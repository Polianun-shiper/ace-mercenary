// ============================================================================
// 联机大厅 UI (P1-4: 房间大厅)
// ============================================================================
// 风格: 沿用本作的琥珀 CRT 终端语汇(crt-panel / crt-corner / crt-label 等),
// 与主菜单其余面板一致。
//
// 布局(自上而下):
//   ① 房间信息条   : 房号 / 你的身份(房主/成员) / 连接质量 / 离开
//   ② 模式与设置    : 对战(1v1/2v2/4v4/自由) 或 剧情(合作/对抗) + 地图/关卡
//                     —— 只有房主可改; 成员看到的是只读回显
//   ③ 玩家表        : 队伍 / 名字 / ready / 击毁数占位; 房主可改队伍与踢人
//   ④ 底部操作      : READY 切换 + 房主 START(全员 ready 才亮)
//
// 设计取舍:
//   · 大厅状态全部来自 RoomLobby 的订阅快照 —— 组件不自己维护副本,
//     避免"两份状态不同步"这类 bug(与实体注册表同一思路: 单一真相源)。
//   · 未加入房间时显示"建房/加入"入口, 不显示空表。

import { useEffect, useState } from 'react';
import { getLocale } from '@/lib/game/i18n';
import { getVibe } from '@/lib/game/net/vibe';
import { RoomLobby, type LobbySnapshot } from '@/lib/game/net/lobby';
import {
  MODES, modeInfo, teamName,
  type StoryMode, type TeamSlot, type VersusMode,
} from '@/lib/game/net/room-model';
import { MISSIONS } from '@/lib/game/missions';
import { NetDebugPanel } from './NetDebugPanel';

/** 全局单例: 菜单与引擎共享同一个大厅实例。 */
let _lobby: RoomLobby | null = null;
export function getLobby(): RoomLobby {
  if (!_lobby) _lobby = new RoomLobby(getVibe());
  return _lobby;
}

const BTN = 'border px-2 py-0.5 font-mono text-[0.625rem] tracking-widest transition-colors';
const BTN_ON = 'border-[var(--crt-amber)] bg-[var(--crt-panel-2)] text-[var(--crt-amber-hi)]';
const BTN_OFF = 'border-[var(--crt-amber-ghost)] text-[var(--crt-amber-dim)] hover:bg-[var(--crt-panel-2)]';

