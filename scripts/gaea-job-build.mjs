#!/usr/bin/env node
// === Gaea job 构建器:任意官方模板 → 副本 + 尾链接规范 Export 节点 ===
// 用法:
//   node scripts/gaea-job-build.mjs "<模板名>" <输出.terrain路径> [--node <源节点Id>]
// 说明:
//   - 从 Examples 读模板 → 找"地形终端节点"(整链最后一级非颜色节点)→
//     纯文本拼接官方同款 Export 节点(In+Out+Record+SaveDefinition PNG16),
//     绝不整文件 JSON 重排(Gaea 会拒收重排文件);
//   - 产物可直接在 Gaea GUI 打开(节点已接好),也可直接交给 Swarm 构建。
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const G2 = 'C:/Users/Administrator/AppData/Local/Programs/QuadSpinner/Gaea 2/Examples';

// --- 颜色/纹理类节点:它们是"染色侧链",不作为地形导出源 ---
const COLORISH = /SatMap|TextureBase|ColorErosion|Texturizer|GroundTexture|WaterColor|Shade|Image/i;

function parseGraph(text) {
  const root = JSON.parse(text);
  const T = root.Assets.$values[0].Terrain;
  const map = new Map();
  for (const [k, v] of Object.entries(T.Nodes)) {
    if (k === '$id') continue;
    map.set(Number(k), v);
  }
  const edges = [];
  for (const [, n] of map) {
    for (const p of n.Ports?.$values || []) {
      if (p.Record && p.Record.From !== undefined) {
        edges.push({ from: p.Record.From, to: p.Record.To, fromPort: p.Record.FromPort, toPort: p.Record.ToPort });
      }
    }
  }
  return { root, T, map, edges };
}

function findTerrainTerminal({ map, edges }) {
  const consumedByNonColor = new Set();
  for (const e of edges) {
    const dstType = map.get(e.to)?.$type || '';
    if (!COLORISH.test(dstType)) consumedByNonColor.add(e.from);
  }
  const cands = [];
  for (const [id, n] of map) {
    const t = n.$type || '';
    if (COLORISH.test(t)) continue;
    if (!consumedByNonColor.has(id)) cands.push({ id, n, t });
  }
  if (!cands.length) return null;
  const depth = (id, seen = new Set()) => {
    if (seen.has(id)) return 0;
    seen.add(id);
    const n = map.get(id);
    let best = 0;
    for (const p of n?.Ports?.$values || []) {
      if (p.Record?.From !== undefined && p.Record.From !== id) {
        best = Math.max(best, 1 + depth(p.Record.From, seen));
      }
    }
    return best;
  };
  cands.sort((a, b) => depth(b.id) - depth(a.id));
  return cands[0];
}

function maxNumericId(text) {
  let m = 0;
  const re = /"\$id": ?"(\d+)"/g;
  let hit;
  while ((hit = re.exec(text))) m = Math.max(m, parseInt(hit[1], 10));
  return m;
}

