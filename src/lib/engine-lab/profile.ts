/**
 * EngineLab — 高画质空战渲染引擎 · 配置模型
 * =====================================================================
 * 这是用户在「引擎实验室」UI 中调整的所有渲染参数的权威数据模型。
 * 用户在实验室里调好后点「保存为预设」会写到 localStorage；
 * 点「应用到游戏」会把当前预设标记为 active，下一次启动任务时
 * GameEngine 会读取这个 active 预设并把所有参数应用到场景里。
 *
 * 关键字段分组：
 *  - pipeline:        渲染管线模式 (deferred / forward)
 *  - resolution:      分辨率缩放、像素比上限
 *  - shadows:         自阴影 + CSM 级联 + 软阴影 + 接触阴影
 *  - sky:             UE5 风格大气散射天光 (瑞利 + 米氏)
 *  - lighting:        太阳强度 / 方位 / 仰角 / 颜色温度
 *  - ao:              屏幕空间环境光遮蔽 (SSAO/GTAO 近似)
 *  - bloom:           多尺度泛光 (mipmap blur)
 *  - dof:             景深 (Tilt-shift 风格，聚焦于机体)
 *  - motionBlur:      运动模糊 (基于速度缓冲)
 *  - toneMapping:     ACES / AgX / Reinhard / Filmic
 *  - colorGrading:    对比度 / 饱和度 / 色温 / 色调
 *  - volumetric:      体积雾 / 上帝之光 (屏幕空间后处理雾)
 *  - clouds:          体积云 (光线步进式厚云层, 高空覆盖)
 *  - pbr:             环境贴图强度、IBL 模糊
 *  - performance:     目标帧率、自适应降级阈值
 *
 * 注意: volumetric 与 clouds 是两个互相独立的系统:
 *   - volumetric: 屏幕空间雾 (低空/远景染色, 永远在画面上)
 *   - clouds:     光线步进式体积云 (高空厚云层, 可开关, 可调质量)
 */

import {
  DEFAULT_CLOUD_PROFILE,
  CINEMATIC_CLOUD_PROFILE,
  PERFORMANCE_CLOUD_PROFILE,
  MINIMAL_CLOUD_PROFILE,
} from '@/lib/clouds/params';
import type { CloudProfile } from '@/lib/clouds/params';
export type { CloudProfile, CloudQuality } from '@/lib/clouds/params';

export type Pipeline = 'deferred' | 'forward';
export type ShadowQuality = 'low' | 'medium' | 'high' | 'ultra';
export type ToneMappingMode = 'ACES' | 'AgX' | 'Reinhard' | 'Filmic' | 'None';
export type AOMethod = 'off' | 'ssao' | 'gtao';
export type Antialiasing = 'off' | 'fxaa' | 'smaa' | 'msaa-2x' | 'msaa-4x';
export type PresetBuiltin = 'cinematic' | 'balanced' | 'performance' | 'minimal' | 'custom';

export interface EngineProfile {
  /** 预设名（用户可命名） */
  name: string;
  /** 内置预设类型 */
  preset: PresetBuiltin;
  /** schema 版本，便于未来迁移 */
  version: number;

  // ─── 渲染管线 ───────────────────────────────────────
  pipeline: Pipeline;
  /** 0.5-1.5 之间的分辨率缩放，<1 时降采样换帧率 */
  resolutionScale: number;
  /** devicePixelRatio 上限，4K 屏上限制为 1.5 避免炸帧 */
  pixelRatioCap: number;
  antialiasing: Antialiasing;

  // ─── 阴影 ───────────────────────────────────────────
  shadows: {
    enabled: boolean;
    /** 自阴影开关 — 机体部件互相投影到自身 */
    selfShadow: boolean;
    /** CSM 级联数 1-4 */
    cascades: 1 | 2 | 3 | 4;
    quality: ShadowQuality;
    /** 阴影贴图分辨率 (512/1024/2048/4096) */
    mapSize: 512 | 1024 | 2048 | 4096;
    /** PCF 软阴影半径 (0-1) */
    softness: number;
    /** 阴影偏置 (避免 shadow acne) */
    bias: number;
    /** 法线偏置 (避免锯齿) */
    normalBias: number;
    /** 接触阴影 — 屏幕空间短距离射线，强化机体接地感 */
    contactShadows: boolean;
    contactRadius: number;
    contactOpacity: number;
  };

