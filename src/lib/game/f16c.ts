// === F-16C Block 50 真实模型加载 (per user request: 完全替换原 F-16) ===
//
// 与 mig29.ts 同一套导入流程(War Thunder OBJ + MTL + 贴图族):
//   - OBJ 以 .gz 内联进单文件(base64 8.7MiB 而不是 48MiB),运行时 pako.inflate
//     → 文本 → OBJLoader.parse(见 ./obj-gzip.ts)
//   - 手写 .mtl 解析:map_Kd = albedo、map_Ks = **specular(不是 roughness)**、
//     map_normal = 法线、map_ao = AO;specular 用 canvas 反相成 roughness
//   - 法线修复:War Thunder 导出的面是 CW,three 按 CCW 判正面 → 逐面翻转
//     winding(同步交换 UV)再重算法线,法线朝外
//   - 法线平滑:non-indexed 布局上按位置累加相邻面法线(不重建 geometry);
//     座舱内部(inside/interior)与透明件跳过,否则内外双层法线相消 → 渲染黑
//   - 真实舵面:调用 models.ts 的 extractControlSurfaces()(F-16C 的
//     flaperon_l/_r、elevator0/1、rudder 与 airbrake_l*/_r*,按基名分组共享
//     同一根铰链线)
//
// 两条消费路径(共用同一次解析,互不修改对方的几何):
//   1. loadF16cModel()         —— 玩家机:多材质 sub-mesh + 真实舵面
//   2. loadF16cGeometry()      —— 同型机(f16 / f16-test / f16c 三个 model id
//      共用):合并成单个 BufferGeometry + 单材质 PBR。引擎的 spawnEnemies 只吃
//      AircraftGeometryInfo.geometry,不吃 Group,所以必须有这条合并路径,它接替
//      了原来的 f16.positions/normals/indices/uvs.bin 烘焙。

import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { assetUrl } from './asset-url';
import { fetchTextAsset } from './obj-gzip';
import { fetchAssetText, loadImageTexture } from './fetch-asset';
import { attachDeferredMode, AIRCRAFT_ENV_MAP_INTENSITY, AIRCRAFT_COAT, AIRCRAFT_COAT_ROUGHNESS, CANOPY_COAT, CANOPY_COAT_ROUGHNESS, makeCoatedMaterial } from './pbr/materials';
// 源贴图缺细节时的兜底(程序化粗糙度 / 从 albedo 反推法线),见该模块头说明。
import { getProceduralRoughnessTexture, meanLuminance } from './pbr/detail-maps';
import {
  extractControlSurfaces,
  sanitizeZeroNormals,
  type AircraftGeometryInfo,
  type ControlSurfaceSet,
} from './models';

const F16C_OBJ = '/models/f16c/f16c.obj'; // 实际取 f16c.obj.gz(obj-gzip.ts)
const F16C_MTL = '/models/f16c/f16c.mtl';
const TEX_DIR = '/models/f16c/';

// buildAfterburner()(models.ts)对 enginePositions 还会再加一个 -0.45 的模型
// 空间垂直偏移(当年为老 F-16 的包围盒调的)。F-16C 的包围盒连起落架/垂尾
// 一起算,机身中线落在 y≈-0.68,所以这里预先补偿回去,尾焰才落在真实喷口中心
// 而不是喷口下方。
const AB_PLUME_Y_OFFSET = -0.45;

interface F16cMatDef {
  name: string;
  albedo: string | null;   // map_Kd (_c)
  specular: string | null; // map_Ks (_n_s)
  normal: string | null;   // map_normal (_n_n)
  ao: string | null;       // map_ao (_n_ao)
  alphaMap: string | null; // map_d (_c_a) —— 透明通道贴图(与 MiG-29 同一约定)
  opacity: number;         // d
  color: THREE.Color;      // Kd(纯色材质)
}

interface Parsed {
  meshes: THREE.Mesh[];
  defs: F16cMatDef[];
  merged: THREE.BufferGeometry;
  // 归一化参数 + 原始包围盒(供 info 换算)
  s: number;
  cx: number; cy: number; cz: number;
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  // 喷口中心(归一化后),用于后燃器/发动机定位
  nozzle: THREE.Vector3;
}

