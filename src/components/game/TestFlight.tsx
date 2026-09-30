'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import type { AircraftModel } from '@/lib/game/types';
import { PLAYER_AIRCRAFT } from '@/lib/game/aircraft-catalog';
import { getActivePreset, aircraftDisplayName } from '@/lib/engine-lab/aircraft-presets';
import { applyPresetToGroup } from '@/lib/engine-lab/preset-applier';
import { loadModelFromDataUrl, loadModelFromBlob, disposeGroup } from '@/lib/engine-lab/pbr-material';
import { getModelBlob, isIdbRef, idbRefToKey } from '@/lib/engine-lab/blob-store';
import { buildProceduralGeometry } from '@/lib/game/models';
import {
  AIRCRAFT_AERO,
  createAircraftState,
  stepFlight,
  getForwardVector,
  getUpVector,
  mpsToKts,
  mpsToMach,
  mToFeet,
  type AircraftState,
  type FlightControls,
  NEUTRAL_CONTROLS,
} from '@/lib/engine-lab/test-flight-physics';
import { buildTestFlightScene } from '@/lib/engine-lab/test-flight-scene';

interface Props {
  /** Initial aircraft to fly (defaults to the engine lab's currently-selected one) */
  initialAircraft: AircraftModel;
  onClose: () => void;
}

const ALL_MODELS: AircraftModel[] = ['f16','f15','su35','a10','b52','ea18g','ac130','f117','e3','tu95'];

// Camera modes for chase / cockpit / external views
type CameraMode = 'chase' | 'cockpit' | 'external' | 'far';

