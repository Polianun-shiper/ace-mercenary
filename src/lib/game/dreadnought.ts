// === 敌方 BOSS · 空中战舰「堡垒」(dreadnought class) (per user request) ============
//
// 用户: "新剧情关做一个敌方 BOSS: 一艘体长 900 米的空中战舰「堡垒」。舰体就是超大的长方形,
//        表面挂 16 个组件(机炮/导弹/激光/核心), 按战斗阶段换布局; 运动只有直线巡航 / 加速 /
//        侧面对敌 / 核心暴露四个阶段, 大惯性、弱转向, 最低离地 2500 米; 核心暴露时全武器齐射;
//        另外要一种小型自杀式无人机, 几十架同时在场。"
//
// 设计:
//   · 舰体 = 一块 900 x 240 x 160 的巨型长方形(长沿 Z、宽沿 X、高沿 Y), 再叠舰艏斜面 / 舰桥 /
//     发动机短舱(带发光盘)/ 鳍与天线 / 舷侧肋骨做剪影 —— 远看是"战舰", 近看仍然是那块盒子,
//     于是命中判定可以直接用盒子半长(hull.half)算, 不需要网格级射线。
//   · 16 个挂点**按所在面的外法线定向**(顶面 +Y / 底面 -Y / 左 -X / 右 +X / 艏 +Z / 艉 -Z),
//     统一 parent 到 mountRoot(局部坐标) => 跟着母舰走、自己永远不动, 世界位置由母舰变换决定,
//     引擎只要把挂点的 localPos 过一次母舰矩阵就能做锁定/命中/雷达框。
//   · "换阶段" = 清空 mountRoot 重建(每阶段一张 STAGE_LOADOUTS 表, 数组顺序即 index 0..15),
//     因为换的是**舰体表面的武器布局**而不是被打掉的残骸, 旧挂点整体消失才合理。
//   · 运动 AI 见 updateDreadnoughtMotion: 四阶段递进, 速度与航向都是慢 lerp(大惯性),
//     航向角速度钳在 DREADNOUGHT_MAX_YAW => "900 米的船不该像战斗机一样转弯"。
//   · 本模块**只造模型 + 算运动**: 开火、爆炸、热焰弹视觉、无人机实体生成全部由引擎负责,
//     引擎读 st.flares / st.salvo / st.pitch 即可知道"这一帧该做什么特效"。
import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { assetUrl } from './asset-url';
import { fetchTextAsset } from './obj-gzip';
import { fetchAssetText, loadImageTexture } from './fetch-asset';

/** 舰体尺寸(米)。长沿 Z、宽沿 X、高沿 Y —— 与引擎 heading 0 => +Z 的约定一致, 舰艏在 +Z */
/** === 体积倍率 (per user request: "空中战舰的 boss 体积还要翻 3 倍") =================
 *  体积 x3 => 线度 x3^(1/3) = 1.442, 于是 900x240x160 变成 1298x346x231 米。
 *  与 AIR_WARSHIP_SCALE 同一套约定(体积倍率走立方根); 想改成"线度直接 x3"就把这里写成 3。
 *  注意: 挂点位置/朝向都从下面的 DREADNOUGHT_SIZE 派生, 所以改这一个数全舰一起放大。 */
// 体积 x3(第一轮) -> 长宽高 x3(第二轮) -> **这一轮再翻倍** (per user request: 模型大小还得翻倍)
// => cbrt(3) x 3 x 2 = 8.653, 基础 900x240x160 变成约 7788x2077x1384 米。
// 体积 x3 -> 长宽高 x3 -> 模型翻倍 -> **这一轮体积再翻一倍** (per user request)
// 体积倍率走立方根(与 AIR_WARSHIP_SCALE 同一约定): cbrt(3) x 3 x 2 x cbrt(2) = 10.90,
// 基础 900x240x160 => 约 9813 x 2616 x 1744 米。
// (想要"线度再翻倍"就把 cbrt(2) 换成 2 => 15576 米。)
export const DREADNOUGHT_SCALE = Math.cbrt(3) * 3 * 2 * Math.cbrt(2);
/** 舰体基础尺寸(米, 未乘体积倍率) */
const DREADNOUGHT_BASE = { len: 900, wid: 240, hei: 160 };
/** 舰体尺寸(米, 已乘体积倍率)。长沿 Z、宽沿 X、高沿 Y —— 与引擎 heading 0 => +Z 的约定一致, 舰艏在 +Z */
export const DREADNOUGHT_SIZE = {
  len: DREADNOUGHT_BASE.len * DREADNOUGHT_SCALE,
  wid: DREADNOUGHT_BASE.wid * DREADNOUGHT_SCALE,
  hei: DREADNOUGHT_BASE.hei * DREADNOUGHT_SCALE,
};
/** === 单个挂点血量 = 4 发 MSL =================================================
 *  MSL 基础伤害 120, 引擎再乘 WEAPON_DAMAGE_SCALE 0.8 => 单发实伤 96。
 *  384 = 4 x 96 —— 用户要求"一个组件 4 发导弹打爆", 改这里就等于改"要打几发"。
 *  (机炮/激光的 DPS 远低于导弹, 所以实际是"导弹计数", 引擎不必再写特殊规则。) */
export const DREADNOUGHT_MOUNT_HP = 384;
/** 每个阶段的挂点总数(阶段之间只是 kind/位置不同, 数量恒定, 方便引擎预分配数组) */
export const DREADNOUGHT_MOUNTS = 16;
/** 最低离地高度(米) —— 比轻型战舰(2000)更高: 900 米的舰体压到 2000 米会削到山头 */
export const DREADNOUGHT_MIN_AGL = 2500;
/** 最大航向角速度(rad/s) ≈ 1.15 度/秒 —— "较弱机动转向能力"; 900 米的船转身要按分钟算 */
export const DREADNOUGHT_MAX_YAW = 0.02;
/** 阶段 3/4 的侧面对敌绕行半径(米): 玩家在圆心, 战舰在 6km 外慢慢画圈 */
export const DREADNOUGHT_ORBIT_R = 6000;
/** 四个阶段的目标速度(m/s): 直线巡航 / 加速 / 侧面对敌绕行 / 核心暴露(减速硬撑) */
export const DREADNOUGHT_SPEED = {
  cruise: 35, accel: 75, broadside: 60,
  // === 末阶段: 点燃后燃器**加速逃离** (per user request) =====================
  // 原来是 25(边打边滑), 现在是 210 —— 比阶段 2 的 75 快得多, 玩家必须开加力才追得上。
  // per user request: 末阶段的提速增益**解除**(420 -> 回到 210)
  final: 25, escape: 210,
};
/** 自杀式无人机血量 —— 一轮机炮点射就能打掉(引擎的机炮弹丸伤害比这高得多) */
export const DRONE_HP = 30;

/** 挂点所在的面('front' = 舰艏 +Z, 'rear' = 舰艉 -Z) */
export type MountFace = 'top' | 'bottom' | 'left' | 'right' | 'front' | 'rear';
/** 挂点类型: 机炮 / 导弹发射箱 / 激光发射器 / 核心(阶段 4 的弱点) */
export type MountKind = 'gun' | 'missile' | 'laser' | 'core';

/** 阶段布局表的一行 —— 只描述"挂在哪个面的哪个相对位置", 具体坐标由 faceAnchor 算 */
export interface DreadnoughtMountDef { face: MountFace; kind: MountKind; u: number; v: number; }

