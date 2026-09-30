// §225d 把"造一艘空中战舰"从 placeUnit 闭包里抽成类方法 —— 这样任务布置与调试钩子都能用,
// 验证也不必靠 28% 掷骰碰运气。
const fs = require('fs');
const p = 'src/lib/game/engine.ts';
let s = fs.readFileSync(p, 'utf8');
function once(a, l) { const n = s.split(a).length - 1; if (n !== 1) { console.error('miss', l, n); process.exit(1); } }

// 1) 类方法: 插在 enableProjectedShadow 之前
once('  /**\n   * 启用"投影贴花式阴影"', 'method anchor');
s = s.replace('  /**\n   * 启用"投影贴花式阴影"', [
  '  /**',
  '   * 造一艘轻型空中战舰并登记进 groundUnits (per user request)。',
  '   * 登记进同一条地面单位管线 ⇒ 玩家锁定/伤害/击杀、敌我判定、雷达/HUD 标记全部复用现成逻辑。',
  '   * 位置: 距原点 dist、方位 angle, 高度 = 地形高度 + ≥2000m(用户要求的最低离地)。',
  '   */',
  '  private spawnAirWarship(isAlly: boolean, dist: number, angle: number): GroundUnit | null {',
  '    try {',
  '      const model = buildAirWarship(isAlly, 1);',
  '      const hFn = (this as unknown as { _terrainHeightFn?: (x: number, z: number) => number })._terrainHeightFn;',
  '      const px = Math.cos(angle) * dist, pz = Math.sin(angle) * dist;',
  '      const terrH = hFn ? hFn(px, pz) : 0;',
  '      const y = terrH + AIR_WARSHIP_MIN_AGL + 200 + Math.random() * 1400;',
  '      model.group.position.set(px, y, pz);',
  '      const heading = angle + Math.PI;',
  '      model.group.rotation.y = heading;',
  '      this.scene.add(model.group);',
  '      const unit = {',
  '        id: ++this.idCounter,',
  "        type: 'air_light' as GroundUnitType,",
  '        isAlly,',
  '        group: model.group,',
  '        position: model.group.position.clone(),',
  '        velocity: new THREE.Vector3(Math.sin(heading) * 38, 0, Math.cos(heading) * 38),',
  '        heading,',
  '        speed: 38,',
  '        hp: 720,',
  '        maxHp: 720,',
  '        alive: true,',
  "        name: (isAlly ? '友军' : '敌军') + '轻型空中战舰',",
  '        missileTimer: 2 + Math.random() * 3,',
  '        gunTimer: 1 + Math.random() * 2,',
  '        groundCombatTimer: 5,',
  '        isAir: true,',
  '        airComponents: model.components,',
  '        airMotion: makeAirWarshipMotion(heading),',
  '        collideR: model.hull.radius,',
  '      } as unknown as GroundUnit;',
  '      this.groundUnits.push(unit);',
  '      return unit;',
  '    } catch (e) {',
  "      console.warn('[airship] 生成失败:', e);",
  '      return null;',
  '    }',
  '  }',
  '',
  '  /**\n   * 启用"投影贴花式阴影"',
].join('\n'));

// 2) placeUnit 里的那段闭包实现 → 直接调用类方法
const start = s.indexOf("      if (type === 'air_light') {");
const endMark = '        return;\n      }\n';
const end = s.indexOf(endMark, start);
if (start < 0 || end < 0) { console.error('closure block not found'); process.exit(1); }
const blockEnd = end + endMark.length;
s = s.slice(0, start) + [
  "      if (type === 'air_light') {",
  '        this.spawnAirWarship(isAlly, dist, angle);',
  '        return;',
  '      }',
].join('\n') + '\n' + s.slice(blockEnd);

// 3) 调试钩子(验证用): __airship(true/false) 立即刷一艘
once("      (window as any).__vegdbg = (arg?: unknown) => this.setDebugView(`vegdbg${arg === undefined ? '' : ` ${String(arg)}`}`);", 'hook anchor');
s = s.replace("      (window as any).__vegdbg = (arg?: unknown) => this.setDebugView(`vegdbg${arg === undefined ? '' : ` ${String(arg)}`}`);",
  "      (window as any).__vegdbg = (arg?: unknown) => this.setDebugView(`vegdbg${arg === undefined ? '' : ` ${String(arg)}`}`);\n"
  + "      // 空中战舰: __airship(true) 刷我方 / __airship(false) 刷敌方(验证用; 正式刷新是任务开始时各 28%)\n"
  + "      (window as any).__airship = (ally?: unknown) => {\n"
  + "        const u = this.spawnAirWarship(ally === undefined ? false : !!ally, 3000, Math.random() * Math.PI * 2);\n"
  + "        return u ? `空中战舰已生成: ${u.name} @ ${Math.round(u.position.x)},${Math.round(u.position.y)},${Math.round(u.position.z)} 组件 ${u.airComponents?.length ?? 0}` : '空中战舰生成失败';\n"
  + '      };');

fs.writeFileSync(p, s);
console.log('§225d ok: spawnAirWarship 类方法 + __airship 钩子');
