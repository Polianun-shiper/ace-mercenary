/**
 * PBRMaterialPipeline — PBR 材质管线
 * =====================================================================
 * 用户在「实验机库」里导入机体模型 + PBR 贴图集时用这个管线加载。
 * 支持的标准贴图通道：
 *   - albedo (base color)        ← 必需
 *   - normal                      ← 法线贴图
 *   - roughness                   ← 粗糙度 (灰度)
 *   - metallic                    ← 金属度 (灰度)
 *   - ao (ambient occlusion)      ← 环境光遮蔽贴图
 *   - emissive                    ← 自发光
 *   - height                      ← 高度贴图 (视差)
 *
 * 工作流程：
 *   1. 用户在 UI 选择 .glb/.gltf/.obj 模型文件
 *   2. 用户分别为 7 个贴图槽选择图片文件 (可选)
 *   3. PBRMaterialPipeline.loadMeshFromFiles() 加载并构建材质
 *   4. 返回的 THREE.Group 可直接添加到场景，已开启自阴影
 *
 * 在实验机库里用户能实时调整 metallic/roughness/emissive 强度等
 * 滑块，并预览效果。点「保存」后会写到 localStorage 的 asset
 * registry，下次进游戏自动加载。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

export interface PBRTextureSlots {
  albedo?: File | string;
  normal?: File | string;
  roughness?: File | string;
  metallic?: File | string;
  ao?: File | string;
  emissive?: File | string;
  height?: File | string;
}

export interface PBRMaterialParams {
  /** 0-1，覆盖贴图的金属度 */
  metallic: number;
  /** 0-1，覆盖贴图的粗糙度 */
  roughness: number;
  /** 颜色乘子 */
  color: THREE.ColorRepresentation;
  /** 0-2，环境贴图强度 */
  envMapIntensity: number;
  /** 0-1，AO 贴图强度 */
  aoMapIntensity: number;
  /** 0-1，法线贴图强度 */
  normalScale: number;
  /** 自发光颜色 */
  emissive: THREE.ColorRepresentation;
  /** 自发光强度 */
  emissiveIntensity: number;
  /** 双面渲染 */
  side: THREE.Side;
}

export const DEFAULT_PBR_PARAMS: PBRMaterialParams = {
  metallic: 0.85,
  roughness: 0.25,
  color: 0xcccccc,
  envMapIntensity: 1.0,
  aoMapIntensity: 1.0,
  normalScale: 1.0,
  emissive: 0x000000,
  emissiveIntensity: 0,
  side: THREE.FrontSide,
};

const gltfLoader = new GLTFLoader();

// Configure DRACO decoder — many modern GLBs use Draco mesh compression.
// The decoder files ship with three.js under examples/jsm/libs/draco/.
// We copy them to /public/draco/ at build time so they're served at /draco/.
let dracoConfigured = false;
function ensureDracoConfigured() {
  if (dracoConfigured) return;
  try {
    const draco = new DRACOLoader();
    // Path must end with a slash. DRACOLoader will look for
    // /draco/draco_wasm_wrapper.js + /draco/draco_decoder.wasm
    draco.setDecoderPath('/draco/');
    gltfLoader.setDRACOLoader(draco);
    dracoConfigured = true;
  } catch (e) {
    console.warn('[PBR] DRACOLoader setup failed — Draco-compressed GLBs will not load:', e);
  }
}

// Configure KTX2 texture decoder — used by some GLBs with Basis-compressed textures.
let ktx2Configured = false;
function ensureKtx2Configured(renderer?: THREE.WebGLRenderer) {
  if (ktx2Configured) return;
  try {
    const ktx2 = new KTX2Loader();
    ktx2.setTranscoderPath('/basis/');
    if (renderer) ktx2.detectSupport(renderer);
    gltfLoader.setKTX2Loader(ktx2);
    ktx2Configured = true;
  } catch (e) {
    console.warn('[PBR] KTX2Loader setup failed — KTX2 textures will not load:', e);
  }
}

