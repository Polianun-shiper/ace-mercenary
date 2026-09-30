// scripts/test-joystick-input.mjs
//
// Unit tests for the virtual-input plumbing behind the on-screen joystick:
//   - InputManager virtual API (setVirtualAxis / setVirtualHeld / pressVirtual / clearVirtual)
//   - computeStickVector (stick math: deadzone, clamping, circle normalization)
//
// The VirtualJoystick component itself is exercised in the browser test
// harness (dist-test/joystick-test.html) — this covers the pure logic.
//
// Run: node scripts/test-joystick-input.mjs

import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let failures = 0;
const check = (name, cond) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
};

// --- Compile the two modules to CJS so Node can import them (jsdom-free) ---
const outdir = join(ROOT, '.test-build');
await build({
  entryPoints: [
    join(ROOT, 'src/lib/game/input.ts'),
    join(ROOT, 'src/lib/game/weapon-slots.ts'),
    join(ROOT, 'src/components/game/VirtualJoystick.tsx'),
    join(ROOT, 'src/components/game/Hud.tsx'),
    join(ROOT, 'src/lib/game/engine.ts'),
  ],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outdir,
  logLevel: 'silent',
  alias: { '@': join(ROOT, 'src') },
  external: ['react', 'react-dom', 'react-dom/client', 'three', 'three/*'],
  jsx: 'automatic',
});

const { InputManager } = await import(pathToFileURL(join(outdir, 'lib/game/input.js')).href);
const { tickWeaponSlots, consumeWeaponSlot } = await import(pathToFileURL(join(outdir, 'lib/game/weapon-slots.js')).href);
const {
  computeStickVector,
  loadLayout,
  saveLayout,
  clampPos,
  DEFAULT_LAYOUT,
} = await import(pathToFileURL(join(outdir, 'components/game/VirtualJoystick.js')).href);
const { hitTestMarkers } = await import(pathToFileURL(join(outdir, 'components/game/Hud.js')).href);
const { GUNSHIP_GUNS, DIFFICULTY_SCALES } = await import(pathToFileURL(join(outdir, 'lib/game/engine.js')).href);

console.log('\n== InputManager virtual API ==');
// localStorage is unavailable in plain Node — constructor must not throw.
const im = new InputManager();
check('constructor does not throw without localStorage', true);

check('initial axes are 0', im.pitchAxis() === 0 && im.rollAxis() === 0 && im.yawAxis() === 0);

im.setVirtualAxis('pitch', 1);
check('setVirtualAxis pitch=1 → pitchAxis()=1', im.pitchAxis() === 1);
im.setVirtualAxis('roll', -1);
check('setVirtualAxis roll=-1 → rollAxis()=-1', im.rollAxis() === -1);

im.setVirtualAxis('pitch', 5);
check('axis clamped to 1', im.pitchAxis() === 1);
im.setVirtualAxis('pitch', -2);
check('axis clamped to -1', im.pitchAxis() === -1);

// Mixing keyboard-style held + virtual analog stays clamped.
im.setVirtualHeld('pitchDown', true);
check('keyboard held + virtual -1 clamps to -1', im.pitchAxis() === -1);
im.setVirtualAxis('pitch', 0.5);
check('keyboard held + virtual 0.5 → +0.5 (held wins sign)', im.pitchAxis() === 0.5);
im.setVirtualHeld('pitchDown', false);

// Held actions.
im.setVirtualHeld('brake', true);
im.setVirtualHeld('fireGun', true);
check('setVirtualHeld brake=true → isHeld', im.isHeld('brake') === true);
check('setVirtualHeld fireGun=true → isHeld', im.isHeld('fireGun') === true);
im.setVirtualHeld('brake', false);
check('setVirtualHeld brake=false → not held', im.isHeld('brake') === false);

