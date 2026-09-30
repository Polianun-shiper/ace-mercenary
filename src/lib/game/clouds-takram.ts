// === @takram/three-clouds 适配层 (per user request: 引入 three-clouds 替换旧的体积云) ====
//
// 为什么需要这一层: 库的 `CloudsEffect` 继承的是 **postprocessing** 那个库的 `Effect`,
// 而本项目的 9 段后处理链全部建立在 `three/examples/jsm/postprocessing` 上, 两者不能混用
// (混用要么双 composer, 要么整链迁移 —— 都会动到已经调好的自阴影/高度雾/调色)。
//
// 但库把关键接口留得很干净, 所以**不需要**迁移:
//   · `CloudsEffect.update(renderer, inputBuffer: WebGLRenderTarget, deltaTime?)`
//     —— 入参是 **three 自己的** WebGLRenderTarget(不是 postprocessing 的 buffer 包装),
//        3 个参数, 不要求 outputBuffer。
//   · 算完把云图挂到 `effect.uniforms.cloudsBuffer.value` (= cloudsPass.outputBuffer)。
//   · 合成公式库自己给了一行(shared.js 里的 mainImage):
//        outputColor.rgb = inputColor.rgb * (1.0 - clouds.a) + clouds.rgb;
//     我们在自己的 pass 里照抄即可, 于是**合成时机完全由我们掌控**(能插在高度雾/大气透视之前或之后)。
//   · `setDepthTexture(texture, depthPacking=0)`: 深度用 three 的**标准非线性深度**,
//     片元里 `perspectiveDepthToViewZ(depth, cameraNear, cameraFar)` 自己线性化
//     ⇒ 正好吃 composer 上挂的 DepthTexture(engine.ts attachComposerDepth)。
//
// 于是这一层就是: 一个 three 的 `Pass`, 内部驱动 CloudsEffect, 自己合成。
// `postprocessing` 只作为 `Effect` 基类被 import(不进链、不建 composer)。
//
// === 噪声零资产 (关键) ====
// shape / shapeDetail 是 `Procedural3DTextureBase`(3D), localWeather / turbulence 是
// `ProceduralTextureBase`(2D), 都是**无参 new 就能用**的类, 片元着色器烤在库里。
// 而 `update()` 内部会自己 `proceduralXxx?.render(...)`。
// ⇒ **不需要下载任何贴图**, 单文件/离线部署照样有体积云(比原计划"只放 assets/ 否则回退 billboard"更好)。
// 唯一例外是 STBN(时域上采样的时空蓝噪声): 它是 `Data3DTexture`, 库里没有程序化版本。
// **Phase B 已把它程序化生成掉**(`clouds-stbn.ts`, void-and-cluster 64×64×64, 零资产),
// 所以时域上采样可以开了(现场 `vcloud tup on|off` / `skybound.cloudTemporal`)。
//
// === Phase D: 风归零(静止云) ====
// 用户要"云静止不流动" ⇒ 三个速度场(天气图/形状/细节)默认**归零**, 由 `skybound.cloudWind`
// 缩放(**默认 0 = 完全静止**, 1 = 参考风速, 见下方 Phase D 段的完整说明)。
// 顺带把时域 resolve 的方差裁剪收紧(`skybound.cloudTVarGamma` 默认 1, 库 2 —— 实测更紧更稳)。
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import {
  CloudsEffect,
  CloudShape,
  CloudShapeDetail,
  LocalWeather,
  Turbulence,
  type CloudsQualityPreset,
} from '@takram/three-clouds';
import { AtmosphereParameters } from '@takram/three-atmosphere';
// 深度工具 GLSL 片段(readDepthValue / reverseLogDepth / linearizeDepth)。
// **必须自己注入**, 见 injectDepthChunk 的说明。
import { depth as chunkDepth } from '@takram/three-geospatial/shaders';
// 云光照对接(Phase B): 把我们 Phase A 的透过率 LUT + 自烘的天空辐照度 LUT 喂给库。
// 见 attachAtmosphere 的长注释(这是"路 A": 按库期望的格式与尺寸喂兼容 LUT)。
import { IrradianceLut } from './atmosphere/lut-irradiance';
import type { AtmosphereSystem } from './atmosphere/sky-render';
// 程序化 STBN(时域上采样用) —— 静态 import 会被打进主包; 这里其实很小(几百字节),
// 所以直接静态引, 免得在 render() 的热路径里做动态 import。
import { createSTBN } from './clouds-stbn';
// 现场旋钮统一读取(键不存在 ⇒ 用默认值, 不会把默认值静默改成 0 —— 见 tuning.ts 头)。
import { readTuning } from './tuning';
// === §302 Phase F: 3D 覆盖率(把库的 2D 覆盖率场升维到 3D) ===========================
// 改的是**库的片元着色器字符串**(clouds.frag / shadow.frag), 复用已有的 sampler3D
// `shapeTexture`, **零新增采样器**。全部实现(含"库的哪一段 / 怎么彻底移除")见该文件头。
import {
  DEFAULT_COVER3D,
  checkCover3DProgram,
  isCover3DDefined,
  isCover3DPatched,
  patchCover3D,
  setCover3DDefine,
  setCover3DUniforms,
  unpatchCover3D,
  type Cover3DGlCheck,
  type Cover3DParams,
  type Cover3DPatchResult,
} from './clouds-cover3d';

/** 只为让 setTemporalUpscale 读起来清楚(生成函数就是 createSTBN) */
function requireSTBN(): { createSTBN: typeof createSTBN } {
  return { createSTBN };
}

// === Phase D: 风归零(静止云) + 时域滤波调保守 ========================================
//
// 用户原话: **"我的体积云一般不需要流动, 就静止在那里"** ⇒ 风默认归零 + 顺带小幅降噪。
//
// --- ① 库的机制(README + CloudsEffect.updateSharedUniforms) -------------------------
// 库**每帧**按 dt 推进三个噪声偏移(源码里就是三行 `offset.add(velocity.multiplyScalar(dt))`):
//     localWeatherOffset  += localWeatherVelocity  × dt   (Vector2, 天气图/覆盖率)
//     shapeOffset         += shapeVelocity         × dt   (Vector3, 云的基础形状)
//     shapeDetailOffset   += shapeDetailVelocity   × dt   (Vector3, 细节侵蚀)
// **没有第四个速度场**(本版本的 turbulence 只有 `turbulenceRepeat`, 没有 offset/velocity;
// 世界摆放用 worldToECEFMatrix 平移, 也不是速度)。
//
// --- ② 一个必须先说清的事实: 本项目**本来就是静止的** -------------------------------
// 库的这三个速度场默认值全是零向量(`new Vector2()` / `new Vector3()`, README 对
// `localWeatherVelocity` 的原文是 "A non-zero value animates the clouds"), 而本项目
// **从未写过它们**(engine.ts 里只喂 dt / 增益 / 光柱, 没有速度)。所以本构建的云在
// 默认配置下**逐帧完全不动** —— "风归零"在当前代码上是个**语义化 + 可对比化**的动作:
// 把这个隐含的 0 变成显式的旋钮, 并给出一个"有风"的参照值, 让 A/B 有意义。
//
// --- ③ 静止对噪点的影响(以及它治不了什么) -----------------------------------------
// 静止 ⇒ 这三项不再推进 ⇒ 云在世界空间逐帧不变 ⇒ 时域重投影的历史采样永远是对的,
// 累积能真正收敛 ⇒ "云自身在游移/沸腾"那一类时域噪点消失。
// **但治不了**:
//   · 空间颗粒(步进不足 + 抖动图案) —— 那是低分辨率步进的固有噪声, 只能靠时域累积/步数;
//   · 时域累积路径本身的抖动 —— Phase B 实测: **dt=0 时云带仍有 ~1.13/255 帧间抖动**,
//     而 dt=0 意味着 `速度 × dt ≡ 0`(风项本就为零) ⇒ 这部分**不来自云的运动**,
//     而是 STBN / bayer 按帧号抖动 + resolve 的方差裁剪(见 ⑤)。风归零消不掉这个底噪。
//
// --- ④ "原速"参照值从哪来 ------------------------------------------------------------
// 既然库/项目的原速 = 0, 这里显式定义一组**参考风速**: 同一阵风 **10 m/s**(方向
// (1, 0.4) 归一化)映射到三个纹理空间(换算 = 该纹理的 repeat 的倒数, 即"每米多少 UV"):
//   · 天气图: README 明确 "an offset of 0.5 shifts it by half the tile size",
//     一个 tile ≈ 100km ⇒ 1e-5 /m ⇒ 10 m/s ≈ 1.0e-4 /s;
//   · shape: 库默认 shapeRepeat = 3e-4 /m ⇒ 10 m/s ≈ 3.0e-3 /s;
//   · shapeDetail: 库默认 shapeDetailRepeat = 6e-3 /m ⇒ 10 m/s ≈ 6.0e-2 /s。
// `skybound.cloudWind` 线性缩放它: **0 = 完全静止(默认)**, 1 = 上述参考风速。
// 三个速度场维度不同(Vector2 / Vector3 / Vector3), 但乘的是同一个系数 kv。
// ⚠ 本文件的写入是**权威**的: 每帧 render() 开头都会覆盖这三个速度场 —— 若别处
//   (engine / 调试命令)也写它们, 最终以 `skybound.cloudWind` 为准。
//
// --- ⑤ 顺带的小幅降噪杠杆(实测选型, 不花性能) ---------------------------------------
// 选了**resolve 的方差裁剪阈值**(而不是加步数/加分辨率): 打开时域上采样后, resolve 每帧
// 只用 bayer 选中的 1/16 像素做"新采样", 其余 15/16 走**方差裁剪**后的历史
// (`varianceClipping`; 阈值 = 邻域标准差 × `varianceGamma`, 库默认 2)。
//
// 实测(Phase D 探针 `scripts/_cloudwind-ab.mjs`: 冻结相机 + 静止世界, 风 0, N=10 次
// 截图在云蒙版上的相邻帧平均差, 同一会话内单调, 单位 /255):
//     gamma 8 → 14.53 | 6 → 14.45 | 3 → 12.87 | 2(库默认) → 11.23 | 1.5 → 9.86 | **1 → 8.59**
// ⇒ **gamma 越小越稳**(裁剪更紧 ⇒ 每帧那 1/16 的新噪声样本被拉向邻域均值, 不会停留十几帧),
//   与"调大=更保守"的直觉相反 —— 库自己的注释也承认调大是拿 ghosting 换稳定
//   ("This increases ghosting, of course")。**默认取 1**(= Salvi 那篇 temporal
//   supersampling 的标准取值, 也是"少 ghost"的一侧), 比库默认 2 少 **~24%** 帧间噪点。
// 旋钮(都可现场改, 每帧读, 无需重建):
//   `skybound.cloudTVarGamma` 默认 **1**(库 2; 区间 0.25..8) —— 主杠杆, 越小越稳
//   `skybound.cloudTAlpha`    默认 **0.05**(库 0.1; 区间 0.01..0.5) —— **只在时域上采样
//     被关掉时**才生效(它用在 temporalAntialiasing 分支: `mix(历史, 当前, alpha)`; 开着
//     上采样时走 temporalUpscale, 那条路径里没有 alpha)。默认值不改变开着的路径。
//   `skybound.cloudResScale`  **默认不设**(区间 0.25..1) —— 内部分辨率, **唯一会真的加开销**
//     的杠杆(像素数 ∝ scale²), 只作备用。注意不设时的**实际生效值是 1**: 构造传的 0.5 会被
//     `setQuality('medium')` 的预设覆盖成 1(实测), 云 pass 内部再靠时域上采样只渲 1/4 边长(320×180)。
// **不动步数**(maxIterationCount / maxShadowLengthIterationCount)。
//
// 另一条更狠但**更贵**的路(只作记录, 默认不做): 关掉时域上采样
// (`skybound.cloudTemporal=off` / `vcloud tup off`) 时云 pass 从 1/4 边长(320×180)变成
// 全分辨率(1280×720) —— 步进像素 ×16 ⇒ 实测帧间差 12.87 → **5.64/255**, 但这是拿
// 16 倍云步进开销换的, 与用户"别大幅加开销"的要求冲突, 所以**只给旋钮、不改默认**。
/** 参考风速(m/s)与方向 */
const WIND_REF_SPEED = 10;
/** 方向: +X 为主, 略偏 +Z(已归一化) */
const WIND_REF_DIR_X = 1 / Math.hypot(1, 0.4);
const WIND_REF_DIR_Z = 0.4 / Math.hypot(1, 0.4);
/** 天气图: offset 1.0 ≈ 一个 tile ≈ 100km ⇒ 1e-5 /m */
const WIND_UV_PER_M_WEATHER = 1e-5;
/** shape: 库默认 shapeRepeat = 3e-4 /m(注意是 repeat 的倒数 = 每米几个 UV) */
const WIND_UV_PER_M_SHAPE = 3e-4;
/** shapeDetail: 库默认 shapeDetailRepeat = 6e-3 /m */
const WIND_UV_PER_M_SHAPE_DETAIL = 6e-3;
/** 参考风: 三个纹理空间里的"原速"偏移速率(每秒)。`cloudWind=1` 时用这套值。 */
const WIND_REF_LOCAL_WEATHER = new THREE.Vector2(
  WIND_REF_SPEED * WIND_REF_DIR_X * WIND_UV_PER_M_WEATHER,
  WIND_REF_SPEED * WIND_REF_DIR_Z * WIND_UV_PER_M_WEATHER,
);
const WIND_REF_SHAPE = new THREE.Vector3(
  WIND_REF_SPEED * WIND_REF_DIR_X * WIND_UV_PER_M_SHAPE,
  0,
  WIND_REF_SPEED * WIND_REF_DIR_Z * WIND_UV_PER_M_SHAPE,
);
const WIND_REF_SHAPE_DETAIL = new THREE.Vector3(
  WIND_REF_SPEED * WIND_REF_DIR_X * WIND_UV_PER_M_SHAPE_DETAIL,
  0,
  WIND_REF_SPEED * WIND_REF_DIR_Z * WIND_UV_PER_M_SHAPE_DETAIL,
);

// === Phase C: 丁达尔 / 云隙光柱(clouds lightShafts) ==================================
//
// 库的"光柱"是**同一套 BSM 阴影图的第二个产物**: 除了给地形用的光空间不透明度级联
// (Phase B 的 cloud-ground-shadow), 它还能逐像素向太阳方向**步进**一条"阴影长度"射线
// (`marchShadowLength`, shared.js:1150 —— 被 `#ifdef SHADOW_LENGTH` 包着, 也就是
// `effect.lightShafts`)。
//
// 这条 shadowLength 只被**两个消费点**用:
//   ① 云的 `approximateHaze()`(shared.js:1189): 把整条视线上的雾分成"有云挡住的"
//      与"没挡住的"两段, 只有**被挡住**的那段光学厚度会衰减太阳内散射
//      (`shadowOpticalDepth = (expTerm - shadowExpTerm)·linearTerm`)。于是"朝太阳方向
//      穿过云隙"的像素少衰减 ⇒ **亮柱**; 云底下仍然暗 ⇒ 这就是云隙光/丁达尔束。
//      ⇒ 光柱在**霾(haze)**这一项里, 所以 `effect.haze` 必须为 true(库默认 true)。
//   ② 大气透视/天空(库的 `AtmosphereShadowLength {map}`): 每帧在
//      `updateAtmosphereComposition()` 里从 `shadowPass.outputBuffer` 派发出来
//      (§C 实测: lightShafts=false 时它是 **null**, 打开后才有值)。
//      **我们自己那条 Phase A 大气透视不吃它**(它只对地形像素工作, 天空像素早退),
//      所以"天空上的光柱"要另想办法 —— 见 engine 的屏幕空间 god-ray 补层。
//
// 代价(库自己标了 "Expensive", 也是它的 low/medium 档默认关掉的原因):
//   shadow-length 步进发生在**云 pass 的每个像素**上, 迭代上限 `maxShadowLengthIterationCount`
//   (库默认 500)。我们把它接到质量档上(见 engine 的 shaftSamplesForQuality), 并且因为
//   `temporalUpscale` 默认开着(云 pass 只渲 1/4 边长 = 1/16 像素), 实际代价再降一档。
//
// ⚠ 与 Phase B 的云影共用同一个 BSM: 打开 lightShafts **不会**新加采样器到 three 的材质上,
//   只给库自己的 CloudsMaterial/ResolveMaterial 各加一个 sampler(它自己的预算)。
/** 库的 haze 默认值(CloudsMaterial 构造里写死) —— 我们只做倍率, 不改库的物理量。 */
const HAZE_DENSITY_BASE = 3e-5;
const HAZE_EXPONENT_BASE = 1e-3;
/** `shadow.opticalDepthTailScale` 默认 2(BSM 步进的尾部补偿 = 云的"实"度) */
const SHADOW_TAIL_BASE = 2;

