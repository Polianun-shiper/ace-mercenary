// === 屏幕空间丁达尔补层 (screen-space god rays / 径向光柱) ======================
//
// 为什么还要这一层(而不是只靠库的 BSM 光柱):
//   @takram/three-clouds 的 `lightShafts` 把"云隙光"做在**霾的内散射**里(见
//   clouds-takram.ts 的长注释): `approximateHaze()` 用 shadowLength 把视线分成
//   "被云挡住/没挡住"两段, 于是朝太阳方向穿过云隙的像素少衰减 ⇒ 亮柱。
//   它是**物理正确**的, 但(实测 §C)在 1.5~4km 的玩法高度上表现为"太阳方向的柔和
//   增亮/云底透光带", **不是锐利光柱** —— 因为库的霾密度低(3e-5 量级)、BSM 又是
//   柔和的 8 抽样光学深度, 结构被抹平了。
//   经典的"光柱"观感来自另一件事: **太阳附近那些亮点被云/地形按屏幕空间径向抹开**
//   (GPU Gems 3 的 volumetric light scattering, Kenny Mitchell)。这一层就做这个。
//
// 做法(每个像素, 朝太阳的屏幕位置径向拉):
//   1. `dir = (sunScreen - uv) * density`, 沿 dir 采样 N 步(越远步长越大);
//   2. 每一步同时看**两个遮挡源**:
//        · 场景深度  (depth >= 阈值 ⇒ 天空像素, 不遮挡; 否则算被几何挡住)
//        · 云缓冲不透明度(库的 cloudsBuffer.a; 1 = 全遮) —— 这才是"云隙"的来源,
//          几何深度里**没有云**(云是独立 pass 画的), 只用深度会得到一片均匀雾。
//   3. 权重 = 亮度阈值(smoothstep) × 透过率 × 距离衰减(decay^i);
//   4. 结果按"太阳在不在画面里"整体门控(sunGate), 再加到场景上。
//
// 插在**大气透视之后、Bloom 之前**(与体积云/AP 同一个 forward 链分支):
// 光柱参与泛光才像真的, 且 AP 已经把远处的空气光算完, 光柱叠在最终颜色上。
//
// 安全:
//   · 构造/每帧都 try/catch —— 第三方或本层出问题时最多"没有光柱", 绝不能打断
//     setupPostProcessing(踩过的坑: 一个构造异常把自阴影/雾/调色全丢)。
//   · 采样器 +3(scene/depth/clouds), 远低于 16 上限; 不动任何 three 材质的采样器。
//   · 一键关: `skybound.godRays=off` / hash `&nogodrays` / 控制台 `godrays off`。
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * 每像素最多步数(常量上界; 实际步数由 uSamples 控制, GLSL ES 1.0 要求循环上界是常量)。
 * 24 步 ×(1 深度 + 1 场景 + 1 云)= 72 次采样, 桌面端可接受; 移动档不建这个 pass。
 */
const MAX_STEPS = 24;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D uScene;
uniform sampler2D uDepthTex;
uniform sampler2D uClouds;
uniform float uCloudsOn;
uniform vec2  uSunScreen;   // 太阳的屏幕位置(0..1 的 uv)
uniform float uSunGate;     // 太阳在画面内 + 在相机前方 = 1
uniform float uIntensity;   // 总强度
uniform float uDecay;       // 每步衰减(0.9~1.0)
uniform float uDensity;     // 径向拉伸长度(屏幕比例)
uniform float uThreshold;   // 亮度阈值(只有比它亮的像素才被抹开)
uniform float uKnee;        // 阈值之上的过渡宽度(0.05~1; 小 = 更"只取最亮的")
uniform float uSamples;     // 实际步数(<= ${MAX_STEPS})
uniform float uSkyDepth;    // 深度 >= 它算"天空/无几何遮挡"
uniform float uCloudOccl;   // 云不透明度对遮挡的权重(0 = 不看云)

