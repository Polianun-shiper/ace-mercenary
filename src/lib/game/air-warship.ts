// === 空中战舰 · 单位与组件 (per user request) =====================================
//
// 用户: "设计空中战舰单位和附属 ai。默认模型大概和横着放着的巨型长方形差不多, 有碰撞体积;
//        运动 ai 单独设计: 只以超大半径盘旋或调整方向直行, 与地面保持一定距离(最低离地两千米),
//        大惯性、较弱机动转向能力; 在法线方向上布置类似地面导弹发射器 ai 和机炮 ai 的组件;
//        组件跟着战舰走(装在上面不动); 轻型 6 个组件, 打完爆炸, 以原惯性落到地面大爆炸消失;
//        敌对阵营的可被玩家锁定攻击, 敌我关系与攻击逻辑套用地面单位; 敌我刷新率约 28%"。
//
// 设计:
//   · 舰体 = 一块**横放的巨型长方形**(长沿 Z、宽沿 X), 加舰桥/发动机/垂尾做剪影; 提供碰撞球半径。
//   · 6 个组件**按各自所在面的外法线布置**(顶面 +Y ×4 / 底面 -Y ×2), 直接 parent 到舰体 group
//     ⇒ 跟着战舰走, 自己不动(只有炮塔自身可以小幅转向瞄准, 位置永远不变)。
//   · 运动 AI(见 updateAirWarshipMotion): 两种状态 —— **超大半径盘旋**(半径 ~5km) 与
//     **调整方向后直行**; 高度保持"离地 ≥ 2000m"; 速度/朝向都走大惯性(慢 lerp), 转向率被钳在 ~3°/s。
//   · 组件/摧毁: 组件数量与 HP 挂钩(每掉 1/6 血摧毁一个组件), 6 个全毁 ⇒ 舰体爆炸 + 以原速度惯性坠落,
//     触地再大爆炸并消失。这样"锁定/攻击/伤害/击杀"完全复用引擎已有的地面单位管线, 不需要新目标系统。
import * as THREE from 'three';

// 'laser' | 'core' 是主舰「堡垒」用的(per user request): 激光炮需要充能/持续照射,
// 核心模块是被打掉才算阶段完成的弱点, 自身不开火。
export type AirWarshipComponentKind = 'gun' | 'missile' | 'laser' | 'core';

export interface AirWarshipComponent {
  /** 组件本体(炮塔/发射箱): 已挂在舰体 group 上, 位置固定 */
  mesh: THREE.Group;
  kind: AirWarshipComponentKind;
  hp: number;
  maxHp: number;
  alive: boolean;
  /** 开火冷却(秒) */
  fireTimer: number;
  /** 该组件所在面的外法线(舰体本地空间) —— 布置方向 */
  normal: THREE.Vector3;
  // === 作为**独立单位**用的数据 (per user request: 组件是"分散开来的附属组件单位") =====
  /** 组件在舰体本地空间的位置 —— 引擎每帧用它算出组件的世界坐标(供锁定/命中/雷达框) */
  localPos: THREE.Vector3;
  /** 命中/雷达框用的包围球半径(米) */
  radius: number;
  /** 激光充能进度 0..1(仅 kind === 'laser' 有意义) */
  charge?: number;
  /** 挂点序号(主舰装载表里 0..15, 剧情台词按它对应"刺猬N/长矛N") */
  index?: number;
}

export interface AirWarshipModel {
  group: THREE.Group;
  components: AirWarshipComponent[];
  /** 碰撞体积: 包围球半径 + 半长宽高(供机体碰撞/命中判定用) */
  hull: { radius: number; half: THREE.Vector3 };
  size: { len: number; wid: number; hei: number };
  /** 舰体主材质(受击闪烁/阵亡变暗用) */
  hullMat: THREE.MeshStandardMaterial;
}

/** 基础尺寸(世界单位 = 米)。横放的巨型长方形。 */
const AIR_WARSHIP_BASE = { len: 96, wid: 26, hei: 16 };
/** === 体积倍率 (per user request: "体积要翻10倍才够大") ==========================
 *  体积 ×10 ⇒ 线度 ×10^(1/3) ≈ 2.154(长 207m / 宽 56m / 高 34.5m)。
 *  如果哪天想要"线度直接 ×10", 把这里改成 10 就行 —— 全模块只认这一个乘数。 */
