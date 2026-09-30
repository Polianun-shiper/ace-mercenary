'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { HangarViewer } from '@/lib/game/hangar';
// === 视野球默认偏移(与引擎同一份常量, 机库滑杆的缺省值) ===
import { CAM_BALL_DEFAULT } from '@/lib/game/camera-rig';
import { PLAYER_AIRCRAFT, PAINT_SCHEMES, paintColor, aircraftNameZh, getPlayerSpec } from '@/lib/game/aircraft-catalog';
import type { AircraftModel, AircraftCategory, AircraftSpec } from '@/lib/game/types';

// Persisted player aircraft selection — read by the Briefing screen and the
// GameEngine constructor. localStorage so it survives across sessions.
const PLAYER_MODEL_KEY = 'skybound.playerModel';
const PLAYER_PAINT_KEY = 'skybound.playerPaint';

export function getPlayerModelSelection(): { model: AircraftModel; paint: string } {
  if (typeof window === 'undefined') return { model: 'f16', paint: 'standard' };
  const model = (window.localStorage.getItem(PLAYER_MODEL_KEY) as AircraftModel | null) ?? 'f16';
  const paint = window.localStorage.getItem(PLAYER_PAINT_KEY) ?? 'standard';
  return { model, paint };
}

export function setPlayerModelSelection(model: AircraftModel, paint: string) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(PLAYER_MODEL_KEY, model);
  window.localStorage.setItem(PLAYER_PAINT_KEY, paint);
}

// Category labels for the side-panel filter.
const CATEGORY_LABELS: Record<AircraftCategory | 'all', string> = {
  all: '全部',
  fighter: '战斗机',
  attack: '攻击机',
  bomber: '轰炸机',
  ew: '电子战',
  gunship: '炮艇机',
  stealth: '隐身机',
  awacs: '预警机',
};

// Category color accents for the model button + role badge.
// AMBER CRT design system: monochrome amber only — category distinction is
// carried by the text label, not by hue.
const CATEGORY_COLORS: Record<AircraftCategory, string> = {
  fighter: 'var(--crt-amber)',
  attack: 'var(--crt-amber)',
  bomber: 'var(--crt-amber)',
  ew: 'var(--crt-amber)',
  gunship: 'var(--crt-amber)',
  stealth: 'var(--crt-amber)',
  awacs: 'var(--crt-amber)',
};

// Per-model spec sheet for the bottom panel.
const MODEL_STATS: Record<AircraftModel, { speed: string; armament: string; length: string; wingspan: string; role: string }> = {
  f16:   { speed: '2,120 km/h (马赫 2.0)', armament: 'M61A2 · AIM-9X · AIM-120 · AGM-65', length: '15.03 m', wingspan: '9.96 m',  role: '多用途战斗机' },
  f16c:  { speed: '2,120 km/h (马赫 2.0)', armament: 'M61A2 · AIM-9X · AIM-120 · AGM-65', length: '15.03 m', wingspan: '9.96 m',  role: '多用途战斗机 · 真实模型' },
  'f16-test': { speed: '2,120 km/h (马赫 2.0)', armament: '可动舵面测试平台', length: '15.03 m', wingspan: '9.96 m', role: '实验机 · 可动舵面' },
  f15:   { speed: '2,660 km/h (马赫 2.5)', armament: 'M61A1 · AIM-120 · AIM-9 · GBU-12', length: '19.43 m', wingspan: '13.05 m', role: '制空战斗机' },
  su35:  { speed: '2,400 km/h (马赫 2.25)', armament: 'GSh-30-1 · R-77 · R-73 · Kh-31', length: '21.9 m',  wingspan: '15.3 m',  role: '重型战斗机' },
  a10:   { speed: '706 km/h (马赫 0.56)',   armament: 'GAU-8/A 30mm · AGM-65 · AIM-9',  length: '16.26 m', wingspan: '17.53 m', role: '近距离支援' },
  b52:   { speed: '1,047 km/h (马赫 0.86)', armament: '31,500 kg 载弹 · CRA',            length: '48.5 m',  wingspan: '56.4 m',  role: '战略轰炸机' },
  ea18g: { speed: '1,900 km/h (马赫 1.8)',  armament: 'ALQ-99 · ALQ-218 · AGM-88 哈姆',  length: '17.07 m', wingspan: '11.43 m', role: '电子战机' },
  ac130: { speed: '671 km/h (马赫 0.54)',   armament: '105mm M137 · 40mm 博福斯 · 25mm GAU-12', length: '29.8 m', wingspan: '40.4 m', role: '重型炮艇机' },
  f117:  { speed: '993 km/h (马赫 0.92)',   armament: 'GBU-27 · GBU-10 · BLU-109（内置弹舱）', length: '20.08 m', wingspan: '13.2 m', role: '隐身打击' },
  e3:    { speed: '853 km/h (马赫 0.7)',    armament: 'AN/APY-2 雷达 · 无（指挥平台）',   length: '46.6 m', wingspan: '44.4 m', role: '预警指挥机' },
  tu95:  { speed: '920 km/h (马赫 0.77)',   armament: 'Kh-101 巡航导弹 · 12,000 kg',     length: '49.5 m', wingspan: '51.1 m', role: '涡桨轰炸机（敌方）' },
  mig29: { speed: '2,400 km/h (马赫 2.25)', armament: 'GSh-30-1 · R-27 · R-73 · R-60',    length: '17.32 m', wingspan: '11.36 m', role: '制空战斗机 · 真实模型' },
};

