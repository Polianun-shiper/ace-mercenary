// === 能量空战 AI (Energy-Maneuverability) — 把"转弯"从动画插值升级成战术决策 ======
//
// 为什么单独一个模块: 原来的街机 AI 转弯只有三行 ——
//     e.forward.lerp(desired, dt * 1.6 * turnRate);          // 直接朝目标方向插值
//     e.speed = lerp(e.speed, spec.maxSpeed, dt * 0.6);      // 速度无条件收敛到最大
//     e.rollAngle = lerp(e.rollAngle, -bank * 0.9, dt * 3);  // 滚转只是**视觉**，
//                                                            // 不参与转弯平面
// 于是真实空战里最显眼的三件事全都没有:
//   ① **转弯速率**与速度无关(现实中角速度 ω = g·n / V, 越快半径越大);
//   ② **能量**不守恒 —— 拉杆不掉速、爬升不掉速、俯冲不增速;
//   ③ **先滚转再拉杆** —— 升力方向由机翼朝向决定, 滚没对准就拉不出该有的向心加速度。
//
// 本模块给出三件事(与设计稿一一对应):
//   ① 能量状态 E = V²/2 + g·h ⇒ 用它决定"进攻 / 防守 / 脱离";
//   ② 战术层: 滞后追逐 / 前置追踪 / 高悠悠 / 低悠悠 / 破S / 俯冲增速 / 拖带 / 反扣;
//   ③ 舵面层: 滚转对准转弯平面 → 按 G 指令拉杆 → 诱导阻力掉速 + 重力沿航迹分量
//      ⇒ "转弯掉速、低速转不动" 是**算出来的**, 不是拍出来的。
//
// 设计原则:
//   · **只算"决策 + 转弯平面", 不接管位置积分** —— engine 仍然负责位置/姿态/地形/
//     导弹机炮, 模块只输出 `{gCmd, rollCmd, throttle, aim}` ⇒ 换上去风险小、能一键回退。
//   · 手感常数全走 `AiTuning`(engine 侧每帧从 localStorage 读) ⇒ 现场可调。
//   · **纯数学、不碰渲染** ⇒ 能在 Node 里跑确定性对局测试(scripts/_ai-sim.mjs)。
//
// ⚠ 滚转符号约定(与 engine 一致, 改这里必须同步): 模型 +Z = 机头, +Y = 机背。
//   `rollAngle > 0` = **左**滚(机背倒向 -X); 因此升力方向 = (0,1,0) 绕机头轴转 **+rollAngle**。
import * as THREE from 'three';

const G0 = 9.81;

export interface AiTuning {
  /** 最大可用过载(真实机型 6~9; 越大转得越狠) */
  maxG: number;
  /** 角点速度 = 最佳转弯速度(maxSpeed 的比例): 低于它升力受限, 高于它过载受限 */
  cornerFrac: number;
  /** 峰值角速度倍率(与旧街机 `dt*1.6*turnRate` 的 1.6 对齐 ⇒ 手感不跳变) */
  omegaK: number;
  /** 推力(米/秒², 满油门) */
  thrust: number;
  /** 寄生阻力系数(∝ V²) */
  dragK: number;
  /** 诱导阻力系数(∝ n²) —— 拉杆掉速的根源 */
  inducedK: number;
  /** 滚转角速度倍率(× spec.rollRate) */
  rollK: number;
  /** 滞后追逐的滞后距离基准(米; 按转弯优势缩放) */
  lagBaseM: number;
  /** 机头迎角(度): 姿态指向速度矢量前方几度 */
  aoaDeg: number;
  /** 前置追踪的提前量倍率(1 = 按 900m/s 弹速算) */
  leadK: number;
}

export const AI_TUNING_DEFAULT: AiTuning = {
  maxG: 8.5,
  cornerFrac: 0.62,
  omegaK: 1.6,
  // 标定目标(用 scripts/_ai-sim.mjs 的"标定"段验过):
  //   平飞满油门: 角点速度 316 -> maxSpeed 505 约 21s(真实战机也是这个量级);
  //   持续 6.5G 盘旋: 速度从 460 掉到 ~330(角点附近)并**稳住**, 不会掉到失速。
  //   ⇒ 寄生阻力定 maxSpeed(V=510 时刚好抵消推力), 诱导阻力 ∝ n² 定"拉杆掉速"的量级。
  thrust: 13,
  dragK: 5.0e-5,
  inducedK: 0.2,
  rollK: 1.9,
  lagBaseM: 520,
  aoaDeg: 3.5,
  leadK: 1,
};

