/**
 * preset-applier — apply an AircraftPreset to a Three.js Group
 * =====================================================================
 * Takes the preset's stored data-URL textures + per-part overrides and
 * builds/refreshes PBR materials on every mesh in the group.
 *
 * This is shared between:
 *   - HangarLab live preview
 *   - GameEngine.buildPlayer() at mission start (uses the aircraft's
 *     active game preset, replacing the old procedural-material code path)
 */

import * as THREE from 'three';
import type { AircraftPreset, TextureChannel } from './aircraft-presets';
import { buildPBRMaterial, loadTextureFromPath } from './pbr-material';
import { classifyMeshPart, type BodyPart } from './texture-classifier';

interface LoadedTextures {
  map?: THREE.Texture;
  normalMap?: THREE.Texture;
  roughnessMap?: THREE.Texture;
  metalnessMap?: THREE.Texture;
  aoMap?: THREE.Texture;
  emissiveMap?: THREE.Texture;
}

const CHANNEL_TO_MAT_KEY: Record<TextureChannel, keyof LoadedTextures> = {
  albedo: 'map',
  normal: 'normalMap',
  roughness: 'roughnessMap',
  metallic: 'metalnessMap',
  ao: 'aoMap',
  emissive: 'emissiveMap',
  height: 'normalMap', // we don't use height in MeshStandardMaterial, route to normal as no-op
};

const CHANNEL_SRGB: Record<TextureChannel, boolean> = {
  albedo: true, normal: false, roughness: false, metallic: false,
  ao: false, emissive: true, height: false,
};

/** Cache data-URL → THREE.Texture to avoid reloading when re-applying. */
const textureCache = new Map<string, THREE.Texture>();

async function getTexture(dataUrl: string, srgb: boolean): Promise<THREE.Texture> {
  const cacheKey = `${dataUrl.slice(0, 64)}|${srgb ? 's' : 'l'}`;
  const cached = textureCache.get(cacheKey);
  if (cached) return cached;
  const tex = await loadTextureFromPath(dataUrl, srgb);
  textureCache.set(cacheKey, tex);
  return tex;
}

async function loadChannelMap(
  textures: Partial<Record<TextureChannel, string>>,
): Promise<LoadedTextures> {
  const out: LoadedTextures = {};
  await Promise.all(
    (Object.keys(textures) as TextureChannel[]).map(async (ch) => {
      const url = textures[ch];
      if (!url) return;
      const matKey = CHANNEL_TO_MAT_KEY[ch];
      // Don't overwrite normalMap if we already loaded one from the proper normal channel
      if (matKey === 'normalMap' && ch === 'height' && out.normalMap) return;
      try {
        out[matKey] = await getTexture(url, CHANNEL_SRGB[ch]);
      } catch (e) {
        console.warn(`[preset-applier] Failed to load ${ch} texture:`, e);
      }
    }),
  );
  return out;
}

/**
 * Apply a preset's materials to a Three.js group.
 *   - Replaces every mesh's material with a fresh PBR material
 *   - Routes per-part overrides by mesh.name (using classifyMeshPart)
 *   - Enables castShadow + receiveShadow for self-shadowing
 *   - Returns a disposer for cleanup
 */
export async function applyPresetToGroup(
  group: THREE.Object3D,
  preset: AircraftPreset,
): Promise<() => void> {
  // Load global textures once
  const globalTex = await loadChannelMap(preset.textures);

  // Load per-part textures
  const partTexCache: Record<string, LoadedTextures> = {};
  await Promise.all(
    Object.entries(preset.partOverrides).map(async ([partName, override]) => {
      if (override.textures && Object.keys(override.textures).length > 0) {
        partTexCache[partName] = await loadChannelMap(override.textures);
      }
    }),
  );

  const disposables: { dispose: () => void }[] = [];

  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;

    // Classify the mesh into a body part
    const part = classifyMeshPart(mesh.name || '');
    // Determine which override applies: prefer exact-name match, fallback to part-class match, fallback to global
    let tex = globalTex;
    let params = preset.params;
    let matchedOverrideKey: string | null = null;
    if (preset.partOverrides[mesh.name]) {
      matchedOverrideKey = mesh.name;
    } else {
      // Find an override whose key classifies to the same part
      for (const [key, ov] of Object.entries(preset.partOverrides)) {
        if (classifyMeshPart(key) === part) {
          matchedOverrideKey = key;
          break;
        }
      }
    }
    if (matchedOverrideKey) {
      const ov = preset.partOverrides[matchedOverrideKey];
      if (partTexCache[matchedOverrideKey]) tex = partTexCache[matchedOverrideKey];
      if (ov.params) params = { ...params, ...ov.params };
    }

    // Dispose old material
    if (Array.isArray(mesh.material)) {
      mesh.material.forEach(m => m.dispose());
    } else if (mesh.material) {
      mesh.material.dispose();
    }

    const mat = buildPBRMaterial(tex, params);
    mesh.material = mat;
    disposables.push(mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });

  // Return disposer
  return () => {
    disposables.forEach(d => d.dispose());
  };
}

/** Clear the texture cache (call on engine dispose). */
export function clearPresetTextureCache(): void {
  for (const tex of textureCache.values()) {
    tex.dispose();
  }
  textureCache.clear();
}
