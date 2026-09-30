// === §302 Phase F: 3D 覆盖率(把库的 2D 覆盖率场"升维"到 3D) =====================
//
// ⚠ **2026-09 改版: 判据从"列内相对(竖直切)"换成"高度包络(水平分层)"**
//    旧版用同一 (x,z) 的参考高度做差 ⇒ 逐列比较 ⇒ 竖幕墙 + 128³ 场的体素方块(现场实测)。
//    新版只随**高度**变化(env = 4·hn·(1−hn)), 不采 3D 场 ⇒ 幕墙与方块一起消失。
//    新增的地方是唯一权威 —— 下面 ① ② 的旧描述保留作为**历史记录**(它解释了"为什么
//    必须硬掩码"这条仍然有效的实测结论), 但"逐列/3D 噪声"那部分已不适用。
//    `uCover3DScale` / `uCover3DRefY` 现在**不再被掩码使用**(仍声明/仍写入, 便于回退对比);
//    掩码也不再采样 `shapeTexture` —— 原前置校验保留但已非必需(库始终声明它, 不会误拦)。
//    静态校验脚本: `bun/esbuild + node scripts/verify-cover3d.ts`(对库的真实 shader 文本
//    跑一遍注入, 断言 3 处调用点改写 + 新掩码就位 + uniform 不重复定义)。
//
// 用户原话: **"把覆盖率本身做成 3D, 我们可能需要体积纹理, 然后在完全做好之前保留退路"**。
//
// ---------------------------------------------------------------------------------
// ① 这个补丁改的是库的哪一段(精确到字符串)
// ---------------------------------------------------------------------------------
// 目标: `@takram/three-clouds` 的 **片元着色器**(`shaders/clouds.frag` 与 `shaders/shadow.frag`)。
// 这两份着色器在运行时就是**材质上的一个字符串**(`CloudsMaterial.fragmentShader` /
// `ShadowMaterial.fragmentShader`; 库是 `RawShaderMaterial` + 固定 fragment 字符串,
// `#include "clouds"` 已被 `resolveIncludes` 就地展开) ⇒ 直接改字符串最确定。
//
// 库的覆盖率算在哪(改动前后的原文):
//
//     // shaders/clouds.glsl —— WeatherSample 是"这一层在这一点的密度"
//     WeatherSample sampleWeather(const vec2 uv, const float height, const float mipLevel) {
//       ...
//       vec4 factor = 1.0 - coverage * heightScale;      // 覆盖率只吃 uv(XZ 球面映射) + 整层统一圆顶
//       weather.density = remapClamped(mix(localWeather, vec4(1.0), coverageFilterWidths), factor, factor + coverageFilterWidths);
//       return weather;
//     }
//
// **问题(前两轮已确诊)**: `uv` 来自 `getGlobeUv(position)` —— 它是**水平面的**映射;
// `heightScale` 是 `shapeAlteringFunction()` 给出的**整层统一**圆顶(不是逐朵)。
// ⇒ `weather.density` 在同一个 (x,z) 柱子上, 只要覆盖率一为 0, **整根柱子的所有高度都没有云**
// ⇒ 云边界 = 2D 覆盖率等值线**竖直挤出** ⇒ 用户看到的"幕墙 / 像 MC 方块 / 切糕"。
//
// ---------------------------------------------------------------------------------
// ② 补丁做了什么(复用现有 3D 纹理, **零新增采样器**)
// ---------------------------------------------------------------------------------
// 不新增任何纹理/采样器: 直接复用**已经挂在材质上**的 3D 纹理 `shapeTexture`
// (128³ 可平铺 Perlin-Worley, 库本来就在 `sampleMedia` 里用它做侵蚀), 只是**换一个尺度/相位**
// 在**世界空间**再采一次, 当作"**3D 覆盖率场**", 再与**本列(同一 x,z)在云带中高处的参考值**比较:
//
//     vec3  p  = position * shapeRepeat * uCover3DScale + vec3(0.37, 0.61, 0.19);   // 与侵蚀场错开相位
//     vec3  pr = vec3(p.x, (bottomRadius + uCover3DRefY) * shapeRepeat.y * uCover3DScale + 0.61, p.z);
//     float n  = textureLod(shapeTexture, p,  0.0).r;    // 这一点的 3D 场值
//     float nr = textureLod(shapeTexture, pr, 0.0).r;    // 同一 (x,z) 在云带中高处的值(参考)
//     float m  = smoothstep(-0.08, 0.08, (n - nr) - uCover3DBias);
//     weather.density *= mix(vec4(1.0), vec4(m), uCover3DK);      // 低于"自己那一列"的那段直接归零
//
// ⇒ 同一 (x,z) 柱子在不同**高度**上有/无云(UE 那套: 天气图给 2D 覆盖率, 3D 噪声决定
//   "这根柱子里哪一段有云"), 边界不再是 2D 等值线的竖直挤出。
//   **为什么是"硬掩码"、"列内相对"、以及前 4 版各差在哪**, 见 INJECT_HELPER 上面那段长注释
//   (那是本轮最有价值的实测结论: 绝对阈值是刀口, 列内相对才可携带)。
//
// 注入点(3 处, 都是"贴上去", 不动库的函数体):
//   ① **uniform 声明**: 插在 `parameters` 段 `uniform vec3 shapeOffset;` 之后;
//   ② **包装函数**: 插在 `vec4 getLayerDensity(const vec4 heightFraction) {` **之前**
//      (即 `sampleWeather()` 定义之后 —— GLSL 要求先声明后使用);
//   ③ **调用点改写**: `sampleWeather(uv, height, mipLevel)` → `sampleWeatherCover3D(uv, height, mipLevel, position)`
//      (**全部** 3 处: clouds.frag 的主步进 + 太阳光线步进, shadow.frag 的 BSM 步进;
//       三处作用域内都恰好有 `position` = 该步进点的 ECEF 位置)。
//      ⚠ 必须先做 ③ 再插 ② —— 包装函数体内用的就是那个**原始**调用文本, 顺序反了会自我递归。
//      ⚠ 云 pass 与 shadow pass 的 `position` 是**同一个空间**(都加过 `altitudeCorrection`)
//        ⇒ 两边采到同一个 3D 场 ⇒ 云影与云体一致(不会"有影无云")。
//
// 开关语义(见 `applyCover3D` / `skybound.cloudCover3D`):
//   · 注入本身是**恒等透传**(包装函数体被 `#ifdef COVER3D` 包着, define 不在时逐位等价于库原文);
//   · `COVER3D` 这个 **define** 才是"开/关" —— 关掉时 recompile 回恒等路径(不重新注入)。
//
// ---------------------------------------------------------------------------------
// ③ 怎么彻底移除
// ---------------------------------------------------------------------------------
// 删掉 `clouds-takram.ts` 里对 `patchCover3D()` / `applyCover3D()` 的调用(两处: 构造/patchLibraryShaders
// 里一次, 每帧 `render()` 里一次), 本文件即变成死代码, 可以整个删掉。
// **没有任何一行 node_modules 被改过** —— 补丁只活在"字符串常量 + 注入函数"里, 重装依赖不受影响。
// 运行时的中间档: `skybound.cloudCover3D=unpatched`(控制台 `vcloud cover3d unpatched`)会把
// 材质上的 `fragmentShader` **反向改回库原文**(与"从没注入过"等价), 用于取证/一键还原。
import * as THREE from 'three';

