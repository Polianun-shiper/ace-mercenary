// ============================================================================
// 采样引擎音层 (per user request: 用真实录音的节流阀音色切片驱动引擎声)
// ============================================================================
// 目标: 用用户录制的 引擎与后燃器.wav 替换/叠加原来的纯合成引擎声。
//
// 原实现(audio.ts 合成层)是振荡器+滤波器: 涡轮啸叫 + 风扇嗡嗡 + 燃烧轰鸣 +
// 排气嘶声, 全部由油门线性参数化。它"像"但不"真"。
//
// 本模块的做法:
//   1. 把整段录音解码成 AudioBuffer;
//   2. 按 8 个节流阀档位**切片**(表见 engine-audio-slices.ts, 由分析脚本生成);
//   3. 每档建一对交替的 BufferSource 做**交叉淡化循环**(接缝不爆音);
//   4. 每帧按油门选相邻两档, 用增益做交叉淡化 —— 于是 0→1 全程都是连续、
//      随油门变化的真实引擎音色;
//   5. 加力档(thr>=0.85)额外抬升, 对应录音里 8.6~9.6s 的轰鸣。
//
// 与合成层的关系: **两层叠加**。采样层提供真实音色主体, 合成层保留涡轮啸叫等
// 高频细节 —— 单靠录音会缺少随速度变化的啸叫, 单靠合成又不够真实。
//
// 为什么全部用 gain 节点而不是改 playbackRate:
//   录音本身已包含从怠速到加力的**真实音色变化**, 直接切换音色片段比"拉转速"
//   更真实; playbackRate 只用于极小的微调(避免机械感)。

import {
  ENGINE_SLICES,
  ENGINE_AUDIO_URL,
  AFTERBURNER_THR,
  LOOP_XFADE_SEC,
  type EngineSlice,
} from './engine-audio-slices';

interface Band {
  slice: EngineSlice;
  /** 两个交替播放的源 + 各自增益, 用于交叉淡化循环 */
  srcs: AudioBufferSourceNode[];
  gains: GainNode[];
  /** 下一条源的下标 */
  next: number;
  /** 本档的混合权重(0..1), 由油门驱动 */
  weight: number;
  /** 目标权重(每帧设定, 用 setTargetAtTime 平滑过渡) */
  targetWeight: number;
  /** 每档的总输出增益(所有源共享) */
  out: GainNode;
  started: boolean;
}

export class SampledEngineAudio {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private master: GainNode | null = null;
  private bands: Band[] = [];
  private running = false;
  private volume = 1;
  /** 诊断: 当前主档 */
  activeKey = '-';
  /** 交叉淡化循环的调度器(用 AudioContext 时间, 不依赖 rAF) */
  private schedulerId: number | null = null;

  /** 加载并切片。失败不抛 —— 调用方继续用合成层兜底。 */
  async load(ctx: AudioContext, dest: AudioNode): Promise<boolean> {
    this.ctx = ctx;
    try {
      // 走 assetUrl —— 单文件构建里是内联 data URI, 本地/平台都一样能读。
      const { assetUrl } = await import('./asset-url');
      const res = await fetch(assetUrl(ENGINE_AUDIO_URL));
      if (!res.ok) return false;
      const arr = await res.arrayBuffer();
      this.buffer = await ctx.decodeAudioData(arr);
    } catch {
      return false;
    }
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(dest);
    for (const slice of ENGINE_SLICES) {
      const out = ctx.createGain();
      out.gain.value = 0;
      out.connect(this.master);
      const srcs: AudioBufferSourceNode[] = [];
      const gains: GainNode[] = [];
      for (let i = 0; i < 2; i++) {
        const g = ctx.createGain();
        g.gain.value = 0;
        g.connect(out);
        srcs.push(ctx.createBufferSource());
        gains.push(g);
      }
      this.bands.push({ slice, srcs, gains, next: 0, weight: 0, targetWeight: 0, out, started: false });
    }
    return true;
  }

  get ready(): boolean {
    return !!this.buffer && this.bands.length > 0;
  }

  /** 开始/停止(进关卡、暂停、返回菜单)。 */
  setRunning(on: boolean): void {
    if (!this.ctx || !this.ready) return;
    if (on === this.running) return;
    this.running = on;
    if (on) {
      this.startBands();
      this.master?.gain.setTargetAtTime(1, this.ctx.currentTime, 0.8);
      this.schedule();
    } else {
      this.master?.gain.setTargetAtTime(0, this.ctx.currentTime, 0.5);
      // 源不立即停 —— 淡出后再由 schedule 里的清理停止; 这里只停止调度。
      if (this.schedulerId !== null) {
        window.clearInterval(this.schedulerId);
        this.schedulerId = null;
      }
      window.setTimeout(() => this.stopBands(), 1200);
    }
  }

  private startBands(): void {
    const ctx = this.ctx!;
    const buf = this.buffer!;
    for (const b of this.bands) {
      const sr = buf.sampleRate;
      const off = Math.max(0, Math.min(buf.duration - 0.05, b.slice.startSec));
      const dur = Math.max(0.05, Math.min(buf.duration - off, b.slice.endSec - b.slice.startSec));
      for (let i = 0; i < 2; i++) {
        const s = ctx.createBufferSource();
        s.buffer = buf;
        s.loop = true;
        s.loopStart = off;
        s.loopEnd = off + dur;
        s.connect(b.gains[i]);
        try { s.start(0, off); } catch { /* 忽略重复启动 */ }
        b.srcs[i] = s;
      }
      b.started = true;
      b.next = 0;
      // 两条源相位错开半个循环 —— 交叉淡化时不会有静音缺口。
      const phase = (dur / 2) * sr;
      void phase;
    }
    // 立即让第 0 条源满增益, 第 1 条 0(它们相位相同, 但循环点不同时刻到达)
    for (const b of this.bands) {
      b.gains[0].gain.value = 1;
      b.gains[1].gain.value = 0;
    }
  }

