/**
 * TestFlightScene — the world the test-flight mode flies in
 * =====================================================================
 * A clean sky + distant mountains + a long runway + scattered airports.
 * No wingmen, no enemies, no ground units — pure aerodynamic playground.
 *
 * The scene reuses the engine lab's atmospheric sky if available; falls
 * back to a simple gradient skydome + hemisphere light otherwise.
 */

import * as THREE from 'three';

export interface TestFlightScene {
  group: THREE.Group;
  /** Sun directional light (for shadows + sky scattering) */
  sun: THREE.DirectionalLight;
  /** Update sky state (sun position follows time-of-day if desired) */
  update: (dt: number, cameraPos: THREE.Vector3) => void;
}

export function buildTestFlightScene(): TestFlightScene {
  const group = new THREE.Group();

  // === Skydome (gradient) ===
  // Two-color vertical gradient via a large inverted sphere with custom shader
  const skyGeo = new THREE.SphereGeometry(40000, 32, 16);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor:    { value: new THREE.Color(0x2a5fb8) },
      bottomColor: { value: new THREE.Color(0xc8d8f0) },
      sunDir:      { value: new THREE.Vector3(0.4, 0.7, 0.3).normalize() },
      sunColor:    { value: new THREE.Color(0xfff0c8) },
    },
    vertexShader: /* glsl */`
      varying vec3 vWorldPos;
      void main() {
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vWorldPos;
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      uniform vec3 sunDir;
      uniform vec3 sunColor;
      void main() {
        vec3 dir = normalize(vWorldPos);
        float t = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 col = mix(bottomColor, topColor, pow(t, 0.8));
        // Sun glow
        float sunDot = max(dot(dir, sunDir), 0.0);
        col += sunColor * pow(sunDot, 200.0) * 0.8;
        col += sunColor * pow(sunDot, 8.0) * 0.06;
        // Horizon haze
        col = mix(col, bottomColor * 1.05, pow(1.0 - abs(dir.y), 8.0) * 0.5);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.frustumCulled = false;
  group.add(sky);

  // === Lighting ===
  const hemi = new THREE.HemisphereLight(0xb8d8ff, 0x806040, 0.6);
  group.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff4d8, 2.2);
  sun.position.set(600, 1000, 400);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -200;
  sun.shadow.camera.right = 200;
  sun.shadow.camera.top = 200;
  sun.shadow.camera.bottom = -200;
  sun.shadow.camera.near = 100;
  sun.shadow.camera.far = 3000;
  sun.shadow.bias = -0.0001;
  sun.shadow.normalBias = 0.02;
  group.add(sun);

  // === Terrain — large textured ground with rolling hills ===
  const terrainGeo = new THREE.PlaneGeometry(40000, 40000, 200, 200);
  const pos = terrainGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    // Smooth rolling hills, zero near origin (where runway is)
    const distFromOrigin = Math.sqrt(x*x + y*y);
    const flatZone = 1500;
    const heightMul = Math.max(0, Math.min(1, (distFromOrigin - flatZone) / 2000));
    const h = (Math.sin(x * 0.0008) * 30 + Math.cos(y * 0.0011) * 25 + Math.sin((x+y) * 0.003) * 8) * heightMul;
    pos.setZ(i, h);
  }
  terrainGeo.computeVertexNormals();
  const terrainMat = new THREE.MeshStandardMaterial({
    color: 0x4a5a3a,
    roughness: 0.95,
    metalness: 0.0,
    flatShading: false,
  });
  const terrain = new THREE.Mesh(terrainGeo, terrainMat);
  terrain.rotation.x = -Math.PI / 2;
  terrain.receiveShadow = true;
  terrain.frustumCulled = false;
  group.add(terrain);

  // === Runway ===
  const runwayMat = new THREE.MeshStandardMaterial({
    color: 0x2a2a2e,
    roughness: 0.85,
    metalness: 0.0,
  });
  const runway = new THREE.Mesh(new THREE.PlaneGeometry(80, 3000), runwayMat);
  runway.rotation.x = -Math.PI / 2;
  runway.position.y = 0.1;
  runway.receiveShadow = true;
  group.add(runway);

  // Runway markings — centerline dashes
  const dashMat = new THREE.MeshBasicMaterial({ color: 0xeeeeee });
  for (let z = -1400; z <= 1400; z += 60) {
    const dash = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 30), dashMat);
    dash.rotation.x = -Math.PI / 2;
    dash.position.set(0, 0.15, z);
    group.add(dash);
  }
  // Threshold stripes
  const thresholdMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  for (let i = 0; i < 6; i++) {
    const t1 = new THREE.Mesh(new THREE.PlaneGeometry(8, 60), thresholdMat);
    t1.rotation.x = -Math.PI / 2;
    t1.position.set(-30 + i * 12, 0.15, -1450);
    group.add(t1);
    const t2 = t1.clone();
    t2.position.z = 1450;
    group.add(t2);
  }

  // === Distant mountains for visual reference ===
  const mountainMat = new THREE.MeshStandardMaterial({
    color: 0x6a7080,
    roughness: 0.95,
    metalness: 0.0,
    flatShading: true,
  });
  for (let i = 0; i < 40; i++) {
    const angle = (i / 40) * Math.PI * 2;
    const dist = 15000 + Math.random() * 3000;
    const h = 1500 + Math.random() * 1500;
    const w = 3000 + Math.random() * 2000;
    const m = new THREE.Mesh(new THREE.ConeGeometry(w / 2, h, 6), mountainMat);
    m.position.set(Math.cos(angle) * dist, h / 2 - 50, Math.sin(angle) * dist);
    m.castShadow = false;
    m.receiveShadow = true;
    group.add(m);
  }

  // === Scattered clouds (sprite-based, no overdraw cost) ===
  // We'll generate a soft cloud texture procedurally
  const cloudCanvas = document.createElement('canvas');
  cloudCanvas.width = 256; cloudCanvas.height = 256;
  const cctx = cloudCanvas.getContext('2d')!;
  const grad = cctx.createRadialGradient(128, 128, 20, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.4)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  cctx.fillStyle = grad;
  cctx.fillRect(0, 0, 256, 256);
  const cloudTex = new THREE.CanvasTexture(cloudCanvas);
  const cloudMat = new THREE.SpriteMaterial({
    map: cloudTex,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  for (let i = 0; i < 60; i++) {
    const cloud = new THREE.Sprite(cloudMat.clone());
    const angle = Math.random() * Math.PI * 2;
    const r = 2000 + Math.random() * 12000;
    cloud.position.set(
      Math.cos(angle) * r,
      600 + Math.random() * 1500,
      Math.sin(angle) * r,
    );
    const s = 600 + Math.random() * 800;
    cloud.scale.set(s, s * 0.6, 1);
    group.add(cloud);
  }

  return {
    group,
    sun,
    update: (dt: number, cameraPos: THREE.Vector3) => {
      // Skydome follows camera (infinite distance feel)
      sky.position.copy(cameraPos);
      // Sun follows camera too (so shadows stay near)
      sun.position.set(cameraPos.x + 600, cameraPos.y + 1000, cameraPos.z + 400);
      sun.target.position.copy(cameraPos);
      sun.target.updateMatrixWorld();
    },
  };
}
