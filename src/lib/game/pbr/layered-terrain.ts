// === 分层地形材质 (per user request: 层级贴图/分层材质混合) ===
// UE-style layered terrain: 4 PBR layers (sand/grass/rock/snow) blended by
// per-vertex splat weights, layered on top of the game's existing
// MeshStandardMaterial lighting pipeline (sun + hemisphere + shadows + fog)
// via onBeforeCompile injection — no custom lighting reimplementation.
//
// Why onBeforeCompile instead of a raw ShaderMaterial: shadow maps, IBL-ish
// hemisphere terms and fog are handled by the standard pipeline; a raw
// shader would have to reimplement all of it. We only replace the ALBEDO
// source (the layer blend) and keep the micro-relief normal/roughness/ao
// maps from the old terrain — the relief reads correctly on any layer.
//
// Splat weights are computed per-vertex by the terrain builder (height +
// slope + detail-noise jitter, mirroring the old vertex-colour zones) and
// uploaded as a custom `splat` vec4 attribute (x=sand y=grass z=rock w=snow).
// Layer albedo textures are 256² tileable canvases, shared by every chunk.

import * as THREE from 'three';
import { getTextureManager } from './texture-manager';
import { attachDeferredMode } from './materials';
import type { TuneMaterial } from '../terrain-tune';
// === MWAM 真实地形贴图 (per user request: MW Landscape Auto Material 移植) ===
// preset 决定 4 个 splat 槽位的 KTX2 图层名 + 平铺倍数;加载成败逐槽独立,
// 失败槽位保留下面的程序化画布,永不黑屏。
import {
  getMwamPreset,
  getMwamStyleCfg,
  getNeutralNormalTexture,
  loadMwamSlotTextures,
  sheetRoughness,
  LEGACY_SCALES,
  loadMwamNormalArray,
  type MwamPreset,
} from './terrain-mwam';

// === 程序化层 albedo v2 (per user request: 基础色贴图分布太单调/太假) ===
// 256² 可平铺画布改由 terrain-layer-textures.ts 生成(多尺度噪声场 + 逐层
// 材质性格 + 暖冷分离的加色色彩),再加一张极低频"宏观色调"图 —— 后者与
// splat 分带无关,专门解决"同海拔/同坡度的大面积是一块纯色"。
import { makeLayerAlbedoTexture, makeMacroTintTexture } from './terrain-layer-textures';

// three r185 normal_fragment_maps: tangent-space 分支的扰动行 —— 在其后
// 注入第二 octave(仍在本块作用域内,mapN/tbn/faceDirection 都可见)。
// ⚠ 注入锚一律打在 `#include <...>` **这一行**上, 不要打 chunk 正文。
// `onBeforeCompile` 在 three 的 `resolveIncludes` **之前**执行 —— 此刻 shader 里
// 还是 `#include <xxx>`, chunk 正文尚未替换进来, 所以 `includes('chunk 正文')`
// 恒为 false, 注入会**静默失效**。三处注入(层法线/层粗糙度/顶点 AO)原先都锚在
// 正文上, 因此从未生效 —— 隔壁工作树的 docs/blender-pipeline.md §7 第 3 条记录过
// 这同一类缺陷。锚 include 行、并把注入拼在 include 之后即可。
// 变量作用域没问题: GLSL 预处理分支不产生词法作用域, chunk 里声明的
// `tbn` / `mapN` / `roughnessFactor` 在 `#endif` 之后仍然可见。
const NORMAL_OCTAVE_ANCHOR = '#include <normal_fragment_maps>';

/** 全中性层法线数组(4 层 (128,128,255)): 数组没到位时兜底, 保证 sampler2DArray 始终有绑定。 */
let _neutralNrmArray: THREE.DataArrayTexture | null = null;
function neutralNormalArray(): THREE.DataArrayTexture {
  if (_neutralNrmArray) return _neutralNrmArray;
  const W = 4;
  const data = new Uint8Array(W * W * 4 * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = 128; data[i + 1] = 128; data[i + 2] = 255; data[i + 3] = 255; }
  const t = new THREE.DataArrayTexture(data, W, W, 4);
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  _neutralNrmArray = t;
  return t;
}

// 无遮罩时的默认 1×1 黑纹理(uMaskOn=0 时不会被采样,仅为避免空 uniform)。
let _defMaskTex: THREE.DataTexture | null = null;
function getDefaultMaskTexture(): THREE.Texture {
  if (!_defMaskTex) {
    _defMaskTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    _defMaskTex.needsUpdate = true;
  }
  return _defMaskTex;
}

export interface TerrainLayerColors {
  sand: THREE.Color;
  grass: THREE.Color;
  rock: THREE.Color;
  snow: THREE.Color;
}

// Tileable 256² layer albedo canvases now live in terrain-layer-textures.ts
// (multi-scale fields + per-layer character + warm/cool-separated colour, all
// seam-free by construction — see the tileability notes in that module).

/**
 * Build the shared layered-terrain material. `relief*` come from the terrain
 * builder's existing micro-relief set (normal/roughness/ao); `tileRepeat`
 * scales the layer albedo tiling (world units per texture repeat).
 * `terrainStyle` (mountain/desert/archipelago/…) selects the MWAM KTX2 layer
 * set — textures swap in asynchronously; absent/failed layers keep the
 * procedural canvas fallback (see terrain-mwam.ts).
 */
