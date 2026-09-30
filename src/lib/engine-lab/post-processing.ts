/**
 * PostProcessingPipeline — 后处理管线
 * =====================================================================
 * 把所有视觉特效串成 EffectComposer 链：
 *   RenderPass (主渲染)
 *     ↓
 *   SSAO Pass (屏幕空间环境光遮蔽，做出机体缝隙的暗影)
 *     ↓
 *   Bloom Pass (多尺度泛光，太阳 / 引擎尾焰 / 爆炸发光)
 *     ↓
 *   DOF Pass (景深，让远景模糊聚焦于玩家机体)
 *     ↓
 *   Motion Blur Pass (基于速度的运动模糊)
 *     ↓
 *   Color Grading Pass (调色：对比度 / 饱和度 / 色温 / 色调)
 *     ↓
 *   Tone Mapping + Output Pass (ACES / AgX 色调映射)
 *
 * 每个环节都可以独立开关，让用户在 Engine Lab 里逐项试验。
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { AfterimagePass } from 'three/examples/jsm/postprocessing/AfterimagePass.js';
import type { EngineProfile } from './profile';
import {
  createVolumetricCloudPass,
  applyCloudProfile,
} from '@/lib/clouds/volumetric-cloud-pass';

/** 自定义色温 + 色调 + 调色 shader pass */
const ColorGradingShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uContrast: { value: 1.0 },
    uSaturation: { value: 1.0 },
    uTemperature: { value: 0.0 },  // -100 .. 100
    uTint: { value: 0.0 },         // -100 .. 100
    uLift: { value: 0.0 },
    uHighlights: { value: 1.0 },
    uExposure: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uTemperature;
    uniform float uTint;
    uniform float uLift;
    uniform float uHighlights;
    uniform float uExposure;

    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb;

      // 曝光
      col *= uExposure;

      // 色温：暖 = 加红减蓝，冷 = 加蓝减红
      float temp = uTemperature / 100.0;
      col.r += temp * 0.06;
      col.b -= temp * 0.06;

      // 色调：品 = 加红减绿，绿 = 加绿减红
      float tint = uTint / 100.0;
      col.r += tint * 0.05;
      col.g -= tint * 0.05;

      // 暗部抬升 (lift)
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col += uLift * (1.0 - lum);

      // 高光压制
      col *= mix(1.0, smoothstep(0.7, 1.0, lum), 1.0 - uHighlights);
      col += (lum - 0.7) * (1.0 - uHighlights) * 0.3;

      // 对比度
      col = (col - 0.5) * uContrast + 0.5;

      // 饱和度
      float gray = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(gray), col, uSaturation);

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a);
    }
  `,
};

/** 体积雾 pass (高度衰减的指数雾) */
const VolumetricFogShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uFogColor: { value: new THREE.Color(0xb8c8d8) },
    uFogDensity: { value: 0.0015 },
    uHeightFalloff: { value: 0.0008 },
    uCameraPos: { value: new THREE.Vector3() },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform vec3 uFogColor;
    uniform float uFogDensity;
    uniform float uHeightFalloff;
    uniform vec3 uCameraPos;

    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      // 简单的高度雾：越靠近画面顶部 (= 越高的天空) 雾越淡
      float heightFactor = 1.0 - clamp(vUv.y, 0.0, 1.0) * uHeightFalloff * 100.0;
      heightFactor = clamp(heightFactor, 0.1, 1.0);
      float fogAmount = uFogDensity * heightFactor;
      // 把雾混入颜色
      vec3 col = mix(c.rgb, uFogColor, clamp(fogAmount, 0.0, 0.95));
      gl_FragColor = vec4(col, c.a);
    }
  `,
};

export interface PostProcessingOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
}

export class PostProcessingPipeline {
  composer: EffectComposer | null = null;
  private opts: PostProcessingOptions;
  private renderPass!: RenderPass;
  private bloomPass: UnrealBloomPass | null = null;
  private ssaoPass: SSAOPass | null = null;
  private gtaoPass: GTAOPass | null = null;
  private bokehPass: BokehPass | null = null;
  private motionBlurPass: AfterimagePass | null = null;
  private colorGradingPass: ShaderPass | null = null;
  private volumetricFogPass: ShaderPass | null = null;
  /** 体积云 pass — 光线步进式厚云层, 可开关 */
  cloudPass: ShaderPass | null = null;
  private outputPass: OutputPass | null = null;
  private smaaPass: SMAAPass | null = null;

  constructor(opts: PostProcessingOptions) {
    this.opts = opts;
  }

