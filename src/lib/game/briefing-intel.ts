// ============================================================================
// 简报情报推导 —— 任务数据 → "敌我态势图"
// ============================================================================
// 皇牌空战式简报要回答的问题只有三个: 我们在哪、敌人在哪、往哪打。
// 本模块把 Mission 数据翻译成这三种答案, 供两个消费者使用:
//   ① briefing-map.ts   —— 把单位投影到 2D 区域地图上
//   ② briefing-stage.ts —— 把单位摆进 3D 缩比网格战场
// 两边共用同一份 world(中心/边长)与同一套投影, 所以"地图上的那个点"和"3D 里的那
// 个标记"永远是同一个世界位置 —— 相机俯冲穿过地图时, 它们原地重合。
//
// 两条数据来源:
//   * mission.briefing 手写块(存在即优先): 给"关卡数据里没有坐标"的关卡用。
//     s01 就是这种 —— 它的敌人由引擎剧情控制器动态刷出, spawns 是空数组。
//   * 自动推导: spawns / waves / groundSpawns / allySpawns / startPos。
//     16 个普通关卡的数据都很全(如 t00: 4 僚机 + 4 波 24 架 + 11 个地面单位)。
//
// 纯数据模块: 不 import three, 不碰 DOM, 不读 localStorage。

import type {
  AircraftModel,
  AircraftRole,
  BriefingDomain,
  BriefingRouteDef,
  BriefingSide,
  BriefingUnitDef,
  MapPreset,
  Mission,
} from './types';
import { MODEL_CODE } from './aircraft-catalog';

// ============================================================================
// 地面单位类型表(本模块私有)
// ============================================================================
// 为什么不从 environment.ts import GroundUnitType、从 engine.ts import GROUND_MODEL_LABEL:
//   * environment.ts 是 5000+ 行的地形/环境模块, engine.ts 更是 23000+ 行 —— 简报屏
//     是菜单, 它的第一原则是"进得快、卸得干净"。为了十几个字符串把整个引擎拖进菜单
//     屏的包, 是拿加载时间换打字量。
//   * 那两张表在 engine.ts 里本来就是模块私有, 而且已经重复了两份。
// 所以这里按"只声明用得到的子集"复刻一份, 数值与 engine.ts 一致。
// (本仓库已有先例: StoryBrief.tsx / Results3D.tsx 各自复刻了 CRT_PWR_GLOW。)
type GroundKind =
  | 'tank' | 'sam_launcher' | 'aa_vehicle' | 'artillery' | 'bunker' | 'radar_station' | 'laser_aa'
  | 'destroyer' | 'cruiser' | 'frigate' | 'patrol_boat'
  | 'air_light' | 'air_component' | 'air_boss' | 'air_drone';

/** 地面单位中文名(与 engine.ts 的 GROUND_MODEL_LABEL 同值) */
const GROUND_LABEL: Record<GroundKind, string> = {
  tank: '主战坦克', sam_launcher: '导弹发射车', aa_vehicle: '防空车',
  artillery: '自行火炮', bunker: '碉堡', radar_station: '雷达站', laser_aa: '激光防空炮',
  destroyer: '驱逐舰', cruiser: '巡洋舰', frigate: '护卫舰', patrol_boat: '巡逻艇',
  air_light: '轻型空中战舰', air_component: '舰载组件', air_boss: '空中战舰', air_drone: '无人机',
};

/** 地面单位英文名(en locale 用; 中文名是关卡数据里的既定叫法, 英文这份是本模块补的) */
const GROUND_LABEL_EN: Record<GroundKind, string> = {
  tank: 'MAIN BATTLE TANK', sam_launcher: 'SAM LAUNCHER', aa_vehicle: 'SPAAG',
  artillery: 'SELF-PROPELLED HOWITZER', bunker: 'HARDENED BUNKER',
  radar_station: 'RADAR STATION', laser_aa: 'LASER AA GUN',
  destroyer: 'DESTROYER', cruiser: 'CRUISER', frigate: 'FRIGATE', patrol_boat: 'PATROL BOAT',
  air_light: 'LIGHT AIR WARSHIP', air_component: 'SHIP COMPONENT',
  air_boss: 'AIR DREADNOUGHT', air_drone: 'UCAV',
};

/** 地面单位型号码(卡片与标记用) */
const GROUND_CODE: Record<GroundKind, string> = {
  tank: 'MBT', sam_launcher: 'SAM', aa_vehicle: 'SPAAG', artillery: 'SPH',
  bunker: 'BUNKER', radar_station: 'RDR', laser_aa: 'LASER-AA',
  destroyer: 'DDG', cruiser: 'CG', frigate: 'FFG', patrol_boat: 'PB',
  air_light: 'AIR-L', air_component: 'COMP', air_boss: 'AIR-BOSS', air_drone: 'UCAV',
};

