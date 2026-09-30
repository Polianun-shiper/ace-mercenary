// Decode a concatenated-frame .zstd session log into plain text.
// Usage: node _zstd-frames.mjs <in.zstd> <out>
import fs from 'node:fs';
import zlib from 'node:zlib';

const [src, dst] = process.argv.slice(2);
const buf = fs.readFileSync(src);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const chunks = [];
let pos = 0;
let ok = 0;
let bad = 0;
while (pos < buf.length) {
  const i = buf.indexOf(MAGIC, pos);
  if (i < 0) break;
  try {
    const out = zlib.zstdDecompressSync(buf.subarray(i), { maxOutputLength: 64 * 1024 * 1024 });
    if (out.length) chunks.push(out);
    ok++;
  } catch {
    bad++;
  }
  pos = i + 4;
}
const merged = Buffer.concat(chunks);
fs.writeFileSync(dst, merged);
console.log(JSON.stringify({ src, bytes: buf.length, frames_ok: ok, frames_bad: bad, out_bytes: merged.length }));
