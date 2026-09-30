#!/usr/bin/env node
// scripts/clouds-atlas.mjs
//
// 把 clouds-prep.mjs 产出的**逐张**云贴图(颜色 + 法线)打包成**两张图集**:
//   public/textures/clouds/atlas/clouds.jpg     ← 颜色图集
//   public/textures/clouds/atlas/clouds_n.jpg   ← 法线图集
//   public/textures/clouds/atlas/atlas.json     ← 每个文件在哪个格 + 分类
//
// 为什么: 125 张云 = 250 个文件(含法线) → 开局 250 次请求, 加载很慢; 云场还得每张图一个
// InstancedMesh → 125 个 draw call。打包后运行时只拉 **3 个文件**(json + 2 张图),
// 云场只需 1~2 个 InstancedMesh(逐实例图集格坐标)。
//
// 用法: node scripts/clouds-atlas.mjs [--cell 128] [--grid 16x8] [--root public/textures/clouds]

import { existsSync, mkdirSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const CELL = Math.round(parseFloat(getArg('--cell', 128)));
const [GX, GY] = String(getArg('--grid', '16x8')).split('x').map((v) => parseInt(v, 10));
const ROOT = getArg('--root', 'public/textures/clouds');
const OUT = join(ROOT, 'atlas');
const CELLS = GX * GY;

/** 收集 {file, normal, cls} —— 与 clouds-prep.mjs 的输出布局一致。 */
function collect() {
  const out = [];
  for (const cls of ['large', 'small']) {
    const dir = join(ROOT, cls);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => /\.(jpe?g|png|webp)$/i.test(n) && !/_n\./i.test(n)).sort()) {
      const normal = f.replace(/\.(jpe?g|png|webp)$/i, '_n.jpg');
      out.push({ file: `${cls}/${f}`, normal: existsSync(join(dir, normal)) ? `${cls}/${normal}` : null, cls });
    }
  }
  return out;
}

const files = collect();
if (!files.length) {
  console.error(`未找到逐张云贴图(${ROOT}/{large,small}/*.jpg)。先跑: node scripts/clouds-prep.mjs --src <原始目录>`);
  process.exit(1);
}
if (files.length > CELLS) {
  console.error(`格子不够: ${files.length} 张 > ${GX}x${GY}=${CELLS}。用 --grid 调大(如 16x16)。`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
const W = GX * CELL, H = GY * CELL;

const composite = async (pick) => {
  const comps = [];
  const entries = [];
  for (let i = 0; i < files.length; i++) {
    const rel = pick(files[i]);
    if (!rel) continue;
    const src = join(ROOT, rel);
    // 统一缩到格子内(contain + 黑底, 保持宽高比) —— 黑底与素材本身一致, 着色器用亮度当 alpha。
    const buf = await sharp(src).resize(CELL, CELL, { fit: 'contain', background: { r: 0, g: 0, b: 0 } }).jpeg({ quality: 88 }).toBuffer();
    const cx = i % GX, cy = Math.floor(i / GX);
    comps.push({ input: buf, left: cx * CELL, top: cy * CELL });
    entries.push({ i, cx, cy });
  }
  const base = sharp({ create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } } });
  return { img: await base.composite(comps).jpeg({ quality: 88 }).toBuffer(), entries };
};

const color = await composite((f) => f.file);
const normal = await composite((f) => f.normal);
writeFileSync(join(OUT, 'clouds.jpg'), color.img);
writeFileSync(join(OUT, 'clouds_n.jpg'), normal.img);

// 每个文件 → 格坐标(归一化由渲染端按 grid 除)
const json = {
  grid: [GX, GY],
  cell: CELL,
  size: [W, H],
  color: 'clouds.jpg',
  normal: 'clouds_n.jpg',
  files: files.map((f, i) => ({
    file: f.file,
    normal: f.normal,
    class: f.cls,
    cell: [i % GX, Math.floor(i / GX)],
  })),
};
writeFileSync(join(OUT, 'atlas.json'), JSON.stringify(json, null, 1) + '\n');

const kb = (p) => (statSync(p).size / 1024).toFixed(0);
console.log(`OK ${OUT}\\clouds.jpg     ${W}x${H} (${GX}x${GY} 格 × ${CELL}px, ${kb(join(OUT, 'clouds.jpg'))} KB)`);
console.log(`OK ${OUT}\\clouds_n.jpg   ${W}x${H} (${kb(join(OUT, 'clouds_n.jpg'))} KB)`);
console.log(`OK ${OUT}\\atlas.json     ${files.length} 个文件 → 扣掉逐张请求(250 个)后运行时只需 3 个文件`);
