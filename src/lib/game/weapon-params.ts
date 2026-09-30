/**
 * === §339 导弹参数表 (AC7AH 式数据驱动) ======================================
 *
 * 来源: Ace Combat: Assault Horizon 的明文配置 `ArmsParam.txt`(玩家, 707 项)
 * 与 `ArmsParam_Npc.txt`(敌方, 179 项)。字段名**沿用原作**以便对照:
 *   action.speedInit / speedMax / accele / noAcceleTime / endTime / noHomingTime
 *   action.hormingAng / hormingAngHi / hormingAngLow      (导引头视场角, 度)
 *   action.rotAngMax  / rotAngMaxHi  / rotAngMaxLow       (最大角速率, 度/秒)
 *   action.gravity / gravitydecay                        (重力与衰减)
 *   hit.power / lengthStart / lengthEnd / thickness / explosionRadius
 *   lockon.lockonNum / selectNum / range / angle / reload
 *
 * [!] 两个必须知道的翻译决定(否则会抄错):
 *   1) **角度/角速率/时间/几何与尺度无关 ⇒ 照抄**; 但 `speedMax`(原作 4500)与
 *      `power`/半径是**原作单位**下的数 —— 我们用自己的一套(上限 950, 世界标度
 *      0.382)。所以表里的速度/伤害存**我们的值**, 只有角度类字段与原作同值。
 *   2) 原作里 `rotAngMaxHi/Low = 0` 或 `hormingAngHi/Low = 0` 表示**该档未启用**,
 *      用普通的 `rotAngMax` / `hormingAng`。`effectiveTurnRate()` 里就是这个规则。
 *
 * 两档切换点(高速档/低速档按什么阈值切)**不在配置里**(在原作代码里), 属于我们的
 * 可调选择: 默认 `hiK = 0.55`、`loK = 0.30`(即速度 > 55% speedMax 用 Hi 档,
 * < 30% 用 Low 档, 中间线性过渡)。键: `skybound.wp.hiK` / `skybound.wp.loK`。
 *
 * 所有字段都能用控制台 `wpn <弹种>.<字段> <值>` 现场改(见 weapon-knobs.ts),
 * 改完立刻推送在飞的导弹(参数对象带版本号, 见 bumpWeaponParams())。
 */
import { readTuning } from './tuning';

/** 弹种键: 玩家侧按武器类型, 敌方侧按原作 NPC_* 分类 */
export type MissileParamKey =
  | 'MSL' | 'LASM' | 'QAAM' | 'LAAM' | 'SARH' | 'VASM' | 'FOUR_AAM' | 'FOUR_AGM'
  | 'BDL' | 'CLB' | 'HVG' | 'NKV' | 'LASER'
  | 'NPC_MSL' | 'NPC_GROUND' | 'NPC_VLS';

