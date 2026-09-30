#!/usr/bin/env node
// scripts/terrain-layers-import.mjs
//
// 地表图层 → 游戏用的 **KTX2 2D 数组**(albedo / normal / orm)。第一阶段的核心交付物:
// 游戏里的地表一直跑在 4 层 256² 程序化 canvas 兜底上(public/textures/ktx2 里**一个
// .ktx2 都没有** ⇒ terrain-mwam.ts 载入失败静默回退), 而 Blender 侧早就作者化了
// 8 层 Poly Haven PBR。这个脚本把两半接上。
//
// 层清单 / 层序 / 平铺米数 / 旋转 / 兜底粗糙度**全部读材质表**
// (public/config/terrain-materials.json, 单一真源; Blender 侧读同一个文件)。
//
// 为什么用数组而不是每层两张 sampler2D:
//   地形材质贴着 MAX_TEXTURE_IMAGE_UNITS(16), 历史上超限过一次导致"地表完全不画"。
//   4 层 albedo 占 4 个采样器; 换成 1 个 sampler2DArray 后**层数翻倍、采样器反而减少**。
//   (层法线两年前就已经这么干了: pbr/terrain-mwam.ts 的 normal_array_<preset>.ktx2)
//
// ORM 通道契约(见材质表 orm 段, 线性数据不是颜色):
//   R = AO          —— 由 albedo 的腔隙(cavity)近似: 暗沟比周围暗 ⇒ 更像被遮住
//   G = roughness   —— Poly Haven 的 `_rgh.jpg`(1k)
//   B = blendHeight —— Phase B 的高度混合用; 先用模糊后的 albedo luma 当高度代理
//   A = metallic    —— 地形恒 0
//
// 用法:
//   node scripts/terrain-layers-import.mjs                 # 生成 default 集(1024²)
//   node scripts/terrain-layers-import.mjs --size 512      # 低配/移动档
//   node scripts/terrain-layers-import.mjs --set default   # 指定纹理集名
//   node scripts/terrain-layers-import.mjs --only grass,rock   # 只重编某几层(调试)
//   node scripts/terrain-layers-import.mjs --dry           # 只打印将要做的事
//
// 产物:
//   public/textures/ktx2/terrain/<set>/{albedo,normal,orm}_array.ktx2
//   public/textures/ktx2/manifest.json 的 arrays['terrain/<set>'] = { albedo:[层名…], … }

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TABLE = path.join(ROOT, 'public', 'config', 'terrain-materials.json');
const SRC = path.join(ROOT, 'blender', 'terrain', 'out', 'tex', 'ph');
const OUT_ROOT = path.join(ROOT, 'public', 'textures', 'ktx2', 'terrain');
const MANIFEST = path.join(ROOT, 'public', 'textures', 'ktx2', 'manifest.json');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