/** 光柱的现场旋钮(engine 每帧从 readTuning 读出来喂进来)。 */
export interface LightShaftParams {
  enabled: boolean;
  /** haze 密度倍率 = 光柱总强度(库默认 1.0 ⇒ 3e-5) */
  densityK: number;
  /** haze 垂直/角度衰减倍率(库默认 1.0 ⇒ 1e-3); >1 = 光柱更贴地平线/更快散掉 */
  exponentK: number;
  /** shadow-length 步进迭代上限(采样数;库默认 500, 与质量档联动) */
  samples: number;
  /** 云在 BSM 里的"实"度(opticalDepthTailScale 倍率) ⇒ 云越实光柱明暗对比越强 */
  opaqueK: number;
  /** shadow-length 射线最远距离(米; 库默认 200km) */
  maxRayM: number;
}

/**
 * 确保材质里有 `DEPTH_PACKING` 这个 **define**。
 *
 * === 为什么 (实测踩坑: 这是云编译不出来的*真正*原因) ==============================
 * geospatial 的 depth 片段长这样(三个函数的定义都被这个 #ifdef 包着):
 *
 *     #ifdef DEPTH_PACKING
 *     float readDepthValue(const sampler2D depthBuffer, const vec2 uv) { … }
 *     #endif // DEPTH_PACKING
 *
 * 而 three-clouds 的 fragment 里是**无条件**调用 `readDepthValue(...)` 的。库用属性装饰器
 * (`L("DEPTH_PACKING")` + `g.prototype, "depthPacking"`) 把 `depthPacking` 映射到 define,
 * 但它的初值本来就是 `0`(`BasicDepthPacking`), 而 `setDepthTexture()` 写的是
 * `depthPacking = t ?? 0` —— **0 覆盖 0 = 没变化 ⇒ define 从未被写进去** ⇒ `#ifdef` 为假
 * ⇒ 函数被整段编译掉, 调用点却还在 ⇒
 *     ERROR: 'readDepthValue' : no matching overloaded function found
 *     → Fragment shader is not compiled  (云完全不画, 画面看着"正常", 极易误判成功)
 *
 * 修法: 把 define 显式补上(值 0 = BasicDepthPacking, 即"真的深度纹理", 正好是我们的 composer
 * DepthTexture)。有值之后再 `#if DEPTH_PACKING == 3201` 走的是 `texture(...).r`, 与我们的
 * DepthFormat/UnsignedIntType 相符。
 */
function ensureDepthPackingDefine(mat: THREE.Material | null | undefined): boolean {
  const m = mat as unknown as { defines?: Record<string, unknown> } | null | undefined;
  if (!m?.defines) return false;
  if (m.defines.DEPTH_PACKING !== undefined) return false;
  m.defines.DEPTH_PACKING = 0;
  mat!.needsUpdate = true;
  return true;
}
// === §316: 静态抖动补丁(getSTBN 的字符串改写) ==================================
/** 打了静态抖动之后留在源码里的标记串(用于幂等判断与还原) */
const STATIC_JITTER_MARKER = '/* STATIC_JITTER */';
/**
 * 把库的 `getSTBN()` 换成**静态**版本。
 *
 * 库原文(见 node_modules/@takram/three-clouds/src/shaders/clouds.glsl):
 *     float getSTBN() {
 *       ivec3 size = textureSize(stbnTexture, 0);
 *       vec3 scale = 1.0 / vec3(size);
 *       return texture(stbnTexture, vec3(gl_FragCoord.xy, float(frame % size.z)) * scale).r;
 *     }
 * 换成一个自包含的 interleaved gradient noise: 只吃 `gl_FragCoord.xy`(不动), 因此
 * **图案固定**且不平铺。命名/签名保持不变(getSTBN 的调用点很多, 不能动)。
 *
 * 返回 `{ok:false, reason}` 时调用方保持材质原状(绝不留下"未定义函数"的编译失败)。
 */
