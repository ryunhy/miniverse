import { NextResponse } from "next/server";
import { getTaskStore } from "@/lib/server/task-store";
import { spawnReconstructionWorker } from "@/lib/server/worker-spawn";


type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const store = getTaskStore();
  const task = store.get(id);
  if (!task) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  try {
    const retried = store.retry(id);
    const spawnResult = spawnReconstructionWorker(id, JSON.parse(retried.params || "{}"));
    if (!spawnResult.ok) {
      store.appendEvent(id, "warn", spawnResult.error ?? "Worker 未能启动");
    }
    return NextResponse.json({ task: store.get(id)!, workerStarted: spawnResult.ok, workerError: spawnResult.error ?? null });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "重试失败" }, { status: 400 });
  }
}
