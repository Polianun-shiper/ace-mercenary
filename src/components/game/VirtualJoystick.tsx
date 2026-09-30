'use client';

// On-screen virtual joystick + touch buttons for mobile play.
//
// Rendered during the 'playing' phase when the VIRTUAL JOYSTICK setting is
// enabled (auto-ON for touch devices; toggleable in Settings / MainMenu).
// Feeds the shared InputManager through its virtual-input API, so the engine
// polls exactly the same state as keyboard input — no engine changes needed.
//
// Layout:
//   Left stick : pitch (up/down) + roll (left/right)
//   Right stick: yaw (left/right) + throttle (up = throttleUp, down = throttleDown)
//   Buttons    : FIRE (hold = gun) · BRAKE (hold) · MSL · FLR · CAM · WPN ·
//                wingman (ATK/COV/FRM/SUP) · ⏸ (pause)
//
// Every control is a "dock unit" whose on-screen position is user-editable:
// tap ✎ (next to ⏸) to enter layout-edit mode, drag units to reposition,
// then SAVE (persists to skybound.vjLayout) / CANCEL / DEFAULT.

import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { InputManager } from '@/lib/game/input';
import { useT } from '@/hooks/use-i18n';
import { useUiScale } from '@/lib/game/ui-scale';
import { resolveAutoOnSetting } from '@/lib/game/device-mode';

interface VirtualJoystickProps {
  inputManager: InputManager;
  onPause: () => void;
}

// Setting key shared with Settings.tsx / Menus.tsx.
export const VJ_KEY = 'skybound.virtualJoystick';
// Persisted touch layout: unitId → center position (% of viewport).
export const VJ_LAYOUT_KEY = 'skybound.vjLayout';
// (VJ_SIZE_KEY + size helpers defined below with the layout code.)

/** Whether the virtual joystick should show.
 *  §336 起**桌面默认关**(用户要求); 手持设备在"从没设置过"时仍自动开 ——
 *  触屏没有键鼠, 关掉等于没法玩(与 mobileMode 同一个 auto-on 口径,
 *  见 device-mode.ts 的 resolveAutoOnSetting)。设置里手动切过就一直听玩家的。 */
export function isVirtualJoystickEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return resolveAutoOnSetting(VJ_KEY);
}

// === Layout =================================================================

export interface UnitPos { x: number; y: number }
export type VJLayout = Record<string, UnitPos>;

// Default positions (center-anchored, % of viewport). Matches the original
// hardcoded layout on a 390×844 phone.
export const DEFAULT_LAYOUT: VJLayout = {
  leftStick: { x: 20, y: 90 },
  rightStick: { x: 79, y: 74 },
  actions: { x: 62, y: 63 },
  fire: { x: 84, y: 92 },
  brake: { x: 60, y: 93 },
  wingman: { x: 20, y: 59 },
  tgt: { x: 50, y: 80 },
  // === New-function buttons (per user request: 触屏兼容新按键) ===
  func: { x: 39, y: 69 },   // 减速板/注视/导弹视角/僚机视角
  radar: { x: 39, y: 50 },  // 雷达过滤/雷达缩放
  pause: { x: 90, y: 18 },
};

// === Per-unit button size (per user request: 分别改虚拟按键大小) ===
// Each dock unit has an independent scale factor (0.75× / 1× / 1.25× / 1.5×)
// persisted to skybound.vjSize. Applied as a CSS scale on the unit's content
// so buttons AND sticks grow/shrink together.
export const VJ_SIZE_KEY = 'skybound.vjSize';
export type VJSizeMap = Record<string, number>;
export const SIZE_STEPS = [0.75, 1, 1.25, 1.5];

