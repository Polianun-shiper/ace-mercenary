// ============================================================================
// 2D 区域地图 —— 程序化"军用地图"贴图
// ============================================================================
// 简报的前四拍是"2D 地图": 经纬网、海岸线、等高线、地名、比例尺、图廓。这些全部
// 由 Canvas2D 现画, **不加载任何图片** —— 与简报屏"零外部资源、进得快、卸得干净"
// 的第一原则一致(见 StoryBrief.tsx 文件头)。
//
// 为什么不用 SVG: 这张图要当 3D 场景里一块地面的贴图(相机从高空俯视它, 再俯冲
// 穿过它)。Canvas2D 直接产出 CanvasTexture; SVG 要先光栅化, 多一步还更慢。
//
// 地形怎么来的: 一份低频 fbm 高度场(山脊调制 + 向心衰减) + Marching Squares 提
// 等值线。海岸线就是"海平面那条等值线", 等高线就是更高几条 —— 一套实现同时喂 6
// 种地图预设(海洋/群岛/山地/沙漠/城市/自定义)。
//
// **海平面是自适应算出来的, 不是写死的常数**: 各预设只声明"陆地占全图多大比例",
// 海平面取高度场的对应分位数。于是噪声怎么调、预设怎么加, 水陆比例都不会跑偏。
//
// 确定性: 全部随机量从 mission id 播种(见 briefing-intel 的 mulberry32)。同一关
// 每次进场必须是同一张图, 否则"情报"每次都变了。

import type { MapPreset } from './types';
import { mulberry32, projectToMap, seedFrom, type BriefingArea, type BriefingWorld } from './briefing-intel';

/** 贴图边长。2048² 覆盖 16000m 的世界 ≈ 7.8m/texel; 全图入画时文字约 12px, 可读。 */
const TEX = 2048;
/** 高度场采样分辨率(决定海岸线细节与生成耗时)。512² 约 40-90ms, 菜单挂载可接受。 */
const FIELD = 512;
/**
 * 内容安全边距。外圈这段会被 alpha 渐隐吃掉, 所以**所有图廓元素都必须落在它之内**
 * (第一版把标题块放在 70px 处, 正好被渐隐擦掉一半 —— 这类"自己擦自己"的坑全靠
 * 一个足够大的内边距避免)。
 */
const SAFE = 96;

// == 配色(AMBER CRT 族: 纸面近黑, 线条/文字琥珀) ==============================
// 亮度标定说明: 这张图是**信息载体**, 不是背景装饰 —— 它的亮部必须明显高于
// 场景背景(近黑)才能在"地图拍"里一眼读出陆地/海岸/等高线/网格。
// 第一版用了纯黑纸面 + 极低 alpha 的线, 结果整张图跟背景糊在一起(实测画面平均亮度
// 只有 10/255, 亮像素占比 0.3%), 完全读不出是地图。所以陆地提亮到中暗调、
// 网格/海岸/等高线的 alpha 整体上调 —— 仍然远暗于 HUD 的琥珀, 层次不变。
const C_PAPER = '#0a0703';
const C_WATER = '#050302';
const C_HATCH = 'rgba(255,176,0,0.085)';
const C_STIPPLE = 'rgba(255,176,0,0.16)';
const C_COAST = '#d9901f';
const C_CONTOUR = 'rgba(226,132,20,0.72)';
const C_CONTOUR_HI = 'rgba(255,190,40,0.62)';
const C_GRID = 'rgba(255,176,0,0.30)';
const C_GRID_FINE = 'rgba(255,176,0,0.11)';
const C_FRAME = 'rgba(255,176,0,0.52)';
const C_TEXT = '#d2760f';
const C_TEXT_HI = '#ffb000';
const C_ROAD = 'rgba(255,176,0,0.30)';
const C_RIVER = 'rgba(122,180,255,0.24)';
const C_RED = '#ff3b1f';
/** 陆地本体填充(与 C_WATER 拉开层次) */
const LAND_RGB = [0x2e, 0x21, 0x0c] as const;
/** 内陆高地提亮(让地图有"起伏"的明暗) */
const LAND_HI_RGB = [0x46, 0x33, 0x15] as const;

