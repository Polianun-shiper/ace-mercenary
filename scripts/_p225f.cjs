// s5 的爆炸计数改成"触地当帧读": 轮询到 alive 变 false 立刻取 explosions.length。
const fs = require('fs');
const p = '.shots/airship3s.js';
let s = fs.readFileSync(p, 'utf8');
const a = `    s.position.y = terrY + 40;
    s.velocity.y = -30;
    await new Promise(r => setTimeout(r, 3000));`;
const b = `    s.position.y = terrY + 40;
    s.velocity.y = -30;
    // 轮询到"击中"的当帧立刻读爆炸列表(爆炸寿命约 1s, 不能等 3s 再读)
    for (let i = 0; i < 200 && s.alive; i++) await new Promise(r => setTimeout(r, 100));
    const exHit = e.weapons && e.weapons.explosions ? e.weapons.explosions.length : -1;
    const exScales = e.weapons && e.weapons.explosions ? e.weapons.explosions.slice(-4).map(x => Math.round(x.scale * 10) / 10) : [];`;
if (!s.includes(a)) { console.error('miss s5'); process.exit(1); }
s = s.replace(a, b);
s = s.replace("      fxBefore: this.fx0,\n      fxAfter: e.weapons.explosions ? e.weapons.explosions.length : -1,",
              "      fxBefore: this.fx0,\n      fxAfter: exHit,\n      fxScales: exScales,");
fs.writeFileSync(p, s);
console.log('s5 patched');
