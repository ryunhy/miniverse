"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, CheckCircle2, XCircle, Clock, AlertTriangle, ArrowRight } from "lucide-react";
import { api, type TaskRow, type TaskEvent } from "@/lib/api";
import SplatViewer from "@/components/splat/SplatViewer";
import MeshViewer from "@/components/mesh/MeshViewer";
import EditableSceneViewer from "@/components/mesh/EditableSceneViewer";

function NavHeader({ id }: { id: string | null }) {
  return (
    <header
      className="relative flex items-center gap-3 px-5 py-0"
      style={{
        height: 52,
        background: "rgba(8,13,26,0.95)",
        borderBottom: "1px solid rgba(139,92,246,0.15)",
        backdropFilter: "blur(20px)",
        boxShadow: "0 1px 0 rgba(139,92,246,0.08)",
        zIndex: 50,
      }}
    >
      <Link href="/" className="flex items-center gap-2 shrink-0">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ filter: "drop-shadow(0 0 6px rgba(168,85,247,0.7))" }}>
          <path d="M3 7l9-4 9 4v10l-9 4-9-4V7z" stroke="url(#tdGrad)" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M12 3v18M3 7l9 4 9-4" stroke="url(#tdGrad)" strokeWidth="1.5" strokeLinejoin="round" />
          <defs>
            <linearGradient id="tdGrad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
              <stop stopColor="#a855f7" /><stop offset="0.5" stopColor="#ec4899" /><stop offset="1" stopColor="#f59e0b" />
            </linearGradient>
          </defs>
        </svg>
        <span
          className="text-sm font-bold"
          style={{
            background: "linear-gradient(135deg, #a855f7 0%, #ec4899 50%, #f59e0b 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
          }}
        >
          MiniVerse
        </span>
      </Link>
      <span className="text-slate-700">/</span>
      <Link href="/reconstructions" className="text-xs text-slate-500 hover:text-slate-300 transition">
        重建任务
      </Link>
      <span className="text-slate-700">/</span>
      <span className="text-xs text-slate-400 font-mono">{id?.slice(0, 8) ?? "…"}…</span>
      <Link href="/reconstructions" className="ml-auto btn-ghost">
        ← 任务列表
      </Link>
    </header>
  );
}

