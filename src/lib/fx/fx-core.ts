// === FX 粒子系统核心 (per user request: 全新特效编辑器外壳,3A 对标) ===
// 游戏侧接入契约 = FxAsset JSON schema(本文件导出)。系统本体:
//   - 实例化精灵四边形:每 (blend, 贴图) 一个 InstancedMesh,每实例
//     matrix(位置/缩放/自旋)+ iColor(RGBA)+ aFrame(图集帧动画)。
//     贴图缺省 = 程序化柔边圆形;可选 sheet 帧网格图集(序列帧爆炸等)。
//   - CPU 模拟:速度/重力/阻力/寿命、尺寸与颜色随寿命线性插值、自旋、
//     帧按寿命均分推进(spreadCone 内随机)。
//   - 发射器三类 + 闪光灯:
//       sprite      — burst 一次性爆发 / continuous 由调用方按 rate 逐颗调
//       shockwave   — 膨胀环(环形几何缩放 + 淡出)
//       lightflash  — 点光衰减
//   - 池化复用;reset+fastSimulate 支持时间轴 scrub(确定性种子)。
import * as THREE from 'three';

// ===========================================================================
// Schema(编辑器 ↔ 游戏 的 FX 契约)
// ===========================================================================
/** 帧网格图集(sprite 粒子贴图;缺省 = 共享程序化柔边圆形)。 */
export interface SpriteSheetCfg {
  /** RGBA 帧网格图集(dataURL;单文件发布内联用) */
  dataUrl?: string;
  /** 外置图集 URL(可选) */
  url?: string;
  /** 图集网格 cols 列 × rows 行(允许空尾格) */
  cols: number;
  rows: number;
  /** 实际动画帧数(≤ cols×rows;帧按粒子寿命均分) */
  frames: number;
  /** 稳定池键(可选;缺省按 dataUrl 哈希,同图集共享粒子池) */
  key?: string;
}

/**
 * 外置图集 URL 的解析钩子。
 *
 * 为什么需要: sheet.url 会**直接**交给 THREE.TextureLoader, 而单文件构建里
 * /textures/vfx/x.png 的真实位置是 <out>/assets/textures/vfx/x.png(资产库
 * copy=true / external=true)。仓库已有 asset-url.ts 负责这件事(weapons.ts
 * 加载旧爆炸图集时就在用), 但 fx-core 在 src/lib/fx/ 下, 不该反向依赖
 * src/lib/game/ —— 所以这里开一个注入点, 由游戏侧把 assetUrl 传进来;
 * 编辑器不传即恒等(开发服务器下根相对路径本来就对)。
 */
export type SheetUrlResolver = (url: string) => string;
export interface SpriteEmitterCfg {
  type: 'sprite';
  id: string;
  name: string;
  /** 帧序列贴图(可选,缺省用共享程序化柔边圆点) */
  sheet?: SpriteSheetCfg;
  mode: 'burst' | 'continuous';
  burstCount: number;      // burst 一次性数量
  rate: number;            // continuous:每秒发射
  lifetime: number;        // 秒
  lifetimeJitter: number;  // 0..1
  speed: number;           // 初速(单位/秒)
  speedJitter: number;     // 0..1
  spreadCone: number;      // 喷射锥角(度,0=全向 180)
  direction: [number, number, number];
  gravity: number;         // 重力系数(相对世界 -Y,0=无)
  drag: number;            // 每秒速度衰减系数(0=无)
  size0: number;
  size1: number;
  color0: string;
  color1: string;
  opacity0: number;
  opacity1: number;
  blend: 'additive' | 'normal';
  spin: number;            // 弧度/秒
  spinJitter: number;
  /**
   * 显式 draw 顺序(可选)。
   *
   * 为什么需要: 一个爆炸资产里现在有火/烟/冲击波/碎片四个 sprite 池, 它们
   * **位置相同、都 depthWrite:false** → three 的透明排序对它们是平局, 只能靠
   * renderOrder 定序, 否则会闪烁。而且顺序**有对错**:
   *   · 碎片是深色实体, 必须排在加性层**之后** —— 排在前面会被加性光整体照亮,
   *     深色尖刺变成橙色;
   *   · 烟要垫底, 火/冲击波叠在烟上。
   * 缺省值按混合模式给(加性 2 / 普通 1), 与旧行为一致。
   */
  order?: number;
}
export interface ShockwaveCfg {
  type: 'shockwave';
  id: string;
  name: string;
  duration: number;
  startRadius: number;
  endRadius: number;
  thickness: number;
  color: string;
  opacity: number;
  blend: 'additive' | 'normal';
}
export interface LightFlashCfg {
  type: 'lightflash';
  id: string;
  name: string;
  intensity: number;
  radius: number;
  decay: number;
  duration: number;
  color: string;
}
export type FxEmitterCfg = SpriteEmitterCfg | ShockwaveCfg | LightFlashCfg;

