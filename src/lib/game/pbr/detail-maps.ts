// === 从 albedo 反推细节贴图 (per user request: 修复 PBR 机型粗糙度/法线不起作用) ===
//
// 问题: War Thunder 导出的机体贴图里, 法线图(_n)与镜面图(_n_s)经常是**近乎空白**的。
// 实测 MiG-29 (9-12):
//   · _n_s 几乎全黑 → loadSpecularAsRoughness 把整机压到 roughness≈0.86, 一片哑光,
//     "粗糙度贴图看不出效果";
//   · _n   整张都是平坦法线色(128,128,255) → 表面完全没有浮雕,
//     "法线贴图看不出效果"。
// 管线本身没错, 是源数据里没有信息 —— 所以只能从 albedo 反推: 面板线/铆钉/污渍
// 在 albedo 上是画好了的, 它们恰好就是法线与粗糙度的细节来源。
//
// 做法(全部在 canvas 上, 不引外部依赖):
//   · 亮度 → 高通(减均值)得到"细节层", 只有细线/铆钉/污渍会进这一层, 大面积迷彩
//     色块被滤掉(那是涂装, 不是粗糙度);
//   · 细节层 → 法线 (Sobel 梯度) 与 粗糙度调制 (暗线=更粗糙)。
//
// 贴图走 <img> 而不是 TextureLoader: 见 fetch-asset.ts —— r185 的 Loader 内部用
// fetch, file:// 下会抛裸 Event。而 canvas 读像素要求图不污染画布, 所以调用方
// 必须传同源/数据 URI(内联资产就是 data URI, 天然满足)。

