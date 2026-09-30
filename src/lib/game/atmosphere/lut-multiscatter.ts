// === Multiscattering LUT (32×32, HalfFloat RGBA) ==============================
//
// Hillaire 2020 的多次散射近似 —— **这条是日出日落发黄发脏的关键**:
//   只有一次散射的大气在低太阳高度角下会同时缺蓝又缺"环境光", 表现为地平线附近一条
//   脏黄/发褐的带子(经典 bug); 补上二阶以上的散射后, 天空在黄昏是"暖而不脏"的。
// 近似方式(论文): 把二阶以上的入射辐射当作**各向同性**, 于是只需在球面上平均:
//     L̄(x) = (1/4π) ∫ L_single(ω) dω         (用各向同性相函数 1/4π 沿每条光线积分)
//     f_ms(x) = (1/4π) ∫ (∫ σ_s·T ds) dω      (还会被再散射一次的比例)
//     LUT = L̄ · F_ms,  F_ms = 1/(1-f_ms)      (无穷级数的几何和)
// 运行时用法 (见 lut-skyview / lut-aerial): 源项里加 `MS(h, mu_s) · σ_s`, 不乘太阳透过率、
// 不乘行星阴影 —— 它是"环境光", 阴影里的天空靠它才不发黑。
//
// 重烤时机: **太阳高度角变化 > 0.2° 或介质参数变化**, 且最多每 24 帧一次(单次烘烤约
// 64 个方向 × 24 步, 是这里最贵的一张, 但一次只要几~几十 ms, 且只在加载/改太阳时发生)。
import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import {
  ATMO_COMMON_GLSL,
  LUT_SIZES,
  type AtmosphereUniforms,
} from './params';
import { createLutRT, LutBaker } from './lut-transmittance';

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const MS_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

${ATMO_COMMON_GLSL}

uniform sampler2D uAtmTransLut;   // 透过率 LUT
uniform float uMsScale;           // 现场旋钮(默认 1): 整体缩放多次散射
uniform float uMsClamp;           // f_ms 上限(防止 1/(1-f) 爆掉)

const int ATMO_MS_DIRS = 8;       // 球面 8×8 方向
const int ATMO_MS_STEPS = 24;     // 每条光线 24 段(近处密: 平方分布)

vec3 msIntegrateAxis(vec3 ro, vec3 rd, vec3 sunDir, out vec3 scatterFrac) {
  bool hitGround; float tGround;
  float tEnd = atmoRayExit(ro, rd, hitGround, tGround);

  // 打到地面的方向: 加上"地面反照率 × 被太阳照亮的辐照度 / π"(漫反射地面)
  vec3 direct = vec3(0.0);
  if (hitGround) {
    vec3 hitP = ro + rd * tEnd;
    float hr = length(hitP);
    vec3 n = hitP / max(hr, 1e-6);
    vec3 Tsun = atmoSunTransmittance(uAtmTransLut, hitP, sunDir);
    direct = uAtmGroundAlbedo / ATMO_PI * Tsun * max(dot(n, sunDir), 0.0);
  }
  vec3 inscattered = vec3(0.0);
  vec3 scatterAccum = vec3(0.0);
  vec3 T = vec3(1.0);

  // 平方分布: 近处密(介质密度最高), 远处疏
  for (int i = 0; i < ATMO_MS_STEPS; i++) {
    float f0 = float(i) / float(ATMO_MS_STEPS);
    float f1 = float(i + 1) / float(ATMO_MS_STEPS);
    float d0 = tEnd * f0 * f0;
    float d1 = tEnd * f1 * f1;
    float seg = max(d1 - d0, 0.0);
    if (seg <= 0.0) continue;
    vec3 p = ro + rd * (d0 + seg * 0.5);
    vec3 scatRay, scatMie, ext;
    atmoMediumAt(p, scatRay, scatMie, ext);
    vec3 scat = scatRay + scatMie;
    // ∫ σ_s·T ds 这一段(解析)
    vec3 segIntegral = atmoIntegrateSource(scat, ext, seg);
    // f_ms 的分子: 只会被"再散射一次"的那部分(逐通道: 蓝散射得更狠 ⇒ 蓝的多次散射更强)
    // ⚠ 这里**不乘**太阳辐照度(f_ms 是"比例", 乘了会在 1/(1-f) 里约掉)
    scatterAccum += segIntegral * T;
    // 各向同性相函数 = 1/(4π): 这里先乘上, 球面平均的 4π 由权重消掉
    vec3 Tsun = atmoSunTransmittance(uAtmTransLut, p, sunDir);
    inscattered += segIntegral * uAtmSolarIrradiance * Tsun * (1.0 / (4.0 * ATMO_PI)) * T;
    T *= exp(-ext * seg);
  }
  // 地面贡献乘"从起点到地面的透过率"= 循环结束时的 T
  inscattered += direct * uAtmSolarIrradiance * T;
  scatterFrac = scatterAccum;
  return inscattered;
}

