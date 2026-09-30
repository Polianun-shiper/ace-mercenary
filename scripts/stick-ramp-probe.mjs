#!/usr/bin/env node
// scripts/stick-ramp-probe.mjs
//
// === 杆量渐入取证 (per user request: 键盘杆量是不是"按下去就满杆") ===
// 进一关, 装一个逐帧采样器抓 engine.ctrlPitch / ctrlRoll / ctrlYaw,
// 然后按 KeyS(pitchUp) / KeyD(rollRight) 单独与同时按下, 看杆量从 0 到 100%
// 花多久、多轴是否叠加。
//
// 用法: node scripts/stick-ramp-probe.mjs <url> [--hold 2000] [--out x.json]
import { spawn, execSync } from 'node:child_process';
import { existsSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const url = argv[0];
if (!url) { console.log('用法: node scripts/stick-ramp-probe.mjs <url> [--hold 2000]'); process.exit(1); }
const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const HOLD = Number(flag('--hold', 2500));
const OUT = flag('--out', '');
const PORT = 9333;

function findBrowser() {
  if (process.env.BROWSER_PATH && existsSync(process.env.BROWSER_PATH)) return process.env.BROWSER_PATH;
  const roots = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application',
    'C:\\Program Files\\Microsoft\\Edge\\Application',
    'C:\\Program Files\\Google\\Chrome\\Application',
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const vers = readdirSync(root).filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d)).sort().reverse();
    for (const v of vers) {
      for (const exe of ['msedge.exe', 'chrome.exe']) {
        const p = join(root, v, exe);
        if (existsSync(p)) return p;
      }
    }
  }
  throw new Error('找不到浏览器(设置 BROWSER_PATH)');
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      } else if (msg.method) for (const l of this.listeners) l(msg);
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); } }, timeoutMs);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SETUP = `
(function () {
  var eng = window.__engine;
  if (!eng) return 'no-engine';
  var P = { t0: performance.now(), rows: [] };
  window.__probe = P;
  function loop() {
    var e = window.__engine;
    if (e) P.rows.push([
      Math.round(performance.now() - P.t0),
      +(e.ctrlPitch || 0).toFixed(4),
      +(e.ctrlRoll || 0).toFixed(4),
      +(e.ctrlYaw || 0).toFixed(4),
      Math.round(e.playerSpeed || 0),
      // 相机侧: 拖尾尺度 + 机位偏移 + **机动量(多轴)** 的三个来源
      +(e.camera && e.camera.lagScale !== undefined ? e.camera.lagScale : -1).toFixed(3),
      +(e.camera && e.camera.pos ? e.camera.pos.length() : -1).toFixed(3),
      +(e.camera ? e.camera._mvrRateFwd : -1).toFixed(4),
      +(e.camera ? e.camera._mvrRateUp : -1).toFixed(4),
      +(e.camera ? e.camera.gForce : -1).toFixed(3)
    ]);
    if (P.rows.length < 1200) requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  return 'ok';
})()`;

const KEYDEF = {
  KeyS: { key: 's', vk: 83 },
  KeyW: { key: 'w', vk: 87 },
  KeyA: { key: 'a', vk: 65 },
  KeyD: { key: 'd', vk: 68 },
  KeyQ: { key: 'q', vk: 81 },
  KeyE: { key: 'e', vk: 69 },
};