export const AIR_WARSHIP_SCALE = Math.cbrt(10) * 3;
/** 轻型空中战舰尺寸(已含倍率)。
 *  (per user request: 体积 x10 之后, 这一轮再按**长宽高各 x3** -> 乘数 = cbrt(10) x 3 = 6.463,
 *   基础 96x26x16 于是变成约 620x168x103 米 —— 与主舰同一套约定。) */
export const AIR_WARSHIP_SIZE = {
  len: AIR_WARSHIP_BASE.len * AIR_WARSHIP_SCALE,
  wid: AIR_WARSHIP_BASE.wid * AIR_WARSHIP_SCALE,
  hei: AIR_WARSHIP_BASE.hei * AIR_WARSHIP_SCALE,
};
/** 组件数量(轻型) */
export const AIR_WARSHIP_COMPONENTS = 6;
/** 最低离地高度(米) —— 用户要求 2000 */
export const AIR_WARSHIP_MIN_AGL = 2000;
/** === 速度 (per user request: "速度翻5倍") ====================================
 *  38 × 5 = 190 m/s。盘旋半径同样 ×5, 于是**角速度与转向手感保持原样**
 *  (只是整体快了 5 倍), 不会因为提速就变成灵活战斗机。 */
export const AIR_WARSHIP_SPEED = 190;
/** 盘旋半径(米) —— "超大半径", 随速度同步 ×5 以保住原来的转向角速度 */
export const AIR_WARSHIP_ORBIT_R = 26000;
/** 最大转向率(rad/s) —— "较弱的机动转向能力" ≈ 2.6°/s */
export const AIR_WARSHIP_MAX_YAW = 0.045;


/**
 * 造一艘空中战舰。isAlly 只影响配色(敌红/友蓝), 敌我关系由引擎的地面单位管线决定。
 */
/** 我方空中战舰的两种配置 (per user request: 有多个导弹发射器的, 也有多个防空炮的) */
export type AirWarshipVariant = 'missile' | 'gun';

