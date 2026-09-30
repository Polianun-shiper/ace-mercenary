// Shared game types

export type GamePhase =
  | 'menu'
  | 'mission-select'
  | 'hangar'
  | 'briefing'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'results'
  | 'settings';

export type CameraMode = 'chase' | 'far' | 'cockpit' | 'missile' | 'cinematic' | 'side';
// === AC-130 gunship side-firing view (per user request: CapsLock 启动侧炮视角) ===
// 'side' is a special camera mode for gunship aircraft only. It positions
// the camera at the port-side gunport looking outward, so the player can
// aim the 105mm howitzer visually. Unlike other modes, the camera has a
// limited drag range (mouse look within a cone) and does NOT auto-snap
// back to the aircraft if it leaves the field of view.

// Weapon types. EW / SIDE are special weapon modes for electronic-warfare
// aircraft and gunships respectively — chosen via the cycle-weapon key.
// BDL = "Bomb, Dumb, Low-drag" — free-falling unguided bombs the player
// can drop onto ground targets. They follow a ballistic arc and produce a
// large explosion when they impact terrain or any unit.
export type WeaponType =
  | 'GUN'    // forward gun (infinite for fighters)
  | 'MSL'    // standard infrared-homing short-range AAM (Sidewinder-class)
  | 'LASM'   // anti-ship / anti-ground Maverick-class guided missile
  | 'BDL'    // free-fall dumb bomb
  | 'FLR'    // flares (countermeasure)
  | 'EW'     // electronic-warfare jammer pulse (EW aircraft)
  | 'SIDE'   // gunship side-firing howitzer (AC-130)
  // === SP weapons (per user request: 参考皇牌空战推出多款sp武器) ===
  // Each SP weapon has distinct pros/cons — different range, guidance,
  // damage, agility, and capacity. The player picks one SP weapon in the
  // briefing screen to mount on their aircraft for the mission.
  | 'LAAM'   // Long-range Air-to-Air Missile (AIM-54 Phoenix-class) — long range, slow turn, high damage
  | 'QAAM'   // Quick-maneuvering AAM (high agility, short range, medium damage) — curves hard to follow jinking bandits
  | 'SARH'   // Semi-Active Radar Homing (AIM-7 Sparrow-class) — medium range, requires lock maintenance, normal agility
  | 'VASM'   // realistic radar AAM (per user request) — 7km lock, proportional-navigation guidance, powered/coast energy model
  | 'HVG'    // Hypervelocity Gun pod — high-rate, high-damage cannon burst, short range, limited ammo
  | 'CLB'    // Cluster Bomb — drops a spread of sub-munitions over a wide ground area
  | 'NKV'    // tactical nuke (per user request: 仅玩家·12发·3km爆炸)
  // === 新武器 (per user request) ===
  | '4AAM'   // 四联空对空: 一次最多同时锁定 4 个空中目标
  | '4AGM'   // 四联空对地: 一次最多同时锁定 4 个地面/海面目标
  | 'LASER'; // 激光发射器(地面激光防空炮同款的挂载版): 光速直射、持续照射

// Aircraft role expanded for more unit variety.
//   - fighter / interceptor: air-to-air
//   - bomber:                  heavy ordnance, slow
//   - attack:                  close air support (A-10 etc.)
//   - ew:                      electronic-warfare (jamming, anti-radiation)
//   - gunship:                 side-firing AC-130, orbiting ground attack
//   - stealth:                 low-observable strike (F-117)
//   - awacs:                   radar/command platform
//   - player / wingman:        assigned at runtime
export type AircraftRole =
  | 'fighter'
  | 'bomber'
  | 'player'
  | 'wingman'
  | 'interceptor'
  | 'attack'
  | 'ew'
  | 'gunship'
  | 'stealth'
  | 'awacs';

// Aircraft model id — supports more variants.
export type AircraftModel =
  | 'f16'    // F-16C Viper (敌方/僚机用的同型机体几何;玩家也映射到 F-16C 真实模型)
  | 'f16c'   // F-16C Block 50 — 玩家默认机 (真实 OBJ + 30 张贴图, per user request)
  | 'f16-test' // F-16X 可动舵面实验机 (player-only test aircraft)
  | 'b52'    // B-52H Stratofortress
  | 'su35'   // Su-35 Flanker
  | 'a10'    // A-10 Warthog
  | 'f15'    // F-15 Eagle
  | 'tu95'   // Tu-95 Bear
  | 'ea18g'  // EA-18G Growler (electronic warfare)
  | 'ac130'  // AC-130 Spectre (gunship)
  | 'f117'   // F-117 Nighthawk (stealth attack)
  | 'e3'     // E-3 Sentry AWACS
  | 'mig29';  // MiG-29 Fulcrum (player-only, 真实贴图模型)

// Player-selectable aircraft category — used by Hangar/Briefing UI grouping.
export type AircraftCategory = 'fighter' | 'bomber' | 'attack' | 'ew' | 'gunship' | 'stealth' | 'awacs';

// Wingman command set — used by allied AI to follow player tactical orders.
export type WingmanCommand =
  | 'form'      // form up on player
  | 'attack'    // engage nearest enemy
  | 'cover'     // cover player's six
  | 'disperse'  // break formation, free engagement
  | 'rtb';      // return to base (regroup)

// Weather presets for atmospheric variety.
export type WeatherPreset = 'clear' | 'cloudy' | 'rain' | 'storm' | 'fog' | 'snow';

// Map / location presets for variety.
// 'custom' = Gaea/预制地形导入槽(per user request: 新增自定义槽;任务入口待接)
export type MapPreset = 'ocean' | 'city' | 'mountain' | 'desert' | 'archipelago' | 'custom';

