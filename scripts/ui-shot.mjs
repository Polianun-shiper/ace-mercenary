#!/usr/bin/env node
// === UI 截图工具(CDP)—— 用于主界面/编辑器的视觉验收 ====================
// 为什么不用 `msedge --screenshot`:该 CLI 路径在本机 Edge 141 上不稳定
// (进程被 compat-layer 握手卡住、静默不产出文件)。这里改为自己拉起
// headless 浏览器 + 走 DevTools Protocol 截图,稳且能顺带执行 JS(点按钮、
// 改状态后再拍),是长期可用的 UI 回归工具。
//
// 用法:
//   node scripts/ui-shot.mjs <url> <out.png> [--w 1600] [--h 950] [--wait 1500]
//                              [--js "document.querySelector('button').click()"]
//                              [--scale 1] [--keep]
// 说明:
//   --js     导航加载完成后、截图前执行的 JS(可多次;用于切到指定界面)
//   --wait   截图前额外等待毫秒(默认 1200,给字体/CSS 动画稳定时间)
//   --keep   保留浏览器进程(调试用);默认截图后关掉自己拉起的进程
// 浏览器解析顺序:env BROWSER_PATH → Edge 版本目录(取最新) → Chrome → 报错。
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const url = argv[0];
const out = argv[1];
if (!url || !out) {
  console.log('用法: node scripts/ui-shot.mjs <url> <out.png> [--w 1600] [--h 950] [--wait 1200] [--js "…"] [--scale 1] [--keep]');
  process.exit(1);
}
const flag = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const allFlag = (k) => argv.map((a, i) => (a === k ? argv[i + 1] : null)).filter(Boolean);
const W = Number(flag('--w', 1600));
const H = Number(flag('--h', 950));
const WAIT = Number(flag('--wait', 1200));
const SCALE = Number(flag('--scale', 1));
const KEEP = argv.includes('--keep');
const JS_SNIPPETS = allFlag('--js');

// ---------- 解析浏览器可执行文件 ----------
function findBrowser() {
  if (process.env.BROWSER_PATH && existsSync(process.env.BROWSER_PATH)) return process.env.BROWSER_PATH;
  const roots = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application',
    'C:\\Program Files\\Microsoft\\Edge\\Application',
    'C:\\Program Files\\Google\\Chrome\\Application',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application',
  ];
  const exe = (dir) => {
    const direct = join(dir, 'msedge.exe');
    if (existsSync(direct)) return direct;
    const direct2 = join(dir, 'chrome.exe');
    if (existsSync(direct2)) return direct2;
    return null;
  };
  for (const root of roots) {
    if (!existsSync(root)) continue;
    // 版本目录取最新(字典序对 141.0.3537.71 这类版本号有效)
    const vers = readdirSync(root)
      .filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d))
      .sort()
      .reverse();
    for (const v of vers) {
      const p = exe(join(root, v));
      if (p) return p;
    }
    const p = exe(root);
    if (p) return p;
  }
  throw new Error('找不到浏览器(设置 BROWSER_PATH 环境变量指向 msedge.exe / chrome.exe)');
}

// ---------- 极简 CDP 客户端 ----------
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    // 长探测脚本(例如"发射导弹后跟踪十几秒的命中时序")会跑得比默认超时长,
    // 需要时用 UI_SHOT_CDP_TIMEOUT_MS 放大(毫秒)。
    const timeoutMs = Number(process.env.UI_SHOT_CDP_TIMEOUT_MS || 30000);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, timeoutMs);
    });
  }
  once(method, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`等待事件超时: ${method}`)), timeoutMs);
      this.listeners.push((msg) => {
        if (msg.method === method) {
          clearTimeout(t);
          resolve(msg.params);
        }
      });
    });
  }
}

async function waitForDevtools(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('DevTools 端点未就绪(浏览器启动失败?)');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const bin = findBrowser();
  const port = 9200 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), 'ui-shot-'));
  const child = spawn(bin, [
    '--headless=new',
    // 真 GPU(per user request): 不要 --disable-gpu / SwiftShader —— 那是纯 CPU 软渲染,
    // 很吃 CPU, 而且 3D 场景会截成黑屏(只剩 HUD)。只有"必须逐像素可复现"时才换
    // --use-angle=swiftshader。
    '--use-gl=angle',
    '--use-angle=d3d11',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--mute-audio',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let ok = false;
  try {
    const ver = await waitForDevtools(port);
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    });
    const cdp = new CDP(ws);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const S = (m, p) => cdp.send(m, p, sessionId);

    await S('Page.enable');
    await S('Runtime.enable');
    // 页面报错收集(否则"半初始化画面"看不出真因 —— GameApp 出错时也会
    // 进 playing 让用户看到画布,视觉上只表现为没有机体/没有敌人)
    const pageErrors = [];
    cdp.listeners.push((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        pageErrors.push(`[exception] ${d.text} ${d.exception?.description ?? ''}`.trim());
      } else if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
        const txt = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        pageErrors.push(`[${msg.params.type}] ${txt}`);
      }
    });
    await S('Emulation.setDeviceMetricsOverride', {
      width: W, height: H, deviceScaleFactor: SCALE, mobile: false,
    });
    const loaded = cdp.once('Page.loadEventFired');
    await S('Page.navigate', { url });
    await Promise.race([loaded, sleep(15000)]);
    await sleep(WAIT);

    for (const js of JS_SNIPPETS) {
      const r = await S('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) console.warn('[js] 异常:', r.exceptionDetails.text, r.exceptionDetails.exception?.description ?? '');
      else if (r.result && r.result.value !== undefined) console.log('[js] →', JSON.stringify(r.result.value));
      await sleep(500);
    }

    const shot = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    const kb = (readFileSync(out).length / 1024).toFixed(0);
    console.log(`[shot] ${out}  ${W}×${H}@${SCALE}x  ${kb} KB  (${bin.split('\\').pop()})`);
    if (pageErrors.length) {
      console.log(`--- 页面报错 ${pageErrors.length} 条 ---`);
      for (const e of pageErrors.slice(0, 12)) console.log('  ' + e.slice(0, 400));
    }
    await S('Target.closeTarget', { targetId }).catch(() => {});
    ws.close();
    ok = true;
  } finally {
    if (!KEEP) {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      // 保险:只杀自己这次拉起的进程树(绝不动用户已开的浏览器)
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
        }
      } catch { /* ignore */ }
      // 删掉本次 profile(一个 ~64MB; 不删会累积到把盘塞满, 实测踩过 ENOSPC)
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }
    }
  }
  if (!ok) process.exit(2);
}

main().catch((e) => {
  console.error('[ui-shot] 失败:', e.message);
  process.exit(3);
});
