'use client';

import { useEffect, useState } from 'react';
import { InputManager } from '@/lib/game/input';
import type { ControlBindings, InversionSettings } from '@/lib/game/types';
import { useT } from '@/hooks/use-i18n';
import { useLocale } from '@/hooks/use-i18n';
import { setLocale } from '@/lib/game/i18n';
import { VJ_KEY, isVirtualJoystickEnabled } from './VirtualJoystick';
// === 设备形态判定(默认电脑端; 手机档/触屏操作的默认值单一真相源) ===
import { MOBILE_MODE_KEY, resolveAutoOnSetting } from '@/lib/game/device-mode';
import { getMusicPlayer } from '@/lib/game/music';
import { readManualUiScale, notifyUiScale, UI_SCALE_KEY } from '@/lib/game/ui-scale';

type ActionKey = keyof ControlBindings;

// Action key list — labels are looked up via t() so the entire Settings panel
// re-renders in the active locale.
const ACTION_KEYS: { key: ActionKey; group: string }[] = [
  { key: 'pitchUp', group: 'FLIGHT' },
  { key: 'pitchDown', group: 'FLIGHT' },
  { key: 'rollLeft', group: 'FLIGHT' },
  { key: 'rollRight', group: 'FLIGHT' },
  { key: 'yawLeft', group: 'FLIGHT' },
  { key: 'yawRight', group: 'FLIGHT' },
  { key: 'throttleUp', group: 'THROTTLE' },
  { key: 'throttleDown', group: 'THROTTLE' },
  { key: 'brake', group: 'THROTTLE' },
  // === Airbrake (减速板) — per user request: H 键 ===
  { key: 'airbrake', group: 'THROTTLE' },
  // === Emergency brake (紧急减速板) — per user request: Z 按住 ===
  { key: 'emergencyBrake', group: 'THROTTLE' },
  // === AoA limiter override (攻角限制解除) — CapsLock 按住 ===
  { key: 'aoaOverride', group: 'COMBAT' },
  { key: 'fireGun', group: 'COMBAT' },
  { key: 'fireMissile', group: 'COMBAT' },
  { key: 'flare', group: 'COMBAT' },
  { key: 'cycleWeapon', group: 'COMBAT' },
  { key: 'cycleCamera', group: 'VIEW' },
  // === Look-at-target (hold) — R (per user request: 注视敌人) ===
  { key: 'lookTarget', group: 'VIEW' },
  // === Wingman view toggle — B (per user request) ===
  { key: 'wingmanView', group: 'VIEW' },
  // === Missile view toggle — G (per user request) ===
  { key: 'missileView', group: 'VIEW' },
  { key: 'cycleRadarRange', group: 'VIEW' },
  // === Radar filter toggle (per user request: 雷达指示可开关) ===
  { key: 'toggleRadarFilter', group: 'VIEW' },
  // === Free-look (hold) — per user request ===
  // Hold this key + move mouse to look around without turning the aircraft.
  { key: 'freeLook', group: 'VIEW' },
  // === AC-130 side-firing view toggle (per user request: CapsLock) ===
  // Only effective on gunship-category aircraft (AC-130). Toggles the
  // camera between the standard chase/cockpit cycle and the port-side
  // 105mm gunport view (with limited mouse-drag aim range).
  { key: 'toggleSideView', group: 'VIEW' },
  { key: 'gear', group: 'VIEW' },
  { key: 'nextTarget', group: 'COMBAT' },
  { key: 'wingmanAttack', group: 'WINGMAN' },
  { key: 'wingmanCover', group: 'WINGMAN' },
  { key: 'wingmanForm', group: 'WINGMAN' },
  { key: 'callReinforcement', group: 'WINGMAN' },
  { key: 'togglePause', group: 'SYSTEM' },
];

// Map each action key to its translation key in the i18n dictionary.
const ACTION_LABEL_KEYS: Record<ActionKey, string> = {
  pitchUp: 'act.pitchUp',
  pitchDown: 'act.pitchDown',
  rollLeft: 'act.rollLeft',
  rollRight: 'act.rollRight',
  yawLeft: 'act.yawLeft',
  yawRight: 'act.yawRight',
  throttleUp: 'act.throttleUp',
  throttleDown: 'act.throttleDown',
  brake: 'act.brake',
  airbrake: 'act.airbrake',
  emergencyBrake: 'act.emergencyBrake',
  aoaOverride: 'act.aoaOverride',
  fireGun: 'act.fireGun',
  fireMissile: 'act.fireMissile',
  flare: 'act.flare',
  cycleWeapon: 'act.cycleWeapon',
  cycleCamera: 'act.cycleCamera',
  lookBack: 'act.lookBack',
  lookTarget: 'act.lookTarget',
  wingmanView: 'act.wingmanView',
  missileView: 'act.missileView',
  cycleRadarRange: 'act.cycleRadarRange',
  toggleRadarFilter: 'act.toggleRadarFilter',
  freeLook: 'act.freeLook',
  toggleSideView: 'act.toggleSideView',
  gear: 'act.gear',
  nextTarget: 'act.nextTarget',
  wingmanAttack: 'act.wingmanAttack',
  wingmanCover: 'act.wingmanCover',
  wingmanForm: 'act.wingmanForm',
  callReinforcement: 'act.callReinforcement',
  togglePause: 'act.togglePause',
};

function prettyKey(code: string): string {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'ShiftLeft') return 'L-SHIFT';
  if (code === 'ShiftRight') return 'R-SHIFT';
  if (code === 'ControlLeft') return 'L-CTRL';
  if (code === 'ControlRight') return 'R-CTRL';
  if (code === 'Space') return 'SPACE';
  if (code === 'Tab') return 'TAB';
  if (code === 'CapsLock') return 'CAPSLOCK';
  return code.toUpperCase();
}

