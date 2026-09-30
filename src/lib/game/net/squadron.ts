// ============================================================================
// 每玩家中队僚机 (P3-2): "每个玩家自带一个中队僚机"
// ============================================================================
// 需求(用户): 剧情联机里**每个玩家自带一个中队的僚机**。
//
// 为什么不用引擎既有的 this.wingmen:
//   引擎的僚机是"单机玩家的僚机"—— 由本地 AI 直接驱动, 且被 wingman 指令系统
//   (攻击/掩护/编队) 与任务播报共用。联机时僚机是**每个玩家各自的资产**:
//     · 归属明确(ownerPeerId), 只有拥有者仿真它;
//     · 位姿要和自己的飞机**同包广播**(session.maybeSend), 对端插值渲染;
//     · 受到的伤害要路由回拥有者结算(远端射手只报 hit)。
//   所以这里做成一个独立的、拥有者权威的中队模块, 用低模机体(共享几何)。
//
// 与既有武器系统的关系:
//   僚机的机炮**直接写目标句柄的 hp**(`handle.hp -= dmg`) —— 与 weapons.ts 完全
//   同一条路径。若目标是远端单位(RemoteHandle), setter 会捕获伤害并路由给它的
//   拥有者; 若目标是本地仿真的任务 AI, 则直接扣血, 由引擎既有的击毁判定收尾。
//   于是这里不需要任何新的伤害 API。

import * as THREE from 'three';
import {
  type AircraftEntity,
  type EntityRegistry,
  type Faction,
} from './entity';
import type { EnemyHandle } from '../weapons';
import { buildLowPolyAircraft, recolorLowPolyAircraft } from '../models';
import type { AircraftModel } from '../types';
import { sqHash } from './snapshot';

/** 僚机句柄 id 基址(与 net/session 的 NET_HANDLE_BASE / bots 的 PEER_HANDLE_BASE 分开)。 */
export const SQUADRON_HANDLE_BASE = -3000;

/** 僚机编队相对长机的偏移(机体坐标系: +x 右, +y 上, +z 前)。 */
const FORMATION: [number, number, number][] = [
  [-70, -10, -110],
  [70, -10, -110],
  [-140, -20, -210],
  [140, -20, -210],
  [-210, -30, -310],
  [210, -30, -310],
];

/** 机炮: 每发伤害 / 发射间隔(秒) / 有效距离 / 有效夹角。 */
const GUN_DAMAGE = 4.5;
const GUN_INTERVAL = 0.12;
const GUN_RANGE = 1500;
const GUN_ANGLE = Math.cos(THREE.MathUtils.degToRad(16));

export interface SquadronOptions {
  count: number;
  model: AircraftModel;
  /** 对本客户端(IFF)而言的阵营。 */
  faction: Faction;
  ownerPeerId: string;
  ownerName: string;
  /** 拥有者的实体 hash(用于推导僚机 hash)。 */
  ownerHash: number;
}

/** 僚机状态(session 的快照编码用)。 */
export interface SquadronUnitState {
  x: number; y: number; z: number;
  qx: number; qy: number; qz: number; qw: number;
  vx: number; vy: number; vz: number;
  hp: number; alive: boolean;
}

interface SquadUnit {
  slot: number;
  hash: number;
  entity: AircraftEntity;
  handle: EnemyHandle;
  maxHp: number;
  fireT: number;
  lastKillerHash: number;
  lastKillerName: string;
}

/** 中队更新上下文(引擎每帧提供)。 */
export interface SquadronContext {
  ownerPos: THREE.Vector3;
  ownerQuat: THREE.Quaternion;
  ownerForward: THREE.Vector3;
  /** 可攻击的目标句柄(敌对阵营: 远端玩家 + 任务 AI)。 */
  hostiles: EnemyHandle[];
  /** 是否允许开火(死亡/未开战时可关闭)。 */
  engage: boolean;
}

export class WingmanSquadron {
  /** 本队是否在场。长机阵亡 → 退场消失(per user request), 复活 → 归队。 */
  private deployed = true;
  private readonly units: SquadUnit[] = [];
  private readonly root = new THREE.Group();
  private readonly hashOfSlot = new Map<number, number>();

  constructor(
    private readonly registry: EntityRegistry,
    scene: THREE.Scene,
    private readonly opts: SquadronOptions,
  ) {
    scene.add(this.root);
    this.build();
  }

  /** 中队规模。 */
  get count(): number {
    return this.units.length;
  }

  get aliveCount(): number {
    return this.units.reduce((n, u) => n + (u.entity.alive ? 1 : 0), 0);
  }