/**
 * 已经注入过的标记(出现它就不再注入)。
 * ⚠ 必须是一个**真的会出现在注入文本里**的字符串: 最初写成 `'sampleWeatherCover3D(const'`,
 *   而注入的签名是**多行**的(`sampleWeatherCover3D(` + 换行 + `  const vec2 uv,`) ⇒ 标记永远
 *   匹配不上 ⇒ 每次钩子都重新注入一遍 ⇒ `'uCover3DK' : redefinition` + 材质整块编译失败。
 *   (踩过一次, 记在这里 —— 这类"标记写错"的失败模式是**静默重复注入**, 不是"没效果"。)
 */
const MARK_HELPER = 'sampleWeatherCover3D';
/** 注入后的 3D 采样调用(反向还原时要改回 CALL_PLAIN) */
const CALL_3D = 'sampleWeatherCover3D(uv, height, mipLevel, position)';
/** 库原文的调用(锚点, 也是还原后的目标文本) */
const CALL_PLAIN = 'sampleWeather(uv, height, mipLevel)';
/** 锚点 ①: `parameters` 段 "Shape and weather" 的最后一行(在 `#include "clouds"` 之前) */
const ANCHOR_UNIFORMS = 'uniform vec3 shapeOffset;';
/** 锚点 ②: `sampleWeather()` 定义之后紧接着的那段函数 */
const ANCHOR_HELPER = 'vec4 getLayerDensity(const vec4 heightFraction) {';

