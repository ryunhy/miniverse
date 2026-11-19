import assert from "node:assert/strict";
import { test } from "vitest";
import {
  applyAssetCheck,
  classifyAssetFailure,
  deriveMiniatureView,
  syntheticFixture,
  ASSET_CHECK_STATUS,
  type MiniatureView,
  type TaskLike,
} from "./stages";

function task(over: Partial<TaskLike>): TaskLike {
  return { id: "t1", status: "processing", photo_count: 8, result: null, error: null, ...over };
}

function resultWith(glb: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ glb, ...extra });
}

test("worker 上报阶段时按上报状态呈现，来源标记为 worker_report", () => {
  const v = deriveMiniatureView(
    task({
      status: "completed",
      result: resultWith({ path: "glb/a.glb", bytes: 42 }, {
        stages: {
          ingest: { state: "done" },
          structure: { state: "done" },
          instances: { state: "done" },
          geometry: { state: "done" },
          texture: { state: "done" },
          export: { state: "done" },
        },
      }),
    })
  );
  assert.equal(v.stageSource, "worker_report");
  assert.equal(v.ready, true);
  assert.deepEqual(v.stages.map((s) => s.state), ["done", "done", "done", "done", "done", "done"]);
  assert.equal(v.glb?.bytes, 42);
});

test("任务 completed 但没有 GLB：判为未成功，导出阶段标 failed", () => {
  const v = deriveMiniatureView(task({ status: "completed", result: JSON.stringify({ note: "no glb" }) }));
  assert.equal(v.ready, false);
  assert.equal(v.glb, null);
  assert.equal(v.stages.find((s) => s.key === "export")?.state, "failed");
  assert.match(v.banner.text, /没有可用的 GLB/);
});

test("失败任务不会因为残留 stage=done 而显示成功", () => {
  const v = deriveMiniatureView(
    task({
      status: "failed",
      error: "纹理烘焙 OOM",
      result: resultWith({ path: "glb/a.glb" }, { stages: { ingest: { state: "done" }, export: { state: "done" } } }),
    })
  );
  assert.equal(v.ready, false);
  assert.equal(v.banner.level, "error");
});

test("取消任务：不产出、不显示成功，提示可重试", () => {
  const v = deriveMiniatureView(task({ status: "canceled", result: null }));
  assert.equal(v.ready, false);
  assert.equal(v.banner.level, "warn");
  assert.match(v.banner.text, /已取消/);
});

test("无分阶段上报时不按时间编造进度：除输入外均为 unknown", () => {
  const v = deriveMiniatureView(task({ status: "processing" }));
  assert.equal(v.stageSource, "task_status_only");
  const states = v.stages.map((s) => s.state);
  assert.equal(states[0], "done");
  assert.deepEqual(states.slice(1), ["unknown", "unknown", "unknown", "unknown", "unknown"]);
});

test("result 不是合法 JSON 时按无产物处理", () => {
  const v = deriveMiniatureView(task({ status: "completed", result: "not json" }));
  assert.equal(v.ready, false);
  assert.equal(v.glb, null);
});

test("预览与下载都指向当前任务产物", () => {
  const v = deriveMiniatureView(task({ id: "abc-123", status: "completed", result: resultWith({ path: "glb/a.glb" }) }));
  assert.equal(v.glb?.url, "/api/reconstructions/abc-123/scene/glb?asset=room");
  assert.equal(v.glb?.downloadUrl, "/api/reconstructions/abc-123/scene/glb?asset=room&download=1");
});

test("fixture 必须显式标 synthetic，且六个阶段齐全", () => {
  const v = deriveMiniatureView(syntheticFixture());
  assert.equal(v.synthetic, true);
  assert.equal(v.stages.length, 6);
  assert.equal(v.ready, true);
});

test("fixture 误用为真实数据时 synthetic=false 透传（防止冒充）", () => {
  const fake = JSON.parse(syntheticFixture().result as string);
  delete fake.synthetic;
  const v = deriveMiniatureView(
    task({ status: "completed", result: JSON.stringify({ ...fake, glb: { path: "glb/a.glb" } }) })
  );
  assert.equal(v.synthetic, false);
});

// ---------------------------------------------------------------------------
// T-700018：产物核对三态（未发布 / 资产缺失 / 清单非法）
// ---------------------------------------------------------------------------

/** 一个 ready=true 的已完成视图，作为三态改写的输入。 */
function readyView(): MiniatureView {
  return deriveMiniatureView(
    task({
      status: "completed",
      result: resultWith({ path: "glb/a.glb", bytes: 42 }, {
        stages: {
          ingest: { state: "done" },
          structure: { state: "done" },
          instances: { state: "done" },
          geometry: { state: "done" },
          texture: { state: "done" },
          export: { state: "done" },
        },
      }),
    })
  );
}

