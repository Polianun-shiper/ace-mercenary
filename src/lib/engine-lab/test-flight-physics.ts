/**
 * TestFlightPhysics — War Thunder-style 6DOF aerodynamic flight model
 * =====================================================================
 * Replaces the arcade-style "velocity = forward × speed" flight model
 * used in the main game with a proper 6-degrees-of-freedom aerodynamic
 * simulation. Used ONLY in the Engine Lab's Test Flight mode — the main
 * game keeps its arcade physics for gameplay pacing.
 *
 * === Model summary ===
 *
 *  • Standard ISA atmosphere (air density varies with altitude)
 *  • Lift:  L = 0.5 · ρ · V² · S · Cl(α)        α = angle of attack
 *  • Drag:  D = 0.5 · ρ · V² · S · (Cd0 + k·Cl²)
 *  • Side:  Y = 0.5 · ρ · V² · S · Cy(β)         β = sideslip
 *  • Thrust: T(V, h) — laps with altitude, slight speed falloff
 *  • Weight: W = m · g
 *  • Control surfaces:
 *      elevator  → pitch torque (with speed-dependent authority)
 *      ailerons  → roll torque
 *      rudder    → yaw torque
 *  • Aero damping: pitch/roll/yaw rates produce opposing moments
 *  • Stall: when α > α_critical, Cl drops sharply AND a wake-induced
 *    yawing moment appears (post-stall gyration / incipient spin)
 *
 * === Per-aircraft parameters ===
 *
 * All 10 player aircraft have realistic numbers sourced from public
 * data (mass, wing area, thrust, Cl_max). Where exact figures aren't
 * public, reasonable estimates are used. Parameters are tuned so each
 * aircraft feels distinct, mirroring War Thunder's flight characteristics:
 *   - F-16: relaxed stability, very high AoA tolerance, fast pitch rate
 *   - F-15: heavy twin-engine, high energy retention, lower roll at speed
 *   - Su-35: long-range delta canard, post-stall authority, high lift
 *   - A-10: straight wing, low speed authority, very stable, slow
 *   - B-52: huge bomber, slow pitch, low roll rate, high yaw stability
 *   - EA-18G: derived from F/A-18, medium-high alpha, balanced
 *   - AC-130: gunship, very stable, slow but predictable
 *   - F-117: stealth faceted, low AoA tolerance, high drag
 *   - E-3: AWACS based on 707 — very heavy, gentle, slow
 *   - Tu-95: turboprop, huge prop torque, requires rudder trim
 */

import * as THREE from 'three';
import type { AircraftModel } from '@/lib/game/types';

// === Constants =============================================================

const G = 9.81;                              // m/s²
const RHO_SL = 1.225;                        // kg/m³ at sea level (ISA)
const SCALE_HEIGHT = 8500;                   // m, exponential atmosphere
const KTS_TO_MPS = 0.5144;

// === Per-aircraft aerodynamic parameters ===================================

export interface AeroParams {
  /** Mass in kg (loaded, mid-fuel) */
  mass: number;
  /** Wing area in m² */
  wingArea: number;
  /** Max static thrust at sea level, both engines combined, in N */
  maxThrust: number;
  /** Parasitic (zero-lift) drag coefficient */
  cd0: number;
  /** Oswald efficiency factor — converts to induced drag k = 1/(π·AR·e) */
  oswaldE: number;
  /** Aspect ratio (span² / area) */
  aspectRatio: number;
  /** Lift-curve slope, per radian (linear region) */
  clAlpha: number;
  /** Max lift coefficient (just before stall break) */
  clMax: number;
  /** Critical angle of attack (stall onset), radians */
  alphaCritical: number;
  /** Post-stall Cl multiplier (e.g. 0.4 means Cl drops to 40% of peak) */
  postStallClFrac: number;
  /** Sideslip derivative — yaw stability */
  cyBeta: number;
  /** Pitch control authority coefficient (elevator) */
  pitchAuth: number;
  /** Roll control authority coefficient (ailerons) */
  rollAuth: number;
  /** Yaw control authority coefficient (rudder) */
  yawAuth: number;
  /** Pitch damping (1/s) — higher = snappier, less overshoot */
  pitchDamp: number;
  /** Roll damping (1/s) */
  rollDamp: number;
  /** Yaw damping (1/s) */
  yawDamp: number;
  /** Positive G structural limit */
  gLimitPos: number;
  /** Negative G structural limit (negative) */
  gLimitNeg: number;
  /** Inertia scaling — small fighters rotate faster */
  inertiaScale: number;
}

