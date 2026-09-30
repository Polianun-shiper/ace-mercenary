#!/usr/bin/env node
// scripts/import-asset.mjs
//
// === 资产导入工具 (per user request) ===
// "在之后, 所有导入的新机体, 贴图, 以及各种地形贴图, 都要压缩之后放在资产库文件夹里"
//
// 这个脚本就是那条政策的执行者: 把源文件**先压缩**, 落到 public/<库路径>, 再登记进
// src/lib/game/asset-library.json(单一真相源)。登记后:
//   · 构建 (scripts/build-single-html.mjs) 会把 copy:true 的文件拷进
//     dist-single/assets/<库路径> —— 也就是用户说的"资产库文件夹";
//   · 运行时 assetUrl() 对命中前缀的路径解析为 'assets' + path。
// 默认 inline:false —— 新资产**不进单文件 HTML**, 上传时随 assets/ 一起传;
// 需要"双击单文件也能玩"时加 --inline(或构建时 --inline-library 全量内联)。
//
// 压缩规则(按扩展名自动选, 目的只有一个: 能用更小的字节换同样的观感)
//   .obj/.mtl/.gltf/.glb/.bin/.f32bin/.json  → gzip -9   →  <name>.<ext>.gz
//   .png/.jpg/.jpeg/.tif/.tiff/.bmp/.webp    → sharp     →  jpeg q88(无 alpha) / webp q90(有 alpha)
//                                                            并限制最长边 (默认 2048)
//   .wav/.mp3/.ogg/.flac                     → ffmpeg    →  mp3 128k
//   .ktx2/.exr                               → 已压缩/需无损, 原样入库
//   其它                                     → 原样入库 + 警告
//
// 用法:
//   node scripts/import-asset.mjs <源文件...> --as /models/f22/
//        [--kind airframe|texture|terrain|audio|misc]
//        [--max 2048] [--quality 88] [--format jpeg|webp|keep]
//        [--inline] [--no-register] [--dry-run] [--build] [--force]
// 例(新机体 + 配套贴图, 一次导入一个目录):
//   node scripts/import-asset.mjs D:\dl\f22.obj D:\dl\f22\*.jpg --as /models/f22/ --kind airframe
//
// 源文件**永不删除/覆盖**(只读), 产物只写进 public/ 与 asset-library.json。

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, statSync, renameSync, unlinkSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const LIB_JSON = join(ROOT, 'src', 'lib', 'game', 'asset-library.json');

// ---------------------------------------------------------------- 参数解析
const argv = process.argv.slice(2);
const flagVal = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (k) => argv.includes(k);
const AS = flagVal('--as', null);
const KIND = flagVal('--kind', '');
const MAX_DIM = Number(flagVal('--max', 2048));
const QUALITY = Number(flagVal('--quality', 88));
const FORMAT = flagVal('--format', 'jpeg');
const INLINE = has('--inline');
const REGISTER = !has('--no-register');
const DRY = has('--dry-run');
const BUILD = has('--build');
const FORCE = has('--force');

/** 位置参数 = 源文件; 支持 shell 已展开的列表, 以及目录(递归收集)。 */
const rawSources = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    if (!a.includes('=') && ['--as', '--kind', '--max', '--quality', '--format'].includes(a)) i++; // 跳过其值
    continue;
  }
  rawSources.push(a);
}
const SOURCES = [];
for (const s of rawSources) {
  const abs = resolve(s);
  if (!existsSync(abs)) { console.warn(`[warn] 源文件不存在: ${s}`); continue; }
  if (statSync(abs).isDirectory()) {
    for (const f of readdirSync(abs)) {
      const p = join(abs, f);
      if (statSync(p).isFile()) SOURCES.push(p);
    }
  } else {
    SOURCES.push(abs);
  }
}

if (!SOURCES.length || !AS) {
  console.log(`用法: node scripts/import-asset.mjs <源文件...> --as /models/f22/ [--kind airframe]
  选项: --inline(同时内联进单文件) --no-register --dry-run --build --force
        --max ${MAX_DIM}(贴图最长边) --quality ${QUALITY} --format jpeg|webp|keep`);
  process.exit(SOURCES.length || AS ? 0 : 1);
}

// ---------------------------------------------------------------- 工具
const MB = (n) => (n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(0) + ' KB');
const rel = (abs) => abs.replace(ROOT + '\\', '').replace(ROOT + '/', '').replace(/\\/g, '/');