/** 我们自己加的 uniform 名(值由 `applyCover3D` 每帧写) */
export const COVER3D_UNIFORMS = ['uCover3DK', 'uCover3DScale', 'uCover3DBias', 'uCover3DRefY'] as const;

/** 注入的 uniform 声明(跟锚点 ① 一起走) */
const INJECT_UNIFORMS = [
  '',
  '// === §302 cover3d: 本补丁自己的 uniform(不是库的; 值由 TakramCloudsPass 每帧写) ===',
  '// uCover3DK: 0 = 恒等(逐位回到原行为), 1 = 3D 覆盖率全量生效',
  '// uCover3DScale: 3D 覆盖率场的频率倍率(乘以库的 shapeRepeat)',
  '// uCover3DBias: 阈值偏移(>0 = 挖得更狠, <0 = 更保守)',
  '// uCover3DRefY: 参考高度(米, 云带中高) —— 见下面"为什么是列内相对"',
  'uniform float uCover3DK;',
  'uniform float uCover3DScale;',
  'uniform float uCover3DBias;',
  'uniform float uCover3DRefY;',
].join('\n');

/**
 * 注入的包装函数(跟锚点 ② 一起走; 注意: **不要**在这里写反引号, 见 clouds-takram 头的构建坑)
 *
 * === 为什么必须是"硬掩码"而不是"变薄"(实测三版) ==============================
 * 本项目这层云是**光学厚**的(实测云缓冲 alpha 均值 0.51 俯视 / 0.83 仰视,
 * `saturate(density × densityScale × 廓线)` 在可见高度上早就顶到 1):
 *   ① 乘法软掩码 `density *= smoothstep(...)`: 1.0 变 0.3 还是"厚" ⇒ 屏幕上几乎不变
 *      (整帧 mad 1.27/255, 只有 1.7% 像素变化 >8)。
 *   ② 减法(覆盖率阈值 3D 平移): 竖直方差 +34%, 但主要削薄内部 ⇒ 可见边界没跨过"不透"阈值,
 *      整帧 mad 仍旧 1~2/255, 肉眼看不出洞。
 * ⇒ 必须是**硬掩码**(低的那部分体积真的归零)。它跨过 `minDensity` 早退与不透明度阈值
 *   ⇒ 出现真空洞 ⇒ 同一 (x,z) 柱子在**不同高度**上有/无云, 底面/顶面不再是平板。
 *
 * === 为什么是"列内相对"而不是绝对阈值(实测第 4 版) =============================
 * 绝对阈值 `smoothstep(T-0.18, T, n)` 实测是**刀口**: `shapeTexture.r` 的取值高度集中在
 * 0.7~0.95(T=0.55 完全没变化, T=0.70 只降 0.7% 不透明度, T=0.90 却把整片云打碎成几缕)。
 * 而且这个分布随采样尺度/相位漂移 ⇒ 绝对阈值不可携带(改 scale 就得重新标定)。
 * 改成**列内相对**: 同一 (x,z) 取竖直方向的一个参考高度 yref(云带中高)的同一个场值作基准,
 *     d = n(x,y,z) − n(x,yref,z)   (零均值、自标定: 与该点的绝对取值分布无关)
 *     mask = smoothstep(−w, +w, d − bias)   (w 固定 0.08)
 * ⇒ 保留"这根柱子里比自己中高更实的那一段", 砍掉更虚的那一段 —— 这正是"覆盖率升维到 3D"的语义,
 *   而且**天然砍掉约 50% 体积**(不需要标定绝对阈值), 效果对纹理分布不敏感。
 */
