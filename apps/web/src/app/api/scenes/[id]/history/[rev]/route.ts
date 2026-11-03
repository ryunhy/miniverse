import { NextResponse } from "next/server";
import { getSceneHistoryVersion, ValidationError } from "@/lib/server/scene-store";

type Ctx = { params: Promise<{ id: string; rev: string }> };

/** 单个历史版本快照（只读）：恢复时由前端取出内容，再走 PUT 的 CAS 写入 */
export async function GET(_req: Request, ctx: Ctx) {
  const { id, rev } = await ctx.params;
  if (!/^\d+$/.test(rev)) {
    return NextResponse.json({ error: "版本号必须是非负整数" }, { status: 400 });
  }
  try {
    const scene = getSceneHistoryVersion(id, Number.parseInt(rev, 10));
    if (!scene) return NextResponse.json({ error: "历史版本不存在" }, { status: 404 });
    return NextResponse.json({ scene });
  } catch (e) {
    const status = e instanceof ValidationError ? 400 : 500;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "读取历史版本失败" },
      { status }
    );
  }
}
