// ============================================================================
// 设备形态判定 —— "手机性能模式" 与 "触屏操作" 的**默认值**单一真相源
// ============================================================================
// 以前这段判定在 4 个地方各写一份(engine.ts 构造期 + Settings.tsx + Menus.tsx +
// VirtualJoystick.tsx), 想改默认值要改 4 处, 漏一处就出现"设置界面显示关、引擎实际开"
// 这种自相矛盾的状态。现在统一从这里取。
//
// === 默认电脑端 (per user request: 游戏的默认设置为电脑端模式而不是手机模式) ===
// 旧判定是 `'ontouchstart' in window || navigator.maxTouchPoints > 0` —— 只要机器
// **有**触点能力就判成手机。后果: 带触摸屏的 Windows 笔记本/一体机、以及 headless
// 浏览器(maxTouchPoints > 0)全部被默认塞进手机档(砍分辨率/关泛光/关阴影/贴片云),
// 电脑玩家一进游戏就是降质画面。
// 新判定要求**两个条件同时成立**才算手持设备(缺一不可):
//   ① 主指针是"粗指针": matchMedia('(pointer: coarse)') —— 触摸屏笔记本的主指针
//      通常是鼠标/触控板(fine), 这里为 false, 所以不会误判; (any-pointer: coarse)
//      才会因为"有个触摸屏"而为真, 那个不能用。
//   ② 小屏: min(innerWidth, innerHeight) <= 900 —— 手机竖屏/横屏、小平板都落在这个
//      范围内; 桌面窗口(哪怕拉窄到 1280×720)通常不小于它, 何况还有①把关。
// 玩家一旦在设置里手动切过(localStorage 有值), 就一直尊重玩家的选择, 不再自动改。
//
// 手动覆盖(自动判定之外的出口):
//   · 设置界面 / 主菜单的开关  → 写 localStorage
//   · `#desktop` hash         → 强制关手机模式(自动化验证用, 见 GameApp)
//   · `#mobile` hash          → 强制开手机模式(真机调试用)

/** 手持设备的屏幕短边上限(px)。手机竖/横屏与小平板都在这之内。 */
export const HANDHELD_MAX_MIN_SIDE = 900;

/** 手机性能模式的 localStorage 键(引擎与设置界面共用, 免得各写一份字符串)。 */
export const MOBILE_MODE_KEY = 'skybound.mobileMode';

/**
 * 是否是"真手持设备": 粗指针(触屏为主)**且**小屏。
 * 注意用 `(pointer: coarse)` 而不是 `(any-pointer: coarse)` —— 后者只要求"存在"
 * 触屏, 带触摸屏的笔记本会因此误判。
 */
export function isHandheldDevice(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const coarse = typeof window.matchMedia === 'function'
      && window.matchMedia('(pointer: coarse)').matches;
    if (!coarse) return false;
    const shortSide = Math.min(window.innerWidth || 0, window.innerHeight || 0);
    return shortSide > 0 && shortSide <= HANDHELD_MAX_MIN_SIDE;
  } catch {
    return false;   // 判定失败一律按电脑端(默认电脑端)
  }
}

/**
 * 解析一个"自动开启"型开关的默认值: localStorage 有值就听玩家的, 否则按设备形态。
 * @param storageKey 例如 'skybound.mobileMode' / VJ_KEY
 * @param autoOnWhenUnset 未存过值时, 手持设备是否默认开启(手机档 = true, 触屏操作 = true)
 */
export function resolveAutoOnSetting(storageKey: string, autoOnWhenUnset = true): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const v = window.localStorage.getItem(storageKey);
    if (v !== null) return v === 'on';
  } catch { /* 隐私模式等 */ }
  return autoOnWhenUnset && isHandheldDevice();
}
