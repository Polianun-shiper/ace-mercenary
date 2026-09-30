/**
 * EngineLabRenderer — 高画质空战渲染引擎主类
 * =====================================================================
 * 这是「单独给高画质空战游戏渲染的游戏引擎」的核心入口。
 * 它把 AtmosphericSky + EnhancedShadowSystem + PBRMaterialPipeline
 * + PostProcessingPipeline 串成一个完整的渲染管线，给空战场景用。
 *
 * 用户在 Engine Lab UI 里调参时，EngineLabRenderer.applyProfile()
 * 会被实时调用，立即重建管线让用户看到效果。
 *
 * 在实际游戏中，GameEngine 启动任务时会构造一个 EngineLabRenderer
 * 实例，读取 active profile 并应用，然后每帧调用 render()。
 *
 * 关键性能优化 (60fps 目标):
 *  - 分辨率自适应降级 (adaptiveScaling)
 *  - 像素比上限 (pixelRatioCap)
 *  - 阴影贴图按级联数限制大小
 *  - 后处理 pass 数按性能档选择性启用
 *  - 视锥裁剪 + InstancedMesh
 */
import * as THREE from 'three';
import { AtmosphericSky } from './atmospheric-sky';
import { EnhancedShadowSystem } from './enhanced-shadows';
import { PostProcessingPipeline } from './post-processing';
import type { EngineProfile } from './profile';
import { updateCloudPassUniforms } from '@/lib/clouds/volumetric-cloud-pass';
import {
  cloudAmbientFromSunElevation,
  cloudSunColorFromElevation,
  parseColorHex,
} from '@/lib/clouds/params';

export interface EngineLabRendererOptions {
  canvas: HTMLCanvasElement;
  /** 初始 profile (从 localStorage 加载的) */
  profile: EngineProfile;
}