export interface AircraftSpec {
  id: string;
  name: string;
  // Chinese display name (per user request: 全部中文) — fall back to `name`.
  nameZh?: string;
  code: string;
  model: AircraftModel;
  role: AircraftRole;
  category: AircraftCategory;
  maxSpeed: number; // units/sec
  // === Real-world top speed (per user request) ===
  // The airframe's ACTUAL maximum speed in knots. The drag-vs-energy
  // equilibrium in the flight model targets this value (full throttle
  // balances drag at the real top speed). Falls back to maxSpeed × 1.85
  // when unset (e.g. custom/legacy specs).
  realMaxSpeed?: number;
  minSpeed: number;
  acceleration: number;
  turnRate: number; // rad/sec at full deflection
  rollRate: number;
  hp: number;
  color: number;
  scale: number;
  // Special-ability flags (used by engine for unique mechanics).
  abilities: {
    // Electronic-warfare: nearby enemy missiles lose track more often; player gets a "jammer" HUD indicator.
    jammer?: boolean;
    // Gunship: weapon is a side-firing autocannon that always fires toward the targeted ground/enemy
    // when player banks into a pylon turn (roll > threshold).
    sideCannon?: boolean;
    // Stealth: radar signature reduced — enemies take longer to lock on; missiles less accurate.
    stealth?: boolean;
    // AWACS: enlarged radar range — more blips visible on the radar/minimap.
    awacs?: boolean;
    // === 攻角限制器 (per user request: CapsLock 解除攻角限制) ===
    // Fighter FBW with an AoA limiter: HOLDING CapsLock releases the limiter —
    // the nose can pull past ~18° into deep-AoA without the stall nose-drop
    // (the FBW/vector authority holds the attitude).
    aoaLimiter?: boolean;
    // === 推力矢量 TVC (per user request: 超低速无视舵效衰减) ===
    // Thrust-vectoring nozzles: with CapsLock held at very low speed, control
    // authority no longer degrades with airflow (speedT floor) — the nose can
    // still swing to drive the velocity vector.
    tvc?: boolean;
  };
}

export interface WeaponState {
  GUN: number; // -1 = infinite
  MSL: number;
  LASM: number;
  BDL: number; // free-fall dumb bombs
  FLR: number;
  EW?: number;  // EW jammer charges (-1 = infinite)
  SIDE?: number; // gunship side-cannon ammo (-1 = infinite)
  // === SP weapon slots (per user request: 参考皇牌空战sp武器) ===
  // Each SP weapon is its own slot — only ONE is non-zero at a time (the
  // player picks one in the briefing screen). All default to 0; the
  // engine bumps the selected one based on the player's localStorage
  // 'skybound.spWeapon' key.
  LAAM?: number; // long-range AAM count
  QAAM?: number; // quick-maneuvering AAM count
  SARH?: number; // semi-active radar homing AAM count
  // === 新武器 (per user request) ===
  '4AAM'?: number;  // 四联空对空
  '4AGM'?: number;  // 四联空对地(攻顶)
  LASER?: number;   // 激光发射器(按"跳"计量)
  VASM?: number; // realistic radar AAM count (per user request)
  HVG?: number;  // hypervelocity gun pod ammo
  CLB?: number;  // cluster bomb count
  NKV?: number;  // tactical nuke count (per user request)
}

export interface EnemySpawn {
  // === AI 分层 (per user request: 大部分普通 AI, 少部分高级 AI) ==================
  // 'ace' = 高级(6 倍血 + 4 次导弹规避), 缺省 = 普通。
  // hpScale / fireRateScale 是给"普通"再分档用的: 血更少、导弹间隔更长 —— 剧情关卡里的大编队
  // 必须靠这两个旋钮压下来, 否则十几架一起扑上来玩家根本打不过。
  skill?: 'normal' | 'ace';
  hpScale?: number;
  fireRateScale?: number;
  model: AircraftModel;
  role: AircraftRole;
  position: [number, number, number];
  heading: number; // radians, 0 = +Z
  altitude: number;
  formationOffset?: [number, number, number];
  // Optional name override for special units.
  callsign?: string;
  // For wingman spawns (allied aircraft, not carriers).
  isWingman?: boolean;
  // === Ace (per user request: 第零关雪鸮王牌中队) ===
  // Ace units: HP ×6, dodge the first 4 missile hits at 90% then 20%,
  // take half gun damage, and are invulnerable during the story-lock phase.
  ace?: boolean;
  // === §335 剧情 s02《洞川撤退》: 逐机的"打谁"分工 ============================
  // 敌机 AI 原本是"75% 概率打玩家 / 否则打最近的友军", 而护送关必须能表达
  // "这 4 架只冲轰炸机 / 这 2 架绕后打运输机 / 这 3 架缠住护航机"。这里给每架
  // 一个可选分工, 由 updateEnemies 的目标选择读取(见 engine.ts 的 roleTag 分支):
  //   'bomber-hunter'    优先找友军**轰炸机**(长弓编队)
  //   'transport-hunter' 优先找友军**运输机**(铁锤编队)
  //   'escort-engager'   只打护航机(玩家 + 僚机), 不碰编队
  //   'ace-on-escort'    王牌: 死盯玩家僚机里的指定一架(targetWingman)
  // 不填 = 保持原有行为(普通关零回归)。
  roleTag?: 'bomber-hunter' | 'transport-hunter' | 'escort-engager' | 'ace-on-escort';
  /** roleTag==='ace-on-escort' 时死盯的僚机序号(0 基, 对应 wingmen 数组下标) */
  targetWingman?: number;
}

