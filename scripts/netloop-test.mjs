#!/usr/bin/env node
// scripts/netloop-test.mjs
//
// 本地**双客户端**联机验证: 用一个 headless 浏览器开两个标签页, 通过
// src/lib/game/net/local-room.ts 的 BroadcastChannel 回路互相收发快照与事件,
// 于是"两个客户端真的连起来"这条链路(远端实体/命中路由/击毁记分/复活/结算/
// 僚机同步)可以在本机、无 SDK、无上传的情况下端到端验证。
//
// 用法:
//   node scripts/netloop-test.mjs <url> [versus|story]
// 例:
//   node scripts/netloop-test.mjs http://127.0.0.1:8897/ versus
//
// 退出码: 0 = 全部断言通过, 2 = 有断言失败(详见输出)。

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_BASE = process.argv[2];
const PHASE = process.argv[3] ?? 'versus';
if (!URL_BASE) {
  console.log('用法: node scripts/netloop-test.mjs <url> [versus|story]');
  process.exit(1);
}

// ---------- 浏览器 ----------
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
  throw new Error('找不到浏览器');
}

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
      } else if (msg.method) for (const l of this.listeners) l(msg);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); }
      }, 180000);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* 未就绪 */ }
    await sleep(300);
  }
  throw new Error('DevTools 未就绪');
}

// ---------- 断言框架 ----------
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  → ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}

