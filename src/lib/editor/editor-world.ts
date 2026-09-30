// === 编辑器场景主权 (per user request: UE5 编辑器式地形编辑器) ===
// 独立于 GameEngine 的场景/渲染/重建管线:1:1 复用 environment.ts 的构建
// 函数(地形/植被/城市/天空/海洋/单体资产),terrain-tune 覆盖走与游戏完全
// 相同的 buildHeightmapTerrain(opts.tune) 代码路径 —— 编辑器里调出来的
// 观感 = 游戏本体的观感(mission 覆盖除外)。
//
// 实时 vs 重建分层:
//   实时(uniform/灯光,零重建):雾、湿地面、tileRepeat、macroAO、层粗糙度、
//     槽位平铺倍数、太阳方向/颜色/强度、曝光、bloom 强度、LOD 环参数
//   重建(debounce):地形(size/seed/mode/样式/分位/AO 半径/颜色)、植被、
//     城市、天空预设/天气、地图切换
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import {
  getSkyConfig, applyWeather, buildAtmosphericSky, buildSunDisc,
  buildOcean, buildHeightmapTerrain, buildTerrainForest, buildCity,
  buildHeightFogVolume,
  type SkyConfig, type TerrainChunkInfo, type TerrainHeightSurvey,
} from '../game/environment';
import { getTextureManager } from '../game/pbr/texture-manager';
import { getMwamStyleCfg } from '../game/pbr/terrain-mwam';
// === 统一分层带解析器 (per user request: 遮罩与游戏带高逐米一致) ===
import {
  resolveBands, bandWeightsAt, applySlopeRock, bandAreaShare,
  type BandReport, type BandTunables,
} from '../game/terrain-bands';
import type { TuneMap } from '../game/terrain-tune';
// === Gaea 外部高度源 (per user request: 导入预制地形) ===
import { buildExternalHeightAt, type HeightGrid } from '../terrain-import/height-source';
import { EditorFlyCamera } from './editor-camera';
import { ActorStore, EditorGizmo, findPaletteDef } from './editor-placement';
import { ProbesManager } from './editor-probes';
import type { EditorActor } from './editor-placement';
import type { EditorParams, EditorMapParams, EditorMapType } from './editor-params';

export interface EditorStats {
  fps: number;
  drawCalls: number;
  triangles: number;
  visibleChunks: number;
  totalChunks: number;
  instanced: number;
  vramMB: number;
  camSpeed: number;
}

/** 遮罩画布(每地图一张;strokes = 手绘笔迹计数,防止自动生成覆盖手绘) */
interface MaskEntry {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  res: number;
  size: number;
  strokes: number;
}

export interface EditorWorldCallbacks {
  onProgress?: (label: string | null) => void;
  onStats?: (s: EditorStats) => void;
  onSelectionChanged?: (actor: EditorActor | null) => void;
}

function disposeObjectDeep(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.geometry?.dispose?.();
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        if (!mat) continue;
        (mat as THREE.Material).dispose?.();
      }
    }
  });
  root.removeFromParent?.();
}

export class EditorWorld {
  readonly flyCam: EditorFlyCamera;
  readonly gizmo: EditorGizmo;
  readonly actors = new ActorStore();
  readonly probes: ProbesManager;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private raycaster = new THREE.Raycaster();

  // 环境分层节点
  private skyMesh: THREE.Mesh | null = null;
  private sunDisc: THREE.Sprite | null = null;
  private sunLight: THREE.DirectionalLight | null = null;
  private hemiLight: THREE.HemisphereLight | null = null;
  private ocean: THREE.Mesh | null = null;
  private terrainGroup: THREE.Group | null = null;
  private chunks: TerrainChunkInfo[] = [];
  private vegGroup: THREE.Group | null = null;
  private cityGroup: THREE.Group | null = null;
  private chunkOverlay: THREE.Group | null = null;
  private bandSliceGroup: THREE.Group | null = null;
  private heightFogMesh: THREE.Mesh | null = null;
  private heightFogSize = 0;
  private terrainMat: THREE.MeshStandardMaterial | null = null;
  private sampleHeight: ((x: number, z: number) => number) | null = null;
  private survey: TerrainHeightSurvey | null = null;
  // === Mask Splatting(per user request: 自动分层 ↔ 遮罩) ===
  // 每地图一张 RGBA 遮罩(R/G/B/A = 低地/草/岩/雪),1024² 默认;
  // CanvasTexture 线性采样 + mip;自动生成/手绘都写这张图。
  private maskStore = new Map<string, MaskEntry>();
  private maskBusy = new Set<string>(); // 自动生成单飞(每地图一次)
  // === Gaea/预制地形运行时数据 (per user request: 自定义槽导入) ===
  // 高度网格/顶点色图挂在 world(不进 EditorParams,避免 JSON 撑爆);
  // params.maps.<t>.external 只存定位元数据。
  private externalGrids = new Map<string, HeightGrid>();
  private externalVtx = new Map<string, { tex: THREE.CanvasTexture; canonical: [number, number, number][] }>();
  private externalNormal = new Map<string, THREE.Texture>(); // 004 高度场烘焙法线
  private externalAo = new Map<string, THREE.Texture>();      // 004 Gaea AO(世界域)

  /** 挂载外部高度包(custom 槽;重复挂载时先释放旧贴图)。 */
  setExternalPack(
    mapType: string,
    grid: HeightGrid,
    vtx?: { tex: THREE.CanvasTexture; canonical: [number, number, number][] },
    normal?: THREE.Texture | null,
    ao?: THREE.Texture | null,
  ) {
    const old = this.externalVtx.get(mapType);
    if (old && old !== vtx) old.tex.dispose();
    this.externalGrids.set(mapType, grid);
    if (vtx) this.externalVtx.set(mapType, vtx);
    else this.externalVtx.delete(mapType);
    if (normal) this.externalNormal.set(mapType, normal);
    else this.externalNormal.delete(mapType);
    if (ao) this.externalAo.set(mapType, ao);
    else this.externalAo.delete(mapType);
  }

  /** 取外部法线贴图(rebuild 传材质;无则程序 relief 照旧)。 */
  externalNormalOf(mapType: string): THREE.Texture | null {
    return this.externalNormal.get(mapType) ?? null;
  }
  /** 取外部 AO 贴图(rebuild 传材质;无则间接光零改动)。 */
  externalAoOf(mapType: string): THREE.Texture | null {
    return this.externalAo.get(mapType) ?? null;
  }

