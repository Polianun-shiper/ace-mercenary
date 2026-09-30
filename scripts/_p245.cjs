// §245: ① 主舰坠落爆炸 面积x6 + 动画 1/6 速 ② 友军战舰 x2(10 艘) ③ MiG-29 尾焰对准尾喷口
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

// ① 主舰触地爆炸: 面积 x6(线度 x sqrt(6)) + 动画时间 x6(慢 1/6) + 巨大爆炸声
rep(E, `            // 触地大爆炸: 主舰用更大的 scale (per user request)
            const bigK = u.boss ? 1.6 : 1;
            this.weapons.spawnExplosion(u.position.clone(), 9 * bigK);
            this.weapons.spawnExplosion(u.position.clone().add(new THREE.Vector3(0, 18, 0)), 6 * bigK);`,
`            // === 主舰坠落爆炸 (per user request: 特效面积 x6, 动画速度降到 1/6, 巨大的爆炸声) ====
            // "面积 x6" = 线度 x sqrt(6) ≈ 2.45(想直接线度 x6 就把 CRASH_AREA_K 改成 6);
            // "动画 1/6 速" = spawnExplosion 的 timeScale 传 6(它会把这一批图层的 life/maxLife 乘 6,
            // 而膨胀/淡出用的是 t = 1 - life/maxLife, 于是整体慢 6 倍且形状不变)。
            const CRASH_AREA_K = Math.sqrt(6);
            const bigK = u.boss ? 1.6 * CRASH_AREA_K : 1;
            const slowK = u.boss ? 6 : 1;
            this.weapons.spawnExplosion(u.position.clone(), 9 * bigK, 1, slowK);
            this.weapons.spawnExplosion(u.position.clone().add(new THREE.Vector3(0, 18, 0)), 6 * bigK, 1, slowK);
            if (u.boss) {
              // 主舰坠毁: 叠加更大的火球 + 巨大爆炸声(过场里那一下要震)
              this.weapons.spawnExplosion(u.position.clone().add(new THREE.Vector3(0, 40, 0)), 5 * CRASH_AREA_K, 1.4, slowK);
              this.audio.explosion(2.6);
              getMusicPlayer().playSfx('explosion_large');
              this.camera.addShake(1.8);
            }`,
 '主舰坠毁爆炸 x6/慢6倍');

// ② 友军空中战舰 x2(5 -> 10)
rep(E, `    this.spawnStoryAllyWarships();`,
`    this.spawnStoryAllyWarships();`, 'noop');
rep(E, `    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * Math.PI * 2 + Math.random() * 0.4;`,
`    // per user request: 友军空中战舰数量 x2(5 -> 10), 依然围着主舰打
    const N = 10;
    for (let i = 0; i < N; i++) {
      const ang = (i / N) * Math.PI * 2 + Math.random() * 0.4;`,
 '友军战舰 10 艘');
rep(E, `    const alive = this.groundUnits.filter((g) => g.alive && g.isAlly && g.type === 'air_light');
    if (alive.length >= 5) { this.bossAllyShipT = 4; return; }`,
`    const alive = this.groundUnits.filter((g) => g.alive && g.isAlly && g.type === 'air_light');
    if (alive.length >= 10) { this.bossAllyShipT = 4; return; }   // 上限同步 x2(per user request)`,
 '补位上限 10');
rep(E, `      const u = this.spawnAirWarship(true, dist, ang, i % 2 === 0 ? 'missile' : 'gun');
      if (u) {
        u.name = (i % 2 === 0 ? '友军导弹舰' : '友军防空舰') + ' #' + (i + 1);`,
`      const u = this.spawnAirWarship(true, dist, ang, i % 2 === 0 ? 'missile' : 'gun');
      if (u) {
        u.name = (i % 2 === 0 ? '友军导弹舰' : '友军防空舰') + ' #' + (i + 1);`,
 'noop2');

// ③ MiG-29 尾焰: 去掉过头的位置偏移, 只保留放大 —— 位置交给 applyNozzleAlign(默认已对准尾喷口)
rep(E, `    if (isMig29) {
      this.playerAfterburner.scale.multiplyScalar(1.6);
      this.playerAfterburner.position.z -= 2.2 * meshScale;
      this.playerAfterburner.position.y -= 0.2 * meshScale;
    }`,
`    // per user request: 大两圈, 但**位置要对准尾喷口中间那个组件** —— 上一版我后移了 2.2 过头了。
    // 位置本身由 applyNozzleAlign 的自动测量负责(它把火焰摆在喷口截面上, 控制台 nozzle 可微调),
    // 所以这里只放大, 不再额外位移。
    if (isMig29) {
      this.playerAfterburner.scale.multiplyScalar(1.6);
    }`,
 'MiG-29 尾焰位置对准');
console.log('§245 done');