export interface FighterKinematics {
  position: THREE.Vector3;
  forward: THREE.Vector3;
  /** 机体"上"(已含滚转) —— 升力方向 */
  up: THREE.Vector3;
  speed: number;
  rollAngle: number;
  spec: { maxSpeed: number; minSpeed: number; turnRate: number; rollRate: number };
}

export interface TargetKinematics {
  position: THREE.Vector3;
  forward: THREE.Vector3;
  speed: number;
}

/** 战术(设计稿里那张表) */
export type FightTactic =
  | 'lead'        // 前置追踪: 已进机炮包线, 瞄提前量
  | 'lag'         // 滞后追逐: 瞄目标后方, 压缩对手转弯空间
  | 'pure'        // 纯追踪: 直接咬
  | 'high-yoyo'   // 高悠悠: 快冲到前头了, 拉起换高度、等对手转回来
  | 'low-yoyo'    // 低悠悠: 对手在下方转, 压下去切内圈
  | 'split-s'     // 破S: 滚 180° 后俯冲换向 + 换速度
  | 'dive'        // 俯冲增速(能量不足)
  | 'extend'      // 拖带/脱离(能量劣势且被咬)
  | 'reverse';    // 急转反扣(被咬尾, 迫对手冲过头)

export interface FighterCommand {
  tactic: FightTactic;
  /** 过载指令(0 ~ 可用 G) */
  gCmd: number;
  /** 滚转指令(弧度; 0 = 机翼水平, >0 = 左滚) */
  rollCmd: number;
  /** 油门 0~1.05(>1 = 加力) */
  throttle: number;
  /** 想要的机头指向(engine 用它做锁定/开火判定与意图可视化) */
  aim: THREE.Vector3;
  /** 能量(V²/2 + g·h)与能量差(自己 - 目标) */
  energy: number;
  eDiff: number;
  debug: {
    rangeM: number;
    /** 目标尾后角(0 = 我在目标正后方 = 完美咬尾; 度) */
    ataDeg: number;
    /** 接近率(正 = 在拉近) */
    closing: number;
    /** 滚转误差(0 = 已对准转弯平面; 度) */
    rollErrDeg: number;
    /** 角速度上限(度/秒) */
    omegaMaxDeg: number;
    /** 可用过载(升力/G 限约束后的值) */
    gAvail: number;
  };
}

const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _t3 = new THREE.Vector3();

/** 把单位向量 from 朝 to 转最多 maxRad(保持单位长度)。 */
function rotateTowards(from: THREE.Vector3, to: THREE.Vector3, maxRad: number): THREE.Vector3 {
  const dot = THREE.MathUtils.clamp(from.dot(to), -1, 1);
  const ang = Math.acos(dot);
  if (ang < 1e-5) return from.clone();
  const axis = new THREE.Vector3().crossVectors(from, to);
  if (axis.lengthSq() < 1e-12) return from.clone();   // 反向: 退化, 交给滚转处理
  axis.normalize();
  return from.clone().applyAxisAngle(axis, Math.min(maxRad, ang)).normalize();
}

/**
 * 一架 AI 的战术大脑。每个敌机一个实例(带战术滞回等历史状态)。
 *
 * engine 侧用法:
 *   const cmd = f.update(own, target, dt);     // 决策 + 舵面指令
 *   const nose = f.noseDirection(own, cmd);    // 带迎角滞后的机头指向(写姿态用)
 *   f.integrate(own, cmd, dt);                 // 速度/能量/滚转/航迹的积分
 *   e.position.addScaledVector(own.forward, own.speed * WORLD_SPEED_SCALE * dt);  // 位置仍由 engine 走
 */
export class EnergyFighter {
  tuning: AiTuning;
  tactic: FightTactic = 'lag';
  private _tacticHold = 0;

