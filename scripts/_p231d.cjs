// §231d: 偏航舵铰链改成"紧邻舵面的那条斜边"(不是竖直的后缘线)
//  · models.ts: 量出舵面前缘的倾斜角, 把铰链点放到该斜边在舵面高度中心处, 并把**铰链轴**存到
//    mesh.userData.hingeAxis(单位向量) —— 这样舵面绕真正的斜边转, 而不是绕一条竖直轴自转。
//  · engine.ts: 驱动舵面时优先用 hingeAxis 走四元数(没有该字段的老路径仍走 rotation.y)。
const fs = require('fs');
function rep(file, a, b, label, all) {
  let s = fs.readFileSync(file, 'utf8');
  const n = s.split(a).length - 1;
  if (n === 0) { console.log('skip:', label); return; }
  if (!all && n !== 1) { console.error('miss(' + n + ') ' + file + ':', label); process.exit(1); }
  fs.writeFileSync(file, all ? s.split(a).join(b) : s.replace(a, b));
  console.log('ok:', label, all ? '(' + n + ')' : '');
}
const M = 'src/lib/game/models.ts';
const E = 'src/lib/game/engine.ts';

// ① 铰链计算: 前缘线倾角 + 铰链点 + hingeAxis
rep(M, `  const setupHinge = (meshes: THREE.Mesh[], axis: 'x' | 'y') => {
    if (!meshes.length) return;
    const bb = new THREE.Box3();
    for (const m of meshes) bb.expandByObject(m);
    const bbCenter = bb.getCenter(new THREE.Vector3());
    const hingeZ = bb.max.z; // 后缘(与 MiG-29 的取法一致)
    for (const m of meshes) {
      const mb = new THREE.Box3().setFromObject(m);
      const mbCenter = mb.getCenter(new THREE.Vector3());
      const pivot = new THREE.Vector3();
      if (axis === 'x') pivot.set(bbCenter.x, mbCenter.y, hingeZ);
      else pivot.set(mbCenter.x, bbCenter.y, hingeZ);
      m.geometry.translate(-pivot.x, -pivot.y, -pivot.z);
      m.position.copy(pivot);
      m.geometry.computeBoundingSphere();
    }
    out.hingeCount++;
  };`,
`  const setupHinge = (meshes: THREE.Mesh[], axis: 'x' | 'y') => {
    if (!meshes.length) return;
    const bb = new THREE.Box3();
    for (const m of meshes) bb.expandByObject(m);
    const bbCenter = bb.getCenter(new THREE.Vector3());
    const hingeZ = bb.max.z; // 后缘(与 MiG-29 的取法一致)

    // === 偏航舵: 铰链是"紧邻舵面的那条**斜边**" (per user request) ================
    // 这两架的垂尾都是后掠的, 舵面铰链线并不竖直 —— 早期实现一律绕竖直轴(穿过后缘)转,
    // 因此舵面看起来是"整片平移+自转"。这里先从舵面顶点量出前缘线的倾斜角:
    //   取 z 最小的顶点(前缘最低点) 与 上半段里 z 最小的顶点(前缘较高处), 两点连线 => 倾角。
    // 然后把铰链点放到这条斜边在**本片高度中心**处的位置, 并把铰链轴(单位向量)写进
    // mesh.userData.hingeAxis, 由引擎用四元数驱动(见 engine 的舵面驱动段)。
    let tilt = 0;
    let leadZ0 = 0, leadY0 = 0, leadDzDy = 0;
    if (axis === 'y') {
      let lowY = Infinity, highY = -Infinity;
      for (const m of meshes) {
        const p = m.geometry.attributes.position;
        for (let i = 0; i < p.count; i++) {
          const y = p.getY(i);
          if (y < lowY) lowY = y;
          if (y > highY) highY = y;
        }
      }
      let aZ = Infinity, aY = 0;       // 前缘最低点
      let bZ = Infinity, bY = 0;       // 上半段前缘点
      const midY = (lowY + highY) / 2;
      for (const m of meshes) {
        const p = m.geometry.attributes.position;
        for (let i = 0; i < p.count; i++) {
          const y = p.getY(i), z = p.getZ(i);
          if (z < aZ) { aZ = z; aY = y; }
          if (y >= midY && z < bZ) { bZ = z; bY = y; }
        }
      }
      if (isFinite(aZ) && isFinite(bZ) && Math.abs(bY - aY) > 1e-4) {
        tilt = Math.atan2(bZ - aZ, bY - aY);
        leadZ0 = aZ;
        leadY0 = aY;
        leadDzDy = (bZ - aZ) / (bY - aY);
      }
    }
    const hingeAxisDir = new THREE.Vector3(0, Math.cos(tilt), Math.sin(tilt)).normalize();

    for (const m of meshes) {
      const mb = new THREE.Box3().setFromObject(m);
      const mbCenter = mb.getCenter(new THREE.Vector3());
      const pivot = new THREE.Vector3();
      if (axis === 'x') {
        pivot.set(bbCenter.x, mbCenter.y, hingeZ);
      } else if (leadDzDy !== 0) {
        // 斜边铰链: 在**本片高度中心**处沿前缘线取点(z 由前缘线线性外推)
        pivot.set(mbCenter.x, mbCenter.y, leadZ0 + (mbCenter.y - leadY0) * leadDzDy);
      } else {
        pivot.set(mbCenter.x, bbCenter.y, hingeZ);
      }
      m.geometry.translate(-pivot.x, -pivot.y, -pivot.z);
      m.position.copy(pivot);
      m.geometry.computeBoundingSphere();
      if (axis === 'y') {
        (m.userData as { hingeAxis?: THREE.Vector3 }).hingeAxis = hingeAxisDir.clone();
      }
    }
    out.hingeCount++;
  };`,
 'setupHinge 斜边铰链');

// ② 引擎驱动: 优先四元数绕 hingeAxis
rep(E, `      for (const r of this._migSurfaces.rudders) {
        r.rotation.y = this.ctrlYaw * 0.45;
      }`,
`      for (const r of this._migSurfaces.rudders) {
        // 绕**斜边铰链轴**转(见 models.ts setupHinge); 没有该字段就退回老的绕 Y
        const ax = (r.userData as { hingeAxis?: THREE.Vector3 }).hingeAxis;
        if (ax) r.quaternion.setFromAxisAngle(ax, this.ctrlYaw * 0.45);
        else r.rotation.y = this.ctrlYaw * 0.45;
      }`,
 'MiG-29 舵面斜边铰链');

rep(E, `      for (const r of S.rudders) {
        r.rotation.y = this.ctrlYaw * 0.45;
      }`,
`      for (const r of S.rudders) {
        // === F-16C 偏航舵绕"紧邻舵面的斜边"转 (per user request) ==================
        // 早期是绕竖直轴(穿过后缘)自转; 现在用 models.ts 量出的斜边铰链轴走四元数。
        const ax = (r.userData as { hingeAxis?: THREE.Vector3 }).hingeAxis;
        if (ax) r.quaternion.setFromAxisAngle(ax, this.ctrlYaw * 0.45);
        else r.rotation.y = this.ctrlYaw * 0.45;
      }`,
 'F-16C 舵面斜边铰链');
console.log('§231d done');
