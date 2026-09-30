#!/usr/bin/env node
// scripts/extract-uasset-mips.mjs
//
// Extracts the mip0 (full-resolution) source image out of UE5.x .uasset
// texture files. Editor-stored textures keep each mip as a PNG stream in
// the file's bulk region — BUT the streams are not always spec-complete:
// some mips lack the trailing IEND chunk (the IDAT data just stops), so we
// never rely on chunk walking past IDAT. Instead:
//
//   1. find every PNG signature + parse IHDR (fixed layout, always valid)
//   2. collect the consecutive IDAT chunks that follow
//   3. inflate them and check the output equals w*h*channels+rows scanline
//      bytes — a complete mip decodes exactly, padding/IEND not required
//   4. rebuild a clean PNG from the raw scanlines (mip0 = largest width)
//
// Input : MW Landscape Auto Material texture .uasset files on G:\test1
// Output: textures-src/mwam/<layer>/<albedo|normal|mask>.png  (+ report)
// Files with no decodable PNG are reported for the UE5.8 editor fallback
// (scripts/export-mwam-from-ue.py).
//
// Usage: node scripts/extract-uasset-mips.mjs

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ROOT = 'G:/test1/vngi1/Content/MWLandscapeAutoMaterial/Textures';
const OUT_ROOT = path.join(ROOT, 'textures-src', 'mwam');

// layer id: (subfolder, filename token) -> output layer name
const FOLDER_LAYER = {
  Ground: {
    Dirt: 'dirt', Grass: 'grass', Rock: 'rock',
    SandA: 'sand_a', SandC: 'sand_c', Snow: 'snow', Stones: 'stones',
  },
  Cover: { CoverRocks: 'cover_rocks' },
  Extra: { Variation: 'variation' },
  Plants: { Grass: 'plants_grass' },
};
// uasset suffix -> output channel name
const CHANNEL = { col: 'albedo', nrm: 'normal', msk: 'mask' };

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CH_BY_COLOR_TYPE = { 2: 3, 6: 4, 0: 1, 4: 2 };

// --- minimal PNG writer (raw RGBA/RGB scanlines, filter 0) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, colorType, scanlines) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;                 // bit depth
  ihdr[9] = colorType;         // 2 = RGB, 6 = RGBA
  const idat = zlib.deflateSync(scanlines, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

/**
 * Try to decode a complete mip starting at a PNG signature.
 * Returns { w, h, bytes } of a rebuilt clean PNG, or null.
 */
function decodePngAt(buf, sigPos) {
  if (buf.length - sigPos < 33) return null;
  const len = buf.readUInt32BE(sigPos + 8);
  const type = buf.toString('latin1', sigPos + 12, sigPos + 16);
  if (len !== 13 || type !== 'IHDR') return null;
  const w = buf.readUInt32BE(sigPos + 16);
  const h = buf.readUInt32BE(sigPos + 20);
  const bitDepth = buf[sigPos + 24];
  const colorType = buf[sigPos + 25];
  const ch = CH_BY_COLOR_TYPE[colorType];
  if (bitDepth !== 8 || !ch || w < 16 || h < 16 || w !== h || (w & (w - 1)) !== 0 || w > 16384) return null;
  // Collect consecutive IDAT chunks (fixed walk — stops at first non-IDAT,
  // so a missing IEND does not matter). The IHDR header chunk comes first.
  const parts = [];
  let pos = sigPos + 8;
  let guard = 0;
  while (pos + 8 <= buf.length && guard++ < 1000000) {
    const clen = buf.readUInt32BE(pos);
    const ctype = buf.toString('latin1', pos + 4, pos + 8);
    const cend = pos + 12 + clen;
    if (cend > buf.length) return null;
    if (ctype === 'IHDR') { pos = cend; continue; }
    if (ctype !== 'IDAT') break;
    if (clen > 128 * 1024 * 1024) return null;
    parts.push(buf.subarray(pos + 8, cend - 4));
    pos = cend;
  }
  if (!parts.length) return null;
  try {
    const raw = zlib.inflateSync(Buffer.concat(parts));
    const expected = h * (1 + w * ch); // filter byte per row
    if (raw.length !== expected) return null;
    return { w, h, bytes: encodePNG(w, h, colorType, raw) };
  } catch {
    return null;
  }
}

function carveMip0(buf) {
  const found = [];
  let i = 0;
  while ((i = buf.indexOf(PNG_SIG, i)) !== -1) {
    const png = decodePngAt(buf, i);
    if (png) found.push(png);
    i += 8;
  }
  if (!found.length) return null;
  found.sort((a, b) => b.w * b.h - a.w * a.h);
  return found[0];
}

const tasks = [];
for (const [folder, layers] of Object.entries(FOLDER_LAYER)) {
  for (const [token, layer] of Object.entries(layers)) {
    for (const [suffix, channel] of Object.entries(CHANNEL)) {
      const file = path.join(SRC_ROOT, folder, `TEX_MWAM_${token}_${suffix}.uasset`);
      tasks.push({ file, layer, channel, folder });
    }
  }
}

const report = { ok: [], failed: [], skipped: [] };
fs.mkdirSync(OUT_ROOT, { recursive: true });

for (const t of tasks) {
  if (!fs.existsSync(t.file)) { report.skipped.push({ ...t, reason: 'file missing' }); continue; }
  const buf = fs.readFileSync(t.file);
  const png = carveMip0(buf);
  if (!png) { report.failed.push({ ...t, bytes: buf.length, reason: 'no decodable embedded PNG' }); continue; }
  const outDir = path.join(OUT_ROOT, t.layer);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${t.channel}.png`);
  fs.writeFileSync(outFile, png.bytes);
  report.ok.push({
    file: t.file.replace(SRC_ROOT + '/', ''), layer: t.layer, channel: t.channel,
    w: png.w, h: png.h, outBytes: png.bytes.length, uassetBytes: buf.length,
  });
  console.log(`  OK  ${t.layer}/${t.channel}.png  ${png.w}x${png.h}  rebuilt ${(png.bytes.length / 1048576).toFixed(1)}MB  (uasset ${(buf.length / 1048576).toFixed(1)}MB)`);
}

const repPath = path.join(OUT_ROOT, '_extract-report.json');
fs.writeFileSync(repPath, JSON.stringify(report, null, 2));
console.log(`\n=== done: ${report.ok.length} ok, ${report.failed.length} failed, ${report.skipped.length} skipped ===`);
console.log(`report: ${repPath}`);
if (report.failed.length) {
  console.log('\nFailed (need UE5.8 editor export fallback — scripts/export-mwam-from-ue.py):');
  for (const f of report.failed) console.log(`  - ${f.file}  (${f.reason})`);
}
