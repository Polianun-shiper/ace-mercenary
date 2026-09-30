// §239: ① IR 红环还原 ② 3D 导弹指示器(绿色环+红柱)减半 ③ 末阶段浓烟 + 大爆炸 ④ 尾焰改为向外喷(实测校准)
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
const H = 'src/components/game/Hud.tsx';

// ① IR 红环还原(我上一轮改错了环 —— 那是"玩家锁定敌人"的 IR 环, 不是导弹来袭指示器)
rep(H, `      // === 指示环减半 (per user request: 被导弹锁定的 3d 指示环减小一半) ============
      const baseR = 25 * scale;
      const minR = 11 * scale;`,
`      // 这是"玩家锁定敌人"的 IR 环 —— 上一轮我误改成了它, 用户指出改错了目标, 这里还原。
      const baseR = 50 * scale;
      const minR = 22 * scale;`,
 'IR 环还原');

// ② 3D 导弹来袭指示器(绿色环 + 红色柱)体积减半
rep(E, `    const SPHERE_R = 10;   // radius of the invisible sphere around the aircraft (+4/6)
    const PILLAR_MAX = 4;  // longest the red pillar can grow (at 0 distance)`,
`    // === 体积减半 (per user request: 被敌方导弹追踪时那个绿色环 + 红色柱子的导弹指示器体积减半) ====
    // 这才是用户说的那个"三维空间里的导弹指示器"(torus 环 + 红柱, 指向每一发来袭导弹)。
    // 全部尺寸(球面半径 / 环大小 / 柱长)一律减半 => 整体体积约为原来的一半。
    const SPHERE_R = 5;    // 原 10
    const PILLAR_MAX = 2;  // 原 4`,
 '指示器球面/柱长减半');
rep(E, `          this._missileWarnGeo = new THREE.TorusGeometry(1.6, 0.15, 10, 20);`,
`          this._missileWarnGeo = new THREE.TorusGeometry(0.8, 0.075, 10, 20);   // 原 (1.6, 0.15)`,
 '环几何减半');
rep(E, `          this._warnPillarGeo = new THREE.CylinderGeometry(0.09, 0.09, 1, 6);`,
`          this._warnPillarGeo = new THREE.CylinderGeometry(0.045, 0.045, 1, 6);   // 原 0.09`,
 '柱几何减半');
rep(E, `      const plen = Math.max(2, k * PILLAR_MAX);`,
`      const plen = Math.max(1, k * PILLAR_MAX);   // 原 Math.max(2, ...)`,
 '柱最短长减半');

// ③ 末阶段浓烟 + 大爆炸
rep(E, `        // === 末阶段点燃后燃器 (per user request: 打开后燃器, 发出宏大轰鸣, 加速逃离) ===`,
`        // === 末阶段: 冒大烟 + 爆炸特效变大 (per user request) ==========================
        // 核心暴露之后舰体一路冒浓烟(cheap 爆炸自带的烟层, 便宜且量大), 并且这一阶段的
        // 挂点爆炸/舰体爆炸/触地爆炸的 scale 整体放大 —— 读起来就是"这艘船快不行了"。
        if (this.bossStage >= 4 || this.bossSmokeOn) {
          this.bossSmokeOn = true;
          this.bossSmokeT -= dt;
          if (this.bossSmokeT <= 0) {
            this.bossSmokeT = 0.28;
            const half = this.bossModel ? this.bossModel.hullFrame.half : new THREE.Vector3(600, 400, 2000);
            const r = () => (Math.random() - 0.5) * 2;
            this.weapons.spawnCheapExplosion(
              u.position.clone().add(new THREE.Vector3(r() * half.x * 0.8, half.y * (0.6 + r() * 0.3), r() * half.z * 0.9)),
              2.6 + Math.random() * 1.6,
            );
          }
        }
        // === 末阶段点燃后燃器 (per user request: 打开后燃器, 发出宏大轰鸣, 加速逃离) ===`,
 '末阶段浓烟');

