// §235a: 碰撞盒(和挂点盒)改成**从 FBX 几何量出来的舰体盒** —— 不再用写死的 30% 高度比例;
//        桅杆(细长刀片)自动被排除; 高度随模型缩放; 撞上掉血改成 10/秒。
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

rep(D, `/** 舰体层占模型总高的比例(桅杆不算甲板)。 */
const HULL_BAND = 0.30;`,
`/** 舰体层占模型总高的比例 —— **仅作为量不出几何时的兜底**(见 measureHullFrame)。
 *  实测 bastion.obj: 舰体占底部 27.5%, 上面 72% 全是一把细长刀片(桅杆/上层建筑, 水平半径 49 x 0.4),
 *  所以"用比例猜"和"用量出来的"差得不多, 但量出来的才是模型自己的碰撞盒。 */
const HULL_BAND = 0.30;
/** 判定"这一层属于舰体"的水平半径阈值(占最大水平半径的比例) —— 桅杆细, 一眼能滤掉。 */
const HULL_EXTENT_THRESHOLD = 0.45;`,
 'HULL_BAND 注释 + 阈值');

rep(D, `/** 从模型实际包围盒推出"挂点盒": 长/宽取满, 高只取底部一条, 且把盒子上移让顶面=甲板。 */
export function hullFrameFromObject(obj: THREE.Object3D): HullFrame {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const hei = size.y * HULL_BAND;
  const half = new THREE.Vector3(size.x / 2, hei / 2, size.z / 2);
  const center = new THREE.Vector3(
    (box.min.x + box.max.x) / 2,
    box.min.y + hei / 2,          // 贴住模型底部
    (box.min.z + box.max.z) / 2,
  );
  return { half, center };
}`,
`/**
 * 从模型的**几何本体**量出"舰体盒" (per user request: 碰撞盒直接用 fbx 的那个, 而不是之前的盒子)。
 *
 * 做法: 把顶点按 Y 分 40 层, 每层量水平半径(点到中轴的距离); 桅杆/上层建筑是**细长刀片**
 * (bastion 实测: 49 x 0.4 的水平半径), 所以"水平半径 >= 最大值的 45%"的那段**自下而上连续层**
 * 就是舰体 —— 顶面即甲板, 桅杆被自然排除。
 * 盒子取量出来的包络(长宽用舰体层自己的范围, 高度到甲板为止), 因此:
 *   · 它就是**这个 fbx 自己的碰撞盒**, 而不是程序化那版的 900x240x160;
 *   · 模型放大时盒子一起放大(所有尺寸都来自几何);
 *   · 桅杆不算在内。
 * 读不到几何(理论上不会)时回退到"底部 30% 高度"的经验值。
 */
export function hullFrameFromObject(obj: THREE.Object3D): HullFrame {
  const full = new THREE.Box3().setFromObject(obj);
  const fullSize = full.getSize(new THREE.Vector3());
  const pts: THREE.Vector3[] = [];
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    const p = m.geometry.attributes.position as THREE.BufferAttribute | undefined;
    if (!p) return;
    m.updateMatrixWorld(true);
    const step = Math.max(1, Math.floor(p.count / 4000));   // 大网格抽样(40 层量大势就够了)
    for (let i = 0; i < p.count; i += step) {
      pts.push(new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld));
    }
  });
  // 兜底: 拿不到顶点就按经验比例
  if (pts.length < 32) {
    const hei = fullSize.y * HULL_BAND;
    return {
      half: new THREE.Vector3(fullSize.x / 2, hei / 2, fullSize.z / 2),
      center: new THREE.Vector3((full.min.x + full.max.x) / 2, full.min.y + hei / 2, (full.min.z + full.max.z) / 2),
    };
  }
  const minY = full.min.y, spanY = Math.max(1e-3, fullSize.y);
  const N = 40;
  const bandH = spanY / N;
  const slabR: number[] = new Array(N).fill(0);
  for (const v of pts) {
    const k = Math.min(N - 1, Math.max(0, Math.floor((v.y - minY) / bandH)));
    const r = Math.hypot(v.x - (full.min.x + full.max.x) / 2, v.z - (full.min.z + full.max.z) / 2);
    if (r > slabR[k]) slabR[k] = r;
  }
  const maxR = Math.max(...slabR, 1e-3);
  let topBand = 0;
  for (let i = 0; i < N; i++) {
    if (slabR[i] >= maxR * HULL_EXTENT_THRESHOLD) topBand = i; else break;   // 连续层, 遇到细层就停
  }
  const hullTopY = minY + (topBand + 1) * bandH;
  // 舰体层的 X/Z 包络(只统计舰体层内的点)
  const bx = new THREE.Box3();
  for (const v of pts) if (v.y <= hullTopY) bx.expandByPoint(v);
  const half = new THREE.Vector3(
    Math.max(1e-3, (bx.max.x - bx.min.x) / 2),
    Math.max(1e-3, (hullTopY - minY) / 2),
    Math.max(1e-3, (bx.max.z - bx.min.z) / 2),
  );
  const center = new THREE.Vector3(
    (bx.min.x + bx.max.x) / 2,
    minY + half.y,                 // 贴住模型底部
    (bx.min.z + bx.max.z) / 2,
  );
  return { half, center };
}`,
 '几何量框');

rep(E, `            this.playerHp -= 45 * dt;`,
`            this.playerHp -= 10 * dt;     // per user request: 撞舰体改成 10/秒`,
 '撞舰掉血 10/秒');
