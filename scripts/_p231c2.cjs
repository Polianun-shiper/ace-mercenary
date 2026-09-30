// §231c(2): 修掉刚才那批的类型问题(AI 低模 info 构造 / 锁定圈参数 / Enemy.intentPlayer)
const fs = require('fs');
const E = 'src/lib/game/engine.ts';
function rep(a, b, label) {
  let s = fs.readFileSync(E, 'utf8');
  const n = s.split(a).length - 1;
  if (n === 0) { console.log('skip:', label); return; }
  if (n !== 1) { console.error('miss(' + n + '):', label); process.exit(1); }
  fs.writeFileSync(E, s.replace(a, b));
  console.log('ok:', label);
}

rep(`    const info = getLowGeometry(spawn.model) ? { ...this.geomCache[spawn.model], geometry: getLowGeometry(spawn.model) } : this.geomCache[spawn.model];
    if (!info) return;`,
`    const baseInfo = this.geomCache[spawn.model];
    if (!baseInfo) return;
    const info: AircraftGeometryInfo = { ...baseInfo, geometry: getLowGeometry(spawn.model) };`,
 'AI 低模 info 构造');

rep(`    // === 玩家雷达锁定圈 (per user request: TAB 的最高优先级在雷达锁定圈之内, 且优先近的) ====
    // 判定与武器锁定一致: 距离进 lockRange, 且目标落在机头前的锁定锥里 —— 也就是 HUD 上
    // 那个"锁定圈"能罩住的那些目标。圈内的按**距离由近到远**排在最前面; 圈外的维持原来的
    // "屏幕中心优先 + 距离微调" 规则(联机/近战乱斗时手感不变)。
    const fwd = this.playerForward ?? new THREE.Vector3(0, 0, 1);
    const lockRange = this.weapons.lockRangeFor(this.currentWeapon);
    const LOCK_COS = Math.cos(THREE.MathUtils.degToRad(this.weapons.lockConeDeg()));`,
`    // === 玩家雷达锁定圈 (per user request: TAB 的最高优先级在雷达锁定圈之内, 且优先近的) ====
    // 判定与"能不能锁定开火"一致: 距离进该武器的锁定距离, 且目标落在机头前约 45° 的锁定锥里
    // (与 updateLock 的 0.7 cos 阈值同源)—— 也就是 HUD 那个锁定圈能罩住的目标。
    // 圈内的按**距离由近到远**排最前; 圈外的维持原规则(屏幕中心优先 + 距离微调), 乱斗手感不变。
    const fwd = this.playerForward;
    const lockRange = this.weaponLockRange();
    const LOCK_COS = 0.7;`,
 '锁定圈参数');

rep(`  private orderTargetsForCycle(list: Enemy[]): Enemy[] {`,
`  /** 当前武器的锁定距离(与 updateLock 里的表保持一致; 只是把那张表提出来复用)。 */
  private weaponLockRange(): number {
    if (this.currentWeapon === 'LASM') return 5000;
    if (this.currentWeapon === 'LAAM') return 8000;
    if (this.currentWeapon === 'QAAM') return 4000;
    if (this.currentWeapon === 'SARH') return 6000;
    if (this.currentWeapon === '4AAM' || this.currentWeapon === '4AGM') return 6000;
    if (this.currentWeapon === 'VASM') return 7000;
    return 3500;
  }

  private orderTargetsForCycle(list: Enemy[]): Enemy[] {`,
 'weaponLockRange 方法');

rep(`interface Enemy extends EnemyHandle {
  model: AircraftModel;`,
`interface Enemy extends EnemyHandle {
  model: AircraftModel;
  /** true = 这个 AI 当前的攻击意图是**玩家**(用于"同时最多 4 个咬玩家"的配额) */
  intentPlayer?: boolean;`,
 'Enemy.intentPlayer 字段');
