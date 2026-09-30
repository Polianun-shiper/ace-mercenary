import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import type { AircraftModel } from './types';
import { assetUrl } from './asset-url';
import { rigSurface, rigNozzle } from './aircraft-rig';
// === PBR 贴图系统 (per user request: 现代 PBR 渲染) ===
// Aircraft get full procedural PBR texture sets (albedo/normal/metallic/
// roughness/ao/emissive) keyed by (model, paint scheme, colour). The colour
// argument stays the tint — MeshStandardMaterial.color multiplies the map.
import { getAircraftTextureSet } from './pbr/texture-sets';
import { buildPBRMaterial, ensureTriplanarUVs, AIRCRAFT_ENV_MAP_INTENSITY, AIRCRAFT_COAT, AIRCRAFT_COAT_ROUGHNESS, makeCoatedMaterial } from './pbr/materials';
import { getTextureManager } from './pbr/texture-manager';
// === 延迟渲染管线 (per user request: 延迟渲染 + 现代化光照) ===
import { isDeferredActive, DEFERRED_LAYER } from './pbr/deferred';

// Cache loaded geometries so we don't reparse the OBJ on every spawn.
const geometryCache: Record<string, AircraftGeometryInfo> = {};
// === Shared LOW-poly proxy geometries (per user request: 单位 LOD) ===
// For distance LOD: the full OBJ models are ~100k triangles (f16). Beyond a
// few km that's wasted — each aircraft swaps to a shared procedural
// (~300-tri) geometry, built once per model and reused by every instance.
const lowGeomCache: Partial<Record<AircraftModel, THREE.BufferGeometry>> = {};
export function getLowGeometry(model: AircraftModel): THREE.BufferGeometry {
  if (!lowGeomCache[model]) {
    lowGeomCache[model] = buildProceduralGeometry(model);
    // Shared across missions — engine.dispose() must NOT free it.
    lowGeomCache[model]!.userData.shared = true;
  }
  return lowGeomCache[model]!;
}

/**
 * 联机用低面数机体 (per user request: 队友和敌人的机体都使用低面数模型)。
 *
 * 为什么联机单位一律用低模:
 *   · 真实机体(F-16C 36MB / MiG-29 37MB)每个实例都要独立材质与贴图消费,
 *     8 人对局 + 僚机中队会有十几个实例 —— 显存与 draw call 都吃不消;
 *   · 远端单位本来就是**网络插值**出来的, 细节在高速运动中几乎看不见;
 *   · 低模是**共享几何**(每个机型只建一次, ~300 三角面), 实例只花一个 draw call。
 *
 * 阵营配色沿用雷达/HUD 的语义: 敌红 / 友青蓝 / 中立白。
 * 这样"切阵营"时机体颜色也会变, IFF 翻转一眼可见(与测试 bot 行为一致)。
 *
 * @param model 机型(决定低模外形)
 * @param faction 阵营(决定颜色)
 */
export function buildLowPolyAircraft(model: AircraftModel, faction: 'player' | 'ally' | 'enemy' | 'neutral'): THREE.Mesh {
  const color = faction === 'enemy' ? 0xd23a2a
    : faction === 'neutral' ? 0xdddddd
    : 0x4fc3f7;
  const mat = new THREE.MeshStandardMaterial({ color, metalness: 0.45, roughness: 0.5 });
  const mesh = new THREE.Mesh(getLowGeometry(model), mat);
  // Phase E1: 与玩家机同量级的缩放 —— 玩家机已统一到 AI 尺度表(1.4), 这里同步 2.2 → 1.4,
  // 否则联机里"远端玩家机/自家中队僚机"会比本机大 1.571×。
  mesh.scale.setScalar(1.4);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** 依据阵营重上低模颜色 —— 切阵营时调用(IFF 翻转的视觉体现)。 */
export function recolorLowPolyAircraft(mesh: THREE.Object3D, faction: 'player' | 'ally' | 'enemy' | 'neutral'): void {
  const color = faction === 'enemy' ? 0xd23a2a
    : faction === 'neutral' ? 0xdddddd
    : 0x4fc3f7;
  mesh.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.MeshStandardMaterial;
    if (mat && mat.color) mat.color.setHex(color);
  });
}

// Some models have their nose pointing -Z in the source OBJ. We standardize so
// every aircraft's nose is at +Z (matching our forward = +Z convention).
const NOSE_REORIENT: Record<string, boolean> = {
  b52: true,
  // === AC-130 flies the B-52 airframe (per user request) ===
  // The B-52 OBJ is stored nose-first -Z, so the AC-130 (which reuses that
  // model) must flip the same way — otherwise nose/aft are reversed.
  ac130: true,
};

// Engine count per aircraft.
const ENGINE_LAYOUT: Record<string, { count: 1 | 2 | 4 | 8; lateralSpacing: number; verticalOffset: number }> = {
  f16: { count: 1, lateralSpacing: 0, verticalOffset: -0.05 },
  // === F-16C 真实模型 (per user request: 完全替换原 F-16) ===
  // 与 f16 同一副 F-16C 机体,单发布局相同。
  f16c: { count: 1, lateralSpacing: 0, verticalOffset: -0.05 },
  // === F-16X testbed reuses the F-16 single-engine layout (per user request) ===
  'f16-test': { count: 1, lateralSpacing: 0, verticalOffset: -0.05 },
  b52: { count: 8, lateralSpacing: 1.4, verticalOffset: -0.2 },
  // Procedural aircraft use their own layouts.
  su35: { count: 2, lateralSpacing: 1.2, verticalOffset: -0.1 },
  a10: { count: 2, lateralSpacing: 1.6, verticalOffset: -0.2 },
  f15: { count: 2, lateralSpacing: 1.0, verticalOffset: -0.1 },
  tu95: { count: 4, lateralSpacing: 2.4, verticalOffset: -0.3 },
  // New aircraft
  ea18g: { count: 2, lateralSpacing: 1.2, verticalOffset: -0.1 },
  ac130: { count: 4, lateralSpacing: 1.8, verticalOffset: -0.2 },
  f117:  { count: 2, lateralSpacing: 0.5, verticalOffset: -0.05 },
  e3:    { count: 4, lateralSpacing: 1.6, verticalOffset: -0.2 },
};

const objLoader = new OBJLoader();

export interface AircraftGeometryInfo {
  geometry: THREE.BufferGeometry;
  // === 扫描用几何 (per fix: 后燃器/凝结云的"自动适配"以前量的是空占位几何) ========
  // 多材质真实模型(F-16C/MiG-29)渲染走几十个 sub-mesh, geometry 只是个空占位;
  // 把真正要量的 sub-mesh 几何列在这里, deriveNozzleMetrics/deriveWingStations
  // 就会去量它们(见 nozzle-metrics.ts 的 positionArrays)。
  scanGeometries?: THREE.BufferGeometry[];
  tailZ: number;
  noseZ: number;
  halfSpan: number;
  enginePositions: THREE.Vector3[];
  // Whether this geometry was procedurally generated.
  procedural: boolean;
}

function normalize(obj: THREE.Object3D): THREE.BufferGeometry {
  const geoms: THREE.BufferGeometry[] = [];
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      const g = mesh.geometry.clone();
      g.applyMatrix4(mesh.matrixWorld);
      // Keep uv — the OBJ files carry full vt layouts and the PBR texture
      // system needs them (PBR per user request). Everything else is
      // dropped and normals are recomputed below anyway.
      for (const key of Object.keys(g.attributes)) {
        if (key !== 'position' && key !== 'uv') g.deleteAttribute(key);
      }
      geoms.push(g);
    }
  });
  if (geoms.length === 0) return new THREE.BufferGeometry();
  obj.updateMatrixWorld(true);
  const merged = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms);
  merged.computeVertexNormals();
  merged.computeBoundingBox();
  const box = merged.boundingBox!;
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);
  merged.translate(-center.x, -center.y, -center.z);
  const maxDim = Math.max(size.x, size.y, size.z);
  const s = 10 / maxDim;
  merged.scale(s, s, s);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

