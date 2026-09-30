/**
 * AircraftPresets — per-aircraft PBR material / texture preset registry
 * =====================================================================
 * The Engine Lab's "Experimental Hangar" lets the user manage a library of
 * material + texture presets, one per AircraftModel (f16, f15, su35, …).
 *
 * Lifecycle:
 *   1. Each AircraftModel starts with a BUILT-IN default preset that mirrors
 *      the procedural geometry & MeshStandardMaterial colors already used by
 *      the game (so out-of-the-box behavior is unchanged).
 *   2. In the Engine Lab the user can ADD a new preset for any aircraft.
 *      They pick a .glb/.gltf/.obj model file, batch-import any number of
 *      texture images, and the system AUTO-DETECTS each texture's channel
 *      (albedo / normal / roughness / metallic / ao / emissive / height) by
 *      filename + pixel-feature analysis.
 *   3. If the auto-assignment is wrong, the user can manually drag/reassign
 *      any texture to any channel slot — for the whole aircraft or for a
 *      specific named mesh part (fuselage / wing / canopy / exhaust …).
 *   4. The user saves the preset (name + params), and marks ONE preset per
 *      aircraft as the "GAME-ACTIVE" preset — that's the one the engine
 *      loads when a mission starts.
 *
 * Storage: localStorage 'skybound.hangarLab.presets.v2'
 *   The structure is keyed by aircraftModel → presetId[] → preset object.
 *   Textures are stored as data URLs (base64). For typical PBR sets
 *   (~5 textures × 2MB each) we stay comfortably under the 8MB localStorage
 *   budget. If a user imports a massive 8K texture we resize-compress it on
 *   save to 2K — keeps localStorage from blowing up.
 */

import type { AircraftModel } from '@/lib/game/types';
import { DEFAULT_PBR_PARAMS, type PBRMaterialParams } from './pbr-material';

// === Texture channel enum & metadata =========================================

export type TextureChannel =
  | 'albedo'
  | 'normal'
  | 'roughness'
  | 'metallic'
  | 'ao'
  | 'emissive'
  | 'height';

export const TEXTURE_CHANNELS: { key: TextureChannel; label: string; hint: string; srgb: boolean }[] = [
  { key: 'albedo',    label: 'Albedo (基础色)',    hint: '必需',         srgb: true  },
  { key: 'normal',    label: 'Normal (法线)',       hint: '凹凸细节',     srgb: false },
  { key: 'roughness', label: 'Roughness (粗糙度)', hint: '光滑/哑光',    srgb: false },
  { key: 'metallic',  label: 'Metallic (金属度)',  hint: '金属反射',     srgb: false },
  { key: 'ao',        label: 'AO (环境遮蔽)',       hint: '缝隙暗影',     srgb: false },
  { key: 'emissive',  label: 'Emissive (自发光)',  hint: '发光部位',     srgb: true  },
  { key: 'height',    label: 'Height (高度)',       hint: '视差',         srgb: false },
];

// === Preset model ============================================================

export interface AircraftPreset {
  /** uuid-style id */
  id: string;
  /** which aircraft this preset is for */
  aircraftModel: AircraftModel;
  /** user-facing name e.g. "F-16 Camo Desert" */
  name: string;
  /** built-in presets ship with the game and cannot be deleted */
  isBuiltin: boolean;
  /** is this preset the one used when the player flies this aircraft? */
  isGameActive: boolean;

  /**
   * Model source — 'builtin' = procedural geometry that ships with the game,
   * 'file' = a user-imported .glb/.gltf/.obj file. We store the file as a
   * data URL too (so the game can rehydrate it on mission start without
   * needing the user to re-import).
   */
  modelSource: 'builtin' | 'file';
  modelFileName?: string;
  modelDataUrl?: string; // only when modelSource === 'file'

  /**
   * Global texture slots — applied to every mesh in the model.
   * Values are data URLs (base64 PNG/JPEG/WebP).
   */
  textures: Partial<Record<TextureChannel, string>>;

  /** Global PBR params — applied to every mesh unless overridden per-part. */
  params: PBRMaterialParams;

  /**
   * Per-part overrides — keyed by mesh.name (e.g. "fuselage", "canopy",
   * "exhaust"). If the imported GLB has named meshes, the user can assign
   * different textures / params to each part. Auto-assignment uses mesh
   * name heuristics to suggest a slot.
   */
  partOverrides: Record<string, {
    textures?: Partial<Record<TextureChannel, string>>;
    params?: Partial<PBRMaterialParams>;
  }>;

  createdAt: number;
  updatedAt: number;
}

// === Built-in default presets ===============================================

/**
 * Default per-aircraft colors mirror the procedural-geometry colors already
 * used in models.ts / aircraft-catalog.ts so the "no preset chosen" state
 * is visually identical to the pre-Lab game.
 */
