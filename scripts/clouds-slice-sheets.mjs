#!/usr/bin/env node
// scripts/clouds-slice-sheets.mjs
//
// 把"联络表"(contact sheet, 5 列 × 5 行 = 25 格/张)切成单张云图, 供
// scripts/clouds-prep.mjs 做分类/裁剪/法线。
//
// 用法:
//   node scripts/clouds-slice-sheets.mjs <sheet1.png> [sheet2.png ...] [--out public/textures/clouds/_raw] [--cols 5] [--rows 5]
// 例(用户那 5 张 QQ 联络表):
//   node scripts/clouds-slice-sheets.mjs "C:/Users/Administrator/Downloads/QQ20260914-2156*.png" \
//        --out public/textures/clouds/_raw
//
// 说明:
// - 等分切格(联络表是均匀网格), 每格内部的黑边交给下游 clouds-prep 的"内容包围盒裁剪"处理。
// - 全黑(有效像素太少)的格直接跳过, 不写入 _raw, 免得下游把它当素材。

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? args[outIdx + 1] : 'public/textures/clouds/_raw';
const colsIdx = args.indexOf('--cols');
const rowsIdx = args.indexOf('--rows');
const COLS = colsIdx >= 0 ? parseInt(args[colsIdx + 1], 10) : 5;
const ROWS = rowsIdx >= 0 ? parseInt(args[rowsIdx + 1], 10) : 5;
const skip = new Set(['--out', OUT, '--cols', String(COLS), '--rows', String(ROWS)]);
const inputs = args.filter((a) => !skip.has(a) && !a.startsWith('--'));

/** 展开 glob(只支持末尾 * 的简单形式, 避免引入额外依赖)。 */
function expandOne(p) {
  if (!p.includes('*')) return existsSync(p) ? [p] : [];
  const dir = dirname(p);
  const pat = basename(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const re = new RegExp('^' + pat + '$', 'i');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => re.test(f)).map((f) => join(dir, f));
}
const files = inputs.flatMap(expandOne);
if (!files.length) {
  console.error('未找到联络表图(用法见文件头注释)');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

let total = 0, kept = 0, skipped = 0;
for (let s = 0; s < files.length; s++) {
  const f = files[s];
  const meta = await sharp(f).metadata();
  const cw = Math.floor(meta.width / COLS);
  const ch = Math.floor(meta.height / ROWS);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      total++;
      const cell = sharp(f).extract({ left: c * cw, top: r * ch, width: cw, height: ch });
      // 有效像素占比检查(全黑格跳过): 取灰度统计, 均值太低即认为空
      const st = await cell.clone().greyscale().stats();
      const mean = st.channels[0].mean;
      const max = st.channels[0].max;
      if (mean < 3 || max < 24) { skipped++; continue; }
      const name = `sheet${String(s + 1).padStart(2, '0')}-r${r + 1}c${c + 1}.png`;
      await cell.png().toFile(join(OUT, name));
      kept++;
    }
  }
  console.log(`  ${basename(f)} -> ${cw}x${ch} 格 ${COLS}x${ROWS}`);
}
console.log(`\n切片完成: 共 ${total} 格, 写入 ${kept} 张, 跳过全黑 ${skipped} 张 -> ${OUT}`);