function mergeGeometries(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let totalVerts = 0;
  for (const g of geoms) totalVerts += g.attributes.position.count;
  // Merge UVs alongside positions when every part has them (PBR support).
  const hasUv = geoms.every((g) => g.attributes.uv);
  const positions = new Float32Array(totalVerts * 3);
  const uvs = hasUv ? new Float32Array(totalVerts * 2) : null;
  let offset = 0;
  for (const g of geoms) {
    positions.set(g.attributes.position.array as Float32Array, offset);
    if (uvs) uvs.set(g.attributes.uv.array as Float32Array, (offset / 3) * 2);
    offset += g.attributes.position.count * 3;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (uvs) merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return merged;
}

// === Procedural aircraft builders ===
// For aircraft without .obj assets, we build a low-poly silhouette from primitives.
// Each returns a BufferGeometry with nose at +Z, tail at -Z, normalized to ~10 units long.
// === Exported (per user request: 解决模型加载不出来的问题) ===
// buildProceduralGeometry is now exported so the engine's loadAssets() can
// use it as a last-resort fallback if the OBJ file fails to load AND the
// normal try/catch path also fails. This guarantees the engine ALWAYS has
// a non-null geometry for every model, so the mission can always start.
export function buildProceduralGeometry(model: AircraftModel): THREE.BufferGeometry {
  // We compose a Group of meshes then merge via a manual traversal.
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x888888 });
  switch (model) {
    case 'su35': {
      // Su-35: twin-tail heavy fighter, canards, long fuselage, big LERX
      const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.5, 9, 12), mat);
      fuselage.rotation.x = Math.PI / 2;
      group.add(fuselage);
      // Nose cone
      const nose = new THREE.Mesh(new THREE.ConeGeometry(0.5, 2, 12), mat);
      nose.rotation.x = Math.PI / 2;
      nose.position.z = 5;
      group.add(nose);
      // Main wings (delta-ish, large)
      const wingGeom = new THREE.BoxGeometry(8.5, 0.2, 3);
      const wing = new THREE.Mesh(wingGeom, mat);
      wing.position.z = 0;
      group.add(wing);
      // Canards (small forward wings)
      const canardGeom = new THREE.BoxGeometry(2.5, 0.15, 1.2);
      const canardL = new THREE.Mesh(canardGeom, mat);
      canardL.position.set(-1.8, 0, 3);
      group.add(canardL);
      const canardR = canardL.clone();
      canardR.position.x = 1.8;
      group.add(canardR);
      // Twin vertical tails
      const tailGeom = new THREE.BoxGeometry(0.15, 1.6, 1.6);
      const tailL = new THREE.Mesh(tailGeom, mat);
      tailL.position.set(-0.7, 0.7, -3.5);
      group.add(tailL);
      const tailR = tailL.clone();
      tailR.position.x = 0.7;
      group.add(tailR);
      // Engine nozzles
      const nozGeom = new THREE.CylinderGeometry(0.35, 0.4, 0.6, 8);
      const nozL = new THREE.Mesh(nozGeom, mat);
      nozL.rotation.x = Math.PI / 2;
      nozL.position.set(-0.5, -0.1, -4.5);
      group.add(nozL);
      const nozR = nozL.clone();
      nozR.position.x = 0.5;
      group.add(nozR);
      break;
    }
    case 'a10': {
      // A-10: straight wings, twin tail, two big engines high on rear fuselage
      const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.6, 7, 10), mat);
      fuselage.rotation.x = Math.PI / 2;
      group.add(fuselage);
      const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 1.5, 10), mat);
      nose.rotation.x = Math.PI / 2;
      nose.position.z = 4;
      group.add(nose);
      // GAU-8 gun barrel (signature feature)
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.2, 2.5, 8), mat);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, -0.15, 5);
      group.add(barrel);
      // Straight high-aspect wings
      const wing = new THREE.Mesh(new THREE.BoxGeometry(10, 0.18, 2.2), mat);
      group.add(wing);
      // Twin tails — connected at top by horizontal stabilizer
      const tailGeom = new THREE.BoxGeometry(0.18, 1.5, 1.4);
      const tailL = new THREE.Mesh(tailGeom, mat);
      tailL.position.set(-1.5, 1.0, -3);
      group.add(tailL);
      const tailR = tailL.clone();
      tailR.position.x = 1.5;
      group.add(tailR);
      const hstab = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.15, 1.0), mat);
      hstab.position.set(0, 1.7, -3);
      group.add(hstab);
      // Engine pods (two large nacelles high on rear)
      const nacGeom = new THREE.CylinderGeometry(0.55, 0.55, 2.4, 10);
      const nacL = new THREE.Mesh(nacGeom, mat);
      nacL.rotation.x = Math.PI / 2;
      nacL.position.set(-1.6, 0.7, -2);
      group.add(nacL);
      const nacR = nacL.clone();
      nacR.position.x = 1.6;
      group.add(nacR);
      break;
    }
    case 'f15': {
      // F-15: twin engine, big wings, twin tail
      const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.6, 9, 12), mat);
      fuselage.rotation.x = Math.PI / 2;
      group.add(fuselage);
      const nose = new THREE.Mesh(new THREE.ConeGeometry(0.65, 2.5, 12), mat);
      nose.rotation.x = Math.PI / 2;
      nose.position.z = 5.5;
      group.add(nose);
      // Wings
      const wing = new THREE.Mesh(new THREE.BoxGeometry(8.0, 0.18, 3.2), mat);
      wing.position.z = -0.5;
      group.add(wing);
      // Twin tails
      const tailGeom = new THREE.BoxGeometry(0.2, 1.8, 1.8);
      const tailL = new THREE.Mesh(tailGeom, mat);
      tailL.position.set(-1.0, 0.9, -3.5);
      group.add(tailL);
      const tailR = tailL.clone();
      tailR.position.x = 1.0;
      group.add(tailR);
      // Engine nozzles (large, twin)
      const nozGeom = new THREE.CylinderGeometry(0.5, 0.55, 0.8, 10);
      const nozL = new THREE.Mesh(nozGeom, mat);
      nozL.rotation.x = Math.PI / 2;
      nozL.position.set(-0.6, -0.05, -4.8);
      group.add(nozL);
      const nozR = nozL.clone();
      nozR.position.x = 0.6;
      group.add(nozR);
      break;
    }
    case 'tu95': {
      // Tu-95 Bear: big turboprop bomber, swept wings, 4 contraprops
      const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.7, 10, 12), mat);
      fuselage.rotation.x = Math.PI / 2;
      group.add(fuselage);
      const nose = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 8), mat);
      nose.position.z = 5;
      group.add(nose);
      // Swept wings — use tapered boxes angled back
      const wingL = new THREE.Mesh(new THREE.BoxGeometry(5, 0.25, 2.5), mat);
      wingL.position.set(-3, 0, -0.5);
      wingL.rotation.y = -0.35;
      group.add(wingL);
      const wingR = wingL.clone();
      wingR.position.x = 3;
      wingR.rotation.y = 0.35;
      group.add(wingR);
      // 4 engine nacelles with contraprop disks
      const nacGeom = new THREE.CylinderGeometry(0.35, 0.35, 1.6, 8);
      const propDiskGeom = new THREE.CircleGeometry(1.2, 16);
      const propMat = new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.35, side: THREE.DoubleSide });
      const positions: [number, number][] = [
        [-2.0, 0.6], [2.0, 0.6], [-4.0, 0.6], [4.0, 0.6],
      ];
      for (const [px, py] of positions) {
        const nac = new THREE.Mesh(nacGeom, mat);
        nac.rotation.x = Math.PI / 2;
        nac.position.set(px, py, -0.5);
        group.add(nac);
        // Spinning prop disk (visual approximation)
        const disk = new THREE.Mesh(propDiskGeom, propMat);
        disk.position.set(px, py, 0.5);
        disk.rotation.y = Math.PI / 2;
        group.add(disk);
      }
      // Tail
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.25, 2.0, 1.5), mat);
      tail.position.set(0, 1.0, -4.5);
      group.add(tail);
      break;
    }
    case 'ea18g': {
      // EA-18G Growler: derived from F/A-18F. Twin-tail, twin-engine,
      // signature wingtip EW pods + belly ALQ-99 pod.
      const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.55, 9, 12), mat);
      fuselage.rotation.x = Math.PI / 2;
      group.add(fuselage);
      const nose = new THREE.Mesh(new THREE.ConeGeometry(0.55, 2.2, 12), mat);
      nose.rotation.x = Math.PI / 2;
      nose.position.z = 5.4;
      group.add(nose);
      // Leading-edge extensions (LERX)
      const lerxGeom = new THREE.BoxGeometry(1.4, 0.15, 2.2);
      const lerxL = new THREE.Mesh(lerxGeom, mat);
      lerxL.position.set(-0.9, 0.0, 2.4);
      lerxL.rotation.y = -0.2;
      group.add(lerxL);
      const lerxR = lerxL.clone();
      lerxR.position.x = 0.9;
      lerxR.rotation.y = 0.2;
      group.add(lerxR);
      // Trapezoidal wings
      const wingGeom = new THREE.BoxGeometry(8.4, 0.18, 2.6);
      const wing = new THREE.Mesh(wingGeom, mat);
      wing.position.z = 0.2;
      group.add(wing);
      // Twin canted vertical tails (signature F/A-18 look)
      const tailGeom = new THREE.BoxGeometry(0.18, 1.5, 1.4);
      const tailL = new THREE.Mesh(tailGeom, mat);
      tailL.position.set(-0.9, 0.9, -3.4);
      tailL.rotation.z = 0.18;
      group.add(tailL);
      const tailR = tailL.clone();
      tailR.position.x = 0.9;
      tailR.rotation.z = -0.18;
      group.add(tailR);
      // Horizontal stabilizers
      const hstab = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.15, 1.0), mat);
      hstab.position.set(0, 0.0, -3.8);
      group.add(hstab);
      // Engine nozzles (twin)
      const nozGeom = new THREE.CylinderGeometry(0.45, 0.5, 0.7, 10);
      const nozL = new THREE.Mesh(nozGeom, mat);
      nozL.rotation.x = Math.PI / 2;
      nozL.position.set(-0.55, -0.05, -4.7);
      group.add(nozL);
      const nozR = nozL.clone();
      nozR.position.x = 0.55;
      group.add(nozR);
      // === EW signature: wingtip pods (ALQ-218) + belly ALQ-99 pod ===
      const podMat = new THREE.MeshStandardMaterial({ color: 0x3a3f48, metalness: 0.7, roughness: 0.4 });
      const wingtipPodGeom = new THREE.CylinderGeometry(0.18, 0.18, 1.6, 8);
      const podL = new THREE.Mesh(wingtipPodGeom, podMat);
      podL.rotation.x = Math.PI / 2;
      podL.position.set(-4.4, 0, 0.4);
      group.add(podL);
      const podR = podL.clone();
      podR.position.x = 4.4;
      group.add(podR);
      // Belly ALQ-99 pod (cylinder under fuselage)
      const alqGeom = new THREE.CylinderGeometry(0.3, 0.3, 2.4, 10);
      const alq = new THREE.Mesh(alqGeom, podMat);
      alq.rotation.x = Math.PI / 2;
      alq.position.set(0, -0.7, 0.5);
      group.add(alq);
      break;
    }
    case 'ac130': {
      // AC-130 Spectre: C-130 Hercules airframe, high wing, T-tail, 4 turboprops.
      // Side-firing 105mm howitzer + 40mm Bofors implied by port-side gunport.
      const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 0.85, 11, 14), mat);
      fuselage.rotation.x = Math.PI / 2;
      group.add(fuselage);
      const nose = new THREE.Mesh(new THREE.SphereGeometry(1.0, 12, 10), mat);
      nose.position.z = 5.5;
      group.add(nose);
      // Cargo ramp (slight cone at the rear)
      const ramp = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.65, 1.6, 12), mat);
      ramp.rotation.x = Math.PI / 2;
      ramp.position.z = -5.8;
      group.add(ramp);
      // High-mounted straight wing
      const wingGeom = new THREE.BoxGeometry(13, 0.28, 2.4);
      const wing = new THREE.Mesh(wingGeom, mat);
      wing.position.set(0, 0.9, 0.3);
      group.add(wing);
      // 4 turboprop nacelles on the wing
      const nacGeom = new THREE.CylinderGeometry(0.42, 0.42, 1.8, 10);
      const propDiskGeom = new THREE.CircleGeometry(1.0, 14);
      const propMat = new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.3, side: THREE.DoubleSide });
      const nacPositions: [number, number, number][] = [
        [-1.8, 0.9, 0.3], [1.8, 0.9, 0.3], [-4.5, 0.9, 0.3], [4.5, 0.9, 0.3],
      ];
      for (const [nx, ny, nz] of nacPositions) {
        const nac = new THREE.Mesh(nacGeom, mat);
        nac.rotation.x = Math.PI / 2;
        nac.position.set(nx, ny, nz);
        group.add(nac);
        // Prop disk on the leading edge
        const disk = new THREE.Mesh(propDiskGeom, propMat);
        disk.position.set(nx, ny, nz + 1.0);
        disk.rotation.y = Math.PI / 2;
        group.add(disk);
      }
      // T-tail (high horizontal stabilizer + vertical fin)
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.28, 2.2, 1.6), mat);
      fin.position.set(0, 1.6, -5.0);
      group.add(fin);
      const hstab = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.18, 1.0), mat);
      hstab.position.set(0, 2.6, -5.0);
      group.add(hstab);
      // === Gunship signature: port-side gunport for 105mm howitzer ===
      const gunportMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.4, roughness: 0.6 });
      const gunport = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, 0.3), gunportMat);
      gunport.position.set(-1.05, -0.2, 0.5);
      group.add(gunport);
      // 105mm barrel poking out the port
      const barrelMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.7, roughness: 0.3 });
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 2.2, 8), barrelMat);
      barrel.rotation.z = Math.PI / 2;
      barrel.position.set(-2.0, -0.2, 0.5);
      group.add(barrel);
      // 40mm Bofors gunport (smaller, slightly forward)
      const barrel40 = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 1.4, 8), barrelMat);
      barrel40.rotation.z = Math.PI / 2;
      barrel40.position.set(-1.8, 0.1, 1.8);
      group.add(barrel40);
      break;
    }
    case 'f117': {
      // F-117 Nighthawk: faceted stealth attack jet, V-tail, flat nozzle.
      // Build faceted look with triangular / wedge boxes.
      const fuselage = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.7, 8.0), mat);
      group.add(fuselage);
      // Wedge nose (pyramid-like via ConeGeometry with 4 segments)
      const nose = new THREE.Mesh(new THREE.ConeGeometry(1.0, 3.0, 4), mat);
      nose.rotation.x = Math.PI / 2;
      nose.rotation.y = Math.PI / 4;
      nose.position.z = 5.5;
      group.add(nose);
      // Swept delta wings (angled boxes)
      const wingL = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.18, 3.5), mat);
      wingL.position.set(-3.0, -0.05, -0.5);
      wingL.rotation.y = -0.5; // strong sweep
      group.add(wingL);
      const wingR = wingL.clone();
      wingR.position.x = 3.0;
      wingR.rotation.y = 0.5;
      group.add(wingR);
      // V-tail (twin canted outward)
      const vtailGeom = new THREE.BoxGeometry(0.16, 1.4, 1.2);
      const vtailL = new THREE.Mesh(vtailGeom, mat);
      vtailL.position.set(-0.7, 0.6, -3.6);
      vtailL.rotation.z = 0.55;
      group.add(vtailL);
      const vtailR = vtailL.clone();
      vtailR.position.x = 0.7;
      vtailR.rotation.z = -0.55;
      group.add(vtailR);
      // Flat slab exhaust (signature F-117 feature) — wide box at the rear
      const exhaustMat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.8, roughness: 0.5 });
      const exhaust = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.4, 0.6), exhaustMat);
      exhaust.position.set(0, -0.05, -4.2);
      group.add(exhaust);
      // Faceted body panels — subtle edge highlights via small boxes on top
      const panelMat = new THREE.MeshStandardMaterial({ color: 0x222831, metalness: 0.6, roughness: 0.5 });
      const panel = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.06, 4.0), panelMat);
      panel.position.set(0, 0.4, 0.5);
      group.add(panel);
      break;
    }
    case 'e3': {
      // E-3 Sentry AWACS: Boeing 707 airframe + signature rotodome.
      const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.75, 11, 14), mat);
      fuselage.rotation.x = Math.PI / 2;
      group.add(fuselage);
      const nose = new THREE.Mesh(new THREE.SphereGeometry(0.85, 12, 10), mat);
      nose.position.z = 5.5;
      group.add(nose);
      // Swept low wing
      const wingL = new THREE.Mesh(new THREE.BoxGeometry(5, 0.22, 2.6), mat);
      wingL.position.set(-3, -0.3, 0.5);
      wingL.rotation.y = -0.25;
      group.add(wingL);
      const wingR = wingL.clone();
      wingR.position.x = 3;
      wingR.rotation.y = 0.25;
      group.add(wingR);
      // 4 engine nacelles under wing
      const nacGeom = new THREE.CylinderGeometry(0.32, 0.32, 1.6, 10);
      const nacPositions: [number, number][] = [
        [-1.6, -0.6], [1.6, -0.6], [-3.6, -0.6], [3.6, -0.6],
      ];
      for (const [nx, ny] of nacPositions) {
        const nac = new THREE.Mesh(nacGeom, mat);
        nac.rotation.x = Math.PI / 2;
        nac.position.set(nx, ny, 0.6);
        group.add(nac);
      }
      // Conventional tail
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.25, 2.2, 1.6), mat);
      fin.position.set(0, 1.2, -5.0);
      group.add(fin);
      const hstab = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.18, 1.0), mat);
      hstab.position.set(0, 0.6, -5.0);
      group.add(hstab);
      // === AWACS signature: rotodome (ellipsoid) on struts above fuselage ===
      const domeMat = new THREE.MeshStandardMaterial({ color: 0x2a2f38, metalness: 0.5, roughness: 0.6 });
      const dome = new THREE.Mesh(new THREE.SphereGeometry(1.4, 16, 8), domeMat);
      dome.scale.set(1.0, 0.18, 1.0); // flatten into a disk
      dome.position.set(0, 1.6, 0.5);
      group.add(dome);
      // Struts
      const strutMat = new THREE.MeshStandardMaterial({ color: 0x444a55, metalness: 0.6, roughness: 0.4 });
      const strutGeom = new THREE.BoxGeometry(0.12, 0.6, 0.12);
      const strutL = new THREE.Mesh(strutGeom, strutMat);
      strutL.position.set(-0.6, 1.2, 0.5);
      group.add(strutL);
      const strutR = strutL.clone();
      strutR.position.x = 0.6;
      group.add(strutR);
      break;
    }
    default: {
      // Fallback: simple cylinder
      const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.5, 8, 10), mat);
      fuselage.rotation.x = Math.PI / 2;
      group.add(fuselage);
    }
  }
  // Merge all meshes in the group into a single BufferGeometry.
  const geoms: THREE.BufferGeometry[] = [];
  group.updateMatrixWorld(true);
  group.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      const g = mesh.geometry.clone();
      g.applyMatrix4(mesh.matrixWorld);
      for (const key of Object.keys(g.attributes)) {
        if (key !== 'position') g.deleteAttribute(key);
      }
      geoms.push(g);
    }
  });
  const merged = mergeGeometries(geoms);
  merged.computeVertexNormals();
  // 程序化低模里薄板/退化面会留下 0 长度法线(实测敌人/僚机各带 84~87 个, 还有 1 个非有限值):
  // 着色器 normalize 出 NaN ⇒ 该片全黑 + 随 bloom 扩散成整屏闪黑。这里一次修干净。
  sanitizeZeroNormals(merged);
  merged.computeBoundingBox();
  const box = merged.boundingBox!;
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);
  merged.translate(-center.x, -center.y, -center.z);
  const maxDim = Math.max(size.x, size.y, size.z);
  const s = 10 / maxDim;
  merged.scale(s, s, s);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