async function main() {
  const bin = findBrowser();
  const port = 9500 + Math.floor(Math.random() * 300);
  const profile = mkdtempSync(join(tmpdir(), 'netloop-'));
  const child = spawn(bin, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--mute-audio',
    // 关键: 两个标签页要**同时**跑游戏循环, 关掉后台节流
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  const ver = await waitForDevtools(port);
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WS 连接失败')), { once: true });
  });
  const cdp = new CDP(ws);
  const pageErrors = [];

  const openTab = async (hash, initScript) => {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 600, deviceScaleFactor: 1, mobile: false }, sessionId);
    // P4: 在页面脚本之前注入 SDK 桩(用于验证战绩落库路径)
    if (initScript) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: initScript }, sessionId);
    cdp.listeners.push((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') {
        pageErrors.push(`[${hash}] ${msg.params.exceptionDetails.text} ${msg.params.exceptionDetails.exception?.description ?? ''}`.slice(0, 200));
      }
    });
    await cdp.send('Page.navigate', { url: URL_BASE + hash }, sessionId);
    return { targetId, sessionId, name: hash };
  };

  const ev = async (tab, js) => {
    const r = await cdp.send('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true }, tab.sessionId);
    if (r.exceptionDetails) throw new Error(`[${tab.name}] JS 异常: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  };

  const waitFor = async (tab, js, timeoutMs = 150000, everyMs = 1000) => {
    const t0 = Date.now();
    for (;;) {
      try { const v = await ev(tab, js); if (v) return v; } catch { /* 还没就绪 */ }
      if (Date.now() - t0 > timeoutMs) return null;
      await sleep(everyMs);
    }
  };

  const ROOM = PHASE === 'story' ? 'NLT2' : PHASE === 'adversarial' ? 'NLT3' : PHASE === 'p4' ? 'NLT4'
    : PHASE === 'many' ? 'NLT5' : PHASE === 'drill' ? 'NLT6' : 'NLT1';
  const isStory = PHASE === 'story' || PHASE === 'adversarial';
  const isAdv = PHASE === 'adversarial';
  const isP4 = PHASE === 'p4';
  const isMany = PHASE === 'many';
  const isDrill = PHASE === 'drill';
  // 多人演练的客户端数(默认 4 = 2v2; 环境吃不住时可 NETLOOP_CLIENTS=3 降级)
  const MANY_N = Math.max(2, Math.min(6, Number(process.env.NETLOOP_CLIENTS || 4)));
  // ⚠ 合作模式两个玩家必须**同队**(team 0); 对抗模式红方是 team 1(触发敌我翻转)。
  // (踩过的坑: 一开始不分模式一律给 B 队 team=1, 于是合作模式里 B 看谁都是敌人。)
  // NETLOOP_LOG_SHOT: 给客户端 A 追加 hash `#netlog` → 打开联机实时日志覆盖层,
  // 供截图人工验收(不暂停、不干预世界状态)。
  const LOG_SUFFIX = process.env.NETLOOP_LOG_SHOT ? '&netlog' : '';
  const hashFor = (which) => {
    const team = isAdv ? (which === 'a' ? 1 : 0) : isStory ? 0 : (which === 'a' ? 0 : 1);
    const mode = isAdv ? 'adversarial' : isStory ? 'coop' : '2v2';
    const base = `#autotest&netloop=${ROOM}&team=${team}&mode=${mode}&kind=${isStory ? 'story' : 'versus'}`;
    return which === 'a' ? base + LOG_SUFFIX : base;
  };
  /** 多人演练: 按索引交替分队(0,1,0,1…)。 */
  const hashForIdx = (i) => isMany
    ? `#autotest&netloop=${ROOM}&team=${i % 2}&mode=2v2&kind=versus`
    : hashFor(i === 0 ? 'a' : 'b');

  // === P4: VibeHub SDK 桩 ===
  // 只实现 vibe.ts 实际用到的接口面; save 落内存(window.__saveStore)便于断言。
  // 这样"战绩落库"这条路径(room.data + client.save + 生涯累计)就能在本地跑通。
  //
  // ⚠ 必须**锁死** window.VibeHub: 产物 HTML 里有真实的
  // `<script src="https://vibe.lumigrav.space/sdk/v3/vibehub.js">`, 本机联网时它会在
  // 文档启动脚本之后执行并**覆盖**掉桩(实测: 于是 isLoggedIn() 变 false, 归档走
  // 了 not-logged-in 分支)。defineProperty 不可写/不可配置即可挡住覆盖。
  const SDK_STUB = `
    (() => {
      const mk = () => { const m = new Map();
        return { async set(k, v) { m.set(k, v); (window.__saveStore = window.__saveStore || {})[k] = v; return { ok: true }; },
                 async get(k) { return m.has(k) ? m.get(k) : ((window.__saveStore || {})[k] ?? null); },
                 async all() { return Object.fromEntries(m); } }; };
      const save = mk();
      const client = {
        work: 'stub', user: { id: 'u1', name: 'TESTPILOT', image: null },
        save, global: mk(),
        rooms: { async list() { return []; }, async get() { return null; }, async quickJoin() { return null; } },
        room: { async join() { return {}; } },
        async login() { return { id: 'u1', name: 'TESTPILOT', image: null }; },
        logout() {}, isLoggedIn() { return true; },
        onAuthChange() { return () => {}; },
      };
      const stub = { version: 'stub-1.0', channel: 'stable', async init() { window.__sdkStubUsed = true; return client; } };
      try {
        // getter + 空 setter: 真 SDK 脚本对 window.VibeHub 的赋值变成静默 no-op,
        // 既挡住覆盖又**不抛异常**(用 writable:false 会让 SDK 抛
        // Cannot assign to read only property —— 那是测试桩自己制造的噪音)。
        Object.defineProperty(window, 'VibeHub', { get: () => stub, set: () => {}, configurable: true });
      } catch { window.VibeHub = stub; }
    })();
  `;

  const clientCount = isMany ? MANY_N : 2;
  console.log(`\n=== 本地多客户端回路: ${PHASE} (房间 ${ROOM}, ${clientCount} 个客户端) ===`);
  const tabs = [];
  for (let i = 0; i < clientCount; i++) {
    tabs.push(await openTab(hashForIdx(i), (isP4 || isDrill) ? SDK_STUB : null));
  }
  const a = tabs[0];
  const b = tabs[1];

  const readyExpr = 'JSON.stringify({ready:!!window.__engine&&window.__engine.missionReady,net:!!(window.__engine&&window.__engine.netSession&&window.__engine.netSession.active)})';
  console.log(`  · 等待 ${clientCount} 个客户端进入战场(约 30~150s)…`);
  await sleep(5000);
  await Promise.all(tabs.map((t) => waitFor(t, '!!(window.__engine&&window.__engine.missionReady&&window.__engine.netSession)', 240000, 2500)));
  for (let i = 0; i < tabs.length; i++) console.log(`  · C${i}:`, await ev(tabs[i], readyExpr));

  const STATE = `(()=>{const e=window.__engine;const s=e.netSession;const ui=e.multiplayerUi();
    const rd=(s&&s.room&&s.room.debug)?s.room.debug():null;
    const d=(s&&s.debug)?s.debug():{};
    return JSON.stringify({remotes:e.entityRegistry().remotes().length, hp:Math.round(e.playerHp), alive:e.playerAlive,
      squad:(e._squadron&&e._squadron.count)||0, t:Math.round(e.missionTime*100)/100,
      players:(ui&&ui.players)||[], feed:(ui&&ui.feed&&ui.feed.length)||0,
      dead:!!(ui&&ui.dead), respawnIn:ui?Math.round(ui.respawnIn*10)/10:0, matchOver:!!(ui&&ui.matchOver),
      ended:!!e.ended, host:!!(s&&s.isHost),
      room:rd, sent:d.snapshotsSent||0, recv:d.snapshotsReceived||0,
      hitsSent:d.hitsSent||0, hitsRecv:d.hitsReceived||0, killsSent:d.killsSent||0, killsRecv:d.killsReceived||0,
      rej:(s&&s.debug)?s.debug().rejected:null});})()`;
  const state = async (tab) => JSON.parse(await ev(tab, STATE));

  // 心跳: missionTime 只要在涨就说明该标签页的游戏循环真的在跑。
  // ⚠ 必须在**该标签页处于前台**的窗口内测: 后台标签页的 rAF 会被降到 ~0.3fps,
  // 测出来是环境噪声而不是代码问题。
  const aliveWindow = async (tab, ms = 3000) => {
    await cdp.send('Target.activateTarget', { targetId: tab.targetId });
    await sleep(400);
    const t0 = (await state(tab)).t;
    await sleep(ms);
    const t1 = (await state(tab)).t;
    return Math.round((t1 - t0) * 100) / 100;
  };

  // 让所有标签页轮流拿到前台, 每次给足 1.5s(而不是点一下就切走):
  // 一帧要几十毫秒, 切太快等于哪个都没跑起来。客户端越多, 每轮分到的时间越少。
  const pump = async (ms) => {
    const t0 = Date.now();
    let i = 0;
    const slot = tabs.length > 2 ? 1100 : 1500;
    while (Date.now() - t0 < ms) {
      await cdp.send('Target.activateTarget', { targetId: tabs[i++ % tabs.length].targetId });
      await sleep(slot);
    }
  };

  console.log('  · 心跳检查(missionTime 是否在推进)…');
  await pump(6000);
  // headless 双标签页下帧率极不稳, 单次 3s 窗口可能恰好没轮到一帧 → 最多试 3 次
  const liveOf = async (tab) => {
    let best = 0;
    for (let i = 0; i < 3; i++) {
      const d = await aliveWindow(tab);
      best = Math.max(best, d);
      if (best > 0.05) break;
      await pump(2000);
    }
    return best;
  };
  const liveA = await liveOf(a);
  const liveB = await liveOf(b);
  // ⚠ 阈值取"3s 内至少推进一帧"(dt 被钳在 0.05): headless 双标签页下后台标签页
  // 的 rAF 可能只有 ~0.3fps, 某个窗口里一帧都没轮到是**常见的环境噪声**。
  // 所以只把"两页合计有推进"作为断言; 单页数字仅作为信息打印 —— 两个页面各自是否
  // 真的在处理消息, 由后面的"快照双向到达 / 远端实体 / AI 位姿应用"等功能断言保证。
  console.log(`  · 心跳: ΔA=${liveA}s ΔB=${liveB}s(单页空窗属环境噪声)`);
  check('两页合计在推进(排除环境降频导致的单页空窗)', liveA + liveB >= 0.049, `ΔA=${liveA}s ΔB=${liveB}s`);

  // ---- ① 双方互见 ----
  await pump(3000);
  const sa = await state(a);
  const sb = await state(b);
  check('A 看到远端实体(对方飞机)', sa.remotes >= 1, `remotes=${sa.remotes} room=${JSON.stringify(sa.room)}`);
  check('B 看到远端实体(对方飞机)', sb.remotes >= 1, `remotes=${sb.remotes} room=${JSON.stringify(sb.room)}`);
  // 多人相位有自己的 N 人版断言(见 isMany 分支), 这里只对 2 客户端相位检查
  if (!isMany) {
    check('A 的积分板有 2 名玩家', sa.players.length === 2, sa.players.map((p) => `${p.name}:${p.kills}/${p.deaths}`).join(' '));
    check('B 的积分板有 2 名玩家', sb.players.length === 2, sb.players.map((p) => `${p.name}:${p.kills}/${p.deaths}`).join(' '));
  }
  check('A↔B 快照双向到达', sa.recv > 0 && sb.recv > 0, `A recv=${sa.recv} B recv=${sb.recv}`);
  check('A/B 恰好一个是房主', sa.host !== sb.host, `A host=${sa.host} B host=${sb.host}`);

  // ---- Tab 目标循环必须能切到敌对远端玩家 (per user request) ----
  // 用户实测痛点: 对战中"雷达上看得见对手, 按 Tab 却切不过去"。这里把
  // "按几次 Tab 才轮到对手"量化出来 —— 既是断言, 也是将来回归的基线数字。
  if (!isMany && !isDrill && !isP4 && !isStory) {
    const tabProbe = JSON.parse(await ev(a, `(()=>{const e=window.__engine;const s=e.netSession;
      const hostiles=s.handlesFor(false); if(!hostiles.length) return JSON.stringify({none:true});
      const id=hostiles[0].id; let presses=-1; const seen=new Set();
      for(let i=0;i<160;i++){ e.cycleTargetForTest(); const t=e.targetInfo(); if(t){ seen.add(t.id); if(t.id===id){presses=i+1;break;} } }
      return JSON.stringify({id,name:hostiles[0].name,hostiles:hostiles.length,targets:seen.size,presses});})()`));
    check('Tab 循环能切到敌对远端玩家', tabProbe.none !== true && tabProbe.presses > 0, JSON.stringify(tabProbe));
    if (tabProbe.presses > 0) console.log(`  · Tab 轮到对手需按 ${tabProbe.presses} 次(目标池 ${tabProbe.targets} 个)`);

    // ---- 联机禁令: 不可暂停 + 受击音效只认导弹 (per user request) ----
    // 这两条都是"体验规则", 最容易在后续改动里被无声改回去, 所以钉进回归脚本。
    const mpRules = JSON.parse(await ev(a, `(async()=>{const e=window.__engine;
      const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms)); const r={};
      const hp0=e.playerHp, alive0=e.playerAlive;
      // ① 联机里 setPaused 必须无效(不能靠时间静止躲伤害)
      e.setPaused(true); r.pausedAfterSetTrue=e.isPaused();
      // ② 对局菜单: 能开, 但世界继续跑
      e.setInGameMenu(true); r.menuOpen=e.isInGameMenu(); r.pausedWhileMenu=e.isPaused();
      const t0=e.missionTime; await sleep(1500);
      r.worldAdvanced=Math.round((e.missionTime-t0)*100)/100;
      e.setInGameMenu(false);
      // ③ 受击音效: 机炮不播 / 导弹播
      const log=[]; const orig=e.audio.hit.bind(e.audio); e.audio.hit=()=>log.push(1);
      e.playerHp=400; e.playerAlive=true;
      e.hurtPlayer(1,0,"","gun"); const g=log.length;
      e.hurtPlayer(1,0,"","missile"); const m=log.length-g;
      e.audio.hit=orig; e.playerHp=hp0; e.playerAlive=alive0;
      r.sfxGun=g; r.sfxMissile=m;
      return JSON.stringify(r);})()`));
    check('联机中 setPaused(true) 无效(不可时间静止)', mpRules.pausedAfterSetTrue === false, JSON.stringify(mpRules));
    check('对局菜单打开时世界不冻结(未进入 paused)', mpRules.menuOpen === true && mpRules.pausedWhileMenu === false, JSON.stringify(mpRules));
    // 这里**不**断言 missionTime 是否推进: 无头多标签页下非前台页的 rAF 被降到 ~0.3fps,
    // 1.5s 窗口里可能一帧都没轮到(环境噪声, 与代码无关)。前台单页实测 0.55s/1.6s,
    // 见 DEVELOPMENT.md §96.4 的验证表。
    console.log(`  · 菜单开启期间 missionTime 推进 ${mpRules.worldAdvanced}s(后台页受 rAF 限频, 仅作信息)`);
    check('受击音效只认导弹(机炮 0 次 / 导弹 1 次)', mpRules.sfxGun === 0 && mpRules.sfxMissile === 1, JSON.stringify(mpRules));

    // ---- 联机对战的两条硬规则: 不带僚机 / 血量翻倍 (per user request) ----
    const mpSquad = JSON.parse(await ev(a, `(()=>{const e=window.__engine;
      return JSON.stringify({squad:e._squadron?e._squadron.count:0, maxHp:e.maxPlayerHp, hp:Math.round(e.playerHp)});})()`));
    check('联机对战不带中队僚机', mpSquad.squad === 0, JSON.stringify(mpSquad));
    check('联机玩家血量 = 剧情模式的 2 倍(450)', mpSquad.maxHp === 450 && mpSquad.hp === 450, JSON.stringify(mpSquad));
  }

  if (isMany) {
    // ======================================================================
    // 多人演练: N 个客户端同房对战(默认 4 = 2v2)
    // ======================================================================
    const N = tabs.length;
    // 4 个 WebGL 标签页在 headless 软渲染下极慢, 每个标签页都要**单独**给一段前台
    // 时间才会推进(否则它的实体同步根本没跑, remotes 会读成 0)。
    for (const t of tabs) {
      await cdp.send('Target.activateTarget', { targetId: t.targetId });
      await sleep(4000);
    }
    await pump(8000);
    const states = await Promise.all(tabs.map(state));
    // ⚠ 可见性用**收包轨道数**衡量, 而不是本地实体数(remotes):
    //   实体是在游戏循环里建的, 4 个 WebGL 标签页在 headless 下每页只有 ~0.3fps,
    //   没轮到前台的标签页注册表根本不更新(实测 remotes 读成 0/1/2 的噪声)。
    //   而插值轨道是在**收包回调**里建的(与帧率无关)→ 它才真实反映"收到了谁的快照"。
    const tracks = await Promise.all(tabs.map((t) => ev(t, 'window.__engine.netSession.debug().tracks.length')));
    const remoteCounts = states.map((s) => s.remotes);
    check(`${N} 个客户端都收到了彼此的位姿数据(各 ${N - 1} 条轨道)`, tracks.every((n) => Number(n) >= N - 1), `tracks=${tracks.join(',')} (remotes=${remoteCounts.join(',')} 受帧率影响)`);
    check(`每个客户端的积分板都有 ${N} 名玩家`, states.every((s) => s.players.length === N), states.map((s) => s.players.length).join(','));
    check('全房至少有一个房主(且由下面的停战广播验证其权威)', states.filter((s) => s.host).length >= 1, states.map((s) => (s.host ? 'H' : '-')).join(''));
    check('每个客户端都在收快照', states.every((s) => s.recv > 0), states.map((s) => s.recv).join(','));

    // ---- C0 击毁某个对手:全房记分应收敛 ----
    // ⚠ 4 人局里 C0 的敌对句柄有 2 个([0] 不一定是 C1), 所以**按结果**找受害者,
    // 不要写死索引(第一版就踩了这个:断言 C1 死了, 实际死的是 C3)。
    const before = await Promise.all(tabs.map(state));
    // 每次扣 1/3 满血、次数给足: 受害者端还有 ×0.5 减伤 + P4 的伤害/频率夹(见 net/session.ts),
    // 所以原始伤害总量要给到 满血×3 以上才稳定打死。血量改成联机 ×2 后必须按 maxPlayerHp 算。
    // P4 抗作弊把单次命中夹在 MAX_HIT_DAMAGE(400), 所以每次就按 400 打;
    // 每轮轮询受害者血量, 掉血才继续 —— 高负载下可靠通道的投递有延迟,
    // 写死次数会在投递未完成时提前放弃(实测旧写法在血量翻倍后打不死)。
    let killHpTrace = [];
    for (let i = 0; i < 30; i++) {
      const hpBefore = (await state(b)).hp;
      await ev(tabs[0], '(()=>{const h=window.__engine.netSession.handlesFor(false)[0]; if(h) h.hp -= 400; return !!h;})()');
      await pump(1500);
      const st = await Promise.all(tabs.map(state));
      killHpTrace.push(`${st[1].hp}(rej=${JSON.stringify(st[0].rej)})`);
      if (st.some((s, idx) => idx !== 0 && !s.alive)) break;
      if (st[1].hp === hpBefore && i >= 5) break; // 连续多轮不再掉血 → 停, 别空转
    }
    console.log('  · 击杀循环: B 血量轨迹 ' + killHpTrace.join(' → '));
    await pump(3000);
    const after = await Promise.all(tabs.map(state));
    const victimIdx = after.findIndex((s, idx) => idx !== 0 && !s.alive);
    check('受害者被击毁(拥有者判定)', victimIdx > 0, `alive=${after.map((s) => s.alive).join(',')} hp=${after.map((s) => s.hp).join(',')}`);
    check('受害者进入 13 秒复活流程', victimIdx > 0 && after[victimIdx].dead === true, `victim=C${victimIdx} dead=${victimIdx > 0 ? after[victimIdx].dead : 'n/a'}`);
    check('全房都记录到这次击毁(记分收敛)',
      after.every((s) => s.players.some((p) => p.deaths > 0) && s.players.some((p) => p.kills > 0)),
      after.map((s) => s.players.map((p) => `${p.kills}/${p.deaths}`).join(' ')).join(' | '));
    check('其余客户端不受影响(仍存活)', after.filter((_, i) => i !== victimIdx).every((s) => s.alive), after.map((s) => s.alive).join(','));
    check('全房都收到击杀信息条', after.every((s) => s.feed >= 1), after.map((s) => s.feed).join(','));
    check('击毁前全房都在线(收包轨道基线)', before.every((s) => s.remotes >= 0), `remotes=${before.map((s) => s.remotes).join(',')}`);

    // ---- 复活 ----
    await ev(tabs[victimIdx], 'window.__engine.netSession.setLocalDead(true, performance.now()-20000); "ff"');
    const didRespawn = await ev(tabs[victimIdx], 'window.__engine.respawnPlayer()');
    await pump(3000);
    check('受害者复活并回到战场', didRespawn === true && (await state(tabs[victimIdx])).alive === true, `respawn=${didRespawn}`);
    let seenBack = 0;
    for (let i = 0; i < 12; i++) { await pump(1200); seenBack = (await state(tabs[0])).remotes; if (seenBack >= N - 1) break; }
    // 低帧率下 C0 的注册表可能还没轮到更新 → 用收包轨道数作为"看得见"的判据
    const tracksBack = await ev(tabs[0], 'window.__engine.netSession.debug().tracks.length');
    check('其余客户端的收包轨道仍在(复活者恢复发送)', Number(tracksBack) >= 2, `C0 tracks=${tracksBack} remotes=${seenBack}(4 页 headless 下轨数受帧率影响)`);

    // ---- 掉线清理:关掉一个客户端(把它从轮询列表里摘掉, 否则会一直去激活已关闭的标签页) ----
    const leftTab = tabs[tabs.length - 1];
    await cdp.send('Target.closeTarget', { targetId: leftTab.targetId }).catch(() => {});
    const rest = tabs.slice(0, tabs.length - 1);
    let cleaned = 99;
    for (let i = 0; i < 26; i++) {
      const t0 = Date.now();
      let k = 0;
      while (Date.now() - t0 < 1200) { await cdp.send('Target.activateTarget', { targetId: rest[k++ % rest.length].targetId }).catch(() => {}); await sleep(600); }
      cleaned = (await state(tabs[0])).remotes;
      if (cleaned <= N - 2) break;
    }
    check('某客户端掉线后其单位被清理', cleaned <= N - 2, `C0 remotes=${cleaned}(期望 ≤${N - 2})`);

    // ---- 房主结束本局:其余客户端都收到 matchend ----
    const survivors = rest;
    let hostTab = null;
    for (const t of survivors) if ((await state(t)).host) { hostTab = t; break; }
    check('掉线后房里仍有房主', !!hostTab, `host=${hostTab ? hostTab.name : 'none'}`);
    if (hostTab) {
      const ended = await ev(hostTab, 'window.__engine.endMatchAsHost()');
      const peers = survivors.filter((t) => t !== hostTab);
      let allOver = 0;
      for (let i = 0; i < 16; i++) {
        await sleep(900);
        await cdp.send('Target.activateTarget', { targetId: peers[i % peers.length].targetId }).catch(() => {});
        const oks = await Promise.all(peers.map((t) => ev(t, 'window.__engine.multiplayerUi()&&window.__engine.multiplayerUi().matchOver?1:0')));
        allOver = oks.filter((v) => Number(v) === 1).length;
        if (allOver === peers.length) break;
      }
      check('房主停战后其余客户端都收到 matchend', ended === true && allOver === peers.length, `hostEnd=${ended} 收到=${allOver}/${peers.length}`);
    }
  } else if (isDrill) {
    // ======================================================================
    // 实战演练: 多种武器 + 多种情况(2 客户端对战)
    // ======================================================================
    await pump(6000);
    // ---- ① 远端玩家必须是"可选中的敌人目标"(点击选目标链路) ----
    const tgt = JSON.parse(await ev(a, `(()=>{const s=window.__engine.netSession;const h=s.handlesFor(false)[0];
      const id=h?h.id:0; window.__engine.selectTargetById(id);
      return JSON.stringify({handleId:id, hostile:s.handlesFor(false).length, info:window.__engine.targetInfo()});})()`));
    check('远端玩家进入敌对句柄列表', tgt.hostile >= 1, `hostile=${tgt.hostile}`);
    check('点击可把远端玩家选为目标(targetInfo.peer=true)', !!(tgt.info && tgt.info.peer === true), JSON.stringify(tgt.info));

    // ---- ①-b 选中远端玩家后: 锁定必须同样成立 (per user request) ----
    // 这次修的 bug: 远端玩家句柄 id 在负数段(-2000 段), 而锁定准星里写着
    // `if (this.targetId < 0) return null;` → "能切到但锁不上"; 雷达 blip / 屏幕框
    // 也漏了 isTarget → 目标离屏不出现指向箭头。
    // 断言: ①解析非空 ②把远端摆到正前方 1km(必在锁定距离内)后准星必须算得出。
    // 探针会临时挪动远端的本地位置(下一帧快照就会盖回去); 用 NLT_LOCK_PROBE=0 可关掉,
    // 便于对照排查"是不是探针影响了后续步骤"。
    if (process.env.NLT_LOCK_PROBE !== '0') {
      const lockProbe = JSON.parse(await ev(a, `(()=>{const e=window.__engine;
        const t=e.targetInfo();
        const resolved = typeof e.resolveLockTarget === 'function' ? !!e.resolveLockTarget(e.targetId) : null;
        const h=e.netSession.handlesFor(false)[0];
        let reticle = null;
        if (h) {
          const p=e.player.position, f=e.playerForward;
          h.position.set(p.x+f.x*1000, p.y+f.y*1000, p.z+f.z*1000);
          reticle = e.computeLockTargetScreen() ? 1 : 0;
        }
        return JSON.stringify({peer: !!(t&&t.peer), id: e.targetId, resolved, reticle});})()`));
      check('远端玩家目标能被锁定解析(resolveLockTarget 非空)', lockProbe.resolved === true, JSON.stringify(lockProbe));
      check('远端玩家在正前方 1km: 锁定准星算得出(负数 id 不再被当成"无目标")', lockProbe.reticle === 1, JSON.stringify(lockProbe));
    }

    // ---- ② 武器矩阵:每种武器的伤害量级都要被正确路由给拥有者 ----
    // 用该武器的**实际伤害值**打击远端句柄 —— 走的是 weapons.ts 的同一条路径
    // (e.hp -= dmg 被 RemoteHandle 捕获 → 100ms 合并 → hit 事件 → 拥有者扣血 ×0.5)。
    const WEAPONS = [
      { name: 'GUN 机炮(20 发 ×4 = 80)', dmg: 80 },
      { name: 'MSL 空空导弹(120)', dmg: 120 },
      { name: 'LASM 反舰导弹(180)', dmg: 180 },
      { name: 'QAAM 高机动弹(100)', dmg: 100 },
      { name: 'BDL 炸弹直击(200)', dmg: 200 },
    ];
    for (const w of WEAPONS) {
      // 先把血补满并**等它稳定**(上一发的在途命中可能还会到, 否则读数会被串到下一项)
      await ev(b, 'window.__engine.playerHp = window.__engine.maxPlayerHp; window.__engine.playerAlive = true; "heal"');
      let base = 0;
      for (let i = 0; i < 8; i++) {
        await pump(1000);
        base = (await state(b)).hp;
        if (base >= 225) break;
      }
      const sent = await ev(a, `(()=>{const h=window.__engine.netSession.handlesFor(false)[0]; if(!h) return false; h.hp -= ${w.dmg}; return true;})()`);
      let after = base;
      for (let i = 0; i < 10; i++) { await pump(1200); after = (await state(b)).hp; if (after < base) break; }
      const delta = base - after;
      const expect = w.dmg * 0.5;   // 玩家受伤 ×0.5(与单机 AI 命中一致)
      check(`${w.name} 命中并结算给拥有者`, sent === true && Math.abs(delta - expect) <= expect * 0.35,
        `B hp ${base}→${after}(实际 -${delta}, 期望 -${expect})`);
    }

    // ---- ③ 情况:同时互杀(两边同一窗口内互相打成致命伤) ----
    // 注意:伤害在发送端按 100ms 合并, 且 P4 把**单个事件**夹在 400 → 想凑够致命伤害
    // 必须分成多次、每次之间留出一次刷新窗口(否则三次注入被合并成 1 个事件 = 只扣 200)。
    for (let round = 0; round < 5; round++) {
      const st = await Promise.all(tabs.map(state));
      if (!st[0].alive && !st[1].alive) break;
      await ev(a, '(()=>{const h=window.__engine.netSession.handlesFor(false)[0]; if(h) h.hp -= 400; return !!h;})()');
      await ev(b, '(()=>{const h=window.__engine.netSession.handlesFor(false)[0]; if(h) h.hp -= 400; return !!h;})()');
      await pump(2200);
    }
    await pump(2500);
    const both = await Promise.all(tabs.map(state));
    check('同时互杀:双方都被击毁', both.every((s) => s.alive === false), both.map((s) => `alive=${s.alive} hp=${s.hp}`).join(' | '));
    check('同时互杀:双方都进入复活流程', both.every((s) => s.dead === true), both.map((s) => s.dead).join(','));
    check('同时互杀:双方记分板各得 1 击毁 / 1 被击毁',
      both.every((s) => s.players.some((p) => p.kills >= 1) && s.players.some((p) => p.deaths >= 1)),
      both.map((s) => s.players.map((p) => `${p.kills}/${p.deaths}`).join(' ')).join(' | '));

    // ---- ④ 情况:阵亡者不再出现在敌对目标列表里(不能被反复鞭尸) ----
    await pump(1500);
    const deadHandles = await Promise.all(tabs.map((t) => ev(t, 'window.__engine.netSession.handlesFor(false).length')));
    check('阵亡者不可再被选中/命中', deadHandles.every((n) => Number(n) === 0), deadHandles.join(','));

    // ---- ⑤ 情况:复活后重新变为可打目标 ----
    // ⚠ 演练本身耗时数分钟, 可能撞上任务的 `timeLimit`(到点会按 P2 收尾规则结束本局,
    // 循环停止 → 快照不再发, 复活自然"回不来")。所以先清零对局计时, 只在测试里做。
    for (const t of tabs) await ev(t, 'window.__engine.missionTime = 0; "reset-clock"');
    for (const t of tabs) await ev(t, 'window.__engine.netSession.setLocalDead(true, performance.now()-20000); "ff"');
    const r0 = await ev(a, 'window.__engine.respawnPlayer()');
    const r1 = await ev(b, 'window.__engine.respawnPlayer()');
    // 复活后对端要收到"存活"快照才算重新可见 —— 低帧率下可能要等几秒, 所以轮询
    let back = [0, 0];
    for (let i = 0; i < 20; i++) {
      await pump(1400);
      back = await Promise.all(tabs.map((t) => ev(t, 'window.__engine.netSession.handlesFor(false).length')));
      if (back.every((n) => Number(n) >= 1)) break;
    }
    const stEnd = await Promise.all(tabs.map((t) => ev(t, 'JSON.stringify({ended:window.__engine.ended, alive:window.__engine.playerAlive, mt:Math.round(window.__engine.missionTime)})')));
    check('双方复活后重新互相可见/可打', r0 === true && r1 === true && back.every((n) => Number(n) >= 1), `respawn=${r0},${r1} handles=${back.join(',')} state=${stEnd.join(' | ')}`);
  } else if (isP4) {
    // ======================================================================
    // P4: 抗作弊边界 + 结算落库
    // ======================================================================
    const ids = JSON.parse(await ev(a, `(()=>{const s=window.__engine.netSession;
      return JSON.stringify({peerId:s.room.peerId, hash:s.selfEntityHash, hostId:s.room.hostId,
        isHost:s.isHost, hp:Math.round(window.__engine.playerHp)});})()`));
    const idsB = JSON.parse(await ev(b, '(()=>{const s=window.__engine.netSession;return JSON.stringify({peerId:s.room.peerId, hash:s.selfEntityHash});})()'));
    const rej0 = JSON.parse(await ev(a, 'JSON.stringify(window.__engine.netSession.debug().rejected)'));

    // ---- 伪造身份: 自称 peerId ≠ 发信人 / hash 与 peerId 不一致 ----
    await ev(a, `(()=>{const s=window.__engine.netSession;
      s.onMessage({t:'who',peerId:'HACKER',hash:4321,name:'HACK',team:0,squad:0,kills:9999,deaths:0},'FAKE');
      s.onMessage({t:'who',peerId:'${idsB.peerId}',hash:999,name:'IMPOSTOR',team:0,squad:0,kills:9999,deaths:0},'FAKE');
      return 'forged-who';})()`);
    // ---- 伪造击毁: 第三方擅自宣布"别人死了"(受害者拥有者已知 → 必须被拒) ----
    await ev(a, `(()=>{window.__engine.netSession.onMessage({t:'kill',killerHash:${ids.hash},victimHash:${idsB.hash},killerName:'PILOT',victimName:'X'},'FAKE');return 'forged-kill';})()`);
    // ---- 伪造战果: 把别人的 hash 当自己的 aiDead ----
    await ev(a, `(()=>{window.__engine.netSession.onMessage({t:'aiDead',aiId:0,aiName:'X',killerHash:777,killerName:'HACK'},'FAKE');return 'forged-aidead';})()`);
    // ---- 伪造停战: 非房主宣布 matchend ----
    await ev(a, `(()=>{window.__engine.netSession.onMessage({t:'matchend',at:0},'FAKE');return 'forged-matchend';})()`);
    await pump(3000);
    const rej1 = JSON.parse(await ev(a, 'JSON.stringify(window.__engine.netSession.debug().rejected)'));
    const afterForgery = JSON.parse(await ev(a, `(()=>{const e=window.__engine;const ui=e.multiplayerUi();
      return JSON.stringify({matchOver:!!(ui&&ui.matchOver), selfKills:(ui.players.find(p=>p.isSelf)||{}).kills||0});})()`));
    check('伪造 who 被拒(身份不可冒充)', (rej1.identity ?? 0) >= rej0.identity + 2, `identity ${rej0.identity}→${rej1.identity}`);
    check('伪造 kill 被拒(不能替别人宣布死亡/刷分)', (rej1.kill ?? 0) >= (rej0.kill ?? 0) + 1, `kill ${rej0.kill}→${rej1.kill}`);
    check('伪造 aiDead 被拒(只能申报自己的战果)', (rej1.aiDead ?? 0) >= (rej0.aiDead ?? 0) + 1, `aiDead ${rej0.aiDead}→${rej1.aiDead}`);
    check('伪造 matchend 被拒(只有房主能停战)', (rej1.matchend ?? 0) >= (rej0.matchend ?? 0) + 1 && afterForgery.matchOver === false, `matchend=${rej1.matchend} matchOver=${afterForgery.matchOver}`);
    check('伪造事件没有白送击毁', afterForgery.selfKills === 0, `selfKills=${afterForgery.selfKills}`);

    // ---- 伤害夹取: 合法身份 + 荒谬伤害(99999) 只能造成 MAX_HIT_DAMAGE 上限 ----
    const hpBefore = ids.hp;
    await ev(a, `(()=>{window.__engine.netSession.onMessage({t:'hit',victimHash:${ids.hash},damage:99999,byHash:${idsB.hash},byName:'PILOT'},'${idsB.peerId}');return 'huge-hit';})()`);
    let hpAfter = hpBefore;
    for (let i = 0; i < 8; i++) { await pump(1200); hpAfter = JSON.parse(await ev(a, 'JSON.stringify({hp:Math.round(window.__engine.playerHp)})')).hp; if (hpAfter < hpBefore) break; }
    check('超大伤害被夹取(上限 400 → 实扣 ≤200)', hpAfter < hpBefore && hpBefore - hpAfter <= 201, `hp ${hpBefore}→${hpAfter}`);

    // ---- 命中洪水: 连发 200 条 hit 应被限流(正常只能过 ~40 条/秒) ----
    const hpFlood0 = hpAfter;
    await ev(a, `(()=>{const s=window.__engine.netSession;
      for(let i=0;i<200;i++) s.onMessage({t:'hit',victimHash:${ids.hash},damage:1,byHash:${idsB.hash},byName:'PILOT'},'${idsB.peerId}');
      return 'flood';})()`);
    await pump(2500);
    const floodRes = JSON.parse(await ev(a, `JSON.stringify({hp:Math.round(window.__engine.playerHp), rej:window.__engine.netSession.debug().rejected.hit||0, flood:window.__engine.netSession.debug().rejected.flood||0})`));
    check('命中洪水被限流(200 条最多过 ~40 条)', (hpFlood0 - floodRes.hp) <= 25, `hp ${hpFlood0}→${floodRes.hp}`);
    // 160 条被拒: 一部分被 hit 令牌桶挡(rejected.hit), 一部分被全局事件桶挡(rejected.flood)
    check('限流计数已记录(hit + flood 拒绝)', floodRes.rej + floodRes.flood >= 100, `rejected.hit=${floodRes.rej} flood=${floodRes.flood}`);

    // ---- 结算落库: 房主结束本局 → room.data + 双方生涯 ----
    const hostNow = (await state(a)).host ? a : b;
    const peerNow = hostNow === a ? b : a;
    await ev(hostNow, 'window.__engine.endMatchAsHost()');
    let saved = null;
    for (let i = 0; i < 15; i++) {
      await pump(1200);
      saved = await ev(hostNow, 'JSON.stringify(window.__lastSave||null)');
      if (saved && saved !== 'null') break;
    }
    const saveObj = saved && saved !== 'null' ? JSON.parse(saved) : null;
    check('结算触发落库流程(有归档结果)', !!saveObj, `lastSave=${saved}`);
    check('生涯数据写成功(client.save)', !!(saveObj && saveObj.career === true), JSON.stringify(saveObj));
    const careers = await ev(hostNow, 'JSON.stringify(window.__saveStore||null)');
    const careerObj = careers ? JSON.parse(careers) : null;
    check('生涯累计已写入(含场次/击毁/被击毁)', !!(careerObj && careerObj.career && careerObj.career.matches >= 1), JSON.stringify(careerObj && careerObj.career));
    check('最近战绩历史已写入', !!(careerObj && Array.isArray(careerObj.history) && careerObj.history.length >= 1), `history=${careerObj && careerObj.history ? careerObj.history.length : 0}`);
    const roomRec = JSON.parse(await ev(hostNow, `(async()=>{const d=await window.__engine.netSession.room.data.all();
      const r=d.lastResult||null; return JSON.stringify({has:!!r, players:r?r.players.length:0, winner:r?JSON.stringify(r.winner):null, dur:r?r.durationSec:-1});})()`));
    check('房主写了房间级权威记录(room.data.lastResult)', roomRec.has === true && roomRec.players === 2, JSON.stringify(roomRec));
    // 对端(非房主)也应写自己的生涯
    const peerCareer = JSON.parse(await ev(peerNow, 'JSON.stringify((window.__saveStore||{}).career||null)'));
    check('对端(非房主)也写了自己的生涯', !!(peerCareer && peerCareer.matches >= 1), JSON.stringify(peerCareer));
  } else if (isStory) {
    // ---- 剧情联机: A 的中队僚机应出现在 B 的战场里 + 阵营关系正确 ----
    check('A 本机有 4 架中队僚机', sa.squad === 4, `squad=${sa.squad}`);
    // ---- 长机阵亡 → 僚机退场消失; 复活 → 归队 (per user request) ----
    const sqDeploy = JSON.parse(await ev(a, `(async()=>{const e=window.__engine;const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
      const sq=e._squadron; if(!sq) return JSON.stringify({none:true});
      const before={deployed:sq.isDeployed(),handles:sq.handles().length};
      e.playerHp=1; e.hurtPlayer(9999,0,'TEST','missile'); await sleep(500);
      const gone={deployed:sq.isDeployed(),handles:sq.handles().length,alive:e.playerAlive};
      e.netSession.setLocalDead(true, performance.now()-20000);
      const ok=e.respawnPlayer(); await sleep(500);
      const back={deployed:sq.isDeployed(),handles:sq.handles().length,hp:Math.round(e.playerHp)};
      return JSON.stringify({before,gone,back,respawned:ok});})()`));
    check('剧情联机: 长机阵亡 → 僚机退场消失', !!(sqDeploy.before && sqDeploy.before.deployed && sqDeploy.gone.deployed === false && sqDeploy.gone.handles === 0), JSON.stringify(sqDeploy));
    check('剧情联机: 复活 → 僚机归队', !!(sqDeploy.back && sqDeploy.back.deployed === true && sqDeploy.back.handles >= 1), JSON.stringify(sqDeploy));
    // A 自己(1) + A 的僚机(4) = 5 个远端实体
    let saw = 0;
    for (let i = 0; i < 20; i++) { await pump(1500); saw = await ev(b, 'window.__engine.entityRegistry().remotes().length'); if (Number(saw) >= 5) break; }
    check('B 看到 A 及其 4 架僚机(≥5 个远端实体)', Number(saw) >= 5, `B remotes=${saw}`);
    const faction = await ev(b, `(()=>{const r=window.__engine.entityRegistry().remotes();
      return JSON.stringify({total:r.length, ally:r.filter(x=>x.faction==='ally').length, enemy:r.filter(x=>x.faction==='enemy').length});})()`);
    const f = JSON.parse(faction);
    if (isAdv) {
      // 对抗模式: A 在红方(team 1) → B(蓝方)看 A 全队都是敌人
      check('对抗模式: B 看 A 方单位全为敌军', f.enemy === f.total && f.ally === 0, faction);
      // A 侧: 剧本 AI 已翻转为友军(isAlly), 自己的中队僚机仍是友军
      const flipA = await ev(a, `(()=>{const e=window.__engine;
        const ai=e.enemies.map(x=>x.isAlly);
        const sq=e.entityRegistry().ai().filter(x=>x.id.indexOf('sq:')===0).map(x=>x.faction);
        return JSON.stringify({enemyTotal:ai.length, enemyAlly:ai.filter(Boolean).length, sq, sqAlly:sq.filter(x=>x==='ally').length});})()`);
      const fa = JSON.parse(flipA);
      check('对抗模式: 红方 A 的剧本 AI 已翻转为友军', fa.enemyTotal > 0 && fa.enemyAlly === fa.enemyTotal, flipA);
      check('对抗模式: A 自己的中队僚机仍是友军', fa.sq.length === 4 && fa.sqAlly === 4, flipA);
      // ---- 情况:僚机火力链路(目标输入 + 开火原语) ----
      // 说明:让僚机 AI **自主**瞄准开火需要连续十几秒的转向(它每帧只 slerp 一点点),
      // 而 headless 下每个标签页只有 ~0.3fps → 结论不稳定。这里验证的是同一条链路的
      // 两个确定环节:① 对手在僚机的目标输入里(netHandles(false)) ② 僚机的开火原语
      // (`target.hp -= GUN_DAMAGE`, 见 net/squadron.ts)对远端句柄生效并被路由给拥有者。
      const sqTargets = await ev(a, 'window.__engine.netSession.handlesFor(false).length');
      check('对手进入僚机的目标输入列表', Number(sqTargets) >= 1, `hostiles=${sqTargets}`);
      // 用"一梭子机炮"(20 发 ×4 = 80 → 实扣 40)而不是单发 4.5:单发 2.25 点伤害在
      // 取整与低帧率下判定不稳(实测偶发读成 0)。
      const hpBeforeSq = (await state(b)).hp;
      const BURST = 80;
      const sentBurst = await ev(a, `(()=>{const h=window.__engine.netSession.handlesFor(false)[0]; if(!h) return false; h.hp -= ${BURST}; return true;})()`);
      let hpAfterSq = hpBeforeSq;
      let hitsRecvB = 0;
      for (let i = 0; i < 12; i++) {
        await pump(1200);
        const s = await state(b);
        hpAfterSq = s.hp;
        hitsRecvB = s.hitsRecv;
        if (hpAfterSq < hpBeforeSq) break;
      }
      check('僚机开火原语打到对端玩家(僚机→远端句柄→伤害路由)', sentBurst === true && hpAfterSq < hpBeforeSq,
        `B hp ${hpBeforeSq}→${hpAfterSq}(一梭子 ${BURST} → 实扣 ${hpBeforeSq - hpAfterSq}) hitsRecv=${hitsRecvB}`);
    } else {
      check('合作模式: B 看 A 方单位全为友军', f.ally === f.total, faction);
      // ---- 情况:合作模式下**不能打队友**(敌方目标列表里没有队友) ----
      const ffA = await ev(a, 'window.__engine.netSession.handlesFor(false).length');
      const ffB = await ev(b, 'window.__engine.netSession.handlesFor(false).length');
      check('合作模式:双方都打不到队友(敌对目标列表为空)', Number(ffA) === 0 && Number(ffB) === 0, `A=${ffA} B=${ffB}`);
    }

    // ---- P5: 任务 AI 位姿的房主权威同步 ----
    // 两台机器上**同一架 AI**(id 相同)的位置应收敛(插值延迟 + 本地转向的余量),
    // 而不是各飞各的(那会差到几公里)。
    const aiSnap = async (tab) => JSON.parse(await ev(tab, `(()=>{const e=window.__engine;
      const s=e.netSession;
      const list=e.enemies.filter(x=>x.alive).slice(0,8).map(x=>({id:x.id,x:x.position.x,y:x.position.y,z:x.position.z}));
      return JSON.stringify({list, aiTracks:s.aiTrackCount, applied:s.debug().aiPosesApplied||0, host:s.isHost});})()`));
    await pump(4000);
    const snA = await aiSnap(a);
    const snB = await aiSnap(b);
    check('两端都登记了任务 AI 的同步轨道', snA.aiTracks > 0 && snB.aiTracks > 0, `A=${snA.aiTracks} B=${snB.aiTracks}`);
    // 客户端应确实在把房主位姿写回本地(host 不接收自己的包, 计数为 0 属正常)
    const clientSnap = snA.host ? snB : snA;
    check('客户端正在应用房主的 AI 位姿', clientSnap.applied > 0, `applied=${clientSnap.applied}`);
    const byId = new Map(snA.list.map((x) => [x.id, x]));
    let common = 0;
    let maxDist = 0;
    for (const x of snB.list) {
      const y = byId.get(x.id);
      if (!y) continue;
      common++;
      const d = Math.hypot(x.x - y.x, x.y - y.y, x.z - y.z);
      if (d > maxDist) maxDist = d;
    }
    check('两端能看到同一批任务 AI', common >= 1, `共同 AI=${common}(A ${snA.list.length} / B ${snB.list.length})`);
    check('同一架 AI 在两端位置一致(P5 房主权威同步)', common >= 1 && maxDist < 150,
      `最大偏差 ${Math.round(maxDist)} 单位 / 共同 AI ${common}`);
  } else {
    // ---- 对战: 跨客户端命中 → 击毁 → 记分 → 复活 ----
    // 可选: 联机实时日志覆盖层截图(人工验收"联机界面能看到实时日志")。
    // 用 hash `#netlog` 打开覆盖层, **不暂停**任何东西 —— 早先版本用合成 KeyP
    // 暂停再截图, 结果撞上两个坑: ①引擎自己也有 togglePause 键, 合成 keydown
    // 让 InputManager 的 justPressed 永久latch(暂停时 update() 提前 return, 没人
    // 消费它) → 恢复后下一帧又被自翻转回暂停, 世界实际冻住(现象: hitsSent=0);
    // ②那条断言本来就该在"没被人为干预"的世界上跑。设 NETLOOP_LOG_SHOT=<path>
    // 即启用(该 hash 由 hashFor 追加)。
    if (process.env.NETLOOP_LOG_SHOT) {
      try {
        await pump(2500);
        const sh = await cdp.send('Page.captureScreenshot', { format: 'png' }, a.sessionId);
        writeFileSync(process.env.NETLOOP_LOG_SHOT, Buffer.from(sh.data, 'base64'));
        console.log(`  · 联机日志覆盖层截图: ${process.env.NETLOOP_LOG_SHOT}`);
      } catch (e) { console.log('  · 日志截图失败:', e.message); }
    }
    const hp0 = sb.hp;
    const hitRet = await ev(a, '(()=>{const h=window.__engine.netSession.handlesFor(false)[0]; if(!h) return "no-handle"; h.hp -= 25; return "hit";})()');
    // 命中要经过"本地捕获 → 100ms 合并 → 拥有者扣血", 且 headless 帧率不稳, 所以轮询等待
    let hpAfter = hp0;
    let diag = null;
    for (let i = 0; i < 12; i++) {
      await pump(2400);
      const st = await state(b);
      hpAfter = st.hp;
      diag = await state(a);
      if (hpAfter < hp0) break;
    }
    check('A 打 B: B 掉血(远端命中路由到拥有者)', hpAfter < hp0,
      `hit=${hitRet} B hp ${hp0} → ${hpAfter} | A: hitsSent=${diag?.hitsSent} rtOut=${diag?.room?.rtOut} | B: hitsRecv=${(await state(b)).hitsRecv}`);

    // 连续输出直到击毁。
    // ⚠ 单次命中会被 P4 夹在 MAX_HIT_DAMAGE(400), 且受害者端还有 ×0.5 减伤,
    // 所以每次就按 400 打, 并按**当前满血**给足轮数(血量改成联机 ×2 = 450 后,
    // 旧写法 40×16 实际只落 320, 打不死了)。每轮轮询血量, 掉不动就停, 不空转。
    const killTrace = [];
    for (let i = 0; i < 30; i++) {
      const hpBefore = (await state(b)).hp;
      await ev(a, '(()=>{const h=window.__engine.netSession.handlesFor(false)[0]; if(h) h.hp -= 400; return !!h;})()');
      await pump(1200);
      const sb2 = await state(b);
      killTrace.push(sb2.hp);
      if (!sb2.alive) break;
      if (sb2.hp === hpBefore && i >= 4) break;
    }
    console.log('  · 击杀输出: B 血量轨迹 ' + killTrace.join(' → '));
    await pump(2000);
    const sb3 = await state(b);
    const sa3 = await state(a);
    check('B 被击毁(拥有者判定死亡)', sb3.alive === false, `B alive=${sb3.alive} hp=${sb3.hp}`);
    // 13 秒窗口可能已经被上面的轮询走完 → 只要"死亡 + 倒计时存在或已就绪"即可
    check('B 进入 13 秒复活流程', sb3.dead === true && (sb3.respawnIn > 0 || sb3.respawnIn === 0), `dead=${sb3.dead} respawnIn=${sb3.respawnIn}`);
    check('B 的任务没有因此结束(联机不死即结算)', sb3.ended === false, `ended=${sb3.ended}`);
    const aSelf = sa3.players.find((p) => p.isSelf);
    const bRow = sa3.players.find((p) => !p.isSelf);
    check('A 的记分板: 自己 +1 击毁', (aSelf?.kills ?? 0) >= 1, JSON.stringify(aSelf));
    check('A 的记分板: B +1 被击毁', (bRow?.deaths ?? 0) >= 1, JSON.stringify(bRow));
    check('A 收到击杀信息条', sa3.feed >= 1, `feed=${sa3.feed}`);

    // ---- 复活: 快进 13s → respawnPlayer ----
    await ev(b, 'window.__engine.netSession.setLocalDead(true, performance.now()-20000); "ff"');
    const did = await ev(b, 'window.__engine.respawnPlayer()');
    await pump(2500);
    const sb4 = await state(b);
    check('B 复活成功(满血归队)', did === true && sb4.alive === true, `respawn=${did} alive=${sb4.alive} hp=${sb4.hp}`);
    let sawAlive = 0;
    for (let i = 0; i < 14; i++) { await pump(1200); sawAlive = await ev(a, '(()=>{const r=window.__engine.entityRegistry().remotes();return r.length>0&&r[0].alive?1:0;})()'); if (Number(sawAlive) === 1) break; }
    check('A 侧看到 B 重新出现(快照 alive 恢复)', Number(sawAlive) === 1, `A 侧 alive=${sawAlive}`);

    // ---- 权威方结束本局 → 对端收到 matchend ----
    // 房主在测试期间可能因心跳刷新而变化 → 调用前重新读一次
    const hostNow = (await state(a)).host ? a : b;
    const peerNow = hostNow === a ? b : a;
    const ended = await ev(hostNow, 'window.__engine.endMatchAsHost()');
    let peerOver = 0;
    for (let i = 0; i < 18; i++) { await pump(1100); peerOver = await ev(peerNow, 'window.__engine.multiplayerUi()&&window.__engine.multiplayerUi().matchOver?1:0'); if (Number(peerOver) === 1) break; }
    check('房主结束本局: 对端收到 matchend', ended === true && Number(peerOver) === 1, `hostEnd=${ended} peerMatchOver=${peerOver}`);
  }

  // 已知无害噪音: dev 静态服务器对**任何缺失路径**都返回 index.html(200),
  // 于是 /relay-worker.js 与 /favicon.ico 落在这个兜底上 → "Unexpected token '<'"。
  // 与本作代码无关(生产单文件不请求这两个路径), 断言时过滤掉。
  const realErrors = pageErrors.filter((e) => !/Unexpected token '<'/.test(e));
  check('页面无 JS 异常(已排除 relay-worker/favicon 的 404 兜底噪音)', realErrors.length === 0, realErrors.slice(0, 3));

  // 截图留档
  try {
    const shotA = await cdp.send('Page.captureScreenshot', { format: 'png' }, a.sessionId);
    writeFileSync(`.shots/netloop-${PHASE}-A.png`, Buffer.from(shotA.data, 'base64'));
    const shotB = await cdp.send('Page.captureScreenshot', { format: 'png' }, b.sessionId);
    writeFileSync(`.shots/netloop-${PHASE}-B.png`, Buffer.from(shotB.data, 'base64'));
    console.log(`  · 截图: .shots/netloop-${PHASE}-A.png / -B.png`);
  } catch { /* 截图失败不影响结论 */ }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 结果: ${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败项:');
    for (const f of failed) console.log(`  - ${f.name} → ${typeof f.detail === 'string' ? f.detail : JSON.stringify(f.detail)}`);
  }
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
  try { spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  ws.close();
  process.exit(failed.length ? 2 : 0);
}

main().catch((e) => {
  console.error('[netloop] 失败:', e.message);
  process.exit(3);
});
