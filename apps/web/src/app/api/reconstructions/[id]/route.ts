import { NextResponse } from "next/server";
import { getTaskStore } from "@/lib/server/task-store";
import { syncTaskFromWorker } from "@/lib/server/status-sync";
import { workerBusy } from "@/lib/server/worker-spawn";


type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const store = getTaskStore();
  syncTaskFromWorker(id);
  const task = store.get(id);
  if (!task) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  const busy = workerBusy();
  return NextResponse.json({
    task,
    events: store.events(id),
    logTail: store.logTail(id),
    worker: { busy: busy.busy, pid: busy.pid ?? null },
  });
}
