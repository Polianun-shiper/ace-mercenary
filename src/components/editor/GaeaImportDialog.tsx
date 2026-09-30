// === Gaea 预制地形导入窗口 (per user request: 独立处理窗口 + 自动流程) ===
// 多步向导(编辑器内 overlay):
//   素材:16-bit 灰度 PNG 高度 / EXR 高度 / 顶点色 OBJ / 内置样例
//   → 参数(世界尺寸/单位-米换算/海面偏移)
//   → 一键「导入到自定义槽」:顶点色软分类→RGBA 遮罩(与既有遮罩通道一致,
//     空格由相对分带兜底)+ 顶点色图 → 挂到 EditorWorld(custom)→ 重建预览;
//   → 导出 terrain-tune 时高度包内嵌/外置(EditorApp 负责附加)。
// ⚠ 本文窗口面向旧「OBJ 顶点色 + 程序遮罩」工作流;Gaea GUI 导出的 PBR
//   四贴图(HeightmapExport/ColorExport/AOExport/NormalsExport)用顶栏
//   「▶ 测试 004」按钮 —— 自动按文件名识别为 高度/基础色/AO/法线 全挂载。
'use client';

import { useCallback, useRef, useState } from 'react';
import * as THREE from 'three';
import type { EditorWorld } from '@/lib/editor/editor-world';
import type { EditorParams } from '@/lib/editor/editor-params';
import type { HeightGrid } from '@/lib/terrain-import/height-source';
import {
  DEFAULT_CANONICAL, rasterVertexColorMask, fillMaskGaps,
  type VertexColorPt,
} from '@/lib/terrain-import/classify';
import { buildExternalHeightAt } from '@/lib/terrain-import/height-source';
import { REL_ANCHORS } from '@/lib/game/terrain-bands';
import { getMwamStyleCfg } from '@/lib/game/pbr/terrain-mwam';
import { decodePngGray16, decodeExrHeight, parseObjVertices, makeGaeaSample } from '@/lib/editor/gaea-import-decode';

interface RawSrc {
  /** 归一/原值高度行主序;w/h 像素数 */
  u: Float32Array;
  w: number;
  h: number;
  /** true = 值已是米(EXR/样例);false = 0..1 需 amp 放大 */
  meters: boolean;
  label: string;
}

function Row({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-slate-300">
      <span className="w-24 shrink-0">{label}</span>
      <input type="range" className="flex-1 h-1 accent-[#9dffb0]" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
      <input type="number" className="w-16 bg-slate-800 rounded px-1 py-0.5 text-right" value={value} min={min} max={max} step={step} onChange={(e) => onChange(parseFloat(e.target.value))} />
    </div>
  );
}

