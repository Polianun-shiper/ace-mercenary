// === GPU 逐 pass 剖析器(游戏内控制台 `gpup`) ===================================
//
// 为什么要把探针脚本搬进游戏: "对准天顶 GPU 突然 100%" 这类问题**强依赖具体机器**
// (分辨率/显卡/关卡/画质档), 我在这台机器上量不出你看到的 100%(1280x720 下天顶 18ms、
// 几何量反而更少)。所以给你一把**能在你自己的机器上、指着你要看的画面按一下**的尺子。
//
// 它量什么(单位都是毫秒, 除非注明):
//   · **每个 composer pass 的 GPU 时间**(EXT_disjoint_timer_query_webgl2 计时查询);
//   · **composer 之外的 GPU 大头**: `updateAtmosphere`(每帧烤 sky-view/aerial LUT)、
//     `updateProjectedShadow`(2048² 机体自阴影 RT) —— 这两块**不在 pass 列表里**,
//     用逐 pass 表看不见, 实测下来恰恰是最容易被忽略的盲区;
//   · **提交 vs 排空**: `composer.render()` 的 CPU 提交耗时 + 随后 `gl.finish()` 的排空耗时
//     ⇒ 立刻能分清"卡在 CPU 提交"还是"卡在 GPU 算力";
//   · 每帧 draw calls / triangles(GPU 忙而 calls 少 = 填充率; calls 跟着涨 = 几何)。
//
// ⚠ 两个必须知道的实现细节(踩过):
//   ① **QUERY_RESULT_AVAILABLE 不会在同步循环里翻** —— 必须在帧与帧之间让出事件循环
//      (游戏本身的 RAF 循环天然满足; 探针脚本里要显式 setTimeout(0))。只查一次会拿到空表。
//   ② 开启剖析会在每帧后加一次 `gl.finish()`(硬同步) ⇒ **帧率会掉**, 这是测量代价, 不是 bug。
//      所以默认关, 只在 `gpup` 打开期间生效。
import * as THREE from 'three';

/**
 * 给 composer pass 起个**可读的标签**(压缩后构造函数名是无意义的 `v5`/`hI`, 靠特征属性认人)。
 * 这套指纹与探针 `_gpuprof.mjs`/`_skygpu.mjs` 一致, 便于两边对照。
 */
export function describePass(p: unknown, i: number): string {
  const o = p as Record<string, unknown> & {
    getEffect?: unknown;
    setLuts?: unknown;
    mat?: { uniforms?: Record<string, unknown> };
    uniforms?: Record<string, unknown>;
    material?: unknown;
    scene?: unknown;
  };
  let tag = '';
  if (typeof o.getEffect === 'function') tag = '云pass(takram)';
  else if (o.mat?.uniforms?.uSunGate) tag = '屏幕光柱';
  else if (typeof o.setLuts === 'function') tag = '大气透视AP';
  // GTAO 的特征是 `gtaoMaterial`(three 的 GTAOPass 不暴露 .uniforms/.material),
  // 它也有 `.scene`, 所以必须在 scene 之前判(否则两个 pass 都显示"渲染pass(场景)")
  else if ((o as { gtaoMaterial?: unknown }).gtaoMaterial || o.uniforms?.radius !== undefined) tag = 'GTAO';
  else if (o.mat?.uniforms && (o.mat.uniforms as Record<string, unknown>).uScene) tag = '高度雾';
  else if (o.scene) tag = '渲染pass(场景)';
  else if (typeof (o as { strength?: unknown }).strength === 'number') tag = 'Bloom';
  else if ((o as { isOutputPass?: unknown }).isOutputPass) tag = '输出(色调映射)';
  else if (o.material) tag = '材质全屏pass';
  const name = (p as { constructor?: { name?: string } })?.constructor?.name ?? 'pass';
  return `${i}:${name}${tag ? '·' + tag : ''}`;
}

/** 一条被计时的对象: 名字 + 取 render 的宿主 + 原本的 render */
interface Timed {
  label: string;
  host: Record<string, unknown>;
  key: string;
  orig: (...a: unknown[]) => unknown;
}