export interface FxAsset {
  version: 1;
  id: string;
  name: string;
  /** 循环重放(编辑器时间轴 loop 用) */
  loop: boolean;
  /** 游戏槽位(编辑器分配;fx-tune slots 由此导出。运行时核心忽略) */
  slot?: 'ground' | 'air';
  emitters: FxEmitterCfg[];
}

// ===========================================================================
// 柔边圆形精灵纹理(共享)
// ===========================================================================
let _spriteTex: THREE.CanvasTexture | null = null;
function spriteTexture(): THREE.CanvasTexture {
  if (_spriteTex) return _spriteTex;
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.75, 'rgba(255,255,255,0.28)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  _spriteTex = new THREE.CanvasTexture(c);
  _spriteTex.colorSpace = THREE.SRGBColorSpace;
  return _spriteTex;
}

// ===========================================================================
// 图集(sheet)键 —— 同键共享粒子池与贴图
// ===========================================================================
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** sheet 的稳定池键(同图集 → 同池同贴图)。 */
export function sheetKeyOf(s: SpriteSheetCfg): string {
  if (s.key) return `k:${s.key}`;
  const src = s.dataUrl ?? s.url ?? '';
  return `s:${fnv1a(src)}`;
}

/**
 * 地面序列帧特效的"踩地"抬升量:精灵 quad 以中心定位,若不抬升,图集主体
 * 会半截埋进地形。取资产内 sheet 发射器的最大尺寸(×scale)的一半,把
 * quad 底边对齐命中面。无 sheet/全空中 → 0(不抬)。
 */
export function sheetFootLift(asset: FxAsset, scale: number): number {
  let m = 0;
  for (const e of asset.emitters) {
    if (e.type === 'sprite' && e.sheet) m = Math.max(m, e.size0, e.size1);
  }
  return m * scale * 0.5;
}

// ===========================================================================
// 粒子池(单发射器级 InstancedMesh;自定义 shader 支持 per-instance RGBA)
// three r185 的 instanceColor 只走 RGB —— 透明渐变/正常混合需要真 alpha,
// 所以用 3A 式自写 instanced sprite shader(iColor vec4 属性)。
// ===========================================================================
interface Pool {
  mesh: THREE.InstancedMesh;
  capacity: number;
  count: number;              // 活跃粒子数
  // 每粒子状态
  pos: Float32Array;          // 3
  vel: Float32Array;          // 3
  life: Float32Array;         // 剩余寿命
  maxLife: Float32Array;
  size0: Float32Array;
  size1: Float32Array;
  rot: Float32Array;
  spin: Float32Array;
  drag: Float32Array;
  grav: Float32Array;
  frames: Float32Array;       // 每粒子帧总数(sheet.frames;程序化=1)
  // 颜色(RGBA 预乘语义:additive 池在 shader 外按 RGB 衰减)
  c0: Float32Array;           // 4
  c1: Float32Array;           // 4
  iColor: THREE.InstancedBufferAttribute;
  /** 每粒子当前动画帧(CPU 按寿命比写入;程序化池恒 0) */
  aFrame: THREE.InstancedBufferAttribute;
  /** 图集网格 cols×rows(程序化=1×1) */
  grid: [number, number];
  texKey: string;
  blend: 'additive' | 'normal';
}

// 自定义 sprite shader:billboard 由 CPU 写 instanceMatrix;每实例 RGBA
// (iColor)+ 图集帧(aFrame,VS 内折成网格 UV 偏移)动画。
const SPRITE_VERT = /* glsl */ `
attribute vec4 iColor;
attribute float aFrame;
uniform vec2 uGrid;
varying vec4 vColor;
varying vec2 vUv;
void main() {
  vColor = iColor;
  vec2 cell = vec2(mod(aFrame, uGrid.x), floor(aFrame / uGrid.x));
  vUv = (uv + cell) / uGrid;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;
const SPRITE_FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec4 vColor;
varying vec2 vUv;
void main() {
  vec4 tex = texture2D(uMap, vUv);
  gl_FragColor = tex * vColor;
}
`;

