// Weapon reload slot helpers (per user request: 导弹系统每个武器各自独立的装填cd).
//
// 每个导弹/炸弹武器类型各自持有一组**独立**装填槽: 每个槽有自己的倒计时, <=0 表示"就绪";
// 开火吃掉第一个就绪的槽并给它装上装填时间, 其余槽保持原状态继续倒数。
//   · 常规机型 2 槽(与改造前逐位一致);
//   · **轰炸机的投掷类炸弹 4 槽** (per user request: 轰炸机在投掷类炸弹方面有更多cd槽)。
//
// 纯函数, 导出便于测试(见 scripts/test-joystick-input.mjs)。

import { slotCountForWeapon } from './class-rules';

export type WeaponSlots = number[];

/** 某武器在该机型上的独立装填槽数量。轰炸机的投掷类炸弹 4 个, 其余 2 个。 */
export function slotCountFor(weapon: string, category: string | undefined): number {
  // 机型特色表是单一真相源(见 class-rules.ts): 攻击机对地 4 槽、轰炸机空对空 4 槽/投掷类 6 槽。
  return slotCountForWeapon(weapon, category);
}

/** Advance every slot timer by dt (clamped at 0 = ready). */
export function tickWeaponSlots(slots: WeaponSlots, dt: number): WeaponSlots {
  for (let i = 0; i < slots.length; i++) slots[i] = Math.max(0, slots[i] - dt);
  return slots;
}

/**
 * Consume the first ready slot: arms it with `reloadTime` and returns the
 * new slot state. Returns null when EVERY slot is still reloading.
 */
export function consumeWeaponSlot(slots: WeaponSlots, reloadTime: number): WeaponSlots | null {
  for (let i = 0; i < slots.length; i++) {
    if (slots[i] <= 0) {
      const out = slots.slice();
      out[i] = reloadTime;
      return out;
    }
  }
  return null;
}