import * as THREE from 'three';
import {
  cavityFromAlbedo, weatheringFields, fieldToCanvas, seedOf,
  type GlossSource,
} from './weathering';

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image load failed: ${url.slice(0, 80)}`));
    img.src = url;
  });
}

function toCanvas(img: HTMLImageElement): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  return [c, ctx];
}

/** 3x3 盒式模糊 —— 只用来求"局部均值", 从而得到高通细节。 */
function boxBlur(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          s += src[yy * w + xx];
          n++;
        }
      }
      out[y * w + x] = s / n;
    }
  }
  return out;
}

function luminance(data: Uint8ClampedArray, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    out[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) / 255;
  }
  return out;
}

export interface DerivedDetail {
  /** 由 albedo 细节层生成的法线贴图。 */
  normalMap: THREE.CanvasTexture;
  /** 由 albedo 细节层调制过的粗糙度贴图。 */
  roughnessMap: THREE.CanvasTexture;
  /** 细节层强度均值 —— 用于诊断"这张 albedo 到底有没有可用细节"。 */
  detailMean: number;
}

export interface DeriveOptions {
  /** 法线强度。albedo 上的线很细, 需要比真法线图更大的值才看得出浮雕。 */
  normalStrength?: number;
  /** 粗糙度基值(风化场是"加"在它上面的)。 */
  roughnessBase?: number;
  /** 粗糙度被细节调制的幅度(保留给旧调用方; 现在由风化场的权重决定)。 */
  roughnessRange?: number;
  /**
   * 真实镜面/光泽图 URL(WG 的 `_n_s`)。给了就用**真图的亮点**当额外的抛光掩膜:
   * "用真图补程序化做不出来的真机结构"(轮毂/座舱/抛光边)。
   */
  specUrl?: string;
  /**
   * 粗糙度画布的分辨率上限。UV 对齐的粗糙度配合 2048² 的 albedo 时, 4M 像素逐个
   * 求噪声太贵; 1024² 已经完全够读出"板缝/铆钉/积灰"(板缝在 2048² 上才 2px)。
   */
  roughMaxSize?: number;
}

// --------------------------------------------------------------------------
// 程序化粗糙度 (per user request: 细节太少就直接用程序化生成的, 否则太光滑)
//
// 为什么需要单独一条: 从 albedo 高通反推来的粗糙度, 在**平涂区域**(迷彩大色块、
// 干净蒙皮)细节层 ≈ 0 → 粗糙度停在基值不动 → 整机还是"一片光滑", 看不出材质。
// 而 War Thunder 的机体贴图恰恰大量是平涂。
//
// 现在这一条 = `pbr/weathering.ts` 的多尺度风化场: 域扭曲 FBM 云雾斑 + 各向异性
// 条纹 + Voronoi 分块光泽差 + 划痕 + 掉漆点 + 细颗粒。**没有几何掩膜**(这条路径
// 拿不到法线/亮度细节), 所以它只负责"随机就能做的那一半"; 锁几何的那一半见
// deriveDetailMaps(从 albedo 的板缝/铆钉派生)与 texture-sets(从法线派生)。
//
// 只有一张、全局共享: 程序化噪声本就与具体 UV 布局无关, 逐材质各生成一张既没必要
// 又很贵(1024² 的像素级噪声 × 13 个材质会明显拖慢机库加载)。
// --------------------------------------------------------------------------
const PROC_ROUGH_SIZE = 512;
let _procRough: THREE.CanvasTexture | null = null;

/**
 * 全局共享的程序化粗糙度贴图(512², RepeatWrapping, NoColorSpace)。
 *
 * 基值 0.65: 机体是高金属度材质, 低粗糙度 ≈ 镜面 —— 背光面反射到的主要是暗地面,
 * 于是"背对太阳飞就是死黑"; 偏粗等于把反射从镜面推到绒面, 天光被摊开铺满半球,
 * 背光面才有蒙皮的层次。军机蒙皮本身也是哑光偏粗糙的。风化场在它上下铺开
 * ±0.3 的范围 —— 这才是"能看出粗糙度变化"的关键。
 */
export function getProceduralRoughnessTexture(): THREE.CanvasTexture {
  if (_procRough) return _procRough;
  const N = PROC_ROUGH_SIZE;
  const wf = weatheringFields({ w: N, h: N, seed: 0x51ed2701, level: 'high', base: 0.65 });
  const c = fieldToCanvas(wf.rough, N, N);
  const tex = new THREE.CanvasTexture(c);
  finish(tex);
  // 机体 UV 是一张图集(整机摊在 0..1), 512² 只铺一遍会是大色块 —— 重复若干次
  // 才够细。共享一张贴图, 所以这个尺度对用到它的材质是统一的(程序化噪声本就
  // 与 UV 布局无关, 不需要逐材质对齐)。
  tex.repeat.set(6, 6);
  _procRough = tex;
  return tex;
}

/** 读一张灰度镜面/光泽图, 转成风化场要的 GlossSource。 */
async function loadGlossSource(url: string): Promise<GlossSource | null> {
  try {
    const img = await loadImage(url);
    const [c, ctx] = toCanvas(img);
    const w = c.width, h = c.height;
    const d = ctx.getImageData(0, 0, w, h).data;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const l = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = l;
      out[i * 4 + 3] = 255;
    }
    return { data: out, w, h };
  } catch {
    return null;   // 读不到就当没有: 纯程序化路径, 不报错
  }
}

/**
 * 从 albedo 反推法线 + 粗糙度细节。
 *
 * `albedoUrl` 必须是同源或 data URI —— canvas 读像素对跨域图会抛 SecurityError。
 */
export async function deriveDetailMaps(
  albedoUrl: string,
  opts: DeriveOptions = {},
): Promise<DerivedDetail> {
  const normalStrength = opts.normalStrength ?? 1.2;
  // === 从 albedo 派生的粗糙度也整体调粗 (per user request) ==================
  // base 0.55 → 0.74: 主体落到哑光区。range 0.34 → 0.18 并把下面的 *8 收成 *3,
  // 是因为原来 detail 高的时候会一路减到 0(=镜面), 太阳扫过会闪出一块死亮;
  // 现在最亮也只到 0.30, 仍然是"磨砂金属"而不是镜子。
  const roughnessBase = opts.roughnessBase ?? 0.74;
  const roughnessRange = opts.roughnessRange ?? 0.18;

  const img = await loadImage(albedoUrl);
  const [c, ctx] = toCanvas(img);
  const w = c.width, h = c.height;
  const px = ctx.getImageData(0, 0, w, h);
  const lum = luminance(px.data, w, h);
  const mean = boxBlur(lum, w, h);

  // --- 法线: 对高通后的细节层求 Sobel 梯度 ---
  const nrm = ctx.createImageData(w, h);

  const detailAt = (x: number, y: number) => {
    const i = y * w + x;
    return lum[i] - mean[i];
  };

  let sum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : x;
      const xp = x < w - 1 ? x + 1 : x;
      const ym = y > 0 ? y - 1 : y;
      const yp = y < h - 1 ? y + 1 : y;

      const dx = (detailAt(xp, y) - detailAt(xm, y)) * normalStrength;
      const dy = (detailAt(x, yp) - detailAt(x, ym)) * normalStrength;
      const len = Math.sqrt(dx * dx + dy * dy + 1);
      const o = (y * w + x) * 4;

      nrm.data[o] = ((-dx / len) * 0.5 + 0.5) * 255;
      nrm.data[o + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      nrm.data[o + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      nrm.data[o + 3] = 255;

      sum += Math.abs(detailAt(x, y));
    }
  }

  const nc = document.createElement('canvas');
  nc.width = w;
  nc.height = h;
  nc.getContext('2d')!.putImageData(nrm, 0, 0);
  const normalMap = new THREE.CanvasTexture(nc);
  finish(normalMap);

  // === 粗糙度: 几何派生掩膜(从 albedo 的板缝/铆钉) + 多尺度风化 ==============
  // 为什么要从 albedo 派生而不是只堆噪声: 参考图一半的信息量是"锁在几何上的结构"
  // (板缝/铆钉行/凸边磨亮), 纯噪声永远对不上模型。War Thunder 的 `_n` 是平的
  // (实测 MiG-29: 偏差 0.0099 ≈ 平坦法线), 但 `_c` 上板缝/铆钉/污渍画得清清楚楚
  // —— 那才是这台机体真正的"几何"。用它的高通当代理高度场, 掩膜就天然锁在板缝上。
  //
  // 分辨率上限 roughMaxSize(默认 1024): 2048² albedo 上逐像素求噪声太贵, 而
  // 板缝在 2048² 上也才 2px —— 1024² 已足够读出结构。
  const maxDim = Math.max(w, h);
  const work = Math.min(opts.roughMaxSize ?? 1024, maxDim);
  const rw = Math.max(16, Math.round(w * work / maxDim));
  const rh = Math.max(16, Math.round(h * work / maxDim));
  let cavData = px.data;
  if (rw !== w || rh !== h) {
    const sc = document.createElement('canvas');
    sc.width = rw;
    sc.height = rh;
    const sctx = sc.getContext('2d', { willReadFrequently: true })!;
    sctx.drawImage(c, 0, 0, rw, rh);
    cavData = sctx.getImageData(0, 0, rw, rh).data;
  }
  const cavity = cavityFromAlbedo(cavData, rw, rh, rw >= 512 ? 3 : 2);
  const gloss = opts.specUrl ? await loadGlossSource(opts.specUrl) : null;
  const wf = weatheringFields({
    w: rw, h: rh,
    seed: seedOf(albedoUrl + '|' + (opts.specUrl || '')),
    // 高档: UV 对齐的这张图是"真机质感"的主力, 值得把划痕/掉漆/掩膜都打开
    level: 'high',
    base: roughnessBase,
    cavity,
    gloss,
  });
  const roughnessMap = new THREE.CanvasTexture(fieldToCanvas(wf.rough, rw, rh));
  finish(roughnessMap);
  void roughnessRange;

  return { normalMap, roughnessMap, detailMean: sum / (w * h) };
}

function finish(t: THREE.CanvasTexture) {
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;   // 法线/粗糙度都是数据贴图, 不是颜色
  t.userData.shared = true;            // 跨 mission / 机库共享, 见 f16c.ts 注释
  t.needsUpdate = true;
}

/**
 * 判断一张灰度贴图是否"基本全黑"。
 *
 * 机体镜面图(_n_s)如果通篇近黑, 转成粗糙度后整机会落到同一个值(实测 MiG-29
 * 就是这样), 粗糙度就"看不出效果"。调用方据此决定是否改用反推的粗糙度。
 */
export async function meanLuminance(url: string): Promise<number> {
  try {
    const img = await loadImage(url);
    const [c, ctx] = toCanvas(img);
    const w = c.width, h = c.height;
    const d = ctx.getImageData(0, 0, w, h).data;
    let s = 0, n = 0;
    for (let y = 0; y < h; y += 4) {
      for (let x = 0; x < w; x += 4) {
        const o = (y * w + x) * 4;
        s += (d[o] * 0.299 + d[o + 1] * 0.587 + d[o + 2] * 0.114) / 255;
        n++;
      }
    }
    return s / Math.max(1, n);
  } catch {
    return 1;   // 读不到就当它有内容, 不动原路径
  }
}

/**
 * 判断一张法线贴图是否"基本是空的"。
 *
 * 源法线图如果通篇都是平坦法线色(128,128,255), 用它比用反推的还差 —— 所以调用方
 * 可以先采样判断, 只在源图确实没信息时才走反推。
 */
export async function normalMapIsFlat(url: string, threshold = 0.02): Promise<boolean> {
  try {
    const img = await loadImage(url);
    const [c, ctx] = toCanvas(img);
    const w = c.width, h = c.height;
    const d = ctx.getImageData(0, 0, w, h).data;
    let dev = 0, n = 0;
    // 抽样(每 16 像素取一个)即可, 不需要全图。
    for (let y = 0; y < h; y += 4) {
      for (let x = 0; x < w; x += 4) {
        const o = (y * w + x) * 4;
        const ddx = Math.abs(d[o] - 128) / 255;
        const ddy = Math.abs(d[o + 1] - 128) / 255;
        dev += ddx + ddy;
        n += 2;
      }
    }
    return dev / Math.max(1, n) < threshold;
  } catch {
    return false;   // 读不到就当它有信息, 走原路径, 不额外替换
  }
}
