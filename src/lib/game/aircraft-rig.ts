// === aircraft-rig 融合链 (per user request: 把 Blender 当机体装配/特效锚点编辑器) ===
//
// 它是"锚点 / 后燃器喷口 / 舵面铰链"的**唯一真值**: Blender 里手工拖完由
// blender/aircraft/30_export.py 写成 public/config/aircraft-rig.json, 游戏读它。
//
// 加载顺序(照 terrain-tune 的成熟写法 —— **文件打底 + 存档覆盖**, 深合并):
//   1. fetch /config/aircraft-rig.json(单文件构建走 __ASSET_MANIFEST 的 dataURI)
//   2. localStorage('skybound.aircraftRig')覆盖在上面(编辑器热测/临时试值)
//   ⚠ 不要照 fx-tune.ts 那个"命中 localStorage 就 return"的短路写法 ——
//     那样文件里**新增的槽永远进不来**(terrain-tune 的注释里记过这个坑)。
//
// 空间口径(唯一真值, 见 docs/aircraft-rig.md):
//   所有坐标都在**模型空间** —— 未缩放、最大边 = 10、包围盒居中、机头 +Z。
//   模型空间的 XYZ 正好等于 (右/上/前), 所以引擎里
//   `pos + right*x + up*y + fwd*z` 乘上 meshScale 就是世界坐标。
//   锚点因此**统一随 meshScale 缩放**(修掉了"炮口 y 不跟 scale"那个老问题)。
//
// 所有字段**全部可选**: 缺 → 用现有代码默认值 → 零回归。

/** 锚点: 模型空间的 XYZ 三元组 */
export type RigVec3 = [number, number, number];

/** 后燃器喷口。pos/dir 覆盖硬编码值, radius/aftZ 覆盖"实测或估计"的喷口参数。 */
export interface RigNozzle {
  pos?: RigVec3;
  /** 尾焰轴向(模型空间单位向量)。缺省 = 机体 -Z。 */
  dir?: RigVec3;
  /** 喷口半径(模型空间) */
  radius?: number;
  /** 喷口截面 z(模型空间) */
  aftZ?: number;
}

/** 一个舵面的铰链。key = models.ts 里按基名分组得到的键(如 flaperon_l / rudder0)。 */
export interface RigSurface {
  /** 铰链轴向(模型空间单位向量)。缺省由启发式量出。 */
  axis?: RigVec3;
  /** 铰链点(模型空间)。缺省由启发式量出。 */
  pivot?: RigVec3;
}

export interface RigModel {
  anchor?: Record<string, RigVec3>;
  /** 按发动机序号, 同 enginePositions 的下标 */
  nozzle?: Record<string, RigNozzle>;
  surface?: Record<string, RigSurface>;
}

export interface AircraftRigDoc {
  version: number;
  /** 写它的脚本(自检/追溯用) */
  generator?: string;
  /** key = 机型 id(f16c / mig29 / …) */
  models?: Record<string, RigModel>;
}

/**
 * 几何**共享**的机型归一到同一个 rig 键。
 *
 * f16 / f16-test / f16c 共用同一副 F-16C 机体(见 models.ts 的 F16C_AIRFRAME),
 * 所以它们必须共用一份铰链/锚点数据 —— 否则你在 Blender 里调好 f16c,
 * 玩家换成 f16 就全丢了。别名表让一张表覆盖整个家族。
 */
const RIG_ALIAS: Record<string, string> = { f16: 'f16c', 'f16-test': 'f16c' };

/** 机型 → rig 键(经别名归一)。dump 与查找都必须走它, 否则键对不上。 */
export function rigModelKey(model?: string | null): string | null {
  if (!model) return null;
  return RIG_ALIAS[model] ?? model;
}

export const RIG_LS_KEY = 'skybound.aircraftRig';
export const RIG_JSON_PATH = '/config/aircraft-rig.json';

let _cached: AircraftRigDoc | null | undefined;
/** 每次成功加载自增 —— 诊断/dump 用它确认"读到的确实是这一份" */
let _revision = 0;