  // ─── 天光 / 大气 ────────────────────────────────────
  sky: {
    /** UE5 风格大气散射 (Rayleigh + Mie) */
    atmosphericScattering: boolean;
    /** 太阳方位角 (度, 0=北, 90=东) */
    sunAzimuth: number;
    /** 太阳仰角 (度, 0=地平线, 90=正午) */
    sunElevation: number;
    /** 大气浊度 (1-10, 越大雾越浓) */
    turbidity: number;
    /** 瑞利散射强度 (天空蓝度) */
    rayleigh: number;
    /** 米氏散射强度 (太阳光晕) */
    mieCoefficient: number;
    /** 米氏散射方向 (太阳光线方向性, 0.7-0.9 接近真实) */
    mieDirectionalG: number;
    /** 地平线色温 (温暖 → 冷) */
    horizonTint: number;
    /** 远景大气透视距离 (km) */
    perspectiveDistance: number;
    /** 上帝之光 (god rays) */
    godRays: boolean;
    godRaysIntensity: number;
  };

  // ─── 灯光 ───────────────────────────────────────────
  lighting: {
    sunIntensity: number;          // 太阳光强度 (lux 近似)
    sunColorTemperature: number;   // 5500K = 标准日光
    ambientIntensity: number;      // 环境光
    hemisphereSkyColor: string;    // 上半球天光色
    hemisphereGroundColor: string; // 下半球反射色
    /** IBL 环境贴图强度 — PBR 反射用 */
    environmentIntensity: number;
  };

  // ─── 环境光遮蔽 ─────────────────────────────────────
  ao: {
    method: AOMethod;
    radius: number;        // 采样半径
    intensity: number;     // 遮蔽强度
    bias: number;          // 偏置
    /** 远距离衰减，让 AO 集中在近景 */
    distanceAttenuation: number;
  };

  // ─── Bloom ──────────────────────────────────────────
  bloom: {
    enabled: boolean;
    strength: number;
    radius: number;
    threshold: number;
    /** mipmap 多尺度模糊，更接近摄影泛光 */
    mipmapBlur: boolean;
  };

  // ─── 景深 ───────────────────────────────────────────
  dof: {
    enabled: boolean;
    focusDistance: number;  // 聚焦距离 (m)
    aperture: number;       // 光圈大小，越大景深越浅
    /** 自动对焦到玩家机体 */
    autofocus: boolean;
  };

  // ─── 运动模糊 ───────────────────────────────────────
  motionBlur: {
    enabled: boolean;
    strength: number;       // 0-1
    /** 仅在高速飞行时启用 (基于速度) */
    velocityThreshold: number;
  };

  // ─── 色调映射 ───────────────────────────────────────
  toneMapping: {
    mode: ToneMappingMode;
    exposure: number;       // 0.5-2.0
    /** 伽马 */
    gamma: number;
  };

  // ─── 调色 ───────────────────────────────────────────
  colorGrading: {
    contrast: number;     // 0.5-1.5
    saturation: number;   // 0-2
    temperature: number;  // -100 (冷) - 100 (暖)
    tint: number;         // -100 (绿) - 100 (品)
    /** 暗部抬升 (lift) */
    lift: number;
    /** 高光压制 */
    highlights: number;
  };

  // ─── 体积雾 ─────────────────────────────────────────
  volumetric: {
    enabled: boolean;
    density: number;
    /** 雾色 */
    color: string;
    /** 雾高度衰减 (海拔越高雾越淡) */
    heightFalloff: number;
  };

  // ─── 体积云 (光线步进式) ─────────────────────────────
  clouds: CloudProfile;

  // ─── 性能 ───────────────────────────────────────────
  performance: {
    targetFps: 30 | 60 | 120;
    /** 自适应降级：当连续 N 帧低于阈值时自动降低分辨率 */
    adaptiveScaling: boolean;
    adaptiveMinScale: number;  // 最低降采样到 0.5
    /** 远景实例合并 (LOD) */
    instancing: boolean;
    /** 视锥裁剪 */
    frustumCulling: boolean;
  };
}

// ─── 默认预设 ──────────────────────────────────────────