export class EngineLabRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly sky: AtmosphericSky;
  readonly shadows: EnhancedShadowSystem;
  readonly postFx: PostProcessingPipeline;

  private profile: EngineProfile;
  private currentScale = 1.0;
  private rafHandle = 0;
  private lastTime = performance.now();
  private fpsAccum = 0;
  private fpsCount = 0;
  private fpsAverage = 60;
  private onFpsUpdate?: (fps: number) => void;
  private disposed = false;
  /** 体积云用的时间累加器 (秒) — 永远累加，不受暂停影响 */
  private cloudTime = 0;

  // 给 GameEngine 用的辅助灯
  private hemiLight: THREE.HemisphereLight;
  private ambientLight: THREE.AmbientLight;

  constructor(opts: EngineLabRendererOptions) {
    this.profile = opts.profile;

    // === WebGL Renderer ===
    this.renderer = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: false, // 我们用 SMAA/FXAA pass 代替 MSAA，省内存
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.profile.toneMapping.exposure;
    this.applyResolution();

    // === Scene ===
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a3a5e);
    this.scene.fog = new THREE.FogExp2(0xb8c8d8, this.profile.volumetric.density);

    // === Camera ===
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, 80000);

    // === 大气天光 ===
    this.sky = new AtmosphericSky(80000);
    this.scene.add(this.sky.mesh);
    this.sky.update(this.profile.sky);

    // === 太阳光方向 + 颜色 (供阴影系统用) ===
    const sunDir = (function () {
      const az = THREE.MathUtils.degToRad(opts.profile.sky.sunAzimuth);
      const el = THREE.MathUtils.degToRad(opts.profile.sky.sunElevation);
      return new THREE.Vector3(
        Math.cos(el) * Math.sin(az),
        Math.sin(el),
        Math.cos(el) * Math.cos(az),
      ).normalize();
    })();
    const sunColor = new THREE.Color().setHSL(0.09, 0.3, 0.95);

    // === 阴影系统 ===
    this.shadows = new EnhancedShadowSystem({
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      sunDirection: sunDir,
      sunColor,
      sunIntensity: this.profile.lighting.sunIntensity,
    });
    this.shadows.applyProfile(this.profile);

    // === 环境光 ===
    this.hemiLight = new THREE.HemisphereLight(
      this.profile.lighting.hemisphereSkyColor,
      this.profile.lighting.hemisphereGroundColor,
      this.profile.lighting.ambientIntensity,
    );
    (this.hemiLight as any)._env = true;
    this.scene.add(this.hemiLight);

    this.ambientLight = new THREE.AmbientLight(0xffffff, this.profile.lighting.ambientIntensity * 0.5);
    (this.ambientLight as any)._env = true;
    this.scene.add(this.ambientLight);

    // === 后处理 ===
    this.postFx = new PostProcessingPipeline({
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
    });
    this.postFx.applyProfile(this.profile);
  }

  /** 应用新 profile (重建管线) */
  applyProfile(p: EngineProfile) {
    this.profile = p;

    // 分辨率
    this.applyResolution();

    // 天光
    this.sky.update(p.sky);

    // 太阳方向 / 颜色
    const sunDir = (function () {
      const az = THREE.MathUtils.degToRad(p.sky.sunAzimuth);
      const el = THREE.MathUtils.degToRad(p.sky.sunElevation);
      return new THREE.Vector3(
        Math.cos(el) * Math.sin(az),
        Math.sin(el),
        Math.cos(el) * Math.cos(az),
      ).normalize();
    })();
    this.shadows.setSunDirection(sunDir);

    // 太阳颜色：仰角低时变暖
    const elev = Math.max(0, p.sky.sunElevation) / 90;
    const warm = new THREE.Color(1.6, 0.7, 0.3);
    const noon = new THREE.Color(1.0, 0.96, 0.88);
    const sunColor = warm.clone().lerp(noon, elev);
    this.shadows.setSunColor(sunColor);
    this.shadows.setSunIntensity(p.lighting.sunIntensity);

    // 重建阴影系统 (cascades / mapSize 等可能变了)
    this.shadows.applyProfile(p);

    // 环境光
    this.hemiLight.color.set(p.lighting.hemisphereSkyColor);
    this.hemiLight.groundColor.set(p.lighting.hemisphereGroundColor);
    this.hemiLight.intensity = p.lighting.ambientIntensity;
    this.ambientLight.intensity = p.lighting.ambientIntensity * 0.5;

    // 雾
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.density = p.volumetric.density;
      this.scene.fog.color.set(p.volumetric.color);
    }

    // 重建后处理
    this.postFx.applyProfile(p);
  }

  /** 分辨率缩放 + 像素比上限 */
  private applyResolution() {
    const cap = Math.min(window.devicePixelRatio, this.profile.pixelRatioCap);
    const pr = cap * this.profile.resolutionScale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.currentScale = this.profile.resolutionScale;
    this.postFx?.setSize(window.innerWidth, window.innerHeight);
  }

  resize() {
    this.applyResolution();
  }

  /** 让所有场景里的机体自动接收自阴影 */
  enableSelfShadowOn(obj: THREE.Object3D) {
    this.shadows.enableSelfShadowOnAircraft(obj);
  }

  /** 让地形/建筑接收阴影 */
  enableReceiveShadowOn(obj: THREE.Object3D) {
    this.shadows.enableReceiveShadow(obj);
  }

  /** 仅接收阴影 (适合大物体) */
  enableReceiveShadowOnly(obj: THREE.Object3D) {
    this.shadows.enableReceiveOnly(obj);
  }

  /** 把太阳光跟随玩家走 (让阴影相机始终覆盖玩家附近) */
  followPlayer(playerPos: THREE.Vector3, groundY: number = 0) {
    this.shadows.followTarget(playerPos);
    this.shadows.updateContactShadow(playerPos, groundY);
  }

  /** 设置 FPS 回调 (Engine Lab UI 显示当前 FPS) */
  setFpsCallback(cb: (fps: number) => void) {
    this.onFpsUpdate = cb;
  }

  /**
   * 单帧渲染。可选传入 dt (秒)，默认 1/60。
   * 性能自适应：连续低于 50fps 时降低分辨率到 adaptiveMinScale。
   */
  render(dt: number = 1 / 60) {
    if (this.disposed) return;

    // FPS 监控
    const now = performance.now();
    const realDt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    const fps = 1 / Math.max(realDt, 0.0001);
    this.fpsAccum += fps;
    this.fpsCount++;
    if (this.fpsCount >= 30) {
      this.fpsAverage = this.fpsAccum / this.fpsCount;
      this.fpsAccum = 0;
      this.fpsCount = 0;
      this.onFpsUpdate?.(this.fpsAverage);
      // 自适应降级
      if (this.profile.performance.adaptiveScaling) {
        const targetFps = this.profile.performance.targetFps;
        if (this.fpsAverage < targetFps * 0.85 && this.currentScale > this.profile.performance.adaptiveMinScale) {
          this.currentScale = Math.max(
            this.profile.performance.adaptiveMinScale,
            this.currentScale - 0.1,
          );
          const cap = Math.min(window.devicePixelRatio, this.profile.pixelRatioCap);
          this.renderer.setPixelRatio(cap * this.currentScale);
          this.postFx.setSize(window.innerWidth, window.innerHeight);
        } else if (this.fpsAverage > targetFps * 1.05 && this.currentScale < this.profile.resolutionScale) {
          this.currentScale = Math.min(
            this.profile.resolutionScale,
            this.currentScale + 0.05,
          );
          const cap = Math.min(window.devicePixelRatio, this.profile.pixelRatioCap);
          this.renderer.setPixelRatio(cap * this.currentScale);
          this.postFx.setSize(window.innerWidth, window.innerHeight);
        }
      }
    }

    // 阴影系统跟随相机
    this.shadows.update();
    // 天空跟随相机
    this.sky.followCamera(this.camera.position);

    // 体积云 uniforms 同步 (太阳方向/颜色, 相机矩阵, 时间)
    // 即使 cloud pass 当前 disabled 也更新 (用户随时可能开启)
    const cloudPass = this.postFx.cloudPass;
    if (cloudPass) {
      this.cloudTime += dt;
      const sunDir = this.sky.getSunDirection();
      const sunColor = this.sky.getSunColor();
      // 环境光: 从 profile 取用户设定色, 但若用户没改就用仰角推导的
      const ambient = parseColorHex(this.profile.clouds.ambientColor);
      const elev = this.profile.sky.sunElevation;
      // 自动让 ambient 跟随太阳仰角 (低仰角偏暖)，与用户设置做 50/50 混合
      const autoAmbient = cloudAmbientFromSunElevation(elev);
      ambient.lerp(autoAmbient, 0.5);
      // 太阳颜色同样按仰角推导，与 AtmosphericSky 输出一致
      const autoSunColor = cloudSunColorFromElevation(elev);
      sunColor.lerp(autoSunColor, 0.5);
      const res = new THREE.Vector2(
        this.renderer.domElement.width,
        this.renderer.domElement.height,
      );
      updateCloudPassUniforms(
        cloudPass,
        this.camera,
        sunDir,
        sunColor,
        ambient,
        this.profile.clouds.sunIntensity,
        this.cloudTime,
        res,
      );
    }

    // 后处理链渲染 (包含主 RenderPass + 体积云 + Bloom 等)
    this.postFx.render(dt);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.rafHandle);
    this.postFx.dispose();
    this.shadows.dispose();
    this.sky.dispose();
    this.renderer.dispose();
  }
}
