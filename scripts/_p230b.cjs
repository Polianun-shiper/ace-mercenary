// §230b: 主舰换成用户给的 FBX + 长宽高再 x3(含轻型), 并让挂点摆法支持"任意舰体盒"
const fs = require('fs');
const D = 'src/lib/game/dreadnought.ts';
function rep(file, a, b, label) {
  let s = fs.readFileSync(file, 'utf8');
  const n = s.split(a).length - 1;
  if (n === 0) { console.log('skip:', label); return; }
  if (n !== 1) { console.error('miss(' + n + ') ' + file + ':', label); process.exit(1); }
  fs.writeFileSync(file, s.replace(a, b));
  console.log('ok:', label);
}

// ① 体积倍率: 上一轮 cbrt(3) 之后再按"长宽高 x3"放大
rep(D, `export const DREADNOUGHT_SCALE = Math.cbrt(3);`,
`export const DREADNOUGHT_SCALE = Math.cbrt(3) * 3;`,
 'DREADNOUGHT_SCALE x3 追加');

rep(D, `/** 舰体尺寸(米, 已乘体积倍率)。长沿 Z、宽沿 X、高沿 Y —— 与引擎 heading 0 => +Z 的约定一致, 舰艏在 +Z */`,
`/** 舰体尺寸(米, 已乘倍率)。长沿 Z、宽沿 X、高沿 Y —— 与引擎 heading 0 => +Z 的约定一致, 舰艏在 +Z
 *  (per user request: 上一轮"体积 x3"之后, 这一轮再按**长宽高各 x3** -> 乘数 = cbrt(3) x 3 = 5.196,
 *   基础 900x240x160 于是变成约 4676x1247x831 米 —— 想整体回退就改上面那一个常量。) */`,
 'SIZE 注释更新');

// ② 面锚点支持自定义舰体盒(挂点摆法要能跟着 FBX 的真实包围盒走)
rep(D,
`const FACE_AXIS: Record<MountFace, { n: [number, number, number]; a: 'x' | 'y' | 'z'; as: number; b: 'x' | 'y' | 'z'; bs: number; off: [number, number, number] }> = {
  top:    { n: [0, 1, 0],  a: 'z', as: DREADNOUGHT_SIZE.len, b: 'x', bs: DREADNOUGHT_SIZE.wid, off: [0, DREADNOUGHT_SIZE.hei / 2, 0] },
  bottom: { n: [0, -1, 0], a: 'z', as: DREADNOUGHT_SIZE.len, b: 'x', bs: DREADNOUGHT_SIZE.wid, off: [0, -DREADNOUGHT_SIZE.hei / 2, 0] },
  left:   { n: [-1, 0, 0], a: 'z', as: DREADNOUGHT_SIZE.len, b: 'y', bs: DREADNOUGHT_SIZE.hei, off: [-DREADNOUGHT_SIZE.wid / 2, 0, 0] },
  right:  { n: [1, 0, 0],  a: 'z', as: DREADNOUGHT_SIZE.len, b: 'y', bs: DREADNOUGHT_SIZE.hei, off: [DREADNOUGHT_SIZE.wid / 2, 0, 0] },
  front:  { n: [0, 0, 1],  a: 'x', as: DREADNOUGHT_SIZE.wid, b: 'y', bs: DREADNOUGHT_SIZE.hei, off: [0, 0, DREADNOUGHT_SIZE.len / 2] },
  rear:   { n: [0, 0, -1], a: 'x', as: DREADNOUGHT_SIZE.wid, b: 'y', bs: DREADNOUGHT_SIZE.hei, off: [0, 0, -DREADNOUGHT_SIZE.len / 2] },
};`,
`/** 挂点所在的"舰体盒": 半边长 + 中心(y 方向往往不在原点 —— FBX 舰体只占模型底部一条,
 *  上半部分是桅杆/上层建筑, 武器不该摆到桅杆上去)。 */
export interface HullFrame {
  half: THREE.Vector3;
  center: THREE.Vector3;
}

const FACE_AXIS: Record<MountFace, { n: [number, number, number]; a: 'x' | 'y' | 'z'; b: 'x' | 'y' | 'z' }> = {
  top:    { n: [0, 1, 0],  a: 'z', b: 'x' },
  bottom: { n: [0, -1, 0], a: 'z', b: 'x' },
  left:   { n: [-1, 0, 0], a: 'z', b: 'y' },
  right:  { n: [1, 0, 0],  a: 'z', b: 'y' },
  front:  { n: [0, 0, 1],  a: 'x', b: 'y' },
  rear:   { n: [0, 0, -1], a: 'x', b: 'y' },
};

/** 默认舰体盒 = 程序化舰体(对称, 中心在原点)。 */
export function defaultHullFrame(): HullFrame {
  return {
    half: new THREE.Vector3(DREADNOUGHT_SIZE.wid / 2, DREADNOUGHT_SIZE.hei / 2, DREADNOUGHT_SIZE.len / 2),
    center: new THREE.Vector3(0, 0, 0),
  };
}`,
 'FACE_AXIS 简化 + HullFrame');

// ③ faceAnchor: 接 frame 参数
const faOld = fs.readFileSync(D, 'utf8').match(/export function faceAnchor\([\s\S]*?\n\}/);
if (!faOld) { console.error('faceAnchor body not found'); process.exit(1); }
console.log('faceAnchor 原文:'); console.log(faOld[0].slice(0, 400));
