// === 植被遮罩/精灵验证脚本 (verification harness, not shipped) ===
// 真实调用 src/lib/game/environment.ts 的 buildVegetationMask / buildTerrainForest,
// 在极简 Canvas2D 桩 + 确定性程序化高度场/生物群系场上量测:
//   - 每种类实例数(两个地图模式:山岳 / 群岛)
//   - 遮罩覆盖率(可植被格占比)与平均密度
//   - 构建耗时(含遮罩网格预扫描)
//   - 左半幅精灵的白键 alpha 统计(透明占比 / 白晕残留)
// 运行:
//   npx esbuild scripts/veg-mask-check.ts --bundle --platform=node --format=esm --outfile=.vegcheck.mjs
//   node .vegcheck.mjs
import { installCanvasStub } from './veg-canvas-stub.mjs';
installCanvasStub();

const THREE: any = await import('three');
const env: any = await import('../src/lib/game/environment');

type RGB = [number, number, number];
type W4 = [number, number, number, number];

function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise2(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  return hash2(ix, iy) * (1 - ux) * (1 - uy) + hash2(ix + 1, iy) * ux * (1 - uy) +
    hash2(ix, iy + 1) * (1 - ux) * uy + hash2(ix + 1, iy + 1) * ux * uy;
}
function fbm2(x: number, y: number, oct = 5): number {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += a * vnoise2(x * f, y * f); f *= 2; a *= 0.5; }
  return s;
}
function makeHeightFn(size: number, maxH: number, mode: string): (x: number, z: number) => number {
  const half = size / 2;
  return (x: number, z: number) => {
    const n = Math.pow(fbm2((x / size) * 7.3 + 10, (z / size) * 7.3 - 4, 5), mode === 'archipelago' ? 1.5 : 1.1);
    let h = n * maxH;
    if (mode === 'archipelago') {
      const r = Math.hypot(x, z) / half;
      h = h * (1 - Math.min(1, Math.max(0, (r - 0.25) / 0.6))) - 40;
    }
    return h;
  };
}
function makeBiomeFn(size: number, maxH: number, snowLine: number): (x: number, z: number) => W4 {
  const hf = makeHeightFn(size, maxH, 'mountain');
  return (x: number, z: number) => {
    const t = Math.max(0, Math.min(1, hf(x, z) / maxH));
    let sand = 0, grass = 0, rock = 0, snow = 0;
    if (t < 0.08) sand = 1;
    else if (t < snowLine) {
      const k = Math.max(0, Math.min(1, (t - 0.45) / (snowLine - 0.45)));
      grass = 1 - k; rock = k;
    } else { snow = Math.min(1, (t - snowLine) / (1 - snowLine)); rock = 1 - snow; }
    return [sand, grass, rock, snow];
  };
}
const LAYER = { sand: 0xc2b280, grass: 0x4a7a34, rock: 0x8a8177, snow: 0xf2f4f6 };
function biomeRGB(w: W4): RGB {
  const c = [LAYER.sand, LAYER.grass, LAYER.rock, LAYER.snow].map((hex) => ([
    ((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255,
  ].map((v) => Math.pow(v, 2.2))));
  const s = w[0] + w[1] + w[2] + w[3] || 1;
  return [
    (w[0] * c[0][0] + w[1] * c[1][0] + w[2] * c[2][0] + w[3] * c[3][0]) / s,
    (w[0] * c[0][1] + w[1] * c[1][1] + w[2] * c[2][1] + w[3] * c[3][1]) / s,
    (w[0] * c[0][2] + w[1] * c[1][2] + w[2] * c[2][2] + w[3] * c[3][2]) / s,
  ];
}

interface Mode {
  name: string; size: number; maxH: number; snowLine: number; mode?: string;
  forest: { count: number; spread: number; maxSlope: number; minHeight: number; maxHeight: number; seed: number };
}
const MODES: Mode[] = [
  {
    name: 'mountain (engine 2865 call site)',
    size: 37800, maxH: 2500, snowLine: 0.78,
    forest: { count: 4000, spread: 18900, maxSlope: 0.55, minHeight: 80, maxHeight: 1700, seed: 99 },
  },
  {
    name: 'archipelago (engine 3169 call site)',
    size: 24300, maxH: 900, snowLine: 0.95, mode: 'archipelago',
    forest: { count: 600, spread: 12150, maxSlope: 0.55, minHeight: 30, maxHeight: 800, seed: 1234 },
  },
];

const report: { modes: any[]; sprites: any[] } = { modes: [], sprites: [] };

for (const m of MODES) {
  const h = makeHeightFn(m.size, m.maxH, m.mode ?? 'mountain');
  const biome = makeBiomeFn(m.size, m.maxH, m.snowLine);
  const mask = env.buildVegetationMask({
    spread: m.forest.spread,
    minH: m.forest.minHeight,
    maxH: m.forest.maxHeight,
    maxSlope: m.forest.maxSlope,
    patchiness: 0.35,
    seed: m.forest.seed,
    h,
    biomeAt: biome,
    baseColorAt: (x: number, z: number) => biomeRGB(biome(x, z)),
    layerColors: LAYER,
  });
  // 独立覆盖率扫描(不依赖内部网格)
  let samples = 0, veg = 0, sum = 0;
  const step = m.size / 220;
  for (let z = -m.size / 2; z <= m.size / 2; z += step) {
    for (let x = -m.size / 2; x <= m.size / 2; x += step) {
      const d = mask.sampleDensity(x, z);
      samples++; sum += d; if (d > 0.05) veg++;
    }
  }
  const t0 = performance.now();
  const group = env.buildTerrainForest(h, {
    ...m.forest, quiet: true, vegMask: mask, groundTint: 0.85,
  }) as any;
  const buildMs = performance.now() - t0;
  const dbg = (globalThis as any).__vegPlanLens;
  if (dbg) console.log('  [plan lens]', JSON.stringify(dbg));
  const stats = group.userData.vegStats;
  const counts = stats.counts;
  const total = stats.total;
  // 实例色统计(染色范围 / 绿偏向 / 唯一色数)
  let cMin = 9, cMax = -9, cSum = 0, cN = 0, greenish = 0;
  const uniq = new Set<string>();
  let maxSat = 0;
  const hsl = { h: 0, s: 0, l: 0 };
  const tmp = new THREE.Color();
  let instMeshes = 0, trunkCount = 0, chunkGroups = 0;
  group.traverse((o: any) => {
    if (o.isGroup) chunkGroups++;
    if (!o.isInstancedMesh) return;
    instMeshes++;
    if (!o.material.map) { trunkCount += o.count; return; }
    if (!o.instanceColor) return;
    const a: Float32Array = o.instanceColor.array;
    for (let i = 0; i < a.length; i += 3) {
      const lum = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
      cMin = Math.min(cMin, lum); cMax = Math.max(cMax, lum); cSum += lum; cN++;
      if (a[i + 1] > a[i] && a[i + 1] >= a[i + 2]) greenish++;
      uniq.add(a[i].toFixed(3) + ',' + a[i + 1].toFixed(3) + ',' + a[i + 2].toFixed(3));
      tmp.setRGB(a[i], a[i + 1], a[i + 2]);
      tmp.getHSL(hsl);
      if (hsl.s > maxSat) maxSat = hsl.s;
    }
  });
  // 确定性复核:同一输入重建,比较实例矩阵哈希 + 计数
  const group2 = env.buildTerrainForest(h, {
    ...m.forest, quiet: true, vegMask: mask, groundTint: 0.85,
  }) as any;
  const sig = (g: any): string => {
    let s = 0, n = 0;
    g.traverse((o: any) => {
      if (!o.isInstancedMesh) return;
      n += o.count;
      const a: Float32Array = o.instanceMatrix.array;
      for (let i = 0; i < a.length; i += 7) s = (s * 31 + Math.round(a[i] * 1000)) | 0;
    });
    return n + ':' + s;
  };
  const deterministic = sig(group) === sig(group2);
  report.modes.push({
    name: m.name,
    buildMs: Number(buildMs.toFixed(1)),
    coverageFrac: veg / samples,
    meanDensity: sum / samples,
    maskStats: stats,
    counts,
    total,
    trunkCount,
    instMeshes,
    chunkGroups,
    deterministic,
    tint: cN > 0
      ? { n: cN, minLum: cMin, maxLum: cMax, meanLum: cSum / cN, greenishFrac: greenish / cN, uniqueColors: uniq.size, maxSat }
      : null,
  });
  console.log(`\n== ${m.name} ==`);
  console.log(`  coverage=${(100 * veg / samples).toFixed(1)}%  meanDensity=${(sum / samples).toFixed(3)}  gridCoverage=${(100 * stats.coverage).toFixed(1)}%  cell=${stats.cellSize}m`);
  console.log(`  counts: conifer=${counts.conifer} decid=${counts.decid} grass=${counts.grass} bush=${counts.bush} total=${total}`);
  console.log(`  budget: conifer=${stats.budget.conifer} decid=${stats.budget.decid} grass=${stats.budget.grass} bush=${stats.budget.bush} sum=${stats.budget.sum} (cap ${stats.budget.plantCap}, scale ${stats.budget.plantScale.toFixed(2)})  trunks=${trunkCount}  chunkGroups=${chunkGroups}  instancedMeshes=${instMeshes}`);
  console.log(`  build=${buildMs.toFixed(0)}ms  deterministic=${deterministic}`);
  if (cN) console.log(`  tint: n=${cN} uniq=${uniq.size} lum ${cMin.toFixed(3)}..${cMax.toFixed(3)} mean=${(cSum / cN).toFixed(3)} greenFrac=${(greenish / cN).toFixed(2)} maxSat=${maxSat.toFixed(3)}`);
}

// ---- 精灵白键统计(程序化 2048 图集 + 左半幅裁剪 + 草/灌木变体) ----
console.log('\n== sprite alpha stats (white→transparent key) ==');
const allMetrics: any[] = env.listVegSpriteMetrics();
if (allMetrics.length === 0) console.log('  (no sprite metrics recorded)');
for (const mm of allMetrics) {
  const a = mm.alpha;
  console.log(
    `  ${mm.source}: ${mm.texW}x${mm.texH} aspect=${mm.aspect.toFixed(3)} ` +
    `transparent=${(100 * a.transparent / a.total).toFixed(1)}% ` +
    `hardWhiteKeyed=${(100 * a.whiteKeyed / a.total).toFixed(1)}% ` +
    `opaque=${(100 * a.opaque / a.total).toFixed(1)}% ` +
    `halo(alpha>20 at lum>0.95)=${a.halo}`,
  );
  report.sprites.push({ ...mm });
}
// 显式对照:纯白像素(源亮度 1.0)必须 alpha=0
const whiteKeyCheck = env.getVegSpriteMetricsForReport('skybound-veg-sprite-left-k0.985-0.050-proc');
if (whiteKeyCheck) {
  console.log(`  whiteKey(阈值)=${whiteKeyCheck.alpha.whiteKey} softRamp=${whiteKeyCheck.alpha.softRamp} → ` +
    `大于阈值的源像素 alpha 归零 + 反混合去白边,halo=${whiteKeyCheck.alpha.halo}`);
}

console.log('\nJSON=' + JSON.stringify(report));
