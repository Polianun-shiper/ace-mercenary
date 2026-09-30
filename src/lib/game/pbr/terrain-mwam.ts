// === MWAM 地形图层(KTX2)配置 (per user request: MW Landscape Auto
// Material → web) ===
//
// UE 资产包 MWLandscapeAutoMaterial 的架构我们移植成"换源不换架构":
// 分层 splat 规则(高度带/坡度→权重,smoothstep 分带)原样保留,只把
// 每"角色槽"(低地/植被带/岩带/雪线带)的程序化 256² 画布换成 UE 的
// 真实材质贴图(Dirt/Grass/Rock/SandA/SandC/Snow/Stones),贴图在构建期
// 由 scripts/mwam-import.mjs 转成 KTX2(ETC1S)放
// public/textures/ktx2/terrain/<layer>/,运行时经 KTX2Loader 异步加载,
// 失败/缺失时对应槽位自动回退到程序化画布(永远不黑屏)。
//
// 学习自 MWAM:MF_MWAM_LandscapeUVs(世界对齐平铺)、SlopeMask/高度分带
// (=splatAt)、层叠法线 CombineNormal(=shader 第二 octave)、Variation
// 宏变化(未启用,见 terrain-layers 开关)。bake 思想 = 离线 KTX2。

import * as THREE from 'three';
import { getTextureManager } from './texture-manager';

/** 四个 splat 角色槽:index 0-3 对应 splat.xyzw(sand/grass/rock/snow 语义)。 */
export interface MwamSlot {
  /** public/textures/ktx2/terrain/<sheet>/ 下的图层名(缺库时回退画布) */
  sheet: string;
  /** 本层贴图平铺倍数(相对 uLayerRepeat=1/90 世界单位) */
  scale: number;
}

export interface MwamPreset {
  key: string;
  label: string;
  /** 槽0 低地(splat.x)… 槽3 雪线带(splat.w) */
  slots: [MwamSlot, MwamSlot, MwamSlot, MwamSlot];
}

// === 每贴图层的 PBR 标量(per user request: 层间粗糙度差异) ===
// UE Ground 集只有 col+nrm,没有 roughness 贴图 —— 用层常量粗糙度按
// splat 权重在 shader 里混合(沙糙 / 岩较光滑 / 雪高反…),随后仍乘以
// relief 粗糙图保留微细节。值域按粗糙度惯例 0(镜面)~1(全糙)。
export const SHEET_ROUGHNESS: Record<string, number> = {
  dirt: 0.92,        // 泥土 — 微粗糙
  grass: 1.0,        // 草地 — 漫射主导
  rock: 0.68,        // 岩壁 — 略滑、反光带
  sand_a: 0.88,      // 沙丘 — 糙
  sand_c: 0.9,       // 波纹沙 — 糙
  snow: 0.8,         // 雪 — 相对光滑、有高光
  stones: 0.75,      // 碎石滩 — 中糙
  cover_rocks: 0.7,
  plants_grass: 1.0,
};
export function sheetRoughness(sheet: string | undefined): number {
  if (!sheet) return 0.95;
  return SHEET_ROUGHNESS[sheet] ?? 0.95;
}

// === 分层/AO 风格参数(per user request: 分带修复 + 高度图 AO) ===
// 分带用"真实高度分布分位"驱动,分位边界与软化宽度见各 style:
//   lowTop    : 低地(沙/土)带顶,vegiTop: 植被/中间带顶
//   rockTop   : 岩带顶(之后进入雪带;snowEnabled=false 时岩带延伸到顶)
// 边界间的平滑宽度 = 各边界在分位 ±bandQ 处对应的高度差(随地形自适应)。
// AO:aoStrength(0=关)+ 双采样半径(米)。这些是纯数据,shader/烘焙按此出。
export interface MwamStyleCfg {
  zones: {
    lowTop: number;      // 分位,如 0.055
    vegiTop: number;     // 分位
    rockTop: number;     // 分位
    snowEnabled: boolean;
    bandQ: number;       // 边界软化宽度(分位 ±)
  };
  aoStrength: number;    // 1 = 全遮蔽上限
  aoRadius: [number, number]; // 两个遮蔽采样半径(米)
}