export interface DreadnoughtMount {
  /** 挂点本体(炮塔/发射箱/激光器/核心模块): 已挂在 mountRoot 上(局部坐标), 世界位置由母舰变换决定 */
  mesh: THREE.Group;
  kind: MountKind;
  hp: number;
  maxHp: number;
  alive: boolean;
  /** 开火冷却(秒) */
  fireTimer: number;
  /** 激光充能进度 0..1(仅 laser 有意义, 由引擎推进; 充能时把 mesh.userData.laserMat 调亮) */
  charge: number;
  /** 挂点在舰体本地空间的位置 */
  localPos: THREE.Vector3;
  /** 该挂点所在面的外法线(本地空间) —— 引擎用它把挂点转到世界朝向 */
  normal: THREE.Vector3;
  /** 命中/雷达框包围球半径(米) */
  radius: number;
  /** 0..15, 与 STAGE_LOADOUTS[stage] 的顺序一致(引擎可以拿它索引自己的弹道/音效表) */
  index: number;
}

export interface DreadnoughtModel {
  group: THREE.Group;
  /** 挂点容器: 切阶段时清空它重建(它自己无变换, 所以挂点的 localPos 就是舰体本地坐标) */
  mountRoot: THREE.Group;
  hullMat: THREE.MeshStandardMaterial;
  size: { len: number; wid: number; hei: number };
  hull: { radius: number; half: THREE.Vector3 };
  /** 挂点摆放用的舰体盒(FBX 舰体只占模型底部时, 它与 hull.half 不同) */
  hullFrame: HullFrame;
  /** 额外字段(引擎可不读): 建舰时的阵营, 供 applyStageLoadout 给重建的挂点配色 */
  ally?: boolean;
}

// === 面锚点数学 ==================================================================

/** 每个面: 外法线 + 该面的两条展开轴。约定 u 沿**该面的长边**, v 沿短边, 都取 0..1。
 *  顶/底面: 长边 = 舰体长轴 Z(900) -> 短边 X(240)
 *  左/右面: 长边 = 舰体长轴 Z(900) -> 短边 Y(160)
 *  艏/艉面: 长边 = 舰体宽 X(240)    -> 短边 Y(160)
 *  这样"4 个挂点沿 u 均布"在任何面上都是"沿面内最长方向拉开", 布局表只写 u/v 就够。 */
/** 挂点所在的"舰体盒": 半边长 + 中心。
 *  程序化舰体是对称的(中心在原点), 但 FBX 舰体只占模型底部一条(上面全是桅杆/上层建筑),
 *  武器显然不该摆到桅杆上 —— 所以挂点位置一律走这个盒子, 而不是模型包围盒本身。 */
export interface HullFrame {
  half: THREE.Vector3;
  center: THREE.Vector3;
  /** === 分段包络 (per user request: 碰撞盒要和 fbx 一样的形状且一样大) ================
   *  单个大盒子会把舰艏/舰艉的尖角也框进去(比本体"大一圈")。这里沿长轴切 N 段, 每段记
   *  自己的 z 范围与 x/y 半宽 —— 于是碰撞盒跟着舰体收窄, 形状与本体一致。
   *  长度随模型缩放, 所以只用相对分数(zFrac)存, 每帧用当前 half 换算。 */
  segments?: { zFrac: number; halfLen: number; hx: number; hy: number }[];
}

/** 默认舰体盒 = 程序化舰体(对称, 中心在原点) */
export function defaultHullFrame(): HullFrame {
  return {
    half: new THREE.Vector3(DREADNOUGHT_SIZE.wid / 2, DREADNOUGHT_SIZE.hei / 2, DREADNOUGHT_SIZE.len / 2),
    center: new THREE.Vector3(0, 0, 0),
  };
}

const FACE_AXIS: Record<MountFace, { n: [number, number, number]; a: 'x' | 'y' | 'z'; as: number; b: 'x' | 'y' | 'z'; bs: number; off: [number, number, number] }> = {
  top:    { n: [0, 1, 0],  a: 'z', as: DREADNOUGHT_SIZE.len, b: 'x', bs: DREADNOUGHT_SIZE.wid, off: [0, DREADNOUGHT_SIZE.hei / 2, 0] },
  bottom: { n: [0, -1, 0], a: 'z', as: DREADNOUGHT_SIZE.len, b: 'x', bs: DREADNOUGHT_SIZE.wid, off: [0, -DREADNOUGHT_SIZE.hei / 2, 0] },
  left:   { n: [-1, 0, 0], a: 'z', as: DREADNOUGHT_SIZE.len, b: 'y', bs: DREADNOUGHT_SIZE.hei, off: [-DREADNOUGHT_SIZE.wid / 2, 0, 0] },
  right:  { n: [1, 0, 0],  a: 'z', as: DREADNOUGHT_SIZE.len, b: 'y', bs: DREADNOUGHT_SIZE.hei, off: [DREADNOUGHT_SIZE.wid / 2, 0, 0] },
  front:  { n: [0, 0, 1],  a: 'x', as: DREADNOUGHT_SIZE.wid, b: 'y', bs: DREADNOUGHT_SIZE.hei, off: [0, 0, DREADNOUGHT_SIZE.len / 2] },
  rear:   { n: [0, 0, -1], a: 'x', as: DREADNOUGHT_SIZE.wid, b: 'y', bs: DREADNOUGHT_SIZE.hei, off: [0, 0, -DREADNOUGHT_SIZE.len / 2] },
};

/**
 * 挂点锚点: 盒子六个面之一上, 相对位置 (u, v) 处的**本地坐标 + 外法线**。
 * u/v 都是 0..1 的分数(0.5 = 面中心), u 沿该面长边、v 沿短边(见 FACE_AXIS 注释)。
 * 布局表和引擎都用它, 保证"表里的挂点位置"与"实际网格位置"永远同一套数学。
 */
export function faceAnchor(face: MountFace, u: number, v: number, frame?: HullFrame): { pos: THREE.Vector3; normal: THREE.Vector3 } {
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
}

/**
 * 把挂点组的**本地 +Y 转到该面的外法线**上(挂点网格一律按"底座在 y=0、朝 +Y 长出来"来建)。
 * 只绕单轴转, 前五面/艏艉四种情况互不叠加, 所以用欧拉角最直观、也最好读:
 *   top   : 不用转                     (+Y 本来就是外法线)
 *   bottom: 绕 X 转 180°  => +Y 变 -Y   (底面朝下)
 *   right : 绕 Z 转 -90°  => +Y 变 +X   (右舷朝右)
 *   left  : 绕 Z 转 +90°  => +Y 变 -X   (左舷朝左)
 *   front : 绕 X 转 +90°  => +Y 变 +Z   (舰艏朝前)
 *   rear  : 绕 X 转 -90°  => +Y 变 -Z   (舰艉朝后)
 * 于是"炮口/发射口指向外"这件事对六个面同时成立, 引擎不必每个面写特例。
 */
function orientMountToFace(g: THREE.Group, face: MountFace): void {
  switch (face) {
    case 'top': break;
    case 'bottom': g.rotation.x = Math.PI; break;
    case 'right': g.rotation.z = -Math.PI / 2; break;
    case 'left': g.rotation.z = Math.PI / 2; break;
    case 'front': g.rotation.x = Math.PI / 2; break;
    case 'rear': g.rotation.x = -Math.PI / 2; break;
  }
}

// === 建造期共用的临时对象(避免每次建模型都 new) ==================================
const _box = new THREE.Box3();
const _sphere = new THREE.Sphere();

