// === Gaea 素材解码(仅编辑器打包;游戏运行期不 import 本文件) ===
//  1. 16-bit 灰度 PNG 高度图:自写最小 PNG 解析(pako inflate + 反滤波,
//     不引 pngjs 的 node 内建依赖)—— 输出 Float32 米制前的 0..1 归一值;
//  2. EXR 高度图:three EXRLoader(引擎已有同款半浮点读取先例);
//  3. 顶点色 OBJ:容错解析 `v x y z` / `v x y z r g b`(色 0..255 或 0..1)。
//  4. 样例生成器:程序化 ridge 高度 + 按风格着色的顶点(无文件即可跑通全流程)。
import { pxToWorld } from '../terrain-import/height-source';
import { DEFAULT_CANONICAL, type VertexColorPt } from '../terrain-import/classify';

// ---------------------------------------------------------------------------
// PNG-16 灰度解码(最小实现)
// ---------------------------------------------------------------------------
interface PngHead { width: number; height: number; bitDepth: number; colorType: number; interlace: number; }

function parsePngHead(bytes: Uint8Array): PngHead | null {
  // 返回 null 表示这不是 PNG;抛错 = PNG 但缺 IHDR/不支持
  if (bytes.length < 33 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = bytes[off] * 0x1000000 + bytes[off + 1] * 0x10000 + bytes[off + 2] * 0x100 + bytes[off + 3];
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    if (type === 'IHDR') {
      const d = bytes.subarray(off + 8, off + 8 + 13);
      return {
        width: d[0] * 0x1000000 + d[1] * 0x10000 + d[2] * 0x100 + d[3],
        height: d[4] * 0x1000000 + d[5] * 0x10000 + d[6] * 0x100 + d[7],
        bitDepth: d[8],
        colorType: d[9],
        interlace: d[12],
      };
    }
    off += 12 + len;
  }
  throw new Error('PNG 缺少 IHDR');
}

function unfilterRows(raw: Uint8Array, w: number, h: number, bpp: number): Uint8Array {
  const stride = w * bpp;
  const out = new Uint8Array(raw.length);
  let src = 0;
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const filter = raw[src++];
    const rowStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const rawV = raw[src++];
      const left = x >= bpp ? out[rowStart + x - bpp] : 0;
      const up = y > 0 ? out[rowStart - stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? out[rowStart - stride + x - bpp] : 0;
      let v = rawV;
      if (filter === 1) v += left;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (left + up) >> 1;
      else if (filter === 4) v += paeth(left, up, upLeft);
      out[rowStart + x] = v & 0xff;
    }
  }
  return out;
}

/**
 * 解码灰度 PNG(支持 8/16-bit,灰 1 通道)高度图 → {data: Float32 0..1, w, h, bitDepth}。
 * 颜色类型非灰度直接抛错(遮罩等彩色图走既有 canvas/Image 路径,8-bit 足够)。
 */
export async function decodePngGray16(file: File): Promise<{ data: Float32Array; w: number; h: number; bitDepth: number }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const head = parsePngHead(bytes);
  if (!head) throw new Error('不是 PNG 文件');
  if (head.interlace !== 0) throw new Error('不支持隔行(interlace)PNG,请导出非隔行');
  if (head.colorType !== 0) throw new Error('高度图需灰度 PNG(16-bit 或 8-bit);彩色遮罩请走 PNG8 通道');
  if (head.bitDepth !== 16 && head.bitDepth !== 8) throw new Error(`高度图位深 ${head.bitDepth} 不支持(需 8/16)`);
  const { inflate } = await import('pako');
  const idat: Uint8Array[] = [];
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = bytes[off] * 0x1000000 + bytes[off + 1] * 0x10000 + bytes[off + 2] * 0x100 + bytes[off + 3];
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    if (type === 'IDAT') idat.push(bytes.subarray(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len;
  }
  const concat = new Uint8Array(idat.reduce((s, u) => s + u.length, 0));
  let p = 0;
  for (const u of idat) { concat.set(u, p); p += u.length; }
  const raw = inflate(concat);
  const bpp = head.bitDepth / 8;
  const stride = head.width * bpp;
  if (raw.length < stride * head.height + head.height) throw new Error('PNG 数据长度异常');
  const px = unfilterRows(raw, head.width, head.height, bpp);
  const data = new Float32Array(head.width * head.height);
  const maxV = head.bitDepth === 16 ? 65535 : 255;
  for (let i = 0; i < data.length; i++) {
    const v = head.bitDepth === 16 ? px[i * 2] * 256 + px[i * 2 + 1] : px[i];
    data[i] = v / maxV;
  }
  return { data, w: head.width, h: head.height, bitDepth: head.bitDepth };
}

// ---------------------------------------------------------------------------
// EXR 高度图(半浮点 → float,单通道取 R;复用 three EXRLoader)
// ---------------------------------------------------------------------------
function halfToFloat(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 0x1f) return f ? NaN : s ? -Infinity : Infinity;
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