const objLoader = new OBJLoader();
const texLoader = new THREE.TextureLoader();

/** 从 File 对象加载贴图 (用户在 UI 上传的文件) */
export async function loadTextureFromFile(file: File): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    texLoader.load(
      url,
      (tex) => {
        URL.revokeObjectURL(url);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        resolve(tex);
      },
      undefined,
      (err) => {
        URL.revokeObjectURL(url);
        reject(err);
      },
    );
  });
}

export async function loadTextureFromPath(path: string, srgb = true): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    texLoader.load(
      path,
      (tex) => {
        if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        resolve(tex);
      },
      undefined,
      reject,
    );
  });
}

/** 异步加载多个贴图槽 */
export async function loadAllTextures(slots: PBRTextureSlots): Promise<{
  map?: THREE.Texture;
  normalMap?: THREE.Texture;
  roughnessMap?: THREE.Texture;
  metalnessMap?: THREE.Texture;
  aoMap?: THREE.Texture;
  emissiveMap?: THREE.Texture;
}> {
  const out: any = {};
  const tasks: Promise<void>[] = [];

  const load = async (slot: File | string | undefined, key: string, srgb: boolean) => {
    if (!slot) return;
    try {
      let tex: THREE.Texture;
      if (typeof slot === 'string') {
        tex = await loadTextureFromPath(slot, srgb);
      } else {
        tex = await loadTextureFromFile(slot);
        if (!srgb) tex.colorSpace = THREE.NoColorSpace;
      }
      out[key] = tex;
    } catch (e) {
      console.warn(`[PBR] Failed to load ${key} texture:`, e);
    }
  };

  tasks.push(load(slots.albedo,    'map',           true));
  tasks.push(load(slots.normal,    'normalMap',     false));
  tasks.push(load(slots.roughness, 'roughnessMap',  false));
  tasks.push(load(slots.metallic,  'metalnessMap',  false));
  tasks.push(load(slots.ao,        'aoMap',         false));
  tasks.push(load(slots.emissive,  'emissiveMap',   true));
  await Promise.all(tasks);
  return out;
}

/** 构建一个标准 PBR MeshStandardMaterial */
export function buildPBRMaterial(
  textures: Awaited<ReturnType<typeof loadAllTextures>>,
  params: PBRMaterialParams,
): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: params.color,
    metalness: params.metallic,
    roughness: params.roughness,
    envMapIntensity: params.envMapIntensity,
    aoMapIntensity: params.aoMapIntensity,
    emissive: params.emissive,
    emissiveIntensity: params.emissiveIntensity,
    side: params.side,
  });
  if (textures.map) mat.map = textures.map;
  if (textures.normalMap) {
    mat.normalMap = textures.normalMap;
    mat.normalScale = new THREE.Vector2(params.normalScale, params.normalScale);
  }
  if (textures.roughnessMap) mat.roughnessMap = textures.roughnessMap;
  if (textures.metalnessMap) mat.metalnessMap = textures.metalnessMap;
  if (textures.aoMap) mat.aoMap = textures.aoMap;
  if (textures.emissiveMap) mat.emissiveMap = textures.emissiveMap;
  mat.needsUpdate = true;
  return mat;
}

/** 从 .glb/.gltf/.obj 文件加载 mesh，返回 THREE.Group */
export async function loadModelFromFile(file: File, renderer?: THREE.WebGLRenderer): Promise<THREE.Group> {
  ensureDracoConfigured();
  ensureKtx2Configured(renderer);
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'glb' || ext === 'gltf') {
    const url = URL.createObjectURL(file);
    try {
      const result = await gltfLoader.loadAsync(url);
      URL.revokeObjectURL(url);
      // Enable shadows on every mesh in the loaded scene
      result.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = true;
          m.receiveShadow = true;
        }
      });
      return result.scene;
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
  } else if (ext === 'obj') {
    const text = await file.text();
    const group = objLoader.parse(text);
    group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    return group;
  } else {
    throw new Error(`Unsupported model format: .${ext} (supported: .glb .gltf .obj)`);
  }
}

