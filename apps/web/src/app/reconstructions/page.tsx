"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CloudUpload, FileImage, Loader2, RefreshCw, Square, CheckCircle2, XCircle, Clock, Zap, AlertCircle } from "lucide-react";
import { api, uploadPhotos, type TaskRow } from "@/lib/api";

const STATUS_BADGE: Record<TaskRow["status"], string> = {
  pending: "badge badge-pending",
  processing: "badge badge-processing",
  completed: "badge badge-completed",
  failed: "badge badge-failed",
  canceled: "badge badge-canceled",
};

const STATUS_LABEL: Record<TaskRow["status"], string> = {
  pending: "排队中",
  processing: "处理中",
  completed: "已完成",
  failed: "失败",
  canceled: "已取消",
};

const STATUS_ICON: Record<TaskRow["status"], React.ReactNode> = {
  pending: <Clock size={10} />,
  processing: <Loader2 size={10} className="animate-spin" />,
  completed: <CheckCircle2 size={10} />,
  failed: <XCircle size={10} />,
  canceled: <Square size={10} />,
};

/** 创建重建任务的最少照片数：与 submit 的前置校验同一口径，按钮也据此禁用 */
const MIN_PHOTOS = 3;

/** 排队超过该时长就认为可能卡住：给出原因和可操作出口，而不是继续沉默等待 */
const PENDING_STUCK_MS = 10 * 60 * 1000;

function pendingWaitMinutes(t: TaskRow, now: number): number {
  return now ? Math.max(0, Math.floor((now - new Date(t.created_at).getTime()) / 60000)) : 0;
}

/** 排队原因只有两种可信来源：worker 锁是否被占用、本任务是否记录过 worker 进程 */
function pendingReason(t: TaskRow, worker: { busy: boolean; pid: number | null }): string {
  if (worker.busy) return `已有重建任务在运行（PID ${worker.pid ?? "未知"}），本任务在等它结束`;
  if (t.worker_pid) return "上次启动的 Worker 已退出，且没有上报状态";
  return "Worker 尚未启动，重建环境可能未就绪";
}

