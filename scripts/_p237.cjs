// §237: ① 后燃器朝向后端可翻转(按用户观察取反) ② 第一关加我方空中中队 ③ 体积再翻倍 ④ 后燃器不被远处的云遮住
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

// ---------- ① 后燃器朝后: FLIP 常量(按用户观察取反) ----------
rep(E, `  private ensureBossAfterburner(u: GroundUnit) {
    if (this.bossBurnerGroup) return;
    // 喷口位置: 舰体本地坐标里"最后面"的一点(按舰体盒半长取), 左右各一个
    const half = this.bossModel ? this.bossModel.hull.half : new THREE.Vector3(600, 400, 1900);
    const nozzles = [
      { pos: new THREE.Vector3(-half.x * 0.35, 0, -half.z * 0.98), radius: half.x * 0.16 },
      { pos: new THREE.Vector3(half.x * 0.35, 0, -half.z * 0.98), radius: half.x * 0.16 },
    ];`,
`  private ensureBossAfterburner(u: GroundUnit) {
    if (this.bossBurnerGroup) return;
    // === 喷口在哪一端: 用户实测"后燃器前后方向反了" => 按他的观察取反 =================
    // 我从 FBX 几何推的是"尖的一头是舰艏(+Z)", 于是把喷口放在 -Z; 但用户在实际画面里看到
    // 火焰长在舰艏那一端。以他的观察为准: 喷口改放 +Z 一端。若哪天发现又反了,
    // 把这个常量改成 -1 即可(只影响喷口所在的端, 不影响飞行方向/挂点/碰撞盒)。
    const bowIsMinusZ = true;
    const aftSign = bowIsMinusZ ? 1 : -1;
    const half = this.bossModel ? this.bossModel.hull.half : new THREE.Vector3(600, 400, 1900);
    const nz = half.z * 0.98 * aftSign;
    const nozzles = [
      { pos: new THREE.Vector3(-half.x * 0.35, 0, nz), radius: half.x * 0.16 },
      { pos: new THREE.Vector3(half.x * 0.35, 0, nz), radius: half.x * 0.16 },
    ];`,
 '后燃器端向可翻转');

// ---------- ② 后燃器不被云遮住(深度写入) ----------
rep(E, `    const grp = buildAfterburner(positions, metrics as never);
    u.group.add(grp);
    setAfterburner(grp, 1);
    this.bossBurnerGroup = grp;`,
`    const grp = buildAfterburner(positions, metrics as never);
    // === 别被远处的云盖住 (per user request: 后燃器被远处云层挡住, 遮挡关系错了) ======
    // 体积云是后处理 pass, 它按**场景深度**判断"云在前面还是后面"; 而火焰材质是加色混合、
    // depthWrite=false —— 深度图里没有它 => 云以为那里是天空, 于是把火焰盖掉。
    // 这里给主舰尾焰打开 depthWrite(它本来就在最前面, 不会跟别的透明体打架),
    // 于是深度图里留下火焰, 云的遮挡关系就正确了。只对主舰这组生效, 不动飞机尾焰。
    grp.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const mat = mesh.material as THREE.Material | undefined;
      if (mat) mat.depthWrite = true;
    });
    u.group.add(grp);
    setAfterburner(grp, 1);
    this.bossBurnerGroup = grp;`,
 '后燃器深度写入');

// ---------- ③ 体积再放大一倍(体积 x2 => 线度 x2^(1/3)) ----------
rep(D, `export const DREADNOUGHT_SCALE = Math.cbrt(3) * 3 * 2;`,
`// 体积 x3 -> 长宽高 x3 -> 模型翻倍 -> **这一轮体积再翻一倍** (per user request)
// 体积倍率走立方根(与 AIR_WARSHIP_SCALE 同一约定): cbrt(3) x 3 x 2 x cbrt(2) = 10.90,
// 基础 900x240x160 => 约 9813 x 2616 x 1744 米。
// (想要"线度再翻倍"就把 cbrt(2) 换成 2 => 15576 米。)
export const DREADNOUGHT_SCALE = Math.cbrt(3) * 3 * 2 * Math.cbrt(2);`,
 '体积再 x2');

// ---------- ④ 第一关加我方空中中队 ----------
rep(E, `    this.spawnBossMounts(1);        // 阶段 1 装载先摆好(武器要等阶段 1 才激活)
    this.spawnBossWing(12);         // 护航战斗机先行抵达`,
`    this.spawnBossMounts(1);        // 阶段 1 装载先摆好(武器要等阶段 1 才激活)
    this.spawnBossWing(12);         // 护航战斗机先行抵达
    // === 我方空中中队: 帮玩家吸引火力 (per user request: 第一关多给几个空中中队的友军) ==
    // 用和 T-00 同一套"友军中队"机制(spawnSquadron): 两个中队(共 8 架)在玩家侧后方展开,
    // 它们是真正的友军 AI(会自己找目标交战), 于是敌人"最多 3 个咬玩家"之外的注意力会分到
    // 它们身上 —— 正是用户要的效果。
    this.spawnSquadron(8);`,
 '我方空中中队');
console.log('§237 done');