// === Wave-based mission structure ===
// A mission can define `waves` instead of (or in addition to) `spawns` so that
// enemies arrive in stages. The next wave spawns only after the current wave
// is fully destroyed (or the wave timer expires, whichever comes first).
//   - waveNumber: 1-indexed display label ("WAVE 1/3")
//   - spawns: enemy spawns for this wave (uses the same EnemySpawn format)
//   - delayAfterPrevious: seconds to wait after the previous wave clears
//     before this wave spawns. The first wave ignores this (spawns immediately)
//   - trigger: optional condition that spawns this wave early (per user request:
//     T-00 条件触发波次). When set, the wave spawns as soon as the condition is
//     met instead of waiting for the previous wave to clear.
//   - optional message banner: shown when the wave spawns
export interface Wave {
  waveNumber: number;
  spawns: EnemySpawn[];
  delayAfterPrevious?: number; // seconds; default 5
  banner?: string;             // optional banner message
  trigger?: 'immediate' | 'laser1' | 'laser2' | 'laser3' | 'radar';
}

// Explicitly-placed ground unit (per user request: T-00 激光防空炮/雷达站).
export interface GroundSpawnDef {
  type: string;                       // GroundUnitType name ('laser_aa', 'radar_station', ...)
  position: [number, number, number]; // world XZ (Y ignored — snapped to terrain)
  name: string;                       // HUD name (e.g. '激光防空炮 1')
  isAlly?: boolean;
  hp?: number;                        // optional HP override
}

// Missile tier — drives guidance quality + wobble.
//   - 'low':    weak turn rate, more wobble, shorter range. Used by regular
//               enemy fighters so the player can actually dodge them.
//   - 'normal': standard guidance. Used by elite bandits (Su-35, F-15) and
//               by allied (player + wingman) missiles.
//   - 'high':   top-tier guidance (longer range, tighter turn). Reserved for
//               bosses / named aces.
export type MissileTier = 'low' | 'normal' | 'high';

export interface MissionObjective {
  id: string;
  label: string;
  type: 'destroy' | 'protect' | 'survive' | 'reach';
  target: string;
  count?: number;
  time?: number;
  // === §335 s02: 'reach' 终于有实现了("护送编队抵达某点") ====================
  // 之前 'reach'/'survive' 只声明未实现(见 checkObjectives), s02 的胜利条件是
  // "东奥莱编队全部进入西南防空圈" ⇒ 用 target 指向谁、pos+radius 指向哪个圈:
  //   target: 'escort'  = 该关的护送编队(轰炸机+运输机)
  //   target: 'player'  = 玩家
  //   pos/radius        = 判定圆心(米, y 忽略)与半径
  // allInside=true 时要求**全部**单位都进圈(编队齐了才算), 否则任一进圈即达成。
  pos?: [number, number, number];
  radius?: number;
  allInside?: boolean;
}

// ============================================================================
// 简报情报(手写块)—— 皇牌空战式简报的输入
// ============================================================================
// 为什么需要"手写"这一路: 简报要显示"敌人和友军在哪里", 但**不是每个关卡的数据里
// 都有坐标**。s01(正式版剧情第一关)的 spawns/waves/groundSpawns 全是空的 —— 它的
// 敌人由引擎的剧情控制器 setupStoryS01 按阶段动态刷出, 任务数据里一个坐标都没有。
// 这类关卡只能手写一份"情报图"(简报本来就是情报, 近似是它的本色)。
//
// 其余关卡**不需要**填这个字段: briefing-intel.ts 会从 spawns / waves /
// groundSpawns / allySpawns / startPos 自动推导。有本字段时以手写为准(逐项覆盖)。
//
// 坐标系与任务数据完全一致: x/z 米, 0 = 海平面, heading 弧度 0 = +Z。
export type BriefingSide = 'player' | 'friendly' | 'enemy' | 'target';
export type BriefingDomain = 'air' | 'ground' | 'naval' | 'hvt';

export interface BriefingUnitDef {
  /** 省略则自动生成(`${side}${index}`); 卡片/航线按 id 引用 */
  id?: string;
  side: BriefingSide;
  domain: BriefingDomain;
  /** 型号短码: 空中用 MODEL_CODE('F-15'), 地面用 'RDR'/'LASER-AA' 之类的短码 */
  code: string;
  /** 呼号或单位名(missions 里地面单位本来就带中文名) */
  label?: string;
  roleZh?: string;
  roleEn?: string;
  x: number;
  z: number;
  /** 米。地面单位省略(引擎侧也是忽略 Y 再贴地) */
  altitude?: number;
  heading?: number;
  hp?: number;
  /** 探测/交战半径(米), 卡片上的威胁等级按它归一化 */
  range?: number;
  /** >1 = 情报估计(后续波次), 3D 侧画得更暗更细 */
  wave?: number;
  /** 卡片排序权重, 越大越靠前 */
  priority?: number;
  /** 标记尺寸倍率(省略按 side/domain 给默认值) */
  size?: number;
  /** 仅 domain:'hvt' —— 线框舰体尺寸(宽/高/长), 复用简报的 addHullBox */
  hull?: [number, number, number];
  /** 上目标卡片(省略时按 side/domain/priority 规则决定) */
  card?: { title?: string; typeLabel?: string; weapon?: string; threat?: 1 | 2 | 3 | 4 | 5 };
}

export interface BriefingRouteDef {
  id: string;
  side: 'friendly' | 'enemy';
  /** 地图上/战术图上的航线名(如 'ROUTE ALPHA' / 'INGRESS 1') */
  label: string;
  points: [number, number, number][];
  /** 虚线 = 佯攻/预备/情报估计路线 */
  dash?: boolean;
}

/** 手写简报情报(Mission.briefing) */
export interface MissionBriefingIntel {
  /** 世界范围(米)。省略则按所有单位的包围盒推导, 会夹紧到 16000..60000 */
  world?: { cx: number; cz: number; size: number };
  units: BriefingUnitDef[];
  /** 手写区域(防空圈/威胁圈)。省略时会从 `reach` 类作战目标自动推导 */
  areas?: BriefingAreaDef[];
  routes?: BriefingRouteDef[];
}

