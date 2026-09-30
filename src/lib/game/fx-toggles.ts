// === 特效系统诊断开关 (per user request: 先量后改 / 逐系统归因) =================
// 默认**全部关闭**(= 所有系统照常工作) —— 生产路径零行为变化; 只有显式打开
// 某个系统的 "off" 才会改变行为。
//
// 用途只有一个: 让取证探针(scripts/perf-hitch-probe.mjs)能逐个关掉特效系统,
// 把"风暴关"的帧时/卡顿归因到具体系统, 而不是靠猜。见 DEVELOPMENT.md §111。
//
// 打开方式(只给自动化用, 玩家路径不碰):
//   进关 hash:  #autotest&desktop&mission=m12&fxoff=rain,lightning,smoke
//   运行时:     window.__fxOff.smoke = true        (下一帧生效)
//               window.__fxOff.smoke = false       (恢复)
// 系统名:
//   rain       雨(线段)
//   lightning  闪电(每次击发的管子几何 + 天空/雾闪色)
//   explosion  爆炸的全部网格层 + 点光(含舰船齐射闪光 / 廉价爆炸)
//   smoke      池化烟雾(导弹尾迹 / 发烟爆发 / 机体凝结云)
//   wake       海面舰船尾迹
//   dust       地面车辆扬尘
//   missile    导弹本体(只关视觉, 制导与伤害照常)
//   bullet     机炮/炮弹/火箭的曳光本体(只关视觉, 弹道与伤害照常)
//   spark      命中火花 / 水花(只关视觉)
//   bomb       炸弹本体(只关视觉, 弹道与爆炸照常)
export const FX_OFF: Record<string, boolean> = {};

/** 解析 `a,b,c` 形式的开关串(空串 = 全开)。 */
export function setFxOffFromString(s: string | null | undefined): void {
  for (const k of Object.keys(FX_OFF)) delete FX_OFF[k];
  if (!s) return;
  for (const raw of s.split(/[,|;\s]+/)) {
    const k = raw.trim().toLowerCase();
    if (k) FX_OFF[k] = true;
  }
}

/** 某个特效系统是否被本次诊断关掉。热路径只做一次对象属性读 —— 可忽略。 */
export function fxOff(name: string): boolean {
  return FX_OFF[name] === true;
}
