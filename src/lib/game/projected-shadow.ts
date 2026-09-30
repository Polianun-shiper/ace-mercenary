// === 投影映射阴影纹理(贴花式, 非 CSM) per user request ==============================
//
// 用户: "在机体自阴影选项上加上投影映射阴影纹理选项(不是 csm): 在游戏中, 这张阴影纹理像
//        '贴花'一样, 通过投影矩阵映射到飞机自身的模型表面。给我做这个并顺便适配 pbr 系统"。
//
// 与 CSM 的区别(为什么要单独做一个):
//   · CSM 是"级联阴影贴图 + three 的 shadowMap 机制": 一张/多张深度图按视锥切成若干级联,
//     由 three 自己在 `<shadowmap_pars_fragment>`/`getShadow()` 里采样, 阴影**作用于所有**
//     `receiveShadow` 的物体, 而且它改的是 `directLight.color` 之前的 `shadow` 项。
//   · 本模块是**单张投影贴图 + 手动投影坐标**: 只有一台正交相机(轴 = 太阳方向), 只把
//     "要投影的目标"(这里是玩家机体)渲进深度图; 片元里用**光空间的投影矩阵**算出 uv,
//     采样一次深度图判断"这一点有没有被自己的其它部位挡住"。结果就像把一张阴影图**贴**到
//     机体表面(贴花), 适合"只想让机体自己投自己、且不想开 CSM 那套"的场合。
//
// PBR 适配(关键):
//   阴影只应该压**太阳直射项**, 不能动环境光/IBL —— 否则金属度高的机体背光面会被压成死黑,
//   天光(envMap)本该给的轮廓光也没了。所以注入点是 `lights_fragment_begin` 之后, 把
//   `irradiance`(直接光累计)整体乘一个 `uPSxShadow` 系数(fail-open: 贴图外/更近 = 1.0 不压),
//   而 `radiance`(IBL) 与 ambient 保持不动 ⇒ 与 PBR 管线天然兼容。
//
// 实现要点:
//   · 阴影相机: 正交, 覆盖目标周围 ±half 的立方体(缺省 ±30 单位), 沿 -sunDir 看向目标中心。
//   · 深度图: 把目标 group 渲进一张带 DepthTexture 的 RT(只渲目标, 不渲全场, 便宜且不会
//     被远处的山/云干扰 —— 这正是"贴花"的语义)。
//   · 采样: uv = 投影矩阵 * 世界坐标; 超出 [0,1] 或 z 出界一律判为"亮"(1.0)。
import * as THREE from 'three';

export interface ProjectedShadowParams {
  /** 正交相机半宽(世界单位) —— 覆盖"机体 + 一小圈", 太大会糊 */
  half: number;
  /** 影深图分辨率 */
  size: number;
  /** 深度比较偏置(避免自阴影痤疮); 单位 = 归一化深度 */
  bias: number;
  /** 阴影强度(0..1): 1 = 直接光被完全挡掉 */
  strength: number;
  /** 软边半径(纹素): 0 = 单点采样(硬边, 会有锯齿), 1~2 = 轻微半影 */
  soft: number;
  /** 深度过渡宽度(**世界单位**): 单次比较的柔化宽度(接触柔化), 默认 0.12m */
  penumbra: number;
  /** 间接光(环境/IBL)被遮挡的份额 0..1: 0 = 只压直接光, 0.5 = 全遮处天光也少一半 */
  ambient: number;
  /**
   * 自阴影处的"直接光下限"(0..1)。
   * 用户: 阳光角度不对或被阴影遮住时要用"背光计算"防止过黑(天光倒是没问题)——
   * 也就是别把那部分直接光压到 0: 真机在阴影里仍有多次散射/背光(机翼挡掉的阳光会从机身、
   * 云层再反回来)。这里用下限做这个"多次散射近似": psxK = mix(floor, 1, k)。
   * 0 = 全黑(旧行为), 0.49 = 当前默认(接近一半直接光保留), 0.5+ = 只剩很淡的阴影。
   */
  floor: number;
}

