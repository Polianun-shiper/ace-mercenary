// === Aerial Perspective LUT (32×32 的 2D 变体, 4 张 HalfFloat RT) ===============
//
// Hillaire 2020 的第四张 LUT 是"相机视锥体体积"(论文/UE: 32×32×32, x/y = 近平面上的
// 视锥坐标, z = 距离)。本轮按计划**先做 2D 变体**(能跑通再升级 3D), 坐标轴换成:
//     x = 距离 (非线性的: d = maxDist·u^exp, 近处密)
//     y = 视线天顶角 (与 sky-view LUT **同一份**非线性映射, 地平线附近加密)
//   ⇒ 丢掉的是"方位的各向异性": 一条光线的大气积分主要由它的**高度剖面**(天顶角)+ 距离决定,
//     方位只影响 (a) 太阳相对视线的相函数, (b) 太阳透过率的路径(二阶小量)。
//     (a) 在 AP pass 里**逐像素**补回来(光线是直线 ⇒ 相函数夹角沿光线恒定, 是精确的),
//     (b) 用"太阳-天顶平面"内的光线做代表烘烤(与 sky-view LUT 同一个规范平面)。
//
// 四张 RT 分别存 (都是"相机 → 该距离"的积分):
//   rtT   = rgb 透过率 T
//   rtLr  = rgb 瑞利单次散射(相函数先取**各向同性** 1/4π; 像素端乘回 4π·PR(θ))
//   rtLm  = rgb 米氏单次散射(同上, 像素端乘回 4π·PM(θ))
//   rtLms = rgb 多次散射(各向同性环境光, 像素端不乘相函数)
// 拆开存的原因: 相函数要在**像素**上用自己的 θ 评估(方位), 而多次散射不该再乘相函数 ——
// 混在一张里做不出这个区分, 也是"远处地形淡出的颜色和它背后那片天空对不上(出现假界线)"
// 的直接原因。
//
// 每帧重烤(带冗余保护: 相机高度变化 > 2m / 太阳高度角变化 > 0.02° 才真烤)。
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

const AERIAL_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

${ATMO_COMMON_GLSL}

uniform sampler2D uAtmTransLut;
uniform sampler2D uAtmMsLut;
uniform float uSkySunZenith;    // 太阳天顶角(弧度, 相对相机地方向上)
uniform float uAerialMaxDist;   // 最远距离(km) —— 由远平面参数化
uniform float uAerialExp;       // 距离分布指数
uniform int uTerm;              // 0 = T, 1 = 单次瑞利, 2 = 单次米氏, 3 = 多次散射

#define ATMO_AP_SUB 3           // 每个距离切片内的子采样

vec3 atmoMultiscatter(sampler2D msLut, vec3 p, vec3 sunDir) {
  float r = length(p);
  float h = clamp(r - uAtmBottomRadius, 0.0, uAtmAtmoHeight);
  float muS = dot(p / max(r, 1e-6), sunDir);
  vec2 uv = vec2(h / max(uAtmAtmoHeight, 1e-6), clamp(muS, -1.0, 1.0) * 0.5 + 0.5);
  uv = vec2(atmoUnitToSub(uv.x, ATMO_MS_W), atmoUnitToSub(uv.y, ATMO_MS_H));
  return texture2D(msLut, uv).rgb;
}

