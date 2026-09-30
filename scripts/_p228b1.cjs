// §228b(1/3): 类型 + 导入 + 状态字段 + 剧情控制器骨架(setupStoryS01 / 挂点 / 阶段 / 主循环)
const fs = require('fs');
function patch(file, jobs) {
  let s = fs.readFileSync(file, 'utf8');
  for (const [a, b, label] of jobs) {
    const n = s.split(a).length - 1;
    if (n !== 1) { console.error('miss(' + n + ') ' + file + ':', label); process.exit(1); }
    s = s.replace(a, b);
    console.log('ok:', label);
  }
  fs.writeFileSync(file, s);
}

// ---------- ① 单位类型 + 组件类型 ----------
patch('src/lib/game/environment.ts', [
  [`  | 'air_light'     // 轻型空中战舰(per user request): 巨型长方形舰体 + 6 个表面组件, 高空盘旋
  | 'air_component'; // 空中战舰的**附属组件单位**(per user request): 独立开火 + 独立可锁定, 固定在舰面上`,
   `  | 'air_light'     // 轻型空中战舰(per user request): 巨型长方形舰体 + 6 个表面组件, 高空盘旋
  | 'air_component' // 空中战舰的**附属组件单位**(per user request): 独立开火 + 独立可锁定, 固定在舰面上
  | 'air_boss'      // 正式版剧情第一关的敌方主舰「堡垒」(900x240x160, 16 个面部挂点, 分阶段战斗)
  | 'air_drone';    // 无人机(蜂群): 自杀式冲撞, 数量有限, 骚扰玩家`,
   'GroundUnitType += air_boss/air_drone'],
  [`    case 'air_light': return new THREE.Group();
    // 舰载组件: 网格由空中战舰模块直接挂到舰体上, 这里只给一个空组占位(类型完备用)
    case 'air_component': return new THREE.Group();`,
   `    case 'air_light': return new THREE.Group();
    // 舰载组件: 网格由空中战舰模块直接挂到舰体上, 这里只给一个空组占位(类型完备用)
    case 'air_component': return new THREE.Group();
    // 主舰「堡垒」与无人机同理: 网格由 dreadnought.ts 提供(引擎直接建), 这里只占位
    case 'air_boss': return new THREE.Group();
    case 'air_drone': return new THREE.Group();`,
   'buildGroundUnit cases'],
]);

// ---------- ② 组件类型支持激光/核心 ----------
patch('src/lib/game/air-warship.ts', [
  [`export type AirWarshipComponentKind = 'gun' | 'missile';`,
   `// 'laser' | 'core' 是主舰「堡垒」用的(per user request): 激光炮需要充能/持续照射,
// 核心模块是被打掉才算阶段完成的弱点, 自身不开火。
export type AirWarshipComponentKind = 'gun' | 'missile' | 'laser' | 'core';`,
   'component kind union'],
  [`  /** 组件在舰体本地空间的位置 —— 引擎每帧用它算出组件的世界坐标(供锁定/命中/雷达框) */
  localPos: THREE.Vector3;
  /** 命中/雷达框用的包围球半径(米) */
  radius: number;`,
   `  /** 组件在舰体本地空间的位置 —— 引擎每帧用它算出组件的世界坐标(供锁定/命中/雷达框) */
  localPos: THREE.Vector3;
  /** 命中/雷达框用的包围球半径(米) */
  radius: number;
  /** 激光充能进度 0..1(仅 kind === 'laser' 有意义) */
  charge?: number;
  /** 挂点序号(主舰装载表里 0..15, 剧情台词按它对应"刺猬N/长矛N") */
  index?: number;`,
   'component optional fields'],
]);