/**
 * 简报上的"区域" —— 一个圆(防空圈/安全区/威胁圈)。
 * 由 s02《洞川撤退》引入: 那一关的胜利条件是"编队**全部进入**西南防空圈", 半径 4.3km
 * 的一片空域就是这一关的全部地理 —— 简报不把它画出来, 玩家根本不知道要往哪飞。
 * 所以自带 pos/radius 的 `reach` 作战目标会自动变成一张简报区域, 不必手写。
 */
export interface BriefingAreaDef {
  id?: string;
  /** 'friendly' = 我方防空圈/安全区(青蓝) · 'enemy' = 威胁圈(红) */
  side: 'friendly' | 'enemy';
  /** 地图上的注解文字(尽量短, 会画在圆边上) */
  label: string;
  x: number;
  z: number;
  radius: number;
}

export interface Mission {
  id: string;
  codename: string;
  title: string;
  brief: string;
  // === 正式版剧情关卡序号 (per user request: 剧情菜单单独搞关卡) =================
  // 有值 = 这一关属于「正式版剧情」战役, 序号即关卡号(1 = 第一关)。
  // 剧情菜单只列这些关卡; 普通出击列表(MissionSelect)只列没有该字段的关卡。
  campaign?: number;
  sky: 'day' | 'sunset' | 'dawn' | 'storm' | 'night';
  // === HDRI 天空盒 (per user request: 第一关用真实 HDRI 天空) ===
  // When set, this mission replaces the procedural atmospheric sky with an
  // equirect HDRI (EXR path under public/, loaded via assetUrl): the sky
  // background dome samples the EXR and scene.environment (IBL) is baked
  // from the same EXR via PMREMGenerator.fromEquirectangular. Sun disc /
  // weather sky-colour shifts are skipped — the HDRI carries the lighting.
  environment?: string;
  weather: WeatherPreset;
  map: MapPreset;
  startAltitude: number;
  startSpeed: number;
  startPos: [number, number, number];
  startHeading: number;
  spawns: EnemySpawn[];
  // Optional wave-based spawning. If present, the engine spawns the FIRST
  // wave on mission start and queues subsequent waves — each next wave
  // spawns only after the current wave is fully destroyed (with a brief
  // delay). The objective counts carry over across waves.
  waves?: Wave[];
  objectives: MissionObjective[];
  allySpawns?: { position: [number, number, number]; hp: number; name: string }[];
  // === Explicit ground-unit placements (per user request: T-00) ===
  // When present, spawnGroundUnits() places these instead of the automatic
  // map-based scatter. Used for fixed story targets (laser AA guns, radar
  // station) at exact positions with custom names.
  groundSpawns?: GroundSpawnDef[];
  // === Terrain overrides (per user request: 雪山) ===
  // Partial HeightmapTerrainOpts passed to buildHeightmapTerrain — e.g.
  // { snowLine: 0.05, snowColor: '#f4f6fa' } for an all-snow mountain map.
  terrain?: {
    snowLine?: number;
    rockColor?: string;
    grassColor?: string;
    sandColor?: string;
    snowColor?: string;
    /** === 指定 terrain-tune 里的**自定义地形槽** (per user request: 测试关) ===
     * map:'custom' 时默认吃 tune 的 maps.custom(m13 的雪山)。填 'test' 之类的槽名
     * 就改用 maps.test —— 于是同一张 custom 地图能挂**多份外部高度包**, 关卡之间
     * 互不影响(引擎里只有一处 mapTune 调用, 见 engine.ts 的地形构建段)。 */
    slot?: string;
  };
  /** === 关卡级太阳(时刻)覆盖 (per user request: "时间应该在下午两点") ===
   *  azimuth: 0°=+X, 增大朝 -Z 转; elevation: 0°=地平线。下午两点 ≈ 52/235。 */
  sun?: { elevation?: number; azimuth?: number };
  /** === 世界运动标度的**关卡级**覆盖 (4× 大图专用) ==========================
   *  默认标度(0.382)是给 72.9 km 的旧城市地图调的; 搬到 291.6 km 的 4× 世界后,
   *  同样的标度让所有单位都"慢了 4 倍" —— 实测第二关的撤退航线全长 263 km, 编队
   *  92 m/s ⇒ 单是第一段(144.7 km)就要飞 26 分钟, 而任务时限只有 25 分钟。
   *  这里给这种大图关卡一个覆盖值(范围同控制台 `spd k`, 0.1~1.5), 只影响**世界位移**;
   *  仪表读数与脚本物理不受影响(与 skybound.worldSpeedK 同一套反向补偿)。*/
  worldSpeedK?: number;
  timeLimit?: number;
  reward: string;
  /** === 云/天气旋钮的**关卡级**覆盖 (per user request: 第一关天气指数固定 0.5) ===
   * 优先级: **本字段 > localStorage(skybound.cloud*) > 规则默认** —— 与地形那条
   * (mission.terrain > localStorage > tune) 同一套规矩。
   * 存在的理由: 旋钮只活在 localStorage(全局), 想在某一关钉住一个观感只能手动设置、
   * 换关就串味; 关卡数据是唯一能焊死单关观感的地方。
   * 例: `cloud: { wex: 0.5 }` ⇒ 这一关的天气指数恒为 0.5(0.1..8 内夹紧)。 */
  cloud?: {
    wex?: number;         // 天气指数(库的 weather exponent)：云的"浓/散"总闸
    profile?: number;     // 竖直密度廓线(线性项 0..1)：小=压云底, 大=堆云顶
    baseM?: number;       // 云底海拔(m)
    topM?: number;        // 云顶海拔(m)
    densK?: number;       // 密度系数(仍受 CLOUD_RULE_DENS_MAX 上限约束)
    shapeAmt?: number;    // 形状调制量
    covFilter?: number;   // 覆盖率过渡带
    detailAmt?: number;   // 细节侵蚀量
  };
  // Recommended aircraft categories for this mission (shown in briefing).
  recommendedCategories?: AircraftCategory[];
  // === 手写简报情报 (per user request: 皇牌空战式简报) ========================
  // 只在"关卡数据里没有敌我坐标"时才有必要填(s01: 敌人由剧情控制器动态刷出)。
  // 省略 => briefing-intel.ts 从 spawns/waves/groundSpawns/allySpawns 自动推导。
  briefing?: MissionBriefingIntel;
}

