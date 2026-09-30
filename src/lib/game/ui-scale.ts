// === Global UI auto-scaling (per user request: 所有UI按分辨率自动缩放) ===
// Everything in the game UI is sized with Tailwind rem units — scaling the
// root font-size rescales fonts, spacing, buttons and panels everywhere.
// Spots that hardcode px (canvas drawing, a few inline styles) multiply by
// the same scale via useUiScale().
//
// Formula: auto = min(viewport/1600, viewport/900), clamped 0.45-1.2, then
// multiplied by the manual UI-scale setting (0.7-1.5, default 1).
//   - phone landscape 844×390  → ≈0.45  (HUD shrinks to fit)
//   - desktop 1920×1080        → 1.2
//   - 1440p+                   → 1.2 (capped)

import { useEffect, useRef, useState } from 'react';

export const UI_REF_W = 1600;
export const UI_REF_H = 900;
export const UI_SCALE_KEY = 'skybound.uiScale';
export const UI_SCALE_EVENT = 'skybound:uiScale';

export function readManualUiScale(): number {
  if (typeof window === 'undefined') return 1;
  const v = parseFloat(window.localStorage.getItem(UI_SCALE_KEY) ?? '');
  if (Number.isNaN(v)) return 1;
  return Math.max(0.7, Math.min(1.5, v));
}

export function computeUiScale(): number {
  if (typeof window === 'undefined') return 1;
  const auto = Math.min(window.innerWidth / UI_REF_W, window.innerHeight / UI_REF_H);
  const clamped = Math.max(0.45, Math.min(1.2, auto));
  return clamped * readManualUiScale();
}

export function applyUiScale(): number {
  const s = computeUiScale();
  if (typeof document !== 'undefined') {
    document.documentElement.style.fontSize = `${16 * s}px`;
  }
  return s;
}

// Notify every useUiScale() consumer + re-apply the root font-size.
// Called by the Settings slider so scaling applies live while dragging.
export function notifyUiScale() {
  applyUiScale();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(UI_SCALE_EVENT));
  }
}

// React hook — returns the current scale and keeps it in sync with
// viewport resizes and manual setting changes. Used by canvas/px-based
// components (Hud, VirtualJoystick) that can't scale via rem.
export function useUiScale(): number {
  const [scale, setScale] = useState(1);
  const ref = useRef(1);
  useEffect(() => {
    const upd = () => {
      const s = applyUiScale();
      ref.current = s;
      setScale(s);
    };
    upd();
    window.addEventListener('resize', upd);
    window.addEventListener(UI_SCALE_EVENT, upd);
    // === Polling safety net ===
    // Some embedded/remote browsers resize the viewport without delivering a
    // 'resize' event to the page (IAB free-size mode). A cheap 300ms poll
    // catches those cases; it's a no-op when nothing changed.
    const timer = window.setInterval(() => {
      const s = computeUiScale();
      if (Math.abs(s - ref.current) > 1e-4) upd();
    }, 300);
    return () => {
      window.removeEventListener('resize', upd);
      window.removeEventListener(UI_SCALE_EVENT, upd);
      window.clearInterval(timer);
    };
  }, []);
  return scale;
}