// ---------- ③ engine: 导入 ----------
patch('src/lib/game/engine.ts', [
  [`import { RadioChatter, RadioEvent } from './radio';`,
   `import { RadioChatter, RadioEvent, S01_BLOCKS, S01_RANDOM_CONTROL } from './radio';
// === 正式版剧情第一关: 敌方主舰「堡垒」(per user request) ====================
// 900x240x160 的 dreadnought + 每阶段 16 个面部挂点(装载表在 dreadnought.ts) + 无人机。
import {
  buildDreadnought, buildDrone, applyStageLoadout, makeDreadnoughtMotion, updateDreadnoughtMotion,
  DREADNOUGHT_MIN_AGL, DREADNOUGHT_SPEED, DRONE_HP,
  type DreadnoughtModel, type DreadnoughtMotionState,
} from './dreadnought';`,
   'engine imports'],

  // ---------- ④ 状态字段 ----------
  [`  private t00EndingStarted = false;    // T-00 收尾流程已启动（防重复）`,
   `  private t00EndingStarted = false;    // T-00 收尾流程已启动（防重复）

  // === 正式版剧情第一关: 空中战舰「堡垒」剧情控制器 (per user request) ==========
  // 关卡 id 's01' 时整关的敌人由这里按剧情阶段刷: 主舰 + 16 挂点 + 航空大队 + 轻型舰 + 无人机。
  // 阶段推进条件 = **本阶段 16 个挂点全部击毁**; 打完 4 个阶段后核心暴露, 核心全毁才开始坠落
  // (per user request: boss 空中战舰要打完所有剧情阶段才会坠落)。
  private isS01 = false;
  private boss: GroundUnit | null = null;
  private bossModel: DreadnoughtModel | null = null;
  private bossMotion: DreadnoughtMotionState | null = null;
  private bossStage = 0;                 // 0 遭遇 / 1..4 防御阶段 / 5 坠落
  private bossMountUnits: GroundUnit[] = [];
  private bossKilledInStage = 0;         // 本阶段已毁挂点数(用于台词分档)
  private bossAdvanceT = 0;              // 阶段清空后的推进倒计时
  private bossBlockIdx: Record<string, number> = {};  // 每组台词播到第几句
  private bossWingIds: number[] = [];    // 当前航空大队(阶段切换时撤退)
  private bossLossIdx = 0;               // 护航机损失台词进度
  private bossAnvilIdx = 0;              // 铁砧(轻型舰)台词进度
  private bossCoreIdx = 0;               // 核心模块台词进度
  private bossDrones: GroundUnit[] = [];
  private bossDroneTimer = 12;
  private bossRandTimer = 30;
  private bossFalling = false;
  private bossFallDone = false;
  private bossEndT = 0;`,
   'S01 state fields'],

  // ---------- ⑤ 关卡判定 ----------
  [`    this.isT00 = mission.id === 't00';`,
   `    this.isT00 = mission.id === 't00';
    // 正式版剧情第一关: 敌人全部由剧情控制器刷(见 setupStoryS01)
    this.isS01 = mission.id === 's01';`,
   'isS01 flag'],

  // ---------- ⑥ startMission 挂钩 ----------
  [`    if (this.isT00) this.spawnT00Assault();`,
   `    if (this.isT00) this.spawnT00Assault();
    // === 正式版剧情第一关: 主舰「堡垒」入场 (per user request) ===
    if (this.isS01) this.setupStoryS01();`,
   'setupStoryS01 hook'],

  // ---------- ⑦ 主循环挂钩 ----------
  [`    this.updateGroundUnits(dt); // ships/tanks/SAMs move + engage aircraft`,
   `    this.updateGroundUnits(dt); // ships/tanks/SAMs move + engage aircraft
    this.updateStoryS01(dt);    // 正式版剧情第一关: 主舰阶段推进 / 无人机 / 随机台词`,
   'updateStoryS01 hook'],

  // ---------- ⑧ 单位字段 ----------
  [`  /** 已被拆掉的组件(网格已从舰体摘除, 不再参与开火) */
  compDetached?: boolean;`,
   `  /** 已被拆掉的组件(网格已从舰体摘除, 不再参与开火) */
  compDetached?: boolean;
  /** true = 敌方主舰「堡垒」本体(走 dreadnought 的分阶段运动 AI) */
  boss?: boolean;
  /** true = 无人机(蜂群): 自杀式冲撞玩家 */
  isDrone?: boolean;`,
   'GroundUnit boss/drone fields'],
]);
console.log('§228b-1 ok');