// Models that have real .obj assets in /public/models/ (text OBJ path).
// All other models fall back to procedural geometry.
const HAS_OBJ_FILE: Record<string, boolean> = {
  b52: true,
  // === AC-130 uses the B-52 airframe (per user request: ac130使用b52的模型) ===
  ac130: true,
};

// === F-16C 真实机体 (per user request: 完全替换原 F-16) ===
// f16(玩家默认机 + 大量敌机/僚机)、f16c(新注册的玩家机)与 f16-test 现在
// 共用同一副真实 F-16C Block 50 机体几何 —— 由 f16c.ts 解析
// /models/f16c/f16c.obj.gz 后合并成单个 BufferGeometry(最大维度 10、机头 +Z、
// 居中、flat 法线、含 UV),正好就是旧的 f16.positions/normals/indices/uvs.bin
// 烘焙产物所提供的东西。
//
// 为什么合并:引擎的 spawnEnemies()/buildAircraftMesh() 只吃
// AircraftGeometryInfo.geometry(单个 BufferGeometry + 单材质 PBR 涂装),
// 不吃多材质 Group —— 多材质真实贴图那份是玩家机专用(loadF16cModel)。
//
// 旧的 4 个 f16.*.bin(~7.2MB raw / 9.6MB base64)因此不再内联、不再加载
// (文件仍留在 public/ 里给其它工具用,见 scripts/bake-f16-binary.mjs)。
const F16C_AIRFRAME: Record<string, boolean> = {
  f16: true,
  f16c: true,
  'f16-test': true,
};

