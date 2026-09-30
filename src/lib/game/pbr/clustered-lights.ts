// === 聚类光照 (Clustered Forward+ / 分簇前向光照) ================================
//
// 为什么需要它(这个项目的真实约束, 不是"理论上的上限"):
//   three 的 `WebGLPrograms.getProgramCacheKeyParameters()` 把 **numPointLights 写进了
//   program cache key** —— 场景里点光数量一变, 全场材质重新编译。实测单帧 **1.8~2.2 秒**。
//   于是项目里只能退化成"固定 6 盏常驻池 + 池满就不发光", 后燃器/导弹/爆炸的灯都被这个
//   池子卡着(见 engine.ts 的 FX_LIGHT_POOL / MISSILE_LIGHT_MAX)。
//
// 聚类的核心价值在这里就是**把灯数从 shader 编译键里彻底拿掉**:
//   · 灯列表由本模块持有(普通数据结构, **不是 THREE.Light**, 不进 scene)
//     ⇒ numPointLights 恒定 ⇒ 无论多少盏灯都不会触发重编译;
//   · 每帧在 CPU 侧把灯按视锥分簇(16×9×24), 每簇只记录落在其中的灯号;
//   · 片元里按自身视空间坐标算出所在簇, 只遍历**该簇**的灯 ⇒ 单像素成本与总灯数无关。
// 这与 three 的 WebGPU 版 `examples/jsm/lighting/ClusteredLighting.js` 同一套思路;
// 但那是 `renderer.lighting = ...` 的 WebGPU 专属 API, WebGL 侧没有现成实现, 所以这里自建。
//
// 与既有设施的关系(照抄本项目的两条纪律):
//   · 灯**不进 scene**、数量任意变 —— 与"常驻光池"的初衷一致, 只是把上限拿掉了;
//   · 着色器注入走 `onBeforeCompile` + `#include <lights_fragment_end>` 锚点, 并且
//     **只累加直接光**(directDiffuse/directSpecular), 不动环境光/IBL —— 与
//     projected-shadow.ts 的注入语义一致(PBR 安全: 金属背光面不会被压死黑)。
//
// 采样器预算: 只吃 **1 张** 贴图(簇→灯号索引表)。灯的位置/颜色走 uniform 数组(不是贴图),
// 因为地形材质长期贴着 MAX_TEXTURE_IMAGE_UNITS(16) 的红线(见 docs/blender-import-workflow.md)。
import * as THREE from 'three';

export interface ClusteredLightParams {
  /** 灯上限(超出直接丢弃; uniform 数组长度 = 这个值) */
  maxLights: number;
  /** 每簇最多几盏灯(片元的循环上限 = 这个值, 决定最坏像素成本) */
  maxPerCluster: number;
  /** 簇网格(x/y/z) */
  gridX: number;
  gridY: number;
  gridZ: number;
  /** 簇的深度切分范围(视空间米) —— 用对数切分, 近处细远处粗 */
  near: number;
  far: number;
}

export const CLUSTERED_LIGHT_DEFAULTS: ClusteredLightParams = {
  // 128 盏灯: 足以覆盖"所有导弹尾焰 + 所有后燃器 + 爆炸 + 未来要加的灯光",
  // 而 uniform 成本 = 128 × (vec4 + vec3) ≈ 224 个 vec4, 离 MAX_FRAGMENT_UNIFORM_VECTORS(1024) 还很远。
  maxLights: 128,
  // 每簇 16 盏: 片元最坏 16 次灯计算(4 次贴图取样 × 4 分量)。实测场景里同簇灯数远小于此。
  maxPerCluster: 16,
  gridX: 16,
  gridY: 9,
  gridZ: 24,
  near: 1,
  far: 12000,
};

/** 一盏灯的输入(世界空间)。 */
export interface ClusteredLightInput {
  position: THREE.Vector3;
  /** 线性 RGB(已乘强度) */
  color: THREE.Color;
  /** 影响半径(米); 用于分簇与平滑衰减 */
  range: number;
}