export function buildAirWarship(isAlly: boolean, scale = 1, variant: AirWarshipVariant = 'missile'): AirWarshipModel {
  const s = AIR_WARSHIP_SIZE;
  const group = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({
    color: isAlly ? 0x5a6b7c : 0x6b5a52,
    metalness: 0.55,
    roughness: 0.55,
    flatShading: false,
  });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a3038, metalness: 0.6, roughness: 0.5 });
  const glowMat = new THREE.MeshBasicMaterial({ color: isAlly ? 0x66ccff : 0xff8844 });

  // === 主体: 横放的巨型长方形 ==================================================
  const hull = new THREE.Mesh(new THREE.BoxGeometry(s.wid, s.hei, s.len), hullMat);
  group.add(hull);
  // 舰艏斜切 + 舰艉方块(让它不是纯方砖, 但整体仍是"横放的长方形")
  const prow = new THREE.Mesh(new THREE.BoxGeometry(s.wid * 0.7, s.hei * 0.7, s.len * 0.14), hullMat);
  prow.position.set(0, -s.hei * 0.1, s.len * 0.55);
  group.add(prow);
  // 舰桥(上表面偏后)
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(s.wid * 0.42, s.hei * 0.7, s.len * 0.16), hullMat);
  bridge.position.set(0, s.hei * 0.75, -s.len * 0.26);
  group.add(bridge);
  // 垂尾/天线(增强"战舰"剪影)
  const fin = new THREE.Mesh(new THREE.BoxGeometry(1.6, s.hei * 1.5, s.len * 0.12), darkMat);
  fin.position.set(0, s.hei * 1.2, -s.len * 0.42);
  group.add(fin);
  // 尾部推进器 ×2(发光圆盘)
  for (const sx of [-1, 1]) {
    const eng = new THREE.Mesh(new THREE.CylinderGeometry(s.wid * 0.16, s.wid * 0.16, 2.4, 12), darkMat);
    eng.rotation.x = Math.PI / 2;
    eng.position.set(sx * s.wid * 0.24, 0, -s.len * 0.52);
    group.add(eng);
    const glow = new THREE.Mesh(new THREE.CircleGeometry(s.wid * 0.13, 14), glowMat);
    glow.position.set(sx * s.wid * 0.24, 0, -s.len * 0.54);
    glow.rotation.y = Math.PI;
    group.add(glow);
  }

  // === 6 个组件: 按所在面的**外法线**布置 =======================================
  // 顶面 4 个(+Y): 2 个机炮(前后各一) + 2 个导弹发射箱(左右)
  // 底面 2 个(-Y): 2 个机炮(对下/对地压制)
  // === 我方舰: 6 个部件**全部是导弹发射器** (per user request: 我方的空中战舰增加到 6 个导弹发射器部位) ==
  // 敌我配置刻意做出区别: 我方是"导弹艇"—— 六个挂点全是发射箱, 靠齐射远距离压敌舰;
  // 敌方保持 4 机炮 + 2 导弹的混合配置。射程/伤害走各自阵营那一套(见 engine 的组件开火)。
  // 我方"防空炮型": 六个挂点全是机炮塔(上 4 + 下 2), 负责给主舰与友舰打伞;
  // 我方"导弹型"(默认): 六个挂点全是发射箱, 负责反舰齐射。两种混编出场。
  const allyGunDefs: { normal: THREE.Vector3; kind: AirWarshipComponentKind; pos: THREE.Vector3 }[] = [
    { normal: new THREE.Vector3(0, 1, 0), kind: 'gun', pos: new THREE.Vector3(0, s.hei / 2, s.len * 0.32) },
    { normal: new THREE.Vector3(0, 1, 0), kind: 'gun', pos: new THREE.Vector3(-s.wid * 0.30, s.hei / 2, s.len * 0.12) },
    { normal: new THREE.Vector3(0, 1, 0), kind: 'gun', pos: new THREE.Vector3(s.wid * 0.30, s.hei / 2, s.len * 0.12) },
    { normal: new THREE.Vector3(0, 1, 0), kind: 'gun', pos: new THREE.Vector3(0, s.hei / 2, -s.len * 0.22) },
    { normal: new THREE.Vector3(0, -1, 0), kind: 'gun', pos: new THREE.Vector3(-s.wid * 0.28, -s.hei / 2, s.len * 0.05) },
    { normal: new THREE.Vector3(0, -1, 0), kind: 'gun', pos: new THREE.Vector3(s.wid * 0.28, -s.hei / 2, s.len * 0.05) },
  ];
  const allyDefs: { normal: THREE.Vector3; kind: AirWarshipComponentKind; pos: THREE.Vector3 }[] = [
    { normal: new THREE.Vector3(0, 1, 0), kind: 'missile', pos: new THREE.Vector3(-s.wid * 0.30, s.hei / 2, s.len * 0.30) },
    { normal: new THREE.Vector3(0, 1, 0), kind: 'missile', pos: new THREE.Vector3(s.wid * 0.30, s.hei / 2, s.len * 0.30) },
    { normal: new THREE.Vector3(0, 1, 0), kind: 'missile', pos: new THREE.Vector3(-s.wid * 0.30, s.hei / 2, s.len * 0.02) },
    { normal: new THREE.Vector3(0, 1, 0), kind: 'missile', pos: new THREE.Vector3(s.wid * 0.30, s.hei / 2, s.len * 0.02) },
    { normal: new THREE.Vector3(0, 1, 0), kind: 'missile', pos: new THREE.Vector3(0, s.hei / 2, -s.len * 0.30) },
    { normal: new THREE.Vector3(0, -1, 0), kind: 'missile', pos: new THREE.Vector3(0, -s.hei / 2, -s.len * 0.10) },
  ];
  const defs: { normal: THREE.Vector3; kind: AirWarshipComponentKind; pos: THREE.Vector3 }[] = isAlly
    ? (variant === 'gun' ? allyGunDefs : allyDefs)
    : [
    { normal: new THREE.Vector3(0, 1, 0), kind: 'gun', pos: new THREE.Vector3(0, s.hei / 2, s.len * 0.30) },
    { normal: new THREE.Vector3(0, 1, 0), kind: 'gun', pos: new THREE.Vector3(0, s.hei / 2, -s.len * 0.06) },
    { normal: new THREE.Vector3(0, 1, 0), kind: 'missile', pos: new THREE.Vector3(-s.wid * 0.30, s.hei / 2, s.len * 0.14) },
    { normal: new THREE.Vector3(0, 1, 0), kind: 'missile', pos: new THREE.Vector3(s.wid * 0.30, s.hei / 2, s.len * 0.14) },
    { normal: new THREE.Vector3(0, -1, 0), kind: 'gun', pos: new THREE.Vector3(-s.wid * 0.28, -s.hei / 2, 0) },
    { normal: new THREE.Vector3(0, -1, 0), kind: 'gun', pos: new THREE.Vector3(s.wid * 0.28, -s.hei / 2, 0) },
  ];
  const components: AirWarshipComponent[] = [];
  for (let i = 0; i < Math.min(AIR_WARSHIP_COMPONENTS, defs.length); i++) {
    const d = defs[i];
    const cg = new THREE.Group();
    // 基座(贴合所在面)
    const base = new THREE.Mesh(new THREE.BoxGeometry(s.wid * 0.16, 1.2, s.wid * 0.16), darkMat);
    cg.add(base);
    if (d.kind === 'gun') {
      // 机炮: 炮塔 + 双管
      const turret = new THREE.Mesh(new THREE.BoxGeometry(s.wid * 0.13, 2.6, s.wid * 0.13), hullMat);
      turret.position.y = 1.6;
      cg.add(turret);
      for (const bx of [-0.5, 0.5]) {
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 9, 8), darkMat);
        barrel.rotation.x = Math.PI / 2;
        barrel.position.set(bx * 1.1, 2.4, 5.2);
        cg.add(barrel);
      }
    } else {
      // 导弹发射箱: 双排四管
      const box = new THREE.Mesh(new THREE.BoxGeometry(s.wid * 0.22, 2.2, s.wid * 0.30), hullMat);
      box.position.y = 1.6;
      cg.add(box);
      for (const bx of [-1.2, 1.2]) {
        for (const by of [-0.5, 0.5]) {
          const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 7, 8), darkMat);
          tube.rotation.x = Math.PI / 2;
          tube.position.set(bx, 2.2 + by * 0.9, 2.4);
          cg.add(tube);
        }
      }
    }
    // 让组件的"上"(+Y) 对齐所在面的外法线: 顶面不用转, 底面翻 180°
    if (d.normal.y < 0) cg.rotation.x = Math.PI;
    cg.position.copy(d.pos);
    group.add(cg);
    // 组件的包围球半径(作为独立单位被锁定/命中时用): 按基座与炮塔的实际尺寸估
    const cRadius = Math.max(s.wid * 0.14, 2.2 + (d.kind === 'missile' ? 4.5 : 5.2));
    components.push({
      mesh: cg,
      kind: d.kind,
      hp: 120,
      maxHp: 120,
      alive: true,
      fireTimer: 0,
      normal: d.normal.clone(),
      localPos: d.pos.clone(),
      radius: cRadius,
    });
  }

  group.scale.setScalar(scale);
  group.traverse((o) => { (o as THREE.Object3D & { _env?: boolean })._env = true; });
  const half = new THREE.Vector3(s.wid / 2, s.hei / 2, s.len / 2).multiplyScalar(scale);
  return {
    group,
    components,
    hull: { radius: half.length() * 0.62, half },
    size: { len: s.len * scale, wid: s.wid * scale, hei: s.hei * scale },
    hullMat,
  };
}