export default function ReconstructionsPage() {
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [messageType, setMessageType] = useState<"success" | "error" | "info">("info");
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [worker, setWorker] = useState<{ busy: boolean; pid: number | null }>({ busy: false, pid: null });
  /** 轮询时顺带更新，避免在渲染期调用 Date.now（React 纯度规则） */
  const [now, setNow] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  // 网格是可选增强产物：默认关，开启后 worker 多跑一次训练 + 纹理烘焙
  const [exportMesh, setExportMesh] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewUrls = useRef<string[]>([]);

  const refreshTasks = useCallback(async () => {
    try {
      const { tasks, worker } = await api.listTasks();
      setTasks(tasks);
      setWorker(worker);
      setNow(Date.now());
    } catch {
      // 服务端不可用时静默
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(refreshTasks, 0);
    const iv = setInterval(refreshTasks, 5000);
    return () => {
      clearTimeout(first);
      clearInterval(iv);
      previewUrls.current.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [refreshTasks]);

  const acceptFiles = (list: FileList | null) => {
    if (!list) return;
    const arr = Array.from(list);
    previewUrls.current.forEach((u) => URL.revokeObjectURL(u));
    previewUrls.current = arr.slice(0, 12).map((f) => URL.createObjectURL(f));
    setPreviews(previewUrls.current);
    setFiles(arr);
    setMessage(null);
  };

  const submit = async () => {
    if (files.length < MIN_PHOTOS) {
      setMessage(`至少需要 ${MIN_PHOTOS} 张照片（推荐 30~80 张环绕拍摄）`);
      setMessageType("error");
      return;
    }
    setProgress(0);
    setMessage(null);
    try {
      const result = await uploadPhotos(files, { exportMesh }, setProgress);
      setMessage(
        result.workerStarted
          ? "任务已创建，已派发给重建环境，等待 Worker 开始处理…"
          : `任务已创建，但 Worker 未能启动：${result.workerError ?? "未知原因"}（可在任务列表点「重新尝试」）`
      );
      setMessageType(result.workerStarted ? "success" : "error");
      setFiles([]);
      setPreviews([]);
      await refreshTasks();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "上传失败");
      setMessageType("error");
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="min-h-screen" style={{ background: "#030712", color: "#f1f5f9" }}>
      {/* 星云背景 */}
      <div className="stars-bg pointer-events-none" />
      <div
        className="nebula-glow pointer-events-none"
        style={{
          width: 500,
          height: 500,
          background: "radial-gradient(ellipse, rgba(139,92,246,0.08) 0%, transparent 70%)",
          top: "10%",
          right: "5%",
        }}
      />

      {/* 顶栏 */}
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
            <path d="M3 7l9-4 9 4v10l-9 4-9-4V7z" stroke="url(#rGrad)" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M12 3v18M3 7l9 4 9-4" stroke="url(#rGrad)" strokeWidth="1.5" strokeLinejoin="round" />
            <defs>
              <linearGradient id="rGrad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
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
        <span className="text-xs text-slate-400">照片重建</span>
        <span
          className="text-[10px] px-2 py-0.5 rounded-full"
          style={{
            background: "rgba(34,211,238,0.1)",
            color: "#67e8f9",
            border: "1px solid rgba(34,211,238,0.2)",
          }}
        >
          COLMAP + Gaussian Splatting
        </span>

        <Link
          href="/"
          className="ml-auto btn-ghost"
        >
          ← 返回编辑器
        </Link>
      </header>

      <main className="relative mx-auto max-w-4xl px-4 py-8">
        {/* ── 上传区 ── */}
        <section
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            acceptFiles(e.dataTransfer.files);
          }}
          className="rounded-2xl p-8 text-center transition-all duration-200"
          style={
            dragOver
              ? {
                  background: "rgba(139,92,246,0.1)",
                  border: "2px dashed rgba(168,85,247,0.6)",
                  boxShadow: "0 0 40px rgba(168,85,247,0.15)",
                }
              : {
                  background: "rgba(10,15,30,0.7)",
                  border: "2px dashed rgba(139,92,246,0.2)",
                  backdropFilter: "blur(20px)",
                }
          }
        >
          {/* 上传图标 */}
          <div
            className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl"
            style={{
              background: "linear-gradient(135deg, rgba(124,58,237,0.2), rgba(168,85,247,0.1))",
              border: "1px solid rgba(168,85,247,0.25)",
              boxShadow: "0 0 20px rgba(168,85,247,0.1)",
            }}
          >
            <CloudUpload size={28} style={{ color: "#a855f7", filter: "drop-shadow(0 0 8px rgba(168,85,247,0.6))" }} />
          </div>

          <p className="text-base font-semibold text-slate-200">拖入房间照片，或点击选择</p>
          <p className="mt-1.5 text-[11px] text-slate-500">
            JPG / PNG / WebP · 单张 ≤15MB · 3~120 张 · 推荐 30~80 张环绕拍摄
          </p>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => acceptFiles(e.target.files)}
          />
          <button
            onClick={() => inputRef.current?.click()}
            className="btn-ghost mt-4"
          >
            选择照片
          </button>

          {/* 网格导出开关（可选增强）：默认关，开启会显著拉长任务耗时 */}
          <label
            className="mx-auto mt-4 flex max-w-md cursor-pointer items-start gap-2.5 rounded-xl px-3 py-2.5 text-left"
            style={{
              background: exportMesh ? "rgba(56,189,248,0.1)" : "rgba(15,23,42,0.5)",
              border: `1px solid ${exportMesh ? "rgba(56,189,248,0.35)" : "rgba(139,92,246,0.15)"}`,
            }}
          >
            <input
              type="checkbox"
              checked={exportMesh}
              onChange={(e) => setExportMesh(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-sky-500"
            />
            <span className="text-[11px] leading-5">
              <span className="font-semibold" style={{ color: "#7dd3fc" }}>
                同时导出网格
              </span>
              <span className="ml-1.5 rounded px-1 py-0.5 text-[9px] text-slate-400" style={{ background: "rgba(148,163,184,0.12)" }}>
                默认关闭
              </span>
              <span className="block text-slate-400">
                额外产出带贴图的三维模型，可在任务详情页下载。会多花约 15~25 分钟（8GB 显卡实测约 16 分钟），
                期间要再跑一次训练，显存占用与主重建相近。
              </span>
            </span>
          </label>

          {/* 已选文件预览 */}
          {files.length > 0 && (
            <div className="mt-6 mv-fade-in">
              <div className="flex flex-wrap justify-center gap-2">
                {previews.map((url, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={url}
                    alt={`预览 ${i + 1}`}
                    className="h-16 w-20 rounded-lg object-cover"
                    style={{ border: "1px solid rgba(139,92,246,0.2)", boxShadow: "0 0 8px rgba(0,0,0,0.3)" }}
                  />
                ))}
                {files.length > 12 && (
                  <span
                    className="flex h-16 w-20 items-center justify-center rounded-lg text-[11px] text-slate-400"
                    style={{
                      background: "rgba(15,23,42,0.6)",
                      border: "1px solid rgba(139,92,246,0.15)",
                    }}
                  >
                    +{files.length - 12} 张
                  </span>
                )}
              </div>

              <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-slate-400">
                <FileImage size={13} style={{ color: "#a855f7" }} />
                已选择 {files.length} 张照片
              </p>

              {/* 上传进度条 */}
              {progress !== null && (
                <div className="mt-3 mx-auto max-w-xs">
                  <div
                    className="w-full rounded-full overflow-hidden"
                    style={{ height: 4, background: "rgba(139,92,246,0.1)" }}
                  >
                    <div
                      className="h-full rounded-full progress-glow transition-all duration-300"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  <p className="mt-1.5 text-[10px] text-slate-500">上传中 {progress}%</p>
                </div>
              )}

              <button
                onClick={submit}
                disabled={progress !== null || files.length < MIN_PHOTOS}
                title={files.length < MIN_PHOTOS ? `至少需要 ${MIN_PHOTOS} 张不同角度的照片` : undefined}
                className="btn-gold mt-4 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {progress !== null ? <Loader2 size={13} className="animate-spin" /> : <CloudUpload size={13} />}
                {progress !== null
                  ? `上传中 ${progress}%`
                  : files.length < MIN_PHOTOS
                    ? `还差 ${MIN_PHOTOS - files.length} 张（至少 ${MIN_PHOTOS} 张）`
                    : "创建重建任务"}
              </button>
            </div>
          )}

          {/* 消息提示 */}
          {message && (
            <div
              className="mt-4 inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs mv-fade-in"
              style={
                messageType === "success"
                  ? { background: "rgba(6,78,59,0.3)", color: "#6ee7b7", border: "1px solid rgba(52,211,153,0.2)" }
                  : messageType === "error"
                    ? { background: "rgba(127,29,29,0.3)", color: "#fca5a5", border: "1px solid rgba(248,113,113,0.2)" }
                    : { background: "rgba(30,58,138,0.3)", color: "#93c5fd", border: "1px solid rgba(99,102,241,0.2)" }
              }
            >
              {messageType === "success" ? <CheckCircle2 size={13} /> : messageType === "error" ? <AlertCircle size={13} /> : <Zap size={13} />}
              {message}
            </div>
          )}
        </section>

        {/* ── 拍摄指引 ── */}
        <details
          className="mt-4 rounded-2xl overflow-hidden"
          style={{
            background: "rgba(10,15,30,0.6)",
            border: "1px solid rgba(245,158,11,0.15)",
            backdropFilter: "blur(16px)",
          }}
        >
          <summary
            className="flex cursor-pointer select-none items-center gap-2 px-4 py-3 text-xs font-semibold"
            style={{ color: "#fbbf24" }}
          >
            <span style={{ filter: "drop-shadow(0 0 4px rgba(245,158,11,0.5))" }}>📷</span>
            拍摄指引（决定重建质量的第一要素，点开查看）
          </summary>
          <ul
            className="list-disc gap-1 pl-6 pb-4 pr-4 text-[11px] leading-6 text-amber-100/70 grid"
            style={{ borderTop: "1px solid rgba(245,158,11,0.1)" }}
          >
            <li className="mt-3">数量 30~80 张：环绕房间 2~3 圈（一圈平视、一圈俯仰 30°），相邻照片 <b>60% 以上重叠</b></li>
            <li>移动时原地转身，避免绕着家具走圈，保证所有区域被至少 3 张不同角度看到</li>
            <li>避免运动模糊（手持慢走）、镜面/玻璃反光、大面积纯白墙（缺乏特征点）</li>
            <li>光线稳定：关闭自动曝光/自动对焦，宁可稍暗不要忽明忽暗</li>
            <li>分辨率够用即可（上传后自动降采样，8GB 显存按 1200px 训练）</li>
          </ul>
        </details>

        {/* ── 演示入口 ── */}
        <section
          className="mt-4 rounded-2xl px-4 py-3 flex items-center justify-between text-xs"
          style={{
            background: "rgba(8,47,73,0.3)",
            border: "1px solid rgba(34,211,238,0.15)",
            backdropFilter: "blur(12px)",
            color: "#67e8f9",
          }}
        >
          <span>未配置 GPU 重建环境？</span>
          <Link
            href="/reconstructions/demo"
            className="flex items-center gap-1 rounded-lg px-3 py-1.5 font-semibold transition-all"
            style={{
              background: "rgba(34,211,238,0.1)",
              border: "1px solid rgba(34,211,238,0.2)",
              color: "#22d3ee",
            }}
          >
            查看演示高斯场景 →
          </Link>
        </section>

        {/* ── 任务列表 ── */}
        <section className="mt-8">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-200">重建任务</h2>
            <span className="text-[10px] text-slate-600">每 5 秒自动刷新</span>
          </div>

          {tasks.length === 0 ? (
            <div
              className="rounded-2xl px-4 py-10 text-center text-xs text-slate-600"
              style={{
                background: "rgba(10,15,30,0.4)",
                border: "1px solid rgba(139,92,246,0.08)",
              }}
            >
              暂无任务 · 上传照片创建第一个重建任务
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {tasks.map((t) => (
                <li
                  key={t.id}
                  className="flex items-center gap-3 rounded-2xl px-4 py-3 transition-all duration-150"
                  style={{
                    background: "rgba(10,15,30,0.65)",
                    border: "1px solid rgba(139,92,246,0.12)",
                    backdropFilter: "blur(12px)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.border = "1px solid rgba(139,92,246,0.25)";
                    e.currentTarget.style.boxShadow = "0 0 16px rgba(139,92,246,0.08)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.border = "1px solid rgba(139,92,246,0.12)";
                    e.currentTarget.style.boxShadow = "none";
                  }}
                >
                  {/* 状态徽章 */}
                  <span className={`${STATUS_BADGE[t.status]} flex items-center gap-1`}>
                    {STATUS_ICON[t.status]}
                    {STATUS_LABEL[t.status]}
                  </span>

                  {/* 任务信息 */}
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/reconstructions/${t.id}`}
                      className="block truncate text-xs text-slate-300 transition hover:text-purple-300"
                    >
                      <span className="font-mono">{t.id.slice(0, 8)}…</span>
                      <span className="ml-2 text-slate-500">· {t.photo_count} 张照片 · 尝试 {t.attempts} 次</span>
                    </Link>
                    {t.error && (
                      <p className="mt-0.5 truncate text-[10px] text-red-400">{t.error}</p>
                    )}
                    {/* 处理中显示动态进度条 */}
                    {t.status === "processing" && (
                      <div
                        className="mt-1.5 w-full rounded-full overflow-hidden"
                        style={{ height: 2, background: "rgba(99,102,241,0.1)" }}
                      >
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: "60%",
                            background: "linear-gradient(90deg, #6366f1, #a855f7)",
                            boxShadow: "0 0 6px rgba(168,85,247,0.6)",
                            animation: "mv-progress-shimmer 2s linear infinite",
                            backgroundSize: "200% 100%",
                          }}
                        />
                      </div>
                    )}
                    {/* 排队超时：说清卡在哪、能做什么，而不是让用户干等 */}
                    {t.status === "pending" && now > 0 && now - new Date(t.created_at).getTime() > PENDING_STUCK_MS && (
                      <p className="mt-1 text-[10px] leading-4" style={{ color: "#fbbf24" }}>
                        已排队 {pendingWaitMinutes(t, now)} 分钟：{pendingReason(t, worker)}。可以点「重新尝试」重新派发，或点「取消」放弃这个任务。
                      </p>
                    )}
                  </div>

                  {/* 操作按钮 */}
                  {(t.status === "pending" || t.status === "failed" || t.status === "canceled") && (
                    <button
                      onClick={async () => {
                        try {
                          const r = await api.retryTask(t.id);
                          setMessage(
                            r.workerStarted
                              ? "已重新派发，等待 Worker 开始处理…"
                              : `未能派发：${r.workerError ?? "未知原因"}`
                          );
                          setMessageType(r.workerStarted ? "success" : "error");
                          refreshTasks();
                        } catch (e) {
                          setMessage(e instanceof Error ? e.message : "重新尝试失败");
                          setMessageType("error");
                        }
                      }}
                      className="btn-ghost shrink-0"
                      style={{ color: "#a855f7" }}
                    >
                      <RefreshCw size={11} /> 重新尝试
                    </button>
                  )}
                  {(t.status === "pending" || t.status === "processing") && (
                    <button
                      onClick={async () => {
                        await api.cancelTask(t.id).catch(() => null);
                        refreshTasks();
                      }}
                      className="btn-danger shrink-0"
                    >
                      <Square size={11} /> 取消
                    </button>
                  )}
                  {t.status === "completed" && (
                    <Link
                      href={`/reconstructions/${t.id}`}
                      className="btn-ghost shrink-0"
                      style={{ color: "#6ee7b7", borderColor: "rgba(52,211,153,0.2)" }}
                    >
                      查看结果 →
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
