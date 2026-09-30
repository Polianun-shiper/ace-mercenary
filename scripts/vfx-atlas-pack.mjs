#!/usr/bin/env node
// scripts/vfx-atlas-pack.mjs
//
// 爆炸特效序列帧 → 游戏精灵图集 打包器(游戏侧唯一入口)。
//
// 用法:
//   node scripts/vfx-atlas-pack.mjs blender/vfx/out/ground --slot ground
//   node scripts/vfx-atlas-pack.mjs --all                      # 两个预设都打
//   node scripts/vfx-atlas-pack.mjs blender/vfx/out/ground --dry-run
//   node scripts/vfx-atlas-pack.mjs blender/vfx/out/ground --cell 512
//
// 产物:
//   public/textures/vfx/<preset>-fire.png    加性(火球)
//   public/textures/vfx/<preset>-smoke.png   普通混合(烟团)
//   public/textures/vfx/manifest.json        图集登记(保留旧键, 只增不改)
//   public/config/fx-tune.json               ground/air 两槽位资产(引擎直接消费)
//
// 设计理由(与 scripts/blender-pack.mjs 同一套纪律):
//   约定散进场景设置里, 出错时的表现是"画面看着怪但说不出哪错" —— 排查成本极高。
//   所以约定集中在**这一个文件**里校验, 违规直接硬失败、不写任何文件。
//
// 契约(vfx_lib.py 头部同款):
//   1. 色彩管理必须是 view_transform='Standard' + exposure=0 + gamma=1。
//      用了 AgX/Filmic, 火球的饱和度和亮度会在烘焙阶段就被改掉, 且不可逆。
//   2. 相机必须是正交(ORTHO)。透视相机会引入视差, 贴到 billboard 上就是错的。
//   3. 地面预设取景必须是"内容底边贴帧底边"(ground-foot) —— 游戏侧
//      FxBattleLayer 对地面爆炸做 sheetFootLift 抬升, 靠的就是这个对齐。
//   4. 火趟的 alpha 由 packer 改写为 max(R,G,B) (加性混合约定);
//      烟趟必须是直通 alpha, 且全透明像素的 RGB 必须为 0(否则烟带黑边)。

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import sharp from 'sharp';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const VFX_DIR = join(ROOT, 'public', 'textures', 'vfx');
const TUNE_PATH = join(ROOT, 'public', 'config', 'fx-tune.json');
const MANIFEST_PATH = join(VFX_DIR, 'manifest.json');

// 四趟。blend 与 alpha 策略**逐趟不同**, 这是契约的一部分:
//   fire/wave 加性 → alpha 必须改写成 max(R,G,B)(自发光体积的 alpha 本来就≈0)
//   smoke/debris 普通 → 必须直通 alpha(预乘没处理干净就会有黑边)
// 顺序也有对错: 碎片是深色实体, 必须排在加性层**之后**才不会被加性光洗成橙色。
// 这个顺序在资产 JSON 里用 emitter.order 显式写出(见 src/lib/fx/fx-core.ts)。
/** 加性趟的 alpha 约定: A = max(R,G,B) */
const ADDITIVE_ALPHA = 'additive-max-rgb';
const PASSES = [
  { kind: 'fire', blend: 'additive', policy: ADDITIVE_ALPHA, required: true },
  { kind: 'smoke', blend: 'normal', policy: 'straight', required: true },
  // wave/debris 是后加的趟; 老 sidecar 里没有, 允许缺(缺就不打这一趟)
  { kind: 'wave', blend: 'additive', policy: ADDITIVE_ALPHA, required: false },
  { kind: 'debris', blend: 'normal', policy: 'straight', required: false },
];
const passOf = (kind) => PASSES.find((p) => p.kind === kind);
const presentPasses = (sc) => PASSES.filter((p) => sc.passes?.[p.kind]);

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, dflt = undefined) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return (!v || v.startsWith('--')) ? true : v;
};
const has = (name) => argv.includes('--' + name);
const positional = argv.filter((a, i) => !a.startsWith('--') &&
  !(i > 0 && argv[i - 1].startsWith('--') && !argv[i - 1].startsWith('--no-')));

