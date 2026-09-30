// §231b: 末阶段"开加力 + 轰鸣 + 加速逃离" + 巨量伤害不消失爆炸 + 音乐挂钩
const fs = require('fs');
function rep(file, a, b, label) {
  let s = fs.readFileSync(file, 'utf8');
  const n = s.split(a).length - 1;
  if (n === 0) { console.log('skip:', label); return; }
  if (n !== 1) { console.error('miss(' + n + ') ' + file + ':', label); process.exit(1); }
  fs.writeFileSync(file, s.replace(a, b));
  console.log('ok:', label);
}
const D = 'src/lib/game/dreadnought.ts';
const E = 'src/lib/game/engine.ts';

// ① 阶段 4 速度变快(逃离) + 引擎读的 burn 标志
rep(D, `    stage === 3 ? DREADNOUGHT_SPEED.broadside :
    DREADNOUGHT_SPEED.final;`,
`    stage === 3 ? DREADNOUGHT_SPEED.broadside :
    DREADNOUGHT_SPEED.escape;`,
 '阶段 4 目标速度改为"逃离"');
rep(D, `  /** 阶段 4 全武器持续齐射 => 引擎据此把 fireTimer 全部清零并连续开火 */
  salvo: boolean;`,
`  /** 阶段 4 全武器持续齐射 => 引擎据此把 fireTimer 全部清零并连续开火 */
  salvo: boolean;
  /** 阶段 4 点燃后燃器(引擎据此开尾焰 + 播轰鸣 + 把舰体往战场外推) */
  burn: boolean;`,
 'burn 字段');
rep(D, `  st.flares = stage === 2;
  st.salvo = stage === 4;`,
`  st.flares = stage === 2;
  st.salvo = stage === 4;
  // 阶段 4: 核心暴露 -> 点燃后燃器加速逃离(per user request: 打开后燃器, 轰鸣, 加速逃离)
  st.burn = stage >= 4;`,
 'burn 置位');
rep(D, `  salvo: false,`,
`  salvo: false,
  burn: false,`,
 'burn 初值');
rep(D, `export const DREADNOUGHT_SPEED = { cruise: 35, accel: 75, broadside: 60, final: 25 };`,
`export const DREADNOUGHT_SPEED = {
  cruise: 35, accel: 75, broadside: 60,
  // === 末阶段: 点燃后燃器**加速逃离** (per user request) =====================
  // 原来是 25(边打边滑), 现在是 210 —— 比阶段 2 的 75 快得多, 玩家必须开加力才追得上。
  final: 25, escape: 210,
};`,
 'escape 速度');

// ② 引擎: 后燃器视觉 + 轰鸣 + 音乐挂钩 + 巨量伤害不消失
rep(E, `        if (this.bossMotion.flares) {`,
`        // === 末阶段点燃后燃器 (per user request: 打开后燃器, 发出宏大轰鸣, 加速逃离) ===
        // 视觉走全机通用的 buildAfterburner/setAfterburner(尾部圆盘处), 声音用用户给的
        // transport-space 前半段(低频轰鸣), 只在"刚点上"那一帧起一次, 之后交加力音量维持。
        if (this.bossMotion.burn && !this.bossBurning) {
          this.bossBurning = true;
          this.ensureBossAfterburner(u);
          getMusicPlayer().playShuttleRumble(9);
          this.showMessage('堡垒点燃后燃器 · 正在加速脱离战场', 2.4);
        }
        if (this.bossMotion.burn) {
          if (this.bossBurnerGroup) setAfterburner(this.bossBurnerGroup, 1);
        }
        if (this.bossMotion.flares) {`,
 '后燃器 + 轰鸣');

rep(E, `  /** 用户给的 FBX 主舰(载入失败为 null => 回退程序化舰体) */`,
`  /** 末阶段后燃器: 视觉组 + 是否已点火(只播一次轰鸣) */
  private bossBurnerGroup: THREE.Group | null = null;
  private bossBurning = false;
  /** 用户给的 FBX 主舰(载入失败为 null => 回退程序化舰体) */`,
 '后燃器字段');

rep(E, `  /** 主舰阶段 2 的干扰弹(撒在舰体周围, 视觉上告诉玩家"它在放干扰")。 */`,
`  /** 主舰点燃后燃器: 在舰艉造一组尾焰(用现成的 buildAfterburner/setAfterburner)。 */
  private ensureBossAfterburner(u: GroundUnit) {
    if (this.bossBurnerGroup) return;
    // 喷口位置: 舰体本地坐标里"最后面"的一点(按舰体盒半长取), 左右各一个
    const half = this.bossModel ? this.bossModel.hull.half : new THREE.Vector3(600, 400, 1900);
    const nozzles = [
      { pos: new THREE.Vector3(-half.x * 0.35, 0, -half.z * 0.98), radius: half.x * 0.16 },
      { pos: new THREE.Vector3(half.x * 0.35, 0, -half.z * 0.98), radius: half.x * 0.16 },
    ];
    const positions = nozzles.map((n) => n.pos);
    const metrics = nozzles.map((n) => ({ center: n.pos.clone(), radius: n.radius, axis: new THREE.Vector3(0, 0, -1) }));
    const grp = buildAfterburner(positions, metrics as never);
    u.group.add(grp);
    setAfterburner(grp, 1);
    this.bossBurnerGroup = grp;
  }

  /** 主舰阶段 2 的干扰弹(撒在舰体周围, 视觉上告诉玩家"它在放干扰")。 */`,
 'ensureBossAfterburner');

// ③ 音乐挂钩: startMission 里按关卡选战斗曲
rep(E, `    // Switch to combat music
    getMusicPlayer().resume().then(() => getMusicPlayer().setTrack('combat'));`,
`    // Switch to combat music
    // 剧情第一关用专属战斗曲(White Bird), 其它关卡走原来的随机池
    getMusicPlayer().useStoryCombat(this.isS01);
    getMusicPlayer().resume().then(() => getMusicPlayer().setTrack('combat'));`,
 '剧情战斗曲挂钩');

// ④ 巨量伤害不消失爆炸: 主舰血量低于 1% 时托底(它只能按剧情坠落)
rep(E, `      // 主舰不在这条路上: 它的坠落只由剧情闸门(四个阶段)决定, 见 startBossFall()
      if (u.hp <= 0 && u.alive && u.isAir && !u.isComponent && !u.boss) {`,
`      // === 主舰受巨量伤害也不"模型消失 + 爆炸" (per user request) ==============
      // 它的收场只有一条路: 四个剧情阶段走完 -> startBossFall() 的惯性坠落。
      // 所以这里对主舰做血量托底(至少留 1), 并把 falling 撤销 —— 掉血只会拆挂点。
      if (u.boss && u.hp < 1) u.hp = 1;
      // 主舰不在这条路上: 它的坠落只由剧情闸门(四个阶段)决定, 见 startBossFall()
      if (u.hp <= 0 && u.alive && u.isAir && !u.isComponent && !u.boss) {`,
 '主舰血量托底');
console.log('§231b done');
