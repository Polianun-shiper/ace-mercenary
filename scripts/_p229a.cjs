// §229a: 主舰"只有打完四个剧情阶段才坠落"做成硬保证
// 1) 通用空中单位逻辑(血量归零/联机播报死亡)给 boss 打上的 falling 一律撤销
// 2) startBossFall() 加阶段闸门(bossStage < 4 拒绝)
// 3) beginBossStage 把"玩法改动"放前面、电台放最后并 try/catch —— 电台出错不能挡住挂点刷新
// 4) 每次切阶段给玩家一条可见提示(否则玩家看不出还有几个阶段)
const fs = require('fs');
const p = 'src/lib/game/engine.ts';
function rep(a, b, label) {
  let s = fs.readFileSync(p, 'utf8');
  const n = s.split(a).length - 1;
  if (n === 0) { console.log('skip:', label); return; }
  if (n !== 1) { console.error('miss(' + n + '):', label); process.exit(1); }
  fs.writeFileSync(p, s.replace(a, b));
  console.log('ok:', label);
}

// ① 字段
rep(`  private bossFlareTimer = 0;   // 阶段 2 干扰弹节流`,
`  private bossFlareTimer = 0;   // 阶段 2 干扰弹节流
  private bossFallBlocked = false;  // 已撤销过一次"非剧情坠落"(只警告一次, 免得刷屏)`,
 'bossFallBlocked field');

// ② 通用阵亡/坠落路径排除主舰
rep(`      if (u.hp <= 0 && u.alive && u.isAir && !u.isComponent) {
        u.falling = true;`,
`      // 主舰不在这条路上: 它的坠落只由剧情闸门(四个阶段)决定, 见 startBossFall()
      if (u.hp <= 0 && u.alive && u.isAir && !u.isComponent && !u.boss) {
        u.falling = true;`,
 'kill guard excludes boss');

// ③ updateStoryS01 开头: 撤销一切非剧情坠落
rep(`    if (!this.isS01) return;
    const boss = this.boss;
    if (!boss) return;`,
`    if (!this.isS01) return;
    const boss = this.boss;
    if (!boss) return;
    // === 硬保证: 主舰只会因为"四个剧情阶段全部打完"而坠落 (per user request) ======
    // 通用空中单位逻辑(血量归零 / 联机播报死亡)也可能给主舰打上 falling —— 一律撤销。
    // 只有 startBossFall() 能把它置位; 这条曾经让"打完一轮就坠"成为可能。
    if (boss.falling && !this.bossFalling) {
      boss.falling = false;
      boss.hp = Math.max(boss.hp, 1);
      if (!this.bossFallBlocked) {
        this.bossFallBlocked = true;
        console.warn('[s01] 已撤销主舰的非剧情坠落(只有打完四个阶段才能坠)');
      }
    }`,
 'revoke non-story fall');

// ④ startBossFall 阶段闸门
rep(`  private startBossFall() {
    const boss = this.boss;
    if (!boss || this.bossFalling) return;`,
`  private startBossFall() {
    const boss = this.boss;
    if (!boss || this.bossFalling) return;
    // 硬闸门: 阶段 1..4 必须都走完(阶段 4 核心全毁才会走到这里)
    if (this.bossStage < 4) {
      console.warn('[s01] 阶段未完成(当前 ' + this.bossStage + '), 拒绝坠落');
      return;
    }`,
 'startBossFall stage gate');

// ⑤ beginBossStage: 玩法优先 + 电台兜底 + 阶段提示
rep(`  private beginBossStage(n: number) {
    const boss = this.boss;
    if (!boss || this.bossStage === n) return;
    this.bossStage = n;
    this.bossAdvanceT = 0;
    switch (n) {
      case 1:
        this.playS01Next('s1_open', 0.4);
        this.spawnBossWing(4);          // 阶段 1 航空大队 4 架
        break;
      case 2:
        this.playS01Next('s2_trigger', 0.3);
        this.playS01Block('s2_open', 4.0);
        this.withdrawWing();
        this.spawnBossWing(6);
        this.spawnBossMounts(2);
        break;
      case 3:
        this.playS01Next('s3_trigger', 0.3);
        this.playS01Block('s3_open', 4.0);
        this.withdrawWing();
        this.spawnBossWing(8);
        this.spawnAnvil(0);
        this.spawnAnvil(1);
        this.spawnBossMounts(3);
        break;
      case 4:
        this.playS01Block('s4_open', 4.0);
        this.withdrawWing();
        this.spawnBossWing(10);
        this.spawnAnvil(2);
        this.spawnAnvil(3);
        this.spawnAnvil(4);
        this.spawnBossMounts(4);
        break;
      default: break;
    }
  }`,
`  private beginBossStage(n: number) {
    const boss = this.boss;
    if (!boss || this.bossStage === n) return;
    this.bossStage = n;
    this.bossAdvanceT = 0;
    // === 顺序很重要: 先做"玩法改动"(挂点换装/航空大队/轻型舰), 电台放最后 ==========
    // 早期的写法把电台调用放在前面 —— 只要电台那边抛一次异常(比如某个事件 id 忘了登记),
    // 后面的 spawnBossMounts 就永远不执行, 玩家看到的就是"打完一轮挂点不再刷新"。
    try {
      switch (n) {
        case 1:
          this.spawnBossWing(4);          // 阶段 1 航空大队 4 架
          break;
        case 2:
          this.withdrawWing();
          this.spawnBossWing(6);
          this.spawnBossMounts(2);
          break;
        case 3:
          this.withdrawWing();
          this.spawnBossWing(8);
          this.spawnAnvil(0);
          this.spawnAnvil(1);
          this.spawnBossMounts(3);
          break;
        case 4:
          this.withdrawWing();
          this.spawnBossWing(10);
          this.spawnAnvil(2);
          this.spawnAnvil(3);
          this.spawnAnvil(4);
          this.spawnBossMounts(4);
          break;
        default: break;
      }
    } catch (e) {
      console.warn('[s01] 阶段 ' + n + ' 部署异常:', e);
    }
    // 玩家可见的阶段提示(否则看不出还剩几个阶段)
    const zh = '空中战舰「堡垒」· 第 ' + Math.min(n, 4) + ' 阶段防御';
    this.showMessage(n >= 4 ? zh + '(最终核心)' : zh + '(' + n + '/4)', 2.6);
    // 电台最后播, 且单独兜底
    try {
      if (n === 1) this.playS01Next('s1_open', 0.4);
      if (n === 2) { this.playS01Next('s2_trigger', 0.3); this.playS01Block('s2_open', 4.0); }
      if (n === 3) { this.playS01Next('s3_trigger', 0.3); this.playS01Block('s3_open', 4.0); }
      if (n === 4) this.playS01Block('s4_open', 4.0);
    } catch (e) {
      console.warn('[s01] 阶段 ' + n + ' 电台异常:', e);
    }
  }`,
 'beginBossStage reorder + guard');
console.log('§229a done');
