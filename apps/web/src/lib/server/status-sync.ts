import fs from "node:fs";
import path from "node:path";
import { taskDir } from "./paths";
import { getTaskStore } from "./task-store";
import { releaseWorkerLock, workerBusy } from "./worker-spawn";

/**
 * Web 端 ↔ Python worker 的状态同步。
 * worker 每个阶段写 data/tasks/<id>/status.json：
 * { status: processing|completed|failed|canceled, stage, progress, error?, result? }
 * Web 端在读取任务时懒同步进 SQLite（以文件为准）。
 */

interface WorkerStatus {
  status: "processing" | "completed" | "failed" | "canceled";
  stage?: string;
  progress?: number;
  error?: string;
  result?: Record<string, unknown>;
  updated_at?: string;
}

export function syncTaskFromWorker(taskId: string): void {
  const store = getTaskStore();
  const row = store.get(taskId);
  if (!row) return;
  if (row.status === "completed" || row.status === "canceled") return;

  // 进程已消失且心跳过期 → 直接判失败，不再依赖 status.json 是否还在
  if (failIfWorkerGone(taskId, row)) return;

  const statusPath = path.join(taskDir(taskId), "status.json");
  if (!fs.existsSync(statusPath)) {
    // worker 从未上报：进程还活着或仍在启动窗口内，继续等
    return;
  }

  let ws: WorkerStatus;
  try {
    ws = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  } catch {
    return;
  }

  try {
    // 早前守卫已排除 completed/canceled 终态
    if (ws.status === "completed") {
      store.transition(taskId, "completed", { result: ws.result ?? {}, error: null });
      releaseWorkerLockIfIdle();
    } else if (ws.status === "failed") {
      store.transition(taskId, "failed", { error: ws.error || "重建失败（详见日志）" });
      releaseWorkerLockIfIdle();
    } else if (ws.status === "canceled") {
      store.transition(taskId, "canceled");
      releaseWorkerLockIfIdle();
    } else if (ws.status === "processing" && row.status === "pending") {
      store.transition(taskId, "processing");
    }
  } catch {
    // 状态流转冲突（并发同步）忽略，下次读取再试
  }
}

/**
 * worker 超过该时长没有任何状态上报，且进程已消失 → 判定为异常退出。
 * 可用 MINIVERSE_STALE_MS 环境变量覆盖（毫秒，测试/真机中断演练用；卡 #700127）。
 */
const DEFAULT_STALE_MS = 10 * 60 * 1000;
const configuredStaleMs = Number(process.env.MINIVERSE_STALE_MS);
const STALE_MS = Number.isFinite(configuredStaleMs) && configuredStaleMs > 0
  ? configuredStaleMs
  : DEFAULT_STALE_MS;

/** 最近一次心跳：status.json 优先，回退 input.json（worker 启动后尚未上报时） */
function lastHeartbeatMs(taskId: string): number | null {
  let latest = 0;
  for (const name of ["status.json", "input.json"]) {
    try {
      latest = Math.max(latest, fs.statSync(path.join(taskDir(taskId), name)).mtimeMs);
    } catch {
      // 文件不存在
    }
  }
  return latest > 0 ? latest : null;
}

/**
 * 卡死判定（读取时懒同步，不引入常驻后台任务）：
 * 任务仍是 processing，但记录的 worker 进程已不在，且心跳超过 10 分钟没更新，
 * 说明 worker 被强杀 / 崩溃后没来得及上报，按 failed 收敛。
 *
 * 训练阶段可能长时间不写 status.json（一次 15 分钟以上），所以进程存活时一律不判失败。
 */
function failIfWorkerGone(taskId: string, row: { status: string; worker_pid: number | null }): boolean {
  if (row.status !== "processing") return false;
  if (row.worker_pid) {
    const busy = workerBusy();
    if (busy.busy && busy.pid === row.worker_pid) return false;
  }
  const beat = lastHeartbeatMs(taskId);
  if (beat === null || Date.now() - beat < STALE_MS) return false;
  try {
    getTaskStore().transition(taskId, "failed", { error: "worker 异常退出" });
  } catch {
    return false; // 并发同步已流转，忽略
  }
  releaseWorkerLockIfIdle();
  return true;
}

function releaseWorkerLockIfIdle(): void {
  const busy = workerBusy();
  if (!busy.busy) releaseWorkerLock();
}

/** worker 是否被请求取消 */
export function isCancelRequested(taskId: string): boolean {
  return fs.existsSync(path.join(taskDir(taskId), "cancel.flag"));
}
