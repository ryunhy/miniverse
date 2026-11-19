"use client";

import { useCallback, useEffect, useState } from "react";
import MeshViewer from "@/components/mesh/MeshViewer";
import StageTimeline from "@/components/miniature/StageTimeline";
import type { MiniatureView } from "@/lib/miniature/stages";

const ACTIVE = new Set(["pending", "processing"]);

const BANNER: Record<string, string> = {
  ok: "border-emerald-800 bg-emerald-950/40 text-emerald-200",
  warn: "border-amber-800 bg-amber-950/40 text-amber-200",
  error: "border-rose-800 bg-rose-950/40 text-rose-200",
};

async function call(path: string): Promise<string | null> {
  const res = await fetch(path, { method: "POST" });
  if (res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `请求失败（HTTP ${res.status}）`;
}

/**
 * 任务状态由客户端拉取（与其他页面同一模式）。
 * page.tsx 只解析 params 并渲染本组件，不在 server 端读任务库。
 */
export default function MiniatureLive({
  taskId,
  initial,
  fixture = false,
}: {
  taskId: string;
  initial?: MiniatureView;
  /** true = 拉 ?fixture=1 的 synthetic 契约示例，不轮询 */
  fixture?: boolean;
}) {
  const [view, setView] = useState<MiniatureView | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const qs = fixture ? "?fixture=1" : "";
    try {
      const res = await fetch(`/api/reconstructions/${encodeURIComponent(taskId)}/miniature${qs}`, {
        cache: "no-store",
      });
      // 404/409/422 的产物核对结果也带 view，必须更新详情和阶段状态。
      const body = (await res.json().catch(() => null)) as { view?: MiniatureView; error?: string } | null;
      if (body?.view) {
        setView(body.view);
        setLoadError(null);
      } else {
        setLoadError(body?.error ?? `读取任务状态失败（HTTP ${res.status}）`);
      }
    } catch {
      setLoadError("读取任务状态失败，请刷新后重试。");
    }
  }, [taskId, fixture]);

  useEffect(() => {
    // 一次性首拉。与本仓库既有客户端组件一致（见 EditableSceneViewerCore 的同名规则处理）。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (fixture || !view || !ACTIVE.has(view.status)) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [view, refresh, fixture]);

  const act = async (path: string) => {
    setBusy(true);
    setErr(null);
    const e = await call(path);
    if (e) setErr(e);
    await refresh();
    setBusy(false);
  };

  if (!view) {
    return <div className="rounded-lg border border-slate-800 px-3 py-6 text-xs text-slate-500">{loadError ?? "正在读取任务状态…"}</div>;
  }

  const id = encodeURIComponent(view.taskId);

  return (
    <div className="space-y-4">
      <div className={`rounded-lg border px-3 py-2 text-sm ${BANNER[view.banner.level]}`}>{view.banner.text}</div>

      {view.synthetic && (
        <div className="rounded-lg border border-fuchsia-800 bg-fuchsia-950/40 px-3 py-2 text-xs text-fuchsia-200">
          本产物含推断内容（synthetic）：未被照片直接观测到的表面由几何/纹理推断补全，数值见下方观测占比。
        </div>
      )}

      {loadError && <div role="alert" className="text-sm text-rose-200">{loadError}</div>}
      {err && <div className="rounded-lg border border-rose-800 bg-rose-950/40 px-3 py-2 text-sm text-rose-200">{err}</div>}

      <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <div>
          <StageTimeline stages={view.stages} />
          <p className="mt-2 text-[11px] text-slate-500">
            阶段来源：{view.stageSource === "worker_report" ? "worker 上报" : "任务状态（worker 未上报分阶段状态）"}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {ACTIVE.has(view.status) && (
              <button
                type="button"
                disabled={busy}
                onClick={() => act(`/api/reconstructions/${id}/cancel`)}
                className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
              >
                取消任务
              </button>
            )}
            {(view.status === "failed" || view.status === "canceled") && (
              <button
                type="button"
                disabled={busy}
                onClick={() => act(`/api/reconstructions/${id}/retry`)}
                className="rounded-md bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-900 hover:bg-white disabled:opacity-50"
              >
                重试
              </button>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm text-slate-300">预览</span>
            {view.glb && !fixture && (
              <a
                href={view.glb.downloadUrl}
                className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800"
                data-testid="download-glb"
              >
                下载 GLB{view.glb.bytes ? `（${view.glb.bytes} B）` : ""}
              </a>
            )}
          </div>
          {fixture ? (
            <div className="flex h-[180px] items-center justify-center rounded border border-dashed border-fuchsia-900 bg-fuchsia-950/20 px-4 text-center text-xs text-fuchsia-200/80">
              契约示例不含真实 GLB：这里只演示状态契约，不请求预览与下载，避免把示例当成生成产物。
            </div>
          ) : view.glb ? (
            <MeshViewer url={view.glb.url} height={380} taskId={view.taskId} />
          ) : (
            <div className="flex h-[180px] items-center justify-center rounded border border-dashed border-slate-800 text-xs text-slate-500">
              还没有可预览的 GLB
            </div>
          )}
          {view.provenance && (
            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-slate-400">
              <dt>照片来源</dt>
              <dd className="text-slate-300">{view.provenance.photos ?? "未标注"}</dd>
              <dt>纹理来源</dt>
              <dd className="text-slate-300">{view.provenance.texture ?? "未标注"}</dd>
              <dt>观测占比</dt>
              <dd className="text-slate-300">
                {view.provenance.observed_ratio != null ? view.provenance.observed_ratio.toFixed(4) : "未提供"}
              </dd>
              <dt>推断占比</dt>
              <dd className="text-slate-300">
                {view.provenance.inferred_ratio != null ? view.provenance.inferred_ratio.toFixed(4) : "未提供"}
              </dd>
            </dl>
          )}
        </div>
      </div>
    </div>
  );
}