export interface MissileParams {
  // --- 飞行(action) ---
  /** 发射初速(米/秒, 世界空间; 0 = 用载机速度) */
  speedInit: number;
  /** 速度上限 */
  speedMax: number;
  /** 加速度 (米/秒²) */
  accele: number;
  /** 发射后先滑行多久才点火(秒; 原作 SAAM/4AAM = 0.4) */
  noAcceleTime: number;
  /** 寿命(秒) */
  endTime: number;
  /** 发射后多久开始制导(秒; 原作 4AGM 0.2 / LAGM 0.6) */
  noHomingTime: number;
  /** 导引头视场角(度) —— 捕获/再捕获必须落在这个锥内(相对弹体速度方向) */
  hormingAng: number;
  hormingAngHi: number;
  hormingAngLow: number;
  /** 最大角速率(度/秒): 通用 / 高速档 / 低速档 */
  rotAngMax: number;
  rotAngMaxHi: number;
  rotAngMaxLow: number;
  /** 重力加速度与衰减(原作 9.8 / 1.0; NPC 1.5) */
  gravity: number;
  gravitydecay: number;
  // --- 导引律 ---
  /** 'pursuit' = 提前点追踪(我们原来的做法); 'pn' = 比例导引(原作 VASM 那套) */
  guidance: 'pursuit' | 'pn';
  /** PN 增益 N(原作 VASM = 4.2) */
  pnGain: number;
  /** 追踪噪声(0..0.2; 越大越容易被打偏) */
  wobble: number;
  /** 转向耗能系数(诱导阻力): 速度 -= 转角(rad) * 本系数(米/秒) */
  turnEnergyK: number;
  // --- 命中(hit) ---
  /** 战斗部威力(我们自己的伤害口径) */
  power: number;
  /** 命中胶囊: 沿弹轴的前/后端(local 单位, Start>End; 原作 MSL = 1 / -1) */
  lengthStart: number;
  lengthEnd: number;
  /** 胶囊半径(原作 MSL = 1; NPC = 5) */
  thickness: number;
  /** 近炸半径(原作 LAGM 60 / 4AGM 0); 0 = 无近炸 */
  explosionRadius: number;
  /** 直击伤害倍率(原作 MISSILE_COMMON.directShootPowerRate = 3.0) */
  directShootPowerRate: number;
  /** 目标包围球半径(原作 MISSILE_COMMON.hit.boundingShpereSize = 5) */
  targetBound: number;
  /** 擦过目标后切断制导的距离阈值(原作 missMissileHomingCutDist = 50) */
  missHomingCutDist: number;
  // --- 锁定(lockon) ---
  /** 可同时锁定数(1 = 单目标; 4 = 四连) */
  lockonNum: number;
  /** 可选目标数(雷达可切换的候选上限) */
  selectNum: number;
  /** 锁定距离(米) */
  range: number;
  /** 锁定锥角(度) */
  angle: number;
  /** 冷却(秒; 我们另外有双槽装填, 这里作为参考/备用) */
  reload: number;
  // --- 我们的扩展 ---
  /** 抗干扰: 被干扰弹欺骗的概率(0..1; 原作没有直接对应字段, 按 effectiveTime 反推) */
  flareSuscept: number;
  /** 是否允许无锁定发射(全部 true; 无锁定时该弹不制导) */
  canFireUnguided: boolean;
}

/** 原作的"某档为 0 = 未启用"规则 */
export function effectiveTurnRate(p: MissileParams, speed: number): number {
  const hi = p.rotAngMaxHi > 0 ? p.rotAngMaxHi : p.rotAngMax;
  const lo = p.rotAngMaxLow > 0 ? p.rotAngMaxLow : p.rotAngMax;
  if (hi === lo) return hi;
  const f = speed / Math.max(1, p.speedMax);
  const hiK = readTuning('skybound.wp.hiK', 0.55, 0.05, 0.95);
  const loK = readTuning('skybound.wp.loK', 0.30, 0.0, 0.9);
  if (f >= hiK) return hi;
  if (f <= loK) return lo;
  const t = (f - loK) / Math.max(1e-4, hiK - loK);
  return lo + (hi - lo) * t;                      // 中间线性过渡
}
export function effectiveSightFov(p: MissileParams, speed: number): number {
  const hi = p.hormingAngHi > 0 ? p.hormingAngHi : p.hormingAng;
  const lo = p.hormingAngLow > 0 ? p.hormingAngLow : p.hormingAng;
  if (hi === lo) return hi;
  const f = speed / Math.max(1, p.speedMax);
  return f > 0.5 ? hi : lo;                       // 视场也分两档(原作 hormingAngHi/Low)
}

/** 全表默认(表里没写的弹种用它) */
export const MISSILE_PARAMS_DEFAULT: MissileParams = {
  speedInit: 600, speedMax: 950, accele: 420, noAcceleTime: 0, endTime: 24, noHomingTime: 0,
  hormingAng: 60, hormingAngHi: 0, hormingAngLow: 0,
  rotAngMax: 180, rotAngMaxHi: 0, rotAngMaxLow: 0,
  gravity: 9.8, gravitydecay: 1.0,
  guidance: 'pursuit', pnGain: 4.2, wobble: 0, turnEnergyK: 8,
  power: 120, lengthStart: 1, lengthEnd: -1, thickness: 1,
  explosionRadius: 0, directShootPowerRate: 1.0, targetBound: 5, missHomingCutDist: 50,
  lockonNum: 1, selectNum: 6, range: 3500, angle: 60, reload: 5,
  flareSuscept: 0.9, canFireUnguided: true,
};

/**
 * 表本体。速度/伤害/半径 = 我们的口径; 角度/角速率/时间/胶囊 = 原作值。
 * 对照见每条的 `/* 原作 ... *​/` 注释。
 */
