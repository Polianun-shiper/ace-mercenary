// === MiG-29 真实模型加载 (per user request: 加入可玩机体, 真实贴图) ===
// The MiG-29 uses the real War Thunder OBJ (~407k triangles) with its own
// PBR-ish texture set (_c albedo / _n normal / _n_s specular). This module:
//   - parses the .mtl (13 materials) into a material-name → texture map
//   - loads albedo/normal directly, converts specular→roughness via canvas
//   - keeps the OBJLoader o/g groups so the real control surfaces
//     (aileron/elevator/rudder) can be separated and animated (P3)
//   - player-only: loaded lazily when the player picks MiG-29

import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { assetUrl } from './asset-url';
import { fetchTextAsset } from './obj-gzip';
import { fetchAssetText, loadImageTexture } from './fetch-asset';
import { attachDeferredMode, AIRCRAFT_ENV_MAP_INTENSITY, AIRCRAFT_COAT, AIRCRAFT_COAT_ROUGHNESS, CANOPY_COAT, CANOPY_COAT_ROUGHNESS, makeCoatedMaterial } from './pbr/materials';
import { deriveDetailMaps, normalMapIsFlat, type DerivedDetail }
  from './pbr/detail-maps';

/** albedo URL → 反推细节。避免 13 个材质对同一张 albedo 重复做 Sobel。 */
const _detailCache = new Map<string, Promise<DerivedDetail>>();
function cachedDetail(albedoUrl: string, specUrl?: string): Promise<DerivedDetail> {
  let p = _detailCache.get(albedoUrl);
  if (!p) {
    // === 粗糙度: 板缝/铆钉掩膜 + 多尺度风化 + 真镜面图的亮点 (per user request) ===
    // 见 pbr/detail-maps.ts 的 deriveDetailMaps 说明: `_n` 是平的(实测), 所以
    // "锁几何"这一步改用 `_c` 上的板缝; `_n_s` 虽然整体近黑(均值 0.024), 但里面
    // 的亮点是真机被磨亮的地方(轮毂/座舱/抛光边), 交给风化场当额外抛光掩膜。
    p = deriveDetailMaps(albedoUrl, { normalStrength: 1.2, roughnessBase: 0.55, specUrl });
    _detailCache.set(albedoUrl, p);
  }
  return p;
}
import { sanitizeZeroNormals, type AircraftGeometryInfo } from './models';

interface Mig29MatDef {
  name: string;
  albedo: string | null;   // map_Kd (_c)
  specular: string | null; // map_Ks (_n_s)
  normal: string | null;   // map_normal (_n)
  alphaMap: string | null; // map_d (_c_a)
  opacity: number;         // d
  color: THREE.Color;      // Kd (solid-colour materials)
}

const MIG29_OBJ = '/models/MiG-29 (9-12).obj'; // 实际取 <path>.gz(见 ./obj-gzip.ts)
const MIG29_MTL = '/models/MiG-29 (9-12).mtl';
const TEX_DIR = '/textures/mig29/';

// ---------------------------------------------------------------------------
// mtl 解析（手动，不依赖 three MTLLoader — War Thunder 的 _n_s 是 specular）
// ---------------------------------------------------------------------------
function parseMtl(text: string): Mig29MatDef[] {
  const defs: Mig29MatDef[] = [];
  let cur: Mig29MatDef | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('newmtl ')) {
      if (cur) defs.push(cur);
      cur = {
        name: line.slice(7).trim(),
        albedo: null,
        specular: null,
        normal: null,
        alphaMap: null,
        opacity: 1,
        color: new THREE.Color(1, 1, 1),
      };
    } else if (cur) {
      const p = line.split(/\s+/);
      if (p[0] === 'map_Kd' && p[1]) cur.albedo = basename(p[1]);
      else if (p[0] === 'map_Ks' && p[1]) cur.specular = basename(p[1]);
      else if (p[0] === 'map_normal' && p[1]) cur.normal = basename(p[1]);
      else if (p[0] === 'map_d' && p[1]) cur.alphaMap = basename(p[1]);
      else if (p[0] === 'd' && p[1]) cur.opacity = parseFloat(p[1]);
      else if (p[0] === 'Kd' && p[1]) cur.color = new THREE.Color(parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3]));
    }
  }
  if (cur) defs.push(cur);
  return defs;
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop()!;
}