/** 每种地图预设的地貌参数 */
const PRESET: Record<MapPreset, {
  /** 陆地占全图的面积比例(海平面按它的分位数取) —— 比"阈值常数"稳得多 */
  land: number;
  /** 等高线条数 */
  contours: number;
  /** 向心衰减强度(0 = 均匀噪声, 1 = 只剩中心一块陆地) */
  falloff: number;
  /** 噪声频率(越小 = 地块越大) */
  freq: number;
  /** 山脊调制占比(高山地 = 山脊感) */
  ridge: number;
  stipple: boolean;
  roads: boolean;
  dunes: boolean;
}> = {
  ocean:       { land: 0.34, contours: 2, falloff: 0.55, freq: 2.1, ridge: 0.30, stipple: true,  roads: false, dunes: false },
  archipelago: { land: 0.42, contours: 2, falloff: 0.28, freq: 3.4, ridge: 0.42, stipple: true,  roads: false, dunes: false },
  mountain:    { land: 0.64, contours: 5, falloff: 0.40, freq: 2.6, ridge: 0.72, stipple: false, roads: true,  dunes: false },
  desert:      { land: 0.58, contours: 3, falloff: 0.46, freq: 2.2, ridge: 0.35, stipple: true,  roads: true,  dunes: true  },
  city:        { land: 0.52, contours: 1, falloff: 0.50, freq: 2.4, ridge: 0.25, stipple: true,  roads: true,  dunes: false },
  custom:      { land: 0.56, contours: 4, falloff: 0.44, freq: 2.5, ridge: 0.55, stipple: true,  roads: false, dunes: false },
};

/** 地名表(双语)。密度刻意很低 —— 军用地图的信息密度靠网格与等高线, 不靠地名。 */
const PLACES: Record<MapPreset, string[]> = {
  ocean: ['南湾 · KAPPA BAY', '断崖海角 · CAPE DRAKE', '母港 · HOME PORT', '灰鲸礁 · GREY WHALE REEF', '深水区 · DEEP WATER', '外海锚地 · OUTER ANCHORAGE'],
  archipelago: ['香料群岛 · SPICE ISLES', '珊瑚滩 · CORAL FLAT', '灯塔岛 · LIGHT ISLE', '风隙水道 · WIND GAP', '锚地 · ANCHORAGE', '南礁群 · SOUTH REEFS'],
  mountain: ['雪脊 · SNOW RIDGE', '鹰巢 · EAGLE NEST', '断喉隘 · THROAT PASS', '关西边境 · KANSAI BORDER', '旧矿场 · OLD MINE', '北坳 · NORTH COL'],
  desert: ['干河床 · DRY RIVER', '红沙岗 · RED SAND RIDGE', '驼队驿 · CARAVAN POST', '盐湖 · SALT LAKE', '哨站 7 · OUTPOST 7', '风口 · WIND GATE'],
  city: ['中央区 · CENTRAL WARD', '工业港 · INDUSTRIAL PORT', '旧城区 · OLD TOWN', '机场 · AIRFIELD', '河湾 · RIVER BEND', '东郊 · EAST SUBURB'],
  custom: ['勘测区 · SURVEY ZONE', '观测站 · OBSERVATION POST', '雪原 · SNOW PLAIN', '前进补给点 · DEPOT', '北部山脊 · NORTH RIDGE', '谷地 · VALLEY FLOOR'],
};

const MONO = '"Arial Narrow", "Liberation Sans Narrow", Consolas, monospace';

// ============================================================================
// 噪声
// ============================================================================

/** 值噪声(平滑插值)。perm 由种子决定, 所以同一关的高度场永远一样。 */
function makeNoise(perm: Uint8Array): (x: number, y: number) => number {
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const h = (a: number, b: number): number => perm[(perm[a & 255] + (b & 255)) & 255] / 255;
    const n00 = h(xi, yi);
    const n10 = h(xi + 1, yi);
    const n01 = h(xi, yi + 1);
    const n11 = h(xi + 1, yi + 1);
    return (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v;
  };
}