/**
 * 造一艘「堡垒」。isAlly 只影响配色(敌: 暗钢 + 暖橙; 友: 冷灰 + 青), 敌我关系由引擎决定。
 * 注意: 本函数**不会**挂任何武器 —— 武器由 applyStageLoadout(model, stage) 装配。
 */
export function buildDreadnought(isAlly: boolean): DreadnoughtModel {
  const s = DREADNOUGHT_SIZE;
  const group = new THREE.Group();
  const mountRoot = new THREE.Group(); // 无变换: 挂点直接写舰体本地坐标
  group.add(mountRoot);

  const hullMat = new THREE.MeshStandardMaterial({
    color: isAlly ? 0x60707f : 0x4a5058, // 敌: 暗钢蓝灰(比轻型战舰更深, 显得"重")
    metalness: 0.55,
    roughness: 0.55,
  });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x22262c, metalness: 0.6, roughness: 0.5 });
  // 发光件用 Basic(不吃光照) —— 引擎的泛光/辉光通道只认"最亮的像素", 不受环境光影响更稳
  const glowMat = new THREE.MeshBasicMaterial({ color: isAlly ? 0x66ccff : 0xff8844 });

  // === 主体: 超大的横放长方形 ==================================================
  const hull = new THREE.Mesh(new THREE.BoxGeometry(s.wid, s.hei, s.len), hullMat);
  group.add(hull);

  // 舰艏: 一块下压的斜板 + 撞角 —— 让 900 米的盒子前端有"破浪"的剪影(不影响盒子命中判定)
  const prow = new THREE.Mesh(new THREE.BoxGeometry(s.wid * 0.86, s.hei * 0.42, s.len * 0.13), hullMat);
  prow.position.set(0, -s.hei * 0.18, s.len * 0.55);
  prow.rotation.x = -0.17;
  group.add(prow);
  const ram = new THREE.Mesh(new THREE.BoxGeometry(s.wid * 0.5, s.hei * 0.16, s.len * 0.06), darkMat);
  ram.position.set(0, -s.hei * 0.34, s.len * 0.52);
  group.add(ram);

  // 舰桥/上层建筑(两层递退 + 桅杆): 这是"是不是战舰"最关键的剪影, 放在舰体后段上方
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(s.wid * 0.52, s.hei * 0.62, s.len * 0.18), hullMat);
  bridge.position.set(0, s.hei * 0.81, -s.len * 0.22);
  group.add(bridge);
  const bridgeTop = new THREE.Mesh(new THREE.BoxGeometry(s.wid * 0.34, s.hei * 0.42, s.len * 0.11), hullMat);
  bridgeTop.position.set(0, s.hei * 1.31, -s.len * 0.24);
  group.add(bridgeTop);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3.2, s.hei * 0.8, 8), darkMat);
  mast.position.set(0, s.hei * 1.85, -s.len * 0.26);
  group.add(mast);

  // 舷侧肋骨: 沿舰体长轴每 ~100m 一道, 让 900 米的平板有尺度感(纯视觉, 不参与任何判定)
  for (let i = 0; i < 9; i++) {
    const rib = new THREE.Mesh(new THREE.BoxGeometry(s.wid * 1.005, s.hei * 1.02, s.len * 0.005), darkMat);
    rib.position.z = (i / 8 - 0.5) * s.len * 0.92;
    group.add(rib);
  }

  // 鳍/天线: 上垂尾 x2 + 下垂鳍 x2 + 艏部天线 x2
  for (const sx of [-1, 1]) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(4, s.hei * 0.5, s.len * 0.09), darkMat);
    fin.position.set(sx * s.wid * 0.3, s.hei * 0.72, -s.len * 0.42);
    fin.rotation.z = sx * 0.25;
    group.add(fin);
    const vfin = new THREE.Mesh(new THREE.BoxGeometry(4, s.hei * 0.42, s.len * 0.07), darkMat);
    vfin.position.set(sx * s.wid * 0.34, -s.hei * 0.68, -s.len * 0.3);
    vfin.rotation.z = sx * -0.22;
    group.add(vfin);
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.6, s.hei * 0.55, 6), darkMat);
    ant.position.set(sx * s.wid * 0.36, s.hei * 0.75, s.len * 0.4);
    group.add(ant);
  }

  // 舰艉 4 台发动机短舱 + 发光圆盘(盘面朝 -Z, 所以绕 Y 转 180°)
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const nac = new THREE.Mesh(new THREE.CylinderGeometry(s.wid * 0.11, s.wid * 0.09, s.len * 0.13, 12), darkMat);
      nac.rotation.x = Math.PI / 2;
      nac.position.set(sx * s.wid * 0.29, sy * s.hei * 0.26, -s.len * 0.55);
      group.add(nac);
      const glow = new THREE.Mesh(new THREE.CircleGeometry(s.wid * 0.085, 14), glowMat);
      glow.position.set(sx * s.wid * 0.29, sy * s.hei * 0.26, -s.len * 0.615);
      glow.rotation.y = Math.PI;
      group.add(glow);
    }
  }

  // 引擎的环境贴图/泛光通道靠这个标记收集对象(与 air-warship.ts 完全一致, 不能漏)
  group.traverse((o) => { (o as THREE.Object3D & { _env?: boolean })._env = true; });

  // 碰撞球: 半长向量取 0.62 —— 与轻型战舰同一套系数(把"斜面孔隙"折进去的经验值)
  const half = new THREE.Vector3(s.wid / 2, s.hei / 2, s.len / 2);
  return {
    group,
    mountRoot,
    hullMat,
    size: { len: s.len, wid: s.wid, hei: s.hei },
    hull: { radius: half.length() * 0.62, half },
    hullFrame: { half: half.clone(), center: new THREE.Vector3(0, 0, 0) },
    ally: isAlly,
  };
}

// === 挂点网格 ====================================================================

interface BuildMats {
  hull: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  glow: THREE.MeshBasicMaterial;
}

/**
 * 造一个挂点的网格(局部: 底座贴在 y=0、朝 +Y 长出来; 朝向由 orientMountToFace 负责)。
 * 尺寸全部按 900m 舰体放大: 炮塔比轻型战舰的整段舰体还大, 这样 6km 外也认得出是什么武器。
 * 激光/核心的发光材质**每个挂点单独 new**: 引擎要能单独把它们调亮(充能/核心暴走), 共享材质会一起亮。
 */
