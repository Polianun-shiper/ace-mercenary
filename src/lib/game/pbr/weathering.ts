// === 程序化风化场生成器 (per user request: 把程序化噪声生成器升级到"顶级光泽图"质感) ===
//
// 参考图(一张顶级 MiG-29 模型的光泽度贴图 = 反相粗糙度)里一半信息量来自**锁在几何上的
// 结构**, 纯噪声做不出来:
//   · 随机就能做的: 大尺度云雾色斑 / 细长划痕 / 气流方向条纹油污 / 稀疏掉漆灰尘点;
//   · 必须锁几何的: 蒙皮分块(每块光泽略不同) / 铆钉行 / 板边磨亮 / 凹坑积灰。
//
// 捷径(本文件的立足点): **模型自带的法线图里本来就画着真实的板缝与铆钉**。对法线的
// x/y 分量求散度 = 高度场的拉普拉斯(∇²h), 正=凹(缝/铆钉坑/凹坑)、负=凸(板边/铆钉帽),
// 于是"缝更粗糙更脏 / 凸边与铆钉更亮 / 凹坑积灰"全部天然锁在几何上, 而且
// **不加采样器、不加文件体积**(仍然只是同一张 ORM 的 G 通道)。
//
// 没有法线图时优雅降级: 用 albedo 的高通(暗线=缝, 亮线=棱)当代理高度场; 连 albedo
// 都没有细节时整层掩膜退化为 0, 只剩多尺度风化 —— 不报错、不崩。
//
// 本文件**不依赖 three、不碰 canvas**: 只吃/吐像素数组, 由调用方决定合成进哪张画布
// (见 texture-sets.ts 的 ORM / detail-maps.ts 的 UV 对齐粗糙度)。

export type WeatherQuality = 'low' | 'medium' | 'high';

// ---------------------------------------------------------------------------
// 基础工具: 确定性 PRNG + value noise + fbm
// ---------------------------------------------------------------------------

/** mulberry32: 数字种子 → 稳定序列(同一台机体每次生成完全一致)。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 字符串 → 32 位种子(和 texture-sets 的 seededRand 同一套混合)。 */
export function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hash2(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x: number, y: number, s: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const sx = xf * xf * (3 - 2 * xf);
  const sy = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s);
  const c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

function fbm(x: number, y: number, oct: number, s: number): number {
  let v = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) {
    v += amp * vnoise(x * f, y * f, s + i * 17);
    f *= 2;
    amp *= 0.5;
  }
  return v;
}

// ---------------------------------------------------------------------------
// 1. 几何派生掩膜: 高度场 → 凹(cavity) / 凸(curvature)
// ---------------------------------------------------------------------------

export interface CavityMaps {
  w: number;
  h: number;
  /** 凹: 板缝 / 铆钉坑 / 凹坑。0..1(已按均值归一, 与源图对比度无关)。 */
  cav: Float32Array;
  /** 凸: 板边 / 铆钉帽 / 棱线。0..1。 */
  con: Float32Array;
}

/** 分离式盒式模糊(求"局部均值"/展开细线用)。O(n) 与半径无关(前缀和)。 */
function boxBlurF(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r <= 0) return src.slice();
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / (2 * r + 1);
      const add = src[row + Math.min(w - 1, x + r + 1)];
      const sub = src[row + Math.max(0, x - r)];
      acc += add - sub;
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * r + 1);
      const add = tmp[Math.min(h - 1, y + r + 1) * w + x];
      const sub = tmp[Math.max(0, y - r) * w + x];
      acc += add - sub;
    }
  }
  return out;
}

/**
 * 把一个"∇²h 场"拆成凹/凸掩膜。
 * 正 = 凹(缝/铆钉坑, 局部高度最低), 负 = 凸(板边/铆钉帽)。
 * 归一化用**均值**而不是最大值: 最大值总落在少数几根线上, 用它归一会让绝大多数像素
 * 变成 0, 掩膜在模型上等于不存在; 归一到目标均值后"缝占多少面积"才与源图对比度无关。
 */
