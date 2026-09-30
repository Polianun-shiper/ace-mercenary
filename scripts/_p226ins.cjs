// §226 插进交接文件(按轮次倒序 → 放在 §225 之前)
const fs = require('fs');
const frag = '.shots/_sec226_handoff.md';
let h = fs.readFileSync(frag, 'utf8').trim();
h = h.replace(/^#{2,4}\s*§?226[.、]?\s*/, '### §226 ');
const t = fs.readFileSync('DSH_HANDOFF.md', 'utf8');
const anchor = '### §225 空中战舰单位 + 附属 AI (2026-09-18)';
if (t.includes('### §226 ')) {
  console.log('already inserted');
} else if (!t.includes(anchor)) {
  console.error('anchor missing'); process.exit(1);
} else {
  fs.writeFileSync('DSH_HANDOFF.md', t.replace(anchor, h + '\n\n' + anchor), 'utf8');
  console.log('inserted §226 before §225');
}
