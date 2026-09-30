// === 物理大气透视 (Aerial Perspective) Pass ===================================
//
// 取代(并列于)旧的 `height-fog.ts`: 旧的是"解析指数高度雾 + 手调上限/手调色带" ——
// 它的两个先天问题(见验收判据 2/3):
//   · 地平线附近那条**假界线**: maxOpacity 是全局上限(0.82) ⇒ 远处地形永远留 18% 原色;
//     后来靠 `farFade0/farFade1` 那条"天际带"补丁硬推 alpha → 又从"有线"变成"突然糊掉";
//   · "10km 就全糊掉": density/scaleHeight 是手调常数, 与距离**指数**关系, 没有物理含义。
// 这里改成: 场景深度 → 采样物理大气 LUT(见 lut-aerial.ts) → out = scene·T + (瑞利+米氏+多次散射)。
//   · T 是物理透过率, 远处地形**连续**淡入天空色, 且淡入的颜色 == 它背后那片天空的颜色
//     (两者用的是同一个大气模型) ⇒ 交界处不可能出现色差线(判据 2/3);
//   · 距离关系来自密度廓线积分, 20km 的山只被吃掉一部分(判据 3)。
//
// ⚠ 保留的既有机制(踩过坑, 不要删):
//   ① **玩家机体豁免**: layer 31 + 每帧一张低清纯白遮罩(maskRT) —— 机体像素原样输出,
//      不吃大气透视。见 setExcludeRoot / refreshExcludeLayers / renderMask(与 height-fog 同款)。
//   ② **setParams 式每帧喂参**(engine.updateAtmosphere 每帧调) + `readTuning` 现场旋钮
//      (`atmo ap ...`, 见 engine 的 atmoCmd)。
//   ③ 深度优先用 **composer 自带的 DepthTexture**(零额外渲染); 没有才退回自渲一张低清深度。
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { ATMO_COMMON_GLSL, type AtmosphereUniforms } from './params';

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const AP_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

${ATMO_COMMON_GLSL}

uniform sampler2D uScene;
uniform sampler2D uDepthTex;
uniform sampler2D uMaskTex;    // 玩家机体遮罩(白 = 机体像素, 原样输出不吃大气)
uniform float uMaskOn;
uniform mat4  uInvViewProj;
uniform mat4  uInvProjection;
uniform mat4  uInvView;
uniform vec3  uCameraPos;
uniform float uDepthOn;

uniform sampler2D uApT;
uniform sampler2D uApLr;
uniform sampler2D uApLm;
uniform sampler2D uApLms;
uniform float uAerialMaxDist;
uniform float uAerialExp;
uniform float uApOn;

