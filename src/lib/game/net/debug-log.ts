// ============================================================================
// 联机实时 debug 日志 (per user request: 联机界面加实时运行的 debug 日志)
// ============================================================================
// 为什么需要: 联机这条链路本身是"看不见"的 —— SDK 初始化/登录、房间加入、peer 发现、
// 快照收发、伤害路由、抗作弊拒绝……任何一步断了, 玩家界面只会表现为"没反应"。
// 之前这些信息只进 console, 而**上传后的页面按不了 F12**, 等于看不到。
//
// 设计:
//   · 极小的环形缓冲(默认 300 行) + 订阅回调 —— 不引入任何依赖, 也不碰游戏状态;
//   · 全局捕获 console.warn/error 与未捕获异常/未处理 Promise 拒绝, 一次安装;
//   · 高频事件(逐帧统计)由调用方**节流**后再写, 避免刷屏(见 session.ts 的用法)。
//
// 只在 UI 里展示, 不落库、不上传。

export type LogLevel = 'info' | 'ok' | 'warn' | 'error' | 'net';

export interface LogLine {
  id: number;
  /** 墙钟时间戳(ms) */
  at: number;
  level: LogLevel;
  text: string;
}

const MAX_LINES = 300;

let seq = 0;
const lines: LogLine[] = [];
const subs: ((l: LogLine) => void)[] = [];
let captureInstalled = false;

/** 写一行日志(所有联机模块共用)。 */
export function logLine(level: LogLevel, text: string): void {
  const l: LogLine = { id: ++seq, at: Date.now(), level, text: String(text).slice(0, 400) };
  lines.push(l);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  for (const cb of subs) {
    try { cb(l); } catch { /* 单个订阅者出错不影响其它 */ }
  }
}

export const logInfo = (t: string) => logLine('info', t);
export const logOk = (t: string) => logLine('ok', t);
export const logWarn = (t: string) => logLine('warn', t);
export const logError = (t: string) => logLine('error', t);
export const logNet = (t: string) => logLine('net', t);

/** 取当前全部日志(UI 首次挂载时回填)。 */
export function getLog(): LogLine[] {
  return [...lines];
}

export function subscribeLog(cb: (l: LogLine) => void): () => void {
  subs.push(cb);
  return () => {
    const i = subs.indexOf(cb);
    if (i >= 0) subs.splice(i, 1);
  };
}

export function clearLog(): void {
  lines.length = 0;
  logInfo('— log cleared —');
}

/**
 * 安装全局捕获(幂等): console.warn/error + 未捕获异常/未处理拒绝。
 * 这样 SDK 内部的报错(例如 slug 填错、登录弹窗被拦)会自动出现在面板里。
 */
export function installLogCapture(): void {
  if (captureInstalled || typeof window === 'undefined') return;
  captureInstalled = true;
  try {
    const origWarn = console.warn.bind(console);
    const origErr = console.error.bind(console);
    console.warn = (...a: unknown[]) => { logWarn(fmt(a)); origWarn(...a); };
    console.error = (...a: unknown[]) => { logError(fmt(a)); origErr(...a); };
    window.addEventListener('error', (e) => logError(`uncaught: ${String(e.message ?? e).slice(0, 200)}`));
    window.addEventListener('unhandledrejection', (e) => logError(`rejection: ${String((e as PromiseRejectionEvent).reason ?? e).slice(0, 200)}`));
  } catch { /* 捕获失败不影响游戏 */ }
}

function fmt(args: unknown[]): string {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ').slice(0, 400);
}

/** 节流器:高频事件(每帧统计)用它在固定间隔里只记一次。 */
export function makeThrottle(intervalMs: number): (key: string, fn: () => void) => void {
  const last = new Map<string, number>();
  return (key, fn) => {
    const now = Date.now();
    if (now - (last.get(key) ?? 0) < intervalMs) return;
    last.set(key, now);
    fn();
  };
}
