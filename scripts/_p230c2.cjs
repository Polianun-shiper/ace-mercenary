// §230c(2): 补上被中断的那几条(导弹节奏替换/Enemy 字段/FBX 预载/字段/setupStoryS01/导入/AI 分层)
const fs = require('fs');
const E = 'src/lib/game/engine.ts';
function rep(a, b, label, all) {
  let s = fs.readFileSync(E, 'utf8');
  const n = s.split(a).length - 1;
  if (n === 0) { console.log('skip:', label); return; }
  if (!all && n !== 1) { console.error('miss(' + n + '):', label); process.exit(1); }
  fs.writeFileSync(E, all ? s.split(a).join(b) : s.replace(a, b));
  console.log('ok:', label, '(' + n + ')');
}

rep(`e.missileTimer = (5 + Math.random() * 1) * this.diff.enemyCd;`,
    `e.missileTimer = (5 + Math.random() * 1) * this.diff.enemyCd * (e.fireRateScale ?? 1);`,
    '导弹节奏(全部)', true);

rep(`  aceInvulnerable?: boolean;`,
`  aceInvulnerable?: boolean;
  /** 普通 AI 的开火间隔倍率(>1 更慢); 剧情关卡用它把大编队的火力压下来 */
  fireRateScale?: number;`,
 'Enemy.fireRateScale 字段');

rep(`    const results = await Promise.allSettled(models.map((m) => loadAircraftGeometry(m)));`,
`    // 正式版剧情第一关: 顺手把用户给的主舰 FBX 也载进来(失败就回退程序化舰体, 不阻断开局)
    if (this.isS01) {
      (globalThis as { __loadStage?: string }).__loadStage = 'models:主舰FBX';
      this.bossFbx = await loadBastionModel();
      this.bossFbxSource = this.bossFbx ? 'fbx' : 'procedural';
    }
    const results = await Promise.allSettled(models.map((m) => loadAircraftGeometry(m)));`,
 'FBX 预载');

rep(`  private bossFlareTimer = 0;   // 阶段 2 干扰弹节流`,
`  private bossFlareTimer = 0;   // 阶段 2 干扰弹节流
  /** 用户给的 FBX 主舰(载入失败为 null => 回退程序化舰体) */
  private bossFbx: THREE.Object3D | null = null;
  /** 主舰模型来源(探针/控制台可读): 'fbx' | 'procedural' */
  private bossFbxSource: 'fbx' | 'procedural' = 'procedural';`,
 'bossFbx 字段');

rep(`    const model = buildDreadnought(false);
    this.bossModel = model;`,
`    // 主舰模型: 优先用用户给的 FBX(等比放大到 DREADNOUGHT_SIZE.len), 失败则程序化舰体
    const model = this.bossFbx
      ? buildDreadnoughtFromModel(this.bossFbx, false)
      : buildDreadnought(false);
    this.bossModel = model;`,
 'setupStoryS01 用 FBX');

rep(`import {
  buildDreadnought, buildDrone, applyStageLoadout, makeDreadnoughtMotion, updateDreadnoughtMotion,`,
`import {
  buildDreadnought, buildDreadnoughtFromModel, loadBastionModel, buildDrone,
  applyStageLoadout, makeDreadnoughtMotion, updateDreadnoughtMotion,`,
 '导入 FBX 接口');

rep(`      const spawn: EnemySpawn = {
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
      };`,
`      // === AI 分层 (per user request: 大部分普通 AI, 少部分高级) =================
      // 高级(ace): 6 倍血 + 4 次导弹规避 + Su-35(导弹档次更高) —— 约 15%。
      // 普通: F-16 + 七成血 + 开火间隔 1.8 倍 —— 大编队(12 + 10 架)靠这两个旋钮把压力压下来。
      const ace = Math.random() < 0.15;
      const spawn: EnemySpawn = {
        model: ace ? 'su35' : 'f16',
        role: 'fighter',
        position: [
          boss.position.x + Math.cos(a) * r,
          boss.position.y + (Math.random() - 0.3) * 800,
          boss.position.z + Math.sin(a) * r,
        ],
        heading: boss.heading,
        altitude: boss.position.y + 300,
        callsign: (ace ? '精锐' : '猎犬') + (i + 1),
        skill: ace ? 'ace' : 'normal',
        hpScale: ace ? 1 : 0.7,
        fireRateScale: ace ? 1 : 1.8,
      };`,
 '航空大队 AI 分层');
console.log('§230c-2 done');
