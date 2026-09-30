#!/usr/bin/env node
// === Gaea 高度 EXR → tangent-space 法线贴图 + 灰度层 PNG 烘焙 ===
// 用法:
//   node scripts/gaea-normal-import.mjs <001目录> <输出目录>
// 输入目录需含:HeightmapExport.exr(高度)、SlopeExport.exr、CurvatureExport.exr、
//   MaskAdjustExport.exr、Snow_Snow.tif(Snow 端口标量,仅部署备用)
// 输出:
//   normal.png       —— 由高度场 3×3 差分烘焙,切线空间(RGB=XYZ*0.5+0.5,高=蓝)
//   slope.png / curvature.png / mask-adjust.png —— 灰度层(8bit,备用扩展)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { deflateSync } from 'node:zlib';

const [inDir, outDir] = process.argv.slice(2);
if (!inDir || !outDir) { console.log('用法: node scripts/gaea-normal-import.mjs <001目录> <输出目录>'); process.exit(1); }

const _td = new TextDecoder('utf-8');
const cstr = (u8, a, z) => _td.decode(u8.subarray(a, z));

// ---- EXR 单通道(Y, float32/half,NONE 压缩)解码 ----
function exrGray(file) {
  const b = readFileSync(file);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0, true) !== 0x01312f76) throw new Error('EXR magic 不符');
  let off = 8; const attrs = {};
  for (;;) {
    const ne = b.indexOf(0, off); if (ne < 0) break;
    const name = cstr(b, off, ne); off = ne + 1; if (!name) break;
    const te = b.indexOf(0, off); const type = cstr(b, off, te); off = te + 1;
    const size = dv.getUint32(off, true); off += 4;
    attrs[name] = { at: off }; off += size;
  }
  const dw = attrs.dataWindow.at;
  const w = dv.getInt32(dw + 8, true) - dv.getInt32(dw, true) + 1;
  const h = dv.getInt32(dw + 12, true) - dv.getInt32(dw + 4, true) + 1;
  const chans = [];
  let p = attrs.channels.at; const clEnd = p + attrs.channels.size;
  while (p < clEnd) {
    const e = b.indexOf(0, p); if (e < 0 || e >= clEnd) break;
    const nm = cstr(b, p, e); p = e + 1; if (!nm) break;
    chans.push({ name: nm, type: dv.getInt32(p, true) }); p += 8;
  }
  const ch = chans[0] ?? { name: 'Y', type: 2 };
  if (ch.type !== 1 && ch.type !== 2) throw new Error('非 float/half 通道');
  const bpp = ch.type === 1 ? 2 : 4;
  const half = (hh) => { const s = (hh & 0x8000) >> 15, e = (hh & 0x7c00) >> 10, f = hh & 0x3ff;
    if (e === 0) return (s ? -1 : 1) * 2 ** -14 * (f / 1024);
    if (e === 31) return f ? NaN : (s ? -Infinity : Infinity);
    return (s ? -1 : 1) * 2 ** (e - 15) * (1 + f / 1024); };
  let start = -1;
  for (let o = off; o + 16 < b.length; o++) {
    if (dv.getInt32(o, true) === 0 && dv.getUint32(o + 4, true) === w * bpp) { start = o; break; }
  }
  if (start < 0) throw new Error('找不到数据块');
  const out = new Float32Array(w * h);
  let q = start;
  for (let y = 0; y < h; y++) {
    const sz = dv.getUint32(q + 4, true); q += 8;
    for (let x = 0; x < w; x++) out[y * w + x] = ch.type === 1 ? half(dv.getUint16(q + x * 2, true)) : dv.getFloat32(q + x * 4, true);
    q += sz;
  }
  return { data: out, w, h };
}

// ---- 32-bit float 单通道 TIFF 解码(无压缩) ----
function tifGray(file) {
  const b = readFileSync(file);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (cstr(b, 0, 2) !== 'II') throw new Error('仅支持 little-endian TIFF');
  const u16 = (o) => dv.getUint16(o, true), u32 = (o) => dv.getUint32(o, true);
  const ifd = u32(4); const n = u16(ifd); const tag = {};
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12; const t = u16(e), ty = u16(e + 2), cnt = u32(e + 4);
    if (ty === 3 && cnt === 1) tag[t] = u16(e + 8);
    else if (ty === 4 && cnt === 1) tag[t] = u32(e + 8);
  }
  const w = tag[256], h = tag[257], bits = tag[258], comp = tag[259];
  if (comp !== 1) throw new Error('仅支持无压缩 TIFF');
  const stride = Math.ceil(w * bits / 8);
  const rowOff = tag[273]; // strip offsets(单 strip 或多 strip:取逐行估算)
  const rowsPerStrip = tag[278] ?? h;
  const out = new Float32Array(w * h);
  let base = typeof rowOff === 'number' ? rowOff : 8;
  for (let y = 0; y < h; y++) {
    const strip = Math.floor(y / rowsPerStrip);
    const off = (typeof rowOff === 'number' ? rowOff : rowOff[strip]) + (y % rowsPerStrip) * stride;
    for (let x = 0; x < w; x++) {
      const v = bits === 32 ? dv.getFloat32(off + x * 4, true)
        : bits === 16 ? dv.getUint16(off + x * 2, true) / 65535 : dv.getUint8(off + x) / 255;
      out[y * w + x] = v;
    }
  }
  return { data: out, w, h };
}

