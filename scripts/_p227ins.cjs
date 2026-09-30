// §227 插进交接文件(倒序: 放在 §226 之前)
const fs = require('fs');
let h = fs.readFileSync('.shots/_sec227_handoff.md', 'utf8').trim();
h = h.replace(/^#{2,4}\s*§?227[.、]?\s*/, '### §227 ');
const t = fs.readFileSync('DSH_HANDOFF.md', 'utf8');
const anchor = '### §226 "尾喷口被相机看到就闪黑屏" —— 是自动平滑写出了 0 长度法线';
if (t.includes('### §227 ')) { console.log('already inserted'); }
else if (!t.includes(anchor)) { console.error('anchor missing'); process.exit(1); }
else { fs.writeFileSync('DSH_HANDOFF.md', t.replace(anchor, h + '\n\n' + anchor), 'utf8'); console.log('inserted §227 before §226'); }