function splitCavity(lap: Float32Array, w: number, h: number, spread: number, gain: number): CavityMaps {
  // 展开: 缝在源图上只有 1~2px, 直接拿去调粗糙度会在 mip/远景里被抹平。
  const bl = spread > 0 ? boxBlurF(lap, w, h, spread) : lap;
  let ss = 0;
  for (let i = 0; i < bl.length; i++) ss += bl[i] > 0 ? bl[i] : -bl[i];
  const mean = ss / Math.max(1, bl.length);
  // 平坦法线(实测 MiG-29 的 _n 就是) ⇒ 均值≈0 ⇒ 返回空掩膜, 优雅降级。
  if (!(mean > 2e-4)) return { w, h, cav: new Float32Array(w * h), con: new Float32Array(w * h) };
  const k = Math.min(gain * 40, CAVITY_TARGET / mean);
  const cav = new Float32Array(w * h);
  const con = new Float32Array(w * h);
  for (let i = 0; i < bl.length; i++) {
    const v = bl[i] * k;
    if (v > 0) cav[i] = v < 1 ? v : 1;
    else con[i] = -v < 1 ? -v : 1;
  }
  return { w, h, cav, con };
}

/** 掩膜的平均幅值目标(见 splitCavity: 用均值归一才与源图对比度无关)。 */
const CAVITY_TARGET = 0.05;

/**
 * 法线图(RGB, 法线 x/y 在 R/G) → 凹/凸掩膜。这是首选路径: 结构天然锁几何。
 *
 * 数学: 高度场 h 的法线 n ≈ normalize(-hx, -hy, 1) ⇒ nx ≈ -∂h/∂x。
 * 于是 **∇²h = -(∂nx/∂x + ∂ny/∂y)** —— 直接用散度, 不需要真的积分出 h。
 * 中心差分取 ±1 像素(源图画的就是 1~2px 的缝与铆钉)。
 */
export function cavityFromNormal(data: Uint8ClampedArray, w: number, h: number, spread = 2): CavityMaps {
  const n = w * h;
  const nx = new Float32Array(n);
  const ny = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    nx[i] = (data[i * 4] - 127.5) / 127.5;
    ny[i] = (data[i * 4 + 1] - 127.5) / 127.5;
  }
  const lap = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : y, yp = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : x, xp = x < w - 1 ? x + 1 : x;
      lap[y * w + x] = -0.5 * ((nx[y * w + xp] - nx[y * w + xm]) + (ny[yp * w + x] - ny[ym * w + x]));
    }
  }
  return splitCavity(lap, w, h, spread, 1.0);
}

/**
 * 没有法线图时的降级路径: 用 **albedo 亮度的高通**当代理高度场。
 * 暗线(面板缝/铆钉投影/污渍) → 凹, 亮线(棱边高光/抛光) → 凸。
 * 实测 MiG-29 贴图族就是这样: `_n` 全平, 但 `_c` 上板缝/铆钉画得清清楚楚。
 */
export function cavityFromAlbedo(data: Uint8ClampedArray, w: number, h: number, radius = 3): CavityMaps {
  const n = w * h;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    lum[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) / 255;
  }
  const bg = boxBlurF(lum, w, h, radius);
  // 高通后**再低通一次**: JPEG 的块状噪声在单像素尺度上比板缝还强, 不滤掉的话
  // 掩膜会跟着 JPEG 走(实测 MiG-29 的 _c 是 JPEG q~80)。
  const hp = boxBlurF(lum.map((v, i) => v - bg[i]), w, h, 1);
  // 代理高度场 = 高通亮度 ⇒ 二阶导(拉普拉斯): 暗线(缝/铆钉影/污渍)为正 = 凹。
  const lap = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : y, yp = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : x, xp = x < w - 1 ? x + 1 : x;
      lap[y * w + x] = hp[y * w + xm] + hp[y * w + xp] + hp[ym * w + x] + hp[yp * w + x] - 4 * hp[y * w + x];
    }
  }
  return splitCavity(lap, w, h, 2, 1.0);
}

// ---------------------------------------------------------------------------
// 2. 多尺度程序化风化场
// ---------------------------------------------------------------------------

