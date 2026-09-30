#!/usr/bin/env node
// scripts/rig-dump.mjs
//
// **游戏 → Blender** 方向: 进一个关卡, 把机体的实测真值(几何 + 当前生效锚点 +
// 舵面铰链 + 喷口参数)导出成 JSON, 给 blender/aircraft/ 当编辑器的起点。
//
// 为什么必须由游戏导出而不是在 Blender 里重算:
//   翼尖跨距 / 尾锥 Z / 喷口半径与 aftZ 都是**加载时扫顶点实测**的
//   (src/lib/game/nozzle-metrics.ts), 舵面铰链轴是拟合出来的
//   (src/lib/game/models.ts setupHinge)。在 Blender 侧重算一遍 = 复制一份逻辑,
//   两边一旦漂移, 你手调出来的数值就全是错的。
//
// 用法:
//   node scripts/serve-test.mjs &                     # 先起静态服务(127.0.0.1:8898)
//   node scripts/rig-dump.mjs http://127.0.0.1:8898/
//   node scripts/rig-dump.mjs <url> --all             # 先把全部机型几何载进来再 dump
//   node scripts/rig-dump.mjs <url> --model f16c      # 只关心一个机型
//
// 产物: blender/aircraft/out/rig-dump.json

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'blender', 'aircraft', 'out', 'rig-dump.json');
const argv = process.argv.slice(2);
const url = argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:8898/';
const flag = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes('--' + k);

const MISSION = flag('mission', 'm06');
const ONLY = flag('model', '');
const W = 1280, H = 720;

function findBrowser() {
  if (process.env.BROWSER_PATH && existsSync(process.env.BROWSER_PATH)) return process.env.BROWSER_PATH;
  for (const root of [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application',
    'C:\\Program Files\\Microsoft\\Edge\\Application',
    'C:\\Program Files\\Google\\Chrome\\Application',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application',
  ]) {
    if (!existsSync(root)) continue;
    for (const v of readdirSync(root).filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d)).sort().reverse()) {
      for (const exe of ['msedge.exe', 'chrome.exe']) { const p = join(root, v, exe); if (existsSync(p)) return p; }
    }
  }
  throw new Error('找不到浏览器(可用 BROWSER_PATH 指定)');
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const p = { id, method, params };
    if (sessionId) p.sessionId = sessionId;
    this.ws.send(JSON.stringify(p));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); } }, 300000);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9750 + Math.floor(Math.random() * 200);
const profileDir = mkdtempSync(join(tmpdir(), 'rigdump-'));
const child = spawn(findBrowser(), [
  '--headless=new', '--use-gl=angle', '--use-angle=d3d11', '--no-sandbox', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--mute-audio',
  `--window-size=${W},${H}`, `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`, 'about:blank',
], { stdio: 'ignore', windowsHide: true });

