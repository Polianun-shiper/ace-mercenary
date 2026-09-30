'use client';

import dynamic from 'next/dynamic';

// Load the game client-side only — Three.js touches `window`/`document`.
const GameApp = dynamic(() => import('@/components/game/GameApp').then((m) => m.GameApp), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 flex items-center justify-center bg-black text-[color:var(--crt-amber)] font-mono">
      <div className="text-center">
        <div className="tracking-[0.4em] animate-pulse">◆ 正在初始化 ◆</div>
        <div className="mt-2 text-xs text-[color:var(--crt-amber-dim)]">天际计划 · PROJECT SKYBOUND</div>
      </div>
    </div>
  ),
});

export default function Home() {
  return <GameApp />;
}