function buildMountMesh(kind: MountKind, isAlly: boolean, mats: BuildMats): { group: THREE.Group; laserMat?: THREE.MeshStandardMaterial; coreMat?: THREE.MeshStandardMaterial } {
  const g = new THREE.Group();
  if (kind === 'gun') {
    // 机炮: 底座 + 可转炮塔 + 双长管(88m, 对应 900m 的舰体看着才成比例)
    const base = new THREE.Mesh(new THREE.BoxGeometry(30, 6, 30), mats.dark);
    base.position.y = 3;
    g.add(base);
    const turret = new THREE.Mesh(new THREE.BoxGeometry(24, 16, 24), mats.hull);
    turret.position.y = 14;
    g.add(turret);
    for (const bx of [-4.5, 4.5]) {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 88, 8), mats.dark);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(bx, 18, 34);
      g.add(barrel);
    }
  } else if (kind === 'missile') {
    // 导弹发射箱: 装甲盒 + 2x2 四管(管口伸出盒体, 让"这是发射器"一眼可读)
    const box = new THREE.Mesh(new THREE.BoxGeometry(40, 26, 52), mats.hull);
    box.position.y = 13;
    g.add(box);
    for (const bx of [-9, 9]) {
      for (const by of [8, 19]) {
        const tube = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 46, 8), mats.dark);
        tube.rotation.x = Math.PI / 2;
        tube.position.set(bx, by, 8);
        g.add(tube);
      }
    }
  } else if (kind === 'laser') {
    // 激光: 装甲壳体 + 环形护罩 + 发射镜面(发光) + 2 片散热鳍
    // 镜面做成"贴面的圆盘"(圆柱沿 +Y 就是盘面朝外), 于是粒子/光柱从挂点法线方向射出, 不需要额外定位。
    const housing = new THREE.Mesh(new THREE.BoxGeometry(34, 16, 34), mats.hull);
    housing.position.y = 8;
    g.add(housing);
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(15, 15, 10, 16), mats.dark);
    ring.position.y = 9;
    g.add(ring);
    const laserMat = new THREE.MeshStandardMaterial({
      color: isAlly ? 0x11283c : 0x3a1a10,
      emissive: isAlly ? 0x33aaff : 0xff5a22, // 敌方的激光偏橙红(与舰体暖色强调一致, 玩家一眼分辨敌我光束)
      emissiveIntensity: 1.3,
      metalness: 0.3,
      roughness: 0.35,
    });
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(12, 12, 5, 18), laserMat);
    lens.position.y = 17;
    g.add(lens);
    for (const bx of [-19, 19]) {
      const finPlate = new THREE.Mesh(new THREE.BoxGeometry(2.5, 14, 30), mats.dark);
      finPlate.position.set(bx, 10, 0);
      g.add(finPlate);
    }
    g.userData.laserMat = laserMat; // 引擎充能时把它调亮 / 开火瞬间闪一下
    return { group: g, laserMat };
  } else {
    // 核心: 敞开的框架(4 柱 + 2 横梁 + 底板)里吊一颗发光球 —— 阶段 4 的弱点, 必须比周围亮得多
    const plate = new THREE.Mesh(new THREE.BoxGeometry(46, 6, 46), mats.dark);
    plate.position.y = 3;
    g.add(plate);
    for (const px of [-19, 19]) {
      for (const pz of [-19, 19]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(3.5, 28, 3.5), mats.dark);
        post.position.set(px, 17, pz);
        g.add(post);
      }
    }
    for (const pz of [-19, 19]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(42, 3, 3), mats.dark);
      bar.position.set(0, 30, pz);
      g.add(bar);
    }
    const coreMat = new THREE.MeshStandardMaterial({
      color: isAlly ? 0x11303c : 0x3c2410,
      emissive: isAlly ? 0x44ddff : 0xffb347, // 暖琥珀色: 与暗钢舰体对比最强, 也是"危险"的通用读法
      emissiveIntensity: 1.8,
      metalness: 0.2,
      roughness: 0.3,
    });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(15, 12, 8), coreMat);
    bulb.position.y = 20;
    g.add(bulb);
    g.userData.coreMat = coreMat; // 引擎做脉冲/击破闪光时改它
    return { group: g, coreMat };
  }
  return { group: g };
}

// === 阶段布局 ====================================================================
//
// 数值都用 u 0.18/0.38/0.62/0.82 这种"沿面长边均布"的值, v 基本取 0.5(面中线);
// 需要两层的地方(阶段 3 底面)用 v 0.28/0.72 分开, 避免网格互相插进去。
// 数组顺序 = DreadnoughtMount.index, 引擎可以按 index 写死"第几号挂点打哪一发"。

/** 布局表小工具(纯语法糖, 只是为了下面四张表能一行一个挂点看得清) */
function m(face: MountFace, kind: MountKind, u: number, v = 0.5): DreadnoughtMountDef {
  return { face, kind, u, v };
}

export const STAGE_LOADOUTS: Record<1 | 2 | 3 | 4, DreadnoughtMountDef[]> = {
  // === 阶段 1「直线巡航」: 慢速直飞, 用最"传统战舰"的布局(顶面机炮 + 底面导弹) —— 让玩家先看清楚这艘船
  1: [
    // 顶面 4 机炮沿长轴均布: 前后左右的上半球射界都被覆盖, 但只有 4 门, 玩家可以从低空绕
    m('top', 'gun', 0.18), m('top', 'gun', 0.38), m('top', 'gun', 0.62), m('top', 'gun', 0.82),
    // 底面 4 导弹: 逼玩家别贴在舰体下方闻尾气(从下往上打要冒导弹雨的风险)
    m('bottom', 'missile', 0.18), m('bottom', 'missile', 0.38), m('bottom', 'missile', 0.62), m('bottom', 'missile', 0.82),
    // 左舷 2 + 右舷 2 机炮: 侧向压制, 对应"侧面也有近防炮"
    m('left', 'gun', 0.38), m('left', 'gun', 0.62), m('right', 'gun', 0.38), m('right', 'gun', 0.62),
    // 舰艏 2 导弹(迎头对射) / 舰艉 2 机炮(追尾时也不会白送)
    m('front', 'missile', 0.35), m('front', 'missile', 0.65),
    m('rear', 'gun', 0.35), m('rear', 'gun', 0.65),
  ], // 机炮 10 / 导弹 6
  // === 阶段 2「加速」: 速度翻倍到 75, 导弹换到顶面(对空火力全开), 同时放热焰弹
  2: [
    // 顶面 4 导弹: 玩家躲在上半球就会被迎头打 —— 阶段 2 的压迫感来源
    m('top', 'missile', 0.18), m('top', 'missile', 0.38), m('top', 'missile', 0.62), m('top', 'missile', 0.82),
    // 底面 4 机炮: 上一阶段的底面导弹撤了, 换成便宜的机炮继续封下路
    m('bottom', 'gun', 0.18), m('bottom', 'gun', 0.38), m('bottom', 'gun', 0.62), m('bottom', 'gun', 0.82),
    // 两舷 2+2 导弹: 侧向也变成导弹, 减速贴身会挨得多
    m('left', 'missile', 0.38), m('left', 'missile', 0.62), m('right', 'missile', 0.38), m('right', 'missile', 0.62),
    // 舰艏 2 机炮(迎头泼弹幕) / 舰艉 2 导弹(拖尾追命)
    m('front', 'gun', 0.35), m('front', 'gun', 0.65),
    m('rear', 'missile', 0.35), m('rear', 'missile', 0.65),
  ], // 机炮 6 / 导弹 10
  // === 阶段 3「侧面对敌 + 激光」: 舰体转侧面亮出激光阵列, 用 6000m 半径慢慢绕圈
  3: [
    // 顶面: 2 组激光压在前后(各管一个半球) + 2 机炮居中补近防
    m('top', 'laser', 0.20), m('top', 'gun', 0.38), m('top', 'gun', 0.62), m('top', 'laser', 0.80),
    // 底面: 2 组激光 + 2 发射箱, 用 v 0.28/0.72 分两层错开, 免得网格穿模
    m('bottom', 'laser', 0.30, 0.72), m('bottom', 'laser', 0.70, 0.72),
    m('bottom', 'missile', 0.30, 0.28), m('bottom', 'missile', 0.70, 0.28),
    // 左右舷各 2 发射箱: 侧面对敌阶段"舷侧齐射"的主力
    m('left', 'missile', 0.38), m('left', 'missile', 0.62), m('right', 'missile', 0.38), m('right', 'missile', 0.62),
    // 艏艉各 2 机炮: 保证玩家绕到首尾方向也不是空档
    m('front', 'gun', 0.35), m('front', 'gun', 0.65),
    m('rear', 'gun', 0.35), m('rear', 'gun', 0.65),
  ], // 激光 4 / 机炮 6 / 导弹 6
  // === 阶段 4「核心暴露」: 顶面中部掀开 4 颗核心(唯一能杀死它的弱点), 其余武器变成背景火力
  4: [
    // 顶面: 4 核心聚在舰体中段(u 0.34..0.66, v 0.5) —— 玩家要从上方俯冲进来打, 这是设计的"最终考点"
    m('top', 'core', 0.34), m('top', 'core', 0.44), m('top', 'core', 0.56), m('top', 'core', 0.66),
    // 顶面两端留给激光: 核心区被俯冲时, 前后激光负责把玩家从顶上赶走
    m('top', 'laser', 0.18), m('top', 'laser', 0.82),
    // 底面 2 激光(与阶段 3 同位置, 形成延续感)
    m('bottom', 'laser', 0.38), m('bottom', 'laser', 0.62),
    // 左右舷各 2 机炮: 近防密度提高, 持久战里拖住玩家的血量
    m('left', 'gun', 0.38), m('left', 'gun', 0.62), m('right', 'gun', 0.38), m('right', 'gun', 0.62),
    // 艏艉各 2 发射箱: 玩家掉头爬升脱离时追着打
    m('front', 'missile', 0.35), m('front', 'missile', 0.65),
    m('rear', 'missile', 0.35), m('rear', 'missile', 0.65),
  ], // 核心 4 / 激光 4 / 机炮 4 / 导弹 4
};

