import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSceneFromReconstruction } from "./recon-scene";
import { TaskStore } from "./task-store";
import { getScene, createScene } from "./scene-store";

let dataDir: string;
let store: TaskStore;

beforeEach(() => {
  dataDir = mkdtempSyncCompat();
  process.env.MINIVERSE_DATA_DIR = dataDir;
  store = new TaskStore(path.join(dataDir, "tasks", "tasks.db"));
});

afterEach(() => {
  store.close();
  delete process.env.MINIVERSE_DATA_DIR;
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows 下 WAL 句柄释放有延迟，不影响断言
  }
});

// Node 20 的 mkdtempSync 已存在，包装一层便于统一错误
function mkdtempSyncCompat(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  return fs.mkdtempSync(path.join(tmpdir(), "miniverse-recon-scene-"));
}

function completeTaskWithPly(taskId: string) {
  store.create(taskId, {}, 30);
  store.transition(taskId, "processing");
  store.transition(taskId, "completed", { result: { plyPath: "reconstructions/x/scene.ply" } });
  const plyDir = path.join(dataDir, "reconstructions", taskId);
  mkdirSync(plyDir, { recursive: true });
  writeFileSync(path.join(plyDir, "scene.ply"), "fake-ply-bytes");
}

describe("重建结果自动导入场景", () => {
  it("已完成任务 → 生成挂载高斯背景的场景；经 createScene 后可读回", () => {
    const taskId = randomUUID();
    completeTaskWithPly(taskId);

    const scene = createSceneFromReconstruction(taskId, store);
    expect(scene.reconstruction).toEqual({
      taskId,
      status: "completed",
      format: "gaussian-splat",
      url: `/api/reconstructions/${taskId}/result`,
      synthetic: false,
      // 未采样环境色：null，前端回退到墙/地混合色兜底缺口（方案 B）
      ambientColor: null,
    });
    expect(scene.room.visible).toBe(false); // 程序化外壳自动隐藏
    expect(scene.metadata.note).toContain("真实照片重建");

    // 持久化发生在 route 层 createScene；此处验证 helper 产物可被正常落盘读回
    // （createScene 会重写 createdAt/updatedAt，比较前抹平这两个时间字段）
    const saved = createScene(scene);
    const loaded = getScene(scene.sceneId)!;
    expect({
      ...loaded,
      metadata: {
        ...loaded.metadata,
        createdAt: scene.metadata.createdAt,
        updatedAt: scene.metadata.updatedAt,
      },
    }).toEqual({ ...scene, metadata: { ...scene.metadata, revision: saved.metadata.revision } });
  });

  it("同一任务重复导入 → 新建一份场景，不覆盖已导入的那份", () => {
    const taskId = randomUUID();
    completeTaskWithPly(taskId);

    const first = createScene(createSceneFromReconstruction(taskId, store));
    const second = createScene(createSceneFromReconstruction(taskId, store));

    // 每次导入生成独立 sceneId，因此不会命中「已存在」分支，也绝不会覆盖第一份
    expect(second.sceneId).not.toBe(first.sceneId);
    expect(getScene(first.sceneId)!.metadata.name).toBe(first.metadata.name);
    expect(getScene(second.sceneId)!.sceneId).toBe(second.sceneId);
  });

  it("任务未完成 → 拒绝导入", () => {
    const taskId = randomUUID();
    store.create(taskId, {}, 30); // pending
    expect(() => createSceneFromReconstruction(taskId, store)).toThrow(/任务未完成/);
  });

  it("任务标记完成但产物缺失 → 拒绝导入（数据完整性）", () => {
    const taskId = randomUUID();
    store.create(taskId, {}, 30);
    store.transition(taskId, "processing");
    store.transition(taskId, "completed", { result: {} });
    // 不写 scene.ply
    expect(() => createSceneFromReconstruction(taskId, store)).toThrow(/scene.ply 缺失/);
  });

  it("任务不存在 → 拒绝导入", () => {
    expect(() => createSceneFromReconstruction(randomUUID(), store)).toThrow(/任务不存在/);
  });

  it("非法 taskId（穿越尝试）→ 拒绝", () => {
    expect(() => createSceneFromReconstruction("../../etc", store)).toThrow(/非法任务 ID/);
  });
});
