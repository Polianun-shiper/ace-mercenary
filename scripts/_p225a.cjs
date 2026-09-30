// §225 空中战舰接入地面单位管线
//   ① GroundUnitType 新增 'air_light' + 标签/hp/雷达表
//   ② GroundUnit 接口加 isAir / components / falling / motion / airModel 字段
//   ③ updateGroundUnits: isAir 单位走 air-warship 的运动 AI(跳过地面贴地), 并处理"坠落→触地大爆炸"
//   ④ 组件与 HP 挂钩: 每掉 1/6 血摧毁一个组件; 6 个全毁 = 血尽 = 进坠落态
//   ⑤ 生成: 敌我各 28% 几率刷一艘轻型空中战舰
const fs = require('fs');

// ---------- ① environment.ts: 类型 ----------
{
  const p = 'src/lib/game/environment.ts';
  let s = fs.readFileSync(p, 'utf8');
  const a = "  | 'radar_station'// land radar — large detection range, no weapons";
  const n = s.split(a).length - 1;
  if (n !== 1) { console.error('miss type', n); process.exit(1); }
  s = s.replace(a, "  | 'radar_station'// land radar — large detection range, no weapons\n"
    + "  | 'air_light';   // 轻型空中战舰(per user request): 巨型长方形舰体 + 6 个表面组件, 高空盘旋");
  fs.writeFileSync(p, s);
  console.log('① GroundUnitType + air_light');
}

// ---------- ② ③ ④ engine.ts ----------
{
  const p = 'src/lib/game/engine.ts';
  let s = fs.readFileSync(p, 'utf8');
  function once(a, l) { const n = s.split(a).length - 1; if (n !== 1) { console.error('miss', l, n); process.exit(1); } }

  // import
  once("import { ProjectedShadow, injectProjectedShadowTree, PROJECTED_SHADOW_DEFAULTS } from './projected-shadow';", 'ps import');
  s = s.replace("import { ProjectedShadow, injectProjectedShadowTree, PROJECTED_SHADOW_DEFAULTS } from './projected-shadow';",
    "import { ProjectedShadow, injectProjectedShadowTree, PROJECTED_SHADOW_DEFAULTS } from './projected-shadow';\n"
    + "// === 空中战舰 (per user request) ===\n"
    + "import {\n  buildAirWarship, makeAirWarshipMotion, updateAirWarshipMotion,\n  AIR_WARSHIP_MIN_AGL, AIR_WARSHIP_COMPONENTS, type AirWarshipComponent, type AirWarshipMotionState,\n} from './air-warship';");

  // 标签表
  once("  radar_station: '雷达站',", 'label anchor');
  s = s.replace("  radar_station: '雷达站',", "  radar_station: '雷达站',\n  air_light: '轻型空中战舰',");

  // 接口字段
  once('  heading: number;          // radians, 0 = +Z', 'unit fields');
  s = s.replace('  heading: number;          // radians, 0 = +Z', [
    '  heading: number;          // radians, 0 = +Z',
    '  // === 空中战舰 (per user request) ==========================================',
    '  /** true = 空中单位(跟着 air-warship 的运动 AI 走, 不贴地) */',
    '  isAir?: boolean;',
    '  /** 舰上组件(6 个): 组件被打完 = 血尽 = 进坠落态; 组件数量决定开火密度 */',
    '  airComponents?: AirWarshipComponent[];',
    '  /** 运动状态(盘旋/直行/目标高度) */',
    '  airMotion?: AirWarshipMotionState;',
    '  /** 已在坠落(血尽后带惯性下坠), 触地大爆炸并消失 */',
    '  falling?: boolean;',
    '  /** 舰体碰撞球半径(命中判定/机体相撞用) */',
    '  collideR?: number;',
  ].join('\n'));

  // hp/雷达表(air_light)
  once('      radar_station: 12000,\n      laser_aa: 5000,', 'radar map');
  s = s.replace('      radar_station: 12000,\n      laser_aa: 5000,', '      radar_station: 12000,\n      laser_aa: 5000,\n      air_light: 9000,');
  once('    const hpMap: Record<GroundUnitType, number> = {', 'hp map');
  s = s.replace('    const hpMap: Record<GroundUnitType, number> = {', '    const hpMap: Record<GroundUnitType, number> = {\n      air_light: 720,');

  fs.writeFileSync(p, s);
  console.log('②③④a engine: 类型/字段/表 ok');
}
