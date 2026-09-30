// §238: ① 敌机锁玩家要 7 秒 + 发射后重新锁 ② 击杀回到旧爆炸声
//       ③ boss 激光阵列搬雪山关的激光防空炮 ④ IR 锁定环减半 ⑤ 碰撞盒按 FBX 形状(分段)
//       ⑥ 我方中队跟着主机 ⑦ 尾焰前后方向再翻
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
const H = 'src/components/game/Hud.tsx';

// ---------- ① 敌机锁玩家 7 秒 + 发射后重新锁 ----------
rep(E, `/** 同时最多几个敌方单位(海陆空一起算)可以对玩家有攻击意图 (per user request: 3) */
const MAX_PLAYER_ATTACKERS = 3;`,
`/** 同时最多几个敌方单位(海陆空一起算)可以对玩家有攻击意图 (per user request: 3) */
const MAX_PLAYER_ATTACKERS = 3;
/** 敌方**锁定玩家**所需的雷达照射时间(秒) —— per user request: 7 秒。
 *  比其它目标(普通 2.5~4 秒)长得多, 于是玩家有充足时间做机动甩锁。 */
const PLAYER_LOCK_SECONDS = 7;`,
 'PLAYER_LOCK_SECONDS');

rep(E, `          if (inFunnel) {
            // Respect the simultaneous-attacker cap when locking the player.
            if (target === this.player && playerAttackBudget <= 0) {
              e.aiLockTimer = Math.max(0, e.aiLockTimer - dt * 1.5);
            } else {
              if (target === this.player) playerAttackBudget--;
              e.aiLockTimer += dt;
            }`,
`          // 锁定玩家要 7 秒(其它目标仍走各自的 aiLockRequired)
          const needLock = target === this.player ? PLAYER_LOCK_SECONDS : e.aiLockRequired;
          (e as unknown as { _lockNeed?: number })._lockNeed = needLock;
          if (inFunnel) {
            // Respect the simultaneous-attacker cap when locking the player.
            if (target === this.player && playerAttackBudget <= 0) {
              e.aiLockTimer = Math.max(0, e.aiLockTimer - dt * 1.5);
            } else {
              if (target === this.player) playerAttackBudget--;
              e.aiLockTimer += dt;
            }`,
 '锁定玩家 7 秒(路径1)');

rep(E, `          if (inFunnel) {
            // Respect the simultaneous-attacker cap when locking the player.
            if (tgtIsPlayer && playerAttackBudget <= 0) {`,
`          // 锁定玩家要 7 秒
          const needLock2 = tgtIsPlayer ? PLAYER_LOCK_SECONDS : e.aiLockRequired;
          (e as unknown as { _lockNeed?: number })._lockNeed = needLock2;
          if (inFunnel) {
            // Respect the simultaneous-attacker cap when locking the player.
            if (tgtIsPlayer && playerAttackBudget <= 0) {`,
 '锁定玩家 7 秒(路径2)');

rep(E, `e.aiLockTimer >= e.aiLockRequired`, `e.aiLockTimer >= ((e as unknown as { _lockNeed?: number })._lockNeed ?? e.aiLockRequired)`, '开火条件用 7 秒', true);

// ---------- ② 击杀回到旧爆炸声 ----------
rep(E, `      if (e.spec.isBomber) {
        getMusicPlayer().playSfx('explosion_large');
      }
      // === Kill feedback HUD flash + camera jolt (per user request) ===`,
`      // === 击杀音效: 回到"以前那个"(per user request: 导弹击毁目标依旧使用以前的爆炸声音) ==
      // 之前给轰炸机挂的是新导入的 explosion_large 采样; 用户要求击杀统一用老的爆炸声,
      // 所以这里不再播文件音效, 由下面的 audio.explosion() 统一负责。
      // === Kill feedback HUD flash + camera jolt (per user request) ===`,
 '轰炸机击杀回旧声');
