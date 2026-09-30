// === 程序化地形层贴图 v2 (per user request: 基础色贴图分布太单调/太假) ===
//
// 背景:分层地形材质 (layered-terrain.ts) 的 4 张 256² 画布 albedo 是
// "底色 × 低频色斑 × 细粒噪" 三个乘性项 —— 每层实际上只有一个色相,
// 大面积同海拔/同坡度区域看起来是一块纯色。MWAM 的 KTX2 真实材质
// (terrain-mwam.ts) 提供了另一种做法:贴图自带多尺度色调/色相分布。
//
// 本模块把 MWAM 的思路(多尺度、逐层材质性格、色彩变化与 splat 带无关)
// 复刻成**纯程序化、零资源**的版本:
//   1. 一组 **可平铺** 基础噪声场(sizes 见 FIELDS):低频斑块 / 中频起伏 /
//      细粒 / terrace 化岩层 / torus Worley 碎石 / warp 域扭曲 —— 每个场
//      只算一次,4 层共用(逐层用不同权重组合 → 场相同但分布不同)。
//   2. 逐层 "recipe":每层 = 白底 + Σ(权重 × 场 × 三通道色彩)。
//      色彩是**暖冷分离的加色**,所以变亮变暗都带色相偏移(不是灰阶乘性),
//      这正是旧版"假"的根因。层的整体色相仍然由 base 颜色主导
//      (沙/草/岩/雪 依然一眼可辨),只在其上叠加可信的色调分布。
//   3. 岩层 strata/terrace(水平岩层带)、草层 blotch(草皮/枯草/裸土斑)、
//      沙层 ripple+dune(风纹 + 沙丘暗化)、雪层 scour+drift(风蚀 + 雪堆)。
//   4. 第 5 张极低频"宏观色调"图 (makeMacroTintCanvas):与 splat 分带
//      **完全无关**的宽域色彩变化,由材质在 blended albedo 之后以低权重
//      乘上(见 layered-terrain.ts)。这是"同一带内的大面积色块太单调"
//      的直接解药。
//
// 平铺保证(seam 是可见 bug):所有噪声都在**整数周期格点**上采样 ——
//   value 噪声:period P 个格点覆盖整张图,格点索引按 P 取模 → 天然环面;
//   Worley    :P×P 个抖动格点铺在环面上,邻居索引按 P 取模,距离用
//               "按轴取模后的最短差值" → 边界处格点与内部一致;
//   terrace   :对已平铺的场做逐像素函数(幂/量化)→ 不破坏平铺;
//   有向场(warpDx/Dy、ripple 方向、dune 方向):用 floor 双线性采样
//               (fx == P 时权重为 0,回落到格点 0)→ 相邻像素连续。
// 因此 x=0 与 x=255 的像素只差一个格距(和图片内部任意相邻像素一样),
// 没有"接缝"级跳变。scripts 里的临时校验脚本按此判据做过验证。
//
// 确定性:所有随机数来自 seededRand(字符串种子的 mulberry32),不用
// Math.random()。同一 mode/层 → 同一张图,跨任务/跨会话一致。

import * as THREE from 'three';

const TILE = 256;
/** 宏观色调图尺寸:够 2 个八度(周期 ~47 / ~5.9 世界单位)且显存只有 256KB。 */
const TINT_TILE = 256;

/** 与 layered-terrain.ts 同族的确定性 PRNG(FNV-1a 播种 + mulberry32)。
 *  导出供 terrain-basecolor 复用(程序化基础色图必须与层贴图同一套确定性)。 */