export const MISSILE_PARAMS: Record<MissileParamKey, MissileParams> = {
  // 原作 .MISSILE: 800→4500, accele 850, endTime 9, hormingAng 120, rotAngMax 40 / Hi 360 / Low 120,
  //   power 40, 胶囊 1/-1/1, range 2000, angle 60, reload 5
  MSL: {
    ...MISSILE_PARAMS_DEFAULT,
    speedInit: 600, speedMax: 950, accele: 420, endTime: 24,
    hormingAng: 120, rotAngMax: 40, rotAngMaxHi: 360, rotAngMaxLow: 120,
    wobble: 0, turnEnergyK: 8,
    power: 120, lengthStart: 1, lengthEnd: -1, thickness: 1,
    range: 3500, angle: 60, reload: 5, flareSuscept: 0.9,
  },
  // 原作 .LAGM(近似对舰/远程): 0→4500 accele 1500, noAcceleTime 0.4, endTime 15,
  //   noHomingTime 0.6, rotAngMax 180, explosionRadius 60, range 6000, reload 8
  LASM: {
    ...MISSILE_PARAMS_DEFAULT,
    speedInit: 560, speedMax: 1080, accele: 420, noAcceleTime: 0.4, endTime: 32, noHomingTime: 0.6,
    hormingAng: 120, rotAngMax: 180, rotAngMaxHi: 0, rotAngMaxLow: 0,
    power: 180, lengthStart: 1, lengthEnd: -1, thickness: 1, explosionRadius: 60,
    range: 5000, angle: 60, reload: 8, turnEnergyK: 6,
  },
  // 原作 .QAAM: 1600→4500 accele 600, rotAngMax 60 / Hi 360 / Low 120, power 80, range 2500, reload 6
  QAAM: {
    ...MISSILE_PARAMS_DEFAULT,
    speedInit: 620, speedMax: 980, accele: 500, endTime: 24,
    hormingAng: 120, rotAngMax: 60, rotAngMaxHi: 360, rotAngMaxLow: 120,
    turnEnergyK: 7, power: 150, range: 4000, angle: 60, reload: 6,
    wobble: 0, flareSuscept: 0.85,
  },
  // 原作 .SAAM: 0→6000 accele 1400, noAcceleTime 0.4, endTime 12, rotAngMax 0 / Hi 120 / Low 40,
  //   power 80, range 8000, angle 60, reload 8 (半主动: 需持续照射 ⇒ 我们靠 wobble + 视场表达)
  LAAM: {
    ...MISSILE_PARAMS_DEFAULT,
    speedInit: 0, speedMax: 1250, accele: 900, noAcceleTime: 0.4, endTime: 26,
    hormingAng: 120, rotAngMax: 0, rotAngMaxHi: 120, rotAngMaxLow: 40,
    power: 200, range: 8000, angle: 60, reload: 8,
    wobble: 0.04, turnEnergyK: 10, flareSuscept: 0.6,
  },
  // 原作 .AAM(基础弹): 1600→4500 accele 600, rotAngMax 40, power 60, range 3500, reload 6
  //   ⇒ 我们用 SARH 表达"半主动中距弹": 视场小、机动一般、必须保持锁定
  SARH: {
    ...MISSILE_PARAMS_DEFAULT,
    speedInit: 600, speedMax: 1000, accele: 450, endTime: 26,
    hormingAng: 60, rotAngMax: 40, rotAngMaxHi: 200, rotAngMaxLow: 60,
    power: 170, range: 6000, angle: 45, reload: 6,
    wobble: 0.02, turnEnergyK: 9, flareSuscept: 0.5,
  },
  // 原作 .ADMM: 0→6000 accele 1400, noHomingTime 0.2, hormingAng 175(!), rotAngMax 60 / Hi 90,
  //   power 20, lockonNum 12, range 6000
  VASM: {
    ...MISSILE_PARAMS_DEFAULT,
    speedInit: 600, speedMax: 1150, accele: 500, noHomingTime: 0.2, endTime: 30,
    hormingAng: 175, rotAngMax: 60, rotAngMaxHi: 90, rotAngMaxLow: 60,
    guidance: 'pn', pnGain: 4.2,
    power: 140, lengthStart: 1, lengthEnd: -1, thickness: 1, explosionRadius: 60,
    range: 7000, angle: 60, reload: 7, turnEnergyK: 12, flareSuscept: 0.4,
  },
  // 原作 ._4AAM: 0→4800 accele 1400, noAcceleTime 0.4, rotAngMax 45 / Hi 90, power 80,
  //   lockonNum 4, range 4000, reload 8
  FOUR_AAM: {
    ...MISSILE_PARAMS_DEFAULT,
    speedInit: 0, speedMax: 1000, accele: 900, noAcceleTime: 0.4, endTime: 24,
    hormingAng: 120, rotAngMax: 45, rotAngMaxHi: 90, rotAngMaxLow: 45,
    power: 150, lockonNum: 4, selectNum: 6, range: 6000, angle: 60, reload: 8,
    turnEnergyK: 10,
  },
  // 原作 ._4AGM: 1000→3500 accele 1000, noHomingTime 0.2, rotAngMax 180,
  //   对地: gndHeightOffset 70 / gndDropDistance 300, power 40, lockonNum 4, range 3000
  FOUR_AGM: {
    ...MISSILE_PARAMS_DEFAULT,
    speedInit: 600, speedMax: 900, accele: 600, noHomingTime: 0.2, endTime: 24,
    hormingAng: 120, rotAngMax: 180, rotAngMaxHi: 0, rotAngMaxLow: 0,
    guidance: 'pn', pnGain: 3.5, lockonNum: 4, selectNum: 6, range: 6000, angle: 60, reload: 8,
    power: 180, turnEnergyK: 6,
  },
  // 原作 .UGB(无制导炸弹): speedInit 1200, gravity 80, power 80, hitRadius 80 ⇒ 我们 BDL 走既有物理
  BDL: {
    ...MISSILE_PARAMS_DEFAULT,
    speedInit: 0, speedMax: 0, accele: 0, endTime: 12,
    gravity: 60, gravitydecay: 0, power: 220, range: 0, reload: 0,
    canFireUnguided: true,
  },
  // 原作 .BDM.Missile(子母弹): num 16 / interval 0.05 / startDist 200 ⇒ 我们 CLB 走既有物理
  CLB: {
    ...MISSILE_PARAMS_DEFAULT,
    speedInit: 0, speedMax: 0, accele: 0, endTime: 12,
    gravity: 60, gravitydecay: 0, power: 300, range: 0, reload: 0,
  },
  // 原作 .EML(电磁炮): speedInit 40000(!), dispersion 0.02, length 10, power 80 ⇒ 我们 HVG 用高速直射
  HVG: {
    ...MISSILE_PARAMS_DEFAULT,
    speedInit: 2100, speedMax: 2100, accele: 0, endTime: 2.5,
    gravity: 0, gravitydecay: 0, power: 36, range: 0, reload: 0,
  },
  // 战术核弹(原作没有对应条目): 保留我们原有的行为, 但字段化便于调
  NKV: {
    ...MISSILE_PARAMS_DEFAULT,
    speedInit: 600, speedMax: 1100, accele: 420, endTime: 30,
    hormingAng: 120, rotAngMax: 90, rotAngMaxHi: 200, rotAngMaxLow: 90,
    gravity: 0, power: 0, range: 6000, reload: 10, flareSuscept: 0.3,
  },
  LASER: { ...MISSILE_PARAMS_DEFAULT, speedInit: 0, speedMax: 0, accele: 0, power: 0 },
  // === 敌方(原作 NPC_*) —— 关键的"不对称" ==================================
  // NPC_MISSILE: accele 800, hormingAng 60 / Hi 200 / Low 30, rotAngMaxHi 200 / **Low 3**,
  //   gravitydecay 1.5, 胶囊 **0/10/5**(又长又粗 ⇒ 更粘人)
  //   ⇒ 设计意图: 判定宽松保证有威胁, 但低速档几乎不能转向 ⇒ 逼它掉速就能甩掉。
  NPC_MSL: {
    ...MISSILE_PARAMS_DEFAULT,
    speedInit: 280, speedMax: 880, accele: 420, endTime: 16, noHomingTime: 0,
    hormingAng: 60, hormingAngHi: 200, hormingAngLow: 30,
    rotAngMax: 60, rotAngMaxHi: 200, rotAngMaxLow: 3,
    gravity: 9.8, gravitydecay: 1.5,
    wobble: 0.12, turnEnergyK: 10,
    power: 120, lengthStart: 0, lengthEnd: 10, thickness: 5,
    directShootPowerRate: 1.0, targetBound: 8, missHomingCutDist: 50,
    lockonNum: 1, selectNum: 6, range: 4000, angle: 60, reload: 5, flareSuscept: 0.75,
  },
  // NPC_MISSILE_GROUND / NPC_VLS: 胶囊 10/5/6.5(更宽松), 重力衰减 1.5
  NPC_GROUND: {
    ...MISSILE_PARAMS_DEFAULT,
    speedInit: 280, speedMax: 800, accele: 400, endTime: 16,
    hormingAng: 60, rotAngMax: 60, rotAngMaxHi: 150, rotAngMaxLow: 3,
    gravity: 9.8, gravitydecay: 1.5, wobble: 0.1,
    power: 110, lengthStart: 10, lengthEnd: 5, thickness: 6.5, targetBound: 8,
    range: 4000, angle: 60, reload: 6, flareSuscept: 0.8,
  },
  // NPC_HSAM / NPC_SAM_*: 慢速防空弹, rotAngMax 15(不能大机动), 胶囊 10/5/6.5
  NPC_VLS: {
    ...MISSILE_PARAMS_DEFAULT,
    speedInit: 280, speedMax: 750, accele: 380, endTime: 14,
    hormingAng: 60, rotAngMax: 15, rotAngMaxHi: 15, rotAngMaxLow: 15,
    gravity: 9.8, gravitydecay: 1.5, wobble: 0.08,
    power: 100, lengthStart: 10, lengthEnd: 5, thickness: 6.5, targetBound: 8,
    range: 3500, angle: 60, reload: 6, flareSuscept: 0.8,
  },
};

