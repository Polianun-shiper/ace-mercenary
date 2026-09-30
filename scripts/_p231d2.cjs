// §231d(2): 舵面铰链轴的量法换成"最远点对"(更稳)。按 y 分带量前缘在 F-16C 的 OBJ 上量不出倾角
// (探针实测 tiltDeg = 0), 而舵面是一块细长板 => **最长方向就是铰链方向**; 铰链点取"前缘顶点在
// 该方向直线上的投影", 于是铰链正好落在紧邻舵面的那条斜边上。
const fs = require('fs');
const M = 'src/lib/game/models.ts';
let s = fs.readFileSync(M, 'utf8');
const a = s.indexOf('    let tilt = 0;');
const b = s.indexOf('    const hingeAxisDir = new THREE.Vector3(0, Math.cos(tilt), Math.sin(tilt)).normalize();');
if (a < 0 || b < 0) { console.error('anchor miss'); process.exit(1); }
const NEW = `    // === 偏航舵: 铰链 = "紧邻舵面的那条斜边" (per user request) ==================
    // 早先的实现一律绕竖直轴(穿过后缘)转, 于是舵面看着像"整片平移 + 自转"。
    // 量法: 取舵面顶点的**最远点对** —— 舵面是一块细长板, 最长方向就是它的展向 =
    // 铰链方向(后掠垂尾上这条线自然就是斜的); 再把**前缘顶点**(z 最小)投影到这条直线上,
    // 得到铰链点(正好在紧邻舵面的斜边上)。比按 y 分带量前缘稳得多(那种量法在 F-16C 的
    // OBJ 上实测倾角 = 0, 因为它按部件建的面片并不沿坐标轴排布)。
    const hingeDir = new THREE.Vector3(0, 1, 0);
    const hingePoint = new THREE.Vector3();
    if (axis === 'y') {
      const pts: THREE.Vector3[] = [];
      for (const m of meshes) {
        const p = m.geometry.attributes.position;
        const step = Math.max(1, Math.floor(p.count / 600));   // 大网格抽样, 小网格全取
        for (let i = 0; i < p.count; i += step) pts.push(new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)));
      }
      if (pts.length >= 2) {
        let best = -1, v1 = pts[0], v2 = pts[1];
        for (let i = 0; i < pts.length; i++) {
          for (let j = i + 1; j < pts.length; j++) {
            const d = pts[i].distanceToSquared(pts[j]);
            if (d > best) { best = d; v1 = pts[i]; v2 = pts[j]; }
          }
        }
        hingeDir.copy(v2).sub(v1);
        if (hingeDir.lengthSq() > 1e-8) {
          hingeDir.normalize();
          if (hingeDir.y < 0) hingeDir.negate();     // 约定 +Y 朝上, 符号才稳定
        }
        // 前缘顶点(z 最小)在铰链方向直线上的投影 = 铰链点
        let lead = pts[0];
        for (const p of pts) if (p.z < lead.z) lead = p;
        const t = lead.clone().sub(v1).dot(hingeDir);
        hingePoint.copy(v1).addScaledVector(hingeDir, t);
      }
    }
    const tilt = Math.acos(THREE.MathUtils.clamp(hingeDir.y, -1, 1));
    const tiltDeg = THREE.MathUtils.radToDeg(tilt);
    void tiltDeg;
`;
s = s.slice(0, a) + NEW + s.slice(b);
// hingeAxis 用新的 hingeDir(原来的构造式保留, 只是方向来源换了)
s = s.replace('    const hingeAxisDir = new THREE.Vector3(0, Math.cos(tilt), Math.sin(tilt)).normalize();',
              '    const hingeAxisDir = hingeDir.clone().normalize();');
// 铰链点: 偏航舵用 hingePoint(不再是"按高度外推"), 其余面保持原样
s = s.replace(`      } else if (leadDzDy !== 0) {
        // 斜边铰链: 在**本片高度中心**处沿前缘线取点(z 由前缘线线性外推)
        pivot.set(mbCenter.x, mbCenter.y, leadZ0 + (mbCenter.y - leadY0) * leadDzDy);
      } else {`,
`      } else if (axis === 'y') {
        // 斜边铰链: 铰链点由"前缘顶点在铰链方向上的投影"给出(见上)
        pivot.copy(hingePoint);
      } else {`);
fs.writeFileSync(M, s);
console.log('§231d-2 ok');
