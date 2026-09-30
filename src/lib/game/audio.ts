// Procedural audio engine using the Web Audio API.
// Everything is synthesized at runtime — no external audio files needed.
// Provides:
//   - Background music: a low-key military drum + bass + arpeggio loop
//   - SFX: gun, missile launch, explosion, lock-on beep, lock acquired chime,
//          stall warning beep, hit thud, radio squelch
//   - Radio voice tones for chatter: short-formant synthesized "voice" bursts
//
// Usage:
//   const a = new AudioEngine();
//   await a.init();   // call on user gesture (click / keydown)
//   a.startMusic();
//   a.gun();
//   a.missileLaunch();
//   a.explosion(1.0);
//   a.lockProgress(0.5);
//   a.lockAcquired();
//   a.stall(true);   // toggle
//   a.hit();
//   a.radioVoice({ freq: 220, formant: 800, dur: 0.35, speaker: 'ally' });
//   a.setMusicIntensity(0.7);  // 0 = ambient, 1 = combat

import { assetUrl } from './asset-url';
import { SampledEngineAudio } from './audio-engine-sampled';
import { ENGINE_AUDIO_URL } from './engine-audio-slices';

// === 导入音效的放大量 (per user request: 导入的音效都要放大5倍) ===
// 只包含**用户导入的 wav**(录制电平普遍偏低), 不含平台原生 mp3 ——
// 避免把原本已调好的爆炸/炮声一起推爆。
// 放模块级常量而不是实例字段: 它描述的是素材属性, 与音频上下文无关。
const IMPORTED_SFX_BOOST = new Set([
  'player_hit',     // 被击中.wav
  'radar_lock',     // 被雷达照射.wav
  'gun_burst',      // 连续机炮.wav
  'lock_on',        // 锁定敌人.wav
  'missile_launch', // 导弹离架和发射.wav
  'missile_player', // 玩家发射音
]);
/** 采样引擎层(引擎与后燃器.wav)的放大量 —— 同样按用户要求 ×5。 */
const ENGINE_SAMPLE_BOOST = 5.0;

export type Speaker = 'player' | 'ally1' | 'ally2' | 'enemy1' | 'enemy2' | 'awacs';

interface RadioVoiceOpts {
  freq: number;     // base pitch (Hz)
  formant: number;  // filter center (Hz) — vowel color
  dur: number;      // seconds
  speaker: Speaker;
}