/** 标准化 fbm。奇数阶做山脊调制(abs 折返) -> 海岸线有"半岛与海湾"而不是棉花团 */
function makeFbm(noise: (x: number, y: number) => number, octaves: number) {
  return (x: number, y: number): number => {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    let f = 1;
    for (let i = 0; i < octaves; i += 1) {
      const n = noise(x * f, y * f);
      const v = i % 2 === 1 ? 1 - Math.abs(n * 2 - 1) : n;
      sum += v * amp;
      norm += amp;
      amp *= 0.5;
      f *= 2.03;
    }
    return sum / norm;
  };
}

// ============================================================================
// Marching Squares(等值线)
// ============================================================================
// 只产出线段(不做折线拼接): 肉眼完全一样, 但省掉一整套拓扑拼接代码。对"只要线在
// 那里"的海岸线/等高线需求, 这是划算的取舍。
interface Seg { x0: number; y0: number; x1: number; y1: number }

function marchingSquares(field: Float32Array, n: number, level: number, out: Seg[]): void {
  const at = (i: number, j: number): number => field[j * (n + 1) + i];
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const tl = at(i, j);
      const tr = at(i + 1, j);
      const br = at(i + 1, j + 1);
      const bl = at(i, j + 1);
      let idx = 0;
      if (tl > level) idx |= 8;
      if (tr > level) idx |= 4;
      if (br > level) idx |= 2;
      if (bl > level) idx |= 1;
      if (idx === 0 || idx === 15) continue;
      const t = (a: number, b: number): number => {
        const d = b - a;
        return Math.abs(d) < 1e-6 ? 0.5 : (level - a) / d;
      };
      const top: [number, number] = [i + t(tl, tr), j];
      const right: [number, number] = [i + 1, j + t(tr, br)];
      const bottom: [number, number] = [i + t(bl, br), j + 1];
      const left: [number, number] = [i, j + t(tl, bl)];
      const push = (a: [number, number], b: [number, number]): void => {
        out.push({ x0: a[0], y0: a[1], x1: b[0], y1: b[1] });
      };
      switch (idx) {
        case 1: case 14: push(left, bottom); break;
        case 2: case 13: push(bottom, right); break;
        case 3: case 12: push(left, right); break;
        case 4: case 11: push(top, right); break;
        case 5: push(left, top); push(bottom, right); break;
        case 6: case 9: push(top, bottom); break;
        case 7: case 8: push(left, top); break;
        case 10: push(top, right); push(left, bottom); break;
        default: break;
      }
    }
  }
}

/** 圆角矩形路径(手写 arcTo, 不依赖 ctx.roundRect —— 少一个兼容性变量) */
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * 画一段在屏幕上是正字的文字。
 *
 * 为什么需要它: 相机的 up 是 +Z(俯视时北在屏幕上方), 而世界是右手系 —— 于是屏幕右
 * 方向 = **-X**。贴图里字形的走向是沿 canvas +x(= 世界 +X)的, 到了屏幕上就整体左右
 * 镜像(实测: 标题块/地名/比例尺全是反字)。地理与标记都没错(它们共用同一套世界坐标,
 * 互相是对齐的), 错的只有字形方向 —— 所以这里只把字形就地镜像, 位置一概不动。
 * (与 Hud.tsx 的 Minimap 同一个成因, 那边是靠横向分量取反解决的。)
 */
function mirroredText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  const w = ctx.measureText(text).width;
  const align = ctx.textAlign;
  const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  ctx.save();
  ctx.translate(left + w, 0);
  ctx.scale(-1, 1);
  // 镜像空间里右对齐= 视觉上的左对齐
  ctx.textAlign = 'right';
  ctx.fillText(text, 0, y);
  ctx.restore();
}

// ============================================================================
// 主绘制
// ============================================================================

export interface MapPaintOpts {
  codename: string;
  /** 任务 id(显示在图廓上) */
  missionId: string;
  en: boolean;
  /** 世界范围 —— 画区域(防空圈)时必须用它与 projectToMap 对齐真实坐标 */
  world: BriefingWorld;
  /** 简报区域(防空圈/威胁圈); 空数组就不画 */
  areas: readonly BriefingArea[];
  /** 世界边长(米) —— 两位调用方在传, 但接口漏了这个字段(typecheck 报 TS2353) */
  worldSize?: number;
}

/**
 * 画一张区域地图, 返回可直接 `new THREE.CanvasTexture()` 的 canvas。
 * 纯 Canvas2D, 无外部资源; 一次性成本约 80-150ms(挂在简报进场时)。
 */