// ---------------------------------------------------------------------------
// 贴图加载 + 材质构建
// ---------------------------------------------------------------------------
async function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // ⚠ 不要设 crossOrigin: 它把请求变成 CORS 模式, file:// 下必然失败(裸 Event)。
    // 同目录相对路径不需要 CORS; 资产与 HTML 同源时也不影响 canvas 取像素。
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = assetUrl(url);
  });
}

function imageToCanvas(img: HTMLImageElement): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  return [c, ctx];
}

/** specular(_n_s) 灰度 → roughness(1−specular),canvas 反转。 */
async function loadSpecularAsRoughness(url: string): Promise<THREE.CanvasTexture> {
  const img = await loadImage(url);
  const [c, ctx] = imageToCanvas(img);
  const w = c.width, h = c.height;
  const data = ctx.getImageData(0, 0, w, h);
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
    // === 粗糙度对比放大 (per user request: 增强放大粗糙度贴图在太阳照射下的光照效果) ===
    // 原来是把 specular 灰度**直接反相**(1-lum): 对比度完全等于原图, 而蒙皮大多数像素落在
    // 中间值 → roughness ≈ 0.5 一片, 太阳直射时高光摊成一大片均匀亮斑, 看不出"抛光蒙皮 vs
    // 哑光/烟熏/面板缝"的差别。现在改成语义化的**范围拉伸 + gamma**:
    //   specular 高(光滑金属) → roughness 压到 ~0.10 → 太阳扫过时出现窄而亮的镜面高光;
    //   specular 低(哑光涂层/积碳) → roughness 抬到 ~0.95 → 近似全漫反射。
    // 于是同一束太阳光下, 机身表面才有"金属光泽的层次"而不是一片死亮。
    // 实测(2026-09): F-16C 的 specular 贴图整体偏暗(均值 lum 很低), 直接拉伸后蒙皮均值
    // 仍落在 0.91 ≈ 全哑光, 太阳下只有零星亮点。所以上限压到 0.86(哑光区也保留一层宽高光)
    // 且 gamma 收到 1.1 —— 太阳扫过机身时整体有一层金属光泽, 抛光处再叠窄高光。
    const SPEC_ROUGH_LO = 0.09;   // 最光滑处(镜面高光)
    const SPEC_ROUGH_HI = 0.86;   // 最哑光处(仍有宽而弱的介质高光)
    const SPEC_ROUGH_GAMMA = 1.1;
    const r = SPEC_ROUGH_LO + (SPEC_ROUGH_HI - SPEC_ROUGH_LO) * Math.pow(1.0 - lum, SPEC_ROUGH_GAMMA);
    const v = Math.round(r * 255);
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/** 贴图走 `<img>`(loadImageTexture)而不是 THREE.TextureLoader ——
 *  r185 的 Loader 内部用 fetch, 在 file:// 下会抛裸 Event 导致整个模型
 *  "加载失败"并回退低模(实测)。详见 fetch-asset.ts 的说明。 */
function loadTexture(url: string, srgb: boolean): Promise<THREE.Texture> {
  return loadImageTexture(assetUrl(url), srgb);
}

/** 13 材质 → usemtl 名 → Material 映射。 */
async function buildMaterials(defs: Mig29MatDef[]): Promise<Map<string, THREE.Material>> {
  const map = new Map<string, THREE.Material>();
  for (const def of defs) {
    const matOpts: THREE.MeshStandardMaterialParameters = {
      color: def.color,
      metalness: 0.6,
      roughness: 0.5,
      // 天光强度(同 f16c, per user request ⑤: 机体天光太弱) —— 统一常量
      envMapIntensity: AIRCRAFT_ENV_MAP_INTENSITY,

    };
    // === 漆面清漆层 / 座舱盖玻璃涂层 (per user request: 机体材质能量守恒升级) ===
    // 与 f16c.ts 同一处理: MeshPhysicalMaterial + **纯标量** clearcoat(不绑贴图 ⇒
    // 不占采样器); 玻璃件给 CANOPY_COAT(抛光), 蒙皮给 AIRCRAFT_COAT(底漆+清漆)。
    // 详见 pbr/materials.ts 的 AIRCRAFT_COAT 说明(含"为什么不自己写多散射补偿")。
    const glass = def.opacity < 1;
    const mat: THREE.MeshStandardMaterial = makeCoatedMaterial(
      matOpts,
      glass ? CANOPY_COAT : AIRCRAFT_COAT,
      glass ? CANOPY_COAT_ROUGHNESS : AIRCRAFT_COAT_ROUGHNESS,
      glass ? 'canopyCoat' : 'paintCoat',
    );
    // 纯色/透明材质（无贴图）
    if (def.opacity < 1) {
      mat.transparent = true;
      mat.opacity = def.opacity;
      mat.depthWrite = def.opacity > 0.5;
      mat.metalness = 0.0;
      mat.roughness = 1.0;
    }
    if (def.albedo) {
      mat.map = await loadTexture(TEX_DIR + def.albedo, true);
    }
    // === 源贴图缺细节时从 albedo 反推 (per user request: 修复粗糙度/法线不起作用) ===
    // MiG-29 的 _n 与 _n_s 实测近乎空白, 直接用等于没有。albedo 上画着面板线/铆钉/
    // 污渍 —— 那正是细节来源。按 albedo 缓存, 13 个材质只算少数几张。
    const detail = def.albedo
      ? await cachedDetail(assetUrl(TEX_DIR + def.albedo), def.specular ? assetUrl(TEX_DIR + def.specular) : undefined)
      : null;

    if (def.normal) {
      const srcUrl = assetUrl(TEX_DIR + def.normal);
      const flat = await normalMapIsFlat(srcUrl);
      if (flat && detail) {
        mat.normalMap = detail.normalMap;
        // 反推的法线来自绘图细节, 强度比真法线图浅。首版给 1.8 太强了
        // (per user request: 减一半) —— 减到 0.9。
        mat.normalScale = new THREE.Vector2(0.9, 0.9);
      } else {
        mat.normalMap = await loadImageTexture(srcUrl, false);
        mat.normalScale = new THREE.Vector2(1, 1);
      }
    } else if (detail) {
      mat.normalMap = detail.normalMap;
      mat.normalScale = new THREE.Vector2(0.9, 0.9);
    }
    if (detail) {
      // === 粗糙度 = 真图 + 程序化补细节 (per user request: 顶级光泽图质感) ========
      // 以前这里有两条支路: `_n_s` 太黑(均值 0.024)就整张换成程序化噪声, 否则把
      // `_n_s` 直接反相。两条都不对:
      //   · 反相那条 → 整机落在同一个值(近黑的图反相后就是一片哑光);
      //   · 纯噪声那条 → 结构是"随机"的, 与模型上的板缝/铆钉毫无关系。
      // 现在把 `_n_s` 当**稀疏亮点源**(只取它的高光点), 主体结构由 albedo 的板缝
      // /铆钉派生 + 多尺度风化提供 —— 见 pbr/detail-maps.ts / pbr/weathering.ts。
      mat.roughnessMap = detail.roughnessMap;
      mat.roughness = 1.0; // map owns the channel
    } else if (def.specular) {
      mat.roughnessMap = await loadSpecularAsRoughness(TEX_DIR + def.specular);
      mat.roughness = 1.0;
    }
    if (def.alphaMap) {
      mat.alphaMap = await loadTexture(TEX_DIR + def.alphaMap, false);
      mat.transparent = true;
      mat.depthWrite = false;
    }
    // === 内部结构标记 (per user request: 座舱内部结构回退法线平滑) ===
    // War Thunder 的 interior/inside 贴图标识座舱内部结构(仪表板/舱壁/内部
    // 蒙皮),这些是内外双层/复杂表面,smoothNormals 会抵消法线 → 渲染黑。
    // 按贴图文件名打标,外部机体蒙皮(主材质)不标记,继续平滑。
    mat.userData._interior = /interior|inside/i.test((def.albedo || '') + ' ' + (def.alphaMap || ''));
    // === G-Buffer 接入 (per user request: 控制台看机体 roughness/albedo 等) ===
    // 不透明机身材质接入延迟 G-Buffer —— 延迟管线下控制台 roughness/normal/
    // albedo/metalness/ao 通道就能显示机体(粗糙度来自材质,无法屏幕重建)。
    // 透明材质(座舱玻璃/舱内 alpha)保持前向合成,不写 G-Buffer。uDeferredMode
    // =0 时前向渲染无任何影响。
    if (!mat.transparent) attachDeferredMode(mat);
    mat.needsUpdate = true;
    map.set(def.name, mat);
  }
  return map;
}

// ---------------------------------------------------------------------------
// 法线修复 + 舵面铰链（pivot）设置
// ---------------------------------------------------------------------------
// 1. 法线：War Thunder 导出的 OBJ 面是 CW（顺时针）winding，three.js 按
//    CCW 判正面 → 法线朝内。翻转每个三角面的顶点顺序（交换后两个顶点 +
//    同步 UV）再重算法线，使法线朝外。
// 2. 铰链：机头 +Z，副翼/升降舵/方向舵的铰链都在部件**前缘 = Z 最大**侧
//    （副翼贴机翼后缘、平尾贴机身、方向舵贴垂尾后缘）。War Thunder 把同一
//    舵面拆成多个子网格（如 elevator0_146_0/_1），必须按基名分组、全组共享
//    同一根铰链线，否则旋转时子网格会错位。
const SURFACE_KEY = /vehicle#(aileron1_l|aileron1_r|aileron_l|aileron_r|elevator0|elevator1|rudder0|rudder1)/;

interface SurfGroup {
  key: string;
  axis: 'x' | 'y';
  meshes: THREE.Mesh[];
  bbox: THREE.Box3;
}

/** 翻转 non-indexed geometry 的 winding（CW→CCW），同步交换 UV。 */
function flipWinding(geom: THREE.BufferGeometry) {
  const pos = geom.attributes.position;
  const uv = geom.attributes.uv;
  const count = pos.count;
  const swap = (attr: { array: ArrayLike<number>; itemSize: number } | undefined, i1: number, i2: number) => {
    if (!attr) return;
    const a = attr.array as Float32Array;
    const s = attr.itemSize;
    for (let k = 0; k < s; k++) {
      const t = a[i1 * s + k];
      a[i1 * s + k] = a[i2 * s + k];
      a[i2 * s + k] = t;
    }
  };
  for (let i = 0; i < count; i += 3) {
    swap(pos, i + 1, i + 2);
    swap(uv, i + 1, i + 2);
  }
  pos.needsUpdate = true;
  if (uv) uv.needsUpdate = true;
  geom.computeVertexNormals();
}

/** 平滑法线(per user request: 机体棱角分明)—— 不改变 geometry 结构。
 *  OBJLoader 生成 non-indexed 几何,computeVertexNormals 走 triangle-soup
 *  分支 → 每面独立面法线 = flat shading。这里在 non-indexed 布局上直接按
 *  位置哈希累加相邻面的法线再归一化:相同位置(共享顶点)的顶点获得平滑法线。
 *  与 mergeVertices 相比:不生成 index、不重建 geometry、不碰 groups ——
 *  mergeVertices 曾导致真机全屏黑(geometry 结构被替换后渲染崩),故弃用。 */
function smoothNormals(geom: THREE.BufferGeometry) {
  const pos = geom.attributes.position;
  const nrm = geom.attributes.normal;
  if (!pos || !nrm) return;
  const acc = new Map<string, [number, number, number]>();
  const keyOf = (i: number) =>
    `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
  for (let i = 0; i < pos.count; i++) {
    const k = keyOf(i);
    const a = acc.get(k);
    if (a) {
      a[0] += nrm.getX(i); a[1] += nrm.getY(i); a[2] += nrm.getZ(i);
    } else {
      acc.set(k, [nrm.getX(i), nrm.getY(i), nrm.getZ(i)]);
    }
  }
  for (let i = 0; i < pos.count; i++) {
    const a = acc.get(keyOf(i))!;
    const len = Math.hypot(a[0], a[1], a[2]);
    // 和归零(薄片两面法线相反)时不能写 0 长度法线 —— GLSL 的 normalize(vec3(0)) 是 NaN,
    // 该片全黑且 NaN 会随 bloom 扩散成整屏闪黑。这种情况保留原始法线。详见 f16c.ts 同名注释。
    if (len > 1e-6) nrm.setXYZ(i, a[0] / len, a[1] / len, a[2] / len);
  }
  nrm.needsUpdate = true;
}

/** 组内面数最多的子网格 = 主网格（其 bbox 定义铰链线）。 */
function groupMainMesh(g: SurfGroup): THREE.Mesh | null {
  let main: THREE.Mesh | null = null;
  let mainFaces = -1;
  for (const m of g.meshes) {
    const faces = m.geometry.index ? m.geometry.index.count / 3 : m.geometry.attributes.position.count / 3;
    if (faces > mainFaces) { mainFaces = faces; main = m; }
  }
  return main;
}

// ---------------------------------------------------------------------------
// 尾喷口开合 (per user request: 把 mig29 的尾喷口动画适配好)
// ---------------------------------------------------------------------------
// MiG-29 是**双发**, 两个喷口各有自己的一圈收敛-扩张叶片(OBJ 里 216 个
// `vehicle#nozzle1_*` 分组)。所以不能像单发那样把所有叶片一起缩放 —— 必须
// **按左右分成两组**, 每组绕**自己的喷口中心**收放, 否则叶片会朝机身中心聚拢。
//
// 做法(与 f16c.ts 同一套约定, 但按 X 符号分左右):
//   1) 收集 nozzle 叶片; 按 mesh 包围盒中心的 x 符号分左右两簇;
//   2) 每簇求中心, 把该簇叶片的**几何原点搬到簇中心**(位置补偿写回 mesh.position),
//      这样缩放 = 绕各自喷口径向收放;
//   3) setNozzle(openness): 0 = 干推收拢 / 1 = 全加力张开, 只缩径向两轴。
const NOZZLE_MIN = 0.82;
const NOZZLE_MAX = 1.12;

function shiftToCenter(meshes: THREE.Mesh[], c: THREE.Vector3) {
  // 防御: 包围盒退化(空几何/NaN)时会算出非有限中心, translate 进来会让
  // computeBoundingSphere 报 "Computed radius is NaN" 并让整块网格消失。
  if (!Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.z)) return;
  for (const m of meshes) {
    const g = m.geometry;
    if ((g.userData as { _nzShifted?: boolean })._nzShifted) continue;
    g.translate(-c.x, -c.y, -c.z);
    g.computeBoundingSphere();
    (g.userData as { _nzShifted?: boolean })._nzShifted = true;
    m.position.add(c);
    m.updateMatrix();
  }
}

// ---------------------------------------------------------------------------
// 主加载
// ---------------------------------------------------------------------------
export interface Mig29Model {
  group: THREE.Group;          // 主 mesh（多材质 sub-mesh 组）
  surfaces: { ailerons: THREE.Mesh[]; elevators: THREE.Mesh[]; rudders: THREE.Mesh[] };
  info: AircraftGeometryInfo;
  /** 尾喷口开合: 0 = 收拢(干推) / 1 = 张开(全加力); 返回驱动的叶片数。 */
  setNozzle: (openness: number) => number;
}

export async function loadMig29Model(): Promise<Mig29Model> {
  // === OBJ 走 gzip 内联 (per user request: 单文件体积 ≤100MB) ===
  // 37.2MiB 的文本 OBJ 内联成 base64 要 49.6MiB;先 gzip -9(6.8MiB,gzip 头
  // 由 scripts/gzip-obj-assets.mjs 生成)再内联只要 9.1MiB,运行时 pako.inflate
  // 还原成逐字节一致的文本。.gz 缺失时自动回退原始路径。
  const [objText, mtlRes] = await Promise.all([
    fetchTextAsset(MIG29_OBJ),
    fetchAssetText(assetUrl(MIG29_MTL)),
  ]);
  const mtlText = mtlRes;
  const defs = parseMtl(mtlText);
  const materials = await buildMaterials(defs);

  const loader = new OBJLoader();
  // OBJLoader 只调用 materials.create(name) — 传一个带 create 的适配器即可。
  loader.setMaterials({ create: (name: string) => materials.get(name) } as never);
  const obj = loader.parse(objText);

  // 归一化 + 居中（复用 models.ts 的 normalize 数学：最大维度=10，居中）
  const group = new THREE.Group();
  const surfaces = { ailerons: [] as THREE.Mesh[], elevators: [] as THREE.Mesh[], rudders: [] as THREE.Mesh[] };
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const meshes: THREE.Mesh[] = [];

  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const name = mesh.name || '';
    if (SURFACE_KEY.test(name)) {
      if (/aileron/.test(name)) surfaces.ailerons.push(mesh);
      else if (/elevator/.test(name)) surfaces.elevators.push(mesh);
      else surfaces.rudders.push(mesh);
    }
    meshes.push(mesh);
    const g = mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox!;
    minX = Math.min(minX, b.min.x); maxX = Math.max(maxX, b.max.x);
    minY = Math.min(minY, b.min.y); maxY = Math.max(maxY, b.max.y);
    minZ = Math.min(minZ, b.min.z); maxZ = Math.max(maxZ, b.max.z);
  });

  // 归一化到最大维度 10（居中 + 缩放，和 f16 一样）
  const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  const s = 10 / size;

  // 第一遍：归一化 + 翻转 winding（法线修复）+ 合并共享顶点（法线平滑），按基名收集舵面组
  const surfGroups = new Map<string, SurfGroup>();
  for (const m of meshes) {
    m.geometry.translate(-cx, -cy, -cz);
    m.geometry.scale(s, s, s);
    // === 法线修复 (per user request: 机身法线反了) ===
    // CW → CCW + 重算法线，法线朝外、正面渲染正常。
    flipWinding(m.geometry);
    // === 法线平滑 (per user request: 机体棱角分明) ===
    // 在 non-indexed 布局上直接按位置累加相邻面法线（不重建 geometry）。
    // 只给外部机体表面平滑；内部结构(座舱玻璃/舱内 interior/inside)跳过:
    // 内外双层表面的同位置法线方向相反,smoothNormals 会把它们抵消成近零
    // 法线 → 渲染黑。外部蒙皮(主材质)不平滑范围,继续平滑。
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const transparent = mats.some((mm) => mm && (mm as THREE.Material).transparent);
    const interior = mats.some((mm) => mm && (mm as { userData?: { _interior?: boolean } }).userData?._interior);
    if (!transparent && !interior) smoothNormals(m.geometry);
    m.geometry.computeBoundingBox();
    m.position.set(0, 0, 0);
    m.scale.set(1, 1, 1);
    if (!m.geometry.attributes.normal) m.geometry.computeVertexNormals();
    // 0 长度法线兜底(平滑抵消 / OBJ 源数据) —— 见 models.ts sanitizeZeroNormals 的注释:
    // 留着它着色器 normalize 出 NaN, 该片全黑并随 bloom 扩散成整屏闪黑。
    sanitizeZeroNormals(m.geometry);
    const key = m.name.match(SURFACE_KEY)?.[1] ?? null;
    if (key) {
      let g = surfGroups.get(key);
      if (!g) {
        g = { key, axis: key.startsWith('rudder') ? 'y' : 'x', meshes: [], bbox: new THREE.Box3() };
        surfGroups.set(key, g);
      }
      g.meshes.push(m);
      g.bbox.union(m.geometry.boundingBox!);
    }
    group.add(m);
  }

  // === 舵面铰链 (per user request: 旋转轴中心位置纠正) ===
  // 每组共享同一根铰链线：铰链 z = 主网格前缘（Z 最大），方向舵绕 Y 轴
  // （铰链 x = 主网格 x 中心），副翼/升降舵绕 X 轴（铰链 y = 主网格 y 中心）。
  // 每个子网格绕这根铰链线转，旋转轴不再各自为政。
  for (const g of surfGroups.values()) {
    const main = groupMainMesh(g);
    if (!main) continue;
    const mb = main.geometry.boundingBox!;
    // 铰链线固定值在循环外拷贝 — geometry.translate() 会就地重算 boundingBox
    // (applyMatrix4 → computeBoundingBox)，若循环内每次读 mb 会拿到主网格被
    // 平移后的值，导致子网格 pivot 错位。
    const mbCenter = mb.getCenter(new THREE.Vector3());
    const hingeZ = mb.max.z;
    for (const m of g.meshes) {
      const bbCenter = m.geometry.boundingBox!.getCenter(new THREE.Vector3());
      const pivot = new THREE.Vector3();
      if (g.axis === 'x') {
        pivot.set(bbCenter.x, mbCenter.y, hingeZ);
      } else {
        pivot.set(mbCenter.x, bbCenter.y, hingeZ);
      }
      m.geometry.translate(-pivot.x, -pivot.y, -pivot.z);
      m.position.copy(pivot);
      m.userData.surfaceAxis = g.axis;
    }
  }

  // 几何信息（尾部/机头/翼展，用于后燃器/发动机定位）
  // 机头 = +Z（z 最大），机尾 = -Z（z 最小），归一化后 ×s
  const tailZ = (minZ - cz) * s;
  const noseZ = (maxZ - cz) * s;
  const halfSpan = ((maxX - minX) * s) / 2;

  const info: AircraftGeometryInfo = {
    geometry: new THREE.BufferGeometry(), // 占位（多材质不用单 geometry）
    // 见 f16c.ts 同处注释: 后燃器/凝结云的自动测量要量这些 sub-mesh 的真实顶点,
    // 空占位几何会让它们静默退回估计值。
    scanGeometries: meshes.map((m) => m.geometry),
    tailZ,
    noseZ,
    halfSpan,
    enginePositions: [
      new THREE.Vector3(-0.55, -0.1, tailZ - 0.1),
      new THREE.Vector3(0.55, -0.1, tailZ - 0.1),
    ],
    procedural: false,
  };

  return { group, surfaces, info, setNozzle: makeNozzleSetter(group) };
}

