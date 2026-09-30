// === 终端音效(Web Audio 实时合成, 零素材) =================================
// 为什么合成而不是放素材: 单文件发布已逼近平台上传阈值(99.9MB),
// 而"继电器咔哒/走带静电/CRT 断电"这类短促机械音用振荡器+噪声几行就能合成,
// 体积极小且不需要 base64 内联。
//
// 约束(浏览器自动播放策略):
//   - AudioContext 必须在**用户手势**里创建/恢复, 所以只有用户按键或点击时才响;
//   - 不注册任何自动播放; 静音开关持久化在 localStorage('skybound.uiSound');
//   - 与游戏本体的 audio.ts 完全独立(那套是战斗音效, 这里只是 UI 反馈)。
// ============================================================================

type Ctor = typeof AudioContext;

const SETTING_KEY = 'skybound.uiSound';

let ctx: AudioContext | null = null;
let muted: boolean | null = null;
/** 是否已经有过真实用户手势(自动播放策略门槛)。 */
let hadGesture = false;

/** 标记"用户已交互"(全局委托会自动调用; 也可由调用方在事件处理里显式调用)。 */
export function markUserGesture(): void {
  hadGesture = true;
}

// === 诊断/自动化计数 (P5 验收用) ===
// 只累加计数、不产生任何副作用: headless 断言"手势前无 AudioContext、手势后
// 确实发声"靠它。window 上挂一个只读快照对象。
type SfxCounters = Record<string, number> & { ctxCreated?: number; denied?: number };
function counters(): SfxCounters {
  if (typeof window === 'undefined') return {};
  const w = window as unknown as { __uiSfx?: SfxCounters };
  if (!w.__uiSfx) w.__uiSfx = {};
  return w.__uiSfx;
}
function bump(name: string): void {
  const c = counters();
  c[name] = (c[name] ?? 0) + 1;
}

/** 同类音效的最小间隔(ms) —— 组件显式调用与全局委托可能同时触发, 靠它去重。 */
const DEBOUNCE_MS = 45;
const lastAt: Record<string, number> = {};
function tooSoon(name: string): boolean {
  const now = Date.now();
  if (now - (lastAt[name] ?? 0) < DEBOUNCE_MS) return true;
  lastAt[name] = now;
  return false;
}

function readMuted(): boolean {
  if (muted !== null) return muted;
  if (typeof window === 'undefined') return true;
  muted = window.localStorage.getItem(SETTING_KEY) === 'off';
  return muted;
}

/** 静音状态(供 UI 显示) */
export function uiSoundEnabled(): boolean {
  return !readMuted();
}

/** 切换静音; 返回切换后的状态 */
export function setUiSoundEnabled(on: boolean): boolean {
  muted = !on;
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(SETTING_KEY, on ? 'on' : 'off');
  }
  // 关闭时顺手把已经排队的尾音掐掉, 避免"关了还在响"
  if (!on && ctx) {
    try { void ctx.suspend(); } catch { /* ignore */ }
  }
  if (on && ctx) {
    try { void ctx.resume(); } catch { /* ignore */ }
  }
  return on;
}

/** 懒创建 AudioContext(只能在用户手势里首次调用) */
function ac(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (readMuted()) return null;
  // === 用户手势门 (阶段 5) ===
  // 没有手势就创建 AudioContext 会被 Chromium 记一条 "AudioContext was not
  // allowed to start" 警告(且上下文永远 suspended)。所以先等第一次真实输入:
  // 全局委托的监听在**捕获阶段**先跑, 同一事件的音效不会被这条门挡掉。
  if (!hadGesture) return null;
  if (!ctx) {
    const W = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
    const C = W.AudioContext ?? W.webkitAudioContext;
    if (!C) return null;
    try {
      ctx = new C();
      const c = counters();
      c.ctxCreated = (c.ctxCreated ?? 0) + 1;
    } catch { return null; }
  }
  if (ctx.state === 'suspended') {
    try { void ctx.resume(); } catch { /* ignore */ }
  }
  return ctx;
}

/** 一段白噪声缓冲(静电/走带底噪共用) */
function noiseBuffer(c: AudioContext, seconds: number): AudioBuffer {
  const frames = Math.max(1, Math.floor(c.sampleRate * seconds));
  const buf = c.createBuffer(1, frames, c.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < frames; i++) {
    // 轻微低通的白噪(比纯白噪更接近电路底噪)
    const w = Math.random() * 2 - 1;
    last = last * 0.62 + w * 0.38;
    data[i] = last;
  }
  return buf;
}

