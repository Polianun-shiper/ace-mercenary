#!/usr/bin/env node
// ============================================================================
// scripts/clouds-prep.mjs —— 2D 云贴图自动分类裁剪 + 法线贴图生成
// ============================================================================
// 素材: VFX Assets "2D Cloud Textures Pack" (125 张 1024px JPEG, 黑底无 alpha)。
// 目标: 把原始大图自动切成**大云 / 小云 / 航迹云**三类, 裁掉黑边, 并为每张
//       生成配套法线贴图(_n.jpg), 供游戏端"按天光/太阳角度动态着色"用。
//
// 用法:
//   node scripts/clouds-prep.mjs [--src <目录|glob|文件>] [--out public/textures/clouds]
//                               [--max 1024] [--q 88]
//   node scripts/clouds-prep.mjs --selftest          # 用合成图跑一遍自检(无素材要求)
//
// 默认 --src public/textures/clouds/_raw(原图丢这里), 输出到 --out。
// 输出结构:
//   <out>/large/large-001.jpg  + large-001_n.jpg
//   <out>/small/small-001.jpg  + small-001_n.jpg
//   <out>/_contrail/contrail-001.jpg + _n.jpg   (游戏端暂不使用, 留档)
//   <out>/manifest.json          (含 class / normal / w / h / aspect / fill)
//   <out>/clouds-prep-report.json(阈值 / 判定规则 / 统计, 供写文档与调参)
//
// ★ 原图(黑底、无 alpha)裁剪后**仍然是黑底 JPEG**, 不转 alpha —— 游戏端着色器
//   已经用亮度当 alpha(见 environment.ts 的 buildCloudSprites 片元), 少一条路径
//   也省体积。若源图带 alpha 则压到黑底上(flatten)。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ============================================================================
// === 可调阈值 (全部具名常量, 调分类只动这一段) ==============================
// ============================================================================
/** 内容判定: 亮度 > 此值算"有效云像素"(0..255)。黑底 ~0-6, 云体 30-255。
 *  取 12 是为了滤掉 JPEG 抖动噪声, 又不会把淡云边切掉太多。 */
const LUM_THRESHOLD = 12;
/** 求包围盒前的高斯模糊 sigma(去孤立噪点, 避免 bbox 被单个亮点撑大)。 */
const BBOX_BLUR_SIGMA = 0.8;
/** bbox 外扩余量(占内容宽高的比例) —— 保住云缘的软过渡, 不切出硬边。 */
const CROP_MARGIN = 0.04;

/** 航迹云判定①: 极细长 —— aspect = w/h ≥ 3.5 且 fill = 有效/(w*h) < 0.18。 */
const CONTRAIL_ASPECT = 3.5;
const CONTRAIL_FILL = 0.18;
/** 航迹云判定②: 主方向明显倾斜 —— 像素协方差主轴与水平夹角 > 25°。
 *  但**只在稀疏内容上生效**(fill < CONTRAIL_TILT_MAX_FILL): 一个敦实的圆团云
 *  的协方差主轴方向在数学上是不稳定的(接近各向同性), 不加这个门会误杀。 */
const CONTRAIL_TILT_DEG = 25;
const CONTRAIL_TILT_MAX_FILL = 0.30;
/** 航迹云判定③: **法向 RMS 厚度** < 10px (协方差小特征值的平方根, 与方向无关)。
 *  前两条都会漏: 斜条纹裁剪后 bbox 接近方形(aspect 抓不到), 水平条纹倾角 ≈ 0(倾角抓不到)。
 *  实测(125 张源切片): 7 张条纹的 RMS 厚度 = 4.71~6.95, 其余 **118 张全部 >= 13.76** ——
 *  阈值取 10 正好落在这段明确的空隙里。注: 细长比(elong)不能当判据, 扁平的大云带
 *  细长比也很高(实测最高 ~11.7), 用它会误杀几十张正常云。 */
const CONTRAIL_THICKNESS = 10;

/** 大型平底团云: aspect ∈ [1.25, 3.2] 且 fill ≥ 0.30, 或 bbox 占整幅 ≥ 0.45。 */
const LARGE_ASPECT_MIN = 1.25;
const LARGE_ASPECT_MAX = 3.2;
const LARGE_FILL = 0.30;
/** bbox 面积 / 原图面积 的兜底: 一张几乎铺满整幅的云必然是大云, 不管 fill。 */
const LARGE_BBOX_COVER = 0.45;

