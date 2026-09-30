// === 接触硬化软阴影 (contact-hardening / PCSS 风格) — 太阳阴影滤波模型升级 ============
//
// 用户投诉(原话): "阴影不够明显, 而且软阴影有明显的分阶, 可能是没混合起来"。
// 已排除的两条路(见 DSH_HANDOFF §298 / DEVELOPMENT §304):
//   · CSM: 4 级级联 = 4 张 directionalShadowMap, 而地形材质已经 14/16 张采样器
//     ⇒ 17 > MAX_TEXTURE_IMAGE_UNITS(16) ⇒ 地表整片消失。**不能开**。
//   · 收小静态正交盒: ±4000 → ±1800(1.95 → 0.98 单位/纹素) 在同机位逐像素对比下
//     mad 仅 1.07(噪声底 0.81)、锐度指标几乎不变 ⇒ 那张图的"糊/分阶"不是纹素密度限的。
// ⇒ 剩下的只有**滤波模型**本身。
//
// three r185 的 PCFShadowMap 实现(`shadowmap_pars_fragment` 的 SHADOWMAP_TYPE_PCF 分支)是
//   radius = shadowRadius * texelSize.x;  // 引擎没设 shadow.radius ⇒ 默认 1 ⇒ 半径 1 纹素
//   5 个 Vogel 盘抽样(每个再吃一次硬件 2x2 PCF), 按 IGN 逐像素旋转
// ⇒ 半影总宽只有 ~3.8 纹素(实测 10%..90% = 7.35 世界单位 @ 1.953 单位/纹素),
//   而且**核宽是个常数**: 遮挡物贴着接收面时和离得很远时一样宽 —— 既没有接触硬化,
//   也把有限的几个量化档挤在很窄的一段里。
//
// 本模块做的事(零新增采样器 —— 硬约束: 地形 14/16、CloudsMaterial 15/16):
//   ① 改名保留原实现: 在 `#include <shadowmap_pars_fragment>` **之前**下
//      `#define getShadow _getShadowPCF_stock`, include 之后 `#undef getShadow`,
//      然后用**完全相同的签名**重新定义 `getShadow` ⇒ `shadowmask_pars_fragment` 与
//      `lights_fragment_begin` 里那 3 个调用点自动接到新实现(不需要改 three 的 chunk 正文,
//      也不需要 anchor 到 chunk 正文 —— onBeforeCompile 早于 resolveIncludes)。
//   ② **遮挡物深度只用现有那张 `sampler2DShadow` 反解**, 不加任何贴图/采样器:
//      比较采样 texture(sm, vec3(uv, zRef)) 在 zRef 越过遮挡物深度时会从 1 翻到 0,
//      于是对 zRef 做 **4 步二分**就能估出"接收面与遮挡物沿光轴的间距"。这只多花 4 次
//      比较采样, 换来真实的 PCSS 间距项。
//   ③ 半影核半径 = 间距(连续量) ⇒ **核宽逐像素连续变化 ⇒ 没有量化台阶**;
//      近处(间距→0)核收到 `uCHMinTexels`, 远处收到 `uCHSoftTexels`/上限。
//   ④ 滤波本身用 12 抽旋转 Vogel 盘(抽数比原来的 5 抽多, 且逐像素随机旋转 ⇒ 残余量化
//      被打散成高频噪声而不是同心阶梯)。
//
// 注入自检(照 project-shadow.ts 的教训): 锚点/`#define`/`#undef`/新函数定义逐条查,
// 缺了就 console.warn 并**放弃这个材质**(退回原 PCF), 绝不静默。
//
// ⚠ 这个文件的字符串**绝不能出现反引号之外的模板字面量陷阱**: GLSL 用数组 join('\n')
//   拼, 不写模板字符串里的 `${}`(会破坏 esbuild 单文件构建)。
import * as THREE from 'three';

