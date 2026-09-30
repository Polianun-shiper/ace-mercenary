// === 天空辐照度 LUT (64×16, HalfFloat RGBA) —— 专为 @takram/three-clouds 的"路 A" =====
//
// 为什么需要它(Phase B 的核心): takram 的云要算"太阳直射辐照 + 天空辐照", 走的是
// Bruneton 的运行时接口:
//     GetSunAndSkyScalarIrradiance(pos, sunDir, out skyIrradiance)   // shared3.js:817
//       sky_irradiance = GetIrradiance(irradiance_texture, r, mu_s) * 2π
//       return atmosphere.solar_irradiance * GetTransmittanceToSun(transmittance_texture, r, mu_s)
// 也就是说**它要两张 2D 贴图**: 透过率(我们 Phase A 已有, 尺寸/参数化完全一致)+ **天空辐照度**。
// 两张都是 null 时: `GetTransmittanceToSun` 采到 0 ⇒ **太阳直射项恒等于 0** ⇒ 云的明暗完全不
// 响应 sunDirection(§281 实测: sunDirection 取反"几乎逐像素不变")。这就是本文件要补的一格。
//
// === 与库的约定 (照 shared3.js 抄的, 别改) ====================================
//   · 尺寸: 库里 IRRADIANCE_TEXTURE_WIDTH=64 / HEIGHT=16 写死在着色器里(shared2.js 常量),
//     所以贴图**必须**是 64×16 —— 换尺寸就得同时改库的 define。
//   · UV 参数化 `GetIrradianceTextureUvFromRMuS`:
//         x_mu_s = mu_s*0.5 + 0.5                       (太阳天顶角余弦, 线性)
//         x_r    = (r - bottom) / (top - bottom)        (半径, 线性)
//         uv     = GetTextureCoordFromUnitRange(x, size) = 0.5/size + x*(size-1)/size
//     而 `GetTextureCoordFromUnitRange(x,size)` 与 params.ts 的 `atmoUnitToSub(x,size)`
//     **逐项相同**((0.5 + x*(size-1))/size)。所以我们按 atmoSubToUnit 烘、库按
//     GetTextureCoordFromUnitRange 采, 两边的"单位坐标"(x=0 → 首格中心, x=1 → 末格中心)
//     严格对齐, 采样正好落在烘出来的格心上 —— 与 Phase A 的四张 LUT 同一套做法。
//   · 值: 库里只以 `GetIrradiance(...) * 2π` 的形式用它, 所以这里存 **E/(2π)**,
//     其中 E = ∫_半球 L(ω)·cosθ dω 是真正的天空辐照度。这样 `*2π` 之后正好是 E。
//     (同一个值也被 GROUND_BOUNCE 的 `approximateRadianceFromGround` 消费:
//      `groundIrradiance = skyIrradiance + (1-coverage)*sunIrradiance`, 单位自洽。)
//
// === 烘焙内容 ================================================================
//   E(r, mu_s) = ∫_上半球 L(r, ω → sun(μ_s)) · cosθ dω
//   L 用与 `lut-skyview.ts` **完全同一个积分式**(单次散射 × 太阳透过率 + 多次散射 LUT),
//   只是把"视线方向"换成"半球采样方向"。θ 从"地方向上(+Y)"量起 ⇒ cosθ 就是朗伯权重。
//   方位 φ 只积 [0, π] 再 ×2: 介质关于"太阳-天顶平面"镜像对称(太阳在该平面内), 这是精确的。
//
// ⚠ 与 sky-view LUT 同样**不含地面反射**(光线打到地面就停) —— 与 Phase A 的已知限制一致。
//
// === 重烤时机 ================================================================
//   这张 LUT **不依赖当前太阳方向**(mu_s 是它的一个轴), 也不依赖相机 ⇒ 只有
//   "太阳辐照度变了"(白天↔夜景的太阳强度系数 / atmo tint)或"介质变了"才重烤。
//   一局里基本只烤 1 次(加载 warmup)。单次成本 ≈ 64×16 × 8×8×12 步 ≈ 0.8M 步。
import * as THREE from 'three';
import {
  ATMO_COMMON_GLSL,
  type AtmosphereUniforms,
} from './params';
import { createLutRT, LutBaker } from './lut-transmittance';

