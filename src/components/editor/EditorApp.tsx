// === 地形编辑器 UI (per user request: UE5 编辑器式地形编辑器) ===
// 布局:左侧(资产库 + 场景大纲)、右侧(Inspector 参数面板)、顶栏(地图/
// 保存/导出)、底部 HUD(帧率/面数/流式/显存)。所有参数实时驱动
// EditorWorld.applyPatch(实时 uniform 或防抖重建)。
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { EditorWorld, type EditorStats } from '@/lib/editor/editor-world';
import { PALETTE, type EditorActor } from '@/lib/editor/editor-placement';
import { defaultEditorParams, parseEditorParams, exportTuneDoc, EDITOR_MAP_TYPES, type EditorParams, type EditorMapType } from '@/lib/editor/editor-params';
import { encodeF32Bin, type HeightGrid } from '@/lib/terrain-import/height-source';
import { loadExternalHeight } from '@/lib/terrain-import/loader';
import { applyGridTransform, transformImageToCanvas } from '@/lib/terrain-import/transform';
import { DEFAULT_CANONICAL } from '@/lib/terrain-import/classify';
import { assetUrl } from '@/lib/game/asset-url';
import { GaeaImportDialog } from './GaeaImportDialog';
import { TUNE_LS_KEY } from '@/lib/game/terrain-tune';

const PROJECT_LS_KEY = 'skybound.editor.project';

