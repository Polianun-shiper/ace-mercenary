// === PBR 材质工厂 (per user request: 完整现代 PBR 贴图支持) ===
// Every PBR-lit material in the game is created through this factory so that:
//   - color spaces / anisotropy / mipmaps are always correct
//   - texture sets are shared and tracked (VRAM accounting)
//   - later debug view modes (P4) and the deferred G-Buffer path (P3) hook
//     in at exactly one place
//
// Triplanar strategy for non-UV geometry (tanks, ships, primitives): instead
// of onBeforeCompile shader surgery (brittle across three versions), we BAKE
// triplanar UVs into the geometry once — dominant axis of each vertex normal
// selects the projection plane, position is mapped to 0..1 × repeat scale.
// Primitives (Box/Cylinder/Sphere) share cached baked geometries, so the
// cost is a one-time CPU pass per geometry type.

import * as THREE from 'three';
import { PBRTextureSet, getBuildingDetailChannels } from './texture-sets';
import { getTextureManager } from './texture-manager';

// === G-Buffer 输出注入 (per user request: 延迟渲染实验管线) ===
// Adds 3 extra MRT outputs (normal / metallic-roughness-ao / emissive) to any
// MeshStandardMaterial. When uDeferredMode > 0.5 the material writes raw
// G-Buffer channels instead of the lit color; location 0 stays three's own
// pc_fragColor (black in deferred mode — the lighting pass re-lights it).
// Anchor `#include <opaque_fragment>` exists in r185's meshphysical.glsl.js
// (the final output write happens right after it) — if the anchor ever
// changes, the injection silently no-ops and objects render unlit.
const DEFERRED_INJECT = `
    if ( uDeferredMode > 0.5 ) {
      gBufNormal = vec4( normal * 0.5 + 0.5, 1.0 );
      float _met = metalness;
      #ifdef USE_METALNESSMAP
        _met = texture2D( metalnessMap, vMetalnessMapUv ).x;
      #endif
      float _rgh = roughness;
      #ifdef USE_ROUGHNESSMAP
        _rgh = texture2D( roughnessMap, vRoughnessMapUv ).x;
      #endif
      float _ao = 1.0;
      #ifdef USE_AOMAP
        _ao = texture2D( aoMap, vAoMapUv ).x;
      #endif
      gBufMra = vec4( _met, _rgh, _ao, 1.0 );
      gBufEmissive = vec4( totalEmissiveRadiance, 1.0 );
    }`;

// === 延迟 G-Buffer albedo 输出 (per user request: 延迟渲染) ===
// Location 0 IS the albedo target. It must be RAW LINEAR — three's own
// tonemapping/colorspace chunks run before this block and would corrupt it,
// so we overwrite gl_FragColor with the raw diffuseColor AFTER
// colorspace_fragment. Depth is written to three's native depthTexture (NOT
// alpha — alpha stays 1). vMapUv is only declared under USE_MAP in r185 —
// every other map has its OWN varying (vRoughnessMapUv / vMetalnessMapUv /
// vAoMapUv).
const DEFERRED_ALBEDO_INJECT = `
    if ( uDeferredMode > 0.5 ) {
      gl_FragColor = vec4( diffuseColor.rgb, 1.0 );
    }`;

/**
 * Attach the deferred G-Buffer outputs to a material. Chains with any existing
 * onBeforeCompile (e.g. the layered-terrain injection) — `prev` runs first.
 */
