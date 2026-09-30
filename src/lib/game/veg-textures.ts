// === 植被贴图管线 · 自动适配 (per user request: 贴图怎么搞 + 自动适配) ==================
//
// 用户: "高植被用 4 叉 alpha 贴片, 低矮植被用 billboard 的树木贴图素材, 怎么给 DeepSeek
//        搞贴图(也可以去网络找)和自动适配"。
//
// 这套管线解决"素材从哪来 + 来了怎么自动适配", 三种来源**按优先级自动降级**:
//
//   ① 一株一文件(最省心):  public/textures/veg/<species>/*.png|jpg|webp
//   ② 一张图集(最省事):     public/textures/veg/<species>_sheet.png  ← 自动**按 alpha 切株**
//   ③ 程序化(零素材兜底):   environment.ts 里既有的程序化图集(离线单文件也能看)
//
// 自动适配清单(这就是"来了就能用"的部分):
//   · **alpha 还是白键**: 逐像素看 alpha 通道有没有真实变化。有 → 当作带 alpha 的透明图直接切;
//     没有(RGB/JPG, 透明区被拍成白底) → 走**亮度白键**(阈值自动标定: 取背景亮度分布的高分位),
//     并留一条软过渡带压掉 JPEG 白边。
//   · **自动切株**: 对整张图做 alpha(或白键后)投影, 找全空的列/行当分隔线, 再求每块的紧包围盒
//     ⇒ 图集里有几株就用几株, 不用手写裁剪坐标, 也不怕留白/间距不一致。
//   · **宽高比自适应**: 每株记自己的 w/h, 打包时按"保持自身比例"塞进格子(格子里留边),
//     于是又高又细的松树不会被压扁成方块。
//   · **自动打包成一张图集**: 所有株进一张 2048 图集 + 每株一张 UV 矩形表 ⇒
//     实例化时靠一个 `aUvOffset` 属性挑株型, 一个 species 仍然只有 1 个 draw call。
//   · **解析不了就降级**: 任何一步失败(文件缺失/解码失败/切不出株)都退回程序化图集, 绝不阻断加载。
//
// 素材从哪找(实测能下的源见 public/textures/veg/README.md):
//   · OpenGameArt  CC0  https://opengameart.org/content/trees-bushes  (ansimuz, 像素风)
//   · OpenGameArt  CC0  https://opengameart.org/content/trees-1
//   · ambientCG / Poly Haven 的 CC0 贴图库(注意: 本站当时只有 Decal/Atlas 两类, 植物命中 0)
//   抓取脚本: `node scripts/veg-fetch-assets.mjs`(默认下 CC0 那两套, 落到 public/textures/veg/)。
import * as THREE from 'three';
import { assetUrl } from './asset-url';

export type VegSpecies = 'conifer' | 'decid' | 'grass' | 'bush';
export const VEG_SPECIES: VegSpecies[] = ['conifer', 'decid', 'grass', 'bush'];

/** 一株的图集矩形(uv 空间)+ 自己的宽高比 */
export interface VegSpriteRect {
  u0: number; v0: number; u1: number; v1: number;
  /** 该株原始像素宽高比 (w/h), 用于格子内留边保持比例 */
  aspect: number;
}

export interface VegSpriteTexture {
  species: VegSpecies;
  /** 打包后的图集(可能只有 1 株) */
  texture: THREE.CanvasTexture;
  /** 每株的 UV 矩形(至少 1 条) */
  sprites: VegSpriteRect[];
  /** 素材来源, 报告/控制台用: 'files:12' | 'sheet:trees_bushes' | 'procedural' */
  source: string;
  /** >0 = 让材质用着色器白键抠掉该亮度以上的像素(本地 file:// 无像素分析时的兜底) */
  shaderKey: number;
  /** alpha / 白键统计(报告用) */
  stats: { total: number; transparent: number; whiteKeyed: number; keyMode: 'alpha' | 'whitekey' };
}

// ---------------------------------------------------------------------------
// 图片解码
// ---------------------------------------------------------------------------
function decodeImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // === crossOrigin 只给绝对 http(s) 外部图 (per fix: file:// 下一张都加载不出来) ===
    // 对 file:// 或相对路径设 crossOrigin=anonymous ⇒ 浏览器按 CORS 请求处理, 而 file://
    // 没有 CORS 应答 ⇒ **加载直接失败**。实测: 不设时 416x160 秒开, 设了就 onerror。
    // 只有跨域 http 图才需要它(否则画布被污染: 既不能 getImageData 也不能当 WebGL 贴图)。
    if (/^https?:\/\//i.test(url)) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode failed: ' + url));
    img.src = url;
  });
}

