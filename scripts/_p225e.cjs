// 修探针: 页面里没有全局 THREE, 用 set(x,y,z); 顺带把爆炸计数接到真实字段 explosions。
const fs = require('fs');
const p = '.shots/airship3s.js';
let s = fs.readFileSync(p, 'utf8');
function rep(a, b) {
  if (!s.includes(a)) { console.error('miss:', a.slice(0, 60)); process.exit(1); }
  s = s.replace(a, b);
}
rep("s.position.copy(e.player.position).add(new THREE.Vector3(0, 400, 900));",
    "const pp = e.player.position;\n    s.position.set(pp.x, pp.y + 400, pp.z + 900);");
rep("e.weapons.bullets.length, emsl: e.weapons.enemyMissiles.length };",
    "e.weapons.bullets.length, emsl: e.weapons.enemyMissiles.length, ex: e.weapons.explosions.length };");
rep("emslBefore: this.m0.emsl, emslAfter: e.weapons.enemyMissiles.length,",
    "emslBefore: this.m0.emsl, emslAfter: e.weapons.enemyMissiles.length,\n      exBefore: this.m0.ex, exAfter: e.weapons.explosions.length,");
rep("e.weapons.effects ? e.weapons.effects.length : -1", "e.weapons.explosions ? e.weapons.explosions.length : -1");
rep("    const hits = [];\n    e.targetId = s.id;\n    for (let i = 0; i < 40; i++) {\n      e.cycleTargetForTest();",
    "    const hits = [];\n    e.targetId = -12345;\n    for (let i = 0; i < 220; i++) {\n      e.cycleTargetForTest();");
fs.writeFileSync(p, s);
console.log('probe patched');