/**
 * Load a model directly from a Blob — avoids the data-URL round-trip which
 * bloats memory for large GLBs. Used by the IndexedDB-backed blob store.
 */
export async function loadModelFromBlob(blob: Blob, fileName: string, renderer?: THREE.WebGLRenderer): Promise<THREE.Group> {
  const file = new File([blob], fileName, { type: blob.type || 'application/octet-stream' });
  return loadModelFromFile(file, renderer);
}

/**
 * Load a model from a stored data URL (used by the engine when rehydrating
 * a saved aircraft preset at mission start). Reconstructs a File from the
 * data URL and delegates to loadModelFromFile.
 *
 * For large models that exceed localStorage budget, the preset stores an
 * `idb://<key>` sentinel instead of a base64 data URL — callers should
 * check `isIdbRef()` first and use `getModelBlob()` + `loadModelFromBlob()`.
 */
export async function loadModelFromDataUrl(dataUrl: string, fileName: string, renderer?: THREE.WebGLRenderer): Promise<THREE.Group> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const file = new File([blob], fileName, { type: blob.type || 'application/octet-stream' });
  return loadModelFromFile(file, renderer);
}

/**
 * 把 PBR 材质应用到 Group 的所有 mesh
 * 替换原有的所有 material (用于「一键给机体上 PBR 材质」)
 */
export function applyPBRToGroup(
  group: THREE.Group,
  textures: Awaited<ReturnType<typeof loadAllTextures>>,
  params: PBRMaterialParams,
) {
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    // 销毁旧材质
    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((m) => m.dispose());
    } else if (mesh.material) {
      mesh.material.dispose();
    }
    mesh.material = buildPBRMaterial(textures, params);
    // 开启自阴影 (机体互相投影)
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });
}

/** 把所有 mesh 的 PBR 参数同步更新 (用户拖滑块时实时刷新) */
export function updatePBRParams(group: THREE.Group, params: Partial<PBRMaterialParams>) {
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    if (!mat || !mat.isMeshStandardMaterial) return;
    if (params.metallic !== undefined) mat.metalness = params.metallic;
    if (params.roughness !== undefined) mat.roughness = params.roughness;
    if (params.color !== undefined) mat.color.set(params.color);
    if (params.envMapIntensity !== undefined) mat.envMapIntensity = params.envMapIntensity;
    if (params.aoMapIntensity !== undefined) mat.aoMapIntensity = params.aoMapIntensity;
    if (params.normalScale !== undefined && mat.normalScale) {
      mat.normalScale.set(params.normalScale, params.normalScale);
    }
    if (params.emissive !== undefined) mat.emissive.set(params.emissive);
    if (params.emissiveIntensity !== undefined) mat.emissiveIntensity = params.emissiveIntensity;
    if (params.side !== undefined) mat.side = params.side;
    mat.needsUpdate = true;
  });
}

/** 销毁 group 上的所有材质 + 几何 (释放 GPU 资源) */
export function disposeGroup(group: THREE.Object3D) {
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((m) => {
        (m as any).map?.dispose?.();
        (m as any).normalMap?.dispose?.();
        (m as any).roughnessMap?.dispose?.();
        (m as any).metalnessMap?.dispose?.();
        (m as any).aoMap?.dispose?.();
        (m as any).emissiveMap?.dispose?.();
        m.dispose();
      });
    } else if (mesh.material) {
      const m = mesh.material as any;
      m.map?.dispose?.();
      m.normalMap?.dispose?.();
      m.roughnessMap?.dispose?.();
      m.metalnessMap?.dispose?.();
      m.aoMap?.dispose?.();
      m.emissiveMap?.dispose?.();
      m.dispose();
    }
  });
}
