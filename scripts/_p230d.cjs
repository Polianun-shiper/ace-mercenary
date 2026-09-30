// §230d: GameApp 用新的 PrepBay 取代"跳进机库"
const fs = require('fs');
const G = 'src/components/game/GameApp.tsx';
function rep(a, b, label) {
  let s = fs.readFileSync(G, 'utf8');
  const n = s.split(a).length - 1;
  if (n === 0) { console.log('skip:', label); return; }
  if (n !== 1) { console.error('miss(' + n + '):', label); process.exit(1); }
  fs.writeFileSync(G, s.replace(a, b));
  console.log('ok:', label);
}
rep(`import { Results3D } from './Results3D';`,
`import { Results3D } from './Results3D';
// 战斗准备 = 新 3D 机库 + 全部旧选择面板 (per user request: 不是跳进机库界面, 而是自己一屏)
import { PrepBay } from './PrepBay';`,
 'import PrepBay');
rep(`type Phase = 'menu' | 'multiplayer' | 'mission-select' | 'story-select' | 'story-brief' | 'story-hub'
  | 'hangar' | 'briefing' | 'loading' | 'playing' | 'results' | 'results-story' | 'settings';`,
`type Phase = 'menu' | 'multiplayer' | 'mission-select' | 'story-select' | 'story-brief' | 'story-hub'
  | 'prep' | 'hangar' | 'briefing' | 'loading' | 'playing' | 'results' | 'results-story' | 'settings';`,
 'Phase += prep');
rep(`      if (phase === 'menu' || phase === 'mission-select' || phase === 'story-select' || phase === 'story-brief'
        || phase === 'story-hub' || phase === 'hangar' || phase === 'briefing' || phase === 'settings') {`,
`      if (phase === 'menu' || phase === 'mission-select' || phase === 'story-select' || phase === 'story-brief'
        || phase === 'story-hub' || phase === 'prep' || phase === 'hangar' || phase === 'briefing' || phase === 'settings') {`,
 'music phase #1');
rep(`    if (phase === 'menu' || phase === 'mission-select' || phase === 'story-select' || phase === 'story-brief'
      || phase === 'story-hub' || phase === 'hangar' || phase === 'briefing' || phase === 'settings') {`,
`    if (phase === 'menu' || phase === 'mission-select' || phase === 'story-select' || phase === 'story-brief'
      || phase === 'story-hub' || phase === 'prep' || phase === 'hangar' || phase === 'briefing' || phase === 'settings') {`,
 'music phase #2');
rep(`      || phase === 'story-select' || phase === 'story-brief' || phase === 'story-hub'
      || phase === 'hangar' || phase === 'briefing' || phase === 'settings' || phase === 'results' || phase === 'results-story';`,
`      || phase === 'story-select' || phase === 'story-brief' || phase === 'story-hub' || phase === 'prep'
      || phase === 'hangar' || phase === 'briefing' || phase === 'settings' || phase === 'results' || phase === 'results-story';`,
 'ui sound phase');
rep(`    if (phase === 'mission-select' || phase === 'story-select' || phase === 'story-brief' || phase === 'story-hub') { playTape(); return undefined; }`,
`    if (phase === 'mission-select' || phase === 'story-select' || phase === 'story-brief' || phase === 'story-hub' || phase === 'prep') { playTape(); return undefined; }`,
 'screen sfx');
rep(`          onPrep={() => { prepFromStoryRef.current = true; setPhase('hangar'); }}`,
`          onPrep={() => setPhase('prep')}`,
 'hub onPrep -> prep');
rep(`      {phase === 'hangar' && (
        <Hangar onBack={() => setPhase(prepFromStoryRef.current ? 'story-hub' : 'menu')} />
      )}`,
`      {/* === 战斗准备: 新 3D 机库 + 旧的选择面板 (per user request) === */}
      {phase === 'prep' && (
        <PrepBay
          missionId={missionId}
          onBack={() => setPhase('story-hub')}
          onLaunch={() => launchMission(missionId)}
        />
      )}

      {phase === 'hangar' && (
        <Hangar onBack={() => setPhase(prepFromStoryRef.current ? 'story-hub' : 'menu')} />
      )}`,
 'render PrepBay');