/** 与库里写死的 IRRADIANCE_TEXTURE_WIDTH / HEIGHT 一致 —— 改这里必须同时改库的 define。 */
export const IRRA_LUT_W = 64;
export const IRRA_LUT_H = 16;

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const IRRA_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

${ATMO_COMMON_GLSL}

uniform sampler2D uAtmTransLut;
uniform sampler2D uAtmMsLut;

// 与 lut-skyview.ts 里的 atmoMultiscatter 同一份(uv 参数化 = 高度 × 太阳天顶角余弦)
vec3 atmoMultiscatter(sampler2D msLut, vec3 p, vec3 sunDir) {
  float r = length(p);
  float h = clamp(r - uAtmBottomRadius, 0.0, uAtmAtmoHeight);
  float muS = dot(p / max(r, 1e-6), sunDir);
  vec2 uv = vec2(h / max(uAtmAtmoHeight, 1e-6), clamp(muS, -1.0, 1.0) * 0.5 + 0.5);
  uv = vec2(atmoUnitToSub(uv.x, ATMO_MS_W), atmoUnitToSub(uv.y, ATMO_MS_H));
  return texture2D(msLut, uv).rgb;
}

// 半球采样: θ(天顶) 20 段 × φ(方位) 10 段(只积半圈, ×2), 每段 10~24 步(随光线长度)。
// θ 用"向地平线加密"的二次翘曲 —— 见 main 里的说明(这是与参考 LUT 对得上的关键)。
// ⚠ 段数 14→20 (§294): θ>80° 的样本 4→10 段, 覆盖 79.8~89.97°(间距 1~2°, 与"低太阳
//   时 1~3° 宽的辉光带"同量级)。**实测这一改只动 <0.2%** —— 14 段的二次翘曲本来就
//   已经收敛(见 §294 的敏感性实验: 步数 24→40 也只差 -1%), 保留 20 是给高浊度/雾霾
//   (uAtmMieScale 变大 ⇒ 辉光带更窄)留余量, 代价只是加载期一次 ×1.43 的烘烤量。
const int IRR_NT = 20;
const int IRR_NP = 10;
const int IRR_STEPS = 24;
const float IRR_SEG_T = 0.3;

// 烘烤观测点离地高度 (km; 只在 x_r=0 那一行起作用, 其余行被压缩掉等量高度)。
//
// ⚠ 不这么做的话, 最底那一行是**坏的**: x_r=0 ⇒ r 正好等于 bottomRadius, 观测点
//   落在行星球面上, atmoRaySphereNearest 对"向上"的光线算出的切线判别式
//   c = dot(ro,ro) - R*R 是 0(两个乘积逐位相消), 于是 t1 = -b + sqrt(b*b)
//   变成"b*b 舍入到哪一侧"的抛硬币 —— 实测一半的方向返回 t≈0.5m(hitGround=true
//   ⇒ rayLen≈0 ⇒ **整条方向的天空项被丢掉**), 另一半才拿到正确的长光线。
//   后果(§294 实测, 与 Bruneton 参考 irradiance.bin 逐格比):
//     · 行 0(地面) 比值 0.188(mu_s≈0.05)~0.277(mu_s≈0.95), 而 **行 1~14 的比值(rgb 均值)
//       1.05~1.21** ⇒ 不是"整体尺度差", 是这一行的数值退化; 低太阳角那 0.14~0.215 的亏欠主要来自它。
//     · 库的 GROUND_BOUNCE(clouds.frag 的 approximateRadianceFromGround)正好
//       **按 x_r=0 精确取这一行**(pos - normal*height 就是脚下地面点) ⇒ 地面反弹光暗 ~4×。
//   抬 1m 之后 c = 2*R*h ≈ 12.7 ≫ fl(b*b) 的 ULP(4), 判别式远离噪声, 不再丢方向;
//   而 1m 对密度(1/8000 = 0.0125%)与几何都可忽略 ⇒ 仍是"地面那一格"的值。
const float IRR_H0 = 0.001;