export const PROJECTED_SHADOW_DEFAULTS: ProjectedShadowParams = {
  half: 30,
  // === 1024 -> 2048 (per user request: 自阴影边缘有锯齿, 提一点分辨率) =============
  // 覆盖 ±30 单位 ⇒ 2048² 时 1 纹素 ≈ 2.9cm(1024 时 5.9cm)。这张图每帧只渲玩家机体
  // (不是全场), 所以翻倍的开销很小; 采样器占用也不变(还是 1 张)。
  size: 2048,
  bias: 0.0025,
  // === 0.85 -> 1.0 (per user report: 阴影不够明显) ===
  strength: 1.0,
  // 软边半径(纹素): 3 纹素 ≈ 8.8cm 半影 —— "稍微涂抹"一档, 台阶没了但阴影依然清晰。
  // 实测(2048², 覆盖 ±30): 过渡带像素 488 -> 671(soft 4) -> 869(soft 8), 深阴影区保持 ~220
  // (只把边界摊开、没有把阴影吃掉)。0 = 回到单点采样的硬边(想自己比就敲 shadowtex soft 0)。
  // 0 = 回到单点采样的硬边(想自己对比就把 `shadowtex soft 0` 敲一下)。
  soft: 3.0,
  // 深度过渡宽度(世界单位): 0.12m 的接触柔化 —— 让单次比较也连续, 是分阶的第二道保险。
  penumbra: 0.12,
  // 间接光遮挡份额: 0.5 让阴影在环境光占比高的场景里也看得清, 但不把机体压死黑。
  // per user request(2026-09-24 "机体自阴影太淡, 要很明显") 0.5 -> **0.75**:
  // 高金属 / 高 IBL 的机体上只压直接光几乎看不出阴影, 间接光跟着挡才"实"。
  // 现场调: 控制台 `shadowtex ambient <0..1>`(0 = 只压直接光, 会偏淡; 1 = 天光也全挡)。
  ambient: 0.75,
  // === 背光 (per user request: 第一阶段 0.22 -> 0.49) ==========================
  // per user request(2026-09-24 "不仔细看根本看不出来") 0.49 -> **0.12**:
  // 着色器结尾是 `mix(max(floor, 1-strength), 1, k)` ⇒ **floor 才是"全遮处保留多少直接光"**。
  // 0.49 等于只挡掉一半直接光(看着像没阴影); 0.12 让全遮处只剩 12% ⇒ 阴影立刻清楚。
  // 仍不为 0(不做死黑), 且地面/接缝另有 PCSS 接触阴影兜着。太狠就 `shadowtex floor 0.3`。
  floor: 0.12,
};

/** 注入用的 uniform 集合(所有被注入的材质**共享同一份对象**, 每帧只写一次) */
export interface ProjectedShadowUniforms {
  uPSxMap: { value: THREE.Texture | null };
  uPSxMatrix: { value: THREE.Matrix4 };
  uPSxBias: { value: number };
  uPSxStrength: { value: number };
  /** 全遮处保留的直接光比例(0..1) */
  uPSxFloor: { value: number };
  uPSxOn: { value: number };
  /** 1/size —— 软边抽样的步长 */
  uPSxTexel: { value: THREE.Vector2 };
  /** 软边半径(纹素) */
  uPSxSoft: { value: number };
  /** 深度过渡宽度(归一化) */
  uPSxDepthSoft: { value: number };
  /** 间接光遮挡份额 0..1 */
  uPSxAmbient: { value: number };
  /** 太阳方向(**视空间**, 单位向量) —— 用来判断这一面是不是"朝太阳" */
  uPSxSunView: { value: THREE.Vector3 };
}

export function makeProjectedShadowUniforms(): ProjectedShadowUniforms {
  return {
    uPSxMap: { value: null },
    uPSxMatrix: { value: new THREE.Matrix4() },
    uPSxBias: { value: PROJECTED_SHADOW_DEFAULTS.bias },
    uPSxStrength: { value: PROJECTED_SHADOW_DEFAULTS.strength },
    uPSxFloor: { value: PROJECTED_SHADOW_DEFAULTS.floor },
    uPSxOn: { value: 0 },
    uPSxTexel: { value: new THREE.Vector2(1 / PROJECTED_SHADOW_DEFAULTS.size, 1 / PROJECTED_SHADOW_DEFAULTS.size) },
    uPSxSoft: { value: PROJECTED_SHADOW_DEFAULTS.soft },
    uPSxDepthSoft: { value: PROJECTED_SHADOW_DEFAULTS.penumbra / 179.5 },
    uPSxAmbient: { value: PROJECTED_SHADOW_DEFAULTS.ambient },
    uPSxSunView: { value: new THREE.Vector3(0, 1, 0) },
  };
}

