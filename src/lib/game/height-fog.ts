// === 指数级高度雾 v3 · 大气透视 (per user request: 升级成大气透视 Atmospheric Perspective) =
//
// 用户原话: "把原本的雾系统升级成这种质感 —— 近处对比度高, 远处被洗白, 山谷比山顶浓,
//   雾与阳光有互动(远处微微发光)"; 并给了参考图(远处山体被蓝白光罩住、暗部被提亮)。
//
// v1(`buildHeightFogVolume` 那个大盒子)失败的原因见下(v2 注释), 已经修好了;
// v2 只做了"高度积分 + 混到天空色", 缺的正是**大气透视的三件事里最关键的两件**:
//   · 内散射**没有方向性** —— 无论朝哪看, 雾都是一样的蓝白, 于是"迎光/背光"没有区别,
//     也就没有"远处的雾被太阳照亮"的那种发光感;
//   · 混合是**单色 lerp**, 没有"空气光"的加性成分 —— 远处的暗部只是被染蓝, 没有被**提亮**,
//     对比度不下降 ⇒ 看着还是"一层蓝雾", 而不是"大气"。
//
// v3 改的就是这两件(物理形式取空气光的标准写法):
//   · 消光+内散射:  out = scene·T + airCol·(1-T),  T = exp(-od)(= v2 的 mix, 但 airCol 现在有方向)
//   · 方向相关内散射(Mie 前向散射): airCol = mix(hazeBlue, sunWarm, (dot(rd, sunDir))^sunPow · 散射强度)
//     朝太阳看 → 暖白微发光; 背对太阳 → 只剩瑞利散射的冷蓝白。太阳落到地平线下时暖色自动消退。
//   · 空气光的"对比度衰减": 远处按 alpha 去饱和(out = mix(out, luma(out), desat·alpha)),
//     暗部被提亮、色彩被洗掉 —— 这就是参考图里远山"发白、发灰、没有黑"的成因。
//   · 额外一点加性太阳光晕(glow), 让雾本身"被照亮"(参考图远景的微弱发光)。
//
// 近处对比度靠 startDistance(默认 900m)保住: 900m 内的物体 od 从中段才开始积 ⇒ alpha≈0,
// 机体/近景山体保持原始饱和度 —— 正是用户要的"近处对比度高"。
//
// v2 的做法(真·指数高度雾, 屏幕空间解析积分):
//   · 高度密度取经典的指数剖面  ρ(y) = density · exp(-(y - base) / H)   (H = scaleHeight)
//   · 沿视线**解析积分**(闭式解, 每像素 O(1), 不用一步一步走):
//       |rd.y| 很小(水平):  od = ρ(y0) · (tEnd - tStart)
//       否则:               od = density·H/|rd.y| · |exp(-h(tEnd)/H) - exp(-h(tStart)/H)|
//     (h(y) = max(y, base) - base —— base 以下按 base 处的密度, 免得地下指数爆表)
//   · 颜色不是"雾色", 而是**天空地平线色**(engine 每帧把 cfg.bottom / 天光采样喂进来),
//     于是远处地形自然地收敛到天空色 ⇒ 地平线消失、天际线的锯齿被抹平 —— 这正是"不是雾"。
//   · 天空像素单独处理: 只在地平线附近给一个很窄的提亮(band 由 skyLift/角度控制),
//     让天空与远处地形的接缝也对上; 抬头看天不受影响。
//   · 深度来自自己的**低清深度 RT**(0.25 分辨率; 雾是极低频信号, 够用)。
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FOG_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D uScene;
uniform sampler2D uDepthTex;
uniform sampler2D uMaskTex;   // (已废弃——机体豁免的活口在 atmosphere/aerial-perspective-pass.ts)
uniform float uMaskOn;
uniform mat4  uInvViewProj;
uniform mat4  uInvProjection;
uniform mat4  uInvView;
uniform vec3  uCameraPos;
uniform float uDepthOn;

