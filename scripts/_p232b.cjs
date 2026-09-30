// §232b: 我方空中战舰 ① 6 个导弹发射器 ② 自己索敌 -> 转向 -> 环绕攻击
const fs = require('fs');
function rep(file, a, b, label, all) {
  let s = fs.readFileSync(file, 'utf8');
  const n = s.split(a).length - 1;
  if (n === 0) { console.log('skip:', label); return; }
  if (!all && n !== 1) { console.error('miss(' + n + ') ' + file + ':', label); process.exit(1); }
  fs.writeFileSync(file, all ? s.split(a).join(b) : s.replace(a, b));
  console.log('ok:', label);
}
const AW = 'src/lib/game/air-warship.ts';
const E = 'src/lib/game/engine.ts';

// ---------- ① 我方轻型舰: 6 个导弹发射器 ----------
rep(AW, `  const defs: { normal: THREE.Vector3; kind: AirWarshipComponentKind; pos: THREE.Vector3 }[] = [
    { normal: new THREE.Vector3(0, 1, 0), kind: 'gun', pos: new THREE.Vector3(0, s.hei / 2, s.len * 0.30) },
    { normal: new THREE.Vector3(0, 1, 0), kind: 'gun', pos: new THREE.Vector3(0, s.hei / 2, -s.len * 0.06) },
    { normal: new THREE.Vector3(0, 1, 0), kind: 'missile', pos: new THREE.Vector3(-s.wid * 0.30, s.hei / 2, s.len * 0.14) },
    { normal: new THREE.Vector3(0, 1, 0), kind: 'missile', pos: new THREE.Vector3(s.wid * 0.30, s.hei / 2, s.len * 0.14) },
    { normal: new THREE.Vector3(0, -1, 0), kind: 'gun', pos: new THREE.Vector3(-s.wid * 0.28, -s.hei / 2, 0) },
    { normal: new THREE.Vector3(0, -1, 0), kind: 'gun', pos: new THREE.Vector3(s.wid * 0.28, -s.hei / 2, 0) },
  ];`,
`  // === 我方舰: 6 个部件**全部是导弹发射器** (per user request: 我方的空中战舰增加到 6 个导弹发射器部位) ==
  // 敌我配置刻意做出区别: 我方是"导弹艇"—— 六个挂点全是发射箱, 靠齐射远距离压敌舰;
  // 敌方保持 4 机炮 + 2 导弹的混合配置。射程/伤害走各自阵营那一套(见 engine 的组件开火)。
  const allyDefs: { normal: THREE.Vector3; kind: AirWarshipComponentKind; pos: THREE.Vector3 }[] = [
    { normal: new THREE.Vector3(0, 1, 0), kind: 'missile', pos: new THREE.Vector3(-s.wid * 0.30, s.hei / 2, s.len * 0.30) },
    { normal: new THREE.Vector3(0, 1, 0), kind: 'missile', pos: new THREE.Vector3(s.wid * 0.30, s.hei / 2, s.len * 0.30) },
    { normal: new THREE.Vector3(0, 1, 0), kind: 'missile', pos: new THREE.Vector3(-s.wid * 0.30, s.hei / 2, s.len * 0.02) },
    { normal: new THREE.Vector3(0, 1, 0), kind: 'missile', pos: new THREE.Vector3(s.wid * 0.30, s.hei / 2, s.len * 0.02) },
    { normal: new THREE.Vector3(0, 1, 0), kind: 'missile', pos: new THREE.Vector3(0, s.hei / 2, -s.len * 0.30) },
    { normal: new THREE.Vector3(0, -1, 0), kind: 'missile', pos: new THREE.Vector3(0, -s.hei / 2, -s.len * 0.10) },
  ];
  const defs = isAlly ? allyDefs : [
    { normal: new THREE.Vector3(0, 1, 0), kind: 'gun', pos: new THREE.Vector3(0, s.hei / 2, s.len * 0.30) },
    { normal: new THREE.Vector3(0, 1, 0), kind: 'gun', pos: new THREE.Vector3(0, s.hei / 2, -s.len * 0.06) },
    { normal: new THREE.Vector3(0, 1, 0), kind: 'missile', pos: new THREE.Vector3(-s.wid * 0.30, s.hei / 2, s.len * 0.14) },
    { normal: new THREE.Vector3(0, 1, 0), kind: 'missile', pos: new THREE.Vector3(s.wid * 0.30, s.hei / 2, s.len * 0.14) },
    { normal: new THREE.Vector3(0, -1, 0), kind: 'gun', pos: new THREE.Vector3(-s.wid * 0.28, -s.hei / 2, 0) },
    { normal: new THREE.Vector3(0, -1, 0), kind: 'gun', pos: new THREE.Vector3(s.wid * 0.28, -s.hei / 2, 0) },
  ];`,
 '我方舰 6 导弹发射器');

// ---------- ② 索敌环绕: 运动 AI 接目标 ----------
rep(AW, `export interface AirWarshipMotionState {
  /** 目标高度(离地 >= MIN_AGL, 由调用方按地形给) */
  targetY: number;`,
`export interface AirWarshipMotionState {
  /** 目标高度(离地 >= MIN_AGL, 由调用方按地形给) */
  targetY: number;
  /** 索敌后要环绕的半径(引擎按目标体型设: 敌舰越大绕得越远) */
  orbitR: number;`,
 'orbitR 字段');
rep(AW, `  return {
    targetY: 0,
    mode: 'straight',`,
`  return {
    targetY: 0,
    orbitR: 3000,
    mode: 'straight',`,
 'orbitR 初值');