// 1×1 白贴图:未传外部 AO 时的 neutral(uniform 恒有值,uExtAoMode=0 不采样)。
const WHITE_TEX = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
WHITE_TEX.needsUpdate = true;
export function buildLayeredTerrainMaterial(opts: {
  mode: string;
  colors: TerrainLayerColors;
  reliefNormal: THREE.Texture;
  reliefRoughness: THREE.Texture;
  reliefAo: THREE.Texture;
  tileRepeat: number;
  terrainStyle?: string | null;
  /** terrain-tune / 地形编辑器覆盖(全部可选,缺省走现有常量) */
  materialTune?: TuneMaterial;
  /** Mask Splatting:遮罩贴图与覆盖范围(编辑器/游戏加载后传入) */
  maskTexture?: THREE.Texture | null;
  worldSize?: number;
  /** === 世界域烘焙光照图 (per 任务: Blender 光照贴图导入) ==========================
   * 单张 RGBA: R=AO, G=GI, B=太阳可见度, A=预留。**复用内置 aoMap 槽位**,
   * 贴图 channel=2 → three 按世界域 uv2 采样;G/B 在 aomap_fragment 之后用
   * **同一个** aoMap 采样器 + vAoMapUv 注入 → 净增 0 个纹理单元。
   * 地形材质贴着 MAX_TEXTURE_IMAGE_UNITS, 这条是硬约束(见 docs/blender-import-workflow.md)。 */
  bakeMap?: THREE.Texture | null;
  bakeStrengths?: { ao?: number; gi?: number; shadow?: number };
  /** bakeMap 是**单通道 AO 灰图**(旧 Gaea AOExport 语义)而非打包图:
   *  此时只当 R 用, 不注入 G/B。缺省: 只传 externalAo 时为 true, 传 bakeMap 时为 false。 */
  bakeIsAoOnly?: boolean;
  /** === Gaea 外部顶点色远/近混合 (per user request) ===
   * 远景直接显示导入顶点色(稳定不闪);近景随距离平滑切换到「遮罩选层
   * 高清细节 × 顶点色/规范色 色彩校正」;缺省 = 关闭(现有地形零回归)。 */
  externalVertex?: {
    /** 顶点色 8-bit RGBA 世界色图(与 mask 同坐标/分辨率) */
    tex: THREE.Texture;
    /** 规范色卡 RGB 0..1 ×4(低地/草/岩/雪),与 classify 同序 */
    canonical: [number, number, number][];
    mixNear: number;
    mixFar: number;
    /** === 色图亮度增益 (per user request: Gaea 基础色太亮 → 0.72) ===
     * 乘在色图 RGB 上(两个分支都生效)。做成 uniform 而不是重烘贴图 ——
     * 迭代成本低, 且可用控制台/编辑器实时调。缺省 1 = 零回归。 */
    gain?: number;
  };
  /** === 外部法线贴图(per user request: Gaea 高度场烘焙,tangent-space) ===
   * 提供后替换程序 relief 法线(仅 custom 全盘 Gaea 关传入,零回归)。 */
  normalMap?: THREE.Texture | null;
  /** === 外部环境光遮蔽(per user request: PBR 四贴图完整支持) ===
   * 与色图同世界域(±size/2,1:1)的 AO 灰图;全盘 Gaea 关传入后按世界 uv
   * 采样乘到间接光(ambientOcclusion 之上),程序关缺省 → 零回归。 */
  externalAo?: THREE.Texture | null;
}): THREE.MeshStandardMaterial {
  const mgr = getTextureManager();
  const aniso = mgr.anisotropy;
  const tune = opts.materialTune;
  // === MWAM preset:4 个槽位 = 低地/植被带/岩带/雪线带(与 splat.xyzw 对应) ===
  const mwamPreset = getMwamPreset(opts.terrainStyle ?? null);
  // 平铺倍数:有 preset 用贴图层各自的 scale,否则沿用历史 1.0/1.3/1.7/1.0
  // (写进 uniform,升级/换层不动 shader 即可改密度)。tune.slotScales 覆盖。
  const presetScales: [number, number, number, number] = mwamPreset
    ? [mwamPreset.slots[0].scale, mwamPreset.slots[1].scale, mwamPreset.slots[2].scale, mwamPreset.slots[3].scale]
    : LEGACY_SCALES;
  const layerScales: [number, number, number, number] = tune?.slotScales ?? presetScales;
  // === PBR 层参数(per user request):每槽 roughness 标量 ===
  // 无 preset(纯画布路径)时全槽 = 材质 base roughness(.95) → 注入后与
  // 原渲染逐位一致(roughnessFactor = Σw·r,权重和归一)。
  // tune.sheetRough 按贴图层名覆盖 SHEET_ROUGHNESS。
  const roughOf = (sheet: string | undefined): number => {
    const base = mwamPreset ? sheetRoughness(sheet) : 0.95;
    if (sheet && tune?.sheetRough && tune.sheetRough[sheet] !== undefined) return tune.sheetRough[sheet];
    return base;
  };
  const layerRough: [number, number, number, number] = mwamPreset
    ? [
        roughOf(mwamPreset.slots[0].sheet),
        roughOf(mwamPreset.slots[1].sheet),
        roughOf(mwamPreset.slots[2].sheet),
        roughOf(mwamPreset.slots[3].sheet),
      ]
    : [0.95, 0.95, 0.95, 0.95];
  // §356 回退: 8 层数组材质路径(KTX2 sampler2DArray albedo/ORM + 材质表驱动的
  //   逐层平铺/旋转/权重通道)已从**游戏运行期移除** —— 只留给 Blender/资产管线
  //   (public/config/terrain-materials.json + public/textures/ktx2/terrain/** 仍在盘上)。
  //   为什么: 那套是"运行时逐像素做 8 层混合",与本项目方向冲突(混合在 Blender 里做完,
  //   游戏只贴最终烘好的图), 且它会把片元纹理单元推向 MAX_TEXTURE_IMAGE_UNITS(16) 上限 ——
  //   一超限 MeshStandardMaterial 编译失败, 症状就是"地表完全不画只剩 skirt"。
  //   现在地表材质**只有一条路**: 下面这套旧的 4 槽 uLayer0..3(逐槽 KTX2 升级/画布兜底)。

  // === 高度图 AO 强度(per user request):按风格,画布路径 = 0(零回归) ===
  // tune.macroAO >= 0 覆盖风格表(-1 = 跟随风格表)。
  const styleAo = mwamPreset ? (getMwamStyleCfg(opts.terrainStyle)?.aoStrength ?? 0) : 0;
  const macroAo = tune?.macroAO !== undefined && tune.macroAO >= 0 ? tune.macroAO : styleAo;

  // === 烘焙光照图: 决定"只在 R 通道(AO)用"还是"R/G/B 三通道都用" ==========
  // 定义得早, 因为下面的 macroAoFinal 依赖 bakeOn。
  // bakeExtra 为真才注入 G/B —— 只当 AO 用时**不新增任何 uniform/采样器**,
  // 保持采样器预算与历史行为逐位一致(地形材质贴着 MAX_TEXTURE_IMAGE_UNITS)。
  const bakeTex = opts.bakeMap ?? null;
  const bakeOn = !!bakeTex;
  const bakeIsAo = opts.bakeIsAoOnly ?? false;
  const bakeStrengths = opts.bakeStrengths ?? {};
  const bakeAoVal = bakeOn ? (bakeStrengths.ao ?? 1) : undefined;
  const bakeGiVal = bakeOn && !bakeIsAo ? (bakeStrengths.gi ?? 1) : 0;
  const bakeShadowVal = bakeOn && !bakeIsAo ? (bakeStrengths.shadow ?? 0) : 0;
  // B(太阳可见度)默认 0:实时阴影已在跑, 再叠一层大尺度烘焙投影会双重变暗。
  const bakeExtra = bakeOn && !bakeIsAo && (bakeGiVal > 0 || bakeShadowVal > 0);
  // === 有烘焙 AO 时关掉逐顶点高度图 AO (per 任务: 避免双重变暗) ===
  // 两者语义重复(都在压间接光), 叠乘会让山谷/背光面偏黑。显式给了 macroAO 时
  // 仍以用户为准 —— 这条让"为什么关了"留痕在执行处。
  const macroAoFinal = bakeOn && !(tune?.macroAO !== undefined && tune.macroAO >= 0) ? 0 : macroAo;
  // tileRepeat / 湿地面 / 法线强度:tune 覆盖代码常量
  const tileRepeatFinal = tune?.tileSize ? 1 / tune.tileSize : opts.tileRepeat;
  const wetTintVal = tune?.wetTint ?? 0.72;
  const wetLevelVal = tune?.wetLevel ?? 5.0;
  const normalScaleVal = tune?.normalScale ?? 0.6;
  // === 岩层材质修正 (per user request: 远景岩层一片深蓝/贴图不显) ===
  // KTX2/画布岩层 albedo 偏暗偏蓝 → 对「岩带权重」施加乘性校正
  // (默认提亮去蓝;tune.material.rockBoost 可覆盖;只影响岩槽)。
  const rockBoostVal = tune?.rockBoost
    ? new THREE.Vector3(tune.rockBoost[0], tune.rockBoost[1], tune.rockBoost[2])
    : new THREE.Vector3(1.18, 1.09, 0.98);
  // === Gaea 外部顶点色远/近(per user request;缺省 null = 关闭零回归) ===
  const extVtx = opts.externalVertex ?? null;
  // === Mask Splatting(per user request: 自动分层 ↔ 遮罩) ===
  // maskTexture + materialTune.maskMode → 逐像素读遮罩;否则顶点 splat。
  const maskModeFinal = !!(opts.maskTexture && tune?.maskMode);
  const worldSizeMask = opts.worldSize ?? 50000;
  const maskTexVal = opts.maskTexture ?? getDefaultMaskTexture();
  // 程序化画布(每槽 albedo:多尺度场 + 逐层材质性格),KTX2 缺失时的兜底。
  const layers = [
    makeLayerAlbedoTexture(opts.colors.sand, opts.mode, 'sand', 0),
    makeLayerAlbedoTexture(opts.colors.grass, opts.mode, 'grass', 1),
    makeLayerAlbedoTexture(opts.colors.rock, opts.mode, 'rock', 2),
    makeLayerAlbedoTexture(opts.colors.snow, opts.mode, 'snow', 3),
  ];
  for (const t of layers) {
    mgr.track(t);
    t.anisotropy = Math.max(t.anisotropy, aniso);
  }
  // === 宏观色调图(第 5 张;与 splat 分带无关的低频色彩变化) ===
  // 周期 = 1/uMacroTintScale 世界单位 ×2 个八度。程序化地图专用:
  // Gaea 全盘模式(uMixFar<=0)下色调在 shader 里被覆盖,天然 no-op。
  const macroTint = makeMacroTintTexture(opts.mode);
  mgr.track(macroTint);
  macroTint.anisotropy = Math.max(macroTint.anisotropy, aniso);
  // 每槽法线初始为"中性法线"(0,0,1):Whiteout 叠加后与原渲染逐位一致,
  // KTX2 法线加载成功后逐槽替换 —— 升级前后视觉连续。
  const neutralNormal = getNeutralNormalTexture();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: false,
    // === 外部法线贴图(per user request: Gaea 导入关法线) ===
    // custom/全盘 Gaea 关由 001 高度场烘焙的 normal.png 提供表面法线
    // (与几何/色图同源,近景不发虚);未提供 → 程序 micro-relief 照旧。
    normalMap: opts.normalMap ?? opts.reliefNormal,
    normalScale: new THREE.Vector2(normalScaleVal, normalScaleVal),
    // === 基础粗糙度 0.95 → 0.72 (per user request: 放大粗糙度贴图在太阳照射下的效果) ===
    // 0.95 几乎是纯漫反射(高光只剩一丝), 所以地形在太阳下"怎么转都没有反光", 层与层
    // 之间也看不出差别。降到 0.72 让介质高光(F0=0.04)真正出现一个可见的光斑带,
    // 微起伏 roughnessMap 与下面的层 roughness 再在这个基线上做变化。
    roughness: 0.72,
    roughnessMap: opts.reliefRoughness,
    // === 烘焙光照图复用 aoMap 槽位 (per 任务: Blender 光照贴图导入) ===
    // R 通道(= AO)由 three 内置 aoMap 管线消费; G/B 在下面 onBeforeCompile 里
    // 用同一个采样器注入。有烘焙图时强度由 tune 的 bakeAO 决定, 否则维持历史值 0.7。
    aoMap: bakeOn ? bakeTex : opts.reliefAo,
    aoMapIntensity: bakeOn ? (bakeAoVal ?? 1) : 0.7,
    metalness: 0.0,
    flatShading: false,
  });
  // aoMap 用 channel 2 → three 生成 `#define AOMAP_UV uv2`, 内置 AO 管线按世界域
  // 采样; 我们注入的 GI/太阳通道也采样同一个 aoMap + vAoMapUv。
  // ⚠ channel 必须在**创建期**设定: WebGLPrograms.getParameters 早于
  //   onBeforeCompile 读 material.aoMap.channel 去生成 AOMAP_UV / USE_UV2 ——
  //   在 onBeforeCompile 里改已经太晚。
  if (bakeOn && bakeTex) bakeTex.channel = 2;
  mat.userData.pbrSet = `terrain/layered/${opts.mode}`;
  mat.userData.debugTag = 'terrain:layered';
  // === 当前槽位纹理(单点真值源) ===
  // 初始 = 画布 albedo + 中性法线;KTX2 升级后逐槽替换。重编译时
  // onBeforeCompile 从这里恢复,保证延迟模式等重编译不丢已升级贴图。
  mat.userData._mwamTex = {
    albedo: [...layers],
    normal: [neutralNormal, neutralNormal, neutralNormal, neutralNormal],
  };
  // === Mask Splatting 权威状态(编辑器切换模式/绑贴图时改写 + needsUpdate) ===
  mat.userData._maskState = { on: maskModeFinal ? 1 : 0, tex: maskTexVal };

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uLayer0 = { value: layers[0] };
    shader.uniforms.uLayer1 = { value: layers[1] };
    shader.uniforms.uLayer2 = { value: layers[2] };
    shader.uniforms.uLayer3 = { value: layers[3] };
    // === MWAM 升级槽位:每槽 albedo(画布→KTX2)独立可换,还有法线通道。
    // 重新编译(如延迟模式开关)时从 userData._mwamTex 恢复已升级贴图。
    const cur = mat.userData._mwamTex as
      | { albedo: THREE.Texture[]; normal: THREE.Texture[] } | undefined;
    // === 层法线: 4 个 sampler2D -> 1 个 sampler2DArray (per 采样器预算) ============
    // 这是本材质唯一一处"净省采样器"的改动: 4 张层法线原本要 4 个纹理单元, 而它正是
    // "层法线 octave 一直被禁"的原因(14 -> 18 超限)。数组化后只占 1 个, 净省 3。
    // 数组还没到位时用"全中性数组"兜底 + uLayerNrmArrOn=0 ⇒ octave 自门禁不执行,
    // 观感与未启用时逐位一致(不会因为这次改动而变样)。
    const nrmArr = (mat.userData._mwamNormalArray as THREE.Texture | undefined) ?? neutralNormalArray();
    shader.uniforms.uLayerNrmArr = { value: nrmArr };
    shader.uniforms.uLayerNrmArrOn = { value: nrmArr === neutralNormalArray() ? 0 : 1 };
    void neutralNormal;
    shader.uniforms.uLayerScale0 = { value: layerScales[0] };
    shader.uniforms.uLayerScale1 = { value: layerScales[1] };
    shader.uniforms.uLayerScale2 = { value: layerScales[2] };
    shader.uniforms.uLayerScale3 = { value: layerScales[3] };
    // §356 回退: 8 层数组通道(uLayerAlbArr/uLayerOrmArr/uLayerCnt/uLayerTile/uLayerRot/
    //   uLayerWch/uLayerRoughA/uRegionMask)整块移除 —— 连 uniform 都不再挂, 保证运行期
    //   不存在任何数组采样器/资产的触碰。地表只走下面的 4 槽标量。
    // 采样器账目(供控制台/验证脚本断言; 超 16 会整片不画)
    mat.userData.samplers = { layers: 4, normalArr: 1, ormArr: 0, region: 0 };
    // === PBR:层 roughness + 高度图 AO uniform ===
    shader.uniforms.uLayerRough0 = { value: layerRough[0] };
    shader.uniforms.uLayerRough1 = { value: layerRough[1] };
    shader.uniforms.uLayerRough2 = { value: layerRough[2] };
    shader.uniforms.uLayerRough3 = { value: layerRough[3] };
    shader.uniforms.uMacroAO = { value: macroAoFinal };
    if (bakeExtra) {
      shader.uniforms.uBakeGI = { value: bakeGiVal };
      shader.uniforms.uBakeShadow = { value: bakeShadowVal };
    }
    // === Mask Splatting uniform ===
    // 权威状态在 mat.userData._maskState(on/tex) —— 编辑器切换遮罩/绑定贴图
    // 时改状态 + material.needsUpdate,重编译后这里读到最新值;动态改 uniform
    // 引用在多 program 变体下不可靠(捕获的可能不是主渲染变体)。
    const ms = mat.userData._maskState as { on: number; tex: THREE.Texture } | undefined;
    shader.uniforms.uMask = { value: ms?.tex ?? maskTexVal };
    shader.uniforms.uMaskOn = { value: ms?.on ?? (maskModeFinal ? 1 : 0) };
    shader.uniforms.uMaskHalf = { value: new THREE.Vector2(worldSizeMask / 2, worldSizeMask / 2) };
    shader.uniforms.uMaskInvSize = { value: new THREE.Vector2(1 / worldSizeMask, 1 / worldSizeMask) };
    // albedo 的 KTX2 也要在重编译后接回 —— 统一从 userData 恢复。
    const albCur = cur?.albedo;
    if (albCur) {
      shader.uniforms.uLayer0.value = albCur[0];
      shader.uniforms.uLayer1.value = albCur[1];
      shader.uniforms.uLayer2.value = albCur[2];
      shader.uniforms.uLayer3.value = albCur[3];
    }
    // 记录当前 uniform 对象(供异步升级换 .value + 后续恢复)。
    mat.userData._mwamUniforms = {
      albedo: [shader.uniforms.uLayer0, shader.uniforms.uLayer1, shader.uniforms.uLayer2, shader.uniforms.uLayer3],
      normalArray: shader.uniforms.uLayerNrmArr,
      normalArrayOn: shader.uniforms.uLayerNrmArrOn,
    };
    // === tilesize 命令 (per user request: 控制台实时调地形纹理缩放) ===
    // Expose the repeat uniform so engine.setTerrainTileSize() can retune it
    // at runtime — every terrain chunk shares this material.
    shader.uniforms.uLayerRepeat = { value: tileRepeatFinal };
    mat.userData._uLayerRepeat = shader.uniforms.uLayerRepeat;
    shader.uniforms.uWetTint = { value: wetTintVal }; // low-ground darkening
    shader.uniforms.uWetLevel = { value: wetLevelVal };
    // === 宏观色调(第 5 张;程序化地图专用) ===
    // uMacroTintScale = 1 / 世界单位周期(uLayerRepeat 同量纲):默认 0.5m⁻¹
    // → 第一八度 ~2048 世界单位、第二八度(×2)~1024 世界单位。设 0 关闭。
    shader.uniforms.uMacroTint = { value: macroTint };
    shader.uniforms.uMacroTintScale = { value: 1 / 2048 };
    mat.userData._uMacroTintScale = shader.uniforms.uMacroTintScale;
    shader.uniforms.uRockBoost = { value: rockBoostVal }; // 岩层提亮去蓝
    // === Gaea 外部顶点色远/近 uniform (uVtxMode=0 → 全关零回归) ===
    shader.uniforms.uVtxMode = { value: extVtx ? 1 : 0 };
    shader.uniforms.uVtxTex = { value: extVtx?.tex ?? getDefaultMaskTexture() };
    shader.uniforms.uMixNear = { value: extVtx?.mixNear ?? 1400 };
    shader.uniforms.uMixFar = { value: extVtx?.mixFar ?? 3400 };
    // === Gaea 外部 AO 采样器已移除 (per fix: 片元纹理单元超 16 上限) ===
    // 症状: "FRAGMENT shader texture image units count exceeds
    // MAX_TEXTURE_IMAGE_UNITS(16)" → 地形材质编译失败 → 地表完全不画, 只剩 skirt
    // 裙边切面(用户描述为"只剩分割 LOD 的格子")。项目档案 §38/§39 也记录过同族症状。
    // 根因: 这个材质原本就在上限上跑 —— 4 层 albedo + 4 层 layer 法线 + 外部
    // normalMap + 外部 roughnessMap + 外部 aoMap + uMask = 16, 而 16 正是 WebGL2
    // 的**保证下限**(很多 GPU 恰好给 16)。所以任何净增 1 个采样器都会编译失败。
    // 取舍: uExtAo 只喂 gExtAo, 而 gExtAo 只在一个分支里被消费(全盘模式算完即丢),
    // 所以它是唯一可以"整块拿掉而不损失有效功能"的采样器 —— 删它换回 1 个余量,
    // 让新增的 uVtxTex(程序化基础色)/uMacroTint(低频色调)得以保留。
    shader.uniforms.uVtxGain = { value: extVtx?.gain ?? 1 };
    const canon = extVtx?.canonical ?? [[0.72, 0.66, 0.47], [0.27, 0.38, 0.18], [0.52, 0.47, 0.42], [0.95, 0.97, 0.98]];
    shader.uniforms.uCanon0 = { value: new THREE.Vector3(canon[0][0], canon[0][1], canon[0][2]) };
    shader.uniforms.uCanon1 = { value: new THREE.Vector3(canon[1][0], canon[1][1], canon[1][2]) };
    shader.uniforms.uCanon2 = { value: new THREE.Vector3(canon[2][0], canon[2][1], canon[2][2]) };
    shader.uniforms.uCanon3 = { value: new THREE.Vector3(canon[3][0], canon[3][1], canon[3][2]) };
    // === 编辑器实时调参句柄 (per user request: 地形编辑器实时调参) ===
    // 地形编辑器 / 控制台可直接改这些 uniform 的 .value,无需重建地形。
    mat.userData._tuneUniforms = {
      uLayerRepeat: shader.uniforms.uLayerRepeat,
      uWetTint: shader.uniforms.uWetTint,
      uWetLevel: shader.uniforms.uWetLevel,
      uMacroAO: shader.uniforms.uMacroAO,
      uRockBoost: shader.uniforms.uRockBoost,
      scales: [shader.uniforms.uLayerScale0, shader.uniforms.uLayerScale1, shader.uniforms.uLayerScale2, shader.uniforms.uLayerScale3],
      rough: [shader.uniforms.uLayerRough0, shader.uniforms.uLayerRough1, shader.uniforms.uLayerRough2, shader.uniforms.uLayerRough3],
      // === Mask Splatting:编辑器实时切换自动↔遮罩 / 换遮罩贴图 ===
      mask: { on: shader.uniforms.uMaskOn, tex: shader.uniforms.uMask },
      // === Gaea 外部顶点色远/近(实时改混合距离/开关/亮度) ===
      external: {
        mode: shader.uniforms.uVtxMode,
        tex: shader.uniforms.uVtxTex,
        mixNear: shader.uniforms.uMixNear,
        mixFar: shader.uniforms.uMixFar,
        gain: shader.uniforms.uVtxGain,
      },
    };

    // --- vertex: custom `splat` + `ao` attributes, world position ---
    // ao = 高度图烘焙的环境光遮蔽(0..1,中性=1),供 aomap 注入处压间接光。
    shader.vertexShader =
      'attribute vec4 splat;\nattribute float ao;\nvarying vec4 vSplat;\nvarying float vAo;\nvarying vec3 vWorldPos;\n' +
      shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      'void main() {',
      'void main() {\n  vSplat = splat;\n  vAo = ao;\n  vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;',
    );

    // --- fragment: blend the layers into the albedo + layer normal octave ---
    // ⚠ 采样器预算: 数组模式与旧 4 槽模式**必须编译期二选一**(不能用运行期 if/else)!
    //   实测: 只把新路径写进 if 分支、旧的 4 个 uLayer0..3 留在 else 里 ⇒ 编译器**照样绑定**
    //   那 4 个单元(它们仍是活跃引用), 于是 4(旧) + 4(新数组+ORM+区域) 直接顶爆 16,
    //   症状就是 "FRAGMENT shader texture image units count exceeds MAX_TEXTURE_IMAGE_UNITS(16)"
    //   → MeshStandardMaterial 编译失败 → 地表完全不画只剩 skirt(项目档案 §38/§39 同族事故)。
    shader.fragmentShader =
      'uniform sampler2D uLayer0;\nuniform sampler2D uLayer1;\n'
        + 'uniform sampler2D uLayer2;\nuniform sampler2D uLayer3;\n' +
      // 层法线采样器(octave 开启时才真正采样)。注意: 实测即使不声明它们,
      // 地形材质仍然贴着 MAX_TEXTURE_IMAGE_UNITS —— 说明这四个**本来就被编译器
      // 剪掉了**, 不是预算的占用者。所以省声明解决不了采样器紧张的问题。
      // 层法线: 一个 sampler2DArray 顶四张(层序 = 槽0..3), 另配一个开关 uniform
      'uniform sampler2DArray uLayerNrmArr;\nuniform float uLayerNrmArrOn;\n' +
      // §356 回退: 8 层数组的采样器声明(uLayerAlbArr/uLayerOrmArr/uLayerTile/uLayerRot/
      //   uLayerWch/uLayerRoughA/uRegionMask)已删除。这些**声明**本身就会占片元纹理单元:
      //   实测只声明不用也会把单元数顶过 MAX_TEXTURE_IMAGE_UNITS(16) ⇒ 材质编译失败
      //   ⇒ 地表完全不画。所以回退必须连声明一起删, 一个字符都不留。
      'uniform float uLayerRepeat;\nuniform float uLayerScale0;\nuniform float uLayerScale1;\n' +
      'uniform float uLayerScale2;\nuniform float uLayerScale3;\n' +
      'uniform float uLayerRough0;\nuniform float uLayerRough1;\n'
        + 'uniform float uLayerRough2;\nuniform float uLayerRough3;\n' +
      'uniform float uMacroAO;\n' +
      // === 世界域烘焙通道 (per 任务: Blender 光照贴图导入) ===
      // G/B 复用下面已声明的 aoMap 采样器 + vAoMapUv, **不新增采样器**。
      (bakeExtra ? 'uniform float uBakeGI;\nuniform float uBakeShadow;\n' : '') +
      'uniform float uWetTint;\nuniform float uWetLevel;\n' +
      // === 宏观色调(与 splat 分带无关的低频色彩变化) ===
      'uniform sampler2D uMacroTint;\nuniform float uMacroTintScale;\n' +
      'uniform vec3 uRockBoost;\n' +
      // === Gaea 外部顶点色远/近 (per user request;uVtxMode=0 全关零回归) ===
      'uniform float uVtxMode;\nuniform sampler2D uVtxTex;\n' +
      'uniform float uMixNear;\nuniform float uMixFar;\n' +
      // 色图亮度增益(默认 1;custom 图设 0.72 压亮)
      'uniform float uVtxGain;\n' +
      // 注: Gaea 外部 AO 采样器(uExtAo/uExtAoMode)已移除 —— 见 uniforms 处的说明,
      // 它让片元纹理单元从 16 顶到 17, 超过 MAX_TEXTURE_IMAGE_UNITS(16) 导致
      // 地形材质编译失败(地表不画、只剩 skirt)。
      'uniform vec3 uCanon0;\nuniform vec3 uCanon1;\nuniform vec3 uCanon2;\nuniform vec3 uCanon3;\n' +
      // === Mask Splatting(per user request: 自动分层 ↔ 遮罩) ===
      // uMask = RGBA 遮罩(R/G/B/A = 低地/草/岩/雪),uMaskOn>0.5 时逐像素
      // 读遮罩作为权重(归一化),否则用顶点 splat(自动分层)。
      'uniform sampler2D uMask;\nuniform float uMaskOn;\n' +
      'uniform vec2 uMaskHalf;\nuniform vec2 uMaskInvSize;\n' +
      'varying vec4 vSplat;\nvarying float vAo;\nvarying vec3 vWorldPos;\n' +
      `vec4 terrainWeights() {
        vec4 w = vSplat;
        if ( uMaskOn > 0.5 ) {
          vec2 muv = ( vWorldPos.xz + uMaskHalf ) * uMaskInvSize;
          vec4 m = texture2D( uMask, muv );
          float ms = m.x + m.y + m.z + m.w;
          w = m / max( ms, 1e-4 );
        }
        return w;
      }
      // §356 回退: 8 层数组采样函数(layRot/layWeight/layWeights/layAlbedo/layRough)
      //   整段删除 —— 它们引用数组 uniform, 留着就是"白占纹理单元"。
` +
      shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      'vec4 diffuseColor = vec4( diffuse, opacity );',
      `vec4 diffuseColor = vec4( diffuse, opacity );
      // === 分层地形 splat 混合 (per user request: 层级贴图) ===
      // MWAM 升级后 uLayer0..3 是 KTX2 真实贴图,否则仍是 256² 画布;
      // 每槽独立平铺倍数(uLayerScaleN)写入 uniform,与画布时代观感一致。
      {
        vec4 wS = terrainWeights();
        vec2 layUv = vWorldPos.xz * uLayerRepeat;
        // §356 回退: 这里是唯一的 albedo 混合, 恒为旧的 4 槽路径(数组分支已删)。
        vec3 alb = texture2D( uLayer0, layUv * uLayerScale0 ).rgb * wS.x
                 + texture2D( uLayer1, layUv * uLayerScale1 ).rgb * wS.y
                 + texture2D( uLayer2, layUv * uLayerScale2 ).rgb * wS.z
                 + texture2D( uLayer3, layUv * uLayerScale3 ).rgb * wS.w;
        // 岩层提亮去蓝(per user request):只对岩带权重生效,越纯岩效果越足
        alb *= mix( vec3( 1.0 ), uRockBoost, wS.z );
        // === 宏观色调 (per user request: 同带大面积一块纯色) ===
        // 与 splat 分带**无关**的低频色彩变化:同一海拔/坡度的区域也会有
        // 宽域的明暗 + 冷暖摆动(大尺度 1:1 采样 + ×2 尺度 0.45 权重)。
        // 画布以 128 = 乘数 1.0 编码(NoColorSpace,不做 sRGB 解码)。
        // 实测(256² 画布统计):R x0.86..x1.00、B x0.99..x1.11,均值
        // 约 x0.90/x0.91/x1.07 —— 带宽被截断在 ±1 导致均值略偏冷暗,
        // 相当于对程序化地表整体压暗约 10% 并同时获得冷暖摆动(这正是
        // 之前"平亮假"的补充);Gaea 全盘模式下 alb 随即被色图覆盖 →
        // 对 custom 地图 no-op。uMacroTintScale<=0 可整体关闭。
        if ( uMacroTintScale > 0.0 ) {
          vec2 tuv = vWorldPos.xz * uMacroTintScale;
          vec3 tint = ( texture2D( uMacroTint, tuv ).rgb * 2.0 - 1.0 )
                    + ( texture2D( uMacroTint, tuv * 2.0 ).rgb * 2.0 - 1.0 ) * 0.45;
          alb *= 1.0 + tint * 0.5;
        }
        // === Gaea 外部顶点色远/近 (per user request) ===
        // 远(>=uMixFar)≈导入顶点色(稳定);近(<=uMixNear)= 细节贴图 ×
        // 顶点色/规范色 校正(颜色连续、材质细节全开);中间 smoothstep 过渡。
        // uMixFar<=0 → "Gaea 全盘模式"(custom 导入关):地表恒 = 色图,
        // 程序化分层/顶点 splat 对颜色不参与(smoothstep 无定义区规避)。
        if ( uVtxMode > 0.5 ) {
          vec2 vuv2 = ( vWorldPos.xz + uMaskHalf ) * uMaskInvSize;
          // 外部 AO 采样已移除(省 1 个纹理单元, 见 uniforms 处说明)。
          vec3 vc = texture2D( uVtxTex, vuv2 ).rgb;
          if ( uMixFar <= 0.0 ) {
            // === Gaea 全盘模式(custom 导入关):地表恒 = Gaea 色图 ===
            // 程序分层/顶点 splat/湿暗 全部不参与颜色 —— 颜色 100% Gaea。
            // uVtxGain:色图整体亮度增益(per user request: Gaea 基础色太亮 → 0.72)。
            alb = vc * uVtxGain;
          } else {
            float vdist = length( vWorldPos - cameraPosition );
            float nearF = smoothstep( uMixNear, uMixFar, vdist );
            vec3 canon = wS.x * uCanon0 + wS.y * uCanon1 + wS.z * uCanon2 + wS.w * uCanon3;
            vec3 corr = clamp( vc / ( canon + 1e-3 ), 0.35, 2.4 );
            alb = mix( alb * corr, vc * uVtxGain, nearF );
            // Wet low-ground darkening (非全盘模式才生效)。
            if ( vWorldPos.y < uWetLevel ) {
              alb *= mix( 1.0, uWetTint, clamp( 1.0 - vWorldPos.y / uWetLevel, 0.0, 1.0 ) );
            }
          }
        } else {
          // Wet low-ground darkening (程序化地图,历史行为不变)。
          if ( vWorldPos.y < uWetLevel ) {
            alb *= mix( 1.0, uWetTint, clamp( 1.0 - vWorldPos.y / uWetLevel, 0.0, 1.0 ) );
          }
        }
        diffuseColor.rgb *= clamp( alb, 0.0, 1.0 );
      }`,
    );
    // === MWAM 层法线 octave(仿 MWAM MF_MWAM_CombineNormal) ===
    // 内置 relief 法线扰动之后,再按 splat 权重混合四张层法线做第二层
    // 扰动。层法线用 Whiteout 近似与 mapN 合并(仍走同一个 tbn 旋转)。
    // 未升级时层法线 = 中性(0,0,1),Whiteout 结果与升级前逐位一致。
    const NORMAL_OCTAVE = `#include <normal_fragment_maps>
      if ( uLayerNrmArrOn > 0.5 ) {
        vec4 wS = terrainWeights();
        vec2 layUv = vWorldPos.xz * uLayerRepeat;
        // §356 回退: 只留旧的常量层号 4 槽采样(数组 8 层循环已删)。
        vec3 ln = ( texture2D( uLayerNrmArr, vec3( layUv * uLayerScale0, 0.0 ) ).xyz * 2.0 - 1.0 ) * wS.x
             + ( texture2D( uLayerNrmArr, vec3( layUv * uLayerScale1, 1.0 ) ).xyz * 2.0 - 1.0 ) * wS.y
             + ( texture2D( uLayerNrmArr, vec3( layUv * uLayerScale2, 2.0 ) ).xyz * 2.0 - 1.0 ) * wS.z
             + ( texture2D( uLayerNrmArr, vec3( layUv * uLayerScale3, 3.0 ) ).xyz * 2.0 - 1.0 ) * wS.w;
        float wsum = wS.x + wS.y + wS.z + wS.w;
        if ( wsum > 1e-4 ) {
          ln = normalize( ln );
          vec3 comb = normalize( vec3( mapN.xy + ln.xy, max( mapN.z * ln.z, 0.0 ) ) );
          normal = normalize( tbn * comb );
        }
      }`;
    if (shader.fragmentShader.includes(NORMAL_OCTAVE_ANCHOR)) {
      // === 层法线 octave: 暂不注入(采样器预算) ==============================
      // 这三处注入原先都锚在 chunk 正文上 → 从未生效。修锚点时发现三者代价不同:
      //   · 顶点 AO   只用 uMacroAO(float)+vAo(varying) → 净增 0 采样器 ✓ 已启用
      //   · 层粗糙度  只用 uLayerRough0..3(float)       → 净增 0 采样器 ✓ 已启用
      //   · 层法线 octave 要 4 个 uLayerNrm 采样器       → +4 → 顶爆纹理单元 ✗
      // 实测: 修好锚点后 4 个 uLayerNrm 从"声明但未使用(被编译器剪掉)"变成实际使用,
      // 片元采样器 14 → 18 > MAX_TEXTURE_IMAGE_UNITS(16) →
      // "FRAGMENT shader texture image units count exceeds MAX_TEXTURE_IMAGE_UNITS(16)"
      // → 材质 VALIDATE_STATUS false。地形材质长期贴着这个上限, 项目档案里有过
      // "顶到 17 → 地表完全不画只剩 skirt" 的事故(见 docs/blender-import-workflow.md §8)。
      // 所以层法线**必须先解决预算**再开, 两条路:
      //   a) 把 4 张层法线打包进一张图集(1 个采样器, 净省 3)—— 需改 terrain-mwam 载入端;
      //   b) 复用一个已绑定的通道(例如把层法线折进 albedo 图的 alpha)。
      // 在那之前保持关闭: 层法线未启用时语义等价于中性 (0,0,1), 与原观感一致。
      // === 层法线 octave 现已启用 (per 采样器预算已解决) ==========================
      // 原来这里是"直接跳过注入"——因为 4 个 uLayerNrm 独立采样器会把片元纹理单元顶到 18。
      // 现在层法线走 **sampler2DArray**(只占 1 个, 净省 3) ⇒ 可以注入了。
      // 注入始终进行, 是否生效由 uLayerNrmArrOn 决定: 数组没载入时 = 0 ⇒ 整段不执行 ⇒
      // 与"未启用"逐位一致(所以不存在"资产缺失就变样"的风险)。
      shader.fragmentShader = shader.fragmentShader.replace(NORMAL_OCTAVE_ANCHOR, NORMAL_OCTAVE);
      mat.userData._layerNormalSkipped = !(mat.userData._mwamNormalArray);
    } else if (!mat.userData._mwamWarned) {
      mat.userData._mwamWarned = true;
      console.warn('[terrain] MWAM normal-octave anchor not found — layer normals disabled (three version drift?)');
    }
    // === 高度图 AO(per user request):压间接光,直射/高光不动 ===
    // anchor 在 aomap_fragment(USE_AOMAP 恒开,地形 aoMap 常在)。
    // vAo 由 terrain-v2 逐顶点烘焙(中性=1 → uMacroAO×0 无影响)。
    const AO_INJ = '#include <aomap_fragment>';
    if (shader.fragmentShader.includes(AO_INJ)) {
      // === 世界域烘焙通道 (per 任务: Blender 光照贴图导入) ====================
      // AO(R 通道)已由 three 内置 aoMap 管线处理(同一张贴图 + aoMapIntensity)。
      // 这里复用**同一个** aoMap 采样器与 vAoMapUv(= channel 2 世界域 UV),
      // 因此不新增任何纹理单元 —— 地形材质贴着 MAX_TEXTURE_IMAGE_UNITS, 这是硬约束。
      //   G = GI(间接弹射系数, 1 = 全天空)  → 压间接光
      //   B = 太阳可见度(0 = 被遮挡)        → 压直接光(默认关, 见 bakeShadowVal)
      // 该 chunk 在 main() 里位于 lights_fragment_begin → maps → end **之后**,
      // 所以此处 directDiffuse / indirectDiffuse 均已累加完毕。
      const bakeInj = bakeExtra
        ? `
        {
          vec3 bk = texture2D( aoMap, vAoMapUv ).rgb;
          if ( uBakeGI > 0.0 ) reflectedLight.indirectDiffuse *= mix( 1.0, bk.g, uBakeGI );
          if ( uBakeShadow > 0.0 ) reflectedLight.directDiffuse *= mix( 1.0, bk.b, uBakeShadow );
        }`
        : '';
      shader.fragmentShader = shader.fragmentShader.replace(
        AO_INJ,
        `${AO_INJ}${bakeInj}
        reflectedLight.indirectDiffuse *= ( 1.0 - uMacroAO * ( 1.0 - vAo ) );`,
      );
    } else if (!mat.userData._mwamWarned) {
      mat.userData._mwamWarned = true;
      console.warn('[terrain] macro-AO anchor not found — AO disabled (three version drift?)');
    }
    // === PBR 层 roughness(per user request):Σ splat·uLayerRough_i ===
    // anchor 在 roughnessmap_fragment(无条件声明;随后若存在 relief 粗糙
    // 贴图仍会继续乘 texelRoughness.g)。权重和归一,画布路径全槽 = base
    // roughness → 与原渲染逐位一致。
    const ROUGH_ANCHOR = '#include <roughnessmap_fragment>';
    if (shader.fragmentShader.includes(ROUGH_ANCHOR)) {
      shader.fragmentShader = shader.fragmentShader.replace(
        ROUGH_ANCHOR,
        `${ROUGH_ANCHOR}
        {
          vec4 wS = terrainWeights();
          float rw = wS.x + wS.y + wS.z + wS.w;
          // §356 回退: 只留旧的 4 个逐槽粗糙度标量(数组 ORM 聚合已删)。
          float rr = wS.x * uLayerRough0 + wS.y * uLayerRough1
                   + wS.z * uLayerRough2 + wS.w * uLayerRough3;
          rr *= ( 1.0 / max( rw, 1e-4 ) );
          // === 层间差异放大 (per user request: 放大粗糙度在太阳下的效果) ===
          // 各 preset 的层粗糙度都是 0.9 附近的常量(UE Ground 集没有 roughness 贴图),
          // 直接混合出来几乎是同一个值 → 沙地/雪地/岩石/草地看起来一模一样。
          // 以 0.72 为基准做一次线性扩张: 比基准光滑的层更光滑(太阳下先出反光),
          // 比基准粗糙的层更粗糙 —— 高光带因此能"沿着地貌层"走出来。
          const float ROUGH_BASE = 0.72;
          const float ROUGH_SPREAD = 2.2;
          rr = clamp( ROUGH_BASE + ( rr - ROUGH_BASE ) * ROUGH_SPREAD, 0.08, 1.0 );
          roughnessFactor = mix( roughnessFactor, rr, min( rw, 1.0 ) );
        }`,
      );
    } else if (!mat.userData._mwamWarned) {
      mat.userData._mwamWarned = true;
      console.warn('[terrain] layer-roughness anchor not found — layer roughness disabled (three version drift?)');
    }
    // === 注入自检(每次材质编译打一行) =====================================
    // 这三处注入原先都锚在 ShaderChunk **正文**上, 而 onBeforeCompile 早于
    // resolveIncludes → `includes()` 恒为 false → 三处一起静默失效(层法线 /
    // 逐层粗糙度 / 顶点高度图 AO 从未生效)。已改成锚 `#include <...>` 行。
    // 留一行自检: 以后 three 升级让锚点漂移时能立刻看见, 不用靠"画面好像变平了"
    // 去猜。看到三个 ok 才算注入都在。
    if (!mat.userData._injectReported) {
      mat.userData._injectReported = true;
      const fs = shader.fragmentShader;
      const mark = (needle: string) => (fs.includes(needle) ? 'ok' : 'MISS');
      const report = {
        // 层法线 octave 是**刻意关闭**的: 它要 4 个采样器, 会顶爆纹理单元上限。
        // 详见上面 NORMAL_OCTAVE 处的说明。
        layerNormal: 'skipped(sampler budget)',
        layerRough: mark('roughnessFactor = mix( roughnessFactor, rr'),
        vertexAo: mark('uMacroAO * ( 1.0 - vAo )'),
        // 世界域烘焙光照图: none / ao-only(R 通道当 AO) / packed(G/B 注入已生效)
        bake: !bakeOn ? 'none' : (bakeExtra ? `packed(gi=${bakeGiVal},sun=${bakeShadowVal})` : 'ao-only'),
      };
      // 同时挂到 window —— 无头验收时直接读它, 不必依赖控制台输出。
      (window as unknown as { __terrainInject?: unknown }).__terrainInject = report;
      console.log('[terrain] 注入自检:'
        + ` 层法线=${report.layerNormal}`
        + ` 层粗糙度=${report.layerRough}`
        + ` 顶点AO=${report.vertexAo}`
        + ` 烘焙=${report.bake}`);
    }
    // === 编译已完成,uniform 引用就绪 —— 若异步升级还没跑,现在立刻启动 ===
    // (loadSky 很重时首帧渲染晚于材质创建数秒,创建期的轮询可能已超时;
    //  这里作为最终兜底触发点。)
    kickMwamUpgrade(mat, mwamPreset);
  };
  // === Bug B 修复 (per user request: 延迟模式地形缺失) ===
  // attachDeferredMode must run AFTER the layered onBeforeCompile above —
  // it wraps the existing callback (layered runs first as `prev`), so the
  // terrain shader gets BOTH the splat blend AND the G-Buffer outputs.
  // Previously it ran before, so the assignment below overwrote the wrapper
  // entirely: no G-Buffer injection, but deferredReady=true moved the mesh
  // to layer 1 → G-Buffer had no normal/mra/emissive → black terrain.
  attachDeferredMode(mat);

  // === MWAM KTX2 地形贴图异步升级(火后不管;失败/无清单时画布照常) ===
  kickMwamUpgrade(mat, mwamPreset);

  return mat;
}