export interface HudState {
  speed: number; // knots
  altitude: number; // feet
  heading: number; // degrees
  throttle: number; // 0..1
  hp: number; // current HP (absolute, may exceed 100 with the new HP boost)
  maxHp: number; // maximum HP for percentage bar calculation
  weapons: WeaponState;
  currentWeapon: WeaponType;
  // === §337 武器面板"剩余弹量条"的归一基准 ==================================
  // 每种武器**本局见过的最大弹量**(起飞挂载量; 补给/换挂后自动抬高)。
  // 面板按 当前/最大 画条长。引擎每帧取 max 累计(见 emitHud 里 weaponMax 那几行)。
  weaponMax?: Record<string, number>;
  // === Gunship caliber label (e.g. "105MM HOWITZER") for the HUD ===
  gunshipGunLabel?: string;
  // === Dual-slot reload state (per user request) ===
  // [slotReady0, slotReady1] — true = that slot can fire right now.
  weaponSlots: boolean[];
  // === Incoming-lock radar alert (per user request: 被锁定时有雷达告警) ===
  // True while an enemy unit is locking the player or an enemy missile is
  // inbound. Rendered as a flashing red warning in the HUD.
  incomingLock: boolean;
  // === Airbrake (减速板) — per user request: H 键开启减速板 ===
  // True while the speedbrake is deployed (drag ×3) — shown in the HUD.
  airbrakeOpen?: boolean;
  // === AC-130 side-cannon impact predictor (per user request) ===
  // Screen-space (0..1) predicted shell impact + blast-radius circle (px).
  // Only non-null while the gunship FPS side view is active.
  sideCannonImpact: { x: number; y: number; radius: number; dist?: number; gunLabel?: string } | null;
  lockProgress: number; // 0..1
  hasLock: boolean;
  targetName: string;
  targetDist: number; // meters
  targetAspect: number; // degrees off nose
  radarBlips: { x: number; y: number; type: 'enemy' | 'ally' | 'neutral' | 'missile'; id: number }[];
  offRadar: { x: number; y: number; type: 'enemy' | 'ally' | 'neutral' | 'missile'; id: number; dist: number }[];
  minimapBlips: {
    x: number;
    z: number;
    y: number;
    type: 'enemy' | 'ally' | 'neutral' | 'missile';
    id: number;
    isTarget?: boolean;
  }[];
  screenMarkers: {
    x: number;
    y: number;
    type: 'enemy' | 'ally' | 'neutral' | 'missile';
    id: number;
    onScreen: boolean;
    isTarget: boolean;
    dist: number;
    edgeX: number;
    edgeY: number;
    name?: string;
    modelName?: string;  // 载具型号 (per user request: HUD 显示被切换目标的型号)
    isNext?: boolean;    // 下一个切换候选目标 → 雷达框上显示 NE
    occluded?: boolean;  // 视线被地形/建筑/单位遮挡 → 虚线框
    isPlayer?: boolean;  // 玩家机(远端玩家) → 雷达框上**常驻显示名字**
    important?: boolean; // 重要单位(友军轰炸机/运输机, 见 engine.isImportantUnit) → 框上打绿 X
  }[];
  // === §335 s02: 世界空间区域(防空圈等)与空爆弹预警 ========================
  // 雷达/小地图上要画的**世界坐标圆**: 平移到 toMap() 后按 (r/range)*R 画弧。
  // 之前引擎里没有任何世界空间圆的概念(只有屏幕空间量程环), 这是为"西南防空圈"
  // 与"空爆弹锁定圈"新加的最小机制。
  zones?: {
    x: number; z: number; r: number;
    color: 'friendly' | 'hostile' | 'danger';
    label?: string;
  }[];
  /** §339: 当前武器若此刻开火会是"无制导"(没锁定) —— HUD 显示提示 */
  unguided?: boolean;
  /** 空爆弹预警(全图雷达预警 3 秒): 锁定圈 + 倒计时, 到 0 引爆 */
  airburstWarning?: { x: number; z: number; r: number; countdown: number } | null;
  // === Flight instruments (per user request: 速度矢量 + 机头指向矢量) ===
  // Screen-space (0..1) positions of the player's world velocity direction
  // (flight-path marker) and nose pointing direction. null when off the
  // screen edge / not computable.
  velocityVector?: { x: number; y: number } | null;
  noseVector?: { x: number; y: number } | null;
  playerPos: { x: number; y: number; z: number };
  objectiveText: string;
  objectiveProgress: string;
  missionTime: number;
  score: number;
  message: string;
  messageTime: number;
  gForce: number;
  stall: boolean;
  cameraMode: CameraMode;
  cockpit: boolean;
  // === 视角缩放倍率 (per user request: 无级缩放 + UI 显示倍率) ===
  // 摄像机缩放放大率:默认机位 zoomBaseline/当前 zoomMult —— 1.0 = 设置默认
  // 机位;滚轮拉近(相机变近/画面放大)>1,拉远 <1。滚轮连续缩放实时变化。
  cameraZoom: number;
  // === 临时镜头缩放读数 (per user request: 精确化调整) ===
  // 控制台 `__zoomHud()` 打开后在**过载值下面**显示(4 位小数);
  // zoomRaw = 相机自己的 zoomMult(0.72 = 设置里的默认机位, 越小 = 相机越近 = 画面越大)。
  zoomReadout: boolean;
  zoomRaw: number;
  radioMessages: {
    id: number;
    speaker: string;
    side: 'ally' | 'enemy' | 'awacs';
    text: string;
    duration: number;
    startAt: number;
  }[];
  // === New: realistic flight telemetry ===
  aoa: number;        // angle of attack in degrees
  energy: number;     // specific energy (0..1 normalized)
  loadFactor: number; // G
  // === AoA limiter override (per user request: CapsLock 按住) ===
  // True while a fighter holds the AoA-limiter override (CapsLock) — the HUD
  // shows "AOA LIMIT OFF"; TVC aircraft show extra low-speed authority.
  aoaOverrideActive?: boolean;
  // TVC low-speed authority engaged (thrust-vectoring keeps control at very
  // low speed while the override is held) — HUD shows a TVC tag.
  tvcActive?: boolean;
  // Wingman command state (current order shown in HUD)
  wingmanCommand: WingmanCommand;
  // === Reinforcement call state ===
  // 0 = ready, >0 = seconds until next call available.
  reinforcementCooldown: number;
  // Number of reinforcement calls remaining (max 2 per mission).
  reinforcementsRemaining: number;
  // Weather + environment readout
  weather: WeatherPreset;
  windSpeed: number; // m/s
  // Storm intensity 0..1 (rain density / lightning chance)
  stormIntensity: number;
  // === Aircraft specialization readout ===
  // Active aircraft category (e.g. "fighter", "gunship"). Drives HUD mode.
  aircraftCategory: AircraftCategory;
  // Player's currently-active special-ability flags (mirrors spec.abilities).
  abilities: {
    jammer?: boolean;
    sideCannon?: boolean;
    stealth?: boolean;
    awacs?: boolean;
  };
  // Jammer charge 0..1 (only meaningful when abilities.jammer).
  jammerCharge: number;
  // Side-cannon readiness 0..1 (only meaningful when abilities.sideCannon).
  sideCannonCharge: number;
  // === Wave system ===
  // 0 when mission has no waves. Otherwise: currentWave (1-indexed).
  currentWave: number;
  // Total number of waves in the mission (0 when no waves).
  totalWaves: number;
  // Number of enemies remaining in the current wave (display only).
  waveEnemiesRemaining: number;
  // True while waiting between waves (during the delay window).
  waveTransition: boolean;
  // Seconds until next wave spawns (only meaningful during waveTransition).
  waveTransitionTime: number;
  // === Bloom / sun visual state ===
  // 0..1 sun brightness factor — drives HUD glare / lens effect (currently
  // purely informational; the bloom pass itself is configured in-engine).
  sunIntensity: number;
  // True if the mission is using the 'night' sky preset (drives HUD styling).
  isNight: boolean;
  // === Radar/minimap zoom level ===
  // 0 = small (4km), 1 = medium (8km), 2 = large (14km). Cycled by KeyM.
  radarZoomLevel: number;
  // Current radar range in world units (derived from radarZoomLevel).
  radarRange: number;
  // === Hit feedback (per user request) ===
  // damageFlash: 0..1 — briefly 1 when player takes damage, decays to 0.
  // The HUD renders a red vignette overlay whose opacity = damageFlash.
  damageFlash: number;
  // hitConfirmFlash: 0..1 — briefly 1 when player's weapon hits an enemy,
  // decays to 0. The HUD renders a subtle green reticle pulse on hit.
  hitConfirmFlash: number;
  // killFlash: 0..1 — briefly 1 when player kills an enemy. Triggers a
  // stronger HUD pulse + screen-edge tinted flash.
  killFlash: number;
  // === Bomb impact predictor (per user request) ===
  // When currentWeapon === 'BDL', the engine computes where a bomb dropped
  // right now would land (parabolic free-fall from current altitude / speed /
  // heading). The HUD renders a ground-reticle marker at this world position
  // projected to screen. Empty array when BDL isn't selected.
  bombImpactPoint: { x: number; y: number; z: number } | null;
  // The projected screen-space position of the bomb impact point (0..1 NDC
  // already mapped to 0..1 with y flipped). null when off-screen or behind.
  bombImpactScreen: { x: number; y: number; radius: number } | null;
  // === 落点水平距离 + 下落时间 (per user request: 指示器按速度和落点距离结合) ===
  // 与落点指示器同一个弹道解: distance = 落点离机体的水平距离(m), tof = 从投放到
  // 落地的时间(s)。HUD 在指示器旁显示, 让"速度和距离一起算出来"这件事看得见。
  bombImpactDist?: number;
  bombImpactTof?: number;
  // === Gun/HVG straight-line impact predictor (per user request: 炮类落点指示器) ===
  gunImpactScreen?: { x: number; y: number; radius: number } | null;
  // === Nuke white flash (per user request: NKV 战术核弹) ===
  nukeFlash?: number;
  // === Score gain popup (per user request: 僚机击杀左上角加分播报) ===
  // Set for a short window after any kill (player or wingman) so the
  // top-left score panel can flash "+2500".
  scoreGain?: number;
  // === 不带僚机模式 (per user request) ===
  wingmenEnabled?: boolean;
  // True when the player is in free-look mode (holding the free-look key).
  // HUD shows a "FREE LOOK" indicator so the player knows they're not
  // controlling the aircraft.
  freeLook: boolean;
  // True when the player is flying dangerously close to terrain (within
  // 100m). HUD shows a "TERRAIN" pull-up warning.
  terrainWarning: boolean;
  // === Lock-on type (per user request: 红外弹MSL vs 雷达弹区分锁定UI) ===
  // The HUD renders different lock-on indicators depending on the missile
  // type currently selected:
  //   - 'ir'    = infrared-homing (MSL, QAAM, LASM) — pulsing red circle
  //               that shrinks/locks onto the target's radar frame.
  //   - 'radar' = radar-homing (LAAM, SARH) — 45°-tilted small square that
  //               jitters around the target, settling on lock.
  //   - 'none'  = weapon doesn't use lock-on (GUN, BDL, EW, SIDE, HVG, CLB)
  // The engine sets this each frame based on currentWeapon.
  lockType: 'ir' | 'radar' | 'none';
  // The screen-space position of the CURRENT LOCK TARGET (0..1 NDC, y
  // already flipped). null when no target. Used by the HUD to render the
  // lock indicator at the target's position rather than at screen centre.
  lockTargetScreen: { x: number; y: number } | null;
  /** true = 正在播关卡内过场运镜(HUD 画上下黑边, 让出画面给镜头) */
  cinematic?: boolean;
  // === Gun aiming ring (per user request: 机炮瞄准环) ===
  // Screen-space position of the hostile aircraft the target switch sits on,
  // shown when it's within gun effective range. `active` = inside the 30°
  // auto-aim cone (the gun is slewing onto the lead point). null otherwise.
  gunAimRing?: { x: number; y: number; active: boolean } | null;
  // === Gun heat for the cooldown bar (per user request: 机炮冷却槽) ===
  // 0..1. At 1.0 the gun is overheated and locked out until it cools below
  // 0.7. The HUD renders a small heat gauge next to the ammo list.
  gunHeat?: number;
  // True while the gun is in the overheat lockout (heat ≥ 1 until cooled to
  // 0.7) — the HUD shows a red "过热" indicator for the whole lockout.
  gunOverheated?: boolean;
  // === Manual gun mode (per user request: 纯机炮准心) ===
  // true = auto-aim disabled — the gun fires straight and the HUD shows a
  // fixed centre crosshair; the player leads the target manually.
  gunManual?: boolean;
  // === Radar filter toggle (per user request: 雷达指示可开关) ===
  // When true, the HUD shows a "FILTER" indicator and the radar/minimap/
  // screen markers are pre-filtered by the engine to only include the
  // player's wingmen + currently selected target + incoming missiles.
  // Toggled with KeyT.
  radarFilter: boolean;
  // === Mouse-aim cursor (per user request: 战争雷霆式鼠标瞄准) ===
  // Screen-space (0..1, y 0=top) position of the WT-style aim circle +
  // whether the mouse-aim control mode is active. null when the control
  // mode is keyboard. Rendered by the HUD as a small ring with a dot.
  mouseAimCursor?: { x: number; y: number; active: boolean } | null;
  // === In-mission debug view (per user request: ` 键调试控制台) ===
  // Current engine debug view label — the HUD shows it as a small badge so
  // the player knows which render layer is being inspected. '', 'lit',
  // 'wireframe', 'lod', 'radar', or a G-Buffer channel name.
  debugView?: string;
  // === FPS counter (per user request: 调试控制台 fps 命令) ===
  // Smoothed frames-per-second, only pushed when the console's `fps` overlay
  // is on. The HUD renders it bottom-left.
  fps?: number;
  // === 联机 HUD 状态 (P2 收尾) ===
  // 单机为 undefined → 积分板/击杀信息/复活倒计时完全不出现, 单机画面零变化。
  // 字段与 net/session.ts 的 NetUiState 结构一致。
  mp?: {
    isHost: boolean;
    selfTeam: number;
    /** 本机是否处于"被击毁等待复活"。 */
    dead: boolean;
    /** 复活倒计时(秒, 0 = 可复活)。 */
    respawnIn: number;
    respawnReady: boolean;
    matchOver: boolean;
    players: { name: string; team: number; kills: number; deaths: number; isSelf: boolean }[];
    teamScores: Record<string, number>;
    feed: { id: number; killer: string; victim: string; selfInvolved: boolean }[];
    peers: number;
    pingMs: number;
  };
}

