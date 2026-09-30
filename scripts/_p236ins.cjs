const fs = require('fs');
let h = fs.readFileSync('.shots/_sec236_handoff.md', 'utf8').trim();
h = h.replace(/^#{2,4}\s*§?236[.、]?\s*/, '### §236 ');
const t = fs.readFileSync('DSH_HANDOFF.md', 'utf8');
const anchor = '### §235 主舰碰撞盒改用';
if (t.includes('### §236 ')) console.log('already inserted');
else if (!t.includes(anchor)) { console.error('anchor missing'); process.exit(1); }
else { fs.writeFileSync('DSH_HANDOFF.md', t.replace(anchor, h + '\n\n' + anchor), 'utf8'); console.log('inserted §236'); }
