import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createScene,
  deleteScene,
  getScene,
  getSceneHistoryVersion,
  listSceneHistory,
  MissingPreconditionError,
  SceneExistsError,
  SceneNotFoundError,
  updateScene,
} from "./scene-store";
import { createDemoScene, createEmptyScene, safeParseScene } from "@shared/scene-schema";
import { POST as postSceneRoute } from "../../app/api/scenes/route";
import {
  DELETE as deleteSceneRoute,
  PUT as putSceneRoute,
} from "../../app/api/scenes/[id]/route";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "miniverse-guards-"));
  process.env.MINIVERSE_DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.MINIVERSE_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function jsonRequest(url: string, method: string, body: unknown, headers?: Record<string, string>) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("写入入口护栏（store 层）", () => {
  it("createScene 撞已存在 ID → SceneExistsError，且原内容一字不改", () => {
    const v0 = createScene(createEmptyScene("原始"));
    expect(() => createScene({ ...v0, metadata: { ...v0.metadata, name: "覆盖尝试" } })).toThrow(
      SceneExistsError
    );
    expect(getScene(v0.sceneId)!.metadata.name).toBe("原始");
    expect(getScene(v0.sceneId)!.metadata.revision).toBe(0);
  });

  it("updateScene 缺版本号 → MissingPreconditionError，不落盘", () => {
    const v0 = createScene(createEmptyScene("需要版本号"));
    expect(() => updateScene({ ...v0, metadata: { ...v0.metadata, name: "盲写" } }, undefined)).toThrow(
      MissingPreconditionError
    );
    expect(getScene(v0.sceneId)!.metadata.name).toBe("需要版本号");
  });

  it("updateScene 目标不存在 → SceneNotFoundError，不隐式重建", () => {
    const ghost = createEmptyScene("幽灵");
    deleteScene(ghost.sceneId);
    expect(() => updateScene(ghost, 0)).toThrow(SceneNotFoundError);
    expect(getScene(ghost.sceneId)).toBeNull();
  });

  it("deleteScene 把主文件与历史目录一起移到 _trash 归档", () => {
    const v0 = createScene(createEmptyScene("待删"));
    updateScene(v0, 0); // 产生一份历史快照
    const historyRoot = path.join(dataDir, "scenes", "_history", v0.sceneId);
    expect(existsSync(historyRoot)).toBe(true);

    expect(deleteScene(v0.sceneId)).toBe(true);
    expect(existsSync(path.join(dataDir, "scenes", `${v0.sceneId}.json`))).toBe(false);
    expect(existsSync(historyRoot)).toBe(false);

    const trashRoot = path.join(dataDir, "scenes", "_trash");
    const archived = readdirSync(trashRoot).filter((d) => d.startsWith(v0.sceneId));
    expect(archived).toHaveLength(1);
    const dir = path.join(trashRoot, archived[0]);
    expect(existsSync(path.join(dir, "scene.json"))).toBe(true);
    expect(existsSync(path.join(dir, "history"))).toBe(true);
  });
});

describe("历史版本按生命周期隔离", () => {
  it("同 sceneId 换了 createdAt（外部恢复/重新导入）后，读不到上一生命周期快照", () => {
    const v0 = createScene(createEmptyScene("第一代"));
    updateScene(v0, 0); // 第一代生命周期里产生 0.json
    const p = path.join(dataDir, "scenes", `${v0.sceneId}.json`);

    // 模拟主文件被另一份同 ID、不同 createdAt 的内容替换
    const raw = JSON.parse(readFileSync(p, "utf8"));
    raw.metadata.createdAt = new Date(Date.now() + 60_000).toISOString();
    raw.metadata.name = "第二代";
    writeFileSync(p, JSON.stringify(raw, null, 2));

    // 旧生命周期快照不可见
    expect(listSceneHistory(v0.sceneId)).toEqual([]);
    expect(getSceneHistoryVersion(v0.sceneId, 0)).toBeNull();

    // 新生命周期写入只会在自己的目录里留快照（revision 沿用主文件里的 1）
    const v2 = updateScene(getScene(v0.sceneId)!, 1);
    const entries = listSceneHistory(v0.sceneId);
    expect(entries.map((e) => e.revision)).toEqual([1]);
    expect(entries[0].name).toBe("第二代");
    expect(getSceneHistoryVersion(v0.sceneId, 1)!.metadata.name).toBe("第二代");
    expect(v2.metadata.revision).toBe(2);

    const lifecycleDirs = readdirSync(path.join(dataDir, "scenes", "_history", v0.sceneId), {
      withFileTypes: true,
    }).filter((d) => d.isDirectory());
    expect(lifecycleDirs).toHaveLength(2);
  });
});