// === Control remapping support ===
export interface ControlBindings {
  pitchUp: string;
  pitchDown: string;
  rollLeft: string;
  rollRight: string;
  yawLeft: string;
  yawRight: string;
  throttleUp: string;
  throttleDown: string;
  brake: string;
  fireGun: string;
  fireMissile: string;
  flare: string;
  cycleCamera: string;
  cycleWeapon: string;
  togglePause: string;
  nextTarget: string;
  lookBack: string;
  // === Look-at-target (hold) — per user request: R 注视敌人 ===
  // While held, the chase camera keeps the currently selected/switched
  // hostile unit near the centre of the view (Ace Combat-style target cam).
  lookTarget: string;
  // === Wingman view toggle — per user request: B 切换僚机视角 ===
  // Edge-triggered: cycles the camera onto each wingman to see what they're
  // doing; past the last wingman it returns to the player's own view.
  wingmanView: string;
  // === Missile view toggle — per user request: G 观察发射的导弹 ===
  // Edge-triggered: follows your most recently fired missile in a missile
  // cam; pressing again (or the missile detonating) returns to the chase cam.
  missileView: string;
  // Wingman commands
  wingmanAttack: string;
  wingmanCover: string;
  wingmanForm: string;
  // Call in allied reinforcements (new wingmen spawn and fly to the player).
  callReinforcement: string;
  // Cycle radar/minimap zoom (small / medium / large range).
  cycleRadarRange: string;
  // === Radar filter toggle (per user request: 雷达指示可开关) ===
  // When active, the radar + screen markers only show the player's wingmen
  // + currently selected target + incoming missiles. Lets the player focus
  // on their immediate tactical picture instead of the full battlefield.
  toggleRadarFilter: string;
  // === Free-look (hold) — per user request ===
  // While held, the chase camera decouples from the aircraft's heading and
  // follows mouse movement so the player can look around without turning
  // the aircraft. Releasing the key snaps the camera back to the chase view.
  freeLook: string;
  // === AC-130 gunship side-firing view toggle (per user request) ===
  // Toggles the camera between the standard chase/cockpit cycle and the
  // side-firing 105mm gunport view. Only effective when flying a gunship-
  // category aircraft (AC-130). In side view, the camera is positioned
  // at the port-side gunport with a limited mouse-drag range, and the
  // aircraft is allowed to leave the field of view (no auto-recentering).
  // === KeyK (per user request: CapsLock 让给攻角限制解除) ===
  toggleSideView: string;
  /** 起落架收放 (per user request: G 键) */
  gear: string;
  // === AoA limiter override (per user request: CapsLock 按住解除攻角限制) ===
  // Fighters with an AoA limiter: HOLD CapsLock → nose pulls past the FBW
  // AoA limit into deep-AoA without the stall nose-drop. TVC aircraft also
  // keep full control authority at very low speed while held.
  aoaOverride: string;
  // === Airbrake (减速板) — per user request: H 开启减速板 ===
  // While held, the speedbrake deploys and multiplies the air drag, so the
  // aircraft loses speed quickly. The high-G brake moved to KeyN.
  airbrake: string;
  // === Emergency brake (紧急减速板) — per user request: Z 按住 ===
  // Hold to deploy the emergency speedbrake — same drag multiplier as the
  // regular airbrake (×3). Unlike airbrake it is hold-to-activate, not a
  // toggle, so it stacks naturally with high-G/energy management.
  emergencyBrake: string;
}