// === 圆点伪影: 带圆点的切片整张不用 (per user request) ======================
// 联络表切片里常带若干**孤立的小圆点**(素材包自带的样点/杂点), 裁进云图后就是云上
// 漂着几个突兀的亮点。判定四条件同时成立才算"圆点", 缺一不可:
//   ① 面积不大: <= max(6px, 裁剪面积 * DOT_MAX_AREA_FRAC)
//   ② 外形接近圆/点: bbox 两维都不超过裁剪尺寸的 DOT_MAX_SIZE_FRAC(排除条纹/碎边)
//   ③ 与主体分离: bbox 外扩 DOT_ISOLATED_PAD 后没有别的前景像素(排除云的碎边角)
//   ④ **够亮**: 块内峰值亮度 >= DOT_MIN_PEAK —— 这条是实测加上的: 黑底上大量"小块"
//      峰值只有 13~39(淡噪声/云缘碎屑), 肉眼根本看不见; 真正的圆点峰值 50~255。
// 再加一条: 主体面积至少是它的 DOT_MAIN_RATIO 倍(否则可能是"一朵碎云"而不是圆点)。
// 达到 DOT_MIN_COUNT 个 → 该切片直接丢弃(不写文件 → 自然不进图集), 不做修补。
// ⚠️ 面积/尺寸上限是**按实测放大过**的: 第一版取了 0.4% / 5%(只认 4x4 角落白点),
// 结果用户指出的那朵"底下带 4 个圆点"的云(small-022 的源切片)漏掉了 —— 它那几个点
// 聚成一团 248px / bbox 18x19。现在放到 3% / 20%, 仍靠"孤立 + 够亮 + 主体远大于它"兜底。
const DOT_MAX_AREA_FRAC = 0.03;
const DOT_MAX_SIZE_FRAC = 0.2;
const DOT_ISOLATED_PAD = 4;
const DOT_MAIN_RATIO = 8;
const DOT_MIN_PEAK = 45;
const DOT_MIN_COUNT = 1;

/** 法线强度 k: n = normalize(vec3(-dx*k, -dy*k, 1))。
 *  2.0 太平面(几乎看不到立体感), 4.0 起开始出现"塑料感的硬边"; 3.0 是中间值。 */
const NORMAL_STRENGTH = 3.0;
/** 法线前对高度场做一次轻模糊: 直接对 JPEG 亮度求导会把压缩噪声放大成麻点。 */
const NORMAL_BLUR_SIGMA = 0.7;
/** === 原图光照包络(大尺度打光)的相对模糊半径 (per user request) ===
 *  法线的"高度场"必须先剥掉素材自带的**光照/阴影**大尺度分量: 亮度 = 形体起伏 × 光照,
 *  大尺度那一层基本就是这张云图拍摄时的打光(光源方向 + 云的自阴影), 直接拿亮度当高度会把
 *  "整朵云左亮右暗"编码成"整片法线朝左", 游戏里太阳一换方向就错。
 *  取短边的这个比例做模糊半径: 太小剥不干净(还会残留整体倾向), 太大把形体也削平(法线变死板)。 */
const LIGHT_SIGMA_FRAC = 0.12;

const DEFAULT_MAX = 1024;
const DEFAULT_Q = 88;

// ============================================================================
// === 参数解析 ==============================================================
// ============================================================================
function argValue(flag, dflt) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(flag + '='));
  return eq ? eq.slice(flag.length + 1) : dflt;
}

const SELFTEST = process.argv.includes('--selftest');
const SRC_ARG = argValue('--src', path.join(ROOT, 'public', 'textures', 'clouds', '_raw'));
const OUT_ARG = argValue('--out', path.join(ROOT, 'public', 'textures', 'clouds'));
const MAX_EDGE = Math.max(64, parseInt(argValue('--max', String(DEFAULT_MAX)), 10) || DEFAULT_MAX);
const JPEG_Q = Math.min(100, Math.max(40, parseInt(argValue('--q', String(DEFAULT_Q)), 10) || DEFAULT_Q));

const IMG_RE = /\.(jpe?g|png|webp|tiff?|bmp)$/i;

