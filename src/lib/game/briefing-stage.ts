// ============================================================================
// 简报 3D 舞台 —— 2D 区域地图 → 缩比网格战场
// ============================================================================
// 六拍一次播完(旧版是 32 秒无缝循环; 现在是一段"过场", 因为剧情配音要在末段留驻):
//
//   01 BOOT         0.0-1.6   黑场淡入, 地图平面从高空浮现
//   02 CARTOGRAPHY  1.6-5.0   地图被"画"出来(遮罩揭开 + 扫描光幕); 经纬网 / 等高线
//   03 TARGETS      5.0-9.2   目标卡片错峰弹出(准星收拢 + 引线 + 蓝图线稿)
//   04 ROUTES       9.2-11.4  进攻箭头带生长 + 箭头锥; 敌军来袭虚线箭头
//   05 DIVE        11.4-13.2  相机抬头俯冲; 地图由中心向外揭开消散, 网格战场浮现
//   06 GRID        13.2-17.6  缩比网格战场点亮; 标记抬起 + 立杆 + 航线管生长
//      HOLD        17.6-∞     缓慢漂移环绕(剩余配音在这里播完)
//
// 三件事让"2D→3D 穿越"成立:
//   ① 地图平面与网格战场**共用同一块世界**(同一个中心/边长, 同一套 XZ 映射),
//      所以地图上某个目标的点, 在 3D 里原地就是那个标记 —— 位置连续, 不靠淡出蒙混。
//   ② 标记会**从地图上升起来**: 位置从地图平面高度插值到它自己的高度, 地图消散的
//      同时它们站起来, 于是"平面的情报"变成"立体的战场"。
//   ③ 相机从正俯视(看地图)一路转到斜俯视(看网格), 一次连续运动, 中间不切镜头。
//
// 全部程序化: 场景里没有模型/贴图/字体, 唯一的贴图是 Canvas2D 现画的地图。
// 一条时钟 + 关键帧轨道, 没有任何 setState 驱动的动画。

import * as THREE from 'three';
import {
  toneColor,
  type BriefingCard,
  type BriefingIntel,
  type BriefingRoute,
  type BriefingUnit,
  type GlyphKind,
} from './briefing-intel';
import { paintRegionMap } from './briefing-map';

// ============================================================================
// 时间轴(导出给组件层: 快进、读拍、播完判定都靠这几个常量)
// ============================================================================
/** 各拍起始时刻(秒)。最后一拍 GRID 之后的 HOLD 是无限长的留驻段。 */
export const BEAT_T = [0, 1.6, 5.0, 9.2, 11.4, 13.2, 17.6] as const;
/** HOLD 拍的序号 */
export const BEAT_HOLD = 6;
/** 进入留驻的时刻 —— "快进"就跳到这里 */
export const HOLD_T = BEAT_T[6];
/** 到这一刻, 整段动画(含最后一个标记的错峰弹出与航线生长)一定播完 */
export const SEQ_END_T = 19.2;
export const BEAT_NAME = ['BOOT', 'CARTOGRAPHY', 'TARGETS', 'ROUTES', 'DIVE', 'GRID', 'HOLD'] as const;
export const BEAT_NAME_ZH = ['系统启动', '地图成像', '目标确认', '航路规划', '场景切入', '战术态势', '留驻'] as const;
/** 上游的拍数(不含 HOLD 留驻段) */
export const BEAT_COUNT = 6;

export function beatAt(t: number): number {
  for (let i = BEAT_T.length - 1; i >= 0; i -= 1) if (t >= BEAT_T[i]) return i;
  return 0;
}