/** 尽量在 http 下列出目录; 拿不到就返回空(靠固定命名兜底)。
 *
 *  === 为什么 file:// 直接跳过 (per fix: 任务一直建不完) ===
 *  file:// 下对"目录 URL"发 fetch 不是立刻失败, 而是**挂住**(Chrome 对 file 目录请求
 *  既不 resolve 也不 reject), 于是这里的 await 会把整条任务构建流程卡死 ——
 *  实测表现是 missionReady 永远为 false、植被/贴图全是 0。所以:
 *    · file:// 一律不发这个请求, 直接走固定命名;
 *    · http 下也加 2s 超时, 服务器不返回目录列表时同样不能拖住构建。
 */
/** 植被贴片清单(public/textures/veg/manifest.json, 由 scripts/veg-manifest.mjs 生成)。
 *  §364: 静态服务器不给目录索引 ⇒ 原来的 listDir 恒为空 ⇒ 加载器退化成"盲探"
 *  8 编号 × 3 扩展 × 2 命名, 每次进关刷 70+ 条 404。清单只列磁盘上真有的文件。
 *  取不到清单(未生成 / 单文件版没内联)时**完全回退旧行为**, 不会更差。 */
interface VegManifest { species?: Record<string, string[]>; sheets?: string[]; count?: number }
let _vegManifestReq: Promise<VegManifest | null> | null = null;
function loadVegManifest(): Promise<VegManifest | null> {
  if (!_vegManifestReq) {
    _vegManifestReq = (async () => {
      try {
        const r = await fetch(assetUrl('/textures/veg/manifest.json'), { cache: 'force-cache' });
        if (!r.ok) return null;
        const j = (await r.json()) as VegManifest;
        if (!j || typeof j !== 'object' || !j.species) return null;
        console.info('[veg] 贴片清单已接入: ' + Object.entries(j.species).map(([k, v]) => k + '=' + v.length).join(' ')
          + (j.sheets && j.sheets.length ? ' sheets=' + j.sheets.length : ''));
        return j;
      } catch { return null; }
    })();
  }
  return _vegManifestReq;
}

async function listDir(path: string): Promise<string[]> {
  try {
    if (typeof location !== 'undefined' && location.protocol === 'file:') return [];
    const r = await Promise.race([
      fetch(assetUrl(path), { cache: 'no-store' }),
      new Promise<null>((res) => setTimeout(() => res(null), 2000)),
    ]);
    if (!r || !r.ok) return [];
    const txt = await r.text();
    // 目录列表是 HTML; 抓 href 里的文件名即可(两种服务器格式都吃)
    const names = new Set<string>();
    const re = /href="([^"]+\.(?:png|jpg|jpeg|webp))"/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(txt))) names.add(m[1].split('/').pop() as string);
    return [...names];
  } catch {
    return []; // 目录列举不可用 → 走固定命名
  }
}

// ---------------------------------------------------------------------------
// 像素 → 蒙版(alpha 或白键), 再按投影自动切株
// ---------------------------------------------------------------------------
interface MaskImage { w: number; h: number; a: Uint8Array; stats: VegSpriteTexture['stats'] }

function toMask(img: HTMLImageElement): MaskImage {
  const w = img.width, h = img.height;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, w, h).data;
  const a = new Uint8Array(w * h);
  // ① alpha 通道有没有真实变化? 只看"有没有大量半透明/全透明像素"
  let transparent = 0;
  for (let i = 0; i < w * h; i++) if (d[i * 4 + 3] < 200) transparent++;
  const alphaMeaningful = transparent > w * h * 0.02;
  // ② 没有 alpha ⇒ 白键: 阈值自动标定。取全图亮度的高分位(背景通常是纯白/近白),
  //    落在该分位以上的算背景。比写死 0.985 稳(素材曝光/压缩不同)。
  let keyMode: 'alpha' | 'whitekey' = alphaMeaningful ? 'alpha' : 'whitekey';
  let thr = 0.985;
  if (!alphaMeaningful) {
    const hist = new Uint32Array(64);
    let n = 0;
    for (let i = 0; i < w * h; i++) {
      const lum = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
      hist[Math.min(63, Math.max(0, Math.round(lum * 63)))]++; n++;
    }
    let acc = 0, p = 0;
    for (let b = 63; b >= 0; b--) { acc += hist[b]; if (acc > n * 0.02) { p = b; break; } }  // 顶部 2% 的亮度
    thr = Math.max(0.80, Math.min(0.995, (p + 0.5) / 64));
  }
  let whiteKeyed = 0;
  for (let i = 0; i < w * h; i++) {
    if (alphaMeaningful) {
      a[i] = d[i * 4 + 3];
    } else {
      const lum = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
      // 白键 + 软过渡带(0.05): 压掉 JPEG 边缘白边/光晕
      const k = (lum - thr) / 0.05;
      const alpha = k <= 0 ? 1 : k >= 1 ? 0 : 1 - k;
      if (alpha <= 0) whiteKeyed++;
      a[i] = Math.round(alpha * 255);
    }
  }
  return { w, h, a, stats: { total: w * h, transparent, whiteKeyed, keyMode } };
}

