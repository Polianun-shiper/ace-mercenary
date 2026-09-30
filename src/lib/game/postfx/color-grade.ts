/**
 * 后期调色 pass (per user request: 加上后期处理功能, 对画面进行调色与调整)。
 *
 * 设计要点
 * - 独立成文件、独立成一个 pass, 不侵入既有 SSR/Bloom/SSAO 链路: 插在链条**最后**
 *   (OutputPass 之后), 也就是在**已色调映射/已转显示空间**的最终画面上做调色 ——
 *   这是"像修图软件那样调"的位置, 亮度/对比度/色温的行为符合直觉。
 * - 一个全屏 pass(1 个 draw call), 移动端也负担得起; 默认全中性(等于不存在)。
 * - 参数存 localStorage(`skybound.cg.*`), 与项目其它设置一致; 控制台 `grade` 可实时改。
 *
 * 参数语义
 *   exposure    线性曝光倍数(1 = 不变)
 *   brightness  亮度增益(1 = 不变)
 *   contrast    对比度, 围绕中灰 0.5 缩放(1 = 不变)
 *   saturation  饱和度(1 = 不变, 0 = 黑白)
 *   temperature 色温: >0 偏暖(红↑蓝↓), <0 偏冷
 *   tint        色调: >0 偏绿, <0 偏品红
 *   lift        暗部抬升(0 = 不变, 0.05 = 胶片褪色感)
 *   gain        高光增益(1 = 不变)
 *   gamma       显示 gamma(1 = 不变, >1 提亮中间调)
 *   vignette    暗角强度(0..1)
 *   grain       颗粒强度(0..1)
 */
import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

export interface ColorGradeValues {
  exposure: number; brightness: number; contrast: number; saturation: number;
  temperature: number; tint: number; lift: number; gain: number; gamma: number;
  vignette: number; grain: number;
  /**
   * 蓝调阴影(0..0.35): 只压暗部的蓝红比 —— 参考图那种"雪岩地形 + 深蓝天空"的冷调
   * 靠这个参数出效果。单靠 temperature 会让整个画面一起偏蓝(高光也变蓝, 很假)。
   */
  shadowBlue: number;
}

export const COLOR_GRADE_DEFAULTS: ColorGradeValues = {
  exposure: 1, brightness: 1, contrast: 1, saturation: 1,
  temperature: 0, tint: 0, lift: 0, gain: 1, gamma: 1,
  vignette: 0, grain: 0, shadowBlue: 0,
};

/**
 * 游戏默认画面色调 (per user request: 把默认画面色调调成参考图那种)。
 *
 * 参考图特征(逐项对应): 冷调高对比、雪/岩地形 + 深蓝天空、**阴影明显偏蓝而高光基本中性**、
 * 轻微暗角、极轻颗粒。数值都在显示空间(本 pass 在 OutputPass 之后), 相当于在成片上调色。
 */
export const COLOR_GRADE_GAME_DEFAULT: Partial<ColorGradeValues> = {
  exposure: 0.92,
  brightness: 1.0,
  contrast: 1.24,       // 高对比: 雪面亮、岩体暗
  saturation: 0.9,    // 略降饱和, 避免艳俗(蓝只留给天空与阴影)
  temperature: -0.09,  // 整体偏冷
  tint: 0.0,
  lift: -0.02,        // 黑位再压一点(首版 0 时画面偏白, 参考图黑位更深)
  gain: 1.05,          // 高光略提, 雪面更亮
  gamma: 1.0,
  vignette: 0.22,       // 轻微暗角
  grain: 0.012,         // 极轻颗粒
  shadowBlue: 0.22,    // 阴影蓝调: 参考图最有辨识度的一环(首版 0.12 偏弱)
};