/** 地面单位 HP(与 engine.ts 的 hpMap 同值; 关卡可用 GroundSpawnDef.hp 覆盖) */
const GROUND_HP: Record<GroundKind, number> = {
  tank: 80, sam_launcher: 150, aa_vehicle: 60, artillery: 70, bunker: 120,
  radar_station: 80, laser_aa: 480,
  destroyer: 200, cruiser: 260, frigate: 150, patrol_boat: 60,
  air_light: 900, air_component: 260, air_boss: 999999, air_drone: 40,
};

/** 探测/交战半径(米, 与 engine.ts 的 radarRangeMap 同值) —— 威胁等级的归一化依据 */
const GROUND_RANGE: Record<GroundKind, number> = {
  tank: 1500, sam_launcher: 7000, aa_vehicle: 3000, artillery: 2500, bunker: 1500,
  radar_station: 12000, laser_aa: 5000,
  destroyer: 6000, cruiser: 8000, frigate: 5500, patrol_boat: 2000,
  air_light: 9000, air_component: 4000, air_boss: 14000, air_drone: 3000,
};

const GROUND_TYPES = Object.keys(GROUND_CODE) as GroundKind[];
const GROUND_SET = new Set<string>(GROUND_TYPES);
const isGroundKind = (t: string): t is GroundKind => GROUND_SET.has(t);

/** 无法识别的类型名(关卡数据漂移/新增) —— 不崩, 当成"未编目地面目标" */
const UNKNOWN = { zh: '地面目标', en: 'UNKNOWN GROUND TARGET', code: 'GND', hp: 80, range: 2000 };

function gLabelZh(t: string): string { return isGroundKind(t) ? GROUND_LABEL[t] : UNKNOWN.zh; }
function gLabelEn(t: string): string { return isGroundKind(t) ? GROUND_LABEL_EN[t] : UNKNOWN.en; }
function gCode(t: string): string { return isGroundKind(t) ? GROUND_CODE[t] : UNKNOWN.code; }
function gHp(t: string): number { return isGroundKind(t) ? GROUND_HP[t] : UNKNOWN.hp; }
function gRange(t: string): number { return isGroundKind(t) ? GROUND_RANGE[t] : UNKNOWN.range; }

/** 地面/海面/空中战舰的域划分 */
function gDomain(t: string): BriefingDomain {
  if (t === 'air_boss' || t === 'air_light' || t === 'air_component') return 'hvt';
  if (t === 'destroyer' || t === 'cruiser' || t === 'frigate' || t === 'patrol_boat') return 'naval';
  return 'ground';
}

/** 建议武器(按单位类型) —— 卡片上的"怎么打" */
const GROUND_WEAPON: Record<GroundKind, string> = {
  laser_aa: 'AGM · 反辐射', radar_station: 'AGM · 反辐射', sam_launcher: 'AGM · 防区外',
  aa_vehicle: 'UGB · 低空突防', tank: 'UGB · 集束', artillery: 'UGB · 集束',
  bunker: 'UGB · 穿透', destroyer: 'LASM · 反舰', cruiser: 'LASM · 反舰',
  frigate: 'LASM · 反舰', patrol_boat: 'GUN · 扫射',
  air_light: 'LASM · 反舰', air_component: 'AGM · 部件剥离',
  air_boss: 'QAAM · 核心暴露后', air_drone: 'GUN / MSL',
};
const AIR_WEAPON = 'MSL / QAAM';

/** 空中角色 → 中/英角色名 */
const AIR_ROLE: Record<AircraftRole, { zh: string; en: string }> = {
  player: { zh: '你 · 长机', en: 'YOU · LEAD' },
  wingman: { zh: '僚机', en: 'WINGMAN' },
  fighter: { zh: '敌战斗机', en: 'ENEMY FIGHTER' },
  interceptor: { zh: '敌截击机', en: 'ENEMY INTERCEPTOR' },
  bomber: { zh: '敌轰炸机', en: 'ENEMY BOMBER' },
  attack: { zh: '敌攻击机', en: 'ENEMY ATTACK' },
  awacs: { zh: '预警机', en: 'AWACS' },
  ew: { zh: '敌电子战机', en: 'ENEMY EW' },
  gunship: { zh: '炮艇机', en: 'GUNSHIP' },
  stealth: { zh: '敌隐身机', en: 'ENEMY STEALTH' },
};

function airRole(role: AircraftRole | undefined, side: BriefingSide): { zh: string; en: string } {
  if (role && AIR_ROLE[role]) return AIR_ROLE[role];
  return side === 'enemy' ? AIR_ROLE.fighter : AIR_ROLE.wingman;
}