export function seededRand(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 可平铺噪声原语
// ---------------------------------------------------------------------------

/** 周期 P 的格点随机值表(P×P,行主序)。 */
function latticeRand(P: number, seed: string): Float32Array {
  const n = P * P;
  const out = new Float32Array(n);
  const r = seededRand(seed);
  for (let i = 0; i < n; i++) out[i] = r();
  return out;
}

const wrapIdx = (v: number, P: number): number => ((v % P) + P) % P;

/** 双线性采样一张**可平铺**值噪声(格点索引按 P 取模 → 环面连续)。 */
function sampleLattice(L: Float32Array, P: number, fx: number, fy: number): number {
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  let tx = fx - ix;
  let ty = fy - iy;
  tx = tx * tx * (3 - 2 * tx);
  ty = ty * ty * (3 - 2 * ty);
  const x0 = wrapIdx(ix, P);
  const y0 = wrapIdx(iy, P);
  const x1 = wrapIdx(ix + 1, P);
  const y1 = wrapIdx(iy + 1, P);
  const a = L[y0 * P + x0];
  const b = L[y0 * P + x1];
  const c = L[y1 * P + x0];
  const d = L[y1 * P + x1];
  // fx == P 时 tx == 0 → 取 x0(=0)格点,与左边界逐值一致。
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/** 由若干"格点周期"叠加而成的 fBm,归一化到 0..1。 */
function buildValueField(size: number, periods: number[], amps: number[], seed: string): Float32Array {
  const lattices = periods.map((P, i) => latticeRand(P, `${seed}#${i}`));
  const out = new Float32Array(size * size);
  let norm = 0;
  for (const a of amps) norm += a;
  const inv = 1 / Math.max(1e-6, norm);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (let o = 0; o < periods.length; o++) {
        const P = periods[o];
        v += amps[o] * sampleLattice(lattices[o], P, (x / size) * P, (y / size) * P);
      }
      out[row + x] = v * inv;
    }
  }
  return out;
}

/**
 * 环面 Worley(F1 距离):P×P 个抖动格点铺在环面上,邻居格点索引按 P 取模、
 * 距离按轴取最短绕行 → 边界像素与内部像素看到的是同一套格点。
 * 搜索半径为 3 格:单格内 1 个抖动点,最坏情况下(点落在格角)最近点仍在
 * 相邻格内,3×3 即完备 —— 这是"一个格点/格"Worley 的标准结论。
 * 距离以**格**为单位(0..~1.5),返回 0..1(0 = 格点中心,1 = 距离 ≥1 格)。
 */
function buildWorleyField(size: number, P: number, seed: string): Float32Array {
  const r = seededRand(seed);
  const jx = new Float32Array(P * P);
  const jy = new Float32Array(P * P);
  for (let i = 0; i < P * P; i++) {
    jx[i] = r();
    jy[i] = r();
  }
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const ry = y / size;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const rx = x / size;
      // 当前点所在的格(未取模的格坐标)
      const gx = Math.floor(rx * P);
      const gy = Math.floor(ry * P);
      let best = 1e9;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cx = gx + dx;
          const cy = gy + dy;
          const k = wrapIdx(cy, P) * P + wrapIdx(cx, P);
          // 该格抖动点相对当前点的位移,**单位 = 格**(跨边界按 P 绕行)
          let ox = cx + jx[k] - rx * P;
          let oy = cy + jy[k] - ry * P;
          ox -= P * Math.round(ox / P);
          oy -= P * Math.round(oy / P);
          const d2 = ox * ox + oy * oy; // 格²
          if (d2 < best) best = d2;
        }
      }
      const d = Math.sqrt(best); // 单位:格(0 .. ~1.4)
      out[row + x] = d >= 1 ? 1 : d;
    }
  }
  return out;
}

/**
 * 把 0..1 场重映射为 **水平层理带**(岩层 strata / 风纹 ripple 共用)。
 * `sharp` 越大层界越清晰,`warp` 用另一张平铺场做域扭曲(层界不规则)。
 * 逐像素函数 + 平铺输入场 → 输出仍平铺。
 */
function buildTerraceField(
  size: number,
  src: Float32Array,
  warp: Float32Array | null,
  bands: number,
  sharp: number,
  warpAmt: number,
): Float32Array {
  const out = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    let v = src[i];
    if (warp && warpAmt > 0) v += (warp[i] - 0.5) * warpAmt;
    if (v < 0) v = 0;
    else if (v > 1) v = 1;
    let w = 0.5 + 0.5 * Math.sin((v * bands - 0.25) * Math.PI * 2);
    w = Math.pow(w, sharp);
    out[i] = w;
  }
  return out;
}

