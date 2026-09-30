#!/usr/bin/env node
// ===========================================================================
// Blender/Gaea 烘焙图导入打包器 (游戏侧唯一入口)
// ===========================================================================
// 职责: 把 Blender 烘出来的(或 Gaea 导出的)通道图,归一化成游戏约定的单张
//       世界域打包图,写进 public/custom-maps/<slot>/,并更新 terrain-tune.json
//       + manifest.json。
//
// 为什么要有"打包器"这一层(而不是让 Blender 直接吐游戏格式):
//   · **约定集中在一处**。世界域 UV、行 0 = −Z、通道顺序、线性/颜色空间、
//     归一化口径,这些一旦分散到 Blender 场景设置里,就会变成"画面看着怪但
//     说不出哪错"。这里全部显式声明 + 校验 + 报错。
//   · 可测试。Blender 不在 CI 里,但本脚本在 —— 可以用合成图跑端到端回归。
//   · 归一化口径固定: GI 按 p95 归一、太阳通道按 (raw / N·L) 去调制,
//     游戏侧只消费 0..1 的乘数。
//
// 通道契约(详见 docs/blender-pipeline.md):
//   R = AO(1=无遮挡)   G = GI(1=全天空)   B = 太阳可见度(1=见太阳)   A = 保留
//
// 用法:
//   # A. 从 Blender 输出目录(含 bake.json sidecar)
//   node scripts/blender-pack.mjs bake/blender --slot custom
//
//   # B. 只拿现成的通道图(Gaea AOExport 等;缺的通道自动填中性值)
//   node scripts/blender-pack.mjs --slot custom \
//        --ao public/custom-maps/custom/ao.jpg \
//        [--gi gi.png] [--sun sun.png] [--normal n.png] [--color c.png]
//
// 常用选项:
//   --res 2048        目标分辨率(2 的幂;缺省取 sidecar/高度包分辨率)
//   --height <f32bin|gz>  高度场(算太阳通道的 N·L 与做朝向自检);缺省从 tune 取
//   --sun-elev/--sun-azim 太阳方向(度);缺省从 sidecar 取
//   --gi 1 --ao 1 --sun 0 --ao-intensity 1     通道强度(写进 tune)
//   --dry-run         只校验 + 打印,不写任何文件
//   --no-tune         只写贴图,不改 terrain-tune.json
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TUNE_PATH = join(ROOT, 'public', 'config', 'terrain-tune.json');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const flag = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1].startsWith('--')));

const DRY = has('--dry-run');
const NO_TUNE = has('--no-tune');
const SLOT = flag('--slot', 'custom');
const RES_ARG = flag('--res') ? Number(flag('--res')) : 0;
const AO_STRENGTH = Number(flag('--ao-intensity', flag('--ao-strength', '1')));
const GI_STRENGTH = Number(flag('--gi', '1'));
const SUN_STRENGTH = Number(flag('--sun', '0'));

const bakeDir = positional[0] && existsSync(positional[0]) ? positional[0] : null;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('[warn]', ...a);
let problems = 0;
const fail = (...a) => { problems++; console.error('[FAIL]', ...a); };

function readTune() {
  return JSON.parse(readFileSync(TUNE_PATH, 'utf8'));
}
function writeTune(doc) {
  writeFileSync(TUNE_PATH, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

/** 读 PNG/JPG 为 8bit 灰度 array(sharp 会做 sRGB→linear? 不会: 我们直接取原始通道)。 */
async function readGray(path) {
  if (!existsSync(path)) throw new Error('找不到文件: ' + path);
  const img = sharp(path, { failOn: 'none' });
  const meta = await img.metadata();
  const { data, info } = await img.removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, channels: info.channels, meta };
}
/** 读 3 通道(法线/颜色)。 */
async function readRgb(path) {
  const img = sharp(path, { failOn: 'none' });
  const { data, info } = await img.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, channels: info.channels };
}

