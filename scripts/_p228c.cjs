// §228c: 'boss' 目标专用计数(否则未知 target 会退回 "any" 击杀计数 -> 第一架敌机被击落就通关)
const fs = require('fs');
const p = 'src/lib/game/engine.ts';
function rep(a, b, label, all) {
  let s = fs.readFileSync(p, 'utf8');
  const n = s.split(a).length - 1;
  if (n === 0) { console.log('skip:', label); return; }
  if (!all && n !== 1) { console.error('miss(' + n + '):', label); process.exit(1); }
  fs.writeFileSync(p, all ? s.split(a).join(b) : s.replace(a, b));
  console.log('ok:', label, '(' + n + ')');
}
rep(`        : o.target === 'radar' ? (this.objectiveGroundKills.radar ?? 0)
        : this.objectiveKills.any;`,
    `        : o.target === 'radar' ? (this.objectiveGroundKills.radar ?? 0)
        // === 正式版剧情第一关: 只认"主舰被击毁" (per user request) ==============
        // 不能让它退回下面的 objectiveKills.any —— 那样随便打下一架敌机就被判"目标达成",
        // 剧情阶段还没打完就通关了。
        : o.target === 'boss' ? (this.objectiveGroundKills.boss ?? 0)
        : this.objectiveKills.any;`,
    'objective eval #1');
rep(`        : obj.target === 'radar' ? (this.objectiveGroundKills.radar ?? 0)
        : this.objectiveKills.any;`,
    `        : obj.target === 'radar' ? (this.objectiveGroundKills.radar ?? 0)
        : obj.target === 'boss' ? (this.objectiveGroundKills.boss ?? 0)
        : this.objectiveKills.any;`,
    'objective eval #2');
// 坠落收尾: 先念完最后一句(3.2s), 再记"主舰已击毁"并收尾
rep(`      if (this.bossFallDone && this.bossEndT > 0) {
        this.bossEndT -= dt;
        if (this.bossEndT <= 0) this.endMission(true, 'MISSION COMPLETE');
      }`,
    `      if (this.bossFallDone && this.bossEndT > 0) {
        this.bossEndT -= dt;
        if (this.bossEndT <= 0) {
          // 台词播完才记战果: 任务目标(击毁主舰)达标 -> checkObjectives 也会在同帧收尾
          (this.objectiveGroundKills as Record<string, number>).boss = 1;
          this.score += 12000;
          this.endMission(true, 'MISSION COMPLETE');
        }
      }`,
    'boss kill counted at impact');