const INJECT_HELPER = [
  '// === §302 cover3d: 3D 覆盖率调制(包在库的 sampleWeather 外面, 不改库的函数体) ========',
  '// 库的覆盖率是 2D (XZ) 场(uv 来自 getGlobeUv, 竖直方向只有"整层统一"的圆顶), 于是同一',
  '// (x,z) 柱子在**所有高度**上一齐有/没有云 => 边界 = 2D 等值线竖直挤出("幕墙/切糕")。',
  '// 这里用**同一张 3D shapeTexture**(零新增采样器)在**世界空间**换尺度/相位再采一次, 当成',
  '// "3D 覆盖率场": 与**本列中高**的参考值比较, 低于自己的那一段直接归零 =>',
  '// 同一根柱子在**不同高度**上有/无云(见 clouds-cover3d.ts 头: 为什么是硬掩码 + 列内相对)。',
  '// COVER3D 未定义时本函数是恒等透传(inline 后与库原文逐位一致)。',
  'WeatherSample sampleWeatherCover3D(',
  '  const vec2 uv,',
  '  const float height,',
  '  const float mipLevel,',
  '  const vec3 position',
  ') {',
  '  WeatherSample weather = sampleWeather(uv, height, mipLevel);',
  '#ifdef COVER3D',
  '  {',
  '    // === 水平分层: 判据只随**高度**变化(替换原来的"列内相对"竖直切法) ===',
  '    // 旧版: 用同一 (x,z) 的参考高度做差 (n − nr) ⇒ **逐列**比较 ⇒ 同一列的上下边界是',
  '    //        同一条竖直等值线 ⇒ "幕墙/切糕"; 且要采 128³ 的 shapeTexture 当 3D 覆盖率场,',
  '    //        一个 tile 被 uCover3DScale 拉到大尺度后体素 ≈ 数百米 ⇒ 屏幕上的"MC 方块"。',
  '    // 新版: 高度包络 env = 4·hn·(1−hn) (hn = 层内归一化高度) —— 与水平位置**无关**:',
  '    //        · 不再采 3D 场 ⇒ 体素方块消失;',
  '    //        · 同一列在不同高度上"够不够到阈值"不同(每列的 2D 覆盖率不同) ⇒',
  '    //          上下边界不再是竖线 ⇒ 这就是"水平分层"。',
  '    // 阈值语义沿用 uCover3DBias(>0 = 挖得更狠); 过渡带半宽 0.08 = 实测值(接近二值但不出',
  '    // 锯齿)。光学厚云的实测结论: 软乘系数无效(1.0→0.3 还是"厚") ⇒ 必须是硬掩码。',
  '    float cover3dLayerH = max(1.0, maxHeight - minHeight);',
  '    float cover3dHn = clamp((length(position) - bottomRadius - minHeight) / cover3dLayerH, 0.0, 1.0);',
  '    float cover3dEnv = 4.0 * cover3dHn * (1.0 - cover3dHn);',
  '    float cover3dM = smoothstep(uCover3DBias - 0.08, uCover3DBias + 0.08, cover3dEnv - 0.5);',
  '    // uCover3DK = 0 => 掩码恒 1(逐位回到原行为, 见 clouds-takram 的 A/B 证据)',
  '    weather.density *= mix(vec4(1.0), vec4(cover3dM), clamp(uCover3DK, 0.0, 1.0));',
  '  }',
  '#endif // COVER3D',
  '  return weather;',
  '}',
  '',
].join('\n');

