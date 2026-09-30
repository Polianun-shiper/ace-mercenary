// === UE5 Landscape 对标地形网格 v2 (per user request: 新地形网格系统) ===
// Replaces the old "per-vertex noise displacement + hard LOD cuts + skirt"
// terrain with a UE5-style continuous-LOD system:
//
//   1. HEIGHTMAP DATA SOURCE — every chunk bakes its LOD0-resolution height
//      field once (Float32Array sampled from the shared height function).
//      All LOD meshes sample the SAME heightmap (bilinear), so equal-LOD
//      neighbours agree EXACTLY on shared edges (no cracks, no skirts).
//   2. CONTINUOUS LOD MORPHING — when adjacent chunks render at different
//      LOD levels, the FINER chunk's edge band (3 cells) is pulled down to
//      the coarser neighbour's edge line (UE5 LOD morphing). No popping,
//      no seams; the skirt becomes a rarely-seen fallback.
//   3. Splat weights are baked once per chunk at LOD0 resolution and
//      stride-sampled by the LOD meshes — identical layer blend at all LODs.
//
// The chunk grid layout / streaming interface (center/gx/gz/meshes/skirt)
// is unchanged so the engine's ring streaming and collision (sampleHeight)
// keep working untouched.

import * as THREE from 'three';

export interface TerrainV2ChunkInfo {
  center: THREE.Vector3;
  gx: number;
  gz: number;
  meshes: THREE.Mesh[]; // [LOD0..LOD3]
  skirt: THREE.Mesh | undefined;
  /** UE5 continuous-LOD morph. `neighbors` = [N, E, S, W] chunk+level. */
  setLOD(level: number, neighbors: ({ chunk: TerrainV2ChunkInfo; level: number } | null)[]): void;
  // Internal (shared by neighbour morph sampling):
  _hmap: Float32Array;
  _grid0: number;
  _cell: number;
  _minX: number;
  _minZ: number;
}

export interface TerrainV2Options {
  size: number;
  chunkCount: number;
  s0: number; // LOD0 segments per chunk edge
  heightAt: (x: number, z: number) => number;
  /** Per-vertex layer weights [sand, grass, rock, snow] at a world point. */
  splatAt: (x: number, z: number) => [number, number, number, number];
  /** Optional heightmap-based ambient occlusion 0..1 at a world point.
   *  Missing → neutral (1.0): geometry still carries the `ao` attribute so
   *  the layered shader stays uniform across terrain styles. */
  aoAt?: (x: number, z: number) => number;
  material: THREE.Material;
  buildSkirt: (cx: number, cz: number) => THREE.Mesh | null;
  yieldToBrowser?: () => Promise<void>;
}

// Bilinear sample of a chunk's heightmap at world coords (edge-exact: at
// the chunk boundary the interpolation degenerates to the border texel).
function sampleHmap(hmap: Float32Array, grid0: number, cell: number, minX: number, minZ: number, wx: number, wz: number): number {
  const fx = THREE.MathUtils.clamp((wx - minX) / cell, 0, grid0 - 1);
  const fy = THREE.MathUtils.clamp((wz - minZ) / cell, 0, grid0 - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, grid0 - 1), y1 = Math.min(y0 + 1, grid0 - 1);
  const tx = fx - x0, ty = fy - y0;
  const h00 = hmap[x0 + y0 * grid0];
  const h10 = hmap[x1 + y0 * grid0];
  const h01 = hmap[x0 + y1 * grid0];
  const h11 = hmap[x1 + y1 * grid0];
  const a = h00 + (h10 - h00) * tx;
  const b = h01 + (h11 - h01) * tx;
  return a + (b - a) * ty;
}

// LOD grid layout: stride = 2^L cells, grid = floor(s0/stride)+1 vertices,
// spacing = s0/(grid-1) cells per segment (exact edge-to-edge coverage).
function lodLayout(s0: number, L: number): { grid: number; stride: number; spacing: number } {
  const stride = 1 << L;
  const grid = Math.floor(s0 / stride) + 1;
  return { grid, stride, spacing: s0 / (grid - 1) };
}

