// === 程序化地形配方内核 (per user request: 配方直生·雪山同款档) ===
// 不用 Gaea —— 你发令 → 我落成 TerrainRecipe(纯 JSON 配方)→ 本模块在
// 运行处(引擎 custom 槽 / headless 脚本)按配方现算 Float32 米制高度网格,
// 再走 buildHeightmapTerrain({heightAt}) —— 分块 LOD 自动切、相对分带自动
// 出遮罩/顶点 splat、植被/云带按配方。产物 = 配方 JSON(可读可改可回写)。
// 纯数学实现(无 DOM/three 依赖):引擎、编辑器、Node 脚本共用同一份。
import type { HeightGrid } from './height-source';

export type TerrainFamily = 'ridge' | 'hills' | 'canyon' | 'plateau' | 'dunes' | 'archipelago' | 'valley';

export interface RecipeLayer {
  family: TerrainFamily;
  /** 混合权重(相对;同族多 layer 可叠不同波长/种子) */
  weight: number;
  /** 基础特征波长(米):一个峰/脊/沙丘的尺寸 */
  base?: number;
  /** fbm 倍频(默认 4;更大更碎) */
  octaves?: number;
  /** ridge:脊线尖锐度(1=经典 ridge;<1 柔和 >1 更尖) */
  ridgePow?: number;
  /** 各向异性挤压:>1 沿 x 拉长(纵向条带),<1 反之 */
  stretch?: number;
  /** 层内种子偏移 */
  seedOff?: number;
  /** 可选:只在该域起作用时的域窗口(0..1 的世界中心距比;>0 时按 smooth 窗淡出) */
  domainRadius?: number;
}

export interface TerrainRecipe {
  version: 1;
  /** 配方名(脚本/console 引用) */
  name: string;
  /** 世界范围(米,±size/2)与生成网格分辨率(建议 ~LOD0 行数 896) */
  size: number;
  resX: number;
  resY: number;
  seed: number;
  /** meters = min + frac^tone × (max-min) */
  minHeight: number;
  maxHeight: number;
  /** 高度域色调:>1 中低区更占面积(平原多);<1 高峰更突出 */
  tone?: number;
  /** 海面:低于 seaLevel 平滑沉到 seaFloor(海平面=0 语义与现系统一致) */
  seaLevel?: number;
  seaFloor?: number;
  /** 岛屿化:距中心 > radius 平滑沉海(可选) */
  islandRadius?: number;
  islandDepth?: number;
  /** 体积云带(米;引擎 custom 槽读取) */
  cloudBase?: number;
  cloudTop?: number;
  /** 下列字段为 tune/脚本便利字段(生成器忽略): */
  /** MWAM 风格键(mountain/desert/…;缺省 'mountain') */
  style?: string;
  /** 地形四色覆盖(可选) */
  colors?: { rock?: string; grass?: string; sand?: string; snow?: string };
  /** 植被(tune maps.custom.veg;缺省稀疏) */
  veg?: { enabled?: boolean; count?: number; spread?: number; maxSlope?: number; minHeight?: number; maxHeight?: number; seed?: number };
  layers: RecipeLayer[];
}

// ---------------------------------------------------------------------------
// 确定性噪声(世界米坐标;同 seed 每次逐位一致)
// ---------------------------------------------------------------------------
function hash2(x: number, z: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263) + Math.imul(seed | 0, 69069);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function smooth(v: number) { return v * v * (3 - 2 * v); }
function vnoise2(x: number, z: number, seed: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  const u = smooth(fx), v = smooth(fz);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** 域旋转防网格化。 */
function rotXY(x: number, z: number, seed: number): [number, number] {
  const a = (seed % 17) * 0.11 + 0.25;
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c - z * s, x * s + z * c];
}

/** fbm 归一 0..1。 */
function fbm2(x: number, z: number, oct: number, seed: number): number {
  let v = 0, amp = 1, sum = 0;
  for (let i = 0; i < oct; i++) {
    v += amp * vnoise2(x, z, seed + i * 101);
    sum += amp;
    amp *= 0.5;
    x *= 2.03; z *= 2.03;
  }
  return v / sum;
}

/** 经典 ridge(1-|2n-1|)^pow 的 fbm,归一 0..1。 */
function ridgeFbm(x: number, z: number, oct: number, pow: number, seed: number): number {
  let v = 0, amp = 1, sum = 0;
  for (let i = 0; i < oct; i++) {
    const n = vnoise2(x, z, seed + i * 113);
    const r = 1 - Math.abs(2 * n - 1);
    v += amp * Math.pow(r, pow);
    sum += amp;
    amp *= 0.5;
    x *= 2.07; z *= 2.07;
  }
  return v / sum;
}