/** 3D 覆盖率的现场参数(每帧从 localStorage 读, 见 clouds-takram.ts 的 applyCover3D) */
export interface Cover3DParams {
  /** 'on' = 生效; 'off' = 注入但恒等(默认); 'unpatched' = 连注入都撤掉 */
  mode: 'on' | 'off' | 'unpatched';
  /** 强度 0..1(mask 的 lerp 系数; 0 = 恒等) */
  k: number;
  /** 频率倍率(× 库的 shapeRepeat) */
  scale: number;
  /** 阈值偏移 */
  bias: number;
  /** 参考高度(米; 云带中高) —— 由 pass 从当前层配置算出来, 不是用户旋钮 */
  refY: number;
}

/**
 * 默认参数(与 clouds-takram.ts / engine.ts 的 `readTuning` 默认值**必须一致**)
 *
 * `mode: 'on'` —— §302 的实测结论(详见 clouds-takram 的 A/B 表): 3D 覆盖率把
 * **仰视云底边界起伏** 73→90~98px、**云带底边 std** 3.5→9.5~11.9px(×3)、
 * 仰视"每千云像素局部极大" 7.2→10.6、俯视云带边界 std 101→108~112px,
 * 而云量(面积 0.694 / 峰值亮度)只 −2~4%、帧时间无回归、斑点仅仰视 +12%。
 * 一键回退: `vcloud cover3d off`(恒等) / `off` → `unpatched`(连注入都撤掉)。
 */
export const DEFAULT_COVER3D: Cover3DParams = {
  // === §330: 运行时默认改成 off(与滑条面板/描述表里的 def:false 对齐) ===
  // 为什么改: ①面板一直显示 OFF 而运行时是 ON —— 又是一处"键值 vs 运行时"不一致(§322 同类坑);
  //   ②实测 +1.7ms(§308/§328), 在 1912x956 的机器上是固定开销里可省的一块;
  //   ③它同时是"云层垂直分块"的嫌疑之一(低频大块掩膜)。
  // 想要它的收益(仰视云底起伏 ×~1.2、底边 std ×3)随时  —— 注入一直在, 只是不再默认启用。
  mode: 'off',
  k: 1,
  scale: 1.2,
  bias: 0,
  refY: 8200,
};

/** 一个材质的注入结果(自检用; 缺任何一项都算失败) */
export interface Cover3DPatchResult {
  /** 材质名(库的材质名, 便于对照控制台/探针读数) */
  name: string;
  /** 本次调用是否真的改了字符串 */
  changed: boolean;
  /** 之前就已经是注入态 */
  already: boolean;
  /** 是否成功(全部锚点命中 + uniform 齐全) */
  ok: boolean;
  /** 材质**不存在**(库没建这个 pass) —— 不是"注入失败", 不该告警 */
  absent?: boolean;
  /** 失败原因(ok=false 时给出来, 便于 console.warn) */
  reason?: string;
  anchors: {
    /** ① uniform 声明锚点 */
    uniforms: boolean;
    /** ② 包装函数锚点 */
    helper: boolean;
    /** ③ 调用点命中数(clouds.frag 应为 2, shadow.frag 应为 1) */
    callSites: number;
    /** 库原文里真的有 sampler3D shapeTexture 吗(= 我们复用的那张) */
    shapeTexture: boolean;
  };
  /** 材质上的 COVER3D define 当前值 */
  define: boolean;
}

