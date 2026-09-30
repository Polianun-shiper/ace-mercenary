#!/usr/bin/env node
// scripts/console-cmd-probe.mjs
//
// === 关卡内调试控制台命令取证 (per user request) =========================
// 用户在关卡里按 ` 打开的是自己写的控制台(DebugConsole → engine.setDebugView),
// 不是浏览器 devtools ⇒ 命令必须走 setDebugView。这里直接调它, 验证:
//   zoomhud / zoom <rel> / airflow [mul] 三条命令的返回与副作用(HUD 出现读数、
//   倍率真的改了、气流幅度真的改了), 以及投弹音效换成了短促清脆的那条。
import { spawn, execSync } from 'node:child_process';
import { existsSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9341;
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
  const dir = mkdtempSync(join(tmpdir(), 'console-cmd-'));
  const proc = spawn(browser, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--use-gl=angle', '--use-angle=d3d11', '--window-size=1600,950', '--remote-debugging-port=' + PORT, '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
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
  const ev = async (js, t = 90000) => { const r = await cdp.send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true }, undefined, t); if (r.exceptionDetails) throw new Error('页内异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
  let ready = false;
  for (let i = 0; i < 200; i++) { try { if (await ev('!!(window.__engine && window.__engine.missionReady)')) { ready = true; break; } } catch {} await sleep(1500); }
  if (!ready) { console.error('FAILED: 关卡没起来'); killProc(); process.exit(1); }
  console.log('missionReady = true');
  await sleep(2500);
  await ev('window.__engine._controlMode = "keyboard"; "kb"');

  console.log('=== 关卡内控制台命令(setDebugView) ===');
  const cmd = async (c) => {
    const r = await ev(`window.__engine.setDebugView(${JSON.stringify(c)})`);
    console.log(`  > ${c.padEnd(14)} → ${r}`);
    return r;
  };
  await cmd('zoomhud');
  await sleep(700);
  console.log('    HUD 里出现读数行:', await ev('document.body.innerText.includes("ZOOM ×") ? "有" : "没有"'),
    '|', await ev('(document.body.innerText.match(/ZOOM ×[\\d.]+/)||["-"])[0]'));
  console.log('    localStorage.skybound.zoomHud =', await ev('String(localStorage.getItem("skybound.zoomHud"))'));
  await cmd('zoom 1.4');
  await sleep(1000);
  console.log('    改后读数:', await ev('(document.body.innerText.match(/ZOOM ×[\\d.]+/)||["-"])[0]'),
    '| raw', await ev('(document.body.innerText.match(/raw [\\d.]+/)||["-"])[0]'));
  await cmd('airflow');
  await cmd('airflow 0.5');
  await sleep(1000);
  console.log('    0.5 倍后读数:', await ev('JSON.stringify(window.__airflow())'));
  await cmd('airflow 1');
  await sleep(800);
  await cmd('zoomhud 0');
  await sleep(500);
  // 注意: 右上角还有一个常驻的 2 位小数读数(ZOOM ×1.40), 所以这里要按**4 位小数**判定。
  console.log('    关掉后 HUD 还有读数行吗:', await ev('/ZOOM ×\\d+\\.\\d{4}/.test(document.body.innerText) ? "有(不对)" : "没有(对)"'));
  // 顺手确认未知命令仍然报未知(别把别的命令吃掉)
  await cmd('lit');
  await cmd('zoomhud on');

  console.log('=== 投弹音效 ===');
  // 取证方式: ① 挂钩 `HTMLAudioElement.prototype.play` 记录 music player 播了哪个文件
  //           (`playSfx('missile_launch')` 走 Audio 元素);
  //           ② 挂钩 AudioManager.playerMissileLaunch(Web Audio 采样, 不是元素)。
  console.log('  挂钩:', await ev(`(() => {
    const e = window.__engine;
    window.__sfx = { files: [], player: 0 };
    if (!window.__playHooked) {
      const origPlay = HTMLAudioElement.prototype.play;
      HTMLAudioElement.prototype.play = function () {
        try { window.__sfx.files.push(String(this.src).split('/').pop()); } catch (err) {}
        return origPlay.apply(this, arguments);
      };
      const a = e.audio;
      const op = a.playerMissileLaunch.bind(a);
      a.playerMissileLaunch = () => { window.__sfx.player++; return op(); };
      window.__playHooked = true;
    }
    return 'hooked';
  })()`));
  const drop = await ev(`(() => {
    const e = window.__engine;
    e.currentWeapon = 'BDL';
    e.weapons_state.BDL = 20;
    window.__sfx.files.length = 0; window.__sfx.player = 0;
    try { e.dropBomb(); } catch (err) { return 'err: ' + (err && err.message); }
    return JSON.stringify({ files: window.__sfx.files, playerCalls: window.__sfx.player });
  })()`);
  console.log('  投一枚 BDL 后:', drop);
  const longPlayed = String(drop).includes('sfx_missile_launch');
  console.log('  → 是否还在播那条 2.2s 长录音:', longPlayed ? '是(不对)' : '否(对)',
    '| playerMissileLaunch 调用:', String(drop).includes('"playerCalls":1') ? '1 次(对)' : '不是 1 次');

  if (SHOT) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, undefined, 60000);
    writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log('  截图:', SHOT);
  }
  killProc();
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