const DEFAULT_COLOR_BY_MODEL: Record<AircraftModel, { color: number; metalness: number; roughness: number; emissive?: number; emissiveIntensity?: number }> = {
  f16:   { color: 0x808a96, metalness: 0.65, roughness: 0.4 },
  // F-16C 真实模型 (per user request: 完全替换原 F-16) — 玩家默认机
  f16c:  { color: 0x808a96, metalness: 0.65, roughness: 0.4 },
  'f16-test': { color: 0x7a90a8, metalness: 0.65, roughness: 0.4 },
  f15:   { color: 0x884444, metalness: 0.6,  roughness: 0.45 },
  su35:  { color: 0x556070, metalness: 0.6,  roughness: 0.45 },
  a10:   { color: 0x4a4a3a, metalness: 0.4,  roughness: 0.6 },
  b52:   { color: 0x6b6b66, metalness: 0.4,  roughness: 0.55 },
  ea18g: { color: 0x445060, metalness: 0.6,  roughness: 0.45 },
  ac130: { color: 0x4a4133, metalness: 0.4,  roughness: 0.6 },
  f117:  { color: 0x1a1d24, metalness: 0.85, roughness: 0.35 },
  e3:    { color: 0x5a6068, metalness: 0.5,  roughness: 0.5 },
  tu95:  { color: 0x6b6b66, metalness: 0.4,  roughness: 0.55 },
  mig29: { color: 0x8a8f96, metalness: 0.65, roughness: 0.4 },
};

const AIRCRAFT_DISPLAY_NAMES: Record<AircraftModel, string> = {
  f16:   'F-16C VIPER',
  f16c:  'F-16C BLOCK 50',
  'f16-test': 'F-16X TESTBED',
  f15:   'F-15 EAGLE',
  su35:  'Su-35 FLANKER',
  a10:   'A-10 WARTHOG',
  b52:   'B-52H STRATO',
  ea18g: 'EA-18G GROWLER',
  ac130: 'AC-130 SPECTRE',
  f117:  'F-117 NIGHTHAWK',
  e3:    'E-3 SENTRY',
  tu95:  'Tu-95 BEAR',
  mig29: 'MiG-29 FULCRUM',
};

export function aircraftDisplayName(model: AircraftModel): string {
  return AIRCRAFT_DISPLAY_NAMES[model] ?? model.toUpperCase();
}

/** Build a fresh built-in preset for an aircraft. */
export function buildBuiltinPreset(aircraftModel: AircraftModel): AircraftPreset {
  const cfg = DEFAULT_COLOR_BY_MODEL[aircraftModel] ?? DEFAULT_COLOR_BY_MODEL.f16;
  return {
    id: `builtin-${aircraftModel}`,
    aircraftModel,
    name: `${AIRCRAFT_DISPLAY_NAMES[aircraftModel]} — 默认`,
    isBuiltin: true,
    isGameActive: false, // will be set true for ONE preset per aircraft at load time
    modelSource: 'builtin',
    textures: {},
    params: {
      ...DEFAULT_PBR_PARAMS,
      color: cfg.color,
      metallic: cfg.metalness,
      roughness: cfg.roughness,
      emissive: cfg.emissive ?? 0x000000,
      emissiveIntensity: cfg.emissiveIntensity ?? 0,
    },
    partOverrides: {},
    createdAt: 0,
    updatedAt: 0,
  };
}

// === Storage =================================================================

const STORAGE_KEY = 'skybound.hangarLab.presets.v2';

interface StorageShape {
  /** aircraftModel → presetId[] (order preserved) */
  order: Partial<Record<AircraftModel, string[]>>;
  /** presetId → preset */
  presets: Record<string, AircraftPreset>;
}

function loadStorage(): StorageShape {
  if (typeof window === 'undefined') return { order: {}, presets: {} };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { order: {}, presets: {} };
    const parsed = JSON.parse(raw) as StorageShape;
    if (!parsed.order || !parsed.presets) return { order: {}, presets: {} };
    return parsed;
  } catch {
    return { order: {}, presets: {} };
  }
}

function saveStorage(s: StorageShape) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch (e) {
    // Most likely QuotaExceededError — textures too large. We surface this
    // to the caller; the UI will tell the user to compress their textures.
    console.warn('[AircraftPresets] save failed:', e);
    throw e;
  }
}

/**
 * Ensure every AircraftModel has its built-in preset, and exactly one
 * is marked isGameActive per model. Returns the freshly-normalized storage.
 */
function normalizeStorage(): StorageShape {
  const s = loadStorage();
  const allModels: AircraftModel[] = ['f16','f15','su35','a10','b52','ea18g','ac130','f117','e3','tu95'];

  for (const m of allModels) {
    if (!s.order[m]) s.order[m] = [];
    const ids = s.order[m] as string[];
    // Ensure built-in preset exists at index 0
    const builtinId = `builtin-${m}`;
    if (!ids.includes(builtinId)) ids.unshift(builtinId);
    if (!s.presets[builtinId]) {
      s.presets[builtinId] = buildBuiltinPreset(m);
    } else {
      // Refresh display name in case we updated it
      s.presets[builtinId].name = `${AIRCRAFT_DISPLAY_NAMES[m]} — 默认`;
    }
    // Ensure exactly one isGameActive per aircraft
    const presets = ids.map(id => s.presets[id]).filter(Boolean) as AircraftPreset[];
    const activeCount = presets.filter(p => p.isGameActive).length;
    if (activeCount === 0) {
      // Default to built-in being active
      s.presets[builtinId].isGameActive = true;
    } else if (activeCount > 1) {
      // Keep only the first active
      let seen = false;
      for (const p of presets) {
        if (p.isGameActive) {
          if (seen) p.isGameActive = false;
          seen = true;
        }
      }
    }
  }

  saveStorage(s);
  return s;
}

