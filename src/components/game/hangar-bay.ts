// ==== 机库内景(3D 布景) =====================================================
// 用途: 战机准备界面的背景 —— 一个可信的机务维修机棚, 而不是"机体漂在黑色虚空里":
//   地坪   混凝土大板 + 牵引中线 + 黄色安全边界 + 格栅工作区 + 危险条纹区
//   墙体   大板缝墙板 + 危险条纹检修门 + 卷帘大门 + 管线/线槽/通风管/配电箱
//   顶棚   外露桁架 + 吊车轨/电动葫芦 + 发光灯具板(多排) + 墙面洗墙灯带
//   道具   工具车/抽屉柜、货箱与托盘、脚手架、移动发电机、灭火器点、
//          油桶、安全锥、工作台、地插与电缆、机棚柱
//
// 为什么单独一个文件: hangar.ts 里已经有"相机 / 输入 / 模型加载 / 显存回收"四大块,
// 布景代码再塞进去那个类就没法读了。这里只依赖 three, 完全自包含。
//
// 性能约定(机库是菜单, 不是关卡):
//   1) 同材质的重复盒体/圆柱一律走 InstancedMesh —— 上百个盒子若各自一个 Mesh,
//      draw call 会翻好几倍; 整个机库额外 draw call 控制在 ~90(远低于 150);
//   2) 贴图全部用 canvas 现画(混凝土/墙板/危险条纹/接触阴影), 不引外部资源;
//   3) 本模块不参与渲染循环, 循环里也不会 new 任何东西(纯静态布景)。
//
// 显存回收: 本模块产出的全部是普通 Mesh / InstancedMesh, 材质只把贴图放在
// map 槽(不碰 lightMap/bumpMap 等 hangar.ts 不认的槽位), 所以 HangarViewer.detach()
// 里那段"遍历场景 → dispose 几何 + dispose 材质及 map/normalMap/..."已经覆盖,
// 机库退出时格栅、墙板贴图会一起释放, 不需要额外写 dispose 代码。

import * as THREE from 'three';

/** 机库净高(地坪到顶棚板下沿)。hangar.ts 的轨道相机与"跟拍主光"要按它夹高度:
 *  有了顶棚以后, 相机拉到最远 + 俯仰抬到最高会跑到屋面板外面去(画面里只剩屋顶),
 *  夹一下高度就永远留在舱内。 */
export const HANGAR_BAY_CEIL_Y = 28;

/** 地坪标高 —— 与改造前同一高度(原来那面 CircleGeometry 地坪也在 y = -5):
 *  机体不改位, 机位/取景/轨道半径全部沿用原有数值。 */
export const HANGAR_BAY_FLOOR_Y = -5;

/** 机库半宽/半深。必须 >= 相机最远轨道半径(滚轮夹到 90): 相机水平轨道半径
 *  = dist * cos(pitch) <= 90, 所以半宽 92 的方舱能装下整条轨道, 拉远了也不会
 *  穿到墙外面去看背板。 */
const HX = 92;
const HZ = 92;
/** 墙厚 */
const T = 1.6;

/** 布景构建结果。lights 只是给调用方留个句柄(统计/调参用), 灯本身已经挂进 root。 */
export interface HangarBay {
  root: THREE.Group;
  lights: THREE.Light[];
}

// ---------------------------------------------------------------- 小工具 ----