/** 单位向量场(0..1 → cos/sin):用于风纹/雪蚀的**方向性**,同样平铺。 */
function buildWarpDirField(size: number, P: number, seed: string): { dx: Float32Array; dy: Float32Array } {
  const L = latticeRand(P, seed);
  const dx = new Float32Array(size * size);
  const dy = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = sampleLattice(L, P, (x / size) * P, (y / size) * P) * Math.PI * 2;
      const i = y * size + x;
      dx[i] = Math.cos(a);
      dy[i] = Math.sin(a);
    }
  }
  return { dx, dy };
}

// ---------------------------------------------------------------------------
// 基础场缓存(4 层 / 所有 mode 共用;每张图只算一次)
// ---------------------------------------------------------------------------
const F_SIZE = 256;
/** 低频斑块(大尺度单调区)。 */
const F_BIG = 0;
/** 中频起伏。 */
const F_MED = 1;
/** 细粒(最细到逐像素,但周期仍是 256 → 平铺)。 */
const F_FINE = 2;
/** 岩层层理(terrace,warp 域扭曲)。 */
const F_STRATA = 3;
/** 碎石/砾石斑(Worley)。 */
const F_STONE = 4;
/** 域扭曲方向场。 */
const F_WARP = 5;
/** 有向风纹(只沿一个方向,与 ripple 方向场正交)。 */
const F_RIPPLE = 6;
/** 宽脊(雪堆 drifts)。 */
const F_RIDGE = 7;
const F_COUNT = 8;

let _fields: Float32Array[] | null = null;

function fields(): Float32Array[] {
  if (_fields) return _fields;
  const out: Float32Array[] = new Array(F_COUNT);
  out[F_BIG] = buildValueField(F_SIZE, [3, 7], [1, 0.42], 'tl-big');
  out[F_MED] = buildValueField(F_SIZE, [11, 29], [1, 0.5], 'tl-med');
  out[F_FINE] = buildValueField(F_SIZE, [53, 127, 256], [1, 0.72, 0.5], 'tl-fine');
  const strataSrc = buildValueField(F_SIZE, [5, 17], [1, 0.34], 'tl-strata');
  const warpMed = buildValueField(F_SIZE, [13], [1], 'tl-warpmed');
  out[F_STRATA] = buildTerraceField(F_SIZE, strataSrc, warpMed, 7, 1.7, 0.34);
  out[F_STONE] = buildWorleyField(F_SIZE, 17, 'tl-stone');
  const dir = buildWarpDirField(F_SIZE, 5, 'tl-warp');
  out[F_WARP] = dir.dx;
  const rippleSrc = buildTerraceField(F_SIZE, buildValueField(F_SIZE, [41], [1], 'tl-ripple'), out[F_BIG], 13, 2.0, 0.35);
  out[F_RIPPLE] = rippleSrc;
  out[F_RIDGE] = buildValueField(F_SIZE, [9, 23], [1, 0.45], 'tl-ridge');
  _fields = out;
  return out;
}

// ---------------------------------------------------------------------------
// 逐层 recipe
// ---------------------------------------------------------------------------
// 每一项 = { f: 场索引, w: 权重(正 = 变亮/变暖, 负 = 变暗/变冷), r/g/b: 三通道
// 乘数增量 }。色彩刻意"暖亮冷暗":提亮带黄/橙,压暗带蓝/青 —— 真实地表
// (湿土、阴影缝隙、雪影)就是这样,纯灰阶明暗才是"假"的来源。
//
// 标定:各场去均值后 RMS 见 FIELD_RMS 注释(实测,scripts 临时脚本);
// 权重 × 场 RMS × 通道增量 ≈ 该 octave 对 albedo 的标准差贡献(0..1),
// 目标每层亮度 std ≈ 0.05(≈13/255,与旧版"大色块"同量级但有机),
// 其中色相 std 明显高于旧版(旧版几乎只有明暗,没有色相分布)。
interface Rx {
  f: number;
  w: number;
  r: number;
  g: number;
  b: number;
}

