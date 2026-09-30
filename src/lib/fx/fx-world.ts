// === FX 预览世界 (per user request: 特效编辑器外壳,3A 对标) ===
// 独立预览场景:渐变天空 + 地面平面 + 参考网格 + 太阳/环境光 + bloom;
// 点击发射当前 FX;时间控制(pause/speed/loop/scrub);复用 EditorFlyCamera。
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { EditorFlyCamera } from '../editor/editor-camera';
import { FxSystem, sheetFootLift, type FxAsset, type FxEmitterCfg } from './fx-core';
import { LegacyExplosion } from './legacy-explosion';

export interface FxWorldOptions {
  onStats?: (s: { fps: number; particles: number; time: number }) => void;
}

export class FxWorld {
  readonly flyCam: EditorFlyCamera;
  readonly system: FxSystem;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private composer: EffectComposer;
  private raycaster = new THREE.Raycaster();
  private ground: THREE.Mesh;
  private disposed = false;

  // 时间状态
  paused = false;
  speed = 1;
  loop = true;
  /** 循环时长(秒),时间轴长度 */
  loopDuration = 4;
  private time = 0;
  // 连续发射器累计(按 rate 产粒子)
  private continuousAccum = new Map<string, number>();

  private fpsAccum = 0;
  private fpsFrames = 0;
  private lastFps = 0;
  private statsTimer = 0;

  // === A/B 对比(per user request: 能看到原生游戏特效 vs 准备替换的特效) ===
  /** preset=只播序列帧预设;legacy=只播原生爆炸复刻;side=左右同屏(左原生 右预设) */
  compareMode: 'preset' | 'legacy' | 'side' = 'preset';
  /** 原生复刻的 scale(游戏击杀级爆炸 ≈1.8-2.0) */
  legacyScale = 2;
  private legacyFx: LegacyExplosion[] = [];
  private lastLegacySpawn: THREE.Vector3 | null = null;
  /** 并排间距(世界单位) */
  private readonly SIDE_GAP = 520;