describe("HTTP 层语义（POST 409 / PUT 428 / PUT 404）", () => {
  it("POST 完整场景撞已存在 sceneId → 409，且不覆盖", async () => {
    const v0 = createScene(createEmptyScene("已有场景"));
    const res = await postSceneRoute(
      jsonRequest("http://localhost/api/scenes", "POST", {
        ...v0,
        metadata: { ...v0.metadata, name: "覆盖尝试" },
      })
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("scene_exists");
    expect(getScene(v0.sceneId)!.metadata.name).toBe("已有场景");
  });

  it("PUT 缺 If-Match / expectedRevision → 428，且不落盘", async () => {
    const v0 = createScene(createEmptyScene("不许盲写"));
    const res = await putSceneRoute(
      jsonRequest(`http://localhost/api/scenes/${v0.sceneId}`, "PUT", {
        ...v0,
        metadata: { ...v0.metadata, name: "盲写" },
      }),
      ctx(v0.sceneId)
    );
    expect(res.status).toBe(428);
    expect((await res.json()).code).toBe("revision_required");
    expect(getScene(v0.sceneId)!.metadata.name).toBe("不许盲写");
  });

  it("DELETE 之后 PUT → 404，不再复活场景", async () => {
    const v0 = createScene(createEmptyScene("将被删除"));
    const del = await deleteSceneRoute(
      new Request(`http://localhost/api/scenes/${v0.sceneId}`, { method: "DELETE" }),
      ctx(v0.sceneId)
    );
    expect(del.status).toBe(200);

    const put = await putSceneRoute(
      jsonRequest(
        `http://localhost/api/scenes/${v0.sceneId}`,
        "PUT",
        { ...v0, metadata: { ...v0.metadata, name: "复活" } },
        { "if-match": '"0"' }
      ),
      ctx(v0.sceneId)
    );
    expect(put.status).toBe(404);
    expect((await put.json()).code).toBe("scene_not_found");
    expect(getScene(v0.sceneId)).toBeNull();
  });

  it("PUT 带正确 If-Match → 200 且 revision 递增", async () => {
    const v0 = createScene(createEmptyScene("正常保存"));
    const res = await putSceneRoute(
      jsonRequest(
        `http://localhost/api/scenes/${v0.sceneId}`,
        "PUT",
        { ...v0, metadata: { ...v0.metadata, name: "改过了" } },
        { "if-match": '"0"' }
      ),
      ctx(v0.sceneId)
    );
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.revision).toBe(1);
    expect(getScene(v0.sceneId)!.metadata.name).toBe("改过了");
  });
});

describe("共享 schema 表驱动：素材白名单与同源 URL", () => {
  const template = createDemoScene().objects[0];

  function sceneWithObject(assetId: string) {
    return { ...createEmptyScene("白名单"), objects: [{ ...template, assetId }] };
  }

  function sceneWithUrl(url: unknown) {
    const base = createEmptyScene("URL");
    return { ...base, reconstruction: { ...base.reconstruction, url } };
  }

  it.each([
    ["../../etc/passwd", false],
    ["https://evil.example.com/model.glb", false],
    ["不存在_asset", false],
    ["chair", true],
    ["bed_double", true],
  ])("assetId=%s 通过=%s", (assetId, expected) => {
    expect(safeParseScene(sceneWithObject(assetId)).success).toBe(expected);
  });

  it.each([
    [null, true],
    ["/api/reconstructions/2f3a92a0-23f0-414b-86ee-f9c9e0bc85a6/result", true],
    ["/demo/room.ply", true],
    ["https://evil.example.com/steal.ply", false],
    ["javascript:alert(1)", false],
    ["//evil.example.com/x.ply", false],
    ["/other/path.ply", false],
  ])("reconstruction.url=%s 通过=%s", (url, expected) => {
    expect(safeParseScene(sceneWithUrl(url)).success).toBe(expected);
  });
});
