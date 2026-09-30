import * as THREE from 'three';
import { loadAircraftGeometry, buildAircraftMesh, buildAfterburner, setAfterburner, AircraftGeometryInfo, buildControlSurfaces, AFTERBURNER_PLUME_Y_OFFSET, hasAfterburner } from './models';
import { deriveNozzleMetrics } from './nozzle-metrics';
import { applyNozzleAlign } from './afterburner-vfx';
import { buildSkyDome, buildOcean, buildCloudField, getSkyConfig } from './environment';
// === 机棚布景(地坪/墙体/顶棚桁架/灯具/道具 + 布景灯) ===
// 场景内容全部搬去 hangar-bay.ts: 详见该文件的头部说明(实例化/draw call/回收)。
import { buildHangarBay, HANGAR_BAY_CEIL_Y, HANGAR_BAY_FLOOR_Y } from '@/components/game/hangar-bay';
// === Blender 烘焙机库 (per user request: 用 Blender 资产替换程序化布景) =========
// 几何 + 扫描 PBR 贴图 + 4096² 光照贴图, 全部由 blender/hangar/ 导出并登记在
// asset-library.json(copy=true / inline=false, 随 assets/ 发布)。
// 程序化布景仍然保留: 它立即可用、且是 file:// 或资产缺失时的兜底 —— 加载成功
// 后才替换, 所以机库任何情况下都不会是空的。
import { loadGLB, disposeTree, type LoadedGLB } from './glb-asset';
import { loadImageTexture } from './fetch-asset';
import { assetUrl } from './asset-url';

const BAKED_BAY_GLB = '/models/hangar/hangar_baked.glb';
const BAKED_BAY_LIGHTMAP = '/models/hangar/lightmap.webp';
/**
 * 烘焙光照贴图的显示强度。
 *
 * 为什么是 π 的倍数而不是 1: three 的 MeshBasicMaterial 片元里是
 *   `indirectDiffuse += lightMapTexel.rgb * lightMapIntensity * RECIPROCAL_PI`
 * (meshbasic.glsl.js 里那行 `* RECIPROCAL_PI`) —— **默认会再除一个 π**。
 * 图集是 `70_bake.py` 归一化(p99→0.95)后的**线性照度**, 所以要乘回 π 才等于"原值"。
 *
 * 为什么要再乘一个曝光系数: 舱内照度物理上只有门口阳光带的约 1%(p99 已归一化),
 * 而游戏的整体曝光是按户外白天定的 ⇒ 直接按原值显示, 整个舱内会压成黑。
 * Blender 预览当年看着亮, 是因为那边的胶片曝光(exposure -3.0 那一套)。
 * 这个系数就是补这段曝光差; 阳光带会过曝到纯白 —— 那正是"从门口打进来的一束光"
 * 该有的样子。
 */
const BAY_LIGHTMAP_INTENSITY = Math.PI * 5;
/** 灯具透镜的"在发光"亮度(basic 材质没有 emissive 通道, 用颜色代替)。 */
const BAY_LAMP_GLOW = 2.2;

// === 机库天空 + 太阳 (per user request: 以天空盒确定太阳方向与投影) ===========
// 这两个值与 blender/hangar/20_preview.py 里的 SUN_ELEVATION / SUN_ROTATION 是
// **配对的**: Blender 那边用 sun_rotation=180 把太阳放到大门那侧(-Y), 换到这里
// 是 +Z。改一边必须改另一边, 否则实时投影会和烘进光照贴图里的天光方向错开。
const BAY_SKY_PRESET = 'day' as const;
const BAY_SUN_ELEV_DEG = 25;
const BAY_SUN_ELEV_RAD = (BAY_SUN_ELEV_DEG * Math.PI) / 180;
import { ALL_MODELS } from './aircraft-catalog';
import type { AircraftModel } from './types';
// === PBR 纹理管理 (per user request: 显存回收) ===
import { getTextureManager } from './pbr/texture-manager';

/**
 * 把烘焙机库的材质换成"只吃光照贴图、完全不参与实时着色"的 MeshBasicMaterial。
 *
 * 为什么必须换材质而不是靠图层隔离: three 没有逐物体的灯光遮罩(灯光图层过滤是逐
 * 相机的), 详见 swapInBakedBay 里的长注释。
 *
 * 注意: **不要 dispose 原材质** —— 它的贴图(尤其 map)会被新材质继续引用。
 */
function bakeOnlyMaterial(src: THREE.Material, lightMap: THREE.Texture | null): THREE.Material {
  const std = src as THREE.MeshStandardMaterial;
  if (!(std as unknown as { isMeshStandardMaterial?: boolean }).isMeshStandardMaterial) return src;
  // 灯具透镜: Blender 侧它靠 emissive 发光(烘焙时强度 260), 而 basic 没有 emissive
  // 通道。也**不能**给它挂 lightMap —— 透镜处收到的那份烘焙值很小, 乘上去会把
  // "灯在亮"压成灰。直接用颜色表达"在发光"。
  if (std.name && std.name.startsWith('HG_LampLens')) {
    return new THREE.MeshBasicMaterial({
      color: new THREE.Color(1.0, 0.97, 0.92).multiplyScalar(BAY_LAMP_GLOW),
      side: std.side,
      fog: true,
    });
  }
  const basic = new THREE.MeshBasicMaterial({
    map: std.map ?? null,
    lightMap: lightMap ?? null,
    lightMapIntensity: BAY_LIGHTMAP_INTENSITY,
    color: std.color ? std.color.clone() : new THREE.Color(0xffffff),
    side: std.side,
    transparent: std.transparent,
    opacity: std.opacity,
    alphaTest: std.alphaTest,
    depthWrite: std.depthWrite,
    vertexColors: std.vertexColors,
    fog: true,
  });
  basic.name = std.name;
  return basic;
}

