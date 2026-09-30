// === terrain-tune 融合链 (per user request: 地形编辑器导出 → 游戏本体) ===
// 编辑器把调好的参数导出为 terrain-tune.json(契约见下),本模块负责:
//   1. 加载:优先 localStorage('skybound.terrainTune',编辑器热测)→
//      fetch('/config/terrain-tune.json')(仓库落盘,AI/程序融合只改 JSON)
//   2. 分发:engine.ts 在 loadSky 取 maps.<mapType> 与 global 节,覆盖代码
//      默认值。优先级链:mission.terrain 覆盖 > 用户 localStorage 设置 >
//      terrain-tune > 代码默认。
// 所有字段可选 —— 缺什么就用现有代码默认,绝不让游戏缺参。
import type { TerrainRecipe } from '../terrain-import/recipe-gen';

/** 地形构建参数覆盖(与 HeightmapTerrainOpts 一一对应,全部可选)。 */
export interface TuneTerrain {
  size?: number;
  segments?: number;
  maxHeight?: number;
  seed?: number;
  mode?: 'mountain' | 'plains' | 'canyon' | 'archipelago';
  snowLine?: number;
  islandFalloff?: boolean;
  islandRadius?: number;
  rockColor?: string;
  grassColor?: string;
  sandColor?: string;
  snowColor?: string;
  terrainStyle?: string;
  /** === Gaea 基础色亮度增益 (per user request: 导入图基础色太亮) ===
   * 乘在 Gaea 色图 RGB 上(走 uniform, 无需重烘 1.3MB 贴图)。缺省 1(零回归);
   * custom 图在 engine.ts 取 0.72 压亮。可实时调:
   *   __engine._terrainMaterial.userData._tuneUniforms.external.gain.value = 0.6 */
  colorGain?: number;
  // 分位分带(STYLE_CFG 覆盖)
  zoneLowTop?: number;
  zoneVegiTop?: number;
  zoneRockTop?: number;
  zoneBandQ?: number;
  zoneSnowEnabled?: boolean;
  // === 分层基准 (per user request: 多山峰时按固定平面高度切片) ===
  // bandMode='absolute' 时用绝对海拔阈值(米);'quantile' = 面积分位;
  // 'relative' = nimbus 式垂直归一(带高 = 实测高度域百分比,默认)。
  bandMode?: 'quantile' | 'absolute' | 'relative';
  bandLow?: number;
  bandVegi?: number;
  bandRock?: number;
  // === 陡坡转岩软化 (per user request: 岩石占满遮罩) ===
  // 阈值(坡度≥此值开始转岩,默认 0.72)与转移强度(默认 0.65)。
  slopeRockStart?: number;
  slopeRockK?: number;
  // === Gaea/预制地形外部高度包 (per user request: 自定义槽导入) ===
  // 提供后 engine 用外部高度场替代程序化噪声;bytesBase64 内嵌(小包,
  // file:// 可用)或 url 外置(相对 public/,经 __ASSET_MANIFEST/dataURI)。
  externalHeight?: {
    kind?: 'f32bin';
    /** 世界范围(米) */
    size: number;
    resX: number;
    resY: number;
    /** 名义最大高(米;缺省由数据现算) */
    maxHeight?: number;
    bytesBase64?: string;
    url?: string;
    /** 体积云带(米;缺省按地图类型默认) */
    cloudBase?: number;
    cloudTop?: number;
  };
  // === 程序化地形配方 (per user request: 配方直生;纯指令驱动) ===
  // 有 recipe 时引擎在运行处按配方现算高度网格(免大文件,改参即新地形);
  // 与 externalHeight 二选一:recipe 用于"程序生成",externalHeight 用于
  // "文件导入"。
  recipe?: TerrainRecipe;
  // 高度图 AO
  aoStrength?: number;
  aoRadius1?: number;
  aoRadius2?: number;
  aoDirs?: number;
}

