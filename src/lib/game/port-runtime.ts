// === 港口运行时（实例化 + 按距离加载/卸载） ====================================
// 输入(由 blender/terrain/24_export_port.py 导出):
//   · public/models/port/port.glb          19 份**原型网格**(glTF Y-up ⇒ 与游戏坐标约定一致)
//   · port_instances.f32bin                每行 6 × float32: x, y, z, rotZ, 原型下标, 缩放
// 做法: 按"原型下标"分组 ⇒ 每个原型一个 **InstancedMesh** ⇒ 460 个物件 = **19 次 draw call**
//       (用户: "大数量建筑和东西都要实例化", "不能占用很多 draw call")
//       整座港口算一个**簇**, 用它的包围球到相机的距离决定加载/卸载(与植被同一套距离判据)。
// 为什么不像植被那样分桶流式: 港口只有几百个实例(不是 25 万棵树), 分桶收益为零, 但会引入
//   每桶一个网格 ⇒ draw call 反而变多。这里"整簇加载 + 距离剔除"才是 19 次的来源。
import * as THREE from 'three';
import { loadGLB } from './glb-asset';

export interface PortRuntimeOpts {
  scene: THREE.Scene;
  /** GLB 路径(相对 public/) */
  glbUrl: string;
  /** 实例数据(已解好的 Float32Array); 不给就按 instancesUrl fetch */
  instances?: Float32Array;
  instancesUrl?: string;
  /** 基座平台网格(军港基底, 27_export_plate.py 导出)。不导出它 ⇒ 建筑会悬空(见该脚本注释) */
  plateUrl?: string;
  /** 簇的包围球到相机的距离 > cullM 就整体隐藏(米) */
  cullM?: number;
}

export interface PortStats {
  loaded: boolean;
  protos: number;
  instances: number;
  drawn: number;
  visible: boolean;
  centerKm: [number, number, number];
  radiusKm: number;
  distKm: number;
  tickMs: number;
}

const UP = new THREE.Vector3(0, 1, 0);

export class PortRuntime {
  private scene: THREE.Scene;
  private o: Required<Pick<PortRuntimeOpts, 'cullM'>>;
  private glbUrl: string;
  private injected?: Float32Array;
  private instancesUrl?: string;
  private plateUrl?: string;
  private readonly group = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private center = new THREE.Vector3();
  private radius = 0;
  private loaded = false;
  private total = 0;
  private stats: PortStats = {
    loaded: false, protos: 0, instances: 0, drawn: 0, visible: false,
    centerKm: [0, 0, 0], radiusKm: 0, distKm: -1, tickMs: 0,
  };

  constructor(opts: PortRuntimeOpts) {
    this.scene = opts.scene;
    this.glbUrl = opts.glbUrl;
    this.injected = opts.instances;
    this.instancesUrl = opts.instancesUrl;
    this.plateUrl = opts.plateUrl;
    this.o = { cullM: opts.cullM ?? 90000 };
    this.group.name = 'PORT';
    // 港口**不能**打 _env 标记: loadSky() 挂载港口之后还会遍历场景删除所有 _env===true 的
    // 对象(清理上一关的程序化环境) ⇒ 港口会被那次清理扫掉(实测: s02 里 PORT 组 parent=null,
    // 19 个 InstancedMesh 全部不在场景中)。回收由 loadSky 显式 dispose。
    this.scene.add(this.group);
  }

  get object3d(): THREE.Group { return this.group; }
  getStats(): PortStats { return this.stats; }

