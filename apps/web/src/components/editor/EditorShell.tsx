"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Undo2,
  Redo2,
  Save,
  Download,
  Upload,
  RotateCcw,
  Move,
  RotateCw,
  Maximize2,
  Play,
  Pencil,
  CloudUpload,
  Database,
  HardDrive,
  Sparkles,
  Loader2,
  X,
  CheckCircle2,
  WifiOff,
  Cpu,
  ChevronLeft,
  History,
  RefreshCw,
  MoreHorizontal,
} from "lucide-react";
import SceneCanvas from "./SceneCanvas";
import LeftPanel from "./LeftPanel";
import PropertiesPanel from "./PropertiesPanel";
import { useEditorStore, type ViewPreset } from "@/stores/editor-store";
import { api, ApiError, type SceneHistoryEntry } from "@/lib/api";
import { decideAutosave, snapshotScene } from "@/lib/autosave-decision";
import type { SceneData } from "@shared/scene-schema";

interface EditorShellProps {
  sceneId: string;
}

/**
 * 保存反馈的持续状态（不是一次性 toast）：
 * - saving：正在写服务端
 * - saved：已写入，保留时间戳直到下一次改动
 * - failed：写入失败，改动已留在本机，可点重试
 * - paused：自动保存被挂起（版本冲突未决 / 场景已被删除），需用户处理后可重试
 */
type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; at: number }
  | { status: "failed"; message: string }
  | { status: "paused"; message: string };

/**
 * 保存状态胶囊：header 与窄屏浮层共用。
 * header 在窄屏是横向滚动容器，状态胶囊会被挤出可视区，
 * 所以窄屏额外在视口右上角常驻一份（.mv-save-float 控制显隐）。
 */