// Edge actions — written into `pressed`, consumed by clearFrame like keys.
im.pressVirtual('fireMissile');
im.pressVirtual('flare');
check('pressVirtual fireMissile → isPressed', im.isPressed('fireMissile') === true);
check('pressVirtual flare → isPressed', im.isPressed('flare') === true);
im.clearFrame();
check('clearFrame clears virtual presses', im.isPressed('fireMissile') === false && im.isPressed('flare') === false);

// clearVirtual resets everything.
im.setVirtualAxis('yaw', 0.8);
im.setVirtualHeld('throttleUp', true);
im.pressVirtual('cycleCamera');
im.clearVirtual();
check('clearVirtual zeroes axes', im.yawAxis() === 0);
check('clearVirtual clears held', im.isHeld('throttleUp') === false);
check('clearVirtual does not clear pressed (owned by clearFrame)', im.isPressed('cycleCamera') === true);

// Inversion applies to virtual axes too (settings consistency).
im.setVirtualAxis('pitch', 1);
im.setInversion('pitch', true);
check('inversion flips virtual axis', im.pitchAxis() === -1);
im.setInversion('pitch', false);

console.log('\n== computeStickVector ==');
// NOTE: pointer Y is screen-down; stick "up" (pointer above origin) → y=-1.
// The component maps pitch = -y, so up = nose-up. Tests assert the RAW math.
const c = (ox, oy, x, y) => computeStickVector(ox, oy, x, y);

let v = c(0, 0, 0, 0);
check('center → (0,0)', v.x === 0 && v.y === 0);

v = c(0, 0, 0, -42);
check('full up → y=-1', v.y === -1);
v = c(0, 0, 42, 0);
check('full right → x=1', v.x === 1);
v = c(0, 0, 0, 42);
check('full down → y=1', v.y === 1);
v = c(0, 0, -42, 0);
check('full left → x=-1', v.x === -1);

v = c(0, 0, 0, -84);
check('beyond travel clamps to 1', v.y === -1);

v = c(0, 0, 0, -21);
check('half deflection → y≈-0.457 (deadzone re-mapped)', Math.abs(v.y + 0.4565) < 0.01);

v = c(0, 0, 0, -3);
check('inside deadzone → 0', v.y === 0);

v = c(100, 100, 130, 130);
check('origin offset works', Math.abs(v.x - 0.682) < 0.01 && Math.abs(v.y - 0.682) < 0.01);

console.log('\n== Layout persistence (loadLayout / saveLayout / clampPos) ==');
// In-memory storage stand-in.
const mem = new Map();
const storage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
};

// No saved layout → defaults.
const l0 = loadLayout(storage);
check('no storage → defaults returned', JSON.stringify(l0) === JSON.stringify(DEFAULT_LAYOUT));
check('defaults include all 8 units', Object.keys(l0).length === 8);

// Saved layout overrides per-unit, missing units fall back to defaults.
saveLayout({ leftStick: { x: 10, y: 20 }, actions: { x: 50, y: 50 } }, storage);
const l1 = loadLayout(storage);
check('saved unit overrides default', l1.leftStick.x === 10 && l1.leftStick.y === 20);
check('saved actions override', l1.actions.x === 50 && l1.actions.y === 50);
check('unsaved units keep defaults', l1.fire.x === DEFAULT_LAYOUT.fire.x && l1.pause.y === DEFAULT_LAYOUT.pause.y);
check('unknown saved keys ignored', Object.keys(l1).length === 8);

// Saved values are clamped into 5..95.
saveLayout({ rightStick: { x: -10, y: 120 } }, storage);
const l2 = loadLayout(storage);
check('saved values clamped', l2.rightStick.x === 5 && l2.rightStick.y === 95);

// Corrupt JSON → defaults.
mem.set('skybound.vjLayout', '{not json');
const l3 = loadLayout(storage);
check('corrupt JSON → defaults', JSON.stringify(l3) === JSON.stringify(DEFAULT_LAYOUT));