export function attachDeferredMode(mat: THREE.MeshStandardMaterial) {
  if (mat.userData.deferredReady) return mat;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.uniforms.uDeferredMode = { value: mat.userData.deferredOn ? 1 : 0 };
    shader.fragmentShader =
      'uniform float uDeferredMode;\n' +
      'layout(location = 1) out highp vec4 gBufNormal;\n' +
      'layout(location = 2) out highp vec4 gBufMra;\n' +
      'layout(location = 3) out highp vec4 gBufEmissive;\n' +
      shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      '#include <opaque_fragment>\n' + DEFERRED_INJECT,
    );
    // === albedo 输出必须在 fog 之后 (per user request) ===
    // gl_FragColor is rewritten by tonemapping → colorspace → fog chunks. If
    // we write albedo at colorspace (before fog), the fog chunk mixes our raw
    // albedo toward fogColor (brown) and corrupts the G-Buffer. Injecting
    // AFTER fog keeps the albedo raw. (dithering after this only adds ±1/255
    // noise, negligible.)
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <fog_fragment>',
      '#include <fog_fragment>\n' + DEFERRED_ALBEDO_INJECT,
    );
    mat.userData._deferredUniform = shader.uniforms.uDeferredMode;
  };
  mat.userData.deferredReady = true;
  return mat;
}

/** Set the deferred mode on every material (1 = write G-Buffer, 0 = lit). */
export function setMaterialDeferred(mats: Iterable<THREE.MeshStandardMaterial>, on: boolean) {
  for (const m of mats) {
    if (!m || !m.userData?.deferredReady) continue;
    m.userData.deferredOn = on;
    const u = m.userData._deferredUniform as { value: number } | undefined;
    if (u) u.value = on ? 1 : 0;
  }
}

/** Bake triplanar UVs into a geometry (idempotent: skips if uv exists). */
export function bakeTriplanarUVs(geom: THREE.BufferGeometry, repeat = 1): THREE.BufferGeometry {
  if (geom.attributes.uv) return geom;
  const pos = geom.attributes.position;
  let nor = geom.attributes.normal;
  if (!nor) {
    geom.computeVertexNormals();
    nor = geom.attributes.normal;
  }
  const count = pos.count;
  const box = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute);
  const size = new THREE.Vector3();
  box.getSize(size);
  const uv = new Float32Array(count * 2);
  const px = pos.array as Float32Array;
  const nx = nor.array as Float32Array;
  for (let i = 0; i < count; i++) {
    const ax = Math.abs(nx[i * 3]), ay = Math.abs(nx[i * 3 + 1]), az = Math.abs(nx[i * 3 + 2]);
    let u: number, v: number;
    if (ax >= ay && ax >= az) {
      u = (px[i * 3 + 1] - box.min.y) / (size.y || 1); // YZ plane
      v = (px[i * 3 + 2] - box.min.z) / (size.z || 1);
    } else if (ay >= ax && ay >= az) {
      u = (px[i * 3] - box.min.x) / (size.x || 1);     // XZ plane
      v = (px[i * 3 + 2] - box.min.z) / (size.z || 1);
    } else {
      u = (px[i * 3] - box.min.x) / (size.x || 1);     // XY plane
      v = (px[i * 3 + 1] - box.min.y) / (size.y || 1);
    }
    uv[i * 2] = u * repeat;
    uv[i * 2 + 1] = v * repeat;
  }
  geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geom;
}

// Cache for geometry-level baked UVs (keyed by geometry uuid — primitives
// are shared through THREE.Cache / module singletons, so this dedups).
const bakedCache = new WeakSet<THREE.BufferGeometry>();

export function ensureTriplanarUVs(geom: THREE.BufferGeometry, repeat = 1): THREE.BufferGeometry {
  if (geom.attributes.uv || bakedCache.has(geom)) return geom;
  bakeTriplanarUVs(geom, repeat);
  bakedCache.add(geom);
  return geom;
}

