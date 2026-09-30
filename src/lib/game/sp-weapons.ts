// === SP Weapons catalog (per user request: 参考皇牌空战推出多款sp武器) ===
// Each SP weapon has distinct pros/cons — the player picks ONE in the
// briefing screen to mount on their aircraft for the mission. The catalog
// is consumed by:
//   - Menus.tsx (Briefing) — renders the picker UI
//   - engine.ts (resetState) — bumps the selected weapon's count into weapons_state
//   - engine.ts (fireMissile / dropBomb) — routes the fire command to the
//     right code path with the right stats (range, damage, guidance)
//   - Hud.tsx — renders the lock-on indicator type (ir / radar / none)
//
// Design notes (Ace Combat inspired):
//   - LAAM (Long-range Air-to-Air Missile): Phoenix-class. Pros: very long
//     range (8km), high damage (200). Cons: slow turn rate (can miss agile
//     fighters), low ammo (8). Lock type: radar.
//   - QAAM (Quick-maneuvering AAM): Pros: extreme agility (curves hard to
//     follow jinking bandits), high steer rate. Cons: short range (3km),
//     low damage (80), low ammo (12). Lock type: ir.
//   - SARH (Semi-Active Radar Homing): Sparrow-class. Pros: medium range
//     (6km), medium damage (150). Cons: requires the player to MAINTAIN
//     lock until impact (lockProgress decays fast if the target leaves
//     the funnel). Lock type: radar.
//   - HVG (Hypervelocity Gun pod): Pros: high fire rate (25 rps), high
//     damage per shot (15), long effective range (1.5km). Cons: limited
//     ammo (400 rounds), no lock-on required (gun-style). Lock type: none.
//   - CLB (Cluster Bomb): Pros: wide area damage (60m radius), high total
//     damage. Cons: unguided, only useful against ground targets, low
//     ammo (10). Lock type: none.

import type { WeaponType } from './types';

export interface SPWeaponSpec {
  type: WeaponType;            // 'LAAM' | 'QAAM' | 'SARH' | 'HVG' | 'CLB'
  code: string;                // short HUD code (e.g. 'LAAM')
  name: string;                // full name
  // === Stats ===
  range: number;               // max engagement range (meters)
  damage: number;              // damage on direct hit
  agility: number;             // 0..1 — higher = tighter turn (for missiles)
  speed: number;               // missile cruise speed (m/s) — 0 for gun/bomb
  ammo: number;
  /** 多目标同时锁定的目标数上限(4AAM/4AGM = 4)。 */
  multiLock?: number;                // default ammo count when selected
  lockType: 'ir' | 'radar' | 'none';
  // === UI metadata ===
  pros: string;                // short pros description (shown in briefing)
  cons: string;                // short cons description
  aceCombatName: string;       // flavour: the real AC weapon it's inspired by
  color: string;               // hex color for HUD/briefing accent
}

// === Main weapon catalog (per user request: sp和主武器在关卡开始前自己选四个) ===
// Main weapons are the standard missiles/bombs/flares that every fighter
// carries. They're cheaper and more plentiful than SP weapons, but less
// specialized. The player picks 4 weapons total (mix of main + SP) in the
// briefing screen — those 4 become the cycle-able loadout for the mission.
export interface MainWeaponSpec {
  type: WeaponType;            // 'MSL' | 'LASM' | 'BDL' | 'FLR'
  code: string;
  name: string;
  ammo: number;                // default ammo count when selected
  pros: string;
  cons: string;
  color: string;
}

export const MAIN_WEAPONS: MainWeaponSpec[] = [
  {
    type: 'MSL',
    code: 'MSL',
    name: '标准空空导弹',
    // === Per user request: 普通导弹就有130多发区间 ===
    // Was 60 — bumped to 140 so the player has plenty of standard missiles
    // for sustained combat across a long mission.
    ammo: 140,
    pros: '通用红外制导，射程/威力/机动均衡',
    cons: '无专长——特定领域被SP武器超越',
    color: '#9dffb0',
  },
  {
    type: 'LASM',
    code: 'LASM',
    name: '对地/反舰导弹',
    // === Bumped to 80 so the player can saturate ground/naval targets ===
    ammo: 80,
    pros: '反舰/对地，大弹头，射程远',
    cons: '对战斗机机动差，比MSL慢',
    color: '#ffcc44',
  },
  {
    type: 'BDL',
    code: 'BDL',
    name: '自由落体航弹',
    // === Bumped to 50 for proper bombing runs ===
    ammo: 50,
    pros: '爆炸范围大（60m 伤害半径，已翻倍），无需锁定，量大',
    cons: '无制导——需俯冲投弹，仅对地；伤害半径 60m',
    color: '#a8a8a8',
  },
  {
    type: 'FLR',
    code: 'FLR',
    name: '热焰弹',
    ammo: 120,
    pros: '对抗措施——摆脱红外导弹锁定',
    cons: '数量有限，只能对抗红外导弹（雷达弹无效）',
    color: '#ffaa66',
  },
];