/** 逐材质共享的一组 uniform(所有注入材质引用同一个对象 ⇒ 一改全改)。 */
export interface ShadowFilterUniforms {
  uCHOn: { value: number };
  /** 间距满量程时对应的半影核半径(纹素) */
  uCHSoftTexels: { value: number };
  /** 核半径下限(纹素): 保证"接触处"也不会硬到出现锯齿 */
  uCHMinTexels: { value: number };
  /** 核半径上限(纹素) */
  uCHMaxTexels: { value: number };
  /** 遮挡物搜索(blocker search)盘半径(纹素) */
  uCHSearch: { value: number };
  /** "接收面-遮挡物"沿光轴间距的满量程(**归一化阴影深度** = far-near 的几分之一) */
  uCHGapMax: { value: number };
  /** 滤波抽数(8..16; 超过 16 会明显吃帧时) */
  uCHTaps: { value: number };
  /** blocker search 抽数(4..8; 每抽内部还要 4 步二分) */
  uCHBlkTaps: { value: number };
  /** blocker 二分时给接收面加的深度偏置(归一化), 防自遮挡导致的间距虚大 */
  uCHBias: { value: number };
}

export const SHADOW_FILTER_DEFAULTS = {
  softTexels: 5.0,
  minTexels: 1.0,
  maxTexels: 5.0,
  search: 2.0,
  gapMaxWorld: 500,   // 世界单位: 间距超过它就按满量程(最软)
  taps: 12,
  blkTaps: 5,
  bias: 0.00015,
};

export function createShadowFilterUniforms(): ShadowFilterUniforms {
  return {
    uCHOn: { value: 1 },
    uCHSoftTexels: { value: SHADOW_FILTER_DEFAULTS.softTexels },
    uCHMinTexels: { value: SHADOW_FILTER_DEFAULTS.minTexels },
    uCHMaxTexels: { value: SHADOW_FILTER_DEFAULTS.maxTexels },
    uCHSearch: { value: SHADOW_FILTER_DEFAULTS.search },
    uCHGapMax: { value: 0.03 },
    uCHTaps: { value: SHADOW_FILTER_DEFAULTS.taps },
    uCHBlkTaps: { value: SHADOW_FILTER_DEFAULTS.blkTaps },
    uCHBias: { value: SHADOW_FILTER_DEFAULTS.bias },
  };
}

/** 开/关的默认值: 默认 **开**; `?pcss=0` 或 localStorage `skybound.pcss='off'` 可关(A/B 用)。 */
export function readShadowFilterEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const q = new URLSearchParams(window.location.search).get('pcss');
    if (q === '0' || q === 'off' || q === 'false') return false;
    if (q === '1' || q === 'on' || q === 'true') return true;
    return window.localStorage.getItem('skybound.pcss') !== 'off';
  } catch {
    return true;
  }
}

