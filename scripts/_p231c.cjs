// §231c: AI 低模 / TAB 优先锁定圈 / 同时最多 4 个敌机打玩家 / 机库预览 x2 / 4AAM-4AGM 挂载量 / 简报音乐
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
const G = 'src/components/game/GameApp.tsx';
const H = 'src/lib/game/hangar.ts';
const SP = 'src/lib/game/sp-weapons.ts';

// ---------- ① AI 单位全部走低模 ==========
rep(E, `    const info = this.geomCache[spawn.model];
    if (!info) return;
    const stats = this.getAircraftStats(spawn.model, spawn.role);`,
`    // === AI 单位一律用低模 (per user request: AI 单位全部要用低模) ==============
    // geomCache 里是"玩家级"模型(F-16C 是 36MB 的 OBJ, 上万面); 敌人/僚机是成打同时在场,
    // 用共享低模(~300 面/机型, 每机型只建一次)才是正确开销 —— 也顺便让 AI 机体在远处更好认。
    // 玩家机的路径不走这里(见 buildPlayer), 所以主视角画质不受影响。
    const info = getLowGeometry(spawn.model) ? { ...this.geomCache[spawn.model], geometry: getLowGeometry(spawn.model) } : this.geomCache[spawn.model];
    if (!info) return;
    const stats = this.getAircraftStats(spawn.model, spawn.role);`,
 'AI 低模(spawnEnemyFromWave)');

// ---------- ② TAB: 锁定圈内优先 + 优先近的 ==========
rep(E, `  private orderTargetsForCycle(list: Enemy[]): Enemy[] {
    const cam = this.camera.camera;
    cam.updateMatrixWorld();
    const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
    return list
      .map((e) => {
        const to = e.position.clone().sub(this.player.position);
        const dist = to.length();
        to.normalize();
        // Dot with camera forward — 1.0 = 正前方, -1.0 = 正后方。
        return { e, score: to.dot(camFwd) - Math.min(dist, 8000) / 80000 }; // 距离项最多贡献 -0.1
      })
      .sort((a, b) => b.score - a.score)
      .map((s) => s.e);
  }`,
`  private orderTargetsForCycle(list: Enemy[]): Enemy[] {
    const cam = this.camera.camera;
    cam.updateMatrixWorld();
    const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
    // === 玩家雷达锁定圈 (per user request: TAB 的最高优先级在雷达锁定圈之内, 且优先近的) ====
    // 判定与武器锁定一致: 距离进 lockRange, 且目标落在机头前的锁定锥里 —— 也就是 HUD 上
    // 那个"锁定圈"能罩住的那些目标。圈内的按**距离由近到远**排在最前面; 圈外的维持原来的
    // "屏幕中心优先 + 距离微调" 规则(联机/近战乱斗时手感不变)。
    const fwd = this.playerForward ?? new THREE.Vector3(0, 0, 1);
    const lockRange = this.weapons.lockRangeFor(this.currentWeapon);
    const LOCK_COS = Math.cos(THREE.MathUtils.degToRad(this.weapons.lockConeDeg()));
    return list
      .map((e) => {
        const to = e.position.clone().sub(this.player.position);
        const dist = to.length();
        to.normalize();
        const inCircle = dist <= lockRange && to.dot(fwd) >= LOCK_COS;
        return {
          e,
          inCircle,
          dist,
          // Dot with camera forward — 1.0 = 正前方, -1.0 = 正后方。
          score: to.dot(camFwd) - Math.min(dist, 8000) / 80000, // 距离项最多贡献 -0.1
        };
      })
      .sort((a, b) => {
        if (a.inCircle !== b.inCircle) return a.inCircle ? -1 : 1;
        if (a.inCircle) return a.dist - b.dist;   // 圈内: 近的优先
        return b.score - a.score;                 // 圈外: 屏幕中心优先
      })
      .map((s) => s.e);
  }`,
 'TAB 锁定圈优先');

