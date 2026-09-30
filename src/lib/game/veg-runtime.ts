// === 植被运行时（位置文件驱动 · 按距离流式 · 低开销） ==========================
// 设计(用户定):
//   · blender 提供每棵树的位置(trees.f32bin, 每棵 6×float32: x,y,z,高,冠幅,朝向)
//   · 游戏按**球形距离**加载/卸载 + 切 LOD 几何
//   · 阴影用**低开销的 blob(软圆盘)影子** —— 不打真实阴影贴图
//   · 树色**跟着脚下的地表色**变(建桶时采样一次, 烘进 instanceColor)
//   · 预留 **alpha 贴图树** 通路(map + alphaTest), 后面换几何/贴图即可, 色染照旧生效
//
// 与上一版的差别(用户反馈"好卡 / 估计没有按距离加载"):
//   ① 真正**按距离加载**: 近处才建 bucket 并上传实例; 超出 streamM 的桶**dispose 释放**
//      (上一版一次性建满所有桶常驻, 只截断 count ⇒ 显存与提交量都在 ⇒ 观感就是"没按距离加载")
//   ② 桶从 2 km 放大到 **4 km** ⇒ 桶数与 draw call 大幅下降
//   ③ blob 影子(仅最近档) + 关掉真实投影
//   ④ 建桶按**时间预算**分帧做; 每帧只做"算距离 → 切 band/几何/count"
import * as THREE from 'three';
import { assetUrl } from './asset-url';

export interface VegRuntimeOpts {
  scene: THREE.Scene;
  /** trees.f32bin 的 URL(相对 public/) */
  url: string;
  /** 已解好的数据(离线检查用); 给了就不 fetch */
  data?: Float32Array;
  /** 分桶边长(m) */
  bucketM?: number;
  /** 流式半径(m): 只保留这个范围内的桶(超出 + 迟滞就卸载释放) */
  streamM?: number;
  /** 球形距离分段(m): 近(8棱)/中(5棱)/远(3棱) */
  lod1M?: number;
  lod2M?: number;
  cullM?: number;
  /** 中/远档保留比例(实例数截断; 位置表本身是随机序 ⇒ 空间无偏) */
  lod2Keep?: number;
  lod3Keep?: number;
  /** 树基色(会被地表色偏染) */
  color?: number;
  /** 地表色采样(线性 0..1 RGB)。给了就**按脚下颜色变色**, 建桶时采样一次 */
  groundAt?: (x: number, z: number) => [number, number, number];
  /** 地表色对树色的影响(0 = 不变色, 1 = 完全取地表色) */
  groundMix?: number;
  /** 每帧建桶的时间预算(ms) */
  budgetMs?: number;
  /** === 预留: alpha 贴图树 ===
   * 给了 map 就走"贴图 + alphaTest"材质(交叉面片/广告牌树都适用), instanceColor 照旧生效 */
  map?: THREE.Texture | null;
  /** 剪影贴图 URL(默认 public/textures/veg/conifer_1.png, 真 alpha) */
  cutoutUrl?: string;
  alphaTest?: number;
  /** blob 影子(默认开): 扁平软圆盘, 只画最近档 */
  blobShadow?: boolean;
  /** 树是否投真实阴影(默认**关** —— 用 blob 替代) */
  castShadow?: boolean;
}

export interface VegStats {
  /** 位置表是否已成功载入(mountVegRT 用它判断成败) */
  loaded: boolean;
  total: number; cells: number; built: number; queued: number;
  drawn: number; drawnBuckets: number; nearestKm: number;
  buildMs: number; tickMs: number; blobs: number;
}

interface Bucket {
  key: string;
  /** 分片填充游标(< n 表示还没填完) */
  cursor: number;
  /** 世界中心(米) */
  cx: number; cz: number;
  n: number;
  inst: THREE.InstancedMesh | null;
  blob: THREE.InstancedMesh | null;
  band: number;
}

const UP = new THREE.Vector3(0, 1, 0);

/** 单帧最多填多少棵实例矩阵(分片, 避免长卡) */
const FILL_CHUNK = 512;