let ok = false;
try {
  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) ver = await r.json(); } catch {}
    if (!ver) await sleep(300);
  }
  if (!ver) throw new Error('DevTools 未就绪');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('WS 失败')), { once: true }); });
  const cdp = new CDP(ws);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => cdp.send(m, p, sessionId);
  await S('Page.enable'); await S('Runtime.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  const ev = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
    return r.result?.value;
  };

  // 固定天气, 免得同一份 dump 每次环境不同
  await S('Page.navigate', { url });
  await sleep(1200);
  await ev(`(()=>{try{localStorage.setItem('skybound.weatherOverride','clear');}catch(e){} return 1;})()`);

  // ★ 只改 fragment 不会重新加载页面, 游戏看不到 hash → 必须带查询参数
  const base = url.split('#')[0];
  await S('Page.navigate', { url: `${base}${base.includes('?') ? '&' : '?'}cb=${Date.now()}#autotest&desktop&mission=${MISSION}` });

  // 关卡预热(材质/几何全载)常超过 60s → 在 Node 侧轮询, 不用页内长循环
  let ready = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 300000) {
    ready = await ev(`(()=>{const e=window.__engine;return e?{ready:!!e.missionReady,stage:(window.__loadStage||null)}:null;})()`);
    if (ready && ready.ready) break;
    await sleep(2000);
  }
  console.log(`[ready] ${JSON.stringify(ready)}  用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (!ready?.ready) throw new Error('关卡没就绪(等 300s 仍未 missionReady)');

  if (has('all')) {
    const r = await ev(`window.__rigPreloadAll()`);
    console.log('[preload]', JSON.stringify(r));
  }
  await sleep(500);

  const doc = await ev(`window.__rigDump()`);
  if (!doc || !doc.models) throw new Error('__rigDump 没返回 models —— 钩子没注册?');
  if (ONLY) {
    const keep = doc.models[ONLY];
    doc.models = keep ? { [ONLY]: keep } : {};
    if (!keep) console.warn(`[warn] dump 里没有机型 ${ONLY}; 现有: ${Object.keys(doc.models).join(', ')}`);
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');
  const ids = Object.keys(doc.models);
  console.log(`[dump] ${ids.length} 个机型: ${ids.join(', ')}`);
  console.log(`        rig 文件已加载=${doc.rigFileLoaded} 版本=${doc.rigRevision}`);
  console.log(`[out]  → ${OUT}`);

  // === 门: 默认值必须逐位复现改动前的世界坐标 ==============================
  // 不去跟"改动前的 dump"比对(那会混进环境噪声), 而是**算术核对**:
  // 锚点表的设计意图就是"世界偏移 = 旧硬编码常量", 所以直接按旧公式算期望值。
  // 这样每次 dump 都能自动证明"重构没有改变任何默认行为"。
  const LEGACY = {
    muzzle: (g, s) => [0, -0.192, g.noseZ * s + 0.32],
    gunport: () => [-3.0, -0.4, 0.5],
    missileR: () => [2.2, -1.15, 1.5],
    missileL: () => [-2.2, -1.15, 1.5],
    bomb: () => [0, -0.8, 1.0],
    rocket: () => [0, 1.0, 6.0],
    wingTipL: (g, s) => [-g.halfSpan * s, -0.3, 0.2],
    wingTipR: (g, s) => [g.halfSpan * s, -0.3, 0.2],
    flare: () => [0, -1.0, 0],
    trailSmoke: () => [0, 0, -2.0],
    trailSmokeHeavy: () => [0, 0, -4.0],
  };
  // ★ 有 rig 覆盖的锚点**不能**再拿旧常量当期望值 —— 否则一个改了锚点的仓库
  //   跑出来仍然显示默认值核对通过, 那是会说谎的门。
  const rigPath = join(ROOT, 'public', 'config', 'aircraft-rig.json');
  let rigDoc = null;
  try { rigDoc = JSON.parse(readFileSync(rigPath, 'utf8')); } catch { rigDoc = null; }
  const RIG_ALIAS = { f16: 'f16c', 'f16-test': 'f16c' };
  const overridden = (mid, k) => {
    const key = RIG_ALIAS[mid] ?? mid;
    return !!rigDoc?.models?.[key]?.anchor?.[k];
  };
  const bad = [];
  let checked = 0, skipped = 0;
  for (const [mid, m] of Object.entries(doc.models)) {
    const w = m.anchorWorldUnits;
    if (!w) continue;
    for (const [k, fn] of Object.entries(LEGACY)) {
      if (!w[k]) { continue; }
      if (overridden(mid, k)) { skipped++; continue; }   // 被 rig 手工改过, 不参与对账
      const want = fn(m.geom, m.scale);
      const got = w[k];
      const dx = Math.max(...want.map((v, i) => Math.abs(v - got[i])));
      checked++;
      if (dx > 1e-4) bad.push(`${mid}.${k}: 期望 [${want.join(', ')}] 实得 [${got.join(', ')}] Δ=${dx.toExponential(2)}`);
    }
    console.log(`[check] ${mid}: 锚点 ${Object.keys(w).length} 个, 几何 noseZ=${m.geom.noseZ} tailZ=${m.geom.tailZ} halfSpan=${m.geom.halfSpan} scale=${m.scale}`);
    if (m.surface) console.log(`        舵面 ${Object.keys(m.surface).length} 个: ${Object.keys(m.surface).join(', ')}`);
    if (m.nozzle) {
      const nz = m.nozzle[0];
      console.log(`        喷口#0 pos=[${nz.pos.join(', ')}] radius=${nz.radius} aftZ=${nz.aftZ} ${nz.measured ? '(实测)' : '(估计)'}`);
    }
  }
  if (bad.length) {
    console.error(`\n✗ 默认值回归! ${bad.length}/${checked} 项与旧硬编码不一致:`);
    for (const b of bad.slice(0, 12)) console.error('   ' + b);
    throw new Error('默认锚点与改动前不一致 —— 见上面清单');
  }
  console.log(`\n✓ 默认值核对通过: ${checked} 项锚点逐位复现改动前的世界坐标(Δ<1e-4)`);
  if (skipped > 0) {
    console.log(`  (另有 ${skipped} 项被 aircraft-rig.json 手工覆盖, 已退出对账 —— 那是预期行为, `
      + `不代表默认值有问题; 想全部回到默认就删掉该机型在 rig 文件里的条目)`);
  }
  ok = true;
} catch (e) {
  console.error('rig dump 失败:', e.message);
} finally {
  try { child.kill(); } catch {}
  try { rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
}
process.exit(ok ? 0 : 1);
