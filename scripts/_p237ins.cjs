const fs = require('fs');
let h = fs.readFileSync('.shots/_sec237_handoff.md', 'utf8').trim();
h = h.replace(/^#{2,4}\s*§?237[.、]?\s*/, '### §237 ');
const t = fs.readFileSync('DSH_HANDOFF.md', 'utf8');
const anchor = '### §236 简报语音减半';
if (t.includes('### §237 ')) console.log('already inserted');
else if (!t.includes(anchor)) { console.error('anchor missing'); process.exit(1); }
else { fs.writeFileSync('DSH_HANDOFF.md', t.replace(anchor, h + '\n\n' + anchor), 'utf8'); console.log('inserted §237'); }
