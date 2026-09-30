// === 程序化 PBR 贴图集生成器 (per user request: 现代 PBR 贴图系统) ===
// The game ships zero artist-made textures, so we generate complete PBR
// texture sets (albedo / normal / metallic / roughness / ao / emissive)
// on canvas at runtime. Every set is:
//   - deterministic: seeded by (id + variant), so the same aircraft always
//     gets the same livery across missions and reloads
//   - cached: one set per key, shared by every instance of that model
//   - replaceable: if the build pipeline drops real KTX2 textures for
//     `textures/ktx2/<id>/…` (scripts/ktx2-export.mjs + user assets in
//     textures-src/), TextureManager prefers those over these canvases
//
// NOTE: the aircraft OBJ UV layouts are unknown to us, so the art is
// "generic livery" — base camo + panel lines + rivets + accents — which
// reads correctly on any UV layout. Real artist textures simply replace
// these sets later, no engine change needed.

import * as THREE from 'three';
// Circular import note: texture-manager imports { textureVRAM, clearAllTextureSets }
// from this module; we import { getTextureManager } back for untrack(). All uses
// are runtime function calls (never module-init), so the cycle is safe.
import { getTextureManager } from './texture-manager';
// === 程序化风化场 (per user request: 顶级光泽图质感) =============================
// 与 three / 采样器无关: 只吐像素数组, 由本文件合成进已有的 ORM / albedo 画布。
import { weatheringFields, cavityFromNormal, fieldToCanvas, applyWeatheringToCanvas, seedOf } from './weathering';

export interface PBRTextureSet {
  id: string;
  albedo: THREE.Texture;   // SRGBColorSpace
  normal: THREE.Texture;   // linear
  /**
   * === ORM 单槽 (per 采样器预算) ==========================================
   * R=AO / G=roughness / B=metalness, 与 three 内置通道约定**完全一致**
   * (three 本来就读 roughnessMap.g / metalnessMap.b, aoMap 读 .r)。
   * 为什么必须合成一张: three 的 aoMap / roughnessMap / metalnessMap 各占**一个独立
   * 纹理单元**, 即使三者指向同一张贴图也不省 ⇒ 只有"只喂 aoMap 一个槽 + shader 取 G/B"
   * 才真的少 2 个采样器(见 pbr/materials.ts 的注入)。
   */
  orm?: THREE.Texture;     // linear
  metallic?: THREE.Texture; // linear(旧资产/KTX2 回退用; 走 ORM 时不再绑)
  roughness?: THREE.Texture;// linear(同上)
  ao?: THREE.Texture;       // linear(同上)
  emissive: THREE.Texture; // SRGBColorSpace
}

/** 把 AO / 粗糙度 / 金属度三张灰度画布合成一张 ORM(R=AO, G=roughness, B=metalness)。 */
function composeOrm(cAO: HTMLCanvasElement, cR: HTMLCanvasElement, cM: HTMLCanvasElement): HTMLCanvasElement {
  const [out, octx] = makeCanvas(cAO.width, cAO.height);
  const a = cAO.getContext('2d')!.getImageData(0, 0, cAO.width, cAO.height);
  const r = cR.getContext('2d')!.getImageData(0, 0, cR.width, cR.height);
  const m = cM.getContext('2d')!.getImageData(0, 0, cM.width, cM.height);
  const dst = octx.createImageData(cAO.width, cAO.height);
  for (let i = 0; i < dst.data.length; i += 4) {
    dst.data[i] = a.data[i];         // R = AO
    dst.data[i + 1] = r.data[i];     // G = roughness
    dst.data[i + 2] = m.data[i];     // B = metalness
    dst.data[i + 3] = 255;
  }
  octx.putImageData(dst, 0, 0);
  return out;
}

// Deterministic PRNG so generation is stable across runs.
function seededRand(seed: string): () => number {
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

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  return [c, ctx];
}

function makeTex(c: HTMLCanvasElement, sRGB: boolean): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = sRGB ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
}

// Draw fine-grained HSV noise over the canvas to give the albedo material life.
function addNoise(ctx: CanvasRenderingContext2D, w: number, h: number, rand: () => number, alpha: number, lumaJitter: number) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * 2;
    d[i] = Math.max(0, Math.min(255, d[i] + n * lumaJitter * 255));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n * lumaJitter * 255));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n * lumaJitter * 255));
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

