// === 程序化地形基础色图 (per user request: 程序化关卡"直接色图") ===
//
// 背景:程序化关卡(mountain/desert/archipelago,以及无外部色图的 custom)
// 之前的基础色来自「4 张 256² 层 albedo × 顶点 splat 权重 × 可选自动遮罩」——
// 大面积同海拔/同坡度区域仍是一块程序色,而且一旦开启 Mask Splatting,地表
// 颜色就完全由那张自动生成的遮罩决定。用户要求:程序化关卡**彻底放弃用
// 自动遮罩表示基础色**,改为**程序化生成一张基础色贴图直接贴上去**。
//
// 本模块即那张贴图:任务开始时离线烘一张 2048²(可参数化)的卫星感地面色图,
// 整图 1:1 覆盖 ±size/2 世界域,交给材质走**既有** externalVertex 直出模式
// (mixNear=0 / mixFar=0 → uVtxMode=1 且 uMixFar<=0 → albedo 恒 = 该图 ×
// uVtxGain)。与 custom/Gaea 导入地图**完全同一条管线**,shader 不动、零新增
// 逐帧开销(仍是那一次 texture2D)。遮罩/顶点 splat 从此只影响层法线 octave
// 与层粗糙度权重,不再决定颜色。
//
// 颜色从哪来(与高度图**同源**,不是另画一张无关的图):
//   1. 生物群系分带:调用 environment.ts 的 `splatAt` 回调(海拔 + 坡度 +
//      带界扰动 + 陡坡转岩 —— 与游戏内顶点权重逐位同源),在粗格上采样后
//      双线性放大;基色 = 4 层色卡(沙/草/岩/雪)按权重混合 → 语义与游戏一致。
//   2. 排水/洼地暗化:粗高度格 − 盒模糊(≈size/80)得局部起伏,负值(洼地/
//      沟谷)混入该 mode 的湿润色并整体压暗(偏冷);再叠一层 ≈size/20 的
//      宽域起伏(盆地/宽谷)做低频暗化。正向起伏(山脊)提亮并偏暖。
//   3. 多尺度斑驳:复用 terrain-layer-textures 的**可平铺基础场**(低频大
//      斑块 / 中频起伏 / 细粒 / Worley 碎石或 terrac 风纹 / warp 方向场),
//      按**世界尺度**(≈37km / 31km / 6km / mode 自选 / 25km 周期)采样 →
//      明暗摆动**带色相分离**(暖亮冷暗),逐 mode 权重不同。
//   4. 排水纹:中频场做 ridged 变换 × 洼地门控 → 树枝状暗纹(真实水系/冲沟
//      的观感),只在低洼处出现。
//   5. 第 5 张场按 mode 换:山岳/平原用 Worley(砾石/裸土斑/裂隙),荒漠换成
//      terrace 风纹场(沙丘脊线 —— 亮脊 + 背风暗槽)—— 同一槽位,零额外开销。
//   6. 逐 mode 性格表 + 种子抖动(seededRand,绝不用 Math.random):
//      同一 mission → 同一张图。
//
// 成本(2048²):粗格 ≈ (res/8)² × (heightAt + splatAt) + (res/4)² × heightAt,
// 逐像素只做查表/双线性/乘加,无 sin、无逐帧开销。实测耗时由 onBuilt 上报,
// 并在首次生成时 console.info 一行。
//
// 朝向约定(重要):画布**行 0 = 世界 -Z**(与编辑器遮罩画布 / 外部高度场
// 网格同一约定:`row = (z + size/2) / size * res`),纹理 `flipY = false` 上传
// —— 这样 shader 里 `v = (z + size/2)/size` 采到的行与写入的世界坐标**逐像素
// 对应**,基础色与高度图不会 Z 镜像。

import * as THREE from 'three';
import { TILEABLE_FIELD, sampleTileableField, seededRand, tileableFields } from './terrain-layer-textures';

export type BaseRgb = [number, number, number];

/** 4 层色卡(sRGB 0..1;与材质 colors 同源,缺省 = 游戏色卡)。 */
export interface TerrainBaseColorColors {
  sand: BaseRgb;
  grass: BaseRgb;
  rock: BaseRgb;
  snow: BaseRgb;
}