export class HangarViewer {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  /** 调试用: 暴露给 window.__hangar 后由控制台读取。 */
  readonly rendererRef = () => this.renderer;
  readonly sceneRef = () => this.scene;
  // === Blender 烘焙机库 (per user request) ===
  // 程序化布景先挂上去, Blender 资产加载成功后替换; 失败则一直用程序化版。
  // (程序化布景字段已删除: 机库只用 Blender 烘焙版 —— per user request)
  private bakedBay: LoadedGLB | null = null;
  // === 机库天空 + 太阳 (与关卡同一套: cfg 是单一来源) ===
  private sunLight!: THREE.DirectionalLight;
  private baySky: THREE.Mesh | null = null;
  private baySkyCfg: import('./environment').SkyConfig | null = null;
  /** PMREM 天光烘出来的渲染目标, 退出时必须 release, 否则一张环境贴图漏在显存。 */
  private bayEnvRT: THREE.WebGLRenderTarget | null = null;
  private camera: THREE.PerspectiveCamera;
  private raf = 0;
  private lastT = 0;
  // === PC FPS cap (per user request: 最大帧率限制) ===
  private fpsCap = 0;
  private lastCapT = 0;
  private geomCache: Partial<Record<AircraftModel, AircraftGeometryInfo>> = {};
  private currentMesh: THREE.Group | null = null;
  // === MiG-29 多材质真实模型 (per user request: 加入机库) ===
  private mig29Model: import('./mig29').Mig29Model | null = null;
  // === F-16C 真实模型 (per user request: 完全替换原 F-16) ===
  // 玩家默认机 = F-16C,机库初始化时预加载(资产已内联,file:// 也能加载),
  // 这样点开默认卡片直接看到真实贴图机体。
  private f16cModel: import('./f16c').F16cModel | null = null;
  private migSurfaces: { ailerons: THREE.Mesh[]; elevators: THREE.Mesh[]; rudders: THREE.Mesh[] } | null = null;
  // === Movable control surfaces (per user request: F-16X 可动舵面实验机) ===
  // Set when the F-16X is shown — the loop wiggles them as a self-demo.
  private ctrlSurfaces: { aileronL: THREE.Mesh; aileronR: THREE.Mesh; elevator: THREE.Mesh; rudder: THREE.Mesh } | null = null;
  private afterburner!: THREE.Group;
  private oceanMat!: THREE.ShaderMaterial;
  /** show() 的世代号: 并发调用时只有最后一次允许把机体放回场景(见 show 说明)。 */
  private showGen = 0;
  private yaw = 0;
  private targetYaw = 0;
  private pitch = -0.06;
  private targetPitch = -0.06;
  private dist = 38;
  // === 预览放大 2 倍 (per user request: 机库的所有飞机都放大 2 倍大小) ============
  // 机体本身 x PREVIEW_SCALE, 相机距离也同步拉开(否则放大后直接被裁掉)。
  private static readonly PREVIEW_SCALE = 2;
  /** 预览整体抬高(米): 飞机不再坐在甲板上 */
  private static readonly HANGAR_LIFT = 9;
  private targetDist = 38 * HangarViewer.PREVIEW_SCALE;
  private autoRotate = true;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private spotLight!: THREE.SpotLight;
  private spotTarget!: THREE.Object3D;
  // === Frame-centre offset (per user request: 机库调视野中心) ===
  // The aircraft's view-centre position, tuned in the hangar: x/y/z in WORLD
  // UNITS for the mouse-aim camera (a world-fixed invisible ball that only
  // follows the aircraft's position, never its rotation) or a camera-frame
  // screen offset for the traditional chase camera. worldFixed selects which
  // preview math to use. The hangar camera orbits the view centre and a
  // marker ball sits exactly on it.
  private frameCenter = { x: 0, y: 0, z: 0 };
  private frameWorldFixed = true;
  private centreBall: THREE.Mesh | null = null;
  private tmpF = new THREE.Vector3();
  private tmpR = new THREE.Vector3();
  private tmpU = new THREE.Vector3();
  private tmpWU = new THREE.Vector3(0, 1, 0);
  private tmpLT = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // 调试句柄: 与 window.__engine 同思路 —— 机库出问题(光照/贴图/阴影)时
    // 能直接从控制台读内部状态, 不用靠截图猜。
    //   __hangar.scene / __hangar.sunLight / __hangar.renderer
    (window as unknown as { __hangar?: HangarViewer }).__hangar = this;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x0a0e14, 0.002);
    this.camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.5, 8000);
    this.camera.position.set(0, 6, 38);
    this.camera.lookAt(0, 0, 0);
    // === 调试挂钩 (per user request: 机库黑屏排查) ===
    // 与引擎的 window.__engine 同一套思路: 自动化验证要能读机库内部状态(模型加载
    // 出来没有、场景里挂了什么、相机在哪、画了多少个 draw call), 否则"黑屏"只能靠猜。
    try { (window as unknown as Record<string, unknown>).__hangar = this; } catch { /* ignore */ }
    // === PC FPS cap (per user request: 最大帧率限制) ===
    try {
      const cap = parseInt(localStorage.getItem('skybound.fpsCap') ?? '0', 10);
      this.fpsCap = [0, 30, 60, 120, 144].includes(cap) ? cap : 0;
    } catch { this.fpsCap = 0; }
    getTextureManager().refresh();
    getTextureManager().attachRenderer(this.renderer);
  }

  async init() {
    // === Use Promise.allSettled + timeout safety net (per user request: 机库模型加载不出来) ===
    // Previously used Promise.all — if ANY single model rejected, the whole
    // init() rejected, the `setLoading(false)` callback in Hangar.tsx never
    // fired, and the user was stuck on the "LOADING MODELS" overlay forever.
    //
    // Now we use Promise.allSettled so each model loads independently.
    // Failures (which shouldn't happen now that OBJ loading is disabled)
    // produce a console warning but don't block init.
    //
    // We also add a hard 5-second safety timeout — if for any reason the
    // model loading hangs (network glitch, browser bug, etc.), we still
    // hide the loading overlay so the user can interact with the hangar.
    const models: AircraftModel[] = ALL_MODELS.filter((m) => m !== 'mig29');
    const results = await Promise.allSettled(models.map((m) => loadAircraftGeometry(m)));
    for (let i = 0; i < models.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        this.geomCache[models[i]] = r.value;
      } else {
        console.warn(`[hangar] loadAircraftGeometry rejected for ${models[i]}:`, r.reason);
      }
    }
    // === MiG-29 多材质真实模型 (per user request: 加入机库 + 分段加载) ===
    // 不再无条件预加载 —— 玩家点击 MiG-29 卡片时才按需从外部资产库加载
    // (ensureMig29),玩 f16/b52 等基础机体零额外下载。
    // === F-16C 真实模型 (per user request: 完全替换原 F-16) ===
    // 例外:默认玩家机就是 F-16C,资产已内联进单文件 —— 机库直接把真实模型
    // 预加载出来,否则第一眼看到的会是程序化涂装的合并几何。失败不阻断
    // (show() 会回退 geomCache 里的同一副机体几何)。
    try {
      const { loadF16cModel } = await import('./f16c');
      this.f16cModel = await loadF16cModel();
    } catch (err) {
      console.warn('[hangar] F-16C 真实模型加载失败,回退合并几何:', err);
      this.f16cModel = null;
    }
    this.buildEnvironment();
    this.buildCentreBall();
    this.attachInput();
    this.lastT = performance.now();
    this.loop();
  }

  // === View-centre marker ball (per user request: 机库调视野中心给个小球) ===
  // A small glowing sphere at the aircraft's view-centre point so the player
  // can SEE where the tuned frame-centre is while nudging it around — instead
  // of blind-tuning an invisible offset. Additive + depthWrite off so it
  // glows through the fuselage when it sits inside the model.
  private buildCentreBall() {
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.9, 16, 12),
      new THREE.MeshBasicMaterial({
        color: 0x66eeff,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    ball.renderOrder = 999;
    this.scene.add(ball);
    this.centreBall = ball;
  }

  /** 后燃器: 与引擎同一条路径 —— 先从模型量出喷口(位置/口径), 再叠加控制台 nozzle 的微调。
   *  这样机库里看到的火焰大小/位置与关卡内一致, 在这里试出来的数就能直接用。 */
  private buildAb(info: AircraftGeometryInfo, scale: number) {
    const axes = info.enginePositions.map((p) => new THREE.Vector3(p.x, p.y + AFTERBURNER_PLUME_Y_OFFSET, p.z));
    const ab = buildAfterburner(info.enginePositions.map((p) => p.clone()), deriveNozzleMetrics(info, axes));
    applyNozzleAlign(ab, scale);
    return ab;
  }

  private buildEnvironment() {
    // === 机库光照对齐 Blender (per user request) ============================
    // 原来这套是"红光 + 没有天空球"的旧配置: 一盏橙红轮廓光 + 一盏跟拍聚光 +
    // 一张 storm 天空烘的 IBL。它和 Blender 里那个"物理天空 + 低角度阳光穿过
    // 大门"的场景对不上 —— 那道阳光是机库观感的主体。
    //
    // 现在照**关卡同一条路**来: 一个 SkyConfig 当单一来源, 天空穹顶 / 平行光 /
    // 阴影相机 / IBL 全从它派生。改天空预设, 太阳方向和光色就一起变。
    this.scene.background = new THREE.Color(0x0b0f15);
    // === 程序化布景**整段删除** (per user request: 原本程序化生成的机库完全被新机库替换掉) ====
    // 原来是"程序化先顶上、烘焙版加载好再替换"的兜底; 现在烘焙资产内联在单文件里(§251),
    // 它才是唯一真源。留着兜底只会造成"两个机库"的困惑 + 多余开销, 所以去掉:
    // 万一加载失败就是空场景 + 一条警告(而不是悄悄变回旧机库)。
    void this.swapInBakedBay();

    // === 天空 ==============================================================
    const cfg = getSkyConfig(BAY_SKY_PRESET);
    // 太阳方位: 关卡的 day 预设太阳在 -Z, 也就是**背墙外侧** —— 光进不了门。
    // 必须覆盖成 Blender 的那个角度: 高度角 25°、方位正对大门(+Z 侧)。
    // Blender 那边我用的是同一个值, 两边的光带才能落在同一处。
    cfg.sunPos.set(0, Math.sin(BAY_SUN_ELEV_RAD), Math.cos(BAY_SUN_ELEV_RAD))
      .normalize();
    this.baySkyCfg = cfg;
    // 机库是封闭舱室, 但门洞 110×24m 是敞开的, 天空穹顶挂上去只从门里看得到
    // —— 那正是阳光和天光的来源, 不能省。
    this.baySky = buildSkyDome(cfg, 3000);
    this.scene.add(this.baySky);

    // === 太阳平行光 + 阴影 (与关卡同一套做法) ================================
    this.sunLight = new THREE.DirectionalLight(cfg.sunColor, cfg.sunI);
    this.sunLight.position.copy(cfg.sunPos.clone().multiplyScalar(600));
    this.sunLight.target.position.set(0, 0, 0);
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);
    // 阴影相机: 机库场景很小(184m 见方), 所以正交半宽收到 90 —— 阴影贴图
    // 的纹素全砸在舱内, 机体在地面上的投影才清楚。关卡那边是 ±4000(飞行区
    // 几公里), 直接抄会用不到 1% 的纹素。
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    const sc = this.sunLight.shadow.camera as THREE.OrthographicCamera;
    sc.near = 1;
    sc.far = 2000;
    const sd = 90;
    sc.left = -sd;
    sc.right = sd;
    sc.top = sd;
    sc.bottom = -sd;
    this.sunLight.shadow.bias = -0.0005;
    this.sunLight.shadow.normalBias = 0.08;   // 与关卡同值: 机体的薄机身自阴影
    sc.updateProjectionMatrix();
    this.renderer.shadowMap.enabled = true;
    // three r185 只有 PCFShadowMap / VSMShadowMap 两种有映射, PCFSoft 会被静默
    // 降级成 BASIC(关卡那边踩过)。用 PCF。
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    // === 跟拍主光(保留, 但弱化) =============================================
    // 现在有方向明确、有阴影的太阳当主光, 这盏跟拍灯退回到"相机转到机体背面时
    // 的补光"角色, 强度从 60 降到 22, 免得把太阳的明暗关系冲掉。
    this.spotLight = new THREE.SpotLight(0xfff0d0, 22, 200, Math.PI / 6, 0.55, 1);
    this.spotLight.position.set(15, 40, 25);
    this.spotTarget = new THREE.Object3D();
    this.scene.add(this.spotTarget);
    this.spotLight.target = this.spotTarget;
    this.scene.add(this.spotLight);

    // === 天光 IBL ==========================================================
    // F-16C / MiG-29 是高金属度 PBR: 金属没有漫反射项, 只吃直接光与环境反射。
    // 机库"暗不溜秋"的根因就是这里漏了 scene.environment —— 加多少盏灯都救不回来。
    // 用**同一个 cfg** 烘, 太阳角度变了这里也跟着变, 机体金属反射的底才和天空一致。
    // 注意: 这一步发生在烘焙机库**加载完之前**, 所以先用"只有天空"的版本兜底;
    // 机库就绪后 `swapInBakedBay` 会调 `bakeHangarEnv()` 重烘一次(见那里的说明)。
    try {
      this.scene.environment = this.bakeEnvFrom([buildSkyDome(cfg, 3000)]);
      this.scene.environmentIntensity = 1.0;
    } catch (err) {
      console.warn('[hangar] 天光环境烘焙失败(机体可能偏暗):', err);
    }
  }

  /**
   * 把一个物体集合烘成 PMREM 环境贴图(返回 render target, 调用方负责 dispose/保存)。
   *
   * 为什么要这一步: `scene.environment` 原来**只**包含天空盒 ⇒ 机体在舱内反射/接收的
   * 天光其实是"室外天空", 与舱内环境对不上(用户: *"飞机在机库内的天光捕获仍然是捕获的
   * 天空盒, 能不能让它捕获机库内的环境"*)。
   * 烘焙机库的材质被换成了 MeshBasicMaterial(纯烘焙色, 不吃实时光), 所以**把机库渲进
   * cubemap 得到的就是舱内环境本身**(墙面/地坪/顶棚/灯具/门口那束光都在里面) —— 这正是
   * 机库版 IBL 需要的输入。克隆一份机库进临时场景: 几何与材质是**共享**的, 不额外吃显存。
   */
  private bakeEnvFrom(extra: THREE.Object3D[]): THREE.Texture {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    for (const o of extra) envScene.add(o);
    const rt = pmrem.fromScene(envScene, 0.02, 100, 4000);
    pmrem.dispose();
    // 上一次烘的 RT 要释放, 否则每换一次机库就漏一张 cubemap 在显存里。
    if (this.bayEnvRT) this.bayEnvRT.dispose();
    this.bayEnvRT = rt;
    return rt.texture;
  }

  /**
   * 机库就绪后**重烘环境**: 输入 = 机库本体(克隆, 共享几何/材质) + 天空盒。
   * 保留天空盒是因为门口那束阳光/室外亮度是机库观感的一部分(烘焙时的 sun_rotation 就是
   * 把太阳放到大门那一侧); 机库本体则补上舱内的墙面/地坪/灯具颜色。
   */
  private bakeHangarEnv() {
    const objs: THREE.Object3D[] = [];
    const bayRoot = this.bakedBay?.scene ?? null;   // 程序化布景已删除, 只有烘焙版
    if (bayRoot) {
      const clone = bayRoot.clone(true);   // 共享几何/材质 ⇒ 不额外吃显存
      objs.push(clone);
    }
    if (this.baySkyCfg) objs.push(buildSkyDome(this.baySkyCfg, 3000));
    try {
      this.scene.environment = this.bakeEnvFrom(objs);
      // 舱内环境整体比室外天空暗, 强度适当抬起 —— 保证换上去之后机体不会整体压暗。
      this.scene.environmentIntensity = 1.35;
      console.info('[hangar] 环境已按机库内部重烘(含灯具/地坪/墙面)');
    } catch (err) {
      console.warn('[hangar] 机库环境重烘失败, 保留天空版本:', err);
    }
  }

  /**
   * 机体要**投也要收**阴影: 投 = 停在地面时投在机库地坪上的影子(这是"像关卡里
   * 一样有投影"的主体), 收 = 机身自阴影(薄机身的结构感全靠它)。
   */
  private enableAircraftShadows(group: THREE.Object3D) {
    group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!(m as any).isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
    });
  }

  /**
   * 用 Blender 烘焙的机库替换程序化布景。失败不抛 —— 保留程序化版继续跑。
   *
   * 光照贴图单独取、代码里赋值: glTF 没有光照贴图槽位, 最近的
   * occlusionTexture / emissiveTexture 都不是 three 的 material.lightMap 想要的
   * 东西, 硬塞进 GLB 要跟导出器的槽位约定较劲。挂成同级文件反而完全可控。
   * UV 直接用 GLB 里的 TEXCOORD_1(导出器会带上全部 UV 层, 已实测)。
   */
  private async swapInBakedBay() {
    try {
      const baked = await loadGLB(BAKED_BAY_GLB);
      // 资产的地坪在 glTF 的 Y=0, 按 HANGAR_BAY_FLOOR_Y 契约落到 y=-5。
      baked.scene.position.y = -5;

      // 光照贴图。三个必须同时对的点, 每一个错了光照都会整片错乱:
      //   1) flipY = false —— glTF 的 UV 约定是 flipY=false, 而 loadImageTexture
      //      建的是默认 flipY=true 的 CanvasTexture, 不翻转会整张上下颠倒。
      //   2) channel = 1 —— three 按 material.lightMap.channel 选 UV 通道
      //      (getChannel: 0 → 'uv', 1 → 'uv1'), 而 Texture.channel **默认是 0**。
      //      光照 UV 在 GLB 的 TEXCOORD_1 里(three 里叫 uv1), 不设 channel 就会
      //      拿 UV0 —— 也就是世界坐标米制的平铺 UV —— 去采样一张烘焙图集,
      //      结果就是"贴图在乱跳"加上"完全没有明暗"。
      //   3) 采样 UV 必须在 [0,1]: 光照图集是打包的, 要 clamp 不能 repeat。
      let lightMap: THREE.Texture | null = null;
      try {
        lightMap = await loadImageTexture(assetUrl(BAKED_BAY_LIGHTMAP), true);
        lightMap.flipY = false;
        lightMap.channel = 1;
        lightMap.wrapS = THREE.ClampToEdgeWrapping;
        lightMap.wrapT = THREE.ClampToEdgeWrapping;
        lightMap.needsUpdate = true;
      } catch (err) {
        console.warn('[hangar] 光照贴图加载失败(机库将只吃实时灯光):', err);
      }

      baked.scene.traverse((o) => {
        // === 机库必须"完全不参与实时着色" (2026-09 修: 舱内发白、没有阴影) ========
        // 曾经的做法是把机库放图层 1、指望实时灯照不到它。**那个前提是错的**:
        // three 的灯光图层过滤是**逐相机**的 —— WebGLRenderer.projectObject 里
        //   `const visible = object.layers.test( camera.layers )`   // 拿的是 camera
        // 通过之后 `currentRenderState.pushLight( object )` 把灯推进**全局**光照
        // 状态, 所有材质共享, 没有"逐物体的灯光遮罩"。
        // 于是机库照样被太阳/天光/环境光照到, 而且因为 receiveShadow=false, 那些
        // 光全是**无阴影**的 ⇒ 整舱被冲成一片均匀的亮, 烘焙出来的明暗对比全丢。
        //
        // 正确的做法是把机库的材质整批换成 **MeshBasicMaterial**(完全烘焙的语义):
        //   indirectDiffuse  = lightMap * lightMapIntensity * RECIPROCAL_PI
        //   indirectDiffuse *= diffuseColor(即 map)
        //   outgoingLight    = indirectDiffuse        // 没有任何实时灯参与
        // 也就是"最终 = albedo × 烘焙光照", 与 Blender 的渲染语义一致。
        o.layers.set(1);   // 保留: 便于将来做独立 pass / 隔离拾取(对光照无作用)
        const mesh = o as THREE.Mesh;
        if (!(mesh as any).isMesh) return;
        // 不投也不收: 结构投影已经烘在图集里(再实时投会出双份暗带), 而它本来
        // 就不吃实时光, 收了也没有可乘的项。
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const converted = mats.map((m) => bakeOnlyMaterial(m as THREE.Material, lightMap));
        mesh.material = Array.isArray(mesh.material) ? converted : converted[0];
      });
      // 相机要能看见图层 1(机库), 否则换上去的是个不渲染的物体。
      this.camera.layers.enable(1);

      this.scene.add(baked.scene);
      this.bakedBay = baked;
      // === 机库就绪 ⇒ 用它自己重烘环境贴图 (per user request: 天光要捕机库内的环境) ===
      this.bakeHangarEnv();
    } catch (err) {
      // 常见原因: 线上只传了 index.html(assets/ 不存在) → 拿到 SPA 兜底 HTML;
      // 或 file:// 双击单文件。保留程序化版即可继续, 所以这里只警告。
      console.warn('[hangar] Blender 机库加载失败, 保留程序化布景:', err);
    }
  }

  private attachInput() {
    this.canvas.addEventListener('mousedown', this.onDown);
    window.addEventListener('mouseup', this.onUp);
    window.addEventListener('mousemove', this.onMove);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  detach() {
    this.canvas.removeEventListener('mousedown', this.onDown);
    window.removeEventListener('mouseup', this.onUp);
    window.removeEventListener('mousemove', this.onMove);
    this.canvas.removeEventListener('wheel', this.onWheel as any);
    cancelAnimationFrame(this.raf);
    // === Release PBR textures + per-session scene resources (per user
    // request: 显存回收) ===
    // 机棚布景(hangar-bay.ts)也是这条遍历释放的: 那边产出的全是普通 Mesh /
    // InstancedMesh, 材质只把 canvas 贴图放在 map 槽 —— 每个 mesh 的几何 + 材质
    // + map 都会被下面这段收走(InstancedMesh 也是 Mesh, 一样进 isMesh 分支),
    // 所以机库退出时格栅/墙板/危险条纹/接触阴影那几张贴图不会留在显存里。
    getTextureManager().clearAll();
    const isShared = (o: { userData?: Record<string, unknown> }) => o.userData?.shared === true;
    const disposeTex = (t?: THREE.Texture | null) => {
      if (t && !isShared(t)) t.dispose();
    };
    const disposeMat = (m?: THREE.Material | null) => {
      if (!m) return;
      const a = m as unknown as Record<string, unknown>;
      disposeTex(a.map as THREE.Texture);
      disposeTex(a.normalMap as THREE.Texture);
      disposeTex(a.aoMap as THREE.Texture);
      disposeTex(a.metalnessMap as THREE.Texture);
      disposeTex(a.roughnessMap as THREE.Texture);
      disposeTex(a.emissiveMap as THREE.Texture);
      // lightMap 必须一起收: 它是 2048² 的光照图集, 漏掉就是一张 16MB 的
      // 纹理留在显存里(这段遍历原本没有它, 因为旧布景没有光照贴图)。
      disposeTex(a.lightMap as THREE.Texture);
      m.dispose();
    };
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        if (mesh.geometry && !isShared(mesh.geometry)) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[];
        if (Array.isArray(mat)) mat.forEach(disposeMat);
        else disposeMat(mat);
      }
    });
    // PMREM 的环境渲染目标不在场景树里, 那条遍历收不到它。
    if (this.bayEnvRT) {
      this.scene.environment = null;
      this.bayEnvRT.dispose();
      this.bayEnvRT = null;
    }
    this.bakedBay?.dispose();
    this.bakedBay = null;
  }

  private onDown = (e: MouseEvent) => {
    this.dragging = true;
    this.autoRotate = false;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };
  private onUp = () => { this.dragging = false; };
  private onMove = (e: MouseEvent) => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    // === 机库相机 yaw 不限位 (per user request: 撤销上一轮的 ±60° 限制) ==============
    this.targetYaw += dx * 0.005;
    this.targetPitch = THREE.MathUtils.clamp(this.targetPitch + dy * 0.005, -0.4, 0.4);
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.targetDist = THREE.MathUtils.clamp(this.targetDist + e.deltaY * 0.05, 14 * HangarViewer.PREVIEW_SCALE, 90 * HangarViewer.PREVIEW_SCALE);
  };

  /** F-16 的"视觉尺度"基准(第一次构建 f16/f16c 预览时记录), 用来归一各机型的屏占比。 */
  private static sizeRef = 0;

  setAutoRotate(b: boolean) {
    this.autoRotate = b;
  }

  /** 按需加载 MiG-29 模型(机库点卡片时调用,分段加载)。成功后调用方再
   *  show('mig29')。失败(file:// 下浏览器禁 fetch 外部库)→ 返回 false,
   *  UI 提示需要 http 服务器。 */
  async ensureMig29(): Promise<boolean> {
    // === 每次都要重新取一份包装 (per fix: 机库黑屏) =========================
    // show() 会把模型 group 的 children **搬进**机库场景(为了能驱动真实舵面),
    // 搬完原 group 就空了。以前这里 `if (this.mig29Model) return true` 会直接返回
    // 那份空包装 → 第二次 show 的机体是空的, 屏幕上只剩后燃器/网格 = "机库黑屏"。
    // loadMig29Model() 内部解析是记忆化的, 重新调用只是再造一层 Mesh 包装, 很便宜。
    try {
      const { loadMig29Model } = await import('./mig29');
      this.mig29Model = await loadMig29Model();
      return true;
    } catch (err) {
      console.warn('[hangar] MiG-29 加载失败(基础单文件需 http 服务器):', err);
      this.mig29Model = null;
      return false;
    }
  }

  /** F-16C 同理: 重新取一份包装, 避免把已经被搬空的 group 再 show 一次。 */
  private async reloadF16c(): Promise<void> {
    try {
      const { loadF16cModel } = await import('./f16c');
      this.f16cModel = await loadF16cModel();
    } catch (err) {
      console.warn('[hangar] F-16C 真实模型加载失败,回退合并几何:', err);
      this.f16cModel = null;
    }
  }

  async show(model: AircraftModel, color?: number, afterburner = false): Promise<void> {
    // === 世代号: 并发 show 只允许最后一次落进场景 ==========================
    // UI 确实会连调两次 show(先把机体摆上去避免 loading 底下空一拍, 紧接着
    // 再用重新取的模型包一次)。两次都是 async: 若先发起的那次在 await 期间被
    // 后发起的抢先跑完, 它恢复后**又 scene.add 了一个 group**, 于是两个机体
    // 重叠在一起(z-fighting 看起来像"贴图糊了"), 而 currentMesh 只指向其中一个
    // —— 另一个成了无法回收的孤儿。
    // 修法: 每次 show 自增世代, 每个 await 之后确认自己仍是最新世代, 否则直接放弃。
    const gen = ++this.showGen;
    if (this.currentMesh) {
      this.scene.remove(this.currentMesh);
      this.currentMesh = null;
    }
    // === F-16C 真实模型 (per user request: 完全替换原 F-16) ===
    // 默认玩家机 f16(以及新注册的 f16c)展示真实多材质模型。
    if (model === 'f16' || model === 'f16c') await this.reloadF16c();
    if (model === 'mig29') await this.ensureMig29();
    // await 之后重新确认还是最新世代 —— 不是就退出, 绝不 add。
    if (gen !== this.showGen) return;
    const f16c = (model === 'f16' || model === 'f16c') ? this.f16cModel : null;
    if (f16c) {
      const g = new THREE.Group();
      for (const c of [...f16c.group.children]) g.add(c);
      this.migSurfaces = { ailerons: f16c.surfaces.ailerons, elevators: f16c.surfaces.elevators, rudders: f16c.surfaces.rudders };
      this.ctrlSurfaces = null;
      g.scale.setScalar(1.7 * HangarViewer.PREVIEW_SCALE);
      const group = new THREE.Group();
      group.add(g);
      this.afterburner = this.buildAb(f16c.info, 1.7);
      group.add(this.afterburner);
      group.scale.setScalar(1.1 * HangarViewer.PREVIEW_SCALE);
      // === 飞机整体上移 (per user request: 机库内的飞机往上移动一些) ================
      // 预览放大 2 倍之后, 原来"坐在甲板上"的高度显得太贴地 —— 抬起来一点, 也让机腹/起落架
      // 更好看。单位与世界一致(米级), 观感上约等于把人抬到胸口高度。
      group.position.y = HangarViewer.HANGAR_LIFT;
      // 油门/加力演示(与 MiG-29 相同:机库开关控制火焰可见性)
      setAfterburner(this.afterburner, afterburner ? 0.8 : 0);
      this.scene.add(group);
      this.currentMesh = group;
      this.enableAircraftShadows(group);
      this.targetDist = 38 * HangarViewer.PREVIEW_SCALE;
      return;
    }
    // === MiG-29 多材质真实模型 (per user request: 加入机库 + 分段加载) ===
    // 模型按需加载:若还没加载,调用方需先 await ensureMig29() 再 show。
    if (model === 'mig29' && this.mig29Model) {
      const mm = this.mig29Model;
      const g = new THREE.Group();
      for (const c of [...mm.group.children]) g.add(c);
      this.migSurfaces = { ailerons: mm.surfaces.ailerons, elevators: mm.surfaces.elevators, rudders: mm.surfaces.rudders };
      this.ctrlSurfaces = null;
      g.scale.setScalar(1.7 * HangarViewer.PREVIEW_SCALE);
      const group = new THREE.Group();
      group.add(g);
      this.afterburner = this.buildAb(mm.info, 1.7);
      group.add(this.afterburner);
      group.scale.setScalar(1.1 * HangarViewer.PREVIEW_SCALE);
      group.position.y = HangarViewer.HANGAR_LIFT;
      this.scene.add(group);
      this.currentMesh = group;
      this.enableAircraftShadows(group);
      this.targetDist = 38 * HangarViewer.PREVIEW_SCALE;
      return;
    }
    const info = this.geomCache[model];
    if (!info) return;
    const c = color ?? (model === 'f16' ? 0x808a96 : 0x6b6b66);
    // Stealth aircraft get a subtle emissive to bring out the facets.
    const meshOpts: { metalness: number; roughness: number; emissive?: number; emissiveIntensity?: number; model?: string } = {
      metalness: 0.7,
      roughness: 0.35,
      model,
    };
    if (model === 'f117') {
      meshOpts.emissive = 0x101418;
      meshOpts.emissiveIntensity = 0.25;
    }
    const mesh = buildAircraftMesh(info.geometry, c, meshOpts);
    // Per-model mesh scale — bombers/gunships are physically large so we shrink them.
    const meshScale = model === 'f16' ? 2.0
                    : model === 'b52' || model === 'tu95' ? 1.6
                    : model === 'ac130' || model === 'e3' ? 1.7
                    : 1.7;
    mesh.scale.setScalar(meshScale);
    const group = new THREE.Group();
    group.add(mesh);
    this.afterburner = this.buildAb(info, meshScale);
    group.add(this.afterburner);
    // === Movable control surfaces (per user request: F-16X 实验机) ===
    // The testbed shows its ailerons/elevator/rudder; the render loop wiggles
    // them so the movable-surface feasibility is visible in the hangar.
    this.ctrlSurfaces = null;
    if (model === 'f16-test') {
      const surf = buildControlSurfaces(info, meshScale);
      this.ctrlSurfaces = surf;
      group.add(surf.aileronL);
      group.add(surf.aileronR);
      group.add(surf.elevator);
      group.add(surf.rudder);
    }
    // Turboprops (Tu-95, AC-130, E-3) don't show afterburner flames.
    // 共享判定: 涡桨/无加力的轰炸机与炮艇机都不点加力火焰(B-52 以前漏了)。
    // (per user request: "AC130 和 b52 这种不要启用后燃器特效")
    const isTurboprop = !hasAfterburner(model, undefined);
    if (isTurboprop) {
      setAfterburner(this.afterburner, 0);
      this.afterburner.visible = false;
    } else {
      setAfterburner(this.afterburner, afterburner ? 0.8 : 0);
    }
    // Reset scale depending on model size
    if (model === 'b52' || model === 'tu95') {
      group.scale.setScalar(0.65);
    } else if (model === 'ac130' || model === 'e3') {
      group.scale.setScalar(0.85);
    } else {
      group.scale.setScalar(1.1 * HangarViewer.PREVIEW_SCALE);
    }
    group.position.y = 0;
    this.scene.add(group);
    this.currentMesh = group;
    this.enableAircraftShadows(group);
    // === 屏占比归一化: 按机体**实测包围盒**定机位距离 (per user request) ============
    // 以前是写死的 if/else(b52/tu95=55, ac130/e3=48, 其余=38) ⇒ MiG-29 比 F-16 大一圈
    // 却和 F-16 同一个距离 ⇒ 屏占比明显更大。现在:
    //   视觉尺度 metric = 包围盒最长边 × 当前 group 缩放
    //   距离 = 38 × (metric / metric_F16)  ⇒ 屏占比与 F-16 一致
    // F-16 的基准值在**第一次出现 F-16/f16c 时**记录(任何机型先看都能自纠正:
    // 先看别的机型就先用默认 38, 一旦看过 F-16 就以它为准重新归一)。
    const _box = new THREE.Box3().setFromObject(group);
    const _sz = _box.getSize(new THREE.Vector3());
    // ⚠ 不要再乘 group.scale.x: Box3.setFromObject() 是按 **matrixWorld** 展开的,
    //   group 自身的缩放**已经算在里面**了。再乘一次 = 缩放算两遍 ——
    //   而各机型挂缩放的层级不同(F-16 的 1.7× 挂在内层 g、外层=1;
    //   MiG-29 的 1.1× 挂在外层) ⇒ MiG-29 的尺度会被多算 2.2 倍,
    //   距离被推到 clamp 上限(90), 屏占比反而比 F-16 小得多 —— 与"屏占比一致"的目标相反。
    const metric = Math.max(_sz.x, _sz.y, _sz.z);
    if ((model === 'f16' || model === 'f16c') && metric > 1e-3) {
      HangarViewer.sizeRef = metric;
    }
    const ref = HangarViewer.sizeRef > 1e-3 ? HangarViewer.sizeRef : metric;
    this.targetDist = THREE.MathUtils.clamp(38 * (ref > 1e-3 ? metric / ref : 1), 24, 90);
    // 数值自述口: 屏占比归一出问题时, 一眼能看出 metric/ref 到底是多少(cons 里读 __hangarSize)
    (window as unknown as Record<string, unknown>).__hangarSize = {
      model, metric: +metric.toFixed(3), ref: +ref.toFixed(3), dist: +this.targetDist.toFixed(1),
    };
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    // === PC FPS cap (per user request: 最大帧率限制) ===
    if (this.fpsCap > 0) {
      const interval = 1000 / this.fpsCap;
      if (now - this.lastCapT < interval) return;
      this.lastCapT = now;
    }
    const dt = Math.min(0.05, (now - this.lastT) / 1000);
    this.lastT = now;
    // === Control-surface self-demo (per user request: F-16X 实验机) ===
    // Wiggle the ailerons/elevator/rudder with slow sines so the movable
    // surfaces are clearly visible in the hangar.
    if (this.ctrlSurfaces) {
      const t = now / 1000;
      this.ctrlSurfaces.aileronL.rotation.x = Math.sin(t * 2.0) * 0.45;
      this.ctrlSurfaces.aileronR.rotation.x = -Math.sin(t * 2.0) * 0.45;
      this.ctrlSurfaces.elevator.rotation.x = Math.sin(t * 1.5) * 0.4;
      this.ctrlSurfaces.rudder.rotation.y = Math.sin(t * 2.5) * 0.45;
    }
    // === MiG-29 真实舵面自演示 (per user request: 从 obj 提取) ===
    // 符号与引擎驱动一致(MiG-29 舵面后缘在 Z 负侧,升降舵/副翼与
    // f16-test 合成舵面相反)。
    if (this.migSurfaces) {
      const t = now / 1000;
      for (const a of this.migSurfaces.ailerons) {
        const left = (a.name || '').includes('_l');
        a.rotation.x = (left ? -1 : 1) * Math.sin(t * 2.0) * 0.45;
      }
      for (const e of this.migSurfaces.elevators) {
        e.rotation.x = Math.sin(t * 1.5) * 0.4;
      }
      for (const r of this.migSurfaces.rudders) {
        r.rotation.y = Math.sin(t * 2.5) * 0.45;
      }
    }
    if (this.autoRotate) this.targetYaw += dt * 0.25;
    this.yaw = THREE.MathUtils.lerp(this.yaw, this.targetYaw, 0.1);
    this.pitch = THREE.MathUtils.lerp(this.pitch, this.targetPitch, 0.1);
    this.dist = THREE.MathUtils.lerp(this.dist, this.targetDist, 0.1);
    // === Orbit camera around the 3D VIEW CENTRE (per user request) ===
    // The camera orbits the aircraft's tuned view-centre point, ALWAYS looks
    // at it, and the marker ball sits exactly there — so the player can SEE
    // where the frame centre is while adjusting it (no blind tuning).
    const fc = this.frameCenter;
    const orbitX = Math.sin(this.yaw) * Math.cos(this.pitch) * this.dist;
    const orbitY = Math.sin(this.pitch) * this.dist + 4;
    const orbitZ = Math.cos(this.yaw) * Math.cos(this.pitch) * this.dist;
    // View centre:
    //  - mouse-aim camera: a WORLD-FIXED ball at (x, y, z) — only follows the
    //    aircraft's position, never rotates with it. The z is the PLAYER'S
    //    fore/aft tuning (legitimate), not a built-in offset.
    //  - traditional camera: a camera-frame screen offset (x/y fractions of
    //    half-screen along the camera right/up, z depth along the look).
    let vc: THREE.Vector3;
    if (this.frameWorldFixed) {
      vc = this.tmpLT.set(fc.x, fc.y, fc.z);
    } else {
      const fwd = this.tmpF.set(-orbitX, -orbitY, -orbitZ).normalize();
      const right = this.tmpR.crossVectors(fwd, this.tmpWU);
      if (right.lengthSq() > 1e-6) right.normalize();
      else right.set(1, 0, 0);
      const up = this.tmpU.crossVectors(right, fwd);
      const S = this.dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5));
      vc = this.tmpLT.set(0, 0, 0)
        .addScaledVector(right, -fc.x * S)
        .addScaledVector(up, -fc.y * S)
        .addScaledVector(fwd, fc.z);
    }
    // === 相机与主光夹高: 机棚现在有顶棚了 (per user request: 全新机库) ==========
    // 改造前是露天场景, 俯仰拉满 + 拉远只是"从高处俯看"; 有了屋顶之后同样的操作会把
    // 相机送到屋面板外面去 —— 画面里只剩一块屋顶板, 机体反而看不见了。
    // 夹在顶棚下方 4 单位, 机体在任何机位都还在画面里(取景本身没动: 只是不会再
    // 跑到屋面之上)。主光同理夹在顶棚下方, 免得出现"光从屋顶外面照进来"。
    // 相机**上下都要夹**。原来只夹了顶棚: 俯仰角拉到 -0.4 配大距离时
    // orbitY = sin(-0.4)*dist + 4 会跑到地板以下(默认距离 76 时是 -9.6,
    // 而地板在 -5), 于是从地板下面往上看 —— 地坪是单面朝上的, 从下不可见,
    // 画面下半部直接变成穿过地板看到的天空。
    // 下界取地板上方 1.5, 与上面 HANGAR_BAY_CEIL_Y - 4 对称成"永远留在舱内"。
    const camY = THREE.MathUtils.clamp(
      orbitY + vc.y,
      HANGAR_BAY_FLOOR_Y + 1.5,
      HANGAR_BAY_CEIL_Y - 4,
    );
    this.camera.position.set(orbitX + vc.x, camY, orbitZ + vc.z);
    this.camera.lookAt(vc.x, vc.y, vc.z);
    if (this.centreBall) this.centreBall.position.copy(vc);
    // Spotlight follows camera
    this.spotLight.position.set(orbitX * 0.7, Math.min(orbitY + 18, HANGAR_BAY_CEIL_Y - 2.5), orbitZ * 0.7);
    this.spotTarget.position.set(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
  };

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // === Frame-centre preview (per user request: 机库调视野中心) ===
  // worldFixed = the offset is a world-fixed ball (mouse-aim camera); false =
  // a camera-frame screen offset (traditional chase camera).
  setFrameCenter(x: number, y: number, z: number, worldFixed: boolean) {
    this.frameCenter.x = x;
    this.frameCenter.y = y;
    this.frameCenter.z = z;
    this.frameWorldFixed = worldFixed;
  }
}