// ============================================================================
// 配色(标记与卡片共用一份, 免得两处漂移)
// ============================================================================
// 色相沿用 Hud.tsx 的 CANVAS_COLOR 与旧简报的 MARK_COLOR: 友军青蓝、敌方红/红橙,
// 琥珀是终端主色。新增一档 estimate(暗琥珀)表达"这是情报估计, 还没到场"。
export const MARK_COLOR = {
  player: '#8fe8ff',    // 玩家机: 友军青蓝提亮一档(自己永远最显眼)
  friendly: '#5ad2ff',  // 友军/僚机
  target: '#ff3b1f',    // 作战目标(HUD 的"当前目标红"同值)
  hvt: '#ff3b1f',       // 高价值目标(空中战舰): 同红, 靠双环 + 实心块区分
  enemy: '#ff6a2c',     // 非目标敌机: 红橙, 与目标红拉开一档
  estimate: '#a8580c',  // 后续波次/情报估计: 暗琥珀, 形状也更细
} as const;
export type MarkTone = keyof typeof MARK_COLOR;

export function toneColor(tone: MarkTone): string { return MARK_COLOR[tone]; }

/** 标记图形: 全由线段拼成(1 个标记 = 1 个 draw call, 线宽恒 1px, 像 HUD) */
export type GlyphKind = 'chevron' | 'ring' | 'diamond' | 'bracket';

/** 蓝图线稿类型(卡片缩略图上画哪种装备) */
export type BlueprintKind =
  | 'radar' | 'laser_aa' | 'sam' | 'aa' | 'tank' | 'artillery' | 'bunker'
  | 'ship_small' | 'ship_large' | 'aircraft' | 'airship' | 'generic';

// ============================================================================
// 运行时数据结构
// ============================================================================

export interface BriefingUnit {
  id: string;
  tone: MarkTone;
  glyph: GlyphKind;
  side: BriefingSide;
  domain: BriefingDomain;
  /** 型号码: 'F-15' / 'RDR' / 'LASER-AA' */
  code: string;
  /** 呼号或单位名 */
  label: string;
  roleZh: string;
  roleEn: string;
  /** 世界坐标(米) */
  x: number;
  z: number;
  altitude: number;
  /** 朝向(弧度, 0 = +Z)。线框舰体用它摆正首向 */
  heading?: number;
  hp?: number;
  range?: number;
  /** >1 = 情报估计(后续波次) */
  wave?: number;
  priority: number;
  /** 标记尺寸倍率(几何单位会先按相机距离等比放大, 再乘它) */
  size: number;
  /** 仅 hvt: 线框舰体尺寸 */
  hull?: [number, number, number];
  /** true = 出 DOM 标签(受 MAX_LABELS 限制) */
  labelled: boolean;
  /** true = 上目标卡片 */
  card: boolean;
  /** true = 画立杆(地面单位立杆表达"它在地面") */
  pin: boolean;
  /** 实心填充块(只有玩家机与高价值目标配得上) */
  fill: boolean;
  /** 战术阶段的错峰入场延迟(秒) */
  delay: number;
}

export interface BriefingRoute {
  id: string;
  side: 'friendly' | 'enemy';
  label: string;
  /** 世界坐标折线(y 为海拔) */
  points: [number, number, number][];
  dash: boolean;
  /** 3D 侧错峰绘制延迟(秒) */
  delay: number;
}

/**
 * 简报区域(一个圆)。2D 地图上画成虚线圆 + 排线, 3D 里是地面上的一圈环。
 * 来源: 手写 `Mission.briefing.areas`, 或从自带 pos/radius 的 `reach` 作战目标推导。
 */
export interface BriefingArea {
  id: string;
  tone: MarkTone;
  label: string;
  x: number;
  z: number;
  radius: number;
}

export interface BriefingCard {
  unitId: string;
  title: string;
  code: string;
  typeLabel: string;
  /** 地图格号(游戏内 GRID; 本作没有 lat/lon, 不谎报经纬度) */
  gridRef: string;
  /** 威胁等级 1..5 */
  threat: 1 | 2 | 3 | 4 | 5;
  weapon: string;
  blueprint: BlueprintKind;
  objective?: string;
  tone: MarkTone;
}

export interface BriefingWorld {
  /** 世界中心(米) */
  cx: number;
  cz: number;
  /** 正方形边长(米) —— 地图平面与缩比网格共用同一块地 */
  size: number;
}

export interface BriefingIntel {
  world: BriefingWorld;
  region: MapPreset;
  units: BriefingUnit[];
  routes: BriefingRoute[];
  areas: BriefingArea[];
  cards: BriefingCard[];
}

