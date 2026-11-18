import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { reconstructionDir, taskDir } from "@/lib/server/paths";
import { getTaskStore } from "@/lib/server/task-store";
import { syncTaskFromWorker } from "@/lib/server/status-sync";
import { resolveMeshStatus, type MeshState } from "@/lib/server/mesh-status";

type Ctx = { params: Promise<{ id: string }> };

export type { MeshState };

/**
 * 网格状态的唯一判定入口（前端不再靠 HEAD 探测猜）。
 *
 * state:
 *   ready   产物已就绪（mesh.glb 存在）
 *   running 正在生成网格，phase 区分「整链路跑到网格阶段」与「单独重试网格」
 *   failed  生成失败，带 error
 *   missing 任务开了网格但还没有产物，也没有失败记录
 *   absent  任务没开网格
 *
 * 判定规则本身在 lib/server/mesh-status.ts（纯函数，有单测）。
 */
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

  // 整链路的阶段：worker 在 status.json 里写 stage，网格段为 "mesh"
  let workerStage: string | null = null;
  try {
    const st = JSON.parse(fs.readFileSync(path.join(taskDir(id), "status.json"), "utf8")) as { stage?: unknown };
    workerStage = typeof st.stage === "string" ? st.stage : null;
  } catch {
    // 任务还没写 status.json
  }

  // 单独重试的进度/错误单独落盘（见 services/reconstruction/app/worker.py::run_mesh_only）
  let retry: { status?: string; error?: string } | null = null;
  try {
    retry = JSON.parse(fs.readFileSync(path.join(taskDir(id), "mesh-status.json"), "utf8"));
  } catch {
    // 没有重试记录
  }

  const requested = params.exportMesh === true || meshResult !== null;
  const meshError = typeof meshResult?.error === "string" && meshResult.error ? meshResult.error : null;

  const { state, error, phase } = resolveMeshStatus({
    glbBytes,
    requested,
    taskStatus: task.status,
    workerStage,
    retryStatus: retry?.status ?? null,
    retryError: retry?.error ?? null,
    meshError,
  });

  return NextResponse.json({ state, error, requested, bytes: glbBytes, phase });
}