rep(AW, `export function updateAirWarshipMotion(
  pos: THREE.Vector3,
  vel: THREE.Vector3,
  headingRef: { heading: number },
  st: AirWarshipMotionState,
  dt: number,
  terrainY: number,
  speed = AIR_WARSHIP_SPEED,
): void {`,
`export function updateAirWarshipMotion(
  pos: THREE.Vector3,
  vel: THREE.Vector3,
  headingRef: { heading: number },
  st: AirWarshipMotionState,
  dt: number,
  terrainY: number,
  speed = AIR_WARSHIP_SPEED,
  /** 索敌到的目标位置(可空): 给了它就"转向过去 + 绕着它打", 而不是按计时器瞎飞 */
  targetPos?: THREE.Vector3 | null,
): void {`,
 '运动函数加 targetPos');

rep(AW, `  // === 模式切换: 直行 ↔ 盘旋 ==================================================
  st.modeT -= dt;`,
`  // === 索敌后的行为 (per user request: 不是强行绕, 是自己索敌 -> 转向过去 -> 环绕攻击) ====
  // 做法: 把目标周围的**切向**当期望航向(绕圈), 再叠一个径向修正把距离拉回 orbitR ——
  // 远了往里压、近了往外让。于是观感是"先掉头飞过去, 到位后自然开始绕", 而不是被钉在圆上。
  if (targetPos) {
    const to = targetPos.clone().sub(pos);
    to.y = 0;
    const dist = to.length();
    if (dist > 1) {
      const radial = to.clone().multiplyScalar(1 / dist);
      const tangent = new THREE.Vector3(-radial.z, 0, radial.x).multiplyScalar(st.orbitSign);
      const want = dist > st.orbitR * 1.15 ? 0.75 : (dist < st.orbitR * 0.85 ? -0.55 : 0);
      const dir = tangent.addScaledVector(radial, want).normalize();
      st.desiredHeading = Math.atan2(dir.x, dir.z);
      // 顶着内部计时器: seek 期间不切换到别的模式(否则会突然开始自由盘旋)
      st.mode = 'straight';
      st.modeT = Math.max(st.modeT, 6);
    }
  }

  // === 模式切换: 直行 ↔ 盘旋 ==================================================
  st.modeT -= dt;`,
 '索敌环绕逻辑');

// ---------- ③ 引擎: 我方(敌方)舰都自己找目标 ----------
rep(E, `        } else {
          if (!u.airMotion) u.airMotion = makeAirWarshipMotion(u.heading);
          const hRef = { heading: u.heading };
          updateAirWarshipMotion(u.position, u.velocity, hRef, u.airMotion, dt, terrY, u.speed);`,
`        } else {
          if (!u.airMotion) u.airMotion = makeAirWarshipMotion(u.heading);
          // === 自己索敌 (per user request: 我方空中战舰会环绕敌方空中战舰攻击) =========
          // 我方优先咬敌方主舰「堡垒」(它就是这一关最大的目标), 没有主舰再咬最近的敌方单位;
          // 敌方(轻型舰)反过来咬玩家/友军。搜到谁就绕谁打 —— 环绕半径按目标体型放大,
          // 免得绕着 3.9 公里的主舰时贴着舰体飞。
          let seekPos: THREE.Vector3 | null = null;
          let seekRadius = 3000;
          if (u.isAlly) {
            const boss = this.boss;
            if (boss && boss.alive) {
              seekPos = boss.position;
              seekRadius = Math.max(3200, (boss.collideR ?? 1200) * 1.9);
            } else {
              const t = this.pickAirTarget(u.position, true, 22000);
              if (t) { seekPos = t.position; seekRadius = Math.max(2200, ((t as unknown as GroundUnit).collideR ?? 300) * 2.2); }
            }
          } else {
            const t = this.pickAirTarget(u.position, false, 22000);
            if (t) { seekPos = t.position; seekRadius = Math.max(2200, ((t as unknown as GroundUnit).collideR ?? 300) * 2.2); }
          }
          if (seekPos) u.airMotion.orbitR = seekRadius;
          const hRef = { heading: u.heading };
          updateAirWarshipMotion(u.position, u.velocity, hRef, u.airMotion, dt, terrY, u.speed, seekPos);`,
 '引擎: 轻型舰自己索敌');

// ---------- ④ attach 的武器目标里也要能选到"舰"(否则我方舰打不到主舰) ----------
rep(E, `    const cands: Enemy[] = isAlly ? this.enemies : [...this.wingmen, ...this.carriers];
    for (const e of cands) {
      if (!e.alive) continue;
      const d = from.distanceTo(e.position);
      if (d < bestD) { bestD = d; tgt = e; }
    }
    return tgt;
  }`,
`    const cands: Enemy[] = isAlly ? this.enemies : [...this.wingmen, ...this.carriers];
    for (const e of cands) {
      if (!e.alive) continue;
      const d = from.distanceTo(e.position);
      if (d < bestD) { bestD = d; tgt = e; }
    }
    // === 大目标也算合法目标 (per user request: 我方空中战舰要环绕敌方空中战舰攻击) ======
    // 敌方主舰「堡垒」/轻型舰/它们的挂点都在 groundUnits 里 —— 只挑飞机的话我方舰
    // 永远打不到主舰, 所以这里把敌方(或我方, 取决于阵营)的地面/空面单位也放进候选。
    for (const g of this.groundUnits) {
      if (!g.alive || g.isNeutral || g.isAlly === isAlly) continue;
      const d = from.distanceTo(g.position);
      if (d < bestD) { bestD = d; tgt = g as unknown as Enemy; }
    }
    return tgt;
  }`,
 '舰载武器可锁大目标');
console.log('§232b done');
