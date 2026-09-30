const fs = require('fs');
let h = fs.readFileSync('.shots/_sec248_handoff.md', 'utf8').trim();
h = h.replace(/^#{2,4}\s*§?248[.、]?\s*/, '### §248 ');
const t = fs.readFileSync('DSH_HANDOFF.md', 'utf8');
const anchor = '### §247 剧情语音整体放大';
if (t.includes('### §248 ')) console.log('already inserted');
else if (!t.includes(anchor)) { console.error('anchor missing'); process.exit(1); }
else { fs.writeFileSync('DSH_HANDOFF.md', t.replace(anchor, h + '\n\n' + anchor), 'utf8'); console.log('inserted §248'); }