function makePool(scene: THREE.Scene, capacity: number, blend: 'additive' | 'normal', tex: THREE.Texture, grid: [number, number], texKey: string, order?: number): Pool {
  const geo = new THREE.PlaneGeometry(1, 1);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: tex },
      uGrid: { value: new THREE.Vector2(grid[0], grid[1]) },
    },
    vertexShader: SPRITE_VERT,
    fragmentShader: SPRITE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: blend === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  // 火(加性)默认画在烟(normal)之后, 否则火球会被烟糊住。
  // 两个池都 depthWrite:false 且位置相同 → three 的透明排序对它俩是平局,
  // 只能靠 renderOrder 定序(相等时按材质 id 排, 结果不稳定会闪)。
  // 资产可以用 emitter.order 显式指定(爆炸的碎片必须排最后, 见 schema 注释)。
  mesh.renderOrder = order ?? (blend === 'additive' ? 2 : 1);
  const iColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  iColor.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iColor', iColor);
  const aFrame = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
  aFrame.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aFrame', aFrame);
  scene.add(mesh);
  return {
    mesh, capacity, count: 0, iColor, aFrame, grid, texKey,
    pos: new Float32Array(capacity * 3),
    vel: new Float32Array(capacity * 3),
    life: new Float32Array(capacity),
    maxLife: new Float32Array(capacity),
    size0: new Float32Array(capacity),
    size1: new Float32Array(capacity),
    rot: new Float32Array(capacity),
    spin: new Float32Array(capacity),
    drag: new Float32Array(capacity),
    grav: new Float32Array(capacity),
    frames: new Float32Array(capacity),
    c0: new Float32Array(capacity * 4),
    c1: new Float32Array(capacity * 4),
    blend,
  };
}

function hexRGBA(hex: string, opacity: number, out: Float32Array, o: number) {
  const c = new THREE.Color(hex);
  out[o] = c.r;
  out[o + 1] = c.g;
  out[o + 2] = c.b;
  out[o + 3] = opacity;
}

// ===========================================================================
// 发射器运行态
// ===========================================================================
interface ShockInstance { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; t: number; duration: number; r0: number; r1: number; }
interface LightInstance { light: THREE.PointLight; t: number; duration: number; base: number; }

export class FxSystem {
  private pools = new Map<string, Pool>();
  private shocks: ShockInstance[] = [];
  private flashes: LightInstance[] = [];
  // === 图集(sheet)贴图注册表(按 sheetKeyOf 键;同键共享贴图与粒子池) ===
  private sheetTex = new Map<string, THREE.Texture>();
  private sheetLoading = new Map<string, Promise<THREE.Texture | null>>();
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpSpinQ = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();
  private tmpS = new THREE.Vector3();
  private UPZ = new THREE.Vector3(0, 0, 1);
  private camQuat = new THREE.Quaternion();
  private _activeSprites = 0;

  constructor(private scene: THREE.Scene, private capacityPerEmitter = 4096,
              private resolveSheetUrl: SheetUrlResolver = (u) => u) {}

  get activeParticles(): number { return this._activeSprites; }

  /** 预解码一组资产的 sheet(幂等;解码完成前对应发射器自动跳过)。 */
  async prepareSheets(assets: FxAsset[]): Promise<number> {
    const jobs: Promise<unknown>[] = [];
    for (const a of assets) {
      for (const e of a.emitters) {
        if (e.type === 'sprite' && e.sheet) jobs.push(this.decodeSheet(e.sheet));
      }
    }
    await Promise.all(jobs);
    return this.sheetTex.size;
  }

  /** 直接注册/解码一张图集(key 自动取 sheetKeyOf;幂等)。 */
  setSheetImage(sheet: SpriteSheetCfg): Promise<THREE.Texture | null> {
    return this.decodeSheet(sheet);
  }

  /** 已解码图集(未解码返回 undefined)。 */
  sheetTexture(sheet: SpriteSheetCfg | undefined): THREE.Texture | undefined {
    if (!sheet) return undefined;
    return this.sheetTex.get(sheetKeyOf(sheet));
  }

