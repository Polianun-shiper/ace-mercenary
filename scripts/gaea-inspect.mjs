#!/usr/bin/env node
// === Gaea .terrain Schema 盘点(只读;autopilot step1) ===
// 遍历官方 Examples .terrain(JSON.NET 工程),统计节点类型与参数字段,
// 重点找输出/网格/变量类节点;摘要写 docs/gaea-schema.md。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CANDIDATES = [
  'C:/Users/Administrator/AppData/Local/Programs/QuadSpinner/Gaea 2/Examples',
  'C:/Program Files/QuadSpinner/Gaea 2/Examples',
];

function findExamples() {
  for (const p of CANDIDATES) {
    try {
      if (readdirSync(p).length > 0) return p;
    } catch { /* next */ }
  }
  return null;
}

const dir = findExamples();
if (!dir) {
  console.error('未找到 Gaea Examples 目录');
  process.exit(1);
}
const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.terrain'));
console.log(`Examples: ${files.length} 个 .terrain @ ${dir}\n`);

const typeStats = new Map();
const interesting = new Map();
const rootKeys = new Map();

for (const f of files) {
  let json;
  try {
    json = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  } catch (e) {
    console.log(`跳过(非 JSON): ${f}`);
    continue;
  }
  for (const k of Object.keys(json)) rootKeys.set(k, (rootKeys.get(k) ?? 0) + 1);
  const assets = (json.Assets && json.Assets.$values) || [];
  for (const asset of assets) {
    const terrain = asset && asset.Terrain;
    if (!terrain || !terrain.Nodes) continue;
    for (const nodeId of Object.keys(terrain.Nodes)) {
      const node = terrain.Nodes[nodeId];
      const type = String(node.$type || '?');
      const name = String(node.Name || '');
      const keys = Object.keys(node).filter((k) => !['$id', '$type', 'Id', 'Position', 'Ports', 'Modifiers'].includes(k));
      let rec = typeStats.get(type);
      if (!rec) {
        rec = { count: 0, keys: new Set(), names: new Set() };
        typeStats.set(type, rec);
      }
      rec.count++;
      keys.forEach((k) => rec.keys.add(k));
      rec.names.add(name);
      if (/output|export|file|mesh|variab|savemap|bake/i.test(type + ' ' + name)) {
        const arr = interesting.get(type) || [];
        arr.push({ file: f, type, name, keys });
        interesting.set(type, arr);
      }
    }
  }
}

const sorted = [...typeStats.entries()].sort((a, b) => b[1].count - a[1].count);
console.log('=== 节点类型 Top30 ===');
for (const [type, s] of sorted.slice(0, 30)) {
  console.log(`${String(s.count).padStart(4)}  ${type.replace('QuadSpinner.Gaea.Nodes.', '')}  keys[${s.keys.size}]: ${[...s.keys].slice(0, 16).join(', ')}`);
}

console.log('\n=== 输出/网格/变量类节点 ===');
for (const [type, arr] of interesting) {
  const short = type.replace('QuadSpinner.Gaea.Nodes.', '');
  console.log(`\n-- ${short} (${arr.length} 处)`);
  for (const it of arr.slice(0, 8)) {
    console.log(`   ${it.file} :: ${it.name} keys: ${it.keys.slice(0, 24).join(', ')}`);
  }
}

console.log('\n=== 根级键(跨文件出现次数) ===');
console.log([...rootKeys.entries()].map(([k, v]) => `${k}=${v}`).join('  '));

const lines = [];
lines.push('# Gaea .terrain Schema 盘点(自动生成)', '');
lines.push(`> 扫描目录:${dir}(${files.length} 个示例)`, '');
lines.push('## 根级键');
lines.push([...rootKeys.entries()].map(([k, v]) => `- ${k} ×${v}`).join('\n') || '- 无', '');
lines.push('## 节点类型(前 30)', '', '| 类型 | 次数 | 常见参数字段 |', '|---|---|---|');
for (const [type, s] of sorted.slice(0, 30)) {
  lines.push(`| ${type.replace('QuadSpinner.Gaea.Nodes.', '')} | ${s.count} | ${[...s.keys].slice(0, 18).join('、')} |`);
}
lines.push('', '## 输出/网格/变量类节点', '');
for (const [type, arr] of interesting) {
  lines.push(`### ${type.replace('QuadSpinner.Gaea.Nodes.', '')}`);
  lines.push('');
  for (const it of arr.slice(0, 8)) {
    lines.push(`- ${it.file} :: ${it.name} — keys: ${it.keys.join('、')}`);
  }
  lines.push('');
}
writeFileSync(join(ROOT, 'docs/gaea-schema.md'), lines.join('\n'));
console.log('\n已写 docs/gaea-schema.md');
