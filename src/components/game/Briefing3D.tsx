'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

// === Briefing 3D scene (per user request) ===
// Renders a simplified 3D preview of the mission area inside the briefing
// panel. Shows:
//   - The mission's map type as a stylized ground (water plane for ocean/
//     archipelago, sandy ground for desert, rocky terrain for mountain,
//     building blocks for city).
//   - Markers for the player start, allied spawn points, and enemy spawn
//     points — colour-coded blue (ally) and red (enemy).
//   - The mission's sky preset as a gradient background.
//   - A slowly rotating camera so the player can see the layout from
//     all angles.
//
// This is intentionally a MINIMAL scene — no aircraft models, no terrain
// detail, no post-processing. Just enough to give the player a spatial
// sense of where enemies and allies will appear relative to their start
// position.

const SKY_COLORS: Record<string, { top: string; bottom: string }> = {
  day: { top: '#3a6a9a', bottom: '#a8c8e0' },
  sunset: { top: '#2a1a3a', bottom: '#e89060' },
  dawn: { top: '#1a2a4a', bottom: '#e8b890' },
  storm: { top: '#2a2a2a', bottom: '#5a5a5a' },
  night: { top: '#050810', bottom: '#1a2030' },
};

const GROUND_COLORS: Record<string, { base: string; detail: string }> = {
  ocean: { base: '#1a4a7a', detail: '#2a6a9a' },
  archipelago: { base: '#1a4a7a', detail: '#3a8a5a' },
  desert: { base: '#c8a878', detail: '#a88858' },
  mountain: { base: '#3a4a3a', detail: '#5a4a3a' },
  city: { base: '#2a2a2a', detail: '#4a4a4a' },
};

