// === 地形编辑器参数 schema (per user request: UE5 编辑器式地形编辑器) ===
// 编辑器"可保存可导出"的单点真值:所有可调参数(地形/材质/雾与天空/植被/
// 城市/LOD 流式/画质)都在这里,分两个层级:
//   maps.<mapType> —— 每张地图各自的地形/材质/植被/城市/LOD(对应游戏
//     engine.ts 三个 buildHeightmapTerrain 调用点的常量)
//   global —— 雾/天空/画质(场景级,与 getSkyConfig + 后处理对应)
// 导出为 terrain-tune.json(游戏端 src/lib/game/terrain-tune.ts 消费),
// 优先级 mission.terrain > terrain-tune > 代码默认。

export type EditorMapType = 'mountain' | 'desert' | 'archipelago' | 'custom';
/** 编辑器地图槽列表(顺序即 UI 顺序)。 */
export const EDITOR_MAP_TYPES: EditorMapType[] = ['mountain', 'desert', 'archipelago', 'custom'];

// ---------- 地形 ----------
export interface EditorTerrain {
  size: number;
  segments: number;
  maxHeight: number;
  seed: number;
  /** 噪声模式(游戏端 desert 用 'plains' 噪声 + desert 样式,编辑器同义) */
  mode: 'mountain' | 'plains' | 'canyon' | 'archipelago';
  snowLine: number;            // 直接高度带雪线(0..1);样式带分位可用时仅作参考
  islandFalloff: boolean;
  islandRadius: number;
  rockColor: string;           // '#rrggbb'(程序化画布兜底色)
  grassColor: string;
  sandColor: string;
  snowColor: string;
  /** 分层样式:MWAM preset key(mountain/desert/archipelago/plains/canyon) */
  terrainStyle: string;
  // --- 分位分带覆盖(STYLE_CFG 的同名参数) ---
  zoneLowTop: number;          // 分位:低地带顶
  zoneVegiTop: number;         // 分位:植被带顶
  zoneRockTop: number;         // 分位:岩带顶(snow 关闭时岩带延伸至顶)
  zoneBandQ: number;           // 边界软化宽度(分位 ±)
  zoneSnowEnabled: boolean;
  // --- 分层基准 (per user request: 多山峰按固定平面高度切片) ---
  // 'relative' = nimbus 式垂直归一(默认;带高 = 实测高度域百分比,不随山高漂移)
  // 'quantile' = 面积分位;'absolute' = 固定海拔米。
  bandMode: 'quantile' | 'absolute' | 'relative';
  bandLow: number;             // absolute 模式:低地带顶(海拔米)
  bandVegi: number;            // 植被带顶(海拔米)
  bandRock: number;            // 岩带顶(海拔米;雪关闭时忽略)
  // --- 陡坡转岩软化(默认 0.72 起 / 0.65 转移;不填跟随代码默认) ---
  slopeRockStart?: number;
  slopeRockK?: number;
  // --- 高度图 AO ---
  aoStrength: number;          // 0..1(0 = 关)
  aoRadius1: number;           // 米(近采样半径)
  aoRadius2: number;           // 米(远采样半径)
  aoDirs: number;              // 方位采样数(3/6)
}

// ---------- 分层材质 ----------
export interface EditorMaterial {
  tileSize: number;            // 世界单位/每贴图重复(旧 90)
  wetTint: number;             // 低洼暗化强度(0..1)
  wetLevel: number;            // 低洼高度阈值(世界单位)
  normalScale: number;         // relief 法线强度(0..2)
  macroAO: number;             // -1 = 用分带表 aoStrength;否则覆盖
  // 每槽平铺倍数(相对 tileSize);与 MWAM PRESETS slot.scale 同义
  slotScales: [number, number, number, number];
  // 每层粗糙度覆盖:key = sheet(dirt/grass/rock/…);空表 = SHEET_ROUGHNESS
  sheetRough: Record<string, number>;
  // === Mask Splatting(per user request: 自动分层 ↔ 遮罩) ===
  maskMode: boolean;           // true = 逐像素读遮罩;false = 自动分层(顶点 splat)
}