/**
 * 换阶段: 清空 mountRoot 并按 STAGE_LOADOUTS[stage] 重建 16 个挂点, 返回与表顺序一致的数组。
 * 旧挂点整体丢弃(不 dispose): 一局最多切 3 次, 泄漏量可以忽略, 而共享材质(hull/dark/glow)
 * 一旦 dispose 会连新挂点一起变黑 —— 不 dispose 反而更安全。
 */
export function applyStageLoadout(model: DreadnoughtModel, stage: 1 | 2 | 3 | 4): DreadnoughtMount[] {
  for (const c of model.mountRoot.children.slice()) model.mountRoot.remove(c);
  const isAlly = model.ally === true;
  const mats: BuildMats = {
    hull: model.hullMat,
    dark: new THREE.MeshStandardMaterial({ color: 0x22262c, metalness: 0.6, roughness: 0.5 }),
    glow: new THREE.MeshBasicMaterial({ color: isAlly ? 0x66ccff : 0xff8844 }),
  };
  const defs = STAGE_LOADOUTS[stage];
  const out: DreadnoughtMount[] = [];
  for (let i = 0; i < defs.length; i++) {
    const d = defs[i];
    const { pos, normal } = faceAnchor(d.face, d.u, d.v, model.hullFrame);
    const built = buildMountMesh(d.kind, isAlly, mats);
    const cg = built.group;
    orientMountToFace(cg, d.face);
    cg.position.copy(pos);
    cg.userData.mountIndex = i;
    // 包围球半径: 先算一次自身包围盒(此时还没 parent, updateMatrixWorld 走自己的局部矩阵即可),
    // 取 0.6 倍包围球 —— 挂点有长达 88m 的炮管, 用包围盒最大半径当命中球太宽容, 0.6 是"炮塔本体"的经验折中。
    cg.updateMatrixWorld(true);
    _box.setFromObject(cg);
    _box.getBoundingSphere(_sphere);
    const radius = Math.max(10, _sphere.radius * 0.6);
    model.mountRoot.add(cg);
    out.push({
      mesh: cg,
      kind: d.kind,
      hp: DREADNOUGHT_MOUNT_HP,
      maxHp: DREADNOUGHT_MOUNT_HP,
      alive: true,
      fireTimer: 0,
      charge: 0,
      localPos: pos,
      normal,
      radius,
      index: i,
    });
  }
  return out;
}

// === 用户给的 FBX 主舰 (per user request: "boss的空中战舰模型换成这个并等比放大") ==========
//
// 模型事实(用 three 的 FBXLoader 在 Node 里量过): 单网格 24480 顶点 / 8160 三角面 / 1 个材质 +
// 内嵌贴图; 尺寸 119 x 90 x 38, **长轴是 X**, 且高度 90 里绝大部分是桅杆/上层建筑 —— 舰体只占
// 底部一条(顶点投影看, 宽甲板带集中在 y 的底部 ~30%)。所以:
//   · 摆正: 绕 Y 转 -90° 把长轴 X 变成我们的 Z(舰艏 +Z), 再等比缩放到目标舰长;
//   · 挂点盒(hullFrame) 只取**底部 30% 高度**那一层当甲板, 武器不会摆到桅杆上去。
//
// === 为什么主资产不再是那个 39.8MB 的 FBX (per user request: file:// 双击也要用真模型) ====
// 原实现只载 /models/airship/bastion.fbx: 39.8MB 太大不能内联, 只能随行放 <out>/assets/
// 走 http 取 —— 玩家**双击单文件**(file://)时读不到, 于是回退程序化盒子。用户反馈:
// "boss 空中战舰还是用原来的而不是 fbx 模型"。
//
// 现在主资产 = **可内联的小文件三件套**, 由 scripts/bastion-to-obj.mjs 从**同一个 FBX**
// 构建期导出(不是重制模型, 是同一个网格换容器):
//   · /models/airship/bastion.obj(.gz)  文本几何(v/vt/vn + usemtl bastion), gzip 5.2× →
//     base64 0.97MiB, file:// 下走 <img>/XHR 可读的内联 data URI
//   · /models/airship/bastion.mtl       单个材质, 唯一作用是"albedo 文件名"的真相源
//   · /models/airship/bastion_albedo.jpg 原内嵌贴图(浏览器 canvas 提取, 降采样到 2048²)
// 加载顺序: OBJ 三件套(内联, 任何环境可用) → FBX(随行, http 部署的兜底) → 程序化盒子。
export const BASTION_OBJ = '/models/airship/bastion.obj';
export const BASTION_MTL = '/models/airship/bastion.mtl';
/** 贴图目录约定(与 f16c.ts 的 TEX_DIR 同): MTL 里只写文件名, 目录由代码拼。 */
export const BASTION_TEX_DIR = '/models/airship/';
/** 模型朝向修正(弧度): 见 buildDreadnoughtFromModel 里的说明。 */
export const BASTION_YAW = Math.PI / 2;
/** 舰艉在世界/舰体本地空间的那一侧(+1 = +Z, -1 = -Z)。艏在 +Z 时艉就是 -Z。
 *  后燃器摆在哪一端、往哪喷, 全部由它推导 —— 这样"翻朝向"只需要改 BASTION_YAW 一处。 */
export const BASTION_STERN_SIGN = -1;
export const BASTION_FBX = '/models/airship/bastion.fbx';
/** 舰体层占模型总高的比例 —— **仅作为量不出几何时的兜底**(见 measureHullFrame)。
 *  实测 bastion.obj: 舰体占底部 27.5%, 上面 72% 全是一把细长刀片(桅杆/上层建筑, 水平半径 49 x 0.4),
 *  所以"用比例猜"和"用量出来的"差得不多, 但量出来的才是模型自己的碰撞盒。 */
