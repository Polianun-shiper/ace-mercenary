const fs = require('fs');
const p = '.shots/airship3s.js';
let s = fs.readFileSync(p, 'utf8');
const a = "      fxAfter: e.weapons && e.weapons.effects ? e.weapons.effects.length : -1,";
if (!s.includes(a)) { console.error('miss'); process.exit(1); }
s = s.replace(a, "      fxAfter: exHit,\n      fxScales: exScales,");
fs.writeFileSync(p, s);
console.log('ok');
