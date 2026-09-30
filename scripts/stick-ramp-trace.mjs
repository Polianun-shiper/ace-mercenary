#!/usr/bin/env node
// scripts/stick-ramp-trace.mjs
// 抓 engine.rampAxis 的真实调用: dt / rampIn / rampOut / 调用频率(每帧几次)。
import { spawn, execSync } from 'node:child_process';
import { existsSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const url = argv[0];
const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const OUT = flag('--out', '');
const PORT = 9334;

function findBrowser() {
  if (process.env.BROWSER_PATH && existsSync(process.env.BROWSER_PATH)) return process.env.BROWSER_PATH;
  for (const root of ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application', 'C:\\Program Files\\Microsoft\\Edge\\Application', 'C:\\Program Files\\Google\\Chrome\\Application']) {
    if (!existsSync(root)) continue;
    for (const v of readdirSync(root).filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d)).sort().reverse()) {
      for (const exe of ['msedge.exe', 'chrome.exe']) { const p = join(root, v, exe); if (existsSync(p)) return p; }
    }
  }
  throw new Error('找不到浏览器');
}
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      if (m.id !== undefined && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) reject(new Error(m.error.message)); else resolve(m.result); }
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = ++this.id; const payload = { id, method, params }; if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时: ' + method)); } }, timeoutMs); });
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INSTALL = `
(function () {
  var eng = window.__engine; if (!eng) return 'no-engine';
  var proto = Object.getPrototypeOf(eng);
  var found = null, depth = 0;
  while (proto && depth < 8) { if (typeof proto.rampAxis === 'function') { found = proto; break; } proto = Object.getPrototypeOf(proto); depth++; }
  if (!found) return 'no-rampAxis';
  var T = { t0: performance.now(), calls: [], frames: 0 };
  window.__trace = T;
  var orig = found.rampAxis;
  found.rampAxis = function (cur, target, dt, rampIn, rampOut) {
    var r = orig.apply(this, arguments);
    if (T.calls.length < 4000) T.calls.push([+(performance.now() - T.t0).toFixed(1), +(cur).toFixed(3), +(target).toFixed(3), +(dt).toFixed(5), +rampIn.toFixed(3), +rampOut.toFixed(3), +r.toFixed(3)]);
    return r;
  };
  window.__patched = true;
  // 同时记录每帧的 dt(引擎自己的帧时)
  var fl = 0;
  function loop() {
    fl++;
    window.__frames = fl;
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  return 'patched:' + depth;
})()`;

async function main() {
  const browser = findBrowser();
  const userDir = mkdtempSync(join(tmpdir(), 'stick-trace-'));
  const proc = spawn(browser, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--use-gl=angle', '--use-angle=d3d11', '--window-size=1600,950', '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDir, 'about:blank'], { stdio: 'ignore' });
  // 退出兜底: 无头浏览器(及其渲染/GPU 子进程)必须被杀干净, 否则会一直吃 CPU。
  // taskkill /T 杀整棵树 —— proc.kill() 只结束主进程, 子进程在 Windows 上可能残留。
  const killProc = () => {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    if (process.platform === 'win32') {
      try { execSync('taskkill /PID ' + proc.pid + ' /T /F', { stdio: 'ignore' }); } catch { /* ignore */ }
    }
  };
  process.on('exit', killProc);
  process.on('SIGINT', () => { killProc(); process.exit(130); });
  process.on('SIGTERM', () => { killProc(); process.exit(143); });
  process.on('uncaughtException', (e) => { console.error('uncaught:', e && e.message); killProc(); process.exit(1); });

  let ver = null;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); ver = await r.json(); break; } catch { await sleep(500); } }
  if (!ver) throw new Error('devtools 起不来');
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page') || list[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url });
  const ev = async (js, t = 60000) => { const r = await cdp.send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true }, undefined, t); if (r.exceptionDetails) throw new Error('页内异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
  const waitFor = async (js, timeoutMs = 240000) => { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { try { if (await ev(js)) return true; } catch {} await sleep(1500); } return false; };
  console.log('等 missionReady …', await waitFor('!!(window.__engine && window.__engine.missionReady)'));
  await sleep(3000);
  console.log('patch:', await ev(INSTALL));
  console.log('inertiaScale(localStorage):', await ev('String(window.localStorage.getItem("skybound.inertiaScale"))'));
  console.log('mass/类别:', await ev('JSON.stringify({mass:window.__engine.playerMass,cat:window.__engine.playerCategory,model:window.__engine.playerModel})'));
  await ev('window.__trace.calls.length = 0; window.__trace.t0 = performance.now(); "reset"');
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'KeyS', key: 's', windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83 });
  await sleep(1200);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyS', key: 's', windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83 });
  const calls = JSON.parse(await ev('JSON.stringify(window.__trace.calls.slice(0, 60))'));
  const nAll = await ev('window.__trace.calls.length');
  const frames = await ev('window.__frames');
  console.log('\n1.2s 内 rampAxis 调用总数:', nAll, '| rAF 帧数:', frames, '| 每帧调用:', (nAll / Math.max(1, frames)).toFixed(2));
  console.log('\n时间(ms)  cur    target  dt       rampIn  rampOut  ->ret');
  for (const c of calls) console.log(c.map((v) => String(v).padStart(8)).join(' '));
  if (OUT) writeFileSync(OUT, JSON.stringify(calls, null, 1));
  proc.kill(); process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
