// Aircraft catalog — central registry of all playable & spawned aircraft.
// Used by: Hangar UI (model picker), Briefing (player aircraft selection),
// Engine (player + enemy stats), and Models loader (geometry routing).

import type { AircraftModel, AircraftSpec, AircraftCategory } from './types';

// === Player-selectable aircraft ===
// These are the aircraft the player can fly in the Hangar/Briefing flow.
// Hostile-only aircraft (b52, su35, a10, f15, tu95) are NOT in the player
// roster by default — they appear as enemies/wingmen only.
export const PLAYER_AIRCRAFT: AircraftSpec[] = [
  // === Fighters ===
  // === F-16C Block 50 真实模型 (per user request: 完全替换原来那架低模 F-16) ===
  // 玩家默认机。机体 = War Thunder 导出的 F-16C Block 50 OBJ(40 万面)+ 30 张
  // _c/_n/_n_s/_n_ao 贴图,走 mig29.ts 同一条导入流程(见 src/lib/game/f16c.ts)。
  // 引擎里 'f16' 与 'f16c' 都解析到这套真实模型(敌机/僚机 f16 共用同一副合并
  // 几何),所以这架飞机就是"原来那架 F-16"的替换品。
  {
    id: 'f16c',
    name: 'F-16C VIPER',
    nameZh: 'F-16C 蝰蛇',
    code: 'F-16C',
    model: 'f16c',
    role: 'player',
    category: 'fighter',
    maxSpeed: 510,   // game units
    realMaxSpeed: 1300, // real: Mach 2.0
    minSpeed: 230,
    acceleration: 170,
    turnRate: 1.0,
    rollRate: 2.4,
    hp: 60,
    color: 0x808a96,
    scale: 1.4,
    abilities: { aoaLimiter: true },
  },
  // === MiG-29 支点 (per user request: 加入可玩机体, 真实贴图模型) ===
  // Twin-engine air-superiority fighter. Uses the real War Thunder OBJ + PBR
  // texture set (albedo/normal/specular→roughness) — player-only for now.
  {
    id: 'mig29',
    name: 'MiG-29 FULCRUM',
    nameZh: 'MiG-29 支点',
    code: 'MiG-29',
    model: 'mig29',
    role: 'player',
    category: 'fighter',
    maxSpeed: 560,
    realMaxSpeed: 1500, // real: Mach 2.25
    minSpeed: 240,
    acceleration: 180,
    turnRate: 1.05,
    rollRate: 2.3,
    hp: 65,
    color: 0x8a8f96,
    scale: 1.4,
    abilities: { aoaLimiter: true, tvc: true },
  },
  // === F-16X 可动舵面实验机 (per user request: 测试可动舵面可行性) ===
  // Same F-16 airframe and performance, but with VISIBLE movable control
  // surfaces (ailerons/elevator/rudder) driven by the 0.7s control authority
  // ramp — a testbed for the control-surface mechanic. Player-only.
  {
    id: 'f16-test',
    name: 'F-16X TESTBED',
    nameZh: 'F-16X 可动舵面实验机',
    code: 'F-16X',
    model: 'f16-test',
    role: 'player',
    category: 'fighter',
    maxSpeed: 510,   // game units
    realMaxSpeed: 1300, // real: Mach 2.0
    minSpeed: 230,
    acceleration: 170,
    turnRate: 1.0,
    rollRate: 2.4,
    hp: 60,
    color: 0x7a90a8,
    scale: 1.4,
    abilities: { aoaLimiter: true, tvc: true },
  },
  {
    id: 'f15-player',
    name: 'F-15 EAGLE',
    nameZh: 'F-15 鹰',
    code: 'F-15',
    model: 'f15',
    role: 'player',
    category: 'fighter',
    maxSpeed: 557,
    realMaxSpeed: 1630, // real: Mach 2.5
    minSpeed: 250,
    acceleration: 190,
    turnRate: 1.05,
    rollRate: 2.5,
    hp: 75,
    color: 0x884444,
    scale: 1.5,
    abilities: { aoaLimiter: true },
  },
  {
    id: 'su35-player',
    name: 'Su-35 FLANKER',
    nameZh: 'Su-35 侧卫',
    code: 'Su-35',
    model: 'su35',
    role: 'player',
    category: 'fighter',
    maxSpeed: 574,
    realMaxSpeed: 1490, // real: Mach 2.25
    minSpeed: 250,
    acceleration: 180,
    turnRate: 1.15,
    rollRate: 2.6,
    hp: 70,
    color: 0x556070,
    scale: 1.5,
    abilities: { aoaLimiter: true, tvc: true },
  },
  // === Attack (CAS) ===
  {
    id: 'a10-player',
    name: 'A-10 WARTHOG',
    nameZh: 'A-10 疣猪',
    code: 'A-10',
    model: 'a10',
    role: 'player',
    category: 'attack',
    maxSpeed: 319,
    realMaxSpeed: 390, // real: ~450 mph (subsonic CAS)
    minSpeed: 170,
    acceleration: 105,
    turnRate: 0.7,
    rollRate: 1.4,
    hp: 110,
    color: 0x4a4a3a,
    scale: 1.5,
    abilities: {},
  },
  // === Bomber ===
  {
    id: 'b52-player',
    name: 'B-52H STRATO',
    nameZh: 'B-52H 同温层堡垒',
    code: 'B-52',
    model: 'b52',
    role: 'player',
    category: 'bomber',
    // === 最高速度 208 → 700 (per user request: B-52 比 AC-130 更高一些) ===
    // 与 AC-130(600) 拉开档次: 轰炸机比炮艇机快。vsK 随之升到 0.58(上限 1.6),
    // 舵效/牵引/机头导向的机型适配区间一并上移(见 §128/§129/§134)。
    maxSpeed: 700,
    realMaxSpeed: 565, // real: ~650 mph
    minSpeed: 130,
    acceleration: 65,
    turnRate: 0.18,
    rollRate: 0.4,
    hp: 100,
    color: 0x6b6b66,
    scale: 0.9,
    abilities: {},
  },
  // === Electronic Warfare ===
  {
    id: 'ea18g',
    name: 'EA-18G GROWLER',
    nameZh: 'EA-18G 咆哮者',
    code: 'EA-18G',
    model: 'ea18g',
    role: 'player',
    category: 'ew',
    maxSpeed: 485,
    realMaxSpeed: 1190, // real: Mach 1.8
    minSpeed: 245,
    acceleration: 160,
    turnRate: 0.95,
    rollRate: 2.2,
    hp: 65,
    color: 0x445060,
    scale: 1.4,
    abilities: { jammer: true },
  },
  // === Gunship ===
  {
    id: 'ac130',
    name: 'AC-130 SPECTRE',
    nameZh: 'AC-130 幽灵炮艇',
    code: 'AC-130',
    model: 'ac130',
    role: 'player',
    category: 'gunship',
    // === 最高速度 174 → 600 (per user request) ===
    // 副作用是好的: 速度阈值缩放系数 vsK(= maxSpeed/1200) 从被夹住的下限 0.35 升到 0.5,
    // 舵效/牵引耦合的适配区间随之变宽(与「AC-130 不要用战斗机那套速度阈值」方向一致)。
    // 注: B-52 定为 700, 比炮艇机更高(per user request: b52 更高一些)。
    maxSpeed: 600,
    realMaxSpeed: 320, // real: ~368 mph
    minSpeed: 110,
    // === 引擎功率 / 加速能力 ×3 (per user request) ===
    // `acceleration` 就是推力功率项 —— 飞行模型里用它算加速度
    // (thrust = 0.14 × acceleration/90 × throttle / mass), 所以 ×3 同时提升了
    // "引擎功率"和"加速能力"。45 → 135。
    acceleration: 135,
    turnRate: 0.22,
    rollRate: 0.45,
    hp: 160,
    color: 0x4a4133,
    scale: 1.2,
    abilities: { sideCannon: true },
  },
  // === Stealth Strike ===
  {
    id: 'f117',
    name: 'F-117 NIGHTHAWK',
    nameZh: 'F-117 夜鹰',
    code: 'F-117',
    model: 'f117',
    role: 'player',
    category: 'stealth',
    maxSpeed: 383,
    realMaxSpeed: 594, // real: ~684 mph
    minSpeed: 205,
    acceleration: 110,
    turnRate: 0.7,
    rollRate: 1.6,
    hp: 55,
    color: 0x1a1d24,
    scale: 1.3,
    abilities: { stealth: true },
  },
  // === AWACS (support) ===
  {
    id: 'e3',
    name: 'E-3 SENTRY',
    nameZh: 'E-3 望楼',
    code: 'E-3',
    model: 'e3',
    role: 'player',
    category: 'awacs',
    maxSpeed: 289,
    realMaxSpeed: 460, // real: ~530 mph
    minSpeed: 190,
    acceleration: 85,
    turnRate: 0.32,
    rollRate: 0.6,
    hp: 90,
    color: 0x5a6068,
    scale: 1.2,
    abilities: { awacs: true },
  },
];

