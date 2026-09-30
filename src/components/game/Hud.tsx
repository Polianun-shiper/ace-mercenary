'use client';

import { useEffect, useRef, type RefObject } from 'react';
import type { HudState, WeaponType } from '@/lib/game/types';
import { Minimap } from './Radar';
import { useT } from '@/hooks/use-i18n';
import { getLocale } from '@/lib/game/i18n';
import { useUiScale } from '@/lib/game/ui-scale';
import { zhValue, WEATHER_ZH, CATEGORY_ZH, CAM_MODE_ZH, WINGMAN_CMD_ZH } from '@/lib/game/labels-zh';

// === canvas 专用色板(per fix: ctx.* 不接受 CSS 变量) ===
// canvas 2D 上下文的 strokeStyle/fillStyle/shadowColor 只认具体颜色值;
// 之前写成 'var(--crt-green)' 是无效值, 浏览器忽略赋值 → 画笔保留旧色或变黑
// (这就是"敌人雷达框黑色"的原因)。这里的值与 globals.css 的 --crt-* 令牌一一
// 对应, 改令牌时要同步这里。
const CANVAS_COLOR = {
  amberHi: '#ffd27a',
  amber: '#ffb000',
  amberBright: '#ff9e2c',
  amberDim: '#c2610a',
  red: '#ff3b1f',
  green: '#7cff6b',
  // 友军/僚机雷达与屏幕框: 青蓝(功能色, 与琥珀/红/绿区分) per user request
  ally: '#5ad2ff',
} as const;

