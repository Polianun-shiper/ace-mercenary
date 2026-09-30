// === Phase A: Hillaire 2020 物理大气 · 参数 + 共享 GLSL ========================
//
// 论文: Sébastien Hillaire, "A Scalable and Production Ready Sky and Atmosphere
// Rendering Technique", EGSR 2020 (UE5 的 SkyAtmosphere 就是这套)。
// 结构 (与论文/参考实现一一对应):
//   · Transmittance LUT  (256×64) —— 只依赖介质参数, 参数变了才重烤
//   · Multiscattering LUT(32×32)  —— 二阶以上散射近似成各向同性 (日出日落不发黄发脏的关键)
//   · Sky-View LUT       (192×108) —— 天球方向 → 天空辐射; 地平线附近分配更多精度
//   · Aerial Perspective LUT      —— 相机视锥体的"空气光"体积 (本文件组里是 32×32 的 2D 变体)
//
// 本文件负责: 真实地球参数 (SI 单位: 米 / 1/m) + 每帧参数对象 + uniform 打包 + 共享 GLSL。
//
// ⚠ GPU 侧单位是 **km / 1/km**, 不是米 —— 见 `createAtmosphereUniforms` 的说明:
//   bottomRadius 6_360_000 在 32bit float 里的分辨率是 0.76m, 行星半径 + 大气积分会产生
//   肉眼可见的台阶(地平线附近的密度积分对 h 的精度极敏感)。参考实现(pl-sky / UE)统一用
//   公里: 6360 的分辨率是 0.00076km = 0.76mm, 完全够用。
//
// 世界约定 (与游戏一致, 只有一处需要留意):
//   · 世界: +Y 向上, 海平面 y=0, 地图在原点 ±14km
//   · 大气空间: 行星中心在原点, 世界点 (x,y,z) → 大气点 (x, y+r0, z)
//     ⇒ 大气空间的"地方向上" = normalize(大气点); 方向向量本身两边相同 (纯平移)
//     注意: 这条映射等价于"把平面地图贴在球面上" —— 14km 处的曲率偏差 = d²/(2R) ≈ 15m,
//     28km 处 ≈ 62m。对 8km 尺度高的大气来说可以忽略; 但**地平线/黄昏带是球面几何算的**,
//     所以远距离(>100km 的掠射光线)的行为是物理正确的(太阳落到地平线下时高层大气仍被照亮)。
import * as THREE from 'three';

/** 大气介质与行星参数 (SI: 米 / 1·m⁻¹)。默认值 = 真实地球 (Bruneton/Hillaire 参考值)。 */
export interface AtmosphereParams {
  /** 行星半径 (海平面) 米 */
  bottomRadius: number;
  /** 大气顶半径 米 (= bottomRadius + 厚度) */
  topRadius: number;
  /** Rayleigh 散射系数 (每米, 海平面处), RGB 三通道 */
  rayleighScattering: THREE.Vector3;
  /** Rayleigh 密度指数尺度高 (米) */
  rayleighScaleHeight: number;
  /** Mie 散射系数 (每米, 海平面处) */
  mieScattering: THREE.Vector3;
  /** Mie 吸收系数 (每米; 消光 = 散射 + 吸收) */
  mieAbsorption: THREE.Vector3;
  /** Mie 密度指数尺度高 (米) */
  mieScaleHeight: number;
  /** Mie 相函数各向异性 (Cornette-Shanks) */
  mieG: number;
  /** Ozone 吸收系数 (每米, 峰值处) */
  ozoneAbsorption: THREE.Vector3;
  /** Ozone 层峰值高度 (米) */
  ozoneCenterHeight: number;
  /** Ozone 三角廓线的半宽 (米; |h-c| > width 时密度 0) */
  ozoneWidth: number;
  /** 地面反照率 (0..1) */
  groundAlbedo: number;
  /** 大气层顶太阳辐照度 (每通道, 参考实现单位) —— 全局亮度标定就建在它上面 */
  solarIrradiance: THREE.Vector3;
  /** 太阳角半径 (弧度; 真实值 0.2666° = 0.004652 rad) */
  sunAngularRadius: number;
}

