// === 关卡内调试控制台 (per user request: ` 键查看各种渲染层) ===
// Press Backquote (`) in a mission to open a console:
//   - type a command + Enter, or click a button in the quick-select menu
//   - Escape / ` again to close
// Opening the console freezes the world (engine.debugPaused — update loop
// stops, RAF keeps rendering so view switches apply instantly) and disables
// game input (typing can't fly the aircraft). Commands are forwarded to
// engine.setDebugView() / setPipelineCmd().
//
// Available views:
//   lit / wireframe / lod / radar
//   albedo / normal / ao / roughness / metalness / emissive / depth (G-Buffer
//   channels — need the deferred pipeline: type "pipeline deferred" first)
import { useEffect, useRef, useState } from 'react';
import type { GameEngine } from '../../lib/game/engine';

interface Props {
  getEngine: () => GameEngine | null;
}

const VIEW_GROUPS: { label: string; cmds: string[] }[] = [
  {
    label: 'RENDER VIEWS',
    cmds: ['lit', 'wireframe', 'ssgi', 'lod', 'radar'],
  },
  {
    label: 'G-BUFFER (DEFERRED)',
    cmds: ['albedo', 'normal', 'ao', 'roughness', 'metalness', 'emissive', 'depth'],
  },
  {
    label: 'PIPELINE',
    cmds: ['pipeline forward', 'pipeline deferred', 'pipeline auto'],
  },
  {
    label: 'OVERLAYS',
    cmds: ['fps', 'colliders', 'hitlines'],
  },
  {
    label: 'TERRAIN TEXTURE',
    cmds: ['tilesize 30', 'tilesize 60', 'tilesize 90', 'tilesize 120'],
  },
  {
    label: 'SHADOW RES (SELF)',
    cmds: ['shadowres 512', 'shadowres 1024', 'shadowres 2048', 'shadowres 4096'],
  },
  // === 阴影排查工具 (per user request: 用 three 自带工具直接看阴影贴图本身) ===
  // shadowmap → ShadowMapViewer 把当前生效那只灯的深度图贴在右下角;
  // shadowcam → CameraHelper 画出阴影相机视锥(是否包住机体)。
  {
    label: 'SHADOW DEBUG',
    cmds: ['shadowmap', 'shadowcam', 'shadowinfo', 'shadowbias 0 1', 'shadowbias -0.0005 1', 'shadowbias 0 2.5'],
  },
  {
    label: 'SUN ANGLE',
    cmds: ['sun', 'sun auto', 'sun 90 30', 'sun 180 15', 'sun 270 45'],
  },
  {
    // === 实时雾密度 (per user request: 控制台实时调雾;编辑器同款 FogExp2) ===
    label: 'FOG (实时雾密度)',
    cmds: ['fog 0', 'fog 0.00003', 'fog 0.00006', 'fog 0.00012', 'fog 0.00025', 'fog 0.0005'],
  },
  {
    // === 高度雾 v2 (per user request: 修复并重做) ===
    // 屏幕空间解析积分的指数高度雾, 目标是**抹平远处地平线与天际线**(把远地形融进天空色)。
    // hfog 0 = 关; 0.3 轻雾(远山还清楚); 0.6 中; 0.9 重(地平线几乎完全融进天空)。
    label: 'HEIGHT FOG (高度雾 v2 · 抹平地平线)',
    cmds: ['hfog 0', 'hfog 0.3', 'hfog 0.6', 'hfog 0.9'],
  },
  {
    // === 体积云 v2 (per user request: 彻底重做; 高度与贴片云一致) ===
    // 不带参数的 vcloud 会打印两层高度带(base 与贴片云同源)与 pass 状态;
    // 开着时贴片云自动隐藏, 关掉立刻回到贴片云 —— 现场 A/B 很方便。
    // §321: tuner = 打开右上角的**滑条面板**(手敲数字太难受时的入口; 也可按 F2)
    label: 'VOLUME CLOUDS (体积云 v2 · 滑条面板: tuner / F2)',
    cmds: ['tuner', 'vcloud', 'vcloud on', 'vcloud off', 'vcloud cov 0.15', 'vcloud cov 0.30', 'vcloud cov 0.6', 'vcloud low', 'vcloud med', 'vcloud high'],
  },
  {
    // === 镜头缩放读数 + 气流扰动 (per user request: 关卡内控制台手动点) ===
    // zoomhud → 在**过载值 G 下方**显示 4 位小数的缩放倍率(临时读数, 默认关);
    // zoom <倍率> → 相对默认机位精确设定放大倍率; airflow [倍数] → 读/写机体气流扰动幅度。
    label: 'CAMERA / AIRFLOW (镜头·气流)',
    cmds: ['zoomhud', 'zoomhud 0', 'zoom 1', 'zoom 1.25', 'zoom 0.8', 'airflow', 'airflow 0.5', 'airflow 1.5'],
  },
  {
    // === 尾喷口 / 凝结云现场对齐 (per user request: 位置+缩放, 自动保存) ==========
    // 先敲不带参数的那条看当前状态(nozzle 会打印自动测量出来的喷口截面/口径,
    // "估计"= 没量到几何; vapor 会强制显示凝结云面片并打印翼形站位)。
    // 调完的数值自动记进 localStorage, 下次进关仍然生效; reset 回自动结果。
    label: 'NOZZLE / VAPOR (尾喷口·凝结云)',
    cmds: [
      'nozzle', 'vapor',
      'nozzle 0 -0.3 0.2 1 1 1.2', 'vapor 0 0 0.5 1 1 1.1',
      'nozzle reset', 'vapor reset', 'vapor off',
    ],
  },
  {
    // §327 性能实时记录器 (per user request): 录制期间右下角有 ● REC 角标; 导出 json/csv 后可发我分析
    label: 'PERF REC (性能记录器)',
    cmds: ['rec start', 'rec stop', 'rec', 'rec note 标记', 'rec rate 50', 'rec gpu off', 'rec export', 'rec csv', 'rec dump', 'rec clear'],
  },
  {
    label: 'AIRCRAFT SELF-SHADOW (机体自阴影)',
    cmds: ['shadowtex', 'shadowtex strength 1', 'shadowtex strength 0.5', 'shadowtex strength 0', 'shadowtex floor 0.3', 'shadowtex ambient 1', 'shadowtex soft 0', 'shadowtex soft 6'],
  },
  {
    label: 'MISC',
    cmds: ['reset', 'help'],
  },
];