// Model → OBJ source file override. The AC-130 flies the B-52 body.
const MODEL_OBJ_SOURCE: Record<string, string> = {
  ac130: 'b52',
};

// === 以 .gz 内联的机体源 (per 单文件体积) ===
// 清单与 scripts/gzip-obj-assets.mjs 的 OBJ_SOURCES 对应(b52 在 2026-09 加入)。
// 这些源**只有 .obj.gz** 被内联进单文件(ASSETS 清单里 .gz 替掉了 .obj),
// 所以必须走 obj-gzip.ts 的 fetchTextAsset(XHR + pako.inflate), 不能 fetch 文本。
// f16c / MiG-29 / 堡垒有自己的加载器, 不走这条 HAS_OBJ_FILE 分支。
const GZ_OBJ_MODELS = new Set(['b52']);

// === 真实舵面提取 (per user request: 舵面动画适配) ===
// MiG-29 与 F-16C 的 OBJ 都把舵面拆成**多个子网格**(例:`elevator0_100_0` 与
// `_1` 是同一片舵面的两个材质分组), 所以必须**按基名分组、全组共享同一个铰链
// 轴**, 否则每片会各自绕自己的包围盒中心转, 看起来像散架。
//
// 命名差异(两份模型都覆盖到):
//   MiG-29 : aileron1_l/_r · elevator0/1 · rudder0/1
//   F-16C  : flaperon_l/_r(升降副翼, F-16 没有独立副翼) · elevator0/1 · rudder
//            · airbrake_l*/airbrake_r*(减速板)
// 左/右判定用名字里的 `_l` / `_r`(与既有 MiG-29 代码一致)。
/** 把一个几何里"0 长度 / 非有限"的顶点法线换成它所在面的几何法线。
 *
 *  为什么必须专门做这一步: GLSL 里 `normalize(vec3(0))` 是 **NaN** —— 那个片元直接
 *  算成黑色, 而且 NaN 会顺着 bloom 的模糊扩散成**整屏闪黑**(用户报的"尾喷口那块被
 *  追尾相机看到就闪黑屏"就是它)。零长度法线有两个来源: ① 法线平滑时共享位置上的
 *  法线互相抵消(薄叶片两面朝向相反); ② OBJ 源数据本身就带 (0,0,0)。
 *
 *  退化三角形(面积为 0)取不到面法线, 退而取同面另外两个顶点的法线均值; 再不行给
 *  (0,1,0)。唯一目标是: 几何里**绝不留下** 0 长度法线。返回被修掉的顶点数(诊断用)。
 */
export function sanitizeZeroNormals(geom: THREE.BufferGeometry): number {
  const pos = geom.attributes.position as THREE.BufferAttribute | undefined;
  const nrm = geom.attributes.normal as THREE.BufferAttribute | undefined;
  if (!pos || !nrm) return 0;
  const p = pos.array as ArrayLike<number>;
  const n = nrm.array as Float32Array;
  const idx = geom.index ? (geom.index.array as ArrayLike<number>) : null;
  const tris = Math.floor(idx ? idx.length / 3 : p.length / 9);
  const isBad = (v: number) => !(Math.hypot(n[v * 3], n[v * 3 + 1], n[v * 3 + 2]) > 1e-6);
  let fixed = 0;
  for (let t = 0; t < tris; t++) {
    const i0 = idx ? idx[t * 3] : t * 3;
    const i1 = idx ? idx[t * 3 + 1] : t * 3 + 1;
    const i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
    const b0 = isBad(i0), b1 = isBad(i1), b2 = isBad(i2);
    if (!b0 && !b1 && !b2) continue;
    const ax = p[i1 * 3] - p[i0 * 3], ay = p[i1 * 3 + 1] - p[i0 * 3 + 1], az = p[i1 * 3 + 2] - p[i0 * 3 + 2];
    const bx = p[i2 * 3] - p[i0 * 3], by = p[i2 * 3 + 1] - p[i0 * 3 + 1], bz = p[i2 * 3 + 2] - p[i0 * 3 + 2];
    let fx = ay * bz - az * by, fy = az * bx - ax * bz, fz = ax * by - ay * bx;
    let fl = Math.hypot(fx, fy, fz);
    const verts: [number, boolean][] = [[i0, b0], [i1, b1], [i2, b2]];
    if (!(fl > 1e-12)) {
      fx = 0; fy = 0; fz = 0;
      for (const [v, bad] of verts) {
        if (bad) continue;
        fx += n[v * 3]; fy += n[v * 3 + 1]; fz += n[v * 3 + 2];
      }
      fl = Math.hypot(fx, fy, fz);
    }
    if (!(fl > 1e-12)) { fx = 0; fy = 1; fz = 0; fl = 1; }
    fx /= fl; fy /= fl; fz /= fl;
    for (const [v, bad] of verts) {
      if (!bad) continue;
      n[v * 3] = fx; n[v * 3 + 1] = fy; n[v * 3 + 2] = fz;
      fixed++;
    }
  }
  if (fixed) nrm.needsUpdate = true;
  return fixed;
}

/**
 * 舵面种类判定表。**唯一实现**: models.ts 的分组、engine 的 dump、Blender 侧 rig
 * 的键都从这里来 —— 各自写一份必然漂移(已踩过: dump 里键带 `vehicle#` 前缀,
 * 而分组产出的键没有, rig 就永远匹配不上)。
 */
export const CONTROL_SURFACE_KIND: { key: string; test: RegExp }[] = [
  { key: 'aileron', test: /aileron|flaperon/ },
  { key: 'elevator', test: /elevator/ },
  { key: 'rudder', test: /rudder/ },
  { key: 'airbrake', test: /airbrake|speedbrake/ },
];

/** 这块 mesh 属于哪种舵面(不属于 → null)。 */
export function controlSurfaceKindOf(m: THREE.Mesh): string | null {
  const raw = ((m.name || '') + ' ' + (m.parent?.name || '')).toLowerCase();
  return CONTROL_SURFACE_KIND.find((k) => k.test.test(raw))?.key ?? null;
}

/**
 * 铰链分组键: 从种类词开始截, 再去掉末尾的 `_<数字>` 材质后缀。
 * `vehicle#flaperon_l_93` → `flaperon_l`;`vehicle#elevator0` → `elevator0`。
 *
 * ⚠ 这就是 rig JSON 里 `surface.<key>` 的键。改这里等于改对外契约。
 */
export function controlSurfaceKey(m: THREE.Mesh): string | null {
  const raw = ((m.name || '') + ' ' + (m.parent?.name || '')).toLowerCase();
  const hit = CONTROL_SURFACE_KIND.find((k) => k.test.test(raw));
  if (!hit) return null;
  const found = hit.test.exec(raw)?.[0] ?? '';
  const idx = raw.indexOf(found);
  if (idx < 0) return null;
  const tail = raw.slice(idx);
  const base = tail.replace(/_[0-9]+.*$/, '');
  return base.length ? base : tail;
}

/** 副翼/升降舵的默认铰链轴(绕机体横轴)。 */
const DEFAULT_HINGE_X = new THREE.Vector3(1, 0, 0);

/**
 * 取舵面的铰链轴。**总是有值**(没有 hingeAxis 字段的就是纯 X 轴)——
 * 于是引擎里所有舵面都能走同一条四元数驱动路径, 而不是"方向舵四元数、
 * 其余三个 Euler X"两套。rig 里换任意轴也就自然生效了。
 */
export function hingeAxisOf(m: THREE.Mesh): THREE.Vector3 {
  return (m.userData as { hingeAxis?: THREE.Vector3 }).hingeAxis ?? DEFAULT_HINGE_X;
}

export interface ControlSurfaceSet {
  ailerons: THREE.Mesh[];
  elevators: THREE.Mesh[];
  rudders: THREE.Mesh[];
  /** 减速板(F-16C);MiG-29 没有 → 空数组 */
  airbrakesL: THREE.Mesh[];
  airbrakesR: THREE.Mesh[];
  /** 诊断 */
  hingeCount: number;
}