// Catalog — array form so the Briefing can iterate it for the picker.
export const SP_WEAPONS: SPWeaponSpec[] = [
  {
    type: 'LAAM',
    code: 'LAAM',
    name: '远程空空导弹',
    range: 8000,
    damage: 200,
    agility: 0.25,   // low agility — slow turn
    speed: 540,
    // === Per user request: sp武器有60多发 ===
    // Was 8 — bumped to 60 so the player can use their SP weapon liberally
    // across a long mission. LAAM's low agility + long range still keeps
    // each shot from being a guaranteed kill (agile fighters can dodge).
    ammo: 60,
    lockType: 'radar',
    pros: '超远射程（8km），高伤害（200），对战斗机一击必杀',
    cons: '转弯慢——易被敏捷战斗机躲开',
    aceCombatName: '灵感来自 XLAA / AIM-54 不死鸟',
    color: '#ff8a4a',
  },
  {
    type: 'QAAM',
    code: 'QAAM',
    name: '高机动空空导弹',
    range: 4000,   // 仅比MSL远500m (per user request)
    damage: 160,
    agility: 0.95,   // extreme agility — curves hard
    speed: 460,
    // === Bumped to 60 — QAAM's short range means many shots at close range ===
    ammo: 60,
    lockType: 'ir',
    pros: '极限机动（急转咬住蛇形敌机），难以规避',
    cons: '射程短（4km），伤害中等（160）',
    aceCombatName: '灵感来自 QAAM（皇牌空战招牌武器）',
    color: '#ff5a5a',
  },
  {
    type: 'SARH',
    code: 'SARH',
    name: '半主动雷达空空导弹',
    range: 6000,
    damage: 150,
    agility: 0.55,
    speed: 500,
    // === Bumped to 60 ===
    ammo: 60,
    lockType: 'radar',
    pros: '中等射程（6km），中等伤害（150），全能型',
    cons: '需持续保持锁定——目标脱离锥形区即丢失',
    aceCombatName: '灵感来自 SAAM / AIM-7 麻雀',
    color: '#ffd14a',
  },
  // === VASM 现实雷达弹 (per user request) ===
  // The ONLY missile with the realistic flight model: 7km radar lock,
  // proportional-navigation guidance, powered boost phase then inertia
  // coast, air drag + maneuver bleed draining energy, and it falls when
  // energy runs out. Long range, radar lock maintenance like SARH.
  {
    type: 'VASM',
    code: 'VASM',
    name: '现实雷达制导导弹',
    range: 7000,
    damage: 180,
    agility: 0.7,
    speed: 950,
    ammo: 24,
    lockType: 'radar',
    pros: '7km 锁定 · 比例导引 · 动力段+滑行的真实能量模型，命中率高',
    cons: '滑行段减速、急转耗能，射程末端能量不足会坠落；需持续保持锁定',
    aceCombatName: '现实导弹：动力段加速·惯性滑行·空气阻力·能量耗尽坠落',
    color: '#ffb070',
  },
  {
    type: 'HVG',
    code: 'HVG',
    name: '超高速机炮吊舱',
    range: 1500,
    damage: 18,
    agility: 0,
    speed: 0,        // gun — no missile body
    // === Bumped to 800 — high rate of fire chews through ammo fast ===
    ammo: 800,
    lockType: 'none',
    pros: '高射速（25发/秒），单发伤害高（18），无需锁定',
    cons: '射程短（1.5km），只有直射（无溅射）',
    aceCombatName: '灵感来自 EML / 机炮吊舱',
    color: '#9dffb0',
  },
  {
    type: 'CLB',
    code: 'CLB',
    name: '集束炸弹',
    range: 0,        // unguided
    damage: 300,     // per sub-munition (per user request: 爆炸和伤害范围都挺高)
    agility: 0,
    speed: 0,        // bomb
    // === Few rounds (per user request: CLB数量少) ===
    ammo: 24,
    lockType: 'none',
    pros: '超级反舰航弹：爆炸范围大（150m 伤害/散布半径，已翻倍），伤害极高',
    cons: '无制导，仅对地/对舰',
    aceCombatName: '灵感来自 SOD / 集束炸弹',
    color: '#ffcc44',
  },
  // === NKV 战术核弹 (per user request: 新武器·仅玩家·12发·3km爆炸) ===
  {
    type: 'NKV',
    code: 'NKV',
    name: '战术核弹',
    range: 0,        // 直飞空爆
    damage: 99999,   // 3km 内秒杀
    agility: 0,
    speed: 400,
    ammo: 12,
    lockType: 'none',
    pros: '战术核弹：3km 爆炸范围，范围内敌方单位瞬间消灭',
    cons: '数量极少（12 发），注意与友军保持距离',
    aceCombatName: '灵感来自战术核航弹',
    color: '#ff8844',
  },
  // === 4AAM / 4AGM: 多目标同时锁定 (per user request) ===
  {
    type: '4AAM',
    code: '4AAM',
    name: '四联空对空导弹',
    range: 6000,
    damage: 90,
    agility: 3.4,
    speed: 620,
    // === 挂载量翻倍 (per user request: 4AAM/4AGM 的挂载量) ====================
    // 12 -> 24: 4 目标齐射从 3 轮变成 6 轮, 大编队/多挂点目标才够用。
    ammo: 24,
    lockType: 'radar',
    multiLock: 4,
    pros: '一次可同时锁定最多 4 个空中目标，齐射覆盖编队',
    cons: '单发伤害低于 MSL；锁定需要逐个建立（雷达弹）',
    aceCombatName: '灵感来自 XMAA / 4AAM',
    color: '#66ddff',
  },
  {
    type: '4AGM',
    code: '4AGM',
    name: '四联空对地导弹',
    range: 6000,
    damage: 150,
    agility: 3.0,
    speed: 560,
    ammo: 12,
    lockType: 'ir',
    multiLock: 4,
    pros: '一次同时锁定最多 4 个地面/海面目标；攻顶弹道（飞到目标上空再垂直俯冲），150m 级爆炸',
    cons: '只打地面/海面；单发伤害低于 LASM',
    aceCombatName: '灵感来自 4AGM',
    color: '#ffbb55',
  },
  // === 激光发射器: 与地面激光防空炮同款的挂载版 (per user request) ===
  {
    type: 'LASER',
    code: 'LASER',
    name: '激光发射器',
    range: 4000,
    damage: 26,        // 每跳伤害(0.25s 一跳)
    agility: 0,
    speed: 4000,       // 光速(命中判定为直射)
    ammo: 300,         // 按"跳"计量
    lockType: 'none',
    pros: '光速直射、几乎无下坠，高射速持续输出；对地与对空通用',
    cons: '需要持续照射同一目标才有效；高热、耗弹快',
    aceCombatName: '同款地面激光防空炮的挂载版',
    color: '#88ffcc',
  },
];