// Draw faint horizontal/vertical panel lines + rivet dots (used by albedo and
// normal). Panel lines are drawn as slightly darker (albedo) or relief
// (normal) thin strokes; rivets as tiny dots along the lines.
function drawPanels(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  rand: () => number,
  kind: 'albedo' | 'normal' | 'metal',
  base: [number, number, number],
) {
  const spacing = Math.max(48, Math.min(96, Math.round(Math.min(w, h) / 8)));
  const seamAlpha = kind === 'albedo' ? 0.35 : kind === 'normal' ? 1 : 0.2;
  ctx.lineWidth = kind === 'normal' ? 2 : 1;
  for (let y = 0; y < h; y += spacing) {
    const off = Math.round((rand() - 0.5) * spacing * 0.4);
    const yy = (y + off + h) % h;
    // Horizontal seam
    if (kind === 'normal') {
      ctx.strokeStyle = 'rgba(60,60,120,1)';
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(w, yy); ctx.stroke();
      ctx.strokeStyle = 'rgba(210,210,255,1)';
      ctx.beginPath(); ctx.moveTo(0, yy + 2); ctx.lineTo(w, yy + 2); ctx.stroke();
    } else {
      ctx.strokeStyle = `rgba(0,0,0,${seamAlpha})`;
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(w, yy); ctx.stroke();
    }
    // Rivets along the seam
    for (let x = 0; x < w; x += spacing / 2) {
      if (rand() < 0.35) continue;
      const xo = Math.round(x + (rand() - 0.5) * spacing * 0.5);
      if (kind === 'normal') {
        ctx.fillStyle = 'rgba(140,140,190,1)';
        ctx.beginPath(); ctx.arc(xo, yy + 2, 1.6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(40,40,80,1)';
        ctx.beginPath(); ctx.arc(xo + 1.6, yy + 4, 1.6, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = `rgba(0,0,0,${seamAlpha * 0.7})`;
        ctx.fillRect(xo, yy + 1, 2, 2);
      }
    }
  }
  for (let x = 0; x < w; x += spacing) {
    const off = Math.round((rand() - 0.5) * spacing * 0.4);
    const xx = (x + off + w) % w;
    if (kind === 'normal') {
      ctx.strokeStyle = 'rgba(60,60,120,1)';
      ctx.beginPath(); ctx.moveTo(xx, 0); ctx.lineTo(xx, h); ctx.stroke();
      ctx.strokeStyle = 'rgba(210,210,255,1)';
      ctx.beginPath(); ctx.moveTo(xx + 2, 0); ctx.lineTo(xx + 2, h); ctx.stroke();
    } else {
      ctx.strokeStyle = `rgba(0,0,0,${seamAlpha})`;
      ctx.beginPath(); ctx.moveTo(xx, 0); ctx.lineTo(xx, h); ctx.stroke();
    }
  }
}

// Decode a base colour into per-zone tints for the livery.
// === 显存修复 (per user request: 显存回收) ===
// The albedo base is colour-NEUTRAL: the hue comes from
// MeshStandardMaterial.color at the material level, so one texture set is
// shared by every aircraft of the same (model, paint scheme) regardless of
// paint colour. Otherwise every colour variant cached its own ~45MB set and
// switching paints grew VRAM without bound.
interface Livery {
  base: [number, number, number];
  spine: [number, number, number];   // fuselage spine / canopy zone
  belly: [number, number, number];   // underside shading
  accent: [number, number, number];  // tip accents / markings
  camo: boolean;
  dark: boolean;
}

function makeLivery(scheme: string): Livery {
  // Neutral grey-green skin; hue comes from the material tint.
  const base: [number, number, number] = [0.53, 0.55, 0.52];
  const shade = (f: number): [number, number, number] =>
    [base[0] * f, base[1] * f, base[2] * f];
  const tint = (add: number): [number, number, number] =>
    [base[0] + add, base[1] + add, base[2] + add];
  const camo = scheme === 'camo';
  // Accent derived from scheme: aggressor → light blue tips, stealth → amber,
  // everything else → roundel red.
  const accent: [number, number, number] =
    scheme === 'aggressor' ? [0.55, 0.75, 0.95]
    : scheme === 'stealth' ? [1.0, 0.72, 0.3]
    : [0.75, 0.2, 0.2];
  return {
    base,
    spine: tint(0.06),
    belly: shade(0.85),
    accent,
    camo,
    dark: false,
  };
}

// === Aircraft texture set (per user request: 战机 PBR 贴图) ===
// 1024² albedo + 512² aux at high quality; halved per tier. A 10-unit-long
// model viewed from a chase cam never resolves 2048², so this is visually
// identical while using ~1/4 the VRAM of the original 2048² sets.
// (Real artist textures go through the KTX2+Basis pipeline instead.)
// Feature layout is UV-agnostic so it works on any OBJ unwrap:
//   - base livery colour + noise + panel lines + rivets
//   - camo blobs for camo schemes
//   - spine strip, radome tint, wingtip accent bands, tail roundel
const aircraftCache = new Map<string, PBRTextureSet>();
// Least-recently-used order (most recently used at the END). Evicts + frees
// GPU textures when the cache exceeds the cap, so paint switching / model
// cycling can't grow VRAM without bound.
const aircraftLru: string[] = [];
const MAX_AIRCRAFT_SETS = 12;

function lruTouch(key: string) {
  const i = aircraftLru.indexOf(key);
  if (i >= 0) aircraftLru.splice(i, 1);
  aircraftLru.push(key);
}

function lruEvict() {
  while (aircraftLru.length > MAX_AIRCRAFT_SETS) {
    const old = aircraftLru.shift()!;
    const set = aircraftCache.get(old);
    if (set) disposeTextureSet(set);
    aircraftCache.delete(old);
  }
}

/** Free GPU/CPU memory of a texture set (all 6 channels). */
export function disposeTextureSet(set: PBRTextureSet) {
  for (const t of [set.albedo, set.normal, set.orm, set.metallic, set.roughness, set.ao, set.emissive]) {
    if (!t) continue;   // ORM 与旧三槽互斥, 可能有空的
    // Drop the manager's strong reference so the texture object (and its
    // canvas backing store) can be GC'd — otherwise tracked grows forever.
    getTextureManager().untrack(t);
    t.dispose();
  }
}

/** Drop every cached procedural texture set and free its VRAM. */
export function clearAllTextureSets() {
  for (const s of aircraftCache.values()) disposeTextureSet(s);
  for (const s of unitCache.values()) disposeTextureSet(s);
  for (const d of buildingDetailCache.values()) {
    d.normal.dispose();
    d.ao.dispose();
  }
  aircraftCache.clear();
  aircraftLru.length = 0;
  unitCache.clear();
  buildingDetailCache.clear();
}

// === 生成耗时统计 (per user request: 程序化生成的代价是启动时间) ================
// 程序化贴图的"成本"全在生成时的那几毫秒里(单文件体积为 0)。探针通过
// window.__texGenStats / window.__texBench 读这里的数字, 用于"改前/改后"对比。
interface TexGenStat { id: string; ms: number; w: number; h: number }
const texGenStats: TexGenStat[] = [];

/** `?texdump` 时把生成的画布留在 window 上, 供探针导出 PNG(验收用)。 */
// ⚠ 探针的 `#autotest&…` 全部在 hash 里, search 永远是空的 —— 两处都要查。
const TEX_DUMP = typeof location !== 'undefined'
  && /(^|[?&#])texdump/.test((location.search || '') + (location.hash || ''));
const dumpedCanvases: Record<string, HTMLCanvasElement> = {};

function installTexHooks() {
  if (typeof window === 'undefined' || (window as unknown as { __texHooked?: boolean }).__texHooked) return;
  const w = window as unknown as Record<string, unknown>;
  w.__texHooked = true;
  w.__texGenStats = texGenStats;
  if (TEX_DUMP) w.__texCanvases = dumpedCanvases;
}

export function getAircraftTextureSet(
  model: string,
  scheme: string,
  quality: 'low' | 'medium' | 'high',
): PBRTextureSet {
  const key = `${model}|${scheme}|${quality}`;
  const hit = aircraftCache.get(key);
  if (hit) {
    lruTouch(key);
    return hit;
  }

  const t0 = performance.now();
  const canv = generateAircraftCanvases(model, scheme, quality);
  const tGen = performance.now() - t0;
  texGenStats.push({ id: canv.id, ms: Math.round(tGen * 100) / 100, w: canv.w, h: canv.h });
  if (texGenStats.length > 64) texGenStats.shift();
  installTexHooks();

  const set: PBRTextureSet = {
    id: canv.id,
    albedo: makeTex(canv.cA, true),
    normal: makeTex(canv.cN, false),
    orm: makeTex(composeOrm(canv.cAO, canv.cR, canv.cM), false),   // R=AO/G=rough/B=metal 一槽搞定
    emissive: makeTex(canv.cE, true),
  };
  aircraftCache.set(key, set);
  lruTouch(key);
  lruEvict();
  return set;
}

interface AircraftCanvases {
  id: string; w: number; h: number;
  cA: HTMLCanvasElement; cN: HTMLCanvasElement; cM: HTMLCanvasElement;
  cR: HTMLCanvasElement; cAO: HTMLCanvasElement; cE: HTMLCanvasElement;
}

/** 纯画布生成(不建 THREE.Texture、不进缓存) —— 便于探针重复计时。 */
function generateAircraftCanvases(
  model: string,
  scheme: string,
  quality: 'low' | 'medium' | 'high',
): AircraftCanvases {
  const key = `${model}|${scheme}|${quality}`;
  const albW = quality === 'high' ? 1024 : quality === 'medium' ? 512 : 256;
  const auxW = quality === 'high' ? 512 : quality === 'medium' ? 256 : 128;
  const rand = seededRand(key);
  // 每张画布一条**同种子的新流**: 板缝/铆钉在 albedo / normal / metal / AO 四张图上
  // 拿到逐像素一致的位置(共用一条流会让第 2 次调用接着上次的位置继续 → 错开半格,
  // 于是"从法线派生的板缝掩膜"与 albedo 上画的板缝对不上)。
  const panelRand = () => seededRand(key + '|panels');
  const livery = makeLivery(scheme);
  const [cA, ctxA] = makeCanvas(albW, albW);
  const [cN, ctxN] = makeCanvas(auxW, auxW);
  const [cM, ctxM] = makeCanvas(auxW, auxW);
  const [cR, ctxR] = makeCanvas(auxW, auxW);
  const [cAO, ctxAO] = makeCanvas(auxW, auxW);
  const [cE, ctxE] = makeCanvas(auxW, auxW);

  const r255 = (c: [number, number, number]) =>
    `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
  const rgba = (c: [number, number, number], a: number) =>
    `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

  // --- ALBEDO ---
  // Base coat
  ctxA.fillStyle = r255(livery.base);
  ctxA.fillRect(0, 0, albW, albW);
  // Belly shading along the bottom edge (UV-agnostic: darker lower half band)
  const bellyGrad = ctxA.createLinearGradient(0, albW * 0.6, 0, albW);
  bellyGrad.addColorStop(0, rgba(livery.belly, 0));
  bellyGrad.addColorStop(1, rgba(livery.belly, 1));
  ctxA.fillStyle = bellyGrad;
  ctxA.fillRect(0, 0, albW, albW);
  // Spine strip along the top edge
  const spineGrad = ctxA.createLinearGradient(0, 0, 0, albW * 0.25);
  spineGrad.addColorStop(0, rgba(livery.spine, 1));
  spineGrad.addColorStop(1, rgba(livery.spine, 0));
  ctxA.fillStyle = spineGrad;
  ctxA.fillRect(0, 0, albW, albW);
  // Camo blobs (military schemes)
  if (livery.camo) {
    const blobCols: [number, number, number][] = [
      shade(livery.base, 1.35), shade(livery.base, 0.75), shade(livery.base, 0.55),
    ];
    for (let i = 0; i < 26; i++) {
      const bx = rand() * albW, by = rand() * albW;
      const bw = albW * (0.06 + rand() * 0.14), bh = albW * (0.04 + rand() * 0.1);
      ctxA.fillStyle = rgba(blobCols[i % 3], 0.75);
      ctxA.beginPath();
      ctxA.ellipse(bx, by, bw, bh, rand() * Math.PI, 0, Math.PI * 2);
      ctxA.fill();
    }
  }
  // Panel lines + rivets
  drawPanels(ctxA, albW, albW, panelRand(), 'albedo', livery.base);
  // Radome tint — a horizontal band around the nose zone (UV bottom-left
  // region is typically the nose; a diagonal band covers either orientation).
  ctxA.fillStyle = rgba(shade(livery.base, 0.8), 0.55);
  ctxA.beginPath();
  ctxA.moveTo(0, albW * 0.08); ctxA.lineTo(albW * 0.42, 0);
  ctxA.lineTo(albW * 0.58, 0); ctxA.lineTo(albW * 0.16, albW * 0.08);
  ctxA.closePath(); ctxA.fill();
  // Wingtip accent bands (two vertical stripes near the edges)
  ctxA.fillStyle = rgba(livery.accent, 0.9);
  ctxA.fillRect(albW * 0.03, 0, Math.max(4, albW * 0.015), albW);
  ctxA.fillRect(albW * 0.955, 0, Math.max(4, albW * 0.015), albW);
  // Tail roundel (small circle near top-right)
  ctxA.fillStyle = rgba(livery.accent, 1);
  ctxA.beginPath();
  ctxA.arc(albW * 0.82, albW * 0.12, albW * 0.028, 0, Math.PI * 2);
  ctxA.fill();
  ctxA.fillStyle = rgba([0.95, 0.95, 0.95], 0.9);
  ctxA.beginPath();
  ctxA.arc(albW * 0.82, albW * 0.12, albW * 0.013, 0, Math.PI * 2);
  ctxA.fill();
  // Weathering: faint streaks + noise
  ctxA.globalCompositeOperation = 'multiply';
  for (let i = 0; i < 10; i++) {
    const x = rand() * albW;
    const grad = ctxA.createLinearGradient(x, 0, x + 20, albW);
    grad.addColorStop(0, 'rgba(50,50,50,0)');
    grad.addColorStop(0.5, 'rgba(50,50,50,0.25)');
    grad.addColorStop(1, 'rgba(50,50,50,0)');
    ctxA.fillStyle = grad;
    ctxA.fillRect(x, 0, 24, albW);
  }
  ctxA.globalCompositeOperation = 'source-over';
  addNoise(ctxA, albW, albW, rand, 1, 0.05);
  // (albedo 上的积灰在下面的风化场算完之后统一叠 —— 见 "WEATHERING" 段)

  // --- NORMAL ---
  // ⚠ 面板布局必须与 albedo / AO / metal 上画的**完全同位置** —— 见 panelRand 的说明。
  ctxN.fillStyle = 'rgb(128,128,255)';
  ctxN.fillRect(0, 0, auxW, auxW);
  drawPanels(ctxN, auxW, auxW, panelRand(), 'normal', [0, 0, 0]);
  // Canopy bump (soft raised ellipse)
  const canGrad = ctxN.createRadialGradient(auxW * 0.5, auxW * 0.2, 4, auxW * 0.5, auxW * 0.2, auxW * 0.18);
  canGrad.addColorStop(0, 'rgb(190,190,255)');
  canGrad.addColorStop(1, 'rgb(128,128,255)');
  ctxN.fillStyle = canGrad;
  ctxN.beginPath(); ctxN.ellipse(auxW * 0.5, auxW * 0.2, auxW * 0.16, auxW * 0.05, 0, 0, Math.PI * 2); ctxN.fill();
  addNoise(ctxN, auxW, auxW, rand, 1, 0.08);

  // --- METALLIC (grayscale: 0 = dielectric, 255 = metal) ---
  // Baseline: skin slightly metallic; radome/nozzle bands differ.
  const baseMetal = livery.dark ? 150 : 110;
  ctxM.fillStyle = `rgb(${baseMetal},${baseMetal},${baseMetal})`;
  ctxM.fillRect(0, 0, auxW, auxW);
  // Nozzle/engine zone (bottom band) high metal
  ctxM.fillStyle = `rgba(210,210,210,0.8)`;
  ctxM.fillRect(0, auxW * 0.86, auxW, auxW * 0.14);
  // Radome zone low metal
  ctxM.fillStyle = `rgba(20,20,20,0.8)`;
  ctxM.beginPath();
  ctxM.moveTo(0, auxW * 0.08); ctxM.lineTo(auxW * 0.42, 0);
  ctxM.lineTo(auxW * 0.58, 0); ctxM.lineTo(auxW * 0.16, auxW * 0.08);
  ctxM.closePath(); ctxM.fill();
  drawPanels(ctxM, auxW, auxW, panelRand(), 'metal', [0, 0, 0]);
  addNoise(ctxM, auxW, auxW, rand, 1, 0.12);

  // === ROUGHNESS: 几何派生掩膜 + 多尺度风化 (per user request: 顶级光泽图质感) ===
  // 以前这里只有"一片灰 + 底部一圈烟熏 + 白噪声", 所以太阳扫过时机身没有任何
  // "磨亮的板边 / 积灰的板缝 / 一块块蒙皮"的层次。现在从**刚画好的法线图**里算
  // cavity/curvature(散度), 再叠多尺度风化 —— 细节天然锁在几何上, 且不新增纹理
  // (仍然只是这张 ORM 的 G 通道), 不加采样器。
  const baseRough = 120;
  const wf = weatheringFields({
    w: auxW,
    h: auxW,
    seed: seedOf(key + '|weather'),
    level: quality,
    base: baseRough / 255,
    cavity: cavityFromNormal(ctxN.getImageData(0, 0, auxW, auxW).data, auxW, auxW, auxW >= 512 ? 2 : 1),
  });
  ctxR.drawImage(fieldToCanvas(wf.rough, auxW, auxW), 0, 0);
  // 喷口烟熏: 参考图里尾部一定是被熏黑+烤哑光的(保留原来的那条带, 叠在风化之上)
  ctxR.fillStyle = 'rgba(255,255,255,0.55)';
  ctxR.fillRect(0, auxW * 0.88, auxW, auxW * 0.12);
  // albedo 也吃同一份风化场: 缝里积灰压暗、磨亮的板边微微提亮。分辨率不同
  // (albedo 1024² / 场 512²), applyWeatheringToCanvas 内部按比例取样。
  applyWeatheringToCanvas(cA, wf, { dirt: 0.30, sheen: 0.13 });

  // --- AO (grayscale: 0 = fully occluded, 255 = open) ---
  ctxAO.fillStyle = 'rgb(255,255,255)';
  ctxAO.fillRect(0, 0, auxW, auxW);
  // Wing roots / panel gaps / canopy base get darker — approximate with
  // bands + vignette so any UV layout picks up *some* cavity shading.
  const vg = ctxAO.createRadialGradient(auxW / 2, auxW / 2, auxW * 0.2, auxW / 2, auxW / 2, auxW * 0.75);
  vg.addColorStop(0, 'rgba(255,255,255,1)');
  vg.addColorStop(1, 'rgba(190,190,190,1)');
  ctxAO.fillStyle = vg;
  ctxAO.fillRect(0, 0, auxW, auxW);
  ctxAO.fillStyle = 'rgba(150,150,150,0.6)';
  ctxAO.fillRect(0, auxW * 0.88, auxW, auxW * 0.12); // nozzle cavity
  ctxAO.fillStyle = 'rgba(160,160,160,0.5)';
  ctxAO.fillRect(0, 0, auxW, auxW * 0.04); // spine shadow
  drawPanels(ctxAO, auxW, auxW, panelRand(), 'albedo', [0, 0, 0]);
  // 同一个风化场再压 AO: **凹处(板缝/铆钉坑)积灰变暗** —— 与粗糙度用的是同一份掩膜,
  // 所以"缝更粗糙"和"缝更脏"永远同步(参考图里这两件事是同一件事)。
  applyWeatheringToCanvas(cAO, wf, { dirt: 0.55, sheen: 0.10 });
  addNoise(ctxAO, auxW, auxW, rand, 1, 0.1);

  // --- EMISSIVE (navigation lights + strobe) ---
  ctxE.fillStyle = 'rgba(0,0,0,0)';
  ctxE.clearRect(0, 0, auxW, auxW);
  // Red port light (left edge), green starboard (right edge), white strobes
  ctxE.fillStyle = 'rgba(255,40,40,1)';
  ctxE.beginPath(); ctxE.arc(auxW * 0.04, auxW * 0.5, auxW * 0.012, 0, Math.PI * 2); ctxE.fill();
  ctxE.fillStyle = 'rgba(40,255,40,1)';
  ctxE.beginPath(); ctxE.arc(auxW * 0.96, auxW * 0.5, auxW * 0.012, 0, Math.PI * 2); ctxE.fill();
  ctxE.fillStyle = 'rgba(255,255,255,1)';
  ctxE.beginPath(); ctxE.arc(auxW * 0.5, auxW * 0.06, auxW * 0.008, 0, Math.PI * 2); ctxE.fill();
  ctxE.beginPath(); ctxE.arc(auxW * 0.5, auxW * 0.94, auxW * 0.008, 0, Math.PI * 2); ctxE.fill();

  const id = `aircraft/${model}-${scheme}`;
  if (TEX_DUMP) {
    // 导出用: 粗糙度画布 + 合成后的 ORM(G 通道 = roughness)。
    dumpedCanvases[`${id}|rough|${quality}`] = cR;
    dumpedCanvases[`${id}|orm|${quality}`] = composeOrm(cAO, cR, cM);
    dumpedCanvases[`${id}|normal|${quality}`] = cN;
    dumpedCanvases[`${id}|albedo|${quality}`] = cA;
  }
  return { id, w: albW, h: auxW, cA, cN, cM, cR, cAO, cE };
}

function shade(c: [number, number, number], f: number): [number, number, number] {
  return [Math.min(1, c[0] * f), Math.min(1, c[1] * f), Math.min(1, c[2] * f)];
}

// === Shared ground-unit / vehicle texture set ===
// One 1024² set for tanks / AA / SAM / ships / props — tinted per-unit by the
// material's color (MeshStandardMaterial.color multiplies the albedo map).
const unitCache = new Map<string, PBRTextureSet>();

export function getUnitTextureSet(variant: string, quality: 'low' | 'medium' | 'high'): PBRTextureSet {
  const key = `${variant}|${quality}`;
  const hit = unitCache.get(key);
  if (hit) return hit;
  const W = quality === 'high' ? 512 : quality === 'medium' ? 256 : 128;
  const rand = seededRand(key);
  const [cA, ctxA] = makeCanvas(W, W);
  const [cN, ctxN] = makeCanvas(W, W);
  const [cM, ctxM] = makeCanvas(W, W);
  const [cR, ctxR] = makeCanvas(W, W);
  const [cAO, ctxAO] = makeCanvas(W, W);
  const [cE, ctxE] = makeCanvas(W, W);

  // Albedo: neutral grey-green base + panel lines + dirt
  ctxA.fillStyle = '#6a6a60';
  ctxA.fillRect(0, 0, W, W);
  drawPanels(ctxA, W, W, rand, 'albedo', [0.42, 0.42, 0.38]);
  // Dirt band at the bottom (tracks/keel)
  ctxA.fillStyle = 'rgba(60,50,35,0.6)';
  ctxA.fillRect(0, W * 0.8, W, W * 0.2);
  addNoise(ctxA, W, W, rand, 1, 0.08);

  const panelRand = () => seededRand(key + '|panels');
  ctxN.fillStyle = 'rgb(128,128,255)';
  ctxN.fillRect(0, 0, W, W);
  drawPanels(ctxN, W, W, panelRand(), 'normal', [0, 0, 0]);
  addNoise(ctxN, W, W, rand, 1, 0.06);

  ctxM.fillStyle = 'rgb(90,90,90)';
  ctxM.fillRect(0, 0, W, W);
  addNoise(ctxM, W, W, rand, 1, 0.15);

  // === 车辆/地面单位: 同一套几何派生风化 (per user request: 顶级光泽图质感) ===
  // 和机体同一条路: 从刚画好的法线派生板缝/铆钉掩膜 → 缝里积灰更糙、凸边磨亮。
  const wf = weatheringFields({
    w: W, h: W, seed: seedOf(key + '|weather'), level: quality,
    base: 140 / 255,
    cavity: cavityFromNormal(ctxN.getImageData(0, 0, W, W).data, W, W, W >= 512 ? 2 : 1),
  });
  ctxR.drawImage(fieldToCanvas(wf.rough, W, W), 0, 0);
  ctxR.fillStyle = 'rgba(255,255,255,0.5)';
  ctxR.fillRect(0, W * 0.8, W, W * 0.2);   // 履带/龙骨带的泥

  ctxAO.fillStyle = 'rgb(255,255,255)';
  ctxAO.fillRect(0, 0, W, W);
  ctxAO.fillStyle = 'rgba(160,160,160,0.6)';
  ctxAO.fillRect(0, W * 0.8, W, W * 0.2);
  applyWeatheringToCanvas(cAO, wf, { dirt: 0.5, sheen: 0.10 });
  addNoise(ctxAO, W, W, rand, 1, 0.1);

  ctxE.clearRect(0, 0, W, W);

  const set: PBRTextureSet = {
    id: `unit/${variant}`,
    albedo: makeTex(cA, true),
    normal: makeTex(cN, false),
    orm: makeTex(composeOrm(cAO, cR, cM), false),   // R=AO/G=rough/B=metal 一槽搞定
    emissive: makeTex(cE, true),
  };
  unitCache.set(key, set);
  return set;
}

// === Building window texture detail channels ===
// The city already bakes 4 window albedo textures; this adds matching
// normal (window-grid relief) + ao (grime) channels so the same materials
// become full PBR sets. Keyed by the same params makeBuildingTexture uses.
const buildingDetailCache = new Map<string, { normal: THREE.Texture; ao: THREE.Texture }>();

export function getBuildingDetailChannels(kind: 'glass' | 'office' | 'residential' | 'landmark'): {
  normal: THREE.Texture;
  ao: THREE.Texture;
} {
  const hit = buildingDetailCache.get(kind);
  if (hit) return hit;
  const W = 256;
  const rand = seededRand(`building-${kind}`);
  const [cN, ctxN] = makeCanvas(W, W);
  const [cAO, ctxAO] = makeCanvas(W, W);

  // Window grid relief — matches the albedo window density roughly:
  // glass 24×18, office 28×22, residential 18×16, landmark 32×28.
  const winW = kind === 'office' ? 28 : kind === 'residential' ? 18 : kind === 'landmark' ? 32 : 24;
  const winH = kind === 'office' ? 22 : kind === 'residential' ? 16 : kind === 'landmark' ? 28 : 18;
  const cols = Math.floor(W / winW);
  const rows = Math.floor(W / winH);
  ctxN.fillStyle = 'rgb(128,128,255)';
  ctxN.fillRect(0, 0, W, W);
  ctxAO.fillStyle = 'rgb(255,255,255)';
  ctxAO.fillRect(0, 0, W, W);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const px = x * winW, py = y * winH;
      // Window frame recess (normal dip) + ao shadow
      ctxN.fillStyle = 'rgba(110,110,235,1)';
      ctxN.fillRect(px + 2, py + 2, winW - 4, winH - 4);
      ctxAO.fillStyle = 'rgba(225,225,225,1)';
      ctxAO.fillRect(px + 2, py + 2, winW - 4, winH - 4);
      // Glass inset highlight
      if (rand() < 0.6) {
        ctxN.fillStyle = 'rgba(150,150,255,1)';
        ctxN.fillRect(px + 6, py + 6, winW - 12, winH - 12);
      }
      // Grime between windows
      ctxAO.fillStyle = `rgba(210,210,210,${0.5 + rand() * 0.4})`;
      ctxAO.fillRect(px, py + winH - 3, winW, 3);
    }
  }
  // Edge vignette (corners of each face occluded)
  const vg = ctxAO.createRadialGradient(W / 2, W / 2, W * 0.3, W / 2, W / 2, W * 0.72);
  vg.addColorStop(0, 'rgba(255,255,255,0)');
  vg.addColorStop(1, 'rgba(215,215,215,1)');
  ctxAO.fillStyle = vg;
  ctxAO.fillRect(0, 0, W, W);

  const out = {
    normal: makeTex(cN, false),
    ao: makeTex(cAO, false),
  };
  buildingDetailCache.set(kind, out);
  return out;
}

/**
 * === 生成耗时台架 (per user request: 改动前后各测一次生成耗时) ==================
 * 每次用不同的 scheme 后缀绕开缓存, 直接量"纯画布生成"的耗时(不含建 Texture)。
 * 探针: `__texBench('high', 5)` → 返回 [{ms, w, h}]。
 */
export function benchAircraftGeneration(quality: 'low' | 'medium' | 'high', n: number): TexGenStat[] {
  const out: TexGenStat[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const canv = generateAircraftCanvases('bench', 'standard' + i, quality);
    out.push({ id: canv.id, ms: Math.round((performance.now() - t0) * 100) / 100, w: canv.w, h: canv.h });
  }
  return out;
}

installTexHooks();
if (typeof window !== 'undefined' && TEX_DUMP) {
  (window as unknown as Record<string, unknown>).__texBench = benchAircraftGeneration;
}

/** Estimate GPU VRAM of one texture incl. its mip chain (bytes). */
export function textureVRAM(t: THREE.Texture): number {
  if (!t.image) return 0;
  const w = (t.image as { width?: number }).width ?? 0;
  const h = (t.image as { height?: number }).height ?? 0;
  if (!w || !h) return 0;
  const bpp = t.colorSpace === THREE.SRGBColorSpace ? 4 : 3;
  // Full mip chain ≈ 1.33× the base level (RGBA) — close enough for budgets.
  return Math.ceil((w * h * bpp) * 1.33);
}
