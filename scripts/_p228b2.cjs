// §228b(2/3): 剧情控制器方法体 —— 插在 detachAirComponent 之前
const fs = require('fs');
const p = 'src/lib/game/engine.ts';
let s = fs.readFileSync(p, 'utf8');
const anchor = `  /**
   * 把一枚舰载组件从舰体上摘掉: 网格脱离舰体(不再跟着飞、不再显示), 单位标记阵亡。`;
if (!s.includes(anchor)) { console.error('anchor missing'); process.exit(1); }

const BLOCK = `  // =========================================================================
  // 正式版剧情第一关: 空中战舰「堡垒」剧情控制器 (per user request)
  // =========================================================================
  // 剧情阶段(与任务书一致):
  //   0 遭遇   主舰从地图东侧进场, 12 架护航机先行, 武器未激活; 玩家进入 15km 触发阶段 1
  //   1 初始防御(16 挂点: 机炮10/导弹6) + 4 架航空大队, 直线慢速巡航
  //   2 强化防御(16 挂点: 机炮6/导弹10) + 6 架, 加速 + 俯仰 + 干扰弹
  //   3 激光与舰队(16 挂点: 激光4/机炮6/导弹6) + 8 架 + 2 艘轻型舰, 侧面对敌
  //   4 最终核心(核心4 + 激光4 + 机炮4 + 导弹4) + 10 架 + 3 艘轻型舰, 减速齐射
  //   坠落   核心全毁 -> 惯性滑翔 -> 触地大爆炸 -> 通讯中断 -> 任务完成
  // 台词: 全部走 radio.ts 的 S01_BLOCKS(每组内部严格按顺序), 见 download/radio_lines_s01_placeholders.md

  /** 按顺序播该组台词的**下一句**(剧情里"每毁一个挂点说一句"就靠它)。 */
  private playS01Next(key: keyof typeof S01_BLOCKS, delay = 0.25): boolean {
    const list = S01_BLOCKS[key];
    const i = this.bossBlockIdx[key] ?? 0;
    if (!list || i >= list.length) return false;
    this.bossBlockIdx[key] = i + 1;
    this.radio.trigger(list[i], { force: true, delay });
    return true;
  }

  /** 整组台词按顺序播(段落式对话, 用 radio 的队列)。 */
  private playS01Block(key: keyof typeof S01_BLOCKS, gap = 3.6) {
    const list = S01_BLOCKS[key];
    if (!list) return;
    this.radio.triggerSequence(list, { gap });
  }

  /**
   * 建立第一关: 主舰「堡垒」从**地图东侧**进场 + 12 架护航机 + 开场无线电。
   * 主舰此时武器未激活(阶段 0), 玩家接近到 15km 内才切阶段 1。
   */
  private setupStoryS01() {
    const model = buildDreadnought(false);
    this.bossModel = model;
    const heading = -Math.PI / 2;          // 朝 -X 飞 = 从东侧进入
    const y = DREADNOUGHT_MIN_AGL + 900;
    model.group.position.set(13000, y, 1500);
    model.group.rotation.y = heading;
    this.scene.add(model.group);
    const u = {
      id: ++this._groundIdSeq,
      type: 'air_boss' as GroundUnitType,
      isAlly: false,
      group: model.group,
      position: model.group.position.clone(),
      velocity: new THREE.Vector3(Math.sin(heading) * DREADNOUGHT_SPEED.cruise, 0, Math.cos(heading) * DREADNOUGHT_SPEED.cruise),
      heading,
      speed: DREADNOUGHT_SPEED.cruise,
      // 舰体本体不做"血量击杀": 阶段推进只认挂点, 核心全毁才坠落(per user request)
      hp: 999999, maxHp: 999999,
      alive: true,
      name: '空中战舰「堡垒」',
      missileTimer: 4, gunTimer: 1, groundCombatTimer: 999,
      isAir: true, boss: true,
      airComponents: [] as AirWarshipComponent[],
      collideR: model.hull.radius,
      radarRange: 14000,
      wakeTimer: 0, dustTimer: 0, targetId: -1, targetIsAir: true,
    } as unknown as GroundUnit;
    this.groundUnits.push(u);
    this.boss = u;
    this.bossMotion = makeDreadnoughtMotion(heading);
    this.bossStage = 0;
    this.spawnBossMounts(1);        // 阶段 1 装载先摆好(武器要等阶段 1 才激活)
    this.spawnBossWing(12);         // 护航战斗机先行抵达
    this.playS01Next('s0_awacs', 1.2);
    this.playS01Block('s0_escort', 4.4);
  }

  /** 按阶段装载表重建 16 个挂点(先把上一阶段的挂点单位 + 网格全部清除)。 */
  private spawnBossMounts(stage: 1 | 2 | 3 | 4) {
    const boss = this.boss; const model = this.bossModel;
    if (!boss || !model) return;
    for (const mu of this.bossMountUnits) {
      if (!mu.compDetached) this.detachAirComponent(mu, true);
    }
    this.bossMountUnits = [];
    const mounts = applyStageLoadout(model, stage);
    boss.airComponents = mounts as unknown as AirWarshipComponent[];
    this.bossKilledInStage = 0;
    mounts.forEach((c, i) => {
      const cu = {
        id: ++this._groundIdSeq,
        type: 'air_component' as GroundUnitType,
        isAlly: false,
        group: c.mesh,
        position: new THREE.Vector3(),
        velocity: boss.velocity.clone(),
        heading: boss.heading,
        speed: 0,
        hp: c.hp, maxHp: c.maxHp,
        alive: true,
        name: (c.kind === 'core' ? '核心模块' : c.kind === 'laser' ? '长矛激光炮' : c.kind === 'missile' ? '导弹发射器' : '刺猬机炮') + ' #' + (i + 1),
        missileTimer: 3 + Math.random() * 4,
        gunTimer: 1 + Math.random() * 2,
        groundCombatTimer: 999,
        isAir: true, isComponent: true,
        parentShipId: boss.id,
        compIndex: i,
        attachLocal: c.localPos.clone(),
        collideR: c.radius,
        radarRange: 7000,
        wakeTimer: 0, dustTimer: 0, targetId: -1, targetIsAir: true,
      } as unknown as GroundUnit;
      this.groundUnits.push(cu);
      this.bossMountUnits.push(cu);
    });
  }

  /** 主舰释放航空大队: n 架战斗机从主舰周围进场(护航/各阶段增援都是它)。 */
  private spawnBossWing(n: number) {
    const boss = this.boss; if (!boss) return;
    if (!this.geomCache['f16']) return;
    let nextId = this.enemies.length > 0 ? Math.max(...this.enemies.map((e) => e.id)) + 1 : 100;
    for (let i = 0; i < n; i++) {
      const a = (i / Math.max(1, n)) * Math.PI * 2 + Math.random() * 0.5;
      const r = 1100 + Math.random() * 1200;
      const spawn: EnemySpawn = {
        model: 'f16',
        role: 'fighter',
        position: [
          boss.position.x + Math.cos(a) * r,
          boss.position.y + (Math.random() - 0.3) * 800,
          boss.position.z + Math.sin(a) * r,
        ],
        heading: boss.heading,
        altitude: boss.position.y + 300,
        callsign: '猎犬' + (i + 1),
      };
      this.spawnEnemyFromWave(spawn, nextId);
      this.bossWingIds.push(nextId);
      nextId += 1;
    }
  }

  /** 上一波敌机撤退: 掉头飞离, 一段时间后脱离战场消失(简化实现, 见 §228 文档)。 */
  private withdrawWing() {
    const ids = this.bossWingIds;
    this.bossWingIds = [];
    if (ids.length === 0) return;
    const mark = () => {
      for (const id of ids) {
        const e = this.enemies.find((x) => x.id === id);
        if (!e || !e.alive) continue;
        // 静默脱离: 不给分、不播爆炸(它们是"撤退"不是"被击落")
        e.alive = false;
        if (e.group) this.scene.remove(e.group);
      }
    };
    for (const id of ids) {
      const e = this.enemies.find((x) => x.id === id && x.alive);
      if (!e) continue;
      const dir = new THREE.Vector3(e.position.x, 0, e.position.z);
      if (dir.lengthSq() < 1) dir.set(1, 0, 0);
      e.velocity.copy(dir.normalize().multiplyScalar(240));
    }
    window.setTimeout(mark, 9000);
  }

  /** 轻型空中战舰「铁砧」从地图边缘飞入(阶段 3 起)。 */
  private spawnAnvil(index: number): GroundUnit | null {
    const ang = Math.random() * Math.PI * 2;
    const u = this.spawnAirWarship(false, 12000 + Math.random() * 2500, ang);
    if (u) u.name = '铁砧' + (index + 1);
    return u;
  }

  /** 无人机(蜂群): 从主舰/轻型舰放出, 自杀式冲撞玩家。 */
  private spawnSwarmDrone() {
    const boss = this.boss;
    if (!boss || this.bossDrones.length > 7) return;
    const src = this.bossDrones.length < 3 || !this.boss ? boss : boss;
    const a = Math.random() * Math.PI * 2;
    const r = 400 + Math.random() * 900;
    const g = buildDrone(false);
    g.position.set(
      src.position.x + Math.cos(a) * r,
      src.position.y + (Math.random() - 0.4) * 500,
      src.position.z + Math.sin(a) * r,
    );
    this.scene.add(g);
    const u = {
      id: ++this._groundIdSeq,
      type: 'air_drone' as GroundUnitType,
      isAlly: false,
      group: g,
      position: g.position.clone(),
      velocity: new THREE.Vector3(0, 0, 1).multiplyScalar(120),
      heading: 0, speed: 190,
      hp: DRONE_HP, maxHp: DRONE_HP,
      alive: true,
      name: '蜂群无人机',
      missileTimer: 999, gunTimer: 999, groundCombatTimer: 999,
      isAir: true, isDrone: true,
      collideR: 6,
      wakeTimer: 0, dustTimer: 0, targetId: -1, targetIsAir: true,
    } as unknown as GroundUnit;
    this.groundUnits.push(u);
    this.bossDrones.push(u);
  }

  /** 切到剧情阶段 n: 台词 + 挂点换装 + 航空大队 + 轻型舰 + 主舰行为。 */
  private beginBossStage(n: number) {
    const boss = this.boss;
    if (!boss || this.bossStage === n) return;
    this.bossStage = n;
    this.bossAdvanceT = 0;
    switch (n) {
      case 1:
        this.playS01Next('s1_open', 0.4);
        this.spawnBossWing(4);          // 阶段 1 航空大队 4 架
        break;
      case 2:
        this.playS01Next('s2_trigger', 0.3);
        this.playS01Block('s2_open', 4.0);
        this.withdrawWing();
        this.spawnBossWing(6);
        this.spawnBossMounts(2);
        break;
      case 3:
        this.playS01Next('s3_trigger', 0.3);
        this.playS01Block('s3_open', 4.0);
        this.withdrawWing();
        this.spawnBossWing(8);
        this.spawnAnvil(0);
        this.spawnAnvil(1);
        this.spawnBossMounts(3);
        break;
      case 4:
        this.playS01Block('s4_open', 4.0);
        this.withdrawWing();
        this.spawnBossWing(10);
        this.spawnAnvil(2);
        this.spawnAnvil(3);
        this.spawnAnvil(4);
        this.spawnBossMounts(4);
        break;
      default: break;
    }
  }

  /** 核心全毁 -> 开始坠落(惯性滑翔 + 触地倒计时台词), 之后触地爆炸并完成任务。 */
  private startBossFall() {
    const boss = this.boss;
    if (!boss || this.bossFalling) return;
    this.bossFalling = true;
    this.bossStage = 5;
    // 复用空中单位已有的"坠落"分支(零推力 + 重力 + 触地大爆炸 + 移除)
    boss.falling = true;
    if (boss.velocity.y > 0) boss.velocity.y = 0;
    this.playS01Block('s5_fall', 5.2);
  }

  /**
   * 剧情主循环: 阶段推进 / 挂点台词 / 护航机损失 / 无人机 / 随机通讯。
   * 每帧由 update() 调用(只在 s01 关卡里做事)。
   */
  private updateStoryS01(dt: number) {
    if (!this.isS01) return;
    const boss = this.boss;
    if (!boss) return;
    // === 坠落收尾: 触地后主舰被移除 => 通讯中断 -> 任务完成 ===
    if (this.bossFalling) {
      if (!this.bossFallDone && !boss.alive) {
        this.bossFallDone = true;
        this.bossEndT = 3.2;
        this.radio.trigger(S01_BLOCKS.s5_fall[S01_BLOCKS.s5_fall.length - 1], { force: true, delay: 0.6 });
      }
      if (this.bossFallDone && this.bossEndT > 0) {
        this.bossEndT -= dt;
        if (this.bossEndT <= 0) this.endMission(true, 'MISSION COMPLETE');
      }
      return;
    }

    // === 阶段 0: 玩家接近到 15km 内 -> 武器激活, 进入阶段 1 ===
    if (this.bossStage === 0) {
      const d = boss.position.distanceTo(this.player.position);
      if (d < 15000) this.beginBossStage(1);
      return;
    }

    // === 挂点损失: 记数 + 台词(前半段用第一组, 过半用第二组) ===
    const mounts = this.bossMountUnits;
    const deadNow = mounts.filter((m) => !m.alive || m.compDetached).length;
    if (deadNow > this.bossKilledInStage) {
      const gain = deadNow - this.bossKilledInStage;
      this.bossKilledInStage = deadNow;
      for (let i = 0; i < gain; i++) {
        const half = mounts.length / 2;
        if (this.bossKilledInStage <= half) {
          const key = this.bossStage === 1 ? 's1_mount'
            : this.bossStage === 2 ? 's2_mount'
              : this.bossStage === 3 ? 's3_mount' : 's4_core';
          this.playS01Next(key, 0.3);
        } else {
          const key = this.bossStage === 1 ? 's1_mount2'
            : this.bossStage === 2 ? 's2_mount2'
              : this.bossStage === 3 ? 's3_mount2' : 's4_core';
          this.playS01Next(key, 0.3);
        }
      }
    }

    // === 护航机损失台词(每个阶段一组) ===
    const lostWing = this.bossWingIds.filter((id) => {
      const e = this.enemies.find((x) => x.id === id);
      return !e || !e.alive;
    }).length;
    if (lostWing > this.bossLossIdx) {
      this.bossLossIdx = lostWing;
      const key = this.bossStage === 1 ? 's1_loss' : this.bossStage === 2 ? 's2_loss' : 's4_loss';
      this.playS01Next(key, 0.4);
    }

    // === 阶段推进: 16 个挂点全部击毁(核心阶段 = 4 个核心模块全毁) ===
    const allGone = mounts.length > 0 && mounts.every((m) => !m.alive || m.compDetached);
    if (allGone && this.bossStage >= 1) {
      if (this.bossStage >= 4) {
        // 阶段 4 全毁 => 核心全毁, 允许坠落(这是"打完所有剧情阶段才会坠落"的唯一出口)
        this.bossAdvanceT += dt;
        if (this.bossAdvanceT > 2.2) {
          this.playS01Next('s4_core2', 0.3);
          this.startBossFall();
        }
      } else {
        this.bossAdvanceT += dt;
        if (this.bossAdvanceT > 3.0) this.beginBossStage(this.bossStage + 1);
      }
    }

    // === 铁砧(轻型舰)台词: 它们被击毁时按顺序说 ===
    const anvils = this.groundUnits.filter((u) => u.type === 'air_light' && !u.isAlly);
    const anvilDead = anvils.filter((u) => !u.alive).length;
    if (anvilDead > this.bossAnvilIdx) {
      this.bossAnvilIdx = anvilDead;
      this.playS01Next('s3_anvil', 0.4);
    }

    // === 无人机(蜂群): 持续放出, 数量有限, 被击落后过一段时间补充 ===
    this.bossDrones = this.bossDrones.filter((d) => d.alive);
    this.bossDroneTimer -= dt;
    if (this.bossDroneTimer <= 0) {
      this.bossDroneTimer = 9 + Math.random() * 7;
      this.spawnSwarmDrone();
      if (this.bossStage >= 3 && Math.random() < 0.5) this.spawnSwarmDrone();
    }

    // === 全局随机敌军通讯(主舰存活期间随机播) ===
    this.bossRandTimer -= dt;
    if (this.bossRandTimer <= 0) {
      this.bossRandTimer = 32 + Math.random() * 26;
      this.radio.trigger(S01_RANDOM_CONTROL, { force: true });
    }
  }

`;

s = s.replace(anchor, BLOCK + anchor);
fs.writeFileSync(p, s);
console.log('§228b-2 ok: 剧情控制器方法体已插入');
