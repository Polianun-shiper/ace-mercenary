'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { GameEngine } from '@/lib/game/engine';
import type { HudState, AircraftModel } from '@/lib/game/types';
import { MISSIONS, getMission } from '@/lib/game/missions';
import { Hud } from './Hud';
import { MainMenu, MissionSelect, StorySelect, Briefing, Results, LoadingScreen } from './Menus';
// 正式版剧情流程的新界面 (per user request): 3D 简报/枢纽菜单 + 3D 轨迹结算
import { Briefing3D, StoryHubMenu } from './StoryBrief';
import { Results3D } from './Results3D';
// 战斗准备 = 新 3D 机库 + 全部旧选择面板 (per user request: 不是跳进机库界面, 而是自己一屏)
import { PrepBay } from './PrepBay';
import { MultiplayerLobby, getLobby } from './MultiplayerLobby';
import { createLocalRoom, readNetLoopHash } from '@/lib/game/net/local-room';
import { recordMatchResult } from '@/lib/game/net/records';
import type { MatchResultRecord } from '@/lib/game/net/records';
import { getVibe } from '@/lib/game/net/vibe';
// 特效系统的诊断开关(默认全开; 只给自动化归因用, 见 §111)
import { FX_OFF, setFxOffFromString } from '@/lib/game/fx-toggles';
import type { MatchKind, StoryMode, VersusMode } from '@/lib/game/net/room-model';
import { Hangar, getPlayerModelSelection } from './Hangar';
import { Settings } from './Settings';
import { applyDefaultPreset, factoryShadowMode, markPresetApplied } from '@/lib/game/preset';
import { InputManager } from '@/lib/game/input';
import { getMusicPlayer } from '@/lib/game/music';
import { useT } from '@/hooks/use-i18n';
import { LangToggle } from './LangToggle';
import { VirtualJoystick } from './VirtualJoystick';
import { DebugConsole, DiagOverlay } from './DebugConsole';
// §321 云参数滑条面板(F2 / 控制台 tuner / URL #tuner)
import { CloudTuner } from './CloudTuner';
import { NetDebugPanel } from './NetDebugPanel';
import {
  installUiSoundBindings, playPowerDown, playPowerUp, playStatic, playTape,
} from '@/lib/game/ui-sound';
// Applies the global UI auto-scale (root font-size) — also covers the
// standalone single-file build which has no Next.js layout.
import { useUiScale } from '@/lib/game/ui-scale';

type Phase = 'menu' | 'multiplayer' | 'mission-select' | 'story-select' | 'story-brief' | 'story-hub'
  | 'prep' | 'hangar' | 'briefing' | 'loading' | 'playing' | 'results' | 'results-story' | 'settings';

interface ResultData {
  win: boolean;
  score: number;
  stats: { kills: number; time: number; accuracy: number };
  /** 本局飞行轨迹(世界坐标, 引擎抽稀后给) —— 3D 结算界面画空战轨迹 */
  path?: [number, number, number][];
  /** 击杀点(世界坐标) */
  killMarks?: [number, number, number][];
  /** true = 正式版剧情关卡(结算屏用 3D 轨迹版) */
  story?: boolean;
  /** 联机结算的积分板(单机为 undefined)。 */
  mp?: {
    players: { name: string; team: number; kills: number; deaths: number; isSelf: boolean }[];
    teamScores: Record<string, number>;
    selfTeam: number;
  } | null;
}

/** 联机开局的模式参数(由大厅 START 或本地回路 #netloop 传来)。 */
interface MpLaunch {
  team: number;
  mode: VersusMode | StoryMode;
  kind: MatchKind;
  respawnSec: number;
  /** 显式房间(本地双客户端回路用); 不传则取联机大厅的房间。 */
  room?: unknown;
}

