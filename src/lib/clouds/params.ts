/**
 * Volumetric Cloud Parameters
 * =====================================================================
 * 体积云参数与预设。所有数值由 EngineProfile.clouds 持有，用户在
 * Engine Lab UI 的「体积云」标签页中调整。
 *
 * 这套参数与 `volumetric` (体积雾) 互相独立：
 *   - volumetric: 后处理屏幕空间雾 (低空 / 远景染色)
 *   - clouds:     光线步进式体积云 (高空厚云层)
 *
 * 物理启发的模型参考 Guerra (2018) "Real-time Rendering of Volumetric
 * Clouds" + Schneider (2015) "The Real-time Volumetric Cloudscapes of
 * Horizon Zero Dawn"。核心公式：
 *   - Henyey-Greenstein 双叶相位函数 (前向 + 后向散射)
 *   - Beer-Powder 衰减定律 (边缘粉效应)
 *   - 多层高度剖面 (层云 + 积云 + 卷云)
 *   - 朝太阳方向的 lightMarch (自阴影)
 *   - 多次散射近似 (次级相位叶)
 */

import * as THREE from 'three';

export type CloudQuality = 'low' | 'medium' | 'high' | 'ultra';

export interface CloudProfile {
  /** 总开关 — 关闭时 pass 直接透传，无开销 */
  enabled: boolean;
  /** 云覆盖率 0..1 — smoothstep 阈值控制天空被云覆盖的比例 */
  coverage: number;
  /** 密度倍数 0..2 — 每步采样的密度缩放 */
  density: number;
  /** 风速 0..1 — 云体随时间漂移速度 */
  windSpeed: number;
  /** 云层底部高度 (世界 Y, 米) */
  cloudBottom: number;
  /** 云层顶部高度 (世界 Y, 米) */
  cloudTop: number;
  /** 质量档位 — 决定光线步进次数 */
  quality: CloudQuality;
  /** 环境光颜色 — 阴影区云内的环境光 */
  ambientColor: string;
  /** 太阳强度倍数 — 控制云被照亮的亮度 */
  sunIntensity: number;
  /** 闪电开关 (留作未来扩展，目前仅 UI 占位) */
  lightning: boolean;
}

/** 不同质量档位对应的步进次数 (编译时常量, 让 GLSL 循环可被驱动优化) */
export const CLOUD_QUALITY_PRESETS: Record<CloudQuality, {
  maxSteps: number;
  maxLightSteps: number;
}> = {
  low:    { maxSteps: 16, maxLightSteps: 2 },
  medium: { maxSteps: 32, maxLightSteps: 3 },
  high:   { maxSteps: 48, maxLightSteps: 4 },
  ultra:  { maxSteps: 64, maxLightSteps: 6 },
};

/** 默认体积云参数 (中等覆盖 / 中密度 / 高质量) */
export const DEFAULT_CLOUD_PROFILE: CloudProfile = {
  enabled: false,         // 默认关闭，需用户在 UI 中开启
  coverage: 0.55,
  density: 1.0,
  windSpeed: 0.15,
  cloudBottom: 1200,
  cloudTop: 2400,
  quality: 'high',
  ambientColor: '#a8c0d8',
  sunIntensity: 1.0,
  lightning: false,
};

/** Cinematic 预设的体积云 — 全开 */
export const CINEMATIC_CLOUD_PROFILE: CloudProfile = {
  ...DEFAULT_CLOUD_PROFILE,
  enabled: true,
  coverage: 0.7,
  density: 1.2,
  quality: 'ultra',
};

/** Performance 预设的体积云 — 低步进 */
export const PERFORMANCE_CLOUD_PROFILE: CloudProfile = {
  ...DEFAULT_CLOUD_PROFILE,
  enabled: false,
  coverage: 0.45,
  density: 0.85,
  quality: 'medium',
};

/** Minimal 预设的体积云 — 强制关闭 */
export const MINIMAL_CLOUD_PROFILE: CloudProfile = {
  ...DEFAULT_CLOUD_PROFILE,
  enabled: false,
  quality: 'low',
};

/** 根据太阳仰角计算云的环境光颜色 — 仰角低时偏暖 */
export function cloudAmbientFromSunElevation(sunElevationDeg: number): THREE.Color {
  const t = Math.max(0, Math.min(1, sunElevationDeg / 90));
  // 日落暖色 → 正午冷色
  const sunset = new THREE.Color(0xff9a6a);
  const noon = new THREE.Color(0xa8c0d8);
  return sunset.clone().lerp(noon, t);
}

/** 根据太阳仰角计算太阳颜色 — 仰角低时偏橙红 */
export function cloudSunColorFromElevation(sunElevationDeg: number): THREE.Color {
  const t = Math.max(0, Math.min(1, sunElevationDeg / 90));
  const sunset = new THREE.Color(1.6, 0.7, 0.3);
  const noon = new THREE.Color(1.0, 0.96, 0.88);
  return sunset.clone().lerp(noon, t);
}

/** 解析 hex 颜色字符串到 THREE.Color (容错) */
export function parseColorHex(hex: string): THREE.Color {
  try {
    return new THREE.Color(hex);
  } catch {
    return new THREE.Color(0xa8c0d8);
  }
}