/** 世界域变换: 与游戏 transform.ts 同序(flipY → flipX → rotCW90)。 */
function applyTransform(gray, w, h, tf) {
  let d = gray, W = w, H = h;
  const flip = (dd, ww, hh, axis) => {
    const out = new Uint8Array(dd.length);
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < ww; x++) {
        const sx = axis === 'x' ? ww - 1 - x : x;
        const sy = axis === 'y' ? hh - 1 - y : y;
        out[y * ww + x] = dd[sy * ww + sx];
      }
    }
    return out;
  };
  const rotCW = (dd, ww, hh) => {
    // 顺时针 90°: (x,y) → (hh-1-y, x),新尺寸 hh×ww
    const out = new Uint8Array(dd.length);
    const nw = hh, nh = ww;
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < ww; x++) {
        out[x * nw + (nw - 1 - y)] = dd[y * ww + x];
      }
    }
    return { d: out, w: nw, h: nh };
  };
  if (tf?.flipY) d = flip(d, W, H, 'y');
  if (tf?.flipX) d = flip(d, W, H, 'x');
  const rot = ((tf?.rot ?? 0) % 360 + 360) % 360;
  for (let k = 0; k < rot / 90; k++) {
    const r = rotCW(d, W, H);
    d = r.d; W = r.w; H = r.h;
  }
  return { data: d, w: W, h: H };
}

/** 双线性重采样到 res×res(灰度)。 */
function resample(gray, w, h, res) {
  if (w === res && h === res) return gray;
  const out = new Uint8Array(res * res);
  for (let j = 0; j < res; j++) {
    const fy = (j + 0.5) * h / res - 0.5;
    const y0 = Math.max(0, Math.min(h - 1, Math.floor(fy)));
    const y1 = Math.max(0, Math.min(h - 1, y0 + 1));
    const ty = Math.max(0, Math.min(1, fy - y0));
    for (let i = 0; i < res; i++) {
      const fx = (i + 0.5) * w / res - 0.5;
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(fx)));
      const x1 = Math.max(0, Math.min(w - 1, x0 + 1));
      const tx = Math.max(0, Math.min(1, fx - x0));
      const a = gray[y0 * w + x0] * (1 - tx) + gray[y0 * w + x1] * tx;
      const b = gray[y1 * w + x0] * (1 - tx) + gray[y1 * w + x1] * tx;
      out[j * res + i] = Math.round(a * (1 - ty) + b * ty);
    }
  }
  return out;
}

/** 百分位(0..1 值域)。 */
function percentile(gray, p) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const target = gray.length * p;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) return v / 255;
  }
  return 1;
}
function mean(gray) {
  let s = 0;
  for (let i = 0; i < gray.length; i++) s += gray[i];
  return s / gray.length / 255;
}
function stdev(gray) {
  const m = mean(gray) * 255;
  let s = 0;
  for (let i = 0; i < gray.length; i++) { const dd = gray[i] - m; s += dd * dd; }
  return Math.sqrt(s / gray.length) / 255;
}

/** 从高度包算 N·L(与太阳方向,度)。用于太阳通道去调制 + 朝向自检。 */
function normalDotSun(heightPath, size, sunElevDeg, sunAzimDeg) {
  let raw = readFileSync(heightPath);
  if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) raw = gunzipSync(raw);
  const n = raw.length / 4;
  const res = Math.round(Math.sqrt(n));
  const heights = new Float32Array(raw.buffer, raw.byteOffset, n);
  const cell = size / (res - 1);
  const elev = (sunElevDeg * Math.PI) / 180;
  const azim = (sunAzimDeg * Math.PI) / 180;
  const L = [Math.cos(elev) * Math.sin(azim), Math.sin(elev), Math.cos(elev) * Math.cos(azim)];
  const out = new Float32Array(res * res);
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(res - 1, i + 1);
      const j0 = Math.max(0, j - 1), j1 = Math.min(res - 1, j + 1);
      const dx = (heights[j * res + i1] - heights[j * res + i0]) / ((i1 - i0) * cell);
      const dz = (heights[j1 * res + i] - heights[j0 * res + i]) / ((j1 - j0) * cell);
      // 法线 = normalize(-dx, 1, -dz)
      const inv = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
      const nx = -dx * inv, ny = inv, nz = -dz * inv;
      const nd = nx * L[0] + ny * L[1] + nz * L[2];
      out[j * res + i] = Math.max(0, nd);
    }
  }
  return { ndl: out, res, heights };
}

