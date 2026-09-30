// ============================================================================
// 联机房间模型 (P1-4: 房间大厅)
// ============================================================================
// 玩法定义(per user request):
//   · 联机对战: 1v1 / 2v2 / 4v4 / 自由对战(FFA)
//   · 剧情联机: 合作(同阵营) / 对抗(玩家可选择敌方阵营)
//   · 房间制, 有房主; 房主自由选择剧情关卡(剧情联机)或地图(自由对战)
//   · 被击毁后 13 秒内选机复活
//   · 团队战按队总分判定胜负; 个人战按个人击毁数
//   · 剧情联机: 每个玩家自带一个中队僚机; 选敌方阵营则敌方 AI 转友、友方 AI 转敌
//
// 同步模型: state-sync(房主权威) —— 见 net/entity.ts 顶部说明。
//   房主跑权威循环并广播快照; 客户端只应用/插值, 不回写、不读库。
//
// 本文件只放**纯数据与规则**(无网络、无 THREE), 便于单测与复用:
//   房间设置、队伍分配、模式校验、胜负判定、复活计时。

/** 对局类型。 */
export type MatchKind = 'versus' | 'story';

/** 子模式: 对战有队伍规模, 剧情有合作/对抗。 */
export type VersusMode = '1v1' | '2v2' | '4v4' | 'ffa';
export type StoryMode = 'coop' | 'adversarial';

export interface ModeInfo {
  id: VersusMode | StoryMode;
  kind: MatchKind;
  /** 中文名 */
  label: string;
  /** 每队人数(ffa 为 1; coop/adversarial 不限队员数, 由关卡定) */
  teamSize: number;
  /** 队伍数(ffa 为 0 = 每人独立阵营) */
  teams: number;
  /** 最大玩家数 */
  maxPlayers: number;
}

export const MODES: ModeInfo[] = [
  { id: '1v1', kind: 'versus', label: '1 对 1', teamSize: 1, teams: 2, maxPlayers: 2 },
  { id: '2v2', kind: 'versus', label: '2 对 2', teamSize: 2, teams: 2, maxPlayers: 4 },
  { id: '4v4', kind: 'versus', label: '4 对 4', teamSize: 4, teams: 2, maxPlayers: 8 },
  { id: 'ffa', kind: 'versus', label: '自由对战', teamSize: 1, teams: 0, maxPlayers: 8 },
  { id: 'coop', kind: 'story', label: '剧情 · 合作', teamSize: 0, teams: 2, maxPlayers: 8 },
  { id: 'adversarial', kind: 'story', label: '剧情 · 对抗', teamSize: 0, teams: 2, maxPlayers: 8 },
];

export function modeInfo(id: VersusMode | StoryMode): ModeInfo {
  return MODES.find((m) => m.id === id) ?? MODES[0];
}

/** 阵营槽位。自由对战每人一个独立 slot, 所以用数字。 */
export type TeamSlot = 0 | 1 | -1;   // -1 = 未分配

/** 玩家在房间里的状态。 */
export interface LobbyPlayer {
  peerId: string;
  name: string;
  /** 房主 */
  isHost: boolean;
  team: TeamSlot;
  ready: boolean;
  /** 选定的机型(展示用) */
  model?: string;
  /** 本机(用于 UI 区分自己) */
  isSelf?: boolean;
}

/** 房间设置(房主可改; 改动通过 room.state 广播)。 */
export interface RoomSettings {
  kind: MatchKind;
  mode: VersusMode | StoryMode;
  /** 剧情联机: 关卡 id; 自由对战: 地图 id */
  missionId: string;
  /** 是否允许中途加入 */
  allowJoin: boolean;
  /** 击毁后复活等待(秒) —— 用户指定 13 */
  respawnDelaySec: number;
}

/** 复活等待(per user request: 被击毁后 13 秒以内选择飞机再度复活)。 */
export const RESPAWN_DELAY_SEC = 13;

export const DEFAULT_SETTINGS: RoomSettings = {
  kind: 'versus',
  mode: '2v2',
  missionId: '',
  allowJoin: true,
  respawnDelaySec: RESPAWN_DELAY_SEC,
};

/**
 * 队伍分配。
 *
 * 规则:
 *   · 对战队伍模式: 按**人数均衡**轮流分配(0,1,0,1…), 房主可手动改
 *   · 自由对战: 每人独立 slot(此处返回 0, 实际用 peerId 区分, 见 isFfa)
 *   · 剧情模式: 玩家自选(合作默认全队 0; 对抗可选 0/1)
 */
