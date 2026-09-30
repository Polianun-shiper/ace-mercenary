// §230b(2): faceAnchor 接 HullFrame; applyStageLoadout 用 model.hullFrame; 新增 FBX 载入与建舰
const fs = require('fs');
const D = 'src/lib/game/dreadnought.ts';
function rep(a, b, label) {
  let s = fs.readFileSync(D, 'utf8');
  const n = s.split(a).length - 1;
  if (n === 0) { console.log('skip:', label); return; }
  if (n !== 1) { console.error('miss(' + n + '):', label); process.exit(1); }
  fs.writeFileSync(D, s.replace(a, b));
  console.log('ok:', label);
}

// ① DREADNOUGHT_SCALE 追加 x3
rep(`export const DREADNOUGHT_SCALE = Math.cbrt(3);`,
`export const DREADNOUGHT_SCALE = Math.cbrt(3) * 3;`,
 'DREADNOUGHT_SCALE x3');

// ② faceAnchor 支持自定义舰体盒
rep(`export function faceAnchor(face: MountFace, u: number, v: number): { pos: THREE.Vector3; normal: THREE.Vector3 } {
  const f = FACE_AXIS[face];
  const pos = new THREE.Vector3(f.off[0], f.off[1], f.off[2]);
  pos[f.a] += (u - 0.5) * f.as;
  pos[f.b] += (v - 0.5) * f.bs;
  return { pos, normal: new THREE.Vector3(f.n[0], f.n[1], f.n[2]) };
}`,
`export function faceAnchor(face: MountFace, u: number, v: number, frame?: HullFrame): { pos: THREE.Vector3; normal: THREE.Vector3 } {
  const f = FACE_AXIS[face];
  const fr = frame ?? defaultHullFrame();
  const half = fr.half;
  const size = (ax: 'x' | 'y' | 'z') => (ax === 'x' ? half.x : ax === 'y' ? half.y : half.z) * 2;
  const pos = fr.center.clone();
  pos[f.a] += (u - 0.5) * size(f.a);
  pos[f.b] += (v - 0.5) * size(f.b);
  // 面偏移: 顶/底沿 ±Y, 左/右沿 ±X, 艏/艉沿 ±Z
  if (face === 'top') pos.y += half.y;
  else if (face === 'bottom') pos.y -= half.y;
  else if (face === 'right') pos.x += half.x;
  else if (face === 'left') pos.x -= half.x;
  else if (face === 'front') pos.z += half.z;
  else pos.z -= half.z;
  return { pos, normal: new THREE.Vector3(f.n[0], f.n[1], f.n[2]) };
}`,
 'faceAnchor(frame)');

// ③ DreadnoughtModel 增加 hullFrame
rep(`  hull: { radius: number; half: THREE.Vector3 };
  /** 额外字段(引擎可不读): 建舰时的阵营, 供 applyStageLoadout 给重建的挂点配色 */
  ally?: boolean;`,
`  hull: { radius: number; half: THREE.Vector3 };
  /** 挂点摆放用的舰体盒(FBX 舰体只占模型底部时, 它与 hull.half 不同) */
  hullFrame: HullFrame;
  /** 额外字段(引擎可不读): 建舰时的阵营, 供 applyStageLoadout 给重建的挂点配色 */
  ally?: boolean;`,
 'model.hullFrame');

// ④ applyStageLoadout 用 model.hullFrame
rep(`    const { pos, normal } = faceAnchor(d.face, d.u, d.v);`,
`    const { pos, normal } = faceAnchor(d.face, d.u, d.v, model.hullFrame);`,
 'applyStageLoadout 用 hullFrame');

// ⑤ 程序化舰体返回 hullFrame
rep(`  return {
    group,
    components,
    hull: { radius: half.length() * 0.62, half },
    size: { len: s.len * scale, wid: s.wid * scale, hei: s.hei * scale },
    hullMat,
  };`,
`  return {
    group,
    mountRoot: group,          // 程序化舰体的挂点直接挂在 group 上(没有单独的容器)
    components,
    hull: { radius: half.length() * 0.62, half },
    hullFrame: { half: half.clone(), center: new THREE.Vector3(0, 0, 0) },
    size: { len: s.len * scale, wid: s.wid * scale, hei: s.hei * scale },
    hullMat,
  };`,
 'programmatic hullFrame');

fs.writeFileSync(D, fs.readFileSync(D, 'utf8'));
console.log('§230b-2 done');