// ---------------------------------------------------------------------------
// mtl 解析（手动，不依赖 three MTLLoader — War Thunder 的 _n_s 是 specular）
// ---------------------------------------------------------------------------
function parseMtl(text: string): F16cMatDef[] {
  const defs: F16cMatDef[] = [];
  let cur: F16cMatDef | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('newmtl ')) {
      if (cur) defs.push(cur);
      cur = {
        name: line.slice(7).trim(),
        albedo: null,
        specular: null,
        normal: null,
        ao: null,
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
      else if (p[0] === 'map_ao' && p[1]) cur.ao = basename(p[1]);
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
function loadImage(url: string): Promise<HTMLImageElement> {
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
  // 跨 mission / 机库共享 —— engine.dispose() 与 hangar.detach() 按
  // userData.shared 跳过释放,否则「进机库看一眼再开打」会丢贴图。
  tex.userData.shared = true;
  return tex;
}

/** 贴图走 `<img>`(loadImageTexture)而不是 THREE.TextureLoader ——
 *  r185 的 Loader 内部用 fetch, 在 file:// 下会抛裸 Event, 一路冒泡成
 *  "模型加载失败"并回退程序化低模(实测)。详见 fetch-asset.ts。 */
function loadTexture(url: string, srgb: boolean): Promise<THREE.Texture> {
  return loadImageTexture(assetUrl(url), srgb).then((t) => {
    t.userData.shared = true;
    return t;
  });
}

/** 13 材质 → usemtl 名 → Material 映射。 */
async function buildMaterials(defs: F16cMatDef[]): Promise<Map<string, THREE.Material>> {
  const map = new Map<string, THREE.Material>();
  for (const def of defs) {
    const matOpts: THREE.MeshStandardMaterialParameters = {
      color: def.color,
      metalness: 0.6,
      roughness: 0.5,
      // === 天光强度 (per user request ⑤: 机体天光太弱) ===
      // envMapIntensity 控制 scene.environment(天空盒 IBL)对这块材质的贡献。
      // 1.0 → 1.5 → 统一引用 AIRCRAFT_ENV_MAP_INTENSITY(1.9) —— 与
      // models.ts 的 PBR 贴图路径同源, 避免两处数值漂移。
      envMapIntensity: AIRCRAFT_ENV_MAP_INTENSITY,
      // === 双面渲染 (per bug: F-16 从顶部能透视看到底部) ===
      // 决定"能否看穿"的是 **winding + material.side**, 与 normalScale / 顶点法线
      // 无关 —— 这正是我前几轮改错层的原因(改了贴图法线与顶点法线, 看穿依旧)。
      // F-16C 的 OBJ 来自 War Thunder, 其面朝向与 three 的 CCW 约定不一致; 而
      // flipWinding() 对**混合朝向**的模型无法保证逐面正确 —— 只要有一部分三角形
      // 被判成背面, 单面材质就把它们剔除 → 从上方看穿到内部(座舱/机腹)。
      // DoubleSide 从根上消除该现象(封闭壳体开销可接受, 且与 MiG-29 观感一致)。
      side: THREE.DoubleSide,
      // === 不要给这个模型设 shadowSide (2026-09 实测回退) ===
      // 曾按"DoubleSide 深度图会把受光正面自身写进去 → 自投影 acne"的思路改成
      // shadowSide = BackSide。但对 F-16C 是**错的**: 该模型 winding 被 flipWinding 翻过、
      // 且面朝向本来就是混的(当初正是因为"从上方能看穿到机腹"才改成 DoubleSide)。
      // three 的 depth pass 于是只渲染"背面", 实际被剔得几乎不剩三角形 →
      // **shadow map 全黑、机体自阴影完全没有**(用户实测: shadowmap 画面全黑)。
      // 结论: 这个模型只能让 depth pass 跟着 DoubleSide 走, 条带靠 PCF + normalBias 解决。
    };
    // === 漆面清漆层 / 座舱盖玻璃涂层 (per user request: 机体材质能量守恒升级) ===
    // 一律走 MeshPhysicalMaterial —— clearcoat 只存在于它上面,**纯标量**(不绑贴图
    // ⇒ 不占采样器); 能量账由 three 的涂层模型自己平: 基底按 (1-clearcoat*Fcc) 扣,
    // 再叠 coatSpec*clearcoat(见 pbr/materials.ts 的 AIRCRAFT_COAT 说明)。
    //   · 玻璃件(d<1): MTL 写的是 Ks=1 / Ns=255 的抛光镜面, 原来下面强行改成
    //     metalness=0/roughness=1 的哑光黑 ⇒ 舱盖成了不反光的黑洞。给 CANOPY_COAT。
    //   · 蒙皮: 真机 = 底漆 + 聚氨酯清漆, 给 AIRCRAFT_COAT(与 models.ts 的程序化
    //     机体同源, 免得僚机比自己亮/暗)。
    const glass = def.opacity < 1;
    const mat: THREE.MeshStandardMaterial = makeCoatedMaterial(
      matOpts,
      glass ? CANOPY_COAT : AIRCRAFT_COAT,
      glass ? CANOPY_COAT_ROUGHNESS : AIRCRAFT_COAT_ROUGHNESS,
      glass ? 'canopyCoat' : 'paintCoat',
    );
    // 纯色/透明材质(座舱玻璃等,无贴图)
    if (def.opacity < 1) {
      mat.transparent = true;
      mat.opacity = def.opacity;
      mat.depthWrite = def.opacity > 0.5;
      mat.metalness = 0.0;
      mat.roughness = 1.0;
    }
    if (def.albedo) mat.map = await loadTexture(TEX_DIR + def.albedo, true);
    if (def.normal) {
      mat.normalMap = await loadTexture(TEX_DIR + def.normal, false);
      // === 法线取向参照 MiG-29 (per user request: f16 的法线内外方向参考 mig29) ===
      // MiG-29 用的就是 (1, 1), 而两者的法线管线逐行一致(flipWinding → 交换 UV →
      // 外部蒙皮 smoothNormals → 内部/透明件跳过), 所以 F-16C 也必须是 (1, 1)。
      // 历史: 我一度改成 (1,-1) 再改成 (-1,-1) —— 那是在改**贴图法线**;而用户
      // 说的"内外方向"指的是**面朝向**(winding + side), 由 flipWinding 决定,
      // 与 normalScale 无关。改 normalScale 只会把凹凸明暗搞反, 修不了内外。
      mat.normalScale = new THREE.Vector2(1, 1);
    }
    if (def.specular) {
      // 镜面图整体近黑 → 转出来的粗糙度会整机落在同一个值上("一片光滑", 太阳下
      // 看不出材质变化)。这种情况换成**程序化粗糙度**(多尺度噪声 + 流痕), 不依赖
      // 源图有没有细节。见 pbr/detail-maps.ts 的说明。
      const specUrl = assetUrl(TEX_DIR + def.specular);
      const dark = (await meanLuminance(specUrl)) < 0.06;
      mat.roughnessMap = dark
        ? getProceduralRoughnessTexture()
        : await loadSpecularAsRoughness(TEX_DIR + def.specular);
      mat.roughness = 1.0; // map owns the channel
    }
    if (def.ao) {
      // aoMap 走 uv(Texture.channel 默认 0),不需要第二套 UV。
      mat.aoMap = await loadTexture(TEX_DIR + def.ao, false);
      mat.aoMapIntensity = 1.0;
    }
    // === 内部结构标记 (per user request: 与 MiG-29 处理座舱黑屏的方法一致) ===
    // interior/inside/cockpit/canopy 贴图 = 座舱内外双层结构。smoothNormals 按
    // **位置哈希**累加相邻面法线, 而内外两层在几乎同一位置、法线朝向相反 →
    // 累加后互相抵消成近零法线 → 着色器算不出光照 → **座舱渲染成黑色**。
    // 所以这些部件必须**跳过法线平滑**(与 MiG-29 的规则保持一致)。
    //
    // 判定输入也与 MiG-29 对齐: 用「albedo + alphaMap(透明通道贴图)」两个名字。
    // F-16C 的 MTL 未导出 map_d, 但保留 alphaMap 项以便与 MiG-29 同规则,
    // 并为将来带透明通道的贴图留出判定依据。
    // === 座舱内部件清单核对 (per user request: 检查机舱内还有哪些部件开着法线自动平滑) ===
    // 逐个核对 f16c.mtl 里带 albedo 的材质, 找出"确实是座舱内部、但名字没被这条正则覆盖"的:
    //   f_16c_block_50_interior_c  → interior ∈ 已覆盖 ✓(跳过平滑)
    //   f_16c_block_50_inside_c    → inside   ∈ 已覆盖 ✓
    //   **f_16c_seat_c            → "seat"(弹射座椅, 座舱内!) 不在正则里 ✗ ⇒ 它一直在走
    //      smoothNormals 自动平滑** —— 就是用户问的那个部件。
    // 另外把同类内部件一并纳入(面板/仪表/HUD/舱盖/飞行员/弹射/玻璃), 免得以后再漏。
    // 存下 albedo 名字: 控制台/探针可以据此列出"每个部件用的是哪张贴图", 便于点对点排查。
    (mat.userData as { _albedoName?: string })._albedoName = def.albedo || '(none)';
    // === 白名单只留"机身大表面蒙皮" (per user request: 其它部件一律不给平滑) ==========
    // 用户原话: "f16c 的模型只有机身大表面蒙皮使用自动法线平滑，其它部件一律不给平滑"。
    //
    // 实测各贴图覆盖面(机库探针 .shots/texmap.js, 括号 = mesh 数 / 顶点数):
    //   f_16c_block_50_c              (166 / 838,635) ← **机身+机翼+尾翼的大表面蒙皮, 保留平滑**
    //   us_2000lb_gbu31_v1b_usaf_c    (  4 / 162,786) ← 2000lb 炸弹, 现在起逐面法线
    //   f_16a_block_10_pylon2_c       (  2 /  27,348) ← 挂架, 逐面
    //   f_16a_block_10_launcher_aim9_c(  2 /  15,102) ← AIM-9 发射轨, 逐面
    //   f_16a_block_10_lattice_c      (  1 /     156) ← 格栅, 逐面
    //   interior / inside / seat      ( 12 / 142,953) ← 座舱内部件, 本来就跳过平滑
    //
    // 注意: 这条正则**不会**误伤同类名 —— f_16c_block_50_interior_c / _inside_c 里的
    // "block_50_" 后面接的是 interior/inside, 与 "block_50_c" 不连续, 匹配不上。
    // === 用蒙皮贴图的**内部腔体/机构**不参与自动平滑 (per user request) ================
    // 实测: 平滑的 166 个网格里包含 maingear_bay(起落架舱) / hook(尾钩) / us_m61_gun_barrel
    // (机炮炮管/炮舱) 这类"内部腔体与机构" —— 它们和蒙皮共用 f_16c_block_50_c, 于是跟着被
    // 平滑了。腔体内壁本来就是硬边结构, 平滑后光照发糊/出现怪影。按名字剔除。
    // (注: 外部蒙皮/挂架不受影响; 想恢复: 删掉这个 bay|hook|gun|... 的附加条件即可。)
    mat.userData._keepSmooth = /f_16c_block_50_c/i.test(def.albedo || '');
    mat.userData._interior = /interior|inside|cockpit|canopy|seat|panel|instr|hud|pilot|eject|glass/i.test(
      (def.albedo || '') + ' ' + (def.alphaMap || ''),
    );
    // === 座舱内件(要隐藏的) (per user request: 将驾驶舱内的组件隐藏不显示) ==========
    // 比 _interior **窄**: 只认"座舱内部结构" —— 舱盖玻璃(canopy)/玻璃件(glass)是外观件,
    // 属于从外面本来就要看到的东西, 不能一起藏掉。命中者稍后 visible = false。
    // === 不再包含 inside (per fix: 尾喷口/后机身怪影) ==============================
    // `*_inside_c` 是**内层壳**(fuse/wing/tail 的 _1 副本), 它负责挡住"看穿到内部";
    // 上一轮把它们一起隐藏了, 后机身/尾喷口那一片就可能露出内部结构 —— 用户反馈的
    // "可能是尾喷口那边法线/结构不对"很可能就是这个。现在只隐藏真正的座舱内部件。
    (mat.userData as { _cockpitInner?: boolean })._cockpitInner = /interior|cockpit|seat|panel|instr|hud|pilot|eject/i.test(
      (def.albedo || '') + ' ' + (def.alphaMap || ''),
    );
    // === G-Buffer 接入 (控制台可看机体 albedo/normal/roughness/ao) ===
    if (!mat.transparent) attachDeferredMode(mat);
    mat.needsUpdate = true;
    map.set(def.name, mat);
  }
  return map;
}

// ---------------------------------------------------------------------------
// 法线修复
// ---------------------------------------------------------------------------
/** 翻转 non-indexed geometry 的 winding(CW→CCW),同步交换 UV。 */
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

/** 平滑法线 —— non-indexed 布局上按位置哈希累加相邻面法线再归一化。
 *  不生成 index、不重建 geometry、不碰 groups(mergeVertices 曾导致全屏黑)。 */
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
    // === 累加和归零时不要写 0 长度法线 (per bug: 尾喷口薄片导致闪黑屏) ==========
    // 薄片(喷口叶片这类两面法线相反的板)共享位置上的法线会互相抵消, 原来的
    // `len || 1` 于是写下 (0,0,0): GLSL 里 normalize(vec3(0)) 是 NaN, 该片直接全黑,
    // 而且 NaN 会顺着 bloom 的模糊扩散成**整屏闪黑**。这里改成"和太小就保留顶点
    // 自己的原始法线" —— 既不产生 NaN, 着色也回到该面原本的朝向。
    if (len > 1e-6) nrm.setXYZ(i, a[0] / len, a[1] / len, a[2] / len);
  }
  nrm.needsUpdate = true;
}

