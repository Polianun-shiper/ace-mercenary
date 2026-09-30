#!/usr/bin/env node
// scripts/rig-watch.mjs
//
// **手工调整的闭环**: Blender 里保存 .blend → 自动导出 rig json → 自动刷新游戏页面。
// 一条命令起完, 之后就是"拖一下、存一下、看一眼"。
//
// 用法:
//   node scripts/serve-test.mjs &                       # 静态服务(127.0.0.1:8898)
//   node scripts/rig-watch.mjs --model f16c             # 起一个带调试口的游戏窗口并盯着
//   node scripts/rig-watch.mjs --model f16c --url http://127.0.0.1:8898/#autotest&desktop&mission=m06
//   node scripts/rig-watch.mjs --model f16c --no-export  # 只盯 json(自己手动跑 30_export)
//
// 它盯两个文件:
//   blender/aircraft/out/<model>.rig.blend   ← 你在 Blender 里保存它
//   public/config/aircraft-rig.json          ← 导出产物; 一变就刷新游戏页面
//
// ★ 为什么用**轮询**而不是 fs.watch:
//   Windows 上 Blender/编辑器保存常用"写临时文件再改名"的原子替换, fs.watch 经常
//   漏事件(仓库里 scripts/blender-watch.mjs 的注释记过同一条)。轮询 1s 足够便宜。
//
// ★ 为什么刷新页面而不是做"热更": 仓库现有 tune 加载器都是一次性模块缓存, 而锚点/
//   舵面铰链有一部分是**建机体时烘进几何**的(铰链 pivot 会 geometry.translate)。
//   刷新才是诚实且必定正确的做法; 假装热更只会让人以为生效了其实没生效。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes('--' + k);

const MODEL = flag('model', 'f16c');
const BLEND = join(ROOT, 'blender', 'aircraft', 'out', `${MODEL}.rig.blend`);
const RIG = join(ROOT, 'public', 'config', 'aircraft-rig.json');
const URL = flag('url', 'http://127.0.0.1:8898/#autotest&desktop&mission=m06');
const BLENDER = process.env.BLENDER || 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Blender\\blender.exe';
const INTERVAL = Number(flag('interval', '1000'));
const DO_EXPORT = !has('no-export');
const W = 1600, H = 900;

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
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); } }, 60000);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = (p) => { try { const s = statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return 'missing'; } };

async function main() {
  if (!existsSync(RIG)) {
    console.warn(`[warn] 还没有 ${RIG} —— 先跑一次 30_export.py, 或它会在你第一次保存后自动生成`);
  }
  const port = 9800 + Math.floor(Math.random() * 150);
  const profileDir = mkdtempSync(join(tmpdir(), 'rigwatch-'));
  const child = spawn(findBrowser(), [
    has('headless') ? '--headless=new' : '--new-window',
    '--use-gl=angle', '--use-angle=d3d11', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
    `--window-size=${W},${H}`, `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: has('headless') });

  let ws = null, sessionId = null, cdp = null;
  const attach = async () => {
    let ver = null;
    for (let i = 0; i < 60 && !ver; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) ver = await r.json(); } catch {}
      if (!ver) await sleep(300);
    }
    if (!ver) throw new Error('DevTools 未就绪');
    ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('WS 失败')), { once: true }); });
    cdp = new CDP(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
    await cdp.send('Page.enable', {}, sessionId);
  };
  const reload = async () => {
    // ★ **触发即走, 不等结果**。
    //   原来用 `await Page.navigate(...)`: 它要等导航提交, 而这个页面进关卡要预热
    //   (实测 60s+), 于是 60s 的 CDP 超时先炸 —— 日志里是
    //   `[reload] 失败: CDP 超时: Page.navigate`, 表现就是"我保存了但游戏不刷新"。
    //   重载是我们不需要回执的动作, 所以干脆不 await, 也就不存在超时。
    try {
      const u = URL.split('#')[0];
      const h = URL.includes('#') ? '#' + URL.split('#')[1] : '';
      const target = `${u}${u.includes('?') ? '&' : '?'}cb=${Date.now()}${h}`;
      // 用页内 location.replace 比 CDP 的 Page.navigate 更省事: 发完就返回
      cdp.send('Runtime.evaluate',
        { expression: `location.replace(${JSON.stringify(target)})` }, sessionId).catch(() => {});
      console.log(`[reload] ${new Date().toLocaleTimeString()}  已触发页面重载`);
    } catch (e) {
      console.error('[reload] 失败:', e.message);
    }
  };

  await attach();
  await cdp.send('Page.navigate', { url: URL }, sessionId);
  console.log(`[watch] 模型 ${MODEL}`);
  console.log(`        blend : ${BLEND}`);
  console.log(`        rig   : ${RIG}`);
  console.log(`        游戏  : ${URL}`);
  console.log(`        轮询 ${INTERVAL}ms${DO_EXPORT ? ' (保存 blend 会自动导出)' : ' (--no-export: 只盯 json)'}`);
  console.log('  Ctrl+C 退出\n');

  let lastBlend = stamp(BLEND);
  let lastRig = stamp(RIG);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep(INTERVAL);
    const sb = stamp(BLEND);
    if (DO_EXPORT && sb !== lastBlend) {
      lastBlend = sb;
      console.log(`[blend] 检测到保存 → 导出 rig …`);
      const r = spawnSync(BLENDER, ['-b', '--factory-startup',
        '--python', join(ROOT, 'blender', 'aircraft', '30_export.py'),
        '--', '--model', MODEL], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
      const out = (r.stdout || '') + (r.stderr || '');
      const lines = out.split('\n').filter((l) => /^\s*\[rig\]/.test(l));
      for (const l of lines.slice(-8)) console.log('   ' + l.trim());
      if (r.status !== 0) {
        console.error(`[blend] 导出失败(exit ${r.status}) —— 上面应有原因`);
      } else {
        // ★ 导出成功后要**主动刷新一次**。
        //   曾经的写法是"把 json 的时间戳记下来, 免得下面再触发一次多余的刷新" ——
        //   结果把刷新整个吞掉了: 你保存 → json 更新了 → 但游戏页面永远不刷,
        //   看上去就像"改了没生效"。两条路都要能刷: blend 保存(这条) 与 json 被外部改。
        lastRig = stamp(RIG);
        await reload();
      }
    }
    const sr = stamp(RIG);
    if (sr !== lastRig) {
      lastRig = sr;
      await reload();
    }
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
