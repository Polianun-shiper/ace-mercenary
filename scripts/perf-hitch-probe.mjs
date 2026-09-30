#!/usr/bin/env node
// scripts/perf-hitch-probe.mjs
//
// === 偶发长卡顿取证探针 (per user request: 先查证再修) ====================
// 在 headless 浏览器里进一关、按可控方式持续飞行(默认强制低空), 逐秒采样
// renderer.info 与帧间隔, 并在有 CPU 采样时把"最长的那几帧"落到具体函数。
//
// 用法:
//   node scripts/perf-hitch-probe.mjs <url> [--seconds 90] [--low] [--profile]
//                                        [--w 1600] [--h 950] [--out x.json]
// 说明:
//   --low      每帧把玩家按在"离地 600m"的高度(用引擎自己的 _terrainHeightFn),
//              并把 HP 顶成满值防止坠毁结束任务 —— 复现"低空作战"工况。
//   --profile  同时开 CDP Profiler(1ms 采样), 结束时把最长的 3 个帧间隔窗口内的
//              自耗时最高函数打印出来(定位"是什么在那一帧现场构建")。
// 注意: 不用 --disable-gpu —— 要的是真 GPU 路径上的卡顿, 不是 SwiftShader。
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const url = argv[0];
if (!url) {
  console.log('用法: node scripts/perf-hitch-probe.mjs <url> [--seconds 90] [--low] [--profile]');
  process.exit(1);
}
const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const SECONDS = Number(flag('--seconds', 90));
const LOW = argv.includes('--low');
const PROFILE = argv.includes('--profile');
const W = Number(flag('--w', 1600));
const H = Number(flag('--h', 950));
const OUT = flag('--out', '');

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); } }, timeoutMs);
    });
  }
  once(method, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`等待事件超时: ${method}`)), timeoutMs);
      this.listeners.push((msg) => { if (msg.method === method) { clearTimeout(t); resolve(msg.params); } });
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 页内采样脚本(纯 IE/ES5 友好写法, 避免模板字符串转义问题) ----
const SETUP = (low) => `
(function () {
  var eng = window.__engine;
  if (!eng || !eng.renderer) return 'no-engine';
  var info = eng.renderer.info;
  var P = { t0: performance.now(), gaps: [], marks: [], samples: [], first: [], low: ${low ? 'true' : 'false'}, peaks: [] };
  window.__probe = P;
  var last = performance.now();
  var lastSec = -1;
  var gl = null;
  try { gl = eng.renderer.getContext(); } catch (e) {}
  var dbg = null;
  try {
    var ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) dbg = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
  } catch (e) {}
  P.gpu = dbg || 'unknown';
  function loop() {
    var now = performance.now();
    var d = now - last; last = now;
    P.gaps.push(d);
    var s = Math.floor((now - P.t0) / 1000);
    if (P.first.length < 14) {
      P.first.push({ g: +d.toFixed(1), prog: info.programs ? info.programs.length : 0, geo: info.memory.geometries, tex: info.memory.textures });
    }
    if (s !== lastSec) {
      lastSec = s;
      // 场景里**可见**的点光源数(three 的 program cache key 含 numPointLights,
      // 这个数一变, 每个材质都要重新编译/链接)。
      var pl = 0, dl = 0, hl = 0, plLit = 0;
      eng.scene.traverse(function (o) {
        if (o.isPointLight && o.visible) { pl++; if (o.intensity > 0) plLit++; }
        else if (o.isDirectionalLight && o.visible) dl++;
        else if (o.isHemisphereLight && o.visible) hl++;
      });
      P.samples.push({
        s: s,
        pl: pl, plLit: plLit, dl: dl, hl: hl,
        comp: eng.composer ? 1 : 0,
        pw: eng.prewarmInfo ? JSON.stringify(eng.prewarmInfo) : '',
        programs: info.programs ? info.programs.length : 0,
        tex: info.memory.textures,
        geo: info.memory.geometries,
        calls: info.render.calls,
        tris: info.render.triangles,
        y: Math.round(eng.player && eng.player.position ? eng.player.position.y : 0),
        heap: (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0)
      });
    }
    if (P.low && eng.player && eng.playerVelocity) {
      var p = eng.player.position;
      var fn = eng._terrainHeightFn;
      var gy = 0;
      try { gy = fn ? (fn(p.x, p.z) || 0) : 0; } catch (e) { gy = 0; }
      p.y = gy + 600;
      if (eng.playerVelocity.y > 0) eng.playerVelocity.y = 0;
      if (eng.playerHp !== undefined) eng.playerHp = 1e9;
      if (eng.playerSpeed !== undefined && eng.playerSpeed < 380) eng.playerSpeed = 400;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  return 'ok';
})()`;

