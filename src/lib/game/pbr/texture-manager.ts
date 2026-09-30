// === 纹理管理器 (per user request: 纹理性能优化 + 显存高效调用) ===
// Owns texture quality, anisotropy, VRAM accounting and (later) KTX2
// compressed-texture streaming. Game code talks to PBR materials through
// the factory in materials.ts; this manager keeps the settings + budgets.
//
// KTX2 strategy:
//   - Real artist textures placed in textures-src/ are encoded at build time
//     (scripts/ktx2-export.mjs) into public/textures/ktx2/<id>/…
//   - In single-file builds the asset manifest (window.__ASSET_MANIFEST) is
//     queried to know which KTX2 sets exist; the KTX2Loader transcoder files
//     (/basis/*) are remapped to data URIs there too.
//   - Sets without KTX2 assets fall back to the procedural canvas sets.
//   - If the browser can't transcode (no WebAssembly / WebGL2) it falls back
//     automatically — KTX2 is an acceleration, never a requirement.

import * as THREE from 'three';
import { textureVRAM, clearAllTextureSets } from './texture-sets';

export type TextureQuality = 'low' | 'medium' | 'high';

export const TEXTURE_QUALITY_KEYS: TextureQuality[] = ['low', 'medium', 'high'];

// Per-quality settings: anisotropy + max generated texture size tier.
const QUALITY_CFG: Record<TextureQuality, { anisotropy: number; tier: number }> = {
  low: { anisotropy: 4, tier: 0 },
  medium: { anisotropy: 8, tier: 1 },
  high: { anisotropy: 16, tier: 2 },
};

export class TextureManager {
  private quality: TextureQuality = 'high';
  // Registered textures for VRAM accounting (weak refs are fine — dispose
  // removes them; we only report, never prevent GC).
  private tracked = new Set<THREE.Texture>();
  // === KTX2 + Basis Universal (per user request: 贴图/显存压缩) ===
  // Lazy KTX2Loader (dynamic import — only fetched when KTX2 sets exist).
  private ktx2: Promise<any> | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  // Loaded KTX2 sets, shared by every material of the same setId (dedup —
  // previously every material re-fetched all 6 files).
  private ktx2Sets = new Map<string, { textures: THREE.Texture[] }>();

  /** Read quality from localStorage (cached; call refresh() after settings change). */
  constructor() {
    this.refresh();
  }

  /** 移动性能模式: 由引擎在构造时注入(skybound.mobileMode 或触摸设备自动判定)。 */
  private mobileMode = false;

  /** 引擎设置移动模式。移动端强制 low 档 —— 这是显存占用最大的一块。 */
  setMobileMode(on: boolean): void {
    this.mobileMode = on;
    this.refresh();
  }

  refresh() {
    try {
      const v = localStorage.getItem('skybound.textureQuality');
      // 移动模式强制 low(256²/128² 程序化贴图集), 压过用户的桌面档设置。
      this.quality = this.mobileMode
        ? 'low'
        : (TEXTURE_QUALITY_KEYS.includes(v as TextureQuality) ? v : 'high') as TextureQuality;
    } catch {
      this.quality = 'high';
    }
  }

  get qualitySetting(): TextureQuality {
    return this.quality;
  }

  get anisotropy(): number {
    return QUALITY_CFG[this.quality].anisotropy;
  }

  /** Track a texture for VRAM reporting. */
  track(t: THREE.Texture): THREE.Texture {
    this.tracked.add(t);
    t.anisotropy = Math.max(t.anisotropy, this.anisotropy);
    return t;
  }

  untrack(t: THREE.Texture) {
    this.tracked.delete(t);
  }

  /** Release ALL tracked textures + cached sets (mission/hangar teardown). */
  clearAll() {
    for (const t of this.tracked) t.dispose();
    this.tracked.clear();
    // KTX2 sets are per-mission too — drop them so the next mission
    // re-fetches fresh compressed textures.
    this.ktx2Sets.clear();
    clearAllTextureSets();
  }

  /** Rough VRAM footprint of every tracked texture (bytes). */
  totalVRAM(): number {
    let sum = 0;
    for (const t of this.tracked) sum += textureVRAM(t);
    return sum;
  }

  /** One-line memory report for the debug console (`memory` command). */
  reportMemory(): string {
    const mb = (b: number) => (b / 1024 / 1024).toFixed(1) + ' MB';
    return [
      `textures tracked: ${this.tracked.size}`,
      `estimated texture VRAM: ${mb(this.totalVRAM())}`,
      `quality: ${this.quality} (aniso ${this.anisotropy})`,
    ].join('\n');
  }

  /** True when a KTX2 texture set exists for the id (build-generated assets). */
  ktx2SetAvailable(id: string): boolean {
    try {
      // Injected by build-single-html.mjs (both dev + single-file builds).
      const manifest = (window as unknown as { __KTX2_MANIFEST?: string[] }).__KTX2_MANIFEST;
      if (manifest) return manifest.includes(id);
      // Dev fallback: probe the single-file asset manifest keys.
      const am = (window as unknown as { __ASSET_MANIFEST?: Record<string, string> }).__ASSET_MANIFEST;
      if (am) return Object.keys(am).some((k) => k.startsWith(`/textures/ktx2/${id}/`));
      return false;
    } catch {
      return false;
    }
  }

