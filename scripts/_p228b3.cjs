// §228b(3/3): 运行时分支 —— 主舰运动 / 无人机 / 激光炮 / 光束清理 / 类型表 / resetState
const fs = require('fs');
const p = 'src/lib/game/engine.ts';
let s = fs.readFileSync(p, 'utf8');
function rep(a, b, label) {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.error('miss(' + n + '):', label); process.exit(1); }
  s = s.replace(a, b);
  console.log('ok:', label);
}

// ---------- ① 主舰 + 无人机分支(插在组件分支之前) ----------
rep(`      // === 空中战舰的**附属组件单位** (per user request) =====================`,
`      // === 敌方主舰「堡垒」: 分阶段运动 AI (per user request) ==================
      // 阶段行为(慢巡航/加速+俯仰/侧面对敌/减速齐射)全在 dreadnought.updateDreadnoughtMotion 里,
      // 这里只把结果贴到 group 上, 并按运动状态做两件事: 阶段 2 撒干扰弹、阶段 4 让挂点齐射。
      if (u.isAir && u.boss && !u.falling) {
        const hFnB = (this as unknown as { _terrainHeightFn?: (x: number, z: number) => number })._terrainHeightFn;
        const terrYB = hFnB ? hFnB(u.position.x, u.position.z) : 0;
        if (!this.bossMotion) this.bossMotion = makeDreadnoughtMotion(u.heading);
        const hRefB = { heading: u.heading };
        updateDreadnoughtMotion(u.position, u.velocity, hRefB, this.bossMotion, dt, terrYB, this.bossStage, this.player.position);
        u.heading = hRefB.heading;
        u.speed = this.bossMotion.speedNow;
        u.group.position.copy(u.position);
        u.group.rotation.y = u.heading;
        // 阶段 2 的轻微俯仰(绕 Z 摆一下, 900 米的船"点头"很轻微)
        u.group.rotation.z = this.bossMotion.pitch;
        if (this.bossMotion.flares) {
          this.bossFlareTimer -= dt;
          if (this.bossFlareTimer <= 0) {
            this.bossFlareTimer = 0.5;
            this.spawnBossFlares(u.position);
          }
        }
        // 舰体矩阵当帧刷新: 16 个挂点单位在**同一帧**里用它算世界坐标(不刷新会滞后一帧)
        u.group.updateMatrixWorld(true);
        continue;   // 主舰不走地面逻辑, 也不走轻型舰的组件台账
      }
      // === 蜂群无人机: 自杀式冲撞玩家 (per user request) ===
      if (u.isAir && u.isDrone) {
        const toP = this.player.position.clone().sub(u.position);
        const dist = toP.length();
        const dir = dist > 1 ? toP.multiplyScalar(1 / dist) : toP.set(0, 0, 1);
        u.heading = Math.atan2(dir.x, dir.z);
        const want = dir.multiplyScalar(u.speed);
        u.velocity.lerp(want, Math.min(1, dt * 0.9));   // 无人机转向快, 但起步有惯性
        u.position.addScaledVector(u.velocity, dt);
        u.group.position.copy(u.position);
        u.group.rotation.y = u.heading;
        // 撞上就炸(近距离引爆, 给玩家一点伤害 + 视觉)
        if (dist < 45) {
          this.weapons.spawnExplosion(u.position.clone(), 1.6);
          u.alive = false;
          this.scene.remove(u.group);
          if (this.playerHp > 0) {
            this.playerHp -= 6;
            this.damageFlash = Math.min(1, this.damageFlash + 0.25);
            this.camera.addShake(0.25);
          }
        }
        continue;
      }
      // === 空中战舰的**附属组件单位** (per user request) =====================`,
 'boss + drone branches');

// ---------- ② updateAirComponentWeapons: 激光 / 核心 / 齐射 ----------
rep(`  private updateAirComponentWeapons(u: GroundUnit, ship: GroundUnit, comp: AirWarshipComponent, dt: number) {
    if (comp.fireTimer > 0) comp.fireTimer -= dt;
    if (comp.fireTimer > 0 || ship.falling || !ship.alive) return;`,
`  private updateAirComponentWeapons(u: GroundUnit, ship: GroundUnit, comp: AirWarshipComponent, dt: number) {
    // 核心模块是被打掉的弱点, 自身不开火 (per user request: 阶段 4 核心只是目标)
    if (comp.kind === 'core') return;
    // 主舰处于"遭遇"阶段(0)时武器未激活 (per user request: 阶段 0 武器未激活)
    if (ship.boss && this.bossStage < 1) return;
    // 激光炮走自己的"充能 -> 持续照射 -> 冷却"循环
    if (comp.kind === 'laser') { this.updateMountLaser(u, ship, comp, dt); return; }
    // 阶段 4 齐射: 冷却整体缩短(不是清零, 免得每帧都开火)
    const rapid = !!ship.boss && (this.bossMotion?.salvo ?? false);
    if (comp.fireTimer > 0) comp.fireTimer -= dt;
    if (comp.fireTimer > 0 || ship.falling || !ship.alive) return;`,
 'laser/core/rapid branch');

