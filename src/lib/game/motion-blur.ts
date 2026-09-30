// === 动态模糊 (per user request: 观感增强,设置里开关) ===
// CSS 合成方案(源思路: edgexz gi-layer motionBlur 7051-7145):
//   按相机旋转角速度对游戏 canvas 施加 CSS blur + 轻微 scale 补偿,
//   HUD/设置层不糊(它们不是 canvas 的兄弟层)。
//   角速度 = 全轴旋转角(quaternion 夹角)/dt → EMA(0.72/0.28)→ 死区 →
//   快攻慢收 → 0.25px 量化后写 style.filter/transform(量化避免每帧刷 CSS)。
import * as THREE from 'three';

export type MotionBlurStrength = 'low' | 'med' | 'high';

/** 各强度最大模糊半径 (px) */
const MAX_PX: Record<MotionBlurStrength, number> = {
  low: 1.6,
  med: 2.6,
  high: 3.6,
};
const GAIN = 1.5;      // rad/s → px 增益
const DEAD = 0.12;     // 死区: 低于该角速度不模糊 (防微抖/菜单余晖)
const PX_QUANT = 0.25; // CSS 量化步长

export class MotionBlurFx {
  private prevQ = new THREE.Quaternion();
  private hasPrev = false;
  private vel = 0;
  private cur = 0;
  private lastPx = -1;
  private tmpQ = new THREE.Quaternion();
  private strength: MotionBlurStrength = 'med';

  constructor(private canvas: HTMLCanvasElement, strength: MotionBlurStrength = 'med') {
    this.strength = strength;
  }

  setStrength(s: MotionBlurStrength) {
    this.strength = s;
  }

  /** 每帧驱动 (dt 秒; camera = 游戏透视相机) */
  update(dt: number, camera: THREE.PerspectiveCamera) {
    camera.getWorldQuaternion(this.tmpQ);
    let w = 0;
    if (this.hasPrev) {
      const d = THREE.MathUtils.clamp(this.tmpQ.dot(this.prevQ), -1, 1);
      // 全轴旋转角(含滚转) → 角速度
      w = (2 * Math.acos(Math.abs(d))) / Math.max(1e-4, dt);
    }
    this.hasPrev = true;
    this.prevQ.copy(this.tmpQ);

    // EMA 平滑 + 上限(避免丢帧时 dt 异常撑出超大值)
    this.vel = this.vel * 0.72 + Math.min(w, 12) * 0.28;
    const target = this.vel > DEAD
      ? Math.min(MAX_PX[this.strength], (this.vel - DEAD) * GAIN)
      : 0;
    // 快攻慢收: 起糊快、收糊慢,避免尾迹突兀
    this.cur += (target - this.cur) * (target > this.cur ? 0.45 : 0.16);
    this.apply(Math.abs(this.cur) < 0.02 ? 0 : this.cur);
  }

  private apply(px: number) {
    const q = Math.round(px / PX_QUANT) * PX_QUANT;
    if (q === this.lastPx) return;
    this.lastPx = q;
    const canvas = this.canvas;
    if (q <= 0.001) {
      if (canvas.style.filter || canvas.style.transform) {
        canvas.style.filter = '';
        canvas.style.transform = '';
      }
      return;
    }
    const h = canvas.clientHeight || window.innerHeight || 1;
    canvas.style.filter = `blur(${q.toFixed(2)}px)`;
    // 轻微放大遮盖 blur 边缘虚化
    canvas.style.transform = `scale(${(1 + (q * 2.6) / h).toFixed(4)})`;
  }

  /** 暂停/菜单/结束时清掉效果并复位状态 */
  clear() {
    this.lastPx = -1;
    this.hasPrev = false;
    this.vel = 0;
    this.cur = 0;
    if (this.canvas) {
      this.canvas.style.filter = '';
      this.canvas.style.transform = '';
    }
  }
}