export interface TerrainBaseColorOpts {
  /** 材质 mode(mountain / plains / canyon / archipelago…;兜底 mountain)。 */
  mode: string;
  /** 生物群系性格键(缺省 = mode;引擎传 terrainStyle 更准:desert ≠ plains)。 */
  styleKey?: string | null;
  /** 世界范围(米):贴图 1:1 覆盖 ±size/2。 */
  size: number;
  /** 分辨率(默认 2048)。 */
  resolution?: number;
  /** 任务种子(进 per-mode 抖动;同 mission 恒等)。 */
  seed?: number;
  /** 世界高度函数(与地形几何同一个;分带/起伏全从这里来)。 */
  heightAt: (x: number, z: number) => number;
  /** 分带权重(与材质 splat 同源的函数:x=沙 y=草 z=岩 w=雪)。 */
  splatAt: (x: number, z: number) => [number, number, number, number];
  /** 4 层色卡(sRGB 0..1)。 */
  colors: TerrainBaseColorColors;
  /** 分带格分辨率(缺省 res/8,钳 48..256)。 */
  bandGrid?: number;
  /** 起伏(高度)格分辨率(缺省 res/4,钳 48..512)。 */
  reliefGrid?: number;
  /** 水位附近湿暗:与材质 uWetLevel/uWetTint 同语义(缺省 5m / 0.72)。 */
  wetLevel?: number;
  wetTint?: number;
  /**
   * 缓存签名附加项(高度源指纹)。缓存按「同参数 = 同一张图」复用画布,
   * 调用方传入高度函数指纹(如几个采样点)可避免换了高度源却命中旧缓存。
   */
  cacheKey?: string;
  /** 生成完毕回调(诊断:耗时/格尺寸)。 */
  onBuilt?: (info: TerrainBaseColorInfo) => void;
}

export interface TerrainBaseColorInfo {
  resolution: number;
  bandGrid: number;
  reliefGrid: number;
  totalMs: number;
  gridMs: number;
  shadeMs: number;
}

export interface TerrainBaseColorStats {
  min: [number, number, number];
  max: [number, number, number];
  mean: [number, number, number];
  std: [number, number, number];
}

// ---------------------------------------------------------------------------
// 生物群系性格表
// ---------------------------------------------------------------------------
interface BiomeChar {
  /** 斑驳的通道分离:亮 → 暖(+r+g,-b),暗 → 冷(反向)。 */
  hue: BaseRgb;
  /** 洼地/排水湿润色(sRGB;与基色混合)。 */
  moist: BaseRgb;
  /** 湿润色混入量。 */
  valleyMix: number;
  /** 洼地整体暗化量。 */
  valleyDark: number;
  /** 山脊提亮量。 */
  ridgeLight: number;
  /** 斑驳幅度倍数。 */
  mottle: number;
  /** 碎石/裸土斑强度(第 5 张场)。 */
  stone: number;
  /** 细粒权重(细粒场在斑驳里的权重)。 */
  grain: number;
  /** 全局饱和度(1 = 不变)。 */
  sat: number;
  /** 全局亮度(1 = 不变;标定用,与旧分层 albedo 均值同档)。 */
  gain: number;
  /** 起伏尺度倍数(1 = 自动尺度;荒漠地形平缓 → 调小阈值)。 */
  relief: number;
  /** 第 5 张场用哪个(山岳/平原 = Worley 砾石;荒漠 = 风纹沙丘带)。 */
  texKind: 'stone' | 'ripple';
  /** 第 5 张场的世界周期(米)。 */
  texPeriod: number;
}