export function loadSizes(storage?: { getItem(k: string): string | null }): VJSizeMap {
  const out: VJSizeMap = {};
  try {
    const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
    const raw = store?.getItem(VJ_SIZE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as VJSizeMap;
      for (const id of Object.keys(DEFAULT_LAYOUT)) {
        const v = saved[id];
        if (typeof v === 'number' && v >= 0.5 && v <= 2) out[id] = v;
      }
    }
  } catch { /* ignore */ }
  return out;
}
export function saveSizes(sizes: VJSizeMap, storage?: { setItem(k: string, v: string): void }): void {
  try {
    const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
    store?.setItem(VJ_SIZE_KEY, JSON.stringify(sizes));
  } catch { /* ignore */ }
}
export function nextSize(cur?: number): number {
  const i = SIZE_STEPS.indexOf(cur ?? 1);
  return SIZE_STEPS[(i + 1) % SIZE_STEPS.length];
}

export function clampPos(p: UnitPos, min = 5, max = 95): UnitPos {
  return { x: Math.max(min, Math.min(max, p.x)), y: Math.max(min, Math.min(max, p.y)) };
}

const defaultCopy = (): VJLayout =>
  Object.fromEntries(Object.entries(DEFAULT_LAYOUT).map(([k, v]) => [k, { ...v }]));

/** Load the saved layout merged over defaults (unknown keys ignored, missing
 *  units fall back to defaults so future additions still get a position).
 *  Accepts an optional storage for unit testing. */
export function loadLayout(storage?: { getItem(k: string): string | null }): VJLayout {
  const out = defaultCopy();
  try {
    const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
    const raw = store?.getItem(VJ_LAYOUT_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as VJLayout;
      for (const [id, d] of Object.entries(DEFAULT_LAYOUT)) {
        const s = saved[id];
        if (s && typeof s.x === 'number' && typeof s.y === 'number') {
          out[id] = clampPos({ x: s.x, y: s.y });
        }
      }
    }
  } catch { /* ignore */ }
  return out;
}

export function saveLayout(layout: VJLayout, storage?: { setItem(k: string, v: string): void }): void {
  try {
    const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
    store?.setItem(VJ_LAYOUT_KEY, JSON.stringify(layout));
  } catch { /* ignore */ }
}

// === Stick math =============================================================

const TRAVEL = 42; // px — knob travel radius for full deflection (× uiScale)
const DEAD = 0.08; // deadzone near stick center (re-mapped, not snapped)

// Ramp input through the deadzone smoothly: 0 at |v| <= DEAD, 1 at |v| = 1.
const ramp = (v: number) =>
  Math.abs(v) < DEAD ? 0 : Math.sign(v) * ((Math.abs(v) - DEAD) / (1 - DEAD));

// Pure stick math: pointer position relative to the stick origin → normalized
// -1..1 vector (clamped to the travel circle, deadzone re-mapped). Exported
// for unit testing.
export function computeStickVector(
  originX: number,
  originY: number,
  pointerX: number,
  pointerY: number,
  travel: number = TRAVEL,
  dead: number = DEAD,
): { x: number; y: number } {
  const dx = pointerX - originX;
  const dy = pointerY - originY;
  const len = Math.hypot(dx, dy) || 1;
  const scale = len > travel ? travel / len : 1;
  const x = Math.max(-1, Math.min(1, ramp((dx * scale) / travel)));
  const y = Math.max(-1, Math.min(1, ramp((dy * scale) / travel)));
  return { x, y };
}