/** 真实地球大气 (论文/UE 默认值)。 */
export const EARTH_ATMOSPHERE: AtmosphereParams = {
  bottomRadius: 6_360_000,
  topRadius: 6_420_000, // 60km 大气厚度
  // βR = (5.8e-6, 13.5e-6, 33.1e-6) 1/m @ 海平面 (Bruneton 2017 标准值)
  rayleighScattering: new THREE.Vector3(5.802e-6, 13.558e-6, 33.1e-6),
  rayleighScaleHeight: 8000,
  mieScattering: new THREE.Vector3(3.996e-6, 3.996e-6, 3.996e-6),
  mieAbsorption: new THREE.Vector3(0.444e-6, 0.444e-6, 0.444e-6),
  mieScaleHeight: 1200,
  mieG: 0.8,
  // 臭氧只吸收不散射; R 通道弱(蓝绿被吃 ⇒ 黄昏的橙红), 峰值 25km
  ozoneAbsorption: new THREE.Vector3(0.650e-6, 1.881e-6, 0.085e-6),
  ozoneCenterHeight: 25_000,
  ozoneWidth: 15_000,
  groundAlbedo: 0.1,
  solarIrradiance: new THREE.Vector3(1.474, 1.8504, 1.91198),
  sunAngularRadius: 0.004675,
};

export function cloneAtmosphereParams(p: AtmosphereParams = EARTH_ATMOSPHERE): AtmosphereParams {
  return {
    ...p,
    rayleighScattering: p.rayleighScattering.clone(),
    mieScattering: p.mieScattering.clone(),
    mieAbsorption: p.mieAbsorption.clone(),
    ozoneAbsorption: p.ozoneAbsorption.clone(),
    solarIrradiance: p.solarIrradiance.clone(),
  };
}

/**
 * 每帧参数 ("每帧可用"的参数对象 —— 天空/AP 两侧共用同一个实例, 每帧由 engine 填)。
 * 全部是"运行时输入", 不是介质常数(介质常数在上面的 AtmosphereParams 里, 变了要重烤 LUT)。
 */
export interface AtmosphereFrame {
  /** 太阳方向 (世界空间, 归一化; 从场景指向太阳) */
  sunDirection: THREE.Vector3;
  /** 相机世界坐标 (米) */
  cameraPosition: THREE.Vector3;
  /** 辐射亮度倍率 —— 全模型的亮度标定(唯一需要现场调的标量), 见 AtmosphereSystem.radianceScale */
  radianceScale: number;
  /** 太阳圆盘的亮度倍率(相对 solarIrradiance) */
  sunDiscScale: number;
  /** 太阳圆盘的光晕强度(米氏前向散射, 0 = 关) */
  sunHalo: number;
  /** 多次散射开关 (关掉 = 回到"只有一次散射"的脏黄昏, 现场 A/B 用) */
  multiscatter: boolean;
  /** 臭氧开关 (现场 A/B: 关掉后黄昏/黎明会失去那层蓝紫) */
  ozone: boolean;
  /** 气溶胶(Mie)倍率 —— 天气(turbidity)映射进来的雾霾浓度 */
  mieScale: number;
  /** 玩家机体遮罩相关由 AP pass 自己管; 这里只放"大气"本身 */
  enabled: boolean;
}

export function createAtmosphereFrame(): AtmosphereFrame {
  return {
    sunDirection: new THREE.Vector3(0.35, 0.37, -0.86).normalize(),
    cameraPosition: new THREE.Vector3(),
    radianceScale: 26,
    sunDiscScale: 12,
    sunHalo: 1,
    multiscatter: true,
    ozone: true,
    mieScale: 1,
    enabled: true,
  };
}

