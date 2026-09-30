'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { MISSIONS } from '@/lib/game/missions';
import { PLAYER_AIRCRAFT, aircraftNameZh, getPlayerSpec } from '@/lib/game/aircraft-catalog';
import type { AircraftModel, AircraftCategory, AircraftSpec, WeaponType } from '@/lib/game/types';
import { SP_WEAPONS, readSPWeaponSelection, writeSPWeaponSelection, MAIN_WEAPONS, ALL_LOADABLE_WEAPONS, LOADOUT_SLOTS, readLoadout, writeLoadout, defaultLoadoutForCategory, getWeaponDisplay } from '@/lib/game/sp-weapons';
import { useT } from '@/hooks/use-i18n';
import { getLocale } from '@/lib/game/i18n';
import { LangToggle } from './LangToggle';
import { BriefingStage, type BriefingStageHandle } from './BriefingStage';
import { deriveBriefingIntel } from '@/lib/game/briefing-intel';
import { VJ_KEY, isVirtualJoystickEnabled } from './VirtualJoystick';
// === 设备形态判定(默认电脑端; 手机档/触屏操作的默认值单一真相源) ===
import { MOBILE_MODE_KEY, resolveAutoOnSetting } from '@/lib/game/device-mode';
import { GUNSHIP_GUNS, type GunshipGunId } from '@/lib/game/engine';
import { playKey, playConfirm, playBack, playPowerDown, playPowerUp, uiSoundEnabled, setUiSoundEnabled } from '@/lib/game/ui-sound';
import { getVibe } from '@/lib/game/net/vibe';
import { zhValue, SKY_ZH, WEATHER_ZH, MAP_ZH, CATEGORY_ZH } from '@/lib/game/labels-zh';

// === Persistence helpers (mirror Hangar.tsx keys) ===
const PLAYER_MODEL_KEY = 'skybound.playerModel';
const PLAYER_PAINT_KEY = 'skybound.playerPaint';
// Wingman model selection (per-mission override; default = mission default).
const WINGMAN_MODEL_KEY = 'skybound.wingmanModel';

function readSelection(): { model: AircraftModel; paint: string } {
  if (typeof window === 'undefined') return { model: 'f16', paint: 'standard' };
  const model = (window.localStorage.getItem(PLAYER_MODEL_KEY) as AircraftModel | null) ?? 'f16';
  const paint = window.localStorage.getItem(PLAYER_PAINT_KEY) ?? 'standard';
  return { model, paint };
}

function writeSelection(model: AircraftModel, paint: string) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(PLAYER_MODEL_KEY, model);
  window.localStorage.setItem(PLAYER_PAINT_KEY, paint);
}

// Wingman model override — 'auto' means use the mission's default wingman
// model. Otherwise, override the wingmen to use the selected fighter model.
function readWingmanSelection(): AircraftModel | 'auto' {
  if (typeof window === 'undefined') return 'auto';
  const v = window.localStorage.getItem(WINGMAN_MODEL_KEY);
  if (v === 'auto' || v === null) return 'auto';
  // Accept any fighter-model name (f16, f15, su35, a10, ea18g, f117)
  return v as AircraftModel;
}

function writeWingmanSelection(m: AircraftModel | 'auto') {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(WINGMAN_MODEL_KEY, m);
}

// === 琥珀单色设计系统(per user request) ===
// 机型类别不再用色相区分 —— 单色终端里色相只承担"语义"(红=警告/绿=就绪),
// 类别区分交给文字标签(见 CATEGORY_LABEL)与图标, 色相只用琥珀阶梯做层次。
const CATEGORY_COLORS: Record<AircraftCategory, string> = {
  fighter: 'var(--crt-amber)',
  attack: 'var(--crt-amber)',
  bomber: 'var(--crt-amber)',
  ew: 'var(--crt-amber)',
  gunship: 'var(--crt-amber)',
  stealth: 'var(--crt-amber)',
  awacs: 'var(--crt-amber)',
};

// Compact category labels for the briefing inline picker.
const CATEGORY_LABEL: Record<AircraftCategory, string> = {
  fighter: 'FTR',
  attack: 'ATK',
  bomber: 'BMR',
  ew: 'EW',
  gunship: 'GUN',
  stealth: 'STL',
  awacs: 'AWACS',
};

// ============================================================================
// 主界面 —— 90 年代军用战斗电脑终端 / 琥珀单色 CRT / 磁带电子朋克
// ============================================================================
// 阶段2(per user request): 由"居中横置磁带机机箱"重构为【四区战术终端】:
//   ① StatusBar  顶部状态栏(分类密级/机型/走带计数/PWR-NR-REC/时钟/信号)
//   ② ModeList   左侧模式列表(战役/机库/设置/快速调节/退出, 键盘 ↑↓ + Enter)
//   ③ TacticalMap 中央雷达战术地图(MISSIONS 航点 + 网格 + 旋转扫描 + 光标)
//   ④ DetailPanel 右侧详情(当前选中模式的航电/航图读段 + 快速调节开关)
//   ⑤ TapeDeck   底部磁带控制(卡带标签/SIDE/卷轴/VU表/计数器/运输键)
//   ⑥ FooterHints 底部提示行(按键说明/丝印/条码)
// 交互与文案(i18n 键、localStorage 键、onPlay/onHangar/onSettings)与原实现一致。
// ============================================================================

/** 终端机箱外发光(呼吸) */
const CRT_PWR_GLOW = '0 0 60px rgba(255,176,0,0.055), 0 0 200px rgba(255,176,0,0.02)';

/** 模式列表标识 */
type ModeKey = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** 软开机自检 —— 每次会话只在首次进入主界面播放(点任意处跳过) */
let bootedThisSession = false;

function pad2(n: number): string { return String(Math.floor(n)).padStart(2, '0'); }

/** 飞行时钟读数 HH:MM:SS(客户端挂载后才渲染, 避免水合不一致) */
function clockText(d: Date | null): string {
  if (!d) return '--:--:--';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 日期戳 1990-01-01 风格(军表格式) */
function dateText(d: Date | null): string {
  if (!d) return '---- -- --';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 走带计数读数(装饰: 模拟磁带机在转) */
function counterText(t: number): string {
  return `${pad2(t / 60)}:${pad2(t % 60)}`;
}

function replaceText(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (_m, k: string) => (k in vars ? String(vars[k]) : `{${k}}`));
}

/** 保留 i18n 插值行为的极简取值器(不改动任何 i18n 键) */
function label(t: ReturnType<typeof useT>, key: string, vars?: Record<string, string | number>): string {
  return replaceText(t(key), vars);
}

/** 状态栏单元格 */
function StatusCell({
  label: cellLabel, value, tone = 'data', glow = false,
}: { label: string; value: string; tone?: 'data' | 'dim' | 'warn' | 'ready'; glow?: boolean }) {
  const toneClass =
    tone === 'dim' ? 'crt-text--dim'
      : tone === 'warn' ? 'crt-warn'
        : tone === 'ready' ? 'crt-ready'
          : 'crt-text';
  return (
    <div className="flex min-w-0 flex-col gap-0.5 border-l px-2.5 first:border-l-0 sm:px-3" style={{ borderColor: 'var(--crt-line)' }}>
      <span className="crt-label whitespace-nowrap">{cellLabel}</span>
      <span className={`crt-data truncate ${toneClass} ${glow ? 'crt-text--glow' : ''}`}>{value}</span>
    </div>
  );
}

/**
 * VibeHub 账号状态条 (P1-1)。
 *
 * 规范要求: 游戏必须自己提供**登录按钮 / 退出按钮 / 当前账号状态**, 并用
 * onAuthChange 同步 —— SDK 不注入任何样式或固定 UI, 所以这里按本作的琥珀 CRT
 * 语汇自制一条紧凑状态带。
 *
 * 容错: SDK 未加载(本地双击 / 无网 / 平台未授权)时显示「离线」而非报错 ——
 * 单机玩法必须完全不受影响。
 */
function AccountChip() {
  const vibe = getVibe();
  const [user, setUser] = useState<{ name: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let alive = true;
    vibe.init().then((c) => {
      if (!alive) return;
      setReady(!!c);
      stop = vibe.onAuthChange((u) => { if (alive) setUser(u ? { name: u.name } : null); });
    });
    return () => { alive = false; stop?.(); };
  }, [vibe]);

  const zh = getLocale() === 'zh';
  const label = !ready ? (zh ? '离线' : 'OFFLINE')
    : user ? (user.name || (zh ? '已登录' : 'SIGNED IN'))
      : (zh ? '未登录' : 'SIGNED OUT');

  return (
    <div className="flex items-center justify-end gap-2 border-b border-[var(--crt-amber-ghost)] bg-[var(--crt-panel)]/60 px-2.5 py-1 font-mono text-[0.5625rem] tracking-widest">
      <span className="text-[var(--crt-amber-dim)]">VIBEHUB</span>
      <span className={user ? 'text-[var(--crt-green)]' : 'text-[var(--crt-amber)]'}>{label}</span>
      {ready && !user && (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await vibe.login();        // 必须由用户手势触发, 否则浏览器拦截授权弹窗
            setBusy(false);
          }}
          className="border border-[var(--crt-amber-dim)] px-1.5 py-0.5 text-[var(--crt-amber-hi)] hover:bg-[var(--crt-panel-2)] disabled:opacity-50"
        >
          {busy ? (zh ? '授权中…' : 'AUTHORIZING…') : (zh ? '登录' : 'SIGN IN')}
        </button>
      )}
      {ready && user && (
        <button
          type="button"
          onClick={() => vibe.logout()}
          className="border border-[var(--crt-amber-ghost)] px-1.5 py-0.5 text-[var(--crt-amber-dim)] hover:bg-[var(--crt-panel-2)]"
        >
          {zh ? '退出' : 'SIGN OUT'}
        </button>
      )}
    </div>
  );
}

/** 顶部状态栏 */
function StatusBar({
  model, counter, clock, date, shutting = false,
}: { model: string; counter: number; clock: Date | null; date: string; shutting?: boolean }) {
  return (
    <div
      className="relative flex shrink-0 select-none flex-wrap items-stretch border-b"
      style={{ borderColor: 'var(--crt-line-strong)', background: 'linear-gradient(180deg, rgba(31,22,8,0.9) 0%, rgba(10,6,1,0.9) 100%)' }}
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="crt-data crt-text--glow-strong crt-text--hi tracking-[0.3em]">ACE/SKY</span>
        <span className="crt-label hidden sm:inline">· TAC-OS v3.11</span>
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-stretch justify-end">
        <StatusCell label="CLASS" value="■ TOP SECRET" tone="warn" />
        <StatusCell label="AIRFRAME" value={model.toUpperCase()} />
        <StatusCell label="TAPE" value={`T1-A ${counterText(counter)}`} />
        <StatusCell label="DATE" value={date} tone="dim" />
        <StatusCell label="TIME" value={clockText(clock)} glow />
        <div className="flex items-center gap-2 border-l px-3" style={{ borderColor: 'var(--crt-line)' }}>
          <span className="crt-label">SIG</span>
          <span className="flex items-end gap-[2px]">
            <span className="h-2 w-[3px]" style={{ background: 'var(--crt-amber)' }} />
            <span className="h-3 w-[3px]" style={{ background: 'var(--crt-amber)' }} />
            <span className="h-4 w-[3px]" style={{ background: 'var(--crt-amber)' }} />
            <span className="h-2.5 w-[3px]" style={{ background: 'var(--crt-amber-deep)' }} />
          </span>
        </div>
        <div className="flex items-center gap-3 border-l px-3" style={{ borderColor: 'var(--crt-line)' }}>
          <span className="flex items-center gap-1.5">
            <span className={`tp-led h-2 w-2 ${shutting ? '' : 'animate-tp-breathe'}`} style={{ color: shutting ? 'var(--crt-red)' : 'var(--crt-green)' }} />
            <span className="crt-label">{shutting ? 'PWR ↓' : 'PWR'}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="tp-led h-2 w-2" style={{ color: 'var(--crt-amber)' }} />
            <span className="crt-label">NR</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="tp-led animate-tp-rec h-2 w-2" style={{ color: 'var(--crt-red)' }} />
            <span className="crt-label">REC</span>
          </span>
        </div>
      </div>
    </div>
  );
}

/** 面板标题条 */
function PanelBar({ title, meta, tone = 'normal' }: { title: string; meta?: string; tone?: 'normal' | 'warn' }) {
  return (
    <div className="crt-panel-head flex shrink-0 items-center justify-between gap-2 px-2.5 py-1.5">
      <span className={`crt-label ${tone === 'warn' ? 'crt-warn' : 'crt-text--hi'} tracking-[0.26em]`}>{title}</span>
      {meta ? <span className="crt-label truncate">{meta}</span> : null}
    </div>
  );
}

/** 块状读数(标签 + 大号数值) */
function Readout({ k, v, tone = 'data' }: { k: string; v: string; tone?: 'data' | 'dim' | 'warn' | 'ready' | 'hi' }) {
  const toneClass =
    tone === 'dim' ? 'crt-text--dim'
      : tone === 'warn' ? 'crt-warn'
        : tone === 'ready' ? 'crt-ready'
          : tone === 'hi' ? 'crt-text--hi crt-text--glow' : 'crt-text';
  return (
    <div className="flex flex-col gap-0.5">
      <span className="crt-label">{k}</span>
      <span className={`crt-data leading-snug ${toneClass}`}>{v}</span>
    </div>
  );
}

/** 面板内的水平分隔(刻线 + 刻度) */
function Ruler() {
  return (
    <span
      className="mt-2 mb-1.5 block h-[6px] w-full"
      style={{
        backgroundImage:
          'repeating-linear-gradient(90deg, var(--crt-amber-deep) 0 1px, transparent 1px 9px), repeating-linear-gradient(90deg, var(--crt-amber) 0 1px, transparent 1px 45px)',
        opacity: 0.75,
      }}
    />
  );
}

const TACTICAL_NODES: { x: number; z: number }[] = MISSIONS.slice(0, 14).map((m) => ({ x: m.startPos[0], z: m.startPos[2] }));

// ============================================================================
// 参考图语汇的终端主体(per user request: 主界面要像"蓝色军用终端"那张参考图)
// ============================================================================
// 参考图的可辨识特征, 这里逐条照搬到琥珀 CRT:
//   ① 上半部**多列等宽文本块**(左边一段代码、中间一段、右边一段), 用 1px 竖线分栏;
//   ② 中部**状态行 + 点线填充**(`Verifying KDL Pool Data........ Update Success`);
//   ③ 下半部**数据表**(ID / ADDR / SZ / CL 那种四列表格);
//   ④ 底部**透视地板网格**(梯形线框, 往远处收);
//   ⑤ 全程只有描边与刻字, 没有圆角、没有填充面板。
// ============================================================================

/** 左列:终端自检代码块(真实文本, 等宽; 参考图第一栏那种密集代码) */
const DOSSIER_CODE: string[] = [
  '/* ACE/SKY TACTICAL SHELL — build readout */',
  'static void tac_boot(uint32_t flags) {',
  '  const struct rig *r = rig_resolve(PLAYER_RIG);',
  '  for (i = 0; i < SORTIE_MAX; ++i)',
  '    tac_load_sortie(mission_id(i));',
  '  csm_attach(r->sun, CASCADE_COUNT);',
  '  terrain_bind(r->height, r->color);',
  '  /* armed. do not leave the seat. */',
  '}',
];

/** 中列:火控与航电加载表(参考图中栏的 while/if 代码块位) */
const DOSSIER_CODE2: string[] = [
  'while (ground_crew() != 0) {',
  '  for (bay = 0; bay < BAYS; ++bay)',
  '    if (pylon_busy(bay))',
  '      arm_pylon(bay, loadout[bay]);',
  '  log_sigint(POOL_DATA, &pool);',
  '}',
  '/* crew chief sign-off required */',
];

/** 右列:结构/路由表(参考图第三栏 if/else 代码块位) */
const DOSSIER_CODE3: string[] = [
  'if (route_valid(flight)) {',
  '  left  = waypoint_first(flight);',
  '  right = waypoint_last(flight);',
  '} else if (route_degraded(flight)) {',
  '  /* fall back to heading hold */',
  '  left = right = home_plate();',
  '}',
];

