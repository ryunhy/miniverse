import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getTaskStore } from "@/lib/server/task-store";
import { validateAndSavePhotos, UploadError } from "@/lib/server/uploads";
import { spawnReconstructionWorker } from "@/lib/server/worker-spawn";
import { syncTaskFromWorker } from "@/lib/server/status-sync";


export async function GET() {
  const store = getTaskStore();
  // 列表也要懒同步 worker 的 status.json，否则 worker 由外部（WSL/手工）运行时列表会一直停在 pending
  for (const task of store.list()) {
    if (task.status !== "completed" && task.status !== "canceled") {
      syncTaskFromWorker(task.id);
    }
  }
  return NextResponse.json({ tasks: store.list() });
}

/**
 * 创建重建任务：multipart/form-data
 * photos: File[]（3~120 张，JPG/PNG/WebP，单张 ≤15MB）
 * params: 可选 JSON 字符串 { maxResolution?: number, steps?: number }
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