/** 沙:干燥感(暖亮)/ 沙丘脊暗化(冷暗)/ 风纹(暖冷交替)/ 细砂粒。 */
const SAND_RX: Rx[] = [
  { f: F_BIG, w: 1.31, r: 0.12, g: 0.09, b: -0.21 },       // 干燥亮斑:黄(压蓝)
  { f: F_MED, w: -1.05, r: 0.05, g: 0.02, b: -0.07 },      // 沙丘暗化:冷蓝
  { f: F_RIPPLE, w: 0.63, r: 0.115, g: 0.065, b: -0.18 },  // 风纹亮脊
  { f: F_RIPPLE, w: -0.54, r: -0.045, g: -0.03, b: 0.075 }, // 风纹背光槽(冷)
  { f: F_STONE, w: -2.1, r: -0.01, g: -0.04, b: -0.075 },  // 砾石/贝壳斑
  { f: F_FINE, w: 0.59, r: 0.045, g: 0.028, b: -0.073 },   // 细砂粒
];

/** 草:草皮密斑(绿深)/ 枯草(黄亮)/ 裸土(褐暗)/ 细叶噪。 */
const GRASS_RX: Rx[] = [
  { f: F_BIG, w: 1.38, r: -0.048, g: 0.092, b: -0.044 },   // 密植被:绿深
  { f: F_MED, w: 0.9, r: 0.168, g: 0.114, b: -0.282 },     // 枯草:黄
  { f: F_STONE, w: -2.1, r: 0.081, g: -0.021, b: -0.06 },  // 裸土斑:褐
  { f: F_FINE, w: 0.81, r: -0.017, g: 0.065, b: -0.048 },  // 叶片细噪
  { f: F_WARP, w: 0.26, r: 0.054, g: 0.06, b: -0.114 },    // 大尺度湿润度摆动
];

/** 岩:水平层理(冷暖交替)/ 风化亮面 / 裂隙暗缝 / 碎石 / 苔痕。 */
const ROCK_RX: Rx[] = [
  { f: F_STRATA, w: 0.56, r: 0.102, g: 0.077, b: -0.179 },  // 岩层暖带
  { f: F_STRATA, w: -0.42, r: -0.015, g: -0.056, b: 0.072 }, // 岩层冷带
  { f: F_MED, w: 0.62, r: 0.077, g: 0.062, b: -0.138 },     // 风化亮面
  { f: F_BIG, w: -0.47, r: 0.0, g: -0.051, b: 0.051 },      // 大尺度风化暗块
  { f: F_STONE, w: -1.23, r: -0.011, g: -0.051, b: 0.062 }, // 裂隙/碎石
  { f: F_STONE, w: 0.75, r: 0.072, g: 0.051, b: -0.123 },   // 岩面亮粒
  { f: F_FINE, w: 0.53, r: 0.062, g: 0.051, b: -0.113 },    // 颗粒感
  { f: F_WARP, w: 0.14, r: -0.011, g: 0.051, b: -0.041 },   // 局部苔/尘
];

/** 雪:雪影(冷蓝)/ 风蚀亮面 / 雪堆(脊)/ 冰晶斑点。 */
const SNOW_RX: Rx[] = [
  { f: F_BIG, w: -1.53, r: -0.048, g: -0.036, b: 0.084 },  // 雪影:冷蓝
  { f: F_MED, w: 0.69, r: 0.036, g: 0.048, b: -0.084 },    // 风蚀亮面:暖白
  { f: F_RIDGE, w: 0.57, r: 0.032, g: 0.042, b: -0.074 },  // 雪堆脊
  { f: F_RIPPLE, w: -0.41, r: -0.035, g: -0.039, b: 0.074 }, // 风蚀沟:微蓝
  { f: F_FINE, w: 0.95, r: 0.027, g: 0.032, b: -0.057 },   // 冰晶颗粒
];

/**
 * 逐 mode 微调(荒漠沙更"风成"、山岳岩层更明显、群岛植被更湿绿…)。
 * 只调权重倍数,不改色相 → 生物群系语义不变。
 */