// Helper — get the spec for a given SP weapon type (or null if not an SP weapon).
export function getSPWeaponSpec(type: WeaponType): SPWeaponSpec | null {
  return SP_WEAPONS.find((s) => s.type === type) ?? null;
}

// Helper — get the spec for a given main weapon type (or null).
export function getMainWeaponSpec(type: WeaponType): MainWeaponSpec | null {
  return MAIN_WEAPONS.find((s) => s.type === type) ?? null;
}

// Helper — get the ammo count for any weapon type (main or SP).
export function getWeaponAmmo(type: WeaponType): number {
  const sp = getSPWeaponSpec(type);
  if (sp) return sp.ammo;
  const main = getMainWeaponSpec(type);
  if (main) return main.ammo;
  return 0;
}

// Helper — get the display name + color for any weapon type.
export function getWeaponDisplay(type: WeaponType): { code: string; name: string; color: string; pros: string; cons: string } {
  const sp = getSPWeaponSpec(type);
  if (sp) {
    return {
      code: sp.code,
      name: sp.name,
      color: sp.color,
      pros: sp.pros,
      cons: sp.cons,
    };
  }
  const main = getMainWeaponSpec(type);
  if (main) {
    return {
      code: main.code,
      name: main.name,
      color: main.color,
      pros: main.pros,
      cons: main.cons,
    };
  }
  return { code: '???', name: '未知', color: '#ffffff', pros: '', cons: '' };
}