const CELL = flag('cell') ? parseInt(flag('cell'), 10) : 256;
const DRY = has('dry-run');
const NO_TUNE = has('no-tune');
const OUT_DIR = flag('out') ? resolve(flag('out')) : VFX_DIR;
const ALL = has('all');
// === 动画速度倍率 ===
// 2 = 播放时长翻倍 = **动画速度减半**(帧是按粒子寿命均分的, 寿命翻倍就是慢放一倍)。
// 用 --slow <倍数> 可覆盖; 1 = 回到原来速度。
const SLOW = flag('slow') ? Math.max(0.1, parseFloat(flag('slow'))) : 2;

const log = (...a) => console.log('[pack]', ...a);
const fail = (msg) => { console.error('[pack] 硬失败:', msg); process.exit(2); };

// ---------------------------------------------------------------------------
// 1. sidecar 契约校验
// ---------------------------------------------------------------------------
function loadSidecar(dir) {
  const p = join(dir, 'bake.json');
  if (!existsSync(p)) fail(`缺 sidecar: ${p}(先跑 blender/vfx/30_render.py)`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

function validateSidecar(sc, dir) {
  const c = sc.contract || {};
  const errs = [];
  if (c.viewTransform !== 'Standard') {
    errs.push(`viewTransform=${c.viewTransform} 必须是 'Standard' —— ` +
      `AgX/Filmic 会在烘焙阶段就改掉火球的亮度与饱和度, 事后无法还原`);
  }
  if (Number(c.exposure) !== 0) errs.push(`exposure=${c.exposure} 必须是 0`);
  if (Number(c.gamma) !== 1) errs.push(`gamma=${c.gamma} 必须是 1`);
  if (c.cameraProjection !== 'ORTHO') {
    errs.push(`cameraProjection=${c.cameraProjection} 必须是 ORTHO —— ` +
      `透视相机有视差, 贴到 billboard 上是错的`);
  }
  if (c.frameVertical !== 'world +Z') errs.push(`frameVertical=${c.frameVertical} 必须是 'world +Z'`);
  if (c.filmTransparent !== true) errs.push('filmTransparent 必须是 true(alpha 只能来自体积)');

  const wantMode = sc.preset === 'ground' ? 'ground-foot' : 'air-center';
  if (c.framingMode !== wantMode) {
    errs.push(`framingMode=${c.framingMode} 与槽位不匹配(应为 ${wantMode}) —— ` +
      `地面爆炸靠"内容底边贴帧底边"对齐 sheetFootLift`);
  }
  // 地面预设: 内容底边应当就在地面附近
  if (sc.preset === 'ground') {
    const z0 = sc.framing?.bbox?.[2];
    if (!(Math.abs(z0) < 3.0)) {
      errs.push(`framing.bbox 底边 z=${z0} 离地面(z=0)太远 —— 抬升后火球会浮空或埋地`);
    }
  }
  // 每趟帧数必须齐全且一致。缺了不在场但有 required 标记的趟 → 硬失败;
  // wave/debris 是后加的, 老 sidecar 没有它们也允许(缺就不打那一趟)。
  for (const p of PASSES) {
    const info = sc.passes?.[p.kind];
    if (!info) {
      if (p.required) errs.push(`sidecar 缺 ${p.kind} 趟(必需)`);
      else log(`  注: sidecar 里没有 ${p.kind} 趟 —— 跳过该趟(去跑 blender/vfx/${p.kind === 'wave' ? '50_shockwave' : '55_debris'}.py 可以补上)`);
      continue;
    }
    if (info.count !== sc.grid?.frames) {
      errs.push(`${p.kind} 趟帧数 ${info.count} ≠ grid.frames ${sc.grid?.frames}`);
    }
    for (const f of info.files || []) {
      const fp = join(dir, p.kind, f);
      if (!existsSync(fp)) { errs.push(`${p.kind} 趟缺帧文件: ${fp}`); break; }
    }
  }
  for (const p of presentPasses(sc)) {
    const got = sc.contract?.alphaOffsets?.[p.kind];
    if (got !== p.policy) {
      errs.push(`alphaOffsets.${p.kind}=${got}, 期望 ${p.policy}`);
    }
  }
  if (errs.length) {
    fail(`${sc.preset} 的 sidecar 契约不合法(不写任何文件):\n  - ` + errs.join('\n  - '));
  }
  return true;
}

// ---------------------------------------------------------------------------
// 2. 逐帧读取 + alpha 策略 + 降采样
// ---------------------------------------------------------------------------
async function readFrame(path, cell) {
  const img = sharp(path).ensureAlpha();
  const meta = await sharp(path).metadata();
  if (meta.width !== meta.height) {
    log(`  !! 不是正方形帧(${meta.width}x${meta.height}): ${basename(path)} —— 图集格会被拉变形`);
  }
  return img.resize(cell, cell, { fit: 'fill', kernel: 'lanczos3' })
    .raw().toBuffer({ resolveWithObject: true });
}

/**
 * alpha 策略。
 * - additive: A = max(R,G,B)。加性混合是 src.rgb*src.a, 而自发光体积的
 *   alpha 本来就≈0(它不吸收光), 不改写的话游戏里火等于完全不可见。
 * - straight: 若是预乘的就反预乘(那才会产生黑边: 预乘数据的 RGB 已经乘过 alpha,
 *   当直通用会二次衰减)。**直通 alpha 下"alpha=0 而 RGB≠0"是合法的** ——
 *   游戏里 rgb*a=0, 那些像素根本不参与合成。所以这里只把它**清零**(让图集不歧义、
 *   也更利于压缩), 不当作错误。
 *
 *   ⚠ 曾经的判据是"全透明像素 RGB 必须为 0, 否则硬失败", 那条**是错的**:
 *   它把合法的直通数据判成了缺陷, 于是空中档的烟趟被拒、整个打包器 exit(2),
 *   fx-tune.json 一直停在旧内容上 —— 而外面看上去只是"改了没生效", 极难查。
 */
function applyAlphaPolicy(buf, n, kind, alphaMode) {
  let fixed = 0, dirty = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (kind === 'additive') {
      const a = Math.max(buf[o], buf[o + 1], buf[o + 2]);
      if (buf[o + 3] !== a) { buf[o + 3] = a; fixed++; }
    } else {
      if (alphaMode === 'PREMUL') {
        const a = buf[o + 3];
        if (a > 0 && a < 255) {
          buf[o] = Math.min(255, Math.round(buf[o] * 255 / a));
          buf[o + 1] = Math.min(255, Math.round(buf[o + 1] * 255 / a));
          buf[o + 2] = Math.min(255, Math.round(buf[o + 2] * 255 / a));
          fixed++;
        }
      }
      if (buf[o + 3] === 0 && (buf[o] || buf[o + 1] || buf[o + 2])) {
        // 清零(不是报错): 不可见像素的 RGB 没必要留, 留着还会让"直通还是预乘"变得含糊
        buf[o] = 0; buf[o + 1] = 0; buf[o + 2] = 0;
        dirty++;
      }
    }
  }
  return { fixed, dirty };
}

function stats(buf, n, cell) {
  let aMax = 0, aSum = 0, rgbMax = 0, cover = 0, clip = 0, edge = 0, edgeBot = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = buf[o + 3], m = Math.max(buf[o], buf[o + 1], buf[o + 2]);
    aMax = Math.max(aMax, a); aSum += a; rgbMax = Math.max(rgbMax, m);
    if (m > 10) cover++;
    if (m >= 250) clip++;
  }
  // ★ 帧边污染检测: 内容碰到格子边界 → 在游戏里是一条笔直的切边,
  //   看起来就像精灵外面套了个方框。这类缺陷必须能被自动抓住, 不能靠肉眼发现。
  // ★ 帧边污染检测, **分边统计**:
  //   · 左侧/右侧/上侧被内容碰到 → 一定是缺陷(在游戏里就是一条笔直的切边,
  //     看起来像"精灵外面套了个方框");
  //   · 底边被碰到是**地面档的预期行为** —— 游戏按 sheetFootLift 把 quad 底边对齐
  //     命中点, 贴地的扬尘层本来就该压在框底。所以底边不计入缺陷。
  if (cell) {
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const o = (y * cell + x) * 4;
        if (buf[o + 3] <= 8) continue;
        const nearL = x < 2, nearR = x >= cell - 2;
        const nearT = y < 2, nearB = y >= cell - 2;
        if (nearL || nearR || nearT) edge++;
        if (nearB) edgeBot++;
      }
    }
  }
  return {
    alphaMax: aMax, alphaMean: +(aSum / n).toFixed(2),
    rgbMax, coverPct: +(100 * cover / n).toFixed(1), clipPct: +(100 * clip / n).toFixed(1),
    edgePx: edge, edgeBotPx: edgeBot,
  };
}