const CHAR_MOUNTAIN: BiomeChar = {
  hue: [0.085, 0.065, -0.135], moist: [0.20, 0.28, 0.17],
  valleyMix: 0.34, valleyDark: 0.15, ridgeLight: 0.085,
  mottle: 1.0, stone: 0.55, grain: 0.50, sat: 1.02, gain: 1.0, relief: 1.0,
  texKind: 'stone', texPeriod: 9216,
};
const CHAR_CANYON: BiomeChar = {
  hue: [0.105, 0.060, -0.145], moist: [0.30, 0.26, 0.17],
  valleyMix: 0.26, valleyDark: 0.17, ridgeLight: 0.100,
  mottle: 1.05, stone: 0.75, grain: 0.60, sat: 1.05, gain: 1.0, relief: 1.0,
  texKind: 'stone', texPeriod: 9216,
};
const CHAR_DESERT: BiomeChar = {
  hue: [0.105, 0.075, -0.160], moist: [0.47, 0.40, 0.27],
  valleyMix: 0.30, valleyDark: 0.10, ridgeLight: 0.075,
  mottle: 1.0, stone: 0.50, grain: 0.85, sat: 1.03, gain: 1.0, relief: 0.9,
  texKind: 'ripple', texPeriod: 8192,
};
const CHAR_PLAINS: BiomeChar = {
  hue: [0.050, 0.125, -0.125], moist: [0.18, 0.29, 0.15],
  valleyMix: 0.42, valleyDark: 0.13, ridgeLight: 0.070,
  mottle: 1.0, stone: 0.40, grain: 0.50, sat: 1.04, gain: 1.0, relief: 1.0,
  texKind: 'stone', texPeriod: 12288,
};
const CHAR_ARCHIPELAGO: BiomeChar = {
  hue: [0.040, 0.150, -0.110], moist: [0.13, 0.27, 0.14],
  valleyMix: 0.46, valleyDark: 0.17, ridgeLight: 0.090,
  mottle: 1.10, stone: 0.50, grain: 0.50, sat: 1.06, gain: 1.0, relief: 1.0,
  texKind: 'stone', texPeriod: 9216,
};
const CHAR_CITY: BiomeChar = {
  hue: [0.055, 0.095, -0.105], moist: [0.20, 0.27, 0.16],
  valleyMix: 0.30, valleyDark: 0.12, ridgeLight: 0.060,
  mottle: 0.85, stone: 0.55, grain: 0.40, sat: 1.00, gain: 1.0, relief: 1.0,
  texKind: 'stone', texPeriod: 6144,
};

const BIOME_CHAR: Record<string, BiomeChar> = {
  mountain: CHAR_MOUNTAIN,
  canyon: CHAR_CANYON,
  desert: CHAR_DESERT,
  plains: CHAR_PLAINS,
  archipelago: CHAR_ARCHIPELAGO,
  island: CHAR_ARCHIPELAGO,
  ocean: CHAR_ARCHIPELAGO,
  city: CHAR_CITY,
};