  applyProfile(p: EngineProfile) {
    this.dispose();
    const w = this.opts.renderer.domElement.width;
    const h = this.opts.renderer.domElement.height;
    const pr = this.opts.renderer.getPixelRatio();

    const composer = new EffectComposer(this.opts.renderer);
    composer.setPixelRatio(pr);
    composer.setSize(w, h);

    this.renderPass = new RenderPass(this.opts.scene, this.opts.camera);
    composer.addPass(this.renderPass);

    // ─── 体积云 (光线步进式) ─────────────────────
    // 放在 RenderPass 之后、AO/Bloom 之前，让云参与所有后续后处理
    // (Bloom 会让云边缘泛光、DOF 会让远处云模糊等)
    if (p.clouds.enabled) {
      this.cloudPass = createVolumetricCloudPass();
      applyCloudProfile(this.cloudPass, p.clouds);
      composer.addPass(this.cloudPass);
    }

    // ─── SSAO / GTAO ───────────────────────────
    if (p.ao.method === 'gtao') {
      try {
        this.gtaoPass = new GTAOPass(this.opts.scene, this.opts.camera, w, h);
        this.gtaoPass.output = GTAOPass.OUTPUT.Default;
        // GTAOPass 参数存在 gtaoMaterial.uniforms 里
        (this.gtaoPass as any).gtaoMaterial.uniforms.radius.value = p.ao.radius;
        (this.gtaoPass as any).blendIntensity = p.ao.intensity;
        composer.addPass(this.gtaoPass);
      } catch (e) {
        console.warn('[PostFX] GTAO init failed, falling back to SSAO:', e);
        this.gtaoPass = null;
      }
    }
    if (p.ao.method === 'ssao' || (p.ao.method === 'gtao' && !this.gtaoPass)) {
      try {
        this.ssaoPass = new SSAOPass(this.opts.scene, this.opts.camera, w, h);
        this.ssaoPass.kernelRadius = p.ao.radius;
        this.ssaoPass.minDistance = 0.001;
        this.ssaoPass.maxDistance = 0.1 * p.ao.distanceAttenuation;
        composer.addPass(this.ssaoPass);
      } catch (e) {
        console.warn('[PostFX] SSAO init failed:', e);
        this.ssaoPass = null;
      }
    }

    // ─── Bloom ─────────────────────────────────
    if (p.bloom.enabled) {
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(w, h),
        p.bloom.strength,
        p.bloom.radius,
        p.bloom.threshold,
      );
      (this.bloomPass as any).mipmapBlur = p.bloom.mipmapBlur;
      composer.addPass(this.bloomPass);
    }

    // ─── 景深 (DOF) ────────────────────────────
    if (p.dof.enabled) {
      try {
        this.bokehPass = new BokehPass(this.opts.scene, this.opts.camera, {
          focus: p.dof.focusDistance,
          aperture: p.dof.aperture,
          maxblur: 0.01,
        });
        composer.addPass(this.bokehPass);
      } catch (e) {
        console.warn('[PostFX] BokehPass init failed:', e);
        this.bokehPass = null;
      }
    }

    // ─── 运动模糊 (Afterimage 近似) ────────────
    if (p.motionBlur.enabled) {
      this.motionBlurPass = new AfterimagePass(p.motionBlur.strength * 0.6);
      composer.addPass(this.motionBlurPass);
    }

    // ─── 体积雾 (后处理版，加在最终输出前) ─────
    if (p.volumetric.enabled) {
      this.volumetricFogPass = new ShaderPass(VolumetricFogShader);
      (this.volumetricFogPass.uniforms.uFogColor.value as THREE.Color).set(p.volumetric.color);
      this.volumetricFogPass.uniforms.uFogDensity.value = p.volumetric.density;
      this.volumetricFogPass.uniforms.uHeightFalloff.value = p.volumetric.heightFalloff;
      composer.addPass(this.volumetricFogPass);
    }

    // ─── 调色 ──────────────────────────────────
    this.colorGradingPass = new ShaderPass(ColorGradingShader);
    this.colorGradingPass.uniforms.uContrast.value = p.colorGrading.contrast;
    this.colorGradingPass.uniforms.uSaturation.value = p.colorGrading.saturation;
    this.colorGradingPass.uniforms.uTemperature.value = p.colorGrading.temperature;
    this.colorGradingPass.uniforms.uTint.value = p.colorGrading.tint;
    this.colorGradingPass.uniforms.uLift.value = p.colorGrading.lift;
    this.colorGradingPass.uniforms.uHighlights.value = p.colorGrading.highlights;
    this.colorGradingPass.uniforms.uExposure.value = p.toneMapping.exposure;
    composer.addPass(this.colorGradingPass);

    // ─── SMAA 抗锯齿 ───────────────────────────
    if (p.antialiasing === 'smaa') {
      this.smaaPass = new SMAAPass();
      composer.addPass(this.smaaPass);
    }

    // ─── Tone Mapping + 输出 ───────────────────
    // EffectComposer 默认用 Three.js 的 tone mapping，所以
    // 我们在 renderer 上设置 mode + exposure
    this.setToneMapping(p.toneMapping.mode, p.toneMapping.exposure);

    this.outputPass = new OutputPass();
    composer.addPass(this.outputPass);

    this.composer = composer;
  }

  setToneMapping(mode: EngineProfile['toneMapping']['mode'], exposure: number) {
    const r = this.opts.renderer;
    r.toneMappingExposure = exposure;
    switch (mode) {
      case 'ACES':     r.toneMapping = THREE.ACESFilmicToneMapping; break;
      case 'AgX':      r.toneMapping = THREE.AgXToneMapping; break;
      case 'Reinhard': r.toneMapping = THREE.ReinhardToneMapping; break;
      case 'Filmic':   r.toneMapping = THREE.CineonToneMapping; break;
      case 'None':     r.toneMapping = THREE.NoToneMapping; break;
    }
  }

  setSize(w: number, h: number) {
    if (!this.composer) return;
    this.composer.setSize(w, h);
    this.composer.setPixelRatio(this.opts.renderer.getPixelRatio());
  }

  render(deltaTime: number = 1 / 60) {
    if (this.composer) {
      this.composer.render(deltaTime);
    } else {
      this.opts.renderer.render(this.opts.scene, this.opts.camera);
    }
  }

  dispose() {
    if (this.composer) {
      this.composer.dispose();
      this.composer = null;
    }
    this.bloomPass = null;
    this.ssaoPass = null;
    this.gtaoPass = null;
    this.bokehPass = null;
    this.motionBlurPass = null;
    this.colorGradingPass = null;
    this.volumetricFogPass = null;
    this.cloudPass = null;
    this.outputPass = null;
    this.smaaPass = null;
  }
}
