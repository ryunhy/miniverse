import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { reconstructionDir } from "@/lib/server/paths";
import { getTaskStore } from "@/lib/server/task-store";
import { syncTaskFromWorker } from "@/lib/server/status-sync";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 下发重建网格产物 mesh.glb（2DGS + TSDF + 纹理烘焙，见 docs/MESH.md）。
 * 网格是可选增强项：任务未开 exportMesh 或网格生成失败时返回 404，
 * 前端据此回退到高斯查看器。
 */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  syncTaskFromWorker(id);
  const task = getTaskStore().get(id);
  if (!task) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  if (task.status !== "completed") {
    return NextResponse.json({ error: `任务未完成（当前状态: ${task.status}）` }, { status: 409 });
  }

  const glb = path.join(reconstructionDir(id), "mesh.glb");
  if (!fs.existsSync(glb)) {
    const meta = path.join(reconstructionDir(id), "mesh-metadata.json");
    const reason = fs.existsSync(meta) ? "网格元数据存在但 GLB 缺失" : "该任务未生成网格产物（exportMesh 未开启或失败）";
    return NextResponse.json({ error: reason, available: false }, { status: 404 });
  }

  const stat = fs.statSync(glb);
  const stream = fs.createReadStream(glb);
  return new NextResponse(stream as unknown as ReadableStream, {
    headers: {
      "Content-Type": "model/gltf-binary",
      "Content-Length": String(stat.size),
      "Cache-Control": "no-store",
    },
  });
}
