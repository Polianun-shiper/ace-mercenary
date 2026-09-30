import * as THREE from 'three';
// 只用类型 —— 避免与 models.ts 形成运行时循环依赖(类型引用会被擦除, 无循环)。
import type { AircraftGeometryInfo } from './models';
import { assetUrl } from './asset-url';
import { positionArrays } from './nozzle-metrics';
// === 后燃器火焰主体 (per user request: 引擎后燃器特效重置方案) ==================
// 方案: "锥体网格 + 加色混合 + 着色器动态扭曲 + 渐变淡出"。
//  · 几何: ConeGeometry(开口), 轴线与机体 -Z 对齐 ⇒ **母口在喷口、锥尖在后方**;
//  · 材质: ShaderMaterial + AdditiveBlending + depthWrite:false(火焰发光且不写深度);
//  · 片元: ① 从喷口到锥尖的颜色渐变(白→黄→橙→红) + alpha 末端柔和淡出;
//          ② 廉价噪波(3 个 sin 叠加)驱动 UV 扭曲与顶点半径脉动 ⇒ 火焰边缘流动/抖动;
//          ③ 马赫钻石纹: sin(t×26 − time×8) 的明暗涟漪(真实后燃器喷流的节律);
//  · 内层再加一个更小更白的芯锥 ⇒ 中心白热、外层橙红, 层次与亮度都靠叠加累积。
// 保留喷口处的一圈激波环(上一轮修正过角度), 去掉旧的"两片交叉贴图 + 蓝色锥"。
// === 后燃器火焰**结构图**(per user request: 用 Blender 高质量重置后燃器) ==========
// 由 blender/vfx/70_flame_texture.py 烘出来的灰度结构图: u = 绕锥面一圈(已无缝),
// v = 轴向。它替换了原来"三个 sin 叠出来的假噪波" —— 那张图里是真实的多层 fBm
// 湍流 + 马赫钻纹, 是 GPU 上几个 sin 做不出来的。
//
// 尺寸契约: **不改任何尺寸**。锥体几何 / 缩放 / 强度驱动全不动, 只换贴图采样。
//
// 两条容易踩的:
//   · colorSpace 必须是 **NoColorSpace**: 这张图是"结构系数(数据)", 不是颜色。
//     按 sRGB 上传会被硬件线性化 → 结构对比度整体走形。
//   · 加载是异步的: 没就绪时 uHasFlame=0, shader 回退到原来的 sin 噪波(零回归);
//     贴图到了再把 uHasFlame 置 1。所有材质共享同一张贴图(每喷嘴两个材质)。
let _flameTex: THREE.Texture | null = null;
let _flameTried = false;
/** 贴图到货前建好的材质 —— 像素到位后统一把 uHasFlame 翻成 1。 */
const _flameWaiters: THREE.ShaderMaterial[] = [];

/**
 * 贴图的**像素**是否已到。
 * TextureLoader 是异步的: 对象(以及 1×1 占位图)先有, 真图后到。用 `_flameTex`
 * 判空会早开 — 材质先按"有贴图"渲染, 采到占位黑图 ⇒ 火焰先黑一下再亮。
 */
function flameReady(): boolean {
  const t = _flameTex;
  return !!(t && t.image);
}

function flameTexture(): THREE.Texture | null {
  if (_flameTex || _flameTried) return _flameTex;
  _flameTried = true;
  try {
    const t = new THREE.TextureLoader().load(
      assetUrl('/textures/vfx/afterburner-flame.png'),
      () => {
        // ★ 到货之后才开 uHasFlame(见 flameReady 的说明)。
        for (const m of _flameWaiters) m.uniforms.uHasFlame.value = 1;
        _flameWaiters.length = 0;
      },
      undefined,
      () => { _flameTex = null; _flameWaiters.length = 0; },   // 失败 → 保持 sin 兜底, 绝不影响画面
    );
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    _flameTex = t;
  } catch { _flameTex = null; }
  return _flameTex;
}

