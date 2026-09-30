// === Per user request: 给个真实贴图开关 + 地形/云/海岛可导入和开关 ===
// Satellite/real-texture storage for the heightmap terrain. The user can
// import any image (png/jpg/webp) and it will be mapped across the whole
// terrain mesh as a real satellite texture, replacing the procedural
// detail texture. A built-in default (`/textures/satellite-default.webp`)
// is also available so the user can try the feature without importing
// anything.
//
// Storage: IndexedDB "skybound_terrain" object store, key = "satellite",
// value = Blob. We use IndexedDB (not localStorage) because image files
// can exceed localStorage's ~5MB limit. Object URLs are cached in memory
// so the texture loads instantly on subsequent mission starts.
//
// The engine reads two localStorage flags at mission start:
//   skybound.realTerrainTexture  = 'on' | 'off'   (default 'off')
//   skybound.terrainSource       = 'builtin' | 'custom'  (default 'builtin')
// And loads the satellite texture (custom IndexedDB blob OR the built-in
// default) only when realTerrainTexture === 'on'.

const TERRAIN_TEX_DB_NAME = 'skybound_terrain';
const TERRAIN_TEX_STORE = 'textures';
const TERRAIN_TEX_KEY = 'satellite';
const TERRAIN_TEX_DB_VERSION = 1;

// localStorage flag keys
export const REAL_TERRAIN_TEX_KEY = 'skybound.realTerrainTexture';
export const TERRAIN_SOURCE_KEY = 'skybound.terrainSource';
// Visibility toggles for whole environment layers
export const TERRAIN_VISIBLE_KEY = 'skybound.terrainVisible';
export const ISLANDS_VISIBLE_KEY = 'skybound.islandsVisible';

let _terrainTexDbPromise: Promise<IDBDatabase> | null = null;
function getTerrainTexDb(): Promise<IDBDatabase> | null {
  if (typeof window === 'undefined' || !('indexedDB' in window)) return null;
  if (_terrainTexDbPromise) return _terrainTexDbPromise;
  _terrainTexDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(TERRAIN_TEX_DB_NAME, TERRAIN_TEX_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TERRAIN_TEX_STORE)) {
        db.createObjectStore(TERRAIN_TEX_STORE); // key = string, value = Blob
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _terrainTexDbPromise;
}

// In-memory cache of the Object URL so we don't recreate it every frame.
let _terrainTexUrlCache: string | null = null;

export async function setTerrainTextureFile(file: Blob): Promise<void> {
  const db = getTerrainTexDb();
  if (!db) return;
  try {
    const database = await db;
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(TERRAIN_TEX_STORE, 'readwrite');
      tx.objectStore(TERRAIN_TEX_STORE).put(file, TERRAIN_TEX_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    // Invalidate cache so next getTerrainTextureUrl reloads.
    if (_terrainTexUrlCache) {
      URL.revokeObjectURL(_terrainTexUrlCache);
      _terrainTexUrlCache = null;
    }
  } catch (e) {
    console.warn('[terrainTexture] failed to store satellite texture', e);
  }
}

export async function removeTerrainTextureFile(): Promise<void> {
  const db = getTerrainTexDb();
  if (!db) return;
  try {
    const database = await db;
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(TERRAIN_TEX_STORE, 'readwrite');
      tx.objectStore(TERRAIN_TEX_STORE).delete(TERRAIN_TEX_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    if (_terrainTexUrlCache) {
      URL.revokeObjectURL(_terrainTexUrlCache);
      _terrainTexUrlCache = null;
    }
  } catch (e) {
    console.warn('[terrainTexture] failed to remove satellite texture', e);
  }
}

export async function getTerrainTextureUrl(): Promise<string | null> {
  if (_terrainTexUrlCache) return _terrainTexUrlCache;
  const db = getTerrainTexDb();
  if (!db) return null;
  try {
    const database = await db;
    const blob = await new Promise<Blob | undefined>((resolve, reject) => {
      const tx = database.transaction(TERRAIN_TEX_STORE, 'readonly');
      const req = tx.objectStore(TERRAIN_TEX_STORE).get(TERRAIN_TEX_KEY);
      req.onsuccess = () => resolve(req.result as Blob | undefined);
      req.onerror = () => reject(req.error);
    });
    if (!blob) return null;
    _terrainTexUrlCache = URL.createObjectURL(blob);
    return _terrainTexUrlCache;
  } catch (e) {
    console.warn('[terrainTexture] failed to load satellite texture', e);
    return null;
  }
}

export async function hasTerrainTextureFile(): Promise<boolean> {
  const db = getTerrainTexDb();
  if (!db) return false;
  try {
    const database = await db;
    const count = await new Promise<number>((resolve, reject) => {
      const tx = database.transaction(TERRAIN_TEX_STORE, 'readonly');
      const req = tx.objectStore(TERRAIN_TEX_STORE).count(TERRAIN_TEX_KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return count > 0;
  } catch {
    return false;
  }
}

// === Flag getters/setters (localStorage-backed, read by the engine at
// mission start) ===

export function isRealTerrainTextureOn(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(REAL_TERRAIN_TEX_KEY) === 'on';
}
export function setRealTerrainTextureOn(on: boolean) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(REAL_TERRAIN_TEX_KEY, on ? 'on' : 'off');
}

export function getTerrainSource(): 'builtin' | 'custom' {
  if (typeof window === 'undefined') return 'builtin';
  return window.localStorage.getItem(TERRAIN_SOURCE_KEY) === 'custom' ? 'custom' : 'builtin';
}
export function setTerrainSource(src: 'builtin' | 'custom') {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(TERRAIN_SOURCE_KEY, src);
}

export function isTerrainVisible(): boolean {
  if (typeof window === 'undefined') return true;
  return window.localStorage.getItem(TERRAIN_VISIBLE_KEY) !== 'off';
}
export function setTerrainVisible(on: boolean) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(TERRAIN_VISIBLE_KEY, on ? 'on' : 'off');
}

export function isIslandsVisible(): boolean {
  if (typeof window === 'undefined') return true;
  return window.localStorage.getItem(ISLANDS_VISIBLE_KEY) !== 'off';
}
export function setIslandsVisible(on: boolean) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ISLANDS_VISIBLE_KEY, on ? 'on' : 'off');
}

// Path to the built-in default satellite texture (copied from the user's
// uploaded OIP-C.webp). The engine loads this via TextureLoader when the
// user picks 'builtin' as the terrain source.
export const BUILTIN_SATELLITE_TEXTURE_URL = '/textures/satellite-default.webp';