// 沿一条方向积出天空辐射亮度(与 skyview 的单条光线积分同一个式子)
vec3 irrRadiance(vec3 ro, vec3 rd, vec3 sunDir) {
  bool hitGround; float tGround;
  float rayLen = atmoRayExit(ro, rd, hitGround, tGround);

  float cosTheta = clamp(dot(rd, sunDir), -1.0, 1.0);
  float phaseR = atmoRayleighPhase(cosTheta);
  float phaseM = atmoMiePhase(cosTheta, uAtmMieG);

  // 采样数随光线长度增加(短光线 10 步, 掠射光线 24 步) —— 与 skyview 同一策略
  float lenK = clamp(rayLen / max(2.0 * uAtmAtmoHeight, 1e-6), 0.0, 1.0);
  float sampleCount = mix(10.0, float(IRR_STEPS), lenK);

  vec3 L = vec3(0.0);
  vec3 T = vec3(1.0);
  for (int i = 0; i < IRR_STEPS; i++) {
    if (float(i) >= sampleCount) break;
    float f0 = float(i) / sampleCount;
    float f1 = float(i + 1) / sampleCount;
    // 平方分布: 近处密(介质密度/太阳透过率变化最快的那段)
    float d0 = rayLen * f0 * f0;
    float d1 = (f1 > 1.0) ? rayLen : rayLen * f1 * f1;
    float seg = max(d1 - d0, 0.0);
    if (seg <= 0.0) continue;
    vec3 p = ro + rd * (d0 + seg * IRR_SEG_T);
    vec3 scatRay, scatMie, ext;
    atmoMediumAt(p, scatRay, scatMie, ext);
    vec3 Tsun = atmoSunTransmittance(uAtmTransLut, p, sunDir);
    vec3 ms = atmoMultiscatter(uAtmMsLut, p, sunDir) * uAtmMultiScatterOn;
    vec3 source = uAtmSolarIrradiance * (Tsun * (scatRay * phaseR + scatMie * phaseM)
                                      + (scatRay + scatMie) * ms);
    L += T * atmoIntegrateSource(source, ext, seg);
    T *= exp(-ext * seg);
  }
  return L;
}

