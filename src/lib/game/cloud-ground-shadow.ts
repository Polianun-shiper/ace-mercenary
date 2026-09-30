// === 地面云影: 把 takram 云的 BSM(Beer Shadow Map)投到地形/地面材质上 ================
//
// 为什么单独做一个模块: 这是**第二次**给 three 材质注入采样器(第一次是 projected-shadow.ts
// 的机体投影自阴影)。红线: 一个材质最多 16 个采样器 —— 地形材质本来就用掉十几个, 再加一个
// 就是 15/16。一旦注入让着色器**链接失败**, 地表会整片消失(历史上真的加爆过, 只剩 skirt)。
// 所以这里的规矩和 projected-shadow.ts 完全一致:
//   · `userData._cgsInjected` 幂等标志(同一材质只注入一次);
//   · 锚点用 three 的 `#include <...>`(不是硬编码 GLSL 片段);
//   · **写入后立刻自检**(注入点字符串 / 每个用到的 uniform 都声明了没有), 缺一条就大声 warn。
//
// === 为什么 GLSL 全部自己写一遍(不引 @takram/three-geospatial/shaders) ==============
// geospatial 的 `cascadedShadowMaps` 片段里会调 `viewZToOrthographicDepth(...)`, 那个函数
// **只在 three 的 `<packing>` 里有**, 而 `<packing>` 是否被包含取决于材质有没有开影子
// (meshphysical 自己的 frag 里没有 `#include <packing>`)。两种做法都危险:
//   · 直接引 chunk ⇒ 名字不在就整段编译失败;
//   · 自己再定义一份 `viewZToOrthographicDepth` ⇒ 如果 `<packing>` 也在(开影子时就在),
//     就是**函数重定义** ⇒ 同样编译失败。
// 所以这里把用到的三个函数(级联选择 / 光空间 uv / 射线求交)全部用 `cgs` 前缀**自己写一份**,
// 数学与库逐字对应(引用见各函数注释), 零外部依赖, 不可能与其它注入打架。
//
// 数据来源: 库的 `effect.shadowPass.outputBuffer`(DataArrayTexture, 每级联一层) +
// `effect.shadowMaps.cascades[i]`(光空间投影矩阵 + 视锥区间) + 层配置里的 shadowTopHeight。
//
// 物理: BSM 存的是"沿太阳方向到云层顶的光学深度"的压缩量
//    (r: frontDepth, g: meanExtinction, b: maxOpticalDepth, a: maxOpticalDepthTail),
//   库的 readShadowOpticalDepth = min(b + a, g * distanceToFront)。
//   地面取 T = exp(-opticalDepth) 就是"阳光穿过云层后还剩多少", 乘到直接光上即可。
import * as THREE from 'three';
import type { CloudsEffect } from '@takram/three-clouds';

/** 注入用的 uniform 集合(被注入的材质**共享同一份对象**, 引擎每帧只写一次) */
export interface CloudGroundShadowUniforms {
  uCGSBuf: { value: THREE.Texture | null };
  uCGSTexel: { value: THREE.Vector2 };
  uCGSIntervals: { value: THREE.Vector2[] };
  uCGSMatrices: { value: THREE.Matrix4[] };
  /** 阴影级联的 far(= 归一化深度的上限, 与库的 shadowFar 同一个量) */
  uCGSFar: { value: number };
  /** 相机近平面(库的 getFadedCascadeIndex 需要 cameraNear) */
  uCGSNear: { value: number };
  uCGSBottomRadius: { value: number };
  uCGSTopHeight: { value: number };
  uCGSSunDir: { value: THREE.Vector3 };
  uCGSAltCorrect: { value: THREE.Vector3 };
  uCGSOn: { value: number };
  /** 0 = 不压, 1 = 完全按物理(直接光乘 exp(-od)) */
  uCGSStrength: { value: number };
  /** 间接光(IBL)被云影影响的份额 0..1 —— 全影处的天光也该少一点 */
  uCGSAmbient: { value: number };
  /** PCF 半径(纹素) */
  uCGSSoft: { value: number };
}

export const CLOUD_GROUND_SHADOW_DEFAULTS = {
  strength: 1.0,
  ambient: 0.45,
  soft: 1.6,
};

