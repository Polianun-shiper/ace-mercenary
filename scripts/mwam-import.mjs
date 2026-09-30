#!/usr/bin/env node
// scripts/mwam-import.mjs
//
// MW Landscape Auto Material → 地形 KTX2 图层导入。
// 读取 textures-src/mwam/<layer>/{albedo|normal|mask}.png(由
// extract-uasset-mips.mjs 或 export-mwam-from-ue.py 产出),做:
//   1. 法线重映射:源 .uasset 的 "nrm" 通道把 X/Y 存在 G/B、R 接近常数
//      (≈Z),three.js 需要 R=X G=Y B=Z —— 重排为 (G,B,sqrt(1-X²-Y²))。
//   2. sharp 缩放:albedo/mask 4096 → 1024(lanczos3,默认 sRGB 语义);
//      normal 先重映射再缩放,缩放后逐像素重归一化(保持单位向量)。
//   3. basisu ETC1S 编码:public/textures/ktx2/terrain/<layer>/<ch>.ktx2
//      (albedo sRGB;normal/mask 走 -linear),与飞机贴图同一工具链。
//   4. manifest.json 更新:追加 "terrains" 表(只列实际生成的通道),
//      单文件构建据此内联,避免 KTX2_CHANNELS 六通道假设造成的缺失告警。
//
// 可选参数:--size 1024  (输出边长;512/1024/2048)
//          --flip-green (法线 Y 翻转开关,视觉校验用)
// Usage : node scripts/mwam-import.mjs [--size 1024] [--flip-green]

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ROOT = path.join(ROOT, 'textures-src', 'mwam');
const OUT_ROOT = path.join(ROOT, 'public', 'textures', 'ktx2', 'terrain');
const MANIFEST = path.join(ROOT, 'public', 'textures', 'ktx2', 'manifest.json');

const SIZE = (() => {
  const i = process.argv.indexOf('--size');
  const v = i >= 0 ? parseInt(process.argv[i + 1], 10) : 1024;
  return [512, 1024, 2048].includes(v) ? v : 1024;
})();
const FLIP_GREEN = process.argv.includes('--flip-green');

// ===========================================================================
// basisu 编码(与 scripts/ktx2-export.mjs 同一调用约定)
// ===========================================================================
function basisuExe() {
  const pkg = path.join(ROOT, 'node_modules', 'basis_universal');
  if (!fs.existsSync(pkg)) return null;
  const bin = path.join(pkg, 'bin', process.platform === 'win32' ? 'basisu.exe' : 'basisu');
  return fs.existsSync(bin) ? bin : null;
}

function encodeToKtx2(pngPath, outPath, linear) {
  const exe = basisuExe();
  if (!exe) return false;
  const args = [pngPath, '-ktx2', '-mipmap'];
  if (linear) args.push('-linear');
  args.push('-output_file', outPath);
  const r = spawnSync(exe, args, { stdio: 'pipe', encoding: 'utf8', timeout: 180000 });
  if (r.status !== 0) {
    console.warn(`  basisu failed: ${(r.stderr ?? r.stdout ?? '').slice(0, 240)}`);
    return false;
  }
  return fs.existsSync(outPath);
}

// ===========================================================================
// 法线重映射 + 重归一化(纯 raw 字节运算)
// ===========================================================================
const NEUTRAL = 127.5;
/**
 * 源通道顺序 (Rf,Gf,Bf) = (≈Z 常数, X, Y)。three 需要 (R=X, G=Y, B=Z):
 *   out.R = src.G ; out.G = FLIP_GREEN ? 255 - src.B : src.B ; out.B = recZ
 * 输出前重归一化,保证长度 1(缩放插值后法线会偏离单位向量)。
 */