/** 调色预设(per user request: 一键出风格)。 */
export const COLOR_GRADE_PRESETS: Record<string, Partial<ColorGradeValues>> = {
  neutral: { ...COLOR_GRADE_DEFAULTS },
  cinematic: { contrast: 1.12, saturation: 1.08, temperature: 0.04, lift: 0.012, vignette: 0.28, grain: 0.015 },
  warm: { temperature: 0.12, brightness: 1.03, saturation: 1.05, gain: 1.02 },
  cold: { temperature: -0.12, contrast: 1.06, saturation: 0.95 },
  punch: { contrast: 1.25, saturation: 1.15, gain: 1.03 },
  faded: { lift: 0.06, gain: 0.95, contrast: 0.92, saturation: 0.85 },
  night: { exposure: 0.92, temperature: -0.06, contrast: 1.1, saturation: 0.9, vignette: 0.35, lift: 0.02 },
  // 游戏默认(参考图调性)
  default: COLOR_GRADE_GAME_DEFAULT,
  // 更冷的雪原/极地风
  arctic: { contrast: 1.2, saturation: 0.88, temperature: -0.08, shadowBlue: 0.2, gain: 1.04, vignette: 0.18, grain: 0.01 },
};

const LS_PREFIX = 'skybound.cg.';
export const COLOR_GRADE_KEYS = Object.keys(COLOR_GRADE_DEFAULTS) as (keyof ColorGradeValues)[];

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform float uExposure;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform float uTemperature;
uniform float uTint;
uniform float uLift;
uniform float uGain;
uniform float uGamma;
uniform float uVignette;
uniform float uGrain;
uniform float uShadowBlue;
uniform float uTime;
varying vec2 vUv;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;

  // 曝光 / 亮度
  c *= uExposure * uBrightness;
  // 对比度(围绕中灰)
  c = (c - 0.5) * uContrast + 0.5;
  // 暗部抬升 / 高光增益 (lift/gain, 经典调色台模型)
  c = c * uGain + uLift * (1.0 - c);
  // 色温 / 色调
  c.r *= 1.0 + uTemperature;
  c.b *= 1.0 - uTemperature;
  c.g *= 1.0 + uTint;
  // 蓝调阴影: 只在暗部把蓝抬起来、红压下去(高光几乎不动) —— 参考图的冷调来自这里,
  // 而不是整体 temperature, 所以高光(雪面/机身反光)仍然是中性的。
  if (uShadowBlue > 0.0) {
    float lum0 = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float sw = 1.0 - smoothstep(0.0, 0.6, lum0);
    c.b += uShadowBlue * sw * 0.6;
    c.r -= uShadowBlue * sw * 0.25;
  }
  // 饱和度(按亮度混合)
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  // 显示 gamma
  c = pow(max(c, vec3(0.0)), vec3(1.0 / max(uGamma, 0.01)));
  // 暗角
  if (uVignette > 0.0) {
    float d = distance(vUv, vec2(0.5));
    c *= 1.0 - uVignette * smoothstep(0.35, 0.95, d);
  }
  // 颗粒(用时间做抖动, 免得像固定噪点)
  if (uGrain > 0.0) {
    c += (hash(vUv * 1024.0 + uTime) - 0.5) * uGrain;
  }

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

