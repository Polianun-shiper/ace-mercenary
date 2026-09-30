#!/usr/bin/env node
// scripts/gzip-obj-assets.mjs
//
// Pre-compresses the big text OBJ airframe assets with gzip -9 so the
// single-file build (scripts/build-single-html.mjs) can inline them as
// base64 data URIs at ~5.5x smaller size. War Thunder OBJ exports are pure
// ASCII vertex/face soup, so gzip -9 measures 5.5-5.9x on them:
//
//   f16c.obj      36.2 MiB -> ~6.5 MiB   (base64 8.7 MiB instead of 48.3 MiB)
//   MiG-29.obj    37.2 MiB -> ~6.8 MiB   (base64 9.1 MiB instead of 49.6 MiB)
//
// Runtime side: the loaders inflate the .gz with pako (already a project
// dependency — see src/lib/terrain-import/loader.ts) and hand the text to
// three's OBJLoader.parse. Zero fidelity loss: the OBJ text is byte-identical
// after inflate.
//
// The generated .gz files live next to their source in public/models/, which
// also makes them reachable from the dev server (scripts/serve-test.mjs
// serves /models/ straight out of public/).
//
// Regeneration: skipped when the .gz exists and is newer than its source.
// build-single-html.mjs calls ensureGzippedObjs() on every build, so a
// re-exported OBJ is always re-compressed automatically.
//
// Usage: node scripts/gzip-obj-assets.mjs

import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Text OBJ airframes that are inlined into the single-file build.
export const OBJ_SOURCES = [
  'public/models/f16c/f16c.obj',
  'public/models/MiG-29 (9-12).obj',
  // 主舰「堡垒」: 由 scripts/bastion-to-obj.mjs 从 bastion.fbx 导出(3.98MiB 文本)。
  // 内联后 file:// 双击单文件也能用真模型 —— 39.8MiB 的 FBX 本体不适合内联(base64 53MiB),
  // 所以只内联这份 OBJ(几何) + 浏览器提取的 albedo JPEG。
  'public/models/airship/bastion.obj',
  // B-52(与 AC-130 共用机体): 1.13MiB 文本 → gzip 0.27MiB,单文件 base64
  // 1.51MiB → 0.36MiB(**省 1.1MiB**)。这是唯一还以"未压缩文本"内联的机体,
  // 其余(f16c / MiG-29 / 堡垒)早就在这份清单里。走 programs/models.ts 的
  // HAS_OBJ_FILE 分支, 由 obj-gzip.ts 的 fetchTextAsset 在运行时 inflate。
  'public/models/b52.obj',
];

// === 天空盒 EXR 的 gzip 内联 (per 单文件体积: 余量只剩 71KiB 时的第一根杠杆) ===
// 任务给出的 `--no-4k-sky` 是**空操作**: 历史 4K 天空 evening.exr 早已登记为
// inline:false(只随行), 清单里根本没有它。真正占体积的是**第一关**的
// evening-046b.exr(13.80MiB PIZ → base64 17.55MiB, 占单文件的 17.6%)。
// EXR 的 PIZ 是逐块无损编码, 整文件再套一层 gzip -9 仍能省 1.23MiB
// (13.80 → 12.57MiB, base64 18.40 → 16.76MiB = **省 1.56MiB**)。
// 解压后与原始 EXR **逐字节一致** ⇒ 画质零变化(不是"降到 2K"那种降级)。
export const SKY_SOURCES = [
  'public/textures/sky/evening-046b.exr',
];

/**
 * Ensure every OBJ_SOURCES entry has an up-to-date `<name>.obj.gz` beside it.
 * @returns {{ path: string, gz: string, raw: number, gzBytes: number, ratio: number, skipped: boolean }[]}
 */
export function ensureGzippedObjs() {
  return ensureGzipped(OBJ_SOURCES, '[gzip-obj]');
}

/**
 * Ensure every SKY_SOURCES entry has an up-to-date `<name>.gz` beside it
 * (天空盒: EXR 本身无损, 外面再套 gzip 也是无损 —— 只为省单文件 base64)。
 */
export function ensureGzippedSkies() {
  return ensureGzipped(SKY_SOURCES, '[gzip-sky]');
}

/** 共享实现: 源文件比 .gz 新(或 .gz 缺失/为空)就重新 gzip -9。 */
function ensureGzipped(sources, tag) {
  const results = [];
  for (const rel of sources) {
    const src = join(ROOT, rel);
    const dst = src + '.gz';
    if (!existsSync(src)) {
      console.warn(`${tag} missing source, skipping: ${rel}`);
      continue;
    }
    const srcStat = statSync(src);
    const fresh = existsSync(dst) && statSync(dst).mtimeMs >= srcStat.mtimeMs && statSync(dst).size > 0;
    if (fresh) {
      const gzBytes = statSync(dst).size;
      results.push({ path: rel, gz: basename(dst), raw: srcStat.size, gzBytes, ratio: srcStat.size / gzBytes, skipped: true });
      continue;
    }
    const raw = readFileSync(src);
    const gz = gzipSync(raw, { level: 9 });
    writeFileSync(dst, gz);
    results.push({ path: rel, gz: basename(dst), raw: raw.length, gzBytes: gz.length, ratio: raw.length / gz.length, skipped: false });
  }
  return results;
}

// Direct invocation → print a report.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rows = [...ensureGzippedObjs(), ...ensureGzippedSkies()];
  for (const r of rows) {
    console.log(
      `[gzip] ${r.skipped ? 'up-to-date' : 'wrote'} ${r.gz}: ` +
      `${(r.raw / 1048576).toFixed(2)} MiB -> ${(r.gzBytes / 1048576).toFixed(2)} MiB ` +
      `(${r.ratio.toFixed(2)}x, base64 ${((r.gzBytes * 4) / 3 / 1048576).toFixed(2)} MiB)`,
    );
  }
}
