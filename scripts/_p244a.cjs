// §244: ① MiG-29 尾焰"大两圈 + 位置后移" ② 末阶段提速解除 ③ 敌方空中战舰每波数量 x2
//       ④ 过场运镜改成关键帧轨道(电影感: 缓入缓出 + 焦距变化 + 轻手持漂移)
const fs = require('fs');
function rep(file, a, b, label, all) {
  let s = fs.readFileSync(file, 'utf8');
  const n = s.split(a).length - 1;
  if (n === 0) { console.log('skip:', label); return; }
  if (!all && n !== 1) { console.error('miss(' + n + ') ' + file + ':', label); process.exit(1); }
  fs.writeFileSync(file, all ? s.split(a).join(b) : s.replace(a, b));
  console.log('ok:', label, all ? '(' + n + ')' : '');
}
const E = 'src/lib/game/engine.ts';
const D = 'src/lib/game/dreadnought.ts';

// ① MiG-29 尾焰: 大两圈 + 后移
rep(E, `    if (isMig29) this.playerAfterburner.scale.multiplyScalar(0.6);`,
`    // per user request: 改成**大两圈**并把位置往机尾方向后移(上一轮我误做成缩小 0.6)
    if (isMig29) {
      this.playerAfterburner.scale.multiplyScalar(1.6);
      this.playerAfterburner.position.z -= 2.2 * meshScale;
      this.playerAfterburner.position.y -= 0.2 * meshScale;
    }`,
 'MiG-29 尾焰大两圈+后移');

// ② 末阶段提速解除
rep(D, `  final: 25, escape: 420,   // per user request: 末阶段速度再翻两倍`,
`  // per user request: 末阶段的提速增益**解除**(420 -> 回到 210)
  final: 25, escape: 210,`,
 '末阶段提速解除');

// ③ 敌方空中战舰每波 x2
rep(E, `        this.spawnAnvil(0);
        this.spawnAnvil(1);
        this.spawnBossMounts(3);`,
`        // per user request: 每波刷出来的敌方空中战舰数量 x2(阶段 3: 2 -> 4)
        this.spawnAnvil(0);
        this.spawnAnvil(1);
        this.spawnAnvil(2);
        this.spawnAnvil(3);
        this.spawnBossMounts(3);`,
 '阶段3 敌方战舰 x2');
rep(E, `        this.spawnAnvil(2);
        this.spawnAnvil(3);
        this.spawnAnvil(4);
        this.spawnBossMounts(4);`,
`        // per user request: 每波数量 x2(阶段 4: 3 -> 6)
        this.spawnAnvil(0);
        this.spawnAnvil(1);
        this.spawnAnvil(2);
        this.spawnAnvil(3);
        this.spawnAnvil(4);
        this.spawnAnvil(5);
        this.spawnBossMounts(4);`,
 '阶段4 敌方战舰 x2');
console.log('§244 1/2 done');
