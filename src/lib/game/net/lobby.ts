// ============================================================================
// 房间管理 (P1-4: 房间大厅)
// ============================================================================
// 职责: 把 VibeHub 的 Room 包装成"本作需要的大厅语义" ——
//   · 房主 / 成员 / ready 状态
//   · 房间设置(模式、地图/关卡)由房主改并广播
//   · 队伍分配(房主权威)
//   · 开战倒计时(全员 ready 后房主发令)
//
// 严格遵循规范:
//   · 实时状态(位姿快照)走 room.sendRealtime —— 本文件只管**大厅**, 不碰快照
//   · 不可丢事件(设置变更/加入/离开/开战)走 room.send(可靠有序)
//   · 房间元数据(供列表/匹配)走 room.announce, 读走 vibe.rooms.list
//   · 不写库: 大厅状态是内存态, 用可靠消息同步 —— 只有"当局结果"才落 room.data
//
// 幂等: join/announce/close 都做了重复调用保护, 便于 React 严格模式下的双执行。

import type { VibeHubClient } from './vibe';
import { logInfo, logOk, logError, logNet } from './debug-log';
import {
  type LobbyPlayer,
  type MatchKind,
  type RoomSettings,
  type StoryMode,
  type TeamSlot,
  type VersusMode,
  DEFAULT_SETTINGS,
  modeInfo,
  autoAssignTeam,
} from './room-model';

/** 大厅 → 成员的可靠消息。 */
type LobbyMsg =
  | { t: 'hello'; name: string; model?: string }
  | { t: 'settings'; settings: RoomSettings }
  | { t: 'team'; peerId: string; team: TeamSlot }
  | { t: 'ready'; peerId: string; ready: boolean }
  | { t: 'start'; at: number; settings: RoomSettings }
  | { t: 'bye'; peerId: string };

export interface LobbySnapshot {
  roomId: string;
  selfPeerId: string;
  isHost: boolean;
  settings: RoomSettings;
  players: LobbyPlayer[];
  /** 全员 ready(且人数达到模式下限)时可开战 */
  canStart: boolean;
  /** 已收到开战令的时间戳(0 = 未开战) */
  startAt: number;
  /** 连接质量提示 */
  peers: { id: string; open: boolean; latency: number }[];
}

const MIN_PLAYERS: Record<string, number> = { '1v1': 2, '2v2': 2, '4v4': 2, ffa: 2, coop: 1, adversarial: 2 };

export class RoomLobby {
  private selfName = 'PILOT';
  private selfModel = '';
  private players = new Map<string, LobbyPlayer>();
  private settings: RoomSettings = { ...DEFAULT_SETTINGS };
  private startAt = 0;
  private subs: ((s: LobbySnapshot) => void)[] = [];
  private joined = false;
  private leaving = false;

  constructor(private readonly vibe: VibeHubClient) {}

  get isActive(): boolean {
    return this.joined;
  }

  /** 当前房间实例(SDK Room) —— 开战后交给引擎绑定(见 engine.attachNetRoom)。 */
  get roomInstance(): unknown | null {
    return this.roomRef;
  }

  get roomId(): string {
    return this.currentRoomId;
  }

  onUpdate(cb: (s: LobbySnapshot) => void): () => void {
    this.subs.push(cb);
    cb(this.snapshot());
    return () => {
      const i = this.subs.indexOf(cb);
      if (i >= 0) this.subs.splice(i, 1);
    };
  }

  private emit(): void {
    const s = this.snapshot();
    for (const cb of this.subs) {
      try { cb(s); } catch { /* 单个订阅者异常不影响其它 */ }
    }
  }

  setSelf(name: string, model = ''): void {
    this.selfName = name || 'PILOT';
    this.selfModel = model;
    const me = this.players.get(this.selfPeerId);
    if (me) { me.name = this.selfName; me.model = this.selfModel; }
    this.emit();
  }

  private selfPeerId = '';

  snapshot(): LobbySnapshot {
    const list = [...this.players.values()];
    // 房主永远排第一, 其余按加入顺序(保持稳定, 避免 UI 跳动)
    list.sort((a, b) => (a.isHost === b.isHost ? 0 : a.isHost ? -1 : 1));
    const need = MIN_PLAYERS[this.settings.mode] ?? 2;
    const readyCount = list.filter((p) => p.ready).length;
    // 团队模式还要检查两队都有人(否则开战即一边倒)
    const teamsOk = (() => {
      if (this.settings.mode === 'ffa') return true;
      const t0 = list.some((p) => p.team === 0);
      const t1 = list.some((p) => p.team === 1);
      return t0 && t1;
    })();
    const peers = this.lastPeers;
    return {
      roomId: this.currentRoomId,
      selfPeerId: this.selfPeerId,
      isHost: this.isHost,
      settings: { ...this.settings },
      players: list,
      canStart: this.isHost && list.length >= need && readyCount === list.length && teamsOk,
      startAt: this.startAt,
      peers,
    };
  }

  private currentRoomId = '';
  private isHost = false;
  private lastPeers: { id: string; open: boolean; latency: number }[] = [];

