// Next dev 路由:http://localhost:3000/editor
// 编辑器独立于游戏本体;生产/单文件部署用 dist-editor/index.html
// (per user request: 编辑器产物放在 dist-single **外面**, 发布目录只留游戏)。
// 'use client' 必须有:Next16 禁止 Server Component 内 dynamic({ssr:false})。
'use client';
import dynamic from 'next/dynamic';

const EditorApp = dynamic(
  () => import('@/components/editor/EditorApp').then((m) => m.EditorApp),
  { ssr: false },
);

export default function EditorPage() {
  return <EditorApp />;
}