interface WritableMaterial {
  name?: string;
  uuid?: string;
  fragmentShader?: string;
  uniforms?: Record<string, unknown>;
  defines?: Record<string, unknown>;
  needsUpdate?: boolean;
}

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * 给一个库的云材质注入 3D 覆盖率调制(幂等)。
 *
 * ⚠ 顺序是**关键**: 先改调用点(③), 再插包装函数(②) —— 包装函数体里用的就是原始调用文本,
 *   顺序反了 `replaceAll` 会把包装函数体自己改写掉 ⇒ 无限递归。
 * ⚠ 三处锚点任一找不到 ⇒ **整体放弃**(不写任何一段), 并返回 `ok:false` + 原因:
 *   宁可"没效果", 也绝不能留下半截补丁把材质搞坏(历史上硬塞导致过整块材质编译失败)。
 * ⚠ `uniforms` 必须能被写: 我们在着色器里声明了 3 个 uniform, 而 three 的
 *   `WebGLUniforms.upload()` 是 `values[u.id].value` —— 声明了却不在材质 `uniforms` 里
 *   会在 draw 时抛 TypeError。所以两条要么一起成立, 要么都不做。
 */
export function patchCover3D(mat: THREE.Material | null | undefined): Cover3DPatchResult {
  const m = mat as unknown as WritableMaterial | null | undefined;
  const res: Cover3DPatchResult = {
    name: m?.name ?? '(unnamed)',
    changed: false,
    already: false,
    ok: false,
    anchors: { uniforms: false, helper: false, callSites: 0, shapeTexture: false },
    define: false,
  };
  try {
    const src = m?.fragmentShader;
    if (!m || typeof src !== 'string' || src.length === 0) {
      res.absent = !m;
      res.reason = m ? '材质没有 fragmentShader(不是库的云/阴影材质?)' : '材质不存在(库没建这个 pass)';
      return res;
    }
    res.anchors.shapeTexture = /\buniform\s+sampler3D\s+shapeTexture\s*;/.test(src);
    res.define = isCover3DDefined(mat);
    if (src.includes(MARK_HELPER)) {
      res.already = true;
      res.anchors.helper = true;
      res.anchors.uniforms = src.includes('uCover3DK');
      res.anchors.callSites = countOccurrences(src, CALL_3D);
      res.ok = res.anchors.uniforms && res.anchors.callSites > 0;
      if (!res.ok) {
        res.reason = `已存在注入标记但状态不完整(uniform=${res.anchors.uniforms} 调用点=${res.anchors.callSites})`
          + ' —— 先切 unpatched 再切回 on';
      }
      return res;
    }
    // --- 锚点自检(缺一不可) ---
    res.anchors.uniforms = src.includes(ANCHOR_UNIFORMS);
    res.anchors.helper = src.includes(ANCHOR_HELPER);
    res.anchors.callSites = countOccurrences(src, CALL_PLAIN);
    if (!res.anchors.shapeTexture) {
      res.reason = '着色器里没有 `uniform sampler3D shapeTexture;`(我们复用的那张 3D 纹理不在)';
      return res;
    }
    if (!res.anchors.uniforms) {
      res.reason = `uniform 声明锚点没命中: ${ANCHOR_UNIFORMS}`;
      return res;
    }
    if (!res.anchors.helper) {
      res.reason = `包装函数锚点没命中: ${ANCHOR_HELPER}`;
      return res;
    }
    if (res.anchors.callSites < 1) {
      res.reason = `调用点锚点没命中(应为 1~2 处): ${CALL_PLAIN}`;
      return res;
    }
    if (!m.uniforms || typeof m.uniforms !== 'object') {
      res.reason = '材质没有 uniforms 容器(声明了 uniform 也写不进去 ⇒ 会在 draw 时抛错)';
      return res;
    }
    // --- ③ 先改调用点 ---
    let next = src.split(CALL_PLAIN).join(CALL_3D);
    // --- ② 再插包装函数 ---
    next = next.replace(ANCHOR_HELPER, `${INJECT_HELPER}${ANCHOR_HELPER}`);
    // --- ① 最后插 uniform 声明 ---
    next = next.replace(ANCHOR_UNIFORMS, `${ANCHOR_UNIFORMS}${INJECT_UNIFORMS}`);
    // --- uniform 值(声明与写入必须同时成立) ---
    for (const name of COVER3D_UNIFORMS) {
      if (!m.uniforms[name]) m.uniforms[name] = new THREE.Uniform(0);
    }
    const u = m.uniforms as Record<string, THREE.Uniform<number>>;
    if (u.uCover3DScale.value === 0) u.uCover3DScale.value = DEFAULT_COVER3D.scale;
    m.fragmentShader = next;
    m.needsUpdate = true;
    res.changed = true;
    res.ok = true;
    return res;
  } catch (err) {
    res.reason = `注入抛错: ${String(err)}`;
    return res;
  }
}