/** 真镜面/光泽图(WG 的 `_n_s`): 只在**亮点**处起作用 —— 那里是真机被磨亮的地方。 */
export interface GlossSource {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

export interface WeatherOpts {
  w: number;
  h: number;
  seed: number;
  level: WeatherQuality;
  /** 基础粗糙度(0..1)。给了 cavity 也没关系 —— 掩膜是"加"在它上面的。 */
  base: number;
  /** 几何派生掩膜; 没有就传 null(优雅降级, 只剩多尺度风化)。 */
  cavity?: CavityMaps | null;
  /** 稀疏的真镜面图: 亮点额外抛光(用真图补程序化做不出来的真机结构)。 */
  gloss?: GlossSource | null;
}

export interface WeatherFields {
  w: number;
  h: number;
  /** 最终粗糙度 0..1(RMG 的 G 通道)。 */
  rough: Float32Array;
  /** 灰尘/污渍量 0..1 → 压暗 albedo、压暗 AO。 */
  grime: Float32Array;
  /** 磨亮/抛光量 0..1 → albedo 微微提亮。 */
  shine: Float32Array;
}

/** 双线性采样(把"噪声分辨率"的平滑层放大到目标分辨率)。 */
function bilin(f: Float32Array, fw: number, fh: number, x: number, y: number): number {
  const fx = x - 0.5, fy = y - 0.5;
  let x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  let x1 = x0 + 1, y1 = y0 + 1;
  if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
  if (x1 > fw - 1) x1 = fw - 1; if (y1 > fh - 1) y1 = fh - 1;
  if (x0 > fw - 1) x0 = fw - 1; if (y0 > fh - 1) y0 = fh - 1;
  const a = f[y0 * fw + x0], b = f[y0 * fw + x1], c = f[y1 * fw + x0], d = f[y1 * fw + x1];
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

/** 二维场内的归一化采样(掩膜分辨率可能与目标不同)。 */
function sampleNorm(f: Float32Array, fw: number, fh: number, u: number, v: number): number {
  return bilin(f, fw, fh, u * (fw - 1) + 1, v * (fh - 1) + 1);
}

/**
 * 压缩动态范围到 [0,1] 的 soft 曲线(拐点附近平滑)。
 * 为什么不用 min/max 拉伸: 单点极值会把整张图拉到两端, 中间全挤在一起。
 */
function soft(v: number, lo: number, hi: number): number {
  if (hi <= lo) return 0;
  let t = (v - lo) / (hi - lo);
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  return t * t * (3 - 2 * t);
}

const W_HIGH = {
  blotch: 0.13,   // 云雾状色斑(域扭曲 FBM)
  streak: 0.12,   // 气流方向条纹油污
  patch: 0.085,   // 蒙皮分块光泽差
  scratch: 0.22,  // 划痕
  chip: 0.16,     // 掉漆/灰尘点
  seam: 0.26,     // 凹(缝/坑) → 更粗糙
  edge: 0.34,     // 凸(板边/铆钉) → 更亮
  gloss: 0.50,    // 真镜面亮点 → 抛光
  grime: 0.26,    // 积灰对粗糙度的额外贡献
};
const W_MED = {
  blotch: 0.10, streak: 0.08, patch: 0.07, scratch: 0.10, chip: 0.08,
  seam: 0.18, edge: 0.24, gloss: 0.35, grime: 0.18,
};
const W_LOW = {
  blotch: 0.07, streak: 0.05, patch: 0.05, scratch: 0.0, chip: 0.0,
  seam: 0.0, edge: 0.0, gloss: 0.0, grime: 0.10,
};

// 粗糙度夹紧区间 —— 下限保"太阳扫过有窄高光", 上限保"哑光区不亮成塑料"。
const ROUGH_LO = 0.07;
const ROUGH_HI = 0.97;

/**
 * 生成三层风化场(粗糙度 / 灰尘 / 磨亮)。
 *
 * 所有"平滑"的噪声层都先在**噪声分辨率**(≤512)上算, 再双线性放大 —— 这样 2048² 的
 * UV 对齐粗糙度也负担得起(否则 4M 像素逐个求 fbm 会明显拖慢机库加载)。
 * 需要保持锐利的层(几何掩膜 / 划痕 / 掉漆点)在目标分辨率上算。
 */
export function weatheringFields(o: WeatherOpts): WeatherFields {
  const w = o.w, h = o.h, n = w * h;
  const wts = o.level === 'low' ? W_LOW : o.level === 'medium' ? W_MED : W_HIGH;
  const rd = rng(o.seed);

  // --- 平滑层: **噪声分辨率**(再双线性放大到目标分辨率) ---
  // div ≥ 2: 512² 的机体贴图在 256² 上算噪声, 视觉上分辨不出, 但直接省掉 3/4 的
  // fbm 计算 —— 这是本文件耗时的大头(逐像素 4 个 fbm × 3 倍频)。
  const div = Math.max(o.level === 'low' ? 4 : 2, Math.round(Math.max(w, h) / 512));
  const nw = Math.max(16, Math.ceil(w / div)), nh = Math.max(16, Math.ceil(h / div));
  const nn = nw * nh;
  const blotch = new Float32Array(nn);   // 有符号: 中心 0, ±1
  const streak = new Float32Array(nn);   // 0..1
  const patch = new Float32Array(nn);    // 0..1(一块一个值)
  const patchShine = new Float32Array(nn);

  // ① 大尺度云雾色斑: FBM + **域扭曲** —— "不均匀旧漆"观感的来源。
  //    没有域扭曲的 FBM 是"棉花团", 扭曲之后才有真实的涂抹/氧化形状。
  for (let y = 0; y < nh; y++) {
    const v = y / nh;
    for (let x = 0; x < nw; x++) {
      const u = x / nw;
      const qx = fbm(u * 3.1 + 11.7, v * 3.1 + 4.3, 2, o.seed + 101) - 0.5;
      const qy = fbm(u * 3.1 + 27.1, v * 3.1 + 9.9, 2, o.seed + 211) - 0.5;
      // 大斑块(低频) + 中斑块(中频), 扭到一起去
      const b1 = fbm(u * 2.6 + 2.2 * qx, v * 2.6 + 2.2 * qy, 3, o.seed + 7);
      const b2 = fbm(u * 6.5 + 1.1 * qx, v * 6.5 + 1.1 * qy, 2, o.seed + 13);
      blotch[y * nw + x] = (b1 * 0.62 + b2 * 0.38 - 0.5) * 2;
      // ② 方向性条纹: 沿 V 拉长(u 高频/v 低频) = 气流方向/油污流痕。
      //    再加一点沿 V 的横向扭曲, 免得像直尺画出来的。
      const bend = (fbm(u * 2.0, v * 0.6, 2, o.seed + 31) - 0.5) * 0.55;
      const s1 = fbm((u + bend) * 26, v * 1.6, 3, o.seed + 41);
      const s2 = fbm((u + bend) * 58, v * 3.0, 2, o.seed + 53);
      streak[y * nw + x] = soft(s1 * 0.68 + s2 * 0.32, 0.40, 0.74);
    }
  }

  // ③ 逐区块光泽差异: **抖动网格 Voronoi**(不是规则格) —— 每块蒙皮一个独立的
  //    光泽偏移, 复现参考图里"一块一个值"。分块大小 ~1/nCells, 边界只做窄过渡。
  {
    const cells = o.level === 'low' ? 4 : 5;
    // 抖动 4 个自由度(位置 x/y + 光泽 + 抛光)预先烘进表里 —— 逐像素调 9 次哈希
    // (每次 4 个 hash2)是这里最贵的一步, 预烘后只剩数组读取。
    const g = cells + 2;   // 外围留一圈, 处理边界格时不必判负
    const jpx = new Float32Array(g * g), jpy = new Float32Array(g * g);
    const jval = new Float32Array(g * g), jsh = new Float32Array(g * g);
    for (let y = 0; y < g; y++) {
      for (let x = 0; x < g; x++) {
        const cx = x - 1, cy = y - 1;
        const j = (k: number) => vnoise(cx * 1.37 + cy * 7.71 + k * 3.17, cy * 2.11 + k * 13.3, o.seed + 71 + k * 29);
        const i = y * g + x;
        // 抖动幅度 < 半格, 保证栅格拓扑不乱
        jpx[i] = (cx + 0.15 + 0.7 * j(0)) / cells;
        jpy[i] = (cy + 0.15 + 0.7 * j(1)) / cells;
        jval[i] = j(2);
        jsh[i] = j(3);
      }
    }
    // 格宽不等时把 v 方向拉直, 让"分块"大体近似方形 —— 但**不是规则网格**: 每格
    // 的边界由抖动后的种子位置决定, 所以看不出贴图接缝。
    const aspect = nh / nw;
    for (let y = 0; y < nh; y++) {
      const v = y / nh;
      const gy = Math.min(cells - 1, Math.floor(v * cells)) + 1;
      for (let x = 0; x < nw; x++) {
        const u = x / nw;
        const gx = Math.min(cells - 1, Math.floor(u * cells)) + 1;
        let best = 1e9, second = 1e9, bestVal = 0, bestShine = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const i = (gy + oy) * g + (gx + ox);
            const dx = u - jpx[i], dy = (v - jpy[i]) * aspect;
            const d = dx * dx + dy * dy;
            if (d < best) {
              second = best; best = d;
              bestVal = jval[i];
              bestShine = jsh[i];
            } else if (d < second) second = d;
          }
        }
        // 边界过渡: 第二近种子离得远 ⇒ 块内部(权重 1); 很近 ⇒ 边界(权重 0)。
        const border = soft(Math.sqrt(second - best) * cells, 0.03, 0.18);
        patch[y * nw + x] = bestVal * border;
        patchShine[y * nw + x] = (bestShine < 0.6 ? 0 : (bestShine - 0.6) / 0.4) * border;
      }
    }
  }

