/**
 * VolumetricCloudPass
 * =====================================================================
 * 把体积云着色器包装成 EffectComposer 可用的 ShaderPass。
 *
 * 这个 pass 读取前一 pass 的输出 (tDiffuse, 即已渲染的场景:
 * AtmosphericSky + 地形 + 机体 + 已有的体积雾)，在上面叠加体积云，
 * 输出到下一 pass (Bloom / DOF 等)。
 *
 * 关键集成点：
 *   - uniforms.uInvProjection / uInvView 由外部每帧调用 update()
 *     传入相机矩阵 — 用于从屏幕 UV 反推世界空间视线方向。
 *   - uniforms.uSunDir / uSunColor 由 EngineLabRenderer 从
 *     AtmosphericSky 同步过来，保证云的光照与天光一致。
 *   - uniforms.uTime 由外部累加 dt。
 *   - defines.MAX_STEPS / MAX_LIGHT_STEPS 由 setQuality() 切换,
 *     触发 shader 重编译。
 *
 * 性能注意：
 *   - 体积云 pass 大约花费 1-3ms (medium) 到 5-8ms (ultra) 在
 *     RTX 3060 上, 1080p 全分辨率。如果用户开启后帧率暴跌, 建议
 *     降到 medium 或低档。
 *   - 半分辨率渲染是未来的优化方向 (需要双 RT + 上采样), 当前
 *     版本直接全分辨率渲染以保证质量。
 */

import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import {
  CLOUD_VERTEX_SHADER,
  CLOUD_FRAGMENT_SHADER,
} from './shaders';
import {
  type CloudProfile,
  type CloudQuality,
  CLOUD_QUALITY_PRESETS,
  parseColorHex,
} from './params';

/** 创建一个全新的 VolumetricCloudPass (含 ShaderMaterial + uniforms) */
export function createVolumetricCloudPass(): ShaderPass {
  const pass = new ShaderPass({
    uniforms: {
      tDiffuse:      { value: null as THREE.Texture | null },
      uInvProjection: { value: new THREE.Matrix4() },
      uInvView:       { value: new THREE.Matrix4() },
      uInvViewProj:   { value: new THREE.Matrix4() },
      uCameraPos:     { value: new THREE.Vector3() },
      uSunDir:        { value: new THREE.Vector3(0, 1, 0) },
      uSunColor:      { value: new THREE.Color(1.0, 0.96, 0.88) },
      uAmbientColor:  { value: new THREE.Color(0.66, 0.75, 0.85) },
      uSunIntensity:  { value: 1.0 },
      uTime:          { value: 0.0 },
      uCoverage:      { value: 0.55 },
      uDensity:       { value: 1.0 },
      uWindSpeed:     { value: 0.15 },
      uCloudBottom:   { value: 1200.0 },
      uCloudTop:      { value: 2400.0 },
      uResolution:    { value: new THREE.Vector2(1920, 1080) },
      uTerrainDepth:  { value: null as THREE.Texture | null },
      uDepthOn:       { value: 0 },
    },
    vertexShader:   CLOUD_VERTEX_SHADER,
    fragmentShader: CLOUD_FRAGMENT_SHADER,
    defines: {
      MAX_STEPS: String(CLOUD_QUALITY_PRESETS.high.maxSteps),
      MAX_LIGHT_STEPS: String(CLOUD_QUALITY_PRESETS.high.maxLightSteps),
    },
  });

  pass.enabled = false;
  return pass;
}

/** 每帧更新云 pass 的相机相关 uniforms (调用方为 EngineLabRenderer)。
 *  depthTex/depthOn 可选: 传入场景深度贴图后开启「山挡云」深度截断,
 *  不传则保持旧行为 (无遮挡, 云铺满整层)。 */
export function updateCloudPassUniforms(
  pass: ShaderPass,
  camera: THREE.PerspectiveCamera,
  sunDir: THREE.Vector3,
  sunColor: THREE.Color,
  ambientColor: THREE.Color,
  sunIntensity: number,
  time: number,
  resolution: THREE.Vector2,
  depth?: { depthTex: THREE.Texture; invViewProj: THREE.Matrix4 },
): void {
  const u = pass.uniforms;
  // 逆矩阵 — 用 camera.projectionMatrixInverse / matrixWorld 的 inverse
  (u.uInvProjection.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
  (u.uInvView.value as THREE.Matrix4).copy(camera.matrixWorld);
  (u.uCameraPos.value as THREE.Vector3).copy(camera.position);
  if (depth) {
    (u.uInvViewProj.value as THREE.Matrix4).copy(depth.invViewProj);
    (u.uTerrainDepth.value as THREE.Texture | null) = depth.depthTex;
    u.uDepthOn.value = 1;
  } else {
    u.uDepthOn.value = 0;
  }
  (u.uSunDir.value as THREE.Vector3).copy(sunDir);
  (u.uSunColor.value as THREE.Color).copy(sunColor);
  (u.uAmbientColor.value as THREE.Color).copy(ambientColor);
  u.uSunIntensity.value = sunIntensity;
  u.uTime.value = time;
  (u.uResolution.value as THREE.Vector2).copy(resolution);
}

/** 应用 CloudProfile — 设置密度/覆盖/质量等参数 (会触发 shader 重编译) */
export function applyCloudProfile(
  pass: ShaderPass,
  profile: CloudProfile,
): void {
  const u = pass.uniforms;
  pass.enabled = profile.enabled;
  u.uCoverage.value = profile.coverage;
  u.uDensity.value = profile.density;
  u.uWindSpeed.value = profile.windSpeed;
  u.uCloudBottom.value = profile.cloudBottom;
  u.uCloudTop.value = profile.cloudTop;
  u.uSunIntensity.value = profile.sunIntensity;
  (u.uAmbientColor.value as THREE.Color).copy(parseColorHex(profile.ambientColor));

  // 质量档位 — 切换 MAX_STEPS / MAX_LIGHT_STEPS (触发重编译)
  const desired = CLOUD_QUALITY_PRESETS[profile.quality as CloudQuality];
  const mat = pass.material as THREE.ShaderMaterial;
  const curSteps = parseInt(mat.defines.MAX_STEPS as string, 10);
  const curLight = parseInt(mat.defines.MAX_LIGHT_STEPS as string, 10);
  if (curSteps !== desired.maxSteps || curLight !== desired.maxLightSteps) {
    mat.defines.MAX_STEPS = String(desired.maxSteps);
    mat.defines.MAX_LIGHT_STEPS = String(desired.maxLightSteps);
    mat.needsUpdate = true;
  }
}

/** 销毁 pass 内部资源 */
export function disposeCloudPass(pass: ShaderPass): void {
  pass.dispose();
}
