// §227b: 剩下的四个接入点
const fs = require('fs');
const p = 'src/lib/game/engine.ts';
let s = fs.readFileSync(p, 'utf8');
function rep(a, b, label) {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.error('miss(' + n + '):', label); process.exit(1); }
  s = s.replace(a, b);
  console.log('ok:', label);
}

// 1) 通用阵亡路径: 组件不适用"空中单位改为坠落"的规则(它是挂件, 打完就消失)
rep("      if (u.hp <= 0 && u.alive && u.isAir) {\n        u.falling = true;",
    "      if (u.hp <= 0 && u.alive && u.isAir && !u.isComponent) {\n        u.falling = true;",
    'kill guard exempts components');

// 2) 通用阵亡路径的移除: 组件的父节点是舰体, 必须走 detachAirComponent
rep("        this.scene.remove(u.group);\n        // === Remove the laser beam visuals with the unit (per user request) ===\n        if (u.laserBeam) {",
    "        // 舰载组件挂在舰体 group 上, scene.remove 对它无效(只警告不摘除) —— 走专用摘除\n        if (u.isComponent) this.detachAirComponent(u, true);\n        else this.scene.remove(u.group);\n        // === Remove the laser beam visuals with the unit (per user request) ===\n        if (u.laserBeam) {",
    'generic kill detaches component');

// 3) 舰体触地消失时, 把剩下的组件一起清掉(不留孤儿目标在雷达上)
rep("            this.weapons.spawnExplosion(u.position.clone(), 9);\n            this.weapons.spawnExplosion(u.position.clone().add(new THREE.Vector3(0, 18, 0)), 6);\n            u.alive = false;\n            u.hp = 0;\n            this.scene.remove(u.group);",
    "            this.weapons.spawnExplosion(u.position.clone(), 9);\n            this.weapons.spawnExplosion(u.position.clone().add(new THREE.Vector3(0, 18, 0)), 6);\n            u.alive = false;\n            u.hp = 0;\n            this.scene.remove(u.group);\n            // 母舰消失 ⇒ 残余组件一并清除(否则雷达/锁定列表里会留下飘在空中的挂件)\n            if (u.airComponentUnits) {\n              for (const cu of u.airComponentUnits) if (!cu.compDetached) this.detachAirComponent(cu, true);\n            }",
    'ship removal clears components');

// 4) 地面单位互殴的碎伤不该去点高空的舰载组件
rep("        for (const other of this.groundUnits) {\n          if (!other.alive || other.isNeutral) continue;\n          if (other.isAlly === u.isAlly) continue; // same side",
    "        for (const other of this.groundUnits) {\n          if (!other.alive || other.isNeutral) continue;\n          // 舰载组件高挂在空中, 不该被地面/海面单位的碎伤点名\n          if (other.isComponent) continue;\n          if (other.isAlly === u.isAlly) continue; // same side",
    'chip damage skips components');

fs.writeFileSync(p, s);
console.log('§227b ok');