  /** Give the manager a renderer so KTX2Loader can run detectSupport(). */
  attachRenderer(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
  }

  /**
   * Lazy shared KTX2Loader (single instance — multiple loaders would each
   * fetch the transcoder + allocate worker pools). Public so terrain layer
   * sheets (terrain-mwam.ts) can load KTX2 textures directly; returns null
   * when the loader failed to initialise.
   */
  getKtx2Loader(): Promise<any> {
    if (!this.ktx2) {
      this.ktx2 = (async () => {
        const { KTX2Loader } = await import('three/examples/jsm/loaders/KTX2Loader.js');
        const loader = new KTX2Loader();
        // Single-file builds inline /basis/* + KTX2 assets as data URIs in
        // __ASSET_MANIFEST — remap every URL through it so the transcoder
        // fetches work fully offline.
        const manifest = (window as unknown as { __ASSET_MANIFEST?: Record<string, string> }).__ASSET_MANIFEST;
        if (manifest) {
          const manager = new THREE.LoadingManager();
          manager.setURLModifier((url) => manifest[url.replace(window.location.origin, '')] ?? url);
          loader.manager = manager;
        }
        loader.setTranscoderPath('/basis/');
        if (this.renderer) loader.detectSupport(this.renderer);
        return loader;
      })().catch((err) => {
        console.warn('[pbr] KTX2Loader init failed:', err);
        this.ktx2 = null;
        return null;
      });
    }
    return this.ktx2;
  }

  /**
   * Swap a material's maps for the KTX2 (Basis-compressed) versions of its
   * texture set, if the build generated them. Fire-and-forget: while the
   * async load is in flight the procedural canvas set is already rendering.
   * The loaded set is cached per setId and SHARED by every material — the
   * procedural set is deliberately NOT disposed here (it lives in the shared
   * aircraftCache and other materials still reference it; clearAll() frees
   * everything at mission end).
   * Returns true if the upgrade was kicked off (or already applied).
   */
  async requestKtx2Upgrade(mat: THREE.MeshStandardMaterial, setId: string): Promise<boolean> {
    try {
      if (!this.ktx2SetAvailable(setId)) return false;
      if (mat.userData.ktx2) return true;
      // Dedup: a set already in flight/loaded is shared, not re-fetched.
      const cached = this.ktx2Sets.get(setId);
      if (cached) {
        this.applyKtx2Textures(mat, cached.textures);
        return true;
      }
      const loader = await this.getKtx2Loader();
      if (!loader) return false;
      if (mat.userData.ktx2 || this.ktx2Sets.has(setId)) {
        const again = this.ktx2Sets.get(setId);
        if (again) this.applyKtx2Textures(mat, again.textures);
        return true; // raced — another request won
      }
      const base = `/textures/ktx2/${setId}`;
      const textures = await Promise.all([
        loader.loadAsync(`${base}/albedo.ktx2`),
        loader.loadAsync(`${base}/normal.ktx2`),
        loader.loadAsync(`${base}/metallic.ktx2`),
        loader.loadAsync(`${base}/roughness.ktx2`),
        loader.loadAsync(`${base}/ao.ktx2`),
        loader.loadAsync(`${base}/emissive.ktx2`),
      ]);
      // Another request may have finished while we were loading.
      if (this.ktx2Sets.has(setId)) {
        const won = this.ktx2Sets.get(setId)!;
        this.applyKtx2Textures(mat, won.textures);
        return true;
      }
      textures[0].colorSpace = THREE.SRGBColorSpace;
      textures[5].colorSpace = THREE.SRGBColorSpace;
      for (const t of textures) {
        t.anisotropy = Math.max(t.anisotropy, this.anisotropy);
        this.track(t);
      }
      this.ktx2Sets.set(setId, { textures });
      this.applyKtx2Textures(mat, textures);
      return true;
    } catch (err) {
      console.warn(`[pbr] KTX2 upgrade failed for ${setId}:`, err);
      return false;
    }
  }

  private applyKtx2Textures(mat: THREE.MeshStandardMaterial, textures: THREE.Texture[]) {
    if (mat.userData.ktx2 || !mat.map) return; // already swapped / material disposed
    mat.map = textures[0];
    mat.normalMap = textures[1];
    // 走 ORM 单槽的材质**不**再被这三槽覆盖(否则采样器又回到 6):
    // KTX2 只升级 albedo/normal(有 emissive 才升), ORM 保持过程式那张。
    if (!mat.userData.ormSingle) {
      mat.metalnessMap = textures[2];
      mat.roughnessMap = textures[3];
      mat.aoMap = textures[4];
    }
    if (mat.emissiveMap) mat.emissiveMap = textures[5];
    mat.needsUpdate = true;
    mat.userData.ktx2 = true;
  }
}

/** Global singleton — the game has exactly one renderer/texture pipeline. */
let _manager: TextureManager | null = null;
export function getTextureManager(): TextureManager {
  if (!_manager) _manager = new TextureManager();
  return _manager;
}
