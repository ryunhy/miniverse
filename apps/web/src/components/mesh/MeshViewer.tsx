"use client";

import dynamic from "next/dynamic";

// 与 SplatViewer 同一挂载方式：R3F Canvas 必须跳过 SSR，否则水合后渲染循环不启动。
const MeshViewer = dynamic(() => import("@/components/mesh/MeshViewerCore"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center bg-slate-900 text-xs text-slate-500" style={{ height: 520 }}>
      正在加载网格查看器…
    </div>
  ),
});

interface MeshViewerProps {
  url: string;
  height?: number;
  orient?: "identity" | "colmap-nerfstudio";
  /** 关联重建任务 ID：提供时优先用训练相机机位，与高斯查看器对齐 */
  taskId?: string | null;
  /** 与高斯查看器同步视角（默认开） */
  syncEnabled?: boolean;
}

export default function MeshViewerLazy({ url, height = 520, orient = "identity", taskId, syncEnabled = true }: MeshViewerProps) {
  return <MeshViewer url={url} height={height} orient={orient} taskId={taskId} syncEnabled={syncEnabled} />;
}
