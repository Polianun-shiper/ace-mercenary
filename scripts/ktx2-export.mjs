#!/usr/bin/env node
// === KTX2 + Basis Universal 贴图导出 (per user request: 纹理压缩 + 显存优化) ===
// Encodes PBR texture sets into KTX2 (Basis Universal ETC1S) so the runtime
// loads ~10-30× smaller GPU textures instead of raw canvas RGBA.
//
// Two sources:
//   1. DEMO sets — procedural livery textures generated here in pure Node
//      (direct per-pixel math + a minimal PNG writer, no canvas/native deps)
//      for the aircraft models/paints the game actually uses. This exercises
//      the whole KTX2 decode path end-to-end with zero artist assets.
//   2. textures-src/<id>/ — real artist textures (albedo.png, normal.png,
//      metallic.png, roughness.png, ao.png, emissive.png) dropped in by the
//      user. Each subdir becomes a texture-set id that overrides the demo.
//
// Encoding: the `basisu` CLI from the `basis_universal` npm devDependency.
// If it isn't installed the script prints a warning and skips — the runtime
// gracefully falls back to procedural canvas textures.
//
// Output: public/textures/ktx2/<id>/<channel>.ktx2
//         public/textures/ktx2/manifest.json   (list of available set ids)
//
// Usage: node scripts/ktx2-export.mjs

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'textures', 'ktx2');
const SRC_DIR = path.join(ROOT, 'textures-src');

// ---------------------------------------------------------------------------
// Minimal PNG writer (RGBA8, no filters) — pure node, no canvas dependency.
// ---------------------------------------------------------------------------
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
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  const stride = 1 + w * 4;
  const raw = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * stride + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// Deterministic PRNG + smooth value noise (mirrors the runtime generators).
// ---------------------------------------------------------------------------
function seededRand(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// 2D value noise: bilinear interp over a random lattice, normalized 0..1.
function makeNoise(w, h, seed, scale) {
  const rand = seededRand(seed);
  const gw = Math.max(2, Math.ceil(w / scale) + 2);
  const gh = Math.max(2, Math.ceil(h / scale) + 2);
  const lattice = new Float32Array(gw * gh);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = (y / scale) % (gh - 1);
    const gy = Math.floor(fy);
    const ty = fy - gy;
    for (let x = 0; x < w; x++) {
      const fx = (x / scale) % (gw - 1);
      const gx = Math.floor(fx);
      const tx = fx - gx;
      const i00 = lattice[gy * gw + gx];
      const i10 = lattice[gy * gw + gx + 1];
      const i01 = lattice[(gy + 1) * gw + gx];
      const i11 = lattice[(gy + 1) * gw + gx + 1];
      const a = i00 + (i10 - i00) * tx;
      const b = i01 + (i11 - i01) * tx;
      out[y * w + x] = a + (b - a) * ty;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Channel generators (albedo/normal/metallic/roughness/ao/emissive)
// ---------------------------------------------------------------------------
const SCHEME_BASE = {
  standard: [0.50, 0.54, 0.58],
  camo: [0.42, 0.48, 0.36],
  aggressor: [0.53, 0.30, 0.28],
  stealth: [0.16, 0.17, 0.20],
};
const SCHEME_ACCENT = {
  standard: [0.75, 0.20, 0.20],
  camo: [0.75, 0.20, 0.20],
  aggressor: [0.55, 0.75, 0.95],
  stealth: [1.0, 0.72, 0.30],
};

function genAlbedo(w, h, model, scheme, rand) {
  const out = new Uint8Array(w * h * 4);
  const base = SCHEME_BASE[scheme] ?? SCHEME_BASE.standard;
  const accent = SCHEME_ACCENT[scheme] ?? SCHEME_ACCENT.standard;
  const camo = scheme === 'camo';
  const noise = makeNoise(w, h, `${model}|${scheme}|albedo`, 48);
  const noiseFine = makeNoise(w, h, `${model}|${scheme}|fine`, 8);
  const camoN = makeNoise(w, h, `${model}|${scheme}|camo`, 140);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r = base[0], g = base[1], b = base[2];
      // Camo blobs for military schemes
      if (camo) {
        const v = camoN[y * w + x];
        const k = v < 0.35 ? 1.35 : v < 0.6 ? 1.0 : 0.72;
        r *= k; g *= k; b *= k;
      }
      // Fine material noise
      const n = 1 + (noiseFine[y * w + x] - 0.5) * 0.12 + (noise[y * w + x] - 0.5) * 0.1;
      r *= n; g *= n; b *= n;
      // Panel lines (grid every ~1/6 of size)
      const step = Math.max(24, Math.round(Math.min(w, h) / 6));
      const onLine = (x % step) < 1.2 || (y % step) < 1.2;
      if (onLine) { r *= 0.82; g *= 0.82; b *= 0.82; }
      // Spine strip (top edge darker/light)
      if (y < h * 0.06) { const k = 1 + (0.06 * h - y) / (0.06 * h) * 0.08; r *= k; g *= k; b *= k; }
      // Belly shading (bottom band darker)
      if (y > h * 0.86) { const k = 0.85; r *= k; g *= k; b *= k; }
      // Wingtip accent bands (left + right edges)
      if (x < w * 0.02 || x > w * 0.98) { r = accent[0]; g = accent[1]; b = accent[2]; }
      out[i] = Math.max(0, Math.min(255, Math.round(r * 255)));
      out[i + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
      out[i + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
      out[i + 3] = 255;
    }
  }
  return out;
}

function genNormal(w, h, model, scheme, rand) {
  const out = new Uint8Array(w * h * 4);
  const noise = makeNoise(w, h, `${model}|${scheme}|nrm`, 10);
  const step = Math.max(24, Math.round(Math.min(w, h) / 6));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r = 128 + (noise[y * w + x] - 0.5) * 30;
      const onLine = (x % step) < 2 || (y % step) < 2;
      if (onLine) r -= 14;
      out[i] = r; out[i + 1] = 128; out[i + 2] = 255; out[i + 3] = 255;
    }
  }
  return out;
}

function genMetallic(w, h, model, scheme, rand) {
  const out = new Uint8Array(w * h * 4);
  const noise = makeNoise(w, h, `${model}|${scheme}|met`, 20);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let v = 110 + (noise[y * w + x] - 0.5) * 40;
      if (y > h * 0.86) v = 200;          // nozzle zone high metal
      if (y < h * 0.04) v = 30;           // radome low metal
      out[i] = out[i + 1] = out[i + 2] = Math.max(0, Math.min(255, Math.round(v)));
      out[i + 3] = 255;
    }
  }
  return out;
}