// Map model → default player spec (used by engine to look up player stats).
const SPEC_BY_MODEL: Partial<Record<AircraftModel, AircraftSpec>> = {};
for (const s of PLAYER_AIRCRAFT) {
  // First registration wins — keeps 'f16' player spec, etc.
  if (!SPEC_BY_MODEL[s.model]) SPEC_BY_MODEL[s.model] = s;
}

export function getPlayerSpec(model: AircraftModel): AircraftSpec {
  return SPEC_BY_MODEL[model] ?? PLAYER_AIRCRAFT[0];
}

// Display name — Chinese by default (per user request: 全部中文), falls back
// to the English name when the user toggled the locale to English.
export function aircraftNameZh(spec: AircraftSpec): string {
  return spec.nameZh ?? spec.name;
}

// === Model → short type code (per user request: HUD 显示载具型号) ===
// Shown on the HUD next to the target radar frame / off-screen arrow so the
// player can identify the switched target's vehicle type at a glance.
export const MODEL_CODE: Record<AircraftModel, string> = {
  f16: 'F-16',
  f16c: 'F-16C',
  'f16-test': 'F-16X',
  f15: 'F-15',
  su35: 'Su-35',
  a10: 'A-10',
  b52: 'B-52',
  tu95: 'TU-95',
  ea18g: 'EA-18G',
  ac130: 'AC-130',
  f117: 'F-117',
  e3: 'E-3',
  mig29: 'MiG-29',
};