rep(`      comp.fireTimer = 9 + Math.random() * 5;
    } else {`,
`      comp.fireTimer = (9 + Math.random() * 5) * (rapid ? 0.45 : 1);
    } else {`,
 'missile cooldown rapid');

rep(`      comp.fireTimer = 0.55 + Math.random() * 0.5;
    }
  }`,
`      comp.fireTimer = (0.55 + Math.random() * 0.5) * (rapid ? 0.5 : 1);
    }
  }

  /**
   * 主舰激光炮「长矛」的充能-照射循环 (per user request: 充能 3 秒, 发射持续 5 秒)。
   * 充能期间炮口发光(charge 0..1), 充满后拉一条光束持续照射; 玩家在光轴附近就被烧。
   * 光束网格懒创建在单位上(laserCylinder / laserCylinderCore), 单位被摘除时一起清理。
   */
  private updateMountLaser(u: GroundUnit, ship: GroundUnit, comp: AirWarshipComponent, dt: number) {
    const CHARGE = 3.0, FIRE = 5.0, COOL = 7.0;
    const tgt = this.pickAirTarget(u.position, u.isAlly, u.radarRange > 0 ? u.radarRange : 7000);
    if (!tgt || ship.falling || !ship.alive) {
      comp.charge = 0;
      comp.fireTimer = Math.max(comp.fireTimer, 0.6);
      this.setMountBeam(u, null, null, 0);
      return;
    }
    // --- 冷却 ---
    if (comp.fireTimer > 0) {
      comp.fireTimer -= dt;
      comp.charge = 0;
      this.setMountBeam(u, null, null, 0);
      return;
    }
    const origin = new THREE.Vector3();
    comp.mesh.getWorldPosition(origin);
    const q = new THREE.Quaternion();
    ship.group.getWorldQuaternion(q);
    const nrm = comp.normal.clone().applyQuaternion(q).normalize();
    const muzzle = origin.addScaledVector(nrm, comp.radius * 0.5);
    const toT = tgt.position.clone().sub(muzzle);
    const len = toT.length();
    const dir = len > 1 ? toT.multiplyScalar(1 / len) : nrm.clone();
    // --- 充能 ---
    const c = comp.charge ?? 0;
    if (c < 1) {
      comp.charge = Math.min(1, c + dt / CHARGE);
      if (comp.charge >= 1) comp.fireTimer = FIRE;    // 充满 => 开始照射
      this.setMountBeam(u, null, null, 0);            // 充能期间不画光束(炮口发光由材质表现)
      return;
    }
    // --- 照射 ---
    comp.fireTimer -= dt;
    const beamLen = Math.min(len, 9000);
    this.setMountBeam(u, beamLen > 1 ? dir : nrm, muzzle, beamLen);
    // 命中判定: 玩家离光轴足够近(2 度锥)且在射程内 => 持续伤害
    const toPlayer = this.player.position.clone().sub(muzzle);
    const distP = toPlayer.length();
    if (distP > 1 && distP < 9000) {
      const cosA = toPlayer.normalize().dot(dir);
      if (cosA > 0.9994) {
        const dmg = 26 * dt;
        this.playerHp -= dmg;
        this.camera.addShake(0.7);
        this.damageFlash = Math.min(1, this.damageFlash + 0.3 * dt * 4);
        this.playerHitShakeT = Math.max(this.playerHitShakeT, 0.4);
      }
    }
    if (comp.fireTimer <= 0) {
      comp.charge = 0;
      comp.fireTimer = COOL;
      this.setMountBeam(u, null, null, 0);
    }
  }

  /** 懒创建/更新/隐藏一枚挂点的激光光束(len <= 0 表示关掉)。 */
  private setMountBeam(u: GroundUnit, dir: THREE.Vector3 | null, origin: THREE.Vector3 | null, len: number) {
    if (!dir || !origin || len <= 1) {
      if (u.laserCylinder) u.laserCylinder.visible = false;
      if (u.laserCylinderCore) u.laserCylinderCore.visible = false;
      if (u.laserBeam) u.laserBeam.visible = false;
      return;
    }
    if (!u.laserCylinder) {
      const colMat = new THREE.MeshBasicMaterial({
        color: 0xff5533, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      const col = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 1, 10, 1, true), colMat);
      col.renderOrder = 998;
      col.frustumCulled = false;
      this.scene.add(col);
      u.laserCylinder = col;
      const coreMat = new THREE.MeshBasicMaterial({
        color: 0xffd0a0, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      const core = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 1, 8, 1, true), coreMat);
      core.renderOrder = 999;
      core.frustumCulled = false;
      this.scene.add(core);
      u.laserCylinderCore = core;
    }
    const up = new THREE.Vector3(0, 1, 0);
    const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
    for (const m of [u.laserCylinder, u.laserCylinderCore]) {
      m.visible = true;
      m.position.copy(origin).addScaledVector(dir, len * 0.5);
      m.quaternion.copy(quat);
      m.scale.set(1, len, 1);
    }
  }

  /** 主舰阶段 2 的干扰弹(撒在舰体周围, 视觉上告诉玩家"它在放干扰")。 */
  private spawnBossFlares(pos: THREE.Vector3) {
    for (let i = 0; i < 8; i++) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(2.2, 6, 6),
        new THREE.MeshBasicMaterial({ color: 0xffcc44, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      mesh.position.copy(pos).add(new THREE.Vector3((Math.random() - 0.5) * 260, -80 - Math.random() * 60, (Math.random() - 0.5) * 260));
      this.scene.add(mesh);
      const dir = new THREE.Vector3((Math.random() - 0.5) * 2, -1 - Math.random(), (Math.random() - 0.5) * 2).normalize();
      this.weapons.bullets.push({
        mesh, velocity: dir.multiplyScalar(90), life: 4.5, damage: 0, hitRadius: 0,
        damagerKind: 'ground', isShell: false,
      } as never);
    }
  }`,
 'laser machinery + boss flares');

