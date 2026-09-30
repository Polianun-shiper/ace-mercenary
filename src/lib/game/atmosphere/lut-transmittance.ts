// === Transmittance LUT (256×64, HalfFloat RGBA) ===============================
//
// Hillaire 2020 的第一张 LUT: "从 (半径 r, 天顶角余弦 mu) 出发, 走到大气顶/地面还剩多少光"。
// 它只依赖**介质参数**(散射系数/密度廓线/行星半径), 与太阳角度、相机位置都无关 ⇒
// 只在参数变化时重烤一次 (engine 启动 / `atmo` 旋钮改参数时)。
//
// 参数化用 Bruneton 2017 的"按到大气顶的距离 d 均匀切"(uv.x = mu 轴, uv.y = r 轴):
// 它把一半的分辨率给了 d ∈ [(Rt-r), (rho+H)] 里的"掠射段" ⇒ 地平线附近 mu 的分辨率
// 远高于线性映射(h=0 时 uv.x∈[0.5,1] 覆盖 mu∈[0,0.092] ≈ 5.3°, 256 格里一半都在这段)。
// 天地线附近不准的话, 日出日落的红色带会出现台阶/硬边 —— 这条参数化就是为它选的。
//
// 打到地面的格子写 0(被行星挡住), 与 atmoSampleTransmittance 里的地平线判据一致。
import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import {
  ATMO_COMMON_GLSL,
  LUT_SIZES,
  type AtmosphereUniforms,
} from './params';

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const TRANS_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

${ATMO_COMMON_GLSL}

// 采样步数: 参考实现用 40(实时路径), 但这条路只在参数变化时跑一次, 用 128 保证
// 长掠射光线(875km)也准 —— 掠射光线的 altitude 随 t 上升得很慢(t²/2R), 均匀步长足够。
const int ATMO_TRANS_STEPS = 128;

void main() {
  float r, mu;
  atmoUvToRMu(vUv, r, mu);

  vec3 ro = vec3(0.0, r, 0.0);
  vec3 rd = vec3(sqrt(max(1.0 - mu * mu, 0.0)), mu, 0.0);

  bool hitGround; float tGround;
  float tEnd = atmoRayExit(ro, rd, hitGround, tGround);

  float step = tEnd / float(ATMO_TRANS_STEPS);
  vec3 od = vec3(0.0);
  for (int i = 0; i < ATMO_TRANS_STEPS; i++) {
    vec3 p = ro + rd * (step * (float(i) + 0.5));
    float h = max(length(p) - uAtmBottomRadius, 0.0);
    od += atmoExtinction(h) * step;
  }

  vec3 T = exp(-max(od, vec3(0.0)));
  if (hitGround) T = vec3(0.0);   // 地面挡住 ⇒ 该方向没有阳光直射
  gl_FragColor = vec4(T, 1.0);
}
`;

/** 所有 LUT 共用的"烤制画布"(全屏四边形 + 自己的正交相机, 由 FullScreenQuad 提供)。 */
export class LutBaker {
  private quad: FullScreenQuad;
  private placeholder: THREE.Material;
  /** 累计烤制次数 (atmo report 用) */
  bakes = 0;
  constructor() {
    this.placeholder = new THREE.MeshBasicMaterial();
    this.quad = new FullScreenQuad(this.placeholder);
  }
  /** 把 material 全屏画进 rt。只动 renderTarget, 其余渲染状态由调用方决定。 */
  render(renderer: THREE.WebGLRenderer, rt: THREE.WebGLRenderTarget, material: THREE.Material): void {
    const q = this.quad as unknown as { material: THREE.Material };
    q.material = material;
    renderer.setRenderTarget(rt);
    this.quad.render(renderer);
    this.bakes++;
  }
  dispose(): void {
    this.quad.dispose();
    this.placeholder.dispose();
  }
}

/** 建一张 LUT 用的 HalfFloat RT(线性过滤 + 边界钳制, 不生成 mip)。 */
export function createLutRT(w: number, h: number): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  return rt;
}

/**
 * 透过率 LUT。`invalidate()` 后下一次 ensure() 会重烤 —— engine 在
 * "介质参数/天气"变化时调用它; 每帧调用 ensure() 是零成本(内部有 dirty 标志)。
 */
export class TransmittanceLut {
  readonly rt: THREE.WebGLRenderTarget;
  private mat: THREE.ShaderMaterial;
  private dirty = true;
  private baker: LutBaker;
  /** 累计重烤次数 (atmo report 用) */
  bakes = 0;

  constructor(u: AtmosphereUniforms, baker: LutBaker) {
    const [w, h] = LUT_SIZES.transmittance;
    this.rt = createLutRT(w, h);
    this.baker = baker;
    this.mat = new THREE.ShaderMaterial({
      uniforms: u as unknown as Record<string, THREE.IUniform>,
      vertexShader: QUAD_VERT,
      fragmentShader: TRANS_FRAG,
      depthTest: false,
      depthWrite: false,
    });
  }

  get texture(): THREE.Texture { return this.rt.texture; }

  invalidate(): void { this.dirty = true; }

  /** 脏了才烤。返回本次是否真的烤了。 */
  ensure(renderer: THREE.WebGLRenderer): boolean {
    if (!this.dirty) return false;
    this.baker.render(renderer, this.rt, this.mat);
    this.dirty = false;
    this.bakes++;
    return true;
  }

  dispose(): void {
    this.rt.dispose();
    this.mat.dispose();
  }
}