// localStorage key for the player's selected SP weapon. 'none' = no SP weapon
// (just the standard loadout).
export const SP_WEAPON_KEY = 'skybound.spWeapon';

// === 4-slot loadout system (per user request: sp和主武器在关卡开始前自己选四个) ===
// The player picks 4 weapons total — a mix of main + SP weapons. The 4
// selected weapons become the cycle-able loadout for the mission. The GUN
// is always available (not part of the 4 slots) for fighters.
//
// localStorage key: 'skybound.loadout' = JSON array of 4 WeaponType entries.
// Example: '["MSL","LASM","QAAM","CLB"]'
//
// If the loadout is missing or invalid, we fall back to the aircraft's
// default loadout (mission-driven via spec.category).
export const LOADOUT_KEY = 'skybound.loadout';
export const LOADOUT_SLOTS = 4;

// All weapons available for loadout selection (main + SP, in display order).
// FLR is included so the player can choose to carry extra flares.
export const ALL_LOADABLE_WEAPONS: WeaponType[] = [
  // Main weapons first
  'MSL', 'LASM', 'BDL', 'FLR', 'NKV',
  // SP weapons
  'LAAM', 'QAAM', 'SARH', 'VASM', 'HVG', 'CLB',
  // === 新武器 (per user request: 挂载槽位里要能看到 4AAM/4AGM/LASER) ===
  // 之前只加进了 SP_WEAPONS 规格表, 而'可挂载清单'是另一份列表 → 选择器里看不到它们。
  '4AAM', '4AGM', 'LASER',
];

// Default loadout by aircraft category — used when the player hasn't
// customized their loadout yet, or when their saved loadout is invalid.
export function defaultLoadoutForCategory(category: string): WeaponType[] {
  switch (category) {
    case 'fighter':
      return ['MSL', 'LASM', 'FLR', 'QAAM'];
    case 'attack':
      return ['LASM', 'BDL', 'FLR', 'CLB'];
    case 'bomber':
      return ['BDL', 'BDL', 'FLR', 'LASM'];
    case 'stealth':
      return ['MSL', 'LASM', 'BDL', 'FLR'];
    case 'ew':
      return ['MSL', 'FLR', 'FLR', 'QAAM'];
    case 'gunship':
      return ['BDL', 'LASM', 'FLR', 'CLB'];
    case 'awacs':
      return ['MSL', 'FLR', 'FLR', 'FLR'];
    default:
      return ['MSL', 'LASM', 'FLR', 'QAAM'];
  }
}

// Read the player's 4-slot loadout from localStorage. Returns the saved
// loadout if valid (4 entries, all loadable weapon types), or null if
// missing/invalid — caller should fall back to defaultLoadoutForCategory.
export function readLoadout(): WeaponType[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(LOADOUT_KEY);
    if (!v) return null;
    const parsed = JSON.parse(v) as unknown;
    if (!Array.isArray(parsed)) return null;
    if (parsed.length !== LOADOUT_SLOTS) return null;
    const valid = parsed.every(
      (w) => typeof w === 'string' && ALL_LOADABLE_WEAPONS.includes(w as WeaponType),
    );
    if (!valid) return null;
    return parsed as WeaponType[];
  } catch {
    return null;
  }
}

export function writeLoadout(loadout: WeaponType[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LOADOUT_KEY, JSON.stringify(loadout));
  } catch {
    // ignore
  }
}

// Read the player's SP weapon selection from localStorage. Returns 'none' if
// no selection (or invalid value).
// === Kept for backwards-compat — the new 4-slot loadout supersedes this, ===
// but the old single-SP-weapon picker still works as a fallback.
export function readSPWeaponSelection(): WeaponType | 'none' {
  if (typeof window === 'undefined') return 'none';
  try {
    const v = window.localStorage.getItem(SP_WEAPON_KEY);
    if (!v) return 'none';
    if (v === 'none') return 'none';
    const valid = SP_WEAPONS.find((s) => s.type === v);
    return valid ? (v as WeaponType) : 'none';
  } catch {
    return 'none';
  }
}

export function writeSPWeaponSelection(sp: WeaponType | 'none') {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SP_WEAPON_KEY, sp);
  } catch {
    // ignore
  }
}
