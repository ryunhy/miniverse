"use client";

import dynamic from "next/dynamic";

// R3F Canvas 不能在服务端渲染：水合后渲染循环才启动，与 SplatViewer/MeshViewer 同一挂载方式。
const EditableSceneViewer = dynamic(
  () => import("@/components/mesh/EditableSceneViewerCore"),
  {
    ssr: false,
    loading: () => (
      <div
        className="flex items-center justify-center rounded-2xl bg-slate-900 text-xs text-slate-500"
        style={{ height: 620 }}
      >
        正在加载可编辑场景…
      </div>
    ),
  },
);

export default function EditableSceneViewerLazy({
  id,
  height = 620,
}: {
  id: string;
  height?: number;
}) {
  return <EditableSceneViewer id={id} height={height} />;
}
