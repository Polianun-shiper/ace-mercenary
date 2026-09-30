#!/usr/bin/env node
// scripts/rig-workshop.mjs
//
// **一条命令把整条链跑起来**: 起服务 → 取真值 → 建场景 → 开 Blender → 开游戏 → 挂监听。
// 之后你只需要做一件事: **在 Blender 里拖, 然后 Ctrl+S**。
//
// 为什么要有它: 原来要开三个窗口敲四条命令(serve / dump / build / watch),
// 而且顺序错了会得到"基线过期"这种看不懂的报错。合成一条之后, 顺序由脚本保证。
//
// 用法:
//   node scripts/rig-workshop.mjs --model f16c
//   node scripts/rig-workshop.mjs --model f16c --refresh-dump   # 强制重新取真值+重建场景
//   node scripts/rig-workshop.mjs --model f16c --no-blender     # 不自动开 Blender
//   node scripts/rig-workshop.mjs --model f16c --no-game        # 不自动开游戏窗口/监听
//
// 它做了什么(每步都会告诉你为什么):
//   1. 起静态服务(serve-test.mjs) —— 游戏和 rig json 都从它走
//   2. out/rig-dump.json 不存在(或 --refresh-dump) → 跑 rig-dump(无头浏览器进关卡取真值)
//   3. out/<model>.rig.blend 不存在或比 dump 旧 → 跑 10_build
//   4. 用 **GUI** 打开 .blend(不是 -b)
//   5. 开一个带调试口的游戏窗口 + 挂 rig-watch: 你保存 blend → 自动导出 → 自动刷新游戏
//
// Ctrl+C 会收掉服务与监听, **不会**关掉 Blender(你还在里面干活)。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes('--' + k);

const MODEL = flag('model', 'f16c');
const MISSION = flag('mission', 'm06');
const PORT = Number(flag('port', '8898'));
const URL = `http://127.0.0.1:${PORT}/#autotest&desktop&mission=${MISSION}`;
const BLEND = join(ROOT, 'blender', 'aircraft', 'out', `${MODEL}.rig.blend`);
const DUMP = join(ROOT, 'blender', 'aircraft', 'out', 'rig-dump.json');

const children = [];
function track(child, name) { children.push({ child, name }); return child; }
function cleanup() {
  for (const { child, name } of children) {
    try { child.kill(); console.log(`[stop] ${name}`); } catch { /* ignore */ }
  }
}
process.on('SIGINT', () => { console.log('\n[exit] 收工(Blender 保持打开)'); cleanup(); process.exit(0); });
process.on('exit', cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };

async function waitHttp(url, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* retry */ }
    await sleep(400);
  }
  return false;
}

function runNode(script, args, label) {
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args],
    { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) {
    console.error(`\n[失败] ${label}(exit ${r.status})—— 上面的输出里应有原因`);
    cleanup();
    process.exit(r.status ?? 1);
  }
}

async function main() {
  console.log(`[rig-workshop] 模型 ${MODEL} / 关卡 ${MISSION}`);
  console.log('  你最终只需要做一件事: 在 Blender 里拖, 然后 Ctrl+S\n');

  // 1) 静态服务(已经在跑就直接用)
  let serverUp = false;
  try { const r = await fetch(`http://127.0.0.1:${PORT}/`); serverUp = r.ok; } catch { serverUp = false; }
  if (serverUp) {
    console.log(`[1/5] 静态服务已在跑 (${PORT}) —— 直接用`);
  } else {
    console.log(`[1/5] 起静态服务 (${PORT}) …`);
    track(spawn(process.execPath, [join(ROOT, 'scripts', 'serve-test.mjs')],
      { stdio: 'ignore', env: { ...process.env, PORT: String(PORT) } }), 'serve-test');
    if (!(await waitHttp(`http://127.0.0.1:${PORT}/`))) {
      console.error('  服务起不来 —— 端口被占? 换 --port');
      cleanup(); process.exit(1);
    }
    console.log('  ok');
  }

  // 2) 取真值(游戏实测数据)
  const fresh = has('refresh-dump');
  if (!existsSync(DUMP) || fresh) {
    runNode('rig-dump.mjs', [url0(), '--mission', MISSION, '--all'],
      `[2/5] 从游戏取真值${fresh ? '(--refresh-dump 强制)' : '(首次, 约 1 分钟)'}`);
  } else {
    console.log('[2/5] 已有 out/rig-dump.json —— 跳过(想刷新用 --refresh-dump)');
  }

  // 3) 建可手拖的场景(dump 更新了才重建)
  if (!existsSync(BLEND) || mtime(BLEND) < mtime(DUMP) || fresh) {
    runNode('rig.mjs', ['build', '--model', MODEL], '[3/5] 建 rig 场景');
  } else {
    console.log('[3/5] .blend 比 dump 新 —— 跳过(想重建用 --refresh-dump)');
  }

  // 4) 开 Blender GUI(不动 -b;detached, Ctrl+C 不会关掉它)
  if (!has('no-blender')) {
    const blender = findBlender();
    if (blender) {
      console.log(`[4/5] 用 GUI 打开 ${BLEND}`);
      const gui = spawn(blender, [BLEND], { detached: true, stdio: 'ignore' });
      gui.unref();
    } else {
      console.warn('[4/5] 找不到 Blender —— 手动打开这个文件:', BLEND);
    }
  } else {
    console.log('[4/5] --no-blender: 跳过');
  }

  // 5) 游戏窗口 + 监听(保存 blend → 自动导出 → 自动刷新页面)
  if (!has('no-game')) {
    console.log('[5/5] 开游戏窗口并挂监听(保存 blend 会自动导出+刷新)');
    console.log('      停止: 在本窗口按 Ctrl+C\n');
    const w = spawn(process.execPath,
      [join(ROOT, 'scripts', 'rig-watch.mjs'), '--model', MODEL, '--url', URL],
      { stdio: 'inherit', cwd: ROOT });
    track(w, 'rig-watch');
    await new Promise((res) => w.on('exit', res));
  } else {
    console.log('[5/5] --no-game: 跳过\n');
    console.log('手动生效: npm run rig:export 之后刷新游戏页面');
  }
}

function url0() {
  // rig-dump 需要不带 hash 的基址 + --mission 参数
  return `http://127.0.0.1:${PORT}/`;
}

function findBlender() {
  const cands = [
    process.env.BLENDER,
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Blender\\blender.exe',
    'C:\\Program Files\\Steam\\steamapps\\common\\Blender\\blender.exe',
  ].filter(Boolean);
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

main().catch((e) => { console.error(e); cleanup(); process.exit(1); });
