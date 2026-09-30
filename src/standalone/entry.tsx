// Standalone single-file build entry (scripts/build-single-html.mjs).
//
// Replaces the Next.js shell (layout + dynamic page) with a plain
// ReactDOM root. The game is 100% client-side, so nothing else is needed.
// Fonts: Geist (next/font) is replaced by a system font stack injected in
// the built HTML's CSS override.
import { createRoot } from 'react-dom/client';
import { GameApp } from '@/components/game/GameApp';

// === 资产库接线 (per user request: 恢复 HTML + 资产库互相连接的结构) ===
// 单文件把模型/贴图全部 base64 内联 → 96MB, 且每次改动都要整包重传, 已被判定
// 不可持续。改为"HTML 留引擎与 UI, 大资产放随行资产库":
//   dist-single/index.html        ← 引擎 + UI
//   dist-single/assets/models/... ← 模型与贴图(构建时从 public/ 拷出)
// assetUrl() 对命中 isExternalAsset() 的路径返回 `assets` + 原路径。
//
// ⚠ 只在**独立产物**里设: dev(next dev / serve-test)下资产来自 public/, 若也指向
// assets/ 会 404(实测 mig29 加载失败、报错 60 条)。构建脚本会给产物注入
// window.__ASSET_LIB='assets' 作标记, 这里据此判断。
if (typeof window !== 'undefined' && (window as unknown as { __ASSET_LIB?: string }).__ASSET_LIB) {
  (window as unknown as { __EXTERNAL_ASSETS?: { root: string } }).__EXTERNAL_ASSETS = {
    root: (window as unknown as { __ASSET_LIB: string }).__ASSET_LIB,
  };
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element not found');


createRoot(rootEl).render(<GameApp />);