// ============================================================================
// === 源图收集 (目录 / glob / 单文件) =======================================
// ============================================================================
function collectSources(src) {
  if (!fs.existsSync(src)) {
    // 也许是个 glob(文件不存在但含通配符)
    if (/[*?[{]/.test(src)) {
      try {
        const hits = fs.globSync(src, { cwd: ROOT }).map((f) => path.resolve(ROOT, f));
        return hits.filter((f) => IMG_RE.test(f)).sort();
      } catch {
        return [];
      }
    }
    return [];
  }
  const st = fs.statSync(src);
  if (st.isFile()) return IMG_RE.test(src) ? [src] : [];
  // 目录: 只收本层, 跳过 _ 前缀目录(避免把上一次的输出/原图目录当输入递归吃掉)
  const out = [];
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name.startsWith('_')) continue;
      out.push(...collectSources(path.join(src, e.name)));
    } else if (IMG_RE.test(e.name)) {
      out.push(path.join(src, e.name));
    }
  }
  return out.sort();
}

// ============================================================================
// === 内容分析: 亮度掩码 → 包围盒 / fill / 主轴倾角 =========================
// ============================================================================
/** 返回全分辨率亮度数组(已模糊)+ 掩码索引, 供 bbox 与统计共用。 */
async function luminancePlane(file) {
  // 转单通道灰度 + 轻模糊(去噪)。removeAlpha: 带 alpha 的 PNG 也统一处理。
  const { data, info } = await sharp(file, { limitInputPixels: 1 << 28 })
    .removeAlpha()
    .greyscale()
    .blur(BBOX_BLUR_SIGMA > 0.3 ? BBOX_BLUR_SIGMA : 0.3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { lum: data, w: info.width, h: info.height };
}

/**
 * 由亮度平面求: 非黑内容包围盒 + 裁剪后 fill + 主轴倾角。
 * 统计口径按需求: **用裁剪后的内容统计**(aspect/fill 都是裁剪后尺寸的比值)。
 */
function analyze(lum, w, h) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (lum[row + x] > LUM_THRESHOLD) {
        mask[row + x] = 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null; // 全黑: 没有内容

  // 4% 余量(相对内容尺寸), 再夹回原图范围。
  const cw0 = maxX - minX + 1;
  const ch0 = maxY - minY + 1;
  const mx = Math.round(cw0 * CROP_MARGIN);
  const my = Math.round(ch0 * CROP_MARGIN);
  const left = Math.max(0, minX - mx);
  const top = Math.max(0, minY - my);
  const width = Math.min(w - left, cw0 + 2 * mx);
  const height = Math.min(h - top, ch0 + 2 * my);

  // 裁剪窗内的有效像素数 + 一阶/二阶矩(主轴倾角用)。
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let y = top; y < top + height; y++) {
    const row = y * w;
    for (let x = left; x < left + width; x++) {
      if (!mask[row + x]) continue;
      const px = x - left, py = y - top;
      n++; sx += px; sy += py; sxx += px * px; syy += py * py; sxy += px * py;
    }
  }
  const fill = n / (width * height);
  // === 圆点伪影检测(裁剪窗内 8 连通标记) ===
  const dotInfo = findDotArtifacts(mask, lum, w, h, { left, top, width, height });
  // 协方差矩阵 [[cxx,cxy],[cxy,cyy]] → 主轴与 x 轴夹角(弧度)的半角公式。
  let tiltDeg = 0;
  let elong = 1;
  let thickness = 0;
  if (n > 8) {
    const mcx = sx / n, mcy = sy / n;
    const cxx = sxx / n - mcx * mcx;
    const cyy = syy / n - mcy * mcy;
    const cxy = sxy / n - mcx * mcy;
    let th = 0.5 * Math.atan2(2 * cxy, cxx - cyy); // (-90°, 90°]
    let deg = Math.abs((th * 180) / Math.PI);
    if (deg > 90) deg = 180 - deg;
    tiltDeg = deg;
    // === 细长比(与方向无关) = 两个特征值比值的开方 ===
    const tr = cxx + cyy;
    const det = cxx * cyy - cxy * cxy;
    const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    const l1 = tr / 2 + disc;          // 大类
    const l2 = Math.max(1e-6, tr / 2 - disc);
    elong = Math.sqrt(l1 / l2);        // 圆团 ≈ 1, 长条纹 >> 1 (只做记录, 不参与判定)
    thickness = Math.sqrt(l2);         // 法向 RMS 厚度(px) —— 航迹云判定③用它
  }
  return {
    crop: { left, top, width, height },
    aspect: width / height,
    fill,
    tiltDeg,
    // 细长比(与方向无关): 团云 ≈ 1, 长条纹(航迹云) 远大于 1。只做记录(不能当判据)。
    elong,
    // 法向 RMS 厚度(px): 条纹 4~7, 正常云 >= 13.8 —— 航迹云判定③用的就是它。
    thickness,
    // 孤立圆点个数(>= DOT_MIN_COUNT 的切片整张不用, 见 findDotArtifacts)。
    dots: dotInfo.dots,
    // 形态像圆点但太暗(黑底上看不见)的块数 —— 只做记录, 不影响判定。
    faint: dotInfo.faint,
    // bbox(含余量前的纯内容框)占原图面积比 —— large 的兜底判据。
    bboxCover: (cw0 * ch0) / (w * h),
    srcW: w,
    srcH: h,
  };
}