interface Query {
  slot: number;
  query: WebGLQuery;
}

export class GpuProfiler {
  private gl: WebGL2RenderingContext | null = null;
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  private timed: Timed[] = [];
  private queue: Query[] = [];
  private free: WebGLQuery[] = [];
  private acc: number[][] = [];          // 每个 slot 的样本(ms)
  /** §324: 当前量的是什么(表头显示) —— `gpup` 与 `gpup cloud` 是**互斥**的两种模式 */
  private modeNote = 'composer 逐 pass';
  private frames = 0;
  private disjoint = 0;
  private lastSubmitMs = 0;
  private lastDrainMs = 0;
  private lastCalls = 0;
  private lastTris = 0;
  private enabled = false;

  get isOn(): boolean { return this.enabled; }

  /** 挂上(幂等): 把每个 composer pass + 两个 composer 外的 GPU 大头包一层计时查询。 */
  install(
    renderer: THREE.WebGLRenderer,
    passes: Array<{ label: string; obj: Record<string, unknown> }>,
    extra: Array<{ label: string; obj: Record<string, unknown>; key: string }>,
  ): boolean {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as unknown as
      { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
    if (!ext) { this.gl = null; return false; }
    this.gl = gl;
    this.ext = ext;
    if (this.timed.length) { this.enabled = true; return true; }   // 已挂过
    const targets: Array<[string, Record<string, unknown>, string]> = [
      ...passes.map((p) => [p.label, p.obj, 'render'] as [string, Record<string, unknown>, string]),
      ...extra.map((e) => [e.label, e.obj, e.key] as [string, Record<string, unknown>, string]),
    ];
    for (const [label, obj, key] of targets) {
      const orig = obj[key] as ((...a: unknown[]) => unknown) | undefined;
      if (typeof orig !== 'function') continue;
      const slot = this.timed.length;
      const bound = orig.bind(obj);
      this.timed.push({ label, host: obj, key, orig: bound });
      obj[key] = (...args: unknown[]) => {
        if (!this.enabled || !this.gl || !this.ext) return bound(...args);
        const g = this.gl;
        let q = this.free.pop();
        if (!q) q = g.createQuery() as WebGLQuery;
        try {
          g.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
          const r = bound(...args);
          g.endQuery(this.ext.TIME_ELAPSED_EXT);
          this.queue.push({ slot, query: q });
          return r;
        } catch (err) {
          try { g.endQuery(this.ext.TIME_ELAPSED_EXT); } catch { /* ignore */ }
          this.free.push(q);
          throw err;
        }
      };
    }
    this.acc = this.timed.map(() => []);
    this.enabled = true;
    return true;
  }

  /** 每帧调一次(引擎的 render() 末尾): 收上一帧的查询结果 + 记录本帧的提交/排空/几何量。 */
  tick(submitMs: number, drainMs: number, calls: number, tris: number): void {
    if (!this.enabled || !this.gl || !this.ext) return;
    this.lastSubmitMs = submitMs;
    this.lastDrainMs = drainMs;
    this.lastCalls = calls;
    this.lastTris = tris;
    this.frames++;
    const g = this.gl;
    try {
      if (g.getParameter(this.ext.GPU_DISJOINT_EXT)) this.disjoint++;
    } catch { /* ignore */ }
    const keep: Query[] = [];
    for (const it of this.queue) {
      let avail = false;
      try { avail = g.getQueryParameter(it.query, g.QUERY_RESULT_AVAILABLE) as boolean; } catch { avail = false; }
      if (avail) {
        let ns = 0;
        try { ns = g.getQueryParameter(it.query, g.QUERY_RESULT) as number; } catch { ns = 0; }
        if (this.acc[it.slot] && this.acc[it.slot].length < 600) this.acc[it.slot].push(ns / 1e6);
        this.free.push(it.query);
      } else keep.push(it);
    }
    this.queue = keep;
  }

  /**
   * §324: **卸载**当前的包装, 把方法原样还原 —— 用于切换测量目标。
   *
   * 为什么必须有: WebGL2 **禁止嵌套计时查询**。想量"云 pass 内部"(BSM / march+resolve /
   * 四个程序化纹理烘焙)时, 就不能同时包装 composer 的 pass —— 内层查询会失效, 而且**外层读数
   * 会一起被污染**(§320 实测: 云 pass 被读成 0.00ms)。所以 `gpup` 与 `gpup cloud` 是**互斥**的
   * 两种模式, 切换前必须先卸载(否则还原不了, 只能刷页面)。
   */
  uninstall(): void {
    for (const t of this.timed) { try { t.host[t.key] = t.orig; } catch { /* ignore */ } }
    this.timed = [];
    this.acc = [];
    this.queue = [];
    for (const q of this.free) { try { this.gl?.deleteQuery(q); } catch { /* ignore */ } }
    this.free = [];
    this.enabled = false;
  }

  /**
   * §327: 每个 slot 的**最近一次**样本(ms) —— 记录器每次采样时取一份(不是平均值)。
   * 剖析器的查询是异步收的, 所以这里给的可能是上一帧/上两帧的值; 记录器按时间戳一起存, 事后对齐。
   */
  lastSample(): Array<{ label: string; ms: number; n: number }> {
    return this.timed.map((t, i) => {
      const a = this.acc[i] ?? [];
      return { label: t.label, ms: a.length ? a[a.length - 1] : -1, n: a.length };
    });
  }

  /** §327: 整帧统计的最近一次值(记录器用) */
  lastStats(): { submitMs: number; drainMs: number; calls: number; tris: number; frames: number; disjoint: number } {
    return { submitMs: this.lastSubmitMs, drainMs: this.lastDrainMs, calls: this.lastCalls, tris: this.lastTris, frames: this.frames, disjoint: this.disjoint };
  }

  /** 表头显示"当前量的是什么"(切换模式时由 engine 设置) */
  setModeNote(note: string): void { this.modeNote = note; }

  reset(): void {
    this.acc = this.timed.map(() => []);
    this.frames = 0;
    this.disjoint = 0;
  }

  off(): void { this.enabled = false; this.reset(); }

  /** 出表(文本, 给控制台) */
  report(): string {
    if (!this.gl || !this.ext) return 'GPU 剖析: 本环境没有 EXT_disjoint_timer_query_webgl2, 无法计时';
    const rows = this.timed.map((t, i) => {
      const a = this.acc[i].slice().sort((x, y) => x - y);
      const med = a.length ? a[a.length >> 1] : 0;
      return { label: t.label, n: a.length, med, max: a.length ? a[a.length - 1] : 0 };
    }).filter((r) => r.n > 0).sort((x, y) => y.med - x.med);
    const passSum = rows.filter((r) => !r.label.startsWith('·')).reduce((s, r) => s + r.med, 0);
    const sideSum = rows.filter((r) => r.label.startsWith('·')).reduce((s, r) => s + r.med, 0);
    const lines = [
      `GPU 剖析: ${this.enabled ? 'ON' : 'OFF'}  目标=${this.modeNote}  采样帧=${this.frames}  抽查到 disjoint=${this.disjoint}(>0 表示计时不可信)`,
      `  整帧: 提交(CPU) ${this.lastSubmitMs.toFixed(2)}ms + 排空(GPU) ${this.lastDrainMs.toFixed(2)}ms`
      + `   draw calls=${this.lastCalls}  三角形=${this.lastTris}`,
      `  pass 合计=${passSum.toFixed(2)}ms  composer 外合计=${sideSum.toFixed(2)}ms`,
      '  (标 · 的是 **composer 之外** 的 GPU 大头: LUT 烘焙 / 机体自阴影 RT —— 逐 pass 表看不到它们)',
    ];
    for (const r of rows) {
      lines.push(`    ${r.label.padEnd(22)} med=${r.med.toFixed(2).padStart(7)}ms  max=${r.max.toFixed(2).padStart(7)}ms  n=${r.n}`);
    }
    if (!rows.length) lines.push('    (还没采到样本: 让画面跑 1~2 秒再敲一次 `gpup`)');
    return lines.join('\n');
  }
}
