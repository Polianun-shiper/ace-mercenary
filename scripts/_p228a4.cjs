const fs = require('fs');
let p = 'src/components/game/GameApp.tsx';
let s = fs.readFileSync(p, 'utf8');
function rep(a, b, label) {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.error('miss(' + n + '):', label); process.exit(1); }
  s = s.replace(a, b); console.log('ok:', label);
}
rep("type Phase = 'menu' | 'multiplayer' | 'mission-select' | 'hangar' | 'briefing' | 'loading' | 'playing' | 'results' | 'settings';",
    "type Phase = 'menu' | 'multiplayer' | 'mission-select' | 'story-select' | 'hangar' | 'briefing' | 'loading' | 'playing' | 'results' | 'settings';",
    'Phase type');
rep("        <MainMenu\n          onPlay={() => setPhase('mission-select')}",
    "        <MainMenu\n          onPlay={() => setPhase('mission-select')}\n          onStory={() => setPhase('story-select')}",
    'MainMenu onStory prop');
fs.writeFileSync(p, s);

p = 'src/lib/game/missions.ts';
s = fs.readFileSync(p, 'utf8');
rep("recommendedCategories: ['fighter', 'multirole'],", "recommendedCategories: ['fighter'],", 's01 category');
fs.writeFileSync(p, s);