const DEFAULT_AERO: AeroParams = {
  mass: 12000, wingArea: 28, maxThrust: 130000, cd0: 0.022, oswaldE: 0.85,
  aspectRatio: 3.5, clAlpha: 5.0, clMax: 1.4, alphaCritical: 0.35,
  postStallClFrac: 0.55, cyBeta: -0.4,
  pitchAuth: 1.0, rollAuth: 1.0, yawAuth: 0.6,
  pitchDamp: 2.8, rollDamp: 4.0, yawDamp: 1.8,
  gLimitPos: 9, gLimitNeg: -3, inertiaScale: 1.0,
};

export const AIRCRAFT_AERO: Record<AircraftModel, AeroParams> = {
  // F-16C Viper — relaxed stability, fly-by-wire, 25° AoA limiter
  f16: {
    ...DEFAULT_AERO,
    mass: 12000, wingArea: 27.87, maxThrust: 131000, cd0: 0.020, oswaldE: 0.82,
    aspectRatio: 3.2, clAlpha: 5.2, clMax: 1.6, alphaCritical: 0.42,
    postStallClFrac: 0.70,
    pitchAuth: 1.25, rollAuth: 1.15, yawAuth: 0.55,
    pitchDamp: 3.2, rollDamp: 4.5, yawDamp: 1.6,
    gLimitPos: 9, gLimitNeg: -3, inertiaScale: 0.85,
  },
  // F-16X testbed — same aerodynamics as the F-16 (per user request)
  'f16-test': {
    ...DEFAULT_AERO,
    mass: 12000, wingArea: 27.87, maxThrust: 131000, cd0: 0.020, oswaldE: 0.82,
    aspectRatio: 3.2, clAlpha: 5.2, clMax: 1.6, alphaCritical: 0.42,
    postStallClFrac: 0.70,
    pitchAuth: 1.25, rollAuth: 1.15, yawAuth: 0.55,
    pitchDamp: 3.2, rollDamp: 4.5, yawDamp: 1.6,
    gLimitPos: 9, gLimitNeg: -3, inertiaScale: 0.85,
  },
  // F-16C Block 50 真实模型 (per user request: 完全替换原 F-16) — 同一副机体
  f16c: {
    ...DEFAULT_AERO,
    mass: 12000, wingArea: 27.87, maxThrust: 131000, cd0: 0.020, oswaldE: 0.82,
    aspectRatio: 3.2, clAlpha: 5.2, clMax: 1.6, alphaCritical: 0.42,
    postStallClFrac: 0.70,
    pitchAuth: 1.25, rollAuth: 1.15, yawAuth: 0.55,
    pitchDamp: 3.2, rollDamp: 4.5, yawDamp: 1.6,
    gLimitPos: 9, gLimitNeg: -3, inertiaScale: 0.85,
  },
  // F-15 Eagle — twin-engine, large clipped delta, very fast, high energy retention
  f15: {
    ...DEFAULT_AERO,
    mass: 20000, wingArea: 56.5, maxThrust: 213000, cd0: 0.022, oswaldE: 0.80,
    aspectRatio: 2.96, clAlpha: 4.8, clMax: 1.2, alphaCritical: 0.32,
    postStallClFrac: 0.50,
    pitchAuth: 1.05, rollAuth: 0.95, yawAuth: 0.65,
    pitchDamp: 2.6, rollDamp: 3.6, yawDamp: 2.0,
    gLimitPos: 9, gLimitNeg: -3, inertiaScale: 1.05,
  },
  // Su-35 Flanker — big delta-canard, post-stall authority (Pugachev's Cobra)
  su35: {
    ...DEFAULT_AERO,
    mass: 25000, wingArea: 62.0, maxThrust: 290000, cd0: 0.024, oswaldE: 0.78,
    aspectRatio: 3.55, clAlpha: 5.5, clMax: 1.85, alphaCritical: 0.45,
    postStallClFrac: 0.75,
    pitchAuth: 1.20, rollAuth: 1.10, yawAuth: 0.60,
    pitchDamp: 3.0, rollDamp: 4.2, yawDamp: 1.9,
    gLimitPos: 10, gLimitNeg: -3, inertiaScale: 1.10,
  },
  // A-10 Warthog — straight wing, low speed authority, very stable, very slow
  a10: {
    ...DEFAULT_AERO,
    mass: 21000, wingArea: 57.6, maxThrust: 80000, cd0: 0.032, oswaldE: 0.83,
    aspectRatio: 6.5, clAlpha: 5.5, clMax: 1.4, alphaCritical: 0.30,
    postStallClFrac: 0.60,
    pitchAuth: 0.90, rollAuth: 1.30, yawAuth: 0.80,
    pitchDamp: 2.4, rollDamp: 3.2, yawDamp: 2.2,
    gLimitPos: 7, gLimitNeg: -3, inertiaScale: 1.20,
  },
  // B-52H Stratofortress — huge bomber, gentle, slow controls, very stable
  b52: {
    ...DEFAULT_AERO,
    mass: 120000, wingArea: 371.6, maxThrust: 380000, cd0: 0.018, oswaldE: 0.75,
    aspectRatio: 8.56, clAlpha: 5.0, clMax: 1.2, alphaCritical: 0.28,
    postStallClFrac: 0.45,
    pitchAuth: 0.55, rollAuth: 0.45, yawAuth: 0.85,
    pitchDamp: 1.8, rollDamp: 1.5, yawDamp: 1.4,
    gLimitPos: 3, gLimitNeg: -1.5, inertiaScale: 3.5,
  },
  // EA-18G Growler — derived from F/A-18, high alpha, balanced fighter
  ea18g: {
    ...DEFAULT_AERO,
    mass: 21000, wingArea: 46.45, maxThrust: 158000, cd0: 0.024, oswaldE: 0.81,
    aspectRatio: 3.5, clAlpha: 5.0, clMax: 1.4, alphaCritical: 0.40,
    postStallClFrac: 0.65,
    pitchAuth: 1.10, rollAuth: 1.05, yawAuth: 0.60,
    pitchDamp: 2.8, rollDamp: 4.0, yawDamp: 1.9,
    gLimitPos: 7.5, gLimitNeg: -2.5, inertiaScale: 1.05,
  },
  // AC-130 Spectre — C-130 derived, very stable, slow, predictable
  ac130: {
    ...DEFAULT_AERO,
    mass: 70000, wingArea: 162.1, maxThrust: 138000, cd0: 0.026, oswaldE: 0.78,
    aspectRatio: 6.7, clAlpha: 5.2, clMax: 1.3, alphaCritical: 0.30,
    postStallClFrac: 0.55,
    pitchAuth: 0.70, rollAuth: 0.65, yawAuth: 0.75,
    pitchDamp: 2.0, rollDamp: 2.0, yawDamp: 1.6,
    gLimitPos: 3.5, gLimitNeg: -1.5, inertiaScale: 2.2,
  },
  // F-117 Nighthawk — faceted stealth, unstable aerodynamically, fly-by-wire
  f117: {
    ...DEFAULT_AERO,
    mass: 24000, wingArea: 73.0, maxThrust: 97000, cd0: 0.042, oswaldE: 0.65,
    aspectRatio: 1.95, clAlpha: 3.8, clMax: 0.95, alphaCritical: 0.24,
    postStallClFrac: 0.40,
    pitchAuth: 1.15, rollAuth: 0.85, yawAuth: 0.90,
    pitchDamp: 3.0, rollDamp: 3.8, yawDamp: 2.4,
    gLimitPos: 6, gLimitNeg: -2, inertiaScale: 1.15,
  },
  // E-3 Sentry — Boeing 707 derivative, very heavy, gentle
  e3: {
    ...DEFAULT_AERO,
    mass: 150000, wingArea: 283.4, maxThrust: 380000, cd0: 0.020, oswaldE: 0.78,
    aspectRatio: 7.0, clAlpha: 5.0, clMax: 1.2, alphaCritical: 0.27,
    postStallClFrac: 0.45,
    pitchAuth: 0.60, rollAuth: 0.50, yawAuth: 0.80,
    pitchDamp: 1.8, rollDamp: 1.6, yawDamp: 1.4,
    gLimitPos: 3, gLimitNeg: -1, inertiaScale: 3.8,
  },
  // Tu-95 Bear — turboprop, huge prop torque, high yaw stability needed
  tu95: {
    ...DEFAULT_AERO,
    mass: 95000, wingArea: 295.0, maxThrust: 110000, cd0: 0.024, oswaldE: 0.82,
    aspectRatio: 8.84, clAlpha: 5.2, clMax: 1.3, alphaCritical: 0.28,
    postStallClFrac: 0.50,
    pitchAuth: 0.70, rollAuth: 0.55, yawAuth: 1.00,
    pitchDamp: 1.9, rollDamp: 1.8, yawDamp: 1.5,
    gLimitPos: 3, gLimitNeg: -1.2, inertiaScale: 3.0,
  },
  mig29: {
    ...DEFAULT_AERO,
    mass: 18000, wingArea: 38.0, maxThrust: 166000, cd0: 0.021, oswaldE: 0.82,
    aspectRatio: 3.4, clAlpha: 5.3, clMax: 1.55, alphaCritical: 0.40,
    postStallClFrac: 0.68,
    pitchAuth: 1.20, rollAuth: 1.10, yawAuth: 0.55,
    pitchDamp: 3.0, rollDamp: 4.3, yawDamp: 1.5,
    gLimitPos: 9, gLimitNeg: -3, inertiaScale: 1.0,
  },
};

