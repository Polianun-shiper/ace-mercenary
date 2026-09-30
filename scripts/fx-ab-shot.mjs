#!/usr/bin/env node
// scripts/fx-ab-shot.mjs
//
// 爆炸特效的游戏内 A/B 截图门: **新式图集** vs **原生逃生阀**, 同一会话、同一视点。
//
// 为什么必须在同一会话里跑两遍:
//   两次起浏览器之间飞机会继续飞、云会飘, 像素差里混进视点漂移(仓库里
//   _multishot.mjs 头注释记过这条: 同区域能差出 9/255, 与被测效果同量级)。
//   所以这里一个会话里先把相机钉死, 再依次跑 baked / legacy 两组。
//
// 为什么不能靠 setPaused 冻结:
//   引擎主循环里 `if (paused) { render(); return; }` 在
//   `fxBattle.update(dt, …)`(engine.ts:18799)**之前** —— 暂停会把特效一起冻住,
//   截出来全是第 0 帧。所以这里让世界照跑, 只钉相机。
//
// 用法:
//   node scripts/serve-test.mjs &                      # 先起静态服务(127.0.0.1:8898)
//   node scripts/fx-ab-shot.mjs http://127.0.0.1:8898/
//   node scripts/fx-ab-shot.mjs <url> --mission m06 --times 0.1,0.35,0.8,1.5 --scales 1,2,4
//
// 产物: .shots/fx-ab/{baked,legacy}/<case>-t<t>.png + ab.json(逐张的坐标/尺寸诊断)
// 任何 __glErrors / __jsErrors 非空 → 非 0 退出。

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const url = argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:8898/';
const flag = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes('--' + k);

const MISSION = flag('mission', 'm06');
const TIMES = String(flag('times', '0.1,0.35,0.8,1.5')).split(',').map(Number);
const SCALES = String(flag('scales', '1,2,4')).split(',').map(Number);
const CASES = String(flag('cases', 'ground,air')).split(',');
const OUT = resolve(flag('out', join(ROOT, '.shots', 'fx-ab')));
const W = Number(flag('w', 1600)), H = Number(flag('h', 950));
/** --direct: 直连 tryPlay 播槽位资产(绕开 AGL 归类, 见 spawnExpr 注释) */
const DIRECT = has('direct');
/** 爆点离剔除相机的距离(米)。太远看不清, 太近会被"离相机太近"的判定吃掉 */
const SPAWN_DIST = Number(flag('dist', '600'));
/**
 * --follow: 不冻结相机, 让追尾机位跟着玩家走。
 * 为什么需要: 剔除用的 lodCamForward 是**跟着玩家**的, 而一旦冻结渲染相机, 两者立刻
 * 分家 —— 爆点虽然通过了剔除, 却会偏在渲染画面的边上。想看正对镜头的大特写就得让它跟着。
 */
const FOLLOW = has('follow');
/** --up N: 把爆点沿世界上方抬高 N(米)。用来把它放到**天空背景**上 ——
 *  叠在亮地形上时, 加性的火球和深色烟都几乎看不出来, 容易误判成特效没显示。 */
