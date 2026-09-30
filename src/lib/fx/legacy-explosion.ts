// === 原生爆炸复刻(编辑器 A/B 对比用) ===
// FX 编辑器要与游戏内原生爆炸直接对照调参时使用:按 weapons.ts
// spawnExplosion() 的高 LOD 六层(闪光/火球/烟幕/冲击波环/火花×2点光)同
// 参数、同逐帧动画公式独立复刻(编辑器不能依赖 WeaponSystem 运行上下文)。
// 仅供编辑器视口对比,游戏运行时永不引用。
import * as THREE from 'three';

const FLASH_COLOR = 0xffffff;
const FIRE_COLOR = 0xffaa44;
const SMOKE_COLOR = 0x3a3030;
const RING_COLOR = 0xffd080;
const SPARK_COLORS = [0xffe080, 0xff8030];
const SMOKE_LIFE = 2.2;
const FIRE_LIFE = 1.4;
const RING_LIFE = 0.6;
const GLOW_LIFE = 1.0;

interface Layer {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  light: THREE.PointLight | null;
  life: number;
  maxLife: number;
  ring?: boolean; // RingGeometry 命中判定缓存
}
interface Spark {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
}

export class LegacyExplosion {
  private layers: Layer[] = [];
  private sparks: Spark[] = [];
  private sphereGeo: THREE.SphereGeometry;
  private _sparkGeo: THREE.SphereGeometry | null = null;
  private scene: THREE.Scene;
  /** 游戏内击杀级爆炸 scale≈1.8-2.0;AB 对比默认取 2 */
  readonly scale: number;

