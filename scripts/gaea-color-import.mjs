#!/usr/bin/env node
// === Gaea ColorExport(3ch float32 EXR,BGR 平面序)→ 8bit PNG 转换器 ===
// 用法:
//   node scripts/gaea-color-import.mjs <ColorExport.exr> <out.png> [--gamma 1] [--preview 小图.png]
// EXR scanline 布局:B 行(w×4B) + G 行 + R 行(平面式,非交错)。
// 统计 + gamma 选项,8bit sRGB PNG;默认 gamma=1(EXR 若已存 sRGB)。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { deflateSync } from 'node:zlib';

const [exrPath, outPng] = process.argv.slice(2);
const gArg = () => { const i = process.argv.indexOf('--gamma'); return i >= 0 ? Number(process.argv[i + 1]) : 1; };
const pvArg = () => { const i = process.argv.indexOf('--preview'); return i >= 0 ? process.argv[i + 1] : ''; };
const gamma = gArg();
if (!exrPath || !outPng) { console.log('用法: node scripts/gaea-color-import.mjs <exr> <out.png> [--gamma 1] [--preview 小图.png]'); process.exit(1); }

const b = readFileSync(exrPath);
const _td = new TextDecoder('utf-8');
const cstr = (u8, a, z) => _td.decode(u8.subarray(a, z));
const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
if (dv.getUint32(0, true) !== 0x01312f76) throw new Error('EXR magic 不符');

let off = 8;
const attrs = {};
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
const comp = b[attrs.compression.at];
if (comp !== 0) throw new Error(`压缩 ${comp} 不支持(仅 NONE)`);

// 数据起点:header 末尾特征扫描(y=0 && size=w*12 的 3ch float 行)
let start = -1;
for (let o = off; o + 16 < b.length; o++) {
  if (dv.getInt32(o, true) === 0 && dv.getUint32(o + 4, true) === w * 12) { start = o; break; }
}
if (start < 0) throw new Error('找不到 3ch float 数据块');

// 读出 B/G/R 三个平面,统计
const n = w * h;
const planes = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
let q = start;
for (let y = 0; y < h; y++) {
  const sz = dv.getUint32(q + 4, true); q += 8;
  for (let c = 0; c < 3; c++) {
    for (let x = 0; x < w; x++) planes[c][y * w + x] = dv.getFloat32(q + (c * w + x) * 4, true);
  }
  q += sz;
}
for (let c = 0; c < 3; c++) {
  let mn = Infinity, mx = -Infinity, sum = 0;
  for (let i = 0; i < n; i++) { const v = planes[c][i]; if (v < mn) mn = v; if (v > mx) mx = v; sum += v; }
  console.log(`ch${c}(${'BGR'[c]}) min=${mn.toFixed(4)} mean=${(sum / n).toFixed(4)} max=${mx.toFixed(4)}`);
}

// 像素级统计(合成后)便于判断是否需要 gamma
let gmn = Infinity, gmx = -Infinity;
for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) { const v = planes[c][i]; if (v < gmn) gmn = v; if (v > gmx) gmx = v; }
console.log(`整体 min=${gmn.toFixed(4)} max=${gmx.toFixed(4)} gamma=${gamma} → 若值域≈[0,1] 直出;若 >1 需归一`);

// 归一化(带 clip):按整体值域线性映射到 [0,1],低于/高于 1% 分位不收(色图应已 0..1)
const lo = 0, hi = 1;
const map = (v) => Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1)));

// PNG 8bit RGB 写入
const crc32 = (buf) => { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; };
const chk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, cr]); };
function writePng(path, pw, ph, px) {
  const stride = pw * 3;
  const raw = Buffer.alloc(ph * (stride + 1));
  for (let y = 0; y < ph; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < pw; x++) {
      const s = (y * pw + x) * 3, d = y * (stride + 1) + 1 + x * 3;
      raw[d] = px[s]; raw[d + 1] = px[s + 1]; raw[d + 2] = px[s + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(pw, 0); ihdr.writeUInt32BE(ph, 4); ihdr[8] = 8; ihdr[9] = 2;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chk('IHDR', ihdr), chk('IDAT', deflateSync(raw)), chk('IEND', Buffer.alloc(0)),
  ]));
}

// gamma 编码:8bit 值 = clamp(round((v)^(1/gamma) * 255)) —— EXR 若 linear,gamma=2.2 提亮;sRGB 存则 1
const enc = (v) => Math.max(0, Math.min(255, Math.round(Math.pow(map(v), 1 / gamma) * 255)));
const px = Buffer.alloc(n * 3);
for (let i = 0; i < n; i++) { px[i * 3] = enc(planes[2][i]); px[i * 3 + 1] = enc(planes[1][i]); px[i * 3 + 2] = enc(planes[0][i]); }
writePng(outPng, w, h, px);

const pv = pvArg();
if (pv) {
  const S = 480, sh = Math.round(S * h / w), small = Buffer.alloc(S * sh * 3);
  for (let y = 0; y < sh; y++) for (let x = 0; x < S; x++) {
    const sx = Math.floor((x + 0.5) / S * w), sy = Math.floor((y + 0.5) / sh * h);
    const d = (y * S + x) * 3, s2 = (sy * w + sx) * 3;
    small[d] = px[s2]; small[d + 1] = px[s2 + 1]; small[d + 2] = px[s2 + 2];
  }
  writePng(pv, S, sh, small);
}
console.log(`[ok] ${outPng} (${w}×${h})${pv ? ' 预览 ' + pv : ''}`);