function TerminalDossier({ model, paint, missionCount, first }: {
  model: string;
  paint: string;
  missionCount: number;
  first: { id: string; codename: string; title: string; map?: string } | undefined;
}) {
  const zh = getLocale() === 'zh';
  return (
    <div className="crt-panel relative order-first shrink-0 overflow-hidden">
      {/* 透视地板网格:垫在整个主体块底部(参考图底部那圈梯形线框) */}
      <div className="crt-floor" />
      <div className="relative">
        {/* ① 多列文本块:三栏等宽代码, 1px 竖线分栏 */}
        <div className="crt-cols" style={{ gridTemplateColumns: '1.25fr 1fr 1fr' }}>
          <div className="crt-col">
            <div className="crt-col__head">SYS · BOOT LOG</div>
            {DOSSIER_CODE.map((l, i) => (
              <div key={i} className={`crt-line ${i === 0 || i === 7 ? 'crt-line--hot' : ''}`}>{l}</div>
            ))}
          </div>
          <div className="crt-col">
            <div className="crt-col__head">ARM · POOL LOAD</div>
            {DOSSIER_CODE2.map((l, i) => (
              <div key={i} className={`crt-line ${l.startsWith('/*') ? 'crt-line--hot' : ''}`}>{l}</div>
            ))}
          </div>
          <div className="crt-col">
            <div className="crt-col__head">NAV · ROUTE</div>
            {DOSSIER_CODE3.map((l, i) => (
              <div key={i} className={`crt-line ${l.startsWith('/*') ? 'crt-line--hot' : ''}`}>{l}</div>
            ))}
          </div>
        </div>

        {/* ② 状态行 + 点线(参考图核心标识性元素) */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t px-3 py-1.5" style={{ borderColor: 'var(--crt-line)' }}>
          <span className="crt-statusrow">
            <span className="crt-statusrow__k">AIRFRAME</span>
            <span className="crt-dots" />
            <span className="crt-statusrow__v">{model.toUpperCase()} · {paint.toUpperCase()}</span>
          </span>
          <span className="crt-statusrow">
            <span className="crt-statusrow__k">SORTIE POOL</span>
            <span className="crt-dots" />
            <span className="crt-statusrow__v">{zh ? '就绪' : 'READY'} · {missionCount}</span>
          </span>
          <span className="crt-statusrow">
            <span className="crt-statusrow__k">{zh ? 'SIGINT 校验' : 'VERIFY SIGINT'}</span>
            <span className="crt-dots" />
            <span className="crt-statusrow__v crt-ready">{zh ? '通过' : 'VERIFIED'}</span>
          </span>
          <span className="crt-statusrow ml-auto">
            <span className="crt-statusrow__k">WARDEN</span>
            <span className="crt-dots" />
            <span className="crt-statusrow__v">{zh ? '在线' : 'ONLINE'}</span>
          </span>
        </div>

        {/* ③ 数据表:机体/挂载/末日代码(参考图 ID/ADDR/SZ/CL 表) */}
        <div className="border-t px-3 py-2" style={{ borderColor: 'var(--crt-line)' }}>
          <div className="crt-col__head" style={{ border: 0, marginBottom: '0.35rem', paddingBottom: 0 }}>
            {zh ? '机体与挂载寄存器' : 'AIRFRAME · STORES REGISTER'}
          </div>
          <table className="crt-table">
            <thead>
              <tr>
                <th>IDX</th><th>{zh ? '位置' : 'SLOT'}</th><th>{zh ? '装备' : 'STORE'}</th>
                <th>{zh ? '数量' : 'QTY'}</th><th>{zh ? '状态' : 'STATUS'}</th><th>BUS</th>
              </tr>
            </thead>
            <tbody>
              {[
                { i: '01', slot: zh ? '机炮' : 'GUN', store: 'M61A2 20MM', qty: '∞', st: zh ? '就绪' : 'RDY', bus: '0x3F01' },
                { i: '02', slot: zh ? '主翼' : 'WING', store: 'AIM-9X MSL', qty: '60', st: zh ? '就绪' : 'RDY', bus: '0x3F02' },
                { i: '03', slot: zh ? '重挂' : 'HEAVY', store: 'AGM-65 LASM', qty: '12', st: zh ? '就绪' : 'RDY', bus: '0x3F03' },
                { i: '04', slot: zh ? '弹舱' : 'BAY', store: 'MK-82 BDL', qty: '06', st: zh ? '待检' : 'CHK', bus: '0x3F04' },
                { i: '05', slot: zh ? '对抗' : 'CMDS', store: 'FLR DISPENSER', qty: '06', st: zh ? '就绪' : 'RDY', bus: '0x3F05' },
                { i: '06', slot: zh ? '导航' : 'NAV', store: first ? (first.map ?? 'OCEAN').toUpperCase() : '—', qty: '—', st: zh ? '在线' : 'LIVE', bus: '0x3F06' },
              ].map((r) => (
                <tr key={r.i}>
                  <td className="is-dim">{r.i}</td>
                  <td className="is-dim">{r.slot}</td>
                  <td className="is-hi">{r.store}</td>
                  <td>{r.qty}</td>
                  <td className={r.st === (zh ? '待检' : 'CHK') ? 'is-warn' : ''}>{r.st}</td>
                  <td className="is-dim">{r.bus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ④ 已知敌情/任务线(等宽密集文本, 参考图 System Processing 那段) */}
        <div className="border-t px-3 py-1.5" style={{ borderColor: 'var(--crt-line)' }}>
          <div className="crt-line crt-line--hot">{`// SORTIE MANIFEST — ${missionCount} entries loaded`}</div>
          {MISSIONS.slice(0, 4).map((m, i) => (
            <div key={m.id} className="crt-line">
              {`  ${String(i + 1).padStart(2, '0')}  ${m.id.toUpperCase().padEnd(6)} ${(m.map ?? 'ocean').toUpperCase().padEnd(12)} ${m.codename} · ${m.title}`}
            </div>
          ))}
          <div className="crt-line">{`  .. ${missionCount - 4 > 0 ? missionCount - 4 : 0} more entries — see SORTIE INDEX`}</div>
        </div>
      </div>
    </div>
  );
}

/** 块状光标(选中行前的实心块) */
function Caret() {
  return <span className="text-[9px] leading-none" style={{ color: 'var(--crt-amber)' }}>█</span>;
}

/** 中央雷达战术地图 —— 从 MISSIONS 航点投影, 展示战役航路 */
function TacticalMap({ selectedIndex, title, meta, nodes = TACTICAL_NODES }: {
  selectedIndex: number;
  title: string;
  meta: string;
  nodes?: { x: number; z: number }[];
}) {
  const xs = nodes.map((n) => n.x);
  const zs = nodes.map((n) => n.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const spanX = maxX - minX || 1;
  const spanZ = maxZ - minZ || 1;

  const project = (x: number, z: number): { px: number; py: number } => ({
    px: 10 + ((x - minX) / spanX) * 80,
    py: 90 - ((z - minZ) / spanZ) * 80,
  });

  const pts = nodes.map((n) => project(n.x, n.z));
  const last = pts[pts.length - 1] ?? { px: 50, py: 50 };
  const hx = last.px;
  const hy = last.py;
  const sel = pts[selectedIndex % pts.length] ?? { px: 50, py: 50 };
  const path = pts.map((p) => `${p.px.toFixed(2)},${p.py.toFixed(2)}`).join(' ');

  return (
    <div className="crt-panel crt-corner relative order-2 flex min-h-[240px] flex-1 flex-col lg:order-none lg:min-h-0">
      <PanelBar title={title} meta={meta} />
      <div className="relative min-h-0 flex-1 overflow-hidden" style={{ background: 'radial-gradient(115% 95% at 50% 50%, rgba(255,176,0,0.035) 0%, rgba(8,4,0,0.94) 58%, rgba(4,2,0,1) 100%)' }}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          {[20, 40, 60, 80].map((v) => (
            <line key={`v${v}`} x1={v} y1={0} x2={v} y2={100} stroke="var(--crt-amber-ghost)" strokeWidth={0.1} />
          ))}
          {[20, 40, 60, 80].map((v) => (
            <line key={`h${v}`} x1={0} y1={v} x2={100} y2={v} stroke="var(--crt-amber-ghost)" strokeWidth={0.1} />
          ))}
          {/* 固定合模线(不是扫描, 所以不旋转) */}
          <line x1={50} y1={0} x2={50} y2={100} stroke="var(--crt-amber-deep)" strokeWidth={0.1} opacity={0.5} />
          <line x1={0} y1={50} x2={100} y2={50} stroke="var(--crt-amber-deep)" strokeWidth={0.1} opacity={0.5} />
          <polyline points={path} fill="none" stroke="var(--crt-amber-dim)" strokeWidth={0.22} strokeDasharray="1.2 0.9" />
          {pts.map((p, i) => (
            <g key={`n${i}`}>
              <circle cx={p.px} cy={p.py} r={i === 0 ? 0.95 : 0.6} fill="var(--crt-amber)" />
            </g>
          ))}
          {sel ? (
            <rect
              x={sel.px - 2.6} y={sel.py - 2.6} width={5.2} height={5.2}
              fill="none" stroke="var(--crt-amber)" strokeWidth={0.34}
            />
          ) : null}
          <circle cx={hx} cy={hy} r={3.2} fill="none" stroke="var(--crt-amber)" strokeWidth={0.3} className="crt-node" />
          <line x1={hx - 5} y1={hy} x2={hx - 3.4} y2={hy} stroke="var(--crt-amber)" strokeWidth={0.3} />
          <line x1={hx + 3.4} y1={hy} x2={hx + 5} y2={hy} stroke="var(--crt-amber)" strokeWidth={0.3} />
          <line x1={hx} y1={hy - 5} x2={hx} y2={hy - 3.4} stroke="var(--crt-amber)" strokeWidth={0.3} />
          <line x1={hx} y1={hy + 3.4} x2={hx} y2={hy + 5} stroke="var(--crt-amber)" strokeWidth={0.3} />
        </svg>
        {/* 低速水平扫掠带: 地图本体的"屏幕在工作"提示(旋转扇形只留在角落表盘里) */}
        <div className="crt-scanband" />
        {/* 角部圆形雷达表: 扫描前沿在这里旋转 */}
        <div className="crt-radar absolute left-2.5 top-2.5 hidden h-[92px] w-[92px] sm:block">
          <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
            <circle cx={50} cy={50} r={46} fill="none" stroke="var(--crt-amber-deep)" strokeWidth={0.7} />
            <circle cx={50} cy={50} r={30} fill="none" stroke="var(--crt-amber-ghost)" strokeWidth={0.6} />
            <circle cx={50} cy={50} r={15} fill="none" stroke="var(--crt-amber-ghost)" strokeWidth={0.6} />
            <line x1={50} y1={4} x2={50} y2={96} stroke="var(--crt-amber-ghost)" strokeWidth={0.6} />
            <line x1={4} y1={50} x2={96} y2={50} stroke="var(--crt-amber-ghost)" strokeWidth={0.6} />
            <circle cx={66} cy={38} r={2.6} fill="var(--crt-amber)" />
            <circle cx={34} cy={64} r={2.2} fill="var(--crt-amber-dim)" />
            <circle cx={58} cy={70} r={1.8} fill="var(--crt-amber-dim)" />
            {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
              <line
                key={`t${a}`}
                x1={50 + 40 * Math.sin((a * Math.PI) / 180)}
                y1={50 - 40 * Math.cos((a * Math.PI) / 180)}
                x2={50 + 46 * Math.sin((a * Math.PI) / 180)}
                y2={50 - 46 * Math.cos((a * Math.PI) / 180)}
                stroke="var(--crt-amber-deep)"
                strokeWidth={1}
              />
            ))}
          </svg>
          <div className="crt-sweep" />
        </div>
        <div className="pointer-events-none absolute inset-0 crt-scanlines opacity-70" />
        <div className="crt-label crt-text--dim absolute bottom-1.5 left-2.5">GRID 100 · MAG</div>
        <div className="crt-label crt-text--dim absolute bottom-1.5 right-2.5">NODES {pts.length}</div>
        <div className="crt-label crt-text--dim absolute right-2.5 top-2.5 hidden sm:block">RDR 40 NM</div>
      </div>
    </div>
  );
}

/** 快速调节开关行 */
function SettingRow({ label: rowLabel, value, onToggle }: { label: string; value: boolean; onToggle: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!value)}
      aria-pressed={value}
      className="crt-key flex w-full items-center justify-between gap-2 px-2 py-1.5 focus-visible:outline focus-visible:outline-1"
      style={{ outlineColor: 'var(--crt-line-strong)' }}
    >
      <span className="crt-label truncate tracking-[0.16em]">{rowLabel}</span>
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="tp-led h-2 w-2" style={{ color: value ? 'var(--crt-green)' : 'var(--crt-amber-deep)' }} />
        <span className="crt-data w-7 text-right">{value ? 'ON' : 'OFF'}</span>
      </span>
    </button>
  );
}

/** 底部运输键(磁带机主操作) */
function TransportKey({
  glyph, label: keyLabel, sub, onPress, title,
}: { glyph: string; label: string; sub: string; onPress: () => void; title?: string }) {
  return (
    <button
      type="button"
      onClick={onPress}
      title={title ?? keyLabel}
      className="crt-key group flex items-center gap-2 px-2 py-1.5 text-left focus-visible:outline focus-visible:outline-1"
      style={{ outlineColor: 'var(--crt-line-strong)' }}
    >
      <span className="text-lg leading-none" style={{ color: 'var(--crt-amber)', textShadow: 'var(--crt-glow)' }}>{glyph}</span>
      <span className="flex min-w-0 flex-col">
        <span className="crt-label truncate tracking-[0.18em]">{keyLabel}</span>
        <span className="crt-label truncate opacity-60">{sub}</span>
      </span>
    </button>
  );
}

const BOOT_LINES: { t: string; tone?: 'dim' | 'ok' }[] = [
  { t: 'ACE/SKY TACTICAL OS 3.11 (C) 1986 BUNKER SYSTEMS' },
  { t: 'CPU  MC68030 · 25 MHZ ................ OK', tone: 'ok' },
  { t: 'MEM  4096 KB ......................... OK', tone: 'ok' },
  { t: 'TAPE DRIVE TD-1 SELF TEST ............ OK', tone: 'ok' },
  { t: 'AIRFRAME LIBRARY / WEAPONS LOADER .... OK', tone: 'ok' },
  { t: 'SIGINT UPLINK ........................ SECURE', tone: 'ok' },
  { t: 'WARNING: UNAUTHORIZED ACCESS IS A COURT MARTIAL OFFENCE', tone: 'dim' },
];

function BootLine({ text, tone }: { text: string; tone?: 'dim' | 'ok' }) {
  const cls = tone === 'ok' ? 'crt-ready' : tone === 'dim' ? 'crt-text--dim' : 'crt-text';
  return (
    <div className={`crt-data truncate ${cls}`}>
      &gt; {text}
    </div>
  );
}

/** 开机自检覆盖层(点击可跳过) */
function BootSequence({ lines, onDone }: { lines: { t: string; tone?: 'dim' | 'ok' }[]; onDone: () => void }) {
  const [shown, setShown] = useState(0);
  const [held, setHeld] = useState(false);

  // 阶段 5: CRT 开机音(高压建立 + 消磁"咚")。浏览器自动播放策略下, 只有用户在
  // 本次页面里已经有过手势才会真的发声; 没有就静默跳过(不影响自检动画)。
  useEffect(() => {
    try { playPowerUp(); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (held) return undefined;
    if (shown >= lines.length) {
      const end = window.setTimeout(onDone, 620);
      return () => window.clearTimeout(end);
    }
    const step = window.setTimeout(() => setShown((n) => n + 1), 130);
    return () => window.clearTimeout(step);
  }, [shown, held, lines.length, onDone]);

  return (
    <div
      className="absolute inset-0 z-50 flex cursor-pointer flex-col items-start justify-start overflow-hidden px-4 py-4 sm:px-8 sm:py-6"
      style={{ background: 'radial-gradient(120% 100% at 50% 50%, var(--crt-bg) 0%, var(--crt-bg-screen) 70%, #000 100%)' }}
      onClick={() => { setHeld(true); onDone(); }}
      role="presentation"
    >
      <div className="crt-scanlines pointer-events-none absolute inset-0" />
      {lines.slice(0, shown).map((l, i) => (
        <BootLine key={i} text={l.t} tone={l.tone} />
      ))}
      <span className="crt-caret" />
    </div>
  );
}

export function MainMenu({ onPlay, onStory, onHangar, onSettings, onMultiplayer }: { onPlay: () => void; onStory: () => void; onHangar: () => void; onSettings: () => void; onMultiplayer: () => void }) {
  const t = useT();
  // === Inline settings panel (per user request) ===
  // The user wants quick access to common settings without leaving the
  // main menu. We surface a compact panel with the most-used toggles:
  // music volume, bloom, SSR, static shadow, CSM. Full settings (key
  // rebinding, language) are still on the dedicated Settings page.
  const [showSettings, setShowSettings] = useState(false);
  const [bloom, setBloom] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem('skybound.bloom') !== 'off';
  });
  const [ssr, setSsr] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('skybound.ssr') === 'on';
  });
  const [staticShadow, setStaticShadow] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem('skybound.staticShadow') !== 'off';
  });
  const [csm, setCsm] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('skybound.csm') === 'on';
  });
  // === 预设默认值 (per user request) ===
  const [cloudMode, setCloudMode] = useState<'geometry' | 'sprite'>(() => {
    if (typeof window === 'undefined') return 'sprite';
    const v = window.localStorage.getItem('skybound.cloudMode');
    return v === 'geometry' ? 'geometry' : 'sprite';
  });
  // Virtual joystick (touch controls) — same key as the Settings page.
  const [vj, setVj] = useState<boolean>(isVirtualJoystickEnabled);
  // Mobile performance mode (60fps) — same key / same 默认电脑端 判定 as the Settings page.
  const [mobileMode, setMobileMode] = useState<boolean>(() => resolveAutoOnSetting(MOBILE_MODE_KEY));
  // === 侧炮机位开关 (per user request): true = skybound.sideViewCam 为 'free' ===
  const [sideCamFree, setSideCamFree] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try { return window.localStorage.getItem('skybound.sideViewCam') === 'free'; } catch { return false; }
  });
  const toggle = (key: string, on: boolean, setter: (v: boolean) => void) => {
    setter(on);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(key, on ? 'on' : 'off');
    }
  };

  // === 终端状态:选中模式 / 键盘导航 / 飞行时钟 ===
  // 关机时先播放 CRT 断电(塌缩+白闪+静电), 再回主菜单 —— 不做成"瞬间刷新"
  const shutdownRef = useRef(false);
  const shutdown = () => {
    if (shutdownRef.current) return;
    shutdownRef.current = true;
    try { playPowerDown(); } catch { /* ignore */ }
    setShutting(true);
    window.setTimeout(() => {
      if (typeof window !== 'undefined') window.location.reload();
    }, 640);
  };
  const MODES = useMemo(() => ([
    { key: 'camp', glyph: '▶', label: label(t, 'menu.campaign'), sub: 'CAMPAIGN', run: onPlay },
  // === 正式版剧情 (per user request: 在游戏菜单加上正式版剧情菜单, 单独搞关卡) ===
  // 与上面的普通出击分开: 这条进的是剧情专用界面(只列 campaign 关卡)。
  { key: 'story', glyph: '★', label: getLocale() === 'zh' ? '正式版剧情' : 'STORY CAMPAIGN', sub: 'OPERATION BASTION', run: onStory },
    // === 联机大厅入口 (P1-4) ===
    { key: 'mp', glyph: '⇄', label: getLocale() === 'zh' ? '联机对战' : 'MULTIPLAYER', sub: 'VIBEHUB / P2P', run: onMultiplayer },
    { key: 'hangar', glyph: '⏏', label: label(t, 'menu.hangar'), sub: 'AIRFRAME', run: onHangar },
    { key: 'settings', glyph: '⚙', label: label(t, 'menu.settings'), sub: 'SYSTEM', run: onSettings },
    { key: 'quick', glyph: '▤', label: getLocale() === 'zh' ? '快速调节' : 'QUICK SET', sub: 'UTILITY', run: () => setShowSettings((s) => !s) },
    // === 全屏切换 (per user request: 菜单给手动按钮, 取消进关自动全屏) ==========
    { key: 'full', glyph: '⛶', label: getLocale() === 'zh' ? '全屏' : 'FULLSCREEN', sub: 'DISPLAY', run: () => {
      try {
        if (document.fullscreenElement) void document.exitFullscreen?.();
        else void document.documentElement.requestFullscreen?.();
      } catch { /* 浏览器拒绝/不支持 */ }
    } },
    { key: 'exit', glyph: '⏹', label: getLocale() === 'zh' ? '退出终端' : 'POWER OFF', sub: 'HALT', run: shutdown },
  ] as const), [t, onPlay, onHangar, onSettings]);
  const [modeKey, setModeKey] = useState<ModeKey>(0);
  const [shutting, setShutting] = useState(false);
  const [booted, setBooted] = useState<boolean>(bootedThisSession);
  // UI 音效开关(默认开; 只在用户手势里首次创建 AudioContext)
  const [soundOn, setSoundOn] = useState<boolean>(() => uiSoundEnabled());
  useEffect(() => {
    if (booted) bootedThisSession = true;
  }, [booted]);
  const mod = MODES[modeKey];
  const modeId = mod.key;
  const modeTitle = mod.label;

  // 飞行时钟(客户端挂载后填充, 每 30s 刷新)
  const [clock, setClock] = useState<Date | null>(null);
  useEffect(() => {
    setClock(new Date());
    const id = window.setInterval(() => setClock(new Date()), 30000);
    return () => window.clearInterval(id);
  }, []);

  // 数码走带计数器(主界面装饰:模拟磁带机在转)
  const [counter, setCounter] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setCounter((c) => (c + 1) % 6000), 1000);
    return () => window.clearInterval(id);
  }, []);

  // 当前机型(详情面板 AIRFRAME 读数)
  const airframe = useMemo(() => readSelection(), []);

  // 键盘导航: ↑↓/Home/End 移动, Enter/Space 执行, Esc 关抽屉
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (shutting) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      playKey();
      setModeKey((m) => (((m + step + MODES.length) % MODES.length) as ModeKey));
      return;
    }
    if (e.key === 'Home') { e.preventDefault(); playKey(); setModeKey(0); return; }
    if (e.key === 'End') { e.preventDefault(); playKey(); setModeKey((MODES.length - 1) as ModeKey); return; }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (showSettings) { playBack(); setShowSettings(false); return; }
      playConfirm();
      MODES[modeKey].run();
      return;
    }
    if (e.key === 'Escape' && showSettings) { e.preventDefault(); playBack(); setShowSettings(false); }
  };

  const first = MISSIONS[0];
  const repo = first
    ? `${first.codename} · ${first.title}`
    : (getLocale() === 'zh' ? '暂无作战任务' : 'NO SORTIES ON FILE');
  const readyCount = MISSIONS.length;

  const detTitle = modeId === 'camp'
    ? (getLocale() === 'zh' ? '最新作战任务' : 'LATEST SORTIE')
    : modeId === 'hangar'
      ? (getLocale() === 'zh' ? '当前机体' : 'ACTIVE AIRFRAME')
      : modeId === 'settings'
        ? (getLocale() === 'zh' ? '系统配置' : 'SYSTEM CONFIG')
        : modeId === 'quick'
          ? (getLocale() === 'zh' ? '快速调节' : 'QUICK SET')
          : (getLocale() === 'zh' ? '终端状态' : 'TERMINAL STATE');

  return (
    <div className={`crt-frame crt-flicker relative h-full w-full select-none ${shutting ? 'crt-poweroff' : 'overflow-hidden'}`} style={{ background: 'var(--crt-bg)' }} tabIndex={0} onKeyDown={onKeyDown}>
      {/* 面板底纹 + 显像管余晖 */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'linear-gradient(180deg, rgba(255,176,0,0.05) 0%, rgba(0,0,0,0) 18%, rgba(0,0,0,0) 82%, rgba(255,176,0,0.03) 100%), radial-gradient(120% 80% at 50% 50%, rgba(255,176,0,0.035) 0%, rgba(0,0,0,0) 60%)',
          boxShadow: CRT_PWR_GLOW,
        }}
      />

      <div className="relative z-10 flex h-full w-full flex-col">
        <StatusBar model={airframe.model} counter={counter} clock={clock} date={dateText(clock)} shutting={shutting} />
        {/* === VibeHub 账号状态 (P1-1, 规范要求: 登录/退出/当前账号三者都要有) === */}
        <AccountChip />

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5 lg:overflow-y-auto">
          {/* ⓪ 参考图语汇的终端主体(多列代码块 + 点线状态行 + 数据表 + 透视地板) */}
          <TerminalDossier
            model={airframe.model}
            paint={airframe.paint}
            missionCount={MISSIONS.length}
            first={first ? { id: first.id, codename: first.codename, title: first.title, map: first.map } : undefined}
          />

          <div className="grid min-h-0 grid-cols-1 gap-2 lg:grid-cols-[minmax(0,258px)_minmax(0,1fr)_minmax(0,360px)]">
          {/* ② 模式列表 */}
          <div className="crt-panel crt-corner order-1 flex min-h-0 w-full flex-col">
            <PanelBar title={getLocale() === 'zh' ? '模式' : 'MODE'} meta="↑↓ / ENTER" />
            <div className="flex min-h-0 flex-1 flex-col p-1.5" role="listbox" aria-label={getLocale() === 'zh' ? '主菜单模式' : 'Main menu modes'}>
              {MODES.map((m, i) => {
                const sel = i === modeKey;
                return (
                  <button
                    key={m.key}
                    type="button"
                    role="option"
                    aria-selected={sel}
                    onMouseEnter={() => { setModeKey(i as ModeKey); playKey(); }}
                    onFocus={() => setModeKey(i as ModeKey)}
                    onClick={() => {
                      // 单击 = 确认执行(与键盘 Enter 一致)。
                      // 之前的"已选中才执行"模型要求点击两次(第一次只选中),
                      // 且用 modeId 判断会读到本次渲染的旧值 —— 直接简化为一次点击。
                      playConfirm();
                      setModeKey(i as ModeKey);
                      m.run();
                    }}
                    className={`relative flex items-center gap-2 px-2 py-[5px] text-left transition-colors ${sel ? 'crt-invert' : ''}`}
                  >
                    <span className={`w-4 shrink-0 text-center text-[11px] ${sel ? '' : 'crt-text--dim'}`}>{m.glyph}</span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={`crt-data truncate text-[13px] tracking-[0.12em] ${sel ? 'font-bold' : 'crt-text--dim'}`}>{m.label}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {/* 本地记录:航路/机体/磁带 */}
            <div className="shrink-0 border-t p-2" style={{ borderColor: 'var(--crt-line)' }}>
              <div className="crt-label mb-1">LOCAL RECORD</div>
              <div className="crt-data crt-text--dim truncate text-[10px]">ROUTE · {repo}</div>
              <div className="crt-data crt-text--dim truncate text-[10px]">AIRFRAME · {airframe.model.toUpperCase()} / {airframe.paint.toUpperCase()}</div>
              <div className="crt-data crt-text--dim truncate text-[10px]">SORTIES READY · {readyCount}</div>
            </div>
          </div>

          {/* ③ 中央雷达战术地图 */}
          <TacticalMap
            selectedIndex={modeKey}
            title={getLocale() === 'zh' ? '战役航图' : 'TACTICAL MAP'}
            meta={`TAC-1 · ${getLocale() === 'zh' ? '战术' : 'TACTICAL'}`}
          />

          {/* ④ 右侧详情 */}
          <div className="crt-panel crt-corner order-3 flex min-h-0 w-full flex-col lg:order-none">
            <PanelBar title={getLocale() === 'zh' ? '详情' : 'DETAIL'} meta={detTitle} />
            <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
              {modeId === 'camp' ? (
                <>
                  <div className="crt-label mb-1">MISSION 01 · PRIORITY</div>
                  <div className="crt-data crt-text--hi crt-text--glow mb-1 text-[13px] leading-snug">{repo}</div>
                  <div className="crt-data crt-text--hi mb-2 text-[11px] leading-relaxed">
                    {first ? `${(first.brief ?? '').slice(0, 120)}` : ''}
                  </div>
                  <Ruler />
                  <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                    <Readout k="SKY" v={first ? zhValue(SKY_ZH, first.sky.toUpperCase()) : '--'} />
                    <Readout k="WX" v={first ? zhValue(WEATHER_ZH, (first.weather ?? 'clear').toUpperCase()) : '--'} />
                    <Readout k="TERRAIN" v={first ? zhValue(MAP_ZH, (first.map ?? 'ocean').toUpperCase()) : '--'} />
                    <Readout k="TGT ALT" v={first ? `${first.startAltitude} M` : '--'} />
                    <Readout k="LIMIT" v={first && first.timeLimit ? `${Math.round(first.timeLimit / 60)} MIN` : '--'} />
                    <Readout k="ORDNANCE" v={first ? `${first.objectives.length} OBJ` : '--'} tone="hi" />
                  </div>
                  <Ruler />
                  <div className="crt-label mb-1">STATUS</div>
                  <div className="crt-data crt-ready">◆ READY FOR TAKEOFF</div>
                  <div className="crt-data crt-warn mt-1">▲ LIVE ORDNANCE · CHECK MASTER ARM</div>
                </>
              ) : modeId === 'hangar' ? (
                <>
                  <div className="crt-label mb-1">ASSIGNED AIRFRAME</div>
                  <div className="crt-data crt-text--hi crt-text--glow text-[15px]">{airframe.model.toUpperCase()}</div>
                  <div className="crt-data crt-text--dim text-[11px]">PAINT · {airframe.paint.toUpperCase()}</div>
                  <Ruler />
                  <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                    <Readout k="CAT" v={CATEGORY_LABEL[getPlayerSpec(airframe.model).category] ?? '---'} />
                    <Readout k="SLOTS" v={`${LOADOUT_SLOTS}`} />
                    <Readout k="WINGMAN" v={readWingmanSelection().toUpperCase()} />
                    <Readout k="MODELS" v={`${PLAYER_AIRCRAFT.length}`} />
                  </div>
                  <Ruler />
                  <div className="crt-label mb-1">BAY</div>
                  <div className="crt-data crt-text--dim">◆ AIRFRAME BAY ACCESSIBLE</div>
                  <div className="crt-data crt-text--dim mt-1">◆ PAINT / ORDNANCE CONFIG EDITABLE</div>
                </>
              ) : modeId === 'settings' || modeId === 'quick' ? (
                <>
                  <div className="crt-label mb-1.5">
                    {getLocale() === 'zh' ? '常用画质开关(进入关卡时生效)' : 'QUICK TOGGLES (APPLIES ON MISSION START)'}
                  </div>
                  <div className="grid grid-cols-1 gap-1.5">
                    <SettingRow label={getLocale() === 'zh' ? '泛光 BLOOM' : 'BLOOM'} value={bloom} onToggle={(v) => toggle('skybound.bloom', v, setBloom)} />
                    <SettingRow label="SCREEN SSR" value={ssr} onToggle={(v) => toggle('skybound.ssr', v, setSsr)} />
                    <SettingRow label={getLocale() === 'zh' ? '静态阴影' : 'STATIC SHADOW'} value={staticShadow} onToggle={(v) => toggle('skybound.staticShadow', v, setStaticShadow)} />
                    <SettingRow label="CSM" value={csm} onToggle={(v) => toggle('skybound.csm', v, setCsm)} />
                    <SettingRow label={getLocale() === 'zh' ? '虚拟摇杆' : 'VIRTUAL STICK'} value={vj} onToggle={(v) => toggle(VJ_KEY, v, setVj)} />
                    <SettingRow label={getLocale() === 'zh' ? '手机60帧' : 'MOBILE 60FPS'} value={mobileMode} onToggle={(v) => toggle('skybound.mobileMode', v, setMobileMode)} />
                    {/* === 侧炮机位二选一 (per user request: 自由视角 / 固定机位) ===
                        值写在 skybound.sideViewCam: 'free' = 自由机位(保留鼠标操控机位),
                        'fixed' = 固定机位(键盘模式进侧炮的那个位置)。仅鼠标操控模式生效。 */}
                    <SettingRow label={getLocale() === 'zh' ? '侧炮自由机位' : 'SIDE GUN FREE CAM'} value={sideCamFree} onToggle={(v) => { setSideCamFree(v); try { window.localStorage.setItem('skybound.sideViewCam', v ? 'free' : 'fixed'); } catch { /* ignore */ } }} />
                    <SettingRow
                      label={getLocale() === 'zh' ? '云朵:几何体' : 'CLOUDS: GEOMETRY'}
                      value={cloudMode === 'geometry'}
                      onToggle={(v) => {
                        const m = v ? 'geometry' : 'sprite';
                        setCloudMode(m);
                        if (typeof window !== 'undefined') window.localStorage.setItem('skybound.cloudMode', m);
                      }}
                    />
                  </div>
                  <Ruler />
                  {modeId === 'settings' ? (
                    <button
                      type="button"
                      onClick={onSettings}
                      className="crt-key w-full px-2 py-2 text-[10px] focus-visible:outline focus-visible:outline-1"
                      style={{ outlineColor: 'var(--crt-line-strong)' }}
                    >
                      → {getLocale() === 'zh' ? '完整设置 / 按键绑定' : 'FULL SETTINGS / KEYBINDS'}
                    </button>
                  ) : (
                    <div className="crt-data crt-text--dim">↑↓ {getLocale() === 'zh' ? '左侧选择「设置」进入完整界面' : 'SELECT "SETTINGS" ON THE LEFT'}</div>
                  )}
                </>
              ) : (
                <>
                  <div className="crt-label mb-1">TERMINAL</div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                    <Readout k="OS" v="TAC-OS 3.11" />
                    <Readout k="BUILD" v="terrain-v2" />
                    <Readout k="TAPE" v={`T1-A ${counterText(counter)}`} />
                    <Readout k="NODES" v={`${TACTICAL_NODES.length}`} />
                  </div>
                  <Ruler />
                  <div className="crt-data crt-text--dim leading-relaxed">
                    {getLocale() === 'zh'
                      ? '终端已就绪。使用 ↑↓ 选择模式, ENTER 执行, ESC 返回。磁带记录自动保存至本地存储。'
                      : 'TERMINAL READY. USE ↑↓ TO SELECT, ENTER TO EXECUTE, ESC TO CANCEL. TAPE LOGS PERSIST TO LOCAL STORAGE.'}
                  </div>
                </>
              )}
            </div>
            <div className="crt-label crt-text--dim shrink-0 border-t px-2.5 py-1.5" style={{ borderColor: 'var(--crt-line)' }}>
              {label(t, 'menu.footerVersion', { n: MISSIONS.length })} · BUILD terrain-v2-debug
            </div>
          </div>
        </div>
          </div>

        {/* ⑤ 底部磁带控制 */}
        <div className="relative shrink-0 border-t px-2.5 pb-2 pt-2" style={{ borderColor: 'var(--crt-line-strong)', background: 'linear-gradient(180deg, rgba(10,6,1,0.9) 0%, rgba(24,16,5,0.95) 100%)' }}>
          <div className="mb-1.5 flex flex-wrap items-end justify-between gap-2">
            <div className="tp-label -rotate-[0.6deg] px-2 py-0.5">
              <span className="crt-data text-[9px] font-bold" style={{ color: 'var(--crt-ink)' }}>
                SIDE A · GHOST SQUADRON · TYPE III HIGH BIAS · 90 MIN
              </span>
            </div>
            <span className="crt-label">◀◀ REW · PLAY · FF ▶▶ · TAPE 1 / SIDE A</span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex shrink-0 items-center gap-1.5">
              <div className="tp-reel h-11 w-11" />
              <div className="tp-reel tp-reel--slow h-11 w-11" />
            </div>
            <div className="min-w-[128px] flex-1">
              <div className="flex items-center gap-1.5">
                <span className="crt-label w-2">L</span>
                <div className="tp-vu h-2.5 flex-1 overflow-hidden">
                  <div className="tp-vu-fill h-full" />
                </div>
                <span className="crt-label w-2">R</span>
                <div className="tp-vu h-2.5 flex-1 overflow-hidden">
                  <div className="tp-vu-fill tp-vu-fill--r h-full" />
                </div>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="crt-label">VU · METER</span>
                <span className="crt-label">-20 -10 -5 0 +3</span>
              </div>
            </div>
            <div className="tp-vfd shrink-0 px-2.5 py-1 text-center">
              <div className="crt-label opacity-90">TAPE 1 · SIDE A</div>
              <div className="crt-data crt-text--glow-strong text-[15px] font-bold">{counterText(counter)}</div>
            </div>
            <div className="grid min-w-[260px] flex-1 grid-cols-2 gap-1.5 sm:grid-cols-4">
              <TransportKey glyph="▶" label={label(t, 'menu.campaign')} sub="PLAY" onPress={onPlay} />
              <TransportKey glyph="⏏" label={label(t, 'menu.hangar')} sub="EJECT" onPress={onHangar} />
              <TransportKey glyph="⚙" label={label(t, 'menu.settings')} sub="CONFIG" onPress={onSettings} />
              <TransportKey
                glyph={showSettings ? '▴' : '▾'}
                label={getLocale() === 'zh' ? '快速调节' : 'QUICK SET'}
                sub="UTILITY"
                onPress={() => setShowSettings((s) => !s)}
              />
            </div>
          </div>
        </div>

        {/* ⑥ 底部提示 + 丝印 */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-1.5" style={{ borderColor: 'var(--crt-line)' }}>
          <span className="crt-label">↑↓ NAV</span>
          <span className="crt-label">ENTER EXEC</span>
          <span className="crt-label">ESC BACK</span>
          <span className="crt-label">TAB PANEL</span>
          <span className="crt-warn crt-label">⚠ CAUTION · DO NOT ERASE</span>
          <span className="tp-hazard h-2.5 w-16" />
          <span className="crt-label ml-auto hidden truncate sm:inline">{label(t, 'menu.footerModels')}</span>
          <span className="crt-label whitespace-nowrap">SN 007-1986-A · MADE IN THE BUNKER</span>
          <span className="tp-barcode hidden h-5 w-24 sm:block" />
        </div>
      </div>

      {/* 语言切换 + UI 音效开关(右上角, 浮在最上层) */}
      <div className="absolute right-3 top-12 z-30 flex flex-col items-end gap-2">
        <LangToggle />
        <button
          type="button"
          onClick={() => {
            const next = !soundOn;
            setUiSoundEnabled(next);
            setSoundOn(next);
            if (next) playKey();
          }}
          aria-pressed={soundOn}
          title={soundOn
            ? (getLocale() === 'zh' ? '终端音效: 开' : 'Terminal sound: ON')
            : (getLocale() === 'zh' ? '终端音效: 关' : 'Terminal sound: OFF')}
          className="crt-key flex items-center gap-1.5 px-2 py-1"
        >
          <span className="tp-led h-2 w-2" style={{ color: soundOn ? 'var(--crt-green)' : 'var(--crt-amber-deep)' }} />
          <span className="crt-label">{soundOn ? 'SND ON' : 'SND OFF'}</span>
        </button>
      </div>

      {/* ===== CRT 效果叠加层(纯装饰, 不接收指针事件) ===== */}
      <div className="crt-scanlines pointer-events-none absolute inset-0 z-40 opacity-80" />
      <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden">
        <div className="tp-tracking h-[16%] w-full" />
      </div>
      <div className="tp-grain pointer-events-none absolute inset-0 z-40 mix-blend-overlay" style={{ opacity: 'var(--crt-grain-alpha)' }} />
      <div className="crt-vignette pointer-events-none absolute inset-0 z-40" />

      {!booted && <BootSequence lines={BOOT_LINES} onDone={() => setBooted(true)} />}
      {shutting && <div className="crt-powerflash" />}
    </div>
  );
}


/**
 * 正式版剧情菜单 (per user request: 在游戏菜单加上正式版剧情菜单, 单独搞关卡)。
 *
 * 与 MissionSelect(普通出击列表)分开: 这里只列 `campaign` 有值的关卡, 按关卡号排序,
 * 每一行是那关的剧情简介 + 目标 + 奖励; 点行进入原有 Briefing 流程(机型/僚机/挂载照旧)。
 * 视觉沿用终端语汇, 不引入新配色。
 */
export function StorySelect({ onSelect, onBack }: { onSelect: (id: string) => void; onBack: () => void }) {
  const t = useT();
  const story = useMemo(
    () => MISSIONS.filter((m) => typeof m.campaign === 'number').sort((a, b) => (a.campaign ?? 0) - (b.campaign ?? 0)),
    [],
  );
  return (
    <div className="crt-frame crt-flicker relative h-full w-full select-none overflow-hidden crt-font" style={{ background: 'var(--crt-bg)' }}>
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'linear-gradient(180deg, rgba(255,176,0,0.05) 0%, rgba(0,0,0,0) 16%, rgba(0,0,0,0) 84%, rgba(255,176,0,0.03) 100%), radial-gradient(120% 80% at 50% 50%, rgba(255,176,0,0.035) 0%, rgba(0,0,0,0) 60%)',
          boxShadow: CRT_PWR_GLOW,
        }}
      />
      <div className="relative z-10 flex h-full w-full flex-col">
        <div
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-2.5 py-1.5"
          style={{ borderColor: 'var(--crt-line-strong)', background: 'linear-gradient(180deg, rgba(31,22,8,0.9) 0%, rgba(10,6,1,0.9) 100%)' }}
        >
          <button onClick={onBack} className="crt-key shrink-0 px-2.5 py-1 text-[10px]">◀ {t('ms.back')}</button>
          <span className="crt-data crt-text--hi crt-text--glow tracking-[0.3em]">
            {getLocale() === 'zh' ? '正式版剧情' : 'STORY CAMPAIGN'}
          </span>
          <span className="crt-label hidden sm:inline">· TAC-OS 3.11 · OPERATION BASTION</span>
          <span className="ml-auto flex items-center gap-2.5">
            <span className="crt-label hidden sm:inline">CLASS ■ TOP SECRET</span>
            <span className="flex items-center gap-1.5">
              <span className="tp-led animate-tp-breathe h-2 w-2" style={{ color: 'var(--crt-amber)' }} />
              <span className="crt-label">{story.length} {getLocale() === 'zh' ? '关' : 'OPS'}</span>
            </span>
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
          {story.length === 0 && (
            <div className="crt-label p-4 text-center">{getLocale() === 'zh' ? '暂无剧情关卡' : 'NO STORY MISSIONS'}</div>
          )}
          {story.map((m) => (
            <button
              key={m.id}
              onClick={() => onSelect(m.id)}
              className="crt-panel mb-2 block w-full px-3 py-2 text-left transition-colors hover:bg-[rgba(255,176,0,0.08)]"
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="crt-data crt-text--hi text-[15px] tracking-[0.18em]">
                  MISSION {String(m.campaign).padStart(2, '0')}
                </span>
                <span className="crt-data crt-text--glow text-[13px]">{m.codename}</span>
                <span className="crt-label">{m.title}</span>
              </div>
              <p className="crt-label mt-1.5 leading-relaxed" style={{ whiteSpace: 'normal' }}>{m.brief}</p>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                {m.objectives.map((o) => (
                  <span key={o.id} className="crt-label">◆ {o.label}</span>
                ))}
                <span className="crt-label">■ {m.map.toUpperCase()}</span>
                <span className="crt-label">■ {m.reward}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function MissionSelect({ onSelect, onBack }: { onSelect: (id: string) => void; onBack: () => void }) {
  const t = useT();
  // 剧情关卡有自己的界面(StorySelect), 这里只列普通出击关卡 (per user request: 剧情单独搞关卡)
  const sorties = useMemo(() => MISSIONS.filter((m) => !m.campaign), []);
  return (
    <div className="crt-frame crt-flicker relative h-full w-full select-none overflow-hidden crt-font" style={{ background: 'var(--crt-bg)' }}>
      {/* 显像管余晖 */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'linear-gradient(180deg, rgba(255,176,0,0.05) 0%, rgba(0,0,0,0) 16%, rgba(0,0,0,0) 84%, rgba(255,176,0,0.03) 100%), radial-gradient(120% 80% at 50% 50%, rgba(255,176,0,0.035) 0%, rgba(0,0,0,0) 60%)',
          boxShadow: CRT_PWR_GLOW,
        }}
      />

      <div className="relative z-10 flex h-full w-full flex-col">
        {/* 终端抬头条(与主界面状态栏同一语汇) */}
        <div
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-2.5 py-1.5"
          style={{ borderColor: 'var(--crt-line-strong)', background: 'linear-gradient(180deg, rgba(31,22,8,0.9) 0%, rgba(10,6,1,0.9) 100%)' }}
        >
          <button
            onClick={onBack}
            className="crt-key shrink-0 px-2.5 py-1 text-[10px]"
          >
            ◀ {t('ms.back')}
          </button>
          <span className="crt-data crt-text--hi crt-text--glow tracking-[0.3em]">{t('ms.title')}</span>
          <span className="crt-label hidden sm:inline">· TAC-OS 3.11 · SORTIE INDEX</span>
          <span className="ml-auto flex items-center gap-2.5">
            <span className="crt-label hidden sm:inline">CLASS ■ TOP SECRET</span>
            <span className="flex items-center gap-1.5">
              <span className="tp-led animate-tp-breathe h-2 w-2" style={{ color: 'var(--crt-amber)' }} />
              <span className="crt-label">{t('ms.countOps', { n: sorties.length })}</span>
            </span>
          </span>
        </div>

        {/* 作战任务清单:每条 = 一片终端读数行 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
          <div className="mx-auto grid w-full max-w-5xl gap-1.5">
            {sorties.map((m, i) => (
              <button
                key={m.id}
                onClick={() => onSelect(m.id)}
                className="crt-panel crt-corner group flex items-stretch overflow-hidden text-left transition-colors hover:border-[var(--crt-line-strong)] focus-visible:border-[var(--crt-line-strong)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1"
                style={{ outlineColor: 'var(--crt-line-strong)' }}
              >
                {/* 序号列(零填充) */}
                <span className="flex w-9 shrink-0 flex-col items-center justify-center border-r px-1 sm:w-14" style={{ borderColor: 'var(--crt-line)' }}>
                  <span className="crt-data crt-text--hi crt-text--glow text-base leading-none sm:text-2xl">{String(i + 1).padStart(2, '0')}</span>
                  <span className="crt-label mt-1 hidden sm:inline">IDX</span>
                </span>
                {/* 读数主体 */}
                <span className="min-w-0 flex-1 px-2.5 py-2">
                  <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                    <span className="crt-label tracking-[0.3em]">{m.codename}</span>
                    <span className="crt-data crt-text--dim hidden text-[10px] tracking-[0.2em] sm:inline">{m.id.toUpperCase()}</span>
                    <span className="crt-tag crt-label hidden opacity-0 transition-opacity group-hover:opacity-100 sm:inline">▶ EXEC</span>
                  </span>
                  <span className="crt-data crt-text--hi mt-1 block truncate text-[0.9375rem] tracking-[0.06em] transition-colors group-hover:text-[color:var(--crt-amber)] sm:text-base">{m.title}</span>
                  <span className="crt-data crt-text--dim mt-1 block truncate text-[11px] leading-snug sm:line-clamp-2 sm:whitespace-normal">{m.brief}</span>
                  {/* 数据栅格:每格 = 标签 + 值(满宽分隔线, 方便逐列扫读) */}
                  <span className="mt-2 grid grid-cols-2 gap-x-3 border-t pt-1.5 sm:grid-cols-3 lg:grid-cols-4" style={{ borderColor: 'var(--crt-line)' }}>
                    <span className="flex min-w-0 items-baseline justify-between gap-2 border-b py-0.5" style={{ borderColor: 'var(--crt-line)' }}>
                      <span className="crt-label shrink-0">LIMIT</span>
                      <span className="crt-data truncate text-[0.6875rem]" style={{ color: 'var(--crt-amber-hi)' }}>{t('ms.time', { time: `${Math.floor((m.timeLimit ?? 0) / 60)}:${((m.timeLimit ?? 0) % 60).toString().padStart(2, '0')}` })}</span>
                    </span>
                    <span className="flex min-w-0 items-baseline justify-between gap-2 border-b py-0.5" style={{ borderColor: 'var(--crt-line)' }}>
                      <span className="crt-label shrink-0">SKY</span>
                      <span className="crt-data truncate text-[0.6875rem]" style={{ color: 'var(--crt-amber-hi)' }}>{t('ms.sky', { sky: zhValue(SKY_ZH, m.sky.toUpperCase()) })}</span>
                    </span>
                    <span className="hidden min-w-0 items-baseline justify-between gap-2 border-b py-0.5 sm:flex" style={{ borderColor: 'var(--crt-line)' }}>
                      <span className="crt-label shrink-0">WX</span>
                      <span className="crt-data truncate text-[0.6875rem]" style={{ color: 'var(--crt-amber-hi)' }}>{t('ms.weather', { weather: zhValue(WEATHER_ZH, (m.weather ?? 'clear').toUpperCase()) })}</span>
                    </span>
                    <span className="hidden min-w-0 items-baseline justify-between gap-2 border-b py-0.5 lg:flex" style={{ borderColor: 'var(--crt-line)' }}>
                      <span className="crt-label shrink-0">MAP</span>
                      <span className="crt-data truncate text-[0.6875rem]" style={{ color: 'var(--crt-amber-hi)' }}>{t('ms.map', { map: zhValue(MAP_ZH, (m.map ?? 'ocean').toUpperCase()) })}</span>
                    </span>
                    <span className="flex min-w-0 items-baseline justify-between gap-2 border-b py-0.5" style={{ borderColor: 'var(--crt-line)' }}>
                      <span className="crt-label shrink-0">UNITS</span>
                      <span className="crt-data truncate text-[0.6875rem]" style={{ color: 'var(--crt-amber-hi)' }}>{t('ms.units', { n: m.spawns.length })}</span>
                    </span>
                    <span className="flex min-w-0 items-baseline justify-between gap-2 border-b py-0.5" style={{ borderColor: 'var(--crt-line)' }}>
                      <span className="crt-label shrink-0">OBJ</span>
                      <span className="crt-data truncate text-[0.6875rem]" style={{ color: 'var(--crt-amber-hi)' }}>{t('ms.objectives', { n: m.objectives.length })}</span>
                    </span>
                    {m.recommendedCategories && m.recommendedCategories.length > 0 && (
                      <span className="col-span-2 flex min-w-0 items-baseline justify-between gap-2 border-b py-0.5 sm:col-span-3 lg:col-span-4" style={{ borderColor: 'var(--crt-line)' }}>
                        <span className="crt-label shrink-0">ASSIGNED CAT</span>
                        <span className="crt-data crt-text--dim truncate text-[0.6875rem]">{t('ms.recommended', { cats: m.recommendedCategories.map((c) => CATEGORY_ZH[c] ?? c).join(' / ') })}</span>
                      </span>
                    )}
                  </span>
                </span>
                {/* 行尾状态列 */}
                <span className="hidden w-16 shrink-0 flex-col items-end justify-between border-l px-2 py-2 sm:flex" style={{ borderColor: 'var(--crt-line)' }}>
                  <span className="tp-hazard h-2.5 w-10 opacity-60" />
                  <span className="crt-label">RDR</span>
                  <span className="tp-barcode h-4 w-10 opacity-40" />
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* 底部提示行(与主界面提示行同一语汇) */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-1.5" style={{ borderColor: 'var(--crt-line)' }}>
          <span className="crt-label">CLICK SELECT</span>
          <span className="crt-label">ESC BACK</span>
          <span className="crt-warn crt-label">⚠ LIVE ORDNANCE</span>
          <span className="tp-hazard h-2.5 w-14" />
          <span className="crt-label ml-auto hidden truncate sm:inline">{t('ms.countOps', { n: sorties.length })}</span>
          <span className="crt-label hidden whitespace-nowrap lg:inline">SN 007-1986-A · MADE IN THE BUNKER</span>
        </div>
      </div>

      {/* ===== CRT 叠加层(纯装饰) ===== */}
      <div className="crt-scanlines pointer-events-none absolute inset-0 z-40 opacity-80" />
      <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden">
        <div className="tp-tracking h-[16%] w-full" />
      </div>
      <div className="crt-vignette pointer-events-none absolute inset-0 z-40" />
    </div>
  );
}

export function Briefing({ missionId, onLaunch, onBack }: { missionId: string; onLaunch: () => void; onBack: () => void }) {
  const t = useT();
  const en = getLocale() === 'en';
  const m = MISSIONS.find((x) => x.id === missionId)!;
  // === 任务区域预览: 与剧情简报同一套舞台, 走 preview 模式 =====================
  const areaIntel = useMemo(() => deriveBriefingIntel(m), [m]);
  const areaApi = useRef<BriefingStageHandle>(null);
  const [areaView, setAreaView] = useState<'map' | 'grid'>('grid');
  // Player aircraft selection is editable directly on the briefing screen —
  // no need to detour through the Hangar. Selection persists to localStorage
  // using the same keys the Hangar uses, so changes show up there too.
  const [sel, setSel] = useState<{ model: AircraftModel; paint: string }>(() => readSelection());
  // === Wingman model override per user request ===
  // 'auto' = use the mission's pre-defined wingman model. Otherwise, override
  // every wingman spawn in this mission to use the selected fighter. Lets the
  // player fly with fighter wingmen even on missions that originally feature
  // A-10 / EA-18G / Su-35 wingmen.
  const [wingmanModel, setWingmanModel] = useState<AircraftModel | 'auto'>(() => readWingmanSelection());
  // === 派遣僚机开关 (per user request: 可以选择不带僚机) ===
  const [wingmenEnabled, setWingmenEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem('skybound.wingmenEnabled') !== 'off';
  });
  const setWingmenOn = (on: boolean) => {
    setWingmenEnabled(on);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.wingmenEnabled', on ? 'on' : 'off');
    }
  };
  // === 机炮瞄准模式 (per user request: 出击前选择自动瞄准或纯机炮准心) ===
  const [gunAim, setGunAim] = useState<'auto' | 'manual'>(() => {
    if (typeof window === 'undefined') return 'auto';
    return window.localStorage.getItem('skybound.gunAim') === 'off' ? 'manual' : 'auto';
  });
  const setGunAimOn = (mode: 'auto' | 'manual') => {
    setGunAim(mode);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.gunAim', mode === 'manual' ? 'off' : 'on');
    }
  };
  // === 任务天气选择 (per user request: 关卡前可选天气/随机) ===
  type WeatherChoice = 'auto' | 'random' | 'clear' | 'cloudy' | 'rain' | 'storm' | 'fog' | 'snow';
  const [weatherOverride, setWeatherOverride] = useState<WeatherChoice>(() => {
    if (typeof window === 'undefined') return 'auto';
    const v = window.localStorage.getItem('skybound.weatherOverride');
    return (v === 'random' || (v && ['clear', 'cloudy', 'rain', 'storm', 'fog', 'snow'].includes(v)))
      ? (v as WeatherChoice)
      : 'auto';
  });
  const setWeatherValue = (v: WeatherChoice) => {
    setWeatherOverride(v);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.weatherOverride', v);
    }
  };
  // === SP weapon selection (per user request: 参考皇牌空战sp武器) ===
  // 'none' = no SP weapon (standard loadout only). Otherwise the player's
  // selected SP weapon is mounted on their aircraft for the mission.
  const [spWeapon, setSpWeapon] = useState<WeaponType | 'none'>(() => readSPWeaponSelection());
  // === Gunship side-cannon caliber (per user request: ac130可以自选sp炮) ===
  // === Multi-gun loadout (per user request: 侧炮自由选择多个不同口径的炮带进去) ===
  // The AC-130 can mount SEVERAL calibers; V cycles between them in mission.
  const [gunshipGuns, setGunshipGuns] = useState<GunshipGunId[]>(() => {
    if (typeof window === 'undefined') return ['g25', 'g40', 'g105', 'laser'];
    try {
      const raw = window.localStorage.getItem('skybound.gunshipGuns');
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          const valid = arr.filter((x) => x === 'g25' || x === 'g40' || x === 'g105' || x === 'laser');
          if (valid.length > 0) return valid;
        }
      }
    } catch { /* ignore */ }
    // Legacy single-gun key.
    const v = window.localStorage.getItem('skybound.gunshipGun');
    return v === 'g25' || v === 'g40' || v === 'g105' ? [v] : ['g25', 'g40', 'g105', 'laser'];
  });
  const toggleGun = (id: GunshipGunId) => {
    setGunshipGuns((prev) => {
      const has = prev.includes(id);
      const next = has ? prev.filter((g) => g !== id) : [...prev, id];
      return next.length > 0 ? next : prev; // always keep at least one gun
    });
  };
  // === 4-slot weapon loadout (per user request: sp和主武器在关卡开始前自己选四个) ===
  // The player picks 4 weapons total (mix of main + SP). The 4 selections
  // become the cycle-able loadout for the mission. We initialize from
  // localStorage or fall back to the category default.
  // === 侧炮机位: 简报界面即可自由切换 (per user request) ===
  // true = 自由机位(保留鼠标操控机位), false = 固定机位(键盘模式那个侧视位置)。
  // 值写在 localStorage 的 skybound.sideViewCam(取值为 free / fixed), 引擎进侧炮视角时读取。
  const [sideCamFree, setSideCamFree] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try { return window.localStorage.getItem('skybound.sideViewCam') === 'free'; } catch { return false; }
  });
  const [loadout, setLoadout] = useState<WeaponType[]>(() => {
    const saved = readLoadout();
    if (saved) return saved;
    // Will be re-set by the useEffect below once spec is resolved.
    return ['MSL', 'LASM', 'FLR', 'QAAM'];
  });
  useEffect(() => {
    setSel(readSelection());
    setWingmanModel(readWingmanSelection());
    setSpWeapon(readSPWeaponSelection());
    const saved = readLoadout();
    if (saved) {
      setLoadout(saved);
    } else {
      // Use the category default for the currently-selected aircraft.
      const cat = (PLAYER_AIRCRAFT.find((s) => s.model === readSelection().model) ?? PLAYER_AIRCRAFT[0]).category;
      setLoadout(defaultLoadoutForCategory(cat));
    }
  }, [missionId]);
  useEffect(() => {
    writeSelection(sel.model, sel.paint);
  }, [sel.model, sel.paint]);
  useEffect(() => {
    writeWingmanSelection(wingmanModel);
  }, [wingmanModel]);
  useEffect(() => {
    writeSPWeaponSelection(spWeapon);
  }, [spWeapon]);

  // Persist the gunship gun selection (array — legacy key untouched).
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem('skybound.gunshipGuns', JSON.stringify(gunshipGuns));
      } catch { /* ignore */ }
    }
  }, [gunshipGuns]);
  // Persist the 4-slot loadout whenever it changes.
  useEffect(() => {
    writeLoadout(loadout);
  }, [loadout]);
  // Resolve spec from the catalog.
  const spec: AircraftSpec = useMemo(
    () => PLAYER_AIRCRAFT.find((s) => s.model === sel.model) ?? PLAYER_AIRCRAFT[0],
    [sel.model],
  );
  const recommended = m.recommendedCategories ?? [];
  // Build a loadout summary from the spec's category.
  // === Per user request: when the 4-slot loadout is active (non-gunship/EW),
  // show the player's selected 4 weapons instead of the category default. ===
  const loadoutLines = useMemo<{ label: string; value: string }[]>(() => {
    const lines: { label: string; value: string }[] = [];
    if (spec.category === 'gunship') {
      lines.push({ label: '侧炮 · 105毫米榴弹炮', value: '∞' });
      lines.push({ label: '机炮 · 25毫米 GAU-12', value: '∞' });
      lines.push({ label: '干扰弹 · 对抗措施', value: '8' });
    } else if (spec.category === 'ew') {
      lines.push({ label: '电子战 · ALQ-99 干扰机', value: '∞' });
      lines.push({ label: '导弹 · AIM-120 阿姆拉姆', value: '40' });
      lines.push({ label: '干扰弹 · 对抗措施', value: '8' });
    } else if (spec.category === 'bomber') {
      lines.push({ label: '对地导弹 · AGM-65 小牛', value: '40' });
      lines.push({ label: '航弹 · MK-82 普通炸弹', value: '30' });
      lines.push({ label: '干扰弹 · 对抗措施', value: '6' });
    } else if (spec.category === 'stealth') {
      lines.push({ label: '导弹 · AIM-120 阿姆拉姆', value: '16' });
      lines.push({ label: '对地导弹 · GBU-27 宝石路', value: '8' });
      lines.push({ label: '航弹 · GBU-39 小直径炸弹', value: '10' });
      lines.push({ label: '干扰弹 · 对抗措施', value: '4' });
    } else if (spec.category === 'awacs') {
      lines.push({ label: '导弹 · AIM-120 (防御型)', value: '8' });
      lines.push({ label: '干扰弹 · 对抗措施', value: '10' });
    } else if (spec.category === 'attack') {
      lines.push({ label: '机炮 · GAU-8/A 30毫米', value: '∞' });
      lines.push({ label: '导弹 · AIM-9 响尾蛇', value: '24' });
      lines.push({ label: '对地导弹 · AGM-65 小牛', value: '24' });
      lines.push({ label: '航弹 · MK-82 普通炸弹', value: '20' });
      lines.push({ label: '干扰弹 · 对抗措施', value: '8' });
    } else {
      // Fighter
      lines.push({ label: '机炮 · M61A2 20毫米', value: '∞' });
      lines.push({ label: '导弹 · AIM-9X 响尾蛇', value: '60' });
      lines.push({ label: '对地导弹 · AGM-65 小牛', value: '12' });
      lines.push({ label: '航弹 · MK-82 普通炸弹', value: '6' });
      lines.push({ label: '干扰弹 · 对抗措施', value: '6' });
    }
    // === Append selected SP weapon to the loadout summary (gunship/EW only) ===
    if ((spec.category === 'gunship' || spec.category === 'ew') && spWeapon !== 'none') {
      const spSpec = SP_WEAPONS.find((s) => s.type === spWeapon);
      if (spSpec) {
        lines.push({ label: `SP · ${spSpec.code} · ${spSpec.name.toUpperCase()}`, value: String(spSpec.ammo) });
      }
    }
    // === Override the missile/bomb/flare summary with the 4-slot selection
    // for non-gunship/EW aircraft. Show each selected weapon's code + total
    // ammo (stacked if duplicates, EXCEPT MSL which is capped to 1×). ===
    if (spec.category !== 'gunship' && spec.category !== 'ew' && loadout.length === 4) {
      // Clear the category-default missile/bomb lines (keep GUN if present).
      const filtered = lines.filter((l) => l.label.startsWith('GUN'));
      // Re-add the 4-slot weapons, deduped + stacked (MSL capped to 1× — see
      // engine.ts resetState() for the matching runtime enforcement).
      const counts: Record<string, number> = {};
      for (const w of loadout) {
        counts[w] = (counts[w] ?? 0) + 1;
      }
      for (const w of Object.keys(counts)) {
        const d = getWeaponDisplay(w as WeaponType);
        // MSL: cap effective slot count at 1 (multi-slot stacking rolled back).
        const effectiveCount = w === 'MSL' ? 1 : counts[w];
        const totalAmmo = d.code === 'GUN' ? Infinity : effectiveCount * (SP_WEAPONS.find((s) => s.type === w)?.ammo ?? MAIN_WEAPONS.find((s) => s.type === w as WeaponType)?.ammo ?? 0);
        filtered.push({
          label: `${d.code} · ${d.name.toUpperCase()}`,
          value: totalAmmo === Infinity ? '∞' : String(totalAmmo),
        });
      }
      return filtered;
    }
    return lines;
  }, [spec.category, spWeapon, loadout]);

  return (
    <div className="crt-frame crt-flicker relative h-full w-full select-none overflow-hidden crt-font" style={{ background: 'var(--crt-bg)' }}>
      {/* 显像管余晖 */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'linear-gradient(180deg, rgba(255,176,0,0.05) 0%, rgba(0,0,0,0) 16%, rgba(0,0,0,0) 84%, rgba(255,176,0,0.03) 100%), radial-gradient(120% 80% at 50% 50%, rgba(255,176,0,0.035) 0%, rgba(0,0,0,0) 60%)',
          boxShadow: CRT_PWR_GLOW,
        }}
      />

      <div className="relative z-10 flex h-full w-full flex-col">
        {/* 简报抬头条:返回键 + 抬头 + 任务代号 */}
        <div
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-2.5 py-1.5"
          style={{ borderColor: 'var(--crt-line-strong)', background: 'linear-gradient(180deg, rgba(31,22,8,0.9) 0%, rgba(10,6,1,0.9) 100%)' }}
        >
          <button onClick={onBack} className="crt-key shrink-0 px-2.5 py-1 text-[10px]">◀ {t('ms.back')}</button>
          <span className="crt-data crt-text--hi crt-text--glow tracking-[0.3em]">{t('br.title')}</span>
          <span className="crt-label hidden sm:inline">· TAC-OS 3.11 · OPERATION ORDER</span>
          <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="crt-label">CLASS ■ TOP SECRET</span>
            <span className="crt-data crt-text--hi tracking-[0.24em]">{m.codename}</span>
            <span className="flex items-center gap-1.5">
              <span className="tp-led h-2 w-2" style={{ color: 'var(--crt-amber)' }} />
              <span className="crt-label">PWR</span>
            </span>
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
          <div className="mx-auto w-full max-w-5xl">
        <div className="crt-panel crt-corner">
          <div className="crt-panel-head flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5">
            <span className="crt-label crt-text--hi tracking-[0.26em]">MISSION BRIEF</span>
            <span className="crt-label truncate">{m.codename} · {m.id.toUpperCase()}</span>
          </div>
          <div className="p-3 sm:p-5">
          <div className="crt-label tracking-[0.3em]">{m.codename}</div>
          <h3 className="crt-data crt-text--hi crt-text--glow mt-1 text-2xl tracking-[0.08em] sm:text-3xl">{m.title}</h3>
          <span className="mt-2 mb-2 block h-[6px] w-full" style={{ backgroundImage: 'repeating-linear-gradient(90deg, var(--crt-amber-deep) 0 1px, transparent 1px 9px), repeating-linear-gradient(90deg, var(--crt-amber) 0 1px, transparent 1px 45px)', opacity: 0.75 }} />
          <p className="crt-data crt-text--hi crt-select leading-relaxed">{m.brief}</p>

          {/* === 任务区域预览(2D 地图 / 3D 缩比网格, per user request) === */}
          {/* 与剧情简报是**同一套舞台**(briefing-stage.ts): 这里走 preview 模式 ——
              不跑六拍过场, 只慢慢环绕, 并允许在"2D 地图(带进攻箭头)"与"3D 缩比
              网格(敌我标记)"之间切换。挑挂载的时候能一眼看清战场布局。 */}
          <div className="mt-5">
            <div className="crt-label mb-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 tracking-[0.24em]">
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="crt-text--hi">{en ? 'MISSION AREA' : '任务区域'}</span>
                <span>{t('stbr.legend')}</span>
              </span>
              <button
                type="button"
                onClick={() => {
                  playKey();
                  const next = areaView === 'map' ? 'grid' : 'map';
                  setAreaView(next);
                  areaApi.current?.setPreviewView(next);
                }}
                className="crt-key shrink-0 px-2 py-1 text-[10px] tracking-[0.18em]"
              >
                {areaView === 'map' ? t('stbr.gridView') : t('stbr.mapView')}
              </button>
            </div>
            <div className="tp-monitor">
              {/* 内层容器: .tp-monitor 自己有 5px 内边距, 画布要落在内边距之内,
                  才能和 .tp-monitor-scan(inset:5px)严丝合缝地叠在一起 */}
              <div className="relative h-52 overflow-hidden sm:h-64">
                <BriefingStage
                  ref={areaApi}
                  intel={areaIntel}
                  mode="preview"
                  en={en}
                  missionId={missionId}
                  codename={m.codename}
                  showCards={false}
                />
              </div>
              <div className="tp-monitor-scan" />
            </div>
            <div className="crt-label mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>{areaView === 'map' ? 'CAM · MAP DOWNLINK' : 'CAM · ORBIT AUTO'}</span>
              <span>SIG ▮▮▮▯</span>
              <span>OPTICS BAY 2</span>
              <span className="crt-text--dim">{t('stbr.toggleHint')}</span>
            </div>
          </div>

          {/* 作战目标 / 环境数据 */}
          <div className="mt-4 grid grid-cols-1 gap-2 lg:grid-cols-2">
            <div className="crt-panel crt-corner">
              <div className="crt-panel-head px-2.5 py-1.5">
                <span className="crt-label crt-text--hi tracking-[0.26em]">{t('br.objectives')}</span>
              </div>
              <div className="p-2.5">
              <ul className="space-y-1">
                {m.objectives.map((o) => (
                  <li key={o.id} className="crt-data flex items-start gap-2">
                    <span className="crt-text--deep shrink-0">▸</span>
                    <span className="crt-text--hi crt-select">{o.label}{o.count ? ` (${o.count})` : ''}{o.time ? ` (${o.time}s)` : ''}</span>
                  </li>
                ))}
              </ul>
              {recommended.length > 0 && (
                <div className="mt-3 border-t pt-2" style={{ borderColor: 'var(--crt-line)' }}>
                  <div className="crt-label mb-1.5 tracking-[0.24em]">{t('br.recommendedAircraft')}</div>
                  <div className="flex flex-wrap gap-1">
                    {recommended.map((c) => (
                      <span key={c} className="crt-box px-2 py-1 text-[0.625rem] tracking-wider"
                        style={{ borderColor: CATEGORY_COLORS[c], color: CATEGORY_COLORS[c] }}>
                        ◈ {CATEGORY_ZH[c] ?? c}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              </div>
            </div>

            <div className="crt-panel crt-corner">
              <div className="crt-panel-head px-2.5 py-1.5">
                <span className="crt-label crt-text--hi tracking-[0.26em]">{t('br.environment')}</span>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2 p-2.5">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="crt-label">SKY</span>
                  <span className="crt-data crt-text--hi truncate">{t('br.sky')}</span>
                  <span className="crt-data crt-text--dim truncate text-[10px]">{zhValue(SKY_ZH, m.sky.toUpperCase())}</span>
                </div>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="crt-label">WX</span>
                  <span className="crt-data crt-text--hi truncate">{t('br.weather')}</span>
                  <span className="crt-data crt-text--dim truncate text-[10px]">{zhValue(WEATHER_ZH, (m.weather ?? 'clear').toUpperCase())}</span>
                </div>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="crt-label">MAP</span>
                  <span className="crt-data crt-text--hi truncate">{t('br.map')}</span>
                  <span className="crt-data crt-text--dim truncate text-[10px]">{zhValue(MAP_ZH, (m.map ?? 'ocean').toUpperCase())}</span>
                </div>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="crt-label">LIMIT</span>
                  <span className="crt-data crt-text--hi truncate">{m.timeLimit ? `${Math.round(m.timeLimit / 60)} MIN` : '∞'}</span>
                  <span className="crt-data crt-text--dim truncate text-[10px]">{t('ms.objectives', { n: m.objectives.length })} · {t('ms.units', { n: m.spawns.length })}</span>
                </div>
                <span className="tp-hazard col-span-2 h-2.5 opacity-60" />
              </div>
            </div>
          </div>

          {/* 挂载配置 */}
          <div className="crt-panel crt-corner mt-2">
            <div className="crt-panel-head flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5">
              <span className="crt-label crt-text--hi tracking-[0.26em]">{t('br.selectAircraft')}</span>
              <span className="crt-label truncate">ARMAMENT · STORES MANAGEMENT</span>
            </div>
            <div className="grid grid-cols-1 gap-x-5 gap-y-4 p-2.5 lg:grid-cols-2">
            <div>
              {/* Inline aircraft picker — 3-column grid, color-coded by category.
                  Clicking any aircraft swaps the selection immediately; the
                  spec sheet below updates to show the new aircraft's stats. */}
              <div className="grid grid-cols-3 gap-1 max-h-44 overflow-y-auto pr-1">
                {PLAYER_AIRCRAFT.map((s) => {
                  const accent = CATEGORY_COLORS[s.category];
                  const isActive = sel.model === s.model;
                  const isRecommended = recommended.includes(s.category);
                  return (
                    <button
                      key={s.id}
                      onClick={() => setSel((p) => ({ ...p, model: s.model }))}
                      className={`relative border px-2 py-1.5 text-left transition-colors ${isActive ? 'border-[var(--crt-amber)] bg-[var(--crt-amber)]/10 text-[var(--crt-amber-hi)]' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/8'}`}
                      style={isActive ? { borderColor: accent, background: `${accent}1a` } : undefined}
                      title={s.name}
                    >
                      {isRecommended && (
                        <span className="absolute top-0.5 right-1 text-[0.5rem] tracking-wider" style={{ color: accent }}>★</span>
                      )}
                      <div className="text-[0.6875rem] tracking-wide leading-tight" style={isActive ? { color: accent } : undefined}>{s.code}</div>
                      <div className="text-[0.5rem] opacity-70 mt-0.5">{CATEGORY_LABEL[s.category]}</div>
                    </button>
                  );
                })}
              </div>
              <div className="crt-label mt-2 tracking-[0.18em]">
                {t('br.recommendedHint')}
              </div>

              <div className="crt-label mt-4 mb-1.5 tracking-[0.24em]">{t('br.paintScheme')}</div>
              <div className="grid grid-cols-4 gap-1">
                {(['standard', 'stealth', 'aggressor', 'camo'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setSel((prev) => ({ ...prev, paint: p }))}
                    className={`px-2 py-1 text-[0.625rem] border tracking-wider ${sel.paint === p ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/8'}`}
                  >
                    {p.toUpperCase()}
                  </button>
                ))}
              </div>

              <div className="crt-label mt-4 mb-1.5 tracking-[0.24em]">{t('br.selectedAircraft')}</div>
              <div className="crt-data crt-text--hi text-[0.8125rem]">
                <span style={{ color: CATEGORY_COLORS[spec.category] }}>{aircraftNameZh(spec)}</span>
                <span className="crt-text--dim"> · GHOST 1-1</span>
              </div>
              <div className="crt-data crt-text--dim mt-1 text-[0.625rem]">
                生命 {spec.hp} · 极速 {spec.maxSpeed} · {CATEGORY_ZH[spec.category] ?? spec.category.toUpperCase()}
                {spec.abilities.jammer && ' · 干扰机'}
                {spec.abilities.sideCannon && ' · 侧炮'}
                {spec.abilities.stealth && ' · 隐身'}
                {spec.abilities.awacs && ' · 预警机'}
              </div>
              <span className="mt-2 block h-[6px] w-full" style={{ backgroundImage: 'repeating-linear-gradient(90deg, var(--crt-amber-deep) 0 1px, transparent 1px 9px), repeating-linear-gradient(90deg, var(--crt-amber) 0 1px, transparent 1px 45px)', opacity: 0.75 }} />

              {/* === 派遣僚机开关 (per user request: 可以选择不带僚机) === */}
              <div className="flex items-center justify-between mt-4 mb-2">
                <span className="crt-label tracking-[0.24em]">
                  {getLocale() === 'zh' ? '派遣僚机' : 'WINGMEN'}
                </span>
                <button
                  onClick={() => setWingmenOn(!wingmenEnabled)}
                  className={`px-3 py-1 text-[0.625rem] border tracking-widest ${wingmenEnabled ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-dim)]'}`}
                >
                  {wingmenEnabled ? (getLocale() === 'zh' ? '开' : 'ON') : (getLocale() === 'zh' ? '关' : 'OFF')}
                </button>
              </div>
              {/* === 机炮瞄准模式 (per user request: 出击前选择) === */}
              <div className="flex items-center justify-between mt-3 mb-2">
                <span className="crt-label tracking-[0.24em]">
                  {getLocale() === 'zh' ? '机炮瞄准' : 'GUN AIM'}
                </span>
                <div className="flex gap-1">
                  <button
                    onClick={() => setGunAimOn('auto')}
                    className={`px-2 py-1 text-[0.625rem] border tracking-widest ${gunAim === 'auto' ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-dim)]'}`}
                  >
                    {getLocale() === 'zh' ? '自动瞄准' : 'AUTO'}
                  </button>
                  <button
                    onClick={() => setGunAimOn('manual')}
                    className={`px-2 py-1 text-[0.625rem] border tracking-widest ${gunAim === 'manual' ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-dim)]'}`}
                  >
                    {getLocale() === 'zh' ? '纯准心' : 'MANUAL'}
                  </button>
                </div>
              </div>
              {/* === 任务天气选择 (per user request: 关卡前可选天气/随机) === */}
              <div className="mt-3 mb-1">
                <div className="crt-label tracking-[0.24em] mb-2">
                  {getLocale() === 'zh' ? '任务天气' : 'WEATHER'}
                </div>
                <div className="grid grid-cols-4 gap-1">
                  {([
                    ['auto', getLocale() === 'zh' ? '任务默认' : 'AUTO'],
                    ['random', getLocale() === 'zh' ? '随机' : 'RANDOM'],
                    ['clear', getLocale() === 'zh' ? '晴' : 'CLEAR'],
                    ['cloudy', getLocale() === 'zh' ? '多云' : 'CLOUDY'],
                    ['rain', getLocale() === 'zh' ? '雨' : 'RAIN'],
                    ['storm', getLocale() === 'zh' ? '雷暴' : 'STORM'],
                    ['fog', getLocale() === 'zh' ? '雾' : 'FOG'],
                    ['snow', getLocale() === 'zh' ? '雪' : 'SNOW'],
                  ] as [WeatherChoice, string][]).map(([v, label]) => (
                    <button
                      key={v}
                      onClick={() => setWeatherValue(v)}
                      className={`px-1 py-1 text-[0.5625rem] border tracking-wider ${weatherOverride === v ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/8'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
                  {getLocale() === 'zh'
                    ? '不同天气的天光颜色和效果不同；随机每次进关卡都不同。'
                    : 'Each weather changes the sky light and effects; RANDOM varies every mission.'}
                </div>
              </div>
              {/* === Wingman model override per user request === */}
              {/* Lets the player choose which fighter model wingmen fly, so they
                  can pick e.g. F-15 escorts on missions that originally ship
                  with F-16 wingmen. 'AUTO' keeps the mission default. */}
              <div className={`crt-label tracking-[0.24em] mb-2 ${wingmenEnabled ? '' : 'opacity-40'}`}>{getLocale() === 'zh' ? '僚机机型' : 'WINGMAN MODEL'}</div>
              <div className={`grid grid-cols-5 gap-1 ${wingmenEnabled ? '' : 'opacity-40 pointer-events-none'}`}>
                <button
                  onClick={() => setWingmanModel('auto')}
                  className={`px-1 py-1 text-[0.5625rem] border tracking-wider ${wingmanModel === 'auto' ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/8'}`}
                >
                  {getLocale() === 'zh' ? '自动' : 'AUTO'}
                </button>
                {(['f16', 'f15', 'su35', 'a10'] as AircraftModel[]).map((mdl) => {
                  const ws = PLAYER_AIRCRAFT.find((s) => s.model === mdl);
                  if (!ws) return null;
                  return (
                    <button
                      key={mdl}
                      onClick={() => setWingmanModel(mdl)}
                      className={`px-1 py-1 text-[0.5625rem] border tracking-wider ${wingmanModel === mdl ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/8'}`}
                      title={ws.name}
                    >
                      {ws.code}
                    </button>
                  );
                })}
              </div>
              <div className="text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
                {getLocale() === 'zh' ? 'AUTO = 使用任务默认僚机机型' : 'AUTO = USE MISSION DEFAULT WINGMAN MODEL'}
              </div>

              {/* === 4-slot weapon loadout (per user request: sp和主武器在关卡开始前自己选四个) === */}
              {/* The player picks 4 weapons total (mix of main + SP). Each
                  slot can be any of MSL / LASM / BDL / FLR / LAAM / QAAM /
                  SARH / HVG / CLB. The 4 selections become the cycle-able
                  loadout for the mission. GUN is always available for
                  fighters (not part of the 4 slots). */}
              {/* Hide for gunship/EW — those have mandatory special weapons */}
              {spec.category !== 'gunship' && spec.category !== 'ew' && (
                <>
                  <div className="crt-label tracking-[0.24em] mb-2 mt-4">
                    {getLocale() === 'zh' ? '武器挂载 (4 槽)' : 'WEAPON LOADOUT (4 SLOTS)'}
                  </div>
                  {/* 4 slot displays — each shows the currently selected
                      weapon code + a row of buttons to pick a different
                      weapon for that slot. */}
                  <div className="space-y-1.5">
                    {[0, 1, 2, 3].map((slotIdx) => {
                      const current = loadout[slotIdx];
                      const disp = getWeaponDisplay(current);
                      return (
                        <div key={slotIdx} className="crt-box crt-corner border-[var(--crt-amber-ghost)] p-1.5">
                          <div className="flex items-center justify-between mb-1">
                            <span className="crt-label tracking-[0.24em]">
                              {getLocale() === 'zh' ? `槽位 ${slotIdx + 1}` : `SLOT ${slotIdx + 1}`}
                            </span>
                            <span
                              className="crt-data crt-text--hi text-[0.625rem] font-bold tracking-wider"
                              style={{ color: disp.color }}
                            >
                              {disp.code}
                            </span>
                          </div>
                          {/* Weapon picker for this slot — 9 buttons (4 main + 5 SP) */}
                          {/* === MSL multi-slot disabled (per user request) ===
                              MSL can only occupy ONE slot. If MSL is already
                              picked in another slot, the MSL button is disabled
                              in this slot (greyed out, not clickable). Other
                              weapons (LASM/BDL/FLR/SP) still allow duplicates. */}
                          <div className="grid grid-cols-5 gap-0.5">
                            {ALL_LOADABLE_WEAPONS.map((w) => {
                              const d = getWeaponDisplay(w);
                              const isActive = current === w;
                              // MSL is locked to one slot — if it's already
                              // picked in another slot, disable it here.
                              const mslInOtherSlot = w === 'MSL'
                                && loadout.some((lw, i) => i !== slotIdx && lw === 'MSL');
                              const disabled = mslInOtherSlot && !isActive;
                              return (
                                <button
                                  key={w}
                                  disabled={disabled}
                                  onClick={() => {
                                    const next = [...loadout];
                                    next[slotIdx] = w;
                                    setLoadout(next);
                                  }}
                                  className={`px-0.5 py-1 text-[0.5rem] border tracking-wider ${
                                    disabled
                                      ? 'border-[var(--crt-amber-ghost)] text-[var(--crt-amber-deep)] cursor-not-allowed'
                                      : isActive
                                        ? 'text-[var(--crt-amber-hi)]'
                                        : 'border-[var(--crt-amber-ghost)] text-[var(--crt-amber-dim)] hover:bg-[var(--crt-amber)]/8'
                                  }`}
                                  style={isActive && !disabled ? { borderColor: 'var(--crt-amber-hi)', background: 'rgba(255,176,0,0.18)', color: 'var(--crt-amber-hi)' } : undefined}
                                  title={
                                    disabled
                                      ? (getLocale() === 'zh' ? 'MSL 只能选择一个槽位' : 'MSL LIMITED TO ONE SLOT')
                                      : `${d.name}\n+ ${d.pros}\n- ${d.cons}`
                                  }
                                >
                                  {d.code}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {/* Show summary of selected loadout + tip */}
                  <div className="mt-2 text-[0.5625rem] text-[var(--crt-amber-dim)]">
                    {getLocale() === 'zh'
                      ? '选 4 件武器，重复选择同款叠加弹药（MSL 仅 1 槽）。GUN 永远可用。'
                      : 'PICK 4 WEAPONS. DUPLICATES STACK AMMO (MSL LIMITED TO 1 SLOT). GUN ALWAYS AVAILABLE.'}
                  </div>
                </>
              )}

              {/* === SP weapon selection (per user request: 参考皇牌空战sp武器) === */}
              {/* Lets the player pick ONE special weapon to mount on their
                  aircraft for the mission. Each SP weapon has distinct
                  pros/cons. 'NONE' = standard loadout only.
                  === Gunship override (per user request: ac130可以自选sp炮) ===
                  The AC-130's SP slot is its side CANNON — the briefing shows
                  the three selectable calibers instead of missiles. */}
              {/* Hidden when the 4-slot loadout is active (gunship/EW only). */}
              {spec.category === 'gunship' || spec.category === 'ew' ? (
                <>
                  {spec.category === 'gunship' ? (
                    <>
                      <div className="crt-label tracking-[0.24em] mb-2 mt-4">
                        {getLocale() === 'zh' ? '侧炮口径' : 'SIDE CANNON'}
                      </div>
                      <div className="grid grid-cols-3 gap-1">
                        {(Object.keys(GUNSHIP_GUNS) as GunshipGunId[]).map((id) => {
                          const g = GUNSHIP_GUNS[id];
                          const active = gunshipGuns.includes(id);
                          return (
                            <button
                              key={id}
                              onClick={() => toggleGun(id)}
                              className={`px-1 py-1.5 text-[0.5625rem] border tracking-wider ${active ? 'border-[var(--crt-red)] text-[var(--crt-amber-dim)] bg-[var(--crt-red)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/8'}`}
                              title={g.label}
                            >
                              {g.label.split(' ')[0]}{active ? ' ✓' : ''}
                            </button>
                          );
                        })}
                      </div>
                      <div className="mt-2 text-[0.625rem] space-y-0.5" style={{ color: 'var(--crt-amber-dim)' }}>
                        <div className="font-bold tracking-wider">
                          {getLocale() === 'zh'
                            ? `已挂载 ${gunshipGuns.length} 门炮 · 任务中按 V 切换`
                            : `${gunshipGuns.length} gun(s) mounted · press V in mission to cycle`}
                        </div>
                        <div className="text-[0.5625rem] opacity-80">
                          {gunshipGuns.map((id) => GUNSHIP_GUNS[id].label).join(' · ')}
                        </div>
                        <div className="text-[0.5625rem] opacity-60">
                          {getLocale() === 'zh' ? '空格直射 · CapsLock炮手视角' : 'Space fires direct · CapsLock gunner view'}
                        </div>
                      </div>
                      {/* === 侧炮机位二选一 (per user request: 简报界面即可切换) ===
                          自由机位 = 进侧炮时保留鼠标操控机位(自由视角);
                          固定机位 = 键盘模式进侧炮的那个位置(原行为)。 */}
                      <div className="crt-label tracking-[0.24em] mb-2 mt-4">
                        {getLocale() === 'zh' ? '侧炮机位' : 'SIDE GUN CAMERA'}
                      </div>
                      <div className="grid grid-cols-2 gap-1">
                        <button
                          onClick={() => { setSideCamFree(false); try { window.localStorage.setItem('skybound.sideViewCam', 'fixed'); } catch { /* ignore */ } }}
                          className={`px-2 py-1.5 text-[0.5625rem] border tracking-wider ${!sideCamFree ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/8'}`}
                        >
                          {getLocale() === 'zh' ? '固定机位 (原行为)' : 'FIXED (default)'}
                        </button>
                        <button
                          onClick={() => { setSideCamFree(true); try { window.localStorage.setItem('skybound.sideViewCam', 'free'); } catch { /* ignore */ } }}
                          className={`px-2 py-1.5 text-[0.5625rem] border tracking-wider ${sideCamFree ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/8'}`}
                        >
                          {getLocale() === 'zh' ? '自由机位 (鼠标机位)' : 'FREE (mouse cam)'}
                        </button>
                      </div>
                      <div className="mt-1 text-[0.5625rem] opacity-60" style={{ color: 'var(--crt-amber-dim)' }}>
                        {getLocale() === 'zh'
                          ? '键盘与鼠标操控模式通用'                   
                          : 'Applies to both keyboard and mouse control'}
                      </div>
                      <div className="hidden">
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="crt-label tracking-[0.24em] mb-2 mt-4">
                        {getLocale() === 'zh' ? 'SP 武器挂载' : 'SP WEAPON'}
                      </div>
                      <div className="grid grid-cols-3 gap-1">
                        <button
                          onClick={() => setSpWeapon('none')}
                          className={`px-1 py-1.5 text-[0.5625rem] border tracking-wider ${spWeapon === 'none' ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/8'}`}
                        >
                          {getLocale() === 'zh' ? '无' : 'NONE'}
                        </button>
                        {SP_WEAPONS.map((sp) => (
                          <button
                            key={sp.type}
                            onClick={() => setSpWeapon(sp.type)}
                            className={`px-1 py-1.5 text-[0.5625rem] border tracking-wider ${spWeapon === sp.type ? 'text-[var(--crt-amber-hi)]' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/8'}`}
                            style={spWeapon === sp.type ? { borderColor: 'var(--crt-amber-hi)', background: 'rgba(255,176,0,0.18)', color: 'var(--crt-amber-hi)' } : undefined}
                            title={`${sp.name}\n${sp.pros}\n${sp.cons}\n${sp.aceCombatName}`}
                          >
                            {sp.code}
                          </button>
                        ))}
                      </div>
                      {/* Show the selected SP weapon's pros/cons */}
                      {spWeapon !== 'none' && (() => {
                        const sp = SP_WEAPONS.find((s) => s.type === spWeapon);
                        if (!sp) return null;
                        return (
                          <div className="crt-label mt-2 flex flex-col gap-0.5" style={{ color: 'var(--crt-amber-dim)' }}>
                            <div className="crt-text--hi tracking-[0.2em]">{sp.name}</div>
                            <div className="text-[0.5625rem] opacity-80">+ {sp.pros}</div>
                            <div className="text-[0.5625rem] opacity-80">- {sp.cons}</div>
                            <div className="text-[0.5625rem] opacity-50 mt-0.5">{sp.aceCombatName}</div>
                          </div>
                        );
                      })()}
                    </>
                  )}
                </>
              ) : null}

              <div className="crt-label tracking-[0.24em] mb-2 mt-4">{t('br.loadout')}</div>
              <ul className="space-y-0.5">
                {loadoutLines.map((l) => (
                  <li key={l.label} className="crt-data flex items-baseline justify-between gap-2 border-b py-0.5" style={{ borderColor: 'var(--crt-line)' }}>
                    <span className="crt-text--hi truncate">{l.label}</span>
                    <span className="crt-text--hi crt-text--glow shrink-0 font-bold">{l.value}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          </div>

          {/* 控制说明 */}
          <div className="crt-panel crt-corner mt-2">
            <div className="crt-panel-head px-2.5 py-1.5">
              <span className="crt-label crt-text--hi tracking-[0.26em]">{t('br.controls')}</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5 p-2.5 sm:grid-cols-3 lg:grid-cols-4">
              <div className="crt-data crt-text--hi border-b py-0.5" style={{ borderColor: 'var(--crt-line)' }}>{t('ctrl.pitch')}</div>
              <div className="crt-data crt-text--hi border-b py-0.5" style={{ borderColor: 'var(--crt-line)' }}>{t('ctrl.roll')}</div>
              <div className="crt-data crt-text--hi border-b py-0.5" style={{ borderColor: 'var(--crt-line)' }}>{t('ctrl.yaw')}</div>
              <div className="crt-data crt-text--hi border-b py-0.5" style={{ borderColor: 'var(--crt-line)' }}>{t('ctrl.throttle')}</div>
              <div className="crt-data crt-text--hi border-b py-0.5" style={{ borderColor: 'var(--crt-line)' }}>{t('ctrl.gun')}</div>
              <div className="crt-data crt-text--hi border-b py-0.5" style={{ borderColor: 'var(--crt-line)' }}>{t('ctrl.missile')}</div>
              <div className="crt-data crt-text--hi border-b py-0.5" style={{ borderColor: 'var(--crt-line)' }}>{t('ctrl.cycleWpn')}</div>
              <div className="crt-data crt-text--hi border-b py-0.5" style={{ borderColor: 'var(--crt-line)' }}>{t('ctrl.flare')}</div>
              <div className="crt-data crt-text--hi border-b py-0.5" style={{ borderColor: 'var(--crt-line)' }}>{t('ctrl.camera')}</div>
              <div className="crt-data crt-text--hi border-b py-0.5" style={{ borderColor: 'var(--crt-line)' }}>{t('ctrl.freeLook')}</div>
              <div className="crt-data crt-text--hi border-b py-0.5" style={{ borderColor: 'var(--crt-line)' }}>{t('ctrl.nextTgt')}</div>
              <div className="crt-data crt-text--hi border-b py-0.5" style={{ borderColor: 'var(--crt-line)' }}>{t('ctrl.lookback')}</div>
              <div className="crt-data crt-text--hi border-b py-0.5" style={{ borderColor: 'var(--crt-line)' }}>{t('ctrl.pause')}</div>
              <div className="crt-data crt-text--hi border-b py-0.5" style={{ borderColor: 'var(--crt-line)' }}>{t('ctrl.wingAtk')}</div>
              <div className="crt-data crt-text--hi border-b py-0.5" style={{ borderColor: 'var(--crt-line)' }}>{t('ctrl.wingCov')}</div>
              <div className="crt-data crt-text--hi border-b py-0.5" style={{ borderColor: 'var(--crt-line)' }}>{t('ctrl.wingForm')}</div>
              <div className="crt-data crt-text--hi border-b py-0.5" style={{ borderColor: 'var(--crt-line)' }}>{t('ctrl.settings')}</div>
              <div className="crt-data crt-text--dim col-span-2 border-b py-0.5 sm:col-span-3 lg:col-span-4" style={{ borderColor: 'var(--crt-line)' }}>{t('ctrl.mouseWheel')}</div>
            </div>
          </div>
          </div>
        </div>

        {/* 出击键(执行键帽) */}
        <div className="mt-3 flex flex-col items-center gap-2">
          <button
            onClick={onLaunch}
            className="crt-key crt-corner w-full max-w-xl px-8 py-3 text-[0.8125rem] font-bold tracking-[0.3em] hover:border-[var(--crt-amber-hi)] hover:text-[color:var(--crt-amber-hi)] focus-visible:outline focus-visible:outline-1"
            style={{ outlineColor: 'var(--crt-line-strong)' }}
          >
            ▶ {t('br.launch')}
          </button>
          <div className="crt-label text-center tracking-[0.24em]">
            {t('br.launchHint')}
          </div>
        </div>
          </div>
        </div>

        {/* 底部提示行 */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-1.5" style={{ borderColor: 'var(--crt-line)' }}>
          <span className="crt-label">ESC BACK</span>
          <span className="crt-label">ARM BEFORE TAKEOFF</span>
          <span className="crt-warn crt-label">⚠ LIVE ORDNANCE</span>
          <span className="tp-hazard h-2.5 w-14" />
          <span className="crt-label ml-auto whitespace-nowrap">SN 007-1986-A · MADE IN THE BUNKER</span>
          <span className="tp-barcode hidden h-5 w-24 sm:block" />
        </div>
      </div>

      {/* ===== CRT 叠加层(纯装饰) ===== */}
      <div className="crt-scanlines pointer-events-none absolute inset-0 z-40 opacity-80" />
      <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden">
        <div className="tp-tracking h-[16%] w-full" />
      </div>
      <div className="crt-vignette pointer-events-none absolute inset-0 z-40" />
    </div>
  );
}

export function Results({ win, score, stats, mp, saveStatus, onContinue }: {
  win: boolean;
  score: number;
  stats: { kills: number; time: number; accuracy: number };
  /** 联机结算积分板(P2 收尾); 单机为 null/undefined → 不渲染。 */
  mp?: { players: { name: string; team: number; kills: number; deaths: number; isSelf: boolean }[]; teamScores: Record<string, number>; selfTeam: number } | null;
  /** P4-1: 战绩归档结果(联机才有; 单机为 null)。 */
  saveStatus?: { reason: string; room: boolean; career: boolean } | null;
  onContinue: () => void;
}) {
  const t = useT();
  const accent = win ? 'var(--crt-green)' : 'var(--crt-red)';
  // 战术评估:命中率与评分(仅呈现, 不改变任何原有数值来源)
  const accPct = Math.max(0, Math.min(100, Math.round(stats.accuracy * 100)));
  const rows: [string, string][] = [
    [t('res.score'), score.toLocaleString()],
    [t('res.kills'), String(stats.kills)],
    [t('res.time'), `${Math.floor(stats.time / 60)}:${(stats.time % 60).toString().padStart(2, '0')}`],
    ['ACC', `${accPct}%`],
  ];
  const segs = 20;
  const filled = Math.round((accPct / 100) * segs);
  return (
    <div className="crt-frame crt-flicker relative h-full w-full select-none overflow-hidden crt-font" style={{ background: 'var(--crt-bg)' }}>
      {/* 显像管余晖 */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'linear-gradient(180deg, rgba(255,176,0,0.05) 0%, rgba(0,0,0,0) 16%, rgba(0,0,0,0) 84%, rgba(255,176,0,0.03) 100%), radial-gradient(120% 80% at 50% 50%, rgba(255,176,0,0.035) 0%, rgba(0,0,0,0) 60%)',
          boxShadow: CRT_PWR_GLOW,
        }}
      />

      <div className="relative z-10 flex h-full w-full flex-col">
        {/* 终端抬头条 */}
        <div
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-2.5 py-1.5"
          style={{ borderColor: 'var(--crt-line-strong)', background: 'linear-gradient(180deg, rgba(31,22,8,0.9) 0%, rgba(10,6,1,0.9) 100%)' }}
        >
          <span className="crt-data crt-text--hi crt-text--glow tracking-[0.3em]">DEBRIEF</span>
          <span className="crt-label hidden sm:inline">· TAC-OS 3.11 · SORTIE DEBRIEF</span>
          <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className={'crt-label ' + (win ? 'crt-ready' : 'crt-warn')}>■ {win ? t('res.success') : t('res.fail')}</span>
            <span className="crt-label">PRINT · 1/1</span>
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
          <div className="mx-auto flex min-h-full w-full max-w-[680px] flex-col justify-center">
            {/* 评估单:竖排打印纸 + 表格读数 */}            <div className="crt-panel crt-corner">
              {/* 判定横幅(绿=通过 / 红=失败) */}
              <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 border-b px-3 py-2" style={{ borderColor: accent, background: win ? 'rgba(124,255,107,0.07)' : 'rgba(255,59,31,0.08)' }}>
                <span className="crt-label crt-text--glow" style={{ color: accent }}>{win ? t('res.success') : t('res.fail')}</span>
                <span className="crt-data crt-text--glow text-xl font-bold tracking-[0.24em] sm:text-2xl" style={{ color: accent }}>{win ? t('res.complete') : t('res.failed')}</span>
                <span className="tp-hazard h-3 w-16 opacity-70" />
              </div>

              <div className="p-3 sm:p-5">
                <span className="tp-hazard block h-2 w-full opacity-55" />

                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="crt-label crt-text--hi tracking-[0.26em]">{t('res.score')} · RECORD SHEET</span>
                  <span className="crt-label">SEGMENTS {segs} · FILLED {String(filled).padStart(2, '0')}</span>
                </div>

                {/* 数据条栅格 */}
                <div className="mt-1.5 flex gap-[2px]">
                  {Array.from({ length: segs }).map((_, i) => (
                    <span
                      key={i}
                      className="h-3 flex-1"
                      style={{
                        background: i < filled ? 'var(--crt-amber)' : 'var(--crt-amber-ghost)',
                        boxShadow: i < filled ? '0 0 5px rgba(255,176,0,0.45)' : undefined,
                      }}
                    />
                  ))}
                </div>

                {/* 表格式读数 */}
                <div className="mt-3">
                  {rows.map(([k, v], i) => (
                    <div
                      key={k}
                      className="flex items-baseline justify-between gap-3 border-b py-2"
                      style={{ borderColor: i === 0 ? 'var(--crt-line-strong)' : 'var(--crt-line)' }}
                    >
                      <span className="crt-label min-w-0 truncate">{k}</span>
                      <span className="crt-data crt-text--hi crt-text--glow shrink-0 text-lg font-bold">{v}</span>
                    </div>
                  ))}
                </div>

                {/* === 联机积分板 (P2 收尾) ===
                    走纯规则(团队按队总分 / 个人战按击毁数)排名的最终战绩;
                    单机结算时 mp 为 null, 这一段完全不渲染。 */}
                {mp && mp.players.length > 0 && (
                  <div className="mt-3 border-t pt-2" style={{ borderColor: 'var(--crt-line)' }}>
                    <div className="crt-label crt-text--hi mb-1 tracking-[0.24em]">
                      MULTIPLAYER · FINAL SCOREBOARD
                    </div>
                    {Object.keys(mp.teamScores).length > 0 && (
                      <div className="crt-label mb-1 flex flex-wrap gap-x-3">
                        {Object.entries(mp.teamScores)
                          .sort(([a], [b]) => Number(a) - Number(b))
                          .map(([team, s]) => (
                            <span
                              key={team}
                              style={{ color: Number(team) === mp.selfTeam ? 'var(--crt-ally, #5ad2ff)' : 'var(--crt-red-light, #ff6a5c)' }}
                            >
                              {Number(team) === 0 ? 'BLUE' : 'RED'} {s}
                            </span>
                          ))}
                      </div>
                    )}
                    <table className="w-full">
                      <thead>
                        <tr className="crt-label">
                          <th className="py-0.5 text-left">#</th>
                          <th className="py-0.5 text-left">CALLSIGN</th>
                          <th className="py-0.5 text-right">K</th>
                          <th className="py-0.5 text-right">D</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...mp.players]
                          .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
                          .map((p, i) => (
                            <tr key={`${p.name}-${i}`} className="border-t" style={{ borderColor: 'var(--crt-line)' }}>
                              <td className="crt-label py-1">{String(i + 1).padStart(2, '0')}</td>
                              <td className={`crt-data py-1 ${p.isSelf ? 'crt-text--hi' : ''}`}>
                                {p.name}{p.isSelf ? ' (YOU)' : ''}
                              </td>
                              <td className="crt-data py-1 text-right">{p.kills}</td>
                              <td className="crt-data py-1 text-right opacity-70">{p.deaths}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="crt-label mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="crt-text--hi">SIGNAL LOST · RECOVERED</span>
                  <span>TAPE 1 / SIDE A</span>
                  {/* === P4-1: 战绩归档状态 ===
                      联机才有: 已归档=就绪绿; 离线/未登录=琥珀提示(不影响游玩)。 */}
                  {saveStatus && (
                    <span className={saveStatus.reason === 'ok' ? 'crt-ready' : 'crt-warn'}>
                      {saveStatus.reason === 'ok'
                        ? (getLocale() === 'zh'
                          ? `◈ 战绩已归档${saveStatus.room ? '(含房间记录)' : ''}`
                          : `◈ RESULT ARCHIVED${saveStatus.room ? ' (ROOM+SAVE)' : ''}`)
                        : saveStatus.reason === 'not-logged-in'
                          ? (getLocale() === 'zh' ? '◇ 未登录 · 战绩未归档' : '◇ NOT LOGGED IN · NOT ARCHIVED')
                          : saveStatus.reason === 'duplicate'
                            ? (getLocale() === 'zh' ? '◇ 本局已归档' : '◇ ALREADY ARCHIVED')
                            : (getLocale() === 'zh' ? '◇ 离线 · 战绩未归档' : '◇ OFFLINE · NOT ARCHIVED')}
                    </span>
                  )}
                  {/* 语义色随判定走: 失败时"评估归档"不该是就绪绿 */}
                  <span className={`ml-auto ${win ? 'crt-ready' : 'crt-warn'}`}>◆ ASSESSMENT FILED</span>
                </div>

                {/* 条码 / 序列号尾部 */}
                <div className="mt-3 flex flex-wrap items-end justify-between gap-3 border-t pt-2.5" style={{ borderColor: 'var(--crt-line)' }}>
                  <span className="tp-barcode h-7 w-40 opacity-70" />
                  <span className="crt-label min-w-0">SN 007-1986-A · DEB-{win ? 'OK' : 'NG'} · ORDNANCE EXPENDED</span>
                </div>
                <div className="crt-label mt-1 flex flex-wrap items-center justify-between gap-2">
                  <span className="crt-warn">⚠ {win ? 'RECOVER AIRFRAME BEFORE NEXT SORTIE' : 'AIRFRAME LOST · NEXT OF KIN NOTIFIED'}</span>
                  <span className="tp-hazard h-2.5 w-20" />
                </div>
              </div>
            </div>

            <div className="mt-3 flex justify-center">
              <button
                onClick={onContinue}
                className="crt-key crt-corner w-full max-w-sm px-6 py-3 text-[0.75rem] font-bold tracking-[0.3em] hover:border-[var(--crt-amber-hi)] hover:text-[color:var(--crt-amber-hi)] focus-visible:outline focus-visible:outline-1"
                style={{ outlineColor: 'var(--crt-line-strong)' }}
              >
                ▶ {t('res.continue')}
              </button>
            </div>
          </div>
        </div>

        {/* 底部提示行 */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-1.5" style={{ borderColor: 'var(--crt-line)' }}>
          <span className="crt-label">ENTER CONTINUE</span>
          <span className={'crt-label ' + (win ? 'crt-ready' : 'crt-warn')}>■ {win ? 'MISSION COMPLETE' : 'MISSION FAILED'}</span>
          <span className="tp-hazard h-2.5 w-14" />
          <span className="crt-label ml-auto whitespace-nowrap">SN 007-1986-A · MADE IN THE BUNKER</span>
        </div>
      </div>

      {/* ===== CRT 叠加层(纯装饰) ===== */}
      <div className="crt-scanlines pointer-events-none absolute inset-0 z-40 opacity-80" />
      <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden">
        <div className="tp-tracking h-[16%] w-full" />
      </div>
      <div className="crt-vignette pointer-events-none absolute inset-0 z-40" />
    </div>
  );
}

export function LoadingScreen({ text }: { text: string }) {
  const t = useT();
  // === Animated progress bar (per user request: 关卡读条卡住进不去) ===
  // Previously a static 40% width div — looked identical whether the engine
  // was actually loading or had hung. Now we drive a real progress bar with
  // a phase indicator that cycles through the actual loading stages so the
  // user can see WHAT is happening (not just that something is).
  const [progress, setProgress] = useState(0);
  const [stageIdx, setStageIdx] = useState(0);
  const stages = [
    '正在初始化作战系统',
    '正在加载机体模型',
    '正在生成地形',
    '正在部署单位',
    '正在准备任务',
  ];
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let p = 0;
    let sIdx = 0;
    let lastStageBump = performance.now();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      // Progress grows quickly to ~85% then slows — never reaches 100% here
      // (the actual completion is the engine calling onReady which switches
      // the phase to 'playing' and unmounts this component).
      if (p < 85) {
        // First 60% in ~0.6s (fast initial), then slow crawl to 85% over ~3s
        const rate = p < 60 ? 100 : 8;
        p = Math.min(85, p + rate * dt);
        setProgress(p);
      }
      // Cycle stage label every ~700ms so the user sees activity
      if (now - lastStageBump > 700) {
        sIdx = (sIdx + 1) % stages.length;
        setStageIdx(sIdx);
        lastStageBump = now;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="crt-frame crt-flicker relative h-full w-full select-none overflow-hidden crt-font" style={{ background: 'var(--crt-bg)' }}>
      {/* 显像管余晖 */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'linear-gradient(180deg, rgba(255,176,0,0.05) 0%, rgba(0,0,0,0) 16%, rgba(0,0,0,0) 84%, rgba(255,176,0,0.03) 100%), radial-gradient(120% 80% at 50% 50%, rgba(255,176,0,0.035) 0%, rgba(0,0,0,0) 60%)',
          boxShadow: CRT_PWR_GLOW,
        }}
      />

      <div className="relative z-10 flex h-full w-full flex-col">
        {/* 终端抬头条 */}
        <div
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-2.5 py-1.5"
          style={{ borderColor: 'var(--crt-line-strong)', background: 'linear-gradient(180deg, rgba(31,22,8,0.9) 0%, rgba(10,6,1,0.9) 100%)' }}
        >
          <span className="crt-data crt-text--hi crt-text--glow tracking-[0.3em]">POST</span>
          <span className="crt-label hidden sm:inline">· TAC-OS 3.11 · POWER-ON SELF-TEST</span>
          <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="crt-label">NO FAULTS LOGGED</span>
            <span className="flex items-center gap-1.5">
              <span className="tp-led animate-tp-rec h-2 w-2" style={{ color: 'var(--crt-red)' }} />
              <span className="crt-label crt-warn">BUSY</span>
            </span>
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
          <div className="mx-auto flex min-h-full w-full max-w-[560px] flex-col justify-center">
            <div className="crt-panel crt-corner">
              <div className="crt-panel-head flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5">
                <span className="crt-label crt-text--hi tracking-[0.26em]">{t('loading.init')}</span>
                <span className="crt-label truncate">TAPE 1 · SIDE A</span>
              </div>
              <div className="p-3">
                {/* 终端读数行(装饰) */}
                <div className="crt-label flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="crt-text--hi">▸ POST SEQ 07/12</span>
                  <span>MEM CHECK · OK</span>
                  <span>BUS · OK</span>
                  {/* 阶段 5: 打字机光标 —— 自检还在继续输出 */}
                  <span className="crt-caret" />
                </div>
                <span
                  className="mt-1.5 block h-[6px] w-full"
                  style={{ backgroundImage: 'repeating-linear-gradient(90deg, var(--crt-amber-deep) 0 1px, transparent 1px 9px), repeating-linear-gradient(90deg, var(--crt-amber) 0 1px, transparent 1px 45px)', opacity: 0.75 }}
                />

                {/* 载入读数:百分比 + 分段进度条 */}
                <div className="mt-2.5 flex items-baseline justify-between gap-2">
                  <span className="crt-label">{t('loading.standby')}</span>
                  <span className="crt-data crt-text--hi crt-text--glow-strong text-base font-bold">{String(Math.floor(progress)).padStart(2, '0')}%</span>
                </div>
                <div className="mt-1 flex gap-[2px]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(progress)}>
                  {Array.from({ length: 24 }).map((_, i) => {
                    const on = (i + 1) * (100 / 24) <= progress;
                    return (
                      <span
                        key={i}
                        className="h-3.5 flex-1 transition-colors duration-150 ease-linear"
                        style={{
                          background: on ? 'var(--crt-amber)' : 'var(--crt-amber-ghost)',
                          boxShadow: on ? '0 0 5px rgba(255,176,0,0.5)' : undefined,
                        }}
                      />
                    );
                  })}
                </div>

                {/* 自检行:完成=琥珀(进度), 当前=高亮琥珀, 未到=暗。
                    刻意不用绿色 —— 绿色是"就绪/通过"这一整体判定的语义,
                    逐条进度用绿色会让"全绿"失去意义(见设计系统约束)。 */}
                <div className="mt-3 flex flex-col gap-1">
                  {stages.map((s, i) => (
                    <div key={s} className="flex items-center gap-2">
                      <span
                        className={`tp-led h-1.5 w-1.5 ${i < stageIdx ? '' : i === stageIdx ? 'animate-tp-breathe' : 'tp-led--off'}`}
                        style={{ color: i < stageIdx ? 'var(--crt-amber)' : 'var(--crt-amber-bright)' }}
                      />
                      <span className={`crt-label ${i === stageIdx ? 'crt-text--hi' : i < stageIdx ? 'crt-text' : 'crt-text--dim'}`}>
                        {i < stageIdx ? '■' : i === stageIdx ? '▶' : '□'} {s}{i === stageIdx ? '…' : ''}
                      </span>
                    </div>
                  ))}
                </div>

                {/* 主提示(保留 text 作为首要提示语) */}
                <div className="mt-3 border-t pt-2" style={{ borderColor: 'var(--crt-line)' }}>
                  <div className="crt-data crt-text--hi crt-text--glow">{text}</div>
                  <div className="crt-label mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span>DO NOT POWER OFF</span>
                    <span className="tp-hazard ml-auto h-2.5 w-16" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 底部提示行 */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-1.5" style={{ borderColor: 'var(--crt-line)' }}>
          <span className="crt-label">PLEASE STAND BY</span>
          <span className="crt-label">POST 07/12</span>
          <span className="crt-warn crt-label">⚠ DO NOT ERASE</span>
          <span className="crt-label ml-auto whitespace-nowrap">SN 007-1986-A · MADE IN THE BUNKER</span>
        </div>
      </div>

      {/* ===== CRT 叠加层(纯装饰) ===== */}
      <div className="crt-scanlines pointer-events-none absolute inset-0 z-40 opacity-80" />
      <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden">
        <div className="tp-tracking h-[16%] w-full" />
      </div>
      <div className="crt-vignette pointer-events-none absolute inset-0 z-40" />
    </div>
  );
}
