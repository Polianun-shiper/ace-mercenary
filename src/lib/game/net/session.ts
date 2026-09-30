// ============================================================================
// 联机会话 (P2): 快照收发 + 远端实体驱动 + 命中/击毁/积分 (P2 收尾)
// ============================================================================
// 职责:
//   · 20Hz 把本地玩家(和自己的中队)位姿编码为二进制, 走 room.sendRealtime(可丢通道)
//   · 收到远端快照 → 喂给插值器 → 每帧把插值结果写进实体注册表里的远端实体
//   · 用**可靠通道**交换 peerId ↔ hash 映射(见 snapshot.ts 的 hashOfPeer 说明)
//   · 命中/击毁/复活/积分/开战结束全部走可靠通道(事件不可丢)
//
// 严格遵循同步模型(owner-authoritative / state-sync):
//   · **每个客户端只全仿真自己拥有的单位**(自己那架 + 自己的中队僚机);
//     别人的飞机只做插值渲染, 不跑物理, 也不由本地扣血。
//   · 因此"打到别人的飞机"不能本地结算 —— 必须把伤害**路由给拥有者**:
//       射手本地武器命中远端句柄 → 捕获 hp 差值 → 可靠事件 hit → 拥有者扣血
//       拥有者扣到 0 → 广播 kill → 所有客户端记分/播报/机体消失
//     这套"拥有者权威"让伤害数字只有一个真相源, 不会出现两边各扣一次。
//   · 任务 AI(剧情联机)由各端**本地仿真**(同一任务脚本), 击毁后广播 aiDead
//     让所有端把同一架 AI 标记为死 —— 不需要为 AI 再做一套快照。
//   · 本文件不写任何数据库: 位置/姿态只在内存与 P2P 之间流动。
//
// 与实体注册表的关系: 远端实体由本模块**创建/更新/销毁**, 引擎的相机/雷达/HUD
// 通过注册表自动看到它们 —— 所以这里不需要碰引擎的渲染代码。

import * as THREE from 'three';
import {
  type AircraftEntity,
  type EntityRegistry,
  type Faction,
  peerEntityId,
} from './entity';
import { RemoteInterpolator } from './interpolate';
import { logInfo, logOk, logWarn, logNet, makeThrottle } from './debug-log';
import { buildLowPolyAircraft, recolorLowPolyAircraft } from '../models';
import type { EnemyHandle, DamageKind } from '../weapons';
import type { AircraftModel } from '../types';
import {
  SNAP_ALIVE, SNAP_DEAD,
  aiHash,
  decodePoses, encodePoses, hashOfPeer, isAiHash, poseBytes, sqHash, SNAP_MAX_RECORDS,
  type PoseSnapshot,
} from './snapshot';

/** 快照发送频率(规范: 15~20Hz)。 */
export const SNAPSHOT_HZ = 20;
/** 命中事件的合并节流(ms): 机炮每秒 20 发, 不合并会刷爆可靠通道。 */
const HIT_FLUSH_MS = 100;
/** 远端玩家机使用的低面数机型(共享几何, 不加载真实 OBJ)。 */
const REMOTE_MODEL: AircraftModel = 'f16';
/** 本地玩家被击毁后的默认复活等待(秒) —— 由房间设置覆盖(用户指定 13)。 */
export const DEFAULT_RESPAWN_SEC = 13;
/** 远端句柄 id 基址(-2000 段; 小队句柄在其上方, 负数段各占各的, 不撞号)。 */
export const NET_HANDLE_BASE = -2000;

/** P5: 房主提供的"任务 AI 当前位姿"来源。 */
export type AiPoseFn = () => {
  id: number; x: number; y: number; z: number;
  qx: number; qy: number; qz: number; qw: number;
  vx: number; vy: number; vz: number;
  hp: number; alive: boolean;
}[] | null;

/** 本地中队(自己的僚机队)向会话暴露的最小接口 —— 由引擎注入, 避免模块循环依赖。 */
export interface SquadronPoseSource {  /** 返回本客户端**拥有**的僚机状态(slot 从 1 开始, 顺序稳定)。 */
  unitStates(): {
    x: number; y: number; z: number;
    qx: number; qy: number; qz: number; qw: number;
    vx: number; vy: number; vz: number;
    hp: number; alive: boolean;
  }[];
}

/** 击毁播报条目(HUD 击杀信息条用)。 */
export interface KillFeedItem {
  id: number;
  killer: string;
  victim: string;
  /** killer/victim 里是否包含自己(高亮用)。 */
  selfInvolved: boolean;
  at: number;
}

/** 积分板一行。 */
export interface NetScoreRow {
  peerId: string;
  name: string;
  team: number;
  kills: number;
  deaths: number;
  isSelf: boolean;
}

/** 交给 HUD/结算的联机 UI 状态(引擎每帧取一次)。 */
export interface NetUiState {
  active: boolean;
  roomId: string;
  isHost: boolean;
  selfTeam: number;
  players: NetScoreRow[];
  teamScores: Record<string, number>;
  feed: KillFeedItem[];
  /** 本地玩家是否处于被击毁等待复活状态。 */
  dead: boolean;
  /** 复活倒计时(秒, 0 = 可以复活)。 */
  respawnIn: number;
  respawnReady: boolean;
  /** 权威方已宣布结束(等待结算)。 */
  matchOver: boolean;
  peers: number;
  pingMs: number;
}

/** 击毁/命中事件用的可靠消息类型。 */
type NetEvent =
  | { t: 'who'; peerId: string; hash: number; name: string; team: number; squad: number; kills?: number; deaths?: number }   // 身份握手
  | { t: 'kill'; killerHash: number; victimHash: number; killerName: string; victimName: string }   // 击毁(拥有者广播)
  | { t: 'aiDead'; aiId: number; aiName: string; killerHash: number; killerName: string }           // 任务 AI 被击毁
  | { t: 'hit'; victimHash: number; damage: number; byHash: number; byName: string; kind?: DamageKind }                // 伤害路由(射手→拥有者)
  | { t: 'respawn'; hash: number }                                                                  // 复活
  | { t: 'left'; peerId: string }
  | { t: 'matchend'; at: number };

export interface NetSessionStats {
  outboundPoseBytes: number;
  inboundPoseBytes: number;
  snapshotsSent: number;
  snapshotsReceived: number;
  remoteCount: number;
  peers: number;
  hitsSent: number;
  hitsReceived: number;
  killsSent: number;
  killsReceived: number;
  /** P5: 本帧写回本地的任务 AI 位姿数。 */
  aiPosesApplied: number;
}

type RoomLike = {
  peerId: string;
  isHost: boolean;
  roomId?: string;
  send(m: unknown, to?: string): void;
  sendRealtime(m: unknown, to?: string): void;
  onMessage(cb: (m: unknown, from: string) => void): unknown;
  peers(): { id: string; open: boolean; latency: number }[];
  /** SDK 给出的房主 peerId(P4 抗作弊: 只接受房主的 matchend)。 */
  hostId?: string | null;
};

