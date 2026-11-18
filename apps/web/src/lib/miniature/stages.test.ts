import assert from "node:assert/strict";
import { test } from "vitest";
import { deriveMiniatureView, syntheticFixture, type TaskLike } from "./stages";

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
