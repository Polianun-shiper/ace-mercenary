// === 植被 billboard / 交叉面片几何 + 材质注入 (per user request) =====================
//
// 用户: "高植被用 4 叉 alpha 贴片, 低矮植被用 billboard 的树木贴图素材"。
//
// 两套几何:
//   · **4 叉交叉面片**(buildCrossPlaneGeometry 已有): 4 片绕 Y 每 45° 交叉 —— 高植被
//     (针叶/阔叶)用它, 从任何角度看都有体积感, 这是"树"该有的样子。
//   · **billboard**(本文件新增): 单片, 永远面向相机 —— 低矮植被(草/灌木)用它。
//
// 关键设计: billboard **在顶点着色器里转**, 不在 CPU 里转。
//   低矮植被是数量最大的一档(几万株), 如果每帧用 CPU 把每个实例矩阵改成朝向相机,
//   每帧要写几万个矩阵 + 上传显存 ⇒ 直接吃掉帧预算,"大量实例化"就无从谈起。
//   做法: 实例矩阵的**平移与缩放**照旧(位置/大小), 但把它的**旋转丢掉**, 在视图空间里
//   用一个固定朝向的四边形去贴相机:
//
//     vec4 centerView = modelViewMatrix * instanceMatrix * vec4(0,0,0,1);
//     centerView.xy  += position.xy * instanceScale.xy;   // position.y ∈ [0,1] ⇒ 底对齐
//     gl_Position     = projectionMatrix * centerView;
//
//   于是实例矩阵一辈子只写一次(建图时), 每帧零 CPU 开销, 且永远正对相机。
//
// 阴影: 阴影深度 pass 用的是**另一套 program**(three 的 depth material), 不会走我们注入的
//   顶点着色器 ⇒ 不处理的话草/灌木的阴影会是"没转过的交叉面片"。所以这里同时产出一个
//   `customDepthMaterial`, 注入同样的 billboard 变换, 保证 CSM 里影子形状一致。
import * as THREE from 'three';

/** 单位 billboard 四边形: x ∈ [-0.5,0.5] / y ∈ [0,1](底部贴地) / uv 0..1(含 v 翻转) */
export function buildBillboardGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array([
    -0.5, 0, 0,
    0.5, 0, 0,
    0.5, 1, 0,
    -0.5, 1, 0,
  ]);
  const uv = new Float32Array([
    0, 1,
    1, 1,
    1, 0,
    0, 0,
  ]);
  const nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/**
 * 给一个（MeshStandardMaterial 或 depth material）注入:
 *   1. 视图空间 billboard(丢掉实例旋转, 只保留平移/缩放)
 *   2. 每实例 UV 变化: 属性 `aUvOffset`(vec2, 该株在图集里的 u0/v0) + `aUvScale`(vec2, 宽高)
 *      ⇒ 一张图集出 N 种株型, 但**仍然只有 1 个 InstancedMesh / 1 个 draw call**。
 *   3. **着色器白键**(uVegKey > 0 时生效): 亮度高于阈值的像素抠掉。
 *      为什么非要它: `file://` 下 canvas 被 file 图片**污染**, `getImageData` 直接抛
 *      SecurityError(实测) ⇒ 像素级分析(自动切株/白键标定)在"双击单文件"时做不到。
 *      把"白底抠图"搬到片元着色器后, 素材有没有 alpha 都能用。
 */
const VEG_KEY_UNIFORMS = new WeakMap<THREE.Material, { value: number }>();

/** 取(或建)该材质对应的白键阈值 uniform 引用; 写入即生效, 不需要重编译。 */
export function vegKeyUniformOf(mat: THREE.Material): { value: number } {
  let u = VEG_KEY_UNIFORMS.get(mat);
  if (!u) { u = { value: 0 }; VEG_KEY_UNIFORMS.set(mat, u); }
  return u;
}

export function injectBillboard(mat: THREE.Material, opts: { billboard: boolean; uvVariety?: boolean }): void {
  const keyU = vegKeyUniformOf(mat);
  mat.onBeforeCompile = (shader) => {
    const wantUV = opts.uvVariety !== false;
    shader.uniforms.uVegKey = keyU;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', [
        '#include <common>',
        wantUV ? 'attribute vec2 aUvOffset;' : '',
        wantUV ? 'attribute vec2 aUvScale;' : '',
      ].filter(Boolean).join('\n'))
      // 顶点: 先做 UV 变化(图集选株), 再做 billboard 变换
      .replace('#include <uv_vertex>', [
        '#include <uv_vertex>',
        wantUV ? 'vMapUv = vMapUv * aUvScale + aUvOffset;' : '',
      ].filter(Boolean).join('\n'))
      .replace('#include <project_vertex>', opts.billboard ? [
        '// === billboard: 丢掉实例旋转, 在视图空间正对相机 ===',
        'vec3 bbScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), 1.0);',
        'vec4 bbCenter = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);',
        'bbCenter.xy += position.xy * bbScale.xy;',
        'vec4 mvPosition = bbCenter;',
        'gl_Position = projectionMatrix * mvPosition;',
      ].join('\n') : '#include <project_vertex>');
    // 片元: 着色器白键(0 = 关; 走 uniform, 切换不重编译)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uVegKey;')
      .replace('#include <map_fragment>', [
        '#include <map_fragment>',
        '// 白键: 亮度 ≥ uVegKey 的像素抠掉(软过渡 0.06)。uVegKey=0 时是恒等变换。',
        'if (uVegKey > 0.001) {',
        '  float vkLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));',
        '  diffuseColor.a *= 1.0 - smoothstep(uVegKey - 0.06, uVegKey + 0.06, vkLum);',
        '}',
      ].join('\n'));
  };
  mat.needsUpdate = true;
}

/** 生成与注入版匹配的阴影深度材质(CSM 深度 pass 用) */
export function makeBillboardDepthMaterial(base: THREE.Material): THREE.Material {
  const dm = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    // alphaTest 让阴影按贴片形状裁剪(与主材质一致)
    alphaTest: (base as THREE.MeshStandardMaterial).alphaTest ?? 0.35,
    // 深度材质没有 map 时 alphaTest 无效 → 复用主材质贴图
    map: (base as THREE.MeshStandardMaterial).map ?? null,
  } as THREE.MeshDepthMaterialParameters);
  injectBillboard(dm, { billboard: true, uvVariety: true });
  return dm;
}

/** 逐实例 UV 属性(打包时按株型写入)。返回可直接挂到几何上的两个属性。 */
export function buildUvVarietyAttributes(
  sprites: { u0: number; v0: number; u1: number; v1: number }[],
  pick: (i: number) => number,
  count: number,
): { aUvOffset: THREE.InstancedBufferAttribute; aUvScale: THREE.InstancedBufferAttribute } {
  const off = new Float32Array(count * 2);
  const scl = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const s = sprites.length ? sprites[Math.min(sprites.length - 1, Math.max(0, pick(i)))] : null;
    if (s) {
      off[i * 2] = s.u0; off[i * 2 + 1] = s.v0;
      scl[i * 2] = s.u1 - s.u0; scl[i * 2 + 1] = s.v1 - s.v0;
    } else {
      off[i * 2] = 0; off[i * 2 + 1] = 0;
      scl[i * 2] = 1; scl[i * 2 + 1] = 1;
    }
  }
  return {
    aUvOffset: new THREE.InstancedBufferAttribute(off, 2),
    aUvScale: new THREE.InstancedBufferAttribute(scl, 2),
  };
}
