import * as THREE from 'three';
// 图集精灵特效: 纹理走 <img> 路线(r185 的 TextureLoader 在 file:// 下会抛裸 Event)
import { loadImageTexture } from './fetch-asset';
import { assetUrl } from './asset-url';
// 特效诊断开关(默认全开; 只给自动化逐系统归因用, 见 §111 / fx-toggles.ts)
import { fxOff } from './fx-toggles';
import {
  paramsFor, effectiveTurnRate, effectiveSightFov, missileCommon,
  type MissileParams, type MissileParamKey,
} from './weapon-params';

/** §339: 按武器类型/阵营推断参数表键(玩家与敌方各一套, 见 weapon-params.ts 的"不对称"说明) */
export function paramsKeyFor(type: 'MSL' | 'LASM', isAlly: boolean, _tier: 'low' | 'normal' | 'high'): MissileParamKey {
  // 敌方**空中**发射的弹统一走 NPC_MSL —— 它自带 Hi(200°/s、视场 200°)/ Low(3°/s、视场 30°)
  // 两档, "低速档几乎咬不住"这个特性已经写在档里了; 地对空/舰载发射点会显式传
  // 'NPC_GROUND' / 'NPC_VLS'(胶囊更长更粗, 重力衰减 1.5)。
  if (!isAlly) return 'NPC_MSL';
  return type === 'LASM' ? 'LASM' : 'MSL';
}

export interface Bullet {
  mesh: THREE.Mesh;
  /** §346: 发射者名字(击杀播报 "谁打死了谁"; 机炮子弹也必须带, 否则枪杀只显示"哪一方") */
  launcherName?: string;
  velocity: THREE.Vector3;
  life: number; // seconds remaining
  // === Extended bullet physics (per user request: 显眼的抛物线炮弹和高速直射炮弹) ===
  // gravity: downward acceleration applied each frame (units/s^2). 0 = straight line.
  //   Artillery shells use ~25 (slow lob), tank main guns use 0 (flat direct fire).
  // drag: velocity damping per second (0 = no drag, 1 = stop in 1s). 0.05-0.15 for shells.
  // spin: visual roll rate (rad/s) for shell meshes so they look like rotating bullets.
  // isShell: marks large-calibre shells (different trail rendering + bigger hit VFX).
  gravity?: number;
  drag?: number;
  spin?: number;
  isShell?: boolean;
  // Trail color for shell tracers — defaults to bullet yellow.
  trailColor?: number;
  // Per-shell damage override (per user request: AC-130 SP炮每口径不同伤害).
  // Defaults to 18 for shells / 4 for bullets when unset.
  damage?: number;
  // === Manual-gun hit radius override (per user request: 固定机炮更高碰撞判定) ===
  // Player bullets fired from a FIXED (non-auto-aim) gun get a larger
  // collision sphere so near-misses register — auto-aim shots stay tight.
  hitRadius?: number;
  // Small blast radius (per user request: A-10机炮爆炸) — the A-10's GAU-8
  // shells explode on impact, damaging nearby targets.
  blastRadius?: number;
  // === Damager kind (per user request: 单位的摧毁播报只播报自己和僚机打的) ===
  // When this bullet/shell hits a target, the target's lastDamagerKind is
  // set to this value. Used by the engine to filter kill notifications.
  //   - 'player'  — fired by the player's gun
  //   - 'wingman' — fired by an allied wingman
  //   - 'ally'    — fired by an allied AI aircraft (non-wingman)
  //   - 'enemy'   — fired by an enemy aircraft
  //   - 'ground'  — fired by a ground/naval unit
  // Undefined = unknown source (treated as 'enemy' by default).
  damagerKind?: 'player' | 'wingman' | 'ally' | 'enemy' | 'ground';
}

// === Pooled smoke particle (per user request: 三层粒子烟雾 + 对象池) ===
// Replaces the old per-puff Sprite create/dispose pattern. We now keep a
// fixed pool of MAX_SMOKE sprites and recycle them — no allocations during
// gameplay, no disposal, no GC churn.
//
// Each particle has a `stage` that drives its colour, growth, and fade:
//   0 = bright flame core (short-lived, hot yellow-white)
//   1 = thick smoke       (medium life, grey for player / orange-red for enemy)
//   2 = thin扩散 mist     (long life, very low opacity, large size)
//
// All pooled sprites share the SAME material template (cloned once per
// pool entry) so each can fade independently. Sprites use depthWrite:false
// + fog:false so multiple transparent smoke particles blend correctly and
// are NOT dimmed by the scene's exponential fog (otherwise distant
// missile contrails turn into an unreadable grey blob).
export interface SmokeParticle {
  pos: THREE.Vector3;       // world position (sprite reads from this each frame)
  vel: THREE.Vector3;       // diffusion velocity (random per-axis)
  life: number;             // remaining seconds
  maxLife: number;          // total lifetime at spawn
  size: number;             // current sprite scale (grows over time)
  fromPlayer: boolean;      // true = allied (player/wingman) missile, false = enemy
  stage: 0 | 1 | 2 | 3;   // 0=flame, 1=thick smoke, 2=thin mist, 3=condensation
  active: boolean;          // false = free slot in the pool
}

// Old interface kept for backwards-compat with the Missile.smokePuffs field
// (still typed, but no longer used by the new pooled system).
export interface MissileSmokePuff {
  mesh: THREE.Sprite;
  life: number;
  maxLife: number;
  growRate: number;
}

export interface Missile {
  group: THREE.Group;
  velocity: THREE.Vector3;
  life: number;
  target: EnemyHandle | null;
  speed: number;
  /** 加速目标(导弹正常速度); 发射后由 boost 段逐步逼近 */
  maxSpeed: number;
  type: 'MSL' | 'LASM';
  // === Trail fields kept for backwards-compat but no longer used ===
  // The old ribbon-based trail (which caused the "竖杠/白点" bug because
  // flat planes attached to the missile group appear as vertical bars when
  // viewed edge-on) has been REMOVED. The new pooled particle system
  // (SmokeParticle[]) below produces the smoke contrail. These fields are
  // kept as no-op stubs so any stray references don't crash.
  trailMesh: THREE.Mesh | null;
  trailPositions: THREE.Vector3[];
  smokeMat: THREE.MeshBasicMaterial | null;
  outerRibbon: THREE.Mesh | null;
  innerRibbon: THREE.Mesh | null;
  dead: boolean;
  hit: boolean;
  // === Miss tracking (per user request) ===
  // Set to true the moment this missile actually damages a target. When
  // the missile is removed (dead) without `hit`, the engine treats it as
  // a "miss" and triggers a radio callout.
  reportedHit: boolean;
  // `isPlayer` is kept for backwards compatibility — true means "fired by
  // player or wingman" (stored in this.missiles), false means "fired by an
  // enemy" (stored in this.enemyMissiles).
  isPlayer: boolean;
  // `isAlly` is the authoritative side flag for friendly-fire filtering.
  //   true  = allied missile (player + wingman)  → can only hit isAlly=false targets
  //   false = enemy missile                       → can only hit isAlly=true  targets
  isAlly: boolean;
  // === Missile tier (per user request) ===
  // 'low'    = weak guidance, more wobble, shorter range (regular enemy fighters)
  // 'normal' = standard guidance (elite enemies + all allied missiles)
  // 'high'   = top-tier guidance (boss aces)
  // When unset (legacy), treated as 'normal'. Applied in updateMissiles().
  tier: 'low' | 'normal' | 'high';
  // === Launcher exclusion (per user request) ===
  // ID of the aircraft that fired this missile. The missile can never
  // collide-detonate on its own launcher — even if the launcher flies back
  // through its own missile's path. This is the "AI僚机自己发射的导弹对自己无效"
  // requirement. Default -1 = no launcher exclusion (player default).
  launcherId: number;
  // === New pooled smoke particle trail ===
  // Each missile keeps a small list of indices into the shared smokeParticle
  // pool. We spawn particles every ~16ms during boost, every ~18ms during
  // cruise, and recycle them when they expire.
  smokeEmitT: number; // countdown to next puff spawn
  // Keep the old field name for backwards-compat with clear() / dead cleanup
  // — but it's now an empty stub array (we don't push per-missile sprites
  // anymore; particles live in the shared pool).
  smokePuffs: MissileSmokePuff[];
  // === Last-hit unit type (per user request) ===
  // Set when the missile detonates so the right VFX can be picked.
  // 'aircraft_fighter' / 'aircraft_bomber' / 'destroyer' / 'cruiser' /
  // 'tank' / 'sam_launcher' / 'aa_vehicle' / 'player' / undefined.
  lastHitUnitType?: string;
  // === Damager kind (per user request: 单位的摧毁播报只播报自己和僚机打的) ===
  // Set at fire time so we know who to credit for kills made by this missile.
  //   - 'player'  — fired by the player
  //   - 'wingman' — fired by an allied wingman
  //   - 'ally'    — fired by an allied AI aircraft (non-wingman)
  //   - 'enemy'   — fired by an enemy aircraft
  //   - 'ground'  — fired by a ground/naval unit (allied or enemy)
  // When undefined, derived from isAlly + launcherId as a fallback.
  damagerKind?: 'player' | 'wingman' | 'ally' | 'enemy' | 'ground';
  // === Missile age (per user request: LASM 导弹速度从慢到越来越快) ===
  // Seconds since launch — used for the accelerating speed curve of LASM.
  age: number;
  /**
   * 上一帧位置 —— **逐弹保存**(取代原先 updateMissiles 里函数级的共享暂存 `_prev`)。
   *
   * 为什么必须逐弹: 原来那段 `_prev` 是所有导弹共用一个局部变量, 只在移动前赋值。
   * 一旦将来有任何分支走到引信判定却没经过赋值(新增飞行模式、提前 return、换帧错位),
   * 扫掠线段就会变成"上一枚导弹的位置 → 本枚导弹的位置", 长度可达数千米 —— 于是
   * 导弹刚发射就"扫过"整张地图, 把远处正好落在虚假线段上的敌人瞬间击落(用户实测:
   * 偶尔发射导弹打远距离目标时, 导弹刚发射就击落了远处的敌人)。逐弹一个 Vector3
   * 的代价可以忽略, 但这一整类 bug 从此不存在。
   */
  prev: THREE.Vector3;
  /** 累计飞行路程(m) —— 引信解除保险用。比纯计时更可靠: 慢速弹不会"还没离架就解锁"。 */
  flown: number;
  // === Flare blind period (per user request: 箔条容易干扰导弹) ===
  // After losing lock to flares, the missile flies blind for this many
  // seconds before it may re-acquire a target — otherwise flares were
  // useless because the missile re-locked instantly.
  blindT?: number;
  // === No re-acquire (per user request: 干扰弹/错过一次后不再锁定) ===
  // Set the moment a missile is decoyed by flares OR has flown past the
  // player once (missed). It then flies straight/ballistic until it expires
  // or hits terrain — it NEVER locks on again.
  noReacquire?: boolean;
  // Distance to the player last frame — used to detect the "missed once"
  // (the player-missile gap starts growing).
  prevPlayerDist?: number;
  // Closest the missile ever got to the player — "missed once" only counts
  // after the missile actually closed in (< 250) and then the gap grew
  // (a true pass-by). A dodge during the flare blind period alone does NOT
  // permanently defeat the missile — re-flaring is what keeps it blind.
  minPlayerDist?: number;
  // === 4-second self-destruct after losing lock/target (per user request) ===
  // Seconds spent WITHOUT a target (only counted once the missile HAD one at
  // some point — a dumb-fired missile that never locked isn't "losing" it).
  // At 4s the missile self-destructs instead of flying until its fuel runs out.
  noTargetT?: number;
  hadTarget?: boolean;
  // === Nuke warhead (per user request: NKV 战术核弹) ===
  isNuke?: boolean;
  /** §344 发射者名字(击杀播报用: "谁打死了谁") */
  launcherName?: string;
  // === §339 AC7AH 式参数(数据表驱动) =======================================
  /** 参数表键(MSL / QAAM / NPC_MSL …), 每帧用 paramsFor(pKey) 取最新值 */
  pKey?: MissileParamKey;
  /** true = **无制导发射**: 不搜索、不重新捕获、不转向, 沿发射方向直飞(引信照常解锁) */
  unguided?: boolean;
  /** 发射时刻(秒, 由 age 推) —— noAcceleTime/noHomingTime 用 */
  launchT?: number;
  /** 已对当前目标切断制导(擦过目标: 原作 missMissileHomingCutDist) */
  cutGuidance?: boolean;
  /** 与当前目标的最近距离(脱靶判定用) */
  minTgtDist?: number;
  /** 上一帧与目标的距离 */
  prevTgtDist?: number;
}

/**
 * 伤害来源类型 —— 只喂给**反馈**(受击音效), 绝不参与伤害数值计算。
 *
 * 为什么需要它: 受击音效(`audio.hit()` = 被击中.wav)以前在**任何**扣血时都播,
 * 机炮每秒 20 发的流弹会让它变成噪音。按用户要求, 只有**导弹**命中才播这个音效,
 * 机炮命中保持安静。联机时远端射手的伤害是通过 `hit` 事件路由过来的, 所以这个
 * 类型必须随事件一起过网(见 net/session.ts 的 pendingKind)。
 */
export type DamageKind = 'missile' | 'gun' | 'laser' | 'other';

export interface PlayerHitTarget {
  /** 该玩家机的位置(引用共享, 每帧读到的都是最新值)。 */
  pos: THREE.Vector3;
  /** 受伤回调。本地玩家由引擎直接改 this.playerHp; 远端玩家走网络上报。
   *  kind 缺省视为 'other'(不播受击音效) —— 老调用点零改动。 */
  hp: { hp: number; alive: boolean; onHit: (dmg: number, kind?: DamageKind) => void };
}

export interface EnemyHandle {
  id: number;
  group: THREE.Group;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  alive: boolean;
  hp: number;
  isBomber: boolean;
  isAlly: boolean;
  name: string;
  // === Unit type (per user request) ===
  // Used to dispatch different hit VFX + SFX depending on what was hit.
  // 'aircraft_fighter' / 'aircraft_bomber' / 'destroyer' / 'cruiser' /
  // 'tank' / 'sam_launcher' / 'aa_vehicle' / 'player'.
  // Undefined for legacy callers — treated as 'aircraft_fighter'.
  unitType?: string;
  // === Last damager kind (per user request: 单位的摧毁播报只播报自己和僚机打的) ===
  // Set by the weapons system whenever damage is applied. The engine reads
  // this when the unit dies to decide whether to play a kill notification.
  // Optional because not all callers care about kill tracking.
  lastDamagerKind?: 'player' | 'wingman' | 'ally' | 'enemy' | 'ground';
  /** §344: 击杀者名字(击杀播报 "谁打死了谁") —— 由武器侧从 launcherName 透传 */
  lastDamagerName?: string;
  // === 本次扣血是什么武器打的 (per user request: 只有导弹命中才播受击音效) ===
  // 与 lastDamagerKind 同一套用法: 武器系统在 `e.hp -= dmg` **之前**写一次。
  // 联机时远端句柄(RemoteHandle)把它实现为访问器, 捕获进待上报的命中事件 ——
  // 于是受害者的客户端能区分"对手用导弹打我"和"对手用机炮扫我"。
  lastWeaponKind?: DamageKind;
  // === Ace unit fields (per user request: T-00 雪鸮王牌机制) ===
  // - aceInvulnerable: true during the story-lock phase → all damage skipped
  // - aceDodgeLeft: counts down from 4 — the first 4 missile hits have a 90%
  //   dodge chance, afterwards 20%. Also halves gun damage.
  aceInvulnerable?: boolean;
  aceDodgeLeft?: number;
}

// === Ace damage gating (per user request: T-00 雪鸮王牌中队) ===
// Returns the damage actually applied (0 = fully dodged/invulnerable).
// - invulnerable during the story-lock phase → no damage at all
// - missile hits: first 4 at 90% dodge, then 20% (机体过热/舵面超载)
// - gun hits: halved
// Splash/bomb damage only respects invulnerability.
// Exported for unit testing (scripts/test-t00-logic.mjs).
/**
 * 全局武器伤害倍率(平衡用, per user request: 平衡和削弱武器伤害)。
 *
 * 作用点是**所有武器造成伤害的入口**(aceDamage + 直击玩家的两处), 所以对玩家、
 * 僚机、敌机、地面单位一律生效 —— 对称削减, 不改相对强弱。联机里跨玩家的伤害在
 * 射手端算好再路由, 所以只会被削一次(受害者端不会二次削减)。
 *
 * 想改手感不用改代码: 浏览器控制台
 *   localStorage.setItem('skybound.weaponDamageScale','0.7'); location.reload()
 * 默认 0.8 = 削 20%。
 */
export const WEAPON_DAMAGE_SCALE: number = (() => {
  try {
    const v = typeof window !== 'undefined'
      ? parseFloat(localStorage.getItem('skybound.weaponDamageScale') ?? '')
      : NaN;
    return Number.isFinite(v) && v >= 0.1 && v <= 3 ? v : 0.8;
  } catch {
    return 0.8;
  }
})();

export function aceDamage(t: EnemyHandle, dmg: number, kind: 'missile' | 'gun' | 'splash' | 'bomb'): number {
  dmg *= WEAPON_DAMAGE_SCALE;
  if (t.aceInvulnerable) return 0;
  if (kind === 'missile' && t.aceDodgeLeft !== undefined) {
    if (t.aceDodgeLeft > 0) {
      t.aceDodgeLeft -= 1;
      if (Math.random() < 0.9) return 0; // dodged
    } else if (Math.random() < 0.2) {
      return 0; // overheated — 20% dodge
    }
  }
  if (kind === 'gun' && t.aceDodgeLeft !== undefined) dmg *= 0.5;
  return dmg;
}

export interface Explosion {
  /**
   * 视觉由图集精灵池绘制时的类别(per user request: 爆炸 → 图集精灵动画)。
   * 有它 → 这层不再有自己的 mesh/材质, 只保留位置/时间(由 syncFxAtlas 写进实例属性);
   * 没有 → 老路径(逐层 mesh + 逐爆材质)。
   */
  atlas?: 'fire' | 'smoke';
  /** 图集路径的基准尺寸(世界单位)。 */
  baseScale?: number;
  mesh: THREE.Mesh;
  light: THREE.PointLight;
  life: number;
  maxLife: number;
  /** true = light 取自引擎的**常驻点光池**(per fix ①): 结束时只归还不从 scene 移除。
   *  池里的灯始终留在 scene 里 → 场景点光数量恒定 → three 不会重编译程序。 */
  pooled?: boolean;
}

/** 引擎常驻动态点光源池的接口(per fix ①)。
 *  为什么必须池化: three 的 program cache key 含 numPointLights(见
 *  WebGLPrograms.getProgramCacheKeyParameters), 场景里点光**数量**一变,
 *  当时所有材质都要现场重新编译/链接(实测单帧 1.8~2.2 s)。所以爆炸/舰船
 *  齐射的点光不能"用时 scene.add、灭时 scene.remove", 必须用数量恒定的常驻池。 */
export interface DynLightPool {
  acquire(): THREE.PointLight | null;
  release(light: THREE.PointLight | null | undefined): void;
}

// === Free-fall dumb bombs (per user request) ===
// Unguided ballistic bombs dropped from the player's aircraft. They follow
// a parabolic free-fall trajectory (initial velocity inherited from the
// player's velocity, gravity pulling them down) and detonate on contact
// with terrain OR any unit (ground or air). Big explosion, large damage
// radius — designed for sinking ships / destroying armor formations.
export interface Bomb {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;        // seconds remaining before forced detonation
  dead: boolean;
}

interface BulletGeometry {
  geom: THREE.BufferGeometry;
  mat: THREE.MeshBasicMaterial;
}

export class WeaponSystem {
  bullets: Bullet[] = [];
  missiles: Missile[] = [];
  explosions: Explosion[] = [];
  enemyMissiles: Missile[] = [];
  // === Free-fall bombs (per user request) ===
  bombs: Bomb[] = [];
  // === §343 finishBlow 触发次数(探针/控制台可读, 证明演出真的触发过) ===
  private _finishBlows = 0;
  finishBlowCount(): number { return this._finishBlows; }

  private bulletGeo: BulletGeometry;
  // === 曳光批量绘制 (per user request: 实体特效改精灵/批量绘制, 降 draw call) ===
  // 原来每发子弹 = 一个 Mesh = 一个 draw call(风暴关 flak 密集时几百个)。这里收敛成一个
  // InstancedMesh: 只改"怎么画", 弹道/命中/伤害/寿命/诊断开关全部走原有逻辑。
  private _fxTracer: THREE.InstancedMesh | null = null;
  // === 爆炸图集精灵池 (per user request: 材质收敛 → 图集精灵动画) ===
  // 原来 explosión 每层一个 mesh + 每爆一次新建/销毁材质(24 个爆炸 ≈ 70+ 对象/70+ draw call)。
  // 现在 flash/fire 走 fire 图集、smoke 走 smoke 图集, 各 1 个实例化广告牌 → 整类特效 1 draw call。
  private _fxAtlas: { fire: THREE.Texture | null; smoke: THREE.Texture | null } = { fire: null, smoke: null };
  private _fxAtlasTried = false;
  private _fxFireQ: { mesh: THREE.Mesh; aCenter: THREE.InstancedBufferAttribute; aProgress: THREE.InstancedBufferAttribute; aScale: THREE.InstancedBufferAttribute } | null = null;
  private _fxSmokeQ: { mesh: THREE.Mesh; aCenter: THREE.InstancedBufferAttribute; aProgress: THREE.InstancedBufferAttribute; aScale: THREE.InstancedBufferAttribute } | null = null;
  private static readonly FX_ATLAS_MAX = 96;
  /** 图集层的占位网格: 共享空几何 + 共享隐藏材质, **永不加入场景**(不产生 draw call),
   *  只用来携带位置/时间。比"逐爆建 mesh + 材质 + 几何"省掉全部 GPU 资源与释放抖动。 */
  private _emptyGeo = new THREE.BufferGeometry();
  private _dummyLight: THREE.PointLight | null = null;
  private _ringGeo: THREE.RingGeometry | null = null;
  private _ringMatTpl: THREE.MeshBasicMaterial | null = null;
  /** 图集层的占位(带位置, 不入场景)。 */
  private makeAtlasAnchor(pos: THREE.Vector3): THREE.Mesh {
    if (!this._hiddenMat) this._hiddenMat = new THREE.MeshBasicMaterial({ visible: false });
    const a = new THREE.Mesh(this._emptyGeo, this._hiddenMat);
    a.position.copy(pos);
    return a;
  }
  private static readonly FX_ATLAS_GRID = 8;
  // 火花同理: 每次命中都会生成一个火花 Mesh + 逐发材质(风暴关 flak 里成百上千),
  // 收敛成第二个 InstancedMesh。用**几何对象判别**(火花都用 _sparkGeo)路由,
  // 所以不必改任何一个创建点。
  private _fxSpark: THREE.InstancedMesh | null = null;
  private static readonly FX_TRACER_MAX = 1024;
  private static readonly FX_SPARK_MAX = 512;
  private readonly _fxM = new THREE.Matrix4();
  private missileGeo: THREE.BufferGeometry;
  private missileMat: THREE.MeshStandardMaterial;
  private explosionGeo: THREE.BufferGeometry;
  private scene: THREE.Scene;
  private nextMissileId = 0;
  // === Bomb geometry (per user request) ===
  // A simple ovoid bomb shape — fins at the back, pointy nose. We reuse the
  // geometry across all bombs (only one material per bomb for the body).
  private bombGeo: THREE.BufferGeometry;
  private bombMat: THREE.MeshStandardMaterial;
  // Shared smoke texture + sprite material for missile smoke trails.
  // We bake a soft radial puff once and reuse it across every missile —
  // both allied and enemy. The colour is white-grey so it reads as a
  // real smoke contrail against the sky.
  private smokeTex: THREE.CanvasTexture;
  private smokeMatTpl: THREE.SpriteMaterial;
  /** 火焰专用材质模板(加色混合) —— 与烟雾同一张贴图, 只改 blending ⇒ 橙焰会"发光"。 */
  private fireMatTpl!: THREE.SpriteMaterial;