// ---------- 植被 / 城市 ----------
export interface EditorVeg {
  enabled: boolean;
  count: number;
  spread: number;
  maxSlope: number;
  minHeight: number;
  maxHeight: number;
  seed: number;
  // === 素材编辑 (per user request) ===
  colorTune: { grass: string; conifer: string; decid: string; bush: string; trunk: string };
  scaleTune: { tree: number; bush: number; grass: number };
  grassCount: number;
  bushCount: number;
}
export interface EditorCity {
  enabled: boolean;
  size: number;
  blockSize: number;
  seed: number;
  // === 素材编辑 (per user request) ===
  colorTune: {
    glass: { bg: string; win: string; emissiveIntensity: number };
    office: { bg: string; win: string; emissiveIntensity: number };
    residential: { bg: string; win: string; emissiveIntensity: number };
    landmark: { bg: string; win: string; emissiveIntensity: number };
  };
}

// ---------- LOD / 流式实验 ----------
export interface EditorLod {
  streaming: boolean;          // 环形流式模拟(关 = 全部 LOD0)
  lodScale: number;            // 0.5..2 环宽缩放
  lod0Radius: number;          // 0..4 强制 LOD0 环半径(chunk 环)
  showChunkOverlay: boolean;   // chunk 边界 + LOD 颜色线框
}

// ---------- 雾 / 天空 / 画质(global) ----------
export interface EditorFog {
  color: string;
  density: number;             // FogExp2 density
  // === 指数级高度雾(per user request: 所在高度 + 生效/变化范围) ===
  heightFog: {
    enabled: boolean;
    color: string;
    opacity: number;           // 0..1
    baseHeight: number;        // 雾集中高度(米)
    falloff: number;           // 向上衰减范围(米)
    startDistance: number;     // 生效距离(米)
    fadeEnd: number;           // 最大距离(米)
    // === 大气透视(v3, §252): 这四项**只在游戏内生效** —— 编辑器预览用的是体素雾盒,
    //     不跑游戏那条屏幕空间散射 pass; 但它们会随 tune 一起保存/导出并驱动游戏。 ===
    sunScatter: number;        // 0..1 阳光散射(0 = 退化成均匀蓝白雾)
    sunPow: number;            // 1..12 前向散射角向尖锐度(越大暖色越集中在太阳附近)
    desat: number;             // 0..1 空气光的对比度衰减(远处洗白)
    sunGlow: number;           // 0..1 雾被太阳照亮的微光
  };
}
export interface EditorSky {
  preset: 'day' | 'sunset' | 'dawn' | 'storm' | 'night';
  weather: string;             // 'clear'|'cloudy'|'rain'|'storm'|'fog'|'snow'
  sunAzimuth: number;          // 度
  sunElevation: number;        // 度(-10..90)
  sunIntensity: number;        // 方向光强度乘子(≈cfg.sunI)
  ambientIntensity: number;    // ≈cfg.ambientI
  toneExposure: number;        // ACES exposure
}
export interface EditorQuality {
  bloom: boolean;
  bloomStrength: number;       // 0..2
  textureQuality: 'low' | 'medium' | 'high';
  // === 场景阴影 (per user request: 加上场景阴影) ===
  shadows: { enabled: boolean; resolution: 1024 | 2048 | 4096; softness: number };
}

// ---------- 总 schema ----------
// === Gaea/预制地形外部元数据 (per user request: 自定义槽导入) ===
// 运行时数据(高度网格/遮罩)不落 EditorParams —— 大 payload 走
// EditorWorld 内存 + 导出包;这里只存「怎么重新定位这份地形」的元数据。
export interface GaeaExternalMeta {
  /** 该槽使用外部高度源(为 false 时 = 普通程序化默认,可当第五张测试图) */
  active: boolean;
  /** 世界范围(米;决定 ±size/2 采样与 LOD 分块) */
  size: number;
  /** 源高度单位 → 米 的缩放(导入期已折算进 f32bin,这里仅记录) */
  heightScale: number;
  /** 海平面偏移(米;源图在此值以下算水下,引擎沿用 0=海面) */
  seaLevel: number;
  /** 导出遮罩分辨率档(512/1024/2048) */
  maskRes: 512 | 1024 | 2048;
  /** 顶点色(远景) ↔ 细节贴图(近景)混合距离(米):near/far */
  mixNear: number;
  mixFar: number;
  /** 顶点色规范色卡(RGB 0..1 ×4:低地/草/岩/雪)—— 与 classify 默认同构 */
  canonical?: [number, number, number][];
  /** 包名(导出/外置文件命名) */
  name: string;
}