  private stopBands(): void {
    for (const b of this.bands) {
      for (let i = 0; i < 2; i++) {
        try { b.srcs[i]?.stop(); } catch { /* ignore */ }
      }
      b.started = false;
      b.gains.forEach((g) => { g.gain.value = 0; });
    }
  }

  /**
   * 交叉淡化循环调度。
   *
   * 为什么不用 `loop=true` 直接循环: 直接循环在接缝处会有电平跳变(咔哒)。
   * 这里每 LOOP_XFADE_SEC 前把"下一条源"淡入、"当前源"淡出, 等效于无缝交叉淡化
   * 循环。用 setInterval 而不是 rAF —— 音频调度不该被渲染帧率影响; 但这里只做
   * 增益包络, 真正的时基仍是 AudioContext 的 currentTime。
   */
  private schedule(): void {
    if (this.schedulerId !== null) return;
    const tick = () => {
      if (!this.ctx || !this.running) return;
      const now = this.ctx.currentTime;
      for (const b of this.bands) {
        if (!b.started || b.weight <= 0.001) continue;
        // 每档独立推进交叉淡化相位
        const dur = b.slice.endSec - b.slice.startSec;
        const period = Math.max(0.25, dur);
        if (!(b as unknown as { _phaseT?: number })._phaseT) {
          (b as unknown as { _phaseT?: number })._phaseT = now;
        }
        const p = b as unknown as { _phaseT: number };
        if (now - p._phaseT >= period - LOOP_XFADE_SEC) {
          const cur = b.next;
          const nxt = 1 - cur;
          const fade = LOOP_XFADE_SEC;
          b.gains[nxt].gain.cancelScheduledValues(now);
          b.gains[cur].gain.cancelScheduledValues(now);
          b.gains[nxt].gain.setValueAtTime(b.gains[nxt].gain.value, now);
          b.gains[cur].gain.setValueAtTime(b.gains[cur].gain.value, now);
          b.gains[nxt].gain.linearRampToValueAtTime(1, now + fade);
          b.gains[cur].gain.linearRampToValueAtTime(0, now + fade);
          // 把刚淡出的源复位到循环起点, 供下一轮使用
          const s = b.srcs[cur];
          const off = b.slice.startSec;
          const len = b.slice.endSec - b.slice.startSec;
          b.next = nxt;
          p._phaseT = now + fade;
          // 复位旧源(下一轮它就是"下一条"): 重排它的循环区间
          try {
            s.loopStart = off;
            s.loopEnd = off + len;
          } catch { /* ignore */ }
        }
      }
    };
    this.schedulerId = window.setInterval(tick, 60);
  }

  /**
   * 每帧按油门更新档位混合权重 (核心)。
   *
   * 取相邻两档做线性交叉淡化:
   *   thr=0.30 → idle 权重 0, t30 权重 1
   *   thr=0.37 → t30 0.5 / t45 0.5
   * 于是任意油门都对应"两段真实音色的混合", 全程连续无跳变。
   */
  update(throttle: number): void {
    if (!this.ctx || !this.ready) return;
    const thr = Math.max(0, Math.min(1, throttle));
    let lo = 0;
    for (let i = 0; i < ENGINE_SLICES.length; i++) {
      if (ENGINE_SLICES[i].thr <= thr) lo = i;
    }
    const hi = Math.min(ENGINE_SLICES.length - 1, lo + 1);
    const a = ENGINE_SLICES[lo];
    const b = ENGINE_SLICES[hi];
    const span = Math.max(1e-4, b.thr - a.thr);
    const t = Math.max(0, Math.min(1, (thr - a.thr) / span));
    this.activeKey = t > 0.5 ? b.key : a.key;
    for (let i = 0; i < this.bands.length; i++) {
      const w = i === lo ? 1 - t : (i === hi ? t : 0);
      const band = this.bands[i];
      band.targetWeight = w;
      band.out.gain.setTargetAtTime(w * this.volume, this.ctx.currentTime, 0.10);
    }
  }

  /** 音量(0..1), 由 audio.ts 的引擎音量设置驱动。 */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.ctx) {
      for (const b of this.bands) {
        b.out.gain.setTargetAtTime(b.targetWeight * this.volume, this.ctx.currentTime, 0.15);
      }
    }
  }

  /** 是否处于加力档(供诊断/外部读取)。 */
  get inAfterburner(): boolean {
    const key = this.activeKey;
    return key === 't85' || key === 'ab';
  }

  /** 诊断快照。 */
  debug(): { ready: boolean; running: boolean; activeKey: string; afterburnerThr: number; bands: number } {
    return {
      ready: this.ready, running: this.running,
      activeKey: this.activeKey, afterburnerThr: AFTERBURNER_THR,
      bands: this.bands.length,
    };
  }

  dispose(): void {
    if (this.schedulerId !== null) window.clearInterval(this.schedulerId);
    this.schedulerId = null;
    this.stopBands();
    this.bands = [];
    this.buffer = null;
  }
}