/**
 * 统计裁剪窗内的**孤立圆点**个数(8 连通)。返回 { dots, faint, mainArea }。
 *
 * 判定见文件顶部 DOT_* 常量注释: 小面积 + 圆外形 + 与主体分离 + 主体远大于它 +
 * 峰值亮度达标(黑底上真的看得见)。纯几何+亮度判定, 只跑一遍 flood fill O(N)。
 */
function findDotArtifacts(mask, lum, w, h, crop) {
  const { left, top, width, height } = crop;
  const N = width * height;
  const label = new Int32Array(N);      // 0 = 未标记; 组件 i 的标记值是 i + 1
  const stack = new Int32Array(N);      // 显式栈(避免递归爆栈)
  const comps = [];                     // { area, x0, y0, x1, y1 }
  for (let sy = 0; sy < height; sy++) {
    for (let sx = 0; sx < width; sx++) {
      const i0 = sy * width + sx;
      if (label[i0] || !mask[(top + sy) * w + (left + sx)]) continue;
      const id = comps.length + 1;
      let sp = 0;
      stack[sp++] = i0;
      label[i0] = id;
      let area = 0, bx0 = sx, bx1 = sx, by0 = sy, by1 = sy;
      while (sp > 0) {
        const i = stack[--sp];
        const x = i % width;
        const y = (i - x) / width;
        area++;
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            const ni = ny * width + nx;
            if (label[ni] || !mask[(top + ny) * w + (left + nx)]) continue;
            label[ni] = id;
            stack[sp++] = ni;
          }
        }
      }
      comps.push({ area, x0: bx0, y0: by0, x1: bx1, y1: by1 });
    }
  }
  if (comps.length < 2) return { dots: 0, faint: 0, mainArea: comps[0]?.area ?? 0 };
  let mainIdx = 0;
  for (let i = 1; i < comps.length; i++) if (comps[i].area > comps[mainIdx].area) mainIdx = i;
  const main = comps[mainIdx];
  const maxArea = Math.max(6, DOT_MAX_AREA_FRAC * width * height);
  const maxW = DOT_MAX_SIZE_FRAC * width;
  const maxH = DOT_MAX_SIZE_FRAC * height;
  let dots = 0;
  let faint = 0;
  for (let i = 0; i < comps.length; i++) {
    if (i === mainIdx) continue;
    const c = comps[i];
    if (c.area > maxArea) continue;                                    // ① 够小
    if (c.x1 - c.x0 + 1 > maxW || c.y1 - c.y0 + 1 > maxH) continue;    // ② 够圆
    if (main.area < c.area * DOT_MAIN_RATIO) continue;                 // 主体远大于它
    const px0 = Math.max(0, c.x0 - DOT_ISOLATED_PAD);
    const px1 = Math.min(width - 1, c.x1 + DOT_ISOLATED_PAD);
    const py0 = Math.max(0, c.y0 - DOT_ISOLATED_PAD);
    const py1 = Math.min(height - 1, c.y1 + DOT_ISOLATED_PAD);
    let inPad = 0;
    let peak = 0;
    for (let y = py0; y <= py1; y++) {
      const gy = top + y;
      for (let x = px0; x <= px1; x++) {
        if (label[y * width + x] === i + 1) {
          inPad++;
          const v = lum[gy * w + (left + x)];                          // ④ 块内峰值
          if (v > peak) peak = v;
        }
      }
    }
    if (inPad !== c.area) continue;                                    // ③ 孤立无邻居
    if (peak >= DOT_MIN_PEAK) dots++;
    else faint++;
  }
  return { dots, faint, mainArea: main.area };
}

