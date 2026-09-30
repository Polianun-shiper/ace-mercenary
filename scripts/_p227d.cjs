// §227d: 组件的字段补齐(wake/dust/target 计时器) + 联机播报死亡时组件要摘网格
const fs = require('fs');
const p = 'src/lib/game/engine.ts';
let s = fs.readFileSync(p, 'utf8');
function rep(a, b, label) {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.error('miss(' + n + '):', label); process.exit(1); }
  s = s.replace(a, b); console.log('ok:', label);
}

rep(`          isAir: true,
          isComponent: true,
          parentShipId: unit.id,
          compIndex: i,
          attachLocal: c.localPos.clone(),
          collideR: c.radius,
          radarRange: 5200,`,
`          isAir: true,
          isComponent: true,
          parentShipId: unit.id,
          compIndex: i,
          attachLocal: c.localPos.clone(),
          collideR: c.radius,
          radarRange: 5200,
          // 组件不进海迹/地面灰尘/自主巡逻那几条分支, 但字段留全, 免得别处读到 undefined -> NaN
          wakeTimer: 0, dustTimer: 0,
          targetId: -1, targetIsAir: true,`,
 'component unit fields');

rep(`    const g = this.groundUnits.find((x) => x.id === aiId);
    if (g && g.alive) {
      // === 空中战舰: 联机端播报死亡也只切坠落 (per user request) ===`,
`    const g = this.groundUnits.find((x) => x.id === aiId);
    if (g && g.alive) {
      // 舰载组件在联机端播报死亡时直接摘掉网格(它没有坠落可言)
      if (g.isComponent) { this.detachAirComponent(g, true); return; }
      // === 空中战舰: 联机端播报死亡也只切坠落 (per user request) ===`,
 'remote death detaches component');

fs.writeFileSync(p, s);
console.log('§227d ok');
