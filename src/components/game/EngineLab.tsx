'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import { EngineLabRenderer } from '@/lib/engine-lab/engine-lab-renderer';
import {
  type EngineProfile,
  type PresetBuiltin,
  type ToneMappingMode,
  type AOMethod,
  type Antialiasing,
  type ShadowQuality,
  type CloudQuality,
  getBuiltinProfile,
  loadAllProfiles,
  saveAllProfiles,
  applyProfileToGame,
  loadActiveProfile,
  setActiveProfile,
  upsertProfile,
  deleteProfile,
  cloneProfile,
} from '@/lib/engine-lab/profile';
import { buildPreviewFighter, buildDesertTerrain, buildMountainRange, buildPBRTestRig } from '@/lib/engine-lab/lab-scene';
import { HangarLab } from './HangarLab';
import { TestFlight } from './TestFlight';
import type { AircraftModel } from '@/lib/game/types';

interface Props {
  onBack: () => void;
}

export function EngineLab({ onBack }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<EngineLabRenderer | null>(null);
  const fighterRef = useRef<THREE.Group | null>(null);
  const pbrRigRef = useRef<THREE.Group | null>(null);
  const orbitRef = useRef({ theta: 0, phi: 0.4, r: 35, auto: true });
  const [profile, setProfile] = useState<EngineProfile>(() => loadActiveProfile());
  const [savedProfiles, setSavedProfiles] = useState<EngineProfile[]>(() => loadAllProfiles());
  const [fps, setFps] = useState(60);
  const [activeTab, setActiveTab] = useState<'shadows' | 'sky' | 'lighting' | 'ao' | 'bloom' | 'dof' | 'motion' | 'tone' | 'color' | 'volumetric' | 'clouds' | 'performance'>('shadows');
  const [showHangarLab, setShowHangarLab] = useState(false);
  const [showTestFlight, setShowTestFlight] = useState(false);
  const [testFlightAircraft, setTestFlightAircraft] = useState<AircraftModel>('f16');
  const [autoRotate, setAutoRotate] = useState(true);
  const [nameInput, setNameInput] = useState(profile.name);
  const [showAppliedToast, setShowAppliedToast] = useState(false);

  // ─── 初始化渲染器 ──────────────────────────────────────
  useEffect(() => {
    if (!canvasRef.current) return;
    const r = new EngineLabRenderer({
      canvas: canvasRef.current,
      profile,
    });
    rendererRef.current = r;
    r.setFpsCallback(setFps);

    // 加预览场景
    const fighter = buildPreviewFighter();
    fighterRef.current = fighter;
    r.scene.add(fighter);
    r.enableSelfShadowOn(fighter);

    const terrain = buildDesertTerrain();
    r.scene.add(terrain);
    r.enableReceiveShadowOnly(terrain);

    const mountains = buildMountainRange();
    r.scene.add(mountains);
    r.enableReceiveShadowOnly(mountains);

    const rig = buildPBRTestRig();
    pbrRigRef.current = rig;
    rig.position.set(0, 0, -15);
    r.scene.add(rig);
    r.enableSelfShadowOn(rig);

    // 相机轨道
    let rafId = 0;
    let lastT = performance.now();
    const loop = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastT) / 1000);
      lastT = now;
      // 自动旋转相机
      if (autoRotate && fighterRef.current) {
        orbitRef.current.theta += dt * 0.3;
      }
      const { theta, phi, r: dist } = orbitRef.current;
      const cam = r.camera;
      cam.position.set(
        Math.cos(theta) * Math.cos(phi) * dist,
        Math.sin(phi) * dist + 5,
        Math.sin(theta) * Math.cos(phi) * dist,
      );
      cam.lookAt(0, 0, 0);
      // 跟随玩家位置 (让阴影相机也跟着)
      r.followPlayer(new THREE.Vector3(0, 0, 0), -8);
      // 让机体自转
      if (fighterRef.current) fighterRef.current.rotation.y += dt * 0.1;
      if (pbrRigRef.current) pbrRigRef.current.rotation.y += dt * 0.2;
      r.render(dt);
      rafId = requestAnimationFrame(loop);
    };
    loop();

    const onResize = () => r.resize();
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      r.dispose();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── profile 改动时实时应用 ────────────────────────────
  useEffect(() => {
    if (!rendererRef.current) return;
    rendererRef.current.applyProfile(profile);
  }, [profile]);

  // ─── 修改 profile 的辅助函数 (immutable 更新) ─────────
  const update = useCallback((fn: (p: EngineProfile) => void) => {
    setProfile((prev) => {
      const next = structuredClone(prev);
      fn(next);
      next.preset = 'custom';
      return next;
    });
  }, []);

  const updateShadows = (fn: (s: EngineProfile['shadows']) => void) => update((p) => fn(p.shadows));
  const updateSky = (fn: (s: EngineProfile['sky']) => void) => update((p) => fn(p.sky));
  const updateLighting = (fn: (l: EngineProfile['lighting']) => void) => update((p) => fn(p.lighting));
  const updateAO = (fn: (a: EngineProfile['ao']) => void) => update((p) => fn(p.ao));
  const updateBloom = (fn: (b: EngineProfile['bloom']) => void) => update((p) => fn(p.bloom));
  const updateDOF = (fn: (d: EngineProfile['dof']) => void) => update((p) => fn(p.dof));
  const updateMotion = (fn: (m: EngineProfile['motionBlur']) => void) => update((p) => fn(p.motionBlur));
  const updateTone = (fn: (t: EngineProfile['toneMapping']) => void) => update((p) => fn(p.toneMapping));
  const updateColor = (fn: (c: EngineProfile['colorGrading']) => void) => update((p) => fn(p.colorGrading));
  const updateVolumetric = (fn: (v: EngineProfile['volumetric']) => void) => update((p) => fn(p.volumetric));
  const updateClouds = (fn: (c: EngineProfile['clouds']) => void) => update((p) => fn(p.clouds));
  const updatePerf = (fn: (pf: EngineProfile['performance']) => void) => update((p) => fn(p.performance));

  // ─── 预设管理 ───────────────────────────────────────
  const loadBuiltin = (preset: PresetBuiltin) => {
    const p = getBuiltinProfile(preset);
    setProfile(p);
    setNameInput(p.name);
  };
  const resetToDefault = () => {
    // Reset graphics quality to the factory Balanced profile and clear the
    // active-profile pointer so the game falls back to defaults too.
    const p = getBuiltinProfile('balanced');
    setProfile(p);
    setNameInput(p.name);
    try {
      window.localStorage.removeItem('skybound.engineLab.activeProfile');
    } catch {}
    setSavedProfiles(loadAllProfiles());
    setShowAppliedToast(true);
    setTimeout(() => setShowAppliedToast(false), 2500);
  };
  const saveAsPreset = () => {
    if (!nameInput.trim()) return;
    const toSave: EngineProfile = { ...structuredClone(profile), name: nameInput.trim() };
    upsertProfile(toSave);
    setSavedProfiles(loadAllProfiles());
  };
  const loadSaved = (name: string) => {
    const p = savedProfiles.find((x) => x.name === name);
    if (p) {
      setProfile(structuredClone(p));
      setNameInput(p.name);
    }
  };
  const deleteSaved = (name: string) => {
    deleteProfile(name);
    setSavedProfiles(loadAllProfiles());
  };
  const duplicateProfile = () => {
    const c = cloneProfile(profile);
    setProfile(c);
    setNameInput(c.name);
  };
  const applyToGame = () => {
    if (!nameInput.trim()) return;
    const toApply: EngineProfile = { ...structuredClone(profile), name: nameInput.trim() };
    applyProfileToGame(toApply);
    setSavedProfiles(loadAllProfiles());
    // 显示成功提示
    setShowAppliedToast(true);
    setTimeout(() => setShowAppliedToast(false), 2500);
  };

  // ─── 鼠标拖动相机 ───────────────────────────────────
  const onMouseDown = (e: React.MouseEvent) => {
    const startX = e.clientX;
    const startY = e.clientY;
    const startTheta = orbitRef.current.theta;
    const startPhi = orbitRef.current.phi;
    setAutoRotate(false);
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      orbitRef.current.theta = startTheta - dx * 0.01;
      orbitRef.current.phi = Math.max(0.1, Math.min(Math.PI / 2 - 0.1, startPhi + dy * 0.01));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const onWheel = (e: React.WheelEvent) => {
    orbitRef.current.r = Math.max(10, Math.min(80, orbitRef.current.r + e.deltaY * 0.02));
  };

  // ─── UI 辅助组件 ────────────────────────────────────
  const Slider = ({ label, value, min, max, step, onChange, fmt }: {
    label: string; value: number; min: number; max: number; step: number;
    onChange: (v: number) => void; fmt?: (v: number) => string;
  }) => (
    <div className="mb-3">
      <div className="flex justify-between items-center mb-1">
        <label className="text-xs text-cyan-200/80 tracking-wider">{label}</label>
        <span className="text-xs text-amber-200/90 font-mono">{fmt ? fmt(value) : value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1 accent-amber-400"
      />
    </div>
  );

  const Toggle = ({ label, value, onChange }: {
    label: string; value: boolean; onChange: (v: boolean) => void;
  }) => (
    <div className="flex justify-between items-center mb-2 px-1 py-1.5 hover:bg-cyan-950/30 cursor-pointer" onClick={() => onChange(!value)}>
      <span className="text-xs text-cyan-200/80 tracking-wider">{label}</span>
      <span className={`text-xs tracking-widest ${value ? 'text-[#9dffb0]' : 'text-cyan-300/40'}`}>{value ? 'ON' : 'OFF'}</span>
    </div>
  );

  const Select = <T extends string>({ label, value, options, onChange }: {
    label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
  }) => (
    <div className="mb-3">
      <label className="text-xs text-cyan-200/80 tracking-wider block mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="w-full bg-cyan-950/60 border border-cyan-400/30 text-cyan-100 text-xs px-2 py-1.5"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );

  const TAB_LABELS: { key: typeof activeTab; label: string }[] = [
    { key: 'shadows', label: '阴影' },
    { key: 'sky', label: '天光' },
    { key: 'lighting', label: '灯光' },
    { key: 'ao', label: 'AO' },
    { key: 'bloom', label: '泛光' },
    { key: 'dof', label: '景深' },
    { key: 'motion', label: '动模' },
    { key: 'tone', label: '色调' },
    { key: 'color', label: '调色' },
    { key: 'volumetric', label: '体积雾' },
    { key: 'clouds', label: '体积云' },
    { key: 'performance', label: '性能' },
  ];

  return (
    <div className="fixed inset-0 w-full h-full bg-black overflow-hidden flex font-mono">
      {/* === 左侧：参数面板 === */}
      <div className="w-[420px] h-full flex flex-col border-r border-cyan-400/30 bg-gradient-to-b from-cyan-950/40 to-black">
        {/* 标题 */}
        <div className="px-4 py-3 border-b border-cyan-400/30 flex items-center justify-between">
          <button onClick={onBack} className="text-xs text-cyan-300/60 hover:text-cyan-100 tracking-widest">← BACK</button>
          <h2 className="text-base text-amber-300 tracking-widest">引擎实验室</h2>
          <span className="text-[10px] text-cyan-300/50">{fps.toFixed(0)} FPS</span>
        </div>

        {/* 预设栏 */}
        <div className="px-3 py-2 border-b border-cyan-400/20 space-y-2">
          <div className="flex gap-1 flex-wrap">
            {(['cinematic', 'balanced', 'performance', 'minimal'] as PresetBuiltin[]).map((p) => (
              <button
                key={p}
                onClick={() => loadBuiltin(p)}
                className={`text-[10px] px-2 py-1 border tracking-widest transition-colors ${
                  profile.preset === p
                    ? 'border-amber-300 text-amber-200 bg-amber-300/10'
                    : 'border-cyan-400/30 text-cyan-300/70 hover:border-cyan-300 hover:text-cyan-100'
                }`}
              >
                {p.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="flex gap-1 items-center">
            <input
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="画质预设名"
              className="flex-1 bg-cyan-950/60 border border-cyan-400/30 text-cyan-100 text-xs px-2 py-1"
            />
            <button
              onClick={saveAsPreset}
              className="text-[10px] px-2 py-1 border border-cyan-400/40 text-cyan-200 hover:bg-cyan-400/10 tracking-widest"
              title="把当前画质参数保存为预设（可命名多个）"
            >保存</button>
            <button
              onClick={duplicateProfile}
              className="text-[10px] px-2 py-1 border border-cyan-400/40 text-cyan-200 hover:bg-cyan-400/10 tracking-widest"
            >复制</button>
            <button
              onClick={resetToDefault}
              className="text-[10px] px-2 py-1 border border-amber-400/40 text-amber-200 hover:bg-amber-400/10 tracking-widest"
              title="放弃当前修改，恢复 Balanced 默认画质"
            >重置</button>
          </div>
          {/* 已保存画质预设列表 */}
          <div className="max-h-24 overflow-y-auto space-y-0.5">
            {savedProfiles.map((p) => (
              <div key={p.name} className="flex items-center gap-1 text-[10px]">
                <button
                  onClick={() => loadSaved(p.name)}
                  className={`flex-1 text-left px-2 py-1 border tracking-wider ${
                    profile.name === p.name
                      ? 'border-[#9dffb0]/60 bg-[#9dffb0]/10 text-[#9dffb0]'
                      : 'border-cyan-400/20 text-cyan-200/70 hover:bg-cyan-400/5'
                  }`}
                >
                  {p.name} <span className="opacity-50">[{p.preset}]</span>
                </button>
                <button
                  onClick={() => deleteSaved(p.name)}
                  className="px-1.5 py-1 border border-red-400/30 text-red-300/70 hover:bg-red-400/10"
                >×</button>
              </div>
            ))}
          </div>
        </div>

        {/* 标签栏 */}
        <div className="flex flex-wrap gap-0.5 px-2 py-2 border-b border-cyan-400/20">
          {TAB_LABELS.map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`text-[10px] px-2 py-1 tracking-wider transition-colors ${
                activeTab === t.key
                  ? 'bg-amber-400/20 text-amber-200 border border-amber-300/50'
                  : 'text-cyan-300/60 hover:text-cyan-100 border border-transparent'
              }`}
            >{t.label}</button>
          ))}
        </div>

        {/* 参数区域 */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {activeTab === 'shadows' && (
            <>
              <Toggle label="启用阴影" value={profile.shadows.enabled} onChange={(v) => updateShadows((s) => { s.enabled = v; })} />
              <Toggle label="机体自阴影" value={profile.shadows.selfShadow} onChange={(v) => updateShadows((s) => { s.selfShadow = v; })} />
              <Toggle label="接触阴影 (接地感)" value={profile.shadows.contactShadows} onChange={(v) => updateShadows((s) => { s.contactShadows = v; })} />
              <Select<ShadowQuality>
                label="阴影质量"
                value={profile.shadows.quality}
                onChange={(v) => updateShadows((s) => { s.quality = v; })}
                options={[
                  { value: 'low', label: 'LOW (1024)' },
                  { value: 'medium', label: 'MEDIUM (2048)' },
                  { value: 'high', label: 'HIGH (2048×4级)' },
                  { value: 'ultra', label: 'ULTRA (4096×4级)' },
                ]}
              />
              <Slider label="CSM 级联数" value={profile.shadows.cascades} min={1} max={4} step={1}
                onChange={(v) => updateShadows((s) => { s.cascades = v as 1|2|3|4; })}
                fmt={(v) => `${v.toFixed(0)} 级`} />
              <Slider label="软阴影 (PCF 半径)" value={profile.shadows.softness} min={0} max={1} step={0.05}
                onChange={(v) => updateShadows((s) => { s.softness = v; })} />
              <Slider label="阴影偏置" value={profile.shadows.bias} min={-0.005} max={0} step={0.0001}
                onChange={(v) => updateShadows((s) => { s.bias = v; })}
                fmt={(v) => v.toFixed(4)} />
              <Slider label="法线偏置" value={profile.shadows.normalBias} min={0} max={2} step={0.05}
                onChange={(v) => updateShadows((s) => { s.normalBias = v; })} />
              <Slider label="接触阴影半径" value={profile.shadows.contactRadius} min={2} max={20} step={0.5}
                onChange={(v) => updateShadows((s) => { s.contactRadius = v; })}
                fmt={(v) => `${v.toFixed(1)} m`} />
              <Slider label="接触阴影不透明度" value={profile.shadows.contactOpacity} min={0.1} max={1} step={0.05}
                onChange={(v) => updateShadows((s) => { s.contactOpacity = v; })} />
            </>
          )}
          {activeTab === 'sky' && (
            <>
              <Toggle label="大气散射 (UE5 风格)" value={profile.sky.atmosphericScattering} onChange={(v) => updateSky((s) => { s.atmosphericScattering = v; })} />
              <Toggle label="上帝之光 (God Rays)" value={profile.sky.godRays} onChange={(v) => updateSky((s) => { s.godRays = v; })} />
              <Slider label="太阳方位角" value={profile.sky.sunAzimuth} min={0} max={360} step={1}
                onChange={(v) => updateSky((s) => { s.sunAzimuth = v; })}
                fmt={(v) => `${v.toFixed(0)}°`} />
              <Slider label="太阳仰角" value={profile.sky.sunElevation} min={0} max={90} step={1}
                onChange={(v) => updateSky((s) => { s.sunElevation = v; })}
                fmt={(v) => `${v.toFixed(0)}°`} />
              <Slider label="大气浊度" value={profile.sky.turbidity} min={1} max={10} step={0.5}
                onChange={(v) => updateSky((s) => { s.turbidity = v; })} />
              <Slider label="瑞利散射 (蓝度)" value={profile.sky.rayleigh} min={0} max={6} step={0.1}
                onChange={(v) => updateSky((s) => { s.rayleigh = v; })} />
              <Slider label="米氏散射 (光晕)" value={profile.sky.mieCoefficient} min={0} max={0.05} step={0.001}
                onChange={(v) => updateSky((s) => { s.mieCoefficient = v; })}
                fmt={(v) => v.toFixed(4)} />
              <Slider label="米氏方向性" value={profile.sky.mieDirectionalG} min={0.5} max={0.95} step={0.01}
                onChange={(v) => updateSky((s) => { s.mieDirectionalG = v; })} />
              <Slider label="地平线色温" value={profile.sky.horizonTint} min={-1} max={1} step={0.05}
                onChange={(v) => updateSky((s) => { s.horizonTint = v; })}
                fmt={(v) => v > 0 ? `+${v.toFixed(2)} 暖` : `${v.toFixed(2)} 冷`} />
              <Slider label="大气透视距离" value={profile.sky.perspectiveDistance} min={5} max={100} step={1}
                onChange={(v) => updateSky((s) => { s.perspectiveDistance = v; })}
                fmt={(v) => `${v.toFixed(0)} km`} />
              <Slider label="God Rays 强度" value={profile.sky.godRaysIntensity} min={0} max={2} step={0.1}
                onChange={(v) => updateSky((s) => { s.godRaysIntensity = v; })} />
            </>
          )}
          {activeTab === 'lighting' && (
            <>
              <Slider label="太阳光强度" value={profile.lighting.sunIntensity} min={0} max={10} step={0.1}
                onChange={(v) => updateLighting((l) => { l.sunIntensity = v; })} />
              <Slider label="太阳色温 (K)" value={profile.lighting.sunColorTemperature} min={2000} max={12000} step={100}
                onChange={(v) => updateLighting((l) => { l.sunColorTemperature = v; })}
                fmt={(v) => `${v.toFixed(0)} K`} />
              <Slider label="环境光强度" value={profile.lighting.ambientIntensity} min={0} max={2} step={0.05}
                onChange={(v) => updateLighting((l) => { l.ambientIntensity = v; })} />
              <Slider label="IBL 环境贴图强度" value={profile.lighting.environmentIntensity} min={0} max={3} step={0.1}
                onChange={(v) => updateLighting((l) => { l.environmentIntensity = v; })} />
              <div className="mb-3">
                <label className="text-xs text-cyan-200/80 tracking-wider block mb-1">半球天光色</label>
                <input type="color" value={profile.lighting.hemisphereSkyColor}
                  onChange={(e) => updateLighting((l) => { l.hemisphereSkyColor = e.target.value; })}
                  className="w-full h-8 bg-transparent border border-cyan-400/30" />
              </div>
              <div className="mb-3">
                <label className="text-xs text-cyan-200/80 tracking-wider block mb-1">地面反射色</label>
                <input type="color" value={profile.lighting.hemisphereGroundColor}
                  onChange={(e) => updateLighting((l) => { l.hemisphereGroundColor = e.target.value; })}
                  className="w-full h-8 bg-transparent border border-cyan-400/30" />
              </div>
            </>
          )}
          {activeTab === 'ao' && (
            <>
              <Select<AOMethod>
                label="AO 方法"
                value={profile.ao.method}
                onChange={(v) => updateAO((a) => { a.method = v; })}
                options={[
                  { value: 'off', label: '关闭' },
                  { value: 'ssao', label: 'SSAO (基础)' },
                  { value: 'gtao', label: 'GTAO (高级，参考 UE5)' },
                ]}
              />
              <Slider label="采样半径" value={profile.ao.radius} min={0.1} max={2.0} step={0.05}
                onChange={(v) => updateAO((a) => { a.radius = v; })} />
              <Slider label="遮蔽强度" value={profile.ao.intensity} min={0} max={3} step={0.1}
                onChange={(v) => updateAO((a) => { a.intensity = v; })} />
              <Slider label="偏置" value={profile.ao.bias} min={0} max={0.2} step={0.005}
                onChange={(v) => updateAO((a) => { a.bias = v; })}
                fmt={(v) => v.toFixed(3)} />
              <Slider label="距离衰减" value={profile.ao.distanceAttenuation} min={0} max={2} step={0.05}
                onChange={(v) => updateAO((a) => { a.distanceAttenuation = v; })} />
            </>
          )}
          {activeTab === 'bloom' && (
            <>
              <Toggle label="启用 Bloom" value={profile.bloom.enabled} onChange={(v) => updateBloom((b) => { b.enabled = v; })} />
              <Toggle label="Mipmap 多尺度模糊" value={profile.bloom.mipmapBlur} onChange={(v) => updateBloom((b) => { b.mipmapBlur = v; })} />
              <Slider label="强度" value={profile.bloom.strength} min={0} max={3} step={0.05}
                onChange={(v) => updateBloom((b) => { b.strength = v; })} />
              <Slider label="半径" value={profile.bloom.radius} min={0} max={1.5} step={0.05}
                onChange={(v) => updateBloom((b) => { b.radius = v; })} />
              <Slider label="阈值" value={profile.bloom.threshold} min={0} max={1.5} step={0.05}
                onChange={(v) => updateBloom((b) => { b.threshold = v; })} />
            </>
          )}
          {activeTab === 'dof' && (
            <>
              <Toggle label="启用景深 (DOF)" value={profile.dof.enabled} onChange={(v) => updateDOF((d) => { d.enabled = v; })} />
              <Toggle label="自动对焦机体" value={profile.dof.autofocus} onChange={(v) => updateDOF((d) => { d.autofocus = v; })} />
              <Slider label="聚焦距离" value={profile.dof.focusDistance} min={5} max={300} step={1}
                onChange={(v) => updateDOF((d) => { d.focusDistance = v; })}
                fmt={(v) => `${v.toFixed(0)} m`} />
              <Slider label="光圈 (越大景深越浅)" value={profile.dof.aperture} min={0.001} max={0.1} step={0.001}
                onChange={(v) => updateDOF((d) => { d.aperture = v; })}
                fmt={(v) => v.toFixed(3)} />
            </>
          )}
          {activeTab === 'motion' && (
            <>
              <Toggle label="启用运动模糊" value={profile.motionBlur.enabled} onChange={(v) => updateMotion((m) => { m.enabled = v; })} />
              <Slider label="模糊强度" value={profile.motionBlur.strength} min={0} max={1} step={0.05}
                onChange={(v) => updateMotion((m) => { m.strength = v; })} />
              <Slider label="触发速度阈值" value={profile.motionBlur.velocityThreshold} min={50} max={500} step={10}
                onChange={(v) => updateMotion((m) => { m.velocityThreshold = v; })}
                fmt={(v) => `${v.toFixed(0)} m/s`} />
            </>
          )}
          {activeTab === 'tone' && (
            <>
              <Select<ToneMappingMode>
                label="色调映射"
                value={profile.toneMapping.mode}
                onChange={(v) => updateTone((t) => { t.mode = v; })}
                options={[
                  { value: 'ACES', label: 'ACES Filmic (推荐)' },
                  { value: 'AgX', label: 'AgX (电影感)' },
                  { value: 'Reinhard', label: 'Reinhard (柔和)' },
                  { value: 'Filmic', label: 'Filmic (胶片)' },
                  { value: 'None', label: '关闭' },
                ]}
              />
              <Slider label="曝光" value={profile.toneMapping.exposure} min={0.3} max={2.5} step={0.05}
                onChange={(v) => updateTone((t) => { t.exposure = v; })} />
              <Slider label="伽马" value={profile.toneMapping.gamma} min={1.5} max={3} step={0.05}
                onChange={(v) => updateTone((t) => { t.gamma = v; })} />
            </>
          )}
          {activeTab === 'color' && (
            <>
              <Slider label="对比度" value={profile.colorGrading.contrast} min={0.5} max={1.5} step={0.02}
                onChange={(v) => updateColor((c) => { c.contrast = v; })} />
              <Slider label="饱和度" value={profile.colorGrading.saturation} min={0} max={2} step={0.05}
                onChange={(v) => updateColor((c) => { c.saturation = v; })} />
              <Slider label="色温" value={profile.colorGrading.temperature} min={-100} max={100} step={2}
                onChange={(v) => updateColor((c) => { c.temperature = v; })}
                fmt={(v) => v > 0 ? `+${v.toFixed(0)} 暖` : `${v.toFixed(0)} 冷`} />
              <Slider label="色调" value={profile.colorGrading.tint} min={-100} max={100} step={2}
                onChange={(v) => updateColor((c) => { c.tint = v; })}
                fmt={(v) => v > 0 ? `+${v.toFixed(0)} 品` : `${v.toFixed(0)} 绿`} />
              <Slider label="暗部抬升 (Lift)" value={profile.colorGrading.lift} min={0} max={0.3} step={0.01}
                onChange={(v) => updateColor((c) => { c.lift = v; })} />
              <Slider label="高光压制" value={profile.colorGrading.highlights} min={0.5} max={1.5} step={0.02}
                onChange={(v) => updateColor((c) => { c.highlights = v; })} />
            </>
          )}
          {activeTab === 'volumetric' && (
            <>
              <Toggle label="启用体积雾" value={profile.volumetric.enabled} onChange={(v) => updateVolumetric((s) => { s.enabled = v; })} />
              <Slider label="雾密度" value={profile.volumetric.density} min={0} max={0.01} step={0.0001}
                onChange={(v) => updateVolumetric((s) => { s.density = v; })}
                fmt={(v) => v.toFixed(4)} />
              <Slider label="高度衰减" value={profile.volumetric.heightFalloff} min={0} max={0.005} step={0.0001}
                onChange={(v) => updateVolumetric((s) => { s.heightFalloff = v; })}
                fmt={(v) => v.toFixed(4)} />
              <div className="mb-3">
                <label className="text-xs text-cyan-200/80 tracking-wider block mb-1">雾色</label>
                <input type="color" value={profile.volumetric.color}
                  onChange={(e) => updateVolumetric((s) => { s.color = e.target.value; })}
                  className="w-full h-8 bg-transparent border border-cyan-400/30" />
              </div>
            </>
          )}
          {activeTab === 'clouds' && (
            <>
              <Toggle label="启用体积云 (光线步进)" value={profile.clouds.enabled} onChange={(v) => updateClouds((c) => { c.enabled = v; })} />
              <Select<CloudQuality>
                label="云质量 (步进次数)"
                value={profile.clouds.quality}
                onChange={(v) => updateClouds((c) => { c.quality = v; })}
                options={[
                  { value: 'low',    label: 'LOW (16 步 / 2 光步)' },
                  { value: 'medium', label: 'MEDIUM (32 步 / 3 光步)' },
                  { value: 'high',   label: 'HIGH (48 步 / 4 光步)' },
                  { value: 'ultra',  label: 'ULTRA (64 步 / 6 光步)' },
                ]}
              />
              <Slider label="云覆盖率" value={profile.clouds.coverage} min={0} max={1} step={0.01}
                onChange={(v) => updateClouds((c) => { c.coverage = v; })}
                fmt={(v) => `${(v * 100).toFixed(0)}%`} />
              <Slider label="云密度" value={profile.clouds.density} min={0} max={2} step={0.05}
                onChange={(v) => updateClouds((c) => { c.density = v; })} />
              <Slider label="风速 (云漂移)" value={profile.clouds.windSpeed} min={0} max={1} step={0.01}
                onChange={(v) => updateClouds((c) => { c.windSpeed = v; })}
                fmt={(v) => `${(v * 100).toFixed(0)}%`} />
              <Slider label="云层底部高度" value={profile.clouds.cloudBottom} min={200} max={4000} step={50}
                onChange={(v) => updateClouds((c) => { c.cloudBottom = v; })}
                fmt={(v) => `${v.toFixed(0)} m`} />
              <Slider label="云层顶部高度" value={profile.clouds.cloudTop} min={500} max={6000} step={50}
                onChange={(v) => updateClouds((c) => { c.cloudTop = v; })}
                fmt={(v) => `${v.toFixed(0)} m`} />
              <Slider label="太阳照亮强度" value={profile.clouds.sunIntensity} min={0} max={3} step={0.05}
                onChange={(v) => updateClouds((c) => { c.sunIntensity = v; })} />
              <div className="mb-3">
                <label className="text-xs text-cyan-200/80 tracking-wider block mb-1">云内环境光色</label>
                <input type="color" value={profile.clouds.ambientColor}
                  onChange={(e) => updateClouds((c) => { c.ambientColor = e.target.value; })}
                  className="w-full h-8 bg-transparent border border-cyan-400/30" />
              </div>
              <div className="text-[10px] text-cyan-200/50 leading-relaxed mt-2 px-1">
                体积云采用物理启发模型: Henyey-Greenstein 双叶相位 + Beer-Powder 衰减 + 多次散射近似。
                ULTRA 档在 RTX 3060 上约 5-8ms/帧; 若掉帧请降到 MEDIUM。
                云层会自动跟随太阳方向与颜色 (与「天光」标签同步)。
              </div>
            </>
          )}
          {activeTab === 'performance' && (
            <>
              <Slider label="分辨率缩放" value={profile.resolutionScale} min={0.5} max={1.5} step={0.05}
                onChange={(v) => update((p) => { p.resolutionScale = v; })}
                fmt={(v) => `${(v * 100).toFixed(0)}%`} />
              <Slider label="像素比上限" value={profile.pixelRatioCap} min={0.75} max={2} step={0.05}
                onChange={(v) => update((p) => { p.pixelRatioCap = v; })}
                fmt={(v) => v.toFixed(2)} />
              <Select<Antialiasing>
                label="抗锯齿"
                value={profile.antialiasing}
                onChange={(v) => update((p) => { p.antialiasing = v; })}
                options={[
                  { value: 'off', label: '关闭' },
                  { value: 'fxaa', label: 'FXAA (快)' },
                  { value: 'smaa', label: 'SMAA (高质量)' },
                ]}
              />
              <Select<'deferred' | 'forward'>
                label="渲染管线"
                value={profile.pipeline}
                onChange={(v) => update((p) => { p.pipeline = v; })}
                options={[
                  { value: 'deferred', label: '延迟渲染 (Deferred)' },
                  { value: 'forward', label: '前向渲染 (Forward)' },
                ]}
              />
              <Select<'30' | '60' | '120'>
                label="目标帧率"
                value={String(profile.performance.targetFps) as '30' | '60' | '120'}
                onChange={(v) => updatePerf((pf) => { pf.targetFps = parseInt(v) as 30|60|120; })}
                options={[
                  { value: '30', label: '30 FPS' },
                  { value: '60', label: '60 FPS' },
                  { value: '120', label: '120 FPS' },
                ]}
              />
              <Toggle label="自适应分辨率降级" value={profile.performance.adaptiveScaling} onChange={(v) => updatePerf((pf) => { pf.adaptiveScaling = v; })} />
              <Slider label="最低降采样" value={profile.performance.adaptiveMinScale} min={0.3} max={0.9} step={0.05}
                onChange={(v) => updatePerf((pf) => { pf.adaptiveMinScale = v; })}
                fmt={(v) => `${(v * 100).toFixed(0)}%`} />
              <Toggle label="实例合并 (LOD)" value={profile.performance.instancing} onChange={(v) => updatePerf((pf) => { pf.instancing = v; })} />
              <Toggle label="视锥裁剪" value={profile.performance.frustumCulling} onChange={(v) => updatePerf((pf) => { pf.frustumCulling = v; })} />
            </>
          )}
        </div>

        {/* 底部：应用到游戏 */}
        <div className="px-3 py-3 border-t border-cyan-400/30 space-y-2">
          <button
            onClick={() => setShowHangarLab(true)}
            className="w-full py-2 text-xs border border-purple-400/50 text-purple-200 hover:bg-purple-400/10 tracking-widest"
            title="按机型管理涂装与模型预设（与画质预设互相独立）"
          >
            ◆ 机体涂装 / 模型预设 (按机型)
          </button>
          <button
            onClick={() => {
              // Pre-fill with whichever aircraft the user last edited in HangarLab
              // (stored by HangarLab on close). Default to f16.
              let m: AircraftModel = 'f16';
              try {
                const stored = window.localStorage.getItem('skybound.hangarLab.lastModel');
                if (stored) m = stored as AircraftModel;
              } catch {}
              setTestFlightAircraft(m);
              setShowTestFlight(true);
            }}
            className="w-full py-2 text-xs border border-amber-400/50 text-amber-200 hover:bg-amber-400/10 tracking-widest"
          >
            ✈ 试飞 (拟真气动 · 无敌我)
          </button>
          <button
            onClick={applyToGame}
            className="w-full py-2.5 text-sm border-2 border-[#9dffb0]/70 hover:border-[#9dffb0] text-[#9dffb0] hover:bg-[#9dffb0]/10 tracking-widest font-bold"
          >
            ▶ 应用画质到游戏
          </button>
          {showAppliedToast && (
            <div className="text-[10px] text-[#9dffb0] text-center tracking-widest animate-pulse">
              ✓ 已保存并设为当前画质预设，下次任务启动时生效
            </div>
          )}
        </div>
      </div>

      {/* === 右侧：3D 预览 === */}
      <div className="flex-1 relative" onMouseDown={onMouseDown} onWheel={onWheel}>
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

        {/* 浮层：参数指示器 */}
        <div className="absolute top-3 left-3 text-[10px] text-cyan-200/70 tracking-widest space-y-0.5 pointer-events-none">
          <div>管线: <span className="text-amber-200">{profile.pipeline.toUpperCase()}</span></div>
          <div>级联: <span className="text-amber-200">{profile.shadows.cascades}×</span> / 软阴影: <span className="text-amber-200">{(profile.shadows.softness * 100).toFixed(0)}%</span></div>
          <div>AO: <span className="text-amber-200">{profile.ao.method.toUpperCase()}</span> / Bloom: <span className="text-amber-200">{profile.bloom.enabled ? 'ON' : 'OFF'}</span></div>
          <div>色调: <span className="text-amber-200">{profile.toneMapping.mode}</span> / 曝光: <span className="text-amber-200">{profile.toneMapping.exposure.toFixed(2)}</span></div>
          <div>分辨率: <span className="text-amber-200">{(profile.resolutionScale * 100).toFixed(0)}%</span></div>
          <div>体积云: <span className="text-amber-200">{profile.clouds.enabled ? profile.clouds.quality.toUpperCase() : 'OFF'}</span></div>
        </div>

        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-[10px] text-cyan-200/50 tracking-widest pointer-events-none">
          鼠标拖动旋转 · 滚轮缩放 · {autoRotate ? '自动旋转 ON' : '自动旋转 OFF'}
        </div>

        <button
          onClick={() => setAutoRotate((v) => !v)}
          className="absolute top-3 right-3 text-[10px] px-2 py-1 border border-cyan-400/40 text-cyan-200 hover:bg-cyan-400/10 tracking-widest"
        >
          {autoRotate ? '⏸ 暂停旋转' : '▶ 自动旋转'}
        </button>
      </div>

      {/* === 实验机库浮层 (Portal 到 body 避免 Three.js canvas 与 React reconciliation 冲突) === */}
      {showHangarLab && typeof document !== 'undefined' && createPortal(
        <HangarLab
          onClose={() => setShowHangarLab(false)}
          onApplyToFighter={(group) => {
            // 把机库里的 PBR 材质应用到当前预览机体
            if (fighterRef.current) {
              fighterRef.current.traverse((o) => {
                const m = o as THREE.Mesh;
                if (m.isMesh && m.material) {
                  if (Array.isArray(m.material)) m.material.forEach((mm) => mm.dispose());
                  else (m.material as THREE.Material).dispose();
                  m.material = (group as any).material ?? m.material;
                }
              });
              rendererRef.current?.enableSelfShadowOn(fighterRef.current);
            }
          }}
        />,
        document.body,
      )}

      {/* === 试飞浮层 (Portal 到 body) === */}
      {showTestFlight && typeof document !== 'undefined' && createPortal(
        <TestFlight
          initialAircraft={testFlightAircraft}
          onClose={() => setShowTestFlight(false)}
        />,
        document.body,
      )}
    </div>
  );
}
