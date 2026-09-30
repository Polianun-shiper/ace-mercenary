#!/usr/bin/env node
// scripts/vfx-preview.mjs
//
// 把烘出来的火/烟两趟**按游戏里的混合方式**合成一张预览图 —— 唯一的目的是
// "用肉眼判断游戏里会是什么样", 所以合成模型必须和运行时一字不差:
//
//   1. 烟(normal)    : out = rgb*a + out*(1-a)
//   2. 火(additive)  : A = max(R,G,B)(packer 的 additive-max-rgb 策略, 因为
//                      纯自发光体积的 alpha 本来就≈0); out = out + rgb*A
//   顺序与 src/lib/fx/fx-core.ts 里 makePool 的 renderOrder(smoke=1, fire=2)一致。
//
// 用法:
//   node scripts/vfx-preview.mjs --preset ground --frames 1,6,12,18,24,30,36,42,48
//   node scripts/vfx-preview.mjs --preset air --out .shots/vfx/air.png --cell 320
//
// 产物: .shots/vfx/<preset>-preview.png(横向条: 逐帧)
//
// ★ 会**跳过还没渲完的帧**: 正式烘焙是逐帧覆盖写的, 中途跑这个脚本会读到
//   "一半新一半旧"(旧的还是 32px 的低质探针图)。这里按帧边长把关, 不匹配就跳过,
//   免得拿混合了新旧的结果当依据 —— 这个坑我自己踩过一次。

import sharp from 'sharp';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

const PRESET = flag('preset', 'ground');
const TOKEN = { ground: 'f', air: '4' }[PRESET];
if (!TOKEN) { console.error('未知预设:', PRESET, '(可选 ground / air)'); process.exit(2); }

const OUT = resolve(flag('out', join(ROOT, '.shots', 'vfx', `${PRESET}-preview.png`)));
const CELL = Number(flag('cell', 300));
const GAP = Number(flag('gap', 4));
const SRC = join(ROOT, 'blender', 'vfx', 'out', PRESET);

// 背景用垂直渐变(上天空、下地面尘) —— 中性灰底会把火/烟的边缘看死
const BG_TOP = [138, 164, 190];
const BG_BOT = [104, 96, 84];

// 合成顺序 = 游戏里的 draw 顺序(fx-core.makePool 的 renderOrder):
//   烟(normal) → 冲击波(additive) → 火(additive) → 碎片(normal)。
//   碎片必须**最后**画: 它是深色实体, 靠"挡住火球"才看得见; 放在加性层之前
//   会被加性光整体照亮, 深色尖刺会变成橙色。
//   加性层用 A = max(R,G,B) —— 也就是 packer 的 additive-max-rgb 策略。
const PASSES = [
  { kind: 'smoke', blend: 'normal' },
  { kind: 'wave', blend: 'additive' },
  { kind: 'fire', blend: 'additive' },
  { kind: 'debris', blend: 'normal' },
];

function listFrames(kind) {
  const d = join(SRC, kind);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.startsWith(`${TOKEN}_${kind}_`) && f.endsWith('.png')).sort();
}

function parseFramesArg(all) {
  const raw = flag('frames');
  if (!raw) return all.map((_, i) => i + 1);
  return String(raw).split(',').map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
}

async function main() {
  const framesByKind = {};
  for (const p of PASSES) framesByKind[p.kind] = listFrames(p.kind);
  const base = framesByKind.fire.length ? framesByKind.fire : framesByKind.smoke;
  if (!base.length) { console.error('没有帧, 先跑 30_render.py:', SRC); process.exit(1); }

  const want = parseFramesArg(base);
  const picked = [];
  let size = 0;
  for (const n of want) {
    const idx = n - 1;
    if (idx < 0 || idx >= base.length) continue;
    const layers = [];
    let ok = true;
    let dim = 0;
    for (const p of PASSES) {
      const list = framesByKind[p.kind];
      if (idx >= list.length) continue;
      const path = join(SRC, p.kind, list[idx]);
      const m = await sharp(path).metadata();
      // 关口: 所有存在的趟必须同尺寸(否则就是读到了"半新半旧"的中间状态)
      if (!dim) dim = m.width;
      if (m.width !== dim) { console.log(`  跳过第 ${n} 帧: ${p.kind} 是 ${m.width}px ≠ ${dim}px(那趟还没渲完)`); ok = false; break; }
      layers.push({ ...p, path });
    }
    if (!ok) continue;
    if (!size) size = dim;
    if (dim !== size) { console.log(`  跳过第 ${n} 帧: ${dim}px ≠ 首帧 ${size}px`); continue; }
    picked.push({ n, layers });
  }
  if (!picked.length) { console.error('没有可用的完整帧'); process.exit(1); }

  const W = picked.length * CELL + (picked.length - 1) * GAP;
  const H = CELL;
  const canvas = Buffer.alloc(W * H * 4);
  // 背景渐变(上天空、下地面尘) —— 中性灰底会把火/烟的边缘看死
  for (let y = 0; y < H; y++) {
    const t = y / Math.max(1, H - 1);
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      canvas[o] = Math.round(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t);
      canvas[o + 1] = Math.round(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t);
      canvas[o + 2] = Math.round(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t);
      canvas[o + 3] = 255;
    }
  }

  for (let i = 0; i < picked.length; i++) {
    const { layers, n } = picked[i];
    const ox = i * (CELL + GAP);
    const bufs = [];
    for (const L2 of layers) {
      bufs.push({ ...L2, data: (await sharp(L2.path).ensureAlpha()
        .resize(CELL, CELL, { kernel: 'lanczos3' }).raw().toBuffer({ resolveWithObject: true })).data });
    }
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const si = (y * CELL + x) * 4;
        const di = (y * W + ox + x) * 4;
        let r = canvas[di] / 255, g = canvas[di + 1] / 255, b = canvas[di + 2] / 255;
        for (const L2 of bufs) {
          const d = L2.data;
          if (L2.blend === 'normal') {
            const a = d[si + 3] / 255;
            r = (d[si] / 255) * a + r * (1 - a);
            g = (d[si + 1] / 255) * a + g * (1 - a);
            b = (d[si + 2] / 255) * a + b * (1 - a);
          } else {
            const fr = d[si] / 255, fg = d[si + 1] / 255, fb = d[si + 2] / 255;
            const fa = Math.max(fr, fg, fb);
            r = Math.min(1, r + fr * fa);
            g = Math.min(1, g + fg * fa);
            b = Math.min(1, b + fb * fa);
          }
        }
        canvas[di] = Math.round(r * 255);
        canvas[di + 1] = Math.round(g * 255);
        canvas[di + 2] = Math.round(b * 255);
        canvas[di + 3] = 255;
      }
    }
    console.log(`  合成第 ${n} 帧 (${layers.map((l) => l.kind).join('+')})`);
  }

  mkdirSync(dirname(OUT), { recursive: true });
  await sharp(canvas, { raw: { width: W, height: H, channels: 4 } }).png().toFile(OUT);
  console.log(`\n预览 → ${OUT}  (${picked.length} 帧, 每帧 ${CELL}px)`);
  console.log("合成顺序: 烟 → 冲击波 → 火 → 碎片(与 fx-core 的 renderOrder 一致)");
}

main().catch((e) => { console.error(e); process.exit(1); });
