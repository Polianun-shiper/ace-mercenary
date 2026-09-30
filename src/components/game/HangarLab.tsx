'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import * as THREE from 'three';
import {
  type AircraftPreset,
  type TextureChannel,
  listPresetsFor,
  upsertPreset,
  deletePreset,
  setGameActivePreset,
  createNewPreset,
  getActivePreset,
  aircraftDisplayName,
  fileToDataUrl,
  TEXTURE_CHANNELS,
} from '@/lib/engine-lab/aircraft-presets';
import {
  classifyTexture,
  classifyMeshPart,
  PART_LABELS,
  type BodyPart,
} from '@/lib/engine-lab/texture-classifier';
import { loadModelFromFile, disposeGroup, DEFAULT_PBR_PARAMS, type PBRMaterialParams } from '@/lib/engine-lab/pbr-material';
import { applyPresetToGroup } from '@/lib/engine-lab/preset-applier';
import {
  putModelBlob,
  getModelBlob,
  deleteModelBlob,
  makeModelKey,
  keyToIdbRef,
  isIdbRef,
  idbRefToKey,
} from '@/lib/engine-lab/blob-store';
import type { AircraftModel } from '@/lib/game/types';
import { PLAYER_AIRCRAFT } from '@/lib/game/aircraft-catalog';

interface Props {
  onClose: () => void;
  /** 把当前预设应用回 Engine Lab 预览机体 */
  onApplyToFighter: (group: THREE.Group) => void;
}

const ALL_MODELS: AircraftModel[] = ['f16','f15','su35','a10','b52','ea18g','ac130','f117','e3','tu95'];

// === Imported texture entry (before being slotted into a channel) ============
interface ImportedTexture {
  id: string;
  fileName: string;
  dataUrl: string;
  thumbnail: string;
  detectedChannel: TextureChannel;
  confidence: number;
  features: any;
  userOverride?: TextureChannel; // user manually re-assigned
}

// === Per-part material override entry =======================================
interface PartOverrideEntry {
  partKey: string;       // either mesh.name or a body-part label
  partLabel: string;
  textures: Partial<Record<TextureChannel, string>>;
  params: Partial<PBRMaterialParams>;
}