/**
 * 反向还原: 把 `fragmentShader` 改回**库原文**(= 与"从没注入过"等价)。
 * 只做我们那三段的**逆操作**, 不碰库/clouds-takram 的其它注入(depth 片段等)。
 * 用于 `skybound.cloudCover3D=unpatched`(取证 / 一键还原)。
 */
export function unpatchCover3D(mat: THREE.Material | null | undefined): boolean {
  const m = mat as unknown as WritableMaterial | null | undefined;
  try {
    const src = m?.fragmentShader;
    if (!m || typeof src !== 'string') return false;
    if (!src.includes(MARK_HELPER)) return false;
    if (m.defines) delete m.defines.COVER3D;
    // 逆操作顺序 = 正向的倒序: 先摘包装函数(它体内是**原始**调用文本, 必须先摘),
    // 再摘 uniform 声明, 最后把 3D 调用改回库原文。
    let next = src.replace(`${INJECT_HELPER}`, '');
    next = next.replace(`${INJECT_UNIFORMS}`, '');
    next = next.split(CALL_3D).join(CALL_PLAIN);
    m.fragmentShader = next;
    m.needsUpdate = true;
    return true;
  } catch {
    return false;
  }
}

/** 材质上的 COVER3D define 是否开着 */
export function setCover3DDefine(mat: THREE.Material | null | undefined, on: boolean): boolean {
  const m = mat as unknown as WritableMaterial | null | undefined;
  if (!m?.defines) return false;
  const has = m.defines.COVER3D !== undefined;
  if (on && !has) {
    m.defines.COVER3D = '1';
    m.needsUpdate = true;
    return true;
  }
  if (!on && has) {
    delete m.defines.COVER3D;
    m.needsUpdate = true;
    return true;
  }
  return false;
}

/** 每帧写 3 个 uniform(只写变化的值; 都是标量 ⇒ 不会触发重编译) */
export function setCover3DUniforms(mat: THREE.Material | null | undefined, p: Cover3DParams): void {
  const m = mat as unknown as WritableMaterial | null | undefined;
  const u = m?.uniforms as Record<string, THREE.Uniform<number>> | undefined;
  if (!u) return;
  const k = u.uCover3DK;
  if (k && typeof k.value === 'number' && Math.abs(k.value - p.k) > 1e-6) k.value = p.k;
  const s = u.uCover3DScale;
  if (s && typeof s.value === 'number' && Math.abs(s.value - p.scale) > 1e-6) s.value = p.scale;
  const b = u.uCover3DBias;
  if (b && typeof b.value === 'number' && Math.abs(b.value - p.bias) > 1e-6) b.value = p.bias;
  const r = u.uCover3DRefY;
  if (r && typeof r.value === 'number' && Math.abs(r.value - p.refY) > 1) r.value = p.refY;
}