/** List all presets for a given aircraft, in display order. */
export function listPresetsFor(aircraftModel: AircraftModel): AircraftPreset[] {
  const s = normalizeStorage();
  const ids = (s.order[aircraftModel] ?? []) as string[];
  return ids.map(id => s.presets[id]).filter(Boolean) as AircraftPreset[];
}

/** Get the currently-active game preset for an aircraft. */
export function getActivePreset(aircraftModel: AircraftModel): AircraftPreset {
  const s = normalizeStorage();
  const ids = (s.order[aircraftModel] ?? []) as string[];
  for (const id of ids) {
    const p = s.presets[id];
    if (p && p.isGameActive) return p;
  }
  // Fallback to built-in
  return s.presets[`builtin-${aircraftModel}`] ?? buildBuiltinPreset(aircraftModel);
}

/** Add or update a preset (upsert by id). */
export function upsertPreset(preset: AircraftPreset): void {
  const s = normalizeStorage();
  s.presets[preset.id] = preset;
  const ids = (s.order[preset.aircraftModel] ?? []) as string[];
  if (!ids.includes(preset.id)) ids.push(preset.id);
  s.order[preset.aircraftModel] = ids;
  saveStorage(s);
}

/** Delete a preset. Built-in presets are protected. */
export function deletePreset(presetId: string): void {
  const s = normalizeStorage();
  const p = s.presets[presetId];
  if (!p) return;
  if (p.isBuiltin) return; // cannot delete built-in
  // If we're deleting the active preset, fall back to built-in
  const wasActive = p.isGameActive;
  delete s.presets[presetId];
  const ids = (s.order[p.aircraftModel] ?? []) as string[];
  s.order[p.aircraftModel] = ids.filter(id => id !== presetId);
  if (wasActive) {
    s.presets[`builtin-${p.aircraftModel}`].isGameActive = true;
  }
  saveStorage(s);
}

/** Mark a preset as the one used in the actual game (per-aircraft). */
export function setGameActivePreset(aircraftModel: AircraftModel, presetId: string): void {
  const s = normalizeStorage();
  const ids = (s.order[aircraftModel] ?? []) as string[];
  for (const id of ids) {
    const p = s.presets[id];
    if (!p) continue;
    p.isGameActive = (id === presetId);
  }
  saveStorage(s);
}

/** Create a new blank preset for an aircraft. Returns the new preset. */
export function createNewPreset(
  aircraftModel: AircraftModel,
  name: string,
  modelSource: 'builtin' | 'file' = 'builtin',
): AircraftPreset {
  const cfg = DEFAULT_COLOR_BY_MODEL[aircraftModel] ?? DEFAULT_COLOR_BY_MODEL.f16;
  const now = Date.now();
  const id = `preset-${now}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    aircraftModel,
    name: name || `${AIRCRAFT_DISPLAY_NAMES[aircraftModel]} — 自定义`,
    isBuiltin: false,
    isGameActive: false,
    modelSource,
    textures: {},
    params: {
      ...DEFAULT_PBR_PARAMS,
      color: cfg.color,
      metallic: cfg.metalness,
      roughness: cfg.roughness,
    },
    partOverrides: {},
    createdAt: now,
    updatedAt: now,
  };
}

// === Image → data-URL helpers ===============================================

/**
 * Read a File as a data URL (base64). Optionally downscale very large
 * images to keep localStorage within budget.
 */
export function fileToDataUrl(file: File, maxDim = 2048): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // If file is small enough or is a JPEG already, just return as-is
      if (file.size < 1_500_000) {
        resolve(dataUrl);
        return;
      }
      // Downscale via canvas
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth, h = img.naturalHeight;
        const scale = Math.min(1, maxDim / Math.max(w, h));
        if (scale >= 1) {
          resolve(dataUrl);
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(w * scale);
        canvas.height = Math.floor(h * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(dataUrl); return; }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        // Try WebP first (smaller); fallback to PNG
        const webp = canvas.toDataURL('image/webp', 0.92);
        if (webp && webp.length < dataUrl.length) resolve(webp);
        else resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Generate a small thumbnail data URL for a texture (for UI preview).
 * 96×96, JPEG, low-quality — small enough to keep many in memory.
 */
export function makeThumbnail(dataUrl: string, size = 96): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(dataUrl); return; }
      // cover-fit
      const w = img.naturalWidth, h = img.naturalHeight;
      const scale = Math.max(size / w, size / h);
      const dw = w * scale, dh = h * scale;
      ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
      resolve(canvas.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => resolve('');
    img.src = dataUrl;
  });
}
