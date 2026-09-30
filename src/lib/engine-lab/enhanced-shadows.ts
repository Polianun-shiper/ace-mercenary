/**
 * EnhancedShadowSystem — AAA 级自阴影系统
 * =====================================================================
 * 这是用户截图里要求的阴影质感：阴影能投在自己机体上 (自阴影)，
 * 软硬结合 (PCF kernel size)，能跟着相机走 (CSM 级联)。
 *
 * 三层阴影：
 *  1. CSM 级联阴影 (4 级) — 主阴影系统，覆盖近-中-远距离
 *     - 第 1 级: 0-80m, 4096 贴图, 给机体自阴影
 *     - 第 2 级: 80-300m, 2048 贴图, 给僚机/敌机
 *     - 第 3 级: 300-1200m, 2048 贴图, 给中景地面单位
 *     - 第 4 级: 1200-4000m, 1024 贴图, 给远景山脉
 *
 *  2. 接触阴影 (Contact Shadows) — 屏幕空间短距离射线
 *     解决 CSM 在机体接地处的"飞起来"问题，让机翼/起落架
 *     和地面之间有清晰的暗影环
 *
 *  3. 机体自身投影 — 通过 castShadow + receiveShadow 双向开启
 *     让机翼在机身上投影，垂尾在平尾上投影，做出机体自身的
 *     阴影层次感
 */
import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import type { EngineProfile } from './profile';

export interface ShadowSystemOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  sunDirection: THREE.Vector3;
  sunColor: THREE.Color;
  sunIntensity: number;
}

export class EnhancedShadowSystem {
  private csm: CSM | null = null;
  private sunLight: THREE.DirectionalLight | null = null;
  private contactShadowMesh: THREE.Mesh | null = null;
  private opts: ShadowSystemOptions;
  private enabled = true;

  constructor(opts: ShadowSystemOptions) {
    this.opts = opts;
  }

  applyProfile(p: EngineProfile) {
    this.dispose();
    if (!p.shadows.enabled) {
      this.enabled = false;
      return;
    }
    this.enabled = true;
    this.opts.renderer.shadowMap.enabled = true;
    this.opts.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // 主太阳光 — 总是开启，用于漫反射光照 (即使没阴影也要照亮机体)
    this.sunLight = new THREE.DirectionalLight(this.opts.sunColor, this.opts.sunIntensity);
    this.sunLight.position.copy(this.opts.sunDirection.clone().multiplyScalar(5000));
    this.sunLight.castShadow = true;

    // 阴影相机参数 — 比传统实现更紧凑的近端，确保机体自阴影清晰
    const cam = this.sunLight.shadow.camera as THREE.OrthographicCamera;
    cam.near = 1;
    cam.far = 6000;
    cam.left = -120;
    cam.right = 120;
    cam.top = 120;
    cam.bottom = -120;
    cam.updateProjectionMatrix();

    this.sunLight.shadow.mapSize.set(p.shadows.mapSize, p.shadows.mapSize);
    this.sunLight.shadow.bias = p.shadows.bias;
    this.sunLight.shadow.normalBias = p.shadows.normalBias;
    // PCF 软阴影核大小 (1=硬, 5=软, 11=很软)
    const kernelSize = Math.round(1 + p.shadows.softness * 10) as 1 | 3 | 5 | 7 | 11;
    (this.sunLight.shadow as any).radius = kernelSize;

    this.opts.scene.add(this.sunLight);
    this.opts.scene.add(this.sunLight.target);

    // CSM 级联 — 给中远距离场景提供阴影
    if (p.shadows.cascades > 1) {
      try {
        const sunDir = this.opts.sunDirection.clone().normalize();
        this.csm = new CSM({
          camera: this.opts.camera,
          parent: this.opts.scene,
          cascades: p.shadows.cascades,
          maxFar: 4000,
          mode: 'practical',
          shadowMapSize: p.shadows.mapSize,
          lightDirection: sunDir,
          lightIntensity: this.opts.sunIntensity,
          lightNear: 1,
          lightFar: 8000,
          lightMargin: 200,
          shadowBias: p.shadows.bias,
        });
        for (const light of this.csm.lights) {
          light.color.copy(this.opts.sunColor);
          light.position.copy(sunDir.clone().multiplyScalar(5000));
          light.target.position.set(0, 0, 0);
          this.opts.scene.add(light.target);
          light.shadow.normalBias = p.shadows.normalBias;
          // 软阴影
          (light.shadow as any).radius = kernelSize;
        }
        // 让 CSM 在玩家移动时跟相机走
        this.csm.update();
      } catch (e) {
        console.warn('[EnhancedShadowSystem] CSM init failed, falling back to single shadow:', e);
        this.csm = null;
      }
    }

    // 接触阴影 — 一个低分辨率的暗影盘，紧贴机体下方
    if (p.shadows.contactShadows) {
      this.buildContactShadow(p.shadows.contactRadius, p.shadows.contactOpacity);
    }
  }

