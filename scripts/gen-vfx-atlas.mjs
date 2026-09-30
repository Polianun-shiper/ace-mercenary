#!/usr/bin/env node
// scripts/gen-vfx-atlas.mjs
//
// 程序化生成 VFX 图集(精灵图): 用代码画, 不依赖任何第三方素材; 以后想换真素材,
// 直接把同名 PNG 覆盖掉即可(渲染端只认图集切格, 不关心里面画的是什么)。
//
// 用法:
//   node scripts/gen-vfx-atlas.mjs                 # 生成 explosion-fire.png / explosion-smoke.png
//   node scripts/gen-vfx-atlas.mjs --cell 128 --grid 8
//
// 输出: public/textures/vfx/<name>.png, 尺寸 = (cell*grid)²; 每格一帧, 按行优先排列。
// 约定: alpha 在图里; 渲染端 additive(火) / 普通混合(烟) 各取所需。
//
// 为什么要图集: 爆炸原来是"每层一个 mesh + 每层一个材质 + 每爆一次新建/销毁" ——
// 24 个爆炸同时存在就是 70+ 个对象、70+ 个 draw call, 还有逐爆的材质分配/释放抖动。
// 改成图集 + 实例化广告牌后, 一整类特效只有 1 个 draw call。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const getArg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? parseFloat(args[i + 1]) : d;
};
const CELL = Math.round(getArg('--cell', 128));
const GRID = Math.round(getArg('--grid', 8));
const OUT_DIR = 'public/textures/vfx';
const SIZE = CELL * GRID;

/** 确定性 PRNG(同一 seed 每次生成完全一样, 便于 diff)。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 3D 值噪声(便宜的自写版, 够画云/火的不规则边缘)。 */
function makeNoise(seed) {
  const rnd = mulberry32(seed);
  const g = new Float32Array(256 * 256);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  const at = (x, y) => g[((y & 255) << 8) | (x & 255)];
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = smooth(x - xi), yf = smooth(y - yi);
    return lerp(lerp(at(xi, yi), at(xi + 1, yi), xf), lerp(at(xi, yi + 1), at(xi + 1, yi + 1), xf), yf);
  };
}
const fbm = (n, x, y, oct = 4) => {
  let s = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += n(x * f, y * f) * amp; f *= 2.03; amp *= 0.5; }
  return s;
};

/**
 * 画一张图集。
 * @param kind 'fire' | 'smoke'
 * @param tint 基准色(火: 暖橙; 烟: 深灰)
 */
function drawAtlas(kind, tint) {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  const rnd = mulberry32(kind === 'fire' ? 1337 : 7331);
  const noise = makeNoise(kind === 'fire' ? 4242 : 2424);
  const frames = GRID * GRID;

  for (let f = 0; f < frames; f++) {
    const fx = f % GRID, fy = Math.floor(f / GRID);
    const p = f / (frames - 1);                      // 0 → 1 动画进度
    // 火: 快速起亮 → 膨胀 → 尾部转暗; 烟: 前段淡入、中段最浓、后段散去
    const grow = kind === 'fire' ? 0.18 + 0.82 * Math.pow(p, 0.55) : 0.30 + 0.70 * Math.pow(p, 0.5);
    const alphaEnv = kind === 'fire'
      ? Math.min(1, p * 6) * Math.max(0, 1 - Math.pow(Math.max(0, p - 0.55) / 0.45, 1.6))
      : Math.min(1, p * 4) * Math.max(0, 1 - Math.pow(Math.max(0, p - 0.5) / 0.5, 2.0));
    // 色带: 火从近白 → 黄 → 橙 → 暗红; 烟从亮灰 → 深灰
    const ramp = (q) => {
      if (kind === 'smoke') {
        const v = 0.42 - 0.22 * q;
        return [v * tint[0], v * tint[1], v * tint[2]];
      }
      // fire
      const a = [1.0, 0.96, 0.86], b = [1.0, 0.72, 0.22], c = [0.85, 0.26, 0.06], d = [0.22, 0.06, 0.03];
      const t1 = Math.min(1, q / 0.35), t2 = Math.min(1, Math.max(0, (q - 0.35) / 0.4)), t3 = Math.min(1, Math.max(0, (q - 0.75) / 0.25));
      const mix = (x, y, t) => x + (y - x) * t;
      const p1 = a.map((v, i) => mix(v, b[i], t1));
      const p2 = p1.map((v, i) => mix(v, c[i], t2));
      return p2.map((v, i) => mix(v, d[i], t3));
    };

    const cx = fx * CELL + CELL / 2, cy = fy * CELL + CELL / 2;
    const R = CELL * 0.5 * grow;
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const dx = x + 0.5 - CELL / 2, dy = y + 0.5 - CELL / 2;
        const d = Math.hypot(dx, dy) / R;                     // 0 中心 → 1 边缘
        // 用噪声把"半径"打毛, 得到不规则的火舌/云絮边缘
        const nz = fbm(noise, (x / CELL) * 4 + f * 0.7, (y / CELL) * 4, 4);
        const edge = d + (nz - 0.5) * (kind === 'fire' ? 0.55 : 0.85);
        if (edge >= 1) continue;
        const fall = Math.pow(1 - Math.max(0, edge), kind === 'fire' ? 1.5 : 2.0);
        const dens = Math.min(1, fall * (kind === 'fire' ? 1.5 : 1.2) * (0.75 + 0.5 * fbm(noise, x / CELL * 7, y / CELL * 7, 3)));
        const col = ramp(Math.min(1, d * 0.9 + (1 - dens) * 0.25));
        const a = Math.max(0, Math.min(1, dens * alphaEnv));
        const di = ((fy * CELL + y) * SIZE + (fx * CELL + x)) * 4;
        buf[di] = Math.round(col[0] * 255);
        buf[di + 1] = Math.round(col[1] * 255);
        buf[di + 2] = Math.round(col[2] * 255);
        buf[di + 3] = Math.round(a * 255);
      }
    }
  }
  return buf;
}

mkdirSync(dirname(join(OUT_DIR, 'x')), { recursive: true });
for (const [name, kind, tint] of [
  ['explosion-fire', 'fire', [1, 1, 1]],
  ['explosion-smoke', 'smoke', [0.62, 0.58, 0.55]],
]) {
  const buf = drawAtlas(kind, tint);
  const out = join(OUT_DIR, name + '.png');
  await sharp(buf, { raw: { width: SIZE, height: SIZE, channels: 4 } }).png({ compressionLevel: 9 }).toFile(out);
  const st = (await import('node:fs')).statSync(out);
  console.log(`OK ${out}  ${SIZE}x${SIZE} (${GRID}x${GRID} 格 × ${CELL}px, ${(st.size / 1024).toFixed(1)} KB)`);
}
writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify({ files: ['explosion-fire.png', 'explosion-smoke.png'], grid: GRID, cell: CELL, frames: GRID * GRID }, null, 2) + '\n');
console.log('OK ' + join(OUT_DIR, 'manifest.json'));