// ---------- ③ detachAirComponent: 一并摘掉激光光束 ----------
rep(`    const p = u.group.parent;
    if (p) p.remove(u.group);
    // silent: 调用方(通用阵亡路径)已经放过大爆炸, 这里不再叠一发
    if (!silent) this.weapons.spawnExplosion(u.position.clone(), 1.6);`,
`    const p = u.group.parent;
    if (p) p.remove(u.group);
    // 激光光束挂在 scene 上(不是舰体), 摘挂点时要一起清掉, 否则光束会留在原地
    for (const m of [u.laserCylinder, u.laserCylinderCore]) if (m) this.scene.remove(m);
    if (u.laserBeam) this.scene.remove(u.laserBeam);
    u.laserCylinder = undefined;
    u.laserCylinderCore = undefined;
    u.laserBeam = undefined;
    // silent: 调用方(通用阵亡路径)已经放过大爆炸, 这里不再叠一发
    if (!silent) this.weapons.spawnExplosion(u.position.clone(), 1.6);`,
 'detach cleans beams');

// ---------- ④ 类型表: air_boss / air_drone ----------
rep(`const GROUND_MODEL_LABEL: Record<GroundUnitType, string> = {
  // 舰载组件(独立单位)在 HUD 上就写它是什么: 导弹组 / 机炮
  air_component: '舰载组件',`,
`const GROUND_MODEL_LABEL: Record<GroundUnitType, string> = {
  // 舰载组件(独立单位)在 HUD 上就写它是什么: 导弹组 / 机炮
  air_component: '舰载组件',
  air_boss: '空中战舰',
  air_drone: '无人机',`,
 'GROUND_MODEL_LABEL boss/drone');

rep(`    const hpMap: Record<GroundUnitType, number> = {
      air_light: 720,
      air_component: 120,`,
`    const hpMap: Record<GroundUnitType, number> = {
      air_light: 720,
      air_component: 120,
      air_boss: 999999,
      air_drone: 30,`,
 'hpMap #1 boss/drone');

rep(`      air_component: 120,
    };`,
`      air_component: 120,
      air_boss: 999999,
      air_drone: 30,
    };`,
 'hpMap #2 boss/drone');

rep(`      air_component: 5200,
      destroyer: 6000,`,
`      air_component: 5200,
      air_boss: 14000,
      air_drone: 3000,
      destroyer: 6000,`,
 'radarRangeMap #1 boss/drone');

rep(`      air_component: 5200,
    };`,
`      air_component: 5200,
      air_boss: 14000,
      air_drone: 3000,
    };`,
 'radarRangeMap #2 boss/drone');

// ---------- ⑤ resetState: 剧情状态清零 ----------
rep(`    this.isT00 = false;`,
`    this.isT00 = false;
    // 正式版剧情第一关的剧情状态(重开关卡必须清零, 否则上一局的主舰/阶段会残留)
    this.isS01 = false;
    this.boss = null;
    this.bossModel = null;
    this.bossMotion = null;
    this.bossStage = 0;
    this.bossMountUnits = [];
    this.bossKilledInStage = 0;
    this.bossAdvanceT = 0;
    this.bossBlockIdx = {};
    this.bossWingIds = [];
    this.bossLossIdx = 0;
    this.bossAnvilIdx = 0;
    this.bossCoreIdx = 0;
    this.bossDrones = [];
    this.bossDroneTimer = 12;
    this.bossRandTimer = 30;
    this.bossFalling = false;
    this.bossFallDone = false;
    this.bossEndT = 0;
    this.bossFlareTimer = 0;`,
 'resetState s01');

fs.writeFileSync(p, s);
console.log('§228b-3 ok');
