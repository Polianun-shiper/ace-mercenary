#!/usr/bin/env node
// === 分块批量 Swarm 驱动(node;解决 Swarm 不自动退出的问题) ===
// 用法: node scripts/gaea-tile-run.mjs <tilesDir> [--grid 3] [--res 512] [--conc 2] [--timeoutMin 10]
import { spawn } from 'node:child_process';
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SWARM = 'C:/Users/Administrator/AppData/Local/Programs/QuadSpinner/Gaea 2/Gaea.Swarm.exe';
const PS = 'powershell';
const args = process.argv.slice(2);
const dir = args[0];
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const grid = Number(get('--grid', '3'));
const res = get('--res', '512');
const conc = Number(get('--conc', '2'));
const timeoutMs = Number(get('--timeoutMin', '10')) * 60000;

if (!dir) { console.log('用法: node scripts/gaea-tile-run.mjs <tilesDir> [--grid 3] [--res 512] [--conc 2]'); process.exit(1); }

function runSwarm(name, outDir) {
  return new Promise((resolve) => {
    // 隐藏窗口启动(避免 console handle 崩溃)
    const psArgs = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Start-Process -FilePath '${SWARM}' -ArgumentList '--Filename','${join(dir, name + '.terrain')}','--buildpath','${outDir}','--resolution','${res}','--silent','--ignorecache' -WindowStyle Hidden -PassThru | Select-Object -ExpandProperty Id`,
    ];
    const child = spawn(PS, psArgs, { shell: false, windowsHide: true });
    let pid = null;
    let outBuf = '';
    child.stdout.on('data', (d) => { outBuf += d; const m = outBuf.match(/(\d+)/); if (m && !pid) pid = Number(m[1]); });
    child.on('close', () => {
      if (!pid) { resolve({ name, ok: false, err: 'no pid' }); return; }
      poll(pid, outDir, name, resolve);
    });
    child.on('error', (e) => resolve({ name, ok: false, err: String(e) }));
  });
}

function poll(pid, outDir, name, resolve) {
  const exr = join(outDir, 'HeightmapExport.exr');
  const t0 = Date.now();
  let lastSize = -1, stable = 0;
  const iv = setInterval(() => {
    let size = -1;
    if (existsSync(exr)) size = statSync(exr).size;
    if (size > 0 && size === lastSize) stable += 2; else { stable = 0; lastSize = size; }
    const timedOut = Date.now() - t0 > timeoutMs;
    if ((size > 0 && stable >= 4) || timedOut) {
      clearInterval(iv);
      try { process.kill(pid); } catch { /* gone */ }
      setTimeout(() => resolve({ name, ok: size > 0, size, timedOut }), 500);
    }
  }, 2000);
}

(async () => {
  const names = [];
  for (let r = 0; r < grid; r++) for (let c = 0; c < grid; c++) names.push(`tile_r${r}_c${c}`);
  const queue = [...names];
  const running = new Set();
  const results = [];
  while (queue.length || running.size) {
    while (running.size < conc && queue.length) {
      const n = queue.shift();
      running.add(n);
      const outDir = join(dir, `${n}-out`);
      runSwarm(n, outDir).then((r) => {
        running.delete(n);
        results.push(r);
        console.log(`[${r.ok ? 'ok' : 'FAIL'}] ${n} ${r.size ? `(${Math.round(r.size / 1024)}KB)` : ''}${r.timedOut ? ' TIMEOUT' : ''}${r.err ? ' ' + r.err : ''}`);
      });
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  const ok = results.filter((r) => r.ok).length;
  console.log(`ALL DONE: ${ok}/${results.length}`);
  process.exit(ok === results.length ? 0 : 2);
})();
