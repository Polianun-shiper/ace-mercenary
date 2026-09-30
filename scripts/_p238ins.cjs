const fs = require('fs');
let h = fs.readFileSync('.shots/_sec238_handoff.md', 'utf8').trim();
h = h.replace(/^#{2,4}\s*§?238[.、]?\s*/, '### §238 ');
const t = fs.readFileSync('DSH_HANDOFF.md', 'utf8');
const anchor = '### §237 后燃器端向';
if (t.includes('### §238 ')) console.log('already inserted');
else if (!t.includes(anchor)) { console.error('anchor missing'); process.exit(1); }
else { fs.writeFileSync('DSH_HANDOFF.md', t.replace(anchor, h + '\n\n' + anchor), 'utf8'); console.log('inserted §238'); }