/** 皮尔逊相关(两个同尺寸灰度) —— 朝向自检用。 */
function corr(a, b) {
  const n = Math.min(a.length, b.length);
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const tune = readTune();
  const mapTune = tune.maps?.[SLOT] ?? (tune.maps = { ...(tune.maps ?? {}), [SLOT]: {} })[SLOT];
  const outDir = join(ROOT, 'public', 'custom-maps', SLOT);
  if (!existsSync(outDir) && !DRY) mkdirSync(outDir, { recursive: true });

  // ---- 1. 收集输入 ----
  let inputs = {};
  let sidecar = null;
  let res = RES_ARG || 2048;
  let sunElev = Number(flag('--sun-elev', 'NaN'));
  let sunAzim = Number(flag('--sun-azim', 'NaN'));
  let size = mapTune.terrain?.externalHeight?.size ?? 48600;
  let maxH = mapTune.terrain?.externalHeight?.maxHeight ?? 4320;

  if (bakeDir) {
    const sp = join(bakeDir, 'bake.json');
    if (!existsSync(sp)) {
      fail(`bake 目录里没有 bake.json sidecar: ${bakeDir}(约定见 docs/blender-pipeline.md)`);
      return finish();
    }
    sidecar = JSON.parse(readFileSync(sp, 'utf8'));
    log(`[sidecar] ${sidecar.format} v${sidecar.version} · Blender ${sidecar.blender ?? '?'}`);
    const conv = sidecar.convention ?? {};
    // 约定自检: 声明缺失就报错(不做"猜")
    for (const k of ['upAxis', 'row0', 'col0']) {
      if (!conv[k]) fail(`sidecar.convention 缺字段 ${k} —— 无法确认坐标系,拒绝导入`);
    }
    if ((conv.upAxis ?? 'Y') !== 'Y') fail(`upAxis=${conv.upAxis}: 游戏是 Y-up。请在 Blender 侧按约定转换(见脚本头)。`);
    if (conv.row0 && conv.row0 !== '-Z') warn(`row0=${conv.row0} ≠ 游戏约定 -Z: 将按 sidecar 的 transform 归一化`);
    if (!conv.channels || conv.channels.R !== 'ao' || conv.channels.G !== 'gi' || conv.channels.B !== 'sun') {
      warn('sidecar.convention.channels 不是标准 R=ao/G=gi/B=sun —— 按标准处理,请核对');
    }
    if ((conv.channelColorspace ?? 'Non-Color') !== 'Non-Color') {
      fail('通道图必须是 Non-Color 线性数据(做了 sRGB 编码会让 AO/GI 数值失真)');
    }
    size = sidecar.world?.size ?? size;
    maxH = sidecar.world?.maxHeight ?? maxH;
    if (!RES_ARG && sidecar.world?.resX) res = sidecar.world.resX;
    sunElev = Number.isNaN(sunElev) ? (sidecar.sun?.elevationDeg ?? 38) : sunElev;
    sunAzim = Number.isNaN(sunAzim) ? (sidecar.sun?.azimuthDeg ?? 145) : sunAzim;
    const f = sidecar.files ?? {};
    inputs = {
      ao: f.ao ? join(bakeDir, f.ao) : null,
      gi: f.gi_raw ? join(bakeDir, f.gi_raw) : (f.gi ? join(bakeDir, f.gi) : null),
      giRaw: !!f.gi_raw,
      sun: f.sun_raw ? join(bakeDir, f.sun_raw) : (f.sun ? join(bakeDir, f.sun) : null),
      sunRaw: !!f.sun_raw,
      normal: f.normal ? join(bakeDir, f.normal) : null,
      color: f.color ? join(bakeDir, f.color) : null,
      transform: conv.transform ?? {},
    };
  } else {
    // 直接给通道图的路径(Gaea AOExport 等)
    // --gi-raw / --sun-raw: 声明"这张图是未归一的烘焙结果",需要去调制/归一化。
    inputs = {
      ao: flag('--ao', null),
      gi: flag('--gi-file', null),
      giRaw: has('--gi-raw'),
      sun: flag('--sun-file', null),
      sunRaw: has('--sun-raw'),
      normal: flag('--normal', null),
      color: flag('--color', null),
      transform: { rot: Number(flag('--rot', '0')), flipX: has('--flip-x'), flipY: has('--flip-y') },
    };
    if (!inputs.ao && !inputs.gi && !inputs.sun) {
      fail('没有输入。给一个 Blender bake 目录,或 --ao/--gi/--sun 至少一张通道图。');
      return finish();
    }
  }
  sunElev = Number.isNaN(sunElev) ? 38 : sunElev;
  sunAzim = Number.isNaN(sunAzim) ? 145 : sunAzim;

  if (!Number.isInteger(Math.log2(res))) fail(`--res ${res} 不是 2 的幂`);
  log(`[world] size=${size} maxHeight=${maxH} res=${res} slot=${SLOT}`);
  log(`[sun] elevation=${sunElev}° azimuth=${sunAzim}°`);

  // ---- 2. 逐通道: 读 → 变换 → 重采样 → 归一化 ----
  const chans = {};
  const stats = {};

  if (inputs.ao) {
    const g = await readGray(inputs.ao);
    let t = applyTransform(g.data, g.w, g.h, inputs.transform);
    let d = resample(t.data, t.w, t.h, res);
    // AO 已是 0..1 乘数,直接用(不做 p95 归一: AO 的物理上界就是 1)
    const m = mean(d), sd = stdev(d);
    stats.ao = { mean: m, stdev: sd };
    log(`[AO]  ${basename(inputs.ao)} ${g.w}² → ${res}²  mean=${m.toFixed(3)} sd=${sd.toFixed(3)}`);
    if (m < 0.5) warn(`AO 均值 ${m.toFixed(3)} 偏低(整体压暗);如非刻意,把 --ao-intensity 调小`);
    if (sd < 0.01) warn('AO 几乎没有变化(可能烘焙失败 / 全白全黑)');
    chans.ao = d;
  } else {
    log('[AO]  未提供 → 填中性 255(不产生遮蔽)');
    chans.ao = new Uint8Array(res * res).fill(255);
  }

  if (inputs.gi) {
    const g = await readGray(inputs.gi);
    let t = applyTransform(g.data, g.w, g.h, inputs.transform);
    let d = resample(t.data, t.w, t.h, res);
    const p95 = percentile(d, 0.95), p50 = percentile(d, 0.5);
    if (inputs.giRaw) {
      // 去归一: raw 是"未归一的间接光辐照度",按 p95 当"全天空参考值"
      const k = p95 > 0.01 ? 1 / p95 : 1;
      log(`[GI]  raw p50=${p50.toFixed(3)} p95=${p95.toFixed(3)} → 按 p95 归一 (×${k.toFixed(3)})`);
      for (let i = 0; i < d.length; i++) d[i] = Math.max(0, Math.min(255, Math.round(d[i] * k)));
    } else {
      log(`[GI]  预归一 p50=${p50.toFixed(3)} p95=${p95.toFixed(3)}`);
    }
    if (p95 / Math.max(p50, 1e-3) < 1.05) warn('GI 通道动态范围几乎为零(可能烘焙没接上间接光)');
    const m = mean(d);
    stats.gi = { mean: m, p95 };
    log(`[GI]  归一后 mean=${m.toFixed(3)}`);
    if (m < 0.15) warn(`GI 均值 ${m.toFixed(3)} 极低 —— 会让地表间接光几乎消失`);
    chans.gi = d;
  } else {
    log('[GI]  未提供 → 填中性 255(不改变间接光)');
    chans.gi = new Uint8Array(res * res).fill(255);
  }

  if (inputs.sun) {
    const g = await readGray(inputs.sun);
    let t = applyTransform(g.data, g.w, g.h, inputs.transform);
    let d = resample(t.data, t.w, t.h, res);
    if (inputs.sunRaw) {
      // raw = N·L × visibility(albedo=1 的 direct pass)→ 除以 N·L 得到纯可见度
      const heightPath = resolveHeightPath(flag('--height', null), mapTune);
      if (!heightPath) {
        warn('没找到高度包,无法把直接光烘焙还原成"纯太阳可见度" → 保守起见填 255(不压直射)');
        d = new Uint8Array(res * res).fill(255);
      } else {
        const { ndl, res: hr } = normalDotSun(heightPath, size, sunElev, sunAzim);
        const ndlRes = resample(floatToU8(ndl, hr), hr, hr, res);
        let good = 0, sumVis = 0;
        for (let i = 0; i < d.length; i++) {
          const nl = ndlRes[i] / 255;
          if (nl > 0.08) {
            const vis = Math.max(0, Math.min(1, (d[i] / 255) / nl));
            d[i] = Math.round(vis * 255);
            good++; sumVis += vis;
          } else {
            d[i] = 255; // 背光面: 直射本来就为 0,可见度无意义 → 置 1 不做额外压暗
          }
        }
        stats.sunVisibleRatio = good ? sumVis / good : 0;
        log(`[SUN] raw → 去 N·L 调制: 受光面平均可见度=${(good ? sumVis / good : 0).toFixed(3)}`);
        // 朝向自检: raw 通道应与 |N·L| 强相关(同域同向时)。相关性低 → 极可能翻转/旋转错。
        const c = corr(g.data, ndlRes);
        stats.sunNdlCorr = c;
        log(`[SUN] 朝向自检 corr(raw, N·L) = ${c.toFixed(3)}`);
        if (c < 0.35) warn('太阳通道与几何 N·L 相关性偏低(朝向/变换可疑,或太阳参数与烘焙时不一致)');
      }
    } else {
      log('[SUN] 预归一(直接当可见度用)');
    }
    if (mean(d) > 0.995) warn('太阳通道几乎全 1(没有产生任何投影遮蔽)');
    const mv = mean(d);
    stats.sun = { mean: mv };
    log(`[SUN] mean=${mv.toFixed(3)}`);
    chans.sun = d;
  } else {
    log('[SUN] 未提供 → 填中性 255(不压直射光)');
    chans.sun = new Uint8Array(res * res).fill(255);
  }

  // ---- 3. 打包 RGBA ----
  const rgba = Buffer.alloc(res * res * 4);
  for (let i = 0; i < res * res; i++) {
    rgba[i * 4] = chans.ao[i];
    rgba[i * 4 + 1] = chans.gi[i];
    rgba[i * 4 + 2] = chans.sun[i];
    rgba[i * 4 + 3] = 255;
  }

  if (problems === 0 && !DRY) {
    const bakePng = join(outDir, 'bake.png');
    // 注意: 不做任何颜色变换(输入是 raw,直接写)。文件里可能带 sRGB 标记,
    // 但游戏按 NoColorSpace 加载 → 数值原样进着色器,这正是我们要的。
    await sharp(rgba, { raw: { width: res, height: res, channels: 4 } })
      .png({ compressionLevel: 9, effort: 8 })
      .toFile(bakePng);
    const kb = (statSync(bakePng).size / 1024).toFixed(0);
    log(`[pack] R=AO G=GI B=SUN A=255 → ${bakePng} ${res}² ${kb} KB`);

    // 法线/色图一起搬过来(世界域,已有约定)
    if (inputs.normal) {
      const dst = join(outDir, 'bake_normal.png');
      await sharp(inputs.normal, { failOn: 'none' }).png().toFile(dst);
      log(`[copy] normal → ${basename(dst)}`);
    }
    if (inputs.color) {
      const dst = join(outDir, 'bake_color.jpg');
      await sharp(inputs.color, { failOn: 'none' }).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toFile(dst);
      log(`[copy] color  → ${basename(dst)}`);
    }
  } else if (DRY) {
    log('[dry-run] 未写任何文件');
  }

  // ---- 4. 写 tune ----
  if (!DRY && !NO_TUNE && problems === 0) {
    const m = (mapTune.material = mapTune.material ?? {});
    m.bakeMap = `/custom-maps/${SLOT}/bake.png`;
    m.bakeMode = 'packed';
    m.bakeAO = AO_STRENGTH;
    m.bakeGI = GI_STRENGTH;
    m.bakeShadow = SUN_STRENGTH;
    // 烘焙 AO 已取代顶点高度图 AO(避免双重变暗);显式写 0 让意图留痕。
    m.macroAO = 0;
    // 外部法线: 世界域(整图烘焙)—— 与 bake 同域,显式声明便于后人核对
    m.normalWorldDomain = true;
    if (inputs.normal) m.normalMap = `/custom-maps/${SLOT}/bake_normal.png`;
    if (inputs.color) m.colorMap = `/custom-maps/${SLOT}/bake_color.jpg`;
    if (m.aoMap) log(`[tune] 保留 aoMap(${m.aoMap}):bakeMap 优先,bakeMap 的 R 通道才是生效的 AO`);
    writeTune(tune);
    log('[tune] public/config/terrain-tune.json 已更新 (material.bakeMap / bakeAO / bakeGI / bakeShadow / macroAO=0)');

    // ---- 5. 写 manifest ----
    const mfPath = join(outDir, 'manifest.json');
    const mf = existsSync(mfPath) ? JSON.parse(readFileSync(mfPath, 'utf8')) : { version: 1, layers: {} };
    mf.world = { size, maxHeight: maxH, resX: res, resY: res };
    mf.layers = mf.layers ?? {};
    mf.layers.M_Bake = {
      file: 'bake.png',
      src: bakeDir ? basename(bakeDir) : 'blender/gaea channels',
      role: 'bake-packed-world(R=AO G=GI B=sun A=reserved, 线性)',
      used: true,
    };
    if (inputs.normal) mf.layers.T_NormalBake = { file: 'bake_normal.png', src: 'blender', role: 'normal-tangent-world', used: true };
    if (inputs.color) mf.layers.T_ColorBake = { file: 'bake_color.jpg', src: 'blender', role: 'albedo-srgb', used: true };
    writeFileSync(mfPath, JSON.stringify(mf, null, 2) + '\n', 'utf8');
    log('[manifest] public/custom-maps/' + SLOT + '/manifest.json 已更新');
  }

  log('\n[stats] ' + JSON.stringify(stats));
  return finish();
}

function resolveHeightPath(explicit, mapTune) {
  if (explicit) return existsSync(explicit) ? explicit : null;
  const url = mapTune?.terrain?.externalHeight?.url;
  if (!url) return null;
  const p = join(ROOT, 'public', url.replace(/^\//, ''));
  return existsSync(p) ? p : null;
}

function floatToU8(arr, res) {
  const out = new Uint8Array(res * res);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(arr[i] * 255)));
  return out;
}

function finish() {
  if (problems > 0) {
    console.error(`\n✗ 有 ${problems} 项硬性问题,已中止(未写文件)。`);
    process.exit(1);
  }
  console.log('\n✓ 打包完成。');
  process.exit(0);
}

main().catch((e) => { console.error('打包失败:', e); process.exit(1); });