/** 按 alpha 投影自动切株: 全空的列/行是分隔线, 每块求紧包围盒。 */
function autoSlice(m: MaskImage, maxSprites = 24): { x: number; y: number; w: number; h: number }[] {
  const { w, h, a } = m;
  const empty = (thr = 8) => {
    const colHas = new Uint8Array(w);
    const rowHas = new Uint8Array(h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (a[y * w + x] > thr) { colHas[x] = 1; rowHas[y] = 1; }
      }
    }
    return { colHas, rowHas };
  };
  const { colHas, rowHas } = empty();
  // 切成"列带"(连续有内容的列区段), 再在每段内按行切 → 得到每株的块
  const runs = (has: Uint8Array, len: number, gap = 2): [number, number][] => {
    const out: [number, number][] = [];
    let s = -1, g = 0;
    for (let i = 0; i < len; i++) {
      if (has[i]) {
        if (s < 0) s = i;
        g = 0;
      } else if (s >= 0) {
        g++;
        if (g >= gap) { out.push([s, i - g]); s = -1; g = 0; }
      }
    }
    if (s >= 0) out.push([s, len - 1]);
    // 太窄的区段丢掉(噪点)
    return out.filter(([x0, x1]) => x1 - x0 >= 2);
  };
  const colRuns = runs(colHas, w, 3);
  const boxes: { x: number; y: number; w: number; h: number }[] = [];
  for (const [cx0, cx1] of colRuns) {
    // 这一列带内的行占用
    const rows = new Uint8Array(h);
    for (let y = 0; y < h; y++) {
      for (let x = cx0; x <= cx1; x++) if (a[y * w + x] > 8) { rows[y] = 1; break; }
    }
    for (const [ry0, ry1] of runs(rows, h, 3)) {
      // 紧包围盒(去掉块内留白)
      let minX = w, maxX = -1, minY = h, maxY = -1;
      for (let y = ry0; y <= ry1; y++) {
        for (let x = cx0; x <= cx1; x++) {
          if (a[y * w + x] > 8) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) continue;
      const bw = maxX - minX + 1, bh = maxY - minY + 1;
      if (bw < 4 || bh < 4) continue;
      boxes.push({ x: minX, y: minY, w: bw, h: bh });
      if (boxes.length >= maxSprites) return boxes;
    }
  }
  return boxes;
}

// ---------------------------------------------------------------------------
// 打包成图集(保持每株自己的宽高比)
// ---------------------------------------------------------------------------
const ATLAS = 2048;

function packAtlas(
  img: HTMLImageElement,
  mask: MaskImage,
  boxes: { x: number; y: number; w: number; h: number }[],
  margin = 4,
): { canvas: HTMLCanvasElement; sprites: VegSpriteRect[] } {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS; canvas.height = ATLAS;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.clearRect(0, 0, ATLAS, ATLAS);
  const sprites: VegSpriteRect[] = [];
  // 简单行式装箱: 同一行的格子高度取该行最大高, 宽度累加, 超宽换行。
  let penX = margin, penY = margin, rowH = 0;
  for (const b of boxes) {
    // 单株最长边压到 512(植被贴片不需要更大; 省显存也省构建体积)
    const scale = Math.min(1, 512 / Math.max(b.w, b.h));
    const dw = Math.max(2, Math.round(b.w * scale));
    const dh = Math.max(2, Math.round(b.h * scale));
    if (penX + dw + margin > ATLAS) { penX = margin; penY += rowH + margin; rowH = 0; }
    if (penY + dh + margin > ATLAS) break; // 图集满(正常不会: 切株上限 24)
    ctx.drawImage(img, b.x, b.y, b.w, b.h, penX, penY, dw, dh);
    sprites.push({
      u0: penX / ATLAS, v0: 1 - (penY + dh) / ATLAS,
      u1: (penX + dw) / ATLAS, v1: 1 - penY / ATLAS,
      aspect: dw / dh,
    });
    penX += dw + margin;
    if (dh > rowH) rowH = dh;
  }
  void mask;
  return { canvas, sprites };
}

