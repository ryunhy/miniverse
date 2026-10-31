import { NextResponse } from "next/server";
import { getTaskStore } from "@/lib/server/task-store";
import { syncTaskFromWorker } from "@/lib/server/status-sync";
import { loadTrainingCameras, CamerasUnavailableError } from "@/lib/server/recon-cameras";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 下发任务的训练相机位姿（nerfstudio 世界系）。
 * 前端取景：相机位置取「最接近全体相机位置中位数」的一台真实相机 + 场景点云中心做 target，
 * 使重建场景初始视角贴近真实拍摄视角；产物缺失（如旧任务/手动清理）返回 404，前端回退稳健取景。
 */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  syncTaskFromWorker(id);
  const task = getTaskStore().get(id);
  if (!task) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  if (task.status !== "completed") {
    return NextResponse.json({ error: `任务未完成（当前状态: ${task.status}）` }, { status: 409 });
  }
  try {
    const data = loadTrainingCameras(id);
    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    if (e instanceof CamerasUnavailableError) {
      return NextResponse.json({ error: `训练相机数据不可用: ${e.message}` }, { status: 404 });
    }
    throw e;
  }
}