function remapNormalRGBA(src, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const x = (src[o + 1] - NEUTRAL) / NEUTRAL;       // file G → X
    let y = (src[o + 2] - NEUTRAL) / NEUTRAL;         // file B → Y
    if (FLIP_GREEN) y = -y;
    const zsq = 1 - x * x - y * y;
    const z = zsq > 0 ? Math.sqrt(zsq) : 0;
    const inv = 1 / Math.sqrt(x * x + y * y + z * z);
    out[o] = Math.round(x * inv * NEUTRAL + NEUTRAL);
    out[o + 1] = Math.round(y * inv * NEUTRAL + NEUTRAL);
    out[o + 2] = Math.round(z * inv * NEUTRAL + NEUTRAL);
    out[o + 3] = 255;
  }
  return out;
}

function normalizeRawRGBA(buf, w, h) {
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const x = (buf[o] - NEUTRAL) / NEUTRAL;
    const y = (buf[o + 1] - NEUTRAL) / NEUTRAL;
    const z = (buf[o + 2] - NEUTRAL) / NEUTRAL;
    const inv = 1 / Math.sqrt(x * x + y * y + z * z) || 1;
    buf[o] = Math.round(x * inv * NEUTRAL + NEUTRAL);
    buf[o + 1] = Math.round(y * inv * NEUTRAL + NEUTRAL);
    buf[o + 2] = Math.round(z * inv * NEUTRAL + NEUTRAL);
  }
}