export interface EditorMapParams {
  terrain: EditorTerrain;
  material: EditorMaterial;
  veg: EditorVeg;
  city: EditorCity;
  lod: EditorLod;
  external?: GaeaExternalMeta;
  // === 导入图层独立对齐(per user request: 四贴图各自调试) ===
  // 高度场/基础色/法线/AO 各一层;游戏 tune 同构(transform.ts 变换约定)。
  transform?: { height?: { rot?: number; flipX?: boolean; flipY?: boolean };
    color?: { rot?: number; flipX?: boolean; flipY?: boolean };
    normal?: { rot?: number; flipX?: boolean; flipY?: boolean };
    ao?: { rot?: number; flipX?: boolean; flipY?: boolean } };
}
export interface EditorParams {
  version: 1;
  mapType: EditorMapType;
  maps: Record<EditorMapType, EditorMapParams>;
  fog: EditorFog;
  sky: EditorSky;
  quality: EditorQuality;
  /** 编辑器专用调试选项(不导出进 terrain-tune) */
  debug: { showBandSlices: boolean };
  /** 每地图遮罩:RGBA 4 通道(低地/草/岩/雪),1024² 默认(≈12m/纹素) */
  masks: Record<EditorMapType, { res: 512 | 1024 | 2048; png?: string }>;
}

// ===========================================================================
// 默认值(与 engine.ts 三处调用点 + terrain-mwam STYLE_CFG 一致)
// ===========================================================================
const STYLE_DEFAULT: Record<string, { lowTop: number; vegiTop: number; rockTop: number; bandQ: number; snow: boolean; ao: number; r1: number; r2: number }> = {
  mountain:    { lowTop: 0.05, vegiTop: 0.58, rockTop: 0.87, bandQ: 0.05, snow: true,  ao: 0.85, r1: 380, r2: 1100 },
  plains:      { lowTop: 0.06, vegiTop: 0.66, rockTop: 0.93, bandQ: 0.05, snow: true,  ao: 0.55, r1: 160, r2: 480 },
  desert:      { lowTop: 0.06, vegiTop: 0.72, rockTop: 1.0,  bandQ: 0.06, snow: false, ao: 0.5,  r1: 150, r2: 450 },
  archipelago: { lowTop: 0.05, vegiTop: 0.6,  rockTop: 0.88, bandQ: 0.05, snow: true,  ao: 0.7,  r1: 220, r2: 660 },
  canyon:      { lowTop: 0.04, vegiTop: 0.5,  rockTop: 0.9,  bandQ: 0.04, snow: true,  ao: 0.8,  r1: 300, r2: 900 },
};

