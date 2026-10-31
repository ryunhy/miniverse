import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { reconstructionDir } from "@/lib/server/paths";
import { getTaskStore } from "@/lib/server/task-store";
import { syncTaskFromWorker } from "@/lib/server/status-sync";


type Ctx = { params: Promise<{ id: string }> };

/** 下发重建产物 scene.ply（Gaussian Splatting 格式），供查看器流式加载 */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  syncTaskFromWorker(id);
  const task = getTaskStore().get(id);
  if (!task) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  if (task.status !== "completed") {
    return NextResponse.json({ error: `任务未完成（当前状态: ${task.status}）` }, { status: 409 });
  }
  const ply = path.join(reconstructionDir(id), "scene.ply");
  if (!fs.existsSync(ply)) {
    return NextResponse.json({ error: "产物文件缺失（scene.ply）" }, { status: 404 });
  }
  const stat = fs.statSync(ply);
  const stream = fs.createReadStream(ply);
  return new NextResponse(stream as unknown as ReadableStream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(stat.size),
      "Cache-Control": "no-store",
    },
  });
}
