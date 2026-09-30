// Standalone single-file build entry for the FX editor
// (scripts/build-single-html.mjs → dist-editor/fx-editor.html, 与 dist-single **平级**).
//
// 特效编辑器外壳:独立应用,为"新系统特效"提供粒子系统与调参环境;
// 导出契约 = FxAsset JSON(src/lib/fx/fx-core.ts),游戏侧后续接入。
import { createRoot } from 'react-dom/client';
import { FXEditorApp } from '@/components/fx/FXEditorApp';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element not found');

createRoot(rootEl).render(<FXEditorApp />);