  private build(): void {
    const n = Math.max(0, Math.min(this.opts.count, FORMATION.length));
    for (let i = 0; i < n; i++) {
      const slot = i + 1;
      const hash = sqHash(this.opts.ownerHash, slot);
      const mesh = new THREE.Group();
      mesh.add(buildLowPolyAircraft(this.opts.model, this.opts.faction));
      this.root.add(mesh);
      const hp = 100;
      const id = `sq:${slot}`;
      const handle: EnemyHandle = {
        id: SQUADRON_HANDLE_BASE - i,
        group: mesh,
        position: mesh.position,
        velocity: new THREE.Vector3(),
        alive: true,
        hp,
        isBomber: false,
        isAlly: this.opts.faction !== 'enemy',
        name: `${this.opts.ownerName}-${slot}`,
        unitType: 'aircraft_fighter',
      };
      const entity: AircraftEntity = {
        id,
        origin: 'ai',
        faction: this.opts.faction,
        ownerPeerId: this.opts.ownerPeerId,
        position: mesh.position,
        velocity: handle.velocity,
        alive: true,
        hp,
        group: mesh,
        name: handle.name,
        handleId: handle.id,
      };
      this.registry.register(entity);
      this.units.push({
        slot, hash, entity, handle, maxHp: hp, fireT: Math.random() * GUN_INTERVAL,
        lastKillerHash: 0, lastKillerName: '',
      });
      this.hashOfSlot.set(slot, hash);
    }
    this.registry.markDirty();
  }

  markDirty(): void {
    this.registry.markDirty();
  }

  /** 僚机 hash 列表(诊断/对账用)。 */
  hashes(): number[] {
    return this.units.map((u) => u.hash);
  }

  /** slot(1 起) → hash。 */
  hashForSlot(slot: number): number {
    return this.hashOfSlot.get(slot) ?? 0;
  }

  /** 武器句柄(引擎把己方中队的句柄放进 allyHandles, 于是敌机武器能打它们)。 */
  handles(): EnemyHandle[] {
    // 退场期间不给句柄: 敌人打不到、Tab 也选不到(它们已经离开战场了)。
    if (!this.deployed) return [];
    return this.units.filter((u) => u.handle.alive).map((u) => u.handle);
  }

  handleById(id: number): EnemyHandle | undefined {
    return this.units.find((u) => u.handle.id === id)?.handle;
  }

  entityByHash(hash: number): AircraftEntity | undefined {
    return this.units.find((u) => u.hash === hash)?.entity;
  }

  unitStates(): SquadronUnitState[] {
    return this.units.map((u) => ({
      x: u.entity.position.x, y: u.entity.position.y, z: u.entity.position.z,
      qx: u.entity.group.quaternion.x, qy: u.entity.group.quaternion.y,
      qz: u.entity.group.quaternion.z, qw: u.entity.group.quaternion.w,
      vx: u.entity.velocity.x, vy: u.entity.velocity.y, vz: u.entity.velocity.z,
      hp: Math.max(0, Math.round(u.handle.hp)),
      alive: u.entity.alive,
    }));
  }

  /** 切阵营(IFF 翻转: 僚机从友军变敌军时, 颜色与 isAlly 必须同时改)。 */
  setFaction(faction: Faction): void {
    this.opts.faction = faction;
    for (const u of this.units) {
      u.entity.faction = faction;
      u.handle.isAlly = faction !== 'enemy';
      recolorLowPolyAircraft(u.entity.group, faction);
    }
    this.registry.markDirty();
  }

  /**
   * 受到伤害(由联机会话路由过来: 远端射手打中了我的僚机)。
   * 返回本单位的显示名, 便于播报。
   */
  applyDamage(slot: number, damage: number, killerHash: number, killerName: string): boolean {
    if (!this.deployed) return false;
    const u = this.units.find((x) => x.slot === slot);
    if (!u || !u.entity.alive) return false;
    u.handle.hp -= damage;
    if (killerHash) { u.lastKillerHash = killerHash; u.lastKillerName = killerName; }
    if (u.handle.hp <= 0) {
      this.killUnit(u);
      return true;
    }
    return false;
  }

  private killUnit(u: SquadUnit): void {
    if (!u.entity.alive) return;
    u.handle.alive = false;
    u.entity.alive = false;
    u.entity.hp = 0;
    u.entity.group.visible = false;
    // 记录待广播的击毁(拥有者权威: 只有我能宣布自己僚机的死亡)
    this.pendingDeaths.push({
      slot: u.slot, name: u.handle.name,
      killerHash: u.lastKillerHash, killerName: u.lastKillerName,
    });
    this.registry.markDirty();
  }

  /** 复活整个中队(长机 13 秒后复活时一起归队)。 */
  reviveAll(): void {
    for (const u of this.units) {
      u.handle.hp = u.maxHp;
      u.handle.alive = true;
      u.entity.alive = true;
      u.entity.hp = u.maxHp;
      u.entity.group.visible = true;
      // 直接贴到长机后方, 避免从旧位置"飞回来"
      u.entity.position.copy(this.lastOwnerPos).addScaledVector(this.lastOwnerForward, -120 * u.slot);
    }
    this.registry.markDirty();
  }

