// ============================================================================
// 联机实体层 (P0-a: 实体容器)
// ============================================================================
// 为什么需要这一层:
//   单机时代"玩家"是 engine 上一组写死的字段(this.player / playerVelocity /
//   playerHp ... 共 20+ 个, 138 处引用), 而 AI 走另一套 this.enemies[]。
//   联机要同时存在 N 架"玩家级"飞行器(本地 + 远端), 所以必须先有一个**统一的
//   实体注册表**, 后续的位姿同步 / 阵营判定 / 目标选择 / 积分统计都以它为准。
//
// P0-a 的纪律(重要):
//   本步**只新增容器, 不改任何既有玩法逻辑**。
//   `this.player` 的 138 处引用、`this.enemies[]` 的 AI 逻辑全部原样保留;
//   注册表只是把已经存在的飞机**登记进来**(存引用, 不接管).
//   这样单机行为逐帧不变, 但 P0-b/P0-c 与 P1 联机都有了落脚点。
//
// 与 VibeHub 同步模型的对应关系:
//   规范要求先声明同步模型 —— 本项目用 **state-sync(房主权威)**:
//     · 每个客户端只**全仿真自己那一架**(所以不需要把 this.player 变成数组);
//     · 别人的飞机只做**插值渲染**, 不跑物理;
//     · 房主(host)跑权威循环并广播快照, 客户端不回写、不读库。
//   本文件里的 `remote` 槽位就是给"别人的飞机"准备的。

import type * as THREE from 'three';

/** 实体标识。
 *  · `local`        —— 本客户端的玩家机(每客户端恰好一个)
 *  · `peer:<id>`    —— 远端玩家机(SDK 的 peerId)
 *  · `ai:<n>`       —— AI 单位(敌机 / 僚机 / 轰炸机…), n = 引擎内既有 id
 *  用字符串而不是数字, 是为了让"玩家机"和"AI 单位"共用一个命名空间而不撞号:
 *  引擎里 enemy.id 是数字, 若直接复用, 未来 peerId 映射进来必然冲突。 */
export type EntityId = string;

export const LOCAL_ENTITY: EntityId = 'local';
export const peerEntityId = (peerId: string): EntityId => `peer:${peerId}`;
export const aiEntityId = (n: number): EntityId => `ai:${n}`;

/** 阵营。
 *  P0-a 只做**记录**;真正的敌我翻转(剧情联机里"选敌方 → 原友军变敌人")
 *  放在 P3, 届时统一由这张表驱动, 不再散落在 isAlly 判断里。 */
export type Faction = 'player' | 'ally' | 'enemy' | 'neutral';

/** 实体来源 —— 决定谁仿真它、谁只做插值。 */
export type EntityOrigin =
  | 'local'   // 本机仿真(唯一会写 physics 的玩家机)
  | 'remote'  // 远端玩家机:只应用网络快照 + 插值
  | 'ai';     // AI 单位:单机由本机仿真;联机剧情模式由 host 仿真并广播

/** 统一飞行器实体。
 *  字段刻意与引擎既有 `EnemyHandle`(`src/lib/game/weapons.ts`)对齐 ——
 *  position / velocity / alive / hp / isAlly / group 同名同义, 这样把既有的
 *  `Enemy` 登记进来时**不需要转换**, 武器系统也能继续用同一套 handle。 */
export interface AircraftEntity {
  readonly id: EntityId;
  readonly origin: EntityOrigin;
  /** 阵营(P0-a 仅记录;P3 起成为唯一敌我判定来源) */
  faction: Faction;
  /** 拥有者的 peerId。AI 僚机归属某个玩家时填该玩家 peerId;
   *  单机 AI 为 undefined。用于"每个玩家自带一个中队僚机"(P3)。 */
  ownerPeerId?: string;

  // === 与 EnemyHandle 对齐的运动学/状态(引用共享, 不复制) ===
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  alive: boolean;
  hp: number;
  /** 渲染根节点(机体 + 尾焰)。 */
  group: THREE.Object3D;

