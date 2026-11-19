import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { taskDir } from "@/lib/server/paths";
import { getTaskStore } from "@/lib/server/task-store";
import { spawnReconstructionWorker } from "@/lib/server/worker-spawn";


type Ctx = { params: Promise<{ id: string }> };

/**
 * 重新尝试 = 重新派发 worker，不重传照片、不改状态机。
 * - pending：只重新派发（排队卡住的自救出口），不累加尝试次数
 * - failed/canceled：先回到 pending，再派发（沿用原有重试上限）
 */
export async function POST(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const store = getTaskStore();
  const task = store.get(id);
  if (!task) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  try {
    const params = JSON.parse(task.params || "{}");
    if (task.status === "pending") {
      store.appendEvent(id, "info", "用户手动重新派发排队任务");
      const spawnResult = spawnReconstructionWorker(id, params);
      if (!spawnResult.ok) {
        store.appendEvent(id, "warn", spawnResult.error ?? "Worker 未能启动");
      }
      return NextResponse.json({
        task: store.get(id)!,
        workerStarted: spawnResult.ok,
        workerError: spawnResult.error ?? null,
      });
    }

    const retried = store.retry(id, () => {
      fs.rmSync(path.join(taskDir(id), "status.json"), { force: true });
    });
    const spawnResult = spawnReconstructionWorker(id, JSON.parse(retried.params || "{}"));
    if (!spawnResult.ok) {
      store.appendEvent(id, "warn", spawnResult.error ?? "Worker 未能启动");
    }
    return NextResponse.json({ task: store.get(id)!, workerStarted: spawnResult.ok, workerError: spawnResult.error ?? null });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "重试失败" }, { status: 400 });
  }
}
