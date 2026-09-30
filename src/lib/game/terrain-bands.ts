// === 统一分层带解析器 (per user request: 岩石占满遮罩/高度不透明) ===
// 游戏(environment splat)、遮罩自动生成(editor-world)、诊断显示共用这一
// 套函数 —— 保证「导出 tune 的带高」与「游戏里实际渲染的带高」逐米一致。
// 三种模式(全部返回「米」):
//   quantile = 面积分位(老默认;带 = 高度分布 q(lowTop)…q(rockTop))
//   absolute = 固定海拔米(手动档;bandLow/bandVegi/bandRock 驱动)
//   relative = nimbus 式「垂直归一」:带 = 实测高度域 minH..maxH 的百分比
//              (不随山峰绝对高低漂移;REL_ANCHORS 为各图默认锚点)
// 另提供面积占比统计(扫 survey 缓存)与陡坡转岩软化,供 console/编辑器读数。

export type BandMode3 = 'quantile' | 'absolute' | 'relative';

/** 与 tune/editor-params 地形字段相容的鸭子类型(全可选,缺什么走默认)。 */
export interface BandTunables {
  bandMode?: string;
  bandLow?: number;
  bandVegi?: number;
  bandRock?: number;
  zoneLowTop?: number;
  zoneVegiTop?: number;
  zoneRockTop?: number;
  zoneBandQ?: number;
  zoneSnowEnabled?: boolean;
  maxHeight?: number;
  // === 陡坡转岩软化 (per user request;默认阈值 0.72 / 转移 0.65) ===
  slopeRockStart?: number;
  slopeRockK?: number;
}

export interface BandSurvey {
  minH: number;
  maxH: number;
  q: (p: number) => number;   // 高度分布分位:q(0.87)=87% 面积以下的高度(米)
  cache?: Float32Array;       // 逐格高度(n×n,行主序)—— 面积统计用
  n?: number;
}

export interface BandZoneAnchors {
  lowTop: number;    // quantile 分位 / relative 垂直比例的 低地带顶
  vegiTop: number;   // 植被带顶
  rockTop: number;   // 岩带顶(之后进雪;snowEnabled=false 岩带延伸到顶)
  snowEnabled: boolean;
  bandQ: number;     // 边界软化宽(±)
}

export interface BandReport {
  mode: BandMode3;
  /** 三带边界(米) */
  low: number;
  vegi: number;
  rock: number;
  /** 雪带启用(=true 时岩带在 rock 处让位给雪) */
  snowOn: boolean;
  /** 边界软化半宽(米) */
  softLow: number;
  softVegi: number;
  softRock: number;
  domainMin: number;
  domainMax: number;
  /** 面积占比(需要 cache):[低地/沙, 草, 岩, 雪];无 cache 为 null */
  area: [number, number, number, number] | null;
}

/** relative 垂直带默认(按图;比率相对实测高度域)。 */
export const REL_ANCHORS: Record<string, { lowTop: number; vegiTop: number; rockTop: number }> = {
  mountain:    { lowTop: 0.06, vegiTop: 0.5,  rockTop: 0.82 },
  plains:      { lowTop: 0.08, vegiTop: 0.62, rockTop: 0.9 },
  desert:      { lowTop: 0.05, vegiTop: 0.6,  rockTop: 1.0 },
  archipelago: { lowTop: 0.08, vegiTop: 0.5,  rockTop: 0.9 },
  canyon:      { lowTop: 0.06, vegiTop: 0.42, rockTop: 0.82 },
};

/** absolute 固定米默认(按图;与 editor-params absBands 同源)。 */
export const ABS_DEFAULTS: Record<string, [number, number, number]> = {
  mountain:    [300, 1200, 2600],
  desert:      [60, 240, 700],
  archipelago: [80, 400, 1400],
  plains:      [150, 600, 1800],
  canyon:      [100, 500, 1600],
};

const clamp01 = (p: number) => Math.min(1, Math.max(0, p));
const smooth = (b: number, w: number, v: number) => {
  if (w <= 1e-4) return v <= b ? 0 : 1;
  const t = clamp01((v - (b - w)) / (2 * w));
  return t * t * (3 - 2 * t);
};

/**
 * 解析带高(米)。mapKey 供 relative/absolute 默认锚点;tunables 可覆盖。
 * quantile/relative 需要 survey(高度分布);absolute 不需要。
 */
