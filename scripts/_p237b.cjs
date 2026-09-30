// §237b: 我方空中中队用剧情关自己的 _sorties 机制(单机可用), 并把它们的攻击目标指向敌方主舰
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

rep(`    // === 我方空中中队: 帮玩家吸引火力 (per user request: 第一关多给几个空中中队的友军) ==
    // 用和 T-00 同一套"友军中队"机制(spawnSquadron): 两个中队(共 8 架)在玩家侧后方展开,
    // 它们是真正的友军 AI(会自己找目标交战), 于是敌人"最多 3 个咬玩家"之外的注意力会分到
    // 它们身上 —— 正是用户要的效果。
    this.spawnSquadron(8);`,
`    // === 我方空中中队: 帮玩家吸引火力 (per user request: 第一关多给几个空中中队的友军) ==
    // 注意: spawnSquadron() 是**联机**机制(需要 this._net), 单机里直接 return —— 所以这里用
    // 剧情关自己的友军中队实现(与 T-00 的支援机同一套 _sorties), 单机也真的会出现、真的参战。
    this.spawnStorySquadrons(8);`,
 '改用剧情友军中队');

rep(`  /** 按阶段装载表重建 16 个挂点(先把上一阶段的挂点单位 + 网格全部清除)。 */`,
`  /**
   * 第一关的我方空中中队 (per user request: 多给几个空中中队的友军帮玩家吸引注意力)。
   * 两个中队共 n 架, 在玩家侧后上方展开; 它们进 _sorties(与 T-00 支援机同一套 AI), 并且
   * 攻击目标由 updateStoryS01 每帧指向敌方主舰 —— 于是它们会真的扑上去打主舰, 顺手把
   * 敌人的注意力从玩家身上分走(配合"同时最多 3 个咬玩家"的配额)。
   */
  private spawnStorySquadrons(n: number) {
    const models: AircraftModel[] = ['f16', 'f16', 'f15', 'f16', 'f16', 'f15', 'f16', 'f16'];
    const p = this.player.position;
    for (let i = 0; i < n; i++) {
      const model = models[i % models.length];
      const base = this.geomCache[model];
      if (!base) continue;
      // AI 走低模(与敌机同一规则)
      const mesh = buildAircraftMesh(getLowGeometry(model), 0x3a6aaa, { metalness: 0.5, roughness: 0.5, model });
      const g = new THREE.Group();
      mesh.scale.setScalar(1.6);
      g.add(mesh);
      // 两个中队: 每 4 架一队, 一队在玩家左后, 一队在右后
      const squad = Math.floor(i / 4);
      const k = i % 4;
      g.position.set(
        p.x + (squad === 0 ? -1 : 1) * (420 + k * 160),
        p.y + 260 + (k % 2) * 90,
        p.z - 900 - Math.floor(k / 2) * 200,
      );
      this.scene.add(g);
      this._sorties.push({
        group: g,
        pos: g.position,
        forward: new THREE.Vector3(0, 0, 1),
        speed: 470,
        hp: 90,
        alive: true,
        target: p.clone(),          // 由 updateStoryS01 每帧指向主舰
        missileT: 3 + i * 0.8,
        lockT: 0,
      });
    }
  }

  /** 按阶段装载表重建 16 个挂点(先把上一阶段的挂点单位 + 网格全部清除)。 */`,
 'spawnStorySquadrons');

// 每帧把友军中队的攻击目标指向主舰
rep(`    // === 全局随机敌军通讯(主舰存活期间随机播) ===`,
`    // 我方中队的攻击目标 = 敌方主舰(它们会自己飞过去打, 从而分走敌人注意力)
    if (this._sorties.length > 0) {
      for (const s of this._sorties) if (s.alive) s.target.copy(boss.position);
    }

    // === 全局随机敌军通讯(主舰存活期间随机播) ===`,
 '中队目标指向主舰');