function genRoughness(w, h, model, scheme, rand) {
  const out = new Uint8Array(w * h * 4);
  const noise = makeNoise(w, h, `${model}|${scheme}|rgh`, 8);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let v = 115 + (noise[y * w + x] - 0.5) * 90;
      if (y > h * 0.9) v = 220; // exhaust soot
      out[i] = out[i + 1] = out[i + 2] = Math.max(0, Math.min(255, Math.round(v)));
      out[i + 3] = 255;
    }
  }
  return out;
}

function genAO(w, h, model, scheme, rand) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dx = (x / w - 0.5) * 2, dy = (y / h - 0.5) * 2;
      const vign = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 0.55);
      let v = 235 * (0.75 + 0.25 * vign);
      if (y > h * 0.88) v *= 0.8; // nozzle cavity
      if (y < h * 0.03) v *= 0.85; // spine shadow
      out[i] = out[i + 1] = out[i + 2] = Math.max(0, Math.min(255, Math.round(v)));
      out[i + 3] = 255;
    }
  }
  return out;
}

function genEmissive(w, h, model, scheme, rand) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out[i] = out[i + 1] = out[i + 2] = 0; out[i + 3] = 255;
    }
  }
  // Nav lights: red left, green right, white top/bottom strobes
  const dot = (cx, cy, col) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const d = Math.hypot((x - cx) / w, (y - cy) / h);
      if (d < 0.02) {
        const i = (y * w + x) * 4;
        out[i] = col[0]; out[i + 1] = col[1]; out[i + 2] = col[2];
      }
    }
  };
  dot(w * 0.03, h * 0.5, [255, 30, 30]);
  dot(w * 0.97, h * 0.5, [30, 255, 30]);
  dot(w * 0.5, h * 0.04, [255, 255, 255]);
  dot(w * 0.5, h * 0.96, [255, 255, 255]);
  return out;
}

// ---------------------------------------------------------------------------
// Encode via basisu CLI
// ---------------------------------------------------------------------------
function basisuExe() {
  // node_modules/basis_universal/bin/<platform> (win32: basisu.exe)
  const pkg = path.join(ROOT, 'node_modules', 'basis_universal');
  if (!fs.existsSync(pkg)) return null;
  const bin = path.join(pkg, 'bin', process.platform === 'win32' ? 'basisu.exe' : 'basisu');
  return fs.existsSync(bin) ? bin : null;
}