export interface PBRMaterialOptions {
  /** Tint colour — multiplied into the albedo map (MeshStandardMaterial.color). */
  color?: number;
  metalness?: number;
  roughness?: number;
  emissive?: number;
  emissiveIntensity?: number;
  /** Extra per-channel multipliers (e.g. scale AO on aircraft). */
  aoIntensity?: number;
  /** Bake triplanar UVs into the geometry before building (no-UV objects). */
  triplanar?: boolean;
  triplanarRepeat?: number;
  /** Mark userData for debug layers / deferred G-Buffer (P3/P4). */
  debugTag?: string;
  /** === 天光(IBL)强度 (per user request ⑤) ===
   *  scene.environment(PMREM 天空盒)对该材质的贡献倍率。不传则保持 three 默认
   *  1.0(地形/建筑等不该被这一项影响的材质不受波及);机体走
   *  AIRCRAFT_ENV_MAP_INTENSITY。 */
  envMapIntensity?: number;
  /** === 漆面清漆层强度 (per user request: 机体/单位材质能量守恒升级) ===
   *  0/不传 = 不加(材质仍是 MeshStandardMaterial); >0 = 换成 MeshPhysicalMaterial
   *  并开 scalar clearcoat(纯标量, 不绑任何贴图 ⇒ 不占采样器)。机体用
   *  AIRCRAFT_COAT, 玻璃/座舱盖用 CANOPY_COAT。 */
  coat?: number;
  /** 清漆层自身粗糙度(默认 AIRCRAFT_COAT_ROUGHNESS)。 */
  coatRoughness?: number;
}

/** === 机体天光强度 (per user request ⑤: 机体的天光强度太弱了) ===
 *  控制 scene.environment(天空盒 PMREM IBL)在机身蒙皮上的贡献。原来三处各写
 *  "1.5"(甚至还停留在默认 1.0 的 PBR 贴图路径) —— 现在统一到这一个常量,
 *  f16c.ts / mig29.ts / models.ts 的 buildAircraftMesh 全部引用它。
 *  1.5 → 1.9: 机身金属反射与天光梯度(背光面、机腹反弹光)明显起来。 */
/**
 * 机体天光强度(per user request ⑤: 机体天光太弱) —— scene.environment(天空盒 IBL)
 * 对机体材质的贡献倍率。1.0 = three 默认(原始值), 1.9 = 上一版, 本次抬到 **2.6**。
 *
 * 控制台可实时调, 不用重新构建:
 *   localStorage.setItem('skybound.aircraftSkyLight','3.2'); location.reload()
 * (范围 0.2–6; 太高会把机腹/背光面的明暗层次冲平, 建议 2.0–3.0 之间找手感。)
 */
export const AIRCRAFT_ENV_MAP_INTENSITY = (() => {
  try {
    const raw = typeof window !== 'undefined' ? localStorage.getItem('skybound.aircraftSkyLight') : null;
    const v = raw === null ? NaN : parseFloat(raw);
    return Number.isFinite(v) && v > 0.2 && v <= 6 ? v : 2.6;
  } catch {
    return 2.6;
  }
})();

