#!/usr/bin/env node
// === 群系增强:向既有 job 的地形链头再并一座 Mountain(Combine Max 合并) ===
// 用法:
//   node scripts/gaea-add-mountain.mjs <in.terrain> <out.terrain> [--height 4] [--seed 777] [--x 偏移]
// 思路(纯文本,绝不整文件重排):
//   chainHead(起点 Mountain M1) → 新 Combine(Max) → 原下游
//   新 Mountain M2 → Combine.Input2
//   新节点 $id 用 900+ 区间,避免与现网冲突;539 之类下游 In-Record.From 改写为 Combine。
import { readFileSync, writeFileSync } from 'node:fs';

function main() {
  const [inPath, outPath] = process.argv.slice(2);
  const height = Number(process.argv[process.argv.indexOf('--height') + 1] || 4);
  const seed = Number(process.argv[process.argv.indexOf('--seed') + 1] || 777);
  const dx = Number(process.argv[process.argv.indexOf('--x') + 1] || 4000);
  if (!inPath || !outPath) { console.log('用法: node scripts/gaea-add-mountain.mjs <in> <out> [--height 4] [--seed 777] [--x 4000]'); process.exit(1); }
  const text = readFileSync(inPath, 'utf8');
  const root = JSON.parse(text);
  const T = root.Assets.$values[0].Terrain;
  const map = new Map();
  for (const [k, v] of Object.entries(T.Nodes)) if (k !== '$id') map.set(Number(k), v);

  // 找起点 Mountain:In 口无 Record(真源头)且类型 Mountain
  const fed = new Set();
  for (const [, n] of map) for (const p of n.Ports?.$values || []) if (p.Record?.To !== undefined) fed.add(p.Record.To);
  const heads = [...map.entries()].filter(([id, n]) => !fed.has(id) && /Mountain/.test(n.$type || ''));
  const head = heads.length ? heads.reduce((a, b) => (a[0] < b[0] ? a : b)) : null;
  if (!head) { console.error('找不到起点 Mountain 节点'); process.exit(1); }
  const [hId, hNode] = head;
  // 下游:消费 head.Out 的节点(其 In-Record.From === hId)
  const downstream = [...map.entries()].find(([, n]) =>
    (n.Ports?.$values || []).some((p) => p.Record?.From === hId));
  if (!downstream) { console.error('起点 Mountain 没有下游'); process.exit(1); }
  const [dId, dNode] = downstream;

  // 新节点 Id 与 $id(900+ 段)
  const newIdBase = 9000 + Math.max(...map.keys());
  const m2Id = newIdBase + 1;
  const cbId = newIdBase + 2;
  let ref = 900000; // JSON.NET $id 只需唯一,无需连续
  const R = () => String(++ref);
  const I = (d) => ' '.repeat(12 + d * 2);
  const hPos = hNode.Position || { X: 26000, Y: 26000 };

  // --- Mountain2 节点文本 ---
  const m2Ref = R();
  const m2Lines = [];
  m2Lines.push(I(1) + '"' + m2Id + '": {' + '\r\n');
  m2Lines.push(I(2) + '"$id": "' + m2Ref + '",' + '\r\n');
  m2Lines.push(I(2) + '"$type": "QuadSpinner.Gaea.Nodes.Mountain, Gaea.Nodes",' + '\r\n');
  m2Lines.push(I(2) + '"Height": ' + height + ',' + '\r\n');
  m2Lines.push(I(2) + '"Style": "Strata",' + '\r\n');
  m2Lines.push(I(2) + '"Seed": ' + seed + ',' + '\r\n');
  m2Lines.push(I(2) + '"Id": ' + m2Id + ',' + '\r\n');
  m2Lines.push(I(2) + '"Name": "Mountain2",' + '\r\n');
  m2Lines.push(I(2) + '"Position": {' + '\r\n');
  m2Lines.push(I(3) + '"$id": "' + R() + '",' + '\r\n');
  m2Lines.push(I(3) + '"X": ' + (hPos.X + dx) + ',' + '\r\n');
  m2Lines.push(I(3) + '"Y": ' + (hPos.Y + 3000) + '\r\n');
  m2Lines.push(I(2) + '},' + '\r\n');
  m2Lines.push(I(2) + '"Ports": {' + '\r\n');
  m2Lines.push(I(3) + '"$id": "' + R() + '",' + '\r\n');
  m2Lines.push(I(3) + '"$values": [' + '\r\n');
  m2Lines.push(I(3) + '{' + '\r\n');
  m2Lines.push(I(4) + '"$id": "' + R() + '",' + '\r\n');
  m2Lines.push(I(4) + '"Name": "In",' + '\r\n');
  m2Lines.push(I(4) + '"Type": "PrimaryIn",' + '\r\n');
  m2Lines.push(I(4) + '"IsExporting": true,' + '\r\n');
  m2Lines.push(I(4) + '"Parent": { "$ref": "' + m2Ref + '" }' + '\r\n');
  m2Lines.push(I(3) + '},' + '\r\n');
  m2Lines.push(I(3) + '{' + '\r\n');
  m2Lines.push(I(4) + '"$id": "' + R() + '",' + '\r\n');
  m2Lines.push(I(4) + '"Name": "Out",' + '\r\n');
  m2Lines.push(I(4) + '"Type": "PrimaryOut",' + '\r\n');
  m2Lines.push(I(4) + '"IsExporting": true,' + '\r\n');
  m2Lines.push(I(4) + '"Parent": { "$ref": "' + m2Ref + '" }' + '\r\n');
  m2Lines.push(I(3) + '}' + '\r\n');
  m2Lines.push(I(3) + ']' + '\r\n');
  m2Lines.push(I(2) + '},' + '\r\n');
  m2Lines.push(I(2) + '"Modifiers": { "$id": "' + R() + '", "$values": [] }' + '\r\n');
  m2Lines.push(I(1) + '}');
  const m2Text = m2Lines.join('');

  // --- Combine(Max) 节点文本 ---
  const cbRef = R();
  const cbLines = [];
  cbLines.push(I(1) + '"' + cbId + '": {' + '\r\n');
  cbLines.push(I(2) + '"$id": "' + cbRef + '",' + '\r\n');
  cbLines.push(I(2) + '"$type": "QuadSpinner.Gaea.Nodes.Combine, Gaea.Nodes",' + '\r\n');
  cbLines.push(I(2) + '"PortCount": 2,' + '\r\n');
  cbLines.push(I(2) + '"Ratio": 1,' + '\r\n');
  cbLines.push(I(2) + '"Mode": "Max",' + '\r\n');
  cbLines.push(I(2) + '"Id": ' + cbId + ',' + '\r\n');
  cbLines.push(I(2) + '"Name": "MergeMountains",' + '\r\n');
  cbLines.push(I(2) + '"NodeSize": "Small",' + '\r\n');
  cbLines.push(I(2) + '"Position": {' + '\r\n');
  cbLines.push(I(3) + '"$id": "' + R() + '",' + '\r\n');
  cbLines.push(I(3) + '"X": ' + (hPos.X + 1500) + ',' + '\r\n');
  cbLines.push(I(3) + '"Y": ' + hPos.Y + '\r\n');
  cbLines.push(I(2) + '},' + '\r\n');
  cbLines.push(I(2) + '"Ports": {' + '\r\n');
  cbLines.push(I(3) + '"$id": "' + R() + '",' + '\r\n');
  cbLines.push(I(3) + '"$values": [' + '\r\n');
  // In ← head.Out
  cbLines.push(I(3) + '{' + '\r\n');
  cbLines.push(I(4) + '"$id": "' + R() + '",' + '\r\n');
  cbLines.push(I(4) + '"Name": "In",' + '\r\n');
  cbLines.push(I(4) + '"Type": "PrimaryIn, Required",' + '\r\n');
  cbLines.push(I(4) + '"IsExporting": true,' + '\r\n');
  cbLines.push(I(4) + '"Record": {' + '\r\n');
  cbLines.push(I(5) + '"$id": "' + R() + '",' + '\r\n');
  cbLines.push(I(5) + '"From": ' + hId + ',' + '\r\n');
  cbLines.push(I(5) + '"To": ' + cbId + ',' + '\r\n');
  cbLines.push(I(5) + '"FromPort": "Out",' + '\r\n');
  cbLines.push(I(5) + '"ToPort": "In",' + '\r\n');
  cbLines.push(I(5) + '"IsValid": true' + '\r\n');
  cbLines.push(I(4) + '},' + '\r\n');
  cbLines.push(I(4) + '"Parent": { "$ref": "' + cbRef + '" }' + '\r\n');
  cbLines.push(I(3) + '},' + '\r\n');
  // Out
  cbLines.push(I(3) + '{' + '\r\n');
  cbLines.push(I(4) + '"$id": "' + R() + '",' + '\r\n');
  cbLines.push(I(4) + '"Name": "Out",' + '\r\n');
  cbLines.push(I(4) + '"Type": "PrimaryOut",' + '\r\n');
  cbLines.push(I(4) + '"IsExporting": true,' + '\r\n');
  cbLines.push(I(4) + '"Parent": { "$ref": "' + cbRef + '" }' + '\r\n');
  cbLines.push(I(3) + '},' + '\r\n');
  // Input2 ← m2.Out
  cbLines.push(I(3) + '{' + '\r\n');
  cbLines.push(I(4) + '"$id": "' + R() + '",' + '\r\n');
  cbLines.push(I(4) + '"Name": "Input2",' + '\r\n');
  cbLines.push(I(4) + '"Type": "In",' + '\r\n');
  cbLines.push(I(4) + '"IsExporting": true,' + '\r\n');
  cbLines.push(I(4) + '"Record": {' + '\r\n');
  cbLines.push(I(5) + '"$id": "' + R() + '",' + '\r\n');
  cbLines.push(I(5) + '"From": ' + m2Id + ',' + '\r\n');
  cbLines.push(I(5) + '"To": ' + cbId + ',' + '\r\n');
  cbLines.push(I(5) + '"FromPort": "Out",' + '\r\n');
  cbLines.push(I(5) + '"ToPort": "Input2",' + '\r\n');
  cbLines.push(I(5) + '"IsValid": true' + '\r\n');
  cbLines.push(I(4) + '},' + '\r\n');
  cbLines.push(I(4) + '"Parent": { "$ref": "' + cbRef + '" }' + '\r\n');
  cbLines.push(I(3) + '},' + '\r\n');
  // Mask(空)
  cbLines.push(I(3) + '{' + '\r\n');
  cbLines.push(I(4) + '"$id": "' + R() + '",' + '\r\n');
  cbLines.push(I(4) + '"Name": "Mask",' + '\r\n');
  cbLines.push(I(4) + '"Type": "In",' + '\r\n');
  cbLines.push(I(4) + '"IsExporting": true,' + '\r\n');
  cbLines.push(I(4) + '"Parent": { "$ref": "' + cbRef + '" }' + '\r\n');
  cbLines.push(I(3) + '}' + '\r\n');
  cbLines.push(I(3) + ']' + '\r\n');
  cbLines.push(I(2) + '},' + '\r\n');
  cbLines.push(I(2) + '"Modifiers": { "$id": "' + R() + '", "$values": [] }' + '\r\n');
  cbLines.push(I(1) + '}');
  const cbText = cbLines.join('');

  // 尾部插入:Nodes dict 收尾 = "}"(dict) + "," + Groups。在 dict 收尾前插成员。
  // 通用锚:dict 收尾行 + Groups 行(唯一),前一行是最后一个节点成员自己的 "}"。
  const seg = '\r\n          },\r\n          "Groups": {';
  const si = text.indexOf(seg);
  if (si < 0) { console.error('找不到 Nodes 尾锚'); process.exit(1); }
  // text.slice(0,si) 以最后一个节点成员的 "}" 结尾 → 补 "," 后接新成员
  let out = text.slice(0, si) + ',\r\n' + m2Text + ',\r\n' + cbText + seg + text.slice(si + seg.length);
  // 改写下游 In-Record.From: head → cbId(只改下游节点的 In 口)
  const dStart = out.indexOf('"' + dId + '": {');
  if (dStart < 0) { console.error('找不到下游节点'); process.exit(1); }
  const dSeg = out.slice(dStart);
  const fromHead = '"From": ' + hId + ',';
  const fi = dSeg.indexOf(fromHead);
  if (fi < 0) { console.error('下游 In-Record 未找到 From 指向 head'); process.exit(1); }
  out = out.slice(0, dStart + fi) + '"From": ' + cbId + ',' + out.slice(dStart + fi + fromHead.length);

  writeFileSync(outPath, out, 'utf8');
  JSON.parse(readFileSync(outPath, 'utf8'));
  console.log(`[ok] ${inPath} → ${outPath}`);
  console.log(`    起点 Mountain(${hId}) 与 Mountain2(${m2Id},H=${height},Seed=${seed}) → Combine(${cbId},Mode=Max) → 下游 ${dId}`);
}
main();