// Capability badge — rendered next to the spec sheet.
function capabilityBadges(spec: AircraftSpec): { label: string; color: string }[] {
  const badges: { label: string; color: string }[] = [];
  // 这里以前直接读 spec.abilities —— spec 为 undefined 时抛异常把整个机库
  // 卸载成黑屏(见下面 getPlayerSpec 的注释)。abilities 本身也给个空对象兜底:
  // 以后新增机型忘了写 abilities 字段也不会再黑屏,只是不显示徽章。
  const ab = spec?.abilities ?? ({} as AircraftSpec['abilities']);
  if (ab.jammer) badges.push({ label: '干扰机', color: 'var(--crt-amber-dim)' });
  if (ab.sideCannon) badges.push({ label: '侧炮', color: 'var(--crt-amber-dim)' });
  if (ab.stealth) badges.push({ label: '隐身', color: 'var(--crt-amber)' });
  if (ab.awacs) badges.push({ label: '预警雷达', color: 'var(--crt-amber)' });
  // Always show HP and TOP SPEED.
  return badges;
}

export function Hangar({ onBack }: { onBack: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<HangarViewer | null>(null);
  const [filter, setFilter] = useState<AircraftCategory | 'all'>('all');
  const [model, setModel] = useState<AircraftModel>('f16');
  const [paint, setPaint] = useState<'standard' | 'stealth' | 'aggressor' | 'camo'>('standard');
  const [afterburner, setAfterburner] = useState(false);
  const [autoRotate, setAutoRotate] = useState(true);
  const [loading, setLoading] = useState(true);
  // === 机库内提示条 (per user request: 分段加载 / MiG-29 需 http) ===
  // 短暂显示在卡片区上方:MiG-29 按需加载中,或基础单文件(file://)下提示
  // MiG-29 需要 http 服务器访问外部资产库。
  const [notice, setNotice] = useState<string | null>(null);
  // === Camera frame-centre adjustment (per user request: 机库调视野中心) ===
  // Two independent 3D view-centre offsets — the NEW mouse-aim camera and the
  // TRADITIONAL chase camera — tuned here in the hangar, auto-saved, applied
  // by the engine's camera-rig on the next mission. The hangar viewer live-
  // previews the active offset with a marker ball at the view centre.
  const readCamCenter = (key: string): { x: number; y: number; z: number } => {
    // 没存过值时用**引擎的默认值**(鼠标操控模式的视野球默认偏移), 否则机库一打开就会
    // 把 {0,0,0} 当成"当前值"回写(见下面的 auto-save), 把引擎默认值悄悄抹掉 ——
    // 用户看到的就是"默认偏移失效"。传统相机(camCenterOld)的默认仍是 {0,0,0}。
    const dflt = key === 'skybound.camCenterNew' ? CAM_BALL_DEFAULT : { x: 0, y: 0, z: 0 };
    if (typeof window === 'undefined') return { ...dflt };
    try {
      const o = JSON.parse(window.localStorage.getItem(key) ?? 'null');
      if (o && typeof o.x === 'number' && typeof o.y === 'number') {
        return {
          x: Math.max(-25, Math.min(25, o.x)),
          y: Math.max(-25, Math.min(25, o.y)),
          z: Math.max(-25, Math.min(25, typeof o.z === 'number' ? o.z : 0)),
        };
      }
    } catch { /* ignore */ }
    return { ...dflt };
  };
  const [camTarget, setCamTarget] = useState<'new' | 'old'>('new');
  const [camNew, setCamNew] = useState<{ x: number; y: number; z: number }>(() => readCamCenter('skybound.camCenterNew'));
  const [camOld, setCamOld] = useState<{ x: number; y: number; z: number }>(() => readCamCenter('skybound.camCenterOld'));
  const activeCam = camTarget === 'new' ? camNew : camOld;
  // Auto-save whenever the tuned offsets change (belt + suspenders — the
  // nudge buttons also save, this covers every path).
  // ⚠️ 首次挂载**不写**: 那时 camNew/camOld 只是"读出来的初始值", 写下去等于把
  // 默认值固化成存档(而且会把引擎默认的视野球偏移覆盖成 0)。只有用户真的调过才写。
  const camSavedOnce = useRef(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!camSavedOnce.current) { camSavedOnce.current = true; return; }
    window.localStorage.setItem('skybound.camCenterNew', JSON.stringify(camNew));
    window.localStorage.setItem('skybound.camCenterOld', JSON.stringify(camOld));
  }, [camNew, camOld]);
  // Live preview — push the active offset into the hangar viewer. The NEW
  // mouse-aim camera uses a WORLD-fixed ball (x/y/z world units, only the
  // position follows the aircraft); the traditional camera uses a camera-
  // frame screen offset.
  useEffect(() => {
    viewerRef.current?.setFrameCenter(activeCam.x, activeCam.y, activeCam.z, camTarget === 'new');
  }, [activeCam.x, activeCam.y, activeCam.z, camTarget]);
  const nudgeCam = (dx: number, dy: number, dz = 0) => {
    const key = camTarget === 'new' ? 'skybound.camCenterNew' : 'skybound.camCenterOld';
    const next = {
      x: Math.max(-25, Math.min(25, activeCam.x + dx)),
      y: Math.max(-25, Math.min(25, activeCam.y + dy)),
      z: Math.max(-25, Math.min(25, activeCam.z + dz)),
    };
    if (camTarget === 'new') setCamNew(next);
    else setCamOld(next);
    if (typeof window !== 'undefined') window.localStorage.setItem(key, JSON.stringify(next));
  };

  // Restore persisted selection on mount.
  useEffect(() => {
    const sel = getPlayerModelSelection();
    setModel(sel.model);
    setPaint(sel.paint as 'standard' | 'stealth' | 'aggressor' | 'camo');
  }, []);

  // === 机库黑屏的真凶 (per user request: 修复机库黑屏) ====================
  // PLAYER_AIRCRAFT 里已经**没有 'f16' 这条**,而机库默认 model 仍是 'f16'
  // (localStorage 里存的也可能是老的 'f16')——原来的 `find(...)!` 直接返回
  // undefined,紧接着 capabilityBadges(spec) 读 spec.abilities 在 useMemo 里抛
  // 异常,React 卸载整个机库: 屏幕全黑、连 <canvas> 都不存在。
  // 改用引擎同一份 getPlayerSpec(): 任何 model 都必然返回一条 spec。
  const spec = useMemo(() => getPlayerSpec(model), [model]);
  // 老存档/异常 model 下 MODEL_STATS 也可能查不到(下面要读 stats.role)。
  const stats = useMemo(() => MODEL_STATS[model] ?? MODEL_STATS.f16, [model]);
  const badges = useMemo(() => capabilityBadges(spec), [spec]);

  // Persist selection whenever it changes.
  useEffect(() => {
    setPlayerModelSelection(model, paint);
  }, [model, paint]);

  // Filtered list — show only aircraft matching the active category filter.
  const visibleSpecs = useMemo(() => {
    if (filter === 'all') return PLAYER_AIRCRAFT;
    return PLAYER_AIRCRAFT.filter((s) => s.category === filter);
  }, [filter]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const v = new HangarViewer(canvas);
    viewerRef.current = v;
    // === Safety timeout (per user request: 机库模型加载不出来) ===
    // If init() hasn't completed within 5 seconds (shouldn't happen now that
    // OBJ loading is disabled, but defensive), force-hide the loading overlay
    // so the user can still interact with the hangar instead of being stuck.
    let safetyTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      console.warn('[Hangar] init() timed out after 5s — force-hiding loading overlay');
      setLoading(false);
    }, 5000);
    v.init().then(() => {
      if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
      const initial = getPlayerModelSelection();
      const spec0 = getPlayerSpec(initial.model);
      // 这里的 show 只是"先把机体摆上去"(避免 loading 覆盖层下面空一拍);
      // 紧接着下面那个 effect(loading=false 后触发)会用重新取的模型包装再 show 一次。
      void v.show(initial.model, paintColor(initial.paint, spec0.category), false);
      v.setAutoRotate(true);
      setLoading(false);
    }).catch((err) => {
      console.error('[Hangar] init() rejected:', err);
      if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
      // Force-hide on error too — don't leave the user stuck.
      setLoading(false);
    });
    const onResize = () => v.resize();
    window.addEventListener('resize', onResize);
    return () => {
      if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
      window.removeEventListener('resize', onResize);
      v.detach();
      viewerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = viewerRef.current;
    if (!v || loading) return;
    let cancelled = false;
    // === MiG-29 按需加载 (per user request: 分段加载) ===
    // 资产在外部库 assets-mig29/,首次点卡片才 fetch。file:// 下浏览器禁
    // fetch 外部文件 → ensureMig29 失败 → 提示需要 http 并回退 F-16。
    if (model === 'mig29') {
      setNotice('加载 MiG-29 模型…');
      v.ensureMig29().then((ok) => {
        if (cancelled) return;
        if (ok) {
          setNotice(null);
          void v.show(model, paintColor(paint, spec.category), afterburner).then(() => {
            if (!cancelled) v.setAutoRotate(autoRotate);
          });
        } else {
          setNotice('⚠ MiG-29 需要 http 服务器访问（资产在 assets-mig29 外部库）');
          setModel('f16');
        }
      });
      return () => { cancelled = true; };
    }
    // show() 现在要 await: 多材质模型(F-16C/MiG-29)每次 show 都会重新取一份
    // Mesh 包装(上一次 show 已经把那份 children 搬进场景了), 不 await 会拿到旧的。
    void v.show(model, paintColor(paint, spec.category), afterburner).then(() => {
      if (!cancelled) v.setAutoRotate(autoRotate);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, paint, afterburner, loading, spec.category]);

  useEffect(() => {
    viewerRef.current?.setAutoRotate(autoRotate);
  }, [autoRotate]);

  return (
    <div className="relative w-full h-full overflow-hidden bg-black">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 z-10 p-4 flex items-center justify-between font-mono">
        <button onClick={onBack} className="text-[var(--crt-amber-dim)] hover:text-[var(--crt-amber-hi)] text-sm tracking-widest">
          ◀ 退出机库
        </button>
        <div className="text-[var(--crt-amber)] tracking-[0.4em] text-sm" style={{ textShadow: '0 0 12px rgba(255,176,0,0.5)' }}>
          ◆ 战机机库 ◆
        </div>
        <div className="w-32 text-right">
          <span className="text-[0.625rem] text-[var(--crt-amber-dim)] tracking-widest">{visibleSpecs.length} / {PLAYER_AIRCRAFT.length} 机型</span>
        </div>
      </div>

      {/* 机库提示条 (MiG-29 按需加载 / 需 http 提示) */}
      {notice && (
        <div className="absolute left-1/2 top-16 -translate-x-1/2 z-20 px-4 py-1.5 text-[11px] tracking-widest font-mono border border-[var(--crt-line)] bg-black/70 text-[var(--crt-amber-hi)]">
          {notice}
        </div>
      )}

      {/* Loading overlay */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-20 font-mono">
          <div className="text-center">
            <div className="text-[var(--crt-amber)] tracking-widest animate-pulse mb-2">正在加载模型</div>
            <div className="text-[var(--crt-amber-dim)] text-xs">正在初始化几何数据…</div>
          </div>
        </div>
      )}

      {/* Side panel: category filter + model select */}
      <div className="absolute left-0 top-1/2 -translate-y-1/2 z-10 p-4 font-mono">
        <div className="bg-black/40 border border-[var(--crt-amber-deep)] p-3 space-y-2 max-h-[85vh] overflow-y-auto" style={{ minWidth: '15rem' }}>
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1">类别</div>
          <div className="grid grid-cols-2 gap-1 mb-2">
            {(['all', 'fighter', 'attack', 'bomber', 'ew', 'gunship', 'stealth', 'awacs'] as const).map((c) => (
              <button
                key={c}
                onClick={() => setFilter(c)}
                className={`px-2 py-1 text-[0.625rem] border tracking-wider ${filter === c ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
              >
                {CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1">选择机型</div>
          {visibleSpecs.map((s) => {
            const accent = CATEGORY_COLORS[s.category];
            const isActive = model === s.model;
            return (
              <button
                key={s.id}
                onClick={() => setModel(s.model)}
                className={`block w-full text-left px-3 py-2 border ${isActive ? 'text-[var(--crt-amber-hi)]' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
                style={isActive ? { borderColor: accent, background: `color-mix(in srgb, ${accent} 10%, transparent)` } : undefined}
              >
                <div className="text-sm tracking-widest" style={isActive ? { color: accent } : undefined}>{aircraftNameZh(s)}</div>
                <div className="text-[0.625rem] opacity-70">{MODEL_STATS[s.model].role}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right panel: paint + options + capability badges */}
      <div className="absolute right-0 top-1/2 -translate-y-1/2 z-10 p-4 font-mono">
        <div className="bg-black/40 border border-[var(--crt-amber-deep)] p-4 space-y-3" style={{ minWidth: '14rem' }}>
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1">涂装</div>
          <div className="grid grid-cols-2 gap-1">
            {(['standard', 'stealth', 'aggressor', 'camo'] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPaint(p)}
                className={`px-2 py-1 text-xs border ${paint === p ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
              >
                {{ standard: '标准', stealth: '隐身', aggressor: '侵略者', camo: '迷彩' }[p]}
              </button>
            ))}
          </div>

          {badges.length > 0 && (
            <>
              <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1 mt-3">特殊能力</div>
              <div className="space-y-1">
                {badges.map((b) => (
                  <div key={b.label} className="px-2 py-1 text-[0.625rem] border tracking-wider" style={{ borderColor: b.color, color: b.color, background: `color-mix(in srgb, ${b.color} 10%, transparent)` }}>
                    ◆ {b.label}
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1 mt-3">选项</div>
          <button
            onClick={() => setAfterburner(!afterburner)}
            className={`block w-full text-left px-3 py-2 text-xs border ${afterburner ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[rgba(255,176,0,0.10)]' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)]'}`}
          >
            加力燃烧室：{afterburner ? '开' : '关'}
          </button>
          <button
            onClick={() => setAutoRotate(!autoRotate)}
            className={`block w-full text-left px-3 py-2 text-xs border ${autoRotate ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)]'}`}
          >
            自动旋转：{autoRotate ? '开' : '关'}
          </button>

          {/* === Camera frame-centre adjustment (per user request: 机库调视野中心) === */}
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1 mt-3">相机视野中心</div>
          <div className="grid grid-cols-2 gap-1 mb-2">
            <button
              onClick={() => setCamTarget('new')}
              className={`px-2 py-1 text-[0.625rem] border ${camTarget === 'new' ? 'border-[var(--crt-amber-hi)] text-[var(--crt-amber-hi)] bg-[var(--crt-amber-hi)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              新相机(鼠标瞄准)
            </button>
            <button
              onClick={() => setCamTarget('old')}
              className={`px-2 py-1 text-[0.625rem] border ${camTarget === 'old' ? 'border-[var(--crt-amber-hi)] text-[var(--crt-amber-hi)] bg-[var(--crt-amber-hi)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              传统相机
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1" style={{ width: '7.5rem' }}>
            <span />
            <button onClick={() => nudgeCam(0, 1)} className="px-2 py-1 text-xs border border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/10">▲</button>
            <span />
            <button onClick={() => nudgeCam(-1, 0)} className="px-2 py-1 text-xs border border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/10">◀</button>
            <button onClick={() => nudgeCam(-activeCam.x, -activeCam.y, -activeCam.z)} className="px-2 py-1 text-xs border border-[var(--crt-red-dim)] text-[var(--crt-red)] hover:bg-[rgba(255,59,31,0.10)]">重置</button>
            <button onClick={() => nudgeCam(1, 0)} className="px-2 py-1 text-xs border border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/10">▶</button>
            <span />
            <button onClick={() => nudgeCam(0, -1)} className="px-2 py-1 text-xs border border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/10">▼</button>
            <span />
          </div>
          {/* Depth axis — world Z for the mouse-aim ball; zoom for the chase cam */}
          <div className="grid grid-cols-2 gap-1 mt-1" style={{ width: '7.5rem' }}>
            <button onClick={() => nudgeCam(0, 0, 1)} className="px-2 py-1 text-[0.625rem] border border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/10">Z+</button>
            <button onClick={() => nudgeCam(0, 0, -1)} className="px-2 py-1 text-[0.625rem] border border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/10">Z−</button>
          </div>
          <div className="text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
            X {activeCam.x.toFixed(1)} · Y {activeCam.y.toFixed(1)} · Z {activeCam.z.toFixed(1)} · 自动保存
          </div>
          <div className="text-[0.5625rem] text-[var(--crt-amber-dim)] mt-0.5">
            {camTarget === 'new' ? '青色小球 = 机体位置+x/y/z（世界固定，不随机体旋转）' : '青色小球 = 画面中心预览'}
          </div>

          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mt-2">拖动旋转 · 滚轮缩放</div>
        </div>
      </div>

      {/* Bottom: stats */}
      {stats && (
        <div className="absolute bottom-0 left-0 right-0 z-10 p-4 font-mono">
          <div className="bg-black/40 border border-[var(--crt-amber-deep)] p-4 max-w-3xl mx-auto">
            <div className="flex items-center justify-between mb-2">
              <div>
                <div className="text-2xl text-[var(--crt-amber-hi)] tracking-wide">{aircraftNameZh(spec)}</div>
                <div className="text-xs" style={{ color: CATEGORY_COLORS[spec.category] }}>{stats.role} · {CATEGORY_LABELS[spec.category]}</div>
              </div>
              <div className="text-xs text-[var(--crt-amber)]/70 tracking-widest">规格表</div>
            </div>
            <div className="grid grid-cols-4 gap-4 text-xs">
              <div>
                <div className="text-[var(--crt-amber-dim)]">极速</div>
                <div className="text-[var(--crt-amber-hi)]">{stats.speed}</div>
              </div>
              <div>
                <div className="text-[var(--crt-amber-dim)]">武器</div>
                <div className="text-[var(--crt-amber-hi)]">{stats.armament}</div>
              </div>
              <div>
                <div className="text-[var(--crt-amber-dim)]">机长</div>
                <div className="text-[var(--crt-amber-hi)]">{stats.length}</div>
              </div>
              <div>
                <div className="text-[var(--crt-amber-dim)]">翼展</div>
                <div className="text-[var(--crt-amber-hi)]">{stats.wingspan}</div>
              </div>
            </div>
            {/* Capability summary line */}
            <div className="mt-2 text-[0.625rem] text-[var(--crt-amber-dim)] tracking-wider">
              生命 {spec.hp} · 转向 {spec.turnRate.toFixed(2)} rad/s · 滚转 {spec.rollRate.toFixed(1)} rad/s · 重量 ×{spec.category === 'gunship' ? '3.0' : spec.category === 'bomber' ? '2.2' : spec.category === 'awacs' ? '2.5' : spec.category === 'attack' ? '1.5' : '1.0'}
              {badges.length > 0 && ' · 能力: ' + badges.map((b) => b.label).join(', ')}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
