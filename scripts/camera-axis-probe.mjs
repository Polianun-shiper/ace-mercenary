#!/usr/bin/env node
// scripts/camera-axis-probe.mjs
//
// === 相机"多轴融合"受控单元测试 (per user request: 相机响应/回正要多轴融合) ===
// 自动进关后把引擎暂停, 然后**手工**按固定角速度转动合成姿态并直接调 camera.update(),
// 过载固定为 1G(纯滚转/纯偏航的物理特征: 不产生过载), 看 rig 的机动量判据:
//   · 旧判据 |gForce−1|/2.5 → 纯滚转下恒为 0(相机只会用回正的慢速率 = "单轴响应");
//   · 新判据 max(旧, 姿态角速率) → 纯滚转也能进入快跟随。
import { spawn, execSync } from 'node:child_process';
import { existsSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9337;
function findBrowser() {
  if (process.env.BROWSER_PATH && existsSync(process.env.BROWSER_PATH)) return process.env.BROWSER_PATH;
  for (const root of ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application', 'C:\\Program Files\\Microsoft\\Edge\\Application', 'C:\\Program Files\\Google\\Chrome\\Application']) {
    if (!existsSync(root)) continue;
    for (const v of readdirSync(root).filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d)).sort().reverse()) {
      for (const exe of ['msedge.exe', 'chrome.exe']) { const p = join(root, v, exe); if (existsSync(p)) return p; }
    }
  }
  throw new Error('找不到浏览器(设置 BROWSER_PATH)');
}
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      if (m.id !== undefined && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) reject(new Error(m.error.message)); else resolve(m.result); }
    });
  }
  send(method, params = {}, s, t = 30000) {
    const id = ++this.id; const p = { id, method, params }; if (s) p.sessionId = s;
    this.ws.send(JSON.stringify(p));
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时: ' + method)); } }, t); });
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 受控姿态喂给 rig: axis = 'roll' | 'yaw' | 'pitch', rate = rad/s
const DRIVE = (axis, rate) => `
(function () {
  var eng = window.__engine;
  if (!eng) return 'no-engine';
  eng.debugPaused = true;             // 暂停引擎主循环对相机的更新
  var rig = eng.camera;
  var THREE = eng.player.position.constructor;   // Vector3
  var pos = eng.player.position.clone();
  var U = eng.player.up ? eng.player.up.clone() : null;
  // 用引擎自己的 playerForward/Right/Up 做初始姿态(它们每帧由 updatePlayerAxes 维护)
  var fwd = eng.playerForward.clone(), up = eng.playerUp.clone(), right = eng.playerRight.clone();
  var dt = 1 / 60;
  var out = { axis: '${axis}', rate: ${rate}, frames: 0, mvrFwdMax: 0, mvrUpMax: 0, oldMax: 0, fusedMax: 0, lerpPosTrace: [] };
  // 轴: roll = 绕 fwd 转; yaw = 绕 up 转; pitch = 绕 right 转
  var ax = '${axis}' === 'roll' ? fwd : ('${axis}' === 'yaw' ? up : right);
  var ang = ${rate} * dt;
  for (var i = 0; i < 150; i++) {
    // 旋转合成姿态(与机型朝向无关, 只关心姿态角速率)
    fwd.applyAxisAngle(ax, ang).normalize();
    up.applyAxisAngle(ax, ang).normalize();
    right.crossVectors(up, fwd).normalize();
    ax = '${axis}' === 'roll' ? fwd : ('${axis}' === 'yaw' ? up : right);
    rig.update(dt, pos, fwd, up, right, 500, 1200, 1);   // 过载恒 1G
    var f7 = Math.abs(rig._mvrRateFwd), f8 = Math.abs(rig._mvrRateUp);
    var oldV = Math.min(1, 0 / 2.5);                      // |gForce-1| = 0
    var newV = Math.min(1, Math.max(oldV, (f7 + f8 * 0.5) / 0.9));
    if (i > 3) {
      if (f7 > out.mvrFwdMax) out.mvrFwdMax = f7;
      if (f8 > out.mvrUpMax) out.mvrUpMax = f8;
      if (oldV > out.oldMax) out.oldMax = oldV;
      if (newV > out.fusedMax) out.fusedMax = newV;
    }
    out.frames++;
  }
  eng.debugPaused = false;
  return JSON.stringify(out);
})()`;

async function main() {
  const browser = findBrowser();
  const dir = mkdtempSync(join(tmpdir(), 'cam-axis-'));
  const proc = spawn(browser, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--use-gl=angle', '--use-angle=d3d11', '--window-size=1600,950', '--remote-debugging-port=' + PORT, '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
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
  const url = process.argv[2] || 'file:///E:/ipbeifen2-dsh/dist-single/index.html#autotest&desktop';
  await cdp.send('Page.navigate', { url });
  const ev = async (js, t = 90000) => { const r = await cdp.send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true }, undefined, t); if (r.exceptionDetails) throw new Error('页内异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
  for (let i = 0; i < 160; i++) { try { if (await ev('!!(window.__engine && window.__engine.missionReady)')) break; } catch {} await sleep(1500); }
  await sleep(2500);
  console.log('控制模式 ->', await ev('window.__engine._controlMode = "keyboard"; window.__engine._controlMode'));
  await sleep(800);
  console.log('相机模式 ->', await ev('window.__engine.camera.getMode()'));
  for (const [axis, rate] of [['roll', 2.0], ['yaw', 0.6], ['pitch', 1.2]]) {
    const r = JSON.parse(await ev(DRIVE(axis, rate)));
    console.log(`  [${axis} ${rate} rad/s, 1G] 帧数 ${r.frames} | 角速率 fwd ${r.mvrFwdMax.toFixed(3)} / up ${r.mvrUpMax.toFixed(3)} rad/s | 旧判据 ${r.oldMax.toFixed(3)} → 新判据 ${r.fusedMax.toFixed(3)}`);
  }
  await ev('window.__engine.debugPaused = false; "resume"');
  proc.kill(); process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
