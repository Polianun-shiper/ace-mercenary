// §241: ① 主舰前进方向翻转(单一常量) + 尾焰随之摆到艉端并朝外
//       ② 末阶段速度再 x2  ③ 开局刷 5 艘友军空中战舰(导弹型/防空炮型) ④ 死了刷新
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
const AW = 'src/lib/game/air-warship.ts';

// ---------- ① 主舰朝向: 单一常量 ----------
rep(D, `  const model = src;
  // 1) 摆正: 长轴 X -> Z
  model.rotation.y = -Math.PI / 2;`,
`  const model = src;
  // 1) 摆正: 长轴 X -> Z
  // === 舰艏朝哪一头 (per user request: 主舰的前后前进方向反了) =====================
  // 我用几何量出来的结论是"模型的尖头在 +X", -90 度把它转到 +Z(引擎的机头方向);
  // 但用户在画面里看到舰体是"倒着飞" => 换成 +90 度, 让**另一头**朝前。
  // 两个值都试过: BASTION_YAW = -PI/2(尖头朝前) / +PI/2(尖头朝后)。改这一处即可,
  // 后燃器的艉端与喷向会自动跟着走(见 engine 里 BASTION_STERN_SIGN 的推导)。
  model.rotation.y = BASTION_YAW;`,
 '主舰朝向常量');
rep(D, `export const BASTION_FBX = '/models/airship/bastion.fbx';`,
`/** 模型朝向修正(弧度): 见 buildDreadnoughtFromModel 里的说明。 */
export const BASTION_YAW = Math.PI / 2;
/** 舰艉在世界/舰体本地空间的那一侧(+1 = +Z, -1 = -Z)。艏在 +Z 时艉就是 -Z。
 *  后燃器摆在哪一端、往哪喷, 全部由它推导 —— 这样"翻朝向"只需要改 BASTION_YAW 一处。 */
export const BASTION_STERN_SIGN = -1;
export const BASTION_FBX = '/models/airship/bastion.fbx';`,
 '朝向常量导出');

// 引擎: 艉端/喷向跟着 BASTION_STERN_SIGN
rep(E, `    // === 喷口在哪一端: 用户实测"后燃器前后方向反了" => 按他的观察取反 =================
    // 我从 FBX 几何推的是"尖的一头是舰艏(+Z)", 于是把喷口放在 -Z; 但用户在实际画面里看到
    // 火焰长在舰艏那一端。以他的观察为准: 喷口改放 +Z 一端。若哪天发现又反了,
    // 把这个常量改成 -1 即可(只影响喷口所在的端, 不影响飞行方向/挂点/碰撞盒)。
    const bowIsMinusZ = true;
    const aftSign = bowIsMinusZ ? 1 : -1;
    const half = this.bossModel ? this.bossModel.hull.half : new THREE.Vector3(600, 400, 1900);
    const nz = half.z * 0.98 * aftSign;`,
`    // === 喷口在**舰艉**那一端 (端向由 BASTION_STERN_SIGN 推导, 与舰体朝向同源) ========
    const sternSign = BASTION_STERN_SIGN;
    const half = this.bossModel ? this.bossModel.hull.half : new THREE.Vector3(600, 400, 1900);
    const nz = half.z * 0.98 * sternSign;`,
 '艉端推导');
rep(E, `      if (c.userData && c.userData.role === 'flame') {
        // 探针实测(修复前): 火焰在 -Z 端 且 锥尖朝 +Z —— 也就是'贴着舰体往船里喷'。
        // 喷口在 +Z 端, 所以只要把锥尖翻到 +Z(朝外), 位置保持 +Z 端即可 => 向外喷。
        c.rotation.x += Math.PI;
      }`,
`      if (c.userData && c.userData.role === 'flame') {
        // 火焰锥默认朝 -Z 喷。艉在 -Z 时(默认情形)不用转; 艉在 +Z 时整束翻 180 度 => 一律朝舰体外。
        if (BASTION_STERN_SIGN > 0) c.rotation.x += Math.PI;
      }`,
 '喷向按艉端推导');
rep(E, `  buildAirWarship, makeAirWarshipMotion, updateAirWarshipMotion,`,
`  buildAirWarship, makeAirWarshipMotion, updateAirWarshipMotion,`,
 'noop');
rep(E, `import {
  buildDreadnought, buildDreadnoughtFromModel, loadBastionModel, buildDrone,`,
`import {
  buildDreadnought, buildDreadnoughtFromModel, loadBastionModel, buildDrone, BASTION_STERN_SIGN,`,
 '导入 STERN_SIGN');

// ---------- ② 末阶段速度 x2 ----------
rep(D, `  final: 25, escape: 210,`, `  final: 25, escape: 420,   // per user request: 末阶段速度再翻两倍`, '逃逸速度 x2');

// ---------- ③ 友军空中战舰两种型号 ----------
rep(AW, `export function buildAirWarship(isAlly: boolean, scale = 1): AirWarshipModel {`,
`/** 我方空中战舰的两种配置 (per user request: 有多个导弹发射器的, 也有多个防空炮的) */
export type AirWarshipVariant = 'missile' | 'gun';

export function buildAirWarship(isAlly: boolean, scale = 1, variant: AirWarshipVariant = 'missile'): AirWarshipModel {`,
 'buildAirWarship variant 参数');
rep(AW, `  const allyDefs: { normal: THREE.Vector3; kind: AirWarshipComponentKind; pos: THREE.Vector3 }[] = [`,
`  // 我方"防空炮型": 六个挂点全是机炮塔(上 4 + 下 2), 负责给主舰与友舰打伞;
  // 我方"导弹型"(默认): 六个挂点全是发射箱, 负责反舰齐射。两种混编出场。
  const allyGunDefs: { normal: THREE.Vector3; kind: AirWarshipComponentKind; pos: THREE.Vector3 }[] = [
    { normal: new THREE.Vector3(0, 1, 0), kind: 'gun', pos: new THREE.Vector3(0, s.hei / 2, s.len * 0.32) },
    { normal: new THREE.Vector3(0, 1, 0), kind: 'gun', pos: new THREE.Vector3(-s.wid * 0.30, s.hei / 2, s.len * 0.12) },
    { normal: new THREE.Vector3(0, 1, 0), kind: 'gun', pos: new THREE.Vector3(s.wid * 0.30, s.hei / 2, s.len * 0.12) },
    { normal: new THREE.Vector3(0, 1, 0), kind: 'gun', pos: new THREE.Vector3(0, s.hei / 2, -s.len * 0.22) },
    { normal: new THREE.Vector3(0, -1, 0), kind: 'gun', pos: new THREE.Vector3(-s.wid * 0.28, -s.hei / 2, s.len * 0.05) },
    { normal: new THREE.Vector3(0, -1, 0), kind: 'gun', pos: new THREE.Vector3(s.wid * 0.28, -s.hei / 2, s.len * 0.05) },
  ];
  const allyDefs: { normal: THREE.Vector3; kind: AirWarshipComponentKind; pos: THREE.Vector3 }[] = [`,
 '防空炮型挂点表');
rep(AW, `  const defs: { normal: THREE.Vector3; kind: AirWarshipComponentKind; pos: THREE.Vector3 }[] = isAlly ? allyDefs : [`,
`  const defs: { normal: THREE.Vector3; kind: AirWarshipComponentKind; pos: THREE.Vector3 }[] = isAlly
    ? (variant === 'gun' ? allyGunDefs : allyDefs)
    : [`,
 '按型号选表');
console.log('§241 1/2 done');
