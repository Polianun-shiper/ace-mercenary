#!/usr/bin/env node
// === Gaea 自动驾驶仪 v0(探针) ===
// 阶段A「注入 Export 并跑 Swarm」:取官方雪山模板副本 → 图链尾注入
// Export(HeightmapExport, PNG16)→ Gaea.Swarm 隐藏进程 --buildpath 构建 →
// 递归列出产物(高度 PNG16/其它)。
// 用法:
//   node scripts/gaea-autopilot.mjs <outdir> [--res 2048]
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const G2 = 'C:/Users/Administrator/AppData/Local/Programs/QuadSpinner/Gaea 2';
const TEMPLATE = join(G2, 'Examples/Detailed Snow Peak.terrain');
const SWARM = join(G2, 'Gaea.Swarm.exe');

const args = process.argv.slice(2);
const outDir = (args.find((a) => !a.startsWith('--')) || 'F:/SkyAceGaea/job1').replace(/\\/g, '/');
const resI = args.indexOf('--res');
const res = resI >= 0 ? args[resI + 1] : '2048';

function listRec(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) listRec(p, acc);
    else acc.push(p);
  }
  return acc;
}

// 1) 副本 + 注入 Export 节点
const orig = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
mkdirSync(outDir, { recursive: true });
const terrain = orig.Assets.$values[0].Terrain;
const nodes = terrain.Nodes;
// Nodes 对象里还混着 JSON.NET 的 "$id" 元条目 —— 只取真正的节点
const nodeArr = Object.values(nodes).filter((n) => n && typeof n.Id === 'number');

// 找颜色类终端(不导出它,导出其上游地形)
const isColor = (n) => /SatMap|Texture|Color|Shade/i.test(String(n.$type) + ' ' + String(n.Name || ''));
const usedAsFrom = new Set();
for (const n of nodeArr) {
  for (const p of (n.Ports && n.Ports.$values) || []) {
    if (p.Record && p.Record.From !== undefined && p.Record.To === n.Id) usedAsFrom.add(p.Record.From);
  }
}
let source = null;
const colorSink = nodeArr.find((n) => isColor(n));
if (colorSink) {
  for (const p of (colorSink.Ports && colorSink.Ports.$values) || []) {
    if (p.Record && p.Record.From !== undefined) { source = p.Record.From; break; }
  }
}
if (source === null || !nodes[source]) {
  const sinks = nodeArr.filter((n) => !usedAsFrom.has(n.Id) && !isColor(n));
  source = sinks.length ? sinks[0].Id : nodeArr[nodeArr.length - 1].Id;
}
// 找最大的 $id(JSON.NET 用字符串数字),新节点在之后分配,避免引用冲突
let maxRef = 0;
const walk = (o) => {
  if (o === null || typeof o !== 'object') return;
  for (const k of Object.keys(o)) {
    if (k === '$id') {
      const n = parseInt(String(o[k]), 10);
      if (!Number.isNaN(n)) maxRef = Math.max(maxRef, n);
    } else {
      walk(o[k]);
    }
  }
};
walk(orig);
const newId = Math.max(1, ...nodeArr.map((n) => Number(n.Id))) + 1;
const r = () => String(++maxRef);
const myRef = r(); // 本 Export 节点的 $id(字符串)

const exportNode = {
  $id: myRef,
  $type: 'QuadSpinner.Gaea.Nodes.Export, Gaea.Nodes',
  Id: newId,
  Name: 'HeightmapExport',
  Position: { $id: r(), X: 32000, Y: 26300 },
  Ports: {
    $id: r(),
    $values: [
      {
        $id: r(), Name: 'In', Type: 'PrimaryIn', IsExporting: true,
        Parent: { $ref: myRef },
        Record: { $id: r(), From: Number(source), To: newId, FromPort: 'Out', ToPort: 'In', IsValid: true },
      },
      { $id: r(), Name: 'Out', Type: 'PrimaryOut', IsExporting: true, Parent: { $ref: myRef } },
    ],
  },
  Modifiers: { $id: r(), $values: [] },
  SaveDefinition: { Filename: 'Heightmap', Format: 'PNG16', Enabled: true, DisabledProfiles: [] },
};
nodes[String(newId)] = exportNode;

const modPath = join(outDir, 'Detailed Snow Peak.terrain');
writeFileSync(modPath, JSON.stringify(orig, null, 2));
console.log(`[inject] 源节点 ${source} → Export(${newId}) @ ${modPath}`);

// 2) 隐藏进程跑 Swarm
const ps1 = join(outDir, 'run.ps1');
writeFileSync(ps1, [
  '$ErrorActionPreference="Continue"',
  `$swarm = "${SWARM.replace(/\//g, '\\')}"`,
  `$terrain = "${modPath.replace(/\//g, '\\')}"`,
  `$args = @("--Filename", $terrain, "--buildpath", "${outDir.replace(/\//g, '\\')}", "--resolution", "${res}", "--silent", "--ignorecache")`,
  '$p = Start-Process -FilePath $swarm -ArgumentList $args -Wait -PassThru -WindowStyle Hidden',
  'Set-Content -Path "' + outDir.replace(/\//g, '\\') + '\\code.txt" -Value ("CODE=" + $p.ExitCode)',
].join('\n'));
const ps = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1.replace(/\//g, '\\')], { encoding: 'utf8', timeout: 900000 });
console.log(`[swarm] ps exit=${ps.status} stderr=${(ps.stderr || '').slice(0, 400)}`);
const codeFile = join(outDir, 'code.txt');
console.log('[swarm] code =', existsSync(codeFile) ? readFileSync(codeFile, 'utf8').trim() : '(无 code.txt)');

// 3) 列出产物
const files = listRec(outDir).filter((f) => !f.endsWith('.terrain') && !f.endsWith('.ps1') && !f.endsWith('.txt'));
console.log(`[out] ${files.length} 个产物:`);
for (const f of files) console.log('   ', f.replace(/\//g, '\\'));
console.log('工作区:', outDir.replace(/\//g, '\\'));