const SNAPSHOT = `(function () {
  var P = window.__probe; if (!P) return null;
  var g = P.gaps, n = g.length, mx = 0, over50 = 0, over100 = 0, over250 = 0, sum = 0;
  for (var i = 0; i < n; i++) { var v = g[i]; sum += v; if (v > mx) mx = v; if (v > 50) over50++; if (v > 100) over100++; if (v > 250) over250++; }
  var s = P.samples.length ? P.samples[P.samples.length - 1] : {};
  return {
    elapsed: Math.round((performance.now() - P.t0) / 1000),
    frames: n, avg: n ? +(sum / n).toFixed(2) : 0, max: +mx.toFixed(1),
    over50: over50, over100: over100, over250: over250,
    programs: s.programs, tex: s.tex, geo: s.geo, calls: s.calls, heap: s.heap, gpu: P.gpu
  };
})()`;

const FINISH = `(function () {
  var P = window.__probe; if (!P) return null;
  return { gaps: P.gaps, samples: P.samples, first: P.first, t0: P.t0, gpu: P.gpu };
})()`;

function summarize(res) {
  const gaps = res.gaps;
  const n = gaps.length;
  const sorted = gaps.slice().sort((a, b) => a - b);
  const max = sorted[n - 1] || 0;
  // p50/p95 也给出(§111 之前只报 avg/p99/p99.9; 风暴关的"帧数不足"要看中位数,
  // 而不是被最坏几帧拉高的均值)
  const pct = (q) => sorted[Math.min(n - 1, Math.max(0, Math.floor(n * q)))] || 0;
  const p50 = pct(0.5);
  const p95 = pct(0.95);
  const p99 = sorted[Math.floor(n * 0.99)] || 0;
  const p999 = sorted[Math.floor(n * 0.999)] || 0;
  const avg = gaps.reduce((a, b) => a + b, 0) / (n || 1);
  const over50 = gaps.filter((v) => v > 50).length;
  const over100 = gaps.filter((v) => v > 100).length;
  const over250 = gaps.filter((v) => v > 250).length;
  // 最长 5 个卡顿的"发生时刻"(相对 t0, 秒)
  const top = gaps.map((v, i) => ({ v, ms: (res.samples.length ? 0 : 0) + i }))
    .sort((a, b) => b.v - a.v).slice(0, 6);
  // 逐帧累计时刻,换算 top 的发生秒
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + gaps[i];
  const topWithT = gaps.map((v, i) => ({ v, t: cum[i] / 1000 })).sort((a, b) => b.v - a.v).slice(0, 6);
  return { n, avg, p50, p95, p99, p999, max, over50, over100, over250, top: topWithT, samples: res.samples };
}

// ---- CPU profile 分析: 找最长帧间隔窗口内的自耗时最高函数 ----
function analyzeProfile(profile, res) {
  const byId = new Map();
  for (const n of profile.nodes) byId.set(n.id, n);
  const gaps = res.gaps;
  const n = gaps.length;
  // 帧序号 → 绝对时刻(ms, 相对 profile.startTime)
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + gaps[i];
  const winSec = [0, 1, 2]; // 最长的 3 个窗口
  const order = gaps.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v).slice(0, 3);
  // profile 采样时间轴
  const t = [];
  let acc = 0;
  for (let i = 0; i < profile.samples.length; i++) { acc += profile.timeDeltas[i] || 0; t.push(acc / 1000); }
  const out = [];
  for (const o of order) {
    const a = cum[o.i] + gaps[o.i] * 0.25;
    const b = cum[o.i + 1];
    const self = new Map();
    for (let k = 0; k < profile.samples.length; k++) {
      if (t[k] < a || t[k] > b) continue;
      const id = profile.samples[k];
      self.set(id, (self.get(id) || 0) + (profile.timeDeltas[k] || 0));
    }
    const rows = [...self.entries()].map(([id, us]) => {
      const nd = byId.get(id);
      const f = nd && nd.callFrame;
      const nm = f ? (f.functionName || '(anon)') : '?';
      const u = f ? (f.url || '').split('/').slice(-1)[0].replace(/^.*\[/, '[') : '';
      return { ms: +(us / 1000).toFixed(1), fn: nm, url: u, line: f ? f.lineNumber : -1 };
    }).sort((x, y) => y.ms - x.ms).slice(0, 10);
    out.push({ gapMs: +o.v.toFixed(1), t: +(cum[o.i] / 1000).toFixed(2), rows });
  }
  return out;
}