  // --- 全分辨率层 ---
  const rough = new Float32Array(n);
  const grime = new Float32Array(n);
  const shine = new Float32Array(n);
  const cav = o.cavity && o.cavity.w > 0 ? o.cavity : null;

  // 真镜面图: 亮点阈值按图自身的 99 分位自适应 —— WG 的 _n_s 全图近黑, 固定阈值会
  // 把整张图判成"无信息"或把噪声判成"抛光"。
  let gloss = o.gloss;
  let gLo = 1, gHi = 1;
  if (gloss && gloss.data.length) {
    const hist = new Uint32Array(64);
    const gn = gloss.w * gloss.h;
    for (let i = 0; i < gn; i++) {
      const l = (gloss.data[i * 4] * 0.299 + gloss.data[i * 4 + 1] * 0.587 + gloss.data[i * 4 + 2] * 0.114) / 255;
      hist[Math.min(63, (l * 64) | 0)]++;
    }
    let acc = 0, p99 = 1;
    for (let b = 63; b >= 0; b--) {
      acc += hist[b];
      if (acc >= gn * 0.01) { p99 = (b + 1) / 64; break; }
    }
    gLo = Math.max(0.10, p99 * 0.30);
    gHi = Math.max(gLo + 0.05, p99 * 0.92);
    if (p99 < 0.06) gloss = null;   // 整张就是黑的 → 没有可用信息
  }

