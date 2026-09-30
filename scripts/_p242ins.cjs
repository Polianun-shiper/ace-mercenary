const fs = require('fs');
let h = fs.readFileSync('.shots/_sec242_handoff.md', 'utf8').trim();
h = h.replace(/^#{2,4}\s*§?242[.、]?\s*/, '### §242 ');
const t = fs.readFileSync('DSH_HANDOFF.md', 'utf8');
const anchor = '### §241 主舰朝向翻转';
if (t.includes('### §242 ')) { console.log('already inserted'); }
else if (!t.includes(anchor)) { console.error('anchor missing'); process.exit(1); }
else { fs.writeFileSync('DSH_HANDOFF.md', t.replace(anchor, h + '\n\n' + anchor), 'utf8'); console.log('inserted §242'); }