/** 继电器咔哒: 极短噪声脉冲 + 低通, 用于列表选择/开关 */
function blip(freq = 420, dur = 0.045, gain = 0.05, type: OscillatorType = 'square'): void {
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(60, freq * 0.55), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/** 继电器"哒"(两层: 机械脉冲 + 金属泛音) */
export function playKey(): void {
  if (tooSoon('key')) return;
  bump('key');
  try { playKeyUnsafe(); } catch { /* 音效失败绝不影响 UI */ }
}
function playKeyUnsafe(): void {
  const c = ac();
  if (!c) return;
  blip(560, 0.038, 0.045, 'square');
  blip(1180, 0.022, 0.018, 'triangle');
}

/** 确认/执行: 双音上行 */
export function playConfirm(): void {
  if (tooSoon('confirm')) return;
  bump('confirm');
  try { playConfirmUnsafe(); } catch { /* ignore */ }
}
function playConfirmUnsafe(): void {
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  blip(660, 0.06, 0.05, 'square');
  window.setTimeout(() => { try { blip(990, 0.09, 0.045, 'square'); } catch { /* ignore */ } }, 70);
  // 轻微磁带机走带底噪, 让"确认"听起来像机器在动作
  const src = c.createBufferSource();
  const g = c.createGain();
  const f = c.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 1400;
  f.Q.value = 0.8;
  src.buffer = noiseBuffer(c, 0.16);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.025, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
  src.connect(f); f.connect(g); g.connect(c.destination);
  src.start(t);
}

/** 返回/取消: 单音下行 */
export function playBack(): void {
  if (tooSoon('back')) return;
  bump('back');
  try { blip(320, 0.07, 0.04, 'sawtooth'); } catch { /* ignore */ }
}

/** CRT 断电: 高压泄放(下滑音) + 静电爆 + 低频"噗" */
export function playPowerDown(): void {
  if (tooSoon('powerDown')) return;
  bump('powerDown');
  try { playPowerDownUnsafe(); } catch { /* ignore */ }
}
function playPowerDownUnsafe(): void {
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  // 高压泄放: 从 2.2kHz 一路滑到 40Hz
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(2200, t);
  osc.frequency.exponentialRampToValueAtTime(40, t + 0.42);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.07, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(3000, t);
  lp.frequency.exponentialRampToValueAtTime(220, t + 0.42);
  osc.connect(lp); lp.connect(g); g.connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.5);
  // 静电爆
  const src = c.createBufferSource();
  const ng = c.createGain();
  const hp = c.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 900;
  src.buffer = noiseBuffer(c, 0.34);
  ng.gain.setValueAtTime(0.0001, t);
  ng.gain.exponentialRampToValueAtTime(0.05, t + 0.008);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
  src.connect(hp); hp.connect(ng); ng.connect(c.destination);
  src.start(t);
  // 低频"噗"
  const thump = c.createOscillator();
  const tg = c.createGain();
  thump.type = 'sine';
  thump.frequency.setValueAtTime(120, t);
  thump.frequency.exponentialRampToValueAtTime(38, t + 0.3);
  tg.gain.setValueAtTime(0.0001, t);
  tg.gain.exponentialRampToValueAtTime(0.09, t + 0.02);
  tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
  thump.connect(tg); tg.connect(c.destination);
  thump.start(t);
  thump.stop(t + 0.36);
}

// ============================================================================
// 阶段 5 补充: 开机 / 静电 / 走带 / 拒绝 + 全局委托
// ============================================================================

/** CRT 开机: 高压建立(上滑音) + 消磁"咚" + 静电尾巴 */
export function playPowerUp(): void {
  if (tooSoon('powerUp')) return;
  bump('powerUp');
  try {
    const c = ac();
    if (!c) return;
    const t = c.currentTime;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(48, t);
    osc.frequency.exponentialRampToValueAtTime(1500, t + 0.38);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.44);
    osc.connect(g); g.connect(c.destination);
    osc.start(t); osc.stop(t + 0.48);
    // 消磁"咚"
    const thump = c.createOscillator();
    const tg = c.createGain();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(90, t);
    thump.frequency.exponentialRampToValueAtTime(40, t + 0.22);
    tg.gain.setValueAtTime(0.0001, t);
    tg.gain.exponentialRampToValueAtTime(0.075, t + 0.015);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    thump.connect(tg); tg.connect(c.destination);
    thump.start(t); thump.stop(t + 0.28);
    // 静电尾
    const src = c.createBufferSource();
    const ng = c.createGain();
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 0.7;
    src.buffer = noiseBuffer(c, 0.28);
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.03, t + 0.03);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    src.connect(bp); bp.connect(ng); ng.connect(c.destination);
    src.start(t + 0.05);
  } catch { /* ignore */ }
}