function mkTerrain(map: EditorMapType, style: string, s: typeof STYLE_DEFAULT[string]): EditorTerrain {
  // 绝对海拔分层默认阈值(米)—— 多山峰地图按固定平面高度切片
  const absBands: Record<EditorMapType, [number, number, number]> = {
    mountain: [300, 1200, 2600],
    desert: [60, 240, 700],
    archipelago: [80, 400, 1400],
    custom: [300, 1200, 2600],
  };
  const [bLo, bVegi, bRock] = absBands[map];
  if (map === 'mountain' || map === 'custom') {
    return {
      size: 48600, segments: 512, maxHeight: 4320, seed: map === 'custom' ? 0 : 4242,
      mode: 'mountain', snowLine: 0.55, islandFalloff: false, islandRadius: 12150,
      rockColor: '#4a3a2a', grassColor: '#3a5a2a', sandColor: '#b8a878', snowColor: '#f4f6fa',
      terrainStyle: style,
      zoneLowTop: s.lowTop, zoneVegiTop: s.vegiTop, zoneRockTop: s.rockTop, zoneBandQ: s.bandQ, zoneSnowEnabled: s.snow,
      bandMode: 'relative', bandLow: bLo, bandVegi: bVegi, bandRock: bRock,
      aoStrength: s.ao, aoRadius1: s.r1, aoRadius2: s.r2, aoDirs: 6,
    };
  }
  if (map === 'desert') {
    return {
      size: 54000, segments: 512, maxHeight: 1080, seed: 7777,
      mode: 'plains', snowLine: 2.0, islandFalloff: false, islandRadius: 12150,
      rockColor: '#a88858', grassColor: '#c8a878', sandColor: '#e0c898', snowColor: '#ffffff',
      terrainStyle: 'desert',
      zoneLowTop: s.lowTop, zoneVegiTop: s.vegiTop, zoneRockTop: s.rockTop, zoneBandQ: s.bandQ, zoneSnowEnabled: s.snow,
      bandMode: 'relative', bandLow: bLo, bandVegi: bVegi, bandRock: bRock,
      aoStrength: s.ao, aoRadius1: s.r1, aoRadius2: s.r2, aoDirs: 6,
    };
  }
  return {
    size: 37800, segments: 512, maxHeight: 2430, seed: 8888,
    mode: 'archipelago', snowLine: 0.85, islandFalloff: true, islandRadius: 12150,
    rockColor: '#6a5848', grassColor: '#4a7a3a', sandColor: '#e8d8a8', snowColor: '#f8f8f8',
    terrainStyle: 'archipelago',
    zoneLowTop: s.lowTop, zoneVegiTop: s.vegiTop, zoneRockTop: s.rockTop, zoneBandQ: s.bandQ, zoneSnowEnabled: s.snow,
    bandMode: 'relative', bandLow: bLo, bandVegi: bVegi, bandRock: bRock,
    aoStrength: s.ao, aoRadius1: s.r1, aoRadius2: s.r2, aoDirs: 6,
  };
}

function mkMap(map: EditorMapType): EditorMapParams {
  // custom(Gaea 导入槽)= 山岳同款分带参数表(terrainStyle 'mountain')
  const styleKey = map === 'desert' ? 'desert' : map === 'archipelago' ? 'archipelago' : map === 'custom' ? 'mountain' : map;
  return {
    terrain: mkTerrain(map, styleKey, STYLE_DEFAULT[styleKey]),
    material: {
      tileSize: 40, wetTint: 0.72, wetLevel: 5.0, normalScale: 0.6, macroAO: -1,
      slotScales: [1.0, 1.3, 1.7, 1.0],
      sheetRough: {},
      maskMode: false,
    },
    veg: {
      enabled: map !== 'desert',
      count: map === 'mountain' ? 4000 : 600,
      spread: map === 'mountain' ? 18900 : 12150,
      maxSlope: 0.55, minHeight: 80,
      maxHeight: map === 'mountain' ? 1700 : 800,
      seed: map === 'mountain' ? 99 : 1234,
      colorTune: {
        grass: '#ffffff', conifer: '#9fd8a0', decid: '#b8e0a0', bush: '#a8d498', trunk: '#4a3520',
      },
      scaleTune: { tree: 1, bush: 1, grass: 1 },
      grassCount: 60000,
      bushCount: 2600,
    },
    city: {
      enabled: map === 'desert', size: 14000, blockSize: 600, seed: 7,
      colorTune: {
        glass: { bg: '#2a3540', win: '#5a8aaa', emissiveIntensity: 0.4 },
        office: { bg: '#3a3530', win: '#d8b878', emissiveIntensity: 0.3 },
        residential: { bg: '#403838', win: '#e8c888', emissiveIntensity: 0.25 },
        landmark: { bg: '#1a1e26', win: '#ffd97a', emissiveIntensity: 0.5 },
      },
    },
    lod: { streaming: true, lodScale: 1.0, lod0Radius: 2, showChunkOverlay: false },
  };
}

