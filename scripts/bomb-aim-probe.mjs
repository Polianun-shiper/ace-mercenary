#!/usr/bin/env node
// scripts/bomb-aim-probe.mjs
//
// === 投弹落点指示器取证 (per user request) =============================
// 用户: "投弹指示器怎么不按飞机的速度和落点距离结合计算"。这里直接量:
//   ① 不同空速下, 指示器给出的预测落点离机体的**水平距离**(= 提前量)有没有随速度变;
//   ② 真投一枚, 记录实际起爆的 XZ, 与投弹瞬间的预测比对(预测准不准);
//   ③ 指示器的屏幕位置(x,y)在不同速度下是否跟着动。
import { spawn, execSync } from 'node:child_process';
import { existsSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9343;
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
  const dir = mkdtempSync(join(tmpdir(), 'bomb-aim-'));
  const proc = spawn(browser, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--use-gl=angle', '--use-angle=d3d11', '--window-size=1600,950', '--remote-debugging-port=' + PORT, '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  const killProc = () => {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    if (process.platform === 'win32') {
      try { execSync('taskkill /PID ' + proc.pid + '/T /F', { stdio: 'ignore' }); } catch { /* ignore */ }
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

  // 采样器: 记录每个炸弹的位置(爆炸后从数组移除 ⇒ 留最后一帧位置 = 实际落点)
  await ev(`(() => {
    const e = window.__engine;
    window.__bs = { last: null, log: [] };
    if (!window.__bsHooked) {
      const w = e.weapons;
      const origDrop = w.dropBomb.bind(w);
      w.dropBomb = function (pos, vel) {
        window.__bs.last = { dropPos: { x: pos.x, y: pos.y, z: pos.z }, vel: { x: vel.x, y: vel.y, z: vel.z }, track: [] };
        return origDrop(pos, vel);
      };
      const origUpd = w.updateBombs ? w.updateBombs.bind(w) : null;
      window.__bsHooked = true;
    }
    return 'hook-ready';
  })()`);

  // 逐帧记录炸弹位置
  await ev(`(() => {
    if (window.__bsRaf) return 'already';
    const loop = () => {
      const e = window.__engine;
      const w = e && e.weapons;
      if (w && w.bombs && window.__bs && window.__bs.last) {
        for (const b of w.bombs) window.__bs.last.track.push({ x: +b.mesh.position.x.toFixed(2), y: +b.mesh.position.y.toFixed(2), z: +b.mesh.position.z.toFixed(2) });
      }
      window.__bsRaf = requestAnimationFrame(loop);
    };
    window.__bsRaf = requestAnimationFrame(loop);
    return 'tracking';
  })()`);

  const measure = async (speed) => {
    // 设定空速并把机头压平(避免落点算到山上/太快撞地), 再用指示器读数
    const r = await ev(`(() => {
      const e = window.__engine;
      e.currentWeapon = 'BDL';
      e.weapons_state.BDL = 30;
      e.playerSpeed = ${speed};
      e.playerHp = 1e9;
      const g = e.playerGravity;
      const p = e.position ? null : null;
      const info = e.computeBombImpactInfo();
      const pred = info ? info.point : null;
      const scr = info ? e.projectBombImpact(info.point) : null;
      const origin = e.player.position;
      const fwd = e.playerForward;
      const horiz = pred ? Math.hypot(pred.x - origin.x, pred.z - origin.z) : null;
      const drop = pred ? (origin.y - pred.y) : null;
      // 与"机头方向 × 该水平距离"比: 落点是否在机头正下方(即是否按机头指向甩出)
      const alongFwd = pred ? ((pred.x - origin.x) * fwd.x + (pred.z - origin.z) * fwd.z) : null;
      const lateral = pred ? ((pred.x - origin.x) * fwd.z - (pred.z - origin.z) * fwd.x) : null;
      return JSON.stringify({
        speed: Math.round(e.playerSpeed),
        alt: Math.round(origin.y),
        pred: pred ? { x: Math.round(pred.x), y: Math.round(pred.y), z: Math.round(pred.z) } : null,
        horizLead: horiz === null ? null : Math.round(horiz),
        dropHeight: drop === null ? null : Math.round(drop),
        alongFwd: alongFwd === null ? null : Math.round(alongFwd),
        lateral: lateral === null ? null : Math.round(lateral),
        screen: scr ? { x: +scr.x.toFixed(3), y: +scr.y.toFixed(3), r: Math.round(scr.radius) } : null,
        infoDist: info ? Math.round(info.distance) : null,
        infoTof: info ? +info.tof.toFixed(2) : null,
      });
    })()`);
    return JSON.parse(r);
  };

  console.log('=== ① 指示器在不同空速下的落点(同一高度/姿态) ===');
  const rows = [];
  for (const sp of [300, 600, 900]) {
    // 稳定 1.2s 让机体姿态/位置收敛, 再读
    await ev(`window.__engine.playerSpeed = ${sp}; "set"`);
    await sleep(1200);
    rows.push(await measure(sp));
  }
  for (const r of rows) {
    console.log(`  空速 ${String(r.speed).padStart(4)} | 高度 ${r.alt} | 预测落点 (${r.pred ? r.pred.x + ',' + r.pred.y + ',' + r.pred.z : 'null'})`
      + ` | 水平提前量 ${r.horizLead}m (沿机头 ${r.alongFwd}m / 侧向 ${r.lateral}m) | 落差 ${r.dropHeight}m`
      + ` | 屏幕 (${r.screen ? r.screen.x + ',' + r.screen.y : '-'}) 半径 ${r.screen ? r.screen.r : '-'}px`
      + ` | 解出的距离/时间 ${r.infoDist}m / ${r.infoTof}s`);
  }
  const leadGrew = rows[0].horizLead !== null && rows[2].horizLead !== null && rows[2].horizLead > rows[0].horizLead * 1.15;
  console.log('  → 提前量是否随速度明显增长:', leadGrew ? 'YES' : 'NO(有问题)');

  console.log('=== ② 预测 vs 实际落点(真投一枚) ===');
  for (const sp of [600]) {
    const r = await ev(`(() => {
      const e = window.__engine;
      e.currentWeapon = 'BDL';
      e.weapons_state.BDL = 30;
      e.playerSpeed = ${sp};
      const info = e.computeBombImpactInfo();
      const pred = info ? info.point : null;
      window.__bs.last = null;
      try { e.dropBomb(); } catch (err) { return 'err:' + (err && err.message); }
      window.__predAtDrop = pred ? { x: pred.x, y: pred.y, z: pred.z } : null;
      return JSON.stringify({ pred: window.__predAtDrop, dropVel: window.__bs.last ? window.__bs.last.vel : null });
    })()`);
    const dropped = JSON.parse(r);
    // 等炸弹落地(最长 12s)
    let landed = null;
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      const st = await ev(`(() => { const e = window.__engine; const bs = e.weapons.bombs.length; return JSON.stringify({ bombs: bs, track: window.__bs.last ? window.__bs.last.track.slice(-1)[0] : null }); })()`);
      const s = JSON.parse(st);
      if (s.bombs === 0 && s.track) { landed = s.track; break; }
      if (s.bombs === 0) break;
    }
    console.log('  投放速度', sp, '| 投弹初速', JSON.stringify(dropped.dropVel));
    console.log('  预测落点:', JSON.stringify(dropped.pred), '| 实际落点:', JSON.stringify(landed));
    if (landed && dropped.pred) {
      const dxz = Math.hypot(landed.x - dropped.pred.x, landed.z - dropped.pred.z);
      const dy = landed.y - dropped.pred.y;
      console.log(`  → 水平误差 ${dxz.toFixed(1)}m | 高度误差 ${dy.toFixed(1)}m`);
    }
  }

  if (SHOT) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, undefined, 60000);
    writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log('  截图:', SHOT);
  }
  killProc();
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
