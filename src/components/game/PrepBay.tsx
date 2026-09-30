'use client';

// ============================================================================
// PrepBay —— 剧情战役的【战斗准备】屏
// ============================================================================
// 为什么有这一屏(per user request): 剧情中枢的"战斗准备"以前直接跳去机库(Hangar),
// 而机库那一屏带着一堆跟"出击前配置"无关的东西(相机视野中心调节、规格表、加力/
// 自动旋转开关...)。玩家要的其实只有两件事:
//   ① 看得见机体(机库那套布景 + 灯光 + 模型) ② 选机型/涂装/僚机/天气/挂载。
// 于是本屏 = 机库的 3D 视口(直接复用 HangarViewer, 布景升级自动继承)
//        + Menus.tsx 里 Briefing 那一整套【选项面板】的拷贝, 其余一概不带
//          (不带任务简报正文/目标/环境数据面板, 也不带简报那个自转机体预览)。
//
// 【关键: 状态不重造】—— 下面每个选项的 localStorage 键与写法都与
// Menus.tsx 的 Briefing / Hangar.tsx 完全一致:
//   skybound.playerModel / playerPaint / wingmanModel / wingmenEnabled /
//   gunAim / weatherOverride / skybound.gunshipGuns / skybound.spWeapon /
//   skybound.loadout(+ sp-weapons.ts 里那几个 read/write 助手)
// 引擎与 GameApp 出击时读的就是这些键 —— 只要这里的值一样, 关内行为就一样,
// 所以这一屏绝不新造状态层(那才是真正的"两处真相"事故源)。
// ============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { HangarViewer } from '@/lib/game/hangar';
// 视野球默认偏移: 与机库/引擎共用同一份常量(不推给 viewer 的话, 机体的取景
// 会停在 {0,0,0}, 与关内实际取景差一个偏移)。
import { CAM_BALL_DEFAULT } from '@/lib/game/camera-rig';
import { getMission } from '@/lib/game/missions';
import { PLAYER_AIRCRAFT, aircraftNameZh, getPlayerSpec, paintColor } from '@/lib/game/aircraft-catalog';
import type { AircraftModel, AircraftCategory, WeaponType } from '@/lib/game/types';
import {
  SP_WEAPONS, readSPWeaponSelection, writeSPWeaponSelection,
  ALL_LOADABLE_WEAPONS, LOADOUT_SLOTS, readLoadout, writeLoadout,
  defaultLoadoutForCategory, getWeaponDisplay,
} from '@/lib/game/sp-weapons';
import { useT } from '@/hooks/use-i18n';
import { getLocale } from '@/lib/game/i18n';
import { GUNSHIP_GUNS, type GunshipGunId } from '@/lib/game/engine';
import { CATEGORY_ZH } from '@/lib/game/labels-zh';

// === 持久化助手(逐字对齐 Menus.tsx 的 Briefing / Hangar.tsx 的键名) ===
const PLAYER_MODEL_KEY = 'skybound.playerModel';
const PLAYER_PAINT_KEY = 'skybound.playerPaint';
// 僚机机型(按关覆盖; 'auto' = 用任务自带的僚机机型)。
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

function readWingmanSelection(): AircraftModel | 'auto' {
  if (typeof window === 'undefined') return 'auto';
  const v = window.localStorage.getItem(WINGMAN_MODEL_KEY);
  if (v === 'auto' || v === null) return 'auto';
  return v as AircraftModel;
}

function writeWingmanSelection(m: AircraftModel | 'auto') {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(WINGMAN_MODEL_KEY, m);
}

// === 视野中心(与机库 Hangar.tsx 同一套读法) ===
// 机库把"视野中心"调好的值自动存进 skybound.camCenterNew, 引擎用同一个键当
// 鼠标操控模式的视野球偏移。这里读出来推给 viewer, 3D 视口的取景才与关内一致。
function readCamCenterOffset(): { x: number; y: number; z: number } {
  if (typeof window === 'undefined') return { ...CAM_BALL_DEFAULT };
  try {
    const o = JSON.parse(window.localStorage.getItem('skybound.camCenterNew') ?? 'null') as
      { x?: number; y?: number; z?: number } | null;
    if (o && typeof o.x === 'number' && typeof o.y === 'number') {
      const clamp = (n: number) => Math.max(-25, Math.min(25, n));
      return { x: clamp(o.x), y: clamp(o.y), z: clamp(typeof o.z === 'number' ? o.z : 0) };
    }
  } catch { /* 坏存档就当没存过 */ }
  return { ...CAM_BALL_DEFAULT };
}

// === 琥珀单色设计系统: 类别不靠色相区分 ===
// 与 Menus/Hangar 一致 —— 单色终端里色相只承担语义(红=警告/绿=就绪), 类别区分
// 交给文字标签, 所以这里只有一个琥珀色常量, 不再逐类别配颜色。
const CATEGORY_ACCENT = 'var(--crt-amber)';