const HULL_BAND = 0.30;
/** === 碰撞盒相对舰体的收缩系数 (per user request: 碰撞盒等比缩小一中圈) =================
 *  0.8 = 每边缩 20%(观感"小一中圈"); 想再小就把这个数往下调(0.7 更小), 只影响**碰撞**,
 *  不影响挂点摆放与模型显示 —— 挂点仍然严格贴在甲板面上。 */
export const HULL_COLLIDE_SHRINK = 0.8;
/** 判定"这一层属于舰体"的水平半径阈值(占最大水平半径的比例) —— 桅杆细, 一眼能滤掉。 */
const HULL_EXTENT_THRESHOLD = 0.45;

/**
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
  // === 分段包络: 沿 Z(长轴)切 16 段, 每段量自己的 x/y 半宽 ========================
  // 只统计舰体带内的点(桅杆已被排除), 于是得到"跟着舰体收窄"的形状而不是一个大盒子。
  const NSEG = 16;
  const segLen = (half.z * 2) / NSEG;
  const segs: { zFrac: number; halfLen: number; hx: number; hy: number }[] = [];
  for (let i = 0; i < NSEG; i++) {
    const z0 = center.z - half.z + i * segLen;
    const z1 = z0 + segLen;
    let hx = 0, hy = 0, n = 0;
    for (const v of pts) {
      if (v.y > hullTopY || v.z < z0 || v.z >= z1) continue;
      hx = Math.max(hx, Math.abs(v.x - center.x));
      hy = Math.max(hy, Math.abs(v.y - center.y));
      n++;
    }
    if (n === 0) continue;   // 空段(理论上没有)直接跳过
    segs.push({
      zFrac: (z0 + z1) / 2 - center.z,
      halfLen: segLen / 2,
      hx: Math.max(1e-3, hx),
      hy: Math.max(1e-3, hy),
    });
  }
  return { half, center, segments: segs.length > 0 ? segs : undefined };
}

/** 主舰模型实际来自哪条路径(引擎读它上报/回归测试断言, 见 engine.bossFbxSource)。 */
export type BastionSource = 'obj' | 'fbx' | 'procedural';
/** loadBastionModel() 的产物: 模型 + 它来自哪条路径。 */
export interface BastionLoad {
  obj: THREE.Object3D;
  source: BastionSource;
}

/** 贴图统一走 sRGB(否则颜色会偏暗/偏灰) + 正面渲染(FBX 导出常带 DoubleSide)。 */
function normalizeBastionMaterials(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[] | undefined;
    if (!m) return;
    for (const mm of Array.isArray(m) ? m : [m]) {
      if (mm.map) mm.map.colorSpace = THREE.SRGBColorSpace;
      mm.side = THREE.FrontSide;
    }
  });
}

/**
 * 主路径: OBJ + MTL + albedo JPEG(三件套都内联进单文件)。
 *
 * 与 f16c.ts 同一条取数链: fetchTextAsset(自动取 .gz + pako.inflate) → OBJLoader.parse;
 * 贴图用 loadImageTexture(<img> 而不是 TextureLoader —— file:// 下 fetch 被禁而 <img> 放行,
 * 详见 fetch-asset.ts 的注释)。
 *
 * 贴图只认 MTL 的 map_Kd(和 3D 管线一致): 换贴图只要改/覆盖这两份文件, 不用改代码。
 * 贴图拿不到时**保留几何**(灰金属)而不是整艘退回盒子 —— 但会在控制台 warn, 不静默。
 */
async function buildBastionFromObj(): Promise<THREE.Object3D> {
  const [objText, mtlText] = await Promise.all([
    fetchTextAsset(BASTION_OBJ),
    fetchAssetText(assetUrl(BASTION_MTL)).catch(() => ''),
  ]);
  const texFile = /^\s*map_Kd\s+(\S+)/m.exec(mtlText)?.[1] ?? 'bastion_albedo.jpg';
  const mat = new THREE.MeshStandardMaterial({
    name: 'bastion',
    metalness: 0.5,
    roughness: 0.55,
    side: THREE.FrontSide,
  });
  try {
    const map = await loadImageTexture(assetUrl(BASTION_TEX_DIR + texFile), true);
    map.colorSpace = THREE.SRGBColorSpace;
    mat.map = map;
  } catch (e) {
    console.warn('[bastion] albedo 贴图载入失败, 舰体退成无贴图金属材质:', e);
  }
  const obj = new OBJLoader().parse(objText);
  // 单材质(OBJ 里只有一个 usemtl bastion): 直接换成交付贴图的 PBR 材质,
  // 这样受击闪烁/阵亡变暗(引擎改的是 hullMat)能作用在舰体上。
  obj.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = mat;
  });
  return obj;
}

/** 兜底路径: 交付件 FBX 本体(39.8MB, 只可能来自 <out>/assets/ 的 http 部署)。 */
async function buildBastionFromFbx(): Promise<THREE.Object3D> {
  const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
  const obj = await new FBXLoader().loadAsync(assetUrl(BASTION_FBX));
  // 贴图是内嵌的: 让它们走 sRGB, 否则颜色会偏暗/偏灰
  normalizeBastionMaterials(obj);
  return obj;
}

/** 加载主舰模型(单例缓存)。优先级 OBJ 三件套 → FBX → null(调用方回退程序化舰体)。 */
let _bastionPromise: Promise<BastionLoad | null> | null = null;
export function loadBastionModel(): Promise<BastionLoad | null> {
  if (_bastionPromise) return _bastionPromise;
  _bastionPromise = (async () => {
    try {
      const obj = await buildBastionFromObj();
      normalizeBastionMaterials(obj);
      console.info('[bastion] OBJ 载入成功:', BASTION_OBJ);
      return { obj, source: 'obj' as const };
    } catch (e) {
      console.warn('[bastion] OBJ 载入失败, 改试 FBX:', e);
    }
    try {
      const obj = await buildBastionFromFbx();
      console.info('[bastion] FBX 载入成功(OBJ 不可用时的兜底):', BASTION_FBX);
      return { obj, source: 'fbx' as const };
    } catch (e) {
      console.warn('[bastion] FBX 也失败, 回退程序化舰体:', e);
      return null;
    }
  })();
  return _bastionPromise;
}

/**
 * 用 FBX 模型建主舰: 摆正(长轴转到 Z) -> 等比缩放到目标舰长 -> 把**舰体底部**对到原点,
 * 再套一个与前作同构的 DreadnoughtModel(挂点容器/舰体盒/材质都从模型量出来)。
 */