function SaveStateChip({
  state,
  onRetry,
  className = "",
}: {
  state: SaveState;
  onRetry: () => void;
  className?: string;
}) {
  if (state.status === "idle") return null;
  const tone =
    state.status === "saved"
      ? { background: "rgba(6,26,22,0.92)", color: "#34d399", border: "1px solid rgba(52,211,153,0.4)" }
      : state.status === "saving"
        ? { background: "rgba(6,22,30,0.92)", color: "#67e8f9", border: "1px solid rgba(34,211,238,0.4)" }
        : state.status === "failed"
          ? { background: "rgba(32,10,14,0.94)", color: "#f87171", border: "1px solid rgba(248,113,113,0.45)" }
          : { background: "rgba(32,23,6,0.94)", color: "#fbbf24", border: "1px solid rgba(245,158,11,0.45)" };
  return (
    <span
      className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] backdrop-blur-sm ${className}`}
      style={tone}
      title={state.status === "failed" || state.status === "paused" ? state.message : undefined}
    >
      {state.status === "saving" && (
        <>
          <Loader2 size={10} className="animate-spin" />
          保存中…
        </>
      )}
      {state.status === "saved" && (
        <>
          <CheckCircle2 size={10} />
          已保存{" "}
          <span className="tabular-nums">
            {new Date(state.at).toLocaleTimeString("zh-CN", { hour12: false })}
          </span>
        </>
      )}
      {(state.status === "failed" || state.status === "paused") && (
        <>
          {state.status === "failed" ? <WifiOff size={10} /> : <HardDrive size={10} />}
          {state.message}
          <button
            className="ml-0.5 flex items-center gap-0.5 rounded px-1 py-0.5 underline underline-offset-2 transition hover:bg-white/10"
            onClick={onRetry}
          >
            <RefreshCw size={9} /> 重试
          </button>
        </>
      )}
    </span>
  );
}

export default function EditorShell({ sceneId }: EditorShellProps) {
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 读失败类型：unavailable=5xx/网络，missing=404（仅用于文案与提示，不参与自动保存判定） */
  const [loadFailure, setLoadFailure] = useState<"unavailable" | "missing" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 保存遇到 409：必须由用户三选一，绝不静默失败。基准 serverRevision 只在首次冲突时固定 */
  const [conflict, setConflict] = useState<{ server: SceneData | null; serverRevision: number } | null>(null);
  /** 用户取消冲突后暂停自动保存：避免「取消 → 立刻又自动重试 → 又弹窗」的死循环 */
  const [autosaveHold, setAutosaveHold] = useState(false);
  /** 历史版本面板：只读快照列表，恢复走 CAS 追加为新版本 */
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<SceneHistoryEntry[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [health, setHealth] = useState<{ python: string | null; workerBusy: boolean; taskCount: number } | null>(null);
  /** 持续可见的保存状态（toast 只作补充） */
  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" });
  // 窄屏没有横向空间同时放两侧面板：默认折叠，保证 3D 视口占满宽度且可交互
  const [leftCollapsed, setLeftCollapsed] = useState(
    () => typeof window !== "undefined" && window.innerWidth <= 900,
  );
  const [rightCollapsed, setRightCollapsed] = useState(
    () => typeof window !== "undefined" && window.innerWidth <= 900,
  );

  // 窗口被拖窄时同样收起两侧面板（只自动收起、不自动展开，用户手动打开后不会被抢走）
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth <= 900) {
        setLeftCollapsed(true);
        setRightCollapsed(true);
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  /** 场景不存在时的补救入口：真的新建一个场景，而不是跳回首页打开另一个已有场景 */
  const [creatingScene, setCreatingScene] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const scene = useEditorStore((s) => s.scene);
  const selectedId = useEditorStore((s) => s.selectedId);
  const gizmoMode = useEditorStore((s) => s.gizmoMode);
  const previewMode = useEditorStore((s) => s.previewMode);
  const past = useEditorStore((s) => s.past);
  const future = useEditorStore((s) => s.future);
  const savedAt = useEditorStore((s) => s.savedAt);
  const storageMode = useEditorStore((s) => s.storageMode);
  const loadSource = useEditorStore((s) => s.loadSource);
  const savedBaseline = useEditorStore((s) => s.savedBaseline);
  const splatLoad = useEditorStore((s) => s.splatLoad);
  const splatProgress = useEditorStore((s) => s.splatProgress);
  const viewMode = useEditorStore((s) => s.viewMode);
  const requestView = useEditorStore((s) => s.requestView);

  const setScene = useEditorStore((s) => s.setScene);
  const setGizmoMode = useEditorStore((s) => s.setGizmoMode);
  const setPreviewMode = useEditorStore((s) => s.setPreviewMode);
  const updateMetadata = useEditorStore((s) => s.updateMetadata);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const markSaved = useEditorStore((s) => s.markSaved);
  const mirrorToLocal = useEditorStore((s) => s.mirrorToLocal);
  const restoreFromLocal = useEditorStore((s) => s.restoreFromLocal);
  const loadSceneJson = useEditorStore((s) => s.loadSceneJson);
  const resetToDemo = useEditorStore((s) => s.resetToDemo);
  const pushHistory = useEditorStore((s) => s.pushHistory);
  const setReconstruction = useEditorStore((s) => s.setReconstruction);

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 2500);
  }, []);

  // 加载场景：读失败按类型分流（5xx/网络 vs 404），本地副本一律只读，不自动回写
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { scene: loaded } = await api.getScene(sceneId);
        if (alive) {
          setScene(loaded, sceneId);
          setLoadFailure(null);
          setReady(true);
          // 刷新本地镜像（仅 localStorage，不写服务端）：保证离线/场景被删时仍有本地副本
          mirrorToLocal();
        }
      } catch (e) {
        if (!alive) return;
        const missing = e instanceof ApiError && e.status === 404;
        setLoadFailure(missing ? "missing" : "unavailable");
        if (restoreFromLocal(sceneId)) {
          flash(missing ? "场景已不存在，可手动用本地副本重建" : "服务端暂不可用，已载入本地副本（只读）");
        } else {
          setLoadError(missing ? "场景已不存在，且无本地缓存" : "服务端暂不可用，且无本地缓存");
        }
        setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [sceneId, setScene, restoreFromLocal, mirrorToLocal, flash]);

  // 内容是否相对已持久化基线有变化：用序列化比对，避免 dirty 标记漏置位
  const sceneDirty = scene !== null && savedBaseline !== null && snapshotScene(scene) !== savedBaseline;

  /**
   * 统一保存入口：带 revision 做 CAS。409 时不写、不吞错，弹出冲突对话框
   * 让用户三选一；其他失败退回本地缓存并保留 dirty 状态。
   */
  const saveToServer = useCallback(
    async (
      target: SceneData,
      expectedRevision?: number
    ): Promise<"ok" | "conflict" | "failed" | "gone"> => {
      setSaveState({ status: "saving" });
      try {
        const res = await api.saveScene(
          target,
          expectedRevision !== undefined ? { expectedRevision } : undefined
        );
        markSaved("server", res.revision);
        setAutosaveHold(false);
        setSaveState({ status: "saved", at: Date.now() });
        return "ok";
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          const payload = e.payload as { revision?: number; scene?: SceneData } | undefined;
          const serverScene = payload?.scene ?? null;
          // 只记录基准 revision + 服务端内容；不缓存本地快照，避免弹窗期间编辑让基准漂移
          setConflict({
            server: serverScene,
            serverRevision: payload?.revision ?? serverScene?.metadata.revision ?? 0,
          });
          setSaveState({ status: "paused", message: "等你处理版本冲突" });
          return "conflict";
        }
        if (e instanceof ApiError && e.status === 404) {
          // 场景已在别处被删除：不再重试，避免每次编辑都打空请求
          markSaved("local");
          setAutosaveHold(true);
          setSaveState({ status: "paused", message: "场景已被删除，改动只在本机" });
          flash("这个场景已在别处被删除，当前改动只保留在本机，无法再同步到服务端。");
          return "gone";
        }
        markSaved("local");
        setSaveState({ status: "failed", message: "没能写入服务端，改动已留在本机" });
        return "failed";
      }
    },
    [markSaved, flash]
  );

  /** 失败/挂起后的手动重试：用当前最新内容再写一次，不重传照片、不重置场景 */
  const retrySave = useCallback(async () => {
    const current = useEditorStore.getState().scene;
    if (!current) return;
    mirrorToLocal();
    const result = await saveToServer(current);
    if (result === "ok") flash("已保存到服务端");
    else if (result === "failed") flash("服务端仍不可用，改动保留在本机");
  }, [saveToServer, mirrorToLocal, flash]);

  // 自动保存（防抖 1200ms）：同一串连续改动（含输入框逐字修改、连续两次拖动）只写一次。
  // loadSource=local 时直接跳过：旧镜像可能早于服务端数据；
  // 内容与服务端一致（dirty=false）也跳过，避免加载后盲写覆盖这半秒内别处的改动。
  // 冲突弹窗未决或用户取消后挂起时同样跳过：编辑器仍可继续改，只是不写、不再弹第二个窗。
  useEffect(() => {
    const decision = decideAutosave({
      ready,
      hasScene: scene !== null,
      loadSource,
      dirty: sceneDirty,
      suspended: conflict !== null || autosaveHold,
    });
    if (decision !== "write" || !scene) return;
    const t = setTimeout(async () => {
      mirrorToLocal();
      await saveToServer(scene);
    }, 1200);
    return () => clearTimeout(t);
  }, [scene, sceneDirty, ready, sceneId, loadSource, mirrorToLocal, saveToServer, conflict, autosaveHold]);

  // 本地副本回写服务端：仅由用户点击 + 二次确认触发
  const handleOverwriteServer = useCallback(async () => {
    const current = useEditorStore.getState().scene;
    if (!current) return;
    if (!window.confirm("确定用本地副本覆盖服务端场景？服务端当前内容会被丢弃，且无法撤销。")) return;
    const result = await saveToServer(current);
    if (result === "ok") {
      setLoadFailure(null);
      flash("已用本地副本覆盖服务端");
    } else if (result === "failed") {
      flash("覆盖失败：服务端仍不可用");
    } else if (result === "gone") {
      flash("覆盖失败：这个场景已被删除，本地内容已保留在本机");
    }
  }, [saveToServer, flash]);

  // 409 冲突三选项：以服务端版本覆盖本地
  const resolveConflictUseServer = useCallback(() => {
    if (!conflict?.server) return;
    setScene(conflict.server, sceneId);
    mirrorToLocal();
    setConflict(null);
    setLoadFailure(null);
    flash("已载入服务端最新版本，本地改动已丢弃");
  }, [conflict, setScene, sceneId, mirrorToLocal, flash]);

  // 409 冲突三选项：用当前最新内容强制覆盖服务端（基准 revision 固定为首次冲突时的服务端版本）
  const resolveConflictUseMine = useCallback(async () => {
    if (!conflict) return;
    const latest = useEditorStore.getState().scene;
    if (!latest) return;
    const result = await saveToServer(latest, conflict.serverRevision);
    if (result === "ok") {
      setConflict(null);
      setLoadFailure(null);
      flash("已用本地内容覆盖服务端");
    } else if (result === "failed") {
      flash("覆盖失败：服务端不可用，本地内容已保留");
    } else if (result === "gone") {
      flash("覆盖失败：这个场景已被删除，本地内容已保留在本机");
    }
    // result=conflict：服务端在此期间又变了，saveToServer 会更新基准并保持弹窗
  }, [conflict, saveToServer, flash]);

  // 409 冲突三选项：取消——不写服务端，保留本地内容，并暂停自动保存（可手动重试）
  const resolveConflictCancel = useCallback(() => {
    setConflict(null);
    setAutosaveHold(true);
    flash("已取消写入：本地改动仍保留，自动保存已暂停（点「保存」可重试）");
  }, [flash]);

  // 历史版本：打开面板即拉取只读快照列表（revision 倒序）
  const openHistory = useCallback(async () => {
    setHistoryOpen(true);
    setHistoryLoading(true);
    try {
      const { entries } = await api.listSceneHistory(sceneId);
      setHistoryEntries(entries);
    } catch (e) {
      setHistoryEntries([]);
      flash(`历史版本读取失败：${e instanceof Error ? e.message : "服务端不可用"}`);
    } finally {
      setHistoryLoading(false);
    }
  }, [sceneId, flash]);

  /**
   * 恢复历史版本：读取快照内容 → 以当前服务端版本号为基线 CAS 写入。
   * 写入是「追加新版本」，不改写历史；服务端在落盘前会把当前版本再快照一份。
   */
  const restoreHistory = useCallback(
    async (revision: number) => {
      if (restoring !== null) return;
      const current = useEditorStore.getState().scene;
      if (!current) {
        flash("场景未加载，无法恢复");
        return;
      }
      setRestoring(revision);
      try {
        const { scene: version } = await api.getSceneHistoryVersion(sceneId, revision);
        const res = await api.saveScene(version, { expectedRevision: current.metadata.revision });
        setScene(res.scene, sceneId);
        markSaved("server", res.revision);
        mirrorToLocal();
        setConflict(null);
        setAutosaveHold(false);
        flash(`已恢复 v${revision} 的内容，并保存为新版本 v${res.revision}`);
        const { entries } = await api.listSceneHistory(sceneId);
        setHistoryEntries(entries);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          flash("恢复失败：服务端已被其他会话修改，请刷新页面后重试");
          api.listSceneHistory(sceneId).then(({ entries }) => setHistoryEntries(entries)).catch(() => {});
        } else if (e instanceof ApiError && e.status === 404) {
          flash("恢复失败：该历史版本不存在或已损坏");
        } else {
          flash(`恢复失败：${e instanceof Error ? e.message : "服务端不可用"}`);
        }
      } finally {
        setRestoring(null);
      }
    },
    [sceneId, restoring, setScene, markSaved, mirrorToLocal, flash]
  );

  // 快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      const st = useEditorStore.getState();
      if (e.key === "z" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (e.shiftKey) st.redo(); else st.undo();
      } else if ((e.key === "Delete" || e.key === "Backspace") && st.selectedId) {
        e.preventDefault();
        st.removeObject(st.selectedId!);
      } else if (e.key === "d" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        st.duplicateSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 健康检查
  useEffect(() => {
    const tick = () => api.health().then(setHealth).catch(() => setHealth(null));
    tick();
    const iv = setInterval(tick, 15000);
    return () => clearInterval(iv);
  }, []);

  const handleExport = () => {
    if (!scene) return;
    const blob = new Blob([JSON.stringify(scene, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `miniverse-${scene.metadata.name}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = async (file: File) => {
    try {
      const result = loadSceneJson(JSON.parse(await file.text()));
      flash(result.ok ? "场景导入成功" : `导入失败：${result.error}`);
    } catch {
      flash("导入失败：不是合法的 JSON 文件");
    }
  };

  /** 重置为演示场景：二次确认后清空并自动写回服务端 */
  const handleReset = () => {
    if (loadSource === "local") return;
    if (!window.confirm("确定重置为演示场景？当前场景的全部家具与重建背景都会被清空，并替换为内置演示场景，改动将在 1.2 秒后自动写入服务端。")) return;
    pushHistory();
    resetToDemo();
  };

  /** 打开导入文件选择器：ref 只在事件回调里读，不在渲染期访问 */
  const openImportPicker = useCallback(() => fileInputRef.current?.click(), []);

  /** 窄屏折叠进「更多」的次级操作：桌面态与折叠菜单共用同一份定义，避免两处行为漂移 */
  const secondaryActions: {
    key: string;
    label: string;
    icon: typeof CloudUpload;
    title: string;
    href?: string;
    onClick?: () => void;
    disabled?: boolean;
    style?: CSSProperties;
  }[] = [
    {
      key: "recon",
      label: "照片重建",
      icon: CloudUpload,
      title: "上传照片创建重建任务",
      href: "/reconstructions",
      style: { color: "#67e8f9", borderColor: "rgba(34,211,238,0.2)" },
    },
    {
      key: "history",
      label: "历史版本",
      icon: History,
      title: "查看该场景的历史版本并恢复",
      onClick: () => (historyOpen ? setHistoryOpen(false) : void openHistory()),
      style: historyOpen ? { color: "#c4b5fd", borderColor: "rgba(139,92,246,0.35)" } : undefined,
    },
    { key: "export", label: "导出", icon: Download, title: "导出当前场景 JSON", onClick: handleExport },
    { key: "import", label: "导入", icon: Upload, title: "导入场景 JSON" },
    {
      key: "reset",
      label: "重置",
      icon: RotateCcw,
      title: loadSource === "local" ? "只读模式：请用本地副本覆盖服务端" : "重置为演示场景",
      onClick: handleReset,
      disabled: loadSource === "local",
      style: { color: "#fbbf24", borderColor: "rgba(245,158,11,0.2)" },
    },
  ];
  const [moreOpen, setMoreOpen] = useState(false);

  const createNewScene = useCallback(async () => {
    if (creatingScene) return;
    setCreatingScene(true);
    setCreateError(null);
    try {
      const { scene: created } = await api.createScene("demo");
      router.push(`/editor/${created.sceneId}`);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "新建场景失败");
      setCreatingScene(false);
    }
  }, [creatingScene, router]);

  if (loadError) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-[#030712] text-slate-300">
        <div
          className="flex flex-col items-center gap-3 rounded-2xl px-8 py-6"
          style={{
            background: "rgba(10,15,30,0.9)",
            border: "1px solid rgba(248,113,113,0.25)",
            boxShadow: "0 0 30px rgba(248,113,113,0.1)",
          }}
        >
          <p className="text-sm text-red-400">{loadError}</p>
          {createError && <p className="text-[11px] text-red-400">{createError}</p>}
          <div className="flex items-center gap-2">
            <button
              className="btn-accent disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void createNewScene()}
              disabled={creatingScene}
            >
              {creatingScene ? "正在新建…" : "新建一个场景"}
            </button>
            <Link href="/reconstructions" className="btn-ghost">
              返回任务列表
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const isGaussian = scene?.reconstruction.format === "gaussian-splat" && !!scene.reconstruction.url;
  /** 视角预设依赖高斯包围帧：点云未就绪前禁用，避免点了没反应 */
  const splatReady = !isGaussian || splatLoad === "ready";

  return (
    <div className="flex h-screen flex-col" style={{ background: "#030712" }}>
      {/* ── 顶部栏 ── */}
      <header
        className="mv-topbar relative flex items-center gap-2 px-3 py-0 shrink-0"
        style={{
          height: "var(--topbar-height, 44px)",
          background: "rgba(8,13,26,0.95)",
          borderBottom: "1px solid rgba(139,92,246,0.15)",
          backdropFilter: "blur(20px)",
          boxShadow: "0 1px 0 rgba(139,92,246,0.08), 0 4px 20px rgba(0,0,0,0.4)",
          zIndex: 50,
        }}
      >
        {/* Logo + 面包屑 */}
        <Link href="/" className="flex items-center gap-2 shrink-0 mr-1">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" style={{ filter: "drop-shadow(0 0 6px rgba(168,85,247,0.7))" }}>
            <path d="M3 7l9-4 9 4v10l-9 4-9-4V7z" stroke="url(#hGrad)" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M12 3v18M3 7l9 4 9-4" stroke="url(#hGrad)" strokeWidth="1.5" strokeLinejoin="round" />
            <defs>
              <linearGradient id="hGrad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
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

        {/* 分隔 */}
        <span className="text-slate-700 text-xs mx-1">/</span>

        {/* 场景名称输入 */}
        <input
          value={scene?.metadata.name ?? ""}
          onChange={(e) => updateMetadata({ name: e.target.value })}
          className="w-36 rounded-md px-2 py-1 text-xs text-slate-200 transition focus:outline-none"
          style={{
            background: "rgba(15,23,42,0.5)",
            border: "1px solid rgba(51,65,85,0.4)",
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = "rgba(168,85,247,0.5)";
            e.currentTarget.style.boxShadow = "0 0 8px rgba(168,85,247,0.2)";
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = "rgba(51,65,85,0.4)";
            e.currentTarget.style.boxShadow = "none";
          }}
          placeholder="场景名称"
        />

        {/* 标签 */}
        {scene?.metadata.demo && (
          <span
            className="rounded-full px-2 py-0.5 text-[9px] font-semibold"
            style={{ background: "rgba(245,158,11,0.15)", color: "#fbbf24", border: "1px solid rgba(245,158,11,0.25)" }}
          >
            演示
          </span>
        )}
        {scene?.reconstruction.synthetic && (
          <span
            className="rounded-full px-2 py-0.5 text-[9px] font-semibold"
            style={{ background: "rgba(34,211,238,0.12)", color: "#67e8f9", border: "1px solid rgba(34,211,238,0.2)" }}
          >
            程序生成
          </span>
        )}

        {/* 竖线 */}
        <div className="mx-1 h-5 w-px" style={{ background: "rgba(139,92,246,0.2)" }} />

        {/* 撤销/重做 */}
        <button className="btn-ghost" onClick={undo} disabled={past.length === 0} title="Ctrl+Z">
          <Undo2 size={12} /> 撤销
        </button>
        <button className="btn-ghost" onClick={redo} disabled={future.length === 0} title="Ctrl+Shift+Z">
          <Redo2 size={12} /> 重做
        </button>

        {/* 竖线 */}
        <div className="mx-1 h-5 w-px" style={{ background: "rgba(139,92,246,0.2)" }} />

        {/* Gizmo 按钮组 */}
        <div
          className="flex overflow-hidden rounded-lg"
          style={{ border: "1px solid rgba(139,92,246,0.2)" }}
        >
          {(
            [
              ["translate", Move, "移动", "W"],
              ["rotate", RotateCw, "旋转", "E"],
              ["scale", Maximize2, "缩放", "R"],
            ] as const
          ).map(([mode, Icon, label]) => (
            <button
              key={mode}
              onClick={() => setGizmoMode(mode)}
              title={label}
              style={
                gizmoMode === mode
                  ? {
                      background: "linear-gradient(135deg, rgba(99,102,241,0.5), rgba(168,85,247,0.4))",
                      color: "#c4b5fd",
                      boxShadow: "inset 0 0 12px rgba(168,85,247,0.2)",
                      borderRight: "1px solid rgba(139,92,246,0.25)",
                    }
                  : {
                      background: "rgba(15,23,42,0.4)",
                      color: "#64748b",
                      borderRight: "1px solid rgba(51,65,85,0.3)",
                    }
              }
              className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium transition-all duration-150 hover:text-slate-200"
            >
              <Icon size={11} /> {label}
            </button>
          ))}
        </div>

        {/* 视图预设（高斯背景激活时显示）*/}
        {isGaussian && (
          <div
            className="flex overflow-hidden rounded-lg"
            style={{ border: "1px solid rgba(34,211,238,0.2)" }}
          >
            {(
              [
                ["inside", "环视"],
                ["model360", "360°"],
                ["front", "正视"],
                ["side", "侧视"],
                ["top", "顶视"],
              ] as [ViewPreset, string][]
            ).map(([preset, label]) => {
              const active =
                (preset === "inside" && viewMode === "inside") ||
                (preset !== "inside" && viewMode === "model");
              return (
                <button
                  key={preset}
                  onClick={() => requestView(preset)}
                  disabled={!splatReady}
                  title={
                    splatReady
                      ? `${label}视角`
                      : "高斯背景还在加载，加载完成后即可使用"
                  }
                  style={
                    active
                      ? {
                          background: "linear-gradient(135deg, rgba(6,182,212,0.4), rgba(34,211,238,0.25))",
                          color: "#67e8f9",
                          boxShadow: "inset 0 0 10px rgba(34,211,238,0.15)",
                          borderRight: "1px solid rgba(34,211,238,0.2)",
                        }
                      : {
                          background: "rgba(15,23,42,0.4)",
                          color: "#164e63",
                          borderRight: "1px solid rgba(8,145,178,0.15)",
                        }
                  }
                  className="px-2.5 py-1.5 text-[10px] font-medium transition-all duration-150 hover:text-cyan-300 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:text-inherit"
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}

        {/* 右侧操作区 */}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            className="btn-ghost"
            style={
              previewMode
                ? {
                    background: "linear-gradient(135deg, rgba(168,85,247,0.25), rgba(245,158,11,0.15))",
                    color: "#c4b5fd",
                    border: "1px solid rgba(168,85,247,0.3)",
                    boxShadow: "0 0 10px rgba(168,85,247,0.2)",
                  }
                : {}
            }
            onClick={() => setPreviewMode(!previewMode)}
            title="预览模式：隐藏编辑 UI (P)"
          >
            {previewMode ? <Pencil size={12} /> : <Play size={12} />}
            {previewMode ? "退出预览" : "预览"}
          </button>

          <Link
            href="/reconstructions"
            className="btn-ghost mv-topbar-secondary"
            style={{ color: "#67e8f9", borderColor: "rgba(34,211,238,0.2)" }}
          >
            <CloudUpload size={12} /> 照片重建
          </Link>

          <button
            className="btn-ghost"
            disabled={loadSource === "local" || conflict !== null || saveState.status === "saving"}
            title={
              conflict
                ? "请先处理右下角的保存冲突"
                : loadSource === "local"
                  ? "只读模式：请用本地副本覆盖服务端"
                  : "立即保存到服务端"
            }
            onClick={() => void retrySave()}
          >
            {saveState.status === "saving" ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Save size={12} />
            )}{" "}
            保存
          </button>
          {/* 次级操作：宽屏平铺，≤1100px 折叠进「更多」，避免 820px 时按钮被裁到屏幕外 */}
          <div className="mv-topbar-secondary flex items-center gap-1.5">
            {secondaryActions
              .filter((a) => a.key !== "recon")
              .map((a) => {
                const Icon = a.icon;
                return (
                  <button
                    key={a.key}
                    className="btn-ghost"
                    disabled={a.disabled}
                    title={a.title}
                    style={a.style}
                    onClick={a.key === "import" ? openImportPicker : a.onClick}
                  >
                    <Icon size={12} /> {a.label}
                  </button>
                );
              })}
          </div>

          <div className="mv-topbar-more relative">
            <button
              className="btn-ghost"
              title="更多操作"
              onClick={() => setMoreOpen((v) => !v)}
              style={moreOpen ? { color: "#c4b5fd", borderColor: "rgba(168,85,247,0.35)" } : {}}
            >
              <MoreHorizontal size={12} /> 更多
            </button>
            {moreOpen && (
              <div
                className="absolute right-0 top-full z-50 mt-1 flex w-40 flex-col gap-1 rounded-lg p-1.5"
                style={{
                  background: "rgba(8,13,26,0.98)",
                  border: "1px solid rgba(139,92,246,0.25)",
                  boxShadow: "0 12px 30px rgba(0,0,0,0.5)",
                }}
              >
                {secondaryActions.map((a) => {
                  const Icon = a.icon;
                  const inner = (
                    <>
                      <Icon size={12} /> {a.label}
                    </>
                  );
                  return a.href ? (
                    <Link
                      key={a.key}
                      href={a.href}
                      className="btn-ghost justify-start"
                      title={a.title}
                      onClick={() => setMoreOpen(false)}
                    >
                      {inner}
                    </Link>
                  ) : (
                    <button
                      key={a.key}
                      className="btn-ghost justify-start"
                      disabled={a.disabled}
                      title={a.title}
                      onClick={() => {
                        setMoreOpen(false);
                        if (a.key === "import") openImportPicker();
                        else a.onClick?.();
                      }}
                    >
                      {inner}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleImport(f);
              e.target.value = "";
            }}
          />
        </div>
      </header>

      {/* ── 只读本地副本提示条（读失败回退时出现，回写需用户显式确认） ── */}
      {loadSource === "local" && loadFailure && (
        <div
          className="flex shrink-0 items-center gap-2 px-3 py-1.5 text-[10px]"
          style={{
            background: "rgba(245,158,11,0.08)",
            borderBottom: "1px solid rgba(245,158,11,0.2)",
            color: "#fbbf24",
          }}
        >
          <HardDrive size={11} style={{ color: "#fbbf24" }} />
          <span>
            {loadFailure === "missing"
              ? "场景已不存在，可手动用本地副本重建"
              : "服务端暂不可用，已载入本地副本（只读）"}
          </span>
          <button
            className="btn-ghost ml-1"
            style={{ color: "#fbbf24", borderColor: "rgba(245,158,11,0.3)" }}
            onClick={handleOverwriteServer}
          >
            用本地副本覆盖服务端
          </button>
        </div>
      )}

      {/* ── 主体三栏 ── */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* 左侧面板 */}
        {!previewMode && (
          <aside
            className="shrink-0 transition-all duration-200"
            style={{
              width: leftCollapsed ? 0 : 224,
              overflow: "hidden",
              borderRight: "1px solid rgba(139,92,246,0.12)",
              position: "relative",
            }}
          >
            <div style={{ width: 224, height: "100%" }}>
              <LeftPanel />
            </div>
            {/* 折叠按钮 */}
            <button
              onClick={() => setLeftCollapsed((v) => !v)}
              style={{
                position: "absolute",
                right: -12,
                top: "50%",
                transform: "translateY(-50%)",
                zIndex: 10,
                width: 24,
                height: 40,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(10,15,30,0.95)",
                border: "1px solid rgba(139,92,246,0.2)",
                borderRadius: "0 6px 6px 0",
                color: "#6366f1",
                cursor: "pointer",
                transition: "all 0.15s",
              }}
              title={leftCollapsed ? "展开素材库" : "折叠素材库"}
            >
              <ChevronLeft size={12} style={{ transform: leftCollapsed ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
            </button>
          </aside>
        )}

        {/* 折叠时显示展开按钮 */}
        {!previewMode && leftCollapsed && (
          <button
            onClick={() => setLeftCollapsed(false)}
            style={{
              position: "absolute",
              left: 0,
              top: "50%",
              transform: "translateY(-50%)",
              zIndex: 10,
              width: 20,
              height: 40,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(10,15,30,0.95)",
              border: "1px solid rgba(139,92,246,0.2)",
              borderRadius: "0 6px 6px 0",
              color: "#6366f1",
              cursor: "pointer",
            }}
          >
            <ChevronLeft size={12} style={{ transform: "rotate(180deg)" }} />
          </button>
        )}

        {/* 画布主区 */}
        <main className="relative min-w-0 flex-1" style={{ background: "#030712" }}>
          {ready && <SceneCanvas />}

          {/* 保存状态常驻在视口右上角：不挤占 header（窄屏 header 会横向滚动），任何宽度都可见 */}
          <SaveStateChip
            state={saveState}
            onRetry={() => void retrySave()}
            className="absolute right-2 top-2 z-30"
          />

          {/* 高斯背景状态条 */}
          {isGaussian && (
            <div
              className="absolute left-3 top-3 z-10 flex items-center gap-2 rounded-xl px-3 py-2 text-[11px] mv-fade-in"
              style={{
                background: "rgba(8,13,26,0.88)",
                backdropFilter: "blur(20px)",
                border: "1px solid rgba(34,211,238,0.2)",
                boxShadow: "0 0 20px rgba(34,211,238,0.12), 0 4px 16px rgba(0,0,0,0.4)",
                color: "#67e8f9",
              }}
            >
              <Sparkles size={12} style={{ filter: "drop-shadow(0 0 4px rgba(34,211,238,0.7))" }} />
              <span>高斯重建背景{scene?.reconstruction.synthetic ? "（演示）" : ""}</span>

              {splatLoad === "loading" && (
                <span className="flex items-center gap-1.5" style={{ color: "#22d3ee" }}>
                  <Loader2 size={10} className="animate-spin" />
                  {splatProgress?.phase === "download" && splatProgress.percent !== null
                    ? `下载 ${splatProgress.percent}%`
                    : splatProgress?.phase === "parse"
                      ? "解析中…"
                      : "加载中…"}
                  {splatProgress?.phase === "download" && splatProgress.percent !== null && (
                    <span className="h-1 w-20 overflow-hidden rounded-full" style={{ background: "rgba(34,211,238,0.1)" }}>
                      <span
                        className="block h-full rounded-full transition-all duration-200"
                        style={{
                          width: `${splatProgress.percent}%`,
                          background: "linear-gradient(90deg, #06b6d4, #22d3ee)",
                          boxShadow: "0 0 6px rgba(34,211,238,0.6)",
                        }}
                      />
                    </span>
                  )}
                </span>
              )}
              {splatLoad === "error" && <span className="text-red-400">加载失败</span>}

              {scene?.reconstruction.taskId && (
                <Link
                  href={`/reconstructions/${scene.reconstruction.taskId}`}
                  className="text-slate-500 underline hover:text-slate-300 text-[10px]"
                >
                  任务详情
                </Link>
              )}
              <button
                disabled={loadSource === "local"}
                title={loadSource === "local" ? "只读模式：请用本地副本覆盖服务端" : "退出重建背景"}
                onClick={() => {
                  if (loadSource === "local") return;
                  // 会清空重建背景并自动写回服务端，必须二次确认
                  if (!window.confirm("确定退出重建背景？当前场景的高斯重建背景会被清空并恢复程序化房间外壳，改动将在 0.8 秒后自动写入服务端。")) return;
                  setReconstruction({ format: "none", url: null, status: "none", taskId: null });
                }}
                className="ml-1 rounded p-0.5 text-slate-500 transition hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
                style={{ lineHeight: 1 }}
              >
                <X size={12} />
              </button>
            </div>
          )}
        </main>

        {/* 右侧属性面板 */}
        {!previewMode && (
          <aside
            className="shrink-0 transition-all duration-200 relative"
            style={{
              width: rightCollapsed ? 0 : 256,
              overflow: "hidden",
              borderLeft: "1px solid rgba(139,92,246,0.12)",
            }}
          >
            <div style={{ width: 256, height: "100%" }}>
              <PropertiesPanel onCollapse={() => setRightCollapsed((v) => !v)} collapsed={rightCollapsed} />
            </div>
          </aside>
        )}

        {/* Toast 通知 */}
        {notice && (
          <div
            className="mv-toast absolute bottom-5 left-1/2 -translate-x-1/2 rounded-xl px-5 py-2.5 text-xs text-slate-100"
            style={{ zIndex: 100 }}
          >
            {notice}
          </div>
        )}
      </div>

      {/* ── 底部状态栏 ── */}
      <footer
        className="mv-statusbar flex items-center gap-4 px-3 shrink-0"
        style={{
          height: "var(--statusbar-height, 26px)",
          background: "rgba(8,13,26,0.95)",
          borderTop: "1px solid rgba(139,92,246,0.1)",
          fontSize: 10,
          color: "#475569",
        }}
      >
        {/* 存储状态 */}
        <span className="flex items-center gap-1.5">
          {loadSource === "local" ? (
            <>
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: "#fbbf24", boxShadow: "0 0 4px rgba(251,191,36,0.7)" }}
              />
              <HardDrive size={10} style={{ color: "#fbbf24" }} />
              <span style={{ color: "#fbbf24" }}>本地副本（只读）</span>
            </>
          ) : storageMode === "server" || (ready && loadSource === "server" && !sceneDirty) ? (
            <>
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: "#34d399", boxShadow: "0 0 4px rgba(52,211,153,0.7)" }}
              />
              <Database size={10} style={{ color: "#34d399" }} />
              <span style={{ color: "#34d399" }}>服务端已同步</span>
            </>
          ) : storageMode === "local" ? (
            <>
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{
                  background: saveState.status === "failed" ? "#f87171" : "#fbbf24",
                  boxShadow: `0 0 4px ${saveState.status === "failed" ? "rgba(248,113,113,0.7)" : "rgba(251,191,36,0.7)"}`,
                }}
              />
              <HardDrive size={10} style={{ color: saveState.status === "failed" ? "#f87171" : "#fbbf24" }} />
              <span style={{ color: saveState.status === "failed" ? "#f87171" : "#fbbf24" }}>
                {saveState.status === "failed" ? "保存失败（改动在本机）" : "本地缓存"}
              </span>
            </>
          ) : (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-slate-700" />
              <span>{autosaveHold ? "待保存（已暂停自动保存）" : "待保存"}</span>
            </>
          )}
          {savedAt && (
            <span className="text-slate-600">
              · {new Date(savedAt).toLocaleTimeString("zh-CN", { hour12: false })}
            </span>
          )}
        </span>

        <span className="text-slate-700">|</span>
        <span>场景 {sceneId.slice(0, 8)}…</span>
        <span>家具 {scene?.objects.length ?? 0} 件{selectedId ? " · 已选 1" : ""}</span>

        {scene?.reconstruction.format === "gaussian-splat" && (
          <span style={{ color: "#22d3ee" }}>高斯背景{scene.reconstruction.synthetic ? "（演示）" : ""}</span>
        )}

        {/* 右侧：重建环境状态。只如实报告实际检查项（health 仅探测 Python 解释器），
            不把「找到 python」说成「GPU 就绪」；悬停给出实际检测范围。 */}
        <span className="ml-auto flex items-center gap-3">
          <span
            className="flex items-center gap-1.5"
            title={
              health?.python
                ? `实际检测项：Python 3 解释器（${health.python}）。GPU、CUDA 与训练依赖未检测，不代表重建一定能跑。`
                : "实际检测项：未找到可用的 Python 3 解释器（python / py -3）。重建任务无法在本机启动。"
            }
          >
            {health?.python ? (
              <>
                <Cpu size={9} style={{ color: "#34d399" }} />
                <span style={{ color: "#34d399" }}>重建环境：Python 可用</span>
              </>
            ) : (
              <>
                <WifiOff size={9} style={{ color: "#f59e0b" }} />
                <span style={{ color: "#f59e0b" }}>重建环境：未配置</span>
              </>
            )}
          </span>
          {health && health.taskCount > 0 && (
            <Link href="/reconstructions" className="flex items-center gap-1 hover:underline" style={{ color: "#38bdf8" }}>
              {/* 跳动点表示运行中 */}
              {health.workerBusy && (
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: "#38bdf8", animation: "mv-dot-blink 1s ease-in-out infinite" }}
                />
              )}
              重建任务 {health.taskCount} 个{health.workerBusy ? " · 运行中" : ""}
            </Link>
          )}
        </span>
      </footer>

      {/* 历史版本面板：只读列表，恢复走 CAS 追加为新版本（不改写历史） */}
      {historyOpen && (
        <div className="mv-history fixed right-4 top-14 z-40 flex max-h-[60vh] w-[26rem] flex-col rounded-lg border border-slate-700 bg-slate-900 shadow-2xl">
          <div className="flex items-center gap-2 border-b border-slate-700/60 px-4 py-2.5">
            <History size={13} style={{ color: "#c4b5fd" }} />
            <span className="text-xs font-semibold text-slate-200">历史版本</span>
            <button
              className="ml-auto rounded p-0.5 text-slate-500 transition hover:text-slate-200"
              onClick={() => setHistoryOpen(false)}
              title="关闭"
            >
              <X size={13} />
            </button>
          </div>
          <div className="px-4 py-2 text-[10px] leading-relaxed text-slate-500">
            每次覆盖写入前自动快照，最多保留最近 20 份。恢复会以当前版本号为基线追加为新版本，不改写历史。
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {historyLoading ? (
              <div className="flex items-center gap-2 px-2 py-3 text-[11px] text-slate-400">
                <Loader2 size={11} className="animate-spin" /> 读取中…
              </div>
            ) : !historyEntries || historyEntries.length === 0 ? (
              <div className="px-2 py-3 text-[11px] text-slate-500">暂无历史版本（尚未发生过覆盖写入）</div>
            ) : (
              historyEntries.map((entry) => (
                <div
                  key={entry.revision}
                  className="mb-1 flex items-center gap-2 rounded px-2 py-1.5 transition hover:bg-slate-800/60"
                >
                  <span
                    className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-mono"
                    style={{ background: "rgba(139,92,246,0.15)", color: "#c4b5fd" }}
                  >
                    v{entry.revision}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] text-slate-300">
                      {entry.objectCount} 件家具 · {entry.name}
                    </div>
                    <div className="text-[10px] text-slate-500">
                      {new Date(entry.updatedAt).toLocaleString("zh-CN", { hour12: false })}
                    </div>
                  </div>
                  <button
                    className="shrink-0 rounded border border-slate-600 px-2 py-1 text-[10px] text-slate-300 transition hover:bg-slate-700/40 disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={loadSource === "local" || conflict !== null || restoring !== null}
                    title={
                      loadSource === "local"
                        ? "只读模式：请先用本地副本覆盖服务端"
                        : conflict
                          ? "请先处理保存冲突"
                          : "恢复该版本（追加为新版本）"
                    }
                    onClick={() => void restoreHistory(entry.revision)}
                  >
                    {restoring === entry.revision ? "恢复中…" : "恢复"}
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* 保存冲突：非模态浮层，三选项，绝不静默失败；处理前仍可继续编辑（自动保存已暂停） */}
      {conflict && (
        <div className="mv-conflict fixed bottom-4 right-4 z-50 w-[24rem] rounded-lg border border-amber-500/40 bg-slate-900 p-5 shadow-2xl">
          <div className="mb-2 text-sm font-semibold" style={{ color: "#fbbf24" }}>
            这个场景刚被别处改过
          </div>
          <div className="mb-4 text-xs leading-relaxed text-slate-400">
            你打开之后，另一个窗口或设备保存了这个场景。为了不把对方的改动冲掉，
            <span style={{ color: "#f87171" }}>你刚才的修改还没有存进去</span>。
            你仍然可以继续编辑，只是自动保存暂时停住了。请选一种处理方式：
          </div>
          <div className="flex flex-col gap-2">
            <button
              className="rounded border border-sky-500/40 px-3 py-2 text-left transition hover:bg-sky-500/10"
              onClick={resolveConflictUseServer}
            >
              <span className="block text-xs text-sky-300">用对方的版本（我的改动会消失）</span>
              <span className="mt-0.5 block text-[10px] leading-relaxed text-slate-400">
                页面会切换成对方保存的样子；你这边现在的改动全部丢弃，且无法撤销。
              </span>
            </button>
            <button
              className="rounded border border-amber-500/40 px-3 py-2 text-left transition hover:bg-amber-500/10"
              onClick={resolveConflictUseMine}
            >
              <span className="block text-xs text-amber-300">保留我的版本（对方刚存的改动会被替换）</span>
              <span className="mt-0.5 block text-[10px] leading-relaxed text-slate-400">
                服务端会存成你现在的画面；对方刚保存的内容被覆盖，对方不会收到提醒。
              </span>
            </button>
            <button
              className="rounded border border-slate-600 px-3 py-2 text-left transition hover:bg-slate-700/30"
              onClick={resolveConflictCancel}
            >
              <span className="block text-xs text-slate-300">先不处理，继续编辑</span>
              <span className="mt-0.5 block text-[10px] leading-relaxed text-slate-400">
                你的改动留在当前页面，自动保存保持暂停；之后可以再点「保存」重新决定，关掉页面则可能丢失。
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
