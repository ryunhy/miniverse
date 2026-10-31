"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import dynamic from "next/dynamic";

const EditorShell = dynamic(() => import("@/components/editor/EditorShell"), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen items-center justify-center bg-slate-950 text-xs text-slate-500">
      正在加载 3D 编辑器…
    </div>
  ),
});

function EditorWithParams() {
  const params = useParams<{ id: string }>();
  if (!params?.id) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950 text-xs text-slate-500">
        参数缺失
      </div>
    );
  }
  return <EditorShell sceneId={params.id} />;
}

export default function EditorPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center bg-slate-950 text-xs text-slate-500">
          正在加载…
        </div>
      }
    >
      <EditorWithParams />
    </Suspense>
  );
}
