// §227c: 补上所有 Record<GroundUnitType, ...> 表里的 air_component, 以及 buildGroundUnit 的兜底分支
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

patch('src/lib/game/engine.ts', [
  // ① HUD 载具型号标签
  ["const GROUND_MODEL_LABEL: Record<GroundUnitType, string> = {",
   "const GROUND_MODEL_LABEL: Record<GroundUnitType, string> = {\n  // 舰载组件(独立单位)在 HUD 上就写它是什么: 导弹组 / 机炮\n  air_component: '舰载组件',",
   'GROUND_MODEL_LABEL'],
  // ② 第一张 hpMap
  ["    const hpMap: Record<GroundUnitType, number> = {\n      air_light: 720,",
   "    const hpMap: Record<GroundUnitType, number> = {\n      air_light: 720,\n      air_component: 120,",
   'hpMap #1'],
  // ③ 第二张 hpMap
  ["      sam_launcher: 150, aa_vehicle: 60, artillery: 100, bunker: 500, radar_station: 80, laser_aa: 480, air_light: 720,\n    };",
   "      sam_launcher: 150, aa_vehicle: 60, artillery: 100, bunker: 500, radar_station: 80, laser_aa: 480, air_light: 720,\n      air_component: 120,\n    };",
   'hpMap #2'],
  // ④ 第一张 radarRangeMap
  ["      destroyer: 6000,\n      cruiser: 8000,\n      frigate: 5000,\n      patrol_boat: 2500,",
   "      destroyer: 6000,\n      cruiser: 8000,\n      frigate: 5000,\n      patrol_boat: 2500,\n      air_component: 5200,",
   'radarRangeMap #1'],
  // ⑤ 第二张 radarRangeMap
  ["      sam_launcher: 7000, aa_vehicle: 3000, artillery: 2000, bunker: 1500, radar_station: 12000, laser_aa: 5000,",
   "      sam_launcher: 7000, aa_vehicle: 3000, artillery: 2000, bunker: 1500, radar_station: 12000, laser_aa: 5000,\n      air_component: 5200,",
   'radarRangeMap #2'],
]);

patch('src/lib/game/environment.ts', [
  // buildGroundUnit 的兜底分支(引擎不会用它建组件 —— 组件的网格由舰体提供, 这里只为类型完备)
  ["    case 'air_light': return new THREE.Group();",
   "    case 'air_light': return new THREE.Group();\n    // 舰载组件: 网格由空中战舰模块直接挂到舰体上, 这里只给一个空组占位(类型完备用)\n    case 'air_component': return new THREE.Group();",
   'buildGroundUnit air_component'],
]);
console.log('§227c ok');
