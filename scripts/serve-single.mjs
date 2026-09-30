#!/usr/bin/env node
// scripts/serve-single.mjs
//
// Static server for the single-file build + its external asset library
// (per user request: 分段加载).
//   - serves dist-single/index.html at /
//   - serves the external library dist-single/assets-mig29/* (MiG-29 OBJ +
//     textures) — fetched on demand only when the player picks MiG-29
//
// Why a server at all: browsers forbid fetch() of external files from a
// file:// page (CORS/opaque origin), so the external library must be served
// over http. Base aircraft (F-16/B-52/…) are fully inlined and play fine
// either way.
//
// Usage: node scripts/serve-single.mjs   → http://127.0.0.1:8899

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8899);
const DIST = join(ROOT, 'dist-single');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.obj': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.mtl': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ktx2': 'application/octet-stream',
  '.wasm': 'application/wasm',
};

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  // 游戏产物在 dist-single/(要上传的那份); 编辑器在**平级**的 dist-editor/ 里,
  // 所以 /editor/* 前缀映射到那边(见 §91)。
  const editorMatch = /^\/editor\/(.*)$/.exec(urlPath);
  const distRoot = editorMatch ? join(ROOT, 'dist-editor') : DIST;
  const distRel = editorMatch ? (editorMatch[1] || 'index.html') : (urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, ''));
  const file = join(distRoot, distRel);

  if (!existsSync(file) || !file.startsWith(distRoot)) {
    // === 未知路径一律 404, 不再"SPA 兜底返回 index.html" (per fix) ===
    // 兜底会把 /favicon.ico 与 /relay-worker.js 当 SPA 路由, 各返回一份 90MB 的
    // index.html —— 实测一次页面加载因此多下 ~180MB, 加载被拖到几十秒, 而且和游戏
    // 本身无关。单文件产物是自包含的, 不需要 SPA 兜底; 那两条请求立刻失败即可
    // (页面里对它们的失败本来就是忽略的)。
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  const data = readFileSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': data.length,
    // No-cache — the build is regenerated often and files are large.
    'Cache-Control': 'no-store',
  });
  res.end(data);
});

server.listen(PORT, () => {
  console.log(`serving dist-single + assets-mig29/ on http://127.0.0.1:${PORT}/`);
});