const STYLE_CFG: Record<string, MwamStyleCfg> = {
  // 山岳:谷底土带窄、草带居中、岩带中高、雪顶 —— 直方图分位保证每一层
  // 都占有真实的面积,不再出现"一个带垄断全图"。
  mountain: {
    zones: { lowTop: 0.05, vegiTop: 0.58, rockTop: 0.87, snowEnabled: true, bandQ: 0.05 },
    aoStrength: 0.85, aoRadius: [380, 1100],
  },
  plains: {
    zones: { lowTop: 0.06, vegiTop: 0.66, rockTop: 0.93, snowEnabled: true, bandQ: 0.05 },
    aoStrength: 0.55, aoRadius: [160, 480],
  },
  // 荒漠:snow 关闭 → 岩带随分位爬到顶(沙丘低地 + 岩台/石山高区),
  // 陡坡另转岩 —— 荒漠视觉 = 沙 + 岩双主层,不再是单一张沙。
  desert: {
    zones: { lowTop: 0.06, vegiTop: 0.72, rockTop: 1.0, snowEnabled: false, bandQ: 0.06 },
    aoStrength: 0.5, aoRadius: [150, 450],
  },
  archipelago: {
    zones: { lowTop: 0.05, vegiTop: 0.6, rockTop: 0.88, snowEnabled: true, bandQ: 0.05 },
    aoStrength: 0.7, aoRadius: [220, 660],
  },
  canyon: {
    zones: { lowTop: 0.04, vegiTop: 0.5, rockTop: 0.9, snowEnabled: true, bandQ: 0.04 },
    aoStrength: 0.8, aoRadius: [300, 900],
  },
};

export function getMwamStyleCfg(key: string | undefined | null): MwamStyleCfg | null {
  if (!key) return null;
  return STYLE_CFG[key] ?? null;
}

// === 按地图风格选层(学习 MWAM 示例材质的层叠配比) ===
// mountain: 谷底土/草带/岩壁/雪顶 —— 对应 MWAM MountainRange 风格
// plains  : 沙岸(水边)/草/岩/雪 —— 旧"平原"默认语义
// desert  : 浅色沙丘(sandA)/波纹沙(sandC)/岩山/土 —— 修掉旧 desert 用
//           plains+绿化逻辑的"荒漠长草"问题(desert 的 vegi 槽几乎覆盖
//           整个高度带,必须给沙而非草)
// archipelago: 沙滩/雨林绿/岩/雪山
// canyon  : 土/沙/岩/雪(备用,当前无调用方)
const PRESETS: Record<string, MwamPreset> = {
  mountain: {
    key: 'mountain', label: 'MWAM 山岳 (Dirt/Grass/Rock/Snow)',
    slots: [
      { sheet: 'dirt', scale: 1.0 },
      { sheet: 'grass', scale: 1.3 },
      { sheet: 'rock', scale: 1.7 },
      { sheet: 'snow', scale: 1.0 },
    ],
  },
  plains: {
    key: 'plains', label: 'MWAM 平原 (SandC/Grass/Rock/Snow)',
    slots: [
      { sheet: 'sand_c', scale: 1.0 },
      { sheet: 'grass', scale: 1.2 },
      { sheet: 'rock', scale: 1.6 },
      { sheet: 'snow', scale: 1.1 },
    ],
  },
  desert: {
    key: 'desert', label: 'MWAM 荒漠 (SandA/SandC/Rock/Dirt)',
    slots: [
      { sheet: 'sand_a', scale: 1.0 },
      { sheet: 'sand_c', scale: 1.2 },
      { sheet: 'rock', scale: 1.6 },
      { sheet: 'dirt', scale: 1.0 },
    ],
  },
  archipelago: {
    key: 'archipelago', label: 'MWAM 群岛 (SandA/Grass/Rock/Snow)',
    slots: [
      { sheet: 'sand_a', scale: 1.0 },
      { sheet: 'grass', scale: 1.25 },
      { sheet: 'rock', scale: 1.6 },
      { sheet: 'snow', scale: 1.0 },
    ],
  },
  canyon: {
    key: 'canyon', label: 'MWAM 峡谷 (Dirt/SandC/Rock/Snow)',
    slots: [
      { sheet: 'dirt', scale: 0.9 },
      { sheet: 'sand_c', scale: 1.1 },
      { sheet: 'rock', scale: 1.5 },
      { sheet: 'snow', scale: 1.0 },
    ],
  },
};

/** 旧行为(纯画布)的默认平铺倍数,无 preset 时与历史渲染一致。 */
export const LEGACY_SCALES: [number, number, number, number] = [1.0, 1.3, 1.7, 1.0];

export function getMwamPreset(key: string | undefined | null): MwamPreset | null {
  if (!key) return null;
  return PRESETS[key] ?? null;
}

// ===========================================================================
// 异步 KTX2 图层加载(每槽 albedo+normal 独立成败,失败槽位保留画布)
// ===========================================================================
const TERRAIN_KTX2_BASE = '/textures/ktx2/terrain';

export interface MwamSlotTextures {
  albedo?: THREE.CompressedTexture;
  normal?: THREE.CompressedTexture;
}

function ktx2Tex(loader: any, path: string, srgb: boolean, mgr: ReturnType<typeof getTextureManager>): Promise<THREE.CompressedTexture> {
  return loader.loadAsync(path).then((t: THREE.CompressedTexture) => {
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false; // basisu 已烘焙 mip 链
    t.anisotropy = Math.max(t.anisotropy, mgr.anisotropy);
    mgr.track(t);
    return t;
  });
}