// ============================================================================
// 确定性随机
// ============================================================================
// 同一关每次进场必须是同一张地图、同一条航线 —— 否则玩家每次重进简报都看到不同的
// 世界, "情报"就不可信了。所以所有程序化取值(地图海岸线、航线中间点)都从 mission
// id 播种, 不用 Math.random()。
export function seedFrom(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// 投影(2D 地图与 3D 场景的唯一真相)
// ============================================================================
// u 向右 = +X, v 向上 = +Z(地图上北在屏幕上方)。世界是正方形且以 (cx,cz) 为中心,
// 所以 u,v 落在 0..1 内; 超出范围的点在真实数据里不该出现(世界按包围盒推导), 但
// 手写情报块可以指定 world, 所以消费者仍要自己裁剪。
export function projectToMap(x: number, z: number, world: BriefingWorld): [number, number] {
  return [0.5 + (x - world.cx) / world.size, 0.5 + (z - world.cz) / world.size];
}

/** 8x8 分区的军用格号(游戏内 GRID) */
export function gridRef(x: number, z: number, world: BriefingWorld): string {
  const [u, v] = projectToMap(x, z, world);
  const col = Math.max(0, Math.min(7, Math.floor(u * 8)));
  const row = Math.max(0, Math.min(7, Math.floor(v * 8)));
  const subU = Math.max(0, Math.min(9, Math.floor((u * 8 - col) * 10)));
  const subV = Math.max(0, Math.min(9, Math.floor((v * 8 - row) * 10)));
  return `${String.fromCharCode(65 + col)}${8 - row}-${subU}${subV}`;
}

// ============================================================================
// 规模上限
// ============================================================================
// t00 这种关卡有 39 个单位(4 僚机 + 24 架波次机 + 11 个地面)。全部标注会糊成一片,
// 所以: 标记全画(不谎报敌人数量), 但**标签**限量; 波次 >1 的用暗色细字形表达
// "这是情报估计"。
const MAX_LABELS = 12;
const MAX_CARDS = 4;
const MAX_ROUTES = 5;
/** 单位总数上限(极端关卡兜底) */
const MAX_UNITS = 64;
/** 单条 'any' 型作战目标最多把几个敌人提升为"作战目标"(防止满屏红) */
const ANY_TARGET_PROMOTE = 3;
// 世界边长的下/上限。
//   下限: 几公里的遭遇战不该得到一个几公里的世界(相机贴脸、网格粗得像砖)。
//   **上限必须留得足够大**: 正式版剧情关卡用的是 291.6 km 的 4× 广域地形 ——
//   s02《洞川撤退》的出生点 (101272,124198) 到撤离点 (-70192,-139581) 直线就有
//   240 km, 再加撤离点自己 28 km 的半径, 内容跨度近 300 km。
//   旧上限 60000 会把整张态势图**裁没**: 单位与区域全落在世界方块之外, 相机对着一片
//   空地, 界面上只剩网格 —— 用户报的"s02 简报里态势图不见了"就是这个(实测踩过)。
const WORLD_MIN = 16000;
const WORLD_MAX = 400000;

// ============================================================================
// 威胁 / 蓝图
// ============================================================================
function threatOf(range: number | undefined, domain: BriefingDomain): 1 | 2 | 3 | 4 | 5 {
  if (domain === 'hvt') return 5;
  const r = range ?? 2000;
  if (r >= 12000) return 5;
  if (r >= 8000) return 4;
  if (r >= 5000) return 3;
  if (r >= 3000) return 2;
  return 1;
}

function blueprintOf(domain: BriefingDomain, kind?: GroundKind, isAir?: boolean): BlueprintKind {
  if (isAir || domain === 'air') return 'aircraft';
  if (domain === 'hvt') return 'airship';
  if (!kind) return 'generic';
  if (kind === 'radar_station') return 'radar';
  if (kind === 'laser_aa') return 'laser_aa';
  if (kind === 'sam_launcher') return 'sam';
  if (kind === 'aa_vehicle') return 'aa';
  if (kind === 'tank') return 'tank';
  if (kind === 'artillery') return 'artillery';
  if (kind === 'bunker') return 'bunker';
  if (domain === 'naval') return kind === 'destroyer' || kind === 'cruiser' ? 'ship_large' : 'ship_small';
  return 'generic';
}

function weaponOf(domain: BriefingDomain, kind?: GroundKind): string {
  if (domain === 'air') return AIR_WEAPON;
  if (kind) return GROUND_WEAPON[kind];
  return domain === 'hvt' ? GROUND_WEAPON.air_boss : 'AGM · 通用';
}

// ============================================================================
// 作战目标的匹配器
// ============================================================================
// objective.target 的取值(全库实测): any / fighter / bomber / ace / boss / laser / radar,
// 另有 protect:fleet。匹配不到任何单位时该目标不影响简报(不编造敌人)。
function objectiveMatcher(target: string): {
  match: (def: BriefingUnitDef, kind: GroundKind | undefined, ace: boolean) => boolean;
  /** true = 不限数量(any 这类), 由调用方按优先级挑几个 */
  all: boolean;
} {
  switch (target.toLowerCase()) {
    case 'laser': return { match: (_d, k) => k === 'laser_aa', all: false };
    case 'radar': return { match: (_d, k) => k === 'radar_station', all: false };
    case 'boss': return { match: (d) => d.domain === 'hvt', all: false };
    case 'ace': return { match: (_d, _k, ace) => ace, all: false };
    case 'bomber': return { match: (d) => d.code === 'B-52' || d.code === 'TU-95', all: false };
    case 'fighter': return {
      match: (d) => d.code === 'F-16' || d.code === 'F-15' || d.code === 'MiG-29' || d.code === 'Su-35',
      all: false,
    };
    default: return { match: () => true, all: true };
  }
}

// ============================================================================
// 单位组装
// ============================================================================

interface Draft {
  def: BriefingUnitDef;
  /** 原始地面类型后缀(用于卡片蓝图与建议武器); 空中单位为空 */
  groundKind?: GroundKind;
  ace?: boolean;
  /** 被哪条作战目标认领(卡片上显示"所属任务") */
  objective?: string;
}

function buildUnit(def: BriefingUnitDef, groundKind: GroundKind | undefined): BriefingUnit {
  const side = def.side;
  const domain = def.domain;
  const isAir = domain === 'air';

  // 色相: 玩家 → 友军 → 高价值目标 → 作战目标 → 后续波次估计 → 敌
  let tone: MarkTone;
  if (side === 'player') tone = 'player';
  else if (side === 'friendly') tone = 'friendly';
  else if (domain === 'hvt') tone = 'hvt';
  else if (side === 'target') tone = 'target';
  else if ((def.wave ?? 1) > 1) tone = 'estimate';
  else tone = 'enemy';

  // 图形: 空中用指向性符号, 地面/海面用括号框, 高价值目标用解算环
  let glyph: GlyphKind;
  if (domain === 'hvt') glyph = 'ring';
  else if (isAir) glyph = side === 'enemy' || side === 'target' ? 'diamond' : 'chevron';
  else glyph = 'bracket';

  const range = def.range ?? (groundKind ? gRange(groundKind) : undefined);
  const fallbackLabel = groundKind ? gLabelZh(groundKind) : '地面目标';
  // 标记尺寸倍率: 玩家机最显眼, 高价值目标次之, 后续波次更小(它是"估计")
  const size = def.size
    ?? (side === 'player' ? 1.35
      : domain === 'hvt' ? 1.7
        : side === 'target' ? 1.05
          : domain === 'air' ? 0.95
            : side === 'friendly' ? 0.95
              : 0.85);

  return {
    id: def.id ?? `unit-${side}-${Math.round(def.x)}-${Math.round(def.z)}`,
    tone,
    glyph,
    side,
    domain,
    code: def.code,
    label: def.label ?? fallbackLabel,
    roleZh: def.roleZh ?? fallbackLabel,
    roleEn: def.roleEn ?? (groundKind ? gLabelEn(groundKind) : UNKNOWN.en),
    x: def.x,
    z: def.z,
    altitude: def.altitude ?? 0,
    heading: def.heading,
    hp: def.hp,
    range,
    wave: def.wave,
    priority: def.priority ?? 0,
    size,
    hull: def.hull,
    labelled: false,
    card: false,
    pin: !isAir,
    fill: side === 'player' || domain === 'hvt',
    delay: 0,
  };
}

/** 单位排序权重: 越大越该上卡片 / 越该带标签 */
function unitPriority(u: BriefingUnit): number {
  let p = u.priority;
  if (u.side === 'player') p += 1000;
  if (u.side === 'target') p += 500;
  if (u.domain === 'hvt') p += 400;
  if (u.side === 'friendly') p += 200;
  p += Math.min(300, (u.hp ?? 0) / 4);
  p -= (u.wave ?? 1) * 30; // 后续波次优先级更低(它是"估计")
  return p;
}

// ============================================================================
// 主推导
// ============================================================================

/** 把任务数据推导成一份简报情报 */
export function deriveBriefingIntel(mission: Mission | undefined): BriefingIntel {
  const region: MapPreset = mission?.map ?? 'ocean';
  const drafts: Draft[] = [];
  const authoredRoutes: BriefingRouteDef[] = [];

  if (mission?.briefing) {
    // === 手写情报: 以它为准 ===
    mission.briefing.units.forEach((def, i) => {
      def.id = def.id ?? `authored-${i}`;
      drafts.push({ def });
    });
    if (mission.briefing.routes) authoredRoutes.push(...mission.briefing.routes);
  } else if (mission) {
    // === 自动推导 ===
    const start = mission.startPos;
    drafts.push({
      def: {
        id: 'player', side: 'player', domain: 'air', code: 'LEAD',
        label: 'RAVEN 1', roleZh: AIR_ROLE.player.zh, roleEn: AIR_ROLE.player.en,
        x: start[0], z: start[2], altitude: start[1], heading: mission.startHeading,
        priority: 900,
      },
    });

    // 空中单位: spawns(含僚机) + waves 逐波
    let airIndex = 0;
    const pushAir = (s: Mission['spawns'][number], wave?: number): void => {
      const isWing = !!s.isWingman || s.role === 'wingman';
      const side: BriefingSide = isWing ? 'friendly' : 'enemy';
      const role = airRole(s.role, side);
      const model = MODEL_CODE[s.model] ?? String(s.model).toUpperCase();
      airIndex += 1;
      drafts.push({
        def: {
          id: `air-${airIndex}`,
          side,
          domain: 'air',
          code: model,
          label: s.callsign ?? `${model} ${airIndex}`,
          roleZh: role.zh,
          roleEn: role.en,
          x: s.position[0],
          z: s.position[2],
          altitude: s.altitude ?? s.position[1],
          heading: s.heading,
          wave,
          priority: s.ace ? 260 : (isWing ? 120 : 40),
        },
        ace: !!s.ace,
      });
    };
    for (const s of mission.spawns ?? []) pushAir(s);
    for (const w of mission.waves ?? []) for (const s of w.spawns) pushAir(s, w.waveNumber);

    // 地面单位
    (mission.groundSpawns ?? []).forEach((g, i) => {
      const domain = gDomain(g.type);
      const kind = isGroundKind(g.type) ? g.type : undefined;
      drafts.push({
        def: {
          id: `gnd-${i}`,
          side: g.isAlly ? 'friendly' : 'enemy',
          domain,
          code: gCode(g.type),
          label: g.name,
          roleZh: gLabelZh(g.type),
          roleEn: gLabelEn(g.type),
          x: g.position[0],
          z: g.position[2],
          hp: g.hp ?? gHp(g.type),
          range: gRange(g.type),
          priority: domain === 'hvt' ? 400 : 80,
          hull: domain === 'hvt' ? [900, 240, 160] : undefined,
        },
        groundKind: kind,
      });
    });

    // 友军水面单位(航母之类)
    (mission.allySpawns ?? []).forEach((a, i) => {
      drafts.push({
        def: {
          id: `ally-${i}`,
          side: 'friendly', domain: 'naval', code: 'CV',
          label: a.name, roleZh: '友军水面舰艇', roleEn: 'ALLIED SURFACE UNIT',
          x: a.position[0], z: a.position[2], hp: a.hp, range: 4000, priority: 180,
        },
        groundKind: 'cruiser',
      });
    });

    // === 作战目标 → 认领单位(把它们提升为"目标"并优先上卡片) ===
    for (const o of mission.objectives ?? []) {
      if (o.type !== 'destroy') continue;
      const m = objectiveMatcher(o.target);
      const candidates = drafts.filter((d) => d.def.side === 'enemy' && m.match(d.def, d.groundKind, !!d.ace));
      if (candidates.length === 0) continue;
      let take = candidates;
      if (m.all) {
        // 'any' 之类不限形状: 只把最有价值的几个提升为目标, 否则整张图会红成一片
        const want = Math.max(ANY_TARGET_PROMOTE, Math.min(o.count ?? ANY_TARGET_PROMOTE, 6));
        take = candidates
          .slice()
          .sort((a, b) => ((b.def.hp ?? 0) + (b.ace ? 200 : 0)) - ((a.def.hp ?? 0) + (a.ace ? 200 : 0)))
          .slice(0, want);
      } else {
        take = candidates.slice(0, Math.max(1, o.count ?? candidates.length));
      }
      for (const d of take) {
        d.def.side = 'target';
        d.def.priority = (d.def.priority ?? 0) + (d.def.domain === 'hvt' ? 400 : 300);
        d.objective = o.label;
      }
    }
  }

  // === 单位组装 / 排序 / 截断 ===
  const built = drafts.map((d) => buildUnit(d.def, d.groundKind));
  built.sort((a, b) => unitPriority(b) - unitPriority(a));
  const kept = built.slice(0, MAX_UNITS);
  const draftOf = new Map<string, Draft>();
  for (const d of drafts) if (d.def.id) draftOf.set(d.def.id, d);

  // 上卡片的资格: 手写指定, 或"作战目标 / 高价值目标"
  for (const u of kept) {
    u.card = !!draftOf.get(u.id)?.def.card || u.side === 'target' || u.domain === 'hvt';
  }

  // 标签限量: 先按优先级给前 MAX_LABELS 个, 再保证玩家一定有
  for (let i = 0; i < kept.length && i < MAX_LABELS; i += 1) kept[i].labelled = true;
  const player = kept.find((u) => u.side === 'player');
  if (player) player.labelled = true;

  // 入场延迟: 玩家 → 友军 → 高价值目标 → 目标 → 其余敌人(错峰 0.075s)
  const passOf = (u: BriefingUnit): number =>
    u.side === 'player' ? 0 : u.side === 'friendly' ? 1 : u.domain === 'hvt' ? 2 : u.side === 'target' ? 3 : 4;
  let order = 0;
  for (let pass = 0; pass <= 4; pass += 1) {
    for (const u of kept) {
      if (passOf(u) !== pass) continue;
      u.delay = order * 0.075;
      order += 1;
    }
  }

  // === 区域(防空圈/威胁圈) ===
  // 手写的优先; 再把手写没覆盖到的、自带 pos/radius 的 `reach` 目标补进来
  // —— s02《洞川撤退》的胜利条件就是"编队全部进入西南防空圈", 那片空域必须画出来。
  const areas: BriefingArea[] = [];
  for (const [i, a] of (mission?.briefing?.areas ?? []).entries()) {
    areas.push({
      id: a.id ?? `area-${i}`,
      tone: a.side === 'friendly' ? 'friendly' : 'target',
      label: a.label,
      x: a.x,
      z: a.z,
      radius: a.radius,
    });
  }
  for (const o of mission?.objectives ?? []) {
    if (o.type !== 'reach' || !o.pos || !o.radius) continue;
    const near = areas.some((a) => Math.hypot(a.x - o.pos![0], a.z - o.pos![2]) < Math.max(1000, o.radius! * 0.5));
    if (near) continue;
    areas.push({
      id: `obj-${o.id}`,
      tone: 'friendly',
      label: o.label,
      x: o.pos[0],
      z: o.pos[2],
      radius: o.radius,
    });
  }

  // === 航线 ===
  const routes: BriefingRoute[] = authoredRoutes.map((r, i) => ({
    id: r.id, side: r.side, label: r.label, points: r.points, dash: !!r.dash, delay: i * 0.22,
  }));

  if (routes.length === 0 && kept.length > 0) {
    const rand = mulberry32(seedFrom(mission?.id ?? 'brief'));
    const start = mission?.startPos ?? [0, 2000, -8000];
    const startPt: [number, number, number] = [start[0], start[1], start[2]];

    // 友军突击航线: 从起飞点打到各目标簇(<=3 条)
    const strikeGroups = cluster(kept.filter((u) => u.side === 'target' || u.side === 'enemy'), 3);
    strikeGroups.forEach((group, i) => {
      const pts: [number, number, number][] = [startPt];
      const dx = group.x - startPt[0];
      const dz = group.z - startPt[2];
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len;
      const nz = dx / len;
      // 两个中间点: 沿航线垂线错开一点, 让带子有真实的转弯形状(而不是一条直尺)
      for (let k = 1; k <= 2; k += 1) {
        const t = k / 3;
        const bulge = (rand() - 0.5) * 0.28;
        pts.push([
          startPt[0] + dx * t + nx * len * bulge,
          startPt[1] + (group.altitude - startPt[1]) * t,
          startPt[2] + dz * t + nz * len * bulge,
        ]);
      }
      pts.push([group.x, group.altitude, group.z]);
      routes.push({
        id: `strike-${i}`,
        side: 'friendly',
        label: i === 0 ? 'ROUTE ALPHA' : i === 1 ? 'ROUTE BRAVO' : 'ROUTE CHARLIE',
        points: pts,
        dash: false,
        delay: i * 0.22,
      });
    });

    // 敌军来袭航线: 敌方集群 → 玩家方向(虚线 = 情报估计)
    const ingress = cluster(kept.filter((u) => u.side === 'enemy' || u.side === 'target'), 2);
    ingress.forEach((group, i) => {
      const from: [number, number, number] = [group.x, group.altitude, group.z];
      const pts: [number, number, number][] = [from];
      for (let k = 1; k <= 2; k += 1) {
        const t = k / 3;
        pts.push([
          from[0] + (startPt[0] - from[0]) * t,
          group.altitude + (startPt[1] - group.altitude) * t,
          from[2] + (startPt[2] - from[2]) * t,
        ]);
      }
      routes.push({
        id: `ingress-${i}`,
        side: 'enemy',
        label: i === 0 ? 'INGRESS 1' : 'INGRESS 2',
        points: pts,
        dash: true,
        delay: 0.3 + i * 0.22,
      });
    });
  }

  // === 世界范围 ===
  // 单位 + 航线端点 + 区域(含半径)全都要进包围盒 —— 只按单位算的话, 一条通往角落的
  // 航线或一个半径 4.3km 的防空圈会被切在地图外面。
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  const grow = (x: number, z: number): void => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  };
  for (const u of kept) grow(u.x, u.z);
  for (const r of routes) for (const p of r.points) grow(p[0], p[2]);
  for (const a of areas) { grow(a.x - a.radius, a.z - a.radius); grow(a.x + a.radius, a.z + a.radius); }
  if (!Number.isFinite(minX)) { minX = -8000; maxX = 8000; minZ = -8000; maxZ = 8000; }
  const span = Math.max(maxX - minX, maxZ - minZ, 4000);
  const world: BriefingWorld = mission?.briefing?.world ?? {
    cx: (minX + maxX) / 2,
    cz: (minZ + maxZ) / 2,
    size: Math.max(WORLD_MIN, Math.min(WORLD_MAX, span * 1.15)),
  };

  // === 目标卡片 ===
  const cards: BriefingCard[] = [];
  for (const u of kept) {
    if (cards.length >= MAX_CARDS) break;
    if (!u.card) continue;
    const draft = draftOf.get(u.id);
    const def = draft?.def;
    const kind = draft?.groundKind;
    const isAir = u.domain === 'air';
    cards.push({
      unitId: u.id,
      title: def?.card?.title ?? u.label,
      code: u.code,
      typeLabel: def?.card?.typeLabel
        ?? (u.domain === 'hvt' ? '空中战舰 · 高价值目标'
          : u.side === 'target' ? (def?.roleZh ?? u.roleZh)
            : u.roleZh),
      gridRef: gridRef(u.x, u.z, world),
      threat: def?.card?.threat ?? threatOf(u.range, u.domain),
      weapon: def?.card?.weapon ?? weaponOf(u.domain, kind),
      blueprint: blueprintOf(u.domain, kind, isAir),
      objective: draft?.objective,
      tone: u.tone,
    });
  }

  return { world, region, units: kept, routes: routes.slice(0, MAX_ROUTES), areas, cards };
}