// 卡片角标(与 Briefing 同一套短码)。
const CATEGORY_CODE: Record<AircraftCategory, string> = {
  fighter: 'FTR', attack: 'ATK', bomber: 'BMR', ew: 'EW',
  gunship: 'GUN', stealth: 'STL', awacs: 'AWACS',
};

// 类别筛选行: 顺序与机库侧栏一致, 中文名复用 labels-zh 的 CATEGORY_ZH(不另抄一份)。
const FILTER_ORDER: (AircraftCategory | 'all')[] = ['all', 'fighter', 'attack', 'bomber', 'ew', 'gunship', 'stealth', 'awacs'];
const FILTER_EN: Record<AircraftCategory | 'all', string> = {
  all: 'ALL', fighter: 'FIGHTER', attack: 'ATTACK', bomber: 'BOMBER', ew: 'EW',
  gunship: 'GUNSHIP', stealth: 'STEALTH', awacs: 'AWACS',
};

type WeatherChoice = 'auto' | 'random' | 'clear' | 'cloudy' | 'rain' | 'storm' | 'fog' | 'snow';
const WEATHER_ORDER: WeatherChoice[] = ['auto', 'random', 'clear', 'cloudy', 'rain', 'storm', 'fog', 'snow'];

// === 释放 WebGL 上下文(卸载时) ===
// HangarViewer 只对外提供 detach()(停 RAF + 回收几何/材质/贴图), 渲染器本身没有
// 公开的释放入口。本屏是**频繁进出的菜单页**, 每进出一次就漏一个 WebGL 上下文,
// 几次之后浏览器开始丢上下文(表现为黑屏) —— 所以这里按运行时字段把 renderer 取
// 回来显式 dispose + forceContextLoss, 与 Results3D/StoryBrief 的清理方式一致。
// 安全性: 共享给 texture-manager 的那份 renderer 引用只用于 KTX2 能力探测, 而每次
// 出击都会 new GameEngine → 构造函数里重新 attachRenderer 换成当次的活渲染器,
// 所以在菜单里释放旧上下文不会影响之后的关卡。
type RendererLike = { dispose(): void; forceContextLoss?: () => void };
function disposeViewer(v: HangarViewer) {
  v.detach();
  const r = (v as unknown as { renderer?: RendererLike }).renderer;
  if (!r) return;
  try {
    r.dispose();
    r.forceContextLoss?.();
  } catch (err) {
    console.warn('[PrepBay] 释放渲染器失败:', err);
  }
}