const SIZE = (() => {
  const v = parseInt(arg('--size', '1024'), 10);
  return [512, 1024, 2048].includes(v) ? v : 1024;
})();
const DRY = has('--dry');
const ONLY = (arg('--only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// 材质表
// ---------------------------------------------------------------------------
if (!fs.existsSync(TABLE)) fail(`缺材质表 ${TABLE}`);
const table = JSON.parse(fs.readFileSync(TABLE, 'utf8'));
const layers = table.layers;
const ORM = table.orm;
const SET = arg('--set', table.arrays?.defaultSet || 'default');
const CHANNELS = table.arrays?.channels || ['albedo', 'normal', 'orm'];
const SUFFIX = table.arrays?.fileSuffix || '_array.ktx2';

if (ORM.r !== 'ao' || ORM.g !== 'roughness' || ORM.b !== 'blendHeight' || ORM.a !== 'metallic') {
  // 通道语义与着色器里的消费方式绑定, 改了必须同时改 layered-terrain.ts / 材质表注释。
  fail(`材质表 orm 契约不是 ao/roughness/blendHeight/metallic ⇒ 拒绝生成(见该文件 orm._doc)`);
}

function fail(msg) { console.error('[layers] ✗ ' + msg); process.exit(1); }

function basisuExe() {
  // 与 scripts/mwam-import.mjs 同一约定路径(npm 包的 `bin` 字段是对象, 不能直接 join)。
  const exe = process.platform === 'win32' ? 'basisu.exe' : 'basisu';
  const cands = [
    path.join(ROOT, 'node_modules', 'basis_universal', 'bin', exe),
    path.join(ROOT, 'node_modules', '.bin', exe),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

// ---------------------------------------------------------------------------
// 单层三通道
// ---------------------------------------------------------------------------
/** 缓存目录: 组装好的中间 PNG(albedo/normal/orm) —— 数组编码要的是文件列表。 */
const TMP = path.join(ROOT, 'node_modules', '.cache', 'terrain-layers', `${SET}-${SIZE}`);

async function buildLayer(L) {
  const albP = path.join(SRC, `${L.name}_alb.jpg`);
  const nrmP = path.join(SRC, `${L.name}_nrm.jpg`);
  const rghP = path.join(SRC, `${L.name}_rgh.jpg`);
  if (!fs.existsSync(albP)) fail(`缺源贴图 ${albP}（先跑 blender/terrain/36_fetch_polyhaven.py）`);
  if (!fs.existsSync(nrmP)) fail(`缺源法线 ${nrmP}`);

  const dir = path.join(TMP, L.name);
  fs.mkdirSync(dir, { recursive: true });

  // ① albedo(sRGB 保持原样; 缩放用 lanczos3 保细节)
  const albOut = path.join(dir, 'albedo.png');
  await sharp(albP).resize(SIZE, SIZE, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toFile(albOut);

  // ② normal(Poly Haven 的 nor_gl 已是 R=X/G=Y/B=Z 的 OpenGL 约定 ⇒ 与 three 一致, 不重排)
  const nrmOut = path.join(dir, 'normal.png');
  await sharp(nrmP).resize(SIZE, SIZE, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toFile(nrmOut);

  // ③ ORM: R=AO(腔隙近似) G=roughness(源贴图) B=blendHeight(luma 代理) A=0
  const N = SIZE * SIZE;
  const grayRaw = async (p, fill) => {
    if (!p || !fs.existsSync(p)) return Buffer.alloc(N, fill);
    const { data } = await sharp(p).resize(SIZE, SIZE, { kernel: 'lanczos3' })
      .removeAlpha().grayscale().raw().toBuffer({ resolveWithObject: true });
    return data.length >= N ? data.subarray(0, N) : Buffer.concat([data, Buffer.alloc(N - data.length, fill)]);
  };
  const rgh = await grayRaw(fs.existsSync(rghP) ? rghP : null, Math.round((L.rough ?? 0.95) * 255));
  const luma = await grayRaw(albP, 128);
  // 模糊后的 luma 当"高度"代理, 原 luma 与它的差当腔隙(暗沟) ⇒ AO
  const blur = await sharp(albP).resize(SIZE, SIZE, { kernel: 'lanczos3' })
    .removeAlpha().grayscale().blur(Math.max(1, SIZE / 128)).raw().toBuffer();
  const ao = Buffer.alloc(N);
  const hgt = Buffer.alloc(N);
  for (let i = 0; i < N; i++) {
    const d = blur[i] - luma[i];                    // >0 = 比周围暗 = 沟壑
    const cav = Math.max(0, Math.min(1, d / 64));   // 0..1
    ao[i] = Math.round(255 * (1 - 0.35 * cav));     // 最多压到 0.65, 别把贴图压死
    hgt[i] = blur[i];
  }
  const orm = Buffer.alloc(N * 4);
  for (let i = 0; i < N; i++) {
    orm[i * 4 + 0] = ao[i];
    orm[i * 4 + 1] = rgh[i];
    orm[i * 4 + 2] = hgt[i];
    orm[i * 4 + 3] = 0;                             // metallic = 0
  }
  const ormOut = path.join(dir, 'orm.png');
  await sharp(orm, { raw: { width: SIZE, height: SIZE, channels: 4 } })
    .png({ compressionLevel: 9 }).toFile(ormOut);

  // ★ 同时把 ORM 落到 **Blender 管线目录** (out/tex/ph/<层>_orm.png):
  //   Blender 侧的高度混合 / 逐层粗糙度要读它(高度存 B 通道), 不能只躺在 node_modules 缓存里。
  const ormPipe = path.join(SRC, `${L.name}_orm.png`);
  try { fs.copyFileSync(ormOut, ormPipe); } catch { /* 只读目录等异常不致命 */ }

  return { albOut, nrmOut, ormOut, ormPipe, rghSrc: fs.existsSync(rghP) };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const exe = basisuExe();
if (!exe && !DRY) fail('未安装 basis_universal（node_modules/basis_universal/bin/basisu.exe）—— 它是 KTX2 编码器');

const picked = ONLY.length ? layers.filter((L) => ONLY.includes(L.name)) : layers;
if (!picked.length) fail(`--only 没匹配到任何层: ${ONLY.join(',')}`);

console.log(`[layers] 集=${SET}  尺寸=${SIZE}²  层=${picked.length}/${layers.length}`
  + `  ORM=R:${ORM.r}/G:${ORM.g}/B:${ORM.b}/A:${ORM.a}`);
if (DRY) {
  for (const L of picked) console.log(`  · ${L.name.padEnd(12)} rot=${L.rotDeg}° rough=${L.rough} src=${L.src?.slug}`);
  console.log(`[layers] --dry: 未写入任何文件。输出目录将是 ${path.relative(ROOT, path.join(OUT_ROOT, SET))}`);
  process.exit(0);
}

fs.mkdirSync(path.join(OUT_ROOT, SET), { recursive: true });
const perChannel = { albedo: [], normal: [], orm: [] };
for (const L of picked) {
  const r = await buildLayer(L);
  perChannel.albedo.push(r.albOut);
  perChannel.normal.push(r.nrmOut);
  perChannel.orm.push(r.ormOut);
  console.log(`  · ${L.name.padEnd(12)} 组装完成${r.rghSrc ? '' : '（无 _rgh.jpg ⇒ 用表里兜底粗糙度）'}`
    + `  → ${path.basename(r.ormPipe)}（给 Blender 高度混合/逐层粗糙度用）`);
}

const written = [];
for (const ch of CHANNELS) {
  const pngs = perChannel[ch];
  if (!pngs || !pngs.length) continue;
  const outFile = path.join(OUT_ROOT, SET, `${ch}${SUFFIX}`);
  // albedo 是颜色(sRGB); normal/orm 是线性数据 ⇒ 必须带 -linear, 否则 basisu 会按 sRGB 做变换
  const args = [...pngs, '-tex_array', '-ktx2', '-mipmap'];
  if (ch !== 'albedo') args.push('-linear');
  args.push('-output_file', outFile);
  const t0 = Date.now();
  const r = spawnSync(exe, args, { stdio: 'pipe', encoding: 'utf8', timeout: 300000 });
  if (r.status !== 0 || !fs.existsSync(outFile)) {
    fail(`basisu ${ch} 失败: ${(r.stderr ?? r.stdout ?? '').slice(0, 300)}`);
  }
  const kb = fs.statSync(outFile).size / 1024;
  written.push({ ch, file: outFile, kb: +kb.toFixed(0), layers: pngs.length });
  console.log(`  OK ${ch.padEnd(7)} ${String(pngs.length).padStart(2)} 层 → `
    + `${path.relative(ROOT, outFile).replace(/\\/g, '/')}  ${kb.toFixed(0)} KB  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// manifest: 记录**层序**(运行时按同一顺序索引数组) + 体积 + 源 slug
const mf = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};
mf.arrays = mf.arrays || {};
mf.arrays[`terrain/${SET}`] = {
  layers: picked.map((L) => L.name),
  size: SIZE,
  channels: Object.fromEntries(written.map((w) => [w.ch, { file: path.basename(w.file), kb: w.kb }])),
  orm: { r: ORM.r, g: ORM.g, b: ORM.b, a: ORM.a },
  note: '层序 == public/config/terrain-materials.json 的 maps.<slot>.layers',
};
fs.writeFileSync(MANIFEST, JSON.stringify(mf, null, 2) + '\n');

const total = written.reduce((a, w) => a + w.kb, 0);
console.log(`[layers] 完成: ${written.length} 个数组 / 共 ${total} KB`
  + `（对比: 旧的单张 color.png 3.4 MB + normal.png 8.5 MB）`);

// ---------------------------------------------------------------------------
// 区域掩码打包(干区/林区) —— 8 层里 dry / forestfloor 两层的权重来源
//   源: blender/terrain/out/tex/mwam/{forest_bake,dry_bake}.png(33_prep_mwam.py 出, 世界域)
//   包: R=forestfloor, G=dry(材质表 regionMasks.packing) ⇒ 游戏侧**1 个采样器**读两层
//   ⚠ 线性数据(权重), 不是颜色 ⇒ 游戏侧按 NoColorSpace 读(与 maskPng 同一约定)。
// ---------------------------------------------------------------------------
if (!has('--no-regions')) {
  const pack = table.regionMasks?.packing || { r: 'forestfloor', g: 'dry' };
  const srcOf = { forestfloor: 'forest_bake.png', dry: 'dry_bake.png' };
  const srcDir = path.join(ROOT, 'blender', 'terrain', 'out', 'tex', 'mwam');
  const rP = path.join(srcDir, srcOf[pack.r] || 'forest_bake.png');
  const gP = path.join(srcDir, srcOf[pack.g] || 'dry_bake.png');
  if (fs.existsSync(rP) && fs.existsSync(gP)) {
    const N = SIZE * SIZE;
    const plane = async (p) => {
      const { data } = await sharp(p).resize(SIZE, SIZE, { kernel: 'lanczos3' })
        .removeAlpha().grayscale().raw().toBuffer({ resolveWithObject: true });
      return data.length >= N ? data.subarray(0, N) : Buffer.concat([data, Buffer.alloc(N - data.length, 0)]);
    };
    const nr = await plane(rP);
    const ng = await plane(gP);
    const rgba = Buffer.alloc(N * 4);
    for (let i = 0; i < N; i++) {
      rgba[i * 4 + 0] = nr[i];
      rgba[i * 4 + 1] = ng[i];
      rgba[i * 4 + 2] = 0;   // 预留(Phase C 的 Filler / sdb 分类)
      rgba[i * 4 + 3] = 255;
    }
    const slots = Object.keys(table.maps || {});
    for (const slot of slots) {
      const dir = path.join(ROOT, 'public', 'custom-maps', slot);
      if (!fs.existsSync(dir)) continue;
      const out = path.join(dir, 'region_masks.png');
      await sharp(rgba, { raw: { width: SIZE, height: SIZE, channels: 4 } })
        .png({ compressionLevel: 9 }).toFile(out);
      console.log(`  OK region_masks  R=${pack.r} G=${pack.g} → `
        + `${path.relative(ROOT, out).replace(/\\/g, '/')}  ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
    }
  } else {
    console.warn(`  [regions] 缺源图(${path.relative(ROOT, rP)} / ${path.relative(ROOT, gP)})`
      + ` ⇒ 跳过区域掩码(dry/forestfloor 两层在游戏里会是 0 权重)`);
  }
}

