#!/usr/bin/env node
// scripts/vista-shot.mjs
//
// === 取景截图 (per user request: 按参考图调海面/天空/云) ==================
// 把机体钉在指定高度、机头对准指定方位(默认对准**太阳方位**)、机翼拉平, 然后截图。
// 这样每次改完着色器都能拿到同一构图的"明信片", 用来和参考图比。
//
// 用法:
//   node scripts/vista-shot.mjs <url> --out .shots/x.png [--alt 1200] [--yaw auto|180]
//        [--pitch 0] [--speed 500] [--bomb] [--zoom 1]
import { spawn, execSync } from 'node:child_process';
import { existsSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9345;
const argv = process.argv.slice(2);
const url = argv[0];
if (!url) { console.log('用法: node scripts/vista-shot.mjs <url> --out x.png'); process.exit(1); }
const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const OUT = flag('--out', '.shots/vista.png');
const ALT = Number(flag('--alt', 1200));
const YAW = flag('--yaw', 'auto');
const PITCH = Number(flag('--pitch', 0));
const SPEED = Number(flag('--speed', 520));
const BOMB = argv.includes('--bomb');
const ZOOM = Number(flag('--zoom', 1));
const NOCLOUDS = argv.includes('--noclouds');   // 隐藏云场: 单独看天空+海面(排查用)
const OCEAN_DBG = Number(flag('--oceanDbg', 0));   // 海面调试通道(见 engine.__oceanDbg)

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

// 钉姿态: 每帧覆盖位置/朝向/速度。yaw='auto' → 机头对准太阳方位。
const PIN = (alt, yaw, pitch, speed, bomb, zoom) => `
(function () {
  var e = window.__engine; if (!e) return 'no-engine';
  // ⚠️ #autotest 默认是**鼠标操控模式**: 相机跟的是"鼠标瞄准方向", 不是机头。
  // 于是"钉住机头朝太阳"根本不能让相机看向太阳 —— 取景/取证全错(我踩过)。
  // 这里强制键盘模式 → setMouseAimDir(null) → 相机跟随机头朝向。
  e._controlMode = 'keyboard';
  if (window.__pinRaf) cancelAnimationFrame(window.__pinRaf);
  if (${bomb ? 'true' : 'false'}) { e.currentWeapon = 'BDL'; e.weapons_state.BDL = 30; }
  if (${NOCLOUDS ? 'true' : 'false'}) {
    // 云是 depthWrite=false 的大面积贴片, 会盖住天空/海面 —— 排查光照时先关掉。
    if (e.cloudField) e.cloudField.visible = false;
    else e.scene.traverse(function (o) { if (o.isInstancedMesh && o.userData && o.userData.cloudMat) o.visible = false; });
    if (e.rainSystem && e.rainSystem.group) e.rainSystem.group.visible = false;
  }
  if (${zoom} !== 1) { try { e.setZoomRel(${zoom}); } catch (err) {} }
  if (${OCEAN_DBG} > 0) { try { window.__oceanDbg(${OCEAN_DBG}); } catch (err) {} }
  // 机头 +Z: forward = (sin(yaw), 0, cos(yaw)) ⇒ 要让它等于太阳的水平方向(sunPos.xz 归一化)
  // ⇒ yaw = atan2(sunPos.x, sunPos.z)。(写成 atan2(-x,-z) 会让机头**背对**太阳 —— 我踩过。)
  var sunAz = Math.atan2(e.cfg.sunPos.x, e.cfg.sunPos.z);
  var yawRad = ${yaw === 'auto' ? 'sunAz' : `(${Number(yaw)} * Math.PI / 180)`};
  function loop() {
    var en = window.__engine;
    if (en) {
      var p = en.player.position;
      p.y = ${alt};
      en.player.rotation.set(${pitch} * Math.PI / 180, yawRad, 0, 'YXZ');
      en.updatePlayerAxes ? en.updatePlayerAxes() : null;
      en.playerSpeed = ${speed};
      if (en.playerVelocity) en.playerVelocity.set(0, 0, 0);
    }
    window.__pinRaf = requestAnimationFrame(loop);
  }
  loop();
  return 'pinned alt=' + ${alt} + ' yaw=${yaw === 'auto' ? 'sunAz' : Number(yaw)}';
})()`;

async function main() {
  const browser = findBrowser();
  const dir = mkdtempSync(join(tmpdir(), 'vista-'));
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
  console.log('  align:', await ev(`JSON.stringify((() => {
    const e = window.__engine, c = e.camera.camera;
    const f = new (e.player.position.constructor)(0, 0, -1).applyQuaternion(c.quaternion);
    const s = e.cfg.sunPos.clone().normalize();
    const hf = Math.hypot(f.x, f.z), hs = Math.hypot(s.x, s.z);
    const azim = (f.x * s.x + f.z * s.z) / Math.max(1e-6, hf * hs);
    return {
      camFwd: [+f.x.toFixed(2), +f.y.toFixed(2), +f.z.toFixed(2)],
      camDownDeg: +(Math.asin(-f.y) * 180 / Math.PI).toFixed(1),
      sunElevDeg: +(Math.asin(s.y) * 180 / Math.PI).toFixed(1),
      azimDot: +azim.toFixed(3),
      // 期望: 光路所在像素的视线俯角 ≈ 太阳高度角(azimDot≈1 时)
      expectDepressionDeg: +(Math.asin(s.y) * 180 / Math.PI).toFixed(1),
    };
  })())`));
  console.log('  pin:', await ev(PIN(ALT, YAW, PITCH, SPEED, BOMB, ZOOM)));
  await sleep(2500);   // 让相机/水面/云稳定到新姿态
  const info = await ev(`JSON.stringify({
    alt: Math.round(window.__engine.player.position.y),
    speed: Math.round(window.__engine.playerSpeed),
    weather: window.__engine.hudWeatherLoad ? 0 : 0,
    sun: [+window.__engine.cfg.sunPos.x.toFixed(0), +window.__engine.cfg.sunPos.y.toFixed(0), +window.__engine.cfg.sunPos.z.toFixed(0)],
    hdr: !!(window.__engine._hdrEnvTex),
  })`);
  console.log('  state:', info);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, undefined, 60000);
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('  截图:', OUT);
  await ev('if (window.__pinRaf) cancelAnimationFrame(window.__pinRaf); "unpin"');
  killProc();
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