export function Briefing3D({ missionId }: { missionId: string }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!mountRef.current) return;
    // Import mission data lazily — keeps this component self-contained.
    let disposed = false;
    let renderer: THREE.WebGLRenderer | null = null;
    let frameId = 0;

    (async () => {
      const { MISSIONS } = await import('@/lib/game/missions');
      const m = MISSIONS.find((x) => x.id === missionId);
      if (!m || disposed) return;
      const mapType = m.map ?? 'ocean';
      const sky = m.sky ?? 'day';
      const skyCol = SKY_COLORS[sky] ?? SKY_COLORS.day;
      const groundCol = GROUND_COLORS[mapType] ?? GROUND_COLORS.ocean;

      const width = mountRef.current!.clientWidth;
      const height = mountRef.current!.clientHeight;
      const scene = new THREE.Scene();
      // Gradient background via fog + clear color.
      scene.background = new THREE.Color(skyCol.bottom);
      scene.fog = new THREE.Fog(new THREE.Color(skyCol.bottom), 200, 800);

      const camera = new THREE.PerspectiveCamera(45, width / height, 1, 2000);
      camera.position.set(180, 120, 180);
      camera.lookAt(0, 0, 0);

      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setSize(width, height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      mountRef.current!.appendChild(renderer.domElement);

      // Lighting
      const ambient = new THREE.AmbientLight(0xffffff, 0.6);
      scene.add(ambient);
      const dir = new THREE.DirectionalLight(0xffffff, 0.8);
      dir.position.set(50, 100, 30);
      scene.add(dir);

      // === Ground plane ===
      // A simple disc with the map type's base colour. For city, add a
      // few building blocks. For mountain, add a few cone peaks. For
      // desert, add a few dune ridges.
      const groundGeom = new THREE.CircleGeometry(150, 64);
      groundGeom.rotateX(-Math.PI / 2);
      const groundMat = new THREE.MeshStandardMaterial({
        color: groundCol.base,
        roughness: 0.9,
        metalness: 0.0,
      });
      const ground = new THREE.Mesh(groundGeom, groundMat);
      scene.add(ground);

      // Map-specific detail props.
      if (mapType === 'city') {
        // Building blocks
        for (let i = 0; i < 30; i++) {
          const h = 8 + Math.random() * 30;
          const w = 4 + Math.random() * 6;
          const box = new THREE.Mesh(
            new THREE.BoxGeometry(w, h, w),
            new THREE.MeshStandardMaterial({ color: groundCol.detail, roughness: 0.7 }),
          );
          const a = Math.random() * Math.PI * 2;
          const r = 20 + Math.random() * 120;
          box.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r);
          scene.add(box);
        }
      } else if (mapType === 'mountain') {
        // Cone peaks
        for (let i = 0; i < 8; i++) {
          const h = 30 + Math.random() * 50;
          const cone = new THREE.Mesh(
            new THREE.ConeGeometry(15 + Math.random() * 15, h, 6),
            new THREE.MeshStandardMaterial({ color: groundCol.detail, roughness: 0.9, flatShading: true }),
          );
          const a = Math.random() * Math.PI * 2;
          const r = 30 + Math.random() * 100;
          cone.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r);
          scene.add(cone);
        }
      } else if (mapType === 'desert') {
        // Dune ridges (low flattened spheres)
        for (let i = 0; i < 6; i++) {
          const dune = new THREE.Mesh(
            new THREE.SphereGeometry(20 + Math.random() * 15, 8, 6),
            new THREE.MeshStandardMaterial({ color: groundCol.detail, roughness: 1.0 }),
          );
          const a = Math.random() * Math.PI * 2;
          const r = 30 + Math.random() * 100;
          dune.position.set(Math.cos(a) * r, -10, Math.sin(a) * r);
          dune.scale.set(2, 0.4, 1);
          scene.add(dune);
        }
      } else if (mapType === 'archipelago') {
        // A few small islands
        for (let i = 0; i < 5; i++) {
          const island = new THREE.Mesh(
            new THREE.ConeGeometry(10 + Math.random() * 10, 8 + Math.random() * 8, 6),
            new THREE.MeshStandardMaterial({ color: '#3a8a5a', roughness: 0.9 }),
          );
          const a = (i / 5) * Math.PI * 2;
          const r = 60 + Math.random() * 60;
          island.position.set(Math.cos(a) * r, 4, Math.sin(a) * r);
          scene.add(island);
        }
      }

      // === Spawn markers ===
      // Player start — bright cyan diamond.
      const playerStart = m.startPos;
      const playerMarker = new THREE.Mesh(
        new THREE.OctahedronGeometry(4, 0),
        new THREE.MeshStandardMaterial({ color: 0x00ffff, emissive: 0x00aaff, emissiveIntensity: 0.5 }),
      );
      playerMarker.position.set(playerStart[0] * 0.02, 5, playerStart[2] * 0.02);
      scene.add(playerMarker);

      // Ally spawns — blue spheres.
      for (const s of m.spawns) {
        if (s.isWingman || s.role === 'wingman') {
          const marker = new THREE.Mesh(
            new THREE.SphereGeometry(3, 8, 8),
            new THREE.MeshStandardMaterial({ color: 0x4a8aff, emissive: 0x2a4aaa, emissiveIntensity: 0.3 }),
          );
          marker.position.set(s.position[0] * 0.02, 4, s.position[2] * 0.02);
          scene.add(marker);
        }
      }
      // Enemy spawns — red cones.
      for (const s of m.spawns) {
        if (!s.isWingman && s.role !== 'wingman') {
          const marker = new THREE.Mesh(
            new THREE.ConeGeometry(3, 6, 6),
            new THREE.MeshStandardMaterial({ color: 0xff4a4a, emissive: 0xaa2a2a, emissiveIntensity: 0.4 }),
          );
          marker.position.set(s.position[0] * 0.02, 5, s.position[2] * 0.02);
          scene.add(marker);
        }
      }
      // Wave spawns (if any) — orange cones.
      if (m.waves) {
        for (const w of m.waves) {
          for (const s of w.spawns) {
            const marker = new THREE.Mesh(
              new THREE.ConeGeometry(2.5, 5, 6),
              new THREE.MeshStandardMaterial({ color: 0xff8a30, emissive: 0xaa4a10, emissiveIntensity: 0.3, transparent: true, opacity: 0.7 }),
            );
            marker.position.set(s.position[0] * 0.02, 4, s.position[2] * 0.02);
            scene.add(marker);
          }
        }
      }

      // Slowly rotate the camera around the scene.
      const startTime = performance.now();
      const animate = () => {
        if (disposed) return;
        const t = (performance.now() - startTime) / 1000;
        const angle = t * 0.15;
        camera.position.x = Math.cos(angle) * 220;
        camera.position.z = Math.sin(angle) * 220;
        camera.position.y = 120 + Math.sin(t * 0.3) * 10;
        camera.lookAt(0, 0, 0);
        renderer!.render(scene, camera);
        frameId = requestAnimationFrame(animate);
      };
      animate();

      // Resize handler
      const onResize = () => {
        if (!mountRef.current || !renderer) return;
        const w = mountRef.current.clientWidth;
        const h = mountRef.current.clientHeight;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      window.addEventListener('resize', onResize);

      cleanupRef.current = () => {
        window.removeEventListener('resize', onResize);
        cancelAnimationFrame(frameId);
        if (renderer) {
          renderer.dispose();
          if (renderer.domElement.parentNode) {
            renderer.domElement.parentNode.removeChild(renderer.domElement);
          }
        }
        scene.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.geometry) mesh.geometry.dispose();
          const mat = mesh.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else if (mat) mat.dispose();
        });
      };
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      if (cleanupRef.current) cleanupRef.current();
    };
  }, [missionId]);

  return (
    <div
      ref={mountRef}
      className="w-full h-48 border border-cyan-400/30 bg-black/40"
      style={{ minHeight: '12rem' }}
    />
  );
}
