// 临时:模拟 engine 调用方式(仅传 sampleHeight,不注入地表色)冒烟测试
import { installCanvasStub } from './veg-canvas-stub.mjs';
installCanvasStub();
const env: any = await import('../src/lib/game/environment');

function hash2(x: number, y: number) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise2(x: number, y: number) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  return hash2(ix, iy) * (1 - ux) * (1 - uy) + hash2(ix + 1, iy) * ux * (1 - uy) + hash2(ix, iy + 1) * (1 - ux) * uy + hash2(ix + 1, iy + 1) * ux * uy;
}
function fbm2(x: number, y: number, oct = 5) { let s = 0, a = 0.5, f = 1; for (let i = 0; i < oct; i++) { s += a * vnoise2(x * f, y * f); f *= 2; a *= 0.5; } return s; }
const size = 37800, maxH = 2500;
const h = (x: number, z: number) => Math.abs(Math.pow(fbm2((x / size) * 7.3 + 10, (z / size) * 7.3 - 4, 5), 1.1)) * maxH;
// 完全按 engine.ts 山地调用点的方式:mask 只注入 sampleHeight
const mask = env.buildVegetationMask({
  spread: 18900, minH: 80, maxH: 1700, maxSlope: 0.55, patchiness: 0.35, seed: 99, h,
});
const forest = env.buildTerrainForest(h, {
  count: 4000, spread: 18900, maxSlope: 0.55, minHeight: 80, maxHeight: 1700, seed: 99,
  grassCount: 60000, bushCount: 2600, vegMask: mask,
});
const st = forest.userData.vegStats;
console.log('SMOKE counts', JSON.stringify(st.counts), 'total', st.total, 'coverage', (st.coverage * 100).toFixed(1) + '%', 'tint', JSON.stringify(st.tint));
// 逐实例色唯一值(确认 derived ground 染色真的在动)
const seen = new Set<string>();
forest.traverse((o: any) => {
  if (!o.isInstancedMesh || !o.instanceColor) return;
  const a = o.instanceColor.array;
  for (let i = 0; i < a.length; i += 3) seen.add(a[i].toFixed(4) + ',' + a[i + 1].toFixed(4) + ',' + a[i + 2].toFixed(4));
});
console.log('SMOKE unique instance colors =', seen.size, JSON.stringify(Array.from(seen).slice(0, 6)));