// === ISA atmosphere =========================================================

export function airDensity(altitude: number): number {
  // Exponential approximation, good enough below 20 km
  return RHO_SL * Math.exp(-Math.max(0, altitude) / SCALE_HEIGHT);
}

// === Lift / drag / side coefficients =======================================

/** Cl vs angle of attack (radians). Linear up to α_crit, then breaks. */
export function liftCoeff(alpha: number, p: AeroParams): number {
  const a = alpha;
  const ac = p.alphaCritical;
  if (Math.abs(a) <= ac) {
    // Linear region — passes through 0 at α=0, slope clAlpha
    return p.clAlpha * a;
  }
  // Post-stall: drop sharply, then plateau
  const sign = a > 0 ? 1 : -1;
  const overshoot = Math.abs(a) - ac;
  const peak = p.clAlpha * ac; // = Cl_max-ish (may exceed clMax slightly with curve)
  const clPeak = Math.min(peak, p.clMax * sign);
  // Exponential decay to plateau over ~6° past critical
  const plateau = clPeak * p.postStallClFrac;
  const decay = Math.exp(-overshoot / 0.15);
  return sign * (plateau + (clPeak * sign - plateau) * decay);
}

/** Drag polar: Cd = Cd0 + k·Cl² */
export function dragCoeff(cl: number, p: AeroParams): number {
  const k = 1.0 / (Math.PI * p.aspectRatio * p.oswaldE);
  return p.cd0 + k * cl * cl;
}