export interface AirWarshipMotionState {
  /** 目标高度(离地 ≥ MIN_AGL, 由调用方按地形给) */
  targetY: number;
  /** 索敌后环绕目标的半径(引擎按目标体型给: 敌舰越大绕得越远) */
  orbitR: number;
  /** 0 = 直行, 1 = 盘旋 (内部按计时器切换) */
  mode: 'straight' | 'orbit';
  /** 当前模式剩余时间 */
  modeT: number;
  /** 直行时的目标航向 */
  desiredHeading: number;
  /** 盘旋方向(±1) */
  orbitSign: number;
}

export function makeAirWarshipMotion(heading: number): AirWarshipMotionState {
  return {
    targetY: 0,
    orbitR: 3000,
    mode: 'straight',
    modeT: 18 + Math.random() * 16,
    desiredHeading: heading,
    orbitSign: Math.random() < 0.5 ? -1 : 1,
  };
}

/**
 * 运动 AI: 只会"超大半径盘旋"或"调方向后直行"; 高度保持离地 ≥ MIN_AGL;
 * 速度/朝向都走大惯性(慢 lerp), 转向率被钳在 AIR_WARSHIP_MAX_YAW。
 *
 * @param pos 舰体位置(世界) —— 直接改
 * @param vel 速度(世界) —— 直接改
 * @param st  运动状态 —— 直接改
 * @param terrainY 舰体所在水平位置的地形高度(米)
 * @returns 本帧实际航向(弧度)与是否发生了坠地
 */
