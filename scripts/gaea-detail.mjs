#!/usr/bin/env node
// === Gaea 宏观 + 程序细节增强(v2 路线;免费版 Gaea 无 tiled/8K) ===
// 用户诉求:飞机靠近不糊 → 需要比 LOD0(54m/格)更密的源数据,但 Gaea 免费版
// 锁单张 1024²。方案:把 Gaea 宏观 1024² 双线性放大到 2048²/4096²,再叠
// 加"确定性多尺度 fBm 细节"(米域连续、无缝、固定 seed)—— 宏观形态来自
// Gaea,高频岩石/雪坡细节由程序补,保证块间/尺度间无缝。
// 用法:
//   node scripts/gaea-detail.mjs <in.exr> <out.f32bin> [--res 2048] [--size 48600]
//       [--maxh 4320] [--seed 4242] [--rock 0.9] [--snow 0.55] [--outpng x.png]
// 输出:res×res f32bin(米制,双线性放大宏观 + 细节),打印统计。
import { readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname } from 'node:path';

// ---------- EXR 解码(同 gaea-import,float32 单通道 NONE) ----------
const _td = new TextDecoder('utf-8');
const cstr = (u8, a, b) => _td.decode(u8.subarray(a, b));
function exrDecode(_buf) {
  const buf = _buf instanceof Uint8Array ? _buf : new Uint8Array(_buf);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 8;
  const attrs = {};
  for (;;) {
    const nameEnd = buf.indexOf(0, off);
    if (nameEnd < 0) throw new Error('EXR header 损坏');
    const name = cstr(buf, off, nameEnd);
    off = nameEnd + 1;
    if (!name) break;
    const typeEnd = buf.indexOf(0, off);
    const type = cstr(buf, off, typeEnd);
    off = typeEnd + 1;
    const size = dv.getUint32(off, true);
    off += 4;
    attrs[name] = { at: off };
    off += size;
  }
  const dw = attrs.dataWindow.at;
  const w = dv.getInt32(dw + 8, true) - dv.getInt32(dw, true) + 1;
  const h = dv.getInt32(dw + 12, true) - dv.getInt32(dw + 4, true) + 1;
  const comp = buf[attrs.compression.at];
  if (comp !== 0) throw new Error(`EXR 压缩=${comp} 不支持`);
  let p = attrs.channels.at;
  const clEnd = p + attrs.channels.size;
  let chType = 2;
  while (p < clEnd) {
    const e = buf.indexOf(0, p);
    if (e < 0 || e >= clEnd) break;
    const nm = cstr(buf, p, e);
    p = e + 1;
    if (!nm) break;
    chType = dv.getInt32(p, true);
    p += 8;
  }
  const bpp = chType === 1 ? 2 : 4;
  let start = -1;
  for (let o = off; o + 16 < buf.length; o++) {
    if (dv.getInt32(o, true) === 0 && dv.getUint32(o + 4, true) === w * bpp) { start = o; break; }
  }
  if (start < 0) throw new Error('找不到扫描线起点');
  const out = new Float32Array(w * h);
  let q = start;
  const half = (hh) => { const s = (hh & 0x8000) >> 15, e = (hh & 0x7c00) >> 10, f = hh & 0x3ff; return e === 0 ? (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024) : (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024); };
  for (let y = 0; y < h; y++) {
    const sz = dv.getUint32(q + 4, true);
    q += 8;
    for (let x = 0; x < w; x++) {
      const v = chType === 1 ? half(dv.getUint16(q + x * 2, true)) : dv.getFloat32(q + x * 4, true);
      out[y * w + x] = v;
    }
    q += sz;
  }
  return { data: out, w, h };
}