  constructor(tuning: Partial<AiTuning> = {}) {
    this.tuning = { ...AI_TUNING_DEFAULT, ...tuning };
  }

  /** 能量: V²/2 + g·h */
  static energy(speed: number, y: number): number {
    return 0.5 * speed * speed + G0 * y;
  }

  /**
   * 可用过载曲线(G 可用):
   *   V < Vcorner: 升力受限 ⇒ nAvail = maxG·(V/Vcorner)²
   *   V > Vcorner: 过载受限 ⇒ nAvail = maxG
   * 两段在 Vcorner 处连续。
   */
  gAvailable(speed: number, maxSpeed: number): number {
    const t = this.tuning;
    const vCorner = Math.max(40, maxSpeed * t.cornerFrac);
    const v = Math.max(25, speed);
    return v <= vCorner ? t.maxG * Math.pow(v / vCorner, 2) : t.maxG;
  }

  /** 角速度上限(度/秒): ω = g·nAvail / V, 再乘 omegaK 对齐旧街机峰值手感 */
  omegaMaxFor(speed: number, maxSpeed: number): number {
    const v = Math.max(25, speed);
    return (this.tuning.omegaK * G0 * this.gAvailable(v, maxSpeed)) / v;
  }

  /** 决策 + 舵面指令(每帧调一次) */
  update(own: FighterKinematics, target: TargetKinematics | null, dt: number): FighterCommand {
    const t = this.tuning;
    const E = EnergyFighter.energy(own.speed, own.position.y);
    const vCorner = Math.max(40, own.spec.maxSpeed * t.cornerFrac);
    const gAvail = this.gAvailable(own.speed, own.spec.maxSpeed);
    const omegaMax = this.omegaMaxFor(own.speed, own.spec.maxSpeed);
    const dbgBase = { rangeM: Infinity, ataDeg: 0, closing: 0, rollErrDeg: 0, omegaMaxDeg: THREE.MathUtils.radToDeg(omegaMax), gAvail };

    // ---- 无目标: 巡航(拉平 + 保能量) ----
    if (!target) {
      this.tactic = 'extend';
      const level = new THREE.Vector3(own.forward.x, 0, own.forward.z).normalize();
      const cmd: FighterCommand = {
        tactic: 'extend', gCmd: this._levelG(own), rollCmd: 0,
        throttle: own.speed < vCorner * 1.05 ? 1 : 0.7, aim: level,
        energy: E, eDiff: 0, debug: { ...dbgBase, rangeM: Infinity },
      };
      this._fillRoll(own, cmd);
      return cmd;
    }

    // ---- 几何量 ----
    const toTgt = _t1.copy(target.position).sub(own.position);
    const rangeM = toTgt.length();
    const losDir = toTgt.clone().normalize();                     // 视线(我 -> 目标)
    const tgtVel = target.forward.clone().normalize();
    const tailDir = tgtVel.clone().negate();                      // 目标机尾朝后
    // ⚠ ATA(尾后角)的定义: **0 度 = 我在目标正后方**(完美咬尾), 180 度 = 迎头。
    //   "从目标指向我"的方向 = -losDir; 它和"机尾朝后"重合度越高 ⇒ 我越在尾后。
    //   (第一版写成 `acos(losDir·tailDir)` = 180° - 正确值 ⇒ 开局正尾后却被判成迎头,
    //    于是 AI 一上来就"反扣/拖带" —— 是 _ai-sim.mjs 抓出来的。)
    const ataDeg = THREE.MathUtils.radToDeg(
      Math.acos(THREE.MathUtils.clamp(-losDir.dot(tailDir), -1, 1)));
    const closing = own.forward.dot(losDir) * own.speed - tgtVel.dot(losDir) * target.speed;
    const eDiff = E - EnergyFighter.energy(target.speed, target.position.y);
    // 对手转弯能力(用来算"转弯优势" ⇒ 决定滞后距离)
    const omT = (G0 * this.gAvailable(target.speed, Math.max(60, target.speed * 1.6))) / Math.max(25, target.speed);
    const omegaAdv = THREE.MathUtils.clamp(omegaMax / Math.max(1e-3, omT), 0.6, 1.8);

    // ---- 战术选择(0.35s 滞回, 免得姿态抖) ----
    this._tacticHold -= dt;
    if (this._tacticHold <= 0) {
      this._tacticHold = 0.35;
      this.tactic = this._pickTactic({ ataDeg, rangeM, closing, eDiff, speed: own.speed, vCorner, tgtY: target.position.y, ownY: own.position.y });
    }

    // ---- 目标点 / G 强度 / 油门 ----
    // 油门就是**能量管理**的执行器(用户设计稿第 1 条): 高于角点速度收油门、
    // 低于角点补油门。为什么必须做: 速度越快转弯半径越大(ω = g·n/V), 于是"油门到底"
    // 的 AI 反而咬不住在转弯的对手 —— _ai-sim.mjs 场景A 抓到的就是这件事(速度冲到 541,
    // 半径 2.2km > 对手 1.3km, 永远进不了机炮包线)。
    const vCornerNow = own.spec.maxSpeed * t.cornerFrac;
    let aim: THREE.Vector3;
    let gFrac = 1;
    let throttle = 1;
    switch (this.tactic) {
      case 'lead': {
        const tFly = rangeM / 900;
        aim = target.position.clone().addScaledVector(tgtVel, target.speed * tFly * t.leadK);
        // 咬到包线里就别再加速; 快贴脸了收油门(否则冲过头)
        throttle = (rangeM < 500 && closing > 60) ? 0.6 : (own.speed < vCornerNow ? 1.05 : 0.95);
        break;
      }
      case 'lag': {
        // **滞后追逐**: 瞄目标尾后 lagBase 米除以"转弯优势" ⇒ 优势越大咬得越紧
        const lagM = t.lagBaseM / omegaAdv;
        aim = target.position.clone().addScaledVector(tgtVel, -Math.min(lagM, rangeM * 0.9));
        // 切内圈时把速度压在角点附近(这就是"用速度换角速度")
        throttle = own.speed > vCornerNow * 1.12 ? 0.55 : (own.speed < vCornerNow * 0.95 ? 1.05 : 0.9);
        break;
      }
      case 'pure':
        aim = target.position.clone();
        throttle = own.speed > vCornerNow * 1.12 ? 0.6 : 1;
        break;
      case 'high-yoyo': {
        // 拉起换高度(出转弯平面), 目标是"等对手转回来"而不是硬咬
        aim = target.position.clone().add(new THREE.Vector3(0, Math.min(260, rangeM * 0.35), 0))
          .addScaledVector(tgtVel, -rangeM * 0.25);
        gFrac = 0.85; throttle = 0.55;
        break;
      }
      case 'low-yoyo': {
        aim = target.position.clone().add(new THREE.Vector3(0, -Math.min(180, rangeM * 0.25), 0));
        gFrac = 0.9;
        break;
      }
      case 'split-s': {
        aim = own.position.clone().addScaledVector(own.forward, 200);
        aim.y -= 400;
        break;
      }
      case 'dive': {
        aim = _t2.copy(own.forward).setY(-0.55).normalize().clone();
        gFrac = 0.35; throttle = 1.05;
        break;
      }
      case 'reverse': {
        aim = target.position.clone();
        gFrac = 1; throttle = 0.9;
        break;
      }
      case 'extend':
      default: {
        aim = own.position.clone().addScaledVector(own.forward, 400);
        aim.y = Math.max(aim.y, own.position.y - 100);
        gFrac = 0.3; throttle = 1.05;
        break;
      }
    }

    const cmd: FighterCommand = {
      tactic: this.tactic, gCmd: 0, rollCmd: 0, throttle, aim,
      energy: E, eDiff,
      debug: { ...dbgBase, rangeM, ataDeg, closing },
    };
    // ---- 转弯平面 + "先滚转再拉杆" ----
    this._fillRoll(own, cmd, gFrac, gAvail);
    return cmd;
  }