/**
 * === 导弹全局项(原作 ArmsParam.txt 的 .MISSILE_COMMON.*) ======================
 * 这些不是"某个弹种"的参数, 而是**所有导弹共用**的演出/判定参数:
 *   finishBlow*  擦过目标后的"终结爆炸": 距离窗口 200~750m, 演出时长 2~3s;
 *                另有 finishBlowNormalMissileDist 60(普通弹的近界)
 *   missMissileLeadOffset/Radius 20  脱靶弹的"诱饵"偏移(把擦过做得更好看)
 * [说明] 原作配置里 finishBlowTimeMin/Max 与 DistMin/Max 的**触发关系**没写(在代码里),
 *   我按最自然的一种实现: 在 finishBlowNear(60) ~ finishBlowDistMax(750) 之间终结的敌方弹,
 *   演出**时长**取 finishBlowTimeMin~Max。两个界都可调, 想收紧就改 finishBlowDistMin。
 */
export interface MissileCommon {
  finishBlowDistMin: number;
  finishBlowDistMax: number;
  finishBlowTimeMin: number;
  finishBlowTimeMax: number;
  /** 近界: 比这更近的终结也算(原作 finishBlowNormalMissileDist 60) */
  finishBlowNear: number;
  missLeadOffset: number;
  missLeadRadius: number;
}
export const MISSILE_COMMON_DEFAULT: MissileCommon = {
  finishBlowDistMin: 200, finishBlowDistMax: 750, finishBlowTimeMin: 2, finishBlowTimeMax: 3,
  finishBlowNear: 60, missLeadOffset: 20, missLeadRadius: 20,
};
const _commonCache: { rev: number; v: MissileCommon } = { rev: -1, v: MISSILE_COMMON_DEFAULT };
/** 读全局项(键 skybound.wpm.<字段>, 现场可调) */
export function missileCommon(): MissileCommon {
  if (_commonCache.rev === _rev) return _commonCache.v;
  const base = MISSILE_COMMON_DEFAULT;
  const out: MissileCommon = { ...base };
  const num = (k: keyof MissileCommon, lo: number, hi: number) => {
    (out as unknown as Record<string, number>)[k] = readTuning(`skybound.wpm.${k}`, base[k], lo, hi);
  };
  num('finishBlowDistMin', 0, 3000); num('finishBlowDistMax', 0, 5000);
  num('finishBlowTimeMin', 0.1, 10); num('finishBlowTimeMax', 0.1, 10);
  num('finishBlowNear', 0, 1000); num('missLeadOffset', 0, 200); num('missLeadRadius', 0, 200);
  _commonCache.rev = _rev; _commonCache.v = out;
  return out;
}

