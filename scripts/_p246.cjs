// §246: ① 重开关卡后主舰变形/组件消失的根因: 建舰时**改的是缓存的模板对象**(scale/position 累积)
//          => 改成克隆一份再改。
//       ② 主舰碰撞盒等比缩小"一中圈"(常量, 一行可调)
const fs = require('fs');
function rep(file, a, b, label, all) {
  let s = fs.readFileSync(file, 'utf8');
  const n = s.split(a).length - 1;
  if (n === 0) { console.log('skip:', label); return; }
  if (!all && n !== 1) { console.error('miss(' + n + ') ' + file + ':', label); process.exit(1); }
  fs.writeFileSync(file, all ? s.split(a).join(b) : s.replace(a, b));
  console.log('ok:', label, all ? '(' + n + ')' : '');
}
const D = 'src/lib/game/dreadnought.ts';
const E = 'src/lib/game/engine.ts';

// ① 克隆模板
rep(D, `  const model = src;`,
`  // === 必须**克隆**一份再改 (per bug: 重开关卡后主舰变形、组件跑没、运镜找不到目标) ==========
  // loadBastionModel() 带缓存, 返回的是**同一个** Object3D 模板; 而下面要改它的 rotation/scale/position
  // (而且是 *= / -= 这种**相对**修改) —— 直接改模板会让这些变换**逐局累积**: 第二局舰体被
  // 又乘一次缩放、又偏一次位置, 于是越重开越大越歪, 挂在它身上的组件自然"不见了",
  // 过场相机也是按量出来的包围盒取景的, 目标一变就飞了。克隆之后模板永远干净。
  const model = src.clone(true);`,
 '克隆舰体模板');

// ② 碰撞盒缩小一中圈
rep(D, `/** 判定"这一层属于舰体"的水平半径阈值(占最大水平半径的比例) —— 桅杆细, 一眼能滤掉。 */`,
`/** === 碰撞盒相对舰体的收缩系数 (per user request: 碰撞盒等比缩小一中圈) =================
 *  0.8 = 每边缩 20%(观感"小一中圈"); 想再小就把这个数往下调(0.7 更小), 只影响**碰撞**,
 *  不影响挂点摆放与模型显示 —— 挂点仍然严格贴在甲板面上。 */
export const HULL_COLLIDE_SHRINK = 0.8;
/** 判定"这一层属于舰体"的水平半径阈值(占最大水平半径的比例) —— 桅杆细, 一眼能滤掉。 */`,
 '收缩系数常量');

// 碰撞判定按收缩系数(分段与整盒两条路径都覆盖)
rep(E, `          const frame = this.bossModel.hullFrame;
          const half = frame.half;`,
`          const frame = this.bossModel.hullFrame;
          // 碰撞盒按用户要求等比缩一圈(只影响碰撞判定, 不动挂点/模型)
          const half = frame.half.clone().multiplyScalar(HULL_COLLIDE_SHRINK);`,
 '碰撞盒收缩(整盒)');
rep(E, `            segHalfX = seg.hx; segHalfY = seg.hy;
            inBody = Math.abs(_bossLocal.x) < seg.hx && Math.abs(_bossLocal.y) < seg.hy;`,
`            segHalfX = seg.hx * HULL_COLLIDE_SHRINK;
            segHalfY = seg.hy * HULL_COLLIDE_SHRINK;
            inBody = Math.abs(_bossLocal.x) < segHalfX && Math.abs(_bossLocal.y) < segHalfY;`,
 '碰撞盒收缩(分段)');
rep(E, `  buildDreadnought, buildDreadnoughtFromModel, loadBastionModel, buildDrone, BASTION_STERN_SIGN,`,
`  buildDreadnought, buildDreadnoughtFromModel, loadBastionModel, buildDrone, BASTION_STERN_SIGN, HULL_COLLIDE_SHRINK,`,
 '导入收缩系数');
console.log('§246 done');