  private decodeSheet(sheet: SpriteSheetCfg): Promise<THREE.Texture | null> {
    const key = sheetKeyOf(sheet);
    if (this.sheetTex.has(key)) return Promise.resolve(this.sheetTex.get(key)!);
    const inflight = this.sheetLoading.get(key);
    if (inflight) return inflight;
    const raw = sheet.dataUrl ?? sheet.url;
    if (!raw) return Promise.resolve(null);
    // dataUrl 原样用; 外置 url 过一次注入的解析器(单文件构建要重定向到资产库)
    const src = sheet.dataUrl ? raw : this.resolveSheetUrl(raw);
    const p = (async () => {
      try {
        const tex = await new THREE.TextureLoader().loadAsync(src);
        // 帧网格图集按 sRGB 上传(WebGL2 硬件线性化,与程序化圆点一致)。
        tex.colorSpace = THREE.SRGBColorSpace;
        // === 关键: 网格图集**不能开 mipmap** ===
        // mipmap 是对整张纹理逐级降采样, 而图集是 cols×rows 个格子拼起来的 ——
        // 高级别 mip 会把所有帧平均成一坨, 于是每个 quad 都变成一片均匀的深色方片
        // (实测: 贴到地形上就是一个边缘笔直、半透明的黑方块, 里面的火/烟全被糊掉)。
        // 原来那句"mipmap 让远处小粒子不吃亏"在这里是错的: 逐格 UV 采样与 mipmap
        // 在原理上就冲突。宁可远处稍许走样, 也不能整片糊成方框。
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        // 帧序: 图集按"行优先、PNG 第一行 = 第 0 帧"写出(vfx-atlas-pack.mjs),
        // 而 three 默认 flipY=true 会把 v=0 对到 PNG 的最后一行 → 帧被按行倒着播。
        // 关掉 flipY, 让 v=0 = PNG 顶行 = 第 0 帧。
        tex.flipY = false;
        tex.needsUpdate = true;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        this.sheetTex.set(key, tex);
        return tex;
      } catch (e) {
        console.warn('[FxSystem] sheet 解码失败:', key, e);
        return null;
      } finally {
        this.sheetLoading.delete(key);
      }
    })();
    this.sheetLoading.set(key, p);
    return p;
  }

  reset() {
    for (const p of this.pools.values()) { p.count = 0; p.mesh.count = 0; }
    for (const s of this.shocks) { s.mat.opacity = 0; s.mesh.visible = false; }
    for (const f of this.flashes) f.light.intensity = 0;
    this.shocks.length = 0;
    this.flashes.length = 0;
    this._activeSprites = 0;
  }

  /** 在位置 pos 播放整条 FX 资产(所有发射器)。scale=整体倍率(尺寸/半径)。 */
  play(asset: FxAsset, pos: THREE.Vector3, baseDir: THREE.Vector3 = new THREE.Vector3(0, 1, 0), opts: { scale?: number } = {}) {
    for (const e of asset.emitters) this.playEmitter(e, pos, baseDir, opts);
  }