// clampPos basics.
check('clampPos inside range untouched', clampPos({ x: 50, y: 50 }).x === 50);
check('clampPos clamps low', clampPos({ x: -3, y: 0 }).x === 5 && clampPos({ x: -3, y: 0 }).y === 5);
check('clampPos clamps high', clampPos({ x: 100, y: 200 }).x === 95 && clampPos({ x: 100, y: 200 }).y === 95);
check('clampPos custom bounds', clampPos({ x: 0, y: 0 }, 10, 90).x === 10);

console.log('\n== Dual-slot weapon reload (tickWeaponSlots / consumeWeaponSlot) ==');
const RELOAD = 4.0;
// Both slots start ready.
let s = [0, 0];
check('both slots initially ready', s[0] <= 0 && s[1] <= 0);

// Fire 1 → slot A arms, slot B stays ready.
const r1 = consumeWeaponSlot(s, RELOAD);
check('first shot arms slot A', r1 !== null && r1[0] === 4.0 && r1[1] <= 0);
if (r1) s = r1;

// Fire 2 immediately → slot B arms (independent slot).
const r2 = consumeWeaponSlot(s, RELOAD);
check('second shot arms slot B', r2 !== null && r2[0] === 4.0 && r2[1] === 4.0);
if (r2) s = r2;

// Fire 3 → both reloading → blocked.
check('third shot blocked while both reloading', consumeWeaponSlot(s, RELOAD) === null);

// After 4s both are ready again.
s = tickWeaponSlots(s, RELOAD);
check('after 4s both slots ready', s[0] <= 0 && s[1] <= 0);

// Asymmetric case: fire one, wait 2s, fire the other → one slot reloads
// while the other is still counting down.
s = [0, 0];
s = consumeWeaponSlot(s, RELOAD) ?? s;         // arm A
s = tickWeaponSlots(s, 2.0);                   // A has 2s left
s = consumeWeaponSlot(s, RELOAD) ?? s;         // arm B (full 4s)
check('independent timers: A=2s remaining, B=4s', Math.abs(s[0] - 2) < 1e-9 && Math.abs(s[1] - 4) < 1e-9);
s = tickWeaponSlots(s, 2.0);                   // A ready, B 2s left
check('A ready after its 2s, B still reloading', s[0] <= 0 && Math.abs(s[1] - 2) < 1e-9);
const r3 = consumeWeaponSlot(s, RELOAD);
check('A can fire again while B reloads', r3 !== null && Math.abs(r3[1] - 2) < 1e-9);
check('tick clamps at 0 (never negative)', tickWeaponSlots([1.5, 0.1], 10)[0] === 0);

console.log('\n== Marker hit test (hitTestMarkers) ==');
const mk = (id, x, y, dist, onScreen = true, type = 'enemy') => ({
  x, y, type, id, onScreen, isTarget: false, dist, edgeX: 0, edgeY: 0,
});
const W = 1000, H = 800;
const markers = [
  mk(1, 0.2, 0.3, 500),     // box ~52px at dist 500
  mk(2, 0.7, 0.3, 500),
  mk(3, 0.5, 0.5, 10000),   // far → small box (~25px)
];
// Click inside marker 1's box.
check('click inside box 1 → id 1', hitTestMarkers(markers, W, H, 0.2 * W, 0.3 * H) === 1);
// Click near box 1 edge (within grace).
check('click near box 1 edge → id 1', hitTestMarkers(markers, W, H, 0.2 * W + 28, 0.3 * H) === 1);
// Click far from any box → null.
check('click empty area → null', hitTestMarkers(markers, W, H, 0.05 * W, 0.05 * H) === null);
// Click inside box 3 (small box).
check('click inside far box 3 → id 3', hitTestMarkers(markers, W, H, 0.5 * W, 0.5 * H) === 3);
// Off-screen markers are never hit.
const off = [mk(4, 0.1, 0.1, 300, false)];
check('off-screen marker → null', hitTestMarkers(off, W, H, 0.1 * W, 0.1 * H) === null);
// Missile markers are never hit.
const miss = [mk(5, 0.5, 0.5, 300, true, 'missile')];
check('missile marker → null', hitTestMarkers(miss, W, H, 0.5 * W, 0.5 * H) === null);
// Overlapping boxes → nearest one wins (click closer to box 6's center).
const overlap = [mk(6, 0.5, 0.5, 300), mk(7, 0.505, 0.505, 300)];
check('overlap → nearest (id 6)', hitTestMarkers(overlap, W, H, 0.501 * W, 0.501 * H) === 6);