// ============================================================================
// === 分类规则 (顺序判定, 先命中先算; 规则原样抄进报告) =====================
// ============================================================================
const RULES = [
  `contrail: aspect >= ${CONTRAIL_ASPECT} 且 fill < ${CONTRAIL_FILL}`,
  `contrail: fill < ${CONTRAIL_TILT_MAX_FILL} 且 主轴倾角 > ${CONTRAIL_TILT_DEG}° (稀疏内容的斜条纹)`,
  `contrail: 法向 RMS 厚度 < ${CONTRAIL_THICKNESS}px (与方向无关: 水平/斜条纹都能抓)`,
  `large: aspect ∈ [${LARGE_ASPECT_MIN}, ${LARGE_ASPECT_MAX}] 且 fill >= ${LARGE_FILL}`,
  `large: bbox 面积 / 原图面积 >= ${LARGE_BBOX_COVER}`,
  'small: 其余(较方、fill 中等) → 中小型孤立团云',
  `不使用: 裁剪窗内检出 >= ${DOT_MIN_COUNT} 个孤立圆点伪影(面积 <= 裁剪 ${DOT_MAX_AREA_FRAC * 100}% + bbox 两维 <= ${DOT_MAX_SIZE_FRAC * 100}% + 周边 ${DOT_ISOLATED_PAD}px 无邻 + 峰值亮度 >= ${DOT_MIN_PEAK})`,
];

function classify(a) {
  if (a.aspect >= CONTRAIL_ASPECT && a.fill < CONTRAIL_FILL) return 'contrail';
  if (a.fill < CONTRAIL_TILT_MAX_FILL && a.tiltDeg > CONTRAIL_TILT_DEG) return 'contrail';
  // 厚度兜底: 水平条纹(倾角≈0)与斜条纹(aspect 接近 1)都靠这条抓 (per user request)
  if (a.thickness > 0 && a.thickness < CONTRAIL_THICKNESS) return 'contrail';
  if (a.aspect >= LARGE_ASPECT_MIN && a.aspect <= LARGE_ASPECT_MAX && a.fill >= LARGE_FILL) return 'large';
  if (a.bboxCover >= LARGE_BBOX_COVER) return 'large';
  return 'small';
}

// ============================================================================
// === 法线贴图: 去掉原图光照后的高度场 → Sobel → n = normalize(vec3(-dx*k, -dy*k, 1))
// ============================================================================
/** 输入: 与输出图**完全同尺寸**的亮度平面(从已编码的 JPEG 再解一次, 保证对齐),
 *  以及同尺寸的**大尺度亮度包络**(shade = 原图自带的光照/阴影, per user request)。
 *  输出: 3 通道 raw RGB(8bit), 即 n*0.5+0.5。
 *
 *  高度场取 `0.5 + (lum − shade)`(相对包络的亮度偏差)而不是裸亮度:
 *    · 等于局部光照基准 → 0.5(平坦); 比基准亮 → 凸起; 比基准暗 → 凹陷。
 *    · 背景是纯黑(shade→0), 所以这里用**减法**不用除法 —— 除法会在云缘 shade≈0 处
 *      把噪声放大成麻点。
 *    · 剥掉大尺度打光后, 法线只表达云瓣/褶皱这种局部起伏, 换太阳方向才对得上。
 */
function sobelNormal(lum, w, h, shade) {
  const rgb = Buffer.allocUnsafe(w * h * 3);
  // 归一化: /255 得到 0..1; /8 是 Sobel 核权重和, 把所有梯度压到 ±1 量级。
  const H = (x, y) => {
    const cx = x < 0 ? 0 : x >= w ? w - 1 : x;
    const cy = y < 0 ? 0 : y >= h ? h - 1 : y;
    const i = cy * w + cx;
    const L = lum[i] / 255;
    if (!shade) return L;
    return 0.5 + (L - shade[i] / 255);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1))
               - (H(x - 1, y - 1) + 2 * H(x - 1, y) + H(x - 1, y + 1));
      // 图像行 y 向下增长; 而切空间 +Y(uv 的 v, three 默认 flipY 后)指向图像**上方**。
      // 所以 "dH/dy" 必须取 **上 - 下**(不是下 - 上)才是切空间 v 方向的导数,
      // 否则法线的 y 分量整体反号 → 立面被"从下往上"照亮(凸起处受光侧跑到底部)。
      const gy = (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1))
               - (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1));
      const dx = gx / 8;
      const dy = gy / 8;
      let nx = -dx * NORMAL_STRENGTH;
      let ny = -dy * NORMAL_STRENGTH;
      let nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv; ny *= inv; nz *= inv;
      const o = (y * w + x) * 3;
      rgb[o] = Math.round((nx * 0.5 + 0.5) * 255);
      rgb[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      rgb[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    }
  }
  return rgb;
}