export function PrepBay({ missionId, onBack, onLaunch }: { missionId: string; onBack: () => void; onLaunch: () => void }) {
  const t = useT();
  const zh = getLocale() === 'zh';
  // getMission 而不是 MISSIONS.find(...) —— 未知关卡 id 时返回 undefined 而不是
  // 让整屏炸掉(剧情中枢里 missionId 来自上一屏的选择, 但它可能是个老存档的 id)。
  const mission = useMemo(() => getMission(missionId), [missionId]);
  const codename = mission?.codename ?? missionId.toUpperCase();
  const recommended = mission?.recommendedCategories ?? [];

  // ---- 机型 / 涂装 ----
  const [sel, setSel] = useState<{ model: AircraftModel; paint: string }>(() => readSelection());
  const [filter, setFilter] = useState<AircraftCategory | 'all'>('all');
  // ---- 僚机 ----
  const [wingmanModel, setWingmanModel] = useState<AircraftModel | 'auto'>(() => readWingmanSelection());
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
  // ---- 机炮瞄准 ----
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
  // ---- 任务天气 ----
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
  // ---- 挂载: 4 槽 ----
  // 读存档; 没存过就用当前机型的类别默认挂载(与 Briefing 同一条路径)。
  // 这里放在 useState 的惰性初值里而不是放到 effect 里回填 —— 初值在浏览器首帧
  // 就拿到了, effect 里 setState 只会白白多一次级联渲染。
  const [loadout, setLoadout] = useState<WeaponType[]>(
    () => readLoadout() ?? defaultLoadoutForCategory(getPlayerSpec(sel.model).category),
  );
  // 4 槽改成"标签页 + 当前槽的武器按钮"(本屏右侧是窄栏, 4 个槽同时铺开会高到离谱)。
  const [activeSlot, setActiveSlot] = useState(0);
  // ---- 炮艇机侧炮 / 电子战机 SP 武器(这两类不走 4 槽, 保持 Briefing 的原有配置方式) ----
  const [gunshipGuns, setGunshipGuns] = useState<GunshipGunId[]>(() => {
    if (typeof window === 'undefined') return ['g25', 'g40', 'g105', 'laser'];
    try {
      const raw = window.localStorage.getItem('skybound.gunshipGuns');
      if (raw) {
        const arr = JSON.parse(raw) as unknown;
        if (Array.isArray(arr)) {
          const valid = arr.filter((x) => x === 'g25' || x === 'g40' || x === 'g105' || x === 'laser') as GunshipGunId[];
          if (valid.length > 0) return valid;
        }
      }
    } catch { /* 坏存档回落到默认 */ }
    // 老键(单口径)兼容。
    const v = window.localStorage.getItem('skybound.gunshipGun');
    return v === 'g25' || v === 'g40' || v === 'g105' ? [v] : ['g25', 'g40', 'g105', 'laser'];
  });
  const toggleGun = (id: GunshipGunId) => {
    setGunshipGuns((prev) => {
      const has = prev.includes(id);
      const next = has ? prev.filter((g) => g !== id) : [...prev, id];
      return next.length > 0 ? next : prev; // 至少留一门
    });
  };
  const [spWeapon, setSpWeapon] = useState<WeaponType | 'none'>(() => readSPWeaponSelection());

  // ---- 3D 视口 ----
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<HangarViewer | null>(null);
  const [loading, setLoading] = useState(true);
  // MiG-29 是外部资产库(按需加载), file:// 下会失败 —— 提示条就为这个存在。
  const [notice, setNotice] = useState<string | null>(null);

  // 每次改动写回同一个键(引擎/GameApp 就靠这些键拿配置)。
  useEffect(() => { writeSelection(sel.model, sel.paint); }, [sel.model, sel.paint]);
  useEffect(() => { writeWingmanSelection(wingmanModel); }, [wingmanModel]);
  useEffect(() => { writeSPWeaponSelection(spWeapon); }, [spWeapon]);
  useEffect(() => { writeLoadout(loadout); }, [loadout]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem('skybound.gunshipGuns', JSON.stringify(gunshipGuns));
    } catch { /* 隐私模式下写不进去也无所谓 */ }
  }, [gunshipGuns]);

  // 机型资料: 用引擎同一份 getPlayerSpec() —— 老存档里可能存着已下架的机型名
  // (比如 PLAYER_AIRCRAFT 里已经没有 'f16' 这条了), 直接 find(...)! 会拿到
  // undefined 并在下面读字段时抛异常, 把整屏卸载成黑屏(机库踩过这个坑)。
  const spec = useMemo(() => getPlayerSpec(sel.model), [sel.model]);
  // 高亮用"解析后的机型": 老存档的 'f16' 在目录里对应 f16c 那张卡。
  const activeModel = spec.model;

  const visibleSpecs = useMemo(() => {
    if (filter === 'all') return PLAYER_AIRCRAFT;
    return PLAYER_AIRCRAFT.filter((s) => s.category === filter);
  }, [filter]);

  // ---- 3D: 挂载 / 拆卸 ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const v = new HangarViewer(canvas);
    viewerRef.current = v;
    // 兜底(与机库同): init() 卡住时别让加载遮罩永远盖着视口。
    let safetyTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      console.warn('[PrepBay] HangarViewer.init() 超时 5s - 强行收起加载遮罩');
      setLoading(false);
    }, 5000);
    v.init().then(() => {
      if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
      const fc = readCamCenterOffset();
      v.setFrameCenter(fc.x, fc.y, fc.z, true);
      // 机库里那颗"视野中心"青色小球是给玩家调偏移用的辅助标记(它旁边还有一整
      // 块调节面板), 本屏没有那个功能, 留着就只是一个飘在机体上的青色球 -> 藏掉。
      // 注意只藏球, 不放弃 setFrameCenter(): 取景(相机绕视野中心)仍要与关内一致。
      const marker = (v as unknown as { centreBall?: { visible: boolean } }).centreBall;
      if (marker) marker.visible = false;
      // 先摆一次机体, 且**等它真的进场景**再收起加载遮罩 —— 否则重机型(F-16C
      // 真实模型)还在解析时遮罩就已经撤掉, 玩家看到的是几秒空机棚。
      const initial = readSelection();
      return v.show(initial.model, paintColor(initial.paint, getPlayerSpec(initial.model).category), false).then(() => {
        v.setAutoRotate(true);
        setLoading(false);
      });
    }).catch((err) => {
      console.error('[PrepBay] HangarViewer.init() 失败:', err);
      if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
      setLoading(false);
    });
    const onResize = () => v.resize();
    window.addEventListener('resize', onResize);
    // 这里的画布是分栏里的一块面板而不是整屏: 窄屏堆叠时窗口尺寸可能没变, 但
    // 面板尺寸变了 —— 只听 window resize 会让渲染尺寸和面板对不上(画面拉花)。
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    ro?.observe(canvas);
    return () => {
      if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
      ro?.disconnect();
      window.removeEventListener('resize', onResize);
      disposeViewer(v);
      viewerRef.current = null;
    };
  }, []);

  // ---- 3D: 选择变化 -> 换机体/涂装 ----
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || loading) return;
    let cancelled = false;
    // MiG-29 的资产在外部库, 首次选中才按需 fetch; file:// 下会失败 -> 提示需要
    // http 并回退到默认机, 而不是留一个空视口。
    // 注意: 提示只在 promise 回调里 setState(effect 体内同步 setState 会多一轮
    // 级联渲染, 且规则禁止); 加载期间靠下方 3D 视口的机型名读数给反馈。
    if (sel.model === 'mig29') {
      v.ensureMig29().then((ok) => {
        if (cancelled) return;
        if (ok) {
          setNotice(null);
          void v.show('mig29', paintColor(sel.paint, spec.category), false);
        } else {
          setNotice('MiG-29 需要 http 服务器访问（资产在 assets-mig29 外部库）');
          setSel((p) => ({ ...p, model: 'f16c' }));
        }
      });
      return () => { cancelled = true; };
    }
    // show() 要 await: 多材质真实模型(F-16C/MiG-29)每次 show 都会重新取一份 Mesh
    // 包装(上一次 show 已经把那份 children 搬进场景了)。
    void v.show(sel.model, paintColor(sel.paint, spec.category), false);
    return () => { cancelled = true; };
  }, [sel.model, sel.paint, loading, spec.category]);

  const paintChoices = ['standard', 'stealth', 'aggressor', 'camo'] as const;
  const slotWeapon = loadout[activeSlot] ?? 'MSL';

  return (
    <div className="crt-frame crt-flicker relative h-full w-full select-none overflow-hidden crt-font" style={{ background: 'var(--crt-bg)' }}>
      {/* 显像管余晖 */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'linear-gradient(180deg, rgba(255,176,0,0.05) 0%, rgba(0,0,0,0) 16%, rgba(0,0,0,0) 84%, rgba(255,176,0,0.03) 100%), radial-gradient(120% 80% at 50% 50%, rgba(255,176,0,0.035) 0%, rgba(0,0,0,0) 60%)',
          boxShadow: '0 0 60px rgba(255,176,0,0.055), 0 0 200px rgba(255,176,0,0.02)',
        }}
      />

      <div className="relative z-10 flex h-full w-full flex-col">
        {/* 抬头条: 返回 + 标题 + 任务代号 + 出击 */}
        <div
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-2.5 py-1.5"
          style={{ borderColor: 'var(--crt-line-strong)', background: 'linear-gradient(180deg, rgba(31,22,8,0.9) 0%, rgba(10,6,1,0.9) 100%)' }}
        >
          <button onClick={onBack} className="crt-key shrink-0 px-2.5 py-1 text-[10px]">{t('ms.back')}</button>
          <span className="crt-data crt-text--hi crt-text--glow tracking-[0.3em]">
            {zh ? '战斗准备 / BATTLE PREP' : 'BATTLE PREP'}
          </span>
          <span className="crt-label hidden sm:inline">· ARMAMENT · STORES MANAGEMENT</span>
          <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="crt-label">MISSION</span>
            <span className="crt-data crt-text--hi tracking-[0.24em]">{codename}</span>
            <button
              onClick={onLaunch}
              className="crt-key crt-corner px-4 py-1.5 text-[11px] font-bold tracking-[0.3em] hover:border-[var(--crt-amber-hi)] hover:text-[color:var(--crt-amber-hi)]"
              style={{ borderColor: 'var(--crt-line-strong)' }}
            >
              ▶ {zh ? '出击 / SORTIE' : 'SORTIE'}
            </button>
          </span>
        </div>

        {/* 主体: 左 = 3D 机库视口, 右 = 选项面板栏(可滚动)。窄屏自动堆叠。 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-2.5 lg:overflow-hidden">
          <div className="grid grid-cols-1 gap-2.5 lg:h-full lg:grid-cols-12">

            {/* ===== 左: 3D 机库场景 ===== */}
            <div className="flex min-h-0 flex-col gap-1.5 lg:col-span-7">
              <div className="tp-monitor relative h-[44vh] min-h-0 flex-1 lg:h-auto">
                <canvas ref={canvasRef} className="block h-full w-full" />
                <div className="tp-monitor-scan" />
                {loading && (
                  <div className="absolute inset-[5px] z-10 flex items-center justify-center bg-black/80 font-mono">
                    <div className="text-center">
                      <div className="crt-text crt-text--glow tracking-widest animate-pulse mb-1">正在初始化机库</div>
                      <div className="crt-label">LOADING GEOMETRY ...</div>
                    </div>
                  </div>
                )}
                {notice && (
                  <div className="absolute left-2 top-2 z-10 border border-[var(--crt-line)] bg-black/70 px-2 py-1 text-[10px] tracking-widest crt-text--hi">
                    {notice}
                  </div>
                )}
                <div className="absolute bottom-2 right-2 z-10">
                  <span className="tp-led inline-block h-2 w-2" style={{ color: 'var(--crt-amber)' }} />
                </div>
              </div>
              <div className="crt-label flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="crt-text--hi tracking-[0.24em]">{zh ? '机库 · 拖动旋转 · 滚轮缩放' : 'HANGAR · DRAG TO ORBIT · WHEEL TO ZOOM'}</span>
                <span>{aircraftNameZh(spec)} · {sel.paint.toUpperCase()}</span>
              </div>
            </div>

            {/* ===== 右: 选项面板 ===== */}
            <div className="flex min-h-0 flex-col gap-2.5 overflow-y-auto pr-0.5 lg:col-span-5">

              {/* --- 机型: 类别筛选 + 3 列卡片(推荐机型打星) --- */}
              <div className="crt-panel crt-corner">
                <div className="crt-panel-head flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5">
                  <span className="crt-label crt-text--hi tracking-[0.26em]">{t('br.selectAircraft')}</span>
                  <span className="crt-label truncate">{visibleSpecs.length} / {PLAYER_AIRCRAFT.length} · AIRFRAME</span>
                </div>
                <div className="p-2.5">
                  {/* 类别筛选行(顺序与机库侧栏一致) */}
                  <div className="grid grid-cols-4 gap-1">
                    {FILTER_ORDER.map((c) => (
                      <button
                        key={c}
                        onClick={() => setFilter(c)}
                        className={`border px-1 py-1 text-[0.5625rem] tracking-wider ${filter === c
                          ? 'border-[var(--crt-amber)] bg-[var(--crt-amber)]/10 text-[var(--crt-amber)]'
                          : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/8'}`}
                      >
                        {zh ? (c === 'all' ? '全部' : (CATEGORY_ZH[c] ?? c)) : FILTER_EN[c]}
                      </button>
                    ))}
                  </div>

                  {/* 3 列机型卡片: 点哪张就换哪张, 右上角 ★ = 本任务推荐类别 */}
                  <div className="mt-2 grid max-h-44 grid-cols-3 gap-1 overflow-y-auto pr-1">
                    {visibleSpecs.map((s) => {
                      const isActive = activeModel === s.model;
                      const isRecommended = recommended.includes(s.category);
                      return (
                        <button
                          key={s.id}
                          onClick={() => setSel((p) => ({ ...p, model: s.model }))}
                          title={s.name}
                          className={`relative border px-2 py-1.5 text-left transition-colors ${isActive
                            ? 'border-[var(--crt-amber)] bg-[var(--crt-amber)]/10 text-[var(--crt-amber-hi)]'
                            : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/8'}`}
                          style={isActive ? { borderColor: CATEGORY_ACCENT, background: `${CATEGORY_ACCENT}1a` } : undefined}
                        >
                          {isRecommended && (
                            <span className="absolute right-1 top-0.5 text-[0.5rem] tracking-wider" style={{ color: CATEGORY_ACCENT }}>★</span>
                          )}
                          <div className="text-[0.6875rem] leading-tight tracking-wide" style={isActive ? { color: CATEGORY_ACCENT } : undefined}>{s.code}</div>
                          <div className="mt-0.5 text-[0.5rem] opacity-70">{CATEGORY_CODE[s.category]}</div>
                        </button>
                      );
                    })}
                  </div>
                  <div className="crt-label mt-2 tracking-[0.18em]">{t('br.recommendedHint')}</div>
                </div>
              </div>

              {/* --- 涂装方案 + 已选机型读数 --- */}
              <div className="crt-panel crt-corner">
                <div className="crt-panel-head px-2.5 py-1.5">
                  <span className="crt-label crt-text--hi tracking-[0.26em]">{t('br.paintScheme')}</span>
                </div>
                <div className="p-2.5">
                  <div className="grid grid-cols-4 gap-1">
                    {paintChoices.map((p) => (
                      <button
                        key={p}
                        onClick={() => setSel((prev) => ({ ...prev, paint: p }))}
                        className={`border px-1 py-1 text-[0.625rem] tracking-wider ${sel.paint === p
                          ? 'border-[var(--crt-amber)] bg-[var(--crt-amber)]/10 text-[var(--crt-amber)]'
                          : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/8'}`}
                      >
                        {p.toUpperCase()}
                      </button>
                    ))}
                  </div>

                  <div className="crt-label mb-1.5 mt-4 tracking-[0.24em]">{t('br.selectedAircraft')}</div>
                  <div className="crt-data crt-text--hi text-[0.8125rem]">
                    <span style={{ color: CATEGORY_ACCENT }}>{aircraftNameZh(spec)}</span>
                    <span className="crt-text--dim"> · GHOST 1-1</span>
                  </div>
                  <div className="crt-data crt-text--dim mt-1 text-[0.625rem]">
                    生命 {spec.hp} · 极速 {spec.maxSpeed} · {CATEGORY_ZH[spec.category] ?? spec.category.toUpperCase()}
                  </div>
                  <span className="mt-2 block h-[6px] w-full" style={{ backgroundImage: 'repeating-linear-gradient(90deg, var(--crt-amber-deep) 0 1px, transparent 1px 9px), repeating-linear-gradient(90deg, var(--crt-amber) 0 1px, transparent 1px 45px)', opacity: 0.75 }} />
                </div>
              </div>

              {/* --- 出击配置: 派遣僚机 / 机炮瞄准 --- */}
              <div className="crt-panel crt-corner">
                <div className="crt-panel-head px-2.5 py-1.5">
                  <span className="crt-label crt-text--hi tracking-[0.26em]">{zh ? '出击配置' : 'SORTIE OPTIONS'}</span>
                </div>
                <div className="p-2.5">
                  <div className="flex items-center justify-between">
                    <span className="crt-label tracking-[0.24em]">{zh ? '派遣僚机' : 'WINGMEN'}</span>
                    <button
                      onClick={() => setWingmenOn(!wingmenEnabled)}
                      className={`border px-3 py-1 text-[0.625rem] tracking-widest ${wingmenEnabled
                        ? 'border-[var(--crt-amber)] bg-[var(--crt-amber)]/10 text-[var(--crt-amber)]'
                        : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-dim)]'}`}
                    >
                      {wingmenEnabled ? (zh ? '开' : 'ON') : (zh ? '关' : 'OFF')}
                    </button>
                  </div>

                  <div className="mt-3 flex items-center justify-between">
                    <span className="crt-label tracking-[0.24em]">{zh ? '机炮瞄准' : 'GUN AIM'}</span>
                    <div className="flex gap-1">
                      <button
                        onClick={() => setGunAimOn('auto')}
                        className={`border px-2 py-1 text-[0.625rem] tracking-widest ${gunAim === 'auto'
                          ? 'border-[var(--crt-amber)] bg-[var(--crt-amber)]/10 text-[var(--crt-amber)]'
                          : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-dim)]'}`}
                      >
                        {zh ? '自动瞄准' : 'AUTO'}
                      </button>
                      <button
                        onClick={() => setGunAimOn('manual')}
                        className={`border px-2 py-1 text-[0.625rem] tracking-widest ${gunAim === 'manual'
                          ? 'border-[var(--crt-amber)] bg-[var(--crt-amber)]/10 text-[var(--crt-amber)]'
                          : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-dim)]'}`}
                      >
                        {zh ? '瞄准心' : 'MANUAL'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* --- 任务天气 --- */}
              <div className="crt-panel crt-corner">
                <div className="crt-panel-head px-2.5 py-1.5">
                  <span className="crt-label crt-text--hi tracking-[0.26em]">{zh ? '任务天气' : 'WEATHER'}</span>
                </div>
                <div className="p-2.5">
                  <div className="grid grid-cols-4 gap-1">
                    {WEATHER_ORDER.map((v) => (
                      <button
                        key={v}
                        onClick={() => setWeatherValue(v)}
                        className={`border px-1 py-1 text-[0.5625rem] tracking-wider ${weatherOverride === v
                          ? 'border-[var(--crt-amber)] bg-[var(--crt-amber)]/10 text-[var(--crt-amber)]'
                          : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/8'}`}
                      >
                        {{
                          auto: zh ? '任务默认' : 'AUTO',
                          random: zh ? '随机' : 'RANDOM',
                          clear: zh ? '晴' : 'CLEAR',
                          cloudy: zh ? '多云' : 'CLOUDY',
                          rain: zh ? '雨' : 'RAIN',
                          storm: zh ? '雷暴' : 'STORM',
                          fog: zh ? '雾' : 'FOG',
                          snow: zh ? '雪' : 'SNOW',
                        }[v]}
                      </button>
                    ))}
                  </div>
                  <div className="mt-1 text-[0.5625rem] text-[var(--crt-amber-dim)]">
                    {zh
                      ? '不同天气的天光颜色和效果不同, 随机每次进关卡都不同。'
                      : 'EACH WEATHER CHANGES THE SKY LIGHT AND EFFECTS; RANDOM VARIES EVERY MISSION.'}
                  </div>
                </div>
              </div>

              {/* --- 僚机机型 --- */}
              <div className="crt-panel crt-corner">
                <div className="crt-panel-head px-2.5 py-1.5">
                  <span className="crt-label crt-text--hi tracking-[0.26em]">{zh ? '僚机机型' : 'WINGMAN MODEL'}</span>
                </div>
                <div className="p-2.5">
                  {/* 不带僚机时这一组置灰(与 Briefing 一致: 带了也白带)。 */}
                  <div className={`grid grid-cols-5 gap-1 ${wingmenEnabled ? '' : 'pointer-events-none opacity-40'}`}>
                    <button
                      onClick={() => setWingmanModel('auto')}
                      className={`border px-1 py-1 text-[0.5625rem] tracking-wider ${wingmanModel === 'auto'
                        ? 'border-[var(--crt-amber)] bg-[var(--crt-amber)]/10 text-[var(--crt-amber)]'
                        : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/8'}`}
                    >
                      {zh ? '自动' : 'AUTO'}
                    </button>
                    {(['f16', 'f15', 'su35', 'a10'] as AircraftModel[]).map((mdl) => {
                      const ws = PLAYER_AIRCRAFT.find((s) => s.model === mdl);
                      if (!ws) return null;
                      return (
                        <button
                          key={mdl}
                          onClick={() => setWingmanModel(mdl)}
                          title={ws.name}
                          className={`border px-1 py-1 text-[0.5625rem] tracking-wider ${wingmanModel === mdl
                            ? 'border-[var(--crt-amber)] bg-[var(--crt-amber)]/10 text-[var(--crt-amber)]'
                            : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/8'}`}
                        >
                          {ws.code}
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-1 text-[0.5625rem] text-[var(--crt-amber-dim)]">
                    {zh ? 'AUTO = 使用任务默认僚机机型' : 'AUTO = USE MISSION DEFAULT WINGMAN MODEL'}
                  </div>
                </div>
              </div>

              {/* --- 武器挂载 --- */}
              <div className="crt-panel crt-corner">
                <div className="crt-panel-head flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5">
                  <span className="crt-label crt-text--hi tracking-[0.26em]">
                    {zh ? '武器挂载 (4 槽)' : 'WEAPON LOADOUT (4 SLOTS)'}
                  </span>
                  <span className="crt-label truncate">STORES · {slotWeapon}</span>
                </div>
                <div className="p-2.5">
                  {spec.category !== 'gunship' && spec.category !== 'ew' ? (
                    <>
                      {/* 槽位标签页: 每个槽右边显示它当前挂着什么。
                          4 个槽各铺一整套武器按钮会把这栏撑到三屏高, 所以改成"选槽 -> 选武器"。 */}
                      <div className="grid grid-cols-4 gap-1">
                        {Array.from({ length: LOADOUT_SLOTS }, (_, i) => {
                          const d = getWeaponDisplay(loadout[i] ?? 'MSL');
                          const on = activeSlot === i;
                          return (
                            <button
                              key={i}
                              onClick={() => setActiveSlot(i)}
                              title={d.name}
                              className={`border px-1 py-1 text-[0.5625rem] tracking-wider ${on
                                ? 'border-[var(--crt-amber)] bg-[var(--crt-amber)]/10 text-[var(--crt-amber)]'
                                : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/8'}`}
                            >
                              <span className="flex items-center justify-between gap-1">
                                <span className="truncate">{zh ? `槽位 ${i + 1}` : `SLOT ${i + 1}`}</span>
                                <span className="font-bold" style={{ color: d.color }}>{d.code}</span>
                              </span>
                            </button>
                          );
                        })}
                      </div>

                      {/* 当前槽的武器按钮。MSL 只能占一个槽: 别的槽已经选了 MSL 时这里
                          禁用(灰掉不可点); 其它武器允许重复 -> 叠加弹药。 */}
                      <div className="mt-2 grid grid-cols-5 gap-0.5">
                        {ALL_LOADABLE_WEAPONS.map((w) => {
                          const d = getWeaponDisplay(w);
                          const isActive = slotWeapon === w;
                          const mslInOtherSlot = w === 'MSL' && loadout.some((lw, i) => i !== activeSlot && lw === 'MSL');
                          const disabled = mslInOtherSlot && !isActive;
                          return (
                            <button
                              key={w}
                              disabled={disabled}
                              onClick={() => {
                                const next = [...loadout];
                                next[activeSlot] = w;
                                setLoadout(next);
                              }}
                              className={`border px-0.5 py-1 text-[0.5rem] tracking-wider ${disabled
                                ? 'cursor-not-allowed border-[var(--crt-amber-ghost)] text-[var(--crt-amber-deep)]'
                                : isActive
                                  ? 'text-[var(--crt-amber-hi)]'
                                  : 'border-[var(--crt-amber-ghost)] text-[var(--crt-amber-dim)] hover:bg-[var(--crt-amber)]/8'}`}
                              style={isActive && !disabled ? { borderColor: 'var(--crt-amber-hi)', background: 'rgba(255,176,0,0.18)', color: 'var(--crt-amber-hi)' } : undefined}
                              title={disabled
                                ? (zh ? 'MSL 只能选择一个槽位' : 'MSL LIMITED TO ONE SLOT')
                                : `${d.name}\n+ ${d.pros}\n- ${d.cons}`}
                            >
                              {d.code}
                            </button>
                          );
                        })}
                      </div>
                      <div className="mt-2 text-[0.5625rem] text-[var(--crt-amber-dim)]">
                        {zh
                          ? '选 4 件武器, 重复选择同款叠加弹药(MSL 仅 1 槽)。GUN 永远可用。'
                          : 'PICK 4 WEAPONS. DUPLICATES STACK AMMO (MSL LIMITED TO 1 SLOT). GUN ALWAYS AVAILABLE.'}
                      </div>
                    </>
                  ) : spec.category === 'gunship' ? (
                    <>
                      {/* 炮艇机没有 4 槽武器: 它的"挂载"就是侧炮口径(可多选, 关内按 V 轮换)。 */}
                      <div className="crt-label mb-2 tracking-[0.24em]">{zh ? '侧炮口径' : 'SIDE CANNON'}</div>
                      <div className="grid grid-cols-2 gap-1">
                        {(Object.keys(GUNSHIP_GUNS) as GunshipGunId[]).map((id) => {
                          const g = GUNSHIP_GUNS[id];
                          const active = gunshipGuns.includes(id);
                          return (
                            <button
                              key={id}
                              onClick={() => toggleGun(id)}
                              title={g.label}
                              className={`border px-1 py-1.5 text-[0.5625rem] tracking-wider ${active
                                ? 'border-[var(--crt-red)] bg-[var(--crt-red)]/10 text-[var(--crt-amber-dim)]'
                                : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/8'}`}
                            >
                              {g.label.split(' ')[0]}{active ? ' *' : ''}
                            </button>
                          );
                        })}
                      </div>
                      <div className="mt-2 space-y-0.5 text-[0.5625rem] text-[var(--crt-amber-dim)]">
                        <div className="font-bold tracking-wider">
                          {zh ? `已挂载 ${gunshipGuns.length} 门炮 · 任务中按 V 切换` : `${gunshipGuns.length} GUN(S) MOUNTED · PRESS V IN MISSION`}
                        </div>
                        <div className="opacity-80">{gunshipGuns.map((id) => GUNSHIP_GUNS[id].label).join(' · ')}</div>
                      </div>
                    </>
                  ) : (
                    <>
                      {/* 电子战机同理: 挂载 = 一件 SP 武器。 */}
                      <div className="crt-label mb-2 tracking-[0.24em]">{zh ? 'SP 武器挂载' : 'SP WEAPON'}</div>
                      <div className="grid grid-cols-3 gap-1">
                        <button
                          onClick={() => setSpWeapon('none')}
                          className={`border px-1 py-1.5 text-[0.5625rem] tracking-wider ${spWeapon === 'none'
                            ? 'border-[var(--crt-amber)] bg-[var(--crt-amber)]/10 text-[var(--crt-amber)]'
                            : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/8'}`}
                        >
                          {zh ? '无' : 'NONE'}
                        </button>
                        {SP_WEAPONS.map((sp) => {
                          const on = spWeapon === sp.type;
                          return (
                            <button
                              key={sp.type}
                              onClick={() => setSpWeapon(sp.type)}
                              title={`${sp.name}\n${sp.pros}\n${sp.cons}`}
                              className={`border px-1 py-1.5 text-[0.5625rem] tracking-wider ${on
                                ? 'text-[var(--crt-amber-hi)]'
                                : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/8'}`}
                              style={on ? { borderColor: 'var(--crt-amber-hi)', background: 'rgba(255,176,0,0.18)' } : undefined}
                            >
                              {sp.code}
                            </button>
                          );
                        })}
                      </div>
                      {spWeapon !== 'none' && (() => {
                        const sp = SP_WEAPONS.find((s) => s.type === spWeapon);
                        if (!sp) return null;
                        return (
                          <div className="mt-2 flex flex-col gap-0.5 text-[0.5625rem] text-[var(--crt-amber-dim)]">
                            <div className="crt-text--hi tracking-[0.2em]">{sp.name}</div>
                            <div className="opacity-80">+ {sp.pros}</div>
                            <div className="opacity-80">- {sp.cons}</div>
                          </div>
                        );
                      })()}
                    </>
                  )}
                </div>
              </div>

              {/* 主出击键(与抬头条那颗同一个 handler; 面板翻到底也能直接走) */}
              <button
                onClick={onLaunch}
                className="crt-key crt-corner w-full px-8 py-2.5 text-[0.8125rem] font-bold tracking-[0.3em] hover:border-[var(--crt-amber-hi)] hover:text-[color:var(--crt-amber-hi)] focus-visible:outline focus-visible:outline-1"
                style={{ outlineColor: 'var(--crt-line-strong)' }}
              >
                ▶ {zh ? '出击 / SORTIE' : 'SORTIE'}
              </button>
            </div>
          </div>
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