function tuneRecipe(mode: string, layerIdx: number, rx: Rx[]): Rx[] {
  const k = (f: number, mul: number): Rx[] =>
    rx.map((e) => (e.f === f ? { ...e, w: e.w * mul } : e));
  if (layerIdx === 0) {
    // 沙/低地
    if (mode === 'desert') return k(F_RIPPLE, 1.5);
    if (mode === 'archipelago') return k(F_RIPPLE, 0.7);
    return rx;
  }
  if (layerIdx === 1) {
    // 草/植被
    if (mode === 'desert') return k(F_MED, 1.35); // 荒漠里偏枯黄
    if (mode === 'archipelago') return k(F_BIG, 1.35); // 雨林:密植被斑更强
    return rx;
  }
  if (layerIdx === 2) {
    // 岩
    if (mode === 'mountain' || mode === 'canyon') return k(F_STRATA, 1.35);
    if (mode === 'plains') return k(F_STRATA, 0.6);
    return rx;
  }
  // 雪
  if (mode === 'plains') return k(F_RIPPLE, 0.6);
  return rx;
}

/**
 * 生成一张 256² 可平铺的层 albedo 画布。
 * @param base  层基色(生物群系色,主导整体色相)
 * @param mode  地形风格(mountain/desert/archipelago/city/ocean/plains…)
 * @param layer 层名(进种子,保证同图不同层分布不同)
 * @param layerIdx 0..3(x=低地 y=草 z=岩 w=雪)
 */
export function makeLayerAlbedoCanvas(
  base: THREE.Color,
  mode: string,
  layer: string,
  layerIdx: number,
): HTMLCanvasElement {
  const F = fields();
  let rx: Rx[];
  switch (layerIdx) {
    case 1: rx = GRASS_RX; break;
    case 2: rx = ROCK_RX; break;
    case 3: rx = SNOW_RX; break;
    default: rx = SAND_RX; break;
  }
  rx = tuneRecipe(mode, layerIdx, rx);

  const img = new ImageData(F_SIZE, F_SIZE);
  const d = img.data;
  const br = base.r;
  const bg = base.g;
  const bb = base.b;
  const n = F_SIZE * F_SIZE;
  // 逐像素:base 上叠加加色色彩项,再整体加一点确定性细粒(去 banding)。
  const grain = buildValueField(F_SIZE, [197], [1], 'tl-grain');
  for (let i = 0; i < n; i++) {
    let r = br;
    let g = bg;
    let b = bb;
    for (let e = 0; e < rx.length; e++) {
      const it = rx[e];
      const t = it.w * F[it.f][i];
      r += t * it.r;
      g += t * it.g;
      b += t * it.b;
    }
    const gn = (grain[i] - 0.5) * 0.05;
    r += gn;
    g += gn;
    b += gn;
    const o = i * 4;
    d[o] = r <= 0 ? 0 : r >= 1 ? 255 : (r * 255) | 0;
    d[o + 1] = g <= 0 ? 0 : g >= 1 ? 255 : (g * 255) | 0;
    d[o + 2] = b <= 0 ? 0 : b >= 1 ? 255 : (b * 255) | 0;
    d[o + 3] = 255;
  }

  const c = document.createElement('canvas');
  c.width = c.height = F_SIZE;
  const ctx = c.getContext('2d')!;
  ctx.putImageData(img, 0, 0);
  return c;
}