// ---------------------------------------------------------------------------
// 3. 排图集
// ---------------------------------------------------------------------------
async function packAtlas(dir, sc, passKind, blend) {
  const files = sc.passes[passKind].files;
  const cols = sc.grid.cols, rows = sc.grid.rows;
  const W = cols * CELL, H = rows * CELL;
  const out = Buffer.alloc(W * H * 4, 0);
  const alphaMode = sc.contract.alphaMode || 'STRAIGHT';
  let fixedTotal = 0, dirtyTotal = 0;
  const perFrame = [];

  for (let i = 0; i < files.length; i++) {
    const { data, info } = await readFrame(join(dir, passKind, files[i]), CELL);
    const n = info.width * info.height;
    // ★ 策略由**混合模式**决定, 不是由趟名 —— 之前这里传的是趟名, 于是
    //   fire/wave 都走了 straight 分支, 加性改写整段没生效(冲击波图集
    //   96% 像素不透明, 游戏里会糊一整块不透明方片)。
    const { fixed, dirty } = applyAlphaPolicy(data, n, blend, alphaMode);
    fixedTotal += fixed; dirtyTotal += dirty;
    perFrame.push(stats(data, n, info.width));

    const cx = (i % cols) * CELL, cy = Math.floor(i / cols) * CELL;
    for (let y = 0; y < CELL; y++) {
      const src = y * CELL * 4;
      const dst = ((cy + y) * W + cx) * 4;
      data.copy(out, dst, src, src + CELL * 4);
    }
  }

  // === 硬失败: 空图集 / 火被截成一片白 ===
  const cmax = Math.max(...perFrame.map(f => f.coverPct));
  const edgeBad = perFrame.filter(f => f.edgePx > 0).length;
  const cclip = Math.max(...perFrame.map(f => f.clipPct));
  const errors = [];
  if (cmax < 1.0) errors.push(`所有帧的内容覆盖都 <1%(最大 ${cmax}%) —— 图集基本是空的`);
  if (passKind === 'fire' && cclip > 55) {
    errors.push(`火趟有 ${cclip}% 的像素被截到纯白(>55%) —— 8bit+Standard 下会糊成一坨白球`);
  }
  if (errors.length) fail(`${sc.preset}/${passKind}: \n  - ` + errors.join('\n  - '));

  return { out, W, H, cols, rows, fixedTotal, dirtyTotal, perFrame, cmax, cclip, edgeBad,
           edgePxMax: Math.max(...perFrame.map(f => f.edgePx)),
           edgeBotMax: Math.max(...perFrame.map(f => f.edgeBotPx)) };
}