function injectStaticJitter(src: string): { ok: boolean; src: string; reason?: string } {
  if (src.includes(STATIC_JITTER_MARKER)) return { ok: true, src };
  const sig = 'float getSTBN()';
  const i = src.indexOf(sig);
  if (i < 0) return { ok: false, src, reason: '找不到 float getSTBN() 的签名(库版本变了?)' };
  const bodyStart = src.indexOf('{', i);
  if (bodyStart < 0) return { ok: false, src, reason: 'getSTBN 没有函数体' };
  // 找配对的右花括号(函数体里没有嵌套花括号, 但仍按计数匹配以防万一)
  let depth = 0; let end = -1;
  for (let k = bodyStart; k < src.length; k++) {
    const c = src[k];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  if (end < 0) return { ok: false, src, reason: 'getSTBN 的花括号不配对' };
  const replacement = `${STATIC_JITTER_MARKER}
float getSTBN() {
  // §316 静态抖动: 只用像素坐标做哈希(不随帧号变) => 噪声成为**固定图案**,
  // 单帧空间滤波(compMat 的双边上采样)就能吃掉它; 动画抖动则永远留下来。
  vec2 _sp = floor(gl_FragCoord.xy);
  return fract(52.9829189 * fract(dot(_sp, vec2(0.06711056, 0.00583715))));
}`;
  const out = src.slice(0, i) + replacement + src.slice(end + 1);
  // 自检: 替换后必须还有定义、且不再依赖 stbnTexture/frame
  if (!out.includes('float getSTBN()')) return { ok: false, src, reason: '自检失败: 替换后没有 getSTBN 定义' };
  return { ok: true, src: out };
}
/** 还原: 把标记段换回库原文 */
function restoreStaticJitter(src: string): { ok: boolean; src: string } {
  const i = src.indexOf(STATIC_JITTER_MARKER);
  if (i < 0) return { ok: false, src };
  const sig = 'float getSTBN()';
  const j = src.indexOf(sig, i);
  if (j < 0) return { ok: false, src };
  const bodyStart = src.indexOf('{', j);
  let depth = 0; let end = -1;
  for (let k = bodyStart; k < src.length; k++) {
    const c = src[k];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  if (end < 0) return { ok: false, src };
  const original = `float getSTBN() {
  ivec3 size = textureSize(stbnTexture, 0);
  vec3 scale = 1.0 / vec3(size);
  return texture(stbnTexture, vec3(gl_FragCoord.xy, float(frame % size.z)) * scale).r;
}`;
  return { ok: true, src: src.slice(0, i) + original + src.slice(end + 1) };
}

function injectDepthChunk(mat: THREE.Material | null | undefined): boolean {
  const src = (mat as { fragmentShader?: string } | null | undefined)?.fragmentShader;
  if (!src) return false;
  const uses = src.includes('readDepthValue');
  const defines = /float\s+readDepthValue\s*\(/.test(src);
  if (!uses || defines) return false;
  const writable = mat as unknown as { fragmentShader: string };
  writable.fragmentShader = `${chunkDepth}\n${src}`;
  mat!.needsUpdate = true;
  return true;
}

/**
 * 合成: 云是**预乘 alpha 的 over** —— 与库自带 mainImage 一致。
 *
 * `clouds.a` = **不透明度**(1 = 全遮蔽, 0 = 晴空); `clouds.rgb` 已乘过 alpha。
 *
 * ⚠ 这段我一开始写错过, 记录一下别再犯:
 * 最初怀疑 `a` 是"透过率", 改成了 `scene * a + clouds.rgb`。**那是错的**, 因为当时的判据
 * 来自一块**根本没编译成功的着色器**写出的垃圾缓冲(见 ensureDepthPackingDefine 的说明):
 * 未编译 ⇒ 云 pass 什么都没写 ⇒ 缓冲恒为 1/garbage ⇒ 看起来"a 在整个画面都≈1",
 * 于是被误判成"透过率=1=晴空"。等 DEPTH_PACKING 修好、云真的画出来之后再看 a 通道:
 * 晴空与机体都是 **0**、云团是 **1** ⇒ 明确是**不透明度**。
 * (当时还有一个"additive 看起来正常"的假象: pass 没渲染 ⇒ 加的是 0 ⇒ 画面自然正常。)
 */
const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D uScene;
uniform sampler2D uClouds;
uniform sampler2D uDepth;       // composer 场景深度(空间路径的边缘保护用)
uniform float uCloudsOn;
uniform float uCloudsGain;
uniform vec2  uCloudTexel;      // 云缓冲 1 像素的 uv 尺寸(1/4 边长时 = 4/屏幕宽)
uniform vec2  uNearFar;         // 相机 near/far(还原视空间深度用)
uniform float uSpatial;         // 0 = 直取(时域路径/旧行为), 1 = 空间滤波上采样
uniform float uSpatialTaps;     // 4 = 十字 / 5 = 十字+中 / 9 = 3x3
uniform float uSpatialSpread;   // 采样半径(texel; >1 = 核更宽, 压得更狠也更软)
uniform float uSpatialRange;    // 深度灵敏度(小 = 更容易跨深度混合)
uniform float uSpatialSharp;    // 亮度/不透明度灵敏度
uniform float uSpatialClampK;   // 离群钳制(k 倍标准差; 0 = 关) —— 治"突兀白点"
uniform float uSpatialFarK;     // 远景附加环半径(texel; <=1 = 关) —— 治"远处噪点"
uniform float uSpatialFarM;     // 判定"远"的距离(米)
uniform float uSpatialSoft;     // "涂抹": 绕过双边权重的固定核平均占比(0 = 关) —— 治云边串珠
varying vec2 vUv;

// 视空间线性深度(从透视图深度还原, 与 three 的 perspectiveDepthToViewZ 同式)
float viewZ(float d) {
  float z = d * 2.0 - 1.0;
  return (2.0 * uNearFar.x * uNearFar.y) / (uNearFar.y + uNearFar.x - z * (uNearFar.y - uNearFar.x));
}

/**
 * 双边上采样 + 去噪(**单帧内**, 不碰历史帧)。
 *
 * 为什么这么写(per user request: 摆脱 TAA 的限制):
 *   · 库的时域 resolve 输出 = "1/16 新采样 + 15/16 方差裁剪过的历史" ⇒ 相机一动就拖影/鬼影
 *     (库自己的注释也承认 "This increases ghosting, of course");
 *   · 这里改成 AC7 那条路: **保持云 1/4 低分辨率 march**(march 像素省 16 倍), 用单帧空间滤波重建,
 *     历史帧完全不参与 ⇒ **结构上不可能有拖影**。
 * 权重 = binomial 空间权重 x 深度相似 x 亮度相似(交叉双边): 云边/天地交界不被糊。
 *
 * === 两个"噪点"专用手段(per user request: 突兀白点 / 远处噪点) ==================
 *  ① **离群钳制(治突兀白点)**: 随机采样在暗云里偶尔落到云核上 ⇒ 单个像素亮成白点。
 *     把**中心**像素的亮度夹进"邻域均值 ± k·标准差", 颜色按比例缩放保持色相, 并把削掉的
 *     那部分从**中心那一项**里扣掉(不是缩放整体结果) ⇒ 只削离群亮度、不动邻域结构。
 *     k 由 uSpatialClampK 控制(0 = 关)。⚠ 统计量必须**排除中心自己**, 否则中心把 σ 撑大, 永远钳不住。
 *  ② **远景附加环(治远处噪点)**: 远处云的屏幕空间频率高、单像素采样少 ⇒ 噪点更明显; 而远景
 *     **没有场景深度突变**(整片天际深度都=far), 所以可以安全地多采一圈(uSpatialFarK = 环半径 texel)。
 *     ⚠ 教训: **不要**把 3x3 的间距整体放大来"加宽核" —— 间距一大抽头就不再相关,
 *       加权平均的方差反而变大(实测白点 288 -> 290 / 624 -> 638, 高频 6.51 -> 7.07, 更噪)。
 *       要加的是**采样数**, 不是间距。
 *  ③ 核宽/灵敏度本身由 spread / sharp / range 现场调(见 engine 的 vcloud spatial 表)。
 *  注: 本块在 GLSL 模板串**内**, 注释里不能出现反引号(会提前结束模板串)。
 */
vec4 spatialCloud() {
  vec4 c0 = texture2D(uClouds, vUv);
  if (uSpatial < 0.5) return c0;
  float dScene = texture2D(uDepth, vUv).r;
  float d0 = viewZ(dScene);
  // 远处加权(0 = 近景, 1 = 超过 uSpatialFarM 的远景): 远景**没有场景深度突变**(整片天际的
  // 场景深度都=far), 所以可以安全地多采一圈把噪点压下去。见文件头 ②。
  float farW = smoothstep(uSpatialFarM * 0.35, uSpatialFarM, abs(d0));
  // 中心权重**恒为 4.0**(binom 4 x wd=1 x wl=1), 钳制要拿它做减项 ⇒ 写成常量省一次判定
  const float w0 = 4.0;
  float lum0 = dot(c0.rgb, vec3(0.299, 0.587, 0.114)) + c0.a;
  vec3 acc = vec3(0.0); float accA = 0.0; float wsum = 0.0;
  float accL = 0.0; float accL2 = 0.0;
  // ④ "涂抹"项用的**纯 binomial 累加器**(不带任何双边权重): 只多两个累加器, **不多一次采样**。
  //    为什么要它: 交叉双边滤波**按设计**保护云边(亮度相近才混合), 而背光暗云的串珠恰恰长在云边上,
  //    于是所有滤波参数都动不了它(实测)。用户问"能不能靠涂抹解决" => 这里给一个**绕过双边权重**的
  //    纯平均项, 0 = 关(默认), 越大越糊越干净。代价可量化: 边缘梯度 p99 会掉。
  vec3 accS = vec3(0.0); float accSA = 0.0; float wS = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      bool cross = (x == 0) || (y == 0);
      if (uSpatialTaps < 8.0 && !cross) continue;      // 4/5 抽头: 只走十字
      float binom = (x == 0 && y == 0) ? 4.0 : (cross ? 2.0 : 1.0);
      vec2 uv = vUv + vec2(float(x), float(y)) * uCloudTexel * uSpatialSpread;
      vec4 cs = texture2D(uClouds, uv);
      float ds = viewZ(texture2D(uDepth, uv).r);
      float lums = dot(cs.rgb, vec3(0.299, 0.587, 0.114)) + cs.a;
      // 两个相似度用"线性斜坡"(比 exp 便宜、也不会溢出; 与 GTAO 的 denoise 同思路),
      // 各有 0.15 的地板 ⇒ 极端情况下也只降权、不会完全不采(避免硬边)
      float wd = max(1.0 - abs(ds - d0) / max(1e-3, uSpatialRange), 0.0);
      float wl = max(1.0 - abs(lums - lum0) / max(1e-3, uSpatialSharp), 0.0);
      float w = binom * (0.15 + 0.85 * wd) * (0.15 + 0.85 * wl);
      acc += cs.rgb * w; accA += cs.a * w; wsum += w;
      accL += lums * w; accL2 += lums * lums * w;
      accS += cs.rgb * binom; accSA += cs.a * binom; wS += binom;
    }
  }
  // ② 远景**附加一圈**(半径 = uSpatialFarK texel; <=1 视为关): 只加**采样数**、不放大 3x3 的间距。
  //    实测教训: 早先的做法是把 3x3 的间距整体乘 1.6~2.5 —— 结果**更噪**(白点 288->290/624->638,
  //    高频 6.51->7.07), 因为间距一放大, 抽头之间就不再相关, 加权平均的方差反而变大。
  if (uSpatialFarK > 1.05 && farW > 0.01) {
    float rad = uSpatialFarK * uSpatialSpread;
    for (int k = 0; k < 4; k++) {
      vec2 dir = k == 0 ? vec2(1.0, 0.0) : (k == 1 ? vec2(-1.0, 0.0) : (k == 2 ? vec2(0.0, 1.0) : vec2(0.0, -1.0)));
      vec2 uv = vUv + dir * uCloudTexel * rad;
      vec4 cs = texture2D(uClouds, uv);
      float ds = viewZ(texture2D(uDepth, uv).r);
      float lums = dot(cs.rgb, vec3(0.299, 0.587, 0.114)) + cs.a;
      float wd = max(1.0 - abs(ds - d0) / max(1e-3, uSpatialRange), 0.0);
      float wl = max(1.0 - abs(lums - lum0) / max(1e-3, uSpatialSharp), 0.0);
      float w = farW * 2.0 * (0.15 + 0.85 * wd) * (0.15 + 0.85 * wl);
      acc += cs.rgb * w; accA += cs.a * w; wsum += w;
      accL += lums * w; accL2 += lums * lums * w;
    }
  }
  vec4 outC = wsum > 1e-4 ? vec4(acc / wsum, accA / wsum) : c0;
  // ① 离群钳制(治"突兀白点"): 把**中心**的亮度夹进"邻域均值 ± k·σ", 颜色整体缩放保色相。
  //    ⚠ 统计量必须**排除中心自己** —— 早先用含中心的 mean/σ, 中心这个离群点把自己的 σ 撑大,
  //      于是永远钳不住(实测 clamp 2.5 / 6 与 clamp 0 的白点数 288 -> 285 -> 290, 等于没做)。
  //    排除中心是**零成本**的: 中心贡献(gray*lum0 与 w0)本来就在累加器里, 减掉即可。
  //    削掉的量也要从**中心那一项**里扣(不是缩放整体结果), 否则连邻域的真实结构一起压暗。
  if (uSpatialClampK > 0.05 && wsum > w0 + 1e-4) {
    float sum8 = wsum - w0;
    float mean8 = (accL - lum0 * w0) / sum8;
    float var8 = max(0.0, (accL2 - lum0 * lum0 * w0) / sum8 - mean8 * mean8);
    float lim = uSpatialClampK * max(sqrt(var8), 1e-3) + 0.003;
    float Lc = clamp(lum0, mean8 - lim, mean8 + lim);
    vec4 c0c = vec4(c0.rgb * (Lc / max(lum0, 1e-4)), c0.a);
    outC = vec4((acc - c0.rgb * w0 + c0c.rgb * w0) / wsum,
                (accA - c0.a * w0 + c0c.a * w0) / wsum);
  }
  // ④ "涂抹": 与双边权重无关的固定核平均(见上面 accS 的注释)。放在钳制**之后** ⇒
  //    先做无痛的离群点外科手术, 再做用户要的整体软化。
  if (uSpatialSoft > 0.001 && wS > 1e-4) {
    vec4 soft = vec4(accS / wS, accSA / wS);
    outC = vec4(mix(outC.rgb, soft.rgb, uSpatialSoft), mix(outC.a, soft.a, uSpatialSoft));
  }
  return outC;
}

void main() {
  vec4 scene = texture2D(uScene, vUv);
  if (uCloudsOn < 0.5) { gl_FragColor = scene; return; }
  vec4 clouds = spatialCloud();
  // 预乘 over: a = 不透明度。uCloudsGain 见 setGain 的说明(辐射尺度对齐)。
  vec3 cloudRgb = clouds.rgb * uCloudsGain;
  gl_FragColor = vec4(
    scene.rgb * (1.0 - clouds.a) + cloudRgb,
    scene.a * (1.0 - clouds.a) + clouds.a
  );
}
`;

const COMPOSITE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Phase A 的天空 LUT 辐射亮度, 相对**库自带的 Bruneton 参考 LUT**
 * (`@takram/three-atmosphere/assets/irradiance.bin`, 同一套 AtmosphereParameters.DEFAULT)
 * 低约 **3.8 倍** —— 用我们自烘的 IrradianceLut 逐格对照实测:
 *   h=0,    mu_s=1 : 我们 0.01188 vs 参考 0.04514   (0.263)
 *   h=10km, mu_s=1 : 我们 0.002359 vs 参考 0.008972 (0.263)
 *   → **高度的依赖关系完全一致**(比值 5.0 vs 5.03), 通道比也一致 ⇒ 是整体尺度差, 不是形状差。
 * (剩余随太阳高度的漂移: mu_s 0.5 处 0.215、近地平 0.14 —— 低太阳角的残差更大, 见已知限制。)
 *
 * 云吃的是"物理辐照度", 而画面里的天空是 **我们的 LUT × radianceScale** ⇒ 云必须再乘
 * 1/3.8 才与天空同源(否则云会整体比天空亮 3.8 倍)。
 */
const SKY_RADIANCE_RATIO = 1 / 3.8;

/** 一层云的配置(映射到库的 CloudLayer: channel / altitude / height / 是否参与 BSM 阴影)。 */
export interface TakramCloudBand {
  /** localWeather 的通道: 4 层分别吃 r/g/b/a */
  channel: 'r' | 'g' | 'b' | 'a';
  /** 云底高度(米) */
  altitude: number;
  /** 云层厚度(米) */
  height: number;
  /** 是否参与 Beer Shadow Map(云影/光柱)。false = 该层不投影 */
  shadow: boolean;
  /** 密度(0 = 该层关闭) */
  densityScale: number;
  /**
   * 形状量 0..1(库默认 1)。**这是"层内是否饱和"最有效的旋钮之一**:
   * 着色器里 `density = remap(density, (1-shape)*shapeAmount, 1)` ——
   * shapeAmount 越小, 噪声阈值越低 ⇒ 层内更多体素直接顶到密度 1(实心团块),
   * 而不是"一片半透明的雾"。0.7~0.8 会明显更像"云团"。
   */
  shapeAmount?: number;
  /**
   * 覆盖率过滤宽度(库默认 0.6, 第 3 层 0.5)。越小 ⇒ 天气图的覆盖率过渡越锐利,
   * 云体内部越"满"(要么实心要么没有)。**薄雾感的直接对手**: 0.4 附近开始明显。
   */
  coverageFilterWidth?: number;
  /** 细节侵蚀量(库默认 1; 第 3 层是 0) */
  shapeDetailAmount?: number;
  /** 天气图指数(库默认 1); 越小云越满 */
  weatherExponent?: number;
  /**
   * 层内密度廓线 `exp(expTerm·e^(exponent·hf)) + linearTerm·hf + constantTerm`(hf = 层内归一化高度)。
   * 库默认 `(0, 0, 0.75, 0.25)`: 层底只有 0.25 ⇒ 底部本身就淡。
   * 想让"整层都实"就把它压平(如 `(0,0,0.5,0.5)`)。
   */
  densityProfile?: { expTerm?: number; exponent?: number; linearTerm?: number; constantTerm?: number };
}

export class TakramCloudsPass extends Pass {
  readonly effect: CloudsEffect;
  private compMat: THREE.ShaderMaterial;
  private fsComp: FullScreenQuad;
  private camera: THREE.PerspectiveCamera;
  private initialized = false;
  private lastDepthTexture: THREE.Texture | null = null;
  /** 合成开关(与 pass 的 enabled 分开: 可以留着云图但临时不合成, 便于 A/B) */
  private compositeOn = true;
  /** 时域上采样需要 STBN 贴图; 没贴图时开着只会更花 */
  private stbn: THREE.Data3DTexture | null = null;
  /** 是否尝试过生成程序化 STBN(避免失败后每帧重试) */
  private temporalAttempted = false;
  /** 自检: 是否真的拿到了云图(诊断用) */
  private lastHadClouds = false;
  // === Phase B: 云光照对接(路 A) ==============================================
  /** 挂在云上的物理大气(为 null = 不接, 回到"只有环境项"的旧行为) */
  private atmoSys: AtmosphereSystem | null = null;
  /** 我们自烘的天空辐照度 LUT(64×16, 与库的 IRRADIANCE_TEXTURE_* 一致) */
  private irrLut: IrradianceLut | null = null;
  /** 云材质被库重建时要把两张 LUT 重新挂上去(幂等, 每帧比对一次引用) */
  private lastAtmoMat: THREE.Material | null = null;
  /** 本帧的 LUT 是否已挂上(自检用) */
  private atmoLightOk = false;
  /** 云合成增益的标定基准(radianceScale 归一化前的值), 见 applyAtmoGain */
  private baseGain = 1.0;
  /** Phase C: 光柱开关的实际状态(库的 getter 是当前 define 的镜像, 这里留一份显式的) */
  private lightShaftsOn = false;

  constructor(camera: THREE.PerspectiveCamera, resolutionScale = 0.5) {
    super();
    this.camera = camera;
    // needsSwap: 我们要把 readBuffer 换成合成结果写回 writeBuffer
    this.needsSwap = true;
    // 默认关 —— 由引擎按设置项/调试开关打开
    this.enabled = false;

    // 第 3 参数省略时库内部默认 `AtmosphereParameters.DEFAULT`(真实地球半径 + 大气高度),
    // 于是椭球/大气厚度都是自洽的, 不需要我们手搓一个 {bottomRadius, topRadius}。
    // ⚠ Phase B: 这里改成**显式传我们自己的实例** —— 库会把它包成材质的 `ATMOSPHERE`
    //    uniform, 我们每帧把 `solar_irradiance` 换成 Phase A 那份(含夜景压暗 / atmo tint
    //    的太阳辐照度)。传实例而不是用默认值, 是为了不污染 `AtmosphereParameters.DEFAULT`
    //    那个**全局静态对象**(别的库/组件也在读它)。
    //   `new AtmosphereParameters()` 的数值与 EARTH_ATMOSPHERE 逐项相同(Phase A 抄的就是
    //    这套参考值: bottomRadius 6360km / topRadius 6420km / solarIrradiance (1.474,1.8504,1.91198)),
    //    所以这不是"另一套大气", 而是同一套的**可变副本**。
    this.effect = new CloudsEffect(camera, { resolutionScale }, new AtmosphereParameters());

    // === 程序化噪声(零资产) ====
    this.effect.shapeTexture = new CloudShape();              // 3D Perlin-Worley, 云的基础形状
    this.effect.shapeDetailTexture = new CloudShapeDetail();   // 3D 细节侵蚀
    this.effect.localWeatherTexture = new LocalWeather();      // 2D 天气图: 覆盖率/云型
    this.effect.turbulenceTexture = new Turbulence();          // 2D 湍流扰动

    // === 走"解析日照"路径(accurateSunSkyLight=false) =========================
    // 这条路径**只要两张 2D 贴图**: transmittance + irradiance(见 shaders/bruneton/runtime
    // 的 GetSunAndSkyScalarIrradiance, shared3.js:817)。另一条(true)要 3D 的
    // scattering / single_mie_scattering / higher_order_scattering, 那是 Bruneton 的
    // 4D LUT 体系, 与本项目的 Hillaire 方案对不上(而且体积极大)。
    // ⇒ **选 false + 喂我们自己的两张 2D LUT**, 这就是 Phase B 的"路 A"。
    this.effect.clouds.accurateSunSkyLight = false;
    // STBN 缺失 ⇒ 时域上采样先关(见文件头说明)
    this.effect.temporalUpscale = false;
    this.effect.qualityPreset = 'medium';

    this.compMat = new THREE.ShaderMaterial({
      uniforms: {
        uScene: { value: null as THREE.Texture | null },
        uClouds: { value: null as THREE.Texture | null },
        uCloudsOn: { value: 1 },
        // === Phase B: 增益语义变了 ==========================================
        // Phase 0/§281 时期: 库的日照项恒为 0(缺 transmittance/irradiance 贴图),
        //   画面里那层"薄雾"其实是数值残差, 所以要 ×10 才勉强看得见。
        // 现在(attachAtmosphere 之后)库拿到真的太阳/天空辐照, 输出已经是**辐射亮度**,
        //   增益回到"辐射尺度对齐"的本意: 实际值 = baseGain × radianceScale/8
        //   (见 applyAtmoGain)。初值 1.0, 现场用 `skybound.cloudsGain` 标定。
        // ⚠ 初值直接写在这里而**不是**在构造函数里调 setGain(): setGain 依赖 this.compMat,
        //    而 compMat 在本语句之后才创建 —— 在构造里提前调用会抛 TypeError, 把整个
        //    setupPostProcessing 连带打断(踩过: takram pass 静默消失)。
        uCloudsGain: { value: 1 },
        // === §316 单帧空间滤波(摆脱时域历史) ================================
        uDepth: { value: null as THREE.Texture | null },
        uCloudTexel: { value: new THREE.Vector2(1 / 320, 1 / 180) },
        uNearFar: { value: new THREE.Vector2(2, 80000) },
        /** 0 = 直取解析图(旧行为/退路), 1 = 空间滤波上采样(新默认) */
        uSpatial: { value: 0 },
        uSpatialTaps: { value: 9 },
        uSpatialSpread: { value: 1 },
        uSpatialRange: { value: 900 },
        uSpatialSharp: { value: 0.12 },
        // §320: 噪点三件套 —— 离群钳制(突兀白点) / 远处加宽(远处噪点)
        // 默认值来自 §316 的 A/B: k=2.5σ 能削掉绝大部分"白点"而肉眼看不到结构变化(见 DEVELOPMENT §320)
        uSpatialClampK: { value: 2.5 },
        uSpatialFarK: { value: 2.0 },
        uSpatialFarM: { value: 6000 },
        uSpatialSoft: { value: 0 },
      },
      vertexShader: COMPOSITE_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.fsComp = new FullScreenQuad(this.compMat);
    // 补上库缺的 depth 片段(三个材质: 云步进 / 解析 / 阴影)
    this.patchLibraryShaders();
  }

  /**
   * **库着色器补丁的总入口**(曾名 `patchDepthChunks`; §302 起它同时负责两件事,
   * 所以都从这里走 —— 所有"库可能重建/重编译材质"的钩子都调它, 幂等且便宜):
   *   ① 补 depth 片段 + DEPTH_PACKING define(见 patchDepthChunks 的长注释);
   *   ② §302 3D 覆盖率注入(见 clouds-cover3d.ts 头; `off` 时只注入恒等包装, 由 define 决定是否生效)。
   */
  private patchLibraryShaders(): void {
    this.patchDepthChunks();
    this.patchCover3DAll();
    this.patchStaticJitter();   // §316: 静态抖动(源头治"沸腾")
  }

  /**
   * 给库的材质补 depth 片段。
   * 材质是 `RawShaderMaterial` + 固定 fragment 字符串 ⇒ 直接改字符串最确定;
   * 但质量档/分辨率变化可能让库重建材质, 所以 initialize/setQuality/setSize 都再补一次(幂等)。
   */
  private patchDepthChunks(): void {
    const eff = this.effect as unknown as {
      cloudsPass?: { currentMaterial?: THREE.Material; resolveMaterial?: THREE.Material };
      shadowPass?: { currentMaterial?: THREE.Material };
    };
    const defined: string[] = [];
    const patched: string[] = [];
    const targets: Array<[string, THREE.Material | undefined]> = [
      ['clouds', eff.cloudsPass?.currentMaterial],
      ['resolve', eff.cloudsPass?.resolveMaterial],
      ['shadow', eff.shadowPass?.currentMaterial],
    ];
    for (const [name, mat] of targets) {
      if (ensureDepthPackingDefine(mat)) defined.push(name);
      if (injectDepthChunk(mat)) patched.push(name);
    }
    if (defined.length) console.info(`[clouds] 已补 DEPTH_PACKING define: ${defined.join(', ')}`);
    if (patched.length) console.info(`[clouds] 已补 depth 片段: ${patched.join(', ')}`);
  }

  // === §302 Phase F: 3D 覆盖率(把库的 2D 覆盖率场升维到 3D) ======================
  //
  // 库的 `weather.density` 只吃 `uv`(= 水平映射, 见 clouds-cover3d.ts 头)。这里在
  // `sampleWeather()` 外面包一层, 用**同一张 3D `shapeTexture`**(零新增采样器)在**世界空间**
  // 换尺度/相位再采一次当"低频 3D 覆盖率场" ⇒ 同一 (x,z) 柱子在**不同高度**上有/无云。
  //
  // 三个档(`skybound.cloudCover3D`, **每帧读**; 键不存在 ⇒ **默认 `on`**, 见 DEFAULT_COVER3D):
  //   `on`(默认)  = 打开 define ⇒ 3D 覆盖率生效(强度/频率/阈值见下面三个旋钮)
  //   `off`        = 注入保留但 `COVER3D` define 关着 ⇒ 包装函数是**恒等透传**(与库原文逐位一致)
  //   `unpatched`  = 把材质 `fragmentShader` **反向改回库原文**(= 从没注入过), 供取证/一键还原
  // 旋钮(都每帧读, 只写标量 uniform ⇒ 不触发重编译):
  //   `skybound.cloudCover3DK`(0..1, 默认 1)、`skybound.cloudCover3DScale`(0.1..4, 默认 1.2)、
  //   `skybound.cloudCover3DBias`(-0.3..0.3, 默认 0; 列内相对偏差的阈值平移)
  // 参考高度 `uCover3DRefY` 不是旋钮: 由 `cover3dRefY()` 从当前层配置算(云带中高)。
  /** 两个注入口(云步进 + BSM 阴影; 后者保证"有影有云"一致) */
  private cover3dTargets(): Array<[string, THREE.Material | null | undefined]> {
    const eff = this.effect as unknown as {
      cloudsPass?: { currentMaterial?: THREE.Material };
      shadowPass?: { currentMaterial?: THREE.Material };
    };
    return [
      ['clouds', eff.cloudsPass?.currentMaterial],
      ['shadow', eff.shadowPass?.currentMaterial],
    ];
  }

  /**
   * 读开关(`skybound.cloudCover3D`)。
   * ⚠ **键不存在 ⇒ 用 `DEFAULT_COVER3D.mode`**(§302 起是 `on`), **不是** `off` ——
   *   否则"出厂默认"和"键没写过"会变成两件事(踩过: 默认翻了 on 但这条写死 off ⇒ 白翻)。
   * 显式的 `off`/`0`/`false` ⇒ 恒等档; 其它非法值也回 `DEFAULT_COVER3D.mode`。
   */
  private cover3dMode(): Cover3DParams['mode'] {
    try {
      const raw = window.localStorage.getItem('skybound.cloudCover3D');
      if (raw === null || raw.trim() === '') return DEFAULT_COVER3D.mode;
      const v = raw.trim().toLowerCase();
      if (v === 'on' || v === '1' || v === 'true') return 'on';
      if (v === 'unpatched') return 'unpatched';
      if (v === 'off' || v === '0' || v === 'false') return 'off';
      return DEFAULT_COVER3D.mode;
    } catch {
      return DEFAULT_COVER3D.mode;
    }
  }

  /** 当前生效的 3D 覆盖率参数(每帧读 ⇒ devtools 改完立刻生效) */
  cover3dParams(): Cover3DParams {
    return {
      mode: this.cover3dMode(),
      k: readTuning('skybound.cloudCover3DK', 1, 0, 1),
      scale: readTuning('skybound.cloudCover3DScale', DEFAULT_COVER3D.scale, 0.1, 4),
      bias: readTuning('skybound.cloudCover3DBias', 0, -0.3, 0.3),
      refY: this.cover3dRefY(),
    };
  }

  /**
   * 参考高度(米) = 当前所有"有效云层"(厚度 > 0)的**中高**。
   * 掩码是"列内相对"的(与本列中高处的同一个场值比), 所以参考点必须落在云带里;
   * 层配置变了(云底/云顶旋钮)这里会跟着变 ⇒ 每帧重新算, 不用手工维护一个常量。
   */
  private cover3dRefY(): number {
    try {
      const layers = this.effect.cloudLayers as unknown as {
        length: number; [i: number]: { altitude: number; height: number };
      };
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < (layers?.length ?? 0); i++) {
        const l = layers[i];
        if (!l || !(l.height > 0)) continue;
        lo = Math.min(lo, l.altitude);
        hi = Math.max(hi, l.altitude + l.height);
      }
      if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) return (lo + hi) / 2;
    } catch { /* ignore */ }
    return DEFAULT_COVER3D.refY;
  }

  /**
   * 注入(幂等, 带自检)。**任何一处锚点没命中就整体放弃并 console.warn** ——
   * 宁可"没效果", 也不能留下半截补丁(历史上硬塞导致过整块材质编译失败)。
   * `unpatched` 档**跳过注入**(否则会与 applyCover3D 的还原每帧互相打架 ⇒ 每帧重编译)。
   */
  private patchCover3DAll(): void {
    if (this.cover3dMode() === 'unpatched') return;
    for (const [kind, mat] of this.cover3dTargets()) {
      const r = patchCover3D(mat);
      this._cover3dPatch[kind] = r;
      if (!r.ok) {
        if (r.absent) continue;   // 库没建这个 pass ⇒ 不是失败, 不告警
        const key = `${kind}:${r.reason}`;
        if (!this._cover3dWarned.has(key)) {
          this._cover3dWarned.add(key);
          console.warn(`[cover3d] ${kind} 材质注入**放弃**(保持未打补丁): ${r.reason}`);
        }
      } else if (r.changed) {
        console.info(`[cover3d] 已注入 3D 覆盖率(${kind} / ${r.name})`
          + ` 调用点 ${r.anchors.callSites} 处 · shapeTexture ${r.anchors.shapeTexture ? '有' : '无'}`);
      }
    }
  }

  /**
   * 每帧: 读开关 ⇒ 注入/还原 + define 开关 + 写 uniform。
   *
   * 代价控制: 字符串级操作(注入/还原/自检)只在"材质引用或档位变了"时做一次;
   * 每帧只写 3 个标量 uniform(幂等, 值没变就一个字节都不写)。
   */
  private applyCover3D(): void {
    const p = this.cover3dParams();
    const targets = this.cover3dTargets();
    const refs = targets.map(([, m]) => m ?? null);
    const structural = p.mode !== this._cover3dModeCache
      || refs.length !== this._cover3dRefs.length
      || refs.some((m, i) => m !== this._cover3dRefs[i]);
    if (structural) {
      this._cover3dRefs = refs;
      this._cover3dModeCache = p.mode;
      if (p.mode === 'unpatched') {
        let n = 0;
        for (const [, mat] of targets) {
          if (setCover3DDefine(mat, false)) n++;
          if (unpatchCover3D(mat)) n++;
        }
        console.info(`[cover3d] 已把库的 fragmentShader 还原成原文(unpatched, ${n} 处改动)`);
      } else {
        this.patchCover3DAll();
      }
    }
    this._cover3dParams = p;
    if (p.mode === 'unpatched') return;
    for (const [, mat] of targets) {
      // define = 真正的开关(关掉 ⇒ recompile 回恒等路径, 见 clouds-cover3d.ts 头)
      setCover3DDefine(mat, p.mode === 'on');
      if (p.mode === 'on') setCover3DUniforms(mat, p);
    }
  }

  /** 立刻应用一次(控制台/探针用: 不必等下一帧, 报告里就能看到真实状态) */
  applyCover3DNow(): void {
    try { this.applyCover3D(); } catch (err) { console.warn('[cover3d] 立刻应用失败:', err); }
  }

  /** 3D 覆盖率自检(控制台 `vcloud cover3d` / 探针 `__cover3d()` 用) */
  cover3dDiag(): {
    params: Cover3DParams;
    materials: Array<{
      kind: string;
      name: string;
      patched: boolean;
      defined: boolean;
      patch: Cover3DPatchResult | null;
      gl: Cover3DGlCheck | null;
      /** 材质上 4 个 uniform 的实际值(-1 = 没有) */
      uniform: { k: number; scale: number; bias: number; refY: number };
    }>;
  } {
    const materials = this.cover3dTargets().map(([kind, mat]) => {
      const u = (mat as unknown as { uniforms?: Record<string, { value?: unknown }> } | null | undefined)?.uniforms;
      const num = (v: unknown) => (typeof v === 'number' ? +v.toFixed(4) : -1);
      return {
        kind,
        name: (mat as unknown as { name?: string } | null | undefined)?.name ?? '(none)',
        patched: isCover3DPatched(mat),
        defined: isCover3DDefined(mat),
        patch: this._cover3dPatch[kind] ?? null,
        gl: this._lastRenderer ? checkCover3DProgram(this._lastRenderer, mat) : null,
        // 顺手把 uniform 实际值带出来(便于确认"每帧读"真的写进去了)
        uniform: {
          k: num(u?.uCover3DK?.value),
          scale: num(u?.uCover3DScale?.value),
          bias: num(u?.uCover3DBias?.value),
          refY: num(u?.uCover3DRefY?.value),
        },
      };
    });
    return { params: this._cover3dParams ?? this.cover3dParams(), materials };
  }

  private _cover3dPatch: Record<string, Cover3DPatchResult> = {};
  private _cover3dWarned = new Set<string>();
  private _cover3dRefs: Array<THREE.Material | null> = [];
  private _cover3dModeCache = '\u0000';
  private _cover3dParams: Cover3DParams | null = null;
  /** render() 里留一份 renderer(自检 `checkCover3DProgram` 要用; 只存引用, 不持有) */
  private _lastRenderer: THREE.WebGLRenderer | null = null;

  /** 首次进链时初始化库(需要 renderer 与目标缓冲类型)。 */
  initialize(renderer: THREE.WebGLRenderer, frameBufferType: THREE.TextureDataType) {
    if (this.initialized) return;
    this.effect.initialize(renderer, false, frameBufferType);
    // 库在这里可能才把材质定型 ⇒ 再补一次(幂等)
    this.patchLibraryShaders();
    this.initialized = true;
  }

  /** 云层配置(米制高度直接喂进去)。 */
  setBands(bands: readonly TakramCloudBand[]) {
    const next = bands.map((b) => ({
      channel: b.channel,
      // 库的 altitude 是云底高度(米), height 是厚度(米)
      altitude: b.altitude,
      height: b.height,
      densityScale: b.densityScale,
      shadow: b.shadow,
      // 形状/覆盖率/细节(不传 = 沿用库的当前值; 见 TakramCloudBand 的说明)
      ...(b.shapeAmount !== undefined ? { shapeAmount: b.shapeAmount } : {}),
      ...(b.coverageFilterWidth !== undefined ? { coverageFilterWidth: b.coverageFilterWidth } : {}),
      ...(b.shapeDetailAmount !== undefined ? { shapeDetailAmount: b.shapeDetailAmount } : {}),
      ...(b.weatherExponent !== undefined ? { weatherExponent: b.weatherExponent } : {}),
      ...(b.densityProfile !== undefined ? { densityProfile: b.densityProfile } : {}),
    }));
    // 库固定 4 层: 没给的层把密度归零, 否则会留着默认层继续渲染
    const value = [0, 1, 2, 3].map((i) => next[i] ?? {
      channel: (['r', 'g', 'b', 'a'] as const)[i],
      altitude: 0,
      height: 0,
      densityScale: 0,
      shadow: false,
    });
    this.effect.cloudLayers.set(value);
  }

  /**
   * 单次光线的最远距离(米)。库默认 **200000(200km!)**: 掠射视线会穿过上百公里的云层,
   * 把"远看一片云"堆成一堵白墙 —— 这正是"飞进云里只有一层薄雾"的影像成因之一
   * (近处云薄 + 远处云糊成一片)。收到 40~80km 后掠射视线的堆积大幅减轻, 云团边界清楚。
   */
  setMaxRayDistance(m: number) {
    const v = Math.max(1000, Math.min(200000, m));
    if (Math.abs((this.effect.clouds.maxRayDistance as number) - v) > 1) {
      this.effect.clouds.maxRayDistance = v;
      this.patchLibraryShaders();
    }
  }
  getMaxRayDistance(): number { return this.effect.clouds.maxRayDistance as number; }

  setQuality(preset: CloudsQualityPreset) {
    this.effect.qualityPreset = preset;
    this.patchLibraryShaders();
  }
  getQuality(): CloudsQualityPreset { return this.effect.qualityPreset; }

  setCoverage(v: number) { this.effect.coverage = v; }
  getCoverage(): number { return this.effect.coverage; }

  // === Phase B: 云光照对接 =====================================================
  //
  // 问题(§281 实测): 把 `sunDirection` 整体取反, 画面**几乎逐像素不变** —— 因为库里算
  // "太阳直射辐照"和"天空辐照"的 `GetSunAndSkyScalarIrradiance` 要采两张贴图
  // (`transmittance_texture` / `irradiance_texture`), 而它们都是 **null** ⇒
  //   sunIrradiance  = solar_irradiance × GetTransmittanceToSun(null, ...) = **0**
  //   skyIrradiance  = GetIrradiance(null, ...) × 2π                    = **0**
  // 于是云的所有项(直射 × 多次散射近似、天光充填、地面反弹、霾内散射)全部乘 0, 只剩数值
  // 噪声 —— 画面里那层"薄雾"就是这么来的, 也是"没被太阳照亮"的真正根因(不是增益不够)。
  //
  // 解法("路 A" —— 按库期望的格式喂兼容 LUT):
  //   · `transmittance_texture` ← **Phase A 的透过率 LUT**(`TransmittanceLut`)。
  //     尺寸 256×64、HalfFloat、存透过率(不是光学厚度), UV 参数化
  //     `uv=( (d-dMin)/(dMax-dMin), rho/H )` —— 与库的 `GetTransmittanceTextureUvFromRMu`
  //     **逐项相同**(Phase A 抄的就是 Bruneton 2017 那套), 库的
  //     `TRANSMITTANCE_TEXTURE_WIDTH=256/HEIGHT=64` 也正好一致。零适配。
  //   · `irradiance_texture` ← 自烘的 `IrradianceLut`(64×16, 与库的
  //     `IRRADIANCE_TEXTURE_WIDTH=64/HEIGHT=16` 一致, UV 参数化同款 —— 见该文件头)。
  //   · 每帧把 Phase A 的 `uAtmSolarIrradiance` 镜像进材质的 `ATMOSPHERE.solar_irradiance`
  //     ⇒ 夜景压暗 / `atmo tint` 对**云**也生效(§293 的"改 atmo exp 看不到云变化"一并解决)。
  // 这条路**一行库的着色器都不用改**, 而且用的是库自己那套经过验证的日照代码
  // (太阳盘地平线判据 / 到太阳的透过率 / 天空辐照)。
  attachAtmosphere(sys: AtmosphereSystem | null): void {
    this.atmoSys = sys;
    this.lastAtmoMat = null;   // 下一帧重新挂
    if (!sys) {
      // 摘掉: 把两张 LUT 置空(否则库还在用它们, A/B 就比不出"有没有光照")
      try {
        this.effect.transmittanceTexture = null;
        this.effect.irradianceTexture = null;
      } catch { /* ignore */ }
      this.atmoLightOk = false;
      // 回到 Phase 0 的"平光"增益(那层薄雾是残留辐射, 要 ×10 才看得见)
      this.setGain(10);
    }
  }

  /** 云光照是否已生效(探针/自检用) */
  isAtmoLightAttached(): boolean { return this.atmoLightOk; }

  /** 取云材质的 `ATMOSPHERE.solar_irradiance`(库把它包成 struct uniform) */
  private solarIrradianceUniform(): THREE.Vector3 | null {
    const mat = (this.effect as unknown as {
      cloudsPass?: { currentMaterial?: THREE.Material };
    }).cloudsPass?.currentMaterial;
    const u = (mat as unknown as { uniforms?: Record<string, unknown> } | undefined)?.uniforms;
    const atm = u?.ATMOSPHERE as { value?: { solar_irradiance?: THREE.Vector3 } } | undefined;
    return atm?.value?.solar_irradiance ?? null;
  }

  /**
   * 每帧调用(由 render() 内部调, 保证在 `effect.update()` 之前): 挂 LUT + 镜像太阳辐照度。
   * 幂等: 材质引用变了(库在质量档/尺寸变化时可能重建材质)就重新挂一次。
   */
  private ensureAtmoLight(renderer: THREE.WebGLRenderer): void {
    const sys = this.atmoSys;
    if (!sys) { this.atmoLightOk = false; return; }
    const mat = (this.effect as unknown as {
      cloudsPass?: { currentMaterial?: THREE.Material };
    }).cloudsPass?.currentMaterial ?? null;
    if (!mat) { this.atmoLightOk = false; return; }

    if (!this.irrLut) {
      // 用系统自己的 LutBaker 之外的独立 baker: 尺寸/生命周期与云绑定, 与 Phase A 解耦
      this.irrLut = new IrradianceLut(
        sys.uniforms,
        sys.transmittance.texture,
        sys.multiscatter.texture,
      );
    }

    // 太阳辐照度(含夜景压暗 / tint)先镜像过去 —— LUT 烘焙也要读它
    const E = sys.uniforms.uAtmSolarIrradiance.value as THREE.Vector3;
    const dst = this.solarIrradianceUniform();
    if (dst) dst.copy(E);

    // 辐照度 LUT: 只在"辐照度/介质真的变了"时重烤(它不依赖太阳方向与相机)
    this.irrLut.update(renderer, E);

    if (this.lastAtmoMat !== mat) {
      this.effect.transmittanceTexture = sys.transmittance.texture;
      this.effect.irradianceTexture = this.irrLut.texture;
      this.lastAtmoMat = mat;
    }
    this.atmoLightOk = !!(this.effect.transmittanceTexture && this.effect.irradianceTexture);
  }

  /**
   * 库的输出是**物理辐射亮度**(太阳常数那一套单位), 而本项目的画面曝光是 Phase A 的
   * `skybound.atmoExp`(radianceScale)定下来的 —— 天空就是这么显示的:
   *     画面亮度 = 天空 LUT 的辐射亮度 × radianceScale
   * 所以云也必须乘同一个 radianceScale, 两边才同源:
   *     uCloudsGain = cloudsGain(标定基准) × radianceScale × SKY_RADIANCE_RATIO
   * 这样 `atmo exp` 改天空时云跟着走(§293 的已知限制: "天空最亮处被云盖住时改 atmo exp
   * 看不到变化" —— 一并解决)。
   */
  private applyAtmoGain(): void {
    // 没接上光照时不要动增益(attachAtmosphere(null) 会设成平光值 10, 供 A/B 对比)
    if (!this.atmoLightOk || !this.atmoSys) return;
    const base = this.baseGain;
    const rs = this.atmoSys.frame.radianceScale || 8;
    this.setGain(base * rs * SKY_RADIANCE_RATIO);
  }

  setLightShafts(on: boolean) {
    const eff = this.effect as unknown as { lightShafts: boolean };
    if (eff.lightShafts === !!on) return;
    eff.lightShafts = !!on;
    this.lightShaftsOn = !!on;
    // 打开/关闭会换 define(SHADOW_LENGTH) 并重建 render target(库的 setter 内部做),
    // 材质随之重编译 ⇒ 立刻把 depth 片段/DEPTH_PACKING 补回去(否则坑一复发:
    // "readDepthValue 没有重载" ⇒ 云整块不画)。
    this.patchLibraryShaders();
  }
  getLightShafts(): boolean { return this.lightShaftsOn; }

  /**
   * 每帧喂光柱旋钮(engine 调用)。**幂等且 cheap**: 只写几个 uniform/属性。
   *
   * 写的是库自己的那几个量(不做"我们自己的后处理系数"), 因为光柱的物理链条
   * (BSM → shadowLength 步进 → 霾内散射衰减) 全在库里; 我们能调的只有它的输入:
   *   · `clouds.hazeDensityScale`  = 霾密度        → 光柱**强度**(最直接的一根)
   *   · `clouds.hazeExponent`      = 霾的高度衰减  → 光柱**衰减/寿命**
   *   · `clouds.maxShadowLengthIterationCount`     → **采样数**
   *   · `clouds.maxShadowLengthRayDistance`        → 光柱能穿多远(掠射越远, 柱越长越糊)
   *   · `shadow.opticalDepthTailScale`             → 云在 BSM 里的"实"度 ⇒ **云不透明度→光柱对比**
   * 另外 `coverage`(engine 每帧写, = 天气 cov × cloudCovK)会**门控**整个霾:
   * 库是 `modulation = remapClamped(coverage, 0.2, 0.4)` ⇒ coverage<0.2 时霾为 0、光柱直接消失。
   */
  applyLightShafts(p: LightShaftParams): void {
    if (this.effect.lightShafts !== !!p.enabled) this.setLightShafts(p.enabled);
    if (!p.enabled) return;
    const c = this.effect.clouds as unknown as {
      hazeDensityScale: number;
      hazeExponent: number;
      maxShadowLengthIterationCount: number;
      maxShadowLengthRayDistance: number;
    };
    const sh = this.effect.shadow as unknown as { opticalDepthTailScale: number };
    // 只在真的变了才写(库的 shorthand 写值会 needsUpdate —— 每帧写会引起整帧重编译抖动)
    const wantDensity = HAZE_DENSITY_BASE * Math.max(0.05, p.densityK);
    if (Math.abs(c.hazeDensityScale - wantDensity) > 1e-9) c.hazeDensityScale = wantDensity;
    const wantExp = HAZE_EXPONENT_BASE * Math.max(0.1, p.exponentK);
    if (Math.abs(c.hazeExponent - wantExp) > 1e-9) c.hazeExponent = wantExp;
    const wantSamples = Math.max(8, Math.min(500, Math.round(p.samples)));
    if (c.maxShadowLengthIterationCount !== wantSamples) c.maxShadowLengthIterationCount = wantSamples;
    const wantRay = Math.max(5000, Math.min(200000, p.maxRayM));
    if (Math.abs(c.maxShadowLengthRayDistance - wantRay) > 1) c.maxShadowLengthRayDistance = wantRay;
    const wantTail = SHADOW_TAIL_BASE * Math.max(0.1, p.opaqueK);
    if (Math.abs(sh.opticalDepthTailScale - wantTail) > 1e-9) sh.opticalDepthTailScale = wantTail;
  }

  /**
   * 光柱自检(探针/`vcloud shafts` 报告用): 库那条 `AtmosphereShadowLength` 真的有值吗?
   *
   * 判据的由来: 库在 `updateAtmosphereComposition()` 里写
   *   `_atmosphereShadowLength = shadowLengthBuffer != null ? {map: shadowLengthBuffer} : null`
   * 而 `shadowLengthBuffer` 只有 lightShafts 打开时才存在(见上面 LightShaftParams 的注释)
   * ⇒ **lightShafts=true 时这里必须非 null**, 否则说明 render target 没重建成功。
   */
  getLightShaftInfo(): {
    lightShafts: boolean;
    haze: boolean;
    atmosphereShadowLength: boolean;
    shadowLengthBuffer: boolean;
    hazeDensityScale: number;
    hazeExponent: number;
    samples: number;
    maxRayM: number;
    tailScale: number;
    temporalUpscale: boolean;
  } {
    const eff = this.effect as unknown as {
      atmosphereShadowLength: unknown;
      clouds: Record<string, number>;
      shadow: Record<string, number>;
    };
    const c = eff.clouds ?? {};
    const sh = eff.shadow ?? {};
    let buf = false;
    try {
      buf = !!(this.effect as unknown as { cloudsPass?: { shadowLengthBuffer?: unknown } })
        .cloudsPass?.shadowLengthBuffer;
    } catch { /* ignore */ }
    return {
      lightShafts: this.effect.lightShafts,
      haze: this.effect.haze,
      atmosphereShadowLength: !!eff.atmosphereShadowLength,
      shadowLengthBuffer: buf,
      hazeDensityScale: typeof c.hazeDensityScale === 'number' ? c.hazeDensityScale : -1,
      hazeExponent: typeof c.hazeExponent === 'number' ? c.hazeExponent : -1,
      samples: typeof c.maxShadowLengthIterationCount === 'number' ? c.maxShadowLengthIterationCount : -1,
      maxRayM: typeof c.maxShadowLengthRayDistance === 'number' ? c.maxShadowLengthRayDistance : -1,
      tailScale: typeof sh.opticalDepthTailScale === 'number' ? sh.opticalDepthTailScale : -1,
      temporalUpscale: this.effect.temporalUpscale,
    };
  }

  /** 取 shadowLength 缓冲(给"天空光柱"补层用: 我们自己的大气透视/后处理可以吃它) */
  getShadowLengthBuffer(): THREE.Texture | null {
    try {
      const b = (this.effect as unknown as { cloudsPass?: { shadowLengthBuffer?: THREE.Texture } })
        .cloudsPass?.shadowLengthBuffer;
      return b ?? null;
    } catch { return null; }
  }

  setShapeDetail(on: boolean) { this.effect.shapeDetail = on; }
  setTurbulence(on: boolean) { this.effect.turbulence = on; }
  setHaze(on: boolean) { this.effect.haze = on; }
  setComposite(on: boolean) { this.compositeOn = !!on; }
  getComposite(): boolean { return this.compositeOn; }

  /**
   * 云的整体增益(辐射尺度对齐)。
   *
   * === 为什么需要它 (实测: 云画出来了但**又暗又脏**) ==============================
   * 库算的是**物理量级的辐射**: 它的日照来自 `solar_irradiance`(真实太阳常数),
   * 云输出的绝对值与它自己的大气天空是一套单位。而本项目的画面亮度是 Phase A 的
   * `skybound.atmoExp`(radianceScale)标定过的 ⇒ 两边差一个标量, 云会明显偏暗/偏亮。
   * 与其去改库的物理参数(会把云的相对明暗关系也改坏), 不如在**我们自己的合成**里乘一个
   * 标量做对齐 —— 它只影响云的绝对亮度, 不动云的形状/相对明暗。
   *
   * ⚠ Phase B 之后**不要直接调这个**: 用 `setBaseGain` —— 实际增益由它派生成
   * `baseGain × radianceScale/8`, 这样 `atmo exp` 改天空时云跟着走(同一份曝光)。
   */
  setGain(v: number) { this.compMat.uniforms.uCloudsGain.value = v; }
  getGain(): number { return this.compMat.uniforms.uCloudsGain.value as number; }

  /** 设置标定基准增益(现场旋钮 `skybound.cloudsGain`), 实际增益 = 基准 × radianceScale/8 */
  setBaseGain(v: number) { this.baseGain = v; this.applyAtmoGain(); }
  getBaseGain(): number { return this.baseGain; }

  /**
   * 时域上采样(1/16 的像素真正步进, 靠重投影补帧 —— UE 用的就是这招)。
   * **需要 STBN 贴图**: 传进来之前不要开, 否则抖动为 0、走样明显。
   *
   * Phase B: STBN 现在是**程序化生成**的(`clouds-stbn.ts`, void-and-cluster,
   * 64×64×64 R8, 零资产零体积开销)。所以显式指定贴图这件事变成了可选:
   * 不传就自动用程序化那张(第一次调用时生成, 约几十 ms)。
   */
  setTemporalUpscale(on: boolean, stbn: THREE.Data3DTexture | null = null) {
    if (stbn) { this.stbn = stbn; this.effect.stbnTexture = stbn; }
    if (on && !this.stbn) {
      try {
        const { createSTBN } = requireSTBN();
        this.stbn = createSTBN();
        this.effect.stbnTexture = this.stbn;
        this.temporalAttempted = true;
      } catch (err) {
        console.warn('[clouds] STBN 生成失败, 时域上采样保持关闭:', err);
      }
    }
    const want = !!on && !!this.stbn;
    this.effect.temporalUpscale = want;
    if (want && this.lastDepthTexture) {
      // 打开时域上采样后库会按 1/4 mip 采样, 让材质重编译一次拿新 define
      this.patchLibraryShaders();
    }
    return want;
  }
  /**
   * 云层高度自检(探针 / `vcloud` 报告用): 直接读**着色器真正用的**那三个值。
   *
   * 为什么必须有这一项 —— `clouds.frag::getRayNearFar()` 按 `cameraHeight` 与
   * `minHeight/maxHeight` 分三档(层下/层内/层上), 三档的光线起止点**完全不同**:
   *   · 层下: 光线打到地面球 ⇒ `nearFar=(-1)` ⇒ **整段 march 被跳过**(低空看不到云);
   *           不打地面时才用球壳弦(`second.y..second.z`);
   *   · 层内: `nearFar=(cameraNear, …)` ⇒ 从相机起算(云"突然出现"的观感来源);
   *   · 层上: `nearFar=(first.z, second.z)` ⇒ 纯球壳弦长 ⇒ 掠射时上百 km(与 engine 的
   *           视锥上界叠加 ⇒ 变卡; engine 那侧已改成球壳求交上界)。
   * 而这两个值**分属两套坐标**: `cameraHeight` 由库每帧从相机 ECEF 算(JS), 层的
   * `min/maxHeight` 是配置 + `bottomRadius`。当年世界半径摆错(用 bottomRadius 而非椭球 a)
   * 就使 `cameraHeight` 恒为负 ⇒ 永远落在"层下"档, 症状与"低空没有云"一致
   * (见 `setWorldFrame()` 的注释)。所以把两边一起打出来, 差值一眼可见。
   */
  heightReport(): {
    cameraHeight: number;
    minHeight: number;
    maxHeight: number;
    worldRadius: number;
    branch: 'below' | 'inside' | 'above' | 'unknown';
  } | null {
    const eff = this.effect as unknown as {
      cloudsMaterial?: { uniforms?: Record<string, { value?: unknown }> };
      material?: { uniforms?: Record<string, { value?: unknown }> };
    };
    const u = eff?.cloudsMaterial?.uniforms ?? eff?.material?.uniforms;
    const num = (k: string): number | null => {
      const v = u?.[k]?.value;
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };
    const ch = num('cameraHeight');
    const lo = num('minHeight');
    const hi = num('maxHeight');
    if (ch === null || lo === null || hi === null) return null;
    return {
      cameraHeight: ch, minHeight: lo, maxHeight: hi,
      worldRadius: this._worldRadius ?? 0,
      branch: ch < lo ? 'below' : ch < hi ? 'inside' : 'above',
    };
  }

  /** 程序化 STBN 是否可用(探针/report 用) */
  hasSTBN(): boolean { return !!this.stbn; }

  /**
   * 世界 → ECEF 的摆放: 把本地平面世界贴在地球赤道表面(世界 (0,0,0) → ECEF (0, R, 0))。
   *
   * === ⚠ 半径必须是**椭球赤道半径 a**(WGS84 = 6378137), 不是 bottomRadius(6360000) =====
   * 这是 Phase C 抓到的一个**Phase 0 集成 bug**(§265 当年按"着色器用 length(ECEF) −
   * bottomRadius 算高度"就取了 bottomRadius, 漏了库在每个片元里还加了一项):
   *
   *     vec3 cameraPosition = vCameraPosition + altitudeCorrection;      // clouds.frag:833
   *     raySphereIntersections(cameraPosition, rd, bottomRadius + vec4(0, minHeight, …))
   *
   * `altitudeCorrection` = `−ellipsoid.getOsculatingSphereCenter(surface, bottomRadius)`,
   * 实测 (0, **−18137**, −13.9) —— 也就是"半径 bottomRadius 的拟合球球心"比椭球球心高
   * 18137m(a − bottomRadius)。于是:
   *   · 用 bottomRadius 摆世界 ⇒ 着色器里的位置比真实高度**低 18137m**;
   *   · 而云层半径是 `bottomRadius + 层高度`(没有跟着修正)⇒ **云在世界坐标里比配置高度高 18137m**。
   * 实测(相机高度扫描截图): 配置 4600~6462m 的云带实际渲染在 **22737~24599m**;
   * 同时 JS 侧那个 `cameraHeight`(= `Ellipsoid.setFromECEF(ECEF).height`, 用 WGS84 椭球)
   * 也是 `世界高度 − 18137` ⇒ 在大气层内**恒为负**。
   * 后果(两个都是真 bug, 不是一个 bug 的两个说法):
   *   ① 玩法高度对不上 —— 引擎的穿云气流/扰动按 4600~6500m 判定, 而眼睛看到的云在 22km;
   *   ② 库的**霾(`approximateHaze`)被整段关掉** —— 它的第一行就是
   *      `if (cameraHeight * modulation < 0.0) return vec4(0.0);`
   *      而 cameraHeight 恒负 ⇒ 霾恒为 0 ⇒ **云隙光柱(丁达尔)也恒为 0**(光柱就长在霾里)。
   *
   * 用**椭球赤道半径**摆世界后, 两个坐标系同时对上:
   *   着色器 r − bottomRadius = 世界高度 ✓, JS cameraHeight = 世界高度 ✓,
   *   云层半径 bottomRadius + 层高度 也正好落在世界高度 = 层高度 ✓。
   * (`ecefToWorldMatrix` 与 `altitudeCorrection` 仍由库在 update 内部自行求逆/推导, 这里只设
   *  worldToECEFMatrix 一个 —— 见 shared.js:3535-3543。)
   */
  setWorldFrame() {
    const R = this.worldRadius();
    this.effect.worldToECEFMatrix.makeTranslation(0, R, 0);
    this._worldRadius = R;
  }
  /** 实际用的世界球心半径(探针/报告用) */
  getWorldRadius(): number { return this._worldRadius; }

  /**
   * 世界半径 = 云材质那个椭球的赤道半径(WGS84 a = 6378137)。
   * 直接读材质的 `ellipsoid.radii.x`(库默认 `Ellipsoid.WGS84`), 读不到才退回
   * `bottomRadius + 18137`(18137 = WGS84 的 a − bottomRadius, 与库实测的
   * altitudeCorrection.y 一致)。**不要**退回 bottomRadius —— 那正是上面那个 bug。
   */
  private worldRadius(): number {
    const bc = AtmosphereParameters.DEFAULT.bottomRadius;      // 6360000
    const WGS84_A = 6378137;                                   // a, 与库 Ellipsoid.WGS84 一致
    try {
      const e = (this.effect as unknown as { ellipsoid?: { radii?: { x?: number } } }).ellipsoid;
      const a = e?.radii?.x;
      if (typeof a === 'number' && Number.isFinite(a) && a > bc) return a;
    } catch { /* ignore */ }
    return WGS84_A;
  }
  private _worldRadius = 0;

  setSize(width: number, height: number) {
    this.effect.setSize(width, height);
    this.patchLibraryShaders();
  }

  getEffect(): CloudsEffect { return this.effect; }
  hadClouds(): boolean { return this.lastHadClouds; }
  getCloudsTexture(): THREE.Texture | null {
    const v = this.effect.uniforms.get('cloudsBuffer')?.value;
    return (v as THREE.Texture | null) ?? null;
  }

  // === Phase D: 风(速度场) =====================================================
  /**
   * 每帧把三个速度场设成 `参考风速 × skybound.cloudWind`(**每帧读**, 改完立刻生效)。
   *
   * 默认 0 ⇒ 三个速度场恒为零向量 ⇒ 库那三行 `offset.add(velocity × dt)` 不再推进
   * ⇒ 云在世界空间逐帧不变(用户要的"静止在那里")。1 ⇒ 参考风速(见文件头 ④)。
   *
   * 为什么是"覆盖"而不是"乘一个已有值": 库/项目本来就没有速度来源(见文件头 ②),
   * 乘 0 还是 0, 旋钮就没有意义; 覆盖式写入让 `cloudWind` 成为唯一权威, A/B 也可复现。
   */
  private applyWind(): void {
    const kv = readTuning('skybound.cloudWind', 0, 0, 1);
    const eff = this.effect;
    eff.localWeatherVelocity.copy(WIND_REF_LOCAL_WEATHER).multiplyScalar(kv);
    eff.shapeVelocity.copy(WIND_REF_SHAPE).multiplyScalar(kv);
    eff.shapeDetailVelocity.copy(WIND_REF_SHAPE_DETAIL).multiplyScalar(kv);
  }

  /** 当前风速系数(探针/报告用) */
  getWindScale(): number { return readTuning('skybound.cloudWind', 0, 0, 1); }
  /** 当前三个速度场的实际值(探针用; 全 0 = 静止) */
  getWindInfo(): {
    kv: number;
    localWeather: [number, number];
    shape: [number, number, number];
    shapeDetail: [number, number, number];
  } {
    const e = this.effect;
    return {
      kv: this.getWindScale(),
      localWeather: [e.localWeatherVelocity.x, e.localWeatherVelocity.y],
      shape: [e.shapeVelocity.x, e.shapeVelocity.y, e.shapeVelocity.z],
      shapeDetail: [e.shapeDetailVelocity.x, e.shapeDetailVelocity.y, e.shapeDetailVelocity.z],
    };
  }

  // === §316 单帧空间滤波(摆脱时域历史) 的旋钮 =================================
  /**
   * 每帧读。语义:
   *   · `skybound.cloudSpatial`(默认 **on**): 云的颜色/不透明度**不再用解析出来的历史图**,
   *     而是拿**本帧的 1/4 边长 march 缓冲**做双边上采样+去噪 ⇒ 结构上没有历史参与,
   *     不可能有拖影/鬼影(库的时域路径自己承认 "This increases ghosting, of course")。
   *   · `cloudSpatialTaps` 4|5|9(默认 9): 4 = 十字、5 = 十字+中、9 = 3x3。
   *   · `cloudSpatialSpread`(1..2.5): 采样半径(texel)。比"再加一圈抽头"更省 ——
   *     **总抽取数不变**(仍 9 次), 只是核更宽 ⇒ 压得更狠也更软。
   *   · `cloudSpatialRange`(深度灵敏度, 米)、`cloudSpatialSharp`(亮度/不透明度灵敏度):
   *     越小越"敢跨边缘混合"(更软), 越大越保边(更锐但可能留颗粒)。
   */
  private applySpatialTuning(): void {
    const u = this.compMat.uniforms;
    const on = this.lsFlag('skybound.cloudSpatial', true);
    this.spatialOn = on;
    u.uSpatial.value = on ? 1 : 0;
    u.uSpatialTaps.value = readTuning('skybound.cloudSpatialTaps', 9, 4, 9);
    u.uSpatialSpread.value = readTuning('skybound.cloudSpatialSpread', 1, 1, 2.5);
    u.uSpatialRange.value = readTuning('skybound.cloudSpatialRange', 900, 20, 20000);
    u.uSpatialSharp.value = readTuning('skybound.cloudSpatialSharp', 0.12, 0.005, 2);
    // §320: 噪点三件套的现场旋钮(每帧读)
    u.uSpatialClampK.value = readTuning('skybound.cloudSpatialClamp', 2.5, 0, 8);   // 0 = 关离群钳制
    u.uSpatialFarK.value = readTuning('skybound.cloudSpatialFar', 2.0, 0, 4);       // <=1 = 不加环
    u.uSpatialFarM.value = readTuning('skybound.cloudSpatialFarM', 6000, 500, 60000);
    u.uSpatialSoft.value = readTuning('skybound.cloudSpatialSoft', 0, 0, 1);   // 0 = 不涂抹
  }

  /** 本帧的**原始 march 缓冲**(1/4 边长; 空间路径的数据源 —— 未经任何历史处理) */
  private rawMarchTexture(): THREE.Texture | null {
    const cp = (this.effect as unknown as {
      cloudsPass?: { currentRenderTarget?: THREE.WebGLRenderTarget };
    }).cloudsPass;
    return cp?.currentRenderTarget?.texture ?? null;
  }

  /**
   * §324: 云 pass 的**内部阶段**清单(给游戏内 `gpup cloud` 用)。
   *
   * 为什么单列: WebGL2 **禁止嵌套计时查询** —— 不能同时包装 composer 的 pass 和它的内部
   * (实测: 内层失效, 而外层读数会一起被污染)。所以这是**替代**模式: `gpup cloud` 时只包这些,
   * 得到"云 pass 的细分"(BSM 级联拟合/BSM 渲染/主 march+resolve/四个程序化纹理烘焙)。
   * 顺序 = 实际调用顺序, 便于看"谁是大头"。
   */
  profilerStages(): Array<{ label: string; obj: Record<string, unknown>; key: string }> {
    const eff = this.effect as unknown as Record<string, unknown>;
    const out: Array<{ label: string; obj: Record<string, unknown>; key: string }> = [];
    const push = (label: string, obj: unknown, key: string) => {
      const o = obj as Record<string, unknown> | undefined;
      if (o && typeof o[key] === 'function') out.push({ label, obj: o, key });
    };
    push('·云BSM 级联拟合', eff.shadowMaps, 'update');
    push('·云BSM 渲染', eff.shadowPass, 'update');
    push('·主march+resolve', eff.cloudsPass, 'update');
    push('·纹理 天气', eff.proceduralLocalWeather, 'render');
    push('·纹理 形状', eff.proceduralShape, 'render');
    push('·纹理 形状细节', eff.proceduralShapeDetail, 'render');
    push('·纹理 湍流', eff.proceduralTurbulence, 'render');
    return out;
  }

  /** 空间路径的现场读数(报告/探针用) */
  getSpatialInfo(): Record<string, unknown> {
    const u = this.compMat.uniforms;
    const raw = this.rawMarchTexture();
    const cp = (this.effect as unknown as {
      cloudsPass?: { currentRenderTarget?: THREE.WebGLRenderTarget };
    }).cloudsPass;
    return {
      on: this.spatialOn,
      taps: u.uSpatialTaps.value,
      spread: +Number(u.uSpatialSpread.value).toFixed(2),
      range: u.uSpatialRange.value,
      sharp: u.uSpatialSharp.value,
      clamp: u.uSpatialClampK.value,
      far: u.uSpatialFarK.value,
      farM: u.uSpatialFarM.value,
      soft: u.uSpatialSoft.value,
      staticJitter: this.staticJitterApplied,
      source: this.spatialOn ? 'raw-march(1/4)' : 'resolved(temporal)',
      rawSize: raw && cp?.currentRenderTarget
        ? [cp.currentRenderTarget.width, cp.currentRenderTarget.height] : null,
      hasDepth: !!u.uDepth.value,
      samplers: 4,   // scene / clouds / depth (+ 无: 云前深度暂未用)
    };
  }

  /**
   * === §316 源头治理: 把"每帧换切片"的 STBN 抖动改成**静态**抖动 ================
   *
   * 库的 `getSTBN()`(`clouds.glsl` 里那段)是:
   *     texture(stbnTexture, vec3(gl_FragCoord.xy, float(frame % size.z)))   // ← 每帧换一层
   * 于是**即使世界完全静止**, 噪声图案也每帧不同 ⇒ 屏幕上的"沸腾/闪烁"。
   * 时域累积能把这种噪声平均掉, 但代价是拖影。
   *
   * 空间路线(AC7 那条)反过来做: **让抖动固定下来**, 噪声就变成一张**静态图案** ——
   * 静态图案用单帧双边滤波能干干净净地吃掉; 动画噪声则无论如何都会留下来。
   * 这里用经典的 interleaved gradient noise(**自包含写法**, 不依赖库里的 include 顺序),
   * 只吃 gl_FragCoord ⇒ 固定、非平铺(不像 STBN 那样每 64 像素重复)。
   *
   * 幂等: 已打过补丁的材质直接跳过(比对标记串)。锚点找不到时**只 warn 一次**并把材质
   * 留在原状(getSTBN 仍有定义 ⇒ 不会出现"未定义函数"的编译失败)。
   */
  private patchStaticJitter(): void {
    // ⚠ 默认**跟随空间路径**: 静态抖动只有配上单帧空间滤波才有意义。
    //   实测(_cloudspatial-ab): 静态抖动 + **时域**路径反而更差(静止帧间差 0.0191 → 0.0258)——
    //   因为时域 resolve 的方差裁剪假设"噪声逐帧独立", 抖动固定后历史会锁住同一张图案。
    //   所以 spatial 关掉时, 除非显式写 `cloudStaticJitter=on`, 否则不动库的逐帧抖动。
    const want = this.lsFlag('skybound.cloudStaticJitter', this.spatialOn);
    const eff = this.effect as unknown as {
      cloudsPass?: { currentMaterial?: THREE.Material };
      shadowPass?: { currentMaterial?: THREE.Material };
    };
    const targets: Array<[string, THREE.Material | undefined]> = [
      ['clouds', eff.cloudsPass?.currentMaterial],
      ['shadow', eff.shadowPass?.currentMaterial],
    ];
    for (const [name, mat] of targets) {
      const m = mat as unknown as { fragmentShader?: string } | undefined;
      if (!m || typeof m.fragmentShader !== 'string') continue;
      const src = m.fragmentShader;
      const hasMarker = src.includes('STATIC_JITTER');
      if (!want) {
        if (hasMarker) { this.restoreJitter(name, m as { fragmentShader: string }); }
        continue;
      }
      if (hasMarker) continue;                       // 已打(幂等)
      const patched = injectStaticJitter(src);
      if (!patched.ok) {
        if (!this._jitterWarned) {
          this._jitterWarned = true;
          console.warn(`[clouds] 静态抖动补丁未应用(${name}): ${patched.reason}`);
        }
        continue;
      }
      (m as { fragmentShader: string }).fragmentShader = patched.src;
      (mat as THREE.Material).needsUpdate = true;
      this.staticJitterApplied = true;
      console.info(`[clouds] 静态抖动已应用(${name}): getSTBN 改为固定图案(降"沸腾"的源头)`);
    }
    // 光有 STBN 静态还不够: 库的 `temporalJitter`(Bayer-16)每帧都在动投影矩阵与 Vogel 旋转
    // ⇒ march 结果**仍然**逐帧不同(实测: 只打 STBN 补丁时, 静止世界的帧间差和动画抖动一样)。
    this.neutralizeTemporalJitter();
  }

  /**
   * 把库每帧算出来的 `temporalJitter` **中和掉**(投影抖动 + Vogel 旋转):
   * `copyCameraSettings()` 里 `inverseProjectionMatrix.elements[8/9] += dx*2` 是 CPU 侧改的,
   * 所以只改 shader 不够 —— 这里包一层: 原调用照做, 之后把 jitter 置 0 并用**未抖动的**
   * 投影矩阵重算一次逆矩阵。于是"相机不动 + 世界暂停"时, march 的**输入完全相同** ⇒
   * 输出逐帧相同(空间滤波的噪声才有机会被干净地吃掉)。
   * 幂等: 已经包过就跳过。退路: `cloudStaticJitter=off` 时不包(保持库的逐帧抖动)。
   */
  private neutralizeTemporalJitter(): void {
    if (!this.staticJitterApplied) return;   // 只在静态档生效
    const cp = (this.effect as unknown as {
      cloudsPass?: {
        currentMaterial?: THREE.Material & {
          copyCameraSettings?: (...a: unknown[]) => void;
          __jitterWrapped?: boolean;
          uniforms?: Record<string, { value: unknown }>;
        };
      };
    }).cloudsPass;
    const mat = cp?.currentMaterial;
    if (!mat || typeof mat.copyCameraSettings !== 'function' || mat.__jitterWrapped) return;
    const orig = mat.copyCameraSettings.bind(mat);
    const self = this;
    mat.copyCameraSettings = function (...args: unknown[]) {
      orig(...args);
      try {
        const u = mat.uniforms;
        const tj = u?.temporalJitter as { value?: THREE.Vector2 } | undefined;
        if (tj?.value && typeof (tj.value as THREE.Vector2).setScalar === 'function') {
          (tj.value as THREE.Vector2).setScalar(0);
        }
        const ipm = u?.inverseProjectionMatrix as { value?: THREE.Matrix4 } | undefined;
        const cam = args[0] as THREE.PerspectiveCamera | undefined;
        if (ipm?.value && cam?.projectionMatrix) {
          // 用未抖动的投影矩阵重算(原函数是先 copy 再改 elements[8/9] 再求逆)
          (ipm.value as THREE.Matrix4).copy(cam.projectionMatrix).invert();
        }
      } catch (err) {
        if (!self._jitterWarned) {
          self._jitterWarned = true;
          console.warn('[clouds] temporalJitter 中和失败(保留库的逐帧抖动):', err);
        }
      }
    };
    mat.__jitterWrapped = true;
    console.info('[clouds] 已中和 temporalJitter(投影抖动 + Vogel 旋转) ⇒ 静止时 march 输入逐帧相同');
  }
  /** 静态抖动是否已生效(补丁成功过; 报告/探针用) */
  private staticJitterApplied = false;
  /** §316 空间路径是否生效(默认开; `skybound.cloudSpatial='off'` 回到时域解析图) */
  private spatialOn = true;

  /** 布尔型 localStorage 开关(键不存在 = def; 只认 'off'/'0'/'false' 为关) */
  private lsFlag(key: string, def: boolean): boolean {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null || raw.trim() === '') return def;
      const v = raw.trim().toLowerCase();
      if (v === 'off' || v === '0' || v === 'false') return false;
      if (v === 'on' || v === '1' || v === 'true') return true;
      return def;
    } catch {
      return def;
    }
  }
  private _jitterWarned = false;
  /** 把静态抖动还原成库原文(退路用) */
  private restoreJitter(name: string, m: { fragmentShader: string }): void {
    const p = restoreStaticJitter(m.fragmentShader);
    if (!p.ok) return;
    m.fragmentShader = p.src;
    this.staticJitterApplied = false;
    console.info(`[clouds] 静态抖动已还原(${name}): 回到库的按帧换切片`);
  }


  /**
   * 每帧读 `skybound.cloudTVarGamma` / `skybound.cloudTAlpha` 写进 resolve 材质。
   *
   * 只写 **uniform 的 value**(标量), 不碰 defines ⇒ 不会触发材质重编译(每帧写也不抖)。
   * 材质引用变了(库在质量档/尺寸变化时可能重建)会自动重新写。
   * 见文件头 ⑤: 实测 **gamma 越紧(越小)越稳**, 所以默认 1(库 2)。
   *
   * 顺便给出**内部分辨率**旋钮 `skybound.cloudResScale`(**默认不设**; 区间 0.25..1):
   * 空间颗粒的根因是"云 pass 只渲 1/res 边长", 调大能真正变细, 但**代价线性上升**
   * (像素数 ∝ scale²), 所以只作为备用杠杆, 默认不动; 改它要重建 render target
   * ⇒ 变更时补一次 patchDepthChunks(幂等)。
   * ⚠ 注意"不设"时的**实际生效值是 1**(不是构造里那个 0.5): 构造传 0.5 之后
   *   `setQuality('medium')` 的预设会把 `resolutionScale` 覆盖成 1(实测 probe 读数),
   *   此时时域上采样让云 pass 内部只渲 1/4 边长(320×180)。
   */
  private applyTemporalTuning(): void {
    // ⚠ 默认值给 **1**(而不是"不设就不管"): `vcloud res 0.5` 之后再 `vcloud reset` 会**删掉键**,
    //   若默认是 -1 就会"键没了但内部还停在 0.5" —— 那 reset 就没真复位(实测踩到)。
    //   1 = medium 档的生效值(= 内部再按 1/4 边长跑 march), 也是构造+preset 之后的初始态,
    //   所以正常启动时这里比较下来相等 ⇒ 不会白重建 render target。
    // §322: 上限 1 -> 3(见 engine 的 vcloud res 分支说明); 三处夹取必须一致, 否则写了不生效
    // §330: 默认 0.4(=实测省的那套)。[!] 陷阱守卫: `tup off` 时 march 分辨率 = base x res,
    //   若 res 仍给 1 就是**全画布 march**(§316 实测 141ms/帧的那个坑) ⇒ 关掉时域上采样时
    //   一律把 res 夹到 <=0.5 并在控制台提示一次。
    // [!] 必须与引擎自己的判据一致(, 即**键不存在 = 开**); 我第一版写成
    //   lsFlag(key,false) ⇒ 键不存在时也判成"关了" ⇒ 把 res 误夹到 0.5(实测 march 239x120)。
    const tupOff = (() => { try { return window.localStorage.getItem('skybound.cloudTemporal') === 'off'; } catch { return false; } })();
    // 默认 1.6: 时域上采样把 march 再除 4 ⇒ 1.6 在 1912 宽上给 765x382(与 §329 实测省的那套同尺寸)。
    // (res=1 时只有 478x239; 0.4 只有 192x96 —— 那种会明显糊, 所以默认给 1.6)
    const rsWanted = readTuning('skybound.cloudResScale', 1.6, 0.25, 3);
    const rs = tupOff ? Math.min(rsWanted, 0.5) : rsWanted;
    if (tupOff && rsWanted > 0.5 && !this._resClampWarned) {
      this._resClampWarned = true;
      console.warn(`[clouds] 时域上采样关闭时 march 分辨率按比例直乘屏幕 ⇒ res=${rsWanted} 会变成全画布 march(141ms/帧的坑), 已夹到 ${rs}`);
    }
    if (Math.abs(this.effect.resolutionScale - rs) > 0.005) {
      this.effect.resolutionScale = rs;
      this.patchLibraryShaders();
    }
    const mat = (this.effect as unknown as {
      cloudsPass?: { resolveMaterial?: THREE.Material };
    }).cloudsPass?.resolveMaterial as
      | (THREE.Material & { uniforms?: Record<string, { value?: unknown }> })
      | undefined;
    const u = mat?.uniforms;
    if (!u) return;
    const gamma = readTuning('skybound.cloudTVarGamma', 1, 0.25, 8);
    const alpha = readTuning('skybound.cloudTAlpha', 0.05, 0.01, 0.5);
    const g = u.varianceGamma;
    if (g && typeof g.value === 'number' && Math.abs(g.value - gamma) > 1e-6) g.value = gamma;
    const a = u.temporalAlpha;
    if (a && typeof a.value === 'number' && Math.abs(a.value - alpha) > 1e-6) a.value = alpha;
  }

  /**
   * === per user request: 控制台现场改完"pass 侧"旋钮, 立刻生效(不等下一帧) ==========
   *
   * 为什么需要: 关卡内控制台一开就 `debugPaused=true`, 引擎 loop 提前 return ⇒
   * `render()` 里的 `applyWind/applyTemporalTuning/applyCover3D` 都不会跑,
   * 于是"控制台里改了 `skybound.cloudWind` / `cloudResScale` / `cloudTVarGamma`, 画面却不动",
   * 必须关掉控制台才生效。这个方法把它们同步跑一遍(三处都幂等, 每帧再跑一次也无害)。
   */
  /**
   * §330 门控发布的"档位"(null = 正常)。字段语义见 applyInternals 里的用法。
   * 为什么由引擎"发布档位"而不是直接写库对象: 迭代数必须**只有一个写者**, 否则每帧两个写者抢,
   * 谁后写谁赢 —— 实测门控就是这么被覆盖掉的(march 8.17ms 的空天)。
   */
  private iterClass: {
    mult: number; floor: number;
    sunFloor?: number; groundFloor?: number;
    shadowLenMult?: number; shadowLenFloor?: number;
  } | null = null;

  /** 引擎的门控每帧调这个(代替过去直接写 clouds.maxIterationCount) */
  setIterClass(cls: {
    mult: number; floor: number;
    sunFloor?: number; groundFloor?: number;
    shadowLenMult?: number; shadowLenFloor?: number;
  } | null): void { this.iterClass = cls; }

  getIterClass(): { mult: number; floor: number } | null { return this.iterClass; }

  applySideTuningNow(): void {
    try {
      this.applyCover3D();
      this.applyWind();
      this.applyTemporalTuning();
      this.applyInternals();
      this.applySpatialTuning();   // §316 空间滤波旋钮(现场改完立刻可见)
      this.patchStaticJitter();    // §316 静态抖动开关(开/关都要重编译一次)
    } catch (err) {
      console.warn('[clouds] 现场应用 side 旋钮失败(保持上一状态):', err);
    }
  }

  /**
   * === 库"内部性能开关"的现场旋钮(每帧读; 值不变就不写 => 幂等) =====================
   *
   * 这些才是**真正决定云 pass 成本**的东西(库的 `CloudsEffect.clouds` / effect 级布尔)。
   * 现场:`vcloud steps <n>` / `vcloud sdetail on|off` / …(见 engine 的 CLOUD_INTERNAL 表)。
   *
   * ⚠ 与"质量档"的关系: 库的 `qualityPreset` 是个**只有 setter 没有 getter** 的访问器
   *   (`set qualityPreset(e) { Object.assign(this, ft[e]) … }`), 所以 `eff.qualityPreset`
   *   读回来**永远是 undefined** —— 我第一版据此误判"档位没生效", 实际是生效的, 只是读不到。
   *   这里的旋钮**优先级高于档位**(档位先写, 我们再每帧覆写), 所以两者可以混用:
   *   先 `vcloud med` 拿一套基线, 再用 `vcloud steps 150` 单独压步数。
   */
  applyInternals(): void {
    const eff = this.effect as unknown as {
      clouds: Record<string, unknown>;
      shapeDetail?: boolean;
      turbulence?: boolean;
      haze?: boolean;
    };
    const c = eff.clouds;
    if (!c) return;
    // 数值旋钮: 键不存在(readTuning 回 -1) => 不动(保持档位给的值)
    const num = (key: string, lo: number, hi: number): number | undefined => {
      const v = readTuning(key, -1, lo, hi);
      return v < 0 ? undefined : v;
    };
    // 布尔旋钮: -1 = 键不存在(不动) / 0 = off / 1 = on
    const flag = (key: string): boolean | undefined => {
      const v = readTuning(key, -1, 0, 1);
      return v < 0 ? undefined : v >= 0.5;
    };
    const setN = (obj: Record<string, unknown>, k: string, v: number | undefined) => {
      if (v !== undefined && obj[k] !== v) obj[k] = v;
    };
    const setB = (k: keyof typeof eff, v: boolean | undefined) => {
      if (v !== undefined && eff[k] !== v) (eff as Record<string, unknown>)[k as string] = v;
    };

    // === §330 迭代数的**唯一写者** =================================================
    // 门控(引擎)只发布档位, 这里每帧按档位算并写入。否则[门控压到 2]会被本函数在**同一帧更晚**
    // 按 `skybound.cloudSteps` 写回 130 —— 实测就是这么把门控废掉的(march 8.17ms 的空天)。
    const wantSteps = num('skybound.cloudSteps', 20, 2000);
    const cls = this.iterClass;
    if (cls) {
      // 基准: 优先用户键值, 没有就用库当前值(库自己档位给的)
      const b = wantSteps !== undefined ? wantSteps : (typeof c.maxIterationCount === 'number' ? c.maxIterationCount : 500);
      const bSun = (() => { const v = num('skybound.cloudSunSteps', 0, 8); return v !== undefined ? v : (typeof c.maxIterationCountToSun === 'number' ? c.maxIterationCountToSun : 2); })();
      const bGnd = (() => { const v = num('skybound.cloudGroundSteps', 0, 8); return v !== undefined ? v : (typeof c.maxIterationCountToGround === 'number' ? c.maxIterationCountToGround : 1); })();
      const rs = (v: number, mult: number, floor: number) => Math.max(floor, Math.min(v, Math.round(v * mult)));
      c.maxIterationCount = rs(b, cls.mult, cls.floor);
      c.maxIterationCountToSun = Math.max(cls.sunFloor ?? 0, Math.min(bSun, Math.round(bSun * cls.mult)));
      c.maxIterationCountToGround = cls.groundFloor ?? 0;
      // 阴影长度(云隙光柱那条次级 march): 默认 96/112 步, 空天里纯浪费 —— 档位里一起压。
      if (cls.shadowLenMult !== undefined) {
        const bSh = typeof c.maxShadowLengthIterationCount === 'number' ? c.maxShadowLengthIterationCount : 96;
        const wantSh = num('skybound.cloudShadowLenSteps', 1, 500);
        const baseSh = wantSh !== undefined ? wantSh : bSh;
        c.maxShadowLengthIterationCount = Math.max(cls.shadowLenFloor ?? 1, Math.min(baseSh, Math.round(baseSh * cls.shadowLenMult)));
      }
    } else {
    setN(c, 'maxIterationCount', wantSteps !== undefined ? wantSteps : 95);   // §330 默认改成实测省的 95(键不存在也写, 否则库停在 500)
    setN(c, 'maxIterationCountToSun', num('skybound.cloudSunSteps', 0, 8));      // 到太阳的次级 march
    setN(c, 'maxIterationCountToGround', num('skybound.cloudGroundSteps', 0, 8)); // 到地面的次级 march
    }
    { const v = num('skybound.cloudMinStep', 10, 500); setN(c, 'minStepSize', v !== undefined ? v : 70); }   // §330 默认 70
    setN(c, 'maxStepSize', num('skybound.cloudMaxStep', 100, 5000));             // 步长上限
    setN(c, 'minTransmittance', num('skybound.cloudMinTrans', 0.001, 0.5));      // 越大越早终止
    setN(c, 'multiScatteringOctaves', num('skybound.cloudOctaves', 1, 8));       // 多次散射阶数
    setB('shapeDetail', flag('skybound.cloudShapeDetail'));                     // 每步 +1 次 3D 采样
    setB('turbulence', flag('skybound.cloudTurb'));
    setB('haze', flag('skybound.cloudHaze'));
    const acc = flag('skybound.cloudAcc');
    if (acc !== undefined && c.accurateSunSkyLight !== acc) c.accurateSunSkyLight = acc;
  }

  /** 内部开关的当前值(报告/探针用) */
  getInternals(): Record<string, number | boolean | null> {
    const eff = this.effect as unknown as {
      clouds?: Record<string, unknown>;
      shapeDetail?: boolean; turbulence?: boolean; haze?: boolean;
    };
    const c = eff.clouds ?? {};
    const n = (k: string) => (typeof c[k] === 'number' ? (c[k] as number) : null);
    const b = (k: string) => (typeof c[k] === 'boolean' ? (c[k] as boolean) : null);
    return {
      maxIterationCount: n('maxIterationCount'),
      maxIterationCountToSun: n('maxIterationCountToSun'),
      maxIterationCountToGround: n('maxIterationCountToGround'),
      minStepSize: n('minStepSize'),
      maxStepSize: n('maxStepSize'),
      minTransmittance: n('minTransmittance'),
      multiScatteringOctaves: n('multiScatteringOctaves'),
      accurateSunSkyLight: b('accurateSunSkyLight'),
      shapeDetail: eff.shapeDetail ?? null,
      turbulence: eff.turbulence ?? null,
      haze: eff.haze ?? null,
      lightShafts: (this.effect as unknown as { lightShafts?: boolean }).lightShafts ?? null,
      maxShadowLengthIterationCount: n('maxShadowLengthIterationCount'),
      maxRayDistance: n('maxRayDistance'),
      resolutionScale: this.effect.resolutionScale,
    };
  }

  /** 当前 resolve 滤波设置(探针/自检用) */
  getResolveTuning(): { varianceGamma: number; temporalAlpha: number } {
    const mat = (this.effect as unknown as {
      cloudsPass?: { resolveMaterial?: THREE.Material };
    }).cloudsPass?.resolveMaterial as
      | (THREE.Material & { uniforms?: Record<string, { value?: unknown }> })
      | undefined;
    const u = mat?.uniforms;
    return {
      varianceGamma: typeof u?.varianceGamma?.value === 'number' ? u.varianceGamma.value : -1,
      temporalAlpha: typeof u?.temporalAlpha?.value === 'number' ? u.temporalAlpha.value : -1,
    };
  }

  /**
   * === §300: 时域 resolve 路径读数 (探针/诊断用) ===============================
   *
   * 用来回答"历史缓冲到底有没有在跨帧复用"这个只有读数能回答的问题。库的时域上采样
   * 路径(`TEMPORAL_UPSCALE`)里每帧:
   *   · `currentFrame`(1/16 的像素, 由 `bayerIndices[x%4][y%4] == frame%16` 决定)直接吃当前帧;
   *   · 其余 15/16 走 `varianceClipping`(把 history 夹进"当前帧 5 邻居"的方差盒里);
   *   · 帧末 `swapBuffers()` 交换 resolve/history 两张 RT, 所以 `outputBuffer` 与
   *     `colorHistoryBuffer` **是同一张纹理**, 而下一帧往另一张写 —— 这是正常的双缓冲,
   *     不是"读写同一张"的 bug(踩过这个误判, 记在这里)。
   *
   * `render()` 里每帧顺手记的四个量(都是属性读, 无分配、无 uniform 写):
   *   frames          我们调 render 的次数
   *   frameAdvances   库 `resolveMaterial.uniforms.frame` 相对上一帧**有没有推进**(库的
   *                   STBN/抖动全靠它, 卡住不动 ⇒ 云会静止在同一个噪声切片上)
   *   historySwaps    history 纹理 uuid 变化次数(= 双缓冲真的在翻转)
   *   histSameStreak  连续多少帧 history 纹理没变(应恒为 1: 每帧都翻)
   */
  temporalDiag(): {
    frames: number;
    frameAdvances: number;
    historySwaps: number;
    histSameStreak: number;
    effectFrame: number;
    resolveFrame: number;
    resolveMaterialUuid: string;
    resolveMaterialVersion: number;
    historyTextureUuid: string;
    historyBufferUuid: string;
    historyIsResolveTarget: boolean;
    colorBufferUuid: string;
    lowRes: [number, number];
    fullRes: [number, number];
    uniform: { varianceGamma: number; temporalAlpha: number; jitter: [number, number]; texel: [number, number] };
    temporalUpscale: boolean;
    stbnAttached: boolean;
    depthVelocityAttached: boolean;
  } {
    const eff = this.effect as unknown as {
      frame?: number;
      cloudsPass?: {
        resolveMaterial?: THREE.Material & { uniforms?: Record<string, { value?: unknown }> };
        currentMaterial?: { uniforms?: Record<string, { value?: unknown }> };
        historyRenderTarget?: THREE.WebGLRenderTarget;
        resolveRenderTarget?: THREE.WebGLRenderTarget;
        currentRenderTarget?: THREE.WebGLRenderTarget;
        temporalUpscale?: boolean;
      };
    };
    const cp = eff.cloudsPass;
    const rm = cp?.resolveMaterial;
    const u = rm?.uniforms;
    const num = (v: unknown): number => (typeof v === 'number' ? v : -1);
    const v2 = (v: unknown): [number, number] => {
      const o = v as { x?: number; y?: number } | undefined;
      return [num(o?.x), num(o?.y)];
    };
    const texUuid = (v: unknown): string => {
      const t = v as { uuid?: string } | undefined;
      return typeof t?.uuid === 'string' ? t.uuid : '';
    };
    return {
      frames: this._frames,
      frameAdvances: this._frameAdvances,
      historySwaps: this._historySwaps,
      histSameStreak: this._histSameStreak,
      effectFrame: num(eff.frame),
      resolveFrame: num(u?.frame?.value),
      resolveMaterialUuid: rm?.uuid ?? '',
      resolveMaterialVersion: num(rm?.version),
      historyTextureUuid: texUuid(cp?.historyRenderTarget?.texture),
      historyBufferUuid: texUuid(u?.colorHistoryBuffer?.value),
      historyIsResolveTarget: cp?.historyRenderTarget === cp?.resolveRenderTarget,
      colorBufferUuid: texUuid(u?.colorBuffer?.value),
      lowRes: cp?.currentRenderTarget ? [cp.currentRenderTarget.width, cp.currentRenderTarget.height] : [0, 0],
      fullRes: cp?.historyRenderTarget ? [cp.historyRenderTarget.width, cp.historyRenderTarget.height] : [0, 0],
      uniform: {
        varianceGamma: num(u?.varianceGamma?.value),
        temporalAlpha: num(u?.temporalAlpha?.value),
        jitter: v2(u?.jitterOffset?.value),
        texel: v2(u?.texelSize?.value),
      },
      temporalUpscale: !!cp?.temporalUpscale,
      stbnAttached: !!cp?.currentMaterial?.uniforms?.stbnTexture?.value,
      depthVelocityAttached: !!u?.depthVelocityBuffer?.value,
    };
  }

  /** 每帧记一次时域路径的身份/推进(便宜: 4 个属性读 + 1 个字符串比较) */
  private trackTemporal(): void {
    this._frames++;
    const cp = (this.effect as unknown as {
      cloudsPass?: {
        resolveMaterial?: { uniforms?: Record<string, { value?: unknown }> };
        historyRenderTarget?: THREE.WebGLRenderTarget;
      };
    }).cloudsPass;
    const f = cp?.resolveMaterial?.uniforms?.frame?.value;
    if (typeof f === 'number') {
      if (f !== this._lastFrame) this._frameAdvances++;
      this._lastFrame = f;
    }
    const uuid = cp?.historyRenderTarget?.texture?.uuid ?? '';
    if (uuid !== this._lastHistUuid) {
      if (this._lastHistUuid) this._historySwaps++;
      this._histSameStreak = 0;
      this._lastHistUuid = uuid;
    } else if (uuid) {
      this._histSameStreak++;
    }
  }

  private _frames = 0;
  private _frameAdvances = 0;
  private _historySwaps = 0;
  private _histSameStreak = 0;
  private _lastFrame = Number.NaN;
  private _lastHistUuid = '';

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ) {
    if (!readBuffer) return;
    this._lastRenderer = renderer;
    if (!this.initialized) {
      this.initialize(renderer, readBuffer.texture.type);
    }
    // === §302 Phase F: 3D 覆盖率(每帧读开关 ⇒ 关掉即回到未打补丁的行为) ==========
    // 必须在 effect.update() **之前**(注入/define 要在材质编译前定下来)。
    // 包 try/catch: 注入失败最多是"回到 2D 覆盖率", 绝不能把 pass 弄崩(会把合成也丢掉)。
    try {
      this.applyCover3D();
    } catch (err) {
      if (!this._cover3dErr) {
        this._cover3dErr = true;
        console.error('[cover3d] 3D 覆盖率开关应用失败(保持未打补丁状态, 不再刷屏):', err);
      }
    }
    // === Phase D: 风 + 时域滤波(每帧, 必须在 effect.update() 之前) ==============
    // 包 try/catch: 旋钮写失败最多是"回到库默认", 绝不能把 pass 弄崩(会把合成也丢掉)。
    try {
      this.applyWind();
      this.applyTemporalTuning();
      this.applyInternals();      // 库内部性能开关(步数/步长/细节布尔), 每帧读 ⇒ 现场即时生效
      this.trackTemporal();       // §300: 时域路径读数(frame 推进 / history 双缓冲翻转)
    } catch (err) {
      if (!this._windErr) {
        this._windErr = true;
        console.error('[clouds] 风/时域旋钮写入失败(回退库默认, 不再刷屏):', err);
      }
    }
    // === Phase B: 云光照(路 A) ================================================
    // 必须在 effect.update() **之前**: LUT 要挂到材质上, 太阳辐照度要先镜像过去。
    // 整段包 try/catch: 光照对不上最多回到"平光云", 绝不能把 pass 弄崩(会把合成也丢掉)。
    try {
      this.ensureAtmoLight(renderer);
      this.applyAtmoGain();
    } catch (err) {
      if (!this._atmoLightErr) {
        this._atmoLightErr = true;
        console.error('[clouds] 云光照对接失败(回退平光, 不再刷屏):', err);
      }
      this.atmoLightOk = false;
    }
    // 深度: 优先进链时挂在 readBuffer 上的 DepthTexture(= composer 的场景深度)。
    // 拿不到就退化成"无遮挡"(云会盖在近景上, 能明显看出来) —— 日志里会警告一次。
    const depth = readBuffer.depthTexture ?? this.lastDepthTexture;
    if (depth) {
      this.effect.setDepthTexture(depth);
      this.lastDepthTexture = depth;
    }

    this.effect.update(renderer, readBuffer, this.dt);
    const cloudsTex = this.getCloudsTexture();
    this.lastHadClouds = !!cloudsTex;

    // === §316 单帧空间滤波: 数据源 + 边缘保护用的深度 ==========================
    // 空间路径读**本帧的 1/4 边长 march 缓冲**(没经过任何历史处理); 时域路径仍旧读解析图。
    // 每帧读旋钮 ⇒ 现场改完立刻可见; 丢一帧失败就退回解析图(绝不黑屏)。
    try {
      this.applySpatialTuning();
    } catch (err) {
      if (!this._spatialErr) {
        this._spatialErr = true;
        console.warn('[clouds] 空间滤波旋钮应用失败(退回时域解析图):', err);
      }
      this.spatialOn = false;
      this.compMat.uniforms.uSpatial.value = 0;
    }
    // ⚠ 着色器**编译失败**既不抛 JS 异常也不报错给调用方(three 只往 console 打一行), 结果是
    //   整个合成 pass 不出图 = **黑屏**。§320 真踩过一次(累加器类型写错), 而且只有"量画面平均
    //   亮度"的探针才发现 ⇒ 这里加一次体检: 程序对象存在但没链上程序 ⇒ 立刻退回时域路径。
    //   (用 program 对象是否存在来避免"第 0 帧还没编译"的误判 —— 那时 program 本身就是 null。)
    {
      const pg = (this.compMat as unknown as { program?: { program?: unknown } | null }).program;
      if (this.spatialOn && pg && pg.program == null && !this._compileWarned) {
        this._compileWarned = true;
        console.warn('[clouds] 合成着色器编译失败 ⇒ 退回时域解析图(检查 compMat 的 GLSL)');
        this.spatialOn = false;
        this.compMat.uniforms.uSpatial.value = 0;
      }
    }
    const rawTex = this.spatialOn ? this.rawMarchTexture() : null;
    const useTex = rawTex ?? cloudsTex;
    const u = this.compMat.uniforms;
    u.uScene.value = readBuffer.texture;
    u.uClouds.value = useTex;
    u.uCloudsOn.value = this.compositeOn && useTex ? 1 : 0;
    if (rawTex) {
      const cp = (this.effect as unknown as {
        cloudsPass?: { currentRenderTarget?: THREE.WebGLRenderTarget };
      }).cloudsPass;
      const w = cp?.currentRenderTarget?.width ?? 1;
      const h = cp?.currentRenderTarget?.height ?? 1;
      (u.uCloudTexel.value as THREE.Vector2).set(1 / Math.max(1, w), 1 / Math.max(1, h));
    }
    // 深度: 优先 composer 场景深度(它已是 sampler2D 口径); uNearFar 从相机取。
    // ⚠ 只在空间路径需要; 拿不到深度时把 uSpatial 关掉(纯双线性上采样), 不做"假遮挡"。
    const cu = u.uDepth as { value: THREE.Texture | null };
    cu.value = depth ?? null;
    (u.uNearFar.value as THREE.Vector2).set(this.camera.near, this.camera.far);
    if (!cu.value && this.spatialOn) u.uSpatial.value = 0;

    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsComp.render(renderer);
  }
  private _spatialErr = false;
  /** §330 "tup off + res>0.5" 的夹取提示只打一次 */
  private _resClampWarned = false;
  /** 合成着色器编译失败的警告只打一次(见 render 里的体检) */
  private _compileWarned = false;

  private dt = 1 / 60;
  /** 光照对接的报错只报一次(每帧 try 会刷屏) */
  private _atmoLightErr = false;
  /** Phase D: 风/时域旋钮写入的报错也只报一次 */
  private _windErr = false;
  /** §302: 3D 覆盖率开关应用的报错也只报一次 */
  private _cover3dErr = false;

  /** 由引擎每帧喂 dt(库的时间推进用)。 */
  setDeltaTime(dt: number) { this.dt = dt; }

  override dispose() {
    this.compMat.dispose();
    this.fsComp.dispose();
    try { this.irrLut?.dispose(); } catch { /* ignore */ }
    this.irrLut = null;
    try { this.stbn?.dispose(); } catch { /* ignore */ }
    this.stbn = null;
    // §302: 材质随 effect.dispose() 一起走; 这里只清我们自己的引用(免得探针拿着旧对象问状态)
    this._cover3dRefs = [];
    this._lastRenderer = null;
    this.effect.dispose?.();
  }
}
