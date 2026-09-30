import * as THREE from 'three';

// ============================================================================
// === WORLD-DISTRIBUTED CLOUD CLUSTERS =======================================
// ============================================================================
// Polygonal cloud clusters at fixed world positions. Each cluster is a group
// of jittered icosahedron "lobes" that read as puffy cumulus clouds. The
// clusters are placed across a large radius around the world origin and
// drift slowly with the wind — when the player flies past one, it stays
// behind (unlike a sky dome which always follows the camera).
//
// Three coverage presets:
//   scattered — random disc placement, mostly isolated puffs
//   mixed     — half banked (linear cloud banks), half scattered
//   overcast  — mostly banked, tighter spacing
//
// Stormy weather swaps the material for a dark, slightly emissive variant
// so clouds read as threatening thunderheads.
// ============================================================================

export interface WorldCloudCluster {
  group: THREE.Group;
  driftDir: number;
  driftSpeed: number;
}

export interface WorldCloudFieldOpts {
  count?: number;
  spread?: number;
  baseHeight?: number;
  coverage?: 'scattered' | 'mixed' | 'overcast';
  cloudColor?: THREE.Color;
  isStormy?: boolean;
}

function getLobeTemplates(): THREE.BufferGeometry[] {
  const cached = THREE.Cache.get('skybound-cloud-lobe-templates');
  if (cached) return cached as THREE.BufferGeometry[];
  const puffGeom = new THREE.IcosahedronGeometry(1, 1);
  const templates: THREE.BufferGeometry[] = [];
  for (let t = 0; t < 4; t++) {
    const g = puffGeom.clone();
    const pos = g.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < arr.length; i += 3) {
      const nx = arr[i], ny = arr[i + 1], nz = arr[i + 2];
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      const jitter = 0.65 + Math.random() * 0.7;
      arr[i] = (nx / len) * jitter;
      arr[i + 1] = (ny / len) * jitter;
      arr[i + 2] = (nz / len) * jitter;
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
    // Shared across missions — engine.dispose() must NOT free it.
    (g as any).userData.shared = true;
    templates.push(g);
  }
  THREE.Cache.add('skybound-cloud-lobe-templates', templates);
  return templates;
}

export function buildWorldCloudClusters(opts: WorldCloudFieldOpts = {}): {
  group: THREE.Group;
  clusters: WorldCloudCluster[];
  dispose: () => void;
} {
  const count = opts.count ?? 220;
  const spread = opts.spread ?? 38000;
  const baseHeight = opts.baseHeight ?? 1800;
  const coverage = opts.coverage ?? 'mixed';
  const isStormy = opts.isStormy ?? false;

  const group = new THREE.Group();
  const clusters: WorldCloudCluster[] = [];

  const cloudColor = opts.cloudColor ?? new THREE.Color(0xffffff);
  const litColor = isStormy
    ? new THREE.Color(0x6a7280)
    : cloudColor.clone().lerp(new THREE.Color(0xffffff), 0.4);
  const litMat = new THREE.MeshStandardMaterial({
    color: litColor,
    roughness: 0.95,
    metalness: 0,
    transparent: true,
    opacity: 0.92,
    flatShading: true,
    depthWrite: false,
  });
  const stormMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x3a3f48),
    roughness: 1.0,
    metalness: 0,
    transparent: true,
    opacity: 0.96,
    flatShading: true,
    depthWrite: false,
    emissive: new THREE.Color(0x080a0e),
    emissiveIntensity: 0.4,
  });
  const activeMat = isStormy ? stormMat : litMat;
  const lobeTemplates = getLobeTemplates();

  const placements: { x: number; y: number; z: number; bank: boolean }[] = [];
  const randDisc = () => {
    const r = Math.sqrt(Math.random()) * spread;
    const a = Math.random() * Math.PI * 2;
    return { x: Math.cos(a) * r, z: Math.sin(a) * r };
  };
  const randY = (jitter: number) => baseHeight + (Math.random() - 0.5) * jitter;
  const genBank = (n: number, spacing: number, crossJitter: number) => {
    const center = randDisc();
    const heading = Math.random() * Math.PI * 2;
    const dx = Math.cos(heading);
    const dz = Math.sin(heading);
    const halfLen = (n - 1) * spacing * 0.5;
    for (let k = 0; k < n; k++) {
      const t = k * spacing - halfLen;
      const cross = (Math.random() - 0.5) * crossJitter;
      placements.push({
        x: center.x + dx * t + dz * cross,
        y: randY(600),
        z: center.z + dz * t - dx * cross,
        bank: true,
      });
    }
  };
  if (coverage === 'scattered') {
    for (let i = 0; i < count; i++) {
      const p = randDisc();
      placements.push({ x: p.x, y: randY(800), z: p.z, bank: false });
    }
  } else if (coverage === 'mixed') {
    const bankClouds = Math.floor(count * 0.5);
    let placed = 0;
    const bankCount = 2 + Math.floor(Math.random() * 3);
    const perBank = Math.max(4, Math.floor(bankClouds / bankCount));
    for (let b = 0; b < bankCount && placed < bankClouds; b++) {
      const n = Math.min(perBank + Math.floor(Math.random() * 3), bankClouds - placed);
      genBank(n, 320, 280);
      placed += n;
    }
    while (placements.length < count) {
      const p = randDisc();
      placements.push({ x: p.x, y: randY(800), z: p.z, bank: false });
    }
  } else {
    const bankClouds = Math.floor(count * 0.85);
    let placed = 0;
    const bankCount = 3 + Math.floor(Math.random() * 3);
    const perBank = Math.max(6, Math.floor(bankClouds / bankCount));
    for (let b = 0; b < bankCount && placed < bankClouds; b++) {
      const n = Math.min(perBank + Math.floor(Math.random() * 4), bankClouds - placed);
      genBank(n, 180, 180);
      placed += n;
    }
    while (placements.length < count) {
      const p = randDisc();
      placements.push({ x: p.x, y: randY(800), z: p.z, bank: false });
    }
  }

  for (let i = 0; i < count; i++) {
    const placement = placements[i];
    const cloudGroup = new THREE.Group();
    const isBank = placement.bank;
    const lobeCount = isBank ? 8 + Math.floor(Math.random() * 6) : 5 + Math.floor(Math.random() * 6);
    const baseSize = isBank ? 360 + Math.random() * 420 : 280 + Math.random() * 380;
    const verticalBias = isBank ? 0.25 : 0.45;
    for (let j = 0; j < lobeCount; j++) {
      const tmpl = lobeTemplates[Math.floor(Math.random() * lobeTemplates.length)];
      const mesh = new THREE.Mesh(tmpl, activeMat);
      const angle = Math.random() * Math.PI * 2;
      const r = Math.random() * baseSize * (isBank ? 0.85 : 0.7);
      const lobeScale = baseSize * (0.55 + Math.random() * 0.6);
      mesh.position.set(
        Math.cos(angle) * r,
        (Math.random() - 0.3) * baseSize * verticalBias,
        Math.sin(angle) * r,
      );
      mesh.scale.setScalar(lobeScale);
      cloudGroup.add(mesh);
    }
    cloudGroup.position.set(placement.x, placement.y, placement.z);
    const driftSpeed = 4 + Math.random() * 6;
    const driftDir = Math.random() * Math.PI * 2;
    (cloudGroup as any)._env = true;
    group.add(cloudGroup);
    clusters.push({ group: cloudGroup, driftDir, driftSpeed });
  }

  const dispose = () => {
    litMat.dispose();
    stormMat.dispose();
  };

  return { group, clusters, dispose };
}