export function makeCloudGroundShadowUniforms(): CloudGroundShadowUniforms {
  return {
    uCGSBuf: { value: null },
    uCGSTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
    uCGSIntervals: { value: [new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2()] },
    uCGSMatrices: { value: [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()] },
    uCGSFar: { value: 1 },
    uCGSNear: { value: 0.1 },
    uCGSBottomRadius: { value: 6360000 },
    uCGSTopHeight: { value: 0 },
    uCGSSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uCGSAltCorrect: { value: new THREE.Vector3() },
    uCGSOn: { value: 0 },
    uCGSStrength: { value: CLOUD_GROUND_SHADOW_DEFAULTS.strength },
    uCGSAmbient: { value: CLOUD_GROUND_SHADOW_DEFAULTS.ambient },
    uCGSSoft: { value: CLOUD_GROUND_SHADOW_DEFAULTS.soft },
  };
}

/**
 * 从库里把这一帧的 BSM 状态搬进我们的 uniform(每帧调一次, 很便宜)。
 * 返回 false = 数据不全(BSM 还没建 / 云没开) ⇒ 调用方应把 uCGSOn 归 0。
 * ⚠ 读的是**上一帧**的 BSM(库在 pass render 里才更新矩阵/缓冲), 对地面云影完全够用。
 */
export function feedCloudGroundShadow(
  u: CloudGroundShadowUniforms,
  effect: CloudsEffect | null | undefined,
  cameraNear = 0.1,
): boolean {
  if (!effect) { u.uCGSOn.value = 0; return false; }
  const eff = effect as unknown as {
    shadowPass?: { outputBuffer?: THREE.DataArrayTexture | null };
    shadowMaps?: {
      far?: number;
      cascades?: Array<{ matrix: THREE.Matrix4; interval: THREE.Vector2 }>;
    };
    cloudsPass?: { currentMaterial?: { uniforms?: Record<string, { value: unknown }> } };
  };
  const buf = eff.shadowPass?.outputBuffer ?? null;
  const cascades = eff.shadowMaps?.cascades;
  if (!buf || !cascades || !cascades.length) { u.uCGSOn.value = 0; return false; }

  const matU = eff.cloudsPass?.currentMaterial?.uniforms;
  const num = (k: string, d: number): number => {
    const v = matU?.[k]?.value;
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
  };
  const vec = (k: string): THREE.Vector3 | null => {
    const v = matU?.[k]?.value;
    return v instanceof THREE.Vector3 ? v : null;
  };

  u.uCGSBuf.value = buf;
  const n = Math.min(4, cascades.length);
  for (let i = 0; i < n; i++) {
    u.uCGSMatrices.value[i].copy(cascades[i].matrix);
    u.uCGSIntervals.value[i].copy(cascades[i].interval);
  }
  u.uCGSFar.value = eff.shadowMaps?.far ?? 1;
  u.uCGSNear.value = cameraNear;
  u.uCGSBottomRadius.value = num('bottomRadius', 6360000);
  u.uCGSTopHeight.value = num('shadowTopHeight', 0);
  const ac = vec('altitudeCorrection');
  if (ac) u.uCGSAltCorrect.value.copy(ac);
  // BSM 的分辨率(纹素步长)从贴图尺寸推
  const img = (buf as unknown as { image?: { width?: number; height?: number } }).image;
  const w = img?.width ?? 1024, h = img?.height ?? 1024;
  u.uCGSTexel.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
  u.uCGSOn.value = 1;
  return true;
}

/**
 * 把一个材质接上地面云影(只压直接光; 与 PBR 管线天然兼容)。
 * 幂等: 同一材质反复调用只注入一次。返回 true = 本次真的注入了。
 *
 * ⚠ 采样器红线: 这会**给材质加 1 个 sampler2DArray**。注入后必须实测 program 里
 *   采样器数 ≤ 16 且**链接成功**(`_shadow-probe` 会报); 一旦失败立刻回退(见 engine 的开关)。
 */