  clearExternalPack(mapType: string) {
    const old = this.externalVtx.get(mapType);
    if (old) old.tex.dispose();
    this.externalGrids.delete(mapType);
    this.externalVtx.delete(mapType);
    this.externalNormal.delete(mapType);
    this.externalAo.delete(mapType);
  }

  /** 取回外部包(导出/诊断)。 */
  externalPackOf(mapType: string): { grid: HeightGrid; vtx: { tex: THREE.CanvasTexture; canonical: [number, number, number][] } | null } | null {
    const grid = this.externalGrids.get(mapType);
    if (!grid) return null;
    return { grid, vtx: this.externalVtx.get(mapType) ?? null };
  }

  /** 实时调远/近混合距离(改 uniform,不重建)。 */
  applyExternalMix(mapType: string, near: number, far: number) {
    const mat = this.terrainMat;
    const ext = (mat as unknown as { userData?: { _tuneUniforms?: { external?: { mixNear: { value: number }; mixFar: { value: number } } } } })?.userData?._tuneUniforms?.external;
    if (ext) {
      ext.mixNear.value = near;
      ext.mixFar.value = far;
    }
    const meta = this.params.maps[mapType as EditorMapType]?.external;
    if (meta) {
      meta.mixNear = near;
      meta.mixFar = far;
    }
  }


  // 重建防抖 + 流式节流
  private terrainRebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private skyRebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private streamLast = 0;
  private building = false;
  private pendingRebuild = false;
  private disposed = false;

  // 帧统计
  private fpsAccum = 0;
  private fpsFrames = 0;
  private lastFps = 0;
  private statsTimer = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    public params: EditorParams,
    private cb: EditorWorldCallbacks = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = params.sky.toneExposure;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
    this.renderer.setSize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
    // === 场景阴影 (per user request: 加上场景阴影) ===
    this.renderer.shadowMap.enabled = params.quality.shadows.enabled;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.flyCam = new EditorFlyCamera(canvas.clientWidth / Math.max(1, canvas.clientHeight));
    this.gizmo = new EditorGizmo(this.flyCam.camera, canvas);
    this.scene.add(this.gizmo.controls.getHelper());
    this.gizmo.onFrozenChange = (frozen) => { this.flyCam.frozen = frozen; };

    this.probes = new ProbesManager(this.renderer, this.scene);
    getTextureManager().attachRenderer(this.renderer);
    getTextureManager().refresh();

    this.scene.background = new THREE.Color(params.fog.color);
    this.scene.fog = new THREE.FogExp2(params.fog.color, params.fog.density);

