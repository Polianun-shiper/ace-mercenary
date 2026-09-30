'use client';

// Applies the global UI scale (root font-size) on mount + viewport resize.
// Mounted in the Next.js layout so even the shell text scales; GameApp also
// applies it for the standalone single-file build.
import { useUiScale } from '@/lib/game/ui-scale';

export function UiScaler() {
  useUiScale();
  return null;
}