test("错误消息归类：没有 scene.json → 未发布（禁改区消息契约回归）", () => {
  const c = classifyAssetFailure("场景不存在: abc-123");
  assert.equal(c.kind, "unpublished");
});

test("错误消息归类：清单在但文件缺 → 资产缺失", () => {
  const c = classifyAssetFailure("资产文件不存在: room.glb");
  assert.equal(c.kind, "asset_missing");
  if (c.kind === "asset_missing") assert.match(c.detail, /room\.glb/);
});

test("错误消息归类：schema/解析/路径问题 → 清单非法", () => {
  for (const msg of [
    "scene.json 无法解析: Unexpected token",
    "不支持的场景 schema: miniverse.scene-manifest.v0",
    "scene.json 缺少 objects",
    "资产路径非法: ../evil.glb",
    "资产路径越界: room.glb",
    "非法场景 ID",
  ]) {
    assert.equal(classifyAssetFailure(msg).kind, "manifest_invalid", msg);
  }
});

test("三态 HTTP 语义互不相同：404 / 409 / 422", () => {
  assert.equal(ASSET_CHECK_STATUS.unpublished, 404);
  assert.equal(ASSET_CHECK_STATUS.asset_missing, 409);
  assert.equal(ASSET_CHECK_STATUS.manifest_invalid, 422);
  assert.equal(new Set(Object.values(ASSET_CHECK_STATUS)).size, 3);
});

test("未发布：ready=false、warn、文案说「尚未发布」而不是「找不到文件」", () => {
  const v = applyAssetCheck(readyView(), { kind: "unpublished" });
  assert.equal(v.ready, false);
  assert.equal(v.glb, null);
  assert.equal(v.banner.level, "warn");
  assert.match(v.banner.text, /尚未发布/);
  assert.match(v.banner.text, /scene\.json/);
  assert.doesNotMatch(v.banner.text, /磁盘上找不到该文件/);
  assert.equal(v.stages.find((s) => s.key === "export")?.state, "failed");
});

test("资产缺失：ready=false、error、文案说「资产文件缺失」并带明细", () => {
  const v = applyAssetCheck(readyView(), { kind: "asset_missing", detail: "资产文件不存在: room.glb" });
  assert.equal(v.ready, false);
  assert.equal(v.glb, null);
  assert.equal(v.banner.level, "error");
  assert.match(v.banner.text, /资产文件缺失/);
  assert.match(v.banner.text, /room\.glb/);
  assert.equal(v.stages.find((s) => s.key === "export")?.state, "failed");
});

test("清单非法：ready=false、error、文案说「非法」而不是「找不到文件」", () => {
  const v = applyAssetCheck(readyView(), { kind: "manifest_invalid", detail: "资产路径非法: ../evil.glb" });
  assert.equal(v.ready, false);
  assert.equal(v.glb, null);
  assert.equal(v.banner.level, "error");
  assert.match(v.banner.text, /非法/);
  assert.match(v.banner.text, /\.\.\/evil\.glb/);
  assert.doesNotMatch(v.banner.text, /磁盘上找不到该文件/);
  assert.equal(v.stages.find((s) => s.key === "export")?.state, "failed");
});

test("三态文案互不相同，且都不把 ready 强置 true", () => {
  const base = readyView();
  const texts = [
    applyAssetCheck(base, { kind: "unpublished" }),
    applyAssetCheck(base, { kind: "asset_missing", detail: "资产文件不存在: room.glb" }),
    applyAssetCheck(base, { kind: "manifest_invalid", detail: "不支持的场景 schema: x" }),
  ];
  assert.equal(new Set(texts.map((v) => v.banner.text)).size, 3);
  for (const v of texts) assert.equal(v.ready, false);
});

test("核对成功：只更新字节数，ready 与其余字段不变", () => {
  const base = readyView();
  const v = applyAssetCheck(base, { kind: "ok", bytes: 2048 });
  assert.equal(v.ready, true);
  assert.equal(v.glb?.bytes, 2048);
  assert.equal(v.banner.level, "ok");
  assert.deepEqual(v.stages.map((s) => s.state), base.stages.map((s) => s.state));
});

test("消费契约回归：三态失败视图仍完整可渲染（六阶段齐全、身份字段保留）", () => {
  const base = readyView();
  for (const check of [
    { kind: "unpublished" },
    { kind: "asset_missing", detail: "资产文件不存在: room.glb" },
    { kind: "manifest_invalid", detail: "scene.json 无法解析: bad" },
  ] as const) {
    const v = applyAssetCheck(base, check);
    assert.equal(v.taskId, base.taskId);
    assert.equal(v.status, base.status);
    assert.equal(v.stages.length, 6);
    assert.ok(v.banner.text.length > 0);
    assert.equal(typeof v.ready, "boolean");
    // 非导出阶段不被核对结果篡改
    for (const s of v.stages.filter((s) => s.key !== "export")) {
      assert.deepEqual(s, base.stages.find((b) => b.key === s.key));
    }
  }
});
