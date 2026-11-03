import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteScene,
  getScene,
  getSceneHistoryVersion,
  listSceneHistory,
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

describe("历史版本读取（listSceneHistory / getSceneHistoryVersion）", () => {
  it("列表按 revision 倒序，含名称与家具数摘要", () => {
    const v0 = putScene(createDemoScene()); // rev0：7 件家具
    const v1 = putScene({ ...v0, objects: v0.objects.slice(0, 5), metadata: { ...v0.metadata, name: "少两件" } });
    const v2 = putScene({ ...v1, objects: v1.objects.slice(0, 3), metadata: { ...v1.metadata, name: "少四件" } });
    expect(v2.metadata.revision).toBe(2);

    const entries = listSceneHistory(v0.sceneId);
    expect(entries.map((e) => e.revision)).toEqual([1, 0]);
    expect(entries[0].objectCount).toBe(5);
    expect(entries[0].name).toBe("少两件");
    expect(entries[1].objectCount).toBe(7);
  });

  it("没有历史目录时返回空列表（不抛错）", () => {
    const v0 = putScene(createEmptyScene("无历史"));
    expect(listSceneHistory(v0.sceneId)).toEqual([]);
  });

  it("非法场景 ID（路径穿越）被拒绝", () => {
    expect(() => listSceneHistory("../../etc/passwd")).toThrow(ValidationError);
    expect(() => getSceneHistoryVersion("../x", 0)).toThrow(ValidationError);
    expect(() => getScene("../../etc/passwd")).toThrow(ValidationError);
  });

  it("读取单个历史版本：存在返回内容，不存在返回 null，非法版本号抛错", () => {
    const v0 = putScene(createEmptyScene("可恢复"));
    const v1 = putScene(v0); // 快照 rev0
    const restored = getSceneHistoryVersion(v1.sceneId, 0)!;
    expect(restored.metadata.revision).toBe(0);
    expect(restored.metadata.name).toBe("可恢复");
    expect(getSceneHistoryVersion(v1.sceneId, 99)).toBeNull();
    expect(() => getSceneHistoryVersion(v1.sceneId, -1)).toThrow(ValidationError);
    expect(() => getSceneHistoryVersion(v1.sceneId, 1.5)).toThrow(ValidationError);
  });

  it("恢复历史版本写入为追加的新版本，且当前版本被快照保留（历史不改写）", () => {
    const v0 = putScene(createDemoScene());
    const v1 = putScene({ ...v0, objects: v0.objects.slice(0, 5), metadata: { ...v0.metadata, name: "删了两件" } });
    // 恢复 rev0 内容，基线为当前 rev1
    const restored = putScene(getSceneHistoryVersion(v1.sceneId, 0)!, 1);
    expect(restored.metadata.revision).toBe(2);
    expect(restored.objects).toHaveLength(7);
    // 恢复前的 v1 也被快照，历史里原 v0 快照仍在
    const entries = listSceneHistory(v1.sceneId).map((e) => e.revision);
    expect(entries).toEqual([1, 0]);
    expect(getSceneHistoryVersion(v1.sceneId, 0)!.objects).toHaveLength(7);
    expect(getSceneHistoryVersion(v1.sceneId, 1)!.objects).toHaveLength(5);
  });
});
