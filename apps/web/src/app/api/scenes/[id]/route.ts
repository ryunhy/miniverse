import { NextResponse } from "next/server";
import { deleteScene, getScene, putScene, ValidationError } from "@/lib/server/scene-store";


type Ctx = { params: Promise<{ id: string }> };

/** 场景读写服务端日志：id / status / 耗时 / 是否触发写回（writeback=yes 表示本次请求落了盘） */
function logScene(op: "GET" | "PUT", id: string, status: number, startedAt: number, writeback: boolean) {
  console.info(
    `[scenes] ${op} id=${id} status=${status} durationMs=${Date.now() - startedAt} writeback=${writeback ? "yes" : "no"}`
  );
}

export async function GET(_req: Request, ctx: Ctx) {
  const startedAt = Date.now();
  const { id } = await ctx.params;
  const scene = getScene(id);
  logScene("GET", id, scene ? 200 : 404, startedAt, false);
  if (!scene) return NextResponse.json({ error: "场景不存在或数据损坏" }, { status: 404 });
  return NextResponse.json({ scene });
}

export async function PUT(req: Request, ctx: Ctx) {
  const startedAt = Date.now();
  const { id } = await ctx.params;
  try {
    const body = await req.json();
    if (body?.sceneId !== id) {
      logScene("PUT", id, 400, startedAt, false);
      return NextResponse.json({ error: "sceneId 与路径不一致" }, { status: 400 });
    }
    const saved = putScene(body);
    logScene("PUT", id, 200, startedAt, true);
    return NextResponse.json({ scene: saved, savedAt: new Date().toISOString() });
  } catch (e) {
    if (e instanceof ValidationError) {
      logScene("PUT", id, 400, startedAt, false);
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    logScene("PUT", id, 500, startedAt, false);
    return NextResponse.json({ error: e instanceof Error ? e.message : "保存失败" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const ok = deleteScene(id);
  return NextResponse.json({ deleted: ok }, { status: ok ? 200 : 404 });
}
