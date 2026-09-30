#!/usr/bin/env node
// scripts/hud-airflow-probe.mjs
//
// === 临时镜头缩放读数 + 气流扰动强度 取证 ===============================
// 验证 (per user request):
//   ① 控制台 __zoomHud() 一键开关, 打开后 HUD 在**过载值下面**出现 4 位小数读数;
//   ② __zoom(1.25) 精确设定倍率;
//   ③ __airflow() 实时读数(mul / envK / attitudeK / cloudK / stormK / k / 滚转角度),
//      __airflow(2) 实时改幅度;
//   ④ 平飞(无云无风暴)幅度小、大姿态幅度涨、**穿云时放大**(把机体瞬移到云瓣位置上)。
import { spawn, execSync } from 'node:child_process';
import { existsSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9339;
const argv = process.argv.slice(2);
const url = argv[0] || 'file:///E:/ipbeifen2-dsh/dist-single/index.html#autotest&desktop';
const SHOT = (() => { const i = argv.indexOf('--shot'); return i >= 0 ? argv[i + 1] : ''; })();

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
  send(method, params = {}, s, t = 30000) {
    const id = ++this.id; const p = { id, method, params }; if (s) p.sessionId = s;
    this.ws.send(JSON.stringify(p));
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时: ' + method)); } }, t); });
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = findBrowser();
  const dir = mkdtempSync(join(tmpdir(), 'hud-air-'));
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
  await cdp.send('Page.navigate', { url });
  const ev = async (js, t = 90000) => { const r = await cdp.send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true }, undefined, t); if (r.exceptionDetails) throw new Error('页内异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
  let ready = false;
  for (let i = 0; i < 200; i++) { try { if (await ev('!!(window.__engine && window.__engine.missionReady)')) { ready = true; break; } } catch {} await sleep(1500); }
  if (!ready) {
    const diag = await ev('JSON.stringify({engine:!!window.__engine,mk:!!(window.__engine&&window.__engine.missionReady),errs:(window.__jsErrors||[]).slice(0,3),gl:(window.__glErrors||[]).length})');
    console.error('FAILED: 关卡没起来 →', diag);
    proc.kill(); process.exit(1);
  }
  console.log('  missionReady = true');
  await sleep(2500);
  // HUD 状态是 emitHud() 通过 onHudUpdate 推给 React 的 —— 挂钩抓最后一帧。
  await ev(`(() => {
    const e = window.__engine;
    if (!window.__hudHooked) {
      const orig = e.onHudUpdate;
      e.onHudUpdate = (h) => { window.__hud = h; if (orig) orig(h); };
      window.__hudHooked = true;
    }
    return 'hooked';
  })()`);
  await sleep(400);
  const hudOf = async (keys) => JSON.parse(await ev(`(()=>{const h=window.__hud||{};return JSON.stringify(${keys});})()`));
  await ev('window.__engine._controlMode = "keyboard"; "kb"');

  // ---- ① 读数开关 ----
  console.log('=== ① 临时缩放读数开关 ===');
  console.log('  初始 hud.zoomReadout =', await ev('(window.__hud||{}).zoomReadout'));
  console.log('  __zoomHud() ->', await ev('window.__zoomHud()'));
  await sleep(900);
  const st = JSON.parse(await ev('JSON.stringify((()=>{const h=window.__hud||{};return {zoomReadout:h.zoomReadout,zoomRel:+(h.cameraZoom||0).toFixed(4),zoomRaw:+(h.zoomRaw||0).toFixed(4)};})())'));
  console.log('  hud:', JSON.stringify(st));
  console.log('  HUD DOM 有没有读数行:', await ev('document.body.innerText.includes("ZOOM ×") ? "有" : "没有"'));
  console.log('  HUD 里那一行文本:', await ev('(document.body.innerText.match(/ZOOM ×[\\d.]+/)||["-"])[0] + " / " + (document.body.innerText.match(/raw [\\d.]+/)||["-"])[0]'));
  console.log('  localStorage:', await ev('String(localStorage.getItem("skybound.zoomHud"))'));

  // ---- ② 精确设定倍率 ----
  console.log('=== ② __zoom() 精确设定 ===');
  console.log('  __zoom(1.25) ->', JSON.stringify(await ev('window.__zoom(1.25)')));
  await sleep(1200);
  console.log('  稳定后 __zoom() ->', JSON.stringify(await ev('window.__zoom()')));
  console.log('  HUD 文本:', await ev('(document.body.innerText.match(/ZOOM ×[\\d.]+/)||["-"])[0]'));

  // ---- ③ 气流扰动读数(平飞) ----
  console.log('=== ③ __airflow() 平飞读数 ===');
  console.log('  ', JSON.stringify(await ev('window.__airflow()')));
  await sleep(600);
  console.log('  (再采一次, 确认稳定)', JSON.stringify(await ev('window.__airflow()')));

  // ---- ④ 大姿态 ----
  console.log('=== ④ 大姿态(按住 KeyD 滚转 1.6s) ===');
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'KeyD', key: 'd', windowsVirtualKeyCode: 68, nativeVirtualKeyCode: 68 });
  await sleep(1600);
  console.log('  滚转中:', JSON.stringify(await ev('window.__airflow()')));
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyD', key: 'd', windowsVirtualKeyCode: 68, nativeVirtualKeyCode: 68 });
  await sleep(500);

  // ---- ⑤ 穿云 ----
  console.log('=== ⑤ 穿云(把机体瞬移到最近的云瓣位置) ===');
  const tp = await ev(`(()=>{
    const e = window.__engine;
    const b = e.cloudField.userData.cloudOverdrawBuckets || [];
    if (!b.length) return 'no-buckets';
    const it = b[0].userData.cloudOverdrawItems;
    if (!it || !it.length) return 'no-items';
    // 取离机体最近的那个云瓣, 把机体放到它的世界位置上(与 updateCloudOverdrawCap 同一公式: center+offset, 漂移忽略)
    const p = e.player.position;
    let best = null, bd = 1e9;
    for (const c of it) {
      const wx = c.center.x + c.offset.x, wy = c.center.y + c.offset.y, wz = c.center.z + c.offset.z;
      const d = Math.hypot(wx - p.x, wy - p.y, wz - p.z);
      if (d < bd) { bd = d; best = { wx, wy, wz, r: Math.max(c.sx, c.sy) * 0.5 }; }
    }
    window.__tp = best;
    return JSON.stringify({ nearestDist: Math.round(bd), r: Math.round(best.r) });
  })()`);
  console.log('  最近云瓣:', tp);
  // 连续把机体钉在云瓣位置上 0.8s(引擎每帧会解算位置, 所以反复写)
  await ev(`window.__pin = setInterval(() => {
    const e = window.__engine, t = window.__tp;
    if (e && t) { e.player.position.set(t.wx, t.wy, t.wz); }
  }, 16); "pinning"`);
  await sleep(900);
  console.log('  云里:', JSON.stringify(await ev('window.__airflow()')));
  console.log('  cloudField.userData.cloudInsideK =', await ev('+(window.__engine.cloudField.userData.cloudInsideK||0).toFixed(3)'));
  await ev('clearInterval(window.__pin); "unpin"');

  // ---- ⑥ 实时调幅 ----
  console.log('=== ⑥ __airflow(2) 实时调幅 ===');
  const before = await ev('window.__airflow()');
  await ev('window.__airflow(2); "set"');
  await sleep(1400);
  const after = await ev('window.__airflow()');
  console.log('  改前 k =', before.k, '(mul', before.mul + ')  →  改后 k =', after.k, '(mul', after.mul + ')',
    '| 比值 =', (after.k / Math.max(0.0001, before.k)).toFixed(2));
  await ev('window.__airflow(1); "reset"');

  if (SHOT) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, undefined, 60000);
    writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log('  截图:', SHOT);
  }
  proc.kill(); process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