export function resolveBands(
  mapKey: string,
  anchors: BandZoneAnchors,
  tunables: BandTunables,
  survey: BandSurvey | null,
  nominalMaxH: number,
): BandReport | null {
  // 缺省 = relative(与编辑器新项目默认一致,「编辑器观感=游戏观感」);
  // 旧 tune 里显式写 'quantile'/'absolute' 的继续逐位保持原行为。
  const mode = (
    tunables.bandMode === 'absolute' ? 'absolute'
      : tunables.bandMode === 'quantile' ? 'quantile'
      : 'relative'
  ) as BandMode3;
  const snowOn = anchors.snowEnabled && (tunables.zoneSnowEnabled ?? true);

  if (mode === 'absolute') {
    const [dLo, dVegi, dRk] = ABS_DEFAULTS[mapKey]
      ?? [tunables.bandLow ?? 300, tunables.bandVegi ?? 1200, tunables.bandRock ?? 2600];
    const soft = Math.max(60, nominalMaxH * 0.03);
    return {
      mode, snowOn,
      low: tunables.bandLow ?? dLo,
      vegi: tunables.bandVegi ?? dVegi,
      rock: tunables.bandRock ?? dRk,
      softLow: soft, softVegi: soft, softRock: soft,
      domainMin: survey?.minH ?? 0,
      domainMax: survey?.maxH ?? nominalMaxH,
      area: null,
    };
  }

  if (!survey) return null;
  const span = survey.maxH - survey.minH;
  if (span < 1e-3) return null;

  if (mode === 'quantile') {
    const q = (p: number) => survey.q(clamp01(p));
    const lowTop = tunables.zoneLowTop ?? anchors.lowTop;
    const vegiTop = tunables.zoneVegiTop ?? anchors.vegiTop;
    const rockTop = tunables.zoneRockTop ?? anchors.rockTop;
    const low = q(lowTop);
    const vegi = q(vegiTop);
    const rock = snowOn ? q(Math.min(rockTop, 0.999)) : vegi;
    // 软化半宽(米)= 边界 ±bandQ 之间高度差的一半(随分布自适应)
    const soft = (p: number) => {
      const pl = clamp01(p - (tunables.zoneBandQ ?? anchors.bandQ));
      const ph = clamp01(p + (tunables.zoneBandQ ?? anchors.bandQ));
      return Math.max((q(ph) - q(pl)) * 0.5, 0.5);
    };
    return {
      mode, snowOn, low, vegi, rock,
      softLow: soft(lowTop),
      softVegi: soft(vegiTop),
      softRock: snowOn ? soft(Math.min(rockTop, 0.999)) : soft(vegiTop),
      domainMin: survey.minH, domainMax: survey.maxH,
      area: null,
    };
  }

  // === relative: nimbus 式垂直归一(带 = 实测高度域百分比) ===
  const rel = REL_ANCHORS[mapKey]
    ?? { lowTop: anchors.lowTop, vegiTop: anchors.vegiTop, rockTop: anchors.rockTop };
  const toM = (p: number) => survey.minH + clamp01(p) * span;
  const soft = Math.max(40, span * 0.04);
  const low = toM(tunables.zoneLowTop ?? rel.lowTop);
  const vegi = toM(tunables.zoneVegiTop ?? rel.vegiTop);
  const rock = snowOn ? toM(tunables.zoneRockTop ?? rel.rockTop) : vegi;
  return {
    mode, snowOn, low, vegi, rock,
    softLow: soft, softVegi: soft, softRock: soft,
    domainMin: survey.minH, domainMax: survey.maxH,
    area: null,
  };
}

/** 纯分层权重(低地/草/岩/雪;不含 jitter/陡坡;与旧 quantile 逐位等价)。 */
export function bandWeightsAt(rep: BandReport, h: number): [number, number, number, number] {
  const uLo = smooth(rep.low, rep.softLow, h);
  const uVg = smooth(rep.vegi, rep.softVegi, h);
  if (!rep.snowOn) return [1 - uLo, uLo * (1 - uVg), uVg, 0];
  const uRk = smooth(rep.rock, rep.softRock, h);
  return [1 - uLo, uLo * (1 - uVg), uVg * (1 - uRk), uVg * uRk];
}

/** 陡坡转岩(可调阈值/强度;默认阈值 0.72、转移 0.65 —— 较旧 0.62/0.85 克制)。 */
export function applySlopeRock(
  w: [number, number, number, number],
  slope: number,
  t: BandTunables,
): [number, number, number, number] {
  const start = t.slopeRockStart ?? 0.72;
  const k = clamp01((slope - start) / Math.max(1e-4, 1 - start));
  const transfer = t.slopeRockK ?? 0.65;
  const m = k * transfer;
  if (m <= 0) return w;
  const [ws, wg, wr, wn] = w;
  const from = wg + ws;
  return [ws * (1 - m), wg * (1 - m), wr + from * m, wn];
}

/** 面积占比(需 survey.cache/n):[低地, 草, 岩, 雪];无缓存返回 null。 */
export function bandAreaShare(
  rep: BandReport,
  cache?: Float32Array,
  n?: number,
): [number, number, number, number] | null {
  if (!cache || !n || cache.length < n * n) return null;
  let lo = 0, grass = 0, rock = 0, snow = 0;
  const hLo = rep.low, hVg = rep.vegi, hRk = rep.rock;
  for (let i = 0; i < cache.length; i++) {
    const h = cache[i];
    if (h < hLo) lo++;
    else if (h < hVg) grass++;
    else if (rep.snowOn && h >= hRk) snow++;
    else rock++;
  }
  const tot = Math.max(1, cache.length);
  return [lo / tot, grass / tot, rock / tot, snow / tot];
}
