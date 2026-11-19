import fs from "node:fs";
import { NextResponse } from "next/server";
import { getTaskStore } from "@/lib/server/task-store";
import { syncTaskFromWorker } from "@/lib/server/status-sync";
import { sceneAssetPath, SceneValidationError } from "@/lib/server/recon-editable-scene";
import {
  applyAssetCheck,
  classifyAssetFailure,
  deriveMiniatureView,
  syntheticFixture,
  ASSET_CHECK_STATUS,
  type AssetCheck,
} from "@/lib/miniature/stages";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 微缩重建的阶段视图。
 *
 * - 真实任务：阶段状态来自 result 里 worker 上报的 stages，没有就退化成"仅任务状态"，
 *   绝不按时间补进度。
 * - 产物核对：清单说导出成功还不够，这里再核对一次磁盘；未发布(404)/资产缺失(409)/清单非法(422)
 *   三态分开表达，各自文案与 HTTP 语义不同，失败响应体仍携带完整 view。
 * - `?fixture=1`：显式 synthetic 的 UI 契约示例，只用于前端状态演示（响应里 synthetic=true）。
 */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const url = new URL(req.url);

  if (url.searchParams.get("fixture") === "1") {
    const view = deriveMiniatureView(syntheticFixture());
    return NextResponse.json({
      view,
      synthetic: true,
      note: "合成契约示例，非真实重建；不得作为生成证据",
    });
  }

  syncTaskFromWorker(id);
  const store = getTaskStore();
  const task = store.get(id);
  if (!task) return NextResponse.json({ error: "任务不存在" }, { status: 404 });

  let view = deriveMiniatureView(task);

  if (view.ready) {
    // 产物核对三态分开表达（T-700018）：未发布 / 资产缺失 / 清单非法，
    // 不再一律报「磁盘上找不到该文件」。失败响应仍带完整 view，HTTP 码见 ASSET_CHECK_STATUS。
    let check: AssetCheck;
    try {
      const file = sceneAssetPath(id, "room");
      check = { kind: "ok", bytes: fs.statSync(file).size };
    } catch (e) {
      if (e instanceof SceneValidationError) {
        check = classifyAssetFailure(e.message);
      } else if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        // sceneAssetPath 通过后文件才被移走：清单在、文件缺
        check = { kind: "asset_missing", detail: "GLB 文件在核对间隙被移除（ENOENT）" };
      } else {
        throw e;
      }
    }
    view = applyAssetCheck(view, check);
    if (check.kind !== "ok") {
      return NextResponse.json(
        {
          view,
          error: view.banner.text,
          events: store.events(id, 30),
          logTail: store.logTail(id, 60),
        },
        { status: ASSET_CHECK_STATUS[check.kind] },
      );
    }
  }

  return NextResponse.json({ view, events: store.events(id, 30), logTail: store.logTail(id, 60) });
}