rep(E, `        if (u.type === 'destroyer' || u.type === 'cruiser' || u.type === 'sam_launcher') {
            getMusicPlayer().playSfx('explosion_large');
          }`, `        // (击杀音效统一走 audio.explosion, 不再叠新采样 —— per user request)`, '水面击退回旧声');
rep(E, `      if (u.type === 'destroyer' || u.type === 'cruiser' || u.type === 'sam_launcher') {
        getMusicPlayer().playSfx('explosion_large');
      }`, `      // (击杀音效统一走 audio.explosion —— per user request: 依旧用以前的爆炸声)`, '地面击退回旧声');

// ---------- ④ IR 锁定环减半 ----------
rep(H, `      const baseR = 50 * scale;
      const minR = 22 * scale;`,
`      // === 指示环减半 (per user request: 被导弹锁定的 3d 指示环减小一半) ============
      const baseR = 25 * scale;
      const minR = 11 * scale;`,
 'IR 环减半');

// ---------- ⑦ 尾焰前后方向再翻(整组绕 Y 转 180 度: 喷口 x 对称, 位置不变, 只有火焰朝向反) ----------
rep(E, `    u.group.add(grp);
    setAfterburner(grp, 1);
    this.bossBurnerGroup = grp;`,
`    // === 火焰朝外 (per user request: 后燃器的自身前后方向相反还没改过来) ============
    // 上一轮只把"喷口在哪一端"翻了过来, 但火焰锥体本身仍朝舰体内侧喷(看起来就是"方向反了")。
    // 整组绕 Y 转 180 度: 喷口左右对称 => 位置不变, 只有火焰朝向翻到舰体外侧。
    grp.rotation.y = Math.PI;
    u.group.add(grp);
    setAfterburner(grp, 1);
    this.bossBurnerGroup = grp;`,
 '尾焰朝向翻外');

// ---------- ③ boss 激光阵列 = 雪山关激光防空炮 ----------
rep(E, `  private updateMountLaser(u: GroundUnit, ship: GroundUnit, comp: AirWarshipComponent, dt: number) {
    const CHARGE = 3.0, FIRE = 5.0, COOL = 7.0;`,
`  private updateMountLaser(u: GroundUnit, ship: GroundUnit, comp: AirWarshipComponent, dt: number) {
    // === 参数照搬雪山关的激光防空炮 (per user request: boss 激光阵列就用之前那个激光防空炮) ===
    // 那门炮的手感是: 充能 3 秒 -> 持续照射 5 秒 -> 冷却 7 秒; 光束是"半径 9 米擦到就扣血"的粗柱,
    // 持续伤害 30 HP/秒、每 0.25 秒结算一次(见 laser_aa 段)。这里逐条对齐, 视觉也换成同一套蓝白。
    const CHARGE = 3.0, FIRE = 5.0, COOL = 7.0;
    const BEAM_R = 9;            // 与激光防空炮同一命中半径(米)
    const DPS = 30;              // 同一持续伤害(HP/秒)
    const TICK = 0.25;           // 同一结算节奏(4 Hz)`,
 '激光参数对齐 laser_aa');
rep(E, `    if (distP > 1 && distP < 9000 && toPlayer.normalize().dot(dir) > 0.9994) {
      this.playerHp -= 26 * dt;`,
`    // 命中判定照搬激光防空炮: 目标点到光束线段的距离 <= 9 米即"擦到就扣血", 4 Hz 结算
    const toP = this.player.position.clone().sub(muzzle);
    const segLen = Math.min(len, 9000);
    const uu = segLen > 1e-6 ? Math.max(0, Math.min(1, toP.dot(dir) / segLen)) : 0;
    const closest = muzzle.clone().addScaledVector(dir, uu * segLen);
    const hitDist = closest.distanceTo(this.player.position);
    u.laserDmgT = (u.laserDmgT ?? 0) - dt;
    if (hitDist <= BEAM_R && distP < 9000 && u.laserDmgT <= 0) {
      u.laserDmgT = TICK;
      this.playerHp -= DPS * TICK * WEAPON_DAMAGE_SCALE;`,
 '激光命中判定照搬');

