// Next dev 路由:http://localhost:3000/fx-editor
// FX 特效编辑器独立应用;生产/单文件部署用 dist-editor/fx-editor.html(与 dist-single 平级)。
// 'use client' 必须有:Next16 禁止 Server Component 内 dynamic({ssr:false})。
'use client';
import dynamic from 'next/dynamic';

const FXEditorApp = dynamic(
  () => import('@/components/fx/FXEditorApp').then((m) => m.FXEditorApp),
  { ssr: false },
);

export default function FxEditorPage() {
  return <FXEditorApp />;
}
