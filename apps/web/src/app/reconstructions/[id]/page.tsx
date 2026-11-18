"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, CheckCircle2, XCircle, Clock, AlertTriangle, ArrowRight, RefreshCw } from "lucide-react";
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

/** /api/reconstructions/:id/mesh/status 的响应体 */
type MeshStatusBody = {
  state: "ready" | "running" | "failed" | "missing" | "absent";
  error: string | null;
  /** 仅 state=running 时有值：inline=整链路跑到网格阶段，retry=只重试网格 */
  phase?: "inline" | "retry" | null;
  /** mesh.glb 当前字节数（重试失败时旧产物仍在，据此提示可继续下载） */
  bytes?: number;
};

/** 把 worker 的原始报错翻成用户能看懂的话（术语只在「技术细节」里展开） */
function meshErrorText(raw: string): string {
  if (/TSDF|faces=\d+/i.test(raw)) return "重建出的表面太少，可能是拍摄角度或光线不足，建议补拍后再试。";
  if (/CUDA|显存|out of memory/i.test(raw)) return "显卡显存不足，先关掉其他占用显卡的程序再试。";
  if (/config\.yml|训练文件/.test(raw)) return "找不到上次重建留下的训练文件，只能重跑整个重建任务。";
  if (/scene\.ply|点云/.test(raw)) return "找不到上次重建的高斯点云，只能重跑整个重建任务。";
  if (/ModuleNotFoundError|No module named/.test(raw)) return "重建环境缺少组件，请先跑一次环境自检。";
  return "生成过程中出错，可以点「仅重试网格」再试一次。";
}

/** 排队超过该时长即提示可能卡住（与列表页同一口径） */
const PENDING_STUCK_MINUTES = 10;