  constructor(scene: THREE.Scene, pos: THREE.Vector3, scale = 2) {
    this.scene = scene;
    this.scale = scale;
    this.sphereGeo = new THREE.SphereGeometry(1, 12, 8);
    const p = pos;

    // 1. 初始闪光(白,additive,0.12s)
    const flashMat = new THREE.MeshBasicMaterial({ color: FLASH_COLOR, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    const flash = new THREE.Mesh(this.sphereGeo, flashMat);
    flash.position.copy(p);
    flash.scale.setScalar(scale * 0.8);
    scene.add(flash);
    this.layers.push({ mesh: flash, mat: flashMat, light: null, life: 0.12, maxLife: 0.12 });

    // 2. 主火球(橙,additive,1.4s + 点光 5/700/2)
    const fireMat = new THREE.MeshBasicMaterial({ color: FIRE_COLOR, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    const fire = new THREE.Mesh(this.sphereGeo, fireMat);
    fire.position.copy(p);
    fire.scale.setScalar(scale * 0.2);
    scene.add(fire);
    const fireLight = new THREE.PointLight(FIRE_COLOR, 5, 700, 2);
    fireLight.position.copy(p);
    scene.add(fireLight);
    this.layers.push({ mesh: fire, mat: fireMat, light: fireLight, life: FIRE_LIFE, maxLife: FIRE_LIFE });

    // 3. 烟幕(灰,normal,2.2s)
    const smokeMat = new THREE.MeshBasicMaterial({ color: SMOKE_COLOR, transparent: true, opacity: 0.75, blending: THREE.NormalBlending, depthWrite: false });
    const smoke = new THREE.Mesh(this.sphereGeo, smokeMat);
    smoke.position.copy(p);
    smoke.scale.setScalar(scale * 0.3);
    scene.add(smoke);
    this.layers.push({ mesh: smoke, mat: smokeMat, light: null, life: SMOKE_LIFE, maxLife: SMOKE_LIFE });

    // 4. 冲击波环(环几何,additive,0.6s,随机朝向同游戏)
    const ringGeo = new THREE.RingGeometry(0.5, 0.7, 24);
    const ringMat = new THREE.MeshBasicMaterial({ color: RING_COLOR, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.copy(p);
    ring.rotation.x = Math.random() * Math.PI;
    ring.rotation.y = Math.random() * Math.PI;
    ring.scale.setScalar(scale * 0.4);
    scene.add(ring);
    this.layers.push({ mesh: ring, mat: ringMat, light: null, life: RING_LIFE, maxLife: RING_LIFE, ring: true });

    // 5. 火花 8-12 颗(additive 小球,无重力飞行,0.7-1.1s)
    const sparkCount = Math.floor(8 + Math.random() * 5);
    for (let i = 0; i < sparkCount; i++) {
      const sparkMat = new THREE.MeshBasicMaterial({ color: SPARK_COLORS[i % 2], transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
      if (!this._sparkGeo) this._sparkGeo = new THREE.SphereGeometry(0.45, 5, 4);
      const spark = new THREE.Mesh(this._sparkGeo, sparkMat);
      spark.position.copy(p);
      spark.scale.setScalar(scale * 0.15);
      scene.add(spark);
      const angle = Math.random() * Math.PI * 2;
      const elev = (Math.random() - 0.5) * Math.PI;
      const speed = 18 + Math.random() * 20;
      this.sparks.push({
        mesh: spark,
        vel: new THREE.Vector3(Math.cos(angle) * Math.cos(elev) * speed, Math.sin(elev) * speed, Math.sin(angle) * Math.cos(elev) * speed),
        life: 0.7 + Math.random() * 0.4,
      });
    }

    // 6. 余辉暖光(0xff8030,2/500/2,1s)—— ghost mesh 只当寿命载体
    const ghostMat = new THREE.MeshBasicMaterial();
    const glowLight = new THREE.PointLight(0xff8030, 2, 500, 2);
    glowLight.position.copy(p);
    scene.add(glowLight);
    const ghost = new THREE.Mesh(new THREE.BufferGeometry(), ghostMat);
    this.layers.push({ mesh: ghost, mat: ghostMat, light: glowLight, life: GLOW_LIFE, maxLife: GLOW_LIFE });
  }

  get alive(): boolean {
    return this.layers.length > 0 || this.sparks.length > 0;
  }

  /** 逐帧积分(与 weapons.ts 爆炸 tick 同公式:层按色/几何类型定增长率)。 */
  step(dt: number) {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const ex = this.layers[i];
      ex.life -= dt;
      const t = Math.max(0, 1 - ex.life / ex.maxLife);
      let growthRate = 6;
      if (ex.mat.color && ex.mat.color.getHex() === SMOKE_COLOR) growthRate = 4;
      else if (ex.ring) growthRate = 14;
      else if (ex.mat.color && ex.mat.color.getHex() === RING_COLOR) growthRate = 14;
      ex.mesh.scale.setScalar(THREE.MathUtils.lerp(ex.mesh.scale.x, ex.mesh.scale.x + 0.001 + t * growthRate, 0.5));
      ex.mat.opacity = Math.max(0, 1 - t);
      if (ex.light && ex.light.intensity > 0) ex.light.intensity = Math.max(0, 4 * (1 - t));
      if (ex.life <= 0) {
        this.scene.remove(ex.mesh);
        if (ex.light && (ex.light.intensity > 0 || ex.light.distance > 0)) this.scene.remove(ex.light);
        ex.mat.dispose();
        const g = ex.mesh.geometry as THREE.BufferGeometry;
        if (g && (g.type === 'RingGeometry' || (g.type === 'BufferGeometry' && g.attributes.position === undefined))) g.dispose();
        this.layers.splice(i, 1);
      }
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.life -= dt;
      if (s.life <= 0) {
        this.scene.remove(s.mesh);
        (s.mesh.material as THREE.Material).dispose();
        this.sparks.splice(i, 1);
        continue;
      }
      s.mesh.position.addScaledVector(s.vel, dt);
    }
  }

  dispose() {
    for (const ex of this.layers) {
      this.scene.remove(ex.mesh);
      if (ex.light && (ex.light.intensity > 0 || ex.light.distance > 0)) this.scene.remove(ex.light);
      try { ex.mat.dispose(); } catch { /* noop */ }
    }
    for (const s of this.sparks) {
      this.scene.remove(s.mesh);
      try { (s.mesh.material as THREE.Material).dispose(); } catch { /* noop */ }
    }
    this.layers.length = 0;
    this.sparks.length = 0;
    this.sphereGeo.dispose();
    if (this._sparkGeo) this._sparkGeo.dispose();
  }
}