/** 收集喷口叶片 → 按左右分簇 → 各自原点归位 → 返回开合函数。
 *  在 group 组装完之后调用(此时 mesh 已在 group 层级里、matrixWorld 可用)。 */
function makeNozzleSetter(group: THREE.Group): (openness: number) => number {
  group.updateMatrixWorld(true);
  const petals: THREE.Mesh[] = [];
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const nm = ((m.name || '') + ' ' + (m.parent?.name || '')).toLowerCase();
    if (nm.includes('nozzle')) petals.push(m);
  });
  if (!petals.length) return () => 0;

  // 按喷口簇中心分组: 用 X 符号区分左右(双发);单发机型会全部落在同一侧,
  // 此时退化为"一个簇", 行为与 f16c 的单发实现一致。
  const withCenter = petals.map((m) => {
    const b = new THREE.Box3().setFromObject(m);
    return { m, c: b.getCenter(new THREE.Vector3()) };
  });
  const xs = withCenter.map((w) => w.c.x);
  const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
  const left = withCenter.filter((w) => w.c.x <= mid);
  const right = withCenter.filter((w) => w.c.x > mid);
  const clusters = [left, right].filter((c) => c.length >= 3);

  const centers: THREE.Vector3[] = [];
  for (const cl of clusters) {
    const c = new THREE.Vector3();
    for (const w of cl) c.add(w.c);
    c.multiplyScalar(1 / cl.length);
    centers.push(c);
    shiftToCenter(cl.map((w) => w.m), c);
  }

  const all = clusters.flat().map((w) => w.m);
  return (openness: number) => {
    const k = NOZZLE_MIN + (NOZZLE_MAX - NOZZLE_MIN) * Math.max(0, Math.min(1, openness));
    for (const m of all) m.scale.set(k, k, 1);
    return all.length;
  };
}
