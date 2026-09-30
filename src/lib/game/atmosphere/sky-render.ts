// === 物理天空渲染 + 大气系统(LUT 管理器) ======================================
//
// 替换 `environment.ts` 里 `buildAtmosphericSky()` 用的 ATMOSPHERE_FRAG(那套是"手调假大气":
// opticalDepth = 1/(dir.y+0.05) 的假光学厚度、没有 Ozone、地平线是一条手调色带)。
//
// 天空像素 = Sky-View LUT(一次采样) + 太阳圆盘(含透过率衰减)。所有大气积分都在 LUT 里做完了,
// 所以这个着色器极便宜、也永远不会和 AP 体积/PMREM 的取值不一致。
//
// 关于色调映射 (照抄现有做法):
//   · 场景是 **线性 HDR** 缓冲(HalfFloat), 真正的 ACES 由后处理链末尾的 OutputPass 做 ⇒
//     天空着色器输出**线性辐射亮度**即可, 这里不自己做 tone mapping(与旧的 ATMOSPHERE_FRAG
//     的 col/(col+1) 不同 —— 那是为了在 8bit 时代不爆掉而手写的 rolloff, 物理天空不需要)。
//   · 唯一例外是 **PMREM 烘焙(uAtmEnvBake=1)**: scene.environment 是"线性光照"通道, 而旧实现
//     喂进去的是 rolloff 后的显示域亮度; 为了让 IBL 亮度**不至于突然变一个量级**, 烘焙时套用
//     与 environment.ts 的 HDRI dome 同一条 Narkowicz ACES 拟合(见 acesFilmic 注释)。
import * as THREE from 'three';
import {
  ATMO_COMMON_GLSL,
  EARTH_ATMOSPHERE,
  LUT_SIZES,
  cloneAtmosphereParams,
  createAtmosphereFrame,
  createAtmosphereUniforms,
  feedAtmosphereFrame,
  worldToAtmosphereKm,
  type AtmosphereFrame,
  type AtmosphereParams,
  type AtmosphereUniforms,
} from './params';
import { LutBaker, TransmittanceLut } from './lut-transmittance';
import { MultiscatterLut } from './lut-multiscatter';
import { SkyViewLut } from './lut-skyview';
import { AerialPerspectiveLut } from './lut-aerial';

/** 天空球半径: 必须大于任何可能的相机高度(否则天空会"消失"), 且顶点会被钉到远平面。
 *  === 4× 世界放大到 250 km (per user request: "天空盒还是不够大需要放大两三倍") =====
 *  旧值 100 km 是给 60.75 km 见方的旧地图调的; 现在的世界是 291.6 km(±145.8 km),
 *  加上 engine 每帧把穹顶挪到相机位置, 250 km 给足余量。
 *  ⚠ 顶点被钉到远平面(gl_Position.z = w) ⇒ 半径不参与深度, 只决定射线方向的曲率。 */
const SKY_DOME_RADIUS = 250_000;