void main() {
  vec3 scene = texture2D(uScene, vUv).rgb;
  if (uSunGate < 0.5 || uIntensity <= 0.0) { gl_FragColor = vec4(scene, 1.0); return; }

  vec2 dir = (uSunScreen - vUv) * uDensity;
  vec2 uv = vUv;
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  float w = 1.0;
  float steps = max(1.0, min(uSamples, float(${MAX_STEPS})));
  for (int i = 0; i < ${MAX_STEPS}; ++i) {
    if (float(i) >= steps) break;
    uv += dir / steps;
    // 出屏就停(屏外的采样没有意义, 继续只是把一个常数抹满屏)
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;

    // ① 几何遮挡(天空像素不算遮挡)
    float d = texture2D(uDepthTex, uv).r;
    float geo = step(uSkyDepth, d);

    // ② 云遮挡(云缓冲不透明度; 没有云缓冲时视为不遮挡)
    float cocc = 1.0;
    if (uCloudsOn > 0.5 && uCloudOccl > 0.0) {
      float ca = texture2D(uClouds, uv).a;
      cocc = 1.0 - clamp(ca, 0.0, 1.0) * uCloudOccl;
    }
    float occ = geo * cocc;

    vec3 c = texture2D(uScene, uv).rgb;
    float lum = dot(c, vec3(0.299, 0.587, 0.114));
    // === 亮度权重用**线性斜坡**而不是 smoothstep(a,1,x) =================
    // smoothstep 只在 x→1 附近才有力, 于是"太阳被云挡住、只剩一圈辉光"时权重≈0
    // ⇒ 光柱直接消失(实测踩到: 同一组参数的两次会话一个出大扇面、一个什么都不出,
    //   区别只是那一刻太阳本体在不在画面里)。这里改成
    //   clamp((lum - thresh) / knee, 0, 1): 阈值之上 knee 宽度内就吃满权重,
    // 于是"云隙辉光"这种中等亮度也能当光源 —— 这正是本层要的效果。
    float bright = clamp((lum - uThreshold) / max(0.02, uKnee), 0.0, 1.0);
    // ⚠ 只把"亮点"抹开: 普通地面/海面即使没被挡住也不该贡献光柱(bright=0)
    acc += c * (bright * occ * w);
    wsum += w;
    w *= uDecay;
    if (w < 0.01) break;
  }
  vec3 rays = wsum > 1e-4 ? acc / wsum : vec3(0.0);
  vec3 outColor = scene + rays * uIntensity;
  // 有限性保险(与天空/AP 同款): 出现 NaN/Inf 时不要整帧变黑
  gl_FragColor = vec4(clamp(outColor, vec3(0.0), vec3(1.0e5)), 1.0);
}
`;

export interface GodRayParams {
  enabled: boolean;
  /** 光柱总强度(默认 0.35; §295 标定, 1.0 会把整幅画面洗白) */
  intensity: number;
  /** 每步衰减(0.9~1.0; 越大光柱越长) */
  decay: number;
  /** 径向拉伸长度(屏幕比例; 0.2~1.2) */
  density: number;
  /** 亮度阈值(0~0.95; 越高只有太阳/云隙那种极亮点才参与) */
  threshold: number;
  /** 阈值之上的过渡宽度(0.05~1) */
  knee: number;
  /** 步数(4~24) */
  samples: number;
  /** 云不透明度对遮挡的权重(0~1; 1 = 云全遮, 光柱只在云隙里出现) */
  cloudOcclusion: number;
}

/**
 * 屏幕空间径向光柱。`needsSwap` + readBuffer→writeBuffer, 与其它 pass 同款;
 * 深度优先吃 composer 的 DepthTexture(零额外渲染)。
 */
export class GodRaysPass extends Pass {
  private mat: THREE.ShaderMaterial;
  private fsQuad: FullScreenQuad;
  private camera: THREE.PerspectiveCamera;
  /** 云缓冲的来源(takram pass; 没有它也能跑 —— 只看几何遮挡) */
  private cloudSource: { getCloudsTexture(): THREE.Texture | null } | null = null;
  private tmp = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera) {
    super();
    this.camera = camera;
    this.needsSwap = true;
    this.enabled = false;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uScene: { value: null as THREE.Texture | null },
        uDepthTex: { value: null as THREE.Texture | null },
        uClouds: { value: null as THREE.Texture | null },
        uCloudsOn: { value: 0 },
        uSunScreen: { value: new THREE.Vector2(0.5, 0.5) },
        uSunGate: { value: 0 },
        // 与 engine.godRaysParams 的默认值保持一致(§295 标定; 只在第一帧 updateGodRays
        // 跑到之前生效 —— 阈值 0.25 那版会把整幅画面洗白, 见那里的注释)。
        uIntensity: { value: 0.35 },
        uDecay: { value: 0.88 },
        uDensity: { value: 0.4 },
        uThreshold: { value: 0.55 },
        uKnee: { value: 0.12 },
        uSamples: { value: 16 },
        uSkyDepth: { value: 0.9995 },
        uCloudOccl: { value: 1.0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.mat);
  }

  /** 挂云缓冲来源(engine 在 takram pass 建好后调; null = 只用几何遮挡) */
  setCloudSource(src: { getCloudsTexture(): THREE.Texture | null } | null): void {
    this.cloudSource = src;
  }

  /** 每帧喂参数(engine 调)。太阳方向 → 屏幕位置在这里算。 */
  setParams(p: GodRayParams, sunDir: THREE.Vector3 | null): void {
    const u = this.mat.uniforms;
    u.uIntensity.value = p.enabled ? p.intensity : 0;
    u.uDecay.value = Math.min(0.999, Math.max(0.5, p.decay));
    u.uDensity.value = Math.max(0, p.density);
    u.uThreshold.value = Math.min(0.95, Math.max(0, p.threshold));
    u.uKnee.value = Math.min(1, Math.max(0.02, p.knee));
    u.uSamples.value = Math.max(1, Math.min(MAX_STEPS, Math.round(p.samples)));
    u.uCloudOccl.value = Math.max(0, Math.min(1, p.cloudOcclusion));
    this.enabled = p.enabled;

    // 太阳的屏幕位置: 取相机前方 10km 处沿太阳方向的点投影(与太阳光的 position 同口径)
    let gate = 0;
    if (p.enabled && sunDir) {
      this.tmp.copy(sunDir).normalize().multiplyScalar(10000).add(this.camera.position);
      this.tmp.project(this.camera);
      // z 在 [-1,1] 且落在画面内才开门(z<1 才是"在相机前方")
      const inside = this.tmp.z < 1 && Math.abs(this.tmp.x) < 1.15 && Math.abs(this.tmp.y) < 1.15;
      (u.uSunScreen.value as THREE.Vector2).set(this.tmp.x * 0.5 + 0.5, this.tmp.y * 0.5 + 0.5);
      gate = inside ? 1 : 0;
    } else {
      (u.uSunScreen.value as THREE.Vector2).set(0.5, 0.5);
    }
    u.uSunGate.value = gate;
  }

  /** 当前是否真的在起作用(探针用) */
  isActive(): boolean {
    return this.enabled && (this.mat.uniforms.uSunGate.value as number) > 0.5
      && (this.mat.uniforms.uIntensity.value as number) > 0;
  }

  /** 探针用: 当前参数读数 */
  getInfo(): Record<string, number | null> {
    const u = this.mat.uniforms;
    return {
      intensity: u.uIntensity.value as number,
      decay: u.uDecay.value as number,
      density: u.uDensity.value as number,
      threshold: u.uThreshold.value as number,
      knee: u.uKnee.value as number,
      samples: u.uSamples.value as number,
      sunGate: u.uSunGate.value as number,
      sunU: (u.uSunScreen.value as THREE.Vector2).x,
      sunV: (u.uSunScreen.value as THREE.Vector2).y,
      clouds: u.uCloudsOn.value as number,
      hasDepth: u.uDepthTex.value ? 1 : 0,
    };
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    if (!readBuffer) return;
    if (!this.enabled) return;
    try {
      const rbuf = readBuffer as THREE.WebGLRenderTarget & { depthTexture?: THREE.Texture | null };
      const depth = rbuf.depthTexture ?? null;
      if (!depth) return;   // 没深度就没法判遮挡 —— 宁可不画(而不是把整个画面抹成雾)
      const u = this.mat.uniforms;
      u.uScene.value = readBuffer.texture;
      u.uDepthTex.value = depth;
      const clouds = this.cloudSource?.getCloudsTexture() ?? null;
      u.uClouds.value = clouds;
      u.uCloudsOn.value = clouds ? 1 : 0;
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      this.fsQuad.render(renderer);
    } catch (err) {
      if (!this._errOnce) {
        this._errOnce = true;
        console.error('[godrays] 光柱 pass 渲染失败(本帧跳过, 不再刷屏):', err);
      }
    }
  }
  private _errOnce = false;

  override dispose(): void {
    this.mat.dispose();
    this.fsQuad.dispose();
  }
}
