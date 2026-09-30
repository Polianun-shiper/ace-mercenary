// §229c: 引擎记录飞行轨迹 + 击杀点(给 3D 结算界面的"线框地形上的空战轨迹"用)
//       + GameApp 的剧情流程接线(剧情选择 -> 3D 简报 -> 枢纽菜单 -> 战斗准备(机库) -> 出击 -> 3D 结算)
const fs = require('fs');
function rep(file, a, b, label) {
  let s = fs.readFileSync(file, 'utf8');
  const n = s.split(a).length - 1;
  if (n === 0) { console.log('skip:', label); return; }
  if (n !== 1) { console.error('miss(' + n + ') ' + file + ':', label); process.exit(1); }
  fs.writeFileSync(file, s.replace(a, b));
  console.log('ok:', label);
}

// ============ ① 引擎: 轨迹字段 ============
const E = 'src/lib/game/engine.ts';
rep(E, `  private bossFallBlocked = false;  // 已撤销过一次"非剧情坠落"(只警告一次, 免得刷屏)`,
`  private bossFallBlocked = false;  // 已撤销过一次"非剧情坠落"(只警告一次, 免得刷屏)
  // === 3D 结算界面用的飞行轨迹 / 击杀点 (per user request: 结算界面画空战轨迹) ======
  // 每 0.5 秒采一个玩家位置, 上限 1500 点(超出后隔点抽稀, 所以一整局都能覆盖到);
  // 击杀点只在 killEnemy 时记一个, 上限 200。两者都在 endMission 时随结算数据一起交给 UI。
  private flightPath: THREE.Vector3[] = [];
  private flightPathT = 0;
  private killMarks: THREE.Vector3[] = [];`,
 'engine flightPath fields');

// 采样: 塞进 update() 里已挂的剧情循环旁边(每帧都会跑到, 内部自己节流)
rep(E, `    this.updateStoryS01(dt);    // 正式版剧情第一关: 主舰阶段推进 / 无人机 / 随机台词`,
`    this.updateStoryS01(dt);    // 正式版剧情第一关: 主舰阶段推进 / 无人机 / 随机台词
    // 飞行轨迹采样(0.5s 一次; 超过 1500 点后隔点抽稀, 于是全程都留得下)
    this.flightPathT -= dt;
    if (this.flightPathT <= 0) {
      this.flightPathT = 0.5;
      if (this.flightPath.length >= 1500) {
        this.flightPath = this.flightPath.filter((_, i) => i % 2 === 0);
      }
      this.flightPath.push(this.player.position.clone());
    }`,
 'flight path sampling');

// 击杀点
rep(E, `  private killEnemy(e: Enemy) {
    e.alive = false;
    e.hp = 0;`,
`  private killEnemy(e: Enemy) {
    e.alive = false;
    e.hp = 0;
    // 3D 结算界面用: 记下击杀点(上限 200, 超了就丢最早那个)
    if (this.killMarks.length < 200) this.killMarks.push(e.position.clone());`,
 'kill marks');

// 结算数据里带上轨迹(抽稀到 <= 600 点, 免得跨进程传一个巨大数组)
rep(E, `      this.cb.onMissionComplete({
        win,
        score: mp ? mp.score : this.score`,
`      // 轨迹抽稀: 目标 <= 600 点(3D 结算只需形状, 不需要每个 0.5s 的原始点)
      const stride = Math.max(1, Math.ceil(this.flightPath.length / 600));
      const path = this.flightPath
        .filter((_, i) => i % stride === 0)
        .map((v) => [Math.round(v.x), Math.round(v.y), Math.round(v.z)] as [number, number, number]);
      const killMarks = this.killMarks
        .slice(-64)
        .map((v) => [Math.round(v.x), Math.round(v.y), Math.round(v.z)] as [number, number, number]);
      this.cb.onMissionComplete({
        win,
        path,
        killMarks,
        score: mp ? mp.score : this.score`,
 'mission complete payload');

// resetState 清空
rep(E, `    this.bossFlareTimer = 0;`,
`    this.bossFlareTimer = 0;
    this.flightPath = [];
    this.flightPathT = 0;
    this.killMarks = [];`,
 'resetState flight path');

// 公开只读: 这一关是不是正式版剧情关卡(结算界面据此选 3D 版)
rep(E, `  get missionReady(): boolean {`,
`  /** 正式版剧情关卡(结算屏要换成 3D 轨迹版)。 */
  get storyMission(): boolean {
    return this.isS01;
  }

  get missionReady(): boolean {`,
 'storyMission getter');

console.log('§229c(引擎) done');