/** 确定性伪随机(不用 Math.random: 机库每次打开的地坪噪点/油渍位置要一致,
 *  否则"每次进机库地面都在变", 也便于截图对比验收)。 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas2d(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function finishTex(c: HTMLCanvasElement, rx: number, ry: number): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // 颜色贴图必须标 sRGB: 渲染器 outputColorSpace = SRGBColorSpace, 不标的贴图
  // 会被当成线性数据, 画面整体发灰发暗(这是 three r152+ 的常见踩坑点)。
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.repeat.set(rx, ry);
  return tex;
}

/** 混凝土地坪: 骨料噪点 + 分格缝 + 淡油渍。一格 = 12.5 世界单位(约 6 m)。 */
function makeConcreteTexture(): THREE.CanvasTexture {
  const S = 512;
  const [cv, ctx] = canvas2d(S, S);
  // 底色直接就是"最终反照率", 材质 color 保持白色 —— 地坪明暗只有这一处可调,
  // 避免出现"贴图 x 材质色"叠暗(改一个地方看不出来是谁在压暗)。
  ctx.fillStyle = '#6d737b';
  ctx.fillRect(0, 0, S, S);
  const rng = makeRng(20240919);
  for (let i = 0; i < 24000; i++) {
    const g = rng() < 0.5 ? 88 + rng() * 34 : 118 + rng() * 62;
    ctx.fillStyle = `rgba(${g | 0},${(g + 3) | 0},${(g + 9) | 0},${(0.08 + rng() * 0.22).toFixed(3)})`;
    ctx.fillRect(rng() * S, rng() * S, 1 + rng() * 3, 1 + rng() * 3);
  }
  // 分格缝: 两道竖缝 + 两道横缝(缝宽 3px), 缝一侧补一条浅色倒角高光,
  // 看起来才像"切下去的缝"而不是"画上去的线"。
  for (const t of [0, 0.5]) {
    const x = t * S;
    ctx.fillStyle = 'rgba(38,42,48,0.9)';
    ctx.fillRect(x - 1.5, 0, 3, S);
    ctx.fillStyle = 'rgba(150,158,168,0.25)';
    ctx.fillRect(x + 1.5, 0, 1.5, S);
    const y = t * S;
    ctx.fillStyle = 'rgba(38,42,48,0.9)';
    ctx.fillRect(0, y - 1.5, S, 3);
    ctx.fillStyle = 'rgba(150,158,168,0.25)';
    ctx.fillRect(0, y + 1.5, S, 1.5);
  }
  // 油渍/水痕: 很淡的深色圆斑, 让地面有"用过"的痕迹(纯噪点会显得太均匀)
  for (let i = 0; i < 16; i++) {
    const x = rng() * S, y = rng() * S, r = 12 + rng() * 46;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(24,26,30,0.30)');
    g.addColorStop(1, 'rgba(24,26,30,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return finishTex(cv, 15, 15);
}

/** 墙板: 大板缝 + 铆钉 + 底部踢脚漆带 + 竖向污痕。一格 = 40 世界单位(约 20 m)。 */
function makeWallTexture(): THREE.CanvasTexture {
  const S = 512;
  const [cv, ctx] = canvas2d(S, S);
  ctx.fillStyle = '#454e59';
  ctx.fillRect(0, 0, S, S);
  const rng = makeRng(775533);
  for (let i = 0; i < 9000; i++) {
    const g = 62 + rng() * 46;
    ctx.fillStyle = `rgba(${g | 0},${(g + 4) | 0},${(g + 12) | 0},${(0.06 + rng() * 0.16).toFixed(3)})`;
    ctx.fillRect(rng() * S, rng() * S, 1 + rng() * 4, 1 + rng() * 4);
  }
  // 大板缝: 一格画 2 条竖缝 + 2 条横缝 ⇒ 板宽 20 m / 板高约 8 m, 是"大板"而不是砖缝
  const seam = (x0: number, y0: number, x1: number, y1: number) => {
    ctx.strokeStyle = 'rgba(30,35,42,0.95)';
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.strokeStyle = 'rgba(160,172,186,0.22)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0 + 4, y0 + 4); ctx.lineTo(x1 + 4, y1 + 4); ctx.stroke();
  };
  for (const x of [0, 256]) seam(x, 0, x, S);
  for (const y of [140, 396]) seam(0, y, S, y);
  // 铆钉: 沿缝点两排小圆点
  ctx.fillStyle = 'rgba(178,188,200,0.35)';
  for (let i = 0; i < S; i += 16) {
    for (const x of [8, 248]) { ctx.beginPath(); ctx.arc(x, i, 1.6, 0, Math.PI * 2); ctx.fill(); }
  }
  // 底部踢脚漆带(canvas 的下沿 = 墙面下沿, 见 flipY): 深色漆 + 一条黄线,
  // 远看就是"墙根刷了一条警戒色", 给整面墙一个落地的收口。
  ctx.fillStyle = '#333c47';
  ctx.fillRect(0, S - 96, S, 96);
  ctx.fillStyle = '#c9a02c';
  ctx.fillRect(0, S - 100, S, 6);
  // 竖向污痕(雨水/油污)从缝口往下带一点, 破掉"整面新墙"的假
  for (let i = 0; i < 26; i++) {
    const x = rng() * S;
    const g = ctx.createLinearGradient(0, 0, 0, 120 + rng() * 200);
    g.addColorStop(0, 'rgba(22,26,32,0.30)');
    g.addColorStop(1, 'rgba(22,26,32,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, 1 + rng() * 7, 120 + rng() * 200);
  }
  return finishTex(cv, 4.7, 0.83);
}

/** 危险条纹(黄黑斜纹): 用作检修门框、卷帘门底梁、地面危险区。 */
function makeHazardTexture(): THREE.CanvasTexture {
  const S = 128;
  const [cv, ctx] = canvas2d(S, S);
  ctx.fillStyle = '#14171c';
  ctx.fillRect(0, 0, S, S);
  ctx.save();
  ctx.translate(S / 2, S / 2);
  ctx.rotate(-Math.PI / 4);
  ctx.fillStyle = '#dfb42a';
  // 从 -8 到 8 条: 斜纹带跨过整个旋转后的方形范围, 保证贴图四角都被覆盖
  for (let i = -8; i < 8; i++) ctx.fillRect(i * 24, -S * 1.5, 12, S * 3);
  ctx.restore();
  return finishTex(cv, 3.5, 2);
}

/** 机体接触阴影: 径向渐变(中心深、边缘化开)。和真阴影贴图比, 这个方案
 *  成本是一张贴图 + 一个面片, 而且**不会因为机体换型/相机绕圈而失效** ——
 *  机体在机库里始终位于原点、也不自转(转的是相机), 静态软阴影完全够用,
 *  也就省掉了整条 shadowMap 管线(见文件末尾灯光注释里的取舍说明)。 */
function makeContactShadowTexture(): THREE.CanvasTexture {
  const S = 256;
  const [cv, ctx] = canvas2d(S, S);
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.60)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.34)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 一条实例的摆放: 位置 / 缩放 / 可选欧拉角。基础几何是"单位盒(1x1x1)"或
 *  "单位柱(直径 1、高 1)", 所以 s 就是该件的真实尺寸。 */
type Pl = { p: [number, number, number]; s: [number, number, number]; r?: [number, number, number] };

/** 把同材质的多个实例压进一个 InstancedMesh。
 *  为什么这么写: 机库道具全是"盒子 + 盒子 + 盒子", 逐个 Mesh 的话光是螺栓、
 *  抽屉、格栅条就能堆出几百个 draw call; 合并成实例后每种材质基本只有 1 个。
 *  注意 frustumCulled = false: three 的 InstancedMesh 只按"基础几何"算包围球,
 *  不按实例矩阵算, 一旦被误剔除整排道具会突然消失 —— 布景不差那点剔除收益。 */
function instanced(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  list: Pl[],
  name: string,
): THREE.InstancedMesh | null {
  if (list.length === 0) return null;
  const im = new THREE.InstancedMesh(geo, mat, list.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();
  list.forEach((it, i) => {
    e.set(it.r?.[0] ?? 0, it.r?.[1] ?? 0, it.r?.[2] ?? 0);
    q.setFromEuler(e);
    im.setMatrixAt(i, m.compose(v.set(it.p[0], it.p[1], it.p[2]), q, sc.set(it.s[0], it.s[1], it.s[2])));
  });
  im.instanceMatrix.needsUpdate = true;
  im.frustumCulled = false;
  im.name = name;
  return im;
}

// ------------------------------------------------------------ 布景主体 ----

/** 构建整个机库内景。返回的 root 里已经含全部几何 + 灯光 + 灯光目标,
 *  调用方 scene.add(root) 即可。 */
export function buildHangarBay(): HangarBay {
  const root = new THREE.Group();
  root.name = 'hangar-bay';
  const lights: THREE.Light[] = [];

  const FLOOR = HANGAR_BAY_FLOOR_Y;
  const CEIL = HANGAR_BAY_CEIL_Y;
  const WALL_H = CEIL - FLOOR;              // 墙体净高
  const WALL_CY = FLOOR + WALL_H / 2;       // 墙体中心标高

  // ------------------------------------------------------------- 材质 ----
  const M = {
    concrete: new THREE.MeshStandardMaterial({ map: makeConcreteTexture(), roughness: 0.9, metalness: 0.05 }),
    lineWhite: new THREE.MeshStandardMaterial({ color: 0xd7d0b6, roughness: 0.85, metalness: 0.0 }),
    lineYellow: new THREE.MeshStandardMaterial({ color: 0xdfa41d, roughness: 0.8, metalness: 0.0 }),
    hazard: new THREE.MeshStandardMaterial({ map: makeHazardTexture(), roughness: 0.72, metalness: 0.12 }),
    wall: new THREE.MeshStandardMaterial({ map: makeWallTexture(), roughness: 0.82, metalness: 0.14 }),
    roof: new THREE.MeshStandardMaterial({ color: 0x272d36, roughness: 0.9, metalness: 0.12 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x3b434e, roughness: 0.55, metalness: 0.55 }),
    darkSteel: new THREE.MeshStandardMaterial({ color: 0x2b313a, roughness: 0.62, metalness: 0.45 }),
    grate: new THREE.MeshStandardMaterial({ color: 0x4a525d, roughness: 0.42, metalness: 0.85 }),
    gratePit: new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.95, metalness: 0.1 }),
    pipe: new THREE.MeshStandardMaterial({ color: 0x646c76, roughness: 0.45, metalness: 0.7 }),
    tray: new THREE.MeshStandardMaterial({ color: 0x59616c, roughness: 0.5, metalness: 0.65 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.96, metalness: 0.0 }),
    door: new THREE.MeshStandardMaterial({ color: 0x5b6673, roughness: 0.5, metalness: 0.5 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x131820, roughness: 0.22, metalness: 0.25 }),
    lamp: new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.5, metalness: 0.4 }),
    // 灯具发光面: 自发光只影响它自己的亮度(three 没有 GI), 真正的照度来自下面
    // 那几盏 SpotLight —— 但这块"发光板"是把画面读成"机库灯全开着"的关键。
    lampOn: new THREE.MeshStandardMaterial({ color: 0x30363e, emissive: 0xffeccf, emissiveIntensity: 2.7, roughness: 0.5, metalness: 0.05 }),
    stripOn: new THREE.MeshStandardMaterial({ color: 0x2c3239, emissive: 0xffdfae, emissiveIntensity: 1.9, roughness: 0.5, metalness: 0.05 }),
    signOn: new THREE.MeshStandardMaterial({ color: 0x101710, emissive: 0x63e88f, emissiveIntensity: 1.3, roughness: 0.6, metalness: 0.0 }),
    cart: new THREE.MeshStandardMaterial({ color: 0x36404c, roughness: 0.6, metalness: 0.4 }),
    cartDrawer: new THREE.MeshStandardMaterial({ color: 0x2b333d, roughness: 0.55, metalness: 0.45 }),
    crateA: new THREE.MeshStandardMaterial({ color: 0x474c3f, roughness: 0.78, metalness: 0.2 }),
    crateB: new THREE.MeshStandardMaterial({ color: 0x3e4852, roughness: 0.8, metalness: 0.2 }),
    crateC: new THREE.MeshStandardMaterial({ color: 0x5b4a34, roughness: 0.85, metalness: 0.15 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x6b5a3e, roughness: 0.92, metalness: 0.0 }),
    scaffold: new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.48, metalness: 0.72 }),
    orange: new THREE.MeshStandardMaterial({ color: 0xd2601a, roughness: 0.65, metalness: 0.05 }),
    red: new THREE.MeshStandardMaterial({ color: 0x9c2a20, roughness: 0.6, metalness: 0.1 }),
    machine: new THREE.MeshStandardMaterial({ color: 0xb8901c, roughness: 0.6, metalness: 0.25 }),
    bench: new THREE.MeshStandardMaterial({ color: 0x53504a, roughness: 0.82, metalness: 0.2 }),
    shadow: new THREE.MeshBasicMaterial({ map: makeContactShadowTexture(), transparent: true, depthWrite: false, opacity: 0.8 }),
  };

  // 单位基础几何: 全场景共用, 靠实例矩阵缩放成形(见 instanced 注释)。
  const BOX = new THREE.BoxGeometry(1, 1, 1);
  const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
  const CONE = new THREE.ConeGeometry(0.5, 1, 12);
  const TORUS = new THREE.TorusGeometry(0.5, 0.14, 8, 14);

  const put = (im: THREE.InstancedMesh | null) => { if (im) root.add(im); };
  const putAll = (list: (THREE.InstancedMesh | null)[]) => list.forEach(put);

  // ------------------------------------------------------------- 地坪 ----
  // 大板: 顶面正好在 y = FLOOR(与改造前地坪同高)
  const slab = new THREE.Mesh(new THREE.BoxGeometry(2 * HX + 2 * T, 1.4, 2 * HZ + 2 * T), M.concrete);
  slab.position.set(0, FLOOR - 0.7, 0);
  root.add(slab);

  // 牵引中线(机位中心线): 一串虚线, 沿 Z 方向
  const dash: Pl[] = [];
  for (let z = -HZ + 12; z <= HZ - 12; z += 7.5) dash.push({ p: [0, FLOOR + 0.03, z], s: [0.55, 0.06, 4.4] });
  // 中线两侧的黄色引导实线: 牵引车/拖机走的通道边线
  const lanes: Pl[] = [];
  for (const x of [-3.7, 3.7]) lanes.push({ p: [x, FLOOR + 0.03, 0], s: [0.28, 0.06, 2 * HZ - 26] });
  // 黄色安全边界: 围出机体作业区(危险区界), 内加两条短接边形成闭环
  const SAFE_X = 46;
  const SAFE_Z = 52;
  const bound: Pl[] = [
    { p: [0, FLOOR + 0.035, -SAFE_Z], s: [2 * SAFE_X, 0.06, 0.4] },
    { p: [0, FLOOR + 0.035, SAFE_Z], s: [2 * SAFE_X, 0.06, 0.4] },
    { p: [-SAFE_X, FLOOR + 0.035, 0], s: [0.4, 0.06, 2 * SAFE_Z] },
    { p: [SAFE_X, FLOOR + 0.035, 0], s: [0.4, 0.06, 2 * SAFE_Z] },
  ];
  // 危险条纹地面区: 每个检修门前的装卸/动火区
  const hazardPads: Pl[] = [];
  for (const x of [-50, 0, 50]) hazardPads.push({ p: [x, FLOOR + 0.04, -HZ + 11], s: [17, 0.06, 9] });
  for (const x of [-40, 40]) hazardPads.push({ p: [x, FLOOR + 0.04, HZ - 11], s: [17, 0.06, 9] });

  putAll([
    instanced(BOX, M.lineWhite, dash, 'bay-centerline'),
    instanced(BOX, M.lineYellow, lanes, 'bay-lane-lines'),
    instanced(BOX, M.lineYellow, bound, 'bay-safety-boundary'),
    instanced(BOX, M.hazard, hazardPads, 'bay-hazard-pads'),
  ]);

  // 格栅工作区(左右各一块): 凹槽底板 + 横向格栅条 + 两道压条。
  // 层高关系是"底板略高于地坪、格栅条再抬高 0.2": 从上面看, 格栅条之间能看见
  // 下面那块暗底板, 才有"这是个凹下去的格栅"的读法(全做平就成了地坪上的几根亮条)。
  const GRATE_W = 30;
  const GRATE_D = 20;
  const gratePits: Pl[] = [];
  const grateBars: Pl[] = [];
  const grateStraps: Pl[] = [];
  for (const cx of [-58, 58]) {
    const cz = 4;
    gratePits.push({ p: [cx, FLOOR - 0.2, cz], s: [GRATE_W, 0.9, GRATE_D] });
    for (let i = 0; i < 26; i++) {
      const x = cx - GRATE_W / 2 + 0.9 + i * (GRATE_W - 1.8) / 25;
      grateBars.push({ p: [x, FLOOR + 0.22, cz], s: [0.34, 0.32, GRATE_D - 0.6] });
    }
    for (const z of [cz - GRATE_D / 2 + 0.4, cz + GRATE_D / 2 - 0.4]) {
      grateStraps.push({ p: [cx, FLOOR + 0.42, z], s: [GRATE_W, 0.24, 0.6] });
    }
  }
  putAll([
    instanced(BOX, M.gratePit, gratePits, 'bay-grate-pit'),
    instanced(BOX, M.grate, grateBars, 'bay-grate-bars'),
    instanced(BOX, M.grate, grateStraps, 'bay-grate-straps'),
  ]);

  // 横穿机位的电缆沟(带格栅盖板): 机棚地坪上最典型的一道"地平线",
  // 而且它正好横在默认机位画面的中下部 —— 地坪立刻有了纵深参照, 不是一块灰板。
  const trenchY = FLOOR - 0.2;
  const trenchZ = -24;
  const trenchPit = new THREE.Mesh(new THREE.BoxGeometry(2 * HX - 8, 1.0, 4.4), M.gratePit);
  trenchPit.position.set(0, trenchY, trenchZ);
  root.add(trenchPit);
  const trenchBars: Pl[] = [];
  const trenchEdges: Pl[] = [];
  for (let x = -HX + 6; x <= HX - 6; x += 2.6) {
    trenchBars.push({ p: [x, FLOOR + 0.28, trenchZ], s: [1.0, 0.36, 3.8] });
  }
  for (const oz of [-2.35, 2.35]) trenchEdges.push({ p: [0, FLOOR + 0.2, trenchZ + oz], s: [2 * HX - 9, 0.4, 0.5] });
  putAll([
    instanced(BOX, M.grate, trenchBars, 'bay-trench-bars'),
    instanced(BOX, M.darkSteel, trenchEdges, 'bay-trench-edges'),
  ]);

  // 机体接触阴影(位置固定: 机体永远在原点, 转的是相机, 见贴图函数注释)
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(58, 48), M.shadow);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0, FLOOR + 0.1, 0);
  shadow.renderOrder = 2;
  root.add(shadow);

  // ------------------------------------------------------------- 墙体 ----
  const wallBack = new THREE.Mesh(new THREE.BoxGeometry(2 * HX + 2 * T, WALL_H, T), M.wall);
  wallBack.position.set(0, WALL_CY, -(HZ + T / 2));
  const wallFront = wallBack.clone();
  wallFront.position.z = HZ + T / 2;
  const wallLeft = new THREE.Mesh(new THREE.BoxGeometry(T, WALL_H, 2 * HZ), M.wall);
  wallLeft.position.set(-(HX + T / 2), WALL_CY, 0);
  const wallRight = wallLeft.clone();
  wallRight.position.x = HX + T / 2;
  root.add(wallBack, wallFront, wallLeft, wallRight);

  // 墙面竖向结构肋: 给大平面加"结构感", 也把 190 宽的墙在视觉上分段
  const ribs: Pl[] = [];
  for (let x = -80; x <= 80; x += 20) {
    if (x !== 0) ribs.push({ p: [x, WALL_CY, -HZ + 0.5], s: [1.4, WALL_H, 1.6] });
    ribs.push({ p: [x, WALL_CY, HZ - 0.5], s: [1.4, WALL_H, 1.6] });
  }
  for (let z = -80; z <= 80; z += 20) {
    ribs.push({ p: [-HX + 0.5, WALL_CY, z], s: [1.6, WALL_H, 1.4] });
    ribs.push({ p: [HX - 0.5, WALL_CY, z], s: [1.6, WALL_H, 1.4] });
  }
  put(instanced(BOX, M.steel, ribs, 'bay-wall-ribs'));

  // 机棚柱: 舱内四根方柱, 是中景最重要的"尺度参照"(没有它们, 大跨屋盖里
  // 机体的大小关系读不出来), 也顺便挂配电箱/线管。
  const cols: Pl[] = [];
  const colBase: Pl[] = [];
  for (const cx of [-46, 46]) {
    for (const cz of [-46, 46]) {
      cols.push({ p: [cx, WALL_CY, cz], s: [2.6, WALL_H, 2.6] });
      colBase.push({ p: [cx, FLOOR + 1.2, cz], s: [4.2, 2.4, 4.2] });
    }
  }
  putAll([instanced(BOX, M.steel, cols, 'bay-columns'), instanced(BOX, M.darkSteel, colBase, 'bay-column-bases')]);

  // --- 检修门(危险条纹门框) ---
  // 后墙 3 樘 + 前后墙各 1 樘。门框四条边 + 门板 + 观察窗 + 把手 全部按实例合并,
  // 5 樘门只花 4 个 draw call。
  const doorCenters: { x: number; z: number; ry: number }[] = [
    { x: -50, z: -HZ + 0.2, ry: 0 },
    { x: 0, z: -HZ + 0.2, ry: 0 },
    { x: 50, z: -HZ + 0.2, ry: 0 },
    { x: -92, z: 34, ry: Math.PI / 2 },   // 左墙
    { x: 92, z: -34, ry: -Math.PI / 2 },  // 右墙
  ];
  const DOOR_W = 14;
  const DOOR_H = 16;
  const DOOR_CY = FLOOR + DOOR_H / 2;
  const frames: Pl[] = [];
  const slabs: Pl[] = [];
  const windows: Pl[] = [];
  const handles: Pl[] = [];
  for (const d of doorCenters) {
    // 门框局部坐标 -> 世界坐标: 侧面墙上的门整体绕 Y 转 90 度
    const cs = Math.cos(d.ry);
    const sn = Math.sin(d.ry);
    const loc = (lx: number, ly: number, lz: number): [number, number, number] => [
      d.x + lx * cs + lz * sn,
      ly,
      d.z - lx * sn + lz * cs,
    ];
    const r: [number, number, number] = [0, d.ry, 0];
    frames.push({ p: loc(0, DOOR_CY + DOOR_H / 2 + 0.45, 0.1), s: [DOOR_W + 1.8, 0.9, 0.6], r });
    frames.push({ p: loc(0, FLOOR + 0.2, 0.1), s: [DOOR_W + 1.8, 0.4, 0.6], r });
    frames.push({ p: loc(-(DOOR_W / 2 + 0.45), DOOR_CY, 0.1), s: [0.9, DOOR_H + 1.8, 0.6], r });
    frames.push({ p: loc(DOOR_W / 2 + 0.45, DOOR_CY, 0.1), s: [0.9, DOOR_H + 1.8, 0.6], r });
    slabs.push({ p: loc(0, DOOR_CY, 0.32), s: [DOOR_W, DOOR_H, 0.35], r });
    windows.push({ p: loc(-2.4, DOOR_CY + 4.4, 0.55), s: [5.2, 3.0, 0.14], r });
    handles.push({ p: loc(DOOR_W / 2 - 1.5, DOOR_CY - 1.4, 0.62), s: [0.46, 2.8, 0.42], r });
  }
  putAll([
    instanced(BOX, M.hazard, frames, 'bay-door-frames'),
    instanced(BOX, M.door, slabs, 'bay-door-slabs'),
    instanced(BOX, M.glass, windows, 'bay-door-windows'),
    instanced(BOX, M.pipe, handles, 'bay-door-handles'),
  ]);

  // --- 前后墙的卷帘大门(机棚的正门, 关着的) ---
  // 相机绕圈时"正对面那面墙"会是画面主体, 墙上有一扇大卷帘门, 空间立刻被读成
  // "能进飞机的机棚"而不是"一间会议室"。12 根帘板合并成 1 个 draw call。
  const rollSlats: Pl[] = [];
  const ROLL_W = 54;
  const ROLL_H = 0.9;
  for (let i = 0; i < 26; i++) {
    const cy = FLOOR + 0.6 + i * 1.05;
    rollSlats.push({ p: [0, cy, HZ - 0.55], s: [ROLL_W, ROLL_H, 0.5] });
  }
  const rollTracks: Pl[] = [
    { p: [-(ROLL_W / 2 + 1), FLOOR + 14, HZ - 0.7], s: [2.0, 30, 1.2] },
    { p: [ROLL_W / 2 + 1, FLOOR + 14, HZ - 0.7], s: [2.0, 30, 1.2] },
  ];
  const rollBox: Pl[] = [{ p: [0, FLOOR + 28.4, HZ - 1.2], s: [ROLL_W + 6, 3.6, 3.2] }];
  const rollLamp: Pl[] = [{ p: [0, FLOOR + 26.2, HZ - 0.8], s: [ROLL_W - 6, 0.8, 0.5] }];
  putAll([
    instanced(BOX, M.door, rollSlats, 'bay-roll-slats'),
    instanced(BOX, M.steel, rollTracks, 'bay-roll-tracks'),
    instanced(BOX, M.darkSteel, rollBox, 'bay-roll-drum'),
    instanced(BOX, M.hazard, rollLamp, 'bay-roll-hazard'),
  ]);

  // ------------------------------------------------------ 管线/线槽/风管 ----
  // 管线沿墙抱一圈: 机库"工业感"的主要来源不是道具, 是这些走线。
  const pipes: Pl[] = [];
  const pipeBands: [number, number][] = [[FLOOR + 21, 0.9], [FLOOR + 23.2, 0.6], [FLOOR + 25.0, 1.4]];
  for (const [py, rad] of pipeBands) {
    pipes.push({ p: [0, py, -HZ + 1.6], s: [rad, 2 * HX - 12, rad], r: [0, 0, Math.PI / 2] });
    pipes.push({ p: [0, py, HZ - 1.6], s: [rad, 2 * HX - 12, rad], r: [0, 0, Math.PI / 2] });
    pipes.push({ p: [-HX + 1.6, py, 0], s: [rad, 2 * HZ - 12, rad], r: [Math.PI / 2, 0, 0] });
    pipes.push({ p: [HX - 1.6, py, 0], s: [rad, 2 * HZ - 12, rad], r: [Math.PI / 2, 0, 0] });
  }
  // 立管: 从管线下来接到柱子和墙根的设备
  for (const cx of [-46, 46]) {
    for (const cz of [-46, 46]) {
      pipes.push({ p: [cx + 1.6, FLOOR + 12, cz], s: [0.7, 20, 0.7] });
    }
  }
  put(instanced(CYL, M.pipe, pipes, 'bay-pipes'));

  // 电缆桥架(左右墙各一道) + 桥架里的电缆
  const trayPlates: Pl[] = [];
  const trayLips: Pl[] = [];
  const trayRungs: Pl[] = [];
  const trayCables: Pl[] = [];
  for (const sx of [-1, 1]) {
    const x = sx * (HX - 2.6);
    const y = FLOOR + 13.4;
    trayPlates.push({ p: [x, y, 0], s: [2.6, 0.2, 2 * HZ - 20] });
    for (const off of [-1.25, 1.25]) trayLips.push({ p: [x + off, y + 0.5, 0], s: [0.16, 0.9, 2 * HZ - 20] });
    for (let z = -HZ + 12; z <= HZ - 12; z += 6) trayRungs.push({ p: [x, y - 0.2, z], s: [2.5, 0.16, 0.35] });
    for (let i = 0; i < 4; i++) {
      trayCables.push({ p: [x - 0.9 + i * 0.6, y + 0.35, 0], s: [0.22, 2 * HZ - 24, 0.22], r: [Math.PI / 2, 0, 0] });
    }
  }
  putAll([
    instanced(BOX, M.tray, trayPlates, 'bay-tray-plates'),
    instanced(BOX, M.tray, trayLips, 'bay-tray-lips'),
    instanced(BOX, M.tray, trayRungs, 'bay-tray-rungs'),
    instanced(CYL, M.rubber, trayCables, 'bay-tray-cables'),
  ]);

  // 后墙通风管 + 吊架 + 送风口
  const duct = new THREE.Mesh(new THREE.BoxGeometry(2 * HX - 40, 4.2, 3.6), M.tray);
  duct.position.set(0, FLOOR + 27, -HZ + 4.4);
  root.add(duct);
  const ductHangers: Pl[] = [];
  const ductGrilles: Pl[] = [];
  for (let x = -60; x <= 60; x += 12) {
    ductHangers.push({ p: [x, FLOOR + 29.6, -HZ + 3.0], s: [0.4, 3.4, 0.4] });
    ductGrilles.push({ p: [x, FLOOR + 24.7, -HZ + 2.7], s: [6.6, 0.3, 0.5] });
  }
  putAll([
    instanced(BOX, M.steel, ductHangers, 'bay-duct-hangers'),
    instanced(BOX, M.darkSteel, ductGrilles, 'bay-duct-grilles'),
  ]);

  // 墙面配电箱/接线盒(挂在柱子和墙肋上)
  const boxes: Pl[] = [];
  const boxLids: Pl[] = [];
  for (const cx of [-46, 46]) {
    for (const cz of [-46, 46]) {
      boxes.push({ p: [cx + 1.9, FLOOR + 6.4, cz], s: [0.9, 4.4, 3.0] });
      boxLids.push({ p: [cx + 2.45, FLOOR + 6.4, cz], s: [0.25, 3.4, 2.2] });
    }
  }
  for (const x of [-70, -20, 24, 70]) {
    boxes.push({ p: [x, FLOOR + 6.0, -HZ + 1.5], s: [3.0, 4.6, 0.9] });
    boxLids.push({ p: [x, FLOOR + 6.0, -HZ + 2.05], s: [2.2, 3.6, 0.25] });
  }
  putAll([
    instanced(BOX, M.tray, boxes, 'bay-junction-boxes'),
    instanced(BOX, M.cartDrawer, boxLids, 'bay-junction-lids'),
  ]);

  // ------------------------------------------------------------- 顶棚 ----
  // 屋面板(深色) + 主梁 + 次梁 + 斜撑 + 檩条。外露桁架是用户点名的要素:
  // "高细节机棚"在画面上主要靠顶棚这一层结构读出来。
  const roof = new THREE.Mesh(new THREE.BoxGeometry(2 * HX + 2 * T, 1.4, 2 * HZ + 2 * T), M.roof);
  roof.position.set(0, CEIL + 0.7, 0);
  root.add(roof);

  const girders: Pl[] = [];
  const crossBeams: Pl[] = [];
  const braces: Pl[] = [];
  const purlins: Pl[] = [];
  for (let z = -72; z <= 72; z += 24) girders.push({ p: [0, CEIL - 1.5, z], s: [2 * HX - 2, 2.4, 1.4] });
  for (let x = -84; x <= 84; x += 14) crossBeams.push({ p: [x, CEIL - 3.2, 0], s: [1.5, 2.0, 2 * HZ - 2] });
  for (const x of [-77, -63, -49, -35, -21, -7, 7, 21, 35, 49, 63, 77]) {
    braces.push({ p: [x, CEIL - 2.4, -72], s: [0.7, 5.4, 0.7], r: [0, 0, Math.PI / 4] });
    braces.push({ p: [x, CEIL - 2.4, 72], s: [0.7, 5.4, 0.7], r: [0, 0, -Math.PI / 4] });
  }
  for (let z = -84; z <= 84; z += 8) purlins.push({ p: [0, CEIL - 0.85, z], s: [2 * HX - 2, 0.8, 0.5] });
  putAll([
    instanced(BOX, M.steel, girders, 'bay-girders'),
    instanced(BOX, M.steel, crossBeams, 'bay-cross-beams'),
    instanced(BOX, M.darkSteel, braces, 'bay-braces'),
    instanced(BOX, M.darkSteel, purlins, 'bay-purlins'),
  ]);

  // --- 灯具: 顶棚 3 排 x 4 组高棚灯 + 6 组低棚吊灯 + 墙面洗墙灯带 ---
  // 发光面朝下, 位置都在画面上半部分的"顶棚带"里(默认机位能直接看到后排灯具)。
  const lampHouse: Pl[] = [];
  const lampFace: Pl[] = [];
  const lampRods: Pl[] = [];
  for (const z of [-56, -14, 34]) {
    for (const x of [-66, -22, 22, 66]) {
      lampRods.push({ p: [x, CEIL - 4.3, z], s: [0.3, 2.6, 0.3] });
      lampHouse.push({ p: [x, CEIL - 6.0, z], s: [10, 1.4, 4.2] });
      lampFace.push({ p: [x, CEIL - 6.85, z], s: [9.2, 0.35, 3.4] });
    }
  }
  // 低棚吊灯: 直接吊在机位上方的作业灯(吊杆长, 视觉上把顶棚"拉下来"接住机体)
  for (const [x, z] of [[-30, -30], [30, -30], [-30, 30], [30, 30], [0, -52], [0, 46]] as [number, number][]) {
    lampRods.push({ p: [x, (CEIL - 3.2 + CEIL - 9) / 2, z], s: [0.3, CEIL - 3.2 - (CEIL - 9), 0.3] });
    lampHouse.push({ p: [x, CEIL - 10, z], s: [8.4, 1.3, 3.4] });
    lampFace.push({ p: [x, CEIL - 10.8, z], s: [7.6, 0.35, 2.7] });
  }
  putAll([
    instanced(BOX, M.lamp, lampHouse, 'bay-lamp-houses'),
    instanced(BOX, M.lampOn, lampFace, 'bay-lamp-faces'),
    instanced(CYL, M.darkSteel, lampRods, 'bay-lamp-rods'),
  ]);

  // 洗墙灯带: 贴墙一圈暖光带, 让"墙根也是亮的" —— 机体之外的区域不发黑,
  // 整个空间才会读成"灯全开的机库"而不是"打了聚光灯的舞台"。
  const strips: Pl[] = [];
  for (const z of [-56, 0, 56]) {
    strips.push({ p: [-HX + 0.7, FLOOR + 20, z], s: [0.5, 1.0, 16] });
    strips.push({ p: [HX - 0.7, FLOOR + 20, z], s: [0.5, 1.0, 16] });
  }
  for (const x of [-62, 0, 62]) strips.push({ p: [x, FLOOR + 20, -HZ + 0.7], s: [16, 1.0, 0.5] });
  for (const x of [-40, 40]) strips.push({ p: [x, FLOOR + 20, HZ - 0.7], s: [16, 1.0, 0.5] });
  put(instanced(BOX, M.stripOn, strips, 'bay-wall-strips'));

  // 应急指示灯(绿) + 墙上标牌
  const signs: Pl[] = [
    { p: [-50 + 7.6, FLOOR + 17.6, -HZ + 0.8], s: [2.2, 0.9, 0.35] },
    { p: [0 + 4, FLOOR + 17.6, -HZ + 0.8], s: [2.2, 0.9, 0.35] },
    { p: [50 - 7.6, FLOOR + 17.6, -HZ + 0.8], s: [2.2, 0.9, 0.35] },
    { p: [-HX + 0.8, FLOOR + 21.6, 34 + 7.6], s: [0.35, 0.9, 2.2] },
    { p: [HX - 0.8, FLOOR + 21.6, -34 + 7.6], s: [0.35, 0.9, 2.2] },
  ];
  put(instanced(BOX, M.signOn, signs, 'bay-exit-signs'));

  // --- 吊车轨 + 电动葫芦 ---
  // 吊车轨放在机体后方(z = -40): 默认机位下它正好落在画面上部"顶棚带",
  // 是一眼能确认"这是维修机棚"的构件。
  const rail = new THREE.Mesh(new THREE.BoxGeometry(2 * HX - 30, 1.3, 1.9), M.darkSteel);
  rail.position.set(0, CEIL - 4.8, -40);
  root.add(rail);
  const railClamps: Pl[] = [];
  for (let x = -72; x <= 72; x += 12) railClamps.push({ p: [x, CEIL - 3.6, -40], s: [0.5, 1.6, 0.5] });
  const hoistBody: Pl[] = [];
  const hoistChains: Pl[] = [];
  const hoistHooks: Pl[] = [];
  for (const hx of [-42, 22]) {
    hoistBody.push({ p: [hx, CEIL - 6.9, -40], s: [4.4, 2.6, 3.6] });
    hoistChains.push({ p: [hx, CEIL - 12.6, -40], s: [0.34, 8.8, 0.34] });
    hoistHooks.push({ p: [hx, CEIL - 17.6, -40], s: [1.6, 1.6, 1.6], r: [0, 0, 0] });
  }
  putAll([
    instanced(BOX, M.steel, railClamps, 'bay-rail-clamps'),
    instanced(BOX, M.machine, hoistBody, 'bay-hoist-bodies'),
    instanced(CYL, M.rubber, hoistChains, 'bay-hoist-chains'),
    instanced(TORUS, M.steel, hoistHooks, 'bay-hoist-hooks'),
  ]);

  // ------------------------------------------------------------- 道具 ----
  // 摆放原则: 全部在机体(约半径 26)之外, 且集中在默认机位能看到的那个扇形里
  // (z = -25 ~ -85, |x| 随距离放宽) —— 默认机位就是打开机库第一眼看到的画面。
  // 工具车 x4(抽屉柜 + 台面 + 脚轮 + 推手)。
  // 位置: 前两台放在默认机位照片中央那条可视带里(机体斜后方的开阔地坪),
  // 后两台贴墙脚 —— 相机转过去时它们接棒, 画面任何角度都有"人手在用的家伙"。
  const cartBody: Pl[] = [];
  const cartDrawers: Pl[] = [];
  const cartTop: Pl[] = [];
  const cartWheels: Pl[] = [];
  const cartHandles: Pl[] = [];
  for (const [cx, cz, ry] of [[-26, -42, 0.35], [24, -58, -0.5], [-42, -86, 0.15], [68, 6, -1.0]] as [number, number, number][]) {
    cartBody.push({ p: [cx, FLOOR + 3.2, cz], s: [5.2, 6.4, 3.0], r: [0, ry, 0] });
    cartTop.push({ p: [cx, FLOOR + 6.6, cz], s: [5.8, 0.5, 3.6], r: [0, ry, 0] });
    cartHandles.push({ p: [cx - 2.6 * Math.cos(ry), FLOOR + 8.4, cz + 2.6 * Math.sin(ry)], s: [0.35, 3.2, 3.0], r: [0, ry, 0] });
    for (let i = 0; i < 5; i++) {
      cartDrawers.push({ p: [cx + (Math.cos(ry) * 1.5), FLOOR + 0.9 + i * 1.15, cz - Math.sin(ry) * 1.55], s: [0.35, 0.95, 2.4], r: [0, ry, 0] });
    }
    for (const ox of [-2.1, 2.1]) {
      for (const oz of [-1.1, 1.1]) {
        cartWheels.push({
          p: [cx + ox * Math.cos(ry) + oz * Math.sin(ry), FLOOR + 0.42, cz - ox * Math.sin(ry) + oz * Math.cos(ry)],
          s: [0.95, 0.5, 0.95],
          r: [0, ry, Math.PI / 2],
        });
      }
    }
  }
  putAll([
    instanced(BOX, M.cart, cartBody, 'bay-cart-bodies'),
    instanced(BOX, M.cartDrawer, cartDrawers, 'bay-cart-drawers'),
    instanced(BOX, M.steel, cartTop, 'bay-cart-tops'),
    instanced(CYL, M.rubber, cartWheels, 'bay-cart-wheels'),
    instanced(BOX, M.pipe, cartHandles, 'bay-cart-handles'),
  ]);

  // 货箱/集装箱堆: 沿四壁墙脚码放。
  // 【摆放逻辑】机库 UI 是"左中右三栏", 左右两栏各占屏幕约 1/3 —— 落在画面
  // 左右边缘的道具会被面板挡住。而相机是绕机体转的(自动旋转默认开), "对面那面墙"
  // 永远在画面中央那条可视带里。所以**重货一律堆墙脚**(距原点 80~88 单位),
  // 不论相机转到哪个朝向, 总有一批道具在画面正中偏下的位置, 画面不会空。
  const crateSizes: [number, number, number][] = [[4.6, 3.4, 4.6], [5.6, 2.6, 3.6], [6.4, 4.2, 5.0]];
  const crateStacks: { x: number; z: number; k: 0 | 1 | 2; n: number; ry: number }[] = [
    { x: 52, z: -86, k: 1, n: 2, ry: 0.0 },
    { x: 72, z: -84, k: 0, n: 1, ry: 0.2 },
    { x: -54, z: -86, k: 1, n: 3, ry: -0.15 },
    { x: -74, z: -82, k: 2, n: 1, ry: 0.1 },
    { x: 86, z: 18, k: 1, n: 3, ry: -0.3 },
    { x: 82, z: -26, k: 2, n: 2, ry: 0.25 },
    { x: -86, z: -14, k: 0, n: 2, ry: 0.0 },
    { x: -82, z: 34, k: 2, n: 1, ry: 0.4 },
    { x: -20, z: 86, k: 1, n: 2, ry: 0.05 },
    { x: 34, z: 88, k: 0, n: 2, ry: -0.1 },
    { x: 70, z: 84, k: 1, n: 1, ry: 0.3 },
    { x: -64, z: 84, k: 1, n: 1, ry: -0.2 },
  ];
  const crateA: Pl[] = [];
  const crateB: Pl[] = [];
  const crateC: Pl[] = [];
  const pallets: Pl[] = [];
  const crateStraps: Pl[] = [];
  for (const st of crateStacks) {
    const s = crateSizes[st.k];
    const arr = st.k === 0 ? crateA : st.k === 1 ? crateB : crateC;
    pallets.push({ p: [st.x, FLOOR + 0.7, st.z], s: [s[0] + 1.6, 1.4, s[2] + 1.6], r: [0, st.ry, 0] });
    for (let i = 0; i < st.n; i++) {
      // 逐层码高, 上面几层错开一点(整整齐齐的等边堆看着像贴图, 不像码放的货)
      const off = i === 0 ? 0 : (i % 2 === 0 ? 0.4 : -0.35);
      const y = FLOOR + 1.4 + s[1] * (i + 0.5);
      arr.push({ p: [st.x + off, y, st.z + off], s, r: [0, st.ry, 0] });
      crateStraps.push({ p: [st.x + off, y + s[1] / 2 + 0.06, st.z + off], s: [s[0] + 0.2, 0.25, 0.3], r: [0, st.ry, 0] });
      crateStraps.push({ p: [st.x + off, y + s[1] / 2 + 0.06, st.z + off], s: [0.3, 0.25, s[2] + 0.2], r: [0, st.ry, 0] });
    }
  }
  putAll([
    instanced(BOX, M.crateA, crateA, 'bay-crate-a'),
    instanced(BOX, M.crateB, crateB, 'bay-crate-b'),
    instanced(BOX, M.crateC, crateC, 'bay-crate-c'),
    instanced(BOX, M.wood, pallets, 'bay-pallets'),
    instanced(BOX, M.darkSteel, crateStraps, 'bay-crate-straps'),
  ]);

  // 脚手架/踏步梯 x2(立管 + 横杆 + 平台板 + 护栏)
  const scTubes: Pl[] = [];
  const scSteps: Pl[] = [];
  const scRails: Pl[] = [];
  for (const [cx, cz, ry] of [[-18, -64, 0.4], [34, -72, -0.3], [56, -88, 0.9], [-58, 58, 0.2]] as [number, number, number][]) {
    for (const ox of [-3.4, 3.4]) {
      for (const oz of [-2.4, 2.4]) {
        scTubes.push({
          p: [cx + ox * Math.cos(ry) + oz * Math.sin(ry), FLOOR + 7, cz - ox * Math.sin(ry) + oz * Math.cos(ry)],
          s: [0.34, 14, 0.34],
        });
      }
    }
    for (const y of [FLOOR + 4.6, FLOOR + 9.4, FLOOR + 13.6]) {
      for (const oz of [-2.4, 2.4]) {
        scRails.push({ p: [cx + oz * Math.sin(ry), y, cz + oz * Math.cos(ry)], s: [7.2, 0.28, 0.28], r: [0, ry, 0] });
      }
    }
    scSteps.push({ p: [cx, FLOOR + 7.3, cz], s: [7.0, 0.3, 5.0], r: [0, ry, 0] });
    scSteps.push({ p: [cx, FLOOR + 2.3, cz], s: [7.0, 0.3, 5.0], r: [0, ry, 0] });
  }
  putAll([
    instanced(CYL, M.scaffold, scTubes, 'bay-scaffold-tubes'),
    instanced(BOX, M.wood, scSteps, 'bay-scaffold-steps'),
    instanced(BOX, M.scaffold, scRails, 'bay-scaffold-rails'),
  ]);

  // 移动发电机(机架 + 油箱 + 排气管 + 控制面板 + 脚轮)
  const genBody: Pl[] = [];
  const genTank: Pl[] = [];
  const genPipe: Pl[] = [];
  const genPanel: Pl[] = [];
  for (const [cx, cz, ry] of [[-46, -84, 0.25], [66, 30, -0.8], [-84, 26, 1.2], [76, -60, -0.4]] as [number, number, number][]) {
    genBody.push({ p: [cx, FLOOR + 3.6, cz], s: [7.0, 5.6, 4.2], r: [0, ry, 0] });
    genTank.push({ p: [cx, FLOOR + 7.6, cz], s: [5.0, 2.6, 3.6], r: [0, ry, 0] });
    genPipe.push({ p: [cx + 2.6 * Math.cos(ry), FLOOR + 9.4, cz - 2.6 * Math.sin(ry)], s: [0.7, 4.4, 0.7] });
    genPanel.push({ p: [cx - 3.6 * Math.cos(ry), FLOOR + 4.4, cz + 3.6 * Math.sin(ry)], s: [0.3, 3.0, 2.6], r: [0, ry, 0] });
  }
  putAll([
    instanced(BOX, M.machine, genBody, 'bay-gen-bodies'),
    instanced(BOX, M.darkSteel, genTank, 'bay-gen-tanks'),
    instanced(CYL, M.pipe, genPipe, 'bay-gen-pipes'),
    instanced(BOX, M.cartDrawer, genPanel, 'bay-gen-panels'),
  ]);

  // 灭火器点: 红瓶 + 挂板, 沿墙布 5 处(红色小点在冷灰墙面上是最省钱的"人味")
  const exBottle: Pl[] = [];
  const exBracket: Pl[] = [];
  const exSpots: Pl[] = [];
  const exPoints: { p: [number, number, number]; r?: [number, number, number] }[] = [
    { p: [-74, FLOOR + 2.6, -HZ + 1.4] },
    { p: [-10, FLOOR + 2.6, -HZ + 1.4] },
    { p: [74, FLOOR + 2.6, -HZ + 1.4] },
    { p: [-HX + 1.4, FLOOR + 2.6, 28], r: [0, Math.PI / 2, 0] },
    { p: [HX - 1.4, FLOOR + 2.6, -28], r: [0, -Math.PI / 2, 0] },
  ];
  for (const e of exPoints) {
    exBottle.push({ p: e.p, s: [1.5, 3.6, 1.5] });
    exBracket.push({ p: [e.p[0], e.p[1] + 0.6, e.p[2]], s: [2.2, 4.8, 0.7], r: e.r });
    exSpots.push({ p: [e.p[0], e.p[1] + 5.4, e.p[2]], s: [1.8, 0.8, 0.35], r: e.r });
  }
  put(instanced(BOX, M.signOn, exSpots, 'bay-fire-signs'));
  putAll([
    instanced(CYL, M.red, exBottle, 'bay-extinguishers'),
    instanced(BOX, M.cartDrawer, exBracket, 'bay-extinguisher-brackets'),
  ]);

  // 油桶 x7 + 安全锥 x6(锥一圈围在机体作业区边上)
  const drums: Pl[] = [];
  for (const [dx, dz] of [[-44, -74], [-40, -76], [-36, -74], [44, -72], [48, -74], [78, -68], [-78, -64]] as [number, number][]) {
    drums.push({ p: [dx, FLOOR + 4.0, dz], s: [3.0, 8.0, 3.0] });
  }
  const cones: Pl[] = [];
  const coneBase: Pl[] = [];
  for (const [cx, cz] of [[-26, -26], [26, -26], [-26, 26], [26, 26], [-30, -46], [30, -46]] as [number, number][]) {
    cones.push({ p: [cx, FLOOR + 2.6, cz], s: [2.2, 5.0, 2.2] });
    coneBase.push({ p: [cx, FLOOR + 0.2, cz], s: [3.4, 0.4, 3.4] });
  }
  putAll([
    instanced(CYL, M.machine, drums, 'bay-drums'),
    instanced(CONE, M.orange, cones, 'bay-cones'),
    instanced(BOX, M.darkSteel, coneBase, 'bay-cone-bases'),
  ]);

  // 机务工作台(后墙): 台面 + 台腿 + 台钳 + 工具挂板
  const benchTop: Pl[] = [{ p: [-24, FLOOR + 6.4, -HZ + 3.6], s: [22, 0.7, 5.0] }];
  const benchLegs: Pl[] = [];
  for (const ox of [-10, 10]) {
    for (const oz of [-2, 2]) {
      benchLegs.push({ p: [-24 + ox, FLOOR + 3.2, -HZ + 3.6 + oz], s: [0.8, 6.4, 0.8] });
    }
  }
  const benchVise: Pl[] = [{ p: [18, FLOOR + 8.4, -HZ + 3.6], s: [3.6, 2.6, 3.0] }];
  const benchTools: Pl[] = [{ p: [-24, FLOOR + 13.6, -HZ + 1.6], s: [18, 12, 0.4] }];
  putAll([
    instanced(BOX, M.bench, benchTop, 'bay-bench-top'),
    instanced(BOX, M.steel, benchLegs, 'bay-bench-legs'),
    instanced(BOX, M.machine, benchVise, 'bay-bench-vise'),
    instanced(BOX, M.darkSteel, benchTools, 'bay-bench-toolboard'),
  ]);

  // 地插(地面电源插座箱) + 拖在地上的电缆 + 卷线盘。
  // 插座点位按"电缆要接的设备"来定: 插座永远紧挨着它供电的工具车/发电机,
  // 电缆才有去处(悬空断头的电缆一眼假)。
  const sockets: Pl[] = [];
  const reels: Pl[] = [];
  const socketXY: [number, number][] = [[-24, -46], [22, -62], [-48, -78], [36, 42]];
  for (const [sx, sz] of socketXY) {
    sockets.push({ p: [sx, FLOOR + 0.5, sz], s: [2.6, 1.0, 2.6] });
    reels.push({ p: [sx + 3.0, FLOOR + 2.0, sz + 1.2], s: [3.2, 1.4, 3.2], r: [Math.PI / 2, 0, 0] });
  }
  putAll([
    instanced(BOX, M.darkSteel, sockets, 'bay-floor-sockets'),
    instanced(CYL, M.machine, reels, 'bay-cable-reels'),
  ]);
  // 电缆: 从地插一路甩到工具车/发电机, 垂着一点弧度(管体是最便宜的"软物"表达)
  const cablePaths: [number, number][][] = [
    [[-24, -46], [-25, -45], [-25.5, -43.5], [-26, -42]],
    [[22, -62], [23, -61], [23.5, -59.5], [24, -58]],
    [[-48, -78], [-47, -80], [-46.5, -82], [-46.5, -84]],
  ];
  for (const pts of cablePaths) {
    const curve = new THREE.CatmullRomCurve3(pts.map(([x, z]) => new THREE.Vector3(x, FLOOR + 0.35, z)));
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 20, 0.22, 6, false), M.rubber);
    root.add(tube);
  }

  // ------------------------------------------------------------- 灯光 ----
  // 灯数: 6 盏(环境 + 半球 + 3 盏顶棚聚光 + 1 盏前景点光) + hangar.ts 原有的
  // "跟拍主光" + 一盏暖色轮廓光 = 8 盏, 到顶不超。全部 castShadow = false。
  //
  // 关于是否上真阴影: 机棚里最需要阴影的是"机体落在地上的接触影"。上 shadowMap
  // 要为唯一一盏投影灯再渲一遍整个机库(几十个 draw call)且有机体换型后贴图过期
  // 的问题; 这里改用一张径向渐变面片当接触阴影(见 makeContactShadowTexture),
  // 机位固定为原点 ⇒ 静态软阴影在任何机位/任何机型下都成立, 成本 1 个 draw call。
  //
  // 【衰减 decay 的取值, 这是机库布光最容易翻车的一处】
  // 旧机库主光是 SpotLight(.., 6, 200, PI/6, 0.5, 1.5): 机位在半径 38 上,
  // 物理衰减 1.5 次方 ⇒ 40^1.5 约 253 ⇒ 实际照度 6/253 约 0.024, 灯其实根本
  // 照不到机体(这就是"暗不溜秋"的最直接原因)。顶棚灯具到机体是 25~35 单位:
  // 若用 decay = 1, 要等价就得把 intensity 抬到 100 量级, 一旦相机拉远/灯具
  // 抬高, 照度又会掉一截 —— 亮度随视角飘, 这在菜单里是纯粹的坑。
  // 所以顶棚灯统一 decay = 0(恒定照度): 机库是尺寸固定的封闭空间, "不做距离
  // 衰减"在这里不是物理错误, 而是布光手段(等价于片场用无衰减灯铺底),
  // 好处是全机位亮度稳定、再也不会出现"某些角度突然变黑"。
  const amb = new THREE.AmbientLight(0x7f8ea6, 0.2);
  // 半球光(补光): 顶棚往下打的冷白 + 地面反弹的深灰。它没有方向性、不投影,
  // 是"把墙也抬起来"最便宜的一盏 —— 只靠聚光灯的话, 锥体外那几面墙会一直是
  // 黑的, 空间就读不成"灯全开着的机棚"了。
  const hemi = new THREE.HemisphereLight(0xa6c8f0, 0x1a1f27, 0.75);
  lights.push(amb, hemi);

  /** 顶棚聚光灯: decay = 0, 靠 penumbra 把边缘化开, 不投影。 */
  const ceilingSpot = (
    name: string,
    color: number,
    intensity: number,
    px: number, py: number, pz: number,
    tx: number, ty: number, tz: number,
    angle: number,
    penumbra: number,
  ) => {
    const s = new THREE.SpotLight(color, intensity, 0, angle, penumbra, 0);
    s.name = name;
    s.position.set(px, py, pz);
    const t = new THREE.Object3D();
    t.position.set(tx, ty, tz);
    root.add(t);
    s.target = t;
    return s;
  };
  // 中央主灯(暖白): 正对机位上方, 保证任何机位下机体正面都有主光
  const keyLight = ceilingSpot('bay-key', 0xfff2dc, 2.8, 0, CEIL - 6.5, -6, 0, -1, 0, 0.85, 0.8);
  // 左右两盏(冷/暖各一): 造出"冷暖对置"的立体感 —— 金属机体只靠一盏灯时
  // 侧向高光会糊成一片, 两盏色温不同的侧光能把机身的转折读出来。
  // 张角也放大到 0.92 rad(约 53 度): 顺带把两侧墙面刷到, 墙面不再是黑的。
  const coolLight = ceilingSpot('bay-cool', 0xc9dcff, 1.9, -34, CEIL - 7, 16, -8, 0, 0, 0.92, 0.85);
  const warmLight = ceilingSpot('bay-warm', 0xffdca6, 1.8, 34, CEIL - 7, 18, 8, 0, 0, 0.92, 0.85);
  lights.push(keyLight, coolLight, warmLight);
  // 前景点光: 机位附近地面的一团冷光, 让"相机脚下"的地坪不至于死板;
  // 这盏用 decay = 2(真正的平方反比)是有意的 —— 它要的就是局部光斑,
  // 所以 intensity 按距离给足(半径 10 单位处约 2.4)。
  const frontFill = new THREE.PointLight(0x9ec2f2, 240, 0, 2);
  frontFill.name = 'bay-front-fill';
  frontFill.position.set(0, 13, 30);
  lights.push(frontFill);

  root.add(amb, hemi, keyLight, coolLight, warmLight, frontFill);
  return { root, lights };
}
