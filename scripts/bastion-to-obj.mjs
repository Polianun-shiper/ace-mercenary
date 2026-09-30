#!/usr/bin/env node
// scripts/bastion-to-obj.mjs
//
// === 主舰「堡垒」FBX → 可内联的 OBJ + MTL (per user request: boss 在 file:// 下也要用真模型) ====
//
// 问题: public/models/airship/bastion.fbx 是 39.8MB 的单网格 FBX(内嵌贴图), 它只能
// 随行放在 <out>/assets/ 里走 http 取; 玩家**双击单文件**(file://)时读不到 → 引擎回退
// 程序化舰体, 用户看到的就是"空中战舰还是用原来的盒子"。
//
// 解法: 把它拆成**能被 build-single-html.mjs 内联的小资产**:
//   bastion.obj     文本几何(v/vt/vn + usemtl bastion), OBJExporter 导出
//   bastion.obj.gz  上面那份 gzip -9(OBJ 是纯 ASCII 浮点文本, 压缩率 4×+),
//                   运行时由 dreadnought.ts 的 fetchTextAsset(pako.inflate)解回文本
//   bastion.mtl     一个材质(map_Kd bastion_albedo.jpg)
//   bastion_albedo.jpg  内嵌贴图(浏览器里 canvas 提取, 见下)
//
// 内嵌贴图**不在这里导出**: Node 里 FBXLoader 解析内嵌贴图时会返回空 Texture(没有
// <img>/canvas 去解码 JPEG/PNG 字节), 所以贴图只能在真浏览器里用 canvas 提出来 ——
// 那份 JPEG(<=2048)是构建期产物, 生成后与 OBJ 一起内联。
//
// 坐标约定: OBJExporter 把顶点乘以 mesh.matrixWorld 再写出, 所以产物与
// scripts/_fbxinspect.mjs 量到的 FBX **世界包围盒一致**(119 × 90 × 38, 长轴 X)——
// 这正是 dreadnought.ts 的 buildDreadnoughtFromModel() 期待的姿态(它负责把长轴
// 转到 Z 并等比缩放), 两条加载路径(OBJ / FBX)因此可以共用同一个建模函数。
//
// 用法: node scripts/bastion-to-obj.mjs [fbx路径] [obj输出路径]
//   默认 public/models/airship/bastion.fbx → public/models/airship/bastion.obj

import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FBX_IN = process.argv[2] || join(ROOT, 'public/models/airship/bastion.fbx');
const OBJ_OUT = process.argv[3] || join(ROOT, 'public/models/airship/bastion.obj');
const MTL_OUT = OBJ_OUT.replace(/\.obj$/i, '.mtl');
const TEX_NAME = 'bastion_albedo.jpg';
const MAT_NAME = 'bastion';

// --- Node 里的极简 DOM stub(与 scripts/_fbxinspect.mjs 同一套) ------------------
// FBXLoader 建贴图时会用到 document/window.URL, 这里只求几何信息: 贴图给个空 Texture,
// 避免它真去解码图片字节。
globalThis.document = globalThis.document ?? {
  createElementNS: () => ({ style: {}, getContext: () => null, width: 0, height: 0 }),
  createElement: () => ({ style: {}, getContext: () => null, width: 0, height: 0 }),
};
globalThis.window = globalThis.window ?? { URL: { createObjectURL: () => 'about:blank', revokeObjectURL: () => {} } };
THREE.TextureLoader.prototype.load = function () { return new THREE.Texture(); };

console.log(`[bastion-to-obj] 读 ${FBX_IN}`);
const buf = readFileSync(FBX_IN);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const t0 = Date.now();
const obj = new FBXLoader().parse(ab, '');
obj.updateMatrixWorld(true);
console.log(`[bastion-to-obj] FBX 解析 ${Date.now() - t0}ms`);

// 材质名必须固定: OBJExporter 写 `usemtl <material.name>`, OBJLoader 之后按这个名字查
// MTL 定义。原始 FBX 的材质名不确定, 这里统一改成 'bastion'(只有 1 个材质)。
let meshes = 0, verts = 0, tris = 0, uvCount = 0, normalCount = 0, skipped = 0;
obj.traverse((o) => {
  if (!o.isMesh) return;
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  // OBJExporter 只认单个 material(= 我们的 OBJ 只有 1 个材质); 多材质网格会被它按
  // 第一个材质写, 所以这里先检查, 有意外就如实报告而不是静默丢材质。
  if (mats.length > 1) skipped++;
  for (const m of mats) if (m) m.name = MAT_NAME;
  const g = o.geometry;
  meshes++;
  verts += g.attributes.position ? g.attributes.position.count : 0;
  tris += g.index ? g.index.count / 3 : (g.attributes.position ? g.attributes.position.count / 3 : 0);
  if (g.attributes.uv) uvCount += g.attributes.uv.count;
  if (g.attributes.normal) normalCount += g.attributes.normal.count;
});
if (skipped) console.warn(`[bastion-to-obj] 警告: ${skipped} 个多材质网格(OBJExporter 只导第一个材质)`);

const t1 = Date.now();
let text = new OBJExporter().parse(obj);
console.log(`[bastion-to-obj] OBJExporter ${Date.now() - t1}ms`);

// OBJExporter 不写 mtllib(它只导几何), 手工补一行让 OBJLoader 能找到材质定义。
const header = `# bastion (airship) — 由 scripts/bastion-to-obj.mjs 从 bastion.fbx 导出\n` +
  `# 单网格 ${verts} 顶点 / ${tris} 三角面 / 1 材质 ${MAT_NAME}; 顶点已烘到世界坐标(长轴 X)\n` +
  `mtllib ${MTL_OUT.split(/[\\/]/).pop()}\n`;
if (!/^\s*mtllib\b/m.test(text)) text = header + text;
writeFileSync(OBJ_OUT, text, 'utf8');

const mtl = `# bastion (airship) — scripts/bastion-to-obj.mjs 生成\n` +
  `# 内嵌贴图在浏览器里用 canvas 提取为 ${TEX_NAME}(见构建说明)\n` +
  `newmtl ${MAT_NAME}\n` +
  `Ka 1.000 1.000 1.000\n` +
  `Kd 1.000 1.000 1.000\n` +
  `Ks 0.000 0.000 0.000\n` +
  `Ns 10.0\n` +
  `d 1.0\n` +
  `illum 2\n` +
  `map_Kd ${TEX_NAME}\n`;
writeFileSync(MTL_OUT, mtl, 'utf8');

const box = new THREE.Box3().setFromObject(obj);
const size = box.getSize(new THREE.Vector3());
console.log(JSON.stringify({
  fbx: FBX_IN,
  obj: OBJ_OUT,
  mtl: MTL_OUT,
  meshes, verts, tris: Math.round(tris), uvCount, normalCount,
  objBytes: Buffer.byteLength(text),
  bboxWorld: { min: box.min.toArray().map((x) => +x.toFixed(1)), max: box.max.toArray().map((x) => +x.toFixed(1)) },
  size: size.toArray().map((x) => +x.toFixed(1)),
  longestAxis: size.x >= size.y && size.x >= size.z ? 'X' : (size.y >= size.z ? 'Y' : 'Z'),
}, null, 1));