export function defaultEditorParams(): EditorParams {
  return {
    version: 1,
    mapType: 'mountain',
    maps: { mountain: mkMap('mountain'), desert: mkMap('desert'), archipelago: mkMap('archipelago'), custom: mkMap('custom') },
    fog: {
      color: '#c8d4e0', density: 0.00002,
      // 指数级高度雾默认关;开启后参数即导出
      heightFog: {
        enabled: false, color: '#cfd8e4', opacity: 0.5,
        baseHeight: 150, falloff: 400, startDistance: 600, fadeEnd: 12000,
        // 大气透视(§252): 默认与游戏内 _hfParams 对齐, 只在游戏里生效
        sunScatter: 0.7, sunPow: 3.5, desat: 0.4, sunGlow: 0.28,
      },
    },
    sky: { preset: 'day', weather: 'clear', sunAzimuth: 135, sunElevation: 45, sunIntensity: 2.2, ambientIntensity: 0.55, toneExposure: 1.08 },
    quality: { bloom: true, bloomStrength: 0.7, textureQuality: 'high', shadows: { enabled: true, resolution: 2048, softness: 0.6 } },
    debug: { showBandSlices: false },
    masks: {
      mountain: { res: 1024 },
      desert: { res: 1024 },
      archipelago: { res: 1024 },
      custom: { res: 1024 },
    },
  };
}

// ===========================================================================
// 深合并(导入项目 JSON 时保护缺字段)
// ===========================================================================
function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined || patch === null) return base;
  if (Array.isArray(base) && Array.isArray(patch)) return patch as unknown as T;
  if (typeof base === 'object' && typeof patch === 'object' && !Array.isArray(patch)) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const k of Object.keys(patch as Record<string, unknown>)) {
      out[k] = deepMerge((base as Record<string, unknown>)[k], (patch as Record<string, unknown>)[k]);
    }
    return out as T;
  }
  return patch as unknown as T;
}

/** 从 JSON 字符串导入(编辑器项目格式;不完整字段自动补默认)。 */
export function parseEditorParams(json: string): EditorParams {
  const base = defaultEditorParams();
  try {
    const raw = JSON.parse(json) as Partial<EditorParams>;
    if (raw.version !== 1) return base;
    return deepMerge(base, raw);
  } catch {
    return base;
  }
}

// ===========================================================================
// 导出为游戏端 terrain-tune.json(terrain-tune.ts 消费的契约)
// ===========================================================================
export interface TerrainTuneDoc {
  version: 1;
  global: { fog: EditorFog; sky: Omit<EditorSky, 'preset' | 'weather'>; quality: EditorQuality };
  maps: Record<string, { terrain: EditorTerrain; material: EditorMaterial; veg: EditorVeg; city: EditorCity; lod: EditorLod }>;
}

export function exportTuneDoc(params: EditorParams): TerrainTuneDoc {
  return {
    version: 1,
    global: {
      fog: params.fog,
      sky: {
        sunAzimuth: params.sky.sunAzimuth,
        sunElevation: params.sky.sunElevation,
        sunIntensity: params.sky.sunIntensity,
        ambientIntensity: params.sky.ambientIntensity,
        toneExposure: params.sky.toneExposure,
      },
      quality: params.quality,
    },
    maps: {
      mountain: mapToTuneDoc(params, 'mountain'),
      desert: mapToTuneDoc(params, 'desert'),
      archipelago: mapToTuneDoc(params, 'archipelago'),
      custom: mapToTuneDoc(params, 'custom'),
    },
  };
}

/** 导出单张地图:遮罩模式时把 maskMode + maskPng(dataURL)写进 material。 */
function mapToTuneDoc(params: EditorParams, map: EditorMapType) {
  const mp = params.maps[map];
  const mask = params.masks[map];
  // 逐字段挑选 —— external(编辑器专用,Gaea 运行时数据)绝不泄漏进 tune;
  // 高度包由 EditorApp 导出时以 externalHeight 附加(数据在世界侧)。
  const out: Record<string, unknown> = {
    terrain: mp.terrain,
    veg: mp.veg,
    city: mp.city,
    lod: mp.lod,
    // === 导入贴图对齐参数导出(游戏 engine 按此旋转/镜像) ===
    ...(mp.transform ? { transform: mp.transform } : {}),
  };
  out.material = {
    ...mp.material,
    // maskPng 只在遮罩模式且有图时携带,避免 tune JSON 无谓膨胀
    ...(mp.material.maskMode && mask.png ? { maskMode: true, maskPng: mask.png } : { maskMode: false }),
  };
  return out as TerrainTuneDoc['maps'][string];
}
