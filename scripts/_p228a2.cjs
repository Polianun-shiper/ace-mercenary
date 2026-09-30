const fs = require('fs');
const p = 'src/components/game/GameApp.tsx';
let s = fs.readFileSync(p, 'utf8');
const a = `      {phase === 'mission-select' && (
        <MissionSelect
          onSelect={(id) => {
            setMissionId(id);
            setPhase('briefing');
          }}
          onBack={() => setPhase('menu')}
        />
      )}
`;
const b = `      {phase === 'mission-select' && (
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
            setPhase('briefing');
          }}
          onBack={() => setPhase('menu')}
        />
      )}
`;
if (s.split(a).length - 1 !== 1) { console.error('miss'); process.exit(1); }
fs.writeFileSync(p, s.replace(a, b));
console.log('ok: render StorySelect');

// 剧情相位也要算"菜单态"(音乐/UI 音/切屏音三处判断), 否则进剧情界面会静音或没音效
for (const [x, y, label] of [
  ["      if (phase === 'menu' || phase === 'mission-select' || phase === 'hangar' || phase === 'briefing' || phase === 'settings') {\n        mp.setTrack('menu');",
   "      if (phase === 'menu' || phase === 'mission-select' || phase === 'story-select' || phase === 'hangar' || phase === 'briefing' || phase === 'settings') {\n        mp.setTrack('menu');",
   'menu music phase'],
  ["    if (phase === 'menu' || phase === 'mission-select' || phase === 'hangar' || phase === 'briefing' || phase === 'settings') {\n      const mp = getMusicPlayer();",
   "    if (phase === 'menu' || phase === 'mission-select' || phase === 'story-select' || phase === 'hangar' || phase === 'briefing' || phase === 'settings') {\n      const mp = getMusicPlayer();",
   'menu music phase 2'],
  ["    const menuPhase = phase === 'menu' || phase === 'multiplayer' || phase === 'mission-select'\n      || phase === 'hangar' || phase === 'briefing' || phase === 'settings' || phase === 'results';",
   "    const menuPhase = phase === 'menu' || phase === 'multiplayer' || phase === 'mission-select'\n      || phase === 'story-select' || phase === 'hangar' || phase === 'briefing' || phase === 'settings' || phase === 'results';",
   'ui sound phase'],
  ["    if (phase === 'mission-select') { playTape(); return undefined; }",
   "    if (phase === 'mission-select' || phase === 'story-select') { playTape(); return undefined; }",
   'screen transition sfx'],
]) {
  let t = fs.readFileSync(p, 'utf8');
  const n = t.split(x).length - 1;
  if (n !== 1) { console.error('miss(' + n + '):', label); process.exit(1); }
  fs.writeFileSync(p, t.replace(x, y));
  console.log('ok:', label);
}