function biomeChar(styleKey: string): BiomeChar {
  return BIOME_CHAR[styleKey] ?? BIOME_CHAR.mountain;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** 平滑阶跃(与 shader smoothstep 同族;洼地/山脊软化用)。 */
const smooth01 = (v: number): number => v * v * (3 - 2 * v);
const clampInt = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : Math.round(v);

/**
 * 可分离盒模糊(移动平均,O(n);边缘钳制)。用于「局部起伏 = 高度 − 邻域均值」,
 * 半径以格为单位。返回新数组,不修改输入。
 */
function boxBlur(src: Float32Array, n: number, radius: number): Float32Array {
  const r = Math.max(1, radius | 0);
  const tmp = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  const inv = 1 / (2 * r + 1);
  // 横向
  for (let y = 0; y < n; y++) {
    const row = y * n;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + Math.min(n - 1, Math.max(0, k))];
    for (let x = 0; x < n; x++) {
      tmp[row + x] = sum * inv;
      sum += src[row + Math.min(n - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  // 纵向
  for (let x = 0; x < n; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[Math.min(n - 1, Math.max(0, k)) * n + x];
    for (let y = 0; y < n; y++) {
      out[y * n + x] = sum * inv;
      sum += tmp[Math.min(n - 1, y + r + 1) * n + x] - tmp[Math.max(0, y - r) * n + x];
    }
  }
  return out;
}

/** 去均值标准差(起伏阈值自标定用)。 */
function stdOf(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  const m = s / a.length;
  let v = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - m;
    v += d * d;
  }
  return Math.sqrt(v / a.length);
}

/** 0..1 软阈值(低于 lo 为 0,到 1 为 1)。 */
function softGate(v: number, lo: number): number {
  const t = clamp01((v - lo) / Math.max(1e-4, 1 - lo));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// 生成(带 1 条上次结果的缓存:同一 mission 重复建图/切图不重算)
// ---------------------------------------------------------------------------
let _cacheKey = '';
let _cacheCanvas: HTMLCanvasElement | null = null;
/** 上次生成耗时(诊断;不在渲染路径上)。 */
let _lastInfo: TerrainBaseColorInfo | null = null;

function signature(o: TerrainBaseColorOpts, res: number, G: number, R: number): string {
  const c = o.colors;
  return [
    o.styleKey ?? o.mode, o.mode, res, G, R, o.size, o.seed ?? 0,
    c.sand.join(','), c.grass.join(','), c.rock.join(','), c.snow.join(','),
    o.cacheKey ?? '',
  ].join('|');
}

/**
 * 生成程序化基础色画布(默认 2048²)。纯计算:无网络、无外部资源、无逐帧
 * 开销;同一 (mode/size/seed/色卡/分辨率) → 同一张图(确定性)。
 */
export function makeTerrainBaseColorCanvas(o: TerrainBaseColorOpts): HTMLCanvasElement {
  const t0 = Date.now();
  const res = clampInt(o.resolution ?? 2048, 64, 4096);
  const G = clampInt(o.bandGrid ?? res / 8, 48, 256);
  const R = clampInt(o.reliefGrid ?? res / 4, 48, 512);
  const key = signature(o, res, G, R);
  if (_cacheCanvas && _cacheKey === key) return _cacheCanvas;

  const size = o.size;
  const half = size / 2;
  const cell = size / res;
  const styleKey = (o.styleKey ?? o.mode ?? 'mountain').toLowerCase();
  const ch = biomeChar(styleKey);
  const rng = seededRand(`basecolor:${styleKey}:${o.seed ?? 0}`);

  // --- 1) 粗分带格(复用游戏内 splatAt:海拔 + 坡度 + 带界扰动 + 陡坡转岩) ---
  const band = new Float32Array(G * G * 4);
  const cellB = size / G;
  for (let j = 0; j < G; j++) {
    const wz = -half + (j + 0.5) * cellB;
    for (let i = 0; i < G; i++) {
      const w = o.splatAt(-half + (i + 0.5) * cellB, wz);
      const s = w[0] + w[1] + w[2] + w[3];
      const inv = s > 1e-4 ? 1 / s : 0;
      const p = (j * G + i) * 4;
      band[p] = w[0] * inv;
      band[p + 1] = w[1] * inv;
      band[p + 2] = w[2] * inv;
      band[p + 3] = w[3] * inv;
    }
  }

  // --- 2) 高度格 + 局部起伏(洼地/山脊) ---
  const cellR = size / R;
  const hs = new Float32Array(R * R);
  for (let j = 0; j < R; j++) {
    const wz = -half + (j + 0.5) * cellR;
    for (let i = 0; i < R; i++) hs[j * R + i] = o.heightAt(-half + (i + 0.5) * cellR, wz);
  }
  // 两级邻域均值:≈size/80(沟谷/山脊)+ ≈size/20(盆地/宽谷)
  const rTight = Math.max(1, Math.round(R / 160));
  const rWide = Math.max(rTight + 1, Math.round(R / 40));
  const blurT = boxBlur(hs, R, rTight);
  const blurW = boxBlur(hs, R, rWide);
  const relT = new Float32Array(R * R);
  const relW = new Float32Array(R * R);
  for (let i = 0; i < hs.length; i++) {
    relT[i] = hs[i] - blurT[i];
    relW[i] = hs[i] - blurW[i];
  }
  // 阈值自标定(与地形绝对幅度无关):1.3σ 处饱和,省掉逐 mode 手调米数。
  const reliefK = 1 / Math.max(0.25, ch.relief);
  const invScaleT = 1 / Math.max(2, stdOf(relT) * 1.3 * reliefK);
  const invScaleW = 1 / Math.max(2, stdOf(relW) * 1.3 * reliefK);
  const gridMs = Date.now() - t0;

  // --- 3) 逐像素着色 ---
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = res;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(res, res);
  const d = img.data;

  // 可平铺基础场(terrain-layer-textures 的 8 张场按世界周期采样):
  // 低频大斑块 / 中频起伏 / 细粒 / 第 5 张(mode 自选)/ warp 方向场。
  const TF = tileableFields();
  const f0 = TF[TILEABLE_FIELD.BIG], f1 = TF[TILEABLE_FIELD.MED], f2 = TF[TILEABLE_FIELD.FINE];
  const f3 = ch.texKind === 'ripple' ? TF[TILEABLE_FIELD.RIPPLE] : TF[TILEABLE_FIELD.STONE];
  const f4 = TF[TILEABLE_FIELD.WARP];
  const ip0 = 1 / 36864, ip1 = 1 / 30720, ip2 = 1 / 6144;
  const ip3 = 1 / ch.texPeriod, ip4 = 1 / 24576;
  // === 宏观色斑 / 第二尺度沟壑 (per user request: 地形着色升级) ==============
  // 复用已有场、只换周期 ⇒ 零额外烘焙成本(数据不变), 只多两次纹理采样:
  //   · 宏观: 用 BIG 场放到 ≈131km 周期(整张 30km 地图上只有几个大斑块) ⇒ 大区域之间
  //     才有暖/冷、明/暗的差别, 解决"整片同色";
  //   · 第二尺度: 用 FINE 场放到 ≈3km 周期并取**倒脊形** ⇒ 山体上比现有排水纹(用 MED、
  //     30km 周期)更粗一级的枝状冲沟/沟壑。
  const ipM = 1 / 131072, ipM2 = 1 / 3072;
  // 每 mode/种子的场相位抖动(uv 域 = 纹素/256;环面上平移不产生接缝)。
  const j = (): number => rng() / 256;
  const u0 = j(), u1 = j(), u2 = j(), u3 = j(), u4 = j();
  const v0 = j(), v1 = j(), v2 = j(), v3 = j(), v4 = j();
  const uM = j(), vM = j(), uM2 = j(), vM2 = j();

  // 列预计算:粗格 x 索引/权重(逐行复用)
  const bandScale = G / res;
  const relScale = R / res;
  const bx0 = new Int32Array(res), bx1 = new Int32Array(res), btx = new Float32Array(res);
  const rx0 = new Int32Array(res), rx1 = new Int32Array(res), rtx = new Float32Array(res);
  for (let px = 0; px < res; px++) {
    let g = (px + 0.5) * bandScale - 0.5;
    if (g < 0) g = 0;
    let i0 = g | 0;
    if (i0 > G - 2) i0 = G - 2;
    bx0[px] = i0; bx1[px] = i0 + 1; btx[px] = g - i0;
    let r = (px + 0.5) * relScale - 0.5;
    if (r < 0) r = 0;
    let k0 = r | 0;
    if (k0 > R - 2) k0 = R - 2;
    rx0[px] = k0; rx1[px] = k0 + 1; rtx[px] = r - k0;
  }

  const cs = o.colors.sand, cg = o.colors.grass, cr = o.colors.rock, cn = o.colors.snow;
  const [mr, mg, mb] = ch.moist;
  const [hr, hg, hb] = ch.hue;
  const valleyMix = ch.valleyMix, valleyDark = ch.valleyDark, ridgeLight = ch.ridgeLight;
  const mottle = ch.mottle, stoneAmt = ch.stone, sat = ch.sat, gain = ch.gain;
  const isRipple = ch.texKind === 'ripple';
  // 水位附近湿暗(与旧 shader 的 uWetLevel/uWetTint 同语义):直出色图模式下
  // shader 的湿暗分支不再执行 → 在这里烘进贴图,保住"近水面湿沙"的观感。
  const wetLevel = Math.max(0, o.wetLevel ?? 5);
  const wetTint = clamp01(o.wetTint ?? 0.72);
  const wetDark = 1 - wetTint;
  const invWetLevel = wetLevel > 0 ? 1 / wetLevel : 0;

  for (let py = 0; py < res; py++) {
    const wz = -half + (py + 0.5) * cell;
    let gz = (py + 0.5) * bandScale - 0.5;
    if (gz < 0) gz = 0;
    let jb0 = gz | 0;
    if (jb0 > G - 2) jb0 = G - 2;
    const jb1 = jb0 + 1, tbz = gz - jb0;
    const browA = jb0 * G * 4, browB = jb1 * G * 4;
    let rz = (py + 0.5) * relScale - 0.5;
    if (rz < 0) rz = 0;
    let jr0 = rz | 0;
    if (jr0 > R - 2) jr0 = R - 2;
    const jr1 = jr0 + 1, trz = rz - jr0;
    const rrowA = jr0 * R, rrowB = jr1 * R;
    const z0 = wz * ip0 + v0, z1 = wz * ip1 + v1, z2 = wz * ip2 + v2;
    const z3 = wz * ip3 + v3, z4 = wz * ip4 + v4;
    const zM = wz * ipM + vM, zM2 = wz * ipM2 + vM2;
    let o = py * res * 4;
    for (let px = 0; px < res; px++, o += 4) {
      const wx = -half + (px + 0.5) * cell;

      // --- 分带权重(粗格 → 双线性放大)---
      const xa = bx0[px], xb = bx1[px], txb = btx[px];
      const pa = browA + xa * 4, pb = browB + xa * 4, pc = browA + xb * 4, pd = browB + xb * 4;
      const w0 = (band[pa] + (band[pc] - band[pa]) * txb) * (1 - tbz) + (band[pb] + (band[pd] - band[pb]) * txb) * tbz;
      const w1 = (band[pa + 1] + (band[pc + 1] - band[pa + 1]) * txb) * (1 - tbz) + (band[pb + 1] + (band[pd + 1] - band[pb + 1]) * txb) * tbz;
      const w2 = (band[pa + 2] + (band[pc + 2] - band[pa + 2]) * txb) * (1 - tbz) + (band[pb + 2] + (band[pd + 2] - band[pb + 2]) * txb) * tbz;
      const w3 = (band[pa + 3] + (band[pc + 3] - band[pa + 3]) * txb) * (1 - tbz) + (band[pb + 3] + (band[pd + 3] - band[pb + 3]) * txb) * tbz;

      // --- 局部起伏(同一粗格双线性)---
      const ra = rrowA + rx0[px], rb = rrowB + rx0[px], rc = rrowA + rx1[px], rd = rrowB + rx1[px];
      const txr = rtx[px];
      const lt = (relT[ra] + (relT[rc] - relT[ra]) * txr) * (1 - trz) + (relT[rb] + (relT[rd] - relT[rb]) * txr) * trz;
      const lw = (relW[ra] + (relW[rc] - relW[ra]) * txr) * (1 - trz) + (relW[rb] + (relW[rd] - relW[rb]) * txr) * trz;
      const ha = hs[ra] + (hs[rc] - hs[ra]) * txr;
      const hbx = hs[rb] + (hs[rd] - hs[rb]) * txr;
      const hpx = ha + (hbx - ha) * trz;
      const valleyT = smooth01(clamp01(-lt * invScaleT));
      const basinT = smooth01(clamp01(-lw * invScaleW));
      const ridgeT = smooth01(clamp01(lt * invScaleT));

      // --- 多尺度场(可平铺基础场,环面双线性)---
      const sBIG = sampleTileableField(f0, wx * ip0 + u0, z0);
      const sMED = sampleTileableField(f1, wx * ip1 + u1, z1);
      const sFINE = sampleTileableField(f2, wx * ip2 + u2, z2);
      const sTEX = sampleTileableField(f3, wx * ip3 + u3, z3);
      const sWARP = sampleTileableField(f4, wx * ip4 + u4, z4);
      const sMACRO = sampleTileableField(f0, wx * ipM + uM, zM);
      const sMID2 = sampleTileableField(f2, wx * ipM2 + uM2, zM2);

      // --- 基色(4 层色卡按带权重混合;与游戏分带语义一致)---
      let r = w0 * cs[0] + w1 * cg[0] + w2 * cr[0] + w3 * cn[0];
      let g = w0 * cs[1] + w1 * cg[1] + w2 * cr[1] + w3 * cn[1];
      let b = w0 * cs[2] + w1 * cg[2] + w2 * cr[2] + w3 * cn[2];

      // --- 排水/洼地:湿润色混入 + 压暗(偏冷)---
      const wet = valleyMix * (0.68 * valleyT + 0.32 * basinT);
      if (wet > 0.002) {
        r += (mr - r) * wet;
        g += (mg - g) * wet;
        b += (mb - b) * wet;
      }
      const dark = 1 - valleyDark * (0.7 * valleyT + 0.3 * basinT);
      r *= dark; g *= dark; b *= dark;

      // --- 山脊提亮(暖)---
      if (ridgeT > 0.002) {
        const li = 1 + ridgeLight * ridgeT;
        r = r * li + ridgeT * 0.030;
        g = g * li + ridgeT * 0.024;
        b = b * li + ridgeT * 0.014;
      }

      // --- 多尺度斑驳:亮度摆动 + 暖冷色相分离(变亮变暖/变暗变冷)---
      const snowDamp = 1 - 0.55 * w3; // 雪面少斑驳(保持干净高亮)
      const t = ((sBIG - 0.5) * 1.30 + (sMED - 0.5) * 0.62 + (sFINE - 0.5) * ch.grain)
        * mottle * snowDamp;
      // 低频湿润度/色相漂移:WARP 是**签名**方向场(cos,均值 0)→ 直接乘,
      // 不能再减 0.5(那会引入 +b/−r 的常数偏移,把整张图推冷)。
      const drift = sWARP * 0.22 + (sBIG - 0.5) * 0.45;
      const hueAmt = t + drift;
      r += hueAmt * hr;
      g += hueAmt * hg;
      b += hueAmt * hb;
      const bright = 1 + t * 0.20;
      r *= bright; g *= bright; b *= bright;

      // --- 第 5 张场:砾石/裸土斑(山岳/平原)或风纹沙丘带(荒漠)---
      if (isRipple) {
        const band2 = smooth01(clamp01((sTEX - 0.45) * 2.2)); // 0..1 风纹脊
        const sc = (band2 - 0.5) * 0.16 * stoneAmt;
        r += sc * 0.9; g += sc * 0.7; b -= sc * 0.5;
      } else {
        // Worley:1 = 格边(裂缝/碎石缝);岩带权重越高越明显。只做轻度去饱和
        // (0.32 ≈ 1/3 向亮度灰靠)+ 轻微压暗 —— 保留岩带的暖色调性格。
        const st = softGate(sTEX, 0.42) * stoneAmt * (0.40 + 0.60 * w2);
        if (st > 0.002) {
          const luma = r * 0.299 + g * 0.587 + b * 0.114;
          r += (luma - r) * st * 0.32 - st * 0.045;
          g += (luma - g) * st * 0.32 - st * 0.040;
          b += (luma - b) * st * 0.32 - st * 0.024;
        }
      }

      // --- 排水纹(树枝状暗纹;只在低洼/湿润处出现)---
      const chanMid = 1 - Math.min(1, Math.abs((sMED + sWARP * 0.18) * 2 - 1));
      const chanT = softGate(chanMid * chanMid * chanMid, 0.55) * (0.30 + 0.70 * valleyT);
      if (chanT > 0.002) {
        r *= 1 - 0.11 * chanT;
        g *= 1 - 0.07 * chanT;
        b *= 1 - 0.03 * chanT;
      }

      // === ① 宏观色斑: 区域级暖/冷 + 明/暗偏移 (per user request) ==============
      // 用 (sMACRO - 0.5)*2 ≈ -1..1 做**分离式**偏移: 亮区偏暖、暗区偏冷(不是单纯加减亮度),
      // 幅度 7.5% 且雪面减半(保持雪干净)。这样从高空看, 一大片区域不会是一模一样的颜色。
      {
        const macroV = (sMACRO - 0.5) * 2;
        const macroAmt = 0.075 * (1 - 0.5 * w3);
        r *= 1 + macroV * macroAmt;
        g *= 1 + macroV * macroAmt * 0.85;
        b *= 1 + macroV * macroAmt * 0.55;
      }

      // === ② 第二尺度沟壑: 比排水纹更粗一级的枝状冲沟 (per user request) =========
      // 倒脊形 (1-|2n-1|) 在 ≈3km 周期上取谷线 ⇒ 山体出现中等尺度的沟壑;
      // 权重仍是"低洼处更明显"(与排水纹同一套 valleyT), 高处岩面不会被涂黑。
      {
        const ridged2 = 1 - Math.abs(sMID2 * 2 - 1);
        const gully = softGate(ridged2, 0.62) * (0.30 + 0.70 * valleyT);
        if (gully > 0.002) {
          r *= 1 - 0.10 * gully;
          g *= 1 - 0.07 * gully;
          b *= 1 - 0.04 * gully;
        }
      }

      // --- 高海拔微去饱和(与雪线过渡自然)---
      if (w3 > 0.02) {
        const luma = r * 0.299 + g * 0.587 + b * 0.114;
        const k = w3 * 0.16;
        r += (luma - r) * k; g += (luma - g) * k; b += (luma - b) * k;
      }

      // --- 水位附近湿暗(旧 shader 的 uWetTint/uWetLevel,烘进贴图)---
      if (wetLevel > 0 && hpx < wetLevel) {
        const wk = 1 - wetDark * clamp01(1 - hpx * invWetLevel);
        r *= wk; g *= wk; b *= wk;
      }

      // --- 饱和度 / 亮度标定 / 写字节 ---
      if (sat !== 1) {
        const luma = r * 0.299 + g * 0.587 + b * 0.114;
        r = luma + (r - luma) * sat;
        g = luma + (g - luma) * sat;
        b = luma + (b - luma) * sat;
      }
      r *= gain; g *= gain; b *= gain;
      d[o] = r <= 0 ? 0 : r >= 1 ? 255 : (r * 255 + 0.5) | 0;
      d[o + 1] = g <= 0 ? 0 : g >= 1 ? 255 : (g * 255 + 0.5) | 0;
      d[o + 2] = b <= 0 ? 0 : b >= 1 ? 255 : (b * 255 + 0.5) | 0;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const shadeMs = Date.now() - t0 - gridMs;

  const info: TerrainBaseColorInfo = {
    resolution: res, bandGrid: G, reliefGrid: R,
    totalMs: Date.now() - t0, gridMs, shadeMs,
  };
  _cacheKey = key;
  _cacheCanvas = canvas;
  _lastInfo = info;
  o.onBuilt?.(info);
  return canvas;
}

/** 上次生成耗时(诊断;从未生成过时 null)。 */
export function lastTerrainBaseColorInfo(): TerrainBaseColorInfo | null {
  return _lastInfo;
}

/**
 * 包装成 three 贴图:SRGB(与 Gaea 色图/层 albedo 同规格;现代 three 用
 * sRGB 内部格式,采样即得线性 albedo)、ClampToEdge(整图 1:1 覆盖世界域,
 * 越界不该重复)、mipmap + 各向异性(远景不闪)。
 * `flipY = false`:画布行 0 = 世界 -Z,与 shader 的 v=(z+size/2)/size 逐行对应。
 */
export function makeTerrainBaseColorTexture(o: TerrainBaseColorOpts): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(makeTerrainBaseColorCanvas(o));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.flipY = false;
  tex.anisotropy = 8;
  tex.name = `terrain-basecolor/${o.styleKey ?? o.mode}`;
  return tex;
}

/** 诊断:逐通道 min/max/mean/std(0..255 域;不参与渲染路径)。 */
export function terrainBaseColorStats(canvas: HTMLCanvasElement): TerrainBaseColorStats {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('terrainBaseColorStats: no 2d context');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return terrainBaseColorStatsOf(img.data, canvas.width * canvas.height);
}

/** 诊断核心(可直接喂 ImageData.data;Node 量测脚本用)。 */
export function terrainBaseColorStatsOf(d: Uint8ClampedArray, n: number): TerrainBaseColorStats {
  const min: [number, number, number] = [255, 255, 255];
  const max: [number, number, number] = [0, 0, 0];
  const sum: [number, number, number] = [0, 0, 0];
  const sq: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    for (let c = 0; c < 3; c++) {
      const v = d[o + c];
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
      sum[c] += v;
      sq[c] += v * v;
    }
  }
  const mean: [number, number, number] = [0, 0, 0];
  const std: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const m = sum[c] / n;
    mean[c] = m;
    std[c] = Math.sqrt(Math.max(0, sq[c] / n - m * m));
  }
  return { min, max, mean, std };
}

/**
 * 世界坐标 → 基础色 RGB 采样器(0..1)。
 *
 * 用途:把"地面基础色"喂给下游消费者(植被遮罩/藤蔓着色等), 让它们与地面同色系。
 * 采样约定与 shader 完全一致(u = (x+size/2)/size, v = (z+size/2)/size), 画布由
 * `makeTerrainBaseColorCanvas` 以「行 0 = 世界 −Z + flipY=false」写入, 所以这里
 * 直接按 v 取行即可, 不会 Z 镜像。
 *
 * 返回的函数带 `size`, 便于调用方判断坐标是否越界。
 */
export function makeTerrainBaseColorSampler(
  canvas: HTMLCanvasElement,
  size: number,
): { sample: (x: number, z: number) => [number, number, number]; size: number } {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const data = ctx ? ctx.getImageData(0, 0, w, h).data : null;
  const inv = 1 / size;
  return {
    size,
    sample: (x: number, z: number): [number, number, number] => {
      if (!data) return [0.5, 0.5, 0.5];
      const u = Math.min(1, Math.max(0, (x + size / 2) * inv));
      const v = Math.min(1, Math.max(0, (z + size / 2) * inv));
      const px = Math.min(w - 1, Math.max(0, Math.round(u * (w - 1))));
      const py = Math.min(h - 1, Math.max(0, Math.round(v * (h - 1))));
      const o = (py * w + px) * 4;
      // sRGB 存储 → 线性 0..1(与材质 colors 同域;植被着色只需相对关系)
      const s = (i: number) => {
        const c = data[o + i] / 255;
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      };
      return [s(0), s(1), s(2)];
    },
  };
}