/** 共享 uniform(所有大气着色器共用一个对象集 ⇒ 改一处全体生效, 不用逐材质同步)。 */
export interface AtmosphereUniforms {
  [key: string]: THREE.IUniform;
  uAtmBottomRadius: THREE.IUniform<number>;
  uAtmTopRadius: THREE.IUniform<number>;
  uAtmAtmoHeight: THREE.IUniform<number>;
  uAtmRayleighScatter: THREE.IUniform<THREE.Vector3>;
  uAtmInvRayleighH: THREE.IUniform<number>;
  uAtmMieScatter: THREE.IUniform<THREE.Vector3>;
  uAtmMieExtinction: THREE.IUniform<THREE.Vector3>;
  uAtmInvMieH: THREE.IUniform<number>;
  uAtmMieG: THREE.IUniform<number>;
  uAtmMieScale: THREE.IUniform<number>;
  uAtmOzoneAbsorb: THREE.IUniform<THREE.Vector3>;
  uAtmOzoneCenter: THREE.IUniform<number>;
  uAtmInvOzoneWidth: THREE.IUniform<number>;
  uAtmOzoneOn: THREE.IUniform<number>;
  uAtmGroundAlbedo: THREE.IUniform<number>;
  uAtmSolarIrradiance: THREE.IUniform<THREE.Vector3>;
  uAtmSunAngularRadius: THREE.IUniform<number>;
  // per-frame
  uAtmSunDir: THREE.IUniform<THREE.Vector3>;
  uAtmCameraKm: THREE.IUniform<THREE.Vector3>;
  uAtmViewHeight: THREE.IUniform<number>;
  uAtmUpDir: THREE.IUniform<THREE.Vector3>;
  uAtmRadianceScale: THREE.IUniform<number>;
  uAtmSunDiscScale: THREE.IUniform<number>;
  uAtmSunHalo: THREE.IUniform<number>;
  uAtmMultiScatterOn: THREE.IUniform<number>;
}

const KM = 1e-3;

/**
 * 打包成 uniform。介质常数一次性写好(参数变化时由 AtmosphereSystem 重新调用),
 * 每帧变化的量由 `feedAtmosphereFrame` 写。
 */
export function createAtmosphereUniforms(p: AtmosphereParams = EARTH_ATMOSPHERE): AtmosphereUniforms {
  const u = {
    uAtmBottomRadius: { value: p.bottomRadius * KM },
    uAtmTopRadius: { value: p.topRadius * KM },
    uAtmAtmoHeight: { value: (p.topRadius - p.bottomRadius) * KM },
    // 1/m → 1/km (乘 1000)
    uAtmRayleighScatter: { value: p.rayleighScattering.clone().multiplyScalar(1000) },
    uAtmInvRayleighH: { value: 1 / (p.rayleighScaleHeight * KM) },
    uAtmMieScatter: { value: p.mieScattering.clone().multiplyScalar(1000) },
    uAtmMieExtinction: {
      value: p.mieScattering.clone().add(p.mieAbsorption).multiplyScalar(1000),
    },
    uAtmInvMieH: { value: 1 / (p.mieScaleHeight * KM) },
    uAtmMieG: { value: p.mieG },
    uAtmMieScale: { value: 1 },
    uAtmOzoneAbsorb: { value: p.ozoneAbsorption.clone().multiplyScalar(1000) },
    uAtmOzoneCenter: { value: p.ozoneCenterHeight * KM },
    uAtmInvOzoneWidth: { value: 1 / (p.ozoneWidth * KM) },
    uAtmOzoneOn: { value: 1 },
    uAtmGroundAlbedo: { value: p.groundAlbedo },
    uAtmSolarIrradiance: { value: p.solarIrradiance.clone() },
    uAtmSunAngularRadius: { value: p.sunAngularRadius },
    uAtmSunDir: { value: new THREE.Vector3(0.35, 0.37, -0.86).normalize() },
    uAtmCameraKm: { value: new THREE.Vector3(0, p.bottomRadius * KM, 0) },
    uAtmViewHeight: { value: p.bottomRadius * KM },
    uAtmUpDir: { value: new THREE.Vector3(0, 1, 0) },
    uAtmRadianceScale: { value: 26 },
    uAtmSunDiscScale: { value: 12 },
    uAtmSunHalo: { value: 1 },
    uAtmMultiScatterOn: { value: 1 },
  } as unknown as AtmosphereUniforms;
  return u;
}

