/**
 * 可调旋钮的统一读取(替代散落的 `Number(localStorage.getItem(k))`)。
 *
 * 为什么单独抽一个: `Number(localStorage.getItem(k))` 在**键不存在**时返回
 * `Number(null) === 0`, 而守卫通常写成 `v >= 0 && v <= N` —— 于是 0 被当成
 * 合法值写进旋钮, **默认值被静默改成 0**。实际踩过: `skybound.inertiaScale`
 * 让 massK = 0 ⇒ 杆量渐入/机动惯性双双落到下限(0.05s / 0.02s), 表现为
 * "按下去就满杆、松手就归零"; `skybound.bodyWobble` / `skybound.turbAmp`
 * 同理被解析成 0, 机体气流晃动与镜头气流抖动**在默认配置下完全不生效**。
 *
 * 这里的语义: **键必须真的存在且能解析成区间内的数**, 否则一律用默认值。
 * 键存在但越界/乱填 ⇒ 也用默认值(与旧行为一致, 只是不再把 0 当合法缺省)。
 */
export function readTuning(key: string, def: number, min: number, max: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null || raw.trim() === '') return def;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < min || v > max) return def;
    return v;
  } catch {
    return def;
  }
}
