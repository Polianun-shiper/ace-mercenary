// §230b(3): 程序化舰体补 hullFrame + 新增 FBX 载入/建舰
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

rep(`  return {
    group,
    mountRoot,
    hullMat,
    size: { len: s.len, wid: s.wid, hei: s.hei },
    hull: { radius: half.length() * 0.62, half },
    ally: isAlly,
  };`,
`  return {
    group,
    mountRoot,
    hullMat,
    size: { len: s.len, wid: s.wid, hei: s.hei },
    hull: { radius: half.length() * 0.62, half },
    hullFrame: { half: half.clone(), center: new THREE.Vector3(0, 0, 0) },
    ally: isAlly,
  };`,
 '程序化 hullFrame');

rep(`// === 无人机 ======================================================================`,
`// === 用户给的 FBX 主舰 (per user request: "boss的空中战舰模型换成这个并等比放大") ==========
//
// 模型事实(用 three 的 FBXLoader 在 Node 里量过): 单网格 24480 顶点 / 8160 三角面 / 1 个材质 +
// 内嵌贴图; 尺寸 119 x 90 x 38, **长轴是 X**, 且高度 90 里绝大部分是桅杆/上层建筑 —— 舰体只占
// 底部一条(顶点投影看, 宽甲板带集中在 y 的底部 ~30%)。所以:
//   · 摆正: 绕 Y 转 -90° 把长轴 X 变成我们的 Z(舰艏 +Z), 再等比缩放到目标舰长;
//   · 挂点盒(hullFrame) 只取**底部 30% 高度**那一层当甲板, 武器不会摆到桅杆上去;
//   · 贴图是 FBX 内嵌的, 加载后直接可用(不需要额外资产)。
export const BASTION_FBX = '/models/airship/bastion.fbx';
/** 舰体层占模型总高的比例(桅杆不算甲板)。 */
const HULL_BAND = 0.30;

/** 从模型实际包围盒推出"挂点盒": 长/宽取满, 高只取底部一条, 且把盒子上移让顶面=甲板。 */
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
}

/** 加载主舰 FBX(单例缓存)。失败返回 null, 调用方回退程序化舰体。 */
let _bastionPromise: Promise<THREE.Object3D | null> | null = null;
export function loadBastionModel(): Promise<THREE.Object3D | null> {
  if (_bastionPromise) return _bastionPromise;
  _bastionPromise = (async () => {
    try {
      const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
      const { assetUrl } = await import('./asset-url');
      const obj = await new FBXLoader().loadAsync(assetUrl(BASTION_FBX));
      // 贴图是内嵌的: 让它们走 sRGB, 否则颜色会偏暗/偏灰
      obj.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[] | undefined;
        if (!m) return;
        for (const mm of Array.isArray(m) ? m : [m]) {
          if (mm.map) mm.map.colorSpace = THREE.SRGBColorSpace;
          mm.side = THREE.FrontSide;
        }
      });
      console.info('[bastion] FBX 载入成功:', BASTION_FBX);
      return obj;
    } catch (e) {
      console.warn('[bastion] FBX 载入失败, 回退程序化舰体:', e);
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
  const model = src;
  // 1) 摆正: 长轴 X -> Z
  model.rotation.y = -Math.PI / 2;
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

// === 无人机 ======================================================================`,
 'FBX 载入 + 建舰');
console.log('§230b-3 done');
