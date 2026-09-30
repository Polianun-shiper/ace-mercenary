// === 机体锚点: 硬编码默认值集中表 + rig 覆盖 (per user request: Blender 当装配编辑器) ===
//
// 以前这些锚点是**散在 engine.ts 各处的硬编码常量**, 而且**空间口径不统一**:
//   · 翼尖跨距、炮口 z 乘了 meshScale;
//   · 导弹/炸弹/干扰弹的偏移是**世界单位常量**(不随 scale);
//   · 翼尖的 y/z 更糟 —— 玩家用 `(-0.3, 0.2)` 世界单位, AI 用 `(-0.05*s, -0.6*s)`
//     ⇒ 同一条拉烟从两个不同地方冒出来。
//
// 现在统一成一条规则(见 aircraft-rig.ts 的空间口径说明):
//   **所有锚点都存模型空间坐标, 引擎统一乘 meshScale。**
//   对每个锚点, 默认值按"在当前 meshScale 下复现改动前那个世界坐标"来算 ——
//   所以默认行为逐位不变(有 rig-dump 逐项 diff 守着), 只是从此**随 scale 一致缩放**。
//
// 消费方式:
//   const a = anchorFor(model, 'missileL', info, meshScale);
//   pos.addScaledVector(right, a[0]*s).addScaledVector(up, a[1]*s).addScaledVector(fwd, a[2]*s);
// 或直接用 anchorWorld() 把上面三步一次做完。

import * as THREE from 'three';
import { rigAnchor, type RigVec3 } from './aircraft-rig';

/** 需要的实测几何(模型空间; 由 models.ts 的 AircraftGeometryInfo 测得) */
export interface AnchorGeom {
  noseZ: number;
  tailZ: number;
  halfSpan: number;
}

export type AnchorKey =
  /** 机炮炮口(机头) */
  | 'muzzle'
  /** AC-130 侧炮口(只有带 sideCannon 的机型用) */
  | 'gunport'
  /** 导弹挂点(左右) */
  | 'missileL' | 'missileR'
  /** 炸弹投放点 */
  | 'bomb'
  /** 火箭弹(NKV)发射点 */
  | 'rocket'
  /** 翼尖(拉烟/凝结云) */
  | 'wingTipL' | 'wingTipR'
  /** 干扰弹投放点 */
  | 'flare'
  /** 受损烟的挂点 */
  | 'trailSmoke'
  /** 大型机(运输/轰炸机)的受损烟 —— 比战斗机更靠后, 所以单独一个键 */
  | 'trailSmokeHeavy';

/**
 * 改动前的**世界单位常量**。留在这里是为了让"默认值复现旧行为"这件事可核对:
 * 每个下面的默认值都是 `LEGACY / meshScale`(模型空间), 乘回去就是旧值。
 */
const LEGACY = {
  muzzleY: -0.192, muzzleZBack: 0.32,
  gunport: [3.0, 0.4, 0.5] as const,       // right/up/fwd 取反见下(在左侧)
  missile: [2.2, -1.15, 1.5] as const,
  bomb: [0, -0.8, 1.0] as const,
  rocket: [0, 1.0, 6.0] as const,
  wingTipY: -0.3, wingTipZ: 0.2,
  flare: [0, -1.0, 0] as const,
  trailSmoke: [0, 0, -2.0] as const,
  trailSmokeHeavy: [0, 0, -4.0] as const,
};

/**
 * 取锚点(模型空间)。
 *
 * 顺序: rig 里的手工值 → 否则按旧公式算出的默认值。
 * `meshScale` 只用于把旧的世界单位常量换算成模型空间, 让默认值等价于旧行为。
 */
