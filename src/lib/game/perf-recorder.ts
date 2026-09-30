// === §327 性能实时记录器 (per user request: 实时记录位置/视角/高度/体积云细分 pass 等, 事后分析) ===
//
// 用法(控制台 / 浏览器钩子 `__rec(...)` 同一条路):
//   rec start / rec stop / rec          → 开始 / 停止 / 状态(含本次样本数、时长、字段数)
//   rec rate <ms>                       → 采样间隔(默认 100ms; 越小越密)
//   rec clear                           → 丢弃已采样本与事件
//   rec export                          → 下载 JSON(带环境头 + 采样 + 事件)
//   rec csv                             → 下载 CSV(方便直接拖进表格)
//   rec dump                            → 在控制台打印 JSON 的前几行(不下载时的快速抽查)
//   rec note <文字>                     → 往事件流里插一条带时间戳的标记(方便对齐"我按了什么")
//   rec gpu on|off                      → 记录时是否自动打开云内部剖析(默认 on; 见下面"测量代价")
//
// 设计要点:
//  · **采样在引擎的 render() 里驱动**(所以暂停/菜单时也能记录), 按 `rateMs` 节流。
//  · 字段由引擎提供的 `sample()` 回调给出 —— 这个类不认识引擎内部, 只负责节流/存/导出。
//  · 样本上限 `maxSamples`(默认 30000)封顶, 超出后**丢最旧的**, 保证长时间挂着不会吃爆内存。
//  · [!] 测量代价: 打开 `gpu on` 会让剖析器每帧多一次 `gl.finish` ⇒ 帧时本身会变差(这是测量成本),
//    但**云细分 pass 的 GPU 时间只有计时查询能给**。所以默认开, 你可以在 `rec gpu off` 下录一份
//    "纯帧率"的做对照。
//  · [!] 记录的是**采样时刻的值**, 不是平均值; `med/max` 是剖析器累积的统计(它自己会 reset)。

export interface PerfEvent {
  t: number;          // 相对记录开始的毫秒
  what: string;
}

export class PerfRecorder {
  private on = false;
  private rateMs = 100;
  private maxSamples = 30000;
  private samples: Record<string, unknown>[] = [];
  private events: PerfEvent[] = [];
  private t0 = 0;
  private lastAt = -1e9;
  private meta: Record<string, unknown> = {};
  private gpuWanted = true;
  /** 引擎在 start 时回调一次: 用来按需要打开云内部剖析; 返回一行说明 */
  onStart: ((wantGpu: boolean) => string) | null = null;
  /** 引擎在 stop 时回调一次(把剖析器关掉/恢复) */
  onStop: (() => void) | null = null;

  get isOn(): boolean { return this.on; }
  get count(): number { return this.samples.length; }
  get elapsedMs(): number { return this.on ? performance.now() - this.t0 : 0; }
  get wantGpu(): boolean { return this.gpuWanted; }
  /** 最近一次样本(状态行用) */
  get last(): Record<string, unknown> | null { return this.samples.length ? this.samples[this.samples.length - 1] : null; }

  start(meta: Record<string, unknown>): string {
    this.samples = [];
    this.events = [];
    this.meta = { ...meta, startedAt: new Date().toISOString(), rateMs: this.rateMs };
    this.t0 = performance.now();
    this.lastAt = -1e9;
    this.on = true;
    const extra = this.onStart ? this.onStart(this.gpuWanted) : '';
    return `录制开始(间隔 ${this.rateMs}ms, 上限 ${this.maxSamples} 样本)。${extra}`;
  }
  stop(): string {
    if (!this.on) return `录制未开始(已有 ${this.samples.length} 个样本可导出)`;
    this.on = false;
    this.onStop?.();
    const sec = ((performance.now() - this.t0) / 1000).toFixed(1);
    return `录制停止: ${sec}s / ${this.samples.length} 样本 / ${this.events.length} 事件。用 \`rec export\` 下载 JSON。`;
  }
  clear(): string { const n = this.samples.length; this.samples = []; this.events = []; return `已清空 ${n} 个样本`; }
  setRate(ms: number): string { this.rateMs = Math.max(16, Math.min(5000, Math.round(ms))); return `采样间隔 = ${this.rateMs}ms`; }
  setGpu(on: boolean): string { this.gpuWanted = !!on; return `记录时云内部剖析 = ${on ? 'ON' : 'OFF'}`; }

  /** 引擎每帧调: 到点就取一个样本。`sample` 只在真的要采时才调用(省掉构造开销) */
  tick(frame: number, sample: () => Record<string, unknown>): void {
    if (!this.on) return;
    const now = performance.now();
    if (now - this.lastAt < this.rateMs) return;
    this.lastAt = now;
    let s: Record<string, unknown>;
    try { s = sample(); } catch (err) { s = { sampleError: String(err).slice(0, 120) }; }
    s.t = +(now - this.t0).toFixed(1);
    s.frame = frame;
    if (this.samples.length >= this.maxSamples) this.samples.shift();
    this.samples.push(s);
  }
  addEvent(what: string): void {
    if (!this.on) return;
    this.events.push({ t: +(performance.now() - this.t0).toFixed(1), what: String(what).slice(0, 200) });
    if (this.events.length > 4000) this.events.shift();
  }

  report(): string {
    const last = this.last;
    const keys = last ? Object.keys(last).length : 0;
    return `录制: ${this.on ? 'ON' : 'OFF'}  样本=${this.samples.length}  事件=${this.events.length}`
      + `  间隔=${this.rateMs}ms  字段=${keys}  本次时长=${this.on ? (this.elapsedMs / 1000).toFixed(1) + 's' : '-'}`
      + `  云内部剖析=${this.gpuWanted ? 'ON' : 'OFF'}`
      + (last ? `\n  最近样本: t=${last.t}ms alt=${last.alt}m tier=${last.tier} 云pass=${last.cloudPassMs}ms` : '');
  }

  payload(): Record<string, unknown> {
    return {
      meta: { ...this.meta, stoppedAt: new Date().toISOString(), samples: this.samples.length, events: this.events.length },
      events: this.events,
      samples: this.samples,
    };
  }
  json(): string { return JSON.stringify(this.payload()); }
  dumpLines(n = 6): string {
    const s = this.json();
    return `JSON 长度=${s.length} 字符(约 ${(s.length / 1048576).toFixed(2)}MB)\n` + s.slice(0, 1200)
      + (n > 0 ? `\n  ...(前 1200 字符; 完整内容用 rec export)` : '');
  }
  csv(): string {
    const rows = this.samples;
    if (!rows.length) return '(无样本)';
    const cols = Array.from(rows.reduce((set: Set<string>, r) => {
      for (const k of Object.keys(r)) set.add(k);
      return set;
    }, new Set<string>()));
    const head = cols.join(',');
    const body = rows.map((r) => cols.map((c) => {
      const v = r[c];
      if (v === undefined || v === null) return '';
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\n');
    return head + '\n' + body;
  }

  /** 控制台的 start 需要引擎先给一份环境头(画布/旋钮快照等) */
  startWith(meta: Record<string, unknown>): string { return this.start(meta); }
}
