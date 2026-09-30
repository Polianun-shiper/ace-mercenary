// === 顶点色 → 遮罩分类(shared:编辑器导入期 + 未来运行期) ===
// Gaea 顶点色按「与 4 层规范色卡最近邻」软分类成 RGBA 遮罩
// (R/G/B/A = 低地/草/岩/雪,与 splat.xyzw/既有 mask 通道一致)。
// 逐世界格 bin 求平均色 → 距离倒数软权重;空格由调用方提供的
// 高度/坡度自动权重兜底(fillMaskGaps)。
export type LayerName = 'low' | 'grass' | 'rock' | 'snow';
export const LAYER_NAMES: LayerName[] = ['low', 'grass', 'rock', 'snow'];

/** 规范色卡默认值(线性 0..1):sand/grass/rock/snow —— 与引擎四色接近。 */
export const DEFAULT_CANONICAL: [number, number, number][] = [
  [0.72, 0.66, 0.47], // low(沙/低地)
  [0.27, 0.38, 0.18], // grass
  [0.52, 0.47, 0.42], // rock(亮灰褐,导入后可用 uRockBoost 微调)
  [0.95, 0.97, 0.98], // snow
];

export interface VertexColorPt {
  x: number;   // 世界米
  z: number;
  /** 顶点色 0..1 */
  r: number;
  g: number;
  b: number;
}

/** 单点软分类权重(距离倒数平方,归一)。 */
export function classifyColor(
  r: number, g: number, b: number,
  canonical: [number, number, number][] = DEFAULT_CANONICAL,
): [number, number, number, number] {
  const w: number[] = [];
  let sum = 0;
  for (let k = 0; k < 4; k++) {
    const dr = r - canonical[k][0];
    const dg = g - canonical[k][1];
    const db = b - canonical[k][2];
    const d2 = Math.max(1e-5, dr * dr + dg * dg + db * db);
    const wi = 1 / d2;
    w.push(wi);
    sum += wi;
  }
  return [w[0] / sum, w[1] / sum, w[2] / sum, w[3] / sum];
}

/**
 * 顶点色栅格化:逐世界格 bin(平均色)→ 软分类权重。
 * 输出 Uint8ClampedArray(resX*resY*4),未覆盖格全 0(留给 fillMaskGaps)。
 * 顶点太多时按格预聚合,O(顶点数 + resX*resY),不按像素遍历顶点。
 */
export function rasterVertexColorMask(
  pts: VertexColorPt[],
  opts: { size: number; resX: number; resY: number; canonical?: [number, number, number][] },
): Uint8ClampedArray {
  const { size, resX, resY, canonical } = opts;
  const out = new Uint8ClampedArray(resX * resY * 4);
  const cnt = new Uint32Array(resX * resY);
  const acc = new Float32Array(resX * resY * 3);
  for (const p of pts) {
    const ix = Math.floor(((p.x + size / 2) / size) * resX);
    const iy = Math.floor(((p.z + size / 2) / size) * resY);
    if (ix < 0 || iy < 0 || ix >= resX || iy >= resY) continue;
    const ci = iy * resX + ix;
    cnt[ci]++;
    const o = ci * 3;
    acc[o] += p.r; acc[o + 1] += p.g; acc[o + 2] += p.b;
  }
  for (let i = 0; i < resX * resY; i++) {
    const c = cnt[i];
    if (!c) continue;
    const o = i * 3;
    const w = classifyColor(acc[o] / c, acc[o + 1] / c, acc[o + 2] / c, canonical);
    const mo = i * 4;
    out[mo] = Math.round(w[0] * 255);
    out[mo + 1] = Math.round(w[1] * 255);
    out[mo + 2] = Math.round(w[2] * 255);
    out[mo + 3] = Math.round(w[3] * 255);
  }
  return out;
}

/**
 * 空格兜底:把 mask 中四通道和 ≈0 的格用 heightFn 自动权重(统一带/
 * 高度+坡度)填上 —— 保证导入结果无死角、与既有「相对分带」体系连续。
 * fallbackWeights(x,z) 由调用方给出(如 editor 用 bandWeightsAt+slope)。
 */
export function fillMaskGaps(
  mask: Uint8ClampedArray,
  opts: { size: number; resX: number; resY: number },
  fallbackWeights: (x: number, z: number) => [number, number, number, number],
): Uint8ClampedArray {
  const { size, resX, resY } = opts;
  for (let iy = 0; iy < resY; iy++) {
    const z = ((iy + 0.5) / resY) * size - size / 2;
    for (let ix = 0; ix < resX; ix++) {
      const o = (iy * resX + ix) * 4;
      const s = mask[o] + mask[o + 1] + mask[o + 2] + mask[o + 3];
      if (s > 4) continue;
      const x = ((ix + 0.5) / resX) * size - size / 2;
      const w = fallbackWeights(x, z);
      mask[o] = Math.round(w[0] * 255);
      mask[o + 1] = Math.round(w[1] * 255);
      mask[o + 2] = Math.round(w[2] * 255);
      mask[o + 3] = Math.round(w[3] * 255);
    }
  }
  return mask;
}