/** EXR 高度图(通常 R 通道) → Float32(米前 0..1 或原始值视文件;调用方负责缩放)。 */
export async function decodeExrHeight(file: File): Promise<{ data: Float32Array; w: number; h: number }> {
  const { EXRLoader } = await import('three/examples/jsm/loaders/EXRLoader.js');
  const url = URL.createObjectURL(file);
  try {
    const loader = new EXRLoader();
    const tex = await loader.loadAsync(url);
    const img = tex.image as { data: ArrayLike<number>; width?: number; height?: number };
    const raw = img.data;
    const w = tex.width ?? img.width ?? 0;
    const h = tex.height ?? img.height ?? 0;
    if (!w || !h || !raw) throw new Error('EXR 解码为空');
    const ch = Math.max(1, Math.floor(raw.length / (w * h))); // 通常 4(rgba)
    const data = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) data[i] = halfToFloat(raw[i * ch] as number);
    return { data, w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------------
// OBJ 顶点 + 顶点色容错解析
// ---------------------------------------------------------------------------
export function parseObjVertices(text: string): VertexColorPt[] {
  const pts: VertexColorPt[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line[0] !== 'v' || line[1] === 'n' || line[1] === 't') continue;
    const t = line.slice(1).trim();
    if (!t) continue;
    const n = t.split(/\s+/).map(Number);
    if (n.length < 3 || n.some((x) => Number.isNaN(x))) continue;
    // 常见:V X Y Z 或 V X Y Z R G B(0..1 或 0..255)
    let r = 0.7, g = 0.7, b = 0.7;
    if (n.length >= 6) {
      const rv = n[3], gv = n[4], bv = n[5];
      const scale = Math.max(rv, gv, bv) > 1.01 ? 1 / 255 : 1;
      r = Math.min(1, Math.max(0, rv * scale));
      g = Math.min(1, Math.max(0, gv * scale));
      b = Math.min(1, Math.max(0, bv * scale));
    } else {
      // 无顶点色:按高度给个灰阶?—— 由调用方决定是否丢弃;这里给中性岩灰。
      r = DEFAULT_CANONICAL[2][0]; g = DEFAULT_CANONICAL[2][1]; b = DEFAULT_CANONICAL[2][2];
    }
    pts.push({ x: n[0], z: n[2], r, g, b });
  }
  return pts;
}

// ---------------------------------------------------------------------------
// 样例生成器(无素材也能端到端跑通导入流程)
// ---------------------------------------------------------------------------
function hash2(x: number, z: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263) + Math.imul(seed | 0, 69069);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function smooth(v: number) { return v * v * (3 - 2 * v); }
function vnoise2(x: number, z: number, seed: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return smooth(fz) * (smooth(fx) * (d - c) + c) + (1 - smooth(fz)) * (smooth(fx) * (b - a) + a);
}
function ridge2(x: number, z: number, oct: number, seed: number): number {
  let v = 0, amp = 1, f = 1, sum = 0;
  for (let i = 0; i < oct; i++) {
    v += amp * (1 - Math.abs(2 * vnoise2(x * f, z * f, seed + i * 17) - 1));
    sum += amp; amp *= 0.5; f *= 2.1;
  }
  return v / sum;
}

export interface GaeaSamplePack {
  /** 米制高度(行主序;含 0 基平原与隆起) */
  heights: Float32Array;
  size: number;
  res: number;
  /** 模拟 OBJ 顶点(比高度格疏,带按高度带+噪声的顶点色) */
  verts: VertexColorPt[];
  maxHeight: number;
}

/** 程序化 ridge 山地样例:heights 512²(48.6km,~95m/px 粗略)+ 128² 顶点色。 */
export function makeGaeaSample(seed = 2026): GaeaSamplePack {
  const size = 48600;
  const res = 512;
  const amp = 2400;
  const base = 350;
  const heights = new Float32Array(res * res);
  const ns = res / size;
  for (let iy = 0; iy < res; iy++) {
    const z = pxToWorld(iy, size, res);
    for (let ix = 0; ix < res; ix++) {
      const x = pxToWorld(ix, size, res);
      let n = ridge2(x * ns * 1.1, z * ns * 1.1, 6, seed) * amp;
      n += (vnoise2(x * ns * 2.2, z * ns * 2.2, seed + 7) - 0.5) * 300;
      n = Math.max(0, n * 0.85);
      heights[iy * res + ix] = base + n;
    }
  }
  // 顶点色(128²):按高度带选规范色 + 邻域噪声 → 模拟 Gaea 顶点色成品
  const vr = 128;
  const verts: VertexColorPt[] = [];
  for (let iy = 0; iy < vr; iy++) {
    const z = pxToWorld(iy, size, vr);
    for (let ix = 0; ix < vr; ix++) {
      const x = pxToWorld(ix, size, vr);
      const h = heights[Math.floor(iy * (res / vr)) * res + Math.floor(ix * (res / vr))] ?? base;
      const f = Math.min(1, Math.max(0, (h - base) / (base + amp)));
      const jit = (vnoise2(x * 0.004, z * 0.004, seed + 3) - 0.5) * 0.16;
      const col = f < 0.12 ? DEFAULT_CANONICAL[0]
        : f < 0.55 ? DEFAULT_CANONICAL[1]
        : f < 0.86 ? DEFAULT_CANONICAL[2]
        : DEFAULT_CANONICAL[3];
      verts.push({
        x, z,
        r: Math.min(1, col[0] * (1 + jit)),
        g: Math.min(1, col[1] * (1 + jit * 0.7)),
        b: Math.min(1, col[2] * (1 + jit * 0.5)),
      });
    }
  }
  return { heights, size, res, verts, maxHeight: base + amp };
}
