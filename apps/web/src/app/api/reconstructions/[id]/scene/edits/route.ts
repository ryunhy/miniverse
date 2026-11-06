import { NextResponse } from "next/server";
import {
  SceneValidationError,
  SceneVersionConflict,
  clearEdits,
  loadEdits,
  saveEdits,
} from "@/lib/server/recon-editable-scene";

type Ctx = { params: Promise<{ id: string }> };

function fail(e: unknown) {
  if (e instanceof SceneVersionConflict) {
    return NextResponse.json(
      { error: e.message, code: "stale_scene_version", currentVersion: e.current },
      { status: 409 },
    );
  }
  if (e instanceof SceneValidationError) {
    const missing = /不存在/.test(e.message);
    return NextResponse.json({ error: e.message }, { status: missing ? 404 : 400 });
  }
  throw e;
}

/** 读取已保存布局；无布局时 edits=null。 */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const stored = loadEdits(id);
    return NextResponse.json(
      {
        edits: stored.edits,
        editsStale: stored.stale,
        sceneVersion: stored.currentVersion,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return fail(e);
  }
}

/** 保存布局（整份替换）。版本不匹配返回 409，防止把旧布局套到新几何上。 */
export async function PUT(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  try {
    const edits = saveEdits(id, body);
    return NextResponse.json(
      { ok: true, edits, sceneVersion: edits.baseSceneVersion },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return fail(e);
  }
}

/** 删除已保存布局（恢复默认）。 */
export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const removed = clearEdits(id);
    return NextResponse.json(
      { ok: true, removed },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return fail(e);
  }
}
