// §241b: 开局 5 艘友军空中战舰(两种型号混编) + 战损后自动补充
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

// spawnAirWarship 支持型号
rep(`  private spawnAirWarship(isAlly: boolean, dist: number, angle: number): GroundUnit | null {
    try {
      const model = buildAirWarship(isAlly, 1);`,
`  private spawnAirWarship(isAlly: boolean, dist: number, angle: number, variant: AirWarshipVariant = 'missile'): GroundUnit | null {
    try {
      const model = buildAirWarship(isAlly, 1, variant);`,
 'spawnAirWarship 支持型号');
rep(`      if (u) u.name = '铁砧' + (index + 1);`,
`      if (u) u.name = '铁砧' + (index + 1);`,
 'noop');
rep(`  buildAirWarship, makeAirWarshipMotion, updateAirWarshipMotion,`,
`  buildAirWarship, makeAirWarshipMotion, updateAirWarshipMotion, type AirWarshipVariant,`,
 '导入型号类型');

// 开局刷 5 艘友军战舰(围着主舰) + 补充逻辑
rep(`    this.spawnStorySquadrons(12);`,
`    this.spawnStorySquadrons(12);
    // === 开局刷 5 艘友军空中战舰, 围着敌方主舰打 (per user request) ============
    // 两种型号混编: 3 艘导弹型(反舰齐射) + 2 艘防空炮型(给友军打伞)。
    // 它们会自己索敌(见我方的 seek 逻辑)—— 目标是敌方主舰, 顺带吸引护航机火力。
    this.spawnStoryAllyWarships();`,
 '开局友军战舰');
rep(`  /** 按阶段装载表重建 16 个挂点(先把上一阶段的挂点单位 + 网格全部清除)。 */`,
`  /**
   * 友军空中战舰编队 (per user request: 开局刷 5 艘友军空中战舰在 boss 周围, 死了就补新的)。
   * 围着敌方主舰散开生成: 3 艘导弹型 + 2 艘防空炮型(型号交替), 上限 5 艘;
   * 战损后由 updateStoryS01 按冷却补位, 于是战场上始终有 5 艘在打主舰。
   */
  private spawnStoryAllyWarships() {
    const boss = this.boss;
    if (!boss) return;
    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * Math.PI * 2 + Math.random() * 0.4;
      const dist = 2200 + Math.random() * 2600;   // 围着主舰散开(3.9~9.8km 的舰体尺度下很贴身)
      const u = this.spawnAirWarship(true, dist, ang, i % 2 === 0 ? 'missile' : 'gun');
      if (u) {
        u.name = (i % 2 === 0 ? '友军导弹舰' : '友军防空舰') + ' #' + (i + 1);
        // 生成点相对**主舰**而不是地图原点(主舰在 13km 外进场)
        const bx = boss.position.x + Math.cos(ang) * dist;
        const bz = boss.position.z + Math.sin(ang) * dist;
        const hFn = (this as unknown as { _terrainHeightFn?: (x: number, z: number) => number })._terrainHeightFn;
        const terr = hFn ? hFn(bx, bz) : 0;
        u.position.set(bx, terr + AIR_WARSHIP_MIN_AGL + 300 + Math.random() * 900, bz);
        u.group.position.copy(u.position);
        u.airMotion = makeAirWarshipMotion(u.heading);
      }
    }
  }

  /** 友军战舰补位: 场上活着的友军轻型舰少于 5 艘时, 每 18 秒补一艘(型号交替)。 */
  private replenishStoryAllyWarships(dt: number) {
    const boss = this.boss;
    if (!boss || !boss.alive) return;
    this.bossAllyShipT -= dt;
    if (this.bossAllyShipT > 0) return;
    const alive = this.groundUnits.filter((g) => g.alive && g.isAlly && g.type === 'air_light');
    if (alive.length >= 5) { this.bossAllyShipT = 4; return; }
    this.bossAllyShipT = 18;
    this.bossAllyShipN = (this.bossAllyShipN ?? 0) + 1;
    const ang = Math.random() * Math.PI * 2;
    const dist = 2600 + Math.random() * 2400;
    const u = this.spawnAirWarship(true, dist, ang, this.bossAllyShipN % 2 === 0 ? 'missile' : 'gun');
    if (u) {
      u.name = (this.bossAllyShipN % 2 === 0 ? '友军导弹舰' : '友军防空舰') + ' 补充#' + this.bossAllyShipN;
      const bx = boss.position.x + Math.cos(ang) * dist;
      const bz = boss.position.z + Math.sin(ang) * dist;
      const hFn = (this as unknown as { _terrainHeightFn?: (x: number, z: number) => number })._terrainHeightFn;
      const terr = hFn ? hFn(bx, bz) : 0;
      u.position.set(bx, terr + AIR_WARSHIP_MIN_AGL + 300 + Math.random() * 900, bz);
      u.group.position.copy(u.position);
      u.airMotion = makeAirWarshipMotion(u.heading);
      this.showMessage('友军空中战舰补充到位', 1.6);
    }
  }

  /** 按阶段装载表重建 16 个挂点(先把上一阶段的挂点单位 + 网格全部清除)。 */`,
 '友军战舰编队 + 补位');

// 每帧调用补位
rep(`    // === 无人机(蜂群): 持续放出, 数量有限, 被击落后过一段时间补充 ===`,
`    // 友军战舰补位(死了就补新的, per user request)
    this.replenishStoryAllyWarships(dt);

    // === 无人机(蜂群): 持续放出, 数量有限, 被击落后过一段时间补充 ===`,
 '每帧补位');

// 字段
rep(`  /** 我方战果台词的"已播过"标记(首杀/激光/核心模块等各只播一次) */`,
`  /** 友军战舰补位计时 + 型号交替计数 */
  private bossAllyShipT = 8;
  private bossAllyShipN = 0;
  /** 我方战果台词的"已播过"标记(首杀/激光/核心模块等各只播一次) */`,
 '补位字段');

// resetState
rep(`    this.bossDroneTimer = 12;`,
`    this.bossDroneTimer = 12;
    this.bossAllyShipT = 8;
    this.bossAllyShipN = 0;`,
 'resetState 补位字段');