  /**
   * 中队在场/退场 (per user request: 联机剧情模式里玩家阵亡后僚机退场消失,
   * 直到玩家重新出生时再度出现)。
   *
   * 退场 = 全体隐藏 + 不再提供句柄 + 不再出手; 归队 = 贴到长机后方重新出现。
   * 与 killUnit() 的区别: 退场**不改变生死**, 只是编队撤离 —— 所以复活归队后
   * 存活的僚机仍在, 阵亡的仍要靠 reviveAll() 才回来。
   */
  setDeployed(on: boolean): void {
    if (this.deployed === on) return;
    this.deployed = on;
    for (const u of this.units) {
      u.entity.group.visible = on && u.entity.alive;
      if (on && u.entity.alive) {
        // 归队: 直接贴到长机后方(与 reviveAll 同一手法, 避免从旧位置飞回来)
        u.entity.position.copy(this.lastOwnerPos).addScaledVector(this.lastOwnerForward, -120 * u.slot);
        u.entity.velocity.set(0, 0, 0);
      }
    }
    this.registry.markDirty();
  }

  isDeployed(): boolean { return this.deployed; }

  private readonly lastOwnerPos = new THREE.Vector3();
  private readonly lastOwnerForward = new THREE.Vector3(0, 0, 1);

  /**
   * 每帧推进。
   *
   * 运动刻意做得简单(编队跟随 + 朝向目标), 因为僚机是"玩家资产", 不是全 AI:
   * 真正的空战 AI 在引擎里(任务 AI/单机僚机), 这里只需要"跟着你、帮你打"。
   */
  update(dt: number, ctx: SquadronContext): void {
    this.lastOwnerPos.copy(ctx.ownerPos);
    this.lastOwnerForward.copy(ctx.ownerForward);
    if (!this.deployed) return;
    // 选一个目标: 最靠近长机前半球的那个
    const target = ctx.engage ? this.pickTarget(ctx) : null;
    const tmp = new THREE.Vector3();
    for (const u of this.units) {
      if (!u.entity.alive) continue;
      // 1) 编队位置(机体坐标系 → 世界)
      const off = FORMATION[Math.min(u.slot - 1, FORMATION.length - 1)];
      const desired = tmp.set(off[0], off[1], off[2]).applyQuaternion(ctx.ownerQuat).add(ctx.ownerPos);
      const to = desired.clone().sub(u.entity.position);
      const dist = to.length();
      const speed = THREE.MathUtils.clamp(dist * 1.2, 70, 430);
      if (dist > 1) to.normalize().multiplyScalar(speed);
      // 速度平滑(避免抖动)
      const k = 1 - Math.exp(-2.2 * dt);
      u.entity.velocity.lerp(to, k);
      u.entity.position.addScaledVector(u.entity.velocity, dt);
      // 2) 朝向: 有目标且在前半球 → 转向目标; 否则沿速度方向
      const faceDir = new THREE.Vector3();
      if (target) {
        const toT = target.position.clone().sub(u.entity.position);
        const d = toT.length();
        toT.normalize();
        if (d < GUN_RANGE * 1.6) faceDir.copy(toT);
      }
      if (faceDir.lengthSq() < 1e-6 && u.entity.velocity.lengthSq() > 1e-4) {
        faceDir.copy(u.entity.velocity).normalize();
      }
      if (faceDir.lengthSq() > 1e-6) {
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), faceDir);
        u.entity.group.quaternion.slerp(q, 1 - Math.exp(-3.5 * dt));
      }
      // 3) 机炮: 距离/夹角合适就开火(直接写目标句柄 hp —— 远端会被路由给拥有者)
      u.fireT -= dt;
      if (target && u.fireT <= 0) {
        const toT = target.position.clone().sub(u.entity.position);
        const d = toT.length();
        if (d < GUN_RANGE) {
          toT.normalize();
          const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(u.entity.group.quaternion);
          if (fwd.dot(toT) > GUN_ANGLE) {
            u.fireT = GUN_INTERVAL;
            target.hp -= GUN_DAMAGE;
          }
        }
      }
      // 4) 本地受击死亡(本地 AI 武器直接扣的血) → 判定击毁并记录
      if (u.handle.hp <= 0 && u.entity.alive) this.killUnit(u);
    }
  }

  /** 本帧新击毁的僚机(引擎拿去广播 kill 事件)。 */
  private pendingDeaths: { slot: number; name: string; killerHash: number; killerName: string }[] = [];

  /** 供引擎调用: 取出待广播的僚机击毁。 */
  takeDeaths(): { slot: number; name: string; killerHash: number; killerName: string }[] {
    const out = this.pendingDeaths;
    this.pendingDeaths = [];
    return out;
  }

  private pickTarget(ctx: SquadronContext): EnemyHandle | null {
    let best: EnemyHandle | null = null;
    let bestScore = -Infinity;
    for (const h of ctx.hostiles) {
      if (!h.alive) continue;
      const to = h.position.clone().sub(ctx.ownerPos);
      const d = to.length();
      if (d > 6000) continue;
      to.normalize();
      const score = to.dot(ctx.ownerForward) - d / 20000;
      if (score > bestScore) { bestScore = score; best = h; }
    }
    return best;
  }

  clear(): void {
    for (const u of this.units) {
      this.registry.unregister(u.entity.id);
      this.root.remove(u.entity.group);
    }
    this.units.length = 0;
    this.hashOfSlot.clear();
    this.registry.markDirty();
  }
}
