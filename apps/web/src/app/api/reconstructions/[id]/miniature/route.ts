import fs from "node:fs";
import { NextResponse } from "next/server";
import { getTaskStore } from "@/lib/server/task-store";
import { syncTaskFromWorker } from "@/lib/server/status-sync";
import { sceneAssetPath, SceneValidationError } from "@/lib/server/recon-editable-scene";
import { deriveMiniatureView, syntheticFixture } from "@/lib/miniature/stages";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 微缩重建的阶段视图。
 *
 * - 真实任务：阶段状态来自 result 里 worker 上报的 stages，没有就退化成"仅任务状态"，
 *   绝不按时间补进度。
 * - 产物核对：清单说导出成功还不够，这里再 stat 一次 GLB；文件不在就判失败。
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
    try {
      const st = fs.statSync(sceneAssetPath(id, "room"));
      view = { ...view, glb: view.glb ? { ...view.glb, bytes: st.size } : view.glb };
    } catch (e) {
      if (!(e instanceof SceneValidationError) && (e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      // 清单里有 GLB 但文件不见了：必须显式失败，不能沿用"生成成功"
      view = {
        ...view,
        ready: false,
        glb: null,
        banner: { level: "error", text: "结果清单声明了 GLB，但磁盘上找不到该文件，不能视为生成成功。" },
        stages: view.stages.map((s) =>
          s.key === "export" ? { ...s, state: "failed", detail: "GLB 文件缺失" } : s
        ),
      };
    }
  }

  return NextResponse.json({ view, events: store.events(id, 30), logTail: store.logTail(id, 60) });
}
