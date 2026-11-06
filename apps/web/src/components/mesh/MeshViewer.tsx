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
}

export default function MeshViewerLazy({ url, height = 520, orient = "identity" }: MeshViewerProps) {
  return <MeshViewer url={url} height={height} orient={orient} />;
}