// === 漆面清漆层 (clearcoat) —— 解析式, 零贴图 ⇒ 零采样器 ========================
// (per user request: 机体/单位材质的"能量守恒升级")
//
// 先回答"为什么没有自己写 Fdez-Agüera 那套多散射(FssEss)补偿": three 0.185.1 的
// MeshStandardMaterial / MeshPhysicalMaterial 着色器里**已经**是那一套, 而且比手写更全:
//   · IBL 多散射     lights_physical_pars_fragment 的 computeMultiscattering()
//                    (FssEss = Fr*fab.x + F90*fab.y; multiScatter += Fms*Ems; fab 取自 dfgLUT)
//   · 直射光多散射   同 chunk 的 BRDF_GGX_Multiscatter()(RE_Direct_Physical 直接调用)
//   · IBL 掠射 Fresnel 同一套 dfgLUT 已经覆盖(不是老版本的解析近似)
//   · AO 的镜面遮蔽   aomap_fragment 的 computeSpecularOcclusion()(USE_ENVMAP + STANDARD)
//   · 涂层基底衰减    meshphysical: outgoingLight*(1-clearcoat*Fcc) + coatSpec*clearcoat
// 运行时 dump 每个已编译 program 的 gl.getShaderSource(fragmentShader) 可逐条复核
// (见 DSH_HANDOFF §296 的探针)。在同一条管线上**再注一遍就是二次补偿**(金属过亮)。
//
// 真正缺的是**清漆层本身**: 机体蒙皮是"底漆"没有清漆(真机是底漆 + 聚氨酯清漆),
// 而座舱盖等 MTL 里 d<1 的件被强制成 metalness=0/roughness=1(哑光黑 —— 可 MTL 写的是
// Ks=1/Ns=255 的抛光镜面), 于是舱盖渲染成一块不反光的黑洞。这里用**纯标量** clearcoat
// 补上: 不需要任何贴图 ⇒ 不新增采样器; 能量账由 three 的涂层模型自己平(基底按
// (1-clearcoat*Fcc) 扣掉涂层反射走的那份, 再叠 coatSpec*clearcoat)。
//
// 控制台可实时调, 不用重新构建:
//   localStorage.setItem('skybound.aircraftCoat','0.6'); location.reload()
// (0–1; 0 = 关掉清漆层回到原来的哑光漆面。)
export const AIRCRAFT_COAT = (() => {
  try {
    const raw = typeof window !== 'undefined' ? localStorage.getItem('skybound.aircraftCoat') : null;
    const v = raw === null ? NaN : parseFloat(raw);
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.35;
  } catch {
    return 0.35;
  }
})();
/** 清漆层自己的粗糙度: 越大越像"半哑光漆", 越小越像"刚打过蜡"。 */
export const AIRCRAFT_COAT_ROUGHNESS = 0.45;
/** 座舱盖/玻璃: 抛光(MTL 里这些件是 Ks=1 / Ns=255)。 */
export const CANOPY_COAT = 1.0;
export const CANOPY_COAT_ROUGHNESS = 0.06;

/** 所有加了清漆层的材质(供运行时缩放 / 探针 A/B)。 */
const coatedMaterials = new Set<THREE.MeshPhysicalMaterial>();
/** 每个材质的"满强度" clearcoat 值。 */
const coatBase = new WeakMap<THREE.Material, number>();

/**
 * 给材质加清漆层(幂等)。**必须**是 MeshPhysicalMaterial —— clearcoat 只存在于它上面
 * (MeshStandardMaterial 上设 clearcoat 是静默无效的)。带注入自检。
 */
export function applyPaintCoat<T extends THREE.MeshPhysicalMaterial>(
  mat: T,
  coat: number,
  roughness: number,
  tag: string = 'paintCoat',
): T {
  if (!(coat > 0)) return mat;
  mat.clearcoat = Math.min(1, coat);
  mat.clearcoatRoughness = roughness;
  coatBase.set(mat, mat.clearcoat);
  coatedMaterials.add(mat);
  mat.userData[tag] = true;
  // === 注入自检 (per 教训: 这类失效是**静默**的) ============================
  // 只查两件事, 都是"看不出来但错了"的失效:
  //   ① 材质不是 MeshPhysicalMaterial ⇒ three 不会开 USE_CLEARCOAT, 涂层不存在;
  //   ② clearcoat 绑了贴图 ⇒ 每个 clearcoatMap/roughnessMap/normalMap 各占 1 个采样器,
  //      与"不加贴图/不占采样器"的红线冲突(本项目的 ORM 已经把唯一空位占满了)。
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    const p = shader as unknown as {
      clearcoat?: boolean;
      clearcoatMap?: unknown;
      clearcoatRoughnessMap?: unknown;
      clearcoatNormalMap?: unknown;
    };
    const id = mat.name || mat.uuid;
    if (p.clearcoat !== true) {
      console.warn(`[pbr] clearcoat 未生效(材质不是 MeshPhysicalMaterial?): ${id}`);
    } else if (p.clearcoatMap || p.clearcoatRoughnessMap || p.clearcoatNormalMap) {
      console.warn(`[pbr] clearcoat 带了贴图(会占采样器, 与"零采样器"约定冲突): ${id}`);
    }
  };
  mat.needsUpdate = true;
  return mat;
}