/** Sideside force coefficient vs sideslip β (radians). Negative = weathervane. */
export function sideCoeff(beta: number, p: AeroParams): number {
  return p.cyBeta * beta;
}

// === Aircraft state ========================================================

export interface AircraftState {
  /** World-space position (m) */
  position: THREE.Vector3;
  /** World-space velocity (m/s) */
  velocity: THREE.Vector3;
  /** Orientation quaternion (body frame) */
  orientation: THREE.Quaternion;
  /** Body-frame angular velocity (rad/s) */
  angularVel: THREE.Vector3; // (pitch, roll, yaw) — careful with axes
  /** Throttle 0..1 */
  throttle: number;
  /** Airspeed (m/s) */
  airspeed: number;
  /** Angle of attack (radians) */
  aoa: number;
  /** Sideslip angle (radians) */
  beta: number;
  /** Current G-load (positive = toward pilot's feet / pull) */
  gLoad: number;
  /** Altitude AGL (m) */
  altitude: number;
  /** Whether the aircraft is currently stalled */
  stalled: boolean;
  /** Whether wings-level / spin-recovery is active */
  spinRecoveryActive: boolean;
  /** Engine thrust (N) currently produced */
  thrust: number;
  /** Damage factor 0..1 (0=healthy, 1=destroyed). For G-overload. */
  damage: number;