void main() {
  float viewHeight = max(uAtmViewHeight, uAtmBottomRadius);
  // 格点中心 → 单位参数(与采样端 atmoUnitToSub 配套: 单位 0/1 正好落在首/末格中心)
  float unitY = atmoSubToUnit(vUv.y, ATMO_AP_H);
  float unitX = atmoSubToUnit(vUv.x, ATMO_AP_W);
  float zenith = atmoUvYToZenith(unitY, viewHeight);
  // AP 体积没有方位轴 ⇒ 用"太阳-天顶平面"内的光线做代表(cAz = 1)
  vec3 rd = atmoViewDirInSunPlane(zenith, 1.0);
  vec3 ro = vec3(0.0, viewHeight, 0.0);
  vec3 sunDir = atmoSunDirInPlane(uSkySunZenith);

  bool hitGround; float tGround;
  float rayLen = atmoRayExit(ro, rd, hitGround, tGround);

  float maxDist = max(uAerialMaxDist, 1e-3);
  // 我这个格点的距离参数 = 该格点自己的切片边界 ⇒ 累加正好停在我这条参数上
  float myIx = floor(unitX * (ATMO_AP_W - 1.0) + 0.5);

  vec3 T = vec3(1.0);
  vec3 accR = vec3(0.0);
  vec3 accM = vec3(0.0);
  vec3 accMs = vec3(0.0);

  for (int s = 0; s < ATMO_AP_SLICES; s++) {
    if (float(s) >= myIx) break;
    float u0 = float(s) / (ATMO_AP_W - 1.0);
    float u1 = float(s + 1) / (ATMO_AP_W - 1.0);
    float d0 = min(atmoAerialSliceDistance(u0, maxDist, uAerialExp), rayLen);
    float d1 = min(atmoAerialSliceDistance(u1, maxDist, uAerialExp), rayLen);
    float sliceLen = d1 - d0;
    if (sliceLen <= 0.0) continue;
    float seg = sliceLen / float(ATMO_AP_SUB);
    for (int k = 0; k < ATMO_AP_SUB; k++) {
      float d = d0 + seg * (float(k) + 0.5);
      vec3 p = ro + rd * d;
      vec3 scatRay, scatMie, ext;
      atmoMediumAt(p, scatRay, scatMie, ext);
      vec3 Tsun = atmoSunTransmittance(uAtmTransLut, p, sunDir);
      vec3 ms = atmoMultiscatter(uAtmMsLut, p, sunDir) * uAtmMultiScatterOn;
      const float ISO = 1.0 / (4.0 * ATMO_PI);
      // 太阳辐照度必须乘进来(LUT 存的是辐射亮度, 见 skyview 里的说明)
      vec3 E = uAtmSolarIrradiance;
      accR += T * atmoIntegrateSource(E * Tsun * scatRay * ISO, ext, seg);
      accM += T * atmoIntegrateSource(E * Tsun * scatMie * ISO, ext, seg);
      accMs += T * atmoIntegrateSource(E * (scatRay + scatMie) * ms, ext, seg);
      T *= exp(-ext * seg);
    }
  }

  vec3 outv = T;
  if (uTerm == 1) outv = accR;
  else if (uTerm == 2) outv = accM;
  else if (uTerm == 3) outv = accMs;
  gl_FragColor = vec4(atmoClampRadiance(outv), 1.0);
}
`;

export interface AerialLutTextures {
  t: THREE.Texture;
  lr: THREE.Texture;
  lm: THREE.Texture;
  lms: THREE.Texture;
}

export class AerialPerspectiveLut {
  private rts: THREE.WebGLRenderTarget[] = [];
  private mat: THREE.ShaderMaterial;
  private baker: LutBaker;
  private dirty = true;
  private lastAlt = 1e9;
  private lastSunZenith = 1e9;
  /** 累计重烤次数 (每帧上限 1) */
  bakes = 0;
  /** 最远距离(km)/ 分布指数 —— 由远平面参数化 */
  maxDist = 60;
  exponent = 2.0;

  constructor(
    u: AtmosphereUniforms,
    transLut: THREE.Texture,
    msLut: THREE.Texture,
    baker: LutBaker,
  ) {
    const [w, h] = LUT_SIZES.aerial;
    for (let i = 0; i < 4; i++) this.rts.push(createLutRT(w, h));
    this.baker = baker;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        ...(u as unknown as Record<string, THREE.IUniform>),
        uAtmTransLut: { value: transLut },
        uAtmMsLut: { value: msLut },
        uSkySunZenith: { value: 1.0 },
        uAerialMaxDist: { value: 60 },
        uAerialExp: { value: 2 },
        uTerm: { value: 0 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: AERIAL_FRAG,
      depthTest: false,
      depthWrite: false,
    });
  }

  get textures(): AerialLutTextures {
    return {
      t: this.rts[0].texture,
      lr: this.rts[1].texture,
      lm: this.rts[2].texture,
      lms: this.rts[3].texture,
    };
  }

  get maxDistanceKm(): number { return this.maxDist; }
  get depthExponent(): number { return this.exponent; }

  invalidate(): void { this.dirty = true; }

  /** 每帧调用(带冗余烘烤保护)。farDistanceM 一般传相机的远平面。 */
  update(
    renderer: THREE.WebGLRenderer,
    altitude: number,
    sunZenith: number,
    farDistanceM: number,
  ): boolean {
    const farKm = Math.max(1, farDistanceM * 1e-3);
    if (Math.abs(farKm - this.maxDist) > 1e-3) this.dirty = true;
    if (Math.abs(altitude - this.lastAlt) > 2.0) this.dirty = true;
    if (Math.abs(sunZenith - this.lastSunZenith) > 3.5e-4) this.dirty = true;
    if (!this.dirty) return false;
    this.maxDist = farKm;
    this.mat.uniforms.uSkySunZenith.value = sunZenith;
    this.mat.uniforms.uAerialMaxDist.value = farKm;
    this.mat.uniforms.uAerialExp.value = this.exponent;
    for (let i = 0; i < 4; i++) {
      this.mat.uniforms.uTerm.value = i;
      this.baker.render(renderer, this.rts[i], this.mat);
    }
    this.lastAlt = altitude;
    this.lastSunZenith = sunZenith;
    this.dirty = false;
    this.bakes++;
    return true;
  }

  dispose(): void {
    for (const rt of this.rts) rt.dispose();
    this.rts = [];
    this.mat.dispose();
  }
}
