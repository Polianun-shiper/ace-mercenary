// §240: 接上我方(盟友)剧情台词的触发时机 —— 用 radio.ts 新导出的 S01_ALLY_BLOCKS
const fs = require('fs');
const E = 'src/lib/game/engine.ts';
function rep(a, b, label, all) {
  let s = fs.readFileSync(E, 'utf8');
  const n = s.split(a).length - 1;
  if (n === 0) { console.log('skip:', label); return; }
  if (!all && n !== 1) { console.error('miss(' + n + '):', label); process.exit(1); }
  fs.writeFileSync(E, all ? s.split(a).join(b) : s.replace(a, b));
  console.log('ok:', label, all ? '(' + n + ')' : '');
}

rep(`import { RadioChatter, RadioEvent, S01_BLOCKS, S01_RANDOM_CONTROL } from './radio';`,
`import { RadioChatter, RadioEvent, S01_BLOCKS, S01_ALLY_BLOCKS, S01_RANDOM_CONTROL } from './radio';`,
 '导入 S01_ALLY_BLOCKS');

rep(`  /** 整组台词按顺序播(段落式对话, 用 radio 的队列)。 */`,
`  // === 我方(盟友)剧情台词 (per user request: 队友的剧情台词也一样放进游戏, 语音留占位符) =====
  // 与敌方那套并排: 每组内部严格按顺序, 整组播(段落式)或逐句播(按战果推进)。
  // 语音同样是占位符(没有 mp3 => radio 自动降级成"只显示字幕")。
  private playS01AllyBlock(key: keyof typeof S01_ALLY_BLOCKS, gap = 4.0) {
    const list = S01_ALLY_BLOCKS[key];
    if (!list) return;
    this.radio.triggerSequence(list, { gap });
  }

  private playS01AllyNext(key: keyof typeof S01_ALLY_BLOCKS, delay = 0.3): boolean {
    const list = S01_ALLY_BLOCKS[key];
    const k = 'ally_' + key;
    const i = this.bossBlockIdx[k] ?? 0;
    if (!list || i >= list.length) return false;
    this.bossBlockIdx[k] = i + 1;
    this.radio.trigger(list[i], { force: true, delay });
    return true;
  }

  /** 整组台词按顺序播(段落式对话, 用 radio 的队列)。 */`,
 '我方台词接口');

rep(`    this.playS01Next('s0_awacs', 1.2);
    this.playS01Block('s0_escort', 4.4);`,
`    this.playS01Next('s0_awacs', 1.2);
    this.playS01Block('s0_escort', 4.4);
    // 我方开场(基石/游隼/山雀...): 排在敌方那组后面, 免得两句叠在一起
    window.setTimeout(() => { if (this.isS01) this.playS01AllyBlock('s0_open', 4.2); }, 14000);`,
 '我方开场台词');

rep(`      if (n === 1) this.playS01Next('s1_open', 0.4);
      if (n === 2) { this.playS01Next('s2_trigger', 0.3); this.playS01Block('s2_open', 4.0); }
      if (n === 3) { this.playS01Next('s3_trigger', 0.3); this.playS01Block('s3_open', 4.0); }
      if (n === 4) this.playS01Block('s4_open', 4.0);`,
`      if (n === 1) this.playS01Next('s1_open', 0.4);
      if (n === 2) { this.playS01Next('s2_trigger', 0.3); this.playS01Block('s2_open', 4.0); }
      if (n === 3) { this.playS01Next('s3_trigger', 0.3); this.playS01Block('s3_open', 4.0); }
      if (n === 4) this.playS01Block('s4_open', 4.0);
      // 我方对应阶段的台词(和敌方那组错开几秒起播)
      const allyKey = n === 1 ? 's1_open' : n === 2 ? 's2_open' : n === 3 ? 's3_open' : 's4_open';
      window.setTimeout(() => { if (this.isS01 && this.bossStage === n) this.playS01AllyBlock(allyKey as 's1_open', 4.2); }, 2600);`,
 '阶段台词(我方)');