/** 排队原因只从两个可信来源推导：worker 锁是否被占用、本任务是否记录过 worker 进程 */
function pendingReason(task: TaskRow, worker: { busy: boolean; pid: number | null }): string {
  if (worker.busy) return `已有重建任务在运行（PID ${worker.pid ?? "未知"}），正在等它结束`;
  if (task.worker_pid) return "上次启动的 Worker 已退出，且没有上报状态";
  return "Worker 尚未启动，重建环境可能未就绪";
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
  /** 排队任务的出口：重新派发 / 取消，各自有进行中与失败反馈 */
  const [taskActing, setTaskActing] = useState<"retry" | "cancel" | null>(null);
  const [taskActionError, setTaskActionError] = useState<string | null>(null);
  const [worker, setWorker] = useState<{ busy: boolean; pid: number | null }>({ busy: false, pid: null });
  /** 手动触发一次刷新：操作后立即反映状态，而不是等下一次 3 秒轮询 */
  const [refreshNonce, setRefreshNonce] = useState(0);
  /** 轮询时更新，避免在渲染期调用 Date.now（React 纯度规则） */
  const [now, setNow] = useState(0);
  // 网格是可选增强产物：状态与失败原因统一由服务端判定，不再靠 HEAD 探测猜
  const [mesh, setMesh] = useState<MeshStatusBody | null>(null);
  const [meshRetrying, setMeshRetrying] = useState(false);
  const [meshRetryError, setMeshRetryError] = useState<string | null>(null);
  // 场景清单（scene-manifest v1）优先：存在时可选中/变换/撤销并保存布局
  const [sceneAvailable, setSceneAvailable] = useState(false);
  /** 网格与高斯两个查看器的视角同步开关（默认开，拖动任一另个跟随） */
  const [viewSync, setViewSync] = useState(true);
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
        setWorker(data.worker);
        setNow(Date.now());
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
  }, [id, refreshNonce]);

  // 网格状态：产物是否存在、是否正在单独重试、失败原因是什么，都由服务端判定
  useEffect(() => {
    if (!id) return;
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`/api/reconstructions/${id}/mesh/status`, { cache: "no-store" });
        if (!r.ok) return;
        const body = (await r.json()) as MeshStatusBody;
        if (alive) setMesh(body);
      } catch {
        // 网络抖动保留上次结果
      }
    };
    tick();
    const iv = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [id]);

  const retryMesh = async () => {
    if (!id) return;
    setMeshRetrying(true);
    setMeshRetryError(null);
    try {
      const r = await fetch(`/api/reconstructions/${id}/mesh/retry`, { method: "POST" });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(body.error || "网格重试启动失败");
      setMesh((m) => (m ? { ...m, state: "running", error: null } : m));
    } catch (e) {
      setMeshRetryError(e instanceof Error ? e.message : "网格重试启动失败");
    } finally {
      setMeshRetrying(false);
    }
  };

  const retryTask = async () => {
    if (!id || taskActing) return;
    setTaskActing("retry");
    setTaskActionError(null);
    try {
      const r = await api.retryTask(id);
      if (!r.workerStarted) setTaskActionError(`仍然没能派发：${r.workerError ?? "未知原因"}`);
      setRefreshNonce((n) => n + 1);
    } catch (e) {
      setTaskActionError(e instanceof Error ? e.message : "重新尝试失败");
    } finally {
      setTaskActing(null);
    }
  };

  const cancelTask = async () => {
    if (!id || taskActing) return;
    setTaskActing("cancel");
    setTaskActionError(null);
    try {
      await api.cancelTask(id);
      setRefreshNonce((n) => n + 1);
    } catch (e) {
      setTaskActionError(e instanceof Error ? e.message : "取消失败");
    } finally {
      setTaskActing(null);
    }
  };

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

  const waitedMinutes = task && now
    ? Math.max(0, Math.floor((now - new Date(task.created_at).getTime()) / 60000))
    : 0;

  // 事件按时间倒序，取最近一条错误：任务最终完成时，只在顶部留一句人话，
  // 完整报错收进折叠日志，避免「重建完成」正下方就是满屏红色报错。
  const lastFailure = events.find((ev) => ev.level === "error");
  const logSummary =
    task?.status === "completed" && lastFailure
      ? `上次失败原因：${lastFailure.message}（该次已通过重新尝试完成，最终结果正常）`
      : null;

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

        {/* 结果区：网格与高斯结果同屏并排（同一世界坐标，可对照），窄屏自动堆叠 */}
        <div className={`grid grid-cols-1 items-start gap-4 ${sceneAvailable ? "" : "xl:grid-cols-2"}`}>
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
        ) : task?.status === "completed" &&
          (mesh?.state === "ready" || (mesh?.state === "failed" && (mesh?.bytes ?? 0) > 0)) ? (
          <section
            className="overflow-hidden rounded-2xl mv-fade-in"
            style={{
              border: "1px solid rgba(56,189,248,0.2)",
              boxShadow: "0 0 30px rgba(56,189,248,0.08)",
            }}
          >
            <div
              className="flex items-center justify-between gap-3 px-4 py-2"
              style={{
                background: "rgba(8,13,26,0.95)",
                borderBottom: "1px solid rgba(56,189,248,0.15)",
              }}
            >
              <span className="text-[11px] text-slate-500">
                纹理网格与下方高斯结果共用同一世界坐标，可对照查看
              </span>
              <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-300">
                <input
                  type="checkbox"
                  checked={viewSync}
                  onChange={(e) => setViewSync(e.target.checked)}
                  className="accent-sky-400"
                />
                同步视角
              </label>
            </div>
            <MeshViewer
              url={`/api/reconstructions/${id}/mesh`}
              height={520}
              orient="colmap-nerfstudio"
              taskId={id}
              syncEnabled={viewSync}
            />
            <div
              className="flex items-center gap-3 px-4 py-3"
              style={{
                borderTop: "1px solid rgba(56,189,248,0.15)",
                background: "rgba(8,13,26,0.95)",
              }}
            >
              <span className="flex-1 text-[11px] text-slate-500">
                纹理网格 · 拖动旋转 / 滚轮缩放 / 右键平移
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

        {/* 网格状态：未就绪时说清原因，并支持只重试网格（不重跑整个重建） */}
        {/* 整链路跑到网格阶段时主任务还是 processing，这里也要显示，否则会被当成「未导出网格」 */}
        {mesh && mesh.state !== "ready" && (task?.status === "completed" || mesh.state === "running") && (
          <section
            className="mt-4 rounded-2xl px-5 py-4 mv-fade-in"
            style={{
              background: "rgba(10,15,30,0.7)",
              border: `1px solid ${mesh.state === "failed" ? "rgba(248,113,113,0.25)" : "rgba(148,163,184,0.18)"}`,
            }}
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5 shrink-0">
                {mesh.state === "running" ? (
                  <Loader2 size={18} className="animate-spin" style={{ color: "#818cf8" }} />
                ) : mesh.state === "failed" ? (
                  <XCircle size={18} style={{ color: "#f87171" }} />
                ) : (
                  <AlertTriangle size={18} style={{ color: "#94a3b8" }} />
                )}
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-slate-100">
                  {mesh.state === "running"
                    ? mesh.phase === "retry" ? "正在重新生成网格…" : "正在生成纹理网格…"
                    : mesh.state === "failed" ? "网格生成失败"
                    : mesh.state === "missing" ? "网格尚未生成"
                    : "未导出网格"}
                </p>
                <p className="mt-1 text-[11px] leading-5 text-slate-400">
                  {mesh.state === "running"
                    ? mesh.phase === "retry"
                      ? "复用上次重建的模型，只重跑网格这一段，不影响已有的高斯结果。大约还要 20~25 分钟。"
                      : "主重建已完成，正在生成带贴图的网格（2DGS 训练 → 表面重建 → 贴图烘焙），大约还要 20~25 分钟；好了这里会换成可直接旋转查看、下载的模型。"
                    : mesh.state === "failed"
                      ? meshErrorText(mesh.error ?? "") +
                        ((mesh.bytes ?? 0) > 0 ? " 上次生成的网格仍然可用，可以继续查看或下载。" : "")
                      : mesh.state === "missing"
                        ? "任务已开启网格导出，但还没有产物。可以只重试网格。"
                        : "创建任务时没有勾选「同时导出网格」，本次只有高斯结果。需要网格请重新创建任务并勾选该选项。"}
                </p>
                {mesh.state === "failed" && mesh.error && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[10px] text-slate-600">技术细节</summary>
                    <pre
                      className="mt-1 max-h-24 overflow-auto text-[10px] leading-4 text-slate-600"
                      style={{ whiteSpace: "pre-wrap" }}
                    >
                      {mesh.error}
                    </pre>
                  </details>
                )}
                {meshRetryError && <p className="mt-1.5 text-[11px] text-red-400">{meshRetryError}</p>}
                {(mesh.state === "failed" || mesh.state === "missing") && (
                  <button
                    onClick={retryMesh}
                    disabled={meshRetrying}
                    className="btn-ghost mt-2.5 flex items-center gap-1.5"
                  >
                    {meshRetrying ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                    {meshRetrying ? "启动中…" : "仅重试网格"}
                  </button>
                )}
              </div>
            </div>
          </section>
        )}

        {/* 高斯查看器 */}
        {task?.status === "completed" ? (
          <section
            className="overflow-hidden rounded-2xl mv-fade-in"
            style={{
              border: "1px solid rgba(139,92,246,0.2)",
              boxShadow: "0 0 30px rgba(139,92,246,0.08)",
            }}
          >
            {/* 操作入口固定在结果卡顶部：不用滚到卡片底部才能导入 */}
            <div
              className="flex items-center gap-3 px-4 py-2"
              style={{
                background: "rgba(8,13,26,0.95)",
                borderBottom: "1px solid rgba(139,92,246,0.15)",
              }}
            >
              <span className="flex-1 text-[11px] text-slate-500">
                重建结果（Gaussian Splatting）
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
            <SplatViewer
              url={`/api/reconstructions/${id}/result`}
              height={520}
              orient="colmap-nerfstudio"
              taskId={id ?? undefined}
              syncEnabled={viewSync}
            />
            <div
              className="flex items-center gap-3 px-4 py-3"
              style={{
                borderTop: "1px solid rgba(139,92,246,0.15)",
                background: "rgba(8,13,26,0.95)",
              }}
            >
              <span className="flex-1 text-[11px] text-slate-500">
                拖动旋转 / 滚轮缩放 / 右键平移
              </span>
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
                <div className="mt-4 flex justify-center">
                  <button onClick={retryTask} disabled={taskActing !== null} className="btn-ghost" style={{ color: "#a855f7" }}>
                    {taskActing === "retry" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                    {taskActing === "retry" ? "正在派发…" : "重新尝试"}
                  </button>
                </div>
                {taskActionError && <p className="mt-2 text-[11px] text-red-400">{taskActionError}</p>}
              </div>
            )}
            {task.status === "pending" && (
              <div className="max-w-lg px-6 text-center">
                <Clock size={32} className="mx-auto mb-3 text-slate-500" />
                <p className="text-sm text-slate-300">排队等待中…</p>
                <p className="mt-1 text-[11px] text-slate-500">
                  已等待 {waitedMinutes} 分钟 · {pendingReason(task, worker)}
                </p>
                {waitedMinutes >= PENDING_STUCK_MINUTES && (
                  <p
                    className="mt-3 rounded-xl px-3 py-2 text-[11px] leading-5"
                    style={{ background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.25)", color: "#fbbf24" }}
                  >
                    排队超过 {PENDING_STUCK_MINUTES} 分钟，可能卡住了。可以「重新尝试」重新派发（不重传照片），或「取消」这个任务。
                  </p>
                )}
                <div className="mt-4 flex justify-center gap-2">
                  <button onClick={retryTask} disabled={taskActing !== null} className="btn-ghost" style={{ color: "#a855f7" }}>
                    {taskActing === "retry" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                    {taskActing === "retry" ? "正在派发…" : "重新尝试"}
                  </button>
                  <button onClick={cancelTask} disabled={taskActing !== null} className="btn-ghost" style={{ color: "#f87171" }}>
                    {taskActing === "cancel" ? <Loader2 size={12} className="animate-spin" /> : <XCircle size={12} />}
                    {taskActing === "cancel" ? "正在取消…" : "取消任务"}
                  </button>
                </div>
                {taskActionError && <p className="mt-2 text-[11px] text-red-400">{taskActionError}</p>}
              </div>
            )}
            {task.status === "canceled" && (
              <div className="max-w-lg px-6 text-center">
                <AlertTriangle size={32} className="mx-auto mb-3" style={{ color: "#64748b" }} />
                <p className="text-sm text-slate-400">任务已取消</p>
                <p className="mt-1 text-[11px] text-slate-500">照片仍保留在任务里，可直接重新尝试，不用重传。</p>
                <div className="mt-4 flex justify-center">
                  <button onClick={retryTask} disabled={taskActing !== null} className="btn-ghost" style={{ color: "#a855f7" }}>
                    {taskActing === "retry" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                    {taskActing === "retry" ? "正在派发…" : "重新尝试"}
                  </button>
                </div>
                {taskActionError && <p className="mt-2 text-[11px] text-red-400">{taskActionError}</p>}
              </div>
            )}
          </section>
        )}

        </div>

        {/* ── 底部二栏：事件 + 日志 ── */}
        <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* 任务事件 */}
          <div>
            <h2 className="mb-3 text-sm font-semibold text-slate-200">任务事件（历史记录，按时间倒序）</h2>
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

          {/* 日志：默认折叠。worker 日志没有尝试分隔标记，无法可靠按「最后一次运行/历史失败」分组，
              因此只在顶部给一句摘要 + 明确标注日志包含全部尝试 */}
          <div>
            <h2 className="mb-3 text-sm font-semibold text-slate-200">处理日志（尾部 200 行）</h2>
            {logSummary && (
              <p
                className="mb-2 rounded-xl px-3 py-2 text-[11px] leading-5"
                style={{
                  background: "rgba(251,191,36,0.08)",
                  border: "1px solid rgba(251,191,36,0.25)",
                  color: "#fbbf24",
                }}
              >
                {logSummary}
              </p>
            )}
            <details
              className="rounded-2xl overflow-hidden"
              style={{
                background: "rgba(3,7,18,0.8)",
                border: "1px solid rgba(139,92,246,0.12)",
              }}
            >
              <summary className="cursor-pointer select-none px-3 py-2 text-[11px] text-slate-400 transition hover:text-slate-200">
                展开查看完整日志（含历史失败尝试的原始输出）
              </summary>
              <pre
                className="max-h-72 overflow-auto px-3 pb-3 text-[10px] leading-5 font-mono"
                style={{ color: "#64748b" }}
              >
                {logTail.length ? logTail.join("\n") : "暂无日志"}
              </pre>
            </details>
          </div>
        </section>
      </main>
    </div>
  );
}
