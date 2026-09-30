'use client';

// React hook for the i18n module. Subscribes to locale changes so any component
// using `useT()` re-renders automatically when the user toggles language.
//
// Usage:
//   const t = useT();
//   return <h1>{t('menu.campaign')}</h1>;
//
// On the very first render in the browser, we read the stored locale from
// localStorage. On the server (SSR), we default to 'en' to keep hydration
// deterministic — the client will pick up the right locale after mount.

import { useSyncExternalStore, useCallback } from 'react';
import { getLocale, subscribe, t as translate, type Locale } from '@/lib/game/i18n';

export function useT(): (key: string, params?: Record<string, string | number>) => string {
  // useSyncExternalStore gives us: stable snapshot + automatic re-render on
  // external changes (the `subscribe` callback notifies when locale changes).
  useSyncExternalStore(
    (cb) => subscribe(cb),
    () => getLocale(),
    () => 'en' as Locale, // server snapshot — always 'en' for SSR determinism
  );
  return useCallback(
    (key: string, params?: Record<string, string | number>) => translate(key, params),
    [],
  );
}

export function useLocale(): Locale {
  return useSyncExternalStore(
    (cb) => subscribe(cb),
    () => getLocale(),
    () => 'en' as Locale,
  );
}