/** 建一个**带清漆层**的 MeshPhysicalMaterial(玻璃件 / 纯色机体走这条)。 */
export function makeCoatedMaterial(
  params: THREE.MeshStandardMaterialParameters,
  coat: number,
  roughness: number,
  tag: string = 'paintCoat',
): THREE.MeshPhysicalMaterial {
  return applyPaintCoat(new THREE.MeshPhysicalMaterial(params), coat, roughness, tag);
}

/**
 * 运行时开关(给探针做**同一会话** A/B): scale=1 满强度, 0 = 关掉清漆层。
 * 只改 clearcoat 标量 ⇒ 不动贴图、不占采样器。返回受影响的材质数。
 */
export function setAircraftCoat(scale: number): number {
  let n = 0;
  for (const m of coatedMaterials) {
    const base = coatBase.get(m) ?? 0;
    m.clearcoat = Math.max(0, Math.min(1, base * scale));
    n++;
  }
  return n;
}

/**
 * Build a MeshStandardMaterial from a PBR texture set.
 * Color spaces: albedo/emissive = sRGB, data channels = linear.
 * Anisotropy comes from the global texture-quality setting.
 */
export function buildPBRMaterial(set: PBRTextureSet, opts: PBRMaterialOptions = {}, geom?: THREE.BufferGeometry): THREE.MeshStandardMaterial {
  const mgr = getTextureManager();
  const aniso = mgr.anisotropy;
  const apply = (t: THREE.Texture) => {
    mgr.track(t);
    t.anisotropy = Math.max(t.anisotropy, aniso);
    return t;
  };
  const orm = set.orm ? apply(set.orm) : null;
  // emissive 真的会发光才绑贴图(以前**无条件**绑: 涂装/单位/AI 机即使不自发光也白占 1 个采样器)。
  const wantEmissiveMap = !!opts.emissive && opts.emissive !== 0x000000 && (opts.emissiveIntensity ?? 0) > 0;
  const params: THREE.MeshStandardMaterialParameters = {
    color: new THREE.Color(opts.color ?? 0xffffff),
    map: apply(set.albedo),
    normalMap: apply(set.normal),
    // === ORM 单槽 (per 采样器预算: 6 -> 3~4) ================================
    // 只喂 aoMap(R=AO/G=roughness/B=metalness), 不再绑 roughnessMap/metalnessMap
    // —— 那两槽即使指向同一张贴图也各占一个采样器。set 没有 orm 时沿用三槽。
    ...(orm
      ? { aoMap: orm }
      // 旧资产/KTX2 回退: 三槽都在才沿用(ORM 化之后这三个字段是可选的)
      : set.ao && set.metallic && set.roughness
        ? { aoMap: apply(set.ao), metalnessMap: apply(set.metallic), roughnessMap: apply(set.roughness) }
        : {}),
    ...(wantEmissiveMap ? { emissiveMap: apply(set.emissive) } : {}),
    emissive: new THREE.Color(opts.emissive ?? 0x000000),
    emissiveIntensity: opts.emissiveIntensity ?? 0,
    metalness: opts.metalness ?? 1,
    roughness: opts.roughness ?? 1,
    flatShading: false,
  };
  // === 清漆层 (见文件上方 AIRCRAFT_COAT 的说明) =============================
  // 要走 clearcoat 就必须是 MeshPhysicalMaterial(它是 MeshStandardMaterial 的子类,
  // 参数完全一致; 不传 coat 时仍是 MeshStandardMaterial, 一点不变)。
  // 注意: 这里只**建**对类, 挂钩子放在 ORM 注入之后(见下), 否则会被那边的
  // `mat.onBeforeCompile = …` 覆盖掉 —— 那座钩子是不链 prev 的。
  const wantCoat = (opts.coat ?? 0) > 0;
  const mat: THREE.MeshStandardMaterial = wantCoat
    ? new THREE.MeshPhysicalMaterial(params)
    : new THREE.MeshStandardMaterial(params);
  mat.aoMapIntensity = opts.aoIntensity ?? 1;
  // === ORM 注入: 用 aoMap 这一个采样器取 G/B 喂 roughness/metalness ==============
  // three 的 chunk 顺序是 roughnessmap_fragment -> metalnessmap_fragment, 所以第一个里
  // 采样一次、第二个复用同一个 texelOrm(同作用域, 不额外采样)。
  if (orm) {
    mat.userData.ormSingle = true;   // 给 KTX2 升级路径看: 走 ORM 就不再接三槽
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <roughnessmap_fragment>', [
          'float roughnessFactor = roughness;',
          'vec4 texelOrm = texture2D( aoMap, vAoMapUv );',
          'roughnessFactor *= texelOrm.g;',
        ].join('\n'))
        .replace('#include <metalnessmap_fragment>', [
          'float metalnessFactor = metalness;',
          'metalnessFactor *= texelOrm.b;',
        ].join('\n'));
      if (!shader.fragmentShader.includes('texelOrm')) {
        console.warn('[pbr] ORM 注入失败(锚点未命中): ' + (mat.name || mat.uuid));
      }
    };
    mat.needsUpdate = true;
  }
  // === 天光(IBL)强度 (per user request ⑤) ===
  // 只在该项被显式传入时改写; 否则保持 three 的 1.0(不波及地形/建筑)。
  if (opts.envMapIntensity !== undefined) mat.envMapIntensity = opts.envMapIntensity;
  // === 清漆层挂钩子: 必须排在 ORM 注入**之后**(那座钩子不链 prev, 先挂会被覆盖) ===
  if (wantCoat) applyPaintCoat(mat as THREE.MeshPhysicalMaterial, opts.coat as number, opts.coatRoughness ?? AIRCRAFT_COAT_ROUGHNESS);
  mat.needsUpdate = true;
  if (opts.debugTag) mat.userData.debugTag = opts.debugTag;
  mat.userData.pbrSet = set.id;
  // Keep a reference to the procedural set so a later KTX2 upgrade can
  // dispose it (the compressed textures replace it on the material).
  mat.userData._proceduralSet = set;
  attachDeferredMode(mat);
  return mat;
}