export class ColorGradePass extends ShaderPass {
  constructor(values?: Partial<ColorGradeValues>) {
    super({
      uniforms: {
        tDiffuse: { value: null },
        uExposure: { value: 1 }, uBrightness: { value: 1 }, uContrast: { value: 1 },
        uSaturation: { value: 1 }, uTemperature: { value: 0 }, uTint: { value: 0 },
        uLift: { value: 0 }, uGain: { value: 1 }, uGamma: { value: 1 },
        uVignette: { value: 0 }, uGrain: { value: 0 }, uShadowBlue: { value: 0 }, uTime: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
    });
    this.setValues(values ?? {});
  }

  private map: Record<string, string> = {
    exposure: 'uExposure', brightness: 'uBrightness', contrast: 'uContrast',
    saturation: 'uSaturation', temperature: 'uTemperature', tint: 'uTint',
    lift: 'uLift', gain: 'uGain', gamma: 'uGamma', vignette: 'uVignette', grain: 'uGrain',
    shadowBlue: 'uShadowBlue',
  };

  /** 批量设值(只认名称合法的键, 数值自动夹到合理范围)。 */
  setValues(v: Partial<ColorGradeValues>): void {
    for (const [k, raw] of Object.entries(v)) {
      const u = this.map[k];
      if (!u || typeof raw !== 'number' || !Number.isFinite(raw)) continue;
      (this.uniforms[u] as { value: number }).value = clampKey(k, raw);
    }
  }

  /** 当前值(读 uniform, 便于 UI/控制台回显与写盘)。 */
  getValues(): ColorGradeValues {
    const out = { ...COLOR_GRADE_DEFAULTS };
    for (const k of COLOR_GRADE_KEYS) {
      const u = this.map[k];
      if (u) (out as unknown as Record<string, number>)[k] = (this.uniforms[u] as { value: number }).value;
    }
    return out;
  }

  /** 是否全中性(全中性 = 这个 pass 不产生任何画面变化, 可以不加进管线)。 */
  isNeutral(): boolean {
    const v = this.getValues();
    return COLOR_GRADE_KEYS.every((k) => Math.abs(v[k] - COLOR_GRADE_DEFAULTS[k]) < 1e-4);
  }

  applyPreset(name: string): boolean {
    const p = COLOR_GRADE_PRESETS[name];
    if (!p) return false;
    this.setValues({ ...COLOR_GRADE_DEFAULTS, ...p });
    return true;
  }

  /** 逐帧推进(颗粒需要时间)。 */
  tick(t: number): void {
    (this.uniforms.uTime as { value: number }).value = t;
  }

  /** 从 localStorage 读参数(项目惯例: skybound.* 键)。 */
  loadFromStorage(): void {
    const v: Partial<ColorGradeValues> = {};
    for (const k of COLOR_GRADE_KEYS) {
      const raw = localStorage.getItem(LS_PREFIX + k);
      if (raw === null) continue;
      const n = parseFloat(raw);
      if (Number.isFinite(n)) (v as unknown as Record<string, number>)[k] = n;
    }
    if (Object.keys(v).length) this.setValues(v);
  }

  /** 写回 localStorage(只写非默认项, 保持存储干净)。 */
  saveToStorage(): void {
    const v = this.getValues();
    for (const k of COLOR_GRADE_KEYS) {
      if (Math.abs(v[k] - COLOR_GRADE_DEFAULTS[k]) < 1e-4) localStorage.removeItem(LS_PREFIX + k);
      else localStorage.setItem(LS_PREFIX + k, String(Math.round(v[k] * 1000) / 1000));
    }
  }
}

/** 各参数的合理范围(夹取, 防止手输把画面搞崩)。 */
function clampKey(key: string, v: number): number {
  switch (key) {
    case 'exposure': return Math.max(0.1, Math.min(4, v));
    case 'brightness': return Math.max(0.2, Math.min(3, v));
    case 'contrast': return Math.max(0, Math.min(3, v));
    case 'saturation': return Math.max(0, Math.min(3, v));
    case 'temperature': return Math.max(-0.5, Math.min(0.5, v));
    case 'tint': return Math.max(-0.5, Math.min(0.5, v));
    case 'lift': return Math.max(-0.3, Math.min(0.3, v));
    case 'gain': return Math.max(0.2, Math.min(3, v));
    case 'gamma': return Math.max(0.4, Math.min(2.5, v));
    case 'vignette': return Math.max(0, Math.min(1, v));
    case 'grain': return Math.max(0, Math.min(0.2, v));
    case 'shadowBlue': return Math.max(0, Math.min(0.35, v));
    default: return v;
  }
}