const base: EngineProfile = {
  name: 'Balanced',
  preset: 'balanced',
  version: 1,
  pipeline: 'deferred',
  resolutionScale: 1.0,
  pixelRatioCap: 1.5,
  antialiasing: 'fxaa',
  shadows: {
    enabled: true,
    selfShadow: true,
    cascades: 4,
    quality: 'high',
    mapSize: 2048,
    softness: 0.6,
    bias: -0.0005,
    normalBias: 0.5,
    contactShadows: true,
    contactRadius: 8,
    contactOpacity: 0.85,
  },
  sky: {
    atmosphericScattering: true,
    sunAzimuth: 135,
    sunElevation: 55,
    turbidity: 5,
    rayleigh: 2.5,
    mieCoefficient: 0.005,
    mieDirectionalG: 0.8,
    horizonTint: 0.0,
    perspectiveDistance: 30,
    godRays: true,
    godRaysIntensity: 0.6,
  },
  lighting: {
    sunIntensity: 3.5,
    sunColorTemperature: 5500,
    ambientIntensity: 0.4,
    hemisphereSkyColor: '#a8c8ff',
    hemisphereGroundColor: '#3a2a1a',
    environmentIntensity: 0.8,
  },
  ao: {
    method: 'gtao',
    radius: 0.5,
    intensity: 1.2,
    bias: 0.025,
    distanceAttenuation: 1.0,
  },
  bloom: {
    enabled: true,
    strength: 0.7,
    radius: 0.6,
    threshold: 0.85,
    mipmapBlur: true,
  },
  dof: {
    enabled: false,
    focusDistance: 80,
    aperture: 0.025,
    autofocus: true,
  },
  motionBlur: {
    enabled: true,
    strength: 0.35,
    velocityThreshold: 200,
  },
  toneMapping: {
    mode: 'ACES',
    exposure: 1.1,
    gamma: 2.2,
  },
  colorGrading: {
    contrast: 1.05,
    saturation: 1.1,
    temperature: 8,
    tint: 0,
    lift: 0.04,
    highlights: 0.95,
  },
  volumetric: {
    enabled: true,
    density: 0.0015,
    color: '#b8c8d8',
    heightFalloff: 0.0008,
  },
  clouds: { ...DEFAULT_CLOUD_PROFILE },
  performance: {
    targetFps: 60,
    adaptiveScaling: true,
    adaptiveMinScale: 0.6,
    instancing: true,
    frustumCulling: true,
  },
};

/** 电影级预设 — 全开画质 */
export const CINEMATIC_PROFILE: EngineProfile = {
  ...base,
  name: 'Cinematic',
  preset: 'cinematic',
  resolutionScale: 1.0,
  pixelRatioCap: 2.0,
  antialiasing: 'msaa-4x',
  shadows: {
    ...base.shadows,
    cascades: 4,
    quality: 'ultra',
    mapSize: 4096,
    softness: 0.8,
    contactShadows: true,
    contactRadius: 12,
  },
  bloom: { ...base.bloom, strength: 0.95, radius: 0.8, threshold: 0.78 },
  dof: { ...base.dof, enabled: true, aperture: 0.04 },
  ao: { ...base.ao, method: 'gtao', radius: 0.7, intensity: 1.5 },
  motionBlur: { ...base.motionBlur, strength: 0.5 },
  toneMapping: { ...base.toneMapping, mode: 'AgX', exposure: 1.15 },
  colorGrading: { ...base.colorGrading, contrast: 1.12, saturation: 1.18 },
  clouds: { ...CINEMATIC_CLOUD_PROFILE },
  performance: { ...base.performance, targetFps: 60, adaptiveScaling: false },
};

/** 平衡预设 — 60fps 目标 (默认) */
export const BALANCED_PROFILE: EngineProfile = { ...base };

/** 性能预设 — 低配机流畅运行 */
export const PERFORMANCE_PROFILE: EngineProfile = {
  ...base,
  name: 'Performance',
  preset: 'performance',
  resolutionScale: 0.85,
  pixelRatioCap: 1.0,
  antialiasing: 'fxaa',
  shadows: {
    ...base.shadows,
    cascades: 2,
    quality: 'medium',
    mapSize: 1024,
    softness: 0.4,
    contactShadows: false,
  },
  ao: { ...base.ao, method: 'ssao', radius: 0.3, intensity: 0.8 },
  bloom: { ...base.bloom, strength: 0.5, radius: 0.5, mipmapBlur: false },
  dof: { ...base.dof, enabled: false },
  motionBlur: { ...base.motionBlur, enabled: false },
  sky: { ...base.sky, godRays: false },
  volumetric: { ...base.volumetric, density: 0.0008 },
  clouds: { ...PERFORMANCE_CLOUD_PROFILE },
  performance: { ...base.performance, targetFps: 60, adaptiveScaling: true, adaptiveMinScale: 0.5 },
};