    void this.rebuildWorld(true);
  }

  // =========================================================================
  // 参数补丁:分层(实时 vs 重建)
  // =========================================================================
  private static TERRAIN_HEAVY = new Set([
    'size', 'segments', 'maxHeight', 'seed', 'mode', 'snowLine',
    'islandFalloff', 'islandRadius', 'rockColor', 'grassColor', 'sandColor',
    'snowColor', 'terrainStyle', 'zoneLowTop', 'zoneVegiTop', 'zoneRockTop',
    'zoneBandQ', 'zoneSnowEnabled', 'aoStrength', 'aoRadius1', 'aoRadius2', 'aoDirs',
  ]);
  private static SKY_HEAVY = new Set(['preset', 'weather']);

  /** 编辑器 UI 提交参数改动(浅补丁,按路径判定实时 or 重建)。 */
  applyPatch(patch: {
    terrain?: Partial<EditorParams['maps']['mountain']['terrain']>;
    material?: Partial<EditorParams['maps']['mountain']['material']>;
    veg?: Partial<EditorParams['maps']['mountain']['veg']>;
    city?: Partial<EditorParams['maps']['mountain']['city']>;
    lod?: Partial<EditorParams['maps']['mountain']['lod']>;
    fog?: Partial<EditorParams['fog']>;
    sky?: Partial<EditorParams['sky']>;
    quality?: Partial<EditorParams['quality']>;
    /** 编辑器调试选项(不导出,只切可视化层) */
    debug?: Partial<EditorParams['debug']>;
  }) {
    const map = this.params.maps[this.params.mapType];
    if (patch.terrain) Object.assign(map.terrain, patch.terrain);
    if (patch.material) Object.assign(map.material, patch.material);
    if (patch.veg) Object.assign(map.veg, patch.veg);
    if (patch.city) Object.assign(map.city, patch.city);
    if (patch.lod) Object.assign(map.lod, patch.lod);
    if (patch.fog) Object.assign(this.params.fog, patch.fog);
    if (patch.sky) Object.assign(this.params.sky, patch.sky);
    if (patch.quality) Object.assign(this.params.quality, patch.quality);
    if (patch.debug) Object.assign(this.params.debug, patch.debug);

    const heavyTerrain = patch.terrain && Object.keys(patch.terrain).some((k) => EditorWorld.TERRAIN_HEAVY.has(k));
    const heavySky = patch.sky && Object.keys(patch.sky).some((k) => EditorWorld.SKY_HEAVY.has(k));
    if (heavyTerrain) this.scheduleTerrainRebuild();
    if (patch.veg || patch.city) this.scheduleTerrainRebuild();
    if (heavySky) this.scheduleSkyRebuild();
    // 其余全部实时应用
    this.applyLiveParams();
    if (patch.lod) this.applyLodParams();
  }

  switchMap(type: EditorMapType) {
    if (this.params.mapType === type) return;
    this.params.mapType = type;
    this.scheduleTerrainRebuild();
    this.applyLiveParams();
  }

  private scheduleTerrainRebuild() {
    if (this.terrainRebuildTimer) clearTimeout(this.terrainRebuildTimer);
    this.terrainRebuildTimer = setTimeout(() => void this.rebuildWorld(false), 400);
  }
  private scheduleSkyRebuild() {
    if (this.skyRebuildTimer) clearTimeout(this.skyRebuildTimer);
    this.skyRebuildTimer = setTimeout(() => { this.rebuildSky(); this.applyLiveParams(); }, 250);
  }

  // =========================================================================
  // 天空 / 光照 / 雾
  // =========================================================================
  private buildCfg(): SkyConfig {
    const sky = this.params.sky;
    const cfg = applyWeather(getSkyConfig(sky.preset), sky.weather as never);
    // 编辑器太阳方向/强度覆盖
    const az = THREE.MathUtils.degToRad(sky.sunAzimuth);
    const el = THREE.MathUtils.degToRad(sky.sunElevation);
    cfg.sunPos.set(
      Math.sin(az) * Math.cos(el),
      Math.sin(el),
      Math.cos(az) * Math.cos(el),
    ).normalize();
    cfg.sunI = sky.sunIntensity;
    cfg.ambientI = sky.ambientIntensity;
    return cfg;
  }

  private rebuildSky() {
    const cfg = this.buildCfg();
    if (this.skyMesh) disposeObjectDeep(this.skyMesh);
    this.skyMesh = buildAtmosphericSky(cfg);
    this.scene.add(this.skyMesh);

    if (this.sunDisc) disposeObjectDeep(this.sunDisc);
    this.sunDisc = buildSunDisc(cfg, cfg.sunPos.y < 0.05);
    this.sunDisc.position.copy(cfg.sunPos).multiplyScalar(38000);
    this.scene.add(this.sunDisc);

    if (!this.sunLight) {
      this.sunLight = new THREE.DirectionalLight(cfg.sunColor, cfg.sunI);
      this.sunLight.name = 'EditorSun';
      this.sunLight.castShadow = true;
      this.sunLight.shadow.camera.near = 10;
      this.sunLight.shadow.camera.far = 40000;
      this.sunLight.shadow.camera.left = -2600;
      this.sunLight.shadow.camera.right = 2600;
      this.sunLight.shadow.camera.top = 2600;
      this.sunLight.shadow.camera.bottom = -2600;
      this.sunLight.shadow.bias = -0.0005;
      this.sunLight.shadow.normalBias = 0.02;
      this.scene.add(this.sunLight);
      this.scene.add(this.sunLight.target);
      this.hemiLight = new THREE.HemisphereLight(cfg.hemiSky, cfg.hemiGround, 0.6);
      this.scene.add(this.hemiLight);
    }
    this.sunLight.color.copy(cfg.sunColor);
    this.sunLight.intensity = cfg.sunI;
    this.sunLight.position.copy(cfg.sunPos).multiplyScalar(20000);
    this.hemiLight!.color.copy(cfg.hemiSky);
    this.hemiLight!.groundColor.copy(cfg.hemiGround);
    this.hemiLight!.intensity = 0.6;

    // 天光:PMREM 从大气天空生成(与游戏 setupSkyEnvironment 同源)
    if (this.skyMesh) this.probes.regenerateSkylightEnv(this.skyMesh);
    this.scene.environmentIntensity = THREE.MathUtils.clamp(cfg.ambientI * 0.8, 0.1, 1.5);
  }

  // =========================================================================
  // 地形 / 植被 / 城市 重建
  // =========================================================================
  private mapToTune(map: EditorMapParams): TuneMap {
    return {
      terrain: {
        size: map.terrain.size,
        segments: map.terrain.segments,
        maxHeight: map.terrain.maxHeight,
        seed: map.terrain.seed,
        mode: map.terrain.mode,
        snowLine: map.terrain.snowLine,
        islandFalloff: map.terrain.islandFalloff,
        islandRadius: map.terrain.islandRadius,
        rockColor: map.terrain.rockColor,
        grassColor: map.terrain.grassColor,
        sandColor: map.terrain.sandColor,
        snowColor: map.terrain.snowColor,
        terrainStyle: map.terrain.terrainStyle,
        zoneLowTop: map.terrain.zoneLowTop,
        zoneVegiTop: map.terrain.zoneVegiTop,
        zoneRockTop: map.terrain.zoneRockTop,
        zoneBandQ: map.terrain.zoneBandQ,
        zoneSnowEnabled: map.terrain.zoneSnowEnabled,
        bandMode: map.terrain.bandMode,
        bandLow: map.terrain.bandLow,
        bandVegi: map.terrain.bandVegi,
        bandRock: map.terrain.bandRock,
        aoStrength: map.terrain.aoStrength,
        aoRadius1: map.terrain.aoRadius1,
        aoRadius2: map.terrain.aoRadius2,
        aoDirs: map.terrain.aoDirs,
      },
      material: {
        tileSize: map.material.tileSize,
        wetTint: map.material.wetTint,
        wetLevel: map.material.wetLevel,
        normalScale: map.material.normalScale,
        macroAO: map.material.macroAO,
        slotScales: [...map.material.slotScales] as [number, number, number, number],
        sheetRough: { ...map.material.sheetRough },
        maskMode: map.material.maskMode,
      },
      veg: {
        ...map.veg,
        colorTune: { ...map.veg.colorTune },
        scaleTune: { ...map.veg.scaleTune },
      },
      city: {
        ...map.city,
        colorTune: {
          glass: { ...map.city.colorTune.glass },
          office: { ...map.city.colorTune.office },
          residential: { ...map.city.colorTune.residential },
          landmark: { ...map.city.colorTune.landmark },
        },
      },
      lod: { ...map.lod },
    };
  }

  async rebuildWorld(initial = false) {
    if (this.building) { this.pendingRebuild = true; return; }
    this.building = true;
    this.cb.onProgress?.(initial ? '初始化场景…' : '重建地形…');
    const map = this.params.maps[this.params.mapType];
    const cfg = this.buildCfg();

    // 释放旧环境层(放置物保留)
    for (const g of [this.terrainGroup, this.vegGroup, this.cityGroup, this.chunkOverlay, this.bandSliceGroup]) {
      if (g) disposeObjectDeep(g);
    }
    this.terrainGroup = null;
    this.vegGroup = null;
    this.cityGroup = null;
    this.chunkOverlay = null;
    this.bandSliceGroup = null;
    this.chunks = [];
    this.sampleHeight = null;
    this.terrainMat = null;
    this.survey = null;

    try {
      const tune = this.mapToTune(map);
      const maskEntry = this.maskEntryFor(this.params.mapType, map.terrain.size);
      // === Gaea/预制地形:外部高度源 + 顶点色远/近 (per user request) ===
      const mapType = this.params.mapType;
      const extGrid = this.externalGrids.get(mapType);
      const extVtx = this.externalVtx.get(mapType);
      const extMeta = map.external;
      const extNormal = this.externalNormalOf(mapType);
      const extAo = this.externalAoOf(mapType);
      const t = await buildHeightmapTerrain({
        tune,
        aoDirs: map.terrain.aoDirs,
        // === Mask Splatting:当前地图遮罩纹理(mode 由 tune.material.maskMode) ===
        maskTexture: maskEntry?.tex ?? null,
        ...(extGrid ? { heightAt: buildExternalHeightAt(extGrid) } : {}),
        ...(extGrid && extVtx && extMeta?.active
          ? { externalVertex: { tex: extVtx.tex, canonical: extVtx.canonical, mixNear: extMeta.mixNear ?? 1400, mixFar: extMeta.mixFar ?? 3400 } }
          : {}),
        // 004 烘焙法线(替换程序 relief,与游戏全盘 Gaea 同观感)
        ...(extGrid && extNormal && extMeta?.active ? { normalMap: extNormal } : {}),
        // 004 外部 AO(世界域灰图,按 indirect 乘,PBR)
        ...(extGrid && extAo && extMeta?.active ? { externalAo: extAo } : {}),
      });
      this.terrainGroup = t.group;
      this.chunks = t.chunks;
      this.sampleHeight = t.sampleHeight;
      this.terrainMat = t.material;
      this.survey = t.survey;
      // === 地形收/投影 (per user request: 编辑器缺阴影) ===
      // 地形网格默认不进阴影,太阳影/放置物影/山体自阴影都落不上来 → 显平。
      for (const c of this.chunks) {
        for (const m of c.meshes) { m.castShadow = true; m.receiveShadow = true; }
      }
      this.scene.add(this.terrainGroup);

      if (map.veg.enabled && this.sampleHeight) {
        this.vegGroup = buildTerrainForest(this.sampleHeight, { ...map.veg });
        // 植被实例参与阴影(alphaTest 剪裁树形)
        this.vegGroup.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
        });
        this.scene.add(this.vegGroup);
      }
      if (map.city.enabled) {
        this.cityGroup = buildCity(cfg, {
          size: map.city.size,
          blockSize: map.city.blockSize,
          seed: map.city.seed,
          colorTune: map.city.colorTune,
        });
        this.cityGroup.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
        });
        this.scene.add(this.cityGroup);
      }
      if (this.params.mapType !== 'desert') {
        if (this.ocean) disposeObjectDeep(this.ocean);
        this.ocean = buildOcean(cfg, Math.max(map.terrain.size * 1.8, 60000));
        this.ocean.userData.editorPlaceable = false;
        // 海洋不投/不收阴影(水面 shader 无阴影语义)
        this.ocean.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) { m.castShadow = false; m.receiveShadow = false; }
        });
        this.scene.add(this.ocean);
      }
      this.applyLiveParams();
      this.rebuildChunkOverlay();
      this.updateBandSlices();
      this.cb.onProgress?.(null);
    } catch (e) {
      console.error('[editor] rebuild failed:', e);
      this.cb.onProgress?.('重建失败,见控制台');
    } finally {
      this.building = false;
      // 重建期间又有新请求(项目载入/快速拖动)→ 收尾后再跑一轮
      if (this.pendingRebuild) {
        this.pendingRebuild = false;
        void this.rebuildWorld(false);
      }
    }
  }

  // =========================================================================
  // 实时参数(零重建)
  // =========================================================================
  private applyLiveParams() {
    const { fog, sky, quality } = this.params;
    const map = this.params.maps[this.params.mapType];

    // 雾
    const fogObj = this.scene.fog as THREE.FogExp2 | null;
    if (fogObj) {
      fogObj.color.set(fog.color);
      fogObj.density = fog.density;
    }
    (this.scene.background as THREE.Color).set(fog.color);
    this.renderer.toneMappingExposure = sky.toneExposure;

    // 太阳(光照与天空 shader 的 uSunDir)
    const cfg = this.buildCfg();
    if (this.sunLight) {
      this.sunLight.color.copy(cfg.sunColor);
      this.sunLight.intensity = cfg.sunI;
      this.sunLight.position.copy(cfg.sunPos).multiplyScalar(20000);
    }
    if (this.sunDisc) {
      this.sunDisc.position.copy(cfg.sunPos).multiplyScalar(38000);
    }
    if (this.skyMesh) {
      const u = (this.skyMesh.material as THREE.ShaderMaterial).uniforms;
      if (u.uSunDir) (u.uSunDir.value as THREE.Vector3).copy(cfg.sunPos);
      if (u.uSunColor) (u.uSunColor.value as THREE.Color).copy(cfg.sunColor).multiplyScalar(THREE.MathUtils.clamp(cfg.sunI, 0.15, 3.0));
    }

    // 分层材质 uniform(tune 句柄)
    const tu = this.terrainMat?.userData._tuneUniforms as
      | { uLayerRepeat?: { value: number }; uWetTint?: { value: number }; uWetLevel?: { value: number }; uMacroAO?: { value: number }; scales?: { value: number }[]; rough?: { value: number }[] }
      | undefined;
    if (tu) {
      if (tu.uLayerRepeat) tu.uLayerRepeat.value = 1 / map.material.tileSize;
      if (tu.uWetTint) tu.uWetTint.value = map.material.wetTint;
      if (tu.uWetLevel) tu.uWetLevel.value = map.material.wetLevel;
      if (tu.uMacroAO) tu.uMacroAO.value = map.material.macroAO >= 0 ? map.material.macroAO : map.terrain.aoStrength;
      for (let i = 0; i < 4; i++) {
        if (tu.scales?.[i]) tu.scales[i].value = map.material.slotScales[i];
        if (tu.rough?.[i]) {
          const sheet = ['dirt', 'grass', 'rock', 'snow'][i]; // 占位:真实 sheet 名在 preset 里
          tu.rough[i].value = map.material.sheetRough[sheet] ?? tu.rough[i].value;
        }
      }
    }
    if (this.terrainMat) {
      this.terrainMat.normalScale.set(map.material.normalScale, map.material.normalScale);
    }

    // bloom
    if (this.bloomPass) this.bloomPass.strength = quality.bloomStrength;
    if (quality.bloom && !this.composer) this.setupComposer();
    if (!quality.bloom && this.composer) this.teardownComposer();

    // === 场景阴影 (per user request: 加上场景阴影) ===
    this.renderer.shadowMap.enabled = quality.shadows.enabled;
    if (this.sunLight) {
      this.sunLight.castShadow = quality.shadows.enabled;
      this.sunLight.shadow.mapSize.set(quality.shadows.resolution, quality.shadows.resolution);
      this.sunLight.shadow.radius = quality.shadows.softness * 8;
    }

    // === Mask 实时切换(自动分层 ↔ 遮罩) ===
    const wantMask = map.material.maskMode;
    if (wantMask) {
      // 进入遮罩:无图 → 秒出粗预览可画 + 后台细化;有图 → 直接挂载。
      // (空遮罩全黑不能直接开)
      this.enterMaskMode(this.params.mapType);
    } else {
      this.applyMaskToMaterial(this.params.mapType, false);
    }

    // === 指数级高度雾(per user request: 所在高度/生效与变化范围) ===
    this.ensureHeightFog();

    this.updateBandSlices();
  }

  // =========================================================================
  // 指数级高度雾(per user request: 所在高度 + 生效/变化范围)
  // =========================================================================
  private ensureHeightFog() {
    const hf = this.params.fog.heightFog;
    const map = this.params.maps[this.params.mapType];
    if (!hf.enabled) {
      if (this.heightFogMesh) {
        disposeObjectDeep(this.heightFogMesh);
        this.heightFogMesh = null;
      }
      this.heightFogSize = 0;
      return;
    }
    const size = map.terrain.size;
    if (!this.heightFogMesh || this.heightFogSize !== size) {
      if (this.heightFogMesh) disposeObjectDeep(this.heightFogMesh);
      this.heightFogMesh = buildHeightFogVolume({
        color: hf.color,
        opacity: hf.opacity,
        baseHeight: hf.baseHeight,
        falloff: hf.falloff,
        startDistance: hf.startDistance,
        fadeEnd: hf.fadeEnd,
        size,
      });
      this.scene.add(this.heightFogMesh);
      this.heightFogSize = size;
    }
    const u = (this.heightFogMesh.material as THREE.ShaderMaterial).uniforms;
    (u.uColor.value as THREE.Color).set(hf.color);
    u.uOpacity.value = hf.opacity;
    u.uBase.value = hf.baseHeight;
    u.uFalloff.value = hf.falloff;
    u.uStart.value = hf.startDistance;
    u.uFadeEnd.value = hf.fadeEnd;
  }

  private applyLodParams() {
    // 只影响流式模拟参数,无重建
    this.streamLast = 0;
  }

  private setupComposer() {
    const size = this.renderer.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.flyCam.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), this.params.quality.bloomStrength, 0.6, 0.9);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
  }
  private teardownComposer() {
    this.composer?.dispose?.();
    this.composer = null;
    this.bloomPass = null;
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.flyCam.setAspect(w / Math.max(1, h));
    this.composer?.setSize(w, h);
  }

  // =========================================================================
  // LOD / 流式实验
  // =========================================================================
  private chunkCountPerSide() { return Math.round(Math.sqrt(Math.max(1, this.chunks.length))); }

  // =========================================================================
  // Mask Splatting(per user request: 自动分层 ↔ 遮罩;可自动生成 + 手绘)
  // =========================================================================
  private ensureMaskCanvas(mapType: string, res: number, size: number): MaskEntry {
    const key = `${mapType}@${res}@${Math.round(size)}`;
    const existing = this.maskStore.get(key);
    if (existing) return existing;
    for (const [k, v] of this.maskStore) {
      if (k.startsWith(mapType + '@')) { v.tex.dispose(); this.maskStore.delete(k); }
    }
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = res;
    const ctx = canvas.getContext('2d')!;
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 8;
    const entry: MaskEntry = { canvas, ctx, tex, res, size, strokes: 0 };
    this.maskStore.set(key, entry);
    return entry;
  }

  maskEntryFor(mapType: string, terrainSize: number): MaskEntry | null {
    for (const v of this.maskStore.values()) if (v.size === terrainSize) return v;
    return null;
  }
  maskTextureFor(mapType: string): THREE.Texture | null {
    for (const [k, v] of this.maskStore) if (k.startsWith(mapType + '@')) return v.tex;
    return null;
  }

  /** 恢复项目遮罩 PNG。 */
  async restoreMaskPng(mapType: string, dataUrl: string, res: number, terrainSize: number) {
    const entry = this.ensureMaskCanvas(mapType, res, terrainSize);
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('mask png decode failed'));
      img.src = dataUrl;
    });
    entry.ctx.clearRect(0, 0, entry.res, entry.res);
    entry.ctx.drawImage(img, 0, 0, entry.res, entry.res);
    entry.strokes = 0;
    entry.tex.needsUpdate = true;
  }

  maskPngDataUrl(mapType: string): string | null {
    for (const [k, v] of this.maskStore) {
      if (k.startsWith(mapType + '@')) return v.canvas.toDataURL('image/png');
    }
    return null;
  }

  /** 单像素权重 —— 与游戏 splat 共用 terrain-bands 统一解析器(无 jitter)。 */
  private maskWeights(mapType: string, h: number, slope: number): [number, number, number, number] {
    const rep = this.bandReportOf(mapType);
    if (!rep) return [0, 1, 0, 0];
    const t = this.params.maps[mapType]?.terrain;
    return applySlopeRock(bandWeightsAt(rep, h), slope, t ?? {});
  }

  /** 统一带报告(米边界 + 面积占比;quantile/relative/absolute 与游戏同源)。 */
  private bandReportOf(mapType: string): BandReport | null {
    const t = this.params.maps[mapType]?.terrain;
    if (!t || !this.survey) return null;
    const style = getMwamStyleCfg(t.terrainStyle);
    const anchors = style?.zones ?? {
      lowTop: t.zoneLowTop,
      vegiTop: t.zoneVegiTop,
      rockTop: t.zoneRockTop,
      snowEnabled: t.zoneSnowEnabled,
      bandQ: t.zoneBandQ,
    };
    const rep = resolveBands(mapType, anchors, t as unknown as BandTunables, this.survey, t.maxHeight ?? 2500);
    if (rep && this.survey.cache && this.survey.n) rep.area = bandAreaShare(rep, this.survey.cache, this.survey.n);
    return rep;
  }

  /**
   * 快速遮罩预览:先采 65×65 粗高度格(毫秒级),双线性插值铺满整张画布 ——
   * 进入遮罩模式立刻有画面可画,不必等全分辨率细化(数秒~十几秒)。
   */
  private async previewMaskNow(mapType: string): Promise<void> {
    if (!this.sampleHeight || !this.survey) return;
    const t = this.params.maps[mapType].terrain;
    const entry = this.ensureMaskCanvas(mapType, this.params.masks[mapType as EditorMapType].res, t.size);
    const { ctx, res, size } = entry;
    const G = 65;
    const hs = new Float32Array(G * G);
    for (let j = 0; j < G; j++) {
      const wz = ((j / (G - 1)) - 0.5) * size;
      for (let i = 0; i < G; i++) {
        const wx = ((i / (G - 1)) - 0.5) * size;
        hs[i + j * G] = this.sampleHeight(wx, wz);
      }
    }
    const img = ctx.createImageData(res, res);
    const d = img.data;
    const cell = size / (G - 1);
    for (let y = 0; y < res; y++) {
      const wz = ((y + 0.5) / res - 0.5) * size;
      const gy = THREE.MathUtils.clamp((wz + size / 2) / cell, 0, G - 1);
      const j0 = Math.min(G - 2, Math.floor(gy));
      const ty = gy - j0;
      for (let x = 0; x < res; x++) {
        const wx = ((x + 0.5) / res - 0.5) * size;
        const gx = THREE.MathUtils.clamp((wx + size / 2) / cell, 0, G - 1);
        const i0 = Math.min(G - 2, Math.floor(gx));
        const tx = gx - i0;
        const h00 = hs[i0 + j0 * G], h10 = hs[i0 + 1 + j0 * G], h01 = hs[i0 + (j0 + 1) * G], h11 = hs[i0 + 1 + (j0 + 1) * G];
        const h = h00 + (h10 - h00) * tx + (h01 - h00) * ty + (h11 - h10 - h01 + h00) * tx * ty;
        const dhx = (h10 - h00 + h11 - h01) / (2 * cell);
        const dhz = (h01 - h00 + h11 - h10) / (2 * cell);
        const slope = Math.max(Math.abs(dhx), Math.abs(dhz));
        const w = this.maskWeights(mapType, h, slope);
        const o = (y * res + x) * 4;
        d[o] = Math.round(w[0] * 255); d[o + 1] = Math.round(w[1] * 255); d[o + 2] = Math.round(w[2] * 255); d[o + 3] = Math.round(w[3] * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    entry.strokes = 0;
    entry.tex.needsUpdate = true;
  }

  /** 进入遮罩模式:立即出预览(可画)+ 后台全分辨率细化(细化不覆盖已手绘笔迹)。 */
  private enterMaskMode(mapType: string) {
    const map = this.params.maps[mapType];
    const entry = this.maskEntryFor(mapType, map.terrain.size);
    if (!entry) {
      void this.previewMaskNow(mapType as EditorMapType).then(() => {
        this.applyMaskToMaterial(mapType, true);
        if (!this.maskBusy.has(mapType)) void this.autoGenerateMask(mapType as EditorMapType, true);
      });
    } else {
      this.applyMaskToMaterial(mapType, true);
    }
  }

  /** 全分辨率自动生成/细化。refine=true 时即使有笔迹也会覆盖(显式“重新生成”)。 */
  async autoGenerateMask(mapType: EditorMapType, refine = false): Promise<THREE.CanvasTexture | null> {
    if (this.maskBusy.has(mapType)) return null;
    this.maskBusy.add(mapType);
    try {
      const map = this.params.maps[mapType];
      const t = map.terrain;
      const res = this.params.masks[mapType].res;
      if (!this.sampleHeight || !this.survey) return null;
      const entry = this.ensureMaskCanvas(mapType, res, t.size);
      if (entry.strokes > 0 && !refine) {
        console.warn('[editor] 检测到已有手绘笔迹,跳过自动覆盖(想重来请点“重置为自动”)');
        this.applyMaskToMaterial(mapType, true);
        return entry.tex;
      }
      const { ctx } = entry;
      const img = ctx.createImageData(res, res);
      const d = img.data;
      const size = t.size;
      for (let y = 0; y < res; y++) {
        const wz = ((y + 0.5) / res) * size - size / 2;
        for (let x = 0; x < res; x++) {
          const wx = ((x + 0.5) / res) * size - size / 2;
          const h = this.sampleHeight(wx, wz);
          const hX = this.sampleHeight(wx + 30, wz);
          const hZ = this.sampleHeight(wx, wz + 30);
          const slope = Math.max(Math.abs(h - hX) / 30, Math.abs(h - hZ) / 30);
          const w = this.maskWeights(mapType, h, slope);
          const o = (y * res + x) * 4;
          d[o] = Math.round(w[0] * 255); d[o + 1] = Math.round(w[1] * 255); d[o + 2] = Math.round(w[2] * 255); d[o + 3] = Math.round(w[3] * 255);
        }
        if (y % 128 === 0) {
          this.cb.onProgress?.(refine ? `细化遮罩 ${Math.round((y / res) * 100)}%` : `生成遮罩 ${Math.round((y / res) * 100)}%`);
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      ctx.putImageData(img, 0, 0);
      entry.strokes = 0;
      entry.tex.needsUpdate = true;
      this.applyMaskToMaterial(mapType, true);
      return entry.tex;
    } catch (e) {
      console.error('[editor] 自动生成遮罩失败:', e);
      this.cb.onProgress?.('遮罩生成失败,见控制台');
      return null;
    } finally {
      this.maskBusy.delete(mapType);
      this.cb.onProgress?.(null);
    }
  }

  /** 手绘:命中点按通道刷权重(UE 式 redistribute)。 */
  paintMask(mapType: string, world: THREE.Vector3, channel: number, radius: number, strength: number) {
    const map = this.params.maps[mapType];
    const entry = this.maskEntryFor(mapType, map.terrain.size)
      ?? this.ensureMaskCanvas(mapType, this.params.masks[mapType as EditorMapType].res, map.terrain.size);
    if (entry.strokes === 0 && this.maskBusy.has(mapType)) {
      console.warn('[editor] 遮罩正在生成/细化,稍等片刻再画(避免覆盖)');
      return;
    }
    entry.strokes++;
    const { ctx, res, size } = entry;
    const px = Math.round(((world.x + size / 2) / size) * (res - 1));
    const py = Math.round(((world.z + size / 2) / size) * (res - 1));
    const pr = Math.max(1, Math.ceil((radius / size) * res));
    const x0 = Math.max(0, px - pr);
    const y0 = Math.max(0, py - pr);
    const x1 = Math.min(res - 1, px + pr);
    const y1 = Math.min(res - 1, py + pr);
    if (x1 < x0 || y1 < y0) return;
    const img = ctx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
    const { data } = img;
    for (let yy = 0; yy < img.height; yy++) {
      for (let xx = 0; xx < img.width; xx++) {
        const wx = x0 + xx, wy = y0 + yy;
        const dist = Math.hypot(wx - px, wy - py) / pr;
        if (dist > 1) continue;
        const tt = 1 - dist;
        const fall = tt * tt * (3 - 2 * tt);
        const add = Math.min(1, strength * fall);
        const o = (yy * img.width + xx) * 4;
        for (let c = 0; c < 4; c++) { if (c !== channel) data[o + c] = Math.round(data[o + c] * (1 - add)); }
        data[o + channel] = Math.min(255, data[o + channel] + Math.round(add * 255));
      }
    }
    ctx.putImageData(img, x0, y0);
    entry.tex.needsUpdate = true;
    this.applyMaskToMaterial(mapType, true);
  }

  /** 把遮罩绑定到地形材质(权威状态;必要时重编译 —— 不依赖 live uniform 捕获)。 */
  applyMaskToMaterial(mapType: string, on: boolean) {
    const mat = this.terrainMat;
    if (!mat) return;
    const entry = this.maskEntryFor(mapType, this.params.maps[mapType].terrain.size);
    const state = mat.userData._maskState as { on: number; tex: THREE.Texture } | undefined;
    if (!state) {
      mat.userData._maskState = { on: on ? 1 : 0, tex: entry?.tex ?? new THREE.Texture() };
      return;
    }
    const changed = state.on !== (on ? 1 : 0) || (on && entry && state.tex !== entry.tex);
    state.on = on ? 1 : 0;
    if (on && entry) state.tex = entry.tex;
    const tu = mat.userData._tuneUniforms as
      | { mask?: { on: { value: number }; tex: { value: THREE.Texture } } } | undefined;
    if (tu?.mask) { tu.mask.on.value = state.on; tu.mask.tex.value = entry?.tex ?? state.tex; }
    if (changed) mat.needsUpdate = true;
  }

  /** 屏幕坐标 → 地形命中点 → 刷权重。返回是否命中。 */
  paintAtPointer(ndcX: number, ndcY: number, channel: number, radius: number, strength: number): boolean {
    if (!this.terrainGroup || !this.params.maps[this.params.mapType].material.maskMode) return false;
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.flyCam.camera);
    this.raycaster.far = 400000;
    const hits = this.raycaster.intersectObjects(this.terrainGroup.children, false);
    if (!hits.length) return false;
    this.paintMask(this.params.mapType, hits[0].point, channel, radius, strength);
    return true;
  }

  // 分层高度切片可视化 (per user request: 多山峰时分层基准落在哪个平面高度)
  // =========================================================================

  /** 三个分层边界当前高度(米):三模式都走统一解析器(游戏同源)。 */
  bandHeights(): { low: number; vegi: number; rock: number } | null {
    const rep = this.bandReportOf(this.params.mapType);
    return rep ? { low: rep.low, vegi: rep.vegi, rock: rep.rock } : null;
  }

  private updateBandSlices() {
    if (!this.bandSliceGroup) {
      this.bandSliceGroup = new THREE.Group();
      this.bandSliceGroup.name = 'BandSlices';
      const size = 100000;
      const colors = ['#e8d8a8', '#6a8a4a', '#8a8a86']; // 沙/草/岩 边界色
      for (let i = 0; i < 3; i++) {
        const m = new THREE.Mesh(
          new THREE.PlaneGeometry(size, size),
          new THREE.MeshBasicMaterial({ color: colors[i], side: THREE.DoubleSide, transparent: true, opacity: 0.12, depthWrite: false }),
        );
        m.rotation.x = -Math.PI / 2;
        m.renderOrder = 500;
        m.userData.editorPlaceable = false;
        m.userData.sliceIndex = i;
        this.bandSliceGroup.add(m);
      }
      this.scene.add(this.bandSliceGroup);
    }
    const h = this.bandHeights();
    const vals = h ? [h.low, h.vegi, h.rock] : [0, 0, 0];
    const show = this.params.debug.showBandSlices && !!h;
    this.bandSliceGroup.children.forEach((c, i) => {
      (c as THREE.Mesh).position.y = vals[i];
      c.visible = show;
    });
  }

  private rebuildChunkOverlay() {
    if (this.chunkOverlay) disposeObjectDeep(this.chunkOverlay);
    this.chunkOverlay = new THREE.Group();
    this.chunkOverlay.name = 'ChunkOverlay';
    const n = this.chunkCountPerSide();
    const chunkSize = (this.params.maps[this.params.mapType].terrain.size) / n;
    const colors = [0x22ff66, 0xffcc22, 0xff8833, 0xff3344]; // LOD0..3
    for (const c of this.chunks) {
      const half = chunkSize / 2;
      const geo = new THREE.BoxGeometry(chunkSize, 1, chunkSize);
      const mat = new THREE.MeshBasicMaterial({ color: colors[0], wireframe: true, transparent: true, opacity: 0.6, depthTest: false });
      const m = new THREE.Mesh(geo, mat);
      m.position.set(c.center.x, 0, c.center.z);
      m.userData.editorPlaceable = false;
      m.userData.chunkRef = c;
      this.chunkOverlay!.add(m);
      void half;
    }
    this.chunkOverlay.visible = this.params.maps[this.params.mapType].lod.showChunkOverlay;
    this.scene.add(this.chunkOverlay);
  }

  /** 环形流式模拟(与游戏 updateTerrainStreaming 同规则的精简版) */
  private streamChunks() {
    const lod = this.params.maps[this.params.mapType].lod;
    const n = this.chunkCountPerSide();
    if (!this.chunks.length) return;
    const cam = this.flyCam.camera.position;
    const map = this.params.maps[this.params.mapType];
    const chunkSize = map.terrain.size / n;
    const cgx = Math.floor((cam.x + map.terrain.size / 2) / chunkSize);
    const cgz = Math.floor((cam.z + map.terrain.size / 2) / chunkSize);
    const byKey = new Map(this.chunks.map((c) => [`${c.gx},${c.gz}`, c]));
    const levelOf = (c: TerrainChunkInfo): number => {
      if (!lod.streaming) return 0;
      const gd = Math.max(Math.abs(c.gx - cgx), Math.abs(c.gz - cgz));
      const s = lod.lodScale;
      return gd <= lod.lod0Radius ? 0 : gd <= lod.lod0Radius + 2 * s ? 1 : gd <= lod.lod0Radius + 4 * s ? 2 : 3;
    };
    const levels = new Map(this.chunks.map((c) => [c, levelOf(c)]));
    for (const c of this.chunks) {
      const level = levels.get(c)!;
      c.meshes.forEach((m, i) => { m.visible = i === level; });
      const neighbors = [
        byKey.get(`${c.gx},${c.gz + 1}`), // N
        byKey.get(`${c.gx + 1},${c.gz}`), // E
        byKey.get(`${c.gx},${c.gz - 1}`), // S
        byKey.get(`${c.gx - 1},${c.gz}`), // W
      ].map((nb) => (nb ? { chunk: nb as never, level: levels.get(nb)! } : null));
      c.setLOD?.(level, neighbors);
    }
    // overlay 染色
    const colors = [0x22ff66, 0xffcc22, 0xff8833, 0xff3344];
    this.chunkOverlay?.children.forEach((m) => {
      const ref = m.userData.chunkRef as TerrainChunkInfo | undefined;
      if (ref) (m as THREE.Mesh).material = new THREE.MeshBasicMaterial({ color: colors[levels.get(ref) ?? 0], wireframe: true, transparent: true, opacity: 0.6, depthTest: false });
    });
  }

  // =========================================================================
  // 放置 / 选择
  // =========================================================================
  async placeFromPalette(def: string): Promise<EditorActor | null> {
    const entry = findPaletteDef(def);
    if (!entry) return null;
    const ray = this.flyCam.rayFromCenter(this.scene, this.raycaster);
    const cfg = this.buildCfg();
    const obj = await entry.build({ cfg, pos: ray.point });
    // 放置物不参与地面拾取遮挡自身;参与阴影
    obj.traverse((o) => {
      o.userData.editorPlaceable = false;
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
    });
    obj.position.copy(ray.point);
    if (this.sampleHeight && !ray.hit) {
      obj.position.y = this.sampleHeight(obj.position.x, obj.position.z);
    }
    const actor = this.actors.add(def, obj);
    obj.userData.actorId = actor.id;
    obj.userData.actorName = actor.name;
    this.scene.add(obj);

    // 探针类:注册到 ProbesManager
    if (obj.userData.probeKind === 'reflection') {
      this.probes.registerReflection(obj as THREE.Group, { radius: 6000 });
    }
    this.select(actor.id);
    return actor;
  }

  select(id: string | null) {
    const actor = id ? this.actors.get(id) : null;
    const obj = actor ? this.scene.getObjectByProperty('actorId', actor.id) : null;
    if (obj) {
      this.gizmo.attach(obj, (o) => this.actors.syncFromObject(actor!.id, o));
      this.flyCam.focusAt(obj.getWorldPosition(new THREE.Vector3()), 800);
    } else {
      this.gizmo.detach();
    }
    this.cb.onSelectionChanged?.(actor ?? null);
  }

  deleteSelected() {
    const obj = this.gizmo.controls.object;
    if (!obj) return;
    const id = obj.userData.actorId as string | undefined;
    const cap = this.probes.reflections.find((r) => r.root === obj);
    if (cap) this.probes.unregisterReflection(cap);
    this.gizmo.detach();
    disposeObjectDeep(obj);
    if (id) this.actors.remove(id);
    this.cb.onSelectionChanged?.(null);
  }

  getObjectByActorId(id: string) { return this.scene.getObjectByProperty('actorId', id); }

  /** 项目文件载入:重建放置物(其余 params 由 React 层恢复)。 */
  async loadActors(list: EditorActor[]) {
    // 清除现有放置物
    for (const a of [...this.actors.actors]) {
      const o = this.getObjectByActorId(a.id);
      if (o) disposeObjectDeep(o);
    }
    this.actors.load([]);
    this.gizmo.detach();
    for (const a of list) {
      const entry = findPaletteDef(a.def);
      if (!entry) continue;
      try {
        const obj = await entry.build({ cfg: this.buildCfg(), pos: new THREE.Vector3(...a.position) });
        obj.traverse((o) => {
          o.userData.editorPlaceable = false;
          const m = o as THREE.Mesh;
          if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
        });
        obj.position.set(...a.position);
        obj.quaternion.set(...a.quaternion);
        obj.scale.set(...a.scale);
        obj.userData.actorId = a.id;
        obj.userData.actorName = a.name;
        this.scene.add(obj);
        this.actors.actors.push(a);
        if (obj.userData.probeKind === 'reflection') {
          this.probes.registerReflection(obj as THREE.Group, { radius: (a.extra?.radius as number) ?? 6000 });
        }
      } catch (e) {
        console.warn('[editor] 载入放置物失败', a.def, e);
      }
    }
  }

  // =========================================================================
  // 主循环
  // =========================================================================
  render(dt: number) {
    if (this.disposed) return;
    this.flyCam.update(dt);
    // === 阴影盒跟随编辑器相机(texel 对齐防移动闪烁,per user request) ===
    if (this.sunLight && this.params.quality.shadows.enabled) {
      const cfg = this.buildCfg();
      const cam = this.flyCam.camera;
      const half = 2600;
      const res = this.params.quality.shadows.resolution;
      const wpt = (half * 2) / res;
      const sx = Math.round(cam.position.x / wpt) * wpt;
      const sz = Math.round(cam.position.z / wpt) * wpt;
      const target = this.sunLight.target.position.set(sx, cam.position.y, sz);
      this.sunLight.position.copy(target).addScaledVector(cfg.sunPos, 15000);
      this.sunLight.target.updateMatrixWorld();
      this.sunLight.shadow.camera.updateProjectionMatrix();
    }
    // 流式模拟节流 0.2s
    this.streamLast += dt;
    if (this.streamLast >= 0.2) {
      this.streamLast = 0;
      this.streamChunks();
    }
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.flyCam.camera);

    // 统计(0.5s 一次)
    this.fpsAccum += dt;
    this.fpsFrames++;
    this.statsTimer += dt;
    if (this.statsTimer >= 0.5) {
      this.lastFps = this.fpsFrames / Math.max(0.001, this.fpsAccum);
      this.fpsAccum = 0;
      this.fpsFrames = 0;
      this.statsTimer = 0;
      let visibleChunks = 0;
      let instanced = 0;
      this.scene.traverse((o) => {
        if (o instanceof THREE.InstancedMesh) instanced += o.count ?? 0;
      });
      for (const c of this.chunks) for (const m of c.meshes) if (m.visible) { visibleChunks++; break; }
      this.cb.onStats?.({
        fps: this.lastFps,
        drawCalls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
        visibleChunks,
        totalChunks: this.chunks.length,
        instanced,
        vramMB: getTextureManager().totalVRAM() / 1048576,
        camSpeed: this.flyCam.speed,
      });
    }
  }

  dispose() {
    this.disposed = true;
    if (this.terrainRebuildTimer) clearTimeout(this.terrainRebuildTimer);
    if (this.skyRebuildTimer) clearTimeout(this.skyRebuildTimer);
    this.gizmo.detach();
    this.probes.dispose();
    this.teardownComposer();
    for (const g of [this.terrainGroup, this.vegGroup, this.cityGroup, this.chunkOverlay, this.bandSliceGroup, this.heightFogMesh, this.skyMesh, this.sunDisc, this.ocean]) {
      if (g) disposeObjectDeep(g);
    }
    for (const v of this.maskStore.values()) v.tex.dispose();
    this.maskStore.clear();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && o.userData.actorId) disposeObjectDeep(o);
    });
    getTextureManager().clearAll();
    this.renderer.dispose();
  }
}