async function main() {
  const browser = findBrowser();
  const userDir = mkdtempSync(join(tmpdir(), 'stick-probe-'));
  const args = [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--use-gl=angle', '--use-angle=d3d11', '--window-size=1600,950',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDir, 'about:blank',
  ];
  const proc = spawn(browser, args, { stdio: 'ignore' });
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
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); ver = await r.json(); break; } catch { await sleep(500); }
  }
  if (!ver) throw new Error('devtools 起不来');

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page') || list[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  await cdp.send('Page.navigate', { url });
  const ev = async (js, timeoutMs = 60000) => {
    const r = await cdp.send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true }, undefined, timeoutMs);
    if (r.exceptionDetails) throw new Error('页内异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  };
  const waitFor = async (js, timeoutMs = 180000, everyMs = 1500) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await ev(js)) return true; } catch { /* keep waiting */ }
      await sleep(everyMs);
    }
    return false;
  };

  console.log('[1/4] 等 missionReady …');
  const ready = await waitFor('!!(window.__engine && window.__engine.missionReady)', 240000);
  console.log('    missionReady =', ready);
  if (!ready) { proc.kill(); throw new Error('没进关卡'); }
  // 稳定一下(出生高度 settle / 前几帧预热)
  await sleep(3000);
  console.log('    状态:', await ev('JSON.stringify({model:window.__engine.playerModel,cat:window.__engine.playerCategory,speed:Math.round(window.__engine.playerSpeed),mass:window.__engine.playerMass,aoa:+window.__engine.playerAoA.toFixed(3)})'));

  console.log('    装采样器:', await ev(SETUP));
  // === 切到"键盘操作模式" (per user request: 要测的就是键盘模式的相机响应) ===
  // `#autotest` 默认跑鼠标操控模式(相机锁在视野球上, 不走 chase 机位的那套机动融合),
  // 所以这里把引擎的控制模式翻成 keyboard —— 引擎每帧读它, 运行时改就生效。
  console.log('    控制模式 ->', await ev('window.__engine._controlMode = "keyboard"; window.__engine._controlMode'));
  await sleep(1200);

  const keyDown = (code) => cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key: KEYDEF[code].key, windowsVirtualKeyCode: KEYDEF[code].vk, nativeVirtualKeyCode: KEYDEF[code].vk });
  const keyUp = (code) => cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: KEYDEF[code].key, windowsVirtualKeyCode: KEYDEF[code].vk, nativeVirtualKeyCode: KEYDEF[code].vk });

  console.log('[2/4] 单轴: 按住 KeyS(抬头) 2.5s');
  await ev('window.__probe.rows.length = 0');
  await keyDown('KeyS');
  await sleep(HOLD);
  await keyUp('KeyS');
  // 松杆后必须继续采样, 否则量不到残余衰减(= 机动惯性)。
  await sleep(2000);
  const single = await ev('JSON.stringify(window.__probe.rows)');
  await sleep(1500);

  console.log('[3/4] 多轴: 同时按住 KeyS + KeyD(抬头+右滚) 2.5s');
  await ev('window.__probe.rows.length = 0');
  await keyDown('KeyS'); await keyDown('KeyD');
  await sleep(HOLD);
  await keyUp('KeyS'); await keyUp('KeyD');
  await sleep(2000);
  const multi = await ev('JSON.stringify(window.__probe.rows)');

  console.log('[4/4] 读结果');
  // === 相机多轴响应: 纯滚转(过载≈0)能不能进入"快跟随" ===
  await ev('window.__probe.rows.length = 0');
  await keyDown('KeyD');
  await sleep(1800);
  const rollRows = JSON.parse(await ev('JSON.stringify(window.__probe.rows)'));
  await keyUp('KeyD');
  const maxOf = (rows, i) => rows.reduce((m, r) => Math.max(m, Math.abs(r[i])), 0);
  const gDev = rollRows.reduce((m, r) => Math.max(m, Math.abs(r[9] - 1)), 0);
  console.log('  [相机/纯滚转] 过载项 |gForce-1| 峰值 =', gDev.toFixed(3), '(≈0 ⇒ 旧判据下 maneuverAmt≈0)');
  console.log('  [相机/纯滚转] 姿态角速率 fwd/up 峰值 =', maxOf(rollRows, 7).toFixed(3), '/', maxOf(rollRows, 8).toFixed(3), 'rad/s');
  console.log('  [相机/纯滚转] 融合后 maneuverAmt 峰值 ≈',
    Math.min(1, Math.max(gDev / 2.5, (maxOf(rollRows, 7) + maxOf(rollRows, 8) * 0.5) / 0.9)).toFixed(3));
  // 决定性对照: 只看"1G 平稳帧"(旧判据在这些帧恒 ≈0 = 用回正的慢速率),
  // 看新判据在同一批帧里能否给出非零机动量 ⇒ 纯滚转/纯偏航也能进入快跟随。
  const oldOf = (r) => Math.abs(r[9] - 1) / 2.5;
  const newOf = (r) => Math.min(1, (Math.abs(r[7]) + Math.abs(r[8]) * 0.5) / 0.9);
  const calm = rollRows.filter((r) => oldOf(r) < 0.05);
  const maxNewCalm = calm.length ? Math.max(...calm.map(newOf)) : 0;
  console.log('  [相机/纯滚转] 1G 平稳帧:', calm.length, '张 —— 这些帧里 旧判据峰值 =',
    (calm.length ? Math.max(...calm.map(oldOf)) : 0).toFixed(3), ', 新判据峰值 =', maxNewCalm.toFixed(3));
  await sleep(600);

  // === 滚转轴符号/自动驾驶让权核查 ===
  await ev('window.__probe.rows.length = 0');
  await keyDown('KeyD');
  await sleep(900);
  console.log('  按住 KeyD →', await ev('JSON.stringify({mode:window.__engine._controlMode,inv:window.__engine.input.inversions,held:[...window.__engine.input.held],rollAxis:window.__engine.input.rollAxis(),axisHeldRoll:window.__engine.input.axisHeld("roll"),maRoll:+window.__engine._maRollCmd.toFixed(3),ctrlRoll:+window.__engine.ctrlRoll.toFixed(3),upY:+window.__engine.playerUp.y.toFixed(3)})'));
  await keyUp('KeyD');
  await sleep(400);

  const rowsS = JSON.parse(single);
  const rowsM = JSON.parse(multi);

  const analyse = (rows, label, axisIdx) => {
    const t = (i) => rows.map((r) => r[i]);
    const idx = axisIdx;
    // 采样帧时
    const dts = [];
    for (let i = 1; i < rows.length; i++) dts.push((rows[i][0] - rows[i - 1][0]) / 1000);
    const dtMed = dts.sort((a, b) => a - b)[Math.floor(dts.length / 2)] || 0.0167;
    const vals = t(idx);
    // 找到首个 > 0.05 的样本作 t0
    let start = vals.findIndex((v) => Math.abs(v) > 0.05);
    if (start < 0) start = 0;
    const base = rows[start][0];
    const hit = (thr) => {
      for (let i = start; i < rows.length; i++) {
        if (Math.abs(rows[i][idx]) >= thr) return ((rows[i][0] - base) / 1000).toFixed(3);
      }
      return null;
    };
    // === 松杆后的残余衰减(RAMP_OUT = 机动惯性) ===
    // 峰值段最后一次 >=0.9 的帧 → 之后第一次 <=0.1 的帧, 这一段才是机动惯性。
    const fall = (thr) => {
      let last = start;
      for (let i = start; i < rows.length; i++) if (Math.abs(rows[i][idx]) >= 0.9) last = i;
      for (let i = last; i < rows.length; i++) if (Math.abs(rows[i][idx]) <= thr) return ((rows[i][0] - rows[last][0]) / 1000).toFixed(3);
      return null;
    };
    const peaked = Math.max(...vals.map(Math.abs));
    const rising = rows.slice(start, start + 40).map((r) => +r[idx].toFixed(3));
    console.log(`  [${label}] 帧时中位 ${(dtMed * 1000).toFixed(1)}ms | 峰值 ${peaked.toFixed(3)}`);
    console.log(`     首次>0.05: ${((rows[start][0] - rows[0][0]) / 1000).toFixed(3)}s  到 0.25: ${hit(0.25)}s  到 0.50: ${hit(0.5)}s  到 0.90: ${hit(0.9)}s`);
    console.log(`     松杆 0.90->0.10: ${fall(0.1)}s  (RAMP_OUT = 机动惯性)`);
    console.log(`     前 40 帧上升序列: ${rising.join(' ')}`);
    return { peaked, hit25: hit(0.25), hit50: hit(0.5), hit90: hit(0.9), fall9010: fall(0.1), rising, dtMed };
  };

  console.log('--- 单轴 KeyS (ctrlPitch, 通道 1) ---');
  const a1 = analyse(rowsS, 'ctrlPitch', 1);
  console.log('--- 单轴 KeyS (ctrlRoll, 通道 2 应≈0) ---');
  const a2 = analyse(rowsS, 'ctrlRoll', 2);
  console.log('--- 多轴 KeyS+KeyD (ctrlPitch) ---');
  const b1 = analyse(rowsM, 'ctrlPitch', 1);
  console.log('--- 多轴 KeyS+KeyD (ctrlRoll) ---');
  const b2 = analyse(rowsM, 'ctrlRoll', 2);

  const report = { url, model: '', single: { pitch: a1, roll: a2 }, multi: { pitch: b1, roll: b2 }, rowsS, rowsM };
  if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 1));
  // === 顺带截图(带真 GL 路径, 与 ui-shot 的 --disable-gpu 不同) ===
  const SHOT = flag('--shot', '');
  if (SHOT) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, undefined, 60000);
    writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log('  截图:', SHOT);
  }  console.log('\n结论:');
  console.log('  单轴到 0.9 用时        :', a1.hit90, 's');
  console.log('  多轴 pitch 到 0.9 用时 :', b1.hit90, 's');
  console.log('  多轴 roll  到 0.9 用时 :', b2.hit90, 's');
  console.log('  多轴是否叠加(两轴都动):', (Math.abs(b1.peaked) > 0.5 && Math.abs(b2.peaked) > 0.5) ? 'YES' : 'NO');
  console.log('  [杆量渐入 RAMP_IN ] pitch 到 0.9 :', a1.hit90, 's | roll 到 0.9 :', b2.hit90, 's   (应≈相同: 杆量不改)');
  console.log('  [机动惯性 RAMP_OUT] pitch 0.9->0.1:', a1.fall9010, 's | roll 0.9->0.1:', b2.fall9010, 's');
  const rp = Number(a1.fall9010), rr = Number(b2.fall9010);
  if (rp > 0 && rr > 0) console.log('  roll/pitch 惯性时间比 =', (rr / rp).toFixed(3), '(目标 0.6)');

  proc.kill();
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