export function autoAssignTeam(players: LobbyPlayer[], mode: VersusMode | StoryMode): Map<string, TeamSlot> {
  const info = modeInfo(mode);
  const out = new Map<string, TeamSlot>();
  if (info.kind === 'versus' && info.teams === 0) {
    // FFA: 每人独立阵营 —— 用各自的索引当 slot, 但 TeamSlot 只有 0/1/-1,
    // 所以这里统一给 0, 由 isFfa() 判定"不看队伍, 看个人"。
    players.forEach((p) => out.set(p.peerId, 0));
    return out;
  }
  let t0 = 0, t1 = 0;
  for (const p of players) {
    // 均衡: 哪个队少就进哪个
    const slot: TeamSlot = t0 <= t1 ? 0 : 1;
    if (slot === 0) t0++; else t1++;
    out.set(p.peerId, slot);
  }
  return out;
}

/** 是否自由对战(不看队伍, 按个人击毁数排名)。 */
export function isFfa(mode: VersusMode | StoryMode): boolean {
  return mode === 'ffa';
}

/** 队伍显示名。 */
export function teamName(slot: TeamSlot, kind: MatchKind): string {
  if (slot === -1) return '未分配';
  if (slot === 0) return kind === 'story' ? '蓝方(原友军)' : '蓝队';
  return kind === 'story' ? '红方(原敌军)' : '红队';
}

/**
 * 剧情联机的敌我翻转映射 (per user request)。
 *
 * 单机剧情里: 玩家 = 友方, 关卡 AI 分敌我两拨。
 * 联机对抗时若玩家选择**敌方阵营**(slot=1):
 *   · 原本的敌方 AI → 变成玩家的友军
 *   · 原本的友方 AI(含僚机) → 变成玩家的敌人
 * 所以需要一个显式的映射函数, 而不是散落各处的 isAlly 判断。
 *
 * @param aiIsAllyInStory 该 AI 在**单机剧情**里的阵营
 * @param playerSlot      该玩家所在队伍
 * @returns 该 AI 对**这个玩家**而言是否为友军
 */
export function aiFriendlyFor(aiIsAllyInStory: boolean, playerSlot: TeamSlot, mode: VersusMode | StoryMode): boolean {
  if (mode !== 'adversarial') return aiIsAllyInStory;   // 合作: 与单机一致
  if (playerSlot === -1) return aiIsAllyInStory;
  // 对抗: 选了红方(slot=1) → 单机里的敌方变友军
  return playerSlot === 1 ? !aiIsAllyInStory : aiIsAllyInStory;
}

/**
 * 胜负判定。
 *
 * 团队战: 按**队伍总分**(击毁数之和)判胜负, 分数高的队赢。
 * 个人战(FFA): 按**个人击毁数**, 最高者赢。
 */
export interface ScoreEntry {
  peerId: string;
  team: TeamSlot;
  kills: number;
  deaths: number;
  /** 助攻/其他加分(可选) */
  score?: number;
}

export interface MatchResult {
  /** 获胜方: 队伍 slot(团队战) 或 peerId 列表(个人战) */
  winners: { kind: 'team'; team: TeamSlot } | { kind: 'player'; peerIds: string[] };
  teamScores: Record<string, number>;
  /** 个人排名(降序) */
  ranking: ScoreEntry[];
}

export function judgeMatch(entries: ScoreEntry[], mode: VersusMode | StoryMode): MatchResult {
  const scoreOf = (e: ScoreEntry) => (e.score ?? 0) + e.kills;
  const ranking = [...entries].sort((a, b) => scoreOf(b) - scoreOf(a));
  const teamScores: Record<string, number> = {};
  for (const e of entries) {
    if (e.team === -1) continue;
    teamScores[String(e.team)] = (teamScores[String(e.team)] ?? 0) + scoreOf(e);
  }
  if (isFfa(mode)) {
    const top = ranking.length ? scoreOf(ranking[0]) : 0;
    const winners = ranking.filter((e) => scoreOf(e) === top).map((e) => e.peerId);
    return { winners: { kind: 'player', peerIds: winners }, teamScores, ranking };
  }
  // 团队战: 找总分最高的队(平局时返回并列第一支, 由调用方处理平局展示)
  let bestTeam: TeamSlot = -1;
  let bestScore = -Infinity;
  for (const [k, v] of Object.entries(teamScores)) {
    if (v > bestScore) { bestScore = v; bestTeam = Number(k) as TeamSlot; }
  }
  return { winners: { kind: 'team', team: bestTeam }, teamScores, ranking };
}

/** 复活计时(per user request: 13 秒以内选机复活)。 */
export function respawnRemaining(deadAtMs: number, nowMs: number, delaySec = RESPAWN_DELAY_SEC): number {
  const elapsed = (nowMs - deadAtMs) / 1000;
  return Math.max(0, delaySec - elapsed);
}