  /**
   * 把"想去的方向(aim)"翻译成 滚转指令 + 过载指令。
   *
   * 物理: 升力垂直于航迹、指向机体上方(随滚转倾斜)。要转弯就是让升力朝转弯方向 ⇒
   *   ① 滚转把机背转到"转弯平面"里(这就是**先滚转**);
   *   ② 拉杆产生向心加速度(**再拉杆**)。
   * 关键在 ③: **有效升力 = G·cos(滚转误差)** —— 没对准时拉杆是拉不出转弯的, 会自动变成
   * "先滚再拉"。这也是用户要的那个视觉特征, 而且不需要额外的动画, 是物理自带的。
   */
  private _fillRoll(own: FighterKinematics, cmd: FighterCommand, gFrac = 0, gAvail = 0): void {
    const toAim = cmd.aim.clone().sub(own.position);
    if (toAim.lengthSq() < 1e-6) { cmd.gCmd = Math.min(gAvail, this._levelG(own) * 0.6); return; }
    const toAimN = toAim.normalize();
    // 需要转弯的侧向分量(垂直于当前航迹)
    const fwd = own.forward.clone().normalize();
    const wantTurn = _t3.copy(toAimN).addScaledVector(fwd, -toAimN.dot(fwd));
    const turnMag = wantTurn.length();
    // 需要的升力方向
    const liftCmd = turnMag < 1e-4 ? own.up.clone().normalize() : wantTurn.clone().normalize();
    // 滚转误差 = 当前"上"与目标升力方向的夹角(带符号, 绕航迹轴)
    const curUp = own.up.clone().normalize();
    const rollErr = Math.acos(THREE.MathUtils.clamp(curUp.dot(liftCmd), -1, 1));
    const sign = Math.sign(curUp.clone().cross(liftCmd).dot(fwd)) || 1;
    cmd.rollCmd = THREE.MathUtils.clamp(own.rollAngle + rollErr * sign, -Math.PI, Math.PI);
    cmd.debug.rollErrDeg = THREE.MathUtils.radToDeg(rollErr);
    // 有效过载 = 可用G · 战术系数 · cos(滚转误差)
    const align = Math.max(0.12, Math.cos(rollErr));
    cmd.gCmd = THREE.MathUtils.clamp(gAvail * gFrac * align, 0, gAvail);
    void turnMag;
  }