void main() {
  // 格点中心 → 单位参数 (与采样端的 atmoUnitToSub 配套: 单位 0/1 正好落在首/末格中心上)
  float x = atmoSubToUnit(vUv.x, ATMO_MS_W);
  float y = atmoSubToUnit(vUv.y, ATMO_MS_H);
  float h = clamp(x, 0.0, 1.0) * uAtmAtmoHeight;
  float muS = clamp(y * 2.0 - 1.0, -0.999, 0.999);

  vec3 P = vec3(0.0, uAtmBottomRadius + h, 0.0);
  vec3 sunDir = atmoSunDirInPlane(acos(muS));

  vec3 L2 = vec3(0.0);
  vec3 fms = vec3(0.0);
  // 球面平均: θ 均匀 + φ 均匀 ⇒ 权重 sinθ·Δθ·Δφ/(4π)
  float dTheta = ATMO_PI / float(ATMO_MS_DIRS);
  float dPhi = 2.0 * ATMO_PI / float(ATMO_MS_DIRS);
  float weight = dTheta * dPhi / (4.0 * ATMO_PI);
  for (int i = 0; i < ATMO_MS_DIRS; i++) {
    float theta = ATMO_PI * (float(i) + 0.5) / float(ATMO_MS_DIRS);
    float st = sin(theta);
    for (int j = 0; j < ATMO_MS_DIRS; j++) {
      float phi = 2.0 * ATMO_PI * (float(j) + 0.5) / float(ATMO_MS_DIRS);
      vec3 V = vec3(st * cos(phi), cos(theta), st * sin(phi));
      vec3 frac;
      vec3 L = msIntegrateAxis(P, V, sunDir, frac);
      L2 += L * st;
      fms += frac * st;
    }
  }
  L2 *= weight;
  fms *= weight;
  // 几何级数求和(无穷次散射): 1 + f + f² + ... = 1/(1-f)
  fms = clamp(fms * uMsScale, 0.0, uMsClamp);
  vec3 Fms = vec3(1.0) / max(vec3(1.0) - fms, vec3(1e-3));
  vec3 ms = L2 * Fms * uMsScale;
  gl_FragColor = vec4(atmoClampRadiance(ms), 1.0);
}
`;

export class MultiscatterLut {
  readonly rt: THREE.WebGLRenderTarget;
  private mat: THREE.ShaderMaterial;
  private baker: LutBaker;
  private dirty = true;
  private lastBakeFrame = -1e9;
  private lastSunMu = 1e9;
  /** 累计重烤次数 (atmo report 用) */
  bakes = 0;

  constructor(
    u: AtmosphereUniforms,
    transLut: THREE.Texture,
    baker: LutBaker,
  ) {
    const [w, h] = LUT_SIZES.multiscatter;
    this.rt = createLutRT(w, h);
    this.baker = baker;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        ...(u as unknown as Record<string, THREE.IUniform>),
        uAtmTransLut: { value: transLut },
        uMsScale: { value: 1 },
        uMsClamp: { value: 0.9 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: MS_FRAG,
      depthTest: false,
      depthWrite: false,
    });
  }

  get texture(): THREE.Texture { return this.rt.texture; }

  /** 介质参数变了(含太阳角突变的初始化) */
  invalidate(): void { this.dirty = true; }

  /** 每帧调用: 太阳高度角变化超过阈值才重烤(并且最多每 24 帧一次)。 */
  update(renderer: THREE.WebGLRenderer, sunZenithCos: number, frameIndex: number): boolean {
    if (Math.abs(sunZenithCos - this.lastSunMu) > 0.0035) this.dirty = true; // ≈0.2°
    if (!this.dirty) return false;
    if (frameIndex - this.lastBakeFrame < 24) return false;
    this.baker.render(renderer, this.rt, this.mat);
    this.lastBakeFrame = frameIndex;
    this.lastSunMu = sunZenithCos;
    this.dirty = false;
    this.bakes++;
    return true;
  }

  /** 强制立刻重烤(加载时用, 不受节流限制)。 */
  force(renderer: THREE.WebGLRenderer, sunZenithCos: number, frameIndex = 1e9): void {
    this.lastBakeFrame = -1e9;
    this.dirty = true;
    this.update(renderer, sunZenithCos, frameIndex);
  }

  setScale(v: number): void {
    this.mat.uniforms.uMsScale.value = Math.max(0, v);
    this.dirty = true;
  }

  getScale(): number { return this.mat.uniforms.uMsScale.value as number; }

  setClamp(v: number): void {
    this.mat.uniforms.uMsClamp.value = Math.min(Math.max(v, 0.1), 0.98);
    this.dirty = true;
  }

  dispose(): void {
    this.rt.dispose();
    this.mat.dispose();
  }
}