export function extractControlSurfaces(root: THREE.Object3D, model?: string | null): ControlSurfaceSet {
  const out: ControlSurfaceSet = {
    ailerons: [], elevators: [], rudders: [], airbrakesL: [], airbrakesR: [],
    hingeCount: 0,
  };
  // 收集 mesh 并归类(用自身名或父组名 —— OBJLoader 把 g 组挂在父级)
  const bucket: Record<string, THREE.Mesh[]> = { aileron: [], elevator: [], rudder: [], airbrake: [] };
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const kind = controlSurfaceKindOf(m);
    if (kind) bucket[kind].push(m);
  });

  // 按**基名**分组: 去掉末尾的 `_<数字>` 材质后缀, 得到铰链键。
  // 键的计算走 controlSurfaceKey(唯一实现) —— engine 的 dump 用的是同一个函数,
  // 所以 rig JSON 里的键与这里天然一致。
  const groupByHinge = (meshes: THREE.Mesh[]) => {
    const map = new Map<string, THREE.Mesh[]>();
    for (const m of meshes) {
      const key = controlSurfaceKey(m);
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(m);
    }
    return map;
  };

  // 给每个铰链组设置共享 pivot(与 MiG-29 同规则):
  //   aileron/elevator → 绕 X 转 → pivot 取 组包围盒中心的 x, 该片自身中心的 y,
  //                      铰链 z 取**后缘**(朝机尾一侧)
  //   rudder          → 绕 Y 转 → pivot 取 该片中心 x, 组包围盒中心 y, 后缘 z
  const setupHinge = (meshes: THREE.Mesh[], axis: 'x' | 'y', key: string) => {
    // === rig 覆盖 (per user request: 在 Blender 里手工定铰链轴/点) ===
    // 有 rig 就用它; 没有才走下面那套启发式。轴可以是任意方向 —— 因为引擎
    // 里所有舵面都改成四元数驱动了(见 hingeAxisOf)。
    const rig = rigSurface(model, key);
    if (!meshes.length) return;
    const bb = new THREE.Box3();
    for (const m of meshes) bb.expandByObject(m);
    const bbCenter = bb.getCenter(new THREE.Vector3());
    const hingeZ = bb.max.z; // 后缘(与 MiG-29 的取法一致)

    // === 偏航舵: 铰链是"紧邻舵面的那条**斜边**" (per user request) ================
    // 这两架的垂尾都是后掠的, 舵面铰链线并不竖直 —— 早期实现一律绕竖直轴(穿过后缘)转,
    // 因此舵面看起来是"整片平移+自转"。这里先从舵面顶点量出前缘线的倾斜角:
    //   取 z 最小的顶点(前缘最低点) 与 上半段里 z 最小的顶点(前缘较高处), 两点连线 => 倾角。
    // 然后把铰链点放到这条斜边在**本片高度中心**处的位置, 并把铰链轴(单位向量)写进
    // mesh.userData.hingeAxis, 由引擎用四元数驱动(见 engine 的舵面驱动段)。
    // === 偏航舵: 铰链 = "紧邻舵面的那条斜边" (per user request) ==================
    // 早先的实现一律绕竖直轴(穿过后缘)转, 于是舵面看着像"整片平移 + 自转"。
    // 量法: 取舵面顶点的**最远点对** —— 舵面是一块细长板, 最长方向就是它的展向 =
    // 铰链方向(后掠垂尾上这条线自然就是斜的); 再把**前缘顶点**(z 最小)投影到这条直线上,
    // 得到铰链点(正好在紧邻舵面的斜边上)。比按 y 分带量前缘稳得多(那种量法在 F-16C 的
    // OBJ 上实测倾角 = 0, 因为它按部件建的面片并不沿坐标轴排布)。
    const hingeDir = new THREE.Vector3(0, 1, 0);
    const hingePoint = new THREE.Vector3();
    if (axis === 'y') {
      const pts: THREE.Vector3[] = [];
      for (const m of meshes) {
        const p = m.geometry.attributes.position;
        const step = Math.max(1, Math.floor(p.count / 600));   // 大网格抽样, 小网格全取
        for (let i = 0; i < p.count; i += step) pts.push(new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)));
      }
      if (pts.length >= 2) {
        let best = -1, v1 = pts[0], v2 = pts[1];
        for (let i = 0; i < pts.length; i++) {
          for (let j = i + 1; j < pts.length; j++) {
            const d = pts[i].distanceToSquared(pts[j]);
            if (d > best) { best = d; v1 = pts[i]; v2 = pts[j]; }
          }
        }
        hingeDir.copy(v2).sub(v1);
        if (hingeDir.lengthSq() > 1e-8) {
          hingeDir.normalize();
          if (hingeDir.y < 0) hingeDir.negate();     // 约定 +Y 朝上, 符号才稳定
        }
        // 前缘顶点(z 最小)在铰链方向直线上的投影 = 铰链点
        let lead = pts[0];
        for (const p of pts) if (p.z < lead.z) lead = p;
        const t = lead.clone().sub(v1).dot(hingeDir);
        hingePoint.copy(v1).addScaledVector(hingeDir, t);
      }
    }
    const tilt = Math.acos(THREE.MathUtils.clamp(hingeDir.y, -1, 1));
    const tiltDeg = THREE.MathUtils.radToDeg(tilt);
    void tiltDeg;
    const hingeAxisDir = hingeDir.clone().normalize();

    // rig 给了轴就用它; 没给: 方向舵用拟合出的斜轴, 其余用纯 X(与旧行为一致)
    // rig 给了轴就用它; 没给: 方向舵用拟合出的斜轴, 其余用纯 X。
    // ⚠ 不能直接拿 hingeDir 当默认 —— 它初值就是 (0,1,0), 只有方向舵那支会覆盖它,
    //   副翼/升降舵/减速板会全变成绕 Y 转(这个错被 rig-dump 抓出来过)。
    const finalAxis = rig?.axis
      ? new THREE.Vector3(rig.axis[0], rig.axis[1], rig.axis[2]).normalize()
      : (axis === 'y' ? hingeDir.clone().normalize() : DEFAULT_HINGE_X.clone());
    // rig 给了铰链点就用它(模型空间); 没给才走启发式
    const rigPivot = rig?.pivot
      ? new THREE.Vector3(rig.pivot[0], rig.pivot[1], rig.pivot[2])
      : null;

    for (const m of meshes) {
      const mb = new THREE.Box3().setFromObject(m);
      const mbCenter = mb.getCenter(new THREE.Vector3());
      const pivot = new THREE.Vector3();
      if (rigPivot) {
        pivot.copy(rigPivot);
      } else if (axis === 'x') {
        pivot.set(bbCenter.x, mbCenter.y, hingeZ);
      } else if (axis === 'y') {
        // 斜边铰链: 铰链点由"前缘顶点在铰链方向上的投影"给出(见上)
        pivot.copy(hingePoint);
      } else {
        pivot.set(mbCenter.x, bbCenter.y, hingeZ);
      }
      m.geometry.translate(-pivot.x, -pivot.y, -pivot.z);
      m.position.copy(pivot);
      m.geometry.computeBoundingSphere();
      // **所有**舵面都写 hingeAxis: 引擎统一用四元数驱动(见 hingeAxisOf),
      // 于是 rig 里换任意轴都能生效, 而不是只有方向舵能斜着转。
      (m.userData as { hingeAxis?: THREE.Vector3 }).hingeAxis = finalAxis.clone();
    }
    out.hingeCount++;
  };

  for (const [key, meshes] of groupByHinge(bucket.aileron)) {
    setupHinge(meshes, 'x', key);
    out.ailerons.push(...meshes);
  }
  for (const [key, meshes] of groupByHinge(bucket.elevator)) {
    setupHinge(meshes, 'x', key);
    out.elevators.push(...meshes);
  }
  for (const [key, meshes] of groupByHinge(bucket.rudder)) {
    setupHinge(meshes, 'y', key);
    out.rudders.push(...meshes);
  }
  for (const [key, meshes] of groupByHinge(bucket.airbrake)) {
    setupHinge(meshes, 'x', key);
    if (/_l/.test(key)) out.airbrakesL.push(...meshes);
    else if (/_r/.test(key)) out.airbrakesR.push(...meshes);
  }
  return out;
}

// Yield to the browser so the main thread can paint the loading screen /
// progress bar. Without this, parsing a 10 MB OBJ on the main thread
// blocks React's render loop and the loading bar appears "stuck".
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// === 尾喷口开合动画 (per user request: 尝试让它支持后燃器尾喷口动画) ===
// 真实 F-16 的收敛-扩张喷口由一圈叶片组成: 干推时收拢(小喉道)、开加力时张开
// (大喉道)。F-16C 模型的喷口叶片在 OBJ 里是**独立分组**(`vehicle#nozzle1_1` …
// `_60`), 所以可以真的做"喷口随油门收放", 而不是只缩放一张火焰贴图。
//
// 用法(在模型加载完、mesh 挂进 group 之后调用一次, 拿到 update 句柄):
//   const nz = prepareNozzleAnimation(group);
//   // 每帧: nz.update(abIntensity)   // 0=收拢 1=完全张开
//
// 实现要点: 叶片是"绕喷口轴径向排布"的一圈, 所以缩放必须发生在**喷口局部坐标系**
// 里(以喷口中心为原点), 否则叶片会朝各自的原点收缩、看起来像炸开。做法是把每个
// 叶片的几何顶点减去喷口中心、写回几何(即把原点搬到喷口中心), 之后直接缩放即可。
export interface NozzleAnimation {
  /** 0 = 收拢(干推) / 1 = 完全张开(全加力) */
  update: (openness: number) => void;
  /** 诊断: 识别到多少片叶片、喷口中心与轴向 */
  petalCount: number;
  center: THREE.Vector3;
}

