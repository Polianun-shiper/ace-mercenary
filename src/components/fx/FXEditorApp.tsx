// === FX 特效编辑器 (per user request: 全新特效编辑器外壳,3A 对标) ===
// 布局:左 FX 资产列表(预设 + 用户资产)+ 发射器列表;右发射器 Inspector
// (全参数实时);底部时间轴(播放/暂停/倍速/循环/scrub);顶栏 导入序列帧/
// 新建/保存/导出。
// === 序列帧爆炸工作流 (per user request: 编辑器的 sprite 特效替换游戏原生) ===
//   「导入序列帧」→ 按文件名前缀分组(fxxx=地面 / 4xxx=空中)→ 自动生成
//   单精灵爆发资产(帧按寿命均分动画)→ 分配槽位 → 导出 fx-tune.json 即
//   游戏融合契约(槽位资产会完全替换游戏内同类别爆炸视觉)。
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FxWorld } from '@/lib/fx/fx-world';
import {
  type FxAsset, type FxEmitterCfg, type SpriteEmitterCfg,
  type ShockwaveCfg, type LightFlashCfg,
} from '@/lib/fx/fx-core';
import {
  BAKE_SIZES, SEQUENCE_FPS, bakeSheet, groupFrames, suggestSlot,
  type BakeSize, type SequenceFrameFile,
} from '@/lib/fx/sheet-bake';
import { FX_TUNE_LS_KEY, type FxSlots, type FxTuneDoc } from '@/lib/game/fx-tune';

const FX_LS_KEY = 'skybound.fx.assets';

/** 自动适配:序列帧总时长 = 帧数 ÷ 24fps;低帧数(<19)自动慢放兜底 ≥0.8s,
 *  保证 1-2 帧素材也能试效果(单帧 = 寿命内静止贴图)。 */
const seqLife = (frames: number) => Math.max(0.8, Math.min(3.5, frames / SEQUENCE_FPS));

// ===========================================================================
// 演示预设(3A 风格:爆炸/尾烟/火花/冲击波/烟尘)
// ===========================================================================
let seq = 0;
const uid = () => `e${Date.now()}-${++seq}`;
const sprite = (p: Partial<SpriteEmitterCfg> & { name: string }): SpriteEmitterCfg => ({
  type: 'sprite', id: uid(), mode: 'burst', burstCount: 120, rate: 60,
  lifetime: 1.2, lifetimeJitter: 0.3, speed: 60, speedJitter: 0.5, spreadCone: 150,
  direction: [0, 1, 0], gravity: 40, drag: 1.2, size0: 30, size1: 6,
  color0: '#ffd080', color1: '#ff5020', opacity0: 1, opacity1: 0,
  blend: 'additive', spin: 2, spinJitter: 0.5,
  ...p,
});
const shock = (p: Partial<ShockwaveCfg> & { name: string }): ShockwaveCfg => ({
  type: 'shockwave', id: uid(), duration: 0.8, startRadius: 10, endRadius: 900,
  thickness: 20, color: '#ffd9a0', opacity: 0.9, blend: 'additive', ...p,
});
const flash = (p: Partial<LightFlashCfg> & { name: string }): LightFlashCfg => ({
  type: 'lightflash', id: uid(), intensity: 200000, radius: 4000, decay: 2, duration: 0.5, color: '#ffb060', ...p,
});