// ===========================================================================
// MWAM KTX2 异步升级
// ===========================================================================
// 升级需要 live uniform 引用(首次编译后才存在)。地形材质在 loadSky 里
// 创建、但首帧渲染可能在数秒后(64 chunk 烘焙很重)—— 所以既在材质创建
// 时 kick(轮询最长 30s 等编译),也在 onBeforeCompile 里再次 kick(编译
// 发生即立刻启动)。异步结果逐槽换 .value,并把新纹理写进
// userData._mwamTex —— 若加载期间发生重编译(延迟模式开关等),新编译的
// uniform 初值会从 _mwamTex 取回,不丢已升级贴图。
function kickMwamUpgrade(mat: THREE.MeshStandardMaterial, preset: MwamPreset | null): void {
  if (!preset || mat.userData._mwamDone || mat.userData._mwamRunning) return;
  const start = Date.now();
  const tryRun = () => {
    if (mat.userData._mwamDone || mat.userData._mwamRunning) return;
    if (mat.userData._mwamUniforms) {
      void runMwamUpgrade(mat, preset);
      return;
    }
    // 材质还没编译过(loadSky 尚未完成)→ 轮询等待,最多 ~30s。
    if (Date.now() - start < 30000) setTimeout(tryRun, 400);
  };
  tryRun();
}