export function makeFlameMaterial(inner: boolean): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uInner: { value: inner ? 1 : 0 },
      uFlame: { value: flameTexture() },
      uHasFlame: { value: flameReady() ? 1 : 0 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uIntensity;
      uniform float uInner;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec3 p = position;
        // 顶点半径脉动: 越靠锥尖摆动越大 ⇒ 火焰"拖着散开"的感觉(末端不僵直)。
        float t = uv.y;                       // 0 喷口 → 1 锥尖
        // 噪波幅度 ÷3、动画速度 ×3 (per user request)
        float wob = sin(t * 9.0 + uTime * 33.0 + uInner * 2.1) * 0.5
                  + sin(t * 17.0 - uTime * 21.9) * 0.28
                  + sin(t * 31.0 + uTime * 45.0) * 0.16;
        p.xz *= 1.0 + wob * (0.02 + 0.073 * t) * uIntensity;
        p.y  += wob * 0.02 * uIntensity;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uIntensity;
      uniform float uInner;
      uniform sampler2D uFlame;              // 火焰结构图(u=周向, v=轴向)
      uniform float uHasFlame;               // 贴图就绪 = 1, 否则回退 sin 噪波
      varying vec2 vUv;
      void main() {
        float t = clamp(vUv.y, 0.0, 1.0);     // 0 喷口 → 1 锥尖
        // --- 纵向颜色渐变: 琥珀口 → 橙 → 红 ---
        // 加色混合最关键的一条: **每层的颜色必须本身是饱和的**。口部原来给 (1,1,0.96) 近白,
        // 外锥 + 内芯两层一叠加必然冲成灰白 —— 于是整条焰看不出火色。改成琥珀起步, 白热只
        // 交给内芯那一层去加(下面 uInner 那一行)。
        // 另外把色标前移: alpha 在 t=0.12 就淡出, 原来橙段到 0.58 才满, 可见的那一段里
        // 根本轮不到橙红。
        vec3 col = mix(vec3(1.00, 0.90, 0.58), vec3(1.00, 0.72, 0.24), smoothstep(0.00, 0.14, t));
        col = mix(col, vec3(1.00, 0.40, 0.08), smoothstep(0.10, 0.45, t));
        col = mix(col, vec3(0.86, 0.13, 0.02), smoothstep(0.42, 1.00, t));
        // 内芯白热(只在内芯那一片上加, 芯外不再叠白)
        col = mix(col, vec3(1.0, 0.97, 0.86), uInner * 0.32);
        // === 火焰结构: 有烘好的结构图就用它, 没有就回退到原来的 sin 噪波(零回归) ===
        float a = (1.0 - smoothstep(0.12, 1.0, t)) * (1.0 - smoothstep(0.55, 1.0, t) * 0.7);
        if (uHasFlame > 0.5) {
          // u = 绕锥面一圈(无缝), v = 轴向。结构系数同时调制亮度与 alpha ——
          // 焰舌立起来、缝隙处变淡, 这才是"真实湍流"该有的样子。
          // ★ 系数按"**均值 ≈ 1**"配(贴图均值 194/255 = 0.76): 加色混合下整体提亮会
          //   直接把橙红冲成白 —— 上一版 0.30+1.25s(均值 1.25)就是这么把焰烧白的。
          // ★ v 要**翻过来采样**: 烘出的结构图是"上亮下暗"(v=1 亮 / v=0 暗), 而锥面的
          //   uv.y = 0 是喷口、1 是锥尖 —— 不翻的话正好把该最亮的喷口压暗、把已经淡出的
          //   锥尖提亮, 整条焰又暗又糊。
          float s = texture2D(uFlame, vec2(vUv.x, 1.0 - vUv.y)).r;
          // 峰值也压住: 加色混合下 color×alpha 一旦 >1 就被色调映射拉成白, 火色全丢。
          col *= 0.34 + 0.80 * s;      // 均值 ≈ 0.95, 峰值 1.14
          a *= 0.42 + 0.60 * s;        // 均值 ≈ 0.88, 峰值 1.02
          // 贴图是静态的, 这里留一点点随时间变化的马赫纹给它"呼吸"(内芯更明显)
          col *= 1.0 + (0.05 + 0.11 * uInner) * sin(t * 26.0 - uTime * 24.0);
        } else {
          float flow = sin(vUv.x * 22.0 + uTime * 18.0 - t * 9.0) * 0.5
                     + sin(vUv.x * 47.0 - uTime * 28.5) * 0.3
                     + sin(vUv.x * 91.0 + uTime * 39.0) * 0.2;
          col *= 1.0 + flow * 0.073 * (0.3 + t);
          col *= 1.0 + (0.18 + 0.30 * uInner) * sin(t * 26.0 - uTime * 24.0);
        }
        a *= 0.55 + 0.45 * uInner;
        a *= uIntensity;
        // §326: 阈值 0.002 -> 0.05 —— 只让"够亮的核心"写深度, 微弱外缘不会在云上戳洞
        if (a <= 0.05) discard;
        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    // §326 (per user request: 后燃器特效被云层遮挡): 每个喷嘴只有这一片 quad(没有叠加层),
    //   所以写深度是安全的 —— 云的 march 在火焰处停住, 火焰不再被云盖掉。
    depthWrite: true,
    side: THREE.DoubleSide,
  });
  // 贴图对象已有、像素未到 → 登记等待(这些材质会先走 sin 兜底, 到货后自动切换)
  if (_flameTex && !flameReady()) _flameWaiters.push(mat);
  return mat;
}

