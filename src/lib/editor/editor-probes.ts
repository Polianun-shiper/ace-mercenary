// === 天光 / 反射捕获 (per user request: 放置天光捕获和反射捕获球 debug) ===
// 天光捕获:PMREM 从大气天空生成全局 IBL(scene.environment),摆放的"天光球"
// 只是标记 + 强度调节;天空参数变化后防抖重新生成。
// 反射捕获:每个捕获球用 CubeCamera 六面渲染当前位置(捕获时隐藏自身与其它
// 捕获球)→ PMREM → 球体 debug 显示 + 可选作用于半径内材质的 envMap。
import * as THREE from 'three';
import { registerPaletteEntry, type PaletteEntry } from './editor-placement';

export interface ReflectionCapture {
  id: string;
  root: THREE.Group;       // 世界里的球体(debug)
  camera: THREE.CubeCamera;
  pmremTex: THREE.Texture | null;
  resolution: number;
  radius: number;          // 作用半径(世界单位)
  applyToMaterials: boolean;
  capturedAt: number;
}

export class ProbesManager {
  readonly reflections: ReflectionCapture[] = [];
  private skyScene: THREE.Scene | null = null;
  private pmrem: THREE.PMREMGenerator | null = null;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
  ) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    registerPaletteEntry(this.skylightEntry());
    registerPaletteEntry(this.reflectionEntry());
  }

  private skylightEntry(): PaletteEntry {
    return {
      def: 'probe-skylight',
      label: '天光捕获球',
      category: '探针',
      build: ({ pos }) => {
        const g = new THREE.Group();
        const mesh = new THREE.Mesh(
          new THREE.SphereGeometry(120, 20, 14),
          new THREE.MeshBasicMaterial({ color: 0x66ccff, wireframe: true }),
        );
        mesh.userData.editorPlaceable = false;
        g.add(mesh);
        g.position.copy(pos);
        g.userData.probeKind = 'skylight';
        return g;
      },
    };
  }

  private reflectionEntry(): PaletteEntry {
    return {
      def: 'probe-reflection',
      label: '反射捕获球',
      category: '探针',
      build: ({ pos }) => {
        const g = new THREE.Group();
        const mesh = new THREE.Mesh(
          new THREE.SphereGeometry(140, 20, 14),
          new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.15, metalness: 0.9 }),
        );
        mesh.userData.editorPlaceable = false;
        g.add(mesh);
        g.position.copy(pos);
        g.userData.probeKind = 'reflection';
        return g;
      },
    };
  }

  /** 天光:用大气天空重建全局 IBL(天空参数变化后由 world 防抖调用)。 */
  regenerateSkylightEnv(skyMesh: THREE.Mesh) {
    if (!this.pmrem) return;
    if (!this.skyScene) {
      this.skyScene = new THREE.Scene();
    }
    const old = this.skyScene.children[0];
    if (old) this.skyScene.remove(old);
    this.skyScene.add(skyMesh.clone());
    const rt = this.pmrem.fromScene(this.skyScene, 0.04, 256, 512);
    const prev = this.scene.environment;
    this.scene.environment = rt.texture;
    prev?.dispose?.();
  }

  /** 注册一个反射捕获球(放置后由 world 调用,并触发一次捕获)。 */
  registerReflection(root: THREE.Group, opts?: { resolution?: number; radius?: number }): ReflectionCapture {
    const resolution = opts?.resolution ?? 128;
    const cubeRT = new THREE.WebGLCubeRenderTarget(resolution);
    const camera = new THREE.CubeCamera(1, 300000, cubeRT);
    root.add(camera);
    const cap: ReflectionCapture = {
      id: `refl-${Date.now()}`,
      root,
      camera,
      pmremTex: null,
      resolution,
      radius: opts?.radius ?? 6000,
      applyToMaterials: false,
      capturedAt: 0,
    };
    this.reflections.push(cap);
    this.capture(cap);
    return cap;
  }

  unregisterReflection(cap: ReflectionCapture) {
    const i = this.reflections.indexOf(cap);
    if (i >= 0) this.reflections.splice(i, 1);
    cap.pmremTex?.dispose?.();
    cap.camera.renderTarget.dispose();
  }

  /** 六面捕获 → PMREM,并把结果贴到 debug 球上。 */
  capture(cap: ReflectionCapture) {
    if (!this.pmrem) return;
    const mesh = cap.root.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh | undefined;
    // 捕获时隐藏所有捕获球自身 + 探针 debug,避免自反射/黑点
    const hidden: THREE.Object3D[] = [];
    for (const r of this.reflections) {
      if (r.root.visible) { r.root.visible = false; hidden.push(r.root); }
    }
    this.scene.traverse((o) => {
      if (o.userData.probeKind && o.visible) { o.visible = false; hidden.push(o); }
    });
    cap.camera.position.copy(cap.root.position);
    cap.camera.update(this.renderer, this.scene);
    cap.pmremTex?.dispose?.();
    cap.pmremTex = this.pmrem.fromCubemap(cap.camera.renderTarget.texture).texture;
    for (const h of hidden) h.visible = true;
    cap.capturedAt = performance.now();
    if (mesh) {
      const m = mesh.material as THREE.MeshStandardMaterial;
      m.envMap = cap.pmremTex;
      m.envMapIntensity = 1.2;
      m.needsUpdate = true;
    }
    this.applyRadius(cap);
  }

  refreshAll() {
    for (const r of this.reflections) this.capture(r);
  }

  /** 把捕获环境应用到半径内资产的材质(切换开关/半径后重算)。 */
  applyRadius(cap: ReflectionCapture) {
    if (!cap.pmremTex) return;
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || o.userData.probeKind || o.userData.editorPlaceable === false) return;
      const d = o.getWorldPosition(new THREE.Vector3()).distanceTo(cap.root.position);
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        if (!mat || !('envMap' in mat)) continue;
        const mm = mat as THREE.MeshStandardMaterial;
        if (cap.applyToMaterials && d <= cap.radius) {
          mm.envMap = cap.pmremTex;
          mm.envMapIntensity = 0.7;
          mm.needsUpdate = true;
        } else if (mm.envMap === cap.pmremTex) {
          mm.envMap = null;
          mm.needsUpdate = true;
        }
      }
    });
  }

  dispose() {
    for (const r of [...this.reflections]) this.unregisterReflection(r);
    this.pmrem?.dispose();
    this.pmrem = null;
  }
}
