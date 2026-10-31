import { NextResponse } from "next/server";
import { deleteScene, getScene, putScene, ValidationError } from "@/lib/server/scene-store";


type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const scene = getScene(id);
  if (!scene) return NextResponse.json({ error: "场景不存在或数据损坏" }, { status: 404 });
  return NextResponse.json({ scene });
}

export async function PUT(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const body = await req.json();
    if (body?.sceneId !== id) {
      return NextResponse.json({ error: "sceneId 与路径不一致" }, { status: 400 });
    }
    const saved = putScene(body);
    return NextResponse.json({ scene: saved, savedAt: new Date().toISOString() });
  } catch (e) {
    if (e instanceof ValidationError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : "保存失败" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const ok = deleteScene(id);
  return NextResponse.json({ deleted: ok }, { status: ok ? 200 : 404 });
}
