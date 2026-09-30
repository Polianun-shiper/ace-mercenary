// === 编辑器资产放置 (per user request: 场景里放置游戏资产 + 移动旋转缩放) ===
// 资产库(procedural builders 来自 environment.ts / models.ts)+ 场景大纲
// (选择/隐藏/删除)+ TransformControls 变换 gizmo。放置物序列化进项目 JSON:
// 只存 (def + 变换 + 参数),载入时用同一 builder 重建 —— 不序列化几何。
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { SkyConfig } from '../game/environment';
import {
  buildTank, buildSamLauncher, buildBunker, buildRadarStation,
  buildArtillery, buildDestroyer, buildCarrier, buildSandDune,
  buildRockyOutcrop, buildOasis, buildAlpineLake, buildHighway,
} from '../game/environment';
import { loadAircraftGeometry, buildAircraftMesh, buildProceduralGeometry } from '../game/models';
import type { AircraftModel } from '../game/types';

// ===========================================================================
// 资产库
// ===========================================================================
export interface PaletteBuildCtx {
  cfg: SkyConfig;
  pos: THREE.Vector3;
}
export interface PaletteEntry {
  def: string;        // 唯一 id(序列化用)
  label: string;      // 中文名
  category: '飞机' | '载具' | '设施' | '地形道具' | '灯光' | '探针' | '几何体';
  build: (ctx: PaletteBuildCtx) => THREE.Object3D | Promise<THREE.Object3D>;
}

const aircraftModel: Record<string, AircraftModel> = {
  f16: 'f16', b52: 'b52', ac130: 'ac130',
  su35: 'su35', f15: 'f15', a10: 'a10', f117: 'f117', e3: 'e3',
};

function buildAircraft(def: string): PaletteEntry['build'] {
  return async ({ pos }) => {
    const model = aircraftModel[def];
    let geom: THREE.BufferGeometry;
    try {
      geom = (await loadAircraftGeometry(model)).geometry;
    } catch {
      geom = buildProceduralGeometry(model);
    }
    const mesh = buildAircraftMesh(geom, model === 'b52' || model === 'ac130' ? 0x5a6a4a : 0x9aa8b4);
    const g = new THREE.Group();
    g.add(mesh);
    g.position.copy(pos);
    g.position.y += 20;
    return g;
  };
}

function staticProp(build: (cfg: SkyConfig, pos: THREE.Vector3) => THREE.Object3D, yOffset = 0): PaletteEntry['build'] {
  return ({ cfg, pos }) => {
    const o = build(cfg, pos);
    o.position.y += yOffset;
    return o;
  };
}

function makeLight(kind: 'dir' | 'point'): PaletteEntry['build'] {
  return ({ pos }) => {
    if (kind === 'dir') {
      const l = new THREE.DirectionalLight(0xffffff, 2.5);
      l.position.copy(pos).add(new THREE.Vector3(0, 3000, 0));
      l.castShadow = false;
      l.userData.editorLight = 'dir';
      return l;
    }
    const l = new THREE.PointLight(0xffb060, 150000, 6000, 2);
    l.position.copy(pos).add(new THREE.Vector3(0, 150, 0));
    l.userData.editorLight = 'point';
    // debug 小球
    const s = new THREE.Mesh(
      new THREE.SphereGeometry(30, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffcc66, wireframe: true }),
    );
    l.add(s);
    return l;
  };
}

/** 内置资产库(探针项由 editor-probes 注册) */
export const PALETTE: PaletteEntry[] = [
  { def: 'aircraft-f16', label: 'F-16', category: '飞机', build: buildAircraft('f16') },
  { def: 'aircraft-b52', label: 'B-52', category: '飞机', build: buildAircraft('b52') },
  { def: 'aircraft-ac130', label: 'AC-130', category: '飞机', build: buildAircraft('ac130') },
  { def: 'aircraft-su35', label: 'Su-35', category: '飞机', build: buildAircraft('su35') },
  { def: 'aircraft-f15', label: 'F-15', category: '飞机', build: buildAircraft('f15') },
  { def: 'aircraft-a10', label: 'A-10', category: '飞机', build: buildAircraft('a10') },
  { def: 'vehicle-tank', label: '坦克', category: '载具', build: ({ cfg, pos }) => buildTank(cfg, false) },
  { def: 'vehicle-sam', label: '防空导弹车', category: '载具', build: ({ cfg, pos }) => buildSamLauncher(cfg, false) },
  { def: 'vehicle-artillery', label: '火炮', category: '载具', build: ({ cfg, pos }) => buildArtillery(cfg, false) },
  { def: 'ship-destroyer', label: '驱逐舰', category: '载具', build: ({ cfg, pos }) => buildDestroyer(cfg, false) },
  { def: 'ship-carrier', label: '航母', category: '载具', build: ({ cfg, pos }) => buildCarrier(cfg) },
  { def: 'struct-bunker', label: '碉堡', category: '设施', build: ({ cfg, pos }) => buildBunker(cfg, false) },
  { def: 'struct-radar', label: '雷达站', category: '设施', build: ({ cfg, pos }) => buildRadarStation(cfg, false) },
  { def: 'prop-dune', label: '沙丘', category: '地形道具', build: staticProp((cfg, p) => buildSandDune(cfg, p, 1200)) },
  { def: 'prop-outcrop', label: '岩石山', category: '地形道具', build: staticProp((cfg, p) => buildRockyOutcrop(cfg, p)) },
  { def: 'prop-oasis', label: '绿洲', category: '地形道具', build: staticProp((cfg, p) => buildOasis(cfg, p)) },
  { def: 'prop-lake', label: '高山湖', category: '地形道具', build: staticProp((cfg, p) => buildAlpineLake(cfg, p, 400)) },
  { def: 'light-dir', label: '方向光', category: '灯光', build: makeLight('dir') },
  { def: 'light-point', label: '点光源', category: '灯光', build: makeLight('point') },
  { def: 'prim-cube', label: '立方体', category: '几何体', build: ({ pos }) => new THREE.Mesh(new THREE.BoxGeometry(200, 200, 200), new THREE.MeshStandardMaterial({ color: 0xcccccc })) },
  { def: 'prim-cylinder', label: '圆柱', category: '几何体', build: ({ pos }) => new THREE.Mesh(new THREE.CylinderGeometry(120, 120, 240, 16), new THREE.MeshStandardMaterial({ color: 0xcccccc })) },
  { def: 'prim-sphere', label: '球体', category: '几何体', build: ({ pos }) => new THREE.Mesh(new THREE.SphereGeometry(150, 16, 12), new THREE.MeshStandardMaterial({ color: 0xcccccc })) },
];