export function DebugConsole({ getEngine }: Props) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [out, setOut] = useState<string[]>(['type "help" or click a command below']);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Backquote toggles the console; Escape closes it. Registered in the
  // CAPTURE phase so game-level key handlers never see the toggling keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Backquote') {
        e.preventDefault();
        e.stopPropagation();
        setOpen((o) => !o);
        return;
      }
      if (e.code === 'Escape' && open) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  // Freeze the world + disable game input while open; unfreeze on close.
  useEffect(() => {
    (window as any).__debugConsoleOpen = open;
    const eng = getEngine();
    if (eng) eng.setDebugPaused(open);
    if (open) {
      // Focus the input on the next frame so the capture-phase handler is
      // already installed.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    return () => {
      (window as any).__debugConsoleOpen = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const run = (cmd: string) => {
    const eng = getEngine();
    if (!eng) {
      setOut((o) => [...o.slice(-19), '[no engine]']);
      return;
    }
    let msg: string;
    if (cmd.startsWith('pipeline ')) {
      msg = eng.setPipelineCmd(cmd.slice(9).trim());
    } else {
      msg = eng.setDebugView(cmd);
    }
    setOut((o) => [...o.slice(-19), `> ${cmd}\n${msg}`]);
  };

  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    const cmd = input.trim();
    if (!cmd) return;
    run(cmd);
    setInput('');
  };

  if (!open) return null;

  return (
    <div
      className="absolute left-3 top-3 z-50 w-[26rem] max-w-[92vw] max-h-[70vh] overflow-y-auto font-mono text-[11px] leading-relaxed"
      style={{
        background: 'rgba(4, 10, 18, 0.88)',
        border: '1px solid rgba(90, 200, 255, 0.35)',
        boxShadow: '0 0 24px rgba(0, 120, 200, 0.25)',
        backdropFilter: 'blur(3px)',
      }}
    >
      {/* Title bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--crt-line)]/20">
        <span className="text-[var(--crt-amber)] tracking-[0.3em]">DEBUG CONSOLE</span>
        <span className="text-[var(--crt-amber)]/40">` / ESC 关闭</span>
      </div>

      {/* Output log */}
      <div className="px-3 py-1.5 text-[var(--crt-amber-hi)]/80 whitespace-pre-wrap max-h-[24vh] overflow-y-auto">
        {out.map((l, i) => (
          <div key={i} className={l.startsWith('>') ? 'text-[var(--crt-amber)]' : 'text-[var(--crt-amber-hi)]/70'}>{l}</div>
        ))}
      </div>

      {/* Input line */}
      <div className="flex items-center px-3 py-1 border-t border-[var(--crt-line)]/20 bg-black/40">
        <span className="text-[var(--crt-amber)] mr-1">&gt;</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onEnter}
          spellCheck={false}
          autoComplete="off"
          className="flex-1 bg-transparent outline-none text-[var(--crt-amber)] placeholder:text-[var(--crt-amber)]/30"
          placeholder="command + Enter…"
        />
      </div>

      {/* Quick-select menu */}
      <div className="px-3 py-2 border-t border-[var(--crt-line)]/20">
        {VIEW_GROUPS.map((g) => (
          <div key={g.label} className="mb-1.5">
            <div className="text-[9px] text-[var(--crt-amber)]/40 tracking-[0.25em] mb-1">{g.label}</div>
            <div className="flex flex-wrap gap-1">
              {g.cmds.map((c) => (
                <button
                  key={c}
                  onClick={() => run(c)}
                  className="px-1.5 py-0.5 text-[10px] border border-[var(--crt-line)]/25 text-[var(--crt-amber-hi)]/80 hover:border-[var(--crt-amber)] hover:text-[var(--crt-amber)] hover:bg-[var(--crt-amber)]/10 transition-colors"
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// 屏上诊断面板 (per user request: 单文件/上传后不用 F12 也能看到关键状态)
// ============================================================================
// 为什么需要它: 用户在**上传后的单文件**里看不到地形, 而我用 headless + 服务器
// 测都复现不出来 —— 两条路的资源加载方式不同, 必须拿到用户那台机器的现场数据。
// 打开方式: 在 URL 末尾加 `#diag`(例如 index.html#diag), 面板出现在右上角。
//   · 红色行 = 异常(会在第一时间暴露是哪个环节挂了)
//   · 数字每 0.5s 刷新, 可以直接截图给我
// 不改变任何渲染/游戏逻辑, 只是把引擎已有状态读出来显示。
// ============================================================================
export function DiagOverlay({ getEngine }: Props) {
  const [show, setShow] = useState(false);
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    const on = typeof location !== 'undefined' && location.hash.includes('diag');
    setShow(on);
    if (!on) return undefined;
    const id = window.setInterval(() => {
      const E = getEngine() as unknown as {
        mapType?: string; missionTime?: number; _terrainChunks?: { meshes: { visible: boolean; geometry?: { attributes?: { position?: { count: number } } } }[] }[];
        _terrainHeightFn?: (x: number, z: number) => number; scene?: { fog?: unknown }; _f16cModel?: unknown;
      } | null;
      const M = (window as unknown as { __ASSET_MANIFEST?: Record<string, string> }).__ASSET_MANIFEST ?? {};
      const errs = (window as unknown as { __jsErrors?: string[] }).__jsErrors ?? [];
      const gl = (window as unknown as { __glErrors?: string[] }).__glErrors ?? [];
      const out: string[] = [];
      out.push(`proto ${typeof location !== 'undefined' ? location.protocol : '?'}  keys ${Object.keys(M).length}`);
      // === 完整报错(不截断) ===
      // 着色器编译失败时, 浏览器的报错里含**具体哪一行/哪个符号**未声明 ——
      // 那正是定位所需的唯一信息, 所以这里把整条原文摊开显示(带换行折行)。
      out.push(`ERR ${errs.length}`);
      if (errs.length) out.push(String(errs[0]).slice(0, 320));
      out.push(`GL  ${gl.length}`);
      if (gl.length) out.push(String(gl[0]).slice(0, 320));
      if (!E) { out.push('engine NONE'); setLines(out); return; }
      const ch = E._terrainChunks ?? [];
      let vis = 0, hid = 0, verts = 0;
      for (const c of ch) {
        let any = false;
        for (const m of c.meshes) { if (m.visible) { any = true; verts += m.geometry?.attributes?.position?.count ?? 0; } }
        if (any) vis++; else hid++;
      }
      out.push(`map ${E.mapType ?? '?'}  t ${Math.round(E.missionTime ?? 0)}s`);
      out.push(`chunks ${ch.length}  vis ${vis}  hid ${hid}`);
      out.push(`verts ${verts}`);
      const h0 = E._terrainHeightFn ? Math.round(E._terrainHeightFn(0, 0)) : NaN;
      out.push(`h(0,0) ${Number.isFinite(h0) ? h0 : 'n/a'}`);
      out.push(`fog ${E.scene?.fog ? 'Y' : 'N'}  f16c ${E._f16cModel ? 'Y' : 'N'}`);
      // === 机体面朝向自检 (per bug: F-16 从顶部能透视看到底部) ===
      // "看穿"由 **winding + material.side** 决定, 与 normalScale/顶点法线无关。
      // 判定: 取一个**朝上的三角形**(其顶点法线 y>0.5), 算它的**几何面法线**
      // (v1-v0)×(v2-v0); 两者点积 < 0 说明顶点顺序与法线相反 → three 会把正面
      // 判成背面并剔除 → 从上方看穿到内部。dot 符号就是判决结果。
      const fm = (E as unknown as { _f16cModel?: { group?: { traverse?: (f: (o: unknown) => void) => void } } })._f16cModel;
      let upTris = 0, backTris = 0, side0 = 0;
      if (fm?.group?.traverse) {
        fm.group.traverse((o: unknown) => {
          const mesh = o as { isMesh?: boolean; geometry?: { attributes?: Record<string, { count: number; getX: (i: number) => number; getY: (i: number) => number; getZ: (i: number) => number }>; index?: unknown }; material?: { side?: number } };
          if (!mesh.isMesh || !mesh.geometry || mesh.geometry.index) return;
          if (side0 === 0 && mesh.material && typeof mesh.material.side === 'number') side0 = mesh.material.side;
          const p = mesh.geometry.attributes?.position;
          const n = mesh.geometry.attributes?.normal;
          if (!p || !n) return;
          const step = Math.max(3, Math.floor(p.count / 900) * 3);
          for (let i = 0; i + 2 < p.count; i += step) {
            const ny = (n.getY(i) + n.getY(i + 1) + n.getY(i + 2)) / 3;
            if (ny < 0.5) continue;   // 只看"朝上"的三角形
            upTris++;
            const ax = p.getX(i + 1) - p.getX(i), ay = p.getY(i + 1) - p.getY(i), az = p.getZ(i + 1) - p.getZ(i);
            const bx = p.getX(i + 2) - p.getX(i), by = p.getY(i + 2) - p.getY(i), bz = p.getZ(i + 2) - p.getZ(i);
            // 几何面法线 y 分量 = az*bx - ax*bz(只判符号即可)
            const faceNy = az * bx - ax * bz;
            if (faceNy < 0) backTris++;
          }
        });
      }
      out.push(`face: up ${upTris} wrong ${backTris} side ${side0}`);
      // === §39 历史根因现场自检 ===
      // 症状"地表不渲染、只剩 LOD 分块切面(skirt)"在项目档案 §39 有记录:
      // 延迟渲染(deferred)G-Buffer 注入曾用 `vMapUv`, 而 r185 只在 USE_MAP 下
      // 声明它 —— 分层地形有 roughnessMap 但**没有 map** → vMapUv 未声明 →
      // 着色器编译失败 → 表面消失、只剩裙边(修复已改用 vRoughnessMapUv)。
      // 这里把管线与编译报错直接摆到屏上, 现场一眼可见。
      const pl = (window as unknown as { __pipeline?: string }).__pipeline;
      out.push(`pipeline ${pl ?? '?'}`);
      // 延迟注入的真实运行时开关(与 pipeline 设置**不是**同一个值:
      // deferredActive 会被任务/材质状态另外改写, 而延迟注入才是让地形材质
      // 多出一段 G-Buffer 代码、进而可能编译失败的那条路径)。
      const da = (E as unknown as { deferredActive?: boolean }).deferredActive;
      out.push(`deferredActive ${da === undefined ? '?' : da ? 'Y' : 'N'}`);
      if (gl.length > 0) {
        out.push('!! SHADER FAIL - see S39');
        // 把**完整**报错摊出来: 里面有出错行号与未声明的符号名, 那才是定位依据。
        // 单独用红色块显示, 保证截图时能看清。
        out.push('---- FULL ERROR ----');
        for (const e of gl.slice(0, 2)) out.push(String(e));
      }
      setLines(out);
    }, 500);
    return () => window.clearInterval(id);
  }, [getEngine]);

  if (!show) return null;
  return (
    <div
      className="pointer-events-none fixed right-2 top-24 z-[60] font-mono text-[10px] leading-tight"
      style={{ background: 'rgba(0,0,0,0.72)', border: '1px solid rgba(255,176,0,0.5)', padding: '4px 6px', color: '#ffb000' }}
    >
      {lines.map((l, i) => (
        <div key={i} style={{ color: /ERR [1-9]|GL  [1-9]|NONE|n\/a/.test(l) ? '#ff5a5a' : '#ffb000' }}>{l}</div>
      ))}
    </div>
  );
}
