'use client';

// ============================================================================
// 剧情 3D 结算屏 —— 线框地形上的空战轨迹 + 收获/战损结算 + 剧情旁白
// ============================================================================
// 需求原话: "界面变成了你在线框地形上的 3d 空战轨迹和收获结算"。
// 所以这一屏的主角不是数据表, 是 3D: 一张程序化的线框地形, 上面那条亮琥珀色的
// 折线就是玩家这一局真飞过的航路; 数据表只是浮在它左侧的一块 CRT 面板。
// 地形随关卡 id 变化(同一关每次进屏完全一致), 轨迹来自调用方传入的世界坐标抽稀点。
//
// 视觉语汇与 Menus.tsx 的 Results 完全同源(crt-frame / crt-flicker / crt-panel /
// crt-corner / crt-key / crt-label / crt-data / crt-text--*), 胜负语义色同源
// (绿=通过 / 红=失败); 数据行复刻 Results 的 score/kills/time/ACC 四项, 并保留
// mp(联机积分板)与 saveStatus(战绩归档)两段 —— 玩家看到的信息与今天一致。
//
// 3D 生命周期的取舍与 StoryBrief.tsx 的 Briefing3D 一致:
//   * 渲染器/场景全部在 effect 内创建, 在清理函数里全部释放并 forceContextLoss();
//   * 场景只建一次(轨迹在本次结算内不会变), 卸载即彻底回收, StrictMode 双跑安全;
//   * 零外部资源 —— 地形/轨迹/标记全部程序化, 进屏不等任何下载。
//
// 绘制预算: 地形线 1 + 等高线 1 + 海面 1 + 轨迹(芯/辉) 2 + 起终点 4 + 爆点 1
//   = 10 个 draw call, 且 update() 里零分配。结算屏前面还压着整条后处理链,
//   这里必须便宜 —— 弱显卡上"打完一局反而卡一下"是最刺眼的体验断点。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import * as THREE from 'three';
// 结算台词按 `<关卡ID大写>_DEBRIEF` 查表取用(见 buildStoryLines): 需要整个模块的导出,
// 所以用命名空间导入而不是具名导入。radio.ts 本来就在本屏的依赖里, 打包体积不变。
import * as radioExports from '@/lib/game/radio';
import { getMission } from '@/lib/game/missions';
import { useT } from '@/hooks/use-i18n';
import { getLocale } from '@/lib/game/i18n';
import { playConfirm, playBack } from '@/lib/game/ui-sound';

// === 终端机箱外发光 / 余晖 / 抬头条底(与 Menus.tsx 逐字相同的三份渐变) ===
// WHY 复刻而不是 import: Menus.tsx 里它们是模块私有常量(未导出), 而"换屏不跳色"
// 比"少写三行"重要得多 —— 结算屏与任务选择屏的底色必须是同一张纸。
const CRT_PWR_GLOW = '0 0 60px rgba(255,176,0,0.055), 0 0 200px rgba(255,176,0,0.02)';
const CRT_GLOW_BG =
  'linear-gradient(180deg, rgba(255,176,0,0.05) 0%, rgba(0,0,0,0) 16%, rgba(0,0,0,0) 84%, rgba(255,176,0,0.03) 100%), radial-gradient(120% 80% at 50% 50%, rgba(255,176,0,0.035) 0%, rgba(0,0,0,0) 60%)';
const CRT_BAR_BG = 'linear-gradient(180deg, rgba(31,22,8,0.9) 0%, rgba(10,6,1,0.9) 100%)';

// ============================================================================
// 场景尺度(单位任意 —— 下面所有数字都只是"相对于轨迹包络"的比例)
// ============================================================================
const PATH_SPAN = 1500;       // 轨迹水平最大跨距映射到的场景尺寸
const MAX_VERT_SPREAD = 220;  // 轨迹垂直摆幅上限(超了就压缩, 见 makeFrame)
const PATH_CLEARANCE = 45;    // 轨迹最低点要高过地形最高点多少
const MAX_TRACK_PTS = 1200;   // 送进几何的轨迹点数上限(抽稀)

const TERRAIN_HALF = 1100;    // 地形半宽 => 2200 见方; 与轨迹 1500 的比例约等于
                              // "一次出击覆盖战区 2/3", 取景上两者都能看清
const TERRAIN_SEGS = 72;      // 72x72 格(73x73 顶点)。格边长 ~30 单位: 山脊是"块状
                              // 地形"而不是细密噪点, 顶点数也压得住(约 1 万段线)
const TERRAIN_AMP = 230;      // 地形起伏幅度(相对 2200 的跨度 = 有山有谷, 但不畸形)
const SEA_Y = -60;            // 海平面高度
const SEA_SIZE = TERRAIN_HALF * 3.2;
const CONTOUR_STEP = 80;      // 等高线间距(场景单位)
const MAX_KILL_MARKS = 64;    // 爆炸标记数量上限(抽稀, 保证 1 个 draw call)
const PANEL_W = 560;          // 左侧结算面板的宽度上限(px): 3D 取景要给它让位
const VIEW_SHIFT = 0.42;      // 取景右移比例(见 setSize 里的 setViewOffset)

// 调色板: 全部落在 CRT 琥珀四阶梯里, 只有起/终点用语义色(绿=出发, 红=终点)
const COL_GRID_MINOR = 0x2b1a06;
const COL_GRID_MAJOR = 0x8f6118;
const COL_CONTOUR = 0x9a6a1c;
const COL_TRACK = 0x6d4a12;
const COL_PATH = 0xffc65a;
const COL_PATH_GLOW = 0xff8a10;
const COL_START = 0x7cff6b;
const COL_END = 0xff3b1f;
const COL_KILL = 0xff5a2a;
const COL_SEA = 0x120a03;
const COL_HORIZON = 0x0a0601;

// ============================================================================
// 轨迹取景帧: 世界坐标 -> 场景坐标
// ============================================================================
// 为什么要"对齐到同一个世界帧": 地形和轨迹原本各说各话(地形按关卡生成, 轨迹是
// 玩家在关卡里的真实坐标)。结算屏只需要"一条能读懂的航路叠在一张地形上", 不需要
// 测绘级精度 —— 所以把轨迹按自己的包围盒居中、等比缩到 PATH_SPAN, 再整体抬高到
// 地形峰值之上。等比的好处: 爬升/俯冲的相对幅度是真的, 不会被拉伸成假动作。
interface PathFrame {
  cx: number; cz: number; cy: number;   // 轨迹包围盒中心(世界坐标)
  k: number;                            // 水平缩放
  ky: number;                           // 垂直缩放(摆幅过大时比 k 更小)
  lift: number;                         // 场景高度偏移(抬到地形之上)
}

/** 世界坐标 -> 场景坐标。无分配(三个 number 进, 写进 out)。 */
function worldToScene(f: PathFrame, x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set((x - f.cx) * f.k, (y - f.cy) * f.ky + f.lift, (z - f.cz) * f.k);
}

type PtTuple = [number, number, number];

/** 只保留三个分量都是有限数的点 —— 引擎那边偶发 NaN 不该让整条轨迹消失。 */
function sanitizePath(src: readonly PtTuple[] | undefined): PtTuple[] {
  if (!Array.isArray(src)) return [];
  const out: PtTuple[] = [];
  for (const p of src) {
    if (!p || p.length < 3) continue;
    if (Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2])) out.push(p);
  }
  return out;
}

/** 等距抽稀(保头保尾)。轨迹点可能有几千个, 几何顶点数没必要跟着涨。 */
function decimate(src: readonly PtTuple[], max: number): PtTuple[] {
  if (src.length <= max) return src.slice();
  const out: PtTuple[] = [];
  const step = (src.length - 1) / (max - 1);
  for (let i = 0; i < max; i += 1) out.push(src[Math.round(i * step)]);
  // 四舍五入可能重复取到同一个点, 也可能取不到最后一个 —— 直接钉死尾点
  out[out.length - 1] = src[src.length - 1];
  return out;
}