export function Settings({ onBack, inputManager }: { onBack: () => void; inputManager: InputManager }) {
  const t = useT();
  const locale = useLocale();
  const [bindings, setBindings] = useState<ControlBindings>(inputManager.getBindings());
  const [inversions, setInversions] = useState<InversionSettings>(inputManager.getInversions());
  const [listening, setListening] = useState<ActionKey | null>(null);
  // Cloud rendering mode — 'geometry' (3D polygonal clouds) or 'sprite'
  // (flat billboard clouds). Persisted to localStorage; engine reads it on
  // mission start.
  // === 预设默认值 (per user request: 固化客户端设置为预设) ===
  // sprite 贴片云 / overcast 密云 / 音乐音量 30%。
  const [cloudMode, setCloudMode] = useState<'geometry' | 'sprite' | 'off'>(() => {
    // §336: 默认 'off'(贴图云关), 且**必须认识 'off'** —— 旧写法把 'off' 也读回
    // 'sprite', 于是"选了关"的面板会显示成"贴片云"选中(设置与实际不符)。
    if (typeof window === 'undefined') return 'off';
    const v = window.localStorage.getItem('skybound.cloudMode');
    return v === 'geometry' ? 'geometry' : v === 'sprite' ? 'sprite' : 'off';
  });
  // Cloud coverage — isolated individuals vs merged banks/sheets.
  const [cloudCoverage, setCloudCoverage] = useState<'scattered' | 'mixed' | 'overcast'>(() => {
    if (typeof window === 'undefined') return 'overcast';
    const v = window.localStorage.getItem('skybound.cloudCoverage');
    return v === 'scattered' ? 'scattered' : v === 'mixed' ? 'mixed' : 'overcast';
  });
  // SSR (Screen-Space Reflections) — high-cost post-processing that adds
  // real-time reflections to the ocean, lakes, and wet terrain. Off by
  // default for framerate; toggle on for cinematic quality.
  const [ssr, setSsr] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('skybound.ssr') === 'on';
  });
  // === GTAO (per user request: 默认已改为 **关**) ============================
  // 接缝/凹陷/机体与地面接触处的遮蔽层次, 但它是整帧最大的一笔固定开销
  // (实测 4.3~4.8ms @1912x956, 主要是要重渲一遍 MeshNormalMaterial 场景)。
  // §336 用户要求"关闭所有 AO 选项" ⇒ 默认关, 只有显式 'on' 才开(与 engine 同口径)。
  const [gtao, setGtao] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('skybound.gtao') === 'on';
  });
  const [gtaoRadius, setGtaoRadius] = useState<number>(() => {
    if (typeof window === 'undefined') return 2;
    const v = window.localStorage.getItem('skybound.gtaoRadius');
    const n = parseFloat(v ?? '');
    return Number.isNaN(n) ? 2 : Math.max(0.5, Math.min(16, n));
  });
  // === SSAO (per user request: SSAO 选项加入设置可开关) ===
  // 接触/凹陷处的屏幕空间环境光遮蔽 —— 3A 桌面标配,但有一个额外的
  // 半分辨率 pass 开销,默认 OFF;半径滑条(2-24,默认 6)调强弱。
  // === 与 GTAO 的关系 (per user request: 别叠两层 AO) ===
  // GTAO 开着时引擎**不会建** SSAO(两层 AO 相乘会把接触处压死), 所以这一项只在
  // GTAO = 关 时才真的有用; UI 上也照这个口径提示(不隐藏, 免得玩家以为设置丢了)。
  const [ssao, setSsao] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('skybound.ssao') === 'on';
  });
  const [ssaoRadius, setSsaoRadius] = useState<number>(() => {
    if (typeof window === 'undefined') return 6;
    const v = window.localStorage.getItem('skybound.ssaoRadius');
    const n = parseFloat(v ?? '');
    return Number.isNaN(n) ? 6 : Math.max(2, Math.min(24, n));
  });
  // === 体积云 v2 (per user request: 彻底重做, 高度与贴片云一致) ===
  // 两层光线步进体积云(低空片云 3019 m / 高空团云 7219 m —— base 直接引用贴片云的常量)
  // + 地形深度遮挡(山挡云、云不穿地)。开着时贴片云自动隐藏, 两者互斥。
  // 开关在任务开始时读; 关卡内想立刻切可以用控制台 vcloud on/off。移动画质模式自动关闭。
  const [volumeClouds, setVolumeClouds] = useState<boolean>(() => {
    // §336: 默认开(键缺席 = 开, 只有显式 'off' 才关) —— 与 engine 同口径。
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem('skybound.volumeClouds') !== 'off';
  });
  const [cloudQuality, setCloudQuality] = useState<'low' | 'med' | 'high'>(() => {
    if (typeof window === 'undefined') return 'med';
    const v = window.localStorage.getItem('skybound.cloudQuality');
    return v === 'low' || v === 'high' ? v : 'med';
  });
  // === 动态模糊(相机角速度 → CSS blur;per user request,默认关) ===
  const [motionBlur, setMotionBlur] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('skybound.motionBlur') === 'on';
  });
  const [mbStrength, setMbStrength] = useState<'low' | 'med' | 'high'>(() => {
    if (typeof window === 'undefined') return 'med';
    const v = window.localStorage.getItem('skybound.motionBlurStrength');
    return v === 'low' || v === 'high' ? v : 'med';
  });
  // === HUD 阴影/毛玻璃增强(ShadowKit 风格子集,默认开) ===
  const [hudShadow, setHudShadow] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem('skybound.hudShadow') !== 'off';
  });
  // Bloom — cheap post-processing that adds a cinematic glow to the sun,
  // missile engines, explosions, and city lights. Strongest at night.
  // Default ON for the visual win; toggle off for maximum framerate.
  const [bloom, setBloom] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem('skybound.bloom') !== 'off';
  });
  // === Bloom strength slider (per user request: bloom的效果不能太亮，可以调节) ===
  // 0..150% multiplier on the per-sky-preset bloom strength. Default 70%
  // tones down the bloom globally so it doesn't wash out the scene.
  const [bloomStrength, setBloomStrength] = useState<number>(() => {
    if (typeof window === 'undefined') return 0.7;
    const v = window.localStorage.getItem('skybound.bloomStrength');
    if (!v) return 0.7;
    const n = parseFloat(v);
    return Number.isNaN(n) ? 0.7 : Math.max(0, Math.min(1.5, n));
  });
  // === Static scene shadow (per user request) ===
  // Single shadow map covering the play area. Buildings + terrain cast/
  // receive shadows. **默认开启** —— 引擎读的是 `!== 'off'`(见 preset.ts):
  // 太阳角度固定 ⇒ 静态正交灯就是本项目的默认阴影源。
  const [staticShadow, setStaticShadow] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem('skybound.staticShadow') !== 'off';
  });
  // === CSM (Cascaded Shadow Maps) for player aircraft ===
  // 4 cascades that follow the camera, giving terrain/buildings/aircraft
  // correct sun shadows in ANY view (the 3A pipeline). **默认关闭** ——
  // 默认已改用静态正交平行光(不需跟随相机, 小物体的投影也就不会随级联游移而闪)。
  // === ⚠ 2026-09-23 复测: 默认保持关闭, 而且这一项现在**会毁地表** =============
  // 实测(m06 冻结相机 A/B): CSM 的 4 级级联要多占 3 张 directionalShadowMap, 而地形
  // 材质本身已用 14/16 张采样器 ⇒ 17 > 16 ⇒ 片元着色器校验失败、地表整片消失
  // (gl.getError() = 1282)。数据见 docs/shadow-pipeline.md §11。开关保留只为 A/B 取证。
  const [csm, setCsm] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('skybound.csm') === 'on';
  });
  // === 投影映射阴影纹理(贴花式, 非 CSM) per user request ===
  // 这是机体自阴影的**唯一**实现: 把一张深度图用投影矩阵贴到机体表面, 只压太阳直射项、
  // 不动 IBL。引擎的默认是**开**(只有显式 'off' 才关), 所以这里显示也用 `!== 'off'`。
  //
  // 已删除: 原"机体自阴影系统(pbr/legacy)"选项。那两套都建立在
  // intensity = 0 的灯上 —— three 里阴影乘在灯自己的颜色上, 所以它们不产生任何可见阴影
  // (见 docs/shadow-pipeline.md §2)。
  const [projShadowTex, setProjShadowTex] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem('skybound.selfShadowMap') !== 'off';
  });
  // === Texture quality (per user request: 纹理性能优化 + PBR) ===
  // Controls the PBR texture resolution tier + anisotropy (4/8/16) used by
  // the texture manager at mission start. Next mission applies; the debug
  // console `textureq` command refreshes live.
  const [textureQuality, setTextureQuality] = useState<'low' | 'medium' | 'high'>(() => {
    if (typeof window === 'undefined') return 'high';
    const v = window.localStorage.getItem('skybound.textureQuality');
    return v === 'low' || v === 'medium' ? v : 'high';
  });
  // === PC FPS cap (per user request: 最大帧率限制) ===
  // 0 = uncapped; 30/60/120/144 limit the render rate (skips whole ticks).
  // Read at engine/hangar construction — applies on next mission/hangar.
  const [fpsCap, setFpsCap] = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    const v = parseInt(window.localStorage.getItem('skybound.fpsCap') ?? '0', 10);
    return [0, 30, 60, 120, 144].includes(v) ? v : 0;
  });
  // === 渲染管线 (per user request: 延迟渲染实验管线) ===
  // forward = 传统前向渲染（默认）· deferred = 延迟渲染实验管线 ·
  // auto = WebGL2 自动延迟，旧设备回退前向。
  const [pipeline, setPipeline] = useState<'forward' | 'deferred' | 'auto'>(() => {
    if (typeof window === 'undefined') return 'forward';
    const v = window.localStorage.getItem('skybound.pipeline');
    return v === 'deferred' || v === 'auto' ? v : 'forward';
  });
  // === Virtual joystick (per user request: 摇杆操控器开关，让手机也能玩) ===
  // On-screen touch joystick during missions. Default: auto-ON on touch
  // devices; the joystick reads this key at mission start.
  const [vj, setVj] = useState<boolean>(isVirtualJoystickEnabled);
  // === Mobile performance mode (per user request: 手机画质优化模式60帧) ===
  // === 默认电脑端 (per user request: 游戏默认是电脑端模式, 不是手机模式) ===
  // 只有"真手持设备"(粗指针 + 小屏)才自动开; 带触摸屏的电脑默认开桌面档。
  // 判定统一在 src/lib/game/device-mode.ts(与引擎/主菜单/虚拟摇杆同一份逻辑)。
  const [mobileMode, setMobileMode] = useState<boolean>(() => resolveAutoOnSetting(MOBILE_MODE_KEY));
  // === Difficulty (per user request: 可以选难度) ===
  // Lower difficulty = lower enemy aggression (cooldowns, lock speed, range,
  // simultaneous attackers). Read by the engine at mission start.
  const [difficulty, setDifficulty] = useState<'easy' | 'normal' | 'hard'>(() => {
    if (typeof window === 'undefined') return 'normal';
    const v = window.localStorage.getItem('skybound.difficulty');
    return v === 'easy' || v === 'hard' ? v : 'normal';
  });
  // === Volume sliders (per user request: 可以调整各种音量大小) ===
  // Master applies on next mission start (WebAudio context); music/SFX apply
  // live through the MusicPlayer.
  const readVol = (key: string, def: number) => {
    if (typeof window === 'undefined') return def;
    const v = parseFloat(window.localStorage.getItem(key) ?? String(def));
    return Number.isNaN(v) ? def : Math.max(0, Math.min(1, v));
  };
  const [volMaster, setVolMaster] = useState<number>(() => readVol('skybound.volumeMaster', 0.8));
  const [volMusic, setVolMusic] = useState<number>(() => readVol('skybound.volumeMusic', 0.5));
  const [volSfx, setVolSfx] = useState<number>(() => readVol('skybound.volumeSfx', 0.8));
  // === Engine / airflow volume (per user request: 设置里可调) ===
  const [volEngine, setVolEngine] = useState<number>(() => readVol('skybound.volumeEngine', 0.6));
  const [volWind, setVolWind] = useState<number>(() => readVol('skybound.volumeWind', 0.5));
  // === Camera framing + UI scale (per user request: 飞机占比/拖尾/界面缩放可调) ===
  // cameraSize 0.5-1.5 (default 1.0) — bigger = aircraft larger in frame.
  // cameraLag 0-2 (default 1.0) — lower = more stable trailing.
  // uiScale 0.7-1.5 (default 1.0) — manual multiplier on the auto scale.
  const [cameraSize, setCameraSize] = useState<number>(() => {
    if (typeof window === 'undefined') return 1;
    const v = parseFloat(window.localStorage.getItem('skybound.cameraSize') ?? '');
    // === 可调范围改成 ×0.2308 ~ ×0.3600 (per user request) ===
    // 这是"相对默认机位的放大倍率"; 与相机内部 zoomMult 互为倒数
    // (zoomMult = 0.72 / 倍率 ⇒ 2.0000 ~ 3.1196)。
    // === 范围: 倍率 ×2.91 ~ ×3.12 (per user request) ===
    // 倍率 = 相对默认机位的画面放大倍率(越大越近); 对应相机内部 zoomMult = 0.72 / 倍率
    // ⇒ 0.2474(最小倍率 2.91) ~ 0.2308(最大倍率 3.12)。
    // === 范围: 倍率(相对默认机位) 0.2308 ~ 0.36 ⇒ zoomMult 2.0000 ~ 3.1196 ===
    // === 范围 0.2308 ~ 6 (默认 ×6, per user request) ===
    // 默认 0.36 ⇒ 基准 zoomMult = 2.0(与进关卡时的 ×6.6667 读数配套)
    return Number.isNaN(v) ? 0.36 : Math.max(0.2308, Math.min(6, v));
  });
  const [cameraLag, setCameraLag] = useState<number>(() => {
    if (typeof window === 'undefined') return 1;
    const v = parseFloat(window.localStorage.getItem('skybound.cameraLag') ?? '');
    return Number.isNaN(v) ? 1 : Math.max(0, Math.min(2, v));
  });
  // === Camera follow speed (per user request: 镜头跟随/回正速度可调) ===
  const [cameraFollow, setCameraFollow] = useState<number>(() => {
    if (typeof window === 'undefined') return 1;
    const v = parseFloat(window.localStorage.getItem('skybound.cameraFollow') ?? '');
    return Number.isNaN(v) ? 1 : Math.max(0.5, Math.min(2.5, v));
  });
  // === Gun aim mode (per user request: 自动瞄准机炮 / 纯机炮准心) ===
  const [gunAim, setGunAim] = useState<'auto' | 'manual'>(() => {
    if (typeof window === 'undefined') return 'auto';
    return window.localStorage.getItem('skybound.gunAim') === 'off' ? 'manual' : 'auto';
  });
  // === Control mode (per user request: 战争雷霆式鼠标瞄准) ===
  // 'keyboard' (default) = classic pitch/roll/yaw keys; 'mouseAim' = the
  // WT-style autopilot (a screen circle defines the aim direction, the
  // airframe aligns with pitch/yaw/roll together; keyboard still blends in).
  // Read by the engine at mission start.
  const [controlMode, setControlMode] = useState<'keyboard' | 'mouseAim'>(() => {
    // Preset default = mouse-aim (per user request: 固化为预设).
    if (typeof window === 'undefined') return 'mouseAim';
    return window.localStorage.getItem('skybound.controlMode') === 'keyboard' ? 'keyboard' : 'mouseAim';
  });
  // === Mouse-aim view-centre micro-float (per user request: 视野中心微浮动) ===
  // 0 = LOCKED to the view-centre ball (the camera never drifts from the
  // aircraft at speed); 1 = floaty chase feel. Read by the engine at mission
  // start (skybound.maFloat).
  const [maFloat, setMaFloat] = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    const v = parseFloat(window.localStorage.getItem('skybound.maFloat') ?? '');
    return Number.isNaN(v) ? 0 : Math.max(0, Math.min(1, v));
  });
  // === Mouse-aim view sensitivity (per user request: 视角灵敏度可调) ===
  // skybound.maSens = multiplier on the base 0.012 rad/px (0.25..2.5, default
  // 1). Read by the engine at mission start.
  const [maSens, setMaSens] = useState<number>(() => {
    if (typeof window === 'undefined') return 1;
    const v = parseFloat(window.localStorage.getItem('skybound.maSens') ?? '');
    return Number.isNaN(v) ? 1 : Math.max(0.25, Math.min(2.5, v));
  });
  const [uiScale, setUiScaleState] = useState<number>(readManualUiScale);
  // === Terrain LOD tuning (per user request: LOD 距离/范围可调) ===
  // skybound.lodScale 0.5-2.0 (default 1.0) — LOD ring distance multiplier.
  // skybound.lod0Radius 0-4 (default 2) — forced-LOD0 chunk-ring size.
  // Both applied on the next mission start, like the camera settings.
  const [lodScale, setLodScale] = useState<number>(() => {
    if (typeof window === 'undefined') return 1;
    const v = parseFloat(window.localStorage.getItem('skybound.lodScale') ?? '');
    return Number.isNaN(v) ? 1 : Math.max(0.5, Math.min(2, v));
  });
  const [lod0Radius, setLod0Radius] = useState<number>(() => {
    if (typeof window === 'undefined') return 2;
    const v = parseFloat(window.localStorage.getItem('skybound.lod0Radius') ?? '');
    return Number.isNaN(v) ? 2 : Math.max(0, Math.min(4, Math.round(v)));
  });
  // === Gaea 导入地形网格分辨率 (per user request: 设置里可改 mesh 分辨率) ===
  // 默认 1792 = terrain-tune.json 里 maps.custom.terrain.segments 的值。
  // 数值越高地表越细, 但顶点数按平方增长(2048 时 custom 图约 3.9M 顶点)。
  const [terrainSegments, setTerrainSegments] = useState<number>(() => {
    if (typeof window === 'undefined') return 1792;
    const v = parseInt(window.localStorage.getItem('skybound.terrainSegments') ?? '', 10);
    return Number.isNaN(v) ? 1792 : Math.max(256, Math.min(2048, v));
  });

  const setCloud = (m: 'geometry' | 'sprite' | 'off') => {
    setCloudMode(m);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.cloudMode', m);
      // === 贴片云"全关" (per user request: 给贴图云加个全关闭选项) ===
      // `cloudMode` 历史上只管"怎么画"(而 'geometry' 已被引擎强制回 'sprite');
      // 真正决定贴片云**是否参与绘制**的是 `skybound.cloudBillboards` —— 引擎在构建时读它
      // 决定要不要 scene.add(不 add = 零绘制, 连 overdraw 上限那套都省掉)。
      // 这里把两者绑在一起: 选"关"就写 off, 选另外两项就恢复 on。
      window.localStorage.setItem('skybound.cloudBillboards', m === 'off' ? 'off' : 'on');
    }
  };
  const setCoverage = (c: 'scattered' | 'mixed' | 'overcast') => {
    setCloudCoverage(c);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.cloudCoverage', c);
    }
  };
  const setSsrOn = (on: boolean) => {
    setSsr(on);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.ssr', on ? 'on' : 'off');
    }
  };
  const setBloomOn = (on: boolean) => {
    setBloom(on);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.bloom', on ? 'on' : 'off');
    }
  };
  // Persist bloom strength (0..1.5) — engine reads this on next mission start.
  const setBloomStrengthValue = (v: number) => {
    const clamped = Math.max(0, Math.min(1.5, v));
    setBloomStrength(clamped);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.bloomStrength', String(clamped));
    }
  };
  // GTAO 开关/半径 —— engine 在下一次任务开始时读取(pass 列表在 setupPostProcessing 定)。
  //   ⚠ 默认开: 写 'on' 而不是删键(删了也等于开, 但显式写更像"用户的选择")。
  //   关卡内想立刻对照可以按 ` 打开调试控制台敲 `gtao off` / `gtao on`。
  const setGtaoOn = (on: boolean) => {
    setGtao(on);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.gtao', on ? 'on' : 'off');
    }
  };
  const setGtaoRadiusValue = (v: number) => {
    const clamped = Math.max(0.5, Math.min(16, v));
    setGtaoRadius(clamped);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.gtaoRadius', String(clamped));
    }
  };
  // SSAO 开关/半径 —— engine 在下一次任务开始时读取。
  const setSsaoOn = (on: boolean) => {
    setSsao(on);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.ssao', on ? 'on' : 'off');
    }
  };
  const setSsaoRadiusValue = (v: number) => {
    const clamped = Math.max(2, Math.min(24, v));
    setSsaoRadius(clamped);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.ssaoRadius', String(clamped));
    }
  };
  // === 体积云/动态模糊/HUD 阴影 — engine 在下一次任务开始时读取 ===
  const setVolumeCloudsOn = (on: boolean) => {
    setVolumeClouds(on);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.volumeClouds', on ? 'on' : 'off');
    }
  };
  const setCloudQualityValue = (q: 'low' | 'med' | 'high') => {
    setCloudQuality(q);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.cloudQuality', q);
    }
  };
  const setMotionBlurOn = (on: boolean) => {
    setMotionBlur(on);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.motionBlur', on ? 'on' : 'off');
    }
  };
  const setMbStrengthValue = (s: 'low' | 'med' | 'high') => {
    setMbStrength(s);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.motionBlurStrength', s);
    }
  };
  const setHudShadowOn = (on: boolean) => {
    setHudShadow(on);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.hudShadow', on ? 'on' : 'off');
      // html.hud-shadow-off → globals.css 回退基础阴影(即时生效)
      document.documentElement.classList.toggle('hud-shadow-off', !on);
    }
  };
  const setStaticShadowOn = (on: boolean) => {
    setStaticShadow(on);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.staticShadow', on ? 'on' : 'off');
    }
  };
  const setCsmOn = (on: boolean) => {
    setCsm(on);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.csm', on ? 'on' : 'off');
    }
  };
  const setTextureQValue = (q: 'low' | 'medium' | 'high') => {
    setTextureQuality(q);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.textureQuality', q);
    }
  };
  const setFpsCapValue = (fps: number) => {
    setFpsCap(fps);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.fpsCap', String(fps));
    }
  };
  const setPipelineValue = (p: 'forward' | 'deferred' | 'auto') => {
    setPipeline(p);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.pipeline', p);
    }
  };
  const setVjOn = (on: boolean) => {
    setVj(on);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(VJ_KEY, on ? 'on' : 'off');
    }
  };
  const setMobileModeOn = (on: boolean) => {
    setMobileMode(on);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.mobileMode', on ? 'on' : 'off');
    }
  };
  const setDifficultyTo = (d: 'easy' | 'normal' | 'hard') => {
    setDifficulty(d);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.difficulty', d);
    }
  };
  const setVol = (key: string, setter: (v: number) => void) => (v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    setter(clamped);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(key, String(clamped));
    }
  };
  const setVolMusicLive = (v: number) => {
    setVol('skybound.volumeMusic', setVolMusic)(v);
    getMusicPlayer().setVolume(v);
  };
  const setVolSfxLive = (v: number) => {
    setVol('skybound.volumeSfx', setVolSfx)(v);
    getMusicPlayer().setSfxVolume(v);
  };
  // Engine / airflow volumes apply on the next mission start (the WebAudio
  // engine loop is per-mission), like the master slider.
  const setVolEngineLive = (v: number) => setVol('skybound.volumeEngine', setVolEngine)(v);
  const setVolWindLive = (v: number) => setVol('skybound.volumeWind', setVolWind)(v);
  // Persist camera framing settings — engine reads them on next mission start.
  const setCameraSizeValue = (v: number) => {
    const clamped = Math.max(0.2308, Math.min(6, v));
    setCameraSize(clamped);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.cameraSize', String(clamped));
    }
  };
  const setCameraLagValue = (v: number) => {
    const clamped = Math.max(0, Math.min(2, v));
    setCameraLag(clamped);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.cameraLag', String(clamped));
    }
  };
  const setCameraFollowValue = (v: number) => {
    const clamped = Math.max(0.5, Math.min(2.5, v));
    setCameraFollow(clamped);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.cameraFollow', String(clamped));
    }
  };
  // Gun aim mode — applied on the next mission start.
  const setGunAimValue = (v: 'auto' | 'manual') => {
    setGunAim(v);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.gunAim', v === 'manual' ? 'off' : 'on');
    }
  };
  // Control mode — applied on the next mission start.
  const setControlModeValue = (v: 'keyboard' | 'mouseAim') => {
    setControlMode(v);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.controlMode', v);
    }
  };
  // Mouse-aim view-centre micro-float — applied on the next mission start.
  const setMaFloatValue = (v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    setMaFloat(clamped);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.maFloat', String(clamped));
    }
  };
  // Mouse-aim view sensitivity multiplier — applied on the next mission start.
  const setMaSensValue = (v: number) => {
    const clamped = Math.max(0.25, Math.min(2.5, v));
    setMaSens(clamped);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.maSens', String(clamped));
    }
  };
  // UI scale applies LIVE (re-scales the whole interface while dragging).
  const setUiScaleValue = (v: number) => {
    const clamped = Math.max(0.7, Math.min(1.5, v));
    setUiScaleState(clamped);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(UI_SCALE_KEY, String(clamped));
      notifyUiScale();
    }
  };
  // Terrain LOD — applied on the next mission start.
  const setLodScaleValue = (v: number) => {
    const clamped = Math.max(0.5, Math.min(2, v));
    setLodScale(clamped);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.lodScale', String(clamped));
    }
  };
  const setLod0RadiusValue = (v: number) => {
    const clamped = Math.max(0, Math.min(4, Math.round(v)));
    setLod0Radius(clamped);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.lod0Radius', String(clamped));
    }
  };
  // === Gaea 导入地形的网格分辨率 (per user request: 设置里可改 mesh 分辨率) ===
  // 只影响 map='custom' 的 Gaea 导入关(其它程序化地图自己定段数)。
  // 取值即 buildHeightmapTerrain 的 segments;引擎会在进关卡时读它。
  const setTerrainSegmentsValue = (v: number) => {
    const clamped = Math.max(256, Math.min(2048, Math.round(v / 64) * 64));
    setTerrainSegments(clamped);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('skybound.terrainSegments', String(clamped));
    }
  };

  // Listen for key presses when in rebinding mode
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') {
        setListening(null);
        return;
      }
      // Don't allow modifier-only keys as primary binding? Allow them, they're useful for throttle.
      inputManager.setBinding(listening, e.code);
      setBindings(inputManager.getBindings());
      setListening(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [listening, inputManager]);

  const groups = Array.from(new Set(ACTION_KEYS.map((a) => a.group)));

  // 进入设置时按存档把 HUD 阴影 DOM class 同步到位(默认开=无 class)
  useEffect(() => {
    if (typeof document === 'undefined') return;
    let off = false;
    try { off = window.localStorage.getItem('skybound.hudShadow') === 'off'; } catch { /* ignore */ }
    document.documentElement.classList.toggle('hud-shadow-off', off);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative w-full h-full overflow-y-auto" style={{ background: 'radial-gradient(ellipse at top, var(--crt-panel-3) 0%, var(--crt-bg-screen) 72%)' }}>
      <div className="absolute inset-0 pointer-events-none" style={{
        background: 'repeating-linear-gradient(0deg, transparent 0, transparent 3px, rgba(0,0,0,0.15) 4px)',
      }} />
      <div className="relative z-10 max-w-4xl mx-auto px-8 py-10 font-mono">
        <div className="flex items-center justify-between mb-8">
          <button onClick={onBack} className="text-[var(--crt-amber-dim)] hover:text-[var(--crt-amber-hi)] text-sm tracking-widest">
            {t('set.back')}
          </button>
          <h2 className="text-2xl text-[var(--crt-amber)] tracking-widest" style={{ textShadow: '0 0 12px rgba(255,176,0,0.5)' }}>
            {t('set.title')}
          </h2>
          <button
            onClick={() => {
              inputManager.resetToDefaults();
              setBindings(inputManager.getBindings());
              setInversions(inputManager.getInversions());
            }}
            className="text-xs text-[var(--crt-red)] hover:text-[var(--crt-red)] tracking-widest border border-[var(--crt-red-dim)] px-3 py-1 hover:bg-[rgba(255,59,31,0.10)]"
          >
            {t('set.reset')}
          </button>
        </div>

        {/* Language selector — prominent at the top */}
        <div className="tp-panel p-5 mb-6">
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-3">{t('set.lang')}</div>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setLocale('en')}
              className={`px-4 py-2 text-sm border tracking-widest ${locale === 'en' ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {t('set.langEn')}
            </button>
            <button
              onClick={() => setLocale('zh')}
              className={`px-4 py-2 text-sm border tracking-widest ${locale === 'zh' ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {t('set.langZh')}
            </button>
          </div>
        </div>

        {/* Cloud rendering mode selector */}
        <div className="tp-panel p-5 mb-6">
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1">{t('set.cloud')}</div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mb-3">{t('set.cloudHint')}</div>
          <div className="grid grid-cols-3 gap-3">
            <button
              onClick={() => setCloud('geometry')}
              className={`px-4 py-2 text-sm border tracking-widest ${cloudMode === 'geometry' ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {t('set.cloudGeo')}
            </button>
            <button
              onClick={() => setCloud('sprite')}
              className={`px-4 py-2 text-sm border tracking-widest ${cloudMode === 'sprite' ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {t('set.cloudSprite')}
            </button>
            {/* === 全关 (per user request: 给贴图云加个全关闭选项) ===
                贴片云不加入场景(零绘制) —— 配合"体积云"开关一起用:
                想要纯体积云就把这里也选"关"(否则体积云开着时引擎也会自动关贴片云)。 */}
            <button
              onClick={() => setCloud('off')}
              className={`px-4 py-2 text-sm border tracking-widest ${cloudMode === 'off' ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {locale === 'zh' ? '关(不画贴片云)' : 'OFF'}
            </button>
          </div>
        </div>

        {/* Cloud coverage selector — individual vs merged banks */}
        <div className="tp-panel p-5 mb-6">
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1">{t('set.cloudCov')}</div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mb-3">{t('set.cloudCovHint')}</div>
          <div className="grid grid-cols-3 gap-3">
            <button
              onClick={() => setCoverage('scattered')}
              className={`px-3 py-2 text-sm border tracking-widest ${cloudCoverage === 'scattered' ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {t('set.cloudCovScattered')}
            </button>
            <button
              onClick={() => setCoverage('mixed')}
              className={`px-3 py-2 text-sm border tracking-widest ${cloudCoverage === 'mixed' ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {t('set.cloudCovMixed')}
            </button>
            <button
              onClick={() => setCoverage('overcast')}
              className={`px-3 py-2 text-sm border tracking-widest ${cloudCoverage === 'overcast' ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {t('set.cloudCovOvercast')}
            </button>
          </div>
        </div>

        {/* SSR (Screen-Space Reflections) quality toggle */}
        <div className="tp-panel p-5 mb-6">
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1">{t('set.ssr')}</div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mb-3">{t('set.ssrHint')}</div>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setSsrOn(false)}
              className={`px-4 py-2 text-sm border tracking-widest ${!ssr ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {t('set.ssrOff')}
            </button>
            <button
              onClick={() => setSsrOn(true)}
              className={`px-4 py-2 text-sm border tracking-widest ${ssr ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {t('set.ssrOn')}
            </button>
          </div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mt-2">{t('set.ssrNote')}</div>
        </div>

        {/* === GTAO (per user request: 地面真值环境光遮蔽取代 SSAO, 默认开) === */}
        <div className="tp-panel p-5 mb-6">
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1">
            {locale === 'zh' ? 'GTAO 环境光遮蔽' : 'GTAO (GROUND-TRUTH AO)'}
          </div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mb-3">
            {locale === 'zh'
              ? '地面真值环境光遮蔽:接缝/凹陷/机体与地面接触处的遮蔽层次(本世代的外形)。全分辨率 + 泊松降噪,比旧 SSAO 干净。默认开启;关掉才会回落到旧 SSAO。'
              : 'Ground-truth ambient occlusion — contact/crevice layers on seams and aircraft-ground contact. Full-res + poisson denoise, cleaner than the old SSAO. ON by default; turning it OFF falls back to the legacy SSAO.'}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setGtaoOn(false)}
              className={`px-4 py-2 text-sm border tracking-widest ${!gtao ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {locale === 'zh' ? '关' : 'OFF'}
            </button>
            <button
              onClick={() => setGtaoOn(true)}
              className={`px-4 py-2 text-sm border tracking-widest ${gtao ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {locale === 'zh' ? '开' : 'ON'}
            </button>
          </div>
          {gtao && (
            <div className="mt-4 pt-3 border-t border-[var(--crt-amber-ghost)]">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[0.625rem] text-[var(--crt-amber-dim)] tracking-widest">
                  {locale === 'zh' ? 'GTAO 半径(米)' : 'GTAO RADIUS (m)'}
                </span>
                <span className="text-[0.625rem] text-[var(--crt-amber)] tracking-wider">{gtaoRadius.toFixed(1)}</span>
              </div>
              <input
                type="range" min={0.5} max={16} step={0.5} value={gtaoRadius}
                onChange={(e) => setGtaoRadiusValue(parseFloat(e.target.value))}
                className="w-full h-2 bg-[var(--crt-panel-3)] appearance-none cursor-pointer accent-[var(--crt-amber)]"
              />
              <div className="text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
                {locale === 'zh'
                  ? '半径是场景尺度(米),越大遮蔽范围越广、也越吃性能。1 米级 = 接缝/接触;机体翼展约 9 米。改动在下一次进入关卡时生效(关卡内可用控制台 gtao r 3 立即对照)。'
                  : 'RADIUS IS IN SCENE METRES (1 unit ≈ 1 m, wingspan ≈ 9). LARGER = WIDER OCCLUSION, MORE COST. APPLIES ON NEXT MISSION START (in-mission: console `gtao r 3`).'}
              </div>
            </div>
          )}
          <div className="text-[0.5625rem] text-[var(--crt-amber-dim)] mt-3">
            {locale === 'zh'
              ? 'GTAO 开着时旧 SSAO 不会被执行(两层 AO 相乘会把接触处压死),所以下面那一项只在 GTAO 关掉时才起作用。'
              : 'WHILE GTAO IS ON THE LEGACY SSAO IS NOT BUILT (STACKING TWO AO LAYERS CRUSHES CONTACTS), SO THE ITEM BELOW ONLY APPLIES WHEN GTAO IS OFF.'}
          </div>
        </div>

        {/* === SSAO toggle (per user request: SSAO 选项加入设置) === */}
        <div className="tp-panel p-5 mb-6">
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1">
            {locale === 'zh' ? 'SSAO 环境光遮蔽(旧)' : 'SSAO (AMBIENT OCCLUSION, LEGACY)'}
          </div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mb-3">
            {locale === 'zh'
              ? '接触处/凹陷/背缝的屏幕空间遮蔽,叠加在 CSM 太阳阴影上。默认关闭以省开销。GTAO 开着时本项不生效。'
              : 'Contact/crevice screen-space ambient occlusion layered over CSM shadows. OFF by default to save cost. INACTIVE WHILE GTAO IS ON.'}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setSsaoOn(false)}
              className={`px-4 py-2 text-sm border tracking-widest ${!ssao ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {locale === 'zh' ? '关' : 'OFF'}
            </button>
            <button
              onClick={() => setSsaoOn(true)}
              className={`px-4 py-2 text-sm border tracking-widest ${ssao ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {locale === 'zh' ? '开' : 'ON'}
            </button>
          </div>
          {ssao && (
            <div className="mt-4 pt-3 border-t border-[var(--crt-amber-ghost)]">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[0.625rem] text-[var(--crt-amber-dim)] tracking-widest">
                  {locale === 'zh' ? 'SSAO 半径' : 'SSAO RADIUS'}
                </span>
                <span className="text-[0.625rem] text-[var(--crt-amber)] tracking-wider">{ssaoRadius.toFixed(0)}</span>
              </div>
              <input
                type="range" min={2} max={24} step={1} value={ssaoRadius}
                onChange={(e) => setSsaoRadiusValue(parseFloat(e.target.value))}
                className="w-full h-2 bg-[var(--crt-panel-3)] appearance-none cursor-pointer accent-[var(--crt-amber)]"
              />
              <div className="text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
                {locale === 'zh'
                  ? '半径越大遮蔽范围越广,也越吃性能。改动在下一次进入关卡时生效。'
                  : 'LARGER RADIUS = WIDER OCCLUSION, MORE COST. APPLIES ON NEXT MISSION START.'}
              </div>
            </div>
          )}
        </div>

        {/* === 体积云 (@takram/three-clouds) ===
            原"深度整合"那版两层步进体积云已被**替换掉**(见 DEVELOPMENT.md §279-282):
            现在是引入 @takram/three-clouds 的物理体积云(BMS 云影/光柱、4 层、程序化噪声零资产)。 */}
        <div className="tp-panel p-5 mb-6">
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1">
            {locale === 'zh' ? '体积云(物理 · 4 层)' : 'VOLUME CLOUDS (PHYSICAL · 4 LAYERS)'}
          </div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mb-3">
            {locale === 'zh'
              ? '四层光线步进体积云(7200~9160 m, 在峰顶 6480 m 之上, 云顶封顶 25000 ft)+ 天气驱动的覆盖率 + BMS 云影/光柱通道; 噪声是运行时程序化生成的, 不依赖任何贴图。开启时贴片云自动让位(也可在"云渲染"里手动全关)。移动画质模式自动关闭。'
              : 'Four-layer ray-marched volume clouds (7200-9160 m, above the 6480 m summit, capped at 25,000 ft) with weather-driven coverage and the BSM shadow/light-shaft channel; noise is generated procedurally at runtime with no texture assets. Billboard clouds step aside while it is on. Auto-off in mobile mode.'}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setVolumeCloudsOn(false)}
              className={`px-4 py-2 text-sm border tracking-widest ${!volumeClouds ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {locale === 'zh' ? '关' : 'OFF'}
            </button>
            <button
              onClick={() => setVolumeCloudsOn(true)}
              className={`px-4 py-2 text-sm border tracking-widest ${volumeClouds ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {locale === 'zh' ? '开(光追云)' : 'ON (RAYMARCH)'}
            </button>
          </div>
          {volumeClouds && (
            <div className="mt-4 pt-3 border-t border-[var(--crt-amber-ghost)]">
              <div className="text-[0.625rem] text-[var(--crt-amber-dim)] tracking-widest mb-2">
                {locale === 'zh' ? '云层画质' : 'CLOUD QUALITY'}
              </div>
              <div className="grid grid-cols-3 gap-3">
                {(['low', 'med', 'high'] as const).map((q) => (
                  <button
                    key={q}
                    onClick={() => setCloudQualityValue(q)}
                    className={`px-3 py-2 text-sm border tracking-widest ${cloudQuality === q ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
                  >
                    {locale === 'zh'
                      ? (q === 'low' ? '低' : q === 'high' ? '高' : '中')
                      : (q === 'low' ? 'LOW' : q === 'high' ? 'HIGH' : 'MED')}
                  </button>
                ))}
              </div>
              <div className="text-[0.5625rem] text-[var(--crt-amber-dim)] mt-2">
                {locale === 'zh'
                  ? '高 = 96 步进 · 中 = 64 · 低 = 40;分辨率同档降采样。改动在下次进入关卡时生效。'
                  : 'HIGH = 96 STEPS · MED = 64 · LOW = 40, WITH MATCHING RESOLUTION SCALE. APPLIES ON NEXT MISSION START.'}
              </div>
            </div>
          )}
          {mobileMode && (
            <div className="text-[0.5625rem] text-[var(--crt-amber-dim)] mt-2">
              {locale === 'zh' ? '⚠ 移动画质模式已开启 —— 体积云将自动关闭。' : '⚠ MOBILE PERFORMANCE MODE IS ON — VOLUME CLOUDS STAY OFF.'}
            </div>
          )}
        </div>

        {/* === 动态模糊 (per user request: 相机角速度 CSS blur,默认关) === */}
        <div className="tp-panel p-5 mb-6">
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1">
            {locale === 'zh' ? '动态模糊' : 'MOTION BLUR'}
          </div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mb-3">
            {locale === 'zh'
              ? '相机高速转向时按角速度模糊(纯 CSS 合成,不占用 GPU 渲染;仅游戏画面,HUD 不糊)。默认关闭。'
              : 'Blurs the game canvas by camera angular velocity (pure CSS compositing, no render cost; HUD stays crisp). OFF by default.'}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setMotionBlurOn(false)}
              className={`px-4 py-2 text-sm border tracking-widest ${!motionBlur ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {locale === 'zh' ? '关' : 'OFF'}
            </button>
            <button
              onClick={() => setMotionBlurOn(true)}
              className={`px-4 py-2 text-sm border tracking-widest ${motionBlur ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {locale === 'zh' ? '开' : 'ON'}
            </button>
          </div>
          {motionBlur && (
            <div className="mt-4 pt-3 border-t border-[var(--crt-amber-ghost)]">
              <div className="text-[0.625rem] text-[var(--crt-amber-dim)] tracking-widest mb-2">
                {locale === 'zh' ? '模糊强度' : 'BLUR STRENGTH'}
              </div>
              <div className="grid grid-cols-3 gap-3">
                {(['low', 'med', 'high'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setMbStrengthValue(s)}
                    className={`px-3 py-2 text-sm border tracking-widest ${mbStrength === s ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
                  >
                    {locale === 'zh'
                      ? (s === 'low' ? '弱' : s === 'high' ? '强' : '中')
                      : (s === 'low' ? 'LOW' : s === 'high' ? 'HIGH' : 'MED')}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* === HUD 阴影/毛玻璃增强 (per user request: ShadowKit 风格,默认开) === */}
        <div className="tp-panel p-5 mb-6">
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1">
            {locale === 'zh' ? 'HUD 阴影增强' : 'HUD SHADOW BOOST'}
          </div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mb-3">
            {locale === 'zh'
              ? '给面板/按钮/发光文字追加更深的层次阴影与毛玻璃(纯 CSS,即时生效)。'
              : 'Deeper layered shadows + frosted glass for panels/buttons/glow text (pure CSS, applies instantly).'}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setHudShadowOn(false)}
              className={`px-4 py-2 text-sm border tracking-widest ${!hudShadow ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {locale === 'zh' ? '关' : 'OFF'}
            </button>
            <button
              onClick={() => setHudShadowOn(true)}
              className={`px-4 py-2 text-sm border tracking-widest ${hudShadow ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {locale === 'zh' ? '开' : 'ON'}
            </button>
          </div>
        </div>

        {/* Virtual joystick toggle (touch controls) */}
        <div className="tp-panel p-5 mb-6">
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1">{t('set.virtualJoystick')}</div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mb-3">{t('set.virtualJoystickHint')}</div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mb-3">{t('set.virtualJoystickHint')}</div>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setVjOn(false)}
              className={`px-4 py-2 text-sm border tracking-widest ${!vj ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {t('set.vjOff')}
            </button>
            <button
              onClick={() => setVjOn(true)}
              className={`px-4 py-2 text-sm border tracking-widest ${vj ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {t('set.vjOn')}
            </button>
          </div>
        </div>

        {/* Mobile performance mode toggle */}
        <div className="tp-panel p-5 mb-6">
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1">{t('set.mobileMode')}</div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mb-3">{t('set.mobileModeHint')}</div>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setMobileModeOn(false)}
              className={`px-4 py-2 text-sm border tracking-widest ${!mobileMode ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {t('set.mobileOff')}
            </button>
            <button
              onClick={() => setMobileModeOn(true)}
              className={`px-4 py-2 text-sm border tracking-widest ${mobileMode ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {t('set.mobileOn')}
            </button>
          </div>
        </div>

        {/* Difficulty selector */}
        <div className="tp-panel p-5 mb-6">
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1">{t('set.difficulty')}</div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mb-3">{t('set.difficultyHint')}</div>
          <div className="grid grid-cols-3 gap-3">
            {(['easy', 'normal', 'hard'] as const).map((d) => (
              <button
                key={d}
                onClick={() => setDifficultyTo(d)}
                className={`px-4 py-2 text-sm border tracking-widest ${difficulty === d ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
              >
                {t(d === 'easy' ? 'set.diffEasy' : d === 'hard' ? 'set.diffHard' : 'set.diffNormal')}
              </button>
            ))}
          </div>
        </div>

        {/* === Control mode (per user request: 战争雷霆式鼠标瞄准) === */}
        <div className="tp-panel p-5 mb-6">
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1">
            {locale === 'zh' ? '操作模式' : 'CONTROL MODE'}
          </div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mb-3">
            {locale === 'zh'
              ? '鼠标瞄准 = 战争雷霆式：屏幕上出现瞄准圈，移动鼠标指向哪里，机体就用偏航/滚转/俯仰三舵联动对准那里；键盘俯仰滚转仍可叠加修正。'
              : 'MOUSE AIM = WAR-THUNDER STYLE: AN AIM CIRCLE FOLLOWS THE MOUSE; THE AIRFRAME ALIGNS ITS NOSE WITH PITCH/YAW/ROLL TOGETHER; KEYBOARD INPUTS STILL BLEND IN.'}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setControlModeValue('keyboard')}
              className={`px-4 py-2 text-sm border tracking-widest ${controlMode === 'keyboard' ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {locale === 'zh' ? '键盘模式' : 'KEYBOARD'}
            </button>
            <button
              onClick={() => setControlModeValue('mouseAim')}
              className={`px-4 py-2 text-sm border tracking-widest ${controlMode === 'mouseAim' ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {locale === 'zh' ? '鼠标瞄准' : 'MOUSE AIM'}
            </button>
          </div>
          <div className="text-[0.5625rem] text-[var(--crt-amber-dim)] mt-2">
            {locale === 'zh'
              ? '改动在下一次进入关卡时生效。鼠标瞄准模式下，瞄准圈推到屏幕边缘时相机会带头转向，机头持续追击。'
              : 'APPLIES ON NEXT MISSION START. IN MOUSE-AIM MODE, PUSHING THE CIRCLE TO THE SCREEN EDGE LEADS THE CAMERA AND THE NOSE KEEPS FOLLOWING.'}
          </div>

          {/* === Mouse-aim view-centre micro-float (per user request: 视野中心微浮动) === */}
          <div className="mt-3 pt-2 border-t border-[var(--crt-amber-ghost)]">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[0.625rem] text-[var(--crt-amber-dim)] tracking-widest">
                {locale === 'zh' ? '视野中心微浮动' : 'VIEW-CENTRE FLOAT'}
              </span>
              <span className="text-[0.625rem] text-[var(--crt-amber)] tracking-wider">
                {maFloat === 0 ? (locale === 'zh' ? '锁死' : 'LOCKED') : `${Math.round(maFloat * 100)}%`}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={maFloat}
              onChange={(e) => setMaFloatValue(parseFloat(e.target.value))}
              className="w-full h-2 bg-[var(--crt-panel-3)] appearance-none cursor-pointer accent-[var(--crt-amber)]"
            />
            <div className="flex justify-between text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
              <span>{locale === 'zh' ? '锁死·不飘' : 'LOCKED'}</span>
              <span>{locale === 'zh' ? '默认 锁死' : 'DEFAULT LOCKED'}</span>
              <span>{locale === 'zh' ? '浮动' : 'FLOATY'}</span>
            </div>
            <div className="text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
              {locale === 'zh'
                ? '锁死=相机贴住视野中心球，高速飞行不飘走；浮动=保留相机拖影手感。仅鼠标瞄准模式。'
                : 'LOCKED = THE CAMERA STAYS ON THE VIEW-CENTRE BALL (NO DRIFT AT SPEED); FLOATY = CHASE-LIKE LAG. MOUSE-AIM MODE ONLY.'}
            </div>
          </div>

          {/* === Mouse-aim view sensitivity (per user request: 视角灵敏度可调) === */}
          <div className="mt-3 pt-2 border-t border-[var(--crt-amber-ghost)]">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[0.625rem] text-[var(--crt-amber-dim)] tracking-widest">
                {locale === 'zh' ? '视角灵敏度' : 'VIEW SENSITIVITY'}
              </span>
              <span className="text-[0.625rem] text-[var(--crt-amber)] tracking-wider">
                ×{maSens.toFixed(2)}
              </span>
            </div>
            <input
              type="range"
              min={0.25}
              max={2.5}
              step={0.05}
              value={maSens}
              onChange={(e) => setMaSensValue(parseFloat(e.target.value))}
              className="w-full h-2 bg-[var(--crt-panel-3)] appearance-none cursor-pointer accent-[var(--crt-amber)]"
            />
            <div className="flex justify-between text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
              <span>×0.25</span>
              <span>{locale === 'zh' ? '默认 ×1.0' : 'DEFAULT ×1.0'}</span>
              <span>×2.5</span>
            </div>
            <div className="text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
              {locale === 'zh'
                ? '鼠标移动多少视角转多少：调高转得更快更远，调低更精细。仅鼠标瞄准模式。'
                : 'HOW FAR THE VIEW TURNS PER MOUSE MOVE: HIGHER = FASTER/WIDER, LOWER = FINER. MOUSE-AIM MODE ONLY.'}
            </div>
          </div>
        </div>

        {/* Volume sliders */}
        <div className="tp-panel p-5 mb-6">
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1">{t('set.volume')}</div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mb-3">{t('set.volumeHint')}</div>
          {[
            { label: t('set.volumeMaster'), value: volMaster, set: (v: number) => setVol('skybound.volumeMaster', setVolMaster)(v) },
            { label: t('set.volumeMusic'), value: volMusic, set: setVolMusicLive },
            { label: t('set.volumeSfx'), value: volSfx, set: setVolSfxLive },
            // === Engine / airflow volume (per user request: 设置里可调) ===
            { label: t('set.volumeEngine'), value: volEngine, set: setVolEngineLive },
            { label: t('set.volumeWind'), value: volWind, set: setVolWindLive },
          ].map((row) => (
            <div key={row.label} className="mt-3 pt-2 border-t border-[var(--crt-amber-ghost)]">
              <div className="flex justify-between text-[0.625rem] mb-1">
                <span className="opacity-80 tracking-widest">{row.label}</span>
                <span className="text-[var(--crt-amber)]">{Math.round(row.value * 100)}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={row.value}
                onChange={(e) => row.set(parseFloat(e.target.value))}
                className="w-full h-2 bg-[var(--crt-panel-3)] appearance-none cursor-pointer accent-[var(--crt-amber)]"
              />
            </div>
          ))}
        </div>

        {/* Bloom quality toggle */}
        <div className="tp-panel p-5 mb-6">
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1">{t('set.bloom')}</div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mb-3">{t('set.bloomHint')}</div>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setBloomOn(false)}
              className={`px-4 py-2 text-sm border tracking-widest ${!bloom ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {t('set.bloomOff')}
            </button>
            <button
              onClick={() => setBloomOn(true)}
              className={`px-4 py-2 text-sm border tracking-widest ${bloom ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {t('set.bloomOn')}
            </button>
          </div>
          {/* === Bloom strength slider (per user request: bloom不能太亮) === */}
          {bloom && (
            <div className="mt-4 pt-3 border-t border-[var(--crt-amber-ghost)]">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[0.625rem] text-[var(--crt-amber-dim)] tracking-widest">
                  {locale === 'zh' ? 'BLOOM 强度' : 'BLOOM STRENGTH'}
                </span>
                <span className="text-[0.625rem] text-[var(--crt-amber)] tracking-wider">
                  {Math.round(bloomStrength * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.05}
                value={bloomStrength}
                onChange={(e) => setBloomStrengthValue(parseFloat(e.target.value))}
                className="w-full h-2 bg-[var(--crt-panel-3)] appearance-none cursor-pointer accent-[var(--crt-amber)]"
              />
              <div className="flex justify-between text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
                <span>0%</span>
                <span>{locale === 'zh' ? '默认 70%' : 'DEFAULT 70%'}</span>
                <span>150%</span>
              </div>
              <div className="text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
                {locale === 'zh'
                  ? '调低可减轻画面过亮；调高让夜晚/夕阳更电影感。改动在下一次进入关卡时生效。'
                  : 'LOWER TO REDUCE GLARE; HIGHER FOR CINEMATIC NIGHT/SUNSET. APPLIES ON NEXT MISSION START.'}
              </div>
            </div>
          )}
        </div>

        {/* === Camera framing + UI scale (per user request: 飞机占比/拖尾/界面缩放) === */}
        <div className="tp-panel p-5 mb-6">
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1">
            {locale === 'zh' ? '相机与界面' : 'CAMERA & UI'}
          </div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mb-3">
            {locale === 'zh' ? '相机设置在下一次进入关卡时生效。' : 'CAMERA SETTINGS APPLY ON NEXT MISSION START.'}
          </div>

          {/* Aircraft size in frame */}
          <div className="pt-2 border-t border-[var(--crt-amber-ghost)]">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[0.625rem] text-[var(--crt-amber-dim)] tracking-widest">
                {locale === 'zh' ? '飞机显示大小' : 'AIRCRAFT SIZE'}
              </span>
              <span className="text-[0.625rem] text-[var(--crt-amber)] tracking-wider">
                {cameraSize.toFixed(4)}×
              </span>
            </div>
            {/* === 暂时禁用可调镜头缩放 (per user request) =====================
                键盘模式主视角的构图已按参考图定成默认(机体约占屏宽 1/3, 机尾略偏上的后上方机位);
                这个滑块先停用, 免得再被调走。要恢复: 把 disabled 去掉、并把 engine 里
                DEFAULT_CHASE_ZOOM_MULT 那段改回读 skybound.cameraSize 即可。 */}
            <input
              type="range"
              min={0.2308}
              max={6}
              step={0.0002}
              value={cameraSize}
              disabled
              onChange={(e) => setCameraSizeValue(parseFloat(e.target.value))}
              className="w-full h-2 bg-[var(--crt-panel-3)] appearance-none cursor-not-allowed accent-[var(--crt-amber)] opacity-40"
            />
            <div className="flex justify-between text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
              <span>小 · 远 ×0.2308</span>
              <span>{`zoomMult ${(0.72 / cameraSize).toFixed(4)}`}</span>
              <span>大 · 近 ×6.0000</span>
            </div>
            <div className="text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
              {locale === 'zh'
                ? '暂时禁用：主视角构图已按参考图定为默认（机体约占屏宽 1/3、机尾略偏上的后上方机位）。游戏内滚轮仍可临时缩放。'
                : 'MULTIPLIER = MAGNIFICATION VS DEFAULT CAMERA; THE LINE BELOW IS RAW zoomMult (= 0.72 / MULTIPLIER). IN-MISSION WHEEL ZOOM STILL WORKS.'}
            </div>
          </div>

          {/* Camera trailing range */}
          <div className="mt-3 pt-2 border-t border-[var(--crt-amber-ghost)]">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[0.625rem] text-[var(--crt-amber-dim)] tracking-widest">
                {locale === 'zh' ? '相机拖尾范围' : 'CAMERA TRAILING'}
              </span>
              <span className="text-[0.625rem] text-[var(--crt-amber)] tracking-wider">
                {cameraLag.toFixed(2)}×
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={cameraLag}
              onChange={(e) => setCameraLagValue(parseFloat(e.target.value))}
              className="w-full h-2 bg-[var(--crt-panel-3)] appearance-none cursor-pointer accent-[var(--crt-amber)]"
            />
            <div className="flex justify-between text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
              <span>{locale === 'zh' ? '稳定' : 'STABLE'}</span>
              <span>{locale === 'zh' ? '默认 1.0' : 'DEFAULT 1.0'}</span>
              <span>{locale === 'zh' ? '灵活' : 'SWINGY'}</span>
            </div>
            <div className="text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
              {locale === 'zh'
                ? '拖尾越大转弯时镜头甩动越明显；调小让视角更稳定。'
                : 'HIGHER = MORE CAMERA SWING IN TURNS; LOWER = MORE STABLE.'}
            </div>
          </div>

          {/* Camera follow / recenter speed */}
          <div className="mt-3 pt-2 border-t border-[var(--crt-amber-ghost)]">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[0.625rem] text-[var(--crt-amber-dim)] tracking-widest">
                {locale === 'zh' ? '镜头跟随 / 回正速度' : 'CAMERA FOLLOW SPEED'}
              </span>
              <span className="text-[0.625rem] text-[var(--crt-amber)] tracking-wider">
                {cameraFollow.toFixed(2)}×
              </span>
            </div>
            <input
              type="range"
              min={0.5}
              max={2.5}
              step={0.05}
              value={cameraFollow}
              onChange={(e) => setCameraFollowValue(parseFloat(e.target.value))}
              className="w-full h-2 bg-[var(--crt-panel-3)] appearance-none cursor-pointer accent-[var(--crt-amber)]"
            />
            <div className="flex justify-between text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
              <span>{locale === 'zh' ? '柔和' : 'SMOOTH'}</span>
              <span>{locale === 'zh' ? '默认 1.0' : 'DEFAULT 1.0'}</span>
              <span>{locale === 'zh' ? '灵敏' : 'SNAPPY'}</span>
            </div>
            <div className="text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
              {locale === 'zh'
                ? '调大让镜头拖曳和回正更跟手（不随飞机惯性变化）。'
                : 'HIGHER = CAMERA DRAGS & RECENTERS FASTER (NOT TIED TO AIRCRAFT INERTIA).'}
            </div>
          </div>

          {/* Gun aim mode — auto-aim vs pure manual crosshair */}
          <div className="mt-3 pt-2 border-t border-[var(--crt-amber-ghost)]">
            <div className="text-[0.625rem] text-[var(--crt-amber-dim)] tracking-widest mb-2">
              {locale === 'zh' ? '机炮瞄准模式' : 'GUN AIM MODE'}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setGunAimValue('auto')}
                className={`flex-1 px-2 py-1.5 text-xs border tracking-wider ${gunAim === 'auto' ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
              >
                {locale === 'zh' ? '自动瞄准' : 'AUTO-AIM'}
              </button>
              <button
                onClick={() => setGunAimValue('manual')}
                className={`flex-1 px-2 py-1.5 text-xs border tracking-wider ${gunAim === 'manual' ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
              >
                {locale === 'zh' ? '纯机炮准心' : 'MANUAL GUN'}
              </button>
            </div>
            <div className="text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
              {locale === 'zh'
                ? '自动：锁定目标在30°锥内时机炮自动打提前量。纯准心：机炮直射，屏幕中央有机炮圈，提前量自己预估。下次进入关卡生效。'
                : 'AUTO: gun auto-leads the locked target inside a 30° cone. MANUAL: gun fires straight at the centre ring — you estimate the lead. Applies next mission.'}
            </div>
          </div>

          {/* UI scale — live */}
          <div className="mt-3 pt-2 border-t border-[var(--crt-amber-ghost)]">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[0.625rem] text-[var(--crt-amber-dim)] tracking-widest">
                {locale === 'zh' ? '界面缩放（叠加自动缩放）' : 'UI SCALE (ON TOP OF AUTO)'}
              </span>
              <span className="text-[0.625rem] text-[var(--crt-amber)] tracking-wider">
                {Math.round(uiScale * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0.7}
              max={1.5}
              step={0.05}
              value={uiScale}
              onChange={(e) => setUiScaleValue(parseFloat(e.target.value))}
              className="w-full h-2 bg-[var(--crt-panel-3)] appearance-none cursor-pointer accent-[var(--crt-amber)]"
            />
            <div className="flex justify-between text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
              <span>70%</span>
              <span>{locale === 'zh' ? '默认 100%' : 'DEFAULT 100%'}</span>
              <span>150%</span>
            </div>
            <div className="text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
              {locale === 'zh'
                ? '界面会随屏幕分辨率自动缩放，此滑杆在自动缩放基础上微调。手机小屏可调小；即时生效。'
                : 'UI AUTO-SCALES WITH RESOLUTION; THIS SLIDER FINE-TUNES ON TOP. APPLIES LIVE.'}
            </div>
          </div>
        </div>

          {/* === Terrain LOD tuning (per user request: LOD 距离/范围可调) === */}
          <div className="tp-panel p-5 mb-6">
            <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1">
              {locale === 'zh' ? '地形 LOD' : 'TERRAIN LOD'}
            </div>
            <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mb-3">
              {locale === 'zh' ? 'LOD 设置在下一次进入关卡时生效。' : 'LOD SETTINGS APPLY ON NEXT MISSION START.'}
            </div>

            {/* LOD distance scale */}
            <div className="pt-2 border-t border-[var(--crt-amber-ghost)]">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[0.625rem] text-[var(--crt-amber-dim)] tracking-widest">
                  {locale === 'zh' ? 'LOD 距离缩放' : 'LOD DISTANCE SCALE'}
                </span>
                <span className="text-[0.625rem] text-[var(--crt-amber)] tracking-wider">
                  {lodScale.toFixed(2)}×
                </span>
              </div>
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.05}
                value={lodScale}
                onChange={(e) => setLodScaleValue(parseFloat(e.target.value))}
                className="w-full h-2 bg-[var(--crt-panel-3)] appearance-none cursor-pointer accent-[var(--crt-amber)]"
              />
              <div className="flex justify-between text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
                <span>{locale === 'zh' ? '精简' : 'CHEAP'}</span>
                <span>{locale === 'zh' ? '默认 1.0' : 'DEFAULT 1.0'}</span>
                <span>{locale === 'zh' ? '精细' : 'DETAILED'}</span>
              </div>
              <div className="text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
                {locale === 'zh'
                  ? '缩放 LOD 换挡距离：调高让远处地形保持高细节（更吃性能），调低更省性能。'
                  : 'SCALES THE LOD RING DISTANCES: HIGHER KEEPS FAR TERRAIN CRISP (COSTLIER); LOWER SAVES FRAMERATE.'}
              </div>
            </div>

            {/* Forced LOD0 radius */}
            <div className="mt-3 pt-2 border-t border-[var(--crt-amber-ghost)]">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[0.625rem] text-[var(--crt-amber-dim)] tracking-widest">
                  {locale === 'zh' ? '强制高细节分块范围' : 'FORCED LOD0 CHUNK RADIUS'}
                </span>
                <span className="text-[0.625rem] text-[var(--crt-amber)] tracking-wider">
                  {lod0Radius} {locale === 'zh' ? '格' : 'RING'}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={4}
                step={1}
                value={lod0Radius}
                onChange={(e) => setLod0RadiusValue(parseFloat(e.target.value))}
                className="w-full h-2 bg-[var(--crt-panel-3)] appearance-none cursor-pointer accent-[var(--crt-amber)]"
              />
              <div className="flex justify-between text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
                <span>0</span>
                <span>{locale === 'zh' ? '默认 2' : 'DEFAULT 2'}</span>
                <span>4</span>
              </div>
              <div className="text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
                {locale === 'zh'
                  ? '玩家周围强制满精度渲染的地块圈大小：调大视野内地形更清晰（更吃性能），调小更省。'
                  : 'THE ALWAYS-FULL-DETAIL CHUNK RING AROUND THE PLAYER: BIGGER = CRISPER TERRAIN (COSTLIER); SMALLER = CHEAPER.'}
              </div>
            </div>

            {/* === Gaea 导入地形网格分辨率 (per user request: 设置里可改 mesh 分辨率) === */}
            <div className="mt-3 pt-2 border-t border-[var(--crt-amber-ghost)]">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[0.625rem] text-[var(--crt-amber-dim)] tracking-widest">
                  {locale === 'zh' ? 'Gaea 地形网格分辨率' : 'GAEA TERRAIN MESH'}
                </span>
                <span className="text-[0.625rem] text-[var(--crt-amber)] tracking-wider">
                  {terrainSegments}²
                </span>
              </div>
              <input
                type="range"
                min={256}
                max={2048}
                step={64}
                value={terrainSegments}
                onChange={(e) => setTerrainSegmentsValue(parseFloat(e.target.value))}
                className="w-full h-2 bg-[var(--crt-panel-3)] appearance-none cursor-pointer accent-[var(--crt-amber)]"
              />
              <div className="flex justify-between text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
                <span>256</span>
                <span>{locale === 'zh' ? '默认 1792' : 'DEFAULT 1792'}</span>
                <span>2048</span>
              </div>
              <div className="text-[0.5625rem] text-[var(--crt-amber-dim)] mt-1">
                {locale === 'zh'
                  ? '只影响 Gaea 导入关卡（map=custom）的地形网格细分：越高地表越细，但顶点数按平方增长（2048 时约 390 万顶点）。下次开始任务时生效。'
                  : 'SUBDIVISION OF THE GAEA-IMPORTED (map=custom) TERRAIN MESH ONLY: HIGHER = FINER GROUND, BUT VERTEX COUNT GROWS QUADRATICALLY (~3.9M AT 2048). APPLIES ON NEXT MISSION START.'}
              </div>
            </div>
          </div>

          {/* Static scene shadow toggle */}
          <div className="tp-panel p-5 mb-6">
            <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1">{t('set.staticShadow')}</div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mb-3">{t('set.staticShadowHint')}</div>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setStaticShadowOn(false)}
              className={`px-4 py-2 text-sm border tracking-widest ${!staticShadow ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {t('set.shadowOff')}
            </button>
            <button
              onClick={() => setStaticShadowOn(true)}
              className={`px-4 py-2 text-sm border tracking-widest ${staticShadow ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {t('set.shadowOn')}
            </button>
          </div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mt-2">{t('set.shadowNote')}</div>
        </div>

        {/* CSM (player aircraft dynamic self-shadow) toggle */}
        <div className="tp-panel p-5 mb-6">
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1">{t('set.csm')}</div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mb-3">{t('set.csmHint')}</div>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setCsmOn(false)}
              className={`px-4 py-2 text-sm border tracking-widest ${!csm ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {t('set.shadowOff')}
            </button>
            <button
              onClick={() => setCsmOn(true)}
              className={`px-4 py-2 text-sm border tracking-widest ${csm ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
            >
              {t('set.shadowOn')}
            </button>
          </div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mt-2">{t('set.csmNote')}</div>
        </div>

        {/* 机体自阴影: 投影贴花式(非 CSM) —— 唯一实现 */}
        <div className="tp-panel p-5 mb-6">
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1">
            {locale === 'zh' ? '投影阴影纹理(贴花式 · 非 CSM)' : 'PROJECTED SHADOW DECAL (NON-CSM)'}
          </div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mb-3">
            {locale === 'zh'
              ? '机体自阴影的做法：把机体自身的深度图当“贴花”，通过投影矩阵映射到机体表面 —— 只压太阳直射项、不动 PBR 的天光/环境反射，所以金属蒙皮的暗面仍有天光轮廓。与场景阴影（静态正交太阳 / CSM）互不影响，可单独开关。'
              : 'The airframe self-shadow: its depth map is projected onto the model like a decal. Only the direct sun term is attenuated, IBL/ambient stay intact, so metallic skin keeps its sky-lit rim. Independent of the world shadow (static sun / CSM).'}
          </div>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => {
                  setProjShadowTex(false);
                  try { window.localStorage.setItem('skybound.selfShadowMap', 'off'); } catch { /* ignore */ }
                }}
                className={`px-4 py-2 text-sm border tracking-widest ${!projShadowTex ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
              >
                {locale === 'zh' ? '关' : 'OFF'}
              </button>
              <button
                onClick={() => {
                  setProjShadowTex(true);
                  try { window.localStorage.setItem('skybound.selfShadowMap', 'on'); } catch { /* ignore */ }
                }}
                className={`px-4 py-2 text-sm border tracking-widest ${projShadowTex ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
              >
                {locale === 'zh' ? '投影贴花阴影' : 'DECAL SHADOW'}
              </button>
            </div>
            <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mt-2">
              {locale === 'zh' ? '关卡内可用控制台微调：shadowtex size 1024 / half 30 / strength 0.85 / bias 0.0025（shadowtex 单独敲可看状态）' : 'Tune in-mission: shadowtex size 1024 / half 30 / strength 0.85 / bias 0.0025'}
            </div>
        </div>

        {/* Texture quality (PBR texture tier + anisotropy) */}
        <div className="tp-panel p-5 mb-6">
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1">{t('set.textureQuality')}</div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mb-3">{t('set.textureQualityHint')}</div>
          <div className="grid grid-cols-3 gap-3">
            {(['low', 'medium', 'high'] as const).map((q) => (
              <button
                key={q}
                onClick={() => setTextureQValue(q)}
                className={`px-3 py-2 text-sm border tracking-widest ${textureQuality === q ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
              >
                {t(`set.tq${q[0].toUpperCase()}${q.slice(1)}`)}
              </button>
            ))}
          </div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mt-2">{t('set.textureQualityNote')}</div>
        </div>

        {/* PC FPS cap */}
        <div className="tp-panel p-5 mb-6">
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1">{t('set.fpsCap')}</div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mb-3">{t('set.fpsCapHint')}</div>
          <div className="grid grid-cols-5 gap-2">
            {[0, 30, 60, 120, 144].map((fps) => (
              <button
                key={fps}
                onClick={() => setFpsCapValue(fps)}
                className={`px-2 py-2 text-sm border tracking-widest ${fpsCap === fps ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
              >
                {fps === 0 ? t('set.fpsOff') : fps}
              </button>
            ))}
          </div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mt-2">{t('set.fpsCapNote')}</div>
        </div>

        {/* 渲染管线 (forward / deferred / auto) */}
        <div className="tp-panel p-5 mb-6">
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-1">{t('set.pipeline')}</div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mb-3">{t('set.pipelineHint')}</div>
          <div className="grid grid-cols-3 gap-3">
            {(['forward', 'deferred', 'auto'] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPipelineValue(p)}
                className={`px-3 py-2 text-sm border tracking-widest ${pipeline === p ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
              >
                {t(`set.pipeline${p[0].toUpperCase()}${p.slice(1)}`)}
              </button>
            ))}
          </div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mt-2">{t('set.pipelineNote')}</div>
        </div>

        {/* Inversion settings */}
        <div className="tp-panel p-5 mb-6">
          <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-3">{t('set.axisInversion')}</div>
          <div className="grid grid-cols-3 gap-3">
            {(['pitch', 'roll', 'yaw'] as (keyof InversionSettings)[]).map((axis) => (
              <button
                key={axis}
                onClick={() => {
                  inputManager.setInversion(axis, !inversions[axis]);
                  setInversions(inputManager.getInversions());
                }}
                className={`px-4 py-2 text-sm border tracking-widest ${inversions[axis] ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/6'}`}
              >
                {axis.toUpperCase()}: {inversions[axis] ? t('set.axisInverted') : t('set.axisNormal')}
              </button>
            ))}
          </div>
          <div className="text-[0.625rem] text-[var(--crt-amber-dim)] mt-2">{t('set.axisHint')}</div>
        </div>

        {/* Key bindings */}
        {groups.map((group) => (
          <div key={group} className="mb-6">
            <div className="text-xs text-[var(--crt-amber-dim)] tracking-widest mb-2">{t(`grp.${group}`)}</div>
            <div className="border border-[var(--crt-amber-deep)] bg-[var(--crt-panel-2)] divide-y divide-[var(--crt-amber-ghost)]">
              {ACTION_KEYS.filter((a) => a.group === group).map((a) => (
                <div key={a.key} className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-sm text-[var(--crt-amber-hi)]">{t(ACTION_LABEL_KEYS[a.key])}</span>
                  <button
                    onClick={() => setListening(a.key)}
                    className={`px-4 py-1.5 text-xs border min-w-[7.5rem] text-center ${
                      listening === a.key
                        ? 'border-[var(--crt-amber)] text-[var(--crt-amber)] bg-[var(--crt-amber)]/20 animate-pulse'
                        : 'border-[var(--crt-amber-deep)] text-[var(--crt-amber-hi)] hover:bg-[var(--crt-amber)]/10'
                    }`}
                  >
                    {listening === a.key ? t('set.pressKey') : prettyKey(bindings[a.key])}
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}

        <div className="text-[0.625rem] text-[var(--crt-amber-dim)] text-center mt-6">
          {t('set.footer')}
        </div>
      </div>
    </div>
  );
}
