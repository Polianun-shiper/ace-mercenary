// §231 交接文件插入(倒序: 放在 §230 之前)
const fs = require('fs');
let h = fs.readFileSync('.shots/_sec231_handoff.md', 'utf8').trim();
h = h.replace(/^#{2,4}\s*§?231[.、]?\s*/, '### §231 ');
const t = fs.readFileSync('DSH_HANDOFF.md', 'utf8');
const anchor = '### §230 语音放大';
if (t.includes('### §231 ')) { console.log('already inserted'); }
else if (!t.includes(anchor)) { console.error('anchor missing'); process.exit(1); }
else { fs.writeFileSync('DSH_HANDOFF.md', t.replace(anchor, h + '\n\n' + anchor), 'utf8'); console.log('inserted §231 before §230'); }
