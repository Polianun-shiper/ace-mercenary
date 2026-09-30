#!/usr/bin/env node
// === 分块 job 生成器:Gaea 雪山模板 → N×N 独立分块 job ===
// 用户诉求:不要"一张图拉伸到全图",要跟雪山 LOD 同构的 7×7 分块、
// 每块独立峰群(不同种子/参数)、块间无缝。
// 用法:
//   node scripts/gaea-tile-jobs.mjs <outdir> [--grid 3] [--base seed]
// 产物:<outdir>/tile_r<row>_c<col>.terrain —— 每个都是 realistic-range 结构
// 副本 + 该块独有的 Mountain 种子/高度/尺度 + 已接好 HeightmapExport。
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

// 直接修改 Base 文件里的两个 Mountain 节点(纯文本,保留图链与导出节点)
function varyTerrain(srcText, { seedA, seedB, hA, hB, sA, sB }) {
  const o = JSON.parse(srcText);
  const T = o.Assets.$values[0].Terrain;
  const map = new Map();
  for (const [k, v] of Object.entries(T.Nodes)) if (k !== '$id') map.set(Number(k), v);
  const mts = [...map.entries()].filter(([, n]) => /Mountain/.test(n.$type || ''));
  if (mts.length < 2) throw new Error('需要 ≥2 个 Mountain 节点(realistic-range 结构)');
  // 主山=Id 小,次山=Id 大(即脚本后加的 Mountain2)
  mts.sort((a, b) => a[0] - b[0]);
  const [aId, a] = mts[0];
  const [bId, b] = mts[1];
  const patch = (id, node, params) => {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      // JSON.NET 属性名唯一命中该节点内(seed 也可能出现在别节点 → 限定区间)
      const start = srcText.indexOf('"' + id + '": {');
      const end = srcText.indexOf('"Ports": {', start);
      if (start < 0 || end < 0) continue;
      const re = new RegExp('"' + k + '":\\s*([0-9.]+)');
      const seg = srcText.slice(start, end);
      const mm = seg.match(re);
      if (mm) {
        const at = start + mm.index + mm[0].indexOf(mm[1]);
        srcText = srcText.slice(0, at) + String(v) + srcText.slice(at + mm[1].length);
      }
    }
  };
  // 主山居中偏低一点,次山种子大偏移
  patch(aId, a, { Height: hA, Scale: sA, Seed: seedA });
  patch(bId, b, { Height: hB, Scale: sB, Seed: seedB });
  return srcText;
}

function main() {
  const [outDir] = process.argv.slice(2);
  const grid = Number(process.argv[process.argv.indexOf('--grid') + 1] || 3);
  const baseSeed = Number(process.argv[process.argv.indexOf('--base') + 1] || 1000);
  const baseFile = 'F:/SkyAceGaea/jobs/realistic-range.terrain';
  if (!outDir) { console.log('用法: node scripts/gaea-tile-jobs.mjs <outdir> [--grid 3] [--base 1000]'); process.exit(1); }
  if (!statSync(baseFile).isFile()) { console.error('缺基座', baseFile); process.exit(1); }
  mkdirSync(outDir, { recursive: true });
  const baseText = readFileSync(baseFile, 'utf8');
  const rng = (n) => {
    let x = Math.sin(n) * 43758.5453123;
    return x - Math.floor(x);
  };
  let n = 0;
  for (let r = 0; r < grid; r++) {
    for (let c = 0; c < grid; c++) {
      const idx = r * grid + c;
      const seedA = baseSeed + idx * 7919 + r * 131 + c * 17 + 101;
      const seedB = baseSeed + idx * 104729 + r * 37 + c * 53 + 1009;
      const sA = 0.9 + rng(seedA) * 0.6;       // 0.9..1.5
      const sB = 0.85 + rng(seedB) * 0.5;      // 0.85..1.35
      const hA = 3.2 + rng(seedA + 5) * 2.2;   // 3.2..5.4
      const hB = 2.6 + rng(seedB + 9) * 2.0;   // 2.6..4.6
      const text = varyTerrain(baseText, { seedA, seedB, hA, hB, sA, sB });
      const f = join(outDir, `tile_r${r}_c${c}.terrain`);
      writeFileSync(f, text, 'utf8');
      JSON.parse(readFileSync(f, 'utf8')); // 校验
      n++;
    }
  }
  console.log(`[ok] ${grid}×${grid}=${n} 分块 job → ${outDir}/tile_r*_c*.terrain`);
}
main();