/** 材质是否处于"已注入"状态(探针读数用) */
export function isCover3DPatched(mat: THREE.Material | null | undefined): boolean {
  const src = (mat as unknown as WritableMaterial | null | undefined)?.fragmentShader;
  return typeof src === 'string' && src.includes(MARK_HELPER);
}

/** 材质上的 COVER3D define 是否开着 */
export function isCover3DDefined(mat: THREE.Material | null | undefined): boolean {
  const d = (mat as unknown as WritableMaterial | null | undefined)?.defines;
  return !!d && d.COVER3D !== undefined;
}

/**
 * GL 侧自检: 库的云材质真的**链接成功**了吗? 我们那 3 个 uniform 进去了吗? 采样器涨了吗?
 *
 * ⚠ 方法论坑(被它骗过一次): **编译失败时 `ACTIVE_UNIFORMS` 会返回 0**, 于是采样器统计会
 *   伪装成"很少/正常"。所以顺序**必须**是先 `gl.validateProgram()` 再读 `VALIDATE_STATUS`,
 *   并且同时看 `gl.getError()`(见 DSH_HANDOFF §300 / CSM 那次)。
 */
export interface Cover3DGlCheck {
  name: string;
  hasProgram: boolean;
  validate: boolean | null;
  /** ACTIVE_UNIFORMS(编译失败时会假性为 0) */
  activeUniforms: number;
  samplers: number;
  samplerNames: string[];
  /** 我们那 3 个 uniform 是否都在 program 里(有 COVER3D 时应该有) */
  cover3dUniforms: string[];
  glError: number;
  validateLog: string;
}

export function checkCover3DProgram(
  renderer: THREE.WebGLRenderer,
  mat: THREE.Material | null | undefined,
): Cover3DGlCheck {
  const out: Cover3DGlCheck = {
    name: (mat as unknown as WritableMaterial | null | undefined)?.name ?? '(none)',
    hasProgram: false,
    validate: null,
    activeUniforms: 0,
    samplers: 0,
    samplerNames: [],
    cover3dUniforms: [],
    glError: 0,
    validateLog: '',
  };
  if (!renderer || !mat) return out;
  try {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const props = renderer.properties as unknown as {
      get: (o: unknown) => { currentProgram?: { program?: WebGLProgram; getUniforms: () => { map: Record<string, { type: number; size: number }> } } };
    };
    const prog = props.get(mat).currentProgram;
    if (!prog?.program) return out;
    out.hasProgram = true;
    // ⚠ 必须先 validate 再看 ACTIVE_UNIFORMS(否则编译失败会伪装成"正常")
    gl.validateProgram(prog.program);
    out.validate = gl.getProgramParameter(prog.program, gl.VALIDATE_STATUS) as boolean;
    out.activeUniforms = (gl.getProgramParameter(prog.program, gl.ACTIVE_UNIFORMS) as number) || 0;
    out.glError = gl.getError();
    if (!out.validate) {
      try { out.validateLog = (gl.getProgramInfoLog(prog.program) || '').slice(0, 400); } catch { /* ignore */ }
    }
    const SAMPLERS = new Set<number>([
      gl.SAMPLER_2D, gl.SAMPLER_3D, gl.SAMPLER_CUBE, gl.SAMPLER_2D_SHADOW,
      gl.SAMPLER_2D_ARRAY, gl.SAMPLER_2D_ARRAY_SHADOW, gl.SAMPLER_CUBE_SHADOW,
    ].filter((v) => typeof v === 'number'));
    const map = prog.getUniforms().map;
    for (const key of Object.keys(map)) {
      const e = map[key];
      if (!e) continue;
      if (SAMPLERS.has(e.type) && (e.size ?? 1) > 0) {
        out.samplers++;
        out.samplerNames.push(key);
      }
      if ((COVER3D_UNIFORMS as readonly string[]).includes(key)) out.cover3dUniforms.push(key);
    }
    out.glError = gl.getError();
    return out;
  } catch {
    return out;
  }
}
