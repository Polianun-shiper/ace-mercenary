// Test harness entry — static page that mounts the REAL VirtualJoystick
// component against a live InputManager and shows its state in a readout.
//
// The readout is updated imperatively (direct textContent mutation, no React
// re-render) so the page stays "static" for the browser automation tool —
// Playwright-style clicks time out on per-frame re-rendering pages, so this
// static harness is how we exercise the joystick's real pointer handlers.
//
// Built by scripts/build-joystick-test.mjs → dist-test/joystick-test.html

import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { InputManager } from '@/lib/game/input';
import { VirtualJoystick } from '@/components/game/VirtualJoystick';

// Force the joystick ON regardless of device.
localStorage.setItem('skybound.virtualJoystick', 'on');

const im = new InputManager();

const EDGE_ACTIONS = ['fireMissile', 'flare', 'cycleCamera', 'cycleWeapon', 'nextTarget', 'togglePause', 'wingmanAttack', 'wingmanCover', 'wingmanForm', 'callReinforcement'];
const HELD_ACTIONS = ['fireGun', 'brake', 'throttleUp', 'throttleDown'];

function Harness() {
  const readoutRef = useRef<HTMLDivElement>(null);
  const pauseCount = useRef(0);

  useEffect(() => {
    const tick = () => {
      if (!readoutRef.current) return;
      const held = HELD_ACTIONS.filter((a) => im.isHeld(a));
      const pressed = EDGE_ACTIONS.filter((a) => im.isPressed(a));
      let layout: unknown = null;
      try {
        const raw = window.localStorage.getItem('skybound.vjLayout');
        layout = raw ? JSON.parse(raw) : null;
      } catch { /* ignore */ }
      readoutRef.current.textContent = JSON.stringify({
        pitch: +im.pitchAxis().toFixed(2),
        roll: +im.rollAxis().toFixed(2),
        yaw: +im.yawAxis().toFixed(2),
        held,
        pressed,
        pauseCount: pauseCount.current,
        layout,
      });
    };
    tick();
    const iv = setInterval(tick, 100);
    return () => clearInterval(iv);
  }, []);

  return (
    <div style={{ background: '#0a0f14', minHeight: '100vh', fontFamily: 'monospace', position: 'relative', overflow: 'hidden' }}>
      <div
        ref={readoutRef}
        id="readout"
        style={{ position: 'absolute', top: 8, left: 8, zIndex: 50, background: '#111', color: '#0f0', fontSize: 12, padding: 8, whiteSpace: 'pre-wrap', maxWidth: 420, pointerEvents: 'none' }}
      />
      <VirtualJoystick
        inputManager={im}
        onPause={() => {
          pauseCount.current += 1;
        }}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