// ---------- 确定性多尺度噪声(值噪声 fBm,米域连续、无缝) ----------
// 宏观放大只是平滑拉伸,真正补"细节感"靠 5 个倍频 fBm;种子固定,同参同果。
function makeNoise(seed) {
  // hash → [-1,1]
  const h = (x, y) => {
    let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed | 0, 1442695041);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    n ^= n >>> 16;
    return (n / 2147483647) * 2 - 1; // ≈[-1,1]
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  const v = (x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const sx = smooth(fx), sy = smooth(fy);
    const a = h(x0, y0), b = h(x0 + 1, y0), c = h(x0, y0 + 1), d = h(x0 + 1, y0 + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
  // fBm(归一,大概 ±1;octaves 从 w0 到 w0/2^(n-1))
  const fbm = (wx, wz, w0, n) => {
    let sum = 0, amp = 1, tot = 0, f = 1;
    for (let i = 0; i < n; i++) {
      sum += v(wx / (w0 / f), wz / (w0 / f)) * amp;
      tot += amp;
      amp *= 0.55;
      f *= 2;
    }
    return sum / tot; // ≈[-1,1]
  };
  return { fbm };
}

// ---------- 参数 ----------
function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const [inPath, outPath] = a;
  return {
    inPath, outPath,
    res: Number(get('--res', '2048')),
    size: Number(get('--size', '48600')),
    maxH: Number(get('--maxh', '4320')),
    seed: Number(get('--seed', '4242')),
    // 细节幅度(米):主倍频波长(米)与幅度比例;放大后 LOD0 27m/格能呈现
    // 波长 ≥ 两倍格距(≈54m)的细节。
    dAmp: Number(get('--damp', '0.12')),      // 细节总幅(相对 maxH 比例)
    w0: Number(get('--w0', '9000')),           // 最大细节波长(米)
    octaves: Number(get('--oct', '5')),
    outPng: get('--outpng', ''),
  };
}

function main() {
  const P = parseArgs();
  if (!P.inPath || !P.outPath) {
    console.log('用法: node scripts/gaea-detail.mjs <in.exr> <out.f32bin> [--res 2048] [--damp 0.12] [--w0 9000] [--outpng p.png]');
    process.exit(1);
  }
  const raw = readFileSync(P.inPath);
  const src = exrDecode(raw);
  console.log(`[macro] ${src.w}×${src.h} Gaea 宏观`);
  const { fbm } = makeNoise(P.seed);
  const N = P.res;
  const out = new Float32Array(N * N);
  // 宏观拉伸:src 0..1 → 0..maxH(把谷底拉到 0)
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < src.data.length; i++) { const v = src.data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = hi - lo || 1;
  const m = (v) => ((v - lo) / span) * P.maxH;
  // 细节采样步长(米/格)
  const cell = P.size / N;
  const detailAmp = P.maxH * P.dAmp;
  let dSum = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      // 宏观(双线性)
      const u = (x + 0.5) / N * (src.w - 1);
      const v = (y + 0.5) / N * (src.h - 1);
      const ix = Math.min(src.w - 2, Math.floor(u)), iy = Math.min(src.h - 2, Math.floor(v));
      const fx = u - ix, fy = v - iy;
      const d = src.data;
      const macro = d[iy * src.w + ix] * (1 - fx) * (1 - fy) + d[iy * src.w + ix + 1] * fx * (1 - fy)
        + d[(iy + 1) * src.w + ix] * (1 - fx) * fy + d[(iy + 1) * src.w + ix + 1] * fx * fy;
      const hBase = m(macro);
      // 细节:世界坐标(中心为 0)米
      const wx = (x + 0.5 - N / 2) * cell;
      const wz = (y + 0.5 - N / 2) * cell;
      // 多层 fBm:不同波长 → 山脊/岩/雪坡细节;幅度随地形坡度/高度弱化
      const n = fbm(wx, wz, P.w0, P.octaves);
      // 幅度包络:谷底细节少(冲积平原),中高海拔细节多;坡度区最强
      const ht = hBase / P.maxH; // 0..1
      const env = 0.08 + 0.92 * Math.min(1, ht * 2.2); // 低地≈0(被水/植被盖),山坡最强
      const detail = n * detailAmp * env;
      dSum += Math.abs(detail);
      out[y * N + x] = Math.max(0, hBase + detail);
    }
  }
  // 统计
  let olo = Infinity, ohi = -Infinity, osum = 0;
  for (let i = 0; i < out.length; i++) { const v = out[i]; if (v < olo) olo = v; if (v > ohi) ohi = v; osum += v; }
  console.log(`[out] ${N}×${N} f32bin · 宏观 0..${P.maxH}m + 细节 ±${(detailAmp).toFixed(0)}m 包络`);
  console.log(`[域] ${olo.toFixed(0)} .. ${ohi.toFixed(0)} m (mean ${(osum / out.length).toFixed(0)}m, 细节均值 |d|≈${(dSum / out.length).toFixed(1)}m)`);
  mkdirSync(dirname(P.outPath), { recursive: true });
  const buf = Buffer.alloc(out.length * 4);
  for (let i = 0; i < out.length; i++) buf.writeFloatLE(out[i], i * 4);
  writeFileSync(P.outPath, buf);
  // ASCII 预览
  const R = ' .:-=+*#%@';
  const PW = 72, PH = 22;
  for (let py = 0; py < PH; py++) {
    let line = '';
    for (let px = 0; px < PW; px++) {
      const sx = Math.min(N - 1, Math.floor(((px + 0.5) / PW) * N));
      const sy = Math.min(N - 1, Math.floor(((py + 0.5) / PH) * N));
      const t = (out[sy * N + sx] - olo) / (ohi - olo || 1);
      line += R[Math.min(R.length - 1, Math.floor(t * R.length))];
    }
    console.log('  ' + line);
  }
  // PNG 彩色(可选,hypsometric)
  if (P.outPng) {
    writePreviewPng(P.outPng, out, N, olo, ohi);
    console.log('预览 →', P.outPng);
  }
}

function writePreviewPng(path, data, N, lo, hi) {
  const P = 640, H = Math.round(P);
  const ramp = [[40, 60, 120], [70, 90, 140], [90, 130, 90], [110, 150, 80], [150, 140, 90], [170, 130, 100], [140, 120, 110], [190, 190, 195], [245, 248, 252]];
  const pick = (t) => { const f = Math.max(0, Math.min(0.999, t)) * (ramp.length - 1); const i = Math.floor(f), k = f - i; const a = ramp[i], b = ramp[Math.min(ramp.length - 1, i + 1)]; return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(P, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  const stride = P * 3;
  const raw = Buffer.alloc(H * (stride + 1));
  for (let y = 0; y < H; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < P; x++) {
      const sx = Math.min(N - 1, Math.floor((x + 0.5) / P * N));
      const sy = Math.min(N - 1, Math.floor((y + 0.5) / H * N));
      const t = (data[sy * N + sx] - lo) / (hi - lo || 1);
      const [r, g, b] = pick(t);
      const d = y * (stride + 1) + 1 + x * 3;
      raw[d] = r; raw[d + 1] = g; raw[d + 2] = b;
    }
  }
  const crc = (b) => { let c = ~0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; };
  const ch = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([l, td, cr]); };
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ch('IHDR', ihdr), ch('IDAT', deflateSync(raw)), ch('IEND', Buffer.alloc(0))]);
  writeFileSync(path, png);
}

main();
