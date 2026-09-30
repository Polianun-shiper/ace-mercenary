// §230c: 轻型舰长宽高 x3 + 引擎接入 FBX 主舰 + 敌机 AI 分层(大部分普通/少部分高级)
const fs = require('fs');
function rep(file, a, b, label) {
  let s = fs.readFileSync(file, 'utf8');
  const n = s.split(a).length - 1;
  if (n === 0) { console.log('skip:', label); return; }
  if (n !== 1) { console.error('miss(' + n + ') ' + file + ':', label); process.exit(1); }
  fs.writeFileSync(file, s.replace(a, b));
  console.log('ok:', label);
}
const AW = 'src/lib/game/air-warship.ts';
const T = 'src/lib/game/types.ts';
const E = 'src/lib/game/engine.ts';

// ① 轻型舰: 体积 x10 之后再按长宽高 x3
rep(AW, `export const AIR_WARSHIP_SCALE = Math.cbrt(10);`,
`export const AIR_WARSHIP_SCALE = Math.cbrt(10) * 3;`,
 '轻型舰 AIR_WARSHIP_SCALE x3');
rep(AW, `/** 轻型空中战舰尺寸(已含体积倍率) */`,
`/** 轻型空中战舰尺寸(已含倍率)。
 *  (per user request: 体积 x10 之后, 这一轮再按**长宽高各 x3** -> 乘数 = cbrt(10) x 3 = 6.463,
 *   基础 96x26x16 于是变成约 620x168x103 米 —— 与主舰同一套约定。) */`,
 '轻型舰注释');

// ② EnemySpawn 增加 AI 分层字段
rep(T, `export interface EnemySpawn {`,
`export interface EnemySpawn {
  // === AI 分层 (per user request: 大部分普通 AI, 少部分高级 AI) ==================
  // 'ace' = 高级(6 倍血 + 4 次导弹规避), 缺省 = 普通。
  // hpScale / fireRateScale 是给"普通"再分档用的: 血更少、导弹间隔更长 —— 剧情关卡里的大编队
  // 必须靠这两个旋钮压下来, 否则十几架一起扑上来玩家根本打不过。
  skill?: 'normal' | 'ace';
  hpScale?: number;
  fireRateScale?: number;`,
 'EnemySpawn skill 字段');

// ③ spawnEnemyFromWave: 应用分层
rep(E, `    const aceHp = spawn.ace ? stats.hp * 6 : stats.hp;`,
`    const isAce = spawn.ace === true || spawn.skill === 'ace';
    const aceHp = Math.max(1, Math.round(stats.hp * (spawn.hpScale ?? 1) * (isAce ? 6 : 1)));`,
 'spawn hp 分层');
rep(E, `      aceDodgeLeft: spawn.ace ? 4 : undefined,`,
`      aceDodgeLeft: isAce ? 4 : undefined,`,
 'dodge 分层');
rep(E, `      aceInvulnerable: spawn.ace ? this.aceStoryActive : undefined,`,
`      aceInvulnerable: isAce ? this.aceStoryActive : undefined,
      // 普通 AI 的开火间隔按 fireRateScale 拉长(>1 = 更慢), 见 EnemySpawn 的注释
      fireRateScale: spawn.fireRateScale ?? 1,`,
 'fireRateScale 落到敌机');

// ④ 敌机导弹节奏用得上 fireRateScale
rep(E, `            e.missileTimer = (5 + Math.random() * 1) * this.diff.enemyCd;`,
`            e.missileTimer = (5 + Math.random() * 1) * this.diff.enemyCd * (e.fireRateScale ?? 1);`,
 '导弹节奏 #1');
rep(E, `              e.missileTimer = (5 + Math.random() * 1) * this.diff.enemyCd;`,
`              e.missileTimer = (5 + Math.random() * 1) * this.diff.enemyCd * (e.fireRateScale ?? 1);`,
 '导弹节奏 #2');

// ⑤ Enemy 字段声明
rep(E, `  aceInvulnerable?: boolean;`,
`  aceInvulnerable?: boolean;
  /** 普通 AI 的开火间隔倍率(>1 更慢); 剧情关卡用它把大编队的火力压下来 */
  fireRateScale?: number;`,
 'Enemy.fireRateScale 字段');

// ⑥ 主舰 FBX 预载(只在 s01)
rep(E, `    const results = await Promise.allSettled(models.map((m) => loadAircraftGeometry(m)));`,
`    // 正式版剧情第一关: 顺手把用户给的主舰 FBX 也载进来(失败就回退程序化舰体, 不阻断开局)
    if (this.isS01) {
      (globalThis as { __loadStage?: string }).__loadStage = 'models:主舰FBX';
      this.bossFbx = await loadBastionModel();
      this.bossFbxSource = this.bossFbx ? 'fbx' : 'procedural';
    }
    const results = await Promise.allSettled(models.map((m) => loadAircraftGeometry(m)));`,
 'FBX 预载');

// ⑦ 字段
rep(E, `  private bossFlareTimer = 0;   // 阶段 2 干扰弹节流`,
`  private bossFlareTimer = 0;   // 阶段 2 干扰弹节流
  /** 用户给的 FBX 主舰(载入失败为 null => 回退程序化舰体) */
  private bossFbx: THREE.Object3D | null = null;
  /** 主舰模型来源(探针/控制台可读): 'fbx' | 'procedural' */
  private bossFbxSource: 'fbx' | 'procedural' = 'procedural';`,
 'bossFbx 字段');

// ⑧ setupStoryS01 用 FBX
rep(E, `    const model = buildDreadnought(false);
    this.bossModel = model;`,
`    // 主舰模型: 优先用用户给的 FBX(等比放大到 DREADNOUGHT_SIZE.len), 失败则程序化舰体
    const model = this.bossFbx
      ? buildDreadnoughtFromModel(this.bossFbx, false)
      : buildDreadnought(false);
    this.bossModel = model;`,
 'setupStoryS01 用 FBX');

// ⑨ 导入
rep(E, `import {
  buildDreadnought, buildDrone, applyStageLoadout, makeDreadnoughtMotion, updateDreadnoughtMotion,`,
`import {
  buildDreadnought, buildDreadnoughtFromModel, loadBastionModel, buildDrone,
  applyStageLoadout, makeDreadnoughtMotion, updateDreadnoughtMotion,`,
 '导入 FBX 接口');

// ⑩ 航空大队 AI 分层(15% 高级 + 85% 普通)
rep(E, `      const spawn: EnemySpawn = {
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
      // 高级(ace): 6 倍血 + 4 次导弹规避 + Su-35 机体(导弹档次更高) —— 约占 15%。
      // 普通: F-16 + 七成血 + 开火间隔 1.8 倍 —— 大编队(最多 12+10 架)靠这个把压力压下来。
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
console.log('§230c done');
