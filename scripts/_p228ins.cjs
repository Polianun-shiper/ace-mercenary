// §228 插进交接文件(倒序: 放在 §227 之前)
const fs = require('fs');
let h = fs.readFileSync('.shots/_sec228_handoff.md', 'utf8').trim();
h = h.replace(/^#{2,4}\s*§?228[.、]?\s*/, '### §228 ');
const t = fs.readFileSync('DSH_HANDOFF.md', 'utf8');
const anchor = '### §227 空中战舰 = 母舰 + 6 个独立组件单位';
if (t.includes('### §228 ')) { console.log('already inserted'); }
else if (!t.includes(anchor)) { console.error('anchor missing'); process.exit(1); }
else { fs.writeFileSync('DSH_HANDOFF.md', t.replace(anchor, h + '\n\n' + anchor), 'utf8'); console.log('inserted §228 before §227'); }