const SKY_VERT = /* glsl */ `
varying vec3 vWorldPos;
void main() {
  vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w;   // 钉在远平面(与旧天空盒同一契约: 不吃深度/永远最远)
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorldPos;

${ATMO_COMMON_GLSL}

uniform sampler2D uAtmSkyLut;
uniform sampler2D uAtmTransLut;
uniform vec3 uAtmCameraWorld;    // 世界坐标的相机位置(天空盒不跟随相机, 方向必须自己算)
uniform float uAtmEnvBake;       // 1 = PMREM 烘焙模式
uniform float uAtmSkyLutOn;      // 0 = LUT 不可用(建造失败), 输出一个安全的兜底色
uniform float uAtmEnvK;          // PMREM 烘焙专用的亮度标定(与画面曝光解耦, 见 engine 说明)

// Narkowicz ACES 拟合 —— 与 environment.ts 的 HDRI dome 用的是同一条曲线
// (只用在 PMREM 烘焙, 让 scene.environment 的亮度与旧天空盒同一量级)。
vec3 acesFilmic(vec3 x) {
  float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec3 rd;
  if (uAtmEnvBake > 0.5) {
    // PMREM 的虚拟相机在原点 ⇒ 方向就是顶点方向(不能减玩家相机位置)
    rd = normalize(vWorldPos);
  } else {
    rd = normalize(vWorldPos - uAtmCameraWorld);
  }

  if (uAtmSkyLutOn < 0.5) {
    gl_FragColor = vec4(vec3(0.25, 0.35, 0.5), 1.0);
    return;
  }

  vec3 up = uAtmUpDir;
  float viewHeight = max(uAtmViewHeight, uAtmBottomRadius);
  float mu = dot(rd, up);
  float zenith = acos(clamp(mu, -1.0, 1.0));
  float cAz = atmoAzimuthCos(rd, up, uAtmSunDir);

  // 画面曝光(radianceScale)与 IBL 曝光(envK)**解耦**: 前者是"这张照片怎么曝光",
  // 后者是"场景的天光有多亮" —— 混用会把机体/地形整体洗白(实测踩过)。
  float scale = (uAtmEnvBake > 0.5) ? uAtmEnvK : uAtmRadianceScale;

  vec2 uv = vec2(atmoLightViewCosToUvX(cAz), atmoZenithToUvY(zenith, viewHeight));
  uv = vec2(atmoUnitToSub(uv.x, ATMO_SKY_W), atmoUnitToSub(uv.y, ATMO_SKY_H));
  vec3 col = texture2D(uAtmSkyLut, uv).rgb * scale;

  // === 太阳圆盘(被大气透过率衰减) =============================================
  // 用一个很窄的 cos 过渡做抗锯齿(固定宽度 ≈ 0.2°, 不依赖 fwidth/导数扩展)
  float cosSun = dot(rd, uAtmSunDir);
  float cosR = cos(uAtmSunAngularRadius);
  float disc = smoothstep(cosR - 8e-6, cosR + 8e-6, cosSun);
  if (disc > 0.0) {
    // 沿**像素方向**采样透过率 ⇒ 太阳贴地平线时圆盘会被压扁/变红(物理上正确)
    vec3 Tsun = atmoSampleTransmittance(uAtmTransLut, viewHeight, mu);
    // 视线被行星挡住(太阳在地平线下)时不画
    vec3 ro = vec3(0.0, max(viewHeight, uAtmBottomRadius), 0.0);
    if (atmoRaySphereNearest(ro, rd, uAtmBottomRadius) >= 0.0) Tsun = vec3(0.0);
    col += disc * uAtmSolarIrradiance * uAtmSunDiscScale * Tsun * scale;
  }

  // 可选解析光晕(默认关: 光晕已经由 Sky-View LUT 的米氏项给出, 开了会轻微重复计数)
  if (uAtmSunHalo > 0.0 && mu > 0.0) {
    float h0 = max(viewHeight - uAtmBottomRadius, 0.0);
    vec3 Tview = atmoSampleTransmittance(uAtmTransLut, viewHeight, mu);
    float column = min(1.0 / max(mu, 0.05), 12.0) / max(uAtmInvMieH, 1e-6);
    col += uAtmSolarIrradiance * uAtmSunDiscScale * uAtmSunHalo * Tview
         * atmoScatterMie(h0) * atmoMiePhase(clamp(cosSun, -1.0, 1.0), uAtmMieG) * column * scale;
  }

  // 有限性保险(见 params.ts atmoClampRadiance): LUT 里万一有坏 texel, 也不能让整帧变黑
  col = clamp(col, vec3(0.0), vec3(1.0e5));
  if (uAtmEnvBake > 0.5) col = acesFilmic(col);
  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * 大气系统: 4 张 LUT 的建造/调度 + 物理天空网格。
 *
 * 更新节奏(见各 LUT 文件头):
 *   · transmittance: 只依赖介质 ⇒ 参数变化时
 *   · multiscatter : 太阳高度角变化 > 0.2° 且距上次 > 24 帧
 *   · sky-view     : 每帧(高度/太阳角无变化则跳过)
 *   · aerial       : 每帧(同上)
 */
export class AtmosphereSystem {
  readonly params: AtmosphereParams;
  readonly uniforms: AtmosphereUniforms;
  readonly frame: AtmosphereFrame;
  readonly skyMesh: THREE.Mesh;

  private renderer: THREE.WebGLRenderer;
  private baker: LutBaker;
  readonly transmittance: TransmittanceLut;
  readonly multiscatter: MultiscatterLut;
  readonly skyView: SkyViewLut;
  readonly aerial: AerialPerspectiveLut;

  private skyMat: THREE.ShaderMaterial;
  private envBaking = false;
  private frameIndex = 0;
  private disposed = false;
  /** 每帧统计(atmo report) */
  readonly stats = {
    frame: 0, sunZenith: 0, altitude: 0,
    msBakes: 0, skyBakes: 0, apBakes: 0, transBakes: 0,
  };

  constructor(renderer: THREE.WebGLRenderer, params: AtmosphereParams = EARTH_ATMOSPHERE) {
    this.renderer = renderer;
    this.params = cloneAtmosphereParams(params);
    this.uniforms = createAtmosphereUniforms(this.params);
    this.frame = createAtmosphereFrame();
    this.baker = new LutBaker();

    this.transmittance = new TransmittanceLut(this.uniforms, this.baker);
    this.multiscatter = new MultiscatterLut(this.uniforms, this.transmittance.texture, this.baker);
    this.skyView = new SkyViewLut(this.uniforms, this.transmittance.texture, this.multiscatter.texture, this.baker);
    this.aerial = new AerialPerspectiveLut(this.uniforms, this.transmittance.texture, this.multiscatter.texture, this.baker);

    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        ...(this.uniforms as unknown as Record<string, THREE.IUniform>),
        uAtmSkyLut: { value: this.skyView.texture },
        uAtmTransLut: { value: this.transmittance.texture },
        uAtmCameraWorld: { value: new THREE.Vector3() },
        uAtmEnvBake: { value: 0 },
        uAtmSkyLutOn: { value: 1 },
        // PMREM/IBL 专用的亮度标定: 与画面曝光(radianceScale=30 级)解耦。
        // 物理天空的动态范围(天顶↔地平 ≈30~100 倍)比旧手调天空大得多, 直接用画面曝光会把
        // 地平线整片烧到 ACES 上限 ⇒ 天光变成"全白环境光"⇒ 机体/地形整体洗白(踩过)。
        // 20 是"天顶 ≈ 0.45、地平 ≈ 0.9"的标定值, 与旧天空盒 PMREM 的量级相当。
        uAtmEnvK: { value: 12 },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: false,   // 与旧的 buildAtmosphericSky 同款声明(ShaderMaterial 本来不吃 three 的 tonemap)
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_DOME_RADIUS, 48, 24), this.skyMat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1000;
    this.skyMesh = mesh;
  }

  /** 天空网格上的材质(engine 检查/替换时用) */
  get material(): THREE.ShaderMaterial { return this.skyMat; }

  /** 加载期把四张 LUT 全部烤出来(不做节流), 并喂一次每帧参数。 */
  warmup(frame: AtmosphereFrame, farDistanceM: number): void {
    feedAtmosphereFrame(this.uniforms, frame, this.params);
    this.applyFrameToMaterials(frame);
    const sunZenith = this.computeSunZenith(frame);
    this.transmittance.ensure(this.renderer);
    this.multiscatter.force(this.renderer, Math.cos(sunZenith));
    this.skyView.update(this.renderer, frame.cameraPosition.y, sunZenith);
    this.aerial.update(this.renderer, frame.cameraPosition.y, sunZenith, farDistanceM);
    this.renderer.setRenderTarget(null);
  }

  /**
   * 每帧调用: 喂参数 + 按需重烤。renderer 状态会被改(setRenderTarget(null) 收尾),
   * 所以**必须在 composer 渲染之前**调用(engine 在 render() 开头调)。
   */
  update(frame: AtmosphereFrame, farDistanceM: number): void {
    if (this.disposed) return;
    this.frameIndex++;
    feedAtmosphereFrame(this.uniforms, frame, this.params);
    this.applyFrameToMaterials(frame);
    const sunZenith = this.computeSunZenith(frame);
    this.stats.frame = this.frameIndex;
    this.stats.sunZenith = sunZenith;
    this.stats.altitude = frame.cameraPosition.y;

    const prevTarget = this.renderer.getRenderTarget();
    this.transmittance.ensure(this.renderer);
    this.multiscatter.update(this.renderer, Math.cos(sunZenith), this.frameIndex);
    this.skyView.update(this.renderer, frame.cameraPosition.y, sunZenith);
    this.aerial.update(this.renderer, frame.cameraPosition.y, sunZenith, farDistanceM);
    this.renderer.setRenderTarget(prevTarget);

    this.stats.transBakes = this.transmittance.bakes;
    this.stats.msBakes = this.multiscatter.bakes;
    this.stats.skyBakes = this.skyView.bakes;
    this.stats.apBakes = this.aerial.bakes;
  }

  /** 太阳相对**相机地方向上**的天顶角(弧度) */
  private computeSunZenith(frame: AtmosphereFrame): number {
    const up = this.uniforms.uAtmUpDir.value as THREE.Vector3;
    return Math.acos(THREE.MathUtils.clamp(up.dot(frame.sunDirection), -1, 1));
  }

  private applyFrameToMaterials(frame: AtmosphereFrame): void {
    const u = this.skyMat.uniforms;
    (u.uAtmCameraWorld.value as THREE.Vector3).copy(frame.cameraPosition);
    u.uAtmEnvBake.value = this.envBaking ? 1 : 0;
  }

  /** 介质参数/天气变化: 透过率 + 多次散射 + 天空 + AP 全部重烤。 */
  invalidateAll(): void {
    this.transmittance.invalidate();
    this.multiscatter.invalidate();
    this.skyView.invalidate();
    this.aerial.invalidate();
  }

  /** 改介质的雾霾(天气 turbidity): Mie 系数倍率。 */
  setMieScale(v: number): void {
    this.frame.mieScale = Math.max(0.05, v);
    this.uniforms.uAtmMieScale.value = this.frame.mieScale;
    this.invalidateAll();
  }

  /**
   * PMREM/IBL 的曝光标定(uAtmEnvK)。
   *
   * 为什么要有这个 setter: 物理大气的天光在低太阳高度角下**物理上就暗**(6.4° 太阳的
   * 天光只有正午的 ~13%), 而旧 HDRI 三关的天空盒是一张"明亮黄昏"的 EXR ⇒ 直接换源会让
   * 地形几乎全黑(实测地形区亮度 m13 101→31、t00 50→7)。envK 就是"这张天空当天光用有
   * 多亮"的唯一旋钮(与画面曝光 radianceScale **解耦**, 见本文件顶部的说明), 引擎对那三关
   * 乘一个补偿系数(见 engine.setupSkyEnvironment 的 DUSK_ENV_K)。
   * 只在**烘焙时**起作用 ⇒ 改完必须重烘一次(setupSkyEnvironment 里连在一起调)。
   */
  setEnvK(k: number): void {
    this.skyMat.uniforms.uAtmEnvK.value = Math.max(0.1, k);
  }

  /** 当前 IBL 曝光标定(诊断/探针读)。 */
  getEnvK(): number {
    return this.skyMat.uniforms.uAtmEnvK.value as number;
  }

  /**
   * PMREM 烘焙专用: 把"相机"摆到原点(高度不变)并按该高度重烤一遍 LUT, 让 IBL 的天光与
   * 关卡高度一致; 烘焙结束后 engine 调用 endEnvBake() 收尾。
   * (PMREM 的虚拟相机在原点, 天空网格也在原点 ⇒ 方向用顶点方向, 不能减玩家相机位置。)
   */
  beginEnvBake(frame: AtmosphereFrame, farDistanceM: number): void {
    const alt = Math.max(0, frame.cameraPosition.y);
    this.envBaking = true;
    const f: AtmosphereFrame = { ...frame, cameraPosition: new THREE.Vector3(0, alt, 0) };
    this.warmup(f, farDistanceM);
  }

  endEnvBake(): void {
    this.envBaking = false;
    this.skyMat.uniforms.uAtmEnvBake.value = 0;
  }

  /**
   * 烘 PMREM 环境(scene.environment 的 IBL 源)。
   * 用**同一份天空材质**(uAtmEnvBake=1 ⇒ 输出过 ACES 的显示域亮度)渲染到一个临时网格,
   * 保证 IBL 的方向分布与画面里的天空完全一致; 抛异常由调用方 catch。
   */
  bakeEnvironment(pmrem: THREE.PMREMGenerator, farDistanceM: number): THREE.WebGLRenderTarget {
    this.beginEnvBake(this.frame, farDistanceM);
    const skyScene = new THREE.Scene();
    const geo = new THREE.SphereGeometry(SKY_DOME_RADIUS, 48, 24);
    const mesh = new THREE.Mesh(geo, this.skyMat);
    mesh.frustumCulled = false;
    skyScene.add(mesh);
    const rt = pmrem.fromScene(skyScene, 0.04, 100, 1000);
    geo.dispose();
    skyScene.remove(mesh);
    this.endEnvBake();
    return rt;
  }

  /** 给 `atmo report` 用的可读状态 */
  report(): string {
    const [tw, th] = LUT_SIZES.transmittance;
    const [mw, mh] = LUT_SIZES.multiscatter;
    const [sw, sh] = LUT_SIZES.skyView;
    const [aw, ah] = LUT_SIZES.aerial;
    const s = this.stats;
    const sunY = this.frame.sunDirection.y;
    return [
      `大气(物理/Hillaire2020)`,
      `LUT 透过率 ${tw}x${th}(参数变化才烤, 已烤 ${s.transBakes})`,
      `LUT 多次散射 ${mw}x${mh}(太阳高度角变化>0.2° 且间隔>24帧, 已烤 ${s.msBakes})`,
      `LUT 天空 ${sw}x${sh}(每帧/带冗余保护, 已烤 ${s.skyBakes})`,
      `LUT 空气光 ${aw}x${ah}×4项 2D变体(每帧/带冗余保护, 已烤 ${s.apBakes}; 远平面 ${this.aerial.maxDistanceKm.toFixed(0)}km 指数 ${this.aerial.depthExponent})`,
      `太阳 高度角 ${(Math.asin(THREE.MathUtils.clamp(sunY, -1, 1)) * 180 / Math.PI).toFixed(2)}° 相对相机天顶角 ${(s.sunZenith * 180 / Math.PI).toFixed(2)}°`,
      `相机高度 ${s.altitude.toFixed(1)}m  亮度倍率 ${this.frame.radianceScale.toFixed(2)}  MS倍率 ${this.multiscatter.getScale().toFixed(2)}  Mie倍率 ${this.frame.mieScale.toFixed(2)}`,
      `开关 多次散射=${this.frame.multiscatter} 臭氧=${this.frame.ozone} 太阳盘=${this.frame.sunDiscScale} 光晕=${this.frame.sunHalo}`,
      `帧号 ${s.frame}`,
    ].join(' | ');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.transmittance.dispose();
    this.multiscatter.dispose();
    this.skyView.dispose();
    this.aerial.dispose();
    this.baker.dispose();
    this.skyMat.dispose();
    (this.skyMesh.geometry as THREE.BufferGeometry).dispose();
  }
}
