const fs = require('fs');
let h = fs.readFileSync('.shots/_sec234_handoff.md', 'utf8').trim();
h = h.replace(/^#{2,4}\s*§?234[.、]?\s*/, '### §234 ');
const t = fs.readFileSync('DSH_HANDOFF.md', 'utf8');
const anchor = '### §233 体积不再收着';
if (t.includes('### §234 ')) { console.log('already inserted'); }
else if (!t.includes(anchor)) { console.error('anchor missing'); process.exit(1); }
else { fs.writeFileSync('DSH_HANDOFF.md', t.replace(anchor, h + '\n\n' + anchor), 'utf8'); console.log('inserted §234 before §233'); }