/** Build a PBR material from a set + geometry that needs triplanar UVs. */
export function buildTriplanarMaterial(
  set: PBRTextureSet,
  geom: THREE.BufferGeometry,
  opts: PBRMaterialOptions = {},
): THREE.MeshStandardMaterial {
  ensureTriplanarUVs(geom, opts.triplanarRepeat ?? 1);
  return buildPBRMaterial(set, opts, geom);
}

// === Shared building materials (city) ===
// The city albedo textures are already canvas-baked; this adds matching
// normal + ao channels so the same 4 materials become full PBR sets.
export function buildBuildingMaterial(opts: {
  kind: 'glass' | 'office' | 'residential' | 'landmark';
  albedo: THREE.Texture;
  emissive: THREE.Color;
  emissiveIntensity: number;
  roughness: number;
  metalness: number;
}): THREE.MeshStandardMaterial {
  const mgr = getTextureManager();
  const detail = getBuildingDetailChannels(opts.kind);
  const aniso = mgr.anisotropy;
  const set = [opts.albedo, detail.normal, detail.ao];
  for (const t of set) {
    mgr.track(t);
    t.anisotropy = Math.max(t.anisotropy, aniso);
  }
  const mat = new THREE.MeshStandardMaterial({
    map: opts.albedo,
    emissiveMap: opts.albedo,
    emissive: opts.emissive,
    emissiveIntensity: opts.emissiveIntensity,
    normalMap: detail.normal,
    aoMap: detail.ao,
    roughness: opts.roughness,
    metalness: opts.metalness,
  });
  mat.userData.pbrSet = `building/${opts.kind}`;
  attachDeferredMode(mat);
  return mat;
}