// === 高负载凝结云: 扫描几何自动贴合**整个机翼**的微鼓面片 (per user request) =====
// 用户: ① "贴合机翼的微鼓面片是覆盖整个机翼的, 需要自己拉形状适配各个战斗机的机翼";
//       ② "位置也没对准"; ③ "凝结云的动画速度翻 7 倍"。
//
// 所以不再用"按比例猜的矩形", 而是**从模型几何里量出机翼平面形状**:
//   · 沿翼展方向分箱, 每个箱子取该处翼面的**最小 z(前缘)**与**最大 z(后缘)** ——
//     扫描时用高度带(y)与前后范围(z)把机身/平尾/垂尾排除在外;
//   · 用这些站位点连成一条**贴合翼面的三角带**(左右镜像共用一条几何);
//   · 面片仍是 8×8 细分(顶点着色器做"中段鼓起 + 四边贴回翼面"), 保证能鼓起来。
// 于是每种机型(F-16C / MiG-29 / Su-35 / B-52 / AC-130 …)都会**自己量出翼形**, 不用手写表。
const VAPOR_VERT = /* glsl */ `
  uniform float uBulge;      // 鼓起量
  uniform float uTime;
  varying vec2 vUv;
  varying float vDome;
  void main() {
    vUv = uv;
    vec3 p = position;
    // 中段鼓起、四边贴回翼面 ⇒ "稍微鼓起来"的一层雾
    float dome = sin(uv.x * 3.14159) * sin(uv.y * 3.14159);
    vDome = dome;
    // 气流让鼓包本身也在呼吸(相位速度与片元流纹一致)
    float wob = sin(uv.x * 7.0 - uTime * 16.8) * 0.35 + sin(uv.y * 9.0 + uTime * 11.9) * 0.25;
    p.z += dome * uBulge * (1.0 + wob * 0.25);   // 面片法线 +Z ⇒ 沿法线抬起
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const VAPOR_FRAG = /* glsl */ `
  uniform float uLoad;
  uniform float uTime;
  varying vec2 vUv;
  varying float vDome;
  float noise(vec2 p) {
    return sin(p.x) * 0.5 + sin(p.x * 2.3 + p.y * 1.7) * 0.3 + sin(p.x * 5.1 - p.y * 3.3) * 0.2;
  }
  void main() {
    float edge = smoothstep(0.0, 0.22, vUv.x) * smoothstep(1.0, 0.78, vUv.x)
               * smoothstep(0.0, 0.18, vUv.y) * smoothstep(1.0, 0.82, vUv.y);
    // === 流纹速度 ×7 (per user request) ===
    float flow = noise(vec2(vUv.y * 26.0 - uTime * 21.7, vUv.x * 9.0 + uTime * 5.6));
    float mist = (0.55 + 0.45 * flow) * (0.35 + 0.65 * vDome);
    float a = edge * mist * uLoad * 0.5;
    if (a <= 0.004) discard;
    vec3 col = mix(vec3(0.86, 0.90, 0.96), vec3(1.0), 0.35 + 0.4 * uLoad);
    gl_FragColor = vec4(col, a);
  }