function Panel({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  return (
    <div className="crt-panel crt-corner flex min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-[var(--crt-amber-ghost)] bg-[var(--crt-panel-2)] px-2 py-1">
        <span className="font-mono text-[0.625rem] tracking-widest text-[var(--crt-amber)]">{title}</span>
        {meta && <span className="font-mono text-[0.5625rem] tracking-wider text-[var(--crt-amber-dim)]">{meta}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">{children}</div>
    </div>
  );
}

export function MultiplayerLobby({ onBack }: { onBack: () => void }) {
  const zh = getLocale() === 'zh';
  const lobby = getLobby();
  const [snap, setSnap] = useState<LobbySnapshot | null>(null);
  const [roomInput, setRoomInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => lobby.onUpdate(setSnap), [lobby]);

  const joinRoom = async (id: string) => {
    const code = id.trim().toUpperCase();
    if (!code) return;
    setBusy(true);
    setNote('');
    // announce 让房间出现在大厅列表里(私密房则不 announce)
    const ok = await lobby.join(code, { name: 'PILOT', announce: { listed: true, open: true, max: 8, mode: 'lobby' } });
    setBusy(false);
    if (!ok) setNote(zh ? '加入失败(需登录 / 网络不可用 / 房号无效)' : 'JOIN FAILED (login / network / bad code)');
  };

  const s = snap;
  const inRoom = !!s && !!s.roomId && s.players.length > 0;
  const info = s ? modeInfo(s.settings.mode) : null;

  return (
    <div className="flex h-full w-full flex-col gap-2 p-2.5">
      {/* ① 房间信息条 */}
      <div className="crt-panel crt-corner flex items-center justify-between px-2 py-1.5">
        <div className="flex items-center gap-3 font-mono text-[0.625rem] tracking-widest">
          <span className="text-[var(--crt-amber-dim)]">{zh ? '房间' : 'ROOM'}</span>
          <span className="text-[var(--crt-amber-hi)]">{inRoom ? s!.roomId : '—'}</span>
          {inRoom && (
            <span className={s!.isHost ? 'text-[var(--crt-green)]' : 'text-[var(--crt-amber)]'}>
              {s!.isHost ? (zh ? '房主' : 'HOST') : (zh ? '成员' : 'MEMBER')}
            </span>
          )}
          {inRoom && s!.peers.length > 0 && (
            <span className="text-[var(--crt-amber-dim)]">
              PING {Math.round(s!.peers.reduce((a, p) => a + (p.latency || 0), 0) / Math.max(1, s!.peers.length))}ms
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {inRoom && (
            <button type="button" className={`${BTN} ${BTN_OFF}`} onClick={() => lobby.leave()}>
              {zh ? '离开房间' : 'LEAVE'}
            </button>
          )}
          <button type="button" className={`${BTN} ${BTN_OFF}`} onClick={onBack}>
            {zh ? '返回' : 'BACK'}
          </button>
        </div>
      </div>

      {!inRoom && (
        /* 未入房: 建房 / 加入 */
        <Panel title={zh ? '联机房间' : 'MULTIPLAYER ROOM'} meta={zh ? '建档 / 加入' : 'HOST / JOIN'}>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy}
                className={`${BTN} ${BTN_ON}`}
                onClick={() => joinRoom(RoomLobby.makeRoomId())}
              >
                {zh ? '创建房间' : 'CREATE ROOM'}
              </button>
              <button
                type="button"
                disabled={busy}
                className={`${BTN} ${BTN_OFF}`}
                onClick={async () => {
                  setBusy(true);
                  const id = await lobby.quickJoin();
                  setBusy(false);
                  if (id) await joinRoom(id);
                  else setNote(zh ? '没有可用房间' : 'NO OPEN ROOMS');
                }}
              >
                {zh ? '快速加入' : 'QUICK JOIN'}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <input
                value={roomInput}
                onChange={(e) => setRoomInput(e.target.value.toUpperCase())}
                placeholder={zh ? '输入房号(6 位)' : 'ROOM CODE (6)'}
                maxLength={8}
                className="w-40 border border-[var(--crt-amber-ghost)] bg-[var(--crt-panel)] px-2 py-1 font-mono text-[0.6875rem] tracking-[0.25em] text-[var(--crt-amber-hi)] outline-none focus:border-[var(--crt-amber)]"
              />
              <button type="button" disabled={busy || !roomInput} className={`${BTN} ${BTN_ON}`} onClick={() => joinRoom(roomInput)}>
                {zh ? '加入' : 'JOIN'}
              </button>
            </div>
            <div className="font-mono text-[0.5625rem] leading-relaxed text-[var(--crt-amber-dim)]">
              {zh
                ? '提示: 联机需要登录 VibeHub 且通过平台地址访问(本地双击无法授权)。'
                : 'NOTE: MULTIPLAYER REQUIRES VIBEHUB LOGIN AND PLATFORM HOSTING (local file:// CANNOT AUTHORIZE).'}
            </div>
            {note && <div className="font-mono text-[0.625rem] text-[var(--crt-red-light,#ff6a5c)]">{note}</div>}
          </div>
        </Panel>
      )}

      {inRoom && (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
          {/* ② 模式与设置 */}
          <div className="flex min-h-0 flex-col gap-2">
            <Panel
              title={zh ? '对局模式' : 'MATCH MODE'}
              meta={s!.isHost ? (zh ? '房主可改' : 'HOST ONLY') : (zh ? '只读' : 'READ ONLY')}
            >
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-1.5">
                  {MODES.map((m) => {
                    const active = s!.settings.mode === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        disabled={!s!.isHost}
                        className={`${BTN} ${active ? BTN_ON : BTN_OFF} disabled:opacity-50`}
                        onClick={() => lobby.setSettings({ kind: m.kind, mode: m.id as VersusMode | StoryMode })}
                      >
                        {m.label}
                      </button>
                    );
                  })}
                </div>

                {/* 地图 / 关卡选择 */}
                <div className="mt-1">
                  <div className="mb-1 font-mono text-[0.5625rem] tracking-widest text-[var(--crt-amber-dim)]">
                    {info?.kind === 'story'
                      ? (zh ? '剧情关卡(房主选择)' : 'STORY MISSION (HOST)')
                      : (zh ? '对战地图(房主选择)' : 'MAP (HOST)')}
                  </div>
                  <select
                    disabled={!s!.isHost}
                    value={s!.settings.missionId}
                    onChange={(e) => lobby.setSettings({ missionId: e.target.value })}
                    className="w-full border border-[var(--crt-amber-ghost)] bg-[var(--crt-panel)] px-2 py-1 font-mono text-[0.625rem] text-[var(--crt-amber-hi)] outline-none focus:border-[var(--crt-amber)] disabled:opacity-50"
                  >
                    <option value="">{zh ? '— 未选择 —' : '— NONE —'}</option>
                    {info?.kind === 'story'
                      ? MISSIONS.map((m) => <option key={m.id} value={m.id}>{`${m.codename} ${m.title}`}</option>)
                      : MISSIONS.map((m) => <option key={m.id} value={m.id}>{`${m.map} · ${m.codename}`}</option>)}
                  </select>
                </div>

                <div className="mt-1 flex flex-wrap gap-3 font-mono text-[0.5625rem] text-[var(--crt-amber-dim)]">
                  <span>{zh ? `队伍规模 ${info?.teamSize || '—'}` : `TEAM ${info?.teamSize || '—'}`}</span>
                  <span>{zh ? `上限 ${info?.maxPlayers} 人` : `MAX ${info?.maxPlayers}`}</span>
                  <span>{zh ? `复活等待 ${s!.settings.respawnDelaySec}s` : `RESPAWN ${s!.settings.respawnDelaySec}s`}</span>
                  {info && modeInfo(s!.settings.mode).teams === 0 && (
                    <span className="text-[var(--crt-amber)]">{zh ? '自由对战: 无 AI 单位' : 'FFA: NO AI UNITS'}</span>
                  )}
                </div>
              </div>
            </Panel>

            {/* ③ 玩家表 */}
            <Panel
              title={zh ? '玩家' : 'PLAYERS'}
              meta={`${s!.players.length}/${info?.maxPlayers ?? 8}`}
            >
              <table className="w-full font-mono text-[0.625rem]">
                <thead>
                  <tr className="text-[0.5625rem] tracking-widest text-[var(--crt-amber-dim)]">
                    <th className="py-0.5 text-left">{zh ? '队伍' : 'TEAM'}</th>
                    <th className="py-0.5 text-left">{zh ? '呼号' : 'CALLSIGN'}</th>
                    <th className="py-0.5 text-left">{zh ? '状态' : 'STATE'}</th>
                    <th className="py-0.5 text-right">{zh ? '操作' : 'ACTION'}</th>
                  </tr>
                </thead>
                <tbody>
                  {s!.players.map((p) => (
                    <tr key={p.peerId} className="border-t border-[var(--crt-amber-ghost)]">
                      <td className="py-1">
                        <span className={p.team === 0 ? 'text-[var(--crt-ally,#5ad2ff)]' : p.team === 1 ? 'text-[var(--crt-red-light,#ff6a5c)]' : 'text-[var(--crt-amber-dim)]'}>
                          {teamName(p.team, s!.settings.kind)}
                        </span>
                      </td>
                      <td className="py-1 text-[var(--crt-amber-hi)]">
                        {p.name}
                        {p.isHost && <span className="ml-1 text-[var(--crt-green)]">★</span>}
                        {p.isSelf && <span className="ml-1 text-[var(--crt-amber-dim)]">({zh ? '你' : 'YOU'})</span>}
                      </td>
                      <td className="py-1">
                        <span className={p.ready ? 'text-[var(--crt-green)]' : 'text-[var(--crt-amber-dim)]'}>
                          {p.ready ? (zh ? '已准备' : 'READY') : (zh ? '待准备' : 'WAIT')}
                        </span>
                      </td>
                      <td className="py-1 text-right">
                        {s!.isHost && !p.isSelf && (
                          <span className="flex justify-end gap-1">
                            <button type="button" className={`${BTN} ${BTN_OFF}`} onClick={() => lobby.setTeam(p.peerId, 0 as TeamSlot)}>蓝</button>
                            <button type="button" className={`${BTN} ${BTN_OFF}`} onClick={() => lobby.setTeam(p.peerId, 1 as TeamSlot)}>红</button>
                            <button type="button" className={`${BTN} ${BTN_OFF}`} onClick={() => lobby.kick(p.peerId)}>{zh ? '踢' : 'KICK'}</button>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {s!.isHost && (
                <button type="button" className={`${BTN} ${BTN_OFF} mt-2`} onClick={() => lobby.autoTeams()}>
                  {zh ? '自动平衡分队' : 'AUTO-BALANCE TEAMS'}
                </button>
              )}
            </Panel>
          </div>

          {/* ④ 操作列 */}
          <div className="flex min-h-0 flex-col gap-2">
            <Panel title={zh ? '准备与开战' : 'READY / START'}>
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  className={`${BTN} ${s!.players.find((p) => p.isSelf)?.ready ? BTN_ON : BTN_OFF}`}
                  onClick={() => lobby.setReady(!(s!.players.find((p) => p.isSelf)?.ready ?? false))}
                >
                  {s!.players.find((p) => p.isSelf)?.ready
                    ? (zh ? '取消准备' : 'UNREADY')
                    : (zh ? '准备' : 'READY')}
                </button>
                <button
                  type="button"
                  disabled={!s!.canStart}
                  className={`${BTN} ${s!.canStart ? BTN_ON : BTN_OFF} disabled:opacity-40`}
                  onClick={() => lobby.startMatch()}
                >
                  {zh ? '开始任务' : 'START MISSION'}
                </button>
                {!s!.isHost && (
                  <div className="font-mono text-[0.5625rem] text-[var(--crt-amber-dim)]">
                    {zh ? '等待房主开始…' : 'WAITING FOR HOST…'}
                  </div>
                )}
                {s!.isHost && !s!.canStart && (
                  <div className="font-mono text-[0.5625rem] text-[var(--crt-amber-dim)]">
                    {zh ? '需全员准备且两队都有人' : 'ALL READY + BOTH TEAMS OCCUPIED'}
                  </div>
                )}
              </div>
            </Panel>

            {/* 剧情联机说明 */}
            {info?.kind === 'story' && (
              <Panel title={zh ? '剧情联机规则' : 'STORY RULES'}>
                <ul className="flex list-disc flex-col gap-1 pl-4 font-mono text-[0.5625rem] leading-relaxed text-[var(--crt-amber-dim)]">
                  <li>{zh ? '每个玩家自带一个中队的僚机' : 'EACH PLAYER BRINGS A WINGMAN SQUADRON'}</li>
                  <li className={s!.settings.mode === 'adversarial' ? 'text-[var(--crt-amber)]' : ''}>
                    {zh
                      ? (s!.settings.mode === 'adversarial'
                        ? '对抗: 选红方则原敌方 AI 变友军、原友军 AI 变敌人'
                        : '合作: 与单机剧情敌我关系一致')
                      : (s!.settings.mode === 'adversarial'
                        ? 'ADVERSARIAL: RED SIDE FLIPS AI ALLEGIANCE'
                        : 'CO-OP: SAME AS SINGLE-PLAYER')}
                  </li>
                  <li>{zh ? '被击毁后 13 秒内选机复活' : 'RESPAWN WITHIN 13s AFTER DEATH'}</li>
                  <li>{zh ? '团队战按队总分、个人战按个人击毁数判胜' : 'TEAM SCORE / PERSONAL KILLS DECIDE'}</li>
                </ul>
              </Panel>
            )}
          </div>
        </div>
      )}

      {/* === 联机实时 debug 日志 (per user request) ===
          上传后按不了 F12, 所以把 SDK/登录/房间/peer/快照/命中/抗作弊这些"看不见的
          链路"直接摊在界面上; 可收起、可清空, 并显示当前生效的 slug 与其来源。 */}
      {/* mt-auto: 未入房时内容很短, 日志贴到屏幕底部像控制台; 入房后上面的
          flex-1 已吃掉剩余空间, mt-auto 不产生副作用。 */}
      <div className="mt-auto shrink-0">
        <NetDebugPanel />
      </div>
    </div>
  );
}