uniform vec3  uHazeColor;     // 大气透视的"目标色"= 天空地平线色(engine 每帧给)
uniform vec3  uSunColor;      // 被太阳照亮时雾的暖色(= cfg.sunColor; engine 每帧给)
uniform vec3  uSunDir;        // 太阳方向(世界空间, 归一化; engine 每帧给)
uniform float uSunScatter;    // 阳光散射强度 0..1(0 = 关 → 纯蓝白均匀雾, 等于 v2 行为)
uniform float uSunPow;        // 前向散射角向尖锐度(越大越集中在太阳方向; 3..8 好看)
uniform float uDesat;         // 空气光的对比度衰减: 远处按 alpha 去饱和 0..1
uniform float uSunGlow;       // 雾自身的微弱发光(太阳方向的雾被照亮)0..1
uniform float uDensity;       // 每米光学密度(在 base 高度处)
uniform float uBase;          // 雾集中高度(米)
uniform float uScaleH;        // 指数衰减尺度 H(米)
uniform float uStart;         // 起效距离(米): 近处不上雾, 免得贴着镜头糊
uniform float uMaxOpacity;    // 总强度上限(0..1) —— 近中景行为
uniform float uFarFade0;      // 天际带判据: 视线仰角上限(弧度), 0 = 关闭