/** 注进 `#include <shadowmap_pars_fragment>` 之后的那段 GLSL(含新的 getShadow)。 */
export const SHADOW_FILTER_GLSL = [
  // ⚠ 两道保护(否则会**把一个本来能编译的材质编译坏**):
  //   · USE_SHADOWMAP 未定义时 chunk 整段是空的 ⇒ 原名函数不存在, 直接引用会编译失败;
  //   · 只有 PCF 分支才把 directionalShadowMap 声明成 sampler2DShadow(VSM/BASIC 是 sampler2D),
  //     签名对不上就会变成"重载不匹配" —— 那种情况下列表里这个 #if 直接关掉, 退回原实现。
  '#if defined( USE_SHADOWMAP ) && defined( SHADOWMAP_TYPE_PCF )',
  '// ===== 接触硬化软阴影注入 (零新增采样器) =====',
  'uniform float uCHOn;',
  'uniform float uCHSoftTexels;',
  'uniform float uCHMinTexels;',
  'uniform float uCHMaxTexels;',
  'uniform float uCHSearch;',
  'uniform float uCHGapMax;',
  'uniform float uCHTaps;',
  'uniform float uCHBlkTaps;',
  'uniform float uCHBias;',
  'float chIgn(vec2 p) {',
  '  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));',
  '}',
  'vec2 chVogel(int i, int n, float phi) {',
  '  const float ga = 2.399963229728653;',
  '  float fn = max(float(n), 1.0);',
  '  float r = sqrt((float(i) + 0.5) / fn);',
  '  float th = float(i) * ga + phi;',
  '  return vec2(cos(th), sin(th)) * r;',
  '}',
  '// 只用**硬件比较采样**反解"遮挡物深度":',
  '//   texture(sm, vec3(uv, zRef)) 在 zRef 越过该 texel 的遮挡物深度时从 1.0 翻到 0.0,',
  '//   所以对 zRef 二分 4 步就能估出间距(0 = 贴着接收面, 1 = 达到满量程)。',
  '//   好处: 不多声明任何 sampler(阴影图还是那一个 sampler2DShadow)。',
  'float chGapAt(sampler2DShadow sm, vec2 uv, float zRecv) {',
  '  float lo = 0.0;',
  '  float hi = 1.0;',
  '  for (int i = 0; i < 4; i++) {',
  '    float mid = 0.5 * (lo + hi);',
  '    float v = textureLod(sm, vec3(uv, zRecv - mid * uCHGapMax), 0.0);',
  '    if (v < 0.5) lo = mid; else hi = mid;',
  '  }',
  '  return 0.5 * (lo + hi);',
  '}',
  'float getShadow(sampler2DShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord) {',
  '  if (uCHOn < 0.5) {',
  '    return _getShadowPCF_stock(shadowMap, shadowMapSize, shadowIntensity, shadowBias, shadowRadius, shadowCoord);',
  '  }',
  '  vec4 sc = shadowCoord;',
  '  sc.xyz /= sc.w;',
  '  sc.z += shadowBias;',
  '  bool inFrustum = sc.x >= 0.0 && sc.x <= 1.0 && sc.y >= 0.0 && sc.y <= 1.0;',
  '  if (!(inFrustum && sc.z <= 1.0)) return 1.0;   // 出界一律判"亮"(fail-open, 与内置一致)',
  '  vec2 texel = vec2(1.0) / shadowMapSize;',
  '  float phi = chIgn(gl_FragCoord.xy) * 6.28318530718;',
  '  float zBase = sc.z - uCHBias;',
  '  // ---- ① blocker search: 小盘上平均"接收面-遮挡物沿光轴间距"(0..1 连续量) ----',
  '  float gapSum = 0.0;',
  '  float gapN = 0.0;',
  '  int bn = int(uCHBlkTaps + 0.5);',
  '  for (int i = 0; i < 8; i++) {',
  '    if (i >= bn) break;',
  '    vec2 o = chVogel(i, bn, phi) * (uCHSearch * texel);',
  '    gapSum += chGapAt(shadowMap, sc.xy + o, zBase);',
  '    gapN += 1.0;',
  '  }',
  '  float gap = gapN > 0.0 ? gapSum / gapN : 0.0;',
  '  // ---- ② 核半径随间距**连续**变化 ⇒ 没有量化台阶, 且近处硬/远处软 ----',
  '  float rT = clamp(gap * uCHSoftTexels, uCHMinTexels, uCHMaxTexels);',
  '  vec2 rad = texel * rT;',
  '  // ---- ③ 旋转 Vogel 盘滤波 ----',
  '  float s = 0.0;',
  '  float n = 0.0;',
  '  int tn = int(uCHTaps + 0.5);',
  '  for (int i = 0; i < 16; i++) {',
  '    if (i >= tn) break;',
  '    vec2 o = chVogel(i, tn, phi) * rad;',
  '    // textureLod(...,0.0) 而不是 texture(...): 循环里带 break 的动态边界下,',
  '    // `texture` 的隐式导数会触发 D3D 编译告警 X3595("gradient instruction used in a',
  '    // loop with varying iteration")并且结果不可预期; 阴影图没有 mip, LOD 恒为 0。',
  '    s += textureLod(shadowMap, vec3(sc.xy + o, sc.z), 0.0);',
  '    n += 1.0;',
  '  }',
  '  float sh = n > 0.0 ? s / n : 1.0;',
  '  return mix(1.0, sh, shadowIntensity);',
  '}',
  '#endif',
].join('\n');

