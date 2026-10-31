import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteScene,
  getScene,
  listScenes,
  putScene,
  ValidationError,
} from "./scene-store";
import { createDemoScene, createEmptyScene, type SceneData } from "@shared/scene-schema";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "miniverse-scenes-"));
  process.env.MINIVERSE_DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.MINIVERSE_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("场景文件存储（保存/加载/恢复）", () => {
  it("保存 → 读取 完整往返（roundtrip）", () => {
    const demo = createDemoScene();
    const saved = putScene(demo);
    const loaded = getScene(saved.sceneId)!;
    expect(loaded).toEqual(saved);
    expect(loaded.objects).toHaveLength(7);
  });

  it("拒绝写入非法场景（Zod 校验）", () => {
    const bad = { ...createEmptyScene(), schemaVersion: 99 };
    expect(() => putScene(bad)).toThrow(ValidationError);
  });

  it("列表按更新时间倒序，含摘要字段", () => {
    const a = putScene(createEmptyScene("A"));
    const b = putScene(createDemoScene());
    const list = listScenes();
    expect(list).toHaveLength(2);
    expect(list[0].sceneId).toBe(b.sceneId); // demo 更新时间靠后（created_at 差异极小，倒序仍稳定）
    const ids = list.map((s) => s.sceneId);
    expect(ids).toContain(a.sceneId);
    const demoSummary = list.find((s) => s.sceneId === b.sceneId)!;
    expect(demoSummary.demo).toBe(true);
    expect(demoSummary.objectCount).toBe(7);
  });

  it("删除后 getScene 返回 null", () => {
    const scene: SceneData = putScene(createEmptyScene());
    expect(deleteScene(scene.sceneId)).toBe(true);
    expect(getScene(scene.sceneId)).toBeNull();
    expect(deleteScene(scene.sceneId)).toBe(false);
  });

  it("损坏文件被隔离（不影响其他场景列表）", () => {
    putScene(createEmptyScene("好场景"));
    const bad = path.join(dataDir, "scenes", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json");
    writeFileSync(bad, "{ not valid json");
    const list = listScenes();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("好场景");
  });
});
