import { NextResponse } from "next/server";
import { listSceneHistory, ValidationError } from "@/lib/server/scene-store";

type Ctx = { params: Promise<{ id: string }> };

/** 历史版本列表（只读）：只返回摘要，不返回快照全文 */
export async function GET(_req: Request, ctx: Ctx) {
  const startedAt = Date.now();
  const { id } = await ctx.params;
  try {
    const entries = listSceneHistory(id);
    console.info(
      `[scenes] HISTORY id=${id} status=200 count=${entries.length} durationMs=${Date.now() - startedAt}`
    );
    return NextResponse.json({ entries });
  } catch (e) {
    const status = e instanceof ValidationError ? 400 : 500;
    console.info(
      `[scenes] HISTORY id=${id} status=${status} durationMs=${Date.now() - startedAt}`
    );
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "读取历史版本失败" },
      { status }
    );
  }
}
