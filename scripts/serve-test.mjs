#!/usr/bin/env node
// scripts/serve-test.mjs
//
// Dev/test static server for the standalone bundle:
//   - serves dist-test/index.html at /
//   - serves repo public/ assets (/models/*, /audio/*, /textures/*, …)
//
// Usage: node scripts/serve-test.mjs   → http://127.0.0.1:8898

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8898);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.obj': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  // Repo public assets — everything outside the page itself.
  // '/config/' = 编辑器导出的 tune JSON(terrain/fx)也直接走仓库 public/,
  // 否则 SPA 回退会拿 index.html 当 JSON → 静默失效。
  const publicPrefixes = ['/models/', '/audio/', '/textures/', '/draco/', '/basis/', '/config/', '/custom-maps/', '/logo.svg', '/robots.txt'];
  const isPublic = publicPrefixes.some((p) => urlPath.startsWith(p));

  // Prefer an actual file in dist-test/, then fall back to index.html
  // (single-page app). Public assets come from the repo's public/ dir.
  //
  // 编辑器产物**不在 dist-test 里**(是平级的 dist-editor-test/), 所以 /editor/*
  // 这段前缀映射到那个目录 —— 这样「编辑器在 dist-single 外面」与「一条命令就能开
  // 编辑器」两件事同时成立。见 §91。
  const editorMatch = /^\/editor\/(.*)$/.exec(urlPath);
  const distRoot = editorMatch ? 'dist-editor-test' : 'dist-test';
  const distRel = editorMatch ? editorMatch[1] : (urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, ''));
  const inDist = join(ROOT, distRoot, distRel || 'index.html');
  const file = isPublic
    ? join(ROOT, 'public', urlPath.replace(/^\//, ''))
    : existsSync(inDist)
      ? inDist
      : join(ROOT, 'dist-test', 'index.html');

  if (!existsSync(file)) {
    res.writeHead(404);
    res.end('404');
    return;
  }
  // ⚠ 目录请求不许打崩服务 (实测: 请求 /custom-maps/ 、/textures/ktx2/terrain 这类
  //   "以 / 结尾的资产库前缀"时, existsSync 对目录返回 true ⇒ readFileSync 抛 EISDIR
  //   ⇒ 未捕获 = **整个静态服务进程退出** ⇒ 页面后续所有资产(地形高度/贴图/港口)全部
  //   拿不到, 表现就是"只有海面/一片蓝"。这里把读失败一律降级成 404 并打印路径。
  let data;
  try {
    data = readFileSync(file);
  } catch (e) {
    console.warn(`[serve-test] 404: ${urlPath} (${String((e && e.code) || e).slice(0, 24)})`);
    res.writeHead(404);
    res.end('404');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': data.length,
    // === No-cache (per user request: 排查旧包缓存问题) ===
    // The game is rebuilt frequently and the single-file bundle is large —
    // browsers would otherwise heuristically cache an OLD index.html and
    // the player tests stale code. Force revalidation every load.
    'Cache-Control': 'no-store',
  });
  res.end(data);
});

server.listen(PORT, () => {
  console.log(`serving dist-test + public/ on http://127.0.0.1:${PORT}/`);
});