/** 任务详情：状态、事件、日志、完成后的高斯查看 */
export default function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [id, setId] = useState<string | null>(null);
  const [task, setTask] = useState<TaskRow | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [logTail, setLogTail] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  // 网格是可选增强产物：探测一次 /mesh 是否存在，决定是否展示网格查看器
  const [hasMesh, setHasMesh] = useState(false);
  // 场景清单（scene-manifest v1）优先：存在时可选中/变换/撤销并保存布局
  const [sceneAvailable, setSceneAvailable] = useState(false);
  const router = useRouter();

  useEffect(() => {
    params.then((p) => setId(p.id));
  }, [params]);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    const tick = async () => {
      try {
        const data = await api.getTask(id);
        if (!alive) return;
        setTask(data.task);
        setEvents(data.events);
        setLogTail(data.logTail);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "加载失败");
      }
    };
    tick();
    const iv = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [id]);

  // 任务完成后探测一次网格产物（404 = 未开启 exportMesh 或生成失败，静默回退到高斯）
  useEffect(() => {
    if (!id || task?.status !== "completed") return;
    let alive = true;
    fetch(`/api/reconstructions/${id}/mesh`, { method: "HEAD" })
      .then((r) => alive && setHasMesh(r.ok))
      .catch(() => alive && setHasMesh(false));
    return () => {
      alive = false;
    };
  }, [id, task?.status]);

  // 场景清单探测：不依赖任务记录（交付的独立场景也要能在真实客户端打开）
  useEffect(() => {
    if (!id) return;
    let alive = true;
    fetch(`/api/reconstructions/${id}/scene`, { method: "HEAD", cache: "no-store" })
      .then((r) => alive && setSceneAvailable(r.ok))
      .catch(() => alive && setSceneAvailable(false));
    return () => {
      alive = false;
    };
  }, [id]);

  if (error && !sceneAvailable) {
    return (
      <div className="flex h-screen flex-col" style={{ background: "#030712" }}>
        <NavHeader id={id} />
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <div
            className="flex flex-col items-center gap-3 rounded-2xl px-8 py-6"
            style={{
              background: "rgba(10,15,30,0.8)",
              border: "1px solid rgba(248,113,113,0.25)",
              boxShadow: "0 0 30px rgba(248,113,113,0.08)",
            }}
          >
            <XCircle size={24} style={{ color: "#f87171" }} />
            <p className="text-sm text-red-400">{error}</p>
            <Link href="/reconstructions" className="btn-ghost">返回任务列表</Link>
          </div>
        </div>
      </div>
    );
  }

  const statusColor: Record<string, string> = {
    pending: "#94a3b8",
    processing: "#818cf8",
    completed: "#34d399",
    failed: "#f87171",
    canceled: "#475569",
  };

  return (
    <div className="min-h-screen" style={{ background: "#030712", color: "#f1f5f9" }}>
      <div className="stars-bg pointer-events-none" />
      <NavHeader id={id} />

      <main className="mx-auto max-w-5xl px-4 py-8">
        {/* 状态卡片 */}
        {task && (
          <div
            className="mb-6 flex items-center gap-4 rounded-2xl px-5 py-4 mv-fade-in"
            style={{
              background: "rgba(10,15,30,0.7)",
              border: `1px solid ${statusColor[task.status]}33`,
              backdropFilter: "blur(16px)",
              boxShadow: `0 0 20px ${statusColor[task.status]}11`,
            }}
          >
            <div
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl"
              style={{
                background: `${statusColor[task.status]}15`,
                border: `1px solid ${statusColor[task.status]}33`,
              }}
            >
              {task.status === "processing" ? (
                <Loader2 size={22} style={{ color: statusColor[task.status], animation: "mv-spin 1s linear infinite" }} />
              ) : task.status === "completed" ? (
                <CheckCircle2 size={22} style={{ color: "#34d399", filter: "drop-shadow(0 0 6px rgba(52,211,153,0.6))" }} />
              ) : task.status === "failed" ? (
                <XCircle size={22} style={{ color: "#f87171", filter: "drop-shadow(0 0 6px rgba(248,113,113,0.6))" }} />
              ) : task.status === "pending" ? (
                <Clock size={22} style={{ color: "#94a3b8" }} />
              ) : (
                <AlertTriangle size={22} style={{ color: "#64748b" }} />
              )}
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-slate-100">
                  {task.status === "processing" ? "重建进行中"
                    : task.status === "completed" ? "重建完成"
                    : task.status === "failed" ? "重建失败"
                    : task.status === "pending" ? "排队等待"
                    : "已取消"}
                </span>
                <span
                  className="rounded-full px-2 py-0.5 text-[9px] font-mono font-semibold"
                  style={{
                    background: `${statusColor[task.status]}15`,
                    color: statusColor[task.status],
                    border: `1px solid ${statusColor[task.status]}33`,
                  }}
                >
                  {id?.slice(0, 8)}…
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-slate-500">
                {task.photo_count} 张照片 · 尝试 {task.attempts} 次
                {task.status === "processing" && " · COLMAP → Splatfacto 训练 → 导出，通常需要 10~40 分钟"}
              </p>
              {task.error && (
                <p className="mt-1 text-[11px] text-red-400">{task.error}</p>
              )}
              {/* 处理中进度条 */}
              {task.status === "processing" && (
                <div
                  className="mt-2 w-full rounded-full overflow-hidden"
                  style={{ height: 3, background: "rgba(99,102,241,0.1)" }}
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: "100%",
                      background: "linear-gradient(90deg, #6366f1, #a855f7, #ec4899, #a855f7, #6366f1)",
                      backgroundSize: "200% 100%",
                      animation: "mv-progress-shimmer 2s linear infinite",
                      boxShadow: "0 0 6px rgba(168,85,247,0.6)",
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {/* 可编辑场景（scene-manifest v1）：选中、移动/旋转/缩放、撤销、保存与刷新恢复 */}
        {sceneAvailable ? (
          <section
            className="overflow-hidden rounded-2xl mv-fade-in"
            style={{
              border: "1px solid rgba(34,211,238,0.25)",
              boxShadow: "0 0 30px rgba(34,211,238,0.08)",
            }}
            data-testid="scene-section"
          >
            <div className="px-2 pt-2">
              <EditableSceneViewer id={id!} height={620} />
            </div>
            <div
              className="flex items-center gap-3 px-4 py-3"
              style={{
                borderTop: "1px solid rgba(34,211,238,0.15)",
                background: "rgba(8,13,26,0.95)",
              }}
            >
              <span className="flex-1 text-[11px] text-slate-500">
                场景清单（scene-manifest v1）· 点击对象选中 · 拖动坐标轴变换 · Ctrl+Z 撤销 · 保存后刷新自动恢复
              </span>
              <a
                href={`/api/reconstructions/${id}/scene/glb?download=1`}
                download={`miniverse-${id}-room.glb`}
                className="text-[11px] text-cyan-400 hover:text-cyan-300"
              >
                下载 GLB
              </a>
            </div>
          </section>
        ) : task?.status === "completed" && hasMesh ? (
          <section
            className="overflow-hidden rounded-2xl mv-fade-in"
            style={{
              border: "1px solid rgba(56,189,248,0.2)",
              boxShadow: "0 0 30px rgba(56,189,248,0.08)",
            }}
          >
            <MeshViewer url={`/api/reconstructions/${id}/mesh`} height={520} orient="colmap-nerfstudio" />
            <div
              className="flex items-center gap-3 px-4 py-3"
              style={{
                borderTop: "1px solid rgba(56,189,248,0.15)",
                background: "rgba(8,13,26,0.95)",
              }}
            >
              <span className="flex-1 text-[11px] text-slate-500">
                纹理网格（2DGS + TSDF）· 拖动旋转 / 滚轮缩放 / 右键平移
              </span>
              <a
                href={`/api/reconstructions/${id}/mesh`}
                download={`miniverse-${id}.glb`}
                className="text-[11px] text-sky-400 hover:text-sky-300"
              >
                下载 GLB
              </a>
            </div>
          </section>
        ) : null}

        {/* 高斯查看器 */}
        {task?.status === "completed" ? (
          <section
            className="overflow-hidden rounded-2xl mv-fade-in"
            style={{
              border: "1px solid rgba(139,92,246,0.2)",
              boxShadow: "0 0 30px rgba(139,92,246,0.08)",
            }}
          >
            <SplatViewer
              url={`/api/reconstructions/${id}/result`}
              height={520}
              orient="colmap-nerfstudio"
              taskId={id ?? undefined}
            />
            <div
              className="flex items-center gap-3 px-4 py-3"
              style={{
                borderTop: "1px solid rgba(139,92,246,0.15)",
                background: "rgba(8,13,26,0.95)",
              }}
            >
              <span className="flex-1 text-[11px] text-slate-500">
                重建结果（Gaussian Splatting）· 拖动旋转 / 滚轮缩放 / 右键平移
              </span>
              <button
                onClick={async () => {
                  setImporting(true);
                  try {
                    const { scene } = await api.createSceneFromReconstruction(id!);
                    router.push(`/editor/${scene.sceneId}`);
                  } catch (e) {
                    setImportError(e instanceof Error ? e.message : "导入失败");
                    setImporting(false);
                  }
                }}
                disabled={importing}
                className="btn-gold flex items-center gap-1.5"
              >
                {importing ? <Loader2 size={13} className="animate-spin" /> : <ArrowRight size={13} />}
                {importing ? "导入中…" : "导入到编辑器"}
              </button>
            </div>
            {importError && (
              <div
                className="px-4 py-2 text-[11px] text-red-400"
                style={{
                  borderTop: "1px solid rgba(248,113,113,0.2)",
                  background: "rgba(127,29,29,0.2)",
                }}
              >
                {importError}
              </div>
            )}
          </section>
        ) : task && (task.status === "pending" || task.status === "processing" || task.status === "failed" || task.status === "canceled") && (
          <section
            className="flex flex-col items-center justify-center rounded-2xl py-16"
            style={{
              background: "rgba(10,15,30,0.5)",
              border: "1px solid rgba(139,92,246,0.1)",
            }}
          >
            {task.status === "failed" && (
              <div className="max-w-lg px-6 text-center">
                <XCircle size={32} className="mx-auto mb-3" style={{ color: "#f87171" }} />
                <p className="text-sm text-red-400 mb-2">
                  重建失败：{task.error ?? "详见日志"}
                </p>
                <p className="text-[11px] text-slate-600">
                  常见原因：未安装 COLMAP / Nerfstudio、CUDA 不可用、照片重叠不足。
                  <br />
                  安装指南见 docs/INSTALL-Windows-WSL2.md
                </p>
              </div>
            )}
            {task.status === "pending" && (
              <div className="text-center">
                <Clock size={32} className="mx-auto mb-3 text-slate-500" />
                <p className="text-sm text-slate-400">排队等待中…</p>
                <p className="mt-1 text-[11px] text-slate-600">Worker 未运行时可在任务列表点「重试」</p>
              </div>
            )}
          </section>
        )}

        {/* ── 底部二栏：事件 + 日志 ── */}
        <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* 任务事件 */}
          <div>
            <h2 className="mb-3 text-sm font-semibold text-slate-200">任务事件</h2>
            <div
              className="rounded-2xl overflow-hidden"
              style={{
                background: "rgba(10,15,30,0.6)",
                border: "1px solid rgba(139,92,246,0.12)",
                backdropFilter: "blur(12px)",
              }}
            >
              <ul className="max-h-72 overflow-y-auto p-3 text-[11px] flex flex-col gap-0.5">
                {events.length === 0 && (
                  <li className="py-2 text-center text-slate-600">暂无事件</li>
                )}
                {events.map((ev) => (
                  <li key={ev.id} className="flex gap-3 py-1 rounded-lg px-2 hover:bg-white/5">
                    <span className="shrink-0 text-slate-600 font-mono text-[10px] mt-0.5">
                      {new Date(ev.created_at).toLocaleTimeString("zh-CN", { hour12: false })}
                    </span>
                    <span
                      style={{
                        color:
                          ev.level === "error" ? "#f87171"
                          : ev.level === "warn" ? "#fbbf24"
                          : "#94a3b8",
                      }}
                    >
                      {ev.message}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* 日志 */}
          <div>
            <h2 className="mb-3 text-sm font-semibold text-slate-200">处理日志（尾部 200 行）</h2>
            <div
              className="rounded-2xl overflow-hidden"
              style={{
                background: "rgba(3,7,18,0.8)",
                border: "1px solid rgba(139,92,246,0.12)",
              }}
            >
              <pre
                className="max-h-72 overflow-auto p-3 text-[10px] leading-5 font-mono"
                style={{ color: "#64748b" }}
              >
                {logTail.length ? logTail.join("\n") : "暂无日志"}
              </pre>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