  /** 诊断用显示名。 */
  name: string;

  /** 武器系统里的数字句柄 id。
   *  雷达/HUD 的 blip/marker 需要用它才能"点击选中"这个实体 ——
   *  之前远端实体在雷达上统一 id=-1(与玩家自己的 id 撞号), 点击框选不到目标。
   *  AI 单位沿用引擎既有 id, 远端玩家用负数段(见 net/session.ts NET_HANDLE_BASE)。 */
  handleId?: number;
}

/**
 * 实体注册表。
 *
 * 设计要点:
 *  1. **存引用不拷贝** —— position/velocity 与引擎里的是同一个 Vector3 实例,
 *     所以引擎照旧写它自己的字段, 注册表读到的就是最新值, 不存在"两份状态要同步"。
 *  2. O(1) 查找 + 按 origin/faction 过滤的缓存数组, 但**缓存失效只靠显式调用**
 *     `markDirty()`; P0-a 的飞机集合在一局内不变, 所以几乎不会失效。
 *  3. 不持有 THREE 资源所有权 —— dispose 仍由引擎负责, 注册表只登记。
 */
export class EntityRegistry {
  private readonly _byId = new Map<EntityId, AircraftEntity>();
  private _cache: AircraftEntity[] | null = null;

  register(e: AircraftEntity): void {
    this._byId.set(e.id, e);
    this._cache = null;
  }

  unregister(id: EntityId): void {
    this._byId.delete(id);
    this._cache = null;
  }

  clear(): void {
    this._byId.clear();
    this._cache = null;
  }

  markDirty(): void {
    this._cache = null;
  }

  get(id: EntityId): AircraftEntity | undefined {
    return this._byId.get(id);
  }

  has(id: EntityId): boolean {
    return this._byId.has(id);
  }

  get size(): number {
    return this._byId.size;
  }

  /** 全部实体(顺序稳定: 本地优先, 其余按注册顺序)。 */
  all(): readonly AircraftEntity[] {
    if (!this._cache) {
      const list = Array.from(this._byId.values());
      // 本地实体永远排第一 —— 相机/HUD/结算都依赖"0 号是我"这个直觉。
      list.sort((a, b) => {
        if (a.origin === 'local') return -1;
        if (b.origin === 'local') return 1;
        return 0;
      });
      this._cache = list;
    }
    return this._cache;
  }

  local(): AircraftEntity | undefined {
    return this._byId.get(LOCAL_ENTITY);
  }

  /** 远端玩家机(联机时用于插值渲染)。 */
  remotes(): AircraftEntity[] {
    return this.all().filter((e) => e.origin === 'remote');
  }

  /** AI 单位。 */
  ai(): AircraftEntity[] {
    return this.all().filter((e) => e.origin === 'ai');
  }

  /** 按阵营过滤(联机团队战 / 敌我翻转都靠它)。 */
  byFaction(faction: Faction): AircraftEntity[] {
    return this.all().filter((e) => e.faction === faction);
  }

  /** 存活计数 —— 团队战判定"哪队赢"、个人战判定"谁赢"的基础。 */
  aliveCount(faction?: Faction): number {
    let n = 0;
    for (const e of this._byId.values()) {
      if (!e.alive) continue;
      if (faction && e.faction !== faction) continue;
      n++;
    }
    return n;
  }

  /** 只读快照(诊断 / #diag 面板用)。 */
  debugSnapshot(): { id: EntityId; origin: EntityOrigin; faction: Faction; alive: boolean; hp: number }[] {
    return this.all().map((e) => ({
      id: e.id, origin: e.origin, faction: e.faction, alive: e.alive, hp: e.hp,
    }));
  }
}

/** 由既有的 `spec.isAlly` 推导阵营 —— 单机沿用既有语义, 不引入新判断。 */
export function factionFromAlly(isAlly: boolean): Faction {
  return isAlly ? 'ally' : 'enemy';
}