export function TestFlight({ initialAircraft, onClose }: Props) {
  // === UI state ===
  const [selectedModel, setSelectedModel] = useState<AircraftModel>(initialAircraft);
  const [cameraMode, setCameraMode] = useState<CameraMode>('chase');
  const [paused, setPaused] = useState(false);
  const [showForceVectors, setShowForceVectors] = useState(true);
  const [showForcePanel, setShowForcePanel] = useState(true);
  const [hudData, setHudData] = useState({
    airspeedKts: 0,
    mach: 0,
    altitudeFt: 0,
    verticalSpeed: 0,
    aoaDeg: 0,
    gLoad: 0,
    throttlePct: 80,
    headingDeg: 0,
    stalled: false,
    damagePct: 0,
    // Force breakdown (kN)
    lift: 0, drag: 0, thrust: 0, weight: 0, side: 0, net: 0,
    q: 0, rho: 0, cl: 0, cd: 0,
  });

  // === Refs (not React state — used inside rAF loop) ===
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const aircraftGroupRef = useRef<THREE.Group | null>(null);
  const aircraftMeshRef = useRef<THREE.Mesh | null>(null);
  const stateRef = useRef<AircraftState>(createAircraftState(new THREE.Vector3(0, 1000, 0), 1000));
  const controlsRef = useRef<FlightControls>({ ...NEUTRAL_CONTROLS });
  const scene3DRef = useRef<ReturnType<typeof buildTestFlightScene> | null>(null);
  const keysRef = useRef<Set<string>>(new Set());
  const cameraModeRef = useRef<CameraMode>('chase');
  const pausedRef = useRef(false);
  const selectedModelRef = useRef<AircraftModel>(initialAircraft);
  // Force-vector arrow helpers (one per force) — live in scene, updated each frame
  const forceArrowsRef = useRef<{
    lift: THREE.ArrowHelper;
    drag: THREE.ArrowHelper;
    thrust: THREE.ArrowHelper;
    weight: THREE.ArrowHelper;
    side: THREE.ArrowHelper;
    net: THREE.ArrowHelper;
    velocity: THREE.ArrowHelper;
  } | null>(null);
  const showForceVectorsRef = useRef(true);
  const showForcePanelRef = useRef(true);

  // Sync refs with state
  useEffect(() => { cameraModeRef.current = cameraMode; }, [cameraMode]);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { selectedModelRef.current = selectedModel; }, [selectedModel]);
  useEffect(() => { showForceVectorsRef.current = showForceVectors; }, [showForceVectors]);
  useEffect(() => { showForcePanelRef.current = showForcePanel; }, [showForcePanel]);

  // === Aircraft model loading ===
  const loadAircraftMesh = useCallback(async (model: AircraftModel): Promise<THREE.Group> => {
    const preset = getActivePreset(model);
    let group: THREE.Group;
    if (preset.modelSource === 'file' && preset.modelDataUrl) {
      try {
        if (isIdbRef(preset.modelDataUrl)) {
          // New path: fetch from IndexedDB blob store
          const key = idbRefToKey(preset.modelDataUrl);
          const blob = await getModelBlob(key);
          if (!blob) throw new Error('模型文件未找到 (IndexedDB)');
          group = await loadModelFromBlob(blob, preset.modelFileName ?? 'model.glb', rendererRef.current ?? undefined);
        } else {
          // Legacy data-URL path
          group = await loadModelFromDataUrl(preset.modelDataUrl, preset.modelFileName ?? 'model.glb', rendererRef.current ?? undefined);
        }
      } catch (e) {
        console.warn(`[TestFlight] Model load failed for ${model}, falling back to procedural:`, e);
        group = buildProceduralGroup(model);
      }
    } else {
      group = buildProceduralGroup(model);
    }
    // Center + scale
    const box = new THREE.Box3().setFromObject(group);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 0.001);
    const scale = 6 / maxDim;
    group.position.sub(center.multiplyScalar(scale));
    group.scale.setScalar(scale);

    // Apply preset PBR materials (textures/params) + self-shadow
    const hasCustom = Object.keys(preset.textures).length > 0 || Object.keys(preset.partOverrides).length > 0;
    if (hasCustom) {
      try { await applyPresetToGroup(group, preset); } catch (e) {
        console.warn('[TestFlight] applyPresetToGroup failed:', e);
      }
    } else {
      group.traverse(o => {
        const m = o as THREE.Mesh;
        if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
      });
    }
    return group;
  }, []);

  // === Initialize renderer ===
  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(60, 1, 0.5, 60000);
    camera.position.set(0, 1010, 30);
    cameraRef.current = camera;

    const tfScene = buildTestFlightScene();
    scene3DRef.current = tfScene;
    scene.add(tfScene.group);

    // === Force-vector arrows (color-coded 3D visualizations) ===============
    // Length scales with force magnitude (clamped). Each arrow starts at the
    // aircraft's position and points in the world-space direction of its force.
    const makeArrow = (color: number) => {
      const a = new THREE.ArrowHelper(
        new THREE.Vector3(0, 1, 0), // direction (updated each frame)
        new THREE.Vector3(0, 0, 0), // origin (updated each frame)
        10,                          // length (updated each frame)
        color,
        2.5,                         // headLength
        1.5,                         // headWidth
      );
      // Make arrows render on top of the aircraft mesh for visibility
      a.line.material = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
      (a.cone.material as THREE.Material) = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
      a.renderOrder = 999;
      scene.add(a);
      return a;
    };
    forceArrowsRef.current = {
      lift:     makeArrow(0x00ff88), // green — lift
      drag:     makeArrow(0xff4444), // red — drag
      thrust:   makeArrow(0xffcc00), // yellow — thrust
      weight:   makeArrow(0xffffff), // white — weight
      side:     makeArrow(0xff00ff), // magenta — side force
      net:      makeArrow(0x44ccff), // cyan — net force
      velocity: makeArrow(0x88aaff), // light blue — velocity vector
    };

    // Track whether this effect has been cleaned up — guards against
    // async-race conditions where loadAircraftMesh resolves after unmount.
    let cancelled = false;

    // Initial aircraft load
    loadAircraftMesh(initialAircraft).then(group => {
      if (cancelled) {
        // Component already unmounted — dispose the group we just built
        // so we don't leak GPU memory.
        try { disposeGroup(group); } catch {}
        return;
      }
      aircraftGroupRef.current = group;
      scene.add(group);
      // Reset state for fresh start
      stateRef.current = createAircraftState(new THREE.Vector3(0, 1500, 0), 1500);
    });

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

    // === Input handling ===
    const onKeyDown = (e: KeyboardEvent) => {
      keysRef.current.add(e.code);
      if (e.code === 'KeyP') {
        setPaused(p => !p);
      }
      if (e.code === 'KeyC') {
        setCameraMode(m => m === 'chase' ? 'cockpit' : m === 'cockpit' ? 'external' : m === 'external' ? 'far' : 'chase');
      }
      if (e.code === 'KeyR') {
        // Reset
        stateRef.current = createAircraftState(new THREE.Vector3(0, 1500, 0), 1500);
        controlsRef.current = { ...NEUTRAL_CONTROLS };
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keysRef.current.delete(e.code);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    // === Main render/physics loop ===
    let rafId = 0;
    let lastT = performance.now();
    let hudCounter = 0;
    const loop = () => {
      rafId = requestAnimationFrame(loop);
      if (cancelled) return;
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastT) / 1000);
      lastT = now;

      // Read controls from keys
      const keys = keysRef.current;
      const controls = controlsRef.current;
      // Pitch: W = nose down (+1), S = nose up (-1) — convention: pull back = nose up
      // We use S=pull up, W=push down like WT/Warthunder
      let pitch = 0;
      if (keys.has('KeyW') || keys.has('ArrowUp')) pitch -= 1;
      if (keys.has('KeyS') || keys.has('ArrowDown')) pitch += 1;
      // Roll: A = left, D = right
      let roll = 0;
      if (keys.has('KeyA') || keys.has('ArrowLeft')) roll -= 1;
      if (keys.has('KeyD') || keys.has('ArrowRight')) roll += 1;
      // Yaw: Q = left, E = right
      let yaw = 0;
      if (keys.has('KeyQ')) yaw -= 1;
      if (keys.has('KeyE')) yaw += 1;
      controls.pitch = pitch;
      controls.roll = roll;
      controls.yaw = yaw;
      // Throttle: Shift = up, Ctrl = down
      if (keys.has('ShiftLeft') || keys.has('ShiftRight')) controls.throttle = Math.min(1, controls.throttle + dt * 0.5);
      if (keys.has('ControlLeft') || keys.has('ControlRight')) controls.throttle = Math.max(0, controls.throttle - dt * 0.5);
      // Airbrake: B
      controls.airbrake = keys.has('KeyB') ? 1 : 0;

      // === Step physics ===
      if (!pausedRef.current && aircraftGroupRef.current) {
        const aero = AIRCRAFT_AERO[selectedModelRef.current];
        const state = stateRef.current;
        // Sub-step for stability at high angular rates
        const subSteps = 2;
        const subDt = dt / subSteps;
        for (let i = 0; i < subSteps; i++) {
          stepFlight(state, controls, aero, subDt);
        }
        // Apply to mesh
        aircraftGroupRef.current.position.copy(state.position);
        aircraftGroupRef.current.quaternion.copy(state.orientation);
      }

      // === Camera follow ===
      const state = stateRef.current;
      const mode = cameraModeRef.current;
      const cam = cameraRef.current;
      const aircraft = aircraftGroupRef.current;
      if (cam && aircraft) {
        if (mode === 'chase') {
          // Chase camera: behind and above the aircraft
          const fwd = getForwardVector(state, new THREE.Vector3());
          const up = getUpVector(state, new THREE.Vector3());
          const targetPos = state.position.clone()
            .sub(fwd.clone().multiplyScalar(25))
            .add(up.clone().multiplyScalar(6));
          cam.position.lerp(targetPos, 1 - Math.exp(-dt * 8));
          cam.lookAt(state.position.x, state.position.y, state.position.z);
        } else if (mode === 'cockpit') {
          // Cockpit: just ahead of aircraft, looking forward
          const fwd = getForwardVector(state, new THREE.Vector3());
          const up = getUpVector(state, new THREE.Vector3());
          cam.position.copy(state.position)
            .add(fwd.clone().multiplyScalar(2))
            .add(up.clone().multiplyScalar(0.8));
          const lookAt = state.position.clone().add(fwd.clone().multiplyScalar(100));
          cam.lookAt(lookAt);
          // Use aircraft orientation directly for cockpit immersion
          cam.quaternion.copy(state.orientation);
          cam.rotateY(Math.PI); // face forward (since -Z is forward in our convention)
        } else if (mode === 'external') {
          // External: orbit slightly behind
          const fwd = getForwardVector(state, new THREE.Vector3());
          const right = new THREE.Vector3(1, 0, 0).applyQuaternion(state.orientation);
          const targetPos = state.position.clone()
            .sub(fwd.clone().multiplyScalar(40))
            .add(right.clone().multiplyScalar(15))
            .add(new THREE.Vector3(0, 10, 0));
          cam.position.lerp(targetPos, 1 - Math.exp(-dt * 4));
          cam.lookAt(state.position);
        } else if (mode === 'far') {
          // Far cinematic: high above and far behind
          const fwd = getForwardVector(state, new THREE.Vector3());
          const targetPos = state.position.clone()
            .sub(fwd.clone().multiplyScalar(80))
            .add(new THREE.Vector3(0, 30, 0));
          cam.position.lerp(targetPos, 1 - Math.exp(-dt * 2));
          cam.lookAt(state.position);
        }
      }

      // === Update scene (sky/sun follows camera) ===
      if (scene3DRef.current && cameraRef.current) {
        scene3DRef.current.update(dt, cameraRef.current.position);
      }

      // === Update force-vector arrows ========================================
      // Each arrow: position = aircraft position; direction = world-space unit
      // vector of the force; length = force magnitude (kN) scaled to a visible
      // range. We use a non-linear scale (sqrt) so small forces stay visible
      // while huge ones don't dominate the screen.
      const arrows = forceArrowsRef.current;
      const showVec = showForceVectorsRef.current;
      if (arrows) {
        const s = stateRef.current;
        const pos = s.position;
        const f = s.forces;
        // Scale: 1 m of arrow length per ~5 kN (with sqrt compression)
        const scaleLen = (kn: number) => Math.min(40, Math.sqrt(Math.max(0, kn)) * 2);
        const updateArrow = (a: THREE.ArrowHelper, dir: THREE.Vector3, kn: number) => {
          const len = scaleLen(kn);
          if (len < 0.5 || !showVec) {
            a.visible = false;
            return;
          }
          a.visible = true;
          a.position.copy(pos);
          a.setDirection(dir);
          a.setLength(len, Math.min(2.5, len * 0.3), Math.min(1.5, len * 0.18));
        };
        updateArrow(arrows.lift,     f.liftDir,     f.lift);
        updateArrow(arrows.drag,     f.dragDir,     f.drag);
        updateArrow(arrows.thrust,   f.thrustDir,   f.thrust);
        updateArrow(arrows.weight,   f.weightDir,   f.weight);
        updateArrow(arrows.side,     f.sideDir,     f.side);
        // Net force — always show if non-trivial
        const netLen = f.netVec.length();
        if (netLen > 1 && showVec) {
          arrows.net.visible = true;
          arrows.net.position.copy(pos);
          arrows.net.setDirection(f.netVec.clone().normalize());
          arrows.net.setLength(scaleLen(f.net), Math.min(3, scaleLen(f.net) * 0.3), Math.min(1.8, scaleLen(f.net) * 0.18));
        } else {
          arrows.net.visible = false;
        }
        // Velocity vector (length proportional to airspeed, scaled down)
        if (s.airspeed > 5 && showVec) {
          arrows.velocity.visible = true;
          arrows.velocity.position.copy(pos);
          arrows.velocity.setDirection(s.velocity.clone().normalize());
          const vlen = Math.min(50, s.airspeed * 0.15);
          arrows.velocity.setLength(vlen, Math.min(3, vlen * 0.2), Math.min(1.8, vlen * 0.12));
        } else {
          arrows.velocity.visible = false;
        }
      }

      // === Render ===
      renderer.render(scene, camera);

      // === HUD update (throttled to 10 Hz) ===
      hudCounter += dt;
      if (hudCounter >= 0.1) {
        hudCounter = 0;
        const s = stateRef.current;
        // Heading: from velocity vector (or facing if too slow)
        const fwd = getForwardVector(s, new THREE.Vector3());
        let heading = Math.atan2(fwd.x, -fwd.z) * 180 / Math.PI;
        if (heading < 0) heading += 360;
        setHudData({
          airspeedKts: mpsToKts(s.airspeed),
          mach: mpsToMach(s.airspeed),
          altitudeFt: mToFeet(s.altitude),
          verticalSpeed: s.velocity.y,
          aoaDeg: s.aoa * 180 / Math.PI,
          gLoad: s.gLoad,
          throttlePct: controls.throttle * 100,
          headingDeg: heading,
          stalled: s.stalled,
          damagePct: s.damage * 100,
          lift: s.forces.lift,
          drag: s.forces.drag,
          thrust: s.forces.thrust,
          weight: s.forces.weight,
          side: s.forces.side,
          net: s.forces.net,
          q: s.forces.q,
          rho: s.forces.rho,
          cl: s.forces.cl,
          cd: s.forces.cd,
        });
      }
    };
    loop();

    return () => {
      // Mark cancelled FIRST so the async loadAircraftMesh callback and the
      // rAF loop bail out instead of touching the disposing renderer.
      cancelled = true;
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      try {
        if (aircraftGroupRef.current) {
          disposeGroup(aircraftGroupRef.current);
        }
      } catch (e) { console.warn('[TestFlight] disposeGroup error:', e); }
      // Dispose force-vector arrows
      if (forceArrowsRef.current) {
        for (const a of Object.values(forceArrowsRef.current)) {
          try {
            scene.remove(a);
            a.dispose();
          } catch {}
        }
        forceArrowsRef.current = null;
      }
      try {
        renderer.dispose();
      } catch (e) { console.warn('[TestFlight] renderer.dispose error:', e); }
      // Null out refs so the selectedModel useEffect (which may fire on a
      // stale closure) can no-op safely.
      aircraftGroupRef.current = null;
      sceneRef.current = null;
      rendererRef.current = null;
      cameraRef.current = null;
      scene3DRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // === Switch aircraft model ===
  useEffect(() => {
    if (!sceneRef.current) return;
    const scene = sceneRef.current;
    // Remove old
    if (aircraftGroupRef.current) {
      scene.remove(aircraftGroupRef.current);
      try { disposeGroup(aircraftGroupRef.current); } catch {}
      aircraftGroupRef.current = null;
    }
    let cancelled = false;
    // Load new
    loadAircraftMesh(selectedModel).then(group => {
      if (cancelled || !sceneRef.current) {
        // Component unmounted or scene torn down while we were loading —
        // dispose the freshly-built group to avoid GPU leak.
        try { disposeGroup(group); } catch {}
        return;
      }
      aircraftGroupRef.current = group;
      sceneRef.current.add(group);
      // Reset state
      stateRef.current = createAircraftState(new THREE.Vector3(0, 1500, 0), 1500);
    });
    return () => { cancelled = true; };
  }, [selectedModel, loadAircraftMesh]);

  // === Aircraft picker dropdown ===
  const AircraftPicker = () => (
    <div className="absolute top-3 left-3 z-10">
      <div className="text-[10px] text-cyan-200/60 tracking-widest mb-1">试飞机型</div>
      <select
        value={selectedModel}
        onChange={e => setSelectedModel(e.target.value as AircraftModel)}
        className="bg-black/80 border border-cyan-400/40 text-cyan-100 text-sm px-2 py-1.5 tracking-wider font-mono"
      >
        {ALL_MODELS.map(m => {
          const preset = getActivePreset(m);
          const hasCustom = preset.modelSource === 'file' || Object.keys(preset.textures).length > 0;
          return (
            <option key={m} value={m}>
              {aircraftDisplayName(m)}{hasCustom ? ' ★已优化' : ''}
            </option>
          );
        })}
      </select>
    </div>
  );

  // === Force row (one line in the force panel) ===
  const ForceRow = ({ label, color, value }: { label: string; color: string; value: number }) => {
    // Bar graph: max ~250 kN reference (typical fighter max lift at 9G)
    const maxKn = 300;
    const pct = Math.min(100, (value / maxKn) * 100);
    return (
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className="inline-block w-2 h-2" style={{ background: color }} />
        <span className="text-cyan-200/80 w-[78px]">{label}</span>
        <div className="flex-1 h-1.5 bg-black/40 border border-cyan-400/10 relative">
          <div className="absolute inset-y-0 left-0" style={{ width: `${pct}%`, background: color, opacity: 0.85 }} />
        </div>
        <span className="text-amber-200 w-[44px] text-right">{value.toFixed(1)}</span>
      </div>
    );
  };

  // === HUD overlay ===
  const HUD = () => {
    const h = hudData;
    return (
      <>
        {/* Top-left: aircraft picker */}
        <AircraftPicker />

        {/* Top-right: controls help + force-toggle buttons */}
        <div className="absolute top-3 right-3 z-10 text-[10px] text-cyan-200/70 tracking-widest font-mono bg-black/40 px-3 py-2 border border-cyan-400/20 space-y-1">
          <div className="text-amber-200">[控制]</div>
          <div>W/S 俯仰 · A/D 滚转 · Q/E 偏航</div>
          <div>Shift/Ctrl 油门 · B 减速板</div>
          <div>C 切换视角 · P 暂停 · R 重置</div>
          <div className="pt-1 border-t border-cyan-400/20 mt-1 space-y-0.5">
            <button
              onClick={() => setShowForcePanel(v => !v)}
              className={`block w-full text-left px-1.5 py-0.5 border tracking-wider ${showForcePanel ? 'border-emerald-400/50 text-emerald-300 bg-emerald-400/10' : 'border-cyan-400/30 text-cyan-300/60 hover:bg-cyan-400/5'}`}
            >
              {showForcePanel ? '✓' : '○'} 力面板
            </button>
            <button
              onClick={() => setShowForceVectors(v => !v)}
              className={`block w-full text-left px-1.5 py-0.5 border tracking-wider ${showForceVectors ? 'border-emerald-400/50 text-emerald-300 bg-emerald-400/10' : 'border-cyan-400/30 text-cyan-300/60 hover:bg-cyan-400/5'}`}
            >
              {showForceVectors ? '✓' : '○'} 3D 力矢量
            </button>
          </div>
        </div>

        {/* Force panel — left side, all important aerodynamic forces */}
        {showForcePanel && (
          <div className="absolute top-20 left-3 z-10 text-[10px] font-mono bg-black/55 border border-cyan-400/30 backdrop-blur px-3 py-2 tracking-wider w-[210px]">
            <div className="text-amber-200 mb-1 text-[11px]">[受力分析 · kN]</div>
            <ForceRow label="升力 Lift"     color="#00ff88" value={h.lift}   />
            <ForceRow label="阻力 Drag"     color="#ff4444" value={h.drag}   />
            <ForceRow label="推力 Thrust"   color="#ffcc00" value={h.thrust} />
            <ForceRow label="重力 Weight"   color="#ffffff" value={h.weight} />
            <ForceRow label="侧力 Side"     color="#ff00ff" value={h.side}   />
            <div className="border-t border-cyan-400/20 my-1" />
            <ForceRow label="合力 Net"      color="#44ccff" value={h.net}    />
            <div className="border-t border-cyan-400/20 my-1" />
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-cyan-200/70">
              <div>Cl: <span className="text-amber-200">{h.cl.toFixed(3)}</span></div>
              <div>Cd: <span className="text-amber-200">{h.cd.toFixed(3)}</span></div>
              <div>q:  <span className="text-amber-200">{(h.q/1000).toFixed(1)}kPa</span></div>
              <div>ρ:  <span className="text-amber-200">{h.rho.toFixed(3)}</span></div>
            </div>
          </div>
        )}

        {/* Force-vector legend — bottom-left, above camera-mode badge */}
        {showForceVectors && (
          <div className="absolute bottom-12 left-3 z-10 text-[9px] font-mono bg-black/40 px-2 py-1 border border-cyan-400/20 tracking-wider">
            <div className="text-amber-200/80 mb-0.5">3D 矢量图例</div>
            <div className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-[#00ff88]"></span>升力</div>
            <div className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-[#ff4444]"></span>阻力</div>
            <div className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-[#ffcc00]"></span>推力</div>
            <div className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-[#ffffff]"></span>重力</div>
            <div className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-[#ff00ff]"></span>侧力</div>
            <div className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-[#44ccff]"></span>合力</div>
            <div className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-[#88aaff]"></span>速度</div>
          </div>
        )}

        {/* Bottom-center: HUD tape */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10 flex gap-6 text-xs font-mono bg-black/50 px-6 py-2 border border-cyan-400/30 backdrop-blur">
          <div className="text-center">
            <div className="text-[9px] text-cyan-200/60">SPEED</div>
            <div className={`text-lg ${h.stalled ? 'text-red-400' : 'text-[#9dffb0]'}`}>{Math.round(h.airspeedKts)}</div>
            <div className="text-[9px] text-cyan-200/40">kts</div>
          </div>
          <div className="text-center">
            <div className="text-[9px] text-cyan-200/60">MACH</div>
            <div className="text-lg text-amber-200">{h.mach.toFixed(2)}</div>
          </div>
          <div className="text-center">
            <div className="text-[9px] text-cyan-200/60">ALT</div>
            <div className="text-lg text-[#9dffb0]">{Math.round(h.altitudeFt).toLocaleString()}</div>
            <div className="text-[9px] text-cyan-200/40">ft</div>
          </div>
          <div className="text-center">
            <div className="text-[9px] text-cyan-200/60">V/S</div>
            <div className={`text-lg ${h.verticalSpeed < -20 ? 'text-red-400' : h.verticalSpeed > 20 ? 'text-[#9dffb0]' : 'text-amber-200'}`}>
              {h.verticalSpeed > 0 ? '+' : ''}{Math.round(h.verticalSpeed * 60)}
            </div>
            <div className="text-[9px] text-cyan-200/40">fpm</div>
          </div>
          <div className="text-center">
            <div className="text-[9px] text-cyan-200/60">AoA</div>
            <div className={`text-lg ${Math.abs(h.aoaDeg) > 15 ? 'text-red-400' : 'text-amber-200'}`}>{h.aoaDeg.toFixed(1)}°</div>
          </div>
          <div className="text-center">
            <div className="text-[9px] text-cyan-200/60">G</div>
            <div className={`text-lg ${h.gLoad > 7 || h.gLoad < -2 ? 'text-red-400' : 'text-[#9dffb0]'}`}>{h.gLoad.toFixed(1)}</div>
          </div>
          <div className="text-center">
            <div className="text-[9px] text-cyan-200/60">THR</div>
            <div className="text-lg text-amber-200">{Math.round(h.throttlePct)}</div>
            <div className="text-[9px] text-cyan-200/40">%</div>
          </div>
          <div className="text-center">
            <div className="text-[9px] text-cyan-200/60">HDG</div>
            <div className="text-lg text-[#9dffb0]">{Math.round(h.headingDeg).toString().padStart(3,'0')}°</div>
          </div>
        </div>

        {/* Stall / damage warning */}
        {h.stalled && (
          <div className="absolute top-1/3 left-1/2 -translate-x-1/2 z-10 text-red-500 text-3xl font-bold tracking-widest animate-pulse">
            ⚠ STALL
          </div>
        )}
        {h.damagePct > 50 && (
          <div className="absolute top-2/5 left-1/2 -translate-x-1/2 z-10 text-red-500 text-2xl font-bold tracking-widest animate-pulse">
            ⚠ AIRFRAME DAMAGE {Math.round(h.damagePct)}%
          </div>
        )}

        {/* Camera mode badge */}
        <div className="absolute bottom-3 left-3 z-10 text-[10px] text-cyan-200/60 tracking-widest font-mono">
          视角: <span className="text-amber-200">{cameraMode.toUpperCase()}</span>
        </div>

        {/* Pause overlay */}
        {paused && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60">
            <div className="text-amber-200 text-4xl tracking-widest font-bold">⏸ 已暂停</div>
          </div>
        )}
      </>
    );
  };

  return (
    <div className="absolute inset-0 z-50 bg-black">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      <HUD />
      <button
        onClick={onClose}
        className="absolute top-3 left-1/2 -translate-x-1/2 z-10 px-4 py-1.5 bg-black/60 border border-cyan-400/40 text-cyan-200 text-xs tracking-widest hover:bg-cyan-400/10"
      >
        ◀ 返回引擎实验室
      </button>
    </div>
  );
}

// === Helper: build a procedural aircraft Group (with named parts for PBR) ===

function buildProceduralGroup(model: AircraftModel): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x808a96, metalness: 0.65, roughness: 0.4 });
  // Reuse the game's procedural geometry builder
  const geo = buildProceduralGeometry(model);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'fuselage';
  g.add(mesh);
  return g;
}