// 官方同款 Export 节点文本。nodeRef = 节点自身 $id(=maxRef+1),已知,直接写死。
function exportMemberText(srcId, newId, nodeRef) {
  let r = nodeRef;
  const id = () => String(++r);
  const nodeSelf = String(nodeRef);
  const P = (d) => ' '.repeat(12 + d * 2);
  const L = [];
  L.push(P(1) + '"' + newId + '": {' + '\r\n');
  L.push(P(2) + '"$id": "' + nodeSelf + '",' + '\r\n');
  L.push(P(2) + '"$type": "QuadSpinner.Gaea.Nodes.Export, Gaea.Nodes",' + '\r\n');
  L.push(P(2) + '"Id": ' + newId + ',' + '\r\n');
  L.push(P(2) + '"Name": "HeightmapExport",' + '\r\n');
  L.push(P(2) + '"Position": {' + '\r\n');
  L.push(P(3) + '"$id": "' + id() + '",' + '\r\n');
  L.push(P(3) + '"X": 34000,' + '\r\n');
  L.push(P(3) + '"Y": 26300' + '\r\n');
  L.push(P(2) + '},' + '\r\n');
  L.push(P(2) + '"Ports": {' + '\r\n');
  L.push(P(3) + '"$id": "' + id() + '",' + '\r\n');
  L.push(P(3) + '"$values": [' + '\r\n');
  // In 口(带 Record)
  L.push(P(3) + '{' + '\r\n');
  L.push(P(4) + '"$id": "' + id() + '",' + '\r\n');
  L.push(P(4) + '"Name": "In",' + '\r\n');
  L.push(P(4) + '"Type": "PrimaryIn",' + '\r\n');
  L.push(P(4) + '"IsExporting": true,' + '\r\n');
  L.push(P(4) + '"Record": {' + '\r\n');
  L.push(P(5) + '"$id": "' + id() + '",' + '\r\n');
  L.push(P(5) + '"From": ' + srcId + ',' + '\r\n');
  L.push(P(5) + '"To": ' + newId + ',' + '\r\n');
  L.push(P(5) + '"FromPort": "Out",' + '\r\n');
  L.push(P(5) + '"ToPort": "In",' + '\r\n');
  L.push(P(5) + '"IsValid": true' + '\r\n');
  L.push(P(4) + '},' + '\r\n');
  L.push(P(4) + '"Parent": {' + '\r\n');
  L.push(P(5) + '"$ref": "' + nodeSelf + '"' + '\r\n');
  L.push(P(4) + '}' + '\r\n');
  L.push(P(3) + '},' + '\r\n');
  // Out 口(官方要求每个节点都有 Out;漏掉会让 AssignBuildOrder 崩溃)
  L.push(P(3) + '{' + '\r\n');
  L.push(P(4) + '"$id": "' + id() + '",' + '\r\n');
  L.push(P(4) + '"Name": "Out",' + '\r\n');
  L.push(P(4) + '"Type": "PrimaryOut",' + '\r\n');
  L.push(P(4) + '"IsExporting": true,' + '\r\n');
  L.push(P(4) + '"Parent": {' + '\r\n');
  L.push(P(5) + '"$ref": "' + nodeSelf + '"' + '\r\n');
  L.push(P(4) + '}' + '\r\n');
  L.push(P(3) + '}' + '\r\n');
  L.push(P(3) + ']' + '\r\n');
  L.push(P(2) + '},' + '\r\n');
  L.push(P(2) + '"Modifiers": {' + '\r\n');
  L.push(P(3) + '"$id": "' + id() + '",' + '\r\n');
  L.push(P(3) + '"$values": []' + '\r\n');
  L.push(P(2) + '},' + '\r\n');
  L.push(P(2) + '"SaveDefinition": {' + '\r\n');
  L.push(P(3) + '"Filename": "Heightmap",' + '\r\n');
  L.push(P(3) + '"Format": "PNG16",' + '\r\n');
  L.push(P(3) + '"Enabled": true,' + '\r\n');
  L.push(P(3) + '"DisabledProfiles": []' + '\r\n');
  L.push(P(2) + '}' + '\r\n');
  L.push(P(1) + '}');
  return L.join('');
}

function main() {
  const [tpl, outPath] = process.argv.slice(2);
  const forceNode = (() => {
    const i = process.argv.indexOf('--node');
    return i >= 0 ? Number(process.argv[i + 1]) : null;
  })();
  if (!tpl || !outPath) {
    console.log('用法: node scripts/gaea-job-build.mjs "<模板名>" <out.terrain> [--node <Id>]');
    process.exit(1);
  }
  const tplPath = join(G2, tpl + '.terrain');
  if (!statSync(tplPath).isFile()) { console.error('找不到模板', tplPath); process.exit(1); }
  const text = readFileSync(tplPath, 'utf8');
  const { root, map, edges } = parseGraph(text);
  const maxId = Math.max(...map.keys());
  let src = forceNode
    ? (map.has(forceNode) ? { id: forceNode, n: map.get(forceNode) } : null)
    : findTerrainTerminal({ map, edges });
  if (!src) { console.error('找不到地形终端节点;可用 --node <Id> 指定'); process.exit(1); }
  const newId = maxId + 1;
  const nodeRef = maxNumericId(text) + 1;
  const member = exportMemberText(src.id, newId, nodeRef);
  const anchor = '            }\r\n          },\r\n          "Groups": {';
  const ai = text.indexOf(anchor);
  if (ai < 0) { console.error('找不到 Nodes 字典尾锚(非标准模板?)'); process.exit(1); }
  const out = text.slice(0, ai) + '            },\r\n' + member + '\r\n          },\r\n          "Groups": {' + text.slice(ai + anchor.length);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, out, 'utf8');
  JSON.parse(readFileSync(outPath, 'utf8')); // 校验 JSON
  const srcName = map.get(src.id)?.Name ?? ('#' + src.id);
  console.log(`[ok] ${tpl} → ${outPath}`);
  console.log(`    导出源 = ${srcName} (Id ${src.id}, ${(src.n.$type || '').split(',').pop()}),新节点 ${newId},节点 $ref=${nodeRef}`);
  console.log('    可在 Gaea GUI 打开预览,或直接 Swarm --Filename 构建');
}
main();