  constructor(private canvas: HTMLCanvasElement, private opts: FxWorldOptions = {}) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
    this.renderer.setSize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);

    this.scene.background = new THREE.Color('#14171c');
    this.scene.fog = new THREE.Fog('#14171c', 800, 6000);

    // 灯光
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(400, 600, 300);
    this.scene.add(sun);
    this.scene.add(new THREE.HemisphereLight('#8ea4c0', '#2a2e38', 0.8));

    // 天空渐变 dome
    const skyGeo = new THREE.SphereGeometry(9000, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color('#0a0f1a') }, bottom: { value: new THREE.Color('#2a3446') } },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float t = clamp(normalize(vP).y * 0.5 + 0.5, 0.0, 1.0); gl_FragColor = vec4(mix(bottom, top, t), 1.0); }',
    });
    const sky = new THREE.Mesh(skyGeo, skyMat);
    sky.renderOrder = -1000;
    this.scene.add(sky);

    // 地面 + 网格
    const groundGeo = new THREE.PlaneGeometry(12000, 12000);
    const groundMat = new THREE.MeshStandardMaterial({ color: '#1d2128', roughness: 1, metalness: 0 });
    this.ground = new THREE.Mesh(groundGeo, groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    const grid = new THREE.GridHelper(4000, 80, '#3a4656', '#232a36');
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    this.scene.add(grid);

    this.flyCam = new EditorFlyCamera(canvas.clientWidth / Math.max(1, canvas.clientHeight));
    this.flyCam.camera.position.set(0, 260, 900);
    this.flyCam.lookAt(new THREE.Vector3(0, 60, 0));

    // bloom(3A 特效观感)
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.flyCam.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(this.canvas.clientWidth, this.canvas.clientHeight), 0.85, 0.5, 0.85));
    this.composer.addPass(new OutputPass());

    this.system = new FxSystem(this.scene);
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.flyCam.setAspect(w / Math.max(1, h));
    this.composer.setSize(w, h);
  }

  /** 在射线命中点播放 FX(地面/网格或空中默认点),按 compareMode 布阵。 */
  playAtRay(asset: FxAsset) {
    const dir = new THREE.Vector3();
    this.flyCam.camera.getWorldDirection(dir);
    this.raycaster.set(this.flyCam.camera.position, dir);
    this.raycaster.far = 20000;
    const hits = this.raycaster.intersectObject(this.ground, false);
    const hitGround = hits.length > 0;
    const base = hitGround ? hits[0].point : this.flyCam.camera.position.clone().addScaledVector(dir, 600);
    this.lastSpawnPos = base.clone();
    this.clearLegacyFx();
    const wantPreset = this.compareMode !== 'legacy';
    const wantLegacy = this.compareMode !== 'preset';
    if (wantPreset) {
      const p = wantLegacy ? base.clone().add(new THREE.Vector3(this.SIDE_GAP, 0, 0)) : base;
      // 地面序列帧与游戏同规则"踩地":抬到 quad 底边贴命中面(AB 对照公平)
      if (hitGround) p.y += sheetFootLift(asset, 1);
      this.playAt(asset, p); // playAt 内部会更新 lastSpawnPos(预设发射点)
    }
    if (wantLegacy) {
      const p = wantPreset ? base.clone().add(new THREE.Vector3(-this.SIDE_GAP, 0, 0)) : base;
      this.spawnLegacyAt(p);
    }
    // 重置连续发射累计(每个 FX 从头播)
    this.continuousAccum.clear();
    this.time = 0;
  }

  playAt(asset: FxAsset, pos: THREE.Vector3) {
    this.lastSpawnPos = pos.clone();
    this.system.play(asset, pos);
  }

  /** 清空当前视口全部特效(切换对比模式/资产时防残留混叠)。 */
  clearFx() {
    this.system.reset();
    this.clearLegacyFx();
    this.continuousAccum.clear();
  }

  /** 原生爆炸复刻(每播一次换新实例;避免堆积) */
  private spawnLegacyAt(pos: THREE.Vector3) {
    this.clearLegacyFx();
    this.lastLegacySpawn = pos.clone();
    this.legacyFx.push(new LegacyExplosion(this.scene, pos, this.legacyScale));
  }

  private clearLegacyFx() {
    for (const l of this.legacyFx) l.dispose();
    this.legacyFx.length = 0;
  }

  /** 时间轴 scrub:回退重放(burst 也重发射,60fps 步长快进)。 */
  scrubTo(t: number) {
    this.system.reset();
    this.continuousAccum.clear();
    this.time = 0;
    // 重发射 burst 发射器(序列帧/爆发预设 scrub 才有画面)+ 原生复刻重播
    if (this.compareMode !== 'legacy' && this.currentAsset && this.lastSpawnPos) {
      this.system.play(this.currentAsset, this.lastSpawnPos);
    }
    if (this.compareMode !== 'preset' && this.lastLegacySpawn) {
      this.clearLegacyFx();
      this.spawnLegacyAt(this.lastLegacySpawn.clone());
    }
    // 分 60fps 步长快进模拟(continuous 按 rate 逐帧产)
    const steps = Math.max(1, Math.round(t / (1 / 60)));
    const dt = t / steps;
    for (let i = 0; i < steps; i++) this.step(dt);
  }

  private step(dt: number) {
    const active = this.currentAsset;
    if (active) {
      for (const e of active.emitters) {
        if (e.type === 'sprite' && e.mode === 'continuous') {
          const acc = (this.continuousAccum.get(e.id) ?? 0) + dt * e.rate;
          let n = Math.floor(acc);
          this.continuousAccum.set(e.id, acc - n);
          while (n-- > 0) this.system.playEmitter(e, this.lastSpawnPos ?? new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
        }
      }
    }
    this.system.update(dt, this.flyCam.camera);
    // 原生爆炸复刻走同一时钟(与序列帧预设同步对比)
    for (let i = this.legacyFx.length - 1; i >= 0; i--) {
      this.legacyFx[i].step(dt);
      if (!this.legacyFx[i].alive) {
        this.legacyFx[i].dispose();
        this.legacyFx.splice(i, 1);
      }
    }
  }

  private lastSpawnPos: THREE.Vector3 | null = null;
  /** UI 在播放时设置上次发射点(continuous 粒子从那里持续产) */
  setSpawnPos(p: THREE.Vector3 | null) { this.lastSpawnPos = p; }

  currentAsset: FxAsset | null = null;

  /**
   * 预解码资产引用的全部序列帧图集(幂等)。视口预览/scrub 会在解码
   * 完成后自动生效;解码期间对应发射器暂时跳过,不会报错。
   */
  prepareAsset(asset: FxAsset | null): Promise<void> {
    if (!asset) return Promise.resolve();
    return this.system.prepareSheets([asset]).then(() => undefined);
  }

  render(dt: number) {
    if (this.disposed) return;
    this.flyCam.update(dt);
    if (!this.paused) {
      const dtScaled = dt * this.speed;
      this.time += dtScaled;
      if (this.loop && this.time >= this.loopDuration) this.time %= this.loopDuration;
      this.step(dtScaled);
    }
    this.composer.render();

    this.fpsAccum += dt;
    this.fpsFrames++;
    this.statsTimer += dt;
    if (this.statsTimer >= 0.5) {
      this.lastFps = this.fpsFrames / Math.max(0.001, this.fpsAccum);
      this.fpsAccum = 0; this.fpsFrames = 0; this.statsTimer = 0;
      this.opts.onStats?.({
        fps: this.lastFps,
        particles: this.system.activeParticles,
        time: this.time,
      });
    }
  }

  dispose() {
    this.disposed = true;
    this.system.dispose();
    this.clearLegacyFx();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
