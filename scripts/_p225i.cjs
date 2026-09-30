// s9: 算舰体在屏幕上的 NDC(不用全局 THREE, 直接借 Vector3.applyMatrix4 的透视除法)
const fs = require('fs');
const p = '.shots/airship3s.js';
let s = fs.readFileSync(p, 'utf8');
const anchor = "  // stage 7: 玩家锁定";
if (!s.includes(anchor)) { console.error('miss'); process.exit(1); }
const add = `  // stage 9: 报告舰体的屏幕位置(用于调截图机位)
  async s9() {
    const e = this.eng();
    const s = this.s2h;
    if (!s) return 'no-ship';
    const cam = e.camera.camera;
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const v = s.position.clone();
    const camDist = v.distanceTo(cam.position);
    v.applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
    const camFwd = cam.getWorldDirection(s.position.clone().set(0, 0, 0));
    const toShip = s.position.clone().sub(cam.position).normalize();
    return JSON.stringify({
      ndc: [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(3)],
      camDist: Math.round(camDist),
      dotFwd: +camFwd.dot(toShip).toFixed(3),
      camY: Math.round(cam.position.y),
      shipY: Math.round(s.position.y),
      playerY: Math.round(e.player.position.y),
      alive: s.alive,
      compsAlive: s.airComponents.filter(c => c.alive).length,
    });
  },
`;
s = s.replace(anchor, add + anchor);
fs.writeFileSync(p, s);
console.log('s9 added');