export interface InversionSettings {
  pitch: boolean;   // invert pitch (pull back = nose up becomes push forward = nose up)
  yaw: boolean;
  roll: boolean;
}

export const DEFAULT_BINDINGS: ControlBindings = {
  pitchUp: 'KeyS',
  pitchDown: 'KeyW',
  rollLeft: 'KeyA',
  rollRight: 'KeyD',
  yawLeft: 'KeyQ',
  yawRight: 'KeyE',
  throttleUp: 'ShiftLeft',
  throttleDown: 'ControlLeft',
  // === B now toggles the wingman view (per user request) ===
  // The high-G brake moved to KeyN — H is now the airbrake (减速板).
  brake: 'KeyN',
  // === H = airbrake (per user request: h键开启减速板) ===
  // Hold to deploy the speedbrake → drag ×3, speed drops fast.
  airbrake: 'KeyH',
  // === Z = emergency brake (per user request: Z 按住紧急减速板) ===
  // Hold to deploy — same drag ×3 as the airbrake, but hold-to-activate.
  emergencyBrake: 'KeyZ',
  // === 机炮 ↔ 导弹 键位对调 (per user request: 通用键位) ===
  // 机炮 空格 -> **F**, 导弹 F -> **空格**。
  // 旧存档不必手工改: input.ts 的 loadFromStorage 里那段"新默认键优先"的冲突解决会把
  // (fireGun=Space, fireMissile=KeyF) 这一对自动纠正成新默认(两者互相冲突, 两个方向都能判到)。
  fireGun: 'KeyF',
  fireMissile: 'Space',
  // === G = 热焰弹 (per user request) ===
  flare: 'KeyG',
  // === M = cycle camera (per user request: 切换视角绑定换成 M 键) ===
  // The radar-range zoom moved to KeyI to free M for the camera cycle.
  cycleCamera: 'KeyM',
  cycleWeapon: 'KeyV',
  togglePause: 'KeyP',
  nextTarget: 'Tab',
  // === R = 注视敌人 (per user request) ===
  // R now holds the Ace-Combat-style target camera; look-back moves to X.
  // === 回看视角键位**已取消** (per user request: lookback 键不要了) ===
  // 置空字符串 = 该动作没有绑定键(输入表支持 ''), 于是 setLookBack 恒为 false。
  lookBack: '',
  lookTarget: 'KeyR',
  // === B = 僚机视角 (per user request) ===
  wingmanView: 'KeyB',
  // === J = 导弹视角 (per user request: G恢复热焰弹，J是导弹视角) ===
  missileView: 'KeyJ',
  wingmanAttack: 'Digit1',
  wingmanCover: 'Digit2',
  wingmanForm: 'Digit3',
  callReinforcement: 'Digit4',
  // === I = radar range (per user request: M 让给切换视角) ===
  // The radar zoom moved off M so M could become the camera cycle key.
  cycleRadarRange: 'KeyI',
  // Toggle radar filter (wingman + selected target only).
  toggleRadarFilter: 'KeyT',
  // Hold KeyC to enter free-look (camera decouples, mouse looks around).
  // Release to snap back to chase view.
  freeLook: 'KeyC',
  // === AC-130 side-firing view — KeyK (per user request: CapsLock 让给 AoA) ===
  // Moved off CapsLock so CapsLock can be the AoA-limiter override on fighters.
  toggleSideView: 'KeyK',
  gear: 'KeyX',
  // === AoA limiter override — CapsLock (per user request: 按住解除攻角限制) ===
  // Fighters with aoaLimiter hold this to release the FBW AoA limit (nose can
  // pull deep without the stall nose-drop); TVC aircraft also keep authority
  // at very low speed while held.
  aoaOverride: 'CapsLock',
};

export const DEFAULT_INVERSION: InversionSettings = {
  pitch: false,
  yaw: false,
  // === Roll default INVERTED (per user request: 滚转预设默认反向) ===
  // The on-screen joystick / gamepad / mouse-aim roll reads as reversed to
  // most users out of the box, so the default is flipped. The Settings axis
  // inversion toggle still overrides it per-save.
  roll: true,
};
