// s8 机位修正: 放在玩家"前方 + 右方"而不是正前方 —— 正前方会被自己的机体挡住(尾翼那根黑带)。
const fs = require('fs');
const p = '.shots/airship3s.js';
let s = fs.readFileSync(p, 'utf8');
const a = "    s.position.set(p.x + (v.x / L) * d, p.y + 40, p.z + (v.z / L) * d);";
if (!s.includes(a)) { console.error('miss'); process.exit(1); }
s = s.replace(a, "    // right = (-fz, 0, fx): 偏到右前方, 避开自家机体的遮挡\n    s.position.set(p.x + (v.x / L) * d - (v.z / L) * 420, p.y + 120, p.z + (v.z / L) * d + (v.x / L) * 420);");
fs.writeFileSync(p, s);
console.log('s8 fixed');