// ===========================================================================
// 主流程
// ===========================================================================
async function main() {
  const hasBasisu = !!basisuExe();
  if (!hasBasisu) {
    console.warn('[mwam] basis_universal 未安装(node_modules/basis_universal/bin/basisu.exe)');
    console.warn('[mwam] 先跑: npm i -D basis_universal(运行时将回退程序化画布)');
    return;
  }
  if (!fs.existsSync(SRC_ROOT)) {
    console.error('[mwam] 找不到', SRC_ROOT, '— 先跑 node scripts/extract-uasset-mips.mjs');
    return;
  }

  fs.mkdirSync(OUT_ROOT, { recursive: true });
  console.log(`[mwam] 目标尺寸 ${SIZE}²  flipGreen=${FLIP_GREEN}  输出 ${OUT_ROOT}`);

  const terrains = {};
  const tmpDir = fs.mkdtempSync(path.join(ROOT, '.mwam-tmp-'));
  let okCount = 0, failCount = 0;

  const layers = fs.readdirSync(SRC_ROOT)
    .filter((d) => fs.statSync(path.join(SRC_ROOT, d)).isDirectory())
    .sort();

  for (const layer of layers) {
    const layerDir = path.join(SRC_ROOT, layer);
    const files = fs.readdirSync(layerDir).filter((f) => /\.png$/i.test(f)).sort();
    if (!files.length) continue;
    const outDir = path.join(OUT_ROOT, layer);
    fs.mkdirSync(outDir, { recursive: true });
    const done = [];

    for (const file of files) {
      const channel = path.basename(file, '.png').toLowerCase();
      const src = path.join(layerDir, file);
      const outFile = path.join(outDir, `${channel}.ktx2`);
      const tmpPng = path.join(tmpDir, `${layer}__${channel}.png`);
      try {
        const { data, info } = await sharp(src, { limitInputPixels: false }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const srcW = info.width, srcH = info.height;

        if (channel === 'normal') {
          // 1) 全分辨率重映射(保方向) → 2) 缩放 → 3) 重归一化
          const remapped = remapNormalRGBA(data, srcW, srcH);
          const small = await sharp(remapped, { raw: { width: srcW, height: srcH, channels: 4 } })
            .resize(SIZE, SIZE, { kernel: sharp.kernel.lanczos3 })
            .raw().toBuffer({ resolveWithObject: true });
          normalizeRawRGBA(small.data, SIZE, SIZE);
          await sharp(small.data, { raw: { width: SIZE, height: SIZE, channels: 4 } })
            .png({ compressionLevel: 9 }).toFile(tmpPng);
        } else {
          // albedo / mask:普通缩放(sRGB 语义由运行时 colorSpace 决定)
          await sharp(data, { raw: { width: srcW, height: srcH, channels: info.channels } })
            .resize(SIZE, SIZE, { kernel: sharp.kernel.lanczos3 })
            .png({ compressionLevel: 9 }).toFile(tmpPng);
        }
        const linear = channel !== 'albedo';
        if (encodeToKtx2(tmpPng, outFile, linear)) {
          done.push(channel);
          okCount++;
          const kb = Math.round(fs.statSync(outFile).size / 1024);
          console.log(`  OK  ${layer}/${channel}.ktx2  ${kb}KB  (src ${srcW}×${srcH})`);
        } else {
          failCount++;
        }
      } catch (e) {
        console.warn(`  FAIL ${layer}/${channel}: ${e.message}`);
        failCount++;
      }
    }
    if (done.length) terrains[`terrain/${layer}`] = done;
  }
  // === 层法线 2D 数组导出 (per 采样器预算: 4 张独立 sampler -> 1 个 sampler2DArray) =====
  // 为什么必须做: 地形材质长期贴着 MAX_TEXTURE_IMAGE_UNITS(16), 而"层法线 octave"那个注入
  // 要 4 个独立采样器(14 -> 18 直接爆, 历史上 12 个材质编译失败、地表只剩 skirt), 所以它一直
  // 被禁着。打成 sampler2DArray 后 4 张只占 1 个 ⇒ 既省 3 个采样器, 又能把层法线打开。
  // 数组硬要求: 各层尺寸/mip 数一致 —— 这里用的是与逐槽产出**同一批** tmp PNG
  // (tmpDir/<layer>__normal.png, 已过 remapNormalRGBA + 缩放 + 重归一化), 所以数组里的法线
  // 与逐槽 KTX2 逐字节同源, 不会出现 Y 反/精度不同这类偏差。
  const PRESETS = {
    mountain:    ['dirt', 'grass', 'rock', 'snow'],
    plains:      ['sand_c', 'grass', 'rock', 'snow'],
    desert:      ['sand_a', 'sand_c', 'rock', 'dirt'],
    archipelago: ['sand_a', 'grass', 'rock', 'snow'],
    canyon:      ['dirt', 'sand_c', 'rock', 'snow'],
  };
  const arrays = {};
  for (const [preset, slots] of Object.entries(PRESETS)) {
    const pngs = slots.map((sl) => path.join(tmpDir, sl + '__normal.png'));
    if (!pngs.every((p) => fs.existsSync(p))) {
      console.warn('  [array] ' + preset + ': 有槽缺 normal 源, 跳过');
      continue;
    }
    const exe = basisuExe();
    if (!exe) break;
    const outFile = path.join(OUT_ROOT, 'normal_array_' + preset + '.ktx2');
    const r = spawnSync(exe, [...pngs, '-tex_array', '-ktx2', '-mipmap', '-linear', '-output_file', outFile],
      { stdio: 'pipe', encoding: 'utf8', timeout: 300000 });
    if (r.status === 0 && fs.existsSync(outFile)) {
      arrays['terrain/' + preset] = slots;
      console.log('  OK  normal_array_' + preset + '.ktx2  '
        + Math.round(fs.statSync(outFile).size / 1024) + 'KB  (' + slots.length + ' 层)');
    } else {
      console.warn('  FAIL normal_array_' + preset + ': ' + (r.stderr ?? r.stdout ?? '').slice(0, 200));
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });

  // 更新 manifest.json:保留 sets,写入 terrains(只含实际产出的通道)
  const mfPath = MANIFEST;
  const mf = fs.existsSync(mfPath) ? JSON.parse(fs.readFileSync(mfPath, 'utf8')) : { sets: [] };
  if (!Array.isArray(mf.sets)) mf.sets = [];
  const existing = (mf.terrains && typeof mf.terrains === 'object') ? mf.terrains : {};
  mf.terrains = { ...existing, ...terrains };
  // 层法线数组: { 'terrain/<preset>': [槽名, ...] } —— 槽顺序 = 数组层序(layer 0..3)
  if (Object.keys(arrays).length) mf.arrays = arrays;
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));
  console.log(`\n=== mwam import done: ${okCount} ktx2 OK, ${failCount} failed ===`);
  console.log(`manifest terrains: ${Object.keys(terrains).length} layers → ${MANIFEST}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