`;

/** 从几何里量出机翼平面: 沿展向分箱, 每个箱子给 (x, 前缘 z, 后缘 z)。 */
function deriveWingStations(info: AircraftGeometryInfo): { x: number; zLE: number; zTE: number }[] | null {
  // === 多材质模型也要能量到 (per fix) ===
  // info.geometry 对 F-16C/MiG-29 是空占位几何, 原来这里 first guard 就直接
  // return null ⇒ 凝结云面片永远是"按比例猜的翼形"。改用 positionArrays():
  // 有 scanGeometries(真实 sub-mesh)就量它们。
  const arrays = positionArrays(info);
  if (arrays.length === 0) return null;
  const span = Math.max(0.5, info.halfSpan);
  const L = Math.max(1, info.noseZ - info.tailZ);
  const BINS = 10;
  const xLo = 0.20, xHi = 1.0;                       // 翼根略外一点 → 翼尖
  // === 自适应高度带 (per fix) ================================================
  // 不同机型的机翼在归一化模型里的高度不一样(而且上下单翼/带挂架都会影响),
  // 所以按"从窄到宽"依次尝试三档高度带 + 两档前后范围, 用**能扫出≥3个站位**的那一档。
  // 扫不出来才退回按比例估计的翼形(不会没东西可用)。
  const yBands: [number, number][] = [[-0.35, 0.25], [-0.5, 0.4], [-0.8, 0.6]];
  const zBands: [number, number][] = [[0.05, 0.90], [0.0, 1.0]];
  for (const [yMin, yMax] of yBands) {
    for (const [zf, zb] of zBands) {
      const lo = new Float32Array(BINS).fill(Infinity);
      const hi = new Float32Array(BINS).fill(-Infinity);
      const zLo = info.tailZ + L * zf, zHi = info.tailZ + L * zb;
      for (const arr of arrays) {
        for (let i = 0; i < arr.length; i += 3) {
          const ax = Math.abs(arr[i]);
          const u = (ax / span - xLo) / (xHi - xLo);
          if (u < 0 || u > 1) continue;
          const y = arr[i + 1], z = arr[i + 2];
          if (y < yMin || y > yMax) continue;
          if (z < zLo || z > zHi) continue;
          const b = Math.min(BINS - 1, Math.floor(u * BINS));
          if (z < lo[b]) lo[b] = z;
          if (z > hi[b]) hi[b] = z;
        }
      }
      const out: { x: number; zLE: number; zTE: number }[] = [];
      for (let b = 0; b < BINS; b++) {
        if (!Number.isFinite(lo[b]) || !Number.isFinite(hi[b])) continue;
        const zLE = hi[b], zTE = lo[b];
        if (zLE - zTE < L * 0.04) continue;           // 该箱子只有零星顶点 → 跳过
        out.push({ x: span * (xLo + (xHi - xLo) * ((b + 0.5) / BINS)), zLE, zTE });
      }
      if (out.length >= 3) {
        (info as unknown as { _vaporBand?: string })._vaporBand = `y[${yMin},${yMax}] z[${zf},${zb}] → ${out.length} 站`;
        return out;
      }
    }
  }
  return null;
}

// === 现场对齐旋钮: 凝结云 / 尾喷口 (per user request: 位置+缩放, 自动保存) ========
// 两个独立的"贴合微调"参数组, 都写进 localStorage, 下次进关自动生效:
//   skybound.vaporAlign  { dx, dy, dz, sx, sy, sz }  —— 凝结云面片
//   skybound.nozzleAlign { dx, dy, dz, sx, sy, sz }  —— 后燃器(尾喷口那一段)
// 语义: 先按模型自动测量结果建好(位置/大小都是量出来的), 再叠加这里的**微调** ——
//       dx/dy/dz = 平移(模型空间单位), sx/sy/sz = 缩放倍数(1 = 不缩放)。
// 所以自动适配怎么变, 微调都是相对它叠加, 不会被写死的绝对值盖掉。
export interface AlignKnobs { dx: number; dy: number; dz: number; sx: number; sy: number; sz: number }
export const VAPOR_ALIGN_KEY = 'skybound.vaporAlign';
export const NOZZLE_ALIGN_KEY = 'skybound.nozzleAlign';
export const ALIGN_IDENTITY: AlignKnobs = { dx: 0, dy: 0, dz: 0, sx: 1, sy: 1, sz: 1 };

export function readAlign(key: string): AlignKnobs {
  const out: AlignKnobs = { ...ALIGN_IDENTITY };
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return out;
    const o = JSON.parse(raw) as Partial<AlignKnobs> | null;
    if (!o) return out;
    // 老格式(vapor 只存 dx/dz/sx/sz)也能读: 缺的字段保持默认。
    for (const k of ['dx', 'dy', 'dz', 'sx', 'sy', 'sz'] as const) {
      const v = o[k];
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
  } catch { /* ignore */ }
  return out;
}

export function writeAlign(key: string, a: AlignKnobs): void {
  try { localStorage.setItem(key, JSON.stringify(a)); } catch { /* ignore */ }
}

function parseAlignArgs(args: string, base: AlignKnobs): AlignKnobs | null {
  const nums = args.split(/\s+/).map(Number).filter((v) => Number.isFinite(v));
  // 兼容旧写法: 4 个数 = dx dz sx sz
  if (nums.length === 4) return { ...base, dx: nums[0], dz: nums[1], sx: nums[2], sz: nums[3] };
  if (nums.length >= 6) {
    return { dx: nums[0], dy: nums[1], dz: nums[2], sx: nums[3], sy: nums[4], sz: nums[5] };
  }
  return null;
}

/** 凝结云: 把记住的微调应用到面片上(建好后一次)。 */
export function applyVaporAlign(group: THREE.Group, a: AlignKnobs = readAlign(VAPOR_ALIGN_KEY)): void {
  const mesh = group.children[0] as THREE.Mesh | undefined;
  if (!mesh) return;
  mesh.position.set(a.dx, a.dy, a.dz);
  mesh.scale.set(a.sx, a.sy, a.sz);
  group.userData.align = { ...a };
}

/**
 * 后燃器: baseScale 是调用方本来要设的缩放(通常是机体的 meshScale)。
 * 微调倍数**乘**在它上面, 偏移加在组的位置上 —— 组本身在机体坐标系里。
 *
 * 三个缩放轴都生效, 而且语义直观(组在机体坐标系里, 轴向 = 机体轴向):
 *   sx/sy → 火焰粗细(横向)   sz → 火焰长度(纵向, 往机尾喷多远)
 * 想"细一点/短一点"就调它们, 不用改任何常量。
 */
export function applyNozzleAlign(ab: THREE.Group, baseScale: number, a: AlignKnobs = readAlign(NOZZLE_ALIGN_KEY)): void {
  ab.scale.set(baseScale * a.sx, baseScale * a.sy, baseScale * a.sz);
  ab.position.set(a.dx, a.dy, a.dz);
  ab.userData.align = { ...a };
}

/** 控制台统一入口: 解析 <dx dy dz sx sy sz> / 旧 4 参数, 写盘并返回新值(null = 参数不合法)。 */
export function setAlignFromArgs(key: string, args: string): AlignKnobs | null {
  const next = parseAlignArgs(args, readAlign(key));
  if (!next) return null;
  writeAlign(key, next);
  return next;
}

export function alignToText(a: AlignKnobs): string {
  const n = (v: number) => (Math.round(v * 1000) / 1000).toString();
  return `pos(${n(a.dx)},${n(a.dy)},${n(a.dz)}) scale(${n(a.sx)},${n(a.sy)},${n(a.sz)})`;
}

export function buildCondensationVapor(info: AircraftGeometryInfo): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.ShaderMaterial({
    uniforms: { uLoad: { value: 0 }, uTime: { value: 0 }, uBulge: { value: 0.16 } },
    vertexShader: VAPOR_VERT,
    fragmentShader: VAPOR_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const span = Math.max(0.5, info.halfSpan);
  const L = Math.max(1, info.noseZ - info.tailZ);
  const stations = deriveWingStations(info);
  // 几何: 每个站位一个"弦向条带"(8 段细分以支持鼓起), 左右镜像各一份。
  const SEG = 8;
  const pts: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  const addWing = (side: number) => {
    const base = pts.length / 3;
    const list = stations ?? [
      { x: span * 0.24, zLE: info.tailZ + L * 0.62, zTE: info.tailZ + L * 0.14 },
      { x: span * 0.60, zLE: info.tailZ + L * 0.50, zTE: info.tailZ + L * 0.11 },
      { x: span * 0.97, zLE: info.tailZ + L * 0.34, zTE: info.tailZ + L * 0.08 },
    ];
    for (let s = 0; s < list.length; s++) {
      const st = list[s];
      for (let k = 0; k <= SEG; k++) {
        const f = k / SEG;                       // 0 = 前缘 → 1 = 后缘
        const z = st.zLE + (st.zTE - st.zLE) * f;
        pts.push(side * st.x, 0.02, z);
        uvs.push(s / Math.max(1, list.length - 1), f);
      }
    }
    for (let s = 0; s < list.length - 1; s++) {
      for (let k = 0; k < SEG; k++) {
        const a = base + s * (SEG + 1) + k, b = a + 1, c = a + SEG + 1, d = c + 1;
        if (side > 0) idx.push(a, c, b, b, c, d);
        else idx.push(a, b, c, b, d, c);
      }
    }
  };
  addWing(1);
  addWing(-1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const patch = new THREE.Mesh(geo, mat);
  patch.userData.role = 'vapor';
  group.add(patch);
  group.userData.role = 'vapor';
  group.userData.stations = stations ? stations.length : 0;
  group.visible = false;
  return group;
}

/**
 * 每帧更新: 引擎给 load(0..1) ⇒ 时间常数淡入淡出 + 推进流纹相位(速度已在着色器里 ×7)。
 * 形状/位置是**从几何量出来的贴合翼面**, 不再逐帧改。
 */
export function updateCondensationVapor(group: THREE.Group | null, dt: number, load: number, clock: number): void {
  if (!group) return;
  const mat = (group.children[0] as THREE.Mesh | undefined)?.material as THREE.ShaderMaterial | undefined;
  if (!mat) return;
  const u = mat.uniforms;
  // === 对齐模式(控制台 vapor 打开)时强制满强度显示, 便于现场量位置 ===
  const force = group.userData.forceShow === true;
  const target = force ? 1 : Math.max(0, Math.min(1, load));
  const rate = target > u.uLoad.value ? 3.2 : 1.1;
  u.uLoad.value += (target - u.uLoad.value) * Math.min(1, dt * rate);
  u.uTime.value = clock;
  group.visible = u.uLoad.value > 0.006;
  // 记住的对齐数值(控制台 vapor <dx dy dz sx sy sz> 写入 localStorage)在首帧应用一次
  if (group.userData.alignApplied !== true) {
    applyVaporAlign(group);
    group.userData.alignApplied = true;
  }
}
