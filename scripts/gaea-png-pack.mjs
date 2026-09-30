#!/usr/bin/env node
// === Gaea PNG 四件套 → 游戏 custom 槽打包器 ===
// 输入(Gaea GUI 导出 PNG):HeightmapExport.png(黑=低/白=高)、ColorExport.png、
//   NormalsExport.png(切线法线)、AOExport.png —— 4096² 8bit。
// 输出(public/custom-maps/custom/):heights.f32bin、color.png、normal.png、
//   ao.png(2048²),并合并 terrain-tune.json。
// 压缩:4096² 过大 → 双线性降采样到 2048²(近景 24m/格,高度 f32bin 16MB
//   在单文件内联 32MB 门限内);高度按 黑0→0m、白→maxHeight。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { inflate } from 'pako';

const { deflateSync, gzipSync } = createRequire(import.meta.url)('zlib');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2];
if (!SRC) { console.log('用法: node scripts/gaea-png-pack.mjs <四件套目录> [--maxh 4320] [--size 48600] [--res 2048]'); process.exit(1); }
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const MAXH = arg('--maxh', 4320), SIZE = arg('--size', 48600), TRES = arg('--res', 2048);

function decodePng(file) {
  const b = readFileSync(file);
  let off = 8, w = 0, h = 0, bit = 0, color = 0, idat = [];
  while (off + 8 <= b.length) {
    const len = b.readUInt32BE(off); const type = b.toString('ascii', off + 4, off + 8); const d = b.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bit = d[8]; color = d[9]; }
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bit !== 8) throw new Error(`${file}: 仅支持 8bit(当前 ${bit})`);
  const bpp = color === 2 ? 3 : color === 0 ? 1 : 4;
  const raw = inflate(Buffer.concat(idat));
  const stride = w * bpp, px = Buffer.alloc(h * stride); let src = 0;
  const paeth = (a, bb, c) => { const p = a + bb - c, pa = Math.abs(p - a), pb = Math.abs(p - bb), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? bb : c; };
  for (let y = 0; y < h; y++) {
    const f2 = raw[src++];
    for (let x = 0; x < stride; x++) {
      const rv = raw[src++];
      const L = x >= bpp ? px[y * stride + x - bpp] : 0, U = y > 0 ? px[(y - 1) * stride + x] : 0;
      const UL = y > 0 && x >= bpp ? px[(y - 1) * stride + x - bpp] : 0;
      let v = rv; if (f2 === 1) v += L; else if (f2 === 2) v += U; else if (f2 === 3) v += (L + U) >> 1; else if (f2 === 4) v += paeth(L, U, UL);
      px[y * stride + x] = v & 0xff;
    }
  }
  return { w, h, bpp, px };
}
// 双线性降采样到 to×to
function downsample(img, to) {
  const out = Buffer.alloc(to * to * img.bpp);
  const s = img.w / to;
  for (let y = 0; y < to; y++) {
    const sy = (y + 0.5) * s - 0.5;
    const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(img.h - 1, y0 + 1);
    const ty = sy - y0;
    for (let x = 0; x < to; x++) {
      const sx = (x + 0.5) * s - 0.5;
      const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(img.w - 1, x0 + 1);
      const tx = sx - x0;
      for (let c = 0; c < img.bpp; c++) {
        const A = img.px[y0 * img.w * img.bpp + x0 * img.bpp + c];
        const B = img.px[y0 * img.w * img.bpp + x1 * img.bpp + c];
        const C = img.px[y1 * img.w * img.bpp + x0 * img.bpp + c];
        const D = img.px[y1 * img.w * img.bpp + x1 * img.bpp + c];
        const v = A + (B - A) * tx + (C - A) * ty + (A - B - C + D) * tx * ty;
        out[(y * to + x) * img.bpp + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }
  return { w: to, h: to, bpp: img.bpp, px: out };
}
function writePng(path, img) {
  const crc32 = (b2) => { let c = ~0; for (let i = 0; i < b2.length; i++) { c ^= b2[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; };
  const chk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, cr]); };
  const stride = img.w * img.bpp;
  const raw = Buffer.alloc(img.h * (stride + 1));
  for (let y = 0; y < img.h; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < img.w; x++) for (let c = 0; c < img.bpp; c++) raw[y * (stride + 1) + 1 + x * img.bpp + c] = img.px[(y * img.w + x) * img.bpp + c];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.w, 0); ihdr.writeUInt32BE(img.h, 4); ihdr[8] = 8; ihdr[9] = img.bpp === 3 ? 2 : 0;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chk('IHDR', ihdr), chk('IDAT', deflateSync(raw)), chk('IEND', Buffer.alloc(0))]));
}

const outDir = join(ROOT, 'public', 'custom-maps', 'custom');
console.log(`压缩: 4096² → ${TRES}² (box/双线性),高度 0..${MAXH}m 黑=低`);

const hImg = downsample(decodePng(join(SRC, 'HeightmapExport.png')), TRES);
const f32 = Buffer.alloc(TRES * TRES * 4);
for (let i = 0; i < TRES * TRES; i++) f32.writeFloatLE((hImg.px[i] / 255) * MAXH, i * 4);
// === 高度场 gzip (per 单文件体积:高度是平滑场,gzip 可压 20× 以上) ===
// 16MB f32bin → ~0.7MB gz → 单文件内联 base64 省约 20MB。
// 运行时 loadExternalHeight 按 kind='f32bin-gzip' 先 inflate 再 decodeF32Bin,
// 老 kind='f32bin' 路径继续兼容。未压缩 f32bin 也留一份给老工具链。
const gz = gzipSync(f32, { level: 9 });
writeFileSync(join(outDir, 'heights.f32bin.gz'), gz);
writeFileSync(join(outDir, 'heights.f32bin'), f32);
console.log(`[高度] heights.f32bin.gz ${(gz.length / 1048576).toFixed(2)}MB(未压缩 ${(f32.length / 1048576).toFixed(1)}MB,压缩 ${(f32.length / gz.length).toFixed(1)}×)`);

writePng(join(outDir, 'color.png'), downsample(decodePng(join(SRC, 'ColorExport.png')), TRES));
console.log('[颜色] color.png');
writePng(join(outDir, 'normal.png'), downsample(decodePng(join(SRC, 'NormalsExport.png')), TRES));
console.log('[法线] normal.png');
writePng(join(outDir, 'ao.png'), downsample(decodePng(join(SRC, 'AOExport.png')), TRES));
console.log('[AO]   ao.png');

const cfgPath = join(ROOT, 'public', 'config', 'terrain-tune.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
cfg.maps.custom.terrain.externalHeight = { kind: 'f32bin', size: SIZE, resX: TRES, resY: TRES, maxHeight: MAXH, url: '/custom-maps/custom/heights.f32bin' };
cfg.maps.custom.material = cfg.maps.custom.material ?? {};
cfg.maps.custom.material.colorMap = '/custom-maps/custom/color.png';
cfg.maps.custom.material.normalMap = '/custom-maps/custom/normal.png';
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
console.log(`[tune] maps.custom → ${SIZE}m / ${MAXH}m / ${TRES}²(4 张已替换)`);
