// === §321/§322 体积云参数滑条面板 (per user request: 手敲数字太难受 / 要保存导出 / 要标开销) ==
//
// 打开方式: 控制台 `tuner`(或 `vcloud ui`) / URL 带 `#tuner` / 按 F2。
// 面板只做两件事: 写 localStorage + 叫引擎立刻推一次(`applyCloudKnobsNow`), 与手敲
// `vcloud <名> <值>` **完全是同一条路** ⇒ 两边读数必然一致。
//
// 四个关键设计(都不是随便选的):
//  ① **默认冻结世界**(setDebugPaused(true)): update 停、RAF 继续 render ⇒ 拖动时画面**立刻变**,
//     且没有运动噪声, 判断画质更准。想边飞边调就点"解冻"。
//  ② **必须主动 releasePointerLock()**: mouseAim 下光标被 canvas 指针锁捕获/隐藏 ⇒ 点不到滑条。
//     同时 engine 的 `_maLockRetry` 已加 `__cloudTunerOpen` 门控 —— 否则每次 pointerdown(拖滑条)
//     都会把指针锁抢回去, 拖到一半就断。
//  ③ **每个滑条标"性能开销等级"**(§322 per user request): 等级来自实测(§313 成本排序 +
//     §320 的"像素 vs 迭代" + §302 采样器复用), 写在描述表里, 面板只负责显示。
//  ④ **保存/导出**: 命名预设(localStorage) + JSON 文件下载/导入 + "导出命令"(可直接粘给我)。
//     三种粒度都是同一份快照格式(只含改过的项)。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameEngine } from '../../lib/game/engine';
import {
  CLOUD_KNOB_GROUPS, CLOUD_FLAG_GROUPS, COST_LABEL, cloudKnobCmd,
  type CloudKnob, type CloudFlag,
} from '../../lib/game/cloud-knobs';

interface Props {
  getEngine: () => GameEngine | null;
}

const PRESETS: { label: string; tip: string }[] = [
  { label: 'quality', tip: '满步数 + 窄核(接近原库观感)' },
  { label: 'balanced', tip: '步数中等 + 略宽核(出厂等价档)' },
  { label: 'perf', tip: 'march 半分辨率 + 宽核补回来' },
  { label: 'lowest', tip: '弱机: 十字核 + 大步长' },
];

/** 开销标签(小圆角框; 等级与说明都来自描述表的实测口径) */
function CostTag({ cost }: { cost?: CloudKnob['cost'] }) {
  if (!cost) return null;
  const c = COST_LABEL[cost];
  return <span title={c.tip} className={`shrink-0 px-1 text-[8px] border leading-[13px] ${c.color}`}>{c.text}</span>;
}