export function buildDreadnoughtFromModel(src: THREE.Object3D, isAlly: boolean): DreadnoughtModel {
  const group = new THREE.Group();
  const mountRoot = new THREE.Group();       // 无变换: 挂点在舰体本地坐标里
  // === 必须**克隆**一份再改 (per bug: 重开关卡后主舰变形、组件跑没、运镜找不到目标) ==========
  // loadBastionModel() 带缓存, 返回的是**同一个** Object3D 模板; 而下面要改它的 rotation/scale/position
  // (而且是 *= / -= 这种**相对**修改) —— 直接改模板会让这些变换**逐局累积**: 第二局舰体被
  // 又乘一次缩放、又偏一次位置, 于是越重开越大越歪, 挂在它身上的组件自然"不见了",
  // 过场相机也是按量出来的包围盒取景的, 目标一变就飞了。克隆之后模板永远干净。
  const model = src.clone(true);
  // 1) 摆正: 长轴 X -> Z
  // === 舰艏朝哪一头 (per user request: 主舰的前后前进方向反了) =====================
  // 我用几何量出来的结论是"模型的尖头在 +X", -90 度把它转到 +Z(引擎的机头方向);
  // 但用户在画面里看到舰体是"倒着飞" => 换成 +90 度, 让**另一头**朝前。
  // 两个值都试过: BASTION_YAW = -PI/2(尖头朝前) / +PI/2(尖头朝后)。改这一处即可,
  // 后燃器的艉端与喷向会自动跟着走(见 engine 里 BASTION_STERN_SIGN 的推导)。
  model.rotation.y = BASTION_YAW;
  model.updateMatrixWorld(true);
  // 2) 等比缩放到目标舰长
  const raw = new THREE.Box3().setFromObject(model);
  const rawSize = raw.getSize(new THREE.Vector3());
  const targetLen = DREADNOUGHT_SIZE.len;
  const k = targetLen / Math.max(1e-3, rawSize.z);
  model.scale.multiplyScalar(k);
  model.updateMatrixWorld(true);
  // 3) 居中 X/Z, 并把舰体底部对齐到 y = -hullHalfY(与 faceAnchor 的原点约定一致)
  const box = new THREE.Box3().setFromObject(model);
  const frame = hullFrameFromObject(model);
  model.position.x -= (box.min.x + box.max.x) / 2;
  model.position.z -= (box.min.z + box.max.z) / 2;
  model.position.y -= frame.center.y - frame.half.y;   // 让甲板盒以原点为中心
  group.add(model);
  group.add(mountRoot);
  group.traverse((o) => { (o as THREE.Object3D & { _env?: boolean })._env = true; });

  // 舰体材质: 借用模型自己的材质(受击闪烁/阵亡变暗会作用在它上面), 拿不到就退回一个金属材质
  let hullMat: THREE.MeshStandardMaterial | null = null;
  model.traverse((o) => {
    const mm = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (!hullMat && mm && (mm as THREE.MeshStandardMaterial).isMeshStandardMaterial) hullMat = mm;
  });
  const fallback = new THREE.MeshStandardMaterial({ color: isAlly ? 0x5a6b7c : 0x6b5a52, metalness: 0.55, roughness: 0.55 });
  const half = frame.half.clone();
  return {
    group,
    mountRoot,
    hullMat: hullMat ?? fallback,
    size: { len: half.z * 2, wid: half.x * 2, hei: half.y * 2 },
    hull: { radius: half.length() * 0.62, half },
    hullFrame: frame,
    ally: isAlly,
  };
}

// === 无人机 ======================================================================

/**
 * 自杀式无人机(≈5m, 三角扁机体 + 小翼 + 尾部发光 + 2 根细天线)。
 * 刻意只用 5 个 mesh: 用户要求"几十架同时在场", 每架再贵一点都会变成 draw call 灾难;
 * 引擎那边(建议)用 InstancedMesh 或对象池复用本函数产出的 group。
 */
export function buildDrone(isAlly: boolean): THREE.Group {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({
    color: isAlly ? 0x5a6b7c : 0x4a4238,
    metalness: 0.5,
    roughness: 0.55,
  });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x22262c, metalness: 0.6, roughness: 0.5 });
  const glowMat = new THREE.MeshBasicMaterial({ color: isAlly ? 0x66ccff : 0xff7733 });

  // 扁三角机体: 圆锥轴转到 +Z(锥尖 = 机头), 再把**局部 Z**压扁 => 世界 Y 方向变扁(缩放先于旋转, 所以压 z 才是压高度)
  const body = new THREE.Mesh(new THREE.ConeGeometry(1.7, 4.4, 8), bodyMat);
  body.rotation.x = Math.PI / 2;
  body.scale.z = 0.4;
  g.add(body);
  // 小三角翼: 只做一块平板, 几十架同时飞时看不出细节差别
  const wing = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.22, 1.4), bodyMat);
  wing.position.z = -0.7;
  g.add(wing);
  // 尾部发动机辉光(朝后, 玩家从后面追时最显眼)
  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 6), glowMat);
  glow.position.z = -2.1;
  g.add(glow);
  // 2 根细天线(剪影特征: 让无人机和导弹在同一帧里能被区分)
  for (const sx of [-1, 1]) {
    const ant = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.1, 0.07), darkMat);
    ant.position.set(sx * 1.25, 0.35, -1.5);
    ant.rotation.z = sx * 0.28;
    g.add(ant);
  }
  g.traverse((o) => { (o as THREE.Object3D & { _env?: boolean })._env = true; });
  return g;
}

// === 运动 AI =====================================================================
// 只有四个阶段, 没有模式切换计时器: 阶段由剧情推进, 行为完全确定。
// 与轻型战舰同一套哲学: 速度/航向都走大惯性(慢 lerp), 航向角速度一律钳到很小, 垂直方向只给几 m/s。

export interface DreadnoughtMotionState {
  /** 高度目标(离地 >= DREADNOUGHT_MIN_AGL), 自身也慢 lerp 防止高度抖 */
  targetY: number;
  /** 本阶段的目标巡航速度(m/s) —— 引擎可读(音效/HUD) */
  speed: number;
  /** 实际速度(大惯性缓动值) */
  speedNow: number;
  /** 阶段 2 的俯仰摆角(弧度)。**引擎读它**加到 group 的朝向上(绕 X 或 Z), 本模块不动 group */
  pitch: number;
  /** 阶段 2 正在释放热焰弹 => 引擎据此生成热焰弹视觉/干扰导弹锁定 */
  flares: boolean;
  /** 阶段 4 全武器持续齐射 => 引擎据此把 fireTimer 全部清零并连续开火 */
  salvo: boolean;
  /** 阶段 4 点燃后燃器(引擎据此开尾焰 + 播轰鸣 + 把舰体往战场外推) */
  burn: boolean;
  /** 侧面对敌的绕行方向: +1 = 右舷朝玩家, -1 = 左舷朝玩家(顺/逆时针由它决定) */
  orbitSign: number;
  /** 基准航向(阶段 1/2 直飞用; 阶段 3/4 每帧被侧面对敌解算覆盖) */
  desiredHeading: number;
  /** 内部计时(驱动俯仰摆动与航向微调的正弦相位) */
  t: number;
  /** 上一帧的地形高度(算地形抬升率用); 建状态时是 NaN, 第一帧自动补上 */
  lastTerrainY: number;
}

export function makeDreadnoughtMotion(heading: number): DreadnoughtMotionState {
  return {
    targetY: 0,
    speed: DREADNOUGHT_SPEED.cruise,
    speedNow: DREADNOUGHT_SPEED.cruise,
    pitch: 0,
    flares: false,
    salvo: false,
  burn: false,
    orbitSign: Math.random() < 0.5 ? -1 : 1,
    desiredHeading: heading,
    t: Math.random() * 60, // 随机相位: 两艘「堡垒」不会同拍摆动
    lastTerrainY: NaN, // 第一帧由 updateDreadnoughtMotion 填
  };
}