export function registerPaletteEntry(e: PaletteEntry) {
  if (!PALETTE.some((p) => p.def === e.def)) PALETTE.push(e);
}
export function findPaletteDef(def: string): PaletteEntry | undefined {
  return PALETTE.find((p) => p.def === def);
}

// ===========================================================================
// 场景大纲 actor
// ===========================================================================
export interface EditorActor {
  id: string;
  name: string;
  def: string;                        // palette def
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
  extra?: Record<string, unknown>;    // 探针强度/半径等
}

export class ActorStore {
  actors: EditorActor[] = [];
  private seq = 1;

  nextName(def: string): string {
    const entry = findPaletteDef(def);
    const base = entry?.label ?? def;
    let n = 1;
    let name = `${base}_${n}`;
    while (this.actors.some((a) => a.name === name)) name = `${base}_${++n}`;
    return name;
  }

  add(def: string, obj: THREE.Object3D): EditorActor {
    const a: EditorActor = {
      id: `actor-${Date.now()}-${this.seq++}`,
      name: this.nextName(def),
      def,
      position: [obj.position.x, obj.position.y, obj.position.z],
      quaternion: [obj.quaternion.x, obj.quaternion.y, obj.quaternion.z, obj.quaternion.w],
      scale: [obj.scale.x, obj.scale.y, obj.scale.z],
    };
    obj.userData.actorId = a.id;
    this.actors.push(a);
    return a;
  }

  get(id: string) { return this.actors.find((a) => a.id === id); }
  remove(id: string) {
    this.actors = this.actors.filter((a) => a.id !== id);
  }
  rename(id: string, name: string) {
    const a = this.get(id);
    if (a) a.name = name;
  }
  /** 从 TransformControls 拖拽后同步回存储 */
  syncFromObject(id: string, obj: THREE.Object3D) {
    const a = this.get(id);
    if (!a) return;
    a.position = [obj.position.x, obj.position.y, obj.position.z];
    a.quaternion = [obj.quaternion.x, obj.quaternion.y, obj.quaternion.z, obj.quaternion.w];
    a.scale = [obj.scale.x, obj.scale.y, obj.scale.z];
  }
  serialize(): EditorActor[] { return this.actors.map((a) => ({ ...a })); }
  load(list: EditorActor[]) {
    this.actors = list.map((a) => ({ ...a, id: a.id || `actor-${Date.now()}-${this.seq++}` }));
    this.seq = this.actors.length + 100;
  }
}

// ===========================================================================
// TransformControls 封装
// ===========================================================================
export class EditorGizmo {
  readonly controls: TransformControls;
  private onDragSync?: (obj: THREE.Object3D) => void;

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement) {
    this.controls = new TransformControls(camera, domElement);
    this.controls.setSize(0.9);
    // gizmo 自身不参与地面拾取/放置射线(helper 是实际渲染的 Group)
    this.controls.getHelper().traverse((o) => { o.userData.editorPlaceable = false; });
    this.controls.addEventListener('dragging-changed', (e) => {
      // 拖拽时冻结飞行相机;结束恢复
      this.onFrozenChange?.(Boolean((e as unknown as { value: boolean }).value));
    });
    this.controls.addEventListener('objectChange', () => {
      if (this.controls.object) this.onDragSync?.(this.controls.object);
    });
  }
  /** gizmo 激活/释放时回调(EditorApp 用于冻结飞行相机) */
  onFrozenChange: ((frozen: boolean) => void) | null = null;

  attach(obj: THREE.Object3D, sync: (o: THREE.Object3D) => void) {
    this.onDragSync = sync;
    this.controls.attach(obj);
  }
  detach() {
    this.onDragSync = undefined;
    this.controls.detach();
  }
  setMode(m: 'translate' | 'rotate' | 'scale') { this.controls.setMode(m); }
  get mode() { return this.controls.getMode() as 'translate' | 'rotate' | 'scale'; }
  get hasObject() { return this.controls.object != null; }
}
