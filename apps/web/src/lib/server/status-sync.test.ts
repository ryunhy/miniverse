import fs from "node:fs";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "./task-store";

// status-sync 依赖三个单例依赖：taskDir（数据目录）、getTaskStore（任务库）、
// worker-spawn（进程锁）。全部替换为临时目录/真实 TaskStore/无锁桩，
// 走真实代码路径（卡 #700127：worker 已写 failed 而派发记录丢失时，首次同步要能落 failed）。

let dir: string;
let taskRoot: string;
let store: TaskStore;

vi.mock("./paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paths")>();
  return { ...actual, taskDir: (id: string) => path.join(taskRoot, id) };
});

vi.mock("./task-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./task-store")>();
  return { ...actual, getTaskStore: () => store };
});

vi.mock("./worker-spawn", () => ({
  workerBusy: () => ({ busy: false, pid: null }),
  releaseWorkerLock: () => {},
  releaseWorkerLockIfIdle: () => {},
  spawnReconstructionWorker: () => ({ ok: false, error: "已有重建任务在运行" }),
}));

const { syncTaskFromWorker } = await import("./status-sync");
const { POST: retryReconstruction } = await import("@/app/api/reconstructions/[id]/retry/route");

function makeTask(id: string, row: { id: string; status: string; photo_count: number; worker_pid?: number }) {
  store.create(row.id, {}, row.photo_count);
  if (row.status !== "pending") store.transition(row.id, row.status as never);
  if (row.worker_pid) store.setWorkerPid(row.id, row.worker_pid);
  const d = path.join(taskRoot, id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "miniverse-status-sync-"));
  taskRoot = path.join(dir, "tasks");
  fs.mkdirSync(taskRoot, { recursive: true });
  store = new TaskStore(path.join(dir, "tasks.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("status-sync：派发记录丢失时首次同步落终态（卡 #700127）", () => {
  it("row=pending 而 status.json=failed → 同步后落 failed 并保留错误原因（修复前永远卡 pending）", () => {
    const id = "t-pending-failed";
    const d = makeTask(id, { id, status: "pending", photo_count: 3 });
    writeFileSync(path.join(d, "status.json"), JSON.stringify({ status: "failed", error: "COLMAP 注册率不足" }));

    syncTaskFromWorker(id);

    const row = store.get(id)!;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("COLMAP 注册率不足");
  });

  it("row=pending 而 status.json=completed → 同步后落 completed（原行为保持）", () => {
    const id = "t-pending-completed";
    const d = makeTask(id, { id, status: "pending", photo_count: 3 });
    writeFileSync(path.join(d, "status.json"), JSON.stringify({ status: "completed", result: { ok: 1 } }));

    syncTaskFromWorker(id);

    expect(store.get(id)!.status).toBe("completed");
  });

  it("row=processing 且进程已消失、心跳过期 → failed（真机中断收敛路径）", () => {
    const id = "t-processing-dead";
    const d = makeTask(id, { id, status: "processing", photo_count: 3, worker_pid: 999999 });
    // 心跳制造为 30 分钟前（STALE_MS 默认 10 分钟）
    const old = new Date(Date.now() - 30 * 60 * 1000);
    writeFileSync(path.join(d, "status.json"), JSON.stringify({ status: "processing", stage: "train" }));
    utimesSync(path.join(d, "status.json"), old, old);
    writeFileSync(path.join(d, "input.json"), "{}");
    utimesSync(path.join(d, "input.json"), old, old);

    syncTaskFromWorker(id);

    const row = store.get(id)!;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("worker 异常退出");
  });

  it("失败任务重试但 worker 忙时，旧的 failed 上报不会把新一轮排队变回失败", async () => {
    const id = "t-retry-queued";
    const d = makeTask(id, { id, status: "failed", photo_count: 3, worker_pid: 999999 });
    writeFileSync(path.join(d, "status.json"), JSON.stringify({ status: "failed", error: "上次失败" }));

    const response = await retryReconstruction(new Request("http://localhost", { method: "POST" }), {
      params: Promise.resolve({ id }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).workerStarted).toBe(false);
    syncTaskFromWorker(id);

    expect(store.get(id)).toMatchObject({ status: "pending", attempts: 1, worker_pid: null, error: null });
  });

  it("row=completed 是终态：不再被 status.json 覆盖", () => {
    const id = "t-terminal";
    const d = makeTask(id, { id, status: "completed", photo_count: 3 });
    writeFileSync(path.join(d, "status.json"), JSON.stringify({ status: "processing", stage: "train" }));

    syncTaskFromWorker(id);

    expect(store.get(id)!.status).toBe("completed");
  });
});
