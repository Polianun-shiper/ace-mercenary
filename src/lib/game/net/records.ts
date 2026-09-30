// ============================================================================
// 战绩落库 (P4-1)
// ============================================================================
// 规范约束(唯一允许写库的场景): **当局结果**才落库。
//   · room.data  —— 这一局的权威记录(房主写, 全房可读)
//   · client.save —— 玩家自己的存档(每个玩家只写自己的生涯数据)
//   · 实时状态绝不写库(位姿走 P2P; 见 session.ts)
//
// 设计取舍:
//   · **每个客户端只写自己的生涯**(它自己的 save 作用域), 房主额外写房间级记录 ——
//     避免"谁都去写全局, 互相覆盖"。
//   · **幂等**: 每局带唯一 matchId, 本地记住"这局已经写过了"就不重复写
//     (结算屏可能被重渲染/重进)。
//   · **离线安全**: SDK 不存在/未登录/写失败都不抛 —— 单机与离线必须照常能玩,
//     结算屏只把"是否归档成功"告知玩家。

import type { VibeHubClient } from './vibe';

/** 一名玩家的当局战绩。 */
export interface PlayerResult {
  peerId: string;
  name: string;
  team: number;
  kills: number;
  deaths: number;
  /** 是否获胜方(团队战按队/个人战按排名)。 */
  winner: boolean;
  isSelf: boolean;
}

/** 一局比赛的完整结果(落 room.data 的权威记录)。 */
export interface MatchResultRecord {
  /** 局唯一 id(时间戳 + 房号), 幂等去重靠它。 */
  matchId: string;
  at: number;
  roomId: string;
  mode: string;
  kind: string;
  missionId: string;
  /** 对局时长(秒)。 */
  durationSec: number;
  teamScores: Record<string, number>;
  players: PlayerResult[];
  /** 获胜方: 队伍 slot, 或 'ffa' 时的 peerId 列表。 */
  winner: { kind: 'team'; team: number } | { kind: 'player'; peerIds: string[] };
  hostPeerId: string;
}

/** 生涯累计(写 client.save)。 */
export interface CareerRecord {
  matches: number;
  wins: number;
  kills: number;
  deaths: number;
  bestKills: number;
  bestScore: number;
  lastAt: number;
}

const CAREER_KEY = 'career';
const HISTORY_KEY = 'history';
const HISTORY_MAX = 10;

/** 本会话已归档过的 matchId(SDK 写成功才记)。 */
const written = new Set<string>();

function safeCareer(v: unknown): CareerRecord {
  const c = (v ?? {}) as Partial<CareerRecord>;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.floor(x)) : 0);
  return {
    matches: n(c.matches), wins: n(c.wins), kills: n(c.kills), deaths: n(c.deaths),
    bestKills: n(c.bestKills), bestScore: n(c.bestScore), lastAt: n(c.lastAt),
  };
}

export interface RecordOutcome {
  /** 房间级记录是否写入成功(仅房主写)。 */
  room: boolean;
  /** 本人生涯是否写入成功。 */
  career: boolean;
  /** 未归档的原因(便于结算屏提示)。 */
  reason: 'ok' | 'offline' | 'not-logged-in' | 'duplicate' | 'error';
}

/**
 * 归档一局结果。
 *
 * @param vibe  SDK 门面(可能未初始化/未登录 → 返回 offline)
 * @param room  房间实例(提供 room.data; 本地回路/无 SDK 时为 null)
 * @param rec   本局结果
 * @param opts  selfScore: 本人这局的分数(用于 bestScore)
 */
export async function recordMatchResult(
  vibe: VibeHubClient,
  room: unknown,
  rec: MatchResultRecord,
  opts: { selfScore: number } = { selfScore: 0 },
): Promise<RecordOutcome> {
  if (written.has(rec.matchId)) return { room: false, career: false, reason: 'duplicate' };
  const client = await vibe.init();
  if (!client) return { room: false, career: false, reason: 'offline' };
  if (!client.isLoggedIn()) return { room: false, career: false, reason: 'not-logged-in' };

  const me = rec.players.find((p) => p.isSelf);
  let roomOk = false;
  let careerOk = false;
  try {
    // === ① 房间级权威记录(只有房主写, 避免互相覆盖) ===
    const r = room as { data?: { set<T>(k: string, v: T, o?: { ttl?: number }): Promise<{ ok: true }> } } | null;
    const isHost = !!me && me.peerId === rec.hostPeerId;
    if (r?.data && isHost) {
      await r.data.set('lastResult', rec);
      roomOk = true;
    }
    // === ② 玩家自己的生涯 + 最近战绩(只写自己的存档) ===
    const prev = safeCareer(await client.save.get<CareerRecord>(CAREER_KEY));
    const next: CareerRecord = {
      matches: prev.matches + 1,
      wins: prev.wins + (me?.winner ? 1 : 0),
      kills: prev.kills + (me?.kills ?? 0),
      deaths: prev.deaths + (me?.deaths ?? 0),
      bestKills: Math.max(prev.bestKills, me?.kills ?? 0),
      bestScore: Math.max(prev.bestScore, Math.max(0, Math.floor(opts.selfScore))),
      lastAt: rec.at,
    };
    await client.save.set(CAREER_KEY, next);
    const hist = (await client.save.get<MatchResultRecord[]>(HISTORY_KEY)) ?? [];
    const trimmed = [rec, ...(Array.isArray(hist) ? hist : [])].slice(0, HISTORY_MAX);
    await client.save.set(HISTORY_KEY, trimmed);
    careerOk = true;
    written.add(rec.matchId);
    return { room: roomOk, career: true, reason: 'ok' };
  } catch (err) {
    console.warn('[records] 战绩归档失败(不影响游玩):', err);
    return { room: roomOk, career: careerOk, reason: 'error' };
  }
}

/** 读取本人生涯(结算屏/机库可展示)。未登录或失败返回 null。 */
export async function loadCareer(vibe: VibeHubClient): Promise<CareerRecord | null> {
  try {
    const client = await vibe.init();
    if (!client || !client.isLoggedIn()) return null;
    return safeCareer(await client.save.get<CareerRecord>(CAREER_KEY));
  } catch {
    return null;
  }
}