export const BUILTIN_FX: FxAsset[] = [
  {
    version: 1, id: 'fx-explosion', name: '爆炸', loop: false,
    emitters: [
      sprite({ name: '火球', burstCount: 260, lifetime: 1.4, lifetimeJitter: 0.25, speed: 140, speedJitter: 0.6, spreadCone: 180, gravity: 25, drag: 2.0, size0: 90, size1: 20, color0: '#fff4d0', color1: '#ff4020', opacity0: 1 }),
      sprite({ name: '烟团', mode: 'continuous', rate: 40, lifetime: 2.6, lifetimeJitter: 0.4, speed: 30, speedJitter: 0.4, spreadCone: 180, gravity: -18, drag: 2.5, size0: 60, size1: 200, color0: '#3a3a3a', color1: '#141414', opacity0: 0.8, opacity1: 0, blend: 'normal', spin: 0.2 }),
      shock({ name: '冲击波' }),
      flash({ name: '闪光' }),
    ],
  },
  {
    version: 1, id: 'fx-missile-smoke', name: '导弹尾烟', loop: true,
    emitters: [
      sprite({ name: '尾烟', mode: 'continuous', rate: 90, lifetime: 2.0, lifetimeJitter: 0.3, speed: 12, speedJitter: 0.3, spreadCone: 20, direction: [0, 1, 0], gravity: 0, drag: 1.5, size0: 26, size1: 90, color0: '#e8e8e8', color1: '#555555', opacity0: 0.9, opacity1: 0, blend: 'normal', spin: 0.4 }),
      sprite({ name: '尾焰', mode: 'continuous', rate: 60, lifetime: 0.35, speed: 10, spreadCone: 12, direction: [0, 1, 0], size0: 30, size1: 4, color0: '#fff0c0', color1: '#ff8020', opacity0: 1, blend: 'additive' }),
      flash({ name: '喷口光', intensity: 80000, radius: 1200, decay: 2, duration: 0.12 }),
    ],
  },
  {
    version: 1, id: 'fx-spark-burst', name: '火花迸射', loop: false,
    emitters: [
      sprite({ name: '火花', burstCount: 400, lifetime: 1.1, lifetimeJitter: 0.5, speed: 220, speedJitter: 0.7, spreadCone: 90, gravity: 90, drag: 0.4, size0: 8, size1: 1, color0: '#fff6c0', color1: '#ff9020', opacity0: 1, spin: 8, spinJitter: 0.8 }),
    ],
  },
  {
    version: 1, id: 'fx-shockwave-ring', name: '环形冲击波', loop: false,
    emitters: [
      shock({ name: '主环', startRadius: 20, endRadius: 2000, duration: 1.1, color: '#9fd0ff', opacity: 0.8 }),
      shock({ name: '内环', startRadius: 5, endRadius: 700, duration: 0.7, color: '#ffffff', opacity: 1 }),
      flash({ name: '爆闪', intensity: 300000, radius: 6000, decay: 2, duration: 0.3, color: '#cfe4ff' }),
    ],
  },
  {
    version: 1, id: 'fx-dust-smoke', name: '烟尘', loop: true,
    emitters: [
      sprite({ name: '烟尘', mode: 'continuous', rate: 50, lifetime: 3.0, lifetimeJitter: 0.4, speed: 16, speedJitter: 0.5, spreadCone: 140, direction: [0, 1, 0], gravity: -10, drag: 1.8, size0: 40, size1: 260, color0: '#6a6258', color1: '#1c1a16', opacity0: 0.7, opacity1: 0, blend: 'normal', spin: 0.1 }),
    ],
  },
];

