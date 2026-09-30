// ============================================================================
// 机型特色表 —— 每类机型的挂载/装填槽/机炮/锁定速度差异 (per user request)
// ============================================================================
// 用户的规则(逐条落到下面的表里):
//   · 攻击机: 对地武器挂载量 = 通用基础量 +30%; 对地冷却槽 2 → 4;
//             空对空瞄准(锁定)速度下降; 机炮伤害/射程/射速大幅提升, 但**机炮自动瞄准速度大幅降低**。
//   · 轰炸机: **部分雷达空对空导弹无法挂载**(只留 MSL/QAAM 这类基础弹);
//             所有空对空武器挂载量 +25%; 所有空对地武器(含投掷类) +55%;
//             空对空冷却槽 = 基础 2 的**两倍**(4); 空对地导弹冷却槽不变(2);
//             **投掷类冷却槽 2 → 6**。
//   · 其它机型(战斗机/隐形机/电子战/预警机/炮艇机): 与改造前逐位一致(全 1.0 / 2 槽)。
//
// 单一真相源: 装填槽数、备弹倍率、机炮倍率、锁定速度倍率都从这里取, 避免散落在
// engine/sp-weapons 里各写一份(以前"轰炸机 4 槽"就是硬编码在 weapon-slots.ts 里的)。

export type AircraftCategory =
  | 'fighter' | 'attack' | 'bomber' | 'gunship' | 'ew' | 'stealth' | 'awacs';

export interface ClassRules {
  /** 对地武器(含投掷类)备弹倍率 */
  a2gAmmoMul: number;
  /** 对空武器备弹倍率 */
  a2aAmmoMul: number;
  /** 对地导弹的独立装填槽数 */
  a2gSlots: number;
  /** 对空武器的独立装填槽数 */
  a2aSlots: number;
  /** 投掷类(BDL/CLB/NKV)的独立装填槽数 */
  bombSlots: number;
  /** 机炮: 伤害 / 射程 / 射速 倍率 */
  gunDmgMul: number;
  gunRangeMul: number;
  gunRofMul: number;
  /** 机炮**自动瞄准**的跟随速度倍率(<1 = 更慢跟上, per user request: 攻击机大幅降低) */
  gunAutoAimRateMul: number;
  /** 锁定(瞄准)速度倍率 */
  lockRateMul: number;
  /** 该机型**不能挂载**的空对空武器(轰炸机: 雷达弹) */
  bannedA2A: string[];
}

const DEFAULT_RULES: ClassRules = {
  a2gAmmoMul: 1, a2aAmmoMul: 1,
  a2gSlots: 2, a2aSlots: 2, bombSlots: 2,
  gunDmgMul: 1, gunRangeMul: 1, gunRofMul: 1, gunAutoAimRateMul: 1,
  lockRateMul: 1,
  bannedA2A: [],
};

export const CLASS_RULES: Record<AircraftCategory, ClassRules> = {
  fighter: { ...DEFAULT_RULES },
  stealth: { ...DEFAULT_RULES },
  ew: { ...DEFAULT_RULES },
  awacs: { ...DEFAULT_RULES },
  gunship: { ...DEFAULT_RULES },
  // === 攻击机: 对地强化 + 机炮重火力, 但空对空瞄准慢、机炮自动瞄准更慢 (per user request) ===
  attack: {
    ...DEFAULT_RULES,
    a2gAmmoMul: 1.3,          // 对地挂载量 +30%
    a2gSlots: 4,              // 对地冷却槽 2 → 4
    gunDmgMul: 2.2,           // 机炮伤害大幅提升
    gunRangeMul: 1.6,         // 射程大幅提升
    gunRofMul: 1.5,           // 射速大幅提升
    gunAutoAimRateMul: 0.3,   // 自动瞄准速度大幅降低(只有基础的 30%)
    lockRateMul: 0.55,        // 空对空瞄准速度下降
  },
  // === 轰炸机: 空对空减配但量多、对地/投掷类翻量、槽多 (per user request) ===
  bomber: {
    ...DEFAULT_RULES,
    a2aAmmoMul: 1.25,         // 所有空对空挂载量 +25%
    a2gAmmoMul: 1.55,         // 所有空对地(含投掷类) +55%
    a2aSlots: 4,              // 空对空冷却槽 = 基础 2 的两倍
    a2gSlots: 2,              // 空对地导弹冷却槽不变
    bombSlots: 6,             // 投掷类冷却槽 2 → 6
    lockRateMul: 0.8,         // 大机体雷达反应略慢
    bannedA2A: ['LAAM', 'SARH'],   // 雷达制导空对空弹不可挂载(只留 MSL/QAAM/4AAM)
  },
};

export function classRules(cat: string | undefined): ClassRules {
  return CLASS_RULES[(cat ?? 'fighter') as AircraftCategory] ?? DEFAULT_RULES;
}

/** 对地武器(含投掷类)。 */
const A2G = new Set(['LASM', 'BDL', 'CLB', 'NKV', '4AGM']);
/** 对空武器。 */
const A2A = new Set(['MSL', 'LAAM', 'QAAM', 'SARH', '4AAM', 'HVG']);
/** 投掷类(自由落体/集束/核弹)。 */
const BOMB = new Set(['BDL', 'CLB', 'NKV']);

export const isA2GWeapon = (w: string): boolean => A2G.has(w);
export const isA2AWeapon = (w: string): boolean => A2A.has(w);
export const isBombWeapon = (w: string): boolean => BOMB.has(w);

/** 该机型上, 这个武器有几个独立装填槽(见 CLASS_RULES 的表头说明)。 */
export function slotCountForWeapon(weapon: string, cat: string | undefined): number {
  const r = classRules(cat);
  if (isBombWeapon(weapon)) return r.bombSlots;
  if (isA2GWeapon(weapon)) return r.a2gSlots;
  if (isA2AWeapon(weapon)) return r.a2aSlots;
  return 2;
}

/** 该机型上, 这个武器的备弹倍率。 */
export function ammoMulForWeapon(weapon: string, cat: string | undefined): number {
  const r = classRules(cat);
  if (isA2GWeapon(weapon)) return r.a2gAmmoMul;
  if (isA2AWeapon(weapon)) return r.a2aAmmoMul;
  return 1;
}

/** 该机型能否挂载这个空对空武器(轰炸机禁雷达弹, per user request)。 */
export function canMountWeapon(weapon: string, cat: string | undefined): boolean {
  return !classRules(cat).bannedA2A.includes(weapon);
}