export function injectCloudGroundShadow(
  mat: THREE.Material,
  u: CloudGroundShadowUniforms,
  cascadeCount = 3,
): boolean {
  const flags = mat.userData as { _cgsInjected?: boolean };
  if (flags._cgsInjected) return false;
  flags._cgsInjected = true;
  const N = Math.max(1, Math.min(4, cascadeCount | 0));
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (typeof prev === 'function') prev.call(mat, shader, renderer);
    Object.assign(shader.uniforms, u);
    // 顶点: 传世界坐标
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCGSWPos;')
      .replace('#include <begin_vertex>', [
        '#include <begin_vertex>',
        'vCGSWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      ].join('\n'));
    // 片元: 自包含的采样片段 + 只压直接光
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', [
        '#include <common>',
        'varying vec3 vCGSWPos;',
        `#define SHADOW_CASCADE_COUNT ${N}`,
        'uniform sampler2DArray uCGSBuf;',
        'uniform vec2 uCGSTexel;',
        'uniform vec2 uCGSIntervals[SHADOW_CASCADE_COUNT];',
        'uniform mat4 uCGSMatrices[SHADOW_CASCADE_COUNT];',
        'uniform float uCGSFar;',
        'uniform float uCGSNear;',
        'uniform float uCGSBottomRadius;',
        'uniform float uCGSTopHeight;',
        'uniform vec3 uCGSSunDir;',
        'uniform vec3 uCGSAltCorrect;',
        'uniform float uCGSOn;',
        'uniform float uCGSStrength;',
        'uniform float uCGSAmbient;',
        'uniform float uCGSSoft;',
        // three 的 packing 片段里那个函数的等价实现(只在这里用, 用 cgs 前缀免得重定义)
        'float cgsViewZToOrthoDepth(const in float viewZ, const in float near, const in float far) {',
        '  return (viewZ + near) / (near - far);',
        '}',
        // 与库 getFadedCascadeIndex 逐字对应(唯一的改动是函数名与 viewZ 换算函数)
        'int cgsCascadeIndex(const vec3 worldPosition) {',
        '  vec4 viewPosition = viewMatrix * vec4(worldPosition, 1.0);',
        '  float depth = cgsViewZToOrthoDepth(viewPosition.z, uCGSNear, uCGSFar);',
        '  vec2 interval; float intervalCenter; float closestEdge; float margin;',
        '  int nextIndex = -1; int prevIndex = -1; float alpha = 0.0;',
        '  for (int i = 0; i < 4; ++i) {',
        '    if (i >= SHADOW_CASCADE_COUNT) break;',
        '    interval = uCGSIntervals[i];',
        '    intervalCenter = (interval.x + interval.y) * 0.5;',
        '    closestEdge = depth < intervalCenter ? interval.x : interval.y;',
        '    margin = max(closestEdge * closestEdge * 0.5, 1e-6);',
        '    interval += margin * vec2(-0.5, 0.5);',
        '    if (i < SHADOW_CASCADE_COUNT - 1) {',
        '      if (depth >= interval.x && depth < interval.y) {',
        '        prevIndex = nextIndex; nextIndex = i;',
        '        alpha = clamp(min(depth - interval.x, interval.y - depth) / margin, 0.0, 1.0);',
        '      }',
        '    } else if (depth >= interval.x) {',
        '      prevIndex = nextIndex; nextIndex = i;',
        '      alpha = clamp((depth - interval.x) / margin, 0.0, 1.0);',
        '    }',
        '  }',
        // 用固定的 0.5 代替逐像素抖动: 地面云影是柔和的, 不需要时间抖动
        '  return 0.5 <= alpha ? nextIndex : prevIndex;',
        '}',
        // 光空间 uv(与库的 getShadowUv 逐字一致)
        'vec2 cgsShadowUv(const vec3 worldPosition, const int cascadeIndex) {',
        '  vec4 clip = uCGSMatrices[cascadeIndex] * vec4(worldPosition, 1.0);',
        '  clip /= clip.w;',
        '  return clip.xy * 0.5 + 0.5;',
        '}',
        // 射线与球的第二交点(库 raySphereSecondIntersection 的等价实现)
        'float cgsRaySphereFar(const vec3 origin, const vec3 direction, const float radius) {',
        '  float b = 2.0 * dot(direction, origin);',
        '  float c = dot(origin, origin) - radius * radius;',
        '  float d = b * b - 4.0 * c;',
        '  return d < 0.0 ? -1.0 : (-b + sqrt(d)) * 0.5;',
        '}',
        // 读一个 texel 的光学深度(与库的 readShadowOpticalDepth 逐字一致)
        'float cgsRead(const vec2 uv, const float distanceToTop, const int cascadeIndex) {',
        '  vec4 s = texture(uCGSBuf, vec3(uv, float(cascadeIndex)));',
        '  float distanceToFront = max(0.0, distanceToTop - s.r);',
        '  return min(s.b + s.a, s.g * distanceToFront);',
        '}',
        // 云影透过率: 1 = 没云(亮), 0 = 全遮
        'float cgsTransmittance(const vec3 worldPosition) {',
        '  if (uCGSOn < 0.5) return 1.0;',
        '  vec3 rayPosition = vec3(worldPosition.x, worldPosition.y + uCGSBottomRadius, worldPosition.z);',
        '  rayPosition += uCGSAltCorrect;',
        '  float distanceToTop = cgsRaySphereFar(',
        '    rayPosition, uCGSSunDir, uCGSBottomRadius + uCGSTopHeight);',
        '  if (distanceToTop <= 0.0) return 1.0;',
        '  int cascadeIndex = cgsCascadeIndex(worldPosition);',
        '  if (cascadeIndex < 0) return 1.0;',
        '  vec2 uv = cgsShadowUv(worldPosition, cascadeIndex);',
        // 贴图外判"亮"(fail-open, 免得级联边缘出现硬边黑块)
        '  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 1.0;',
        '  if (uCGSSoft <= 0.0) return exp(-cgsRead(uv, distanceToTop, cascadeIndex));',
        // 4 抽样 PCF: 对角偏移, 半径可调(云影边缘本就该是软的)
        '  vec2 o = uCGSTexel * uCGSSoft;',
        '  float od = cgsRead(uv + vec2(o.x, o.y), distanceToTop, cascadeIndex)',
        '           + cgsRead(uv + vec2(-o.x, o.y), distanceToTop, cascadeIndex)',
        '           + cgsRead(uv + vec2(o.x, -o.y), distanceToTop, cascadeIndex)',
        '           + cgsRead(uv + vec2(-o.x, -o.y), distanceToTop, cascadeIndex);',
        '  return exp(-od * 0.25);',
        '}',
      ].join('\n'))
      // 只压**直接光**: 与 projected-shadow 同一个注入点(直接光累加完、结束之前)。
      // 间接光按 uCGSAmbient 部分遮挡: 云也确实挡掉一部分天光, 但不归零(否则地面死黑)。
      .replace('#include <lights_fragment_end>', [
        'float cgsT = cgsTransmittance(vCGSWPos);',
        'cgsT = mix(1.0, cgsT, uCGSStrength);',
        'reflectedLight.directDiffuse *= cgsT;',
        'reflectedLight.directSpecular *= cgsT;',
        'reflectedLight.indirectDiffuse *= mix(1.0, cgsT, uCGSAmbient);',
        '#include <lights_fragment_end>',
      ].join('\n'));
    // === 注入自检(注入失败是**静默**的, 必须自己查) ===
    {
      const missing: string[] = [];
      if (!shader.vertexShader.includes('vCGSWPos = (modelMatrix')) missing.push('vertex 注入点(begin_vertex)');
      if (!shader.fragmentShader.includes('float cgsTransmittance(')) missing.push('片元 cgsTransmittance 定义');
      if (!shader.fragmentShader.includes('reflectedLight.directDiffuse *= cgsT')) missing.push('片元 注入点(lights_fragment_end)');
      if (!/#define SHADOW_CASCADE_COUNT [0-9]/.test(shader.fragmentShader)) missing.push('SHADOW_CASCADE_COUNT define');
      for (const uni of ['uCGSBuf', 'uCGSTexel', 'uCGSIntervals', 'uCGSMatrices', 'uCGSFar', 'uCGSNear',
        'uCGSBottomRadius', 'uCGSTopHeight', 'uCGSSunDir', 'uCGSAltCorrect', 'uCGSOn',
        'uCGSStrength', 'uCGSAmbient', 'uCGSSoft']) {
        if (!shader.fragmentShader.includes(uni)) missing.push('未声明的 uniform ' + uni);
      }
      if (missing.length) {
        console.warn(`[cloudshadow] 地面云影注入不完整(材质 ${mat.name || mat.uuid}): ${missing.join(' / ')}`
          + ' —— 云的投影可能完全不生效, 请检查 three 版本或注入点字符串');
        // 注入不完整 ⇒ 立刻关掉(至少不参与渲染; 材质本身照常编译)
        u.uCGSOn.value = 0;
        flags._cgsInjected = false;
      } else {
        console.info(`[cloudshadow] 地面云影已注入材质 ${mat.name || mat.type}(级联 ${N}, +1 sampler)`);
      }
    }
  };
  mat.needsUpdate = true;
  return true;
}
