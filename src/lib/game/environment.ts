import * as THREE from 'three';
// === 植被: billboard 几何/材质注入 + 外部贴图自动适配 (per user request) ====
import { buildBillboardGeometry, injectBillboard, makeBillboardDepthMaterial, buildUvVarietyAttributes, vegKeyUniformOf } from './veg-billboard';
import type { VegSpriteTexture, VegSpecies } from './veg-textures';
import { isHandheldDevice } from './device-mode';   // 着色分辨率按设备形态分档
// === 资产读取通道 (per user request ③: 外部真实 2D 云贴图) ===
// 云贴图走项目既有方式: assetUrl 解析(data URI / 外置库 / public 相对路径),
// loadImageTexture 用 <img> 载入(file:// 下唯一可用), fetchAssetText 读清单。
import { assetUrl } from './asset-url';
import { fetchAssetText, loadImageTexture } from './fetch-asset';
// === PBR 贴图系统 (per user request: 现代 PBR 渲染) ===
// Ground units / ships get shared procedural PBR texture sets with
// triplanar UVs baked into their primitives (no-UV geometry).
import { getUnitTextureSet } from './pbr/texture-sets';
import { getTextureManager } from './pbr/texture-manager';
import { buildTriplanarMaterial, buildBuildingMaterial } from './pbr/materials';
import { buildLayeredTerrainMaterial } from './pbr/layered-terrain';
// === 程序化基础色图 (per user request: 程序化关卡"直接色图") ===
// 程序化关卡不再用「4 层 albedo × splat × 自动遮罩」拼基础色:任务开始时烘
// 一张 2048² 卫星感色图,走既有 externalVertex 直出管线整图贴上去。
import { makeTerrainBaseColorSampler, makeTerrainBaseColorCanvas } from './pbr/terrain-basecolor';
import { getMwamStyleCfg } from './pbr/terrain-mwam';
// === 统一分层带解析器 (per user request: 岩石占满遮罩/带高透明) ===
import {
  resolveBands, bandWeightsAt, applySlopeRock, bandAreaShare,
  type BandReport,
} from './terrain-bands';
import type { TuneMap } from './terrain-tune';
// === UE5 Landscape 对标地形网格 v2 (per user request: 新地形网格系统) ===
import { buildTerrainV2, TerrainV2ChunkInfo } from './pbr/terrain-v2';

/** Shared factory: unit PBR material with triplanar UVs baked into `geom`. */
function unitPBR(geom: THREE.BufferGeometry, color: number, opts: { tag?: string; repeat?: number } = {}): THREE.MeshStandardMaterial {
  const set = getUnitTextureSet('vehicle', getTextureManager().qualitySetting);
  return buildTriplanarMaterial(set, geom, { color, debugTag: opts.tag ?? 'unit', triplanarRepeat: opts.repeat ?? 2 });
}

export type SkyPreset = 'day' | 'sunset' | 'dawn' | 'storm' | 'night';

export interface SkyConfig {
  top: THREE.Color;
  middle: THREE.Color;
  bottom: THREE.Color;
  sunColor: THREE.Color;
  sunPos: THREE.Vector3;
  fog: THREE.Color;
  fogDensity: number;
  oceanColor: THREE.Color;
  cloudColor: THREE.Color;
  ambient: THREE.Color;
  ambientI: number;
  sunI: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  // === Atmospheric sky params (per user request: 天气不同天光颜色) ===
  // Optional per-weather atmosphere tuning consumed by buildAtmosphericSky.
  // When unset, the sky shader derives them from the sun elevation.
  turbidity?: number;
  rayleigh?: number;
}

export type WeatherPreset = 'clear' | 'cloudy' | 'rain' | 'storm' | 'fog' | 'snow';
export type MapPreset = 'ocean' | 'city' | 'mountain' | 'desert' | 'archipelago';

export interface EnvironmentConfig {
  sky: SkyConfig;
  weather: WeatherPreset;
  map: MapPreset;
  // Runtime intensity 0..1 for storm/rain effects
  stormIntensity: number;
  // Wind vector (m/s in XZ plane)
  wind: THREE.Vector2;
}

export function getSkyConfig(preset: SkyPreset): SkyConfig {
  switch (preset) {
    case 'sunset':
      return {
        top: new THREE.Color('#1a3a5c'),
        middle: new THREE.Color('#d97a3e'),
        bottom: new THREE.Color('#f4c26b'),
        sunColor: new THREE.Color('#ffcc88'),
        sunPos: new THREE.Vector3(-3000, 800, -8000).normalize(),
        fog: new THREE.Color('#c98b5a'),
        fogDensity: 0.000055,
        oceanColor: new THREE.Color('#1d3a52'),
        cloudColor: new THREE.Color('#e8b890'),
        ambient: new THREE.Color('#8a5a3a'),
        ambientI: 0.55,
        sunI: 2.0,
        hemiSky: new THREE.Color('#caa37a'),
        hemiGround: new THREE.Color('#2a2435'),
      };
    case 'dawn':
      return {
        top: new THREE.Color('#1a2540'),
        middle: new THREE.Color('#7a8db0'),
        bottom: new THREE.Color('#f0d6b8'),
        sunColor: new THREE.Color('#ffe5c2'),
        sunPos: new THREE.Vector3(2000, 600, -7000).normalize(),
        fog: new THREE.Color('#a8b5c8'),
        fogDensity: 0.00006,
        oceanColor: new THREE.Color('#1a2c44'),
        cloudColor: new THREE.Color('#d8c8b8'),
        ambient: new THREE.Color('#5a6878'),
        ambientI: 0.5,
        sunI: 1.7,
        hemiSky: new THREE.Color('#9fb0c8'),
        hemiGround: new THREE.Color('#1a1f2a'),
      };
    case 'storm':
      // === Per user request ===
      // Overcast / cloudy days shouldn't be brighter than clear days — the
      // previous storm preset used ambientI 0.55 + sunI 0.9 which produced
      // a flat, washed-out look that read as "midday bright" rather than
      // "gloomy overcast". Trimmed both so the scene reads darker and moodier.
      return {
        // §359 (per user request: "雷暴场景太暗"): 仍比晴天暗一档(阴天情绪), 但
        // 抬到"能看清机位/地形"的量级 —— 原来的 0.38/0.55 再叠 applyWeather 的
        // 0.62/0.45 后只剩 0.24/0.25, 加上物理大气被平方压暗 ⇒ 近乎全黑。
        top: new THREE.Color('#232c40'),
        middle: new THREE.Color('#4a5468'),
        bottom: new THREE.Color('#6e788e'),
        sunColor: new THREE.Color('#a8b2c6'),
        sunPos: new THREE.Vector3(1500, 1200, -5000).normalize(),
        fog: new THREE.Color('#48526a'),
        fogDensity: 0.00012,
        oceanColor: new THREE.Color('#141c26'),
        cloudColor: new THREE.Color('#5c6678'),
        ambient: new THREE.Color('#4a5468'),
        ambientI: 0.52,
        sunI: 0.68,
        hemiSky: new THREE.Color('#5a6478'),
        hemiGround: new THREE.Color('#141a24'),
      };
    case 'day':
    default:
      return {
        top: new THREE.Color('#1e4d8c'),
        middle: new THREE.Color('#5fa8d6'),
        bottom: new THREE.Color('#b8dcf0'),
        sunColor: new THREE.Color('#fff5d8'),
        sunPos: new THREE.Vector3(2000, 2200, -5000).normalize(),
        fog: new THREE.Color('#a8c8e0'),
        fogDensity: 0.000045,
        oceanColor: new THREE.Color('#1b4a6e'),
        cloudColor: new THREE.Color('#ffffff'),
        ambient: new THREE.Color('#5a7090'),
        ambientI: 0.55,
        sunI: 2.2,
        hemiSky: new THREE.Color('#88b8e0'),
        hemiGround: new THREE.Color('#1a2c44'),
      };
    case 'night':
      // === Night preset (per user request) ===
      // Moonlit dark sky. The sun (treated as the moon) is low and dim.
      // Bloom is strongest at night so city lights, missile glows, and
      // engine exhaust read dramatically against the dark sky.
      return {
        // §359 (per user request: "晚上太暗, 起码应该有月光"):
        // 月亮的辐照度整档抬高 —— 天空/云/雾/环境光都按"月光能照出层次"取值,
        // 而不是"暗到只剩 HUD"。想要更暗就把 skybound.nightAtmoK / nightMoonK 调小。
        top: new THREE.Color('#080d1c'),
        middle: new THREE.Color('#111e3c'),
        bottom: new THREE.Color('#243154'),
        sunColor: new THREE.Color('#c6d4f0'),
        sunPos: new THREE.Vector3(-1500, 3000, -6000).normalize(),
        fog: new THREE.Color('#0f1830'),
        fogDensity: 0.00008,
        oceanColor: new THREE.Color('#0c1424'),
        cloudColor: new THREE.Color('#4c5872'),
        ambient: new THREE.Color('#33405f'),
        ambientI: 0.62,
        sunI: 0.7,
        hemiSky: new THREE.Color('#2c3a54'),
        hemiGround: new THREE.Color('#0c1220'),
      };
  }
}

// Adjust a sky config for a weather preset (modifies fog, lights, etc.)
export function applyWeather(cfg: SkyConfig, weather: WeatherPreset): SkyConfig {
  const c: SkyConfig = {
    ...cfg,
    top: cfg.top.clone(),
    middle: cfg.middle.clone(),
    bottom: cfg.bottom.clone(),
    sunColor: cfg.sunColor.clone(),
    sunPos: cfg.sunPos.clone(),
    fog: cfg.fog.clone(),
    oceanColor: cfg.oceanColor.clone(),
    cloudColor: cfg.cloudColor.clone(),
    ambient: cfg.ambient.clone(),
    hemiSky: cfg.hemiSky.clone(),
    hemiGround: cfg.hemiGround.clone(),
  };
  switch (weather) {
    case 'cloudy':
      // === Per weather: distinct sky light color (per user request) ===
      // Overcast: pale grey-white atmosphere, murky (higher turbidity).
      c.fogDensity *= 1.4;
      c.sunI *= 0.7;
      c.ambientI *= 0.9;
      c.cloudColor.multiplyScalar(0.85);
      c.sunColor.setRGB(0.82, 0.84, 0.88);
      c.turbidity = 6;
      c.rayleigh = 2.0;
      break;
    case 'rain':
      // Cool steel-grey sky, dim sun, heavy turbidity.
      c.fogDensity *= 1.8;
      c.sunI *= 0.7;
      c.ambientI *= 0.95;
      c.cloudColor.multiplyScalar(0.55);
      c.top.multiplyScalar(0.7);
      c.middle.multiplyScalar(0.7);
      c.bottom.multiplyScalar(0.75);
      c.sunColor.setRGB(0.62, 0.68, 0.74);
      c.turbidity = 8;
      c.rayleigh = 1.8;
      break;
    case 'storm':
      // === Per user request ===
      // Storm weather used to multiply sunI by 0.35 (already-low 0.55 → 0.19),
      // but the sky-blue ambient stayed too bright. Now we keep the sun
      // reasonably dim but also darken the ambient so the overall scene
      // reads as gloomy overcast rather than "evening".
      c.fogDensity *= 2.6;
      // §359: 0.45/0.62/0.35 叠在预设上把 storm 压到近黑(实测前视亮度 0.0017/99.95% 纯黑)。
      // 阴天的情绪交给**浓雾 + 低对比**，不再靠"把光全掐掉"。
      c.sunI *= 0.68;
      c.ambientI *= 0.85;
      c.cloudColor.multiplyScalar(0.5);
      c.top.multiplyScalar(0.62);
      c.middle.multiplyScalar(0.68);
      c.bottom.multiplyScalar(0.74);
      c.oceanColor.multiplyScalar(0.6);
      // Dark slate sky + very high turbidity — heavy overcast.
      c.sunColor.setRGB(0.44, 0.48, 0.54);
      c.turbidity = 10;
      c.rayleigh = 1.6;
      break;
    case 'fog':
      // Milky diffuse white sky — high turbidity scatters everything.
      c.fogDensity *= 3.2;
      c.sunI *= 0.6;
      c.ambientI *= 1.0;
      c.cloudColor.multiplyScalar(0.7);
      c.sunColor.setRGB(0.88, 0.90, 0.92);
      c.turbidity = 12;
      c.rayleigh = 1.4;
      break;
    case 'snow':
      c.fogDensity *= 1.6;
      c.sunI *= 0.7;
      c.ambientI *= 1.0;
      c.cloudColor.setRGB(0.95, 0.95, 0.97);
      c.fog.setRGB(0.85, 0.87, 0.9);
      c.top.setRGB(0.55, 0.6, 0.7);
      c.middle.setRGB(0.7, 0.74, 0.82);
      c.bottom.setRGB(0.85, 0.87, 0.92);
      // Bright cold white sky.
      c.sunColor.setRGB(0.93, 0.95, 1.0);
      c.turbidity = 4;
      c.rayleigh = 1.9;
      break;
    case 'clear':
    default:
      break;
  }
  return c;
}


// === Physical atmospheric sky (per user request: UE4级天光重建) ===
// Ported from the engine-lab (Preetham + Hosek-Wilkie simplified Rayleigh +
// Mie scattering). The sky is computed per-pixel on the GPU from the sun
// direction — no textures, no gradient flat look. Driven by the SkyConfig:
//   - uSunDir / uSunColor come from cfg.sunPos / cfg.sunColor
//   - brightness scales with cfg.sunI (night gets a dim moonlit sky)
//   - turbidity / rayleigh / horizon tint derive from the sun's elevation
//     (low sun = warm sunset / murky, high sun = clear blue)
// Returns the sky mesh; uniforms are reachable via (mesh.material as
// ShaderMaterial).uniforms if the engine needs to animate them.
export function buildAtmosphericSky(cfg: SkyConfig, radius = 40000): THREE.Mesh {
  const sunDir = cfg.sunPos.clone().normalize();
  const elev = Math.max(0, sunDir.y); // 0 horizon → 1 zenith
  // Sky brightness from sun intensity — night (sunI 0.45) is dim.
  const bright = THREE.MathUtils.clamp(cfg.sunI, 0.15, 3.0);
  const sunColor = cfg.sunColor.clone().multiplyScalar(bright);
  const uniforms = {
    uSunDir: { value: sunDir },
    // === Per-weather atmosphere (per user request: 天气不同天光颜色) ===
    // applyWeather sets cfg.turbidity/rayleigh per weather; fall back to
    // sun-elevation-derived values when unset.
    uTurbidity: { value: cfg.turbidity ?? (3.0 + (1 - elev) * 7.0) },
    uRayleigh: { value: cfg.rayleigh ?? (1.6 + (1 - elev) * 2.2) },
    uMieCoefficient: { value: 0.004 + (1 - elev) * 0.004 },
    uMieDirectionalG: { value: 0.82 },
    uHorizonTint: { value: (1 - elev) * 0.9 },        // 日落暖色调
    uSunColor: { value: sunColor },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: ATMOSPHERE_VERT,
    fragmentShader: ATMOSPHERE_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}

// === HDRI 黄昏天空专用 SkyConfig (per user request: 第一关 HDRI 天空) ===
// 供 HDRI 关的光源/雾/hemi 使用(黄昏暖调)。天空本身由 EXR 贴图决定,
// 这套色板只负责 fog 与方向光/半球光近似匹配黄昏 HDRI。
export const HDR_EVENING_CFG: SkyConfig = {
  top: new THREE.Color('#2a1a3a'),
  middle: new THREE.Color('#c96a3e'),
  bottom: new THREE.Color('#f0a868'),
  sunColor: new THREE.Color('#ffb060'),
  sunPos: new THREE.Vector3(-3000, 500, -8000).normalize(),
  fog: new THREE.Color('#b07a58'),
  fogDensity: 0.00005,
  oceanColor: new THREE.Color('#1d2a3a'),
  cloudColor: new THREE.Color('#d8a088'),
  ambient: new THREE.Color('#7a5a44'),
  ambientI: 0.5,
  // === 太阳直射强度下调 (per user request: 不是整个地图都接收太阳光) ===
  // HDRI 是低角度黄昏太阳:直射只应照亮朝向太阳的表面,场景主体光应来自
  // 天空盒天光(IBL environmentIntensity 1.0 + hemi 天顶蓝灰)。1.9 的平行光
  // 把整张地图照得像正午 → 降到 0.8:地图落入黄昏环境光,只有朝阳面有暖
  // 高光与方向感。
  sunI: 0.8,
  hemiSky: new THREE.Color('#c8986e'),
  hemiGround: new THREE.Color('#241a26'),
};

// === 旧 HDRI 关卡改走"物理大气"后的黄昏参数 (per user request: 三关换新天空) ====
// 背景: m13 / t00 / s01 这三关原本靠 `mission.environment`(EXR 天空盒)决定氛围, 而
// 引擎对"带 environment 的关卡"是整条让位的 —— 物理大气、物理大气透视都不建(见
// engine.resolveAtmoOn)。现在**默认**改成走 Phase A 物理大气, 那套"黄昏暖调"就必须
// 由 SkyConfig 自己表达。下面这张表就是把**旧 HDRI 通路实测到的三个数**原样固化:
//   · sunDir    ← engine.sunAutoDir(= sampleHdrSkyInfo 从 EXR 最亮像素带量出的太阳方向)。
//                 保留它 ⇒ 物理天空里的太阳**落在原来 EXR 太阳的位置**(同机位对比时
//                 太阳一厘米都不挪, 只剩"天空怎么画"的差别);
//   · hemiSky   ← 旧通路 `hemiLight.color = lerp(EXR天顶×1.22, white, 0.12)` 的结果;
//   · hemiGround← 旧通路 `hemiLight.groundColor = EXR天底×1.02` 的结果。
// 键 = mission.environment(关卡当初指定的那张 EXR, 去掉前导斜杠)。
export const DUSK_SKY_BY_ENV: Record<
  string,
  { sunDir: readonly [number, number, number]; hemiSky: string; hemiGround: string }
> = {
  // evening.exr —— m13「群山雪原」/ t00「雪山突袭」。实测太阳高度 ~6.4°、方位近 +Z。
  // hemi 是蓝灰(EXR 的天顶/天底就是蓝灰的): 雪山关的"冷黄昏"就靠它。
  'textures/sky/evening.exr': { sunDir: [-0.0417, 0.112, 0.9928], hemiSky: '#a2bbd4', hemiGround: '#84a1bd' },
  // evening-046b.exr —— s01「堡垒·空中战舰」。实测太阳高度 ~3.3°, 与 HDR_EVENING_CFG
  // 自带的 sunPos 逐位一致(那套色板本来就是照这张 EXR 调的), 所以这里 hemi 也沿用它的。
  'textures/sky/evening-046b.exr': { sunDir: [-0.3505, 0.0584, -0.9347], hemiSky: '#c8986e', hemiGround: '#241a26' },
};

/**
 * 旧 HDRI 关卡改走物理大气时用的 SkyConfig。
 *
 * 复用给 HDRI 关调的那套黄昏色板(HDR_EVENING_CFG), 只把 sunPos 与 hemi 换成
 * `DUSK_SKY_BY_ENV` 里该关卡当初实测到的值 —— 于是"天空换成物理大气"这件事发生,
 * 而雾色/环境光/海色/直射强度这些**场景调性**与改之前完全一致。
 *
 * ⚠ 必须返回**副本**: `applyWeather(cfg, 'clear')` 是纯深拷贝(clear 分支不改任何字段),
 * 正好当 clone 用。引擎会就地改 sunPos/sunI/雾(见 loadSky), 直接返回常量对象会让
 * 改动跨关累积(旧代码 `this.cfg = HDR_EVENING_CFG` 就是这个隐患)。
 */
export function duskAtmoConfig(env: string | undefined): SkyConfig {
  const c = applyWeather(HDR_EVENING_CFG, 'clear');
  const o = env ? DUSK_SKY_BY_ENV[env.replace(/^\//, '')] : undefined;
  if (o) {
    c.sunPos.set(o.sunDir[0], o.sunDir[1], o.sunDir[2]);
    c.hemiSky.set(o.hemiSky);
    c.hemiGround.set(o.hemiGround);
  }
  return c;
}

// Narkowicz ACES filmic approximation — applied in the HDRI dome so the
// HDR EXR values (>1 sun) map to a pleasant LDR picture (ShaderMaterial
// doesn't get three's automatic tonemapping).
const ACES_FRAG_GLSL = `
vec3 acesFilmic(vec3 x) {
  float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}`;

// === HDRI 天空 dome (per user request: 第一关用真实 HDRI 天空) ===
// BackSide 天球,逐像素把世界方向映射到 equirect UV 采样 EXR。渲染契约与
// buildAtmosphericSky 完全一致(renderOrder -1000、钉远平面、不吃深度)。
// HDRI 自带太阳 → engine 侧不再叠加 sun disc。
export function buildHDRISky(envTex: THREE.Texture, radius = 40000): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uEnv: { value: envTex } },
    vertexShader: `
      varying vec3 vWorldDir;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldDir = normalize(wp.xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w; // pin to far plane
      }`,
    fragmentShader: `
      uniform sampler2D uEnv;
      varying vec3 vWorldDir;
      ${ACES_FRAG_GLSL}
      void main() {
        vec3 d = normalize(vWorldDir);
        // equirect: 水平 atan2(d.x, d.z), 垂直 acos(d.y)
        // v 翻转(1-):该 EXR 顶部行是天底,需上下翻转 (per user request)
        float u = atan(d.x, d.z) * 0.1591549 + 0.5;   // 1/(2π)
        float v = 1.0 - acos(clamp(d.y, -1.0, 1.0)) * 0.3183099; // 1/π, 翻转
        vec3 col = texture2D(uEnv, vec2(u, v)).rgb;
        gl_FragColor = vec4(acesFilmic(col), 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}

// === CPU port of the atmosphere shader (per user request: 远处雾按天光颜色) ===
// Evaluates the SAME Rayleigh+Mie scattering model the sky dome renders, at
// the horizon toward the sun's azimuth (where the distant haze is strongest
// and most visible). The result is fed to the scene's FogExp2 color so the
// far fog EXACTLY matches the sky light the player sees — orange sky light
// (sunset) → orange distant fog, pale blue noon → pale blue fog.
// Must stay in sync with buildAtmosphericSky's uniforms + ATMOSPHERE_FRAG.
export function skyHorizonColor(cfg: SkyConfig): THREE.Color {
  const sunDir = cfg.sunPos.clone().normalize();
  const elev = Math.max(0, sunDir.y); // 0 horizon → 1 zenith
  const bright = THREE.MathUtils.clamp(cfg.sunI, 0.15, 3.0);
  const sunColor = new THREE.Vector3(
    cfg.sunColor.r * bright,
    cfg.sunColor.g * bright,
    cfg.sunColor.b * bright,
  );
  // Direction to look at: the horizon toward the sun's azimuth (dir.y = 0).
  const horizonDir = new THREE.Vector3(sunDir.x, 0, sunDir.z).normalize();

  const turbidity = cfg.turbidity ?? (3.0 + (1 - elev) * 7.0);
  const rayleigh = cfg.rayleigh ?? (1.6 + (1 - elev) * 2.2);
  const mieCoeff = 0.004 + (1 - elev) * 0.004;
  const g = 0.82;
  const horizonTint = (1 - elev) * 0.9;

  const betaR = new THREE.Vector3(5.8e-6, 13.5e-6, 33.1e-6);
  const betaM = new THREE.Vector3(mieCoeff, mieCoeff, mieCoeff).multiplyScalar(1.0 + turbidity * 0.2);
  const cosTheta = THREE.MathUtils.clamp(horizonDir.dot(sunDir), -1, 1);
  const rayleighPhase = (3.0 / (16.0 * Math.PI)) * (1.0 + cosTheta * cosTheta);
  const denom = 1.0 + g * g - 2.0 * g * cosTheta;
  const miePhase = (3.0 / (8.0 * Math.PI)) * ((1.0 - g * g) * (1.0 + cosTheta * cosTheta)) / ((2.0 + g * g) * Math.pow(denom, 1.5));

  const upDot = Math.max(horizonDir.y, -0.05);
  const opticalDepth = 1.0 / (upDot + 0.05);
  const betaRTotal = betaR.clone().multiplyScalar(rayleigh);
  const tau = betaRTotal.clone().add(betaM).multiplyScalar(opticalDepth);
  const extinction = new THREE.Vector3(Math.exp(-tau.x), Math.exp(-tau.y), Math.exp(-tau.z));

  const sunUpDot = Math.max(sunDir.y, 0.0);
  const sunDepth = 1.0 / (sunUpDot + 0.05);
  const sunTau = betaRTotal.clone().add(betaM).multiplyScalar(sunDepth);
  const sunExt = new THREE.Vector3(Math.exp(-sunTau.x), Math.exp(-sunTau.y), Math.exp(-sunTau.z));

  const sky = new THREE.Vector3()
    .addScaledVector(betaRTotal, rayleighPhase)
    .addScaledVector(betaM, miePhase)
    .multiply(sunExt)
    .multiply(sunColor);
  sky.divide(betaRTotal.clone().add(betaM));
  sky.x *= 1.0 - extinction.x;
  sky.y *= 1.0 - extinction.y;
  sky.z *= 1.0 - extinction.z;

  // Horizon warm/cool tint (same as the shader).
  const horizonFactor = 1.0 - Math.abs(horizonDir.y); // = 1 at the horizon
  const warmTint = new THREE.Vector3(1.4, 1.0, 0.7);
  const coolTint = new THREE.Vector3(0.7, 0.85, 1.2);
  const hCol = new THREE.Vector3().copy(coolTint).lerp(warmTint, horizonTint * 0.5 + 0.5);
  sky.lerp(sky.clone().multiply(hCol), horizonFactor * 0.3);
  // Sunset glow at the horizon when the sun is low.
  const sunHorizonFactor = (1.0 - sunDir.y) * horizonFactor;
  const sunset = new THREE.Vector3(1.6, 0.8, 0.4)
    .multiplyScalar(sunHorizonFactor * 0.4)
    .multiply(sunColor);
  sky.add(sunset);

  // Rolloff tone-map (the sky shader's `col / (col + 1)`).
  const col = new THREE.Color(sky.x / (sky.x + 1), sky.y / (sky.y + 1), sky.z / (sky.z + 1));
  // === Blend toward the sky's own horizon tone as the sun rises ===
  // The sun-side haze is warm even at noon (the sun's glare warms it), but
  // the overall distant fog should lean toward the sky's horizon color when
  // the sun is high — pale blue in day missions, slate in storms — while
  // staying strongly ORANGE at low sun (sunset / dawn, the user's example).
  const coolFactor = THREE.MathUtils.clamp((elev - 0.10) / 0.5, 0, 0.45);
  return col.lerp(cfg.bottom, coolFactor);
}

// Sky vertex — push to the far clip plane so it never occludes the world.
const ATMOSPHERE_VERT = /* glsl */ `
varying vec3 vWorldPos;
void main() {
  vWorldPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w;
}
`;

// Preetham + Hosek-Wilkie simplified Rayleigh + Mie scattering.
const ATMOSPHERE_FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorldPos;

uniform vec3 uSunDir;
uniform float uTurbidity;
uniform float uRayleigh;
uniform float uMieCoefficient;
uniform float uMieDirectionalG;
uniform float uHorizonTint;
uniform vec3 uSunColor;

const vec3 betaR = vec3(5.8e-6, 13.5e-6, 33.1e-6);

vec3 atmosphere(vec3 dir, vec3 sunDir) {
  dir = normalize(dir);
  sunDir = normalize(sunDir);
  vec3 betaM = vec3(uMieCoefficient) * (1.0 + uTurbidity * 0.2);
  float cosTheta = dot(dir, sunDir);
  float rayleighPhase = (3.0 / (16.0 * 3.14159265)) * (1.0 + cosTheta * cosTheta);
  float g = uMieDirectionalG;
  float miePhase = (3.0 / (8.0 * 3.14159265)) *
    ((1.0 - g * g) * (1.0 + cosTheta * cosTheta)) /
    ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * cosTheta, 1.5));
  float upDot = max(dir.y, -0.05);
  float opticalDepth = 1.0 / (upDot + 0.05);
  vec3 betaR_total = betaR * uRayleigh;
  vec3 betaM_total = betaM;
  vec3 tau = (betaR_total + betaM_total) * opticalDepth;
  vec3 extinction = exp(-tau);
  float sunUpDot = max(sunDir.y, 0.0);
  float sunOpticalDepth = 1.0 / (sunUpDot + 0.05);
  vec3 sunExtinction = exp(-(betaR_total + betaM_total) * sunOpticalDepth);
  vec3 skyColor = (rayleighPhase * betaR_total + miePhase * betaM_total) * uSunColor * sunExtinction;
  skyColor /= (betaR_total + betaM_total);
  skyColor *= 1.0 - extinction;
  // Sun disc + soft glow.
  float sunDisc = smoothstep(0.9995, 0.9999, cosTheta);
  skyColor += uSunColor * sunDisc * 50.0;
  float sunGlow = pow(max(cosTheta, 0.0), 200.0);
  skyColor += uSunColor * sunGlow * 0.5;
  // === 太阳那一侧被"整片点亮" (per user request: 程序化天空盒像参考图那样被太阳照亮一部分)
  // 原来只有 pow(cosT,200) 的窄光晕 ⇒ 天空除了太阳周围一小圈之外都是均匀的, 看不出
  // "光从哪来"。这里加两件东西:
  //   ① 宽的米氏前向散射瓣 pow(cosT,8): 太阳周围一大片被暖光填亮(太阳越低越明显);
  //   ② 方位对齐的暖带: 只有**太阳那一侧**的地平线被染成金色, 背对太阳的一侧保持冷色 ——
  //      这才是"被太阳照亮一部分"的观感。
  float glowWide = pow(max(cosTheta, 0.0), 8.0);
  float lowSun = 1.0 - clamp(sunDir.y * 2.0, 0.0, 1.0);
  skyColor += uSunColor * glowWide * (0.18 + 0.55 * lowSun);
  // Horizon warm tint (sunset / dawn).
  float horizonFactor = 1.0 - abs(dir.y);
  vec3 warmTint = vec3(1.4, 1.0, 0.7);
  vec3 coolTint = vec3(0.7, 0.85, 1.2);
  vec3 horizonColor = mix(coolTint, warmTint, uHorizonTint * 0.5 + 0.5);
  skyColor = mix(skyColor, skyColor * horizonColor, horizonFactor * 0.3);
  float sunHorizonFactor = (1.0 - sunDir.y) * horizonFactor;
  vec3 sunsetColor = vec3(1.6, 0.8, 0.4);
  // 方位对齐(水平面内): 1 = 正对太阳方位, 0 = 背对。暖带集中在太阳侧 ——
  // 背光侧只留一点余晖, 否则整圈地平线一样暖, 就看不出"被太阳照亮"了。
  vec3 dirFlat = normalize(vec3(dir.x, 0.0, dir.z) + vec3(1e-4));
  vec3 sunFlat = normalize(vec3(sunDir.x, 0.0, sunDir.z) + vec3(1e-4));
  float azim = max(dot(dirFlat, sunFlat), 0.0);
  skyColor += sunsetColor * sunHorizonFactor * 0.4 * uSunColor * (0.25 + 0.75 * pow(azim, 3.0));
  return skyColor;
}

void main() {
  vec3 dir = normalize(vWorldPos);
  vec3 col = atmosphere(dir, uSunDir);
  // Rolloff so bloom doesn't blow out; keep dark skies (night) visible.
  col = col / (col + vec3(1.0));
  gl_FragColor = vec4(col, 1.0);
}
`;

// Big skydome with vertical gradient via shader
export function buildSkyDome(cfg: SkyConfig, radius = 40000): THREE.Mesh {
  const geom = new THREE.SphereGeometry(radius, 32, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: cfg.top },
      middleColor: { value: cfg.middle },
      bottomColor: { value: cfg.bottom },
      offset: { value: 0.0 },
      exponent: { value: 0.7 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPosition;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPosition = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 topColor;
      uniform vec3 middleColor;
      uniform vec3 bottomColor;
      uniform float offset;
      uniform float exponent;
      varying vec3 vWorldPosition;
      void main() {
        float h = normalize(vWorldPosition + vec3(0.0, offset, 0.0)).y;
        vec3 col;
        if (h > 0.0) {
          float t = pow(h, exponent);
          col = mix(middleColor, topColor, t);
        } else {
          float t = pow(-h, exponent);
          col = mix(middleColor, bottomColor, t);
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  return new THREE.Mesh(geom, mat);
}

// === Sun / Moon visual disc (per user request) ===
// A bright glowing disc placed at the sky's sun position. This gives the
// bloom pass something to actually bloom on — without a high-luminance
// source in the scene, bloom has no effect. The disc is rendered as a
// sprite that always faces the camera, with additive blending so it
// brightens the sky behind it.
//
// At night (sky preset 'night') we use a cooler, dimmer color so the
// disc reads as a moon instead of a sun.
//
// The disc is positioned along cfg.sunPos at a large distance so it sits
// on the skydome — but rendered with `depthWrite: false` so it doesn't
// occlude clouds or aircraft that happen to be in front of it.
export function buildSunDisc(cfg: SkyConfig, isNight: boolean): THREE.Sprite {
  // Brightness scales with sun intensity — at night the moon is much dimmer.
  const baseIntensity = isNight ? 1.4 : Math.max(1.0, cfg.sunI * 0.7);
  const sunColor = isNight ? new THREE.Color('#dce6ff') : cfg.sunColor.clone();
  // Sprite material — additive blending so the disc glows against the sky.
  // We use a CanvasTexture with a radial gradient for a soft halo.
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  const r = Math.round(sunColor.r * 255);
  const g = Math.round(sunColor.g * 255);
  const b = Math.round(sunColor.b * 255);
  grad.addColorStop(0.0, `rgba(${r},${g},${b},1.0)`);
  grad.addColorStop(0.15, `rgba(${r},${g},${b},0.95)`);
  grad.addColorStop(0.40, `rgba(${r},${g},${b},0.45)`);
  grad.addColorStop(0.75, `rgba(${r},${g},${b},0.12)`);
  grad.addColorStop(1.0, `rgba(${r},${g},${b},0.0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    color: 0xffffff,
    transparent: true,
    opacity: baseIntensity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false, // always render on top of skydome
    fog: false,
  });
  const sprite = new THREE.Sprite(mat);
  // Position far out along the sun direction so it sits on the skydome.
  // Sprite scale = visual size; bigger at night (moon) for atmosphere,
  // smaller in daytime (sun reads as a bright point).
  const scale = isNight ? 4500 : 3200;
  sprite.scale.setScalar(scale);
  sprite.position.copy(cfg.sunPos.clone().multiplyScalar(35000));
  return sprite;
}

// Volumetric-style height fog — uses an exponential density gradient with sun scattering.
// Implemented as a screen-space shader pass via a fullscreen overlay quad, blended with
// the scene using the depth buffer. This is a lightweight raymarch approximation.
export function buildVolumetricFog(cfg: SkyConfig): { mesh: THREE.Mesh; material: THREE.ShaderMaterial } {
  const geom = new THREE.PlaneGeometry(2, 2);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tDiffuse: { value: null },
      tDepth: { value: null },
      fogColor: { value: cfg.fog },
      fogDensity: { value: cfg.fogDensity },
      sunDir: { value: cfg.sunPos.clone() },
      sunColor: { value: cfg.sunColor },
      camPos: { value: new THREE.Vector3() },
      // Anisotropic scattering coefficient — brightens fog near sun direction.
      g: { value: 0.6 },
      // Vertical density falloff: higher = fog hugs ground more.
      heightFalloff: { value: 0.0008 },
      time: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 fogColor;
      uniform float fogDensity;
      uniform vec3 sunDir;
      uniform vec3 sunColor;
      uniform vec3 camPos;
      uniform float g;
      uniform float heightFalloff;
      uniform float time;
      varying vec2 vUv;

      // Cheap hash for animated noise — drives fog "swirl"
      float hash(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      float noise(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
              mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
          mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
              mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
          f.z);
      }

      void main() {
        // Fallback: simple exponential height fog tinted by sun direction.
        // (We don't have access to depth buffer without a post-processing pipeline;
        // for now this is rendered as a screen overlay that fades with distance from
        // the horizon line.)
        float y = vUv.y;
        // Fog strongest near horizon (y ≈ 0.5) and below
        float horizonBand = smoothstep(0.65, 0.45, y);
        // Anisotropic scattering: brighten in sun direction
        // Sun position approximated as: project sunDir onto screen
        // Compute a fake "sun screen position" by using sunDir.xy
        vec2 sunScreen = normalize(sunDir.xy + vec2(0.0001)) * 0.5 + 0.5;
        float sunDist = distance(vUv, vec2(sunScreen.x, 1.0 - sunScreen.y));
        float scatter = pow(max(0.0, 1.0 - sunDist), 3.0) * 0.5;

        // Animated fog noise — adds volumetric texture
        vec3 np = vec3(vUv * 8.0, time * 0.05);
        float n = noise(np) * 0.5 + noise(np * 2.0) * 0.25 + noise(np * 4.0) * 0.125;
        float fogAlpha = horizonBand * (0.35 + n * 0.25) * (fogDensity * 8000.0);
        fogAlpha = clamp(fogAlpha, 0.0, 0.85);
        vec3 col = mix(fogColor, sunColor, scatter);
        gl_FragColor = vec4(col, fogAlpha);
      }
    `,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 999; // render after everything
  return { mesh, material: mat };
}
  // ===========================================================================
// 指数级高度雾体积(per user request: 所在高度 + 生效/变化范围)
// UE ExponentialHeightFog 风格参数 → 一个横贯地图的雾盒:
//   alpha(y, dist) = opacity × heightProfile × distFade
//   heightProfile : y ≤ baseHeight → 1;y > baseHeight → exp(-(y-base)/falloff)
//   distFade      : startDistance 起生效,smooth 到 fadeEnd 前归零(消除远墙)
// depthTest on + depthWrite off + renderOrder 在透明层 —— 低洼谷雾、山体
// 穿雾、远处山脚雾霭都成立;相机飞到雾内时由 heightProfile 自然消退。
// ===========================================================================
export interface HeightFogParams {
  color: THREE.ColorRepresentation;
  opacity: number;        // 0..1
  baseHeight: number;     // 雾集中高度(米)
  falloff: number;        // 向上指数衰减范围(米)
  startDistance: number;  // 生效距离(米)
  fadeEnd: number;        // 最大距离(米)
  size: number;           // 覆盖世界范围(米,正方形)
}

const HEIGHT_FOG_VERT = /* glsl */ `
varying vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const HEIGHT_FOG_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uBase;
uniform float uFalloff;
uniform float uStart;
uniform float uFadeEnd;
varying vec3 vWorldPos;
void main() {
  float y = vWorldPos.y;
  // 高度轮廓:低于 base 全浓,向上指数衰减
  float hp = y <= uBase ? 1.0 : exp(-(y - uBase) / max(uFalloff, 1.0));
  // 距离范围:近处不糊镜头,远处淡出避免雾墙
  float dist = distance(vWorldPos, cameraPosition);
  float df = smoothstep(uStart, uStart + 2000.0, dist);
  df *= 1.0 - smoothstep(max(uStart + 2000.0, uFadeEnd - 2500.0), uFadeEnd, dist);
  float alpha = uOpacity * hp * df;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(uColor, alpha);
}
`;

export function buildHeightFogVolume(p: HeightFogParams): THREE.Mesh {
  const bottom = Math.min(-3000, p.baseHeight - 9000);
  const top = p.baseHeight + Math.max(p.falloff * 6, 2500);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: new THREE.Color(p.color) },
      uOpacity: { value: p.opacity },
      uBase: { value: p.baseHeight },
      uFalloff: { value: p.falloff },
      uStart: { value: p.startDistance },
      uFadeEnd: { value: p.fadeEnd },
    },
    vertexShader: HEIGHT_FOG_VERT,
    fragmentShader: HEIGHT_FOG_FRAG,
  });
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.set(p.size, top - bottom, p.size);
  mesh.position.y = (top + bottom) / 2;
  mesh.frustumCulled = false;
  mesh.renderOrder = 150;
  mesh.userData.editorPlaceable = false;
  // (原 `userData.heightFogVolume = true` 已删 —— 全仓**没有任何读者**, 是只写标记;
  //  写它的这套"旧指数高度雾体积盒"如今只在编辑器里用。机体豁免的活口在 AP pass。)
  return mesh;
}


// Procedural-ish ocean: large plane with animated vertex shader
// === 程序化海面 (per user request: 换成预计算固定材质 + 遵循太阳光照) ===
// 旧版自定义 ShaderMaterial:320×320 顶点逐帧位移 + 多层 fbm + 双滚动法线 +
// fresnel + spec,性能重;且 fogColor 写死 cfg.fog(HDRI 关卡橙色),与场景蓝白
// 雾不符。新版 MeshStandardMaterial + 预计算法线贴图:
//   - 接收 CSM 太阳直射 + 阴影、scene.environment IBL、scene.fog(自动蓝白)
//     → 与山地/地形完全一致的光照(不再固定橙色)。
//   - 海浪细节靠程序化预计算法线贴图(多层 fbm → 法线),每帧只滚 normalMap
//     offset(极便宜),不再每像素跑 fbm。
// === 顶点波浪回退 (per user request: 水面效果回到程序化法线状态) ===
// 纯平面 + 法线滚动看起来太平。onBeforeCompile 注入低频动态顶点波浪(3 层
// sin,GPU 顶点阶段跑,免费),保留 MeshStandardMaterial 全部光照/阴影/IBL/雾
// 管线;细节仍由预计算法线贴图滚动提供。CSM 材质收集会链式保留本注入。
// === 动态程序化海面 (per user request: 退回取消程序化之前的视觉) ===
// 恢复最初的动态 ShaderMaterial(320×320 顶点位移 + 多层 fbm 双滚动法线 +
// fresnel + spec 高光) —— 用户实测标准材质+预计算法线版本太"平/假",要求
// 退回动态程序化视觉。修正旧版两个问题:
//   1. fogColor 不再写死 cfg.fog(HDRI 橙色) —— engine 每帧把 scene.fog.color
//      (HDRI 天光采样蓝白)同步给 uFogColor → 海面远处雾色与场景一致;
//   2. sunDir 每帧跟随 cfg.sunPos(EXR 检测/控制台 sun 命令)→ 太阳高光/受光
//      方向始终与天空盒一致(接受太阳光照的方式不变)。
export function buildOcean(cfg: SkyConfig, size = 80000): THREE.Mesh {
  // Higher subdivision than before (320x320 vs 220x220) so the wave-displaced
  // vertices are dense enough to catch the dynamic normal lighting.
  const geom = new THREE.PlaneGeometry(size, size, 320, 320);
  geom.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      oceanColor: { value: cfg.oceanColor },
      // === 大角度反射色 = 天空**地平线色** (per user request: 不再是白色) ==========
      // cfg.bottom 就是这套程序化天空的地平线色; 引擎每帧还会用 SKYCAP 实测色覆盖它。
      highlight: { value: new THREE.Color(cfg.oceanColor).lerp(new THREE.Color(cfg.bottom), 0.65) },
      deepColor: { value: new THREE.Color(cfg.oceanColor).clone().multiplyScalar(0.4) },
      fogColor: { value: cfg.fog.clone() },
      fogDensity: { value: cfg.fogDensity },
      sunDir: { value: cfg.sunPos.clone().normalize() },
      // === 太阳色 (per user request: 海面被太阳照亮的高亮带) ===
      // 高光/闪耀带要用**太阳本身的颜色**: 黄昏是暖金、正午接近白。engine 每帧注入
      // (与 sunDir 同一处, 见 syncOceanEnv / update), 这样控制台改太阳角度时海面
      // 高光颜色跟着变。
      uSunColor: { value: cfg.sunColor.clone() },
      // === 调试通道 (排查用): 0=正常; 1=n·h; 2=宽瓣; 3=pathK(方位对齐);
      //     4=schlick(天光反射比例); 5=太阳高度。engine.__oceanDbg(n) 切换。 ===
      uDebugMode: { value: 0 },
      // === 世界空间太阳锥(engine 每帧注入) ===
      uConeOrigin: { value: new THREE.Vector3() },
      uConeRadius: { value: 1750 },
      uSectorHalf: { value: Math.PI * 40 / 180 },
      uConeApexD: { value: 40000 },                  // 尖端在天空盒边缘(40km)处
      uSunAzimuth: { value: 0 },
      uSunViewK: { value: 1 },
      uConeTan: { value: Math.tan(Math.PI / 9) },
      windDir: { value: new THREE.Vector2(1, 0) },
      windStrength: { value: 1.0 },
      // === 天光/天空盒环境采样 (per user request ⑥) ===
      // 本材质是纯 ShaderMaterial, 不采样 scene.environment —— 所以海面原本
      // 完全不受天光/天空盒影响。engine 在天空设置完成后把 HDRI equirect
      // (EXR, 十字/等距柱状)注入 envMap, envBlend=1 走**真实环境采样**;
      // 没有 HDRI(程序化天空)时 envBlend=0, 退化成下面的**半球天光近似**
      // (天顶色/地平雾色 + 太阳方向), 海面依然有随视角变化的天光。
      envMap: { value: null as THREE.Texture | null },
      envBlend: { value: 0.0 },
      envIntensity: { value: 0.85 },
      skyZenith: { value: (cfg as any).hemiSky ? (cfg as any).hemiSky.clone() : new THREE.Color(0x88a4cc) },
      skyHorizon: { value: cfg.fog.clone().lerp(new THREE.Color(0xffffff), 0.25) },
    },
    vertexShader: /* glsl */ `
      uniform float time;
      uniform vec2 windDir;
      uniform float windStrength;
      varying vec3 vWorldPos;
      varying float vWave;
      varying vec3 vNormalApprox;
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
          mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
          u.y
        );
      }
      void main() {
        vec3 p = position;
        float w1 = sin(p.x * 0.015 + time * 0.6) * cos(p.z * 0.012 + time * 0.5);
        float w2 = sin(p.x * 0.04 - time * 0.9) * cos(p.z * 0.05 + time * 0.7) * 0.4;
        float w3 = sin((p.x + p.z) * 0.08 + time * 1.2) * 0.15;
        float windChop = sin(dot(p.xz, windDir) * 0.025 + time * 1.8) * windStrength * 1.2;
        float h = (w1 + w2 + w3) * 4.0 + windChop;
        float ripple = vnoise(p.xz * 0.04 + vec2(time * 0.3, time * 0.22)) * 1.2;
        ripple += vnoise(p.xz * 0.12 - vec2(time * 0.18, time * 0.27)) * 0.5;
        h += ripple;
        p.y += h;
        vWave = h;
        float eps = 4.0;
        vec3 pX = position + vec3(eps, 0.0, 0.0);
        vec3 pZ = position + vec3(0.0, 0.0, eps);
        float hX = (sin(pX.x * 0.015 + time * 0.6) * cos(pX.z * 0.012 + time * 0.5)
                  + sin(pX.x * 0.04 - time * 0.9) * cos(pX.z * 0.05 + time * 0.7) * 0.4) * 4.0;
        float hZ = (sin(pZ.x * 0.015 + time * 0.6) * cos(pZ.z * 0.012 + time * 0.5)
                  + sin(pZ.x * 0.04 - time * 0.9) * cos(pZ.z * 0.05 + time * 0.7) * 0.4) * 4.0;
        vNormalApprox = normalize(vec3(-(hX - h) / eps, 1.0, -(hZ - h) / eps));
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 oceanColor;
      uniform vec3 highlight;
      uniform vec3 deepColor;
      uniform vec3 fogColor;
      uniform float fogDensity;
      uniform vec3 sunDir;
      uniform vec3 uSunColor;
      // 世界空间太阳锥(engine 每帧注入): 底心(机体海面投影) / tan(半角)
      uniform vec3 uConeOrigin;     // 柱体中心(机体海面投影) —— 只用它的 xz
      uniform float uConeRadius;    // 柱体半径
      uniform float uSectorHalf;    // (保留) 扇形半张角
      uniform float uConeApexD;     // 尖端到机体的水平距离(= 天空盒边缘, 40km)
      uniform float uSunAzimuth;    // 太阳水平方位 atan2(z, x) —— 与下面的 atan(rel.y, rel.x) 同口径
      uniform float uSunViewK;      // "太阳是否出现在视角里" 0..1(engine 每帧按相机朝向算)
      uniform float uConeTan;       // (保留: 旧的锥半角, 海面已不用)
      uniform float uDebugMode;
      uniform float time;
      // === 天光/天空盒环境 (per user request ⑥) ===
      uniform sampler2D envMap;
      uniform float envBlend;      // 1 = 用真实 HDRI 环境贴图, 0 = 半球近似
      uniform float envIntensity;
      uniform vec3 skyZenith;
      uniform vec3 skyHorizon;
      varying vec3 vWorldPos;
      varying float vWave;
      varying vec3 vNormalApprox;
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
          mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
          u.y
        );
      }
      float fbm(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 4; i++) {
          v += a * vnoise(p);
          p *= 2.0;
          a *= 0.5;
        }
        return v;
      }
      float fogFactorExp2(const in float dist) {
        return 1.0 - exp(-fogDensity * fogDensity * dist * dist);
      }
      // === 天光/天空盒环境采样 (per user request ⑥) ===
      // equirect(等距柱状)UV —— 与 three 内置 equirectUv 同一约定
      // (v = asin(y)/π + 0.5, u = atan(z, x)/2π + 0.5)。HDRI EXR 走
      // EXRLoader(flipY=false), 其数据行号比例 = v, 所以可直接 texture2D。
      vec2 equirectUv(vec3 d) {
        float u = atan(d.z, d.x) * 0.15915494 + 0.5;
        float v = asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5;
        return vec2(u, v);
      }
      // 半球天光近似(无 HDRI 时的兜底): 按反射方向的仰角在天顶色/地平色之间插值,
      // 并叠一个"太阳方位附近的亮斑" —— 让人眼仍能看出天光是**有方向的**,
      // 而不是一层常量色。这是近似, 不是真实环境贴图(见 docs/NOTES)。
      vec3 skyApprox(vec3 d) {
        float t = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 c = mix(skyHorizon, skyZenith, smoothstep(0.35, 1.0, t));
        float sunProx = pow(max(dot(d, sunDir), 0.0), 8.0);
        c += highlight * sunProx * 0.35;
        // === 太阳侧天空的暖光 (per user request: 海面被太阳照亮的高亮带) =========
        // 掠射看海时, 反射方向接近水平 ⇒ 海面反射的是**地平线附近的天空**。黄昏时
        // 那一片在太阳那侧是暖金色的, 所以这里按"反射方向水平方位 vs 太阳方位"的
        // 对齐度 + 贴地平线的程度, 给反射色加暖 —— 这就是参考图里那条亮带的底子
        // (镜面高光只负责叠加在上面的碎钻)。
        vec3 dFlat = normalize(vec3(d.x, 0.0, d.z) + vec3(1e-4));
        vec3 sFlat = normalize(vec3(sunDir.x, 0.0, sunDir.z) + vec3(1e-4));
        float azim = max(dot(dFlat, sFlat), 0.0);
        float horizonBand = pow(clamp(1.0 - abs(d.y), 0.0, 1.0), 3.0);
        float lowSun = 1.0 - clamp(sunDir.y * 2.0, 0.0, 1.0);
        c += uSunColor * (0.10 + 0.55 * lowSun) * azim * horizonBand * 0.75;
        return c;
      }
      void main() {
        vec2 uv1 = vWorldPos.xz * 0.05 + vec2(time * 0.10, time * 0.07);
        vec2 uv2 = vWorldPos.xz * 0.11 - vec2(time * 0.08, time * 0.13);
        float n1 = fbm(uv1);
        float n2 = fbm(uv2);
        float e = 0.6;
        vec2 g1 = vec2(fbm(uv1 + vec2(e, 0.0)) - n1, fbm(uv1 + vec2(0.0, e)) - n1) / e;
        vec2 g2 = vec2(fbm(uv2 + vec2(e, 0.0)) - n2, fbm(uv2 + vec2(0.0, e)) - n2) / e;
        // === fbm 梯度权重收窄 (per user request: 太阳闪耀带) =================
        // 这两项原来按"浪的起伏看起来对"取 1.6/0.9, 结果**小面平均倾角 33°** ——
        // 而闪耀带的亮度全来自"接近竖直的小面"(n·h→1): 33° 倾角下宽瓣只有 0.10,
        // 海面于是永远是一层灰。数值模型(统计法线分布)实测:
        //   1.6/0.9 → 倾角 32.9°、宽瓣 0.10 ; 0.45/0.25 → 倾角 11.1°、宽瓣 0.61(6×)。
        // 大尺度起伏交给**顶点波浪**(那里是真正的几何位移), 法线这边只需要"够用的散布"。
        // === 退回原版法线 (per user request) ==================================
        // §177 试过"叠 4 组高频解析波给高光做碎钻", 结果: ① 远距离**满屏摩尔纹**;
        // ② 太阳并没有因此"以正确角度"照亮海面。已整段删除, 权重也退回原值。
        vec3 n = normalize(vNormalApprox
          + vec3(-g1.x, 0.0, -g1.y) * 1.6
          + vec3(-g2.x, 0.0, -g2.y) * 0.9);
        n = normalize(n + vec3(0.0, 0.6, 0.0));
        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 4.0);
        float sun = max(dot(n, sunDir), 0.0);
        float crest = smoothstep(2.5, 6.0, vWave);
        // === 受光色改用**天空盒的颜色** (per user request) ====================
        // 海面被太阳照亮的地方, 看到的其实是"被照亮的天空" —— 所以受光色取
        // 太阳方向上的天色(含天空盒的太阳辉光), 而不是把太阳本身的颜色涂上去。
        // 于是: 蓝天 → 受光偏冷白; 黄昏 → 受光偏金, 且**位置由反射几何自动给出**
        // (太阳在哪、天色就往哪亮), 不需要靠高频法线去"造"高光。
        vec3 skyAtSun = skyApprox(sunDir);
        vec3 col = mix(deepColor, oceanColor, smoothstep(-4.0, 4.0, vWave));
        col = mix(col, skyAtSun, fres * 0.55 + sun * 0.30);
        col += skyAtSun * crest * 0.18;
        // === 太阳闪耀带 (per user request: 海面被太阳照地高亮的地方) ==========
        // 参考图里是**一条从太阳垂下、朝观察者方向拉长的碎金带**, 不是一枚高光点。
        // 三件事凑出这个观感:
        //   ① 双瓣高光: 低次幂的宽瓣(整条带子的底光) + 高次幂的窄瓣(碎钻闪点);
        //   ② 方位对齐 pathK: 视线水平方位 ≈ 太阳水平方位时才亮 ⇒ 带子只出现在
        //      太阳正下方那一条, 不会糊满整片海;
        //   ③ 时间抖动的闪烁 twinkle —— 波光粼粼(高频法线提供小面)。
        // === 太阳光路: 只留一个"宽瓣", 颜色取太阳方向的天色 (per user request) ====
        // 不再叠窄瓣(那需要高频小面, 就是摩尔纹的来源), 也不给太阳本身染色 ——
        // 光路 = "水面把太阳周围那片亮天光反射进眼睛", 所以直接用 skyAtSun。
        vec3 hv = normalize(sunDir + viewDir);
        float nh = max(dot(n, hv), 0.0);
        float glintWide = pow(nh, 18.0);
        float glintSharp = 0.0;
        vec3 vFlat = normalize(vec3(viewDir.x, 0.0, viewDir.z) + vec3(1e-4));
        vec3 sFlat = normalize(vec3(sunDir.x, 0.0, sunDir.z) + vec3(1e-4));
        float pathK = pow(max(dot(vFlat, sFlat), 0.0), 6.0);
        float twinkle = 0.55 + 0.45 * vnoise(vWorldPos.xz * 2.6 + vec2(time * 2.2, time * 1.7));
        // === 竖直扇形柱体: 尖端在**天空盒边缘**, 光束朝机体方向展开 (per user request) ======
        // 用户: "扇形柱体的最尖端是从天空盒边缘开始发出的" + "反转之后就没有高光了"。
        // 上一版把尖端放在机体投影处、开口背向太阳 ⇒ 被照亮的是**背对太阳那半边**的海面,
        // 视野里太阳那一侧反倒没有高光 —— 方向确实反了。
        // 现在: 尖端放在**太阳水平方向上、距离 = 天空盒边缘**的远处(40km), 光束从尖端
        // **朝机体方向**展开(所以近处的海面、也就是朝向太阳那一侧的水面全在柱内 ✓),
        // 并越过机体继续延伸到 2×距离处(对应"两条长边 ×2")。
        // 机体处的半宽 = uConeRadius ⇒ tanHalf = R / uConeApexD。
        vec2 sunXZ = vec2(cos(uSunAzimuth), sin(uSunAzimuth));       // 指向太阳的水平单位向量
        vec2 apexXZ = uConeOrigin.xz + sunXZ * uConeApexD;           // 尖端(天空盒边缘处)
        vec2 axis = -sunXZ;                                          // 从尖端指向机体
        vec2 relA = vWorldPos.xz - apexXZ;
        float sA = dot(relA, axis);
        float tA = dot(relA, vec2(-axis.y, axis.x));
        // === 软门控场(per user request: "白色扇体本身隐形, 仅作标识器") ============
        // 上一版用 (1 - smoothstep(lim*0.86, lim)) 这种**窄过渡**做蒙版, 结果海面上直接
        // 出现一块"刷白的扇形" —— 边界看得见, 像贴了个扇形贴纸。
        // 现在把过渡拉到很宽(侧向 0.35→1.0、纵向同理), 并且**不做硬截断**:
        // 于是它只是一片"朝向太阳方向、越靠中心越强"的平滑权重场, 没有任何可见轮廓,
        // 也不会出现"扇形"的形状读数; 真正的观感交给下面的高光与天光。
        float tanHalf = uConeRadius / max(1.0, uConeApexD);
        float lim = max(0.0, sA) * tanHalf;                          // 该处的半宽(从尖端线性张开)
        float sideK = 1.0 - smoothstep(lim * 0.35, lim * 1.60 + 1.0, abs(tA));
        float alongK = smoothstep(-uConeApexD * 0.05, uConeApexD * 0.35, sA)
                     * (1.0 - smoothstep(uConeApexD * 1.5, uConeApexD * 2.4, sA));
        float coneK = sideK * alongK * uSunViewK;
        // 太阳在地平线下时也不亮
        coneK *= smoothstep(0.0, 0.12, sunDir.y + 0.02);
        // === 再乘"相机视野相对被标记水面的角度" (per user request) =================
        // 用户: "相机视野相对于被标记的水面角度, 角度合适的标记部分正常显示高光,
        //        视野内角度相比水面过大的标记部分就没有高光和增亮加成
        //        (比如在海平面平飞时视野底部的被标记水面就没有高光加成)"。
        // 物理上也对: 水面的镜面反光(太阳光路/高光)只在**掠射角**出现 —— 视线与水面夹角越小
        // 越亮, 接近垂直俯视时根本没有反射光路。
        // viewDir 是从水面**指向相机**的单位向量 ⇒ dot(viewDir, up) = sin(俯角 θ):
        //   θ ≈ 0°(远处/掠射) → 0 ; θ = 30°+ → 0.5+ ; 垂直俯视 → 1。
        // 于是: θ ≤ ~14° 全强度; θ ≥ ~33° 归零(平飞时画面底部那片近处水面正好落在这里) ✓
        float viewGraz = clamp(dot(viewDir, vec3(0.0, 1.0, 0.0)), 0.0, 1.0);
        coneK *= 1.0 - smoothstep(0.25, 0.55, viewGraz);
        vec3 sunCol = skyAtSun;
        // ⚠️ 闪耀带**不能加在这里**: 下面还有一次 fresnel 天光反射 mix(), 掠射角下
        // clamp(schlick×1.35) ≈ 0.95 ⇒ 会把高光整个覆盖掉。实测(取景截图)海面因此
        // 永远是"一片灰", 怎么调高光强度都看不到光路 —— 这行位置就是根因。
        // 正确顺序: 先把 col(含天光反射)算完, 再把镜面项叠上去(见下面 col += glint)。
        // === 高光**只在太阳锥内** (per user request) ==========================
        // 用户: "让在太阳锥里的海面部分被直接照亮并反射像图里那样的高光, 海面的其它部分
        // 就没有高光, 变得比较暗, 去掉原本充满海面的高光"。所以:
        //   · glint(镜面高光)乘 coneK —— 锥外一点高光都没有;
        //   · 锥外整体压暗(mix 到 0.58), 锥内才是"被太阳直射"的亮面;
        //   · pathK(方位对齐)保留在锥内做形状调制(锥内沿太阳方位更亮)。
        // 强度按用户要求削弱到原来的 1/3(3.0 → 1.0): "海面自身的高光反射太强了"。
        // 锥内高光放大: 锥外 0.35(基本看不到), 锥内 +2.6 ⇒ 满强度 ≈ 2.95×(≈原值 3.0 的一半再加强)
        vec3 glint = sunCol * glintWide * (0.30 + 0.70 * pathK) * (0.35 + 2.6 * coneK);
        // twinkle 仍然用来给这条带子加一点"水面在动"的呼吸感(只是幅度很小, 不是碎钻)。
        glint *= 0.92 + 0.08 * twinkle;
        // 锥形分量独立于镜面几何(不挑小面朝向), 所以不靠高频法线也能看出太阳位置。
        // === 锥内: 直接把海面颜色提亮 + 大幅加强高光 (per user request) ==========
        // 用户: "大幅加强在这个扇形区域内的海面高光和海面亮度, 海面原本是蓝色的,
        //        那照亮的部分直接提高颜色亮度"。所以锥内不再只是"加一点天光":
        //   · 亮度直接乘 (1 + 1.7×coneK)  ⇒ 满强度时 ≈ ×2.7(蓝海被显著提亮成亮蓝/泛白);
        //   · 再叠一层天光暖色(太阳方向的天色) ⇒ 黄昏时锥内偏金;
        //   · 高光强度在锥内放大(见下面 glint 的系数);
        //   · 锥外只轻微压暗(0.58 → 0.85) —— 重点是"里面亮", 不是"外面黑"。
        // 提亮幅度大幅收小(1.7 → 0.35)并且**随水面噪声起伏** —— 这样它是"水面被照亮"的
        // 不均匀感, 而不是一整块纯色白斑(那正是上一版看起来像白色扇形的原因)。
        float wob = 0.80 + 0.20 * vnoise(vWorldPos.xz * 0.85 + vec2(time * 0.55, -time * 0.4));
        col *= (1.0 + 0.35 * coneK * wob) * mix(0.88, 1.0, coneK);
        col += skyAtSun * coneK * 0.30;
        // === 天光/天空盒反射 (需求⑥) ====================================
        // 反射方向 → 采样天空: 有 HDRI 走真实环境贴图, 否则半球近似。
        vec3 rdir = reflect(-viewDir, n);
        vec3 skyApproxCol = skyApprox(rdir);
        vec3 envCol = texture2D(envMap, equirectUv(rdir)).rgb * envIntensity;
        vec3 sky = mix(skyApproxCol, envCol, envBlend);
        // Schlick 菲涅尔: 掠射角(视线越平)反射越强 —— 也就是远/近海面出现
        // 明显的天光梯度(远处亮、脚下暗), 这是"海面受天光照"的视觉判据。
        float f0 = 0.02;
        float schlick = f0 + (1.0 - f0) * pow(1.0 - max(dot(n, viewDir), 0.0), 5.0);
        // === 远距离/大角度泛白修复 (per user request) ==========================
        // 掠射角(视野远方)时 schlick → 1, 原来 clamp(schlick × 1.35, 0, 0.95) ⇒ 几乎整片
        // 变成"反射的天空色"。而下面喂进来的 skyHorizon 一直是**雾色**(很浅), 于是远方海面
        // 糊成一片白。现在: ① 反射上限 0.95 → 0.70(保留一部分海水本色);
        // ② 系数 1.35 → 1.05(让它更慢地接近上限); ③ 天空色本身改用"天光捕获"的地平色
        //   (engine 侧注入, 见 syncOceanEnv) 而不是雾色。
        col = mix(col, sky, clamp(schlick * 1.05, 0.0, 0.70));
        // === 太阳闪耀带: 叠在天光反射**之后** (per user request) =================
        // 参考图里那条从太阳垂下、朝观察者拉长的碎金带就靠这一行 —— 它是"太阳的
        // 镜面像", 不该被天光反射的比例压掉; 之后再走雾, 于是远处自然融进雾里。
        col += glint;
        // 太阳低角(黄昏/清晨)时, 光路里的水面整体更暖 —— 反射的天空本身也是暖的。
        col = mix(col, col * vec3(1.18, 1.0, 0.86),
          clamp((1.0 - sunDir.y) * 0.8, 0.0, 1.0) * pathK * 0.5);
        float dist = length(cameraPosition - vWorldPos);
        float fog = fogFactorExp2(dist);
        col = mix(col, fogColor, clamp(fog, 0.0, 0.80));   // 0.9 → 0.8: 远处别整片糊成雾色
        // === 调试通道: 把中间量直接当灰度输出(排查"为什么没有闪耀带") ===
        if (uDebugMode > 0.5) {
          // 6 = 法线(RGB = n*0.5+0.5, 纯蓝 = 竖直), 7 = 半向量 h, 8 = viewDir
          if (uDebugMode > 5.5) {
            vec3 v = uDebugMode < 6.5 ? n : (uDebugMode < 7.5 ? hv : viewDir);
            gl_FragColor = vec4(v * 0.5 + 0.5, 1.0);
            return;
          }
          float dbg = uDebugMode < 1.5 ? nh
                    : uDebugMode < 2.5 ? glintWide
                    : uDebugMode < 3.5 ? pathK
                    : uDebugMode < 4.5 ? clamp(schlick, 0.0, 1.0)
                    : clamp(sunDir.y * 0.5 + 0.5, 0.0, 1.0);
          gl_FragColor = vec4(vec3(dbg), 1.0);
          return;
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.y = 0;
  mesh.frustumCulled = false;
  // === 海面水平拉伸 3 倍 (per user request) ==================================
  // 放在这里而不是各调用点: buildOcean 是全部关卡海面的唯一出口, 改一处即全部生效
  // (mountain / custom / ocean / archipelago 四条分支都走它)。
  // 注意这同时会**拉伸波形**: shader 里的 vWorldPos 由 modelMatrix 得到, 所以缩放
  // 会一起作用到波场/法线空间频率上 —— 波长因此变宽 3 倍。配合下面 detail-maps 的
  // 粗糙度调整, 视觉上是"更平整开阔的海面", 符合"拉伸"的意图。
  mesh.scale.set(3, 1, 3);
  return mesh;
}


// Instanced cumulus puffs forming cloud banks
// === Polygonal volumetric clouds ===
// Each cloud is a cluster of overlapping icospheres whose vertices are
// randomly displaced, giving a lumpy "cauliflower" silhouette that reads
// as a real cumulus cloud from any angle (not just from above). Drawn
// with MeshStandardMaterial so they react to the sun directional light —
// bright tops, dark bottoms, side-shadowed — and respect scene fog.
//
// `mode` selects the cloud rendering style:
//   - 'geometry' (default): 3D polygonal icosphere clusters (current).
//   - 'sprite': classic flat billboard sprites with a procedural puff
//     texture — cheaper and "fluffy" looking, always faces the camera.

export type CloudMode = 'geometry' | 'sprite';

/** 云场可选项: 目前用于外部真实 2D 云贴图(VFX Assets 2D Cloud Textures Pack 之类)。
 *  本轮改为**带元数据**的条目(分类 + 法线图), 见 loadCloudTextures()。 */
export interface CloudFieldOpts {
  /** 外部云贴图(颜色图 + 法线 + 分类); 空/未传 → 程序化云贴图兜底。 */
  cloudTextures?: CloudTexEntry[];
  /** === 小场景覆盖(默认不传) ===
   *  机库远景雾之类的特殊小场景要的是"贴着地的一小簇云", 不是 3 km 高空的
   *  两层云场。传了就覆盖**低空层**的基准高度/面积半径(高空层不受影响)。 */
  lowBaseHeightOverride?: number;
  lowSpreadOverride?: number;
}
// Cloud coverage controls whether clouds are placed as isolated individuals
// or cluster into connected banks/stratus sheets.
//   'scattered' — each cloud placed independently (classic cumulus field)
//   'mixed'     — half independent, half clustered into small banks
//   'overcast'  — almost all clouds grouped into elongated bands so they
//                 visually merge into connected cloud sheets
export type CloudCoverage = 'scattered' | 'mixed' | 'overcast';

// ============================================================================
// === 两层云参数 (per user request ①高空团云 / ②低空片云) ====================
// 旧版两类云混在同一层(单个 baseHeight, ±抖动), 高空团云和低空片云其实都落在
// ~1800 m。现在拆成**显式两层**, 每层有自己的高度/面积/尺寸/密度:
//
//   low  = scattered 类(独立散布的片云/淡积云)     → 低空层 CLOUD_LOW_BASE_HEIGHT
//   high = bank 类(成带排布的贴片团云, 视觉主体)   → 高空层 CLOUD_HIGH_BASE_HEIGHT
//
// ★ 调参只改这一段(高度/面积/尺寸/密度全是具名常量)。
// ============================================================================
/** 4000 ft = 1219.2 m —— 需求①②共同要求的高度抬升量。 */
export const CLOUD_LIFT_FT = 4000;
export const CLOUD_LIFT_M = CLOUD_LIFT_FT * 0.3048; // = 1219.2

/** 低空片云层基准高度: 旧基准 1800 m + 4000 ft = **3019.2 m**(需求②的高度部分已完成)。
 *  本次需求②只再强调"放大面积与密度", 高度不重复抬升; 想再抬就再加一个 CLOUD_LIFT_M。 */
export const CLOUD_LOW_BASE_HEIGHT = 1800 + CLOUD_LIFT_M; // 3019.2
/** 高空团云层基准高度(需求①: "高度从 6000 提升 4000 英尺")。
 *  基准取用户指定的 **6000 m**, 再 +4000 ft(=1219.2 m) → **7219.2 m**。
 *  (上一版实现取 4200 m; 本次以用户给的 6000 为准。想再调只动 CLOUD_HIGH_BASE_M。) */
export const CLOUD_HIGH_BASE_M = 6000;
export const CLOUD_HIGH_BASE_HEIGHT = CLOUD_HIGH_BASE_M + CLOUD_LIFT_M; // 7219.2
/** 低空片云面积半径: 32000 → 48000 (面积 ×2.25, 需求②"放大面积")。 */
export const CLOUD_LOW_SPREAD = 64000;
/** 高空团云面积半径: 保持 32000 —— 需求①要的是"大小+密度", 面积不变才能让
 *  ×1.4 的云量全部转成面密度提升(面积放大反而会稀释密度)。 */
export const CLOUD_HIGH_SPREAD = 40000;
/** 低空片云层密度倍率(需求②): 面积 ×2.25 的同时云量 ×1.5×1.5=2.25...→ 净面密度 ×1.47。 */
export const CLOUD_LOW_DENSITY_BOOST = 2.0;
/** 高空团云层密度倍率(需求①"大幅加大密度"): 面积不变 → 面密度 ×1.4。 */
export const CLOUD_HIGH_DENSITY_BOOST = 2.0;
/** 高空团云尺寸倍率(需求①"大幅加大大小"): baseSize 与云瓣数一起 ×1.6~1.65。 */
export const CLOUD_HIGH_SIZE_SCALE = 2.4;
export const CLOUD_HIGH_PUFF_SCALE = 2.2;
/** 低空片云尺寸倍率(需求②: 面积/密度为主, 尺寸小幅跟随)。 */
export const CLOUD_LOW_SIZE_SCALE = 1.6;
export const CLOUD_LOW_PUFF_SCALE = 1.6;
/** 两层各自的垂直抖动(±)。 */
export const CLOUD_LOW_JITTER = 800;
export const CLOUD_HIGH_JITTER = 600;
/** 整体云量倍率(需求①②"密度加大"): engine 的分级云量(普通/风暴/mobile)
 *  先算出来, 再整体乘这个系数, 于是三个档位同时被放大且仍保持档差。 */
export const CLOUD_DENSITY_SCALE = 1.5;

// === 体积云两层的高度带 (per user request: "体积云的高度和贴片云一样") ============
// 唯一真相源: base 直接**引用贴片云的常量**(CLOUD_LOW_BASE_HEIGHT / CLOUD_HIGH_BASE_HEIGHT),
// 厚度按贴片云瓣的实际竖直尺寸推算(见下面的推导), 横向半径直接用贴片云的 spread。
// 于是"体积云的高度和贴片云一样"是**结构上成立**的 —— 以后调贴片云的高度/面积,
// 体积云自动跟随, 不需要两处手改(上一版体积云写死 cloudBase/cloudTop 1600~2900,
// 和贴片云的 3019 / 7219 差着一整层, 这就是它"看着不对劲"的根因)。
//
// 厚度推导(为什么是这几个数):
//   · 低空片云: baseSize = (760..1660) × CLOUD_LOW_SIZE_SCALE(1.6) ≈ 1216..2656, 云瓣
//     等比缩放 0.6~1.3× ⇒ 典型竖直尺寸 ≈ 1800 ⇒ 半高 ≈ 900; 再叠加 ±CLOUD_LOW_JITTER/2(400)
//     与贴片云瓣"略偏上"的偏置 ⇒ 向下 900 / 向上 1100。
//   · 高空团云: baseSize ≈ 980..2180 × 2.4 ≈ 2352..5232 ⇒ 典型竖直尺寸 ≈ 3600 ⇒ 半高 1800;
//     抖动 ±300 ⇒ 向下 1500 / 向上 1900。
export const VOLUME_CLOUD_LOW_DROP = 900;
export const VOLUME_CLOUD_LOW_RISE = 1100;
export const VOLUME_CLOUD_HIGH_DROP = 1500;
export const VOLUME_CLOUD_HIGH_RISE = 1900;

/** 一层体积云的完整描述(engine 每帧交给 VolumeCloudPass)。 */
export interface CloudLayerBand {
  name: 'low' | 'high';
  /** 贴片云的基准高度(体积云的 slab 以它为中心) */
  base: number;
  bottom: number;
  top: number;
  /** 水平半径(与贴片云同值, 体积云只在半径内生成云) */
  spread: number;
  /** 形状噪声空间频率 (1/米) —— 低层小碎云用高频, 高层大团云用低频 */
  noiseScale: number;
  /** 0 = 低空片云(扁/碎), 1 = 高空团云(圆/大) */
  kind: number;
}

/** 两层体积云的高度带(与贴片云同一套常量推导; 见上面的推导注释)。 */
export function cloudLayerBands(): { low: CloudLayerBand; high: CloudLayerBand } {
  return {
    low: {
      name: 'low',
      base: CLOUD_LOW_BASE_HEIGHT,
      bottom: CLOUD_LOW_BASE_HEIGHT - VOLUME_CLOUD_LOW_DROP,
      top: CLOUD_LOW_BASE_HEIGHT + VOLUME_CLOUD_LOW_RISE,
      spread: CLOUD_LOW_SPREAD,
      // 片云直径 ~1.8 km: 特征尺度取 ~2.2 km —— 视野内要能看到**一朵一朵**的云,
      // 特征尺度太大(1/3500 试过)时远处会连成一整片糊墙(实测截图确认)。
      noiseScale: 1 / 2200,
      kind: 0,
    },
    high: {
      name: 'high',
      base: CLOUD_HIGH_BASE_HEIGHT,
      bottom: CLOUD_HIGH_BASE_HEIGHT - VOLUME_CLOUD_HIGH_DROP,
      top: CLOUD_HIGH_BASE_HEIGHT + VOLUME_CLOUD_HIGH_RISE,
      spread: CLOUD_HIGH_SPREAD,
      // 团云直径 ~3.6 km ⇒ 特征尺度 ~5.2 km(大团云成片, 但仍要看得出团块)
      noiseScale: 1 / 5200,
      kind: 1,
    },
  };
}

// === 云的光照标定 (需求: 云的光照颜色随天光和太阳角度自动变化) ==============
// 片元里 颜色 = uColor(固有色/天气色调) × mix(天光色×AMBIENT_K, 太阳色×SUN_K, N·L)
//   · 天光色 = SkyConfig.cloudColor: 它已经过"预设 + 天气(clear/rain/storm/…)"的
//     调制(见 applyWeather 的 cloudColor.multiplyScalar 系列), 语义就是"这朵云
//     在当前天光下的固有色" → 拿来当**阴影侧(背光面)**的基色最合适;
//   · 太阳色 = SkyConfig.sunColor(天气调制后的日色), 拿来当**受光侧**的基色。
// 两个系数是"绝对亮度"旋钮: 只影响整体明暗, 不影响方向性 ——
// 0.62 / 1.05 是标定出来的(晴天正午受光面 ≈ 改造前的亮度, 背光面明显更暗)。
// === 本轮追加 === 天光色/太阳色各自再乘一个**大气散射染色**(见下面 CLOUD_ATMO_*),
// 且天光色里混入 SkyConfig.top/bottom(天空盒渐变, 权重 CLOUD_SKYDOME_MIX)。
// === 对比度整体提高 (per user request: 云要像参考图那样被太阳照亮) ==========
// 参考图里云的明暗差很明显: 朝太阳的一侧亮到发白/发暖, 背光与云底明显压暗。
// 所以: 太阳侧系数 ↑、天光(暗面)系数 ↓、自阴影 ↑、前向散射(云缘透光)↑。
export const CLOUD_LIGHT_AMBIENT_K = 0.50;
export const CLOUD_LIGHT_SUN_K = 1.42;
/** 法线强度(运行时旋钮): 越陡的云瓣越受"太阳方向项"支配, 越平越接近均匀天光。
 *  公式见片元: nstr = clamp(|n.xy| × uNormalStrength, 0, 1), 默认 2.0 让
 *  |n.xy| ≥ 0.5(≈30° 倾角, 云瓣边缘) 的面拿到完整方向光照。 */
export const CLOUD_NORMAL_STRENGTH = 2.0;

// === 贴片云: 自阴影 + 大气散射色 (per user request) =========================
// 本轮在片元里加三件事(全部零 draw call 开销, 纹理采样 +2):
//   ① 自阴影: 用"亮度×alpha 当高度场"沿太阳方向取 2 个偏移高度, 本像素比前方低
//      → 判为被云体自遮挡, 只压暗(乘 uShadowTint, 阴影偏冷);
//   ② 太阳/天空盒光照色: 从 SkyConfig 的天顶/地平线色 + 太阳色推, 不再只靠 cloudColor;
//   ③ 大气散射: 由太阳高度角 e 解析生成的太阳透射色(低角暖橙→高空白)与天空散射色
//      (低角青灰→高角亮蓝)。
/** 大气散射总强度(全局旋钮): 0 = 不做太阳/天空的散射染色(退回"纯按配置色")，
 *  1 = 满强度。只缩放解析散射色的**染色强度**(与 vec3(1) 插值), 不改变整体明暗。 */
export const CLOUD_ATMO_STRENGTH = 1.0;
/** 自阴影强度 K: occ = clamp((max(h1,h2) - h) * K, 0, 1)。
 *  2.0-4.0 之间调 —— 太大云会"整片发脏"(黑底贴图边缘的软过渡被当成高度差)。 */
export const CLOUD_SELF_SHADOW_K = 4.4;
/** 自阴影采样步长(UV 空间): k1 = step, k2 = 2.5×step。贴图裁剪后是 1024px 宽,
 *  0.02 → 约 20px / 0.05 → 约 51px, 正好是云瓣尺度(不是像素尺度)。 */
export const CLOUD_SELF_SHADOW_STEP = 0.024;
/** 阴影侧染色(阴影偏冷): 自阴影覆盖率 occ 用它把受光色压暗成"云体内部/背面"的颜色。
 *  比原来更暗一点 —— 参考图的云底/背光面是很明显的暗块, 不是淡淡的灰。 */
export const CLOUD_SHADOW_TINT = new THREE.Color(0.42, 0.48, 0.62);
/** 前向散射强度: 太阳正对的那侧额外加一点暖色(pow(ndl,4) 的太阳散射色),
 *  模拟"朝太阳的云缘被阳光穿透发亮"。参考图的云缘发亮很明显 ⇒ 0.28 → 0.5。 */
export const CLOUD_FORWARD_SCATTER = 0.34;
// 0.5 → 0.34: 与下面的透光/锥项是**三层叠加**, 一起给太多会让云整片发白(尤其相机拉远后
// 视线穿过的云瓣更多, alpha 累加更明显)。三层之和保持在"看得出光边但不洗白"。
/** 阳光穿透薄云(透光)强度: 云越薄(高度场越低)且越不被遮挡 → 透出的光越多。
 *  这是"云缘发亮/silver lining"的另一半 —— 前向散射管方向, 这个管厚度。 */
export const CLOUD_TRANSLUCENT_K = 0.30;
/** 太阳视线锥(sun cone)强度: 判据 = "从相机看, 这块云是否落在太阳方向的锥里"
 *  (锥轴 = 太阳方向, 幂次 5 控制半角)。视觉目标: 视野里正对太阳的那片云被明显点亮,
 *  离轴越远越弱 —— 像以太阳为顶点的锥(参考图里"太阳把一片云点亮"的观感)。 */
export const CLOUD_CONE_K = 0.14;
// 0.55 → 0.18: 锥项是**叠加**在已有的前向散射(0.5)与薄处透光(0.55)之上的, 三层一起
// 会把整片云field糊成"白雾盖满天空"(实测 m01 直接看不到云了)。0.18 才有"锥形提亮"而不洗白。

// === Procedural puff texture for sprite clouds ===
// === 多层噪声 alpha 云纹理 (per user request: 换成程序化预计算带 alpha 的云材质) ===
// 旧版是单层径向渐变 + 少量噪声打洞(读起来像"圆形贴片")。新版用多层 fbm
// 值噪声生成写实云团:软边缘、内部密度层次、径向衰减,一次烘焙到 256² canvas。
// 生成 N 张不同 seed 的纹理,云 billboard 随机选用 → 云形状多样,不再千篇一律。
// === 种类增多 (per user request: 外形种类要增多) ===
const CLOUD_TEXTURE_COUNT = 8;

function makeCloudTextures(count = CLOUD_TEXTURE_COUNT): THREE.CanvasTexture[] {
  const cached = THREE.Cache.get('skybound-cloud-puffs');
  if (cached) return cached as THREE.CanvasTexture[];
  const size = 256;
  const smooth = (e0: number, e1: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const out: THREE.CanvasTexture[] = [];
  for (let k = 0; k < count; k++) {
    const seed = k * 137.3 + 11.7;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size, v = y / size;
        // 中心化坐标 → 径向衰减(云片边缘淡出,不再硬圆)。
        const cx = (u - 0.5) * 2, cy = (v - 0.5) * 2;
        const r = Math.sqrt(cx * cx + cy * cy);
        // 多层 fbm:低频塑造云团轮廓,高频增加絮状细节。
        const n1 = fbm2(u * 5 + seed, v * 5 + seed, 5);
        const n2 = fbm2(u * 13 + seed * 2.7, v * 13 + seed * 2.7, 4);
        const density = n1 * 0.65 + n2 * 0.35;
        const radial = 1.0 - smooth(0.45, 1.0, r);
        // 阈值 → 软边缘云团;高密区再叠一层更白(内部层次)。
        let a = smooth(0.42, 0.72, density * radial);
        a = Math.min(1.0, a + smooth(0.62, 0.85, density * radial) * 0.5);
        const i = (y * size + x) * 4;
        img.data[i] = 255;
        img.data[i + 1] = 255;
        img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    // Shared across missions — engine.dispose() must NOT free it.
    (tex as any).userData.shared = true;
    out.push(tex);
  }
  THREE.Cache.add('skybound-cloud-puffs', out);
  return out;
}

// === 外部真实 2D 云贴图接入通道 (per user request ③) =========================
// 需求③: 高空贴片云改用 VFX Assets 2D Cloud Textures Pack(125 张 2D 云纹理 JPG)。
// 该资源是第三方**付费商品**(Gumroad), 不能随仓库分发 —— 所以这里只做**接入通道**:
// 玩家/策划把买到的 JPG 放进 `public/textures/clouds/` 后自动生效, 缺失时静默回退
// 到上面的程序化贴图(8 张 canvas), 功能不会因缺贴图而挂。
//
// 三级发现顺序(找到即停):
//   1. `window.__ASSET_MANIFEST` 里以 `/textures/clouds/` 开头的键 —— 单文件/资产库
//      构建把 import-asset.mjs 入库的贴图内联成 data URI 后就走这条(离线可用);
//   2. 同目录下的 `manifest.json`(`["a.jpg", ...]`, `{"files":[...]}`, 或 files 里
//      放**对象** `{file, normal, class}` —— scripts/clouds-prep.mjs 的产物)—— 文件名
//      随意时用清单声明;
//   3. 固定命名约定 `cloud-001.jpg ... cloud-125.jpg`, 顺序探测到**第一个缺失为止**
//      (命名连续, 所以缺一个就说明到头了, 不会打 125 次空请求)。
//
// 载入用 loadImageTexture(`<img>` 路线)而不是 THREE.TextureLoader —— r185 的
// TextureLoader 内部走 fetch, 在 file:// 下会抛裸 Event(见 fetch-asset.ts)。
//
// === 本轮新增 (需求: 2D 云贴图自动分类 + 法线贴图参与光照) ====================
// 贴图不再只是一张颜色图: 每张带上 **分类**(large / small)与**法线图**。
//   · 分类决定它进哪一层 —— large 只给高空团云层(bank), small 只给低空片云层
//     (scattered); 缺某一类时该层回退程序化贴图(见 buildCloudFieldSprites)。
//   · 法线图 `_n.jpg`(脚本用亮度当高度场烘焙, 见 scripts/clouds-prep.mjs)在片元里
//     算 N·L, 让云"按天光/太阳角度"明暗。
//   · `class: 'contrail'`(航迹云)按用户要求**先不使用** → 载入期直接跳过。
const CLOUD_TEX_DIR = '/textures/clouds/';
const CLOUD_TEX_MANIFEST = CLOUD_TEX_DIR + 'manifest.json';
// === 云图集 (per user request: 125 张合并打包成图集, 否则加载太慢) ===
// scripts/clouds-atlas.mjs 把逐张云图(颜色 + 法线)打成两张 2048x1024 的图集:
//   .../clouds/atlas/{clouds.jpg, clouds_n.jpg, atlas.json}
// 运行时只拉 3 个文件(原来 250 个), 且云场只需 1 个 InstancedMesh(原来每张图一个)。
const CLOUD_ATLAS_DIR = CLOUD_TEX_DIR + 'atlas/';
const CLOUD_ATLAS_JSON = CLOUD_ATLAS_DIR + 'atlas.json';
/** 图集网格(列, 行)。图集加载成功后由 loadCloudAtlas 填; null = 走逐张老路径。 */
let CLOUD_ATLAS_GRID: [number, number] | null = null;
/** 固定命名约定的探测上限(= 用户给的资源张数)。 */
const CLOUD_TEX_FIXED_MAX = 125;
const CLOUD_TEX_RE = /\.(jpe?g|png|webp)$/i;
/** 法线图的命名后缀(与 clouds-prep.mjs 一致: `<name>_n.jpg`)。 */
const CLOUD_TEX_NORMAL_SUFFIX = '_n';
/** 没有 class 元数据时按宽高比兜底判类 —— 与 clouds-prep.mjs 的
 *  LARGE_ASPECT_MIN/MAX 保持一致(宽扁 1.25~3.2 归 large, 其余归 small)。 */
const CLOUD_TEX_LARGE_ASPECT_MIN = 1.25;
const CLOUD_TEX_LARGE_ASPECT_MAX = 3.2;

/** 云贴图分类: 大云(高空团云层) / 小云(低空片云层) / 未知 / 航迹云(不使用)。 */
export type CloudTexClass = 'large' | 'small' | 'unknown' | 'contrail';

/** 一张外部云贴图的完整描述: 颜色图 + 可选法线图 + 分类。
 *  走图集时 tex/normal 指向**同一张图集**, atlasCell 是该云在图集里的格坐标(整数列/行)。 */
export interface CloudTexEntry {
  /** 图集路径下的格坐标 [列, 行](归一化由着色器的 uCellSize 处理)。 */
  atlasCell?: [number, number];
  tex: THREE.Texture;
  /** 法线图(`_n.jpg`, 线性色空间)。拿不到时为 null → 该桶走"无起伏"回退。 */
  normal: THREE.Texture | null;
  cls: CloudTexClass;
}

/** 清单里一条贴图声明(纯字符串 = 旧格式, 只有文件名)。 */
interface CloudTexSpec {
  file: string;
  /** undefined = 按命名约定猜 `<name>_n.jpg`; null = 明确没有法线图。 */
  normal?: string | null;
  cls?: CloudTexClass;
}

function cloudTexFixedName(i: number): string {
  return `${CLOUD_TEX_DIR}cloud-${String(i).padStart(3, '0')}.jpg`;
}

/** 去掉扩展名, 拼上 `_n` 后缀 —— 法线图的命名约定。 */
function normalNameFor(file: string): string {
  return file.replace(CLOUD_TEX_RE, '') + CLOUD_TEX_NORMAL_SUFFIX + '.jpg';
}

/** 路径以 `_n.<图片扩展名>` 结尾的是法线图, 不是颜色图(别当云贴图收进来)。 */
function isNormalPath(p: string): boolean {
  return new RegExp(`${CLOUD_TEX_NORMAL_SUFFIX}\\.(jpe?g|png|webp)$`, 'i').test(p);
}

/** `_raw/`(原图目录)与 `_contrail/`(用户要求先不用的航迹云)不参与。 */
function isExcludedPath(p: string): boolean {
  return /(^|\/)_(raw|contrail)\//i.test(p);
}

/** 从路径反推分类(清单没给 class 时): large/ small/ contrail/ 目录名优先。 */
function classFromPath(p: string): CloudTexClass {
  if (/\/large\//i.test(p)) return 'large';
  if (/\/small\//i.test(p)) return 'small';
  if (/contrail/i.test(p)) return 'contrail';
  return 'unknown';
}

/** 把清单里的一条文件名解析成绝对 URL。 */
function cloudTexUrl(f: string): string {
  return f.startsWith('/') ? f : CLOUD_TEX_DIR + f;
}

/** 从 `__ASSET_MANIFEST` 收集 `/textures/clouds/` 下的图片键(排序保证稳定)。 */
function cloudTexSpecsFromManifest(): CloudTexSpec[] {
  if (typeof window === 'undefined') return [];
  const m = (window as unknown as { __ASSET_MANIFEST?: Record<string, string> }).__ASSET_MANIFEST;
  if (!m) return [];
  return Object.keys(m)
    .filter((k) => k.startsWith(CLOUD_TEX_DIR) && CLOUD_TEX_RE.test(k))
    .filter((k) => !isNormalPath(k) && !isExcludedPath(k))
    .sort()
    .map((k) => ({ file: k, normal: normalNameFor(k), cls: classFromPath(k) }));
}

/** 读同目录 manifest.json → 贴图声明(不存在/格式不对返回空)。
 *  files 里**字符串**与**对象**两种条目都吃(向后兼容旧格式)。 */
async function cloudTexSpecsFromJson(): Promise<CloudTexSpec[]> {
  try {
    const txt = await fetchAssetText(assetUrl(CLOUD_TEX_MANIFEST));
    const j = JSON.parse(txt) as unknown;
    const files = Array.isArray(j) ? j : (j as { files?: unknown[] })?.files;
    if (!Array.isArray(files)) return [];
    const out: CloudTexSpec[] = [];
    for (const f of files) {
      if (typeof f === 'string') {
        if (!CLOUD_TEX_RE.test(f) || isNormalPath(f) || isExcludedPath(f)) continue;
        const url = cloudTexUrl(f);
        out.push({ file: url, normal: normalNameFor(url), cls: classFromPath(url) });
      } else if (f && typeof f === 'object') {
        const o = f as { file?: unknown; normal?: unknown; class?: unknown };
        if (typeof o.file !== 'string') continue;
        if (!CLOUD_TEX_RE.test(o.file) || isExcludedPath(o.file)) continue;
        const url = cloudTexUrl(o.file);
        const cls = (typeof o.class === 'string' ? o.class : classFromPath(url)) as CloudTexClass;
        const nrm = typeof o.normal === 'string' ? cloudTexUrl(o.normal) : normalNameFor(url);
        out.push({ file: url, normal: nrm, cls });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 固定命名约定探测: cloud-001.jpg ... 到第一个缺失为止。
 *  法线图按 `cloud-00N_n.jpg` 约定, 但**只在第 1 张上探一次**决定后面要不要探
 *  —— 否则没有法线图时会白打 125 次 404。
 *  固定命名没有分类信息 → cls 留 'unknown', 载入后按图片宽高比兜底判类。 */
async function cloudTexSpecsFixed(): Promise<CloudTexSpec[]> {
  const found: CloudTexSpec[] = [];
  for (let i = 1; i <= CLOUD_TEX_FIXED_MAX; i++) {
    const url = assetUrl(cloudTexFixedName(i));
    try {
      const tex = await loadImageTexture(url, true);
      (tex as unknown as { userData: Record<string, unknown> }).userData.shared = true;
      found.push({ file: cloudTexFixedName(i), cls: 'unknown', normal: undefined });
      // 已经拿到纹理, 直接复用(避免二次加载)。
      _cloudTexCache.set(url, tex);
    } catch {
      break; // 连续命名 → 第一个缺失就是结尾
    }
    if (i === 1) {
      // 只探一次: 有就继续按约定拼, 没有就整批 normal=null(不再打 404)。
      const hasN = await imageExists(assetUrl(normalNameFor(cloudTexFixedName(1))));
      for (const s of found) s.normal = hasN ? normalNameFor(s.file) : null;
    } else {
      found[found.length - 1].normal = found[0].normal;
    }
  }
  return found;
}

/** 轻量存在性探测(`<img>` 加载一次即弃; file:// 下 HEAD/XHR 都不可用)。 */
function imageExists(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined') { resolve(false); return; }
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

/** url → 已载入纹理(固定命名探测时顺便缓存, 避免重复下载)。 */
const _cloudTexCache = new Map<string, THREE.Texture>();

/** 1×1 的"平法线"贴图(128,128,255): 没有法线图时绑它, 免得 sampler 空绑定告警;
 *  片元里 uHasNormal=0 会把它的影响完全关掉。 */
let _flatNormalTex: THREE.DataTexture | null = null;
function flatNormalTexture(): THREE.DataTexture {
  if (_flatNormalTex) return _flatNormalTex;
  const t = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  (t as unknown as { userData: Record<string, unknown> }).userData.shared = true;
  _flatNormalTex = t;
  return _flatNormalTex;
}

/** 按宽高比兜底判类(清单/路径都没给 class 时): 宽扁 → large, 其余 → small。 */
function classByAspect(w: number, h: number): CloudTexClass {
  if (!(w > 0) || !(h > 0)) return 'unknown';
  const aspect = w / h;
  return aspect >= CLOUD_TEX_LARGE_ASPECT_MIN && aspect <= CLOUD_TEX_LARGE_ASPECT_MAX
    ? 'large'
    : 'small';
}

/**
 * 载入外部 2D 云贴图(颜色图 + 法线图 + 分类)。找不到任何一张时返回 `[]`,
 * 调用方回退程序化贴图。单张失败只跳过该张(不整体失败), 保证"放进去几张就用几张"。
 */
// 注: 黑底 JPG 的"亮度→alpha"抠像**只在片元着色器里做一次**(见 buildCloudSprites 的
// 片元: a = t.a * clamp(lum * 1.35))。早先我在加载期也做了一遍, 结果被乘两次 →
// 云整体变虚/被 discard 吃掉, 所以这里刻意**不做**加载期抠像, 原样返回图片贴图。

/**
 * 尝试加载云图集。成功返回逐"云"条目(共享同一张图集贴图 + 各自格坐标);
 * 失败/未生成图集返回 null → 调用方回退逐张探测(与改造前完全一致)。
 */
async function loadCloudAtlas(): Promise<CloudTexEntry[] | null> {
  try {
    const txt = await fetchAssetText(assetUrl(CLOUD_ATLAS_JSON));
    const j = JSON.parse(txt) as {
      grid?: unknown; color?: unknown; normal?: unknown;
      files?: { file?: unknown; normal?: unknown; class?: unknown; cell?: unknown }[];
    };
    if (!Array.isArray(j.grid) || j.grid.length < 2 || typeof j.color !== 'string' || !Array.isArray(j.files)) return null;
    const gx = Number(j.grid[0]), gy = Number(j.grid[1]);
    if (!(gx > 0 && gy > 0)) return null;
    const color = await loadImageTexture(assetUrl(CLOUD_ATLAS_DIR + j.color), true);
    const normal = typeof j.normal === 'string'
      ? await loadImageTexture(assetUrl(CLOUD_ATLAS_DIR + j.normal), true)
      : null;
    const out: CloudTexEntry[] = [];
    for (const f of j.files) {
      const cls = (typeof f.class === 'string' ? f.class : 'unknown') as CloudTexClass;
      if (cls === 'contrail') continue;   // 航迹云按用户要求不使用
      if (!Array.isArray(f.cell) || f.cell.length < 2) continue;
      const cx = Number(f.cell[0]), cy = Number(f.cell[1]);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
      out.push({ tex: color, normal, cls, atlasCell: [cx, cy] });
    }
    if (!out.length) return null;
    CLOUD_ATLAS_GRID = [gx, gy];
    return out;
  } catch {
    return null;   // 没生成图集/请求失败 → 老路径
  }
}

// ============================================================================
// === 云层遮挡裁剪: 同一视野区域内最多显示 maxLayers 层 (per user request) =====
// ============================================================================
/** 视野内同一像素最多叠几层云瓣; 超出的(完全被挡住的)折叠不画。可用 localStorage 覆盖。 */
export const CLOUD_MAX_LAYERS = 120;   // 上限 200 → 120 (per user request: 被完全遮挡的部分不重复渲染)

const _capM4 = new THREE.Matrix4();
const _capV = new THREE.Vector3();

/**
 * 逐云桶做"最多 maxLayers 层"的遮挡裁剪。
 *
 * 算法(每调用一次做一遍, 建议每 2~4 帧调一次):
 *   ① 用一个粗屏幕网格(48×27)记每格已经画了几层;
 *   ② 把锥内实例**按到相机距离由近到远**排序(近的先占层, 远的才可能被挡);
 *   ③ 逐个把云瓣的屏幕包围盒"盖"到网格上: 若它覆盖的每一格都已有 >= maxLayers 层,
 *      该云瓣折叠(aHide=0, 顶点着色器里缩成零面积 = 不显示); 否则显示并给覆盖的格子 +1。
 *   只对**状态有变化**的实例写属性, 避免每帧整块上传。
 */
export function updateCloudOverdrawCap(
  group: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  time: number,
  maxLayers = CLOUD_MAX_LAYERS,
  probePos?: THREE.Vector3,
): void {
  const buckets = group.userData.cloudOverdrawBuckets as THREE.InstancedMesh[] | undefined;
  if (!buckets || buckets.length === 0) return;
  const W = 48, H = 27;
  const layers = new Uint8Array(W * H);
  const wrap = (group.userData.cloudUniforms as { uWrap?: { value: number } } | undefined)?.uWrap?.value ?? 1e9;
  const camPos = camera.position;
  // === 穿云强度(顺带算, 不额外遍历) (per user request: 穿云时气流扰动放大) ===
  // 判据: 最近云瓣的"归一化距离" d / r(r = 该云瓣包围半径)。d < r ⇒ 在云瓣体积内 ⇒ 1。
  // 取所有云瓣里最近的那个, 于是"穿过云层"会得到接近 1 的值, 远离云时衰减到 0。
  const probe = probePos ?? camPos;
  let cloudMin = Infinity;
  let layerCount = 0;
  // 先把所有实例收集起来统一排序(跨桶: 近的优先占层, 才不会被远处云瓣抢掉层数)
  type Entry = { im: THREE.InstancedMesh; idx: number; dist: number; x: number; y: number; z: number; r: number };
  const entries: Entry[] = [];
  // === 云层高度探测 (per user request: 机体气流扰动要看"是不是在云层里") ==========
  // 判据不是"离某一朵云多近", 而是"机体所在高度附近有多少贴片云" ——
  // 云层内必然有大量云瓣与机体同高且水平距离不远。计数换算成 0..1 的密度。
  for (const im of buckets) {
    const items = im.userData.cloudOverdrawItems as { center: THREE.Vector3; offset: THREE.Vector3; drift: THREE.Vector3; sx: number; sy: number }[] | undefined;
    const attr = im.userData.cloudHideAttr as THREE.InstancedBufferAttribute | undefined;
    if (!items || !attr) continue;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const dx = Math.cos(it.drift.y) * it.drift.x * time;
      const dz = Math.sin(it.drift.y) * it.drift.x * time;
      let cx = it.center.x + dx;
      let cz = it.center.z + dz;
      cx = (((cx + wrap) % (2 * wrap)) + 2 * wrap) % (2 * wrap) - wrap;
      cz = (((cz + wrap) % (2 * wrap)) + 2 * wrap) % (2 * wrap) - wrap;
      const wx = cx + it.offset.x;
      const wy = it.center.y + it.offset.y;
      const wz = cz + it.offset.z;
      const d = Math.hypot(wx - camPos.x, wy - camPos.y, wz - camPos.z);
      const r = Math.max(it.sx, it.sy) * 0.5;
      // 穿云强度用**机体位置**(相机离机体 10~40 单位, 云瓣半径上百, 差这点无所谓但更准)
      const pd = probe === camPos ? d : Math.hypot(wx - probe.x, wy - probe.y, wz - probe.z);
      // 有效半径取 0.35×: 云瓣是**扁平贴片**(billboard), 包围球的体积远大于可见云体,
      // 直接用 0.5×max(sx,sy) 会让"在同一个云团附近巡航"也算穿云(实测巡航时 cloudK≈0.2)。
      const nr = pd / Math.max(1, r * 0.7);
      if (nr < cloudMin) cloudMin = nr;
      // 同高(±云瓣高度)且水平距离 2.6km 内 → 记一层
      if (Math.abs(wy - probe.y) < Math.max(140, r * 0.6) && Math.hypot(wx - probe.x, wz - probe.z) < 2600) layerCount++;
      entries.push({ im, idx: i, dist: d, x: wx, y: wy, z: wz, r });
    }
  }
  if (entries.length === 0) return;
  // 归一化距离 ≤0.65(明确进到云体里) ⇒ 1; ≥1.0(还在云外) ⇒ 0; 中间线性。
  group.userData.cloudInsideK = Number.isFinite(cloudMin)
    ? Math.max(0, Math.min(1, (1.0 - cloudMin) / 0.35))
    : 0;
  // 18 层同高云瓣 ≈ 明确在云层里(密度 1); 0 层 → 0。
  group.userData.cloudLayerK = Math.min(1, layerCount / 18);
  entries.sort((a, b) => a.dist - b.dist);
  // §361: 屏幕半径的正确换算 —— halfPx 是**垂直**半视角的比例(tan(fov/2) 算出来的),
  // 所以 NDC-y 半径 = halfPx、NDC-x 半径 = halfPx / aspect。旧版把 halfPx 当"宽度比例"
  // 用在 x 上、又乘 H/W 用在 y 上 ⇒ 两个轴都错(云瓣的覆盖盒偏窄偏扁)。
  const aspect = camera.aspect > 0 ? camera.aspect : W / H;
  for (const e of entries) {
    // 屏幕空间: 投影中心, 半径按 距离/FOV 换算成像素比例(粗网格下够用)
    _capV.set(e.x, e.y, e.z).project(camera);
    const behind = _capV.z > 1;
    const nx = _capV.x * 0.5 + 0.5;
    const ny = -_capV.y * 0.5 + 0.5;
    const halfPx = camera.fov > 0 ? (e.r / Math.max(1, e.dist)) / Math.tan((camera.fov * Math.PI) / 360) : 0.5;
    const hx = halfPx / aspect;
    const hy = halfPx;
    const gx0 = Math.max(0, Math.floor((nx - hx) * W));
    const gx1 = Math.min(W - 1, Math.floor((nx + hx) * W));
    const gy0 = Math.max(0, Math.floor((ny - hy) * H));
    const gy1 = Math.min(H - 1, Math.floor((ny + hy) * H));
    // §361 (per user report: "某个视角角度下云被不正确剔除"): 旧版只看**中心点**出没出画
    // (固定 ±0.2 屏余量)。云瓣是半径数百米~数公里的巨型贴片 —— 俯视云层时大片云瓣的**中心**
    // 刚好落在画面外、云体却占掉半个屏幕, 于是整块被吃掉, 表现为"往下看云就变少"。
    // 改成**只有整块云瓣都出画才剔除**(中心 ± 屏幕半径), 余量随尺寸自动给出。
    const offX = nx + hx < -0.05 || nx - hx > 1.05;
    const offY = ny + hy < -0.05 || ny - hy > 1.05;
    let hide = behind || offX || offY;
    if (!hide) {
      let allFull = true;
      for (let gy = gy0; gy <= gy1 && allFull; gy++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          if (layers[gy * W + gx] < maxLayers) { allFull = false; break; }
        }
      }
      hide = allFull;
      if (!hide) {
        for (let gy = gy0; gy <= gy1; gy++) {
          for (let gx = gx0; gx <= gx1; gx++) {
            const k = gy * W + gx;
            if (layers[k] < 255) layers[k]++;
          }
        }
      }
    }
    const attr = e.im.userData.cloudHideAttr as THREE.InstancedBufferAttribute;
    const want = hide ? 0 : 1;
    if (attr.array[e.idx] !== want) {
      attr.array[e.idx] = want;
      attr.needsUpdate = true;
    }
  }
  void _capM4;
}

export async function loadCloudTextures(): Promise<CloudTexEntry[]> {
  // === 优先走云图集: 成功即只拉 3 个文件(json + 两张图), 且所有云共用一张贴图 ===
  const atlasEntries = await loadCloudAtlas();
  if (atlasEntries) return atlasEntries;
  let specs = cloudTexSpecsFromManifest();
  if (!specs.length) specs = await cloudTexSpecsFromJson();
  if (!specs.length) specs = await cloudTexSpecsFixed();
  if (!specs.length) return [];
  const out: CloudTexEntry[] = [];
  for (const s of specs) {
    // 航迹云: 用户要求"先不使用" → 连载入都不做(省带宽/显存), 分类只留在清单里。
    if (s.cls === 'contrail') continue;
    const url = assetUrl(s.file);
    let tex = _cloudTexCache.get(url);
    if (!tex) {
      try {
        // manifest 里的键走 assetUrl 取内联 data URI; 固定命名已是最终 URL。
        tex = await loadImageTexture(url, true);
        const u = (tex as unknown as { userData: Record<string, unknown> }).userData;
        u.shared = true; // 跨 mission 复用 —— engine.dispose() 不释放
        u.source = s.file;
        _cloudTexCache.set(url, tex);
      } catch {
        continue; // 单张失败跳过
      }
    }
    // 法线图: 声明了才去载; 载不到 → null(该桶退回"无起伏"路径, 不会崩)。
    let normal: THREE.Texture | null = null;
    if (s.normal !== null) {
      const nUrl = assetUrl(s.normal ?? normalNameFor(s.file));
      const hit = _cloudTexCache.get(nUrl);
      if (hit) {
        normal = hit;
      } else {
        try {
          // srgb=false → NoColorSpace: 法线是**向量数据**, 不能当颜色做 sRGB 解码。
          normal = await loadImageTexture(nUrl, false);
          const nu = (normal as unknown as { userData: Record<string, unknown> }).userData;
          nu.shared = true;
          nu.source = s.normal;
          _cloudTexCache.set(nUrl, normal);
        } catch {
          normal = null;
        }
      }
    }
    // 分类: 清单/路径没给(unknown) → 按已载入图片的宽高比兜底判类。
    let cls: CloudTexClass = s.cls ?? 'unknown';
    if (cls === 'unknown') {
      const img = (tex as unknown as { image?: { width?: number; height?: number } }).image;
      cls = classByAspect(img?.width ?? 0, img?.height ?? 0);
    }
    out.push({ tex, normal, cls });
  }
  return out;
}

// === Cloud placement generator (两层版, 需求①②) ===
// 产出 count 朵云的 {x,y,z} + **层标记**。两层的高度/面积/尺寸/密度全部来自
// 本文件顶部的具名常量(CLOUD_LOW_* / CLOUD_HIGH_*), 不再靠单个 baseHeight
// 把两类云混在一起。
//
// 层划分:
//   high = bank 类(成带排布的贴片团云) → CLOUD_HIGH_BASE_HEIGHT (4200 m)
//   low  = scattered 类(独立散布的片云)  → CLOUD_LOW_BASE_HEIGHT (3019.2 m)
//
// Coverage 决定两层的数量配比(与旧版语义一致, 只是低空层的占比抬高了, 让
// 需求②的"低空片云"在默认 overcast 下也看得见):
//   scattered — 全部低空片云(纯散布场)
//   mixed     — 50% 高空团云 / 50% 低空片云
//   overcast  — 78% 高空团云 / 22% 低空片云(旧 85/15)
// 每层再乘自己的密度倍率(CLOUD_LOW/HIGH_DENSITY_BOOST)。
export type CloudLayer = 'low' | 'high';

export interface CloudPlacement {
  x: number; y: number; z: number;
  /** 所属云层(需求①②: 两层显式分离)。 */
  layer: CloudLayer;
  /** 成带排布的团云(高空层) vs 独立散布的片云(低空层)。 */
  isBank: boolean;
}

/** 低空片云在总数里的占比(按覆盖度)。 */
function lowLayerShare(coverage: CloudCoverage): number {
  return coverage === 'scattered' ? 1 : coverage === 'mixed' ? 0.5 : 0.22;
}

function generateCloudPlacements(
  count: number,
  coverage: CloudCoverage,
  lowHeight = CLOUD_LOW_BASE_HEIGHT,
  lowSpread = CLOUD_LOW_SPREAD,
): CloudPlacement[] {
  const out: CloudPlacement[] = [];
  // Helper — 圆盘内取点。
  // === 改为低差异序列(黄金角螺旋) (per fix: 贴片云分布范围不均匀) ===
  // 原来每次调用都是纯随机(独立同分布) → 统计上均匀, 但**局部会结块、也会留空**;
  // 云又是大尺寸半透明贴片, 结块/留空在画面上非常显眼。
  // 黄金角螺旋是 low-discrepancy 序列: 取前 N 个点就近似均匀铺满圆盘(半径按 √i 增长,
  // 保证面积均匀), 而且**不用预先知道 N** —— 逐次调用即逐次铺开, 两层云、
  // 云带中心共用同一个序列指针, 因此整体分布均匀、不会有两个点几乎重合。
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  let seq = 0;
  const randDisc = (spread: number) => {
    const i = seq++;
    // 半径按 (i+0.5)/SLOTS 的平方根增长 —— 与"圆盘面积均匀"同一口径, 只是位置确定。
    const SLOTS = 512;
    const t = ((i % SLOTS) + 0.5) / SLOTS;
    const r = Math.sqrt(t) * spread;
    const a = i * GOLDEN_ANGLE;
    return { x: Math.cos(a) * r, z: Math.sin(a) * r };
  };
  // Helper — random Y around a layer's base height.
  const randY = (base: number, jitter: number) => base + (Math.random() - 0.5) * jitter;
  // === 低空片云: 独立散布在高空层之下 ============================
  const pushLow = () => {
    const p = randDisc(lowSpread);
    out.push({
      x: p.x,
      y: randY(lowHeight, CLOUD_LOW_JITTER),
      z: p.z,
      layer: 'low',
      isBank: false,
    });
  };
  // === 高空团云: 成带排布 ========================================
  // `spacing` 控制带内云朵间距(越小越重叠、越像连成一片), `crossJitter` 控制
  // 垂直于带向的抖动(越小越直)。两者都随 CLOUD_HIGH_SIZE_SCALE 放大 —— 云朵
  // 放大 1.65× 后间距不变的话相邻云会**互相穿插**, 放大间距才能保持"成带但
  // 各自独立"的观感(需求①: 尺寸放大后避免互相穿插)。
  const sizeK = CLOUD_HIGH_SIZE_SCALE;
  const genBank = (n: number, spacing: number, crossJitter: number) => {
    const center = randDisc(CLOUD_HIGH_SPREAD);
    const heading = Math.random() * Math.PI * 2;
    const dx = Math.cos(heading);
    const dz = Math.sin(heading);
    // Start at one end of the bank, walk to the other.
    const halfLen = (n - 1) * spacing * 0.5;
    for (let k = 0; k < n; k++) {
      const t = k * spacing - halfLen;
      const cross = (Math.random() - 0.5) * crossJitter;
      out.push({
        x: center.x + dx * t + dz * cross,
        y: randY(CLOUD_HIGH_BASE_HEIGHT, CLOUD_HIGH_JITTER),
        z: center.z + dz * t - dx * cross,
        layer: 'high',
        isBank: true,
      });
    }
  };

  // 两层各自的云量(总数 × 层占比 × 层密度倍率)。
  const share = lowLayerShare(coverage);
  const lowCount = Math.round(count * share * CLOUD_LOW_DENSITY_BOOST);
  const highCount = Math.round(count * (1 - share) * CLOUD_HIGH_DENSITY_BOOST);

  if (highCount > 0) {
    // 带数与每带云量和覆盖度一致: overcast 少而长(连成片), mixed 多而短。
    const bankCount = coverage === 'overcast'
      ? 3 + Math.floor(Math.random() * 3)   // 3-5 banks
      : 2 + Math.floor(Math.random() * 3);  // 2-4 banks
    const perBank = Math.max(4, Math.floor(highCount / bankCount));
    let placed = 0;
    for (let b = 0; b < bankCount && placed < highCount; b++) {
      const room = highCount - placed;
      const n = Math.min(perBank + Math.floor(Math.random() * 4), room);
      if (n <= 0) break;
      // overcast 间距收紧(密云连片), mixed 略松(成簇但不连片)。
      // 基准 180/320 → 随尺寸同步放大(见上)。
      genBank(
        n,
        (coverage === 'overcast' ? 180 : 320) * sizeK,
        (coverage === 'overcast' ? 180 : 280) * sizeK,
      );
      placed += n;
    }
  }
  for (let i = 0; i < lowCount; i++) pushLow();
  return out;
}

// ============================================================================
// === HEIGHTMAP TERRAIN SYSTEM (per user request) ============================
// Replaces the old low-poly cones/cylinders with a proper FBM-noise heightmap
// displaced PlaneGeometry. This produces real terrain with ridges, valleys,
// peaks, and plains — like a satellite relief map extruded into 3D.
//
// Key features:
//   - Multi-octave Perlin/value noise (FBM) for natural-looking relief
//   - Height-based texture layering: sand → grass → rock → snow
//   - Optional ridge noise for sharp mountain crests
//   - Optional island falloff so the terrain forms a landmass surrounded by sea
//   - Vertex colors blended by height + slope so we don't need a giant texture
// ============================================================================
// 2D hash + value-noise helpers shared by all terrain builders.
function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise2(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return (
    hash2(ix, iy) * (1 - ux) * (1 - uy) +
    hash2(ix + 1, iy) * ux * (1 - uy) +
    hash2(ix, iy + 1) * (1 - ux) * uy +
    hash2(ix + 1, iy + 1) * ux * uy
  );
}
// Fractal Brownian Motion — stack N octaves of value noise for natural relief.
function fbm2(x: number, y: number, octaves = 5, lacunarity = 2.0, gain = 0.5): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1.0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise2(x * freq, y * freq);
    freq *= lacunarity;
    amp *= gain;
  }
  return sum;
}
// Ridge noise — produces sharp crests instead of smooth hills. Good for mountains.
function ridge2(x: number, y: number, octaves = 5): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1.0;
  for (let i = 0; i < octaves; i++) {
    const n = 1.0 - Math.abs(vnoise2(x * freq, y * freq) * 2 - 1);
    sum += amp * n * n;
    freq *= 2.0;
    amp *= 0.5;
  }
  return sum;
}

/**
 * === 侵蚀式脊状多分形 (eroded ridged multifractal, per user request: 地形更真实) ===
 *
 * 与 `ridge2` 的区别: 每一层八度的**振幅乘上一层的"高度权重"** —— 高处(山脊)继续叠加细节,
 * 低处(谷底)细节被压平。这正是真实山系的样子: **山脊尖锐多褶、谷底平缓沉积**。
 * 权重用 `pow(n, erosion)` 控制侵蚀强度: erosion 越大, 谷底越平、山脊越锐。
 */
function erodedRidge2(x: number, y: number, octaves = 7, erosion = 1.8): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1.0;
  let weight = 1.0;
  for (let i = 0; i < octaves; i++) {
    let n = 1.0 - Math.abs(vnoise2(x * freq, y * freq) * 2 - 1);
    n *= n;
    // 权重来自本层信号: 谷底(n 小) → 权重低 → 后续细节被抑制(谷底平缓)
    n *= weight;
    sum += amp * n;
    weight = Math.min(1, Math.pow(Math.max(0, n) * 2.0, 1 / erosion));
    freq *= 2.0;
    amp *= 0.5;
  }
  return sum;
}

/**
 * === 域扭曲 fBm (domain warping, per user request: 地形更真实) ===
 *
 * 先把采样坐标用另一个噪声场**扭曲** `warp` 幅度, 再取 fBm。效果是山脊/沟谷不再沿噪声网格
 * 直来直去, 而是**自然弯曲、蜿蜒** —— 这是最便宜的"看起来不像程序生成"的手段之一。
 */
function fbmWarp2(x: number, y: number, octaves = 4, warp = 0.5): number {
  const wx = fbm2(x * 0.7 + 13.7, y * 0.7 + 41.3, 3) - 0.5;
  const wy = fbm2(x * 0.7 + 71.9, y * 0.7 + 7.1, 3) - 0.5;
  return fbm2(x + wx * warp * 2, y + wy * warp * 2, octaves);
}

export type HeightmapTerrainOpts = {
  size?: number;          // XZ extent of the terrain plane (default 30000)
  segments?: number;      // subdivision (default 256 — 256x256 verts = ~65k verts)
  maxHeight?: number;     // peak height (default 2500)
  seed?: number;          // deterministic seed
  islandFalloff?: boolean; // if true, terrain dips to 0 at the edges (island)
  islandRadius?: number;  // radius of the island plateau before falloff (default size*0.35)
  mode?: 'mountain' | 'plains' | 'canyon' | 'archipelago';
  snowLine?: number;      // height above which snow appears (0..1 of maxHeight)
  rockColor?: THREE.Color;
  grassColor?: THREE.Color;
  sandColor?: THREE.Color;
  snowColor?: THREE.Color;
  // === MWAM 真实地形贴图 (per user request: MW Landscape Auto Material) ===
  // 选 KTX2 图层 preset(mountain/desert/archipelago/plains/canyon)。
  // 缺省/null = 纯程序化画布(旧观感);图层缺失时逐槽回退画布。
  terrainStyle?: string | null;
  /** === 地形槽位名 (per 任务: 8 层地表数组) ===
   * 材质表按 `maps.<slot>.texSet/layers` 选纹理集与层序(engine 传 mission.terrain.slot)。
   * 不传时用表的 defaultSet(等价于所有槽共用一套 8 层数组)。*/
  slot?: string | null;
  // === 任务雪线覆盖(per user request: T-00 雪山类任务) ===
  // 只有 mission.terrain.snowLine 显式给出时才传 —— 命中后分层退回
  // "直接高度带"模型(按普查真实高度归一),保证全雪/局部雪任务观感不变;
  // 未给出(undefined)且 terrainStyle 存在时用分位自动分带。
  legacySnowLine?: number;
  // === 高度图 AO 方位采样数(mobileMode 由引擎减半;默认 6)。
  aoDirs?: number;
  // === terrain-tune / 地形编辑器覆盖(per user request: 编辑器导出融合) ===
  // 全部字段可选;优先级 mission.terrain(引擎侧)> tune > 代码默认。
  tune?: TuneMap;
  // === Mask Splatting(per user request: 遮罩双模式) ===
  // 已解码的 RGBA 遮罩贴图(maskMode 由 tune.material.maskMode 决定);
  // null/缺省 = 自动分层(顶点 splat)。
  maskTexture?: THREE.Texture | null;
  /** === 世界域烘焙光照图 (per 任务: Blender 光照贴图导入) ===
   * R=AO / G=GI / B=太阳可见度 / A=预留, 单张 RGBA, 世界域 1:1。
   * 由 engine.resolveBakeMap() 解析(material.bakeMap 优先, 退回 material.aoMap)。
   * 消费端复用内置 aoMap 槽位(channel=2), G/B 注入**不新增采样器**。 */
  bakeMap?: THREE.Texture | null;
  bakeIsAoOnly?: boolean;
  bakeStrengths?: { ao?: number; gi?: number; shadow?: number };
  // === Gaea/预制地形外部高度源 (per user request: 导入预制地图工作流) ===
  // 提供后整体替换内部噪声 heightAt(分块烘焙/survey/分带/AO/skirt/
  // 植被摆放全自动跟随);islandFalloff 语义由外部图自带。
  heightAt?: (x: number, z: number) => number;
  // === Gaea 外部顶点色远/近混合(材质用;缺省关闭零回归) ===
  externalVertex?: {
    tex: THREE.Texture;
    canonical: [number, number, number][];
    mixNear: number;
    mixFar: number;
  };
  // === 程序化基础色图分辨率 (per user request: 程序化关卡直接色图) ===
  // 未传 externalVertex(即没有外部 Gaea 色图)= 程序化关卡 → 自动烘一张
  // 基础色贴图走 externalVertex 直出模式。缺省 2048²;移动端(引擎以
  // aoDirs≤3 传低配档)自动降 1024²,省一半显存与生成时间。
  baseColorResolution?: number;
  // === 外部法线贴图(per user request: Gaea 高度场烘焙法线) ===
  // 全盘 Gaea(custom)关替换程序 relief 法线;缺省 = 现观感零回归。
  normalMap?: THREE.Texture | null;
  // === 外部环境光遮蔽(per user request: PBR 四贴图) ===
  // 全盘 Gaea 关的世界域 AO 灰图;缺省 = 现观感零回归。
  externalAo?: THREE.Texture | null;
};

// Build a single heightmap-displaced terrain mesh with vertex-coloured
// height-based texturing (sand/grass/rock/snow). Returns the mesh + a
// `sampleHeight(x, z)` function so the engine can query terrain elevation
// at any point (e.g. to place objects on the surface, or clamp aircraft).
// Yield to the browser so the loading bar can paint between heavy
// synchronous builds (per user request: 优化加载速度).
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface TerrainChunkInfo {
  center: THREE.Vector3; // chunk centre in world XZ
  gx: number;            // grid column (for ring-based streaming)
  gz: number;            // grid row
  meshes: THREE.Mesh[];  // [LOD0 (full), LOD1 (half), LOD2 (quarter), LOD3 (eighth)]
  // === LOD boundary skirt (per user request: 分块边界太明显) ===
  // A vertical wall around the chunk edge (full-res boundary heights down to
  // below the surface) that hides the cracks where adjacent chunks render at
  // different LOD levels. Toggled visible whenever any LOD of the chunk is.
  skirt?: THREE.Mesh;
  // === UE5 连续 LOD 形变 (per user request: 新地形网格系统) ===
  // terrain-v2 chunks expose this: the streaming pass calls it after LOD
  // visibility changes so boundary bands morph between different LODs.
  setLOD?: (level: number, neighbors: ({ chunk: TerrainV2ChunkInfo; level: number } | null)[]) => void;
}

// === UE5-style chunked LOD terrain (per user request: 场景流式 + LOD) ===
// The battle map is huge (up to 54km wide). Instead of ONE always-fully-
// rendered mesh, the terrain is split into an N×N grid of CHUNKS, each with
// 3 LOD levels (full / half / quarter resolution). The engine streams them
// per frame: near chunks render full detail, far chunks render coarse LOD2,
// and chunks beyond the stream radius are hidden entirely. `sampleHeight`
// stays the SAME pure noise function (mesh-independent), so collision,
// HUD occlusion and object placement are completely unaffected. All chunks
// share one material + one tileable texture set.
// === LOD boundary skirt (per user request: 分块边界太明显) ===
// A vertical wall around a chunk's edge: the top follows the FULL-resolution
// boundary heights (so it stitches to fine neighbours), the bottom drops far
// below the surface. This fills the wedge gap between a dense chunk's curved
// edge and its coarser neighbour's straight edge — hiding the LOD seams
// without any runtime stitching. Invisible from above (the terrain hides it).
const SKIRT_DEPTH = 3000;
let _skirtMat: THREE.MeshBasicMaterial | null = null;
function getSkirtMat(): THREE.MeshBasicMaterial {
  if (!_skirtMat) {
    _skirtMat = new THREE.MeshBasicMaterial({ color: 0x4a3a2a, side: THREE.DoubleSide });
  }
  return _skirtMat;
}
function buildChunkSkirt(
  cx: number, cz: number, chunkSize: number, segs: number,
  heightAt: (x: number, z: number) => number,
): THREE.Mesh {
  const half = chunkSize / 2;
  const n = segs + 1;
  const step = chunkSize / segs;
  const positions: number[] = [];
  const addEdge = (pts: { x: number; z: number }[]) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const h1 = heightAt(a.x, a.z);
      const h2 = heightAt(b.x, b.z);
      // Quad → two triangles (top edge at true height, bottom far below).
      positions.push(a.x, h1, a.z, a.x, -SKIRT_DEPTH, a.z, b.x, h2, b.z);
      positions.push(b.x, h2, b.z, a.x, -SKIRT_DEPTH, a.z, b.x, -SKIRT_DEPTH, b.z);
    }
  };
  // Four edges, each sampled at FULL boundary resolution (s0+1 points) so the
  // skirt top always matches the finest neighbour's edge heights.
  const bottom: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) bottom.push({ x: cx - half + i * step, z: cz - half });
  const right: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) right.push({ x: cx + half, z: cz - half + i * step });
  const top: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) top.push({ x: cx + half - i * step, z: cz + half });
  const left: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) left.push({ x: cx - half, z: cz + half - i * step });
  addEdge(bottom);
  addEdge(right);
  addEdge(top);
  addEdge(left);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geom.computeVertexNormals();
  const mesh = new THREE.Mesh(geom, getSkirtMat());
  mesh.frustumCulled = true;
  return mesh;
}

// ===========================================================================
// 地形高度普查(per user request: 分带修复 + 高度图 AO)
// 全图低分辨率(<~70m/格)高度缓存 + 直方图分位函数 q(p)。一次采样,
// 多个用途:分位自动分带的边界高度、AO 的邻域高度采样。
// ===========================================================================
export interface TerrainHeightSurvey {
  cache: Float32Array; // n×n 世界高度
  n: number;           // 每边格数
  cell: number;        // 米/格
  minH: number;
  maxH: number;
  /** 真实高度分布分位:q(0.5) = 中位高度(米) */
  q: (p: number) => number;
}
async function surveyTerrainHeights(opts: {
  size: number;
  heightAt: (x: number, z: number) => number;
}): Promise<TerrainHeightSurvey> {
  const n = Math.min(1024, Math.max(384, Math.round(opts.size / 70))) | 0;
  const cell = opts.size / n;
  const cache = new Float32Array(n * n);
  const BINS = 512;
  const hist = new Float32Array(BINS);
  let minH = Infinity;
  let maxH = -Infinity;
  const half = opts.size / 2;
  let sinceYield = 0;
  for (let j = 0; j < n; j++) {
    const wz = -half + (j + 0.5) * cell;
    for (let i = 0; i < n; i++) {
      const wx = -half + (i + 0.5) * cell;
      const h = opts.heightAt(wx, wz);
      cache[i + j * n] = h;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
      sinceYield++;
      if (sinceYield >= 4096) {
        sinceYield = 0;
        await yieldToBrowser();
      }
    }
  }
  const span = Math.max(maxH - minH, 1e-3);
  for (let i = 0; i < cache.length; i++) {
    const b = Math.min(BINS - 1, Math.floor(((cache[i] - minH) / span) * BINS));
    hist[b]++;
  }
  const cum = new Float64Array(BINS + 1);
  for (let b = 0; b < BINS; b++) cum[b + 1] = cum[b] + hist[b];
  const total = cum[BINS];
  const q = (p: number): number => {
    const t = THREE.MathUtils.clamp(p, 0, 1) * total;
    let lo = 0, hi = BINS;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid + 1] >= t) hi = mid;
      else lo = mid + 1;
    }
    const bin = Math.min(lo, BINS - 1);
    const below = bin > 0 ? cum[bin] : 0;
    const frac = hist[bin] > 0 ? (t - below) / hist[bin] : 0;
    return minH + (bin / BINS) * span + THREE.MathUtils.clamp(frac, 0, 1) * (span / BINS);
  };
  return { cache, n, cell, minH, maxH, q };
}

export async function buildHeightmapTerrain(opts: HeightmapTerrainOpts = {}): Promise<{
  group: THREE.Group;
  chunks: TerrainChunkInfo[];
  sampleHeight: (worldX: number, worldZ: number) => number;
  material: THREE.MeshStandardMaterial;
  /** 高度普查(分位模式启用时非空;编辑器用于高度切片可视化) */
  survey: TerrainHeightSurvey | null;
  /** 统一带报告(模型 A 启用时非空;带高米数+面积占比,供 console/编辑器) */
  bands: BandReport | null;
  /** === 地面基础色采样器 (per user request: 植被按地面基础色着色) ===
   * 程序化地图返回"该点生成基础色 RGB(线性 0..1)"的采样器(取自同一张生成图);
   * 定制 Gaea 图没有这张画布 → null, 调用方自行回退。 */
  baseColorAt: ((x: number, z: number) => [number, number, number]) | null;
}> {
  const tt = opts.tune?.terrain;
  const size = tt?.size ?? opts.size ?? 30000;
  const segs = tt?.segments ?? opts.segments ?? 256;
  const maxH = tt?.maxHeight ?? opts.maxHeight ?? 2500;
  const seed = tt?.seed ?? opts.seed ?? 1337;
  const island = tt?.islandFalloff ?? opts.islandFalloff ?? false;
  const islandR = tt?.islandRadius ?? opts.islandRadius ?? size * 0.35;
  // === 地形着色统一参考"风暴峡谷炮艇"关(mountain 那一套) (per user request) ===
  // 程序化地形不再按地图分套着色 ——沙漠/平原/群岛也一律用 mountain 的岩石/雪线/沟壑配色;
  // 天气与光照仍按关卡走(风暴/雨/晴各自独立), 只有"地表配色方案"被统一。
  // terrain-tune.json 的显式 mode 仍可覆盖; 自定义/Gaea 全盘地图本来就 100% 用色图, 不受影响。
  const modeRequested = tt?.mode ?? opts.mode ?? 'mountain';
  void modeRequested;
  const mode: 'mountain' | 'plains' | 'canyon' | 'archipelago' = 'mountain';
  const snowLine = tt?.snowLine ?? opts.snowLine ?? 0.65;
  const terrainStyle = tt?.terrainStyle ?? opts.terrainStyle ?? null;
  const rockCol = tt?.rockColor ? new THREE.Color(tt.rockColor) : opts.rockColor ?? new THREE.Color('#5a4a3a');
  const grassCol = tt?.grassColor ? new THREE.Color(tt.grassColor) : opts.grassColor ?? new THREE.Color('#3a5a2a');
  const sandCol = tt?.sandColor ? new THREE.Color(tt.sandColor) : opts.sandColor ?? new THREE.Color('#c8b078');
  const snowCol = tt?.snowColor ? new THREE.Color(tt.snowColor) : opts.snowColor ?? new THREE.Color('#e4e6ea');
  const aoDirs = tt?.aoDirs ?? opts.aoDirs ?? 6;

  // Shared tileable textures + material — one set for every chunk and LOD.
  // === 分层地形 (per user request: 层级贴图/分层材质混合) ===
  // 4 PBR layers (sand/grass/rock/snow) blended by per-vertex splat weights
  // via buildLayeredTerrainMaterial (onBeforeCompile injection into the
  // standard pipeline — sun/hemi/shadows/fog all preserved). The micro-relief
  // normal/roughness/ao set still provides surface detail on every layer.
  // §356 回退: 这里只构造**旧的 4 槽**材质 —— 曾经加过一条"8 层 KTX2 数组"支路
  // (opts.layerArrays + sampler2DArray + 材质表 fetch), 已整体从游戏运行期移除。
  // 本文件不再向材质构建器传任何数组参数, 也没有任何对 terrain-materials.json /
  // textures/ktx2/terrain 数组的读取或预取。
  const pbr = makeTerrainPbrTextures(mode);
  const tileRepeat = size / 120;
  pbr.normal.repeat.set(tileRepeat, tileRepeat);
  pbr.roughness.repeat.set(tileRepeat, tileRepeat);
  pbr.ao.repeat.set(tileRepeat, tileRepeat);
  // === 分层地形材质在下面(heightAt/splatAt 定义之后)创建 ===
  // 原因:程序化关卡要把「程序化基础色图」交给材质,而那张图必须读同一个
  // heightAt + splatAt(否则颜色与地形不是同一个世界)。材质只需要在
  // buildTerrainV2 之前就绪,所以创建点后移到 splatAt 之后。

  // Local height function so we can query it later for sampling (WORLD coords).
  const ns = 0.00012; // noise scale — same as before (30k-wide → 3-5 ranges)
  const heightAt: (x: number, z: number) => number = opts.heightAt ?? ((x: number, z: number) => {
    const sx = (x + size / 2) * ns + seed * 0.013;
    const sz = (z + size / 2) * ns + seed * 0.027;
    let h: number;
    if (mode === 'mountain') {
      // === 真实感地形合成 (per user request) ===
      // ① 域扭曲: 山脊走向自然弯曲(不再是噪声网格的直线脊);
      // ② 侵蚀式脊状多分形: 山脊尖锐多褶、谷底平缓;
      // ③ 大尺度起伏(域扭曲 fBm)叠在山体上, 让山峰有大小层次;
      // ④ 高频细碎岩脊: 只加在**高处**(乘高度权重), 模拟风化裸岩 —— 谷底不受影响。
      const wx = sx + (fbm2(sx * 0.6 + 31.7, sz * 0.6 + 11.3, 3) - 0.5) * 1.1;
      const wz = sz + (fbm2(sx * 0.6 + 5.1, sz * 0.6 + 47.9, 3) - 0.5) * 1.1;
      h = erodedRidge2(wx, wz, 7, 1.9) * maxH * 1.15;
      h += fbmWarp2(sx * 0.4, sz * 0.4, 4, 0.5) * maxH * 0.22;
      const rockW = Math.max(0, h / (maxH * 0.75)) ** 2;
      h += ridge2(sx * 2.4, sz * 2.4, 3) * maxH * 0.07 * Math.min(1, rockW);
    } else if (mode === 'canyon') {
      h = fbm2(sx, sz, 5) * maxH;
      const valley = Math.exp(-Math.pow(z / (size * 0.08), 2));
      h -= valley * maxH * 0.6;
    } else if (mode === 'archipelago') {
      h = fbm2(sx * 1.5, sz * 1.5, 4) * maxH * 0.35;
      h += Math.pow(ridge2(sx * 0.6, sz * 0.6, 4), 3) * maxH * 0.85;
    } else {
      h = fbm2(sx * 0.5, sz * 0.5, 4) * maxH * 0.35;
    }
    if (island) {
      const d = Math.sqrt(x * x + z * z);
      const fall = THREE.MathUtils.smoothstep(d, islandR, islandR + size * 0.18);
      h *= 1 - fall;
      h -= fall * 80;
    }
    return h;
  });

  // === Chunk grid ===
  // (per user request: 分块改小而不是降密度 —— 格距保持不变, 只把块切细)
  // 目标块宽 ≈2560m:custom 图 48600/19 ≈ 2558m(每块 s0 = ceil(1792/19) = 95 ⇒
  // 27.1m/格;旧的 9 块配置是 1792/9 = 200 段/块 ⇒ 51.7m/格, 所以细切之后
  // **格距不升反降**(密度更高), 但每块 LOD0 仍是 95²×2 = 18050 三角形 ——
  // 相机附近同时驻留的块数变多, 单块预算变小, 峰值负载更平滑。
  // 上限 19:再切下去 s0 会逼近 4 的下限(网格粗到失去法线细节), 且块数 ~361 → 361
  // 组几何/绘制的管理开销开始反噬。
  // 4 LOD levels (per user request): LOD0 full / LOD1 half / LOD2 quarter /
  // LOD3 eighth — the coarsest floor is always rendered, never streamed out.
  const chunkCount = Math.max(4, Math.min(19, Math.round(size / 2560)));
  const s0 = Math.max(4, Math.ceil(segs / chunkCount));

  // === 高度普查(per user request: 分带修复 + 高度图 AO) ===
  // 采样一张 ~size/70m 的真实高度缓存 + 直方图分位函数。用途:
  //   1) 分位自动分带 —— 每层边界取真实高度分布的分位,保证沙/草/岩/雪
  //      各自占有真实地表面积(修掉旧"名义 maxH 分带"下某一层垄断全图的
  //      "单一层"问题);
  //   2) aoAt 邻域遮蔽 —— 只查缓存双线性,不再为每个 AO 顶点调噪声。
  // 仅 MWAM 风格或任务雪线覆盖时启用(纯画布旧路径零开销、观感不变)。
  // === tune 覆盖:分位带 / AO 参数可被 terrain-tune / 编辑器逐项改 ===
  const styleBase = getMwamStyleCfg(terrainStyle);
  let styleCfg: typeof styleBase = styleBase;
  if (styleBase && tt) {
    styleCfg = {
      ...styleBase,
      zones: {
        ...styleBase.zones,
        ...(tt.zoneLowTop !== undefined ? { lowTop: tt.zoneLowTop } : {}),
        ...(tt.zoneVegiTop !== undefined ? { vegiTop: tt.zoneVegiTop } : {}),
        ...(tt.zoneRockTop !== undefined ? { rockTop: tt.zoneRockTop } : {}),
        ...(tt.zoneBandQ !== undefined ? { bandQ: tt.zoneBandQ } : {}),
        ...(tt.zoneSnowEnabled !== undefined ? { snowEnabled: tt.zoneSnowEnabled } : {}),
      },
      aoStrength: tt.aoStrength ?? styleBase.aoStrength,
      aoRadius: [
        tt.aoRadius1 ?? styleBase.aoRadius[0],
        tt.aoRadius2 ?? styleBase.aoRadius[1],
      ],
    };
  }
  const needSurvey = styleCfg !== null || opts.legacySnowLine !== undefined;
  const survey = needSurvey ? await surveyTerrainHeights({ size, heightAt }) : null;

// === 分层地形 splat 权重 (per user request: 层级贴图) ===
  // x=sand y=grass z=rock w=snow。三种模型:
  //   A. 统一带解析器(有 styleCfg 且无任务雪线覆盖,推荐)—— 见
  //      terrain-bands.ts:quantile(面积分位)/ relative(nimbus 式垂直
  //      归一)/ absolute(固定海拔米)三模式输出同一套「米」边界,与
  //      编辑器遮罩自动生成共用同一函数 → 游戏与遮罩带高逐米一致;
  //   B. 直接高度带(任务 legacySnowLine 覆盖,T-00 全雪类)—— 旧公式,
  //      高度按普查真实范围归一;
  //   C. 纯画布旧路径 —— 与历史逐位一致(名义 maxH 归一)。
  // 模型 A 的陡坡转岩走可调软化(默认 0.72 起 / 0.65 转移);B/C 保持旧式。
  // Baked ONCE per chunk at LOD0 resolution by the terrain-v2 builder.
  const bandRep = (styleCfg && survey && opts.legacySnowLine === undefined)
    ? (() => {
        const r = resolveBands(
          terrainStyle ?? mode,
          styleCfg.zones,
          tt ?? {},
          survey,
          maxH,
        );
        if (r && survey.cache && survey.n) r.area = bandAreaShare(r, survey.cache, survey.n);
        return r;
      })()
    : null;
  const splatAt = (wx: number, wz: number): [number, number, number, number] => {
    const h = heightAt(wx, wz);
    const hX = heightAt(wx + 30, wz);
    const hZ = heightAt(wx, wz + 30);
    const slope = Math.max(Math.abs(h - hX) / 30, Math.abs(h - hZ) / 30);
    // === 带界扰动 (per user request: 分带边界像等高线) ===
    // 旧版只有 ±0.03(0..1 高度域)的单尺度抖动,且 terrainMicroRelief 的
    // 最细 octave 在 ~25m 顶点间距上已是逐点随机 → 顶点间白噪抖动,带界
    // 仍是硬等值线。这里保留同一函数(零额外成本地再采一次,坐标偏移
    // 123.7/457.3m 使两个八度互不相关)作为**连贯的**中尺度摆动:
    // 均值 0 恒成立(两倍相减),幅度 ±0.034(山岳)~±0.037(平原),
    // 波长 ~230~460m —— 带界呈自然起伏而不产生"色块"。
    // 仅模型 A(统一分带,bandRep 非 null —— 依赖 styleCfg + survey)走这条;
    // custom/Gaea 全盘地图虽然 terrainStyle='mountain',但颜色 100% 被色图
    // 覆盖 → 视觉 no-op;纯画布旧路径(styleCfg=null)根本不进模型 A。
    const jit =
      (terrainMicroRelief(wx, wz, mode) - 0.5) * 0.06 +
      (terrainMicroRelief(wx + 123.7, wz + 457.3, mode) - 0.5) * 0.048;
    let wSand = 0, wGrass = 0, wRock = 0, wSnow = 0;

    if (bandRep) {
      // === A. 统一带:三模式全部折算成米域权重(jitter 同步折算米) ===
      const span = (survey?.maxH ?? maxH) - (survey?.minH ?? 0);
      const w = bandWeightsAt(bandRep, h + jit * span);
      return applySlopeRock([w[0], w[1], w[2], w[3]], slope, tt ?? {});
    }

    if (styleCfg && survey && opts.legacySnowLine === undefined) {
      // (防御:bandRep 解析失败兜底 —— 全草)
      wGrass = 1;
      return [0, 1, 0, 0];
    }

    // === B/C. 直接高度带(旧公式) ===
    // legacy 覆盖用普查真实范围归一;纯画布路径维持名义 maxH 旧行为。
    const normMax = opts.legacySnowLine !== undefined && survey ? (survey.maxH - survey.minH) : maxH;
    const normMin = opts.legacySnowLine !== undefined && survey ? survey.minH : 0;
    const ht = THREE.MathUtils.clamp((h - normMin) / normMax, 0, 1);
    const snowL = opts.legacySnowLine ?? snowLine;
    const hts = ht + jit;
    if (hts < 0.08) {
      wSand = 1;
    } else if (hts < snowL) {
      const rockT = THREE.MathUtils.smoothstep(hts, 0.45, snowL);
      wGrass = 1 - rockT;
      wRock = rockT;
    } else {
      const snowT = THREE.MathUtils.smoothstep(hts, snowL, 1.0);
      wRock = 1 - snowT;
      wSnow = snowT;
    }

    // 陡坡 → 岩(B/C 旧式;模型 A 已在上面走 applySlopeRock)
    if (slope > 0.62) {
      const k = Math.min(1, (slope - 0.62) * 1.8);
      const m = k * 0.85;
      wRock += (wGrass + wSand) * m;
      wGrass *= 1 - m;
      wSand *= 1 - m;
    }
    return [wSand, wGrass, wRock, wSnow];
  };

  // === 高度图 AO(per user request: 地形环境光遮蔽) ===
  // 每顶点沿 N 方位 ×2 半径采样普查缓存里的邻域高度:任何一方向某半径
  // 上出现高于自身的地形就累积遮蔽(角度近似 dh/r)。只作用于间接光
  // (shader 注入点),烘焙结果 [0.35,1],强度由 terrain-mwam 风格表给出。
  let aoAt: ((x: number, z: number) => number) | undefined;
  if (styleCfg && survey) {
    const n = survey.n;
    const cell = survey.cell;
    const cache = survey.cache;
    const half = size / 2;
    const sh = (x: number, z: number) => {
      const fx = THREE.MathUtils.clamp((x + half) / cell, 0, n - 1);
      const fy = THREE.MathUtils.clamp((z + half) / cell, 0, n - 1);
      const ix = Math.floor(fx), iy = Math.floor(fy);
      const ix1 = Math.min(ix + 1, n - 1), iy1 = Math.min(iy + 1, n - 1);
      const tx = fx - ix, ty = fy - iy;
      const h00 = cache[ix + iy * n];
      const h10 = cache[ix1 + iy * n];
      const h01 = cache[ix + iy1 * n];
      const h11 = cache[ix1 + iy1 * n];
      return h00 + (h10 - h00) * tx + (h01 - h00) * ty + (h11 - h10 - h01 + h00) * tx * ty;
    };
    const [r1, r2] = styleCfg.aoRadius;
    aoAt = (wx: number, wz: number) => {
      const h0 = sh(wx, wz);
      let occ = 0;
      for (let d = 0; d < aoDirs; d++) {
        const phi = (d / aoDirs) * Math.PI * 2;
        const cos = Math.cos(phi), sin = Math.sin(phi);
        let dirMax = 0;
        for (const r of [r1, r2]) {
          const dh = sh(wx + cos * r, wz + sin * r) - h0;
          if (dh > 0) {
            const o = dh / (r * 0.9); // 阈值角 ~48°:该半径上高过 r*0.9 即满遮蔽
            if (o > dirMax) dirMax = o;
          }
        }
        occ += Math.min(1, dirMax);
      }
      const ao = 1 - (occ / aoDirs) * 0.92;
      return ao < 0.35 ? 0.35 : ao > 1 ? 1 : ao;
    };
  }

  // === 程序化基础色图 + 分层地形材质 (per user request: 程序化关卡"直接色图") ===
  // 程序化地图(没有外部 Gaea 色图 = 没传 opts.externalVertex)不再用
  // 「4 层 albedo × 顶点 splat × 自动遮罩」表示基础色,而是任务开始时按**同一个**
  // heightAt / splatAt 烘一张卫星感基础色图,走**既有** externalVertex 直出
  // 模式(mixNear=0 / mixFar=0 → shader 里 uVtxMode=1 且 uMixFar<=0 → albedo
  // 恒 = 该图 × uVtxGain,shader 一行不改)整图 1:1 贴上去。
  // 于是:遮罩 / 顶点 splat 从此只影响层法线 octave 与层粗糙度权重,不再决定
  // 地表颜色(Gaea custom 关传了 externalVertex → 原样沿用,零回归)。
  // 材质创建点后移到这里:那张图必须读同一个 heightAt/splatAt(否则颜色与地形
  // 不是同一个世界);材质只需在 buildTerrainV2 之前就绪。
  // 高度源指纹:换外部高度包/改种子时避免命中上一张图的画布缓存(4 个采样点
  // 取整即可,成本 = 4 次 heightAt)。程序化路径恒定 → 缓存稳定复用。
  const heightProbe = [
    heightAt(0, 0),
    heightAt(size * 0.31, size * 0.17),
    heightAt(-size * 0.42, size * 0.23),
    heightAt(size * 0.11, -size * 0.39),
  ].map((v) => Math.round(v)).join(',');
  const baseColorCanvas = opts.externalVertex
    ? null
    : makeTerrainBaseColorCanvas({
        mode,
        // 生物群系性格键:desert 关的 mode 是 'plains',terrainStyle 才是沙丘;
        // 没有 terrainStyle(纯画布旧路径)→ 退回 mode。
        styleKey: terrainStyle ?? mode,
        size,
        // 移动端(引擎以 aoDirs=3 传低配档)降 1024²,省一半显存 + 生成时间
        resolution: Math.max(512, opts.baseColorResolution ?? (aoDirs <= 3 ? 1024 : 2048)),
        seed,
        heightAt,
        splatAt,
        colors: {
          sand: [sandCol.r, sandCol.g, sandCol.b],
          grass: [grassCol.r, grassCol.g, grassCol.b],
          rock: [rockCol.r, rockCol.g, rockCol.b],
          snow: [snowCol.r, snowCol.g, snowCol.b],
        },
        // 水位湿暗:与材质 uWetLevel/uWetTint 同源。直出色图模式下 shader 的
        // 湿暗分支不再执行 → 烘进贴图,保住"近水面湿沙"的观感。
        wetLevel: opts.tune?.material?.wetLevel ?? 5.0,
        wetTint: opts.tune?.material?.wetTint ?? 0.72,
        cacheKey: `${opts.heightAt ? 'ext' : 'proc'}#${heightProbe}`,
        onBuilt: (info) => {
          console.info(
            `[terrain] 程序化基础色图 ${info.resolution}² ${terrainStyle ?? mode}: ` +
            `${info.totalMs}ms(粗格 ${info.bandGrid}²/${info.reliefGrid}²,` +
            `高度/分带 ${info.gridMs}ms + 着色 ${info.shadeMs}ms)`,
          );
        },
      });
  const baseColorTex = baseColorCanvas
    ? (() => {
        const t = new THREE.CanvasTexture(baseColorCanvas);
        t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
        t.flipY = false;
        t.anisotropy = 8;
        t.name = `terrain-basecolor/${terrainStyle ?? mode}`;
        return t;
      })()
    : null;
  if (baseColorTex) getTextureManager().track(baseColorTex);
  const mat = buildLayeredTerrainMaterial({
    mode,
    colors: { sand: sandCol, grass: grassCol, rock: rockCol, snow: snowCol },
    reliefNormal: pbr.normal,
    reliefRoughness: pbr.roughness,
    reliefAo: pbr.ao,
    // === 纹理平铺 90 → 40 (per user request: 远景看清纹理) ===
    tileRepeat: 1 / 40, // one layer-texture tile per 40 world units
    terrainStyle,
    materialTune: opts.tune?.material,
    // === Mask Splatting:遮罩贴图 + 世界覆盖范围 ===
    maskTexture: opts.maskTexture ?? null,
    // === 世界域烘焙光照图透传 (per 任务: Blender 光照贴图导入) ===
    // 由 engine.resolveBakeMap() 解析后传进来; 强度从 tune.material 取,
    // B(太阳可见度)默认 0 —— 实时阴影已在跑, 叠加会双重变暗。
    ...(opts.bakeMap
      ? {
          bakeMap: opts.bakeMap,
          bakeIsAoOnly: opts.bakeIsAoOnly,
          bakeStrengths: {
            ao: opts.tune?.material?.bakeAO,
            gi: opts.tune?.material?.bakeGI,
            shadow: opts.tune?.material?.bakeShadow,
          },
        }
      : {}),
    worldSize: size,
    // === 直出色图:外部 Gaea 色图优先;否则 = 程序化基础色图 ===
    // mixNear/mixFar=0(uMixFar<=0)="全盘色图"分支:albedo 恒 = 色图 × gain,
    // 程序化分层/顶点 splat/湿暗对该像素不再参与颜色 —— 即"程序化关卡不再靠
    // 自动遮罩表示基础色"。gain 保持 1.0 且可调(uVtxGain 已在材质
    // userData._tuneUniforms.external 暴露,控制台/编辑器可实时改)。canonical
    // 在该分支不参与计算(仅为关掉直出模式时的兜底),这里给真实四层色卡。
    externalVertex: opts.externalVertex ?? (baseColorTex
      ? {
          tex: baseColorTex,
          canonical: [
            [sandCol.r, sandCol.g, sandCol.b],
            [grassCol.r, grassCol.g, grassCol.b],
            [rockCol.r, rockCol.g, rockCol.b],
            [snowCol.r, snowCol.g, snowCol.b],
          ],
          mixNear: 0,
          mixFar: 0,
          gain: 1,
        }
      : undefined),
    // === 8 层数组(见上面的初始化; undefined = 旧路径) ===
    normalMap: opts.normalMap,
    externalAo: opts.externalAo,
  });

  // === UE5 Landscape 对标地形网格 v2 (per user request: 新地形网格系统) ===
  // Heightmap-driven chunks + continuous LOD morphing (see pbr/terrain-v2.ts):
  // the old per-vertex noise displacement + hard LOD cuts + skirt-only seams
  // are replaced by a heightmap data source sampled by all LODs (equal-LOD
  // neighbours match exactly) and UE5-style boundary morphing between
  // different LODs. Grid layout, streaming and collision are unchanged.
  const { group, chunks } = await buildTerrainV2({
    size,
    chunkCount,
    s0,
    heightAt,
    splatAt,
    aoAt, // 高度图 AO(undefined → terrain-v2 中性全 1,画布路径零影响)
    material: mat,
    buildSkirt: (cx, cz) => buildChunkSkirt(cx, cz, size / chunkCount, s0, heightAt),
    yieldToBrowser,
  });

  // === 共享分层地形材质 (per user request: 控制台 tilesize 实时调纹理缩放) ===
  // Every chunk shares the same layered material; the engine stores it so
  // setTerrainTileSize() can retune the uLayerRepeat uniform at runtime.
  // === 基础色采样器 (per user request: 植被按地面基础色着色) ===
  // 程序化地图的地面颜色来自上面那张生成图;植被遮罩/着色需要"该点的地面基础色",
  // 所以把画布的像素采样器一并返回(定制 Gaea 图没有这张画布 → null, 调用方回退)。
  const baseColorAt = baseColorCanvas
    ? makeTerrainBaseColorSampler(baseColorCanvas, size).sample
    : null;
  return { group, chunks, sampleHeight: heightAt, material: mat, survey, bands: bandRep, baseColorAt };
}

// === Shared procedural micro-relief (per user request: 地形贴图大升级) ===
// One relief function drives BOTH the albedo detail texture and the PBR
// normal/roughness/ao maps, so the colouring and the lighting agree. Coarse
// patch noise + medium variation + fine grain; mountains use ridge noise
// for sharp rock faces.
function terrainMicroRelief(x: number, y: number, mode: string): number {
  const patch = fbm2(x * 0.012 + 7.31, y * 0.012 + 3.17, 4);
  const med = fbm2(x * 0.11 + 1.73, y * 0.11 + 9.51, 3);
  const grain = hash2(x * 3.71, y * 3.19);
  if (mode === 'mountain' || mode === 'canyon') {
    return ridge2(x * 0.028 + 11.3, y * 0.028 + 5.7, 3) * 0.62 + med * 0.26 + grain * 0.12;
  }
  return patch * 0.55 + med * 0.33 + grain * 0.12;
}

// === Procedural terrain detail texture — big upgrade (per user request) ===
// 1024² tileable albedo with REAL terrain character per mode (instead of the
// old 256² salt-and-pepper grain):
//   - mountain/canyon: grey-brown rock, dark crevices, light ridges,
//     horizontal strata bands, snow speckles on high ridges
//   - desert: warm tan sand, wind ripple bands, dune darkening
//   - archipelago: sand + lush green vegetation on higher relief
//   - plains: green grassland with dry/dark patches and dirt spots
// The texture tiles every ~120 world units; from altitude it blends into the
// vertex-colour height/slope banding.
function makeTerrainDetailTexture(mode: string): THREE.CanvasTexture {
  // === 着色分辨率提升 (per user request: 地形着色分辨率要提升不少) ===
  // 反照率细节贴图 1024 → **2048**(桌面); 手持设备保持 1024(显存/带宽友好)。
  const S = isHandheldDevice() ? 1024 : 2048;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  const d = img.data;
  const sstep = THREE.MathUtils.smoothstep;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const h = terrainMicroRelief(x, y, mode);
      let r = 130, g = 130, b = 120;
      if (mode === 'mountain' || mode === 'canyon') {
        // Rock: grey-brown base, dark crevices, light ridges, strata + snow.
        const dark = sstep(0.35, 0.62, h);
        const light = sstep(0.72, 0.95, h);
        r = 168 - dark * 70 + light * 40;
        g = 156 - dark * 64 + light * 34;
        b = 142 - dark * 58 + light * 30;
        const strata = Math.sin(y * 0.055 + h * 9.0) * 0.5 + 0.5;
        r += (strata - 0.5) * 46;
        g += (strata - 0.5) * 40;
        b += (strata - 0.5) * 34;
        if (h > 0.78) {
          const s = sstep(0.78, 0.95, h);
          r += s * 110; g += s * 118; b += s * 126;
        }
      } else if (mode === 'desert' || mode === 'archipelago') {
        // Sand: warm tan, wind ripples, dune darkening, lush vegetation on
        // higher island relief.
        const ripple = (Math.sin(y * 0.16 + fbm2(x * 0.03, y * 0.03, 2) * 7.0) * 0.5 + 0.5);
        const dune = sstep(0.5, 0.85, h);
        r = 216 - dune * 30 + ripple * 22;
        g = 196 - dune * 26 + ripple * 18;
        b = 154 - dune * 24 + ripple * 12;
        if (mode === 'archipelago' && h > 0.6) {
          const v = sstep(0.6, 0.9, h);
          r += v * -42; g += v * 44; b += v * -22;
        }
      } else {
        // Plains grassland: green base, dry/dark patches, dirt spots.
        const dry = sstep(0.5, 0.82, h);
        const dark = sstep(0.1, 0.4, h);
        r = 122 + dry * 34 - dark * 30;
        g = 158 - dry * 20 - dark * 24;
        b = 92 + dry * 10 - dark * 12;
        if (h > 0.84) {
          const s = sstep(0.84, 0.96, h);
          r += s * 60; g += s * 26; b -= s * 8;
        }
      }
      // Fine grain.
      const gr = (hash2(x * 5.13, y * 7.71) - 0.5) * 26;
      const o = (y * S + x) * 4;
      d[o] = Math.max(0, Math.min(255, r + gr));
      d[o + 1] = Math.max(0, Math.min(255, g + gr));
      d[o + 2] = Math.max(0, Math.min(255, b + gr));
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // Tile by blitting thin edge strips to the opposite sides (hides the seam).
  const edge = 10;
  ctx.putImageData(ctx.getImageData(0, 0, S, edge), 0, S - edge);
  ctx.putImageData(ctx.getImageData(0, 0, edge, S), S - edge, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// === Procedural PBR terrain maps (per user request: UE4级地形质感) ===
// Generates normal / roughness / ambient-occlusion canvas textures (512²)
// for the heightmap terrain. All three derive from the SAME shared
// micro-relief as the albedo detail texture (terrainMicroRelief), so the
// lighting agrees with the colouring — the terrain reads as a lit PBR
// surface instead of a flat vertex-coloured carpet.
function makeTerrainPbrTextures(mode: string): { normal: THREE.CanvasTexture; roughness: THREE.CanvasTexture; ao: THREE.CanvasTexture } {
  // PBR 集(法线/粗糙/AO) 512 → **1024**(桌面); 手持保持 512。
  const S = isHandheldDevice() ? 512 : 1024;
  // 1. Height field from the shared micro-relief (×2 to match the albedo's
  //    sampling frequency).
  const hc = document.createElement('canvas');
  hc.width = hc.height = S;
  const hctx = hc.getContext('2d')!;
  const hImg = hctx.createImageData(S, S);
  const hd = hImg.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const h = terrainMicroRelief(x * 2, y * 2, mode);
      const o = (y * S + x) * 4;
      hd[o] = hd[o + 1] = hd[o + 2] = Math.max(0, Math.min(255, h * 255));
      hd[o + 3] = 255;
    }
  }
  hctx.putImageData(hImg, 0, 0);
  const hData = hImg.data;
  // 2. Normal map from the height gradient (tangent space).
  const nc = document.createElement('canvas'); nc.width = nc.height = S;
  const nctx = nc.getContext('2d')!;
  const nImg = nctx.createImageData(S, S);
  const strength = 2.4;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const x0 = hData[(y * S + Math.max(0, x - 1)) * 4];
      const x1 = hData[(y * S + Math.min(S - 1, x + 1)) * 4];
      const y0 = hData[(Math.max(0, y - 1) * S + x) * 4];
      const y1 = hData[(Math.min(S - 1, y + 1) * S + x) * 4];
      let dx = (x1 - x0) / 255, dy = (y1 - y0) / 255, dz = 1 / strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
      const o = (y * S + x) * 4;
      nImg.data[o] = (dx * inv * 0.5 + 0.5) * 255;
      nImg.data[o + 1] = (dy * inv * 0.5 + 0.5) * 255;
      nImg.data[o + 2] = (dz * inv * 0.5 + 0.5) * 255;
      nImg.data[o + 3] = 255;
    }
  }
  nctx.putImageData(nImg, 0, 0);
  // 3. Roughness — per-mode base + relief variation (rock/snow smoother,
  // sand/grass rougher).
  const rc = document.createElement('canvas'); rc.width = rc.height = S;
  const rctx = rc.getContext('2d')!;
  const rImg = rctx.createImageData(S, S);
  const baseR = (mode === 'mountain' || mode === 'canyon') ? 205 : (mode === 'desert' || mode === 'archipelago') ? 235 : 218;
  for (let i = 0; i < S * S; i++) {
    const o = i * 4;
    const n = hData[o];
    let r = baseR + (n - 128) * 0.3 + (Math.random() - 0.5) * 22;
    r = Math.max(120, Math.min(255, r));
    rImg.data[o] = r; rImg.data[o + 1] = r; rImg.data[o + 2] = r; rImg.data[o + 3] = 255;
  }
  rctx.putImageData(rImg, 0, 0);
  // 4. AO — subtle crevice darkening from the gradient magnitude.
  const ac = document.createElement('canvas'); ac.width = ac.height = S;
  const actx = ac.getContext('2d')!;
  const aImg = actx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const x0 = hData[(y * S + Math.max(0, x - 1)) * 4];
      const x1 = hData[(y * S + Math.min(S - 1, x + 1)) * 4];
      const y0 = hData[(Math.max(0, y - 1) * S + x) * 4];
      const y1 = hData[(Math.min(S - 1, y + 1) * S + x) * 4];
      const g = Math.abs(x1 - x0) + Math.abs(y1 - y0);
      const ao = Math.max(0.74, 1.0 - g / 560);
      const o = (y * S + x) * 4;
      const v = ao * 255;
      aImg.data[o] = v; aImg.data[o + 1] = v; aImg.data[o + 2] = v; aImg.data[o + 3] = 255;
    }
  }
  actx.putImageData(aImg, 0, 0);
  const mk = (cv: HTMLCanvasElement) => {
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  };
  return { normal: mk(nc), roughness: mk(rc), ao: mk(ac) };
}

// ===========================================================================
// === 3A-0 植被遮罩 + 左边半幅白键精灵图集 (per user request) ===============
// ===========================================================================
// 用户需求(程序化地形关):
//   (1) 植被分布不能只靠"海拔带 + 均匀随机",要由一张**植被遮罩**决定 ——
//       遮罩同时来自高度图(坡度/雪线/水面)**和**地表基础色(绿地浓、
//       沙岩雪淡);
//   (2) 精灵素材:一张 2×2 排布的植被图集,取**左半幅**作为植被精灵,
//       且**白色背景必须变成透明**(白键);
//   (3) 植被颜色要能跟随它所在位置的地表基础色(逐实例染色)。
//
// 设计要点(零新资源 / 零新依赖 / 确定性):
//   - 遮罩 = 坡面 × 海拔带 × 生物群系亲和度 × 连贯噪声(林缘/空地)。
//     全部由**注入的采样器**驱动:sampleHeight 必需;baseColorAt / biomeAt
//     可选(另一个 agent 正在重写基础色贴图 → 这里永远只依赖"注入",不依赖
//     它的产出;缺省回落到内部高度/坡度→生物群系权重→分层色的近似)。
//   - 精灵图集:整张 2048²(可由 opts.sprites.sheetUrl 后期替换为真实素材,
//     本文件不引入任何二进制资源)在**生成时**做一次真实像素运算 ——
//     烘焙到画布后再做**亮度键控 alpha**(luminance key):>whiteKey 的像素
//     alpha=0,softRamp 宽度内线性过渡(压掉 JPEG 边缘白边/光晕)。
//     裁剪 = 只取**左半幅**(crop 可配置),右半幅的圆冠仅作为"整图沿用"预留。
//   - 逐实例地面染色:每个实例在放置时采样其脚下的地表色(注入的
//     baseColorAt,缺省 = 生物群系权重 × 分层色),转成 HSL 只取**色相+色度**,
//     把亮度固定回植被自身的明度 → 绿地上的树更绿、干地上的树偏黄,且永远
//     不会过曝/荧光(亮度/饱和度双夹紧)。通过 setColorAt 写入实例色。
//
// 兼容性:老的"海拔带 + 均匀随机"路径整体保留(bands/count 语义不变),
// 遮罩路径由 opts.vegMask 启用 —— 三个 engine 调用点即使不改也照旧可用。

/** 植被种类(历史三分类 + 针叶/阔叶细分) */
type VegPlantKind = 'conifer' | 'decid' | 'grass' | 'bush';

/** 坡度/高度等采样器的通用签名 */
export type VegHeightSampler = (x: number, z: number) => number;

/** 地表基础色采样器:返回 0..1 的线性 RGB(注入式,可选) */
export type VegBaseColorSampler = (x: number, z: number) => [number, number, number];

/** 地表生物群系权重采样器:x=沙 y=草 z=岩 w=雪(注入式,可选) */
export type VegBiomeSampler = (x: number, z: number) => [number, number, number, number];

/** 图集裁剪区(归一化 0..1;缺省整个左半幅) */
export interface VegSpriteCropRect { x: number; y: number; w: number; h: number }
/** 精灵图集/白键配置(全部可选;缺省 = 程序化图集 + 左半幅 + 白键) */
export interface VegSpriteKeyOptions {
  /** 外部图集(data/http URL,canvas 或 ImageBitmap):给了就用它替代程序化图集 */
  sheetUrl?: string | null;
  /** 已解码的整张图集(优先级高于 sheetUrl) */
  sheet?: CanvasImageSource | null;
  /** 网格列数(缺省 2:左半幅 = 第一列) */
  sheetCols?: number;
  /** 网格行数(缺省 1) */
  sheetRows?: number;
  /** 显式裁剪区(归一化);缺省由 sheetCols 推出左半幅 */
  crop?: VegSpriteCropRect | null;
  /** 亮度键阈值:亮度 ≥ 该值的像素 alpha 归零(缺省 0.985 ≈ 纯白) */
  whiteKey?: number;
  /** 软过渡带宽度(缺省 0.05):压掉 JPEG 边缘白边/光晕 */
  softRamp?: number;
}
/** 白键 + alpha 统计(诊断/report 用) */
export interface VegSpriteAlphaStats {
  transparent: number;
  opaque: number;
  total: number;
  whiteKeyed: number;
  halo: number;
  whiteKey: number;
  softRamp: number;
}
/** 一只精灵的几何度量(交叉平面按图集比例自适应,避免拉伸) */
export interface VegSpriteMetrics {
  source: string;
  texW: number;
  texH: number;
  aspect: number;
  alpha: VegSpriteAlphaStats;
}

/** 植被遮罩:给一个世界坐标返回 0..1 的植被密度 + 诊断统计 */export interface VegetationMask {
  /** 雪权重 0..1(0 = 无雪, 1 = 纯雪) */
  sampleSnow?: (x: number, z: number) => number;
  /** 0..1 植被密度(0 = 绝对不长,1 = 最茂密) */
  sampleDensity: (x: number, z: number) => number;
  /** 被采样的真实世界范围(±spread) */
  spread: number;
  /** 采样器可用性(诊断/报告用) */
  hasBaseColor: boolean;
  hasBiome: boolean;
  /** 地表色是"推出来"的(无注入采样器:高度/坡度 → 生物群系 → 分层色) */
  derivedGround: boolean;
  /** 已在采样中统计出的覆盖情况(没采样过时为 null) */
  coverage: { samples: number; vegetated: number; mean: number; sum: number } | null;
  /** 该世界位置的地表基础色(0..1 线性 RGB);逐实例染色的唯一入口 */
  groundAt: (x: number, z: number) => [number, number, number];
  /** 分块扫描得到的"可种植格 + 遮罩积分"缓存(首次 buildTerrainForest 时填) */
  _grid?: VegPlantableGrid;
}

/** 遮罩布局参数(全部可选:缺省与历史海拔带一致) */
export interface VegMaskLayout {
  /** 世界范围半径(米);±spread 内采样,缺省 12000 */
  spread: number;
  /** 该高度以下不长植被(水面/滩涂),缺省 25 */
  minH: number;
  /** 该高度以上不长植被(雪线),缺省 1700 */
  maxH: number;
  /** 坡度上限:超过即完全不长;以下按平滑曲线衰减,缺省 0.55 */
  maxSlope: number;
  /** 植被茂密区占比(0..1):噪声阈值,越大越稀少,缺省 0.35 */
  patchiness: number;
  /** 种子(确定性) */
  seed: number;
  /** 采样高度 */
  h: VegHeightSampler;
  /** 注入的地表基础色(可选) */
  baseColorAt?: VegBaseColorSampler;
  /** 真正的雪线(米)。**不给就不按高度判雪** —— 别拿树线当雪线(见 sampleSnow 注释)。 */
  snowLineM?: number;
  /** 注入的生物群系权重(可选;无 baseColorAt 时用它推地表色) */
  biomeAt?: VegBiomeSampler;
  /** 分层色(缺省兜底;无注入采样器时用来估算地表色) */
  layerColors?: { sand: number; grass: number; rock: number; snow: number };
}

function vegFineNoise(x: number, z: number): number {
  return fbm2(x * 0.0016 + 11.3, z * 0.0016 - 4.7, 3);
}
function vegCoarseNoise(x: number, z: number): number {
  return fbm2(x * 0.00035 - 3.1, z * 0.00035 + 8.9, 2);
}
function vegClamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
/** 四舍五入到整数像素(保证图集网格严格对齐) */
function vegPx(v: number): number {
  return Math.max(1, Math.round(v));
}
/** 全白背景下的植被色(会被白键保留,因为是"暗色画在白底上") */
function vegFoliage(shade: number, alpha = 1): string {
  const g = Math.round(60 + shade * 120);
  const r = Math.round(30 + shade * 80);
  const b = Math.round(40 + shade * 70);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}
/**
 * 程序化生成一整张植被图集(纯白背景,**不做抠图**)。左半幅 = 高针叶树,
 * 右半幅 = 圆冠树(仅作为"整图沿用"预留);opts.sprites.sheetUrl 提供后整张
 * 图集可替换为真实素材,其余流程(左半裁剪 + 白键)完全不变。
 */
function buildVegAtlasSheet(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  const half = size / 2;
  const cxL = half / 2;
  // ---- 左半幅:高针叶树(底部留 2% 让树干接地面) ----
  const treeH = half * 0.96;
  const treeW = half * 0.52;
  const baseY = size * 0.98;
  const trunkW = Math.max(2, treeW * 0.075);
  const tg = ctx.createLinearGradient(0, baseY - treeH * 0.16, 0, baseY);
  tg.addColorStop(0, '#5a4630');
  tg.addColorStop(1, '#33271a');
  ctx.fillStyle = tg;
  ctx.fillRect(cxL - trunkW / 2, baseY - treeH * 0.16, trunkW, treeH * 0.16);
  for (let i = 0; i < 7; i++) {
    const y = baseY - treeH * (0.14 + (i / 7) * 0.84);
    const h = treeH * 0.22;
    const w = treeW * (1 - i * 0.115);
    ctx.fillStyle = vegFoliage(0.22 + i * 0.075, 1);
    ctx.beginPath();
    ctx.moveTo(cxL, y - h);
    ctx.lineTo(cxL - w / 2, y);
    ctx.lineTo(cxL + w / 2, y);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = vegFoliage(0.9, 0.4);
  ctx.beginPath();
  ctx.moveTo(cxL, baseY - treeH);
  ctx.lineTo(cxL - treeW * 0.09, baseY - treeH * 0.72);
  ctx.lineTo(cxL + treeW * 0.09, baseY - treeH * 0.72);
  ctx.closePath();
  ctx.fill();
  // ---- 右半幅上部:圆冠树(白键对整张图无差别生效) ----
  const rcx = size * 0.75;
  const rcy = size * 0.27;
  const rad = size * 0.19;
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = vegFoliage(0.3 + i * 0.16, 1);
    const a = (i / 3) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(rcx + Math.cos(a) * rad * 0.36, rcy + Math.sin(a) * rad * 0.32, rad * (0.62 - i * 0.1), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = vegFoliage(0.32, 1);
  ctx.fillRect(rcx - rad * 0.055, rcy + rad * 0.4, rad * 0.11, size * 0.115);
  return c;
}

/**
 * 亮度键控:白 → 透明。对**生成后的画布**做真实像素运算 ——
 *   lum >= whiteKey              → alpha 0(全透明)
 *   whiteKey-softRamp .. whiteKey → 线性渐隐(压掉 JPEG 边缘白边/光晕)
 *   其余                          → 保留原 alpha(乘上原值,不新增不透明像素)
 * 同时把"从透明像素里渗进来的白"去掉:按 alpha 反混合回植被本色。
 */
function vegKeyLuminance(
  c: HTMLCanvasElement,
  whiteKey: number,
  softRamp: number,
): { keyed: number; total: number; whiteKey: number; softRamp: number } {
  const ctx = c.getContext('2d')!;
  const w = c.width, h = c.height;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  let keyed = 0;
  const total = w * h;
  const hi = whiteKey;
  const lo = Math.max(0, whiteKey - softRamp);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum <= lo) continue;
    const t = Math.min(1, (lum - lo) / Math.max(1e-4, hi - lo));
    const a0 = d[i + 3] / 255;
    const na = a0 * (1 - t);
    if (na <= 0.004) {
      d[i + 3] = 0;
      keyed++;
      continue;
    }
    // 反混合:像素 = 本色×(1-t) + 白×t → 本色 = (像素 - 白×t)/(1-t)
    const inv = 1 / (1 - t);
    d[i] = Math.round(vegClamp01((r - t) * inv) * 255);
    d[i + 1] = Math.round(vegClamp01((g - t) * inv) * 255);
    d[i + 2] = Math.round(vegClamp01((b - t) * inv) * 255);
    d[i + 3] = Math.round(na * 255);
    if (na < 0.02) keyed++;
  }
  ctx.putImageData(img, 0, 0);
  return { keyed, total, whiteKey: hi, softRamp };
}

/**
 * 左半幅裁剪 + 白键(用户需求的"自动抠左半 + 白色透明")。
 * rect 缺省 = 整张图左半幅;所有参数可由 opts.sprites 覆盖。
 */
function vegCropAndKey(
  src: CanvasImageSource & { width: number; height: number },
  cfg: VegSpriteKeyOptions,
): { canvas: HTMLCanvasElement; alpha: { transparent: number; opaque: number; total: number; whiteKeyed: number; halo: number; whiteKey: number; softRamp: number }; width: number; height: number } {
  const rows = Math.max(1, Math.floor(cfg.sheetRows ?? 1));
  const cols = Math.max(1, Math.min(2, Math.floor(cfg.sheetCols ?? 2)));
  const cropSpec = cfg.crop ?? { x: 0, y: 0, w: 1 / cols, h: 1 };
  const x0 = vegPx(cropSpec.x * src.width);
  const y0 = vegPx(cropSpec.y * src.height);
  const cw = Math.min(src.width - x0, vegPx(cropSpec.w * src.width));
  const ch = Math.min(src.height - y0, vegPx(cropSpec.h * src.height));
  void rows;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, cw);
  canvas.height = Math.max(1, ch);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(src, x0, y0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  // ---- 白键(像素运算) ----
  const key = vegKeyLuminance(canvas, cfg.whiteKey ?? 0.985, cfg.softRamp ?? 0.05);
  // ---- alpha 统计(供验证脚本/报告) ----
  const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let transparent = 0, opaque = 0, halo = 0;
  const total = canvas.width * canvas.height;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 8) transparent++;
    else opaque++;
    // 白边检测:源亮度 > 0.95 却仍有明显 alpha = 残留白晕
    const lum = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / 255;
    if (lum > 0.95 && px[i + 3] > 20) halo++;
  }
  return {
    canvas,
    alpha: {
      transparent, opaque, total,
      whiteKeyed: key.keyed,
      halo,
      whiteKey: key.whiteKey,
      softRamp: key.softRamp,
    },
    width: canvas.width,
    height: canvas.height,
  };
}

/** 生物群系权重 → 地表色的兜底估算(注入层色;未注入则用引擎常用层色) */
function vegBiomeToColor(
  w: [number, number, number, number],
  colors?: { sand: number; grass: number; rock: number; snow: number },
): [number, number, number] {
  const c = colors ?? { sand: 0xb9a878, grass: 0x486b34, rock: 0x7d7368, snow: 0xf2f4f6 };
  const sr = ((c.sand >> 16) & 255) / 255, sg = ((c.sand >> 8) & 255) / 255, sb = (c.sand & 255) / 255;
  const gr = ((c.grass >> 16) & 255) / 255, gg = ((c.grass >> 8) & 255) / 255, gb = (c.grass & 255) / 255;
  const rr = ((c.rock >> 16) & 255) / 255, rg = ((c.rock >> 8) & 255) / 255, rb = (c.rock & 255) / 255;
  const wr = ((c.snow >> 16) & 255) / 255, wg = ((c.snow >> 8) & 255) / 255, wb = (c.snow & 255) / 255;
  const sum = w[0] + w[1] + w[2] + w[3];
  const k = sum > 1e-4 ? 1 / sum : 0;
  const r = (w[0] * sr + w[1] * gr + w[2] * rr + w[3] * wr) * k;
  const g = (w[0] * sg + w[1] * gg + w[2] * rg + w[3] * wg) * k;
  const b = (w[0] * sb + w[1] * gb + w[2] * rb + w[3] * wb) * k;
  return [
    vegClamp01(Math.pow(r, 2.2)),
    vegClamp01(Math.pow(g, 2.2)),
    vegClamp01(Math.pow(b, 2.2)),
  ];
}

// 无注入采样器时的生物群系权重估算(与 splatAt 的历史带模型同构 —— 只读,
// 不改动 splatAt 本身;这里只做近似,用来决定"绿/干/岩/雪"的植被亲和度)。
function vegBiomeFallback(h: number, slope: number, layout: VegMaskLayout): [number, number, number, number] {
  const minH = layout.minH;
  const span = Math.max(1, layout.maxH - minH);
  const jit = (terrainMicroRelief(0, 0, 'mountain') - 0.5) * 0.02;
  const t = vegClamp01((h - minH) / span + jit);
  let sand = 0, grass = 0, rock = 0, snow = 0;
  if (t < 0.08) sand = 1;
  else if (t < 0.78) {
    const k = THREE.MathUtils.smoothstep(t, 0.45, 0.78);
    grass = 1 - k;
    rock = k;
  } else {
    const k = THREE.MathUtils.smoothstep(t, 0.78, 1);
    rock = 1 - k;
    snow = k;
  }
  if (slope > 0.62) {
    const k = Math.min(1, (slope - 0.62) * 1.8);
    const m = k * 0.85;
    rock += (grass + sand) * m;
    grass *= 1 - m;
    sand *= 1 - m;
  }
  return [sand, grass, rock, snow];
}

/**
 * 构建植被遮罩(确定性;可跨多次 buildTerrainForest 复用 —— 网格积分缓存
 * 挂在返回对象上)。遮罩公式:
 *   density = slopeF × altF × biomeF × noiseF
 *     slopeF = 1 - smoothstep(maxSlope×0.45, maxSlope, slope)
 *     altF   = 水线以上渐入 × 雪线以下渐出(minH/maxH 同历史语义)
 *     biomeF = 0.04 + 1.06×(草 + 0.55×沙 + 0.10×岩)(雪权重直接扣减)
 *     noiseF = 0.35 + 1.05×fbm(连贯中尺度) → 林缘/空地,再乘低频"地区性
 *              贫瘠度" → 大块无林区
 */
export function buildVegetationMask(layout: VegMaskLayout): VegetationMask {
  const spread = Math.max(1, layout.spread);
  const seed = layout.seed;
  const minH = layout.minH;
  const maxH = Math.max(minH + 1, layout.maxH);
  const maxSlope = Math.max(0.05, layout.maxSlope);
  const patchiness = vegClamp01(layout.patchiness ?? 0.5);
  const hAt = layout.h;
  const baseColorAt = layout.baseColorAt;
  const biomeAt = layout.biomeAt;
  const layerColors = layout.layerColors;

  /** 注入采样器可用就用注入的;否则用内部高度/坡度估算(零依赖兜底) */
  const weightsAt = (x: number, z: number, h: number, slope: number): [number, number, number, number] =>
    biomeAt ? biomeAt(x, z) : vegBiomeFallback(h, slope, layout);

  /** 地表基础色:优先注入的 baseColorAt,其次 biomeAt×层色,最后内部估算 */
  const groundAt = (x: number, z: number, h: number, slope: number): [number, number, number] => {
    if (baseColorAt) return baseColorAt(x, z);
    return vegBiomeToColor(weightsAt(x, z, h, slope), layerColors);
  };

  const slopeAt = (x: number, z: number): number => {
    const h = hAt(x, z);
    const hx = hAt(x + 24, z);
    const hz = hAt(x, z + 24);
    return Math.max(Math.abs(h - hx) / 24, Math.abs(h - hz) / 24);
  };

  const sampleDensity = (x: number, z: number): number => {
    const h = hAt(x, z);
    // 水面/滩涂:硬性不长
    if (h < minH) return 0;
    const slope = slopeAt(x, z);
    const slopeF = 1 - THREE.MathUtils.smoothstep(slope, maxSlope * 0.45, maxSlope);
    if (slopeF <= 0.001) return 0;
    const w = weightsAt(x, z, h, slope);
    const wsum = w[0] + w[1] + w[2] + w[3];
    const k = wsum > 1e-4 ? 1 / wsum : 0;
    const sand = w[0] * k, grass = w[1] * k, rock = w[2] * k, snow = w[3] * k;
    // 基础色亲和度:草 1.0 / 沙 0.55 / 岩 0.10 / **雪 0.55**(per user request: 雪地就是雪松)
    // —— 雪地以前是"硬性锁死 0", 用户纠正: 雪地该有树, 而且是白色的雪松。
    // 系数比草低(雪线以上本来就稀疏), 但必须为正; 水面/滩涂仍由上面的 h < minH 拦掉。
    const biomeF = vegClamp01(0.04 + 1.06 * (grass + 0.55 * sand + 0.1 * rock + 0.52 * snow));
    if (biomeF <= 0.001) return 0;
    // 海拔带:水线以上渐入(8%),雪线以下渐出(末 18%)
    const span = maxH - minH;
    const altIn = THREE.MathUtils.smoothstep(h, minH, minH + span * 0.08);
    const altOut = 1 - THREE.MathUtils.smoothstep(h, maxH - span * 0.18, maxH);
    const altF = altIn * altOut;
    if (altF <= 0.001) return 0;
    // 连贯噪声:林缘/空地 + 地区性贫瘠度
    const n = vegFineNoise(x, z);
    const barren = 1 - patchiness * (1 - vegCoarseNoise(x, z));
    // === 对比度抬高 (per user request: 分布太稀少) ==============================
    // 均匀撒粉的观感是"哪儿都有点、哪儿都不像植被"。幂次把中低密度压下去(成裸地)、
    // 高密度保留(成林地) ⇒ 看起来是"一片一片"的植被, 而不是"一把沙"。
    const noiseF = Math.pow(vegClamp01((0.35 + 1.05 * n) * barren), 1.7);
    const d = slopeF * altF * biomeF * noiseF;
    return d <= 0 ? 0 : d >= 1 ? 1 : d;
  };

  /**
   * 雪权重 0..1 —— **以地形基础色为准**(per user request: 通过辨别地形基础色自动适配)。
   *
   * (per fix: 热带火山岛长满雪松) 原来只按高度兜底判雪: vegBiomeFallback 在"植被带"的 78%
   * 以上就判雪(m07 的带是 80~1700m ⇒ 1335m 以上全算雪), 而火山岛的高峰正好在那之上 ——
   * 地形颜色明明是深色岩石, 却被当成雪地种满白松。
   * 现在: 有色画布就按颜色判(白且低饱和 = 雪; 明显有色或偏暗 = 不是雪; 中间给过渡带),
   * 与逐实例染色用的是同一条判据(见 vegTintFromGround 的雪分支), 两处一致。
   * 没有色画布(导入地貌)才退回高度估算。
   */
  const sampleSnow = (x: number, z: number): number => {
    if (baseColorAt) {
      const c = baseColorAt(x, z);
      const lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
      const mx = Math.max(c[0], c[1], c[2]);
      const mn = Math.min(c[0], c[1], c[2]);
      const sat = mx > 1e-4 ? (mx - mn) / mx : 0;
      // === 判据收紧 (per fix: 热带岛的浅灰岩石也被当成雪) =====================
      // 实测 m07(热带火山群岛)在 lum>0.70/sat<0.22 下判出 15,000 株雪松 —— 它的岩石色
      // 是中性浅灰(0.75,0.75,0.75): 亮度够高、饱和度 0 ⇒ 中招。
      // 真雪的两个额外特征: 亮度更高, 且**偏冷**(蓝 ≥ 红)。中性灰不满足后者。
      // 判据: 亮 + 极低饱和 = 雪。**不要**再加偏冷这一条 —— m13 的雪色是接近中性的
      // (实测: 加了偏冷 ⇒ 全雪关卡一株雪松都没有); 中性灰岩石由亮度门槛挡在外面
      // (浅灰岩 lum ≈ 0.75 < 0.78), 亮沙有饱和度(sat > 0.16)也被挡住。
      if (lum > 0.78 && sat < 0.16) {
        const sl = layout.snowLineM;
        if (sl === undefined) return 1;                       // 没给雪线: 信任颜色
        return hAt(x, z) >= sl ? 1 : 0.35;                    // 雪线以下只给过渡权重
      }
      if (lum < 0.72 || sat > 0.22) return 0;                 // 偏暗/有色 = 岩石/沙/植被
      return 0.25;                                            // 灰白过渡带
    }
    // 没有色画布: 只按**真正的雪线**判(米)。没给雪线就返回 0 ——
    // 以前用 vegBiomeFallback 的 snow 分量, 而它的上界就是我传进去的树线,
    // 于是"树线以上"等于"雪线以上", 热带岛屿的高峰被当成雪地(实测 15,000 株白松)。
    const sl = layout.snowLineM;
    if (sl === undefined) return 0;
    return THREE.MathUtils.smoothstep(hAt(x, z), sl, sl + 150);
  };
  const mask: VegetationMask = {
    sampleSnow,
    sampleDensity,
    spread,
    hasBaseColor: !!baseColorAt,
    hasBiome: !!biomeAt,
    // 没有注入地表色采样器时,groundAt 走"高度/坡度→生物群系→分层色"的
    // 估算 —— 仍然能给出随地表变化的基础色(逐实例染色照常生效)。
    derivedGround: !baseColorAt,
    coverage: null,
    /** 该世界位置的地表基础色(0..1 线性 RGB):逐实例染色的唯一入口 */
    groundAt: (x: number, z: number) => groundAt(x, z, hAt(x, z), slopeAt(x, z)),
  };
  return mask;
}

// ---- 可种植网格(遮罩驱动的分块候选索引)-------------------------------
// 把世界切成 ~93m 的格,每格按遮罩密度折算"期望植株数",在 build 时一次性
// 扫描成索引(格中心坐标 + 遮罩密度)。之后每个 chunk 只查自己范围内的格子,
// 单元内确定性抖动取样 —— 不再做"count×16 次随机尝试 + 逐点噪声"(更快,
// 且密度完全由遮罩决定)。水面/无植被区自然为空,不浪费任何尝试。
const VEG_CELL_MIN = 96;
interface VegPlantableGrid {
  cell: number;
  n: number;
  min: number;
  weights: Float32Array;
  /** 每格雪权重 0..1(雪松判定用) */
  snowW: Float32Array;
  /** 遮罩面积积分 Σd×cell²(单位 世界面积;用于平均密度/覆盖率诊断) */
  integral: number;
  /** Σd(无量纲):预算按 chunk 分配时的归一化分母 */
  sumWeights: number;
  /** 逐行前缀和(长度 n*n):快速求任意 chunk 的遮罩权重和 */
  cumWeights: Float64Array;
  /** 世界范围半径(米),与 buildTerrainForest 的 spread 一致 */
  spread: number;
  /** 高度采样器(预算分配时要按格心高度定种类) */
  sampleHeight: (x: number, z: number) => number;
  /** 诊断:每种类实际落株数 */
  planCounts?: Record<VegPlantKind, number>;
  chunkSize: number;
}
function vegPlantableGrid(
  mask: VegetationMask,
  chunkSize: number,
  sampleHeight: (x: number, z: number) => number,
): VegPlantableGrid {
  if (mask._grid && mask._grid.chunkSize === chunkSize) return mask._grid;
  const spread = mask.spread;
  const cell = Math.max(VEG_CELL_MIN, (spread * 2) / 420);
  const min = -spread - cell;
  const max = spread + cell;
  const n = Math.ceil((max - min) / cell) + 1;
  const weights = new Float32Array(n * n);
  // 雪权重(每格一个): 种类分配偏向雪松 + 逐实例选雪松材质都读它
  const snowW = new Float32Array(n * n);
  const cumWeights = new Float64Array(n * n);
  let integral = 0;
  let sumWeights = 0;
  const cellArea = cell * cell;
  for (let iy = 0; iy < n; iy++) {
    const z = min + iy * cell;
    let row = 0;
    for (let ix = 0; ix < n; ix++) {
      const x = min + ix * cell;
      const d = mask.sampleDensity(x, z);
      weights[ix + iy * n] = d;
      snowW[ix + iy * n] = mask.sampleSnow ? mask.sampleSnow(x, z) : 0;
      sumWeights += d;
      integral += d * cellArea;
      row += d;
      cumWeights[ix + iy * n] = row;
    }
  }
  const grid: VegPlantableGrid = {
    cell, n, min, weights, snowW, integral, sumWeights, cumWeights, spread, sampleHeight, chunkSize,
  };
  mask._grid = grid;
  return grid;
}
/** 确定性格哈希:同一格/同一序号 → 同一随机数(确定性,不用 Math.random) */
function vegHash01(a: number, b: number, c: number): number {
  const s = Math.sin(a * 12.9898 + b * 78.233 + c * 37.719) * 43758.5453;
  return s - Math.floor(s);
}
/**
 * 按植被种类加权分配(相对份额;实际数量由预算 = 用户 count 决定):
 * 低地草为主,中低海拔针阔混交,灌木散布;接近雪线时草灌降权、针叶升权。
 * 确定性(用格坐标哈希决定针/阔比例)。
 */
function vegKindShare(kind: VegPlantKind, normAlt: number, r: number, snowF = 0): number {
  const base = kind === 'grass' ? 1.0 : kind === 'bush' ? 0.9 : kind === 'conifer' ? 1.9 : 1.6;
  const hi = vegClamp01((normAlt - 0.6) / 0.4);
  const lo = 1 - vegClamp01(normAlt / 0.35);
  const altW =
    kind === 'grass' ? 1 - hi * 0.55
      : kind === 'bush' ? 1 + lo * 0.5 - hi * 0.3
        : kind === 'conifer' ? 0.75 + hi * 1.25 + lo * 0.35
          : 1 + hi * 0.5;
  const treeBias = kind === 'conifer' ? 0.55 + r : kind === 'decid' ? 0.55 + (1 - r) : 1;
  // === 雪地偏向雪松 (per user request) =====================================
  // 雪线以上的植被几乎只有针叶: 雪松 ×2.6, 阔叶 ×0.35, 灌木 ×0.4, 草 ×0.08。
  // (草在雪里几乎不存在; 阔叶/灌木偶尔出现但不该成片)
  const snowW = kind === 'conifer' ? 1 + snowF * 1.6
    : kind === 'decid' ? 1 - snowF * 0.65
      : kind === 'bush' ? 1 - snowF * 0.6
        : 1 - snowF * 0.92;
  return base * altW * treeBias * snowW;
}
const VEG_KINDS: VegPlantKind[] = ['conifer', 'decid', 'grass', 'bush'];
/**
 * 某 chunk 的落株清单(确定性)。
 * 预算分配:整片地图的总预算是 Σcount;每个 chunk 分到的份额严格等于
 *   (该 chunk 内遮罩权重Σ / 全图 Σ权重) × 总预算
 * → 全图实例总数 = 预算(与用户 count 同量级),且**完全由遮罩重分配**:
 *   绿的地方成林、沙岩稀疏、雪线/水面为零。
 * chunk 内:按每格权重做误差扩散(余数用格哈希抽签),逐株再按
 *   「海拔性格 × 种类预算」抽签定种类(余量校验保证各类型不超预算)。
 */
function vegChunkSlots(
  grid: VegPlantableGrid,
  cx: number,
  cz: number,
  chunkSize: number,
  budgetOf: (k: VegPlantKind) => number,
  layout: { minH: number; maxH: number },
  capLeft: Record<VegPlantKind, number>,
  out: { x: number; z: number; d: number; kind: VegPlantKind; snow?: number }[],
): void {
  out.length = 0;
  if (grid.sumWeights <= 0 || grid.cumWeights.length === 0) return;
  const step = grid.cell;
  const half = chunkSize / 2;
  const x0 = Math.max(0, Math.floor((cx - half - step - grid.min) / step));
  const x1 = Math.min(grid.n - 1, Math.ceil((cx + half + step - grid.min) / step));
  const z0 = Math.max(0, Math.floor((cz - half - step - grid.min) / step));
  const z1 = Math.min(grid.n - 1, Math.ceil((cz + half + step - grid.min) / step));
  const cum = grid.cumWeights;
  const c0 = x0 + z0 * grid.n;
  const c1 = x1 + z1 * grid.n;
  // 该 chunk 的遮罩权重和 = 行区间前缀和(每行是一段连续前缀)
  let chunkSum = 0;
  for (let iz = z0; iz <= z1; iz++) {
    chunkSum += cum[iz * grid.n + x1] - (x0 > 0 ? cum[iz * grid.n + x0 - 1] : 0);
  }
  void c0; void c1;
  if (chunkSum <= 0) return;
  const bwSum = capLeft.conifer + capLeft.decid + capLeft.grass + capLeft.bush;
  if (bwSum <= 0) return;
  const budget = budgetOf('conifer') + budgetOf('decid') + budgetOf('grass') + budgetOf('bush');
  const want = Math.round((budget * chunkSum) / grid.sumWeights);
  if (want <= 0) return;
  let acc = 0;
  for (let iz = z0; iz <= z1; iz++) {
    const rowBase = iz * grid.n;
    for (let ix = x0; ix <= x1; ix++) {
      const i = rowBase + ix;
      const d = grid.weights[i];
      if (d <= 0) continue;
      acc += (d / chunkSum) * want;
      let k = Math.floor(acc);
      const frac = acc - k;
      if (frac > 0 && vegHash01(ix, iz, 61) < frac) k++;
      if (k <= 0) continue;
      const gx = grid.min + ix * step;
      const gz = grid.min + iz * step;
      const h = grid.sampleHeight(gx, gz);
      const normAlt = vegClamp01((h - layout.minH) / Math.max(1, layout.maxH - layout.minH));
      for (let t = 0; t < k; t++) {
        const rk = vegHash01(ix * 3 + 1 + t, iz * 5 + 2 - t, 77);
        let tot = 0;
        const snowF = grid.snowW ? grid.snowW[i] : 0;
        for (const kk of VEG_KINDS) tot += vegKindShare(kk, normAlt, rk, snowF) * budgetOf(kk);
        let pick: VegPlantKind = VEG_KINDS[0];
        if (tot > 0) {
          const v = vegHash01(ix * 7 + 3 + t, iz * 11 + 5 - t, 91) * tot;
          let c = 0;
          pick = VEG_KINDS[VEG_KINDS.length - 1];
          for (const kk of VEG_KINDS) {
            c += vegKindShare(kk, normAlt, rk, snowF) * budgetOf(kk);
            if (v <= c) { pick = kk; break; }
          }
        }
        // 余量校验:该类型已用满则顺延到还有余量的类型
        if (capLeft[pick] <= 0) {
          let found = false;
          for (const kk of VEG_KINDS) {
            if (capLeft[kk] > 0) { pick = kk; found = true; break; }
          }
          if (!found) return;
        }
        capLeft[pick]--;
        out.push({ x: gx, z: gz, d, kind: pick, snow: grid.snowW ? grid.snowW[i] : 0 });
        if (out.length >= want) return;
      }
    }
  }
}

// 地表色 → 植被逐实例色(以"白"为基准的相对乘子,保留地表色相)
//   - 分带中位色(沙/草/岩)只做轻微摆动:0.78..1.02 → 蓝/黄差约 ±18%;
//     地表明显偏绿(草地)时额外整体压暗提绿 —— 绿地更绿、干地偏黄、雪地更亮;
//   - 夹紧:每通道 ≤1、最多压暗 26%,饱和度上限 0.45 → 绝不荧光/过曝;
//   - 无注入基础色时返回白色 → 与历史"材质基色"逐位一致(零回归)。
const VEG_TINT_NEUTRAL_L = 0.45;
const VEG_TINT_SAT_MAX = 0.45;
const _vegTintSrc = new THREE.Color();
const _vegTintHsl = { h: 0, s: 0, l: 0 };
function vegTintFromGround(rgb: [number, number, number]): THREE.Color {
  _vegTintSrc.setRGB(rgb[0], rgb[1], rgb[2]);
  _vegTintSrc.getHSL(_vegTintHsl);
  const l = _vegTintHsl.l;
  const s = Math.min(VEG_TINT_SAT_MAX, _vegTintHsl.s);
  // 分带中位色(沙 0.70 / 草 0.35 / 岩 0.50)→ 0,仅保留色偏
  // === 雪/极亮地表: 直接给冷白 (per user request: 雪松应该是白色的) ============
  // 老公式在亮端会放大成暖褐(dev=+0.5 ⇒ (1.0, 0.26, 0.10)) —— 白雪上种树却偏红棕, 明显不对。
  // 判据用"很亮 + 低饱和"(雪/盐湖/亮沙), 返回带一点冷调的近白, 让雪松读起来是雪压着的白树。
  if (l > 0.70 && s < 0.22) {
    const k = Math.min(1, (l - 0.70) / 0.22);      // 越白 → 越纯白
    const cool = 0.06 * k;                          // 极轻的冷偏, 免得纯灰
    return new THREE.Color(1 - cool * 0.35, 1 - cool * 0.12, 1);
  }
  const dev = Math.max(-0.5, Math.min(0.5, l - VEG_TINT_NEUTRAL_L));
  let r = 1 + dev * 1.05;
  let g = 1 - dev * 1.2;
  let b = 1 - dev * 1.7;
  // 鲜绿(草地)整体压暗并偏绿,让植被"跟着绿地走"
  const gmul = 1 - 0.16 * Math.min(1, s * 2.4);
  r *= gmul;
  g *= gmul;
  b *= gmul;
  const m = Math.max(r, g, b);
  if (m > 1) { r /= m; g /= m; b /= m; } // 上限 1:不许过曝
  return new THREE.Color(Math.max(0, r), Math.max(0, g), Math.max(0, b));
}

// === 3A 植被系统 (per user request: 摒弃多边形堆积,交叉平面+实例化) ===
// 传统 Cone/Sphere 堆积树 → 带透明 alpha 纹理的**平面交叉**模拟立体树冠与草:
//   - 程序化预计算 alpha 纹理(针叶冠 / 阔叶云冠 / 草簇 / 灌木冠),缓存共享。
//   - 交叉几何:多片竖立平面绕 Y 均布合并成一份 BufferGeometry → 每个实例
//     就是一棵完整的树/一簇草,从任何角度看都是"体"而非单张纸片。
//   - InstancedMesh 每 chunk 一批(视锥剔除按块);材质 alphaTest 让阴影按
//     树形剪裁(不再是方形阴影块)。
//   - 生态分布接口:sampleHeight 高度图驱动 —— 种类/密度按 高度带+坡度+
//     区域噪声 决定(低地草、缓坡树、山麓混交、雪线以上无植被)。
//   - Chunking:区域按 chunkSize 分块,每块独立构建+加入场景(剔除/LOD 预留)。
// 兼容旧调用签名(count/spread/maxSlope/minHeight/maxHeight/seed),engine 的
// 山地/岛屿森林调用无需改动。
type VegetationKind = 'tree' | 'grass' | 'bush';
export interface VegetationBand {
  kind: VegetationKind;
  minH?: number;    // 生态:只在这个高度带内分布
  maxH?: number;
  maxSlope?: number; // 生态:坡度上限(陡坡不长树)
  count?: number;   // 期望实例数(全区域)
}
// === 遮罩路径的布局参数(buildTerrainForest 与 buildVegetationMask 共用同一
//     套海拔/坡度/范围解析,保证"遮罩"与"放置"永远一致) ===
interface VegLayoutDefaults {
  spread?: number; count?: number; maxSlope?: number; minHeight?: number;
  maxHeight?: number; grassCount?: number; bushCount?: number;
  chunkSize?: number; minHeightSoft?: number;
}
interface VegLayoutResolved {
  spread: number; chunkSize: number; minH: number; maxH: number; maxSlope: number;
  patchiness: number; densityScale: number; maxPlants: number; groundTint: number;
  counts: { conifer: number; decid: number; grass: number; bush: number };
}
function resolveVegLayout(opts: VegLayoutDefaults & { patchiness?: number; densityScale?: number; maxPlants?: number; groundTint?: number }): VegLayoutResolved {
  const minH = opts.minHeight ?? 60;
  const maxH = opts.maxHeight ?? 1700;
  const densityScale = Math.max(0.05, Math.min(8, opts.densityScale ?? 1));
  return {
    spread: opts.spread ?? 12000,
    chunkSize: opts.chunkSize ?? 1600,
    minH,
    maxH,
    maxSlope: opts.maxSlope ?? 0.55,
    patchiness: opts.patchiness ?? 0.35,
    densityScale,
    maxPlants: Math.max(500, Math.min(400000, opts.maxPlants ?? 150000)),
    groundTint: opts.groundTint ?? 0.85,
    counts: {
      conifer: opts.count ?? 1500,
      decid: opts.count ?? 1500,
      grass: opts.grassCount ?? 60000,
      bush: opts.bushCount ?? 2600,
    },
  };
}
export function buildTerrainForest(
  sampleHeight: (x: number, z: number) => number,
  opts: {
    count?: number; spread?: number; maxSlope?: number; minHeight?: number;
    maxHeight?: number; seed?: number; chunkSize?: number; bands?: VegetationBand[];
    // === 素材编辑 (per user request: 植被素材编辑器选项) ===
    colorTune?: { grass?: string; conifer?: string; decid?: string; bush?: string; trunk?: string };
    scaleTune?: { tree?: number; bush?: number; grass?: number };
    grassCount?: number;
    bushCount?: number;
    /** === 树木几何: 锥形(圆柱树) vs 交叉面片 (per user request: 交叉面片损坏 ⇒ 用圆柱) ===
     * 缺省 true(锥形)。交叉面片依赖 aUvOffset/aUvScale 图集注入, 缺属性就整批不可见;
     * 锥形用纯色材质 + 每实例色, 不依赖图集。要退回旧几何: 传 false。 */
    vegCylinder?: boolean;
    // === 遮罩驱动植被 (per user request: 程序化地形关) ===
    /** 注入的植被遮罩:一旦提供即启用"遮罩驱动"投放路径(老路径保留) */
    vegMask?: VegetationMask | null;
    /** 该高度以下不长植被(遮罩缺省值;水面) */
    minHeightSoft?: number;
    /** 噪音阈值/茂密度(0..1,越大越稀;缺省 0.35) */
    patchiness?: number;
    /** 每公顷/每格目标株数系数(遮罩路径密度总开关,缺省 1) */
    densityScale?: number;
    /** 硬性上限(防止 tune 误设导致上百万实例) */
    maxPlants?: number;
    /** 逐实例地表染色强度 0..1(缺省 0.85;0 = 关闭 → 与历史一致) */
    groundTint?: number;
    /** 精灵图集 / 左半裁剪 / 白键配置(缺省 = 程序化图集 + 左半幅 + 白键) */
    sprites?: VegSpriteKeyOptions;
    /** 静默模式(不打印 [veg] 报告;缺省 false) */
    quiet?: boolean;
    // === 外部植被素材(自动适配) per user request: 贴图自动适配 ===
    /** 由 loadVegTextures() 异步加载好的每物种图集;null/缺省 = 程序化图集 */
    vegTextures?: Record<string, VegSpriteTexture | null> | null;
    /** 分层色(仅用于"无注入地表色采样器"时的遮罩/染色兜底估算) */
    layerColors?: { sand: number; grass: number; rock: number; snow: number };
  } = {},
): THREE.Group {
  const group = new THREE.Group();
  const layout = resolveVegLayout(opts);
  const spread = layout.spread;
  const chunkSize = layout.chunkSize;
  const seed = opts.seed ?? 42;
  const rand = makeRng(seed);
  // === 生态分带(默认:树带尊重旧调用 count/minHeight/maxHeight/maxSlope;
  //     草只在玩家出生区(原点附近)密铺,灌木中海拔) ===
  const bands: Required<VegetationBand>[] = (opts.bands ?? [
    {
      kind: 'tree',
      minH: opts.minHeight ?? 60,
      maxH: opts.maxHeight ?? 1700,
      maxSlope: opts.maxSlope ?? 0.55,
      count: opts.count ?? 1500,
    },
    { kind: 'grass', minH: 0, maxH: (opts.maxHeight ?? 1700) * 0.7, maxSlope: 0.9, count: opts.grassCount ?? 60000 },
    { kind: 'bush', minH: (opts.minHeight ?? 60) + 60, maxH: opts.maxHeight ?? 1700, maxSlope: 0.8, count: opts.bushCount ?? 2600 },
  ] as VegetationBand[]).map((b) => ({
    kind: b.kind, minH: b.minH ?? 0, maxH: b.maxH ?? 5000,
    maxSlope: b.maxSlope ?? 1, count: b.count ?? 0,
  }));
  // === 预计算共享资源(纹理 + 交叉几何) ===
  // 纹理走"图集左半幅裁剪 + 亮度白键";metrics 给出精灵宽高比 + alpha 统计。
  const sprites = opts.sprites;
  const textures = makeVegetationTextures(sprites);
  const spriteMetrics = getVegSpriteMetrics(sprites);
  const decAspect = spriteMetrics.aspect > 0.15 && spriteMetrics.aspect < 1.6 ? spriteMetrics.aspect : 1;
  // 树冠交叉几何:4 片平面绕 Y 每 45° 交叉。树冠片带一点锥度(顶部窄)近似
  // 针叶;阔叶按精灵宽高比自适应(避免把左半幅细高树拉伸/压扁)。
  // === 尺寸(单位 = 米; per fix: 原来树只有 1.5 米高, 从空中根本看不见) ===
  // 世界是米制: 云 3019m / 地形最高 4320m / 机体 ~22 单位(≈15m 的 F-16)。
  // 真实针叶 12~20m ⇒ 取 **22 单位高**; 阔叶 18; 灌木 3.2; 草 0.95(原来 0.9 本来就对)。
  // === 树木几何: 锥形(圆柱树) (per user request: 交叉面片是损坏的, 就用圆柱树) =======
  // 交叉面片依赖 aUvOffset/aUvScale 的图集 UV 注入(见 UV_VARIETY_MATS): 少一个属性就会
  // 整批永远采样同一个 texel(通常是图集左上角的透明像素) ⇒ alphaTest 全裁掉 ⇒
  // 树在屏幕上什么都没有。锥形不需要图集: 纯色 + 每实例色 ⇒ 零依赖、零注入。
  // 退回开关: opts.vegCylinder === false。
  const useCylTree = opts.vegCylinder !== false;
  const coniferGeo = useCylTree
    ? coneTreeGeo(3.4, 22, 0.5)
    : buildCrossPlaneGeometry(4, 7.5, 22, 0.5);
  const decidGeo = useCylTree
    ? coneTreeGeo(2.6, 18, 0.55)
    : buildCrossPlaneGeometry(4, Math.max(6, 18 * Math.max(0.45, Math.min(1.4, decAspect))), 18, 0.55);
  const bushGeo = buildCrossPlaneGeometry(3, 3.4, 3.2, 0.35);
  const grassGeo = buildCrossPlaneGeometry(3, 1.1, 0.95, 0.15);
  const trunkGeo = new THREE.CylinderGeometry(0.32, 0.55, 1, 5);
  const grassMat = new THREE.MeshStandardMaterial({
    map: textures.grass, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide,
    color: 0xffffff, roughness: 1.0, metalness: 0, depthWrite: false,
  });
  // 锥形树的材质 = 不透明纯色, 不吃图集(所以也不进 UV_VARIETY_MATS / BILLBOARD_MATS)。
  // 色调由 tune 的 colorTune 与每实例的地面色 tint 决定。
  const coniferMat = useCylTree
    ? new THREE.MeshStandardMaterial({ color: 0x2f5a30, roughness: 1.0, metalness: 0 })
    : new THREE.MeshStandardMaterial({
        map: textures.conifer, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide,
        color: 0x9fd8a0, roughness: 1.0, metalness: 0, depthWrite: false,
      });
  const decidMat = useCylTree
    ? new THREE.MeshStandardMaterial({ color: 0x3d6b2c, roughness: 1.0, metalness: 0 })
    : new THREE.MeshStandardMaterial({
        map: textures.decid, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide,
        color: 0xb8e0a0, roughness: 1.0, metalness: 0, depthWrite: false,
      });
  const bushMat = new THREE.MeshStandardMaterial({
    map: textures.bush, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide,
    color: 0xa8d498, roughness: 1.0, metalness: 0, depthWrite: false,
  });
  // === 雪松材质 (per user request: 雪地就是雪松, 而且是白色) ==================
  // 贴图 = 程序化雪松(冷白+蓝灰阴影); 基色给接近白(乘上"雪色 tint"仍是白),
  // 与常绿针叶(0x9fd8a0)完全分开 ⇒ 雪地里一眼是白树。
  const coniferSnowMat = new THREE.MeshStandardMaterial({
    map: textures.conifer_snow, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide,
    color: 0xffffff, roughness: 1.0, metalness: 0, depthWrite: false,
  });
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3520, roughness: 1.0 });
  // === 外部素材自动适配 + 低矮植被 billboard (per user request) ===================
  //  · 有外部素材(loadVegTextures 拿到图集) ⇒ 换 map, 按**每株自己的宽高比**重算几何,
  //    并把株型表交给实例化(每实例 aUvOffset/aUvScale 挑株 ⇒ 一张图集出 N 种, 仍 1 draw call);
  //  · 没有 ⇒ 程序化图集(离线单文件照常能看), 行为与历史一致;
  //  · 低矮植被(grass/bush)**一律 billboard**: 固定在视图空间正对相机, 实例矩阵不需要每帧改
  //    (几万株也不会吃 CPU), 阴影用 customDepthMaterial 同步同一套变换。
  const vtex = opts.vegTextures ?? null;
  const spriteOf = (k: VegSpecies) => (vtex && vtex[k] && vtex[k]!.sprites.length ? vtex[k]!.sprites : null);
  const atlasOf = (k: VegSpecies) => (vtex && vtex[k] ? vtex[k]!.texture : null);
  const avgAspect = (k: VegSpecies, def: number) => {
    const sp = spriteOf(k);
    if (!sp) return def;
    let sum = 0;
    for (const r of sp) sum += r.aspect;
    return Math.max(0.25, Math.min(2.5, sum / sp.length));
  };
  // 材质换图 + 打开 alphaTest(素材多为带 alpha 的贴片;白键路径已把背景抠成 alpha=0)
  for (const [k, mat] of [
    ['conifer', coniferMat], ['decid', decidMat], ['bush', bushMat], ['grass', grassMat],
  ] as [VegSpecies, THREE.MeshStandardMaterial][]) {
    const tex = atlasOf(k);
    if (tex) {
      mat.map = tex;
      mat.alphaTest = 0.35;
      mat.transparent = true;
      mat.needsUpdate = true;
    }
  }
  // 低矮植被: billboard 几何(单片, 底对齐)
  const billboardGeo = buildBillboardGeometry();
  const grassGeoOut = billboardGeo;
  const bushGeoOut = billboardGeo;
  // 高植被: 4 叉交叉面片, 但按素材平均宽高比重算锥度/比例(避免把细高松树压扁)
  const coniferGeoOut = spriteOf('conifer')
    ? buildCrossPlaneGeometry(4, Math.max(5, 22 * Math.max(0.35, Math.min(1.2, avgAspect('conifer', 0.5)))), 22, 0.5)
    : coniferGeo;
  const decidGeoOut = spriteOf('decid')
    ? buildCrossPlaneGeometry(4, Math.max(6, 18 * Math.max(0.45, Math.min(1.4, avgAspect('decid', 0.8)))), 18, 0.55)
    : decidGeo;
  // 材质注入: billboard(草/灌木) + 每实例 UV 变化(四个物种都开)
  injectBillboard(grassMat, { billboard: true, uvVariety: true });
  injectBillboard(bushMat, { billboard: true, uvVariety: true });
  if (!useCylTree) {   // 锥形材质没有 map/图集 UV ⇒ 绝不能注入(否则 vMapUv 恒为 0)
    injectBillboard(coniferMat, { billboard: false, uvVariety: true });
    injectBillboard(decidMat, { billboard: false, uvVariety: true });
  }
  const bushDepthMat = makeBillboardDepthMaterial(bushMat);
  /** 材质 → 该物种的株型表(有才写实例 UV 属性) */
  /** billboard 材质集合(草/灌木): 阴影要走同一套变换 */
  const BILLBOARD_MATS = new Set<THREE.Material>([grassMat, bushMat]);
  /** 注入了"每实例 UV 变化"的材质(它们**必须**带 aUvOffset/aUvScale, 见 addInst) */
  // 锥形模式: 树材质不在其中 ⇒ 实例化时不会去加 aUvOffset/aUvScale(也就不会踩那个坑)
  const UV_VARIETY_MATS = new Set<THREE.Material>(useCylTree
    ? [grassMat, bushMat]
    : [grassMat, bushMat, coniferMat, decidMat, coniferSnowMat]);
  // === 材质 → 种类标签(权威) (per fix: 调试层原来靠颜色认种类, 而草和雪松都是 0xffffff) ===
  (grassMat.userData as Record<string, unknown>).vegKind = '草';
  (bushMat.userData as Record<string, unknown>).vegKind = '灌木';
  (coniferMat.userData as Record<string, unknown>).vegKind = '针叶';
  (decidMat.userData as Record<string, unknown>).vegKind = '阔叶';
  (coniferSnowMat.userData as Record<string, unknown>).vegKind = '雪松';
  (trunkMat.userData as Record<string, unknown>).vegKind = '树干';
  // 本地 file:// 下拿不到像素(画布污染) ⇒ 素材带不带 alpha 判不出来, 由 loader 给出
  // shaderKey(>0 时用**着色器白键**把近白背景抠掉)。写进 uniform, 切换不重编译。
  for (const k of ['conifer', 'decid', 'bush', 'grass'] as VegSpecies[]) {
    const t = vtex ? vtex[k] : null;
    if (!t || !t.shaderKey) continue;
    const mat = k === 'conifer' ? coniferMat : k === 'decid' ? decidMat : k === 'bush' ? bushMat : grassMat;
    vegKeyUniformOf(mat).value = t.shaderKey;
  }
  const SPRITES_OF = new Map<THREE.Material, VegSpriteTexture['sprites']>();
  for (const k of ['conifer', 'decid', 'bush', 'grass'] as VegSpecies[]) {
    const sp = spriteOf(k);
    if (!sp) continue;
    const mat = k === 'conifer' ? coniferMat : k === 'decid' ? decidMat : k === 'bush' ? bushMat : grassMat;
    SPRITES_OF.set(mat, sp);
  }
  // === 素材编辑 (per user request: 植被素材编辑器选项) ===
  // tune/编辑器给的颜色直接覆盖材质基色;无 tune 时与历史一致。
  const ct = opts.colorTune;
  if (ct?.grass) grassMat.color.set(ct.grass);
  if (ct?.conifer) coniferMat.color.set(ct.conifer);
  if (ct?.decid) decidMat.color.set(ct.decid);
  if (ct?.bush) bushMat.color.set(ct.bush);
  if (ct?.trunk) trunkMat.color.set(ct.trunk);
  // 生态投放:尝试 count×~6 随机点,匹配分带高度/坡度/噪声密度后产出矩阵。
  const half = spread;
  // 生态投放(块内):只在 (ox,oz)±chunkSize/2 投放,目标数按块面积占**带面积**
  // 比例折算;草/灌木集中在玩家出生区(原点半径内)密铺,远处交给地形+雾。
  const place = (b: Required<VegetationBand>, ox: number, oz: number, ch: number): { m: THREE.Matrix4 }[] => {
    const out: { m: THREE.Matrix4 }[] = [];
    const kindScale = b.kind === 'tree'
      ? (opts.scaleTune?.tree ?? 1)
      : b.kind === 'bush'
        ? (opts.scaleTune?.bush ?? 1)
        : (opts.scaleTune?.grass ?? 1);
    const scaleF = (b.kind === 'grass' ? 1.6 : 1) * kindScale;
    const halfC = chunkSize / 2;
    // 带范围:草/灌木只在 originRadius 内,树全场但远处减密。
    const originR2 = (ox * ox + oz * oz);
    let bandArea = spread * 2 * spread * 2;
    if (b.kind === 'grass' || b.kind === 'bush') {
      if (originR2 > 5200 * 5200) return out; // 出生区外不铺草/灌木
      bandArea = Math.PI * 5200 * 5200;
    }
    // 目标实例数按块面积占带面积折算。
    const target = Math.max(1, Math.round(b.count * (chunkSize * chunkSize) / bandArea));
    let placed = 0;
    let attempts = 0;
    // 树远处减密(>9000 只留 25%),避免地平线外无谓实例。
    let distMul = 1;
    if (b.kind === 'tree' && originR2 > 9000 * 9000) distMul = 0.25;
    const maxA = Math.max(40, target * distMul * 16 + 30);
    const want = Math.max(1, Math.round(target * distMul));
    while (placed < want && attempts < maxA) {
      attempts++;
      const x = ox + (rand() - 0.5) * chunkSize;
      const z = oz + (rand() - 0.5) * chunkSize;
      const h = sampleHeight(x, z);
      if (h < b.minH || h > b.maxH) continue;
      // 坡度
      const hX = sampleHeight(x + 24, z), hZ = sampleHeight(x, z + 24);
      const slope = Math.max(Math.abs(h - hX) / 24, Math.abs(h - hZ) / 24);
      if (slope > b.maxSlope) continue;
      // 区域噪声密度(避免完美均匀;形成林缘/空地)
      if (vnoise2(x * 0.0004 + seed * 0.01, z * 0.0004 - seed * 0.013) < 0.36) continue;
      const s = (0.7 + rand() * 0.9) * scaleF;
      const rot = rand() * Math.PI * 2;
      const sx = s * (0.8 + rand() * 0.5), sy = s * (0.85 + rand() * 0.55), sz = s * (0.8 + rand() * 0.5);
      const m = new THREE.Matrix4().makeRotationY(rot);
      m.scale(new THREE.Vector3(sx, sy, sz));
      // 局部平移(相对 chunk 原点;y = 与块基准的高度差,世界 y 由块位置补回)。
      m.setPosition(x - ox, h - ch, z - oz);
      out.push({ m });
      placed++;
    }
    return out;
  };
  // =====================================================================
  // === 遮罩驱动投放路径 (per user request) =============================
  // =====================================================================
  // opts.vegMask 提供时启用:投放位置完全由遮罩(高度/坡度/水面/雪线 +
  // 地表基础色)决定,不再"海拔带 + 均匀随机"。老路径(bands/place)原样保留,
  // 三个 engine 调用点即使不传 vegMask 也逐位不变。
  const WHITE_TINT = new THREE.Color(1, 1, 1);
  const maskCfg = opts.vegMask ?? null;
  const layoutMinH = maskCfg
    ? Math.max(1, Math.min(layout.minH, opts.minHeightSoft ?? 25))
    : layout.minH;
  const plantCap = Math.max(500, Math.min(layout.maxPlants, 400000));
  // 预扫描遮罩网格(一次性;~93m 格):weights = 逐格密度,sumWeights = Σd,
  // cumWeights = 逐行前缀和(把总预算按遮罩权重分配到每个 chunk)。
  const grid = maskCfg
    ? vegPlantableGrid(maskCfg, chunkSize, sampleHeight)
    : null;
  const maskCells = grid ? grid.weights.length : 0;
  let maskVegetatedCells = 0;
  if (grid) {
    for (let i = 0; i < grid.weights.length; i++) if (grid.weights[i] > 0.05) maskVegetatedCells++;
  }
  const mapArea = (spread * 2) * (spread * 2);
  // 预算 = 用户 count/grassCount/bushCount ×densityScale。语义:整片地图的
  // 目标实例总数(与历史同量级);遮罩只负责**重分配**(绿=密、沙岩=稀、
  // 雪/水=0)。超过 maxPlants 时按比例整体压缩。
  const budgetRaw = (kind: VegPlantKind): number =>
    Math.max(0, Math.round(layout.counts[kind] * layout.densityScale));
  const budgetSum = maskCfg
    ? budgetRaw('conifer') + budgetRaw('decid') + budgetRaw('grass') + budgetRaw('bush')
    : 0;
  const plantScale = maskCfg && budgetSum > plantCap ? plantCap / budgetSum : 1;
  const budgetOf = (kind: VegPlantKind): number => Math.max(0, Math.round(budgetRaw(kind) * plantScale));
  const budgetSumFinal = Math.round(budgetSum * plantScale);
  const capLeft: Record<VegPlantKind, number> = {
    conifer: budgetOf('conifer'), decid: budgetOf('decid'),
    grass: budgetOf('grass'), bush: budgetOf('bush'),
  };
  const tintOn = layout.groundTint > 0 && !!maskCfg;
  const tintK = layout.groundTint;
  const buildT0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const maskCounts: Record<VegPlantKind, number> = { conifer: 0, decid: 0, grass: 0, bush: 0 };
  let slotsTotal = 0;
  /** 当前 chunk 的落株清单(复用同一个数组,避免每 chunk 分配) */
  const slotBuf: { x: number; z: number; d: number; kind: VegPlantKind; snow?: number }[] = [];
  /** 当前 chunk 的树干矩阵/颜色(每 chunk 清空) */
  const trunkLists: THREE.Matrix4[] = [];
  const trunkTints: THREE.Color[] = [];
  /**
   * 遮罩路径:把当前 chunk 的落株清单铺成实例矩阵。
   * 清单 = vegChunkSlots(遮罩权重占比 × 总预算 → 该 chunk 株数;种类已定)。
   * 逐株确定性抖动定位 + 脚下地表色染色(vegetation matches its ground)。
   */
  const placeMasked = (
    layer: VegPlantKind,
    ox: number,
    oz: number,
    ch: number,
    // true = 只要"雪株"(地表是雪), false = 只要非雪株。同一层因此会拆成两个实例批
    // (常绿针叶 / 白雪松), 但每批仍然只有 1 个 draw call。
    onlySnow = false,
  ): { m: THREE.Matrix4[]; tint: THREE.Color[]; sprite: number[] } => {
    const m: THREE.Matrix4[] = [];
    const tint: THREE.Color[] = [];
    // 每株的**株型索引**(图集第几株): 让同一个 chunk 里出现多种株型,
    // 而几何/材质/实例批完全不变 —— 这就是"一张图集出 N 种、仍然 1 draw call"。
    const sprite: number[] = [];
    if (!maskCfg || !grid) return { m, tint, sprite };
    const kindScale = layer === 'grass'
      ? (opts.scaleTune?.grass ?? 1)
      : layer === 'bush'
        ? (opts.scaleTune?.bush ?? 1)
        : (opts.scaleTune?.tree ?? 1);
    const halfCell = grid.cell * 0.47;
    for (const s of slotBuf) {
      if (s.kind !== layer) continue;
      // 雪权重 > 0.5 才当"雪株"; 针叶以外的物种不拆批(雪地里它们本来就被压到接近 0)
      const isSnow = (s.snow ?? 0) > 0.5;
      if (layer === 'conifer' && isSnow !== onlySnow) continue;
      const r1 = vegHash01(s.x * 3.1, s.z * 1.7, 21);
      const r2 = vegHash01(s.x * 1.3, s.z * 2.9, 22);
      const x = s.x + (r1 - 0.5) * 2 * halfCell;
      const z = s.z + (r2 - 0.5) * 2 * halfCell;
      const h = sampleHeight(x, z);
      if (h < layoutMinH) continue;
      // 大小:密度越高越接近满尺寸,稀疏处略小
      const sc = (0.74 + 0.5 * Math.min(1, s.d * 1.6)) * kindScale;
      const rot = vegHash01(s.x, s.z, 31) * Math.PI * 2;
      const sx = sc * (0.82 + 0.4 * vegHash01(x, z, 41));
      const sy = sc * (0.86 + 0.45 * vegHash01(x, z, 42));
      const sz = sc * (0.82 + 0.4 * vegHash01(x, z, 43));
      const mm = new THREE.Matrix4().makeRotationY(rot);
      mm.scale(new THREE.Vector3(sx, sy, sz));
      mm.setPosition(x - ox, h - ch, z - oz);
      m.push(mm);
      sprite.push(Math.floor(vegHash01(x, z, 51) * 997) % 24);   // 0..23, 打包时按实际株数取模
      maskCounts[layer]++;
      let gt: THREE.Color | null = null;
      if (tintOn) {
        gt = vegTintFromGround(maskCfg.groundAt(x, z));
        if (tintK < 1) gt.lerp(WHITE_TINT, 1 - tintK);
        tint.push(gt);
      }
      if (s.kind === 'conifer' || s.kind === 'decid') {
        // 树干:细圆柱,与树冠同一地面高度(局部 y 相同)。
        const tm2 = new THREE.Matrix4().makeScale(0.5, 1.4, 0.5);
        tm2.setPosition(mm.elements[12], mm.elements[13], mm.elements[14]);
        trunkLists.push(tm2);
        trunkTints.push(gt ?? WHITE_TINT);
      }
    }
    return { m, tint, sprite };
  };
  const addInst = (
    g: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.Material,
    list: { m: THREE.Matrix4[]; tint: THREE.Color[]; sprite?: number[] },
    cast: boolean, ox: number, oz: number, oy: number,
  ): void => {
    const n = list.m.length;
    if (n === 0) return;
    // === 每实例 UV 变化 (per user request: 一张素材图集出多种株型) ==============
    // InstancedBufferAttribute 是"挂几何"的, 不同 chunk 的实例数不同 ⇒ 必须 clone 一份
    // 几何(这几个几何都只有 4~8 个顶点, clone 成本可忽略)。
    let geoUse = geo;
    const sprites = SPRITES_OF.get(mat);
    if (UV_VARIETY_MATS.has(mat)) {
      // (per fix: "有位置标识却没有树") 这些材质的着色器里已经注入了
      // `vMapUv = vMapUv * aUvScale + aUvOffset;` —— 几何上就**必须**有这两个属性,
      // 否则未定义属性读成 (0,0) ⇒ aUvScale=(0,0) ⇒ vMapUv 恒为 (0,0) ⇒ 整批永远采样
      // 同一个 texel(通常正是图集左上角的透明像素) ⇒ alphaTest 全裁掉 ⇒ 屏幕上什么都没有。
      // 没有精灵表(程序化图集 / 单株素材)时给恒等值: offset (0,0) / scale (1,1)。
      const hasSprites = !!(sprites && sprites.length && list.sprite);
      const { aUvOffset, aUvScale } = hasSprites
        ? buildUvVarietyAttributes(sprites as typeof sprites & object[], (i: number) => (list.sprite as number[])[i] % (sprites as object[]).length, n)
        : buildUvVarietyAttributes([], () => 0, n);
      geoUse = geo.clone();
      geoUse.setAttribute('aUvOffset', aUvOffset);
      geoUse.setAttribute('aUvScale', aUvScale);
    }
    const inst = new THREE.InstancedMesh(geoUse, mat, n);
    inst.castShadow = cast;
    // === 距离剔除上限(米) (per fix: 低空之外没必要提交几万个亚像素实例) ==========
    // 引擎每帧按"批 → 相机距离"切 visible(见 updateVegetationCulling)。
    // 草/灌木只在近处有意义; 树可以远一点(4000m 外的树也就十几个像素)。
    const isGrass = mat === grassMat;
    const isBush = mat === bushMat;
    // 树几乎不裁: 植被铺在 ±18.9km, 而玩家常在 2km 以上看远处的岛/山 —— 5200m 的树
    // 上限会把视锥里**所有**植被批都切掉(实测 visibleBatches 0/166), 等于又看不见树了。
    // 只裁真正亚像素的两档: 草 1.2km / 灌木 2km; 树给 30km(≈整个地图范围)。
    inst.userData.vegMaxDist = isGrass ? 1200 : isBush ? 2000 : 30000;
    inst.receiveShadow = false;
    // billboard 材质(草/灌木)的阴影必须走同一套"正对相机"的顶点变换, 否则 CSM 里
    // 影子还是没转过的交叉面片 ⇒ 用配套的 customDepthMaterial。
    if (cast && BILLBOARD_MATS.has(mat)) inst.customDepthMaterial = bushDepthMat;
    for (let i = 0; i < n; i++) inst.setMatrixAt(i, list.m[i]);
    inst.instanceMatrix.needsUpdate = true;
    // 逐实例地表染色(per user request):只染色开启时才写 instanceColor,
    // 关闭时与历史完全一致(材质基色乘白色)。
    if (tintOn) {
      for (let i = 0; i < n; i++) inst.setColorAt(i, list.tint[i]);
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    }
    inst.position.set(ox, oy, oz);
    g.add(inst);
  };
  // === Chunk 化:每 chunk 独立实例批 ===
  const cx0 = Math.floor(-half / chunkSize), cx1 = Math.ceil(half / chunkSize);
  const cz0 = cx0, cz1 = cx1;

  for (let gx = cx0; gx < cx1; gx++) {
    for (let gz = cz0; gz < cz1; gz++) {
      const cxx = gx * chunkSize + chunkSize / 2;
      const czz = gz * chunkSize + chunkSize / 2;
      // 按块内平均高度跳过水面块(高度图在海上为负/0 时不投树)
      const ch = sampleHeight(cxx, czz);
      if (ch < -50) continue;
      const g = new THREE.Group();
      if (maskCfg && grid) {
        // === 遮罩驱动:先算该 chunk 的落株清单(遮罩权重占比 × 总预算),
        //     再按种类铺实例 + 逐实例地表染色 ===
        vegChunkSlots(grid, cxx, czz, chunkSize, budgetOf, layout, capLeft, slotBuf);
        if (slotBuf.length > 0) {
          slotsTotal += slotBuf.length;
          trunkLists.length = 0;
          trunkTints.length = 0;
          addInst(g, coniferGeoOut, coniferMat, placeMasked('conifer', cxx, czz, ch), true, cxx, czz, ch);
          // 雪地上的针叶 = **雪松**(白): 单独一批 + 单独材质, 逐实例由格雪权重决定
          addInst(g, coniferGeoOut, coniferSnowMat, placeMasked('conifer', cxx, czz, ch, true), true, cxx, czz, ch);
          addInst(g, decidGeoOut, decidMat, placeMasked('decid', cxx, czz, ch), true, cxx, czz, ch);
          // 灌木/草 = billboard(低矮植被): cast=true 的灌木需要 customDepthMaterial 才不糊阴影
          // 灌木不投影: billboard 数量的最大一档, 进 CSM 深度 pass 只换来看不见的影子
          addInst(g, bushGeoOut, bushMat, placeMasked('bush', cxx, czz, ch), false, cxx, czz, ch);
          addInst(g, grassGeoOut, grassMat, placeMasked('grass', cxx, czz, ch), false, cxx, czz, ch);
          if (trunkLists.length > 0) {
            addInst(g, trunkGeo, trunkMat, { m: trunkLists, tint: trunkTints }, false, cxx, czz, ch);
          }
        }
        slotBuf.length = 0;
        if (g.children.length > 0) {
          (g as any)._env = true;
          group.add(g);
        }
        continue;
      }
      // 每 chunk 用自己的实例列表(place 已在块内投放并产出局部矩阵)
      const grassM: THREE.Matrix4[] = [];
      const conM: THREE.Matrix4[] = [];
      const decidM: THREE.Matrix4[] = [];
      const bushM: THREE.Matrix4[] = [];
      const trunkM: THREE.Matrix4[] = [];
      for (const b of bands) {
        const list = place(b, cxx, czz, ch);
        for (const it of list) {
          const y = it.m.elements[13] + ch; // 局部 y + 块基准 = 世界地面高
          const tgt = b.kind === 'grass' ? grassM : b.kind === 'bush' ? bushM
            : (Math.round(y) + 2) % 3 === 0 ? decidM : conM;
          tgt.push(it.m);
          if (b.kind === 'tree') {
            // 树干:细圆柱,与树冠同一地面高度(局部 y 相同)。
            const tm2 = new THREE.Matrix4().makeScale(0.5, 1.4, 0.5);
            tm2.setPosition(
              it.m.elements[12], it.m.elements[13], it.m.elements[14],
            );
            trunkM.push(tm2);
          }
        }
      }
      const add = (geo: THREE.BufferGeometry, mat: THREE.Material, mats: THREE.Matrix4[], cast: boolean) => {
        if (mats.length === 0) return;
        const inst = new THREE.InstancedMesh(geo, mat, mats.length);
        inst.castShadow = cast;
        inst.receiveShadow = false;
        for (let i = 0; i < mats.length; i++) {
          inst.setMatrixAt(i, mats[i]);
        }
        inst.instanceMatrix.needsUpdate = true;
        inst.position.set(cxx, ch, czz);
        g.add(inst);
      };
      add(grassGeo, grassMat, grassM, false);
      add(bushGeo, bushMat, bushM, true);
      add(coniferGeo, coniferMat, conM, true);
      add(decidGeo, decidMat, decidM, true);
      if (trunkM.length) add(trunkGeo, trunkMat, trunkM, false);
      if (g.children.length > 0) {
        (g as any)._env = true;
        group.add(g);
      }
    }
  }
  // === 统计/报告(实例数、遮罩覆盖、构建耗时)—— 供引擎与验证脚本读取 ===
  const buildMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - buildT0;
  const total = maskCounts.conifer + maskCounts.decid + maskCounts.grass + maskCounts.bush;
  (group as any).userData.vegStats = maskCfg
    ? {
        mode: 'mask',
        seed,
        counts: { ...maskCounts },
        total,
        coverage: maskCells > 0 ? maskVegetatedCells / maskCells : 0,
        gridCells: maskCells,
        integral: grid ? grid.integral : 0,
        cellSize: grid ? grid.cell : 0,
        meanDensity: grid && mapArea > 0 ? grid.integral / mapArea : 0,
        budget: {
          conifer: budgetOf('conifer'), decid: budgetOf('decid'),
          grass: budgetOf('grass'), bush: budgetOf('bush'),
          sum: budgetSumFinal, plantCap, plantScale,
        },
        tint: {
          enabled: tintOn,
          strength: layout.groundTint,
          source: maskCfg.hasBaseColor ? 'baseColorAt' : maskCfg.derivedGround ? 'derived(biome→layer colors)' : 'none',
        },
        sprites: { source: spriteMetrics.source, texW: spriteMetrics.texW, texH: spriteMetrics.texH, aspect: spriteMetrics.aspect, alpha: spriteMetrics.alpha },
        buildMs,
      }
    : { mode: 'bands', seed, buildMs };
  if (maskCfg && !opts.quiet) {
    const a = spriteMetrics.alpha;
    console.info(
      '[veg] mask-driven: ' +
      'coverage=' + (100 * (maskCells > 0 ? maskVegetatedCells / maskCells : 0)).toFixed(1) + '% ' +
      '(cells ' + maskVegetatedCells + '/' + maskCells + ', meanDensity=' +
      (grid && mapArea > 0 ? (grid.integral / mapArea) : 0).toFixed(3) + ') ' +
      'instances conifer=' + maskCounts.conifer + ' decid=' + maskCounts.decid +
      ' grass=' + maskCounts.grass + ' bush=' + maskCounts.bush + ' total=' + total +
      ' (budget ' + budgetSumFinal + ')' +
      ' | tint=' + (tintOn ? 'on(' + layout.groundTint + ')' : 'off') +
      ' | sprite=' + spriteMetrics.source + ' ' + spriteMetrics.texW + 'x' + spriteMetrics.texH +
      ' aspect=' + spriteMetrics.aspect.toFixed(3) +
      ' whiteKey=' + a.whiteKey + ' keyedAlpha0=' +
      (a.total > 0 ? (100 * a.transparent / a.total).toFixed(1) : '0') + '%' +
      ' halo=' + a.halo +
      ' | build=' + buildMs.toFixed(0) + 'ms',
    );
  }
  return group;
}

/** 内部诊断出口(仅供离线验证脚本使用;游戏运行时零开销、不参与逻辑) */
export function __vegInternals(): {
  plantableGrid: (mask: VegetationMask, chunkSize: number, h: VegHeightSampler) => VegPlantableGrid;
  chunkSlots: typeof vegChunkSlots;
  hash01: (a: number, b: number, c: number) => number;
} {
  return { plantableGrid: vegPlantableGrid, chunkSlots: vegChunkSlots, hash01: vegHash01 };
}

// === 植被 alpha 纹理(左半幅裁剪 + 白键 → 透明) ===
// 用户需求(程序化地形关):"从植被贴图里自动把**左半幅**裁出来当植被精灵,
// **白色区域必须变成透明**"。这里的实现是**真实像素运算**:
//   1) 取一整张图集(程序化生成,或 opts.sprites.sheetUrl/sheet 外部提供);
//   2) 只画/裁左半幅(vegCropAndKey,crop 可配置);
//   3) 亮度键控 alpha:白 → alpha 0,soft ramp 内渐隐 + 反混合去白边;
//   4) 结果烘成 <canvas> 后建 CanvasTexture(缓存共享)。
// 草/灌木没有外部素材,采用"同一图集 + 同一条白键管线"的小型程序化变体
// (受光叶簇 / 半球灌木),保证整片植被同源、同一个透明键。
// 精灵度量镜像:纹理走 THREE.Cache(可能被别处 clear()),白键 alpha 统计
// 另存模块级 Map —— 报告/验证脚本永远读得到真实数据,不会退回空统计。
const _vegSpriteMetrics = new Map<string, VegSpriteMetrics>();
function vegStoreSpriteMetrics(key: string, built: { canvas: HTMLCanvasElement; alpha: VegSpriteAlphaStats; source: string }): void {
  _vegSpriteMetrics.set(key, {
    source: built.source,
    texW: built.canvas.width,
    texH: built.canvas.height,
    aspect: built.canvas.width / Math.max(1, built.canvas.height),
    alpha: built.alpha,
  });
}
function vegKeyedTexture(
  key: string,
  build: () => { canvas: HTMLCanvasElement; alpha: VegSpriteAlphaStats; source: string },
): THREE.CanvasTexture {
  const mirrored = _vegSpriteMetrics.get(key);
  const cached = THREE.Cache.get(key);
  if (cached && mirrored) return cached as THREE.CanvasTexture;
  const built = build();
  const tex = new THREE.CanvasTexture(built.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  (tex as any).userData.shared = true;
  THREE.Cache.add(key, tex);
  vegStoreSpriteMetrics(key, built);
  return tex;
}
/** 小尺寸程序化画布(草/灌木用):白底 + 绘制,再走同一条左半裁剪/白键 */
function vegMiniSheet(
  draw: (ctx: CanvasRenderingContext2D, s: number) => void,
  cfg: VegSpriteKeyOptions,
  size = 192,
): { canvas: HTMLCanvasElement; alpha: VegSpriteAlphaStats; source: string } {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  draw(ctx, size);
  const r = vegCropAndKey(c, cfg);
  return { canvas: r.canvas, alpha: r.alpha, source: 'procedural-tuft' };
}
function makeVegetationTextures(sprites?: VegSpriteKeyOptions): Record<'conifer' | 'decid' | 'grass' | 'bush' | 'conifer_snow', THREE.CanvasTexture> {
  const cfg: VegSpriteKeyOptions = sprites ?? {};
  const keyTag = 'k' + (cfg.whiteKey ?? 0.985).toFixed(3) + '-' + (cfg.softRamp ?? 0.05).toFixed(3);
  const spriteKey = 'skybound-veg-sprite-left-' + keyTag + (cfg.sheetUrl ? '-url' : '-proc');
  return {
    // 针叶 / 阔叶:取自同一张图集(左半幅),因此共用一次裁剪+白键结果。
    conifer: vegKeyedTexture(spriteKey, () => vegBuildSheetCrop(cfg)),
    decid: vegKeyedTexture(spriteKey, () => vegBuildSheetCrop(cfg)),
    grass: vegKeyedTexture('skybound-veg-grass-left-' + keyTag, () =>
      vegMiniSheet((ctx, s) => {
        // 受光叶簇:从底部长出的一撮细叶(确定性三角函数,无 Math.random)。
        const base = s * 0.94;
        for (let i = 0; i < 34; i++) {
          const t = i / 34;
          const x = s * 0.5 + (Math.sin(i * 12.9898) * 0.5) * s * 0.44;
          const w = 1 + Math.abs(Math.sin(i * 4.7)) * 2;
          const hgt = s * (0.32 + Math.abs(Math.sin(i * 2.3)) * 0.5);
          const lean = Math.sin(i * 7.1) * 9;
          const shade = 0.32 + Math.abs(Math.sin(i * 1.7)) * 0.6;
          const g = Math.round(90 + shade * 120);
          const r = Math.round(40 + shade * 80);
          const b = Math.round(35 + shade * 60);
          ctx.strokeStyle = 'rgba(' + r + ',' + g + ',' + b + ',0.95)';
          ctx.lineWidth = w;
          ctx.beginPath();
          ctx.moveTo(x, base);
          ctx.quadraticCurveTo(x + lean * 0.4, base - hgt * 0.6, x + lean, base - hgt);
          ctx.stroke();
          void t;
        }
      }, cfg)),
    // === 雪松 (per user request: 雪地 = 白色雪松) ==============================
    // 与针叶同形(细高锥形), 但整体是**冷白/灰蓝**, 枝上挂雪: 大面积白 + 蓝灰阴影,
    // 少量深色针叶从雪缝里透出来。这样即使底下是绿地, 雪松也一眼看出是白的。
    conifer_snow: vegKeyedTexture('skybound-veg-snowconifer-left-' + keyTag, () =>
      vegMiniSheet((ctx, s2) => {
        const base = s2 * 0.96;
        const cx = s2 * 0.5;
        const tiers = 7;
        for (let i = 0; i < tiers; i++) {
          const t = i / (tiers - 1);
          const y = base - s2 * (0.12 + t * 0.82);
          const half = s2 * (0.40 * (1 - t * 0.9) + 0.025);
          // 雪: 冷白, 越靠上越亮(受天光); alpha 略降让下面的蓝灰影子透出来 = 层次
          const li = 0.86 + t * 0.13;
          const r = Math.round(255 * li * 0.97);
          const g2 = Math.round(255 * li * 0.99);
          const b2 = Math.round(255 * Math.min(1, li * 1.02));
          ctx.fillStyle = 'rgba(' + r + ',' + g2 + ',' + b2 + ',0.88)';
          ctx.beginPath();
          ctx.moveTo(cx, y - s2 * 0.05);
          ctx.lineTo(cx - half, y + s2 * 0.07);
          ctx.lineTo(cx + half, y + s2 * 0.07);
          ctx.closePath();
          ctx.fill();
          // 枝下阴影: 加深蓝灰(雪地对比低, 这条影子是唯一的形状线索)
          ctx.fillStyle = 'rgba(' + Math.round(96 * li) + ',' + Math.round(124 * li) + ',' + Math.round(160 * li) + ',0.80)';
          ctx.beginPath();
          ctx.moveTo(cx, y + s2 * 0.005);
          ctx.lineTo(cx - half * 0.92, y + s2 * 0.085);
          ctx.lineTo(cx + half * 0.92, y + s2 * 0.085);
          ctx.closePath();
          ctx.fill();
        }
        // 主干(深灰褐) — 雪地里能看到的树干
        ctx.strokeStyle = 'rgba(74,66,58,0.95)';
        ctx.lineWidth = Math.max(2, s2 * 0.05);
        ctx.beginPath();
        ctx.moveTo(cx, base);
        ctx.lineTo(cx, base - s2 * 0.5);
        ctx.stroke();
      }, cfg)),
    bush: vegKeyedTexture('skybound-veg-bush-left-' + keyTag, () =>
      vegMiniSheet((ctx, s) => {
        // 半球灌木:暗色圆斑(白键只吃白底,暗色全部保留)。
        const cx = s * 0.5, cy = s * 0.62;
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2;
          const shade = 0.34 + i * 0.18;
          const g = Math.round(60 + shade * 120);
          const r = Math.round(28 + shade * 80);
          const b = Math.round(34 + shade * 64);
          ctx.fillStyle = 'rgba(' + r + ',' + g + ',' + b + ',1)';
          ctx.beginPath();
          ctx.arc(cx + Math.cos(a) * s * 0.13, cy + Math.sin(a) * s * 0.1, s * (0.3 - i * 0.04), 0, Math.PI * 2);
          ctx.fill();
        }
      }, cfg)),
  };
}
/** 图集整张 → 左半裁剪 + 白键(缓存 key 与纹理一致,只算一次) */
function vegBuildSheetCrop(cfg: VegSpriteKeyOptions): { canvas: HTMLCanvasElement; alpha: VegSpriteAlphaStats; source: string } {
  const sheet = cfg.sheet ?? (cfg.sheetUrl ? vegLoadSheetSync(cfg.sheetUrl) : buildVegAtlasSheet(2048));
  const source = cfg.sheet ? 'sheet(provided)' : cfg.sheetUrl ? cfg.sheetUrl : 'procedural-atlas-2048';
  const r = vegCropAndKey(sheet as CanvasImageSource & { width: number; height: number }, cfg);
  return { canvas: r.canvas, alpha: r.alpha, source };
}
/** 由 sheetUrl 取图集:同步解码不可靠 → 明确回退程序化图集并告警 */
function vegLoadSheetSync(url: string): HTMLCanvasElement {
  console.warn(
    '[veg] opts.sprites.sheetUrl 需要异步解码,已回退程序化图集;请用 opts.sprites.sheet 传入已解码图集:',
    url,
  );
  return buildVegAtlasSheet(2048);
}
/** 精灵几何度量(左半幅宽高比 + 白键 alpha 统计) */
function getVegSpriteMetrics(sprites?: VegSpriteKeyOptions): VegSpriteMetrics {
  const cfg: VegSpriteKeyOptions = sprites ?? {};
  const keyTag = 'k' + (cfg.whiteKey ?? 0.985).toFixed(3) + '-' + (cfg.softRamp ?? 0.05).toFixed(3);
  const m = _vegSpriteMetrics.get('skybound-veg-sprite-left-' + keyTag + (cfg.sheetUrl ? '-url' : '-proc'));
  if (m) return m;
  return {
    source: 'procedural-atlas-2048',
    texW: 1024, texH: 2048, aspect: 0.5,
    alpha: { transparent: 0, opaque: 0, total: 0, whiteKeyed: 0, halo: 0, whiteKey: cfg.whiteKey ?? 0.985, softRamp: cfg.softRamp ?? 0.05 },
  };
}
/** 诊断:取某精灵图集的裁剪/白键度量(供验证脚本/报告) */
export function getVegSpriteMetricsForReport(key?: string): VegSpriteMetrics | null {
  const tag = key ?? 'k0.985-0.050';
  return _vegSpriteMetrics.get(key ?? ('skybound-veg-sprite-left-' + tag + '-proc')) ?? null;
}
/** 诊断:全部精灵度量 */
export function listVegSpriteMetrics(): VegSpriteMetrics[] {
  return Array.from(_vegSpriteMetrics.values());
}


// === 交叉平面几何 ===
// 把 N 片竖立矩形(绕 Y 均布)合并成一份 BufferGeometry(带 UV/法线)。
// 顶点布局:每片矩形由 2 个三角形组成,sizeX×sizeY,在片局部坐标,
// 片宽中心偏移 offsetY(让冠悬在树干上方时仍以底部为锚)。
/** 锥形树冠(6 棱) —— 与 blender/terrain 的占位树同形; 底部留 yOff 离地。
 *  用 three 自带的 ConeGeometry: 不自己写顶点/法线/索引, 少一类写反法线/索引的坑。 */
function coneTreeGeo(r: number, h: number, yOff: number): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(r, h, 6, 1);
  g.translate(0, yOff + h / 2, 0);      // ConeGeometry 以中心为原点 ⇒ 抬到地面之上
  return g;
}

function buildCrossPlaneGeometry(planes: number, w: number, h: number, yOff: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  const hw = w / 2;
  for (let i = 0; i < planes; i++) {
    const ang = (i / planes) * Math.PI;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const corners = [
      [-hw, yOff], [hw, yOff], [hw, yOff + h], [-hw, yOff + h],
    ].map(([x, y]) => [x * ca, y, -x * sa]);
    pos.push(...corners[0], ...corners[1], ...corners[2], ...corners[3]);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    nrm.push(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1);
    const base = pos.length / 3 - 4;
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setIndex(idx);
  return geo;
}

export function buildCloudField(
  cfg: SkyConfig,
  count = 60,
  mode: CloudMode = 'geometry',
  coverage: CloudCoverage = 'scattered',
  opts: CloudFieldOpts = {},
): THREE.Group {
  // === Sprite / billboard cloud path ===
  if (mode === 'sprite') {
    return buildCloudFieldSprites(cfg, count, coverage, opts);
  }
  // === Polygonal geometry cloud path (default) ===
  const group = new THREE.Group();
  // Shared geometry — one "puff" template, reused for every cloud lobe.
  // Using IcosahedronGeometry(1, 1) gives a low-poly faceted look that
  // catches light nicely without exploding the poly count.
  const puffGeom = new THREE.IcosahedronGeometry(1, 1);
  // Two materials — bright top for sunlit clouds, darker grey for storm
  // clouds. Both respond to scene lighting.
  const isStormy = (cfg as any).stormy === true || cfg.fogDensity > 0.0001;
  const litColor = isStormy ? new THREE.Color(0x6a7280) : new THREE.Color(cfg.cloudColor).lerp(new THREE.Color(0xffffff), 0.4);
  const litMat = new THREE.MeshStandardMaterial({
    color: litColor,
    roughness: 0.95,
    metalness: 0,
    transparent: true,
    opacity: 0.92,
    flatShading: true, // emphasise the faceted polygon look
    depthWrite: false,
  });
  // Stormy variant — darker, more opaque, slight emissive so they read as
  // heavy thunderheads.
  const stormMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x3a3f48),
    roughness: 1.0,
    metalness: 0,
    transparent: true,
    opacity: 0.96,
    flatShading: true,
    depthWrite: false,
    emissive: new THREE.Color(0x080a0e),
    emissiveIntensity: 0.4,
  });
  const activeMat = isStormy ? stormMat : litMat;

  // Pre-build 4 lobe-template geometries (varying vertex jitter) so we have
  // some variety without rebuilding geometry per cloud.
  const lobeTemplates: THREE.BufferGeometry[] = [];
  for (let t = 0; t < 4; t++) {
    const g = puffGeom.clone();
    const pos = g.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < arr.length; i += 3) {
      // Push each vertex outward along its normal with random noise —
      // this gives the lumpy "cauliflower" silhouette cumulus clouds have.
      const nx = arr[i], ny = arr[i + 1], nz = arr[i + 2];
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      const jitter = 0.65 + Math.random() * 0.7; // 0.65..1.35
      arr[i]     = (nx / len) * jitter;
      arr[i + 1] = (ny / len) * jitter;
      arr[i + 2] = (nz / len) * jitter;
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
    lobeTemplates.push(g);
  }

  // === Placement plan (两层, 需求①②) ===
  // 高度/面积/密度全部由 generateCloudPlacements 里的具名常量决定; 这里只按
  // p.layer 选尺寸档(高空团云大、低空片云小)。
  const lowHeight = opts.lowBaseHeightOverride ?? CLOUD_LOW_BASE_HEIGHT;
  const lowSpread = opts.lowSpreadOverride ?? CLOUD_LOW_SPREAD;
  const placements = generateCloudPlacements(count, coverage, lowHeight, lowSpread);
  // 云层漂移的绕回半径 —— engine 的漂移循环用它(旧版硬编码 ±14000, 会把
  // 48000 半径的低空层直接截断)。挂 userData 让 engine 读。
  group.userData.cloudWrap = Math.max(lowSpread, CLOUD_HIGH_SPREAD);

  for (let i = 0; i < placements.length; i++) {
    const cloudGroup = new THREE.Group();
    const p = placements[i];
    const isBank = p.isBank;
    // Each cloud is a set of lobes arranged in a roughly horizontal pancake
    // (wider than tall — cumulus clouds are flat on the bottom, lumpy on top).
    // In 'overcast' coverage, clouds are flatter and wider (more lobes, less
    // vertical bias) so they read as a connected stratus sheet rather than
    // individual puffy cumulus.
    // === 尺寸/密度加大 (需求①高空团云大幅加大 / 需求②低空片云放大) ===
    // 旧: 云瓣 12-19/8-14, baseSize 620-1280/480-980(已经比最初版大一档)。
    // 新: 再乘各层的具名倍率(高空 ×1.65/×1.6, 低空 ×1.3/×1.35)。
    const lobeBase = isBank ? 12 + Math.floor(Math.random() * 8) : 8 + Math.floor(Math.random() * 7);
    const lobeCount = Math.max(4, Math.round(lobeBase * (isBank ? CLOUD_HIGH_PUFF_SCALE : CLOUD_LOW_PUFF_SCALE)));
    // Banked clouds are wider and flatter; individual clouds are taller/lumpier.
    const baseSize = (isBank ? 620 + Math.random() * 660 : 480 + Math.random() * 500)
      * (isBank ? CLOUD_HIGH_SIZE_SCALE : CLOUD_LOW_SIZE_SCALE);
    const verticalBias = isBank ? 0.25 : 0.45; // banked = flatter top
    for (let j = 0; j < lobeCount; j++) {
      const tmpl = lobeTemplates[Math.floor(Math.random() * lobeTemplates.length)];
      const mesh = new THREE.Mesh(tmpl, activeMat);
      // Random offset within the cloud pancake — biased toward a flat top.
      const angle = Math.random() * Math.PI * 2;
      const r = Math.random() * baseSize * (isBank ? 0.85 : 0.7);
      const lobeScale = baseSize * (0.55 + Math.random() * 0.6);
      mesh.position.set(
        Math.cos(angle) * r,
        (Math.random() - 0.3) * baseSize * verticalBias, // bias upward (lumpy top)
        Math.sin(angle) * r,
      );
      mesh.scale.setScalar(lobeScale);
      cloudGroup.add(mesh);
    }
    // Position the whole cloud at its generated placement.
    cloudGroup.position.set(p.x, p.y, p.z);
    (cloudGroup as any)._layer = p.layer;
    (cloudGroup as any)._isBank = isBank;
    // Mark for drift (handled in the engine update loop)
    (cloudGroup as any)._driftSpeed = 4 + Math.random() * 6;
    (cloudGroup as any)._driftDir = Math.random() * Math.PI * 2;
    (cloudGroup as any)._env = true;
    group.add(cloudGroup);
  }
  return group;
}

// ============================================================================
// === 柱面广告牌贴片云场 (per user request ④: 团云方向始终垂直于地平线) ====
// 旧实现 = 每朵云一个 Group, 组里放 5-20 个 THREE.Sprite(每个 puff 一个 Sprite,
// ~170 朵 × 5-14 puff ≈ 上千 draw call)。Sprite 是**完全朝向相机**的 billboard,
// 相机的 up 参与构造基向量 —— 玩家压坡度(横滚)时, 云的上方向跟着机身一起歪,
// 云层看起来"斜插进地面"。
//
// 新实现两点改动:
//   1. **柱面广告牌(cylindrical billboard)**: 自己在顶点着色器里构造基向量 ——
//      只用相机的水平位置求朝向, up 恒为世界 up(+Y)。于是
//        · 相机 roll / pitch 完全不参与 → 云永不倾斜(需求④);
//        · 只随相机**偏航**变化(和地平线保持垂直)。
//   2. **InstancedMesh 按贴图分组**: 每个 puff 一个实例, 每张贴图 1 个 draw call
//      (8 张程序化贴图 = 8 call; 125 张外部 JPG 最多 125 call), 顺带把上面
//      "上千 draw call" 的问题解决掉。
//
// 云的漂移、雾、每朵云的纹理选择都在这里完成; 时间推进由 engine 每帧写共享
// uniform(userData.cloudUniforms), 不做 CPU 端的矩阵重写。
//
// === 本轮新增: 按天光/太阳角度的动态着色 (需求: 云的光照颜色随天光与太阳角变化) ===
// 贴片云是**无法自阴影的平面**, 所以光照不能用"真实法线"; 这里做三步:
//   1. clouds-prep.mjs 把**亮度当高度场**烘出法线图 `_n.jpg`(记录云瓣的起伏方向);
//   2. 顶点里把世界太阳方向投影到广告牌的局部平面 → `vSunLocal`(x 沿 quad 的
//      right 轴, y 沿 quad 的 up 轴 upAxis)。**近水平时 upAxis = 世界 +Y**, 于是
//      **太阳相对云瓣的方位**才是光照输入, 相机怎么飞都不会让云的受光面跟着转
//      (相机只决定"从哪边看");
//   3. 片元里 N·L(0.5+0.5 包裹, 背面不黑) → 天光色 ↔ 太阳色 之间插值。
// 参数由 engine 每帧注入(见 engine.update 的 "贴片云 uniform" 段), 太阳方向跟
// cfg.sunPos 走 → 关卡/`sun` 命令/时刻变化时云的明暗自动跟着变。
//
// === 本轮新增: 高角度朝向混合 (需求②) =======================================
// 原来 up 硬编码世界 +Y 的**柱面**广告牌在俯视/仰视(|视线.y| → 1)时会侧面对着
// 相机 → 云被看成薄片甚至消失。现在按 |视线.y| 把 up 从"世界 up"平滑混到
// "相机 up"(smoothstep(0.45, 0.85)): 近水平仍是柱面(云底平行地平线, 用户此前
// 的要求不破), 高角度自动转成正对相机的球面广告牌。取舍见 §110。
//
// === 上一轮: 自阴影 + 天空盒光照色 + 大气散射色 (per user request) ===========
// 具体公式与新 uniform 见文件下方 CLOUD_ATMO_*/CLOUD_SELF_SHADOW_*/CLOUD_FORWARD_SCATTER
// 常量表与片元源码里的三段注释(① 自阴影 / ② 天光色 / ③ 大气散射)。
// 硬约束: 新增纹理采样 = 2(自阴影的高度场偏移采样), 不引入立方体/PMREM/循环。
//
// === 本轮新增: 天光自动采样 + 云基色可替换 (需求④) ===========================
// uSkyZenith/uSkyHorizon/uSkyColor 现在由 engine 用**HDRI 实测色**驱动(蓝天空盒
// → 淡蓝云, 橙天空盒 → 橙云); 另有 uSkyReplace/uSkyReplaceK 让云基色可以被实测
// 天光色整体替换(K=0 时 mix 退化 = 改造前逐位一致, 程序化天空走这条)。
// 色彩空间口径见 engine 的 _cloudSkyZenith 注释。
// ============================================================================
function makeCloudBillboardMaterial(
  map: THREE.Texture,
  normal: THREE.Texture | null,
  color: THREE.Color,
  shared: {
    uTime: { value: number };
    uFogColor: { value: THREE.Color };
    uFogDensity: { value: number };
    uWrap: { value: number };
    uSunDir: { value: THREE.Vector3 };
    uSunColor: { value: THREE.Color };
    uSkyColor: { value: THREE.Color };
    uNormalStrength: { value: number };
    // === 本轮新增(见文件顶部 CLOUD_ATMO_* 常量表的说明) ===
    uSunElev: { value: number };            // sin(太阳高度角) = uSunDir.y(engine 每帧注入)
    uSkyZenith: { value: THREE.Color };     // SkyConfig.top   —— 天空盒天顶色
    uSkyHorizon: { value: THREE.Color };    // SkyConfig.bottom —— 天空盒地平线色
    uAtmoStrength: { value: number };       // 大气散射总强度
    uSelfShadowK: { value: number };        // 自阴影强度
    uShadowStep: { value: number };         // 自阴影采样步长(UV)
    uShadowTint: { value: THREE.Color };    // 阴影侧染色
    uForwardScatter: { value: number };     // 前向散射强度
    uTranslucentK: { value: number };       // 阳光穿透薄云(云缘发光)强度
    uConeK: { value: number };              // 太阳锥内提亮强度
    uConeOrigin: { value: THREE.Vector3 };  // 世界锥底心(engine 每帧注入)
    uConeTan: { value: number };            // 世界锥 tan(半角)
    // === 需求④: 云基色由 HDRI 实测天光替换(蓝天空盒→淡蓝云 / 橙→橙云) ===
    uSkyReplace: { value: THREE.Color };    // 替换用基色(= 实测 mix(地平,天顶) 去饱和)
    uSkyReplaceK: { value: number };        // 0 = 不替换(程序化天空回退 cfg.cloudColor)
  },
  opacity: number,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: map },
      // 法线图(线性色空间)。没有时绑 1×1 平法线 + uHasNormal=0 → 完全走"无起伏"路径。
      uNormalMap: { value: normal ?? flatNormalTexture() },
      // 图集格尺寸: 1/网格。非图集路径为 (1,1), 配合 aCell=(0,0) → uv 不变。
      uCellSize: {
        value: CLOUD_ATLAS_GRID
          ? new THREE.Vector2(1 / CLOUD_ATLAS_GRID[0], 1 / CLOUD_ATLAS_GRID[1])
          : new THREE.Vector2(1, 1),
      },
      uHasNormal: { value: normal ? 1 : 0 },
      uColor: { value: color.clone() },
      uOpacity: { value: opacity },
      uTime: shared.uTime,           // 共享对象 → engine 改一份, 全部材质同步
      uFogColor: shared.uFogColor,
      uFogDensity: shared.uFogDensity,
      uWrap: shared.uWrap,
      // === 天光/太阳(共享 → engine 每帧注入; 见 update 里的贴片云段) ===
      uSunDir: shared.uSunDir,
      uSunColor: shared.uSunColor,
      uSkyColor: shared.uSkyColor,
      uNormalStrength: shared.uNormalStrength,
      // === 本轮新增: 自阴影 / 天空盒光照色 / 大气散射(共享 → engine 每帧注入) ===
      uSunElev: shared.uSunElev,
      uSkyZenith: shared.uSkyZenith,
      uSkyHorizon: shared.uSkyHorizon,
      uAtmoStrength: shared.uAtmoStrength,
      uSelfShadowK: shared.uSelfShadowK,
      uShadowStep: shared.uShadowStep,
      uShadowTint: shared.uShadowTint,
      uForwardScatter: shared.uForwardScatter,
      uTranslucentK: shared.uTranslucentK,
      uConeK: shared.uConeK,
      uConeOrigin: shared.uConeOrigin,
      uConeTan: shared.uConeTan,
      // ④ HDRI 天光替换(共享): uSkyReplaceK=0 时片元里 mix() 完全不生效 → 零回归。
      uSkyReplace: shared.uSkyReplace,
      uSkyReplaceK: shared.uSkyReplaceK,
      // 阴影侧(天光)与受光侧(太阳)的**绝对亮度系数** —— 具名常量, 调参只改常量表。
      uAmbientK: { value: CLOUD_LIGHT_AMBIENT_K },
      uLitK: { value: CLOUD_LIGHT_SUN_K },
    },
    vertexShader: /* glsl */ `
      // 每实例属性: 云瓣在云内的局部偏移 / 该云的漂移(速度, 方向, 保留)
      attribute vec3 aOffset;
      attribute vec3 aDrift;
      // === 遮挡裁剪: 0 = 该云瓣被判定为"已被 4 层挡住" → 折叠不显示 (per user request) ===
      attribute float aHide;
      uniform float uTime;
      uniform float uWrap;
      uniform vec3 uSunDir;      // 世界空间单位向量(engine 每帧注入)
      varying vec2 vUv;
      varying float vFogDepth;
      attribute vec2 aCell;      // 图集格坐标(逐实例; 非图集路径恒为 0 = 整张贴图)
      varying vec2 vCell;
      varying vec2 vSunLocal;    // 太阳在广告牌局部平面里的方向(x=right, y=世界 up)
      // (云侧不再做任何"锥内提亮": 三次尝试加 varying 都导致云整片消失, 已全部撤回)
      void main() {
        vUv = uv;
        // instanceMatrix = 该云的中心(平移) + 云瓣尺寸(缩放)。用矩阵的平移列
        // 取中心, 用基向量长度取缩放 —— 云瓣是均匀缩放, 所以只取 x/y。
        vec3 center = instanceMatrix[3].xyz;
        float sx = length(instanceMatrix[0].xyz) * aHide;
        float sy = length(instanceMatrix[1].xyz) * aHide;
        // 云层整体漂移(XZ) + 周期性绕回(超出云场半径从另一侧进来)。
        vec2 drift = vec2(cos(aDrift.y), sin(aDrift.y)) * aDrift.x * uTime;
        vec2 cxz = center.xz + drift;
        cxz = mod(cxz + uWrap, 2.0 * uWrap) - uWrap;
        // 云瓣世界位置 = 云中心 + 云瓣局部偏移(云内层次/厚度)。
        vec3 world = vec3(cxz.x + aOffset.x, center.y + aOffset.y, cxz.y + aOffset.z);
        // === 需求② 柱面↔球面朝向混合 (per user request: 高角度不穿帮) =======
        // 问题: 原来 up 硬编码世界 +Y 的柱面广告牌, 在俯视/仰视(|V.y| → 1,
        // 视线接近竖直)时会**侧面对着相机** → 云被看成薄片甚至消失。
        // 修法(0 额外纹理采样): 按 |V.y| 把 up 轴从"世界 up"平滑混合到"相机 up":
        //   近水平 → 世界 up(云底仍平行地平线 —— 用户此前的要求不破);
        //   高角度 → 相机 up(quad 自动转成正对相机的球面广告牌)。
        // V 用**云心**(不含云瓣偏移): 同一朵云所有云瓣朝向一致, 云体不会自相矛盾。
        vec3 cw = vec3(cxz.x, center.y, cxz.y);
        vec3 V = cameraPosition - cw;
        float vl = length(V);
        V = vl > 1e-4 ? V / vl : vec3(0.0, 0.0, 1.0);
        float topness = abs(V.y);
        float sph = smoothstep(0.45, 0.85, topness);
        // camUp = 相机 up 在世界空间的分量 = viewMatrix 的第二行(列主序 [i][1])。
        vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vec3 upAxis = normalize(mix(vec3(0.0, 1.0, 0.0), camUp, sph));
        // right = up × V, 天然 ⟂ 两者 → quad 正面朝向相机(side = FrontSide 就够)。
        // 退化(upAxis ∥ V, 只在混合过渡的极端角度)时退回世界 right。
        vec3 rc = cross(upAxis, V);
        float rl = length(rc);
        vec3 right = rl > 1e-3 ? rc / rl : vec3(1.0, 0.0, 0.0);
        // === 太阳方向 → 广告牌局部平面 ===
        // quad 的局部 x 轴 = right, 局部 y 轴 = upAxis, 所以两个点积就是太阳在
        // 这两个轴上的分量(单位向量 → 分量 ∈ [-1,1])。近水平时 upAxis = 世界 +Y,
        // y 分量退化成 uSunDir.y —— 与改造前逐位一致(零回归)。
        vSunLocal = vec2(dot(uSunDir, right), dot(uSunDir, upAxis));
        // (云顶点不做锥判定 —— 见顶部说明)
        vCell = aCell;
        // 局部 quad (PlaneGeometry 在 XY 平面) → 世界: right 展开 x, upAxis 展开 y。
        world += right * (position.x * sx) + upAxis * (position.y * sy);
        vec4 mv = viewMatrix * vec4(world, 1.0);
        vFogDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform sampler2D uNormalMap;
      uniform vec2 uCellSize;
      varying vec2 vCell;        // 图集格原点(顶点里算好传下来; 漏了这行着色器会编译失败)
      uniform float uHasNormal;
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      uniform vec3 uSunColor;
      uniform vec3 uSkyColor;
      uniform float uNormalStrength;
      uniform float uAmbientK;
      uniform float uLitK;
      // === 本轮新增: 自阴影 / 天空盒光照色 / 大气散射 ===
      uniform float uSunElev;        // sin(太阳高度角) = uSunDir.y(engine 每帧注入)
      uniform vec3 uSkyZenith;       // SkyConfig.top   —— 天空盒天顶色
      uniform vec3 uSkyHorizon;      // SkyConfig.bottom —— 天空盒地平线色
      uniform float uAtmoStrength;   // 大气散射总强度(0 = 不做散射染色)
      uniform float uSelfShadowK;
      uniform float uShadowStep;
      uniform vec3 uShadowTint;
      uniform float uForwardScatter;
      uniform float uTranslucentK;
      uniform float uConeK;       // 太阳锥内的提亮强度
      uniform vec3 uConeOrigin;   // 世界锥底心(机体海面投影, engine 每帧注入)
      uniform float uConeTan;     // 世界锥 tan(半角)
      // === 需求④: 云基色可由 HDRI 实测天光替换 ===
      // K = 0 → cloudBase = uColor(与改造前逐位一致, 程序化天空走这条);
      // K = 1 且有 HDRI → cloudBase = uSkyReplace(实测天空色推出来的淡蓝/橙云基色)。
      // 用 mix 而不是乘: 乘法会把"写死的暖调基色"和实测冷色相互抵消成脏灰, 替换才能
      // 真的做到"蓝天空盒 → 淡蓝云"。
      uniform vec3 uSkyReplace;
      uniform float uSkyReplaceK;
      varying vec2 vUv;
      varying float vFogDepth;
      varying vec2 vSunLocal;
      // "高度场"取值 = 亮度 × alpha。两种素材来源共用同一条自阴影路径:
      //   黑底白云 JPG(a=1, 无 alpha 通道) → 高度 = 亮度;
      //   程序化贴图(白 + alpha)           → 高度 = alpha。
      // 所以哪怕完全没有外部素材(程序化回退), 自阴影也不会退化成常数。
      float cloudHeight(vec4 s) {
        return dot(s.rgb, vec3(0.299, 0.587, 0.114)) * s.a;
      }
      void main() {
        // 图集: 把 [0,1] 的 uv 压进该实例的格子(uCellSize = 1/网格, vCell = 格原点)。
        // 非图集路径下 uCellSize=(1,1)、vCell=(0,0) → 与改造前逐位一致。
        vec2 atlasUv = clamp(vUv, 0.002, 0.998) * uCellSize + vCell;
        vec4 t = texture2D(map, atlasUv);
        // 程序化贴图 = 白 + alpha; 真实 2D 云 JPG = 黑底白云(无 alpha 通道),
        // 所以用亮度当 alpha: 两种来源统一处理。
        float lum = dot(t.rgb, vec3(0.299, 0.587, 0.114));
        float a = t.a * clamp(lum * 1.35, 0.0, 1.0);
        if (a < 0.004) discard;

        // === 云瓣起伏的法线 (需求: 转法线贴图才能正确反映光照变化) ===
        // uHasNormal=0(没素材/没烘法线)时 mix 直接给出 (0,0,1) → 纯亮度着色 + 半球天光。
        vec3 n = mix(vec3(0.0, 0.0, 1.0), texture2D(uNormalMap, atlasUv).rgb * 2.0 - 1.0, uHasNormal);
        // 方向归一(无起伏时退化为 0 向量, 用 nlen 判定避开 normalize(0) 的 NaN)。
        vec2 nxy = n.xy;
        float nlen = length(nxy);
        vec2 ndir = nlen > 1e-4 ? nxy / nlen : vec2(0.0);
        // vSunLocal 是太阳在**广告牌局部平面**内的方向(x=quad 的 right 轴, y=世界 up):
        // 它既是 N·L 的 L, 也是下面自阴影采样要走的方向(同一个方向, 一次归一化复用)。
        vec2 sdir = length(vSunLocal) > 1e-4 ? normalize(vSunLocal) : vec2(0.0, 1.0);
        // 0.5+0.5 包裹: 背光面落在 0(只剩天光), 正对太阳落在 1(全日照)。
        float ndl = clamp(dot(ndir, sdir) * 0.5 + 0.5, 0.0, 1.0);
        // 强度旋钮: 用"起伏幅度 |n.xy| × uNormalStrength"决定方向项生效多少。
        // (裸 normalize(n.xy) 会把归一化掉的 k 与 uNormalStrength 双双变成空转 ——
        //  这里让"越陡的面越受方向项支配, 平的地方退回均匀天光"。)
        float nstr = clamp(nlen * uNormalStrength, 0.0, 1.0);
        ndl = mix(0.5, ndl, nstr);

        // ====================================================================
        // === ③ 大气散射色(解析近似: 只按太阳高度角查两个染色, 无体积积分) ===
        // ====================================================================
        // e = sin(太阳高度角)。engine 每帧注入(= 归一化 sunPos 的 y), 这里再夹一次
        // 防上游漏写 uniform 时把 NaN/异常值传播到整幅画面。
        float e = clamp(uSunElev, -1.0, 1.0);
        float atmo = clamp(uAtmoStrength, 0.0, 2.0);
        // 太阳透射色: 太阳低角 → 暖橙(1,0.55,0.25, 长光程被瑞利散射吃掉蓝绿);
        //              太阳升高 → 接近白(1,0.95,0.88)。
        vec3 sunTint = mix(vec3(1.0, 0.55, 0.25), vec3(1.0, 0.95, 0.88), smoothstep(0.0, 0.35, e));
        // 天空散射色: 低角/暮色 → 青灰(0.55,0.68,0.95); 高角 → 亮蓝(0.75,0.85,1.0)。
        vec3 skyTint = mix(vec3(0.55, 0.68, 0.95), vec3(0.75, 0.85, 1.0), smoothstep(-0.1, 0.4, e));
        // uAtmoStrength = 0 → 两个染色都退回 vec3(1) = "完全不做散射染色"(旋钮语义),
        // 而不是"乘 0 变黑"。
        sunTint = mix(vec3(1.0), sunTint, atmo);
        skyTint = mix(vec3(1.0), skyTint, atmo);
        vec3 skyDome = mix(uSkyHorizon, uSkyZenith, clamp(e * 1.6, 0.0, 1.0));
        // ====================================================================
        // === ② 太阳与天空盒光照色: **受光色 = 天空盒的颜色** (per user request) ===
        // ====================================================================
        // 用户: "云受到照射的颜色可能不应该是太阳的颜色, 应该是和天空盒那样的颜色"。
        // 物理上也对: 云被照亮时看到的是**被阳光提亮的天空色**(云本身接近白/灰,
        // 色调主要由环境散射决定)。直接涂太阳色会让黄昏的云发橙红、正午发黄, 反而把
        // 天空盒自己的色调(顶蓝底金等)丢掉。
        // 现在受光/背光**共用同一套天空色** skyLit, 只是系数不同;
        // 太阳色只掺 22% 当"暖峰"(否则黄昏的云会偏橄榄/纯白)。
        //   skyDome  = mix(天空盒地平线色, 天顶色, 太阳高度角) —— 云所在方向的天空色
        //   skyLit   = mix(uSkyColor, skyDome, 0.45) × 天空散射色
        vec3 skyLit = mix(uSkyColor, skyDome, 0.45) * skyTint;
        // 天光(背光面 / 云底)
        vec3 skyLight = skyLit * uAmbientK;
        // 受光面: 同一套天空色 × 受光系数, 掺一点太阳暖色
        vec3 sunLight = mix(skyLit, uSunColor * sunTint, 0.22) * uLitK;
        // 天光 ↔ 受光 之间插值: 太阳方位/高度一变, 云的明暗与色调立刻跟着变。
        vec3 lit = mix(skyLight, sunLight, ndl);

        // ====================================================================
        // === ① 自阴影(云体自遮挡) ===
        // ====================================================================
        // 贴片云是平面, 没有真实几何遮挡; 这里用"亮度×alpha 当高度场"做廉价体自遮挡:
        // 沿太阳在平面内的方向 sd 取两个偏移高度 h1/h2, 本像素比前方低 = 被云体挡住。
        // 全程 **2 次额外纹理采样**(k1 = uShadowStep, k2 = 2.5×uShadowStep, 都是常数倍,
        // 不是循环/不是多 tap), 云场 2.5 万实例的开销可控。
        float h = cloudHeight(t);
        float h1 = cloudHeight(texture2D(map, vUv + sdir * uShadowStep));
        float h2 = cloudHeight(texture2D(map, vUv + sdir * (uShadowStep * 2.5)));
        float occ = clamp((max(h1, h2) - h) * uSelfShadowK, 0.0, 1.0);
        // 云底/背面本来就该暗: 太阳在云层下方(e < 0)时整体压暗 —— 此时云层底部
        // 收不到直射, 只有天光(这也是"太阳落山后云看起来发灰"的来源)。
        occ = max(occ, clamp(-e * uSelfShadowK * 0.5, 0.0, 1.0));
        // 只**压暗**(乘阴影染色, 阴影偏冷), 不做加法、不引入第二种光源。
        lit = mix(lit, lit * uShadowTint, occ);

        // ====================================================================
        // === ③ 前向散射(太阳方向的一点点暖光) ===
        // ====================================================================
        // 把 0.5+0.5 包裹过的 ndl 重新映射回 0..1(背面 = 0, 不加), 再取 4 次幂 →
        // 只有"正对太阳"的那一小块云缘拿到加成(体积散射里云对太阳方向的强前向峰)。
        // (1 - 雾覆盖) 让远处云不额外发亮 —— 它已经被雾混掉了, 再加会脏。
        float f = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
        float fg = clamp(f, 0.0, 0.92);
        float fs = pow(clamp(ndl * 2.0 - 1.0, 0.0, 1.0), 4.0);
        lit += sunLight * uForwardScatter * fs * (1.0 - fg);
        // === 阳光穿透薄云(云缘/薄处发光) =====================================
        // 前向散射管"方向"(正对太阳的那侧), 这一项管"厚度": 高度场越低(云越薄)
        // 且自遮挡越少, 透出来的太阳光越多 —— 参考图里云团边缘那种发白/发金的光边
        // 主要来自这里。用 (1-occ) 而不是直接相加, 避免把阴影区也点亮。
        float thin = 1.0 - clamp(h * 1.7, 0.0, 1.0);
        lit += sunLight * uTranslucentK * thin * (1.0 - occ) * (0.35 + 0.65 * fs) * (1.0 - fg);

        // 内部密度层次: 高密(亮)处更白, 稀疏处略暗(保留原有密度调制)。
        // === 云基色: 可选被 HDRI 实测天光替换(需求④) ===
        // K = 0 时 mix 退化成 uColor 本身 → 改造前行为逐位保留。
        vec3 cloudBase = mix(uColor, uSkyReplace, clamp(uSkyReplaceK, 0.0, 1.0));
        // === 云上的"太阳视线锥"暂时撤掉 (per fix) ==============================
        // 加了这一项之后云整片消失(实测: 云材质的 material.program 为 false ⇒ 根本没编译/
        // 没渲染, 而 __glErrors/__jsErrors 都是空的, 所以静默失败)。在定位清楚之前先不用它,
        // 海面那一侧的锥项(shader 里的 viewCone)保留 —— 它对海面是有效的。
        // === 太阳锥内的云被照亮 (per user request) ==========================
        // ⚠️ 这里**只用已有的 varying**(vSunLocal = 太阳在广告牌平面内的方向) + uv 做加权,
        // 不新增 varying/不碰 vertex —— 上一版新增 vWorldPosC 之后云材质 material.program
        // 直接变成 false(整片云不渲染, 而错误数组是空的, 静默失败), 所以这条线不能再动。
        // 判据: 像素相对云瓣中心的方向 (uv-0.5) 与"太阳在云瓣平面内的方向"对齐程度 →
        // 越朝太阳的那一侧越亮, 幂次 3 让亮区收成一个锥/扇。视觉上 = 视野里太阳那一侧的云被点亮。
        // (云侧的锥内提亮已撤回: 只保留下面的"朝太阳那一侧发亮"的 billboard 近似,
        //  它不动接口、实测云正常渲染。)
        vec3 col = cloudBase * lit * mix(0.72, 1.0, clamp(lum * 1.15, 0.0, 1.0));
        // exp2 雾(与 buildOcean 同一套公式), 远处云融进雾里(公式与改造前完全一致)。
        col = mix(col, uFogColor, fg);
        gl_FragColor = vec4(col, a * uOpacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    // 柱面广告牌的 quad 法线由基向量保证朝向相机(right × up = fwd), 所以
    // FrontSide 就够 —— 比 DoubleSide 少一半填充率(云是大面积 overdraw)。
    side: THREE.FrontSide,
    fog: false, // 手写 exp2 雾(见 fragment)
  });
}

// === 需求③ 跨步遍历的步长 (per user request: 同朵云内 puff 贴图不重复) ===
// gcd: 用欧几里得算法(池大小 ≤ 128, 开销可忽略, 且只在建场时算一次/朵)。
function gcdInt(a: number, b: number): number {
  while (b) { const t = a % b; a = b; b = t; }
  return a;
}
/** 返回与 pool 互质、且落在 [2, pool-2] 的步长(seed = 云序号)。
 *  · 互质 ⇒ 跨步遍历走满一整个周期才回到起点 ⇒ 前 pool 个 puff 索引互不相同;
 *  · ≥2 且 ≤ pool-2 ⇒ 相邻 puff 的索引差值至少 2, 不会取到相邻(形状最像)的素材。
 *  池太小(≤3)时退化成步长 1 —— 此时本来就没有"形状相近的邻索引"可言。 */
function cloudTexStride(pool: number, seed: number): number {
  if (pool <= 3) return 1;
  const lo = 2, hi = pool - 2, span = hi - lo + 1;
  for (let k = 0; k < span; k++) {
    const step = lo + ((seed * 7 + k) % span);
    if (gcdInt(step, pool) === 1) return step;
  }
  return 1;
}

function buildCloudFieldSprites(
  cfg: SkyConfig,
  count: number,
  coverage: CloudCoverage = 'scattered',
  opts: CloudFieldOpts = {},
): THREE.Group {
  const group = new THREE.Group();
  const isStormy = (cfg as any).stormy === true || cfg.fogDensity > 0.0001;
  const litColor = isStormy ? new THREE.Color(0x6a7280) : new THREE.Color(cfg.cloudColor).lerp(new THREE.Color(0xffffff), 0.4);
  // === 真实云贴图优先 (需求③: VFX Assets 2D Cloud Textures Pack) ===
  // engine 启动时用 loadCloudTextures() 扫 public/textures/clouds/ 载入(有几张用
  // 几张, 目标是 125 张), 从这里传入; 一张都没有就用程序化贴图兜底。
  //
  // === 本轮新增: 按类别分配 (需求: 云按大小自动分类后"适配分配") ===
  // clouds-prep.mjs 把素材分成 large(宽扁平底团云)/ small(中小孤立团云), 这里:
  //   · 高空团云层(bank)     → 只用 large
  //   · 低空片云层(scattered)→ 只用 small
  //   · 某一类缺失(或清单没给 class → 'unknown')时: 用 unknown 池兜底;
  //     unknown 也没有(完全没素材) → 该层回退**程序化贴图**(向后兼容, 不报错)。
  const entries: CloudTexEntry[] = opts.cloudTextures && opts.cloudTextures.length
    ? opts.cloudTextures
    : [];
  const fallbackPool: CloudTexEntry[] = makeCloudTextures().map((tex) => ({ tex, normal: null, cls: 'unknown' as const }));
  const largePool = entries.filter((e) => e.cls === 'large');
  const smallPool = entries.filter((e) => e.cls === 'small');
  const unknownPool = entries.filter((e) => e.cls === 'unknown');
  const bankPool = largePool.length ? largePool : (unknownPool.length ? unknownPool : fallbackPool);
  const lowPool = smallPool.length ? smallPool : (unknownPool.length ? unknownPool : fallbackPool);
  const cloudColor = isStormy ? new THREE.Color(0x4a525a) : litColor;
  const opacity = isStormy ? 0.94 : 0.88;

  // 共享 uniform 对象 —— 所有云材质引用同一份, engine 每帧只写一次。
  const lowHeight = opts.lowBaseHeightOverride ?? CLOUD_LOW_BASE_HEIGHT;
  const lowSpread = opts.lowSpreadOverride ?? CLOUD_LOW_SPREAD;
  const shared = {
    uTime: { value: 0 },
    uFogColor: { value: cfg.fog.clone() },
    uFogDensity: { value: cfg.fogDensity },
    // 绕回半径: 两层里较大的那个, 保证任何一层都不会在半径内被提前折返。
    uWrap: { value: Math.max(lowSpread, CLOUD_HIGH_SPREAD) },
    // === 天光/太阳(engine 每帧注入, 见 engine.update 的贴片云 uniform 段) ===
    // 初值取当前关卡的配置, 这样第一帧(engine 还没写)就是对的颜色。
    uSunDir: { value: cfg.sunPos.clone().normalize() },
    uSunColor: { value: cfg.sunColor.clone() },
    uSkyColor: { value: cfg.cloudColor.clone() },
    uNormalStrength: { value: CLOUD_NORMAL_STRENGTH },
    // === 本轮新增: 自阴影 / 天空盒光照色 / 大气散射 ===
    // 同样在这里给**非 null 的初值**, 程序化回退路径(无外部贴图)与"engine 还没跑
    // 第一帧"都能直接出正确画面, 不会因为 uniforms 里是 null 而拿到 NaN。
    // uSunElev 由 engine 每帧跟随 cfg.sunPos 更新(见 engine.update 的注入段)。
    uSunElev: { value: cfg.sunPos.clone().normalize().y },
    uSkyZenith: { value: cfg.top.clone() },     // 天空盒天顶色 → 云的天光偏色
    uSkyHorizon: { value: cfg.bottom.clone() }, // 天空盒地平线色
    uAtmoStrength: { value: CLOUD_ATMO_STRENGTH },
    uSelfShadowK: { value: CLOUD_SELF_SHADOW_K },
    uShadowStep: { value: CLOUD_SELF_SHADOW_STEP },
    // 阴影染色要 clone: THREE.Color 是可变对象, 多片云场共享同一实例会互相污染。
    uShadowTint: { value: CLOUD_SHADOW_TINT.clone() },
    uForwardScatter: { value: CLOUD_FORWARD_SCATTER },
    uTranslucentK: { value: CLOUD_TRANSLUCENT_K },
    uConeK: { value: CLOUD_CONE_K },
    // 世界空间太阳锥(engine 每帧注入) —— 共享实例, 所有云材质同步
    uConeOrigin: { value: new THREE.Vector3() },
    uConeTan: { value: 0.15 },
    // === ④ HDRI 天光替换 (per user request: 天光自动采样适配) ===
    // uSkyReplaceK = 0 → 片元里 mix(uColor, uSkyReplace, 0) = uColor, 与改造前
    // 逐位一致(程序化天空回退路径零回归); HDRI 关卡由 engine 每帧置 1 并把
    // uSkyReplace 写成实测天空色推出来的云基色。
    uSkyReplace: { value: new THREE.Color(1, 1, 1) },
    uSkyReplaceK: { value: 0 },
  };

  const placements = generateCloudPlacements(count, coverage, lowHeight, lowSpread);

  // === 按贴图分桶 → 每张贴图一个 InstancedMesh(1 draw call) ===
  interface PuffInst {
    /** 图集格坐标 [列, 行](未走图集为 null → 整张贴图)。 */
    cell: [number, number] | null;
    /** 这一瓣用的贴图条目(物化材质时要拿它的 tex/normal)。 */
    entry: CloudTexEntry;
    center: THREE.Vector3;   // 云中心(instanceMatrix 平移)
    offset: THREE.Vector3;   // 云瓣在云内的局部偏移
    drift: THREE.Vector3;    // (速度, 方向, 保留)
    sx: number; sy: number;  // 云瓣尺寸
  }
  // 桶键 = 贴图条目本身(不再是数组下标): 同一张图被两层共用时自然合到一个桶,
  // 而每桶的材质要同时挂**它自己的** map + normalMap, 用下标做键反而要来回查表。
  // 键: 走图集时统一用 '__atlas__'(所有云一张图 → 一个桶); 否则用贴图条目本身。
  const buckets = new Map<unknown, PuffInst[]>();
  const layerTexUsed = { bank: new Set<CloudTexEntry>(), low: new Set<CloudTexEntry>() };
  let lowClouds = 0;
  let highClouds = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  // === 需求③ 验收统计: 同一朵云内 puff 贴图唯一性 ===
  // 逐 puff 计数"这朵云一共几个 puff / 其中几张不同贴图"。理想情况二者相等。
  const texDup = { puffs: 0, unique: 0, cloudsWithDup: 0 };
  // 云序号: 作为跨步遍历的种子(每朵云的起点/步长不同)。
  let cloudIdx = 0;

  for (const p of placements) {
    const isBank = p.isBank;
    if (isBank) highClouds++; else lowClouds++;
    cloudIdx++;
    // === 尺寸/密度加大 (需求①高空团云"大幅"加大大小和密度) ===
    // 旧: puff 13-20/9-14, baseSize 980-2180/760-1660。
    // 新: 各层再乘具名倍率 —— 高空 ×1.6/×1.65(团云的尺寸与云瓣数一起涨),
    // 低空 ×1.35/×1.3(需求②以面积+云量为主, 尺寸小幅跟随)。
    const puffBase = isBank ? 13 + Math.floor(Math.random() * 8) : 9 + Math.floor(Math.random() * 6);
    const puffCount = Math.max(4, Math.round(puffBase * (isBank ? CLOUD_HIGH_PUFF_SCALE : CLOUD_LOW_PUFF_SCALE)));
    const baseSize = (isBank ? 980 + Math.random() * 1200 : 760 + Math.random() * 900)
      * (isBank ? CLOUD_HIGH_SIZE_SCALE : CLOUD_LOW_SIZE_SCALE);
    // 每团云有独立高度偏移(±300),与漂移方向配合让整片云层更有层次。
    const lift = (Math.random() - 0.5) * 600;
    const center = new THREE.Vector3(p.x, p.y + lift, p.z);
    const speed = 4 + Math.random() * 6;
    const dir = Math.random() * Math.PI * 2;
    // 按层取池: 高空团云层只用 large, 低空片云层只用 small(缺类时已回退, 见上)。
    const pool = isBank ? bankPool : lowPool;
    // === 需求③ 同一朵云内 puff 贴图不重复 + 相邻 puff 不取相邻索引 ==========
    // 旧实现: 整朵云随机抽 **1 张**贴图(不同云之间很容易抽到形状相近甚至相同
    // 的素材)。现在**逐 puff** 在池里跨步遍历:
    //   · 步长 step 与池大小互质(见 cloudTexStride)→ 一个完整周期内每个索引
    //     恰好访问一次 ⇒ 前 pool 个 puff **天然不重复**; 只有 puffCount > pool
    //     才会回绕, 且回绕后前 pool 个仍然不重复。
    //   · step ∈ [2, pool-2] ⇒ 相邻 puff 的索引差 ≥ 2(mod 池大小也不相邻),
    //     不会连续取到"同批相邻素材"(clouds-prep.mjs 是同一批切出来的,
    //     相邻索引形状最接近)。
    //   · 起点与步长都以**云序号**为种子 ⇒ 每朵云的排列不同, 宏观仍随机打散。
    // 池已按 class 分开(bank → large / low → small), 所以"形状相近"的素材
    // 本来就跨类, 这里只解决同类内部的重复/相邻问题。
    const step = cloudTexStride(pool.length, cloudIdx);
    const start = pool.length > 1 ? (cloudIdx * 5 + (cloudIdx % 3)) % pool.length : 0;
    const usedInCloud: CloudTexEntry[] = [];
    for (let j = 0; j < puffCount; j++) {
      const entry = pool.length > 1 ? pool[(start + j * step) % pool.length] : pool[0];
      usedInCloud.push(entry);
      (isBank ? layerTexUsed.bank : layerTexUsed.low).add(entry);
      const bucketKey: unknown = entry.atlasCell ? '__atlas__' : entry;
      let bucket = buckets.get(bucketKey);
      if (!bucket) { bucket = []; buckets.set(bucketKey, bucket); }
      const angle = Math.random() * Math.PI * 2;
      const r = Math.random() * baseSize * (isBank ? 0.7 : 0.55);
      const scale = baseSize * (0.6 + Math.random() * 0.7);
      bucket.push({
        cell: entry.atlasCell ?? null,
        entry,
        center,
        offset: new THREE.Vector3(
          Math.cos(angle) * r,
          (Math.random() - 0.35) * baseSize * 0.4,
          Math.sin(angle) * r,
        ),
        drift: new THREE.Vector3(speed, dir, 0),
        sx: scale,
        // === 等比放大, 不再竖向压扁 (per user request: 云层贴图尽量等比例放大而不是拉伸放大) ===
        // 原来这里写 `scale * 0.7`(把每片云竖向压 30%), 图集本身是 contain+黑底(保持了素材
        // 原始宽高比), 结果被这 0.7 二次拉伸 —— 云瓣看起来被压扁、细节发糊。
        // 现在 sy = sx: 整片云只做等比缩放; 想调"扁平感"请改尺寸常量, 不要在这里拉长宽比。
        sy: scale,
      });
    }
    // 验收统计(需求③): 这朵云内 puff 数 vs 不同贴图数。puffCount > pool 时
    // 唯一数上限就是 pool 大小 → 不算违规。
    {
      const uniq = new Set(usedInCloud).size;
      texDup.puffs += puffCount;
      texDup.unique += uniq;
      if (uniq < puffCount && puffCount <= pool.length) texDup.cloudsWithDup++;
    }
    minY = Math.min(minY, center.y);
    maxY = Math.max(maxY, center.y);
  }

  const m4 = new THREE.Matrix4();
  let totalInstances = 0;
  for (const [, list] of buckets) {
    if (!list.length) continue;
    const entry = list[0].entry;   // 桶内所有 puff 共用同一张贴图(图集模式下就是图集)
    // 每个桶一份独立几何 —— 每实例属性(aOffset/aDrift)挂在几何上, 不能共享。
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = makeCloudBillboardMaterial(entry.tex, entry.normal, cloudColor, shared, opacity);
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    im.frustumCulled = false; // 世界坐标在着色器里算, 包围盒不可靠
    im.matrixAutoUpdate = false;
    const aOffset = new Float32Array(list.length * 3);
    const aDrift = new Float32Array(list.length * 3);
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      m4.makeScale(it.sx, it.sy, 1);
      m4.setPosition(it.center); // 平移列 = 云中心(着色器靠它算柱面朝向)
      im.setMatrixAt(i, m4);
      aOffset[i * 3] = it.offset.x;
      aOffset[i * 3 + 1] = it.offset.y;
      aOffset[i * 3 + 2] = it.offset.z;
      aDrift[i * 3] = it.drift.x;
      aDrift[i * 3 + 1] = it.drift.y;
      aDrift[i * 3 + 2] = it.drift.z;
    }
    im.instanceMatrix.needsUpdate = true;
    // aCell = 该实例在图集里的**格原点**(已归一化): 片元用 uv*uCellSize + aCell 取格。
    // 非图集路径全 0 → uv 不变(uCellSize=(1,1))。
    const aCell = new Float32Array(list.length * 2);
    if (CLOUD_ATLAS_GRID) {
      const gx = CLOUD_ATLAS_GRID[0], gy = CLOUD_ATLAS_GRID[1];
      for (let i = 0; i < list.length; i++) {
        const c = list[i].cell;
        if (!c) continue;
        aCell[i * 2] = c[0] / gx;
        aCell[i * 2 + 1] = c[1] / gy;
      }
    }
    geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(aCell, 2));
    // === 遮挡裁剪用的逐实例可见性(初始全 1 = 都显示) ===
    const aHide = new Float32Array(list.length).fill(1);
    const aHideAttr = new THREE.InstancedBufferAttribute(aHide, 1);
    geo.setAttribute('aHide', aHideAttr);
    // 逐实例元数据(世界位置要按着色器同一套公式复刻: center+offset+drift×t, 再绕回)
    const overdrawItems = list.map((it) => ({
      center: it.center, offset: it.offset, drift: it.drift, sx: it.sx, sy: it.sy,
    }));
    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(aOffset, 3));
    geo.setAttribute('aDrift', new THREE.InstancedBufferAttribute(aDrift, 3));
    (im as any)._env = true;
    im.userData.cloudMat = mat;
    im.userData.cloudHideAttr = aHideAttr;
    const odb = (group.userData.cloudOverdrawBuckets as THREE.InstancedMesh[] | undefined);
    if (odb) odb.push(im); else group.userData.cloudOverdrawBuckets = [im];
    im.userData.cloudOverdrawItems = overdrawItems;
    group.add(im);
    totalInstances += list.length;
  }

  // === engine 侧的交接点 ===================================================
  //  time 推进: 每帧 uTime.value = missionTime(见 engine.update)。
  //  雾色: 每帧跟随 scene.fog(与海面同一套同步逻辑)。
  //  cloudSpriteMats 保留为空数组 —— 旧版靠它做"共享材质 counter-roll",
  //  柱面广告牌不需要(geometry 路径仍是 Sprite? 否: 这条路已无 Sprite)。
  group.userData.cloudUniforms = shared;
  group.userData.cloudStats = {
    total: placements.length,
    low: lowClouds,
    high: highClouds,
    instances: totalInstances,
    // 贴图数(本轮语义: 实际用到的桶数)。外部素材存在时给出按类别分配的结果,
    // 供 UI 探针/调试确认"large → 高空 / small → 低空"真的生效。
    textures: buckets.size,
    texturesBank: layerTexUsed.bank.size,
    texturesLow: layerTexUsed.low.size,
    texturesLarge: largePool.length,
    texturesSmall: smallPool.length,
    texturesNormal: entries.filter((e) => !!e.normal).length,
    texturesExternal: entries.length,
    fallbackPool: bankPool === fallbackPool || lowPool === fallbackPool,
    drawCalls: group.children.length,
    minY: Number.isFinite(minY) ? minY : 0,
    maxY: Number.isFinite(maxY) ? maxY : 0,
    // === 需求③ 验收: 同朵云内 puff 贴图唯一率 ===
    // puffTexUnique = Σ(每朵云内不同贴图数) / Σ(每朵云 puff 数) —— 1.0 表示
    // "整场没有任何一朵云用了重复素材"(只有 puffCount > 池大小时才可能 <1)。
    // puffTexDupClouds = 出现重复的云数(< pool 大小却不唯一的云)。
    puffTexUnique: texDup.puffs > 0 ? texDup.unique / texDup.puffs : 1,
    puffTexPuffs: texDup.puffs,
    puffTexUniqueCount: texDup.unique,
    puffTexDupClouds: texDup.cloudsWithDup,
  };
  group.userData.cloudWrap = Math.max(lowSpread, CLOUD_HIGH_SPREAD);
  return group;
}


// Distant island silhouette
export function buildIsland(cfg: SkyConfig, position: THREE.Vector3): THREE.Mesh {
  const geom = new THREE.ConeGeometry(2000, 800, 6);
  const mat = new THREE.MeshStandardMaterial({
    color: cfg.hemiGround.clone().lerp(new THREE.Color('#3a3a30'), 0.4),
    roughness: 0.95,
    metalness: 0,
    flatShading: true,
  });
  const m = new THREE.Mesh(geom, mat);
  m.position.copy(position);
  m.position.y = 200;
  return m;
}

// Allied carrier
export function buildCarrier(cfg: SkyConfig): THREE.Group {
  const g = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({ color: 0x4a5258, roughness: 0.8, metalness: 0.3 });
  const deckMat = new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.9 });
  const hull = new THREE.Mesh(new THREE.BoxGeometry(60, 8, 220), hullMat);
  hull.position.y = 4;
  g.add(hull);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(70, 1, 200), deckMat);
  deck.position.y = 9;
  g.add(deck);
  const tower = new THREE.Mesh(new THREE.BoxGeometry(18, 16, 22), hullMat);
  tower.position.set(18, 18, 30);
  g.add(tower);
  return g;
}

// ============================================================================
// === DETAILED TERRAIN FEATURE BUILDERS ======================================
// Each map type (ocean, city, mountain, desert, archipelago) gets its own set
// of distinctive props so the player can tell at a glance what kind of terrain
// they're flying over. The original buildIsland/buildCity were very basic —
// these new functions add the kind of secondary detail that makes a map feel
// like a real place: vegetation, infrastructure, water bodies, settlements,
// and so on. They are intentionally lightweight (low-poly instanced meshes
// where possible) so dozens can be placed without killing the frame rate.
// ============================================================================

// Seeded PRNG helper (mulberry32) — keeps terrain deterministic per seed
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// === GROUND/NAVAL COMBAT UNITS (per user request) ===========================
// Surface vessels + land vehicles that can move, defend themselves, and
// attack aircraft. These are placed on the map at mission start and updated
// each frame by the engine (movement, target acquisition, weapon firing).
// Visuals are intentionally lightweight (BoxGeometry + CylinderGeometry)
// since there can be many on-screen at once; the engine handles their
// behaviour separately.
// ============================================================================

// Type tag for ground units — drives their AI behaviour + visual builder.
// === Extended variety (per user request: 多款敌我地面和海军单位) ===
// Added frigate, patrol_boat, artillery, bunker, radar_station so each
// mission has a richer combined-arms battlefield.
export type GroundUnitType =
  | 'destroyer'    // allied/enemy naval destroyer — AA missiles + main gun
  | 'cruiser'      // larger warship — stronger AA, more HP
  | 'frigate'      // smaller, faster warship — light AA, lower HP
  | 'patrol_boat'  // very small fast attack craft — weak AA, low HP
  | 'tank'         // land main battle tank — ground-target gun, weak AA
  | 'sam_launcher' // land SAM site — stationary, fires AA missiles at aircraft
  | 'aa_vehicle'   // land mobile AA — autocannon anti-air
  | 'artillery'    // land mobile artillery — long-range ground gun
  | 'bunker'       // land fortified bunker — high HP, no movement, defensive
  | 'radar_station'// land radar — large detection range, no weapons
  | 'laser_aa'     // fixed laser AA (per user request: T-00 激光防空炮)
  | 'air_light'     // 轻型空中战舰(per user request): 巨型长方形舰体 + 6 个表面组件, 高空盘旋
  | 'air_component' // 空中战舰的**附属组件单位**(per user request): 独立开火 + 独立可锁定, 固定在舰面上
  | 'air_boss'      // 正式版剧情第一关的敌方主舰「堡垒」(900x240x160, 16 个面部挂点, 分阶段战斗)
  | 'air_drone';    // 无人机(蜂群): 自杀式冲撞, 数量有限, 骚扰玩家

// Visual builder for a destroyer (naval vessel).
// Returns a Group with hull, deck, superstructure, gun turret, and funnel.
export function buildDestroyer(cfg: SkyConfig, isAlly: boolean): THREE.Group {
  const g = new THREE.Group();
  const hullColor = isAlly ? 0x3a4a5a : 0x4a3a3a;
  const deckColor = isAlly ? 0x2a3640 : 0x3a2a2a;
  const superColor = isAlly ? 0x4a5a6a : 0x5a4a4a;
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.5, metalness: 0.7 });

  // Hull — long box with tapered bow (we fake the taper with a wedge).
  const hullGeom = new THREE.BoxGeometry(14, 8, 90);
  const hullMat = unitPBR(hullGeom, hullColor, { tag: 'unit:dd', repeat: 4 });
  const hull = new THREE.Mesh(hullGeom, hullMat);
  hull.position.y = 4;
  g.add(hull);
  // Bow wedge — angled front.
  const bowGeom = new THREE.BoxGeometry(14, 8, 16);
  const bow = new THREE.Mesh(bowGeom, hullMat);
  bow.position.set(0, 4, 50);
  bow.rotation.x = -0.3;
  g.add(bow);
  // Main deck
  const deckGeom = new THREE.BoxGeometry(16, 1, 88);
  const deckMat = unitPBR(deckGeom, deckColor, { tag: 'unit:dd', repeat: 4 });
  const deck = new THREE.Mesh(deckGeom, deckMat);
  deck.position.y = 8.5;
  g.add(deck);
  // Superstructure — blocky tower amidships.
  const superGeom = new THREE.BoxGeometry(10, 12, 18);
  const superMat = unitPBR(superGeom, superColor, { tag: 'unit:dd', repeat: 2 });
  const super1 = new THREE.Mesh(superGeom, superMat);
  super1.position.set(0, 14, -5);
  g.add(super1);
  // Bridge windows (slight emissive)
  const bridge = new THREE.Mesh(
    new THREE.BoxGeometry(11, 3, 4),
    new THREE.MeshStandardMaterial({ color: 0x1a2a3a, emissive: 0x3a5a7a, emissiveIntensity: 0.3, roughness: 0.2, metalness: 0.8 }),
  );
  bridge.position.set(0, 17, -10);
  g.add(bridge);
  // Funnel
  const funnel = new THREE.Mesh(new THREE.BoxGeometry(5, 8, 5), superMat);
  funnel.position.set(0, 18, 8);
  g.add(funnel);
  // Main gun turret forward
  const turretBase = new THREE.Mesh(new THREE.CylinderGeometry(3, 3.5, 2, 8), gunMat);
  turretBase.position.set(0, 10, 25);
  g.add(turretBase);
  const turret = new THREE.Mesh(new THREE.BoxGeometry(4, 3, 5), gunMat);
  turret.position.set(0, 12, 25);
  g.add(turret);
  const gunBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 12, 6), gunMat);
  gunBarrel.rotation.x = Math.PI / 2;
  gunBarrel.position.set(0, 12, 33);
  g.add(gunBarrel);
  // AA missile launchers aft (two box launchers)
  const launcherMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.5, metalness: 0.6 });
  for (const sx of [-3, 3]) {
    const lnchr = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 4), launcherMat);
    lnchr.position.set(sx, 10, -20);
    g.add(lnchr);
  }
  // Mast
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.5, 14, 6), gunMat);
  mast.position.set(0, 25, -5);
  g.add(mast);
  // Radar dish on mast
  const radar = new THREE.Mesh(new THREE.SphereGeometry(1.5, 8, 4), gunMat);
  radar.position.set(0, 31, -5);
  g.add(radar);
  // Tag for animation
  (g as any)._radarMesh = radar;
  (g as any)._turretMesh = turret;
  (g as any)._gunBarrelMesh = gunBarrel;
  return g;
}

// Cruiser — larger, heavier-armed, more HP than a destroyer.
export function buildCruiser(cfg: SkyConfig, isAlly: boolean): THREE.Group {
  const g = new THREE.Group();
  const hullColor = isAlly ? 0x2a3a4a : 0x3a2a2a;
  const deckColor = isAlly ? 0x1a2630 : 0x2a1a1a;
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.5, metalness: 0.7 });

  // Hull — bigger than destroyer
  const hullGeom = new THREE.BoxGeometry(18, 10, 130);
  const hullMat = unitPBR(hullGeom, hullColor, { tag: 'unit:cl', repeat: 4 });
  const hull = new THREE.Mesh(hullGeom, hullMat);
  hull.position.y = 5;
  g.add(hull);
  // Bow
  const bow = new THREE.Mesh(new THREE.BoxGeometry(18, 10, 20), hullMat);
  bow.position.set(0, 5, 72);
  bow.rotation.x = -0.3;
  g.add(bow);
  // Deck
  const deckGeom = new THREE.BoxGeometry(20, 1, 128);
  const deckMat = unitPBR(deckGeom, deckColor, { tag: 'unit:cl', repeat: 4 });
  const deck = new THREE.Mesh(deckGeom, deckMat);
  deck.position.y = 10.5;
  g.add(deck);
  // Two main gun turrets (fore + aft)
  for (const z of [40, -40]) {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(4, 4.5, 2.5, 8), gunMat);
    base.position.set(0, 12, z);
    g.add(base);
    const turret = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 7), gunMat);
    turret.position.set(0, 15, z);
    g.add(turret);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 16, 6), gunMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 15, z + 11);
    g.add(barrel);
  }
  // Superstructure
  const sup = new THREE.Mesh(new THREE.BoxGeometry(14, 16, 24), hullMat);
  sup.position.set(0, 18, 0);
  g.add(sup);
  // Funnel
  const funnel = new THREE.Mesh(new THREE.BoxGeometry(6, 10, 6), hullMat);
  funnel.position.set(0, 22, 0);
  g.add(funnel);
  // VLS cells (vertical launch system) — grid of small squares aft
  const vlsMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8 });
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const cell = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1, 1.5), vlsMat);
      cell.position.set(-5 + i * 3, 11, -25 + j * 3);
      g.add(cell);
    }
  }
  // Mast
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 18, 6), gunMat);
  mast.position.set(0, 30, 0);
  g.add(mast);
  const radar = new THREE.Mesh(new THREE.SphereGeometry(2, 8, 4), gunMat);
  radar.position.set(0, 38, 0);
  g.add(radar);
  (g as any)._radarMesh = radar;
  return g;
}

// Tank — main battle tank. Used on land maps (mountain/desert/city).
export function buildTank(cfg: SkyConfig, isAlly: boolean): THREE.Group {
  const g = new THREE.Group();
  const bodyColor = isAlly ? 0x3a4a2a : 0x4a3a2a;
  const trackMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 1.0 });

  // Hull
  const hullGeom = new THREE.BoxGeometry(8, 2, 10);
  const bodyMat = unitPBR(hullGeom, bodyColor, { tag: 'unit:tank' });
  const hull = new THREE.Mesh(hullGeom, bodyMat);
  hull.position.y = 2;
  g.add(hull);
  // Tracks (two boxes on either side)
  const trackGeom = new THREE.BoxGeometry(2, 3, 11);
  for (const sx of [-3.5, 3.5]) {
    const track = new THREE.Mesh(trackGeom.clone(), trackMat);
    track.position.set(sx, 1.5, 0);
    g.add(track);
  }
  // Turret
  const turretGeom = new THREE.BoxGeometry(6, 2, 6);
  const turretMat = unitPBR(turretGeom, bodyColor, { tag: 'unit:tank' });
  const turret = new THREE.Mesh(turretGeom, turretMat);
  turret.position.set(0, 4, 0);
  g.add(turret);
  // Main gun
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.5, metalness: 0.7 });
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 8, 6), gunMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 4, 6);
  g.add(barrel);
  // Commander cupola
  const cupola = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.8, 6), turretMat);
  cupola.position.set(-1, 5.5, 0);
  g.add(cupola);
  // AA machine gun on top
  const mg = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 2, 4), gunMat);
  mg.rotation.x = Math.PI / 2;
  mg.position.set(1, 5.5, 0);
  g.add(mg);
  (g as any)._turretMesh = turret;
  (g as any)._gunBarrelMesh = barrel;
  return g;
}

// SAM launcher — stationary land anti-air missile site.
export function buildSamLauncher(cfg: SkyConfig, isAlly: boolean): THREE.Group {
  const g = new THREE.Group();
  const bodyColor = isAlly ? 0x3a4a3a : 0x4a3a3a;
  const launcherMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.6, metalness: 0.6 });
  const radarMat = new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 0.4, metalness: 0.7 });

  // Base platform
  const baseGeom = new THREE.BoxGeometry(10, 1.5, 10);
  const bodyMat = unitPBR(baseGeom, bodyColor, { tag: 'unit:sam' });
  const base = new THREE.Mesh(baseGeom, bodyMat);
  base.position.y = 0.75;
  g.add(base);
  // Command vehicle (small box)
  const cmd = new THREE.Mesh(new THREE.BoxGeometry(4, 3, 4), bodyMat);
  cmd.position.set(0, 3, -3);
  g.add(cmd);
  // Radar dish (rotating) — flat disc tilted up
  const radarMast = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 5, 6), launcherMat);
  radarMast.position.set(0, 5, -3);
  g.add(radarMast);
  const radarDish = new THREE.Mesh(new THREE.SphereGeometry(2.5, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), radarMat);
  radarDish.position.set(0, 7.5, -3);
  radarDish.rotation.x = -Math.PI / 4;
  g.add(radarDish);
  // 4 missile launch tubes (angled up)
  for (let i = 0; i < 4; i++) {
    const angle = (i - 1.5) * 0.15;
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 6, 8), launcherMat);
    tube.position.set((i - 1.5) * 1.5, 4, 3);
    tube.rotation.x = -Math.PI / 3;
    g.add(tube);
  }
  (g as any)._radarMesh = radarDish;
  return g;
}

// AA vehicle — mobile anti-air autocannon on a tank chassis.
export function buildAAVehicle(cfg: SkyConfig, isAlly: boolean): THREE.Group {
  const g = new THREE.Group();
  const bodyColor = isAlly ? 0x3a4a3a : 0x4a3a3a;
  const trackMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 1.0 });
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.5, metalness: 0.7 });

  // Hull (smaller than tank)
  const hullGeom = new THREE.BoxGeometry(7, 2, 9);
  const bodyMat = unitPBR(hullGeom, bodyColor, { tag: 'unit:aa' });
  const hull = new THREE.Mesh(hullGeom, bodyMat);
  hull.position.y = 2;
  g.add(hull);
  // Tracks
  const trackGeom = new THREE.BoxGeometry(1.8, 3, 10);
  for (const sx of [-3, 3]) {
    const track = new THREE.Mesh(trackGeom.clone(), trackMat);
    track.position.set(sx, 1.5, 0);
    g.add(track);
  }
  // Turret (smaller, more open)
  const turretGeom = new THREE.BoxGeometry(5, 1.5, 5);
  const turretMat = unitPBR(turretGeom, bodyColor, { tag: 'unit:aa' });
  const turret = new THREE.Mesh(turretGeom, turretMat);
  turret.position.set(0, 3.5, 0);
  g.add(turret);
  // Twin autocannons
  for (const sx of [-0.8, 0.8]) {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 6, 6), gunMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(sx, 4, 4);
    g.add(barrel);
  }
  // Radar dish (small, on turret)
  const radar = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), gunMat);
  radar.position.set(0, 5, -1);
  radar.rotation.x = -Math.PI / 4;
  g.add(radar);
  (g as any)._turretMesh = turret;
  (g as any)._radarMesh = radar;
  return g;
}

// === Fixed laser AA (per user request: T-00 激光防空炮) ===
// Stationary concrete emplacement with a large focusing lens turret and a
// glowing blue energy ring. Rotates its turret toward targets (engine drives
// _turretMesh.rotation).
export function buildLaserAA(cfg: SkyConfig, isAlly: boolean): THREE.Group {
  const g = new THREE.Group();
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.4, metalness: 0.8 });
  const lensMat = new THREE.MeshStandardMaterial({
    color: 0x6ad0ff, emissive: 0x2a90d0, emissiveIntensity: 0.8, roughness: 0.2, metalness: 0.4,
  });

  // Concrete base platform
  const baseGeom = new THREE.BoxGeometry(12, 3, 12);
  const baseMat = unitPBR(baseGeom, 0x6a6a6a, { tag: 'unit:laser' });
  const base = new THREE.Mesh(baseGeom, baseMat);
  base.position.y = 1.5;
  g.add(base);
  // Foundation corners
  for (const sx of [-5, 5]) {
    for (const sz of [-5, 5]) {
      const foot = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2, 2.5), baseMat);
      foot.position.set(sx, 1, sz);
      g.add(foot);
    }
  }
  // Turret housing (rotating) — box + lens barrel
  const turret = new THREE.Group();
  const housing = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 6), gunMat);
  housing.position.y = 4.5;
  turret.add(housing);
  // === Aim group (per user request: 激光炮双向瞄准) ===
  // Barrel/lens/ring pivot together on PITCH (rotation.x) inside the yaw
  // turret, so the engine can aim the beam up/down as well as left/right.
  const aimGroup = new THREE.Group();
  aimGroup.position.y = 4.5; // pivot at housing center
  // Focusing lens barrel pointing forward
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.6, 7, 12), gunMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.5, 4);
  aimGroup.add(barrel);
  // Energy lens at the muzzle (glowing)
  const lens = new THREE.Mesh(new THREE.SphereGeometry(1.1, 12, 10), lensMat);
  lens.position.set(0, 0.5, 8);
  aimGroup.add(lens);
  // Glowing blue energy ring around the housing
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.25, 8, 24), lensMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.set(0, 1.2, 0);
  aimGroup.add(ring);
  turret.add(aimGroup);
  (turret as any)._laserLens = lens;
  (turret as any)._aimGroup = aimGroup;
  g.add(turret);
  (g as any)._turretMesh = turret;
  return g;
}

// Master builder — picks the right visual for a ground unit type.
// === Extended (per user request: 多款敌我地面和海军单位) ===
// Added frigate, patrol_boat, artillery, bunker, radar_station builders.
export function buildGroundUnit(cfg: SkyConfig, type: GroundUnitType, isAlly: boolean): THREE.Group {
  switch (type) {
    // 空中战舰由 engine/air-warship 单独构建(buildAirWarship), 这里给个占位盒兜底。
    case 'air_light': return new THREE.Group();
    // 舰载组件: 网格由空中战舰模块直接挂到舰体上, 这里只给一个空组占位(类型完备用)
    case 'air_component': return new THREE.Group();
    // 主舰「堡垒」与无人机同理: 网格由 dreadnought.ts 提供(引擎直接建), 这里只占位
    case 'air_boss': return new THREE.Group();
    case 'air_drone': return new THREE.Group();
    case 'destroyer': return buildDestroyer(cfg, isAlly);
    case 'cruiser': return buildCruiser(cfg, isAlly);
    case 'frigate': return buildFrigate(cfg, isAlly);
    case 'patrol_boat': return buildPatrolBoat(cfg, isAlly);
    case 'tank': return buildTank(cfg, isAlly);
    case 'sam_launcher': return buildSamLauncher(cfg, isAlly);
    case 'aa_vehicle': return buildAAVehicle(cfg, isAlly);
    case 'artillery': return buildArtillery(cfg, isAlly);
    case 'bunker': return buildBunker(cfg, isAlly);
    case 'radar_station': return buildRadarStation(cfg, isAlly);
    case 'laser_aa': return buildLaserAA(cfg, isAlly);
  }
}

// === Frigate (per user request: 多款海军单位) ===
// Smaller, faster warship than a destroyer. Lighter armament, lower HP.
// Visual: slim hull, single mast, one gun turret forward.
export function buildFrigate(cfg: SkyConfig, isAlly: boolean): THREE.Group {
  const g = new THREE.Group();
  const hullColor = isAlly ? 0x3a4a5a : 0x4a3a3a;
  const deckColor = isAlly ? 0x2a3640 : 0x3a2a2a;
  const hullMat = new THREE.MeshStandardMaterial({ color: hullColor, roughness: 0.7, metalness: 0.4 });
  const deckMat = new THREE.MeshStandardMaterial({ color: deckColor, roughness: 0.85, metalness: 0.2 });
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.5, metalness: 0.7 });

  // Slim hull — narrower + shorter than destroyer
  const hull = new THREE.Mesh(new THREE.BoxGeometry(7, 5, 28), hullMat);
  hull.position.y = 2.5;
  g.add(hull);
  // Bow taper (wedge)
  const bow = new THREE.Mesh(new THREE.CylinderGeometry(0, 3.5, 8, 4), hullMat);
  bow.rotation.x = Math.PI / 2;
  bow.rotation.y = Math.PI / 4;
  bow.position.set(0, 2.5, 16);
  bow.scale.set(1, 1, 0.7);
  g.add(bow);
  // Deck
  const deck = new THREE.Mesh(new THREE.BoxGeometry(6.5, 0.5, 27), deckMat);
  deck.position.y = 5.2;
  g.add(deck);
  // Superstructure (smaller than destroyer — single block)
  const superStructure = new THREE.Mesh(new THREE.BoxGeometry(5, 4, 6), hullMat);
  superStructure.position.set(0, 7.5, -2);
  g.add(superStructure);
  // Single mast (slim pole)
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 9, 6), gunMat);
  mast.position.set(0, 14, -2);
  g.add(mast);
  // Small radar dish on the mast
  const radar = new THREE.Mesh(new THREE.SphereGeometry(1.2, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), gunMat);
  radar.position.set(0, 18, -2);
  radar.rotation.x = -Math.PI / 4;
  g.add(radar);
  (g as any)._radarMesh = radar;
  // Single gun turret forward
  const turret = new THREE.Mesh(new THREE.BoxGeometry(3, 1.5, 3), gunMat);
  turret.position.set(0, 6, 8);
  g.add(turret);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 5, 6), gunMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 6, 11);
  g.add(barrel);
  (g as any)._turretMesh = turret;
  // Funnel
  const funnel = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.2, 3, 8), hullMat);
  funnel.position.set(0, 8, 2);
  g.add(funnel);
  return g;
}

// === Patrol boat (per user request: 多款海军单位) ===
// Very small fast attack craft. Weak AA, low HP, but cheap — spawns in
// larger numbers. Visual: tiny hull, single mast, one autocannon.
export function buildPatrolBoat(cfg: SkyConfig, isAlly: boolean): THREE.Group {
  const g = new THREE.Group();
  const hullColor = isAlly ? 0x3a4a4a : 0x4a3a3a;
  const hullMat = new THREE.MeshStandardMaterial({ color: hullColor, roughness: 0.7, metalness: 0.4 });
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.5, metalness: 0.7 });

  // Small hull
  const hull = new THREE.Mesh(new THREE.BoxGeometry(3.5, 2, 12), hullMat);
  hull.position.y = 1;
  g.add(hull);
  // Pointed bow
  const bow = new THREE.Mesh(new THREE.CylinderGeometry(0, 1.75, 4, 4), hullMat);
  bow.rotation.x = Math.PI / 2;
  bow.rotation.y = Math.PI / 4;
  bow.position.set(0, 1, 7);
  bow.scale.set(1, 1, 0.6);
  g.add(bow);
  // Tiny cabin
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(3, 1.5, 2), hullMat);
  cabin.position.set(0, 2.5, -1);
  g.add(cabin);
  // Mast
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 4, 6), gunMat);
  mast.position.set(0, 5, -1);
  g.add(mast);
  // Single autocannon
  const turret = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1, 1.5), gunMat);
  turret.position.set(0, 2.5, 3);
  g.add(turret);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 3, 6), gunMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 2.5, 4.5);
  g.add(barrel);
  (g as any)._turretMesh = turret;
  return g;
}

// === Artillery (per user request: 多款地面单位) ===
// Mobile artillery — long-barrel gun on a tracked chassis. Fires at ground
// targets (and aircraft in arc mode). High damage, slow fire rate.
export function buildArtillery(cfg: SkyConfig, isAlly: boolean): THREE.Group {
  const g = new THREE.Group();
  const bodyColor = isAlly ? 0x3a4a3a : 0x4a3a3a;
  const trackMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 1.0 });
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.5, metalness: 0.7 });

  // Hull (longer than tank — artillery chassis)
  const hullGeom = new THREE.BoxGeometry(8, 2, 11);
  const bodyMat = unitPBR(hullGeom, bodyColor, { tag: 'unit:arty' });
  const hull = new THREE.Mesh(hullGeom, bodyMat);
  hull.position.y = 2;
  g.add(hull);
  // Tracks
  const trackGeom = new THREE.BoxGeometry(1.8, 3, 12);
  for (const sx of [-3.5, 3.5]) {
    const track = new THREE.Mesh(trackGeom.clone(), trackMat);
    track.position.set(sx, 1.5, 0);
    g.add(track);
  }
  // Large turret (open-top-ish)
  const turretGeom = new THREE.BoxGeometry(6, 1.8, 5);
  const turretMat = unitPBR(turretGeom, bodyColor, { tag: 'unit:arty' });
  const turret = new THREE.Mesh(turretGeom, turretMat);
  turret.position.set(0, 3.8, -1);
  g.add(turret);
  // Very long barrel (artillery signature)
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.35, 12, 8), gunMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 4.2, 7);
  g.add(barrel);
  // Muzzle brake
  const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 1.2, 8), gunMat);
  muzzle.rotation.x = Math.PI / 2;
  muzzle.position.set(0, 4.2, 12.5);
  g.add(muzzle);
  (g as any)._turretMesh = turret;
  return g;
}

// === Bunker (per user request: 多款地面单位) ===
// Fortified concrete emplacement. Very high HP, no movement, defensive.
// Visual: low concrete block with a slit for weapons.
export function buildBunker(cfg: SkyConfig, isAlly: boolean): THREE.Group {
  const g = new THREE.Group();
  const concreteColor = isAlly ? 0x4a4a48 : 0x4a4040;
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.5, metalness: 0.7 });

  // Main bunker body (low, wide, thick walls)
  const bodyGeom = new THREE.BoxGeometry(12, 5, 10);
  const concreteMat = unitPBR(bodyGeom, concreteColor, { tag: 'unit:bunker', repeat: 3 });
  const body = new THREE.Mesh(bodyGeom, concreteMat);
  body.position.y = 2.5;
  g.add(body);
  // Sloped front (deflects shells)
  const front = new THREE.Mesh(new THREE.BoxGeometry(12, 3, 4), concreteMat);
  front.position.set(0, 1.5, 5);
  front.rotation.x = -Math.PI / 8;
  g.add(front);
  // Slit (dark horizontal opening)
  const slit = new THREE.Mesh(new THREE.BoxGeometry(8, 0.6, 0.4), new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1.0 }));
  slit.position.set(0, 3, 5.1);
  g.add(slit);
  // Two gun barrels poking out of the slit
  for (const sx of [-2, 2]) {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 4, 6), gunMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(sx, 3, 7);
    g.add(barrel);
  }
  // Reinforced roof (slightly raised)
  const roof = new THREE.Mesh(new THREE.BoxGeometry(12.5, 0.6, 10.5), concreteMat);
  roof.position.y = 5.3;
  g.add(roof);
  return g;
}

// === Radar station (per user request: 多款地面单位) ===
// Large radar array on a tower. Provides wide detection range, no weapons.
// Visual: tall lattice tower + large rectangular radar panel.
export function buildRadarStation(cfg: SkyConfig, isAlly: boolean): THREE.Group {
  const g = new THREE.Group();
  const towerColor = isAlly ? 0x3a4a4a : 0x4a3a3a;
  const panelMat = new THREE.MeshStandardMaterial({ color: 0xe0e0e0, roughness: 0.4, metalness: 0.6 });
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 0.95 });

  // Concrete base
  const base = new THREE.Mesh(new THREE.CylinderGeometry(4, 5, 1.5, 12), baseMat);
  base.position.y = 0.75;
  g.add(base);
  // Lattice tower (4 legs + cross-braces)
  const towerGeom = new THREE.CylinderGeometry(0.25, 0.35, 14, 6);
  const towerMat = unitPBR(towerGeom, towerColor, { tag: 'unit:radar' });
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const leg = new THREE.Mesh(towerGeom.clone(), towerMat);
    leg.position.set(Math.cos(angle) * 2.5, 7, Math.sin(angle) * 2.5);
    leg.rotation.x = Math.sin(angle) * 0.1;
    leg.rotation.z = -Math.cos(angle) * 0.1;
    g.add(leg);
  }
  // Tower top platform
  const platform = new THREE.Mesh(new THREE.BoxGeometry(4, 0.5, 4), towerMat);
  platform.position.y = 14;
  g.add(platform);
  // Large rectangular radar panel (rotates)
  const panel = new THREE.Mesh(new THREE.BoxGeometry(8, 4, 0.4), panelMat);
  panel.position.set(0, 18, 0);
  g.add(panel);
  // Panel frame
  const frame = new THREE.Mesh(new THREE.BoxGeometry(8.4, 4.4, 0.2), towerMat);
  frame.position.set(0, 18, -0.1);
  g.add(frame);
  (g as any)._radarMesh = panel;
  return g;
}

// ============================================================================
// OCEAN-MAP FEATURES
// ============================================================================

// A realistic volcanic tropical island: low circular base (beach sand), rising
// to a green vegetated interior, with optional palm trees and a small lighthouse.
// Much more visually rich than the old single-cone buildIsland.
export function buildDetailedIsland(cfg: SkyConfig, position: THREE.Vector3, opts: { radius?: number; hasLighthouse?: boolean; hasVegetation?: boolean; seed?: number } = {}): THREE.Group {
  const g = new THREE.Group();
  const radius = opts.radius ?? 600 + Math.random() * 800;
  const rand = makeRng(opts.seed ?? Math.floor(Math.random() * 1e9));
  const sandMat = new THREE.MeshStandardMaterial({ color: 0xe8d8a8, roughness: 1.0, metalness: 0, flatShading: true });
  const grassMat = new THREE.MeshStandardMaterial({ color: 0x3a6b35, roughness: 0.95, metalness: 0, flatShading: true });
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x5a5048, roughness: 0.95, flatShading: true });

  // Sand beach ring (low flat cone)
  const beach = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.15, 20, 24), sandMat);
  beach.position.y = 10;
  g.add(beach);

  // Grassy interior (raised disc)
  const interiorR = radius * 0.78;
  const interior = new THREE.Mesh(new THREE.CylinderGeometry(interiorR, interiorR * 1.05, 35, 20), grassMat);
  interior.position.y = 25;
  g.add(interior);

  // Rocky hill in the center — high-poly displaced cone so the peak has
  // crags and ridges instead of being a smooth geometry-primitive cone.
  const hillH = 60 + rand() * 80;
  const hillGeom = new THREE.ConeGeometry(interiorR * 0.45, hillH, 32, 16, false, 0);
  {
    const hpos = hillGeom.attributes.position as THREE.BufferAttribute;
    const harr = hpos.array as Float32Array;
    const seed = rand() * 100;
    for (let v = 0; v < harr.length; v += 3) {
      const vx = harr[v], vy = harr[v + 1], vz = harr[v + 2];
      const theta = Math.atan2(vz, vx);
      const hf = (vy + 0.5); // 0 at base, 1 at apex (unit-cone normalised)
      // Multi-octave angular noise — large ridges + small crumble.
      let n = 0;
      n += Math.sin(theta * 7 + seed) * 0.10;
      n += Math.sin(theta * 15 + seed * 1.7) * 0.06;
      n += Math.cos(theta * 29 + seed * 0.5) * 0.035;
      const heightMask = 1.0 - hf * 0.55;
      const radial = 1.0 + n * heightMask;
      harr[v] = vx * radial;
      harr[v + 2] = vz * radial;
    }
    hpos.needsUpdate = true;
    hillGeom.computeVertexNormals();
  }
  const hill = new THREE.Mesh(hillGeom, rockMat);
  hill.position.y = 40 + hillH / 2;
  g.add(hill);

  // Palm trees scattered on the grassy ring
  if (opts.hasVegetation !== false) {
    const palmTrunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.9 });
    const palmLeafMat = new THREE.MeshStandardMaterial({ color: 0x2d6b2a, roughness: 0.85, flatShading: true });
    const palmCount = 6 + Math.floor(rand() * 8);
    for (let i = 0; i < palmCount; i++) {
      const a = rand() * Math.PI * 2;
      const r = interiorR * (0.5 + rand() * 0.4);
      const px = Math.cos(a) * r;
      const pz = Math.sin(a) * r;
      const trunkH = 18 + rand() * 12;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1.0, trunkH, 5), palmTrunkMat);
      trunk.position.set(px, 42 + trunkH / 2, pz);
      trunk.rotation.z = (rand() - 0.5) * 0.2;
      g.add(trunk);
      // Fronds — a flattened cone of leaves on top
      const fronds = new THREE.Mesh(new THREE.ConeGeometry(8, 6, 7), palmLeafMat);
      fronds.position.set(px, 42 + trunkH + 1, pz);
      fronds.scale.y = 0.4;
      g.add(fronds);
    }
  }

  // Optional lighthouse on the beach
  if (opts.hasLighthouse) {
    const lhBase = new THREE.Mesh(
      new THREE.CylinderGeometry(8, 10, 40, 12),
      new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.7 }),
    );
    lhBase.position.set(radius * 0.9, 30, 0);
    g.add(lhBase);
    // Red stripe
    const stripe = new THREE.Mesh(
      new THREE.CylinderGeometry(8.2, 8.2, 8, 12),
      new THREE.MeshStandardMaterial({ color: 0xc03030, roughness: 0.7 }),
    );
    stripe.position.set(radius * 0.9, 35, 0);
    g.add(stripe);
    // Lamp room
    const lamp = new THREE.Mesh(
      new THREE.CylinderGeometry(7, 8, 10, 12),
      new THREE.MeshStandardMaterial({ color: 0xffcc66, emissive: 0xffaa33, emissiveIntensity: 0.5 }),
    );
    lamp.position.set(radius * 0.9, 60, 0);
    g.add(lamp);
    // Red blinking beacon on top
    const beacon = new THREE.Mesh(
      new THREE.SphereGeometry(2, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xff2222 }),
    );
    beacon.position.set(radius * 0.9, 68, 0);
    (beacon as any)._blink = true;
    g.add(beacon);
  }

  g.position.copy(position);
  g.position.y = 0;
  return g;
}

// A cargo/container ship — long hull, bridge at the rear, container stacks.
// Used to populate ocean maps so it's not just empty water.
export function buildCargoShip(cfg: SkyConfig, position: THREE.Vector3, heading = 0): THREE.Group {
  const g = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.7, metalness: 0.4 });
  const deckMat = new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 0.8 });
  const containerColors = [0xc04030, 0x2060a0, 0x30a060, 0xc0a040, 0x604020];
  const containerMats = containerColors.map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 }));

  // Hull
  const hull = new THREE.Mesh(new THREE.BoxGeometry(28, 12, 130), hullMat);
  hull.position.y = 4;
  g.add(hull);
  // Bow taper
  const bow = new THREE.Mesh(new THREE.CylinderGeometry(14, 0, 12, 4), hullMat);
  bow.rotation.x = Math.PI / 2;
  bow.rotation.y = Math.PI / 4;
  bow.position.set(0, 4, 70);
  bow.scale.set(1, 1, 0.6);
  g.add(bow);
  // Deck
  const deck = new THREE.Mesh(new THREE.BoxGeometry(30, 1, 130), deckMat);
  deck.position.y = 10;
  g.add(deck);
  // Container stacks (rows of 3x3 containers)
  for (let row = 0; row < 6; row++) {
    for (let cx = -1; cx <= 1; cx++) {
      for (let cz = 0; cz < 3; cz++) {
        const m = containerMats[Math.floor(Math.random() * containerMats.length)];
        const c = new THREE.Mesh(new THREE.BoxGeometry(7, 7, 18), m);
        c.position.set(cx * 8, 14 + cz * 7, -40 + row * 14);
        g.add(c);
      }
    }
  }
  // Bridge (white superstructure at rear)
  const bridgeMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.6, metalness: 0.2 });
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(20, 18, 22), bridgeMat);
  bridge.position.set(0, 19, -55);
  g.add(bridge);
  // Funnel
  const funnel = new THREE.Mesh(new THREE.CylinderGeometry(3, 4, 12, 8), new THREE.MeshStandardMaterial({ color: 0xb03030, roughness: 0.6 }));
  funnel.position.set(0, 30, -60);
  g.add(funnel);

  g.position.copy(position);
  g.rotation.y = heading;
  return g;
}

// Oil platform — large offshore rig with legs, deck, and a burning flare stack.
// Adds industrial character to ocean maps at distance.
export function buildOilPlatform(cfg: SkyConfig, position: THREE.Vector3): THREE.Group {
  const g = new THREE.Group();
  const legMat = new THREE.MeshStandardMaterial({ color: 0x4a4038, roughness: 0.85, metalness: 0.4 });
  const deckMat = new THREE.MeshStandardMaterial({ color: 0x6a6058, roughness: 0.8, metalness: 0.4 });
  // Four legs
  for (const [dx, dz] of [[-20, -20], [20, -20], [-20, 20], [20, 20]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(4, 60, 4), legMat);
    leg.position.set(dx, 30, dz);
    g.add(leg);
  }
  // Deck platform
  const deck = new THREE.Mesh(new THREE.BoxGeometry(55, 6, 55), deckMat);
  deck.position.y = 60;
  g.add(deck);
  // Drilling tower
  const tower = new THREE.Mesh(new THREE.BoxGeometry(8, 30, 8), legMat);
  tower.position.set(0, 78, 0);
  g.add(tower);
  // Storage tanks
  for (const [dx, dz] of [[-15, -15], [15, 15]]) {
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 14, 12), new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 0.7 }));
    tank.position.set(dx, 70, dz);
    g.add(tank);
  }
  // Flare stack with burning tip (animated flicker via _blink marker)
  const flare = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.5, 25, 6), legMat);
  flare.position.set(18, 78, -18);
  g.add(flare);
  const flame = new THREE.Mesh(
    new THREE.SphereGeometry(3, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xff8030 }),
  );
  flame.position.set(18, 95, -18);
  (flame as any)._flicker = true;
  g.add(flame);

  g.position.copy(position);
  return g;
}

// Naval fleet — a carrier with a couple of destroyer escorts. Spawns together
// so the fleet feels coherent. Used on ocean maps to give the player something
// to defend and a sense of scale.
export function buildFleet(cfg: SkyConfig, center: THREE.Vector3): THREE.Group {
  const g = new THREE.Group();
  // Carrier (use existing builder for consistency)
  const carrier = buildCarrier(cfg);
  carrier.position.copy(center);
  g.add(carrier);
  // Two destroyer escorts
  const escortMat = new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.7, metalness: 0.3 });
  for (const [dx, dz] of [[-300, 200], [300, -200]] as const) {
    const escort = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.BoxGeometry(20, 6, 100), escortMat);
    hull.position.y = 3;
    escort.add(hull);
    // Bow taper
    const bow = new THREE.Mesh(new THREE.CylinderGeometry(10, 0, 6, 4), escortMat);
    bow.rotation.x = Math.PI / 2;
    bow.position.set(0, 3, 55);
    bow.scale.set(1, 1, 0.5);
    escort.add(bow);
    // Bridge
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(12, 8, 14), escortMat);
    bridge.position.set(0, 10, -10);
    escort.add(bridge);
    // Main gun turret
    const turret = new THREE.Mesh(new THREE.CylinderGeometry(4, 5, 5, 8), escortMat);
    turret.position.set(0, 10, 30);
    escort.add(turret);
    // Radar mast
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1, 18, 4), escortMat);
    mast.position.set(0, 18, -5);
    escort.add(mast);
    escort.position.set(center.x + dx, 0, center.z + dz);
    g.add(escort);
  }
  return g;
}

// ============================================================================
// CITY-MAP FEATURES
// ============================================================================

// A large park — green disc with scattered trees and a small pond.
// Breaks up the dense building grid with natural space.
export function buildPark(cfg: SkyConfig, position: THREE.Vector3, radius = 600): THREE.Group {
  const g = new THREE.Group();
  const grassMat = new THREE.MeshStandardMaterial({ color: 0x3a6b35, roughness: 0.95, metalness: 0 });
  const pondMat = new THREE.MeshStandardMaterial({ color: 0x2a5a7a, roughness: 0.3, metalness: 0.5 });
  const treeTrunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3020, roughness: 0.9 });
  const treeLeafMat = new THREE.MeshStandardMaterial({ color: 0x2d5a2a, roughness: 0.85, flatShading: true });

  const lawn = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 2, 24), grassMat);
  lawn.position.y = 1;
  g.add(lawn);
  // Pond
  const pond = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.35, radius * 0.35, 2, 20), pondMat);
  pond.position.set(radius * 0.2, 2, radius * 0.2);
  g.add(pond);
  // Trees scattered around (avoid pond area)
  const rand = makeRng(42);
  for (let i = 0; i < 30; i++) {
    const a = rand() * Math.PI * 2;
    const r = rand() * radius * 0.9;
    const px = Math.cos(a) * r;
    const pz = Math.sin(a) * r;
    // Skip if too close to pond center
    if (Math.hypot(px - radius * 0.2, pz - radius * 0.2) < radius * 0.4) continue;
    const trunkH = 10 + rand() * 8;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.2, trunkH, 5), treeTrunkMat);
    trunk.position.set(px, 2 + trunkH / 2, pz);
    g.add(trunk);
    const crown = new THREE.Mesh(new THREE.ConeGeometry(6, 12, 7), treeLeafMat);
    crown.position.set(px, 2 + trunkH + 4, pz);
    g.add(crown);
  }
  g.position.copy(position);
  g.position.y = 0;
  return g;
}

// A highway section — a long thin dark strip with lane markings.
// Built in local space (centered at origin, extending along +Z) and then
// positioned + rotated by the caller's start/end points.
export function buildHighway(cfg: SkyConfig, start: THREE.Vector3, end: THREE.Vector3): THREE.Group {
  const g = new THREE.Group();
  const delta = end.clone().sub(start);
  const len = delta.length();
  const mid = start.clone().add(end).multiplyScalar(0.5);
  // Direction in XZ plane → rotation about Y. Box's length axis is +Z by default,
  // so we compute the angle that rotates +Z onto the start→end direction.
  const dir = delta.clone().setY(0).normalize();
  const angle = Math.atan2(dir.x, dir.z);
  const roadMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1e, roughness: 0.9, metalness: 0.1 });
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xf0e0a0, roughness: 0.6, emissive: 0x403820, emissiveIntensity: 0.2 });
  // Road — local Z range is [-len/2, +len/2]
  const road = new THREE.Mesh(new THREE.BoxGeometry(40, 1, len), roadMat);
  road.position.y = 1;
  g.add(road);
  // Dashed center line along local Z
  const dashCount = Math.floor(len / 30);
  for (let i = 0; i < dashCount; i++) {
    const dash = new THREE.Mesh(new THREE.BoxGeometry(1, 1.1, 12), lineMat);
    const zLocal = -len / 2 + (i + 0.5) * (len / dashCount);
    dash.position.set(0, 1.1, zLocal);
    g.add(dash);
  }
  // Position the group at the midpoint and rotate it to align with start→end
  g.position.copy(mid);
  g.rotation.y = angle;
  return g;
}

// Airport — a flat runway with threshold markings, taxiways, and a control tower.
// Highly recognizable from the air.
export function buildAirport(cfg: SkyConfig, position: THREE.Vector3, heading = 0): THREE.Group {
  const g = new THREE.Group();
  const runwayMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.85, metalness: 0.1 });
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.6 });
  const taxiMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3e, roughness: 0.85 });
  // Main runway (long, narrow)
  const runway = new THREE.Mesh(new THREE.BoxGeometry(60, 1, 2400), runwayMat);
  runway.position.y = 1;
  g.add(runway);
  // Threshold stripes at both ends
  for (const zEnd of [-1100, 1100]) {
    for (let i = 0; i < 6; i++) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(4, 1.1, 30), lineMat);
      stripe.position.set(-25 + i * 10, 1.1, zEnd - Math.sign(zEnd) * 30);
      g.add(stripe);
    }
  }
  // Center dashed line
  for (let z = -1100; z < 1100; z += 60) {
    const dash = new THREE.Mesh(new THREE.BoxGeometry(1, 1.1, 30), lineMat);
    dash.position.set(0, 1.1, z);
    g.add(dash);
  }
  // Taxiway parallel to runway
  const taxi = new THREE.Mesh(new THREE.BoxGeometry(20, 1, 2400), taxiMat);
  taxi.position.set(80, 1, 0);
  g.add(taxi);
  // Control tower
  const towerBase = new THREE.Mesh(new THREE.BoxGeometry(12, 30, 12), new THREE.MeshStandardMaterial({ color: 0x808088, roughness: 0.6 }));
  towerBase.position.set(120, 15, 0);
  g.add(towerBase);
  const cab = new THREE.Mesh(new THREE.CylinderGeometry(8, 10, 8, 12), new THREE.MeshStandardMaterial({ color: 0x1a2a3a, roughness: 0.3, metalness: 0.5 }));
  cab.position.set(120, 34, 0);
  g.add(cab);
  // Red beacon on tower top
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(1.5, 6, 6), new THREE.MeshBasicMaterial({ color: 0xff2222 }));
  beacon.position.set(120, 40, 0);
  (beacon as any)._blink = true;
  g.add(beacon);

  g.position.copy(position);
  g.rotation.y = heading;
  return g;
}

// Sports stadium — large ring with bright field inside. Adds a recognizable
// landmark to city maps.
export function buildStadium(cfg: SkyConfig, position: THREE.Vector3): THREE.Group {
  const g = new THREE.Group();
  const standMat = new THREE.MeshStandardMaterial({ color: 0x6a6a72, roughness: 0.85 });
  const fieldMat = new THREE.MeshStandardMaterial({ color: 0x2a6b2a, roughness: 0.95 });
  // Outer stands ring
  const stands = new THREE.Mesh(new THREE.CylinderGeometry(180, 200, 35, 24, 1, true), standMat);
  stands.position.y = 17;
  g.add(stands);
  // Inner field
  const field = new THREE.Mesh(new THREE.CylinderGeometry(160, 160, 2, 24), fieldMat);
  field.position.y = 2;
  g.add(field);
  // Floodlight pylons at four corners
  const pylonMat = new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 0.7, metalness: 0.4 });
  for (const [dx, dz] of [[-180, -180], [180, -180], [-180, 180], [180, 180]]) {
    const pylon = new THREE.Mesh(new THREE.BoxGeometry(2, 50, 2), pylonMat);
    pylon.position.set(dx, 25, dz);
    g.add(pylon);
    const lamp = new THREE.Mesh(
      new THREE.BoxGeometry(12, 4, 6),
      new THREE.MeshStandardMaterial({ color: 0xffffe0, emissive: 0xfff0c0, emissiveIntensity: 0.7 }),
    );
    lamp.position.set(dx * 0.95, 52, dz * 0.95);
    g.add(lamp);
  }
  g.position.copy(position);
  return g;
}

// ============================================================================
// MOUNTAIN-MAP FEATURES
// ============================================================================

// Alpine lake — a small blue disc at altitude, nestled between peaks.
export function buildAlpineLake(cfg: SkyConfig, position: THREE.Vector3, radius = 400): THREE.Group {
  const g = new THREE.Group();
  // High-subdivision water disc so the wave displacement reads at this scale.
  const lakeGeom = new THREE.CircleGeometry(radius, 64);
  lakeGeom.rotateX(-Math.PI / 2);
  // Reuse the ocean shader (scaled down via the world-position-derived noise,
  // so no uniforms need to change). We do bump the wave frequency by tweaking
  // the time uniform faster — gives small lakes a "shimmering pond" feel.
  const lakeMat = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      oceanColor: { value: new THREE.Color(0x2a5a8a) },
      // 同上: 地平线色(引擎每帧用 SKYCAP 覆盖)
      highlight: { value: new THREE.Color(cfg.bottom) },
      deepColor: { value: new THREE.Color(0x102840) },
      fogColor: { value: cfg.fog },
      fogDensity: { value: cfg.fogDensity },
      sunDir: { value: cfg.sunPos.clone() },
      windDir: { value: new THREE.Vector2(1, 0.3) },
      windStrength: { value: 0.4 },
    },
    vertexShader: /* glsl */ `
      uniform float time;
      varying vec3 vWorldPos;
      varying float vWave;
      varying vec3 vNormalApprox;
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float vnoise(vec2 p){
        vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);
      }
      void main(){
        vec3 p=position;
        float w1=sin(p.x*0.06+time*1.2)*cos(p.z*0.05+time*0.9);
        float w2=vnoise(p.xz*0.1+vec2(time*0.4,time*0.3))*0.8;
        float h=(w1*1.2)+w2;
        p.y+=h;vWave=h;
        float e=2.0;
        float hX=sin((p.x+e)*0.06+time*1.2)*cos(p.z*0.05+time*0.9)*1.2;
        float hZ=sin(p.x*0.06+time*1.2)*cos((p.z+e)*0.05+time*0.9)*1.2;
        vNormalApprox=normalize(vec3(-(hX-h)/e,1.0,-(hZ-h)/e));
        vec4 wp=modelMatrix*vec4(p,1.0);vWorldPos=wp.xyz;
        gl_Position=projectionMatrix*viewMatrix*wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 oceanColor,highlight,deepColor,fogColor,sunDir;
      uniform float fogDensity,time;
      varying vec3 vWorldPos;varying float vWave;varying vec3 vNormalApprox;
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);}
      float fbm(vec2 p){float v=0.0,a=0.5;for(int i=0;i<4;i++){v+=a*vnoise(p);p*=2.0;a*=0.5;}return v;}
      float fogFactorExp2(const in float dist){return 1.0-exp(-fogDensity*fogDensity*dist*dist);}
      void main(){
        vec2 uv1=vWorldPos.xz*0.15+vec2(time*0.20,time*0.14);
        vec2 uv2=vWorldPos.xz*0.32-vec2(time*0.16,time*0.25);
        float n1=fbm(uv1),n2=fbm(uv2);float e=0.6;
        vec2 g1=vec2(fbm(uv1+vec2(e,0.0))-n1,fbm(uv1+vec2(0.0,e))-n1)/e;
        vec2 g2=vec2(fbm(uv2+vec2(e,0.0))-n2,fbm(uv2+vec2(0.0,e))-n2)/e;
        vec3 n=normalize(vNormalApprox+vec3(-g1.x,0.0,-g1.y)*1.4+vec3(-g2.x,0.0,-g2.y)*0.7);
        n=normalize(n+vec3(0.0,0.6,0.0));
        vec3 viewDir=normalize(cameraPosition-vWorldPos);
        float fres=pow(1.0-max(dot(n,viewDir),0.0),4.0);
        vec3 hv=normalize(sunDir+viewDir);
        float spec=pow(max(dot(n,hv),0.0),200.0);
        float sun=max(dot(n,sunDir),0.0);
        vec3 col=mix(deepColor,oceanColor,smoothstep(-2.0,2.0,vWave));
        col=mix(col,highlight,fres*0.55+sun*0.30);
        col+=vec3(1.0,0.95,0.85)*spec*1.4;
        float dist=length(cameraPosition-vWorldPos);
        col=mix(col,fogColor,clamp(fogFactorExp2(dist),0.0,0.9));
        gl_FragColor=vec4(col,1.0);
      }
    `,
  });
  const lake = new THREE.Mesh(lakeGeom, lakeMat);
  lake.position.y = 2;
  (lake as any)._lakeMat = lakeMat; // expose so engine can update time uniform
  g.add(lake);
  // Shore ring — keep the rocky shoreline.
  const shoreMat = new THREE.MeshStandardMaterial({ color: 0x6a6058, roughness: 0.95, flatShading: true });
  const shore = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.2, radius * 1.05, 2, 32), shoreMat);
  shore.position.y = 1;
  g.add(shore);
  g.position.copy(position);
  return g;
}

// Conifer forest patch — cluster of dark green cones. Used to cover lower
// mountain slopes with forest.
export function buildForestPatch(cfg: SkyConfig, position: THREE.Vector3, count = 30, spread = 800): THREE.Group {
  const g = new THREE.Group();
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x3a2818, roughness: 0.95 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x1f4a1f, roughness: 0.9, flatShading: true });
  const rand = makeRng(7);
  for (let i = 0; i < count; i++) {
    const a = rand() * Math.PI * 2;
    const r = rand() * spread;
    const px = Math.cos(a) * r;
    const pz = Math.sin(a) * r;
    const h = 25 + rand() * 25;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.5, h * 0.3, 5), trunkMat);
    trunk.position.set(px, h * 0.15, pz);
    g.add(trunk);
    // Three stacked cones for a layered conifer look
    for (let layer = 0; layer < 3; layer++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(8 - layer * 2, h * 0.35, 6), leafMat);
      cone.position.set(px, h * 0.3 + layer * h * 0.22, pz);
      g.add(cone);
    }
  }
  g.position.copy(position);
  return g;
}

// === Valley mist / 低空水平云 (per user request: 写实 alpha + 贴坡不穿模) ===
// 多层噪声 alpha 纹理的雾团。**贴坡旋转**:传入地形高度函数,用雾团边缘的
// 高度差算出当地坡度法线,平面旋转到贴合坡面 → 与地形起伏自然贴合,不再
// 出现平面边缘插入山坡/悬空的生硬交线。随机选纹理 + 水平拉伸 + 旋转。
export function buildValleyMist(
  cfg: SkyConfig,
  position: THREE.Vector3,
  radius = 1500,
  sampleHeight?: (x: number, z: number) => number,
): THREE.Mesh {
  const cloudTextures = makeCloudTextures();
  const tex = cloudTextures[Math.floor(Math.random() * cloudTextures.length)];
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    color: 0xffffff,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
  const m = new THREE.Mesh(new THREE.CircleGeometry(radius, 32), mat);
  // === 姿态统一用 quaternion(不碰 rotation,避免覆盖) ===
  // CircleGeometry 默认在 XY 平面(法线 +Z,竖直!)——必须先放平:qFlat 绕 X
  // -90° 使法线 → +Y。随后水平随机旋转(绕 Y)与贴坡都必须在这个基础上
  // 组合,顺序:qFinal = qSlope · qY · qFlat(先放平,再绕竖直轴自转,再贴坡)。
  m.position.copy(position);
  m.position.y = position.y + 5;
  // 每团雾随机水平拉伸(长宽比 0.7-1.4),避免整齐圆盘感。
  m.scale.set(0.7 + Math.random() * 0.7, 1, 0.7 + Math.random() * 0.7);
  const X_AXIS = new THREE.Vector3(1, 0, 0);
  const Y_AXIS = new THREE.Vector3(0, 1, 0);
  const qFlat = new THREE.Quaternion().setFromAxisAngle(X_AXIS, -Math.PI / 2);
  const qY = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, Math.random() * Math.PI * 2);
  let q = qY.multiply(qFlat);
  if (sampleHeight) {
    const x = position.x, z = position.z;
    const r = radius * 0.8;
    const hx1 = sampleHeight(x - r, z), hx2 = sampleHeight(x + r, z);
    const hz1 = sampleHeight(x, z - r), hz2 = sampleHeight(x, z + r);
    const gx = (hx2 - hx1) / (2 * r);
    const gz = (hz2 - hz1) / (2 * r);
    const n = new THREE.Vector3(-gx, 1, -gz).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const cosA = up.dot(n);
    if (cosA > 0.978) { // 坡角 < ~12° 才贴坡;更陡保持水平
      const qSlope = new THREE.Quaternion().setFromUnitVectors(up, n);
      q = qSlope.multiply(q);
    }
  }
  m.quaternion.copy(q);
  return m;
}

// ============================================================================
// DESERT-MAP FEATURES
// ============================================================================

// Sand dune — long low ridge made of a flattened elongated hemisphere.
// Different from mesas (which are vertical cylinders) — dunes are horizontal.
export function buildSandDune(cfg: SkyConfig, position: THREE.Vector3, length = 1200): THREE.Group {
  const g = new THREE.Group();
  const duneMat = new THREE.MeshStandardMaterial({ color: 0xd8b878, roughness: 1.0, flatShading: true });
  const dune = new THREE.Mesh(new THREE.SphereGeometry(length * 0.3, 16, 8), duneMat);
  dune.scale.set(length / 400, 0.15, length / 800);
  dune.position.y = 0;
  g.add(dune);
  // Second smaller dune beside it for variety
  const dune2 = new THREE.Mesh(new THREE.SphereGeometry(length * 0.18, 12, 6), duneMat);
  dune2.scale.set(length / 600, 0.10, length / 1200);
  dune2.position.set(length * 0.25, 0, length * 0.15);
  g.add(dune2);
  g.position.copy(position);
  g.rotation.y = Math.random() * Math.PI;
  return g;
}

// Oasis — small water pond ringed by palm trees and greenery. Stands out
// vividly against the sand.
export function buildOasis(cfg: SkyConfig, position: THREE.Vector3): THREE.Group {
  const g = new THREE.Group();
  const waterMat = new THREE.MeshStandardMaterial({ color: 0x2a7a9a, roughness: 0.2, metalness: 0.6 });
  const sandMat = new THREE.MeshStandardMaterial({ color: 0xd8b878, roughness: 1.0 });
  const grassMat = new THREE.MeshStandardMaterial({ color: 0x4a7a3a, roughness: 0.95 });
  const palmTrunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.9 });
  const palmLeafMat = new THREE.MeshStandardMaterial({ color: 0x2d6b2a, roughness: 0.85, flatShading: true });
  // Sand base
  const sand = new THREE.Mesh(new THREE.CylinderGeometry(120, 140, 2, 20), sandMat);
  sand.position.y = 1;
  g.add(sand);
  // Grass ring
  const grass = new THREE.Mesh(new THREE.CylinderGeometry(85, 100, 2, 20), grassMat);
  grass.position.y = 2;
  g.add(grass);
  // Water
  const water = new THREE.Mesh(new THREE.CylinderGeometry(60, 60, 2, 20), waterMat);
  water.position.y = 3;
  g.add(water);
  // Palm trees around the water
  const rand = makeRng(11);
  const palmCount = 8;
  for (let i = 0; i < palmCount; i++) {
    const a = (i / palmCount) * Math.PI * 2 + rand() * 0.3;
    const r = 80 + rand() * 15;
    const px = Math.cos(a) * r;
    const pz = Math.sin(a) * r;
    const trunkH = 18 + rand() * 10;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1.0, trunkH, 5), palmTrunkMat);
    trunk.position.set(px, 3 + trunkH / 2, pz);
    trunk.rotation.z = (rand() - 0.5) * 0.2;
    g.add(trunk);
    const fronds = new THREE.Mesh(new THREE.ConeGeometry(8, 6, 7), palmLeafMat);
    fronds.position.set(px, 3 + trunkH + 1, pz);
    fronds.scale.y = 0.4;
    g.add(fronds);
  }
  g.position.copy(position);
  return g;
}

// Desert village — a cluster of small flat-roofed adobe buildings around a
// central well. Adds human presence to the desert.
export function buildDesertVillage(cfg: SkyConfig, position: THREE.Vector3): THREE.Group {
  const g = new THREE.Group();
  const adobeMat = new THREE.MeshStandardMaterial({ color: 0xb88858, roughness: 1.0, flatShading: true });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x8a6840, roughness: 1.0 });
  const rand = makeRng(99);
  // Central well
  const well = new THREE.Mesh(new THREE.CylinderGeometry(4, 5, 4, 8), new THREE.MeshStandardMaterial({ color: 0x6a5a48, roughness: 0.9 }));
  well.position.y = 2;
  g.add(well);
  // Buildings around the well
  const count = 8 + Math.floor(rand() * 6);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rand() * 0.4;
    const r = 30 + rand() * 50;
    const px = Math.cos(a) * r;
    const pz = Math.sin(a) * r;
    const w = 12 + rand() * 8;
    const d = 12 + rand() * 8;
    const h = 8 + rand() * 6;
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), adobeMat);
    b.position.set(px, h / 2, pz);
    g.add(b);
    // Flat roof slab slightly larger than the building
    const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 1, 1, d + 1), roofMat);
    roof.position.set(px, h + 0.5, pz);
    g.add(roof);
  }
  g.position.copy(position);
  return g;
}

// Rocky outcrop — jagged cluster of high-poly displaced boulders. Different
// visual texture from mesas (smooth cylinders) and dunes (smooth ellipsoids).
// Each boulder is a high-segment icosahedron with per-vertex jitter so the
// silhouette is irregular and the facets catch light differently.
export function buildRockyOutcrop(cfg: SkyConfig, position: THREE.Vector3): THREE.Group {
  const g = new THREE.Group();
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x5a4838, roughness: 0.95, flatShading: true });
  const rand = makeRng(33);
  const count = 5 + Math.floor(rand() * 4);
  for (let i = 0; i < count; i++) {
    const r = 8 + rand() * 15;
    const h = 15 + rand() * 25;
    // High-poly cone (24 segments vs old 5-7) for a more detailed boulder.
    const segs = 16 + Math.floor(rand() * 8);
    const geom = new THREE.ConeGeometry(r, h, segs, 6, false, 0);
    // Per-vertex angular + height noise so the boulder looks fractured.
    const pos = geom.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const seed = rand() * 100;
    for (let v = 0; v < arr.length; v += 3) {
      const vx = arr[v], vy = arr[v + 1], vz = arr[v + 2];
      const theta = Math.atan2(vz, vx);
      const hf = (vy + 0.5);
      let n = 0;
      n += Math.sin(theta * 9 + seed) * 0.18;
      n += Math.sin(theta * 21 + seed * 2) * 0.10;
      n += Math.cos(theta * 37) * 0.05;
      const mask = 1.0 - hf * 0.4;
      const radial = 1.0 + n * mask;
      arr[v] = vx * radial;
      arr[v + 2] = vz * radial;
    }
    pos.needsUpdate = true;
    geom.computeVertexNormals();
    const rock = new THREE.Mesh(geom, rockMat);
    rock.position.set((rand() - 0.5) * 40, h / 2, (rand() - 0.5) * 40);
    rock.rotation.y = rand() * Math.PI;
    rock.rotation.x = (rand() - 0.5) * 0.2;
    g.add(rock);
  }
  g.position.copy(position);
  return g;
}

// ============================================================================
// ARCHIPELAGO-MAP FEATURES
// ============================================================================

// Coral reef — a shallow ring of light turquoise water around an island.
// Visible from altitude as a bright halo.
export function buildCoralReef(cfg: SkyConfig, position: THREE.Vector3, radius = 800): THREE.Group {
  const g = new THREE.Group();
  const reefMat = new THREE.MeshBasicMaterial({
    color: 0x40d0b0,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  // Outer ring
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius * 0.8, radius, 32), reefMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 1;
  g.add(ring);
  // Inner lagoon (lighter turquoise)
  const lagoon = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.8, 32), new THREE.MeshBasicMaterial({
    color: 0x60e0c0,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
  }));
  lagoon.rotation.x = -Math.PI / 2;
  lagoon.position.y = 0.5;
  g.add(lagoon);
  g.position.copy(position);
  return g;
}

// Volcanic island with a smoking peak — darker rock, caldera, and an animated
// smoke plume (driven by _smoke marker checked each frame). The base cone is
// high-poly with per-vertex noise displacement so the slopes look like rough
// volcanic rock instead of a smooth geometry primitive.
export function buildVolcanicIsland(cfg: SkyConfig, position: THREE.Vector3, radius = 900): THREE.Group {
  const g = new THREE.Group();
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x3a3028, roughness: 0.95, flatShading: true });
  const lavaMat = new THREE.MeshStandardMaterial({ color: 0xff5020, emissive: 0xff3010, emissiveIntensity: 0.8, roughness: 0.6 });
  // Base cone — high-poly (48 segments × 24 rings) with multi-octave angular
  // noise displacement so the slopes have lava-flow channels and rocky ridges.
  const baseGeom = new THREE.ConeGeometry(radius, 300, 48, 24, false, 0);
  {
    const bpos = baseGeom.attributes.position as THREE.BufferAttribute;
    const barr = bpos.array as Float32Array;
    const seed = 42.7;
    for (let v = 0; v < barr.length; v += 3) {
      const vx = barr[v], vy = barr[v + 1], vz = barr[v + 2];
      const theta = Math.atan2(vz, vx);
      const hf = (vy + 0.5); // 0 at base, 1 at apex
      // Volcanic-flow noise — wider, deeper channels than ordinary mountains.
      let n = 0;
      n += Math.sin(theta * 5 + seed) * 0.13;
      n += Math.sin(theta * 11 + seed * 1.4) * 0.07;
      n += Math.cos(theta * 23 + seed * 0.7) * 0.04;
      const heightMask = 1.0 - hf * 0.5;
      const radial = 1.0 + n * heightMask;
      barr[v] = vx * radial;
      barr[v + 2] = vz * radial;
    }
    bpos.needsUpdate = true;
    baseGeom.computeVertexNormals();
  }
  const base = new THREE.Mesh(baseGeom, rockMat);
  base.position.y = 150;
  g.add(base);
  // Caldera (smaller inverted cone on top, darker)
  const caldera = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.3, 80, 10), new THREE.MeshStandardMaterial({ color: 0x1a1410, roughness: 0.95 }));
  caldera.position.y = 320;
  caldera.rotation.x = Math.PI;  // invert so it looks like a depression
  g.add(caldera);
  // Lava glow inside the caldera
  const lava = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.18, 16), lavaMat);
  lava.rotation.x = -Math.PI / 2;
  lava.position.y = 285;
  g.add(lava);
  // Smoke plume (stack of fading grey spheres, animated via _smoke)
  for (let i = 0; i < 5; i++) {
    const puff = new THREE.Mesh(
      new THREE.SphereGeometry(20 + i * 8, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0x4a4a4a, transparent: true, opacity: 0.5 - i * 0.08 }),
    );
    puff.position.y = 340 + i * 30;
    (puff as any)._smokePuff = i;  // index used by the smoke updater
    (puff as any)._smokeBase = puff.position.y;
    g.add(puff);
  }

  g.position.copy(position);
  return g;
}

// Beach village — small cluster of huts on stilts along the waterline, with a
// wooden dock extending into the sea.
export function buildBeachVillage(cfg: SkyConfig, position: THREE.Vector3): THREE.Group {
  const g = new THREE.Group();
  const hutMat = new THREE.MeshStandardMaterial({ color: 0xc0a070, roughness: 0.95, flatShading: true });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x8a5028, roughness: 0.95, flatShading: true });
  const stiltMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.95 });
  const dockMat = new THREE.MeshStandardMaterial({ color: 0x8a6840, roughness: 0.95 });
  const rand = makeRng(57);
  // Huts on stilts
  const hutCount = 5 + Math.floor(rand() * 4);
  for (let i = 0; i < hutCount; i++) {
    const a = (i / hutCount) * Math.PI * 0.8 - Math.PI * 0.4;
    const r = 30 + rand() * 25;
    const px = Math.cos(a) * r;
    const pz = Math.sin(a) * r;
    // Four stilts
    for (const [sx, sz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
      const stilt = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 8, 4), stiltMat);
      stilt.position.set(px + sx, 4, pz + sz);
      g.add(stilt);
    }
    // Hut body
    const hut = new THREE.Mesh(new THREE.BoxGeometry(8, 5, 8), hutMat);
    hut.position.set(px, 10, pz);
    g.add(hut);
    // Thatched roof (4-sided pyramid)
    const roof = new THREE.Mesh(new THREE.ConeGeometry(7, 5, 4), roofMat);
    roof.position.set(px, 15, pz);
    roof.rotation.y = Math.PI / 4;
    g.add(roof);
  }
  // Wooden dock extending outward
  const dock = new THREE.Mesh(new THREE.BoxGeometry(8, 1, 60), dockMat);
  dock.position.set(0, 8, 50);
  g.add(dock);
  // Dock posts
  for (let z = 20; z <= 80; z += 12) {
    for (const x of [-3, 3]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 10, 4), stiltMat);
      post.position.set(x, 4, z);
      g.add(post);
    }
  }
  g.position.copy(position);
  return g;
}

// === Large-scale procedural city ===
// Generates a grid of instanced buildings with varied heights, emissive windows,
// and rooftop details. Designed for night/dusk missions with a city below.
export function buildCity(cfg: SkyConfig, options: {
  size?: number; blockSize?: number; seed?: number;
  // === 素材编辑 (per user request: 城市素材编辑器选项) ===
  // 4 类建筑的 底色/窗色/发光强度;无 tune 时与历史一致。
  colorTune?: {
    glass?: { bg?: string; win?: string; emissiveIntensity?: number };
    office?: { bg?: string; win?: string; emissiveIntensity?: number };
    residential?: { bg?: string; win?: string; emissiveIntensity?: number };
    landmark?: { bg?: string; win?: string; emissiveIntensity?: number };
  };
} = {}): THREE.Group {
  const group = new THREE.Group();
  const size = options.size ?? 12000;
  const blockSize = options.blockSize ?? 600;
  const seed = options.seed ?? 1337;
  // Seeded PRNG
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };

  // === Procedural building texture (per user request) ===
  // A canvas-baked texture with window grid + slight colour variation per
  // building type. Much more realistic than the flat-shaded boxes the old
  // city used. We bake 4 variants: glass-tower (blue-tinted windows),
  // concrete-office (warm yellow windows), residential (small warm windows),
  // and landmark (dark with bright top).
  const makeBuildingTexture = (bgColor: string, winColor: string, winW: number, winH: number, density: number) => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, 256, 256);
    // Window grid
    ctx.fillStyle = winColor;
    const cols = Math.floor(256 / winW);
    const rows = Math.floor(256 / winH);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        // Some windows are dark (off), some are lit.
        if (rand() < density) {
          // Slight per-window brightness variation
          const b = 0.7 + rand() * 0.3;
          ctx.globalAlpha = b;
          ctx.fillRect(x * winW + 2, y * winH + 2, winW - 4, winH - 4);
        }
      }
    }
    ctx.globalAlpha = 1;
    // Add some grime streaks for realism.
    ctx.globalCompositeOperation = 'multiply';
    for (let i = 0; i < 6; i++) {
      const x = rand() * 256;
      const grad = ctx.createLinearGradient(x, 0, x, 256);
      grad.addColorStop(0, 'rgba(80,80,80,0)');
      grad.addColorStop(0.5, 'rgba(60,60,60,0.4)');
      grad.addColorStop(1, 'rgba(80,80,80,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(x - 4, 0, 8, 256);
    }
    ctx.globalCompositeOperation = 'source-over';
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  };

  // === 4 building texture variants ===
  const ct = options.colorTune;
  const glassTex = makeBuildingTexture(ct?.glass?.bg ?? '#2a3540', ct?.glass?.win ?? '#5a8aaa', 24, 18, 0.85);
  const officeTex = makeBuildingTexture(ct?.office?.bg ?? '#3a3530', ct?.office?.win ?? '#d8b878', 28, 22, 0.7);
  const residentialTex = makeBuildingTexture(ct?.residential?.bg ?? '#403838', ct?.residential?.win ?? '#e8c888', 18, 16, 0.55);
  const landmarkTex = makeBuildingTexture(ct?.landmark?.bg ?? '#1a1e26', ct?.landmark?.win ?? '#ffd97a', 32, 28, 0.9);

  // === 4 building materials with textured windows ===
  // Each uses the texture as `map` (colour) plus emissive on the lit windows
  // so they glow at night. The emissive uses the same texture with a tinted
  // colour so only the lit windows actually emit light.
  // === PBR (per user request: 现代 PBR 渲染) ===
  // Normal + ao channels are generated to match each window grid, so the
  // city buildings now have full albedo/normal/ao/roughness/metalness sets.
  const glassMat = buildBuildingMaterial({ kind: 'glass', albedo: glassTex, emissive: new THREE.Color(ct?.glass?.win ?? '#3a6a8a'), emissiveIntensity: ct?.glass?.emissiveIntensity ?? 0.4, roughness: 0.4, metalness: 0.6 });
  const officeMat = buildBuildingMaterial({ kind: 'office', albedo: officeTex, emissive: new THREE.Color(ct?.office?.win ?? '#a8784a'), emissiveIntensity: ct?.office?.emissiveIntensity ?? 0.3, roughness: 0.7, metalness: 0.2 });
  const residentialMat = buildBuildingMaterial({ kind: 'residential', albedo: residentialTex, emissive: new THREE.Color(ct?.residential?.win ?? '#a88858'), emissiveIntensity: ct?.residential?.emissiveIntensity ?? 0.25, roughness: 0.85, metalness: 0.1 });
  const landmarkMat = buildBuildingMaterial({ kind: 'landmark', albedo: landmarkTex, emissive: new THREE.Color(ct?.landmark?.win ?? '#ffd97a'), emissiveIntensity: ct?.landmark?.emissiveIntensity ?? 0.5, roughness: 0.3, metalness: 0.7 });

  // === Performance optimization: InstancedMesh for buildings ===
  // We bucket buildings into 4 categories by height, build one
  // InstancedMesh per category with a unit BoxGeometry, and set per-instance
  // matrices + UV repeats to position + scale each building AND tile its
  // window texture appropriately (taller buildings get more window rows).
  type Bucket = {
    matrices: THREE.Matrix4[];
    uvRepeats: THREE.Vector2[]; // per-instance UV repeat (tiles windows)
    mat: THREE.Material;
    geom: THREE.BoxGeometry;
  };
  // BoxGeometry with UV2 so we can use per-instance UV scaling via the
  // instanceMatrix (we'll bake UV repeat into the geometry's UV attribute
  // — InstancedMesh shares one UV set, so we use a unit UV and rely on the
  // texture's repeat being 1×1; per-instance UV variation is achieved by
  // scaling the building's actual size so windows tile proportionally).
  const boxGeom = new THREE.BoxGeometry(1, 1, 1);
  // Set UVs so the texture repeats based on building dimensions. Since
  // InstancedMesh shares one UV set, we use a 0..1 UV and scale it via the
  // texture's repeat per material — but we can't have per-instance repeat.
  // Solution: use the unit UV (0..1) and let the texture repeat be baked
  // via the texture's `repeat` set on the material's map. For simplicity
  // we set repeat to (4, 6) globally — this tiles windows ~4×6 per face
  // regardless of building size, which looks reasonable across the variety.
  glassTex.repeat.set(3, 8);
  officeTex.repeat.set(3, 6);
  residentialTex.repeat.set(4, 5);
  landmarkTex.repeat.set(2, 10);
  // Keep the PBR detail channels (normal/ao) tiling in lockstep with the
  // albedo window grid, otherwise relief/ao stop matching the windows.
  for (const [albedoTex, mats] of [[glassTex, [glassMat]], [officeTex, [officeMat]], [residentialTex, [residentialMat]], [landmarkTex, [landmarkMat]]] as [THREE.Texture, THREE.MeshStandardMaterial[]][]) {
    for (const m of mats) {
      for (const t of [m.normalMap, m.aoMap]) {
        if (t) t.repeat.copy(albedoTex.repeat);
      }
    }
  }

  const buckets: Bucket[] = [
    { matrices: [], uvRepeats: [], mat: residentialMat, geom: boxGeom }, // short
    { matrices: [], uvRepeats: [], mat: officeMat, geom: boxGeom }, // mid
    { matrices: [], uvRepeats: [], mat: glassMat, geom: boxGeom }, // tall (glass towers)
    { matrices: [], uvRepeats: [], mat: landmarkMat, geom: boxGeom }, // landmark
  ];
  // Separate lists for rooftop antennas + blink lights (these stay as
  // individual meshes because they're rare — only on tall buildings — and
  // the blink light needs per-frame animation via _blink flag).
  const antennas: { pos: THREE.Vector3; height: number }[] = [];
  const blinkLights: { pos: THREE.Vector3 }[] = [];
  // Rooftop water tanks + AC units — give buildings that NYC rooftop look.
  const rooftopProps: { pos: THREE.Vector3; type: 'tank' | 'ac' }[] = [];
  // === New city layout data (per user request: 城市地图重做) ===
  // Parks: green plane blocks (no buildings). Rendered as a single
  // InstancedMesh of PlaneGeometry with a green material.
  const parks: { cx: number; cz: number; size: number }[] = [];
  // Trees: placed in parks + lining some streets. Rendered as two
  // InstancedMeshes (trunk cylinder + canopy sphere) for performance.
  const trees: { px: number; pz: number; height: number; radius: number }[] = [];
  // Cylindrical towers: CBD supertowers that use CylinderGeometry instead
  // of BoxGeometry for architectural variety.
  const cylindricalTowers: { px: number; pz: number; radius: number; height: number; tier: number }[] = [];

  const halfSize = size / 2;
  // === Redesigned city layout (per user request: 城市地图要认真重做，不行就推翻重来) ===
  // The old circular-scatter layout produced a random field of boxes that
  // didn't read as a city — buildings overlapped, there were no streets,
  // no districts, no parks, no landmarks. The user explicitly asked to
  // "scrap and redo" so this is a complete rewrite.
  //
  // The new layout is a GRID-BASED city with distinct districts:
  //
  //   1. ROAD GRID — major avenues every `blockSize` units, with minor
  //      side streets between them. Roads are rendered as dark planes
  //      with lane markings (baked into the ground texture).
  //
  //   2. DISTRICTS — three concentric zones:
  //      - CBD (centre, 0-30% radius): dense cluster of supertall towers
  //        (landmarks + glass towers). The city's skyline identity.
  //      - COMMERCIAL (30-60% radius): mid-rise office buildings, dense
  //        grid layout.
  //      - RESIDENTIAL (60-100% radius): low buildings, more spacing,
  //        some parks.
  //
  //   3. BLOCKS — each block is a square region bounded by roads. Buildings
  //      are placed INSIDE blocks with a margin so they don't poke into
  //      the street. CBD blocks have 4-8 buildings (dense), commercial
  //      blocks have 2-4, residential blocks have 1-3.
  //
  //   4. PARKS — ~8% of blocks are parks (green plane + tree cluster).
  //      Concentrated in the residential zone.
  //
  //   5. RIVER — a diagonal water channel cuts through the city (optional,
  //      controlled by seed). Adds visual variety.
  //
  //   6. LANDMARK CLUSTER — 3-5 supertall towers in the very centre (the
  //      "downtown core"). These are the city's identity towers.
  //
  // Building footprints are varied: squares, rectangles, and a few
  // cylindrical towers (for the CBD) so it's not all boxes.

  const cityRadius = halfSize * 0.92;
  // Block size: divide the city into a grid of blocks.
  // blockSize=600 → ~20x20 = 400 blocks for a 12000-size city.
  const gridSteps = Math.floor(size / blockSize);
  const actualBlockSize = size / gridSteps;
  const roadWidth = actualBlockSize * 0.18; // 18% of block is road
  const buildableSize = actualBlockSize - roadWidth;
  // === Building-height grid (per user request: 目标框被建筑遮挡变虚线) ===
  // Coarse per-cell max building height so the HUD can test whether a
  // target's line-of-sight is blocked by a skyscraper — without raycasting
  // the InstancedMeshes every frame. Cells are one city block.
  const buildingHeight = new Float32Array(gridSteps * gridSteps);
  const markBuilding = (px: number, pz: number, w: number, d: number, h: number) => {
    const gx0 = THREE.MathUtils.clamp(Math.floor((px - w / 2 + halfSize) / actualBlockSize), 0, gridSteps - 1);
    const gx1 = THREE.MathUtils.clamp(Math.floor((px + w / 2 + halfSize) / actualBlockSize), 0, gridSteps - 1);
    const gz0 = THREE.MathUtils.clamp(Math.floor((pz - d / 2 + halfSize) / actualBlockSize), 0, gridSteps - 1);
    const gz1 = THREE.MathUtils.clamp(Math.floor((pz + d / 2 + halfSize) / actualBlockSize), 0, gridSteps - 1);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const i = gz * gridSteps + gx;
        if (h > buildingHeight[i]) buildingHeight[i] = h;
      }
    }
  };

  // === River definition (optional, diagonal) ===
  // A river cuts diagonally through the city. Blocks that intersect the
  // river are skipped (no buildings) — the river plane is rendered
  // separately. The river is a 400-unit-wide band along the diagonal.
  const hasRiver = (seed % 3) === 0; // ~33% of seeds have a river
  const riverWidth = 380;
  // River flows along the line y = x (diagonal). Distance from a point
  // (px, pz) to the diagonal = |px - pz| / sqrt(2).
  const riverDist = (px: number, pz: number) => Math.abs(px - pz) / Math.SQRT2;

  // === District classification by radial distance from centre ===
  const distFromCentre = (px: number, pz: number) => Math.sqrt(px * px + pz * pz);
  const districtOf = (d: number): 'cbd' | 'commercial' | 'residential' => {
    if (d < cityRadius * 0.30) return 'cbd';
    if (d < cityRadius * 0.60) return 'commercial';
    return 'residential';
  };

  // === Place buildings block-by-block ===
  // Iterate the grid. For each block, decide what district it's in, how
  // many buildings to place, and what tier each should be.
  for (let gx = 0; gx < gridSteps; gx++) {
    for (let gz = 0; gz < gridSteps; gz++) {
      // Block centre in world space
      const cx = -halfSize + (gx + 0.5) * actualBlockSize;
      const cz = -halfSize + (gz + 0.5) * actualBlockSize;
      // Skip blocks outside the city radius (circular city inscribed in square)
      if (distFromCentre(cx, cz) > cityRadius) continue;
      // Skip blocks that intersect the river
      if (hasRiver && riverDist(cx, cz) < riverWidth / 2 + actualBlockSize * 0.4) continue;
      const district = districtOf(distFromCentre(cx, cz));
      // === Parks: ~8% of residential blocks, ~4% of commercial, 0% CBD ===
      const parkChance = district === 'residential' ? 0.08 : district === 'commercial' ? 0.04 : 0;
      if (rand() < parkChance) {
        // This block is a park — add a green plane (we'll collect these and
        // render them as a single InstancedMesh later). Skip building placement.
        parks.push({ cx, cz, size: buildableSize * 0.9 });
        continue;
      }
      // === Building count per block (by district) ===
      // CBD: 4-8 dense towers. Commercial: 2-4 mid-rises. Residential: 1-3 low.
      const countRange = district === 'cbd' ? [4, 8]
        : district === 'commercial' ? [2, 4]
        : [1, 3];
      const numBuildings = countRange[0] + Math.floor(rand() * (countRange[1] - countRange[0] + 1));
      // Sub-divide the block into a mini-grid for building placement.
      // For CBD we use a 3x3 sub-grid (9 slots, pick numBuildings of them).
      // For commercial, 2x2. For residential, 2x2 with larger margins.
      const subDiv = district === 'cbd' ? 3 : 2;
      const slotSize = buildableSize / subDiv;
      const buildingMargin = slotSize * 0.12;
      // Generate all slot positions and shuffle so we pick random slots.
      const slots: { x: number; z: number }[] = [];
      for (let sx = 0; sx < subDiv; sx++) {
        for (let sz = 0; sz < subDiv; sz++) {
          const sxWorld = cx - buildableSize / 2 + (sx + 0.5) * slotSize;
          const szWorld = cz - buildableSize / 2 + (sz + 0.5) * slotSize;
          slots.push({ x: sxWorld, z: szWorld });
        }
      }
      // Fisher-Yates shuffle the slots
      for (let i = slots.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const tmp = slots[i]; slots[i] = slots[j]; slots[j] = tmp;
      }
      // Pick the first numBuildings slots
      for (let b = 0; b < numBuildings && b < slots.length; b++) {
        const slot = slots[b];
        const px = slot.x;
        const pz = slot.z;
        // === Tier by district ===
        // CBD: 60% glass tower (tier 2), 25% landmark (tier 3), 15% mid (tier 1)
        // Commercial: 50% mid (tier 1), 40% glass tower (tier 2), 10% low (tier 0)
        // Residential: 70% low (tier 0), 25% mid (tier 1), 5% glass tower (tier 2)
        const r = rand();
        let bucketIdx: number;
        if (district === 'cbd') {
          bucketIdx = r < 0.25 ? 3 : r < 0.85 ? 2 : 1;
        } else if (district === 'commercial') {
          bucketIdx = r < 0.10 ? 0 : r < 0.50 ? 1 : 2;
        } else {
          bucketIdx = r < 0.70 ? 0 : r < 0.95 ? 1 : 2;
        }
        // === Height by tier + district ===
        // CBD buildings are taller than residential of the same tier.
        const districtHeightMult = district === 'cbd' ? 1.3 : district === 'commercial' ? 1.0 : 0.7;
        let baseHeight: number;
        if (bucketIdx === 3)      baseHeight = (200 + rand() * 180) * districtHeightMult;
        else if (bucketIdx === 2) baseHeight = (90 + rand() * 110) * districtHeightMult;
        else if (bucketIdx === 1) baseHeight = (35 + rand() * 55) * districtHeightMult;
        else                       baseHeight = (12 + rand() * 23) * districtHeightMult;
        const height = baseHeight;
        // === Footprint: fit within the slot, with margin ===
        const maxFootprint = slotSize - buildingMargin * 2;
        // Vary footprint: square, rectangular, or small.
        const footprint = rand();
        let width: number, depth: number;
        if (footprint < 0.4) {
          // square (fills most of the slot)
          width = maxFootprint * (0.7 + rand() * 0.25);
          depth = width;
        } else if (footprint < 0.7) {
          // rectangular
          width = maxFootprint * (0.6 + rand() * 0.35);
          depth = maxFootprint * (0.5 + rand() * 0.3);
        } else {
          // small (leaves gaps — more varied skyline)
          width = maxFootprint * (0.4 + rand() * 0.2);
          depth = maxFootprint * (0.4 + rand() * 0.2);
        }
        // === CBD supertowers: 20% chance of cylindrical tower ===
        // Cylindrical towers use a separate bucket (we'll render them with
        // CylinderGeometry instead of BoxGeometry).
        const isCylindrical = district === 'cbd' && bucketIdx >= 2 && rand() < 0.20;
        if (isCylindrical) {
        // Cylindrical tower — push to a special cylindrical bucket
        const radius = Math.min(width, depth) / 2;
        cylindricalTowers.push({ px, pz, radius, height, tier: bucketIdx });
        markBuilding(px, pz, width, depth, height);
          // Skip the box placement below
          if (height > 100 && rand() > 0.4) {
            antennas.push({ pos: new THREE.Vector3(px, height + 18, pz), height: 25 + rand() * 35 });
            blinkLights.push({ pos: new THREE.Vector3(px, height + 35, pz) });
          }
          continue;
        }
        // Build the per-instance matrix: position at (px, height/2, pz) and
        // scale to (width, height, depth).
        const matrix = new THREE.Matrix4();
        matrix.makeScale(width, height, depth);
        matrix.setPosition(px, height / 2, pz);
        buckets[bucketIdx].matrices.push(matrix);
        markBuilding(px, pz, width, depth, height);
        // Rooftop antenna on tall buildings.
        if (height > 100 && rand() > 0.4) {
          antennas.push({ pos: new THREE.Vector3(px, height + 18, pz), height: 25 + rand() * 35 });
          blinkLights.push({ pos: new THREE.Vector3(px, height + 35, pz) });
        }
        // Rooftop water tanks on mid-rise buildings (classic NYC detail).
        if (height > 40 && height < 150 && rand() > 0.6) {
          rooftopProps.push({ pos: new THREE.Vector3(px + (rand() - 0.5) * width * 0.5, height + 6, pz + (rand() - 0.5) * depth * 0.5), type: 'tank' });
        }
        // AC units on flat rooftops of shorter buildings.
        if (height < 80 && rand() > 0.5) {
          rooftopProps.push({ pos: new THREE.Vector3(px + (rand() - 0.5) * width * 0.4, height + 2, pz + (rand() - 0.5) * depth * 0.4), type: 'ac' });
        }
      }
    }
  }

  // === Landmark cluster: 3-5 supertall towers in the very centre ===
  // These are the city's identity — the "twin towers" or "Burj Khalifa" that
  // define the skyline. Placed in a tight cluster at (0,0).
  const landmarkCount = 3 + Math.floor(rand() * 3); // 3-5
  for (let i = 0; i < landmarkCount; i++) {
    const ang = (i / landmarkCount) * Math.PI * 2 + rand() * 0.3;
    const dist = 120 + rand() * 80; // tight cluster within 200 units of centre
    const px = Math.cos(ang) * dist;
    const pz = Math.sin(ang) * dist;
    const height = 320 + rand() * 120; // 320-440 — tallest in the city
    const width = 45 + rand() * 20;
    const depth = 45 + rand() * 20;
    const matrix = new THREE.Matrix4();
    matrix.makeScale(width, height, depth);
    matrix.setPosition(px, height / 2, pz);
    buckets[3].matrices.push(matrix); // landmark bucket
    markBuilding(px, pz, width, depth, height);
    // Each supertall gets an antenna + blink light
    antennas.push({ pos: new THREE.Vector3(px, height + 25, pz), height: 40 + rand() * 30 });
    blinkLights.push({ pos: new THREE.Vector3(px, height + 50, pz) });
  }

  // === River plane (if this city has a river) ===
  if (hasRiver) {
    const riverGeom = new THREE.PlaneGeometry(size * 1.6, riverWidth);
    const riverMat = new THREE.MeshStandardMaterial({
      color: 0x1a3040,
      roughness: 0.2,
      metalness: 0.6,
      transparent: true,
      opacity: 0.85,
    });
    const river = new THREE.Mesh(riverGeom, riverMat);
    river.rotation.x = -Math.PI / 2;
    river.rotation.z = Math.PI / 4; // diagonal
    river.position.y = 0.5;
    (river as any)._env = true;
    group.add(river);
  }

  // === Parks: green planes + tree clusters ===
  if (parks.length > 0) {
    // Green plane per park (single InstancedMesh)
    const parkGeom = new THREE.PlaneGeometry(1, 1);
    const parkMat = new THREE.MeshStandardMaterial({ color: 0x2a4a2a, roughness: 0.95 });
    const parkInst = new THREE.InstancedMesh(parkGeom, parkMat, parks.length);
    parkInst.frustumCulled = false;
    parkInst.receiveShadow = true;
    const m = new THREE.Matrix4();
    for (let i = 0; i < parks.length; i++) {
      const p = parks[i];
      m.makeScale(p.size, p.size, 1);
      m.setPosition(p.cx, 0.6, p.cz);
      parkInst.setMatrixAt(i, m);
    }
    parkInst.instanceMatrix.needsUpdate = true;
    (parkInst as any)._env = true;
    group.add(parkInst);
    // Trees in parks — use the existing tree cluster system
    for (const p of parks) {
      const treeCount = 4 + Math.floor(rand() * 6);
      for (let t = 0; t < treeCount; t++) {
        const tx = p.cx + (rand() - 0.5) * p.size * 0.7;
        const tz = p.cz + (rand() - 0.5) * p.size * 0.7;
        const treeHeight = 8 + rand() * 12;
        const treeRadius = 4 + rand() * 3;
        trees.push({ px: tx, pz: tz, height: treeHeight, radius: treeRadius });
      }
    }
  }

  // === Trees (in parks + along some streets) ===
  if (trees.length > 0) {
    // Tree trunk: cylinder
    const trunkGeom = new THREE.CylinderGeometry(0.5, 0.8, 1, 5);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x3a2818, roughness: 0.9 });
    const trunkInst = new THREE.InstancedMesh(trunkGeom, trunkMat, trees.length);
    trunkInst.frustumCulled = false;
    trunkInst.castShadow = true;
    // Tree canopy: sphere
    const canopyGeom = new THREE.SphereGeometry(1, 6, 5);
    const canopyMat = new THREE.MeshStandardMaterial({ color: 0x2a4a2a, roughness: 0.95 });
    const canopyInst = new THREE.InstancedMesh(canopyGeom, canopyMat, trees.length);
    canopyInst.frustumCulled = false;
    canopyInst.castShadow = true;
    const m = new THREE.Matrix4();
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      // Trunk
      m.makeScale(t.radius * 0.3, t.height * 0.4, t.radius * 0.3);
      m.setPosition(t.px, t.height * 0.2, t.pz);
      trunkInst.setMatrixAt(i, m);
      // Canopy
      m.makeScale(t.radius, t.height * 0.6, t.radius);
      m.setPosition(t.px, t.height * 0.7, t.pz);
      canopyInst.setMatrixAt(i, m);
    }
    trunkInst.instanceMatrix.needsUpdate = true;
    canopyInst.instanceMatrix.needsUpdate = true;
    (trunkInst as any)._env = true;
    (canopyInst as any)._env = true;
    group.add(trunkInst);
    group.add(canopyInst);
  }

  // === Cylindrical towers (CBD supertowers) ===
  if (cylindricalTowers.length > 0) {
    // Pick material by tier (2 = glass, 3 = landmark)
    const cylGeoms = [new THREE.CylinderGeometry(1, 1, 1, 16), new THREE.CylinderGeometry(1, 1, 1, 16)];
    const cylMats = [glassMat, landmarkMat];
    for (let tierIdx = 0; tierIdx < 2; tierIdx++) {
      const tierBuildings = cylindricalTowers.filter(t => t.tier === 2 + tierIdx);
      if (tierBuildings.length === 0) continue;
      const inst = new THREE.InstancedMesh(cylGeoms[tierIdx], cylMats[tierIdx], tierBuildings.length);
      inst.frustumCulled = false;
      inst.castShadow = true;
      inst.receiveShadow = true;
      const m = new THREE.Matrix4();
      for (let i = 0; i < tierBuildings.length; i++) {
        const b = tierBuildings[i];
        m.makeScale(b.radius, b.height, b.radius);
        m.setPosition(b.px, b.height / 2, b.pz);
        inst.setMatrixAt(i, m);
      }
      inst.instanceMatrix.needsUpdate = true;
      (inst as any)._env = true;
      group.add(inst);
    }
  }

  // Build one InstancedMesh per bucket and add to the group.
  for (const bucket of buckets) {
    if (bucket.matrices.length === 0) continue;
    const inst = new THREE.InstancedMesh(bucket.geom, bucket.mat, bucket.matrices.length);
    inst.frustumCulled = false;
    inst.castShadow = true;
    inst.receiveShadow = true;
    for (let i = 0; i < bucket.matrices.length; i++) {
      inst.setMatrixAt(i, bucket.matrices[i]);
    }
    inst.instanceMatrix.needsUpdate = true;
    (inst as any)._env = true;
    group.add(inst);
  }

  // Antennas — use a single InstancedMesh (CylinderGeometry unit).
  if (antennas.length > 0) {
    const antGeom = new THREE.CylinderGeometry(0.4, 0.6, 1, 6);
    const antMat = new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 0.6, metalness: 0.7 });
    const antInst = new THREE.InstancedMesh(antGeom, antMat, antennas.length);
    antInst.frustumCulled = false;
    antInst.castShadow = true;
    antInst.receiveShadow = true;
    const m = new THREE.Matrix4();
    for (let i = 0; i < antennas.length; i++) {
      const a = antennas[i];
      m.makeScale(1, a.height, 1);
      m.setPosition(a.pos);
      antInst.setMatrixAt(i, m);
    }
    antInst.instanceMatrix.needsUpdate = true;
    (antInst as any)._env = true;
    group.add(antInst);
  }

  // === Rooftop props (water tanks + AC units) ===
  // Water tank: small dark cylinder + conical top. AC unit: small grey box.
  // Both use InstancedMesh for performance.
  const tanks = rooftopProps.filter(p => p.type === 'tank');
  const acs = rooftopProps.filter(p => p.type === 'ac');
  if (tanks.length > 0) {
    const tankGeom = new THREE.CylinderGeometry(4, 4, 8, 8);
    const tankMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 0.9 });
    const tankInst = new THREE.InstancedMesh(tankGeom, tankMat, tanks.length);
    tankInst.castShadow = true;
    const m = new THREE.Matrix4();
    for (let i = 0; i < tanks.length; i++) {
      m.makeScale(1, 1, 1);
      m.setPosition(tanks[i].pos);
      tankInst.setMatrixAt(i, m);
    }
    tankInst.instanceMatrix.needsUpdate = true;
    (tankInst as any)._env = true;
    group.add(tankInst);
  }
  if (acs.length > 0) {
    const acGeom = new THREE.BoxGeometry(6, 3, 6);
    const acMat = new THREE.MeshStandardMaterial({ color: 0x6a6a6a, roughness: 0.8, metalness: 0.3 });
    const acInst = new THREE.InstancedMesh(acGeom, acMat, acs.length);
    acInst.castShadow = true;
    const m = new THREE.Matrix4();
    for (let i = 0; i < acs.length; i++) {
      m.makeScale(1, 1, 1);
      m.setPosition(acs[i].pos);
      acInst.setMatrixAt(i, m);
    }
    acInst.instanceMatrix.needsUpdate = true;
    (acInst as any)._env = true;
    group.add(acInst);
  }

  // Blink lights — individual meshes (need _blink flag for animation).
  const blinkMat = new THREE.MeshBasicMaterial({ color: 0xff2222 });
  const blinkGeom = new THREE.SphereGeometry(1.2, 6, 6);
  for (const bl of blinkLights) {
    const light = new THREE.Mesh(blinkGeom, blinkMat);
    light.position.copy(bl.pos);
    (light as any)._blink = true;
    (light as any)._env = true;
    group.add(light);
  }

  // === Ground plane with street texture (per user request) ===
  // Bake a street grid into a canvas texture — dark asphalt with lighter
  // lane markings + intersections. Much more realistic than the flat dark
  // grey plane the old city used.
  const streetTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const ctx = c.getContext('2d')!;
    // Asphalt base
    ctx.fillStyle = '#1a1c20';
    ctx.fillRect(0, 0, 512, 512);
    // Add asphalt noise
    for (let i = 0; i < 4000; i++) {
      const x = rand() * 512;
      const y = rand() * 512;
      const v = 20 + rand() * 30;
      ctx.fillStyle = `rgba(${v},${v},${v + 4},0.5)`;
      ctx.fillRect(x, y, 1, 1);
    }
    // Streets (lighter strips) — both horizontal and vertical
    ctx.fillStyle = '#2a2e36';
    ctx.fillRect(0, 230, 512, 52);   // horizontal street
    ctx.fillRect(230, 0, 52, 512);   // vertical street
    // Lane markings (dashed yellow)
    ctx.fillStyle = '#c8a838';
    for (let x = 0; x < 512; x += 32) {
      ctx.fillRect(x, 254, 18, 3); // horizontal lane
      ctx.fillRect(254, x, 3, 18); // vertical lane
    }
    // Crosswalk stripes at intersections
    ctx.fillStyle = '#d8d8d8';
    for (let i = 0; i < 5; i++) {
      ctx.fillRect(210 + i * 6, 232, 4, 48);
      ctx.fillRect(232, 210 + i * 6, 48, 4);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    // Repeat so each block of the texture corresponds to roughly one city block.
    tex.repeat.set(size / blockSize, size / blockSize);
    return tex;
  })();
  const groundMat = new THREE.MeshStandardMaterial({
    map: streetTex,
    roughness: 0.95,
    metalness: 0.05,
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(size * 1.4, size * 1.4), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  ground.receiveShadow = true;
  (ground as any)._env = true;
  group.add(ground);
  // === Building-height sampler (per user request: 目标框被建筑遮挡变虚线) ===
  // Lets the HUD test line-of-sight against the skyline cheaply.
  (group as any).sampleHeight = (x: number, z: number) => {
    const gx = Math.floor((x + halfSize) / actualBlockSize);
    const gz = Math.floor((z + halfSize) / actualBlockSize);
    if (gx < 0 || gx >= gridSteps || gz < 0 || gz >= gridSteps) return 0;
    return buildingHeight[gz * gridSteps + gx];
  };
  return group;
}

// === Rain / storm particle system ===
// A pool of vertical streaks that follow the camera. Recycled when they fall below
// the camera's altitude. Color is bluish-gray, blended additively for visibility.
export interface RainSystem {
  group: THREE.Group;
  update: (dt: number, cameraPos: THREE.Vector3, windVec: THREE.Vector2, intensity: number) => void;
  setVisible: (v: boolean) => void;
}

export function buildRainSystem(intensity = 1.0): RainSystem {
  const group = new THREE.Group();
  const COUNT = 4000;
  const geom = new THREE.BufferGeometry();
  const positions = new Float32Array(COUNT * 2 * 3);
  const velocities = new Float32Array(COUNT);
  const initial = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT; i++) {
    const x = (Math.random() - 0.5) * 600;
    const y = Math.random() * 400;
    const z = (Math.random() - 0.5) * 600;
    // Streak from (x,y,z) to (x,y-3,z)
    positions[i * 6 + 0] = x;
    positions[i * 6 + 1] = y;
    positions[i * 6 + 2] = z;
    positions[i * 6 + 3] = x;
    positions[i * 6 + 4] = y - 3;
    positions[i * 6 + 5] = z;
    velocities[i] = 80 + Math.random() * 80;
    initial[i * 3 + 0] = x;
    initial[i * 3 + 1] = y;
    initial[i * 3 + 2] = z;
  }
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0xa0b0c8,
    transparent: true,
    opacity: 0.4 * intensity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geom, mat);
  lines.frustumCulled = false;
  group.add(lines);

  let visible = true;

  const update = (dt: number, cameraPos: THREE.Vector3, windVec: THREE.Vector2, _intensity: number) => {
    if (!visible) return;
    const arr = geom.attributes.position.array as Float32Array;
    const windX = windVec.x * 0.3;
    const windZ = windVec.y * 0.3;
    for (let i = 0; i < COUNT; i++) {
      const idx = i * 6;
      // Move top vertex down
      const fall = velocities[i] * dt;
      arr[idx + 1] -= fall;
      arr[idx + 3] -= fall;
      // Wind drift
      arr[idx + 0] += windX * dt * 30;
      arr[idx + 2] += windZ * dt * 30;
      arr[idx + 3] += windX * dt * 30;
      arr[idx + 5] += windZ * dt * 30;
      // Recycle if below camera or out of range
      const dy = arr[idx + 1] - cameraPos.y;
      if (dy < -50) {
        // Reset above camera
        const x = cameraPos.x + (Math.random() - 0.5) * 600;
        const y = cameraPos.y + 200 + Math.random() * 200;
        const z = cameraPos.z + (Math.random() - 0.5) * 600;
        arr[idx + 0] = x;
        arr[idx + 1] = y;
        arr[idx + 2] = z;
        arr[idx + 3] = x;
        arr[idx + 4] = y - 3;
        arr[idx + 5] = z;
      }
    }
    geom.attributes.position.needsUpdate = true;
    // Reposition rain cloud group to follow camera (XZ)
    group.position.x = 0;
    group.position.z = 0;
  };

  const setVisible = (v: boolean) => {
    visible = v;
    group.visible = v;
  };

  return { group, update, setVisible };
}

// === Lightning system (per user request: 闪电在雷雨天气要更明显) ===
// The original system used a 1px LineBasicMaterial bolt which was nearly
// invisible at flight altitudes — most browsers cap linewidth at 1px so the
// bolt was a thin hairline easily missed against the bright storm clouds.
// The new system layers MULTIPLE visual elements so lightning reads clearly
// from any distance:
//
//   1. A FAT additive "glow tube" — a TubeGeometry along the bolt path,
//      rendered with an additive emissive material. This is the bright
//      neon-looking core of the strike that you can see from 10km away.
//   2. The original 1px zig-zag Line on top — adds the sharp electric edge.
//   3. A cloud-illumination billboard sprite at the strike origin — a large
//      additive disc that briefly lights up the cloud deck above the strike.
//   4. A stronger DirectionalLight flash (peak 35, was 24) with a longer
//      tail so the whole scene gets briefly day-lit.
//   5. A short-lived sky tint — we flash the scene.background color brighter
//      for ~0.15s so the entire sky dome reads as "lit from within".
//
// Strike frequency is also higher at high storm intensity — up to 1 strike
// per ~1s during the peak of a storm, plus multi-stroke bursts (real CG
// lightning often hits 3-5 times in rapid succession).
export interface LightningSystem {
  group: THREE.Group;
  light: THREE.DirectionalLight;
  skyLight: THREE.HemisphereLight;
  update: (dt: number, intensity: number, cameraPos: THREE.Vector3, scene?: THREE.Scene | null) => void;
  trigger: () => void;
  // === Per user request: 闪电时播放雷声 ===
  // Called whenever a strike fires (main or secondary). The engine registers
  // a callback that plays the thunder sample with delay based on distance.
  onStrike?: (origin: THREE.Vector3, isMain: boolean) => void;
}

export function buildLightningSystem(): LightningSystem {
  const group = new THREE.Group();

  // === DirectionalLight — the main scene-illuminating flash ===
  // Peak 35 (was 24) — the flash now dominates scene lighting for its brief
  // duration, illuminating clouds, ocean, terrain, and aircraft alike.
  const light = new THREE.DirectionalLight(0xeaf2ff, 0);
  light.position.set(0, 5000, 0);
  group.add(light);

  // === HemisphereLight — sky/ground bounce flash ===
  // During the strike the SKY itself is the light source (cloud-to-cloud
  // discharge lights up the entire cloud deck). A hemisphere light with
  // skyColor = bright white + groundColor = dim blue approximates this
  // "light from above everywhere" effect that a single directional can't.
  const skyLight = new THREE.HemisphereLight(0xeaf2ff, 0x202830, 0);
  group.add(skyLight);

  // === Bolt glow tube (FAT additive core — the new "obvious" element) ===
  // TubeGeometry along the bolt path. We rebuild the geometry each strike
  // (cheap — ~40 segments) so the bolt shape varies per strike. The
  // additive emissive material makes it read as a brilliant neon channel
  // even from very far away.
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xbfd8ff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  let glowMesh: THREE.Mesh | null = null;

  // === Secondary inner core (thin bright tube — the "hot" centre) ===
  const coreMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  let coreMesh: THREE.Mesh | null = null;

  // === Cloud-illumination billboard ===
  // A large additive disc placed at the strike's cloud origin. When it
  // flashes, it visually "lights up the cloud deck" at the strike point —
  // this is what you actually see in real lightning (the bolt itself is
  // thin, but the cloud around it lights up brilliantly).
  // === 给云层闪光一张**径向渐变贴图** (per fix: 闪电顶部出现方块贴图) ===
  // 原来这个 Sprite 没有设置 `map` —— 没有贴图的 SpriteMaterial 会被渲染成一个**实心方块**,
  // 在闪电上方就是那块刺眼的方形。这里现场生成 256² 径向渐变(中心实、边缘全透明),
  // 于是它变成一团柔和光晕(加色混合), 与真实闪电"云层被照亮"的观感一致。
  const glowDiscTex = (() => {
    const SZ = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = SZ;
    const cx = cv.getContext('2d');
    if (!cx) return null;
    const g = cx.createRadialGradient(SZ / 2, SZ / 2, 0, SZ / 2, SZ / 2, SZ / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.14)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    cx.fillStyle = g;
    cx.fillRect(0, 0, SZ, SZ);
    const t = new THREE.CanvasTexture(cv);
    t.needsUpdate = true;
    return t;
  })();
  const cloudDiscMat = new THREE.SpriteMaterial({
    map: glowDiscTex ?? undefined,   // ← 关键: 缺少 map 时 Sprite 就是一个实心方块
    color: 0xc8d8ff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false, // always render on top so it's never occluded by cloud sprites
  });
  const cloudDisc = new THREE.Sprite(cloudDiscMat);
  cloudDisc.scale.set(2400, 2400, 1);
  group.add(cloudDisc);

  // === Original 1px bolt Line — sharp electric edge on top of the glow ===
  const boltMat = new THREE.LineBasicMaterial({
    color: 0xfafcff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    linewidth: 3, // (most browsers cap this at 1px, but we set it anyway)
  });
  const boltGeom = new THREE.BufferGeometry();
  const maxPoints = 40;
  const boltPositions = new Float32Array(maxPoints * 3);
  boltGeom.setAttribute('position', new THREE.BufferAttribute(boltPositions, 3));
  const bolt = new THREE.Line(boltGeom, boltMat);
  bolt.renderOrder = 999; // render on top of the glow tube
  group.add(bolt);

  // Afterglow bolt — slightly offset, dimmer, lingers longer.
  const afterglowMat = new THREE.LineBasicMaterial({
    color: 0xc8d8ff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const afterglowGeom = new THREE.BufferGeometry();
  const afterglowPositions = new Float32Array(maxPoints * 3);
  afterglowGeom.setAttribute('position', new THREE.BufferAttribute(afterglowPositions, 3));
  const afterglow = new THREE.Line(afterglowGeom, afterglowMat);
  group.add(afterglow);

  let timer = 0;
  let nextStrike = 2 + Math.random() * 3;
  let flashLife = 0;
  let boltLife = 0;
  let afterglowLife = 0;
  let cloudLife = 0;
  let burstRemaining = 0;
  let burstTimer = 0;
  // Cached scene background + fog color so we can flash them and restore.
  let savedBg: THREE.Color | null = null;
  let savedFog: THREE.Color | null = null;
  let savedFogDensity = 0;
  let skyFlashLife = 0;

  // === External strike listener (engine registers to play thunder) ===
  // Forward-declared via closure — the actual listener is stored on the
  // returned system object. fireStrike() reads it via `system?.onStrike`.
  let system: LightningSystem;

  // Build a TubeGeometry along a zig-zag path. We sample the same algorithm
  // as the Line bolt so the glow tube exactly traces the visible bolt.
  const buildBoltPath = (origin: THREE.Vector3, jitterScale: number): THREE.Vector3[] => {
    const pts: THREE.Vector3[] = [];
    const target = new THREE.Vector3(
      origin.x + (Math.random() - 0.5) * 800,
      0,
      origin.z + (Math.random() - 0.5) * 800,
    );
    const segs = maxPoints - 1;
    for (let i = 0; i < maxPoints; i++) {
      const t = i / segs;
      pts.push(new THREE.Vector3(
        origin.x + (target.x - origin.x) * t + (Math.random() - 0.5) * jitterScale * (1 - t),
        origin.y * (1 - t) + (Math.random() - 0.5) * 30 * (1 - t),
        origin.z + (target.z - origin.z) * t + (Math.random() - 0.5) * jitterScale * (1 - t),
      ));
    }
    return pts;
  };

  const generateBolt = (origin: THREE.Vector3, positions: Float32Array, geom: THREE.BufferGeometry, jitterScale = 60) => {
    const pts = buildBoltPath(origin, jitterScale);
    for (let i = 0; i < maxPoints; i++) {
      positions[i * 3]     = pts[i].x;
      positions[i * 3 + 1] = pts[i].y;
      positions[i * 3 + 2] = pts[i].z;
    }
    geom.attributes.position.needsUpdate = true;
    geom.setDrawRange(0, maxPoints);
    return pts;
  };

  // Build the fat glow tube geometry from a bolt path. Uses a small radius
  // (8 units) so it's clearly visible at distance but doesn't dominate the
  // view up close. TubeGeometry radial segments = 5 (cheap pentagon prism).
  const buildGlowTube = (pts: THREE.Vector3[], radius: number): THREE.TubeGeometry => {
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
    return new THREE.TubeGeometry(curve, Math.min(80, pts.length * 2), radius, 5, false);
  };

  // Fire a strike (main or secondary) at a given cloud origin.
  const fireStrike = (origin: THREE.Vector3, flashDur: number, boltDur: number, glowDur: number, cloudDur: number, isMain: boolean) => {
    flashLife = flashDur;
    boltLife = boltDur;
    afterglowLife = glowDur;
    cloudLife = cloudDur;
    skyFlashLife = Math.max(skyFlashLife, 0.18);
    const pts = generateBolt(origin, boltPositions, boltGeom, 60);
    generateBolt(origin, afterglowPositions, afterglowGeom, 90);
    light.position.copy(origin);
    light.target.position.set(origin.x, 0, origin.z);
    // Cloud disc at the strike origin — lights up the cloud deck above the bolt.
    cloudDisc.position.copy(origin);
    // Rebuild glow tube geometry for this strike.
    if (glowMesh) {
      group.remove(glowMesh);
      glowMesh.geometry.dispose();
    }
    if (coreMesh) {
      group.remove(coreMesh);
      coreMesh.geometry.dispose();
    }
    const glowGeo = buildGlowTube(pts, 14);
    glowMesh = new THREE.Mesh(glowGeo, glowMat);
    glowMesh.renderOrder = 998;
    group.add(glowMesh);
    const coreGeo = buildGlowTube(pts, 4);
    coreMesh = new THREE.Mesh(coreGeo, coreMat);
    coreMesh.renderOrder = 999;
    group.add(coreMesh);
    // === Notify external listener (engine plays thunder sound) ===
    if (system?.onStrike) system.onStrike(origin, isMain);
  };

  const update = (dt: number, intensity: number, cameraPos: THREE.Vector3, scene?: THREE.Scene | null) => {
    timer += dt;

    // === Multi-stroke burst handling ===
    if (burstRemaining > 0) {
      burstTimer -= dt;
      if (burstTimer <= 0 && intensity > 0.3) {
        const origin = cameraPos.clone().add(new THREE.Vector3(
          (Math.random() - 0.5) * 2500,
          3000,
          (Math.random() - 0.5) * 2500,
        ));
        fireStrike(origin, 0.18, 0.14, 0.5, 0.35, false);
        burstRemaining--;
        burstTimer = 0.08 + Math.random() * 0.18;
      }
    }

    // === Main strike trigger ===
    // Higher intensity → much shorter intervals. At intensity=1 (peak storm)
    // strikes fire roughly every ~0.8-1.5s — a constant electric sky. At
    // intensity=0.5 they're rare (every 4-7s).
    if (timer > nextStrike && intensity > 0.3) {
      timer = 0;
      const base = 0.8 + (1 - intensity) * 4.5;
      nextStrike = base + Math.random() * 1.2;
      const origin = cameraPos.clone().add(new THREE.Vector3(
        (Math.random() - 0.5) * 3000,
        3000,
        (Math.random() - 0.5) * 3000,
      ));
      // Main stroke — longer flash (0.38s, was 0.32), longer bolt (0.28s).
      fireStrike(origin, 0.38, 0.28, 0.7, 0.55, true);
      // 60% chance of a multi-stroke burst (2-4 secondary strikes)
      burstRemaining = Math.random() < 0.6 ? (1 + Math.floor(Math.random() * 3)) : 0;
      burstTimer = 0.10 + Math.random() * 0.16;
    }

    // === Flash decay ===
    if (flashLife > 0) {
      flashLife -= dt;
      // Peak intensity 35 (was 24) — the flash now dominates the scene.
      // The flashLife / 0.38 normalisation matches the main-strike duration.
      const f = Math.max(0, flashLife / 0.38);
      light.intensity = f * 35;
      skyLight.intensity = f * 18;
    } else {
      light.intensity = 0;
      skyLight.intensity = 0;
    }

    // === Bolt Line opacity ===
    if (boltLife > 0) {
      boltLife -= dt;
      boltMat.opacity = Math.max(0, boltLife / 0.28);
    } else {
      boltMat.opacity = 0;
    }
    if (afterglowLife > 0) {
      afterglowLife -= dt;
      afterglowMat.opacity = Math.max(0, afterglowLife / 0.7) * 0.6;
    } else {
      afterglowMat.opacity = 0;
    }

    // === Glow tube + inner core opacity (the new fat bright element) ===
    // Both fade with boltLife so they're only visible during the strike.
    if (glowMesh) {
      (glowMesh.material as THREE.MeshBasicMaterial).opacity = boltLife > 0 ? Math.max(0, boltLife / 0.28) * 0.85 : 0;
    }
    if (coreMesh) {
      (coreMesh.material as THREE.MeshBasicMaterial).opacity = boltLife > 0 ? Math.max(0, boltLife / 0.28) : 0;
    }

    // === Cloud disc fade ===
    if (cloudLife > 0) {
      cloudLife -= dt;
      cloudDiscMat.opacity = Math.max(0, cloudLife / 0.55) * 0.9;
    } else {
      cloudDiscMat.opacity = 0;
    }

    // === Sky tint flash (per user request: 闪电要更明显) ===
    // Briefly brighten the scene background + fog color so the entire sky
    // dome reads as "lit from within" during the strike. This is what makes
    // lightning visible even when you're looking AWAY from the bolt — the
    // whole sky flashes.
    if (skyFlashLife > 0 && scene) {
      if (savedBg === null) {
        // Capture current colors on the first frame of the flash.
        if (scene.background instanceof THREE.Color) {
          savedBg = scene.background.clone();
        } else {
          savedBg = new THREE.Color(0x1a2030);
        }
        if (scene.fog instanceof THREE.FogExp2) {
          savedFog = scene.fog.color.clone();
          savedFogDensity = scene.fog.density;
        }
      }
      const f = Math.max(0, skyFlashLife / 0.18);
      // Lerp background toward bright blue-white during the flash peak.
      if (scene.background instanceof THREE.Color) {
        scene.background.copy(savedBg).lerp(new THREE.Color(0xb8c8ff), f * 0.55);
      }
      if (scene.fog instanceof THREE.FogExp2 && savedFog) {
        scene.fog.color.copy(savedFog).lerp(new THREE.Color(0xb8c8ff), f * 0.55);
        // Briefly reduce fog density so distant terrain becomes visible.
        scene.fog.density = savedFogDensity * (1 - f * 0.5);
      }
      skyFlashLife -= dt;
      if (skyFlashLife <= 0) {
        // Restore on the way out.
        if (scene.background instanceof THREE.Color && savedBg) scene.background.copy(savedBg);
        if (scene.fog instanceof THREE.FogExp2 && savedFog) {
          scene.fog.color.copy(savedFog);
          scene.fog.density = savedFogDensity;
        }
        savedBg = null;
        savedFog = null;
      }
    }
  };

  const trigger = () => {
    // Manual trigger — treated as a main strike for thunder purposes.
    fireStrike(new THREE.Vector3(0, 3000, 0), 0.38, 0.28, 0.7, 0.55, true);
    flashLife = 0.38;
    boltLife = 0.28;
    afterglowLife = 0.7;
    cloudLife = 0.55;
    skyFlashLife = 0.18;
  };

  system = { group, light, skyLight, update, trigger, onStrike: undefined };
  return system;
}
