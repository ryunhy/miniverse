import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { taskDir } from "@/lib/server/paths";
import { getTaskStore } from "@/lib/server/task-store";
import { spawnReconstructionWorker } from "@/lib/server/worker-spawn";
import { syncTaskFromWorker } from "@/lib/server/status-sync";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 仅重试网格：复用已完成任务的训练产物，只重跑网格导出那一段。
 * 通过 params.meshOnly 让 worker 走 run_mesh_only 分支，不重跑 COLMAP / 高斯训练。
 * 任务主状态保持 completed，进度与错误写 data/tasks/<id>/mesh-status.json。
 */
export async function POST(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const store = getTaskStore();
  syncTaskFromWorker(id);
  const task = store.get(id);
  if (!task) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  if (task.status !== "completed") {
    return NextResponse.json(
      { error: `任务未完成（当前状态: ${task.status}），请重试整个重建任务` },
      { status: 409 }
    );
  }

  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(task.params || "{}");
  } catch {
    // params 损坏时按默认参数重试网格
  }

  // spawnReconstructionWorker 会清掉主任务的 status.json（它是为整条重建链路设计的）。
  // 网格重试不写这个文件，先备份再还原，避免已完成任务的记录被删掉。
  const statusPath = path.join(taskDir(id), "status.json");
  const statusBackup = fs.existsSync(statusPath) ? fs.readFileSync(statusPath) : null;

  const spawnResult = spawnReconstructionWorker(id, { ...params, exportMesh: true, meshOnly: true });
  if (statusBackup) fs.writeFileSync(statusPath, statusBackup);

  if (!spawnResult.ok) {
    const message = spawnResult.error ?? "Worker 未能启动";
    store.appendEvent(id, "warn", `网格重试未启动：${message}`);
    return NextResponse.json({ error: message }, { status: 409 });
  }

  store.appendEvent(id, "info", "已开始仅重试网格导出（不重跑重建）");
  return NextResponse.json({ ok: true, workerStarted: true });
}