export class VegRuntime {
  private o: Required<Pick<VegRuntimeOpts, 'bucketM' | 'streamM' | 'lod1M' | 'lod2M' | 'cullM' |
    'lod2Keep' | 'lod3Keep' | 'color' | 'groundMix' | 'budgetMs' | 'alphaTest' |
    'blobShadow' | 'castShadow'>>;
  private scene: THREE.Scene;
  private url: string;
  private injected?: Float32Array;
  private groundAt?: (x: number, z: number) => [number, number, number];
  private mapTex: THREE.Texture | null;
  private cutoutUrl?: string;

  private readonly group = new THREE.Group();
  private readonly geos: THREE.BufferGeometry[];
  private readonly mat: THREE.Material;
  private readonly blobGeo: THREE.BufferGeometry;
  private readonly blobMat: THREE.MeshBasicMaterial;
  private raw: Float32Array = new Float32Array(0);
  private total = 0;
  private buckets = new Map<string, Bucket>();
  private bucketIdx = new Map<string, number[]>();
  private built = new Set<string>();
  private pending: string[] = [];
  private loaded = false;
  /** 距离参数的缓存键(变了才重新解析) —— 控制台改完**立刻生效**, 不必重进任务 */
  private tuneKey = '';
  private stats: VegStats = {
    loaded: false,
    total: 0, cells: 0, built: 0, queued: 0, drawn: 0, drawnBuckets: 0,
    nearestKm: -1, buildMs: 0, tickMs: 0, blobs: 0,
  };