// ---------------------------------------------------------------------------
// 宏观色调图(第 5 张低权重贴图;与 splat 分带无关)
// ---------------------------------------------------------------------------
// 采样方式见 layered-terrain.ts:同一张图取两个尺度(周期 2)叠加,得到
// ~2048 / ~1024 世界单位的两个宽域色调八度。中心 = 1.0,范围约 0.86..1.14,
// 且色相随亮度摆动(暗 = 冷/蓝,亮 = 暖/黄)→ 大块同带区域不再是一块纯色。
export function makeMacroTintCanvas(mode: string): HTMLCanvasElement {
  const F = fields();
  const img = new ImageData(TINT_TILE, TINT_TILE);
  const d = img.data;
  const big = F[F_BIG];
  const med = F[F_MED];
  const warp = F[F_WARP];
  const n = TINT_TILE * TINT_TILE;
  for (let i = 0; i < n; i++) {
    // 宽域摆动 [-1,1]
    const t = (big[i] - 0.5) * 1.6 + (med[i] - 0.5) * 0.7 + (warp[i] - 0.5) * 0.4;
    const tt = t < -1 ? -1 : t > 1 ? 1 : t;
    const o = i * 4;
    // 亮 = 微暖(黄/橙),暗 = 微冷(蓝/青);乘数围绕 1.0
    const rv = 1 + tt * 0.14;
    const gv = 1 + tt * 0.13;
    const bv = 1 - tt * 0.11;
    d[o] = rv <= 0 ? 0 : rv >= 1.99 ? 255 : (rv * 128) | 0;
    d[o + 1] = gv <= 0 ? 0 : gv >= 1.99 ? 255 : (gv * 128) | 0;
    d[o + 2] = bv <= 0 ? 0 : bv >= 1.99 ? 255 : (bv * 128) | 0;
    d[o + 3] = 255;
  }
  const c = document.createElement('canvas');
  c.width = c.height = TINT_TILE;
  const ctx = c.getContext('2d')!;
  ctx.putImageData(img, 0, 0);
  return c;
}

/** 包装成 three 贴图(sRGB + Repeat,与层贴图同规格)。 */
export function makeLayerAlbedoTexture(
  base: THREE.Color,
  mode: string,
  layer: string,
  layerIdx: number,
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(makeLayerAlbedoCanvas(base, mode, layer, layerIdx));
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// 基础场复用出口 (per user request: 程序化基础色图 terrain-basecolor.ts)
// ---------------------------------------------------------------------------
// 8 张可平铺基础场的索引常量 + 采样器:让「程序化基础色图」用**同一批场**
// 而不是另写一套噪声(零重复、观感同源)。世界周期由调用方给(米),环面上
// 任意相位偏移都不会产生接缝。
export const TILEABLE_FIELD = {
  BIG: F_BIG,
  MED: F_MED,
  FINE: F_FINE,
  STRATA: F_STRATA,
  STONE: F_STONE,
  WARP: F_WARP,
  RIPPLE: F_RIPPLE,
  RIDGE: F_RIDGE,
} as const;

/** 基础场边长(texel);采样周期以此为单位。 */
export const TILEABLE_FIELD_SIZE = F_SIZE;

/** 基础场集合(索引见 TILEABLE_FIELD;惰性构建一次,多层/基础色图共用)。 */
export function tileableFields(): Float32Array[] {
  return fields();
}

/**
 * 采样一张可平铺基础场:u/v **归一化到整张场**(1.0 = 一个环面周期),任意
 * 实数(含负数)自动绕回;环面双线性 → 边界与内部逐像素一致(无接缝)。
 */
export function sampleTileableField(F: Float32Array, u: number, v: number): number {
  let fu = u * F_SIZE;
  fu -= Math.floor(fu);
  let fv = v * F_SIZE;
  fv -= Math.floor(fv);
  const ix = fu | 0;
  const iy = fv | 0;
  const tx = fu - ix;
  const ty = fv - iy;
  const ix1 = (ix + 1) & (F_SIZE - 1);
  const iy1 = (iy + 1) & (F_SIZE - 1);
  const r0 = iy * F_SIZE, r1 = iy1 * F_SIZE;
  const a = F[r0 + ix], b = F[r0 + ix1], c = F[r1 + ix], d = F[r1 + ix1];
  const p = a + (b - a) * tx;
  const q = c + (d - c) * tx;
  return p + (q - p) * ty;
}

/** 诊断用:各基础场的去均值 RMS(标定 recipe 权重;不参与渲染路径)。 */
export function fieldRms(): number[] {
  const F = fields();
  return F.map((f) => {
    let s = 0;
    for (let i = 0; i < f.length; i++) s += f[i];
    const m = s / f.length;
    let v = 0;
    for (let i = 0; i < f.length; i++) v += (f[i] - m) * (f[i] - m);
    return Math.sqrt(v / f.length);
  });
}

/** 宏观色调贴图(线性乘数,不能用 sRGB 解码 → NoColorSpace)。 */
export function makeMacroTintTexture(mode: string): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(makeMacroTintCanvas(mode));
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}
