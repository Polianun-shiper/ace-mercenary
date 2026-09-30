// §229d: GameApp 剧情流程接线
// 剧情选择 -> 3D 简报 -> 枢纽菜单(战斗准备/重播简报/调整设置/退出到任务选择 + 出击)
//   -> 战斗准备 = 机库(3D 新机库, 保留全部旧选项) -> 出击 -> 关卡 -> 3D 结算(线框地形轨迹)
const fs = require('fs');
const G = 'src/components/game/GameApp.tsx';
function rep(a, b, label, all) {
  let s = fs.readFileSync(G, 'utf8');
  const n = s.split(a).length - 1;
  if (n === 0) { console.log('skip:', label); return; }
  if (!all && n !== 1) { console.error('miss(' + n + '):', label); process.exit(1); }
  fs.writeFileSync(G, all ? s.split(a).join(b) : s.replace(a, b));
  console.log('ok:', label, '(' + n + ')');
}

// ① 相位与结算数据类型
rep(`type Phase = 'menu' | 'multiplayer' | 'mission-select' | 'story-select' | 'hangar' | 'briefing' | 'loading' | 'playing' | 'results' | 'settings';`,
`type Phase = 'menu' | 'multiplayer' | 'mission-select' | 'story-select' | 'story-brief' | 'story-hub'
  | 'hangar' | 'briefing' | 'loading' | 'playing' | 'results' | 'results-story' | 'settings';`,
 'Phase += story phases');

rep(`  stats: { kills: number; time: number; accuracy: number };
  /** 联机结算的积分板(单机为 undefined)。 */`,
`  stats: { kills: number; time: number; accuracy: number };
  /** 本局飞行轨迹(世界坐标, 引擎抽稀后给) —— 3D 结算界面画空战轨迹 */
  path?: [number, number, number][];
  /** 击杀点(世界坐标) */
  killMarks?: [number, number, number][];
  /** true = 正式版剧情关卡(结算屏用 3D 轨迹版) */
  story?: boolean;
  /** 联机结算的积分板(单机为 undefined)。 */`,
 'ResultData += path/killMarks/story');

// ② 菜单态相位集合(音乐/音效/切屏音)三处
rep(`      if (phase === 'menu' || phase === 'mission-select' || phase === 'story-select' || phase === 'hangar' || phase === 'briefing' || phase === 'settings') {`,
`      if (phase === 'menu' || phase === 'mission-select' || phase === 'story-select' || phase === 'story-brief'
        || phase === 'story-hub' || phase === 'hangar' || phase === 'briefing' || phase === 'settings') {`,
 'music phase set #1', true);
rep(`    if (phase === 'menu' || phase === 'mission-select' || phase === 'story-select' || phase === 'hangar' || phase === 'briefing' || phase === 'settings') {`,
`    if (phase === 'menu' || phase === 'mission-select' || phase === 'story-select' || phase === 'story-brief'
      || phase === 'story-hub' || phase === 'hangar' || phase === 'briefing' || phase === 'settings') {`,
 'music phase set #2', true);
rep(`      || phase === 'story-select' || phase === 'hangar' || phase === 'briefing' || phase === 'settings' || phase === 'results';`,
`      || phase === 'story-select' || phase === 'story-brief' || phase === 'story-hub'
      || phase === 'hangar' || phase === 'briefing' || phase === 'settings' || phase === 'results' || phase === 'results-story';`,
 'ui sound phase set', true);
rep(`    if (phase === 'mission-select' || phase === 'story-select') { playTape(); return undefined; }`,
`    if (phase === 'mission-select' || phase === 'story-select' || phase === 'story-brief' || phase === 'story-hub') { playTape(); return undefined; }`,
 'screen transition sfx', true);

// ③ 结算回调: 带上轨迹 + 是否剧情关
rep(`        setResult({
          ...r,`,
`        setResult({
          ...r,
          story: !!engineRef.current?.storyMission,
          path: r.path,
          killMarks: r.killMarks,`,
 'onMissionComplete payload');

// ④ 剧情选择 -> 3D 简报(而不是 2D Briefing)
rep(`      {phase === 'story-select' && (
        <StorySelect
          onSelect={(id) => {
            setMissionId(id);
            setPhase('briefing');
          }}
          onBack={() => setPhase('menu')}
        />
      )}`,
`      {phase === 'story-select' && (
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
          onPrep={() => { prepFromStoryRef.current = true; setPhase('hangar'); }}
          onReplayBriefing={() => setPhase('story-brief')}
          onSettings={() => { settingsFromStoryRef.current = true; setPhase('settings'); }}
          onExit={() => setPhase('story-select')}
        />
      )}`,
 'story-select -> story-brief + hub');

// ⑤ 机库/设置返回时回到枢纽(而不是主菜单); 机库继续保留全部旧选项
rep(`      {phase === 'hangar' && <Hangar onBack={() => setPhase('menu')} />}`,
`      {phase === 'hangar' && (
        <Hangar onBack={() => setPhase(prepFromStoryRef.current ? 'story-hub' : 'menu')} />
      )}`,
 'hangar back -> hub');
rep(`      {phase === 'settings' && (
        <Settings
          onBack={() => setPhase('menu')}`,
`      {phase === 'settings' && (
        <Settings
          onBack={() => { const toStory = settingsFromStoryRef.current; settingsFromStoryRef.current = false; return setPhase(toStory ? 'story-hub' : 'menu'); }}`,
 'settings back -> hub');

// ⑥ 结算屏: 剧情关走 3D 版
rep(`        <Results
          win={result.win}
          score={result.score}
          stats={result.stats}`,
`        {result.story ? (
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
          stats={result.stats}`,
 'results -> Results3D for story');

// ⑦ 关闭上面的三元: 原 Results 的结束标签后补 ")}"
rep(`            engineRef.current?.dispose();
            engineRef.current = null;
            setPhase('mission-select');
          }}
        />
      )}`,
`            engineRef.current?.dispose();
            engineRef.current = null;
            setPhase('mission-select');
          }}
        />
        )}
      )}`,
 'close ternary for Results');

// ⑧ 导入 + 两个 ref
rep(`import { MainMenu, MissionSelect, StorySelect, Briefing, Results, LoadingScreen } from './Menus';`,
`import { MainMenu, MissionSelect, StorySelect, Briefing, Results, LoadingScreen } from './Menus';
// 正式版剧情流程的新界面 (per user request): 3D 简报/枢纽菜单 + 3D 轨迹结算
import { Briefing3D, StoryHubMenu } from './StoryBrief';
import { Results3D } from './Results3D';`,
 'imports');
rep(`  const [result, setResult] = useState<ResultData | null>(null);`,
`  const [result, setResult] = useState<ResultData | null>(null);
  // 从"枢纽菜单"进机库/设置时记住来路, 返回时回到枢纽而不是主菜单
  const prepFromStoryRef = useRef(false);
  const settingsFromStoryRef = useRef(false);`,
 'two route refs');
console.log('§229d done');