  constructor(opts: VegRuntimeOpts) {
    this.scene = opts.scene;
    this.url = opts.url;
    this.injected = opts.data;
    this.groundAt = opts.groundAt;
    this.mapTex = opts.map ?? null;
    this.cutoutUrl = opts.cutoutUrl;
    this.o = {
      bucketM: opts.bucketM ?? 4000, streamM: opts.streamM ?? 11000,
      lod1M: opts.lod1M ?? 2600, lod2M: opts.lod2M ?? 6000, cullM: opts.cullM ?? 10000,
      lod2Keep: opts.lod2Keep ?? 0.5, lod3Keep: opts.lod3Keep ?? 0.25,
      color: opts.color ?? 0x2f5a30, groundMix: opts.groundMix ?? 0.45,
      budgetMs: opts.budgetMs ?? 2, alphaTest: opts.alphaTest ?? 0.4,
      blobShadow: opts.blobShadow ?? true, castShadow: opts.castShadow ?? false,
    };
    // === 交叉面片(billboard trees) per user request ==========================
    // 用户: "我要的是那个在 blender 里的贴片树" —— 一整棵树的剪影贴图被 alpha 裁剪后交叉成
    // 十字。之前这里跑的是 8/5/3 棱锥占位几何(用户: "跟屎一样的锥形树")。
    // 每棵 = 2 片竖直四边形十字交叉 = 4 个三角面(与 blender 侧 22_trees_from_table.py 一致)。
    // LOD 用**片数**降级: 近 = 十字(2 片) · 中/远 = 单面。
    const crossGeo = (planes: number) => {
      const pos: number[] = [];
      const uv: number[] = [];
      const nrm: number[] = [];
      const idx: number[] = [];
      for (let pl = 0; pl < planes; pl++) {
        const ang = (pl / planes) * Math.PI;
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        const base = pos.length / 3;
        const corners: [number, number][] = [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]];
        for (const [x, y] of corners) {
          pos.push(x * ca, y, -x * sa);
          uv.push(x + 0.5, y);
          nrm.push(0, 0, 1);
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
      g.setIndex(idx);
      return g;
    };
    this.geos = [crossGeo(2), crossGeo(1), crossGeo(1)];
    // 材质: 有 alpha 贴图就走贴图树(预留通路), 否则不透明纯色
    // ⚠ **alphaTest + 不透明**(transparent:false): 几万株树若走透明队列会出描边/闪烁;
    //   裁剪式 alpha 走不透明队列 ⇒ 无排序问题(与 blender 里 Cycles 的裁剪同效)。
    this.mat = new THREE.MeshStandardMaterial({
      color: this.o.color, roughness: 1, metalness: 0,
      alphaTest: this.o.alphaTest, transparent: false, side: THREE.DoubleSide,
    });
    // blob 影子: 扁平圆盘 + 程序化软边 alpha(一次性生成, 不占资产文件)
    this.blobGeo = new THREE.CircleGeometry(1, 10);
    this.blobGeo.rotateX(-Math.PI / 2);
    this.blobMat = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0.34, depthWrite: false,
      alphaMap: makeBlobAlpha(), polygonOffset: true,
      polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.group.name = 'VEG_TREES';
    (this.group as unknown as { _env?: boolean })._env = true;
    this.scene.add(this.group);
  }

  get object3d(): THREE.Group { return this.group; }
  getStats(): VegStats { return this.stats; }

  /** 载入位置表 + 分组(一次性; 只做 CPU 解析, 不建任何 GPU 资源) */
  async load(): Promise<void> {
    let f32 = this.injected;
    if (!f32) {
      try {
        const res = await fetch(this.url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        f32 = new Float32Array(await res.arrayBuffer());
      } catch (e) {
        console.warn('[veg] 位置表载入失败(树不会出现):', this.url, e);
        return;
      }
    }
    const STRIDE = 6, B = this.o.bucketM;
    const n = Math.floor(f32.length / STRIDE);
    this.raw = f32; this.total = n;
    for (let i = 0; i < n; i++) {
      const ox = f32[i * STRIDE], oz = f32[i * STRIDE + 2];
      if (!Number.isFinite(ox) || !Number.isFinite(oz)) continue;
      const key = Math.floor(ox / B) + ',' + Math.floor(oz / B);
      let arr = this.bucketIdx.get(key);
      if (!arr) { arr = []; this.bucketIdx.set(key, arr); }
      arr.push(i);
    }
    for (const [key, idx] of this.bucketIdx) {
      const parts = key.split(',');
      const gx = Number(parts[0]), gz = Number(parts[1]);
      this.buckets.set(key, { key, cx: gx * B + B / 2, cz: gz * B + B / 2, n: idx.length, cursor: 0, inst: null, blob: null, band: -1 });
    }
    // 剪影贴图(交叉面片的外观就靠它): 仓库里那张真 alpha 的 conifer_1.png
    if (!this.mapTex) {
      try {
        const url = assetUrl(this.cutoutUrl ?? "/textures/veg/conifer_1.png");
        const tex = await new THREE.TextureLoader().loadAsync(url);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        (this.mat as THREE.MeshStandardMaterial).map = tex;
        (this.mat as THREE.MeshStandardMaterial).needsUpdate = true;
        this.mapTex = tex;
        console.info("[veg] 剪影贴图已挂:", url);
      } catch (e) {
        console.warn("[veg] 剪影贴图载入失败 ⇒ 树会是实心片:", e);
      }
    }
    this.loaded = true;
    this.stats.loaded = true;
    this.stats.total = n;
    this.stats.cells = this.buckets.size;
    console.info(`[veg] 位置表就绪: ${n} 棵 / ${this.buckets.size} 桶(每桶 ${B / 1000}km)`
      + ` · 流式 ${this.o.streamM / 1000}km · LOD ${this.o.lod1M}/${this.o.lod2M}/${this.o.cullM}m`);
  }

  /** 读控制台/LocalStorage 的距离参数(每帧调用; 用字符串比较做缓存, 未变则零成本)。
   *  skybound.vegDistKm  流式半径(km)      skybound.vegLodKm  三档球形距离(km, 逗号分隔)
   *  ⚠ 必须**运行时读** —— 构造时定死的话控制台改了要重进任务才生效。
   */
  private readTuning(): void {
    let dist = '', lod = '';
    try {
      dist = localStorage.getItem('skybound.vegDistKm') || '';
      lod = localStorage.getItem('skybound.vegLodKm') || '';
    } catch { return; }
    const key = dist + '|' + lod;
    if (key === this.tuneKey) return;
    this.tuneKey = key;
    const d = Number(dist);
    if (Number.isFinite(d) && d > 0) {
      this.o.streamM = Math.min(40000, Math.max(1000, d * 1000));
    }
    const l = lod.split(',').map(Number);
    if (l.length === 3 && l.every((v) => Number.isFinite(v) && v > 0)) {
      const a = l[0] * 1000, b = l[1] * 1000, c = l[2] * 1000;
      this.o.lod1M = a; this.o.lod2M = Math.max(a + 500, b); this.o.cullM = Math.max(b + 500, c);
    }
    this.pending = [];   // 距离变了 ⇒ 重新排队(缩小时靠 tick 的淘汰把远处的桶释放掉)
  }

  /** 每帧一次。camPos = 三维位置(球形距离含高度)。 */
  tick(camPos: THREE.Vector3): void {
    if (!this.loaded) return;
    const t0 = performance.now();
    this.readTuning();
    const o = this.o, B = o.bucketM;
    // ① 排队: 流式半径内尚未建的桶, 近的优先
    if (!this.pending.length) {
      const cand: { key: string; d: number }[] = [];
      for (const [key, b] of this.buckets) {
        if (this.built.has(key)) continue;
        const d = Math.hypot(camPos.x - b.cx, camPos.z - b.cz);
        if (d <= o.streamM) cand.push({ key, d });
      }
      cand.sort((a, b2) => a.d - b2.d);
      this.pending = cand.map((c) => c.key);
    }
    // ② 建桶: 按时间预算分帧
    const tB = performance.now();
    while (this.pending.length) {
      const key = this.pending[0];
      if (this.built.has(key)) { this.pending.shift(); continue; }
      this.buildBucket(key);
      const b = this.buckets.get(key);
      if (b && b.cursor >= b.n) this.pending.shift();    // 填完才出队; 否则下帧接着填
      else break;                                        // 本帧让出, 避免反复填同一个桶
      if (performance.now() - tB > o.budgetMs) break;
    }
    this.stats.buildMs = performance.now() - tB;
    // ③ 卸载: 超出 streamM + 一个桶宽的桶**真释放**(上一版缺的就是这一步)
    const dropLimit = o.streamM + B;
    for (const [key, b] of this.buckets) {
      if (!this.built.has(key)) continue;
      if (Math.hypot(camPos.x - b.cx, camPos.z - b.cz) > dropLimit) {
        if (b.inst) { this.group.remove(b.inst); b.inst.dispose(); b.inst = null; }
        if (b.blob) { this.group.remove(b.blob); b.blob.dispose(); b.blob = null; }
        this.built.delete(key);
        b.band = -1;
      }
    }
    // ④ 提交 + LOD: 球形距离 → band → 换几何 / 截断 count; blob 只给最近档
    let drawn = 0, buckets = 0, nearest = Infinity, blobs = 0;
    for (const b of this.buckets.values()) {
      if (!b.inst) continue;
      const dx = camPos.x - b.cx, dy = camPos.y, dz = camPos.z - b.cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < nearest) nearest = d;
      const band = d < o.lod1M ? 0 : d < o.lod2M ? 1 : d < o.cullM ? 2 : -1;
      if (b.band !== band) {
        b.band = band;
        if (band < 0) {
          b.inst.visible = false;
          if (b.blob) b.blob.visible = false;
          continue;
        }
        if (b.inst.geometry !== this.geos[band]) b.inst.geometry = this.geos[band];
        b.inst.count = Math.max(1, Math.floor(b.n * (band === 0 ? 1 : band === 1 ? o.lod2Keep : o.lod3Keep)));
        if (b.blob) b.blob.visible = band === 0 && o.blobShadow;
      }
      if (band < 0) continue;
      b.inst.visible = true;
      drawn += b.inst.count;
      buckets++;
      if (b.blob && b.blob.visible) blobs += b.blob.count;
    }
    this.stats.drawn = drawn;
    this.stats.drawnBuckets = buckets;
    this.stats.blobs = blobs;
    this.stats.built = this.built.size;
    this.stats.queued = this.pending.length;
    this.stats.nearestKm = Number.isFinite(nearest) ? nearest / 1000 : -1;
    this.stats.tickMs = performance.now() - t0;
  }

  /** 建(或继续填)一个桶。**分片**: 每次最多 FILL_CHUNK 棵, 避免单帧长卡 */
  private buildBucket(key: string): void {
    const b = this.buckets.get(key);
    const idx = this.bucketIdx.get(key);
    if (!b || !idx || !idx.length) { this.built.add(key); return; }
    const o = this.o, S = 6, raw = this.raw;
    let inst = b.inst, blob = b.blob;
    if (!inst) {
      inst = new THREE.InstancedMesh(this.geos[0], this.mat, idx.length);
      inst.castShadow = o.castShadow;
      inst.receiveShadow = false;
      inst.visible = false;                      // 填完才显示(否则会看到半桶树突然补齐)
      this.group.add(inst);
      b.inst = inst;
      if (o.blobShadow) {
        blob = new THREE.InstancedMesh(this.blobGeo, this.blobMat, idx.length);
        blob.castShadow = false; blob.receiveShadow = false; blob.renderOrder = 1;
        blob.visible = false;
        this.group.add(blob);
        b.blob = blob;
      }
    }
    const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
    const bmtx = new THREE.Matrix4(), bpos = new THREE.Vector3(), bscl = new THREE.Vector3();
    const col = new THREE.Color(), base = new THREE.Color(o.color);
    // === 按脚下的地表色 (per user request) ===
    // ⚠ 采样**一次/桶**, 不是每棵: 每棵都去问 terrain.baseColorAt 是上面 14ms 长卡的主因
    //   (3021 次地形采样)。地表色本来就是低频量, 按桶取中心值 + 逐棵明暗抖动即可。
    const hasG = !!this.groundAt;
    if (hasG && b.cursor === 0) {
      try {
        const gc = (this.groundAt as (x: number, z: number) => [number, number, number])(b.cx, b.cz);
        base.setRGB(
          base.r * (1 - o.groundMix) + gc[0] * o.groundMix,
          base.g * (1 - o.groundMix) + gc[1] * o.groundMix,
          base.b * (1 - o.groundMix) + gc[2] * o.groundMix,
        );
      } catch { /* 采样失败就用基色 */ }
    }
    const end = Math.min(idx.length, b.cursor + FILL_CHUNK);
    for (let k = b.cursor; k < end; k++) {
      const i = idx[k] * S;
      const x = raw[i], y = raw[i + 1], z = raw[i + 2];
      const h = Math.max(2, raw[i + 3]), r = Math.max(0.5, raw[i + 4]), rot = raw[i + 5];
      q.setFromAxisAngle(UP, rot);
      pos.set(x, y, z);
      scl.set(r, h, r);
      mtx.compose(pos, q, scl);
      inst.setMatrixAt(k, mtx);
      // === 按脚下的地表色变色 (per user request) ===
      // 建桶时采样一次(不是每帧) ⇒ 运行时零开销。地面偏枯/偏岩 ⇒ 树偏黄褐。
      if (hasG) {
        const j = 0.9 + ((i * 2654435761) % 1000) / 1000 * 0.2;   // 逐棵确定性明暗抖动
        col.copy(base).multiplyScalar(j);
        inst.setColorAt(k, col);
      }
      if (blob) {
        const br = r * 1.9;
        bpos.set(x, y + 0.35, z);
        bscl.set(br, 1, br);
        bmtx.compose(bpos, q, bscl);
        blob.setMatrixAt(k, bmtx);
      }
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    // ⚠ 必须重算包围球: 不算 ⇒ 以**原点**为中心的球 ⇒ 视锥剔除会整桶误剔
    inst.computeBoundingSphere();
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    if (blob) blob.instanceMatrix.needsUpdate = true;
    b.cursor = end;
    if (end < idx.length) return;              // 还没填完: 下一帧继续(不入 built, 仍不可见)
    inst.computeBoundingSphere();               // ⚠ 不算 ⇒ 以原点为中心的球 ⇒ 整桶被误剔
    if (blob) { blob.computeBoundingSphere(); blob.visible = true; }
    inst.visible = true;
    this.built.add(key);
    b.band = -1;                                // 下一帧重判 band
  }

  dispose(): void {
    for (const b of this.buckets.values()) {
      if (b.inst) { this.group.remove(b.inst); b.inst.dispose(); b.inst = null; }
      if (b.blob) { this.group.remove(b.blob); b.blob.dispose(); b.blob = null; }
    }
    this.built.clear(); this.pending = [];
    this.group.removeFromParent();
    for (const g of this.geos) g.dispose();
    this.blobGeo.dispose();
    this.mat.dispose();
    this.blobMat.dispose();
    if (this.mapTex) this.mapTex.dispose();
    this.loaded = false;
  }
}

/** 程序化软边圆盘 alpha(一次生成, 不占资产): 中心实、边缘透明 ⇒ 像一坨软影 */
function makeBlobAlpha(): THREE.Texture | null {
  try {
    const S = 64;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const ctx = cv.getContext('2d');
    if (!ctx) return null;
    const grd = ctx.createRadialGradient(S / 2, S / 2, S * 0.06, S / 2, S / 2, S * 0.5);
    grd.addColorStop(0, '#ffffff');
    grd.addColorStop(0.55, '#9a9a9a');
    grd.addColorStop(1, '#000000');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, S, S);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.NoColorSpace;
    return tex;
  } catch { return null; }
}