const SPEAKER_PRESETS: Record<Speaker, { freq: number; formant: number }> = {
  player:  { freq: 240, formant: 1100 },
  ally1:   { freq: 200, formant: 950 },
  ally2:   { freq: 280, formant: 1300 },
  enemy1:  { freq: 170, formant: 750 },
  enemy2:  { freq: 145, formant: 680 },
  awacs:   { freq: 220, formant: 1450 },
};

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private radioBus!: GainNode;
  // === Dedicated explosion bus (per user request) ===
  // Explosions get their own bus so they can punch through the wind/engine
  // mix at high speed. The bus has a compressor on it so simultaneous
  // detonations don't clip the master, and an overall gain that's louder
  // than the regular SFX bus so explosions are always audible — solving
  // the "高速时听不到爆炸声" problem.
  private explosionBus!: GainNode;
  private explosionCompressor!: DynamicsCompressorNode;
  // Player speed (0..1 normalized) — used to duck wind/engine when an
  // explosion fires so the explosion is always audible at high speed.
  private playerSpeedNorm = 0;

  // Music nodes
  private musicTimer: number | null = null;
  private musicStep = 0;
  private musicIntensity = 0.3; // 0..1
  private musicPlaying = false;

  // Stall warning interval
  private stallActive = false;
  private stallTimer: number | null = null;

  // Lock-on tracking
  private lastLockProgress = 0;
  private lockBeepTimer = 0;

  // Noise buffer cache (for explosions / gun hiss)
  private noiseBuffer: AudioBuffer | null = null;
  private airflowBuffer: AudioBuffer | null = null; // 用户气流录音(采样风声)

  // === External sample cache (per user request: 接入 105mm/40mm 炮声) ===
  // Loaded from /audio/*.mp3 on init(). Fall back to synthesis if load fails.
  private sampleBuffers: Map<string, AudioBuffer> = new Map();
  private sampleLoadPromise: Promise<void> | null = null;

  // === Pre-recorded radio voice lines (per user request: IndexTTS 中文配音) ===
  // Per-line mp3 files are decoded once and cached; the "voice" plays through
  // radioBus so it mixes with the squelch/static bed. A single active source is
  // tracked so clear()/dispose() can cut an in-flight line immediately.
  private radioVoiceBuffers: Map<string, AudioBuffer> = new Map();
  private radioVoiceDecode: Map<string, Promise<AudioBuffer | null>> = new Map();
  private radioVoiceSource: AudioBufferSourceNode | null = null;

  // === Continuous jet engine sound ========================================
  // A proper turbofan engine sound has several characteristic components:
  //   1. Turbine whine    — high-pitched tonal whine (N1/N2 compressor spool)
  //   2. Combustion roar  — low-frequency filtered noise (the deep rumble)
  //   3. Bypass fan hum   — mid-frequency tonal component (the "fan drone")
  //   4. Exhaust hiss     — broadband high-frequency noise (jet plume)
  // The previous implementation used low-frequency sawtooth oscillators which
  // sounded like a piston/propeller engine — totally wrong for a fighter jet.
  private engineTurbine: OscillatorNode | null = null;       // high-pitched N2 spool whine
  private engineTurbine2: OscillatorNode | null = null;      // second harmonic for richness
  private engineFan: OscillatorNode | null = null;           // mid-pitched fan drone (square)
  private engineFanLfo: OscillatorNode | null = null;        // LFO that amplitude-modulates the fan for a subtle "throb"
  private engineFanLfoGain: GainNode | null = null;
  private engineCombustSrc: AudioBufferSourceNode | null = null;  // combustion roar (filtered noise)
  private engineExhaustSrc: AudioBufferSourceNode | null = null;  // exhaust hiss (filtered noise)
  private engineGain: GainNode | null = null;                // master engine gain
  private engineTurbineGain: GainNode | null = null;
  private engineFanGain: GainNode | null = null;
  private engineCombustGain: GainNode | null = null;
  private engineCombustFilter: BiquadFilterNode | null = null;   // lowpass for combustion
  private engineExhaustGain: GainNode | null = null;
  private engineExhaustFilter: BiquadFilterNode | null = null;   // highpass/bandpass for exhaust
  private engineTurbineFilter: BiquadFilterNode | null = null;   // bandpass around whine
  private engineRunning = false;
  // 采样引擎层(真实录音切片): 在 loadSamples 之后加载, 由 setEngineThrottle 驱动。
  private sampledEngine: SampledEngineAudio | null = null;
  private engineTargetThrottle = 0.5;   // 0..1, drives pitch + volume

  private windSrc: AudioBufferSourceNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private windRunning = false;
  private windTargetSpeed = 0.3;        // 0..1, drives wind intensity

  private initialized = false;
  // init() 并发保护。**不变式**:所有 bus/增益在 init() 里同步建好之后才会
  // await,因此"ctx 有值 ⇒ bus 有值";渲染循环里的 setter 再各自兜一层空值
  // 判断(缺 bus 会让渲染循环每帧抛错并中断当帧更新 —— 表现为莫名卡顿)。
  private _initPromise: Promise<void> | null = null;

  async init() {
    if (this.initialized) return;
    // === 并发保护 (per bugfix: 渲染循环每帧调 setMusicIntensity) ===
    // init() 里有 await;期间 this.ctx 已存在但各 bus 尚未建好,若渲染循环
    // 此刻调 setMusicIntensity/setSfxVolume 会读到 undefined 的 bus → 每帧
    // 抛 TypeError 并中断当帧剩余更新(表现为莫名卡顿/操作失灵)。
    // 两道保险:① 并发调用复用同一个 promise;② 所有节点建完再 await resume。
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._initInternal();
    return this._initPromise;
  }

  private async _initInternal() {
    const Ctor = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    // === 顺序很重要:先把总线/增益全部建好,最后才 await resume ===
    // (AudioContext.resume() 在无用户手势时可能长期不 resolve,若把它放在
    //  建节点之前,中间这段时间所有 bus 都是 undefined。)
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(this.ctx.destination);

    // Sub-buses
    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = 0.35;
    this.musicBus.connect(this.master);

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = 0.7;
    this.sfxBus.connect(this.master);

    this.radioBus = this.ctx.createGain();
    this.radioBus.gain.value = 0.55;
    this.radioBus.connect(this.master);

    // === Dedicated explosion bus (per user request) ===
    // Compressor first (tames peaks from overlapping detonations), then a
    // gain stage louder than the regular SFX bus so explosions are always
    // audible — especially at high speed where wind + engine noise can
    // mask them on the regular SFX bus.
    this.explosionCompressor = this.ctx.createDynamicsCompressor();
    this.explosionCompressor.threshold.value = -18;
    this.explosionCompressor.knee.value = 24;
    this.explosionCompressor.ratio.value = 4;
    this.explosionCompressor.attack.value = 0.002;
    this.explosionCompressor.release.value = 0.18;
    this.explosionBus = this.ctx.createGain();
    this.explosionBus.gain.value = 1.0;
    this.explosionCompressor.connect(this.master);
    this.explosionBus.connect(this.explosionCompressor);

    // Build white-noise buffer (1s) for reuse
    const sr = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, sr, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < sr; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;
    // === 气流录音采样(per user request: 替换风声) ===
    this.loadAirflow();

    this.initialized = true;

    // Kick off async sample loading (non-blocking — falls back to synth on miss).
    this.sampleLoadPromise = this.loadSamples();

    // === 采样引擎层 (per user request: 真实节流阀音色) ===
    // 与 samples 并行加载; 失败只 warn, 引擎声自动回落到合成层(不会没声音)。
    this.sampledEngine = new SampledEngineAudio();
    void this.sampledEngine.load(this.ctx, this.sfxBus).then((ok) => {
      if (!ok) {
        console.warn('[audio] 采样引擎音加载失败, 回退纯合成引擎声:', ENGINE_AUDIO_URL);
      } else if (this.engineRunning) {
        this.sampledEngine?.setRunning(true);
        this.sampledEngine?.update(this.engineTargetThrottle);
      }
    });

    // 最后再恢复上下文:即便它一直不 resolve,上面的总线也已可用。
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* will retry on next gesture */ }
    }
  }

  // === External sample loading ===========================================
  // Loads the uploaded user audio (105mm/40mm 炮声, 暴雨, 闪电, 音爆) into
  // AudioBuffers so we can play them through the SFX bus with full Web Audio
  // routing (gain, filter, compressor, etc).
  private async loadSamples() {
    if (!this.ctx) return;
    const samples: Record<string, string> = {
      'cannon_105mm': '/audio/sfx_cannon_105mm.mp3',
      'cannon_40mm':  '/audio/sfx_cannon_40mm.mp3',
      'gun_25mm':     '/audio/sfx_gun_25mm.mp3',
      'thunder':      '/audio/sfx_thunder.mp3',
      'sonic_boom':   '/audio/sfx_sonic_boom.mp3',
      'amb_rain':     '/audio/amb_rain_storm.mp3',
      // === 用户提供的新音效 (per user request: 以音频名字替换音效) ===
      'player_hit':   '/audio/sfx_player_hit.wav',    // 被击中
      'radar_lock':   '/audio/sfx_radar_lock.wav',    // 被雷达照射
      'gun_burst':    '/audio/sfx_gun_burst.wav',     // 连续机炮
      'lock_on':      '/audio/sfx_lock_on.wav',       // 锁定敌人
      'missile_launch': '/audio/sfx_missile_launch.wav', // 导弹离架和发射
      'missile_player': '/audio/sfx_missile_player.wav', // 玩家发射音(用户提供; 原 zapsplat 为空文件不可用)
    };
    await Promise.all(Object.entries(samples).map(async ([key, url]) => {
      try {
        const res = await fetch(assetUrl(url));
        if (!res.ok) return;
        const arr = await res.arrayBuffer();
        const audioBuf = await this.ctx!.decodeAudioData(arr);
        this.sampleBuffers.set(key, audioBuf);
      } catch {
        // Network/decode failure — caller falls back to synth path.
      }
    }));
  }

  /** Ensure samples are loaded (await this if you need them ASAP). */
  async ensureSamplesLoaded() {
    if (this.sampleLoadPromise) await this.sampleLoadPromise;
  }

  /** Internal: play a cached sample through a given bus with optional gain/pitch. */
  private playSample(key: string, opts: { volume?: number; rate?: number; bus?: GainNode; pan?: number } = {}): boolean {
    if (!this.ctx) return false;
    const buf = this.sampleBuffers.get(key);
    if (!buf) return false;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = opts.rate ?? 1.0;
    const g = this.ctx.createGain();
    // === 导入音效整体放大 5 倍 (per user request: 都要放大5倍音效) ===
    // 只对**用户导入的 wav** 生效(wav 录制电平普遍偏低), 不放大平台原生 mp3 ——
    // 避免把原本已调好的爆炸/炮声一起推爆。
    // 放大量做成独立常数而不是改各处 volume: 便于一处调整与调试读值。
    const boost = IMPORTED_SFX_BOOST.has(key) ? 5.0 : 1.0;
    g.gain.value = (opts.volume ?? 1.0) * boost;
    // Optional stereo panning (for left/right gunport separation on AC-130)
    let destNode: AudioNode = g;
    if (opts.pan !== undefined && this.ctx.createStereoPanner) {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, opts.pan));
      g.connect(panner);
      destNode = panner;
    }
    src.connect(g);
    destNode.connect(opts.bus ?? this.sfxBus);
    src.start(t);
    src.stop(t + buf.duration / src.playbackRate.value + 0.05);
    return true;
  }

  /** Resume the context if suspended (call on user gesture). */
  async resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* ignore */ }
    }
  }

  setMasterVolume(v: number) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    this.master.gain.setTargetAtTime(v, ctx.currentTime, 0.05);
  }

  // ============================================================
  // === BACKGROUND MUSIC =======================================
  // ============================================================

  /**
   * Start the procedural background music loop. A step sequencer plays:
   *  - Sub-bass pulse on beats 1 and 3
   *  - Snare-like noise burst on beats 2 and 4
   *  - Low arpeggio (A minor pentatonic) at 1/8 notes
   *  - High pad sweep every 8 beats
   * `musicIntensity` (0..1) raises volume + adds more layers when combat heats up.
   */
  startMusic() {
    if (!this.ctx || this.musicPlaying) return;
    this.musicPlaying = true;
    this.musicStep = 0;
    const stepMs = 125; // 1/16 at 120 BPM → 125 ms; we use 1/8 = 250 ms per arpeggio step
    const tick = () => {
      if (!this.ctx || !this.musicPlaying) return;
      this.musicTick();
      this.musicTimer = window.setTimeout(tick, stepMs);
    };
    tick();
  }

  stopMusic() {
    this.musicPlaying = false;
    if (this.musicTimer !== null) {
      clearTimeout(this.musicTimer);
      this.musicTimer = null;
    }
  }

  setMusicIntensity(v: number) {
    this.musicIntensity = Math.max(0, Math.min(1, v));
    const ctx = this.ctx;
    if (!ctx || !this.musicBus) return;
    // Combat music louder and more present
    const g = 0.25 + this.musicIntensity * 0.30;
    this.musicBus.gain.setTargetAtTime(g, ctx.currentTime, 0.5);
  }

  private musicTick() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const step = this.musicStep;
    // 16-step pattern (2 bars of 8 sixteenths)
    const beat = step % 16;
    const intensity = this.musicIntensity;

    // Sub-bass on beats 1 and 9 (downbeats)
    if (beat === 0 || beat === 8) {
      this.playBassNote(55, t, 0.45, 0.18 + intensity * 0.20);
    }
    // Off-bass at beat 6 (gives momentum)
    if (intensity > 0.4 && (beat === 6 || beat === 14)) {
      this.playBassNote(82.4, t, 0.30, 0.12 + intensity * 0.15);
    }

    // Snare on beats 4 and 12
    if (beat === 4 || beat === 12) {
      this.playSnare(t, 0.18 + intensity * 0.20);
    }
    // Hi-hat on every other 1/16
    if (step % 2 === 0 && intensity > 0.2) {
      this.playHat(t, 0.04 + intensity * 0.05);
    }

    // Arpeggio — A minor pentatonic across two octaves
    // A2=110, C3=130.8, D3=146.8, E3=164.8, G3=196
    const scale = [220, 261.6, 293.7, 329.6, 392, 440, 523.3, 587.3];
    const arpIdx = step % 8;
    const note = scale[arpIdx];
    this.playArpNote(note, t, 0.22, 0.05 + intensity * 0.08);

    // Pad sweep every 32 steps
    if (step % 32 === 0) {
      this.playPad(t, 4.0, 0.04 + intensity * 0.05);
    }

    this.musicStep = (step + 1) % 64;
  }

  private playBassNote(freq: number, t: number, dur: number, vol: number) {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 280;
    lp.Q.value = 6;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(lp); lp.connect(g); g.connect(this.musicBus);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private playSnare(t: number, vol: number) {
    if (!this.ctx || !this.noiseBuffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 0.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    src.connect(bp); bp.connect(g); g.connect(this.musicBus);
    src.start(t);
    src.stop(t + 0.2);
  }

  private playHat(t: number, vol: number) {
    if (!this.ctx || !this.noiseBuffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(hp); hp.connect(g); g.connect(this.musicBus);
    src.start(t);
    src.stop(t + 0.08);
  }

  private playArpNote(freq: number, t: number, dur: number, vol: number) {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    // Slight detune layer for richness
    const osc2 = this.ctx.createOscillator();
    osc2.type = 'triangle';
    osc2.frequency.value = freq * 1.005;
    const g2 = this.ctx.createGain();
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.exponentialRampToValueAtTime(vol * 0.6, t + 0.005);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(this.musicBus);
    osc2.connect(g2); g2.connect(this.musicBus);
    osc.start(t); osc2.start(t);
    osc.stop(t + dur + 0.05); osc2.stop(t + dur + 0.05);
  }

  private playPad(t: number, dur: number, vol: number) {
    if (!this.ctx) return;
    // Slowly swelling low pad — adds atmosphere
    const freqs = [110, 138.6, 164.8]; // A minor triad
    for (const f of freqs) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol, t + dur * 0.3);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
      osc.connect(g); g.connect(this.musicBus);
      osc.start(t);
      osc.stop(t + dur + 0.1);
    }
  }

  // ============================================================
  // === SFX ====================================================
  // ============================================================

  // === Continuous jet engine sound ========================================
  // Constructs a layered turbofan sound:
  //   - Turbine whine:  two oscillators (fundamental + 2nd harmonic) at ~2.2kHz idle,
  //     rising to ~3.6kHz at full afterburner. Bandpass-filtered for that classic
  //     "spooling" character that rises in pitch as throttle increases.
  //   - Fan drone: a square-wave oscillator at ~280Hz idle → ~440Hz full, lightly
  //     amplitude-modulated by a slow LFO (~7Hz) to mimic the bypass fan "throb".
  //   - Combustion roar: lowpass-filtered white noise (~220Hz cutoff) for the deep
  //     bass rumble that increases in volume and brightness with throttle.
  //   - Exhaust hiss: bandpass-filtered noise (~3.5kHz) for the high-frequency
  //     jet plume that becomes prominent at high throttle / afterburner.
  //
  // The old "sawtooth + lowpass" design sounded like a piston/propeller engine
  // because sawtooths at ~70Hz produce a strong fundamental pulse — exactly
  // what a propeller sounds like. A real jet engine is dominated by the turbine
  // whine and broadband noise, with very little low-frequency pulse content.
  startEngine() {
    if (!this.ctx || this.engineRunning) return;
    this.engineRunning = true;
    this.sampledEngine?.setRunning(true);
    const t = this.ctx.currentTime;

    // ---- Master engine bus ----
    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0.0;
    this.engineGain.connect(this.sfxBus);

    // ---- 1. Turbine whine (the signature jet spool) ----
    this.engineTurbine = this.ctx.createOscillator();
    this.engineTurbine.type = 'sawtooth';
    this.engineTurbine.frequency.value = 2200;
    this.engineTurbine2 = this.ctx.createOscillator();
    this.engineTurbine2.type = 'sawtooth';
    this.engineTurbine2.frequency.value = 4400;  // one octave up — gives a richer whine
    this.engineTurbineFilter = this.ctx.createBiquadFilter();
    this.engineTurbineFilter.type = 'bandpass';
    this.engineTurbineFilter.frequency.value = 2800;
    this.engineTurbineFilter.Q.value = 4.0;       // fairly narrow → whiny character
    this.engineTurbineGain = this.ctx.createGain();
    this.engineTurbineGain.gain.value = 0.0;
    this.engineTurbine.connect(this.engineTurbineFilter);
    this.engineTurbine2.connect(this.engineTurbineFilter);
    this.engineTurbineFilter.connect(this.engineTurbineGain);
    this.engineTurbineGain.connect(this.engineGain);
    this.engineTurbine.start(t);
    this.engineTurbine2.start(t);

    // ---- 2. Bypass fan drone (mid-frequency hum + throb) ----
    this.engineFan = this.ctx.createOscillator();
    this.engineFan.type = 'square';
    this.engineFan.frequency.value = 280;
    this.engineFanGain = this.ctx.createGain();
    this.engineFanGain.gain.value = 0.0;
    // Slow LFO modulating fan gain → "throb"
    this.engineFanLfo = this.ctx.createOscillator();
    this.engineFanLfo.type = 'sine';
    this.engineFanLfo.frequency.value = 7.0;
    this.engineFanLfoGain = this.ctx.createGain();
    this.engineFanLfoGain.gain.value = 0.0;       // depth scales with throttle later
    this.engineFanLfo.connect(this.engineFanLfoGain);
    this.engineFanLfoGain.connect(this.engineFanGain.gain);
    this.engineFan.connect(this.engineFanGain);
    this.engineFanGain.connect(this.engineGain);
    this.engineFan.start(t);
    this.engineFanLfo.start(t);

    // ---- 3. Combustion roar (low-passed noise → deep rumble) ----
    if (this.noiseBuffer) {
      this.engineCombustSrc = this.ctx.createBufferSource();
      this.engineCombustSrc.buffer = this.noiseBuffer;
      this.engineCombustSrc.loop = true;
      this.engineCombustFilter = this.ctx.createBiquadFilter();
      this.engineCombustFilter.type = 'lowpass';
      this.engineCombustFilter.frequency.value = 220;
      this.engineCombustFilter.Q.value = 1.0;
      this.engineCombustGain = this.ctx.createGain();
      this.engineCombustGain.gain.value = 0.0;
      this.engineCombustSrc.connect(this.engineCombustFilter);
      this.engineCombustFilter.connect(this.engineCombustGain);
      this.engineCombustGain.connect(this.engineGain);
      this.engineCombustSrc.start(t);

      // ---- 4. Exhaust hiss (band-passed noise → high-frequency plume) ----
      this.engineExhaustSrc = this.ctx.createBufferSource();
      this.engineExhaustSrc.buffer = this.noiseBuffer;
      this.engineExhaustSrc.loop = true;
      this.engineExhaustFilter = this.ctx.createBiquadFilter();
      this.engineExhaustFilter.type = 'bandpass';
      this.engineExhaustFilter.frequency.value = 3500;
      this.engineExhaustFilter.Q.value = 0.7;
      this.engineExhaustGain = this.ctx.createGain();
      this.engineExhaustGain.gain.value = 0.0;
      this.engineExhaustSrc.connect(this.engineExhaustFilter);
      this.engineExhaustFilter.connect(this.engineExhaustGain);
      this.engineExhaustGain.connect(this.engineGain);
      this.engineExhaustSrc.start(t);
    }

    // Fade in master over 1.5s for a smooth engine start
    // === Quieter engine (per user request: 引擎声调小) ===
    // Ceiling 0.9 → 0.7.
    this.engineGain.gain.setValueAtTime(0.0001, t);
    this.engineGain.gain.linearRampToValueAtTime(0.7, t + 1.5);

    // ---- Per-frame parameter lerp toward target throttle ----
    const updateLoop = () => {
      if (!this.ctx || !this.engineRunning) return;
      const now = this.ctx.currentTime;
      const thr = this.engineTargetThrottle;

      // === 合成引擎层已停用 (per user request: 原本的引擎和气流声音就不要了) ===
      // 现在引擎声 100% 来自用户录音的采样层(audio-engine-sampled.ts, 八档切片)。
      // 合成层保留代码但增益全部置 0 —— 这样:
      //   · 不会有两套引擎声叠在一起(采样 + 合成会糊)
      //   · 采样加载失败时仍是**静音**而不是突然冒出合成声(用户明确不要合成声);
      //     若将来想恢复, 把下面各 gain 的 0 换回注释里的表达式即可。
      const SYNTH_ENGINE_OFF = 0;
      // Turbine whine / fan drone / combustion roar / exhaust hiss 全部关闭
      const whineFreq = 2200 + thr * 1400;
      const whineHarmFreq = whineFreq * 2.0;
      const whineGain = SYNTH_ENGINE_OFF;
      void whineFreq; void whineHarmFreq;
      // Open the bandpass slightly at high throttle to let more harmonics through
      const whineCut = 2600 + thr * 2200;
      this.engineTurbine?.frequency.setTargetAtTime(whineFreq, now, 0.12);
      this.engineTurbine2?.frequency.setTargetAtTime(whineHarmFreq, now, 0.12);
      this.engineTurbineFilter?.frequency.setTargetAtTime(whineCut, now, 0.15);
      this.engineTurbineGain?.gain.setTargetAtTime(whineGain, now, 0.15);

      // Fan drone: pitch rises 280Hz → 440Hz, volume 0.02 → 0.10, LFO depth grows with throttle
      const fanFreq = 280 + thr * 160;
      const fanGain = SYNTH_ENGINE_OFF; // 原: (0.015 + thr*0.06) * engineVol
      const lfoDepth = thr * 0.04;   // throb gets more pronounced at high power
      this.engineFan?.frequency.setTargetAtTime(fanFreq, now, 0.18);
      this.engineFanGain?.gain.setTargetAtTime(fanGain, now, 0.18);
      this.engineFanLfoGain?.gain.setTargetAtTime(lfoDepth, now, 0.20);

      // Combustion roar: lowpass opens up, volume rises strongly with throttle
      const combustCut = 180 + thr * 600;
      const combustGain = SYNTH_ENGINE_OFF; // 原: (0.045 + thr*0.15) * engineVol
      this.engineCombustFilter?.frequency.setTargetAtTime(combustCut, now, 0.18);
      this.engineCombustGain?.gain.setTargetAtTime(combustGain, now, 0.18);

      // Exhaust hiss: cutoff rises, volume jumps at afterburner throttle (>=0.85)
      const exhaustCut = 2500 + thr * 3000;
      const afterburner = thr >= 0.85 ? (thr - 0.85) / 0.15 : 0;
      const exhaustGain = SYNTH_ENGINE_OFF; // 原: (0.015 + thr*0.06 + ab*0.07) * engineVol
      this.engineExhaustFilter?.frequency.setTargetAtTime(exhaustCut, now, 0.20);
      this.engineExhaustGain?.gain.setTargetAtTime(exhaustGain, now, 0.20);

      window.setTimeout(updateLoop, 80);
    };
    window.setTimeout(updateLoop, 80);
  }

  stopEngine() {
    if (!this.ctx || !this.engineRunning) return;
    this.engineRunning = false;
    this.sampledEngine?.setRunning(false);
    const t = this.ctx.currentTime;
    if (this.engineGain) {
      this.engineGain.gain.cancelScheduledValues(t);
      this.engineGain.gain.setValueAtTime(this.engineGain.gain.value, t);
      this.engineGain.gain.linearRampToValueAtTime(0.0001, t + 0.6);
    }
    // Capture all sources so we can stop them after the fade-out
    const sources = [
      this.engineTurbine, this.engineTurbine2, this.engineFan, this.engineFanLfo,
      this.engineCombustSrc, this.engineExhaustSrc,
    ];
    window.setTimeout(() => {
      for (const s of sources) {
        try { s?.stop(); } catch { /* ignore */ }
      }
    }, 700);
    this.engineTurbine = null;
    this.engineTurbine2 = null;
    this.engineFan = null;
    this.engineFanLfo = null;
    this.engineFanLfoGain = null;
    this.engineGain = null;
    this.engineTurbineGain = null;
    this.engineFanGain = null;
    this.engineTurbineFilter = null;
    this.engineCombustSrc = null;
    this.engineCombustGain = null;
    this.engineCombustFilter = null;
    this.engineExhaustSrc = null;
    this.engineExhaustGain = null;
    this.engineExhaustFilter = null;
  }

  /** Set the engine throttle target (0..1). Drives pitch + volume of the engine loop. */
  setEngineThrottle(t: number) {
    this.engineTargetThrottle = Math.max(0, Math.min(1, t));
    // === 采样引擎层 (per user request: 真实节流阀音色切片) ===
    // 合成层按油门改振荡器参数; 采样层按油门在两段真实录音切片间交叉淡化。
    // 两层叠加: 采样提供真实音色主体, 合成保留随速度变化的涡轮啸叫细节。
    this.sampledEngine?.update(this.engineTargetThrottle);
  }

  // === Engine / airflow volume multipliers (per user request: 设置里可调) ===
  // 0..1.5 user-adjustable — multiplied into the per-component gains each
  // update loop tick so the sliders take effect live.
  private engineVol = 1;
  private windVol = 1;
  setEngineVolume(v: number) {
    this.engineVol = Math.max(0, Math.min(1.5, v));
    // 采样引擎层同样 ×5 (per user request: 导入音效都放大5倍)`n    this.sampledEngine?.setVolume(this.engineVol * ENGINE_SAMPLE_BOOST);
  }
  setWindVolume(v: number) {
    this.windVol = Math.max(0, Math.min(1.5, v));
  }

  /** Set player normalized speed (0..1) — used to compensate explosion
   *  volume at high speed so detonations stay audible over wind noise. */
  setPlayerSpeed(s: number) {
    this.playerSpeedNorm = Math.max(0, Math.min(1, s));
  }

  // === Continuous wind / airflow noise ===================================
  // Filtered white noise whose volume + cutoff rises with airspeed.
  // At idle it's a faint hiss; at high speed it becomes a steady rush.
  /** 预载用户气流录音(替换合成风声);失败则回退合成噪声。 */
  private async loadAirflow() {
    try {
      const res = await fetch(assetUrl('/audio/airflow.wav'));
      const ab = await res.arrayBuffer();
      if (this.ctx && !this.airflowBuffer) this.airflowBuffer = await this.ctx.decodeAudioData(ab);
    } catch { /* 回退合成 */ }
  }

  startWind() {
    if (!this.ctx || this.windRunning) return;
    if (!this.noiseBuffer && !this.airflowBuffer) return;
    this.windRunning = true;
    const t = this.ctx.currentTime;
    // === 用户气流录音(per user request):已裁高频的采样优先替代合成风声 ===
    const usingSample = !!this.airflowBuffer;
    this.windSrc = this.ctx.createBufferSource();
    this.windSrc.buffer = this.airflowBuffer ?? this.noiseBuffer;
    this.windSrc.loop = true;
    this.windFilter = this.ctx.createBiquadFilter();
    if (usingSample) {
      this.windFilter.type = 'lowpass';       // 录音已裁高频,轻微低通防毛刺
      this.windFilter.frequency.value = 9000;
    } else {
      this.windFilter.type = 'bandpass';
      this.windFilter.frequency.value = 900;
      this.windFilter.Q.value = 0.7;
    }
    this.windGain = this.ctx.createGain();
    this.windGain.gain.value = 0.0;
    this.windSrc.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.sfxBus);
    this.windSrc.start(t);
    // === 气流/风声层已停用 (per user request: 原本的引擎和气流声音就不要了) ===
    // 保留节点与循环(便于将来想恢复时只改这里), 但增益恒为 0。
    this.windGain.gain.setValueAtTime(0.0001, t);
    this.windGain.gain.linearRampToValueAtTime(0.0, t + 1.5);

    const updateLoop = () => {
      if (!this.ctx || !this.windRunning) return;
      const now = this.ctx.currentTime;
      const s = this.windTargetSpeed;
      // Cutoff rises with speed — high speed = brighter, edgier wind(合成模式)
      // Volume rises non-linearly with speed; base lowered (per user request:
      // 气流声小点) and multiplied by the user wind-volume multiplier.
      // 气流层已停用(用户不要原气流声): 目标增益恒 0。
      // 原值: (0.015 + Math.pow(s,1.5) * 0.06) * this.windVol
      const targetGain = 0;
      void s;
      if (this.windFilter) {
        if (usingSample) this.windFilter.frequency.setTargetAtTime(9000, now, 0.25);
        else this.windFilter.frequency.setTargetAtTime(600 + s * 2400, now, 0.25);
      }
      if (this.windGain) this.windGain.gain.setTargetAtTime(targetGain, now, 0.25);
      window.setTimeout(updateLoop, 100);
    };
    window.setTimeout(updateLoop, 100);
  }

  stopWind() {
    if (!this.ctx || !this.windRunning) return;
    this.windRunning = false;
    const t = this.ctx.currentTime;
    if (this.windGain) {
      this.windGain.gain.cancelScheduledValues(t);
      this.windGain.gain.setValueAtTime(this.windGain.gain.value, t);
      this.windGain.gain.linearRampToValueAtTime(0.0001, t + 0.5);
    }
    const src = this.windSrc;
    window.setTimeout(() => {
      try { src?.stop(); } catch { /* ignore */ }
    }, 600);
    this.windSrc = null;
    this.windGain = null;
    this.windFilter = null;
  }

  /** Set the airspeed target (0..1, fraction of max speed). Drives wind volume. */
  setWindSpeed(s: number) {
    this.windTargetSpeed = Math.max(0, Math.min(1, s));
  }

  /** A "whoosh" — for nearby missile fly-by or close-pass enemy aircraft.
   *  Pitched band of noise that swells then fades over ~0.6s. */
  flyby(intensity = 1.0) {
    if (!this.ctx || !this.noiseBuffer) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    // Bandpass sweep — gives a "passing" character
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.5;
    bp.frequency.setValueAtTime(400, t);
    bp.frequency.exponentialRampToValueAtTime(1800, t + 0.25);
    bp.frequency.exponentialRampToValueAtTime(600, t + 0.6);
    const g = this.ctx.createGain();
    const vol = Math.min(0.45, 0.20 * intensity);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.18);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    src.connect(bp); bp.connect(g); g.connect(this.sfxBus);
    src.start(t); src.stop(t + 0.7);
  }

  /**
   * **玩家**机炮开火 (per user request: 那些 wav 全部是给玩家用的)。
   *
   * 与 gun() 的区别: gun() 是通用/AI 用的合成机炮声; 本方法在合成声**之上叠加**
   * 用户导入的 连续机炮.wav —— 用户明确要求"新 wav 与原音一起播放, 不是替换"。
   * 既保留原枪口爆音质感, 又加上真实连续扫射的层次。
   *
   * AI 机炮仍走 gun()(只有合成声): 远处的敌机用玩家的近场录音会显得很怪,
   * 而且多架 AI 同时开火会把 5 倍放大的 wav 叠成一团糊音。
   */
  /**
   * 玩家主炮开火 = **只播 25mm 录音**(per user request: 机炮的发射声音不可以叠加)。
   *
   * 之前的做法是每发都叠一次新导入的 连续机炮.wav —— 但机炮每 0.05s 一发
   * (20 发/秒), 而那段 wav 长 0.42s, 于是**每秒叠 8 层**, 听起来是持续轰鸣,
   * 且停火后还要等缓冲放完(用户反馈"停火之后还在播放")。
   *
   * 现在: 主炮只播原有的 25mm 单发录音(gun25mm) —— 每发一个短音, 天然不叠加、
   * 停火即停。新 wav 只在**需要持续扫射质感**的地方用(见 playerGunContinuous)。
   */
  playerGunPrimary() {
    this.gun25mm();
  }

  /**
   * 连续机炮 wav 的**一次性**播放(不叠加)。
   *
   * 用 timeStamp 做速率限制: 同一段 wav 在它自己的时长内不会再次触发 ——
   * 所以按住机炮时会形成"连续的扫射声", 但**永远不会多层叠加**;
   * 松开扳机后不再触发新的播放, 当前那一段自然播完即止(≈0.4s), 不会长鸣。
   */
  private _gunWavUntil = 0;
  playerGunContinuous() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (now < this._gunWavUntil) return;          // 上一段还在播 → 不叠加
    const buf = this.sampleBuffers.get('gun_burst');
    if (!buf) return;
    this._gunWavUntil = now + buf.duration;        // 锁定到本段结束
    this.playSample('gun_burst', { volume: 1.0, rate: 1.0 + Math.random() * 0.04 });
  }

  /**
   * 只叠**新导入的**连续机炮 wav, 不加合成层(保留给需要它的武器)。
   */
  playerGunBurst() {
    this.playerGunContinuous();
  }

  /** 兼容旧调用: 合成机炮 + 受速率限制的采样(不叠加)。 */
  playerGun() {
    this.playerGunContinuous();
    this.gun();
  }

  /**
   * **玩家**导弹发射 (per user request: 发射导弹的 wav 是给玩家按 F 用的)。
   *
   * 与 missileLaunch() 的区别: 本方法把用户导入的 导弹离架和发射.wav 与**原有的**
   * 合成发射声**叠加**播放(用户明确要求"原本那个导入的发射导弹音频也要留下来和
   * 新导入的 wav 一起播放, 而不是被替换")。
   * AI 发射仍走 missileLaunch()(只有原合成声)。
   */
  playerMissileLaunch() {
    // === 玩家发射音 (per user request: 发射导弹直接用这个播放) ===
    // **只用这一个**: 不再叠加原合成 whoosh, 也不再叠 导弹离架和发射.wav ——
    // 用户明确要求发射音就用 zapsplat, 叠加会让发射声浑浊。
    // (missileLaunch() 合成声与 missile_launch.wav 仍保留给 AI/其它路径。)
    this.playSample('missile_player', { volume: 1.0 });
  }

  /** Single gun shot — short percussive burst with low-end thump + high crackle.
   *  通用/AI 机炮(只有合成层)。玩家机炮请用 playerGun()。 */
  gun() {
    if (!this.ctx || !this.noiseBuffer) return;
    const t = this.ctx.currentTime;
    // Noise burst (crackle)
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2200;
    bp.Q.value = 0.6;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    src.connect(bp); bp.connect(g); g.connect(this.sfxBus);
    src.start(t); src.stop(t + 0.10);
    // Low thump
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.05);
    const g2 = this.ctx.createGain();
    g2.gain.setValueAtTime(0.18, t);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    osc.connect(g2); g2.connect(this.sfxBus);
    osc.start(t); osc.stop(t + 0.08);
  }

  // === AC-130 gunship cannons (per user request) =========================
  // The uploaded 105mm炮.mp3 and 40mm炮.mp3 are now played through the SFX
  // bus. The 105mm routes through the explosion bus too so it punches
  // through wind/engine like a real howitzer shot. Falls back to a heavier
  // synth version of gun() if the sample isn't loaded yet.

  /** 105mm howitzer — the AC-130's main side-firing cannon. */
  cannon105() {
    // Pan hard left — the gunport is on the port side.
    const ok = this.playSample('cannon_105mm', { volume: 1.0, pan: -0.85, bus: this.explosionBus });
    if (!ok) {
      // Fallback: heavy synth thump
      if (!this.ctx || !this.noiseBuffer) return;
      const t = this.ctx.currentTime;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer; src.loop = true;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(800, t);
      lp.frequency.exponentialRampToValueAtTime(120, t + 0.3);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.6, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      src.connect(lp); lp.connect(g); g.connect(this.explosionBus);
      src.start(t); src.stop(t + 0.45);
    }
  }

  /** 40mm Bofors — the AC-130's secondary side-firing cannon. */
  cannon40() {
    const ok = this.playSample('cannon_40mm', { volume: 0.7, pan: -0.7 });
    if (!ok) {
      // Fallback: medium synth burst
      if (!this.ctx || !this.noiseBuffer) return;
      const t = this.ctx.currentTime;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer; src.loop = true;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 600; bp.Q.value = 0.8;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.4, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      src.connect(bp); bp.connect(g); g.connect(this.sfxBus);
      src.start(t); src.stop(t + 0.22);
    }
  }

  /** 25mm GAU-12 Equalizer — used by A-10/A-10 replacement & F-35 gun runs. */
  gun25mm() {
    const ok = this.playSample('gun_25mm', { volume: 0.45, rate: 1.0 + Math.random() * 0.06 });
    if (!ok) this.gun(); // fallback to synth gun
  }

  /** Thunderclap — random pitch + volume variation so repeats don't get stale. */
  thunder(volume = 1.0) {
    const ok = this.playSample('thunder', {
      volume: Math.max(0.4, Math.min(1.2, volume)),
      rate: 0.85 + Math.random() * 0.3,
      bus: this.explosionBus,
    });
    if (!ok) {
      // Fallback: long low rumble synth
      if (!this.ctx || !this.noiseBuffer) return;
      const t = this.ctx.currentTime;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer; src.loop = true;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(400, t);
      lp.frequency.exponentialRampToValueAtTime(80, t + 2.0);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.5 * volume, t + 0.1);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.0);
      src.connect(lp); lp.connect(g); g.connect(this.explosionBus);
      src.start(t); src.stop(t + 2.1);
    }
  }

  /** Sonic boom — when the player breaks the sound barrier. */
  sonicBoom() {
    const ok = this.playSample('sonic_boom', { volume: 0.8, bus: this.explosionBus });
    if (!ok) this.explosion(1.2);
  }

  // === Ambient rain loop (stormy weather) ================================
  // Plays a continuous rain sample, fading in/out with weather intensity.
  private rainSrc: AudioBufferSourceNode | null = null;
  private rainGain: GainNode | null = null;
  private rainRunning = false;
  private rainTargetVolume = 0;

  /** Start the rain ambient loop. Call when entering storm/rain weather. */
  startRain() {
    if (!this.ctx || this.rainRunning) return;
    const buf = this.sampleBuffers.get('amb_rain');
    if (!buf) {
      // Fallback: synthesized rain (filtered white noise loop)
      this.startRainSynth();
      return;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(g); g.connect(this.sfxBus);
    src.start();
    this.rainSrc = src;
    this.rainGain = g;
    this.rainRunning = true;
    this.updateRainVolume();
  }

  private startRainSynth() {
    if (!this.ctx || !this.noiseBuffer || this.rainRunning) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer; src.loop = true;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1200;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 7000;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(this.sfxBus);
    src.start();
    this.rainSrc = src;
    this.rainGain = g;
    this.rainRunning = true;
    this.updateRainVolume();
  }

  /** Stop the rain ambient loop. */
  stopRain() {
    if (!this.rainRunning) return;
    this.rainTargetVolume = 0;
    if (this.rainGain && this.ctx) {
      this.rainGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.5);
    }
    const src = this.rainSrc;
    const g = this.rainGain;
    window.setTimeout(() => {
      try { src?.stop(); } catch {}
      try { src?.disconnect(); } catch {}
      try { g?.disconnect(); } catch {}
    }, 1200);
    this.rainSrc = null;
    this.rainGain = null;
    this.rainRunning = false;
  }

  /** Set rain intensity 0..1 (drives the ambient loop volume). */
  setRainIntensity(v: number) {
    this.rainTargetVolume = Math.max(0, Math.min(1, v)) * 0.55;
    this.updateRainVolume();
  }

  private updateRainVolume() {
    if (!this.rainGain || !this.ctx) return;
    this.rainGain.gain.setTargetAtTime(this.rainTargetVolume, this.ctx.currentTime, 0.3);
  }

  isRainRunning() { return this.rainRunning; }

  /** Missile launch — descending whoosh with igniter pop.
   *  Keeps the synthesized whoosh (the uploaded 导弹发射.mp3 was a corrupt
   *  39-byte placeholder) but adds a sharper high-frequency transient at
   *  the start so the launch cuts through wind/engine at high speed. */
  missileLaunch() {
    // 通用/AI 导弹发射 = **纯合成声**(原有的离架爆音 + 锯齿波 whoosh)。
    // 玩家按 F 发射请用 playerMissileLaunch() —— 那个会在此之上叠加用户 wav。
    // (per user request: wav 是给玩家用的, 且要与原音一起播放而不是替换)
    if (!this.ctx || !this.noiseBuffer) return;
    const t = this.ctx.currentTime;
    // Igniter pop
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1500, t);
    lp.frequency.exponentialRampToValueAtTime(200, t + 0.4);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.32, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    src.connect(lp); lp.connect(g); g.connect(this.sfxBus);
    src.start(t); src.stop(t + 0.65);
    // Whoosh tone (descending)
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(440, t);
    osc.frequency.exponentialRampToValueAtTime(120, t + 0.5);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 800;
    bp.Q.value = 2;
    const g2 = this.ctx.createGain();
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.linearRampToValueAtTime(0.20, t + 0.05);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    osc.connect(bp); bp.connect(g2); g2.connect(this.sfxBus);
    osc.start(t); osc.stop(t + 0.55);
    // === Sharp launch crack (per user request) ===
    // High-frequency transient at t=0 so the launch is unmistakable even
    // when the player is at full afterburner.
    const crackSrc = this.ctx.createBufferSource();
    crackSrc.buffer = this.noiseBuffer;
    crackSrc.loop = true;
    const crackHp = this.ctx.createBiquadFilter();
    crackHp.type = 'highpass';
    crackHp.frequency.value = 4000;
    const crackG = this.ctx.createGain();
    crackG.gain.setValueAtTime(0.18, t);
    crackG.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    crackSrc.connect(crackHp); crackHp.connect(crackG); crackG.connect(this.sfxBus);
    crackSrc.start(t); crackSrc.stop(t + 0.1);
  }

  /** Missile rack drop-off clunk — plays just before missileLaunch().
   *  A short metallic clunk + hiss: the sound of the missile falling off
   *  the rail before the rocket motor ignites. */
  missileRack() {
    if (!this.ctx || !this.noiseBuffer) return;
    const t = this.ctx.currentTime;
    // Metallic clunk — two detuned square waves with fast decay
    const osc1 = this.ctx.createOscillator();
    osc1.type = 'square';
    osc1.frequency.setValueAtTime(420, t);
    osc1.frequency.exponentialRampToValueAtTime(180, t + 0.08);
    const osc2 = this.ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.setValueAtTime(560, t);
    osc2.frequency.exponentialRampToValueAtTime(220, t + 0.08);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.14, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.10);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 800;
    bp.Q.value = 2;
    osc1.connect(bp); osc2.connect(bp); bp.connect(g); g.connect(this.sfxBus);
    osc1.start(t); osc1.stop(t + 0.12);
    osc2.start(t); osc2.stop(t + 0.12);
    // Short mechanical hiss — pneumatic rail release
    const hissSrc = this.ctx.createBufferSource();
    hissSrc.buffer = this.noiseBuffer;
    hissSrc.loop = true;
    const hissHp = this.ctx.createBiquadFilter();
    hissHp.type = 'highpass';
    hissHp.frequency.value = 2500;
    const hissG = this.ctx.createGain();
    hissG.gain.setValueAtTime(0.0001, t);
    hissG.gain.linearRampToValueAtTime(0.10, t + 0.02);
    hissG.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    hissSrc.connect(hissHp); hissHp.connect(hissG); hissG.connect(this.sfxBus);
    hissSrc.start(t); hissSrc.stop(t + 0.2);
  }

  /** Explosion — bass thump + filtered noise burst. `scale` 0..2.
   *  Routed through the dedicated explosion bus (with compressor) so it
   *  punches through wind/engine noise — fixes "高速时听不到爆炸声". */
  explosion(scale = 1.0) {
    if (!this.ctx || !this.noiseBuffer) return;
    const t = this.ctx.currentTime;
    // === Speed compensation (per user request) ===
    // At high speed, wind + engine noise masks the explosion. We boost the
    // explosion volume by up to +60% at full speed so it stays audible.
    // The compressor on the explosion bus prevents this from clipping.
    const speedBoost = 1.0 + this.playerSpeedNorm * 0.6;
    const vol = Math.min(0.95, 0.35 * scale * speedBoost);
    // Noise burst with falling lowpass
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2200, t);
    lp.frequency.exponentialRampToValueAtTime(140, t + 0.7 * scale);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8 * scale);
    src.connect(lp); lp.connect(g); g.connect(this.explosionBus);
    src.start(t); src.stop(t + 0.85 * scale);
    // Sub-bass thump
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.4 * scale);
    const g2 = this.ctx.createGain();
    g2.gain.setValueAtTime(vol * 0.95, t);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.5 * scale);
    osc.connect(g2); g2.connect(this.explosionBus);
    osc.start(t); osc.stop(t + 0.55 * scale);
    // === High-frequency crack (per user request) ===
    // Adds a sharp transient crack on top of the boom — gives the explosion
    // more punch and ensures it cuts through even at very high speed where
    // the low-frequency rumble gets masked by engine combustion.
    if (this.noiseBuffer) {
      const crackSrc = this.ctx.createBufferSource();
      crackSrc.buffer = this.noiseBuffer;
      crackSrc.loop = true;
      const crackHp = this.ctx.createBiquadFilter();
      crackHp.type = 'highpass';
      crackHp.frequency.value = 3000;
      const crackG = this.ctx.createGain();
      crackG.gain.setValueAtTime(vol * 0.7, t);
      crackG.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      crackSrc.connect(crackHp); crackHp.connect(crackG); crackG.connect(this.explosionBus);
      crackSrc.start(t); crackSrc.stop(t + 0.14);
    }
  }

  /** Lock-on progress beep — pitch rises with progress. Pass 0..1. */
  lockProgress(progress: number) {
    if (!this.ctx) return;
    // Beep every ~0.4s while acquiring; pitch rises with progress
    const now = this.ctx.currentTime;
    if (now - this.lockBeepTimer < 0.30) return;
    this.lockBeepTimer = now;
    const freq = 600 + progress * 600;
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.06, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
    osc.connect(g); g.connect(this.sfxBus);
    osc.start(now); osc.stop(now + 0.10);
    this.lastLockProgress = progress;
  }

  /** Lock acquired — 玩家锁定确认: 叠加用户采样 + 保留原双音确认音。
   *  (per user request: wav 与原音一起播放, 不是替换) */
  lockAcquired() {
    this.playSample('lock_on', { volume: 1.0 });
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const playTone = (freq: number, start: number, dur: number, vol: number) => {
      const osc = this.ctx!.createOscillator();
      osc.type = 'square';
      osc.frequency.value = freq;
      const g = this.ctx!.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.linearRampToValueAtTime(vol, start + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(g); g.connect(this.sfxBus);
      osc.start(start); osc.stop(start + dur + 0.05);
    };
    playTone(880, t, 0.10, 0.10);
    playTone(1320, t + 0.10, 0.18, 0.10);
  }

  /** Stall warning — repeating beep. Toggle on/off. */
  stall(active: boolean) {
    this.stallActive = active;
    if (active && this.stallTimer === null) {
      const beep = () => {
        if (!this.ctx || !this.stallActive) return;
        const t = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.value = 1100;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.10, t + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.10);
        osc.connect(g); g.connect(this.sfxBus);
        osc.start(t); osc.stop(t + 0.12);
        this.stallTimer = window.setTimeout(beep, 350);
      };
      beep();
    } else if (!active && this.stallTimer !== null) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  /** Player took a hit — 叠加用户采样(被击中.wav) + 保留原合成受击声。
   *  (per user request: wav 与原音一起播放, 不是替换) */
  hit() {
    this.playSample('player_hit', { volume: 1.0 });
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(50, t + 0.25);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.30, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.30);
    osc.connect(g); g.connect(this.sfxBus);
    osc.start(t); osc.stop(t + 0.35);
    // Metallic clang
    const osc2 = this.ctx.createOscillator();
    osc2.type = 'triangle';
    osc2.frequency.value = 720;
    const g2 = this.ctx.createGain();
    g2.gain.setValueAtTime(0.12, t);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc2.connect(g2); g2.connect(this.sfxBus);
    osc2.start(t); osc2.stop(t + 0.2);
  }

  /** Missile incoming warning — urgent repeating tone. Toggle on/off. */
  private missileWarnActive = false;
  /** 雷达照射采样是否已播过(避免每帧重播) */
  private _radarLockPlayed = false;
  private missileWarnTimer: number | null = null;
  missileWarning(active: boolean) {
    this.missileWarnActive = active;
    // === 采样替换 (per user request: 被雷达照射.wav) ===
    // 用户的录音是真实的 RWR(雷达告警接收机)被照射音 —— 比合成方波 beep 真实。
    // 进入告警时播一次作为"底"; 之后仍保留轻量的周期 beep(合成), 因为真实 RWR
    // 也是"持续音 + 随威胁接近加快的脉冲", 两者叠加更贴近实机。
    // 采样缺失时完全回退到原来的合成 beep 循环。
    if (active && !this._radarLockPlayed) {
      this._radarLockPlayed = this.playSample('radar_lock', { volume: 0.9 });
    } else if (!active) {
      this._radarLockPlayed = false;
    }
    if (active && this.missileWarnTimer === null) {
      const beep = () => {
        if (!this.ctx || !this.missileWarnActive) return;
        const t = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.value = 1500;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.10, t + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
        osc.connect(g); g.connect(this.sfxBus);
        osc.start(t); osc.stop(t + 0.10);
        // Second beep 120ms later
        const t2 = t + 0.12;
        const osc2 = this.ctx.createOscillator();
        osc2.type = 'square';
        osc2.frequency.value = 1800;
        const g3 = this.ctx.createGain();
        g3.gain.setValueAtTime(0.0001, t2);
        g3.gain.linearRampToValueAtTime(0.10, t2 + 0.005);
        g3.gain.exponentialRampToValueAtTime(0.0001, t2 + 0.08);
        osc2.connect(g3); g3.connect(this.sfxBus);
        osc2.start(t2); osc2.stop(t2 + 0.10);
        this.missileWarnTimer = window.setTimeout(beep, 700);
      };
      beep();
    } else if (!active && this.missileWarnTimer !== null) {
      clearTimeout(this.missileWarnTimer);
      this.missileWarnTimer = null;
    }
  }

  // === Incoming-lock radar warning (per user request: 被锁定时有雷达告警) ===
  // Distinct from the missile-inbound warning: a single lower-pitched pulsing
  // tone (700 Hz) that repeats while an enemy is building a lock. Quieter
  // than the urgent 1500/1800 Hz missile double-beep so players can tell the
  // two threats apart.
  incomingLockAlert() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 700;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.07, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.connect(g); g.connect(this.sfxBus);
    osc.start(t); osc.stop(t + 0.25);
  }

  // === Radio static bed (per user request: AI对话语音要有无线电底噪) ===
  // A looped white-noise hiss through a bandpass filter, faded in/out with a
  // smooth envelope — plays UNDER the spoken radio line so the voice sounds
  // like it's coming over a real radio channel (like the squelch bursts).
  // === Louder static + crackle (per user request: 电子底噪要够明显) ===
  radioStatic(durationSec: number, intensity = 0.5) {
    if (!this.ctx || !this.noiseBuffer) return;
    const t = this.ctx.currentTime;
    // Main hiss bed.
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1600;
    bp.Q.value = 0.6;
    const g = this.ctx.createGain();
    const dur = Math.max(0.2, durationSec);
    // Fast fade-in, sustained bed, slow fade-out (like a transmission).
    // Gain raised 0.16 → 0.34 so the electronic hiss is clearly audible.
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(intensity * 0.34, t + 0.06);
    g.gain.setValueAtTime(intensity * 0.34, t + Math.max(0.06, dur - 0.12));
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    src.connect(bp); bp.connect(g); g.connect(this.radioBus);
    src.start(t);
    src.stop(t + dur + 0.05);
    // Random crackle pops — sharp little spikes over the hiss.
    const popCount = Math.max(2, Math.floor(dur * 5));
    for (let i = 0; i < popCount; i++) {
      const pt = t + 0.08 + Math.random() * Math.max(0.1, dur - 0.2);
      const pop = this.ctx.createBufferSource();
      pop.buffer = this.noiseBuffer;
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 3200;
      const pg = this.ctx.createGain();
      pg.gain.setValueAtTime(0.0001, pt);
      pg.gain.linearRampToValueAtTime(intensity * 0.22, pt + 0.004);
      pg.gain.exponentialRampToValueAtTime(0.0001, pt + 0.035);
      pop.connect(hp); hp.connect(pg); pg.connect(this.radioBus);
      pop.start(pt);
      pop.stop(pt + 0.05);
    }
  }

  // ============================================================
  // === RADIO VOICE + SQUELCH ==================================
  // ============================================================

  /** Radio squelch beep — short burst that plays before/after each transmission. */
  radioSquelch(open: boolean) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = open ? 1750 : 1200;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.06, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    // Add a tiny bit of noise for "static"
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1500;
    osc.connect(hp); hp.connect(g); g.connect(this.radioBus);
    osc.start(t); osc.stop(t + 0.07);
  }

  /**
   * Synthesize a short radio voice burst. Different speakers have different
   * base frequency + formant filter to feel like different people.
   * The voice is a series of short amplitude-modulated tone bursts with a
   * bandpass filter — gives a "walkie-talkie" voice quality.
   */
  radioVoice(opts: Partial<RadioVoiceOpts> & { speaker: Speaker }) {
    if (!this.ctx) return;
    const preset = SPEAKER_PRESETS[opts.speaker];
    const freq = opts.freq ?? preset.freq;
    const formant = opts.formant ?? preset.formant;
    const dur = opts.dur ?? 0.35;
    const t = this.ctx.currentTime;

    // Opening squelch
    this.radioSquelch(true);

    // Voice: amplitude-modulated oscillator with random syllable pattern
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    // Slight vibrato
    const lfo = this.ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 5;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = freq * 0.02;
    lfo.connect(lfoGain); lfoGain.connect(osc.frequency);

    // Formant filter (bandpass)
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = formant;
    bp.Q.value = 4;

    // Amplitude envelope — broken into ~4-6 "syllables"
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    const syllables = Math.max(3, Math.floor(dur / 0.06));
    for (let i = 0; i < syllables; i++) {
      const st = t + (i / syllables) * dur;
      const amp = 0.10 + Math.random() * 0.06;
      g.gain.linearRampToValueAtTime(amp, st + 0.005);
      g.gain.linearRampToValueAtTime(0.0001, st + (dur / syllables) * 0.85);
    }
    g.gain.setValueAtTime(0.0001, t + dur);

    // Hi-pass to make it sound "radio-like"
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;

    osc.connect(bp); bp.connect(hp); hp.connect(g); g.connect(this.radioBus);
    osc.start(t); osc.stop(t + dur + 0.05);
    lfo.start(t); lfo.stop(t + dur + 0.05);

    // Closing squelch
    const closeT = t + dur + 0.05;
    const csOsc = this.ctx.createOscillator();
    csOsc.type = 'sine';
    csOsc.frequency.value = 1200;
    const csG = this.ctx.createGain();
    csG.gain.setValueAtTime(0.0001, closeT);
    csG.gain.linearRampToValueAtTime(0.05, closeT + 0.005);
    csG.gain.exponentialRampToValueAtTime(0.0001, closeT + 0.05);
    csOsc.connect(csG); csG.connect(this.radioBus);
    csOsc.start(closeT); csOsc.stop(closeT + 0.07);
  }

  // ============================================================
  // === PRE-RECORDED RADIO VOICE (IndexTTS 中文配音) ==========
  // ============================================================

  /** Whether the audio graph is up (user has interacted with the page). */
  isReady(): boolean {
    return !!this.ctx && this.initialized;
  }

  /**
   * Fetch + decode a per-line radio voice mp3, cached for the session.
   * Returns null when the file is missing/undecodable or audio isn't ready —
   * callers treat null as "no voice for this line".
   */
  async preloadRadioVoice(fileUrl: string): Promise<AudioBuffer | null> {
    if (!this.ctx) return null;
    if (this.radioVoiceBuffers.has(fileUrl)) return this.radioVoiceBuffers.get(fileUrl)!;
    if (this.radioVoiceDecode.has(fileUrl)) return this.radioVoiceDecode.get(fileUrl)!;
    const p = (async (): Promise<AudioBuffer | null> => {
      try {
        const res = await fetch(assetUrl(fileUrl));
        if (!res.ok) return null;
        const arr = await res.arrayBuffer();
        const buf = await this.ctx!.decodeAudioData(arr);
        this.radioVoiceBuffers.set(fileUrl, buf);
        return buf;
      } catch {
        return null; // missing / network / decode failure — silent voice skip
      } finally {
        this.radioVoiceDecode.delete(fileUrl);
      }
    })();
    this.radioVoiceDecode.set(fileUrl, p);
    return p;
  }

  /**
   * Play one decoded radio-voice line through radioBus with a light "radio
   * comms" EQ (high-pass + low-pass). `onEnded` fires when playback completes
   * naturally (or immediately when there is nothing to play). Returns the
   * decoded buffer so callers know the real duration; null = not playable.
   */
  async playRadioVoice(
    fileUrl: string,
    opts: { volume?: number; onEnded?: () => void } = {},
  ): Promise<AudioBuffer | null> {
    const buf = await this.preloadRadioVoice(fileUrl);
    if (!buf || !this.ctx || this.initialized === false) {
      // Nothing playable — do NOT fire onEnded here (that would end a
      // subtitle-only line instantly); the caller falls back on its own.
      return buf;
    }
    const t = this.ctx.currentTime;
    this.stopRadioVoice();

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    // Light "radio channel" coloration — cut sub-bass rumble + harsh highs.
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 180;
    hp.Q.value = 0.5;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 8000;
    // === 剧情语音整体放大 (per user request: 剧情语音对话音量都太小了, 一起放大两三倍) ======
    // 原来这一路是 0.95 x radioBus(0.55) ≈ 满刻度 0.52, 于是文件电平再高也听着小。
    // 现在语音增益提到 2.0, 并在它与总线之间插一级压缩器兜峰值(见下面的 comp), 听感约 2.5 倍。
    const g = this.ctx.createGain();
    g.gain.value = (opts.volume ?? 0.95) * 2.1;
    // Short fade to avoid a click at line start/end.
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(g.gain.value, t + 0.012);
    g.gain.setValueAtTime(g.gain.value, t + Math.max(0.012, buf.duration - 0.05));
    g.gain.linearRampToValueAtTime(0.0001, t + buf.duration);

    src.onended = () => {
      if (this.radioVoiceSource === src) this.radioVoiceSource = null;
      opts.onEnded?.();
    };
    // 压缩器: 阈值 -14dB / 4:1, 把放大后的峰值压住 —— 响度上去了但不削顶
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 6;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.22;
    src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(comp); comp.connect(this.radioBus);
    this.radioVoiceSource = src;
    src.start(t);
    src.stop(t + buf.duration + 0.02);
    return buf;
  }

  /** Cut any in-flight radio voice line immediately (mission end / clear). */
  stopRadioVoice() {
    if (this.radioVoiceSource) {
      try { this.radioVoiceSource.onended = null; } catch { /* ignore */ }
      try { this.radioVoiceSource.stop(); } catch { /* ignore */ }
      this.radioVoiceSource = null;
    }
  }

  /** Discard decoded voice cache (on dispose / audio re-init). */
  private clearRadioVoiceCache() {
    this.radioVoiceBuffers.clear();
    this.radioVoiceDecode.clear();
  }

  // ============================================================
  // === CLEANUP ================================================
  // ============================================================

  dispose() {
    this.stopMusic();
    this.stopEngine();
    this.stopWind();
    this.stall(false);
    this.missileWarning(false);
    this.stopRadioVoice();
    this.clearRadioVoiceCache();
    if (this.ctx) {
      try { this.ctx.close(); } catch { /* ignore */ }
      this.ctx = null;
    }
    this.initialized = false;
  }
}