/** 把世界坐标转成大气空间坐标 (km): (x, y + bottomRadius, z) / 1000 */
export function worldToAtmosphereKm(
  world: THREE.Vector3,
  p: AtmosphereParams,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  return out.set(
    world.x * KM,
    world.y * KM + p.bottomRadius * KM,
    world.z * KM,
  );
}

/** 每帧写"运行时"uniform。相机在**世界**里的位置 → 大气空间 km。 */
export function feedAtmosphereFrame(
  u: AtmosphereUniforms,
  frame: AtmosphereFrame,
  p: AtmosphereParams = EARTH_ATMOSPHERE,
): void {
  u.uAtmSunDir.value.copy(frame.sunDirection).normalize();
  worldToAtmosphereKm(frame.cameraPosition, p, u.uAtmCameraKm.value);
  u.uAtmViewHeight.value = Math.max(u.uAtmCameraKm.value.length(), p.bottomRadius * KM);
  u.uAtmUpDir.value.copy(u.uAtmCameraKm.value).normalize();
  u.uAtmRadianceScale.value = frame.radianceScale;
  u.uAtmSunDiscScale.value = frame.sunDiscScale;
  u.uAtmSunHalo.value = frame.sunHalo;
  u.uAtmMultiScatterOn.value = frame.multiscatter ? 1 : 0;
  u.uAtmOzoneOn.value = frame.ozone ? 1 : 0;
  u.uAtmMieScale.value = Math.max(0.05, frame.mieScale);
}

/**
 * LUT 尺寸 —— **唯一真相源**: TS 侧建 RT 与 GLSL 侧的采样钳制都从这里取,
 * 不可能对不上 (改一个数字两边一起动)。
 */
export const LUT_SIZES = {
  /** 透过率 LUT (宽 = 天顶角余弦轴, 高 = 半径轴) */
  transmittance: [256, 64] as const,
  /** 多次散射 LUT (x = 高度, y = 太阳天顶角余弦) */
  multiscatter: [32, 32] as const,
  /** 天空 LUT (x = cos(方位差), y = 视线天顶角) */
  skyView: [192, 108] as const,
  /** 空气光 LUT 的 2D 变体 (x = 距离, y = 视线天顶角) */
  aerial: [32, 32] as const,
};

/**
 * 共享 GLSL —— 所有大气着色器(LUT 烘烤 + 天空 + 空气光)都拼这段。
 *
 * ⚠ 单位: 位置/半径/尺度高全部 **km**, 散射系数 **1/km**, 高度 h = |p| - bottomRadius (km)。
 * ⚠ 命名统一 `atmo*`; 不支持 GLSL ES 1.00 的写法(数组动态索引/uint)一律避免。
 */