// ---------------------------------------------------------------------------
// 对外: 一套 species → 图集 + 株型表
// ---------------------------------------------------------------------------
const CACHE = new Map<string, Promise<VegSpriteTexture | null>>();

export interface VegTextureLoadOptions {
  /** 强制程序化(忽略磁盘素材), 控制台 `veg proc` 用 */
  forceProcedural?: boolean;
  /** 每株一文件的目录后缀; 缺省 <species> */
  dirName?: (s: VegSpecies) => string;
}

async function loadOneSpecies(s: VegSpecies, opts: VegTextureLoadOptions): Promise<VegSpriteTexture | null> {
  if (opts.forceProcedural) return null;
  const dir = opts.dirName ? opts.dirName(s) : s;
  // ① 每株一文件
  let urls: string[] = [];
  const man = await loadVegManifest();
  const listed = man?.species?.[s] ?? (dir !== s ? man?.species?.[dir] : undefined);
  if (listed && listed.length) {
    // §364: 有清单 ⇒ 只请求清单里的文件(零 404)
    for (const n of listed) urls.push('/textures/veg/' + n);
  } else if (!man) {
    // §364: 只有**没有清单**时才列目录(静态服务器对目录 URL 也返回 404, 白白多两条)
    const names = await listDir(`/textures/veg/${dir}/`);
    for (const n of names) urls.push(`/textures/veg/${dir}/${n}`);
  }
  // §364: 清单**存在**却对该物种没有条目 = 磁盘上就没有这类贴片 ⇒ 不要再盲探
  // (否则每次进关仍会为 grass/bush 各刷十几条 404)。只有拿不到清单时才盲探。
  if (!urls.length && !man) {
    // 目录列举不可用(file:// / 静态服务器不开目录索引) → 试常见固定命名
    // 两种命名都试: 子目录(<species>/<species>_N.png) 与**扁平**(/textures/veg/<species>_N.png,
    // 后者是 scripts/import-asset.mjs --as /textures/veg/ 入库后的路径)。
    for (const ext of ['png', 'jpg', 'webp']) {
      for (let i = 1; i <= 8; i++) {
        urls.push('/textures/veg/' + dir + '/' + s + '_' + i + '.' + ext);
        urls.push('/textures/veg/' + s + '_' + i + '.' + ext);
      }
    }
  }
  const decoded: HTMLImageElement[] = [];
  for (const u of urls.slice(0, 16)) {
    try {
      const img = await decodeImage(assetUrl(u));
      if (img.width >= 8 && img.height >= 8) decoded.push(img);
    } catch { /* 单张失败跳过 */ }
  }
  // ② 一张图集
  if (!decoded.length) {
    // §364: 有清单时只试清单里**属于该物种**的图集 —— 清单说没有就别盲试 6 个组合。
    const man2 = await loadVegManifest();
    const sheetNames = man2?.sheets?.filter((n) => n.startsWith(s + '_') || n.startsWith(dir + '_')) ?? null;
    const cand = man2
      ? (sheetNames ?? []).map((n) => `/textures/veg/${n}`)
      : ['png', 'jpg', 'webp'].flatMap((ext) => [`/textures/veg/${s}_sheet.${ext}`, `/textures/veg/${dir}/${s}_sheet.${ext}`]);
    for (const u of cand) {
      try {
        const img = await decodeImage(assetUrl(u));
        if (img.width >= 16 && img.height >= 16) { decoded.push(img); break; }
      } catch { /* 继续 */ }
    }
  }
  if (!decoded.length) return null;

  // === 试图做像素级分析(自动切株 / 自动 alpha-或-白键) ======================
  // file:// 下 canvas 会被 file 图片污染, getImageData 抛 SecurityError ⇒ 走下面的
  // "整图当一株 + 着色器白键"降级路径(仍然可用, 只是少了自动切株与阈值标定)。
  let pixelOK = true;
  const all: { img: HTMLImageElement; box: { x: number; y: number; w: number; h: number } }[] = [];
  let statsAcc: VegSpriteTexture['stats'] | null = null;
  try {
    for (const img of decoded) {
      const mask = toMask(img);
      if (!statsAcc) statsAcc = mask.stats;
      else { statsAcc.transparent += mask.stats.transparent; statsAcc.whiteKeyed += mask.stats.whiteKeyed; statsAcc.total += mask.stats.total; }
      const boxes = autoSlice(mask, 24);
      if (!boxes.length) continue;
      for (const b of boxes) all.push({ img, box: b });
      if (all.length >= 24) break;
    }
  } catch (e) {
    pixelOK = false;
    all.length = 0;
    console.info('[veg] 无法做像素分析(本地 file:// 的画布污染限制), 改为"整图一张 + 着色器白键":', (e as Error)?.name);
  }
  // === 降级: 整图当一株(drawImage 不读像素, 不受污染限制) ====================
  let shaderKey = 0;
  if (!pixelOK || !all.length) {
    all.length = 0;
    for (const img of decoded.slice(0, 24)) all.push({ img, box: { x: 0, y: 0, w: img.width, h: img.height } });
    // 没有像素就没法判断"有没有 alpha" → 一律开着色器白键(阈值偏保守, 只吃近白背景)
    shaderKey = 0.92;
    statsAcc = { total: 0, transparent: 0, whiteKeyed: 0, keyMode: 'whitekey' };
  }
  // 打包(可能来自多张图 → 逐张追加, 简化处理: 每株单独 drawImage)
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS; canvas.height = ATLAS;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, ATLAS, ATLAS);
  const sprites: VegSpriteRect[] = [];
  let penX = 4, penY = 4, rowH = 0;
  for (const { img, box } of all) {
    const scale = Math.min(1, 512 / Math.max(box.w, box.h));
    const dw = Math.max(2, Math.round(box.w * scale));
    const dh = Math.max(2, Math.round(box.h * scale));
    if (penX + dw + 4 > ATLAS) { penX = 4; penY += rowH + 4; rowH = 0; }
    if (penY + dh + 4 > ATLAS) break;
    ctx.drawImage(img, box.x, box.y, box.w, box.h, penX, penY, dw, dh);
    sprites.push({ u0: penX / ATLAS, v0: 1 - (penY + dh) / ATLAS, u1: (penX + dw) / ATLAS, v1: 1 - penY / ATLAS, aspect: dw / dh });
    penX += dw + 4;
    if (dh > rowH) rowH = dh;
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  // 跨 mission 复用: engine.dispose() 不释放
  (tex as unknown as { userData: Record<string, unknown> }).userData.shared = true;
  // §364: 原来这里读 listDir 的 names(已移进 else 分支) ⇒ 用候选 url 数代替
  const srcKind = urls.length || decoded.length ? (decoded.length > 1 ? 'files' : '') : '';
  return {
    species: s,
    texture: tex,
    sprites,
    shaderKey,
    source: (pixelOK ? (srcKind || 'files') : 'raw(无像素分析)') + ':' + sprites.length,
    stats: statsAcc ?? { total: 0, transparent: 0, whiteKeyed: 0, keyMode: 'alpha' },
  };
}