/** 分层材质覆盖(与 layered-terrain.ts 常量对应)。 */
export interface TuneMaterial {
  tileSize?: number;
  wetTint?: number;
  wetLevel?: number;
  normalScale?: number;
  /** -1 = 用分带表 aoStrength;否则覆盖 uMacroAO */
  macroAO?: number;
  /** 岩层 albedo 乘性校正 [R,G,B](提亮去蓝;默认 1.18/1.09/0.98) */
  rockBoost?: [number, number, number];
  slotScales?: [number, number, number, number];
  sheetRough?: Record<string, number>;
  // === Mask Splatting(per user request: 自动分层 ↔ 遮罩) ===
  // maskMode=true + maskPng(RGBA dataURL,R/G/B/A = 低地/草/岩/雪)时,
  // 分层改为逐像素读遮罩;否则维持顶点 splat 自动分层。
  maskMode?: boolean;
  maskPng?: string;
  /** === 区域掩码(R=林区 forestfloor, G=干区 dry) ===
   *  由 scripts/terrain-layers-import.mjs 从 Blender 的 forest_bake/dry_bake 打包而来
   *  (世界域, 与 maskPng 同坐标; 线性权值 ⇒ 按 NoColorSpace 读)。
   *  §356 回退: 运行期已无消费者 —— 它原先只喂 8 层数组材质(dry/forestfloor 两层的权重
   *  来源), 那套材质已从游戏运行期移除。字段与资产(region_masks.png)都留着, 归
   *  Blender/资产管线的约定用; 地表运行期不会读它。*/
  regionMask?: string;
  // === Gaea 彩色纹理直出 (per user request: 导入地图地表 = Gaea 视口观感) ===
  // Gaea 导入(custom)地图不用游戏内程序分带遮罩,直接把 Gaea 导出的一张
  // 彩色纹理(699 链 Weathering×Snow 合成,worldSize 同高度图)当地表色。
  // colorPng = dataURL 内嵌 或 url 外置(/custom-maps/...png,经 manifest)。
  // mix 0..1:0 = 纯分层(默认),1 = 纯 Gaea 彩色;uv = 全图 ±size/2 1:1。
  colorMap?: string;   // dataURL 或 url(存在时启用)
  colorMix?: number;   // 0..1 混合强度(默认 1 = 全替换)
  // === Gaea 导入关 PBR 附加贴图 (per user request: 四贴图统一) ===
  // 004 类导入(custom)关与 colorMap 同世界域、同取址规则(manifest/file://)。
  normalMap?: string;  // 切线空间法线(替换程序 relief,NoColorSpace 解码)
  aoMap?: string;      // 世界域 AO 灰图(乘间接光)
  // === 世界域法线采样开关 (per 任务: 贴图错位纠错) ===
  /** true = normalMap 按世界域 uv2 采样(与 colorMap 同域);缺省 = chunk 自带 UV。 */
  normalWorldDomain?: boolean;
  // === 世界域烘焙光照图 (per 任务: Blender 光照贴图导入) =====================
  // 单张世界域 RGBA, 与 colorMap 同 ±size/2 1:1、同取址规则(manifest / file://)。
  // 通道契约: **R = AO, G = GI 间接光, B = 太阳可见度, A = 预留**。
  // 三条都是 0..1 的**乘数(线性数据, Non-Color)**, 不是颜色 —— 被 sRGB 编码会让
  // 数值非线性失真;打包器 scripts/blender-pack.mjs 对此硬失败。
  // 消费端: R 走 three 内置 aoMap 槽(贴图 channel=2 世界域 uv2);
  //         G/B 复用**同一个** aoMap 采样器注入 → 净增 0 个纹理单元。
  // 详见 docs/blender-import-workflow.md。
  bakeMap?: string;
  /** 'packed'(默认, 四通道打包) | 'ao'(旧 Gaea AOExport 单通道灰图, 只当 R 用) */
  bakeMode?: 'packed' | 'ao';
  bakeAO?: number;
  bakeGI?: number;
  bakeShadow?: number;
}

