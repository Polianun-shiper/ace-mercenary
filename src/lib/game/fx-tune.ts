// === fx-tune 融合链 (per user request: FX 编辑器预设 → 完全替换游戏原生爆炸) ===
// 与 terrain-tune 同机制:FX 编辑器把序列帧特效预设(含内嵌图集 dataURL)
// 导出为 fx-tune.json 并分配槽位(地面爆炸 f / 空中爆炸 4),本模块负责:
//   1. 加载:优先 localStorage('skybound.fxTune',编辑器热测)→
//      window.__ASSET_MANIFEST dataURI(单文件离线)→ fetch('/config/fx-tune.json')
//   2. 分发:engine 在任务加载时取 slots.<ground|air> 的资产 id,预解码
//      图集后注册进 FxBattleLayer —— 原生爆炸视觉被完全替换。
// 所有字段可选 —— 无 JSON/无槽位/解码失败 → 游戏维持原生爆炸,零回归。
import type { FxAsset } from '../fx/fx-core';

/** 槽位:游戏里一次爆炸按离地高度自动归类后播对应预设。 */
export interface FxSlots {
  /** 地面爆炸(炸弹/地面单位/舰船/坠地 → f 序列) */
  ground?: string;
  /** 空中爆炸(击落敌机/空中导弹命中/防空近炸 → 4 序列) */
  air?: string;
}

export interface FxTuneDoc {
  version: number;
  /** 槽位 → FxAsset.id 映射 */
  slots?: FxSlots;
  /** 资产全表(发射器内嵌 sheet.dataUrl 图集) */
  assets?: FxAsset[];
}

export const FX_TUNE_LS_KEY = 'skybound.fxTune';
export const FX_TUNE_JSON_PATH = '/config/fx-tune.json';

let _cached: FxTuneDoc | null | undefined;

/** 加载 fx-tune(模块级缓存;localStorage 优先,fetch JSON 兜底)。 */
export async function loadFxTune(): Promise<FxTuneDoc | null> {
  if (_cached !== undefined) return _cached;
  _cached = null;
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage.getItem(FX_TUNE_LS_KEY) : null;
    if (ls) {
      const doc = JSON.parse(ls) as FxTuneDoc;
      if (doc && Array.isArray(doc.assets)) {
        _cached = doc;
        return _cached;
      }
    }
  } catch { /* 坏 JSON → 走文件 */ }
  try {
    // 单文件构建:config json 也进 __ASSET_MANIFEST → 用 data URI 离线可取
    const assetUrl: string | undefined = typeof window !== 'undefined'
      ? (window as unknown as { __ASSET_MANIFEST?: Record<string, string> }).__ASSET_MANIFEST?.[FX_TUNE_JSON_PATH]
      : undefined;
    const res = await fetch(assetUrl ?? FX_TUNE_JSON_PATH);
    if (res.ok) {
      const doc = (await res.json()) as FxTuneDoc;
      if (doc && Array.isArray(doc.assets)) _cached = doc;
    }
  } catch { /* 单文件 file:// 下 fetch 被禁 → null(原生爆炸) */ }
  return _cached;
}

/** 按槽位取资产(无槽位/无该 id → null)。 */
export function slotAsset(doc: FxTuneDoc | null, slot: keyof FxSlots): FxAsset | null {
  const id = doc?.slots?.[slot];
  if (!id) return null;
  return doc?.assets?.find((a) => a.id === id) ?? null;
}