  // ==========================================================================
  // 加入 / 建房
  // ==========================================================================

  /**
   * 加入(或创建)房间。
   *
   * 规范: `room.join` 会**原子认领**无 owner 的隐藏房间 —— 所以"建房"与"加入"
   * 是同一个调用; 需要出现在大厅列表时才 `announce`。
   */
  async join(roomId: string, opts: { name: string; announce?: Record<string, unknown> }): Promise<boolean> {
    if (this.joined) return true;
    logInfo(`加入房间 ${roomId} …`);
    const client = await this.vibe.init();
    if (!client) { logError(`加入房间失败: SDK 不可用(未登录 / 无网络 / 本地 file://)`); return false; }
    try {
      const room = await client.room.join(roomId);
      this.attach(room, roomId, opts.name);
      if (opts.announce) {
        try { await room.announce(opts.announce); logNet('房间已公告到大厅列表'); } catch { /* 未登录/离线时忽略 */ }
      }
      this.joined = true;
      return true;
    } catch (err) {
      logError(`加入房间失败: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
      return false;
    }
  }

  /** 生成一个易读的房号(避免歧义字符 0/O/1/I)。 */
  static makeRoomId(): string {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)];
    return s;
  }

  /** 列出大厅里已公开的房间(读 room 层元数据, 不轮询: 由用户操作触发)。 */
  async listRooms(): Promise<{ roomId: string; players: number; max?: number; [k: string]: unknown }[]> {
    const client = await this.vibe.init();
    if (!client) return [];
    try {
      return await client.rooms.list();
    } catch {
      return [];
    }
  }

  /** 快速加入一个有空位的房间。 */
  async quickJoin(): Promise<string | null> {
    logInfo('查询可用房间(quickJoin)…');
    const client = await this.vibe.init();
    if (!client) { logError('quickJoin 失败: SDK 不可用'); return null; }
    try {
      const id = await client.rooms.quickJoin({ filter: (r) => Number(r.players ?? 0) < Number(r.max ?? 8) });
      logInfo(id ? `找到房间 ${id}` : '没有找到可加入的房间');
      return id;
    } catch (err) {
      logError(`quickJoin 失败: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
      return null;
    }
  }

  private attach(room: unknown, roomId: string, name: string): void {
    const r = room as {
      roomId: string; peerId: string; isHost: boolean;
      onMessage(cb: (m: unknown, from: string) => void): unknown;
      onPeer(cb: (e: { type: string; id: string }) => void): unknown;
      send(m: unknown, to?: string): void;
      peers(): { id: string; open: boolean; latency: number }[];
      data: { set<T>(k: string, v: T): Promise<{ ok: true }> };
    };
    this.currentRoomId = r.roomId ?? roomId;
    this.selfPeerId = r.peerId;
    this.isHost = r.isHost;
    this.roomRef = r as unknown as typeof this.roomRef;
    // 自己先登记(房主身份来自 SDK 的原子认领结果, 不由客户端自封)
    this.players.clear();
    this.players.set(r.peerId, {
      peerId: r.peerId, name, isHost: r.isHost, team: -1, ready: false,
      model: this.selfModel, isSelf: true,
    });
    r.onMessage((msg, from) => this.onMessage(msg, from));
    r.onPeer((e) => this.onPeer(e));
    this.selfPeerId = r.peerId;
    logOk(`已进入房间 ${this.currentRoomId} · 我的 peerId=${r.peerId.slice(0, 10)} · ${r.isHost ? '房主' : '成员'}`);
    this.emit();
  }

  private send(m: LobbyMsg, to?: string): void {
    // Room 实例在 join() 时保存到 roomRef; 未加入时静默丢弃(大厅 UI 可能先于 join)。
    this.roomRef?.send(m, to);
  }

  private roomRef: {
    send(m: unknown, to?: string): void;
    peers?: () => { id: string; open: boolean; latency: number }[];
    leave?: () => void;
    data: { set<T>(k: string, v: T): Promise<{ ok: true }> };
  } | null = null;

  private onMessage(msg: unknown, from: string): void {
    const m = msg as LobbyMsg;
    if (!m || typeof m !== 'object' || !('t' in m)) return;
    switch (m.t) {
      case 'hello': {
        const existing = this.players.get(from);
        this.players.set(from, {
          peerId: from,
          name: m.name || 'PILOT',
          isHost: existing?.isHost ?? false,
          team: existing?.team ?? -1,
          ready: existing?.ready ?? false,
          model: m.model,
        });
        // 房主回发当前设置 + 队伍, 让新成员立刻同步
        if (this.isHost) {
          this.send({ t: 'settings', settings: this.settings }, from);
          const t = this.players.get(from)?.team ?? -1;
          this.send({ t: 'team', peerId: from, team: t }, from);
        }
        this.emit();
        break;
      }
      case 'settings':
        // 只有房主的设置生效(房主权威)
        this.settings = { ...m.settings };
        this.emit();
        break;
      case 'team': {
        const p = this.players.get(m.peerId);
        if (p) p.team = m.team;
        this.emit();
        break;
      }
      case 'ready': {
        const p = this.players.get(m.peerId);
        if (p) p.ready = m.ready;
        this.emit();
        break;
      }
      case 'start':
        this.startAt = m.at;
        this.settings = { ...m.settings };
        logOk(`收到开战令(倒计时 ${Math.max(0, Math.round((m.at - Date.now()) / 1000))}s)`);
        this.emit();
        break;
      case 'bye':
        this.players.delete(m.peerId);
        this.emit();
        break;
      default:
        break;
    }
  }

  private onPeer(e: { type: string; id: string }): void {
    if (e.type === 'leave') {
      logInfo(`对端离开: ${e.id.slice(0, 10)}`);
      this.players.delete(e.id);
      this.emit();
    } else if (e.type === 'join') {
      logInfo(`对端加入: ${e.id.slice(0, 10)} — 发送握手`);
      // 新连接建立后主动打招呼, 让双方互相登记
      this.send({ t: 'hello', name: this.selfName, model: this.selfModel }, e.id);
    }
    this.lastPeers = this.roomRef ? (this.roomRef as unknown as { peers?: () => { id: string; open: boolean; latency: number }[] }).peers?.() ?? [] : [];
    this.emit();
  }

  // ==========================================================================
  // 房主操作(权威)
  // ==========================================================================

  /** 改设置(仅房主)。改完广播全房。 */
  setSettings(patch: Partial<RoomSettings>): void {
    if (!this.isHost) return;
    this.settings = { ...this.settings, ...patch };
    if (patch.mode) {
      // 模式变了 → 队容量变了, 重新自动分队
      const assign = autoAssignTeam([...this.players.values()], this.settings.mode);
      for (const [peer, team] of assign) {
        const p = this.players.get(peer);
        if (p) p.team = team;
      }
    }
    this.send({ t: 'settings', settings: this.settings });
    // 分队一起广播
    for (const p of this.players.values()) this.send({ t: 'team', peerId: p.peerId, team: p.team });
    this.emit();
  }

  /** 房主指定某人的队伍。 */
  setTeam(peerId: string, team: TeamSlot): void {
    if (!this.isHost) return;
    const p = this.players.get(peerId);
    if (!p) return;
    p.team = team;
    this.send({ t: 'team', peerId, team });
    this.emit();
  }

  /** 自动平衡分队(仅房主)。 */
  autoTeams(): void {
    if (!this.isHost) return;
    const assign = autoAssignTeam([...this.players.values()], this.settings.mode);
    for (const [peer, team] of assign) {
      const p = this.players.get(peer);
      if (p) p.team = team;
      this.send({ t: 'team', peerId: peer, team });
    }
    this.emit();
  }

  /** 自己 ready(非房主也要 ready; 房主默认视为已 ready)。 */
  setReady(ready: boolean): void {
    const me = this.players.get(this.selfPeerId);
    if (!me) return;
    me.ready = ready;
    this.send({ t: 'ready', peerId: this.selfPeerId, ready });
    this.emit();
  }

  /**
   * 开战(仅房主, 且 canStart)。
   *
   * 返回开战时间戳(供所有客户端对齐倒计时), 0 = 未能开战。
   * 倒计时 3 秒: 让各客户端有时间切场景/准备(地图加载另见 ready 握手)。
   */
  startMatch(leadMs = 3000): number {
    if (!this.isHost) return 0;
    if (!this.snapshot().canStart) return 0;
    const at = Date.now() + leadMs;
    this.startAt = at;
    this.send({ t: 'start', at, settings: this.settings });
    // 当局结果落库 —— 这是规范允许写 room.data 的唯一用途
    void this.roomRef?.data.set('lastStart', { at, settings: this.settings });
    logOk(`房主开战: ${this.settings.mode} · ${this.settings.missionId || '(默认关卡)'} · 倒计时 ${leadMs}ms`);
    this.emit();
    return at;
  }

  /** 踢人(房主权威: 断开该玩家并广播)。 */
  kick(peerId: string): void {
    if (!this.isHost) return;
    this.players.delete(peerId);
    this.send({ t: 'bye', peerId });
    this.emit();
  }

  /** 离开房间。房主离开时房间由 SDK 的 owner 过期机制回收。 */
  leave(): void {
    if (this.leaving) return;
    logInfo(`离开房间 ${this.currentRoomId || '(未入房)'}`);
    this.leaving = true;
    try { this.roomRef?.send({ t: 'bye', peerId: this.selfPeerId }); } catch { /* ignore */ }
    try { (this.roomRef as unknown as { leave?: () => void })?.leave?.(); } catch { /* ignore */ }
    // 清掉房间引用: 否则下次开战可能把**已离开的旧房间**重新挂到引擎上
    // (engine.attachNetRoom 用的是 roomInstance getter)。
    this.roomRef = null;
    this.currentRoomId = '';
    this.isHost = false;
    this.players.clear();
    this.joined = false;
    this.startAt = 0;
    this.leaving = false;
    this.emit();
  }
}