function mergeModel(a: RigModel | undefined, b: RigModel): RigModel {
  return {
    anchor: { ...(a?.anchor ?? {}), ...(b.anchor ?? {}) },
    nozzle: { ...(a?.nozzle ?? {}), ...(b.nozzle ?? {}) },
    surface: { ...(a?.surface ?? {}), ...(b.surface ?? {}) },
  };
}

/**
 * 加载 aircraft-rig(模块级缓存;文件打底 + 存档覆盖)。
 * `undefined` = 没加载过, `null` = 加载了但没有/坏了。
 */
export async function loadAircraftRig(): Promise<AircraftRigDoc | null> {
  if (_cached !== undefined) return _cached;
  _cached = null;

  let fileDoc: AircraftRigDoc | null = null;
  try {
    // 单文件构建: config json 也进 __ASSET_MANIFEST → 用 data URI 离线可取
    const assetUrl: string | undefined = typeof window !== 'undefined'
      ? (window as unknown as { __ASSET_MANIFEST?: Record<string, string> }).__ASSET_MANIFEST?.[RIG_JSON_PATH]
      : undefined;
    const res = await fetch(assetUrl ?? RIG_JSON_PATH);
    if (res.ok) {
      const doc = (await res.json()) as AircraftRigDoc;
      if (doc && typeof doc === 'object' && doc.models) fileDoc = doc;
    }
  } catch { /* file:// 下 fetch 被禁 → 只有存档/全默认 */ }

  let lsDoc: AircraftRigDoc | null = null;
  try {
    const ls = typeof localStorage !== 'undefined' ? localStorage.getItem(RIG_LS_KEY) : null;
    if (ls) {
      const doc = JSON.parse(ls) as AircraftRigDoc;
      if (doc && typeof doc === 'object' && doc.models) lsDoc = doc;
    }
  } catch { /* 坏 JSON → 忽略 */ }

  if (!fileDoc && !lsDoc) return _cached;               // 全默认, 零回归
  if (!fileDoc) { _cached = lsDoc; _revision++; return _cached; }

  // 文件打底 + 存档逐模型覆盖(深合并到 anchor/nozzle/surface 各一层 ——
  // 文件里新增的锚点才能进来, 而不是被整段覆盖掉)
  const models: Record<string, RigModel> = { ...(fileDoc.models ?? {}) };
  for (const [k, v] of Object.entries(lsDoc?.models ?? {})) {
    models[k] = mergeModel((fileDoc.models ?? {})[k], v);
  }
  _cached = { ...fileDoc, ...lsDoc, models };
  _revision++;
  return _cached;
}

/** 同步取某机型的 rig 节(未加载 / 无该机型 → null)。 */
export function rigForModel(model?: string | null): RigModel | null {
  const key = rigModelKey(model);
  if (!_cached || !key) return null;
  return _cached.models?.[key] ?? null;
}

/** 同步取锚点(无 → undefined, 调用方回退默认)。 */
export function rigAnchor(model: string | null | undefined, key: string): RigVec3 | undefined {
  return rigForModel(model)?.anchor?.[key];
}

/** 同步取喷口(无 → undefined)。 */
export function rigNozzle(model: string | null | undefined, index: number): RigNozzle | undefined {
  return rigForModel(model)?.nozzle?.[String(index)];
}

/** 同步取舵面铰链(无 → undefined)。 */
export function rigSurface(model: string | null | undefined, key: string): RigSurface | undefined {
  return rigForModel(model)?.surface?.[key];
}

/** rig 是否已加载(诊断用)。 */
export function aircraftRigLoaded(): boolean { return !!_cached; }
/** 加载版本号(诊断/dump 用)。 */
export function aircraftRigRevision(): number { return _revision; }
/** 当前整份 doc(只读;dump 用)。 */
export function aircraftRigDoc(): AircraftRigDoc | null { return _cached ?? null; }
