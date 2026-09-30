const fs = require('fs');
const s = fs.readFileSync('src/lib/game/missions.ts', 'utf8');
const parts = s.split(/\r?\n  \{\r?\n    id: /).slice(1);
let n = 0;
for (const p of parts) {
  n++;
  const id = p.match(/^'([^']+)'/)?.[1] ?? '?';
  const codename = p.match(/codename: '([^']+)'/)?.[1] ?? '';
  const title = p.match(/title: '([^']+)'/)?.[1] ?? '';
  const map = p.match(/map: '([^']+)'/)?.[1] ?? '';
  console.log(String(n).padStart(2, '0'), id, '|', codename, '|', title, '| map=' + map);
}
