// §227e: ① 速度表别再覆盖空中战舰的巡航速度; ② 组件世界坐标滞后一帧的问题(舰体矩阵当帧刷新)
const fs = require('fs');
const p = 'src/lib/game/engine.ts';
let s = fs.readFileSync(p, 'utf8');
function rep(a, b, label) {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.error('miss(' + n + '):', label); process.exit(1); }
  s = s.replace(a, b); console.log('ok:', label);
}

rep(`      } else if (u.type === 'air_light') {
        u.speed = 38;   // 空中战舰巡航速度(单位/秒)`,
`      } else if (u.type === 'air_light') {
        // 巡航速度走常量 —— 否则这张表每帧把提速改回旧值(提速 5 倍等于白改)
        u.speed = AIR_WARSHIP_SPEED;`,
 'speed table uses constant');

// 舰体分支末尾刷新自己的世界矩阵: 组件在**同一帧**里用 ship.group.matrixWorld 算世界坐标,
// 而 matrixWorld 平时只在渲染前统一更新 ⇒ 不刷新的话组件位置会滞后一帧(实测偏 7m ≈ 一帧位移)。
rep(`            aliveNow = comps.filter((c) => c.alive).length;
            if (aliveNow <= 0 || u.hp <= 0) {`,
`            aliveNow = comps.filter((c) => c.alive).length;
            // 舰体矩阵当帧刷新: 组件用它算世界坐标(不刷新就会滞后一帧, 高速时肉眼可见的"挂件拖后")
            u.group.updateMatrixWorld(true);
            if (aliveNow <= 0 || u.hp <= 0) {`,
 'ship matrixWorld refreshed for components');

fs.writeFileSync(p, s);
console.log('§227e ok');
