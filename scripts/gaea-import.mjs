#!/usr/bin/env node
// === Gaea 产物 → 游戏 custom 槽导入器(v1) ===
// 用法:
//   node scripts/gaea-import.mjs preview  <高度图|目录> [--out out.png] [--name slot]
//   node scripts/gaea-import.mjs import   <高度图|目录> [--size 48600] [--maxh 4320] [--slot custom]
//
// 支持输入:
//   - 单个 EXR(无压缩 float32 单通道 Y, 或半浮点) 或 PNG16 灰度
//   - 目录:自动把 *_y\d+_x\d+.* 分块按网格拼接(Gaea 超大场景多分块产物)
// 流程:
//   preview:只解码+统计+渲染预览 PNG,不碰任何配置(导入前确认关)
//   import :解码 → 归一拉伸到 [0..maxHeight] → public/custom-maps/<slot>/heights.f32bin
//            → 合并 maps.<slot>.terrain.externalHeight 到 public/config/terrain-tune.json
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflate as deflateSync, inflate as inflateSync } from 'pako';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const _td = new TextDecoder('utf-8');
const cstr = (u8, a, b) => _td.decode(u8.subarray(a, b));

// ---------------------------------------------------------------------------
// EXR 解码(仅 NONE 压缩;float32 或 half 单通道 → Float32Array 0..1 归一格)
// ---------------------------------------------------------------------------
function exrDecode(_buf) {
  const buf = _buf instanceof Uint8Array ? _buf : new Uint8Array(_buf);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x01312f76) throw new Error('EXR magic 不符');
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
    attrs[name] = { type, size, at: off };
    off += size;
  }
  const dw = attrs.dataWindow.at;
  const x0 = dv.getInt32(dw, true), y0 = dv.getInt32(dw + 4, true);
  const x1 = dv.getInt32(dw + 8, true), y1 = dv.getInt32(dw + 12, true);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const comp = buf[attrs.compression.at];
  if (comp !== 0) throw new Error(`EXR 压缩=${comp} 暂不支持(仅 NONE)`);
  // channels(chlist): 记录 {name,type:0=UINT,1=HALF,2=FLOAT}
  const chans = [];
  let p = attrs.channels.at;
  const clEnd = p + attrs.channels.size;
  while (p < clEnd) {
    const e = buf.indexOf(0, p);
    if (e < 0 || e >= clEnd) break;
    const nm = cstr(buf, p, e);
    p = e + 1;
    if (!nm) break;
    const pixType = dv.getInt32(p, true);
    p += 8; // pixelType(4) + pLinear(1) + reserved(3)
    chans.push({ name: nm, type: pixType });
  }
  const ch = chans.length ? chans[0] : { name: 'Y', type: 2 };
  if (ch.type !== 1 && ch.type !== 2) throw new Error(`不支持 EXR 通道类型 ${ch.type}`);
  const bpp = ch.type === 1 ? 2 : 4;
  // 定位第一个 chunk:header 后可能有 8B/chunk 的 offset 表,直接特征扫描
  let start = -1;
  for (let o = off; o + 16 < buf.length; o++) {
    if (dv.getInt32(o, true) === 0 && dv.getUint32(o + 4, true) === w * bpp) {
      start = o;
      break;
    }
  }
  if (start < 0) throw new Error('EXR 找不到扫描线起点');
  const out = new Float32Array(w * h);
  let q = start;
  for (let y = 0; y < h; y++) {
    const yy = dv.getInt32(q, true);
    const sz = dv.getUint32(q + 4, true);
    q += 8;
    for (let x = 0; x < w; x++) {
      const v = ch.type === 1 ? halfToFloat(dv.getUint16(q + x * 2, true)) : dv.getFloat32(q + x * 4, true);
      out[y * w + x] = v;
    }
    q += sz;
  }
  return { data: out, w, h };
}
function halfToFloat(h) {
  const s = (h & 0x8000) >> 15, e = (h & 0x7c00) >> 10, f = h & 0x3ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

// ---------------------------------------------------------------------------
// PNG-16 灰度解码(pako inflate + 反滤波;bitDepth16/8)
// ---------------------------------------------------------------------------
function pngDecode(_buf) {
  const buf = _buf instanceof Uint8Array ? _buf : new Uint8Array(_buf);
  if (buf[0] !== 0x89 || buf[1] !== 0x50) throw new Error('不是 PNG');
  let off = 8, w = 0, h = 0, bit = 0, color = 0, idat = [];
  while (off + 8 <= buf.length) {
    const len = buf[off] * 0x1000000 + buf[off + 1] * 0x10000 + buf[off + 2] * 0x100 + buf[off + 3];
    const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    const d = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = d[0] * 0x1000000 + d[1] * 0x10000 + d[2] * 0x100 + d[3];
      h = d[4] * 0x1000000 + d[5] * 0x10000 + d[6] * 0x100 + d[7];
      bit = d[8]; color = d[9];
    } else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!w || !h || !idat.length) throw new Error('PNG 数据缺失');
  const bpp = color === 0 ? 1 : color === 2 ? 3 : color === 6 ? 4 : 0;
  if (!bpp || bit !== 16) throw new Error(`仅支持 16bit 灰度/灰度α PNG (got color=${color} bit=${bit})`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = new Float32Array(w * h);
  const px = Buffer.alloc(raw.length);
  let src = 0;
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < h; y++) {
    const f = raw[src++];
    for (let x = 0; x < stride; x++) {
      const rv = raw[src++];
      const L = x >= bpp ? px[y * stride + x - bpp] : 0;
      const U = y > 0 ? px[(y - 1) * stride + x] : 0;
      const UL = y > 0 && x >= bpp ? px[(y - 1) * stride + x - bpp] : 0;
      let v = rv;
      if (f === 1) v += L; else if (f === 2) v += U;
      else if (f === 3) v += (L + U) >> 1; else if (f === 4) v += paeth(L, U, UL);
      px[y * stride + x] = v & 0xff;
    }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const hi = px[y * stride + x * bpp], lo = px[y * stride + x * bpp + 1];
    out[y * w + x] = (hi * 256 + lo) / 65535;
  }
  return { data: out, w, h };
}

