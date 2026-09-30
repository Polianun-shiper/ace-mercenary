'use client';

// === 界面预览页(开发/验收工具) =============================================
// 为什么需要它: 结算(Results)与加载(LoadingScreen)只能由"打完一局"触发,
// headless 截图工具没有输入能力, 无法稳定复现这两屏做视觉回归。
// 这里把它们用假数据渲染出来, 于是任何一屏都能直接截图验收。
//
// 两种访问方式(渲染的是同一个 <UiPreview/>):
//   1) Next 路由:     /ui-preview?screen=results-win   (next dev)
//   2) 单文件构建:    dist-test/ui-preview.html?screen=results-win
//      —— 见 src/standalone/ui-preview-entry.tsx(只随 --dev 构建产出,
//         不进入 dist-single 发布包)。
//
// screen 取值: results-win / results-fail / loading / briefing / story-brief / hud / hud-titlecard
// 注意: 本页只读, 不写入任何 localStorage, 不启动引擎, 不参与游戏流程。
// ============================================================================

import { useEffect, useState } from 'react';
import { Results, LoadingScreen, Briefing } from '@/components/game/Menus';
import { Briefing3D } from '@/components/game/StoryBrief';
import { Results3D } from '@/components/game/Results3D';
import { Hud } from '@/components/game/Hud';
import type { HudState } from '@/lib/game/types';

type Screen = 'results-win' | 'results-fail' | 'loading' | 'briefing' | 'story-brief' | 'results-story' | 'hud' | 'hud-titlecard';

function isScreen(v: string | null): v is Screen {
  return v === 'results-win' || v === 'results-fail' || v === 'loading'
    || v === 'briefing' || v === 'story-brief' || v === 'results-story'
    || v === 'hud' || v === 'hud-titlecard';
}

// === 关卡内 HUD 的假数据 (per user request: 用预览页做确定性验收) ===
// 为什么不用真进关卡截图:48.6km/1792 段的 custom 地图构建要 ~100 秒, headless
// 截图窗口里引擎只推进到 missionTime≈2, 标题卡(3 秒)必然已经错过; 而且大地图
// 加载在 headless 下不稳定。这里用一份满负荷 HUDState(警告/无线电/波次/多种
// 武器全开)直接渲染, 于是任何 HUD 样式回归都能秒级复现。
function mockHud(): HudState {
  return {
    speed: 855, altitude: 32801, heading: 274, throttle: 0.82,
    hp: 118, maxHp: 150,
    weapons: { GUN: -1, MSL: 42, LASM: 8, BDL: 4, FLR: 12, QAAM: 6, LAAM: 4, SARH: 2, HVG: 0, CLB: 0, NKV: 0, VASM: 0 } as HudState['weapons'],
    currentWeapon: 'MSL',
    weaponSlots: [true, false],
    incomingLock: true,
    airbrakeOpen: true,
    sideCannonImpact: null,
    lockProgress: 0.72, hasLock: true,
    targetName: 'SU-35 FLANKER-E', targetDist: 4820, targetAspect: 23,
    radarBlips: [], offRadar: [],
    minimapBlips: [
      { x: 1200, z: -3400, y: 8200, type: 'enemy', id: 1, isTarget: true },
      { x: -2600, z: 1800, y: 8100, type: 'enemy', id: 2 },
      { x: 400, z: 900, y: 8200, type: 'ally', id: 3 },
      { x: -900, z: -2200, y: 8250, type: 'ally', id: 4 },
      { x: 2600, z: 2600, y: 0, type: 'neutral', id: 5 },
      { x: 300, z: -600, y: 8260, type: 'missile', id: 6 },
    ],
    screenMarkers: [
      { x: 0.62, y: 0.38, type: 'enemy', id: 1, onScreen: true, isTarget: false, dist: 4820, edgeX: 0.62, edgeY: 0.38, name: 'SU-35', modelName: 'SU-35', isNext: false, occluded: false },
      { x: 0.74, y: 0.66, type: 'enemy', id: 7, onScreen: true, isTarget: true, dist: 3100, edgeX: 0.3, edgeY: 0.52, name: 'SNOW OWL 2', modelName: 'F-15', isNext: false, occluded: false },
    ],
    velocityVector: { x: 0.36, y: 0.62 },
    noseVector: { x: 0.62, y: 0.52 },
    playerPos: { x: 0, y: 8200, z: -9000 },
    objectiveText: '摧毁山谷内敌方攻击机 4 架', objectiveProgress: '1 / 4',
    missionTime: 254, score: 48250,
    message: '关西军开始进攻雷达站!', messageTime: 2.4,
    gForce: 5.2, stall: true,
    cameraMode: 'chase', cockpit: false, cameraZoom: 1.25,
    radioMessages: [
      { id: 1, speaker: '雪鸮 2', side: 'ally', text: '你的英文很好……是美国人吗?', duration: 6, startAt: 250 },
      { id: 2, speaker: 'AWACS', side: 'awacs', text: '确认目标在峡谷内, 保持高度。', duration: 6, startAt: 251 },
      { id: 3, speaker: '敌机', side: 'enemy', text: '被咬住了 —— 全力脱离!', duration: 6, startAt: 252 },
    ],
    aoa: 12.4, energy: 0.38, loadFactor: 5.2,
    aoaOverrideActive: true, tvcActive: true,
    wingmanCommand: 'cover',
    reinforcementCooldown: 0, reinforcementsRemaining: 2,
    weather: 'storm', windSpeed: 24, stormIntensity: 0.72,
    aircraftCategory: 'fighter',
    abilities: { jammer: false, sideCannon: false, stealth: false, awacs: false },
    jammerCharge: 0, sideCannonCharge: 0,
    currentWave: 2, totalWaves: 3, waveEnemiesRemaining: 3,
    waveTransition: true, waveTransitionTime: 7,
    gunHeat: 0.45, gunOverheated: false,
    fps: 58, killFlash: 0, damageFlash: 0.2, hitConfirmFlash: 0,
    debugView: 'lit', wingmenEnabled: true,
    radarRange: 8000, radarFilter: true,
    gunshipGunLabel: '', scoreGain: 500,
  } as unknown as HudState;
}