export function updateAirWarshipMotion(
  pos: THREE.Vector3,
  vel: THREE.Vector3,
  headingRef: { heading: number },
  st: AirWarshipMotionState,
  dt: number,
  terrainY: number,
  speed = AIR_WARSHIP_SPEED,
  /** 索敌到的目标位置(可空): 给了它就"转向过去 + 绕着它打", 而不是按计时器瞎飞 */
  targetPos?: THREE.Vector3 | null,
): void {
  // === 高度: 离地至少 MIN_AGL(低于就慢慢爬, 高太多就慢慢下) ====================
  const minY = terrainY + AIR_WARSHIP_MIN_AGL;
  st.targetY = Math.max(minY, st.targetY * 0.995 + minY * 0.005);
  if (pos.y < minY) st.targetY = minY;
  // 大惯性: 垂直方向也慢慢来(±6 m/s)
  const dy = THREE.MathUtils.clamp(st.targetY - pos.y, -6, 6);
  vel.y = dy; // 速度里直接体现(下面再用 heading 分量覆盖水平部分)

  // === 索敌后的行为 (per user request: 不是强行绕, 是自己索敌 -> 转向过去 -> 环绕攻击) ====
  // 做法: 把目标周围的**切向**当期望航向(绕圈), 再叠一个径向修正把距离拉回 orbitR ——
  // 远了往里压、近了往外让。于是观感是"先掉头飞过去, 到位后自然开始绕", 而不是被钉在圆上。
  if (targetPos) {
    const to = targetPos.clone().sub(pos);
    to.y = 0;
    const dist = to.length();
    if (dist > 1) {
      const radial = to.clone().multiplyScalar(1 / dist);
      const tangent = new THREE.Vector3(-radial.z, 0, radial.x).multiplyScalar(st.orbitSign);
      const want = dist > st.orbitR * 1.15 ? 0.75 : (dist < st.orbitR * 0.85 ? -0.55 : 0);
      const dir = tangent.addScaledVector(radial, want).normalize();
      st.desiredHeading = Math.atan2(dir.x, dir.z);
      // 顶着内部计时器: seek 期间不切换到别的模式(否则会突然开始自由盘旋)
      st.mode = 'straight';
      st.modeT = Math.max(st.modeT, 6);
    }
  }

  // === 模式切换: 直行 ↔ 盘旋 ==================================================
  st.modeT -= dt;
  if (st.modeT <= 0) {
    if (st.mode === 'straight') {
      st.mode = 'orbit';
      st.modeT = 26 + Math.random() * 22;
      st.orbitSign = Math.random() < 0.5 ? -1 : 1;
    } else {
      st.mode = 'straight';
      st.modeT = 20 + Math.random() * 20;
      // 直行时挑一个新航向(±25°), 反映"调整方向直行"
      st.desiredHeading += (Math.random() - 0.5) * (Math.PI * 25 / 180);
    }
  }

  // === 期望转向率 ============================================================
  let yawRate: number;
  if (st.mode === 'orbit') {
    // 盘旋: 半径 R ⇒ ω = v / R
    yawRate = (speed / AIR_WARSHIP_ORBIT_R) * st.orbitSign;
  } else {
    // 直行: 缓慢把机头对到 desiredHeading
    let d = st.desiredHeading - headingRef.heading;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    yawRate = THREE.MathUtils.clamp(d * 0.25, -AIR_WARSHIP_MAX_YAW, AIR_WARSHIP_MAX_YAW);
  }
  // 弱转向能力: 一律钳住
  yawRate = THREE.MathUtils.clamp(yawRate, -AIR_WARSHIP_MAX_YAW, AIR_WARSHIP_MAX_YAW);
  headingRef.heading += yawRate * dt;

  // === 大惯性: 水平速度慢慢转向"机头方向 × 巡航速度"(时间常数 ~6s) ============
  const want = new THREE.Vector3(
    Math.sin(headingRef.heading) * speed,
    0,
    Math.cos(headingRef.heading) * speed,
  );
  const k = Math.min(1, dt * 0.17);
  vel.x += (want.x - vel.x) * k;
  vel.z += (want.z - vel.z) * k;
  pos.addScaledVector(vel, dt);
}
