// §225c 生成(敌我各 28%) + 组件决定开火密度
const fs = require('fs');
const p = 'src/lib/game/engine.ts';
let s = fs.readFileSync(p, 'utf8');
function once(a, l) { const n = s.split(a).length - 1; if (n !== 1) { console.error('miss', l, n); process.exit(1); } }

// ---------- ⑤ 生成: 在 placeUnit 里给 air_light 单独构造(巨型长方形 + 组件) ----------
once('    const placeUnit = (type: GroundUnitType, isAlly: boolean, dist: number, angle: number) => {', 'placeUnit');
s = s.replace('    const placeUnit = (type: GroundUnitType, isAlly: boolean, dist: number, angle: number) => {', [
  '    const placeUnit = (type: GroundUnitType, isAlly: boolean, dist: number, angle: number) => {',
  '      // === 空中战舰: 模型/字段与地面单位不同, 单独构造 (per user request) ==========',
  "      if (type === 'air_light') {",
  '        const model = buildAirWarship(isAlly, 1);',
  '        const hFn2 = (this as unknown as { _terrainHeightFn?: (x: number, z: number) => number })._terrainHeightFn;',
  '        const px = Math.cos(angle) * dist, pz = Math.sin(angle) * dist;',
  '        const terrH = hFn2 ? hFn2(px, pz) : 0;',
  '        // 高度: 离地最低 2000m(用户要求), 再随机抬高一点',
  '        const y = terrH + AIR_WARSHIP_MIN_AGL + 200 + Math.random() * 1400;',
  '        model.group.position.set(px, y, pz);',
  '        const heading = angle + Math.PI;',
  '        model.group.rotation.y = heading;',
  '        this.scene.add(model.group);',
  '        const unit: GroundUnit = {',
  '          id: id++ as unknown as number,',
  "          type: 'air_light',",
  '          isAlly,',
  '          group: model.group,',
  '          position: model.group.position.clone(),',
  '          velocity: new THREE.Vector3(Math.sin(heading) * 38, 0, Math.cos(heading) * 38),',
  '          heading,',
  '          speed: 38,',
  '          hp: hpMap.air_light,',
  '          maxHp: hpMap.air_light,',
  '          alive: true,',
  "          name: (isAlly ? '友军' : '敌军') + '轻型空中战舰',",
  '          missileTimer: 2 + Math.random() * 3,',
  '          gunTimer: 1 + Math.random() * 2,',
  '          groundCombatTimer: 5,',
  '          isAir: true,',
  '          airComponents: model.components,',
  '          airMotion: makeAirWarshipMotion(heading),',
  '          collideR: model.hull.radius,',
  '        } as unknown as GroundUnit;',
  '        this.groundUnits.push(unit);',
  '        (model.group as unknown as { _groundUnit?: GroundUnit })._groundUnit = unit;',
  '        return;',
  '      }',
].join('\n'));

// ---------- ⑤b 28% 刷新: 紧跟在地面单位布置之后 ----------
// 找一个"布置完地面单位"的位置: 用 placeUnit 的定义作用域结束前的调用点。
const callSite = '      this.groundUnits.push(unit);\n    };';
if (s.split(callSite).length - 1 === 1) {
  s = s.replace(callSite, [
    '      this.groundUnits.push(unit);',
    '    };',
    '    // === 轻型空中战舰刷新 (per user request: 敌我各约 28%) =======================',
    '    // 独立掷骰: 敌方一艘 / 我方一艘, 各 28% 概率(都低)。位置在 7000~11000m 外,',
    '    // 高度离地 ≥2000m(placeUnit 里算), 于是它一进关就在远处高空盘旋。',
    '    if (Math.random() < 0.28) {',
    "      placeUnit('air_light', false, 7000 + Math.random() * 4000, Math.random() * Math.PI * 2);",
    '    }',
    '    if (Math.random() < 0.28) {',
    "      placeUnit('air_light', true, 5000 + Math.random() * 3000, Math.random() * Math.PI * 2);",
    '    }',
  ].join('\n'));
  console.log('⑤ 28% 刷新已插入');
} else {
  console.error('miss: placeUnit 尾部锚点', s.split(callSite).length - 1);
  process.exit(1);
}

fs.writeFileSync(p, s);
console.log('§225c ok');