/**
 * 缺省轨迹: "爬升出航 -> 两个转弯 -> 俯冲攻击 -> 返场归航"的示意航路。
 * WHY 需要它: 调用方这一轮还没接轨迹记录时, 结算屏也不能给玩家一块光秃秃的地形
 * —— 结算屏的卖点就是"看到自己飞过哪"。用固定航点 + Catmull-Rom 采样, 形状像
 * 真出击, 且每次进屏一模一样(不闪不跳)。
 */
const SYNTH_WAYPOINTS: number[][] = [
  [0, 900, -9200],
  [1200, 3600, -7400],
  [4400, 6200, -3200],
  [5200, 7000, 1900],
  [1700, 7300, 5300],
  [-3100, 6800, 4300],
  [-5300, 3900, 700],
  [-3700, 2400, -3600],
  [-900, 3300, -6900],
  // 收尾不回到原点: 起点/终点标记要能分开认, 闭环会让两个环叠在一起
  [1100, 1200, -8400],
];

function synthPath(): PtTuple[] {
  const curve = new THREE.CatmullRomCurve3(
    SYNTH_WAYPOINTS.map((w) => new THREE.Vector3(w[0], w[1], w[2])),
    false,
    'catmullrom',
    0.35,
  );
  // getPoints 一次性建点(不在渲染循环里), 200 点足够顺
  return curve.getPoints(200).map((v) => [v.x, v.y, v.z] as PtTuple);
}

/** 由轨迹包围盒 + 地形峰值推出取景帧(见 PathFrame 注释)。 */
function makeFrame(src: readonly PtTuple[], terrainMaxY: number): PathFrame {
  let minX = Infinity, maxX = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const p of src) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
    if (p[2] < minZ) minZ = p[2];
    if (p[2] > maxZ) maxZ = p[2];
  }
  const px = Number.isFinite(minX) ? (minX + maxX) / 2 : 0;
  const py = Number.isFinite(minY) ? (minY + maxY) / 2 : 0;
  const pz = Number.isFinite(minZ) ? (minZ + maxZ) / 2 : 0;
  const span = Math.max(maxX - minX, maxZ - minZ, 1);
  const k = PATH_SPAN / span;
  const rawV = (maxY - minY) * k;
  // 垂直方向: 默认与水平同一比例(高度差是真的); 只在摆幅超过预算时单独压缩,
  // 否则一次大高度差的出击会把相机逼到"只能看见轨迹、看不见地形"。
  const ky = rawV > MAX_VERT_SPREAD ? k * (MAX_VERT_SPREAD / rawV) : k;
  const base: PathFrame = { cx: px, cz: pz, cy: py, k, ky, lift: 0 };
  // 二遍: 先按 lift=0 放一遍, 量出最低点, 再把整条轨迹抬到地形峰值之上。
  // WHY 抬高而不是让轨迹穿山: 结算屏要"读得懂", 轨迹被山体遮掉半截是纯粹的损失。
  let sceneMinY = Infinity;
  const tmp = new THREE.Vector3();
  for (const p of src) {
    worldToScene(base, p[0], p[1], p[2], tmp);
    if (tmp.y < sceneMinY) sceneMinY = tmp.y;
  }
  if (!Number.isFinite(sceneMinY)) sceneMinY = 0;
  base.lift = terrainMaxY + PATH_CLEARANCE - sceneMinY;
  return base;
}

// ============================================================================
// 程序化地形: 值噪声 + 陆块轮廓
// ============================================================================
// 整数哈希 -> [0,1)。地形必须"确定" —— 同一关卡每次进结算屏的地形要一模一样,
// 否则玩家会觉得画面在乱抖; 所以用哈希噪声而不是 Math.random。
function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 双线性 + smoothstep 的值噪声(平滑插值才能得到"山脊"而不是"台阶") */
function valueNoise(x: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  const n00 = hash2(xi, zi, seed);
  const n10 = hash2(xi + 1, zi, seed);
  const n01 = hash2(xi, zi + 1, seed);
  const n11 = hash2(xi + 1, zi + 1, seed);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return a + (b - a) * v;
}

interface Terrain {
  h: Float32Array;
  n: number;     // 每边顶点数(TERRAIN_SEGS + 1)
  min: number;
  max: number;
}

/** 高度场: 3 档倍频 fBm 叠在"中心隆起、边缘沉海的陆块轮廓"上。 */
function buildTerrain(seed: number): Terrain {
  const n = TERRAIN_SEGS + 1;
  const h = new Float32Array(n * n);
  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const u = i / TERRAIN_SEGS;
      const v = j / TERRAIN_SEGS;
      // fBm: 大丘陵 + 中尺度山脊 + 细节, 幅度每档减半(低频起手 => 大地形块)
      let sum = 0;
      let amp = 1;
      let f = 2;
      for (let o = 0; o < 3; o += 1) {
        sum += valueNoise(u * f, v * f, seed + o * 101) * amp;
        amp *= 0.5;
        f *= 2;
      }
      // 归一化到 [0,1]
      const base = Math.min(1, sum / 1.75) * TERRAIN_AMP;
      // 陆块轮廓: 中心 1 -> 边缘 0(立方衰减, 于是海岸线是圆钝的不是方的)
      const dx = u - 0.5;
      const dz = v - 0.5;
      const d = Math.min(1, Math.sqrt(dx * dx + dz * dz) / 0.62);
      const shelf = 1 - d * d * d;
      // 第二项把"轮廓低的地方"整体推下海平面: 中心是山, 外圈是海。
      const y = base * (0.35 + 0.65 * shelf) + (shelf - 0.72) * 180;
      h[j * n + i] = y;
      if (y < min) min = y;
      if (y > max) max = y;
    }
  }
  return { h, n, min, max };
}

/** 网格顶点 -> 场景坐标(与轨迹共用同一个水平尺度框架) */
function gridX(i: number): number {
  return (i / TERRAIN_SEGS - 0.5) * 2 * TERRAIN_HALF;
}

/**
 * 在高度场上双线性采样某点的地面高度(场景坐标)。
 * 用途: 画出轨迹在地面上的"影子航迹"与竖直投影线 —— 有了它们, "这条线在三维
 * 空间里的位置"才一眼可判; 没有的话玩家只能看到一条悬空的曲线。
 * 越界会夹到边界格, 所以轨迹飞出地形范围时影子贴在地形边上而不是消失。
 */
function sampleHeight(t: Terrain, x: number, z: number): number {
  const u = (x / (2 * TERRAIN_HALF) + 0.5) * TERRAIN_SEGS;
  const v = (z / (2 * TERRAIN_HALF) + 0.5) * TERRAIN_SEGS;
  const i = Math.max(0, Math.min(TERRAIN_SEGS - 1, Math.floor(u)));
  const j = Math.max(0, Math.min(TERRAIN_SEGS - 1, Math.floor(v)));
  const fu = Math.min(1, Math.max(0, u - i));
  const fv = Math.min(1, Math.max(0, v - j));
  const n = t.n;
  const h00 = t.h[j * n + i];
  const h10 = t.h[j * n + i + 1];
  const h01 = t.h[(j + 1) * n + i];
  const h11 = t.h[(j + 1) * n + i + 1];
  return (h00 * (1 - fu) + h10 * fu) * (1 - fv) + (h01 * (1 - fu) + h11 * fu) * fv;
}

/**
 * 线框地形 —— 一次 draw call。
 * WHY 手写索引而不是 THREE.WireframeGeometry: 后者会把每个三角形的三条边全画出来
 * (含对角线), 顶点数翻一倍还多, 视觉上多出一堆斜线噪声。这里只连"向右"和"向下"
 * 两条邻边, 就是一张干净的正交网格。顶点色区分主线(每 8 格)与次线: 还是一趟绘制。
 */