export function GaeaImportDialog(props: {
  open: boolean;
  onClose: () => void;
  world: EditorWorld | null;
  params: EditorParams;
  setParams: (p: EditorParams) => void;
  notify: (msg: string) => void;
}) {
  const { open, onClose, world, params, setParams, notify } = props;
  const [busy, setBusy] = useState(false);
  const [src, setSrc] = useState<RawSrc | null>(null);
  const [verts, setVerts] = useState<VertexColorPt[] | null>(null);
  const [size, setSize] = useState(48600);
  const [amp, setAmp] = useState(2000);       // 0..1 → 米 幅度
  const [offset, setOffset] = useState(0);     // 海面/基准偏移(米)
  const [maskRes, setMaskRes] = useState<512 | 1024 | 2048>(2048);
  const [mixNear, setMixNear] = useState(1400);
  const [mixFar, setMixFar] = useState(3400);
  const [packName, setPackName] = useState('gaea-custom');
  const heightRef = useRef<HTMLInputElement>(null);
  const objRef = useRef<HTMLInputElement>(null);

  const loadSample = useCallback(() => {
    const s = makeGaeaSample(Math.floor(Math.random() * 1e5));
    setSrc({ u: s.heights, w: s.res, h: s.res, meters: true, label: '内置样例(ridge 山地)' });
    setVerts(s.verts);
    setSize(s.size);
    notify('样例已载入:高度 + 顶点色;点「导入到自定义槽」预览');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onHeightFile = useCallback(async (f: File) => {
    try {
      setBusy(true);
      if (/\.exr$/i.test(f.name)) {
        const r = await decodeExrHeight(f);
        setSrc({ u: r.data, w: r.w, h: r.h, meters: true, label: `EXR ${f.name}` });
        notify('EXR 高度已解码(视为米;如文件是 0..1 请把幅度当系数)');
      } else {
        const r = await decodePngGray16(f);
        setSrc({ u: r.data, w: r.w, h: r.h, meters: false, label: `PNG-${r.bitDepth} ${f.name}` });
        notify('16/8-bit 灰度高度已解码(0..1 → 米 = 值×幅度+偏移)');
      }
    } catch (e) {
      notify('高度解码失败:' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onObjFile = useCallback(async (f: File) => {
    try {
      setBusy(true);
      const text = await f.text();
      const pts = parseObjVertices(text);
      if (!pts.length) throw new Error('OBJ 无顶点');
      setVerts(pts);
      notify(`OBJ 顶点色:${pts.length} 顶点(坐标按米计,自动居中于自定义槽)`);
    } catch (e) {
      notify('OBJ 解析失败:' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 执行导入:生成高度网格 + 遮罩 + 顶点色图 → 挂 world → 重建 custom 槽 */
  const runImport = useCallback(async () => {
    if (!src || !world) return;
    setBusy(true);
    try {
      // 1) 米制高度网格(降/升采样到 w×h 原分辨率?几何采样器任意网格均可)
      const data = new Float32Array(src.u.length);
      const m = src.meters ? 1 : amp;
      for (let i = 0; i < src.u.length; i++) data[i] = src.u[i] * m + offset;
      const grid: HeightGrid = { data, size, resX: src.w, resY: src.h, maxHeight: 0 };
      let mx = -Infinity;
      for (let i = 0; i < data.length; i++) if (data[i] > mx) mx = data[i];
      grid.maxHeight = mx;
      const heightAt = buildExternalHeightAt(grid);

      // 2) 顶点色 → RGBA 遮罩 + 顶点色世界图(custom 槽,统一 ±size/2)
      const res = maskRes;
      const canonical = DEFAULT_CANONICAL;
      let mask: Uint8ClampedArray | null = null;
      let colorCanvas: HTMLCanvasElement | null = null;
      if (verts && verts.length) {
        mask = rasterVertexColorMask(verts, { size, resX: res, resY: res, canonical });
        // 空格兜底:用外部高度的相对分带 + 坡度自动权重填平
        const style = getMwamStyleCfg(params.maps.custom.terrain.terrainStyle);
        const anchors = style?.zones ?? {
          lowTop: 0.05, vegiTop: 0.58, rockTop: 0.87, snowEnabled: true, bandQ: 0.05,
        };
        const tmin = 0, tmax = grid.maxHeight ?? mx;
        const span = Math.max(1e-3, tmax - tmin);
        const frac = REL_ANCHORS.custom ?? { lowTop: 0.06, vegiTop: 0.5, rockTop: 0.82 };
        const rep = {
          mode: 'relative' as const, snowOn: anchors.snowEnabled,
          low: tmin + frac.lowTop * span, vegi: tmin + frac.vegiTop * span,
          rock: tmin + frac.rockTop * span,
          softLow: span * 0.04, softVegi: span * 0.04, softRock: span * 0.04,
          domainMin: tmin, domainMax: tmax, area: null as never,
        };
        const smooth = (b: number, w: number, v: number) => {
          if (w <= 1e-4) return v <= b ? 0 : 1;
          const t = Math.min(1, Math.max(0, (v - (b - w)) / (2 * w)));
          return t * t * (3 - 2 * t);
        };
        fillMaskGaps(mask, { size, resX: res, resY: res }, (x, z) => {
          const h = heightAt(x, z);
          const hX = heightAt(x + 30, z);
          const hZ = heightAt(x, z + 30);
          const slope = Math.max(Math.abs(h - hX) / 30, Math.abs(h - hZ) / 30);
          const uLo = smooth(rep.low, rep.softLow, h);
          const uVg = smooth(rep.vegi, rep.softVegi, h);
          const uRk = smooth(rep.rock, rep.softRock, h);
          const ws = 1 - uLo;
          const wg = uLo * (1 - uVg);
          const wr = uVg * (1 - uRk);
          const wn = uVg * uRk;
          const start = 0.72;
          const k = Math.min(1, Math.max(0, (slope - start) / (1 - start)));
          const m2 = k * 0.65;
          return [ws * (1 - m2), wg * (1 - m2), wr + (ws + wg) * m2, wn];
        });
        // 顶点色世界图(每格平均色,遮罩同分辨率)
        colorCanvas = document.createElement('canvas');
        colorCanvas.width = colorCanvas.height = res;
        const cctx = colorCanvas.getContext('2d')!;
        const img = cctx.createImageData(res, res);
        const pix = img.data;
        const bins = new Map<number, [number, number, number, number]>();
        for (const p of verts) {
          const ix = Math.floor(((p.x + size / 2) / size) * res);
          const iy = Math.floor(((p.z + size / 2) / size) * res);
          if (ix < 0 || iy < 0 || ix >= res || iy >= res) continue;
          const key = iy * res + ix;
          const b = bins.get(key) ?? [0, 0, 0, 0];
          b[0] += p.r; b[1] += p.g; b[2] += p.b; b[3]++;
          bins.set(key, b);
        }
        for (const [key, b] of bins) {
          const n = b[3] || 1;
          const o = key * 4;
          pix[o] = Math.round((b[0] / n) * 255);
          pix[o + 1] = Math.round((b[1] / n) * 255);
          pix[o + 2] = Math.round((b[2] / n) * 255);
          pix[o + 3] = 255;
        }
        cctx.putImageData(img, 0, 0);
      } else {
        notify('无顶点色 → 遮罩走「相对分带自动」:请稍后在 Mask 面板按自动生成');
      }

      // 3) 挂 world(custom)并重建预览
      let vtxEntry: { tex: THREE.CanvasTexture; canonical: [number, number, number][] } | null = null;
      if (colorCanvas) {
        const tex = new THREE.CanvasTexture(colorCanvas);
        tex.colorSpace = THREE.NoColorSpace;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.needsUpdate = true;
        vtxEntry = { tex, canonical };
      }
      world.setExternalPack('custom', grid, vtxEntry ?? undefined);

      // 4) 同步 params:external 元数据 + 尺寸 + 遮罩模式
      const p: EditorParams = structuredClone(params);
      const t = p.maps.custom.terrain;
      t.size = size;
      p.maps.custom.external = {
        active: true, size, heightScale: src.meters ? 1 : amp, seaLevel: offset,
        maskRes: res, mixNear, mixFar, canonical, name: packName,
      };
      if (mask) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = res;
        const c2 = canvas.getContext('2d')!;
        const im = c2.createImageData(res, res);
        im.data.set(mask);
        c2.putImageData(im, 0, 0);
        const dataUrl = canvas.toDataURL('image/png');
        p.masks.custom = { res, png: dataUrl };
        p.maps.custom.material.maskMode = true;
        await world.restoreMaskPng('custom', dataUrl, res, size);
      }
      p.mapType = 'custom';
      setParams(p);
      world.params = p;
      await world.rebuildWorld(false);
      notify(`已导入 custom 槽:高度 ${src.w}×${src.h} · 遮罩 ${res}² · 顶点色${verts ? '✓' : '—'} 远/近 ${mixNear}/${mixFar}m`);
    } catch (e) {
      notify('导入失败:' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, verts, size, amp, offset, maskRes, mixNear, mixFar, packName, world, params, setParams]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 bg-black/70 flex items-center justify-center" onClick={onClose}>
      <div className="w-[560px] max-h-[85vh] overflow-y-auto bg-slate-950 border border-cyan-800/60 rounded-xl p-5 space-y-4 font-mono text-slate-200"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div className="text-sm font-bold text-cyan-300 tracking-widest">GAEA 地形导入 → 自定义槽</div>
          <button className="text-slate-500 hover:text-red-300" onClick={onClose}>✕ 关闭</button>
        </div>
        <div className="text-[10px] text-cyan-300/50 leading-4">
          <span className="text-amber-300/80">顶点色一词仅指本窗口的 OBJ 工作流。</span>
          Gaea GUI 导出的 PBR 四贴图(HeightmapExport/ColorExport/AOExport/
          NormalsExport)请关掉本窗口、用顶栏「▶ 测试 004 导入地形」——按文件名
          自动上 高度/基础色/AO/法线(全盘 Gaea,遵循 PBR)。
        </div>
        <div className="text-[10px] text-cyan-300/50 leading-4">
          素材:16-bit PNG/EXR 高度 + 顶点色 OBJ(可只给高度)。导入后 custom 槽用外部高度场;
          顶点色软分类成 RGBA 遮罩(R/G/B/A = 低地/草/岩/雪,与既有细节贴图槽一一对应);
          远景直接显示顶点色,近景按距离混合到「遮罩选层高清细节 × 颜色校正」。
        </div>

        {/* 步骤1:素材 */}
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold text-emerald-300 tracking-widest">① 素材(未选 → 用内置样例)</div>
          <div className="flex gap-2 flex-wrap text-[11px]">
            <button className="px-2 py-1 rounded bg-cyan-900 hover:bg-cyan-800 text-cyan-100 disabled:opacity-50"
              disabled={busy} onClick={loadSample}>加载样例</button>
            <button className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700" onClick={() => heightRef.current?.click()}>高度图 PNG/EXR…</button>
            <button className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700" onClick={() => objRef.current?.click()}>顶点色 OBJ…</button>
            <input ref={heightRef} type="file" accept=".png,.exr" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onHeightFile(f); e.target.value = ''; }} />
            <input ref={objRef} type="file" accept=".obj" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onObjFile(f); e.target.value = ''; }} />
          </div>
          <div className="text-[10px] text-slate-400">
            {src ? `高度: ${src.label}(${src.w}×${src.h}) · ${src.meters ? '米制' : '归一'}` : '高度: 未选(样例/自动)'}
            {' · '}顶点色: {verts ? `${verts.length} 顶点` : '未选(自动分带出遮罩)'}
          </div>
        </div>

        {/* 步骤2:参数 */}
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold text-emerald-300 tracking-widest">② 参数</div>
          <Row label="世界尺寸(米)" value={size} min={12000} max={80000} step={500} onChange={setSize} />
          {src && !src.meters && <Row label="幅度(米)" value={amp} min={50} max={6000} step={50} onChange={setAmp} />}
          <Row label="基准偏移(米)" value={offset} min={-1500} max={1500} step={10} onChange={setOffset} />
          <div className="flex items-center gap-2 text-[11px]">
            <span className="w-24">遮罩分辨率</span>
            <select className="flex-1 bg-slate-800 rounded px-1 py-0.5" value={maskRes}
              onChange={(e) => setMaskRes(parseInt(e.target.value, 10) as 512 | 1024 | 2048)}>
              {[512, 1024, 2048].map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <input className="flex-1 bg-slate-800 rounded px-1 py-0.5" value={packName} onChange={(e) => setPackName(e.target.value)} placeholder="包名" />
          </div>
        </div>

        {/* 步骤3:远/近混合 */}
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold text-emerald-300 tracking-widest">③ 远/近材质混合(米)</div>
          <Row label="近景边界" value={mixNear} min={200} max={8000} step={50} onChange={(v) => { setMixNear(v); world?.applyExternalMix('custom', v, mixFar); }} />
          <Row label="远景边界" value={mixFar} min={500} max={16000} step={50} onChange={(v) => { setMixFar(v); world?.applyExternalMix('custom', mixNear, v); }} />
          <div className="text-[10px] text-slate-400">远(≥远景边界)= 导入顶点色;近(≤近景边界)= 遮罩选层高清细节 × 颜色校正</div>
        </div>

        <div className="flex items-center gap-2">
          <button className="flex-1 px-3 py-2 rounded bg-emerald-800 hover:bg-emerald-700 text-emerald-100 disabled:opacity-50"
            disabled={busy || !src} onClick={() => void runImport()}>
            {busy ? '处理中…' : '导入到自定义槽并预览'}
          </button>
          <div className="text-[10px] text-slate-500 w-40 leading-3.5">完成后导出 tune(顶栏),游戏 console `mapOverride=custom` 直达测试</div>
        </div>
      </div>
    </div>
  );
}