// ---------- ③ 同时最多 4 个敌机打玩家, 超出的转向友军/僚机 ==========
rep(E, `      e.retargetTimer = (e.retargetTimer ?? 0) - dt;
      // !== P3: 友军化的 AI 永不重新索敌(见上方说明)
      if (e.retargetTimer <= 0 && !e.isAlly) {`,
`      e.retargetTimer = (e.retargetTimer ?? 0) - dt;
      // === 同时最多 4 个敌机有攻击玩家的意图 (per user request) ==================
      // 超出的那些**转向玩家友军和僚机**, 而不是傻等在圈外挂机 —— 这样大编队仍然有威胁,
      // 但玩家不会被十几发导弹同时招呼。计数用 e.intentPlayer 标记, 每帧统计一次。
      const MAX_PLAYER_ATTACKERS = 4;
      let playerIntent = 0;
      for (const other of this.enemies) {
        if (other !== e && other.alive && !other.isAlly && other.intentPlayer) playerIntent++;
      }
      e.intentPlayer = e.intentPlayer === true;
      const intentSlots = MAX_PLAYER_ATTACKERS;
      // !== P3: 友军化的 AI 永不重新索敌(见上方说明)
      if (e.retargetTimer <= 0 && !e.isAlly) {`,
 '攻击意图计数');

rep(E, `        if (playerTargets.length > 0 && Math.random() < 0.75) {`,
`        // 意图配额用完 = 这次索敌只能去咬友军/僚机
        const wantPlayer = playerTargets.length > 0 && Math.random() < 0.75 && playerIntent < intentSlots;
        if (wantPlayer) {
          e.intentPlayer = true;
        } else {
          e.intentPlayer = false;
        }
        if (wantPlayer) {`,
 '意图配额判定');

// ---------- ④ 机库预览放大 2 倍 ==========
rep(H, `  private targetDist = 38;`,
`  // === 预览放大 2 倍 (per user request: 机库的所有飞机都放大 2 倍大小) ============
  // 机体本身 x PREVIEW_SCALE, 相机距离也同步拉开(否则放大后直接被裁掉)。
  private static readonly PREVIEW_SCALE = 2;
  private targetDist = 38 * HangarViewer.PREVIEW_SCALE;`,
 '机库预览倍率');
rep(H, `      g.scale.setScalar(1.7);`, `      g.scale.setScalar(1.7 * HangarViewer.PREVIEW_SCALE);`, 'f16c 预览 x2', true);
rep(H, `      group.scale.setScalar(1.1);`, `      group.scale.setScalar(1.1 * HangarViewer.PREVIEW_SCALE);`, 'f16c group x2', true);
rep(H, `    this.targetDist = THREE.MathUtils.clamp(this.targetDist + e.deltaY * 0.05, 14, 90);`,
`    this.targetDist = THREE.MathUtils.clamp(this.targetDist + e.deltaY * 0.05, 14 * HangarViewer.PREVIEW_SCALE, 90 * HangarViewer.PREVIEW_SCALE);`,
 '缩放范围 x2');
rep(H, `      this.targetDist = 38;`, `      this.targetDist = 38 * HangarViewer.PREVIEW_SCALE;`, 'settle 距离 x2', true);

// ---------- ⑤ 4AAM / 4AGM 挂载量 ==========
rep(SP, `    ammo: 12,
    lockType: 'radar',
    multiLock: 4,`,
`    // === 挂载量翻倍 (per user request: 4AAM/4AGM 的挂载量) ====================
    // 12 -> 24: 4 目标齐射从 3 轮变成 6 轮, 大编队/多挂点目标才够用。
    ammo: 24,
    lockType: 'radar',
    multiLock: 4,`,
 '4AAM 挂载量');

// ---------- ⑥ 简报界面专属音乐 ==========
rep(G, `    if (phase === 'menu' || phase === 'mission-select' || phase === 'story-select' || phase === 'story-brief'
      || phase === 'story-hub' || phase === 'prep' || phase === 'hangar' || phase === 'briefing' || phase === 'settings') {
      const mp = getMusicPlayer();
      mp.setTrack('menu');
    }`,
`    // === 简报界面换专属曲 (per user request: 进入简报界面就换成这个 briefing 音乐) ====
    if (phase === 'story-brief') {
      getMusicPlayer().setTrack('briefing', 900);
    } else if (phase === 'menu' || phase === 'mission-select' || phase === 'story-select'
      || phase === 'story-hub' || phase === 'prep' || phase === 'hangar' || phase === 'briefing' || phase === 'settings') {
      getMusicPlayer().setTrack('menu');
    }`,
 '简报音乐挂钩');
console.log('§231c done');
