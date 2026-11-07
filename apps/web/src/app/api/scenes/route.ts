import { NextResponse } from "next/server";
import { createDemoScene, createEmptyScene } from "@shared/scene-schema";
import { createScene, listScenes, SceneExistsError, ValidationError } from "@/lib/server/scene-store";


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
      // 完整场景提交（导入）：只新建，同 ID 已存在时拒绝，绝不覆盖
      scene = body;
    }
    const saved = createScene(scene);
    return NextResponse.json({ scene: saved }, { status: 201 });
  } catch (e) {
    if (e instanceof SceneExistsError) {
      return NextResponse.json(
        {
          error: "这个场景已经存在，没有做任何修改。请从场景列表打开它，或另存为新场景后再试。",
          code: "scene_exists",
          sceneId: e.sceneId,
        },
        { status: 409 }
      );
    }
    if (e instanceof ValidationError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : "创建失败" }, { status: 500 });
  }
}