export function Hud({
  hud, onSelectUnit, missionStartedAt = 0, missionTitle = '', missionCodename = '', onRespawn,
}: {
  hud: HudState | null;
  onSelectUnit?: (id: number) => void;
  /** 进关瞬间的墙钟时间戳(ms), 用于标题卡 3 秒计时;0 = 不显示标题卡 */
  missionStartedAt?: number;
  missionTitle?: string;
  missionCodename?: string;
  /** 联机: 点击复活(13 秒倒计时结束后可点)。 */
  onRespawn?: () => void;
}) {
  // Removed: center gun-reticle canvas (per user request — "delete this UI in the middle").
  const markerRef = useRef<HTMLCanvasElement | null>(null);
  const t = useT();
  // === 语言 (联机面板用) ===
  // useT() 订阅了语言变化(组件会重渲染), 所以这里读 getLocale() 得到的值是最新的。
  const zh = getLocale() === 'zh';
  // Global UI scale — px-hardcoded spots (canvas drawing, inline sizes)
  // multiply by this so they follow the same auto-scaling as rem-based UI.
  const uiScale = useUiScale();

  if (!hud) return null;

  const weaponName = hud.currentWeapon;
  const weaponCount =
    hud.currentWeapon === 'GUN' ? '∞' :
    hud.currentWeapon === 'SIDE' ? '∞' :
    hud.currentWeapon === 'EW' ? '∞' :
    hud.currentWeapon === 'MSL' ? hud.weapons.MSL :
    hud.currentWeapon === 'LASM' ? hud.weapons.LASM :
    hud.currentWeapon === 'BDL' ? (hud.weapons.BDL ?? 0) :
    hud.currentWeapon === 'NKV' ? (hud.weapons.NKV ?? 0) :
    hud.weapons.FLR;

  const targetBlip = hud.minimapBlips.find((b) => b.isTarget);
  const targetId = targetBlip?.id;

  return (
    <div className="pointer-events-none fixed inset-0 z-30 select-none font-mono text-[var(--crt-amber)]"
      style={{ textShadow: '0 1px 2px rgba(0,0,0,0.9), 0 0 6px rgba(255,176,0,0.35)', ...(hud.mouseAimCursor ? { cursor: 'none' } : {}) }}>
      {/* === Debug view badge (per user request: ` 键调试控制台) ===
          Shows the active render-layer view so the player knows what they're
          inspecting. Hidden for the normal lit view. */}
      {hud.debugView && hud.debugView !== 'lit' && (
        <div
          className="absolute left-1/2 top-2 -translate-x-1/2 text-center text-[10px] tracking-[0.35em]"
          style={{ color: 'var(--crt-amber-hi)', textShadow: '0 0 8px rgba(255,176,0,0.7)' }}
        >
          VIEW: {hud.debugView.toUpperCase()}
          {hud.debugView === 'radar' ? ' · ALL UNITS' : ''}
        </div>
      )}
      {/* === FPS counter (per user request: 控制台 fps 命令) === */}
      {hud.fps !== undefined && (
        <div
          className="absolute left-2 bottom-2 text-[11px] tracking-widest"
          style={{ color: 'var(--crt-amber-hi)', textShadow: '0 0 8px rgba(255,176,0,0.7)' }}
        >
          FPS: {hud.fps}
        </div>
      )}
      {/* ==================================================================
          联机战术面板 (P2 收尾)
          积分板 + 击杀信息 + 复活倒计时。单机时 hud.mp 为 undefined →
          这段 JSX 完全不渲染, 单机画面零变化。
          ================================================================== */}
      {hud.mp && (
        <div
          className="absolute left-2 w-[218px] select-none"
          // 顶栏左上角是标准的仪表读数区(时间/分数/波次), 联机面板放在它下面,
          // 避免两个面板叠在一起(实测重叠会互相压字)。
          style={{ pointerEvents: 'none', top: '6rem' }}
        >
          {/* 积分板 */}
          <div className="border border-[var(--crt-amber-ghost)] bg-[rgba(10,6,1,0.72)] px-1.5 py-1">
            <div className="mb-0.5 flex items-center justify-between text-[9px] tracking-[0.2em] text-[var(--crt-amber-dim)]">
              <span>{zh ? '联机 · 战况' : 'ONLINE · SCORE'}</span>
              <span>
                {hud.mp.isHost ? (zh ? '房主' : 'HOST') : ''}
                {hud.mp.peers > 0 ? ` ${hud.mp.pingMs}ms` : ''}
              </span>
            </div>
            {/* 团队比分 */}
            {Object.keys(hud.mp.teamScores).length > 0 && (
              <div className="mb-0.5 flex gap-2 text-[9px] tracking-widest">
                {Object.entries(hud.mp.teamScores)
                  .sort(([a], [b]) => Number(a) - Number(b))
                  .map(([team, score]) => (
                    <span
                      key={team}
                      style={{ color: Number(team) === hud.mp!.selfTeam ? CANVAS_COLOR.ally : CANVAS_COLOR.red }}
                    >
                      {Number(team) === 0 ? (zh ? '蓝' : 'BLU') : (zh ? '红' : 'RED')} {score}
                    </span>
                  ))}
              </div>
            )}
            <table className="w-full text-[9.5px] leading-tight">
              <tbody>
                {hud.mp.players.slice(0, 8).map((p, i) => (
                  <tr key={`${p.name}-${i}`} style={{ color: p.isSelf ? CANVAS_COLOR.amberHi : 'var(--crt-amber)' }}>
                    <td className="truncate pr-1" style={{ maxWidth: 118 }}>
                      {p.isSelf ? '▶ ' : '  '}
                      {p.name}
                    </td>
                    <td className="w-7 text-right">{p.kills}</td>
                    <td className="w-7 text-right opacity-70">{p.deaths}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-0.5 flex justify-between text-[8px] tracking-widest text-[var(--crt-amber-dim)]">
              <span>{zh ? '击毁 / 被击毁' : 'KILLS / DEATHS'}</span>
              <span>{hud.mp.players.length} {zh ? '人' : 'PLR'}</span>
            </div>
          </div>
          {/* 击杀信息(最新在下) */}
          {hud.mp.feed.length > 0 && (
            <div className="mt-1 flex flex-col gap-0.5">
              {hud.mp.feed.slice(-4).map((f) => (
                <div
                  key={f.id}
                  className="truncate border-l-2 bg-[rgba(10,6,1,0.55)] px-1 py-[1px] text-[9px]"
                  style={{
                    borderColor: f.selfInvolved ? CANVAS_COLOR.amberHi : 'var(--crt-amber-ghost)',
                    color: f.selfInvolved ? CANVAS_COLOR.amberHi : 'var(--crt-amber)',
                  }}
                >
                  {f.killer} ✕ {f.victim}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {/* === 联机复活面板 (P2 收尾): 被击毁后 13 秒倒计时 === */}
      {hud.mp?.dead && (
        <div className="absolute inset-x-0 top-[34%] z-40 flex flex-col items-center gap-2" style={{ pointerEvents: 'auto' }}>
          <div className="border border-[var(--crt-red)] bg-[rgba(12,4,2,0.82)] px-6 py-3 text-center">
            <div className="text-[13px] tracking-[0.3em]" style={{ color: 'var(--crt-red-light, #ff6a5c)' }}>
              {zh ? '机体被击毁' : 'AIRCRAFT DESTROYED'}
            </div>
            <div className="mt-1 text-[26px] font-bold tracking-[0.2em]" style={{ color: CANVAS_COLOR.amberHi }}>
              {hud.mp.respawnReady ? (zh ? '可复活' : 'READY') : Math.ceil(hud.mp.respawnIn)}
            </div>
            <div className="mt-0.5 text-[9px] tracking-[0.25em] text-[var(--crt-amber-dim)]">
              {zh ? '13 秒后可选机重返战场' : 'RESPAWN AVAILABLE AFTER 13s'}
            </div>
            {hud.mp.respawnReady && (
              <button
                type="button"
                onClick={() => onRespawn?.()}
                className="mt-2 border border-[var(--crt-amber)] bg-[var(--crt-panel-2)] px-4 py-1 text-[11px] tracking-[0.25em] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/15"
              >
                {zh ? '▶ 复活 (ENTER)' : '▶ RESPAWN (ENTER)'}
              </button>
            )}
          </div>
        </div>
      )}
      {/* === Hit feedback overlays (per user request) === */}
      {/* Red damage vignette — pulses when the player takes damage. */}
      {hud.damageFlash > 0.01 && (
        <div className="absolute inset-0" style={{
          background: 'radial-gradient(ellipse at center, transparent 30%, rgba(255,40,40,0.6) 100%)',
          opacity: hud.damageFlash,
          mixBlendMode: 'screen',
        }} />
      )}
      {/* Green hit-confirm pulse — subtle full-screen tint when bullets connect. */}
      {hud.hitConfirmFlash > 0.01 && (
        <div className="absolute inset-0" style={{
          background: 'radial-gradient(ellipse at center, rgba(255,176,0,0.16) 0%, transparent 60%)',
          opacity: hud.hitConfirmFlash,
        }} />
      )}
      {/* === Nuke white flash (per user request: NKV 战术核弹) === */}
      {hud.nukeFlash !== undefined && hud.nukeFlash > 0.01 && (
        <div className="absolute inset-0" style={{
          background: 'radial-gradient(ellipse at center, rgba(255,255,255,0.85) 0%, rgba(255,220,180,0.5) 50%, transparent 100%)',
          opacity: Math.min(1, hud.nukeFlash),
          mixBlendMode: 'screen',
        }} />
      )}
      {/* Kill flash — stronger amber pulse on kills. */}
      {hud.killFlash > 0.01 && (
        <div className="absolute inset-0" style={{
          background: 'radial-gradient(ellipse at center, transparent 20%, rgba(255,200,80,0.5) 100%)',
          opacity: hud.killFlash,
          mixBlendMode: 'screen',
        }} />
      )}
      {/* === Bomb impact reticle (per user request) === */}
      {/* When BDL is selected, render a ground-reticle marker at the predicted
          impact point. The engine passes the screen-space position; we draw a
          pulsing circle + crosshair + "BDL" label. */}
      {(hud.currentWeapon === 'BDL' || hud.currentWeapon === 'CLB') && hud.bombImpactScreen && (
        <div className="absolute" style={{
          left: `${hud.bombImpactScreen.x * 100}%`,
          top: `${hud.bombImpactScreen.y * 100}%`,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
        }}>
          {/* === Blast radius circle (per user request: 爆炸范围指示器) === */}
          <div className="absolute rounded-full border border-[var(--crt-amber)]/60" style={{
            width: hud.bombImpactScreen.radius * 2,
            height: hud.bombImpactScreen.radius * 2,
            left: -hud.bombImpactScreen.radius,
            top: -hud.bombImpactScreen.radius,
            boxShadow: 'inset 0 0 12px rgba(255,204,68,0.15)',
          }} />
          <div className="relative" style={{ width: 56 * uiScale, height: 56 * uiScale }}>
            {/* Pulsing outer circle */}
            <div className="absolute inset-0 border-2 rounded-full animate-ping" style={{
              borderColor: 'var(--crt-amber)',
              opacity: 0.6,
            }} />
            {/* Steady inner circle */}
            <div className="absolute inset-2 border-2 rounded-full" style={{
              borderColor: 'var(--crt-amber)',
              opacity: 0.9,
              boxShadow: '0 0 8px rgba(255,200,80,0.6)',
            }} />
            {/* Crosshair lines */}
            <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2" style={{ background: 'var(--crt-amber)', opacity: 0.7 }} />
            <div className="absolute top-1/2 left-0 right-0 h-px -translate-y-1/2" style={{ background: 'var(--crt-amber)', opacity: 0.7 }} />
            {/* Center dot */}
            <div className="absolute left-1/2 top-1/2 w-1.5 h-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ background: 'var(--crt-amber)' }} />
          </div>
          <div className="text-center text-[0.625rem] tracking-widest mt-1" style={{ color: 'var(--crt-amber)', textShadow: '0 0 6px rgba(255,200,80,0.8)' }}>
            {/* === 落点距离 + 落弹时间 = "速度 + 落点距离"一起算出来的读数 ===
                (per user request: 指示器要按飞机的速度和落点距离结合计算)
                两者都来自同一个弹道解: 距离 = 落点水平距离, 时间 = 从投放到落地。
                空速越大 → 两者都变大(实测 300/600/900 空速下水平提前量 2124/3655/5283m)。 */}
            航弹落点 {Math.round(hud.bombImpactDist ?? 0)}M · {((hud.bombImpactTof ?? 0)).toFixed(1)}S
          </div>
        </div>
      )}
      {/* === Gun / HVG impact predictor (per user request: 炮类落点指示器) === */}
      {hud.gunImpactScreen && (
        <div className="absolute pointer-events-none" style={{
          left: `${hud.gunImpactScreen.x * 100}%`,
          top: `${hud.gunImpactScreen.y * 100}%`,
        }}>
          {/* Blast radius (A-10 gun splash) */}
          {hud.gunImpactScreen.radius > 3 && (
            <div className="absolute rounded-full border border-[var(--crt-amber-dim)]/60" style={{
              width: hud.gunImpactScreen.radius * 2,
              height: hud.gunImpactScreen.radius * 2,
              left: -hud.gunImpactScreen.radius,
              top: -hud.gunImpactScreen.radius,
            }} />
          )}
          {/* Impact crosshair */}
          <div className="relative -translate-x-1/2 -translate-y-1/2">
            <div className="absolute left-0 top-1/2 w-4 h-px -translate-x-full" style={{ background: 'var(--crt-amber-dim)' }} />
            <div className="absolute left-1/2 top-0 w-px h-4 -translate-y-full" style={{ background: 'var(--crt-amber-dim)' }} />
            <div className="absolute right-0 top-1/2 w-4 h-px translate-x-full" style={{ background: 'var(--crt-amber-dim)' }} />
            <div className="absolute left-1/2 bottom-0 w-px h-4 translate-y-full" style={{ background: 'var(--crt-amber-dim)' }} />
          </div>
        </div>
      )}
      {/* === Manual gun mode (per user request: 纯机炮准心) === */}
      {/* Auto-aim off: the gun fires straight — the aiming RING (rendered by
          the gunAimRing block below) is the gunsight pipper at the gun axis;
          fly to put the ring on the target and lead by hand. */}
      {hud.gunManual && hud.currentWeapon === 'GUN' && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none text-[0.5rem] tracking-[0.3em] text-[var(--crt-amber)]">
          机炮
        </div>
      )}
      {/* === Gun aiming ring (per user request: 机炮瞄准环) === */}
      {/* Shown when the target switch sits on a hostile unit (aircraft or
          ground) within gun effective range. Green = inside the 30° auto-aim
          cone — the ring rides the gun centre axis at the predicted intercept
          point (it leads the target as the gun slews). Amber = in range but
          outside the cone (bring the nose around to engage the assist). */}
      {hud.gunAimRing && (
        <div className="absolute pointer-events-none" style={{
          left: `${hud.gunAimRing.x * 100}%`,
          top: `${hud.gunAimRing.y * 100}%`,
        }}>
          <div className="relative -translate-x-1/2 -translate-y-1/2" style={{ width: '4.5rem', height: '4.5rem' }}>
            <div
              className={`absolute inset-0 rounded-full border-2 ${hud.gunAimRing.active ? 'border-[var(--crt-amber)]' : 'border-[var(--crt-amber-bright)]/60'}`}
              style={hud.gunAimRing.active ? { boxShadow: '0 0 14px rgba(255,176,0,0.45), inset 0 0 10px rgba(255,176,0,0.22)' } : undefined}
            />
            {/* Cross ticks + center dot */}
            <div className={`absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 ${hud.gunAimRing.active ? 'bg-[var(--crt-amber)]/70' : 'bg-[var(--crt-amber-bright)]/40'}`} />
            <div className={`absolute top-1/2 left-0 right-0 h-px -translate-y-1/2 ${hud.gunAimRing.active ? 'bg-[var(--crt-amber)]/70' : 'bg-[var(--crt-amber-bright)]/40'}`} />
            <div className={`absolute left-1/2 top-1/2 w-1.5 h-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${hud.gunAimRing.active ? 'bg-[var(--crt-amber)]' : 'bg-[var(--crt-amber-bright)]/70'}`} />
          </div>
          <div className="text-center text-[0.5rem] tracking-[0.35em] mt-1" style={{ color: hud.gunAimRing.active ? 'var(--crt-amber)' : 'var(--crt-amber-bright)' }}>
            GUN{hud.gunAimRing.active ? ' · AUTO' : ''}
          </div>
        </div>
      )}
      {/* === Mouse-aim cursor (per user request: 战争雷霆式鼠标瞄准) === */}
      {/* WT-style aim circle — tracks the OS pointer in mouse-aim mode. The
          OS cursor is hidden above; this ring IS the aim. Cyan, smaller than
          the gun ring, with cardinal ticks + a centre dot. */}
      {hud.mouseAimCursor && hud.mouseAimCursor.active && (
        <div className="absolute pointer-events-none" style={{
          left: `${hud.mouseAimCursor.x * 100}%`,
          top: `${hud.mouseAimCursor.y * 100}%`,
        }}>
          <div className="relative -translate-x-1/2 -translate-y-1/2" style={{ width: '3.25rem', height: '3.25rem' }}>
            <div className="absolute inset-0 rounded-full border border-[var(--crt-amber-hi)]/80"
              style={{ boxShadow: '0 0 10px rgba(255,176,0,0.3), inset 0 0 6px rgba(255,176,0,0.18)' }} />
            <div className="absolute left-1/2 top-0 w-px h-2 -translate-x-1/2 bg-[var(--crt-amber-hi)]/80" />
            <div className="absolute left-1/2 bottom-0 w-px h-2 -translate-x-1/2 bg-[var(--crt-amber-hi)]/80" />
            <div className="absolute top-1/2 left-0 h-px w-2 -translate-y-1/2 bg-[var(--crt-amber-hi)]/80" />
            <div className="absolute top-1/2 right-0 h-px w-2 -translate-y-1/2 bg-[var(--crt-amber-hi)]/80" />
            <div className="absolute left-1/2 top-1/2 w-1.5 h-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--crt-amber-hi)]" />
          </div>
        </div>
      )}
      {/* === Free-look indicator (per user request) === */}
      {hud.freeLook && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center pointer-events-none">
          <div className="text-xs tracking-[0.4em] text-[var(--crt-amber-hi)] animate-pulse" style={{ textShadow: '0 0 8px rgba(255,176,0,0.45)' }}>
            自由视角
          </div>
        </div>
      )}
      {/* === AC-130 side-firing view indicator (per user request) === */}
      {/* When the player presses K in an AC-130, the camera switches
          to the port-side gunport. Show a prominent "SIDE VIEW" banner so
          the player knows they're in the special aiming mode + a hint that
          they can drag the mouse to aim within a limited cone. */}
      {hud.cameraMode === 'side' && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 text-center pointer-events-none">
          <div className="text-sm tracking-[0.5em] font-bold text-[var(--crt-amber-dim)] animate-pulse" style={{ textShadow: '0 0 10px rgba(255,176,0,0.7)' }}>
            侧炮视角 · 炮手位
          </div>
          <div className="text-[0.625rem] tracking-[0.3em] text-[var(--crt-amber-hi)]/80 mt-1">
            拖动鼠标瞄准 · K 退出
          </div>
          {/* Crosshair for the gunport aim point */}
          <div className="relative mx-auto mt-2 w-10 h-10" style={{ opacity: 0.85 }}>
            <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2" style={{ background: 'var(--crt-amber-dim)' }} />
            <div className="absolute top-1/2 left-0 right-0 h-px -translate-y-1/2" style={{ background: 'var(--crt-amber-dim)' }} />
            <div className="absolute left-1/2 top-1/2 w-2 h-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[var(--crt-amber-dim)]" />
          </div>
        </div>
      )}
      {/* === Side-cannon impact predictor (per user request: 预测炮弹落点和爆炸范围) ===
          While in the AC-130 FPS side view, show where the aimed shell will
          land + a circle of the blast radius. */}
      {hud.sideCannonImpact && (
        <div
          className="absolute pointer-events-none"
          style={{ left: `${hud.sideCannonImpact.x * 100}%`, top: `${hud.sideCannonImpact.y * 100}%` }}
        >
          {/* === 炮手大瞄准环 (per user request: 参考图那种带刻度的侧炮 FPS 环) ===
              环 + 12 个刻度 + 中心 IMPACT 距离读数 + 口径名, 全部以落点为中心。 */}
          <div className="absolute -translate-x-1/2 -translate-y-1/2" style={{ width: 240, height: 240, left: 0, top: 0 }}>
            <div className="absolute inset-0 rounded-full border" style={{ borderColor: 'rgba(255,204,68,0.55)' }} />
            <div className="absolute inset-[18%] rounded-full border" style={{ borderColor: 'rgba(255,204,68,0.35)' }} />
            {Array.from({ length: 24 }).map((_, i) => {
              const long = i % 6 === 0;
              return (
                <div
                  key={i}
                  className="absolute left-1/2 top-1/2"
                  style={{
                    width: long ? 2 : 1,
                    height: long ? 12 : 7,
                    background: long ? 'rgba(255,204,68,0.95)' : 'rgba(255,204,68,0.6)',
                    transform: `translate(-50%,-50%) rotate(${i * 15}deg) translateY(-118px)`,
                  }}
                />
              );
            })}
            {/* 中心: 落点方框 + IMPACT 距离 */}
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
              <div className="w-3 h-3 border" style={{ borderColor: 'var(--crt-red)' }} />
            </div>
            <div
              className="absolute left-1/2 top-[calc(50%+14px)] -translate-x-1/2 whitespace-nowrap text-[0.5625rem] tracking-widest"
              style={{ color: 'var(--crt-red)' }}
            >
              {`IMPACT ${hud.sideCannonImpact.dist ?? 0}M`}
            </div>
            <div
              className="absolute left-1/2 top-[calc(50%-26px)] -translate-x-1/2 whitespace-nowrap text-[0.625rem] tracking-[0.2em]"
              style={{ color: 'var(--crt-amber)' }}
            >
              {hud.sideCannonImpact.gunLabel ? hud.sideCannonImpact.gunLabel.split(' ')[0] : ''} FPS
            </div>
          </div>
          {/* Impact crosshair(保留: 落点本体的细十字) */}
          <div className="relative -translate-x-1/2 -translate-y-1/2">
            <div className="absolute left-0 top-1/2 w-4 h-px -translate-x-full" style={{ background: 'var(--crt-red)' }} />
            <div className="absolute left-1/2 top-0 w-px h-4 -translate-y-full" style={{ background: 'var(--crt-red)' }} />
            <div className="absolute right-0 top-1/2 w-4 h-px translate-x-full" style={{ background: 'var(--crt-red)' }} />
            <div className="absolute left-1/2 bottom-0 w-px h-4 translate-y-full" style={{ background: 'var(--crt-red)' }} />
            {/* 中心点: 落点本身 */}
            <div
              className="absolute left-0 top-0 w-1 h-1 rounded-full -translate-x-1/2 -translate-y-1/2"
              style={{ background: 'var(--crt-red)', boxShadow: '0 0 6px rgba(255,60,60,0.9)' }}
            />
          </div>
          {/* Blast radius circle */}
          <div
            className="absolute rounded-full border border-[var(--crt-red)]/70"
            style={{
              width: hud.sideCannonImpact.radius * 2,
              height: hud.sideCannonImpact.radius * 2,
              left: -hud.sideCannonImpact.radius,
              top: -hud.sideCannonImpact.radius,
              boxShadow: 'inset 0 0 12px rgba(255,60,60,0.15)',
            }}
          />
        </div>
      )}
      {/* === Terrain pull-up warning (per user request) === */}
      {hud.terrainWarning && (
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 text-center pointer-events-none animate-pulse">
          <div className="text-2xl tracking-widest font-bold text-[var(--crt-red)]" style={{ textShadow: '0 0 12px rgba(255,80,80,0.9)' }}>
            {t('hud.terrain') || '地形 — 拉起!'}
          </div>
        </div>
      )}
      {/* Screen-space markers (enemy/ally boxes drawn on the 3D view) */}
      {hud.screenMarkers && hud.screenMarkers.length > 0 ? (
        <ScreenMarkers key="screen-markers" markers={hud.screenMarkers} canvasRef={markerRef} onSelectUnit={onSelectUnit} scale={uiScale} />
      ) : null}

      {/* Top-left: 时间 + 得分 —— §337 去掉面板框(用户: "原本的分数杂项不变但是去掉框"),
          内容(时间/得分/难度等)一个字没动, 只是不再有底/边框。 */}
      <div className="absolute top-3 left-3 px-1 py-2 text-sm leading-tight"
        style={{ textShadow: '0 0 8px rgba(0,0,0,0.85)' }}>
        <div className="flex items-end gap-3">
          <div className="flex flex-col">
            <span className="hud-kicker">{t('hud.time')}</span>
            <span className="hud-value text-xl">{formatTime(hud.missionTime)}</span>
          </div>
          <div className="hud-cell flex flex-col pl-3">
            <span className="hud-kicker">{t('hud.score')}</span>
            <span className="hud-value text-xl">{hud.score.toString().padStart(6, '0')}</span>
          </div>
        </div>
        {/* === Score gain popup (per user request: 僚机击杀左上角加分播报) === */}
        {hud.scoreGain !== undefined && hud.scoreGain > 0 && (
          <div className="hud-value mt-0.5 animate-pulse text-[0.625rem]">
            +{hud.scoreGain}
          </div>
        )}
        {/* Wave indicator — only shown when mission has waves */}
        {hud.totalWaves > 0 ? (
          <div className="hud-row mt-1.5 pt-1.5">
            <div className="flex items-baseline gap-2">
              <span className="hud-kicker">{t('hud.wave')}</span>
              <span className="hud-dots" />
              <span className="hud-value text-base" style={{
                color: hud.waveTransition ? 'var(--crt-amber-hi)' : 'var(--crt-amber)',
              }}>
                {hud.waveTransition
                  ? `${hud.currentWave}/${hud.totalWaves} → ${hud.waveTransitionTime}s`
                  : `${hud.currentWave}/${hud.totalWaves} · ${hud.waveEnemiesRemaining}`}
              </span>
            </div>
          </div>
        ) : null}
      </div>

      {/* Center message banner */}
      {hud.message ? (
        <div key="msg-banner" className="absolute top-24 left-1/2 -translate-x-1/2 text-center">
          <div className="text-2xl tracking-widest font-bold px-6 py-2 hud-panel" style={{ textShadow: '0 0 12px rgba(255,180,80,0.8)', color: 'var(--crt-amber-hi)' }}>
            {hud.message}
          </div>
        </div>
      ) : null}

      {/* Stall warning */}
      {hud.stall ? (
        <div key="stall-warn" className="absolute top-40 left-1/2 -translate-x-1/2 text-center animate-pulse">
          <div className="text-xl tracking-widest font-bold text-[var(--crt-red)]" style={{ textShadow: '0 0 10px rgba(255,80,80,0.8)' }}>
            {t('hud.stall')}
          </div>
        </div>
      ) : null}

      {/* === 速度 / 高度: 上下堆叠 + 中间分隔线 (§337 按用户手绘图的位置) ==========
         用户图: 这一个块在**画面中间偏左、垂直居中**处(既不在底部, 也不在右边) ——
         所以锚点回到老的"速度"位置(left-[27%] top-1/2, 右对齐), 只是把高度从右侧
          搬下来堆在速度下面, 中间一条横线(图里的写法)。
         两行用固定宽列(w-10 右对齐)+ 数值右对齐 ⇒ "速度""高度"两个标签同一竖线(图里就是左对齐一列)。
         两条竖向刻度带(HudTape)已按用户要求**删除** —— per user request:
         "左右的速度和高度表…不要了, 留出来右侧给武器面板"。所以要恢复刻度尺,
         把下面那两行 <HudTape …/> 取消注释即可(组件定义仍在文件末尾)。 */}
      <div className="absolute left-[27%] top-1/2 -translate-y-1/2 text-right pointer-events-none">
        <div className="flex items-baseline justify-end gap-1">
          <span className="crt-gauge__label w-10 text-right mr-1">{t('hud.speed')}</span>
          <span className="crt-tagbox__num text-xl" style={{ minWidth: '3.5rem', textAlign: 'right' }}>{hud.speed}</span>
          <span className="crt-tagbox__unit w-6 text-left">{t('hud.kn')}</span>
        </div>
        <div className="my-0.5" style={{ borderTop: '1px solid rgba(255,176,0,0.5)', boxShadow: '0 0 6px rgba(255,176,0,0.25)' }} />
        <div className="flex items-baseline justify-end gap-1">
          <span className="crt-gauge__label w-10 text-right mr-1">{t('hud.alt')}</span>
          <span className="crt-tagbox__num text-xl" style={{ minWidth: '3.5rem', textAlign: 'right' }}>{hud.altitude}</span>
          <span className="crt-tagbox__unit w-6 text-left">{t('hud.ft')}</span>
        </div>
      </div>
      {/* <HudTape value={hud.speed} step={50} half={250} side="right" at="38%" /> */}
      {/* <HudTape value={hud.altitude} step={500} half={2500} side="left" at="54.5%" /> */}

      {/* Left: 速度 + 油门 + 能量 —— 橙色发光数字指示器(per user request: 去掉黑框) */}
      <div className="absolute left-3 top-1/2 -translate-y-1/2 text-left">
        {/* Throttle bar — 细琥珀刻度条(不再是一块黑框) */}
        <div className="mt-2.5 h-32 w-3 border border-[var(--crt-line)] bg-[rgba(255,176,0,0.10)] relative">
          <div
            className="absolute bottom-0 left-0 right-0"
            style={{ height: `${Math.round(hud.throttle * 100)}%`, background: 'var(--crt-amber)', boxShadow: '0 0 10px rgba(255,176,0,0.85)' }}
          />
        </div>
        <div className="crt-gauge__label mt-1">{t('hud.thr')}</div>
        {/* === Airbrake indicator (per user request: H 键减速板) === */}
        {hud.airbrakeOpen && (
          <div className="mt-1 text-[0.625rem] tracking-widest text-[var(--crt-amber)] animate-pulse" style={{ textShadow: '0 0 8px rgba(255,200,80,0.8)' }}>
            减速板 AIRBRAKE
          </div>
        )}
        {/* === AoA limiter override (per user request: CapsLock 按住解除攻角限制) === */}
        {hud.aoaOverrideActive && (
          <div className="mt-1 text-[0.625rem] tracking-widest text-[var(--crt-red)] animate-pulse" style={{ textShadow: '0 0 8px rgba(255,80,110,0.8)' }}>
            AOA LIMIT OFF{hud.tvcActive ? ' · TVC' : ''}
          </div>
        )}
        {/* Energy bar */}
        <div className="hud-kicker mt-2.5">{t('hud.energy')}</div>
        <div className="h-20 w-3 border border-[var(--crt-line)] bg-[rgba(255,176,0,0.08)] relative">
          <div
            className="absolute bottom-0 left-0 right-0"
            style={{
              height: `${Math.round(hud.energy * 100)}%`,
              background: hud.energy > 0.5 ? 'var(--crt-amber)' : hud.energy > 0.25 ? 'var(--crt-amber-bright)' : 'var(--crt-red)',
            }}
          />
        </div>
      </div>

      {/* Right: HP + 结构完整度 + 攻角 —— 保持在垂直居中(right-3 top-1/2)。
          §338: 用户明确要求"无视ui遮挡, 把武器面板放在我指定的位置上"
          ⇒ 武器面板固定在 right-[2rem](与这一列同高度、会叠在一起也没关系),
            这一列**不再让位**, 原样留在垂直居中。 */}
      <div className="absolute right-3 top-1/2 -translate-y-1/2 text-right">
        {/* HP bar */}
        <div className="mt-2.5 ml-auto h-32 w-3 border border-[var(--crt-line)] bg-[rgba(255,176,0,0.10)] relative">
          <div
            className="absolute bottom-0 left-0 right-0"
            style={{
              height: `${Math.max(0, Math.min(100, (hud.hp / Math.max(1, hud.maxHp)) * 100))}%`,
              // 三段阈值: 充足=主琥珀 / 受损=亮琥珀 / 危险=警示红(语义色)
              background: hud.hp / Math.max(1, hud.maxHp) > 0.5 ? 'var(--crt-amber)' : hud.hp / Math.max(1, hud.maxHp) > 0.25 ? 'var(--crt-amber-bright)' : 'var(--crt-red)',
              boxShadow: '0 0 10px rgba(255,176,0,0.8)',
            }}
          />
        </div>
        <div className="crt-gauge__label mt-1">{t('hud.dmg', { n: Math.max(0, Math.round(hud.maxHp - hud.hp)) })}</div>
        <div className="crt-gauge__label mt-0.5">{Math.round(hud.hp)}/{Math.round(hud.maxHp)}</div>
        {/* AoA indicator */}
        <div className="crt-gauge__label mt-2.5">攻角 AoA</div>
        <div className="crt-gauge__num text-base" style={{
          color: Math.abs(hud.aoa) > 18 ? 'var(--crt-red)' : Math.abs(hud.aoa) > 10 ? 'var(--crt-amber-bright)' : 'var(--crt-amber)',
        }}>
          {`${hud.aoa > 0 ? '+' : ''}${hud.aoa.toFixed(1)}°`}
        </div>
      </div>

      {/* Heading tape top center */}
      <div className="absolute top-14 left-1/2 -translate-x-1/2 text-center">
        <div className="text-xs opacity-80">{t('hud.hdg')}</div>
        <div className="text-lg tracking-widest">{`${Math.round(hud.heading).toString().padStart(3, '0')}°`}</div>
      </div>

      {/* === G 力读数已按用户要求**删除** (per user request: "g力值显示不要了") ===
          原来这里在准星下方居中显示 `G x.x`。要恢复: 从 git 取回这一段即可(读 hud.gForce)。 */}

      {/* === 临时镜头缩放读数 (per user request: 精确化调整相机缩放) ===
          过载值下面;控制台 `__zoomHud()`(或关卡内控制台 `zoomhud`)一键开关。
          两行分别是(4 位小数是为了"精确化调整" —— 滚轮无级缩放的步进比 1% 还小):
            ① ZOOM ×N  = 相对**默认机位**的画面放大倍率。1.0000 = 设置里那个机位;
                         滚轮/`zoom 1.4` 拉近(相机靠近机体)→ N > 1 画面更大, 拉远 → N < 1。
            ② zoomMult = 相机内部的原始数值(默认机位 = 0.72, 越小相机越近)。
                         N 与它是倒数关系: N = 0.72 / zoomMult。
          (N 就是"我还要放大多少倍"要调的量; zoomMult 只在需要看原始值时有用。) */}
      {hud.zoomReadout ? (
        <div
          key="zoom-readout"
          className="absolute top-1/2 left-1/2 -translate-x-1/2 translate-y-24 text-center font-mono text-[11px] leading-tight"
          style={{ color: 'var(--crt-amber)', textShadow: '0 0 6px rgba(255,176,0,0.5)' }}
        >
          <div title="相对默认机位的放大倍率">{`ZOOM ×${hud.cameraZoom.toFixed(4)}`}</div>
          <div className="opacity-70" title="相机内部 zoomMult(默认机位 0.72)">{`zoomMult ${hud.zoomRaw.toFixed(4)}`}</div>
        </div>
      ) : null}

      {/* === Flight instruments (per user request: 速度矢量 + 机头指向矢量) ===
          Drawn on their own always-on canvas (independent of marker count):
            - FPM = velocity vector: green circle with wings + fin, showing
              where the aircraft is actually GOING (world velocity).
            - Nose marker: amber diamond, showing where the NOSE points.
          Under angle of attack the two separate — that's the point. */}
      <FlightVectors key="flight-vectors" velocityVector={hud.velocityVector} noseVector={hud.noseVector} scale={uiScale} />

      {/* === 锁定程度读数已按用户要求**删除** (per user request: "锁定程度不要了") ===
          原来这里在准星上方居中显示 `锁定 N%` / `已锁定`。连同下面那圈随锁定进度收缩的
          IR 环(LockReticle)一起去掉了 —— 两者是同一个"锁定程度"指示。
          目标的识别不受影响: 目标框/距离仍由 ScreenMarkers 画(见上面的 screen-markers)。 */}

      {/* === Incoming-lock radar alert (per user request: 被锁定时有雷达告警) ===
          Flashing red warning whenever an enemy is locking the player or an
          enemy missile is inbound. Distinct from the player's own lock HUD. */}
      {/* === 过场运镜: 上下黑边 (per user request: 关卡内过场动画) === */}
      {hud.cinematic && (
        <>
          <div key="cine-top" className="pointer-events-none absolute inset-x-0 top-0 z-40 bg-black" style={{ height: '11%' }} />
          <div key="cine-bottom" className="pointer-events-none absolute inset-x-0 bottom-0 z-40 bg-black" style={{ height: '13%' }} />
          <div key="cine-note" className="pointer-events-none absolute bottom-[13%] left-1/2 z-40 -translate-x-1/2 text-[9px] tracking-[0.4em] text-[var(--crt-amber-dim)]">
            CINEMATIC
          </div>
        </>
      )}

      {hud.incomingLock && (
        <div key="incoming-lock" className="absolute top-24 left-1/2 -translate-x-1/2 text-center animate-pulse">
          <div className="text-[var(--crt-red)] text-sm font-bold tracking-[0.4em]" style={{ textShadow: '0 0 10px rgba(255,40,40,0.9)' }}>
            {t('hud.incomingLock')}
          </div>
        </div>
      )}

      {/* === 锁定光环(LockReticle)已按用户要求**删除** ==========================
          per user request: "锁定程度…不要了"。原来这里画两种锁定提示:
            · 红外弹(MSL/QAAM/LASM): 随锁定进度收缩+抖动的红圈
            · 雷达弹(LAAM/SARH): 抖动/旋转的小方框
         两者都是"锁定程度"的可视化, 所以连同上面的 `锁定 N%` 文字一起去掉。
         目标本身仍可辨认: 目标框/距离由 ScreenMarkers 画, 见上面 screen-markers 段。 */}

      {/* Wingman command indicator (top-right area) */}
      {/* === 不带僚机模式 (per user request) === */}
      {hud.wingmenEnabled === false && (
        <div className="absolute top-16 right-3 text-right text-xs opacity-80">
          <div className="opacity-70">{t('hud.wingman')}</div>
          <div className="text-base tracking-widest text-[var(--crt-amber-dim)]">未派遣</div>
        </div>
      )}
      {hud.wingmenEnabled !== false && (
      <div className="absolute top-16 right-3 text-right text-xs">
        <div className="opacity-70">{t('hud.wingman')}</div>
        <div className="text-base tracking-widest" style={{
          color: hud.wingmanCommand === 'attack' ? 'var(--crt-amber-dim)' : hud.wingmanCommand === 'cover' ? 'var(--crt-amber-bright)' : 'var(--crt-amber)',
        }}>
          {zhValue(WINGMAN_CMD_ZH, hud.wingmanCommand.toUpperCase())}
        </div>
        <div className="text-[0.625rem] opacity-60 mt-1">{t('hud.wingmanHint')}</div>
        {/* Reinforcement call status */}
        <div className="text-[0.625rem] mt-1.5" style={{
          color: hud.reinforcementsRemaining <= 0 ? 'var(--crt-amber-ghost)' : hud.reinforcementCooldown > 0 ? 'var(--crt-amber-dim)' : 'var(--crt-amber)',
        }}>
          {t('hud.reinforce')}: {
            hud.reinforcementsRemaining <= 0
              ? t('hud.reinforceEmpty')
              : hud.reinforcementCooldown > 0
                ? t('hud.reinforceCooldown').replace('{n}', String(Math.ceil(hud.reinforcementCooldown)))
                : `${t('hud.reinforceReady')} (${hud.reinforcementsRemaining})`
          }
        </div>
      </div>
      )}

      {/* Bottom-left: tactical map */}
      <div className="absolute bottom-3 left-3">
        <Minimap
          blips={hud.minimapBlips}
          playerPos={hud.playerPos}
          playerHeading={hud.heading}
          targetId={targetId}
          size={Math.round(180 * uiScale)}
          range={hud.radarRange || 8000}
          zones={hud.zones}
          airburst={hud.airburstWarning ?? null}
        />
        <div className="text-[0.625rem] opacity-70 mt-1 text-center tracking-widest">
          {t('hud.tacmap')} · {(hud.radarRange ? (hud.radarRange / 1000).toFixed(0) : '8')}KM
          {/* === Radar filter indicator (per user request: 雷达指示可开关) === */}
          {hud.radarFilter && (
            <span className="ml-2 text-[var(--crt-amber)]">· 过滤</span>
          )}
        </div>
      </div>

      {/* Weather indicator (top-center under objective) */}
      <div className="absolute top-24 left-3 text-xs opacity-80">
        <div className="opacity-70">{t('hud.wx')}</div>
        <div className="text-sm tracking-widest" style={{
          color: hud.stormIntensity > 0.6 ? 'var(--crt-amber-bright)' : hud.stormIntensity > 0.3 ? 'var(--crt-amber)' : 'var(--crt-amber-dim)',
        }}>
          {zhValue(WEATHER_ZH, hud.weather.toUpperCase())}
        </div>
        <div className="text-[0.625rem] opacity-60">{t('hud.wind', { n: Math.round(hud.windSpeed) })}</div>
      </div>

      {/* === 武器面板 (§337 按用户手绘图: 右侧、垂直居中) ======================
          用户图里这一块在**画面右侧偏中**(与中间的速度/高度同一高度带, 不在右下角)。
          §338: 用户指定 `right-[2rem]` 并明确交代"**无视 ui 遮挡**, 就放在我指定的位置"
          ⇒ 位置就是这个数, 不为了避让别的读数而挪。它与最右那列 HP/攻角指示器
            (right-3, 垂直居中)会在同一高度上叠着 —— 这是**用户明确接受**的结果, 不要"优化"。
          修复方向(如果哪天要消除叠加): 把 HP/攻角那列移到别的侧/别的区, 或本块右移到
            right-[11rem] 以外 —— 但请先问, 别自作主张。
          用户草图规则(逐条落地):
            · "原本的分数杂项不变但是去掉框" => 沿用原来的读数, 但**不再有面板框**。
            · "装备的所有武器" => 列出本机实际装备的武器种类(弹量 0 的不列)。
            · "被选到的武器会排序到最下面…之前被切换的武器从上面排序进来"
              => 顺序 = [其它装备武器(固定种类序)] + [当前选中的那一种] 放最后一行。
            · "子项武器 / 的剩余弹量" => 每种右边的粗条 + 数字(条长 = 当前/本局最大弹量)。
            · "1/2 …右边是所有冷却槽的数量, 左边是冷却完毕待发的数量"
              => 当前武器行下面一条分隔线, 再下面 `待发 / 总数`(hud.weaponSlots)。 */}
      <div className="absolute right-[2rem] top-1/2 -translate-y-1/2 px-2 text-right text-sm leading-tight pointer-events-none">
        {(() => {
          const W = hud.weapons as unknown as Record<string, number>;
          const MAX = (hud.weaponMax ?? {}) as Record<string, number>;
          // 本机装备的武器种类(固定种类序 = "从上面排序进来"时的稳定顺序)
          const ORDER: WeaponType[] = ['GUN', 'SIDE', 'EW', 'MSL', 'LASM', 'LAAM', 'QAAM', 'SARH', 'VASM', 'BDL', 'CLB', 'HVG', 'NKV', 'FLR'];
          const LABEL: Partial<Record<WeaponType, string>> = {
            GUN: '机炮', SIDE: '侧炮', EW: '电子战', MSL: 'msl', LASM: 'lasm', LAAM: 'laam',
            QAAM: 'qaam', SARH: 'sarh', VASM: 'vasm', BDL: 'bdl', CLB: 'clb', HVG: 'hvg', NKV: 'nkv',
            FLR: '干扰弹',
          };
          const equipped = ORDER.filter((w) => (W[w] ?? 0) !== 0);
          const cur = hud.currentWeapon as WeaponType;
          // 选中的排到最下面; 其余按种类序从上面排进来
          const rows = [...equipped.filter((w) => w !== cur), ...(equipped.includes(cur) ? [cur] : [])];
          const slots = hud.weaponSlots ?? [];
          const ready = slots.filter(Boolean).length;
          return (
            <>
              {rows.map((w) => {
                const sel = w === cur;
                const n = W[w] ?? 0;
                const inf = n < 0;                       // -1 = 无限(GUN/SIDE/EW)
                const max = Math.max(MAX[w] ?? 0, n, 1);
                const frac = inf ? 1 : Math.max(0, Math.min(1, n / max));
                return (
                  <div
                    key={w}
                    className={`flex items-center justify-end gap-1.5 ${sel ? 'text-[1.35rem]' : 'text-[0.95rem] opacity-45'}`}
                  >
                    {/* 选中的名字被推到最左(整行右对齐 => 名字跟着弹量条一起左移) */}
                    <span
                      className={sel ? 'text-[var(--crt-amber)]' : ''}
                      style={sel ? { textShadow: '0 0 8px rgba(255,196,80,0.75)' } : undefined}
                    >
                      {sel ? `${LABEL[w] ?? w}` : (LABEL[w] ?? w)}
                    </span>
                    {/* 子项武器的剩余弹量粗条 */}
                    <span
                      className="inline-block align-middle border border-[var(--crt-line)]"
                      style={{
                        width: `${Math.round(6 + frac * 46)}px`,
                        height: sel ? '9px' : '6px',
                        background: sel
                          ? 'linear-gradient(90deg, var(--crt-amber-deep), var(--crt-amber))'
                          : 'rgba(255,176,0,0.35)',
                        boxShadow: sel ? '0 0 6px rgba(255,176,0,0.55)' : undefined,
                      }}
                    />
                    <span className={`hud-value ${sel ? 'text-xs text-[var(--crt-amber)]' : 'text-[0.625rem]'}`}>
                      {inf ? '∞' : n.toString().padStart(2, '0')}
                    </span>
                  </div>
                );
              })}
              {/* 当前武器的冷却槽: 待发 / 总数(1/2 = 2 个槽里 1 个装填完毕) */}
              {slots.length > 0 && equipped.includes(cur) && (
                <div className="mt-0.5 pt-0.5 flex items-center justify-end gap-2" style={{ borderTop: '1px solid rgba(255,176,0,0.45)' }}>
                  <span className="text-[0.5625rem] tracking-widest text-[var(--crt-amber-dim)]">冷却槽</span>
                  <span className="text-base tracking-widest" style={{ color: ready > 0 ? 'var(--crt-amber)' : 'var(--crt-red)' }}>
                    {ready}/{slots.length}
                  </span>
                </div>
              )}
            </>
          );
        })()}
        {/* === §339 无制导提示: 此刻开火这枚弹不会追目标(没锁定) ==================
            放在武器面板最下面一行, 与"冷却槽"同区 —— 只看一眼就知道这一发是火箭弹。 */}
        {hud.unguided && (
          <div className="mt-1 flex items-center justify-end gap-1.5">
            <span className="text-[0.5625rem] tracking-widest text-[var(--crt-red)] animate-pulse"
              style={{ textShadow: '0 0 6px rgba(255,80,80,0.8)' }}>
              {getLocale() === 'zh' ? '无制导' : 'UNGUIDED'}
            </span>
          </div>
        )}
        {/* 机炮冷却槽(原来就有, 保留) */}
        {(hud.weapons.GUN ?? 0) !== 0 && hud.gunHeat !== undefined && (
          <div className="flex items-center justify-end gap-1.5 mt-1">
            <span className="text-[0.5rem] tracking-widest" style={{ color: hud.gunOverheated ? 'var(--crt-red)' : 'rgba(255,176,0,0.5)' }}>
              热量
            </span>
            <div className="w-16 h-1.5 bg-[rgba(0,0,0,0.5)] border border-[var(--crt-line)] overflow-hidden">
              <div className="h-full transition-[width] duration-100" style={{
                width: `${Math.round(hud.gunHeat * 100)}%`,
                background: hud.gunOverheated ? 'var(--crt-red)' : hud.gunHeat > 0.7 ? 'var(--crt-amber)' : 'var(--crt-green)',
                boxShadow: hud.gunOverheated ? '0 0 6px rgba(255,90,90,0.9)' : undefined,
              }} />
            </div>
            {hud.gunOverheated && <span className="text-[0.5rem] text-[var(--crt-red)] animate-pulse">过热</span>}
          </div>
        )}
        {/* Ability charge bars */}
        {hud.abilities?.sideCannon && (
          <div className="mt-1 text-[0.625rem]">
            <div className="opacity-70">{t('hud.sideChg')}</div>
            <div className="w-24 h-1.5 bg-white/10 ml-auto">
              <div className="h-full bg-[var(--crt-amber-dim)]" style={{ width: `${Math.round(hud.sideCannonCharge * 100)}%` }} />
            </div>
          </div>
        )}
        {hud.abilities?.jammer && (
          <div className="mt-1 text-[0.625rem]">
            <div className="opacity-70">{t('hud.jammerChg')}</div>
            <div className="w-24 h-1.5 bg-white/10 ml-auto">
              <div className="h-full bg-[var(--crt-amber-bright)]" style={{ width: `${Math.round(hud.jammerCharge * 100)}%` }} />
            </div>
          </div>
        )}
      </div>

      {/* Bottom-center: target info —— §337 回到原来的底部中线(速度/高度已挪到中间偏左, 不再占用这里) */}
      {hud.targetName ? (
        <div key="tgt-info" className="absolute bottom-3 left-1/2 -translate-x-1/2 text-center text-xs">
          <div className="opacity-80">{`${t('hud.tgt')}: ${hud.targetName}`}</div>
          <div>{t('hud.dist', { n: hud.targetDist, a: hud.targetAspect })}</div>
        </div>
      ) : null}
      {/* === Radio chatter — 电影式字幕(per user request) ===
          用户反馈: 之前的四向黑描边"像小游戏"、字号偏小。改为正规影视字幕做法:
          浅色衬线大字 + 半透明底条 + 柔和投影(不再用硬描边), 字号跟电影字幕一个量级。 */}
      <div
        key="radio-chatter"
        className="absolute bottom-20 left-1/2 flex max-w-[86vw] -translate-x-1/2 flex-col items-center gap-1.5 text-center"
        style={{ display: hud.radioMessages && hud.radioMessages.length > 0 ? 'flex' : 'none' }}
      >
        {(hud.radioMessages || []).slice(-3).map((m) => {
          const cls =
            m.side === 'enemy' ? 'crt-subtitle crt-subtitle--enemy'
              : m.side === 'awacs' ? 'crt-subtitle crt-subtitle--awacs'
                : 'crt-subtitle';
          return (
            <div key={m.id} className={cls}>
              {/* §351: 名字按阵营着色(敌=红 / 友军=蓝 / 管制·旁白=琥珀) */}
              <span className={`crt-subtitle__spk crt-subtitle__spk--${m.side}`}>{`[${m.speaker}]`}</span>
              <span>{m.text}</span>
            </div>
          );
        })}
      </div>

      {/* === 进关标题卡 (per user request: 电影开场标题, 显示时间+任务, 3 秒后消失) ===
          上行大号衬线标题(电影开场量级), 下行小写字距的时间/代号行。
          计时用墙钟(missionStartedAt), 到 3s 强制卸载, 不做"淡出后仍占位"。 */}
      {missionStartedAt > 0 && Date.now() - missionStartedAt < 3000 && (
        <div
          key="mission-titlecard"
          /* 放画面上三分之一: 34% 会与屏幕中部的锁定框/单位标记/目标信息重叠(预览页实测)。 */
          className="pointer-events-none absolute inset-x-0 top-[20%] flex flex-col items-center gap-2.5 text-center"
        >
          <div className="crt-subtitle--title">{missionTitle}</div>
          <div className="crt-subtitle--accent">
            {`T ${new Date(missionStartedAt).toTimeString().slice(0, 5)} · ${missionCodename}`}
          </div>
          <div className="mt-0.5 h-[2px] w-44 opacity-70" style={{ background: 'var(--crt-amber)', boxShadow: '0 0 10px rgba(255,176,0,0.8)' }} />
        </div>
      )}

      {/* Camera mode indicator */}
      <div className="absolute top-3 right-3 text-xs opacity-70 text-right">
        <div>{t('hud.cam', { mode: zhValue(CAM_MODE_ZH, hud.cameraMode.toUpperCase()) })}</div>
        {/* === 视角缩放倍率 (per user request: 无级缩放 + UI 显示倍率) ===
            cameraZoom 相对设置机位(1.0=默认);滚轮无级缩放时实时变化,
            非默认时高亮以便看清当前倍率。 */}
        <div
          className="font-mono mt-0.5"
          style={{
            color: Math.abs(hud.cameraZoom - 1) < 0.005 ? undefined : 'var(--crt-amber)',
            opacity: Math.abs(hud.cameraZoom - 1) < 0.005 ? 0.55 : 1,
          }}
        >
          ZOOM ×{hud.cameraZoom.toFixed(2)}
        </div>
      </div>

      {/* Vignette */}
      <div className="absolute inset-0 pointer-events-none" style={{
        background: 'radial-gradient(circle at center, transparent 55%, rgba(0,0,0,0.5) 100%)',
      }} />
    </div>
  );
}

// === Flight instruments (per user request: 速度矢量 + 机头指向矢量) ===
// Always-on canvas that draws two projected flight instruments:
//   - FPM (velocity vector): a green circle with horizontal wings + vertical
//     fin — where the aircraft's WORLD velocity points (flight-path marker).
//   - Nose vector: an amber hollow diamond — where the aircraft nose points.
function FlightVectors({ velocityVector, noseVector, scale = 1 }: {
  velocityVector?: { x: number; y: number } | null;
  noseVector?: { x: number; y: number } | null;
  scale?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.6);
    const W = window.innerWidth;
    const H = window.innerHeight;
    const bw = Math.floor(W * dpr);
    const bh = Math.floor(H * dpr);
    if (c.width !== bw || c.height !== bh) {
      c.width = bw;
      c.height = bh;
      c.style.width = W + 'px';
      c.style.height = H + 'px';
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // === Velocity vector (FPM): 绿色圆环 + 翼 + 立尾 (per user request: 回退到绿色) ===
    if (velocityVector) {
      const px = velocityVector.x * W;
      const py = velocityVector.y * H;
      const r = 12 * scale;
      ctx.strokeStyle = CANVAS_COLOR.green;
      ctx.lineWidth = 1.8 * scale;
      ctx.shadowColor = CANVAS_COLOR.green;
      ctx.shadowBlur = 8 * scale;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.stroke();
      // Wings
      const wing = 13 * scale;
      ctx.beginPath();
      ctx.moveTo(px - r - wing, py);
      ctx.lineTo(px - r + 4 * scale, py);
      ctx.moveTo(px + r + wing, py);
      ctx.lineTo(px + r - 4 * scale, py);
      ctx.stroke();
      // Vertical fin
      ctx.beginPath();
      ctx.moveTo(px, py - r - 9 * scale);
      ctx.lineTo(px, py - r + 4 * scale);
      ctx.stroke();
    }

    // === Nose vector: 绿色空心菱形 (per user request: 回退到绿色) ===
    if (noseVector) {
      const px = noseVector.x * W;
      const py = noseVector.y * H;
      const r = 7 * scale;
      ctx.strokeStyle = CANVAS_COLOR.green;
      ctx.lineWidth = 1.6 * scale;
      ctx.shadowColor = CANVAS_COLOR.green;
      ctx.shadowBlur = 7 * scale;
      ctx.beginPath();
      ctx.moveTo(px, py - r);
      ctx.lineTo(px + r, py);
      ctx.lineTo(px, py + r);
      ctx.lineTo(px - r, py);
      ctx.closePath();
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
  }, [velocityVector, noseVector, scale]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{ width: '100vw', height: '100vh' }}
    />
  );
}


/**
 * === 竖向刻度带 (per user request: 速度/高度数字 UI 按参考图那样带刻度尺) ======
 *
 * 参考图里 SPEED / ALT 数字旁边各有一条"梯子"状刻度带, **当前值永远在带的中央**,
 * 刻度跟着数值上下滑动。实现上只是把 ±half 范围内的刻度按"每格 px"排布, 越界的被
 * 容器 overflow 裁掉 —— 每帧约 11 个刻度节点, 开销可忽略。
 *
 *   value  当前值(速度 kn / 高度 ft)
 *   step   一根刻度的步长(速度 50 / 高度 500)
 *   half   带子上下各显示多少(以步长为单位) —— 速度 ±250 / 高度 ±2500
 *   side   刻度线朝哪边伸(速度带在画面左侧, 刻度朝右; 高度带镜像)
 *   at     定位(相对画面宽度的百分比)—— 速度带宽 38% / 高度带 54.5%(靠近中央)
 */
function HudTape({ value, step, half, side, at }: {
  value: number; step: number; half: number; side: 'left' | 'right'; at: string;
}) {
  const PX_PER_STEP = 16;
  const base = Math.round(value / step) * step;
  const nodes: React.ReactNode[] = [];
  for (let v = base - half; v <= base + half + 1e-6; v += step) {
    const off = ((value - v) / step) * PX_PER_STEP;      // 当前值落在带子中央
    const major = Math.abs(v % (step * 5)) < 1e-6;        // 每 5 格一个长刻度 + 数字
    nodes.push(
      <div
        key={v}
        className="absolute flex items-center"
        style={{ top: `calc(50% + ${off}px)`, [side === 'right' ? 'left' : 'right']: 0, transform: 'translateY(-50%)' } as React.CSSProperties}
      >
        <div style={{
          width: major ? 13 : 7, height: 1,
          background: 'var(--crt-amber)',
          opacity: major ? 0.85 : 0.45,
          boxShadow: major ? '0 0 5px rgba(255,176,0,0.6)' : 'none',
        }} />
        {major ? (
          <span className="text-[0.5rem] leading-none px-1"
            style={{ color: 'var(--crt-amber)', opacity: 0.8, textShadow: '0 1px 2px rgba(0,0,0,0.9)' }}>
            {v}
          </span>
        ) : null}
      </div>,
    );
  }
  return (
    <div className="absolute top-1/2 -translate-y-1/2 h-[170px] w-24 overflow-hidden pointer-events-none crt-tape"
      style={{ left: at }}>
      {/* 带子中轴(细线)——参考图里那条贯穿刻度带的竖线 */}
      <div className="absolute top-0 bottom-0 left-0 w-px" style={{ background: 'var(--crt-line)', opacity: 0.55 }} />
      {/* 中央指针: 当前值所在位置(短横线 + 两侧小点) */}
      <div className="absolute top-1/2 -translate-y-1/2 left-0 flex items-center">
        <div style={{ width: 16, height: 2, background: 'var(--crt-amber-hi)', boxShadow: '0 0 8px rgba(255,200,80,0.9)' }} />
      </div>
      {nodes}
    </div>
  );
}

function formatTime(s: number): string {  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;
}

interface ScreenMarker {
  x: number; y: number;
  type: 'enemy' | 'ally' | 'neutral' | 'missile';
  id: number;
  onScreen: boolean;
  isTarget: boolean;
  dist: number;
  edgeX: number;
  edgeY: number;
  name?: string;
  modelName?: string;  // 载具型号
  isNext?: boolean;    // 下一个切换候选 → NE 标记
  occluded?: boolean;  // 视线被遮挡 → 虚线框
  isPlayer?: boolean;  // 玩家机 → 名字常驻显示
  important?: boolean; // 重要单位(友军轰炸机/运输机) → 框上打绿 X + 细外圈
}

// === Click-to-target hit test (per user request: 鼠标主动左键点击敌人的雷达框切换目标) ===
// Pure function matching a click position against the on-screen marker
// boxes (same box math as the draw pass). Returns the marker's unit id, or
// null when the click missed every box. Exported for unit testing.
export function hitTestMarkers(
  markers: ScreenMarker[],
  W: number,
  H: number,
  clickX: number,
  clickY: number,
  scale = 1,
): number | null {
  let best: { id: number; d: number } | null = null;
  for (const m of markers) {
    if (!m.onScreen || m.type === 'missile') continue;
    const px = m.x * W;
    const py = m.y * H;
    const distFactor = Math.max(0.25, Math.min(1, 1500 / Math.max(m.dist, 250)));
    const boxSize = (22 + distFactor * 30) * scale;
    const half = boxSize / 2 + 4 * scale; // +4px grace
    if (Math.abs(clickX - px) <= half && Math.abs(clickY - py) <= half) {
      const d = (clickX - px) ** 2 + (clickY - py) ** 2;
      if (!best || d < best.d) best = { id: m.id, d };
    }
  }
  return best ? best.id : null;
}

function ScreenMarkers({ markers, canvasRef, onSelectUnit, scale = 1 }: {
  markers: ScreenMarker[];
  canvasRef: RefObject<HTMLCanvasElement | null>;
  onSelectUnit?: (id: number) => void;
  scale?: number;
}) {
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.6);
    const W = window.innerWidth;
    const H = window.innerHeight;
    const bw = Math.floor(W * dpr);
    const bh = Math.floor(H * dpr);
    if (c.width !== bw || c.height !== bh) {
      c.width = bw;
      c.height = bh;
      c.style.width = W + 'px';
      c.style.height = H + 'px';
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const cx = W / 2;
    const cy = H / 2;
    // === Off-screen arrow ring (per user request: 箭头靠近屏幕中心) ===
    // 30% of the smaller screen dimension from centre — well inside the
    // edges so the enlarged target arrow stays readable in peripheral view.
    const edgeR = Math.min(W, H) * 0.30;

    for (const m of markers) {
      const color = m.type === 'enemy' ? (m.isTarget ? CANVAS_COLOR.red : CANVAS_COLOR.green)
        : m.type === 'ally' ? CANVAS_COLOR.ally
        : m.type === 'neutral' ? '#ffffff'  // === Per user request: white box for neutral units ===
        : CANVAS_COLOR.amberHi;
      // === Neutral units get a DIAMOND instead of a square bracket box ===
      // so they're visually distinct from enemy/ally at a glance.
      const isNeutral = m.type === 'neutral';
      if (m.onScreen) {
        const px = m.x * W;
        const py = m.y * H;
        const distFactor = Math.max(0.25, Math.min(1, 1500 / Math.max(m.dist, 250)));
        const boxSize = (22 + distFactor * 30) * scale;
        const half = boxSize / 2;
        ctx.strokeStyle = color;
        ctx.lineWidth = (m.isTarget ? 2.4 : 1.6) * scale;
        ctx.shadowColor = color;
        ctx.shadowBlur = (m.isTarget ? 10 : 4) * scale;
        // === Occlusion (per user request: 被实体/障碍物遮挡变虚线) ===
        // When terrain/buildings/other units block the line of sight, the
        // frame renders DASHED so the player knows they can't see the target.
        if (m.occluded) ctx.setLineDash([5 * scale, 4 * scale]);
        // === Neutral units: draw a diamond outline instead of corner brackets ===
        // (per user request — distinct visual from enemy/ally boxes)
        if (isNeutral) {
          ctx.beginPath();
          ctx.moveTo(px, py - half);
          ctx.lineTo(px + half, py);
          ctx.lineTo(px, py + half);
          ctx.lineTo(px - half, py);
          ctx.closePath();
          ctx.stroke();
          // Inner cross
          ctx.beginPath();
          ctx.moveTo(px - half * 0.4, py);
          ctx.lineTo(px + half * 0.4, py);
          ctx.moveTo(px, py - half * 0.4);
          ctx.lineTo(px, py + half * 0.4);
          ctx.stroke();
        } else {
          const cornerLen = boxSize * 0.28;
          const drawCorner = (ox: number, oy: number, dx: number, dy: number) => {
            ctx.beginPath();
            ctx.moveTo(px + ox + dx * cornerLen, py + oy);
            ctx.lineTo(px + ox, py + oy);
            ctx.lineTo(px + ox, py + oy + dy * cornerLen);
            ctx.stroke();
          };
          drawCorner(-half, -half, 1, 1);
          drawCorner(half, -half, -1, 1);
          drawCorner(-half, half, 1, -1);
          drawCorner(half, half, -1, -1);
        }
        ctx.setLineDash([]);
        // === 重要单位(友军轰炸机/运输机, 如 s02 的护航编队) → 框上打 X + 细外圈 ===
        // 用户要求: 这几架必须和普通单位一眼区分得开(它们是"要保护的目标", 不是杂兵)。
        // 颜色沿用雷达同一段的亮绿 #54e08c(见 Radar.tsx 的 drawImportantMark)—— 框上
        // 敌红/友蓝/中立白/导弹琥珀/选中金都没占绿色 ⇒ 读作"保护这个", 不会被误认成
        // 选中框或敌机。X 的长臂只到半宽的 0.62(画在框内), 所以不压住上下两行的
        // 型号/距离文字; 外圈在框外 2px(红选中框在 3px) ⇒ 两种标记可以同时出现。
        // save/restore 是必须的: 不还原 shadowColor 会让下面 isTarget 的红色型号文字
        // 带上绿色阴影。
        if (m.important) {
          ctx.save();
          ctx.strokeStyle = '#54e08c';
          ctx.shadowColor = '#54e08c';
          ctx.shadowBlur = 6 * scale;
          ctx.lineWidth = 1 * scale;
          ctx.beginPath();
          ctx.arc(px, py, half + 2 * scale, 0, Math.PI * 2);
          ctx.stroke();
          ctx.lineWidth = 2 * scale;
          const xs = half * 0.62;
          ctx.beginPath();
          ctx.moveTo(px - xs, py - xs);
          ctx.lineTo(px + xs, py + xs);
          ctx.moveTo(px + xs, py - xs);
          ctx.lineTo(px - xs, py + xs);
          ctx.stroke();
          ctx.restore();
        }
        if (m.isTarget) {
          ctx.strokeStyle = CANVAS_COLOR.red;
          ctx.lineWidth = 1.2 * scale;
          ctx.globalAlpha = 0.55;
          if (m.occluded) ctx.setLineDash([5 * scale, 4 * scale]);
          ctx.strokeRect(px - half - 3 * scale, py - half - 3 * scale, boxSize + 6 * scale, boxSize + 6 * scale);
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
          // === 载具型号 (per user request: 显示被切换目标的型号) ===
          ctx.fillStyle = CANVAS_COLOR.red;
          ctx.font = `bold ${11 * scale}px monospace`;
          ctx.textAlign = 'center';
          ctx.fillText(m.modelName ?? '目标', px, py - half - 8 * scale);
        }
        // === Next switch candidate (per user request: 雷达框上显示 NE) ===
        // Amber "NE" tag above the frame of the unit the next Tab press
        // will select — so the player can predict the switch.
        if (m.isNext) {
          ctx.fillStyle = CANVAS_COLOR.amberHi;
          ctx.font = `bold ${11 * scale}px monospace`;
          ctx.textAlign = 'center';
          ctx.fillText('NE', px, py - half - (m.isTarget ? 24 : 8) * scale);
        }
        // === 玩家名字常驻显示 (per user request: 友军或敌军玩家的雷达框上常驻名字) ===
        // 不论距离远近、是不是当前目标: 只要是玩家就显示名字, 颜色沿用该框的
        // IFF 颜色 —— 敌对阵营的玩家名字与敌军同色。
        const playerNameShown = !!(m.isPlayer && m.name);
        if (playerNameShown) {
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.95;
          ctx.font = `bold ${10 * scale}px monospace`;
          ctx.textAlign = 'center';
          ctx.fillText(m.name as string, px, py + half + 12 * scale);
          ctx.globalAlpha = 1;
        }
        if (m.dist > 350 && m.type !== 'missile') {
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.85;
          ctx.font = `${10 * scale}px monospace`;
          ctx.textAlign = 'center';
          const km = (m.dist / 1000).toFixed(1);
          // === Neutral label (per user request) ===
          const label = isNeutral ? `中立 ${km}KM` : `${km}KM`;
          // 已经显示名字时把距离标签下移一行, 避免叠在一起
          ctx.fillText(label, px, py + half + (playerNameShown ? 24 : 12) * scale);
          ctx.globalAlpha = 1;
        }
      } else {
        // === Off-screen arrows: only the SWITCHED TARGET gets one (per user
        // request), enlarged and pulled in toward screen centre, with the
        // target's vehicle model + distance label. ===
        if (!m.isTarget || m.type === 'missile') continue;
        const ax = cx + m.edgeX * edgeR;
        const ay = cy + m.edgeY * edgeR;
        const ang = Math.atan2(m.edgeY, m.edgeX);
        ctx.save();
        ctx.translate(ax, ay);
        ctx.rotate(ang);
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 10 * scale;
        ctx.beginPath();
        ctx.moveTo(24 * scale, 0);
        ctx.lineTo(-14 * scale, -17 * scale);
        ctx.lineTo(-7 * scale, 0);
        ctx.lineTo(-14 * scale, 17 * scale);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        // === 重要单位离屏也要打 X (同一个标记语义, 见上面屏内那段) ==========
        // 离屏箭头本来只画给**当前选中目标**; 护航编队若被选成目标又飞到背后,
        // 光一个箭头跟普通目标没区别 ⇒ 这里补同款绿 X。圈半径 26*scale 正好把
        // 箭头(长 24*scale)套住, X 画在圈内, 位置与屏内的标记一致地"包住本体"。
        if (m.important) {
          ctx.save();
          ctx.strokeStyle = '#54e08c';
          ctx.shadowColor = '#54e08c';
          ctx.shadowBlur = 6 * scale;
          ctx.lineWidth = 1 * scale;
          ctx.beginPath();
          ctx.arc(ax, ay, 26 * scale, 0, Math.PI * 2);
          ctx.stroke();
          ctx.lineWidth = 2 * scale;
          const xs = 15 * scale;
          ctx.beginPath();
          ctx.moveTo(ax - xs, ay - xs);
          ctx.lineTo(ax + xs, ay + xs);
          ctx.moveTo(ax + xs, ay - xs);
          ctx.lineTo(ax - xs, ay + xs);
          ctx.stroke();
          ctx.restore();
        }
        ctx.fillStyle = color;
        ctx.font = `bold ${11 * scale}px monospace`;
        ctx.textAlign = 'center';
        const labelX = cx + m.edgeX * (edgeR + 34 * scale);
        const labelY = cy + m.edgeY * (edgeR + 34 * scale);
        // Vehicle model on the first line, distance below it.
        const km = (m.dist / 1000).toFixed(1);
        ctx.fillText(m.modelName ?? m.name ?? '', labelX, labelY);
        ctx.globalAlpha = 0.8;
        ctx.font = `${10 * scale}px monospace`;
        ctx.fillText(`${km}KM`, labelX, labelY + 13 * scale);
        ctx.globalAlpha = 1;
      }
    }
  }, [markers, canvasRef, scale]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full pointer-events-auto cursor-pointer"
      style={{ mixBlendMode: 'screen' }}
      onClick={(e) => {
        // === Click-to-target (per user request) ===
        // Left-click on an enemy's radar box selects it as the current
        // target. Missiles/ally/neutral boxes are ignored.
        if (!onSelectUnit) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const W = rect.width;
        const H = rect.height;
        if (W <= 0 || H <= 0) return;
        const id = hitTestMarkers(
          markers,
          W,
          H,
          e.clientX - rect.left,
          e.clientY - rect.top,
          scale,
        );
        if (id !== null) onSelectUnit(id);
      }}
    />
  );
}