export interface TuneVeg {
  enabled?: boolean;
  /** === 作者植被遮罩(世界域 PNG, R 通道 = 密度) (per user request: 树的位置以 blender 为主导) ===
   * 由 blender/terrain 的 forest_bake / veg_mask 导出(见 70_export_game.py)。
   * 语义: **乘进**程序化密度 ⇒ 引擎的水位/坡度/林线仍然生效, 这张图只决定"哪片是林子"。 */
  maskUrl?: string;
  /** === 树木位置表(blender 导出) (per user request: blender 提供每棵树的位置) ===
   *  由 blender/terrain/71_export_trees.py 生成 → public/custom-maps/<slot>/trees.f32bin。
   *  游戏侧只做"球形距离 → 加载/卸载 + 切 LOD 几何", 不再有遮罩/程序化放置。 */
  treesUrl?: string;
  /** 流式半径(m): 只保留这个半径内的树桶(大地图要够小不动, 太小远处是空的)。
   *  4× 地图(291.6 km)建议 24000~30000; 缺省 11000。 */
  streamM?: number;
  count?: number;
  spread?: number;
  maxSlope?: number;
  minHeight?: number;
  maxHeight?: number;
  seed?: number;
  // === 素材编辑 (per user request: 植被素材编辑器选项) ===
  colorTune?: { grass?: string; conifer?: string; decid?: string; bush?: string; trunk?: string };
  scaleTune?: { tree?: number; bush?: number; grass?: number };
  grassCount?: number;
  bushCount?: number;
}

export interface TuneCity {
  enabled?: boolean;
  size?: number;
  blockSize?: number;
  seed?: number;
  // === 素材编辑 (per user request: 城市素材编辑器选项) ===
  colorTune?: {
    glass?: { bg?: string; win?: string; emissiveIntensity?: number };
    office?: { bg?: string; win?: string; emissiveIntensity?: number };
    residential?: { bg?: string; win?: string; emissiveIntensity?: number };
    landmark?: { bg?: string; win?: string; emissiveIntensity?: number };
  };
}

export interface TuneLod {
  lodScale?: number;
  lod0Radius?: number;
}

export interface MapLayerTransform {
  rot?: number;       // 0 | 90 | 180 | 270(顺时针)
  flipX?: boolean;    // 左右镜像
  flipY?: boolean;    // 上下镜像
}
export type ImportLayer = 'height' | 'color' | 'normal' | 'ao' | 'bake';

export interface TuneMap {
  terrain?: TuneTerrain;
  material?: TuneMaterial;
  veg?: TuneVeg;
  /** === 港口(实例化 + 距离剔除) (per user request) === 
   *  GLB 里是 19 份原型网格, 实例表每行 6×float32(x,y,z,rotZ,原型下标,缩放);
   *  游戏侧按原型分组 ⇒ 19 个 InstancedMesh ⇒ 19 次 draw call。
   *  plateUrl = 基座平台(军港基底)网格, 见 blender/terrain/27_export_plate.py。 */
  port?: { glbUrl?: string; instancesUrl?: string; plateUrl?: string };
  city?: TuneCity;
  lod?: TuneLod;
  // === 导入贴图独立对齐 (per user request: 四贴图各自调试) ===
  // 每一层(高度场/基础色/法线/AO)可单独旋转/镜像;缺失 = 该层零变换。
  transform?: Partial<Record<ImportLayer, MapLayerTransform>>;
}

