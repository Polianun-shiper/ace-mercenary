// === Sky-View LUT (192×108, HalfFloat RGBA) ===================================
//
// Hillaire 2020 的第三张 LUT: 在相机高度上, 把"整个天球"的辐射亮度预积分到一张 192×108 的
// 小图里, 天空着色器就只做一次纹理采样(而不是每像素 64 步积分)。
//
// 参数化(与 lut-aerial / 天空着色器**共用 params.ts 里的同一份 GLSL**, 不会对不上):
//   uv.y = 视线天顶角: 0 = 天顶, 0.5 = 几何地平线, 1 = 天底; 地平线附近按 sqrt 加密
//   uv.x = cos(视线方位 - 太阳方位): 0.5→sqrt 映射, 太阳那一侧(cos→1)分配更多精度
//   ⇒ 只覆盖"太阳-天顶平面"内的半个方位; 但介质球对称 + 太阳在该平面内, Δ → -Δ 是镜像,
//     两侧辐射相同, 所以这一张 LUT 就代表了整圈方位。
//
// 重烤时机: 每帧(带**冗余烘烤保护** —— 只有相机高度变化 > 2m 或太阳高度角变化 > 0.02°
// 或介质参数变化才真的重烤; 悬停/静止时一次都不烤)。单次 192×108×32~64 步。
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

const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

${ATMO_COMMON_GLSL}

uniform sampler2D uAtmTransLut;
uniform sampler2D uAtmMsLut;
uniform float uSkySunZenith;   // 太阳天顶角(弧度, 相对相机地方向上)

vec3 atmoMultiscatter(sampler2D msLut, vec3 p, vec3 sunDir) {
  float r = length(p);
  float h = clamp(r - uAtmBottomRadius, 0.0, uAtmAtmoHeight);
  float muS = dot(p / max(r, 1e-6), sunDir);
  vec2 uv = vec2(h / max(uAtmAtmoHeight, 1e-6), clamp(muS, -1.0, 1.0) * 0.5 + 0.5);
  uv = vec2(atmoUnitToSub(uv.x, ATMO_MS_W), atmoUnitToSub(uv.y, ATMO_MS_H));
  return texture2D(msLut, uv).rgb;
}

const int ATMO_SKY_MAX_STEPS = 64;
const float ATMO_SKY_SEG_T = 0.3;   // 段内采样位置(参考实现用 0.3, 偏向前端)