export class ProjectedShadow {
  readonly uniforms: ProjectedShadowUniforms = makeProjectedShadowUniforms();
  private renderer: THREE.WebGLRenderer;
  private cam: THREE.OrthographicCamera;
  private rt: THREE.WebGLRenderTarget;
  private target: THREE.Object3D | null = null;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private biasMat = new THREE.Matrix4();
  /** 渲深度图时临时顶替 uPSxMap 的 1x1 哑贴图(值 1.0 = 亮), 用来断开自采样反馈回路 */
  private dummyTex: THREE.DataTexture;
  params: ProjectedShadowParams;

  constructor(renderer: THREE.WebGLRenderer, params: ProjectedShadowParams = PROJECTED_SHADOW_DEFAULTS) {
    this.renderer = renderer;
    this.params = { ...params };
    const s = this.params.half;
    this.cam = new THREE.OrthographicCamera(-s, s, s, -s, 0.5, s * 6);
    this.cam.matrixAutoUpdate = true;
    this.rt = this.makeRT(this.params.size);
    this.uniforms.uPSxMap.value = this.rt.depthTexture;
    // === 断反馈回路用的 1x1 哑贴图 (值=1.0 ⇒ 采样到也是亮) ===
    this.dummyTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this.dummyTex.needsUpdate = true;
    // 偏置矩阵: [-1,1] → [0,1](把裁剪空间坐标映射成贴图 uv)
    this.biasMat.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  }

  /** 每帧指定"要投影的目标"(玩家机体 group)与太阳方向 */
  setTarget(obj: THREE.Object3D | null) { this.target = obj; }

  setParams(p: Partial<ProjectedShadowParams>) {
    const prevSize = this.params.size;
    Object.assign(this.params, p);
    const s = this.params.half;
    this.cam.left = -s; this.cam.right = s; this.cam.top = s; this.cam.bottom = -s;
    this.cam.far = s * 6;
    this.cam.updateProjectionMatrix();
    this.uniforms.uPSxBias.value = this.params.bias;
    this.uniforms.uPSxStrength.value = this.params.strength;
    this.uniforms.uPSxSoft.value = this.params.soft;
    this.uniforms.uPSxAmbient.value = this.params.ambient;
    // [!] §327 补: uPSxFloor 以前**从来没被写过** —— setParams 写了 bias/strength/soft/ambient 却漏了它,
    //   于是 params.floor 只是个数, 着色器永远用初值 0.12 ⇒ 控制台  是**空操作**,
    //   我们的 psx>1 那一段"继续压暗"也就压不动。这类"参数存了但没进 uniform"的坑本仓库出现过多次
    //   (size 重建 RT 那次、minstep 那次), 一律在 setParams 里补齐。
    this.uniforms.uPSxFloor.value = this.params.floor;
    // === size 必须真的重建 RT (per fix: 控制台 `shadowtex size` 一直是空操作) ==========
    // 旧实现只把 params.size 记下来, 没重建 render target ⇒ 敲 `shadowtex size 2048`
    // 返回"分辨率 -> 2048"却什么都没变(和压缩脚本那条"改了参数却空转"是同一类坑)。
    if (p.size !== undefined && p.size !== prevSize) {
      this.rt.dispose();
      this.rt = this.makeRT(this.params.size);
      this.uniforms.uPSxMap.value = this.rt.depthTexture;
    }
    // 深度过渡宽度: params 用世界单位(好理解), uniform 要归一化深度。
    // 正交相机深度是线性的 ⇒ 归一化 = 世界宽度 / (far - near)。
    const depthRange = Math.max(1e-6, this.cam.far - this.cam.near);
    this.uniforms.uPSxDepthSoft.value = this.params.penumbra / depthRange;
    const texel = 1 / this.params.size;
    (this.uniforms.uPSxTexel.value as THREE.Vector2).set(texel, texel);
  }