function loadGray(path) {
  const ext = extname(path).toLowerCase();
  return ext === '.exr' ? exrGray(path) : tifGray(path);
}

// ---- PNG 8bit 写入 ----
function writePng8(path, w, h, px) {
  const crc32 = (buf) => { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; };
  const chk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, cr]); };
  const stride = w * 3;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3, d = y * (stride + 1) + 1 + x * 3;
      raw[d] = px[s]; raw[d + 1] = px[s + 1]; raw[d + 2] = px[s + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chk('IHDR', ihdr), chk('IDAT', deflateSync(raw)), chk('IEND', Buffer.alloc(0)),
  ]));
}
function writeGrayPng(path, img, lo, hi) {
  const px = Buffer.alloc(img.w * img.h * 3);
  const span = (hi - lo) || 1;
  for (let i = 0; i < img.w * img.h; i++) {
    const g = Math.max(0, Math.min(255, Math.round(((img.data[i] - lo) / span) * 255)));
    px[i * 3] = px[i * 3 + 1] = px[i * 3 + 2] = g;
  }
  writePng8(path, img.w, img.h, px);
}

// ---- 主流程 ----
const H = loadGray(join(inDir, 'HeightmapExport.exr'));
const { w, h, data } = H;
console.log(`高度场 ${w}×${h}`);
// 值域(高度 EXR 是 0..1 归一或任意尺度;法线只需要"纹素间相对差/纹素宽"比例)
let lo = Infinity, hi = -Infinity;
for (let i = 0; i < data.length; i++) { if (data[i] < lo) lo = data[i]; if (data[i] > hi) hi = data[i]; }
const span = hi - lo || 1;
// 世界跨度匹配:纹素间距 = size/res(世界 48600 语义仅影响整体陡度系数)
const SIZE = 48600;
const texelWorld = SIZE / w;
const px = Buffer.alloc(w * h * 3);
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const x0 = data[y * w + Math.max(0, x - 1)], x1 = data[y * w + Math.min(w - 1, x + 1)];
    const y0 = data[Math.max(0, y - 1) * w + x], y1 = data[Math.min(h - 1, y + 1) * w + x];
    const dx = (x1 - x0) / (2 * texelWorld * span);   // 归一 Δh / 米 → 斜率
    const dz = (y1 - y0) / (2 * texelWorld * span);
    // 切线空间:采样局部 +Y = 行方向朝下?取世界 +Z 沿行:法线 = normalize(-dx*S,-dz*S,1)
    const s = 1.6; // 高度缩放系数(观感调参;1.6≈ 陡坡显著)
    let nx = -dx * s, ny = -dz * s, nz = 1;
    const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx *= inv; ny *= inv; nz *= inv;
    const o = (y * w + x) * 3;
    px[o] = Math.round((nx * 0.5 + 0.5) * 255);
    px[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
    px[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
  }
}
const normalOut = join(outDir, 'normal.png');
writePng8(normalOut, w, h, px);
console.log(`[ok] 法线贴图 ${normalOut} (tangent-space,±1.6×高度系数)`);

// 灰度层(备用部署):slope / curvature / mask-adjust / snow-snow / 侵蚀遮罩
const grayJobs = [
  ['SlopeExport.exr', 'slope.png'],
  ['CurvatureExport.exr', 'curvature.png'],
  ['MaskAdjustExport.exr', 'mask-adjust.png'],
  ['Snow_Snow.tif', 'snow-snow.png'],
  ['WearExport.exr', 'wear.png'],
  ['DepositsExport.exr', 'deposits.png'],
  ['FlowExport.exr', 'flow.png'],
];
for (const [src, dst] of grayJobs) {
  try {
    const img = loadGray(join(inDir, src));
    let gLo = Infinity, gHi = -Infinity;
    for (let i = 0; i < img.data.length; i++) { const v = img.data[i]; if (v < gLo) gLo = v; if (v > gHi) gHi = v; }
    // Slope/Curvature/遮罩按各自 min..max 归一;Snow 雪掩码 0..1
    writeGrayPng(join(outDir, dst), img, dst.startsWith('snow') ? 0 : gLo, dst.startsWith('snow') ? 1 : gHi);
    console.log(`[ok] 灰度层 ${dst} (${gLo.toFixed(3)}..${gHi.toFixed(3)} → 0..255)`);
  } catch (e) {
    console.warn(`[skip] ${src} 未解析(${e.message})`);
  }
}
console.log('部署: 将 normal.png 拷到 public/custom-maps/custom/ 并在 terrain-tune.json 加 material.normalMap');