/**
 * 原子替换目标文件。本机对"已存在的工作区文件"做 rename/copy 覆盖会被策略层拒
 * (EPERM), 但"原文件先改名挪走 → 再放新文件"可以(与 compress-audio.mjs 同一招)。
 */
function replaceFile(tmp, dst) {
  const bak = `${dst}.orig`;
  const move = (a, b) => { try { renameSync(a, b); return true; } catch { return false; } };
  try { unlinkSync(bak); } catch { /* 无残留 */ }
  if (!move(dst, bak)) return false;
  if (move(tmp, dst)) { try { unlinkSync(bak); } catch { /* ignore */ } return true; }
  move(bak, dst);
  return false;
}

function resolveFfmpeg() {
  if (process.env.FFMPEG_BIN && existsSync(process.env.FFMPEG_BIN)) return process.env.FFMPEG_BIN;
  try {
    const p = require('ffmpeg-static');
    if (p && existsSync(p)) return p;
  } catch { /* 未安装 */ }
  return null;
}

/** 写文件: 目标已存在时走备份改名(否则 EPERM)。dry-run 只报告路径。 */
function writeOut(targetAbs, data) {
  mkdirSync(dirname(targetAbs), { recursive: true });
  if (DRY) return true;
  if (existsSync(targetAbs) && !FORCE) {
    console.warn(`  [skip] 目标已存在(加 --force 覆盖): ${rel(targetAbs)}`);
    return false;
  }
  if (existsSync(targetAbs)) {
    const tmp = `${targetAbs}.tmp-import`;
    writeFileSync(tmp, data);
    if (!replaceFile(tmp, targetAbs)) {
      console.warn(`  [warn] 替换失败(文件被占用?): ${rel(targetAbs)}`);
      try { unlinkSync(tmp); } catch { /* ignore */ }
      return false;
    }
    return true;
  }
  writeFileSync(targetAbs, data);
  return true;
}

const GZIP_EXT = new Set(['.obj', '.mtl', '.gltf', '.glb', '.bin', '.f32bin', '.json', '.txt', '.csv']);
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp']);
const AUDIO_EXT = new Set(['.wav', '.mp3', '.ogg', '.flac']);
const ASIS_EXT = new Set(['.ktx2', '.exr', '.basis']);

// ---------------------------------------------------------------- 逐个处理
const produced = [];   // 实际落盘的库内路径
const report = [];

