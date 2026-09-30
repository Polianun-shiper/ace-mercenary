// Centralized input manager with edge-triggered actions + held state.
// Supports runtime remappable bindings and axis inversions (pitch/yaw/roll).
// Loads/saves settings to localStorage.

import { ControlBindings, DEFAULT_BINDINGS, InversionSettings, DEFAULT_INVERSION } from './types';

export interface InputState {
  // Held
  pitchUp: boolean;
  pitchDown: boolean;
  rollLeft: boolean;
  rollRight: boolean;
  yawLeft: boolean;
  yawRight: boolean;
  throttleUp: boolean;
  throttleDown: boolean;
  afterburner: boolean;
  brake: boolean;
  fireGun: boolean;
  // === Emergency brake (per user request: Z 按住紧急减速板) ===
  // Held — deploys the emergency speedbrake (drag ×3, same as airbrake).
  emergencyBrake: boolean;
  // Edge
  fireMissile: boolean;
  flare: boolean;
  cycleCamera: boolean;
  cycleWeapon: boolean;
  togglePause: boolean;
  nextTarget: boolean;
  prevTarget: boolean;
  lookBack: boolean;
  wingmanAttack: boolean;
  wingmanCover: boolean;
  wingmanForm: boolean;
  callReinforcement: boolean;
  cycleRadarRange: boolean;
  // Held — free-look camera mode (hold to decouple camera from aircraft).
  freeLook: boolean;
  // Edge — AC-130 side-firing view toggle (CapsLock). Only effective on
  // gunship-category aircraft; engine ignores it otherwise.
  toggleSideView: boolean;
  /** 起落架收放 (per user request: G 键放下起落架) */
  gear: boolean;
  // Consumed by engine after read
  consumeEdges(): void;
}

const STORAGE_KEY = 'acesky-controls-v2';

export class InputManager {
  private held = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();
  private wheelDelta = 0;

  // === Virtual (touch) input — fed by the on-screen VirtualJoystick ===
  // The engine reads the same axes/held/pressed state, so a virtual joystick
  // simply injects values here. Analog axes are clamped to [-1, 1] and mixed
  // with the keyboard's discrete -1/0/+1 before inversion is applied.
  private virtualAxes: Record<'pitch' | 'roll' | 'yaw', number> = { pitch: 0, roll: 0, yaw: 0 };
  private virtualHeld = new Set<string>();

  // Bindings: action -> KeyboardEvent.code
  private bindings: ControlBindings;
  private inversions: InversionSettings;
  // Reverse lookup: code -> action (rebuilt when bindings change)
  private codeToAction: Map<string, string>;

  private canvas: HTMLElement | null = null;
  private enabled = false;

  constructor() {
    this.bindings = { ...DEFAULT_BINDINGS };
    this.inversions = { ...DEFAULT_INVERSION };
    this.codeToAction = this.buildReverseMap();
    this.loadFromStorage();
    // === 鼠标按键监听在**构造时**就注册 (per 实测: attach() 进关卡后才调, 约 1.3s) =====
    // 鼠标操控模式的左键/右键若等到 attach() 才生效, 开局那一段时间按键就是死的。
    // addEventListener 对**同一个函数引用**是幂等的 ⇒ 这里挂一次、attach() 再挂一次
    // 也不会重复触发。处理器内部按 mouseAimMode 自我门禁, 键盘模式/菜单里不受影响。
    if (typeof window !== 'undefined') {
      window.addEventListener('mousedown', this.onMouseDown);
      window.addEventListener('mouseup', this.onMouseUp);
      window.addEventListener('contextmenu', this.onContextMenu);
    }
  }

  private buildReverseMap(): Map<string, string> {
    const m = new Map<string, string>();
    (Object.keys(this.bindings) as (keyof ControlBindings)[]).forEach((action) => {
      const code = this.bindings[action];
      if (code) m.set(code, action);
    });
    return m;
  }

