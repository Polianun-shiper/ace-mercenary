const fs = require('fs');
let h = fs.readFileSync('.shots/_sec245_handoff.md', 'utf8').trim();
h = h.replace(/^#{2,4}\s*§?245[.、]?\s*/, '### §245 ');
const t = fs.readFileSync('DSH_HANDOFF.md', 'utf8');
const anchor = '### §244 MiG-29 尾焰大两圈后移';
if (t.includes('### §245 ')) console.log('already inserted');
else if (!t.includes(anchor)) { console.error('anchor missing'); process.exit(1); }
else { fs.writeFileSync('DSH_HANDOFF.md', t.replace(anchor, h + '\n\n' + anchor), 'utf8'); console.log('inserted §245'); }