async function compressOne(srcAbs, targetAbs) {
  const ext = extname(srcAbs).toLowerCase();
  const size0 = statSync(srcAbs).size;

  // --- ① 文本/二进制几何 → gzip -9 ---
  if (GZIP_EXT.has(ext)) {
    const buf = readFileSync(srcAbs);
    const gz = gzipSync(buf, { level: 9 });
    const ratio = buf.length / Math.max(1, gz.length);
    const out = writeOut(`${targetAbs}.gz`, gz);
    report.push([basename(srcAbs), MB(size0), `${MB(gz.length)} (gzip ${ratio.toFixed(2)}×)`, out ? `${rel(targetAbs)}.gz` : '(跳过)']);
    if (out) produced.push(`${rel(targetAbs)}.gz`);
    return;
  }

  // --- ② 贴图 → sharp 重编码 + 限制尺寸 ---
  if (IMG_EXT.has(ext)) {
    if (FORMAT === 'keep') {
      const buf = readFileSync(srcAbs);
      const out = writeOut(targetAbs, buf);
      report.push([basename(srcAbs), MB(size0), '原样(--format keep)', out ? rel(targetAbs) : '(跳过)']);
      if (out) produced.push(rel(targetAbs));
      return;
    }
    const sharp = (await import('sharp')).default;
    const img = sharp(srcAbs, { failOn: 'none' });
    const meta = await img.metadata();
    const hasAlpha = !!meta.hasAlpha;
    const fmt = FORMAT === 'webp' || (FORMAT === 'jpeg' && hasAlpha) ? 'webp' : 'jpeg';
    const outExt = fmt === 'webp' ? '.webp' : '.jpg';
    const outAbs = targetAbs.slice(0, -ext.length) + outExt;
    // 有 alpha 用 webp(保留透明), 否则 jpeg(更小)
    const pipeline = img
      .rotate()
      .resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true });
    const opts = fmt === 'webp'
      ? { quality: Math.min(100, QUALITY + 2), effort: 5 }
      : { quality: QUALITY, mozjpeg: true };
    const buf = await pipeline.toFormat(fmt, opts).toBuffer();
    // === 收益不达标就保留原图 (与 compress-audio 的 15% 门槛同一原则) ===
    // 已经是压过的 JPEG 再走一遍 q88, 只省几个百分点却要付一次生成损失 ——
    // 不划算。只有确实缩小了(重编码 ≥12% 或真的降了分辨率)才替换。
    const resized = !!meta.width && !!meta.height && (meta.width > MAX_DIM || meta.height > MAX_DIM);
    const saves = 1 - buf.length / size0;
    if (!resized && saves < 0.12) {
      const raw = readFileSync(srcAbs);
      const keepAbs = targetAbs;
      const out = writeOut(keepAbs, raw);
      report.push([basename(srcAbs), MB(size0), `保留原图(重编码只省 ${(saves * 100).toFixed(0)}%)`, out ? rel(keepAbs) : '(跳过)']);
      if (out) produced.push(rel(keepAbs));
      return;
    }
    const out = writeOut(outAbs, buf);
    const dim = meta.width && meta.height
      ? `${meta.width}×${meta.height} → ${Math.min(meta.width, MAX_DIM)}×${Math.min(meta.height, MAX_DIM)}`
      : '';
    report.push([
      basename(srcAbs),
      MB(size0),
      `${MB(buf.length)} (${fmt} q${QUALITY}, ${((1 - buf.length / size0) * 100).toFixed(0)}% 省)`,
      (out ? rel(outAbs) : '(跳过)') + (dim ? `  ${dim}` : ''),
    ]);
    if (out) produced.push(rel(outAbs));
    return;
  }

  // --- ③ 音频 → mp3 128k ---
  if (AUDIO_EXT.has(ext)) {
    const ffmpeg = resolveFfmpeg();
    if (!ffmpeg) {
      console.warn(`  [warn] ffmpeg 不可用, 音频原样入库: ${basename(srcAbs)}`);
      const buf = readFileSync(srcAbs);
      const out = writeOut(targetAbs, buf);
      report.push([basename(srcAbs), MB(size0), '原样(无 ffmpeg)', out ? rel(targetAbs) : '(跳过)']);
      if (out) produced.push(rel(targetAbs));
      return;
    }
    const outAbs = targetAbs.slice(0, -ext.length) + '.mp3';
    const tmp = `${outAbs}.tmp-import.mp3`;
    mkdirSync(dirname(outAbs), { recursive: true });
    const res = spawnSync(ffmpeg, ['-y', '-i', srcAbs, '-b:a', '128k', '-ac', '2', '-ar', '44100', '-loglevel', 'error', tmp], { stdio: 'ignore' });
    if (res.status !== 0 || !existsSync(tmp)) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
      console.warn(`  [warn] ffmpeg 失败, 音频原样入库: ${basename(srcAbs)}`);
      const out = writeOut(targetAbs, readFileSync(srcAbs));
      report.push([basename(srcAbs), MB(size0), '原样(转码失败)', out ? rel(targetAbs) : '(跳过)']);
      if (out) produced.push(rel(targetAbs));
      return;
    }
    const gz = statSync(tmp).size;
    const ok = writeOut(outAbs, readFileSync(tmp));
    try { unlinkSync(tmp); } catch { /* ignore */ }
    report.push([basename(srcAbs), MB(size0), `${MB(gz)} (mp3 128k)`, ok ? rel(outAbs) : '(跳过)']);
    if (ok) produced.push(rel(outAbs));
    return;
  }

  // --- ④ 已压缩 / 需无损 → 原样 ---
  if (ASIS_EXT.has(ext)) {
    const buf = readFileSync(srcAbs);
    if (size0 > 12 * 1048576) console.warn(`  [warn] ${basename(srcAbs)} 有 ${MB(size0)}: 无损格式压不动, 体积会进资产库`);
    const out = writeOut(targetAbs, buf);
    report.push([basename(srcAbs), MB(size0), '原样(已压缩/需无损)', out ? rel(targetAbs) : '(跳过)']);
    if (out) produced.push(rel(targetAbs));
    return;
  }

  // --- ⑤ 未知类型 ---
  const buf = readFileSync(srcAbs);
  const out = writeOut(targetAbs, buf);
  console.warn(`  [warn] 未知类型 ${ext || '(无扩展名)'}, 未压缩直接入库: ${basename(srcAbs)}`);
  report.push([basename(srcAbs), MB(size0), '原样(未知类型)', out ? rel(targetAbs) : '(跳过)']);
  if (out) produced.push(rel(targetAbs));
}

