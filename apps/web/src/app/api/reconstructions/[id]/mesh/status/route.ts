import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { reconstructionDir, taskDir } from "@/lib/server/paths";
import { getTaskStore } from "@/lib/server/task-store";
import { syncTaskFromWorker } from "@/lib/server/status-sync";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 网格状态的唯一判定入口（前端不再靠 HEAD 探测猜）。
 *
 * state:
 *   ready   产物已就绪（mesh.glb 存在）
 *   running 正在单独重试网格
 *   failed  生成失败，带 error
 *   missing 任务开了网格但还没有产物，也没有失败记录
 *   absent  任务没开网格
 */
type MeshState = "ready" | "running" | "failed" | "missing" | "absent";

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  syncTaskFromWorker(id);
  const task = getTaskStore().get(id);
  if (!task) return NextResponse.json({ error: "任务不存在" }, { status: 404 });

  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(task.params || "{}");
  } catch {
    // params 损坏按未开网格处理
  }

  let meshResult: { error?: string } | null = null;
  try {
    const result = task.result ? (JSON.parse(task.result) as { mesh?: { error?: string } }) : null;
    meshResult = result?.mesh ?? null;
  } catch {
    // result 损坏按无网格记录处理
  }

  const glb = path.join(reconstructionDir(id), "mesh.glb");
  const glbBytes = fs.existsSync(glb) ? fs.statSync(glb).size : 0;

  // 单独重试的进度/错误单独落盘（见 services/reconstruction/app/worker.py::run_mesh_only）
  let retry: { status?: string; error?: string } | null = null;
  try {
    retry = JSON.parse(fs.readFileSync(path.join(taskDir(id), "mesh-status.json"), "utf8"));
  } catch {
    // 没有重试记录
  }

  const requested = params.exportMesh === true || meshResult !== null;

  let state: MeshState = "absent";
  let error: string | null = null;
  if (glbBytes > 0) {
    state = "ready";
  } else if (retry?.status === "processing") {
    state = "running";
  } else if (retry?.status === "failed") {
    state = "failed";
    error = retry.error || "网格生成失败（详见日志）";
  } else if (typeof meshResult?.error === "string" && meshResult.error) {
    state = "failed";
    error = meshResult.error;
  } else if (requested && task.status === "completed") {
    state = "missing";
  }

  return NextResponse.json({ state, error, requested, bytes: glbBytes });
}