export function anchorFor(
  model: string | null | undefined,
  key: AnchorKey,
  geom: AnchorGeom,
  meshScale: number,
): RigVec3 {
  const rig = rigAnchor(model, key);
  if (rig) return [rig[0], rig[1], rig[2]];
  const s = meshScale > 1e-6 ? meshScale : 1;
  switch (key) {
    case 'muzzle':
      // 旧: (0, -0.192, noseZ*scale + 0.32)  → 模型空间 (0, -0.192/s, noseZ + 0.32/s)
      return [0, LEGACY.muzzleY / s, geom.noseZ + LEGACY.muzzleZBack / s];
    case 'gunport':
      // 旧: right*-3.0 + up*-0.4 + fwd*0.5(AC-130 侧炮在左舷)
      return [-LEGACY.gunport[0] / s, -LEGACY.gunport[1] / s, LEGACY.gunport[2] / s];
    case 'missileR':
      return [LEGACY.missile[0] / s, LEGACY.missile[1] / s, LEGACY.missile[2] / s];
    case 'missileL':
      return [-LEGACY.missile[0] / s, LEGACY.missile[1] / s, LEGACY.missile[2] / s];
    case 'bomb':
      return [LEGACY.bomb[0], LEGACY.bomb[1] / s, LEGACY.bomb[2] / s];
    case 'rocket':
      return [LEGACY.rocket[0], LEGACY.rocket[1] / s, LEGACY.rocket[2] / s];
    case 'wingTipL':
      return [-geom.halfSpan, LEGACY.wingTipY / s, LEGACY.wingTipZ / s];
    case 'wingTipR':
      return [geom.halfSpan, LEGACY.wingTipY / s, LEGACY.wingTipZ / s];
    case 'flare':
      return [LEGACY.flare[0], LEGACY.flare[1] / s, LEGACY.flare[2] / s];
    case 'trailSmoke':
      return [LEGACY.trailSmoke[0], LEGACY.trailSmoke[1] / s, LEGACY.trailSmoke[2] / s];
    case 'trailSmokeHeavy':
      return [LEGACY.trailSmokeHeavy[0], LEGACY.trailSmokeHeavy[1] / s, LEGACY.trailSmokeHeavy[2] / s];
    default:
      return [0, 0, 0];
  }
}

/**
 * 把锚点换算成世界坐标(一步到位, 免得每个调用点都写三行 addScaledVector)。
 *
 * 方向量必须是**单位且正交**的机体轴(引擎里就是 playerRight/Up/Forward 那一套)。
 * `meshScale` 在这里乘上 —— 这是"锚点统一随 scale 缩放"的唯一实现点。
 */
export function anchorWorld(
  out: THREE.Vector3,
  origin: THREE.Vector3,
  right: THREE.Vector3,
  up: THREE.Vector3,
  fwd: THREE.Vector3,
  model: string | null | undefined,
  key: AnchorKey,
  geom: AnchorGeom,
  meshScale: number,
): THREE.Vector3 {
  const a = anchorFor(model, key, geom, meshScale);
  const s = meshScale;
  out.copy(origin)
    .addScaledVector(right, a[0] * s)
    .addScaledVector(up, a[1] * s)
    .addScaledVector(fwd, a[2] * s);
  return out;
}

/** 世界单位常量(仅供 dump/文档展示"旧值 vs 新值") */
export const LEGACY_ANCHOR_CONSTS = LEGACY;

/**
 * 全部锚点键(有序)。dump 与 Blender 侧建空物体都按这个列表走 ——
 * 加新锚点时**只改这里和 anchorFor 的 switch** 两处。
 */
export const ALL_ANCHOR_KEYS: readonly AnchorKey[] = [
  'muzzle', 'gunport',
  'missileL', 'missileR',
  'bomb', 'rocket',
  'wingTipL', 'wingTipR',
  'flare', 'trailSmoke', 'trailSmokeHeavy',
] as const;

/** 锚点键 → 中文标签(Blender 空物体命名 / 接片标注用) */
export const ANCHOR_LABELS: Record<string, string> = {
  muzzle: '机炮炮口',
  gunport: '侧炮炮口',
  missileL: '导弹挂点·左',
  missileR: '导弹挂点·右',
  bomb: '投弹点',
  rocket: '火箭发射点',
  wingTipL: '翼尖·左',
  wingTipR: '翼尖·右',
  flare: '干扰弹',
  trailSmoke: '受损烟',
  trailSmokeHeavy: '受损烟·大型机',
};
