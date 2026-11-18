import { NextResponse } from "next/server";
import { getTaskStore } from "@/lib/server/task-store";
import { cancelWorker, releaseWorkerLockIfOwned } from "@/lib/server/worker-spawn";
import { isCancelRequested } from "@/lib/server/status-sync";


type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const store = getTaskStore();
  const task = store.get(id);
  if (!task) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  try {
    cancelWorker(id, task.worker_pid);
    if (task.status === "pending") {
      store.transition(id, "canceled");
      // 只释放属于自己的锁：排队任务的锁通常属于另一个正在运行的任务
      releaseWorkerLockIfOwned(task.worker_pid);
    } else if (task.status === "processing") {
      // worker 会检测 cancel.flag 并写 status.json=canceled；Web 端下次读取时同步
      store.appendEvent(id, "warn", "已请求取消，等待 worker 退出");
    }
    return NextResponse.json({ task: store.get(id)! });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "取消失败" }, { status: 400 });
  }
}

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return NextResponse.json({ requested: isCancelRequested(id) });
}