  /** 建深度图 RT(带 DepthTexture)。size 变化时要重建, 所以单独抽出来。 */
  private makeRT(size: number): THREE.WebGLRenderTarget {
    const rt = new THREE.WebGLRenderTarget(size, size, {
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: new THREE.DepthTexture(size, size),
    });
    rt.depthTexture!.format = THREE.DepthFormat;
    rt.depthTexture!.type = THREE.UnsignedIntType;
    rt.depthTexture!.minFilter = THREE.NearestFilter;
    rt.depthTexture!.magFilter = THREE.NearestFilter;
    return rt;
  }

  /** 每帧调用: 从太阳方向把目标渲进深度图, 并更新投影矩阵 uniform */
  update(sunDir: THREE.Vector3, enabled: boolean) {
    this.uniforms.uPSxOn.value = enabled && !!this.target ? 1 : 0;
    if (!enabled || !this.target) return;
    // 目标中心(机体位置)
    this.target.getWorldPosition(this.tmp);
    // 阴影相机沿太阳方向后退(太阳在 +sunDir 侧), 看向目标
    this.cam.position.copy(this.tmp).addScaledVector(sunDir, this.params.half * 3);
    this.tmp2.copy(this.tmp);
    this.cam.lookAt(this.tmp2);
    this.cam.updateMatrixWorld(true);
    // === 渲染深度(只渲目标子树) =============================================
    // 注意: 用 renderer.render(目标, 阴影相机) 只走目标这一棵子树 ⇒ 便宜, 且不会被
    // 山/云/其它单位干扰(贴花语义: 只关心"机体自己挡自己")。
    // ⚠⚠ 但**必须**先切断"自采样": 被注入的材质片元里会采样 uPSxMap, 而那张贴图
    //     正是本帧的深度附件 ⇒ WebGL 判定为**反馈回路**(同一张贴图既当附件又当采样源),
    //     该次 draw 直接丢弃并报 INVALID_OPERATION。后果是深度图永远是清空值,
    //     片元里 psxShadow() 恒返回 1.0(判"亮") ⇒ **机体自阴影完全不存在**,
    //     只剩材质自身的 N·L 着色 —— 这正是"关卡里机体不投射阴影"的根因。
    //     实证: 每次 update 后 gl.getError() = 0x502; 贴花开/关两帧逐像素差 max 3/255。
    //     修法: 渲之前 uPSxOn 归 0(着色器开头 `if (uPSxOn < 0.5) return 1.0;` 直接返回,
    //     不采样), 并把 uPSxMap 换到 1x1 哑贴图(值 1.0 = 判定为亮, 万一编译器没把采样
    //     判成死代码也不会形成回路), 渲完原样恢复。
    const savedOn = this.uniforms.uPSxOn.value;
    const savedMap = this.uniforms.uPSxMap.value;
    this.uniforms.uPSxOn.value = 0;
    this.uniforms.uPSxMap.value = this.dummyTex;
    const prevTarget = this.renderer.getRenderTarget();
    const prevAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = true;
    this.renderer.setRenderTarget(this.rt);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.target, this.cam);
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.autoClear = prevAutoClear;
    this.uniforms.uPSxMap.value = savedMap;
    this.uniforms.uPSxOn.value = savedOn;
    // 投影矩阵 = 偏置 × 投影 × 视图
    this.uniforms.uPSxMatrix.value
      .copy(this.biasMat)
      .multiply(this.cam.projectionMatrix)
      .multiply(this.cam.matrixWorldInverse);
  }

  dispose() {
    this.rt.dispose();
    this.dummyTex.dispose();
    this.uniforms.uPSxMap.value = null;
  }
}

/**
 * 把一个材质接上投影阴影(PBR 安全: 只压直接光 irradiance)。
 * 可对 MeshStandardMaterial 反复调用(同材质只注入一次)。
 */