// ============================================================================
// P4 抗作弊边界(信任模型的现实上限)
// ============================================================================
// 本作是 **owner-authoritative P2P**: 自己的单位自己说了算。这种模型下有一条
// 无法用客户端逻辑消灭的作弊面 —— **玩家可以对自己的存活/位置撒谎**(P2P 没有
// 权威服务器, 除非把权威搬上服务端)。
// 能做而且值得做的是把**跨实体的主张**变成不可伪造:
//   · 身份: who 必须"自称的 peerId == 发信人", 且 hash 必须与 peerId 一致 →
//     无法冒充别人的身份/顶掉别人的 hash 映射。
//   · 生死: kill 只接受**受害者拥有者**发来的(谁敢宣布别人死 = 丢弃) →
//     无法伪造"我击毁了 X"来刷分。
//   · 战果: aiDead 只接受 killerHash == 发信人自身 hash → 无法把别人的战果算给自己。
//   · 伤害: hit 只接受发给"我拥有的单位"的, 且单次伤害夹到 MAX_HIT_DAMAGE、
//     每秒 hit 数限流 → 无法一发 99999 秒杀。
//   · 结算: matchend 只接受 SDK 指定的房主(room.hostId)。
//   · 洪水: 每个对端的可靠事件做令牌桶限流。
// 被拒的包一律丢弃并计数(见 debug().rejected), 便于现场取证。

/** P4 抗作弊: 单次 hit 事件允许的最大伤害(最大单发导弹 ~180, 留一倍余量)。 */
export const MAX_HIT_DAMAGE = 400;
/** P4 抗作弊: 每个对端每秒允许的可靠事件数(命中会合并, 正常远低于此)。 */
const MAX_EVENTS_PER_SEC = 120;
/** P4 抗作弊: 每个对端每秒允许的 hit 事件数。 */
const MAX_HITS_PER_SEC = 40;
/** P4 抗作弊: who 里 kills/deaths 的上限(超出的数字一律夹住)。 */
const MAX_SCORE_VALUE = 9999;

/** 远端单位(远端玩家 = slot 0; 远端玩家的僚机 = slot 1..N)。 */
interface RemoteUnit {
  hash: number;
  ownerPeerId: string;
  ownerHash: number;
  slot: number;
  entity: AircraftEntity;
  handle: RemoteHandle;
  lastSeenMs: number;
}

/**
 * 远端单位的武器句柄。
 *
 * **关键技巧**: `hp` 用访问器而不是普通字段 —— weapons.ts 是直接写
 * `e.hp -= dmg` 的, 用 setter 就能**捕获本地武器打出的伤害**, 从而把它路由给
 * 拥有者。这样 weapons.ts / 引擎的既有命中链路一行都不用改。
 *
 * 从快照镜像血量时走 `mirrorHp()`(直接写私有字段), 不会把自己收到的血当成伤害。
 */
class RemoteHandle {
  id: number;
  group: THREE.Group;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  alive = true;
  isBomber = false;
  isAlly: boolean;
  name: string;
  unitType = 'aircraft_fighter';
  lastDamagerKind?: 'player' | 'wingman' | 'ally' | 'enemy' | 'ground';
  /** 上一次被本地武器设置的伤害者(用于把击杀归给正确的射手)。 */
  lastDamagerHash = 0;
  lastDamagerName = '';
  /** 待发送给拥有者的累计伤害。 */
  pendingDamage = 0;
  /**
   * 待发送的**武器类型**(per user request: 只有导弹命中才播受击音效)。
   *
   * 与 pendingDamage 同一生命周期: 武器系统在 `hp -= dmg` 之前写 lastWeaponKind,
   * 这里合并到 100ms 一次的上报里; 拥有者据此决定播不播受击音效。
   * 合并期内混了多种武器时**导弹优先** —— 它才是需要那声反馈的事件。
   */
  private pendingKind: DamageKind = 'other';

  private _hp = 100;

  constructor(init: {
    id: number; group: THREE.Group; position: THREE.Vector3; velocity: THREE.Vector3;
    isAlly: boolean; name: string;
  }) {
    this.id = init.id;
    this.group = init.group;
    this.position = init.position;
    this.velocity = init.velocity;
    this.isAlly = init.isAlly;
    this.name = init.name;
  }

  get hp(): number {
    return this._hp;
  }

  /** 本地武器系统扣血 → 捕获伤害(路由给拥有者), 同时更新本地显示血量。 */
  set hp(v: number) {
    const dmg = this._hp - v;
    if (dmg > 0 && Number.isFinite(dmg)) this.pendingDamage += dmg;
    this._hp = Math.max(0, v);
  }

  /** 用网络快照镜像血量(不产生伤害事件)。 */
  mirrorHp(v: number): void {
    this._hp = Math.max(0, v);
  }

  /**
   * 武器系统写"这一发是什么打的"(见 weapons.ts 的 EnemyHandle.lastWeaponKind)。
   *
   * 写成访问器而不是普通字段, 是为了**捕获**写动作 —— 与 hp 访问器捕获伤害同一思路,
   * 武器系统那边完全不必知道联机的存在。
   */
  set lastWeaponKind(k: DamageKind) {
    if (k === 'missile') this.pendingKind = 'missile';
    else if (k === 'gun' && this.pendingKind !== 'missile') this.pendingKind = 'gun';
    else if (k === 'laser' && this.pendingKind === 'other') this.pendingKind = 'laser';
  }

  get lastWeaponKind(): DamageKind {
    return this.pendingKind;
  }

  /** 取走本次上报要带的武器类型并复位。 */
  takeDamageKind(): DamageKind {
    const k = this.pendingKind;
    this.pendingKind = 'other';
    return k;
  }
}

export class NetSession {
  private room: RoomLike | null = null;
  private readonly interp = new RemoteInterpolator();
  private readonly registry: EntityRegistry;

  /** 本地实体 hash(自己的快照用它标识)。 */
  private selfHash = 0;
  /** hash ↔ peerId 双向映射(经可靠通道握手建立)。 */
  private hashToPeer = new Map<number, string>();
  /** 每个 hash 的拥有者 peerId(中队单位的 hash 也要能路由回拥有者)。 */
  private hashOwner = new Map<number, string>();
  private peerToHash = new Map<string, number>();
  /** 远端玩家声明的中队规模(who 握手)。 */
  private peerSquad = new Map<string, number>();

  private units = new Map<number, RemoteUnit>();
  private nextHandleIndex = 0;

  private lastSendMs = 0;
  private lastFlushMs = 0;
  private stats: NetSessionStats = {
    outboundPoseBytes: 0, inboundPoseBytes: 0,
    snapshotsSent: 0, snapshotsReceived: 0, remoteCount: 0, peers: 0,
    hitsSent: 0, hitsReceived: 0, killsSent: 0, killsReceived: 0, aiPosesApplied: 0,
  };

  /** 本地状态提供者 —— 由引擎每帧注入(避免本模块依赖引擎)。 */
  private localState: (() => {
    x: number; y: number; z: number;
    qx: number; qy: number; qz: number; qw: number;
    vx: number; vy: number; vz: number;
    hp: number; alive: boolean; afterburner: boolean; firing: boolean; airbrake: boolean;
    team: number;
  }) | null = null;

  /** 本地中队位姿来源(联机剧情: 每个玩家自带一个中队僚机)。 */
  private squadron: SquadronPoseSource | null = null;

