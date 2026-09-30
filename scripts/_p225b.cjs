// §225b 空中战舰的行为接入:
//   ③ updateGroundUnits 里给 isAir 单位走 air-warship 的运动 AI(不贴地)
//   ④ 组件与 HP 挂钩: 每掉 1/6 血摧毁一个组件; 全部摧毁 ⇒ 进坠落态
//   ④b 坠落态: 保留水平惯性 + 重力下坠; 触地 ⇒ 大爆炸 + 移除
//   ⑤ 生成: 敌我各 28% 概率刷一艘(任务开始时)
const fs = require('fs');
const p = 'src/lib/game/engine.ts';
let s = fs.readFileSync(p, 'utf8');
function once(a, l) { const n = s.split(a).length - 1; if (n !== 1) { console.error('miss', l, n); process.exit(1); } }

// ---------- ③ 运动 AI 分支 ----------
// 在 updateGroundUnits 的每单位循环里, 单位速度/朝向确定之后插一段: 空中单位走自己的 AI。
once('      } else if (u.type === \'artillery\') {\n        u.speed = 8;', 'speed switch tail');
s = s.replace('      } else if (u.type === \'artillery\') {\n        u.speed = 8;', [
  "      } else if (u.type === 'artillery') {",
  '        u.speed = 8;',
  "      } else if (u.type === 'air_light') {",
  '        // 空中战舰巡航速度(单位/秒)',
  '        u.speed = 38;',
].join('\n'));

// 在"贴地/地形吸附"之前插入空中单位的分支 —— 找 updateGroundUnits 里典型的地面高度处理
const groundSnap = '      const groundY = this.terrainHeight ? this.terrainHeight(u.position.x, u.position.z) : 0;';
if (s.split(groundSnap).length - 1 === 1) {
  s = s.replace(groundSnap, [
    '      // === 空中战舰: 走自己的运动 AI, 不做地面吸附 (per user request) ============',
    '      if (u.isAir) {',
    '        const terrY = this.terrainHeight ? this.terrainHeight(u.position.x, u.position.z) : 0;',
    '        if (u.falling) {',
    '          // 血尽坠落: 保留水平惯性 + 重力下坠, 触地大爆炸并消失',
    '          u.velocity.y -= 26 * dt;',
    '          u.position.addScaledVector(u.velocity, dt);',
    '          u.group.position.copy(u.position);',
    '          u.group.rotation.z += dt * 0.06;   // 缓慢侧倾, 读起来像失控',
    '          if (u.position.y <= terrY + 12) {',
    '            this.spawnExplosion(u.position.clone(), 9);      // 触地大爆炸',
    '            this.spawnExplosion(u.position.clone().add(new THREE.Vector3(0, 18, 0)), 6);',
    '            u.alive = false;',
    '            u.hp = 0;',
    '            u.group.visible = false;',
    '            this.scene.remove(u.group);',
    '          }',
    '        } else {',
    '          if (!u.airMotion) u.airMotion = makeAirWarshipMotion(u.heading);',
    '          const hRef = { heading: u.heading };',
    '          updateAirWarshipMotion(u.position, u.velocity, hRef, u.airMotion, dt, terrY, u.speed);',
    '          u.heading = hRef.heading;',
    '          u.group.position.copy(u.position);',
    '          u.group.rotation.y = u.heading;',
    '          // 组件随舰体一起转(它们本来就是 group 的子节点), 这里只推进各自的冷却/摧毁表现',
    '          if (u.airComponents) {',
    '            for (const c of u.airComponents) {',
    '              if (c.fireTimer > 0) c.fireTimer -= dt;',
    '              // 被打掉的组件: 下沉/变暗(视觉上"没了")',
    '              c.mesh.visible = c.alive;',
    '            }',
    '          }',
    '          // 血量 → 组件摧毁(每掉 1/6 血毁一个); 全毁 ⇒ 进坠落态',
    '          if (u.airComponents && u.maxHp > 0) {',
    '            const aliveWant = Math.max(0, Math.ceil((u.hp / u.maxHp) * u.airComponents.length));',
    '            let aliveNow = u.airComponents.filter((c) => c.alive).length;',
    '            for (const c of u.airComponents) {',
    '              if (aliveNow > aliveWant && c.alive) {',
    '                c.alive = false; c.mesh.visible = false; aliveNow--;',
    '                this.spawnExplosion(u.position.clone(), 2.2);   // 组件被毁的小爆炸',
    '              }',
    '            }',
    '            if (aliveNow <= 0 || u.hp <= 0) {',
    '              // 6 个组件全毁 ⇒ 舰体爆炸 + 以原惯性坠落',
    '              u.falling = true;',
    '              u.velocity.y = Math.min(u.velocity.y, 0);',
    '              this.spawnExplosion(u.position.clone(), 7);',
    '              this.spawnExplosion(u.position.clone().add(new THREE.Vector3(0, 10, 0)), 5);',
    '            }',
    '          }',
    '        }',
    '        continue;   // 空中单位不走下面的地面逻辑',
    '      }',
    groundSnap,
  ].join('\n'));
  console.log('③④ 空中 AI + 组件摧毁 + 坠落 已插入');
} else {
  console.error('miss: groundSnap 锚点', s.split(groundSnap).length - 1);
  process.exit(1);
}

fs.writeFileSync(p, s);
console.log('§225b ok');