// ---------------------------------------------------------------------------
// 分块目录 → 网格(按 _y<Y>_x<X> 文件名拼接;单一文件直接解码)
// ---------------------------------------------------------------------------
function loadHeightmap(inputPath) {
  const stat = existsSync(inputPath) ? statSync(inputPath) : null;
  if (stat && stat.isDirectory()) {
    const files = readdirSync(inputPath).filter((f) => /_y\d+_x\d+\.(exr|png)$/i.test(f));
    if (!files.length) throw new Error(`目录 ${inputPath} 里没有 *_y*_x*.exr/png 分块`);
    const tiles = files.map((f) => {
      const m = f.match(/_y(\d+)_x(\d+)\.(exr|png)$/i);
      const raw = readFileSync(join(inputPath, f));
      const img = /\.exr$/i.test(f) ? exrDecode(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)) : pngDecode(raw);
      return { ...img, fy: +m[1], fx: +m[2], file: f };
    });
    const maxX = Math.max(...tiles.map((t) => t.fx)), maxY = Math.max(...tiles.map((t) => t.fy));
    const cols = maxX + 1, rows = maxY + 1;
    const tw = tiles[0].w, th = tiles[0].h;
    if (!tiles.every((t) => t.w === tw && t.h === th)) throw new Error('分块尺寸不一致');
    const w = tw * cols, h = th * rows;
    const data = new Float32Array(w * h);
    for (const t of tiles) {
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        data[(t.fy * th + y) * w + (t.fx * tw + x)] = t.data[y * tw + x];
      }
    }
    return { data, w, h, tiles: `${rows}×${cols} (${files.length} 块)` };
  }
  const raw = readFileSync(inputPath);
  const ext = inputPath.toLowerCase();
  const img = /\.exr$/i.test(ext)
    ? exrDecode(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
    : pngDecode(raw);
  return { ...img };
}