// ---------------------------------------------------------------------------
// 4. 资产 JSON —— 游戏侧 fx-tune 的 ground/air 两槽
// ---------------------------------------------------------------------------
// 冲击波/闪光这两个发射器的参数与 src/lib/fx/fx-presets.ts:74-94 保持一致 ——
// 那边是"没被 fx-tune 覆盖时的内建预设", 两边观感应当同源。
// (打包器是 .mjs, 没法 import TS, 所以这里是**有意的重复**; 改一处要改两处。)
function lightflash(slot) {
  const air = slot === 'air';
  return {
    type: 'lightflash', id: 'flash', name: '闪光',
    intensity: air ? 42 : 30, radius: air ? 320 : 240, decay: 2,
    duration: air ? 0.22 : 0.28,
    color: air ? '#ffd6a0' : '#ffbe86',
  };
}

/**
 * 用 sidecar 里的真实帧数/fps/取景边长生成资产。
 * lifetime = frames / fps 由这里算 —— 游戏按粒子寿命均分帧(fx-core.ts:464-468),
 * 所以"flipbook 原速播放"就是 lifetime == 帧数/fps, 手写这个数一定会写错。
 *
 * ★ 所有 sprite 发射器共用**同一个 size**: 
 *   ① 它们共用同一个取景框, 图集之间必须像素对齐;
 *   ② fx-core 的 sheetFootLift 取的是"资产内所有 sheet 发射器的最大尺寸"来抬升
 *      整个 play —— 尺寸不一致的话, 小尺寸的那层会被抬到浮空/埋地。
 *
 * ★ order 是**必须显式给**的 draw 顺序(见 fx-core SpriteEmitterCfg.order):
 *   碎片是深色实体, 排在加性层之前会被加性光洗成橙色。
 */
