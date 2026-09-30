// === Bake f16.obj → binary geometry (per user request: 优化加载速度) ===
// The 10.9MB text OBJ only needs position data at runtime (normalize() strips
// everything else). This script pre-parses the OBJ at BUILD time and emits
// three binary files (positions/normals/indices) that load ~55% smaller and
// skip the 0.5-2s main-thread OBJ parse at mission start.
//
// The bake replicates the runtime normalize() pipeline exactly:
//   1. parse v/vt/f lines → non-indexed triangle soup
//   2. center + scale so max dimension = 10 (same math as models.ts normalize)
//   3. per-triangle face normals (flat shading — identical to the current
//      OBJ path, which strips vn and calls computeVertexNormals on a
//      non-indexed geometry)
//   4. merge duplicate (position + normal + uv) vertices → indexed mesh
//
// UVs are baked too (PBR per user request) so f16 keeps its Blender unwrap —
// without them the PBR texture system falls back to a plain material.
//
// Output: public/models/f16.positions.bin (Float32Array)
//         public/models/f16.normals.bin   (Float32Array)
//         public/models/f16.indices.bin    (Uint32Array)
//         public/models/f16.uvs.bin        (Float32Array)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'public', 'models', 'f16.obj');
const outPos = path.join(root, 'public', 'models', 'f16.positions.bin');
const outNor = path.join(root, 'public', 'models', 'f16.normals.bin');
const outIdx = path.join(root, 'public', 'models', 'f16.indices.bin');
const outUv = path.join(root, 'public', 'models', 'f16.uvs.bin');

// --- 1. Parse OBJ (v, vt, f only) ---
const text = fs.readFileSync(src, 'utf8');
const rawPos = [];
const rawUv = [];
const rawFaces = []; // each face = list of {v, t} indices (1-based, may be negative)

for (const line of text.split('\n')) {
  if (line.startsWith('v ')) {
    const p = line.split(/\s+/).slice(1, 4).map(Number);
    rawPos.push(p[0], p[1], p[2]);
  } else if (line.startsWith('vt ')) {
    const t = line.split(/\s+/).slice(1, 3).map(Number);
    rawUv.push(t[0], t[1]);
  } else if (line.startsWith('f ')) {
    const parts = line.trim().split(/\s+/).slice(1);
    if (parts.length < 3) continue;
    const face = parts.map((tok) => {
      // "v/vt/vn" or "v//vn" or "v"
      const fields = tok.split('/');
      const v = parseInt(fields[0], 10);
      const t = fields[1] !== undefined && fields[1] !== '' ? parseInt(fields[1], 10) : 0;
      return {
        v: v < 0 ? rawPos.length / 3 + v + 1 : v,
        t: t < 0 ? rawUv.length / 2 + t + 1 : t,
      };
    });
    rawFaces.push(face);
  }
}
const rawVertexCount = rawPos.length / 3;
console.log(`parsed ${rawVertexCount} vertices, ${rawUv.length / 2} uvs, ${rawFaces.length} faces`);

// --- 2. Expand faces into non-indexed triangle soup ---
const triPos = [];
const triUv = [];
const uvValid = rawUv.length > 0;
for (const face of rawFaces) {
  // Fan triangulation for n-gons.
  for (let i = 1; i < face.length - 1; i++) {
    for (const vi of [face[0], face[i], face[i + 1]]) {
      triPos.push(rawPos[(vi.v - 1) * 3], rawPos[(vi.v - 1) * 3 + 1], rawPos[(vi.v - 1) * 3 + 2]);
      if (uvValid && vi.t > 0) {
        triUv.push(rawUv[(vi.t - 1) * 2], rawUv[(vi.t - 1) * 2 + 1]);
      } else {
        triUv.push(0, 0);
      }
    }
  }
}
const triCount = triPos.length / 9;
console.log(`expanded to ${triCount} triangles (${triPos.length / 3} soup vertices)`);

