// Standalone single-file build entry for the UI preview harness
// (scripts/build-single-html.mjs → dist-test/ui-preview.html, --dev only).
//
// 为什么单独做入口: 结算/加载这类屏无法靠点击流稳定复现(要打完一局),
// 需要一个能直接以假数据渲染它们的页面来做视觉回归(headless 截图)。
// 与编辑器入口同理: 自己的 React 根、复用同一套 public 资源与构建管线。
// 该入口只随 `--dev` 构建产出, 不进入 dist-single 发布包。
import { createRoot } from 'react-dom/client';
import { UiPreview } from '@/app/ui-preview/page';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element not found');

createRoot(rootEl).render(<UiPreview />);