  const useCav = !!cav && (wts.seam > 0 || wts.edge > 0);
  const grainAmp = o.level === 'low' ? 0.030 : o.level === 'medium' ? 0.045 : 0.055;
  // 掩膜分辨率与目标一致时可以退化成直接索引(绝大多数情况), 省掉两次双线性。
  const cavSame = !!cav && cav.w === w && cav.h === h;
  const cavW = cav ? cav.w : 0, cavH = cav ? cav.h : 0;
  const cavFx = cav ? cavW / w : 0, cavFy = cav ? cavH / h : 0;

  for (let y = 0; y < h; y++) {
    // 四个平滑场的双线性权重逐像素只算一次, 供 blotch/streak/patch/patchShine 共用
    const fy = y / div;
    let y0 = Math.floor(fy);
    const ty = fy - y0;
    let y1 = y0 + 1;
    if (y0 > nh - 1) y0 = nh - 1;
    if (y1 > nh - 1) y1 = nh - 1;
    const w0 = y0 * nw, w1 = y1 * nw;
    const wy0 = 1 - ty, wy1 = ty;
    const glRow = gloss ? Math.min(gloss.h - 1, ((y * gloss.h / h) | 0)) * gloss.w : 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const fx = x / div;
      let x0 = Math.floor(fx);
      const tx = fx - x0;
      let x1 = x0 + 1;
      if (x0 > nw - 1) x0 = nw - 1;
      if (x1 > nw - 1) x1 = nw - 1;
      const wx0 = 1 - tx, wx1 = tx;
      const b00 = w0 + x0, b01 = w0 + x1, b10 = w1 + x0, b11 = w1 + x1;
      const k00 = wx0 * wy0, k01 = wx1 * wy0, k10 = wx0 * wy1, k11 = wx1 * wy1;
      const bl = blotch[b00] * k00 + blotch[b01] * k01 + blotch[b10] * k10 + blotch[b11] * k11;
      const st = streak[b00] * k00 + streak[b01] * k01 + streak[b10] * k10 + streak[b11] * k11;
      const pt = patch[b00] * k00 + patch[b01] * k01 + patch[b10] * k10 + patch[b11] * k11;
      const ps = patchShine[b00] * k00 + patchShine[b01] * k01 + patchShine[b10] * k10 + patchShine[b11] * k11;

      let c = 0, e = 0;
      if (useCav) {
        if (cavSame) {
          c = cav!.cav[i]; e = cav!.con[i];
        } else {
          const u = x * cavFx, vv = y * cavFy;
          c = sampleNorm(cav!.cav, cavW, cavH, u, vv);
          e = sampleNorm(cav!.con, cavW, cavH, u, vv);
        }
      }
      let gl = 0;
      if (gloss) {
        const gi = glRow + Math.min(gloss.w - 1, ((x * gloss.w / w) | 0));
        const l = (gloss.data[gi * 4] * 0.299 + gloss.data[gi * 4 + 1] * 0.587 + gloss.data[gi * 4 + 2] * 0.114) / 255;
        gl = soft(l, gLo, gHi);
      }

      // 灰尘: 凹处积灰 + 云雾斑(正半边) + 油污条纹
      let g = c * 0.85 + (bl > 0 ? bl * 0.55 : 0) + st * 0.62;
      if (g > 1) g = 1;
      // 磨亮: 凸边 + 抛光区块
      let sh = e * 0.9 + ps * 0.55;
      if (sh > 1) sh = 1;

      // 细颗粒(蒙皮微观起伏): 逐像素一点白噪声, 让高光不至于像塑料一样干净
      const grain = (hash2(x, y, o.seed + 997) - 0.5) * grainAmp;

      let r = o.base
        + c * wts.seam            // 缝/坑 → 更粗糙
        + g * wts.grime           // 积灰 → 更粗糙
        + bl * wts.blotch         // 云雾斑(有符号: 亮处更光滑/暗处更糙)
        + st * wts.streak         // 条纹油污 → 更粗糙
        + (pt - 0.5) * 2 * wts.patch  // 分块差异(有符号)
        - e * wts.edge            // 凸边/铆钉 → 更亮
        - sh * wts.grime * 0.35   // 磨亮顺带压一点粗糙
        - gl * wts.gloss          // 真图上的镜面点
        + grain;
      if (r < ROUGH_LO) r = ROUGH_LO;
      else if (r > ROUGH_HI) r = ROUGH_HI;

      rough[i] = r;
      grime[i] = g;
      shine[i] = sh;
    }
  }

  // ④ 划痕: 细长线段 splat(随机方向/长度/深浅), 一部分露金属(更亮)一部分划毛(更糙)。
  if (wts.scratch > 0) {
    const k = Math.max(1, Math.round(Math.max(w, h) / 256));
    const count = Math.round(10 * k * k);
    const maxLen = Math.max(6, Math.max(w, h) * 0.22);
    for (let i = 0; i < count; i++) {
      const x0 = rd() * w, y0 = rd() * h;
      const ang = rd() * Math.PI * 2;
      const len = (0.08 + 0.92 * rd() * rd()) * maxLen;
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const wide = 0.5 + rd() * 0.9;
      const amp = (0.35 + 0.65 * rd()) * wts.scratch;
      const metal = rd() < 0.35 ? -1 : 1;   // -1: 露金属(变亮) / 1: 划毛(变糙)
      const steps = Math.max(2, Math.round(len));
      for (let s = 0; s < steps; s++) {
        const px = x0 + dx * s, py = y0 + dy * s;
        const r = wide * (0.6 + 0.4 * (s / steps));
        const x1 = Math.floor(px - r - 1), x2 = Math.ceil(px + r + 1);
        const y1 = Math.floor(py - r - 1), y2 = Math.ceil(py + r + 1);
        for (let yy = y1; yy <= y2; yy++) {
          if (yy < 0 || yy >= h) continue;
          for (let xx = x1; xx <= x2; xx++) {
            if (xx < 0 || xx >= w) continue;
            const ddx = xx - px, ddy = yy - py;
            const d = Math.sqrt(ddx * ddx + ddy * ddy);
            if (d > r) continue;
            const a = (1 - d / r) * amp;
            const j = yy * w + xx;
            rough[j] = Math.min(ROUGH_HI, Math.max(ROUGH_LO, rough[j] + a * metal));
            if (metal > 0) grime[j] = Math.min(1, grime[j] + a * 0.5);
          }
        }
      }
    }
  }

  // ⑤ 掉漆/灰尘点: 稀疏小圆点, 中间露金属(亮)、边缘一圈积灰。
  if (wts.chip > 0) {
    const k = Math.max(1, Math.round(Math.max(w, h) / 256));
    const count = Math.round(26 * k * k);
    const rMax = Math.max(1.2, Math.max(w, h) * 0.0035);
    for (let i = 0; i < count; i++) {
      const cx = rd() * w, cy = rd() * h;
      const r = rMax * (0.4 + rd() * 0.9);
      const amp = (0.4 + 0.6 * rd()) * wts.chip;
      const x1 = Math.floor(cx - r * 2 - 1), x2 = Math.ceil(cx + r * 2 + 1);
      const y1 = Math.floor(cy - r * 2 - 1), y2 = Math.ceil(cy + r * 2 + 1);
      for (let yy = y1; yy <= y2; yy++) {
        if (yy < 0 || yy >= h) continue;
        for (let xx = x1; xx <= x2; xx++) {
          if (xx < 0 || xx >= w) continue;
          const ddx = xx - cx, ddy = yy - cy;
          const d = Math.sqrt(ddx * ddx + ddy * ddy);
          const j = yy * w + xx;
          if (d < r) {
            // 芯: 露出金属, 比周围漆面**光滑**(参考图里的亮点就是这种)
            rough[j] = Math.max(ROUGH_LO, rough[j] - amp);
          } else if (d < r * 1.9) {
            // 环: 漆边翻起 + 积灰
            const a = (1 - (d - r) / (r * 0.9)) * amp * 0.6;
            rough[j] = Math.min(ROUGH_HI, rough[j] + a);
            grime[j] = Math.min(1, grime[j] + a * 0.8);
          }
        }
      }
    }
  }

  return { w, h, rough, grime, shine };
}