/**
 * 诊断用: 估计这张云图的**光照来向**(归一化的 2D 单位向量, 图像坐标: +x 右, +y 下)。
 *
 * 做法: 亮度加权质心 减去 前景(掩码)质心 —— 亮的那一侧就是光来的方向。
 * 素材包里的云如果是统一打光(例如都在左上方), 这一列数值会集中在同一象限; 若某张反了,
 * 说明它与其他素材的光照不一致(法线符号要单独当心)。只做记录, 不参与生成。
 */
function measureLightDir(lum, w, h) {
  let wsum = 0, lx = 0, ly = 0, n = 0, cx = 0, cy = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = lum[y * w + x];
      if (v <= LUM_THRESHOLD) continue;
      const f = v / 255;
      wsum += f; lx += x * f; ly += y * f;
      n++; cx += x; cy += y;
    }
  }
  if (!n || wsum <= 0) return [0, 0];
  const dx = lx / wsum - cx / n;
  const dy = ly / wsum - cy / n;
  const m = Math.hypot(dx, dy) || 1;
  return [+(dx / m).toFixed(3), +(dy / m).toFixed(3)];
}

// ============================================================================
// === 处理流程 (自检合成图也走同一条路) =====================================
// ============================================================================
async function processOne(src, out, index, entry) {
  const name = path.basename(src);
  const { lum, w, h } = await luminancePlane(src);
  const a = analyze(lum, w, h);
  if (!a) {
    console.warn(`  [skip] ${name}: 全黑(无有效内容)`);
    entry.skipped = true;
    return;
  }
  const cls = classify(a);

  // === 带圆点伪影的切片整张不使用 (per user request) ===
  // 直接 return: 不写 jpg/法线图 → 目录里没有它 → clouds-atlas.mjs 扫目录时自然也收不到。
  // 不做"抹掉圆点"的修补(用户要的是不用这些纹理)。
  if (a.dots >= DOT_MIN_COUNT) {
    console.warn(`  [drop] ${name}: 检出 ${a.dots} 个孤立圆点伪影 → 不使用该切片`);
    entry.skippedDots = a.dots;
    entry.src = name;            // 报告里要能追到是哪张源切片(emit 路径本来也会写)
    entry.crop = a.crop;         // 记下裁剪窗, 方便事后把丢弃项裁出来人眼复查
    entry.dots = a.dots;
    return;
  }

  // --- 裁剪 + 限最长边 + 压黑底 JPEG (保留黑底无 alpha) ---
  const scale = Math.min(1, MAX_EDGE / Math.max(a.crop.width, a.crop.height));
  const ow = Math.max(1, Math.round(a.crop.width * scale));
  const oh = Math.max(1, Math.round(a.crop.height * scale));
  let pipe = sharp(src, { limitInputPixels: 1 << 28 })
    .extract(a.crop)
    .flatten({ background: { r: 0, g: 0, b: 0 } }); // 带 alpha 也压到黑底
  if (scale < 1) pipe = pipe.resize(ow, oh, { fit: 'fill', kernel: 'lanczos3' });
  const outBuf = await pipe.jpeg({ quality: JPEG_Q, mozjpeg: true }).toBuffer();

  // --- 法线贴图: 从**已编码的输出图**再解亮度 → 尺寸天然一致 ---
  const lum2 = await sharp(outBuf).greyscale().blur(NORMAL_BLUR_SIGMA).raw()
    .toBuffer({ resolveWithObject: true });
  // === 解一层大尺度亮度包络 = 这张素材自带的光照/阴影 (per user request) ===
  // 高度场 = 亮度 − 包络(见 sobelNormal 的注释), 这样法线表达的是形体起伏而不是打光。
  const shadeSigma = Math.max(6, Math.round(Math.min(lum2.info.width, lum2.info.height) * LIGHT_SIGMA_FRAC));
  const shade = await sharp(outBuf).greyscale().blur(shadeSigma).raw()
    .toBuffer({ resolveWithObject: true });
  const nrm = sobelNormal(lum2.data, lum2.info.width, lum2.info.height, shade.data);
  // 诊断: 这张素材的"光照来向"(亮度加权质心相对画面中心的偏移方向) —— 报告里记一笔,
  // 用来确认整包素材的打光方向一致, 以及法线符号没有整体反掉。
  const light = measureLightDir(lum2.data, lum2.info.width, lum2.info.height);
  const nrmBuf = await sharp(nrm, { raw: { width: lum2.info.width, height: lum2.info.height, channels: 3 } })
    // 4:4:4 无次采样: 法线的信息**全在色度通道**上, 默认的 4:2:0 会把它的有效
    // 分辨率砍一半(细节变糊/出现色块), 所以法线图必须关掉 chroma subsampling。
    .jpeg({ quality: JPEG_Q, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer();

  // --- 落盘 ---
  const dir = path.join(out, cls === 'contrail' ? '_contrail' : cls);
  fs.mkdirSync(dir, { recursive: true });
  const base = `${cls}-${String(entry.index).padStart(3, '0')}`;
  const fileRel = `${cls === 'contrail' ? '_contrail' : cls}/${base}.jpg`;
  const normRel = `${cls === 'contrail' ? '_contrail' : cls}/${base}_n.jpg`;
  fs.writeFileSync(path.join(out, fileRel), outBuf);
  fs.writeFileSync(path.join(out, normRel), nrmBuf);

  entry.file = fileRel.split(path.sep).join('/');
  entry.normal = normRel.split(path.sep).join('/');
  entry.class = cls;
  entry.src = name;
  entry.w = lum2.info.width;
  entry.h = lum2.info.height;
  entry.aspect = +(a.aspect).toFixed(3);
  entry.fill = +(a.fill).toFixed(3);
  entry.tiltDeg = +(a.tiltDeg).toFixed(1);
  entry.dots = a.dots;
  // 这张素材的光照来向(诊断): 确认整包打光一致、法线符号没整体反掉。
  entry.light = light;
  entry.bboxCover = +(a.bboxCover).toFixed(3);
  entry.srcW = a.srcW;
  entry.srcH = a.srcH;
  entry.cropW = a.crop.width;
  entry.cropH = a.crop.height;
}

// ============================================================================
// === 自检: 用 sharp 现场合成 3 张黑底测试图 (无需真实素材) ==================
// ============================================================================
async function makeSynthetic(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const S = 1024;
  // ① 大型平底团云: 宽椭圆, 铺满宽度 → aspect≈2, fill 高, bbox 占比大。
  await sharp({
    create: { width: S, height: S, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${S}" height="${S}"><ellipse cx="${S / 2}" cy="${S / 2}" rx="${S * 0.47}" ry="${S * 0.24}" fill="#d8d8d8"/></svg>`,
        ),
        top: 0, left: 0,
      },
    ])
    .jpeg({ quality: 92 })
    .toFile(path.join(dir, 'raw-large.jpg'));
  // ② 中小型孤立团云: 居中**径向渐变的圆顶**(中心亮、边缘渐黑 —— 更像真云的
  //    软边, 也让法线贴图有真实梯度可验: 顶部 G>128 / 底部 G<128 / 左 R<128)。
  await sharp({
    create: { width: S, height: S, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${S}" height="${S}"><defs><radialGradient id="d">` +
            `<stop offset="0" stop-color="#e6e6e6"/><stop offset="0.55" stop-color="#a0a0a0"/>` +
            `<stop offset="1" stop-color="#000000"/></radialGradient></defs>` +
            `<circle cx="${S / 2}" cy="${S / 2}" r="${S * 0.16}" fill="url(#d)"/></svg>`,
        ),
        top: 0, left: 0,
      },
    ])
    .jpeg({ quality: 92 })
    .toFile(path.join(dir, 'raw-small.jpg'));
  // ③ 斜细条航迹云: 45° 细长条 → 触发"极细长 / 主轴倾斜"两条判据。
  await sharp({
    create: { width: S, height: S, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${S}" height="${S}"><rect x="-200" y="${S / 2 - 9}" width="${S + 400}" height="18" fill="#e0e0e0" transform="rotate(-45 ${S / 2} ${S / 2})"/></svg>`,
        ),
        top: 0, left: 0,
      },
    ])
    .jpeg({ quality: 92 })
    .toFile(path.join(dir, 'raw-contrail.jpg'));
  // ④ 近乎无内容的噪点图: 验证"全黑/无内容"分支不崩(只有几粒噪声)。
  await sharp({
    create: { width: S, height: S, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${S}" height="${S}"><rect x="700" y="700" width="3" height="3" fill="#000"/></svg>`,
        ),
        top: 0, left: 0,
      },
    ])
    .jpeg({ quality: 92 })
    .toFile(path.join(dir, 'raw-empty.jpg'));
}

