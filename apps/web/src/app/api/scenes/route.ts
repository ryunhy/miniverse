import { NextResponse } from "next/server";
import { createDemoScene, createEmptyScene } from "@shared/scene-schema";
import { listScenes, putScene, ValidationError } from "@/lib/server/scene-store";


export async function GET() {
  return NextResponse.json({ scenes: listScenes() });
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    let scene: unknown;
    if (body && typeof body === "object" && "template" in body) {
      scene =
        body.template === "demo" ? createDemoScene() : createEmptyScene(String(body.name ?? "未命名场景"));
    } else {
      // 完整场景提交（导入）
      scene = body;
    }
    const saved = putScene(scene);
    return NextResponse.json({ scene: saved }, { status: 201 });
  } catch (e) {
    if (e instanceof ValidationError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : "创建失败" }, { status: 500 });
  }
}