function buildTerrainGrid(t: Terrain): THREE.BufferGeometry {
  const n = t.n;
  const segs = (n - 1) * n * 2;
  const pos = new Float32Array(segs * 2 * 3);
  const col = new Float32Array(segs * 2 * 3);
  const cMinor = new THREE.Color(COL_GRID_MINOR);
  const cMajor = new THREE.Color(COL_GRID_MAJOR);
  let p = 0;
  let c = 0;
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const x = gridX(i);
      const y = t.h[j * n + i];
      const z = gridX(j);
      const major = i % 8 === 0 || j % 8 === 0;
      const cc = major ? cMajor : cMinor;
      // 向右
      if (i < n - 1) {
        pos[p] = x; pos[p + 1] = y; pos[p + 2] = z;
        pos[p + 3] = gridX(i + 1); pos[p + 4] = t.h[j * n + i + 1]; pos[p + 5] = z;
        p += 6;
        col[c] = cc.r; col[c + 1] = cc.g; col[c + 2] = cc.b;
        col[c + 3] = cc.r; col[c + 4] = cc.g; col[c + 5] = cc.b;
        c += 6;
      }
      // 向下
      if (j < n - 1) {
        pos[p] = x; pos[p + 1] = y; pos[p + 2] = z;
        pos[p + 3] = x; pos[p + 4] = t.h[(j + 1) * n + i]; pos[p + 5] = gridX(j + 1);
        p += 6;
        col[c] = cc.r; col[c + 1] = cc.g; col[c + 2] = cc.b;
        col[c + 3] = cc.r; col[c + 4] = cc.g; col[c + 5] = cc.b;
        c += 6;
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/**
 * 等高线 —— 一次 draw call(所有高度层合并进同一条 LineSegments)。
 * 做法是最简 marching squares: 每个格子对每个高度层判断四条边有没有交点,
 * 2 个交点连一段, 4 个交点按相邻顺序连两段。海平面以下的层直接跳过(反正被海面
 * 挡着), 于是唯一那条"海岸线"等高线会格外清晰 —— 这正是想要的山海轮廓。
 */
function buildContours(t: Terrain): THREE.BufferGeometry | null {
  const n = t.n;
  const pts: number[] = [];
  for (let level = SEA_Y + CONTOUR_STEP; level < t.max; level += CONTOUR_STEP) {
    for (let j = 0; j < n - 1; j += 1) {
      for (let i = 0; i < n - 1; i += 1) {
        // 四角: 0=(i,j) 1=(i+1,j) 2=(i+1,j+1) 3=(i,j+1)
        const h0 = t.h[j * n + i];
        const h1 = t.h[j * n + i + 1];
        const h2 = t.h[(j + 1) * n + i + 1];
        const h3 = t.h[(j + 1) * n + i];
        // 四条边: 0-1(+x) 1-2(+z) 2-3(-x) 3-0(-z)
        const ex: number[] = [];
        const ey: number[] = [];
        const ez: number[] = [];
        const push = (a: number, b: number, ax: number, az: number, bx: number, bz: number) => {
          const da = a - level;
          const db = b - level;
          if ((da > 0) === (db > 0)) return;
          const s = da / (da - db);
          ex.push(ax + (bx - ax) * s);
          ey.push(level);
          ez.push(az + (bz - az) * s);
        };
        const x0 = gridX(i);
        const x1 = gridX(i + 1);
        const z0 = gridX(j);
        const z1 = gridX(j + 1);
        push(h0, h1, x0, z0, x1, z0);
        push(h1, h2, x1, z0, x1, z1);
        push(h2, h3, x1, z1, x0, z1);
        push(h3, h0, x0, z1, x0, z0);
        if (ex.length === 2) {
          pts.push(ex[0], ey[0], ez[0], ex[1], ey[1], ez[1]);
        } else if (ex.length === 4) {
          // 鞍点: 按 0-1 / 2-3 配对(视觉上足够, 不必解模糊)
          pts.push(ex[0], ey[0], ez[0], ex[1], ey[1], ez[1]);
          pts.push(ex[2], ey[2], ez[2], ex[3], ey[3], ez[3]);
        }
      }
    }
  }
  if (pts.length === 0) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

/** 关卡 id -> 地形种子(FNV-1a)。同一关固定, 不同关不同。 */
function seedFrom(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) % 100003;
}

// ============================================================================
// 3D 舞台
// ============================================================================
// 10 个 draw call; 材质能共享就共享, 只有需要独立脉动的少数几份各自持有。
// 所有几何都在这里建、在 dispose() 里释放, update() 绝不新建对象。

interface StageInput {
  path?: [number, number, number][];
  killMarks?: [number, number, number][];
  missionId?: string;
}

interface Stage {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** 用户拖拽产生的环绕角偏移(弧度); 场景只读它, 不拥有它 */
  orbitOffset: { value: number };
  setSize: (w: number, h: number) => void;
  update: (elapsed: number) => void;
  dispose: () => void;
}

/** 竖直渐变背景(暗琥珀 -> 近黑), 与 CRT 暖棕黑同族 */
function makeGradientTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, '#2a1b08');
    g.addColorStop(0.46, '#150d03');
    g.addColorStop(1, '#030201');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 2, 128);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createStage(input: StageInput): Stage {
  const scene = new THREE.Scene();
  const gradient = makeGradientTexture();
  scene.background = gradient;
  // 远雾在拿到取景半径后再设(见下面的 scene.fog 赋值), 这里先留空。

  const camera = new THREE.PerspectiveCamera(42, 1, 1, 40000);
  const orbitOffset = { value: 0 };

  // === 地形(线框 + 等高线 + 海面) ===
  const terrain = buildTerrain(seedFrom(input.missionId ?? 'story'));
  const gridGeom = buildTerrainGrid(terrain);
  const gridMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.92 });
  const grid = new THREE.LineSegments(gridGeom, gridMat);
  scene.add(grid);

  const contourGeom = buildContours(terrain);
  let contourMat: THREE.LineBasicMaterial | null = null;
  if (contourGeom) {
    // 等高线用加法混合: 叠在网格上时"亮起来", 而不是把网格盖掉
    contourMat = new THREE.LineBasicMaterial({
      color: COL_CONTOUR,
      transparent: true,
      opacity: 0.4,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    scene.add(new THREE.LineSegments(contourGeom, contourMat));
  }

  // 海面: 只在地形确实有沉入海平面的区域时才画(否则是一张空转的透明面)。
  // 半透明 => 水下的线框被压暗, 顺便当"水深"读。
  let seaMat: THREE.MeshBasicMaterial | null = null;
  if (terrain.min < SEA_Y - 10) {
    seaMat = new THREE.MeshBasicMaterial({
      color: COL_SEA,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const seaGeom = new THREE.PlaneGeometry(SEA_SIZE, SEA_SIZE);
    seaGeom.rotateX(-Math.PI / 2);
    const sea = new THREE.Mesh(seaGeom, seaMat);
    sea.position.y = SEA_Y;
    scene.add(sea);
  }

  // === 轨迹: 归一化 -> 世界帧 ===
  const raw = sanitizePath(input.path);
  const usingPath = raw.length >= 2;
  const src = decimate(usingPath ? raw : synthPath(), MAX_TRACK_PTS);
  const frame = makeFrame(src, terrain.max);

  const vec = new THREE.Vector3();
  const scenePts: THREE.Vector3[] = src.map((p) => worldToScene(frame, p[0], p[1], p[2], new THREE.Vector3()));

  // 折线位置数组(芯线与辉线共用同一份几何 = 同一块显存, 2 个 draw call)
  const linePos = new Float32Array(scenePts.length * 3);
  for (let i = 0; i < scenePts.length; i += 1) {
    linePos[i * 3] = scenePts[i].x;
    linePos[i * 3 + 1] = scenePts[i].y;
    linePos[i * 3 + 2] = scenePts[i].z;
  }
  const lineGeom = new THREE.BufferGeometry();
  lineGeom.setAttribute('position', new THREE.BufferAttribute(linePos, 3));

  const coreMat = new THREE.LineBasicMaterial({ color: COL_PATH, transparent: true, opacity: 0.96 });
  scene.add(new THREE.Line(lineGeom, coreMat));
  // 辉光: 同一条线, 加法混合 + 低不透明度 —— 弱 GPU 上最便宜的"发光",
  // 也正是 StoryBrief 里呼出环用的同一招。
  const glowMat = new THREE.LineBasicMaterial({
    color: COL_PATH_GLOW,
    transparent: true,
    opacity: 0.2,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  scene.add(new THREE.Line(lineGeom, glowMat));

  const first = scenePts[0];
  const last = scenePts[scenePts.length - 1];

  // === 地面航迹(影子)+ 竖直投影线 ===
  // 轨迹在地形上的落点连成折线, 每隔若干点再拉一根垂线到地面。全部合并进 1 个
  // LineSegments。WHY 必须有: 只有把悬空的曲线和它脚下的地形连起来, 玩家才能一眼
  // 读出"这条轨迹飞过了哪片山"; 没有影子, 3D 轨迹就只是一条飘着的线。
  {
    const drop = 8; // 每 8 个采样点拉一根垂线(再密就变成栅栏了)
    const seg: number[] = [];
    let pgx = 0;
    let pgy = 0;
    let pgz = 0;
    for (let i = 0; i < scenePts.length; i += 1) {
      const p = scenePts[i];
      const gy = sampleHeight(terrain, p.x, p.z);
      if (i > 0) seg.push(pgx, pgy, pgz, p.x, gy, p.z);
      if (i % drop === 0 && p.y > gy + 6) seg.push(p.x, p.y, p.z, p.x, gy, p.z);
      pgx = p.x;
      pgy = gy;
      pgz = p.z;
    }
    const trackGeom = new THREE.BufferGeometry();
    trackGeom.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    const trackMat = new THREE.LineBasicMaterial({ color: COL_TRACK, transparent: true, opacity: 0.42 });
    scene.add(new THREE.LineSegments(trackGeom, trackMat));
  }

  // === 起点(绿环) / 终点(红环 + 指向锥) ===
  const ringGeom = new THREE.RingGeometry(40, 54, 28);
  ringGeom.rotateX(-Math.PI / 2);
  const startRingMat = new THREE.MeshBasicMaterial({
    color: COL_START, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false,
  });
  const startRing = new THREE.Mesh(ringGeom, startRingMat);
  startRing.position.copy(first);
  scene.add(startRing);

  const endRingGeom = new THREE.RingGeometry(40, 54, 28);
  endRingGeom.rotateX(-Math.PI / 2);
  const endRingMat = new THREE.MeshBasicMaterial({
    color: COL_END, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false,
  });
  const endRing = new THREE.Mesh(endRingGeom, endRingMat);
  endRing.position.copy(last);
  scene.add(endRing);

  // 起点/终点的垂直杆: 只在正上方 90 单位。3D 里最难判读的就是"这个点落在哪" ——
  // 一根杆把标记和它脚下的地形连起来, 一眼就知道位置。两条杆合并成 1 个 draw call。
  {
    const stalkPts = [
      first.x, first.y, first.z, first.x, first.y + 90, first.z,
      last.x, last.y, last.z, last.x, last.y + 90, last.z,
    ];
    const stalkGeom = new THREE.BufferGeometry();
    stalkGeom.setAttribute('position', new THREE.Float32BufferAttribute(stalkPts, 3));
    const stalkMat = new THREE.LineBasicMaterial({ color: COL_PATH, transparent: true, opacity: 0.5 });
    scene.add(new THREE.LineSegments(stalkGeom, stalkMat));
  }

  // 终点朝向锥: 用最后一段的方向定姿态, 读起来是"航向 - 在这里脱离"。
  if (scenePts.length >= 2) {
    const prev = scenePts[scenePts.length - 2];
    const dir = new THREE.Vector3(last.x - prev.x, last.y - prev.y, last.z - prev.z);
    if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
    dir.normalize();
    const coneGeom = new THREE.ConeGeometry(16, 52, 10);
    const coneMat = new THREE.MeshBasicMaterial({
      color: COL_END, transparent: true, opacity: 0.85, depthWrite: false,
    });
    const cone = new THREE.Mesh(coneGeom, coneMat);
    cone.position.copy(last);
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    scene.add(cone);
  }

  // === 击杀爆点(小十字星, 整体脉动) ===
  // 全部合并进 1 个 LineSegments; 脉动走共享材质的不透明度 —— 比逐个对象缩放便宜。
  let killMat: THREE.LineBasicMaterial | null = null;
  const marks = sanitizePath(input.killMarks);
  if (marks.length > 0) {
    // 爆点必须和轨迹在同一个世界帧里; 而这一帧是由"轨迹包围盒"定义的 ——
    // 所以缺轨迹(走的合成航路)时没有可信的映射, 宁可一个都不画。
    if (usingPath) {
      const picked = decimate(marks, MAX_KILL_MARKS);
      const segPts: number[] = [];
      const L = 76;
      for (const m of picked) {
        worldToScene(frame, m[0], m[1], m[2], vec);
        for (let a = 0; a < 3; a += 1) {
          const ang = (a * Math.PI) / 3;
          const dx = Math.cos(ang) * L;
          const dz = Math.sin(ang) * L;
          segPts.push(vec.x - dx, vec.y, vec.z - dz, vec.x + dx, vec.y, vec.z + dz);
        }
        // 一根短竖杆, 让爆点从水平交叉升级成"炸点"
        segPts.push(vec.x, vec.y - L * 0.7, vec.z, vec.x, vec.y + L * 0.7, vec.z);
      }
      const killGeom = new THREE.BufferGeometry();
      killGeom.setAttribute('position', new THREE.Float32BufferAttribute(segPts, 3));
      killMat = new THREE.LineBasicMaterial({
        color: COL_KILL,
        transparent: true,
        opacity: 0.6,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      scene.add(new THREE.LineSegments(killGeom, killMat));
    }
  }

  // === 取景 ===
  // 相机绕"轨迹 + 地形"的合并包围盒转: 换关卡、换航路都不会出画。
  let pathHalfX = 0;
  let pathHalfZ = 0;
  let pathMinY = Infinity;
  let pathMaxY = -Infinity;
  for (const p of scenePts) {
    pathHalfX = Math.max(pathHalfX, Math.abs(p.x));
    pathHalfZ = Math.max(pathHalfZ, Math.abs(p.z));
    pathMinY = Math.min(pathMinY, p.y);
    pathMaxY = Math.max(pathMaxY, p.y);
  }
  if (!Number.isFinite(pathMinY)) pathMinY = 0;
  if (!Number.isFinite(pathMaxY)) pathMaxY = 0;
  const halfW = Math.max(TERRAIN_HALF, pathHalfX, pathHalfZ) * 1.06;
  const sceneMinY = Math.min(terrain.min, pathMinY);
  const focusY = (sceneMinY + pathMaxY) / 2;
  const halfH = Math.max(240, (pathMaxY - sceneMinY) / 2);

  // 相机俯角: 34 度是"既看得出地形起伏, 又看得出轨迹高度"的角度。再平就只剩剪影,
  // 再俯就变成一张平面图。
  const ELEV = (34 * Math.PI) / 180;
  let fitR = 1;
  let fitH = 1;

  // 取景 = "把地形 + 轨迹装进可见区域", 且可见区域要扣掉左侧面板压住的那一条。
  // setViewOffset 的用法: 逻辑画布宽 = safeW + shift, 只渲染它的左 safeW 像素 ——
  // 于是内容整体右移 shift/2 像素(让开面板), 而净水平视场仍等于 aspect 对应的值。
  // 由此可用精确式子求相机距离: 可见世界宽度 = 2*d*tan(vHalf)*W/H, 而内容中心
  // 落在 cx = (W+shift)/2 像素处, 从中心到最近屏幕边的余量就是取景半径的上限。
  const setSize = (w: number, h: number) => {
    const safeW = Math.max(1, w);
    const safeH = Math.max(1, h);
    // 面板只在够宽的屏上才浮在左边; 窄屏是"面板在上、3D 在后", 不需要让位
    const shift = safeW > PANEL_W + 320 ? (safeW - PANEL_W) * VIEW_SHIFT : 0;
    const cx = (safeW + shift) / 2;
    camera.aspect = safeW / safeH;
    camera.setViewOffset(safeW + shift, safeH, 0, 0, safeW, safeH);
    camera.updateProjectionMatrix();

    const vHalf = (camera.fov * Math.PI) / 360;
    const tanV = Math.tan(vHalf);
    const perPixel = 2 * tanV / safeH;                 // 每像素覆盖的世界单位(焦平面)
    const roomPx = Math.max(1, Math.min(cx, safeW - cx));
    const needH = halfW / (perPixel * roomPx);         // 水平方向所需距离
    const needV = halfH / tanV;                        // 竖直方向所需距离
    const dist = Math.max(needH, needV) * 1.06;
    fitR = dist * Math.cos(ELEV);
    fitH = dist * Math.sin(ELEV);
  };
  // 雾与取景同源: 远的山脊化进背景, 不需要画地平线
  scene.fog = new THREE.Fog(COL_HORIZON, halfW * 1.5, halfW * 4.8);

  const update = (elapsed: number) => {
    // 相机: 慢速环绕 + 轻微上下漂浮。结算屏是"回放", 镜头该稳、该慢。
    const angle = elapsed * 0.085 + orbitOffset.value;
    camera.position.set(
      Math.cos(angle) * fitR,
      focusY + fitH + Math.sin(elapsed * 0.19) * fitH * 0.055,
      Math.sin(angle) * fitR,
    );
    camera.lookAt(0, focusY, 0);

    // 轨迹辉光呼吸: 幅度很小 —— 它是"发光的线", 不是跑马灯
    glowMat.opacity = 0.15 + 0.09 * (0.5 + 0.5 * Math.sin(elapsed * 1.6));
    coreMat.opacity = 0.86 + 0.12 * (0.5 + 0.5 * Math.sin(elapsed * 2.3));

    // 起/终点环: 相位错开的呼吸缩放(起点先亮, 终点后亮 = 时间顺序)
    const s0 = 1 + 0.09 * (0.5 + 0.5 * Math.sin(elapsed * 2.1));
    const s1 = 1 + 0.09 * (0.5 + 0.5 * Math.sin(elapsed * 2.1 + 2.4));
    startRing.scale.set(s0, 1, s0);
    endRing.scale.set(s1, 1, s1);
    startRingMat.opacity = 0.45 + 0.4 * (0.5 + 0.5 * Math.sin(elapsed * 2.1));
    endRingMat.opacity = 0.45 + 0.4 * (0.5 + 0.5 * Math.sin(elapsed * 2.1 + 2.4));

    // 爆点脉冲: 高频(爆炸是"事件"), 共享材质一次改完
    if (killMat) killMat.opacity = 0.35 + 0.62 * (0.5 + 0.5 * Math.sin(elapsed * 4.6));
    // 等高线缓慢明暗(极慢, 几乎察觉不到, 但画面不会"死")
    if (contourMat) contourMat.opacity = 0.3 + 0.14 * (0.5 + 0.5 * Math.sin(elapsed * 0.7));
    if (seaMat) seaMat.opacity = 0.3 + 0.05 * (0.5 + 0.5 * Math.sin(elapsed * 0.9));
  };

  // 幂等释放: 场景两个出口(StrictMode 双跑 / 真卸载)都可能走到这里, 必须只生效一次
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    });
    // 背景贴图挂在 scene 上而不是材质上, 遍历不到, 必须单独释放
    gradient.dispose();
    scene.clear();
  };

  return { scene, camera, orbitOffset, setSize, update, dispose };
}

// ============================================================================
// 旁白: S01_DEBRIEF 台词序列
// ============================================================================
// 本轮没有任何配音文件(public/audio 下只有音乐与音效), voiceFile 指向的路径必然
// 404 —— 所以"播放"是尽力而为: 能响就按音频真实时长, 响不了就按语速估算把字幕挂住。
// 台词永远不会因为缺音频而卡住或抛错。
const LINE_GAP_S = 0.4; // 台词之间的停顿: 广播通话里"该我说话"的自然间隙, 太短会叠字

// 语速按脚本字符估: CJK 4.5 字/秒(中文播报语速), 拉丁 14 字/秒; 夹紧 2.5-9 秒。
// 它同时是字幕停留时长与整段结算的节奏来源。
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;

function estimateSeconds(text: string): number {
  let cjk = 0;
  let latin = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    if (CJK_CHAR.test(ch)) cjk += 1;
    else latin += 1;
  }
  return Math.min(9, Math.max(2.5, cjk / 4.5 + latin / 14));
}

interface StoryLine {
  speaker: string;
  text: string;
  voiceFile: string;
}

/** 没有剧情台词时的播报人(与关卡内无线电的预警机呼号一致) */
const FALLBACK_SPEAKER = 'AWACS EAGLE';

/**
 * 组装本次结算要播的台词序列。
 * 关卡结算台词按 `<关卡ID大写>_DEBRIEF` 从 radio.ts 取(s01 → S01_DEBRIEF)。
 *
 * [!] 这里必须查表, 不能写死遍历 S01_DEBRIEF:
 *     之前放行 s02 之后仍然遍历 S01_DEBRIEF ⇒ **第二关播的是一关的"堡垒坠海"结算**
 *     (用户报的"s02 的结束简报怎么还是 s01 的"就是这个)。剧情关只会越加越多, 每加一关
 *     都回来改一次判断是最容易忘的维护点 —— 所以按 id 查表: 关卡一导出 `<ID>_DEBRIEF`
 *     就自动接上(与 StoryBrief 的 `<ID>_BRIEF` 同一套约定, s02 的简报就是这么接上的)。
 *
 * 查不到该关的结算台词时返回**空数组**: 旁白整段跳过, 底部字幕条会显示"本关无剧情旁白"。
 * 绝不拿别的关卡的内容顶上, 也绝不因为缺数据而崩。
 * 另: S01_DEBRIEF 那套是"打赢了"的台词(堡垒坠海/任务完成), 打输了还播凯旋台词是明显的
 * 错配, 所以失败时不播旁白, 只留一行静态提示。
 */
function buildStoryLines(missionId: string | undefined, en: boolean, win: boolean): StoryLine[] {
  if (!win || !missionId) return [];
  const maybe = (radioExports as unknown as Record<string, unknown>)[`${missionId.toUpperCase()}_DEBRIEF`];
  if (!Array.isArray(maybe)) return [];
  const out: StoryLine[] = [];
  for (const ev of maybe as string[]) {
    // 逐句包一层 try: 目录里个别事件查不到(索引漂移/新增未登记)时只丢那一句,
    // 不该整段结算旁白都放不出来。
    try {
      // ev 是查表得到的一般字符串, storyLineInfo 收的是 RadioEvent 联合类型 ⇒ 这里断言
      // 成它自己的入参类型(等价于 as RadioEvent, 但不必 import 那个联合类型)。
      const info = radioExports.storyLineInfo(ev as Parameters<typeof radioExports.storyLineInfo>[0]);
      const text = en ? info.en : info.zh;
      if (!text) continue;
      out.push({ speaker: info.speaker || FALLBACK_SPEAKER, text, voiceFile: info.voiceFile || '' });
    } catch {
      /* 单句失败: 跳过 */
    }
  }
  return out;
}

// ============================================================================
// mp / saveStatus: 与 Menus.tsx 的 Results 同一份契约, 但本组件的 props 是 unknown
// ============================================================================
// WHY props 声明成 unknown: 调用方可能来自联机流程(结构更强)或单机(null), 本屏
// 不该为了两个可选展示块把类型耦合进调用方。这里做一次形状校验, 形状不对就当没有
// —— 结算屏永远不能因为"积分板少个字段"而白屏。
interface MpPlayer { name: string; team: number; kills: number; deaths: number; isSelf: boolean }
interface MpBoard { players: MpPlayer[]; teamScores: Record<string, number>; selfTeam: number }
interface SaveStatus { reason: string; room: boolean; career: boolean }

function asMpBoard(v: unknown): MpBoard | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Partial<MpBoard>;
  if (!Array.isArray(o.players) || o.players.length === 0) return null;
  return {
    players: o.players as MpPlayer[],
    teamScores: (o.teamScores && typeof o.teamScores === 'object' ? o.teamScores : {}) as Record<string, number>,
    selfTeam: typeof o.selfTeam === 'number' ? o.selfTeam : -1,
  };
}

function asSaveStatus(v: unknown): SaveStatus | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Partial<SaveStatus>;
  if (typeof o.reason !== 'string') return null;
  return { reason: o.reason, room: !!o.room, career: !!o.career };
}

// ============================================================================
// Results3D
// ============================================================================

export interface Results3DProps {
  win: boolean;
  score: number;
  stats: { kills: number; time: number; accuracy: number };
  missionId?: string;
  /** 玩家在关卡里记录的飞行轨迹(世界坐标, 已抽稀)。缺省时合成一条示意轨迹。 */
  path?: [number, number, number][];
  /** 击杀点的世界坐标(可选): 画成轨迹上的爆点标记。 */
  killMarks?: [number, number, number][];
  mp?: unknown;          // 与 Menus.tsx 的 Results 保持一致(联机积分板), 原样透传给 2D 行
  saveStatus?: unknown;  // 同上
  onContinue: () => void;
}

/**
 * 建渲染器。无 WebGL 时返回 null —— 本屏退化成"纯终端结算单"(3D 层空白但 UI/数据
 * 一个不少), 不能白屏。单独抽成函数是为了让调用点拿到非空常量: 渲染循环闭包里用
 * 可空变量会被 TS 判为 possibly null。
 */
function makeRenderer(): THREE.WebGLRenderer | null {
  try {
    return new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
  } catch {
    return null;
  }
}

export function Results3D({
  win, score, stats, missionId, path, killMarks, mp, saveStatus, onContinue,
}: Results3DProps): JSX.Element {
  const t = useT();
  // useT() 订阅了语言变更 -> 切语言会重渲染本组件, 所以这里直接读 getLocale() 就是
  // 最新值。把 locale 放进字幕 effect 的依赖里, 切语言时旁白按新语言重播一遍。
  const en = getLocale() === 'en';
  const mission = useMemo(() => (missionId ? getMission(missionId) : undefined), [missionId]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const orbitRef = useRef<{ value: number }>({ value: 0 });

  // ---- 3D 场景输入快照 ----
  // WHY 用 ref 传而不是把 path/killMarks 放进场景 effect 的依赖: 调用方每次渲染
  // 很可能传的是新数组, 那会让整个 WebGLRenderer 反复重建(结算屏上就是黑屏闪烁)。
  // 这个 effect 声明在场景 effect 之前, 所以挂载时它先跑, 场景拿到的一定是最新值。
  const inputRef = useRef<StageInput>({ path, killMarks, missionId });
  useEffect(() => {
    inputRef.current = { path, killMarks, missionId };
  }, [path, killMarks, missionId]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    // 兜底: 若上一次清理因异常没跑到, 容器里可能留着旧 canvas —— 先清掉再建,
    // 否则每次进出都会多占一个 WebGL 上下文(浏览器上限约 16 个)。
    mount.querySelectorAll('canvas').forEach((c) => c.remove());

    const width = Math.max(1, mount.clientWidth);
    const height = Math.max(1, mount.clientHeight);

    const renderer = makeRenderer();
    if (!renderer) return;
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const stage = createStage(inputRef.current);
    // 拖拽偏移量与场景共享同一个对象(场景只读, 交互只写) —— 免得每帧回调
    orbitRef.current = stage.orbitOffset;
    stage.setSize(width, height);

    // THREE.Timer(r185 起取代已弃用的 Clock; 同样基于 performance.now(), 单调递增)
    const timer = new THREE.Timer();
    let raf = 0;
    const tick = () => {
      timer.update();
      stage.update(timer.getElapsed());
      renderer.render(stage.scene, stage.camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    const onResize = () => {
      const w = Math.max(1, mount.clientWidth);
      const h = Math.max(1, mount.clientHeight);
      renderer.setSize(w, h);
      stage.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    // ---- 拖拽环绕(可选交互) ----
    // 指针事件挂在 mount 上: 空地上的拖拽才转镜头; 面板/按钮带 data-nodrag,
    // 在它们上面拖(比如想选文字)不会把镜头拽走。
    let dragging = false;
    let lastX = 0;
    const onDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('[data-nodrag]')) return;
      dragging = true;
      lastX = e.clientX;
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      stage.orbitOffset.value -= (e.clientX - lastX) * 0.006;
      lastX = e.clientX;
    };
    const onUp = () => { dragging = false; };
    mount.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);

    return () => {
      window.removeEventListener('resize', onResize);
      mount.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      cancelAnimationFrame(raf);
      stage.dispose();
      renderer.dispose();
      // forceContextLoss: 显式告诉驱动"这个上下文不要了", 不等它被 GC 回收
      renderer.forceContextLoss();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, []); // 场景只建一次(轨迹在本次结算内不变; 换轨迹 = 换一屏)

  // ---- 旁白台词(同步装配: radio.ts 是静态 import, 不需要等异步) ----
  const lines = useMemo(() => buildStoryLines(missionId, en, win), [missionId, en, win]);
  // 播放指针带一个 key(关卡 + 语言): 两者之一变了 key 就对不上, index 自动归零。
  // WHY 不用 "effect 里 setIndex(0)" 复位: 那是一次级联渲染, 而且
  // react-hooks/set-state-in-effect 会直接报错 —— 派生比同步便宜也更稳。
  const linesKey = `${missionId ?? ''}|${en ? 'en' : 'zh'}`;
  const [pos, setPos] = useState<{ key: string; index: number }>({ key: '', index: 0 });
  const index = pos.key === linesKey ? pos.index : 0;
  const total = lines.length;
  const current = index < total ? lines[index] : null;
  const shown = Math.min(index + 1, total);
  const finished = total > 0 && index >= total;

  /** 推进一句(定时器与"点字幕跳句"共用) */
  const advance = useCallback(() => {
    setPos((p) => ({ key: linesKey, index: (p.key === linesKey ? p.index : 0) + 1 }));
  }, [linesKey]);

  // ---- 逐句播放 ----
  // 每句一个定时器: 默认按估算时长 + 间隙; 若音频元数据先到且真实时长更长, 就用
  // 真实时长把定时器重排(有 mp3 时字幕与语音同步)。音频任何失败都只当"没声音",
  // 绝不影响推进。
  useEffect(() => {
    if (index >= lines.length) return;
    const line = lines[index];
    const est = estimateSeconds(line.text);
    let timer = 0;
    let audio: HTMLAudioElement | null = null;

    const arm = (seconds: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(advance, (seconds + LINE_GAP_S) * 1000);
    };
    arm(est);

    // 配音是占位: 本轮 public/audio 下没有任何电台 mp3, 这里必然加载失败 ——
    // 因此播放是"尽力而为"的旁路, 时长仍由 arm() 的估算兜底。
    if (line.voiceFile) {
      try {
        audio = new Audio(line.voiceFile);
        audio.addEventListener('loadedmetadata', () => {
          const d = audio?.duration ?? 0;
          if (Number.isFinite(d) && d > est) arm(d);
        });
        audio.addEventListener('error', () => { /* 缺文件: 保持估算时长, 仅显示字幕 */ });
        const p = audio.play();
        if (p && typeof p.catch === 'function') p.catch(() => undefined);
      } catch {
        audio = null;
      }
    }

    return () => {
      window.clearTimeout(timer);
      if (audio) {
        // 清理函数绝不允许抛错(卸载路径上抛错会带塌整棵 React 树)
        try {
          audio.pause();
          audio.removeAttribute('src');
          audio.load();
        } catch {
          /* 忽略: 音频只是旁路 */
        }
      }
    };
  }, [lines, index, advance]);

  // 入场聚焦: 满屏结算屏必须让 Enter / Space 立刻可用(不必先点一下)
  useEffect(() => {
    wrapRef.current?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    // 按钮自己会响应 Enter/Space(冒泡上来会重复触发), 交给按钮处理。
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'BUTTON') return;
    e.preventDefault();
    playConfirm();
    onContinue();
  };

  /** 点字幕条 = 提前跳下一句(旁白只是氛围, 不该逼玩家听完) */
  const skipLine = useCallback(() => {
    if (index >= total) return;
    playBack();
    advance();
  }, [index, total, advance]);

  // ---- 结算读数(与 Menus.tsx 的 Results 逐项对齐) ----
  const accent = win ? 'var(--crt-green)' : 'var(--crt-red)';
  const accPct = Math.max(0, Math.min(100, Math.round(stats.accuracy * 100)));
  const timeText = `${Math.floor(stats.time / 60)}:${Math.floor(stats.time % 60).toString().padStart(2, '0')}`;
  const rows: [string, string][] = [
    [t('res.score'), score.toLocaleString()],
    [t('res.kills'), String(stats.kills)],
    [t('res.time'), timeText],
    // 与 Results 一样只写 ACC(语言无关的读数标签), 值统一是百分比
    ['ACC', `${accPct}%`],
  ];
  const segs = 20;
  const filled = Math.round((accPct / 100) * segs);

  const board = asMpBoard(mp);
  const save = asSaveStatus(saveStatus);
  const trackPts = sanitizePath(path).length;
  const marks = sanitizePath(killMarks).length;

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="crt-frame crt-flicker relative h-full w-full select-none overflow-hidden crt-font focus:outline-none"
      style={{ background: 'var(--crt-bg)' }}
    >
      {/* 3D 舞台铺满整屏(线框地形 + 轨迹); 下面所有 UI 都浮在它之上 */}
      <div ref={mountRef} className="absolute inset-0 z-0" />

      {/* 显像管余晖 */}
      <div className="pointer-events-none absolute inset-0 z-10" style={{ backgroundImage: CRT_GLOW_BG, boxShadow: CRT_PWR_GLOW }} />

      {/* 右侧压暗: 让左侧面板上的字在任何地形亮度下都够对比度(暗角的一种局部化) */}
      <div
        className="pointer-events-none absolute inset-0 z-10"
        style={{ background: 'linear-gradient(90deg, rgba(6,3,0,0.82) 0%, rgba(6,3,0,0.55) 34%, rgba(0,0,0,0) 62%)' }}
      />

      <div className="pointer-events-none relative z-20 flex h-full w-full flex-col">
        {/* 终端抬头条 */}
        <div
          className="pointer-events-auto flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-2.5 py-1.5"
          style={{ borderColor: 'var(--crt-line-strong)', background: CRT_BAR_BG }}
        >
          <span className="crt-data crt-text--hi crt-text--glow tracking-[0.3em]">DEBRIEF 3D</span>
          <span className="crt-label hidden sm:inline">· TAC-OS 3.11 · SORTIE DEBRIEF</span>
          <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className={'crt-label ' + (win ? 'crt-ready' : 'crt-warn')}>■ {win ? t('res.success') : t('res.fail')}</span>
            <span className="crt-label hidden sm:inline">{mission ? `${mission.codename} · ${missionId?.toUpperCase() ?? ''}` : (en ? 'FREE FLIGHT' : '自由飞行')}</span>
            <span className="crt-label">PRINT · 1/1</span>
          </span>
        </div>

        {/* 中部: 左侧结算面板 / 右侧留给 3D 轨迹 */}
        <div data-nodrag="1" className="pointer-events-auto min-h-0 flex-1 overflow-y-auto p-2.5">
          <div className="flex min-h-full w-full flex-col">
            {/* 结算单浮在左半边; lg 以下自然铺满整宽(3D 仍在它后面继续渲染) */}
            <div className="crt-panel crt-corner w-full max-w-[560px]">
              {/* 判定横幅(绿=通过 / 红=失败) */}
              <div
                className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 border-b px-3 py-2"
                style={{ borderColor: accent, background: win ? 'rgba(124,255,107,0.07)' : 'rgba(255,59,31,0.08)' }}
              >
                <span className="crt-label crt-text--glow" style={{ color: accent }}>{win ? t('res.success') : t('res.fail')}</span>
                <span className="crt-data crt-text--glow text-xl font-bold tracking-[0.24em] sm:text-2xl" style={{ color: accent }}>
                  {en ? (win ? 'MISSION COMPLETE' : 'MISSION FAILED') : (win ? '任务完成' : '任务失败')}
                </span>
                <span className="tp-hazard h-3 w-16 opacity-70" />
              </div>

              <div className="p-3 sm:p-4">
                <span className="tp-hazard block h-2 w-full opacity-55" />

                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="crt-label crt-text--hi tracking-[0.26em]">{t('res.score')} · RECORD SHEET</span>
                  <span className="crt-label">SEGMENTS {segs} · FILLED {String(filled).padStart(2, '0')}</span>
                </div>

                {/* 数据条栅格(命中率) */}
                <div className="mt-1.5 flex gap-[2px]">
                  {Array.from({ length: segs }).map((_, i) => (
                    <span
                      key={i}
                      className="h-3 flex-1"
                      style={{
                        background: i < filled ? 'var(--crt-amber)' : 'var(--crt-amber-ghost)',
                        boxShadow: i < filled ? '0 0 5px rgba(255,176,0,0.45)' : undefined,
                      }}
                    />
                  ))}
                </div>

                {/* 表格式读数: score / kills / time / acc */}
                <div className="mt-2.5">
                  {rows.map(([k, v], i) => (
                    <div
                      key={k}
                      className="flex items-baseline justify-between gap-3 border-b py-1.5"
                      style={{ borderColor: i === 0 ? 'var(--crt-line-strong)' : 'var(--crt-line)' }}
                    >
                      <span className="crt-label min-w-0 truncate">{k}</span>
                      <span className="crt-data crt-text--hi crt-text--glow shrink-0 text-lg font-bold">{v}</span>
                    </div>
                  ))}
                </div>

                {/* 轨迹/收获回执: 把"3D 那条线是什么"在数据上也交代清楚 */}
                <div className="crt-label crt-text--hi mt-3 mb-1 tracking-[0.24em]">{en ? 'SORTIE RECAP' : '出击回执'}</div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                  <div className="flex items-baseline justify-between gap-2 border-b pb-1" style={{ borderColor: 'var(--crt-line)' }}>
                    <span className="crt-label">TRACK PTS</span>
                    <span className="crt-data crt-text--hi">{trackPts > 0 ? String(trackPts) : (en ? 'SYNTH' : '合成')}</span>
                  </div>
                  <div className="flex items-baseline justify-between gap-2 border-b pb-1" style={{ borderColor: 'var(--crt-line)' }}>
                    <span className="crt-label">{en ? 'KILL MARKS' : '爆点'}</span>
                    <span className="crt-data crt-text--hi">{marks > 0 ? String(marks) : '--'}</span>
                  </div>
                  <div className="flex items-baseline justify-between gap-2 border-b pb-1" style={{ borderColor: 'var(--crt-line)' }}>
                    <span className="crt-label">{en ? 'REWARD' : '奖励'}</span>
                    <span className="crt-data crt-text--hi crt-text--glow truncate">{mission?.reward ?? '--'}</span>
                  </div>
                  <div className="flex items-baseline justify-between gap-2 border-b pb-1" style={{ borderColor: 'var(--crt-line)' }}>
                    <span className="crt-label">{en ? 'CAMERA' : '回放'}</span>
                    <span className="crt-data crt-text--dim">{en ? 'ORBIT AUTO' : '自动环绕'}</span>
                  </div>
                </div>

                {/* === 联机积分板(与 Menus.tsx 的 Results 同一段) === */}
                {board && (
                  <div className="mt-3 border-t pt-2" style={{ borderColor: 'var(--crt-line)' }}>
                    <div className="crt-label crt-text--hi mb-1 tracking-[0.24em]">
                      MULTIPLAYER · FINAL SCOREBOARD
                    </div>
                    {Object.keys(board.teamScores).length > 0 && (
                      <div className="crt-label mb-1 flex flex-wrap gap-x-3">
                        {Object.entries(board.teamScores)
                          .sort(([a], [b]) => Number(a) - Number(b))
                          .map(([team, s]) => (
                            <span
                              key={team}
                              style={{ color: Number(team) === board.selfTeam ? 'var(--crt-ally, #5ad2ff)' : 'var(--crt-red-light, #ff6a5c)' }}
                            >
                              {Number(team) === 0 ? 'BLUE' : 'RED'} {s}
                            </span>
                          ))}
                      </div>
                    )}
                    <table className="w-full">
                      <thead>
                        <tr className="crt-label">
                          <th className="py-0.5 text-left">#</th>
                          <th className="py-0.5 text-left">CALLSIGN</th>
                          <th className="py-0.5 text-right">K</th>
                          <th className="py-0.5 text-right">D</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...board.players]
                          .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
                          .slice(0, 12)
                          .map((p, i) => (
                            <tr key={`${p.name}-${i}`} className="border-t" style={{ borderColor: 'var(--crt-line)' }}>
                              <td className="crt-label py-1">{String(i + 1).padStart(2, '0')}</td>
                              <td className={`crt-data py-1 ${p.isSelf ? 'crt-text--hi' : ''}`}>
                                {p.name}{p.isSelf ? ' (YOU)' : ''}
                              </td>
                              <td className="crt-data py-1 text-right">{p.kills}</td>
                              <td className="crt-data py-1 text-right opacity-70">{p.deaths}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="crt-label mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="crt-text--hi">SIGNAL LOST · RECOVERED</span>
                  <span>TAPE 1 / SIDE A</span>
                  {/* === 战绩归档状态(与 Results 同一段: 已归档=就绪绿, 离线=琥珀) === */}
                  {save && (
                    <span className={save.reason === 'ok' ? 'crt-ready' : 'crt-warn'}>
                      {save.reason === 'ok'
                        ? (en ? `◈ RESULT ARCHIVED${save.room ? ' (ROOM+SAVE)' : ''}` : `◈ 战绩已归档${save.room ? '(含房间记录)' : ''}`)
                        : save.reason === 'not-logged-in'
                          ? (en ? '◇ NOT LOGGED IN · NOT ARCHIVED' : '◇ 未登录 · 战绩未归档')
                          : save.reason === 'duplicate'
                            ? (en ? '◇ ALREADY ARCHIVED' : '◇ 本局已归档')
                            : (en ? '◇ OFFLINE · NOT ARCHIVED' : '◇ 离线 · 战绩未归档')}
                    </span>
                  )}
                  {/* 语义色随判定走: 失败时"评估归档"不该是就绪绿 */}
                  <span className={`ml-auto ${win ? 'crt-ready' : 'crt-warn'}`}>◆ {en ? 'ASSESSMENT FILED' : '评估已归档'}</span>
                </div>

                <div className="mt-3 flex flex-wrap items-end justify-between gap-3 border-t pt-2.5" style={{ borderColor: 'var(--crt-line)' }}>
                  <span className="tp-barcode h-7 w-40 opacity-70" />
                  <span className="crt-label min-w-0">SN 007-1986-A · DEB-{win ? 'OK' : 'NG'} · ORDNANCE EXPENDED</span>
                </div>
                <div className="crt-label mt-1 flex flex-wrap items-center justify-between gap-2">
                  <span className="crt-warn">⚠ {win ? (en ? 'RECOVER AIRFRAME BEFORE NEXT SORTIE' : '回收机身, 准备下次出击') : (en ? 'AIRFRAME LOST · NEXT OF KIN NOTIFIED' : '机身损失 · 已通知家属')}</span>
                  <span className="tp-hazard h-2.5 w-20" />
                </div>
              </div>
            </div>

            <div className="mt-3 flex justify-start">
              <button
                type="button"
                onClick={() => { playConfirm(); onContinue(); }}
                className="crt-key crt-corner w-full max-w-[560px] px-6 py-3 text-[0.75rem] font-bold tracking-[0.3em] hover:border-[var(--crt-amber-hi)] hover:text-[color:var(--crt-amber-hi)] focus-visible:outline focus-visible:outline-1"
                style={{ outlineColor: 'var(--crt-line-strong)' }}
              >
                ▶ {t('res.continue')}
              </button>
            </div>
          </div>
        </div>

        {/* 底部字幕条 + 控制 */}
        <div
          data-nodrag="1"
          className="pointer-events-auto shrink-0 border-t px-3 pb-2 pt-2"
          style={{ borderColor: 'var(--crt-line-strong)', background: 'linear-gradient(180deg, rgba(10,6,1,0.94) 0%, rgba(24,16,5,0.97) 100%)' }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="crt-label flex flex-wrap items-center gap-x-2">
              <span className="crt-text--hi">{`▶ ${en ? 'DEBRIEF' : '结算'}`}</span>
              {total > 0
                ? <span>{`${shown} / ${total}`}</span>
                : (
                  <span className="crt-text--dim">
                    {win
                      ? (en ? 'NO STORY FEED' : '本关无剧情旁白')
                      : (en ? 'SORTIE LOST · NO FEED' : '本关失利 · 无结算旁白')}
                  </span>
                )}
              {finished ? <span className="crt-text--hi">{en ? '■ COMPLETE' : '■ 播报完毕'}</span> : null}
            </span>
            <span className="crt-label crt-text--dim hidden sm:inline">
              {en ? 'VOICE FEED PLACEHOLDER · TEXT ONLY' : '配音占位 · 仅字幕'}
            </span>
          </div>

          {/* 电影式字幕(与 Hud.tsx / Briefing3D 同一套类) */}
          <div
            onClick={skipLine}
            className="mt-2 flex min-h-[2.6rem] cursor-pointer items-center justify-center text-center"
          >
            {current ? (
              <div className="crt-subtitle max-w-[86vw]" key={`${index}-${current.speaker}`}>
                <span className="crt-subtitle__spk">{`[${current.speaker}]`}</span>
                <span>{current.text}</span>
                <span className="ml-1 inline-block animate-pulse" style={{ color: 'var(--crt-amber)' }}>█</span>
              </div>
            ) : (
              <div className="crt-subtitle crt-subtitle--accent">
                {win
                  ? (en ? 'DEBRIEF COMPLETE · RETURN TO BASE' : '结算完毕 · 返场')
                  : (en ? 'DEBRIEF CLOSED · SORTIE LOST' : '结算结束 · 本关失利')}
              </div>
            )}
          </div>
        </div>

        {/* 底部提示行 */}
        <div className="pointer-events-none flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-1.5" style={{ borderColor: 'var(--crt-line)' }}>
          <span className="crt-label">ENTER / SPACE {en ? 'CONTINUE' : '继续'}</span>
          <span className="crt-label">{en ? 'DRAG TO ORBIT' : '拖拽旋转镜头'}</span>
          <span className="crt-label crt-text--dim hidden sm:inline">{en ? 'CAM AUTO-ORBIT' : '镜头自动环绕'}</span>
          <span className="tp-hazard h-2.5 w-14" />
          <span className="crt-label ml-auto whitespace-nowrap">SN 007-1986-A · MADE IN THE BUNKER</span>
          <span className="tp-barcode hidden h-5 w-24 sm:block" />
        </div>
      </div>

      {/* ===== CRT 叠加层(纯装饰, 不接收指针事件) ===== */}
      <div className="crt-scanlines pointer-events-none absolute inset-0 z-40 opacity-80" />
      <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden">
        <div className="tp-tracking h-[16%] w-full" />
      </div>
      <div className="crt-vignette pointer-events-none absolute inset-0 z-40" />
    </div>
  );
}
