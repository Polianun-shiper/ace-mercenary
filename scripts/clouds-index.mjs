// 云切片索引: 把 public/textures/clouds/{large,small} 里的逐张切片拼成带序号的联络图,
// 并写一份 index.md (序号 → 文件名)。用途: 用户可以直接照着序号删掉有问题的切片。
//   node scripts/clouds-index.mjs
import path from 'node:path';
import { readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLOUDS = path.join(ROOT, 'public', 'textures', 'clouds');
const OUT = path.join(CLOUDS, '_index');
const CELL = 128;      // 单元尺寸(切片最长边本来就是 128)
const COLS = 8;
const PAD = 3;

mkdirSync(OUT, { recursive: true });
const lines = ['# 云切片索引 (由 `node scripts/clouds-index.mjs` 生成)', '',
  '序号 → 文件名(同序号也画在联络图每格左上角)。删掉某个切片后跑 `node scripts/clouds-apply.mjs`',
  '重建图集与产物即可; ⚠️ 不要重跑 `clouds-prep.mjs` —— 它会从 `_raw/` 重新切出全部切片, 把删除撤销掉。', ''];

for (const cls of ['large', 'small']) {
  const dir = path.join(CLOUDS, cls);
  if (!existsSync(dir)) continue;
  const files = readdirSync(dir).filter((n) => /\.jpe?g$/i.test(n) && !/_n\.jpe?g$/i.test(n)).sort();
  const rows = Math.ceil(files.length / COLS);
  const W = COLS * (CELL + PAD) + PAD;
  const H = rows * (CELL + PAD) + PAD;
  const comps = [];
  const labels = [];
  for (let i = 0; i < files.length; i++) {
    const buf = await sharp(path.join(dir, files[i]))
      .resize({ width: CELL, height: CELL, fit: 'contain', background: { r: 0, g: 0, b: 0 } })
      .toBuffer();
    const cx = PAD + (i % COLS) * (CELL + PAD);
    const cy = PAD + Math.floor(i / COLS) * (CELL + PAD);
    comps.push({ input: buf, left: cx, top: cy });
    labels.push(`<text x="${cx + 3}" y="${cy + 14}" font-family="Arial,Helvetica,sans-serif" font-size="13" fill="#ffb000">${i + 1}</text>`);
    lines.push(`${cls} #${i + 1}  ${files[i]}`);
  }
  const svg = Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${labels.join('')}</svg>`);
  await sharp({ create: { width: W, height: H, channels: 3, background: { r: 12, g: 12, b: 12 } } })
    .composite([...comps, { input: svg, left: 0, top: 0 }])
    .png().toFile(path.join(OUT, `sheet-${cls}.png`));
  console.log(`${cls}: ${files.length} 张 → ${path.relative(ROOT, path.join(OUT, `sheet-${cls}.png`))} (${W}x${H}, ${COLS} 列)`);
  lines.push('');
}
writeFileSync(path.join(OUT, 'index.md'), lines.join('\n') + '\n');
console.log('索引 →', path.relative(ROOT, path.join(OUT, 'index.md')));