const RENAME_BEFORE = '#define getShadow _getShadowPCF_stock\n#include <shadowmap_pars_fragment>\n#undef getShadow\n';

// === three 版本体检: 我们的"改名 + 重定义"依赖 chunk 的**确**定义了同名函数 ===
// 这一段在模块级对 `THREE.ShaderChunk.shadowmap_pars_fragment` 查一次(只查字符串,
// 跑一次缓存), 因为 onBeforeCompile 那一刻 chunk 正文还没被 resolveIncludes 替进来。
let _chunkOK: { ok: boolean; hasFn: boolean; hasShadowSampler: boolean; rev: string } | null = null;
export function chunkSanity(): { ok: boolean; hasFn: boolean; hasShadowSampler: boolean; rev: string } {
  if (_chunkOK) return _chunkOK;
  const src = (THREE.ShaderChunk as unknown as Record<string, string>).shadowmap_pars_fragment || '';
  const hasFn = src.indexOf('float getShadow( sampler2DShadow shadowMap') >= 0;
  const hasShadowSampler = src.indexOf('uniform sampler2DShadow directionalShadowMap') >= 0;
  _chunkOK = { ok: hasFn && hasShadowSampler, hasFn, hasShadowSampler, rev: String(THREE.REVISION) };
  if (!_chunkOK.ok) {
    // eslint-disable-next-line no-console
    console.warn('[contact-hardening] three 的 shadowmap_pars_fragment 结构变了(rev ' + THREE.REVISION
      + '), 接触硬化注入不可用 ⇒ 全部材质退回内置 PCF:', _chunkOK);
  }
  return _chunkOK;
}

/** 注入统计(自检/诊断用)。 */
export interface ShadowFilterStats {
  injected: number;
  injectedMats: string[];
  anchorMissing: number;
  warned: string[];
  enabled: boolean;
  gapMaxNorm: number;
  chunkOK?: { ok: boolean; hasFn: boolean; hasShadowSampler: boolean; rev: string };
}

/**
 * 把一个材质接上接触硬化滤波(幂等: 同一材质只注入一次)。
 * 返回 false 表示**没注入**(锚点缺失/材质类型不支持/custom shader), 调用方可以据此统计。
 */