export function GameApp() {
  const t = useT();
  // Global UI scale — subscribes to viewport resize + manual setting changes.
  useUiScale();
  const [phase, setPhase] = useState<Phase>('menu');
  const [missionId, setMissionId] = useState<string>(MISSIONS[0].id);
  const [hud, setHud] = useState<HudState | null>(null);
  const [result, setResult] = useState<ResultData | null>(null);
  // 从"枢纽菜单"进机库/设置时记住来路, 返回时回到枢纽而不是主菜单
  const prepFromStoryRef = useRef(false);
  const settingsFromStoryRef = useRef(false);
  const [paused, setPaused] = useState(false);
  // === 联机对局内菜单 (per user request: 对战中谁也不能暂停) ===
  // 与 paused 的关键区别: 打开菜单**不**冻结世界 —— 时间照走、你照样会被打中,
  // 只是解绑鼠标指针锁让菜单能点。联机里 ESC / P 走这条, 不走 paused。
  const [mpMenu, setMpMenu] = useState(false);
  // === 联机实时日志覆盖层 (#netlog) + 当前是否联机对局 ===
  // netLogOverlay 只在挂载时读一次 hash(与 #diag 的约定一致, 不需要响应式);
  // mpMode 每帧从引擎读太贵, 用 hud 更新时同步的状态。
  const [netLogOverlay] = useState(
    () => typeof window !== 'undefined' && window.location.hash.includes('netlog'),
  );
  const [mpMode, setMpMode] = useState(false);
  // === Mission-ending black fade (per user request: 收尾台词→渐黑→结算) ===
  // Engine calls onMissionEnding ~2.5s before the results screen so the
  // screen fades to black first.
  const [endingFade, setEndingFade] = useState(false);
  // === 进关标题卡的墙钟起点 (per user request: 显示时间+任务, 3 秒后消失) ===
  const [missionStartedAt, setMissionStartedAt] = useState<number>(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  // 当前联机房间(SDK Room 或本地回路) —— P4 结算落库要写它的 room.data
  const mpRoomRef = useRef<unknown | null>(null);
  // P4-1: 战绩归档结果(结算屏显示"已归档/离线未存")
  const [saveStatus, setSaveStatus] = useState<{ reason: string; room: boolean; career: boolean } | null>(null);
  // Shared input manager — gives Settings component access to bindings.
  const inputManagerRef = useRef<InputManager>(new InputManager());

  // Play Dawn music on menu/hangar/settings/briefing
  useEffect(() => {
    // === 着色器错误捕获 (per user request: 地形渲染排查) ===
    // Capture WebGLProgram compile errors so the test harness can read them
    // via plain property access (window.__glErrors) — console is invisible
    // to automation otherwise.
    try {
      (window as any).__glErrors = [];
      (window as any).__jsErrors = [];
      const origErr = console.error;
      console.error = (...args: unknown[]) => {
        try {
          // 着色器编译报错要**完整保留**: three 会把出错行号 + 未声明符号 +
          // 整段 shader 源码一起打印, 而 400 字符只够放下第一行(只有
          // "VALIDATE_STATUS false", 定位不了任何东西)。所以 GL 类报错单独留
          // 3000 字符, 屏上诊断(#diag)会把它摊开显示。
          const s = args.map((a) => (typeof a === 'string' ? a : String(a ?? ''))).join(' ');
          (window as any).__jsErrors.push('err:' + s.slice(0, 600));
          if ((window as any).__jsErrors.length > 60) (window as any).__jsErrors.shift();
          if (s.includes('WebGLProgram') || s.includes('Shader Error') || s.includes('THREE.WebGL') || s.toLowerCase().includes('shader')) {
            (window as any).__glErrors.push(s.slice(0, 3000));
            if ((window as any).__glErrors.length > 40) (window as any).__glErrors.shift();
          }
        } catch { /* ignore */ }
        origErr.apply(console, args);
      };
      window.addEventListener('error', (e) => {
        try {
          (window as any).__jsErrors.push(String(e.message ?? e).slice(0, 300));
          if ((window as any).__jsErrors.length > 40) (window as any).__jsErrors.shift();
        } catch { /* ignore */ }
      });
      window.addEventListener('unhandledrejection', (e) => {
        try {
          (window as any).__jsErrors.push('rej:' + String(e.reason ?? e).slice(0, 300));
          if ((window as any).__jsErrors.length > 40) (window as any).__jsErrors.shift();
        } catch { /* ignore */ }
      });
    } catch { /* ignore */ }
    // Seed the session-tuned default preset on first launch (per user request).
    applyDefaultPreset();
    const mp = getMusicPlayer();
    mp.init();
    // Browsers block autoplay until gesture — try, and resume on first click.
    mp.resume().then(() => {
      if (phase === 'menu' || phase === 'mission-select' || phase === 'story-select' || phase === 'story-brief'
        || phase === 'story-hub' || phase === 'prep' || phase === 'hangar' || phase === 'briefing' || phase === 'settings') {
        mp.setTrack('menu');
      } else if (phase === 'playing') {
        mp.setTrack('combat');
      }
    }).catch(() => {});
    // One-time gesture listener to unlock audio (per fix: 正常使用时进菜单音乐不响)
    // 原实现只调 resume(), **没有在解锁后开始播放曲目** —— 首次进菜单时
    // autoplay 被浏览器拒绝(此时还没有任何用户手势), 用户在菜单里第一次点击后
    // resume() 成功了, 却没人去 setTrack(), 于是菜单一直静音; 只有等他再点一次
    // 触发 phase 变化的 effect 才会响。修法: 解锁回调里**同时**按当前 phase 起播。
    const unlock = () => {
      mp.resume()
        .then(() => {
          if (phase === 'playing') mp.setTrack('combat');
          else mp.setTrack('menu');
        })
        .catch(() => { /* 仍被拒绝: 等下一次手势 */ });
      window.removeEventListener('click', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('click', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('click', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [phase]);

  // When leaving playing/results → back to menu, stop combat music, restart dawn
  useEffect(() => {
    // === 任务列表/简报界面都换简报曲 (per user request: 点任务栏就播简报音乐, 菜单音乐停) ====
    // story-select = 正式版剧情的关卡列表 —— 从这一屏开始就不再放菜单曲了。
    if (phase === 'story-brief' || phase === 'story-select') {
      getMusicPlayer().setTrack('briefing', 900);
    } else if (phase === 'menu' || phase === 'mission-select'
      || phase === 'story-hub' || phase === 'prep' || phase === 'hangar' || phase === 'briefing' || phase === 'settings') {
      getMusicPlayer().setTrack('menu');
    }
  }, [phase]);

  // Start mission
  const launchMission = useCallback(async (id: string, mp?: MpLaunch) => {
    setMissionId(id);
    setPhase('loading');
    setHud(null);
    setPaused(false);
    setMpMenu(false);
    // === Reset the ending black fade (per user request: 开局又渐变黑屏) ===
    // The fade overlay stayed true after a mission ended, so the NEXT
    // mission launch opened on a fully black screen.
    setEndingFade(false);
    await new Promise((r) => setTimeout(r, 60));
    const canvas = canvasRef.current;
    if (!canvas) return;
    engineRef.current?.dispose();
    // Pick a fresh combat track for this mission (random each launch).
    getMusicPlayer().pickCombatTrack();
    // Read the player's aircraft selection from localStorage (set by the Hangar).
    const sel = getPlayerModelSelection();
    const engine = new GameEngine(canvas, {
      onHudUpdate: (h) => setHud(h),
      onMissionComplete: (r) => {        // === 联机结算 (P2 收尾): 带上积分板给结算屏 ===
        const mpUi = engineRef.current?.isMultiplayer ? engineRef.current.multiplayerUi() : null;
        setResult({
          ...r,
          story: !!engineRef.current?.storyMission,
          path: r.path,
          killMarks: r.killMarks,
          mp: mpUi
            ? { players: mpUi.players, teamScores: mpUi.teamScores, selfTeam: mpUi.selfTeam }
            : null,
        });
        setPhase('results');
        // 进结算屏 = 对局结束, 菜单/暂停状态一并清掉(结算屏不该压着菜单)。
        setMpMenu(false);
        setPaused(false);
      },
      onReady: () => {
        // === 进关标题卡计时起点 (per user request: 高堡奇人式字幕 3 秒后消失) ===
        // 用渲染出的墙钟时间而不是 hud.missionTime: 后者由引擎推进, 进关瞬间
        // 还在 0 附近抖动; 标题卡要的是"进关那一刻"的绝对起点。
        setMissionStartedAt(Date.now());
        setPhase('playing');
      },
      // === Ending fade (per user request) ===
      onMissionEnding: () => setEndingFade(true),
      // === P4-1: 联机结算落库 ===
      // 引擎产出权威结果 → 这里(持有 SDK 与存档作用域)归档:
      //   room.data 由房主写当局记录; 每个玩家只写自己的生涯(client.save)。
      onMultiplayerResult: (rec: MatchResultRecord, selfScore: number) => {
        void recordMatchResult(getVibe(), mpRoomRef.current, rec, { selfScore })
          .then((out) => {
            setSaveStatus({ reason: out.reason, room: out.room, career: out.career });
            (window as unknown as { __lastSave?: unknown }).__lastSave = out;
          })
          .catch(() => setSaveStatus({ reason: 'error', room: false, career: false }));
      },
    }, {
      playerModel: sel.model as AircraftModel,
      paintScheme: sel.paint,
      // Shared input manager — the VirtualJoystick writes touch input into
      // the same instance the engine polls every frame.
      inputManager: inputManagerRef.current,
    });
    engineRef.current = engine;
    const m = getMission(id);
    if (!m) return;
    // === 联机对局准备 (P2 收尾) ===
    // 必须在 startMission 之前: 翻转/中队僚机都在 startMission 里按模式生成。
    if (mp) {
      engine.prepareNetMatch({ team: mp.team, mode: mp.mode, kind: mp.kind, respawnSec: mp.respawnSec, name: 'PILOT' });
    }
    engine.startAudio();
    // === Safety timeout (per user request: 关卡读条卡住进不去) ===
    // If startMission hasn't called onReady within 8 seconds (extremely
    // unlikely now that OBJ loading is disabled, but defensive), force the
    // phase to 'playing' so the user isn't stuck on the loading screen.
    // The engine's render loop will still run; if startMission eventually
    // completes, onReady fires and we're already in 'playing' (no-op).
    // §358b: 固定超时(8s/30s)会**提前撤掉 loading 屏** —— 而"开屏字幕 + 渐变亮屏"
    // 必须等着色器编译完(实测冷启动整段预热可达 60 s: 云场就占 ~49 s)。
    // 改成**卡住检测**: 只要引擎还在推进预热阶段(__loadStage 在变)就继续等;
    // 只有当同一个阶段 20 s 没动静(真的挂了)才强行进 playing, 免得用户干等。
    let wdStage = '';
    let wdStuck = 0;
    const watchdog = window.setInterval(() => {
      const st = (window as unknown as { __loadStage?: string }).__loadStage ?? '';
      if (st === 'ready') { window.clearInterval(watchdog); return; }
      if (st !== wdStage) { wdStage = st; wdStuck = 0; return; }
      wdStuck += 1000;
      if (wdStuck > 20000) {
        console.warn('[GameApp] 预热阶段 "' + st + '" 卡住 20s — force-entering playing phase');
        setPhase('playing');
        window.clearInterval(watchdog);
      }
    }, 1000);
    try {
      await engine.startMission(m);
    } catch (err) {
      console.error('[GameApp] startMission() threw:', err);
      setPhase('playing'); // let the user see the canvas even on error
    } finally {
      window.clearInterval(watchdog);
    }
    // === 战斗链路绑定 (P2 收尾): 机体已就位, 现在才挂房间 ===
    // 顺序很重要 —— 提前挂会在机体建好前发出一串 (0,0,0) 快照。
    if (mp) {
      // room 显式给出时(本地双客户端回路 #netloop)直接用; 否则取联机大厅的房间。
      const room = mp.room ?? getLobby().roomInstance;
      mpRoomRef.current = room ?? null;
      if (room) engine.attachNetRoom(room, 'PILOT');
    }
    const onResize = () => engine.resize();
    window.addEventListener('resize', onResize);
    (engine as any)._onResize = onResize;
  }, []);

  // ==========================================================================
  // 大厅 → 战场绑定 (P2 收尾)
  // ==========================================================================
  // 房主按下 START 后, RoomLobby 会把 startAt 广播给全房; 每个客户端在这里
  // **各自**进入战场(同一关卡/模式/分队), 然后把房间挂到引擎上。
  // 用 ref 去重: onUpdate 每次状态变化都会回调, 只在第一次开战时触发。
  //
  // ⚠ 只在**联机大厅屏**订阅: getLobby() 会把 VibeHub SDK 拉进来, 在主菜单就建
  // 实例会让 SDK 尝试登录/弹窗(实测主菜单出现"[vibe] 登录失败: 请允许弹窗"),
  // 这对单机玩家是纯打扰。进了联机屏才需要这条订阅。
  const mpLaunchedRef = useRef(false);
  useEffect(() => {
    if (phase !== 'multiplayer') return undefined;
    const lobby = getLobby();
    const off = lobby.onUpdate((s) => {
      if (!s.startAt || mpLaunchedRef.current) return;
      mpLaunchedRef.current = true;
      const self = s.players.find((p) => p.isSelf);
      const team = self?.team ?? 0;
      const mid = s.settings.missionId || MISSIONS[0].id;
      void launchMission(mid, {
        team,
        mode: s.settings.mode,
        kind: s.settings.kind,
        respawnSec: s.settings.respawnDelaySec,
      });
    });
    return off;
  }, [launchMission, phase]);

  // 离开联机对局(回到菜单/任务选择)时重置去重标记, 以便再次开战。
  useEffect(() => {
    if (phase === 'menu' || phase === 'multiplayer') mpLaunchedRef.current = false;
  }, [phase]);

  // ==========================================================================
  // 阶段 5: 终端 UI 音效与切屏动效
  // ==========================================================================
  // ① 菜单阶段安装"全局音效委托"(点击控件=继电器 / 方向键导航=继电器 /
  //    Enter=确认 / Esc=返回)。战斗阶段不装 —— 那时的点击与按键是操作飞机。
  useEffect(() => {
    const menuPhase = phase === 'menu' || phase === 'multiplayer' || phase === 'mission-select'
      || phase === 'story-select' || phase === 'story-brief' || phase === 'story-hub' || phase === 'prep'
      || phase === 'hangar' || phase === 'briefing' || phase === 'settings' || phase === 'results' || phase === 'results-story';
    if (!menuPhase) return undefined;
    return installUiSoundBindings();
  }, [phase]);

  // ② 切屏音与动效: 进任务 = CRT 断电(音效 + 0.62s 塌缩白闪), 任务就绪 = 高压开机,
  //    磁带任务库 = 走带, 其余菜单之间切换 = 短促静电。
  const prevPhaseRef = useRef<Phase>('menu');
  /** #autotest 的自动开局只允许发生一次 —— 见 auto-start effect 里的说明。 */
  const autoStartedRef = useRef(false);
  const [powerFlash, setPowerFlash] = useState(false);
  useEffect(() => {
    const from = prevPhaseRef.current;
    if (from === phase) return;
    prevPhaseRef.current = phase;
    const isMenu = (p: Phase) => p === 'menu' || p === 'multiplayer' || p === 'mission-select'
      || p === 'hangar' || p === 'briefing' || p === 'settings' || p === 'results';
    if (phase === 'loading') {
      playPowerDown();
      setPowerFlash(true);
      const id = window.setTimeout(() => setPowerFlash(false), 700);
      return () => window.clearTimeout(id);
    }
    if (phase === 'playing') { playPowerUp(); return undefined; }
    if (phase === 'mission-select' || phase === 'story-select' || phase === 'story-brief' || phase === 'story-hub' || phase === 'prep') { playTape(); return undefined; }
    if (isMenu(from) && isMenu(phase)) playStatic();
    return undefined;
  }, [phase]);

  // === 本地双客户端回路 (#netloop=<房号>&team=<0|1>) ===
  // 用 BroadcastChannel 假一个房间, 让**同一浏览器的两个标签页**像真联机一样
  // 互发 20Hz 快照与可靠事件 —— 于是"两个客户端真的连起来"这条链路可以在本机
  // 无 SDK、无上传的情况下端到端验证(见 net/local-room.ts)。
  // 每局只开一次(ref 去重; React 严格模式下 effect 会跑两遍)。
  const netLoopLaunchedRef = useRef(false);
  useEffect(() => {
    const cfg = readNetLoopHash();
    if (!cfg || netLoopLaunchedRef.current) return;
    netLoopLaunchedRef.current = true;
    // === 本地回路用轻量地图(测试专用) ===
    // 默认首关是 4.8 万单位的 Gaea custom 地图 + 1792 段地形, headless 软渲染下
    // 每帧要几十毫秒到几秒, 两个标签页一起跑会把游戏循环压到 <1fps, 联机链路
    // (发包/插值/结算)就测不准。回路模式下换成 ocean 地图 + 移动端段数:
    // 场景极大变轻, 两个客户端都能跑到接近 20Hz 的发送频率。
    try {
      window.localStorage.setItem('skybound.mapOverride', 'ocean');
      window.localStorage.setItem('skybound.mobileMode', 'on');
    } catch { /* ignore */ }
    const room = createLocalRoom(cfg.roomId, `PILOT-T${cfg.team}`);
    const mid = (/mission=([a-z0-9_]+)/.exec(window.location.hash)?.[1]) ?? MISSIONS[0].id;
    void launchMission(mid, {
      team: cfg.team,
      mode: cfg.mode,
      kind: cfg.kind,
      respawnSec: 13,
      room,
    });
  }, [launchMission]);

  // === P4-3: 联机负载压测 hook (#autotest&loadtest) ===
  // 进关后就绪后跑一次 engine.netLoadTest()(8 人 × 5 单位 @20Hz + 本关 AI),
  // 结果写 window.__netLoad 供自动化断言(净码层单帧开销 / 带宽外推)。
  useEffect(() => {
    if (typeof window === 'undefined' || !window.location.hash.includes('loadtest')) return undefined;
    let done = false;
    const id = window.setInterval(() => {
      const eng = engineRef.current as unknown as {
        netLoadTest?: (o?: unknown) => unknown; missionReady?: boolean;
      } | null;
      if (!eng?.netLoadTest || !eng.missionReady || done) return;
      done = true;
      try {
        (window as unknown as { __netLoad?: unknown }).__netLoad = eng.netLoadTest({
          peers: 8, unitsPerPeer: 5, hz: 20, seconds: 4,
        });
      } catch (err) {
        (window as unknown as { __netLoad?: unknown }).__netLoad = { ok: false, error: String(err) };
      }
      window.clearInterval(id);
    }, 700);
    return () => window.clearInterval(id);
  }, []);

  // === 自动化测试钩子 (验证用, #autotest 才触发) ===
  // 直接进第一关 + 按 hash 设管线,便于浏览器自动化截图验证。
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.hash.startsWith('#autotest')) {
      try {
        if (window.location.hash.includes('deferred')) {
          window.localStorage.setItem('skybound.pipeline', 'deferred');
        } else {
          window.localStorage.setItem('skybound.pipeline', 'forward');
        }
        // #projshadow 打开投影贴花式阴影(验证用: 引擎在造机体时读该项, 必须在构造前写)
        if (window.location.hash.includes('projshadow')) {
          window.localStorage.setItem('skybound.selfShadowMap', 'on');
        }
        // #vcloud 打开体积云 v2(验证用: 设置是任务开始时读的, 必须在引擎构造前写)
        if (window.location.hash.includes('vcloud')) {
          window.localStorage.setItem('skybound.volumeClouds', 'on');
        }
        // === #takramclouds / #notakramclouds: @takram/three-clouds 体积云 (Phase 0 验证) ===
        // 引擎在构造期读这些键 ⇒ 必须在构造前写。质量档复用 skybound.cloudQuality
        // (再带 tclow / tchigh 可指定 low/high, 不带则 med)。
        // ⚠ 这些 hash 会**写进 localStorage**(所以关掉页面后再开还在), 关闭用:
        //    · `&notakramclouds` 只关体积云;  `&billboards` 恢复贴片云;
        //    · `&clouddefault` 把两个键都清掉(回到出厂默认)。
        // ⚠ 'notakramclouds' 里含有 'takramclouds' ⇒ **必须先判 notakramclouds**。
        if (window.location.hash.includes('clouddefault')) {
          window.localStorage.removeItem('skybound.cloudsTakram');
          window.localStorage.removeItem('skybound.cloudBillboards');
        }
        if (window.location.hash.includes('notakramclouds')) {
          window.localStorage.setItem('skybound.cloudsTakram', 'off');
        } else if (window.location.hash.includes('takramclouds')) {
          window.localStorage.setItem('skybound.cloudsTakram', 'on');
          window.localStorage.setItem(
            'skybound.cloudQuality',
            window.location.hash.includes('tclow') ? 'low'
              : window.location.hash.includes('tchigh') ? 'high' : 'med',
          );
        }
        // === #atmosphere / #noatmosphere: 物理大气 Phase A (验证用) ============
        // 与上面几个 hash 同理: 引擎在 loadSky() 里读 `skybound.atmo`, 必须在构造前写。
        //   · `&atmosphere`   强制开启物理天空 + 物理大气透视(即使之前 `atmo off` 关过)
        //   · `&noatmosphere` 强制关闭 ⇒ 一键回到旧程序天空 + 旧高度雾
        // ⚠ 'noatmosphere' 里含有 'atmosphere' ⇒ **必须先判 noatmosphere**。
        // 注意: EXR 天空关(退路 `skybound.hdriSky=on`)与 deferred 管线一律让位
        // (见 engine.resolveAtmoOn)。
        if (window.location.hash.includes('noatmosphere')) {
          window.localStorage.setItem('skybound.atmo', 'off');
        } else if (window.location.hash.includes('atmosphere')) {
          window.localStorage.setItem('skybound.atmo', 'on');
        }
        // === #hdrisky / #nohdrisky: 旧 EXR 天空盒退路 (per user request: 三关换新天空) =
        // m13 / t00 / s01 三关**默认**已改走 Phase A 物理大气(黄昏色板见 environment.ts
        // 的 DUSK_SKY_BY_ENV)。这个 hash 是"一键切回旧 EXR 天空盒"的退路 —— 引擎在
        // 构造期读 `skybound.hdriSky`, 所以必须在构造前写:
        //   · `&hdrisky`   = 用回 EXR 天空(物理大气让位, 与改造前逐位一致)
        //   · `&nohdrisky` = 清掉该键 ⇒ 回到**默认**(物理大气)
        // ⚠ 'nohdrisky' 里含有 'hdrisky' ⇒ **必须先判 nohdrisky**。
        // 控制台里对应命令: `hdrisky on|off`(见 engine.setDebugView)。
        if (window.location.hash.includes('nohdrisky')) {
          window.localStorage.removeItem('skybound.hdriSky');
        } else if (window.location.hash.includes('hdrisky')) {
          window.localStorage.setItem('skybound.hdriSky', 'on');
        }
        // === #shafts / #noshafts: 丁达尔 / 云隙光柱 (Phase C 验证用) ==============
        // 引擎每帧读 `skybound.lightShafts` ⇒ 这个 hash 只是替你把值写进去
        // (`vcloud shafts on|off` 也是同一个键, devtools 里改立刻生效)。
        //   · `&shafts`   = 强制打开(即使当前质量档是 low —— 低档默认关)
        //   · `&noshafts` = 强制关闭(一键对照"有柱/无柱")
        // ⚠ 'noshafts' 里含有 'shafts' ⇒ **必须先判 noshafts**。
        if (window.location.hash.includes('noshafts')) {
          window.localStorage.setItem('skybound.lightShafts', 'off');
        } else if (window.location.hash.includes('shafts')) {
          window.localStorage.setItem('skybound.lightShafts', 'on');
        }
        // === #godrays / #nogodrays: 屏幕空间光柱补层 (Phase C 第二层) =============
        // 引擎每帧读 `skybound.godRays`; 这一层与上面的库 BSM 光柱是**独立的两层开关**。
        // ⚠ 'nogodrays' 里含有 'godrays' ⇒ **必须先判 nogodrays**。
        if (window.location.hash.includes('nogodrays')) {
          window.localStorage.setItem('skybound.godRays', 'off');
        } else if (window.location.hash.includes('godrays')) {
          window.localStorage.setItem('skybound.godRays', 'on');
        }
        // === #nobillboards: 结构性关掉贴片云 (per user request: "把贴片云全关了再测试") ===
        // 不加入场景(零绘制); 穿云气流信号仍然照算。体积云开着时会自动关, 这个 hash
        // 是给"不挂体积云、只想看没有贴片云的世界"这类测试用的。
        if (window.location.hash.includes('nobillboards')) {
          window.localStorage.setItem('skybound.cloudBillboards', 'off');
        } else if (window.location.hash.includes('billboards')) {
          // 注意: 'nobillboards' 里含有 'billboards' ⇒ 必须先判 nobillboards(上面的 else if)
          window.localStorage.setItem('skybound.cloudBillboards', 'on');
        }
        // #mig29 用 MiG-29 玩家机验证
        if (window.location.hash.includes('mig29')) {
          window.localStorage.setItem('skybound.playerModel', 'mig29');
        }
        // === #…&model=<id>: 指定玩家机型 ===
        // 关卡推荐机自动化用(例如 m12「风暴突破」推荐 ac130 炮艇机 —— 不指定就
        // 拿默认 F-16 测, 105mm 榴弹炮那一整套特效根本不会被触发)。
        const modelHash = /model=([a-z0-9_-]+)/.exec(window.location.hash)?.[1];
        if (modelHash) window.localStorage.setItem('skybound.playerModel', modelHash);
        // === #…&fxoff=<a,b,c>: 逐系统关掉特效(见 fx-toggles.ts) ===
        // 只改本次会话的 FX_OFF(内存), 不写 localStorage —— 玩家路径零污染。
        setFxOffFromString(/fxoff=([a-z0-9_,|]+)/.exec(window.location.hash)?.[1] ?? '');
        (window as unknown as { __fxOff?: Record<string, boolean> }).__fxOff = FX_OFF;
        // === #desktop / #mobile: 强制画质档 (per user request) ===
        // 默认已是电脑端(见 device-mode.ts 的判定), 这两个 hash 是给"想强行验证某一档"
        // 用的: #desktop 强关手机档(自动化量桌面网格: 段数 1792 而非 336),
        // #mobile 强开手机档(真机/无头想复现省电档时用)。
        if (window.location.hash.includes('desktop')) {
          window.localStorage.setItem('skybound.mobileMode', 'off');
        } else if (window.location.hash.includes('mobile')) {
          window.localStorage.setItem('skybound.mobileMode', 'on');
        }
        // === 自动化测试默认网页静音 (per user request: 测试时记得静音) ===
        // #autotest 会直接进任务放音乐/音效;除 hash 含 'sound'(#autotest-sound)
        // 外全部压到 0。用运行时音量 API(engine.audio + MusicPlayer)而不写
        // localStorage —— 免得污染用户之后的正常游玩音量设置。
        if (!window.location.hash.includes('sound')) {
          const eng = engineRef.current as unknown as {
            audio?: { setMasterVolume?(v: number): void; setEngineVolume?(v: number): void; setWindVolume?(v: number): void };
          } | null;
          try {
            eng?.audio?.setMasterVolume?.(0);
            eng?.audio?.setEngineVolume?.(0);
            eng?.audio?.setWindVolume?.(0);
            getMusicPlayer().setVolume(0);
            getMusicPlayer().setSfxVolume(0);
          } catch { /* ignore */ }
        }
        // === 自动化测试强制"出厂默认"阴影配置 (per fix: 被测路径必须是玩家路径) ====
        // 以前这里无条件写 csm='on', 理由是"验证 3A 太阳阴影路径"。问题是:
        // 它把**每一个** #autotest 截图/GL 审计都导到了 CSM 上, 于是我量到的
        // 永远是 CSM 的行为, 而不是玩家实机的默认行为 —— 排查"机体自阴影在关卡
        // 里用不了"时被这个误导了很久(实测: 之前所有探针都报 csm=true)。
        //
        // === 2026-09-23 再修: 值**从 DEFAULT_PRESET 现读**, 不再硬编码 ====
        // 原因: 出厂默认(静态正交)在这次 CSM 复测里被重新确认, 但"改默认值时必须
        // 记得同步改这里"这件事靠人肉记性 —— 一旦漏了, 自动测试量到的就是**旧行为**
        // (历史上正是这么被误导的)。现在读 preset.ts 的 factoryShadowMode() ⇒
        // 以后改 DEFAULT_PRESET 自动跟随, 这里的"预期值"永远不会漂。
        //   · `#autotest`          = 出厂默认(现在 = 静态正交太阳)
        //   · `#autotest-csm`      = 强制 CSM 级联(取证用; 见 docs/shadow-pipeline.md)
        //   · `#autotest-static`   = 强制静态正交(出厂默认换成 CSM 之后取证仍需要它)
        const hash = window.location.hash;
        const factory = factoryShadowMode();
        const wantCsm = hash.includes('csm') ? true : hash.includes('static') ? false : factory.csm;
        window.localStorage.setItem('skybound.staticShadow', wantCsm ? 'off' : 'on');
        window.localStorage.setItem('skybound.csm', wantCsm ? 'on' : 'off');
        // ⚠ 必须: 否则 applyDefaultPreset() 的 v1→v2 迁移会把刚写进去的值当"旧默认值"
        // 改回去(实测: `#autotest-static` 会被 csm on→off 那条迁移反过来吃掉)。
        markPresetApplied();
      } catch { /* ignore */ }
      const first = MISSIONS[0];
      // === #…&mission=<id>: 指定关卡(默认第一关) ===
      // 风暴关(m12 风暴突破 / m05 风暴航线 / m03 钢铁风暴)"慢"的取证必须能
      // **直接进那一关** —— 否则只能拿第一关(晴天)当代理, 量出来的不是风暴关。
      const missionHash = /mission=([a-z0-9_]+)/.exec(window.location.hash)?.[1];
      const auto = (missionHash ? getMission(missionHash) : undefined) ?? first;
      // === 本地双客户端回路 (#netloop=…) 时**不要**自动开单机任务 ===
      // 由下面的 netloop effect 负责按本地房间参数开局(否则会开两局)。
      // === 自动开局只跑一次 (per fix: 反复重入 startMission 会"加载卡住 + 密集长卡顿") ===
      // launchMission 每次都会 dispose 旧引擎并重新 startMission(含模型/天空/资产/预热);
      // 若这个 effect 因任何依赖变化被重跑, 就会不断打断上一次加载 —— 表现为: 关卡永远进不去,
      // 且每几帧一次 140~190ms 长卡顿(反复重跑预热)。加一次性闸门后与 effect 依赖无关。
      if (auto && !readNetLoopHash(window.location.hash) && !autoStartedRef.current) {
        autoStartedRef.current = true;
        launchMission(auto.id);
      }
      // #ssgi / #roughness:进任务后自动开对应 debug 视图(验证用,等引擎就绪)。
      const wantView = window.location.hash.includes('ssgi') ? 'ssgi'
        : window.location.hash.includes('roughness') ? 'roughness' : null;
      if (wantView) {
        const t = window.setInterval(() => {
          const eng = engineRef.current as unknown as { debugView?: string; ended?: boolean } | null;
          if (eng && eng.debugView !== undefined && eng.ended === false) {
            (eng as unknown as { debugView: string }).debugView = wantView;
            window.clearInterval(t);
          }
        }, 500);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // === 联机链路自测 hook (#mptest) ===
  // 单机环境里跑通"远端实体/命中路由/受击/击毁复活/中队僚机/敌我翻转"整条链路
  // (见 engine.multiplayerSelfTest), 并把结果写到 window.__mpSelfTest 供自动化断言;
  // 顺带打开联机 UI 模拟, 让 HUD 的积分板/击杀信息/复活面板在截图里可见。
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    if (!window.location.hash.includes('mptest')) return undefined;
    const wantSelfTest = window.location.hash.includes('mptest-now');
    let testDone = false;
    let simDone = false;
    const id = window.setInterval(() => {
      const eng = engineRef.current as unknown as {
        multiplayerSelfTest?: () => unknown;
        debugMultiplayerSim?: (on: boolean) => boolean;
        missionReady?: boolean;
      } | null;
      if (!eng?.multiplayerSelfTest) return;
      // 必须等 startMission **真正完成**(机体/武器已建好)才能跑自测 —— 否则
      // respawnPlayer()/spawnSquadron() 会在 player 尚未创建时抛异常。
      // (不能用 phase: 引擎 8 秒安全超时会把 phase 提前改成 playing)
      if (!eng.missionReady) return;
      // 先把整条链路自测跑一遍(可选, 由 #mptest-now 触发)
      if (wantSelfTest && !testDone) {
        testDone = true;
        const result = eng.multiplayerSelfTest();
        (window as unknown as { __mpSelfTest?: unknown }).__mpSelfTest = result;
      }
      // 再打开联机 UI 模拟(积分板/击杀信息在截图里可见)
      if (!simDone && (testDone || !wantSelfTest)) {
        simDone = true;
        eng.debugMultiplayerSim?.(true);
        window.clearInterval(id);
      }
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  // Sync paused state
  useEffect(() => {
    engineRef.current?.setPaused(paused);
  }, [paused]);
  // Sync 联机对局菜单(不暂停, 只解绑指针锁)
  useEffect(() => {
    engineRef.current?.setInGameMenu(mpMenu);
  }, [mpMenu]);

  // === 联机对局检测 (供 #netlog 覆盖层用) ===
  // 房间是在 startMission 之后才挂上的, 所以 onReady 时问引擎可能还是 false;
  // 这里挂在 hud 更新上, 一旦引擎确认联机就置一次 true(之后短路, 不再触发渲染)。
  useEffect(() => {
    if (mpMode || phase !== 'playing') return;
    if (engineRef.current?.isMultiplayer) setMpMode(true);
  }, [hud, phase, mpMode]);

  // Re-read live-relevant settings (render pipeline) when a mission starts,
  // so a pipeline change made in Settings applies even without a full
  // engine recreation. (The constructor already reads it — this makes the
  // refreshPipelineFromStorage API live, as the debug console will use it.)
  useEffect(() => {
    if (phase === 'playing' && engineRef.current) {
      try {
        (engineRef.current as unknown as { refreshPipelineFromStorage?: () => void })
          .refreshPipelineFromStorage?.();
      } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // === 调试控制台打开时 P/Esc 暂停键让位 (per user request: ` 键控制台) ===
      // The debug console has its own P/Esc handling while open — don't
      // fight it with the game pause toggles.
      if ((window as any).__debugConsoleOpen) return;
      // === 长按不重复触发 (per user request: 按住 esc 也不该出问题) ===
      // 浏览器的自动重复会每秒送来几十个 keydown, 不加这道闸就会疯狂来回翻转。
      if (e.repeat) return;
      // === 联机对局: 一律不暂停, 改开"不冻结"的对局菜单 (per user request) ===
      // 联机里时间静止=作弊(对手在打你时按一下就被冻住), 所以 ESC/P 只切菜单;
      // 菜单开着世界照跑, 引擎侧 setPaused() 也会拒绝联机暂停(双保险)。
      if (phase === 'playing' && (e.code === 'KeyP' || e.code === 'Escape')) {
        if (engineRef.current?.isMultiplayer) setMpMenu((m) => !m);
        else setPaused((p) => !p);
      }
      // === 联机复活 (P2 收尾): 13 秒倒计时结束后按 Enter 重返战场 ===
      // 单机下 respawnPlayer() 直接返回 false(不是联机对局), 零影响。
      if (e.code === 'Enter' && phase === 'playing') {
        engineRef.current?.respawnPlayer();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase]);

  // Cleanup on unmount or phase change away from playing
  useEffect(() => {
    if (phase !== 'playing' && phase !== 'loading' && phase !== 'results') {
      if (engineRef.current) {
        const onR = (engineRef.current as any)._onResize;
        if (onR) window.removeEventListener('resize', onR);
        engineRef.current.dispose();
        engineRef.current = null;
      }
    }
  }, [phase]);

  return (
    <div className="fixed inset-0 w-full h-full overflow-hidden bg-black text-white">
      {(phase === 'loading' || phase === 'playing' || phase === 'results') && (
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full"
          style={{ display: 'block' }}
        />
      )}

      {phase === 'menu' && (
        <MainMenu
          onPlay={() => setPhase('mission-select')}
          onStory={() => setPhase('story-select')}
          onHangar={() => setPhase('hangar')}
          onSettings={() => setPhase('settings')}
          onMultiplayer={() => setPhase('multiplayer')}
        />
      )}

      {phase === 'multiplayer' && (
        <div className="absolute inset-0 z-30 overflow-y-auto bg-[var(--crt-bg)]">
          <MultiplayerLobby onBack={() => setPhase('menu')} />
        </div>
      )}

      {phase === 'mission-select' && (
        <MissionSelect
          onSelect={(id) => {
            setMissionId(id);
            setPhase('briefing');
          }}
          onBack={() => setPhase('menu')}
        />
      )}

      {/* 正式版剧情菜单 (per user request): 选完同样进 briefing, 机型/僚机/挂载流程不变 */}
      {phase === 'story-select' && (
        <StorySelect
          onSelect={(id) => {
            setMissionId(id);
            // 正式版剧情: 先看 3D 简报(per user request: 简报只在正式版关卡用)
            setPhase('story-brief');
          }}
          onBack={() => setPhase('menu')}
        />
      )}

      {/* === 3D 简报界面 (per user request: 皇牌空战那种 3D 简报) === */}
      {phase === 'story-brief' && (
        <Briefing3D
          missionId={missionId}
          onDone={() => setPhase('story-hub')}
          onSkip={() => setPhase('story-hub')}
        />
      )}

      {/* === 简报之后的枢纽菜单: 战斗准备 / 重播简报 / 调整设置 / 退出到任务选择 === */}
      {phase === 'story-hub' && (
        <StoryHubMenu
          missionId={missionId}
          onSortie={() => { launchMission(missionId); }}
          onPrep={() => setPhase('prep')}
          onReplayBriefing={() => setPhase('story-brief')}
          onSettings={() => { settingsFromStoryRef.current = true; setPhase('settings'); }}
          onExit={() => setPhase('story-select')}
        />
      )}

      {phase === 'briefing' && (
        <Briefing
          missionId={missionId}
          onLaunch={() => launchMission(missionId)}
          onBack={() => setPhase('mission-select')}
        />
      )}

      {/* === 战斗准备: 新 3D 机库 + 旧的选择面板 (per user request) === */}
      {phase === 'prep' && (
        <PrepBay
          missionId={missionId}
          onBack={() => setPhase('story-hub')}
          onLaunch={() => launchMission(missionId)}
        />
      )}

      {phase === 'hangar' && (
        <Hangar onBack={() => setPhase(prepFromStoryRef.current ? 'story-hub' : 'menu')} />
      )}

      {phase === 'settings' && (
        <Settings
          onBack={() => { const toStory = settingsFromStoryRef.current; settingsFromStoryRef.current = false; return setPhase(toStory ? 'story-hub' : 'menu'); }}
          inputManager={inputManagerRef.current}
        />
      )}

      {phase === 'loading' && <LoadingScreen text="正在初始化作战系统" />}

      {phase === 'playing' && (
        <>
          <Hud
            hud={hud}
            // === 进关标题卡 (per user request: 高堡奇人式白字黑边 3 秒字幕) ===
            missionStartedAt={missionStartedAt}
            missionTitle={getMission(missionId)?.title ?? ''}
            missionCodename={getMission(missionId)?.codename ?? ''}
            // === Click-to-target (per user request) ===
            // Left-click an enemy's radar box on the HUD to switch target.
            onSelectUnit={(id) => engineRef.current?.selectTargetById(id)}
            // === 联机复活 (P2 收尾) ===
            onRespawn={() => engineRef.current?.respawnPlayer()}
          />
          {/* On-screen virtual joystick for touch devices (z-30: above HUD,
              below the z-40 pause overlay). Auto-ON for touch; toggle in
              Settings / MainMenu. */}
          <DebugConsole getEngine={() => engineRef.current} />
          {/* §321 体积云参数滑条(默认不存在; 控制台  / F2 / URL #tuner 才出现) */}
          <CloudTuner getEngine={() => engineRef.current} />
          {/* 屏上诊断: URL 带 #diag 时显示(上传后无法按 F12 时的现场取证) */}
          <DiagOverlay getEngine={() => engineRef.current} />
          {/* === 联机实时日志覆盖层 (per user request) ===
              战斗中想不暂停就看链路? URL 加 #netlog 即在左下角常驻滚动的
              联机日志(SDK/登录/peer/快照/命中/抗作弊)。与 #diag 同一套约定:
              不带 hash 时完全不存在, 零干扰; 上传后出问题时让玩家加个 #netlog
              就能取到现场。 */}
          {netLogOverlay && mpMode && (
            <div className="pointer-events-auto absolute bottom-3 left-3 z-30 w-[34rem] max-w-[46vw]">
              <NetDebugPanel maxHeight={190} />
            </div>
          )}
          <VirtualJoystick
            inputManager={inputManagerRef.current}
            onPause={() => (engineRef.current?.isMultiplayer ? setMpMenu(true) : setPaused(true))}
          />
          {/* Language toggle — top-right corner, available during gameplay */}
          <div className="absolute top-3 right-3 z-40" style={{ marginTop: '4rem' }}>
            <LangToggle />
          </div>
          {/* === Mission-ending black fade (per user request) === */}
          {endingFade && (
            <div className="absolute inset-0 z-50 pointer-events-none bg-black" style={{ animation: 'fade-to-black 2.5s forwards' }} />
          )}
          {(paused || mpMenu) && (
            <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm font-mono">
              <div className="text-center">
                <div className="text-[var(--crt-amber)] tracking-[0.4em] text-sm mb-2">
                  {mpMenu ? t('pause.mpSimRunning') : t('pause.simPaused')}
                </div>
                <h2 className="text-5xl font-black tracking-tighter mb-8">
                  {mpMenu ? t('pause.mpTitle') : t('pause.title')}
                </h2>
                <div className="flex gap-3 justify-center">
                  <button
                    onClick={() => (mpMenu ? setMpMenu(false) : setPaused(false))}
                    className="border-2 border-[var(--crt-amber)]/80 hover:border-[var(--crt-amber)] px-8 py-2 text-[var(--crt-amber)] tracking-widest hover:bg-[var(--crt-amber)]/10"
                  >
                    {mpMenu ? t('pause.mpResume') : t('pause.resume')}
                  </button>
                  <button
                    onClick={() => {
                      engineRef.current?.dispose();
                      engineRef.current = null;
                      setMpMenu(false);
                      setPaused(false);
                      setPhase('settings');
                    }}
                    className="border-2 border-[var(--crt-line)]/60 hover:border-[var(--crt-line)] px-8 py-2 text-[var(--crt-amber-hi)] tracking-widest hover:bg-[var(--crt-amber)]/10"
                  >
                    {t('pause.settings')}
                  </button>
                  <button
                    onClick={() => {
                      engineRef.current?.dispose();
                      engineRef.current = null;
                      setMpMenu(false);
                      setPaused(false);
                      setPhase('menu');
                    }}
                    className="border-2 border-red-400/60 hover:border-red-400 px-8 py-2 text-red-300 tracking-widest hover:bg-red-400/10"
                  >
                    {t('pause.abort')}
                  </button>
                  {/* === 联机: 房主结束本局 (P2 收尾) ===
                      积分板判定胜负并广播 matchend, 全房一起进结算屏。 */}
                  {engineRef.current?.isMultiplayer && (
                    <button
                      onClick={() => {
                        engineRef.current?.endMatchAsHost();
                        setMpMenu(false);
                        setPaused(false);
                      }}
                      className="border-2 border-[var(--crt-amber)]/80 hover:border-[var(--crt-amber)] px-8 py-2 text-[var(--crt-amber)] tracking-widest hover:bg-[var(--crt-amber)]/10"
                    >
                      {t('pause.endMatch')}
                    </button>
                  )}
                </div>
                {/* === 联机实时日志 (per user request) ===
                    战斗中按不了 F12, 所以暂停即见: 快照收发/命中路由/抗作弊拒绝
                    全部实时滚动, 复现问题不用再靠猜。 */}
                {engineRef.current?.isMultiplayer && (
                  <div className="mt-6 w-[46rem] max-w-[80vw] text-left">
                    <NetDebugPanel maxHeight={200} />
                  </div>
                )}
                <div className="text-xs text-[var(--crt-amber-hi)]/40 mt-6">
                  {mpMenu ? t('pause.mpHint') : t('pause.hint')}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {phase === 'results' && result && (
        result.story ? (
        <Results3D
          win={result.win}
          score={result.score}
          stats={result.stats}
          missionId={missionId}
          path={result.path}
          killMarks={result.killMarks}
          mp={result.mp ?? null}
          saveStatus={saveStatus}
          onContinue={() => {
            engineRef.current?.dispose();
            engineRef.current = null;
            setPhase('story-select');
          }}
        />
        ) : (
        <Results
          win={result.win}
          score={result.score}
          stats={result.stats}
          mp={result.mp ?? null}
          saveStatus={saveStatus}
          onContinue={() => {
            // 联机对局结束后离开房间(SDK 的 owner 过期机制会回收房间) ——
            // 否则回主菜单后再开一局会复用同一个房间状态。
            if (result.mp) {
              try { getLobby().leave(); } catch { /* ignore */ }
            }
            engineRef.current?.dispose();
            engineRef.current = null;
            setPhase('mission-select');
          }}
        />
        )
      )}

      {/* === 阶段 5: 进任务时的 CRT 断电白闪 ===
          与 ui-sound 的 playPowerDown() 同时触发, 动画长度同为零点六二秒。 */}
      {powerFlash && <div className="crt-powerflash" />}
    </div>
  );
}
