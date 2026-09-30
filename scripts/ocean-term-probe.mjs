#!/usr/bin/env node
// scripts/ocean-term-probe.mjs
//
// === 海面各中间量的**精确数值**取证 ======================================
// 用 debug 通道把中间量当颜色渲染, 再用 renderer.readRenderTargetPixels 把指定
// 屏幕位置的真实像素值读出来 —— 于是"n·h 到底是多少 / 法线有多陡"是数字, 不是观感。
//
// 用法: node scripts/ocean-term-probe.mjs <url> [--alt 700] [--rows 12]
import { spawn, execSync } from 'node:child_process';
import { existsSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9347;
const argv = process.argv.slice(2);
const url = argv[0] || 'file:///E:/ipbeifen2-dsh/dist-single/index.html#autotest&mission=m01&desktop';
const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const ALT = Number(flag('--alt', 700));
const ROWS = Number(flag('--rows', 10));
const SHOT = flag('--shot', '');

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

const PIN = (alt) => `
(function () {
  var e = window.__engine; if (!e) return 'no-engine';
  // ⚠️ #autotest 默认是**鼠标操控模式**: 相机跟的是"鼠标瞄准方向", 不是机头。
  // 于是"钉住机头朝太阳"根本不能让相机看向太阳 —— 取景/取证全错(我踩过)。
  // 这里强制键盘模式 → setMouseAimDir(null) → 相机跟随机头朝向。
  e._controlMode = 'keyboard';
  if (window.__pinRaf) cancelAnimationFrame(window.__pinRaf);
  if (e.cloudField) e.cloudField.visible = false;
  var sunAz = Math.atan2(e.cfg.sunPos.x, e.cfg.sunPos.z);
  function loop() {
    var en = window.__engine;
    if (en) {
      en.player.position.y = ${alt};
      en.player.rotation.set(0, sunAz, 0, 'YXZ');
      if (en.updatePlayerAxes) en.updatePlayerAxes();
      en.playerSpeed = 520;
      if (en.playerVelocity) en.playerVelocity.set(0, 0, 0);
    }
    window.__pinRaf = requestAnimationFrame(loop);
  }
  loop();
  return 'pinned';
})()`;

// === 像素读取: 挂在 render 之后, 把 WebGL canvas drawImage 到 2D canvas 上 getImageData ===
// 直接 readRenderTargetPixels 读不出来 —— composer 的 RT 是 half-float, 用 Uint8Array 读
// 会静默返回全 0(踩过)。drawImage 在**同一帧渲染后**做是可靠的。
const INSTALL_READER = (rows) => `
(function () {
  var e = window.__engine; if (!e) return 'no-engine';
  if (window.__pxHooked) { window.__pxRows = ${rows}; return 'already'; }
  var c2 = document.createElement('canvas');
  var ctx = c2.getContext('2d');
  window.__pxRows = ${rows};
  var target = (e.composer && e.composer.render) ? e.composer : e.renderer;
  var orig = target.render.bind(target);
  target.render = function () {
    var r = orig.apply(null, arguments);
    try {
      var src = e.renderer.domElement;
      if (c2.width !== src.width || c2.height !== src.height) { c2.width = src.width; c2.height = src.height; }
      ctx.drawImage(src, 0, 0);
      var W = c2.width, H = c2.height, N = window.__pxRows;
      var out = [];
      for (var i = 0; i < N; i++) {
        var py = Math.round(H * (0.42 + 0.56 * (i / (N - 1))));
        var d = ctx.getImageData(Math.round(W / 2), Math.min(H - 1, Math.max(0, py)), 1, 1).data;
        out.push({ py: py, r: d[0] / 255, g: d[1] / 255, b: d[2] / 255 });
      }
      window.__px = out;
    } catch (err) { window.__pxErr = String(err && err.message); }
    return r;
  };
  window.__pxHooked = true;
  return 'hooked';
})()`;

const READ_PX = `JSON.stringify({ rows: window.__px || null, err: window.__pxErr || null })`;
const SET_DBG = (mode) => `window.__engine.oceanMat.uniforms.uDebugMode.value = ${mode}; 'set'`;

async function main() {
  const browser = findBrowser();
  const dir = mkdtempSync(join(tmpdir(), 'ocean-term-'));
  const proc = spawn(browser, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--use-gl=angle', '--use-angle=d3d11', '--window-size=1600,950', '--remote-debugging-port=' + PORT, '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  const killProc = () => {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    if (process.platform === 'win32') { try { execSync('taskkill /PID ' + proc.pid + '/T /F', { stdio: 'ignore' }); } catch { /* ignore */ } }
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
  if (!ready) { console.error('FAILED: 关卡没起来'); killProc(); process.exit(1); }
  await sleep(2500);
  console.log('pin:', await ev(PIN(ALT)));
  await sleep(2500);
  console.log('align:', await ev(`JSON.stringify((() => {
    const e = window.__engine, c = e.camera.camera;
    const f = new (e.player.position.constructor)(0, 0, -1).applyQuaternion(c.quaternion);
    const s = e.cfg.sunPos.clone().normalize();
    const hf = Math.hypot(f.x, f.z), hs = Math.hypot(s.x, s.z);
    return {
      camFwd: [+f.x.toFixed(2), +f.y.toFixed(2), +f.z.toFixed(2)],
      camDownDeg: +(Math.asin(-f.y) * 180 / Math.PI).toFixed(1),
      sunElevDeg: +(Math.asin(s.y) * 180 / Math.PI).toFixed(1),
      azimDot: +((f.x * s.x + f.z * s.z) / Math.max(1e-6, hf * hs)).toFixed(3),
    };
  })())`));
  console.log('uniform:', await ev(`JSON.stringify((() => {
    const u = window.__engine.oceanMat.uniforms;
    return {
      sunDir: [+u.sunDir.value.x.toFixed(3), +u.sunDir.value.y.toFixed(3), +u.sunDir.value.z.toFixed(3)],
      hasDebug: !!u.uDebugMode,
      camY: Math.round(window.__engine.camera.camera.position.y),
      camPos: [+window.__engine.camera.camera.position.x.toFixed(1), +window.__engine.camera.camera.position.z.toFixed(1)],
    };
  })())`));

  console.log('reader:', await ev(INSTALL_READER(ROWS)));
  await sleep(500);
  // 各通道: 1=n·h, 2=宽瓣, 3=pathK, 4=schlick, 6=法线, 7=半向量
  for (const [mode, name] of [[1, 'n·h(灰阶)'], [2, 'glintWide(灰阶)'], [3, 'pathK(灰阶)'], [4, 'schlick(灰阶)'], [6, '法线(RGB=n*0.5+0.5)'], [7, '半向量 h(RGB)']]) {
    await ev(SET_DBG(mode));
    await sleep(400);
    const out = JSON.parse(await ev(READ_PX));
    console.log(`
=== 通道 ${mode}: ${name} (画面正中竖线, 地平线→画面底部) ${out.err ? 'ERR ' + out.err : ''} ===`);
    if (out.rows) for (const r of out.rows) {
      console.log(`  y=${String(r.py).padStart(4)}  ${r.r.toFixed(3)}, ${r.g.toFixed(3)}, ${r.b.toFixed(3)}`);
    }
  }
  await ev('window.__engine.oceanMat.uniforms.uDebugMode.value = 0; if (window.__pinRaf) cancelAnimationFrame(window.__pinRaf); "reset"');
  if (SHOT) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, undefined, 60000);
    writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log('  截图:', SHOT);
  }
  killProc();
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