// ===========================================================================
// 小控件
// ===========================================================================
function Row({ label, value, min, max, step, fmt, onChange }: { label: string; value: number; min: number; max: number; step: number; fmt?: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-slate-300">
      <span className="w-20 shrink-0 truncate">{label}</span>
      <input type="range" className="flex-1 h-1.5 accent-[#9dffb0]" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
      <input type="number" className="w-14 bg-slate-800 rounded px-1 py-0.5 text-right text-slate-200" value={value} step={step} min={min} max={max} onChange={(e) => onChange(parseFloat(e.target.value))} />
      {fmt && <span className="w-12 text-right text-slate-400">{fmt(value)}</span>}
    </div>
  );
}
function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-slate-300">
      <span className="w-20 shrink-0 truncate">{label}</span>
      <input type="color" className="h-5 w-10 bg-slate-800 rounded" value={value} onChange={(e) => onChange(e.target.value)} />
      <span className="text-slate-500">{value}</span>
    </div>
  );
}
function SelectRow({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-slate-300">
      <span className="w-20 shrink-0 truncate">{label}</span>
      <select className="flex-1 bg-slate-800 rounded px-1 py-0.5 text-slate-200" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
}
/** 槽位徽章颜色/文案 */
const SLOT_META: Record<'ground' | 'air', [string, string]> = {
  ground: ['bg-amber-900/60 text-amber-200', '地面'],
  air: ['bg-sky-900/60 text-sky-200', '空中'],
};

// 序列帧图集节(挂在 sprite Inspector 顶部)
function SheetSection({ cfg, onPatch, onAttach }: { cfg: SpriteEmitterCfg; onPatch: (p: Partial<SpriteEmitterCfg>) => void; onAttach: () => void }) {
  const sheet = cfg.sheet;
  if (sheet) {
    const cellSecs = (sheet.frames / SEQUENCE_FPS).toFixed(2);
    return (
      <div className="space-y-1 border border-cyan-900/60 rounded bg-cyan-950/20 p-1.5">
        <div className="text-[10px] font-semibold text-cyan-300">序列帧图集(frames 按寿命均分)</div>
        {/* 图集太大时 CSS 压小预览(不重新解码) */}
        <img src={sheet.dataUrl ?? sheet.url} alt="sheet" className="w-full max-h-16 object-contain bg-slate-900 rounded" />
        <div className="text-[9px] text-slate-400 leading-3.5">
          {sheet.frames} 帧 · {sheet.cols}×{sheet.rows} 网格 · 标称 {cellSecs}s @{SEQUENCE_FPS}fps · 当前寿命 {cfg.lifetime.toFixed(2)}s
        </div>
        <button className="text-[10px] px-2 py-0.5 rounded bg-red-900/50 hover:bg-red-800/60 text-red-200 w-full text-left"
          onClick={() => onPatch({ sheet: undefined })}>✕ 移除序列帧(回程序化柔边圆点)</button>
      </div>
    );
  }
  return (
    <div className="space-y-1 border border-slate-700 rounded p-1.5">
      <div className="text-[10px] font-semibold text-slate-400">贴图:程序化柔边圆点(无图集)</div>
      <button className="text-[10px] px-2 py-0.5 rounded bg-cyan-900/50 hover:bg-cyan-800/60 text-cyan-200 w-full text-left"
        onClick={onAttach}>＋ 挂载序列帧…(导入一组帧 → 自动按寿命播放)</button>
    </div>
  );
}

function EmitterInspector({ cfg, onChange, onAttachSheet }: { cfg: FxEmitterCfg; onChange: (c: FxEmitterCfg) => void; onAttachSheet: () => void }) {
  const patch = (p: Partial<FxEmitterCfg>) => onChange({ ...cfg, ...p } as FxEmitterCfg);
  if (cfg.type === 'shockwave') {
    return (
      <div className="space-y-1.5">
        <Row label="时长" value={cfg.duration} min={0.1} max={5} step={0.05} onChange={(v) => patch({ duration: v })} />
        <Row label="起始半径" value={cfg.startRadius} min={0} max={2000} step={5} onChange={(v) => patch({ startRadius: v })} />
        <Row label="结束半径" value={cfg.endRadius} min={50} max={12000} step={50} onChange={(v) => patch({ endRadius: v })} />
        <Row label="透明度" value={cfg.opacity} min={0} max={1} step={0.02} onChange={(v) => patch({ opacity: v })} />
        <ColorRow label="颜色" value={cfg.color} onChange={(v) => patch({ color: v })} />
        <SelectRow label="混合" value={cfg.blend} options={[['additive', '加色'], ['normal', '正常']]} onChange={(v) => patch({ blend: v as never })} />
      </div>
    );
  }
  if (cfg.type === 'lightflash') {
    return (
      <div className="space-y-1.5">
        <Row label="强度" value={cfg.intensity} min={1000} max={1000000} step={1000} onChange={(v) => patch({ intensity: v })} />
        <Row label="半径" value={cfg.radius} min={100} max={20000} step={100} onChange={(v) => patch({ radius: v })} />
        <Row label="衰减" value={cfg.decay} min={0.5} max={4} step={0.1} onChange={(v) => patch({ decay: v })} />
        <Row label="时长" value={cfg.duration} min={0.05} max={3} step={0.05} onChange={(v) => patch({ duration: v })} />
        <ColorRow label="颜色" value={cfg.color} onChange={(v) => patch({ color: v })} />
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <SheetSection cfg={cfg} onPatch={(p) => patch(p)} onAttach={onAttachSheet} />
      <SelectRow label="模式" value={cfg.mode} options={[['burst', '爆发'], ['continuous', '连续']]} onChange={(v) => patch({ mode: v as never })} />
      {cfg.mode === 'burst' ? (
        <Row label="爆发数量" value={cfg.burstCount} min={1} max={2000} step={10} onChange={(v) => patch({ burstCount: Math.round(v) })} />
      ) : (
        <Row label="每秒发射" value={cfg.rate} min={1} max={500} step={1} onChange={(v) => patch({ rate: Math.round(v) })} />
      )}
      <Row label="寿命" value={cfg.lifetime} min={0.1} max={10} step={0.05} onChange={(v) => patch({ lifetime: v })} />
      <Row label="寿命抖动" value={cfg.lifetimeJitter} min={0} max={1} step={0.02} onChange={(v) => patch({ lifetimeJitter: v })} />
      <Row label="初速" value={cfg.speed} min={0} max={600} step={5} onChange={(v) => patch({ speed: v })} />
      <Row label="速度抖动" value={cfg.speedJitter} min={0} max={1} step={0.02} onChange={(v) => patch({ speedJitter: v })} />
      <Row label="喷射锥角" value={cfg.spreadCone} min={0} max={180} step={1} fmt={(v) => `${v}°`} onChange={(v) => patch({ spreadCone: v })} />
      <Row label="重力" value={cfg.gravity} min={-200} max={400} step={1} onChange={(v) => patch({ gravity: v })} />
      <Row label="阻力" value={cfg.drag} min={0} max={8} step={0.1} onChange={(v) => patch({ drag: v })} />
      <Row label="初始尺寸" value={cfg.size0} min={0.5} max={600} step={1} onChange={(v) => patch({ size0: v })} />
      <Row label="末端尺寸" value={cfg.size1} min={0} max={1000} step={1} onChange={(v) => patch({ size1: v })} />
      <ColorRow label="初始色" value={cfg.color0} onChange={(v) => patch({ color0: v })} />
      <ColorRow label="末端色" value={cfg.color1} onChange={(v) => patch({ color1: v })} />
      <Row label="初始透明" value={cfg.opacity0} min={0} max={1} step={0.02} onChange={(v) => patch({ opacity0: v })} />
      <Row label="末端透明" value={cfg.opacity1} min={0} max={1} step={0.02} onChange={(v) => patch({ opacity1: v })} />
      <Row label="自旋" value={cfg.spin} min={-20} max={20} step={0.1} onChange={(v) => patch({ spin: v })} />
      <Row label="自旋抖动" value={cfg.spinJitter} min={0} max={1} step={0.02} onChange={(v) => patch({ spinJitter: v })} />
      <SelectRow label="混合" value={cfg.blend} options={[['additive', '加色'], ['normal', '正常']]} onChange={(v) => patch({ blend: v as never })} />
    </div>
  );
}

// ===========================================================================
// 主组件
// ===========================================================================
export function FXEditorApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<FxWorld | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  // 挂载序列帧到指定发射器的目标(顶栏导入 = 整组新建资产)
  const attachTo = useRef<{ assetId: string; emitterId: string } | null>(null);
  const [worldReady, setWorldReady] = useState(false);
  const [assets, setAssets] = useState<FxAsset[]>(() => {
    try {
      const ls = typeof localStorage !== 'undefined' ? localStorage.getItem(FX_LS_KEY) : null;
      if (ls) {
        const a = JSON.parse(ls) as FxAsset[];
        if (Array.isArray(a) && a.length) return a;
      }
    } catch { /* 忽略 */ }
    return BUILTIN_FX.map((f) => structuredClone(f));
  });
  const [assetId, setAssetId] = useState<string>(BUILTIN_FX[0].id);
  const [emitterId, setEmitterId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(true);
  const [scrub, setScrub] = useState(0);
  const [stats, setStats] = useState<{ fps: number; particles: number; time: number } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [bakeSize, setBakeSize] = useState<BakeSize>(256);
  // === A/B 对比模式 (per user request: 看到原生游戏特效 vs 准备替换的特效) ===
  const [compare, setCompare] = useState<'preset' | 'legacy' | 'side'>('preset');

  const asset = assets.find((a) => a.id === assetId) ?? assets[0];
  const emitter = asset?.emitters.find((e) => e.id === emitterId) ?? null;
  const hasSheet = asset?.emitters.some((e) => e.type === 'sprite' && !!e.sheet) ?? false;

  // world 生命周期
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const world = new FxWorld(canvas, { onStats: setStats });
    worldRef.current = world;
    world.currentAsset = BUILTIN_FX[0];
    setWorldReady(true);
    let raf = 0;
    let last = performance.now();
    const loopFn = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      world.render(dt);
      raf = requestAnimationFrame(loopFn);
    };
    raf = requestAnimationFrame(loopFn);
    return () => {
      cancelAnimationFrame(raf);
      world.dispose();
      worldRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 键盘:右键环视由 flyCam 处理;空格暂停
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      const w = worldRef.current;
      if (!w) return;
      w.flyCam.onKeyDown(e.code);
      if (e.code === 'Space') { e.preventDefault(); setPaused((p) => !p); }
    };
    const onKeyUp = (e: KeyboardEvent) => worldRef.current?.flyCam.onKeyUp(e.code);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // 世界状态同步(paused/speed/loop/当前资产)
  useEffect(() => {
    const w = worldRef.current;
    if (!w) return;
    w.paused = paused;
    w.speed = speed;
    w.loop = loop;
    if (asset) w.currentAsset = asset;
  }, [paused, speed, loop, asset, assets]);

  // 对比模式同步:preset=仅序列帧预设;legacy=仅原生复刻;side=左原生右预设
  useEffect(() => {
    const w = worldRef.current;
    if (!w) return;
    w.compareMode = compare;
    w.clearFx(); // 切换即清场,避免旧模式特效残留混叠
  }, [compare, worldReady]);

  // 选中带序列帧的资产 → 预解码图集 → 自动播一次(让作者立即看到帧动画)
  useEffect(() => {
    if (!worldReady || !asset || !hasSheet) return;
    const w = worldRef.current;
    if (!w) return;
    let alive = true;
    w.prepareAsset(asset).then(() => {
      if (alive && assetId === asset.id) {
        w.playAtRay(asset);
        setScrub(0);
      }
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldReady, assetId]);

  /** 解码后刷新预览(资产内容原地改,id 未变时用) */
  const previewRefresh = (a: FxAsset) => {
    const w = worldRef.current;
    if (!w) return;
    w.prepareAsset(a).then(() => {
      if (assetId === a.id) { w.playAtRay(a); setScrub(0); }
    });
  };

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const w = worldRef.current;
    if (!w || !asset) return;
    if (e.button === 2) {
      w.flyCam.onMouseDown(e.clientX, e.clientY);
      return;
    }
    if (e.button === 0) {
      w.playAtRay(asset); // 内部记录发射点供 continuous 发射器持续产粒子
    }
  }, [asset]);
  const onMouseMove = useCallback((e: React.MouseEvent) => worldRef.current?.flyCam.onMouseMove(e.clientX, e.clientY), []);
  const onMouseUp = useCallback(() => worldRef.current?.flyCam.onMouseUp(), []);
  const onWheel = useCallback((e: React.WheelEvent) => worldRef.current?.flyCam.onWheel(e.deltaY), []);
  const onCtx = useCallback((e: React.MouseEvent) => e.preventDefault(), []);

  // 资产操作
  const updateAsset = (id: string, fn: (a: FxAsset) => FxAsset) => {
    setAssets((prev) => prev.map((a) => (a.id === id ? fn(a) : a)));
  };
  const newFrom = (tpl: FxAsset) => {
    const a = structuredClone(tpl);
    a.id = `fx-user-${Date.now()}`;
    a.name = `${tpl.name} 副本`;
    setAssets((prev) => [...prev, a]);
    setAssetId(a.id);
  };
  const del = (id: string) => {
    setAssets((prev) => prev.filter((a) => a.id !== id));
    if (assetId === id) setAssetId(assets[0]?.id ?? '');
  };
  const save = () => {
    try {
      localStorage.setItem(FX_LS_KEY, JSON.stringify(assets));
      setMsg('已保存到 localStorage');
    } catch {
      // 序列帧 dataURL 可能超 5MB 配额 —— 内存态保留,用导出文件即可
      setMsg('⚠ localStorage 已满(序列帧体积大):请用「导出」下载 fx-tune.json 保存');
    }
  };

  /** 一个序列帧组 → 自动适配的爆炸资产(单精灵爆发,帧按寿命均分)。 */
  const buildSeqAsset = (token: string, baked: Awaited<ReturnType<typeof bakeSheet>>): FxAsset => {
    const slot = suggestSlot(token);
    return {
      version: 1,
      id: `fx-seq-${Date.now()}-${++seq}`,
      name: `序列帧爆炸[${token}]${slot ? (slot === 'ground' ? '·地面' : '·空中') : ''}`,
      loop: false,
      slot: slot ?? undefined,
      emitters: [{
        type: 'sprite',
        id: uid(),
        name: '序列帧主体',
        sheet: { ...baked.cfg, key: `fx-seq-${Date.now()}-${seq}` },
        mode: 'burst', burstCount: 1, rate: 1,
        lifetime: seqLife(baked.cfg.frames), lifetimeJitter: 0,
        speed: 0, speedJitter: 0, spreadCone: 0, direction: [0, 1, 0],
        gravity: 0, drag: 0, size0: 100, size1: 100,
        color0: '#ffffff', color1: '#ffffff', opacity0: 1, opacity1: 1,
        blend: 'additive', spin: 0, spinJitter: 0,
      }],
    };
  };

  /** 导入主入口:整组新建资产(顶栏)/ 或挂到所选发射器(Inspector)。 */
  const handleImportFiles = async (fileList: FileList | null) => {
    if (!fileList || !fileList.length || importing) return;
    const target = attachTo.current;
    attachTo.current = null;
    const files: SequenceFrameFile[] = [...fileList].map((f) => ({ name: f.name, file: f }));
    const groups = groupFrames(files);
    setImporting(true);
    setMsg('烘制序列帧图集…(每帧缩到最长边 ' + bakeSize + 'px)');
    try {
      if (target) {
        const g = groups[0];
        if (!g) { setMsg('未识别到帧文件'); return; }
        const baked = await bakeSheet(g.frames, bakeSize);
        const cur = assets.find((a) => a.id === target.assetId);
        if (!cur) { setMsg('目标发射器已不存在'); return; }
        const updated: FxAsset = {
          ...cur,
          emitters: cur.emitters.map((e) => e.id === target.emitterId
            ? {
                ...e,
                sheet: { ...baked.cfg, key: `fx-seq-${Date.now()}-${seq}` },
                // 自动适配:寿命对齐标称帧时长(24fps;低帧数自动慢放)
                ...(e.type === 'sprite' ? { lifetime: seqLife(baked.cfg.frames) } : {}),
              } as FxEmitterCfg
            : e),
        };
        setAssets((prev) => prev.map((a) => (a.id === target.assetId ? updated : a)));
        previewRefresh(updated);
        setMsg(`已挂载 ${baked.cfg.frames} 帧图集(网格 ${baked.cfg.cols}×${baked.cfg.rows});点视口或拖动时间轴查看`);
        return;
      }
      // === 导入:每组(≥1 帧)都生成资产 —— 低帧数也可直接试效果 ===
      // 1 帧 = 静止贴图;2-18 帧 = 慢速逐帧(frames<19 自动 ≥0.8s 慢放);
      // 完整序列(≥19 帧)按 24fps 标称时长。分组/帧数/槽位回显在 toast。
      const created: FxAsset[] = [];
      for (const g of groups) {
        const baked = await bakeSheet(g.frames, bakeSize);
        created.push(buildSeqAsset(g.token, baked));
      }
      if (created.length) {
        setAssets((prev) => [...prev, ...created]);
        setAssetId(created[0].id);
        const detail = groups.map((g) => {
          const slot = suggestSlot(g.token);
          const tag = slot ? (slot === 'ground' ? '→地面槽' : '→空中槽') : '';
          const slow = g.frames.length < 19 ? `,已${g.frames.length === 1 ? '静止' : '慢放'}` : '';
          return `[${g.token} ${g.frames.length}帧${tag}${slow}]`;
        }).join(' ');
        setMsg(`已导入 ${created.length} 组:${detail};点视口左键/时间轴查看 — 低帧素材也能直接进游戏试(每帧停留更长)`);
      } else {
        setMsg('未识别到图片帧,请选择 PNG/JPEG/WebP');
      }
    } catch (e) {
      setMsg('导入失败:' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setImporting(false);
    }
  };

  const exportTune = () => {
    // 槽位 → 资产(同槽重复时列表靠后者胜出,与 UI 提示一致)
    const slots: FxSlots = {};
    for (const a of assets) {
      if (a.slot === 'ground') slots.ground = a.id;
      else if (a.slot === 'air') slots.air = a.id;
    }
    const doc: FxTuneDoc = { version: 1, slots, assets };
    try {
      localStorage.setItem(FX_TUNE_LS_KEY, JSON.stringify(doc));
    } catch { /* 导出文件不受配额限制 */ }
    const blob = new Blob([JSON.stringify(doc)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'fx-tune.json';
    a.click();
    URL.revokeObjectURL(url);
    if (slots.ground || slots.air) {
      setMsg('已导出 fx-tune.json(游戏契约):覆盖 public/config/fx-tune.json 后重建即融合 → 槽位资产将完全替换游戏对应爆炸');
    } else {
      setMsg('已导出 fx-tune.json —— 注意:尚未分配槽位,游戏仍用原生爆炸;在右侧把资产槽位设为 地面/空中 后重新导出');
    }
  };

  return (
    <div className="fixed inset-0 bg-black text-slate-200 select-none flex flex-col">
      {/* 顶栏 */}
      <div className="h-10 flex items-center gap-2 px-3 bg-slate-900 border-b border-slate-800 text-[12px] shrink-0">
        <span className="font-bold text-cyan-400 mr-1">FX 特效编辑器</span>
        {/* === 序列帧导入(per user request: f=地面 / 4=空中 自动分组适配) === */}
        <label className="flex items-center gap-1 text-[10px] text-slate-400">
          帧边
          <select className="bg-slate-800 rounded px-1 py-0.5 text-slate-200"
            value={bakeSize} onChange={(e) => setBakeSize(parseInt(e.target.value, 10) as BakeSize)}>
            {BAKE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <button className="px-2 py-1 rounded bg-cyan-900 hover:bg-cyan-800 text-cyan-100 disabled:opacity-50"
          disabled={importing} onClick={() => importRef.current?.click()}>
          {importing ? '烘制中…' : '导入序列帧'}
        </button>
        <div className="w-px h-5 bg-slate-700" />
        <button className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700" onClick={() => asset && newFrom(asset)}>复制当前</button>
        <button className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700" onClick={() => setAssets(BUILTIN_FX.map((f) => structuredClone(f)))}>恢复预设</button>
        <div className="flex-1" />
        <span className="text-[10px] text-slate-500 hidden lg:inline">导入后:分配槽位(地面爆炸/空中爆炸)→ 导出 → 覆盖 public/config/fx-tune.json → 重建即替换游戏爆炸</span>
        <button className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700" onClick={save}>保存</button>
        <button className="px-2 py-1 rounded bg-emerald-800 hover:bg-emerald-700 text-emerald-100" onClick={exportTune}>导出 fx-tune.json</button>
        <input ref={importRef} type="file" multiple accept="image/png,image/jpeg,image/webp" className="hidden"
          onChange={(e) => { void handleImportFiles(e.target.files); e.target.value = ''; }} />
      </div>
      {msg && <div className="absolute top-12 left-1/2 -translate-x-1/2 z-20 bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-[11px] text-emerald-200 max-w-[80vw]" onClick={() => setMsg(null)}>{msg}(点此关闭)</div>}

      <div className="flex-1 flex min-h-0">
        {/* 左:资产 + 发射器 */}
        <div className="w-60 shrink-0 flex flex-col border-r border-slate-800 overflow-y-auto p-2 space-y-2 bg-slate-950/90">
          <div className="text-[11px] font-semibold text-cyan-400">FX 资产(点击选中,视口左键发射)</div>
          {assets.map((a) => (
            <div key={a.id} className={`flex items-center gap-1 text-[11px] px-1.5 py-1 rounded cursor-pointer ${a.id === assetId ? 'bg-cyan-900/50 text-cyan-200' : 'hover:bg-slate-800 text-slate-300'}`}
              onClick={() => { setAssetId(a.id); setEmitterId(null); }}>
              <span className="flex-1 truncate">{a.name}</span>
              {a.slot && (
                <span className={`shrink-0 text-[9px] px-1 rounded ${SLOT_META[a.slot][0]}`}>{SLOT_META[a.slot][1]}</span>
              )}
              <span className="text-[9px] text-slate-500">{a.emitters.length}em</span>
              <button className="text-slate-500 hover:text-red-400" onClick={(e) => { e.stopPropagation(); del(a.id); }}>✕</button>
            </div>
          ))}
          {asset && (
            <>
              <div className="text-[11px] font-semibold text-cyan-400 pt-1">发射器</div>
              {asset.emitters.map((e) => (
                <div key={e.id} className={`flex items-center gap-1 text-[11px] px-1.5 py-1 rounded cursor-pointer ${e.id === emitterId ? 'bg-emerald-900/40 text-emerald-200' : 'hover:bg-slate-800 text-slate-300'}`}
                  onClick={() => setEmitterId(e.id)}>
                  <span className="flex-1 truncate">{e.name} <span className="text-[9px] text-slate-500">{e.type === 'sprite' && e.sheet ? 'seq' : e.type}</span></span>
                  <button className="text-slate-500 hover:text-red-400" onClick={(ev) => { ev.stopPropagation(); updateAsset(asset.id, (x) => ({ ...x, emitters: x.emitters.filter((m) => m.id !== e.id) })); }}>✕</button>
                </div>
              ))}
              <button className="text-[11px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-left"
                onClick={() => {
                  const e = sprite({ name: '新发射器' });
                  updateAsset(asset.id, (x) => ({ ...x, emitters: [...x.emitters, e] }));
                  setEmitterId(e.id);
                }}>+ 精灵发射器</button>
              <button className="text-[11px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-left"
                onClick={() => {
                  const e = shock({ name: '冲击波' });
                  updateAsset(asset.id, (x) => ({ ...x, emitters: [...x.emitters, e] }));
                  setEmitterId(e.id);
                }}>+ 冲击波</button>
              <button className="text-[11px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-left"
                onClick={() => {
                  const e = flash({ name: '闪光' });
                  updateAsset(asset.id, (x) => ({ ...x, emitters: [...x.emitters, e] }));
                  setEmitterId(e.id);
                }}>+ 闪光灯</button>
            </>
          )}
        </div>

        {/* 视口 */}
        <div className="flex-1 relative">
          {/* A/B 对比切换(原生爆炸复刻 = weapons.ts 高 LOD 六层同参数) */}
          <div className="absolute top-2 left-2 z-10 flex gap-1 text-[10px]">
            {([['preset', '仅预设'], ['legacy', '仅原生'], ['side', '原生 ◀ ▶ 预设']] as const).map(([v, l]) => (
              <button key={v} onClick={() => setCompare(v)}
                className={`px-2 py-0.5 rounded border ${compare === v ? 'bg-cyan-700 border-cyan-400 text-white' : 'bg-slate-900/80 border-slate-700 text-slate-300 hover:bg-slate-800'}`}>
                {l}
              </button>
            ))}
          </div>
          {compare !== 'preset' && (
            <div className="absolute top-9 left-2 z-10 text-[10px] bg-slate-950/70 rounded px-2 py-0.5 text-slate-300 pointer-events-none">
              {compare === 'legacy'
                ? '播放中:游戏原生爆炸复刻(原版 6 层:闪光/火球/烟幕/冲击波环/火花/点光,scale 2)'
                : '左 = 游戏原生爆炸 · 右 = 序列帧预设 — 左键发射,同时钟对比(可拖时间轴逐帧看)'}
            </div>
          )}
          <canvas ref={canvasRef} className="absolute inset-0 w-full h-full"
            onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onWheel={onWheel} onContextMenu={onCtx} />
          {stats && (
            <div className="absolute bottom-12 left-2 bg-slate-950/70 rounded px-2 py-1 text-[10px] text-slate-400 pointer-events-none leading-4">
              <div className="text-[#9dffb0]">{stats.fps.toFixed(0)} FPS · 粒子 {stats.particles}</div>
              <div>右键环视 · WASD+QE 飞行 · 左键发射 · 空格 暂停</div>
            </div>
          )}
          {/* 时间轴 */}
          <div className="absolute bottom-0 left-0 right-0 h-10 bg-slate-900/90 border-t border-slate-800 flex items-center gap-2 px-3 text-[11px]">
            <button className={`px-2 py-1 rounded ${paused ? 'bg-emerald-800 text-emerald-100' : 'bg-slate-800'}`} onClick={() => setPaused((p) => !p)}>{paused ? '▶ 播放' : '⏸ 暂停'}</button>
            <select className="bg-slate-800 rounded px-1 py-0.5" value={speed} onChange={(e) => setSpeed(parseFloat(e.target.value))}>
              {[0.1, 0.25, 0.5, 1, 2].map((s) => <option key={s} value={s}>{s}×</option>)}
            </select>
            <label className="flex items-center gap-1 cursor-pointer">
              <input type="checkbox" className="accent-[#9dffb0]" checked={loop} onChange={(e) => setLoop(e.target.checked)} />循环
            </label>
            <input type="range" className="flex-1 h-1.5 accent-[#9dffb0]" min={0} max={worldRef.current?.loopDuration ?? 4} step={0.01} value={scrub}
              onChange={(e) => { const t = parseFloat(e.target.value); setScrub(t); worldRef.current?.scrubTo(t); }} />
            <span className="w-24 text-right text-slate-400">t = {(stats?.time ?? 0).toFixed(2)}s</span>
          </div>
        </div>

        {/* 右:资产 + 发射器 Inspector */}
        <div className="w-72 shrink-0 flex flex-col border-l border-slate-800 overflow-y-auto p-2 space-y-2 bg-slate-950/90">
          {asset && (
            <>
              <div className="text-[11px] font-semibold text-cyan-400">FX 资产</div>
              <div className="flex items-center gap-2 text-[11px]">
                <span className="w-10 shrink-0 text-slate-400">名称</span>
                <input className="flex-1 bg-slate-800 rounded px-1 py-0.5" value={asset.name}
                  onChange={(e) => updateAsset(asset.id, (x) => ({ ...x, name: e.target.value }))} />
              </div>
              <div className="flex items-center gap-2 text-[11px] text-slate-300">
                <span className="w-10 shrink-0 truncate">槽位</span>
                <select className="flex-1 bg-slate-800 rounded px-1 py-0.5 text-slate-200" value={asset.slot ?? 'none'}
                  onChange={(e) => {
                    const v = e.target.value;
                    updateAsset(asset.id, (x) => ({ ...x, slot: v === 'none' ? undefined : v as 'ground' | 'air' }));
                  }}>
                  {[['none', '无(纯编辑器演示)'], ['ground', '地面爆炸 (f 组)'], ['air', '空中爆炸 (4 组)']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              {asset.slot && (() => {
                const clash = assets.find((a) => a.id !== asset.id && a.slot === asset.slot);
                return clash ? (
                  <div className="text-[9px] text-amber-400">⚠ 「{clash.name}」已占该槽位 —— 导出时列表靠后者胜出</div>
                ) : (
                  <div className="text-[9px] text-slate-500">导出后游戏中 {asset.slot === 'ground' ? '地面' : '空中'} 爆炸将完全替换为该预设(音效/震屏保留)</div>
                );
              })()}
            </>
          )}
          <div className="text-[11px] font-semibold text-cyan-400">发射器 Inspector</div>
          {emitter && asset ? (
            <>
              <div className="flex items-center gap-2 text-[11px]">
                <span className="text-slate-400">名称</span>
                <input className="flex-1 bg-slate-800 rounded px-1 py-0.5" value={emitter.name}
                  onChange={(e) => updateAsset(asset.id, (x) => ({ ...x, emitters: x.emitters.map((m) => (m.id === emitter.id ? { ...m, name: e.target.value } : m)) }))} />
              </div>
              <EmitterInspector cfg={emitter}
                onChange={(c) => updateAsset(asset.id, (x) => ({ ...x, emitters: x.emitters.map((m) => (m.id === c.id ? c : m)) }))}
                onAttachSheet={() => { attachTo.current = { assetId: asset.id, emitterId: emitter.id }; importRef.current?.click(); }} />
            </>
          ) : (
            <div className="text-[10px] text-slate-600">选中左侧发射器查看参数;<br />顶部「导入序列帧」按 f*/4* 前缀自动生成地面/空中爆炸资产</div>
          )}
        </div>
      </div>
    </div>
  );
}