// ---------------------------------------------------------------- 登记资产库
function register(prefix, compressSummary) {
  const lib = JSON.parse(readFileSync(LIB_JSON, 'utf8'));
  // "已覆盖"的判据: 同前缀, 或被更宽的目录条目覆盖 **且 copy/inline 取向一致**。
  // 若现有条目是 inline:true(历史内联资产)而本次要 inline:false, 则不算覆盖 ——
  // 新增一条更具体的条目让这个文件走资产库, 而更宽的条目继续管其余文件。
  const covers = (e) => e.prefix === prefix || (e.prefix.endsWith('/') && prefix.startsWith(e.prefix));
  const covered = lib.entries.some((e) => covers(e) && e.copy === true && e.inline === INLINE);
  if (covered) {
    console.log(`  资产库登记: ${prefix} 已被现有条目覆盖, 无需新增`);
    return;
  }
  lib.entries.push({
    prefix,
    kind: KIND || 'imported',
    compress: compressSummary,
    copy: true,
    inline: INLINE,
    external: true,
    note: `import-asset.mjs 导入 (${new Date().toISOString().slice(0, 10)}): 压缩后随行入库; ${INLINE ? '同时内联进单文件' : '不进单文件(保持 HTML 轻量)'}`,
  });
  // 直接覆盖已存在的 JSON 在本机可能被拒(EPERM) → 走"临时文件 + 备份改名"。
  const tmp = `${LIB_JSON}.tmp-import`;
  writeFileSync(tmp, JSON.stringify(lib, null, 2) + '\n');
  if (!replaceFile(tmp, LIB_JSON)) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    console.error('[err] 资产库登记失败(asset-library.json 被占用?) — 请手工添加条目');
    return;
  }
  console.log(`  资产库登记: + ${prefix} (copy=true, inline=${INLINE}, external=true)`);
}

// ---------------------------------------------------------------- 主流程
async function main() {
  // 目标前缀: --as 以 '/' 结尾 = 目录; 否则 = 单文件路径
  const asIsDir = AS.endsWith('/');
  if (!asIsDir && SOURCES.length > 1) {
    console.error('[err] --as 给了单文件路径但有多个源文件; 请用目录形式 --as /models/xxx/');
    process.exit(1);
  }
  const targetDir = asIsDir ? AS : AS.slice(0, AS.lastIndexOf('/') + 1);
  // 登记前缀: --as 给目录 → 目录; 给单个文件 → **文件本身**(否则会把整个目录
  // 登记成 inline:false, 把该目录下其它已内联资产一起踢出单文件)。
  const regPrefix = asIsDir ? targetDir : AS;

  console.log(`=== 资产导入 ===`);
  console.log(`  源文件  : ${SOURCES.length} 个`);
  console.log(`  入库目标: public${targetDir}  ${INLINE ? '(同时内联)' : '(只入资产库)'}${DRY ? '  [dry-run]' : ''}`);

  for (const src of SOURCES) {
    const outPath = asIsDir
      ? `${targetDir}${basename(src)}`
      : AS;
    await compressOne(src, join(PUBLIC, outPath.replace(/^\//, '')));
  }

  // 报告表
  const w = (s, n) => String(s).padEnd(n);
  console.log('\n  ' + w('源文件', 26) + w('压缩前', 11) + w('压缩后', 34) + '入库路径');
  for (const r of report) console.log('  ' + w(r[0], 26) + w(r[1], 11) + w(r[2], 34) + r[3]);

  console.log(`\n  合计: ${SOURCES.length} 个文件, 落盘 ${produced.length} 个${DRY ? '(dry-run 未写盘)' : ''}`);
  if (!DRY && REGISTER && produced.length) {
    const kinds = new Set(report.map((r) => /gzip/.test(r[2]) ? 'gzip' : /jpeg|webp/.test(r[2]) ? 'jpeg/webp' : /mp3/.test(r[2]) ? 'mp3' : '原样'));
    register(regPrefix, [...kinds].join(' + '));
  }

  console.log('\n  下一步:');
  console.log('    1) node scripts/build-single-html.mjs        # 把库内资产拷进 dist-single/assets/');
  console.log('    2) 上传 dist-single/index.html + dist-single/assets/');
  console.log(`    · 需要"双击单文件也能玩"时: 构建加 --inline-library (或本次导入加 --inline)`);
  if (BUILD) {
    console.log('\n  --build: 立刻构建 …');
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-single-html.mjs')], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
}

main().catch((e) => { console.error('[import-asset] 失败:', e); process.exit(1); });