export function paintRegionMap(region: MapPreset, seedKey: string, opts: MapPaintOpts): HTMLCanvasElement {
  const cfg = PRESET[region] ?? PRESET.ocean;
  const rand = mulberry32(seedFrom(`${seedKey}|${region}`));
  const canvas = document.createElement('canvas');
  canvas.width = TEX;
  canvas.height = TEX;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.imageSmoothingEnabled = true;

  // === 1. 高度场 ===
  // 向心衰减让"中心一块主陆地 + 边缘是海", 比均匀噪声像真地图得多。
  const perm = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) perm[i] = i;
  for (let i = 255; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  const fbm = makeFbm(makeNoise(perm), 5);
  const ccx = 0.5 + (rand() - 0.5) * 0.16;
  const ccy = 0.5 + (rand() - 0.5) * 0.16;
  const p1x = ccx + (rand() - 0.5) * 0.22;
  const p1y = ccy + (rand() - 0.5) * 0.22;
  const p2x = ccx + (rand() - 0.5) * 0.34;
  const p2y = ccy + (rand() - 0.5) * 0.34;

  const N = FIELD + 1;
  const field = new Float32Array(N * N);
  let maxH = 0;
  for (let j = 0; j < N; j += 1) {
    const v = j / FIELD;
    for (let i = 0; i < N; i += 1) {
      const u = i / FIELD;
      const base = fbm(u * cfg.freq, v * cfg.freq);
      const r1 = Math.hypot(u - p1x, v - p1y);
      const r2 = Math.hypot(u - p2x, v - p2y);
      const peak = Math.exp(-r1 * r1 * 7.5) + 0.62 * Math.exp(-r2 * r2 * 11);
      // 边缘衰减: 靠近画布边缘平滑压到 0 —— 保证四周是海, 地图才有"区域"感
      const edge = Math.min(1, Math.min(u, 1 - u, v, 1 - v) * 4.2);
      const h = (base * (1 - cfg.ridge) + base * base * cfg.ridge) * 0.72 + peak * 0.5;
      const f = h * (1 - cfg.falloff * (1 - edge));
      field[j * N + i] = f;
      if (f > maxH) maxH = f;
    }
  }

  // === 2. 自适应海平面 ===
  // 取"陆地占比"对应的分位数当海平面。这样即使噪声/预设怎么调, 水陆比例都稳定。
  const sorted = Float32Array.prototype.slice.call(field) as Float32Array;
  sorted.sort();
  const seaIdx = Math.max(0, Math.min(sorted.length - 1, Math.round((1 - cfg.land) * (sorted.length - 1))));
  const sea = sorted[seaIdx];
  // 高地: 海平面之上 30% 处起算(给内陆提亮)
  const hiLo = sea + (maxH - sea) * 0.3;

  // === 3. 纸面 + 水 ===
  ctx.fillStyle = C_PAPER;
  ctx.fillRect(0, 0, TEX, TEX);
  ctx.fillStyle = C_WATER;
  ctx.fillRect(0, 0, TEX, TEX);
  ctx.strokeStyle = C_HATCH;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let k = -TEX; k < TEX * 2; k += 26) {
    ctx.moveTo(k, 0);
    ctx.lineTo(k + TEX, TEX);
  }
  ctx.stroke();

  // === 4. 陆地(512² 逐像素算 alpha, 再平滑放大 —— 比逐像素画 2048² 快 16 倍) ===
  const blit = (
    pick: (h: number) => { r: number; g: number; b: number; a: number },
  ): void => {
    const off = document.createElement('canvas');
    off.width = N;
    off.height = N;
    const octx = off.getContext('2d');
    if (!octx) return;
    const img = octx.createImageData(N, N);
    for (let p = 0; p < field.length; p += 1) {
      const c = pick(field[p]);
      img.data[p * 4] = c.r;
      img.data[p * 4 + 1] = c.g;
      img.data[p * 4 + 2] = c.b;
      img.data[p * 4 + 3] = c.a;
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, TEX, TEX);
  };
  // 陆地本体(软边: 海岸线因此有"墨晕"的手绘感)
  blit((h) => {
    let a = (h - sea) / 0.012 + 0.5;
    a = a < 0 ? 0 : a > 1 ? 1 : a;
    return { r: LAND_RGB[0], g: LAND_RGB[1], b: LAND_RGB[2], a: Math.round(a * 255) };
  });
  // 内陆提亮(第二次绘制, 用更高的阈值)
  blit((h) => {
    let a = (h - hiLo) / 0.05 + 0.5;
    a = a < 0 ? 0 : a > 1 ? 1 : a;
    return { r: LAND_HI_RGB[0], g: LAND_HI_RGB[1], b: LAND_HI_RGB[2], a: Math.round(a * 215) };
  });

  // === 5. 陆地网点 ===
  if (cfg.stipple) {
    ctx.fillStyle = C_STIPPLE;
    const step = 9;
    for (let j = 0; j < TEX; j += step) {
      const fj = Math.min(FIELD, Math.round((j / TEX) * FIELD));
      const rowOff = Math.floor(j / step) % 2;
      for (let i = 0; i < TEX; i += step) {
        const fi = Math.min(FIELD, Math.round((i / TEX) * FIELD));
        if (field[fj * N + fi] <= sea) continue;
        ctx.fillRect(i + rowOff * 2, j, 1.6, 1.6);
      }
    }
  }

  // === 6. 海岸线 + 等高线 ===
  const scale = TEX / FIELD;
  const segs: Seg[] = [];
  const strokeSegs = (list: Seg[], style: string, width: number): void => {
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (const s of list) {
      ctx.moveTo(s.x0 * scale, s.y0 * scale);
      ctx.lineTo(s.x1 * scale, s.y1 * scale);
    }
    ctx.stroke();
  };
  segs.length = 0;
  marchingSquares(field, FIELD, sea, segs);
  strokeSegs(segs, C_COAST, 2.6);
  for (let k = 1; k <= cfg.contours; k += 1) {
    const level = sea + (maxH - sea) * (k / (cfg.contours + 1));
    segs.length = 0;
    marchingSquares(field, FIELD, level, segs);
    strokeSegs(segs, k === cfg.contours ? C_CONTOUR_HI : C_CONTOUR, k === cfg.contours ? 2.0 : 1.5);
  }

  // === 7. 河流(从两座峰沿最陡下降走到海) ===
  ctx.strokeStyle = C_RIVER;
  ctx.lineWidth = 3.2;
  ctx.lineCap = 'round';
  for (const pk of [[p1x, p1y], [p2x, p2y]]) {
    let u = pk[0];
    let v = pk[1];
    ctx.beginPath();
    ctx.moveTo(u * TEX, v * TEX);
    for (let step = 0; step < 300; step += 1) {
      let bu = u;
      let bv = v;
      let bh = field[Math.round(v * FIELD) * N + Math.round(u * FIELD)];
      for (let d = 0; d < 8; d += 1) {
        const a = (d / 8) * Math.PI * 2;
        const nu = u + Math.cos(a) * 0.006;
        const nv = v + Math.sin(a) * 0.006;
        if (nu < 0 || nu > 1 || nv < 0 || nv > 1) continue;
        const nh = field[Math.round(nv * FIELD) * N + Math.round(nu * FIELD)] + (rand() - 0.5) * 0.004;
        if (nh < bh) { bh = nh; bu = nu; bv = nv; }
      }
      if (bu === u && bv === v) break;
      u = bu; v = bv;
      ctx.lineTo(u * TEX, v * TEX);
      if (bh <= sea) break;
    }
    ctx.stroke();
  }

  // === 8. 沙丘纹(沙漠) ===
  if (cfg.dunes) {
    ctx.strokeStyle = 'rgba(255,176,0,0.075)';
    ctx.lineWidth = 5;
    for (let k = 0; k < 26; k += 1) {
      const y0 = (k / 26) * TEX + (rand() - 0.5) * 40;
      ctx.beginPath();
      let drawing = false;
      for (let i = 0; i <= 72; i += 1) {
        const x = (i / 72) * TEX;
        const y = y0 + Math.sin(i * 0.5 + k) * 16 + Math.sin(i * 0.17 + k * 2.3) * 26;
        const fi = Math.max(0, Math.min(FIELD, Math.round((x / TEX) * FIELD)));
        const fj = Math.max(0, Math.min(FIELD, Math.round((y / TEX) * FIELD)));
        if (field[fj * N + fi] <= sea) { drawing = false; continue; }
        if (!drawing) { ctx.moveTo(x, y); drawing = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  // === 9. 路网(城市/山地/沙漠) ===
  if (cfg.roads) {
    // 先落在陆地上的枢纽点, 再连成路
    const hubs: [number, number][] = [];
    for (let k = 0; k < 200 && hubs.length < 6; k += 1) {
      const u = 0.12 + rand() * 0.76;
      const v = 0.12 + rand() * 0.76;
      if (field[Math.round(v * FIELD) * N + Math.round(u * FIELD)] > sea) hubs.push([u, v]);
    }
    if (region === 'city') {
      ctx.strokeStyle = 'rgba(255,176,0,0.13)';
      ctx.lineWidth = 1.4;
      for (const hub of hubs) {
        const hx = hub[0] * TEX;
        const hy = hub[1] * TEX;
        const R = 90 + rand() * 70;
        for (let g = -R; g <= R; g += 16) {
          ctx.beginPath();
          ctx.moveTo(hx + g, hy - R); ctx.lineTo(hx + g, hy + R);
          ctx.moveTo(hx - R, hy + g); ctx.lineTo(hx + R, hy + g);
          ctx.stroke();
        }
      }
    }
    ctx.strokeStyle = C_ROAD;
    ctx.lineWidth = 2.2;
    ctx.setLineDash(region === 'city' ? [] : [10, 7]);
    for (let k = 0; k + 1 < hubs.length; k += 1) {
      const a = hubs[k];
      const b = hubs[k + 1];
      const mu = (a[0] + b[0]) / 2 + (rand() - 0.5) * 0.08;
      const mv = (a[1] + b[1]) / 2 + (rand() - 0.5) * 0.08;
      ctx.beginPath();
      ctx.moveTo(a[0] * TEX, a[1] * TEX);
      ctx.quadraticCurveTo(mu * TEX, mv * TEX, b[0] * TEX, b[1] * TEX);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // === 10. 简报区域(防空圈 / 威胁圈) ===
  // 这一步必须用 projectToMap 把**真实世界坐标**投到画布上 —— 网格、区域、3D 里的
  // 标记因此共享同一套坐标: 地图上这个圆, 就是飞行员最终要飞进去的那片空域。
  // 画布 y = (1 - v) * TEX(v = +Z 朝上), 与贴图 v=0 采样画布顶行一致。
  const wSize = opts.world.size;
  const toPx = (x: number, z: number): [number, number] => {
    const [u, v] = projectToMap(x, z, opts.world);
    return [u * TEX, (1 - v) * TEX];
  };
  for (const a of opts.areas) {
    const [ax, ay] = toPx(a.x, a.z);
    const ar = (a.radius / wSize) * TEX;
    const friendly = a.tone === 'friendly';
    const stroke = friendly ? '#5ad2ff' : '#ff3b1f';
    const fill = friendly ? 'rgba(90,210,255,0.10)' : 'rgba(255,59,31,0.10)';
    ctx.save();
    ctx.beginPath();
    ctx.arc(ax, ay, ar, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 5;
    ctx.stroke();
    // 内圈虚线(军用地图惯例: 双线 = 明确的界区)
    ctx.beginPath();
    ctx.arc(ax, ay, ar * 0.93, 0, Math.PI * 2);
    ctx.setLineDash([26, 16]);
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.setLineDash([]);
    // 十字分划(圆心)
    const cross = Math.min(70, ar * 0.18);
    ctx.beginPath();
    ctx.moveTo(ax - cross, ay); ctx.lineTo(ax + cross, ay);
    ctx.moveTo(ax, ay - cross); ctx.lineTo(ax, ay + cross);
    ctx.lineWidth = 2.5;
    ctx.stroke();
    // 注解: 圆上方一条引线 + 文字
    ctx.font = `700 28px ${MONO}`;
    const label = `${a.label} · R ${(a.radius / 1000).toFixed(1)}KM`;
    const tw = ctx.measureText(label).width;
    const ty = ay - ar - 26;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(ax, ay - ar);
    ctx.lineTo(ax, ty + 10);
    ctx.lineTo(ax + 34 + tw, ty + 10);
    ctx.stroke();
    ctx.fillStyle = stroke;
    ctx.textBaseline = 'alphabetic';
    mirroredText(ctx, label, ax + 40, ty + 2);
    ctx.restore();
  }

  // === 11. 经纬网(8×8 分区, 与 briefing-intel 的 gridRef 完全对应) ===
  // 这张网不是装饰: 卡片上的 "GRID K07-42" 就是按这套分区算出来的, 列号 A..H 在
  // 上下、行号 8..1 在左右, 与 gridRef 的编码一一对应。
  const cell = TEX / 8;
  ctx.strokeStyle = C_GRID_FINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 40; i += 1) {
    if (i % 5 === 0) continue;
    const p = (i / 40) * TEX;
    ctx.moveTo(p, 0); ctx.lineTo(p, TEX);
    ctx.moveTo(0, p); ctx.lineTo(TEX, p);
  }
  ctx.stroke();
  ctx.strokeStyle = C_GRID;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  for (let i = 0; i <= 8; i += 1) {
    const p = i * cell;
    ctx.moveTo(p, 0); ctx.lineTo(p, TEX);
    ctx.moveTo(0, p); ctx.lineTo(TEX, p);
  }
  ctx.stroke();
  // 列号 / 行号(贴在安全边距之内)
  ctx.font = `700 34px ${MONO}`;
  ctx.fillStyle = C_TEXT_HI;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < 8; i += 1) {
    const x = i * cell + cell / 2;
    const col = String.fromCharCode(65 + i);
    mirroredText(ctx, col, x, SAFE - 34);
    mirroredText(ctx, col, x, TEX - SAFE + 34);
  }
  // 行号自顶向下 = 1..8: 画布顶边是北, 而 gridRef 把最北那条带编为 1(北端 row=7 -> 8-7=1)
  for (let i = 0; i < 8; i += 1) {
    const y = i * cell + cell / 2;
    const row = String(i + 1);
    ctx.textAlign = 'left';
    mirroredText(ctx, row, SAFE - 46, y);
    ctx.textAlign = 'right';
    mirroredText(ctx, row, TEX - SAFE + 46, y);
  }
  ctx.textAlign = 'left';

  // === 12. 地名 ===
  const names = PLACES[region] ?? PLACES.ocean;
  let placed = 0;
  for (let k = 0; k < 300 && placed < 5; k += 1) {
    const u = 0.14 + rand() * 0.72;
    const v = 0.14 + rand() * 0.72;
    if (field[Math.round(v * FIELD) * N + Math.round(u * FIELD)] <= sea + 0.03) continue;
    const label = names[placed];
    if (!label) break;
    const x = u * TEX;
    const y = v * TEX;
    ctx.font = `600 25px ${MONO}`;
    const w = ctx.measureText(label).width;
    // 点位注记: 实心方块 + 引线 + 文字(制图学里的标准写法)
    ctx.fillStyle = C_TEXT_HI;
    ctx.fillRect(x - 3.5, y - 3.5, 7, 7);
    ctx.strokeStyle = 'rgba(255,176,0,0.35)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x + 5, y - 5);
    ctx.lineTo(x + 30, y - 34);
    ctx.lineTo(x + 30 + w, y - 34);
    ctx.stroke();
    ctx.fillStyle = C_TEXT;
    mirroredText(ctx, label, x + 34, y - 34);
    placed += 1;
  }

  // === 13. 图廓 / 指北针 / 比例尺 / 标题块 ===
  ctx.strokeStyle = C_FRAME;
  ctx.lineWidth = 3;
  ctx.strokeRect(SAFE - 34, SAFE - 34, TEX - (SAFE - 34) * 2, TEX - (SAFE - 34) * 2);
  // 四角角标(终端语汇: 不用圆角, 用角)
  ctx.lineWidth = 5;
  const corner = 48;
  const cIn = SAFE - 34;
  for (const cx0 of [cIn, TEX - cIn]) {
    for (const cy0 of [cIn, TEX - cIn]) {
      const sx = cx0 < TEX / 2 ? 1 : -1;
      const sy = cy0 < TEX / 2 ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(cx0 + sx * corner, cy0);
      ctx.lineTo(cx0, cy0);
      ctx.lineTo(cx0, cy0 + sy * corner);
      ctx.stroke();
    }
  }
  // 指北针(右上)
  {
    const nx = TEX - SAFE - 90;
    const ny = SAFE + 110;
    ctx.strokeStyle = C_TEXT_HI;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(nx, ny + 46); ctx.lineTo(nx, ny - 46);
    ctx.moveTo(nx, ny - 46); ctx.lineTo(nx - 15, ny - 14);
    ctx.moveTo(nx, ny - 46); ctx.lineTo(nx + 15, ny - 14);
    ctx.moveTo(nx - 24, ny + 8); ctx.lineTo(nx + 24, ny + 8);
    ctx.stroke();
    ctx.font = `700 30px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = C_TEXT_HI;
    mirroredText(ctx, 'N', nx, ny - 68);
    ctx.textAlign = 'left';
  }
  // 比例尺(左下)
  {
    const kmPerCell = opts.world.size / 8 / 1000;
    const bx = SAFE + 4;
    const by = TEX - SAFE - 40;
    const bw = 420;
    ctx.font = `600 26px ${MONO}`;
    ctx.fillStyle = C_TEXT_HI;
    mirroredText(ctx, `SCALE · 1 GRID = ${kmPerCell.toFixed(1)} KM`, bx, by - 26);
    ctx.lineWidth = 3;
    for (let i = 0; i < 4; i += 1) {
      const x = bx + (i * bw) / 4;
      if (i % 2 === 0) {
        ctx.fillStyle = C_TEXT_HI;
        ctx.fillRect(x, by, bw / 4, 14);
      }
      ctx.strokeStyle = C_TEXT_HI;
      ctx.strokeRect(x, by, bw / 4, 14);
    }
    ctx.fillStyle = C_TEXT;
    ctx.font = `600 22px ${MONO}`;
    mirroredText(ctx, '0', bx - 6, by + 42);
    mirroredText(ctx, `${(kmPerCell * 4).toFixed(0)} KM`, bx + bw - 34, by + 42);
  }
  // 标题块(左上)
  {
    ctx.font = `700 46px ${MONO}`;
    ctx.fillStyle = C_TEXT_HI;
    mirroredText(ctx, opts.codename, SAFE + 4, SAFE + 46);
    ctx.font = `600 26px ${MONO}`;
    ctx.fillStyle = C_TEXT;
    mirroredText(ctx, `OPORD ${opts.missionId.toUpperCase()} · GRID 8x8 · MAG`, SAFE + 4, SAFE + 86);
    ctx.fillStyle = C_RED;
    mirroredText(ctx, 'CLASS ■ TOP SECRET', SAFE + 4, SAFE + 120);
  }
  // 右下: 图名
  {
    ctx.font = `600 24px ${MONO}`;
    ctx.fillStyle = C_TEXT;
    ctx.textAlign = 'right';
    mirroredText(ctx, opts.en ? 'REGION MAP · SCALE 1:250000' : '区域地图 · 比例 1:250000', TEX - SAFE - 4, TEX - SAFE - 6);
    ctx.textAlign = 'left';
  }

  // === 14. 边缘渐隐 ===
  // 这张图是悬在空中的一块平面, 硬方形边缘在天空里非常出戏。用 destination-**in** +
  // 模糊把圆角矩形之外擦掉 —— 于是边界完全透明(不会出现硬边), 四角也有取景器感的
  // 圆角。所有图廓元素都在 SAFE 之内, 不会被这一步吃掉。
  //
  // [!] 这里必须是 destination-in, 不能是 destination-out:
  //     destination-out 保留的是"源透明处"的目标像素 ⇒ 圆角矩形**内部**被整片擦掉、
  //     外面反而留着。实测踩过这个坑: 整张贴图 82% 变成全透明, 地图拍里看到的"网格"
  //     其实是**透过透明平面露出来的 3D 战术网格**, 而我一直在调地形颜色 —— 症状在
  //     贴图上, 病因在这一行。destination-in 才是"只保留源不透明处"的正确语义。
  ctx.globalCompositeOperation = 'destination-in';
  ctx.filter = 'blur(30px)';
  roundRectPath(ctx, 30, 30, TEX - 60, TEX - 60, 250);
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'source-over';

  return canvas;
}