rep(`      for (let i = 0; i < gain; i++) {
        const half = mounts.length / 2;`,
`      // 我方台词: 本阶段首杀 / 过半 / 最后一个 / 激光 · 核心模块报点
      {
        const halfN = mounts.length / 2;
        const before = deadNow - gain;
        const crossed = (t: number) => before < t && deadNow >= t;
        const st = this.bossStage;
        if (st === 1 && crossed(1)) this.playS01AllyNext('s1_first', 0.5);
        if (st === 1 && crossed(halfN)) this.playS01AllyNext('s1_half', 0.5);
        if (st === 2 && crossed(halfN)) this.playS01AllyNext('s2_half', 0.5);
        if (st === 1 && before < mounts.length && deadNow >= mounts.length) this.playS01AllyNext('s1_last', 0.5);
        if (st === 2 && before < mounts.length && deadNow >= mounts.length) this.playS01AllyNext('s2_last', 0.5);
        if (st === 3) {
          const lasers = mounts.filter((m) => this.boss?.airComponents?.[m.compIndex]?.kind === 'laser');
          const deadLaser = lasers.filter((m) => !m.alive || m.compDetached).length;
          if (deadLaser >= 1 && !this.bossAllyFlags.laser1) { this.bossAllyFlags.laser1 = true; this.playS01AllyNext('s3_laser1', 0.5); }
          if (lasers.length > 0 && deadLaser >= lasers.length && !this.bossAllyFlags.laserAll) {
            this.bossAllyFlags.laserAll = true;
            this.playS01AllyNext('s3_lasers_clear', 0.5);
          }
        }
        if (st === 4) {
          const cores = mounts.filter((m) => this.boss?.airComponents?.[m.compIndex]?.kind === 'core');
          const deadCore = cores.filter((m) => !m.alive || m.compDetached).length;
          const key = deadCore === 1 ? 's4_core1' : deadCore === 2 ? 's4_core2' : deadCore === 3 ? 's4_core3' : deadCore >= 4 ? 's4_core4' : null;
          if (key && !this.bossAllyFlags[key]) {
            this.bossAllyFlags[key] = true;
            this.playS01AllyBlock(key as 's4_core1', 3.8);
          }
        }
      }
      for (let i = 0; i < gain; i++) {
        const half = mounts.length / 2;`,
 '战果台词(我方)');

rep(`    if (anvilDead > this.bossAnvilIdx) {
      this.bossAnvilIdx = anvilDead;
      this.playS01Next('s3_anvil', 0.4);
    }`,
`    if (anvilDead > this.bossAnvilIdx) {
      this.bossAnvilIdx = anvilDead;
      this.playS01Next('s3_anvil', 0.4);
      // 我方: 第一艘 / 第二艘轻型舰坠落各一组台词
      if (anvilDead >= 1 && !this.bossAllyFlags.anvil1) { this.bossAllyFlags.anvil1 = true; this.playS01AllyBlock('s3_anvil1', 4.0); }
      if (anvilDead >= 2 && !this.bossAllyFlags.anvil2) { this.bossAllyFlags.anvil2 = true; this.playS01AllyBlock('s3_anvil2', 4.0); }
    }`,
 '轻型舰台词(我方)');

rep(`    const c = comp.charge ?? 0;
    if (c < 1) {                       // 充能
      comp.charge = Math.min(1, c + dt / CHARGE);`,
`    const c = comp.charge ?? 0;
    if (c < 1) {                       // 充能
      // 我方报点: 激光开始充能(首次 + 之后每 25 秒最多再提醒一次)
      if (this.isS01 && this.bossStage === 3 && c <= 0.001 && this.bossChargeCallT <= 0) {
        this.bossChargeCallT = 25;
        this.playS01AllyNext('s3_charge', 0.2);
      }
      comp.charge = Math.min(1, c + dt / CHARGE);`,
 '激光充能台词');

rep(`    this.playS01Block('s5_fall', 5.2);`,
`    this.playS01Block('s5_fall', 5.2);
    // 我方坠落段落(错开, 免得和敌方那组抢话筒)
    window.setTimeout(() => { if (this.isS01) this.playS01AllyBlock('s5_fall', 5.0); }, 12000);`,
 '坠落台词(我方)');

rep(`  /** 末阶段浓烟: 开关 + 节流 */`,
`  /** 我方战果台词的"已播过"标记(首杀/激光/核心模块等各只播一次) */
  private bossAllyFlags: Record<string, boolean> = {};
  /** 激光充能报点的节流 */
  private bossChargeCallT = 0;
  /** 末阶段浓烟: 开关 + 节流 */`,
 '我方台词字段');

// 每帧递减充能报点节流
rep(`        if (this.bossCrashT > 0) this.bossCrashT -= dt;`,
`        if (this.bossCrashT > 0) this.bossCrashT -= dt;
        if (this.bossChargeCallT > 0) this.bossChargeCallT -= dt;`,
 '充能节流递减');
console.log('§240 done');