/** 把角度折到 (-PI, PI] —— 航向差必须走短弧, 否则 359° -> 1° 会绕一大圈 */
function wrapPi(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// 每帧复用的临时向量(updateDreadnoughtMotion 里一次都不 new)
const _want = new THREE.Vector3();

/**
 * 「堡垒」的运动 AI。四个阶段:
 *   1 直线巡航: 35 m/s, 只做 3° 以内的正弦航向微调 —— "不改变航线的靶子", 让玩家熟悉它的体积
 *   2 加速:     75 m/s, 叠加缓慢俯仰摆动(写进 st.pitch 给引擎) + st.flares = true
 *   3 侧面对敌: 解算"舰侧面对玩家"的目标航向, 以 ~6000m 半径慢慢绕圈(航向角速度钳 0.02 rad/s)
 *   4 核心暴露: 降到 25 m/s 保持侧面对敌漂移 + st.salvo = true(引擎据此全武器连射)
 *
 * 高度恒有"离地 >= DREADNOUGHT_MIN_AGL", 垂直修正只给几 m/s(900m 的船不能瞬间拉起来)。
 * 本函数只写 pos / vel / headingRef.heading —— 引擎拿这三个值去驱动 group, 绝不能在这里碰 group。
 *
 * @param terrainY 舰体所在水平位置的地形高度(米)
 * @param playerPos 玩家位置(阶段 3/4 侧面对敌用; 不传就退化成直飞)
 */
export function updateDreadnoughtMotion(
  pos: THREE.Vector3,
  vel: THREE.Vector3,
  headingRef: { heading: number },
  st: DreadnoughtMotionState,
  dt: number,
  terrainY: number,
  stage: number,
  playerPos?: THREE.Vector3,
): void {
  st.t += dt;

  // === 目标速度: 大惯性(时间常数 ~10s) —— 阶段 2 的"加速"是慢慢加上去的, 阶段 4 也是慢慢滑停下来 ==
  const speedTarget =
    stage <= 1 ? DREADNOUGHT_SPEED.cruise :
    stage === 2 ? DREADNOUGHT_SPEED.accel :
    stage === 3 ? DREADNOUGHT_SPEED.broadside :
    DREADNOUGHT_SPEED.escape;
  st.speed = speedTarget;
  st.speedNow += (speedTarget - st.speedNow) * Math.min(1, dt * 0.1);

  // === 阶段行为: 期望航向 + 阶段标志 ===========================================
  st.flares = stage === 2;
  st.salvo = stage === 4;
  // 阶段 4: 核心暴露 -> 点燃后燃器加速逃离(per user request: 打开后燃器, 轰鸣, 加速逃离)
  st.burn = stage >= 4;
  let desired: number;
  if (stage <= 1) {
    // 直线巡航: 只做极小航向微调(振幅 3°, 周期 ~140s), 看着像在"修正航线"而不是笔直贴在轨道上
    desired = st.desiredHeading + Math.sin(st.t * 0.045) * (Math.PI * 3 / 180);
  } else if (stage === 2) {
    // 加速: 俯仰摆动(振幅 4°, 周期 ~40s); 只写 st.pitch, 舰体姿态由引擎施加
    st.pitch = Math.sin(st.t * 0.16) * (Math.PI * 4 / 180);
    desired = st.desiredHeading + Math.sin(st.t * 0.03) * (Math.PI * 2 / 180);
  } else {
    // 侧面对敌(阶段 3/4): 让**舰体侧面**正对玩家。
    // 航向 h 时右舷方向 = (cos h, 0, -sin h)(绕 Y 转 h 作用在 +X 上); 要求它朝向玩家的方位角 b,
    // 解出 h = b - 90°(左舷对敌则是 b + 90°)。而"垂直于方位线"恰好就是绕玩家画圆的切线方向,
    // 所以"侧面对敌"和"大半径绕行"是同一件事 —— 不需要再额外算轨道。
    // 半径修正: 离得太远就把航向往玩家方向掰一点(最多 0.6 rad), 把 6000m 的圈维持住。
    let b = headingRef.heading;
    if (playerPos) {
      const dx = playerPos.x - pos.x;
      const dz = playerPos.z - pos.z;
      b = Math.atan2(dx, dz); // 与引擎一致: heading 0 => +Z
      const dist = Math.max(1, Math.hypot(dx, dz));
      const err = THREE.MathUtils.clamp((dist - DREADNOUGHT_ORBIT_R) / DREADNOUGHT_ORBIT_R, -0.6, 0.6);
      desired = b - st.orbitSign * (Math.PI / 2 - err);
    } else {
      // 没有玩家坐标时退化成直飞(引擎忘了传参也不会 NaN 或原地打转)
      desired = st.desiredHeading;
    }
    st.desiredHeading = desired;
  }
  // 阶段 2 之外的俯仰一律平滑收回到水平 —— 放在分支外, 免得"没传 playerPos"时歪着飞出去
  if (stage !== 2) st.pitch += (0 - st.pitch) * Math.min(1, dt * 0.5);

  // === 航向: 一律先钳角速度, 再积分 =============================================
  // 阶段 3/4 的绕行需要 ω = v / R = 60 / 6000 = 0.01 rad/s, 只有钳位(0.02)的一半 =>
  // "标称速度下真的转得过来", 钳位只用来限制瞬态(比如玩家从一侧瞬移到另一侧)。
  // 阶段 1/2 再砍一半: 那两阶段的船"几乎不该拐弯", 微调幅度也必须小。
  const yawCap = (stage <= 2) ? DREADNOUGHT_MAX_YAW * 0.5 : DREADNOUGHT_MAX_YAW;
  // 绕行前馈: 目标航向自己就在以 ω = v / R 的速度转(绕玩家一圈), 纯比例控制必然永远落后一点点
  // (表现就是"侧面对敌"始终差个二三十度)。所以把这一项直接加进期望角速度里 —— 比例项只负责修偏差。
  const orbitFeed = (stage <= 2) ? 0 : -st.orbitSign * (st.speedNow / DREADNOUGHT_ORBIT_R);
  const yawRate = THREE.MathUtils.clamp(wrapPi(desired - headingRef.heading) * 0.2 + orbitFeed, -yawCap, yawCap);
  headingRef.heading = wrapPi(headingRef.heading + yawRate * dt);

  // === 水平速度: 慢慢转到"机头方向 x 当前速度" ==================================
  const k = Math.min(1, dt * 0.1);
  _want.set(Math.sin(headingRef.heading) * st.speedNow, 0, Math.cos(headingRef.heading) * st.speedNow);
  vel.x += (_want.x - vel.x) * k;
  vel.z += (_want.z - vel.z) * k;

  // === 高度: 只保证"离地 >= MIN_AGL", 垂直方向给 5 m/s 上限 ======================
  // 目标高度自己也是慢 lerp, 所以地形起伏不会让 900m 的舰体上下弹跳; 已经低于下限就立刻取下限(安全兜底)。
  // 爬升上限额外叠加"地形抬升率": 山地以 40m/s 迎面追上来时, 死守 5m/s 一定会被按进山里 ——
  // 所以下限这一条改成"最多以(地形抬升 + 5) m/s 往上跟", 下降仍然死卡 5 m/s(绝不主动俯冲)。
  // 这样常规地形下升降都还是几 m/s 的"大惯性", 只有地形真的在往上顶时才被动一起爬。
  if (Number.isNaN(st.lastTerrainY)) st.lastTerrainY = terrainY;
  const rise = THREE.MathUtils.clamp((terrainY - st.lastTerrainY) / Math.max(dt, 1e-4), 0, 200);
  st.lastTerrainY = terrainY;
  const minY = terrainY + DREADNOUGHT_MIN_AGL;
  st.targetY = Math.max(minY, st.targetY * 0.997 + minY * 0.003);
  if (pos.y < minY) st.targetY = minY;
  vel.y = THREE.MathUtils.clamp(st.targetY - pos.y, -5, 5 + rise);

  pos.addScaledVector(vel, dt);
}