export function prepareNozzleAnimation(root: THREE.Object3D): NozzleAnimation | null {
  // 1) 收集喷口叶片 mesh(group/o 名里含 'nozzle')
  const petals: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const name = (m.name || m.parent?.name || '').toLowerCase();
    if (name.includes('nozzle')) petals.push(m);
  });
  if (petals.length < 4) return null;

  // 2) 求喷口中心(所有叶片世界包围盒的中心)与轴向
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  for (const p of petals) {
    tmp.setFromObject(p);
    box.union(tmp);
  }
  const center = box.getCenter(new THREE.Vector3());
  // 轴向 = 最长的那个轴(喷口是"最深"的方向); F-16 是 +Z 机头, 喷口沿 Z。
  const size = box.getSize(new THREE.Vector3());
  const axis = size.z >= size.x && size.z >= size.y ? 'z' : (size.y >= size.x ? 'y' : 'x');

  // 3) 把每片叶片的几何原点搬到喷口中心(这样缩放 = 沿径向收放, 不是各自收缩)
  for (const p of petals) {
    const g = p.geometry as THREE.BufferGeometry;
    if ((g.userData as { _nzShifted?: boolean })._nzShifted) continue;
    // 喷口中心 → 该叶片的局部空间
    const local = center.clone().applyMatrix4(
      new THREE.Matrix4().copy(p.matrixWorld).invert(),
    );
    g.translate(-local.x, -local.y, -local.z);
    g.computeBoundingSphere();
    (g.userData as { _nzShifted?: boolean })._nzShifted = true;
    // 几何搬了原点, 网格位置要补回来, 否则整体位移
    p.position.add(local);
    p.updateMatrix();
  }

  // 4) 收放: 干推 0.82(收拢) → 全加力 1.12(张开)。
  //    只缩径向两轴, 轴向保持不变(喷口不会被拉长/压短)。
  const MIN = 0.82, MAX = 1.12;
  const update = (openness: number) => {
    const k = MIN + (MAX - MIN) * Math.max(0, Math.min(1, openness));
    for (const p of petals) {
      if (axis === 'z') p.scale.set(k, k, 1);
      else if (axis === 'y') p.scale.set(k, 1, k);
      else p.scale.set(1, k, k);
    }
  };
  update(0);

  return { update, petalCount: petals.length, center };
}

export async function loadAircraftGeometry(
  model: AircraftModel,
): Promise<AircraftGeometryInfo> {
  if (geometryCache[model]) return geometryCache[model];

  let geom: THREE.BufferGeometry;
  let usedObj = false;

  if (F16C_AIRFRAME[model]) {
    try {
      // === F-16C 真实机体 (per user request: 完全替换原 F-16) ===
      // f16c.ts 内部:fetch f16c.obj.gz → pako.inflate → OBJLoader.parse →
      // 归一化 + winding 修复 + 合并成单个 geometry(不做平滑法线,与旧 bin 一致)。
      // 解析结果全模块缓存一次,f16/f16c/f16-test 三个 id 共用同一份几何。
      const { loadF16cGeometry } = await import('./f16c');
      // Yield before the heavy parse so the loading bar can paint.
      await yieldToBrowser();
      geom = await loadF16cGeometry();
      usedObj = true;
    } catch (err) {
      console.warn(`[models] F-16C airframe load failed for ${model}, falling back to procedural:`, err);
      geom = buildProceduralGeometry(model);
    }
  } else if (HAS_OBJ_FILE[model]) {
    try {
      // === Real OBJ loading restored (per user request: 恢复obj机体) ===
      // The .obj files DO serve correctly (HTTP 200, full 10.9 MB for f16,
      // 1.2 MB for b52). The previous "disabled" state was a misdiagnosis.
      // The real issue was that OBJLoader.load()'s callback parsed the file
      // on the main thread without yielding, freezing the UI.
      //
      // Fix: use fetch() to get the text (truly async I/O), then yield to
      // the browser with setTimeout(0) BEFORE parsing. This lets React
      // paint the loading screen / progress bar at least once between
      // the fetch resolving and the (synchronous) parse beginning.
      const url = assetUrl(`/models/${MODEL_OBJ_SOURCE[model] ?? model}.obj`);
      // === gzip 内联的机体走 obj-gzip 的取数链 (per 单文件体积) ===
      // B-52(AC-130 共用)的 OBJ 已改为 .gz 内联(1.13MiB 文本 → 0.27MiB gz,
      // base64 省 1.1MiB)。fetchTextAsset 会取 <path>.gz 再 pako.inflate,
      // 解压文本与原始 OBJ 逐字节一致;而且它走 **XHR** —— 顺带修掉这条分支
      // 原来用 fetch() 在 file:// 双击单文件时必然失败的问题。
      // 只对确实有 .gz 的机体用它;其余分支保持原样(fetch 文本路径)。
      const src = MODEL_OBJ_SOURCE[model] ?? model;
      const useGz = GZ_OBJ_MODELS.has(src);
      const text = useGz
        ? await (async () => {
          const { fetchTextAsset } = await import('./obj-gzip');
          return fetchTextAsset(`/models/${src}.obj`);
        })()
        : await (async () => {
          const res = await fetch(url);
          if (!res.ok) {
            throw new Error(`HTTP ${res.status} fetching ${url}`);
          }
          return res.text();
        })();
      // 兜底校验: .gz / .obj 都拿不到时, 静态服务器可能回 SPA 兜底 HTML ——
      // 直接喂给 OBJLoader 会静默产出垃圾几何(实测过这类误判), 这里宁可失败回落程序化。
      if (!/\nv\s/.test(text.slice(0, 4096))) {
        throw new Error(`not an OBJ text payload (${text.slice(0, 40).replace(/\s+/g, ' ')})`);
      }
      // Yield before the heavy parse so the loading bar can paint.
      await yieldToBrowser();
      const obj = objLoader.parse(text);
      geom = normalize(obj);
      // Some models have nose at -Z in source OBJ — flip so nose is +Z.
      if (NOSE_REORIENT[model]) {
        geom.scale(1, 1, -1);
        // === Normal fix (per user request: 修复法线反转的问题) ===
        // The mirror flip reverses triangle winding, so the normals computed
        // BEFORE the flip now point inward. Recompute after the flip so the
        // surface faces outward again.
        geom.computeVertexNormals();
      }
      usedObj = true;
    } catch (err) {
      console.warn(`[models] OBJ load failed for ${model}, falling back to procedural:`, err);
      geom = buildProceduralGeometry(model);
    }
  } else {
    // No .obj asset — use procedural geometry directly.
    // Yield anyway so the call signature is consistently async and the
    // loading loop gets a paint tick per model.
    await yieldToBrowser();
    geom = buildProceduralGeometry(model);
  }

  geom.computeBoundingBox();
  const box = geom.boundingBox!;
  const tailZ = box.min.z;
  const noseZ = box.max.z;
  const halfSpan = Math.max(Math.abs(box.min.x), Math.abs(box.max.x));

  const layout = ENGINE_LAYOUT[model] ?? { count: 2, lateralSpacing: 0.8, verticalOffset: 0 };
  const enginePositions: THREE.Vector3[] = [];
  const n = layout.count;
  if (n === 1) {
    enginePositions.push(new THREE.Vector3(0, layout.verticalOffset, tailZ - 0.1));
  } else if (n === 2) {
    enginePositions.push(new THREE.Vector3(-layout.lateralSpacing, layout.verticalOffset, tailZ - 0.1));
    enginePositions.push(new THREE.Vector3(layout.lateralSpacing, layout.verticalOffset, tailZ - 0.1));
  } else if (n === 4) {
    for (const side of [-1, 1]) {
      for (const offset of [0.5, 1.5]) {
        enginePositions.push(new THREE.Vector3(side * offset * layout.lateralSpacing, layout.verticalOffset, tailZ - 0.1));
      }
    }
  } else if (n === 8) {
    for (const side of [-1, 1]) {
      for (const pod of [0, 1]) {
        for (const inPod of [-0.35, 0.35]) {
          enginePositions.push(new THREE.Vector3(side * (1.1 + pod * 1.0), layout.verticalOffset, tailZ - 0.1 + inPod * 0.2));
        }
      }
    }
  }

  // === OBJ 导入机体的通用体检: 绕序修正 + 重算法线 (per user request) ===
  // 用户要求"以后导入的机体都要这样子检查处理" —— 所以规则做成**对所有 OBJ 导入机体生效**:
  //   ① 反转三角形绕序(CW→CCW, 与外向法线一致);
  //   ② 用绕序重算法线 `computeVertexNormals()`(而不是只把法线取反 —— 重算能同时修正
  //      "绕序与法线互相矛盾"的模型, 与 f16c.ts 的处理完全一致);
  //   ③ 材质侧由 buildAircraftMesh 统一给 `DoubleSide`(见那里的注释: F-16C 当初正是因为
  //      "从上方能看穿到机腹"才改成 DoubleSide, B-52/AC-130 是同一类问题)。
  // 程序化生成的机体(usedObj=false)不动 —— 它们的绕序/法线本来就是对的。
  if (usedObj) {
    const idx = geom.getIndex();
    if (idx) {
      const a = idx.array as Uint16Array | Uint32Array;
      for (let i = 0; i + 2 < a.length; i += 3) {
        const t = a[i];
        a[i] = a[i + 2];
        a[i + 2] = t;
      }
      idx.needsUpdate = true;
    }
    geom.computeVertexNormals();
    console.info('[models] ' + model + ': OBJ 导入 → 绕序翻转 + 重算法线(法线朝外)');
  }
  // 供 buildAircraftMesh 判断"这是导入模型" → 材质用 DoubleSide(封闭壳体开销可接受)。
  geom.userData.objImported = usedObj;
  // 所有非玩家机型的统一出口: 翻转/重算之后再把 0 长度法线修掉
  // (OBJ 源数据里的退化成分为主; 留着就是 NaN ⇒ 黑片 + bloom 扩散)。
  sanitizeZeroNormals(geom);

  const info: AircraftGeometryInfo = {
    geometry: geom,
    tailZ,
    noseZ,
    halfSpan,
    enginePositions,
    procedural: !usedObj,
  };
  // Shared across missions/engines — engine.dispose() must NOT free it.
  geom.userData.shared = true;
  geometryCache[model] = info;
  return info;
}

export interface PaintedMesh {
  mesh: THREE.Mesh;
  afterburnerGroup: THREE.Group;
  contrailEmitPoint: THREE.Vector3;
}