async function main() {
  const bin = findBrowser();
  const port = 9400 + Math.floor(Math.random() * 400);
  const profileDir = mkdtempSync(join(tmpdir(), 'perf-probe-'));
  const child = spawn(bin, [
    '--headless=new',
    '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    '--use-gl=angle', '--use-angle=d3d11',
    `--window-size=${W},${H}`,
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let ok = false;
  try {
    let ver = null;
    for (let i = 0; i < 60 && !ver; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) ver = await r.json(); } catch { /* retry */ }
      if (!ver) await sleep(300);
    }
    if (!ver) throw new Error('DevTools 未就绪');
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WS 连接失败')), { once: true });
    });
    const cdp = new CDP(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const S = (m, p, to) => cdp.send(m, p, sessionId, to);
    await S('Page.enable');
    await S('Runtime.enable');
    await S('Profiler.enable');
    const pageErrors = [];
    cdp.listeners.push((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        pageErrors.push('[exception] ' + (msg.params.exceptionDetails.text || ''));
      }
    });
    await S('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    const loaded = cdp.once('Page.loadEventFired', 60000);
    await S('Page.navigate', { url });
    await Promise.race([loaded, sleep(60000)]);

    // 等 missionReady
    let ready = false;
    for (let i = 0; i < 180 && !ready; i++) {
      const r = await S('Runtime.evaluate', { expression: '!!(window.__engine && window.__engine.missionReady)', returnByValue: true });
      ready = r.result && r.result.value === true;
      if (!ready) await sleep(500);
    }
    if (!ready) throw new Error('missionReady 超时(关卡没起来?)');

    const r0 = await S('Runtime.evaluate', { expression: SETUP(LOW), returnByValue: true });
    console.log('[probe] setup:', r0.result.value);
    // --dump <file.js>: missionReady 之后执行该 JS 文件并打印返回值(读 cloudStats /
    // uniform 等验证数据)。CDP 默认 30s 超时, 所以脚本自身必须很快返回。
    // --dump-timeout <ms>: 长窗口的**现场取证**脚本(例如"逐秒对比 program
    // cacheKey 集合"要跑 20~30 s)才需要放大 —— 默认仍是 30s。
    // 注意: 卡顿帧会把页内 setTimeout 一起顶后, 所以窗口要留足余量。
    const DUMP = flag('--dump', '');
    const DUMP_TO = Number(flag('--dump-timeout', 30000));
    if (DUMP && existsSync(DUMP)) {
      const code = readFileSync(DUMP, 'utf8');
      const rd = await S('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true }, DUMP_TO);
      if (rd.exceptionDetails) console.log('[dump] 异常:', rd.exceptionDetails.text, (rd.exceptionDetails.exception && rd.exceptionDetails.exception.description) || '');
      else console.log('[dump] ' + DUMP + ' -> ' + (typeof rd.result.value === 'string' ? rd.result.value : JSON.stringify(rd.result.value, null, 1)));
    }
    // --shot <png> + --cam x,y,z,tx,ty,tz: 暂停相机并摆到指定位置后截图(② 高角度验收)。
    // 暂停(paused=true)后 engine.update() 会跳过相机跟随, 所以直接写 camera.camera 不会被覆盖。
    const SHOT = flag('--shot', '');
    const CAM = flag('--cam', '');
    if (SHOT) {
      if (CAM) {
        const n = CAM.split(',').map(Number);
        const code = '(function(){var e=window.__engine;e.paused=true;var c=e.camera.camera;c.position.set(' + n[0] + ',' + n[1] + ',' + n[2] + ');c.lookAt(' + n[3] + ',' + n[4] + ',' + n[5] + ');c.updateMatrixWorld(true);return "ok";})()';
        const rc = await S('Runtime.evaluate', { expression: code, returnByValue: true });
        console.log('[cam]', JSON.stringify(rc.result.value), rc.exceptionDetails ? rc.exceptionDetails.text : '');
      }
      await sleep(1500);
      const shot = await S('Page.captureScreenshot', { format: 'png' }, 60000);
      writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
      console.log('[shot]', SHOT, (readFileSync(SHOT).length / 1024).toFixed(0) + ' KB');
    }
    const gpu = await S('Runtime.evaluate', { expression: 'window.__probe.gpu', returnByValue: true });
    console.log('[probe] gpu:', gpu.result.value);
    if (PROFILE) await S('Profiler.start', { samplingInterval: 1000 });

    // 逐 2 秒轮询(每次 CDP 调用都很短, 不做长等待)
    for (let e = 0; e < SECONDS; e += 2) {
      await sleep(2000);
      const r = await S('Runtime.evaluate', { expression: SNAPSHOT, returnByValue: true });
      const v = r.result.value;
      if (v) console.log(`  t=${String(v.elapsed).padStart(3)}s frames=${v.frames} avg=${v.avg}ms max=${v.max}ms >100ms=${v.over100} prog=${v.programs} tex=${v.tex} geo=${v.geo} calls=${v.calls} heap=${v.heap}MB`);
    }

    const rf = await S('Runtime.evaluate', { expression: FINISH, returnByValue: true });
    const res = rf.result.value;
    let prof = null;
    if (PROFILE) prof = await S('Profiler.stop', {}, 60000);

    const sum = summarize(res);
    console.log('\n=== 汇总 ===');
    console.log(`GPU         : ${res.gpu}`);
    console.log(`帧数        : ${sum.n}  平均 ${sum.avg.toFixed(2)} ms  p50 ${sum.p50.toFixed(1)} ms  p95 ${sum.p95.toFixed(1)} ms  p99 ${sum.p99.toFixed(1)} ms  p99.9 ${sum.p999.toFixed(1)} ms  最大 ${sum.max.toFixed(1)} ms`);
    console.log(`>50ms: ${sum.over50}   >100ms: ${sum.over100}   >250ms: ${sum.over250}`);
    console.log('最长 6 个帧间隔 (发生时刻秒):');
    for (const it of sum.top) console.log(`   ${it.v.toFixed(1)} ms  @ ${it.t.toFixed(2)}s`);
    console.log('前 14 帧 [间隔ms / programs / geo / tex]:'); for (const f of (res.first || [])) console.log('    ' + String(f.g).padStart(7) + ' ms  prog=' + f.prog + ' geo=' + f.geo + ' tex=' + f.tex);
    console.log('前 8 帧逐帧间隔: ' + res.gaps.slice(0, 8).map((v) => v.toFixed(1)).join(' / ') + ' ms');
    console.log('\n逐秒 renderer.info:');
    let prev = null;
    for (const s of sum.samples) {
      const dp = prev ? s.programs - prev.programs : 0;
      const dt = prev ? s.tex - prev.tex : 0;
      const dg = prev ? s.geo - prev.geo : 0;
      console.log(`   ${String(s.s).padStart(3)}s prog=${s.programs}(${dp >= 0 ? '+' : ''}${dp}) tex=${s.tex}(${dt >= 0 ? '+' : ''}${dt}) geo=${s.geo}(${dg >= 0 ? '+' : ''}${dg}) calls=${s.calls} ptLight=${s.pl} lit=${s.plLit} dirLight=${s.dl} composer=${s.comp} pw=${s.pw} y=${s.y} heap=${s.heap}MB`);
      prev = s;
    }
    if (prof && prof.profile) {
      console.log('\n=== 最大卡顿帧的 CPU 自耗时 Top10 ===');
      for (const w of analyzeProfile(prof.profile, res)) {
        console.log(`--- gap ${w.gapMs}ms @ ${w.t}s ---`);
        for (const r of w.rows) console.log(`    ${String(r.ms).padStart(7)}ms  ${r.fn}  (${r.url}:${r.line})`);
      }
    }
    if (pageErrors.length) {
      console.log('\n页面异常:', pageErrors.slice(0, 5).join(' | '));
    }
    if (OUT) { writeFileSync(OUT, JSON.stringify({ summary: sum, profile: prof ? analyzeProfile(prof.profile, res) : null }, null, 1)); console.log('\n[out]', OUT); }
    await S('Target.closeTarget', { targetId }).catch(() => {});
    ws.close();
    ok = true;
  } finally {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
    } catch { /* ignore */ }
  }
  if (!ok) process.exit(2);
}

main().catch((e) => { console.error('[perf-hitch-probe] 失败:', e.message); process.exit(3); });