export function HangarLab({ onClose, onApplyToFighter }: Props) {
  // === Aircraft selection ===
  const [selectedModel, setSelectedModel] = useState<AircraftModel>('f16');
  const [presets, setPresets] = useState<AircraftPreset[]>(() => listPresetsFor('f16'));
  const [selectedPresetId, setSelectedPresetId] = useState<string>(() => getActivePreset('f16').id);
  const activePreset = useMemo(() => presets.find(p => p.id === selectedPresetId) ?? presets[0], [presets, selectedPresetId]);

  // Refresh preset list when model changes
  useEffect(() => {
    const list = listPresetsFor(selectedModel);
    setPresets(list);
    const active = getActivePreset(selectedModel);
    setSelectedPresetId(active.id);
    // Persist last-edited aircraft so Engine Lab's Test Flight button knows
    // which aircraft to default to.
    try {
      window.localStorage.setItem('skybound.hangarLab.lastModel', selectedModel);
    } catch {}
  }, [selectedModel]);

  // === 3D preview ===
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const modelGroupRef = useRef<THREE.Group | null>(null);
  const orbitRef = useRef({ theta: 0.7, phi: 0.35, r: 18, auto: true });

  const [loadingModel, setLoadingModel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // === Texture import panel state ===
  const [importedTextures, setImportedTextures] = useState<ImportedTexture[]>([]);
  const [channelAssignments, setChannelAssignments] = useState<Record<TextureChannel, ImportedTexture | null>>({
    albedo: null, normal: null, roughness: null, metallic: null,
    ao: null, emissive: null, height: null,
  });
  const [showPerPartEditor, setShowPerPartEditor] = useState(false);
  const [partOverrides, setPartOverrides] = useState<PartOverrideEntry[]>([]);
  const [detectedParts, setDetectedParts] = useState<{ name: string; part: BodyPart }[]>([]);

  // === Preview renderer init ===
  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a14);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
    cameraRef.current = camera;

    // Lighting rig — neutral sky + sun
    const hemi = new THREE.HemisphereLight(0xb8c8ff, 0x40301a, 0.6);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff0d8, 1.8);
    sun.position.set(8, 14, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -15;
    sun.shadow.camera.right = 15;
    sun.shadow.camera.top = 15;
    sun.shadow.camera.bottom = -15;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 50;
    sun.shadow.bias = -0.0001;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);

    // Subtle floor for shadow reference
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x1a1d2a,
      roughness: 0.85,
      metalness: 0.0,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -5;
    floor.receiveShadow = true;
    scene.add(floor);

    // Camera orbit loop
    let rafId = 0;
    let lastT = performance.now();
    const loop = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastT) / 1000);
      lastT = now;
      if (orbitRef.current.auto && modelGroupRef.current) {
        orbitRef.current.theta += dt * 0.25;
      }
      const { theta, phi, r } = orbitRef.current;
      camera.position.set(
        Math.cos(theta) * Math.cos(phi) * r,
        Math.sin(phi) * r + 2,
        Math.sin(theta) * Math.cos(phi) * r,
      );
      camera.lookAt(0, 0, 0);
      if (modelGroupRef.current) modelGroupRef.current.rotation.y += dt * 0.15;
      renderer.render(scene, camera);
      rafId = requestAnimationFrame(loop);
    };
    loop();

    const onResize = () => {
      if (!canvas.parentElement) return;
      const w = canvas.parentElement.clientWidth;
      const h = canvas.parentElement.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    onResize();
    window.addEventListener('resize', onResize);
    let cancelled = false;
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      try { renderer.dispose(); } catch (e) { console.warn('[HangarLab] renderer.dispose error:', e); }
      // Null out refs so the model/preset useEffect can no-op after unmount.
      sceneRef.current = null;
      rendererRef.current = null;
      cameraRef.current = null;
      modelGroupRef.current = null;
    };
  }, []);

  // === When selected model/preset changes, rebuild preview ===
  useEffect(() => {
    if (!sceneRef.current || !activePreset) return;
    // Remove old model group
    if (modelGroupRef.current) {
      try {
        sceneRef.current.remove(modelGroupRef.current);
        disposeGroup(modelGroupRef.current);
      } catch (e) { console.warn('[HangarLab] old group dispose error:', e); }
      modelGroupRef.current = null;
    }
    let cancelled = false;
    setLoadingModel(true);
    (async () => {
      try {
        let group: THREE.Group;
        if (activePreset.modelSource === 'file' && activePreset.modelDataUrl) {
          if (isIdbRef(activePreset.modelDataUrl)) {
            // New path: fetch blob from IndexedDB
            const key = idbRefToKey(activePreset.modelDataUrl);
            const blob = await getModelBlob(key);
            if (!blob) {
              throw new Error(`模型文件未找到 (IndexedDB key: ${key})。可能已被清除，请重新导入模型。`);
            }
            const file = new File([blob], activePreset.modelFileName ?? 'model.glb', { type: blob.type || 'application/octet-stream' });
            group = await loadModelFromFile(file, rendererRef.current ?? undefined);
          } else {
            // Legacy path: model stored as data URL in localStorage (older presets)
            const blob = await (await fetch(activePreset.modelDataUrl)).blob();
            const file = new File([blob], activePreset.modelFileName ?? 'model.glb', { type: blob.type });
            group = await loadModelFromFile(file, rendererRef.current ?? undefined);
          }
        } else {
          // Use procedural built-in geometry
          group = buildProceduralPreviewAircraft(activePreset.aircraftModel);
        }
        if (cancelled || !sceneRef.current) {
          // Component unmounted during async load — dispose the group.
          try { disposeGroup(group); } catch {}
          return;
        }
        // Center & scale
        const box = new THREE.Box3().setFromObject(group);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 0.001);
        const scale = 8 / maxDim;
        group.position.sub(center.multiplyScalar(scale));
        group.scale.setScalar(scale);

        // Collect detected part names from imported model
        const parts: { name: string; part: BodyPart }[] = [];
        group.traverse(o => {
          const m = o as THREE.Mesh;
          if (m.isMesh && m.name) {
            parts.push({ name: m.name, part: classifyMeshPart(m.name) });
          }
        });
        setDetectedParts(parts);

        // Apply preset materials
        await applyPresetToGroup(group, activePreset);

        if (cancelled || !sceneRef.current) {
          try { disposeGroup(group); } catch {}
          return;
        }
        sceneRef.current.add(group);
        modelGroupRef.current = group;
        setError(null);
      } catch (e: any) {
        if (!cancelled) setError(`预览加载失败: ${e.message ?? e}`);
      } finally {
        if (!cancelled) setLoadingModel(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedModel, selectedPresetId]);

  // === Multi-texture batch import ===
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const modelFileInputRef = useRef<HTMLInputElement | null>(null);

  const handleBatchImport = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    setInfo(`正在分析 ${files.length} 张贴图...`);
    const newEntries: ImportedTexture[] = [];
    const newAssignments = { ...channelAssignments };
    for (const file of Array.from(files)) {
      try {
        const dataUrl = await fileToDataUrl(file);
        // Build thumbnail inline
        const thumb = await makeThumb(dataUrl);
        const cls = await classifyTexture(file.name, dataUrl);
        const entry: ImportedTexture = {
          id: `tex-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
          fileName: file.name,
          dataUrl,
          thumbnail: thumb,
          detectedChannel: cls.best,
          confidence: cls.confidence,
          features: cls.features,
        };
        newEntries.push(entry);
        // Auto-assign to channel if not already taken AND confidence > 0.3
        if (cls.confidence > 0.3 && !newAssignments[cls.best]) {
          newAssignments[cls.best] = entry;
        }
      } catch (e: any) {
        console.warn(`Failed to import ${file.name}:`, e);
      }
    }
    setImportedTextures(prev => [...prev, ...newEntries]);
    setChannelAssignments(newAssignments);
    setInfo(`已导入 ${newEntries.length} 张贴图，自动分配 ${Object.values(newAssignments).filter(Boolean).length} 个槽位。请检查自动分配是否正确。`);
  };

  // === Re-assign texture to channel (manual override) ===
  const assignToChannel = (channel: TextureChannel, tex: ImportedTexture | null) => {
    setChannelAssignments(prev => {
      const next = { ...prev };
      // Remove this texture from any other channel it was assigned to
      if (tex) {
        (Object.keys(next) as TextureChannel[]).forEach(k => {
          if (next[k]?.id === tex.id) next[k] = null;
        });
      }
      next[channel] = tex;
      return next;
    });
  };

  // === Import model file (overrides built-in geometry) ===
  // Model blobs go into IndexedDB (not localStorage) because they can be
  // tens of MB. The preset stores an `idb://<key>` sentinel in modelDataUrl.
  const handleModelImport = async (file: File | null) => {
    if (!file || !activePreset) return;
    setLoadingModel(true);
    setError(null);
    try {
      // Sanity check: file extension
      const ext = file.name.split('.').pop()?.toLowerCase();
      if (!ext || !['glb', 'gltf', 'obj'].includes(ext)) {
        setError(`不支持的模型格式: .${ext ?? '(无)'}。支持 .glb / .gltf / .obj`);
        return;
      }
      // Sanity check: file size — warn over 50 MB
      if (file.size > 50 * 1024 * 1024) {
        if (!window.confirm(`模型文件 ${(file.size/1024/1024).toFixed(1)} MB 较大，可能影响加载速度。继续？`)) return;
      }
      // Store the blob in IndexedDB
      const key = makeModelKey(selectedModel, activePreset.id, file.name);
      await putModelBlob(key, file, file.name);
      // Save into the active preset's modelSource/dataUrl (sentinel only)
      const updated: AircraftPreset = {
        ...activePreset,
        modelSource: 'file',
        modelFileName: file.name,
        modelDataUrl: keyToIdbRef(key),
        updatedAt: Date.now(),
      };
      upsertPreset(updated);
      setPresets(listPresetsFor(selectedModel));
      setInfo(`模型 ${file.name} 已导入到预设「${activePreset.name}」 (${(file.size/1024/1024).toFixed(2)} MB)`);
    } catch (e: any) {
      console.error('[HangarLab] Model import failed:', e);
      setError(`模型导入失败: ${e.message ?? e}`);
    } finally {
      setLoadingModel(false);
    }
  };

  // === Save current panel state into the active preset ===
  const savePresetChanges = useCallback(() => {
    if (!activePreset) return;
    // Convert channelAssignments to data URLs
    const textures: Partial<Record<TextureChannel, string>> = {};
    (Object.keys(channelAssignments) as TextureChannel[]).forEach(ch => {
      const t = channelAssignments[ch];
      if (t) textures[ch] = t.dataUrl;
    });
    // Convert partOverrides to preset format
    const partOverridesData: AircraftPreset['partOverrides'] = {};
    for (const entry of partOverrides) {
      partOverridesData[entry.partKey] = {
        textures: entry.textures,
        params: entry.params,
      };
    }
    const updated: AircraftPreset = {
      ...activePreset,
      textures,
      partOverrides: partOverridesData,
      updatedAt: Date.now(),
    };
    try {
      upsertPreset(updated);
      setPresets(listPresetsFor(selectedModel));
      setInfo(`预设「${activePreset.name}」已保存。`);
    } catch (e: any) {
      setError(`保存失败 (可能是 localStorage 容量超限): ${e.message ?? e}`);
    }
  }, [activePreset, channelAssignments, partOverrides, selectedModel]);

  // === Create new preset ===
  const handleCreatePreset = () => {
    const name = window.prompt('新预设名称：', `${aircraftDisplayName(selectedModel)} — 自定义`);
    if (!name) return;
    const p = createNewPreset(selectedModel, name, 'builtin');
    upsertPreset(p);
    setPresets(listPresetsFor(selectedModel));
    setSelectedPresetId(p.id);
    setImportedTextures([]);
    setChannelAssignments({ albedo: null, normal: null, roughness: null, metallic: null, ao: null, emissive: null, height: null });
    setPartOverrides([]);
  };

  // === Delete preset (built-in protected) ===
  const handleDeletePreset = (id: string) => {
    const p = presets.find(x => x.id === id);
    if (!p || p.isBuiltin) return;
    if (!window.confirm(`删除预设「${p.name}」？`)) return;
    // Clean up IndexedDB blob if present
    if (p.modelSource === 'file' && p.modelDataUrl && isIdbRef(p.modelDataUrl)) {
      deleteModelBlob(idbRefToKey(p.modelDataUrl)).catch(() => {});
    }
    deletePreset(id);
    setPresets(listPresetsFor(selectedModel));
    if (selectedPresetId === id) {
      const active = getActivePreset(selectedModel);
      setSelectedPresetId(active.id);
    }
  };

  // === Reset this aircraft to builtin defaults (delete ALL custom presets
  // for this aircraft, switch active preset back to the built-in one) ===
  const handleResetAircraft = () => {
    if (!window.confirm(`重置 ${aircraftDisplayName(selectedModel)} 的所有自定义涂装预设？\n（内置预设保留，自定义预设将被删除，导入的模型文件也会一并清除）`)) return;
    const all = presets.filter(p => !p.isBuiltin);
    for (const p of all) {
      // Delete model blob from IndexedDB if present
      if (p.modelSource === 'file' && p.modelDataUrl && isIdbRef(p.modelDataUrl)) {
        deleteModelBlob(idbRefToKey(p.modelDataUrl)).catch(() => {});
      }
      deletePreset(p.id);
    }
    // Re-activate the builtin preset for this aircraft
    const fresh = listPresetsFor(selectedModel);
    const builtin = fresh.find(p => p.isBuiltin) ?? fresh[0];
    if (builtin) {
      setGameActivePreset(selectedModel, builtin.id);
      setSelectedPresetId(builtin.id);
    }
    setPresets(fresh);
    setImportedTextures([]);
    setChannelAssignments({ albedo: null, normal: null, roughness: null, metallic: null, ao: null, emissive: null, height: null });
    setPartOverrides([]);
    setInfo(`${aircraftDisplayName(selectedModel)} 已重置为内置默认涂装。`);
  };

  // === Mark as game-active preset ===
  const handleSetActive = (id: string) => {
    setGameActivePreset(selectedModel, id);
    setPresets(listPresetsFor(selectedModel));
    setInfo(`已设为 ${aircraftDisplayName(selectedModel)} 的游戏内机体预设。下次任务启动时生效。`);
  };

  // === Apply to Engine Lab preview fighter ===
  const handleApplyToFighter = () => {
    if (!modelGroupRef.current) return;
    onApplyToFighter(modelGroupRef.current);
    onClose();
  };

  // === When preset switches, sync UI state from preset's stored textures ===
  useEffect(() => {
    if (!activePreset) return;
    // Reconstruct importedTextures from preset.textures (so user sees what's stored)
    const stored: ImportedTexture[] = [];
    const assign: Record<TextureChannel, ImportedTexture | null> = {
      albedo: null, normal: null, roughness: null, metallic: null,
      ao: null, emissive: null, height: null,
    };
    (Object.keys(activePreset.textures) as TextureChannel[]).forEach(ch => {
      const url = activePreset.textures[ch];
      if (url) {
        const entry: ImportedTexture = {
          id: `stored-${ch}-${activePreset.id}`,
          fileName: `(saved) ${ch}.png`,
          dataUrl: url,
          thumbnail: url,
          detectedChannel: ch,
          confidence: 1.0,
          features: {},
        };
        stored.push(entry);
        assign[ch] = entry;
      }
    });
    setImportedTextures(stored);
    setChannelAssignments(assign);
    // Reconstruct part overrides
    const po: PartOverrideEntry[] = Object.entries(activePreset.partOverrides).map(([key, ov]) => ({
      partKey: key,
      partLabel: PART_LABELS[classifyMeshPart(key)] ?? key,
      textures: ov.textures ?? {},
      params: ov.params ?? {},
    }));
    setPartOverrides(po);
  }, [selectedPresetId]);

  // === Mouse orbit ===
  const onMouseDown = (e: React.MouseEvent) => {
    const sx = e.clientX, sy = e.clientY;
    const sTheta = orbitRef.current.theta;
    const sPhi = orbitRef.current.phi;
    orbitRef.current.auto = false;
    const onMove = (ev: MouseEvent) => {
      orbitRef.current.theta = sTheta - (ev.clientX - sx) * 0.008;
      orbitRef.current.phi = Math.max(0.05, Math.min(Math.PI/2 - 0.05, sPhi + (ev.clientY - sy) * 0.008));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const onWheel = (e: React.WheelEvent) => {
    orbitRef.current.r = Math.max(8, Math.min(40, orbitRef.current.r + e.deltaY * 0.02));
  };

  // ========================================================================
  // RENDER
  // ========================================================================
  return (
    <div className="absolute inset-0 z-50 bg-black/95 flex font-mono text-white">
      {/* === LEFT: Aircraft picker + Preset list === */}
      <div className="w-[280px] h-full border-r border-purple-400/30 bg-gradient-to-b from-purple-950/30 to-black overflow-y-auto">
        <div className="px-4 py-3 border-b border-purple-400/30 flex items-center justify-between sticky top-0 bg-black/80 backdrop-blur z-10">
          <div>
            <h2 className="text-sm text-purple-200 tracking-widest">◆ 机体涂装 / 模型预设</h2>
            <div className="text-[9px] text-cyan-200/50 mt-0.5 tracking-wider">按机型管理贴图与模型 · 与画质预设互相独立</div>
          </div>
          <button onClick={onClose} className="text-xs text-cyan-300/70 hover:text-cyan-100">关闭 ✕</button>
        </div>

        {/* Aircraft picker */}
        <div className="px-3 py-3 border-b border-purple-400/20">
          <div className="text-[10px] text-cyan-200/60 tracking-widest mb-2">机型 (按游戏机库)</div>
          <div className="grid grid-cols-2 gap-1">
            {ALL_MODELS.map(m => {
              const playerSpec = PLAYER_AIRCRAFT.find(s => s.model === m);
              return (
                <button
                  key={m}
                  onClick={() => setSelectedModel(m)}
                  className={`px-2 py-1.5 text-[10px] tracking-wider border text-left ${
                    selectedModel === m
                      ? 'border-amber-400 bg-amber-400/15 text-amber-100'
                      : 'border-purple-400/20 text-purple-200/70 hover:bg-purple-400/10'
                  }`}
                >
                  <div className="font-bold">{m.toUpperCase()}</div>
                  <div className="text-[8px] opacity-60 truncate">{playerSpec?.name.split(' ').slice(0,2).join(' ')}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Preset list */}
        <div className="px-3 py-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] text-cyan-200/60 tracking-widest">{aircraftDisplayName(selectedModel)} 的涂装预设</div>
            <div className="flex gap-1">
              <button
                onClick={handleResetAircraft}
                className="text-[10px] px-2 py-0.5 border border-amber-400/40 text-amber-200 hover:bg-amber-400/10"
                title="删除该机型的所有自定义预设，恢复内置默认涂装"
              >重置</button>
              <button
                onClick={handleCreatePreset}
                className="text-[10px] px-2 py-0.5 border border-emerald-400/40 text-emerald-300 hover:bg-emerald-400/10"
              >+ 新增</button>
            </div>
          </div>
          <div className="space-y-1">
            {presets.map(p => (
              <div
                key={p.id}
                className={`border ${
                  selectedPresetId === p.id
                    ? 'border-amber-400/60 bg-amber-400/5'
                    : 'border-purple-400/20 hover:bg-purple-400/5'
                }`}
              >
                <button
                  onClick={() => setSelectedPresetId(p.id)}
                  className="w-full px-2 py-1.5 text-left flex items-center justify-between"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-white/90 truncate flex items-center gap-1">
                      {p.isBuiltin && <span className="text-[9px] text-purple-300/70">⌂</span>}
                      {p.name}
                    </div>
                    <div className="text-[9px] text-cyan-200/40">
                      {p.modelSource === 'builtin' ? '内置几何' : `📁 ${p.modelFileName ?? '导入模型'}`}
                      {Object.keys(p.textures).length > 0 && ` · ${Object.keys(p.textures).length}贴图`}
                    </div>
                  </div>
                  {p.isGameActive && (
                    <span className="text-[9px] px-1 py-0.5 border border-[#9dffb0]/50 text-[#9dffb0]">★ GAME</span>
                  )}
                </button>
                <div className="flex gap-1 px-2 py-1 border-t border-purple-400/10">
                  <button
                    onClick={() => handleSetActive(p.id)}
                    disabled={p.isGameActive}
                    className="flex-1 text-[9px] py-0.5 border border-[#9dffb0]/40 text-[#9dffb0]/80 hover:bg-[#9dffb0]/10 disabled:opacity-30"
                  >
                    {p.isGameActive ? '✓ 使用中' : '设为游戏机体'}
                  </button>
                  {!p.isBuiltin && (
                    <button
                      onClick={() => handleDeletePreset(p.id)}
                      className="px-1.5 text-[9px] py-0.5 border border-red-400/30 text-red-300/70 hover:bg-red-400/10"
                    >删</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* === MIDDLE: Texture import + per-part editor === */}
      <div className="w-[420px] h-full border-r border-cyan-400/30 bg-black/50 overflow-y-auto">
        {activePreset && (
          <>
            <div className="px-4 py-3 border-b border-cyan-400/30 sticky top-0 bg-black/80 backdrop-blur z-10">
              <div className="text-sm text-amber-200 tracking-widest">{activePreset.name}</div>
              <div className="text-[10px] text-cyan-200/60 mt-0.5">
                {aircraftDisplayName(selectedModel)} ·
                {activePreset.isBuiltin ? ' 内置预设' : ' 自定义预设'} ·
                {activePreset.modelSource === 'builtin' ? ' 程序化几何' : ` ${activePreset.modelFileName}`}
              </div>
            </div>

            <div className="px-4 py-4 space-y-5">
              {/* Step 1: Model import (optional) */}
              <section>
                <h3 className="text-xs text-purple-200/80 tracking-widest mb-2">① 机体模型 (可选)</h3>
                <input
                  ref={modelFileInputRef}
                  type="file"
                  accept=".glb,.gltf,.obj"
                  onChange={e => handleModelImport(e.target.files?.[0] ?? null)}
                  className="hidden"
                />
                <button
                  onClick={() => modelFileInputRef.current?.click()}
                  className="w-full py-2 border border-purple-400/50 text-purple-200 hover:bg-purple-400/10 text-xs tracking-wider"
                >
                  {activePreset.modelSource === 'file'
                    ? `✓ ${activePreset.modelFileName} (点击替换)`
                    : '+ 导入 .glb / .gltf / .obj 模型 (留空则使用程序化几何)'}
                </button>
                {activePreset.modelSource === 'file' && detectedParts.length > 0 && (
                  <div className="mt-2 text-[10px] text-cyan-200/60">
                    检测到 {detectedParts.length} 个命名网格：
                    <div className="flex flex-wrap gap-1 mt-1">
                      {detectedParts.slice(0, 8).map(p => (
                        <span key={p.name} className="px-1.5 py-0.5 border border-cyan-400/20 text-cyan-200/70 text-[9px]">
                          {p.name} → {PART_LABELS[p.part]}
                        </span>
                      ))}
                      {detectedParts.length > 8 && <span className="text-cyan-200/40">+{detectedParts.length-8}个</span>}
                    </div>
                  </div>
                )}
              </section>

              {/* Step 2: Batch texture import */}
              <section>
                <h3 className="text-xs text-purple-200/80 tracking-widest mb-2">② 批量导入贴图 (自动识别通道)</h3>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  onChange={e => handleBatchImport(e.target.files)}
                  className="hidden"
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full py-2 border border-amber-400/50 text-amber-200 hover:bg-amber-400/10 text-xs tracking-wider"
                >
                  + 选择多张贴图 (Ctrl/Shift 多选)
                </button>
                <div className="text-[10px] text-cyan-200/40 mt-1">
                  系统会按文件名 + 像素特征自动识别 albedo / normal / roughness / metallic / ao / emissive / height
                </div>

                {importedTextures.length > 0 && (
                  <div className="mt-2 space-y-1 max-h-48 overflow-y-auto">
                    {importedTextures.map(t => (
                      <div key={t.id} className="flex items-center gap-2 border border-cyan-400/20 px-2 py-1">
                        <img src={t.thumbnail} alt="" className="w-10 h-10 object-cover" />
                        <div className="flex-1 min-w-0">
                          <div className="text-[10px] text-white/90 truncate">{t.fileName}</div>
                          <div className="text-[9px] text-cyan-200/50">
                            自动识别: <span className="text-amber-200">{t.detectedChannel}</span>
                            {t.confidence > 0 && ` (${(t.confidence*100).toFixed(0)}%)`}
                          </div>
                        </div>
                        <select
                          value={channelAssignments.albedo?.id === t.id ? 'albedo'
                            : channelAssignments.normal?.id === t.id ? 'normal'
                            : channelAssignments.roughness?.id === t.id ? 'roughness'
                            : channelAssignments.metallic?.id === t.id ? 'metallic'
                            : channelAssignments.ao?.id === t.id ? 'ao'
                            : channelAssignments.emissive?.id === t.id ? 'emissive'
                            : channelAssignments.height?.id === t.id ? 'height'
                            : 'none'}
                          onChange={e => {
                            const ch = e.target.value;
                            if (ch === 'none') assignToChannel('albedo', null); // removes if assigned
                            else assignToChannel(ch as TextureChannel, t);
                          }}
                          className="bg-black/60 border border-cyan-400/30 text-[10px] text-cyan-200 px-1 py-0.5"
                        >
                          <option value="none">未分配</option>
                          {TEXTURE_CHANNELS.map(c => (
                            <option key={c.key} value={c.key}>{c.label.split(' ')[0]}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Step 3: Channel slots overview */}
              <section>
                <h3 className="text-xs text-purple-200/80 tracking-widest mb-2">③ 通道分配 (可手动调整)</h3>
                <div className="space-y-1">
                  {TEXTURE_CHANNELS.map(c => {
                    const t = channelAssignments[c.key];
                    return (
                      <div key={c.key} className="flex items-center gap-2 border border-cyan-400/15 px-2 py-1">
                        <div className="w-16 text-[10px] text-cyan-200/70">{c.label.split(' ')[0]}</div>
                        {t ? (
                          <>
                            <img src={t.thumbnail} alt="" className="w-8 h-8 object-cover" />
                            <div className="flex-1 min-w-0 text-[10px] text-white/80 truncate">{t.fileName}</div>
                            <button
                              onClick={() => assignToChannel(c.key, null)}
                              className="px-1.5 text-[9px] border border-red-400/30 text-red-300/70 hover:bg-red-400/10"
                            >×</button>
                          </>
                        ) : (
                          <div className="flex-1 text-[10px] text-cyan-200/30 italic">空</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* Step 4: PBR params */}
              <section>
                <h3 className="text-xs text-purple-200/80 tracking-widest mb-2">④ PBR 材质参数</h3>
                <PBRParamsEditor
                  params={activePreset.params}
                  onChange={(newParams) => {
                    const updated = { ...activePreset, params: newParams, updatedAt: Date.now() };
                    upsertPreset(updated);
                    setPresets(listPresetsFor(selectedModel));
                  }}
                />
              </section>

              {/* Step 5: Per-part overrides */}
              <section>
                <button
                  onClick={() => setShowPerPartEditor(v => !v)}
                  className="w-full text-left text-xs text-purple-200/80 tracking-widest mb-2 flex items-center justify-between"
                >
                  <span>⑤ 分部位材质覆盖 (高级)</span>
                  <span>{showPerPartEditor ? '▼' : '▶'}</span>
                </button>
                {showPerPartEditor && (
                  <div className="space-y-2 border border-purple-400/20 p-2">
                    <div className="text-[10px] text-cyan-200/50">
                      如果导入的 GLB 模型有命名网格（如 wing_L / canopy / exhaust），可以为不同部位分配不同贴图或参数。
                      检测到的网格会自动按名称归类。
                    </div>
                    {detectedParts.length === 0 && (
                      <div className="text-[10px] text-cyan-200/40 italic">
                        当前模型无命名网格，或使用程序化几何。导入带命名网格的 GLB 后此处会列出。
                      </div>
                    )}
                    {detectedParts.map(dp => {
                      const ov = partOverrides.find(e => e.partKey === dp.name);
                      return (
                        <PartOverrideRow
                          key={dp.name}
                          meshName={dp.name}
                          partLabel={PART_LABELS[dp.part]}
                          override={ov}
                          availableTextures={importedTextures}
                          onChange={(newOv) => {
                            setPartOverrides(prev => {
                              const idx = prev.findIndex(e => e.partKey === dp.name);
                              if (newOv === null) {
                                if (idx >= 0) prev.splice(idx, 1);
                                return [...prev];
                              }
                              if (idx >= 0) prev[idx] = newOv;
                              else prev.push(newOv);
                              return [...prev];
                            });
                          }}
                        />
                      );
                    })}
                  </div>
                )}
              </section>

              {/* Errors & info */}
              {error && (
                <div className="px-3 py-2 border border-red-400/50 bg-red-400/10 text-red-200 text-xs">{error}</div>
              )}
              {info && (
                <div className="px-3 py-2 border border-emerald-400/40 bg-emerald-400/5 text-emerald-200 text-xs">{info}</div>
              )}

              {/* Save & Apply */}
              <section className="space-y-2 pb-4">
                <button
                  onClick={savePresetChanges}
                  className="w-full py-2.5 text-sm border-2 border-amber-400/70 hover:border-amber-400 text-amber-200 hover:bg-amber-400/10 tracking-widest font-bold"
                >
                  💾 保存到当前预设
                </button>
                <button
                  onClick={handleApplyToFighter}
                  disabled={!modelGroupRef.current}
                  className="w-full py-2 text-xs border border-[#9dffb0]/50 text-[#9dffb0] hover:bg-[#9dffb0]/10 tracking-widest disabled:opacity-30"
                >
                  ▶ 应用到引擎实验室预览机体
                </button>
              </section>
            </div>
          </>
        )}
      </div>

      {/* === RIGHT: 3D preview === */}
      <div className="flex-1 relative" onMouseDown={onMouseDown} onWheel={onWheel}>
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
        <div className="absolute top-3 left-3 text-[10px] text-cyan-200/60 tracking-widest pointer-events-none">
          {aircraftDisplayName(selectedModel)} · {activePreset?.name}
        </div>
        {loadingModel && (
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-amber-200 text-sm tracking-widest animate-pulse">
            加载中...
          </div>
        )}
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-[10px] text-cyan-200/40 tracking-widest pointer-events-none">
          鼠标拖动旋转 · 滚轮缩放
        </div>
      </div>
    </div>
  );
}

// === Sub-components =========================================================

function PBRParamsEditor({ params, onChange }: { params: PBRMaterialParams; onChange: (p: PBRMaterialParams) => void }) {
  const update = (key: keyof PBRMaterialParams, value: any) => {
    onChange({ ...params, [key]: value });
  };
  const Slider = ({ label, value, min, max, step, onC, fmt }: any) => (
    <div className="mb-2">
      <div className="flex justify-between text-[10px] mb-0.5">
        <label className="text-cyan-200/70">{label}</label>
        <span className="text-amber-200/90 font-mono">{fmt ? fmt(value) : value.toFixed(2)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onC(parseFloat(e.target.value))}
        className="w-full h-1 accent-amber-400" />
    </div>
  );
  return (
    <div className="border border-cyan-400/20 p-2">
      <Slider label="金属度" value={params.metallic} min={0} max={1} step={0.01} onC={(v:number)=>update('metallic',v)} />
      <Slider label="粗糙度" value={params.roughness} min={0} max={1} step={0.01} onC={(v:number)=>update('roughness',v)} />
      <Slider label="环境贴图强度" value={params.envMapIntensity} min={0} max={3} step={0.05} onC={(v:number)=>update('envMapIntensity',v)} />
      <Slider label="AO 强度" value={params.aoMapIntensity} min={0} max={2} step={0.05} onC={(v:number)=>update('aoMapIntensity',v)} />
      <Slider label="法线强度" value={params.normalScale} min={0} max={3} step={0.05} onC={(v:number)=>update('normalScale',v)} />
      <Slider label="自发光强度" value={params.emissiveIntensity} min={0} max={5} step={0.05} onC={(v:number)=>update('emissiveIntensity',v)} />
      <div className="flex gap-2 mt-2">
        <div className="flex-1">
          <label className="text-[10px] text-cyan-200/70 block mb-0.5">基础色</label>
          <input type="color" value={params.color as string}
            onChange={e => update('color', e.target.value)}
            className="w-full h-7 bg-transparent border border-cyan-400/30" />
        </div>
        <div className="flex-1">
          <label className="text-[10px] text-cyan-200/70 block mb-0.5">自发光色</label>
          <input type="color" value={params.emissive as string}
            onChange={e => update('emissive', e.target.value)}
            className="w-full h-7 bg-transparent border border-cyan-400/30" />
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between px-1 py-1 hover:bg-purple-950/30 cursor-pointer"
        onClick={() => update('side', params.side === THREE.FrontSide ? THREE.DoubleSide : THREE.FrontSide)}>
        <span className="text-[10px] text-cyan-200/70">双面渲染</span>
        <span className={`text-[10px] ${params.side === THREE.DoubleSide ? 'text-[#9dffb0]' : 'text-cyan-300/40'}`}>
          {params.side === THREE.DoubleSide ? 'ON' : 'OFF'}
        </span>
      </div>
    </div>
  );
}

function PartOverrideRow({
  meshName,
  partLabel,
  override,
  availableTextures,
  onChange,
}: {
  meshName: string;
  partLabel: string;
  override?: PartOverrideEntry;
  availableTextures: ImportedTexture[];
  onChange: (ov: PartOverrideEntry | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const enabled = !!override;
  return (
    <div className="border border-purple-400/20">
      <div className="flex items-center gap-2 px-2 py-1">
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => {
            if (e.target.checked) {
              onChange({ partKey: meshName, partLabel, textures: {}, params: {} });
              setExpanded(true);
            } else {
              onChange(null);
            }
          }}
        />
        <span className="text-[10px] text-cyan-200/80 flex-1">{meshName}</span>
        <span className="text-[9px] text-purple-300/60">{partLabel}</span>
        {enabled && (
          <button onClick={() => setExpanded(v => !v)} className="text-[9px] text-cyan-200/60">
            {expanded ? '▼' : '▶'}
          </button>
        )}
      </div>
      {enabled && expanded && override && (
        <div className="px-2 pb-2 border-t border-purple-400/10 space-y-1">
          <div className="text-[9px] text-cyan-200/50 mt-1">为该部位分配贴图 (留空则继承全局)</div>
          {TEXTURE_CHANNELS.map(c => (
            <div key={c.key} className="flex items-center gap-1">
              <div className="w-14 text-[9px] text-cyan-200/60">{c.label.split(' ')[0]}</div>
              <select
                value={override.textures[c.key] ?? ''}
                onChange={e => {
                  const v = e.target.value;
                  const next = { ...override };
                  next.textures = { ...override.textures };
                  if (v === '') delete next.textures[c.key];
                  else next.textures[c.key] = v;
                  onChange(next);
                }}
                className="flex-1 bg-black/60 border border-cyan-400/20 text-[10px] text-cyan-200 px-1 py-0.5"
              >
                <option value="">(继承全局)</option>
                {availableTextures.map(t => (
                  <option key={t.id} value={t.dataUrl}>{t.fileName}</option>
                ))}
              </select>
            </div>
          ))}
          <div className="mt-1 space-y-1">
            <CompactSlider label="金属度" value={override.params.metallic ?? 0}
              onChange={v => onChange({ ...override, params: { ...override.params, metallic: v } })} />
            <CompactSlider label="粗糙度" value={override.params.roughness ?? 0}
              onChange={v => onChange({ ...override, params: { ...override.params, roughness: v } })} />
          </div>
        </div>
      )}
    </div>
  );
}

function CompactSlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <div className="flex justify-between text-[9px] text-cyan-200/60">
        <span>{label}</span>
        <span className="text-amber-200/80">{value.toFixed(2)}</span>
      </div>
      <input type="range" min={0} max={1} step={0.01} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="w-full h-1 accent-amber-400" />
    </div>
  );
}

// === Helpers ================================================================

async function makeThumb(dataUrl: string, size = 40): Promise<string> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(dataUrl); return; }
      const w = img.naturalWidth, h = img.naturalHeight;
      const s = Math.max(size / w, size / h);
      const dw = w * s, dh = h * s;
      ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
      resolve(canvas.toDataURL('image/jpeg', 0.6));
    };
    img.onerror = () => resolve('');
    img.src = dataUrl;
  });
}

/** Build a procedural preview aircraft (matches game's procedural geometry). */
function buildProceduralPreviewAircraft(model: AircraftModel): THREE.Group {
  // Lazy import to avoid circular deps — use the same procedural builder the game uses
  // We construct a simplified placeholder by reusing models.ts buildProceduralGeometry
  // For lab preview simplicity, build a generic jet silhouette that's "good enough"
  // for material preview. The real game uses buildProceduralGeometry for the actual mesh.
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x808a96, metalness: 0.65, roughness: 0.4 });

  // Body
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.4, 8, 16), mat);
  body.rotation.z = Math.PI / 2;
  body.name = 'fuselage';
  body.castShadow = true; body.receiveShadow = true;
  g.add(body);

  // Nose
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.4, 2, 16), mat);
  nose.rotation.z = -Math.PI / 2;
  nose.position.x = 5;
  nose.name = 'nose';
  nose.castShadow = true; nose.receiveShadow = true;
  g.add(nose);

  // Canopy
  const canopyMat = new THREE.MeshStandardMaterial({ color: 0x102030, metalness: 0.2, roughness: 0.05, transparent: true, opacity: 0.85 });
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), canopyMat);
  canopy.position.set(1.5, 0.55, 0);
  canopy.scale.set(1.6, 1.0, 0.9);
  canopy.name = 'canopy';
  canopy.castShadow = true; canopy.receiveShadow = true;
  g.add(canopy);

  // Wings
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, 0);
  wingShape.lineTo(-2.5, 4.5);
  wingShape.lineTo(-1.5, 4.5);
  wingShape.lineTo(1.5, 0);
  wingShape.closePath();
  const wingGeo = new THREE.ExtrudeGeometry(wingShape, { depth: 0.15, bevelEnabled: false });
  wingGeo.center();
  const wingMat = new THREE.MeshStandardMaterial({ color: 0x4a5568, metalness: 0.7, roughness: 0.4 });
  const wingL = new THREE.Mesh(wingGeo, wingMat);
  wingL.position.set(-0.5, -0.1, 1.6);
  wingL.rotation.x = -Math.PI / 2;
  wingL.name = 'wing_L';
  wingL.castShadow = true; wingL.receiveShadow = true;
  g.add(wingL);
  const wingR = wingL.clone();
  wingR.position.z = -1.6;
  wingR.name = 'wing_R';
  g.add(wingR);

  // Tail
  const tailShape = new THREE.Shape();
  tailShape.moveTo(0, 0);
  tailShape.lineTo(-2, 2.2);
  tailShape.lineTo(-1.5, 2.2);
  tailShape.lineTo(0.5, 0);
  tailShape.closePath();
  const tailGeo = new THREE.ExtrudeGeometry(tailShape, { depth: 0.12, bevelEnabled: false });
  const tail = new THREE.Mesh(tailGeo, wingMat);
  tail.position.set(-3.5, 0.3, 0);
  tail.name = 'tail';
  tail.castShadow = true; tail.receiveShadow = true;
  g.add(tail);

  // Exhaust
  const exhaustGeo = new THREE.CylinderGeometry(0.5, 0.45, 0.4, 16);
  exhaustGeo.rotateZ(Math.PI / 2);
  const exhaustMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a1a, metalness: 0.9, roughness: 0.6,
    emissive: 0xff5520, emissiveIntensity: 0.4,
  });
  const exhaust = new THREE.Mesh(exhaustGeo, exhaustMat);
  exhaust.position.x = -4.2;
  exhaust.name = 'exhaust';
  exhaust.castShadow = true; exhaust.receiveShadow = true;
  g.add(exhaust);

  // Model-specific tweaks
  if (model === 'a10' || model === 'ac130' || model === 'b52' || model === 'tu95') {
    g.scale.set(0.9, 0.9, 0.9);
  }
  if (model === 'f117') {
    // Darker, more metallic
    mat.color.set(0x1a1d24);
    mat.metalness = 0.85;
    mat.roughness = 0.35;
  }
  return g;
}