/** 静电爆(切屏/换页): 短促高频噪声 */
export function playStatic(): void {
  if (tooSoon('static')) return;
  bump('static');
  try {
    const c = ac();
    if (!c) return;
    const t = c.currentTime;
    const src = c.createBufferSource();
    const g = c.createGain();
    const hp = c.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1200;
    src.buffer = noiseBuffer(c, 0.14);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.028, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    src.connect(hp); hp.connect(g); g.connect(c.destination);
    src.start(t);
  } catch { /* ignore */ }
}

/** 磁带机走带: 低频嗡鸣 + 抖晃(wow/flutter) + 带噪, 用于进入/切换磁带屏 */
export function playTape(): void {
  if (tooSoon('tape')) return;
  bump('tape');
  try {
    const c = ac();
    if (!c) return;
    const t = c.currentTime;
    const dur = 0.5;
    // 马达嗡鸣
    const motor = c.createOscillator();
    const mg = c.createGain();
    motor.type = 'sawtooth';
    motor.frequency.setValueAtTime(58, t);
    // 抖晃: 频率被 LFO 轻微调制(听感上像磁带机转速不匀)
    const lfo = c.createOscillator();
    const lfoGain = c.createGain();
    lfo.frequency.value = 6.2;
    lfoGain.gain.value = 2.4;
    lfo.connect(lfoGain); lfoGain.connect(motor.frequency);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 420;
    mg.gain.setValueAtTime(0.0001, t);
    mg.gain.exponentialRampToValueAtTime(0.045, t + 0.06);
    mg.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    motor.connect(lp); lp.connect(mg); mg.connect(c.destination);
    motor.start(t); motor.stop(t + dur + 0.02);
    lfo.start(t); lfo.stop(t + dur + 0.02);
    // 带噪(摩擦)
    const src = c.createBufferSource();
    const ng = c.createGain();
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1900; bp.Q.value = 0.6;
    src.buffer = noiseBuffer(c, dur);
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.016, t + 0.05);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp); bp.connect(ng); ng.connect(c.destination);
    src.start(t);
  } catch { /* ignore */ }
}

/** 无效操作(禁用项/被拒绝): 低频短促蜂鸣 */
export function playDeny(): void {
  if (tooSoon('deny')) return;
  bump('deny');
  try {
    const c = ac();
    if (!c) return;
    const t = c.currentTime;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(138, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.035, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(g); g.connect(c.destination);
    osc.start(t); osc.stop(t + 0.2);
  } catch { /* ignore */ }
}

/** 诊断快照(自动化断言用): 各类音效触发次数 + AudioContext 是否已创建。 */
export function uiSoundDebug(): { enabled: boolean; counters: SfxCounters } {
  return { enabled: uiSoundEnabled(), counters: { ...counters() } };
}

const CLICKABLE = 'button, [role="option"], [role="button"], a, label, input[type="checkbox"], input[type="radio"], select';

/**
 * 全局 UI 音效委托(阶段 5)。
 *
 * 为什么用委托而不是逐个组件改: 本作有 8 个菜单屏 + 大量小按钮, 逐个接线既啰嗦
 * 又容易漏。这里在 document 上挂一对监听, 按"控件类型"发对应音效 —— 组件里已有
 * 的显式调用仍然保留(MainMenu), 同名声效在 45ms 内会被去重, 不会双响。
 *
 * ⚠ 只在**菜单阶段**安装(GameApp 按 phase 挂/卸): 战斗中的鼠标点击/按键是操作
 * 飞机, 不该发终端音效。
 *
 * @returns 卸载函数
 */
export function installUiSoundBindings(): () => void {
  if (typeof document === 'undefined') return () => { /* noop */ };

  const onClick = (e: MouseEvent) => {
    markUserGesture();
    const el = e.target as Element | null;
    if (!el || typeof el.closest !== 'function') return;
    const hit = el.closest(CLICKABLE);
    if (!hit) return;
    const disabled = (hit as HTMLButtonElement).disabled === true
      || hit.getAttribute('aria-disabled') === 'true';
    if (disabled) { playDeny(); return; }
    playKey();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    markUserGesture();
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'Home':
      case 'End':
      case 'Tab':
        playKey();
        break;
      case 'Enter':
      case ' ':
        playConfirm();
        break;
      case 'Escape':
      case 'Backspace':
        playBack();
        break;
      default:
        break;
    }
  };

  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  return () => {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
  };
}

