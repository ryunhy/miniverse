"use client";

import dynamic from "next/dynamic";

// R3F Canvas 必须跳过 SSR：SSR 预渲染的 Canvas 在水合后渲染循环不启动（canvas 停留 300×150），
// 与编辑器页保持同一挂载方式（已实证正常）。
const SplatViewer = dynamic(() => import("@/components/splat/SplatViewerCore"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center bg-slate-900 text-xs text-slate-500" style={{ height: 520 }}>
      正在加载高斯查看器…
    </div>
  ),
});

interface SplatViewerProps {
  url: string;
  height?: number;
  /** 数据朝向：colmap-nerfstudio = 真实重建 PLY（nerfstudio 归一化系，Z-up），需 Rx(-90°) 立起 */
  orient?: "identity" | "colmap-nerfstudio";
  /** 关联重建任务 ID：提供时按训练相机取景 */
  taskId?: string | null;
  /** 与网格查看器同步视角（默认开） */
  syncEnabled?: boolean;
}

export default function SplatViewerLazy({ url, height = 520, orient = "identity", taskId, syncEnabled = true }: SplatViewerProps) {
  return <SplatViewer url={url} height={height} orient={orient} taskId={taskId} syncEnabled={syncEnabled} />;
}