// ---------- ⑤ 碰撞盒按 FBX 形状(分段) ----------
rep(D, `export interface HullFrame {
  half: THREE.Vector3;
  center: THREE.Vector3;
}`,
`export interface HullFrame {
  half: THREE.Vector3;
  center: THREE.Vector3;
  /** === 分段包络 (per user request: 碰撞盒要和 fbx 一样的形状且一样大) ================
   *  单个大盒子会把舰艏/舰艉的尖角也框进去(比本体"大一圈")。这里沿长轴切 N 段, 每段记
   *  自己的 z 范围与 x/y 半宽 —— 于是碰撞盒跟着舰体收窄, 形状与本体一致。
   *  长度随模型缩放, 所以只用相对分数(zFrac)存, 每帧用当前 half 换算。 */
  segments?: { zFrac: number; halfLen: number; hx: number; hy: number }[];
}`,
 'HullFrame.segments');

rep(D, `  const center = new THREE.Vector3(
    (bx.min.x + bx.max.x) / 2,
    minY + half.y,                 // 贴住模型底部
    (bx.min.z + bx.max.z) / 2,
  );
  return { half, center };`,
`  const center = new THREE.Vector3(
    (bx.min.x + bx.max.x) / 2,
    minY + half.y,                 // 贴住模型底部
    (bx.min.z + bx.max.z) / 2,
  );
  // === 分段包络: 沿 Z(长轴)切 16 段, 每段量自己的 x/y 半宽 ========================
  // 只统计舰体带内的点(桅杆已被排除), 于是得到"跟着舰体收窄"的形状而不是一个大盒子。
  const NSEG = 16;
  const segLen = (half.z * 2) / NSEG;
  const segs: { zFrac: number; halfLen: number; hx: number; hy: number }[] = [];
  for (let i = 0; i < NSEG; i++) {
    const z0 = center.z - half.z + i * segLen;
    const z1 = z0 + segLen;
    let hx = 0, hy = 0, n = 0;
    for (const v of pts) {
      if (v.y > hullTopY || v.z < z0 || v.z >= z1) continue;
      hx = Math.max(hx, Math.abs(v.x - center.x));
      hy = Math.max(hy, Math.abs(v.y - center.y));
      n++;
    }
    if (n === 0) continue;   // 空段(理论上没有)直接跳过
    segs.push({
      zFrac: (z0 + z1) / 2 - center.z,
      halfLen: segLen / 2,
      hx: Math.max(1e-3, hx),
      hy: Math.max(1e-3, hy),
    });
  }
  return { half, center, segments: segs.length > 0 ? segs : undefined };`,
 '分段包络生成');