// ---------------------------------------------------------------------------
// 3. 场 → 画布(调用方拿去合成 ORM / albedo)
// ---------------------------------------------------------------------------

/** 把 0..1 的场写成灰度画布(粗糙度 / AO 用)。 */
export function fieldToCanvas(f: Float32Array, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < w * h; i++) {
    const v = Math.max(0, Math.min(255, Math.round(f[i] * 255)));
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * 把灰尘/磨亮场合成进一张已有画布。
 * `dirt` = 积灰压暗幅度, `sheen` = 磨亮提亮幅度(同一张场, 各通道给不同权重)。
 */
export function applyWeatheringToCanvas(
  canvas: HTMLCanvasElement,
  f: WeatherFields,
  opts: { dirt?: number; sheen?: number },
) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const dirt = opts.dirt ?? 0;
  const sheen = opts.sheen ?? 0;
  const fw = f.w, fh = f.h;
  for (let y = 0; y < h; y++) {
    const fy = (y * fh / h) | 0;
    for (let x = 0; x < w; x++) {
      const i = fy * fw + ((x * fw / w) | 0);
      let m = 1 - f.grime[i] * dirt + f.shine[i] * sheen;
      if (m < 0.15) m = 0.15;
      const o = (y * w + x) * 4;
      const r = d[o] * m, g = d[o + 1] * m, b = d[o + 2] * m;
      d[o] = r > 255 ? 255 : r;
      d[o + 1] = g > 255 ? 255 : g;
      d[o + 2] = b > 255 ? 255 : b;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// ---------------------------------------------------------------------------
// 4. 调试导出(?texdump)：把画布挂到 window 供探针落 PNG(验收用)
// ---------------------------------------------------------------------------

const dumped: Record<string, HTMLCanvasElement> = {};
const TEX_DUMP = typeof location !== 'undefined'
  && /(^|[?&#])texdump/.test((location.search || '') + (location.hash || ''));

/** 探针开着 ?texdump 时把画布登记到 window.__texCanvases[name]。 */
export function dumpCanvas(name: string, canvas: HTMLCanvasElement) {
  if (!TEX_DUMP || typeof window === 'undefined') return;
  dumped[name] = canvas;
  const w = window as unknown as Record<string, unknown>;
  w.__texCanvases = dumped;
  w.__texDumpOn = true;
}

export function texDumpEnabled(): boolean { return TEX_DUMP; }