void main() {
  float viewHeight = max(uAtmViewHeight, uAtmBottomRadius);
  // 格点中心 → 单位参数(与采样端 atmoUnitToSub 配套)
  float unitY = atmoSubToUnit(vUv.y, ATMO_SKY_H);
  float unitX = atmoSubToUnit(vUv.x, ATMO_SKY_W);
  float zenith = atmoUvYToZenith(unitY, viewHeight);
  float cAz = atmoUvXToLightViewCos(unitX);

  vec3 ro = vec3(0.0, viewHeight, 0.0);
  vec3 rd = atmoViewDirInSunPlane(zenith, cAz);
  vec3 sunDir = atmoSunDirInPlane(uSkySunZenith);

  bool hitGround; float tGround;
  float rayLen = atmoRayExit(ro, rd, hitGround, tGround);

  // 单次散射的相函数: 视线是直线 + 太阳方向恒定 ⇒ 相函数的夹角沿光线**恒定**, 提到循环外
  float cosTheta = clamp(dot(rd, sunDir), -1.0, 1.0);
  float phaseR = atmoRayleighPhase(cosTheta);
  float phaseM = atmoMiePhase(cosTheta, uAtmMieG);

  // 采样数随光线长度增加(短光线 32, 最长的掠射光线 64)
  float lenK = clamp(rayLen / max(2.0 * uAtmAtmoHeight, 1e-6), 0.0, 1.0);
  float sampleCount = mix(32.0, float(ATMO_SKY_MAX_STEPS), lenK);
  float sampleCountFloor = max(floor(sampleCount), 1.0);
  float fullLen = rayLen * sampleCountFloor / sampleCount;

  vec3 L = vec3(0.0);
  vec3 T = vec3(1.0);

  for (int i = 0; i < ATMO_SKY_MAX_STEPS; i++) {
    if (float(i) >= sampleCount) break;
    float f0 = float(i) / sampleCountFloor;
    float f1 = float(i + 1) / sampleCountFloor;
    // 平方分布: 近处密(密度最高/太阳透过率变化最快的那段)
    float d0 = fullLen * f0 * f0;
    float d1 = (f1 > 1.0) ? rayLen : fullLen * f1 * f1;
    float seg = max(d1 - d0, 0.0);
    if (seg <= 0.0) continue;

    vec3 p = ro + rd * (d0 + seg * ATMO_SKY_SEG_T);
    vec3 scatRay, scatMie, ext;
    atmoMediumAt(p, scatRay, scatMie, ext);

    vec3 Tsun = atmoSunTransmittance(uAtmTransLut, p, sunDir);
    // 多次散射(各向同性环境光: 不乘太阳透过率/不乘行星阴影) —— 强度旋钮在 MS LUT 里
    vec3 ms = atmoMultiscatter(uAtmMsLut, p, sunDir) * uAtmMultiScatterOn;
    // ⚠ 必须乘太阳辐照度: LUT 存的是**辐射亮度**(不是"归一化亮度"), 否则
    //   只改辐照度的旋钮(atmo exp / 夜景压暗)对天空毫无作用 —— 实测踩过: 夜景把
    //   辐照度压了 50 倍天空一点没变, 因为只有太阳盘吃了辐照度。切勿在此写反引号!
    vec3 source = uAtmSolarIrradiance * (Tsun * (scatRay * phaseR + scatMie * phaseM)
                                      + (scatRay + scatMie) * ms);
    L += T * atmoIntegrateSource(source, ext, seg);
    T *= exp(-ext * seg);
  }

  gl_FragColor = vec4(atmoClampRadiance(L), 1.0);
}
`;

export class SkyViewLut {
  readonly rt: THREE.WebGLRenderTarget;
  private mat: THREE.ShaderMaterial;
  private baker: LutBaker;
  private lastAlt = 1e9;
  private lastSunZenith = 1e9;
  private dirty = true;
  /** 累计重烤次数(每帧上限 1, atmo report 用) */
  bakes = 0;

  constructor(
    u: AtmosphereUniforms,
    transLut: THREE.Texture,
    msLut: THREE.Texture,
    baker: LutBaker,
  ) {
    const [w, h] = LUT_SIZES.skyView;
    this.rt = createLutRT(w, h);
    this.baker = baker;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        ...(u as unknown as Record<string, THREE.IUniform>),
        uAtmTransLut: { value: transLut },
        uAtmMsLut: { value: msLut },
        uSkySunZenith: { value: 1.0 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: SKY_FRAG,
      depthTest: false,
      depthWrite: false,
    });
  }

  get texture(): THREE.Texture { return this.rt.texture; }

  invalidate(): void { this.dirty = true; }

  /**
   * 每帧调用。相机高度(英里量级)或太阳高度角有可见变化才重烤 ——
   * 判据是"高度差 > 2m / 太阳高度角差 > 0.02°", 飞行中基本等于每帧一次, 悬停时 0 次。
   */
  update(renderer: THREE.WebGLRenderer, altitude: number, sunZenith: number): boolean {
    if (Math.abs(altitude - this.lastAlt) > 2.0) this.dirty = true;
    if (Math.abs(sunZenith - this.lastSunZenith) > 3.5e-4) this.dirty = true;
    if (!this.dirty) return false;
    this.mat.uniforms.uSkySunZenith.value = sunZenith;
    this.baker.render(renderer, this.rt, this.mat);
    this.lastAlt = altitude;
    this.lastSunZenith = sunZenith;
    this.dirty = false;
    this.bakes++;
    return true;
  }

  dispose(): void {
    this.rt.dispose();
    this.mat.dispose();
  }
}