// --- 3. Center + scale to max dimension = 10 (mirror of models.ts normalize) ---
let minX = Infinity, minY = Infinity, minZ = Infinity;
let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
for (let i = 0; i < triPos.length; i += 3) {
  minX = Math.min(minX, triPos[i]); maxX = Math.max(maxX, triPos[i]);
  minY = Math.min(minY, triPos[i + 1]); maxY = Math.max(maxY, triPos[i + 1]);
  minZ = Math.min(minZ, triPos[i + 2]); maxZ = Math.max(maxZ, triPos[i + 2]);
}
const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
const s = 10 / size;
for (let i = 0; i < triPos.length; i += 3) {
  triPos[i] = (triPos[i] - cx) * s;
  triPos[i + 1] = (triPos[i + 1] - cy) * s;
  triPos[i + 2] = (triPos[i + 2] - cz) * s;
}
console.log(`normalized: size ${size.toFixed(2)} → 10, center (${cx.toFixed(2)}, ${cy.toFixed(2)}, ${cz.toFixed(2)})`);

// --- 4. Per-triangle face normals (flat shading) ---
const triNor = new Array(triPos.length).fill(0);
for (let t = 0; t < triCount; t++) {
  const o = t * 9;
  const ax = triPos[o + 3] - triPos[o], ay = triPos[o + 4] - triPos[o + 1], az = triPos[o + 5] - triPos[o + 2];
  const bx = triPos[o + 6] - triPos[o], by = triPos[o + 7] - triPos[o + 1], bz = triPos[o + 8] - triPos[o + 2];
  let nx = ay * bz - az * by;
  let ny = az * bx - ax * bz;
  let nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  for (let k = 0; k < 3; k++) {
    triNor[o + k * 3] = nx;
    triNor[o + k * 3 + 1] = ny;
    triNor[o + k * 3 + 2] = nz;
  }
}

// --- 5. Merge duplicate (position + normal + uv) vertices → indexed ---
const key = (i) => {
  const o = i * 3;
  return (
    Math.round(triPos[o] * 1000) + ',' + Math.round(triPos[o + 1] * 1000) + ',' + Math.round(triPos[o + 2] * 1000) +
    '|' +
    Math.round(triNor[o] * 100) + ',' + Math.round(triNor[o + 1] * 100) + ',' + Math.round(triNor[o + 2] * 100) +
    '|' +
    Math.round(triUv[i * 2] * 1000) + ',' + Math.round(triUv[i * 2 + 1] * 1000)
  );
};
const map = new Map();
const outPosArr = [];
const outNorArr = [];
const outUvArr = [];
const outIdxArr = [];
for (let i = 0; i < triPos.length / 3; i++) {
  const k = key(i);
  let idx = map.get(k);
  if (idx === undefined) {
    idx = outPosArr.length / 3;
    map.set(k, idx);
    outPosArr.push(triPos[i * 3], triPos[i * 3 + 1], triPos[i * 3 + 2]);
    outNorArr.push(triNor[i * 3], triNor[i * 3 + 1], triNor[i * 3 + 2]);
    outUvArr.push(triUv[i * 2], triUv[i * 2 + 1]);
  }
  outIdxArr.push(idx);
}
console.log(`merged ${triPos.length / 3} soup vertices → ${outPosArr.length / 3} indexed vertices, ${outIdxArr.length / 3} triangles`);

// --- 6. Write binary files ---
fs.writeFileSync(outPos, Buffer.from(new Float32Array(outPosArr).buffer));
fs.writeFileSync(outNor, Buffer.from(new Float32Array(outNorArr).buffer));
fs.writeFileSync(outIdx, Buffer.from(new Uint32Array(outIdxArr).buffer));
fs.writeFileSync(outUv, Buffer.from(new Float32Array(outUvArr).buffer));
const mb = (b) => (b / 1024 / 1024).toFixed(2) + " MB";
console.log(`wrote:`);
console.log(`  f16.positions.bin ${mb(fs.statSync(outPos).size)} (${outPosArr.length / 3} verts)`);
console.log(`  f16.normals.bin   ${mb(fs.statSync(outNor).size)}`);
console.log(`  f16.indices.bin    ${mb(fs.statSync(outIdx).size)} (${outIdxArr.length / 3} tris)`);
console.log(`  f16.uvs.bin        ${mb(fs.statSync(outUv).size)}`);
console.log(`  source f16.obj was ${mb(fs.statSync(src).size)}`);