  async load(): Promise<void> {
    // ① 实例表
    let tab = this.injected;
    if (!tab && this.instancesUrl) {
      try {
        const res = await fetch(this.instancesUrl);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        tab = new Float32Array(await res.arrayBuffer());
      } catch (e) {
        console.warn('[port] 实例表载入失败:', this.instancesUrl, e);
        return;
      }
    }
    if (!tab || tab.length < 6) {
      console.warn('[port] 没有实例数据 ⇒ 港口不加载');
      return;
    }
    // ② 原型网格(按名字排序 ⇒ 与导出的 P00..Pnn 顺序一致)
    let geos: THREE.BufferGeometry[] = [];
    let glbMat: THREE.Material | null = null;
    try {
      const glb = await loadGLB(this.glbUrl);
      const named: { n: string; g: THREE.BufferGeometry }[] = [];
      glb.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if ((m as unknown as { isMesh?: boolean }).isMesh && m.geometry) {
          named.push({ n: o.name, g: m.geometry });
          // ★ 带上 GLB 自带材质: 19 个原型共用一份 `PORT_BUILDING`(内嵌港口卫星图 +
          //   每个建筑烘好的贴图 UV)。以前这里 new MeshStandardMaterial(灰) ⇒ 卫星图
          //   白导出了, 游戏里建筑全是纯灰。
          const mm = Array.isArray(m.material) ? m.material[0] : m.material;
          if (!glbMat && mm) glbMat = mm as THREE.Material;
        }
      });
      named.sort((a, b) => a.n.localeCompare(b.n));
      geos = named.map((x) => x.g);
    } catch (e) {
      console.warn('[port] GLB 载入失败:', this.glbUrl, e);
      return;
    }
    if (!geos.length) {
      console.warn('[port] GLB 里没有网格');
      return;
    }
    // ③ 按原型分组 ⇒ 每个原型一个 InstancedMesh(共享几何/材质 ⇒ 少 draw call)
    const S = 6;
    const n = Math.floor(tab.length / S);
    const byProto = new Map<number, THREE.Matrix4[]>();
    const pos = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9, minz = 1e9, maxz = -1e9;
    for (let i = 0; i < n; i++) {
      const b = i * S;
      const x = tab[b], y = tab[b + 1], z = tab[b + 2];
      const rz = tab[b + 3], pi = Math.round(tab[b + 4]), s = tab[b + 5] || 1;
      const idx = Math.min(geos.length - 1, Math.max(0, pi));
      pos.set(x, y, z);
      q.setFromAxisAngle(UP, rz);
      scl.set(s, s, s);
      const m = new THREE.Matrix4().compose(pos, q, scl);
      let arr = byProto.get(idx);
      if (!arr) { arr = []; byProto.set(idx, arr); }
      arr.push(m);
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (z < minz) minz = z; if (z > maxz) maxz = z;
    }
    const mat = glbMat ?? new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.0 });
    for (const [idx, mats] of byProto) {
      const im = new THREE.InstancedMesh(geos[idx], mat, mats.length);
      im.name = 'PORT_PROTO_' + idx;
      im.castShadow = false;
      im.receiveShadow = true;
      for (let k = 0; k < mats.length; k++) im.setMatrixAt(k, mats[k]);
      im.instanceMatrix.needsUpdate = true;
      // ⚠ 必须重算包围球: 不算 ⇒ 以原点为中心的球 ⇒ 视锥剔除整批误剔(植物那边踩过同样的坑)
      im.computeBoundingSphere();
      this.group.add(im);
      this.meshes.push(im);
    }
    // ④ 基座平台(军港基底): 一块 95km×45km、顶面 y=2572 m 的平台。**不加载它, 459 栋
    //    建筑就是悬空 1.8 km 漂着** —— 那处地形只有 106 m、海面 766 m(实测)。
    //    网格顶点已经烘到世界坐标(27_export_plate.py), 直接 add 即可; 与建筑同属 PORT 组
    //    ⇒ 跟着簇一起按距离装卸。
    if (this.plateUrl) {
      try {
        const pg = await loadGLB(this.plateUrl);
        const plates: THREE.Mesh[] = [];
        pg.scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if ((m as unknown as { isMesh?: boolean }).isMesh && m.geometry) plates.push(m);
        });
        for (const m of plates) {
          // 只接收阴影、不投射: 引擎的太阳阴影相机只覆盖玩家 ±4 km, 让一块 95 km 的板
          // 参与投影只会把这个区域整个填满、出现整片自阴影接缝。
          m.castShadow = false;
          m.receiveShadow = true;
          this.group.add(m);
        }
        if (plates.length) console.info(`[port] 基座网格 ${plates.length} 个已挂载`);
      } catch (e) {
        console.warn('[port] 基座载入失败(建筑会悬空):', e);
      }
    }
    this.center.set((minx + maxx) / 2, (miny + maxy) / 2, (minz + maxz) / 2);
    this.radius = 0.5 * Math.hypot(maxx - minx, maxy - miny, maxz - minz);
    this.loaded = true;
    this.total = n;
    this.stats.loaded = true;
    this.stats.protos = this.meshes.length;
    this.stats.instances = n;
    this.stats.centerKm = [this.center.x / 1000, this.center.y / 1000, this.center.z / 1000];
    this.stats.radiusKm = this.radius / 1000;
    console.info(`[port] ${n} 个实例 / ${this.meshes.length} 个原型(InstancedMesh)`
      + ` · 簇半径 ${(this.radius / 1000).toFixed(1)} km · cull ${(this.o.cullM / 1000).toFixed(0)} km`);
  }

  /** 每帧一次: 簇的距离决定整体提交(远处直接不画 ⇒ "按距离卸载") */
  tick(camPos: THREE.Vector3): void {
    if (!this.loaded) return;
    const t0 = performance.now();
    const d = Math.max(0, camPos.distanceTo(this.center) - this.radius);
    const show = d <= this.o.cullM;
    if (this.group.visible !== show) this.group.visible = show;
    // ⚠ 曾经这里有"第二档 LOD": 太远就把每个原型的 count 砍到 34%。砍掉的是**任意**三分之一
    //   建筑(不是空间上远处那批) ⇒ 30 km 外看到的是"建了一半的港区", 比降低细节难看得多;
    //   而 459 个实例总共 19 次 draw call, 省下来的量微不足道。整簇按距离装卸就够了。
    this.stats.drawn = show ? this.total : 0;
    this.stats.visible = show;
    this.stats.distKm = d / 1000;
    this.stats.tickMs = performance.now() - t0;
  }

  dispose(): void {
    for (const im of this.meshes) {
      this.group.remove(im);
      im.dispose();
    }
    this.meshes = [];
    this.group.removeFromParent();
    this.loaded = false;
  }
}