export interface AircraftMeshOptions {
  emissive?: number;
  emissiveIntensity?: number;
  metalness?: number;
  roughness?: number;
  /** Aircraft model id — enables the PBR texture set (procedural livery). */
  model?: string;
  /** Paint scheme name (player only; enemies use colour-derived livery). */
  paint?: string;
}

export function buildAircraftMesh(
  geom: THREE.BufferGeometry,
  color: number,
  opts: AircraftMeshOptions = {},
): THREE.Mesh {
  let material: THREE.MeshStandardMaterial;
  if (opts.model) {
    // === PBR texture set path (per user request: 现代 PBR 贴图) ===
    // Full 6-channel procedural set keyed by (model, paint, colour).
    // metalness/roughness material values become 1.0 with maps so the
    // textures own those channels; colour tints the albedo.
    // Procedural models have no UVs — bake triplanar UVs so they get the
    // livery too (OBJ/binary models keep their real Blender unwrap).
    if (!geom.attributes.uv) ensureTriplanarUVs(geom, 1);
    const mgr = getTextureManager();
    const set = getAircraftTextureSet(opts.model, opts.paint ?? 'standard', mgr.qualitySetting);
    material = buildPBRMaterial(set, {
      color,
      metalness: 1,
      roughness: 1,
      emissive: opts.emissive,
      emissiveIntensity: opts.emissiveIntensity ?? 0,
      aoIntensity: 0.75,
      // === 天光(IBL)强度 (per user request ⑤: 机体的天光强度太弱了) ===
      // ★ 这条 PBR 贴图路径原来没有设 envMapIntensity, 于是吃 three 默认 1.0 ——
      // 而它才是 F-16C/MiG-29 真正走的路径, 所以"改了 f16c.ts 的 1.5 却没效果"。
      // 现在统一引用 AIRCRAFT_ENV_MAP_INTENSITY(1.9)。
      envMapIntensity: AIRCRAFT_ENV_MAP_INTENSITY,
      // === 漆面清漆层 (per user request: 机体材质能量守恒升级) ===
      // 真机 = 底漆 + 聚氨酯清漆。**纯标量** clearcoat ⇒ 不绑任何贴图、不占采样器;
      // 能量账由 three 的涂层模型自己平(基底按 1-clearcoat*Fcc 扣, 再叠 coatSpec)。
      // 见 pbr/materials.ts 的 AIRCRAFT_COAT 说明(含"为什么不自己写多散射补偿")。
      coat: AIRCRAFT_COAT,
      coatRoughness: AIRCRAFT_COAT_ROUGHNESS,
      debugTag: `aircraft:${opts.model}`,
    });
    // === 导入机体统一 DoubleSide (per user request: 从上方能看穿到底部) ===
    // 与 F-16C 完全同一处理: 封闭壳体的导入模型常出现"绕序/面朝向混杂", 从上方能看穿到机腹;
    // DoubleSide 从根上消除该现象(开销可接受, 且与 MiG-29/F-16C 观感一致)。
    // 判定依据是几何上的 objImported 标记 → **以后导入的机体自动套用, 不必再手工检查**。
    if (geom.userData.objImported) material.side = THREE.DoubleSide;
    // === KTX2 + Basis 升级 (per user request: 贴图/显存压缩) ===
    // If the build generated compressed KTX2 versions of this paint's set,
    // swap them in asynchronously (procedural canvas set renders meanwhile).
    mgr.requestKtx2Upgrade(material, set.id);
  } else {
    // Legacy flat-colour path (hangar previews, anything without a model id).
    material = makeCoatedMaterial({
      color,
      metalness: opts.metalness ?? 0.6,
      roughness: opts.roughness ?? 0.45,
      envMapIntensity: AIRCRAFT_ENV_MAP_INTENSITY, // 天光强度(per user request ⑤)
      emissive: new THREE.Color(opts.emissive ?? 0x000000),
      emissiveIntensity: opts.emissiveIntensity ?? 0,
      flatShading: false,
    }, AIRCRAFT_COAT, AIRCRAFT_COAT_ROUGHNESS);   // 清漆层, 见 pbr/materials.ts
  }
  const mesh = new THREE.Mesh(geom, material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // === 延迟渲染 (per user request: 延迟渲染 + 现代化光照) ===
  // Aircraft spawned while the deferred pipeline is active live on the
  // G-Buffer layer only; applyDeferredMode() unmarks them on switch-back.
  if (isDeferredActive()) {
    mesh.layers.enable(DEFERRED_LAYER);
    mesh.layers.disable(0);
    (mesh as unknown as { userData: Record<string, unknown> }).userData._deferredMarked = true;
  }
  return mesh;
}

// === Afterburner flame texture (per user request: 后燃器特效不够真实) ===
// Baked 128×256 canvas: a tapered jet flame — white-hot core at the nozzle
// (bottom), orange-yellow body, soft feathered edges, faint noise jitter.
// Used by the cross-billboard flame planes in buildAfterburner.
let _abTexture: THREE.CanvasTexture | null = null;
function makeAfterburnerTexture(): THREE.CanvasTexture {
  if (_abTexture) return _abTexture;
  const W = 128;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, W, H);
  // Tapered flame silhouette: narrow at nozzle, widest at mid-flame, feathered tip.
  for (let y = 0; y < H; y++) {
    const v = y / H; // 0 = nozzle, 1 = tip
    // Width profile: widest around v=0.35, narrowing to a point at v=1.
    const taper = Math.sin(Math.min(1, v / 0.62) * Math.PI) * 0.55 + 0.08;
    const halfW = Math.max(1, W * 0.5 * taper);
    // Color: white-hot core (v<0.18) → orange-yellow body → transparent tip.
    let r: number, g: number, b: number, a: number;
    if (v < 0.18) {
      const k = v / 0.18;
      r = 255; g = 230 + k * 10; b = 180 + k * 40;
      a = 1;
    } else if (v < 0.62) {
      const k = (v - 0.18) / 0.44;
      r = 255 - k * 70;
      g = 200 - k * 90;
      b = 120 - k * 80;
      a = 1 - k * 0.15;
    } else {
      const k = (v - 0.62) / 0.38;
      r = 185 - k * 100;
      g = 110 - k * 80;
      b = 40 - k * 30;
      a = 0.85 * (1 - k);
    }
    for (let x = 0; x < W; x++) {
      const dx = (x - W / 2) / halfW;
      const edge = Math.max(0, 1 - dx * dx);       // soft horizontal falloff
      const edge2 = edge * edge;
      const noise = 0.85 + Math.random() * 0.15;    // faint jitter
      ctx.fillStyle = `rgba(${Math.round(r * noise)},${Math.round(g * noise)},${Math.round(b * noise)},${(a * edge2).toFixed(3)})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  _abTexture = new THREE.CanvasTexture(c);
  _abTexture.colorSpace = THREE.SRGBColorSpace;
  // Shared across missions — engine.dispose() must NOT free it.
  (_abTexture as any).userData.shared = true;
  return _abTexture;
}

// === Movable control surfaces (per user request: F-16X 可动舵面实验机) ===
// Synthetic ailerons/elevator/rudder attached to the airframe GROUP (in the
// same scaled model space as the muzzle flash — positions = model space ×
// meshScale). The engine drives their hinge rotations each frame from the
// ramped control authority; the hangar wiggles them as a self-demo.
export function buildControlSurfaces(info: AircraftGeometryInfo, meshScale: number): {
  aileronL: THREE.Mesh; aileronR: THREE.Mesh; elevator: THREE.Mesh; rudder: THREE.Mesh;
} {
  const surfaceMat = new THREE.MeshStandardMaterial({
    color: 0xa8b6c4, metalness: 0.4, roughness: 0.5,
    emissive: 0x223344, emissiveIntensity: 0.15,
  });
  // Ailerons — thin spanwise strips on the wing trailing edges, hinge X.
  const aileronGeo = new THREE.BoxGeometry(1.4, 0.07, 0.55);
  const aileronL = new THREE.Mesh(aileronGeo, surfaceMat);
  aileronL.position.set(-info.halfSpan * 0.82 * meshScale, 0.05 * meshScale, -1.1 * meshScale);
  const aileronR = new THREE.Mesh(aileronGeo, surfaceMat);
  aileronR.position.set(info.halfSpan * 0.82 * meshScale, 0.05 * meshScale, -1.1 * meshScale);
  // Elevator — horizontal tail, hinge X.
  const elevator = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.07, 0.6), surfaceMat);
  elevator.position.set(0, 0, (info.tailZ + 0.4) * meshScale);
  // Rudder — vertical fin, hinge Y.
  const rudder = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.2, 0.07), surfaceMat);
  rudder.position.set(0, 0.9 * meshScale, (info.tailZ + 0.3) * meshScale);
  return { aileronL, aileronR, elevator, rudder };
}

// Builds a soft glowing afterburner plume attached behind the engines.
import { makeFlameMaterial } from './afterburner-vfx';
import { deriveNozzleMetrics, type NozzleMetrics } from './nozzle-metrics';

/**
 * 这台飞机有没有**可见的加力燃烧(后燃器)**特效。
 *
 * (per user request: "AC130 和 b52 这种不要启用后燃器特效")
 * 涡桨机(Tu-95 / AC-130 / E-3)与无加力的轰炸机(B-52)尾部根本没有喷口火焰 ——
 * 以前只按 role 判了一半, 结果玩家满油门、或者 AI 拉满速度追击时, 这些机体屁股上
 * 会突然点起一团 F-16 式的加力火焰。判定收在这里, 玩家/僚机/敌机/机库四条路径共用。
 */
const NO_AFTERBURNER_MODELS = new Set(['b52', 'tu95', 'ac130', 'e3']);
const NO_AFTERBURNER_CATEGORIES = new Set(['bomber', 'gunship', 'awacs']);
export function hasAfterburner(model?: string | null, category?: string | null): boolean {
  if (model && NO_AFTERBURNER_MODELS.has(model)) return false;
  if (category && NO_AFTERBURNER_CATEGORIES.has(category)) return false;
  return true;
}
/**
 * buildAfterburner 给每台发动机加的**垂直偏移**(未缩放模型空间)。
 * 真实战机的尾喷口在机身中线**下方**, 所以火焰要从喷口那一段喷出, 而不是机身中线。
 * 导出它是因为: 后燃器"自动测量"要量的轴线就是 enginePositions[i] 叠加这个偏移之后的
 * 那一点(= 火焰真正出现的位置), 两边用同一个常量才不会又量偏(见 nozzle-metrics.ts)。
 */
export const AFTERBURNER_PLUME_Y_OFFSET = -0.45;

export function buildAfterburner(
  enginePositions: THREE.Vector3[] = [new THREE.Vector3(0, 0, -3)],
  // === 喷口自动测量结果 (per user request: 后燃器按模型自动适配大小与位置) =========
  // 由调用方用 deriveNozzleMetrics(info, enginePositions) 量出后再传进来;
  // 不传(老调用点)时退回"按机长比例"的估计 —— 缺省不会再是写死的绝对值。
  nozzles?: NozzleMetrics[],
  // === rig 覆盖: Blender 里手工调出来的尾喷口(位置/方向/半径/aftZ) =============
  // 见 src/lib/game/aircraft-rig.ts 与 blender/aircraft/README.md。
  // 传了机型才查得到; 不传 = 全用实测/估计值(老行为)。
  model?: string | null,
): THREE.Group {
  const group = new THREE.Group();
  const geo = new THREE.SphereGeometry(0.7, 14, 10);
  // === Afterburner plume shifted slightly DOWN from the engine centre ===
  // Real fighter exhaust nozzles sit below the fuselage centreline (the engine
  // bay hangs below the spine), and the afterburner flame extends straight
  // back from the nozzle, not from the centreline. The previous code placed
  // the plume exactly at enginePositions[i] — which corresponds to the
  // engine's lateral/longitudinal centre but at the fuselage vertical centre.
  // Visually this made the flame appear to come out of the middle of the
  // tail rather than from the nozzle beneath it.
  //
  // We add a small -Y offset (0.45 in unscaled model space) to every flame
  // element so the plume reads as coming from the nozzle — like on a real
  // F-16 where the exhaust is clearly below the aft fuselage.
  const PLUME_Y_OFFSET = AFTERBURNER_PLUME_Y_OFFSET;
  // === Realistic jet flame (per user request: 后燃器特效不够真实) ===
  // Two crossed billboard planes with the baked flame texture replace the
  // old plain additive spheres — a real tapered flame shape with a
  // white-hot core, orange body and feathered tip.
  const flameTex = makeAfterburnerTexture();
  const flameMatTpl = new THREE.MeshBasicMaterial({
    map: flameTex,
    transparent: true,
    opacity: 0.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  // Small blue shock-diamond cone retained from the old build.
  const blueMat = new THREE.MeshBasicMaterial({
    color: 0x77aaff,
    transparent: true,
    opacity: 0.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  // 逐台发动机: 用实测喷口(位置 + 半径)决定火焰挂点与基准尺寸。
  // 记录 base radius 到 userData, setAfterburner 里按它成比例给尺寸 —— 大机体大火焰。
  enginePositions.forEach((ep, ei) => {
    const nz = nozzles?.[ei];
    // === rig 覆盖 (per user request: Blender 里手工调尾喷口) ===
    // 优先级: rig(手工) > 实测 metrics > 估计值。
    // ⚠ rig.pos 的语义是"**尾焰起点**", 它已经含了旧的那个全局 Y 偏移
    //   (dump 时就是按 ep.y + PLUME_Y_OFFSET 写出去的) —— 所以用 rig.pos 时
    //   不能再加一次偏移, 否则尾焰会再往下飘 0.45。
    const rig = rigNozzle(model, ei);
    const nozzleR = rig?.radius ?? nz?.radius ?? 0.28;   // 喷口半径(手工/实测/估计)
    const aftZ = rig?.aftZ ?? nz?.aftZ ?? ep.z - 0.9;    // 喷口截面 z(手工/实测/估计)
    const yOff = rig?.pos ? 0 : PLUME_Y_OFFSET;
    // 每台发动机一个 wrapper: 位置 = 尾焰起点, 朝向 = rig.dir(缺省机身 -Z)。
    // 三个部件挂成它的子节点, 于是"转 wrapper" = 整条尾焰绕喷口转。
    const wrapper = new THREE.Group();
    wrapper.position.copy(
      rig?.pos
        ? new THREE.Vector3(rig.pos[0], rig.pos[1], rig.pos[2])
        : new THREE.Vector3(ep.x, ep.y + PLUME_Y_OFFSET, ep.z),
    );
    if (rig?.dir) {
      const d = new THREE.Vector3(rig.dir[0], rig.dir[1], rig.dir[2]);
      if (d.lengthSq() > 1e-9) {
        wrapper.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), d.normalize());
      }
    }
    group.add(wrapper);
    const zAt = (back: number) => aftZ + back * nozzleR; // 以"喷口半径"为单位往后排布
    // === 火焰主体: 开口锥, 轴线对齐机体 -Z(母口在喷口、锥尖在后方) ================
    // ConeGeometry 的 +Y 是锥尖 ⇒ rotation.x = -π/2 把它转到 -Z(机尾方向)。
    // uv.y 天然就是"喷口 0 → 锥尖 1"的纵向参数, 片元用它做颜色渐变与淡出。
    const flameGeo = new THREE.ConeGeometry(1, 1, 26, 10, true);
    const outer = new THREE.Mesh(flameGeo, makeFlameMaterial(false));
    // 位置再往机尾移 0.6(per user request: 往飞机尾部移动一些)
    outer.position.set(0, 0, -1.1);
    outer.rotation.x = -Math.PI / 2;
    outer.userData.role = 'flame';
    outer.userData.inner = 0;
    outer.userData.nozzleR = nozzleR;
    wrapper.add(outer);
    // 内芯: 更细更白(加色叠加后中心白热)
    const core = new THREE.Mesh(flameGeo, makeFlameMaterial(true));
    core.position.set(0, 0, zAt(-0.15) - ep.z);
    core.rotation.x = -Math.PI / 2;
    core.userData.role = 'flame';
    core.userData.inner = 1;
    core.userData.nozzleR = nozzleR;
    wrapper.add(core);
    // 喷口激波环(保留上一轮修正过的朝向: 法线沿机体轴 ⇒ 对着机尾看是正圆)
    const ringGeo = new THREE.RingGeometry(0.14, 0.24, 12);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x88ccff,
      transparent: true,
      opacity: 0.0,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.set(0, 0, aftZ + nozzleR * 0.05 - ep.z);
    ring.rotation.x = 0;
    ring.userData.role = 'ring';
    ring.userData.nozzleR = nozzleR;
    wrapper.add(ring);
  });   // enginePositions.forEach 结束
  group.visible = false;
  return group;
}

export function setAfterburner(group: THREE.Group, intensity: number) {
  group.visible = intensity > 0.01;
  // 时间累加: 本函数每帧被调(引擎传入 0..1 的手柄), 用它推进着色器里的流动相位。
  const now = (group.userData.t as number | undefined) ?? 0;
  const tNext = now + 1 / 60;
  group.userData.t = tNext;
  // ★ 必须 traverse 而不是 children: 每台发动机外面套了一层 wrapper(为了支持
  //   rig 里改尾焰方向), 火焰是孙节点 —— 用 children 会一个都扫不到, 尾焰直接不动。
  group.traverse((c) => {
    const role = c.userData.role as string | undefined;
    if (!role) return;
    const m = (c as THREE.Mesh).material as THREE.Material & {
      uniforms?: { uIntensity?: { value: number }; uTime?: { value: number } };
      opacity?: number;
      color?: THREE.Color;
    };
    if (!m) return;
    if (role === 'flame') {
      const inner = (c.userData.inner as number | undefined) === 1;
      if (m.uniforms?.uIntensity) m.uniforms.uIntensity.value = intensity;
      if (m.uniforms?.uTime) m.uniforms.uTime.value = tNext;
      // 尺寸: 长度随手柄增长(1.7 → 4.6), 半径略增; 长度带随机抖动(喷流抖动)
      const flick = intensity > 0.4 ? 1 + (Math.random() - 0.5) * 0.3 : 1;
      // === 尺寸按**实测喷口半径**成比例 (per user request: 自动适配大小) ==========
      // 基准: 火焰半径 ≈ 0.9 喷口半径(随手柄 0.55→1.15 倍), 长度 ≈ 5.5~12 个喷口半径。
      // 于是大机体(B-52/AC-130)自然得到大火焰, 小机体也不会顶着一团过大的火。
      const nr = (c.userData.nozzleR as number | undefined) ?? 0.28;
      const grow = inner ? 0.62 : 1;
      const rad = (0.55 + 0.60 * intensity) * nr * grow;
      const len = (5.5 + 6.5 * intensity) * nr * flick * (inner ? 0.8 : 1);
      c.scale.set(rad, len, rad);
    } else if (role === 'ring') {
      if (m.opacity !== undefined) m.opacity = intensity > 0.55 ? Math.min(0.9, (intensity - 0.55) * 2.2) : 0;
      c.scale.setScalar(((c.userData.nozzleR as number | undefined) ?? 0.28) * (1.9 + 1.4 * intensity));
    }
  });
}
