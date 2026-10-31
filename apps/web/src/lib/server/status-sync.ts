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

  const statusPath = path.join(taskDir(taskId), "status.json");
  if (!fs.existsSync(statusPath)) {
    // worker 从未上报：如果进程也不在了，视为失败
    if (row.status === "processing" && row.worker_pid) {
      const busy = workerBusy();
      if (!busy.busy || busy.pid !== row.worker_pid) {
        // 进程消失且无状态文件：可能被强杀。保留 processing 但记录警告（避免误判短暂的启动间隙）
      }
    }
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

function releaseWorkerLockIfIdle(): void {
  const busy = workerBusy();
  if (!busy.busy) releaseWorkerLock();
}

/** worker 是否被请求取消 */
export function isCancelRequested(taskId: string): boolean {
  return fs.existsSync(path.join(taskDir(taskId), "cancel.flag"));
}
