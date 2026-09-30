#!/usr/bin/env node
// scripts/blender-watch.mjs
//
// Blender → 游戏 的**实时链路**。把 Blender 当编辑器用时, 这是省时间的那一环:
// 在 Blender 里改完 → 重跑 60_export.py → 本脚本把新 GLB 推进 public/ →
// 浏览器刷新就能看到, 不用重新构建单文件(那要几分钟)。
//
// 为什么直接拷**未压缩**的 GLB 进 public/:
//   glb-asset.ts 的 fetchBinaryAsset 会先试 `<path>.gz`, 失败再回退原始路径。
//   开发期放原始 GLB 就不用等 gzip, 也便于直接用浏览器 DevTools 看。
//   正式入库仍然走 scripts/blender-import.mjs(它才做压缩 + 登记)。
//
// 用法:
//   node scripts/blender-watch.mjs              # 监视并同步到 public/
//   node scripts/blender-watch.mjs --register   # 变更时同时跑 blender-import.mjs
//
// 配合 Blender 侧: 每次导出后本脚本自动同步。想一键化就在 Blender 里存一个
// 导出预设, 或直接反复执行:
//   blender --background --python blender/hangar/60_export.py

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync, watchFile } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flagVal = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (k) => argv.includes(k);

const SRC = flagVal('--src', join(ROOT, 'blender', 'hangar', 'out', 'export', 'hangar.glb'));
const NAME = flagVal('--name', 'hangar');
const REGISTER = has('--register');
const DEST_DIR = join(ROOT, 'public', 'models', NAME);
const DEST = join(DEST_DIR, 'hangar.glb');

let lastSize = -1;
let lastSync = 0;

function sync(reason) {
  if (!existsSync(SRC)) return;
  const size = statSync(SRC).size;
  // Exports land in several writes; ignore a repeat of the same size and
  // anything inside the debounce window, or the copy races the writer.
  const now = Date.now();
  if (size === lastSize || now - lastSync < 800) return;
  lastSize = size;
  lastSync = now;

  mkdirSync(DEST_DIR, { recursive: true });
  try {
    copyFileSync(SRC, DEST);
  } catch (e) {
    console.warn(`[blender-watch] 拷贝失败(可能正在写入, 稍后会自动重试): ${String(e)}`);
    lastSize = -1;
    return;
  }
  console.log(`[blender-watch] ${reason} → public/models/${NAME}/hangar.glb  ` +
    `${(size / 1048576).toFixed(2)} MB  —— 刷新浏览器`);

  if (REGISTER) {
    const res = spawnSync(process.execPath,
      [join(ROOT, 'scripts', 'blender-import.mjs'), '--name', NAME],
      { stdio: 'inherit', cwd: ROOT });
    if (res.status !== 0) console.warn('[blender-watch] blender-import.mjs 失败');
  }
}

function main() {
  if (!existsSync(SRC)) {
    console.log(`[blender-watch] 还没有 ${SRC}`);
    console.log('[blender-watch] 等它出现即可。先跑一次:');
    console.log('  blender --background --python blender/hangar/60_export.py');
  } else {
    sync('初次同步');
  }

  console.log(`[blender-watch] 监视中: ${SRC}`);
  console.log(`[blender-watch] 目标:     ${DEST}`);
  if (REGISTER) console.log('[blender-watch] 变更时会同时登记进 asset-library.json');
  console.log('[blender-watch] Ctrl+C 退出');

  // watchFile(polling) 而不是 watch(): Windows 上对"编辑器原子保存"这类
  // 改名/替换式写入, fs.watch 经常漏事件, 轮询虽然笨但不会漏。
  watchFile(SRC, { interval: 1000 }, () => sync('检测到变更'));
}

main();