export function injectProjectedShadow(mat: THREE.Material, u: ProjectedShadowUniforms): THREE.Material {
  const flags = mat.userData as { _psxInjected?: boolean };
  if (flags._psxInjected) return mat;
  flags._psxInjected = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (typeof prev === 'function') prev.call(mat, shader, renderer);
    Object.assign(shader.uniforms, u);
    // 顶点: 传世界坐标(投影采样要世界空间)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPSxWPos;')
      // (per fix: worldpos_vertex 是条件编译的, 没 envMap/shadowmap 的材质里不编译)
      .replace('#include <begin_vertex>', [
        '#include <begin_vertex>',
        'vPSxWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      ].join('\n'));
    // 片元: 投影采样 → 只乘直接光
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', [
        '#include <common>',
        'varying vec3 vPSxWPos;',
        'uniform sampler2D uPSxMap;',
        'uniform mat4 uPSxMatrix;',
        'uniform float uPSxBias;',
        'uniform float uPSxStrength;',
        'uniform float uPSxOn;',
        'uniform vec2 uPSxTexel;',   // 1/size: 软边抽样的步长
        'uniform float uPSxSoft;',   // 软边半径(纹素): 0 = 单点采样(硬边)
        'uniform float uPSxDepthSoft;', // 深度过渡宽度(归一化): 让单次比较也连续
        // ⚠ 这一行曾经漏了 ⇒ 片元里引用了未声明的 uniform ⇒ **整个注入材质编译失败**
        // ⇒ 机体自阴影彻底消失(而且不报"阴影没生效", 只报一条 shader error, 很容易漏看)。
        // 教训: 注入的 GLSL 里**用到几个 uniform 就必须声明几个**, 且改完要看控制台。
        'uniform float uPSxAmbient;',   // 间接光(天光/IBL)被遮挡的份额
        'uniform float uPSxFloor;',     // 全遮处保留的直接光(多次散射近似, 防过黑)
        'uniform vec3 uPSxSunView;',    // 太阳方向(视空间) —— 判断这一面朝不朝太阳
        'float psxTap(float z, vec2 uv) {',
        '  // 单次抽样也**不是二值**: 把"更近/更远"换成一段深度过渡(接触柔化)。',
        '  return clamp(0.5 + (texture2D(uPSxMap, uv).r - z) / max(uPSxDepthSoft, 1e-7), 0.0, 1.0);',
        '}',
        'float psxShadow(vec3 p) {',
        '  if (uPSxOn < 0.5) return 1.0;',
        '  vec4 sc = uPSxMatrix * vec4(p, 1.0);',
        '  vec3 pc = sc.xyz / max(sc.w, 1e-5);',
        '  // 贴图外一律判"亮"(fail-open, 免得边缘出现硬边黑块)',
        '  if (pc.x < 0.0 || pc.x > 1.0 || pc.y < 0.0 || pc.y > 1.0 || pc.z > 1.0) return 1.0;',
        '  float z = pc.z - uPSxBias;',
        '  float k = psxTap(z, pc.xy);',
        '  // === 软边: 8 方向抽样 + **每像素随机旋转** ==============================',
        '  //   上一版是 5 个固定方向取平均 ⇒ 半影只有 6 级离散值(0/5..5/5), 用户一眼看出',
        '  //   "软阴影有明显的分阶"。现在: ① 每个抽样本身连续(psxTap);',
        '  //   ② 8 方向 + 按屏幕坐标 hash 的随机旋转 ⇒ 残余量化被打散成高频噪声,',
        '  //   视觉上是平滑半影而不是同心阶梯。',
        '  if (uPSxSoft > 0.0) {',
        '    vec2 o = uPSxTexel * uPSxSoft;',
        '    float ang = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;',
        '    float ca = cos(ang), sa = sin(ang);',
        '    float s = k;',
        '    for (int i = 0; i < 8; i++) {',
        '      float a2 = 0.7853981634 * float(i);',
        '      vec2 d = vec2(cos(a2), sin(a2)) * o;',
        '      d = vec2(d.x * ca - d.y * sa, d.x * sa + d.y * ca);',
        '      s += psxTap(z, pc.xy + d);',
        '    }',
        '    k = s / 9.0;',
        '  }',
        '  // 亮 = 1, 遮蔽 = 1 - strength',
        '  // 多次散射近似: 全遮处保留 uPSxFloor 的直接光(而不是压到 0), 半影平滑过渡。',
        '  return mix(max(uPSxFloor, 1.0 - uPSxStrength), 1.0, k);',
        '}',
      ].join('\n'))
      // === PBR 适配: 压**直接光**累计项 (+ 可选压一部分间接光) ==================
      // three 里环境/IBL 的贡献累加在 `reflectedLight.indirectDiffuse`, 平行光在
      // `directDiffuse / directSpecular`。注入点选在所有直接光累加完、`lights_fragment_end`
      // **之前**。
      // === 只压直接光不够明显 (per user report: "阴影不够明显") ====================
      // 只压直接光时, 环境/IBL 那部分一点不动 ⇒ 环境光占比高的场景里阴影几乎看不出来。
      // 物理上遮挡物也会挡掉一部分天光, 所以给间接光一个**部分**遮挡份额 `uPSxAmbient`
      // (默认 0.5): 全遮处间接光也少一半 ⇒ 阴影明显起来; 但不归零, 这样高金属机体
      // 背光面不会被压成死黑(这也是当初完全不动 IBL 的顾虑)。
      // === 间接光遮挡必须"只作用在朝太阳的那面" (per user: 背对太阳飞变成死黑) ======
      // 原因: 背光时整个可见面**本来就被自己挡住**(自阴影判据为"暗"), 于是
      //   indirectDiffuse 也被砍掉一半 ⇒ 只剩极少天光 ⇒ 几乎死黑。
      //   物理上"被自己挡住"确实该少一点天光, 但背光面收到的是**天空的漫射**,
      //   那部分跟太阳挡不挡没关系。所以按 N·sun 加权: 只有朝太阳的面才吃这项。
      //   效果: 迎光面阴影更实(明暗对比更清楚), 背光面保留完整天光充填(不再死黑)。
      .replace('#include <lights_fragment_end>', [
        'float psxK = psxShadow(vPSxWPos);',
        'reflectedLight.directDiffuse *= psxK;',
        'reflectedLight.directSpecular *= psxK;',
        'float psxSunFace = smoothstep(-0.05, 0.35, dot(normalize(vNormal), uPSxSunView));',
        'reflectedLight.indirectDiffuse *= mix(1.0, psxK, uPSxAmbient * psxSunFace);',
        '#include <lights_fragment_end>',
      ].join('\n'));
    // === 注入自检 (per 教训: 注入失败是**静默**的) ================================
    // 两类沉默失败都踩过:
    //   ① 注入点字符串在别的 three 版本里不存在 ⇒ replace 什么都不做, 材质照常编译、
    //      只是完全没有阴影(看不出来);
    //   ② 片元里引用了未声明的 uniform(如 uPSxAmbient) ⇒ 整个材质**编译失败**,
    //      机体自阴影彻底消失, 只在控制台留一条 shader error。
    // 这里把"该出现的东西出现了没有"逐个查一遍, 缺了就大声警告(带上材质名)。
    {
      const missing: string[] = [];
      if (!shader.vertexShader.includes('vPSxWPos = (modelMatrix')) missing.push('vertex 注入点(begin_vertex)');
      if (!shader.fragmentShader.includes('float psxShadow(')) missing.push('片元 psxShadow 定义(common)');
      if (!shader.fragmentShader.includes('directDiffuse *= psxK')) missing.push('片元 注入点(lights_fragment_end)');
      for (const uni of ['uPSxMap', 'uPSxMatrix', 'uPSxBias', 'uPSxStrength', 'uPSxOn', 'uPSxTexel', 'uPSxSoft', 'uPSxDepthSoft', 'uPSxAmbient']) {
        if (!shader.fragmentShader.includes(`uniform float ${uni}`) && !shader.fragmentShader.includes(`uniform vec2 ${uni}`) && !shader.fragmentShader.includes(`uniform sampler2D ${uni}`) && !shader.fragmentShader.includes(`uniform mat4 ${uni}`)) {
          missing.push('未声明的 uniform ' + uni);
        }
      }
      if (missing.length) {
        console.warn(`[shadow] 投影自阴影注入不完整(材质 ${mat.name || mat.uuid}): ${missing.join(' / ')}`
          + ' —— 阴影可能完全不生效, 请检查 three 版本或注入点字符串');
      }
    }
  };
  mat.needsUpdate = true;
  return mat;
}

/** 递归把一棵子树里的所有材质都接上投影阴影(跳过基础材质/透明件) */
export function injectProjectedShadowTree(root: THREE.Object3D, u: ProjectedShadowUniforms): number {
  const seen = new Set<THREE.Material>();
  let n = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      // 只给会走光照管线的材质注入(MeshStandardMaterial / MeshPhysicalMaterial)
      const t = (m as THREE.Material).type;
      if (t !== 'MeshStandardMaterial' && t !== 'MeshPhysicalMaterial') continue;
      injectProjectedShadow(m, u);
      n++;
    }
  });
  return n;
}