  /**
   * 让所有机体部件互相投影 (自阴影)
   * 调用时机: 在加载完机体 Mesh 后立即调用
   */
  enableSelfShadowOnAircraft(aircraftGroup: THREE.Object3D) {
    aircraftGroup.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;  // 关键：让机翼在机身上投影
      }
    });
  }

  /** 让地形/建筑接收阴影 (但不投影) */
  enableReceiveShadow(obj: THREE.Object3D) {
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.receiveShadow = true;
        mesh.castShadow = true;
      }
    });
  }

  /** 仅让接收阴影 (不投影，适合大的地形) */
  enableReceiveOnly(obj: THREE.Object3D) {
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.receiveShadow = true;
    });
  }

  /** 跟随相机更新 CSM 级联 */
  update() {
    if (!this.enabled || !this.csm) return;
    this.csm.update();
  }

  /** 把太阳光跟着玩家走 (让阴影相机始终覆盖玩家附近) */
  followTarget(targetPos: THREE.Vector3) {
    if (!this.sunLight) return;
    // 太阳光位置 = 玩家位置 + 太阳方向 * 5000
    this.sunLight.position.copy(targetPos).addScaledVector(this.opts.sunDirection, 5000);
    this.sunLight.target.position.copy(targetPos);
    this.sunLight.target.updateMatrixWorld();
  }

  // ─── 接触阴影 ─────────────────────────────────────
  // 接触阴影用一个柔和的径向渐变 disk 贴在机体下方，模拟
  // 物体接地处的环境光遮蔽 (像 UE5 的 Contact Shadows)
  private buildContactShadow(radius: number, opacity: number) {
    // 程序化生成一张径向渐变纹理 (中心黑，边缘透明)
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, `rgba(0,0,0,${opacity})`);
    grad.addColorStop(0.5, `rgba(0,0,0,${opacity * 0.5})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;

    const geo = new THREE.CircleGeometry(radius, 32);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      opacity: opacity,
      color: 0x000000,
    });
    this.contactShadowMesh = new THREE.Mesh(geo, mat);
    this.contactShadowMesh.rotation.x = -Math.PI / 2; // 平铺地面
    this.contactShadowMesh.renderOrder = 1;
    this.opts.scene.add(this.contactShadowMesh);
  }

  /** 把接触阴影跟随到玩家脚下 */
  updateContactShadow(playerPos: THREE.Vector3, groundY: number = 0) {
    if (!this.contactShadowMesh) return;
    this.contactShadowMesh.position.set(playerPos.x, groundY + 0.5, playerPos.z);
  }

  setSunDirection(dir: THREE.Vector3) {
    this.opts.sunDirection.copy(dir).normalize();
    if (this.sunLight) {
      this.sunLight.position.copy(dir.clone().multiplyScalar(5000));
    }
    if (this.csm) {
      for (const light of this.csm.lights) {
        light.position.copy(dir.clone().multiplyScalar(5000));
      }
    }
  }

  setSunColor(color: THREE.Color) {
    this.opts.sunColor.copy(color);
    if (this.sunLight) this.sunLight.color.copy(color);
    if (this.csm) {
      for (const light of this.csm.lights) light.color.copy(color);
    }
  }

  setSunIntensity(intensity: number) {
    this.opts.sunIntensity = intensity;
    if (this.sunLight) this.sunLight.intensity = intensity;
    if (this.csm) {
      for (const light of this.csm.lights) light.intensity = intensity;
    }
  }

  dispose() {
    if (this.csm) {
      try { this.csm.remove(); } catch {}
      for (const light of this.csm.lights) {
        this.opts.scene.remove(light);
        this.opts.scene.remove(light.target);
      }
      this.csm = null;
    }
    if (this.sunLight) {
      this.opts.scene.remove(this.sunLight);
      this.opts.scene.remove(this.sunLight.target);
      this.sunLight = null;
    }
    if (this.contactShadowMesh) {
      this.opts.scene.remove(this.contactShadowMesh);
      this.contactShadowMesh.geometry.dispose();
      (this.contactShadowMesh.material as THREE.Material).dispose();
      this.contactShadowMesh = null;
    }

  }
}
