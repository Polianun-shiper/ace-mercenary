/**
 * AtmosphericSky — UE5 风格的物理大气散射天光
 * =====================================================================
 * 实现基于 Preetham + Hosek-Wilkie 简化版的瑞利 + 米氏散射模型，
 * 在 GPU 上实时计算天空颜色，做出贴近虚幻 5 / 越野飞行模拟的视觉质感：
 *
 *   - 渐变天顶-地平线蓝色（瑞利散射）
 *   - 太阳光晕 + 太阳盘（米氏散射）
 *   - 大气透视（远景被大气染色）
 *   - 日出 / 日落暖色过渡（仰角低时瑞利路径变长）
 *
 * 这是程序化的天空着色器，不依赖任何贴图，完全 GPU 计算，0 内存开销。
 */
import * as THREE from 'three';

export interface AtmosphereParams {
  sunAzimuth: number;     // 度
  sunElevation: number;   // 度 (0=地平线, 90=天顶)
  turbidity: number;      // 浊度 (大气粒子浓度)
  rayleigh: number;       // 瑞利散射系数
  mieCoefficient: number;
  mieDirectionalG: number;
  horizonTint: number;    // -1 (冷) - 1 (暖)
}

const SKY_VERT = /* glsl */ `
varying vec3 vWorldPos;
void main() {
  vWorldPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w; // 把天空盒推到最远裁剪面
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorldPos;

uniform vec3 uSunDir;
uniform float uTurbidity;
uniform float uRayleigh;
uniform float uMieCoefficient;
uniform float uMieDirectionalG;
uniform float uHorizonTint;
uniform vec3 uSunColor;

// 瑞利散射常量 (大气分子)
const vec3 betaR = vec3(5.8e-6, 13.5e-6, 33.1e-6);
// 米氏散射常量 (气溶胶)
vec3 betaM;

// 计算天光颜色 (Hosek-Wilkie 简化版)
vec3 atmosphere(vec3 dir, vec3 sunDir) {
  // 归一化方向
  dir = normalize(dir);
  sunDir = normalize(sunDir);

  // 大气粒子浓度
  betaM = vec3(uMieCoefficient) * (1.0 + uTurbidity * 0.2);

  // 与太阳的夹角余弦
  float cosTheta = dot(dir, sunDir);

  // 瑞利相位函数 (各向同性散射，蓝光主导)
  float rayleighPhase = (3.0 / (16.0 * 3.14159265)) * (1.0 + cosTheta * cosTheta);

  // 米氏相位函数 (前向散射，朝太阳方向亮)
  float g = uMieDirectionalG;
  float miePhase = (3.0 / (8.0 * 3.14159265)) *
    ((1.0 - g * g) * (1.0 + cosTheta * cosTheta)) /
    ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * cosTheta, 1.5));

  // 光线穿越大气的路径长度 (仰角越低越长)
  float upDot = max(dir.y, -0.05);
  float opticalDepth = 1.0 / (upDot + 0.05);

  // 累积散射
  vec3 betaR_total = betaR * uRayleigh;
  vec3 betaM_total = betaM;
  vec3 tau = (betaR_total + betaM_total) * opticalDepth;
  vec3 extinction = exp(-tau);

  // 太阳入射光 (假设穿越整层大气)
  float sunUpDot = max(sunDir.y, 0.0);
  float sunOpticalDepth = 1.0 / (sunUpDot + 0.05);
  vec3 sunExtinction = exp(-(betaR_total + betaM_total) * sunOpticalDepth);

  // 最终天光 (瑞利 + 米氏)
  vec3 skyColor = (rayleighPhase * betaR_total + miePhase * betaM_total) * uSunColor * sunExtinction;
  skyColor /= (betaR_total + betaM_total);
  skyColor *= 1.0 - extinction;

  // 太阳盘 (硬光晕)
  float sunDisc = smoothstep(0.9995, 0.9999, cosTheta);
  skyColor += uSunColor * sunDisc * 50.0;

  // 太阳光晕 (软光晕)
  float sunGlow = pow(max(cosTheta, 0.0), 200.0);
  skyColor += uSunColor * sunGlow * 0.5;

  // 地平线色调调整 (日出/日落暖色)
  float horizonFactor = 1.0 - abs(dir.y);
  vec3 warmTint = vec3(1.4, 1.0, 0.7);
  vec3 coolTint = vec3(0.7, 0.85, 1.2);
  vec3 horizonColor = mix(coolTint, warmTint, uHorizonTint * 0.5 + 0.5);
  skyColor = mix(skyColor, skyColor * horizonColor, horizonFactor * 0.3);

  // 地平线辉光 (当太阳低时强化橙红色)
  float sunHorizonFactor = (1.0 - sunDir.y) * horizonFactor;
  vec3 sunsetColor = vec3(1.6, 0.8, 0.4);
  skyColor += sunsetColor * sunHorizonFactor * 0.4 * uSunColor;

  return skyColor;
}

void main() {
  vec3 dir = normalize(vWorldPos);
  vec3 col = atmosphere(dir, uSunDir);
  // 限制亮度避免 bloom 过曝
  col = col / (col + vec3(1.0));
  gl_FragColor = vec4(col, 1.0);
}
`;

/** 由方位角 + 仰角计算太阳方向向量 (世界空间) */
export function sunDirectionFrom(azimuthDeg: number, elevationDeg: number): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  // x=东, y=上, z=南
  return new THREE.Vector3(
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    Math.cos(el) * Math.cos(az),
  ).normalize();
}

export class AtmosphericSky {
  readonly mesh: THREE.Mesh;
  private uniforms: { [k: string]: THREE.IUniform };

  constructor(radius = 80000) {
    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uTurbidity: { value: 5.0 },
      uRayleigh: { value: 2.5 },
      uMieCoefficient: { value: 0.005 },
      uMieDirectionalG: { value: 0.8 },
      uHorizonTint: { value: 0.0 },
      uSunColor: { value: new THREE.Color(1.0, 0.95, 0.85) },
    };
    const geo = new THREE.SphereGeometry(radius, 32, 16);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
  }

  /** 跟随相机位置 (但保持方向不变，做出"无限远"效果) */
  followCamera(camPos: THREE.Vector3) {
    this.mesh.position.copy(camPos);
  }

  update(p: AtmosphereParams) {
    const sunDir = sunDirectionFrom(p.sunAzimuth, p.sunElevation);
    (this.uniforms.uSunDir.value as THREE.Vector3).copy(sunDir);
    this.uniforms.uTurbidity.value = p.turbidity;
    this.uniforms.uRayleigh.value = p.rayleigh;
    this.uniforms.uMieCoefficient.value = p.mieCoefficient;
    this.uniforms.uMieDirectionalG.value = p.mieDirectionalG;
    this.uniforms.uHorizonTint.value = p.horizonTint;

    // 太阳颜色：仰角低时变暖 (日出/日落色)
    const elev = Math.max(0, p.sunElevation) / 90;
    const warm = new THREE.Color(1.6, 0.7, 0.3);   // 日落
    const noon = new THREE.Color(1.0, 0.96, 0.88); // 正午
    const col = warm.clone().lerp(noon, elev);
    (this.uniforms.uSunColor.value as THREE.Color).copy(col);
  }

  /** 给场景用作方向光的方向 */
  getSunDirection(): THREE.Vector3 {
    return (this.uniforms.uSunDir.value as THREE.Vector3).clone();
  }

  getSunColor(): THREE.Color {
    return (this.uniforms.uSunColor.value as THREE.Color).clone();
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