  private loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj.bindings) {
          const merged = { ...DEFAULT_BINDINGS, ...obj.bindings };
          // === 键位冲突修复 (per user request: Z 紧急减速板被旧存档占用) ===
          // When DEFAULT_BINDINGS adds/changes a key (e.g. cycleCamera Z→M,
          // KeyZ becoming emergencyBrake), an OLD save may still bind that
          // key to a different action (cycleCamera:'KeyZ'). Resolve by
          // letting the OLD action fall back to its DEFAULT binding — the
          // new default always wins the key. Only touches conflicting
          // actions; all other user rebinds are preserved.
          for (const action of Object.keys(DEFAULT_BINDINGS) as (keyof ControlBindings)[]) {
            const defCode = DEFAULT_BINDINGS[action];
            if (!defCode) continue;
            for (const other of Object.keys(merged) as (keyof ControlBindings)[]) {
              if (other === action) continue;
              if (merged[other] === defCode) {
                merged[other] = DEFAULT_BINDINGS[other] ?? '';
              }
            }
          }
          this.bindings = merged;
        }
        if (obj.inversions) this.inversions = { ...DEFAULT_INVERSION, ...obj.inversions };
        this.codeToAction = this.buildReverseMap();
      }
    } catch { /* ignore */ }
  }

  private saveToStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ bindings: this.bindings, inversions: this.inversions }));
    } catch { /* ignore */ }
  }

  getBindings(): ControlBindings { return { ...this.bindings }; }
  getInversions(): InversionSettings { return { ...this.inversions }; }

  setBinding(action: keyof ControlBindings, code: string) {
    // Don't allow duplicate codes — clear the previous action that used this code.
    (Object.keys(this.bindings) as (keyof ControlBindings)[]).forEach((a) => {
      if (this.bindings[a] === code) this.bindings[a] = '';
    });
    this.bindings[action] = code;
    this.codeToAction = this.buildReverseMap();
    this.saveToStorage();
  }

  setInversion(axis: keyof InversionSettings, value: boolean) {
    this.inversions[axis] = value;
    this.saveToStorage();
  }

  resetToDefaults() {
    this.bindings = { ...DEFAULT_BINDINGS };
    this.inversions = { ...DEFAULT_INVERSION };
    this.codeToAction = this.buildReverseMap();
    this.saveToStorage();
  }

  attach(canvas: HTMLElement) {
    this.canvas = canvas;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onBefore, true);
    // === Free-look mouse tracking (per user request) ===
    // While the freeLook key is held, we listen to pointermove so the
    // engine can read the mouse delta and yaw/pitch the chase camera
    // independently of the aircraft. We track absolute pointer position
    // (relative to the window centre) so the camera direction is set
    // directly by where the mouse is on screen — feels natural.
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerlockchange', this.onPointerLockChange);
    // === 鼠标操控模式: 左键机炮 / 右键切目标 (per user request) ===
    // 监听在 window 上(瞄准时鼠标被 pointer-lock 捕获, 事件目标是 document/body)。
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('contextmenu', this.onContextMenu);
    this.enabled = true;
  }

  detach() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onBefore, true);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerlockchange', this.onPointerLockChange);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('contextmenu', this.onContextMenu);
    this.enabled = false;
  }

  private onBefore = (e: KeyboardEvent) => {
    if (!this.enabled) return;
    // Z (emergency brake) and I (radar range) joined the game-key list;
    // KeyM is now the camera cycle. CapsLock = AoA-limiter override hold.
    // Prevent default browser actions for all (incl. CapsLock case toggle).
    if (['Space', 'Tab', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyM', 'KeyZ', 'KeyI', 'CapsLock'].includes(e.code)) {
      e.preventDefault();
    }
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    this.wheelDelta += e.deltaY;
  };

  // === Free-look mouse position (per user request) ===
  // Tracks the absolute mouse position (in pixels, relative to viewport
  // top-left). The engine reads this when the freeLook key is held to
  // compute the camera yaw/pitch offset.
  private pointerX = 0;
  private pointerY = 0;
  private hasPointer = false;
  // Raw movement deltas since the last consume — work under POINTER LOCK where
  // clientX/Y freeze at the capture point (per user request: 隐藏鼠标强制居中).
  private pointerDX = 0;
  private pointerDY = 0;

  private onPointerMove = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.pointerX = e.clientX;
    this.pointerY = e.clientY;
    this.hasPointer = true;
    this.pointerDX += e.movementX || 0;
    this.pointerDY += e.movementY || 0;
  };

  private onPointerLockChange = () => {
    // Reset pointer state when pointer-lock toggles so we don't get a stale
    // mouse position stuck on the previous screen location.
    this.hasPointer = !!document.pointerLockElement;
  };

  // === 鼠标操控模式: 左键机炮 / 右键切换目标 (per user request) ==============
  // 只在鼠标操控模式生效(键盘/手柄模式左键要留给 UI)。引擎在控制模式切换时调
  // setMouseAimMode(true/false)。左键是**按住持续开火**(与键盘的 fireGun 同类语义),
  // 右键是**边沿触发**一次目标切换(与 Tab 同类语义)。
  private mouseAimMode = false;
  setMouseAimMode(on: boolean) {
    this.mouseAimMode = !!on;
    if (!on) this.setVirtualHeld('fireGun', false);   // 退出模式时别把机炮卡在'按住'
  }
  isMouseAimMode(): boolean { return this.mouseAimMode; }

  private onMouseDown = (e: MouseEvent) => {
    if (!this.enabled || !this.mouseAimMode) return;
    if (e.button === 0) { this.setVirtualHeld('fireGun', true); e.preventDefault(); }
    else if (e.button === 2) { this.pressVirtual('nextTarget'); e.preventDefault(); }
  };
  private onMouseUp = (e: MouseEvent) => {
    if (!this.mouseAimMode) return;
    if (e.button === 0) { this.setVirtualHeld('fireGun', false); e.preventDefault(); }
  };
  /** 右键菜单会打断"右键切目标" —— 鼠标操控模式下屏蔽。 */
  private onContextMenu = (e: MouseEvent) => {
    if (!this.enabled || !this.mouseAimMode) return;
    e.preventDefault();
  };

  // Returns the current pointer position. The engine maps this to a
  // camera yaw/pitch offset in free-look mode.
  getPointer(): { x: number; y: number; has: boolean } {
    return { x: this.pointerX, y: this.pointerY, has: this.hasPointer };
  }

  /** Raw pointer deltas since the last read (unlimited even under pointer
   *  lock — the mouse can keep moving past the screen edge). */
  consumePointerDelta(): { x: number; y: number } {
    const d = { x: this.pointerDX, y: this.pointerDY };
    this.pointerDX = 0;
    this.pointerDY = 0;
    return d;
  }

  /** Hide + centre-capture the mouse on the game canvas (pointer lock). */
  requestPointerLock() {
    try {
      const el = this.canvas as (HTMLElement & { requestPointerLock?: () => void | Promise<void> });
      if (typeof document !== 'undefined' && !document.pointerLockElement && el && typeof el.requestPointerLock === 'function') {
        // 新标准里 requestPointerLock() 返回 Promise, 没有"用户手势"时会 reject
        // (实测: 程序化恢复指针锁 → 控制台多一条未处理拒绝)。这里吞掉它, 锁不住
        // 就交给 window 上的 pointerdown 重试兜底(见 engine 的 _maLockRetry)。
        const p = el.requestPointerLock();
        if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => { /* 等下一次点击 */ });
      }
    } catch { /* ignore */ }
  }

  /** Restore the normal cursor (exit pointer lock). */
  exitPointerLock() {
    try {
      if (typeof document !== 'undefined' && document.pointerLockElement) {
        document.exitPointerLock();
      }
    } catch { /* ignore */ }
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.enabled) return;
    if (e.repeat) return;
    const action = this.codeToAction.get(e.code);
    if (!action) return;
    if (!this.held.has(action)) this.pressed.add(action);
    this.held.add(action);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (!this.enabled) return;
    const action = this.codeToAction.get(e.code);
    if (!action) return;
    this.held.delete(action);
    this.released.add(action);
  };

  isHeld(action: string): boolean {
    return this.held.has(action) || this.virtualHeld.has(action);
  }

  isPressed(action: string): boolean {
    return this.pressed.has(action);
  }

  // === Virtual (touch) input API ===========================================
  // Used by the on-screen VirtualJoystick component. Values live on this
  // manager so the engine's per-frame polling picks them up automatically.

  /** Set an analog axis value in [-1, +1] (clamped). */
  setVirtualAxis(axis: 'pitch' | 'roll' | 'yaw', v: number) {
    this.virtualAxes[axis] = Math.max(-1, Math.min(1, v));
  }

  /** Returns the current virtual (touch / gamepad) axis value in [-1, +1]. */
  getVirtualAxis(axis: 'pitch' | 'roll' | 'yaw'): number {
    return this.virtualAxes[axis];
  }

  /** True when any virtual axis is deflected beyond `dead` (0..1) — i.e. the
   *  on-screen joystick or gamepad stick is actually pushed. Used to let the
   *  joystick take priority over the mouse-aim autopilot (杆量 input). */
  virtualDeflected(dead = 0.15): boolean {
    return Math.abs(this.virtualAxes.pitch) > dead
      || Math.abs(this.virtualAxes.roll) > dead
      || Math.abs(this.virtualAxes.yaw) > dead;
  }

  /** Set a held action (fireGun / brake / throttleUp / …) on/off. */
  setVirtualHeld(action: string, on: boolean) {
    if (on) this.virtualHeld.add(action);
    else this.virtualHeld.delete(action);
  }

  /** Edge-trigger an action (fireMissile / flare / cycleCamera / …).
   *  Written into `pressed` so the engine consumes it this frame and
   *  clearFrame() resets it, exactly like a key press. */
  pressVirtual(action: string) {
    this.pressed.add(action);
  }

  /** Release everything — call when the joystick unmounts / hides. */
  clearVirtual() {
    this.virtualAxes.pitch = 0;
    this.virtualAxes.roll = 0;
    this.virtualAxes.yaw = 0;
    this.virtualHeld.clear();
  }

  // Read pitch input value in range [-1, +1], applying inversion.
  // +1 = pitch up (nose up), -1 = pitch down (nose down).
  pitchAxis(): number {
    let v = (this.held.has('pitchUp') ? 1 : 0) - (this.held.has('pitchDown') ? 1 : 0) + this.virtualAxes.pitch;
    v = Math.max(-1, Math.min(1, v));
    if (this.inversions.pitch) v = -v;
    return v;
  }

  rollAxis(): number {
    let v = (this.held.has('rollRight') ? 1 : 0) - (this.held.has('rollLeft') ? 1 : 0) + this.virtualAxes.roll;
    v = Math.max(-1, Math.min(1, v));
    if (this.inversions.roll) v = -v;
    return v;
  }

  yawAxis(): number {
    let v = (this.held.has('yawRight') ? 1 : 0) - (this.held.has('yawLeft') ? 1 : 0) + this.virtualAxes.yaw;
    v = Math.max(-1, Math.min(1, v));
    if (this.inversions.yaw) v = -v;
    return v;
  }

  consumeWheel(): number {
    const w = -this.wheelDelta;
    this.wheelDelta = 0;
    return w;
  }

  clearFrame() {
    this.pressed.clear();
    this.released.clear();
    this.wheelDelta = 0;
  }

  /** True while the player manually holds any MANEUVER key (pitch/roll/yaw —
   *  WASD/QE). In mouse-aim mode a manual keyboard maneuver takes TOP
   *  priority over the autopilot trim (per user request: 键盘输入最高优先级).
   *  Only the six attitude axes count — throttle/weapons are not maneuvers. */
  manualManeuverHeld(): boolean {
    return this.held.has('pitchUp') || this.held.has('pitchDown')
      || this.held.has('rollLeft') || this.held.has('rollRight')
      || this.held.has('yawLeft') || this.held.has('yawRight');
  }

  /** === 逐轴版 (per user request: 多轴杆量叠加) ===
   *  只问"这一轴"有没有被手按着 —— 鼠标操控模式用它决定**逐轴**让权:
   *  按着右滚时只有滚转轴交给手动杆量, 俯仰/偏航继续由自动驾驶接管,
   *  于是多轴输入可以叠加(旧的全有全无判定等于单轴)。 */
  axisHeld(axis: 'pitch' | 'roll' | 'yaw'): boolean {
    switch (axis) {
      case 'pitch': return this.held.has('pitchUp') || this.held.has('pitchDown');
      case 'roll': return this.held.has('rollLeft') || this.held.has('rollRight');
      case 'yaw': return this.held.has('yawLeft') || this.held.has('yawRight');
    }
  }

  disable() { this.enabled = false; }
  enable() { this.enabled = true; }
}