/** 舵面槽位(ControlSurfaceSet 里数组型的键)。 */
type SurfaceSlot = 'ailerons' | 'elevators' | 'rudders' | 'airbrakesL' | 'airbrakesR';

/** 把一个 sub-mesh 按名字归类到舵面槽位(无匹配 → null)。 */
function classifySurface(name: string): SurfaceSlot | null {
  const n = name.toLowerCase();
  if (/flaperon|aileron/.test(n)) return 'ailerons';
  if (/elevator/.test(n)) return 'elevators';
  if (/rudder/.test(n)) return 'rudders';
  if (/airbrake|speedbrake/.test(n)) return /_l/.test(n) ? 'airbrakesL' : 'airbrakesR';
  return null;
}

// ---------------------------------------------------------------------------
// 解析(全模块只做一次)
// ---------------------------------------------------------------------------
let _parsed: Promise<Parsed> | null = null;
// 同型机(敌机/僚机)的合并几何 —— 单材质路径复用
let _geometry: THREE.BufferGeometry | null = null;

/** 合并所有 sub-mesh → 单个 non-indexed geometry(位置/UV),flat 法线。
 *  接替旧的 f16.*.bin 烘焙产物(敌机/僚机只吃一个 BufferGeometry)。
 *  **不改动 meshes 本身**,所以之后再对原始 mesh 做归一化/铰链也互不影响。 */
