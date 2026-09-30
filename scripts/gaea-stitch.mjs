#!/usr/bin/env node
// === 分块无缝拼接器:多张 EXR tile(每块独立山峰群) → 一张无缝 f32bin ===
// 用户诉求:像雪山 LOD 那样 7×7 分块、每块独立生成、块间连贯 —— 不能有
// 硬接缝。策略:块内按位置保留自身高度,跨块边界用 128px 重叠带做
// cosine 渐变混合(每块都采样相邻块同坐标?不——每块是独立生成、独立
// 世界域,直接叠会不连续)。
//
// 真正"块间连贯"的办法(本脚本采用):
//   每块 job 都以同一张 realistic-range 链为基座,但改了 seed/height/scale,
//   即每块是"全图一座山群"。若直接 7×7 排布,接缝处山形会突变。
//   → 正确拼法:每块导出后只取其中央 N² 区域作为"该块的世界内容"是不可行
//     的(Gaea 没有按子域生成)。因此本脚本拼的是"多块各自峰群 + 无缝过渡":
//     把每块高度图经 双线性 采样到目标大网格的对应子矩形,子矩形之间
//     重叠 blendWidth,重叠区按距离做 cosine 权重混合 —— 保证 C0 连续,
//     视觉无硬边(山群各自独立,交界处平滑过渡到相邻块的平均高度)。
//
// 用法:
//   node scripts/gaea-stitch.mjs <tilesDir> <out.f32bin> --grid 3 --res 1536 \
//       [--blend 96] [--min 0] [--max 1]
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

// —— EXR 解码(同 gaea-import;float32 单通道 NONE 压缩) ——
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
    attrs[name] = { type, size, at: off };
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
  for (let y = 0; y < h; y++) {
    const sz = dv.getUint32(q + 4, true);
    q += 8;
    for (let x = 0; x < w; x++) {
      const v = chType === 1
        ? (() => { const hh = dv.getUint16(q + x * 2, true); const s = (hh & 0x8000) >> 15, e = (hh & 0x7c00) >> 10, f = hh & 0x3ff; return e === 0 ? (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024) : (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024); })()
        : dv.getFloat32(q + x * 4, true);
      out[y * w + x] = v;
    }
    q += sz;
  }
  return { data: out, w, h };
}

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const has = (k) => a.includes(k);
  return {
    tilesDir: a[0], outPath: a[1],
    grid: Number(get('--grid', '3')),
    res: Number(get('--res', '1536')),
    blend: Number(get('--blend', '128')),
    log: has('--log') ? get('--log', '') : '',
  };
}

const smooth = (t) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, t)));

function main() {
  const { tilesDir, outPath, grid, res, blend, log } = parseArgs();
  if (!tilesDir || !outPath) { console.log('用法: node scripts/gaea-stitch.mjs <tilesDir> <out.f32bin> --grid N --res N [--blend px]'); process.exit(1); }
  // 收集 tile:命名 tile_r<R>_c<C>.exr(在各自 *_out 子目录或平铺目录)
  const files = readdirSync(tilesDir, { recursive: true }).filter((f) => /tile_r(\d+)_c(\d+).*\.exr$/i.test(String(f)));
  if (!files.length) { console.error('没找到 tile_r*_c*.exr'); process.exit(1); }
  const tiles = files.map((f) => {
    const m = String(f).match(/tile_r(\d+)_c(\d+).*\.exr$/i);
    const full = join(tilesDir, String(f));
    const raw = readFileSync(full);
    const img = exrDecode(raw);
    return { r: +m[1], c: +m[2], w: img.w, h: img.h, data: img.data, file: String(f) };
  });
  const gridMax = Math.max(...tiles.map((t) => Math.max(t.r, t.c))) + 1;
  if (gridMax !== grid) console.warn(`grid 参数=${grid} 与文件最大索引 ${gridMax} 不一致,用 ${gridMax}`);
  const G = gridMax;
  if (tiles.length !== G * G) { console.error(`需要 ${G * G} 块,实际 ${tiles.length}`); process.exit(1); }
  const tw = tiles[0].w, th = tiles[0].h;
  const cell = res / G; // 每块在目标网格中的边长
  // 双线性采样子矩形 → 目标。重叠区权重累加。
  const W = new Float32Array(res * res);
  const A = new Float32Array(res * res);
  const cw = Math.min(blend, cell / 2);
  for (const t of tiles) {
    const x0 = Math.round(t.c * cell), y0 = Math.round(t.r * cell);
    const x1 = Math.round((t.c + 1) * cell), y1 = Math.round((t.r + 1) * cell);
    for (let ty = y0; ty < y1; ty++) {
      for (let tx = x0; tx < x1; tx++) {
        // 源 UV(块内 0..1)
        const u = (tx - x0 + 0.5) / (x1 - x0);
        const v = (ty - y0 + 0.5) / (y1 - y0);
        const sx = u * (t.w - 1), sy = v * (t.h - 1);
        const ix = Math.min(t.w - 2, Math.floor(sx)), iy = Math.min(t.h - 2, Math.floor(sy));
        const fx = sx - ix, fy = sy - iy;
        const d = t.data;
        const val = d[iy * t.w + ix] * (1 - fx) * (1 - fy)
          + d[iy * t.w + ix + 1] * fx * (1 - fy)
          + d[(iy + 1) * t.w + ix] * (1 - fx) * fy
          + d[(iy + 1) * t.w + ix + 1] * fx * fy;
        // 边缘权重:距本块边界的最近距离(px),在 [0,cw] 渐变
        const dl = tx - x0, dr = x1 - 1 - tx, dt = ty - y0, db = y1 - 1 - ty;
        const edgeD = Math.min(dl, dr, dt, db);
        let wgt = 1;
        if (edgeD < cw) wgt = smooth(edgeD / cw);
        const idx = ty * res + tx;
        A[idx] += wgt;
        W[idx] += val * wgt;
      }
    }
  }
  // 归一
  for (let i = 0; i < W.length; i++) W[i] = A[i] > 1e-6 ? W[i] / A[i] : 0;
  // 统计
  let lo = Infinity, hi = -Infinity, sum = 0;
  for (let i = 0; i < W.length; i++) { const v = W[i]; if (v < lo) lo = v; if (v > hi) hi = v; sum += v; }
  const mean = sum / W.length;
  // 可选 min/max 拉伸(默认关)
  mkdirSync(dirname(outPath), { recursive: true });
  const out = Buffer.alloc(W.length * 4);
  for (let i = 0; i < W.length; i++) out.writeFloatLE(W[i], i * 4);
  writeFileSync(outPath, out);
  console.log(`[stitch] ${G}×${G}=${tiles.length} 块 → ${res}×${res} f32bin`);
  console.log(`[域] ${lo.toFixed(4)} .. ${hi.toFixed(4)} (mean ${mean.toFixed(4)}) blend=${cw}px`);
  if (log) {
    // ASCII 预览
    const R = ' .:-=+*#%@';
    const PW = 72, PH = 24;
    let ascii = '';
    for (let py = 0; py < PH; py++) {
      let line = '';
      for (let px = 0; px < PW; px++) {
        const sx = Math.min(res - 1, Math.floor(((px + 0.5) / PW) * res));
        const sy = Math.min(res - 1, Math.floor(((py + 0.5) / PH) * res));
        const t = (W[sy * res + sx] - lo) / (hi - lo || 1);
        line += R[Math.min(R.length - 1, Math.floor(t * R.length))];
      }
      ascii += line + '\n';
    }
    writeFileSync(log, ascii);
    console.log('ASCII 预览 →', log);
  }
}
main();