uniform float uFarFade1;      // 天际带判据: 该带内要求的最小光学厚度
uniform float uSkyLift;       // 天空像素在地平线附近的提亮(抹平接缝)
uniform float uSkyBand;       // 天空提亮的仰角尺度(弧度)

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 rayEye = uInvProjection * vec4(ndc, -1.0, 1.0);
  rayEye = vec4(rayEye.xy, -1.0, 0.0);
  vec3 rd = normalize((uInvView * rayEye).xyz);

  // === 场景距离(无几何/未写深度 = 天空) ===
  float tEnd = 1e9;
  bool isSky = true;
  if (uDepthOn > 0.5) {
    float d = texture2D(uDepthTex, vUv).r;
    if (d < 1.0) {
      vec4 w = uInvViewProj * vec4(ndc, d * 2.0 - 1.0, 1.0);
      tEnd = length(w.xyz / w.w - uCameraPos);
      isSky = false;
    }
  }

  // === 内散射色的方向性(Mie 前向散射)=============================
  //   朝太阳看 → 雾被照暖、发亮; 背对太阳 → 只剩瑞利散射的冷蓝白。
  //   sunVis: 太阳落到地平线以下后暖色自然消退(否则夜里也会有暖雾)。
  //   注意: 用 uSunDir.y 判可见度, 不用"太阳是否被山挡住"—— 后者要额外一张
  //   太阳可见性图, 收益远小于成本(雾是极低频信号, 山的遮挡在近处已由 startDistance 处理)。
  float sunAmt = max(dot(rd, uSunDir), 0.0);
  float sunVis = smoothstep(-0.10, 0.12, uSunDir.y);
  float fwd = pow(sunAmt, max(uSunPow, 1.0)) * uSunScatter * sunVis;
  vec3  airCol = mix(uHazeColor, uSunColor, clamp(fwd, 0.0, 1.0));

  vec3 scene = texture2D(uScene, vUv).rgb;
  // === 玩家机体: 完全不吃大气透视 (per user request: "那个雾就应该完全忽略飞机本体来计算") ===
  // 命中遮罩 = 该像素属于玩家机体 ⇒ 原样输出。放在最前面, 连 skyLift/散射/去饱和都不参与。
  if (uMaskOn > 0.5 && texture2D(uMaskTex, vUv).r > 0.02) {
    gl_FragColor = vec4(scene, 1.0);
    return;
  }
  float alpha;

  if (isSky) {
    // 天空: 只在地平线附近拉一点点, 让"天"和"远处地形"接上(抬头看天不受影响)。
    float up = max(rd.y, 0.0);
    alpha = uMaxOpacity * uSkyLift * exp(-up / max(uSkyBand, 1e-3));
  } else {
    float H = max(uScaleH, 1.0);
    float tStart = clamp(uStart, 0.0, tEnd);
    // h(y) = max(y, base) - base: base 以下用 base 处的密度(避免地下指数爆炸)
    float h0 = max(uCameraPos.y, uBase) - uBase;
    float yEnd = uCameraPos.y + rd.y * tEnd;
    float h1 = max(yEnd, uBase) - uBase;
    float od;
    if (abs(rd.y) < 1e-4) {
      od = uDensity * exp(-h0 / H) * (tEnd - tStart);
    } else {
      // 解析积分: ∫ ρ ds = -H/rd.y · [exp(-h(s)/H)] 从 tStart 到 tEnd
      float ts = uCameraPos.y + rd.y * tStart;
      float hs = max(ts, uBase) - uBase;
      od = uDensity * H / abs(rd.y) * abs(exp(-h1 / H) - exp(-hs / H));
    }
    alpha = uMaxOpacity * (1.0 - exp(-max(od, 0.0)));
    // === 天际带"彻底溶解" (per user: 远处地形与天空的分界线太硬, 抹不掉) ==========
    // 症状: 远处地形的**剪影**与天空之间一直有一条清晰的边 —— 因为 maxOpacity(0.82) 是
    //   **全局上限**: 光学厚度再大也只到 0.82 ⇒ 永远留 ~18% 原色 ⇒ 那条边永远在。
    // 为什么不能直接把 maxOpacity 拉满: 它是近中景的行为标定(§219 的教训: 拉满会让海天线
    //   整条消失)。所以这里**只对天际带**再叠一项, 把 alpha 继续推向 1.0。
    //
    // ⚠ 判据用**视线仰角**而不是光学厚度: 第一版按 od>1.5 触发, 实测量到的变化只有
    //   0.9/255 —— 因为 od 强烈依赖高度(4.3km 高度平视地平线 od≈1.3, 而低空是 3.6),
    //   同一组阈值在不同高度/不同关卡上完全不是一回事。
    //   改成"|rd.y| 小于 uFarFade0(弧度) 且 od 大于 uFarFade1" ⇒ **任何高度**的天际带都能中,
    //   且 od 门槛保证"贴脸的平视几何"不被误伤。
    //   现场调: 控制台 hfog far <band> <odMin>(band=0 关闭)。别在这里写反引号, 会截断模板串。
    if (uFarFade0 > 0.0) {
      float horiz = 1.0 - clamp(abs(rd.y) / uFarFade0, 0.0, 1.0);   // 1 = 正对地平线
      float farK = horiz * smoothstep(uFarFade1 * 0.5, uFarFade1, max(od, 0.0));
      alpha = max(alpha, farK);
    }
  }

  if (alpha < 0.002) {
    gl_FragColor = vec4(scene, 1.0);
    return;
  }
  // === 空气光(aerial perspective): 消光 + 内散射 ==================
  //   out = scene·T + airCol·(1-T) —— T = 1-alpha。与 v2 的 mix 同形,
  //   但 airCol 现在随视线与太阳的夹角变化 ⇒ 迎光/背光观感不同。
  vec3 outc = scene * (1.0 - clamp(alpha, 0.0, 1.0)) + airCol * clamp(alpha, 0.0, 1.0);
  // === 对比度衰减("洗白"): 远处向自身亮度靠拢 = 暗部被提亮、彩度被洗掉 ===
  //   只对**几何像素**做(alpha 已经很小); 天空像素的 alpha 很小, 影响可忽略。
  float luma = dot(outc, vec3(0.2126, 0.7152, 0.0722));
  outc = mix(outc, vec3(luma), clamp(uDesat * alpha, 0.0, 1.0));
  // === 雾本身被太阳照亮的那点微光(参考图里远景的"微微发光") ===
  outc += uSunColor * (uSunGlow * fwd * alpha);
  gl_FragColor = vec4(outc, 1.0);
}
`;

export interface HeightFogParamsV2 {
  /** 目标色(一般为天空地平线色; engine 每帧更新) */
  hazeColor: THREE.Color;
  /** 光学密度(1/m, 在 base 高度处) */
  density: number;
  /** 雾集中高度(米) */
  baseHeight: number;
  /** 指数衰减尺度 H(米) */
  scaleHeight: number;
  /** 起效距离(米) */
  startDistance: number;
  /** 强度上限 0..1(近中景行为) */
  maxOpacity: number;
  /** 天际带判据: 视线仰角上限(弧度); 0 = 关闭 */
  farFade0: number;
  /** 天际带判据: 带内要求的最小光学厚度(避免误伤贴脸的平视几何) */
  farFade1: number;
  /** 天空在地平线附近的提亮 0..1 */
  skyLift: number;
  /** 天空提亮的仰角尺度(弧度, 默认 ~0.05 = 3°) */
  skyBand: number;
  // === 大气透视 (v3) ======================================================
  /** 阳光散射强度 0..1; 0 = 关(退化成 v2 的均匀蓝白雾) */
  sunScatter: number;
  /** 前向散射角向尖锐度(1 = 大范围泛暖, 3~8 = 集中在太阳附近) */
  sunPow: number;
  /** 空气光的对比度衰减(远处去饱和/洗白)0..1 */
  desat: number;
  /** 雾自身被太阳照亮的微光 0..1 */
  sunGlow: number;
  /** 太阳方向(世界空间, 归一化; engine 每帧从 cfg.sunPos 喂) */
  sunDir: THREE.Vector3;
  /** 被太阳照亮的暖雾色(engine 每帧从 cfg.sunColor 喂) */
  sunColor: THREE.Color;
  enabled: boolean;
}

export class HeightFogPass extends Pass {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private fogMat: THREE.ShaderMaterial;
  private fsQuad: FullScreenQuad;
  private depthRT: THREE.WebGLRenderTarget | null = null;
  private tmpInvVP = new THREE.Matrix4();
  /** 深度重渲的节流状态(见 render 里的说明) */
  private _frame = 0;
  private _depthValid = false;
  private _lastCam = new THREE.Vector3(1e9, 1e9, 1e9);
  /** 低清深度 RT 的分辨率比例(雾是极低频信号, 0.25 足够) */
  private resScale = 0.2;
  // === 已删除: 玩家机体"免除大气透视"的图层遮罩 (2026-09-24) =====================
  // 这套(layer 31 + 每帧白遮罩 + overrideMaterial 平涂)是**旧指数高度雾时代**做的。
  // 现状核查(用户的疑问"还有没有用"):
  //   · `HeightFogPass` 只在 `_hfParams.enabled` 为真时才挂, 而**没有任何关卡**打开
  //     `global.fog.heightFog.enabled`(全仓 grep: 只有 terrain-tune 的类型定义、编辑器 UI、
  //     以及 environment.ts 里那个只写不读的 `heightFogVolume` 标记) ⇒ 这条 pass 根本不建;
  //   · 物理大气上线后由 `atmosphere/aerial-perspective-pass.ts` 接管, 两者**互斥**
  //     (`取代 heightFogFx`), 而**活着的机体豁免在那条 AP pass 里**(同款实现,
  //     engine 对它调 setExcludeRoot/setAircraftExclusion, 控制台 `atmo exclusion`)。
  // ⇒ 这里的这层是死代码, 按用户"没用就不要了"删除。shader 里的 `uMaskOn` 分支保留但
  //    永不置位(= 恒不生效), 免得动全屏 shader 引入回归。

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.fogMat = new THREE.ShaderMaterial({
      uniforms: {
        uScene:       { value: null as THREE.Texture | null },
        uDepthTex:    { value: null as THREE.Texture | null },
        // (uMaskTex/uMaskOn 已随"机体豁免"一起删除; shader 里那两个声明保留但永不赋值 => 恒不生效)
        uInvViewProj: { value: new THREE.Matrix4() },
        uInvProjection: { value: new THREE.Matrix4() },
        uInvView:     { value: new THREE.Matrix4() },
        uCameraPos:   { value: new THREE.Vector3() },
        uDepthOn:     { value: 1 },
        uHazeColor:   { value: new THREE.Color(0.72, 0.78, 0.86) },
        uSunColor:    { value: new THREE.Color(1.0, 0.86, 0.68) },
        uSunDir:      { value: new THREE.Vector3(0.25, 0.35, -0.9).normalize() },
        uSunScatter:  { value: 0.70 },
        uSunPow:      { value: 3.0 },
        uDesat:       { value: 0.40 },
        uSunGlow:     { value: 0.28 },
        // 默认值与 engine._hfParams 对齐(engine 每帧 setParams, 这里只是兜底):
        //   密度 1.1e-4 / 尺度高 3500m / 起效 2600m / 上限 0.82。
        uDensity:     { value: 1.1e-4 },
        uBase:        { value: 0 },
        uScaleH:      { value: 3500 },
        uStart:       { value: 2600 },
        uMaxOpacity:  { value: 0.82 },
        // 天际带 = |rd.y| < 0.05 rad(≈2.9度) 且 od > 0.5 的那圈
        uFarFade0:    { value: 0.05 },
        uFarFade1:    { value: 0.5 },
        uSkyLift:     { value: 0.35 },
        uSkyBand:     { value: 0.05 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: FOG_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.fogMat);
    this.needsSwap = true;
    this.enabled = false;
  }

  setParams(p: HeightFogParamsV2) {
    const u = this.fogMat.uniforms;
    (u.uHazeColor.value as THREE.Color).copy(p.hazeColor);
    (u.uSunColor.value as THREE.Color).copy(p.sunColor);
    (u.uSunDir.value as THREE.Vector3).copy(p.sunDir).normalize();
    u.uSunScatter.value = p.sunScatter;
    u.uSunPow.value = p.sunPow;
    u.uDesat.value = p.desat;
    u.uSunGlow.value = p.sunGlow;
    u.uDensity.value = p.density;
    u.uBase.value = p.baseHeight;
    u.uScaleH.value = p.scaleHeight;
    u.uStart.value = p.startDistance;
    u.uMaxOpacity.value = p.maxOpacity;
    u.uFarFade0.value = p.farFade0;
    u.uFarFade1.value = p.farFade1;
    u.uSkyLift.value = p.skyLift;
    u.uSkyBand.value = p.skyBand;
    this.enabled = p.enabled;
  }

  private ensureTargets(w: number, h: number) {
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
  ) {
    if (!readBuffer) return;
    if (!this.enabled) return;
    // 只在"没有 composer 深度"时才需要自己那张 RT
    const hasExtDepth = !!(readBuffer as { depthTexture?: unknown }).depthTexture;
    if (!hasExtDepth) this.ensureTargets(readBuffer.width, readBuffer.height);
    else if (!this.depthRT) this.ensureTargets(readBuffer.width, readBuffer.height);
    const depthRT = this.depthRT!;
    const u = this.fogMat.uniforms;

    (u.uInvProjection.value as THREE.Matrix4).copy(this.camera.projectionMatrixInverse);
    (u.uInvView.value as THREE.Matrix4).copy(this.camera.matrixWorld);
    this.tmpInvVP.multiplyMatrices(this.camera.matrixWorld, this.camera.projectionMatrixInverse);
    (u.uInvViewProj.value as THREE.Matrix4).copy(this.tmpInvVP);
    (u.uCameraPos.value as THREE.Vector3).copy(this.camera.position);

    // 1. 场景深度: 优先用 **composer 自带的深度**(零额外渲染, 见 attachComposerDepth)。
    //    没有才退回"自己渲一张低清深度 RT"(并节流)——老路径保留, 以防某条链没挂深度贴图。
    const rbuf = readBuffer as THREE.WebGLRenderTarget & { depthTexture?: THREE.Texture | null };
    let depthTex: THREE.Texture | null = rbuf.depthTexture ?? null;
    if (!depthTex) {
      this._frame++;
      const camNow = this.camera.position;
      const moved = this._lastCam.distanceToSquared(camNow) > 2.25;
      const needDepth = !this._depthValid || (moved && this._frame % 3 === 0);
      if (needDepth) {
        this._lastCam.copy(camNow);
        this._depthValid = true;
        renderer.setRenderTarget(depthRT);
        renderer.clear(true, true, true);
        renderer.render(this.scene, this.camera);
      }
      depthTex = depthRT.depthTexture;
    }
    u.uDepthTex.value = depthTex;
    // 2. (已删除) 玩家机体遮罩 —— 见类字段区那段"已删除: 机体免除大气透视"的说明。
    //    活着的豁免在 atmosphere/aerial-perspective-pass.ts。
    // 3. 解析高度积分 + 混合到天空色
    u.uScene.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);
  }

  override dispose() {
    this.depthRT?.dispose();
    this.depthRT = null;
    this.fogMat.dispose();
    this.fsQuad.dispose();
  }
}