/** 参数表版本 —— 旋钮一改就 +1, 让在飞的导弹下一帧立刻读到新值 */
let _rev = 0;
const _cache = new Map<string, { rev: number; p: MissileParams }>();
export function bumpWeaponParams(): void { _rev += 1; _cache.clear(); }
export function weaponParamsRev(): number { return _rev; }

/**
 * 取参数(带缓存 + 每字段可被 localStorage 覆盖)。
 * 键: `skybound.wp.<弹种>.<字段>`; 越界/缺省 ⇒ 用表里的值(与 readTuning 同语义)。
 * 每帧每弹种只解析一次(cache), 所以现场调参既立刻生效又不吃性能。
 */
export function paramsFor(key: MissileParamKey): MissileParams {
  const hit = _cache.get(key);
  if (hit && hit.rev === _rev) return hit.p;
  const base = MISSILE_PARAMS[key] ?? MISSILE_PARAMS_DEFAULT;
  const out = { ...base };
  const num = (field: keyof MissileParams, lo: number, hi: number) => {
    const v = readTuning(`skybound.wp.${key}.${String(field)}`, base[field] as number, lo, hi);
    (out as unknown as Record<string, number>)[String(field)] = v;
  };
  // 只对数值字段做覆盖(字符串字段 guidance 单独处理)
  num('speedInit', 0, 4000); num('speedMax', 0, 4000); num('accele', 0, 4000);
  num('noAcceleTime', 0, 5); num('endTime', 1, 60); num('noHomingTime', 0, 5);
  num('hormingAng', 1, 180); num('hormingAngHi', 0, 180); num('hormingAngLow', 0, 180);
  num('rotAngMax', 0, 720); num('rotAngMaxHi', 0, 720); num('rotAngMaxLow', 0, 720);
  num('gravity', 0, 60); num('gravitydecay', 0, 5); num('pnGain', 0, 12);
  num('wobble', 0, 0.5); num('turnEnergyK', 0, 60);
  num('power', 0, 9999); num('lengthStart', -20, 40); num('lengthEnd', -40, 40);
  num('thickness', 0, 30); num('explosionRadius', 0, 400);
  num('directShootPowerRate', 0.1, 10); num('targetBound', 0, 40); num('missHomingCutDist', 0, 2000);
  num('lockonNum', 1, 12); num('selectNum', 1, 12); num('range', 0, 30000); num('angle', 5, 180);
  num('reload', 0, 60); num('flareSuscept', 0, 1);
  try {
    const g = localStorage.getItem(`skybound.wp.${key}.guidance`);
    if (g === 'pursuit' || g === 'pn') out.guidance = g;
  } catch { /* ignore */ }
  _cache.set(key, { rev: _rev, p: out });
  return out;
}