rep(E, `  /** 主舰撞机提示的节流计时 */`,
`  /** 末阶段浓烟: 开关 + 节流 */
  private bossSmokeOn = false;
  private bossSmokeT = 0;
  /** 主舰撞机提示的节流计时 */`,
 '烟雾字段');

// 爆炸 scale 放大(末阶段)
rep(E, `            u.falling = true;
              if (u.velocity.y > 0) u.velocity.y = 0;
              this.weapons.spawnExplosion(u.position.clone(), 7);
              this.weapons.spawnExplosion(u.position.clone().add(new THREE.Vector3(0, 10, 0)), 5);`,
`            // 末阶段的爆炸整体放大(per user request: 爆炸特效也变得很大)
              const boomK = this.bossStage >= 4 ? 1.8 : 1;
              this.weapons.spawnExplosion(u.position.clone(), 7 * boomK);
              this.weapons.spawnExplosion(u.position.clone().add(new THREE.Vector3(0, 10, 0)), 5 * boomK);`,
 '挂点清空爆炸放大');
rep(E, `                if (cu && !cu.compDetached) this.detachAirComponent(cu, false);
                else { comps[i].alive = false; comps[i].mesh.visible = false; }
                this.weapons.spawnExplosion(u.position.clone(), 2.2);`,
`                if (cu && !cu.compDetached) this.detachAirComponent(cu, false);
                else { comps[i].alive = false; comps[i].mesh.visible = false; }
                this.weapons.spawnExplosion(u.position.clone(), this.bossStage >= 4 ? 4.2 : 2.2);`,
 '单挂点爆炸放大');
rep(E, `            this.weapons.spawnExplosion(u.position.clone(), 9);
            this.weapons.spawnExplosion(u.position.clone().add(new THREE.Vector3(0, 18, 0)), 6);`,
`            // 触地大爆炸: 主舰用更大的 scale (per user request)
            const bigK = u.boss ? 1.6 : 1;
            this.weapons.spawnExplosion(u.position.clone(), 9 * bigK);
            this.weapons.spawnExplosion(u.position.clone().add(new THREE.Vector3(0, 18, 0)), 6 * bigK);`,
 '触地爆炸放大');

// ④ 尾焰: 从舰体向外喷 —— 之前用整组 rotation.y=PI 翻转, 但火焰锥体仍朝内; 改成"逐个火焰沿法线朝外"
rep(E, `    // === 火焰朝外 (per user request: 后燃器的自身前后方向相反还没改过来) ============
    // 上一轮只把"喷口在哪一端"翻了过来, 但火焰锥体本身仍朝舰体内侧喷(看起来就是"方向反了")。
    // 整组绕 Y 转 180 度: 喷口左右对称 => 位置不变, 只有火焰朝向翻到舰体外侧。
    grp.rotation.y = Math.PI;`,
`    // === 火焰必须朝**舰体外侧**喷 (per user request: 方向反了, 应该从舰体向外喷) ==========
    // buildAfterburner 的火焰锥体默认朝 -Z 喷(飞机尾喷口在 -Z 那一侧)。主舰的喷口在 +Z 端,
    // 所以要把每一束火焰**绕 X 轴翻 180 度**(+Z 变 -Z / -Z 变 +Z), 而不是转整组 ——
    // 转整组会把喷口位置也一起转走, 于是火焰看着还是"往船里喷"。
    // 同时把锥体自身也翻过来, 于是火焰是"贴着舰体、越往外越发散"的形状(而不是一根尖刺扎出去)。
    grp.children.forEach((c) => {
      if (c.userData && c.userData.role === 'flame') {
        c.rotation.x += Math.PI;                       // 锥尖朝内(喷口), 锥底朝外 => 向外扩散
        c.position.z = -c.position.z;                   // 位置镜像回喷口那一侧
      }
    });`,
 '尾焰向外喷');