/** 极简预设 — 集成显卡兜底 */
export const MINIMAL_PROFILE: EngineProfile = {
  ...base,
  name: 'Minimal',
  preset: 'minimal',
  pipeline: 'forward',
  resolutionScale: 0.7,
  pixelRatioCap: 1.0,
  antialiasing: 'off',
  shadows: { ...base.shadows, enabled: false, contactShadows: false },
  sky: { ...base.sky, atmosphericScattering: false, godRays: false },
  ao: { ...base.ao, method: 'off' },
  bloom: { ...base.bloom, enabled: false },
  dof: { ...base.dof, enabled: false },
  motionBlur: { ...base.motionBlur, enabled: false },
  volumetric: { ...base.volumetric, enabled: false },
  clouds: { ...MINIMAL_CLOUD_PROFILE },
  performance: { ...base.performance, targetFps: 30, adaptiveScaling: true, adaptiveMinScale: 0.4 },
};

export function getBuiltinProfile(p: PresetBuiltin): EngineProfile {
  switch (p) {
    case 'cinematic':   return structuredClone(CINEMATIC_PROFILE);
    case 'performance': return structuredClone(PERFORMANCE_PROFILE);
    case 'minimal':     return structuredClone(MINIMAL_PROFILE);
    case 'balanced':
    case 'custom':
    default:            return structuredClone(BALANCED_PROFILE);
  }
}

// ─── localStorage 持久化 ──────────────────────────────

const PROFILES_KEY = 'skybound.engineLab.profiles';
const ACTIVE_KEY = 'skybound.engineLab.activeProfile';

export function loadAllProfiles(): EngineProfile[] {
  if (typeof window === 'undefined') return [BALANCED_PROFILE];
  try {
    const raw = window.localStorage.getItem(PROFILES_KEY);
    if (!raw) return [BALANCED_PROFILE];
    const arr = JSON.parse(raw) as EngineProfile[];
    if (!Array.isArray(arr) || arr.length === 0) return [BALANCED_PROFILE];
    // 向后兼容: 旧版本 profile 可能没有 clouds 字段，补上默认值
    return arr.map(migrateProfile);
  } catch {
    return [BALANCED_PROFILE];
  }
}

/** 把旧版本 profile 升级到当前 schema (补缺失的 clouds 字段) */
function migrateProfile(p: EngineProfile): EngineProfile {
  if (!p.clouds) {
    return { ...p, clouds: { ...DEFAULT_CLOUD_PROFILE } };
  }
  return p;
}

export function saveAllProfiles(profiles: EngineProfile[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
  } catch (e) {
    console.warn('[EngineLab] Failed to save profiles:', e);
  }
}

export function loadActiveProfile(): EngineProfile {
  if (typeof window === 'undefined') return BALANCED_PROFILE;
  try {
    const name = window.localStorage.getItem(ACTIVE_KEY);
    if (!name) return BALANCED_PROFILE;
    const all = loadAllProfiles();
    const found = all.find((p) => p.name === name);
    return found ?? BALANCED_PROFILE;
  } catch {
    return BALANCED_PROFILE;
  }
}

export function setActiveProfile(name: string) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ACTIVE_KEY, name);
}

export function upsertProfile(profile: EngineProfile) {
  const all = loadAllProfiles();
  const idx = all.findIndex((p) => p.name === profile.name);
  if (idx >= 0) all[idx] = profile;
  else all.push(profile);
  saveAllProfiles(all);
}

export function deleteProfile(name: string) {
  const all = loadAllProfiles().filter((p) => p.name !== name);
  saveAllProfiles(all);
}

/** 用户在 Engine Lab 里点「应用到游戏」时调用 */
export function applyProfileToGame(profile: EngineProfile) {
  upsertProfile(profile);
  setActiveProfile(profile.name);
}

/** GameEngine 启动任务时读取激活的预设 */
export function readActiveProfileForGame(): EngineProfile {
  return loadActiveProfile();
}

/** 浅克隆（编辑时使用，避免污染原 profile） */
export function cloneProfile(p: EngineProfile, newName?: string): EngineProfile {
  const clone = structuredClone(p);
  clone.name = newName ?? `${p.name} (copy)`;
  clone.preset = 'custom';
  return clone;
}