// All models that need to be pre-loaded — player roster + enemy-only models.
export const ALL_MODELS: AircraftModel[] = [
  'f16',
  'f16c',
  'f16-test',
  'b52',
  'su35',
  'a10',
  'f15',
  'tu95',
  'ea18g',
  'ac130',
  'f117',
  'e3',
  'mig29',
];

// Paint schemes per category — used by Hangar UI + engine spawn colors.
export const PAINT_SCHEMES: Record<string, { name: string; colors: Partial<Record<AircraftCategory, number>> }> = {
  standard: {
    name: 'STANDARD',
    colors: {
      fighter: 0x808a96,
      bomber: 0x6b6b66,
      attack: 0x4a4a3a,
      ew: 0x445060,
      gunship: 0x4a4133,
      stealth: 0x1a1d24,
      awacs: 0x5a6068,
    },
  },
  stealth: {
    name: 'STEALTH',
    colors: {
      fighter: 0x2a2e36,
      bomber: 0x252830,
      attack: 0x2a2c30,
      ew: 0x252a30,
      gunship: 0x2a2620,
      stealth: 0x0e0f12,
      awacs: 0x2a2e34,
    },
  },
  aggressor: {
    name: 'AGGRESSOR',
    colors: {
      fighter: 0x884444,
      bomber: 0x8a3a3a,
      attack: 0x884030,
      ew: 0x804040,
      gunship: 0x803a30,
      stealth: 0x333028,
      awacs: 0x885040,
    },
  },
  camo: {
    name: 'CAMO',
    colors: {
      fighter: 0x5a6248,
      bomber: 0x4f5538,
      attack: 0x56603a,
      ew: 0x4f5a40,
      gunship: 0x4a4530,
      stealth: 0x2a2a20,
      awacs: 0x555a48,
    },
  },
};

export function paintColor(scheme: string, category: AircraftCategory): number {
  return PAINT_SCHEMES[scheme]?.colors[category] ?? 0x808a96;
}