/** 简单聚类: 把单位按"离得近"分成 n 组, 返回每组中心与平均高度 */
function cluster(
  units: BriefingUnit[],
  n: number,
): { x: number; z: number; altitude: number; units: BriefingUnit[] }[] {
  if (units.length === 0) return [];
  // 最远点采样做种子: 稳定、无需迭代收敛、不引入随机性(同一份数据永远同一组种子)
  const seeds: BriefingUnit[] = [units[0]];
  while (seeds.length < n && seeds.length < units.length) {
    let best: BriefingUnit | null = null;
    let bestD = -1;
    for (const u of units) {
      if (seeds.indexOf(u) >= 0) continue;
      let d = Infinity;
      for (const s of seeds) d = Math.min(d, Math.hypot(u.x - s.x, u.z - s.z));
      if (d > bestD) { bestD = d; best = u; }
    }
    if (!best) break;
    seeds.push(best);
  }
  const groups = seeds.map((s) => ({ x: 0, z: 0, altitude: 0, n: 0, seed: s, units: [] as BriefingUnit[] }));
  for (const u of units) {
    let gi = 0; let gd = Infinity;
    groups.forEach((g, i) => {
      const d = Math.hypot(u.x - g.seed.x, u.z - g.seed.z);
      if (d < gd) { gd = d; gi = i; }
    });
    const g = groups[gi];
    g.x += u.x; g.z += u.z; g.altitude += u.altitude; g.n += 1; g.units.push(u);
  }
  return groups
    .filter((g) => g.n > 0)
    .map((g) => ({ x: g.x / g.n, z: g.z / g.n, altitude: g.altitude / g.n, units: g.units }));
}

// ============================================================================
// 供 UI 使用的小工具
// ============================================================================

/** 单位总数按类别统计(简报底部的态势读数) */
export function intelSummary(intel: BriefingIntel): { friendly: number; enemy: number; targets: number } {
  let friendly = 0; let enemy = 0; let targets = 0;
  for (const u of intel.units) {
    if (u.side === 'player' || u.side === 'friendly') friendly += 1;
    else if (u.side === 'target') { targets += 1; enemy += 1; }
    else enemy += 1;
  }
  return { friendly, enemy, targets };
}
