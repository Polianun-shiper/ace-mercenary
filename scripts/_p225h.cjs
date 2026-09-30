// 加一个 stage: 把一艘敌舰摆到玩家正前方 ~1500m 并"顺桨"悬停, 便于截图看舰体外形。
const fs = require('fs');
const p = '.shots/airship3s.js';
let s = fs.readFileSync(p, 'utf8');
const anchor = "  // stage 7: 玩家锁定";
if (!s.includes(anchor)) { console.error('miss anchor'); process.exit(1); }
const add = `  // stage 8: 摆位给截图看外形(敌舰停在玩家正前方, 组件全部可见)
  async s8(dist) {
    const e = this.eng();
    window.__airship(false);
    await new Promise(r => setTimeout(r, 900));
    const ships = e.groundUnits.filter(u => u.type === 'air_light' && u.alive);
    const s = ships[ships.length - 1];
    if (!s) return 'no-ship';
    const v = e.playerVelocity || { x: 0, z: 1 };
    const L = Math.hypot(v.x, v.z) || 1;
    const p = e.player.position;
    const d = dist || 1400;
    s.position.set(p.x + (v.x / L) * d, p.y + 40, p.z + (v.z / L) * d);
    s.velocity.set(0, 0, 0);
    s.speed = 0.001;
    this.s2h = s;
    await new Promise(r => setTimeout(r, 400));
    return 'framed';
  },
`;
s = s.replace(anchor, add + anchor);
fs.writeFileSync(p, s);
console.log('s8 added');