// ============================================================================
// === main ==================================================================
// ============================================================================
async function main() {
  let src = SRC_ARG;
  let out = OUT_ARG;
  let selfDir = null;
  if (SELFTEST) {
    selfDir = path.join(ROOT, '.tmp-clouds-selftest');
    fs.rmSync(selfDir, { recursive: true, force: true });
    src = path.join(selfDir, 'raw');
    out = path.join(selfDir, 'out');
    await makeSynthetic(src);
    console.log(`[selftest] 合成源图 → ${path.relative(ROOT, src)}`);
  }

  const files = collectSources(src);
  if (!files.length) {
    console.error(`未找到源图: ${src}`);
    console.error('把原始云贴图(黑底 JPG)放进该目录, 或用 --src <目录|glob> 指定;');
    console.error('也可以用 --selftest 跑一遍合成图自检。');
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(out, { recursive: true });
  // 上一次的输出先清掉(否则改了阈值后旧文件会残留, 张数对不上)。
  for (const c of ['large', 'small', '_contrail']) {
    const d = path.join(out, c);
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  }

  const counters = { large: 0, small: 0, contrail: 0 };
  const entries = [];
  console.log(`[1/2] 处理 ${files.length} 张: ${src}`);
  for (const f of files) {
    // 分类在 processOne 里做, 但编号要先知道类别 → 先单独分析一次拿类别/统计。
    const { lum, w, h } = await luminancePlane(f);
    const a = analyze(lum, w, h);
    if (!a) {
      console.warn(`  [skip] ${path.basename(f)}: 全黑(无有效内容)`);
      entries.push({ src: path.basename(f), skipped: true });
      continue;
    }
    const cls = classify(a);
    // ⚠️ 计数器只在实际**写出文件**时递增: 被圆点规则丢弃的切片不占编号 —— 否则
    // 打印出来的分类统计与实际目录里的文件数对不上(会误读成"少了几张")。
    const e = { index: counters[cls] + 1 };
    await processOne(f, out, counters[cls] + 1, e);
    if (e.file) counters[cls]++;
    entries.push(e);
    console.log(
      `  ${String(cls).padEnd(8)} ${e.file ?? '-'}  ${a.srcW}x${a.srcH} → ${a.crop.width}x${a.crop.height}` +
        `(出图 ${e.w}x${e.h})  aspect=${e.aspect} fill=${e.fill} tilt=${e.tiltDeg}° bbox=${e.bboxCover}`,
    );
  }

  // --- 清单(向后兼容: files 里是对象, 但也接受纯字符串 —— 加载器两种都吃) ---
  const listed = entries.filter((e) => !e.skipped);
  const manifest = {
    generator: 'scripts/clouds-prep.mjs',
    rules: RULES,
    files: listed.map((e) => ({
      file: e.file,
      normal: e.normal,
      class: e.class,
      w: e.w,
      h: e.h,
      aspect: e.aspect,
      fill: e.fill,
    })),
  };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const report = {
    src: path.relative(ROOT, src).split(path.sep).join('/'),
    out: path.relative(ROOT, out).split(path.sep).join('/'),
    constants: {
      LUM_THRESHOLD, BBOX_BLUR_SIGMA, CROP_MARGIN,
      CONTRAIL_ASPECT, CONTRAIL_FILL, CONTRAIL_TILT_DEG, CONTRAIL_TILT_MAX_FILL,
      LARGE_ASPECT_MIN, LARGE_ASPECT_MAX, LARGE_FILL, LARGE_BBOX_COVER,
      NORMAL_STRENGTH, NORMAL_BLUR_SIGMA, MAX_EDGE, JPEG_Q,
    },
    rules: RULES,
    counts: { input: files.length, large: counters.large, small: counters.small, excluded: counters.contrail },
    files: listed,
  };
  fs.writeFileSync(path.join(out, 'clouds-prep-report.json'), JSON.stringify(report, null, 2) + '\n');

  console.log('[2/2] 分类统计');
  console.log(`  输入            : ${files.length} 张`);
  console.log(`  large  (大云)   : ${counters.large} 张 → ${path.join(path.relative(ROOT, out), 'large')}/`);
  console.log(`  small  (小云)   : ${counters.small} 张 → ${path.join(path.relative(ROOT, out), 'small')}/`);
  console.log(`  排除到 _contrail: ${counters.contrail} 张(航迹云, 游戏端暂不使用)`);
  console.log(`  丢弃(圆点)      : ${listed.filter((e) => e.skippedDots).length} 张(不写文件, 不进图集)`);
  console.log(`  清单            : ${path.join(path.relative(ROOT, out), 'manifest.json')}`);
  console.log(`  报告            : ${path.join(path.relative(ROOT, out), 'clouds-prep-report.json')}`);
}

main().catch((e) => {
  console.error('[clouds-prep] 失败:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