function buildMerged(meshes: THREE.Mesh[], cx: number, cy: number, cz: number, s: number): THREE.BufferGeometry {
  let total = 0;
  let hasUv = true;
  for (const m of meshes) {
    total += m.geometry.attributes.position.count;
    if (!m.geometry.attributes.uv) hasUv = false;
  }
  const pos = new Float32Array(total * 3);
  const uv = hasUv ? new Float32Array(total * 2) : null;
  let v = 0;
  for (const m of meshes) {
    const src = m.geometry.attributes.position.array as Float32Array;
    const suv = m.geometry.attributes.uv?.array as Float32Array | undefined;
    const n = m.geometry.attributes.position.count;
    for (let i = 0; i < n; i++) {
      pos[v * 3] = (src[i * 3] - cx) * s;
      pos[v * 3 + 1] = (src[i * 3 + 1] - cy) * s;
      pos[v * 3 + 2] = (src[i * 3 + 2] - cz) * s;
      if (uv && suv) { uv[v * 2] = suv[i * 2]; uv[v * 2 + 1] = suv[i * 2 + 1]; }
      v++;
    }
  }
  // CW → CCW:每个面交换后两个顶点的 position 与 uv
  for (let i = 0; i < total; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = (i + 1) * 3 + k, b = (i + 2) * 3 + k;
      const t = pos[a]; pos[a] = pos[b]; pos[b] = t;
    }
    if (uv) {
      for (let k = 0; k < 2; k++) {
        const a = (i + 1) * 2 + k, b = (i + 2) * 2 + k;
        const t = uv[a]; uv[a] = uv[b]; uv[b] = t;
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (uv) g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  // flat 法线(逐面)—— 与旧 f16.*.bin 一致;单材质路径不需要平滑法线,
  // 因此这里省掉 smoothNormals 的开销(1.2M 顶点,约 1.4s,只有玩家路径需要)。
  g.computeVertexNormals();
  // 敌人/僚机走的合并几何也要兜底 0 长度法线: 退化面会让 computeVertexNormals 留下 (0,0,0),
  // 着色器 normalize 出 NaN ⇒ 那片全黑并随 bloom 扩散(见 models.ts sanitizeZeroNormals)。
  sanitizeZeroNormals(g);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

async function parseF16c(): Promise<Parsed> {
  const [objText, mtlRes] = await Promise.all([
    fetchTextAsset(F16C_OBJ),
    fetchAssetText(assetUrl(F16C_MTL)),
  ]);
  const mtlText = mtlRes;
  const defs = parseMtl(mtlText);

  const loader = new OBJLoader();
  // OBJLoader 只调用 materials.create(name)。这里给每个 usemtl 名一个带 name
  // 的占位材质:玩家路径据此换成真材质,同型机路径只用几何。
  const stubs = new Map<string, THREE.Material>();
  loader.setMaterials({
    create: (name: string) => {
      let m = stubs.get(name);
      if (!m) { m = new THREE.MeshStandardMaterial(); m.name = name; stubs.set(name, m); }
      return m;
    },
  } as never);
  const obj = loader.parse(objText);

  const meshes: THREE.Mesh[] = [];
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const nozzleBox = new THREE.Box3();
  let nozzleCount = 0;

  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const name = mesh.name || '';
    if (/vehicle#nozzle1_/i.test(name)) {
      const ng = mesh.geometry;
      if (!ng.boundingBox) ng.computeBoundingBox();
      nozzleBox.union(ng.boundingBox!);
      nozzleCount++;
    }
    meshes.push(mesh);
    const g = mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox!;
    minX = Math.min(minX, b.min.x); maxX = Math.max(maxX, b.max.x);
    minY = Math.min(minY, b.min.y); maxY = Math.max(maxY, b.max.y);
    minZ = Math.min(minZ, b.min.z); maxZ = Math.max(maxZ, b.max.z);
  });
  if (meshes.length === 0) throw new Error('f16c.obj 没有解析出任何 mesh');

  // 归一化:最大维度 = 10,居中(与 models.ts normalize()/mig29 一致)
  const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  const s = 10 / size;

  // 喷口中心(归一化后)。机头 = +Z、机尾 = -Z(War Thunder 与 MiG-29 相同)。
  let nozzle: THREE.Vector3;
  if (nozzleCount > 0) {
    const c = nozzleBox.getCenter(new THREE.Vector3());
    nozzle = new THREE.Vector3((c.x - cx) * s, (c.y - cy) * s, (c.z - cz) * s);
  } else {
    nozzle = new THREE.Vector3(0, 0, (minZ - cz) * s - 0.1);
  }

  // 同型机合并几何(不改动 meshes 本身)
  const merged = buildMerged(meshes, cx, cy, cz, s);

  return { meshes, defs, merged, s, cx, cy, cz, minX, minY, minZ, maxX, maxY, maxZ, nozzle };
}

function getParsed(): Promise<Parsed> {
  if (!_parsed) _parsed = parseF16c();
  return _parsed;
}

// ---------------------------------------------------------------------------
// 路径 1:同型机(敌机/僚机)单几何
// ---------------------------------------------------------------------------
/** 合并后的 F-16C 几何(最大维度 10、机头 +Z、居中、flat 法线、含 UV)。
 *  f16 / f16-test / f16c 共用 —— 取代旧的 f16.*.bin 烘焙。 */
export async function loadF16cGeometry(): Promise<THREE.BufferGeometry> {
  if (_geometry) return _geometry;
  const p = await getParsed();
  _geometry = p.merged;
  // 跨 mission / 机库共享 —— engine.dispose() 与 hangar.detach() 按
  // userData.shared 跳过释放。
  _geometry.userData.shared = true;
  return _geometry;
}

// ---------------------------------------------------------------------------
// 路径 2:玩家机多材质模型 + 真实舵面
// ---------------------------------------------------------------------------
interface Parts {
  meshes: THREE.Mesh[];      // 已归一化/翻转/平滑/舵面铰链/换真材质的主网格
  hingeCount: number;        // extractControlSurfaces 建立的铰链组数(诊断)
  info: AircraftGeometryInfo;
}

let _parts: Promise<Parts> | null = null;

/** 归一化 + winding 修复 + 法线平滑 + 真实舵面铰链 + 材质绑定(全模块一次)。 */
function getParts(): Promise<Parts> {
  if (!_parts) {
    _parts = (async (): Promise<Parts> => {
      const p = await getParsed();
      const materials = await buildMaterials(p.defs);
      const fallback = new THREE.MeshStandardMaterial({ color: 0x8a8f96, metalness: 0.6, roughness: 0.5 });
      const { cx, cy, cz, s } = p;

      // 第一遍:归一化 + winding 修复 + 法线平滑 + 材质绑定
      for (const m of p.meshes) {
        // 占位材质 → MTL 真材质(按 usemtl 名;多 usemtl 的 mesh 保持数组顺序
        // = geometry.addGroup 的 materialIndex)
        const assign = (mm: THREE.Material | undefined) =>
          (mm && materials.get(mm.name)) || fallback;
        const cur = m.material;
        m.material = Array.isArray(cur) ? cur.map(assign) : assign(cur as THREE.Material);

        m.geometry.translate(-cx, -cy, -cz);
        m.geometry.scale(s, s, s);
        // === 法线修复:War Thunder 面是 CW,three 按 CCW 判正面 → 逐面翻转 ===
        flipWinding(m.geometry);
        // === 法线平滑:只给外部蒙皮;内部结构(inside/interior)与透明件跳过 ===
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        const transparent = mats.some((mm) => mm && (mm as THREE.Material).transparent);
        // 一件材质被标为"内部件"(_interior) 或"不保留平滑"(_keepSmooth === false, 见材质段白名单)
        // 就跳过平滑 ⇒ 除蒙皮/挂架/弹体外全部逐面法线(座舱后座等部位不再被平滑糊住棱线)。
        let interior = mats.some((mm) => {
          const u = (mm as { userData?: { _interior?: boolean; _keepSmooth?: boolean } } | undefined)?.userData;
          return !!u && (u._interior === true || u._keepSmooth === false);
        });
        // === 座舱"周围"部件的位置兜底: **已撤回** (per fix, 见 §189) ==============
        // 试过按归一化包围盒判定(前部 z / 上部 y / 中轴 |x| / 小尺寸), 但两套阈值都不靠谱:
        //   · 宽版(z>1.2, |x|<1.2, size<3.2) 命中 166 个网格 —— 连机头雷达罩都进去了,
        //     那种有弧度的件打了逐面法线会变成多面体;
        //   · 紧版(z 1.0~2.6, y>-0.1, |x|<0.9, size<2.0) 命中 0 个 —— 说明该模型这部分
        //     的归一化坐标与我的假设不符。
        // 结论: **位置判定不可靠, 不做**。座舱件继续按材质名判定(见上面的 _interior 正则);
        // 需要精确到"某个看得见的部件"时, 用下面存下来的 _albedoName 在控制台里列出来点对点加。
        // (per fix: 判据必须是**网格名**, 不是贴图名 —— 这些部件用的就是蒙皮贴图)
        // === 尾喷口/排气腔也算空腔 (per bug: 闪黑屏的部件就是它) ==============
        // `vehicle#nozzle1_*` 是一圈薄叶片: 属于空腔, 平滑本来就该跳过; 而且它离
        // 追尾相机只有 ~4 个单位(全机最近的一块网格), 相机压低看进喷口时它占满视野,
        // 之前被自动平滑出的 0 长度法线正好在那里变成整屏闪黑。
        // 现在: 名字里带 nozzle/exhaust 的网格一律不平滑(与 intake/duct 同一规则)。
        const cavityMesh = /bay|hook|gun_barrel|gun_bay|intake|duct|wheel|tire|nozzle|exhaust|burner/i.test(m.name || '');
        const doSmooth = !transparent && !interior && !cavityMesh;
        if (doSmooth) smoothNormals(m.geometry);
        // 诊断标记: 探针/控制台可以直接读"这块网格到底有没有被自动平滑"(别再去猜材质标志)
        (m.userData as { _smoothed?: boolean })._smoothed = doSmooth;
        // === 撤掉顶点法线翻转 (per bug: 加了之后"从顶部能透视看到底部") ===
        // 结论来自 MiG-29 这个**基准**: 它同样是 War Thunder 的 OBJ、同样走
        // flipWinding + smoothNormals, 但**没有**翻顶点法线, 渲染完全正常。
        // 所以正确做法是"什么都不额外做"; 我之前加的 negateNormals 反而把法线
        // 翻到朝内 —— 顶面法线朝内 = 光照算反 + 视觉上像能看穿。
        // (normalScale 也保持 (1,1) 与 MiG-29 一致, 贴图层不参与。)
        m.geometry.computeBoundingBox();
        m.position.set(0, 0, 0);
        m.scale.set(1, 1, 1);
        if (!m.geometry.attributes.normal) m.geometry.computeVertexNormals();
        // === 0 长度法线兜底 (per bug: 尾喷口被相机看到就闪黑屏) ================
        // 平滑抵消与 OBJ 源数据都可能留下 (0,0,0) 法线 ⇒ 着色器 normalize 出 NaN ⇒
        // 该片全黑 + 随 bloom 扩散成整屏闪黑。这里对**每一块**网格(平滑与否都算)做一次
        // 修补, 修掉的数量记在 _nzFixed 上, 控制台/探针可直接查。
        const nzFixed = sanitizeZeroNormals(m.geometry);
        if (nzFixed > 0) (m.userData as { _nzFixed?: number })._nzFixed = nzFixed;
        // === 座舱内件不显示 (per user request) ================================
        // 判定同一次遍历完成: 只要 mesh 上挂了标了 _cockpitInner 的材质就隐藏整块网格。
        // (用 visible 而不是从组里删掉: 引擎/机库后续要按 children 搬移与驱动舵面/喷口。)
        if (mats.some((mm) => (mm as { userData?: { _cockpitInner?: boolean } } | undefined)?.userData?._cockpitInner === true)) {
          m.visible = false;
        }
        // 机库/引擎共享同一批 geometry —— 标记 shared,避免被 dispose 掉。
        m.geometry.userData.shared = true;
      }

      // === 真实舵面铰链 (models.ts 的共享实现) ===
      // 归一化之后再切:铰链线取「组内主网格前缘(Z 最大)」,F-16C 的
      // flaperon / elevator / rudder 前缘都在 Z 大侧(与 MiG-29 同规则)。
      // 一个舵面被 War Thunder 拆成多个子网格时必须共享同一根铰链,否则各转各的。
      const holder = new THREE.Group();
      for (const m of p.meshes) holder.add(m);
      holder.updateMatrixWorld(true);
      // rig 键用 'f16c': getParts() 是共享单例(同一副机体), 机型别名在
      // aircraft-rig.ts 的 RIG_ALIAS 里归一 —— f16/f16-test 会自动查到它。
      const surfaces = extractControlSurfaces(holder, 'f16c');

      // === 尾喷口叶片原点归位(与 models.ts prepareNozzleAnimation 的约定一致)===
      // 把喷口叶片几何的原点搬到喷口中心(位置补偿写回 mesh.position),这样
      // 加力收放 = 绕喷口径向缩放,而不是各叶片朝自己的原点收缩。
      // 在**主网格**上做一次:引擎/机库各自组装出的 wrapper 都从主网格拷贝
      // position,所以两处都能正确缩放;prepareNozzleAnimation() 的
      // _nzShifted 守卫会跳过重复平移(_nzShifted 与之一致)。
      const nz = p.nozzle;
      for (const m of p.meshes) {
        if (!/vehicle#nozzle1_/i.test(m.name || '')) continue;
        const g = m.geometry;
        if ((g.userData as { _nzShifted?: boolean })._nzShifted) continue;
        g.translate(-nz.x, -nz.y, -nz.z);
        g.computeBoundingSphere();
        (g.userData as { _nzShifted?: boolean })._nzShifted = true;
        m.position.add(nz);
        m.updateMatrix();
      }

      // 尾部/机头/翼展(后燃器、炮口、翼尖拉烟定位;机头 = +Z)
      const tailZ = (p.minZ - cz) * s;
      const noseZ = (p.maxZ - cz) * s;
      const halfSpan = ((p.maxX - p.minX) * s) / 2;

      const info: AircraftGeometryInfo = {
        geometry: new THREE.BufferGeometry(), // 占位(多材质不用单 geometry,同 mig29)
        // 真正能被"测量"的几何: 这几十个 sub-mesh 的 position 才是机体外形。
        // 后燃器自动适配(喷口位置/半径)和凝结云翼面贴合都从这里量 —— 不列出来的话
        // 它们只会量到上面那个空占位几何, 静默退回"按机长比例"的估计值。
        scanGeometries: p.meshes.map((m) => m.geometry),
        tailZ,
        noseZ,
        halfSpan,
        // 单发:喷口中心 + 预先抵消 buildAfterburner 的 -0.45 垂直偏移
        enginePositions: [
          new THREE.Vector3(p.nozzle.x, p.nozzle.y - AB_PLUME_Y_OFFSET, p.nozzle.z),
        ],
        procedural: false,
      };

      return { meshes: p.meshes, hingeCount: surfaces.hingeCount, info };
    })();
  }
  return _parts;
}

export interface F16cModel {
  /** 主 mesh 组(多材质 sub-mesh;真实舵面已挂好铰链轴) */
  group: THREE.Group;
  /** 真实舵面 mesh(每份 group 一套 Object3D 包装,geometry 共享) */
  surfaces: ControlSurfaceSet;
  info: AircraftGeometryInfo;
  /**
   * === 尾喷口开合 (per user request: 后燃器尾喷口动画) ===
   * F-16C 的收敛-扩张喷口是 60 片独立叶片(`vehicle#nozzle1_*`)。叶片几何原点
   * 已在 getParts() 里搬到喷口中心,所以这里的缩放就是"绕喷口径向收放"。
   *   openness 0 = 干推收拢 / 1 = 全加力张开
   * 返回实际驱动的叶片数(0 = 该模型没有喷口分组, 调用方可跳过)。
   */
  setNozzle: (openness: number) => number;
}

/** 组装一份玩家机模型。
 *  每次调用返回**新的 Object3D 包装**(共享同一批 geometry/material):
 *  机库与引擎各自持有一份层级树互不干扰 —— mig29.ts 是直接把 children 搬走,
 *  第二次调用就只剩空 group(机库看过再出击 → 玩家机不可见)。几何/材质/贴图
 *  仍然只加载一次。 */
export async function loadF16cModel(): Promise<F16cModel> {
  const parts = await getParts();
  const group = new THREE.Group();
  const surfaces: ControlSurfaceSet = {
    ailerons: [], elevators: [], rudders: [], airbrakesL: [], airbrakesR: [],
    hingeCount: parts.hingeCount,
  };
  // === 喷口叶片收集(与舵面同一趟遍历) ===
  const nozzles: THREE.Mesh[] = [];
  for (const m of parts.meshes) {
    const mesh = new THREE.Mesh(m.geometry, m.material);
    mesh.name = m.name;
    mesh.position.copy(m.position);
    mesh.rotation.copy(m.rotation);
    mesh.scale.copy(m.scale);
    // === visible 也要拷 (per fix: 座舱内件隐藏"没生效") =========================
    // 主网格列表里把座舱内件标了 visible=false, 但这里**又 new 了一层包装** ——
    // 只拷 geometry/material/position/scale 的话, visible 会回到默认 true ⇒ 隐藏失效。
    mesh.visible = m.visible;
    // (per fix) 整份 userData 一起拷: 之前只拷 surfaceAxis, 于是 _smoothed / 其它诊断标记
    // 在新包装上全丢了 —— 与之前 visible 没拷是同一类错。
    mesh.userData = { ...m.userData };
    group.add(mesh);
    const kind = classifySurface(mesh.name || '');
    if (kind) surfaces[kind].push(mesh);
    // USERDATA/surfaceAxis 之外的判定: 喷口叶片按名字收
    if (/vehicle#nozzle1_/i.test(mesh.name || '')) nozzles.push(mesh);
  }
  // 收拢(干推)↔ 张开(全加力)。只缩径向两轴 —— 喷口轴向(XZ? 见下)不缩放,
  // 免得把喷管拉长。F-16 机头 +Z ⇒ 喷口轴向 = Z ⇒ 缩 X/Y。
  const NOZZLE_MIN = 0.82;
  const NOZZLE_MAX = 1.12;
  const setNozzle = (openness: number): number => {
    if (!nozzles.length) return 0;
    const k = NOZZLE_MIN + (NOZZLE_MAX - NOZZLE_MIN) * Math.max(0, Math.min(1, openness));
    for (const n of nozzles) n.scale.set(k, k, 1);
    return nozzles.length;
  };
  setNozzle(0);
  return { group, surfaces, info: parts.info, setNozzle };
}