const SPAWN_UP = Number(flag("up", "0"));

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
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); } }, 60000);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9700 + Math.floor(Math.random() * 250);
const profileDir = mkdtempSync(join(tmpdir(), 'fxab-'));
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
  const shot = async (file) => {
    const sh = await S('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(sh.data, 'base64'));
  };

  // --- 1) 固定环境: 天气必须钉死(它是随机的, A/B 不固定就没法比) ---
  await S('Page.navigate', { url });
  await sleep(1200);
  await ev(`(()=>{try{
    localStorage.setItem('skybound.weatherOverride','clear');
    // ★ 必须**显式**要新式: 游戏默认已回到老 sprite(weapons 图集), 光是删掉这个键
    //   不再等于"启用新式" —— 删掉只会两组都跑老 sprite, A/B 变成自己跟自己比。
    localStorage.setItem('skybound.fxReplacement','new');
  }catch(e){} return location.hash;})()`);
  // ★ 必须带一个查询参数: 只改 fragment 的导航**不会重新加载页面**,
  //   游戏根本看不到 hash, missionReady 永远不会变 true(这个坑我踩过一次)。
  const base = url.split('#')[0];
  const bootUrl = `${base}${base.includes('?') ? '&' : '?'}cb=${Date.now()}#autotest&desktop&mission=${MISSION}`;
  await S('Page.navigate', { url: bootUrl });

  // --- 2) 等世界就绪 ---
  // 在 **Node 侧**轮询, 不用页内长循环: CDP 单次 Runtime.evaluate 有 60s 上限,
  // 而关卡预热(建全部机型材质 + renderer.compile)经常超过 60s —— 页内等会直接超时。
  let ready = null;
  const tReady = Date.now();
  while (Date.now() - tReady < 300000) {
    ready = await ev(`(()=>{const e=window.__engine;return e ? {
      ready: !!e.missionReady, weather: e.weather, hasWeapons: !!e.weapons,
      hasFxBattle: !!e.fxBattle, stage: (window.__loadStage || null) } : null;})()`);
    if (ready && ready.ready) break;
    await sleep(2000);
  }
  console.log(`[ready] ${JSON.stringify(ready)}  用时 ${((Date.now() - tReady) / 1000).toFixed(0)}s`);
  if (!ready?.ready) throw new Error('关卡没就绪(等 300s 仍未 missionReady)');
  if (!ready.hasWeapons) throw new Error('拿不到 engine.weapons —— 无法在指定位置触发爆炸');
  if (!ready.hasFxBattle) {
    console.warn('[warn] engine.fxBattle 为空 —— 新式图集没启用(fx-tune 没槽位?), ' +
      'baked 组会退化成原生, A/B 会看起来一样');
  }
  await sleep(1500);   // 让首帧稳定下来再摆相机

  // --- 3) 钉视点 + 算出固定的爆炸世界坐标 ---
  // Vector3 从现场取, 免得依赖全局 THREE
  const setup = await ev(`(()=>{
    const e = window.__engine;
    const V = e.camera.camera.position.constructor;         // THREE.Vector3
    const cam = e.camera.camera;
    // 找一个前方地面点: 用相机朝向在水平面上投 700m
    const fwd = new V(); cam.getWorldDirection(fwd); fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0,0,-1);
    fwd.normalize();
    // ★ 爆点必须按**剔除用的那套相机**来投: spawnExplosion 的视锥剔除用的是
    //   weapons.lodCameraPos / lodCamForward(65° 半角), 而它**跟着玩家走**; 我一旦
    //   冻结画面相机、玩家继续飞, 两者就分家了 —— 实测 dot 只有 0.26~0.39(≈70°),
    //   爆炸被静默剔除, 画面上什么都没有。用 lod* 投点, dot 天然 = 1。
    //
    //   另外: AGL 12m 的地面爆点在 2000m 高空平飞的视野里本来就不成立(近乎正下方),
    //   地面档的视觉验证需要俯冲/低空 —— 那属于另一个游戏状态, 不在这条 A/B 里硬凑。
    const w = e.weapons;
    const lodPos = w.lodCameraPos, lodFwd = w.lodCamForward;
    const V2 = e.camera.camera.position.constructor;
    let px, pz;
    if (lodPos && lodFwd) {
      const p = lodPos.clone().addScaledVector(lodFwd, 600);
      px = p.x; pz = p.z;
    } else {
      const pf = new V2(); pf.copy(e.playerForward); pf.y = 0;
      if (pf.lengthSq() < 1e-6) pf.set(0, 0, -1);
      pf.normalize();
      px = e.player.position.x + pf.x * 420; pz = e.player.position.z + pf.z * 420;
    }
    const hFn = e._terrainHeightFn;
    const h = (typeof hFn === 'function') ? hFn.call(e, px, pz) : 0;
    ${FOLLOW ? '' : "if (typeof window.__freezeCam === 'function') window.__freezeCam(true);"}
    cam.updateMatrixWorld(true);
    window.__fxAb = { V: V, px: px, pz: pz, h: h };
    return { origin: [px, h, pz], camY: +cam.position.y.toFixed(0),
             playerY: +e.player.position.y.toFixed(0), freezeCam: typeof window.__freezeCam };
  })()`);
  console.log('[setup]', JSON.stringify(setup));

  mkdirSync(OUT, { recursive: true });
  const report = { url, mission: MISSION, times: TIMES, scales: SCALES, setup, runs: {} };

  // 爆点: 一律取"剔除相机的前方 600m" —— 这样必然落在 spawnExplosion 的视锥内
  // (它用的是 weapons.lodCameraPos/lodCamForward, 65° 半角)。
  //
  // --direct: 直接调 fxBattle.tryPlay 播指定槽位, 绕开 AGL 归类。
  //   为什么需要它: "离地 12m 的地面爆炸"在 2000m 高空平飞的视野里几何上不可能成立
  //   (近乎正下方, 必被剔除)。直连 tryPlay 播的仍是游戏用的**同一个资产**,
  //   所以拿它验证"一次只画一发"的观感是等价的。
  const spawnExpr = (kind, scale) => `(()=>{
    const e = window.__engine, A = window.__fxAb, V = A.V;
    const w = e.weapons;
    const pos = w.lodCameraPos.clone().addScaledVector(w.lodCamForward, ${SPAWN_DIST});
    pos.y += ${SPAWN_UP};
    ${DIRECT
      ? `e.fxBattle.tryPlay('${kind}', pos, ${scale});`
      : `const y = (${kind === 'air' ? 'pos.y' : 'A.h + 12'});
    const p2 = new V(pos.x, y, pos.z);
    e.weapons.spawnExplosion(p2, ${scale}, 1, 1);
    pos.copy(p2);`}
    return { agl: +(pos.y - A.h).toFixed(1), direct: ${DIRECT},
             distPlayer: +pos.distanceTo(e.player.position).toFixed(0) };
  })()`;

  // --- 4) 两组: 新式图集 / 原生逃生阀 ---
  for (const mode of ['baked', 'legacy']) {
    const dir = join(OUT, mode);
    mkdirSync(dir, { recursive: true });
    // legacy 走引擎里那个逃生阀(spawnFxReplacement 会直接返回 false → 全部原生)
    await ev(`(()=>{ window.__engine.fxLegacyMode = ${mode === 'legacy'}; return window.__engine.fxLegacyMode; })()`);
    report.runs[mode] = {};
    for (const kind of CASES) {
      for (const scale of SCALES) {
        const agl = await ev(spawnExpr(kind, scale, 0));
        const t0 = Date.now();
        const shots = [];
        for (const t of TIMES) {
          const wait = t * 1000 - (Date.now() - t0);
          if (wait > 0) await sleep(wait);
          const name = `${kind}-s${scale}-t${String(t).replace('.', 'p')}.png`;
          await shot(join(dir, name));
          shots.push(name);
        }
        report.runs[mode][`${kind}-s${scale}`] = { agl, shots };
        console.log(`[shot] ${mode} ${kind} scale=${scale} AGL=${typeof agl === 'number' ? agl.toFixed(1) : agl}m → ${shots.length} 张`);
        await sleep(600);   // 让上一发彻底播完再开下一发
      }
    }
  }

  // --- 5) 门禁 ---
  const errs = await ev(`({ gl: (window.__glErrors||[]).slice(), js: (window.__jsErrors||[]).slice(),
                              glN: (window.__glErrors||[]).length, jsN: (window.__jsErrors||[]).length })`);
  report.errors = errs;
  // ① 画面自检。三条判据, 缺一不可:
  //    a. 亮度在合理区间(既不是黑屏也不是洗白)
  //    b. 画面必须有**结构**(标准差太低 = 一片糊, 场景没渲染出来)
  //    c. **同一批时间点的帧必须互相不同** —— 特效在动就该变。
  //       这条最关键: 有一次 GPU 被别的渲染占满, WebGL 整个没画出来(只剩 HUD,
  //       画面一片洗白), 而旧的两条阈值(均值/极端像素比例)全都放它过了。
  //       "两个时间点像素完全一样"对 A/B 探针来说一定是故障, 没有例外。
  const { default: sharp } = await import('sharp');
  const bad = [];
  const readRaw = async (p) => (await sharp(p).raw().toBuffer({ resolveWithObject: true }));
  for (const mode of ['baked', 'legacy']) {
    for (const [key, info] of Object.entries(report.runs[mode] || {})) {
      const stats = [];
      for (const name of info.shots) {
        const p = join(OUT, mode, name);
        const { data, info: im } = await readRaw(p);
        const n = im.width * im.height;
        let sum = 0, extreme = 0, sum2 = 0;
        for (let i = 0; i < n; i++) {
          const m = (data[i * 3] + data[i * 3 + 1] + data[i * 3 + 2]) / 3;
          sum += m; sum2 += m * m;
          if (m > 240 || m < 4) extreme++;
        }
        const mean = sum / n;
        const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
        stats.push({ name, mean, std, data });
        info[name] = { mean: +mean.toFixed(1), std: +std.toFixed(1), extremePct: +(100 * extreme / n).toFixed(1) };
        if (mean < 12 || mean > 235) bad.push(`${mode}/${name} 亮度异常 mean=${mean.toFixed(1)}(洗白或黑屏)`);
        else if (std < 12) bad.push(`${mode}/${name} 画面没有结构 std=${std.toFixed(1)}(场景没渲染出来)`);
      }
      // 逐对比较相邻时间点
      for (let i = 1; i < stats.length; i++) {
        const a = stats[i - 1].data, b = stats[i].data;
        let d = 0;
        for (let k = 0; k < a.length; k++) d += Math.abs(a[k] - b[k]);
        const mad = d / a.length;
        info[`${key}::diff${i}`] = +mad.toFixed(3);
        if (mad < 1.0) {
          bad.push(`${mode}/${key}: ${stats[i - 1].name} 与 ${stats[i].name} 像素几乎相同(Δ=${mad.toFixed(2)})` +
            ` —— 特效根本没在动 / 场景没渲染`);
        }
      }
    }
  }
  // ② 控制台错误。三条 VALIDATE_STATUS 且 **Program Info Log 为空** 的算噪声:
  //    真正的着色器编译失败一定会带日志, 空日志是驱动在资源紧张时的校验抖动
  //    (同一份代码重跑常常就没有)。真失败由 ① 的截图自检兜住。
  const isNoise = (s) => /VALIDATE_STATUS false/.test(s) && /Program Info Log:\s*(\n|$)/.test(s);
  const realGl = (errs.gl || []).filter((s) => !isNoise(s));
  const realJs = (errs.js || []).filter((s) => !/THREE\.WebGLProgram/.test(s));
  report.renderCheck = { badFrames: bad, glNoise: (errs.glN || 0) - realGl.length };
  writeFileSync(join(OUT, 'ab.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`[errors] gl=${errs.glN}(其中校验噪声 ${report.renderCheck.glNoise}) js=${errs.jsN}`);
  if (bad.length) throw new Error(`渲染自检不过(${bad.length} 帧):\n  - ` + bad.slice(0, 4).join('\n  - '));
  if (realGl.length || realJs.length) {
    throw new Error(`真实 GL/JS 错误(gl=${realGl.length} js=${realJs.length}): ${realGl[0] || realJs[0]}`);
  }
  ok = true;
  console.log(`[done] 产物 → ${OUT}(渲染自检通过)`);
} catch (e) {
  console.error('A/B 失败:', e.message);
} finally {
  try { child.kill(); } catch {}
  try { rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
}
process.exit(ok ? 0 : 1);