/**
 * 加载全部物种的植被贴图。**任何失败都返回 null**, 由调用方回退程序化图集
 * (`environment.ts` 的 makeVegetationTextures) —— 绝不阻断加载。
 */
export async function loadVegTextures(opts: VegTextureLoadOptions = {}): Promise<Record<VegSpecies, VegSpriteTexture | null>> {
  const out = {} as Record<VegSpecies, VegSpriteTexture | null>;
  await Promise.all(VEG_SPECIES.map(async (s) => {
    const key = s + '|' + (opts.forceProcedural ? 'proc' : 'auto');
    if (!CACHE.has(key)) CACHE.set(key, loadOneSpecies(s, opts).catch((e) => { console.warn('[veg] ' + s + ' 素材加载异常(已降级程序化):', e && e.message); return null; }));
    out[s] = await (CACHE.get(key) as Promise<VegSpriteTexture | null>);
  }));
  return out;
}

/** 报告/控制台用: 一眼看清"用的是素材还是程序化、切出几株、白键还是 alpha"。 */
export function vegTextureReport(set: Record<VegSpecies, VegSpriteTexture | null>): string {
  const rows = VEG_SPECIES.map((s) => {
    const t = set[s];
    if (!t) return `  ${s.padEnd(8)} 程序化(无外部素材)`;
    const st = t.stats;
    const keyTxt = t.shaderKey > 0
      ? ('白键(着色器 ' + t.shaderKey.toFixed(2) + ')')
      : (st && st.keyMode === 'alpha' ? 'alpha(素材自带)' : '白键(已烘焙进 alpha)');
    return `  ${s.padEnd(8)} ${t.sprites.length} 株 · ${keyTxt} · 来源 ${t.source}`;
  });
  return '植被贴图:\n' + rows.join('\n');
}