/**
 * 加载 preset 四个槽位的 KTX2 图层。返回 per-slot 结果;某槽任一通道
 * 失败(asset 缺失/加载错)该槽位返回空对象 —— 调用方保留画布纹理。
 * 返回 null 表示 KTX2Loader 不可用(basis 缺失/未挂渲染器)。
 * 渲染器支持检测由 TextureManager 在 attachRenderer 时完成。
 */
export async function loadMwamSlotTextures(
  preset: MwamPreset,
): Promise<MwamSlotTextures[] | null> {
  const mgr = getTextureManager();
  const loader = await mgr.getKtx2Loader(); // 内部做 URL 重映射 + detectSupport
  if (!loader) return null;

  const out: MwamSlotTextures[] = [];
  for (const slot of preset.slots) {
    const base = `${TERRAIN_KTX2_BASE}/${slot.sheet}`;
    const [albedo, normal] = await Promise.all([
      ktx2Tex(loader, `${base}/albedo.ktx2`, true, mgr).catch(() => undefined),
      ktx2Tex(loader, `${base}/normal.ktx2`, false, mgr).catch(() => undefined),
    ]);
    out.push({ albedo, normal });
  }
  return out;
}

/**
 * 载入"层法线 2D 数组"(normal_array_<preset>.ktx2, 由 mwam-import.mjs 用 basisu
 * -tex_array 导出, layerCount = 4 = 槽顺序)。
 *
 * 为什么要数组: 地形材质长期贴着 MAX_TEXTURE_IMAGE_UNITS(16), 而"层法线 octave"要 4 个
 * 独立采样器(14 -> 18 直接爆, 历史上 12 个材质编译失败、地表只剩 skirt), 所以它一直被禁。
 * 4 层打成 sampler2DArray 后只占 **1** 个采样器 ⇒ 净省 3, 并且能把 octave 打开。
 * 失败/资产缺失一律返回 null ⇒ 调用方保持"无数组"状态(octave 自门禁关闭, 观感与今天逐位一致)。
 */
export async function loadMwamNormalArray(preset: MwamPreset): Promise<THREE.Texture | null> {
  const mgr = getTextureManager();
  const loader = await mgr.getKtx2Loader();
  if (!loader) return null;
  const url = `/textures/ktx2/terrain/normal_array_${preset.key}.ktx2`;
  try {
    const tex = await loader.loadAsync(url) as THREE.Texture & { isCompressedArrayTexture?: boolean };
    if (!tex || !tex.isCompressedArrayTexture) return null;   // 不是数组就别用
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
  } catch {
    return null;   // 单文件未内联 / 资产缺失 / 解码失败 → 逐槽回退
  }
}

// ===========================================================================
// §356 回退: 8 层 KTX2 数组地表 + "材质表"单一真源 —— 已从**游戏运行期移除**
// ===========================================================================
//
// 这里曾经有一套"运行时读 public/config/terrain-materials.json 当单一真源, 再用
// sampler2DArray(albedo/normal/orm 三个数组, 8 层)做逐像素分层混合"的实现, 连
// loadTerrainMaterials() 里那句 **无条件的 fetch('/config/terrain-materials.json')**
// 一起删掉了。为什么删:
//   · 方向冲突 —— 本项目的地表混合在 **Blender/资产管线**里做完, 游戏只贴最终烘好的图;
//     这套是"游戏运行期自己堆 8 层", 是另一条路。
//   · 采样器安全 —— 地形材质本来就贴着 MAX_TEXTURE_IMAGE_UNITS(16)(历史事故: 超限 ⇒
//     MeshStandardMaterial 编译失败 ⇒ 地表完全不画只剩 skirt)。多一套数组采样器/声明
//     就是在往这条线上压。
// 资产**不删**: public/config/terrain-materials.json、public/textures/ktx2/terrain/**、
// public/custom-maps/**/region_masks.png 仍在盘上, 归 Blender/资产管线用。
// 运行期地表只有一条路: 下面这套旧的 4 槽(loadMwamSlotTextures + 画布兜底)。

// §356 回退: 材质表相关的类型(TerrainLayer / TerrainMaterials)与
//   loadTerrainMaterials / layersForSlot / texSetForSlot / loadMwamLayerArrays
//   一并删除 —— 运行期不再有任何字段/函数引用 terrain-materials.json, 也不再有
//   数组载入入口(连"探测式"拉取都不存在)。表本身归 Blender 侧解析。

// ===========================================================================
// 中性法线(无 KTX2 时 normal octave 恒等:白水法线叠加后与原来完全一致)
// ===========================================================================
let _neutralNormal: THREE.CanvasTexture | null = null;
export function getNeutralNormalTexture(): THREE.CanvasTexture {
  if (_neutralNormal) return _neutralNormal;
  const c = document.createElement('canvas');
  c.width = c.height = 4;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgb(128,128,255)';
  ctx.fillRect(0, 0, 4, 4);
  _neutralNormal = new THREE.CanvasTexture(c);
  _neutralNormal.wrapS = _neutralNormal.wrapT = THREE.RepeatWrapping;
  return _neutralNormal;
}
