// Standalone single-file build entry for the terrain editor
// (scripts/build-single-html.mjs → dist-editor/index.html, 与 dist-single **平级**).
//
// The editor is a separate app from the game (UE 编辑器 ↔ UE 游戏 的关系):
// same public/ assets, same build pipeline, own React root. It reuses the
// game's environment builders 1:1 so tuned parameters transfer directly via
// terrain-tune.json.
import { createRoot } from 'react-dom/client';
import { EditorApp } from '@/components/editor/EditorApp';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element not found');

createRoot(rootEl).render(<EditorApp />);