void main() {
  vec3 scene = texture2D(uScene, vUv).rgb;

  // === 玩家机体豁免(原样输出) ================================================
  // 放在最前面: 连"是不是天空像素"都不判 —— 机体像素永远不吃大气透视。
  if (uMaskOn > 0.5 && texture2D(uMaskTex, vUv).r > 0.02) {
    gl_FragColor = vec4(scene, 1.0);
    return;
  }
  if (uApOn < 0.5) { gl_FragColor = vec4(scene, 1.0); return; }

  // === 视线方向 + 到遮挡面的距离 =============================================
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 rayEye = uInvProjection * vec4(ndc, -1.0, 1.0);
  rayEye = vec4(rayEye.xy, -1.0, 0.0);
  vec3 rd = normalize((uInvView * rayEye).xyz);

  float tGeo = uAerialMaxDist;
  bool isSky = true;
  if (uDepthOn > 0.5) {
    float d = texture2D(uDepthTex, vUv).r;
    if (d < 1.0) {
      vec4 w = uInvViewProj * vec4(ndc, d * 2.0 - 1.0, 1.0);
      tGeo = length(w.xyz / w.w - uCameraPos);
      isSky = false;
    }
  }
  // 天空像素: 大气已经由天空着色器算过了(那里有全分辨率的方向和太阳圆盘) ⇒ 原样输出。
  // 这样也保证"地形淡出的终点"与天空像素用的是**同一个**大气模型, 不会有接缝。
  if (isSky) { gl_FragColor = vec4(scene, 1.0); return; }

  // === 查 AP LUT ===========================================================
  vec3 up = uAtmUpDir;
  float mu = dot(rd, up);
  float zenith = acos(clamp(mu, -1.0, 1.0));
  float viewHeight = max(uAtmViewHeight, uAtmBottomRadius);
  // 单位参数 → 贴图坐标(与烘烤端的 atmoSubToUnit 配套)
  vec2 uv = vec2(
    atmoUnitToSub(atmoAerialDistanceToUvX(tGeo * 1e-3, uAerialMaxDist, uAerialExp), ATMO_AP_W),
    atmoUnitToSub(atmoZenithToUvY(zenith, viewHeight), ATMO_AP_H)
  );

  vec3 T = texture2D(uApT, uv).rgb;
  vec3 lr = texture2D(uApLr, uv).rgb;
  vec3 lm = texture2D(uApLm, uv).rgb;
  vec3 lms = texture2D(uApLms, uv).rgb;

  // 相函数在**像素**上评估(方位): 光线是直线 + 太阳方向恒定 ⇒ 相函数夹角沿光线恒定,
  // 这一步是精确的; LUT 里存的是各向同性(1/4π)版本, 这里乘回 4π·Ph(θ)。
  float cosTheta = clamp(dot(rd, uAtmSunDir), -1.0, 1.0);
  vec3 inscatter = lr * (4.0 * ATMO_PI * atmoRayleighPhase(cosTheta))
                 + lm * (4.0 * ATMO_PI * atmoMiePhase(cosTheta, uAtmMieG))
                 + lms;
  inscatter *= uAtmRadianceScale;

  vec3 outc = scene * T + inscatter;
  // 有限性保险(与天空着色器同款): 输入/输出出现 NaN/Inf 时不要整帧变黑
  outc = clamp(outc, vec3(0.0), vec3(1.0e5));
  gl_FragColor = vec4(outc, 1.0);
}
`;

export interface AerialPassParams {
  enabled: boolean;
  /** 最远距离(米) —— 一般传相机远平面 */
  farDistance: number;
  /** 距离分布指数 */
  exponent: number;
}

export class AtmosphereAerialPass extends Pass {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private apMat: THREE.ShaderMaterial;
  private fsQuad: FullScreenQuad;
  private depthRT: THREE.WebGLRenderTarget | null = null;
  private tmpInvVP = new THREE.Matrix4();
  private _frame = 0;
  private _depthValid = false;
  private _lastCam = new THREE.Vector3(1e9, 1e9, 1e9);
  private resScale = 0.2;

  private u: AtmosphereUniforms;
  private luts: { t: THREE.Texture; lr: THREE.Texture; lm: THREE.Texture; lms: THREE.Texture };

  // === 玩家机体"免除大气透视"(与 height-fog 同款, 机制刻意保留) ================
  private excludeRoot: THREE.Object3D | null = null;
  private maskRT: THREE.WebGLRenderTarget | null = null;
  private maskLayer = 31;
  private aircraftExcluded = true;
  private maskMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, toneMapped: false });

  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    uniforms: AtmosphereUniforms,
    luts: { t: THREE.Texture; lr: THREE.Texture; lm: THREE.Texture; lms: THREE.Texture },
  ) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.u = uniforms;
    this.luts = luts;
    this.apMat = new THREE.ShaderMaterial({
      uniforms: {
        ...(uniforms as unknown as Record<string, THREE.IUniform>),
        uScene: { value: null as THREE.Texture | null },
        uDepthTex: { value: null as THREE.Texture | null },
        uMaskTex: { value: null as THREE.Texture | null },
        uMaskOn: { value: 0 },
        uInvViewProj: { value: new THREE.Matrix4() },
        uInvProjection: { value: new THREE.Matrix4() },
        uInvView: { value: new THREE.Matrix4() },
        uCameraPos: { value: new THREE.Vector3() },
        uDepthOn: { value: 1 },
        uApT: { value: luts.t },
        uApLr: { value: luts.lr },
        uApLm: { value: luts.lm },
        uApLms: { value: luts.lms },
        uAerialMaxDist: { value: 60 },
        uAerialExp: { value: 2 },
        uApOn: { value: 1 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: AP_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.apMat);
    this.needsSwap = true;
    this.enabled = false;
  }

  /** 每帧喂参数(engine 调用; 只写 uniform, 不触发重烤) */
  setParams(p: AerialPassParams): void {
    const u = this.apMat.uniforms;
    u.uAerialMaxDist.value = Math.max(1e-3, p.farDistance * 1e-3);
    u.uAerialExp.value = Math.max(1, p.exponent);
    u.uApOn.value = p.enabled ? 1 : 0;
    this.enabled = p.enabled;
  }

  /** LUT 重建后重新绑定(engine 在重烤/重建时调, 或直接每帧调都行) */
  setLuts(luts: { t: THREE.Texture; lr: THREE.Texture; lm: THREE.Texture; lms: THREE.Texture }): void {
    this.luts = luts;
    const u = this.apMat.uniforms;
    u.uApT.value = luts.t;
    u.uApLr.value = luts.lr;
    u.uApLm.value = luts.lm;
    u.uApLms.value = luts.lms;
  }

  setAircraftExclusion(on: boolean): void { this.aircraftExcluded = !!on; }
  getAircraftExcluded(): boolean { return this.aircraftExcluded; }

  setExcludeRoot(root: THREE.Object3D | null): void {
    this.excludeRoot = root;
    this.refreshExcludeLayers();
  }

  /** 只挂**不透明**网格(透明的大面片会把背景误判成机体像素 —— 见 height-fog 的说明)。 */
  refreshExcludeLayers(): void {
    const root = this.excludeRoot;
    if (!root) return;
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      const isTransparent = Array.isArray(mat)
        ? mat.some((x) => !!x && !!x.transparent)
        : !!mat && mat.transparent;
      if (isTransparent) o.layers.disable(this.maskLayer);
      else o.layers.enable(this.maskLayer);
    });
  }

  private ensureTargets(w: number, h: number): void {
    const dw = Math.max(2, Math.floor(w * this.resScale));
    const dh = Math.max(2, Math.floor(h * this.resScale));
    if (this.depthRT && this.depthRT.width === dw && this.depthRT.height === dh) return;
    this.depthRT?.dispose();
    this.depthRT = new THREE.WebGLRenderTarget(dw, dh, {
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: new THREE.DepthTexture(dw, dh),
    });
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    if (!readBuffer) return;
    if (!this.enabled) return;
    const rbuf = readBuffer as THREE.WebGLRenderTarget & { depthTexture?: THREE.Texture | null };
    let depthTex: THREE.Texture | null = rbuf.depthTexture ?? null;
    if (!depthTex) {
      this.ensureTargets(readBuffer.width, readBuffer.height);
      const depthRT = this.depthRT!;
      this._frame++;
      const camNow = this.camera.position;
      const moved = this._lastCam.distanceToSquared(camNow) > 2.25;
      if (!this._depthValid || (moved && this._frame % 3 === 0)) {
        this._lastCam.copy(camNow);
        this._depthValid = true;
        renderer.setRenderTarget(depthRT);
        renderer.clear(true, true, true);
        renderer.render(this.scene, this.camera);
      }
      depthTex = depthRT.depthTexture;
    }
    const u = this.apMat.uniforms;
    u.uDepthTex.value = depthTex;
    u.uDepthOn.value = 1;

    (u.uInvProjection.value as THREE.Matrix4).copy(this.camera.projectionMatrixInverse);
    (u.uInvView.value as THREE.Matrix4).copy(this.camera.matrixWorld);
    this.tmpInvVP.multiplyMatrices(this.camera.matrixWorld, this.camera.projectionMatrixInverse);
    (u.uInvViewProj.value as THREE.Matrix4).copy(this.tmpInvVP);
    (u.uCameraPos.value as THREE.Vector3).copy(this.camera.position);

    this.renderMask(renderer, readBuffer.width, readBuffer.height, u);

    u.uScene.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);
  }

  /** 玩家机体遮罩: 只把 maskLayer 上的 mesh 渲进一张低清图(白 = 机体)。 */
  private renderMask(
    renderer: THREE.WebGLRenderer,
    w: number,
    h: number,
    u: Record<string, { value: unknown }>,
  ): void {
    if (!this.excludeRoot || this.maskLayer <= 0 || !this.aircraftExcluded) { u.uMaskOn.value = 0; return; }
    this._frame++;
    // 机体网格可能后挂(异步模型/换涂装/损伤件) ⇒ 每 90 帧自愈重挂一次
    if (this._frame % 90 === 1) this.refreshExcludeLayers();
    const mw = Math.max(2, Math.floor(w * this.resScale));
    const mh = Math.max(2, Math.floor(h * this.resScale));
    if (!this.maskRT || this.maskRT.width !== mw || this.maskRT.height !== mh) {
      this.maskRT?.dispose();
      this.maskRT = new THREE.WebGLRenderTarget(mw, mh, { depthBuffer: true, stencilBuffer: false });
      this.maskRT.texture.minFilter = THREE.LinearFilter;
      this.maskRT.texture.magFilter = THREE.LinearFilter;
    }
    const cam = this.camera as THREE.Camera;
    const prevMaskLayers = cam.layers.mask;
    const prevClear = new THREE.Color();
    renderer.getClearColor(prevClear);
    const prevAlpha = renderer.getClearAlpha();
    // ① 背景不认图层 ⇒ 必须暂时摘掉 scene.background; ② 用纯白平涂 overrideMaterial
    const prevBg = this.scene.background;
    const prevOverride = this.scene.overrideMaterial;
    this.scene.background = null;
    this.scene.overrideMaterial = this.maskMat;
    cam.layers.set(this.maskLayer);
    renderer.setClearColor(0x000000, 1);
    renderer.setRenderTarget(this.maskRT);
    renderer.clear(true, true, false);
    renderer.render(this.scene, cam);
    this.scene.overrideMaterial = prevOverride;
    this.scene.background = prevBg;
    cam.layers.mask = prevMaskLayers;
    renderer.setClearColor(prevClear, prevAlpha);
    u.uMaskTex.value = this.maskRT.texture;
    u.uMaskOn.value = 1;
  }

  override dispose(): void {
    this.depthRT?.dispose();
    this.depthRT = null;
    this.maskRT?.dispose();
    this.maskRT = null;
    this.maskMat.dispose();
    this.apMat.dispose();
    this.fsQuad.dispose();
  }
}