export interface ClusteredLightUniforms {
  uCTex: { value: THREE.Texture | null };
  uCGrid: { value: THREE.Vector3 };
  /** x = near, y = far, z = 每簇的取样组数(ceil(maxPerCluster/4)), w = maxLights */
  uCParams: { value: THREE.Vector4 };
  /** 投影矩阵对角项(P00, P11) —— 用来把视空间坐标变成 NDC */
  uCP: { value: THREE.Vector2 };
  uCCount: { value: number };
  uCOn: { value: number };
  uCLightPos: { value: THREE.Vector4[] };
  uCLightColor: { value: THREE.Vector3[] };
  [k: string]: { value: unknown };
}

export class ClusteredLights {
  readonly params: ClusteredLightParams;
  readonly uniforms: ClusteredLightUniforms;
  /** 已收集的灯(本帧) */
  private lights: ClusteredLightInput[] = [];
  /**
   * 灯对象的池(避免每帧 new)。**关键**: `addLight` 必须**复制**入参 ——
   * 调用方(engine.updateClusteredLights)是复用一个临时 Vector3/Color 逐盏 set 的,
   * 只存引用的话同一帧里所有灯都指向最后一个灯的位置/颜色 ⇒ N 盏灯塌缩成同一盏
   * (实测: 把灯放进 uniform 数组后 128 个 slot 全是同一个坐标)。
   */
  private lightPool: ClusteredLightInput[] = [];
  private clusterCount: number;
  /** 每簇的灯号(0 = 空, 实际存 index+1), 布局: cluster * maxPerCluster + slot */
  private clusterIdx: Uint8Array;
  /** 每簇的灯数 */
  private clusterN: Uint16Array;
  private texData: Uint8Array;
  private tex: THREE.DataTexture;
  private texW: number;
  private texH: number;
  private enabled = true;
  private injected = 0;

