/**
 * === §340 敌方空中 AI: 具名状态 + 机动库 + 按速度插值的机炮散布 ==================
 *
 * 参考 Ace Combat: Assault Horizon 的三层架构(剔除 DFM):
 *   第 1 层 C++ 状态机   —— 我们这里就是 `AirAiState` + 状态计时
 *   第 2 层 编队 AI      —— 未做(见 §340 文档"还没做")
 *   第 3 层 任务导演     —— 未做(下一个阶段: 旗标/节点航路/相对投放)
 *
 * 原作状态表 → 我们的对应:
 *   Attack / AttackBack    => 'attack'        (进攻: 咬目标; 被咬时 nose-to-nose 反转已在引擎里)
 *   AvoidNormal            => 'avoidNormal'   (躲导弹: 机动库 + 干扰弹)
 *   AvoidCenter            => 'avoidCenter'   (别往交战中心扎)
 *   AvoidCombatArea        => 'avoidCombatArea'(脱离交战区 / 血少撤退)
 *   AvoidHighest/Lowest    => 'avoidHighest' / 'avoidLowest' (高度带纪律)
 *   AvoidMesh              => 'avoidMesh'     (贴地拉起)
 *   Command: Break/Barrel/Slalom/Turn => `AIR_MANEUVERS`(机动库)
 *
 * 数据来源与尺度: 原作的 `NPC_BULLET_COMMON.deviationAsm`(speed0 900 / speed1 250 /
 * speedX 350 / precisionX 0.75)与 `deviationFlight`(全 0 = 战斗机不加散布)——
 * 注意原作里战斗机是**零散布**, 难度来自"什么时候开火"而非随机偏; 我们保留了引擎
 * 原有的基础偏差(它已经在模拟"瞄准解算质量"), 只把**速度因子**按原作的插值形状接上:
 * 速度高 -> 散布小, 速度低 -> 散布大, 中间用 speedX 做尺度。全部可用控制台调。
 */
import { readTuning } from '../tuning';

export type AirAiState =
  | 'patrol' | 'attack' | 'avoidNormal' | 'avoidCenter' | 'avoidCombatArea'
  | 'avoidHighest' | 'avoidLowest' | 'avoidMesh';

export type AirManeuver = 'break' | 'barrel' | 'slalom' | 'turn';

/** 机动库: 每个机动 = 一个"相对机体的转向偏移", 持续 `dur` 秒 */
export const AIR_MANEUVERS: AirManeuver[] = ['break', 'barrel', 'slalom', 'turn'];

export interface AiTuning {
  /** 高度带(米): 低于 lo 触发 avoidLowest, 高于 hi 触发 avoidHighest */
  altLoM: number;
  altHiM: number;
  /** 交战中心规避半径(米): 比这更靠近"战场中心"就往回带 */
  centerAvoidM: number;
  /** 血量低于该比例(0..1) => 脱离交战区(avoidCombatArea) */
  disengageHp: number;
  /** 机动库单个动作的持续时间(秒) */
  maneuverT: number;
  /** 状态再评估间隔(秒) —— 防止状态抖动 */
  stateHoldT: number;
  /** 远距"简化 AI"距离(米): 超过它时 AI 降频/简化 */
  lodAirM: number;
  /** §342 avoidMesh: 前瞻探地距离(米) —— 沿速度矢量往前探这么远 */
  meshLookM: number;
  /** §342: 探到地形后要求的最小离地余量(米) */
  meshClearM: number;
  /** §342: 判断"往哪边绕"时左右取样的横向距离(米) */
  meshSideM: number;
  // === §347 AI 机炮削弱(用户: "ai被ai远距离机炮秒杀") ======================
  // 起因: 子弹 1350m/s 比导弹(950)快得多, 而机炮的**散布与伤害从来没有被削弱过** ——
  // 于是 AI 之间在远距就能用机炮互相秒杀。这三项对所有 AI(敌机/僚机/地面舰载/战舰组件)生效。
  /** 散布倍率(默认 3.0 = 散布扩大到 3 倍) */
  gunErrMul: number;
  /** 伤害倍率(默认 0.4 = 单发伤害降到 40%) */
  gunDmgMul: number;
  /** AI 机炮开火距离(米; 原来写死 700) */
  gunRangeM: number;
  // === §348 AI 躲避机炮(用户: "ai会躲避机炮攻击") ==========================
  // 原来 AI 只对**导弹**做规避; 机炮子弹完全不管 —— 而子弹比导弹快(1350 vs 950),
  // 于是 AI 会笔直飞进弹雨。下面五项控制"机炮来袭"的侦测与反应:
  /** 侦测距离(米): 只对这么近的子弹反应 */
  gunThreatM: number;
  /** 来袭锥(cos): 子弹方向与"指向我"的夹角余弦阈值(0.985 ≈ 10 度) */
  gunThreatCone: number;
  /** 会合距离阈值(米): 预计擦身距离小于它才算"会打到我" */
  gunThreatMiss: number;
  /** 一次机炮规避持续的机动时长(秒) */
  gunEvadeT: number;
  /** 两次机炮规避之间的冷却(秒) —— 防止 AI 抖个不停 */
  gunDodgeCd: number;
  /** 机炮散布表(原作 deviationAsm): 高速端/低速端/尺度 + 精度系数 */
  devSpeed0: number;
  devSpeed1: number;
  devSpeedX: number;
  devPrecisionX: number;
}

