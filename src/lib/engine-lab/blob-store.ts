/**
 * blob-store — IndexedDB-backed blob storage for large model files
 * =====================================================================
 * Aircraft model files (.glb / .gltf / .obj) are typically 2–30 MB,
 * which blows past the ~5–10 MB localStorage quota. We keep the small
 * stuff (preset metadata, downscale-2K texture data URLs) in localStorage
 * but offload the bulky model blobs to IndexedDB, which can store hundreds
 * of MB per origin.
 *
 * The preset's `modelDataUrl` field is repurposed: when a model is stored
 * in IndexedDB, the preset stores a sentinel like `idb://<key>` instead
 * of the full base64 data URL. On load, callers detect the sentinel and
 * fetch the blob from IndexedDB via this module.
 *
 * API:
 *   - putModelBlob(key, blob) → Promise<void>
 *   - getModelBlob(key) → Promise<Blob | null>
 *   - deleteModelBlob(key) → Promise<void>
 *   - makeModelKey(fileName) → string   // stable key from filename
 */

const DB_NAME = 'skybound-blobs';
const DB_VERSION = 1;
const STORE_MODELS = 'models';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_MODELS)) {
        db.createObjectStore(STORE_MODELS, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export interface StoredBlob {
  key: string;
  blob: Blob;
  fileName: string;
  createdAt: number;
}

export async function putModelBlob(key: string, blob: Blob, fileName: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_MODELS, 'readwrite');
    tx.objectStore(STORE_MODELS).put({ key, blob, fileName, createdAt: Date.now() } as StoredBlob);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getModelBlob(key: string): Promise<Blob | null> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_MODELS, 'readonly');
      const req = tx.objectStore(STORE_MODELS).get(key);
      req.onsuccess = () => {
        const rec = req.result as StoredBlob | undefined;
        resolve(rec?.blob ?? null);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function deleteModelBlob(key: string): Promise<void> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_MODELS, 'readwrite');
      tx.objectStore(STORE_MODELS).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {}
}

/** Sentinel scheme: preset.modelDataUrl = `idb://<key>` means fetch from IndexedDB. */
export const IDB_SCHEME = 'idb://';

export function makeModelKey(aircraftModel: string, presetId: string, fileName: string): string {
  // Sanitize fileName to a safe key component
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${aircraftModel}/${presetId}/${safe}`;
}

export function isIdbRef(dataUrl: string | undefined): boolean {
  return !!dataUrl && dataUrl.startsWith(IDB_SCHEME);
}

export function idbRefToKey(dataUrl: string): string {
  return dataUrl.slice(IDB_SCHEME.length);
}

export function keyToIdbRef(key: string): string {
  return IDB_SCHEME + key;
}
