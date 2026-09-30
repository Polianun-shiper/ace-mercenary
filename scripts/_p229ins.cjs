const fs = require('fs');
let h = fs.readFileSync('.shots/_sec229_handoff.md', 'utf8').trim();
h = h.replace(/^#{2,4}\s*§?229[.、]?\s*/, '### §229 ');
const t = fs.readFileSync('DSH_HANDOFF.md', 'utf8');
const anchor = '### §228 正式版剧情菜单 + 第一关';
if (t.includes('### §229 ')) console.log('already inserted');
else if (!t.includes(anchor)) { console.error('anchor missing'); process.exit(1); }
else { fs.writeFileSync('DSH_HANDOFF.md', t.replace(anchor, h + '\n\n' + anchor), 'utf8'); console.log('inserted §229 before §228'); }
