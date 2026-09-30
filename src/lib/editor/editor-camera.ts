// === 编辑器自由飞行相机 (per user request: UE5 编辑器式主视角) ===
// UE 风格:按住右键拖动环视、WASD 平移、Q/E 升降、Shift 加速、
// 滚轮调飞行速度、F 聚焦选中物体。与 OrbitControls/FlyControls 无关,
// 纯 yaw/pitch 手工实现 —— 保证"编辑时环视不翻滚"的编辑器手感。
import * as THREE from 'three';

export class EditorFlyCamera {
  readonly camera: THREE.PerspectiveCamera;
  // 飞行速度(世界单位/秒),滚轮可调
  speed = 120;
  /** 变换 gizmo 激活时置 true —— 冻结移动/环视,把输入让给 TransformControls */
  frozen = false;

  private yaw = 0;
  private pitch = -0.35;
  private keys = new Set<string>();
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(60, aspect, 1, 200000);
    // 从山岳地图上空斜视地形
    this.camera.position.set(6000, 9000, 12000);
    this.lookAt(new THREE.Vector3(0, 0, 0));
    // 记录初始 yaw/pitch,与构造位置一致
    const dir = new THREE.Vector3().subVectors(new THREE.Vector3(0, 0, 0), this.camera.position).normalize();
    this.yaw = Math.atan2(-dir.x, -dir.z);
    this.pitch = Math.asin(dir.y);
  }

  setAspect(a: number) {
    this.camera.aspect = a;
    this.camera.updateProjectionMatrix();
  }

  /** 跳到目标点并朝向它(双点) */
  focusAt(target: THREE.Vector3, dist = 600) {
    const dir = new THREE.Vector3().subVectors(this.camera.position, target).normalize();
    if (dir.lengthSq() < 1e-6) dir.set(0, 0.3, -1).normalize();
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.lookAt(target);
  }

  lookAt(target: THREE.Vector3) {
    this.camera.lookAt(target);
    const dir = new THREE.Vector3().subVectors(target, this.camera.position).normalize();
    this.yaw = Math.atan2(-dir.x, -dir.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
  }

  // --- 输入(EditorApp 转发 DOM 事件) ---
  onKeyDown(code: string) { this.keys.add(code); }
  onKeyUp(code: string) { this.keys.delete(code); }
  onMouseDown(x: number, y: number) { this.dragging = true; this.lastX = x; this.lastY = y; }
  onMouseMove(x: number, y: number) {
    if (!this.dragging) return;
    const dx = x - this.lastX;
    const dy = y - this.lastY;
    this.lastX = x;
    this.lastY = y;
    if (this.frozen) return;
    const sens = 0.0026;
    this.yaw -= dx * sens;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * sens, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
  }
  onMouseUp() { this.dragging = false; }
  onWheel(deltaY: number) {
    const k = deltaY > 0 ? 0.8 : 1.25;
    this.speed = THREE.MathUtils.clamp(this.speed * k, 5, 20000);
  }

  update(dt: number) {
    if (this.frozen) return;
    const s = this.speed * (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 3 : 1) * Math.min(dt, 0.1);
    const f = new THREE.Vector3();
    this.camera.getWorldDirection(f);
    const right = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const move = new THREE.Vector3();
    if (this.keys.has('KeyW')) move.add(f);
    if (this.keys.has('KeyS')) move.sub(f);
    if (this.keys.has('KeyD')) move.add(right);
    if (this.keys.has('KeyA')) move.sub(right);
    if (this.keys.has('KeyE')) move.add(up);
    if (this.keys.has('KeyQ')) move.sub(up);
    if (move.lengthSq() > 0) this.camera.position.addScaledVector(move.normalize(), s);

    // yaw/pitch → 相机朝向
    const dir = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    const look = this.camera.position.clone().add(dir);
    this.camera.lookAt(look);
  }

  /** 地面放置射线:从屏幕中心向前方射出,取与地形/资产的最近交点。 */
  rayFromCenter(scene: THREE.Scene, raycaster: THREE.Raycaster): { point: THREE.Vector3; normal: THREE.Vector3; hit: boolean } {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    raycaster.set(this.camera.position, dir);
    raycaster.far = 300000;
    const hits = raycaster.intersectObjects(scene.children, true);
    const ground = hits.find((h) => h.object.userData.editorPlaceable !== false);
    if (!ground) return { point: this.camera.position.clone().addScaledVector(dir, 1000), normal: new THREE.Vector3(0, 1, 0), hit: false };
    return { point: ground.point, normal: ground.face ? ground.face.normal : new THREE.Vector3(0, 1, 0), hit: true };
  }
}