void main() {
  // 格点中心 → 单位参数(与库的 GetTextureCoordFromUnitRange / 我们的 atmoUnitToSub 配套)
  float xMu = atmoSubToUnit(vUv.x, ${IRRA_LUT_W}.0);
  float xR = atmoSubToUnit(vUv.y, ${IRRA_LUT_H}.0);

  float muS = clamp(xMu * 2.0 - 1.0, -1.0, 1.0);
  // 观测点抬 IRR_H0(见上面的说明): 顶端也一起收进来, 免得行 15 落到大气顶之外
  float heightSpan = max(uAtmAtmoHeight - IRR_H0, 1e-4);
  float r = uAtmBottomRadius + IRR_H0 + clamp(xR, 0.0, 1.0) * heightSpan;
  vec3 ro = vec3(0.0, max(r, uAtmBottomRadius), 0.0);
  // 规范坐标: up = +Y, 太阳在那个平面内 ⇒ sunDir = (sin, cos, 0)
  vec3 sunDir = atmoSunDirInPlane(acos(clamp(muS, -1.0, 1.0)));

  float dPhi = ATMO_PI / float(IRR_NP);
  vec3 E = vec3(0.0);
  for (int i = 0; i < IRR_NT; i++) {
    // === θ 采样必须**向地平线加密** (per 实测对照) ==============================
    // 均匀 8 段时最大的 θ 只到 84.4°, 而"太阳低 + 近地平线"的辉光带只有 1~3° 宽
    // ⇒ 那一块被整段跳过, 结果是 LUT 在低太阳角处**低一个数量级**。这里用
    // θ = (π/2)·(1-(1-u)²) 的二次翘曲: 一半的样本落在最后 25%(θ>67°), 末样本 θ≈89.97°;
    // 翘曲的雅可比 dθ/du = (π/2)·2(1-u) 直接乘进权重。
    // §294 复核: 段数 14→20 与"每条光线 24→40 步"**各只动 <0.2% / -1%**(且与 mu_s 无关)
    //   ⇒ 这一层的求积早已收敛, 低太阳段的亏欠不是"θ 太稀"造成的(真凶见 IRR_H0 的说明)。
    float u = (float(i) + 0.5) / float(IRR_NT);
    float w = 1.0 - u;
    float theta = 0.5 * ATMO_PI * (1.0 - w * w);
    float dTheta = 0.5 * ATMO_PI * 2.0 * w / float(IRR_NT);
    float st = sin(theta);
    float ct = cos(theta);
    for (int j = 0; j < IRR_NP; j++) {
      float phi = (float(j) + 0.5) * dPhi;
      vec3 rd = vec3(st * cos(phi), ct, st * sin(phi));
      E += irrRadiance(ro, rd, sunDir) * ct * st * dTheta;
    }
  }
  // ×2 补上被镜像省掉的半圈, 再乘 dφ ⇒ 真正的 ∫L·cosθ dω
  E *= dPhi * 2.0;

  // === 存的到底是什么: E 本身(与 Bruneton 参考实现**逐字一致**) ================
  // 参考实现 three-atmosphere/shaders 的 ComputeIndirectIrradiance:
  //     SolidAngle domega = dtheta*dphi*sin(theta);
  //     result += GetScattering(...) * omega.z * domega;        // omega.z = cosθ
  //   ⇒ 写进 irradiance 贴图的就是 ∫L·cosθ dω = E, 没有再除任何常数。
  // 我第一版想当然写成 E/(2π)(因为库里读的时候乘了 2π), 结果是**把所有云的天光
  // 压小了 2π 倍**(云底发黑)。用库自带的 assets/irradiance.bin(64×16 RGBA16F、
  // 同一套 AtmosphereParameters.DEFAULT)对照实测:
  //   参考 (r=地表, mu_s=1) = (0.0451, 0.1122, 0.2454)
  //   我们存 E/(2π)        = (0.00109, 0.00244, 0.00487)   ← 差 ~7~8 倍
  //   我们存 E             = (0.0068, 0.0153, 0.0306) ×2π ≈ (0.043, 0.096, 0.192)
  //   ⇒ 与参考相差 5%~22%(残差来自 8×8 求积与多次散射近似), 量级对了。
  gl_FragColor = vec4(atmoClampRadiance(E), 1.0);
}
`;

/**
 * 天空辐照度 LUT(64×16)。**不依赖太阳方向 / 相机** —— mu_s 就是它的一根轴。
 * 只在太阳辐照度或介质参数变化时重烤。
 */
export class IrradianceLut {
  readonly rt: THREE.WebGLRenderTarget;
  private mat: THREE.ShaderMaterial;
  private baker: LutBaker;
  private dirty = true;
  private lastSolar = new THREE.Vector3(1e9, 1e9, 1e9);
  /** 累计重烤次数(atmo/cloud report 用) */
  bakes = 0;

  constructor(
    u: AtmosphereUniforms,
    transLut: THREE.Texture,
    msLut: THREE.Texture,
    baker: LutBaker = new LutBaker(),
  ) {
    this.rt = createLutRT(IRRA_LUT_W, IRRA_LUT_H);
    this.baker = baker;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        ...(u as unknown as Record<string, THREE.IUniform>),
        uAtmTransLut: { value: transLut },
        uAtmMsLut: { value: msLut },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: IRRA_FRAG,
      depthTest: false,
      depthWrite: false,
    });
  }

  get texture(): THREE.Texture { return this.rt.texture; }

  /** 介质参数/多次散射倍率变了 */
  invalidate(): void { this.dirty = true; }

  /**
   * 每帧调用(零成本: 内部只在"辐照度真变了"时烤)。
   * 判据: 太阳辐照度相对变化 > 1%(夜景压暗 / atmo tint)。辐照度本身是 LUT 的输入之一。
   */
  update(renderer: THREE.WebGLRenderer, solarIrradiance: THREE.Vector3): boolean {
    const l = this.lastSolar;
    const rel = Math.abs(solarIrradiance.x - l.x) + Math.abs(solarIrradiance.y - l.y)
      + Math.abs(solarIrradiance.z - l.z);
    if (rel > 0.01 * Math.max(0.25, solarIrradiance.length())) this.dirty = true;
    if (!this.dirty) return false;
    const prev = renderer.getRenderTarget();
    this.baker.render(renderer, this.rt, this.mat);
    renderer.setRenderTarget(prev);
    l.copy(solarIrradiance);
    this.dirty = false;
    this.bakes++;
    return true;
  }

  dispose(): void {
    this.rt.dispose();
    this.mat.dispose();
    this.baker.dispose();
  }
}