// ============================================================================
// 缓动工具(本文件自带, 不引依赖 —— 与旧版一致)
// ============================================================================
const TWO_PI = Math.PI * 2;
const DEG2RAD = Math.PI / 180;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smooth(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

function mix(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

/** 相位窗: at 开始升, rise 秒到 1, 保持 hold 秒, fall 秒落回 0(两端导数都为 0) */
function window01(t: number, at: number, rise: number, hold: number, fall: number): number {
  if (t <= at) return 0;
  if (t < at + rise) return smooth((t - at) / rise);
  if (t < at + rise + hold) return 1;
  if (t < at + rise + hold + fall) return 1 - smooth((t - at - rise - hold) / fall);
  return 0;
}

/** easeOutBack: 先冲过头再收回 —— 标记"弹出"的手感来源 */
function popIn(t: number, at: number, dur: number): number {
  const x = (t - at) / dur;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

/** 非均匀时间关键帧轨道。一次性过场不需要循环, 两端自动夹住。 */
function sampleTrack(times: readonly number[], values: readonly number[], t: number): number {
  const n = times.length;
  if (t <= times[0]) return values[0];
  if (t >= times[n - 1]) return values[n - 1];
  for (let i = 0; i < n - 1; i += 1) {
    if (t < times[i + 1]) {
      const k = smooth((t - times[i]) / (times[i + 1] - times[i]));
      return mix(values[i], values[i + 1], k);
    }
  }
  return values[n - 1];
}

// ============================================================================
// 相机关键帧(以世界边长 S 的倍数表达 —— 换关卡换尺度都不用改这里)
// ============================================================================
const CAM_T = [0, 1.6, 3.2, 5.0, 7.2, 9.2, 11.4, 13.2, 15.4, 17.6];
const CAM_X = [0, 0, -0.06, -0.08, 0.04, 0, 0.02, 0.16, 0.26, 0.34];
const CAM_Y = [2.30, 2.20, 1.95, 1.80, 1.66, 2.05, 1.90, 0.62, 0.56, 0.52];
const CAM_Z = [0.02, 0.06, 0.10, 0.12, 0.06, 0.04, 0.10, 0.30, 0.44, 0.52];
const CAM_FOV = [30, 30, 32, 34, 36, 32, 34, 40, 42, 42];
/** 注视点偏移(相对世界中心) */
const LOOK_X = [0, 0, -0.02, -0.04, 0.06, 0, 0.04, 0.10, 0.16, 0.20];
const LOOK_Y = [0.12, 0.12, 0.12, 0.12, 0.12, 0.12, 0.12, 0.02, 0, 0];
const LOOK_Z = [0, 0, 0.02, 0.04, -0.04, 0, -0.02, 0.10, 0.16, 0.20];
const CAM_ROLL = [0, 0, -0.01, -0.02, 0.015, 0.01, 0.02, -0.05, -0.02, -0.01];

/** 地图平面高度(世界边长的比例) */
const MAP_Y_K = 0.10;
const MARK_SCREEN_MAP = 0.036;
const MARK_SCREEN_GRID = 0.052;
/** 标记引线长度(局部单位): 顶端就是 DOM 标签的锚点 */
const STEM_LEN = 1.2;

const COL_GRID_MAJOR = 0x6b4a12;
const COL_GRID_MINOR = 0x241706;
const COL_HULL = 0x120c05;
const COL_EDGE = 0x6a4a12;
const COL_ARROW_F = 0x5ad2ff; // 友军突击(与 HUD 友军青蓝同值)
const COL_ARROW_E = 0xff3b1f; // 敌军来袭(目标红)
const COL_ROUTE_F = 0x5ad2ff;
const COL_ROUTE_E = 0xff6a2c;
const COL_SCAN = 0xffe6b0;
const COL_PIN = 0x8a5a12;
const COL_RUNNER = 0xffe6b0;

/** '#rrggbb' -> 0xrrggbb */
function hexToInt(hex: string): number {
  return Number.parseInt(hex.slice(1), 16);
}

export interface StageOptions {
  en: boolean;
  /** 'sequence' = 六拍过场; 'preview' = 任务简报里那块慢速环绕的预览(忽略时间轴) */
  mode: 'sequence' | 'preview';
  /** 任务 id 与行动代号(画在地图图廓上) */
  missionId: string;
  codename: string;
  /** 地图贴图的各向异性上限(由组件层从 renderer.capabilities 传入) */
  anisotropy?: number;
}

export interface BriefingStage {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  setSize: (w: number, h: number) => void;
  update: (elapsed: number) => void;
  /** 跳转到时间轴上的某一刻(快进用) */
  seek: (t: number) => void;
  /**
   * 把时间轴理解为"恰好 t 秒"并推进一帧(不进 rAF 循环, 由调用方决定何时画)。
   * 用途: headless / 后台标签里 rAF 不跑, 但截图脚本仍需要任意一拍的确切画面 ——
   * 于是"求值"与"循环"解耦。seek + 等一帧做不到这种精确(seek 是相对位移)。
   */
  renderAt: (t: number) => void;
  /** 当前时间轴位置(秒, 含 seek 偏移)—— 组件层用它判拍, 别用 elapsed */
  time: () => number;
  /** 把标记标签锚点 + 卡片锚点投到 NDC。**必须在 render() 之后调用**。 */
  projectAnchors: () => void;
  /** 每个单位 4 个数: ndcX, ndcY, 透明度, 是否在画面内(顺序与 intel.units 一致) */
  labelAnchors: Float32Array;
  /** 每张卡片 4 个数(顺序与 intel.cards 一致) */
  cardAnchors: Float32Array;
  /** 预览模式: 切 2D 地图 / 3D 网格 */
  setPreviewView: (v: 'map' | 'grid') => void;
  /**
   * 现画出来的那张区域地图(CanvasTexture 的源)。
   * 暴露出来是为了能单独把这张图 dump 出来看 —— 它是一张程序化生成的贴图, 出了偏差
   * 只能盯着"它本身"看, 在 3D 里隔着相机和光照是查不出问题的。
   */
  mapImage: HTMLCanvasElement;
  dispose: () => void;
}

// ============================================================================
// 几何工具
// ============================================================================

/** 把一条折线按线段推进数组(每段 2 个点 -> LineSegments 的一个图元) */
function pushPolyline(arr: number[], pts: readonly (readonly [number, number])[], close: boolean): void {
  const n = pts.length;
  const last = close ? n : n - 1;
  for (let i = 0; i < last; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    arr.push(a[0], a[1], 0, b[0], b[1], 0);
  }
}

/**
 * 标记几何 = 图形 + 引线 + 顶端横杠, 全在一个 BufferGeometry 里(1 个 draw call)。
 * 引线画在同一个几何里而不是单独一条 LineSegments 的好处: 引线在 billboard 的局部
 * XY 平面内, 于是它天然跟着图形一起朝向镜头、一起做弹出缩放, 而且不需要每帧回头改
 * 顶点(每帧改顶点就得重建 attribute, 那才是真正的开销)。
 */
function makeMarkerGeometry(kind: GlyphKind): THREE.BufferGeometry {
  const p: number[] = [];
  let top = 0.6;
  if (kind === 'chevron') {
    // 玩家/僚机: 指向敌方的箭头
    pushPolyline(p, [[0, 0.8], [0.5, 0.16], [0.2, 0.16], [0.2, -0.46], [-0.2, -0.46], [-0.2, 0.16], [-0.5, 0.16]], true);
    top = 0.8;
  } else if (kind === 'ring') {
    // 高价值目标: 双环 + 四角分划(大号"目标解算环")
    const r1 = 0.62;
    const r2 = 0.44;
    for (const spec of [[r1, 26], [r2, 18]]) {
      const r = spec[0];
      const seg = spec[1];
      for (let i = 0; i < seg; i += 1) {
        const a0 = (i / seg) * TWO_PI;
        const a1 = ((i + 1) / seg) * TWO_PI;
        p.push(Math.cos(a0) * r, Math.sin(a0) * r, 0, Math.cos(a1) * r, Math.sin(a1) * r, 0);
      }
    }
    for (let k = 0; k < 4; k += 1) {
      const a = k * Math.PI * 0.5;
      p.push(Math.cos(a) * r1, Math.sin(a) * r1, 0, Math.cos(a) * (r1 + 0.24), Math.sin(a) * (r1 + 0.24), 0);
    }
    top = r1 + 0.24;
  } else if (kind === 'diamond') {
    // 敌机: 小菱形(比方框轻, 一眼分得出"次要目标")
    pushPolyline(p, [[0, 0.5], [0.42, 0], [0, -0.5], [-0.42, 0]], true);
    top = 0.5;
  } else {
    // 地面单位: 四角括号框(沿用 HUD 的敌方框语汇)
    const h = 0.5;
    const c = 0.22;
    for (const sx of [1, -1]) {
      for (const sy of [1, -1]) {
        p.push(sx * h, sy * h, 0, sx * h - sx * c, sy * h, 0);
        p.push(sx * h, sy * h, 0, sx * h, sy * (h - c), 0);
      }
    }
    top = h;
  }
  p.push(0, top, 0, 0, STEM_LEN, 0);
  p.push(-0.2, STEM_LEN, 0, 0.2, STEM_LEN, 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  return g;
}

/** 目标卡片的地面准星(双环 + 十字分划) */
function makeReticleGeometry(): THREE.BufferGeometry {
  const p: number[] = [];
  for (const spec of [[0.5, 28], [0.34, 20]]) {
    const r = spec[0];
    const seg = spec[1];
    for (let i = 0; i < seg; i += 1) {
      const a0 = (i / seg) * TWO_PI;
      const a1 = ((i + 1) / seg) * TWO_PI;
      p.push(Math.cos(a0) * r, Math.sin(a0) * r, 0, Math.cos(a1) * r, Math.sin(a1) * r, 0);
    }
  }
  for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    p.push(d[0] * 0.22, d[1] * 0.22, 0, d[0] * 0.6, d[1] * 0.6, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  return g;
}

/**
 * 进攻箭头带: 沿折线做一条**变宽带**(非索引, 6 顶点/段), 用 setDrawRange 生长 ——
 * 这就是 3D 版的 strokeDashoffset, 但形状是实心指挥箭头而不是一条描边线。
 * 顶点写的是**绝对世界坐标**, 所以网格不要再叠加位移。
 */
function makeRibbonGeometry(
  pts: readonly THREE.Vector3[],
  width0: number,
  width1: number,
): { geom: THREE.BufferGeometry; segments: number } {
  const n = pts.length;
  const segments = Math.max(1, n - 1);
  const arr = new Float32Array(segments * 6 * 3);
  let w = 0;
  for (let i = 0; i < segments; i += 1) {
    const t0 = i / segments;
    const t1 = (i + 1) / segments;
    const a = pts[i];
    const b = pts[i + 1];
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    const nx = -dz;
    const nz = dx;
    const w0 = mix(width0, width1, t0);
    const w1 = mix(width0, width1, t1);
    const ax0 = a.x + nx * w0; const az0 = a.z + nz * w0;
    const ax1 = a.x - nx * w0; const az1 = a.z - nz * w0;
    const bx0 = b.x + nx * w1; const bz0 = b.z + nz * w1;
    const bx1 = b.x - nx * w1; const bz1 = b.z - nz * w1;
    const put = (x: number, z: number): void => {
      arr[w] = x; arr[w + 1] = 0; arr[w + 2] = z; w += 3;
    };
    put(ax0, az0); put(ax1, az1); put(bx1, bz1);
    put(ax0, az0); put(bx1, bz1); put(bx0, bz0);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  return { geom, segments };
}

/** 扁三角形箭头(几何体自身朝向 +Z, 用时就地转向切线) */
function makeArrowHeadGeometry(size: number): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(size, size * 2.6, 3);
  // 圆锥默认沿 +Y -> rotateX(90°) 后尖端指向 +Z, 底面落在 z≈0
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, size * 1.3);
  return g;
}

/** 竖直渐变背景(极暗琥珀 -> 近黑), 与 CRT 暖棕黑背景同族 */
function makeGradientTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, '#251808');
    g.addColorStop(0.5, '#0d0803');
    g.addColorStop(1, '#030201');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 2, 128);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ============================================================================
// 舞台内部对象
// ============================================================================

interface RouteObj {
  def: BriefingRoute;
  ribbon: THREE.Mesh;
  ribbonSegments: number;
  head: THREE.Mesh;
  /** 箭头锥的固定位姿(带的终点是常量, 一次算好, 不必每帧求曲线) */
  headPos: THREE.Vector3;
  headQuat: THREE.Quaternion;
  tube?: THREE.Mesh;
  tubeIndex: number;
  runner?: THREE.Mesh;
  curveGrid: THREE.CatmullRomCurve3;
}

interface MarkerObj {
  unit: BriefingUnit;
  line: THREE.LineSegments;
  fill?: THREE.Mesh;
  /** 地图平面上的位置 */
  mapPos: THREE.Vector3;
  /** 网格战场里的位置 */
  gridPos: THREE.Vector3;
  /**
   * 引线长度的倍率。同一处(或近处)叠了多个带标签的单位时, 按名次把标签沿相机上方向
   * 依次拉开 —— 否则两个标签会**完全重叠**成一片看不清的字。
   * s02 就有一例: 山雀 与玩家机的出生点是同一个 XZ(它就在长机正下方 100m)。
   */
  stemK: number;
}

export function createBriefingStage(intel: BriefingIntel, opts: StageOptions): BriefingStage {
  const S = intel.world.size;
  const CX = intel.world.cx;
  const CZ = intel.world.cz;
  const MAP_Y = S * MAP_Y_K;
  /** 地图上元素离平面的抬升(压住 z-fighting; 远大于深度精度) */
  const MAP_LIFT = S * 0.0035;
  const isPreview = opts.mode === 'preview';
  const CARD_LIFT = [0.10, 0.165, 0.128, 0.19];

  const scene = new THREE.Scene();
  const gradient = makeGradientTexture();
  scene.background = gradient;
  // 雾: 地图拍几乎无雾(高空看地图, 要清楚), 切入战场后收近给纵深。
  // 每帧改 near/far 做过渡, 不重建 Fog 对象。
  const fog = new THREE.Fog(0x0a0601, S * 0.6, S * 3.0);
  scene.fog = fog;

  // near 取 S 的 2%: 地图拍相机在 2.3S 高空, 24 位深度缓冲在这个距离上的精度约
  // 0.25 单位, 而地图元素抬升 S*0.0035(16000 的世界里是 56 单位)比它大两个数量级。
  const camera = new THREE.PerspectiveCamera(CAM_FOV[0], 1, S * 0.02, S * 6);
  const camLook = new THREE.Vector3();

  scene.add(new THREE.AmbientLight(0xffb000, 0.35));
  const keyLight = new THREE.DirectionalLight(0xffd9a0, 0.95);
  keyLight.position.set(S * 0.02, S * 0.03, S * 0.018);
  scene.add(keyLight);

  // 高度的压缩映射: 0..ALT_MAX 映射到 0..S*0.09, 再加一点底噪。于是空中单位在网格
  // 上方明显"浮着", 而横向位置仍然准确(俯视读图不会误解坐标)。
  // ALT_MAX 取 10000 m: 广域关卡(s02)的编队巡航在 7000 m、地形最高 6050 m —— 夹在
  // 6000 会把 6000 与 7000 画成同一个高度, 高度这一维就白给了。
  const ALT_MAX = 10000;
  const ALT_K = (S * 0.09) / ALT_MAX;
  const altToY = (alt: number): number => S * 0.004 + Math.min(Math.max(alt, 0), ALT_MAX) * ALT_K;

  // === 星野(视差背景) ===
  const stars = (() => {
    const N = 440;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i += 1) {
      const az = Math.random() * TWO_PI;
      const el = 0.04 + Math.random() * 1.05;
      const r = S * 0.6 + Math.random() * S * 0.25;
      const flat = Math.cos(el) * r;
      pos[i * 3] = CX + Math.cos(az) * flat;
      pos[i * 3 + 1] = Math.sin(el) * r;
      pos[i * 3 + 2] = CZ + Math.sin(az) * flat;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const p = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0xb99a5e, size: 3.4, sizeAttenuation: false, transparent: true,
      opacity: 0.5, depthWrite: false, fog: false,
    }));
    scene.add(p);
    return p;
  })();

  // === 缩比网格战场(两层: 细格底纹 + 扇区粗格) ===
  const gridTiers: { mat: THREE.Material; base: number }[] = [];
  {
    const fine = new THREE.GridHelper(S, 110, COL_GRID_MAJOR, COL_GRID_MINOR);
    fine.position.set(CX, 0, CZ);
    for (const m of (Array.isArray(fine.material) ? fine.material : [fine.material])) {
      m.transparent = true;
      m.depthWrite = false;
      gridTiers.push({ mat: m, base: 0.34 });
    }
    scene.add(fine);
    const coarse = new THREE.GridHelper(S * 1.0002, 11, 0xffb000, 0xffb000);
    coarse.position.set(CX, 0.6, CZ);
    for (const m of (Array.isArray(coarse.material) ? coarse.material : [coarse.material])) {
      m.transparent = true;
      m.depthWrite = false;
      gridTiers.push({ mat: m, base: 0.22 });
    }
    scene.add(coarse);
  }

  // === 方位圈(给网格一个北向参照, 也是旧版"距离玫瑰"的余脉) ===
  const roseMat = new THREE.LineBasicMaterial({
    color: 0xffb000, transparent: true, opacity: 0, depthWrite: false, fog: false,
  });
  const rose = (() => {
    const p: number[] = [];
    const R = S * 0.46;
    for (let i = 0; i < 72; i += 1) {
      const a = (i / 72) * TWO_PI;
      const r0 = i % 6 === 0 ? R * 0.955 : R * 0.98;
      p.push(CX + Math.cos(a) * r0, 1.5, CZ + Math.sin(a) * r0, CX + Math.cos(a) * R, 1.5, CZ + Math.sin(a) * R);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    const ls = new THREE.LineSegments(g, roseMat);
    ls.frustumCulled = false;
    scene.add(ls);
    return ls;
  })();

  // === 空中单位的立杆(合并成 1 个 draw call) ===
  const pinMat = new THREE.LineBasicMaterial({
    color: COL_PIN, transparent: true, opacity: 0, depthWrite: false, fog: false,
  });
  const pins = (() => {
    const p: number[] = [];
    for (const u of intel.units) {
      if (u.altitude <= 0) continue;
      p.push(u.x, 0, u.z, u.x, altToY(u.altitude), u.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p.length ? p : [0, 0, 0, 0, 0, 0], 3));
    const ls = new THREE.LineSegments(g, pinMat);
    ls.frustumCulled = false;
    scene.add(ls);
    return ls;
  })();

  // === 地图平面 ===
  const mapCanvas = paintRegionMap(intel.region, opts.missionId || 'brief', {
    codename: opts.codename,
    missionId: opts.missionId,
    en: opts.en,
    world: intel.world,
    areas: intel.areas,
  });
  const mapTex = new THREE.CanvasTexture(mapCanvas);
  mapTex.colorSpace = THREE.SRGBColorSpace;
  // **flipY = false 是必须的**, 不是风格选择:
  //   PlaneGeometry 经 rotateX(-90°) 后, 平面的 v 与我们的投影 v 是**镜像**的
  //   (v_plane = 0.5 - (z-cz)/S = 1 - v_proj)。CanvasTexture 默认 flipY=true 会再
  //   翻一次, 于是整张贴图相对世界被转了 180° —— 地图上的"北"落在屏幕下方, 而且
  //   所有文字倒过来写(实测: 标题块/比例尺/地名全是倒的)。
  //   关掉 flipY 后, 贴图 t 与平面的 v 一致, 文字与地理同时归位。
  mapTex.flipY = false;
  mapTex.generateMipmaps = true;
  mapTex.minFilter = THREE.LinearMipmapLinearFilter;
  mapTex.magFilter = THREE.LinearFilter;
  if (opts.anisotropy) mapTex.anisotropy = Math.min(8, opts.anisotropy);

  const mapMat = new THREE.MeshBasicMaterial({
    map: mapTex,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    side: THREE.FrontSide,
    toneMapped: false,
    // **必须 fog:false**: 地图拍相机在 2.3S 外, 开着雾会被雾吃掉七成以上。
    fog: false,
  });
  // 揭开/消散遮罩: 往 MeshBasicMaterial 里注入两个 uniform, 而不是另写 ShaderMaterial
  // —— 这样 three 的色彩管线(sRGB 解码 / alpha / 雾)全都保留, 每帧只改一个 float。
  // **customProgramCacheKey 是必须的**: 注入改变了片元源码, 不给缓存键就会命中别的
  // 普通 MeshBasicMaterial 已编译好的 program, uniform 会静默失效。
  const uReveal = { value: isPreview ? 1 : 0 };
  const uRetract = { value: 0 };
  mapMat.onBeforeCompile = (shader) => {
    shader.uniforms.uReveal = uReveal;
    shader.uniforms.uRetract = uRetract;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vBriefUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvBriefUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uReveal;\nuniform float uRetract;\nvarying vec2 vBriefUv;',
      )
      // 注入点选 `map_fragment` 而**不是** `dithering_fragment`:
      //   meshbasic 的片元在 <opaque_fragment> 里就把 diffuseColor.a 写进 gl_FragColor 了,
      //   而 <dithering_fragment> 排在它之后 —— 在那里改 alpha 是**完全无效**的
      //   (实测: 遮罩不管怎么变, 地图都整块亮着)。必须在采样贴图之后、写片元之前动手。
      .replace(
        '#include <map_fragment>',
        [
          '#include <map_fragment>',
          'float bd = distance(vBriefUv, vec2(0.5));',
          // 揭示: 从中心向外画出来, 前沿一条亮带(像扫描把地图画上去)
          'float revealR = uReveal * 0.80;',
          'float on = step(bd, revealR);',
          'float edge = smoothstep(0.014, 0.0, abs(bd - revealR)) * step(0.004, uReveal) * step(uReveal, 0.996);',
          // 消散: 从中心向外掏空
          'float retractR = uRetract * 0.92;',
          'float off = 1.0 - step(bd, retractR);',
          'diffuseColor.a *= on * off * min(1.0, uReveal * 14.0);',
          'diffuseColor.rgb += vec3(1.0, 0.72, 0.30) * edge * 0.9;',
        ].join('\n'),
      );
  };
  mapMat.customProgramCacheKey = () => 'briefingMapReveal';
  const mapGeom = new THREE.PlaneGeometry(S, S);
  mapGeom.rotateX(-Math.PI / 2);
  const mapPlane = new THREE.Mesh(mapGeom, mapMat);
  // 纹理 uv 与地图坐标的对应关系(不需翻转): PlaneGeometry 经 rotateX(-90°) 后
  // 顶点 v=0 落在世界 +Z、u=0 落在 -X; 而 CanvasTexture 默认 flipY=true 使 v=0 采样
  // canvas 顶行 —— canvas 顶部正是地图的北(+Z)。两者一致。
  mapPlane.position.set(CX, MAP_Y, CZ);
  scene.add(mapPlane);

  // === 扫描光幕(地图成像拍扫一遍) ===
  const scanMat = new THREE.MeshBasicMaterial({
    color: COL_SCAN, transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: false, toneMapped: false,
  });
  const scanMesh = (() => {
    const g = new THREE.PlaneGeometry(S * 0.9, S * 0.004);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, scanMat);
    m.position.set(CX, MAP_Y + MAP_LIFT * 2, CZ);
    m.visible = false;
    scene.add(m);
    return m;
  })();

  // === 航线 ===
  const routes: RouteObj[] = [];
  for (const def of intel.routes) {
    const ptsMap = def.points.map((p) => new THREE.Vector3(p[0], MAP_Y + MAP_LIFT, p[2]));
    const curve = new THREE.CatmullRomCurve3(ptsMap, false, 'catmullrom', 0.35);
    const flat = curve.getPoints(86);
    const w0 = def.dash ? S * 0.0034 : S * 0.0052;
    const w1 = def.dash ? S * 0.0016 : S * 0.0014;
    const { geom, segments } = makeRibbonGeometry(flat, w0, w1);

    const ribbonMat = new THREE.MeshBasicMaterial({
      color: def.side === 'friendly' ? COL_ARROW_F : COL_ARROW_E,
      transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
      fog: false, toneMapped: false,
    });
    const ribbon = new THREE.Mesh(geom, ribbonMat);
    ribbon.frustumCulled = false;
    ribbon.visible = false;
    scene.add(ribbon);

    // 箭头锥: 头部的位姿是常量(带的终点不动), 一次算好
    const endP = curve.getPoint(1);
    const endT = curve.getTangent(1).setY(0).normalize();
    const headPos = new THREE.Vector3(endP.x, MAP_Y + MAP_LIFT, endP.z);
    const headQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), endT);
    const head = new THREE.Mesh(makeArrowHeadGeometry(def.dash ? S * 0.0042 : S * 0.0062), ribbonMat);
    head.frustumCulled = false;
    head.visible = false;
    scene.add(head);

    // 3D 航线管: 同样的 XZ, y 抬到网格上方的航行高度
    const ptsGrid = def.points.map((p) => new THREE.Vector3(p[0], altToY(p[1]) + S * 0.006, p[2]));
    const curveGrid = new THREE.CatmullRomCurve3(ptsGrid, false, 'catmullrom', 0.35);
    const tubeGeom = new THREE.TubeGeometry(curveGrid, 96, def.dash ? S * 0.0009 : S * 0.0015, 5, false);
    const tubeMat = new THREE.MeshBasicMaterial({
      color: def.side === 'friendly' ? COL_ROUTE_F : COL_ROUTE_E,
      transparent: true, opacity: 0, depthWrite: false, fog: false, toneMapped: false,
    });
    const tube = new THREE.Mesh(tubeGeom, tubeMat);
    tube.frustumCulled = false;
    tube.visible = false;
    scene.add(tube);
    const tubeIndex = tubeGeom.index ? tubeGeom.index.count : 0;
    tubeGeom.setDrawRange(0, 0);

    // 沿航线跑动的箭头(友军主航路): AC5 的招牌元素
    let runner: THREE.Mesh | undefined;
    if (def.side === 'friendly' && !def.dash) {
      runner = new THREE.Mesh(makeArrowHeadGeometry(S * 0.005), new THREE.MeshBasicMaterial({
        color: COL_RUNNER, transparent: true, opacity: 0, depthWrite: false, fog: false, toneMapped: false,
      }));
      runner.frustumCulled = false;
      runner.visible = false;
      scene.add(runner);
    }

    routes.push({ def, ribbon, ribbonSegments: segments, head, headPos, headQuat, tube, tubeIndex, runner, curveGrid });
  }

  // === 简报区域的地面环(防空圈/威胁圈) ===
  // 地图拍里这个圆已经画在贴图上了; 这一圈是给"缩比网格战场"用的 —— 圆是这一关的
  // 地理本体(编队要飞进去的那片空域), 所以它在切入战场之后必须继续在。
  const areaMats: { mat: THREE.Material; base: number }[] = [];
  for (const a of intel.areas) {
    const ringMat = new THREE.LineBasicMaterial({
      color: hexToInt(toneColor(a.tone)), transparent: true, opacity: 0,
      depthWrite: false, fog: false,
    });
    const discMat = new THREE.MeshBasicMaterial({
      color: hexToInt(toneColor(a.tone)), transparent: true, opacity: 0,
      depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false,
    });
    areaMats.push({ mat: ringMat, base: a.tone === 'friendly' ? 0.85 : 0.7 });
    areaMats.push({ mat: discMat, base: a.tone === 'friendly' ? 0.1 : 0.08 });
    const seg = 96;
    const p: number[] = [];
    for (let i = 0; i < seg; i += 1) {
      const t0 = (i / seg) * TWO_PI;
      const t1 = ((i + 1) / seg) * TWO_PI;
      p.push(
        a.x + Math.cos(t0) * a.radius, 3, a.z + Math.sin(t0) * a.radius,
        a.x + Math.cos(t1) * a.radius, 3, a.z + Math.sin(t1) * a.radius,
      );
    }
    const ring = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(p, 3)),
      ringMat,
    );
    ring.frustumCulled = false;
    scene.add(ring);
    // 内圈虚线: 用更小半径的稀疏段拼(线材质没有 lineDash, 只好自己跳段)
    const p2: number[] = [];
    for (let i = 0; i < seg; i += 1) {
      if (i % 2 === 1) continue;
      const t0 = (i / seg) * TWO_PI;
      const t1 = ((i + 1) / seg) * TWO_PI;
      p2.push(
        a.x + Math.cos(t0) * a.radius * 0.93, 3, a.z + Math.sin(t0) * a.radius * 0.93,
        a.x + Math.cos(t1) * a.radius * 0.93, 3, a.z + Math.sin(t1) * a.radius * 0.93,
      );
    }
    const dash = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(p2, 3)),
      ringMat,
    );
    dash.frustumCulled = false;
    scene.add(dash);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(a.radius, 64), discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(a.x, 1, a.z);
    disc.frustumCulled = false;
    scene.add(disc);
  }

  // === 单位标记 ===
  const markers: MarkerObj[] = [];
  // 先算"标签错位": 同处叠放的带标签单位按出现名次依次拉长引线
  const stemFactor: number[] = [];
  for (let i = 0; i < intel.units.length; i += 1) {
    const u = intel.units[i];
    if (!u.labelled) { stemFactor.push(1); continue; }
    let stacked = 0;
    for (let j = 0; j < i; j += 1) {
      const p = intel.units[j];
      if (!p.labelled) continue;
      if (Math.hypot(p.x - u.x, p.z - u.z) < S * 0.02) stacked += 1;
    }
    stemFactor.push(1 + Math.min(stacked, 4) * 0.28);
  }
  for (const [ui, u] of intel.units.entries()) {
    const mat = new THREE.LineBasicMaterial({
      color: hexToInt(toneColor(u.tone)), transparent: true, opacity: 0,
      depthWrite: false, depthTest: false, fog: false,
    });
    const line = new THREE.LineSegments(makeMarkerGeometry(u.glyph), mat);
    line.frustumCulled = false;
    line.visible = false;
    line.renderOrder = 20; // 标记是"情报层": 永远压在网格与航线之上
    scene.add(line);

    let fill: THREE.Mesh | undefined;
    if (u.fill) {
      fill = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
        color: hexToInt(toneColor(u.tone)), transparent: true, opacity: 0,
        depthWrite: false, depthTest: false, fog: false, toneMapped: false,
      }));
      fill.frustumCulled = false;
      fill.visible = false;
      fill.renderOrder = 19;
      scene.add(fill);
    }

    markers.push({
      unit: u,
      line,
      fill,
      stemK: stemFactor[ui],
      mapPos: new THREE.Vector3(u.x, MAP_Y + MAP_LIFT * 3, u.z),
      gridPos: new THREE.Vector3(u.x, altToY(u.altitude), u.z),
    });
  }

  // === 目标卡片的准星(卡片本体是 DOM; 3D 只出准星与锚点) ===
  // 数组长度必须与 intel.cards 严格一致 —— 组件层按下标取锚点。找不到单位(数据漂移)
  // 就给一个世界中心的兜底位置, 而不是丢掉这一格(丢了会让下标错位)。
  const cards: BriefingCard[] = intel.cards;
  const cardTarget = cards.map((c) => intel.units.find((u) => u.id === c.unitId));
  const reticleMats: THREE.LineBasicMaterial[] = [];
  const reticles: THREE.LineSegments[] = [];
  for (let i = 0; i < cards.length; i += 1) {
    const mat = new THREE.LineBasicMaterial({
      color: hexToInt(toneColor(cards[i].tone)), transparent: true, opacity: 0,
      depthWrite: false, depthTest: false, fog: false,
    });
    const r = new THREE.LineSegments(makeReticleGeometry(), mat);
    r.frustumCulled = false;
    r.visible = false;
    r.renderOrder = 21;
    scene.add(r);
    reticles.push(r);
    reticleMats.push(mat);
  }
  const cardPos = cards.map((c, i) => {
    const u = cardTarget[i];
    return new THREE.Vector3(u ? u.x : CX, MAP_Y + MAP_LIFT * 3, u ? u.z : CZ);
  });
  const cardSize = cards.map((_, i) => 0.042 * (1 + (i % 2) * 0.1));

  // === 高价值目标的线框舰体(沿用旧版"深色剪影 + 琥珀描边"的语汇) ===
  const hullMats: { mat: THREE.Material; base: number }[] = [];
  for (const u of intel.units) {
    if (!u.hull) continue;
    const [w, h, d] = u.hull;
    const geom = new THREE.BoxGeometry(w, h, d);
    const body = new THREE.MeshBasicMaterial({
      color: COL_HULL, transparent: true, opacity: 0, depthWrite: false, fog: false, toneMapped: false,
    });
    const edge = new THREE.LineBasicMaterial({
      color: COL_EDGE, transparent: true, opacity: 0, depthWrite: false, fog: false,
    });
    hullMats.push({ mat: body, base: 0.9 }, { mat: edge, base: 0.72 });
    const g = new THREE.Group();
    g.add(new THREE.Mesh(geom, body));
    g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geom), edge));
    g.position.set(u.x, altToY(u.altitude), u.z);
    g.rotation.y = u.heading ?? 0;
    scene.add(g);
  }

  // ==========================================================================
  // 每帧状态(必须在 update 之前声明 —— update 闭包引用它们)
  // ==========================================================================
  let seekOffset = 0;
  let lastElapsed = 0;
  let previewView: 'map' | 'grid' = 'grid';
  /** 预览模式的时间漂移(在目标时刻附近摆动, 不跑整段过场) */
  let previewT = 6.6;

  /** 每个标记的标签锚点(世界坐标) */
  const labelAnchorPos = markers.map(() => new THREE.Vector3());
  const cardAnchorPos = cards.map(() => new THREE.Vector3());
  const labelAlpha = new Float32Array(markers.length);
  const labelAnchors = new Float32Array(markers.length * 4);
  const cardAlpha = new Float32Array(cards.length);
  const cardAnchors = new Float32Array(cards.length * 4);

  const size = { w: 1, h: 1 };
  const setSize = (w: number, h: number): void => {
    size.w = Math.max(1, w);
    size.h = Math.max(1, h);
    camera.aspect = size.w / size.h;
    camera.updateProjectionMatrix();
  };

  // 复用的临时量(60fps 下每帧 new Vector3 是纯浪费)
  const _up = new THREE.Vector3();
  const _upAxis = new THREE.Vector3();
  const _local = new THREE.Vector3();
  const _anchor = new THREE.Vector3();
  const _proj = new THREE.Vector3();
  const _tangent = new THREE.Vector3();
  const _camDir = new THREE.Vector3();
  const Z_AXIS = new THREE.Vector3(0, 0, 1);
  const Y_AXIS = new THREE.Vector3(0, 1, 0);

  function update(elapsed: number): void {
    lastElapsed = elapsed;
    const t = elapsed + seekOffset;

    // ---------- 预览模式: 在某一拍附近缓慢漂移 ----------
    let seqT = t;
    if (isPreview) {
      const target = previewView === 'grid' ? 15.6 : 10.6;
      previewT += (target - previewT) * 0.025;
      seqT = previewT + Math.sin(elapsed * 0.22) * 0.6;
    }

    // ---------- 1. 相位包络 ----------
    // 必须先算包络: 相机的 up 方向要按 diveK 做插值(见下), 所以它们得在相机之前就位。
    const bootK = smooth(seqT / 1.1);
    const cardsK = isPreview
      ? (previewView === 'map' ? 1 : 0)
      : window01(seqT, BEAT_T[2], 0.5, BEAT_T[3] - BEAT_T[2] - 0.5, 0.6);
    const diveK = isPreview ? 1 : smooth((seqT - BEAT_T[4]) / 1.7);
    const gridK = isPreview ? 1 : smooth((seqT - (BEAT_T[5] - 0.7)) / 1.1);

    // ---------- 2. 相机 ----------
    const px = sampleTrack(CAM_T, CAM_X, seqT) * S;
    const py = sampleTrack(CAM_T, CAM_Y, seqT) * S;
    const pz = sampleTrack(CAM_T, CAM_Z, seqT) * S;
    const lx = sampleTrack(CAM_T, LOOK_X, seqT) * S;
    const ly = sampleTrack(CAM_T, LOOK_Y, seqT) * S;
    const lz = sampleTrack(CAM_T, LOOK_Z, seqT) * S;
    if (isPreview) {
      // 预览: 绕世界中心缓慢环绕(与旧版预览的"自动环绕"同一观感)
      const orbit = elapsed * 0.075;
      const co = Math.cos(orbit);
      const so = Math.sin(orbit);
      camera.position.set(CX + px * co - pz * so, py + Math.sin(elapsed * 0.3) * S * 0.01, CZ + px * so + pz * co);
      camLook.set(CX + lx * co - lz * so, ly, CZ + lx * so + lz * co);
    } else {
      camera.position.set(CX + px + Math.sin(seqT * 1.7) * S * 0.002, py, CZ + pz);
      camLook.set(CX + lx, ly, CZ + lz);
    }
    // 相机的 up 必须跟着拍走:
    //   地图拍是**正俯视(几乎垂直向下)**, 此时 lookAt 默认的 up(0,1,0) 与视线平行,
    //   方向退化 —— three 的 fallback 会给出一个任意翻滚的画面(实测地图被转成 45°
    //   的菱形)。这里在地图拍把 up 定成 +Z: 俯视时"世界北(+Z)在屏幕上方", 既消除
    //   退化, 又正是地图该有的读法(NORTH UP)。切入战场时再插值回 +Y(常规机位)。
    _upAxis.copy(Z_AXIS).lerp(Y_AXIS, diveK).normalize();
    camera.up.copy(_upAxis);
    camera.lookAt(camLook);
    camera.rotateZ(sampleTrack(CAM_T, CAM_ROLL, seqT) + Math.sin(elapsed * 0.4) * 0.004);
    const fov = sampleTrack(CAM_T, CAM_FOV, seqT);
    if (Math.abs(fov - camera.fov) > 0.05) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }

    // ---------- 3. 地图平面: 揭开 / 消散 / 透明度 ----------
    const mapAlpha = isPreview
      ? (previewView === 'map' ? 0.96 : 0)
      : clamp01(bootK * (1 - smooth((seqT - (BEAT_T[4] + 0.7)) / 1.0)));
    if (isPreview) {
      uReveal.value = previewView === 'map' ? 1 : 0;
      uRetract.value = 0;
    } else {
      // 揭示进度: 1.0s 起, 2.8s 画完(正好落在 CARTOGRAPHY 拍里)
      uReveal.value = clamp01(smooth((seqT - 1.0) / 2.8));
      // 消散进度: DIVE 拍由中心向外掏空
      uRetract.value = clamp01(smooth((seqT - BEAT_T[4]) / 1.2));
    }
    mapMat.opacity = mapAlpha;

    // ---------- 4. 扫描光幕 ----------
    const scanWin = isPreview
      ? (previewView === 'map' ? 0.55 : 0)
      : window01(seqT, BEAT_T[1] + 0.5, 0.5, 2.0, 0.8);
    scanMesh.visible = scanWin > 0.01 && mapAlpha > 0.01;
    if (scanMesh.visible) {
      const u = ((seqT - BEAT_T[1] - 0.5) / 3.3 + 4) % 1;
      scanMesh.position.set(CX - S * 0.45 + S * 0.9 * u, MAP_Y + MAP_LIFT * 2, CZ);
      scanMat.opacity = 0.5 * scanWin * mapAlpha * (0.5 + 0.5 * Math.sin(u * Math.PI));
    }

    // ---------- 5. 航线 ----------
    for (let i = 0; i < routes.length; i += 1) {
      const r = routes[i];
      const grow = isPreview
        ? 1
        : smooth(clamp01((seqT - BEAT_T[3] - r.def.delay) / 1.1));
      const ribbonMat = r.ribbon.material as THREE.MeshBasicMaterial;
      r.ribbon.visible = grow > 0.01 && mapAlpha > 0.05;
      if (r.ribbon.visible) {
        r.ribbon.geometry.setDrawRange(0, Math.floor(grow * r.ribbonSegments) * 6);
        ribbonMat.opacity = mapAlpha * (r.def.dash ? 0.7 : 0.92);
        // 箭头锥: 生长过 86% 之后在头部弹出
        const headK = clamp01((grow - 0.86) / 0.14);
        r.head.visible = headK > 0.02;
        if (r.head.visible) {
          r.head.position.copy(r.headPos);
          r.head.quaternion.copy(r.headQuat);
          r.head.scale.setScalar(headK);
          ribbonMat.opacity = mapAlpha * 1.0;
        }
      } else {
        r.head.visible = false;
      }

      // 3D 航线管(GRID 拍)
      if (r.tube) {
        const tubeMat = r.tube.material as THREE.MeshBasicMaterial;
        const tubeGrow = isPreview
          ? 1
          : smooth(clamp01((seqT - (BEAT_T[5] + 1.2) - r.def.delay) / 1.5));
        r.tube.visible = gridK > 0.01 && tubeGrow > 0.005;
        if (r.tube.visible) {
          r.tube.geometry.setDrawRange(0, Math.floor(tubeGrow * r.tubeIndex));
          tubeMat.opacity = gridK * (r.def.dash ? 0.5 : 0.78);
        }
      }

      // 沿航线跑动的箭头(友军主航路)
      if (r.runner) {
        const rm = r.runner.material as THREE.MeshBasicMaterial;
        const runnerOn = gridK * (isPreview ? 1 : clamp01((seqT - (BEAT_T[5] + 2.0)) / 0.8));
        r.runner.visible = runnerOn > 0.02;
        if (r.runner.visible) {
          // getPoint(不是 getPointAt): 纯样条求值, 不触发弧长表重建
          const u = ((elapsed * 0.28) % 1 + 1) % 1;
          r.runner.position.copy(r.curveGrid.getPoint(u));
          _tangent.copy(r.curveGrid.getTangent(u)).normalize();
          r.runner.quaternion.setFromUnitVectors(Z_AXIS, _tangent);
          rm.opacity = runnerOn * 0.95;
        }
      }
    }

    // ---------- 6. 网格战场 / 立杆 / 方位圈 / 区域环 / 雾 ----------
    for (const tier of gridTiers) {
      (tier.mat as THREE.Material & { opacity: number }).opacity = tier.base * gridK;
    }
    // 区域环属于"战场"这一层: 地图拍里这个圆已经画在贴图上了(见 briefing-map),
    // 所以这里跟着 gridK 走 —— 地图消散的同时, 地面上的那圈环接上来。
    for (const am of areaMats) {
      (am.mat as THREE.Material & { opacity: number }).opacity = am.base * gridK;
    }
    pinMat.opacity = gridK * 0.55;
    pins.visible = gridK > 0.01;
    roseMat.opacity = 0.3 * gridK;
    rose.visible = gridK > 0.01;
    // 雾: 地图拍拉远(几乎无雾), 战场拍收近给纵深
    fog.near = mix(S * 0.6, S * 0.12, diveK);
    fog.far = mix(S * 3.0, S * 1.5, diveK);
    stars.rotation.y = elapsed * 0.02;

    // ---------- 7. 线框舰体 ----------
    for (const hm of hullMats) {
      (hm.mat as THREE.Material & { opacity: number }).opacity = hm.base * gridK;
    }

    // ---------- 8. 单位标记(地图上弹出 -> 升到空中) ----------
    // 一条时钟管到底: 标记在地图拍按 delay 错峰出现, 第五拍随 diveK 从地图平面升到
    // 自己的高度(位置插值), 于是"地图上的那个点"就是"战场里的那个标记"。
    const sizeK = 2 * Math.tan(camera.fov * 0.5 * DEG2RAD);
    _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    for (let i = 0; i < markers.length; i += 1) {
      const m = markers[i];
      const u = m.unit;
      const at = isPreview ? 0 : BEAT_T[2] - 0.4 + u.delay;
      const pop = popIn(seqT, at, 0.62);
      _local.copy(m.mapPos).lerp(m.gridPos, diveK);
      const dist = _local.distanceTo(camera.position);
      const markScreen = mix(MARK_SCREEN_MAP, MARK_SCREEN_GRID, diveK);
      const waveDim = (u.wave ?? 1) > 1 ? 0.62 : 1;
      const pulse = 0.5 + 0.5 * Math.sin(elapsed * 2.1 + i * 0.9);
      const s = dist * sizeK * markScreen * u.size * pop * (1 + 0.05 * pulse);
      const alpha = pop * waveDim * (0.72 + 0.28 * pulse) * bootK;
      const on = alpha > 0.02 && s > 0;
      m.line.visible = on;
      (m.line.material as THREE.LineBasicMaterial).opacity = alpha;
      if (on) {
        m.line.position.copy(_local);
        m.line.quaternion.copy(camera.quaternion);
        m.line.scale.setScalar(s);
        if (m.fill) {
          m.fill.visible = true;
          m.fill.position.copy(_local);
          m.fill.quaternion.copy(camera.quaternion);
          m.fill.scale.setScalar(s);
          (m.fill.material as THREE.MeshBasicMaterial).opacity = alpha * 0.34;
        }
      } else if (m.fill) {
        m.fill.visible = false;
      }
      // 标签锚点 = 引线顶端(billboard 局部 (0, STEM_LEN, 0) 经缩放、再乘错位倍率)
      // **只有 labelled 的单位出 DOM 标签**: 标记图形照画(不谎报敌人数量), 但密集关卡
      // (t00 有 39 个、s02 有 21 个)把几十个标签全铺上去就成了一片糊字。
      labelAlpha[i] = on && u.labelled ? alpha : 0;
      labelAnchorPos[i].copy(_local).addScaledVector(_up, STEM_LEN * m.stemK * s);
    }

    // ---------- 9. 目标卡片准星 + 锚点 ----------
    for (let i = 0; i < reticles.length; i += 1) {
      const k = reticles.length > 1 ? i / (reticles.length - 1) : 0;
      const at = isPreview ? 0 : BEAT_T[2] + 0.15 + k * 0.35;
      const pop = isPreview ? 1 : popIn(seqT, at, 0.7);
      const on = pop * cardsK * mapAlpha;
      const r = reticles[i];
      r.visible = on > 0.02;
      cardAlpha[i] = r.visible ? on : 0;
      if (!r.visible) continue;
      const dist = cardPos[i].distanceTo(camera.position);
      const s = dist * sizeK * cardSize[i] * pop;
      r.position.copy(cardPos[i]);
      r.quaternion.copy(camera.quaternion);
      r.scale.setScalar(s);
      reticleMats[i].opacity = on;
      // 卡片锚点 = 地图位置 + 相机上方向 * (距离 * 错开的引出长度)
      cardAnchorPos[i].copy(cardPos[i]).addScaledVector(_up, dist * CARD_LIFT[i % 4] * pop);
    }
  }

  // ==========================================================================
  // 投影(必须在 renderer.render() 之后调用: matrixWorldInverse 是 render 里刷新的)
  // ==========================================================================
  function projectAnchors(): void {
    camera.getWorldDirection(_camDir);
    for (let i = 0; i < markers.length; i += 1) {
      const o = i * 4;
      const a = labelAlpha[i];
      // 相机背后的点: project() 会除以负的 w, 得到左右上下都反过来的假坐标 —— 必须
      // 先用点积剔掉, 否则俯冲穿过标记层时标签会突然出现在画面另一侧。
      if (a <= 0.02 || !inFront(labelAnchorPos[i])) {
        labelAnchors[o + 2] = 0;
        labelAnchors[o + 3] = 0;
        continue;
      }
      _proj.copy(labelAnchorPos[i]).project(camera);
      labelAnchors[o] = _proj.x;
      labelAnchors[o + 1] = _proj.y;
      labelAnchors[o + 2] = a;
      // 出画就整块藏起来: 贴在屏幕边上读不出是谁, 不如不显示
      labelAnchors[o + 3] = Math.abs(_proj.x) < 1.04 && Math.abs(_proj.y) < 1.04 ? 1 : 0;
    }
    for (let i = 0; i < cards.length; i += 1) {
      const o = i * 4;
      const a = cardAlpha[i];
      if (a <= 0.02 || !inFront(cardAnchorPos[i])) {
        cardAnchors[o + 2] = 0;
        cardAnchors[o + 3] = 0;
        continue;
      }
      _proj.copy(cardAnchorPos[i]).project(camera);
      cardAnchors[o] = _proj.x;
      cardAnchors[o + 1] = _proj.y;
      cardAnchors[o + 2] = a;
      // 卡片比标签大, 边界放宽一点(卡片的引线还在画面内就不该整块消失)
      cardAnchors[o + 3] = Math.abs(_proj.x) < 1.1 && Math.abs(_proj.y) < 1.1 ? 1 : 0;
    }
  }

  function inFront(p: THREE.Vector3): boolean {
    _anchor.subVectors(p, camera.position);
    return _anchor.dot(_camDir) > 0;
  }

  const dispose = (): void => {
    // 遍历释放几何/材质(GridHelper / 合并的立杆 / 单位几何都在这里回收)。
    // 共享材质会被重复 dispose 若干次 —— three 的 dispose 是幂等事件分发, 无害。
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    });
    // 背景贴图挂在 scene 上, 遍历不到, 必须单独释放; 地图贴图同理
    gradient.dispose();
    mapTex.dispose();
    scene.clear();
  };

  return {
    scene,
    camera,
    setSize,
    update,
    seek: (target: number) => { seekOffset = target - lastElapsed; },
    // update(0) 让内部时间恰为 t(见接口注释)
    renderAt: (target: number) => { lastElapsed = 0; seekOffset = target; update(0); },
    time: () => lastElapsed + seekOffset,
    projectAnchors,
    labelAnchors,
    cardAnchors,
    setPreviewView: (v) => { previewView = v; },
    mapImage: mapCanvas,
    dispose,
  };
}