function encodeToKtx2(pngPath, outPath, linear = false) {
  const exe = basisuExe();
  if (!exe) return false;
  // ETC1S is the DEFAULT mode; -linear gives better metrics for non-sRGB
  // channels (normal/metallic/roughness/ao). Albedo/emissive stay sRGB.
  const args = [pngPath, '-ktx2', '-mipmap'];
  if (linear) args.push('-linear');
  args.push('-output_file', outPath);
  const r = spawnSync(exe, args, { stdio: 'pipe', encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) {
    console.warn(`  basisu failed for ${pngPath}: ${(r.stderr ?? r.stdout ?? '').slice(0, 200)}`);
    return false;
  }
  return fs.existsSync(outPath);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const DEMO_SETS = [
  { id: 'aircraft/f16-standard', model: 'f16', scheme: 'standard' },
  { id: 'aircraft/f16-camo', model: 'f16', scheme: 'camo' },
  { id: 'aircraft/f16-aggressor', model: 'f16', scheme: 'aggressor' },
  { id: 'aircraft/f16-stealth', model: 'f16', scheme: 'stealth' },
  { id: 'aircraft/f15-standard', model: 'f15', scheme: 'standard' },
  { id: 'aircraft/b52-standard', model: 'b52', scheme: 'standard' },
];

const CHANNELS = ['albedo', 'normal', 'metallic', 'roughness', 'ao', 'emissive'];
const ALB_W = 1024, AUX_W = 512;

function writeSet(id, channels) {
  const dir = path.join(OUT_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  let ok = true;
  for (const [ch, pngBuf] of Object.entries(channels)) {
    const png = path.join(dir, `${ch}.png`);
    const ktx2 = path.join(dir, `${ch}.ktx2`);
    fs.writeFileSync(png, pngBuf);
    if (!encodeToKtx2(png, ktx2, ch !== 'albedo' && ch !== 'emissive')) ok = false;
    fs.rmSync(png, { force: true });
  }
  return ok;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const hasBasisu = !!basisuExe();
  if (!hasBasisu) {
    console.warn('[ktx2] basis_universal not installed — install it with: npm i -D basis_universal');
    console.warn('[ktx2] skipping KTX2 encoding; runtime will use procedural canvas textures.');
  }
  const manifest = [];

  if (hasBasisu) {
    // 1. Demo aircraft sets
    console.log('[ktx2] generating demo aircraft texture sets …');
    for (const s of DEMO_SETS) {
      const rand = seededRand(`${s.model}|${s.scheme}|ktx2`);
      const channels = {
        albedo: encodePNG(ALB_W, ALB_W, genAlbedo(ALB_W, ALB_W, s.model, s.scheme, rand)),
        normal: encodePNG(AUX_W, AUX_W, genNormal(AUX_W, AUX_W, s.model, s.scheme, rand)),
        metallic: encodePNG(AUX_W, AUX_W, genMetallic(AUX_W, AUX_W, s.model, s.scheme, rand)),
        roughness: encodePNG(AUX_W, AUX_W, genRoughness(AUX_W, AUX_W, s.model, s.scheme, rand)),
        ao: encodePNG(AUX_W, AUX_W, genAO(AUX_W, AUX_W, s.model, s.scheme, rand)),
        emissive: encodePNG(AUX_W, AUX_W, genEmissive(AUX_W, AUX_W, s.model, s.scheme, rand)),
      };
      if (writeSet(s.id, channels)) manifest.push(s.id);
      console.log(`  ${s.id} ${fs.existsSync(path.join(OUT_DIR, s.id, 'albedo.ktx2')) ? 'OK' : 'SKIP'}`);
    }
    // 2. textures-src/<id>/ — real artist textures override the demo
    if (fs.existsSync(SRC_DIR)) {
      for (const id of fs.readdirSync(SRC_DIR)) {
        const dir = path.join(SRC_DIR, id);
        if (!fs.statSync(dir).isDirectory()) continue;
        const channels = {};
        for (const ch of CHANNELS) {
          const file = ['albedo', 'normal'].includes(ch)
            ? CHANNELS.map((c) => c).find((c) => c === ch)
            : ch;
          const p = path.join(dir, `${file}.png`);
          const jpg = path.join(dir, `${file}.jpg`);
          const webp = path.join(dir, `${file}.webp`);
          const src = fs.existsSync(p) ? p : fs.existsSync(jpg) ? jpg : fs.existsSync(webp) ? webp : null;
          if (src) channels[ch] = fs.readFileSync(src);
        }
        if (Object.keys(channels).length === 0) {
          console.warn(`  textures-src/${id}: no albedo/normal/metallic/roughness/ao/emissive images found, skipping`);
          continue;
        }
        if (writeSet(id, channels)) manifest.push(id);
        console.log(`  ${id} (from textures-src) OK`);
      }
    }
  }

  // 3. Manifest — consumed by TextureManager (injected into builds)
  // Preserve the existing "terrains" table — that section is owned by
  // scripts/mwam-import.mjs (MWAM terrain layers), not by this script.
  let prevTerrains = {};
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'manifest.json'), 'utf8'));
    if (prev.terrains && typeof prev.terrains === 'object') prevTerrains = prev.terrains;
  } catch { /* first run */ }
  fs.writeFileSync(
    path.join(OUT_DIR, 'manifest.json'),
    JSON.stringify({ sets: manifest, terrains: prevTerrains }, null, 2),
  );
  console.log(`[ktx2] manifest: ${manifest.length} sets → public/textures/ktx2/manifest.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
