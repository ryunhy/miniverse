import { NextResponse } from "next/server";
import { findPython, workerBusy } from "@/lib/server/worker-spawn";
import { getTaskStore } from "@/lib/server/task-store";
import { listScenes } from "@/lib/server/scene-store";


/** 前端底栏健康检查：存储/解释器/worker 占用/场景数 */
export async function GET() {
  const py = findPython();
  const busy = workerBusy();
  let taskCount = 0;
  try {
    taskCount = getTaskStore().list(1000).length;
  } catch {
    // 数据目录尚未初始化
  }
  let sceneCount = 0;
  try {
    sceneCount = listScenes().length;
  } catch {
    // 同上
  }
  return NextResponse.json({
    ok: true,
    storage: "sqlite+file",
    python: py ? `${py.cmd} ${py.args.join(" ")}` : null,
    workerBusy: busy.busy,
    workerPid: busy.pid ?? null,
    taskCount,
    sceneCount,
    time: new Date().toISOString(),
  });
}
