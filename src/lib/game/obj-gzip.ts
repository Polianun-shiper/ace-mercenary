// === 大型文本资产 gzip 传输 (per user request: 单文件体积 ≤100MB) ===
//
// 单文件版把资产以 base64 data URI 内联进 __ASSET_MANIFEST。War Thunder 导出
// 的 OBJ 是纯 ASCII 顶点/面文本,gzip -9 压缩率 5.5× 左右(F-16C 36.2MiB →
// 6.5MiB,MiG-29 37.2MiB → 6.8MiB)—— 直接内联原始文本要 48MiB base64,内联
// .gz 只要 8.7MiB。构建期由 scripts/gzip-obj-assets.mjs 生成 <name>.obj.gz。
//
// 运行时:先取 <path>.gz,用 pako.inflate 解压(与 terrain-import/loader.ts 的
// 'f32bin-gzip' 同一条路,pako 已随项目依赖),再交给 OBJLoader.parse。
// 解压后文本与原始 OBJ **逐字节一致**,零精度损失。
//
// 兼容性:
//   - .gz 不存在(老的单文件包 / 尚未生成) → 回退取原始路径。
//   - 静态服务器对 .gz 设了 Content-Encoding: gzip 时浏览器已自动解压 →
//     魔数(1f 8b)判定失败 → 直接按 UTF-8 文本使用。两种服务器行为都正确。

import { inflate } from 'pako';
import { assetUrl } from './asset-url';
import { fetchAssetBuffer, fetchAssetText } from './fetch-asset';

/** 取文本型大资产(如 OBJ):优先 `<path>.gz` 并 inflate,失败回退原始路径。
 *  ⚠ 走 fetchAssetBuffer(XHR)而不是 fetch():浏览器在 **file:// 下禁止 fetch**,
 *  双击单文件时 fetch 直接 "TypeError: Failed to fetch" → 模型回退程序化低模。
 *  XHR 对**同目录文件**是放行的, 所以三种环境(单文件 data URI / file:// / http)
 *  用同一条代码路径, 不需要按协议分支。 */
export async function fetchTextAsset(path: string): Promise<string> {
  try {
    const bytes = new Uint8Array(await fetchAssetBuffer(assetUrl(path + '.gz')));
    // gzip 魔数 —— 服务器未自动解压时才是真 gzip 数据。
    if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      return new TextDecoder().decode(inflate(bytes));
    }
    // 已被 Content-Encoding 解压 → 字节即原文(部分静态服务器行为)。
    return new TextDecoder().decode(bytes);
  } catch {
    // .gz 缺失/读取失败 → 走下面的原始路径
  }
  return fetchAssetText(assetUrl(path));
}

/** 二进制大资产(天空盒 EXR 等): 优先 `<path>.gz` 并 inflate, 失败回退原始路径。
 *  与 fetchTextAsset 同一套策略;单文件里 EXR 的 PIZ 数据再套一层 gzip -9
 *  仍省 1.2MiB(base64 省 1.6MiB),而解压后与原始 EXR **逐字节一致** ⇒ 零画质
 *  损失(区别于"降到 2K"这类降级)。
 *  ⚠ 调用方要自己判魔数: 这条路可能返回"服务器已解压的原文"、也可能返回
 *  SPA 兜底 HTML(旧部署上 <path>.gz 不存在时), 不能盲信。 */
export async function fetchBinaryAssetMaybeGz(path: string): Promise<ArrayBuffer> {
  try {
    const buf = await fetchAssetBuffer(assetUrl(path + '.gz'));
    const bytes = new Uint8Array(buf);
    if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      return inflate(bytes).buffer as ArrayBuffer;
    }
    return buf; // 已解压原文 / 非 gzip 内容 —— 交给调用方的魔数校验
  } catch {
    // .gz 缺失 → 原始路径
  }
  return fetchAssetBuffer(assetUrl(path));
}