async function runMwamUpgrade(mat: THREE.MeshStandardMaterial, preset: MwamPreset): Promise<void> {
  let upgradedAlbedo = 0;
  let upgradedNormal = 0;
  try {
    // 层法线数组(4 层 1 个采样器)优先于 4 张逐槽法线: 它能解锁 octave, 且省 3 个采样器。
    void loadMwamNormalArray(preset).then((arr) => {
      if (!arr) return;
      mat.userData._mwamNormalArray = arr;
      const u = mat.userData._mwamUniforms as { normalArray?: { value: THREE.Texture }; normalArrayOn?: { value: number } };
      if (u.normalArray) u.normalArray.value = arr;
      if (u.normalArrayOn) u.normalArrayOn.value = 1;
      mat.needsUpdate = true;
      mat.userData._layerNormalSkipped = false;
      console.info('[terrain] 层法线数组已启用(4 层 1 采样器, octave 打开)');
    });
    const slots = await loadMwamSlotTextures(preset);
    if (slots) {
      const tex = mat.userData._mwamTex as { albedo: THREE.Texture[]; normal: THREE.Texture[] };
      const live = mat.userData._mwamUniforms as {
        albedo: { value: THREE.Texture }[];
        normal: { value: THREE.Texture }[];
      };
      slots.forEach((slot, i) => {
        if (slot.albedo) {
          tex.albedo[i] = slot.albedo;
          if (live?.albedo[i]) live.albedo[i].value = slot.albedo;
          upgradedAlbedo++;
        }
        if (slot.normal) {
          tex.normal[i] = slot.normal;
          if (live?.normal[i]) live.normal[i].value = slot.normal;
          upgradedNormal++;
        }
      });
      if (upgradedAlbedo || upgradedNormal) {
        console.info(`[terrain] MWAM ${preset.label}: KTX2 上线 +${upgradedAlbedo} albedo +${upgradedNormal} normal`);
      }
    }
  } catch (e) {
    console.warn('[terrain] MWAM KTX2 upgrade failed — procedural canvases stay:', e);
  } finally {
    mat.userData._mwamDone = true;
  }
}
