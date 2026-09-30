const fs = require('fs');
let h = fs.readFileSync('.shots/_sec233_handoff.md', 'utf8').trim();
h = h.replace(/^#{2,4}\s*§?233[.、]?\s*/, '### §233 ');
const t = fs.readFileSync('DSH_HANDOFF.md', 'utf8');
const anchor = '### §232 我方战舰索敌环绕';
if (t.includes('### §233 ')) { console.log('already inserted'); }
else if (!t.includes(anchor)) { console.error('anchor missing'); process.exit(1); }
else { fs.writeFileSync('DSH_HANDOFF.md', t.replace(anchor, h + '\n\n' + anchor), 'utf8'); console.log('inserted §233 before §232'); }