// Morph band width in cells (from the chunk edge inward).
const MORPH_BAND = 3;

interface MorphData {
  pos: THREE.BufferAttribute;
  baseY: Float32Array;
  bands: { idx: number; edge: 0 | 1 | 2 | 3; factor: number }[];
}

export async function buildTerrainV2(opts: TerrainV2Options): Promise<{
  group: THREE.Group;
  chunks: TerrainV2ChunkInfo[];
}> {
  const { size, chunkCount, s0, heightAt, splatAt, aoAt, material, buildSkirt, yieldToBrowser } = opts;
  const aoFn = aoAt ?? (() => 1); // 中性 AO:几何仍带 ao attribute,shader 一致
  const chunkSize = size / chunkCount;
  const cell = chunkSize / s0;
  const grid0 = s0 + 1;
  const group = new THREE.Group();
  const chunks: TerrainV2ChunkInfo[] = [];
  const YIELD_EVERY = 8192;
  let vertsSinceYield = 0;
  const yieldFn = yieldToBrowser ?? (async () => {});

  for (let gz = 0; gz < chunkCount; gz++) {
    for (let gx = 0; gx < chunkCount; gx++) {
      const cx = -size / 2 + (gx + 0.5) * chunkSize;
      const cz = -size / 2 + (gz + 0.5) * chunkSize;
      const minX = cx - chunkSize / 2;
      const minZ = cz - chunkSize / 2;

      // === 1. Bake LOD0 heightmap + splat weights + macro AO (once per chunk) ===
      const hmap = new Float32Array(grid0 * grid0);
      const splat = new Float32Array(grid0 * grid0 * 4);
      const ao = new Float32Array(grid0 * grid0);
      for (let iy = 0; iy < grid0; iy++) {
        const wz = minZ + iy * cell;
        for (let ix = 0; ix < grid0; ix++) {
          const wx = minX + ix * cell;
          const h = heightAt(wx, wz);
          hmap[ix + iy * grid0] = h;
          const w = splatAt(wx, wz);
          const o = (ix + iy * grid0) * 4;
          splat[o] = w[0];
          splat[o + 1] = w[1];
          splat[o + 2] = w[2];
          splat[o + 3] = w[3];
          ao[ix + iy * grid0] = aoFn(wx, wz);
          vertsSinceYield++;
          if (vertsSinceYield >= YIELD_EVERY) {
            vertsSinceYield = 0;
            await yieldFn();
          }
        }
      }

      // === 2. Build the 4 LOD meshes from the heightmap ===
      const meshes: THREE.Mesh[] = [];
      const morphData: (MorphData | null)[] = [null, null, null, null];
      for (let L = 0; L < 4; L++) {
        const { grid, stride, spacing } = lodLayout(s0, L);
        const n = grid * grid;
        const positions = new Float32Array(n * 3);
        const uvs = new Float32Array(n * 2);
        const splatArr = new Float32Array(n * 4);
        const aoArr = new Float32Array(n);
        const baseY = new Float32Array(n);
        // Bilinear helper over the LOD0-baked fields (splat×4 / ao×1).
        const sampleField = (field: Float32Array, comps: number, sx: number, sy: number, out: number[] | Float32Array, o: number) => {
          const x0 = Math.min(Math.floor(sx), s0);
          const y0 = Math.min(Math.floor(sy), s0);
          const x1 = Math.min(x0 + 1, s0);
          const y1 = Math.min(y0 + 1, s0);
          const tx = sx - x0, ty = sy - y0;
          for (let c = 0; c < comps; c++) {
            const w00 = field[(x0 + y0 * grid0) * comps + c];
            const w10 = field[(x1 + y0 * grid0) * comps + c];
            const w01 = field[(x0 + y1 * grid0) * comps + c];
            const w11 = field[(x1 + y1 * grid0) * comps + c];
            const a = w00 + (w10 - w00) * tx;
            const b = w01 + (w11 - w01) * tx;
            out[o + c] = a + (b - a) * ty;
          }
        };
        for (let j = 0; j < grid; j++) {
          const wz = minZ + j * spacing * cell;
          for (let i = 0; i < grid; i++) {
            const wx = minX + i * spacing * cell;
            const h = sampleHmap(hmap, grid0, cell, minX, minZ, wx, wz);
            const idx = i + j * grid;
            positions[idx * 3] = wx;
            positions[idx * 3 + 1] = h;
            positions[idx * 3 + 2] = wz;
            baseY[idx] = h;
            uvs[idx * 2] = i / (grid - 1);
            uvs[idx * 2 + 1] = j / (grid - 1);
            // Splat weights + AO stride-sampled from the LOD0 bake.
            const cx0 = i * spacing, cy0 = j * spacing;
            const sx = THREE.MathUtils.clamp(cx0, 0, s0);
            const sy = THREE.MathUtils.clamp(cy0, 0, s0);
            sampleField(splat, 4, sx, sy, splatArr, idx * 4);
            sampleField(ao, 1, sx, sy, aoArr, idx);
            vertsSinceYield++;
            if (vertsSinceYield >= YIELD_EVERY) {
              vertsSinceYield = 0;
              await yieldFn();
            }
          }
        }
        // Index buffer (grid-1)² quads → 2 triangles each.
        const indices = new Uint32Array((grid - 1) * (grid - 1) * 6);
        let io = 0;
        for (let j = 0; j < grid - 1; j++) {
          for (let i = 0; i < grid - 1; i++) {
            const a = i + j * grid;
            const b = a + 1;
            const c = a + grid;
            const d = c + 1;
            indices[io++] = a; indices[io++] = c; indices[io++] = b;
            indices[io++] = b; indices[io++] = c; indices[io++] = d;
          }
        }
        const geom = new THREE.BufferGeometry();
        const posAttr = new THREE.BufferAttribute(positions, 3);
        geom.setAttribute('position', posAttr);
        geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        geom.setAttribute('uv2', new THREE.BufferAttribute(new Float32Array(uvs), 2));
        geom.setAttribute('splat', new THREE.BufferAttribute(splatArr, 4));
        // === 高度图 AO(per user request):0..1,shader 里只压间接光 ===
        geom.setAttribute('ao', new THREE.BufferAttribute(aoArr, 1));
        geom.setIndex(new THREE.BufferAttribute(indices, 1));
        geom.computeVertexNormals();
        const mesh = new THREE.Mesh(geom, material);
        mesh.receiveShadow = true;
        mesh.castShadow = L === 0;
        mesh.frustumCulled = true;
        mesh.visible = L === 0;
        meshes.push(mesh);

        // === 3. UE5 morph band metadata (per LOD mesh) ===
        // Vertices within MORPH_BAND cells of an edge get a fade factor;
        // the FINER chunk's band conforms to the coarser neighbour's line.
        if (L > 0) {
          const bands: MorphData['bands'] = [];
          const addBand = (edge: 0 | 1 | 2 | 3) => {
            // Edge 0 = west (x=0), 1 = east (x=grid-1), 2 = south (z=0), 3 = north (z=grid-1)
            for (let k = 0; k < grid; k++) {
              for (let d = 0; d < MORPH_BAND; d++) {
                const factor = 1 - d / MORPH_BAND;
                let idx: number;
                if (edge === 0) idx = d + k * grid;           // west column
                else if (edge === 1) idx = (grid - 1 - d) + k * grid; // east column
                else if (edge === 2) idx = k + d * grid;      // south row
                else idx = k + (grid - 1 - d) * grid;         // north row
                if (k <= d || k >= grid - 1 - d) continue;    // skip corners (handled by their own edge)
                bands.push({ idx, edge, factor });
              }
            }
          };
          addBand(0); addBand(1); addBand(2); addBand(3);
          morphData[L] = { pos: posAttr, baseY, bands };
        }
      }

      // === 4. Skirt (fallback — morphing makes it rarely visible) ===
      const skirt = buildSkirt ? buildSkirt(cx, cz) : null;

      const chunk: TerrainV2ChunkInfo = {
        center: new THREE.Vector3(cx, 0, cz),
        gx,
        gz,
        meshes,
        skirt: skirt ?? undefined,
        _hmap: hmap,
        _grid0: grid0,
        _cell: cell,
        _minX: minX,
        _minZ: minZ,
        setLOD: (level, neighbors) => {
          const md = morphData[level];
          if (!md) return;
          const pos = md.pos;
          const arr = pos.array as Float32Array;
          let changed = false;
          // neighbours arrive as [N, E, S, W]; my band edges are 0=W 1=E 2=S 3=N.
          const NB_MAP = [3, 1, 2, 0];
          for (const b of md.bands) {
            const nb = neighbors[NB_MAP[b.edge]];
            let y = md.baseY[b.idx];
            if (nb && level < nb.level) {
              // I'm finer than the neighbour: pull my band down to ITS
              // coarse edge line (linear between its edge vertices).
              const Y = nb.chunk;
              const wx = arr[b.idx * 3];
              const wz = arr[b.idx * 3 + 2];
              const gY = lodLayout(Y._grid0 - 1, nb.level).grid;
              const spacingY = (Y._grid0 - 1) / (gY - 1);
              let t: number, k0: number, k1: number, frac: number;
              let h0: number, h1: number;
              if (b.edge === 0 || b.edge === 1) {
                // shared edge varies along Z
                t = THREE.MathUtils.clamp((wz - Y._minZ) / Y._cell, 0, Y._grid0 - 1);
                k0 = Math.min(gY - 1, Math.floor(t / spacingY));
                k1 = Math.min(gY - 1, k0 + 1);
                frac = k1 === k0 ? 0 : (t - k0 * spacingY) / (spacingY || 1);
                const ix = b.edge === 0 ? Y._grid0 - 1 : 0; // my west ↔ its east
                h0 = sampleHmap(Y._hmap, Y._grid0, Y._cell, Y._minX, Y._minZ, Y._minX + ix * Y._cell, Y._minZ + k0 * spacingY * Y._cell);
                h1 = sampleHmap(Y._hmap, Y._grid0, Y._cell, Y._minX, Y._minZ, Y._minX + ix * Y._cell, Y._minZ + k1 * spacingY * Y._cell);
              } else {
                // shared edge varies along X
                t = THREE.MathUtils.clamp((wx - Y._minX) / Y._cell, 0, Y._grid0 - 1);
                k0 = Math.min(gY - 1, Math.floor(t / spacingY));
                k1 = Math.min(gY - 1, k0 + 1);
                frac = k1 === k0 ? 0 : (t - k0 * spacingY) / (spacingY || 1);
                const iy = b.edge === 2 ? Y._grid0 - 1 : 0; // my south ↔ its north
                h0 = sampleHmap(Y._hmap, Y._grid0, Y._cell, Y._minX, Y._minZ, Y._minX + k0 * spacingY * Y._cell, Y._minZ + iy * Y._cell);
                h1 = sampleHmap(Y._hmap, Y._grid0, Y._cell, Y._minX, Y._minZ, Y._minX + k1 * spacingY * Y._cell, Y._minZ + iy * Y._cell);
              }
              const target = h0 + (h1 - h0) * frac;
              y = md.baseY[b.idx] + (target - md.baseY[b.idx]) * b.factor;
            }
            if (y !== arr[b.idx * 3 + 1]) {
              arr[b.idx * 3 + 1] = y;
              changed = true;
            }
          }
          if (changed) {
            pos.needsUpdate = true;
            const g = (meshes[level] as THREE.Mesh).geometry;
            g.computeVertexNormals();
            (g.attributes.normal as THREE.BufferAttribute).needsUpdate = true;
          }
        },
      };
      group.add(meshes[0], meshes[1], meshes[2], meshes[3]);
      if (skirt) group.add(skirt);
      chunks.push(chunk);
    }
  }

  return { group, chunks };
}
