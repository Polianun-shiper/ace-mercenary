// Single-file build support + 分段加载 (per user request: 基础 HTML + 外部资产库).
//
// The standalone build (scripts/build-single-html.mjs) inlines the base
// assets (airframes, audio, KTX2) as base64 data URIs in a
// window.__ASSET_MANIFEST map keyed by the original "/models/..." path.
// Anything declared in asset-library.json with copy=true instead lives in the
// external library folder (window.__EXTERNAL_ASSETS.root, e.g. "assets/")
// served next to index.html over http — 新导入的机体/贴图/地形贴图一律走这条路
// (per user request: 压缩后放资产库), 单文件 HTML 只留引擎与 UI。
//
// assetUrl() resolution order:
//   1. inlined data URI (base single-file manifest hit)
//   2. external library URL (<root> + path, only when the page declares one)
//   3. original "/models/..." URL (dev server / public/ fallback)
import ASSET_LIBRARY from './asset-library.json';

export function assetUrl(path: string): string {
  if (typeof window !== 'undefined') {
    const m = (window as any).__ASSET_MANIFEST as Record<string, string> | undefined;
    if (m && m[path]) return m[path];
    // === 外部资产库 (per user request: 分段加载) ===
    // MiG-29 的模型/贴图命中时返回 <root>/models/... 的相对 URL。file://
    // 下浏览器禁止 fetch 外部文件 → 调用方需捕获失败并提示用 http 服务器。
    const ext = (window as any).__EXTERNAL_ASSETS as { root?: string } | undefined;
    if (ext && ext.root && isExternalAsset(path)) {
      return ext.root + path; // 'assets-mig29' + '/models/...' — 相对 http 解析
    }
  }
  return path;
}

/**
 * 判断路径是否属于外部资产库。
 *
 * === 名单来自单一真相源 (per user request: 新资产压缩后放资产库) ===
 * 前缀表写在 src/lib/game/asset-library.json, 构建脚本
 * (scripts/build-single-html.mjs, 决定"哪些文件拷进 <out>/assets/") 读的是
 * **同一个文件**。以前两边各写一份前缀列表, 漂移一次就会变成"URL 指向资产库
 * 但资产库里没这个文件"的 404 —— 现在结构上不可能再漂。
 */
export function isExternalAsset(path: string): boolean {
  for (const e of ASSET_LIBRARY.entries) {
    if (e.external && matchesPrefix(path, e.prefix)) return true;
  }
  return false;
}

/** 前缀匹配: 目录条目以 '/' 结尾时按目录匹配, 否则按"路径本身或其后紧跟分隔符"匹配。 */
function matchesPrefix(path: string, prefix: string): boolean {
  if (prefix.endsWith('/')) return path.startsWith(prefix);
  return path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '.');
}

/** 资产库随行目录名(构建时由 __ASSET_LIB 注入, 这里只作默认值)。 */
export const ASSET_LIB_DEFAULT_ROOT = ASSET_LIBRARY.assetRoot || 'assets';
