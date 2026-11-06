import { NextResponse } from "next/server";
import {
  SceneValidationError,
  listSceneAssets,
  loadEdits,
  loadSceneManifest,
  sceneVersion,
} from "@/lib/server/recon-editable-scene";

type Ctx = { params: Promise<{ id: string }> };

function fail(e: unknown) {
  if (e instanceof SceneValidationError) {
    const missing = /不存在/.test(e.message);
    return NextResponse.json({ error: e.message }, { status: missing ? 404 : 400 });
  }
  throw e;
}

/**
 * 可编辑场景清单：manifest + 资产哈希 + 已保存布局。
 * Cache-Control: no-store —— 布局与版本必须在每次进入页面时重新读取，
 * 否则「保存 → 刷新 → 恢复」会拿到浏览器缓存里的旧值。
 */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const manifest = loadSceneManifest(id);
    const version = sceneVersion(id);
    const stored = loadEdits(id);
    return NextResponse.json(
      {
        manifest,
        sceneVersion: version,
        assets: listSceneAssets(id),
        edits: stored.edits,
        editsStale: stored.stale,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return fail(e);
  }
}

/** HEAD 探测：页面据此决定渲染可编辑场景还是只读网格查看器。 */
export async function HEAD(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    loadSceneManifest(id);
    return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return fail(e);
  }
}