rep(E, `        if (this.playerHp > 0 && this.bossModel) {
          const half = this.bossModel.hullFrame.half;
          _bossInv.copy(u.group.matrixWorld).invert();
          _bossLocal.copy(this.player.position).applyMatrix4(_bossInv).sub(this.bossModel.hullFrame.center);
          const ax = Math.abs(_bossLocal.x), ay = Math.abs(_bossLocal.y), az = Math.abs(_bossLocal.z);
          if (ax < half.x && ay < half.y && az < half.z) {
            // 最近的面 = 出射方向
            const dx = half.x - ax, dy = half.y - ay, dz = half.z - az;`,
`        if (this.playerHp > 0 && this.bossModel) {
          const frame = this.bossModel.hullFrame;
          const half = frame.half;
          _bossInv.copy(u.group.matrixWorld).invert();
          _bossLocal.copy(this.player.position).applyMatrix4(_bossInv).sub(frame.center);
          // === 用**分段包络**判定(形状与 FBX 本体一致, 不再是"大一圈"的外接盒) ==========
          // 先找玩家所在的段(按 z), 再用该段自己的 x/y 半宽判断在不在体内。
          let inBody = false;
          let segHalfX = half.x, segHalfY = half.y;
          if (frame.segments && frame.segments.length > 0) {
            const seg = frame.segments.find((s) => Math.abs(_bossLocal.z - s.zFrac) <= s.halfLen)
              ?? frame.segments.reduce((best, s) => (Math.abs(_bossLocal.z - s.zFrac) < Math.abs(_bossLocal.z - best.zFrac) ? s : best), frame.segments[0]);
            segHalfX = seg.hx; segHalfY = seg.hy;
            inBody = Math.abs(_bossLocal.x) < seg.hx && Math.abs(_bossLocal.y) < seg.hy;
          } else {
            inBody = Math.abs(_bossLocal.x) < half.x && Math.abs(_bossLocal.y) < half.y;
          }
          const ax = Math.abs(_bossLocal.x), ay = Math.abs(_bossLocal.y), az = Math.abs(_bossLocal.z);
          if (inBody && az < half.z) {
            // 最近的面 = 出射方向(用**本段**的半宽算, 于是被推出到舰体表面而不是包络盒表面)
            const dx = segHalfX - ax, dy = segHalfY - ay, dz = half.z - az;`,
 '分段碰撞判定');

// ---------- ⑥ 我方中队跟着主机(而不是扑向主舰) ----------
rep(E, `    this.spawnStorySquadrons(8);`, `    this.spawnStorySquadrons(12);`, '中队数量 8->12');
rep(E, `      // 两个中队: 每 4 架一队, 一队在玩家左后, 一队在右后
      const squad = Math.floor(i / 4);
      const k = i % 4;`,
`      // 三个中队: 每 4 架一队, 分列玩家左后 / 右后 / 正后上方
      const squad = Math.floor(i / 4);
      const k = i % 4;`,
 '中队三列');
rep(E, `      const squad = Math.floor(i / 4);
      const k = i % 4;
      g.position.set(
        p.x + (squad === 0 ? -1 : 1) * (420 + k * 160),
        p.y + 260 + (k % 2) * 90,
        p.z - 900 - Math.floor(k / 2) * 200,
      );`,
`      const squad = Math.floor(i / 4);
      const k = i % 4;
      const side = squad === 0 ? -1 : squad === 1 ? 1 : 0;
      g.position.set(
        p.x + side * (420 + k * 170),
        p.y + 240 + (k % 2) * 90 + (squad === 2 ? 260 : 0),
        p.z - 900 - Math.floor(k / 2) * 200,
      );`,
 '三列站位');
rep(E, `    // 我方中队的攻击目标 = 敌方主舰(它们会自己飞过去打, 从而分走敌人注意力)
    if (this._sorties.length > 0) {
      for (const s of this._sorties) if (s.alive) s.target.copy(boss.position);
    }`,
`    // === 我方中队**跟着主角** (per user request: 跟着主角吸引注意力) ==================
    // 它们不再飞向主舰, 而是把"目标点"设在玩家前上方 —— 于是队形跟着玩家走(护航),
    // 途中遇到敌机照样开火; 敌人的注意力会分到它们身上(配合"最多 3 个咬玩家"的配额)。
    if (this._sorties.length > 0) {
      for (let i = 0; i < this._sorties.length; i++) {
        const s = this._sorties[i];
        if (!s.alive) continue;
        const k = i % 4;
        const side = i < 4 ? -1 : i < 8 ? 1 : 0;
        s.target.set(
          this.player.position.x + side * (420 + k * 170),
          this.player.position.y + 240 + (k % 2) * 90 + (i >= 8 ? 260 : 0),
          this.player.position.z - 700 - Math.floor(k / 2) * 200,
        );
      }
    }`,
 '中队跟随玩家');
console.log('§238 done');
