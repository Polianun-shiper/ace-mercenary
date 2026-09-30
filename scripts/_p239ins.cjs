// §239 交接文件插入(倒序: 放在 §238 之前)
const fs = require('fs');
let h = fs.readFileSync('.shots/_sec239_handoff.md', 'utf8').trim();
h = h.replace(/^#{2,4}\s*§?239[.、]?\s*/, '### §239 ');
const t = fs.readFileSync('DSH_HANDOFF.md', 'utf8');
const anchor = '### §238 7 秒锁定';
if (t.includes('### §239 ')) { console.log('already inserted'); }
else if (!t.includes(anchor)) { console.error('anchor missing'); process.exit(1); }
else { fs.writeFileSync('DSH_HANDOFF.md', t.replace(anchor, h + '\n\n' + anchor), 'utf8'); console.log('inserted §239'); }