export const ATMO_COMMON_GLSL = /* glsl */ `
#define ATMO_PI 3.141592653589793

// === 共享 uniform 声明 (所有大气着色器共用同一个 uniform 对象集, 名字必须一致) ===
// 介质常数 (km / 1/km)
uniform float uAtmBottomRadius;
uniform float uAtmTopRadius;
uniform float uAtmAtmoHeight;
uniform vec3  uAtmRayleighScatter;
uniform float uAtmInvRayleighH;
uniform vec3  uAtmMieScatter;
uniform vec3  uAtmMieExtinction;
uniform float uAtmInvMieH;
uniform float uAtmMieG;
uniform float uAtmMieScale;
uniform vec3  uAtmOzoneAbsorb;
uniform float uAtmOzoneCenter;
uniform float uAtmInvOzoneWidth;
uniform float uAtmOzoneOn;
uniform float uAtmGroundAlbedo;
uniform vec3  uAtmSolarIrradiance;
uniform float uAtmSunAngularRadius;
// 每帧
uniform vec3  uAtmSunDir;        // 世界空间, 归一化(指向太阳)
uniform vec3  uAtmCameraKm;      // 相机的大气空间坐标 (km)
uniform float uAtmViewHeight;    // |相机大气坐标| (km)
uniform vec3  uAtmUpDir;         // 地方向上(世界/大气同向)
uniform float uAtmRadianceScale;
uniform float uAtmSunDiscScale;
uniform float uAtmSunHalo;
uniform float uAtmMultiScatterOn;

// LUT 尺寸 (由 LUT_SIZES 注入, 与 TS 建 RT 用的是同一组数)
#define ATMO_TRANS_W ${LUT_SIZES.transmittance[0]}.0
#define ATMO_TRANS_H ${LUT_SIZES.transmittance[1]}.0
#define ATMO_MS_W ${LUT_SIZES.multiscatter[0]}.0
#define ATMO_MS_H ${LUT_SIZES.multiscatter[1]}.0
#define ATMO_SKY_W ${LUT_SIZES.skyView[0]}.0
#define ATMO_SKY_H ${LUT_SIZES.skyView[1]}.0
#define ATMO_AP_W ${LUT_SIZES.aerial[0]}.0
#define ATMO_AP_H ${LUT_SIZES.aerial[1]}.0
#define ATMO_AP_SLICES ${LUT_SIZES.aerial[0]}

// --- 密度廓线 (Hillaire/Rayleigh 指数 + Ozone 三角) -----------------------------
// ⚠ 全部把 h 夹到 ≥ 0 —— **这是踩过的坑**: 掠射/退化光线下采样点会落到行星内部
//   (h 很负), exp(-h/H) 会直接溢出成 Inf ⇒ 整张 LUT 变 Inf/NaN ⇒ 天空全黑。
//   (参考实现靠 PLANET_RADIUS_OFFSET 规避; 这里用夹紧, 更硬: 即使光线真的穿进星球内部,
//    也只是"密度饱和在地面值 + 透过率归零", 数值永远有限。)
float atmoRayleighDensity(float h) { return exp(-max(h, 0.0) * uAtmInvRayleighH); }
float atmoMieDensity(float h) { return exp(-max(h, 0.0) * uAtmInvMieH) * uAtmMieScale; }
float atmoOzoneDensity(float h) {
  return max(0.0, 1.0 - abs(max(h, 0.0) - uAtmOzoneCenter) * uAtmInvOzoneWidth) * uAtmOzoneOn;
}
vec3 atmoScatterRayleigh(float h) { return uAtmRayleighScatter * exp(-max(h, 0.0) * uAtmInvRayleighH); }
vec3 atmoScatterMie(float h) { return uAtmMieScatter * atmoMieDensity(h); }
vec3 atmoExtinction(float h) {
  float hh = max(h, 0.0);
  return uAtmRayleighScatter * exp(-hh * uAtmInvRayleighH)
       + uAtmMieExtinction * atmoMieDensity(hh)
       + uAtmOzoneAbsorb * atmoOzoneDensity(hh);
}

// --- 相函数 -------------------------------------------------------------------
float atmoRayleighPhase(float c) {
  return 3.0 / (16.0 * ATMO_PI) * (1.0 + c * c);
}
// Cornette-Shanks (各向异性米氏; g=0.8 时前向瓣很窄 ⇒ 太阳附近的光晕/雾的迎光发光)
float atmoMiePhase(float c, float g) {
  float g2 = g * g;
  float denom = max(1.0 + g2 - 2.0 * g * c, 1e-6);
  return 3.0 / (8.0 * ATMO_PI) * (1.0 - g2) * (1.0 + c * c) / ((2.0 + g2) * pow(denom, 1.5));
}

// --- 射线/球求交 (大气空间, 行星中心 = 原点) ------------------------------------
// 返回最近的非负交点, 没交返回 -1。
float atmoRaySphereNearest(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float disc = b * b - c;
  if (disc < 0.0) return -1.0;
  float s = sqrt(disc);
  float t0 = -b - s;
  float t1 = -b + s;
  if (t0 >= 0.0) return t0;
  if (t1 >= 0.0) return t1;
  return -1.0;
}

// 从大气内部出发的一条光线: 走到大气顶, 或(更近时)打到地面。
// hitGround = 该视线被行星挡住; tGround 同时回传(AP 体积需要在"地面处"截断)。
float atmoRayExit(vec3 ro, vec3 rd, out bool hitGround, out float tGround) {
  tGround = atmoRaySphereNearest(ro, rd, uAtmBottomRadius);
  float tTop = atmoRaySphereNearest(ro, rd, uAtmTopRadius);
  hitGround = tGround >= 0.0 && (tTop < 0.0 || tGround < tTop);
  if (hitGround) return tGround;
  return max(tTop, 0.0);
}

// 格点中心 → 单位 uv / 反向 (避免双线性插值跨过 LUT 边界)
float atmoSubToUnit(float u, float res) {
  return clamp((u * res - 0.5) / max(res - 1.0, 1.0), 0.0, 1.0);
}
float atmoUnitToSub(float u, float res) {
  return (clamp(u, 0.0, 1.0) * max(res - 1.0, 1.0) + 0.5) / res;
}

// --- Transmittance LUT 参数化 (Bruneton 2017, 与 UE/参考实现一致) ----------------
//   uv.x → 太阳天顶角余弦 mu, uv.y → 半径 r
//   "地平线附近分配更多精度": 这条参数化按"到大气顶的距离 d"均匀切, 掠射方向(d_max=rho+H)
//   与垂射方向(d_min=Rt-r)各占一半 ⇒ 地平线附近的 mu 分辨率远高于线性映射。
void atmoUvToRMu(vec2 uv, out float r, out float mu) {
  float H = sqrt(max(uAtmTopRadius * uAtmTopRadius - uAtmBottomRadius * uAtmBottomRadius, 0.0));
  float rho = H * clamp(uv.y, 0.0, 1.0);
  r = sqrt(rho * rho + uAtmBottomRadius * uAtmBottomRadius);
  float dMin = uAtmTopRadius - r;
  float dMax = rho + H;
  float d = dMin + clamp(uv.x, 0.0, 1.0) * (dMax - dMin);
  mu = d <= 0.0 ? 1.0 : (H * H - rho * rho - d * d) / (2.0 * r * d);
  mu = clamp(mu, -1.0, 1.0);
}

vec2 atmoRMuToUv(float r, float mu) {
  float H = sqrt(max(uAtmTopRadius * uAtmTopRadius - uAtmBottomRadius * uAtmBottomRadius, 0.0));
  float rho = sqrt(max(r * r - uAtmBottomRadius * uAtmBottomRadius, 0.0));
  float disc = r * r * (mu * mu - 1.0) + uAtmTopRadius * uAtmTopRadius;
  float d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  float dMin = uAtmTopRadius - r;
  float dMax = rho + H;
  return vec2((d - dMin) / max(dMax - dMin, 1e-6), rho / max(H, 1e-6));
}

// 太阳被行星挡住的角度阈值: mu < atmoHorizonMu(h) ⇒ 该点在行星阴影里(只有多次散射)。
float atmoHorizonMu(float r) {
  float t = clamp(uAtmBottomRadius / max(r, 1e-6), 0.0, 1.0);
  return -sqrt(max(1.0 - t * t, 0.0));
}

// 采样透过率 LUT: (r, mu) → RGB 透过率。
//   · mu 低于地平线阈值 ⇒ 0(被行星挡住), 用很窄的平滑过渡避免 terminator 出现硬边
//   · 其余 ⇒ 双线性采样 + 边界钳制
vec3 atmoSampleTransmittance(sampler2D lut, float r, float mu) {
  float muH = atmoHorizonMu(r);
  float soft = smoothstep(muH, muH + 0.0035, mu);
  if (soft <= 0.0) return vec3(0.0);
  vec2 uv = clamp(atmoRMuToUv(r, clamp(mu, -1.0, 1.0)),
                  vec2(0.5 / ATMO_TRANS_W, 0.5 / ATMO_TRANS_H),
                  vec2(1.0 - 0.5 / ATMO_TRANS_W, 1.0 - 0.5 / ATMO_TRANS_H));
  return texture2D(lut, uv).rgb * soft;
}

// --- Sky-View LUT 的参数化 (Hillaire 的 y 轴非线性 + 太阳方位 cos 的 x 轴) --------
//   uv.y: 0 = 天顶, 0.5 = 几何地平线, 1 = 天底(地面)。地平线附近按 sqrt 分配更多精度。
//   uv.x: cos(视线方位 - 太阳方位), 归一化到 [0,1] 并按 sqrt 集中在地平/太阳侧。
// 这套映射与 LUT 的烘烤、天空着色器、AP LUT 的 y 轴**共用同一份实现**, 保证不会对不上。
float atmoZenithToUvY(float zenith, float viewHeight) {
  float horizonDist = sqrt(max(viewHeight * viewHeight - uAtmBottomRadius * uAtmBottomRadius, 0.0));
  float cosBeta = clamp(horizonDist / max(viewHeight, 1e-6), 0.0, 1.0);
  float beta = acos(cosBeta);
  float zToH = ATMO_PI - beta;                 // 天顶 → 几何地平线的夹角
  if (zenith <= zToH) {
    float c = zenith / max(zToH, 1e-6);
    c = 1.0 - c;
    c = sqrt(max(c, 0.0));
    return (1.0 - c) * 0.5;
  }
  float c = (zenith - zToH) / max(beta, 1e-6);
  return 0.5 + sqrt(clamp(c, 0.0, 1.0)) * 0.5;
}

float atmoUvYToZenith(float uvY, float viewHeight) {
  float horizonDist = sqrt(max(viewHeight * viewHeight - uAtmBottomRadius * uAtmBottomRadius, 0.0));
  float cosBeta = clamp(horizonDist / max(viewHeight, 1e-6), 0.0, 1.0);
  float beta = acos(cosBeta);
  float zToH = ATMO_PI - beta;
  float v = clamp(uvY, 0.0, 1.0);
  if (v < 0.5) {
    float c = v * 2.0;
    c = 1.0 - c;
    c = c * c;
    return zToH * (1.0 - c);
  }
  float c = v * 2.0 - 1.0;
  return zToH + beta * c * c;
}

float atmoLightViewCosToUvX(float c) {
  return sqrt(clamp(-c * 0.5 + 0.5, 0.0, 1.0));
}
float atmoUvXToLightViewCos(float uvX) {
  float c = clamp(uvX, 0.0, 1.0);
  c = c * c;
  return -(c * 2.0 - 1.0);
}

// --- Aerial Perspective LUT 的 x 轴 (距离) ------------------------------------
//   d = maxDist * (u^exp): 近处密、远处疏 (大气透视的变化量近处最大)。
float atmoAerialSliceDistance(float uvX, float maxDist, float exponent) {
  return maxDist * pow(clamp(uvX, 0.0, 1.0), exponent);
}
float atmoAerialDistanceToUvX(float d, float maxDist, float exponent) {
  return pow(clamp(d / max(maxDist, 1e-6), 0.0, 1.0), 1.0 / max(exponent, 1e-6));
}

// --- 沿一段"介质近似均匀"的路径解析积分源项: ∫ S·exp(-σt) dt ------------------
//   (参考实现同一写法; σ→0 时退化成线性避免除零)
vec3 atmoIntegrateSource(vec3 source, vec3 extinction, float len) {
  vec3 tSeg = exp(-extinction * len);
  vec3 safe = max(extinction, vec3(1e-7));
  vec3 analytic = source * (vec3(1.0) - tSeg) / safe;
  return mix(analytic, source * len, vec3(lessThan(abs(extinction), vec3(1e-7))));
}

// --- 构造"太阳平面"内的视线方向 -----------------------------------------------
//   规范坐标: up = +Y, 太阳的水平方向 = +X ⇒ 太阳方向 = (sinS, cosS, 0)。
//   viewDir = (sinθ·cosΔ, cosθ, sinθ·sinΔ), cosΔ = cos(视线方位 - 太阳方位)。
//   Δ → -Δ 是"关于太阳-天顶平面的镜像", 而介质球对称 + 太阳在平面内 ⇒ 两侧辐射相同,
//   所以 LUT 的 x 轴只需要覆盖 cosΔ ∈ [-1,1] 就能代表整圈方位。
vec3 atmoViewDirInSunPlane(float zenith, float cAz) {
  float sT = sin(zenith);
  float sA = sqrt(max(1.0 - cAz * cAz, 0.0));
  return vec3(sT * cAz, cos(zenith), sT * sA);
}

// 规范坐标下的太阳方向 (天顶角 rad)
vec3 atmoSunDirInPlane(float sunZenith) {
  return vec3(sin(sunZenith), cos(sunZenith), 0.0);
}

// 世界/大气空间: cos(视线方位 - 太阳方位)。赤道侧退化(太阳正好在天顶/天底)时返回 1。
float atmoAzimuthCos(vec3 rd, vec3 up, vec3 sunDir) {
  vec3 a = rd - up * dot(rd, up);
  vec3 b = sunDir - up * dot(sunDir, up);
  float la = length(a);
  float lb = length(b);
  if (la < 1e-5 || lb < 1e-5) return 1.0;
  return clamp(dot(a, b) / (la * lb), -1.0, 1.0);
}

// --- 太阳可见性/透过率 --------------------------------------------------------
//   p: 大气空间点 (km); dir: 太阳方向(世界/大气同向, 单位向量)。
//   返回 RGB 太阳透过率(含行星阴影软过渡)。
vec3 atmoSunTransmittance(sampler2D transLut, vec3 p, vec3 sunDir) {
  float r = length(p);
  float h = r - uAtmBottomRadius;
  float mu = dot(p / max(r, 1e-6), sunDir);
  if (h <= 0.0 && mu <= 0.0) return vec3(0.0);
  return atmoSampleTransmittance(transLut, r, mu);
}

// --- 介质采样 (h 由位置推) ----------------------------------------------------
void atmoMediumAt(vec3 p, out vec3 scatRay, out vec3 scatMie, out vec3 extinction) {
  float h = max(length(p) - uAtmBottomRadius, 0.0);
  scatRay = atmoScatterRayleigh(h);
  scatMie = atmoScatterMie(h);
  extinction = atmoExtinction(h);
}

// LUT 写出前的保险: 把不可能的值夹掉。物理上一张 LUT 的峰值远小于 1000,
// 而 HalfFloat 的上限是 65504 —— 一旦某个 texel 溢出成 Inf, 采样它的着色器
// 会算出 Inf/Inf = NaN, 整帧变黑(实测踩过)。这里给个硬的有限性保证。
vec3 atmoClampRadiance(vec3 v) {
  return clamp(v, vec3(0.0), vec3(1000.0));
}
`;