export interface TuneGlobal {
  fog?: {
    color?: string;
    density?: number;
    // === 指数级高度雾(per user request: 所在高度/生效与变化范围) ===
    heightFog?: {
      enabled?: boolean;
      color?: string;
      opacity?: number;      // 0..1 雾强度
      baseHeight?: number;   // 雾集中高度(米)
      falloff?: number;      // 向上指数衰减范围(米)
      startDistance?: number; // 生效距离(米)
      fadeEnd?: number;      // 最大距离(米),之前淡出归零
      // === 大气透视 (v3) ==================================================
      sunScatter?: number;   // 0..1 阳光散射强度(0 = 退化成纯蓝白均匀雾, 等于 v2)
      sunPow?: number;       // 前向散射角向尖锐度(1 = 大范围泛暖, 3~8 = 集中在太阳附近)
      desat?: number;        // 0..1 空气光的对比度衰减(远处去饱和/洗白, 暗部被提亮)
      sunGlow?: number;      // 0..1 雾被太阳照亮的微光
    };
  };
  sky?: {
    sunAzimuth?: number;
    sunElevation?: number;
    sunIntensity?: number;
    ambientIntensity?: number;
    toneExposure?: number;
  };
  quality?: { bloom?: boolean; bloomStrength?: number; textureQuality?: 'low' | 'medium' | 'high' };
}

export interface TerrainTuneDoc {
  version: number;
  global?: TuneGlobal;
  maps?: Record<string, TuneMap>;
}

export const TUNE_LS_KEY = 'skybound.terrainTune';
export const TUNE_JSON_PATH = '/config/terrain-tune.json';

let _cached: TerrainTuneDoc | null | undefined;

/** 加载 terrain-tune(模块级缓存;localStorage 优先,fetch JSON 兜底)。 */
export async function loadTerrainTune(): Promise<TerrainTuneDoc | null> {
  if (_cached !== undefined) return _cached;
  _cached = null;
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage.getItem(TUNE_LS_KEY) : null;
    const lsDoc = ls ? (JSON.parse(ls) as TerrainTuneDoc) : null;
    // ⚠ 以前这里"命中 localStorage 就 return" ⇒ **文件里的新槽永远进不来**:
    //   用户用编辑器调过一次地形后, 存档里没有我新加的 maps.test ⇒ mTune=null ⇒
    //   测试关回落成程序化山、且没有植被(实测症状: "一片平绿 + 一棵树都没有")。
    //   改成 **文件打底 + 存档覆盖**(深合并到 maps.<slot>.terrain 这一层):
    //   存档里调过的值仍然优先, 而文件里新增的槽/字段能正常生效。
    let fileDoc: TerrainTuneDoc | null = null;
    try {
      // 单文件构建: config json 也进 __ASSET_MANIFEST → 用 data URI 离线可取
      const assetUrl: string | undefined = typeof window !== 'undefined'
        ? (window as unknown as { __ASSET_MANIFEST?: Record<string, string> }).__ASSET_MANIFEST?.[TUNE_JSON_PATH]
        : undefined;
      const res = await fetch(assetUrl ?? TUNE_JSON_PATH);
      if (res.ok) fileDoc = (await res.json()) as TerrainTuneDoc;
    } catch { /* 单文件 file:// 下 fetch 被禁 → 只有存档/全默认 */ }
    if (!lsDoc) { _cached = fileDoc; return _cached; }
    if (!fileDoc) { _cached = lsDoc; return _cached; }
    const maps: Record<string, TuneMap> = { ...(fileDoc.maps ?? {}) };
    for (const [k, v] of Object.entries(lsDoc.maps ?? {})) {
      const a = (fileDoc.maps ?? {})[k] as TuneMap | undefined;
      maps[k] = {
        ...(a ?? {}), ...v,
        terrain: { ...(a?.terrain ?? {}), ...(v?.terrain ?? {}) },
      } as TuneMap;
    }
    _cached = { ...fileDoc, ...lsDoc, global: { ...(fileDoc.global ?? {}), ...(lsDoc.global ?? {}) }, maps };
    return _cached;
  } catch { /* 坏 JSON → 全默认 */ }
  return _cached;
}

/** 取某地图类型的 tune 节(无则 null)。 */
export function mapTune(doc: TerrainTuneDoc | null, mapType: string): TuneMap | null {
  return doc?.maps?.[mapType] ?? null;
}

/** 全局节(雾/天空/画质)。 */
export function globalTune(doc: TerrainTuneDoc | null): TuneGlobal {
  return doc?.global ?? {};
}
