import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteScene,
  getScene,
  listScenes,
  putScene,
  RevisionConflictError,
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

describe("版本号（revision）与 409 冲突", () => {
  it("新建场景 revision=0，每次成功写入 +1", () => {
    const v0 = putScene(createEmptyScene("版本"));
    expect(v0.metadata.revision).toBe(0);
    const v1 = putScene(v0);
    expect(v1.metadata.revision).toBe(1);
    const v2 = putScene(v1, 1);
    expect(v2.metadata.revision).toBe(2);
  });

  it("expectedRevision 过期 → 抛 RevisionConflictError 且不落盘", () => {
    const v0 = putScene(createEmptyScene("冲突"));
    const v1 = putScene(v0); // 服务端前进到 revision=1
    const before = getScene(v1.sceneId)!;

    const stale = { ...v1, metadata: { ...v1.metadata, name: "我的改动" } };
    expect(() => putScene(stale, 0)).toThrow(RevisionConflictError);
    try {
      putScene(stale, 0);
    } catch (e) {
      expect((e as RevisionConflictError).currentRevision).toBe(1);
    }

    const after = getScene(v1.sceneId)!;
    expect(after.metadata.name).toBe(before.metadata.name);
    expect(after.metadata.revision).toBe(1);
    expect(after.metadata.updatedAt).toBe(before.metadata.updatedAt);
  });

  it("写前把旧版本快照到 _history/<id>/<rev>.json", () => {
    const v0 = putScene(createEmptyScene("快照"));
    const v1 = putScene(v0); // 写前应快照 revision 0
    const dir = path.join(dataDir, "scenes", "_history", v1.sceneId);
    const file = path.join(dir, "0.json");
    expect(existsSync(file)).toBe(true);
    const snapshot = JSON.parse(readFileSync(file, "utf8"));
    expect(snapshot.metadata.revision).toBe(0);
    expect(snapshot.metadata.name).toBe(v0.metadata.name);
  });

  it("冲突（409）不产生历史快照，只记录成功写入前的版本", () => {
    const v0 = putScene(createEmptyScene("冲突快照"));
    const v1 = putScene(v0);
    const dir = path.join(dataDir, "scenes", "_history", v1.sceneId);
    const countBefore = readdirSync(dir).length;
    expect(() => putScene({ ...v1, metadata: { ...v1.metadata, name: "X" } }, 0)).toThrow(RevisionConflictError);
    expect(readdirSync(dir).length).toBe(countBefore);
  });

  it("历史版本最多保留 20 份（保留最近版本）", () => {
    let scene = putScene(createEmptyScene("保留"));
    for (let i = 0; i < 24; i += 1) scene = putScene(scene);
    const dir = path.join(dataDir, "scenes", "_history", scene.sceneId);
    const files = readdirSync(dir)
      .filter((f) => /^\d+\.json$/.test(f))
      .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
    expect(files).toHaveLength(20);
    // 共成功写 25 次（rev 0..24），快照应为 0..23，裁剪后留下最新的 4..23
    expect(files[0]).toBe("4.json");
    expect(files[files.length - 1]).toBe("23.json");
  });

  it("老文件缺 metadata.revision 时按 0 读取（不做破坏性迁移）", () => {
    const saved = putScene(createEmptyScene("老文件"));
    const p = path.join(dataDir, "scenes", `${saved.sceneId}.json`);
    const raw = JSON.parse(readFileSync(p, "utf8"));
    delete raw.metadata.revision;
    writeFileSync(p, JSON.stringify(raw, null, 2));
    expect(getScene(saved.sceneId)!.metadata.revision).toBe(0);
  });
});
