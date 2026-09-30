'use client';

// ============================================================================
// 联机实时 debug 日志面板 (per user request: 联机界面加实时运行的 debug 日志)
// ============================================================================
// 上传后的页面按不了 F12, 所以把联机这条"看不见的链路"直接摊在界面上:
// SDK 初始化 / slug / 登录态 / 建房 / peer 发现 / 快照收发 / 命中路由 / 抗作弊拒绝 /
// 停战 … 全部实时滚动, 并带一行实时状态读数。
//
// 风格沿用琥珀 CRT 终端(与大厅一致); 面板可折叠, 默认展开在联机界面底部。

import { useEffect, useMemo, useRef, useState } from 'react';
import { getLog, subscribeLog, clearLog, installLogCapture, type LogLine } from '@/lib/game/net/debug-log';
import { resolveProjectSlug } from '@/lib/game/net/vibe';
import { getLocale } from '@/lib/game/i18n';

const LEVEL_COLOR: Record<LogLine['level'], string> = {
  info: 'var(--crt-amber-dim)',
  ok: 'var(--crt-green)',
  warn: 'var(--crt-amber)',
  error: 'var(--crt-red-light, #ff6a5c)',
  net: 'var(--crt-ally, #5ad2ff)',
};

function stamp(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function NetDebugPanel({ defaultOpen = true, maxHeight = 168 }: { defaultOpen?: boolean; maxHeight?: number }) {
  const zh = getLocale() === 'zh';
  const [open, setOpen] = useState(defaultOpen);
  const [lines, setLines] = useState<LogLine[]>(() => getLog());
  const boxRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const slug = useMemo(() => resolveProjectSlug(), []);

  useEffect(() => {
    installLogCapture();
    setLines(getLog());
    return subscribeLog((l) => setLines((prev) => (prev.length > 400 ? [...prev.slice(-300), l] : [...prev, l])));
  }, []);

  // 自动滚到底(用户手动往上翻时不打断)
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !open || !stickRef.current) return;
    box.scrollTop = box.scrollHeight;
  }, [lines, open]);

  return (
    <div className="crt-panel crt-corner flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--crt-amber-ghost)] bg-[var(--crt-panel-2)] px-2 py-1">
        <span className="flex items-center gap-2 font-mono text-[0.625rem] tracking-widest text-[var(--crt-amber)]">
          <span className="tp-led animate-tp-rec h-1.5 w-1.5" style={{ color: 'var(--crt-green)' }} />
          {zh ? '联机调试日志(实时)' : 'NET DEBUG LOG (LIVE)'}
          <span className="text-[var(--crt-amber-dim)]">
            {zh ? `· slug=${slug.slug}(${slug.source})` : `· slug=${slug.slug} (${slug.source})`}
          </span>
        </span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            className="border border-[var(--crt-amber-ghost)] px-1.5 py-[1px] font-mono text-[0.5625rem] tracking-widest text-[var(--crt-amber-dim)] hover:text-[var(--crt-amber-hi)]"
            onClick={() => clearLog()}
          >
            {zh ? '清空' : 'CLEAR'}
          </button>
          <button
            type="button"
            className="border border-[var(--crt-amber-ghost)] px-1.5 py-[1px] font-mono text-[0.5625rem] tracking-widest text-[var(--crt-amber-dim)] hover:text-[var(--crt-amber-hi)]"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? (zh ? '收起' : 'HIDE') : (zh ? '展开' : 'SHOW')}
          </button>
        </span>
      </div>
      {open && (
        <div
          ref={boxRef}
          className="min-h-0 flex-1 overflow-y-auto px-2 py-1 font-mono text-[0.5625rem] leading-[1.5]"
          style={{ maxHeight }}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {lines.length === 0 && (
            <div className="text-[var(--crt-amber-dim)]">{zh ? '(暂无日志 — 点击登录/建房后开始记录)' : '(no log yet)'}</div>
          )}
          {lines.map((l) => (
            <div key={l.id} className="truncate" style={{ color: LEVEL_COLOR[l.level] }} title={l.text}>
              <span className="text-[var(--crt-amber-deep)]">{stamp(l.at)}</span> {l.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
