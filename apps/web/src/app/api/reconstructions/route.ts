import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getTaskStore } from "@/lib/server/task-store";
import { validateAndSavePhotos, UploadError } from "@/lib/server/uploads";
import { spawnReconstructionWorker, workerBusy } from "@/lib/server/worker-spawn";
import { syncTaskFromWorker } from "@/lib/server/status-sync";


export async function GET() {
  const store = getTaskStore();
  // 列表也要懒同步 worker 的 status.json，否则 worker 由外部（WSL/手工）运行时列表会一直停在 pending
  for (const task of store.list()) {
    if (task.status !== "completed" && task.status !== "canceled") {
      syncTaskFromWorker(task.id);
    }
  }
  const busy = workerBusy();
  // 附带 worker 占用情况：排队卡住时前端要能说清「前面还有任务」还是「Worker 没起来」
  return NextResponse.json({ tasks: store.list(), worker: { busy: busy.busy, pid: busy.pid ?? null } });
}

/**
 * 创建重建任务：multipart/form-data
 * photos: File[]（3~120 张，JPG/PNG/WebP，单张 ≤15MB）
 * params: 可选 JSON 字符串 { maxResolution?: number, steps?: number, exportMesh?: boolean }
 *   exportMesh=true 时 worker 会在高斯导出后追加网格导出（2DGS + 纹理烘焙）。
 */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const files = form.getAll("photos").filter((f): f is File => f instanceof File);
    let params: Record<string, unknown> = {};
    const rawParams = form.get("params");
    if (typeof rawParams === "string" && rawParams.trim()) {
      try {
        params = JSON.parse(rawParams);
      } catch {
        return NextResponse.json({ error: "params 不是合法 JSON" }, { status: 400 });
      }
      // 落盘前校验：params 会原样写进 data/tasks/<id>/input.json 并下发给 worker，
      // 类型错了 worker 侧只会按默认值静默忽略，用户看不到原因。
      if (params === null || typeof params !== "object" || Array.isArray(params)) {
        return NextResponse.json({ error: "params 必须是 JSON 对象" }, { status: 400 });
      }
      if (params.exportMesh !== undefined && typeof params.exportMesh !== "boolean") {
        return NextResponse.json({ error: "params.exportMesh 必须是布尔值" }, { status: 400 });
      }
    }

    const taskId = randomUUID();
    let savedPaths: string[] = [];
    try {
      savedPaths = await validateAndSavePhotos(files, taskId);
    } catch (e) {
      if (e instanceof UploadError) {
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
      throw e;
    }

    const store = getTaskStore();
    store.create(taskId, params, savedPaths.length);

    const spawnResult = spawnReconstructionWorker(taskId, params);
    if (!spawnResult.ok) {
      // 环境不满足：任务保持 pending（可稍后手动/重试执行），原因写入事件
      store.appendEvent(taskId, "warn", spawnResult.error ?? "Worker 未能启动");
    }

    const task = store.get(taskId)!;
    return NextResponse.json(
      { task, workerStarted: spawnResult.ok, workerError: spawnResult.error ?? null },
      { status: 201 }
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "创建任务失败" }, { status: 500 });
  }
}
