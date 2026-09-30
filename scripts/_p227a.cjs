// §227a: 把"组件=装饰网格"改成"组件=独立单位"。
// 1) 在 air 分支最前面插入**组件分支**(同步世界坐标 + 独立开火)
// 2) 把舰体分支里的"组件台账 + 开火"整段换成新台账(组件死活由组件单位决定)
const fs = require('fs');
const p = 'src/lib/game/engine.ts';
let s = fs.readFileSync(p, 'utf8');
const lines = s.split('\n');
const at = (n) => lines[n - 1]; // 1-indexed

// ---------- 1) 组件分支: 插在"空中战舰: 走 air-warship 的运动 AI"之前 ----------
const anchorIdx = lines.findIndex((l) => l.includes('// === 空中战舰: 走 air-warship 的运动 AI'));
if (anchorIdx < 0) { console.error('anchor 1 missing'); process.exit(1); }
const indent = '      ';
const compBranch = [
  `${indent}// === 空中战舰的**附属组件单位** (per user request) =====================`,
  `${indent}// 组件自己不会飞: 它的网格本来就是舰体 group 的子节点(位置/朝向自动跟着舰体),`,
  `${indent}// 这里只做两件事 —— ① 把登记用的世界坐标(锁定/命中/雷达要)按母舰矩阵更新;`,
  `${indent}// ② 让组件**独立**选目标、独立开火(机炮组件打机炮、导弹组件打导弹)。`,
  `${indent}if (u.isAir && u.isComponent) {`,
  `${indent}  const ship = u.parentShipId !== undefined`,
  `${indent}    ? this.groundUnits.find((g) => g.id === u.parentShipId)`,
  `${indent}    : undefined;`,
  `${indent}  const comp = ship?.airComponents?.[u.compIndex ?? -1];`,
  `${indent}  if (!ship || !comp) {`,
  `${indent}    // 母舰已经不在了 ⇒ 组件跟着消失(绝不把孤儿目标留在雷达/锁定列表里)`,
  `${indent}    if (!u.compDetached) this.detachAirComponent(u, true);`,
  `${indent}  } else {`,
  `${indent}    u.position.copy(u.attachLocal ?? comp.localPos).applyMatrix4(ship.group.matrixWorld);`,
  `${indent}    u.velocity.copy(ship.velocity);`,
  `${indent}    u.heading = ship.heading;`,
  `${indent}    // 组件被单独打掉(或母舰血量拆掉了它) ⇒ 摘网格; 全毁由母舰分支收尾`,
  `${indent}    if (!u.alive || u.compDetached || !comp.alive) {`,
  `${indent}      if (!u.compDetached) this.detachAirComponent(u, true);`,
  `${indent}    } else {`,
  `${indent}      this.updateAirComponentWeapons(u, ship, comp, dt);`,
  `${indent}    }`,
  `${indent}  }`,
  `${indent}  continue;   // 组件不走地面逻辑, 也不走舰体逻辑`,
  `${indent}}`,
].join('\n');
lines.splice(anchorIdx, 0, compBranch);

// ---------- 2) 舰体分支里的组件台账段: 定位并整段替换 ----------
const startIdx = lines.findIndex((l) => l.includes('// 组件: 随舰体一起转(group 子节点)'));
if (startIdx < 0) { console.error('anchor 2 missing'); process.exit(1); }
// 结束点: 该段之后第一个只由 10 个空格 + '}' 组成的行(关闭 if (comps))
let endIdx = -1;
for (let i = startIdx + 1; i < lines.length; i++) {
  if (lines[i] === '          }') { endIdx = i; break; }
}
if (endIdx < 0) { console.error('end of comps block not found'); process.exit(1); }
console.log('replacing lines', startIdx + 1, '-', endIdx + 1);
console.log('first:', lines[startIdx].trim().slice(0, 50));
console.log('last :', lines[endIdx].trim());

const compLedger = [
  '          // === 组件台账: 组件是独立单位, 但归属这艘舰 (per user request) ==========',
  '          // 两种拆挂架的方式: ① 玩家/友军直接打掉组件单位(单位自己 alive=false);',
  '          // ② 母舰血量掉档(每掉 1/6 血拆一个, 与老行为一致)。全毁 ⇒ 舰体爆炸 + 惯性坠落。',
  '          const comps = u.airComponents;',
  '          const compUnits = u.airComponentUnits;',
  '          if (comps) {',
  '            for (let i = 0; i < comps.length; i++) {',
  '              const cu = compUnits?.[i];',
  '              if (cu && (cu.compDetached || !cu.alive)) comps[i].alive = false;',
  '              comps[i].mesh.visible = comps[i].alive;',
  '            }',
  '            const want = Math.max(0, Math.ceil((u.hp / Math.max(1, u.maxHp)) * comps.length));',
  '            let aliveNow = comps.filter((c) => c.alive).length;',
  '            if (aliveNow > want) {',
  '              for (let i = comps.length - 1; i >= 0 && aliveNow > want; i--) {',
  '                if (!comps[i].alive) continue;',
  '                const cu = compUnits?.[i];',
  '                if (cu && !cu.compDetached) this.detachAirComponent(cu, false);',
  '                else { comps[i].alive = false; comps[i].mesh.visible = false; }',
  '                this.weapons.spawnExplosion(u.position.clone(), 2.2);',
  '                aliveNow--;',
  '              }',
  '            }',
  '            aliveNow = comps.filter((c) => c.alive).length;',
  '            if (aliveNow <= 0 || u.hp <= 0) {',
  '              // 6 个组件全毁 ⇒ 舰体爆炸 + 以原惯性坠落',
  '              u.falling = true;',
  '              if (u.velocity.y > 0) u.velocity.y = 0;',
  '              this.weapons.spawnExplosion(u.position.clone(), 7);',
  '              this.weapons.spawnExplosion(u.position.clone().add(new THREE.Vector3(0, 10, 0)), 5);',
  '            }',
  '          }',
].join('\n');

lines.splice(startIdx, endIdx - startIdx + 1, compLedger);
fs.writeFileSync(p, lines.join('\n'));
console.log('§227a ok');