  // === Force breakdown (kN) — refreshed every stepFlight() call ===========
  // These are exposed so the HUD can show a force diagram. Magnitudes are
  // stored in kilonewtons for human-readable display.
  forces: {
    /** Lift magnitude (kN) — perpendicular to velocity, in body-up plane */
    lift: number;
    /** Drag magnitude (kN) — opposes velocity */
    drag: number;
    /** Thrust magnitude (kN) — along body forward */
    thrust: number;
    /** Weight magnitude (kN) — gravity force */
    weight: number;
    /** Side force magnitude (kN) — along body right */
    side: number;
    /** Net force magnitude (kN) — vector sum of all forces */
    net: number;
    /** Net force world-space vector (N, not kN) — for 3D arrow drawing */
    netVec: THREE.Vector3;
    /** Lift world-space direction (unit) — for 3D arrow drawing */
    liftDir: THREE.Vector3;
    /** Drag world-space direction (unit) */
    dragDir: THREE.Vector3;
    /** Thrust world-space direction (unit) */
    thrustDir: THREE.Vector3;
    /** Side force world-space direction (unit) */
    sideDir: THREE.Vector3;
    /** Weight world-space direction (unit) — always (0,-1,0) */
    weightDir: THREE.Vector3;
    /** Dynamic pressure q (Pa) — informational */
    q: number;
    /** Air density (kg/m³) */
    rho: number;
    /** Lift coefficient Cl */
    cl: number;
    /** Drag coefficient Cd */
    cd: number;
    /** Mach number */
    mach: number;
  };
}

export function createAircraftState(startPos: THREE.Vector3, startAlt: number): AircraftState {
  return {
    position: startPos.clone(),
    velocity: new THREE.Vector3(0, 0, 150), // start at 150 m/s forward
    orientation: new THREE.Quaternion(),
    angularVel: new THREE.Vector3(0, 0, 0),
    throttle: 0.8,
    airspeed: 150,
    aoa: 0,
    beta: 0,
    gLoad: 1,
    altitude: startAlt,
    stalled: false,
    spinRecoveryActive: false,
    thrust: 0,
    damage: 0,
    forces: {
      lift: 0, drag: 0, thrust: 0, weight: 0, side: 0, net: 0,
      netVec: new THREE.Vector3(),
      liftDir: new THREE.Vector3(0, 1, 0),
      dragDir: new THREE.Vector3(0, 0, -1),
      thrustDir: new THREE.Vector3(0, 0, 1),
      sideDir: new THREE.Vector3(1, 0, 0),
      weightDir: new THREE.Vector3(0, -1, 0),
      q: 0, rho: RHO_SL, cl: 0, cd: 0, mach: 0,
    },
  };
}

// === Control inputs =========================================================

export interface FlightControls {
  /** Pitch stick: -1 (full push / nose down) .. +1 (full pull / nose up) */
  pitch: number;
  /** Roll stick: -1 (full left) .. +1 (full right) */
  roll: number;
  /** Rudder pedals: -1 (full left) .. +1 (full right) */
  yaw: number;
  /** Throttle: 0..1 */
  throttle: number;
  /** Air brake: 0..1 */
  airbrake: number;
}

export const NEUTRAL_CONTROLS: FlightControls = {
  pitch: 0, roll: 0, yaw: 0, throttle: 0.8, airbrake: 0,
};

// === Physics step ===========================================================

const TMP_FORWARD = new THREE.Vector3();
const TMP_UP = new THREE.Vector3();
const TMP_RIGHT = new THREE.Vector3();
const TMP_VEL_LOCAL = new THREE.Vector3();
const TMP_FORCE = new THREE.Vector3();
const TMP_TORQUE = new THREE.Vector3();
const TMP_Q = new THREE.Quaternion();
const TMP_EULER = new THREE.Euler();

/**
 * Advance the aircraft state by dt seconds.
 * Returns the new state (mutates in place for performance).
 */
