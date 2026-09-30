// === externalHeight(tune 字段)→ HeightGrid 运行期加载 ===
// 加载顺序:bytesBase64(内嵌,单文件/file:// 最稳)→ url(外置相对路径,
// 经 __ASSET_MANIFEST dataURI 或 fetch)。
// kind 两种:
//   'f32bin'      —— 裸 Float32LE 网格(老格式)
//   'f32bin-gzip' —— 同一网格的 gzip。高度场非常平滑,gzip 压缩率 20× 以上:
//                    16MB → ~0.7MB,单文件内联省约 20MB base64。运行时先
//                    inflate 再 decodeF32Bin(零精度损失)。
import { inflate } from 'pako';
import { decodeF32Bin, gridMinMax, type HeightGrid } from './height-source';

export interface ExternalHeightTune {
  kind?: 'f32bin' | 'f32bin-gzip';
  size: number;
  resX: number;
  resY: number;
  maxHeight?: number;
  bytesBase64?: string;
  url?: string;
}

function b64ToArrayBuffer(b64: string): ArrayBuffer {
  // 分段 atob(大包不走字符串拼接)
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** 按 tune 描述取外部高度网格(失败抛错,调用方决定回退)。 */
export async function loadExternalHeight(eh: ExternalHeightTune): Promise<HeightGrid> {
  // gzip 判定:显式 kind,或 url 以 .gz 结尾(兼容只写 url 的 tune)
  const gz = eh.kind === 'f32bin-gzip'
    || (eh.kind === undefined && !!eh.url && /\.gz(\?|$)/i.test(eh.url));
  const decode = (buf: ArrayBuffer): Float32Array => {
    if (!gz) return decodeF32Bin(buf);
    const out = inflate(new Uint8Array(buf));
    return decodeF32Bin(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer);
  };
  let data: Float32Array;
  if (eh.bytesBase64) {
    data = decode(b64ToArrayBuffer(eh.bytesBase64));
  } else if (eh.url) {
    const manifest = (typeof window !== 'undefined')
      ? (window as unknown as { __ASSET_MANIFEST?: Record<string, string> }).__ASSET_MANIFEST?.[eh.url]
      : undefined;
    const res = await fetch(manifest ?? eh.url);
    if (!res.ok) throw new Error(`external height fetch failed: ${eh.url}`);
    data = decode(await res.arrayBuffer());
  } else {
    throw new Error('externalHeight: 缺少 bytesBase64/url');
  }
  const expect = eh.resX * eh.resY;
  if (data.length !== expect) throw new Error(`externalHeight 尺寸不符 ${data.length} vs ${expect}`);
  return { data, size: eh.size, resX: eh.resX, resY: eh.resY, maxHeight: eh.maxHeight ?? gridMinMax(data).max };
}
