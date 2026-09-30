// === Blender 资产(.glb)运行时加载 =========================================
//
// 为什么不用 GLTFLoader.load(): three 的 Loader 内部走 FileLoader → fetch, 而浏览器
// 在 **file:// 下禁止 fetch** —— 双击单文件时会抛一个裸 Event, 一路冒泡成"模型加载
// 失败"。这和 fetch-asset.ts 头部记的是同一个坑(贴图因此改走 <img>)。所以这里自己
// 用 XHR 取字节、按需 pako.inflate, 再交给 GLTFLoader.parse()。
//
// 与 blender/hangar/README.md 的导出约定配套:
//   · 导出 .glb, **不开 Draco**。这套机库 19k 面, 几何压完 gzip 也才 50KB 量级,
//     而开 Draco 会把 /draco/* 解码器拉进依赖 —— 它没被内联进单文件构建(见
//     asset-library.json 与 build-single-html.mjs 的 ASSETS 列表), 得不偿失。
//   · 贴图内嵌(BufferView)在 GLB 里, 不放外链。
//   · 入库由 scripts/import-asset.mjs 压成 <name>.glb.gz。

import { inflate } from 'pako';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { assetUrl } from './asset-url';
import { fetchAssetBuffer } from './fetch-asset';

/** GLB 容器魔数 'glTF'(小端读作 0x46546c67)。 */
const GLB_MAGIC = 0x46546c67;
/** 读到 HTML 而不是 GLB 时的提示 —— 线上 404 会拿到 SPA 兜底页, 这条线索很关键。 */
const HTML_HINT =
  '拿到了 HTML 而不是 GLB: 通常是资产没随行上传(线上只传 index.html 时 ' +
  'assets/ 不存在), 或路径没登记进 asset-library.json。';

/**
 * 取二进制大资产: 优先 `<path>.gz` 并 inflate, 失败回退原始路径。
 *
 * 与 obj-gzip 的 fetchTextAsset 同一套策略, 只是返回 ArrayBuffer 不返回文本 ——
 * GLB 是二进制, 走 TextDecoder 会把字节解坏。
 */
export async function fetchBinaryAsset(path: string): Promise<ArrayBuffer> {
  try {
    const bytes = new Uint8Array(await fetchAssetBuffer(assetUrl(path + '.gz')));
    // gzip 魔数: 服务器未自动解压时才是真 gzip 数据。
    if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const out = inflate(bytes);
      return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    }
    // 已被 Content-Encoding 解压 → 字节即原文件(部分静态服务器行为)。
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  } catch {
    // .gz 缺失/读取失败 → 回退原始路径
  }
  return fetchAssetBuffer(assetUrl(path));
}

export interface LoadedGLB {
  /** 已挂好材质与贴图的场景根。调用方自行 add 到场景并负责位置。 */
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
  /** 释放几何 / 材质 / 贴图。机库退出时按 hangar.ts 的显存回收约定调用。 */
  dispose(): void;
}

/**
 * 载入一个 .glb(或 .glb.gz)。
 *
 * `path` 是 public/ 下的原始路径(如 '/models/hangar/hangar.glb'),
 * 与 asset-url 的解析规则一致 —— .gz 后缀由本函数自己加。
 */
export async function loadGLB(path: string): Promise<LoadedGLB> {
  const buf = await fetchBinaryAsset(path);

  if (buf.byteLength < 12 || new DataView(buf).getUint32(0, true) !== GLB_MAGIC) {
    throw new Error(`loadGLB(${path}): ${HTML_HINT}`);
  }

  const loader = new GLTFLoader();
  // parse() 而不是 load(): 字节已经在我们手里, 不再让 Loader 去 fetch。
  const gltf = await new Promise<any>((resolve, reject) => {
    loader.parse(buf, '', resolve, reject);
  });

  const scene = gltf.scene as THREE.Group;
  scene.name = scene.name || 'glb';

  return {
    scene,
    animations: gltf.animations ?? [],
    dispose: () => disposeTree(scene),
  };
}

/** 遍历释放。贴图可能挂在多个槽位(map/normalMap/roughnessMap/...), 一并处理。 */
export function disposeTree(root: THREE.Object3D): void {
  const seenTex = new Set<THREE.Texture>();
  const seenMat = new Set<THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const mat of mats) {
      if (seenMat.has(mat)) continue;
      seenMat.add(mat);
      for (const value of Object.values(mat as unknown as Record<string, unknown>)) {
        const tex = value as THREE.Texture;
        if (tex && (tex as any).isTexture && !seenTex.has(tex)) {
          seenTex.add(tex);
          tex.dispose();
        }
      }
      mat.dispose();
    }
  });
}

/**
 * 递归收集场景里的光源 —— Blender 里加的灯会以 KHR_lights_punctual 存进 GLB,
 * GLTFLoader 会还原成 THREE.Light。机库布景需要它们, 但调用方通常想统一
 * 统计/调参, 所以给一个取用的入口。
 */
export function collectLights(root: THREE.Object3D): THREE.Light[] {
  const out: THREE.Light[] = [];
  root.traverse((o) => {
    if ((o as THREE.Light).isLight) out.push(o as THREE.Light);
  });
  return out;
}