function Stick({ label, onChange }: { label: string; onChange: (x: number, y: number) => void }) {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const activePointer = useRef<number | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  // Scale the knob travel with the global UI scale (stick base is rem-sized,
  // so the travel radius must match proportionally).
  const uiScale = useUiScale();
  const travel = TRAVEL * uiScale;

  const apply = (clientX: number, clientY: number) => {
    const v = computeStickVector(origin.current.x, origin.current.y, clientX, clientY);
    setPos(v);
    onChange(v.x, v.y);
  };

  const release = () => {
    activePointer.current = null;
    setPos({ x: 0, y: 0 });
    onChange(0, 0);
  };

  return (
    <div
      className="relative w-28 h-28 rounded-full border border-[var(--crt-line)]/40 bg-black/30 backdrop-blur-sm touch-none pointer-events-auto select-none"
      onPointerDown={(e) => {
        activePointer.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        origin.current = { x: e.clientX, y: e.clientY };
        apply(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (activePointer.current !== e.pointerId) return;
        apply(e.clientX, e.clientY);
      }}
      onPointerUp={(e) => {
        if (activePointer.current === e.pointerId) release();
      }}
      onPointerCancel={(e) => {
        if (activePointer.current === e.pointerId) release();
      }}
    >
      {/* Knob */}
      <div
        className="absolute left-1/2 top-1/2 w-12 h-12 rounded-full border border-[var(--crt-line-strong)]/60 bg-[var(--crt-amber)]/25"
        style={{ transform: `translate(calc(-50% + ${pos.x * travel}px), calc(-50% + ${pos.y * travel}px))` }}
      />
      <div className="absolute inset-0 flex items-center justify-center text-[0.5625rem] tracking-[0.25em] text-[var(--crt-amber-hi)]/50 pointer-events-none">
        {label}
      </div>
    </div>
  );
}

function VButton({
  label,
  onDown,
  onUp,
  size = 'md',
  accent,
}: {
  label: string;
  onDown: () => void;
  onUp?: () => void;
  size?: 'sm' | 'md' | 'lg';
  accent?: string;
}) {
  // True when the current press was already handled by pointerdown — a real
  // pointer press fires pointerdown, then click; we must not double-fire.
  // The click path exists for keyboards (Enter/Space) and synthetic click
  // dispatchers that never send pointer events.
  const handledByPointer = useRef(false);
  const sizeCls = size === 'sm' ? 'w-12 h-12 text-[0.5rem]' : size === 'lg' ? 'w-20 h-20 text-sm' : 'w-14 h-14 text-[0.625rem]';
  return (
    <button
      type="button"
      className={`pointer-events-auto touch-none select-none rounded-md border font-mono tracking-widest backdrop-blur-sm ${sizeCls} ${accent ?? 'border-[var(--crt-line)]/40 bg-black/30 text-[var(--crt-amber-hi)] active:bg-[var(--crt-amber)]/30'}`}
      onPointerDown={(e) => {
        handledByPointer.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        onDown();
      }}
      onPointerUp={() => onUp?.()}
      onPointerCancel={() => onUp?.()}
      onClick={() => {
        if (handledByPointer.current) {
          handledByPointer.current = false;
          return;
        }
        // Click-only input (keyboard Enter, synthetic clicks): fire a
        // momentary press. Held buttons release shortly after.
        onDown();
        if (onUp) setTimeout(onUp, 120);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </button>
  );
}

// === Dock unit (user-positionable control) =================================

interface DockUnitProps {
  id: string;
  pos: UnitPos;
  editing: boolean;
  onPosChange: (p: UnitPos) => void;
  // === Per-unit size (per user request: 分别改虚拟按键大小) ===
  size: number;
  onSizeChange: () => void;
  label: string;
  children: ReactNode;
}

// A control anchored by its center at `pos` (% of viewport). In edit mode an
// overlay captures all pointer events for dragging (children get no input),
// and the unit is drawn with a dashed border + name label.
function DockUnit({ id, pos, editing, onPosChange, size, onSizeChange, label, children }: DockUnitProps) {
  const elRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = elRef.current;
    if (!el) return;
    drag.current = {
      pointerId: e.pointerId,
      offsetX: e.clientX - (el.offsetLeft + el.offsetWidth / 2),
      offsetY: e.clientY - (el.offsetTop + el.offsetHeight / 2),
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = elRef.current;
    if (!d || d.pointerId !== e.pointerId || !el) return;
    // Clamp in pixels so the unit never clips off-screen.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cx = Math.max(el.offsetWidth / 2, Math.min(vw - el.offsetWidth / 2, e.clientX - d.offsetX));
    const cy = Math.max(el.offsetHeight / 2, Math.min(vh - el.offsetHeight / 2, e.clientY - d.offsetY));
    onPosChange({ x: (cx / vw) * 100, y: (cy / vh) * 100 });
  };
  const onUp = () => {
    drag.current = null;
  };

  return (
    <div
      ref={elRef}
      data-unit={id}
      className={`absolute touch-none select-none pointer-events-auto transition-[opacity] ${editing ? 'z-40 opacity-80' : 'z-auto'}`}
      style={{ left: `${pos.x}%`, top: `${pos.y}%`, transform: 'translate(-50%, -50%)' }}
    >
      {/* Per-unit size scale — scales buttons + sticks together. */}
      <div style={{ transform: `scale(${size})` }}>{children}</div>
      {editing && (
        <>
          <div className="absolute -inset-1 z-10 rounded-xl border border-dashed border-[var(--crt-line-strong)]/80 pointer-events-auto" />
          <div className="absolute -top-5 left-1/2 -translate-x-1/2 z-10 text-[0.5625rem] tracking-[0.2em] text-[var(--crt-amber-hi)] whitespace-nowrap pointer-events-none">
            {label}
          </div>
          {/* === Per-unit size cycle button (per user request) === */}
          <button
            type="button"
            className="absolute -top-9 left-1/2 -translate-x-1/2 z-20 px-1.5 py-0.5 text-[0.5625rem] border border-amber-400/70 text-amber-200 bg-black/60 pointer-events-auto rounded"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onSizeChange}
          >
            {size}×
          </button>
          <div
            className="absolute -inset-1 z-20 touch-none"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          />
        </>
      )}
    </div>
  );
}

// === Main component =========================================================

export function VirtualJoystick({ inputManager, onPause }: VirtualJoystickProps) {
  const t = useT();
  const [enabled] = useState(isVirtualJoystickEnabled);
  const [editing, setEditing] = useState(false);
  const [layout, setLayout] = useState<VJLayout>(loadLayout);
  // === Per-unit button sizes (per user request: 分别改虚拟按键大小) ===
  const [sizes, setSizes] = useState<VJSizeMap>(loadSizes);
  // Keep a ref so handlers never capture a stale instance across missions.
  const imRef = useRef(inputManager);
  imRef.current = inputManager;

  // Release all virtual input when the joystick unmounts (leaving the
  // playing phase / mission dispose) so nothing stays "stuck".
  useEffect(() => {
    return () => imRef.current.clearVirtual();
  }, []);

  if (!enabled) return null;

  const im = () => imRef.current;
  const pos = (id: string) => layout[id] ?? DEFAULT_LAYOUT[id];
  const sizeOf = (id: string) => sizes[id] ?? 1;
  const setUnitPos = (id: string) => (p: UnitPos) => setLayout((prev) => ({ ...prev, [id]: p }));

  const beginEdit = () => {
    im().clearVirtual();
    setEditing(true);
  };
  const cancelEdit = () => {
    setLayout(loadLayout());
    setSizes(loadSizes());
    setEditing(false);
  };
  const saveEdit = () => {
    saveLayout(layout);
    saveSizes(sizes);
    setEditing(false);
  };
  const resetLayout = () => {
    setLayout(defaultCopy());
    setSizes({});
  };
  const cycleSize = (id: string) => () => {
    setSizes((prev) => ({ ...prev, [id]: nextSize(prev[id]) }));
  };

  return (
    <div className="absolute inset-0 z-30 pointer-events-none select-none font-mono">
      {/* === Layout-edit bar === */}
      {editing && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-1 pointer-events-auto">
          <div className="flex gap-2">
            <button
              onClick={cancelEdit}
              className="px-3 py-1.5 text-xs border border-red-400/60 text-red-200 bg-black/50 tracking-widest"
            >
              ✕ {t('vj.cancel')}
            </button>
            <button
              onClick={saveEdit}
              className="px-3 py-1.5 text-xs border border-[var(--crt-amber)]/70 text-[var(--crt-amber)] bg-black/50 tracking-widest"
            >
              ✓ {t('vj.save')}
            </button>
            <button
              onClick={resetLayout}
              className="px-3 py-1.5 text-xs border border-[var(--crt-line)]/50 text-[var(--crt-amber-hi)] bg-black/50 tracking-widest"
            >
              {t('vj.reset')}
            </button>
          </div>
          <div className="text-[0.5625rem] text-[var(--crt-amber)]/70 tracking-widest bg-black/40 px-2 py-0.5">{t('vj.editHint')}</div>
        </div>
      )}

      {/* === Layout-edit toggle (next to ⏸) === */}
      <div className="absolute top-3 right-20 z-40 pointer-events-auto" style={{ marginTop: '7rem' }}>
        <VButton
          label={editing ? '✕' : '✎'}
          size="sm"
          accent={editing
            ? 'border-amber-400/80 bg-amber-400/20 text-amber-200'
            : 'border-[var(--crt-line)]/50 bg-black/40 text-[var(--crt-amber-hi)] active:bg-[var(--crt-amber)]/20'}
          onDown={() => (editing ? cancelEdit() : beginEdit())}
        />
      </div>

      {/* === Left stick — flight: pitch (Y) + roll (X) === */}
      <DockUnit id="leftStick" pos={pos('leftStick')} editing={editing} onPosChange={setUnitPos('leftStick')} size={sizeOf('leftStick')} onSizeChange={cycleSize('leftStick')} label="飞行">
        <Stick
          label="飞行"
          onChange={(x, y) => {
            im().setVirtualAxis('roll', x);
            im().setVirtualAxis('pitch', -y);
          }}
        />
      </DockUnit>

      {/* === Right stick — yaw (X) + throttle (Y, held while deflected) === */}
      <DockUnit id="rightStick" pos={pos('rightStick')} editing={editing} onPosChange={setUnitPos('rightStick')} size={sizeOf('rightStick')} onSizeChange={cycleSize('rightStick')} label="油门">
        <Stick
          label="油门"
          onChange={(x, y) => {
            im().setVirtualAxis('yaw', x);
            im().setVirtualHeld('throttleUp', y > 0.25);
            im().setVirtualHeld('throttleDown', y < -0.25);
          }}
        />
      </DockUnit>

      {/* === Weapon / action buttons: MSL · FLR · CAM · WPN === */}
      <DockUnit id="actions" pos={pos('actions')} editing={editing} onPosChange={setUnitPos('actions')} size={sizeOf('actions')} onSizeChange={cycleSize('actions')} label="武器">
        <div className="flex gap-2">
          <VButton label="MSL" onDown={() => im().pressVirtual('fireMissile')} />
          <VButton label="干扰" onDown={() => im().pressVirtual('flare')} />
          <VButton label="视角" onDown={() => im().pressVirtual('cycleCamera')} />
          <VButton label="切武" onDown={() => im().pressVirtual('cycleWeapon')} />
        </div>
      </DockUnit>

      {/* === Wingman commands: ATK · COV · FRM · SUP === */}
      <DockUnit id="wingman" pos={pos('wingman')} editing={editing} onPosChange={setUnitPos('wingman')} size={sizeOf('wingman')} onSizeChange={cycleSize('wingman')} label="僚机">
        <div className="grid grid-cols-2 gap-1.5">
          <VButton label="攻击" size="sm" onDown={() => im().pressVirtual('wingmanAttack')} />
          <VButton label="掩护" size="sm" onDown={() => im().pressVirtual('wingmanCover')} />
          <VButton label="编队" size="sm" onDown={() => im().pressVirtual('wingmanForm')} />
          <VButton label="支援" size="sm" onDown={() => im().pressVirtual('callReinforcement')} />
        </div>
      </DockUnit>

      {/* === New-function buttons (per user request: 触屏兼容新按键) ===
          Adds the recently-added key functions to touch: 减速板 (airbrake,
          held), 注视 (lookTarget, held), 导弹视角 (missileView), 僚机视角
          (wingmanView). */}
      <DockUnit id="func" pos={pos('func')} editing={editing} onPosChange={setUnitPos('func')} size={sizeOf('func')} onSizeChange={cycleSize('func')} label="功能">
        <div className="grid grid-cols-2 gap-1.5">
          {/* === Airbrake is an edge-triggered TOGGLE (KeyH) — pressVirtual
              fires one toggle per tap, exactly like the keyboard key. === */}
          <VButton label="减速板" size="sm" accent="border-amber-400/50 bg-black/40 text-amber-100 active:bg-amber-400/20"
            onDown={() => im().pressVirtual('airbrake')} />
          <VButton label="注视" size="sm" accent="border-[#ff8a4a]/50 bg-black/40 text-[#ffcc88] active:bg-[#ff8a4a]/20"
            onDown={() => im().setVirtualHeld('lookTarget', true)} onUp={() => im().setVirtualHeld('lookTarget', false)} />
          <VButton label="弹视" size="sm" accent="border-[var(--crt-line)]/50 bg-black/40 text-[var(--crt-amber-hi)] active:bg-[var(--crt-amber)]/20"
            onDown={() => im().pressVirtual('missileView')} />
          <VButton label="僚视" size="sm" accent="border-[var(--crt-line)]/50 bg-black/40 text-[var(--crt-amber-hi)] active:bg-[var(--crt-amber)]/20"
            onDown={() => im().pressVirtual('wingmanView')} />
        </div>
      </DockUnit>

      {/* === Radar controls (per user request: 触屏兼容新按键) ===
          雷达过滤 (radarFilter) + 雷达缩放 (cycleRadarRange). */}
      <DockUnit id="radar" pos={pos('radar')} editing={editing} onPosChange={setUnitPos('radar')} size={sizeOf('radar')} onSizeChange={cycleSize('radar')} label="雷达">
        <div className="flex gap-1.5">
          <VButton label="过滤" size="sm" accent="border-[var(--crt-amber-bright)]/50 bg-black/40 text-[#c8a8ff] active:bg-[var(--crt-amber-bright)]/20"
            onDown={() => im().pressVirtual('toggleRadarFilter')} />
          <VButton label="缩放" size="sm" accent="border-[var(--crt-amber-bright)]/50 bg-black/40 text-[#c8a8ff] active:bg-[var(--crt-amber-bright)]/20"
            onDown={() => im().pressVirtual('cycleRadarRange')} />
        </div>
      </DockUnit>

      {/* === Target cycle button (per user request: 触屏加切换目标按钮) === */}
      <DockUnit id="tgt" pos={pos('tgt')} editing={editing} onPosChange={setUnitPos('tgt')} size={sizeOf('tgt')} onSizeChange={cycleSize('tgt')} label="目标">
        <VButton
          label="目标"
          accent="border-[#ff8a4a]/60 bg-black/40 text-[#ffcc88] active:bg-[#ff8a4a]/20"
          onDown={() => im().pressVirtual('nextTarget')}
        />
      </DockUnit>

      {/* === FIRE + BRAKE (hold buttons) === */}
      <DockUnit id="fire" pos={pos('fire')} editing={editing} onPosChange={setUnitPos('fire')} size={sizeOf('fire')} onSizeChange={cycleSize('fire')} label="开火">
        <VButton
          label="开火"
          size="lg"
          accent="border-[var(--crt-amber)]/60 bg-black/40 text-[var(--crt-amber)] active:bg-[var(--crt-amber)]/20"
          onDown={() => im().setVirtualHeld('fireGun', true)}
          onUp={() => im().setVirtualHeld('fireGun', false)}
        />
      </DockUnit>
      <DockUnit id="brake" pos={pos('brake')} editing={editing} onPosChange={setUnitPos('brake')} size={sizeOf('brake')} onSizeChange={cycleSize('brake')} label="刹车">
        <VButton
          label="刹车"
          accent="border-[var(--crt-line)]/40 bg-black/30 text-[var(--crt-amber-hi)] active:bg-[var(--crt-amber)]/30"
          onDown={() => im().setVirtualHeld('brake', true)}
          onUp={() => im().setVirtualHeld('brake', false)}
        />
      </DockUnit>

      {/* === Pause — below the language toggle, above the HUD === */}
      <DockUnit id="pause" pos={pos('pause')} editing={editing} onPosChange={setUnitPos('pause')} size={sizeOf('pause')} onSizeChange={cycleSize('pause')} label="暂停">
        <VButton
          label="⏸"
          accent="border-amber-400/60 bg-black/40 text-amber-200 active:bg-amber-400/20"
          onDown={onPause}
        />
      </DockUnit>
    </div>
  );
}
