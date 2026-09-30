// §228b(4): 补 radarRangeMap 两处 + resetState(上一批在 radarRangeMap #1 处中断, 后面几条没落盘)
const fs = require('fs');
const p = 'src/lib/game/engine.ts';
let s = fs.readFileSync(p, 'utf8');
function rep(a, b, label) {
  const n = s.split(a).length - 1;
  if (n === 0) { console.log('skip(already):', label); return; }
  if (n !== 1) { console.error('miss(' + n + '):', label); process.exit(1); }
  s = s.replace(a, b);
  console.log('ok:', label);
}
rep(`      patrol_boat: 2500,
      air_component: 5200,
      tank: 1500,`,
`      patrol_boat: 2500,
      air_component: 5200,
      air_boss: 14000,
      air_drone: 3000,
      tank: 1500,`,
 'radarRangeMap #1');
rep(`      air_component: 5200,
    };`,
`      air_component: 5200,
      air_boss: 14000,
      air_drone: 3000,
    };`,
 'radarRangeMap #2');
rep(`    this.isT00 = false;`,
`    this.isT00 = false;
    // 正式版剧情第一关的剧情状态(重开关卡必须清零, 否则上一局的主舰/阶段会残留)
    this.isS01 = false;
    this.boss = null;
    this.bossModel = null;
    this.bossMotion = null;
    this.bossStage = 0;
    this.bossMountUnits = [];
    this.bossKilledInStage = 0;
    this.bossAdvanceT = 0;
    this.bossBlockIdx = {};
    this.bossWingIds = [];
    this.bossLossIdx = 0;
    this.bossAnvilIdx = 0;
    this.bossCoreIdx = 0;
    this.bossDrones = [];
    this.bossDroneTimer = 12;
    this.bossRandTimer = 30;
    this.bossFalling = false;
    this.bossFallDone = false;
    this.bossEndT = 0;
    this.bossFlareTimer = 0;`,
 'resetState s01');
fs.writeFileSync(p, s);
console.log('§228b-4 ok');
