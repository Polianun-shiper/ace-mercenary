const fs = require('fs');
let h = fs.readFileSync('.shots/_sec241_handoff.md', 'utf8').trim();
h = h.replace(/^#{2,4}\s*§?241[.、]?\s*/, '### §241 ');
const t = fs.readFileSync('DSH_HANDOFF.md', 'utf8');
const anchor = '### §240 我方(盟友)剧情台词上线';
if (t.includes('### §241 ')) { console.log('already inserted'); }
else if (!t.includes(anchor)) { console.error('anchor missing'); process.exit(1); }
else { fs.writeFileSync('DSH_HANDOFF.md', t.replace(anchor, h + '\n\n' + anchor), 'utf8'); console.log('inserted §241'); }