  // ==========================================================================
  // P5: 任务 AI 位姿的房主权威同步
  // ==========================================================================
  // 之前任务 AI 是**各端本地仿真**: 同一架敌机在两台机器上会飞到不同地方(目标
  // 选择/帧率差异会放大), 队友看到的战场和你看到的对不上。P5 的做法: **房主**把
  // 任务 AI 的位姿塞进自己那份快照包(与玩家/僚机同一通道, 32B/单位), 客户端拿到
  // 后每帧校正 —— 于是两端的 AI 位置收敛到插值延迟量级(几十米), 而不是各飞各的。
  //
  // 为什么不像玩家那样"客户端完全不仿真 AI": 任务 AI 的**武器/弹道**目前没有同步,
  // 若客户端不跑 AI 就再也看不到敌机开火(观感明显变差)。所以这里是"位姿以房主为
  // 权威 + 客户端继续本地跑 AI 行为": 位姿一致、开火/伤害维持现状。若要强权威,
  // 需要把 AI 的弹道/开火事件一起同步(留作后续)。
  private aiPoseSource: AiPoseFn | null = null;
  /** aiHash → 任务 AI 的数字 id(两端各自用本地 AI 列表注册, id 确定性一致)。 */
  private readonly aiIdByHash = new Map<number, number>();
  /** 客户端拿到房主给的 AI 位姿时的回调(由引擎注入, 把位姿写回本地 AI 单位)。 */
  onAiPose: ((id: number, pose: {
    position: THREE.Vector3; quaternion: THREE.Quaternion; hp: number; alive: boolean;
  }) => void) | null = null;
  /** 回调复用对象(每帧每个 AI 一次, 避免每帧新建 Vector3/Quaternion)。 */
  private readonly aiPoseScratch = {
    position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), hp: 0, alive: true,
  };

  constructor(registry: EntityRegistry, scene?: THREE.Scene) {
    this.registry = registry;
    this.scene = scene ?? null;
  }

  /** 可选的场景引用: 远端实体首次出现时把占位 group 挂进场景, 便于诊断可视化。 */
  private readonly scene: THREE.Scene | null;

  /** 本地最多能塞进一包的记录数(P5: AI 位姿按此顺延)。 */
  static readonly maxRecordsPerPacket = SNAP_MAX_RECORDS;

  get active(): boolean {
    return !!this.room;
  }

  get selfEntityHash(): number {
    return this.selfHash;
  }

  get selfPeerId(): string {
    return this.room?.peerId ?? '';
  }

  get isHost(): boolean {
    return !!this.room?.isHost;
  }

  /** SDK 指定的房主 peerId(P4: 结算与 matchend 的权威判定; 未知时为空串)。 */
  get hostPeerId(): string {
    return this.room?.hostId ?? '';
  }

  // ==========================================================================
  // 回调(由引擎注入)
  // ==========================================================================

  /** 本地玩家受到远端伤害(已路由到我这里, 由我扣血)。 */
  onLocalDamage: ((damage: number, byHash: number, byName: string, kind?: DamageKind) => void) | null = null;
  /** 本地中队的僚机受到远端伤害(由我扣血)。slot 从 1 开始。 */
  onOwnedDamage: ((slot: number, damage: number, byHash: number, byName: string) => void) | null = null;
  /** 任务 AI 被任意玩家击毁(所有端同步标记)。 */
  onAiDead: ((aiId: number, aiName: string, killerHash: number, killerName: string) => void) | null = null;
  /** 本地玩家击毁他人(killerHash === selfHash) —— 供 HUD 播报。 */
  onKill: ((killerPeerId: string, victimPeerId: string) => void) | null = null;
  /** 权威方宣布本局结束。 */
  onMatchEnd: (() => void) | null = null;

  // ==========================================================================
  // P4: 抗作弊状态(限流 + 拒绝计数)
  // ==========================================================================

  /** 被拒绝的包计数(按类别), 现场取证用。 */
  private rejected: Record<string, number> = { identity: 0, kill: 0, aiDead: 0, hit: 0, matchend: 0, flood: 0 };
  /** 每个对端的可靠事件令牌桶(防洪)。 */
  private readonly evBucket = new Map<string, { tokens: number; at: number }>();
  /** 每个对端的 hit 令牌桶。 */
  private readonly hitBucket = new Map<string, { tokens: number; at: number }>();
  /** 高频日志节流。 */
  private readonly logT = makeThrottle(1500);

  /**
   * 令牌桶放行判定。`rate` = 每秒补充量, 桶容量 = rate(允许一秒突发)。
   * 返回 false 表示超限 → 调用方丢弃该包并计 flood 拒绝。
   */
  private allow(bucket: Map<string, { tokens: number; at: number }>, peer: string, rate: number, now = performance.now()): boolean {
    let b = bucket.get(peer);
    if (!b) { b = { tokens: rate, at: now }; bucket.set(peer, b); }
    const dt = Math.max(0, now - b.at) / 1000;
    b.tokens = Math.min(rate, b.tokens + dt * rate);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private reject(kind: keyof NetSession['rejected']): void {
    this.rejected[kind] = (this.rejected[kind] ?? 0) + 1;
    // 被拒的包会很多(洪水/竞态), 日志里每秒最多记一条, 但保留累计计数
    this.logT('reject', () => {
      logWarn(`抗作弊: 已拒绝 ${Object.entries(this.rejected).map(([k, v]) => `${k}×${v}`).join(' ')}`);
    });
  }

  // ==========================================================================
  // 绑定 / 解绑
  // ==========================================================================

  /**
   * 绑定房间并开始收发。
   *
   * @param room  SDK 的 Room 实例
   * @param name  本地玩家呼号(用于远端显示)
   */
  attach(room: unknown, name: string): void {
    const r = room as RoomLike;
    this.room = r;
    this.selfName = name || 'PILOT';
    this.selfHash = hashOfPeer(r.peerId);
    this.hashToPeer.set(this.selfHash, r.peerId);
    this.hashOwner.set(this.selfHash, r.peerId);
    r.onMessage((msg, from) => this.onMessage(msg, from));
    logOk(`联机会话已绑定房间 ${r.roomId ?? '?'} · peerId=${r.peerId.slice(0, 10)} · ${r.isHost ? '房主' : '成员'} · 我的 hash=${this.selfHash}`);
    // 身份握手: 用**可靠通道**广播自己的 peerId↔hash(快照只带 hash, 省带宽)。
    // 一并带上中队规模与当前积分 —— 后来者据此即可算出我的僚机 hash 与总分。
    this.sendWho();
  }

  detach(): void {
    this.room = null;
    this.interp.clear();
    this.hashToPeer.clear();
    this.hashOwner.clear();
    this.peerToHash.clear();
    this.peerSquad.clear();
    for (const u of this.units.values()) this.registry.unregister(u.entity.id);
    this.units.clear();
    // 远端实体由引擎在下一次 reset 时清理; 这里只清网络态。
  }

  private sendWho(to?: string): void {
    if (!this.room) return;
    this.sendEvent({
      t: 'who', peerId: this.room.peerId, hash: this.selfHash,
      name: this.selfName, team: this.selfTeam,
      squad: this.squadronSlots(),
      kills: this.selfKills, deaths: this.selfDeaths,
    }, to);
  }

  /** 引擎每帧注入"如何读取本地状态"。 */
  setLocalStateProvider(fn: NonNullable<NetSession['localState']>): void {
    this.localState = fn;
  }

  /** 注入本地中队位姿来源(联机剧情模式; 单机/对战可不存在)。 */
  setSquadron(sq: SquadronPoseSource | null): void {
    this.squadron = sq;
    // 中队规模变了要重新握手, 让对端知道该为我预留几个 hash。
    if (this.room) this.sendWho();
  }

  /** 房主注入"任务 AI 的当前位姿"; 客户端传 null。 */
  setAiPoseSource(fn: AiPoseFn | null): void {
    this.aiPoseSource = fn;
  }

  /**
   * 注册本地任务 AI 的 id 列表(P5)。
   *
   * 两端各自用**本地** AI 列表注册 → hash→id 映射天然一致(任务 id 确定性),
   * 不需要在网络上交换 id 表。波次生成新 AI 时重新调用即可(幂等)。
   */
  registerAiIds(ids: number[]): void {
    for (const id of ids) {
      const h = aiHash(id);
      if (!this.aiIdByHash.has(h)) this.aiIdByHash.set(h, id);
      // 同时确保它不会被当成玩家单位: AI hash 与玩家/僚机 hash 空间结构性分离,
      // 但历史遗留的噪声记录要清掉(见 onMessage 里的 isAiHash 说明)。
      this.hashToPeer.delete(h);
      this.hashOwner.delete(h);
    }
  }

  /** 当前注册的任务 AI 数量(诊断)。 */
  get aiTrackCount(): number {
    return this.aiIdByHash.size;
  }

  /** 本地队伍变更时通知(用于快照里的 team 字段)。 */
  setSelfTeam(team: number): void {
    this.selfTeam = team;
    if (this.room) this.sendWho();
  }
  private selfTeam = 255;

  /** 本地玩家名(重连后重发 who)。 */
  private selfName = 'PILOT';
  setSelfName(n: string): void {
    this.selfName = n;
    if (this.room) this.sendWho();
  }

  /** 复活等待(秒) —— 房间设置。 */
  private respawnSec = DEFAULT_RESPAWN_SEC;
  setRespawnDelay(sec: number): void {
    this.respawnSec = Math.max(1, sec);
  }

  /** 本地玩家被击毁的时刻(0 = 未死)。 */
  private localDeadAt = 0;
  private matchOver = false;

  /** 引擎在本地玩家死亡/复活时调用。 */
  setLocalDead(dead: boolean, nowMs = performance.now()): void {
    this.localDeadAt = dead ? nowMs : 0;
    if (!dead) {
      this.interp.remove(this.selfHash);
      this.sendEvent({ t: 'respawn', hash: this.selfHash });
    }
  }

  get localDead(): boolean {
    return this.localDeadAt > 0;
  }

  /** 复活倒计时(秒); 0 = 可以复活。 */
  respawnRemaining(nowMs = performance.now()): number {
    if (!this.localDeadAt) return 0;
    return Math.max(0, this.respawnSec - (nowMs - this.localDeadAt) / 1000);
  }

  // ==========================================================================
  // 发送
  // ==========================================================================

  private sendEvent(e: NetEvent, to?: string): void {
    this.room?.send(e, to);
  }

  /**
   * 伤害路由: 把本地武器打到远端单位的伤害发给它的拥有者。
   *
   * 合并发送(10Hz): 机炮每秒 20 发, 每发都发一个可靠事件会刷爆通道;
   * 100ms 合并一次, 伤害数值累加 —— 拥有者收到的总伤害不变。
   */
  private flushOutboundDamage(nowMs: number): void {
    if (!this.room) return;
    if (nowMs - this.lastFlushMs < HIT_FLUSH_MS) return;
    this.lastFlushMs = nowMs;
    for (const u of this.units.values()) {
      if (u.handle.pendingDamage < 0.5) continue;
      const dmg = u.handle.pendingDamage;
      u.handle.pendingDamage = 0;
      // 武器类型与伤害一起上报: 拥有者靠它决定"这声受击音效该不该响"。
      this.sendEvent({
        t: 'hit', victimHash: u.hash, damage: dmg,
        byHash: this.selfHash, byName: this.selfName,
        kind: u.handle.takeDamageKind(),
      }, u.ownerPeerId);
      this.stats.hitsSent++;
    }
  }

  // ==========================================================================
  // 接收
  // ==========================================================================

  private onMessage(msg: unknown, from: string): void {
    // 二进制 = 位姿快照(走可丢通道)
    if (msg instanceof ArrayBuffer) {
      const poses = decodePoses(msg, performance.now());
      this.stats.inboundPoseBytes += msg.byteLength;
      this.stats.snapshotsReceived++;
      this.interp.ingest(poses, performance.now());
      // 顺带记录 hash→peer(即使 who 包丢了也能兜住)。
      // ⚠ P5: **任务 AI 的记录不能进 hash→peer 表** —— 否则它们会被当成远端玩家单位
      // 建出"幻影实体"(实测: 客户端看到 7 个敌对句柄而不是 1 个, 开火打在幻影上)。
      // AI 的 hash 最高位为 1(见 snapshot.isAiHash), 所以这里不看表就能分辨。
      for (const p of poses) {
        if (isAiHash(p.entityHash)) continue;
        if (!this.hashToPeer.has(p.entityHash)) this.hashToPeer.set(p.entityHash, from);
        if (!this.hashOwner.has(p.entityHash)) this.hashOwner.set(p.entityHash, from);
      }
      return;
    }
    // 对象 = 可靠事件
    const e = msg as NetEvent;
    if (!e || typeof e !== 'object' || !('t' in e)) return;
    // === P4: 全局限流(每个对端) ===
    // 被洪水的客户端会卡在消息处理上, 也会把记分板刷成垃圾。除了心跳/身份握手
    // (who) 之外的所有可靠事件都走令牌桶; who 允许稍高配额(心跳 2.5s 一次)。
    const floodBudget = e.t === 'who' ? MAX_EVENTS_PER_SEC * 2 : MAX_EVENTS_PER_SEC;
    if (!this.allow(this.evBucket, from, floodBudget)) { this.reject('flood'); return; }
    switch (e.t) {
      case 'who': {
        // === P4 抗作弊: 身份不可伪造 ===
        // 必须"自称的 peerId == 发信人", 且 hash 必须与 peerId 一致(确定性哈希)。
        // 否则任何人都能冒充别人的 peerId / 顶掉别人 hash→peerId 的映射。
        if (e.peerId !== from || hashOfPeer(e.peerId) !== e.hash) { this.reject('identity'); return; }
        // === 只在"第一次见到这个 peer"时回敬 who ===
        // 否则 A 回 B、B 又回 A —— 两个客户端会无限互相回敬(带宽死循环)。
        // 单向一次即可: A 广播 → B 首次见到 A 才回敬。
        const firstTime = !this.remoteInfo.has(e.peerId);
        this.hashToPeer.set(e.hash, e.peerId);
        this.hashOwner.set(e.hash, e.peerId);
        this.peerToHash.set(e.peerId, e.hash);
        const prev = this.remoteInfo.get(e.peerId);
        const clamp = (n: number | undefined) => Math.max(0, Math.min(MAX_SCORE_VALUE, Math.floor(n ?? 0)));
        this.remoteInfo.set(e.peerId, {
          hash: e.hash,
          name: String(e.name ?? 'PILOT').slice(0, 24),
          team: e.team === 0 || e.team === 1 ? e.team : 255,
          squad: Math.max(0, Math.min(8, Math.floor(e.squad ?? 0))),
          // 记分只增不减(旧值优先), 且夹在合理范围内
          kills: Math.max(prev?.kills ?? 0, clamp(e.kills)),
          deaths: Math.max(prev?.deaths ?? 0, clamp(e.deaths)),
        });
        this.peerSquad.set(e.peerId, Math.max(0, Math.min(8, Math.floor(e.squad ?? 0))));
        // 该 peer 的中队单位 hash 也要能路由回他
        for (let i = 1; i <= (e.squad ?? 0); i++) {
          const h = sqHash(e.hash, i);
          this.hashToPeer.set(h, e.peerId);
          this.hashOwner.set(h, e.peerId);
        }
        // 首次见到才回敬一次, 让新来的也知道我(单向发现; 见上方 firstTime 说明)
        if (firstTime && this.room && e.peerId !== this.room.peerId) {
          logNet(`发现对端 ${String(e.name).slice(0, 12)} · peer=${e.peerId.slice(0, 10)} · team=${e.team} · 僚机×${e.squad ?? 0}`);
          this.sendWho(from);
        }
        break;
      }
      case 'kill':
        // === P4 抗作弊: 只有受害者的拥有者能宣布这次死亡 ===
        // 但**只在"我们知道这个 hash 归谁"时才拒绝**(已知拥有者 ≠ 发信人):
        // 实测 4 人局里 kill 可能先于 who 握手到达, 那时拥有者还未知 —— 一律丢弃会
        // 让记分不收敛(受害者自己记了死亡, 别人却什么都没收到)。
        // 未知 hash 的 kill 即使被伪造也**拿不到任何好处**: onKillEvent 只按
        // hashToPeer 归属记分, 未知 killer/victim 都不会给谁加分。
        if (this.hashOwner.has(e.victimHash) && this.hashOwner.get(e.victimHash) !== from) {
          this.reject('kill');
          return;
        }
        this.onKillEvent(e.killerHash, e.victimHash, e.killerName, e.victimName);
        break;
      case 'aiDead': {
        // === P4 抗作弊: 只能申报**自己**的战果 ===
        if (e.killerHash !== hashOfPeer(from)) { this.reject('aiDead'); return; }
        // 任务 AI 的生死是**广播**的: 射手本地判定击毁 → 所有端同步标记。
        // 记分只在远端凶手时补账(本机凶手在 reportAiDeath 里已记过)。
        const kPeer = this.hashToPeer.get(e.killerHash) ?? '';
        if (kPeer && kPeer !== this.selfPeerId) {
          const r = this.remoteInfo.get(kPeer);
          if (r) r.kills++;
        }
        this.pushFeed(String(e.killerName ?? '?').slice(0, 24), String(e.aiName ?? 'AI').slice(0, 24), false);
        this.onAiDead?.(e.aiId, e.aiName, e.killerHash, e.killerName);
        break;
      }
      case 'hit': {
        // === P4 抗作弊: 只收"发给我拥有的单位"的命中, 且伤害/频率受限 ===
        // ① 必须由 byHash 的拥有者发来(不能替别人报命中)
        if (e.byHash !== hashOfPeer(from)) { this.reject('hit'); return; }
        // ② 单次伤害夹住(防"一发 99999")
        const dmg = Math.max(0, Math.min(MAX_HIT_DAMAGE, Number(e.damage) || 0));
        if (!(dmg > 0)) { this.reject('hit'); return; }
        // ③ 命中频率限流
        if (!this.allow(this.hitBucket, from, MAX_HITS_PER_SEC)) { this.reject('hit'); return; }
        const isSelfHit = e.victimHash === this.selfHash;
        const slot = isSelfHit ? 0 : this.slotOfMySquadHash(e.victimHash);
        if (!isSelfHit && slot <= 0) { this.reject('hit'); return; }   // 不是我的单位 → 丢弃
        this.stats.hitsReceived++;
        // 武器类型只用于本地反馈, 不参与结算 —— 老客户端不发这个字段时退化为 'other'
        // (也就是"不播受击音效"), 不会因为版本差异而多播一次。
        const kind: DamageKind = e.kind === 'missile' || e.kind === 'gun' || e.kind === 'laser' ? e.kind : 'other';
        if (isSelfHit) this.onLocalDamage?.(dmg, e.byHash, e.byName, kind);
        else this.onOwnedDamage?.(slot, dmg, e.byHash, e.byName);
        break;
      }
      case 'respawn':
        // 复活: 清掉插值缓冲里的陈旧帧, 避免从死亡位置"滑"过去。
        // P4: 只接受"这个 hash 的拥有者"发来的复活(否则别人可以乱清我的缓冲)。
        if (this.hashOwner.get(e.hash) !== from) { this.reject('identity'); return; }
        this.interp.remove(e.hash);
        break;
      case 'matchend':
        // === P4 抗作弊: 只有 SDK 指定的房主能宣布结束 ===
        // (没拿到 hostId 时退化为"只认 isHost 声明", 但至少不是谁都能喊停)
        if (this.room?.hostId && from !== this.room.hostId) { this.reject('matchend'); return; }
        logOk(`收到停战令(matchend) — 本局结束`);
        if (!this.matchOver) {
          this.matchOver = true;
          this.onMatchEnd?.();
        }
        break;
      case 'left': {
        this.hashToPeer.delete(hashOfPeer(e.peerId));
        this.hashOwner.delete(hashOfPeer(e.peerId));
        this.peerToHash.delete(e.peerId);
        this.remoteInfo.delete(e.peerId);
        this.interp.remove(hashOfPeer(e.peerId));
        // 该 peer 的中队单位也一起移除
        const sq = this.peerSquad.get(e.peerId) ?? 0;
        for (let i = 1; i <= sq; i++) this.removeUnit(sqHash(hashOfPeer(e.peerId), i));
        this.peerSquad.delete(e.peerId);
        this.removeUnit(hashOfPeer(e.peerId));
        break;
      }
      default:
        break;
    }
  }

  /** 远端玩家的展示信息(来自 who 握手)。 */
  readonly remoteInfo = new Map<string, { hash: number; name: string; team: number; squad: number; kills: number; deaths: number }>();

  /**
   * 击毁事件(拥有者广播)。
   *
   * 所有端在同一处记分: 凶手 +1 击毁 / 受害者 +1 死亡。这样不需要额外的
   * "积分同步"消息 —— 记分的真相源就是这条可靠事件。
   */
  private onKillEvent(killerHash: number, victimHash: number, killerName: string, victimName: string): void {
    this.stats.killsReceived++;
    const kPeer = this.hashToPeer.get(killerHash) ?? '';
    const vPeer = this.hashToPeer.get(victimHash) ?? '';
    if (kPeer && kPeer !== this.selfPeerId) {
      const r = this.remoteInfo.get(kPeer);
      if (r) r.kills++;
    } else if (kPeer === this.selfPeerId) {
      this.selfKills++;
    }
    if (vPeer && vPeer !== this.selfPeerId) {
      const r = this.remoteInfo.get(vPeer);
      if (r) r.deaths++;
    } else if (vPeer === this.selfPeerId) {
      this.selfDeaths++;
    }
    this.pushFeed(killerName || kPeer || '?', victimName || vPeer || '?', kPeer === this.selfPeerId || vPeer === this.selfPeerId);
    if (kPeer === this.selfPeerId) logOk(`击毁: 我 → ${victimName || vPeer}`);
    else if (vPeer === this.selfPeerId) logWarn(`被击毁: ${killerName || kPeer} → 我`);
    else logNet(`击毁: ${killerName || kPeer} → ${victimName || vPeer}`);
    this.onKill?.(kPeer, vPeer);
  }

  // ==========================================================================
  // 本地记分 / 事件上报(引擎调用)
  // ==========================================================================

  private selfKills = 0;
  private selfDeaths = 0;
  private feed: KillFeedItem[] = [];
  private nextFeedId = 1;

  get kills(): number {
    return this.selfKills;
  }

  get deaths(): number {
    return this.selfDeaths;
  }

  private pushFeed(killer: string, victim: string, selfInvolved: boolean): void {
    this.feed.push({ id: this.nextFeedId++, killer, victim, selfInvolved, at: performance.now() });
    if (this.feed.length > 6) this.feed.splice(0, this.feed.length - 6);
  }

  /** 记一次本地击毁(任务 AI); 由引擎在 AI 死亡时调用并广播。 */
  reportAiDeath(aiId: number, aiName: string): void {
    this.selfKills++;
    this.pushFeed(this.selfName, aiName, true);
    this.sendEvent({ t: 'aiDead', aiId, aiName, killerHash: this.selfHash, killerName: this.selfName });
  }

  /**
   * 本地玩家(或本地中队的僚机)被击毁 → 广播 kill。
   *
   * 只有**拥有者**能宣布自己单位的死亡(拥有者权威), 所以远端看到机体消失与
   * 积分变化都来自这里, 不会出现"两边各自判定死亡"的分歧。
   */
  reportLocalKill(victimHash: number, victimName: string, killerHash: number, killerName: string): void {
    this.stats.killsSent++;
    // 本机也要记自己的账(kill 事件不会回环给自己)
    if (victimHash === this.selfHash) this.selfDeaths++;
    if (killerHash === this.selfHash) this.selfKills++;
    this.pushFeed(killerName || '?', victimName || '?', true);
    this.sendEvent({ t: 'kill', killerHash, victimHash, killerName, victimName });
  }

  /** 权威方(房主)宣布本局结束。 */
  requestMatchEnd(): boolean {
    if (!this.room?.isHost) return false;
    this.matchOver = true;
    this.sendEvent({ t: 'matchend', at: performance.now() });
    return true;
  }

  get matchEnded(): boolean {
    return this.matchOver;
  }

  // ==========================================================================
  // 每帧
  // ==========================================================================

  /**
   * 主更新。`nowMs` 用 performance.now()。
   *
   * 发送按固定 20Hz 节流(不是每渲染帧都发): 高刷屏上 144Hz 都发会浪费带宽,
   * 而规范也要求快照 15~20Hz。
   */
  update(nowMs: number): void {
    // 发送需要房间(没有房间就没有对端);
    // 但**远端实体同步不依赖房间** —— 否则自测(合成快照)与"房间刚断但还
    // 想保留最后一帧画面"这两种情况都会失效。两者必须分开判断。
    if (this.room) {
      this.maybeSend(nowMs);
      this.flushOutboundDamage(nowMs);
      // === 每 2 秒一条"实时状态"日志 ===
      // 联机时最想知道的就是这几个数:对端数 / 收发快照数 / 远端实体 / 出站速率。
      this.logT('stats', () => {
        const peers = this.room?.peers() ?? [];
        const kbps = this.stats.outboundPoseBytes / 1024;
        logNet(`状态: 对端 ${peers.length} · 收包 ${this.stats.snapshotsReceived} · 发包 ${this.stats.snapshotsSent} · `
          + `远端实体 ${this.stats.remoteCount} · AI 位姿 ${this.stats.aiPosesApplied} · 出站 ${kbps.toFixed(1)}KB · `
          + `命中 出${this.stats.hitsSent}/入${this.stats.hitsReceived}`);
      });
    }
    this.syncRemoteEntities(nowMs);
  }

  /** 本地中队当前槽位数(0 = 没有中队)。 */
  private squadronSlots(): number {
    if (!this.squadron) return 0;
    try {
      return this.squadron.unitStates().length;
    } catch {
      return 0;
    }
  }

  /** 某个 hash 是不是"我自己的中队僚机"(返回 1 起的槽位; 0 = 不是)。 */
  private slotOfMySquadHash(hash: number): number {
    const n = this.squadronSlots();
    for (let i = 1; i <= n; i++) if (sqHash(this.selfHash, i) === hash) return i;
    return 0;
  }

  private maybeSend(nowMs: number): void {
    const interval = 1000 / SNAPSHOT_HZ;
    if (nowMs - this.lastSendMs < interval) return;
    this.lastSendMs = nowMs;
    const st = this.localState?.();
    if (!st) return;
    const poses: PoseSnapshot[] = [this.poseOf(this.selfHash, st, nowMs)];
    // 自己的中队僚机同包发送 —— "每个玩家自带一个中队僚机"的位姿同步就是这条。
    // 每个客户端只仿真自己拥有的单位, 所以带宽是 O(自己人), 不是 O(全场)。
    if (this.squadron) {
      const units = this.squadron.unitStates();
      for (let i = 0; i < units.length; i++) {
        const s = units[i];
        poses.push(this.poseOf(sqHash(this.selfHash, i + 1), s, nowMs));
      }
    }
    // === P5: 房主额外广播任务 AI 的位姿 ===
    // 与玩家/僚机同一通道、同 32B 记录。一包最多 SNAP_MAX_RECORDS 条(32),
    // 超出的部分下一包继续 —— 一包放不下时**优先保证玩家/僚机**, AI 顺延。
    if (this.aiPoseSource && this.room?.isHost) {
      const ai = this.aiPoseSource();
      if (ai) {
        for (const a of ai) {
          if (poses.length >= SNAP_MAX_RECORDS - 1) break;
          poses.push(this.poseOf(aiHash(a.id), a, nowMs));
        }
      }
    }
    const buf = encodePoses(poses);
    this.room!.sendRealtime(buf);
    this.stats.outboundPoseBytes += buf.byteLength;
    this.stats.snapshotsSent++;
  }

  private poseOf(
    hash: number,
    s: {
      x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number;
      vx: number; vy: number; vz: number; hp: number; alive: boolean;
      afterburner?: boolean; firing?: boolean; airbrake?: boolean;
    },
    nowMs: number,
  ): PoseSnapshot {
    let flags = s.alive ? SNAP_ALIVE : SNAP_DEAD;
    if (s.afterburner) flags |= 1 << 1;
    if (s.firing) flags |= 1 << 2;
    if (s.airbrake) flags |= 1 << 3;
    return {
      entityHash: hash,
      x: s.x, y: s.y, z: s.z,
      qx: s.qx, qy: s.qy, qz: s.qz, qw: s.qw,
      vx: s.vx, vy: s.vy, vz: s.vz,
      hp: s.hp, flags, team: this.selfTeam, t: nowMs,
    };
  }

  /**
   * 把插值结果写进远端实体(注册表), 并维护武器句柄。
   *
   * 远端实体是**本模块创建**的: 位置/姿态/血量全部来自网络。
   * 引擎的相机/雷达/HUD 通过注册表看到它们, 因此这里不需要改渲染代码;
   * 武器系统通过 handlesFor() 拿到句柄, 命中后由本模块路由给拥有者。
   */
  private syncRemoteEntities(nowMs: number): void {
    let count = 0;
    let aiApplied = 0;    for (const [hash, peerId] of this.hashToPeer) {
      if (peerId === this.room?.peerId) continue;      // 跳过自己
      if (isAiHash(hash)) continue;                    // P5: AI 记录不建远端实体(见上)
      const pose = this.interp.sample(hash, nowMs);
      if (!pose) continue;
      count++;
      let u = this.units.get(hash);
      if (!u) {
        const created = this.createUnit(hash, peerId, pose.team);
        if (!created) continue;
        u = created;
      }
      const ent = u.entity;
      ent.position.copy(pose.position);
      ent.velocity.copy(pose.velocity);
      ent.hp = pose.hp;
      ent.alive = (pose.flags & SNAP_DEAD) === 0;
      const newFaction = this.factionFor(pose.team);
      if (newFaction !== ent.faction) {
        // 阵营变化 → 低模机体换色, 与雷达/HUD 的 IFF 显示保持一致。
        ent.faction = newFaction;
        recolorLowPolyAircraft(ent.group, newFaction);
      }
      // 武器句柄镜像(不触发伤害捕获)
      u.handle.mirrorHp(pose.hp);
      u.handle.alive = ent.alive;
      u.handle.isAlly = ent.faction === 'ally';
      u.lastSeenMs = nowMs;
      // 姿态: 若 group 是本模块创建的占位 Group, 直接写; 引擎挂载真实机体后
      // group 会被替换, 仍走同一路径(写 group.quaternion)。
      ent.group.quaternion.copy(pose.quaternion);
      ent.group.position.copy(pose.position);
      ent.group.visible = ent.alive;
    }
    // 超时未收到快照的远端单位 → 移除(玩家掉线/离开视野)
    for (const [hash, u] of [...this.units]) {
      if (nowMs - u.lastSeenMs > 8000) this.removeUnit(hash);
    }
    // === P5: 任务 AI 的位姿校正(客户端) ===
    // 已经把本地 AI 列表注册成 hash→id; 收到的 AI 记录不进实体注册表(引擎本来
    // 就有这些单位), 直接把插值结果回调给引擎写回位置/姿态/可见性。
    if (this.onAiPose && this.aiIdByHash.size) {
      for (const [hash, id] of this.aiIdByHash) {
        const pose = this.interp.sample(hash, nowMs);
        if (!pose) continue;
        this.aiPoseScratch.position.copy(pose.position);
        this.aiPoseScratch.quaternion.copy(pose.quaternion);
        this.aiPoseScratch.hp = pose.hp;
        this.aiPoseScratch.alive = (pose.flags & SNAP_DEAD) === 0;
        this.onAiPose(id, this.aiPoseScratch);
        aiApplied++;
      }
    }
    this.stats.remoteCount = count;
    this.stats.aiPosesApplied = aiApplied;
    this.stats.peers = this.room?.peers().length ?? 0;
  }

  private createUnit(hash: number, ownerPeerId: string, team: number): RemoteUnit | null {
    // slot 0 = 该 peer 自己的飞机; slot ≥1 = 他的中队僚机(见 sqHash)。
    // 未知 hash(合成注入/手写测试)按 slot 0 处理, 而不是直接丢弃 —— 否则
    // "hash 不是从 peerId 推导出来"的对端永远建不出实体。
    let slot = 0;
    if (hash !== hashOfPeer(ownerPeerId)) {
      const known = this.squadSlotOf(ownerPeerId, hash);
      if (known > 0) slot = known;
    }
    const id = slot === 0 ? peerEntityId(ownerPeerId) : `${peerEntityId(ownerPeerId)}#${slot}`;
    const faction = this.factionFor(team);
    const group = new THREE.Group();
    group.add(buildLowPolyAircraft(REMOTE_MODEL, faction));
    this.scene?.add(group);
    const info = this.remoteInfo.get(ownerPeerId);
    const baseName = info?.name ?? `PEER-${ownerPeerId.slice(0, 4)}`;
    const name = slot === 0 ? baseName : `${baseName}-${slot}`;
    const handle = new RemoteHandle({
      id: NET_HANDLE_BASE - this.nextHandleIndex++,
      group, position: group.position, velocity: new THREE.Vector3(),
      isAlly: faction === 'ally', name,
    });
    const entity: AircraftEntity = {
      id,
      origin: 'remote',
      faction,
      ownerPeerId,
      position: group.position,
      velocity: handle.velocity,
      alive: true,
      hp: handle.hp,
      group,
      name,
      handleId: handle.id,
    };
    this.registry.register(entity);
    const u: RemoteUnit = { hash, ownerPeerId, ownerHash: hashOfPeer(ownerPeerId), slot, entity, handle, lastSeenMs: performance.now() };
    this.units.set(hash, u);
    return u;
  }

  /** 该 hash 属于 ownerPeerId 的第几个僚机槽位(1 起; 0 = 不是)。 */
  private squadSlotOf(ownerPeerId: string, hash: number): number {
    const ownerHash = hashOfPeer(ownerPeerId);
    const n = this.peerSquad.get(ownerPeerId) ?? 0;
    for (let i = 1; i <= n; i++) if (sqHash(ownerHash, i) === hash) return i;
    return 0;
  }

  private removeUnit(hash: number): void {
    const u = this.units.get(hash);
    if (!u) return;
    this.registry.unregister(u.entity.id);
    this.scene?.remove(u.entity.group);
    this.units.delete(hash);
    this.interp.remove(hash);
  }

  // ==========================================================================
  // 武器句柄 / 目标
  // ==========================================================================

  /**
   * 导出武器系统的句柄。
   *
   * 引擎把它接进 weapons.update():
   *   · isAlly=false → 加入"玩家可打的目标"列表
   *   · isAlly=true  → 加入 allyHandles(敌机武器会打它们; 命中同样会被捕获并路由)
   * 由于 RemoteHandle.hp 是访问器, **任何** 对远端单位造成的伤害(玩家武器或
   * 本地仿真的 AI 武器)都会被捕获, 由拥有者结算 —— 不需要给武器系统加分支。
   */
  handlesFor(isAlly: boolean): EnemyHandle[] {
    const out: EnemyHandle[] = [];
    for (const u of this.units.values()) {
      if (!u.handle.alive) continue;
      if (u.handle.isAlly !== isAlly) continue;
      out.push(u.handle);
    }
    return out;
  }

  /** 可锁定的远端目标(敌对阵营)。 */
  lockableTargets(): EnemyHandle[] {
    return this.handlesFor(false);
  }

  /** 攻击方可打到的目标位置(诊断用)。 */
  unitCount(): number {
    return this.units.size;
  }

  /**
   * 队伍 slot → 阵营。
   *
   * 这里就是联机的 IFF 判定点: 与本地同队 = 'ally', 不同队 = 'enemy'。
   * 引擎的雷达/HUD 通过 markerTypeFor(faction) 自动显示正确颜色,
   * 所以"选不同队伍看 IFF 变化"无需改任何显示代码。
   */
  private factionFor(team: number): Faction {
    if (team === 255 || this.selfTeam === 255) return 'enemy';
    return team === this.selfTeam ? 'ally' : 'enemy';
  }

  /** 诊断。 */
  debug(): NetSessionStats & { active: boolean; selfHash: number; rejected: Record<string, number>; tracks: { hash: number; frames: number; ageMs: number }[] } {
    return {
      ...this.stats,
      active: this.active,
      selfHash: this.selfHash,
      rejected: { ...this.rejected },
      tracks: this.interp.debug(),
    };
  }

  /** 一帧快照的理论字节数(诊断)。 */
  static bytesPerSnapshot(players: number): number {
    return poseBytes(players);
  }

  // ==========================================================================
  // 交给 HUD / 结算的 UI 快照
  // ==========================================================================

  /** 由引擎每帧取用(纯读取, 无副作用)。 */
  uiState(nowMs = performance.now()): NetUiState {
    const rows = new Map<string, NetScoreRow>();
    // 自己
    rows.set(this.selfPeerId || 'self', {
      peerId: this.selfPeerId || 'self',
      name: this.selfName,
      team: this.selfTeam,
      kills: this.selfKills,
      deaths: this.selfDeaths,
      isSelf: true,
    });
    for (const [peerId, info] of this.remoteInfo) {
      rows.set(peerId, {
        peerId, name: info.name, team: info.team,
        kills: info.kills, deaths: info.deaths, isSelf: false,
      });
    }
    const players = [...rows.values()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    const teamScores: Record<string, number> = {};
    for (const p of players) {
      if (p.team === 255) continue;
      teamScores[String(p.team)] = (teamScores[String(p.team)] ?? 0) + p.kills;
    }
    const peers = this.room?.peers() ?? [];
    const pingMs = peers.length
      ? Math.round(peers.reduce((a, p) => a + (p.latency || 0), 0) / peers.length)
      : 0;
    const respawnIn = this.respawnRemaining(nowMs);
    return {
      active: this.active,
      roomId: this.room?.roomId ?? '',
      isHost: !!this.room?.isHost,
      selfTeam: this.selfTeam,
      players,
      teamScores,
      feed: [...this.feed],
      dead: this.localDead,
      respawnIn,
      respawnReady: this.localDead && respawnIn <= 0,
      matchOver: this.matchOver,
      peers: peers.length,
      pingMs,
    };
  }

  /**
   * === 调试/自动化: 造一个假的远端玩家记分(只为让 HUD 积分板可见) ===
   * 不联网、不产生实体, 只填 remoteInfo —— 用于单机下截图验收联机 UI。
   */
  debugAddPeer(peerId: string, name: string, team: number, kills: number, deaths: number): void {
    const hash = hashOfPeer(peerId);
    this.hashToPeer.set(hash, peerId);
    this.hashOwner.set(hash, peerId);
    this.remoteInfo.set(peerId, { hash, name, team, squad: 0, kills, deaths });
  }

  /** 调试: 直接塞一条击杀信息(截图用)。 */
  debugAddFeed(killer: string, victim: string): void {
    this.pushFeed(killer, victim, false);
  }

  /**
   * === 合成快照注入 (P2 自测) ===
   * 把一段**假造的远端快照**喂进插值器, 用于在单机下验证整条链路:
   * 二进制解码 → 插值 → 远端实体驱动。
   * 与真实收包走**完全相同**的 interp.ingest 路径, 所以结论对真实联机有效。
   */
  ingestSynthetic(
    poses: { entityHash: number; x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number; vx: number; vy: number; vz: number; hp: number; flags: number; team: number; t: number }[],
    recvAtMs: number,
  ): void {
    // 给合成实体一个可读的 peerId, 便于在注册表里识别
    for (const p of poses) {
      if (!this.hashToPeer.has(p.entityHash)) this.hashToPeer.set(p.entityHash, 'synthetic');
      if (!this.hashOwner.has(p.entityHash)) this.hashOwner.set(p.entityHash, 'synthetic');
    }
    this.interp.ingest(poses, recvAtMs);
  }

  /**
   * === 离线自测: 伤害路由 / 记分 / 复活 (P2 收尾) ===
   * 不需要第二个客户端: 直接走与真实联机**相同**的记账路径, 断言:
   *   · 远端句柄的 hp 被本地武器扣掉时, 捕获到的伤害 == 扣掉的量
   *   · kill 事件把击毁记到凶手、死亡记到受害者
   *   · 死亡→13 秒复活倒计时
   * 返回结构化结果, 供 #diag / 自动化脚本断言。
   */
  selfTest(): {
    ok: boolean; capturedDamage: number; kills: number; deaths: number;
    respawnSec: number; respawnAfterSec: number; feed: number;
  } {
    const hash = 0x4242;
    const peer = 'selftest-peer';
    const now = performance.now();
    this.hashToPeer.set(hash, peer);
    this.hashOwner.set(hash, peer);
    this.remoteInfo.set(peer, { hash, name: 'SELFTEST', team: this.selfTeam === 0 ? 1 : 0, squad: 0, kills: 0, deaths: 0 });
    // 直接建一个远端单位(绕过插值: 只测记账链路)
    let u = this.units.get(hash);
    if (!u) {
      const created = this.createUnit(hash, peer, this.selfTeam === 0 ? 1 : 0);
      if (!created) return { ok: false, capturedDamage: 0, kills: 0, deaths: 0, respawnSec: this.respawnSec, respawnAfterSec: 0, feed: this.feed.length };
      u = created;
    }
    const before = u.handle.pendingDamage;
    // 模拟武器系统扣血(直接写属性 —— 与 weapons.ts 完全同一条路径)
    u.handle.hp -= 37;
    const captured = u.handle.pendingDamage - before;
    // 模拟一次远端击毁自己的 kill 事件
    const kBefore = this.selfKills, dBefore = this.selfDeaths;
    this.onKillEvent(this.selfHash, this.selfHash, this.selfName, this.selfName);
    const kills = this.selfKills - kBefore;
    const deaths = this.selfDeaths - dBefore;
    // 复活倒计时
    this.setLocalDead(true, now);
    const remaining = this.respawnRemaining(now + this.respawnSec * 1000 + 10);
    this.setLocalDead(false);
    // 清理合成单位
    this.removeUnit(hash);
    this.remoteInfo.delete(peer);
    return {
      ok: Math.abs(captured - 37) < 0.01 && kills === 1 && deaths === 1 && remaining <= 0,
      capturedDamage: captured, kills, deaths,
      respawnSec: this.respawnSec, respawnAfterSec: remaining, feed: this.feed.length,
    };
  }
}

/** 供引擎 import 的类型(避免引擎直接依赖 RemoteHandle 类)。 */
export type { RemoteHandle };