  /** 平飞所需 G(把航迹拉回水平; 不超过可用 G) */
  private _levelG(own: FighterKinematics): number {
    const climbSin = THREE.MathUtils.clamp(own.forward.y, -0.9, 0.9);
    return THREE.MathUtils.clamp(1 / Math.max(0.35, Math.sqrt(1 - climbSin * climbSin)), 1, this.tuning.maxG);
  }

  /**
   * 带**迎角滞后**的机头指向: 模型指向速度矢量沿升力方向偏 aoaDeg 度(滚转越狠偏得越多)。
   * 街机那套"朝向 = 速度方向"是没有迎角的; 真实机体机头永远比航迹高几度 —— 这一条最省力、
   * 但对"看起来有重量"贡献很大。
   */
  noseDirection(own: FighterKinematics, cmd: FighterCommand): THREE.Vector3 {
    const aoa = THREE.MathUtils.degToRad(this.tuning.aoaDeg) * THREE.MathUtils.clamp(cmd.gCmd / 3, 0.4, 2.2);
    const fwd = own.forward.clone().normalize();
    const lift = own.up.clone().normalize();
    return fwd.multiplyScalar(Math.cos(aoa)).addScaledVector(lift, Math.sin(aoa)).normalize();
  }

  /**
   * 速度 / 能量 / 滚转 / 航迹的积分。
   *
   * 速度方程: dV = [推力·油门 - 寄生阻力 - 诱导阻力·n² - g·sin(航迹仰角)]·dt
   *   ⇒ 拉杆必然掉速、俯冲必然增速。**位置不在这里积分**(engine 才知道 WORLD_SPEED_SCALE 与地形)。
   *
   * ⚠ 滚转符号: `rollAngle > 0` = 左滚 ⇒ 升力方向 = (0,1,0) 绕机头轴转 **+rollAngle**。
   */
  integrate(own: FighterKinematics, cmd: FighterCommand, dt: number): void {
    const t = this.tuning;
    // 1) 滚转(速率受 spec.rollRate 限制) —— 这就是"先滚转"那一步
    const rollRate = Math.max(0.2, own.spec.rollRate) * t.rollK;
    let dRoll = cmd.rollCmd - own.rollAngle;
    while (dRoll > Math.PI) dRoll -= Math.PI * 2;
    while (dRoll < -Math.PI) dRoll += Math.PI * 2;
    own.rollAngle += THREE.MathUtils.clamp(dRoll, -rollRate * dt, rollRate * dt);

    // 2) 航迹: 朝升力方向转(角速度 = g·n/V), **再叠加重力把航迹往下弯(g/V)**。
    //    这一项不能省: 少了它, "持续拉杆"就变成"往天上翻筋斗"而永远转不出水平盘旋。
    //    两项合起来正好给出真实关系 —— 水平盘旋时 n·cos(倾角) = 1(升力竖直分量正好抵消重力),
    //    也就是"想转得狠就必须滚得多、拉得多"。(_ai-sim.mjs 场景A 抓到过这个缺失。)
    const fwd = own.forward.clone().normalize();
    const liftDir = new THREE.Vector3(0, 1, 0).applyAxisAngle(fwd, own.rollAngle).normalize();
    const omega = (G0 * cmd.gCmd) / Math.max(25, own.speed);
    let f1 = rotateTowards(fwd, liftDir, omega * dt);
    f1 = rotateTowards(f1, new THREE.Vector3(0, -1, 0), (G0 / Math.max(25, own.speed)) * dt);
    own.forward.copy(f1);
    own.up.copy(new THREE.Vector3(0, 1, 0).applyAxisAngle(own.forward.clone().normalize(), own.rollAngle)).normalize();

    // 3) 能量: 推力 - 寄生阻力 - 诱导阻力(n²) - 重力沿航迹分量
    const v = Math.max(25, own.speed);
    const dv = (t.thrust * Math.max(0, cmd.throttle) - t.dragK * v * v - t.inducedK * cmd.gCmd * cmd.gCmd - G0 * own.forward.y) * dt;
    own.speed = THREE.MathUtils.clamp(own.speed + dv, own.spec.minSpeed * 0.95, own.spec.maxSpeed * 1.06);
  }