  // === Pooled smoke particle system (per user request: 三层粒子烟雾 + 对象池) ===
  // A fixed-size pool of sprites + particle data. We allocate MAX_SMOKE
  // sprites ONCE in the constructor and recycle them — no per-frame
  // allocations, no dispose() calls, no GC churn. This is the key
  // difference vs the old per-puff create/dispose pattern.
  //
  // The pool is shared across ALL missiles (player + wingman + enemy).
  // When a missile wants to emit smoke, it calls spawnSmokeParticle() which
  // finds the next inactive slot and activates it. When a particle's life
  // reaches 0, it's marked inactive and its sprite is hidden.
  //
  // Pool size 600 is enough for ~6 simultaneously-flying missiles each
  // emitting 4 particles every 16ms with up to 4s lifetime — well above
  // anything the game actually throws at the player.
  static readonly MAX_SMOKE = 600;
  private smokeParticles: SmokeParticle[] = [];
  private smokeSprites: THREE.Sprite[] = [];
  private smokeGroup: THREE.Group;

  // === Effect LOD camera position (per user request: 特效LOD) ===
  // Set by the engine each frame via setLodCamera(). Used by spawnExplosion()
  // and spawnHitSpark() to compute the distance from the effect to the
  // camera and pick a high/medium/low LOD. If null, assume close (high LOD).
  private lodCameraPos: THREE.Vector3 | null = null;
  // === Effect view culling (per user request: 特效仅在视野内加载) ===
  // The camera's world forward, passed alongside the position. Effects
  // behind the camera (cone test) or beyond the effect draw distance are
  // NOT spawned at all — the player can't see them and they'd only waste
  // draw calls. Null = no cone culling (legacy callers).
  private lodCamForward: THREE.Vector3 | null = null;
  // Scratch vector for the effect view-cone test.
  private _fxTo = new THREE.Vector3();
  // === FX 爆炸替换钩子 (per user request: 编辑器 sprite 特效替换原生爆炸) ===
  // Engine 注册 FxBattleLayer 后置为回调:返回 true = 本次爆炸已交给槽位
  // 预设(f 地面/4 空中)或已被预算吞掉,原生视觉层不再创建。
  onFxOverride: ((pos: THREE.Vector3, scale: number) => boolean) | null = null;
  /** 常驻动态点光源池(per fix ①, 引擎注入)。null = 旧行为(建/删自己的灯,
   *  会让场景点光数量变化 → three 重编译全场程序)。 */
  lightPool: DynLightPool | null = null;
  /** 取一盏点光: 有池走池(常驻, 数量恒定), 没池退回"自己建一盏临时灯"。 */
  private _takeLight(color: number, intensity: number, distance: number, decay: number): { light: THREE.PointLight; pooled: boolean } {
    if (this.lightPool) {
      const L = this.lightPool.acquire();
      if (L) {
        L.color.setHex(color);
        L.intensity = intensity;
        L.distance = distance;
        L.decay = decay;
        return { light: L, pooled: true };
      }
      // 池满 → 该特效这一帧不发光, 绝不现场建灯(建灯 = 数量变化 = 卡顿)。
      return { light: new THREE.PointLight(0, 0, 0, 0), pooled: false };
    }
    return { light: new THREE.PointLight(color, intensity, distance, decay), pooled: false };
  }
  /** 归还/清理一盏爆炸点光(池化 → 只归还不 remove)。 */
  private _dropLight(e: Explosion): void {
    if (e.pooled) { this.lightPool?.release(e.light); return; }
    if (e.light.intensity > 0 || e.light.distance > 0) this.scene.remove(e.light);
  }
  /** 诊断开关用: 一块**共享**的不可见材质。逐发特效(炮弹/火箭/火花)在
   *  `fxoff=bullet|spark` 时改用它 —— 这样"关掉"量到的是完整的视觉开销
   *  (逐发材质 + draw call), 而不是只把 visible 置 false 还照旧建材质。
   *  它在清理路径里被显式排除, 永不 dispose。 */
  private _hiddenMat: THREE.MeshBasicMaterial | null = null;
  private hiddenMat(): THREE.MeshBasicMaterial {
    if (!this._hiddenMat) this._hiddenMat = new THREE.MeshBasicMaterial({ visible: false });
    return this._hiddenMat;
  }
  /** 逐发材质是否该 dispose(共享材质 + 诊断用的隐藏材质都不动)。 */
  private ownsMat(m: THREE.Material): boolean {
    return m !== this.bulletGeo.mat && m !== this._hiddenMat;
  }
  setLodCamera(pos: THREE.Vector3, forward?: THREE.Vector3) {
    if (!this.lodCameraPos) this.lodCameraPos = new THREE.Vector3();
    this.lodCameraPos.copy(pos);
    if (forward) {
      if (!this.lodCamForward) this.lodCamForward = new THREE.Vector3();
      this.lodCamForward.copy(forward);
    } else {
      this.lodCamForward = null;
    }
  }

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.bulletGeo = {
      geom: new THREE.SphereGeometry(0.6, 6, 6),
      mat: new THREE.MeshBasicMaterial({ color: 0xfff080, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.95 }),
    };
    this.missileGeo = new THREE.CapsuleGeometry(0.35, 1.8, 4, 8);
    this.missileGeo.rotateX(Math.PI / 2);
    this.missileMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.7, roughness: 0.4 });
    this.explosionGeo = new THREE.SphereGeometry(1, 12, 8);
    // === Bomb geometry (per user request) ===
    // A small ovoid body with a tail-cone and four fins. We use a single
    // capsule for the body (cheap) + a thin box for the tail fins.
    this.bombGeo = new THREE.CapsuleGeometry(0.45, 1.4, 4, 8);
    this.bombGeo.rotateX(Math.PI / 2); // align with -Z forward
    this.bombMat = new THREE.MeshStandardMaterial({ color: 0x303a48, metalness: 0.5, roughness: 0.6 });

    // === Smoke puff texture for missile trails ===
    // === Redone (per user request: 烟雾要看不到方形才算合格) ===
    // The previous texture had visible square boundaries because:
    //   1. The base layer used fillRect() which paints the entire 256×256
    //      square — even with a radial gradient, the corners still hold
    //      low-alpha pixels that, when many sprites overlap, accumulate
    //      into a visible square halo.
    //   2. The noise layer drew blobs anywhere in [0,size]×[0,size],
    //      including near the canvas edges — so the square boundary was
    //      reinforced by edge noise.
    //
    // New approach — "truly circular, truly soft":
    //   - Draw the base gradient with a CIRCLE path (not fillRect), and
    //     ramp alpha to ZERO at radius = maxR * 0.88 — so the outer
    //     12% of the canvas is COMPLETELY transparent, guaranteeing no
    //     square edge can ever be visible even when sprites overlap.
    //   - Noise blobs are clamped to the inner disc (centres within
    //     maxR*0.35 of canvas centre, draw radius capped at maxR*0.16)
    //     so they never reach the canvas edge.
    //   - A few brighter 'hot' core spots are kept inside the inner 25%
    //     radius so they also never reach the edge.
    this.smokeTex = (() => {
      const cached = THREE.Cache.get('skybound-missile-smoke');
      if (cached) return cached as THREE.CanvasTexture;
      const size = 128;
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d')!;
      const cx = size / 2;
      const cy = size / 2;
      const maxR = size / 2;
      // === Layer 1: base soft radial gradient drawn as a CIRCLE ===
      // Alpha hits 0 at r = maxR * 0.88 — outer ring fully transparent.
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR * 0.88);
      grad.addColorStop(0.00, 'rgba(255,255,255,1.00)');
      grad.addColorStop(0.20, 'rgba(250,250,252,0.92)');
      grad.addColorStop(0.45, 'rgba(230,230,236,0.60)');
      grad.addColorStop(0.70, 'rgba(200,200,210,0.25)');
      grad.addColorStop(0.86, 'rgba(180,180,190,0.04)');
      grad.addColorStop(1.00, 'rgba(180,180,190,0.00)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
      ctx.fill();
      // === Layer 2: low-frequency noise blobs — STRICTLY inside inner disc ===
      // Centres sampled in a disc of radius maxR*0.35 around canvas centre,
      // draw radius capped at maxR*0.16 — guaranteeing no blob can paint
      // within 0.35-0.16 = 0.19 of the canvas edge.
      ctx.globalCompositeOperation = 'multiply';
      for (let i = 0; i < 14; i++) {
        const ang = Math.random() * Math.PI * 2;
        const dist = Math.random() * maxR * 0.35;
        const x = cx + Math.cos(ang) * dist;
        const y = cy + Math.sin(ang) * dist;
        const r = maxR * (0.08 + Math.random() * 0.08); // 0.08–0.16
        const tone = 170 + Math.random() * 70;
        const ng = ctx.createRadialGradient(x, y, 0, x, y, r);
        ng.addColorStop(0, `rgba(${tone},${tone},${tone + 5},1)`);
        ng.addColorStop(1, 'rgba(255,255,255,1)');
        ctx.fillStyle = ng;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      // === Layer 3: a few brighter 'hot' core spots (screen blend) ===
      // Kept inside the inner 20% radius so they never reach the edge.
      ctx.globalCompositeOperation = 'screen';
      for (let i = 0; i < 4; i++) {
        const ang = Math.random() * Math.PI * 2;
        const dist = Math.random() * maxR * 0.18;
        const x = cx + Math.cos(ang) * dist;
        const y = cy + Math.sin(ang) * dist;
        const r = maxR * (0.08 + Math.random() * 0.08);
        const ng = ctx.createRadialGradient(x, y, 0, x, y, r);
        ng.addColorStop(0, 'rgba(255,250,240,0.40)');
        ng.addColorStop(1, 'rgba(255,250,240,0)');
        ctx.fillStyle = ng;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      // Shared across missions — engine.dispose() must NOT free it.
      (tex as any).userData.shared = true;
      THREE.Cache.add('skybound-missile-smoke', tex);
      return tex;
    })();
    // Material template — we clone this per pooled sprite so each particle
    // can fade independently without affecting its siblings.
    // === Per user request ===
    // fog:false is CRITICAL — the scene has volumetric fog, and if smoke
    // particles were fog-affected, distant missile contrails would turn
    // into an unreadable grey blob. With fog:false the smoke keeps its
    // shape + colour at any distance.
    // depthWrite:false is also critical for correct alpha blending between
    // overlapping transparent sprites.
    this.smokeMatTpl = new THREE.SpriteMaterial({
      map: this.smokeTex,
      color: 0xf0f0f5,
      transparent: true,
      opacity: 0.0, // set per-particle on spawn
      // §326 (per user request: 发射的导弹烟雾被云层遮挡): 必须**写深度** ——
      //   体积云 pass 在**整个场景渲染之后**, 它按场景深度裁 march; 透明物体不写深度时,
      //   那里读到的是天空(远平面) => 云直接盖在烟雾上。写深度后: ①云的 march 在烟雾处停住,
      //   ②大气透视也不会再把它当"无限远"上满雾(之前烟雾还被雾洗白过一层)。
      //   alphaTest 只让"够实的部分"写深度, 软边不会在云上戳出空洞。
      //   阈值取很小(0.02): 烟团的峰值不透明度本身只有 0.3~0.6, 阈值一抬就会把整片软边
      //   **判掉**(烟变成硬边小圆片) —— 那是可见的画质回退。0.02 只挡最外圈几乎看不见的像素。
      depthWrite: true,
      alphaTest: 0.02,
      fog: false,   // ← was true — caused distant contrails to grey out
    });
    // === 火焰专用模板: **加色混合** (per user request: 橙色不够鲜艳显眼) ==============
    // 烟雾是普通混合(灰烟在亮天空前也要看得清), 但**火焰必须加色混合**才会"发光" ——
    // 加色下橙色会叠加到背景上变成亮橙/白热, 哪怕在明亮的云层/天空前面也刺眼。
    this.fireMatTpl = this.smokeMatTpl.clone();
    this.fireMatTpl.blending = THREE.AdditiveBlending;
    this.fireMatTpl.color.setHex(0xffffff);

    // === Initialize the pooled smoke particle system ===
    // Pre-allocate MAX_SMOKE sprites + SmokeParticle data slots. All sprites
    // start hidden (visible=false) and all particles start inactive. The
    // spawnSmokeParticle() method finds an inactive slot and activates it.
    this.smokeGroup = new THREE.Group();
    this.smokeGroup.frustumCulled = false;
    // === 不再被远处云遮住 (per user request) ==================================
    // 云片与烟都是半透明、都关掉 depthWrite ⇒ **谁后画谁盖在上面**; 云数量大、排序后
    // 常在烟之后绘制, 于是远处云把导弹尾迹盖掉了。把烟抬到云之上(renderOrder 12)。
    this.smokeGroup.renderOrder = 12;   // 组上标一份便于排查; 真正生效的是精灵自身的 renderOrder
    this.scene.add(this.smokeGroup);
    // 诊断开关: 'smoke' 关掉时连池都不建(量的才是"烟雾这一整套"的完整开销,
    // 而不是只把发射关掉)。只在进关前设定, 运行中不切换。
    const smokeCap = fxOff('smoke') ? 0 : WeaponSystem.MAX_SMOKE;
    for (let i = 0; i < smokeCap; i++) {
      const mat = this.smokeMatTpl.clone();
      // 每个精灵各持一份"普通"与"加色"材质: 生成时按阶段切换(两份都预先建好,
      // 运行时只换引用 ⇒ 不会改 blending 触发着色器重编译/卡顿)。
      const matAdd = this.fireMatTpl.clone();
      const sp = new THREE.Sprite(mat);
      sp.renderOrder = 12;   // 见上: 画在云层之后 ⇒ 不被远处云遮挡
      sp.userData.matNormal = mat;
      sp.userData.matAdd = matAdd;
      sp.visible = false;
      sp.scale.setScalar(1);
      this.smokeGroup.add(sp);
      this.smokeSprites.push(sp);
      this.smokeParticles.push({
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
        maxLife: 1,
        size: 1,
        fromPlayer: true,
        stage: 1,
        active: false,
      });
    }
  }

  // === Spawn a single smoke particle at the given position ===
  // Called 4× per emission cycle (once per stage: flame, thick, mist, extra
  // thick) by emitMissileSmoke(). The `stage` parameter drives the
  // particle's lifetime, size, diffusion velocity, and colour.
  //
  // Returns true if a slot was found, false if the pool was full (in which
  // case the particle is silently dropped — better than overwriting a live
  // one).
  private spawnSmokeParticle(
    pos: THREE.Vector3,
    fromPlayer: boolean,
    stage: 0 | 1 | 2 | 3,
    bias?: THREE.Vector3,
  ): boolean {
    // Find an inactive slot. Linear scan is fine for 600 entries — we
    // could use a free-list for O(1) but the scan is fast enough and the
    // pool is rarely near-full.
    let slot = -1;
    for (let i = 0; i < this.smokeParticles.length; i++) {
      if (!this.smokeParticles[i].active) { slot = i; break; }
    }
    if (slot === -1) return false; // pool full — drop this particle
    const p = this.smokeParticles[slot];
    const sp = this.smokeSprites[slot];
    p.active = true;
    p.pos.copy(pos);
    p.fromPlayer = fromPlayer;
    p.stage = stage;
    // === Per-stage lifetime + initial size + diffusion velocity ===
    // Stage 0 (bright flame): short life, small size, low diffusion —
    //   this is the hot inner core that glows briefly then dies.
    // Stage 1 (thick smoke): medium life, medium size, medium diffusion —
    //   the main visible contrail body. Player = grey-white, enemy = orange-red.
    // Stage 2 (thin扩散 mist): long life, large size, high diffusion —
    //   the dispersing outer cloud that lingers and fades slowly.
    // === 尾迹重做 (per user request: 导弹烟雾也应该重做) ======================
    // 关键改动: 粒子初速不再"原地随机扩散", 而是**沿 -导弹速度方向**被甩到身后
    // (由 bias 传入, 见 emitMissileSmoke) —— 于是烟是一条**被拉在弹后的羽流**,
    // 而不是糊在弹头周围的一团; 再叠一点点随机散射与缓慢上浮(热烟会升)。
    // 分级也按真实尾迹: 喷口处**又细又亮**(火焰芯), 往后**越粗越淡**(厚烟→薄雾)。
    const bx = bias ? bias.x : 0, by = bias ? bias.y : 0, bz = bias ? bias.z : 0;
    const rnd = (k: number) => (Math.random() - 0.5) * k;
    if (stage === 0) {
      // === 火焰芯: 照搬 teardown 的陨石/导弹配方 (per user request) ==============
      // 他们的火焰是**橙色不透明感**(1.0, 0.62~0.92, 0.18)、寿命很短 0.16~0.38s、
      // 尺寸 ≈ 2.0~3.6 × 弹体半径并持续膨胀 ⇒ 沿路径连成一条"烧红的线"。
      // 我们按同样的比例调(尺寸单位换算成精灵 scale 后大致相当), 颜色用他们的橙。
      // === 火焰要"每次发射都看得见" (per user request) =========================
      // 原来寿命只有 0.16~0.38s, 再叠 t² 的衰减 ⇒ 亮不到几帧就没了、几乎看不到。
      // 现在: 寿命 0.28~0.50s + 尺寸 3.4~5.0(精灵 scale 会再 ×3) + 透明度曲线改成"先满后淡"。
      p.maxLife = 0.28 + Math.random() * 0.22;
      p.size = 3.4 + Math.random() * 1.6;
      p.vel.set(bx * 0.9 + rnd(1.2), by * 0.9 + rnd(1.2) + 0.4, bz * 0.9 + rnd(1.2));
    } else if (stage === 1) {
      // 厚烟: 更粗更久, 散射小(保持成柱), 轻微上浮
      p.maxLife = 1.7;   // 3.4 → 2.2 → 1.7: 按 600 槽的预算（1 火焰 + 1 厚烟/周期 ≈ 120 个/枚）
      p.size = 3.2;      // 5.0 → 3.2: 烟太粗 ⇒ 收细;

      p.vel.set(bx + rnd(4), by + rnd(4) + 0.7, bz + rnd(4));
    } else if (stage === 2) {
      // 薄雾: 更大更久, 散射适中(慢慢化开), 上浮更明显
      p.maxLife = 6.0;
      p.size = 9.0;
      p.vel.set(bx * 0.8 + rnd(6), by * 0.8 + rnd(6) + 1.1, bz * 0.8 + rnd(6));
    } else {
      // === Stage 3: white condensation mist (per user request: 机体凝结云特效) ===
      // Small, fast-fading white vapor — the old 7-size ×3 display multiplier
      // + 10/s growth ballooned to ~87 world units; now starts ~10 and tops
      // out ~14 so it reads as a tight wing-root mist (per user: 太大了).
      p.maxLife = 0.8;
      p.size = 2.4;
      p.vel.set(
        (Math.random() - 0.5) * 1.2,
        (Math.random() - 0.5) * 1.2,
        (Math.random() - 0.5) * 1.2,
      );
    }
    p.life = p.maxLife;
    // === 按阶段切材质: 火焰走加色(发光), 烟走普通混合 ===
    const wantAdd = stage === 0;
    const matNow = (sp.userData.matAdd ?? sp.material) as THREE.SpriteMaterial;
    const matPlain = (sp.userData.matNormal ?? sp.material) as THREE.SpriteMaterial;
    if (sp.material !== (wantAdd ? matNow : matPlain)) sp.material = wantAdd ? matNow : matPlain;
    // Sync sprite to particle
    sp.visible = true;
    sp.position.copy(p.pos);
    sp.scale.setScalar(p.size);
    return true;
  }

  // === Emit a full smoke "packet" for a missile ===
  // Called every ~16ms (boost) or ~18ms (cruise) per active missile. Spawns
  // 4 particles in one shot: 1 flame + 2 thick smoke + 1 thin mist. This
  // multi-stage emission per cycle is the KEY to a dense, layered contrail
  // — the隔壁项目 spec confirmed single-particle-per-frame emission
  // produces thin, sparse trails.
  private emitMissileSmoke(pos: THREE.Vector3, fromPlayer: boolean, vel?: THREE.Vector3) {
    if (fxOff('smoke')) return;
    // === 把烟甩到身后 (per user request: 尾迹重做) ============================
    // 偏置 = 弹速方向的**反方向** × 系数: 弹速越快烟被甩得越远 ⇒ 高速弹留下长羽流,
    // 慢速/末段弹的烟更贴着弹体。系数按阶段给(见 spawnSmokeParticle 里的 bx/by/bz 使用)。
    let bias: THREE.Vector3 | undefined;
    if (vel && vel.lengthSq() > 1e-4) {
      const spd = Math.min(60, vel.length());
      bias = vel.clone().normalize().multiplyScalar(-(3.5 + spd * 0.12));
    }
    // === 颗粒配比按"池预算"定 (per fix: 实测一周期 4 颗 × 60/s × 长寿命 = 1.5s 就把 600 池打满) ===
    // teardown 那边池子有 6000 颗(而且是 instanced/points), 我们只有 600 个独立 Sprite
    // (每个都是一次 draw call), 所以**数量必须省**: 每个周期 = 1 火焰 + 1 厚烟。
    // 想要更浓: 走"加力段多一发"那条(见 updateMissiles), 而不是把基础量堆高。
    this.spawnSmokeParticle(pos, fromPlayer, 0, bias);   // 火焰芯
    // 火焰芯再补一发(带一点随机偏移): 火焰寿命短、槽位便宜, 而"每次发射都要看得见"更重要
    {
      const p2 = pos.clone();
      p2.x += (Math.random() - 0.5) * 1.6;
      p2.y += (Math.random() - 0.5) * 1.6;
      p2.z += (Math.random() - 0.5) * 1.6;
      this.spawnSmokeParticle(p2, fromPlayer, 0, bias);
    }
    this.spawnSmokeParticle(pos, fromPlayer, 1, bias);   // 厚烟(主体)
  }

  // === Emit a smoke burst at an arbitrary position (per user request:
  // 融合现有音爆云特效与新烟雾系统) ===
  // Public method so the engine can request a one-shot burst of smoke
  // particles for non-missile events — currently used by the sonic boom
  // cloud to add a volumetric puff on top of the existing torus rings.
  //
  // `count` particles are emitted in a spherical spread around `pos`. All
  // are stage 1 (thick smoke) so they read as a condensation cloud, not a
  // fire. The `fromPlayer` flag tints them grey-white (true) or orange-red
  // (false) — sonic boom uses true.
  emitSmokeBurst(pos: THREE.Vector3, fromPlayer: boolean, count: number, spread = 4.0) {
    if (fxOff('smoke')) return;
    for (let i = 0; i < count; i++) {
      // Random offset within a sphere of radius `spread`
      const ox = (Math.random() - 0.5) * spread * 2;
      const oy = (Math.random() - 0.5) * spread * 2;
      const oz = (Math.random() - 0.5) * spread * 2;
      const p = pos.clone();
      p.x += ox; p.y += oy; p.z += oz;
      // Mostly thick smoke (stage 1), with a few mist (stage 2) for halo
      const stage: 0 | 1 | 2 = Math.random() < 0.15 ? 2 : 1;
      this.spawnSmokeParticle(p, fromPlayer, stage);
    }
  }

  // === High-G condensation vapor (per user request: 机体凝结云特效) ===
  // White mist emitted off the airframe (wing roots / wing tips) when the
  // aircraft pulls high G. Uses the pooled smoke system's stage-3 white
  // condensation particles. `intensity` 0..1 scales emission density.
  spawnCondensation(pos: THREE.Vector3, intensity: number) {
    if (fxOff('smoke')) return;
    // Per user request: 凝结云拖尾太严重 — 1 particle per call, tight spread.
    const p = pos.clone();
    p.x += (Math.random() - 0.5) * 0.9;
    p.y += (Math.random() - 0.5) * 0.9;
    p.z += (Math.random() - 0.5) * 0.9;
    this.spawnSmokeParticle(p, true, 3);
  }

  // === Launch burst VFX (per user request: 舰船发射导弹看起来跟没发射差不多) ===
  // One-shot visual effect at the moment a missile leaves its launcher.
  // Produces:
  //   1. A bright additive flash sphere that expands + fades in ~0.3s
  //      — visible from any distance, so the launch point clearly "pops".
  //   2. A dense smoke burst (14 particles) via the pooled smoke system
  //      — lingers at the launch position for ~1.5s, reading as "a missile
  //      just left here" even after the missile itself has flown away.
  //   3. A brief point light (0.3s) — illuminates the ship hull / launcher
  //      at the moment of firing, selling the "muzzle flash" effect.
  // This is especially important for SHIP launches because the player
  // views from kilometers away at altitude, where the tiny missile body
  // + thin smoke trail would otherwise be invisible.
  spawnLaunchBurst(pos: THREE.Vector3, isAlly: boolean) {
    // 诊断开关: 发射闪光属于爆炸层, 顺带受 'missile' 控制(它是导弹发射的一部分)。
    if (fxOff('explosion') || fxOff('missile')) return;
    // 1. Bright additive flash sphere — reuses the explosion pool so it
    //    gets cleaned up automatically. Scale is large (4.0) so it's
    //    visible from afar; life is short (0.3s) so it reads as a flash,
    //    not a lingering glow.
    const flashGeo = new THREE.SphereGeometry(1, 12, 8);
    const flashColor = isAlly ? 0xfff0a0 : 0xffaa55;
    const flashMat = new THREE.MeshBasicMaterial({
      color: flashColor,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const flash = new THREE.Mesh(flashGeo, flashMat);
    flash.position.copy(pos);
    flash.scale.setScalar(4.0);
    this.scene.add(flash);
    this.explosions.push({
      mesh: flash,
      light: new THREE.PointLight(0, 0, 0, 0),
      life: 0.30,
      maxLife: 0.30,
    });

    // 2. Dense smoke burst at the launch position — 14 particles in a
    //    tight spread. These use the pooled smoke system so they're
    //    cheap and blend correctly with missile contrail smoke.
    this.emitSmokeBurst(pos, isAlly, 14, 5.0);

    // 3. Brief point light — a warm orange-yellow flash that illuminates
    //    the launcher / ship hull. 取自常驻池(per fix ①): 不再现场建灯,
    //    场景点光数量恒定 → three 不会因为"多了一盏灯"而重编译全场程序。
    const flashTaken = this._takeLight(flashColor, 8, 80, 2);
    const flashLight = flashTaken.light;
    flashLight.position.copy(pos);
    // === 池满时【不再新建灯】(per fix: 光数一变 → 全材质重编译 → 每秒多次长卡顿) ===
    // three 的着色器程序缓存键里含 `numPointLights`; 只要可见点光数量变化, 当时**所有**
    // 材质都要重新 link —— 战斗中爆炸密集 → 池反复用尽 → 每次`scene.add(临时灯)`都让全场
    // 重编译, 表现为"每隔不到一秒一次的长时卡顿"。这里改为: 池满则该特效这一帧/闪光
    // 不发光(它的网格本身是自发光亮面, 观感几乎无差别), 但**绝不改变场景灯数**。
    flashLight.intensity = 0;   // 非池灯保持零强度(且永不入场景)
    this.explosions.push({
      mesh: new THREE.Mesh(new THREE.SphereGeometry(0.01, 4, 4), new THREE.MeshBasicMaterial({ visible: false })),
      light: flashLight,
      pooled: flashTaken.pooled,
      life: 0.25,
      maxLife: 0.25,
    });
  }

  // === Update all active smoke particles ===
  // Called once per frame (NOT per missile). Advances each active particle's
  // life, position, size, and colour/opacity based on its stage. Inactive
  // particles are skipped.
  private updateSmokeParticles(dt: number) {
    for (let i = 0; i < this.smokeParticles.length; i++) {
      const p = this.smokeParticles[i];
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        this.smokeSprites[i].visible = false;
        continue;
      }
      // Advance position by diffusion velocity
      p.pos.addScaledVector(p.vel, dt);
      // Damp velocity (diffusion slows over time — smoke settles)
      p.vel.multiplyScalar(0.96);
      // Grow size over time — stage-dependent growth rate
      // (stage 3 condensation grows slowly — per user: 凝结云太大了)
      // 膨胀率: 薄雾 10 → 7(否则外层糊成一团大气球), 厚烟 6 → 7(柱体更饱满)
      const growRate = p.stage === 0 ? 2 : p.stage === 1 ? 5 : p.stage === 3 ? 2 : 5;   // 厚烟膨胀 7 → 5(烟更细)
      p.size += dt * growRate;
      // Life ratio (1 → 0)
      const t = p.life / p.maxLife;
      // Update sprite
      const sp = this.smokeSprites[i];
      sp.position.copy(p.pos);
      sp.scale.setScalar(p.size * 3);
      const mat = sp.material as THREE.SpriteMaterial;
      // === Per-stage colour + opacity ===
      // Stage 0 (flame): bright yellow-white, high opacity, short fade
      // Stage 1 (thick smoke): grey (player) / orange-red (enemy), medium opacity
      // Stage 2 (thin mist): same hue as stage 1 but very low opacity
      if (p.stage === 0) {
        // === Brighter flame core (per user request: 改良导弹尾焰烟雾特效) ===
        // Hot white-yellow with a smooth fade so it reads as a real jet flame.
        // teardown 配方: 橙(绿通道随机 0.62~0.92), 而不是偏白的黄
        // === 更鲜艳的橙 (per user request) =====================================
        // 绿通道 0.62~0.92 → 0.50~0.72、蓝通道 0.18 → 0.05~0.13: 去掉白味, 橙更饱和;
        // 配合上面的**加色混合**, 叠在背景上就是一层亮橙到白热的光(不再是"一块橙贴片")。
        mat.color.setRGB(1.0, 0.50 + Math.random() * 0.22, 0.05 + Math.random() * 0.08);
        mat.opacity = Math.min(1, t * 1.8);
      } else if (p.stage === 1) {
        if (p.fromPlayer) {
          // Player/wingman missile: grey-white smoke
          mat.color.setRGB(0.85, 0.85, 0.88);
        } else {
          // Enemy missile: orange-red smoke (so the player can visually
          // distinguish incoming vs outgoing missiles at a glance)
          mat.color.setRGB(0.95, 0.55, 0.30);
        }
        mat.opacity = t * 0.65;
      } else if (p.stage === 2) {
        // Stage 2 — colour already set by stage 1 path above when the
        // particle was spawned; we just lower opacity for the mist layer.
        // (The colour stays whatever was last set, which is fine — the
        // mist reads as a faint extension of the thick smoke.)
        mat.opacity = t * 0.25;
      } else {
        // === Stage 3: condensation mist (per user request: 机体凝结云) ===
        // Pure white, soft — reads as vapor condensing off the airframe.
        mat.color.setRGB(1.0, 1.0, 1.0);
        mat.opacity = t * 0.35;
      }
    }
  }

  // === Fixed vs auto-aim gun (per user request: 固定机炮更高伤害/碰撞判定) ===
  // damage: per-bullet damage override (auto-aim = 2/3 of the base 4, fixed
  // guns pass a higher value). hitRadius: collision sphere for near-misses.
  /**
   * 把"共享曳光材质"的弹体批量绘制到一个 InstancedMesh 里。
   *
   * 判据用 `b.mesh.material === this.bulletGeo.mat` —— 炮弹(每发自己的加色材质)与火花
   * 语义不同, 本轮保持逐发绘制(见文档"未做项")。原材质被置 `visible=false`, 于是逐发
   * Mesh 不再产生 draw call; 批量绘制用它的**克隆**(参数逐项相同 → 观感不变)。
   * `fxOff('bullet')` 诊断开关仍然生效(那种弹体在创建时就把 mesh.visible 置 false)。
   */
  private syncFxTracer(): void {
    // === 火花池(惰性建): 材质克隆自一个"规范"火花材质(参数与逐发那份完全相同) ===
    if (!this._fxSpark && this._sparkGeo) {
      const sparkMat = new THREE.MeshBasicMaterial({
        color: 0xffe080, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const inst = new THREE.InstancedMesh(this._sparkGeo, sparkMat, WeaponSystem.FX_SPARK_MAX);
      inst.frustumCulled = false;
      inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      inst.count = 0;
      (inst as unknown as { _env?: boolean })._env = true;
      this.scene.add(inst);
      this._fxSpark = inst;
    }
    if (!this._fxTracer) {
      this.bulletGeo.mat.visible = false;
      const mat = this.bulletGeo.mat.clone();
      mat.visible = true;
      const inst = new THREE.InstancedMesh(this.bulletGeo.geom, mat, WeaponSystem.FX_TRACER_MAX);
      inst.frustumCulled = false;
      inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      inst.count = 0;
      (inst as unknown as { _env?: boolean })._env = true; // 跟随 disposeSceneResources 的清理口径
      this.scene.add(inst);
      this._fxTracer = inst;
    }
    const tracer = this._fxTracer;
    const spark = this._fxSpark;
    let n = 0;
    let ns = 0;
    for (const b of this.bullets) {
      const m = b.mesh as THREE.Mesh;
      const g = m.geometry;
      const isTracer = m.material === this.bulletGeo.mat;
      const isSpark = !!spark && !!this._sparkGeo && g === this._sparkGeo;
      if (!isTracer && !isSpark) continue;                 // 炮弹等保持逐发绘制
      // `m.visible === false` 只表示 fxOff 诊断开关把它关了(见 fireBullet/spawnHitSpark),
      // 那种弹体要真的跳过 —— 所以**不能**用 m.visible 兼职"停画"信号(上一版这么写, 结果
      // 第二帧就被这条守卫自己跳过, 池计数归零)。
      if (m.visible === false) continue;
      // 停画方式按类别: 曳光靠共享材质已全局 visible=false(无需逐发处理);
      // 火花是逐发材质 → 藏它那份材质。
      if (isSpark) (m.material as THREE.Material).visible = false;
      this._fxM.compose(m.position, m.quaternion, m.scale);
      if (isTracer) { if (n < WeaponSystem.FX_TRACER_MAX) tracer.setMatrixAt(n++, this._fxM); }
      else if (ns < WeaponSystem.FX_SPARK_MAX) spark!.setMatrixAt(ns++, this._fxM);
    }
    tracer.count = n;
    tracer.instanceMatrix.needsUpdate = true;
    if (spark) { spark.count = ns; spark.instanceMatrix.needsUpdate = true; }
  }

  /**
   * 加载爆炸图集(一次性, 后台) —— 加载完成前 spawnExplosion 走老 mesh 路径, 不阻塞、不崩。
   */
  private async ensureFxAtlas(): Promise<void> {
    if (this._fxAtlasTried) return;
    this._fxAtlasTried = true;
    try {
      const [fire, smoke] = await Promise.all([
        loadImageTexture(assetUrl('/textures/vfx/explosion-fire.png'), true),
        loadImageTexture(assetUrl('/textures/vfx/explosion-smoke.png'), true),
      ]);
      this._fxAtlas.fire = fire;
      this._fxAtlas.smoke = smoke;
      this._fxFireQ = this.makeAtlasQuad(fire, true);
      this._fxSmokeQ = this.makeAtlasQuad(smoke, false);
    } catch {
      // 图集缺失(未跑生成脚本/未随行) → 永久走老路径, 只是没有这次优化。
      this._fxAtlas.fire = null;
      this._fxAtlas.smoke = null;
    }
  }

  /** 造一个"柱面广告牌 + 图集帧动画"的实例化 quad(与云的朝向口径一致: 底面平行地平线)。 */
  private makeAtlasQuad(tex: THREE.Texture, additive: boolean) {
    const N = WeaponSystem.FX_ATLAS_MAX;
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('uv', base.attributes.uv);
    const aCenter = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    const aProgress = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
    const aScale = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
    geo.setAttribute('aCenter', aCenter);
    geo.setAttribute('aProgress', aProgress);
    geo.setAttribute('aScale', aScale);
    geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: tex },
        uGrid: { value: WeaponSystem.FX_ATLAS_GRID },
        uFrames: { value: WeaponSystem.FX_ATLAS_GRID * WeaponSystem.FX_ATLAS_GRID },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aCenter;
        attribute float aProgress;
        attribute float aScale;
        varying vec2 vUv;
        varying float vProgress;
        void main() {
          vUv = uv;
          vProgress = aProgress;
          // 柱面广告牌: 只取相机的水平方向, up 恒为世界 +Y(爆炸底部不会随镜头滚转歪掉)。
          vec3 toCam = cameraPosition - aCenter;
          float horiz = length(toCam.xz);
          vec3 fwd = horiz > 0.001 ? vec3(toCam.x, 0.0, toCam.z) / horiz : vec3(0.0, 0.0, 1.0);
          vec3 right = vec3(fwd.z, 0.0, -fwd.x);
          vec3 world = aCenter + right * (position.x * aScale) + vec3(0.0, position.y * aScale, 0.0);
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform float uGrid;
        uniform float uFrames;
        varying vec2 vUv;
        varying float vProgress;
        void main() {
          // 图集按行优先; 进度 → 帧号(夹到最后一帧, 避免采到越界)。
          float frame = floor(clamp(vProgress, 0.0, 0.9999) * uFrames);
          float gx = floor(mod(frame, uGrid));
          float gy = floor(frame / uGrid);
          vec2 uv = (vec2(gx, gy) + clamp(vUv, 0.001, 0.999)) / uGrid;
          vec4 t = texture2D(uMap, uv);
          if (t.a < 0.004) discard;
          gl_FragColor = vec4(t.rgb, t.a);
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    (mesh as unknown as { _env?: boolean })._env = true;
    this.scene.add(mesh);
    return { mesh, aCenter, aProgress, aScale };
  }

  /** 每帧把爆炸条目里"图集层"的进度/尺寸/位置写进实例属性(与曳光池同一套思路)。 */
  private syncFxAtlas(): void {
    const q = (kind: 'fire' | 'smoke') => (kind === 'fire' ? this._fxFireQ : this._fxSmokeQ);
    const n: Record<string, number> = { fire: 0, smoke: 0 };
    for (const ex of this.explosions) {
      if (!ex.atlas) continue;
      const slot = q(ex.atlas);
      if (!slot) continue;
      const i = n[ex.atlas];
      if (i >= WeaponSystem.FX_ATLAS_MAX) continue;
      const pos = (ex.mesh as THREE.Object3D).position;
      slot.aCenter.setXYZ(i, pos.x, pos.y, pos.z);
      slot.aProgress.setX(i, 1 - ex.life / ex.maxLife);
      slot.aScale.setX(i, ex.baseScale ?? 1);
      n[ex.atlas] = i + 1;
    }
    for (const kind of ['fire', 'smoke'] as const) {
      const slot = q(kind);
      if (!slot) continue;
      const geo = slot.mesh.geometry as THREE.InstancedBufferGeometry;
      geo.instanceCount = n[kind];
      slot.aCenter.needsUpdate = true;
      slot.aProgress.needsUpdate = true;
      slot.aScale.needsUpdate = true;
    }
  }

  fireBullet(origin: THREE.Vector3, dir: THREE.Vector3, speed: number, damagerKind?: Bullet['damagerKind'], blastRadius?: number, damage?: number, hitRadius?: number, launcherName?: string) {
    const mesh = new THREE.Mesh(this.bulletGeo.geom, this.bulletGeo.mat);
    mesh.position.copy(origin);
    // 诊断开关: 'bullet' 只关曳光本体, 弹道/命中/伤害一律照常(否则"关掉子弹"
    // 会顺带把交战本身也改掉, 量出来的不是特效开销)。
    if (fxOff('bullet')) mesh.visible = false;
    this.scene.add(mesh);
    const velocity = dir.clone().normalize().multiplyScalar(speed);
    // §349 诊断: 没带 damagerKind 的子弹 = 击杀播报会显示无来源(用户实测: 开局 AI 互杀
    // 出现 [gun] 但连阵营都没有)。这里**只报一次**并打印调用栈, 用来定位是哪条发射路径漏了。
    if (damagerKind === undefined && !(WeaponSystem as unknown as { _warnedNoKind?: boolean })._warnedNoKind) {
      (WeaponSystem as unknown as { _warnedNoKind?: boolean })._warnedNoKind = true;
      console.warn('[bullet] 有子弹没带 damagerKind ⇒ 击杀播报会显示无来源。调用栈:', new Error().stack);
    }
    this.bullets.push({ mesh, velocity, life: 1.6, damagerKind, blastRadius, damage, hitRadius, launcherName });
  }

  // === Heavy shell — parabolic or direct (per user request: 抛物线炮弹 / 高速直射炮弹) ===
  // Used by:
  //   - Artillery: gravity ~25 (slow lobbing arc, visible to player)
  //   - Tank main guns: gravity 0 (flat direct fire, high speed 1000+)
  //   - Naval guns (destroyer/cruiser main battery): gravity 8 (slight arc at long range)
  //   - Bunker guns: gravity 12 (medium arc, defensive)
  //
  // The shell is a larger, brighter tracer than a normal bullet so the player
  // can see it arcing across the battlefield — this is the "显眼" requirement.
  // The shell glows with an additive yellow-orange trail and has a faint smoke
  // puff trail behind it.
  private shellGeo: THREE.SphereGeometry | null = null;
  fireShell(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    speed: number,
    opts: { gravity?: number; drag?: number; color?: number; size?: number; life?: number; damage?: number; damagerKind?: Bullet['damagerKind'] } = {},
  ) {
    if (!this.shellGeo) this.shellGeo = new THREE.SphereGeometry(1, 8, 6);
    const color = opts.color ?? 0xffaa44;
    const size = opts.size ?? 1.2;
    // Each shell gets its own material so we can fade it independently + tint
    // by side (allied = orange, enemy = red — so the player can tell who's
    // shooting at a glance even at distance).
    // 诊断开关: 'bullet' 关掉时用共享隐藏材质 —— 逐发材质这部分开销也被关掉。
    const mat = fxOff('bullet')
      ? this.hiddenMat()
      : new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
    const mesh = new THREE.Mesh(this.shellGeo, mat);
    mesh.position.copy(origin);
    mesh.scale.setScalar(size);
    this.scene.add(mesh);
    const velocity = dir.clone().normalize().multiplyScalar(speed);
    this.bullets.push({
      mesh,
      velocity,
      life: opts.life ?? 4.0,
      gravity: opts.gravity ?? 0,
      drag: opts.drag ?? 0.02,
      isShell: true,
      trailColor: color,
      spin: 8 + Math.random() * 4,
      damage: opts.damage,
      damagerKind: opts.damagerKind,
    });
  }

  // === Rocket salvo — unguided spread rockets (per user request: 乱射或直射的火箭弹) ===
  // Used by MLRS-style units and patrol boats. Fires `count` rockets in a
  // quick burst with random spread — they look like a "spray" of unguided
  // rockets arcing toward the target area. Each rocket has light gravity
  // (slight arc) and a smoke trail.
  // `spread` is the cone half-angle in radians (0.05 = tight, 0.2 = wide).
  fireRocketSalvo(
    origin: THREE.Vector3,
    targetDir: THREE.Vector3,
    count: number,
    opts: { spread?: number; speed?: number; isAlly?: boolean; color?: number; damagerKind?: Bullet['damagerKind'] } = {},
  ) {
    const spread = opts.spread ?? 0.12;
    const speed = opts.speed ?? 350;
    const isAlly = opts.isAlly ?? false;
    const color = opts.color ?? (isAlly ? 0xffcc66 : 0xff5544);
    const baseDir = targetDir.clone().normalize();
    for (let i = 0; i < count; i++) {
      // Random direction within the spread cone
      const dir = baseDir.clone();
      // Add random angular offset
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * spread;
      const sinPhi = Math.sin(phi);
      // Build a basis perpendicular to baseDir
      const up = Math.abs(baseDir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const right = new THREE.Vector3().crossVectors(baseDir, up).normalize();
      const realUp = new THREE.Vector3().crossVectors(right, baseDir).normalize();
      dir.addScaledVector(right, sinPhi * Math.cos(theta));
      dir.addScaledVector(realUp, sinPhi * Math.sin(theta));
      dir.normalize();
      // Slight speed variation
      const v = speed * (0.85 + Math.random() * 0.3);
      // Stagger the origin a bit so the salvo doesn't all overlap
      const jitter = new THREE.Vector3(
        (Math.random() - 0.5) * 4,
        (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 4,
      );
      const o = origin.clone().add(jitter);
      // Rockets have light gravity (slight arc) and brighter trail
      if (!this.shellGeo) this.shellGeo = new THREE.SphereGeometry(1, 8, 6);
      // 诊断开关: 'bullet' 关掉时同样改共享隐藏材质(见 fireShell)
      const mat = fxOff('bullet') ? this.hiddenMat() : new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.shellGeo, mat);
      mesh.position.copy(o);
      mesh.scale.setScalar(0.7);
      this.scene.add(mesh);
      this.bullets.push({
        mesh,
        velocity: dir.clone().multiplyScalar(v),
        life: 2.5,
        gravity: 6,
        drag: 0.04,
        isShell: true,
        trailColor: color,
        spin: 12,
        damagerKind: opts.damagerKind,
      });
    }
  }

  // === Naval wake trail (per user request: 海上单位在海面上行驶有海迹) ===
  // Spawn a foam particle at a ship's stern. The particle is a small white
  // sprite that expands and fades over ~2.5s, leaving a visible wake stripe
  // behind the ship. We use the existing pooled smoke system to avoid extra
  // allocations — the wake particles are just smoke particles with a white
  // colour and slower fade.
  // Called by updateGroundUnits at a low rate (every ~0.15s per ship).
  spawnNavalWake(sternPos: THREE.Vector3) {
    if (fxOff('wake')) return;
    // Reuse the smoke particle pool — find a free slot and emit a white,
    // slow-fading particle. The pool's spawnSmokeParticle signature takes
    // (pos, fromPlayer, stage). We use stage=2 (thin mist) which has the
    // longest lifetime — perfect for a wake that should persist behind the
    // ship. The colour is set inside updateSmokeParticles based on stage +
    // fromPlayer; we need to override it for wakes.
    // For simplicity, we add a dedicated wake pool here.
    if (this._wakeSprites.length === 0) this._initWakePool();
    // Find a free slot
    let slot = -1;
    for (let i = 0; i < this._wakeParticles.length; i++) {
      if (!this._wakeParticles[i].active) { slot = i; break; }
    }
    if (slot < 0) return; // pool exhausted — skip this frame
    const p = this._wakeParticles[slot];
    p.pos.copy(sternPos);
    p.pos.y = 0.5; // hugging the water surface
    p.vel.set(
      (Math.random() - 0.5) * 4,
      0,
      (Math.random() - 0.5) * 4,
    );
    // === Stronger wake (per user request: 海面单位的拖尾水迹要更明显) ===
    // Longer life + larger sprites + higher opacity so the wake stripe
    // clearly reads behind moving ships.
    p.life = 3.5;
    p.maxLife = 3.5;
    p.size = 7 + Math.random() * 4;
    p.active = true;
    const s = this._wakeSprites[slot];
    s.visible = true;
    s.position.copy(p.pos);
    s.scale.setScalar(p.size);
    (s.material as THREE.SpriteMaterial).opacity = 0.9;
  }

  // === Ground dust trail (per user request: 地面单位前进有显眼但开销低的拖尾灰尘) ===
  // Same pattern as naval wake, but tan/brown colour for dust kicked up by
  // tanks / AA vehicles / armored cars driving on land. Cheap: low spawn
  // rate (every ~0.2s per vehicle), short life (~1.5s), small pool size.
  spawnDustTrail(rearPos: THREE.Vector3) {
    if (fxOff('dust')) return;
    if (this._dustSprites.length === 0) this._initDustPool();
    let slot = -1;
    for (let i = 0; i < this._dustParticles.length; i++) {
      if (!this._dustParticles[i].active) { slot = i; break; }
    }
    if (slot < 0) return;
    const p = this._dustParticles[slot];
    p.pos.copy(rearPos);
    p.pos.y = 1 + Math.random() * 1.5;
    p.vel.set(
      (Math.random() - 0.5) * 3,
      0.5 + Math.random() * 1.5,
      (Math.random() - 0.5) * 3,
    );
    p.life = 1.5;
    p.maxLife = 1.5;
    p.size = 3 + Math.random() * 2;
    p.active = true;
    const s = this._dustSprites[slot];
    s.visible = true;
    s.position.copy(p.pos);
    s.scale.setScalar(p.size);
    (s.material as THREE.SpriteMaterial).opacity = 0.5;
  }

  // === Wake pool (naval) ===
  private static readonly MAX_WAKE = 120;
  private _wakeParticles: { pos: THREE.Vector3; vel: THREE.Vector3; life: number; maxLife: number; size: number; active: boolean }[] = [];
  private _wakeSprites: THREE.Sprite[] = [];
  private _wakeGroup: THREE.Group | null = null;
  private _wakeTex: THREE.CanvasTexture | null = null;
  private _initWakePool() {
    this._wakeGroup = new THREE.Group();
    this.scene.add(this._wakeGroup);
    // Build a soft white foam texture
    const size = 64;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d')!;
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.4, 'rgba(220,235,245,0.55)');
    grad.addColorStop(1, 'rgba(200,220,235,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    this._wakeTex = new THREE.CanvasTexture(c);
    this._wakeTex.colorSpace = THREE.SRGBColorSpace;
    for (let i = 0; i < WeaponSystem.MAX_WAKE; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this._wakeTex,
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        fog: false,
        blending: THREE.NormalBlending,
      });
      const s = new THREE.Sprite(mat);
      s.visible = false;
      s.scale.setScalar(1);
      this._wakeGroup.add(s);
      this._wakeSprites.push(s);
      this._wakeParticles.push({
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0, maxLife: 1, size: 1, active: false,
      });
    }
  }
  private updateWakePool(dt: number) {
    if (this._wakeSprites.length === 0) return;
    for (let i = 0; i < this._wakeParticles.length; i++) {
      const p = this._wakeParticles[i];
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        this._wakeSprites[i].visible = false;
        continue;
      }
      p.pos.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(0.96);
      const t = p.life / p.maxLife;
      const s = this._wakeSprites[i];
      s.position.copy(p.pos);
      // Grow over time + fade
      s.scale.setScalar(p.size * (1.5 - t * 0.5));
      (s.material as THREE.SpriteMaterial).opacity = 0.7 * t;
    }
  }

  // === Dust pool (ground vehicles) ===
  private static readonly MAX_DUST = 200;
  private _dustParticles: { pos: THREE.Vector3; vel: THREE.Vector3; life: number; maxLife: number; size: number; active: boolean }[] = [];
  private _dustSprites: THREE.Sprite[] = [];
  private _dustGroup: THREE.Group | null = null;
  private _dustTex: THREE.CanvasTexture | null = null;
  private _initDustPool() {
    this._dustGroup = new THREE.Group();
    this.scene.add(this._dustGroup);
    const size = 64;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d')!;
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(190,170,140,0.85)');
    grad.addColorStop(0.5, 'rgba(160,140,110,0.45)');
    grad.addColorStop(1, 'rgba(140,120,90,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    this._dustTex = new THREE.CanvasTexture(c);
    this._dustTex.colorSpace = THREE.SRGBColorSpace;
    for (let i = 0; i < WeaponSystem.MAX_DUST; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this._dustTex,
        color: 0xc8b08c,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        fog: false,
        blending: THREE.NormalBlending,
      });
      const s = new THREE.Sprite(mat);
      s.visible = false;
      s.scale.setScalar(1);
      this._dustGroup.add(s);
      this._dustSprites.push(s);
      this._dustParticles.push({
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0, maxLife: 1, size: 1, active: false,
      });
    }
  }
  private updateDustPool(dt: number) {
    if (this._dustSprites.length === 0) return;
    for (let i = 0; i < this._dustParticles.length; i++) {
      const p = this._dustParticles[i];
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        this._dustSprites[i].visible = false;
        continue;
      }
      p.pos.addScaledVector(p.vel, dt);
      p.vel.y -= 1.5 * dt; // gravity on dust
      p.vel.multiplyScalar(0.94);
      const t = p.life / p.maxLife;
      const s = this._dustSprites[i];
      s.position.copy(p.pos);
      s.scale.setScalar(p.size * (1.8 - t));
      (s.material as THREE.SpriteMaterial).opacity = 0.5 * t;
    }
  }

  fireMissile(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    target: EnemyHandle | null,
    type: 'MSL' | 'LASM',
    isAlly: boolean,
    tier: 'low' | 'normal' | 'high' = 'normal',
    launcherId: number = -1,
    damagerKind?: Missile['damagerKind'],
    // === 发射速度模型 (per user request: 导弹初速与载机相同, 之后随时间加速到正常速度) ===
    // launchSpeed: 发射瞬间的速度(调用方传载机速度); 缺省 600 = 老的"初速就很高"行为
    // maxSpeed:    加速目标(导弹的正常速度)
    opts: {
      launchSpeed?: number; maxSpeed?: number;
      /** §339: 参数表键(缺省按 type/阵营推断) */
      pKey?: MissileParamKey;
      /** §339: 无制导发射(没锁定就开火) —— 直飞、不搜索、不重新捕获 */
      unguided?: boolean;
      /** §344: 发射者名字(击杀播报) */
      launcherName?: string;
    } = {},
  ): Missile {
    const group = new THREE.Group();
    const body = new THREE.Mesh(this.missileGeo, this.missileMat);
    group.add(body);
    // === Extra missile effects REMOVED (per user request: 除了烟雾和导弹本体以外其它多余的都去掉) ===
    // Previously there were TWO extra additive spheres attached to the
    // missile group: an 'engine glow' sphere (radius 0.4) and a 'hot
    // engine flame' sphere (radius 0.6). Both were redundant — the pooled
    // smoke system's stage-0 'flame' particle already produces a bright
    // yellow-white combustion glow right at the nozzle, in WORLD space so
    // it stays where the missile was when it emitted (correct contrail
    // behaviour). The two group-attached spheres just added visual noise
    // and clipped through the missile body at certain camera angles.
    //
    // Now the missile group contains ONLY the body mesh. Everything else
    // (smoke, flame glow, contrail) is handled by the pooled particle
    // system, which is the correct architecture.
    group.position.copy(origin);
    // 诊断开关: 'missile' 只关本体视觉, 制导/命中/伤害照常
    if (fxOff('missile')) group.visible = false;
    // Orient missile to dir
    const m = new THREE.Matrix4();
    m.lookAt(new THREE.Vector3(0, 0, 0), dir.clone().negate(), new THREE.Vector3(0, 1, 0));
    group.quaternion.setFromRotationMatrix(m);
    this.scene.add(group);

    // === Launch burst VFX (per user request: 舰船发射导弹看起来跟没发射差不多) ===
    // Ships fire from sea level (y≈0) and the player views from kilometers
    // away at altitude. The tiny missile body (radius 0.35) + the thin smoke
    // trail are nearly invisible at that distance, so a ship launching a
    // missile reads as "nothing happened". We add a one-shot launch burst
    // at the firing position:
    //   1. A bright additive flash sphere — expands + fades in ~0.25s, so
    //      the launch point visibly pops even from far away.
    //   2. A dense smoke burst (12 particles) via emitSmokeBurst — gives
    //      the launch position a lingering smoke cloud that reads as "a
    //      missile just left this spot" for ~1.5s after launch.
    //   3. A brief point light — illuminates the ship hull / launcher at
    //      the moment of firing, selling the "muzzle flash" effect.
    // This makes ship/ground missile launches visually unmissable from any
    // distance.
    this.spawnLaunchBurst(origin, isAlly);

    // === Old ribbon-based trail REMOVED (per user request) ===
    // The three ribbon planes (outerRibbon / midRibbon / innerRibbon) were
    // the source of the "竖杠/白点" bug: they were flat PlaneGeometry meshes
    // parented to the missile group, so they rotated WITH the missile.
    // Viewed edge-on, a flat plane appears as a thin vertical bar (竖杠);
    // the hot additive inner ribbon seen end-on appeared as a bright white
    // dot (白点). The pooled SmokeParticle system produces the contrail
    // instead — particles are spawned in WORLD space (not parented to the
    // missile), so they stay behind as a proper volumetric trail.
    //
    // === Hot engine flame sphere REMOVED (per user request) ===
    // Was a small additive sphere at z=-1.5 on the missile group. Removed
    // because the pooled smoke system's stage-0 'flame' particle already
    // produces the bright combustion glow at the nozzle — the sphere was
    // redundant visual noise.

    const missile: Missile = {
      group,
      // Launch with a velocity boost well above any aircraft cruise speed
      // so the missile pulls cleanly away from its launch platform.
      // === Speed re-scale (per user request: F-16 巡航600/最大1100) ===
      // 320 → 600 (≈ the F-16's no-afterburner cruise) so it visibly
      // separates even when the player is accelerating away.
      // === 初速 = 载机速度 (per user request) ==============================
      // 以前写死 600(比巡航还高) ⇒ 导弹一离架就"窜"出去; 现在默认沿用载机速度,
      // 由 update 里的 boost 段**随时间**加速到 maxSpeed。
      velocity: dir.clone().normalize().multiplyScalar(opts.launchSpeed ?? 600),
      // Extended range: MSL now flies for 12s (was 8s), LASM for 16s (anti-
      // ship weapons naturally have longer endurance). Combined with the
      // higher cruise speed below, MSL effective range is now ~5km and
      // LASM is ~8km — comfortably beyond the player's fire-and-forget
      // engagement window.
      // Low-tier enemy missiles get a shorter life (8s) so a maneuvering
      // player can outrun them — they're meant to be easy to dodge.
      // === Missile life doubled (per user request: 所有导弹寿命翻倍) ===
      // MSL 12→24s, LASM 16→32s; low-tier enemy missiles 8/10→16/20s.
      // Combined with the higher cruise speed, MSL effective range is now
      // ~14km — plenty for long-range engagements.
      life: (!isAlly && tier === 'low') ? (type === 'LASM' ? 20.0 : 16.0) : (type === 'LASM' ? 32.0 : 24.0),
      target,
      speed: opts.launchSpeed ?? 600,
      // 加速目标(正常速度): 对空 900 / 对地 820; 低档敌弹给 720(玩家能甩掉)
      maxSpeed: opts.maxSpeed ?? (type === 'LASM' ? 820 : 900),
      type,
      age: 0,
      prev: origin.clone(),
      flown: 0,
      // Stub fields — no longer used by the new pooled particle system.
      trailMesh: null,
      trailPositions: [],
      smokeMat: null,
      outerRibbon: null,
      innerRibbon: null,
      dead: false,
      hit: false,
      reportedHit: false,
      isPlayer: isAlly, // backwards-compat: allied → player list, enemy → enemy list
      isAlly,
      tier,
      launcherId,
      smokePuffs: [],
      smokeEmitT: 0, // emit a puff immediately on the first frame
      // === Derive damagerKind for kill tracking (per user request) ===
      // If the caller didn't pass an explicit damagerKind, derive it from
      // isAlly + launcherId. Player = launcherId=-1 + isAlly=true. Wingman
      // = launcherId>=1 + isAlly=true. Enemy = isAlly=false. Ground units
      // pass an explicit 'ground' damagerKind via the new parameter.
      damagerKind: damagerKind ?? (
        isAlly
          ? (launcherId === -1 ? 'player' : 'wingman')
          : 'enemy'
      ),
      // === §339: 参数表键 + 无制导标记 ======================================
      // pKey 缺省按 type/阵营推断(玩家 MSL ⇒ 'MSL'; 敌方 MSL ⇒ 若 tier 是 low 走 NPC_MSL)。
      // 无制导: 没锁定就开火 —— 直飞、不搜索、不重新捕获(引信照常解除保险)。
      pKey: opts.pKey ?? paramsKeyFor(type, isAlly, tier),
      launcherName: opts.launcherName,
      unguided: opts.unguided === true,
      launchT: 0,
    };
    // §339: 若调用方给了 unguided, 直接**不带目标**(否则第一个捕获循环会把它接上)
    if (missile.unguided) missile.target = null;
    if (isAlly) {
      this.missiles.push(missile);
    } else {
      this.enemyMissiles.push(missile);
    }
    return missile;
  }

  // === Free-fall dumb bomb (per user request) ===
  // Drops a bomb from the given origin with the player's current velocity
  // (so the bomb starts moving forward at the same speed as the aircraft,
  // then falls under gravity). The bomb is added to the `bombs` array and
  // updated each frame by updateBombs().
  dropBomb(origin: THREE.Vector3, initialVel: THREE.Vector3) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(this.bombGeo, this.bombMat);
    group.add(body);
    // Tail fins — 4 thin boxes arranged in a cross.
    const finMat = new THREE.MeshStandardMaterial({ color: 0x4a5468, metalness: 0.4, roughness: 0.7 });
    const finGeo = new THREE.BoxGeometry(0.08, 0.6, 0.4);
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(finGeo, finMat);
      fin.rotation.z = (i * Math.PI) / 2;
      fin.position.z = -0.8;
      group.add(fin);
    }
    group.position.copy(origin);
    // 诊断开关: 'bomb' 只关本体, 弹道与爆炸照常
    if (fxOff('bomb')) group.visible = false;
    this.scene.add(group);
    this.bombs.push({
      mesh: group as unknown as THREE.Mesh,
      velocity: initialVel.clone(),
      life: 12.0, // 12s lifetime — plenty of time to fall from any altitude
      dead: false,
    });
  }

  // === Compute the predicted impact point of a bomb dropped right now ===
  // Used by the engine each frame to render a ground-reticle marker on the
  // HUD. Returns the world position where the bomb would land (terrain Y at
  // the predicted XZ), or null if the bomb would never land within the
  // maximum lifetime.
  // We do a simple analytic solution: at time t, position is
  //   p(t) = p0 + v0 * t + 0.5 * g * t^2   (where g = (0, -GRAVITY, 0))
  // We solve for the time t when y(t) = groundY, then return x(t), z(t).
  predictBombImpact(
    origin: THREE.Vector3,
    initialVel: THREE.Vector3,
    terrainHeight: (x: number, z: number) => number,
    gravity = 60,
  ): THREE.Vector3 | null {
    return this.predictBombImpactTimed(origin, initialVel, terrainHeight, gravity)?.point ?? null;
  }

  // === 带"下落时间"的落点解 (per user request: 指示器要按速度和落点距离结合) =====
  // 与 predictBombImpact 同一套弹道(重力 + 地形高度迭代), 只是额外把解出来的
  // 飞行时间 t 一起返回 —— HUD 用它显示"落弹时间/落点距离", 让指示器不只是个光点。
  predictBombImpactTimed(
    origin: THREE.Vector3,
    initialVel: THREE.Vector3,
    terrainHeight: (x: number, z: number) => number,
    gravity = 60,
  ): { point: THREE.Vector3; time: number } | null {
    // Gravity in world units per second squared. Tuned so a bomb dropped at
    // 1500m altitude with forward speed 300 takes ~10s to land — feels
    // weighty enough to require lead but not so slow it's tedious.
    // (per user request: AC-130侧炮落点预测 — shells pass their own gravity)
    const G = gravity;
    // Iterate a few times to converge on the terrain height (since terrain
    // height depends on XZ which depends on t). Start by assuming flat
    // ground at y=0.
    let groundY = 0;
    let t = -1;
    for (let iter = 0; iter < 4; iter++) {
      // Solve: origin.y + initialVel.y * t - 0.5 * G * t^2 = groundY
      // → 0.5*G*t^2 - initialVel.y*t + (groundY - origin.y) = 0
      // → t = (initialVel.y ± sqrt(initialVel.y^2 - 2*G*(groundY - origin.y))) / G
      // We want the larger root (later time = when the bomb actually lands,
      // not the small-t solution at the apex if the bomb starts above ground).
      const disc = initialVel.y * initialVel.y - 2 * G * (groundY - origin.y);
      if (disc < 0) return null; // bomb is going up and will never come down within physics
      const sq = Math.sqrt(disc);
      const t1 = (initialVel.y - sq) / G;
      const t2 = (initialVel.y + sq) / G;
      // Take the positive root that's larger (the later landing time)
      const candidates = [t1, t2].filter((x) => x > 0);
      if (candidates.length === 0) return null;
      t = Math.max(...candidates);
      if (t > 30) return null; // bomb takes too long — bail
      // Update groundY based on the predicted XZ
      const px = origin.x + initialVel.x * t;
      const pz = origin.z + initialVel.z * t;
      groundY = terrainHeight(px, pz);
    }
    if (t < 0) return null;
    const x = origin.x + initialVel.x * t;
    const z = origin.z + initialVel.z * t;
    const y = groundY;
    return { point: new THREE.Vector3(x, y, z), time: t };
  }

  // === Lightweight bullet-impact spark =========================================
  // Bullets fire at ~20 rounds/sec from the player's gun and even more from
  // wingman / enemy AI. The old code called spawnExplosion() for every bullet
  // hit — that allocates a fresh MeshBasicMaterial, two Mesh objects, AND a
  // PointLight per hit. At 60+ hits/sec across multiple shooters this hammers
  // the GPU and GC, causing the framerate to crater during gun runs.
  //
  // This new helper is allocation-light:
  //   - One tiny sphere mesh (shared geometry, fresh material — but a much
  //     smaller allocation than a full Explosion with PointLight).
  //   - No PointLight at all (lights are the most expensive scene-graph add).
  //   - Short life (0.18s) so it disappears quickly.
  //   - Pushed to the bullets[] list with negative life decay so it reuses the
  //     existing per-frame bullet update path (no separate code path needed).
  //
  // The visual is a small yellow-white spark that fades out — much less
  // impressive than a fireball, but at 60Hz the player can't actually see
  // the difference, and the framerate stays smooth.
  private _sparkGeo: THREE.BufferGeometry | null = null;
  private spawnBulletSpark(pos: THREE.Vector3) {
    if (fxOff('spark')) return;
    if (!this._sparkGeo) {
      this._sparkGeo = new THREE.SphereGeometry(0.45, 5, 4);
    }
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffe080,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this._sparkGeo, mat);
    mesh.position.copy(pos);
    mesh.scale.setScalar(0.6);
    this.scene.add(mesh);
    this.bullets.push({
      mesh,
      velocity: new THREE.Vector3(
        (Math.random() - 0.5) * 8,
        Math.random() * 4,
        (Math.random() - 0.5) * 8,
      ),
      life: 0.18, // ~10 frames at 60Hz — short enough to be cheap
    });
  }

  // === Per-unit-type hit VFX (per user request) ===
  // Different targets produce different spark colours + sizes:
  //   - aircraft: yellow-white metal sparks (default)
  //   - ship (destroyer/cruiser): orange-red fireball + smoke puff
  //   - tank/sam/aa: orange splash + grey smoke
  //   - terrain (land): brown dust kicked up
  //   - terrain_water: blue ripple + white spray (per user request —
  //     机炮和导弹打到水面和陆地都有不同的特效)
  // The caller passes the target's unitType (or undefined for default).
  spawnHitSpark(pos: THREE.Vector3, unitType?: string) {
    if (fxOff('spark')) return;
    // === Effect view culling (per user request: 特效仅在视野内加载) ===
    if (this.lodCameraPos) {
      if (this.lodCameraPos.distanceTo(pos) > 10000) return;
      if (this.lodCamForward) {
        const to = this._fxTo.copy(pos).sub(this.lodCameraPos);
        const dl = to.length();
        if (dl > 1 && to.divideScalar(dl).dot(this.lodCamForward) < 0.42) return;
      }
    }
    if (!this._sparkGeo) {
      this._sparkGeo = new THREE.SphereGeometry(0.45, 5, 4);
    }
    let color = 0xffe080;       // default: yellow-white metal sparks
    let scale = 0.6;
    let life = 0.18;
    let velSpread = 8;
    switch (unitType) {
      case 'destroyer':
      case 'cruiser':
        // Orange-red fireball + larger, longer-lived.
        color = 0xff7020;
        scale = 1.2;
        life = 0.32;
        velSpread = 16;
        break;
      case 'tank':
      case 'sam_launcher':
      case 'aa_vehicle':
        // Orange splash + medium.
        color = 0xffa040;
        scale = 0.9;
        life = 0.24;
        velSpread = 12;
        break;
      case 'aircraft_bomber':
        // Bigger yellow flash — bomber has more surface to spark off.
        color = 0xfff0a0;
        scale = 0.9;
        life = 0.22;
        velSpread = 10;
        break;
      case 'aircraft_fighter':
      case 'player':
      default:
        // Default metal sparks.
        break;
      case 'terrain':
        // === Brown dust kicked up by LAND impact (per user request) ===
        color = 0x8a6a48;
        scale = 0.8;
        life = 0.32;
        velSpread = 14;
        break;
      case 'terrain_water':
        // === Blue ripple + white spray for WATER impact (per user request) ===
        // Handled by spawnWaterSplash() — but we still spawn a small blue
        // tinted spark here for the initial impact flash.
        color = 0x88c8ff;
        scale = 0.7;
        life = 0.22;
        velSpread = 10;
        break;
    }
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this._sparkGeo, mat);
    mesh.position.copy(pos);
    mesh.scale.setScalar(scale);
    this.scene.add(mesh);
    this.bullets.push({
      mesh,
      velocity: new THREE.Vector3(
        (Math.random() - 0.5) * velSpread,
        Math.random() * (velSpread * 0.5),
        (Math.random() - 0.5) * velSpread,
      ),
      life,
    });
    // === Spawn water splash VFX for water impacts (per user request) ===
    if (unitType === 'terrain_water') {
      this.spawnWaterSplash(pos);
    }
  }

  // === Water splash VFX (per user request) ===
  // Spawn a flat ring ripple + an upward column of spray droplets when a
  // bullet or missile hits the water surface. The ring expands outward
  // like a real water impact; the spray column shoots up briefly.
  private _rippleGeo: THREE.BufferGeometry | null = null;
  private spawnWaterSplash(pos: THREE.Vector3) {
    if (fxOff('spark')) return;
    // === 1. Expanding ring ripple on the water surface ===
    if (!this._rippleGeo) {
      this._rippleGeo = new THREE.RingGeometry(0.4, 0.6, 24);
    }
    const rippleMat = new THREE.MeshBasicMaterial({
      color: 0xaaddff,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ripple = new THREE.Mesh(this._rippleGeo, rippleMat);
    ripple.position.copy(pos);
    ripple.position.y = Math.max(pos.y, 0.5); // sit on the water surface
    ripple.rotation.x = -Math.PI / 2; // flat on the water
    this.scene.add(ripple);
    // Animate via the bullets list (negative life decay — we hijack the
    // bullet update path so we don't need a separate updater).
    this.bullets.push({
      mesh: ripple,
      velocity: new THREE.Vector3(0, 0, 0),
      life: 0.9,
    });
    // We need to grow the ripple — set a custom scale growth via userData
    // that the bullet update loop will tick. Since the bullet loop just
    // does position += velocity, we'll grow it here by setting a large
    // initial scale and using the velocity as a scale-rate (negative Y to
    // avoid moving). Simpler: just animate it manually by pushing a
    // second invisible "marker" bullet that ticks scale each frame.
    // Actually easiest: rely on the bullet's velocity to move it slightly
    // and let the user see a brief flash. For a proper growing ripple we
    // need to scale it — let's push it to a dedicated ripple list.
    this.waterRipples.push({ mesh: ripple, life: 0.9, maxLife: 0.9, growRate: 18.0 });
    // === 2. Upward spray column (per user request) ===
    // A short vertical jet of small blue-white droplets — like the splash
    // a real bullet makes hitting water.
    const dropletCount = 8;
    if (!this._sparkGeo) this._sparkGeo = new THREE.SphereGeometry(0.45, 5, 4);
    for (let i = 0; i < dropletCount; i++) {
      const dropMat = new THREE.MeshBasicMaterial({
        color: 0xc8e8ff,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const drop = new THREE.Mesh(this._sparkGeo, dropMat);
      drop.position.copy(pos);
      drop.position.y = Math.max(pos.y, 0.5);
      drop.scale.setScalar(0.35 + Math.random() * 0.25);
      this.scene.add(drop);
      // Upward velocity + outward spread — like a splash plume.
      const angle = Math.random() * Math.PI * 2;
      const horizSpeed = 4 + Math.random() * 6;
      this.bullets.push({
        mesh: drop,
        velocity: new THREE.Vector3(
          Math.cos(angle) * horizSpeed,
          10 + Math.random() * 8, // strong upward component
          Math.sin(angle) * horizSpeed,
        ),
        life: 0.6 + Math.random() * 0.3,
      });
    }
  }
  // === Water ripple list (per user request) ===
  // Tracked separately so we can grow them each frame (the bullet loop
  // only translates — it doesn't scale).
  private waterRipples: { mesh: THREE.Mesh; life: number; maxLife: number; growRate: number }[] = [];

  // === Per-unit-type missile detonation VFX (per user request) ===
  // Calls spawnExplosion with a scale + tint appropriate to the target.
  // Naval units get a much bigger fireball + secondary flash; aircraft
  // get the default; ground armor gets a dust-and-debris tinted burst.
  // === Water vs land differentiation (per user request) ===
  // 'terrain' → land impact (dust+debris), 'terrain_water' → water impact
  // (ripple+spray, smaller fireball).
  spawnMissileDetonation(pos: THREE.Vector3, unitType?: string) {
    let scale = 1.8;
    switch (unitType) {
      case 'destroyer':
        scale = 3.2;
        break;
      case 'cruiser':
        scale = 4.0;
        break;
      case 'tank':
      case 'sam_launcher':
      case 'aa_vehicle':
        scale = 2.6;
        break;
      case 'aircraft_bomber':
        scale = 2.6;
        break;
      case 'aircraft_fighter':
      case 'player':
      default:
        scale = 1.8;
        break;
      case 'terrain':
        // Ground impact — dusty burst, smaller than a unit kill.
        scale = 1.4;
        break;
      case 'terrain_water':
        // Water impact — smaller fireball, plus a big splash.
        scale = 1.2;
        this.spawnWaterSplash(pos);
        this.spawnWaterSplash(pos); // double-up for a bigger splash on missile hits
        break;
    }
    this.spawnExplosion(pos, scale);
  }

  // === Redone spawnExplosion (per user request — 特效更华丽) ===
  // Was: single fireball sphere + 1 secondary flash + 1 point light.
  // Now layers multiple visual components for a cinematic explosion:
  //   1. Bright initial flash (additive yellow-white sphere)
  //   2. Main fireball (orange sphere, grows + fades)
  //   3. Dark smoke shroud (grey sphere, grows slower + lingers)
  //   4. Outward shockwave ring (flat torus, expands + fades)
  //   5. Hot sparks (8-12 small additive spheres flying outward)
  //   6. Two point lights (one bright quick flash, one warm glow that fades)
  // All layers are pushed to the explosions list and ticked together.
  //
  // === Effect LOD system (per user request: 爆炸等特效在玩家视野范围播放的时候才换成高质量特效，远处用简化特效) ===
  // The system queries `this.lodCameraPos` (set by the engine each frame via
  // setLodCamera()) to compute the distance from the explosion to the camera.
  //   - Distance < 2500: full 6-layer cinematic explosion (current behavior)
  //   - Distance 2500-5000: medium LOD — flash + fireball + smoke shroud only
  //     (no sparks, no shockwave ring, only 1 point light)
  //   - Distance > 5000: low LOD — just the fireball + 1 point light, much
  //     smaller scale. Reads as a distant puff of light without the expensive
  //     sparks/rings/shockwave geometry.
  // This keeps the close-up explosions cinematic while making 20+ distant
  // explosions across the battlefield cheap to render.
  // === Effect view + distance culling (per user request: 特效仅在视野内加载) ===
  // Effects behind the camera (cone test) or beyond the effect draw distance
  // are NOT spawned — the player can't see them, so they'd only waste draw
  // calls and fill the explosion list.
  /**
   * 生成一次爆炸。
   * @param timeScale 动画时间倍率: >1 = 播得更慢(1/6 速度就传 6)。
   *   爆炸的长大/淡出进度用的是 t = 1 - life/maxLife, 所以只要把这一批图层的
   *   life/maxLife 统一乘上倍率, 形状与膨胀速度就整体慢下来(不用逐个改 growthRate)。
   */
  spawnExplosion(pos: THREE.Vector3, scale: number, particleMult = 1, timeScale = 1) {
    const _exFirst = this.explosions.length;   // 本批图层的起点(函数末尾统一下调时间)
    // 诊断开关: 'explosion' 关掉时整层不生成(纯视觉, 伤害由调用方自己结算)。
    if (fxOff('explosion')) return;
    // === Effect LOD — compute distance to camera ===
    // If lodCameraPos is null (engine hasn't set it yet), assume close.
    let dist = 0;
    if (this.lodCameraPos) {
      dist = this.lodCameraPos.distanceTo(pos);
    }
    const MAX_EFFECT_DIST = 14000;
    if (dist > MAX_EFFECT_DIST) return;
    if (this.lodCameraPos && this.lodCamForward) {
      const to = this._fxTo.copy(pos).sub(this.lodCameraPos);
      const dl = to.length();
      // Wide half-angle (~65°, cos ≈ 0.42): anything outside is safely
      // off-screen; the actual camera FOV is narrower.
      if (dl > 1 && to.divideScalar(dl).dot(this.lodCamForward) < 0.42) return;
    }
    // === FX 替换钩子 (per user request: 编辑器序列帧特效完全替换原生爆炸) ===
    // 可见距离内的每次爆炸先问 engine 的 FxBattleLayer(槽位 f 地面/4 空中,
    // 按离地高度自动归类);true = 已被新式预设替换或吞掉 → 跳过原生层。
    if (this.onFxOverride?.(pos, scale) === true) return;
    // === Cap concurrent explosions (per user request: 立体爆炸特效不可以连续堆叠造成画面卡顿) ===
    // Beyond MAX_EXPLOSIONS concurrent effects we force the cheap LOD so a
    // big battle can't accumulate dozens of high-detail explosions (each
    // with multiple point lights + spark meshes) and tank the framerate.
    const MAX_EXPLOSIONS = 24;
    const capped = this.explosions.length >= MAX_EXPLOSIONS;
    const lod: 'high' | 'medium' | 'low' = capped
      ? 'low'
      : dist < 2500 ? 'high' : dist < 5000 ? 'medium' : 'low';
    // Point lights are the priciest part of an explosion — cap concurrent
    // live explosion lights at 3 so a chain-reaction kill feed can't
    // overwhelm the renderer's light pass.
    const liveLights = this.explosions.reduce((n, e) => n + (e.light.intensity > 0 ? 1 : 0), 0);
    const allowLight = lod === 'high' && liveLights < 3;
    // === 图集可用? (per user request: 爆炸 → 图集精灵动画) ===
    // 首次爆炸时后台加载图集(加载完成前/缺图集时自动走老 mesh 路径, 不阻塞不崩)。
    void this.ensureFxAtlas();
    const useAtlas = !!(this._fxFireQ && this._fxSmokeQ);

    // === 1. Initial flash ===
    // 图集路径: 不建材质/几何, 只留一个占位(视觉由 fire 图集池画)。
    const flash = useAtlas ? this.makeAtlasAnchor(pos) : new THREE.Mesh(this.explosionGeo, new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    flash.position.copy(pos);
    flash.scale.setScalar(scale * 0.8);
    if (!useAtlas) this.scene.add(flash);
    // === 闪光层改用固定光池 (per user request: 重置导弹爆炸特效 / 并保持"可见点光数量恒定") ===
    // 原来这里每爆一次就 `new THREE.PointLight` —— 数量一变, three 的 program cache key 失效,
    // 当时所有材质当场重编译(长卡顿的根因)。池灯常驻场景、只用强度表达, 数量永不变化。
    // 池满时 _takeLight 返回零强度未入场景的灯(pooled=false) → 这一帧不发光, 也不会建灯。
    const flashTaken = this._takeLight(0xffffff, 8, 90, 2);
    this.explosions.push({ mesh: flash, light: flashTaken.light, pooled: flashTaken.pooled, life: 0.12, maxLife: 0.12, atlas: useAtlas ? 'fire' : undefined, baseScale: scale * 0.9 });

    // === 2. Main fireball ===
    // 图集路径不建材质/几何(由 fire 图集池绘制), 老路径照旧。
    const fire = useAtlas ? this.makeAtlasAnchor(pos) : new THREE.Mesh(this.explosionGeo, new THREE.MeshBasicMaterial({
      color: 0xffaa44,
      transparent: true,
      opacity: 1.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    fire.position.copy(pos);
    // === LOD: shrink fireball at distance so it doesn't dominate the view ===
    const fireScale = lod === 'low' ? scale * 0.1 : scale * 0.2;
    fire.scale.setScalar(fireScale);
    if (!useAtlas) this.scene.add(fire);
    // === LOD: only emit point lights at high LOD (and within the light budget) ===
    // Point lights are expensive — at medium/low LOD we skip them entirely.
    // The fireball mesh itself is bright enough to read as an explosion.
    // 取自常驻池(per fix ①): 池里的灯不增删 → 场景点光数量恒定。
    const fireTaken = allowLight
      ? this._takeLight(0xffaa44, 5, 700, 2)
      : { light: new THREE.PointLight(0, 0, 0, 0), pooled: false };
    const fireLight = fireTaken.light;
    fireLight.position.copy(pos);
    // === 池满时【不再新建灯】(per fix: 光数一变 → 全材质重编译 → 每秒多次长卡顿) ===
    // three 的着色器程序缓存键里含 `numPointLights`; 只要可见点光数量变化, 当时**所有**
    // 材质都要重新 link —— 战斗中爆炸密集 → 池反复用尽 → 每次`scene.add(临时灯)`都让全场
    // 重编译, 表现为"每隔不到一秒一次的长时卡顿"。这里改为: 池满则该特效这一帧/火球
    // 不发光(它的网格本身是自发光亮面, 观感几乎无差别), 但**绝不改变场景灯数**。
    if (!fireTaken.pooled) fireLight.intensity = 0;
    this.explosions.push({ mesh: fire, light: fireLight, pooled: fireTaken.pooled, life: 1.4, maxLife: 1.4, atlas: useAtlas ? 'fire' : undefined, baseScale: fireScale * 4.2 });

    // === 3. Dark smoke shroud ===
    // === LOD: skip smoke shroud at low LOD ===
    if (lod !== 'low') {
      const smoke = useAtlas ? this.makeAtlasAnchor(pos) : new THREE.Mesh(this.explosionGeo, new THREE.MeshBasicMaterial({
        color: 0x3a3030,
        transparent: true,
        opacity: 0.75,
        blending: THREE.NormalBlending,
        depthWrite: false,
      }));
      smoke.position.copy(pos);
      smoke.scale.setScalar(scale * 0.3);
      if (!useAtlas) this.scene.add(smoke);
      const smokeTaken = this._takeLight(0xff8030, 0.8, 140, 2);
      this.explosions.push({ mesh: smoke, light: smokeTaken.light, pooled: smokeTaken.pooled, life: 2.2, maxLife: 2.2, atlas: useAtlas ? 'smoke' : undefined, baseScale: scale * 2.6 });
    }

    // === 4. Outward shockwave ring ===
    // === LOD: skip shockwave at medium + low LOD ===
    if (lod === 'high') {
      // 环也池化: 几何与材质各只建一份(原来每爆一次 new RingGeometry + new 材质 + new 灯)。
      if (!this._ringGeo) this._ringGeo = new THREE.RingGeometry(0.5, 0.7, 24);
      if (!this._ringMatTpl) this._ringMatTpl = new THREE.MeshBasicMaterial({
        color: 0xffd080,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const ringMat = this._ringMatTpl.clone();   // 逐爆淡出需要独立 opacity
      const ring = new THREE.Mesh(this._ringGeo, ringMat);
      ring.position.copy(pos);
      // Orient the ring randomly so explosions don't all face the same way.
      ring.rotation.x = Math.random() * Math.PI;
      ring.rotation.y = Math.random() * Math.PI;
      ring.scale.setScalar(scale * 0.4);
      this.scene.add(ring);
      // 共享哑灯: 只为满足 Explosion.light 的类型与"强度动画"代码, 永不入场景(数量恒定)。
      if (!this._dummyLight) this._dummyLight = new THREE.PointLight(0, 0, 0, 0);
      this.explosions.push({ mesh: ring, light: this._dummyLight, pooled: false, life: 0.6, maxLife: 0.6 });
    }

    // === 5. Hot sparks ===
    // === LOD: sparks only at high LOD (medium/low skip the 8-12 spark spheres) ===
    // particleMult (per user request: 防空炮弹爆炸粒子减半) scales the spark
    // count down — AA flak passes 0.5 so its puffs are half as busy.
    if (lod === 'high') {
      const sparkCount = Math.max(1, Math.floor((8 + Math.floor(Math.random() * 5)) * particleMult));
      for (let i = 0; i < sparkCount; i++) {
        const sparkMat = new THREE.MeshBasicMaterial({
          color: i % 2 === 0 ? 0xffe080 : 0xff8030,
          transparent: true,
          opacity: 1.0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const spark = new THREE.Mesh(this._sparkGeo ?? (this._sparkGeo = new THREE.SphereGeometry(0.45, 5, 4)), sparkMat);
        spark.position.copy(pos);
        spark.scale.setScalar(scale * 0.15);
        this.scene.add(spark);
        // Push to bullets list with a velocity — bullets get translated each
        // frame and decay. We give them a strong outward velocity.
        const angle = Math.random() * Math.PI * 2;
        const elev = (Math.random() - 0.5) * Math.PI;
        const speed = 18 + Math.random() * 20;
        this.bullets.push({
          mesh: spark,
          velocity: new THREE.Vector3(
            Math.cos(angle) * Math.cos(elev) * speed,
            Math.sin(elev) * speed,
            Math.sin(angle) * Math.cos(elev) * speed,
          ),
          life: 0.7 + Math.random() * 0.4,
          // === Sparks are visual only (per user request: 修复连环爆炸) ===
          // Was un-tagged → defaulted to 4 damage per spark, so every
          // explosion chipped nearby fighters and cascaded into the
          // "chain explosion" the player saw.
          damage: 0,
        });
      }
    }

    // === 6. Secondary warm glow light (lingers after the flash) ===
    // === LOD: only at high LOD — medium/low skip the secondary glow light ===
    if (allowLight) {
      // 取自常驻池(per fix ①): 池满就不加第二盏, 绝不现场建灯。
      const glowTaken = this._takeLight(0xff8030, 2, 500, 2);
      const glowLight = glowTaken.light;
      glowLight.position.copy(pos);
    // === 池满时【不再新建灯】(per fix: 光数一变 → 全材质重编译 → 每秒多次长卡顿) ===
    // three 的着色器程序缓存键里含 `numPointLights`; 只要可见点光数量变化, 当时**所有**
    // 材质都要重新 link —— 战斗中爆炸密集 → 池反复用尽 → 每次`scene.add(临时灯)`都让全场
    // 重编译, 表现为"每隔不到一秒一次的长时卡顿"。这里改为: 池满则该特效这一帧/辉光
    // 不发光(它的网格本身是自发光亮面, 观感几乎无差别), 但**绝不改变场景灯数**。
      if (!glowTaken.pooled) glowLight.intensity = 0;
      // We push a fake explosion entry so the light gets released when it dies.
      this.explosions.push({
        mesh: new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()),
        light: glowLight,
        pooled: glowTaken.pooled,
        life: 1.0,
        maxLife: 1.0,
      });
    }
    // 本批图层统一放慢/加快(见 timeScale 的说明)
    if (timeScale !== 1) {
      for (let i = _exFirst; i < this.explosions.length; i++) {
        const ex = this.explosions[i];
        ex.life *= timeScale;
        ex.maxLife *= timeScale;
      }
    }
  }

  // === Cheap explosion (per user request: 海面单位被击毁时播放廉价的爆炸特效) ===
  // A reduced "budget" explosion used for naval-unit destruction: just a
  // bright fireball + a smoke shroud, no flash ring, sparks, or point
  // lights. Reads as a proper kill at distance but costs a fraction of a
  // full high-LOD explosion — and never contributes to the light budget.

  spawnCheapExplosion(pos: THREE.Vector3, scale: number) {
    // 诊断开关(同 spawnExplosion)
    if (fxOff('explosion')) return;
    // === FX 替换钩子(同 spawnExplosion):槽位预设存在时廉价爆炸同样被替换 ===
    if (this.onFxOverride?.(pos, scale) === true) return;
    const fireMat = new THREE.MeshBasicMaterial({
      color: 0xffaa44,
      transparent: true,
      opacity: 1.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const fire = new THREE.Mesh(this.explosionGeo, fireMat);
    fire.position.copy(pos);
    fire.scale.setScalar(scale * 0.25);
    this.scene.add(fire);
    this.explosions.push({ mesh: fire, light: new THREE.PointLight(0, 0, 0, 0), life: 1.2, maxLife: 1.2 });

    const smokeMat = new THREE.MeshBasicMaterial({
      color: 0x3a3030,
      transparent: true,
      opacity: 0.8,
      blending: THREE.NormalBlending,
      depthWrite: false,
    });
    const smoke = new THREE.Mesh(this.explosionGeo, smokeMat);
    smoke.position.copy(pos);
    smoke.scale.setScalar(scale * 0.4);
    this.scene.add(smoke);
    this.explosions.push({ mesh: smoke, light: new THREE.PointLight(0, 0, 0, 0), life: 2.0, maxLife: 2.0 });
  }

  // === Terrain occlusion support (per user request) ===
  // When terrainHeight is provided, bullets and missiles are checked against
  // terrain each frame: if their position falls below the terrain height at
  // their XZ, they're treated as having hit terrain (removed + dust VFX).
  // Bombs always need terrainHeight (it's how they detonate).
  update(
    dt: number,
    enemies: EnemyHandle[],
    playerPos: THREE.Vector3,
    playerVel: THREE.Vector3,
    playerHp: { hp: number; alive: boolean; onHit: (dmg: number, kind?: DamageKind) => void },
    allies?: EnemyHandle[],
    onAllyHit?: (a: EnemyHandle, dmg: number) => void,
    terrainHeight?: (x: number, z: number) => number,
    onBombHit?: (pos: THREE.Vector3) => void,
    // === Tactical nuke (per user request: NKV 投掷炸弹型) ===
    // Called when a bomb tagged `isNuke` detonates — the engine runs the
    // 3km blast + mushroom-cloud FX there instead of normal bomb splash.
    onNuke?: (pos: THREE.Vector3) => void,
    // === Nuke missile (per user request: NKV 可锁定远程高速导弹) ===
    // Called when a missile tagged `isNuke` impacts a target or terrain —
    // the engine runs the 3km blast there instead of normal single-target
    // damage.
    onNukeMissile?: (pos: THREE.Vector3) => void,
    onMiss?: (m: Missile) => void,
    onPlayerHit?: () => void,
    // === P0-b: 联机玩家目标列表 ===
    // 不传 → 退化为"只有本地玩家"(单机零变化)。传了 → 敌机机炮可命中远端玩家。
    playerTargets?: PlayerHitTarget[],
  ) {
    // Bullets
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      // === Shell physics (per user request: 抛物线炮弹 / 高速直射炮弹) ===
      // Apply gravity (parabolic arc for artillery, 0 for direct-fire tank rounds)
      // and drag (shells slow down over time, bullets don't).
      if (b.gravity) {
        b.velocity.y -= b.gravity * dt;
      }
      if (b.drag) {
        b.velocity.multiplyScalar(1 - b.drag * dt);
      }
      b.mesh.position.addScaledVector(b.velocity, dt);
      // Spin shells so they look like rotating bullets in flight
      if (b.spin) {
        b.mesh.rotation.x += b.spin * dt;
        b.mesh.rotation.y += b.spin * 0.7 * dt;
      }
      b.life -= dt;
      // === Enemy bullets can hit the player (per user request: 敌机机炮能打中玩家) ===
      // Enemy/ground bullets only collide with the `enemies` list — the player
      // isn't in it, so enemy guns previously never connected. Direct check:
      // === 玩家目标列表 (P0-b: 联机远端玩家) ===
      // 原实现只判断本地玩家一个点。改成遍历 playerTargets —— 单机时这个数组
      // 恰好只有本地玩家一项(见引擎 updateWeapons 的构造), 因此行为逐帧不变;
      // 联机时远端玩家也进列表, 敌机机炮就能打中他们。命中半径沿用原来的 8。
      const gunners: PlayerHitTarget[] = playerTargets ?? [
        { pos: playerPos, hp: playerHp },
      ];
      if (b.damagerKind === 'enemy') {
        for (const g of gunners) {
          if (!g.hp.alive) continue;
          const pDist = b.mesh.position.distanceTo(g.pos);
          if (pDist < 8) {
            b.life = 0;
            g.hp.onHit((b.isShell ? (b.damage ?? 18) : 4) * WEAPON_DAMAGE_SCALE, 'gun');
            break;
          }
        }
        if (b.life <= 0) continue;
      }
      // Check enemy collisions
      for (const e of enemies) {
        if (!e.alive) continue;
        // === Enemy bullets never hit other enemy units (per user request:
        //     修复战斗机"连环爆炸") ===
        // Enemy/ground bullets had NO faction filter here — in a furball the
        // bandits chasing the player were close enough that their guns shot
        // EACH OTHER down, so the player saw nearby fighters "chain-explode"
        // after one missile hit. Enemy bullets now only damage the player
        // (handled above) and allied units — never other enemies. This keeps
        // friendly/player bullets unchanged (they still hit enemies).
        if (b.damagerKind === 'enemy' && !e.isAlly) continue;
        // Shells have a larger collision radius than bullets; fixed-gun
        // player bullets get an even larger one (per user request).
        const hitR = b.isShell ? 14 : (b.hitRadius ?? 8);
        if (b.mesh.position.distanceTo(e.position) < hitR) {
          // Shells do more damage than bullets.
          // === Ace gun halving (per user request: T-00 机炮对王牌减半) ===
          // Non-shell bullets honour b.damage too (debris uses damage:0).
          const gunDmg = aceDamage(e, b.isShell ? (b.damage ?? 18) : (b.damage ?? 4), 'gun');
          if (gunDmg > 0) { e.lastWeaponKind = 'gun'; e.hp -= gunDmg; }
          // === A-10 GAU-8 blast (per user request: A-10机炮爆炸范围) ===
          // Explosive rounds damage nearby targets within blastRadius.
          if (b.blastRadius && b.blastRadius > 0) {
            this.spawnExplosion(b.mesh.position.clone(), 0.7);
            for (const t2 of enemies) {
              if (!t2.alive || t2 === e) continue;
              const bd = t2.position.distanceTo(b.mesh.position);
              if (bd <= b.blastRadius) {
                const splashDmg = aceDamage(t2, 4 * (1 - bd / b.blastRadius), 'splash');
                if (splashDmg > 0) {
                  t2.lastWeaponKind = 'gun';
                  t2.hp -= splashDmg;
                  if (b.damagerKind) t2.lastDamagerKind = b.damagerKind;
                  if (b.launcherName) t2.lastDamagerName = b.launcherName;   // §346
                }
              }
            }
          }
          // === Tag the damager (per user request: 单位的摧毁播报只播报自己和僚机打的) ===
          // Stamp the target with who shot it so killEnemy() can decide
          // whether to play a kill notification.
          if (b.damagerKind) {
            e.lastDamagerKind = b.damagerKind;
            if (b.launcherName) e.lastDamagerName = b.launcherName;   // §346
          }
          // === Player HIT broadcast (per user request) ===
          // Only the player's own weapons announce "HIT" — wingman/AI hits
          // stay silent.
          if (b.damagerKind === 'player' && onPlayerHit) {
            onPlayerHit();
          }
          // === Per-unit-type hit spark (per user request) ===
          // Was: this.spawnBulletSpark(b.mesh.position.clone());
          // Now dispatches by target type so naval/armor hits feel meatier.
          this.spawnHitSpark(b.mesh.position.clone(), e.unitType);
          // Shells produce a bigger impact explosion
          if (b.isShell) {
            this.spawnExplosion(b.mesh.position.clone(), 1.8);
          }
          b.life = 0;
          break;
        }
      }
      // === Terrain occlusion for bullets (per user request) ===
      // If the bullet's position is below the terrain height at its XZ, it
      // hit terrain — despawn with the appropriate VFX.
      // === Water vs land differentiation (per user request) ===
      // Terrain height < 5 = water/wet-sand zone → spawn 'terrain_water'
      // (blue ripple + spray). Terrain >= 5 = land → 'terrain' (brown dust).
      if (b.life > 0 && terrainHeight) {
        const ty = terrainHeight(b.mesh.position.x, b.mesh.position.z);
        if (b.mesh.position.y < ty + 0.5) {
          const terrainType = ty < 5 ? 'terrain_water' : 'terrain';
          this.spawnHitSpark(b.mesh.position.clone(), terrainType);
          b.life = 0;
        }
      }
      if (b.life <= 0) {
        this.scene.remove(b.mesh);
        // === Dispose per-shot resources (per user request: 击毁时可能卡顿) ===
        // Bullets share bulletGeo.geom + bulletGeo.mat (no dispose needed).
        // Shells + rocket salvos + sparks each get their OWN material (so
        // they can be coloured per side). Without dispose() these per-shot
        // materials accumulate and trigger GC sweeps. We check: if the
        // bullet's material is NOT the shared bulletGeo.mat, dispose it.
        // Shell geometry is shared (this.shellGeo) so we don't dispose that.
        const bMat = (b.mesh as THREE.Mesh).material as THREE.Material | undefined;
        if (bMat && this.ownsMat(bMat)) {
          bMat.dispose();
        }
        this.bullets.splice(i, 1);
      }
    }

    // Player + wingman missiles — these are allied (isAlly=true).
    // They can only damage enemy targets (isAlly=false). Allied
    // aircraft (player + wingmen + carriers) are passed as part of the
    // target list but filtered out by the friendly-fire check.
    this.updateMissiles(this.missiles, dt, enemies, playerPos, undefined, terrainHeight, onMiss, onPlayerHit, onNukeMissile);

    // Enemy missiles — these are hostile (isAlly=false). They may
    // damage the player AND allied wingmen/carriers. We pass the full
    // ally list (provided by the engine) so they can be hit too; the
    // friendly-fire filter inside updateMissiles ensures enemy missiles
    // only damage isAlly=true targets.
    const enemyTargets: EnemyHandle[] = [];
    if (allies && allies.length > 0) {
      enemyTargets.push(...allies);
    }
    const playerHandle: EnemyHandle = {
      id: -1,
      group: null as any,
      position: playerPos.clone(),
      velocity: playerVel.clone(),
      alive: playerHp.alive,
      hp: playerHp.hp,
      isBomber: false,
      isAlly: true,
      name: 'PLAYER',
    };
    enemyTargets.push(playerHandle);
    this.updateMissiles(this.enemyMissiles, dt, enemyTargets, playerPos, (e, dmg) => {
      if (e.id === -1) {
        playerHp.onHit(dmg * WEAPON_DAMAGE_SCALE, 'missile');
      } else if (onAllyHit) {
        onAllyHit(e, dmg);
      }
    }, terrainHeight);

    // === Bombs (per user request) ===
    // Free-fall physics + terrain/unit collision.
    this.updateBombs(dt, enemies, terrainHeight, onBombHit, onNuke);

    // === Update pooled smoke particles ===
    // Called ONCE per frame (not per missile) — all active particles in the
    // shared pool are advanced together. This is the key efficiency win: we
    // don't iterate per-missile smokePuffs arrays anymore, just one flat
    // scan over the pool.
    this.updateSmokeParticles(dt);

    // === 曳光批量绘制 (per user request: 实体特效改批量/精灵绘制) ===
    this.syncFxTracer();
    // === 爆炸图集精灵池同步(图集层没有自己的 mesh, 每帧把进度/尺寸写进实例属性) ===
    this.syncFxAtlas();

    // === Update wake + dust trails (per user request: 海迹 / 拖尾灰尘) ===
    // Single flat scan over each pool — cheap even when full.
    this.updateWakePool(dt);
    this.updateDustPool(dt);

    // Explosions — update each layer with appropriate growth + fade
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const ex = this.explosions[i];
      ex.life -= dt;
      const t = 1 - ex.life / ex.maxLife;
      // === Per-layer growth rate (per user request — 特效更华丽) ===
      // Different explosion layers should grow at different rates:
      //   - shockwave ring (RingGeometry) → fast expand (grow 12×)
      //   - smoke shroud (dark grey) → slow expand (grow 4×)
      //   - fireball + flash → medium expand (grow 6×)
      // We detect the layer by checking the material color.
      // 图集层没有自己的 mesh/材质(占位不入场景), 视觉由 syncFxAtlas 画 → 跳过老动画。
      if (ex.atlas) {
        if (ex.light.intensity > 0) ex.light.intensity = Math.max(0, 4 * (1 - t));
        if (ex.life <= 0) { this._dropLight(ex); this.explosions.splice(i, 1); }
        continue;
      }
      const mat = ex.mesh.material as THREE.MeshBasicMaterial;
      let growthRate = 6;
      if (mat.color && mat.color.getHex() === 0x3a3030) growthRate = 4;        // smoke shroud
      else if (ex.mesh.geometry && (ex.mesh.geometry as THREE.RingGeometry).type === 'RingGeometry') growthRate = 14; // shockwave
      else if (mat.color && mat.color.getHex() === 0xffd080) growthRate = 14;  // shockwave ring (by color)
      ex.mesh.scale.setScalar(THREE.MathUtils.lerp(ex.mesh.scale.x, ex.mesh.scale.x + 0.001 + t * growthRate, 0.5));
      mat.opacity = Math.max(0, 1 - t);
      if (ex.light.intensity > 0) {
        ex.light.intensity = Math.max(0, 4 * (1 - t));
      }
      if (ex.life <= 0) {
        this.scene.remove(ex.mesh);
        // 池化灯 → 只归还(灯留在 scene 里, 数量恒定); 非池化(无池回退路径)
        // 才真正从场景移除。per fix ①
        this._dropLight(ex);
        // === Dispose per-explosion resources (per user request: 击毁时可能卡顿) ===
        // Each explosion creates its own MeshBasicMaterial instances (flash,
        // fire, smoke, shockwave ring all get unique materials so they can
        // fade independently). Without dispose() these accumulate in GPU
        // memory and trigger periodic GC sweeps that stutter the frame.
        // The shared explosionGeo (sphere) is NOT disposed — it's cached on
        // the weapon system instance and reused. The RingGeometry (shockwave)
        // IS disposed because each explosion creates its own ring instance.
        const meshMat = ex.mesh.material as THREE.Material | THREE.Material[];
        if (Array.isArray(meshMat)) meshMat.forEach((m) => m.dispose());
        else meshMat?.dispose();
        // Only dispose geometries that are unique per-explosion (RingGeometry
        // is created per-spawn). The sphere explosionGeo is shared.
        const g = ex.mesh.geometry as THREE.BufferGeometry;
        if (g && g.type === 'RingGeometry') g.dispose();
        // The "fake" mesh used to host the secondary glow light has an empty
        // BufferGeometry — dispose that too.
        if (g && g.type === 'BufferGeometry' && g.attributes.position === undefined) g.dispose();
        this.explosions.splice(i, 1);
      }
    }

    // === Water ripples (per user request) ===
    // Grow + fade the expanding ring each frame.
    for (let i = this.waterRipples.length - 1; i >= 0; i--) {
      const r = this.waterRipples[i];
      r.life -= dt;
      if (r.life <= 0) {
        this.scene.remove(r.mesh);
        (r.mesh.material as THREE.MeshBasicMaterial).dispose();
        this.waterRipples.splice(i, 1);
        continue;
      }
      const lifeFrac = r.life / r.maxLife;
      const grow = 1.0 + r.growRate * (r.maxLife - r.life);
      r.mesh.scale.setScalar(grow);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.85 * lifeFrac;
    }
  }

  private updateMissiles(
    list: Missile[],
    dt: number,
    targets: EnemyHandle[],
    playerPos: THREE.Vector3,
    onHitCb?: (e: EnemyHandle, dmg: number) => void,
    terrainHeight?: (x: number, z: number) => number,
    onMissCb?: (m: Missile) => void,
    onPlayerHitCb?: () => void,
    onNukeMissileCb?: (pos: THREE.Vector3) => void,
  ) {
    const _tmp = new THREE.Vector3();
    const _desired = new THREE.Vector3();
    const _cur = new THREE.Vector3();
    /** §339: 本帧转向前的速度方向(转向限速率要用它, 不能用 _cur —— 它在 PN 分支里会被覆盖) */
    const _pre = new THREE.Vector3();
    /** §339: 胶囊命中用的"弹体前端"临时点 */
    const _segEnd = new THREE.Vector3();
    const _newDir = new THREE.Vector3();
    const _toTarget = new THREE.Vector3();
    const _seg = new THREE.Vector3();
    const _closest = new THREE.Vector3();

    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m.dead) {
        // === Miss tracking (per user request) ===
        // If the missile died WITHOUT damaging any target, fire the miss
        // callback so the engine can play a radio callout. We only do this
        // for allied missiles (player + wingman) so the player gets
        // feedback on their own shots — enemy missile misses are silent
        // (otherwise the radio would be constant noise).
        if (!m.reportedHit && m.isAlly && onMissCb) {
          onMissCb(m);
        }
        // === §343 finishBlow: 擦身而过的"终结爆炸"(原作 .MISSILE_COMMON.finishBlow*) =====
        // 打空/到期的导弹**不是无声消失**: 如果它是一枚敌方弹、且在玩家附近
        // (finishBlowNear 60m ~ finishBlowDistMax 750m)终结, 就在原地放一团**时长更长**
        // 的爆炸(2~3s, 用 spawnExplosion 的 timeScale) —— 玩家感到的"差一点就打中我",
        // 原作里多半来自这套演出, 而不是真的碰上了。
        // 只对**敌方弹**做(我方弹打空不该在玩家视野里炸一团)。
        if (!m.hit && !m.isAlly) {
          const C = missileCommon();
          const dToPlayer = m.group.position.distanceTo(playerPos);
          if (dToPlayer >= C.finishBlowNear && dToPlayer <= C.finishBlowDistMax) {
            const span = Math.max(0, C.finishBlowTimeMax - C.finishBlowTimeMin);
            const timeScale = C.finishBlowTimeMin + Math.random() * span;
            this.spawnExplosion(m.group.position.clone(), 0.85, 1, timeScale);
            this._finishBlows += 1;
          }
        }
        this.scene.remove(m.group);
        // Smoke particles are pooled — they live in the shared smokeGroup
        // and are recycled by updateSmokeParticles() when their life
        // expires. We do NOT remove them here; the missile's per-missile
        // smokePuffs array is always empty in the new system.
        m.smokePuffs.length = 0;
        list.splice(i, 1);
        continue;
      }
      // === §339 AC7AH 参数表 ==================================================
      // 每弹种每帧取一次(带缓存 ⇒ 现场 `wpn` 改参立刻生效, 且不吃性能)。
      const WP = paramsFor(m.pKey ?? paramsKeyFor(m.type, m.isAlly, m.tier));
      if (m.launchT === undefined) m.launchT = 0;
      // 无制导发射(没锁定就开火): **不搜索、不捕获、不重新捕获、不转向** ——
      // 沿发射方向直飞, 但引信照常解除保险(撞上照样算命中), 也照常吃重力/寿命。
      // [!] 这里**不能**置 noReacquire: 那条分支是"干扰弹/擦过之后无害化", 它会
      //     `continue` 跳过命中判定 ⇒ 无制导弹就永远不会命中。所以只用 unguided 标记,
      //     下面的捕获块与转向块各自让路, 命中判定照走。
      if (m.unguided) m.target = null;
      // 统一的"不制导"判据: 无制导发射 或 已对当前目标切断制导(擦过目标)。
      // 两者的共同点 = 不再搜索/转向, 但**引信与命中判定照常**(与 noReacquire 不同)。
      const noGuide = m.unguided === true || m.cutGuidance === true;
      if (noGuide) m.target = null;
      // 目标制导开始前的延迟(原作 noHomingTime; 4AGM 0.2 / LAGM 0.6 / EW1 1.0)
      const homingArmed = m.age >= (WP.noHomingTime || 0);
      // Target acquisition
      if (m.target && !m.target.alive) m.target = null;
      // === Flare blind period (per user request) ===
      // While blind, don't re-acquire a target — the missile just flies
      // straight. Also forces nuke warheads to fly straight.
      if ((m.blindT ?? 0) > 0) {
        m.blindT = (m.blindT ?? 0) - dt;
        m.target = null;
        // Straight-line cruise while blind (no guidance).
        // === 助推段: 从载机速度慢慢加速到正常速度 (per user request) =================
        // 加速率 110/s²: 600 → 900 约 2.7s, 肉眼能看出"越来越快"; 核弹单独给慢上限。
        m.speed = Math.min(m.speed + dt * 110, (m as any).isNuke ? 400 : (m.maxSpeed ?? 900));
        m.velocity.normalize().multiplyScalar(m.speed);
        m.prev.copy(m.group.position);
        m.group.position.addScaledVector(m.velocity, dt);
        m.flown += m.speed * dt;
        m.group.lookAt(_tmp.copy(m.group.position).add(m.velocity));
        m.life -= dt;
        m.age += dt;
        if ((m as any).isNuke) {
          // Nuke: airburst after 1.5s of straight flight (or terrain contact).
          if (m.age >= 1.5 || m.group.position.y < 5) {
            m.dead = true;
            m.hit = true;
            m.reportedHit = true;
            (m as any).nukeReady = true; // engine detonates it
          }
        }
        continue;
      }
      // === 4-second self-destruct after losing lock (per user request) ===
      // While the missile has NO target, a timer accumulates (only after it
      // had a target at some point). Re-acquiring resets it; reaching 4s
      // destroys the missile — a decoyed/missed missile doesn't loiter.
      if (m.target) {
        m.noTargetT = 0;
        m.hadTarget = true;
      } else if (m.hadTarget) {
        m.noTargetT = (m.noTargetT ?? 0) + dt;
        if (m.noTargetT >= 4) {
          m.dead = true;
          continue;
        }
      }
      // === No re-acquire (per user request: 干扰弹/错过一次后不再锁定) ===
      // Decoyed-by-flares OR missed-once missiles NEVER lock on again — they
      // fly straight/ballistic until they expire or hit terrain.
      if (m.noReacquire) {
        m.target = null;
        // === 助推段: 从载机速度慢慢加速到正常速度 (per user request) =================
        // 加速率 110/s²: 600 → 900 约 2.7s, 肉眼能看出"越来越快"; 核弹单独给慢上限。
        m.speed = Math.min(m.speed + dt * 110, (m as any).isNuke ? 400 : (m.maxSpeed ?? 900));
        m.velocity.normalize().multiplyScalar(m.speed);
        m.prev.copy(m.group.position);
        m.group.position.addScaledVector(m.velocity, dt);
        m.flown += m.speed * dt;
        m.group.lookAt(_tmp.copy(m.group.position).add(m.velocity));
        m.life -= dt;
        m.age += dt;
        continue;
      }
      // === §339: 擦过目标 ⇒ 切断制导(原作 missMissileHomingCutDist = 50) =========
      // 原作行为: 导弹擦过目标后不会立刻消失, 而是断制导、继续按惯性飞一段。
      // 这里对**所有目标**生效(旧的"擦过玩家"规则只在 id === -1 时触发), 阈值来自参数表。
      // 判定: 最近距离曾 <= cutDist, 且距离开始拉开 ⇒ 切断制导(引信仍有效, 撞上照算)。
      if (m.target) {
        const dT = m.group.position.distanceTo(m.target.position);
        m.minTgtDist = Math.min(m.minTgtDist ?? dT, dT);
        if (m.minTgtDist <= WP.missHomingCutDist
          && m.prevTgtDist !== undefined && dT > m.prevTgtDist + 2) {
          m.cutGuidance = true;
        }
        m.prevTgtDist = dT;
      }
      // === Missed-once detection (per user request) ===
      // A missile that was locking the player, CLOSED IN (came within 250)
      // and then flew past (the gap starts growing) counts as a miss — it
      // may not turn around and re-lock. A dodge while the missile is still
      // far (e.g. during the 2s flare blind) does NOT permanently defeat it.
      if (m.target && m.target.id === -1) {
        const d = m.group.position.distanceTo(playerPos);
        m.minPlayerDist = Math.min(m.minPlayerDist ?? d, d);
        if (m.minPlayerDist < 250 && m.prevPlayerDist !== undefined && d > m.prevPlayerDist + 5) {
          m.noReacquire = true;
        }
        m.prevPlayerDist = d;
      }
      // If the current target is on the same side as the missile (shouldn't
      // happen, but defensive), drop it — we never want a missile to track a
      // friendly target, even if it was somehow assigned one.
      if (m.target && m.target.isAlly === m.isAlly) m.target = null;
      if (!noGuide && !m.target) {
        // Find closest enemy in front — but ONLY consider targets on the
        // OPPOSITE side from the missile. This is the friendly-fire filter:
        // an allied missile (isAlly=true) can never acquire an allied target,
        // and an enemy missile (isAlly=false) can never acquire an enemy target.
        // === §339: 捕获锥改成**导引头视场角**(原作 hormingAng / Hi / Low) ======
        // 原来是写死的 dot>0.4(≈±66°)。现在: 视场角两档(高速档/低速档), 半角 = 角/2。
        // ⇒ 玩家 MSL(120°) ≈ ±60°; 敌方低速弹(30°) 只剩 ±15° —— 这就是"低速档几乎
        //    咬不住"的第二个来源(第一个是 rotAngMaxLow = 3°/s)。
        const fovDeg = effectiveSightFov(WP, m.speed);
        let bestDot = homingArmed ? Math.cos(Math.min(180, Math.max(4, fovDeg)) * Math.PI / 360) : 2;
        let best: EnemyHandle | null = null;
        for (const t of targets) {
          if (!t.alive) continue;
          // Friendly-fire filter — skip targets on the same side as the missile.
          if (t.isAlly === m.isAlly) continue;
          _toTarget.copy(t.position).sub(m.group.position).normalize();
          const dot = _toTarget.dot(_tmp.copy(m.velocity).normalize());
          if (dot > bestDot) {
            best = t;
            bestDot = dot;
          }
        }
        m.target = best;
      }
      // Steering toward target
      if (m.target) {
        const tgt = m.target;
        const dist = m.group.position.distanceTo(tgt.position);
        const tti = dist / Math.max(40, m.speed); // time-to-impact estimate
        if ((m as any).isVasm) {
          // === VASM: proportional navigation (per user request) ===
          // Robust PN: desired velocity = current + (PN lateral accel + LOS
          // pursuit pull)·dt. The PN term N·V·(Ω×LOS) cancels the LOS
          // rotation (collision course); the pursuit pull keeps the nose
          // trending onto the bandit so it ALWAYS points at the enemy and
          // keeps correcting when they maneuver.
          const los = _desired.copy(tgt.position).sub(m.group.position);
          const range = los.length();
          const losDir = los.normalize();
          _seg.copy(tgt.velocity).sub(m.velocity);
          const omega = _cur.crossVectors(losDir, _seg).divideScalar(Math.max(30, range * range));
          const PN_N = 4.2;
          _tmp.crossVectors(omega, losDir).multiplyScalar(PN_N * m.speed);
          // Pursuit bias — guarantees the nose stays pointed at the bandit.
          _tmp.addScaledVector(losDir, m.speed * 0.35);
          _desired.copy(m.velocity).normalize().addScaledVector(_tmp, dt).normalize();
          // Terminal: pure pursuit in close so it doesn't overshoot.
          if (dist < 900) {
            _desired.lerp(losDir, Math.min(1, dt * 2.0)).normalize();
          }
        } else if ((m as unknown as { topAttack?: boolean }).topAttack && tgt) {
          // === 4AGM 攻顶弹道 (per user request: 飞到目标上空再突然垂直往下砸) ===
          // 两段式: ① 巡航段导引到"目标位置 + (0, +TOP_H, 0)"即目标正上方;
          //         ② 水平距离进到 TOP_H*0.6 以内 → 切纯垂直向下, 不再比例导引。
          // 俯冲段用固定方向而不是继续追踪, 所以看起来就是"垂直砸下去"。
          const TOP_H = 500;
          const dHoriz = Math.hypot(
            tgt.position.x - m.group.position.x,
            tgt.position.z - m.group.position.z,
          );
          if (dHoriz > TOP_H * 0.6) {
            _desired.set(tgt.position.x, tgt.position.y + TOP_H, tgt.position.z)
              .sub(m.group.position).normalize();
          } else {
            _desired.set(0, -1, 0);
          }
        } else {
          // === Classic guidance (all other missiles) ===
          // Lead the target slightly: aim at predicted position based on
          // target velocity. This dramatically improves Pk against
          // maneuvering targets.
          _desired.copy(tgt.position).addScaledVector(tgt.velocity, Math.min(1.5, tti) * 0.6).sub(m.group.position).normalize();
        }
        _cur.copy(m.velocity).normalize();
        // === Tiered missile guidance (per user request) ===
        // Previously all missiles steered at the same rate — enemies were as
        // accurate as the player, making incoming missiles nearly impossible
        // to dodge. Now guidance scales by missile `tier`:
        //   - 'low'    (regular enemy fighters):   steer dt*1.6, big wobble,
        //                                          capped at 360 m/s, shorter life
        //   - 'normal' (allied + elite enemies):   steer dt*4.0, small wobble,
        //                                          capped at 480 m/s
        //   - 'high'   (boss aces):                steer dt*5.5, tiny wobble,
        //                                          capped at 540 m/s
        // The wobble is a per-frame random angular jitter added to the
        // steering direction — simulates radar tracking noise so missiles
        // fly a slightly curved path instead of a perfect pursuit curve.
        // Low-tier wobble is large enough that a maneuvering player can
        // exploit it to break lock.
        // === AI steer buff (per user request: ai导弹要强一些) ===
        // low tier 1.6 → 2.4 — enemy missiles now actually track a
        // maneuvering target instead of wobbling off every time.
        const tierSteer = m.tier === 'high' ? 5.5 : m.tier === 'low' ? 2.4 : 4.0;
        // === Wingman missiles are deliberately less accurate (per user request) ===
        // "僚机的导弹准度一般，就不要抢我风头" — wingman missiles should be average
        // accuracy so they don't steal the player's thunder. Player missiles
        // (launcherId === -1) keep their full 'normal'-tier guidance; wingman
        // missiles (launcherId >= 1, allied) get a weaker steer + tracking
        // wobble so they miss more often against maneuvering bandits.
        // Enemy missiles keep their existing tier-based logic.
        const isWingmanMissile = m.isAlly && m.launcherId >= 1;
        // === SP weapon agility override (per user request: SP武器各有特色) ===
        // The engine stashes spAgility on the missile's group.userData when
        // the player fires an SP missile. QAAM gets extreme agility (steer
        // 8.0), LAAM gets low agility (steer 2.0), SARH gets medium (steer
        // 4.0). Standard MSL/LASM stays at 4.0.
        const spAgility = (m.group as any).userData?.spAgility as number | undefined;
        const spType = (m.group as any).userData?.spType as string | undefined;
        let baseSteer: number;
        if (m.isAlly && !isWingmanMissile) {
          // Player missile — apply SP agility if set, else full normal.
          // === Player guidance buff (per user request: 提高导弹导引能力) ===
          // Base steer raised 4.0 → 5.5 so player missiles track jinking
          // bandits more aggressively. SP weapons keep their agility spec.
          // === LAAM guidance nerf (per user request: LAAM对准目标能力一般) ===
          // LAAM is a long-range radar missile — powerful but with mediocre
          // terminal agility (steer 2.2 vs MSL's 5.5) and visible tracking
          // wobble, so it can be dodged by maneuvering targets.
          baseSteer = spAgility !== undefined
            ? (spType === 'LAAM' ? 2.2 : 2.0 + spAgility * 6.0)   // agility 0..1 → steer 2..8
            : Math.max(tierSteer, 5.5);
        } else if (isWingmanMissile) {
          // === Wingman missiles buffed (per user request: 僚机AI太弱) ===
          // 2.4 → 3.2 steer — wingmen now land hits on maneuvering bandits
          // without stealing the player's thunder.
          baseSteer = 3.2;                                  // wingman missiles: decent steer
        } else {
          baseSteer = tierSteer;                            // enemy missiles: tier-based
        }
        const steer = Math.min(1, dt * baseSteer);
        _newDir.copy(_cur).lerp(_desired, steer);
        // Tracking noise — enemy missiles + wingman missiles both wobble.
        // Magnitude scales with tier for enemies; wingman uses a medium wobble
        // (0.12) so the missile visibly curves and sometimes loses track of a
        // jinking bandit. Player missiles stay perfectly stable.
        // low = 0.18 (very wobbly), normal = 0.06 (mild), high = 0.02 (precise).
        if (!m.isAlly) {
          // === AI wobble reduction (per user request: ai导弹要强一些) ===
          // low 0.18 → 0.12 — enemy low-tier missiles fly steadier.
          const wobble = m.tier === 'high' ? 0.02 : m.tier === 'low' ? 0.12 : 0.06;
          _newDir.x += (Math.random() - 0.5) * wobble;
          _newDir.y += (Math.random() - 0.5) * wobble;
          _newDir.z += (Math.random() - 0.5) * wobble;
        } else if (isWingmanMissile) {
          const wobble = 0.08;
          _newDir.x += (Math.random() - 0.5) * wobble;
          _newDir.y += (Math.random() - 0.5) * wobble;
          _newDir.z += (Math.random() - 0.5) * wobble;
        } else if (spType === 'LAAM') {
          // === LAAM tracking noise (per user request: 对准目标能力一般) ===
          // Long-range radar missiles get a mild wobble so a jinking target
          // has a real chance to defeat the lock.
          const wobble = 0.04;
          _newDir.x += (Math.random() - 0.5) * wobble;
          _newDir.y += (Math.random() - 0.5) * wobble;
          _newDir.z += (Math.random() - 0.5) * wobble;
        }
        _newDir.normalize();
        // Accelerate to terminal speed — real AAMs sustain Mach 2.5-4. We
        // cap MSL at 480 / LASM at 540 (1.3-1.5× the fastest fighter's top
        // speed) so the missile actually catches its target instead of
        // trailing behind forever. Acceleration rate 200/s means the
        // missile reaches terminal speed in ~1s after launch.
        // Enemy missiles cap slightly lower (420 / 480) so a fast player
        // can actually outrun them in a sustained chase.
        // Low-tier enemy missiles cap even lower (360) so a maneuvering
        // player can outrun them — they're meant to be easy to dodge.
        // === Missile balance (per user request: 玩家导弹减速 / AI导弹增强) ===
        // Player MSL 600 → 500, LASM 660 → 560 — still well above every
        // fighter's top speed so shots connect, but slow enough that the
        // enemy AI's evasion maneuvers have a real chance to defeat them.
        // Enemy missiles are stronger: low tier 327 → 414 max speed
        // (+ steer 1.6→2.4, wobble 0.18→0.12), normal tier 386 → 451.
        const tierMaxBoost = m.tier === 'high' ? 1.0 : m.tier === 'low' ? 0.9 : 0.98;
        // Wingman missiles keep their own cap (slightly below the player's).
        // === Speed re-scale (per user request: F-16 巡航600/最大1100) ===
        // All caps ×~1.9 to stay ahead of the re-scaled airframes: player
        // MSL 950 (>600 cruise, <1100 AB so the player can still outrun
        // their own shots), enemy low-tier ~790 (outrunnable in a chase).
        let maxSpeed = m.isAlly
          ? (isWingmanMissile
              // === Wingman missiles (per user request: 加强僚机) ===
              ? (m.type === 'LASM' ? 880 : 830)        // wingman: own cap
              : (m.type === 'LASM' ? 1080 : 950))        // player: rebalanced cap
          : (m.type === 'LASM' ? 1000 * tierMaxBoost : 880 * tierMaxBoost);
        if (spType === 'LAAM') maxSpeed = 1250;
        // === Nuke warhead speed (per user request: NKV 远程高速导弹) ===
        // The tactical nuke is a long-range high-speed missile: faster than
        // every airframe, hard to outrun once it's locked on.
        if ((m as any).isNuke) maxSpeed = 1100;
        // === LASM accelerating curve (per user request: 导弹速度从慢到越来越快) ===
        // LASM starts slow and keeps accelerating — the longer it flies the
        // faster it gets (accel grows from 120/s to 500/s over ~2.5s).
        // === Speed re-scale (per user request) ===
        // Acceleration doubled alongside the speed re-scale so missiles
        // still reach terminal speed in ~1s after launch.
        const accel = m.isAlly && !isWingmanMissile
          ? (m.type === 'LASM' ? Math.min(1000, 240 + m.age * 320) : 420)
          : 420;
        // §339 noAcceleTime: 发射后先**滑行**这段时间才点火(原作 SAAM/4AAM/LAGM = 0.4s)
        const ignite = m.age >= (WP.noAcceleTime || 0);
        if ((m as any).isVasm) {
          // === VASM: realistic missile energy model (per user request) ===
          // 1. POWERED phase: motor burns for 3.5s — strong acceleration.
          // 2. After burnout: COAST on inertia — quadratic air drag drains
          //    speed continuously.
          // 3. Maneuvering also consumes energy (commanded turn angle).
          // 4. Below FALL_SPEED gravity wins — the missile noses down and
          //    falls, then detonates on terrain/sea contact.
          const coasting = m.age > 3.5;
          const thrust = coasting ? 0 : accel;
          const dragK = coasting ? 0.00022 : 0.00012;
          const turnAngle = Math.acos(Math.max(-1, Math.min(1, _cur.dot(_desired))));
          m.speed = Math.max(40,
            m.speed + dt * thrust - m.speed * m.speed * dragK * dt - turnAngle * 16 * dt);
          m.speed = Math.min(m.speed, maxSpeed);
          const FALL_SPEED = 150;
          if (m.speed < FALL_SPEED) {
            const fallBlend = 1 - m.speed / FALL_SPEED;
            _newDir.y -= fallBlend * 0.9;
            _newDir.normalize();
          }
        } else {
          // === Classic speed model (all other missiles) ===
          m.speed = Math.min(m.speed + dt * (ignite ? accel : 0), maxSpeed);
        }
        // === §339 AC7AH 式约束: 限速率转向(两档) + 转向耗能 + 重力 ==============
        // 这一段是"甩导弹"能否成立的关键。原来转向是 `_newDir = lerp(旧, 目标, dt*增益)`
        // —— 没有角速率上限, 也和速度无关, 所以导弹永远咬得住, 玩家只能靠干扰弹。
        // 现在:
        //   ① 本帧转角**不得超过** effectiveTurnRate(高速档 Hi / 低速档 Low, 由速度插值);
        //   ② 转向要**耗能**: speed -= 转角(rad) * turnEnergyK  ⇒ 逼它大过载就掉速;
        //   ③ 掉了速 ⇒ 下一帧落进低速档(角速率骤降, 敌方甚至到 3°/s) ⇒ 咬不住 ⇒ 脱靶。
        //      这就是原作"用机动把导弹的能量耗掉"的机制, 不是单纯堆 G。
        //   ④ 重力: 原作 gravity 9.8 + gravitydecay —— 衰减做成指数(τ = 1.5·decay 秒),
        //      于是下坠速度有渐近上限(≈ 9.8·τ), 不会把长寿命导弹拉成投石机。
        _pre.copy(m.velocity).normalize();
        const curRateMax = effectiveTurnRate(WP, m.speed) * Math.PI / 180;   // rad/s
        const turnAng = Math.acos(Math.max(-1, Math.min(1, _pre.dot(_newDir))));
        const maxTurn = curRateMax * dt;
        if (turnAng > maxTurn && turnAng > 1e-6) {
          const k = maxTurn / turnAng;
          _newDir.lerpVectors(_pre, _newDir, k).normalize();
        }
        if (WP.turnEnergyK > 0 && turnAng > 0) {
          m.speed = Math.max(30, m.speed - turnAng * WP.turnEnergyK);
        }
        // 方向 = 限速率后的朝向 × 速度
        m.velocity.copy(_newDir).multiplyScalar(m.speed);
        // [!] 重力必须在 copy 之后作用 —— 顺序反了会**被下一行覆盖**(第一版就是这么写的,
        //     实测等效于没有重力)。重力直接加到速度向量上, 下一帧由制导去抵消它。
        if (WP.gravity > 0) {
          const tau = Math.max(0.2, 1.5 * (WP.gravitydecay || 1));
          m.velocity.y -= WP.gravity * Math.exp(-m.age / tau) * dt;
        }
      } else {
        if ((m as any).isVasm) {
          // No target — VASM coasts with drag; without energy it falls.
          const dragK = 0.00028;
          m.speed = Math.max(40, m.speed + dt * 280 - m.speed * m.speed * dragK * dt);
          m.speed = Math.min(m.speed, 540);
          if (m.speed < 150) {
            m.velocity.y -= 90 * dt;
          }
        } else {
          // Classic no-target cruise.
          // §339: 无制导弹保持自己的速度上限(火箭弹不该掉到 540), 且有 gravity 时下坠。
          m.speed = m.unguided
            ? Math.min(m.speed + dt * WP.accele, Math.max(WP.speedMax || 540, m.speed))
            : Math.min(m.speed + dt * 280, 540);
          if (WP.gravity > 0) {
            const tau = Math.max(0.2, 1.5 * (WP.gravitydecay || 1));
            m.velocity.y -= WP.gravity * Math.exp(-m.age / tau) * dt;
          }
        }
        m.velocity.normalize().multiplyScalar(m.speed);
      }
      // Save previous position for swept-segment hit check
      m.prev.copy(m.group.position);
      m.group.position.addScaledVector(m.velocity, dt);
      m.flown += m.speed * dt;
      // Orient
      m.group.lookAt(_tmp.copy(m.group.position).add(m.velocity));
      m.life -= dt;
      m.age += dt;

      // === Pooled smoke particle emission (per user request: 三层粒子烟雾 + 对象池) ===
      // The missile emits a "packet" of 4 particles (1 flame + 2 thick smoke
      // + 1 thin mist) every emission cycle. During the boost phase (first
      // 1.2s after launch, when the missile is still accelerating hard and
      // the rocket motor is burning brightest), the emission rate is 3×
      // higher AND each emission spawns 2 extra packets — giving the
      // launch moment a thick, dense smoke burst that disperses as the
      // missile cruises.
      //
      // We compute the tail position (slightly behind the missile) and pass
      // it to emitMissileSmoke(), which delegates to spawnSmokeParticle()
      // for each of the 4 stages.
      const isBoost = m.life > (m.type === 'LASM' ? 14.8 : 10.8); // last 1.2s of life = boost phase (life starts at 12 or 16)
      m.smokeEmitT -= dt;
      const emitInterval = isBoost ? 0.008 : 0.018;
      while (m.smokeEmitT <= 0) {
        m.smokeEmitT += emitInterval;
        // Compute tail position — slightly behind the missile, with a small
        // random scatter so successive puffs don't stack in a perfect line.
        const back = _tmp.copy(m.velocity).normalize().multiplyScalar(-3.0);
        const emitPos = m.group.position.clone().add(back);
        emitPos.x += (Math.random() - 0.5) * 1.5;
        emitPos.y += (Math.random() - 0.5) * 1.5;
        emitPos.z += (Math.random() - 0.5) * 1.5;
        // === 沿本帧位移做多子步采样 (per user request: 照搬 teardown 的陨石拖尾) ====
        // 他们的关键是: 每帧不只在一个点上喷, 而是**沿这一帧飞过的那段路径**按 n 个子步
        // 各喷一次(n ≈ 速度×dt×0.5, 上限 6) —— 于是高速时火焰连成一条线, 而不是一串断点。
        // 我们的池只有 600 个 Sprite(每个都是独立 draw call), 所以上限压到 3 子步,
        // 并且按当前池占用率降级(忙的时候只喷 1 步), 避免把 600 个槽位瞬间打满。
        let activeN = 0;
        for (const q of this.smokeParticles) if (q.active) activeN++;
        const pressure = activeN / Math.max(1, this.smokeParticles.length);
        const spd = m.velocity.length();
        const sub = pressure > 0.7 ? 1 : Math.max(1, Math.min(3, Math.round(spd * dt * 0.5)));
        for (let k = 0; k < sub; k++) {
          // 从当前位置沿速度方向**回退**到本帧起点之间的插值位置(与 teardown 同构)
          const backPos = emitPos.clone().addScaledVector(m.velocity, -dt * (k / sub));
          this.emitMissileSmoke(backPos, m.isAlly, m.velocity);
        }
        // 加力段再加一倍密度(只多一次, 不再 ×3, 免得爆池)
        if (isBoost && pressure < 0.5) {
          const extraPos = emitPos.clone();
          extraPos.x += (Math.random() - 0.5) * 2.0;
          extraPos.y += (Math.random() - 0.5) * 2.0;
          extraPos.z += (Math.random() - 0.5) * 2.0;
          this.emitMissileSmoke(extraPos, m.isAlly, m.velocity);
        }
      }

      // === Launch safety window (per user request: 刚发射敌机就立刻被击落是bug) ===
      // A missile spawned inside a target's proximity-fuse radius (knife-
      // fight ranges) detonated on its FIRST frame — the "fires and the
      // bandit instantly dies" bug. Skip TARGET-hit detection for the
      // first 0.5s so the missile visibly separates from the launcher
      // before its fuse arms. Terrain/life expiry still work normally.
      //
      // === 修正 (per user request: 偶尔"导弹刚发射就击落远处敌人") ===
      // 原来的保险**只加在旁路分支上**(`if (onHitCb)` 那条, 敌弹打玩家用),
      // 直接命中分支(`if (_closest... <= proximityRadiusSq)`)漏了这道闸门 —— 于是
      // 玩家/僚机的导弹在发射后 0.5 秒内依旧能起爆。而玩家 MSL 950 m/s、LAAM
      // 1250 m/s, 0.5 秒已经飞出 475~625 m, 起步阶段沿线上任何合法目标都会被
      // 当场炸掉(近距离缠斗、迎头接近时尤其明显, 看起来就像"刚发射就击落了远处
      // 的敌人")。现在**两个分支共用**这道保险, 且同时要求"飞够距离" —— 真实导弹
      // 也有最小解锁距离, 慢速弹(如 VASM 起步 40 m/s)不会还没离架就解锁。
      const ARM_TIME = 0.5;      // s
      const ARM_DIST = 120;      // m
      const armed = m.age >= ARM_TIME && m.flown >= ARM_DIST;

      // === 帧步合理性闸门 (结构性护栏) ===
      // 一帧的合法位移就是 m.speed * dt(见上面的位置积分)。扫掠线段明显超过它就说明
      // m.prev 不是"本弹本帧"的位置(陈旧值/换帧错位/将来新增的飞行分支漏了赋值),
      // 此时**整帧不判定命中** —— 否则那条虚假的千米级线段会"扫过"整张地图, 把远处
      // 正好落在线上的敌人瞬间击落, 也就是用户实测的现象。留 5m 余量吸收浮点/转向抖
      // 动, 正常帧永远不会触发。
      const stepLenSq = m.group.position.distanceToSquared(m.prev);
      const legitStep = m.speed * dt + 5;
      const stepOk = stepLenSq <= legitStep * legitStep;

      // Hit check — swept segment so fast missiles don't teleport through the target.
      // Proximity fuse: if missile path passes within `fuseRadius` of a target, detonate.
      // Direct hit radius (the smaller of the two) guarantees a kill on contact.
      // === §339 胶囊命中(替掉写死的 6/12 m 点球) ==============================
      // 原作把命中做成"胶囊": 沿弹轴 lengthStart→lengthEnd + 半径 thickness, 目标侧另有
      // boundingShpereSize。翻译到我们这里:
      //   direct = targetBound + thickness                      (直击半径)
      //   prox   = explosionRadius>0 ? direct+explosionRadius : direct*2   (近炸半径)
      // 玩家 MSL: 5+1 = **6**, 近炸 12 ⇒ 与旧的 6/12 **完全相同(零回归)**;
      // 敌方 NPC_MSL: 8+5 = **13**, 近炸 26 ⇒ 判定明显更宽松("更粘人"), 与它
      //   rotAngMaxLow 3°/s 配在一起 = 更吓人但甩得掉(用户选的不对称设计);
      // VASM/LAGM 类带 explosionRadius 60 ⇒ 近炸 66, 与旧的 60 同量级。
      const directRadius = WP.targetBound + WP.thickness;
      const proximityRadius = WP.explosionRadius > 0
        ? directRadius + WP.explosionRadius
        : directRadius * 2;
      const directRadiusSq = directRadius * directRadius;
      const proximityRadiusSq = proximityRadius * proximityRadius;
      let hit = false;
      let hitDmg = 0;
      let hitUnitType: string | undefined = undefined;
      for (const t of targets) {
        if (!t.alive) continue;
        // Friendly-fire filter — a missile can never collide-detonate on a
        // target on the same side. This is the authoritative guard: even
        // if the missile flies straight through a friendly aircraft, it will
        // not detonate. Belt-and-suspenders with the target-acquisition filter.
        if (t.isAlly === m.isAlly) continue;
        // === Launcher exclusion (per user request) ===
        // A missile can never detonate on the aircraft that fired it. This
        // covers the 'AI僚机自己发射的导弹对自己无效' requirement: a wingman's
        // missile will pass harmlessly through the wingman that launched it
        // even if the wingman reverses course and flies back through the
        // missile's path.
        if (m.launcherId !== -1 && t.id === m.launcherId) continue;
        // Closest point on segment [prev -> cur] to target
        // §339: 弹体前端按原作 lengthStart 前伸(等价于 missileHitSphereOffset 8):
        //   玩家弹 1 米、敌方 NPC 弹 10 米 ⇒ 敌方导弹"擦身而过"也算命中(不对称设计的一环)。
        _segEnd.copy(m.group.position);
        const noseExt = Math.max(0, WP.lengthStart);
        if (noseExt > 0 && m.velocity.lengthSq() > 1e-6) {
          _segEnd.addScaledVector(_tmp.copy(m.velocity).normalize(), noseExt);
        }
        _seg.copy(_segEnd).sub(m.prev);
        const segLenSq = _seg.lengthSq();
        let u = 0;
        if (segLenSq > 1e-6) {
          u = _toTarget.copy(t.position).sub(m.prev).dot(_seg) / segLenSq;
          u = Math.max(0, Math.min(1, u));
        }
        _closest.copy(m.prev).addScaledVector(_seg, u);
        const dSq = _closest.distanceToSquared(t.position);
        // === SP weapon damage override (per user request: SP武器各有特色) ===
        // The engine stashes spDamage on the missile's group.userData when
        // the player fires an SP missile (LAAM/QAAM/SARH). If present, we
        // use that as the base damage instead of the default 120.
        const spDamage = (m.group as any).userData?.spDamage as number | undefined;
        // === LASM damage buff (per user request: LASM是空对地反舰长程雷达弹，伤害高) ===
        // === Wingman missile damage (per user request: 加强僚机) ===
        // 100 → 115 — above a standard fighter's 60 HP in one hit, still
        // below enemy missiles (120) so wingmen soften targets rather than
        // one-shotting everything themselves.
        const baseDmg = m.damagerKind === 'wingman'
          ? 115
          : (spDamage ?? WP.power);
        // §339: 直击倍率(原作 directShootPowerRate 3.0)。我们的 power 本来就是"直击伤害",
        // 所以表里默认 1.0 ⇒ 与旧行为逐值相同(零回归); 想复刻原作"直击×3、近炸衰减更多"
        // 就把旋钮开大(控制台 `wpn MSL.directShootPowerRate 3`)。
        const directDmg = baseDmg * Math.max(0.1, WP.directShootPowerRate);
        if (armed && stepOk && dSq <= directRadiusSq) {
          hit = true;
          hitDmg = directDmg; // direct hit — kills fighters (60 HP) and bombers (100 HP)
          hitUnitType = t.unitType ?? (t.isBomber ? 'aircraft_bomber' : 'aircraft_fighter');
          break;
        }
        if (armed && stepOk && dSq <= proximityRadiusSq) {
          hit = true;
          // Damage falls off with distance — at radius edge, ~50% of base still kills fighters.
          hitDmg = THREE.MathUtils.lerp(directDmg, baseDmg * 0.4, Math.sqrt(dSq) / proximityRadius);
          hitUnitType = t.unitType ?? (t.isBomber ? 'aircraft_bomber' : 'aircraft_fighter');
          break;
        }
      }
      if (hit && hitDmg > 0) {
        // Stash the unit type so the detonation VFX can use it.
        m.lastHitUnitType = hitUnitType;
        // === Mark this missile as having actually hit something so the
        // engine's miss-tracking radio callout doesn't fire. ===
        m.reportedHit = true;
        // === Missile blast radius (per user request: MSL也有爆炸范围) ===
        // Damage every OTHER opposite-side target within 25m with falloff
        // (30% at the edge). The direct-hit target already took full damage.
        const BLAST = 25;
        const blastSq = BLAST * BLAST;
        const applySplash = (skipId: number, cb?: (t: EnemyHandle, dmg: number) => void) => {
          for (const t of targets) {
            if (!t.alive) continue;
            if (t.id === skipId) continue;
            if (t.isAlly === m.isAlly) continue;
            if (m.launcherId !== -1 && t.id === m.launcherId) continue;
            const bd = m.group.position.distanceToSquared(t.position);
            if (bd <= blastSq) {
              const splash = THREE.MathUtils.lerp(hitDmg, hitDmg * 0.3, Math.sqrt(bd) / BLAST);
              if (cb) cb(t, splash);
              else {
                const splashDmg = aceDamage(t, splash, 'splash');
                if (splashDmg > 0) {
                  t.lastWeaponKind = 'missile';
                  t.hp -= splashDmg;
                  if (m.damagerKind) t.lastDamagerKind = m.damagerKind;
                  if (m.launcherName) t.lastDamagerName = m.launcherName;   // §346
            if (m.launcherName) t.lastDamagerName = m.launcherName;   // §346
            if (m.launcherName) t.lastDamagerName = m.launcherName;   // §344 击杀播报
                }
              }
            }
          }
        };
        if (onHitCb) {
          // Pass the (already-computed) dmg so the caller can apply it to whoever was hit.
          // We need to identify which target; for the player-damage path the only target
          // is the player so this is fine.
          for (const t of targets) {
            if (!t.alive) continue;
            // Friendly-fire filter — never apply damage to a same-side target.
            if (t.isAlly === m.isAlly) continue;
            // Launcher exclusion — never apply damage to the firing aircraft.
            if (m.launcherId !== -1 && t.id === m.launcherId) continue;
            // Re-check proximity to identify which target we hit.
            _seg.copy(m.group.position).sub(m.prev);
            const segLenSq = _seg.lengthSq();
            let u = 0;
            if (segLenSq > 1e-6) {
              u = _toTarget.copy(t.position).sub(m.prev).dot(_seg) / segLenSq;
              u = Math.max(0, Math.min(1, u));
            }
            _closest.copy(m.prev).addScaledVector(_seg, u);
            if (armed && _closest.distanceToSquared(t.position) <= proximityRadiusSq) {
              onHitCb(t, hitDmg);
              applySplash(t.id, (t2, dmg) => onHitCb(t2, dmg));
              break;
            }
          }
        } else {
          let directId = -1;
          for (const t of targets) {
            if (!t.alive) continue;
            // Friendly-fire filter — never apply damage to a same-side target.
            if (t.isAlly === m.isAlly) continue;
            // Launcher exclusion — never apply damage to the firing aircraft.
            if (m.launcherId !== -1 && t.id === m.launcherId) continue;
            _seg.copy(m.group.position).sub(m.prev);
            const segLenSq = _seg.lengthSq();
            let u = 0;
            if (segLenSq > 1e-6) {
              u = _toTarget.copy(t.position).sub(m.prev).dot(_seg) / segLenSq;
              u = Math.max(0, Math.min(1, u));
            }
            _closest.copy(m.prev).addScaledVector(_seg, u);
            if (armed && stepOk && _closest.distanceToSquared(t.position) <= proximityRadiusSq) {
              directId = t.id;
              // === Nuke missile (per user request: NKV 可锁定远程高速导弹) ===
              // A nuke warhead hands off to the engine's 3km detonation at
              // the impact point — no single-target damage here.
              if ((m as any).isNuke) {
                if (onNukeMissileCb) onNukeMissileCb(m.group.position.clone());
                break;
              }
              // === Ace dodge/invulnerability (per user request: T-00) ===
              // The missile detonates (VFX plays) but the ace may dodge it
              // or be story-locked. A dodged hit doesn't broadcast HIT.
              const dmg = aceDamage(t, hitDmg, 'missile');
              if (dmg > 0) {
                t.lastWeaponKind = 'missile';
                t.hp -= dmg;
                // === Tag the damager (per user request: 单位的摧毁播报只播报自己和僚机打的) ===
                // Stamp the target with who fired this missile so killEnemy()
                // can decide whether to play a kill notification. This is the
                // allied-missile path (player + wingman + allied ground units).
                if (m.damagerKind) {
                  t.lastDamagerKind = m.damagerKind;
                  if (m.launcherName) t.lastDamagerName = m.launcherName;   // §346
                }
                // === Player HIT broadcast (per user request) ===
                // Only the player's own missiles announce "HIT" — wingman/AI
                // hits stay silent.
                if (m.damagerKind === 'player' && onPlayerHitCb) {
                  onPlayerHitCb();
                }
              }
              // === VASM wide-area blast (per user request: 广域爆炸+高伤害) ===
              // VASM's proximity warhead blasts EVERYTHING within 60m of the
              // detonation — high damage falling off with distance. One big
              // explosion instead of a pinpoint kill.
              if ((m as any).isVasm) {
                const BLAST = 60;
                const blastSq = BLAST * BLAST;
                for (const t2 of targets) {
                  if (!t2.alive || t2.id === directId) continue;
                  if (t2.isAlly === m.isAlly) continue;
                  if (m.launcherId !== -1 && t2.id === m.launcherId) continue;
                  const bd2 = t2.position.distanceToSquared(m.group.position);
                  if (bd2 <= blastSq) {
                    const blast = THREE.MathUtils.lerp(hitDmg, hitDmg * 0.25, Math.sqrt(bd2) / BLAST);
                    const bDmg = aceDamage(t2, blast, 'splash');
                    if (bDmg > 0) {
                      t2.lastWeaponKind = 'missile';
                      t2.hp -= bDmg;
                      if (m.damagerKind) t2.lastDamagerKind = m.damagerKind;
                      if (m.launcherName) t2.lastDamagerName = m.launcherName;   // §346
                    }
                  }
                }
              }
              break;
            }
          }
          // === Player/wingman missiles: NO area splash (per user request) ===
          // A player or wingman missile damages ONLY the single unit it
          // physically hits — one missile, one target. Applies to MSL, LASM
          // and all SP warheads. ONLY enemy missiles keep their 25m blast
          // splash (so a bandit's missile can still clip a wingman).
          if (!m.isAlly) {
            applySplash(directId);
          }
        }
        this.spawnMissileDetonation(m.group.position.clone(), m.lastHitUnitType);
      }
      // Miss if too low or expired
      if (m.group.position.y < -50) hit = true;
      if (m.life <= 0) hit = true;
      // === Terrain occlusion for missiles (per user request) ===
      // If terrain is provided and the missile is below the terrain at its
      // XZ, detonate it on impact (with a terrain-tinted explosion).
      // === Water vs land differentiation (per user request) ===
      // Terrain height < 5 = water → 'terrain_water' (splash + ripple +
      // smaller fireball). Terrain >= 5 = land → 'terrain' (dust burst).
      if (!hit && terrainHeight) {
        const ty = terrainHeight(m.group.position.x, m.group.position.z);
        if (m.group.position.y < ty + 1.5) {
          hit = true;
          m.lastHitUnitType = ty < 5 ? 'terrain_water' : 'terrain';
          // === Nuke missile ground impact (per user request) ===
          // A nuke that hits the ground detonates its 3km blast right there.
          if ((m as any).isNuke && onNukeMissileCb) {
            onNukeMissileCb(m.group.position.clone());
          }
          this.spawnMissileDetonation(m.group.position.clone(), m.lastHitUnitType);
        }
      }
      if (hit) {
        m.dead = true;
      }
    }
  }

  // === Bomb update + collision (per user request) ===
  // Updates each bomb's physics (gravity + velocity), then checks for
  // collision with terrain (below terrain Y at XZ) or any enemy/ally
  // unit (close enough). On hit: spawn big explosion + apply damage.
  private updateBombs(
    dt: number,
    targets: EnemyHandle[],
    terrainHeight?: (x: number, z: number) => number,
    onHit?: (pos: THREE.Vector3) => void,
    onNuke?: (pos: THREE.Vector3) => void,
  ) {
    if (this.bombs.length === 0) return;
    const G = 60; // gravity (matches predictBombImpact)
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const b = this.bombs[i];
      if (b.dead) {
        this.scene.remove(b.mesh);
        this.bombs.splice(i, 1);
        continue;
      }
      // Apply gravity
      b.velocity.y -= G * dt;
      // Move
      b.mesh.position.addScaledVector(b.velocity, dt);
      // Orient the bomb to face its velocity (nose-down as it falls)
      if (b.velocity.lengthSq() > 0.01) {
        b.mesh.lookAt(b.mesh.position.clone().add(b.velocity));
      }
      b.life -= dt;
      // === Terrain impact ===
      let detonated = false;
      let detonatePos: THREE.Vector3 | null = null;
      if (terrainHeight) {
        const ty = terrainHeight(b.mesh.position.x, b.mesh.position.z);
        if (b.mesh.position.y < ty + 1.0) {
          detonated = true;
          detonatePos = b.mesh.position.clone();
          detonatePos.y = ty;
        }
      } else {
        // No terrain — fall back to y=0 (sea level)
        if (b.mesh.position.y < 0) {
          detonated = true;
          detonatePos = b.mesh.position.clone();
          detonatePos.y = 0;
        }
      }
      // === Unit impact ===
      // Bombs have a 12m impact radius — close enough counts as a direct hit
      // for the heavy ordnance. Big damage to whatever they touch.
      if (!detonated) {
        for (const t of targets) {
          if (!t.alive) continue;
          if (b.mesh.position.distanceTo(t.position) < 12) {
            detonated = true;
            detonatePos = b.mesh.position.clone();
            // Apply direct hit damage — big enough to one-shot a destroyer
            // and severely damage a cruiser.
            // === Ace lock gate (per user request: T-00 锁血) ===
            const bombDmg = aceDamage(t, 220, 'bomb');
            if (bombDmg > 0) t.hp -= bombDmg;
            break;
          }
        }
      }
      // === Lifetime expiry ===
      if (!detonated && b.life <= 0) {
        detonated = true;
        detonatePos = b.mesh.position.clone();
      }
      if (detonated && detonatePos) {
        // === Tactical nuke (per user request: NKV 投掷炸弹型) ===
        // A nuke-tagged bomb hands off to the engine's 3km detonation —
        // no splash damage here, the engine handles kills + FX.
        if ((b as any).isNuke) {
          if (onNuke) onNuke(detonatePos);
          else this.spawnExplosion(detonatePos.clone(), 4.0);
        } else {
        // === Cluster bomb sub-munitions (per user request: SP武器 - CLB) ===
        // If this bomb was tagged as a cluster bomb, spawn 8-12 sub-explosions
        // spread over a wide radius (60m) and apply damage across the whole
        // area. Much wider than a regular BDL bomb.
        const isCluster = (b as any).isCluster === true;
        if (isCluster) {
          // === CLB: 伤害判定半径再翻倍 (per user request: 450 → 900m) ===
          // 注意 subRadius 同时管两件事: 子母弹的散布半径 + 伤害判定半径。
          // 用户要的是**伤害判定**翻倍, 散布跟着一起翻倍会让 10 个弹坑铺得太大,
          // 所以拆成两个量: 伤害半径 900, 散布半径保持 450(视觉上是"一片弹坑")。
          const subCount = 10;
          const subRadius = 900;        // 伤害判定半径(翻倍)
          const subSpread = 450;        // 子母弹散布半径(不变)
          for (let s = 0; s < subCount; s++) {
            const angle = (s / subCount) * Math.PI * 2 + Math.random() * 0.4;
            const dist = Math.random() * subSpread;
            const subPos = detonatePos.clone().add(new THREE.Vector3(
              Math.cos(angle) * dist,
              Math.random() * 4,
              Math.sin(angle) * dist,
            ));
            // 小型投掷炸弹(子母弹)的**爆炸特效半径 1/3** (per user request: 1.8 → 0.6)。
            // 只改视觉尺寸, 伤害仍然由下面的 subRadius 统一判定。
            this.spawnExplosion(subPos, 0.6);
          }
          // Wide-area damage across all targets in 75m radius.
          for (const t of targets) {
            if (!t.alive) continue;
            const d = detonatePos.distanceTo(t.position);
            if (d < subRadius) {
              // Heavy damage — falls off with distance.
              const splash = THREE.MathUtils.lerp(300, 50, d / subRadius);
              const splashDmg = aceDamage(t, splash, 'bomb');
              if (splashDmg > 0) t.hp -= splashDmg;
            }
          }
          // Big central explosion on top of the sub-munitions.
          this.spawnExplosion(detonatePos.clone(), 3.5);
        } else {
          // Regular bomb — big explosion + splash damage.
          this.spawnExplosion(detonatePos.clone(), 4.0);
          // === Water vs land differentiation for bomb impacts (per user request) ===
          // Bomb hitting water gets a big double splash on top of the explosion.
          if (terrainHeight) {
            const ty = terrainHeight(detonatePos.x, detonatePos.z);
            if (ty < 5) {
              // Water impact — extra big splash
              this.spawnWaterSplash(detonatePos);
              this.spawnWaterSplash(detonatePos);
              this.spawnWaterSplash(detonatePos);
            }
          }
          // === BDL: 伤害判定半径再翻倍 (per user request: 180 → 360m) ===
          // 峰值伤害保持 240(只是"打得到"的范围翻倍, 不是单发更疼)。
          for (const t of targets) {
            if (!t.alive) continue;
            const d = detonatePos.distanceTo(t.position);
            if (d < 360) {
              const splash = THREE.MathUtils.lerp(240, 0, d / 360);
              const splashDmg = aceDamage(t, splash, 'bomb');
              if (splashDmg > 0) t.hp -= splashDmg;
            }
          }
        }
        } // end of nuke-else — regular/cluster bomb path
        if (onHit) onHit(detonatePos);
        b.dead = true;
      }
    }
  }

  clear() {
    for (const b of this.bullets) this.scene.remove(b.mesh);
    for (const m of this.missiles) {
      this.scene.remove(m.group);
      // Smoke particles are pooled — nothing to clean up per-missile.
      m.smokePuffs.length = 0;
    }
    for (const m of this.enemyMissiles) {
      this.scene.remove(m.group);
      m.smokePuffs.length = 0;
    }
    // === Deactivate all pooled smoke particles ===
    // The sprites themselves stay in the smokeGroup (they're reused on next
    // mission) — we just mark every particle inactive + hide its sprite so
    // no leftover smoke from the previous mission bleeds into the next.
    for (let i = 0; i < this.smokeParticles.length; i++) {
      this.smokeParticles[i].active = false;
      this.smokeSprites[i].visible = false;
    }
    // === Deactivate wake + dust pools (per user request) ===
    for (let i = 0; i < this._wakeParticles.length; i++) {
      this._wakeParticles[i].active = false;
      this._wakeSprites[i].visible = false;
    }
    for (let i = 0; i < this._dustParticles.length; i++) {
      this._dustParticles[i].active = false;
      this._dustSprites[i].visible = false;
    }
    for (const e of this.explosions) {
      this.scene.remove(e.mesh);
      this._dropLight(e); // 池化 → 归还; 非池化 → 移除。per fix ①
    }
    // === Bombs (per user request) ===
    for (const b of this.bombs) this.scene.remove(b.mesh);
    // === Water ripples (per user request) ===
    for (const r of this.waterRipples) {
      this.scene.remove(r.mesh);
      (r.mesh.material as THREE.MeshBasicMaterial).dispose();
    }
    this.waterRipples = [];
    this.bullets = [];
    this.missiles = [];
    this.enemyMissiles = [];
    this.explosions = [];
    this.bombs = [];
  }

  // === EW support: decoy all incoming (enemy) missiles currently in flight. ===
  // Called by the EA-18G jammer pulse. Returns the number of missiles decoyed.
  decoyIncomingMissiles(): number {
    let n = 0;
    for (const m of this.enemyMissiles) {
      if (m.dead) continue;
      // Break target lock — missile will fly ballistic until it expires.
      // === No re-acquire (per user request) ===
      // A jammed missile never locks on again.
      m.target = null;
      m.noReacquire = true;
      // Add a random yaw offset so the missile veers off course.
      const jitter = new THREE.Vector3(
        (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 0.3,
        (Math.random() - 0.5) * 0.6,
      );
      m.velocity.add(jitter.multiplyScalar(60));
      m.dead = false; // keep alive but off-track
      // Spawn a small sparkle to indicate jamming.
      this.spawnExplosion(m.group.position.clone().add(jitter), 0.6);
      n++;
    }
    return n;
  }
}