// ---------------------------------------------------------------------------
// PNG 预览编码(pako deflate;hypsometric 着色 → 便于看地貌)
// snowQ ∈ (0,1):低于该高度分位的区域正常配色,高于的涂雪白(预览雪线用)
// ---------------------------------------------------------------------------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function writePreviewPng(outPath, img, lo, hi, snowQ = 0) {
  const P = 640, scale = P / img.w;
  const H = Math.max(2, Math.round(img.h * scale));
  const rgba = Buffer.alloc(P * H * 4);
  // 高度渐变色:深水蓝 → 土 → 草 → 岩 → 雪
  const ramp = [
    [40, 60, 120], [70, 90, 140], [90, 130, 90], [110, 150, 80],
    [150, 140, 90], [170, 130, 100], [140, 120, 110], [190, 190, 195], [245, 248, 252],
  ];
  const pick = (t) => {
    const f = Math.max(0, Math.min(0.999, t)) * (ramp.length - 1);
    const i = Math.floor(f), k = f - i;
    const a = ramp[i], b = ramp[Math.min(ramp.length - 1, i + 1)];
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  };
  // snowQ:按高度分位定雪线(0 = 关)
  let snowThr = -Infinity;
  if (snowQ > 0 && snowQ < 1) {
    const sorted = Float32Array.from(img.data).sort();
    snowThr = sorted[Math.min(sorted.length - 1, Math.floor(snowQ * sorted.length))];
  }
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < P; px++) {
      const sx = Math.min(img.w - 1, Math.floor((px + 0.5) / scale));
      const sy = Math.min(img.h - 1, Math.floor((py + 0.5) / scale));
      const v = img.data[sy * img.w + sx];
      const t = (v - lo) / (hi - lo || 1);
      const o = (py * P + px) * 4;
      if (v >= snowThr) { rgba[o] = 252; rgba[o + 1] = 254; rgba[o + 2] = 255; rgba[o + 3] = 255; continue; }
      const [r, g, b] = pick(t);
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(P, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit RGB
  const stride = P * 3;
  const rawPx = Buffer.alloc(H * (stride + 1));
  for (let y = 0; y < H; y++) {
    rawPx[y * (stride + 1)] = 0;
    for (let x = 0; x < P; x++) {
      const s = (y * P + x) * 4, d = y * (stride + 1) + 1 + x * 3;
      rawPx[d] = rgba[s]; rawPx[d + 1] = rgba[s + 1]; rawPx[d + 2] = rgba[s + 2];
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rawPx)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, png);
  return `${P}×${H}`;
}

// ---------------------------------------------------------------------------
// f32bin + tune 合并
// ---------------------------------------------------------------------------
function encodeF32(data) {
  const out = Buffer.alloc(data.length * 4);
  for (let i = 0; i < data.length; i++) out.writeFloatLE(data[i], i * 4);
  return out;
}
function statsOf(img) {
  let lo = Infinity, hi = -Infinity, sum = 0, n = img.w * img.h;
  for (let i = 0; i < n; i++) {
    const v = img.data[i];
    if (!(v === v)) continue;
    if (v < lo) lo = v; if (v > hi) hi = v; sum += v;
  }
  return { lo, hi, mean: sum / n, n };
}

const [cmd, input] = process.argv.slice(2);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(k);

if (!cmd || !input) {
  console.log('用法: node scripts/gaea-import.mjs <preview|import> <高度图文件|分块目录> [--size 48600] [--maxh 4320] [--slot custom] [--out 预览.png]');
  process.exit(1);
}

// ---------- 1) 解码 ----------
let img;
try {
  img = loadHeightmap(input);
} catch (e) {
  console.error('[gaea-import] 解码失败:', e.message);
  process.exit(2);
}
const st = statsOf(img);
const slot = arg('--slot', 'custom');
const size = Number(arg('--size', '48600'));
const maxH = Number(arg('--maxh', '4320'));
const worldMeters = (v) => ((v - st.lo) / ((st.hi - st.lo) || 1)) * maxH; // 归一 → 米(峰顶= maxHeight)

console.log(`[解码] ${img.w}×${img.h}${img.tiles ? ` (${img.tiles})` : ''}`);
console.log(`[域]  原始归一 ${st.lo.toFixed(4)} .. ${st.hi.toFixed(4)} (mean ${st.mean.toFixed(4)})`);
console.log(`[米制] 0..${maxH} 拉伸 → 山谷≈0m,峰顶≈${maxH}m (世界范围 ±${size / 2}m)`);

// ---------- 2) preview(只读,不碰配置) ----------
if (cmd === 'preview') {
  const outPng = arg('--out', join(ROOT, 'download', `gaea-preview-${slot}.png`));
  const snowQ = Number(arg('--snowq', '0'));
  const dim = writePreviewPng(outPng, img, st.lo, st.hi, snowQ);
  console.log(`[预览] ${outPng} (${dim})${snowQ > 0 ? ` 雪线=高度分位 ${snowQ}` : ''}`);
  // ASCII 缩略(64×24),让终端也能一眼看形
  const ramp = ' .:-=+*#%@';
  const W = 72, H = 26;
  for (let py = 0; py < H; py++) {
    let line = '';
    for (let px = 0; px < W; px++) {
      const sx = Math.min(img.w - 1, Math.floor(((px + 0.5) / W) * img.w));
      const sy = Math.min(img.h - 1, Math.floor(((py + 0.5) / H) * img.h));
      const t = (img.data[sy * img.w + sx] - st.lo) / (st.hi - st.lo || 1);
      line += ramp[Math.min(ramp.length - 1, Math.floor(t * ramp.length))];
    }
    console.log('  ' + line);
  }
  console.log('[ok] 预览完成。确认后执行: node scripts/gaea-import.mjs import "' + input + '" --slot ' + slot);
  process.exit(0);
}

// ---------- 3) import(确认后:写 f32bin + 合并 tune) ----------
if (cmd === 'import') {
  const outDir = join(ROOT, 'public', 'custom-maps', slot);
  const f32Path = join(outDir, 'heights.f32bin');
  mkdirSync(outDir, { recursive: true });
  const meters = new Float32Array(img.data.length);
  for (let i = 0; i < img.data.length; i++) meters[i] = worldMeters(img.data[i]);
  writeFileSync(f32Path, encodeF32(meters));
  const cfgPath = join(ROOT, 'public', 'config', 'terrain-tune.json');
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : { version: 1 };
  cfg.version = cfg.version ?? 1;
  cfg.maps = cfg.maps ?? {};
  cfg.maps[slot] = cfg.maps[slot] ?? {};
  cfg.maps[slot].terrain = cfg.maps[slot].terrain ?? {};
  cfg.maps[slot].terrain.externalHeight = {
    kind: 'f32bin',
    size,
    resX: img.w,
    resY: img.h,
    maxHeight: maxH,
    url: `/custom-maps/${slot}/heights.f32bin`,
  };
  // 雪山同款观感兜底(可被用户后续改;缺省不写死材质)
  cfg.maps[slot].terrain.mode = cfg.maps[slot].terrain.mode ?? 'mountain';
  cfg.maps[slot].terrain.bandMode = cfg.maps[slot].terrain.bandMode ?? 'relative';
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  console.log(`[写盘] ${f32Path} (${meters.length * 4} B, ${img.w}×${img.h})`);
  console.log(`[合并] ${cfgPath} → maps.${slot}.terrain.externalHeight`);
  console.log('[next] 游戏内 localStorage: skybound.mapOverride=' + slot + ' → 重进任务即见新地形');
  process.exit(0);
}

console.error('未知命令', cmd);
process.exit(1);