  /** 战术选择。注释里写清每一条的判据与理由。 */
  private _pickTactic(o: {
    ataDeg: number; rangeM: number; closing: number; eDiff: number;
    speed: number; vCorner: number; tgtY: number; ownY: number;
  }): FightTactic {
    const { ataDeg, rangeM, closing, eDiff, speed, vCorner } = o;
    const slow = speed < vCorner * 0.85;
    const fast = speed > vCorner * 1.45;

    // ① 能量**真的**吃亏且没有马上开火的机会 ⇒ 先俯冲把能量换回来(能量优先)。
    //    门槛用能量差而不是单纯"速度低": 同速同高的开局不该一上来就去俯冲
    //    (_ai-sim.mjs 第一版就是这么错的: 尾追开局先下潜, 结果从下方追不上)。
    if (slow && (eDiff < 0 || ataDeg > 135) && (ataDeg > 60 || rangeM > 1400)) return 'dive';

    // ② 目标在身后(被咬尾): 能量占优 ⇒ 急转反扣(把对手拖进单环); 劣势 ⇒ 拖带脱离
    if (ataDeg > 135) return eDiff > 0 ? 'reverse' : 'extend';

    // ③ 咬尾中(尾后角 < 60°)
    if (ataDeg < 60) {
      // 快冲到前头了(距离很近而接近率还很高) ⇒ 高悠悠, 别硬咬
      if (rangeM < 450 && closing > 40) return 'high-yoyo';
      // 速度太高、距离还近 ⇒ 同样高悠悠(把速度换成高度, 别overshoot)
      if (fast && rangeM < 900) return 'high-yoyo';
      // 已进机炮包线 ⇒ 前置追踪
      if (rangeM < 950) return 'lead';
      // 中距 ⇒ 滞后追逐(切内圈, 压缩对手转弯空间)
      return 'lag';
    }

    // ④ 侧方(60~135°): 对手在下方 ⇒ 低悠悠切内圈; 否则滞后绕到身后
    if (o.tgtY < o.ownY - 150 && rangeM < 1600) return 'low-yoyo';
    return slow ? 'dive' : 'lag';
  }
}
