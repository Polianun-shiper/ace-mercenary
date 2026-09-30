#!/usr/bin/env node
// === Gaea 导入材质压缩:normal/ao 的 PNG → JPEG =============================
// 为什么:单文件部署(上传网站)对超大 HTML 校验不稳(实测 ~107MB 失败、
// ~89MB 可传)。地形三张 2048² 贴图里 color 已是 JPEG,而 normal/AO 还是
// PNG(7.7MB / 5.4MB)。这两张都是"低频连续图",JPEG 质量 88~92 在 24m/纹素
// 的地表上肉眼无差,体积降 85% 以上。
//
// 用法: node scripts/gaea-material-jpeg.mjs [--quality 90] [--aoq 86] [--revert]
// 作用: public/custom-maps/custom/{normal,ao}.png → .jpg + 更新 terrain-tune.json
//       (--revert 反向:从已有的 .jpg 重新写回 PNG 并改回 tune)
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'public', 'custom-maps', 'custom');
const TUNE = join(ROOT, 'public', 'config', 'terrain-tune.json');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? Number(argv[i + 1]) : d; };
const Q = arg('--quality', 90);
const AOQ = arg('--aoq', 86);
const REVERT = argv.includes('--revert');

const mb = (p) => existsSync(p) ? (statSync(p).size / 1048576).toFixed(2) + 'MB' : '—';

async function toJpeg(base, quality) {
  const src = join(DIR, base + '.png');
  const dst = join(DIR, base + '.jpg');
  if (!existsSync(src)) { console.log(`[跳过] ${base}.png 不存在`); return null; }
  await sharp(src).jpeg({ quality, chromaSubsampling: '4:4:4', mozjpeg: true }).toFile(dst);
  console.log(`[压缩] ${base}.png ${mb(src)} → ${base}.jpg ${mb(dst)} (q${quality})`);
  return base + '.jpg';
}
async function toPng(base) {
  const src = join(DIR, base + '.jpg');
  const dst = join(DIR, base + '.png');
  if (!existsSync(src)) { console.log(`[跳过] ${base}.jpg 不存在`); return null; }
  await sharp(src).png().toFile(dst);
  console.log(`[还原] ${base}.jpg → ${base}.png ${mb(dst)}`);
  return base + '.png';
}

const cfg = JSON.parse(readFileSync(TUNE, 'utf8'));
const mat = cfg.maps.custom.material;

const n = REVERT ? await toPng('normal') : await toJpeg('normal', Q);
const a = REVERT ? await toPng('ao') : await toJpeg('ao', AOQ);
if (n) mat.normalMap = `/custom-maps/custom/${n}`;
if (a) mat.aoMap = `/custom-maps/custom/${a}`;
writeFileSync(TUNE, JSON.stringify(cfg, null, 2));
console.log('[tune] maps.custom.material =', JSON.stringify(mat));
