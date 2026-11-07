import { NextResponse } from "next/server";
import {
  deleteScene,
  getScene,
  MissingPreconditionError,
  RevisionConflictError,
  SceneNotFoundError,
  updateScene,
  ValidationError,
} from "@/lib/server/scene-store";

type Ctx = { params: Promise<{ id: string }> };

/** 场景读写服务端日志：id / status / 耗时 / 是否触发写回（writeback=yes 表示本次请求落了盘） */
function logScene(op: "GET" | "PUT" | "DELETE", id: string, status: number, startedAt: number, writeback: boolean) {
  console.info(
    `[scenes] ${op} id=${id} status=${status} durationMs=${Date.now() - startedAt} writeback=${writeback ? "yes" : "no"}`
  );
}

/** If-Match 支持 `"12"` / `W/"12"` / `12` 三种写法；`*` 视为无条件 */
function parseIfMatch(header: string | null): number | undefined {
  if (header === null) return undefined;
  const raw = header.trim().replace(/^W\//, "").replaceAll('"', "");
  if (raw === "*") return undefined;
  if (!/^\d+$/.test(raw)) throw new ValidationError(`If-Match 需要 revision 数字，收到 "${header}"`);
  return Number.parseInt(raw, 10);
}

/** 版本号优先取请求体 expectedRevision，其次取 If-Match 头 */
function parseExpectedRevision(body: unknown, req: Request): number | undefined {
  if (body && typeof body === "object" && "expectedRevision" in body) {
    const v = (body as { expectedRevision?: unknown }).expectedRevision;
    if (v !== undefined && v !== null) {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
        throw new ValidationError("expectedRevision 必须是非负整数");
      }
      return v;
    }
  }
  return parseIfMatch(req.headers.get("if-match"));
}

export async function GET(_req: Request, ctx: Ctx) {
  const startedAt = Date.now();
  const { id } = await ctx.params;
  const scene = getScene(id);
  logScene("GET", id, scene ? 200 : 404, startedAt, false);
  if (!scene) return NextResponse.json({ error: "场景不存在或数据损坏" }, { status: 404 });
  const revision = scene.metadata.revision;
  return NextResponse.json(
    { scene, revision },
    { headers: { ETag: `"${revision}"` } }
  );
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
    const expectedRevision = parseExpectedRevision(body, req);
    const saved = updateScene(body, expectedRevision);
    logScene("PUT", id, 200, startedAt, true);
    return NextResponse.json({
      scene: saved,
      revision: saved.metadata.revision,
      savedAt: new Date().toISOString(),
    });
  } catch (e) {
    if (e instanceof RevisionConflictError) {
      logScene("PUT", id, 409, startedAt, false);
      return NextResponse.json(
        {
          error: "版本冲突：场景已被其他会话修改",
          code: "revision_conflict",
          revision: e.currentRevision,
          scene: getScene(id),
        },
        { status: 409 }
      );
    }
    if (e instanceof MissingPreconditionError) {
      logScene("PUT", id, 428, startedAt, false);
      return NextResponse.json(
        {
          error: "这次保存没有携带场景版本号，为保护数据已拒绝写入。请刷新页面后重试。",
          code: "revision_required",
        },
        { status: 428 }
      );
    }
    if (e instanceof SceneNotFoundError) {
      logScene("PUT", id, 404, startedAt, false);
      return NextResponse.json(
        {
          error: "这个场景已经被删除，无法再保存。当前改动只保留在本机。",
          code: "scene_not_found",
        },
        { status: 404 }
      );
    }
    if (e instanceof ValidationError) {
      logScene("PUT", id, 400, startedAt, false);
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    logScene("PUT", id, 500, startedAt, false);
    return NextResponse.json({ error: e instanceof Error ? e.message : "保存失败" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const startedAt = Date.now();
  const { id } = await ctx.params;
  try {
    const ok = deleteScene(id);
    logScene("DELETE", id, ok ? 200 : 404, startedAt, ok);
    return NextResponse.json({ deleted: ok }, { status: ok ? 200 : 404 });
  } catch (e) {
    const status = e instanceof ValidationError ? 400 : 500;
    logScene("DELETE", id, status, startedAt, false);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "删除失败" },
      { status }
    );
  }
}