export function stepFlight(state: AircraftState, controls: FlightControls, p: AeroParams, dt: number): AircraftState {
  // Clamp dt — large steps destabilize the integrator
  dt = Math.min(dt, 0.02);
  if (dt <= 0) return state;

  // === Body-frame axes from orientation ===
  // Models in this codebase have nose at +Z (see models.ts buildProceduralGeometry).
  // So body forward = +Z, body up = +Y, body right = +X.
  TMP_FORWARD.set(0, 0, 1).applyQuaternion(state.orientation);
  TMP_UP.set(0, 1, 0).applyQuaternion(state.orientation);
  TMP_RIGHT.set(1, 0, 0).applyQuaternion(state.orientation);

  // === Velocity in body frame ===
  TMP_VEL_LOCAL.copy(state.velocity);
  // Express world velocity into body frame (inverse rotation)
  TMP_Q.copy(state.orientation).invert();
  TMP_VEL_LOCAL.applyQuaternion(TMP_Q);
  // TMP_VEL_LOCAL is now (right, up, forward) — extract components
  const u = TMP_VEL_LOCAL.z;  // forward (body +Z)
  const v = TMP_VEL_LOCAL.x;  // right (sideslip positive = nose right of velocity)
  const w = TMP_VEL_LOCAL.y;  // up

  const airspeed = Math.sqrt(u*u + v*v + w*w);
  state.airspeed = airspeed;
  state.altitude = state.position.y;

  // === AoA and sideslip ===
  // AoA = atan2(w, u); beta = atan2(v, u)
  const aoa = (airspeed > 1) ? Math.atan2(w, u) : 0;
  const beta = (airspeed > 1) ? Math.atan2(v, u) : 0;
  state.aoa = aoa;
  state.beta = beta;

  // === Air density (altitude-dependent) ===
  const rho = airDensity(state.altitude);
  const q = 0.5 * rho * airspeed * airspeed; // dynamic pressure

  // === Lift, drag, side force coefficients ===
  const cl = liftCoeff(aoa, p);
  const cd = dragCoeff(cl, p) + (controls.airbrake * 0.05); // airbrake adds flat drag
  const cy = sideCoeff(beta, p);

  // === Forces in body frame (aerodynamic) ===
  // Body axes: X=right, Y=up, Z=forward (nose direction)
  // Aerodynamic: lift along body-up, drag opposes motion (negative body-Z if no sideslip),
  //              side force along body-right
  const liftForce = q * p.wingArea * cl;
  const dragForce = q * p.wingArea * cd;
  const sideForce = q * p.wingArea * cy;

  // === Thrust ===
  // T = T_static · (ρ/ρ_sl)^0.7 · (1 - 0.1·M) — approx altitude + Mach lapse
  const mach = airspeed / 340;
  const thrust = p.maxThrust * Math.pow(rho / RHO_SL, 0.7) * (1 - 0.05 * Math.max(0, mach)) * controls.throttle;
  state.thrust = thrust;

  // === Net force in body frame (X=right, Y=up, Z=forward) ===
  // Body forward is +Z (matches model nose). Drag opposes velocity → -Z component.
  // Thrust pushes aircraft forward → +Z component.
  TMP_FORCE.set(
    sideForce,                // X right (sideslip)
    liftForce,                // Y up (lift)
    dragForce * -1 + thrust,  // Z forward = -drag + thrust
  );

  // Rotate body-frame force into world frame
  TMP_FORCE.applyQuaternion(state.orientation);

  // Add gravity (world -Y)
  const weightN = p.mass * G;
  TMP_FORCE.y -= weightN;

  // === Record force breakdown for HUD / 3D arrows ===========================
  // Directions are stored as world-space unit vectors; magnitudes in kN.
  const f = state.forces;
  f.lift = Math.abs(liftForce) / 1000;
  f.drag = Math.abs(dragForce) / 1000;
  f.thrust = thrust / 1000;
  f.weight = weightN / 1000;
  f.side = Math.abs(sideForce) / 1000;
  f.net = TMP_FORCE.length() / 1000;
  f.netVec.copy(TMP_FORCE);
  // Lift direction = body up (sign with liftForce so arrow points down for negative Cl)
  f.liftDir.set(0, 1, 0).applyQuaternion(state.orientation).multiplyScalar(Math.sign(liftForce) || 1);
  // Drag direction = opposite of velocity (or body -Z if no airflow)
  if (airspeed > 1) {
    f.dragDir.copy(state.velocity).multiplyScalar(-1).normalize();
  } else {
    f.dragDir.set(0, 0, -1).applyQuaternion(state.orientation);
  }
  f.thrustDir.set(0, 0, 1).applyQuaternion(state.orientation);
  f.sideDir.set(1, 0, 0).applyQuaternion(state.orientation).multiplyScalar(Math.sign(sideForce) || 1);
  f.weightDir.set(0, -1, 0);
  f.q = q;
  f.rho = rho;
  f.cl = cl;
  f.cd = cd;
  f.mach = mach;

  // === Acceleration → velocity ===
  const invMass = 1 / p.mass;
  state.velocity.x += TMP_FORCE.x * invMass * dt;
  state.velocity.y += TMP_FORCE.y * invMass * dt;
  state.velocity.z += TMP_FORCE.z * invMass * dt;

  // === G-load ===
  // G = (lift + thrust_vertical_component - weight) / weight, but conventionally
  // measured along body-up axis: gLoad = lift / weight + cos(angle_to_gravity)
  // Simpler: gLoad = |acceleration - gravity| / G  (perceived by pilot)
  // But WT uses: gLoad = (L + T·sin(α+installation)) / W ≈ Cl·q·S / (m·g)
  const weight = weightN;
  const gAlongBodyUp = liftForce / weight + (TMP_UP.y) * (1 - rho / RHO_SL * 0); // approx
  state.gLoad = gAlongBodyUp;

  // Structural overload — accumulate damage
  if (state.gLoad > p.gLimitPos + 1.5) {
    state.damage += (state.gLoad - p.gLimitPos - 1.5) * dt * 0.05;
  } else if (state.gLoad < p.gLimitNeg - 1.5) {
    state.damage += (p.gLimitNeg - 1.5 - state.gLoad) * dt * 0.05;
  }
  state.damage = Math.min(1, Math.max(0, state.damage));

  // === Stall detection ===
  const wasStalled = state.stalled;
  state.stalled = Math.abs(aoa) > p.alphaCritical * 1.05;

  // === Control surface torques ===
  // Authority scales with dynamic pressure (need airflow to bite)
  // Use a low-speed boost so planes are still controllable on approach
  const qEff = Math.max(q, 50); // floor for low-speed control
  const speedFactor = Math.min(1, qEff / 4000); // saturates around 90 m/s

  // Pitch torque: elevator input × authority × speed × inertia^-1
  // Plus static stability term — aircraft naturally weathervanes to reduce AoA
  const pitchStability = -2.5 * aoa; // restoring moment toward α=0
  const pitchInput = controls.pitch * p.pitchAuth * speedFactor * 80000;
  const pitchDampingMoment = -state.angularVel.x * p.pitchDamp * 40000;
  let pitchTorque = pitchInput + pitchStability * 30000 + pitchDampingMoment;

  // Roll torque: ailerons × authority
  const rollInput = controls.roll * p.rollAuth * speedFactor * 120000;
  const rollDamping = -state.angularVel.z * p.rollDamp * 80000;
  const rollTorque = rollInput + rollDamping;

  // Yaw torque: rudder + weathervane stability (sideslip → restoring yaw)
  const yawStability = -0.8 * beta;
  const yawInput = controls.yaw * p.yawAuth * speedFactor * 60000;
  const yawDamping = -state.angularVel.y * p.yawDamp * 50000;
  let yawTorque = yawInput + yawStability * 40000 + yawDamping;

  // Post-stall yaw moment (incipient spin) — asymmetry when stalled
  if (state.stalled) {
    const spinMoment = Math.sign(state.angularVel.y || (Math.random() - 0.5)) * 8000 * Math.abs(aoa - p.alphaCritical);
    yawTorque += spinMoment;
    // Reduce pitch authority dramatically in stall
    pitchTorque *= 0.3;
  }

  // Spin recovery: if user neutralizes controls AND airspeed is low, gently flatten
  state.spinRecoveryActive = state.stalled &&
    Math.abs(controls.pitch) < 0.1 && Math.abs(controls.roll) < 0.1 && Math.abs(controls.yaw) < 0.1;
  if (state.spinRecoveryActive) {
    // Apply opposite yaw damping + flatten roll
    yawTorque -= state.angularVel.y * 200000;
    const rollLeveling = -state.orientation.x * 50000; // crude: roll toward level
    // Apply small leveling
    TMP_TORQUE.set(rollLeveling, 0, 0);
  }

  // Apply inertia scaling
  const invInertia = 1 / p.inertiaScale;

  // Body-frame torque → angular acceleration
  // Careful: in our convention, pitch is rotation about X (right), roll about Z (back/forward), yaw about Y (up)
  // Body angular velocity (x=pitch, y=yaw, z=roll)
  state.angularVel.x += pitchTorque * invInertia * invMass * 0.5 * dt;
  state.angularVel.y += yawTorque * invInertia * invMass * 0.5 * dt;
  state.angularVel.z += rollTorque * invInertia * invMass * 0.5 * dt;

  // Clamp angular velocities (avoid infinity on damage / extreme inputs)
  const maxAngVel = 4;
  state.angularVel.x = Math.max(-maxAngVel, Math.min(maxAngVel, state.angularVel.x));
  state.angularVel.y = Math.max(-maxAngVel, Math.min(maxAngVel, state.angularVel.y));
  state.angularVel.z = Math.max(-maxAngVel, Math.min(maxAngVel, state.angularVel.z));

  // === Orientation update ===
  // Apply angular velocity as a quaternion delta
  // Body rates: (p, q, r) → (roll about X, pitch about Y, yaw about Z) in 3DS conventions
  // But our angularVel.x = pitch rate (about body X), .y = yaw rate (about body Y), .z = roll rate (about body Z)
  // Body angular velocity vector = (wx, wy, wz) in body frame
  TMP_TORQUE.set(state.angularVel.x, state.angularVel.y, state.angularVel.z);
  // Convert to quaternion delta: dq = 0.5 · q · (ω_vec, 0) · dt
  const dq = new THREE.Quaternion(
    TMP_TORQUE.x * 0.5 * dt,
    TMP_TORQUE.y * 0.5 * dt,
    TMP_TORQUE.z * 0.5 * dt,
    1.0,
  );
  // Renormalize dq (small-angle approximation)
  const dqLen = Math.sqrt(dq.x*dq.x + dq.y*dq.y + dq.z*dq.z + dq.w*dq.w);
  if (dqLen > 0) {
    dq.x /= dqLen; dq.y /= dqLen; dq.z /= dqLen; dq.w /= dqLen;
  }
  // Apply: q_new = q · dq
  state.orientation.multiply(dq);
  state.orientation.normalize();

  // === Position update ===
  state.position.x += state.velocity.x * dt;
  state.position.y += state.velocity.y * dt;
  state.position.z += state.velocity.z * dt;

  // === Ground collision (simple) ===
  if (state.position.y < 0) {
    // Bounce / crash depending on vertical velocity + orientation
    const vertVel = state.velocity.y;
    if (vertVel < -10) {
      // Crash
      state.damage = 1;
    } else {
      // Gentle touchdown — clamp to ground, kill vertical velocity
      state.position.y = 0;
      state.velocity.y = Math.max(0, state.velocity.y + 2); // small bounce
    }
  }

  return state;
}

// === Helpers for camera & HUD ==============================================

/** Returns the world-space forward direction (where nose points). */
export function getForwardVector(state: AircraftState, out: THREE.Vector3): THREE.Vector3 {
  return out.set(0, 0, 1).applyQuaternion(state.orientation);
}

/** Returns the world-space up direction (canopy direction). */
export function getUpVector(state: AircraftState, out: THREE.Vector3): THREE.Vector3 {
  return out.set(0, 1, 0).applyQuaternion(state.orientation);
}

/** Returns the world-space right direction (starboard). */
export function getRightVector(state: AircraftState, out: THREE.Vector3): THREE.Vector3 {
  return out.set(1, 0, 0).applyQuaternion(state.orientation);
}

/** Convert m/s to knots (for HUD display). */
export function mpsToKts(mps: number): number {
  return mps / KTS_TO_MPS;
}

/** Convert m/s to Mach (sea-level approximation; for HUD only). */
export function mpsToMach(mps: number): number {
  return mps / 340;
}

/** Convert m to feet. */
export function mToFeet(m: number): number {
  return m * 3.2808;
}