  playEmitter(cfg: FxEmitterCfg, pos: THREE.Vector3, baseDir: THREE.Vector3 = new THREE.Vector3(0, 1, 0), opts: { scale?: number } = {}) {
    const scale = opts.scale ?? 1;
    if (cfg.type === 'sprite') {
      // 有 sheet 但贴图未解码完 → 本帧跳过(游戏侧预解码后才启用)
      const pool = this.ensurePool(cfg.blend, cfg.sheet, cfg.order);
      if (!pool) return;
      // burst=一次性爆发;continuous=调用方按 rate×dt 逐颗调用(每调用产 1 颗)
      const n = cfg.mode === 'burst'
        ? Math.min(Math.max(1, Math.round(cfg.burstCount)), Math.max(0, pool.capacity - pool.count))
        : pool.capacity - pool.count > 0 ? 1 : 0;
      for (let k = 0; k < n; k++) this.spawnOne(pool, cfg, pos, baseDir, scale);
    } else if (cfg.type === 'shockwave') {
      const geo = new THREE.RingGeometry(Math.max(1, cfg.startRadius * scale) * 0.2, 1, 48);
      const mat = new THREE.MeshBasicMaterial({
        color: cfg.color, transparent: true, opacity: cfg.opacity, side: THREE.DoubleSide, depthWrite: false,
        blending: cfg.blend === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      mat.userData.baseOpacity = cfg.opacity;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(pos);
      mesh.rotation.x = -Math.PI / 2;
      this.scene.add(mesh);
      this.shocks.push({ mesh, mat, t: 0, duration: cfg.duration, r0: cfg.startRadius * scale, r1: cfg.endRadius * scale });
    } else if (cfg.type === 'lightflash') {
      const light = new THREE.PointLight(cfg.color, 0, cfg.radius * scale, cfg.decay);
      light.position.copy(pos);
      this.scene.add(light);
      this.flashes.push({ light, t: 0, duration: cfg.duration, base: cfg.intensity });
    }
  }

  /** 按 blend+图集键取池;sheet 贴图未就绪返回 null。 */
  private ensurePool(blend: 'additive' | 'normal', sheet?: SpriteSheetCfg, order?: number): Pool | null {
    const key = sheet ? sheetKeyOf(sheet) : 'proc';
    let p = this.pools.get(key + '|' + blend);
    if (!p) {
      const tex = sheet ? this.sheetTex.get(key) : spriteTexture();
      if (!tex) return null;
      p = makePool(this.scene, this.capacityPerEmitter, blend, tex,
                   sheet ? [sheet.cols, sheet.rows] : [1, 1], key, order);
      this.pools.set(key + '|' + blend, p);
    }
    return p;
  }

  private spawnOne(pool: Pool, cfg: SpriteEmitterCfg, pos: THREE.Vector3, baseDir: THREE.Vector3, scale: number) {
    const i = pool.count;
    const o = i * 3;
    pool.pos[o] = pos.x; pool.pos[o + 1] = pos.y; pool.pos[o + 2] = pos.z;
    // 方向:cfg.direction 为局部主轴(默认 +Y),由 baseDir 决定整体朝向;锥角内随机
    const cone = THREE.MathUtils.degToRad(cfg.spreadCone);
    const coneF = cone > 0.001 ? Math.cos(cone) : -1;
    let dir = new THREE.Vector3();
    if (cone >= Math.PI - 0.001) {
      dir.randomDirection();
    } else {
      // 在局部球锥内采样:先绕随机轴偏转
      const axis = new THREE.Vector3(
        Math.abs(baseDir.x) < 0.9 ? 1 : 0,
        Math.abs(baseDir.y) < 0.9 ? 1 : 0,
        Math.abs(baseDir.z) < 0.9 ? 1 : 0,
      ).normalize();
      const theta = Math.acos(coneF + Math.random() * (1 - coneF));
      dir.copy(baseDir).applyAxisAngle(axis, theta).normalize();
    }
    const sp = cfg.speed * (1 + (Math.random() * 2 - 1) * cfg.speedJitter);
    pool.vel[o] = dir.x * sp; pool.vel[o + 1] = dir.y * sp; pool.vel[o + 2] = dir.z * sp;
    const lt = cfg.lifetime * (1 + (Math.random() * 2 - 1) * cfg.lifetimeJitter);
    pool.maxLife[i] = Math.max(0.05, lt);
    pool.life[i] = pool.maxLife[i];
    pool.size0[i] = cfg.size0 * scale;
    pool.size1[i] = cfg.size1 * scale;
    // 帧序列:帧按粒子寿命均分(无 sheet = 1 帧静态贴图)
    pool.frames[i] = cfg.sheet ? Math.max(1, Math.round(cfg.sheet.frames)) : 1;
    pool.rot[i] = Math.random() * Math.PI * 2;
    pool.spin[i] = cfg.spin * (1 + (Math.random() * 2 - 1) * cfg.spinJitter);
    pool.drag[i] = cfg.drag;
    pool.grav[i] = cfg.gravity;
    hexRGBA(cfg.color0, cfg.opacity0, pool.c0, i * 4);
    hexRGBA(cfg.color1, cfg.opacity1, pool.c1, i * 4);
    pool.count++;
  }

  /** 更新(dt 秒;camera 用于 billboard)。continuous 发射由调用方按 rate 调 playEmitter,此处只积分。 */
  update(dt: number, camera: THREE.PerspectiveCamera) {
    camera.getWorldQuaternion(this.camQuat);
    this._activeSprites = 0;
    for (const pool of this.pools.values()) {
      const { count, pos, vel, life, maxLife, size0, size1, rot, spin, drag, grav, frames, c0, c1, mesh, iColor, aFrame } = pool;
      const iCol = iColor.array as Float32Array;
      const iFrm = aFrame.array as Float32Array;
      let w = 0;
      for (let i = 0; i < count; i++) {
        if (life[i] <= 0) continue;
        life[i] -= dt;
        if (life[i] <= 0) continue; // 本帧死亡,不留残影
        const o3 = i * 3;
        const dr = 1 - drag[i] * dt;
        vel[o3] *= dr; vel[o3 + 1] *= dr; vel[o3 + 2] *= dr;
        vel[o3 + 1] -= grav[i] * dt;
        pos[o3] += vel[o3] * dt; pos[o3 + 1] += vel[o3 + 1] * dt; pos[o3 + 2] += vel[o3 + 2] * dt;
        rot[i] += spin[i] * dt;
        // 紧凑拷贝(存活粒子前移)
        if (w !== i) {
          const wo3 = w * 3;
          pos[wo3] = pos[o3]; pos[wo3 + 1] = pos[o3 + 1]; pos[wo3 + 2] = pos[o3 + 2];
          vel[wo3] = vel[o3]; vel[wo3 + 1] = vel[o3 + 1]; vel[wo3 + 2] = vel[o3 + 2];
          life[w] = life[i]; maxLife[w] = maxLife[i];
          size0[w] = size0[i]; size1[w] = size1[i];
          rot[w] = rot[i]; spin[w] = spin[i]; drag[w] = drag[i]; grav[w] = grav[i];
          frames[w] = frames[i];
          c0.copyWithin(w * 4, i * 4, i * 4 + 4);
          c1.copyWithin(w * 4, i * 4, i * 4 + 4);
        }
        // instance matrix(billboard + 自旋)
        const t = 1 - life[w] / maxLife[w];
        const size = size0[w] + (size1[w] - size0[w]) * t;
        // 帧序列推进:帧按寿命均分(最后帧钳制,避免越界空白格)
        const total = Math.max(1, frames[w]);
        iFrm[w] = Math.min(total - 1, Math.floor(t * total));
        this.tmpV.set(pos[o3], pos[o3 + 1], pos[o3 + 2]);
        this.tmpQ.copy(this.camQuat);
        const spinQ = this.tmpSpinQ.setFromAxisAngle(this.UPZ, rot[w]);
        this.tmpQ.multiply(spinQ);
        this.tmpS.set(size, size, size);
        this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpS);
        mesh.setMatrixAt(w, this.tmpM);
        // per-instance RGBA(iColor)
        const o4 = w * 4;
        iCol[o4] = c0[o4] + (c1[o4] - c0[o4]) * t;
        iCol[o4 + 1] = c0[o4 + 1] + (c1[o4 + 1] - c0[o4 + 1]) * t;
        iCol[o4 + 2] = c0[o4 + 2] + (c1[o4 + 2] - c0[o4 + 2]) * t;
        iCol[o4 + 3] = c0[o4 + 3] + (c1[o4 + 3] - c0[o4 + 3]) * t;
        w++;
      }
      pool.count = w;
      mesh.count = w;
      mesh.instanceMatrix.needsUpdate = true;
      iColor.needsUpdate = true;
      aFrame.needsUpdate = true;
      this._activeSprites += w;
    }
    // shockwave 膨胀
    for (let i = this.shocks.length - 1; i >= 0; i--) {
      const s = this.shocks[i];
      s.t += dt;
      const t = Math.min(1, s.t / s.duration);
      const r = s.r0 + (s.r1 - s.r0) * t;
      s.mesh.scale.set(r, r, 1);
      s.mat.opacity = s.mat.userData.baseOpacity * (1 - t);
      if (t >= 1) {
        this.scene.remove(s.mesh);
        s.mesh.geometry.dispose();
        s.mat.dispose();
        this.shocks.splice(i, 1);
      }
    }
    // 闪光衰减
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += dt;
      const t = Math.min(1, f.t / f.duration);
      f.light.intensity = f.base * (1 - t) * (1 - t);
      if (t >= 1) {
        this.scene.remove(f.light);
        this.flashes.splice(i, 1);
      }
    }
  }

  dispose() {
    for (const p of this.pools.values()) {
      this.scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      (p.mesh.material as THREE.Material).dispose();
    }
    this.pools.clear();
    // 释放本系统解码的图集贴图(编辑器/游戏各自独立 FxSystem → 独立持有)
    for (const tex of this.sheetTex.values()) tex.dispose();
    this.sheetTex.clear();
    this.sheetLoading.clear();
    this.reset();
  }
}