function buildAsset(sc) {
  const slot = sc.slot;
  const frames = sc.grid.frames;
  const fps = sc.sim.fps;
  const flip = frames / fps;                 // flipbook 的原速时长(秒)
  const size = Math.ceil(sc.framing.size);   // quad 边长 = 取景框边长(米)
  const has = (k) => !!sc.passes?.[k];

  const emitter = (kind, cfg) => Object.assign({
    type: 'sprite', mode: 'burst', burstCount: 1, rate: 0,
    // === 一次爆炸只画**一个** ===
    // 以前火 7 颗 + 烟 5 颗, 而**每颗粒子都是整张图集**(size = 取景框边长), 再叠上
    // 横向初速与寿命抖动 ⇒ 一次爆炸被画成七八个大小不一、散开一点的火球堆,
    // 看着像围着圆心摆了一圈。图集本身已经把整个火球/烟团的演化烘进去了,
    // 所以正确做法是**一颗粒子播完整段**, 而不是多颗粒子各播一遍。
    lifetimeJitter: 0,
    // 形变全部来自 flipbook → size0 == size1, 不做二次缩放
    size0: size, size1: size,
    direction: [0, 1, 0], gravity: 0, drag: 0,
    // 位置锁死在爆炸中心: 位移全部来自图集, 粒子本身不动
    speed: 0, spreadCone: 0,
    // spin 会给"贴在机身上的火球"引入错误的旋转 → 关掉;
    // 观感变化交给 lifetimeJitter(只改播放快慢, 不会播一半 —— 帧进度是归一化的)
    spin: 0, spinJitter: 0,
    sheet: {
      url: `/textures/vfx/${sc.preset}-${kind}.png`,
      cols: sc.grid.cols, rows: sc.grid.rows, frames,
      key: `${sc.preset}-${kind}`,
    },
  }, cfg);

  const emitters = [];
  // 烟: 垫底(order 1)
  if (has('smoke')) {
    emitters.push(emitter('smoke', {
      id: 'smoke', name: '烟团', mode: 'burst', order: 1,
      blend: 'normal',
      // 烟比火活得久: flipbook 慢放(帧进度是归一化的, 只会变慢不会播一半)
      lifetime: +(flip * 2.2 * SLOW).toFixed(3),
      color0: '#ffffff', color1: '#c9c3bb',
      opacity0: 0.85, opacity1: 0,
    }));
  }
  // 冲击波: 叠在烟上、火下(order 2)。短促、亮、透明度快速归零
  if (has('wave')) {
    emitters.push(emitter('wave', {
      id: 'wave', name: '冲击波', mode: 'burst', order: 2,
      blend: 'additive',
      lifetime: flip * SLOW, lifetimeJitter: 0,
      color0: '#ffffff', color1: '#ffffff',
      opacity0: 0.9, opacity1: 0.35,
    }));
  }
  // 火: 主体(order 3)
  if (has('fire')) {
    emitters.push(emitter('fire', {
      id: 'fire', name: '火球', mode: 'burst', order: 3,
      blend: 'additive',
      lifetime: +(flip * SLOW).toFixed(3),
      color0: '#ffffff', color1: '#ffffff',
      opacity0: 1, opacity1: 0.85,
    }));
  }
  // 碎片: **最后画**(order 4) —— 深色实体要挡住前面的火才看得见
  if (has('debris')) {
    emitters.push(emitter('debris', {
      id: 'debris', name: '碎片/烟丝', mode: 'burst', order: 4,
      blend: 'normal',
      lifetime: +(flip * SLOW).toFixed(3), lifetimeJitter: 0,
      color0: '#ffffff', color1: '#ffffff',
      opacity0: 1, opacity1: 1,
    }));
  }

  // 闪光: 一次性 PointLight —— 原生爆炸最缺的"照亮机体"那一下不能丢。
  // (代码画的 RingGeometry 冲击波已被烘出来的 wave 精灵取代, 见 PASSES 注释。)
  emitters.push(lightflash(slot));
  return {
    version: 1, id: `__blender_${slot}`, name: `Blender·${slot === 'ground' ? '地面' : '空中'}爆炸`,
    loop: false, slot,
    emitters: emitters.filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// 5. 主流程
// ---------------------------------------------------------------------------
function updateManifest(entries) {
  let m = {};
  if (existsSync(MANIFEST_PATH)) {
    try { m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')); } catch { m = {}; }
  }
  // 保留旧的顶层键(files/grid/cell/frames 仍被 weapons.ts 的旧图集路径引用), 只增不改
  m.atlases = Object.assign({}, m.atlases, entries);
  m.generator = 'blender/vfx + scripts/vfx-atlas-pack.mjs';
  if (!DRY) writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + '\n');
  log('manifest →', MANIFEST_PATH);
}

function writeTune(assets) {
  let doc = { version: 1 };
  if (existsSync(TUNE_PATH)) {
    try { doc = JSON.parse(readFileSync(TUNE_PATH, 'utf8')); } catch { /* 坏的就算了 */ }
  }
  const bySlot = {};
  for (const a of assets) bySlot[a.slot] = a.id;
  doc.slots = Object.assign({}, doc.slots, bySlot);
  // 保留其它来源的资产(例如编辑器手调的), 只替换同 id 的
  const keep = (doc.assets || []).filter(a => !assets.some(n => n.id === a.id));
  doc.assets = keep.concat(assets);
  if (DRY) { log('--dry-run: 不写 fx-tune.json'); return; }
  if (existsSync(TUNE_PATH)) {
    const bak = TUNE_PATH + '.bak';
    copyFileSync(TUNE_PATH, bak);
    log(`  (原 fx-tune.json 已备份为 ${basename(bak)} —— 编辑器导出的内容别丢了)`);
  }
  writeFileSync(TUNE_PATH, JSON.stringify(doc, null, 2) + '\n');
  log('fx-tune →', TUNE_PATH, `槽位 ground=${doc.slots.ground} air=${doc.slots.air}`);
}

async function packPreset(dir, sc) {
  log(`\n=== ${sc.preset} (slot=${sc.slot}, token=${sc.token}) ===`);
  validateSidecar(sc, dir);
  log(`契约 OK: Standard/exposure0/gamma1 · ORTHO · ${sc.contract.framingMode}`);

  const results = {};
  const manifestEntries = {};
  for (const p of presentPasses(sc)) {
    const r = await packAtlas(dir, sc, p.kind, p.blend);
    results[p.kind] = r;
    const outName = `${sc.preset}-${p.kind}.png`;
    const outPath = join(OUT_DIR, outName);
    log(`${p.kind.padEnd(6)} (${p.blend}): ${r.cols}x${r.rows} 格 × ${CELL}px = ${r.W}x${r.H}, ` +
      `覆盖峰值 ${r.cmax}% 截白峰值 ${r.cclip}%` +
      (p.blend === 'additive' ? `, alpha 改写 ${r.fixedTotal} px` : `, 直通/反预乘修正 ${r.fixedTotal} px`) +
      (r.edgePxMax > 0
        ? `  ⚠ 帧边被内容碰到(${r.edgeBad}/${r.perFrame.length} 帧, 最多 ${r.edgePxMax} px) → 游戏里会是笔直切边`
        : '  帧边干净'));
    if (!DRY) {
      mkdirSync(OUT_DIR, { recursive: true });
      await sharp(r.out, { raw: { width: r.W, height: r.H, channels: 4 } })
        .png({ compressionLevel: 9 }).toFile(outPath);
      const bytes = (await import('node:fs')).statSync(outPath).size;
      log(`  → ${outPath}  ${(bytes / 1048576).toFixed(2)} MiB`);
      // === 同步被服务的那份副本 ===
      // dev 构建声明了 __EXTERNAL_ASSETS={root:'assets'} ⇒ 运行时 assetUrl() 会把
      // /textures/vfx/x.png 解析成 assets/textures/vfx/x.png, 由静态服务从
      // dist-test/assets/ 取 —— 那是**构建时拷的旧副本**。不一起更新的话,
      // 你重新打包了图集、游戏里却还是旧的, 而且毫无提示(fx-tune.json 反而是从
      // 仓库 public/ 现取的, 两者行为不一致, 最容易让人白折腾)。
      for (const outRoot of ['dist-test', 'dist-single', 'dist-editor-test']) {
        if (!existsSync(join(ROOT, outRoot))) continue;
        const dstDir = join(ROOT, outRoot, 'assets', 'textures', 'vfx');
        mkdirSync(dstDir, { recursive: true });
        copyFileSync(outPath, join(dstDir, outName));
        log(`     同步 → ${outRoot}/assets/textures/vfx/${outName}`);
      }
    }
    manifestEntries[`${sc.preset}-${p.kind}`] = {
      file: outName, cols: r.cols, rows: r.rows, frames: sc.grid.frames, cell: CELL,
      blend: p.blend, alphaPolicy: p.policy,
      source: `blender/vfx/out/${sc.preset}/${p.kind}`,
      simFps: sc.sim.fps, simSeconds: sc.sim.simSeconds,
      framingSizeM: sc.framing.size,
    };
  }
  updateManifest(manifestEntries);
  const asset = buildAsset(sc);
  // 运行时显存估算: RGBA8 + mipmap(+33%)
  const vram = Object.values(results).reduce((s, r) => s + r.W * r.H * 4 * 1.34, 0);
  const names = asset.emitters.filter((e) => e.type === 'sprite').map((e) => e.sheet.key).join(', ');
  log(`资产: ${asset.id}  size0/size1=${asset.emitters[0].size0}m  ${names}`);
  log(`显存估算(本预设 ${Object.keys(results).length} 趟, 含 mipmap): ${(vram / 1048576).toFixed(1)} MiB`);
  return { asset, vram };
}

async function main() {
  log(`cell=${CELL} slow=${SLOW}x dryRun=${DRY} out=${OUT_DIR}`);
  const targets = [];
  if (ALL) {
    for (const p of ['ground', 'air']) {
      const d = join(ROOT, 'blender', 'vfx', 'out', p);
      if (existsSync(join(d, 'bake.json'))) targets.push({ dir: d, sc: loadSidecar(d) });
      else log(`跳过 ${p}: 还没有 sidecar(先跑 10/20/30 三个 Blender 脚本)`);
    }
  } else {
    const arg = positional[0];
    if (!arg) fail('用法: node scripts/vfx-atlas-pack.mjs <blender/vfx/out/<preset>> [--slot ground|air]');
    const d = resolve(arg);
    const sc = loadSidecar(d);
    if (flag('slot')) sc.slot = flag('slot');
    targets.push({ dir: d, sc });
  }
  if (!targets.length) fail('没有可打包的预设');

  const assets = [];
  let vram = 0;
  for (const t of targets) {
    const { asset, vram: v } = await packPreset(t.dir, t.sc);
    assets.push(asset); vram += v;
  }
  if (!NO_TUNE) writeTune(assets);
  log(`\n完成。图集显存合计约 ${(vram / 1048576).toFixed(1)} MiB(不含烟的 normal 池)`);
}

main().catch(e => { console.error(e); process.exit(1); });