console.log('\n== Gunship cannon catalog (GUNSHIP_GUNS) ==');
const gunIds = Object.keys(GUNSHIP_GUNS);
check('exactly 3 selectable guns (25/40/105)', gunIds.length === 3 && gunIds.includes('g25') && gunIds.includes('g40') && gunIds.includes('g105'));
check('fire rate: 25mm fastest', GUNSHIP_GUNS.g25.rate < GUNSHIP_GUNS.g40.rate && GUNSHIP_GUNS.g40.rate < GUNSHIP_GUNS.g105.rate);
check('shake scales with caliber (按口径晃动)', GUNSHIP_GUNS.g105.shake > GUNSHIP_GUNS.g40.shake && GUNSHIP_GUNS.g40.shake > GUNSHIP_GUNS.g25.shake);
check('105mm has the biggest blast radius', GUNSHIP_GUNS.g105.radius > GUNSHIP_GUNS.g40.radius && GUNSHIP_GUNS.g40.radius > GUNSHIP_GUNS.g25.radius);
check('shell speed: smaller calibers faster', GUNSHIP_GUNS.g25.shellSpeed > GUNSHIP_GUNS.g40.shellSpeed && GUNSHIP_GUNS.g40.shellSpeed > GUNSHIP_GUNS.g105.shellSpeed);
check('gravity: heavier shells drop more', GUNSHIP_GUNS.g105.gravity > GUNSHIP_GUNS.g40.gravity && GUNSHIP_GUNS.g40.gravity > GUNSHIP_GUNS.g25.gravity);
check('all guns have sane positive values', Object.values(GUNSHIP_GUNS).every((g) => g.rate > 0 && g.shellDamage > 0 && g.shellSpeed > 0 && g.shellCount >= 1));

console.log('\n== Difficulty scaling (DIFFICULTY_SCALES) ==');
check('easy = least aggressive (longest cooldowns)', DIFFICULTY_SCALES.easy.enemyCd > DIFFICULTY_SCALES.normal.enemyCd && DIFFICULTY_SCALES.normal.enemyCd > DIFFICULTY_SCALES.hard.enemyCd);
check('easy = slowest locks', DIFFICULTY_SCALES.easy.lockTime > DIFFICULTY_SCALES.normal.lockTime && DIFFICULTY_SCALES.normal.lockTime > DIFFICULTY_SCALES.hard.lockTime);
check('easy = shortest radar range', DIFFICULTY_SCALES.easy.range < DIFFICULTY_SCALES.normal.range && DIFFICULTY_SCALES.normal.range < DIFFICULTY_SCALES.hard.range);
check('attacker budget: 2 / 3 / 4', DIFFICULTY_SCALES.easy.budget === 2 && DIFFICULTY_SCALES.normal.budget === 3 && DIFFICULTY_SCALES.hard.budget === 4);
check('ground/naval baseline nerf (normal: slower + shorter range)', DIFFICULTY_SCALES.normal.groundCd > 1 && DIFFICULTY_SCALES.normal.groundRange < 1);
check('hard ground units more aggressive than normal', DIFFICULTY_SCALES.hard.groundCd < DIFFICULTY_SCALES.normal.groundCd && DIFFICULTY_SCALES.hard.groundRange > DIFFICULTY_SCALES.normal.groundRange);

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