// ---------------------------------------------------------------------------
// 族函数:输入世界坐标 + 波长 base;输出 0..1(越高越"隆起")
// ---------------------------------------------------------------------------
function familyValue(l: RecipeLayer, x: number, z: number, seed: number): number {
  const base = l.base ?? 2400;
  const oct = Math.max(1, Math.min(8, Math.round(l.octaves ?? 4)));
  const pow = l.ridgePow ?? 1;
  const st = l.stretch ?? 1;
  const [rx, rz] = rotXY(x / base, z / base, seed + (l.seedOff ?? 0));
  const sx = rx * st;
  const sz = rz / st;
  switch (l.family) {
    case 'ridge':
      return ridgeFbm(sx, sz, oct, pow, seed + 1);
    case 'hills':
      return Math.pow(fbm2(sx, sz, oct, seed + 2), 1.3);
    case 'valley': {
      // 谷地:低频主形抬高,高频刻蚀把隆起处压成沟 —— 谷底暗
      const n = fbm2(sx, sz, Math.max(2, oct - 1), seed + 3);
      const carve = fbm2(sx * 2.3, sz * 2.3, Math.max(2, oct - 2), seed + 4);
      return Math.max(0, Math.min(1, n * 0.55 + (1 - carve) * 0.45));
    }
    case 'canyon': {
      const r = ridgeFbm(sx, sz, oct, pow + 0.6, seed + 5);
      const cut = Math.pow(r, 1.6); // 脊谷对比大
      return cut;
    }
    case 'plateau': {
      const n = fbm2(sx * 0.6, sz * 0.6, Math.max(2, oct - 1), seed + 6);
      // 高原:大块抬升 + 台面边缘侵蚀
      const plateau = smooth(Math.min(1, Math.max(0, (n - 0.32) / 0.4)));
      const edge = fbm2(sx * 2.4, sz * 2.4, 3, seed + 7);
      return Math.max(0, Math.min(1, plateau * (0.45 + 0.55 * (1 - edge) )));
    }
    case 'dunes': {
      // 沙丘:纵向脊线(正弦挤压)+ 低频包络
      const env = fbm2(sx * 0.7, sz * 0.7, 3, seed + 8);
      const dune = Math.max(0, Math.sin((sx * 6.28) / 2.0 + sz * 0.25) * 0.5 + 0.5);
      const crest = Math.pow(dune, 2.2);
      return Math.max(0, Math.min(1, env * 0.35 + crest * 0.65));
    }
    case 'archipelago': {
      const n = fbm2(sx * 1.6, sz * 1.6, oct, seed + 9);
      const r = ridgeFbm(sx * 0.8, sz * 0.8, Math.max(3, oct - 1), pow, seed + 10);
      const mass = Math.max(0, Math.min(1, (n * 0.7 + r * 0.9) - 0.52) / 0.5);
      return mass; // 海面以下由 seaLevel 切
    }
    default:
      return 0;
  }
}

/** 域窗口(可选):把某些 layer 限制在地图中心半径内,外缘淡出。 */
function domainFade(l: RecipeLayer, x: number, z: number, size: number): number {
  const r = l.domainRadius;
  if (!r || r <= 0) return 1;
  const d = Math.sqrt(x * x + z * z) / (size / 2);
  return 1 - smooth(Math.min(1, Math.max(0, (d - r * 0.75) / Math.max(1e-3, r * 0.25))));
}

/** 按配方生成米制高度网格(确定性;896² ≈ 数十~百毫秒级)。 */
export function generateTerrainGrid(recipe: TerrainRecipe): HeightGrid {
  const { size, resX, resY, seed, minHeight, maxHeight } = recipe;
  const half = size / 2;
  const tone = recipe.tone ?? 1;
  const range = Math.max(1, maxHeight - minHeight);
  const data = new Float32Array(resX * resY);
  const totalW = recipe.layers.reduce((s, l) => s + Math.max(0.001, l.weight), 0);

  for (let iy = 0; iy < resY; iy++) {
    const z = ((iy + 0.5) / resY) * size - half;
    for (let ix = 0; ix < resX; ix++) {
      const x = ((ix + 0.5) / resX) * size - half;
      let acc = 0;
      for (const l of recipe.layers) {
        const fade = domainFade(l, x, z, size);
        if (fade <= 0) continue;
        acc += l.weight * fade * familyValue(l, x, z, seed);
      }
      let frac = acc / totalW;
      frac = Math.max(0, Math.min(1, frac));
      if (tone !== 1) frac = Math.pow(frac, tone);
      let h = minHeight + frac * range;
      // 海面切割:低于 seaLevel 平滑沉到 seaFloor
      const sea = recipe.seaLevel;
      if (sea !== undefined && h < sea) {
        const fl = recipe.seaFloor ?? Math.max(0, sea - 120);
        const t = Math.min(1, Math.max(0, (sea - h) / Math.max(1, range * 0.06)));
        h = sea - (sea - fl) * smooth(t);
      }
      // 岛屿化
      const ir = recipe.islandRadius;
      if (ir && ir > 0) {
        const d = Math.sqrt(x * x + z * z);
        const fall = smooth(Math.min(1, Math.max(0, (d - ir) / Math.max(1, size * 0.12))));
        const depth = recipe.islandDepth ?? 160;
        h -= fall * depth;
        h *= 1 - fall * 0.6;
      }
      data[iy * resX + ix] = h;
    }
  }
  return { data, size, resX, resY, maxHeight };
}

/** 统计(脚本/console 用)。 */
export function gridStats(grid: HeightGrid): { min: number; max: number; mean: number; areaBelowSea: number } {
  let min = Infinity, max = -Infinity, sum = 0, sea = 0;
  const { data } = grid;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    if (v < 0) sea++;
  }
  return {
    min: min === Infinity ? 0 : min,
    max: max === -Infinity ? 0 : max,
    mean: sum / Math.max(1, data.length),
    areaBelowSea: sea / Math.max(1, data.length),
  };
}