/** 给一个"我们没有的弹种/未知键"兜底 */
export function paramsForWeapon(w: string | undefined, isAlly: boolean, tier: 'low' | 'normal' | 'high'): MissileParams {
  const k = ((): MissileParamKey => {
    switch (w) {
      case 'MSL': return 'MSL';
      case 'LASM': return 'LASM';
      case 'QAAM': return 'QAAM';
      case 'LAAM': return 'LAAM';
      case 'SARH': return 'SARH';
      case 'VASM': return 'VASM';
      case '4AAM': return 'FOUR_AAM';
      case '4AGM': return 'FOUR_AGM';
      case 'BDL': return 'BDL';
      case 'CLB': return 'CLB';
      case 'HVG': return 'HVG';
      case 'NKV': return 'NKV';
      case 'LASER': return 'LASER';
      default: return isAlly ? 'MSL' : 'NPC_MSL';
    }
  })();
  const p = paramsFor(k);
  if (!isAlly && (k === 'MSL' || k === 'LASM')) {
    // 敌方发的普通弹用 NPC 表(如未单独指定)
    const npc = isNaN(tier as unknown as number) ? paramsFor('NPC_MSL') : paramsFor('NPC_MSL');
    return tier === 'low' ? { ...npc, speedMax: npc.speedMax * 0.9, turnEnergyK: 12 } : npc;
  }
  return p;
}
