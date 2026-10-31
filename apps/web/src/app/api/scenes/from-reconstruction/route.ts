import { NextResponse } from "next/server";
import { createSceneFromReconstruction } from "@/lib/server/recon-scene";
import { putScene, ValidationError } from "@/lib/server/scene-store";

/** 由完成的重建任务创建编辑器场景：POST /api/scenes/from-reconstruction { taskId } */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { taskId?: string };
    if (!body.taskId || typeof body.taskId !== "string") {
      return NextResponse.json({ error: "缺少 taskId" }, { status: 400 });
    }
    const scene = createSceneFromReconstruction(body.taskId);
    const saved = putScene(scene);
    return NextResponse.json({ scene: saved }, { status: 201 });
  } catch (e) {
    if (e instanceof ValidationError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : "导入失败" }, { status: 500 });
  }
}