export function CloudTuner({ getEngine }: Props) {
  const [open, setOpen] = useState(false);
  const [frozen, setFrozen] = useState(true);
  const [tick, setTick] = useState(0);
  const [msg, setMsg] = useState('拖动即生效；与 vcloud 同源；开销标签是实测口径');
  const [textBox, setTextBox] = useState<string | null>(null);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const eng = () => getEngine();
  const bump = () => setTick((t) => t + 1);

  // ---- 打开/关闭: 控制台命令派发事件; URL `#tuner` 直接开; F2 切换 --------
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent<{ open?: boolean }>).detail;
      if (d && typeof d.open === 'boolean') setOpen(d.open);
      else setOpen((o) => !o);
    };
    window.addEventListener('skybound:tuner', handler as unknown as EventListener);
    if (typeof location !== 'undefined' && location.hash.includes('tuner')) setOpen(true);
    return () => window.removeEventListener('skybound:tuner', handler as unknown as EventListener);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'F2') { e.preventDefault(); setOpen((o) => !o); return; }
      if (e.code === 'Escape' && open) { e.preventDefault(); setOpen(false); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  // ---- 开关的副作用: 冻结世界 + 让出指针锁 + 给引擎一个门控旗标 ------------------
  useEffect(() => {
    (window as unknown as { __cloudTunerOpen?: boolean }).__cloudTunerOpen = open;
    const e = eng();
    if (!e) return undefined;
    if (open) { e.releasePointerLock(); e.setDebugPaused(true); setFrozen(true); }
    else { e.setDebugPaused(false); }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const applyFrozen = useCallback((f: boolean) => {
    setFrozen(f);
    const e = eng();
    if (!e) return;
    e.setDebugPaused(f);
    if (f) e.releasePointerLock();
  }, []);

  const write = useCallback((k: CloudKnob, v: number) => {
    const e = eng();
    if (!e) return;
    e.setCloudKnob(k.name, v, k.lo, k.hi);
    bump();
  }, []);

  const resetOne = useCallback((k: CloudKnob) => {
    const e = eng();
    if (!e) return;
    setMsg(e.resetCloudKnob(k.name));
    bump();
  }, []);

  const writeFlag = useCallback((f: CloudFlag, value: string) => {
    const e = eng();
    if (!e) return;
    setMsg(e.setCloudFlag(f.name, value));
    bump();
  }, []);

  const runCmd = useCallback((cmd: string) => {
    const e = eng();
    if (!e) return;
    setMsg(e.setDebugView(cmd).split('\n')[0]);
    bump();
  }, []);

  // ---- 导出 / 保存 / 导入 --------------------------------------------------------
  const showText = useCallback(async (txt: string, note: string) => {
    setTextBox(txt);
    try { await navigator.clipboard.writeText(txt); setMsg(`${note}（已复制到剪贴板，也可从下面手动复制）`); }
    catch { setMsg(`${note}（剪贴板被拒，请从下面手动复制）`); }
    bump();
    requestAnimationFrame(() => { boxRef.current?.focus(); boxRef.current?.select(); });
  }, []);

  /** ① 导出为可粘贴的命令(只含改过的项) */
  const exportCmds = useCallback(() => {
    const e = eng();
    if (!e) return '';
    const snap = e.cloudPresetSnapshot();
    const lines: string[] = [];
    for (const [n, v] of Object.entries(snap.knobs)) { const k = CLOUD_KNOB_GROUPS.flatMap((g) => g.items).find((x) => x.name === n); lines.push(k ? cloudKnobCmd(k, v) : `vcloud ${n} ${v}`); }
    for (const [n, v] of Object.entries(snap.flags)) lines.push(`vcloud ${n} ${v}`);
    return lines.length ? lines.join('\n') : '(没有改过任何项 = 全是出厂默认)';
  }, []);

  /** ② 导出为 JSON 文件(可存档/传给别人/贴给我) */
  const exportFile = useCallback(() => {
    const e = eng();
    if (!e) return;
    const snap = e.cloudPresetSnapshot();
    const blob = new Blob([JSON.stringify(snap, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cloud-preset-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    setMsg(`已下载 ${a.download}（${Object.keys(snap.knobs).length} 个数值 + ${Object.keys(snap.flags).length} 个开关）`);
    bump();
  }, []);

  /** ③ 导入 JSON 文件 */
  const importFile = useCallback((f: File) => {
    const e = eng();
    if (!e) return;
    const r = new FileReader();
    r.onload = () => {
      try { setMsg(e.applyCloudPresetSnapshot(JSON.parse(String(r.result)))); bump(); }
      catch { setMsg('导入失败: 不是合法 JSON'); }
    };
    r.readAsText(f);
  }, []);

  /** ④ 一键诊断(贴回给我): 含"键值 vs 运行时值"的对比 */
  const diag = useCallback(() => {
    const e = eng();
    if (!e) return;
    void showText(e.cloudDiagText(), '诊断文本已生成');
  }, [showText]);

  const saveNamed = useCallback(() => {
    const e = eng();
    if (!e) return;
    const name = window.prompt('预设名字(仅本地保存):', `预设${new Date().toTimeString().slice(0, 5)}`);
    if (!name) return;
    setMsg(e.cloudPresetSave(name));
    bump();
  }, []);

  const loadNamed = useCallback(() => {
    const e = eng();
    if (!e) return;
    const list = e.cloudPresetList();
    if (!list.length) { setMsg('还没有保存过预设（先点"保存为预设"）'); bump(); return; }
    const name = window.prompt(`载入哪个预设?\n已有: ${list.join(' / ')}`, list[0]);
    if (!name) return;
    setMsg(e.cloudPresetLoad(name));
    bump();
  }, []);

  if (!open) return null;
  const e = eng();
  const rank: Record<string, number> = { 免费: 0, 低: 1, 中: 2, 高: 3, 线性: 4 };

  return (
    <div
      className="absolute right-3 top-3 z-50 w-[26rem] max-w-[94vw] max-h-[94vh] overflow-y-auto font-mono text-[11px] leading-relaxed"
      style={{ background: 'rgba(4, 10, 18, 0.93)', border: '1px solid rgba(90, 200, 255, 0.35)', boxShadow: '0 0 24px rgba(0, 120, 200, 0.25)', backdropFilter: 'blur(3px)' }}
    >
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--crt-line)]/20 sticky top-0 z-10" style={{ background: 'rgba(4, 10, 18, 0.97)' }}>
        <span className="text-[var(--crt-amber)] tracking-[0.25em]">CLOUD TUNER</span>
        <div className="flex items-center gap-2">
          <button onClick={() => applyFrozen(!frozen)}
            className={`px-1.5 py-0.5 text-[10px] border transition-colors ${frozen ? 'border-[var(--crt-amber)]/50 text-[var(--crt-amber)] hover:bg-[var(--crt-amber)]/10' : 'border-[var(--crt-line)]/30 text-[var(--crt-amber-hi)]/60 hover:border-[var(--crt-amber)]'}`}
            title={frozen ? '世界已冻结(无运动噪声, 判断画质更准) —— 点它解冻可边飞边调' : '世界在跑 —— 点它冻结'}>
            {frozen ? '❄ 已冻结' : '✈ 边飞边调'}
          </button>
          <button onClick={() => setOpen(false)} className="text-[var(--crt-amber)]/50 hover:text-[var(--crt-amber)] text-[10px]">F2 / ESC 关闭</button>
        </div>
      </div>

      {/* 状态行 */}
      <div className="px-3 py-1 text-[10px] text-[var(--crt-amber-hi)]/70 border-b border-[var(--crt-line)]/20 whitespace-pre-wrap">{msg}</div>
      {!e && <div className="px-3 py-2 text-red-400">没有引擎(还没进关卡?)</div>}

      {/* 档位 + 保存/导出 */}
      <div className="px-3 py-2 border-b border-[var(--crt-line)]/20">
        <div className="text-[9px] text-[var(--crt-amber)]/40 tracking-[0.25em] mb-1">画质档 / 保存 / 导出</div>
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <button key={p.label} onClick={() => runCmd(`vcloud preset ${p.label}`)} title={p.tip}
              className="px-1.5 py-0.5 text-[10px] border border-[var(--crt-line)]/25 text-[var(--crt-amber-hi)]/80 hover:border-[var(--crt-amber)] hover:text-[var(--crt-amber)] hover:bg-[var(--crt-amber)]/10 transition-colors">
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1 mt-1">
          <button onClick={saveNamed} title="存进 localStorage(换浏览器/清缓存会丢; 要长期留用右边两个)"
            className="px-1.5 py-0.5 text-[10px] border border-emerald-400/40 text-emerald-300/90 hover:bg-emerald-400/10">保存为预设</button>
          <button onClick={loadNamed} className="px-1.5 py-0.5 text-[10px] border border-emerald-400/40 text-emerald-300/90 hover:bg-emerald-400/10">载入预设</button>
          <button onClick={exportFile} title="下载 JSON 快照(只含改过的项)"
            className="px-1.5 py-0.5 text-[10px] border border-sky-400/40 text-sky-300/90 hover:bg-sky-400/10">导出文件</button>
          <button onClick={() => fileRef.current?.click()} className="px-1.5 py-0.5 text-[10px] border border-sky-400/40 text-sky-300/90 hover:bg-sky-400/10">导入文件</button>
          <input ref={fileRef} type="file" accept=".json,application/json" className="hidden"
            onChange={(ev) => { const f = ev.target.files?.[0]; if (f) importFile(f); ev.target.value = ''; }} />
          <button onClick={() => void showText(exportCmds(), '改动命令已生成')} title="生成一串 vcloud 命令, 可直接粘给我"
            className="px-1.5 py-0.5 text-[10px] border border-sky-400/40 text-sky-300/90 hover:bg-sky-400/10">导出命令</button>
          <button onClick={diag} title={'把"排查噪点要看的全部事实"打成文本(含键值 vs 运行时值的分歧)'}
            className="px-1.5 py-0.5 text-[10px] border border-amber-400/50 text-amber-300 hover:bg-amber-400/10">一键诊断</button>
          <button onClick={() => runCmd('vcloud reset')} className="px-1.5 py-0.5 text-[10px] border border-red-400/40 text-red-300/90 hover:bg-red-400/10">全部复位</button>
        </div>
        {textBox !== null && (
          <div className="mt-1">
            <textarea ref={boxRef} readOnly value={textBox} rows={6} spellCheck={false}
              className="w-full bg-black/50 text-[10px] text-[var(--crt-amber)] outline-none p-1 border border-[var(--crt-line)]/30" />
            <button onClick={() => setTextBox(null)} className="text-[9px] text-[var(--crt-amber)]/50 hover:text-[var(--crt-amber)]">收起</button>
          </div>
        )}
      </div>

      {/* 布尔/档位 */}
      {CLOUD_FLAG_GROUPS.map((g) => (
        <div key={g.label} className="px-3 py-2 border-b border-[var(--crt-line)]/20">
          <div className="text-[9px] text-[var(--crt-amber)]/40 tracking-[0.25em] mb-1">{g.label.toUpperCase()}</div>
          {g.note && <div className="text-[9px] text-[var(--crt-amber-hi)]/45 mb-1">{g.note}</div>}
          {g.items.map((f) => {
            const [onV, offV] = f.values ?? ['on', 'off'];
            const cur = e ? e.cloudFlagValue(f.key, f.def ? onV : offV) : (f.def ? onV : offV);
            const isOn = cur === onV || cur === '1';
            return (
              <div key={f.name} className="flex items-center gap-1.5 py-0.5">
                <button onClick={() => writeFlag(f, isOn ? offV : onV)} title={f.hint ?? ''}
                  className={`w-[3.2rem] shrink-0 px-1 py-0.5 text-[10px] border transition-colors ${isOn ? 'border-[var(--crt-amber)]/60 text-[var(--crt-amber)] bg-[var(--crt-amber)]/10' : 'border-[var(--crt-line)]/25 text-[var(--crt-amber-hi)]/50'}`}>
                  {isOn ? 'ON' : 'OFF'}
                </button>
                <CostTag cost={f.cost} />
                <span className="flex-1 text-[10px] text-[var(--crt-amber-hi)]/80">{f.label}{f.needsReload ? ' ·需重进关' : ''}</span>
                {f.extra?.map((x) => (
                  <button key={x.value} onClick={() => writeFlag(f, x.value)}
                    className="px-1 py-0.5 text-[9px] border border-[var(--crt-line)]/25 text-[var(--crt-amber-hi)]/60 hover:border-[var(--crt-amber)]">{x.label}</button>
                ))}
                {cur !== onV && cur !== offV && <span className="text-[9px] text-[var(--crt-amber)]/60">={cur}</span>}
              </div>
            );
          })}
        </div>
      ))}

      {/* 数值滑条 */}
      {CLOUD_KNOB_GROUPS.map((g) => {
        const most = g.items.reduce((a, b) => (rank[COST_LABEL[b.cost].text] > rank[COST_LABEL[a.cost].text] ? b : a));
        return (
          <div key={g.label} className="px-3 py-2 border-b border-[var(--crt-line)]/20">
            <div className="flex items-baseline gap-2">
              <span className="text-[9px] text-[var(--crt-amber)]/40 tracking-[0.25em]">{g.label.toUpperCase()}</span>
              <span className="text-[9px] text-[var(--crt-amber-hi)]/35">最贵: {most.label}</span>
            </div>
            {g.note && <div className="text-[9px] text-[var(--crt-amber-hi)]/45 mb-1">{g.note}</div>}
            {g.items.map((k) => {
              const { v, changed } = e ? e.cloudKnobValue(k.key, k.def, k.lo, k.hi) : { v: k.def, changed: false };
              const fmt = (x: number) => (k.step >= 1 ? String(Math.round(x)) : x.toFixed(k.step >= 0.05 ? 2 : 3));
              return (
                <div key={k.name} className="py-[3px]">
                  <div className="flex items-center gap-1">
                    <CostTag cost={k.cost} />
                    <span className="text-[10px] text-[var(--crt-amber-hi)]/85 flex-1">
                      {k.label}{k.unit ? <span className="text-[var(--crt-amber-hi)]/40"> ({k.unit})</span> : null}
                    </span>
                    <span className="text-[10px] text-[var(--crt-amber)] tabular-nums">{fmt(v)}</span>
                    {changed && <span className="text-[9px] text-emerald-300/80" title="键存在 = 改过">*</span>}
                    <button onClick={() => resetOne(k)} title={`复位(${k.key}; 默认 ${k.def})`}
                      className="text-[9px] text-[var(--crt-amber)]/40 hover:text-[var(--crt-amber)]">↺</button>
                  </div>
                  <input type="range" min={k.lo} max={k.hi} step={k.step} value={v}
                    onChange={(ev) => write(k, Number(ev.target.value))}
                    className="w-full h-[10px] accent-[var(--crt-amber)]"
                    title={`${k.name}  ${k.lo}..${k.hi}  默认 ${k.def}${k.hint ? '  |  ' + k.hint : ''}`} />
                  {k.hint && <div className="text-[9px] text-[var(--crt-amber-hi)]/40 leading-tight">{k.hint}</div>}
                </div>
              );
            })}
          </div>
        );
      })}

      <div className="px-3 py-2 text-[9px] text-[var(--crt-amber-hi)]/45">
        改完想留档 → 导出文件(JSON) 或 导出命令(贴给我做关卡默认值)。
        <br />数值与手敲 <span className="text-[var(--crt-amber)]">vcloud &lt;名&gt; &lt;值&gt;</span> 完全同源。
        排查噪点先点 <span className="text-[var(--crt-amber)]">一键诊断</span>(会对比"键值 vs 运行时值")。
      </div>
    </div>
  );
}
