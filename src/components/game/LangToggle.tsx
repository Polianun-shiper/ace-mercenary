'use client';

// Compact language toggle button shown in the top-right corner of every screen.
// Clicking flips between EN and 中文. Reads + writes 'skybound.lang' in
// localStorage via the i18n module.

import { useLocale } from '@/hooks/use-i18n';
import { toggleLocale } from '@/lib/game/i18n';

export function LangToggle({ className = '' }: { className?: string }) {
  const locale = useLocale();
  const next = locale === 'en' ? '中文' : 'EN';
  return (
    <button
      onClick={() => toggleLocale()}
      className={`font-mono text-xs tracking-widest border border-[var(--crt-line)]/40 hover:border-[var(--crt-line-strong)] text-[var(--crt-amber-hi)]/80 hover:text-[var(--crt-amber-hi)] px-2 py-1 hover:bg-[var(--crt-amber)]/10 transition-colors ${className}`}
      title={locale === 'en' ? '切换到中文' : 'Switch to English'}
    >
      ⟷ {next}
    </button>
  );
}