// ---------- 控件 ----------
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-slate-800 py-2">
      <div className="text-[11px] font-semibold text-cyan-400 mb-1.5">{title}</div>
      <div className="space-y-1.5 px-1">{children}</div>
    </div>
  );
}
function Row({ label, value, min, max, step, fmt, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  fmt?: (v: number) => string; onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-slate-300">
      <span className="w-24 shrink-0 truncate">{label}</span>
      <input type="range" className="flex-1 h-1.5 accent-[#9dffb0]" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))} />
      <input type="number" className="w-16 bg-slate-800 rounded px-1 py-0.5 text-right text-slate-200"
        value={value} step={step} min={min} max={max}
        onChange={(e) => onChange(parseFloat(e.target.value))} />
      {fmt && <span className="w-14 text-right text-slate-400">{fmt(value)}</span>}
    </div>
  );
}
function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer">
      <input type="checkbox" className="accent-[#9dffb0]" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span className="flex-1">{label}</span>
    </label>
  );
}
function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-slate-300">
      <span className="w-24 shrink-0 truncate">{label}</span>
      <input type="color" className="h-5 w-10 bg-slate-800 rounded" value={value} onChange={(e) => onChange(e.target.value)} />
      <span className="text-slate-500">{value}</span>
    </div>
  );
}
function SelectRow({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-slate-300">
      <span className="w-24 shrink-0 truncate">{label}</span>
      <select className="flex-1 bg-slate-800 rounded px-1 py-0.5 text-slate-200"
        value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
}

// ---------- Inspector ----------
function Inspector({ world, params, setParams, actor, brush, onBrush }: {
  world: EditorWorld;
  params: EditorParams;
  setParams: (p: EditorParams) => void;
  actor: EditorActor | null;
  brush: { channel: number | null; radius: number; strength: number };
  onBrush: (b: typeof brush) => void;
}) {
  const map = params.maps[params.mapType];
  const patch = (p: Partial<Parameters<EditorWorld['applyPatch']>[0]>) => {
    const next = { ...params };
    if (p.terrain) next.maps[params.mapType] = { ...next.maps[params.mapType], terrain: { ...next.maps[params.mapType].terrain, ...p.terrain } };
    if (p.material) next.maps[params.mapType] = { ...next.maps[params.mapType], material: { ...next.maps[params.mapType].material, ...p.material } };
    if (p.veg) next.maps[params.mapType] = { ...next.maps[params.mapType], veg: { ...next.maps[params.mapType].veg, ...p.veg } };
    if (p.city) next.maps[params.mapType] = { ...next.maps[params.mapType], city: { ...next.maps[params.mapType].city, ...p.city } };
    if (p.lod) next.maps[params.mapType] = { ...next.maps[params.mapType], lod: { ...next.maps[params.mapType].lod, ...p.lod } };
    if (p.fog) next.fog = { ...next.fog, ...p.fog };
    if (p.sky) next.sky = { ...next.sky, ...p.sky };
    if (p.quality) next.quality = { ...next.quality, ...p.quality };
    if (p.debug) next.debug = { ...next.debug, ...p.debug };
    setParams(next);
    world.applyPatch(p);
  };

  const t = map.terrain;
  return (
    <div className="flex-1 overflow-y-auto p-2 space-y-0.5 bg-slate-950/90 text-slate-200">
      <Section title="地形 · 核心">
        <Row label="尺寸 size" value={t.size} min={6000} max={80000} step={1000} fmt={(v) => `${(v / 1000).toFixed(1)}km`} onChange={(v) => patch({ terrain: { size: v } })} />
        <Row label="精度 segments" value={t.segments} min={128} max={1024} step={32} onChange={(v) => patch({ terrain: { segments: v } })} />
        <Row label="最高峰 maxHeight" value={t.maxHeight} min={200} max={8000} step={50} fmt={(v) => `${v}m`} onChange={(v) => patch({ terrain: { maxHeight: v } })} />
        <Row label="种子 seed" value={t.seed} min={1} max={99999} step={1} onChange={(v) => patch({ terrain: { seed: Math.round(v) } })} />
        <SelectRow label="噪声模式" value={t.mode} options={[['mountain', '山岳'], ['plains', '平原'], ['canyon', '峡谷'], ['archipelago', '群岛']]} onChange={(v) => patch({ terrain: { mode: v as never } })} />
        <SelectRow label="贴图样式" value={t.terrainStyle} options={[['mountain', 'MWAM 山岳'], ['desert', 'MWAM 荒漠'], ['archipelago', 'MWAM 群岛'], ['plains', 'MWAM 平原'], ['canyon', 'MWAM 峡谷']]} onChange={(v) => patch({ terrain: { terrainStyle: v } })} />
        <Toggle label="岛屿衰减 islandFalloff" value={t.islandFalloff} onChange={(v) => patch({ terrain: { islandFalloff: v } })} />
        <Row label="岛屿半径" value={t.islandRadius} min={2000} max={40000} step={500} onChange={(v) => patch({ terrain: { islandRadius: v } })} />
        <ColorRow label="岩石底" value={t.rockColor} onChange={(v) => patch({ terrain: { rockColor: v } })} />
        <ColorRow label="草地底" value={t.grassColor} onChange={(v) => patch({ terrain: { grassColor: v } })} />
        <ColorRow label="沙地底" value={t.sandColor} onChange={(v) => patch({ terrain: { sandColor: v } })} />
        <ColorRow label="雪地底" value={t.snowColor} onChange={(v) => patch({ terrain: { snowColor: v } })} />
      </Section>
      <Section title="地形 · 分带(真实高度分位)">
        <Row label="低地带顶 Q" value={t.zoneLowTop} min={0} max={0.3} step={0.005} onChange={(v) => patch({ terrain: { zoneLowTop: v } })} />
        <Row label="植被带顶 Q" value={t.zoneVegiTop} min={0.1} max={0.95} step={0.005} onChange={(v) => patch({ terrain: { zoneVegiTop: v } })} />
        <Row label="岩带顶 Q" value={t.zoneRockTop} min={0.2} max={1} step={0.005} onChange={(v) => patch({ terrain: { zoneRockTop: v } })} />
        <Row label="边界软化 ±Q" value={t.zoneBandQ} min={0.01} max={0.2} step={0.005} onChange={(v) => patch({ terrain: { zoneBandQ: v } })} />
        <Toggle label="雪带启用" value={t.zoneSnowEnabled} onChange={(v) => patch({ terrain: { zoneSnowEnabled: v } })} />
      </Section>
      <Section title="地形 · 分层基准(平面高度切片)">
        <SelectRow label="基准模式" value={t.bandMode} options={[['relative', '相对域高(随山自适应)'], ['quantile', '分位(面积均衡)'], ['absolute', '绝对海拔(固定平面)']]} onChange={(v) => patch({ terrain: { bandMode: v as never } })} />
        <Row label="低地带顶(米)" value={t.bandLow} min={0} max={6000} step={10} onChange={(v) => patch({ terrain: { bandLow: v } })} />
        <Row label="植被带顶(米)" value={t.bandVegi} min={20} max={8000} step={10} onChange={(v) => patch({ terrain: { bandVegi: v } })} />
        <Row label="岩带顶(米)" value={t.bandRock} min={100} max={9000} step={10} onChange={(v) => patch({ terrain: { bandRock: v } })} />
        <Toggle label="显示高度切片平面" value={params.debug.showBandSlices} onChange={(v) => patch({ debug: { showBandSlices: v } })} />
        {(() => {
          const h = world.bandHeights();
          return h ? (
            <div className="text-[10px] text-slate-500 leading-4">
              当前边界高度:沙/草 {h.low.toFixed(0)}m · 草/岩 {h.vegi.toFixed(0)}m · 岩/雪 {h.rock.toFixed(0)}m
            </div>
          ) : null;
        })()}
      </Section>
      <Section title="地形 · 高度图 AO">
        <Row label="AO 强度" value={t.aoStrength} min={0} max={1} step={0.01} onChange={(v) => patch({ terrain: { aoStrength: v } })} />
        <Row label="AO 近半径" value={t.aoRadius1} min={30} max={3000} step={10} fmt={(v) => `${v}m`} onChange={(v) => patch({ terrain: { aoRadius1: v } })} />
        <Row label="AO 远半径" value={t.aoRadius2} min={100} max={12000} step={50} fmt={(v) => `${v}m`} onChange={(v) => patch({ terrain: { aoRadius2: v } })} />
        <SelectRow label="AO 方位" value={String(t.aoDirs)} options={[['3', '3(快)'], ['6', '6(精细)']]} onChange={(v) => patch({ terrain: { aoDirs: parseInt(v, 10) } })} />
      </Section>
      <Section title="分层材质(实时)">
        <Row label="贴图平铺 tile" value={map.material.tileSize} min={2} max={300} step={1} fmt={(v) => `${v}m`} onChange={(v) => patch({ material: { tileSize: v } })} />
        <Row label="低洼暗化" value={map.material.wetTint} min={0} max={1} step={0.01} onChange={(v) => patch({ material: { wetTint: v } })} />
        <Row label="低洼阈值" value={map.material.wetLevel} min={0} max={100} step={0.5} onChange={(v) => patch({ material: { wetLevel: v } })} />
        <Row label="法线强度" value={map.material.normalScale} min={0} max={2} step={0.05} onChange={(v) => patch({ material: { normalScale: v } })} />
        <Row label="宏AO覆盖(-1=分带)" value={map.material.macroAO} min={-1} max={1} step={0.05} onChange={(v) => patch({ material: { macroAO: v } })} />
        {[0, 1, 2, 3].map((i) => (
          <Row key={i} label={`槽${i} 平铺倍率`} value={map.material.slotScales[i]} min={0.2} max={4} step={0.05}
            onChange={(v) => patch({ material: { slotScales: map.material.slotScales.map((s, j) => (j === i ? v : s)) as never } })} />
        ))}
      </Section>
      <Section title="纹理分布 · Mask Splatting">
        <SelectRow label="分布模式" value={map.material.maskMode ? 'mask' : 'auto'}
          options={[['auto', '自动分层(顶点权重)'], ['mask', '遮罩模式(逐像素)']]}
          onChange={(v) => patch({ material: { maskMode: v === 'mask' } })} />
        <div className="flex gap-1 items-center">
          <button className="text-[10px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700"
            onClick={() => { void world.autoGenerateMask(params.mapType, true).then(() => world.applyMaskToMaterial(params.mapType, true)); }}>
            自动生成遮罩(按当前分带)
          </button>
          <SelectRow label="分辨率" value={String(params.masks[params.mapType].res)}
            options={[['512', '512'], ['1024', '1024'], ['2048', '2048']]}
            onChange={(v) => setParams({ ...params, masks: { ...params.masks, [params.mapType]: { res: parseInt(v, 10) as never } } })} />
        </div>
        {map.material.maskMode && (
          <>
            <div className="text-[10px] text-slate-500 mt-1 leading-4">
              R/G/B/A = 低地/草/岩/雪 权重(单张 RGBA 遮罩,4 通道控制 4 层纹理)。
              按住左键在地形上绘制;先选下面的层再画。
            </div>
            <div className="grid grid-cols-4 gap-1">
              {[['低地', '#e8d8a8'], ['草', '#4a9a3a'], ['岩', '#8a8a86'], ['雪', '#e8f2fa']].map(([name, col], i) => (
                <button key={name}
                  className={`text-[10px] px-1 py-1 rounded border ${brush.channel === i ? 'border-[#9dffb0] bg-emerald-900/40 text-[#9dffb0]' : 'border-slate-700 hover:border-slate-500 text-slate-300'}`}
                  style={{ borderLeft: `4px solid ${col}` }}
                  onClick={() => onBrush({ ...brush, channel: brush.channel === i ? null : i })}>
                  {name}
                </button>
              ))}
            </div>
            <Row label="笔刷半径" value={brush.radius} min={20} max={4000} step={10} fmt={(v) => `${v}m`} onChange={(v) => onBrush({ ...brush, radius: v })} />
            <Row label="笔刷强度" value={brush.strength} min={0.02} max={1} step={0.02} onChange={(v) => onBrush({ ...brush, strength: v })} />
            {brush.channel === null && <div className="text-[10px] text-amber-300/70">选一层开始绘制(自动切到遮罩模式需先点自动生成)</div>}
          </>
        )}
      </Section>
      <Section title="植被(InstancedMesh)">
        <Toggle label="启用植被" value={map.veg.enabled} onChange={(v) => patch({ veg: { enabled: v } })} />
        <Row label="数量" value={map.veg.count} min={0} max={20000} step={100} onChange={(v) => patch({ veg: { count: Math.round(v) } })} />
        <Row label="分布半径" value={map.veg.spread} min={1000} max={30000} step={500} onChange={(v) => patch({ veg: { spread: v } })} />
        <Row label="最大坡度" value={map.veg.maxSlope} min={0.1} max={1} step={0.05} onChange={(v) => patch({ veg: { maxSlope: v } })} />
        <Row label="高度下限" value={map.veg.minHeight} min={0} max={3000} step={10} onChange={(v) => patch({ veg: { minHeight: v } })} />
        <Row label="高度上限" value={map.veg.maxHeight} min={100} max={8000} step={50} onChange={(v) => patch({ veg: { maxHeight: v } })} />
      </Section>
      <Section title="植被 · 素材编辑(3A)">
        <ColorRow label="草色" value={map.veg.colorTune.grass} onChange={(v) => patch({ veg: { colorTune: { ...map.veg.colorTune, grass: v } } })} />
        <ColorRow label="针叶树冠" value={map.veg.colorTune.conifer} onChange={(v) => patch({ veg: { colorTune: { ...map.veg.colorTune, conifer: v } } })} />
        <ColorRow label="阔叶树冠" value={map.veg.colorTune.decid} onChange={(v) => patch({ veg: { colorTune: { ...map.veg.colorTune, decid: v } } })} />
        <ColorRow label="灌木色" value={map.veg.colorTune.bush} onChange={(v) => patch({ veg: { colorTune: { ...map.veg.colorTune, bush: v } } })} />
        <ColorRow label="树干色" value={map.veg.colorTune.trunk} onChange={(v) => patch({ veg: { colorTune: { ...map.veg.colorTune, trunk: v } } })} />
        <Row label="树尺寸×" value={map.veg.scaleTune.tree} min={0.2} max={3} step={0.05} onChange={(v) => patch({ veg: { scaleTune: { ...map.veg.scaleTune, tree: v } } })} />
        <Row label="灌木尺寸×" value={map.veg.scaleTune.bush} min={0.2} max={3} step={0.05} onChange={(v) => patch({ veg: { scaleTune: { ...map.veg.scaleTune, bush: v } } })} />
        <Row label="草尺寸×" value={map.veg.scaleTune.grass} min={0.2} max={3} step={0.05} onChange={(v) => patch({ veg: { scaleTune: { ...map.veg.scaleTune, grass: v } } })} />
        <Row label="草丛数量" value={map.veg.grassCount} min={0} max={200000} step={2000} onChange={(v) => patch({ veg: { grassCount: Math.round(v) } })} />
        <Row label="灌木数量" value={map.veg.bushCount} min={0} max={20000} step={100} onChange={(v) => patch({ veg: { bushCount: Math.round(v) } })} />
      </Section>
      <Section title="城市集群">
        <Toggle label="启用城市" value={map.city.enabled} onChange={(v) => patch({ city: { enabled: v } })} />
        <Row label="城市规模" value={map.city.size} min={2000} max={30000} step={500} onChange={(v) => patch({ city: { size: v } })} />
        <Row label="街区尺寸" value={map.city.blockSize} min={200} max={1200} step={50} onChange={(v) => patch({ city: { blockSize: v } })} />
      </Section>
      <Section title="城市 · 素材编辑(3A)">
        {(['glass', 'office', 'residential', 'landmark'] as const).map((k) => {
          const names: Record<string, string> = { glass: '玻璃塔', office: '办公楼', residential: '住宅', landmark: '地标' };
          const c = map.city.colorTune[k];
          return (
            <div key={k} className="border-t border-slate-800 pt-1">
              <div className="text-[10px] text-slate-500 mb-0.5">{names[k]}</div>
              <ColorRow label="底色" value={c.bg} onChange={(v) => patch({ city: { colorTune: { ...map.city.colorTune, [k]: { ...c, bg: v } } } })} />
              <ColorRow label="窗色" value={c.win} onChange={(v) => patch({ city: { colorTune: { ...map.city.colorTune, [k]: { ...c, win: v } } } })} />
              <Row label="发光强度" value={c.emissiveIntensity} min={0} max={3} step={0.05} onChange={(v) => patch({ city: { colorTune: { ...map.city.colorTune, [k]: { ...c, emissiveIntensity: v } } } })} />
            </div>
          );
        })}
      </Section>
      <Section title="LOD / 流式实验">
        <Toggle label="环形流式模拟" value={map.lod.streaming} onChange={(v) => patch({ lod: { streaming: v } })} />
        <Row label="环宽缩放 lodScale" value={map.lod.lodScale} min={0.5} max={2} step={0.05} onChange={(v) => patch({ lod: { lodScale: v } })} />
        <Row label="强制LOD0半径" value={map.lod.lod0Radius} min={0} max={4} step={0.5} onChange={(v) => patch({ lod: { lod0Radius: v } })} />
        <Toggle label="chunk 边界叠加" value={map.lod.showChunkOverlay} onChange={(v) => patch({ lod: { showChunkOverlay: v } })} />
      </Section>
      <Section title="指数高度雾(FogExp2 距离雾)">
        <ColorRow label="雾颜色" value={params.fog.color} onChange={(v) => patch({ fog: { color: v } })} />
        <Row label="雾密度" value={params.fog.density} min={0} max={0.0005} step={0.000005} onChange={(v) => patch({ fog: { density: v } })} />
      </Section>
      <Section title="指数级高度雾(体积,3A)">
        <Toggle label="启用高度雾" value={params.fog.heightFog.enabled} onChange={(v) => patch({ fog: { heightFog: { ...params.fog.heightFog, enabled: v } } })} />
        {params.fog.heightFog.enabled && (
          <>
            <ColorRow label="雾颜色" value={params.fog.heightFog.color} onChange={(v) => patch({ fog: { heightFog: { ...params.fog.heightFog, color: v } } })} />
            <Row label="浓度 opacity" value={params.fog.heightFog.opacity} min={0} max={1} step={0.02} onChange={(v) => patch({ fog: { heightFog: { ...params.fog.heightFog, opacity: v } } })} />
            <Row label="所在高度" value={params.fog.heightFog.baseHeight} min={-2000} max={8000} step={10} fmt={(v) => `${v}m`} onChange={(v) => patch({ fog: { heightFog: { ...params.fog.heightFog, baseHeight: v } } })} />
            <Row label="衰减范围 falloff" value={params.fog.heightFog.falloff} min={20} max={4000} step={10} fmt={(v) => `${v}m`} onChange={(v) => patch({ fog: { heightFog: { ...params.fog.heightFog, falloff: v } } })} />
            <Row label="生效距离" value={params.fog.heightFog.startDistance} min={0} max={20000} step={100} fmt={(v) => `${v}m`} onChange={(v) => patch({ fog: { heightFog: { ...params.fog.heightFog, startDistance: v } } })} />
            <Row label="最大距离(淡出)" value={params.fog.heightFog.fadeEnd} min={2000} max={60000} step={500} fmt={(v) => `${v}m`} onChange={(v) => patch({ fog: { heightFog: { ...params.fog.heightFog, fadeEnd: v } } })} />
            <div className="text-[10px] text-slate-500">高度轮廓:≤所在高度全浓,向上按衰减范围指数淡出;近处/远处距离淡入淡出。</div>
            {/* === 大气透视(v3, §252): 方向性内散射 + 空气光对比度衰减。编辑器预览不跑
                游戏那条屏幕空间 pass, 所以下面四项**改了预览不动是正常的** —— 导出 tune 后进游戏生效
                (或进关卡用控制台 `hfog sun|pow|desat|glow <v>` 实时调)。 */}
            <div className="mt-1 text-[10px] text-amber-500/80">大气透视(仅游戏内生效, 预览不变):</div>
            <Row label="阳光散射 sunScatter" value={params.fog.heightFog.sunScatter} min={0} max={1} step={0.05} onChange={(v) => patch({ fog: { heightFog: { ...params.fog.heightFog, sunScatter: v } } })} />
            <Row label="前向散射尖锐度 sunPow" value={params.fog.heightFog.sunPow} min={1} max={12} step={0.5} onChange={(v) => patch({ fog: { heightFog: { ...params.fog.heightFog, sunPow: v } } })} />
            <Row label="对比度衰减 desat" value={params.fog.heightFog.desat} min={0} max={1} step={0.05} onChange={(v) => patch({ fog: { heightFog: { ...params.fog.heightFog, desat: v } } })} />
            <Row label="雾的微光 sunGlow" value={params.fog.heightFog.sunGlow} min={0} max={1} step={0.05} onChange={(v) => patch({ fog: { heightFog: { ...params.fog.heightFog, sunGlow: v } } })} />
          </>
        )}
      </Section>
      <Section title="天空与太阳">
        <SelectRow label="天空预设" value={params.sky.preset} options={[['day', '白天'], ['sunset', '日落'], ['dawn', '黎明'], ['storm', '风暴'], ['night', '夜晚']]} onChange={(v) => patch({ sky: { preset: v as never } })} />
        <SelectRow label="天气" value={params.sky.weather} options={[['clear', '晴朗'], ['cloudy', '多云'], ['rain', '雨'], ['storm', '暴风'], ['fog', '雾天'], ['snow', '雪']]} onChange={(v) => patch({ sky: { weather: v } })} />
        <Row label="太阳方位角" value={params.sky.sunAzimuth} min={0} max={360} step={1} fmt={(v) => `${v}°`} onChange={(v) => patch({ sky: { sunAzimuth: v } })} />
        <Row label="太阳仰角" value={params.sky.sunElevation} min={-10} max={90} step={1} fmt={(v) => `${v}°`} onChange={(v) => patch({ sky: { sunElevation: v } })} />
        <Row label="太阳强度" value={params.sky.sunIntensity} min={0.1} max={5} step={0.05} onChange={(v) => patch({ sky: { sunIntensity: v } })} />
        <Row label="环境光强度" value={params.sky.ambientIntensity} min={0.05} max={2} step={0.05} onChange={(v) => patch({ sky: { ambientIntensity: v } })} />
        <Row label="曝光 exposure" value={params.sky.toneExposure} min={0.2} max={2.5} step={0.02} onChange={(v) => patch({ sky: { toneExposure: v } })} />
      </Section>
      <Section title="画质">
        <Toggle label="Bloom" value={params.quality.bloom} onChange={(v) => patch({ quality: { bloom: v } })} />
        <Row label="Bloom 强度" value={params.quality.bloomStrength} min={0} max={2} step={0.05} onChange={(v) => patch({ quality: { bloomStrength: v } })} />
        <SelectRow label="贴图质量" value={params.quality.textureQuality} options={[['low', '低'], ['medium', '中'], ['high', '高']]} onChange={(v) => patch({ quality: { textureQuality: v as never } })} />
      </Section>
      <Section title="场景阴影(3A)">
        <Toggle label="阴影开关" value={params.quality.shadows.enabled} onChange={(v) => patch({ quality: { shadows: { ...params.quality.shadows, enabled: v } } })} />
        <SelectRow label="阴影分辨率" value={String(params.quality.shadows.resolution)} options={[['1024', '1024(快)'], ['2048', '2048'], ['4096', '4096(精细)']]} onChange={(v) => patch({ quality: { shadows: { ...params.quality.shadows, resolution: parseInt(v, 10) as never } } })} />
        <Row label="阴影软度" value={params.quality.shadows.softness} min={0} max={2} step={0.05} onChange={(v) => patch({ quality: { shadows: { ...params.quality.shadows, softness: v } } })} />
      </Section>
      {actor && (
        <Section title="选中物体">
          <div className="text-[11px] text-slate-300">
            <div>{actor.name} <span className="text-slate-500">({actor.def})</span></div>
            <div className="text-slate-500">位置 {(actor.position.map((v) => v.toFixed(0))).join(', ')}</div>
            <div className="text-slate-500 mt-1">变换:选中后拖 gizmo,或按 W(移动)/E(旋转)/R(缩放)</div>
          </div>
        </Section>
      )}
    </div>
  );
}

// ---------- 大纲 + 资产库 ----------
function Outliner({ world, actors, selectedId, placement, setPlacement, onSelect }: {
  world: EditorWorld;
  actors: EditorActor[];
  selectedId: string | null;
  placement: string | null;
  setPlacement: (d: string | null) => void;
  onSelect: (id: string | null) => void;
}) {
  const cats = Array.from(new Set(PALETTE.map((p) => p.category)));
  return (
    <div className="flex-1 overflow-y-auto p-2 space-y-2 bg-slate-950/90 text-slate-200">
      <div className="text-[11px] font-semibold text-cyan-400">资产库(点选后左键放置,Esc 取消)</div>
      <div className="grid grid-cols-2 gap-1">
        {cats.map((cat) => (
          <div key={cat} className="col-span-2">
            <div className="text-[10px] text-slate-500 mb-0.5">{cat}</div>
            <div className="grid grid-cols-2 gap-1">
              {PALETTE.filter((p) => p.category === cat).map((p) => (
                <button key={p.def}
                  className={`text-left text-[10px] px-1.5 py-1 rounded border ${placement === p.def ? 'border-[#9dffb0] bg-emerald-900/40 text-[#9dffb0]' : 'border-slate-700 hover:border-slate-500 text-slate-300'}`}
                  onClick={() => setPlacement(placement === p.def ? null : p.def)}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="text-[11px] font-semibold text-cyan-400 pt-1">场景大纲</div>
      {actors.length === 0 && <div className="text-[10px] text-slate-600">(空)</div>}
      {actors.map((a) => (
        <div key={a.id} className={`flex items-center gap-1 text-[11px] px-1 py-0.5 rounded cursor-pointer ${selectedId === a.id ? 'bg-cyan-900/50 text-cyan-200' : 'hover:bg-slate-800 text-slate-300'}`}
          onClick={() => onSelect(a.id)}>
          <span className="flex-1 truncate">{a.name}</span>
          <button className="text-slate-500 hover:text-red-400" title="删除"
            onClick={(e) => { e.stopPropagation(); world.select(a.id); world.deleteSelected(); }}>✕</button>
        </div>
      ))}
    </div>
  );
}

// ---------- 主组件 ----------
/** f32bin → base64(分段,避免超大字符串爆栈)。 */
function btoaChunk(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CH = 0x8000;
  let out = '';
  for (let i = 0; i < bytes.length; i += CH) {
    out += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(out);
}

export function EditorApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<EditorWorld | null>(null);
  const [worldReady, setWorldReady] = useState(false);
  const [params, setParams] = useState<EditorParams>(() => {
    try {
      const ls = typeof localStorage !== 'undefined' ? localStorage.getItem(PROJECT_LS_KEY) : null;
      if (ls) {
        const raw = JSON.parse(ls);
        if (raw?.params) return parseEditorParams(JSON.stringify(raw.params));
      }
    } catch { /* 忽略坏项目 */ }
    return defaultEditorParams();
  });
  const [actors, setActors] = useState<EditorActor[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [placement, setPlacement] = useState<string | null>(null);
  const [stats, setStats] = useState<EditorStats | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [gaeaOpen, setGaeaOpen] = useState(false);
  // === Mask 手绘笔刷(per user request: 遮罩手动绘制通道) ===
  const [brush, setBrush] = useState<{ channel: number | null; radius: number; strength: number }>({ channel: null, radius: 1000, strength: 0.6 });
  const paintingRef = useRef(false);
  const brushRef = useRef(brush);
  brushRef.current = brush;
  const actorsRef = useRef<EditorActor[]>([]);
  actorsRef.current = actors;

  // 选笔刷而当前是自动分层 → 自动切遮罩模式(世界侧会自动生成初始遮罩)
  useEffect(() => {
    const w = worldRef.current;
    if (!w) return;
    const wantBrush = brush.channel !== null;
    if (wantBrush && !w.params.maps[w.params.mapType].material.maskMode) {
      w.applyPatch({ material: { maskMode: true } });
      setParams({ ...w.params });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brush.channel, params.mapType]);

  // world 生命周期
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const world = new EditorWorld(canvas, defaultEditorParams(), {
      onProgress: (label) => setProgress(label ?? null),
      onStats: setStats,
      onSelectionChanged: (a) => setSelectedId(a?.id ?? null),
    });
    worldRef.current = world;
    // 恢复 localStorage 项目(参数 + 遮罩 + 放置物)
    (async () => {
      try {
        const ls = localStorage.getItem(PROJECT_LS_KEY);
        if (ls) {
          const raw = JSON.parse(ls);
          if (raw?.params) {
            world.params = parseEditorParams(JSON.stringify(raw.params));
            setParams(world.params);
            await restoreProjectMasks(world.params);
            world.switchMap(world.params.mapType);
            void world.rebuildWorld(false);
          }
          if (Array.isArray(raw?.actors)) {
            setActors(raw.actors);
            void world.loadActors(raw.actors);
          }
        }
      } catch { /* 忽略 */ }
      setWorldReady(true);
    })();

    let raf = 0;
    let last = performance.now();
    const loop = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      world.render(dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      world.dispose();
      worldRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 键盘
  useEffect(() => {
    const w = () => worldRef.current;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
      const world = w();
      if (!world) return;
      world.flyCam.onKeyDown(e.code);
      // 变换模式(有选中物时)
      if (world.gizmo.hasObject) {
        if (e.code === 'KeyW') world.gizmo.setMode('translate');
        if (e.code === 'KeyE') world.gizmo.setMode('rotate');
        if (e.code === 'KeyR') world.gizmo.setMode('scale');
      }
      if (e.code === 'Delete' && world.gizmo.hasObject) { world.deleteSelected(); }
      if (e.code === 'Escape') { setPlacement(null); world.select(null); }
    };
    const onKeyUp = (e: KeyboardEvent) => { worldRef.current?.flyCam.onKeyUp(e.code); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // 鼠标:右键环视 / 左键放置或选择 / 遮罩笔刷绘制
  const toNdc = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * 2 - 1,
      y: -(((e.clientY - r.top) / r.height) * 2 - 1),
    };
  };
  const paintAt = (e: React.MouseEvent) => {
    const w = worldRef.current;
    const b = brushRef.current;
    if (!w || b.channel === null) return;
    const ndc = toNdc(e);
    w.paintAtPointer(ndc.x, ndc.y, b.channel, b.radius, b.strength);
  };
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const world = worldRef.current;
    if (!world) return;
    if (e.button === 2) {
      world.flyCam.onMouseDown(e.clientX, e.clientY);
      return;
    }
    if (e.button === 0) {
      if (brushRef.current.channel !== null && !placement) {
        paintingRef.current = true;
        paintAt(e);
        return;
      }
      if (placement) {
        void world.placeFromPalette(placement).then((a) => {
          if (a) setActors([...world.actors.actors]);
        });
      }
    }
  }, [placement]);
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const world = worldRef.current;
    if (!world) return;
    if (paintingRef.current && brushRef.current.channel !== null) {
      paintAt(e);
      return;
    }
    world.flyCam.onMouseMove(e.clientX, e.clientY);
  }, []);
  const onMouseUp = useCallback(() => {
    paintingRef.current = false;
    worldRef.current?.flyCam.onMouseUp();
  }, []);
  const onWheel = useCallback((e: React.WheelEvent) => {
    worldRef.current?.flyCam.onWheel(e.deltaY);
  }, []);
  const onCtx = useCallback((e: React.MouseEvent) => e.preventDefault(), []);

  // 项目保存 / 载入 / 导出
  /** 把世界里的遮罩画布导出成 png dataURL 并入 params(保存/导出前调用)。 */
  const snapshotMasks = (base: EditorParams): EditorParams => {
    const w = worldRef.current;
    if (!w) return base;
    const next = { ...base, masks: { ...base.masks } };
    for (const m of EDITOR_MAP_TYPES) {
      const png = w.maskPngDataUrl(m);
      if (png) next.masks[m] = { ...next.masks[m], png };
    }
    return next;
  };
  /** 恢复项目 JSON 里的遮罩 PNG(重建前调用)。 */
  const restoreProjectMasks = async (base: EditorParams) => {
    const w = worldRef.current;
    if (!w) return;
    for (const m of EDITOR_MAP_TYPES) {
      const png = base.masks?.[m]?.png;
      if (png) {
        try {
          await w.restoreMaskPng(m, png, base.masks[m].res, base.maps[m].terrain.size);
        } catch { /* 坏图忽略 */ }
      }
    }
  };
  const saveProject = () => {
    const world = worldRef.current;
    const p = snapshotMasks(params);
    const doc = { params: p, actors: world ? world.actors.serialize() : actorsRef.current };
    localStorage.setItem(PROJECT_LS_KEY, JSON.stringify(doc));
    download('skybound-editor-project.json', JSON.stringify(doc, null, 2));
    setMsg('项目已保存(localStorage + 下载,含遮罩)');
  };
  const exportTune = () => {
    const world = worldRef.current;
    if (!world) return;
    const p = snapshotMasks(params);
    const doc = exportTuneDoc(p);
    // === Gaea 外部高度包附加(per user request: 自定义槽导出) ===
    // 小包(<2MB)内嵌 bytesBase64(file:// 单文件可用);大包提示外置目录。
    let bigPacks: string[] = [];
    for (const m of EDITOR_MAP_TYPES) {
      const ext = world.externalPackOf(m);
      const meta = p.maps[m].external;
      if (!ext || !meta?.active) continue;
      const { grid } = ext;
      const bytes = encodeF32Bin(grid.data);
      const eh: { kind: 'f32bin'; size: number; resX: number; resY: number; maxHeight?: number; bytesBase64?: string; url?: string } = {
        kind: 'f32bin',
        size: grid.size,
        resX: grid.resX,
        resY: grid.resY,
        maxHeight: grid.maxHeight,
      };
      if (bytes.byteLength <= 2 * 1024 * 1024) {
        const b64 = btoaChunk(bytes);
        eh.bytesBase64 = b64;
      } else {
        const url = `/custom-maps/${meta.name}/heights.f32bin`;
        eh.url = url;
        bigPacks.push(`${meta.name}(${Math.round(bytes.byteLength / 1024 / 1024)}MB → ${url})`);
      }
      ((doc.maps[m] as unknown as { terrain: Record<string, unknown> }).terrain).externalHeight = eh;
    }
    localStorage.setItem(TUNE_LS_KEY, JSON.stringify(doc));
    download('terrain-tune.json', JSON.stringify(doc, null, 2));
    setMsg(bigPacks.length
      ? `已导出 terrain-tune.json。注意:大包未内嵌,需把 ${bigPacks.join('、')} 放到 public/custom-maps/ 并重建(单文件 file:// 建议用 512² 高度以内的小包)`
      : '已导出 terrain-tune.json(遮罩与外部高度已嵌入)。融合:覆盖 public/config/terrain-tune.json 后重建');
  };
  // === 一键测试「004 已导入地形」(per user request: 专门选项) ===
  // 读取 public/config/terrain-tune.json 的 maps.custom(gaea-import 写入的
  // 004 Gaea 地形(四件套 PNG 打包):externalHeight f32bin + material.colorMap)→ 挂 custom 槽
  // 外部包并全盘 Gaea 渲染(mixNear/mixFar=0,与游戏 m13 一致)。
  const loadGaea004 = async () => {
    const world = worldRef.current;
    if (!world) return;
    setMsg(null);
    setProgress('加载 004 测试地形…');
    try {
      const tuneRes = await fetch(assetUrl('/config/terrain-tune.json'));
      if (!tuneRes.ok) throw new Error('terrain-tune.json 读取失败');
      const tune = await tuneRes.json();
      const mc = tune?.maps?.custom;
      const eh = mc?.terrain?.externalHeight;
      if (!eh?.url) throw new Error('custom 槽缺 externalHeight.url —— 请先跑 scripts/gaea-png-pack.mjs 导入 004');
      const manifest = (window as unknown as { __ASSET_MANIFEST?: Record<string, string> }).__ASSET_MANIFEST;
      // === 复用运行期加载器(与游戏同一条路径) ===
      // 它同时处理 kind='f32bin' 与 'f32bin-gzip'(高度场 gzip,单文件省 20MB)
      // —— 以前这里直接 decodeF32Bin,遇到 .gz 会解出错误尺寸。
      const grid: HeightGrid = await loadExternalHeight({
        kind: eh.kind,
        size: eh.size ?? 48600,
        resX: eh.resX ?? 1024,
        resY: eh.resY ?? 1024,
        maxHeight: eh.maxHeight ?? 4320,
        url: eh.url,
      });
      // === 图层独立对齐(per user request: 四贴图分开调) ===
      // 优先级:编辑器手工修正(world.params)> tune 存的对齐(mc.transform);
      // 手工调整会写回 world.params,下次打开无修正时自动用 tune 的。
      const Tf = world.params.maps?.custom?.transform ?? mc?.transform ?? {};
      const tfH = Tf.height, tfC = Tf.color, tfN = Tf.normal, tfA = Tf.ao;
      if (tfH && (tfH.rot || tfH.flipX || tfH.flipY)) {
        grid.data = applyGridTransform(grid.data, grid.resX, tfH);
      }
      // 色图 → SRGB CanvasTexture(与游戏 resolveColorMap 同语义)
      let vtx: { tex: THREE.CanvasTexture; canonical: [number, number, number][] } | undefined;
      const cm = mc?.material?.colorMap as string | undefined;
      if (cm) {
        const cRes = await fetch(manifest?.[cm] ?? cm);
        if (cRes.ok) {
          const bmp = await createImageBitmap(await cRes.blob());
          let canvas = document.createElement('canvas');
          canvas.width = bmp.width; canvas.height = bmp.height;
          canvas.getContext('2d')!.drawImage(bmp, 0, 0);
          bmp.close();
          if (tfC && (tfC.rot || tfC.flipX || tfC.flipY)) canvas = transformImageToCanvas(canvas, tfC);
          const tex = new THREE.CanvasTexture(canvas);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
          tex.anisotropy = 8;
          tex.needsUpdate = true;
          vtx = { tex, canonical: DEFAULT_CANONICAL };
        }
      }
      // 法线贴图(004 高度场烘焙,tangent-space,数据通道不能走 SRGB)
      let normalTex: THREE.Texture | undefined;
      const nmUrl = mc?.material?.normalMap as string | undefined;
      if (nmUrl) {
        try {
          const nRes = await fetch(manifest?.[nmUrl] ?? nmUrl);
          if (nRes.ok) {
            const nBmp = await createImageBitmap(await nRes.blob());
            let nCanvas = document.createElement('canvas');
            nCanvas.width = nBmp.width; nCanvas.height = nBmp.height;
            nCanvas.getContext('2d')!.drawImage(nBmp, 0, 0);
            nBmp.close();
            if (tfN && (tfN.rot || tfN.flipX || tfN.flipY)) nCanvas = transformImageToCanvas(nCanvas, tfN);
            const nTex = new THREE.CanvasTexture(nCanvas);
            nTex.colorSpace = THREE.NoColorSpace;
            nTex.wrapS = nTex.wrapT = THREE.ClampToEdgeWrapping;
            nTex.anisotropy = 8;
            nTex.needsUpdate = true;
            normalTex = nTex;
          }
        } catch { /* 无法线贴图时程序 relief 兜底 */ }
      }
      // 外部 AO(004 Gaea AOExport 世界域灰图;数据通道不走 SRGB)
      let aoTex: THREE.Texture | undefined;
      const aoUrl = mc?.material?.aoMap as string | undefined;
      if (aoUrl) {
        try {
          const aRes = await fetch(manifest?.[aoUrl] ?? aoUrl);
          if (aRes.ok) {
            const aBmp = await createImageBitmap(await aRes.blob());
            let aCanvas = document.createElement('canvas');
            aCanvas.width = aBmp.width; aCanvas.height = aBmp.height;
            aCanvas.getContext('2d')!.drawImage(aBmp, 0, 0);
            aBmp.close();
            if (tfA && (tfA.rot || tfA.flipX || tfA.flipY)) aCanvas = transformImageToCanvas(aCanvas, tfA);
            const aTex = new THREE.CanvasTexture(aCanvas);
            aTex.colorSpace = THREE.NoColorSpace;
            aTex.wrapS = aTex.wrapT = THREE.ClampToEdgeWrapping;
            aTex.anisotropy = 8;
            aTex.needsUpdate = true;
            aoTex = aTex;
          }
        } catch { /* 无 AO 时间接光不改动 */ }
      }
      world.setExternalPack('custom', grid, vtx, normalTex, aoTex);
      const p: EditorParams = structuredClone(world.params);
      p.maps.custom.terrain.size = grid.size;
      p.maps.custom.external = {
        active: true, size: grid.size, heightScale: 1, seaLevel: 0,
        maskRes: 1024, mixNear: 0, mixFar: 0, canonical: DEFAULT_CANONICAL,
        name: 'custom-004',
      };
      p.mapType = 'custom';
      setParams(p);
      world.params = p;
      await world.rebuildWorld(false);
      // [004] 加载后镜头飞到主峰上方俯瞰(Gaea 群系位置=世界中央 ±size/2)
      try {
        world.flyCam.camera.position.set(0, 7000, 6000);
        world.flyCam.lookAt(new THREE.Vector3(0, 1600, 0));
      } catch { /* 相机不可用忽略 */ }
      // [004] 强制明亮白昼天空:编辑器 localStorage 可能存过暗天色项目,
      // 覆盖它,确保 004 PBR 色图在充足光照下验收(仍可随时改右侧光照)。
      try {
        world.applyPatch({
          sky: {
            preset: 'day', weather: 'clear', sunAzimuth: 135, sunElevation: 45,
            sunIntensity: 3.2, ambientIntensity: 0.95, toneExposure: 1.6,
          },
        });
        setParams({ ...world.params });
      } catch { /* 天空 patch 失败忽略 */ }
      const mb = (grid.data.length * 4 / 1048576).toFixed(1);
      setMsg(`已加载 004 测试地形:${grid.resX}×${grid.resY} 高度(${mb}MB) · 基础色 ${vtx ? '✓' : '—'} · 法线 ${normalTex ? '✓' : '—'} · AO ${aoTex ? '✓' : '—'} · PBR(mix 0/0) · ${alignLayerLabel(alignLayerRef.current)}对齐 ${tfOf(world.params.maps?.custom?.transform)}`);
    } catch (e) {
      setMsg('加载 004 失败:' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setProgress(null);
    }
  };
  // === 图层对齐(per user request: 四贴图独立调试) ===
  // 选中图层(高度/基础色/法线/AO)单独旋转/镜像;每层独立写入
  // maps.custom.transform.<layer>(与游戏 tune 同构);重跑 loadGaea004。
  const [alignLayer, setAlignLayer] = useState<'height' | 'color' | 'normal' | 'ao'>('height');
  const alignLayerRef = useRef(alignLayer);
  alignLayerRef.current = alignLayer;
  const ALIGN_LAYERS: { key: 'height' | 'color' | 'normal' | 'ao'; label: string }[] = [
    { key: 'height', label: '高度' }, { key: 'color', label: '基础色' },
    { key: 'normal', label: '法线' }, { key: 'ao', label: 'AO' },
  ];
  type LayerT = { rot?: number; flipX?: boolean; flipY?: boolean };
  const alignLayerLabel = (k: 'height' | 'color' | 'normal' | 'ao'): string =>
    ALIGN_LAYERS.find((a) => a.key === k)?.label ?? k;
  const alignTf = (mut: (t: NonNullable<LayerT>) => void) => {
    const w = worldRef.current;
    if (!w) return;
    const layer = alignLayerRef.current;
    const p2: EditorParams = structuredClone(w.params);
    const tr = p2.maps.custom.transform ?? (p2.maps.custom.transform = {});
    const t = tr[layer] ?? (tr[layer] = {});
    mut(t);
    setParams(p2);
    w.params = p2;
    void loadGaea004();
  };
  const tfOf = (t: Partial<Record<'height' | 'color' | 'normal' | 'ao', LayerT>> | undefined): string => {
    if (!t) return '0°';
    const cur = t[alignLayerRef.current];
    if (!cur) return '0°';
    return (cur.rot ?? 0) + '°' + (cur.flipX ? '/X' : '') + (cur.flipY ? '/Y' : '');
  };
  const resetAll = () => {
    const fresh = defaultEditorParams();
    localStorage.removeItem(PROJECT_LS_KEY);
    setParams(fresh);
    const world = worldRef.current;
    if (world) {
      world.params = fresh;
      void world.rebuildWorld(false);
    }
    setMsg('已重置默认');
  };
  const onImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    void f.text().then(async (text) => {
      try {
        const doc = JSON.parse(text);
        const p = doc?.params ? parseEditorParams(JSON.stringify(doc.params)) : parseEditorParams(text);
        setParams(p);
        const world = worldRef.current;
        if (world) {
          world.params = p;
          await restoreProjectMasks(p);
          void world.rebuildWorld(false);
          if (Array.isArray(doc?.actors)) {
            setActors(doc.actors);
            void world.loadActors(doc.actors);
          }
        }
        setMsg('项目已导入(含遮罩)');
      } catch {
        setMsg('导入失败:JSON 不合法');
      }
    });
  };

  const mapLabel: Record<EditorMapType, string> = { mountain: '山岳', desert: '荒漠', archipelago: '群岛', custom: '自定义' };

  return (
    <div className="fixed inset-0 bg-black text-slate-200 select-none flex flex-col">
      {/* 顶栏 */}
      <div className="h-10 flex items-center gap-2 px-3 bg-slate-900 border-b border-slate-800 text-[12px] shrink-0">
        <span className="font-bold text-cyan-400 mr-1">地形编辑器</span>
        {EDITOR_MAP_TYPES.map((m) => (
          <button key={m}
            className={`px-2 py-1 rounded ${params.mapType === m ? 'bg-cyan-800 text-cyan-100' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'}`}
            onClick={() => {
              const world = worldRef.current;
              setParams({ ...params, mapType: m });
              world?.switchMap(m);
            }}>
            {mapLabel[m]}
          </button>
        ))}
        <div className="flex-1" />
        <button className="px-2 py-1 rounded bg-violet-800 hover:bg-violet-700 text-violet-100"
          onClick={() => void loadGaea004()}
          title="读取 terrain-tune.json 的 maps.custom(004 已导入资产)并全盘 Gaea 预览">
          ▶ 测试 004 导入地形
        </button>
        <span className="text-slate-500 text-[10px]">对齐 {tfOf(worldRef.current?.params.maps?.custom?.transform)}</span>
        {ALIGN_LAYERS.map(({ key, label }) => (
          <button key={key}
            className={`px-1.5 py-1 rounded text-[11px] ${alignLayer === key ? 'bg-fuchsia-800 text-fuchsia-100' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'}`}
            onClick={() => setAlignLayer(key)}>{label}</button>
        ))}
        <button className="px-2 py-1 rounded bg-cyan-900 hover:bg-cyan-700 text-cyan-100 text-[11px]"
          title="顺时针 90°(黄色湖应对准高度最低处)"
          onClick={() => alignTf((t) => { t.rot = (((t.rot ?? 0) + 90) % 360); })}>↻90°</button>
        <button className="px-2 py-1 rounded bg-cyan-900 hover:bg-cyan-700 text-cyan-100 text-[11px]"
          onClick={() => alignTf((t) => { t.flipX = !t.flipX; })}>⇋X</button>
        <button className="px-2 py-1 rounded bg-cyan-900 hover:bg-cyan-700 text-cyan-100 text-[11px]"
          onClick={() => alignTf((t) => { t.flipY = !t.flipY; })}>⇅Y</button>
        <button className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-[11px]" title="恢复该层原始方向"
          onClick={() => alignTf((t) => { t.rot = 0; t.flipX = false; t.flipY = false; })}>复位</button>
        <label className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 cursor-pointer">导入项目
          <input type="file" accept=".json" className="hidden" onChange={onImportFile} />
        </label>
        <button className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700" onClick={saveProject}>保存项目</button>
        <button className="px-2 py-1 rounded bg-emerald-800 hover:bg-emerald-700 text-emerald-100" onClick={exportTune}>导出 terrain-tune.json</button>
        <button className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700" onClick={resetAll}>重置</button>
        <button className="px-2 py-1 rounded bg-amber-900/80 hover:bg-amber-800 text-amber-100" onClick={() => setGaeaOpen(true)}>Gaea 导入</button>
      </div>
      {msg && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-20 bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-[11px] text-emerald-200"
          onClick={() => setMsg(null)}>{msg}(点此关闭)</div>
      )}
      {progress && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-20 bg-slate-800 border border-cyan-700 rounded px-3 py-1.5 text-[11px] text-cyan-200 animate-pulse">
          {progress} …
        </div>
      )}
      <GaeaImportDialog
        open={gaeaOpen}
        onClose={() => setGaeaOpen(false)}
        world={worldRef.current}
        params={params}
        setParams={(p) => {
          setParams(p);
          const w = worldRef.current;
          if (w) w.params = p;
        }}
        notify={setMsg}
      />

      {/* 主体 */}
      <div className="flex-1 flex min-h-0">
        {/* 左侧:大纲 */}
        <div className="w-56 shrink-0 flex flex-col border-r border-slate-800">
          {worldReady && (
            <Outliner
              world={worldRef.current!}
              actors={actors}
              selectedId={selectedId}
              placement={placement}
              setPlacement={setPlacement}
              onSelect={(id) => worldRef.current?.select(id)}
            />
          )}
        </div>
        {/* 视口 */}
        <div className="flex-1 relative">
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full"
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onWheel={onWheel}
            onContextMenu={onCtx}
          />
          {/* HUD */}
          {stats && (
            <div className="absolute bottom-2 left-2 bg-slate-950/70 rounded px-2 py-1 text-[10px] text-slate-400 pointer-events-none leading-4">
              <div className="text-[#9dffb0]">{stats.fps.toFixed(0)} FPS · {stats.drawCalls} calls · {(stats.triangles / 1000).toFixed(0)}k tris</div>
              <div>chunks {stats.visibleChunks}/{stats.totalChunks} · instanced {stats.instanced} · VRAM {stats.vramMB.toFixed(0)}MB</div>
              <div>相机 {stats.camSpeed.toFixed(0)} u/s(滚轮调速,Shift×3,右键环视,WASD+QE 飞行)</div>
              {placement && <div className="text-emerald-300">放置模式:左键放置</div>}
              {brush.channel !== null && (
                <div className="text-cyan-300">
                  遮罩绘制中:通道 {['低地', '草', '岩', '雪'][brush.channel]} · 半径 {brush.radius}m · 按住左键在地形上刷(命中即写遮罩)
                </div>
              )}
            </div>
          )}
        </div>
        {/* 右侧:Inspector */}
        <div className="w-72 shrink-0 flex flex-col border-l border-slate-800">
          {worldReady && (
            <Inspector
              world={worldRef.current!}
              params={params}
              setParams={setParams}
              actor={actors.find((a) => a.id === selectedId) ?? null}
              brush={brush}
              onBrush={setBrush}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function download(name: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