  constructor(params: ClusteredLightParams = CLUSTERED_LIGHT_DEFAULTS) {
    this.params = { ...params };
    this.clusterCount = this.params.gridX * this.params.gridY * this.params.gridZ;
    this.clusterIdx = new Uint8Array(this.clusterCount * this.params.maxPerCluster);
    this.clusterN = new Uint16Array(this.clusterCount);
    // 每簇 maxPerCluster/4 组、每组一个 RGBA 纹素 ⇒ 用字节贴图传灯号(上限 255 盏)
    const groups = Math.max(1, Math.ceil(this.params.maxPerCluster / 4));
    const texels = this.clusterCount * groups;
    this.texW = Math.min(2048, texels);
    this.texH = Math.ceil(texels / this.texW);
    this.texData = new Uint8Array(this.texW * this.texH * 4);
    this.tex = new THREE.DataTexture(this.texData, this.texW, this.texH, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.tex.minFilter = THREE.NearestFilter;
    this.tex.magFilter = THREE.NearestFilter;
    this.tex.wrapS = THREE.ClampToEdgeWrapping;
    this.tex.wrapT = THREE.ClampToEdgeWrapping;
    this.tex.needsUpdate = true;

    const emptyPos = new THREE.Vector4();
    const emptyCol = new THREE.Vector3();
    const pos: THREE.Vector4[] = [];
    const col: THREE.Vector3[] = [];
    for (let i = 0; i < this.params.maxLights; i++) { pos.push(emptyPos.clone()); col.push(emptyCol.clone()); }
    this.uniforms = {
      uCTex: { value: this.tex },
      uCGrid: { value: new THREE.Vector3(this.params.gridX, this.params.gridY, this.params.gridZ) },
      uCParams: { value: new THREE.Vector4(this.params.near, this.params.far, groups, this.params.maxLights) },
      uCP: { value: new THREE.Vector2(1, 1) },
      uCCount: { value: 0 },
      uCOn: { value: 0 },
      uCLightPos: { value: pos },
      uCLightColor: { value: col },
    };
  }

  setEnabled(on: boolean) { this.enabled = !!on; }
  isEnabled(): boolean { return this.enabled; }
  getInjectedMaterials(): number { return this.injected; }
  getLightCount(): number { return this.lights.length; }

  /** 每帧开头: 清空灯列表。 */
  beginFrame() { this.lights.length = 0; }

  /** 加一盏灯(超出 maxLights 直接忽略, 并返回 -1)。入参会被**复制**(见 lightPool 说明)。 */
  addLight(position: THREE.Vector3, color: THREE.Color, range: number): number {
    const i = this.lights.length;
    if (i >= this.params.maxLights) return -1;
    let slot = this.lightPool[i];
    if (!slot) {
      slot = { position: new THREE.Vector3(), color: new THREE.Color(), range: 1 };
      this.lightPool[i] = slot;
    }
    slot.position.copy(position);
    slot.color.copy(color);
    slot.range = Math.max(1, range);
    this.lights.push(slot);
    return i;
  }

  /**
   * 每帧调用一次(在渲染前): 把灯分到簇里, 更新 uniform 与索引贴图。
   * 只有视空间里真的落在视锥附近的灯才会被写入 —— 这也是"总灯数多但开销不涨"的关键。
   */
  build(camera: THREE.PerspectiveCamera) {
    const p = this.params;
    // 关掉时只把 uniform 置 0, 不做分簇(零开销)
    if (!this.enabled || this.lights.length === 0) {
      this.uniforms.uCOn.value = 0;
      this.uniforms.uCCount.value = 0;
      return;
    }
    const groups = Math.max(1, Math.ceil(p.maxPerCluster / 4));
    this.clusterN.fill(0);
    this.clusterIdx.fill(0);
    const invVP = camera.matrixWorldInverse;
    const cam = this._tmpA;
    const v = this._tmpB;
    const P00 = camera.projectionMatrix.elements[0];
    const P11 = camera.projectionMatrix.elements[5];
    (this.uniforms.uCP.value as THREE.Vector2).set(P00, P11);

    let written = 0;
    const lightPos: THREE.Vector4[] = this.uniforms.uCLightPos.value as THREE.Vector4[];
    const lightCol: THREE.Vector3[] = this.uniforms.uCLightColor.value as THREE.Vector3[];
    for (let li = 0; li < this.lights.length; li++) {
      const L = this.lights[li];
      // 世界 -> 视空间(相机原点, 看向 -z)
      v.copy(L.position).applyMatrix4(invVP);
      const depth = -v.z;
      if (depth <= p.near - L.range || depth >= p.far + L.range) {
        // 完全在视锥深度范围外(仍然写进 uniform, 免得灯号错位)
        lightPos[li].set(v.x, v.y, v.z, L.range);
        lightCol[li].set(L.color.r, L.color.g, L.color.b);
        continue;
      }
      lightPos[li].set(v.x, v.y, v.z, L.range);
      lightCol[li].set(L.color.r, L.color.g, L.color.b);
      // (per fix) 这里原先就 written++ —— 于是"有 128 盏灯"这个计数把**视锥外、
      // 一个簇都没落进**的灯也算上了: 实测 uCCount=128 而索引贴图全 0 字节,
      // 排查时据此误判"数据是好的、只是着色器没生效"。改成只数真的落进簇的灯。
      let landed = false;
      // --- 该灯球覆盖的簇范围 ---
      // x/y: 用灯球在近端面处的角半径把 NDC 包围盒放宽
      const dNear = Math.max(p.near, depth - L.range);
      const rNdcX = (L.range / Math.max(dNear, 1e-3)) * P00 * 0.5;
      const rNdcY = (L.range / Math.max(dNear, 1e-3)) * P11 * 0.5;
      const cx = (v.x * P00) / Math.max(depth, 1e-3) * 0.5 + 0.5;
      const cy = (v.y * P11) / Math.max(depth, 1e-3) * 0.5 + 0.5;
      const x0 = Math.max(0, Math.floor((cx - rNdcX) * p.gridX));
      const x1 = Math.min(p.gridX - 1, Math.floor((cx + rNdcX) * p.gridX));
      const y0 = Math.max(0, Math.floor((cy - rNdcY) * p.gridY));
      const y1 = Math.min(p.gridY - 1, Math.floor((cy + rNdcY) * p.gridY));
      const zt = (d: number) => Math.log(Math.max(d, p.near) / p.near) / Math.log(p.far / p.near);
      const z0 = Math.max(0, Math.floor(zt(depth - L.range) * p.gridZ));
      const z1 = Math.min(p.gridZ - 1, Math.floor(zt(depth + L.range) * p.gridZ));
      if (x1 < x0 || y1 < y0 || z1 < z0) continue;
      for (let cz = z0; cz <= z1; cz++) {
        for (let gy = y0; gy <= y1; gy++) {
          for (let gx = x0; gx <= x1; gx++) {
            const c = (cz * p.gridY + gy) * p.gridX + gx;
            const n = this.clusterN[c];
            if (n >= p.maxPerCluster) continue;
            this.clusterIdx[c * p.maxPerCluster + n] = li + 1;   // 0 = 空
            this.clusterN[c] = n + 1;
            landed = true;
          }
        }
      }
      if (landed) written++;
    }
    // --- 写索引贴图 ---
    this.texData.fill(0);
    for (let c = 0; c < this.clusterCount; c++) {
      const n = this.clusterN[c];
      if (!n) continue;
      for (let s = 0; s < n; s++) {
        const t = c * groups + (s >> 2);
        const comp = s & 3;
        if (t >= this.texW * this.texH) break;
        this.texData[t * 4 + comp] = this.clusterIdx[c * p.maxPerCluster + s];
      }
    }
    this.tex.needsUpdate = true;
    this.uniforms.uCOn.value = 1;
    this.uniforms.uCCount.value = written;
    void cam;
  }

  private _tmpA = new THREE.Vector3();
  private _tmpB = new THREE.Vector3();

  /** 注入一个材质(链式 onBeforeCompile, 与 projected-shadow 同一套约定 + 自检)。 */
  inject(mat: THREE.Material): boolean {
    const m = mat as THREE.MeshStandardMaterial & { isMeshStandardMaterial?: boolean };
    if (!m.isMeshStandardMaterial) return false;
    const flags = mat.userData as { _clusteredInjected?: boolean };
    if (flags._clusteredInjected) return false;
    flags._clusteredInjected = true;
    const u = this.uniforms;
    const maxLights = this.params.maxLights;
    // GLSL 里的循环上限必须是编译期常量 ⇒ 这里把参数直接拼进源码。
    const groups = Math.max(1, Math.ceil(this.params.maxPerCluster / 4));
    const maxPer = groups * 4;
    const decl = [
      'uniform sampler2D uCTex;',
      'uniform vec3 uCGrid;',
      'uniform vec4 uCParams;',
      'uniform vec2 uCP;',
      'uniform float uCCount;',
      'uniform float uCOn;',
      `uniform vec4 uCLightPos[${maxLights}];`,
      `uniform vec3 uCLightColor[${maxLights}];`,
      `vec4 clFetch4(int idx) {   // 取 cluster 的某一组 4 个灯号(0 = 空)`,
      `  vec2 uv = vec2((mod(float(idx), ${this.texW}.0) + 0.5) / ${this.texW}.0,`,
      `                (floor(float(idx) / ${this.texW}.0) + 0.5) / ${this.texH}.0);`,
      `  return texture2D(uCTex, uv) * 255.0;`,
      `}`,
      `float clComp(vec4 v, int k) {   // vec4 不能用变量下标, 只能 if 链`,
      `  if (k == 0) return v.x; if (k == 1) return v.y;`,
      `  if (k == 2) return v.z; return v.w;`,
      `}`,
      'void clAccumulate(vec3 viewPos, vec3 N, vec3 diffuseColor, inout vec3 outDiff) {',
      '  if (uCOn < 0.5 || uCCount < 0.5) return;',
      '  float depth = max(-viewPos.z, 1e-3);',
      '  vec2 ndc = vec2(viewPos.x * uCP.x, viewPos.y * uCP.y) / depth;',
      '  vec2 uv = ndc * 0.5 + 0.5;',
      '  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return;',
      '  ivec2 cell = ivec2(clamp(uv * uCGrid.xy, vec2(0.0), uCGrid.xy - 1.0));',
      '  float zt = log(depth / uCParams.x) / log(uCParams.y / uCParams.x);',
      '  int cz = int(clamp(floor(zt * uCGrid.z), 0.0, uCGrid.z - 1.0));',
      '  int cluster = (cz * int(uCGrid.y) + cell.y) * int(uCGrid.x) + cell.x;',
      `  int base = cluster * ${groups};`,
      `  for (int g = 0; g < ${groups}; g++) {`,
      `    vec4 ids = clFetch4(base + g);`,
      `    for (int k = 0; k < 4; k++) {`,
      `      float f = clComp(ids, k);`,
      `      int slot = int(f + 0.5) - 1;`,
      '      if (slot < 0) continue;',
      '      vec4 lp = uCLightPos[slot];',
      '      vec3 toL = lp.xyz - viewPos;',
      '      float d2 = max(dot(toL, toL), 1e-4);',
      '      float d = sqrt(d2);',
      '      if (d > lp.w) continue;',
      // UE4 式平滑衰减: 1/d² 再乘一个到 range 处归零的窗函数
      '      float win = clamp(1.0 - pow(d / lp.w, 4.0), 0.0, 1.0);',
      '      float att = win * win / d2;',
      '      vec3 Ld = toL / d;',
      '      float ndl = max(dot(N, Ld), 0.0);',
      '      if (ndl <= 0.0) continue;',
      '      vec3 irr = uCLightColor[slot] * att * ndl;',
      '      outDiff += irr * diffuseColor * RECIPROCAL_PI;',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, renderer) => {
      if (typeof prev === 'function') prev.call(mat, shader, renderer);
      Object.assign(shader.uniforms, u);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + decl)
        // 注入点与 projected-shadow 相同: 直接光已累加完、lights_fragment_end 之前。
        // vViewPosition 是 three 给的标准 varying(**注意它带负号**: 实际视空间位置 = -vViewPosition),
        // vNormal 是视空间法线 —— 两者正好是聚类所需。
        .replace('#include <lights_fragment_end>', [
          '{',
          '  vec3 clViewPos = -vViewPosition;',
          '  vec3 clN = normalize(vNormal);',
          '  clAccumulate(clViewPos, clN, diffuseColor.rgb, reflectedLight.directDiffuse);',
          '}',
          '#include <lights_fragment_end>',
        ].join('\n'));
      // === 注入自检 (per 教训: 注入静默失效过两次) ===
      const bad: string[] = [];
      if (!shader.fragmentShader.includes('void clAccumulate(')) bad.push('簇光照函数(common)');
      if (!shader.fragmentShader.includes('clAccumulate(clViewPos')) bad.push('注入点(lights_fragment_end)');
      if (!shader.fragmentShader.includes('uniform sampler2D uCTex;')) bad.push('uCTex 声明');
      if (bad.length) {
        console.warn(`[cluster] 聚类光照注入不完整(材质 ${mat.name || mat.uuid}): ${bad.join(' / ')}`);
      }
    };
    mat.needsUpdate = true;
    this.injected++;
    return true;
  }

  /** 递归注入一棵子树(跳过非 PBR 材质)。返回新注入的材质数。 */
  injectTree(root: THREE.Object3D): number {
    let n = 0;
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mm of mats) if (mm && this.inject(mm)) n++;
    });
    return n;
  }

  dispose() { this.tex.dispose(); }
}