export const AI_TUNING_DEFAULT: AiTuning = {
  altLoM: 600, altHiM: 9000,
  centerAvoidM: 3000,
  disengageHp: 0.25,
  maneuverT: 2.2,
  stateHoldT: 0.5,
  lodAirM: 7000,
  meshLookM: 1400, meshClearM: 260, meshSideM: 700,
  gunErrMul: 3.0, gunDmgMul: 0.4, gunRangeM: 450,
  gunThreatM: 900, gunThreatCone: 0.985, gunThreatMiss: 45, gunEvadeT: 1.1, gunDodgeCd: 2.5,
  devSpeed0: 900, devSpeed1: 250, devSpeedX: 350, devPrecisionX: 1.0,
};

const KEYS: Record<keyof AiTuning, [number, number]> = {
  altLoM: [50, 8000], altHiM: [500, 15000],
  centerAvoidM: [200, 20000], disengageHp: [0, 0.9],
  maneuverT: [0.4, 8], stateHoldT: [0.1, 3], lodAirM: [1000, 30000],
  devSpeed0: [100, 4000], devSpeed1: [0, 4000], devSpeedX: [50, 4000], devPrecisionX: [0, 3],
  meshLookM: [200, 6000], meshClearM: [50, 1500], meshSideM: [100, 3000],
  gunErrMul: [0.2, 12], gunDmgMul: [0, 2], gunRangeM: [100, 2000],
  gunThreatM: [100, 3000], gunThreatCone: [0.5, 1], gunThreatMiss: [5, 300],
  gunEvadeT: [0.2, 4], gunDodgeCd: [0, 15],
};

/** 每帧读(与 aiEnergyTuning 同一套路: 键 skybound.aia.*) */
export function readAiTuning(): AiTuning {
  const out = { ...AI_TUNING_DEFAULT };
  for (const k of Object.keys(KEYS) as (keyof AiTuning)[]) {
    const [lo, hi] = KEYS[k];
    (out as unknown as Record<string, number>)[k] = readTuning(`skybound.aia.${k}`, AI_TUNING_DEFAULT[k], lo, hi);
  }
  return out;
}

/**
 * 机动库: 给一个"朝哪边让"的方向(左右 ±1)与时间 t(秒), 输出**相对机体的转向偏移**。
 *   break  急转     —— 水平急转 + 明显下压(最常用的躲导弹动作)
 *   barrel 桶滚     —— 绕纵轴螺旋, 水平分量随时间左右摆
 *   slalom 蛇形     —— 高频左右交替(消耗导弹能量最有效的动作之一)
 *   turn   纯转向   —— 只拉水平, 不改变高度(适合保持高度带时用)
 * 返回值写进 `out`(原地复用, 不分配)。
 */
export function maneuverOffset(
  m: AirManeuver, t: number, dir: number, out: { x: number; y: number; z: number },
): void {
  const s = Math.sin(t * 3.1) * dir;
  switch (m) {
    case 'barrel': out.x = s * 1.0; out.y = Math.sin(t * 6.2) * 0.55; out.z = 0; break;
    case 'slalom': out.x = Math.sin(t * 5.4) * dir * 1.15; out.y = 0.12; out.z = 0; break;
    case 'turn': out.x = dir * 0.9; out.y = 0; out.z = 0; break;
    // avoidMesh 不用机动库: 它要的是"拉起 + 往低的一侧滚", 由引擎直接算期望方向
    case 'break':
    default: out.x = dir * 1.0; out.y = dir * 0.55; out.z = 0; break;
  }
}

/**
 * 机炮散布(弧度, 半角) —— 原作 `deviationAsm` 的"速度插值 + 精度系数"形状:
 *   速度 >= devSpeed0  => 用 speed1 端的散布(小)
 *   速度 <= devSpeed1  => 散布被放大(慢 = 瞄不稳)
 *   中间 => 以 devSpeedX 做尺度的插值
 * 再乘 `devPrecisionX`(原作 0.75)与机体机动性系数(重机更差), 最后钳到上限。
 * [i] 我们不带 `deviationFlight`(那座全 0): 引擎另有"基础瞄准误差"由调用方保留,
 *     所以这里返回的是**乘在基础误差上的倍率**, 而不是绝对散布。
 */
export function gunDeviationScale(
  speed: number, t: AiTuning, agilityFactor: number,
): number {
  const s0 = t.devSpeed0, s1 = t.devSpeed1, sx = Math.max(1, t.devSpeedX);
  // 归一化: 0 = 最慢, 1 = 最快
  const f = Math.max(0, Math.min(1, (speed - Math.min(s0, s1)) / Math.max(1, Math.abs(s0 - s1))));
  // 慢 => 1.0(散布大), 快 => 0(散布小)
  const speedScale = 1 - f;
  // sx 越"小", 说明该机型的散布随速度变化越剧烈 => 用它做一次幅度缩放
  const mag = Math.max(0.2, Math.min(1.5, sx / 350));
  // 0.55(最快)/1.45(最慢): 均值 ~1 => 难度与旧实现同量级, 变的是"速度对命中的影响"
  return Math.max(0.15, Math.min(2.5, (0.55 + speedScale * 0.9) * mag * t.devPrecisionX * agilityFactor));
}