/** 预览外壳 + 各屏假数据(被 Next 路由页与单文件入口共用) */
export function UiPreview() {
  // window.location 只在客户端可读 —— 挂载后再解析, 避免水合不一致
  const [screen, setScreen] = useState<Screen>('results-win');
  // HUD 标题卡需要"刚进关"的时间戳才会显示(3 秒窗口), 挂载时才取。
  const [hudStartedAt, setHudStartedAt] = useState(0);
  // 剧情简报的调试跳秒(?t=10 = 直接看第 4 拍"进攻箭头"), 六拍的中间几拍各只持续
  // 2-4 秒, 没有它就没法稳定截图做视觉回归。?m=s02 可以换关卡。
  const [seekT, setSeekT] = useState<number | undefined>(undefined);
  const [storyMission, setStoryMission] = useState('s01');
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const s = q.get('screen');
    const rawT = q.get('t');
    // ?t=10 = 剧情简报直接跳到第 10 秒(六拍里的中间几拍各只持续 2-4 秒)
    const v = rawT === null ? undefined : Number(rawT);
    const mm = q.get('m');
    // 整段放进微任务: effect 体内同步 setState 会触发级联渲染(react-hooks/
    // set-state-in-effect), 而这几项状态早一帧晚一帧都无所谓。
    queueMicrotask(() => {
      if (isScreen(s)) setScreen(s);
      if (v !== undefined && Number.isFinite(v) && v >= 0) setSeekT(v);
      if (mm) setStoryMission(mm);
      setHudStartedAt(Date.now());
    });
  }, []);

  if (screen === 'hud' || screen === 'hud-titlecard') {
    return (
      <div className="crt-frame crt-flicker fixed inset-0 h-full w-full overflow-hidden" style={{ background: 'var(--crt-bg)' }}>
        {/* 假背景: 用网格+地平线渐变代替 3D 场景, 让 HUD 对比度可判读 */}
        <div className="absolute inset-0" style={{
          background: 'linear-gradient(180deg, #7d8896 0%, #b9c2c9 46%, #4a3a28 52%, #241a10 100%)',
        }} />
        <div className="crt-scanlines absolute inset-0 opacity-40" />
        <Hud
          hud={mockHud()}
          missionStartedAt={screen === 'hud-titlecard' ? hudStartedAt : 0}
          missionTitle="新地形系统 · 群系雪山验证关"
          missionCodename="试验·群山雪原"
        />
      </div>
    );
  }

  return (
    <div className="crt-frame crt-flicker fixed inset-0 h-full w-full overflow-hidden" style={{ background: 'var(--crt-bg)' }}>
      {screen === 'results-win' && (
        <Results
          win
          score={48250}
          stats={{ kills: 12, time: 254, accuracy: 0.63 }}
          onContinue={() => { /* 预览页:无动作 */ }}
        />
      )}
      {screen === 'results-fail' && (
        <Results
          win={false}
          score={8140}
          stats={{ kills: 3, time: 96, accuracy: 0.21 }}
          onContinue={() => { /* 预览页:无动作 */ }}
        />
      )}
      {/* 剧情结算(3D 战绩屏): 只有打完一局才出得来, headless 下无法复现 —— 而它的旁白
          是按 `<关卡ID大写>_DEBRIEF` 查表的, 正是这类"关卡相关"的 bug 最容易漏。
          ?screen=results-story&m=s01 看第一关的 4 句, m=s02 看"本关无剧情旁白"的兜底。 */}
      {screen === 'results-story' && (
        <Results3D
          win
          score={48250}
          stats={{ kills: 12, time: 254, accuracy: 0.63 }}
          missionId={storyMission}
          onContinue={() => { /* 预览页:无动作 */ }}
        />
      )}
      {screen === 'loading' && <LoadingScreen text="正在初始化作战系统" />}
      {screen === 'briefing' && (
        <Briefing missionId="m13" onLaunch={() => { /* 预览页:无动作 */ }} onBack={() => { /* 预览页:无动作 */ }} />
      )}
      {/* 剧情简报的六拍过场: 默认 s01(手写情报), ?m=s02 看第二关。
          可加 &t=秒 直接跳到某一拍截图, 例如 ?screen=story-brief&t=10。 */}
      {screen === 'story-brief' && (
        <Briefing3D
          missionId={storyMission}
          debugStartAt={seekT}
          onDone={() => { /* 预览页:无动作 */ }}
          onSkip={() => { /* 预览页:无动作 */ }}
        />
      )}
    </div>
  );
}

export default function UiPreviewPage() {
  return <UiPreview />;
}