export function injectShadowFilter(
  mat: THREE.Material,
  u: ShadowFilterUniforms,
  stats?: ShadowFilterStats,
): boolean {
  const flags = mat.userData as { _chInjected?: boolean; _chWarned?: boolean };
  if (flags._chInjected) {
    // 已经接上过(可能早就编译过了): 只更新 uniform 引用, 不再重复挂回调。
    if (stats) { stats.injected += 1; if (stats.injectedMats.length < 24) stats.injectedMats.push(mat.name || mat.type); }
    return true;
  }
  const anyMat = mat as unknown as { isMeshStandardMaterial?: boolean; isMeshPhysicalMaterial?: boolean; isMeshLambertMaterial?: boolean; isMeshPhongMaterial?: boolean; isMeshToonMaterial?: boolean; isShadowMaterial?: boolean };
  if (!(anyMat.isMeshStandardMaterial || anyMat.isMeshPhysicalMaterial || anyMat.isMeshLambertMaterial
    || anyMat.isMeshPhongMaterial || anyMat.isMeshToonMaterial)) {
    return false;   // 自定义 ShaderMaterial / ShadowMaterial / 深度材质: 不动
  }
  if (anyMat.isShadowMaterial) return false;
  flags._chInjected = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (typeof prev === 'function') prev.call(mat, shader, renderer);
    Object.assign(shader.uniforms, u);
    const fs: string = shader.fragmentShader;
    const hasChunk = fs.indexOf('#include <shadowmap_pars_fragment>') >= 0;
    const hasUse = fs.indexOf('USE_SHADOWMAP') >= 0 || fs.indexOf('#include <lights_fragment_begin>') >= 0;
    if (!hasChunk || !hasUse) {
      // 没有阴影 chunk 的材质(纯自发光/自定义) → 安静跳过, 不算失败
      delete (mat.userData as { _chInjected?: boolean })._chInjected;
      return;
    }
    const out = fs
      .replace('#include <shadowmap_pars_fragment>', RENAME_BEFORE + SHADOW_FILTER_GLSL);
    // === 注入自检(照 projected-shadow.ts 的教训: 注入失败是**静默**的) ===
    // ⚠ 这里**只能查 onBeforeCompile 那一刻源串里确实存在的东西**:
    //   改名是 `#define getShadow _getShadowPCF_stock` 在 include **之前**生效、由 GLSL
    //   预处理在 resolveIncludes **之后**完成的 —— 所以此刻源里**看不到**
    //   `float _getShadowPCF_stock(`(chunk 正文还没替进来)。早先在这里查它 ⇒ 自检永远
    //   为假 ⇒ 所有材质被误判为"注入失败"而退回原 PCF(实测: injected 0 / shadersWithInjection 0)。
    //   chunk 正文能不能被改名, 用 `chunkSanity()` 在**模块级**对 three 的 ShaderChunk 查一次。
    const okReplace = out !== fs
      && out.indexOf('#define getShadow _getShadowPCF_stock\n#include <shadowmap_pars_fragment>\n#undef getShadow') >= 0;
    const chunkOK = chunkSanity();
    const okFunc = out.indexOf('float getShadow(sampler2DShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord)') >= 0
      && out.indexOf('_getShadowPCF_stock(') >= 0
      && out.indexOf('chGapAt(') >= 0;
    const okUni = ['uCHOn', 'uCHSoftTexels', 'uCHMinTexels', 'uCHMaxTexels', 'uCHSearch', 'uCHGapMax', 'uCHTaps', 'uCHBlkTaps', 'uCHBias']
      .every((k) => out.indexOf('uniform float ' + k + ';') >= 0);
    const okGuard = out.indexOf('#if defined( USE_SHADOWMAP ) && defined( SHADOWMAP_TYPE_PCF )') >= 0
      && out.indexOf('\n#endif') >= 0;
    if (!okReplace || !okFunc || !okUni || !okGuard || !chunkOK.ok) {
      if (!flags._chWarned) {
        flags._chWarned = true;
        // eslint-disable-next-line no-console
        console.warn('[contact-hardening] GLSL 注入自检失败, 该材质退回原 PCF:', {
          name: mat.name || mat.type, okReplace, okFunc, okUni, okGuard, chunkOK,
        });
      }
      // 清掉幂等标志 ⇒ 以后(例如换了 three 版本/修好锚点后)还能再试, 但 _chWarned 抑制刷屏。
      delete flags._chInjected;
      if (stats) { stats.anchorMissing += 1; stats.warned.push(mat.name || mat.type); }
      return;
    }
    shader.fragmentShader = out;
  };
  mat.needsUpdate = true;
  if (stats) {
    stats.injected += 1;
    if (stats.injectedMats.length < 24) stats.injectedMats.push(mat.name || mat.type);
  }
  return true;
}

/** 遍历场景把所有受影材质接上滤波(节流调用即可)。 */
export function applyShadowFilterToScene(
  scene: THREE.Object3D,
  u: ShadowFilterUniforms,
): ShadowFilterStats {
  const stats: ShadowFilterStats = {
    injected: 0, injectedMats: [], anchorMissing: 0, warned: [],
    enabled: u.uCHOn.value > 0.5, gapMaxNorm: u.uCHGapMax.value, chunkOK: chunkSanity(),
  };
  const stack: THREE.Object3D[] = [scene];
  while (stack.length) {
    const o = stack.pop()!;
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh || (o as unknown as { isPoints?: boolean }).isPoints) {
      const m = mesh.material as unknown;
      const mats: unknown[] = Array.isArray(m) ? m : [m];
      for (const mm of mats) {
        const mat = mm as THREE.Material;
        if (!mat || typeof (mat as unknown as { isMaterial?: boolean }).isMaterial === 'undefined') continue;
        injectShadowFilter(mat, u, stats);
      }
    }
    for (let i = 0; i < o.children.length; i++) stack.push(o.children[i]);
  }
  return stats;
}
