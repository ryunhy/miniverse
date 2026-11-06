import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SCENE_MANIFEST_SCHEMA,
  SceneValidationError,
  SceneVersionConflict,
  clearEdits,
  listSceneAssets,
  loadEdits,
  loadSceneManifest,
  saveEdits,
  sceneAssetPath,
  sceneIdValid,
  sceneVersion,
} from "./recon-editable-scene";

let dataDir: string;

const BASE_MANIFEST = {
  schema: SCENE_MANIFEST_SCHEMA,
  sceneId: "scene-test",
  units: "nu",
  upAxis: "+Y",
  assets: {
    scene: { path: "room.glb" },
    walls: { path: "walls.glb" },
    floor: { path: "floor.glb" },
    sofa: { path: "sofa.glb" },
  },
  objects: [
    {
      objectId: "obj-walls",
      nodeName: "walls",
      label: "wall",
      role: "background",
      startTransform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], visible: true },
    },
    {
      objectId: "obj-floor",
      nodeName: "floor",
      label: "floor",
      role: "background",
      startTransform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], visible: true },
    },
    {
      objectId: "obj-sofa",
      nodeName: "sofa",
      label: "sofa",
      role: "furniture",
      startTransform: { position: [0.1, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], visible: true },
    },
  ],
};

function writeScene(id = "sample", manifest: unknown = BASE_MANIFEST, sub = "") {
  const dir = path.join(dataDir, "reconstructions", id, sub);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "scene.json"), JSON.stringify(manifest, null, 2));
  for (const f of ["room.glb", "walls.glb", "floor.glb", "sofa.glb"]) {
    writeFileSync(path.join(dir, f), Buffer.from(`${f}-bytes`));
  }
  return dir;
}

function editBody(overrides: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    sceneId: "scene-test",
    baseSceneVersion: sceneVersion("sample"),
    updatedAt: new Date().toISOString(),
    objects: {
      "obj-sofa": {
        position: [0.3, 0, 0],
        quaternion: [0, 0, 0, 1],
        scale: [1, 1, 1],
        visible: true,
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "miniverse-scene-"));
  process.env.MINIVERSE_DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.MINIVERSE_DATA_DIR;
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows 下句柄释放有延迟，不影响断言
  }
});

describe("scene id 与目录探测", () => {
  it("只接受安全目录名", () => {
    expect(sceneIdValid("sample")).toBe(true);
    expect(sceneIdValid("f1014582-4012-4acc-b91c-38a9098fcdfe")).toBe(true);
    expect(sceneIdValid("../etc")).toBe(false);
    expect(sceneIdValid("a/b")).toBe(false);
    expect(sceneIdValid("")).toBe(false);
  });

  it("支持 scene.json 落在 mesh/ 子目录", () => {
    writeScene("sample", BASE_MANIFEST, "mesh");
    expect(loadSceneManifest("sample").sceneId).toBe("scene-test");
    expect(sceneAssetPath("sample", "sofa")).toContain(path.join("mesh", "sofa.glb"));
  });

  it("缺失场景报「不存在」（API 映射 404）", () => {
    mkdirSync(path.join(dataDir, "reconstructions", "sample"), { recursive: true });
    expect(() => loadSceneManifest("sample")).toThrow(/不存在/);
  });
});

describe("manifest 校验", () => {
  it("拒绝非 v1 schema", () => {
    writeScene("sample", { ...BASE_MANIFEST, schema: "miniverse.scene-manifest.v0" });
    expect(() => loadSceneManifest("sample")).toThrow(/不支持的场景 schema/);
  });

  it("拒绝空 objects 与重复 objectId", () => {
    writeScene("sample", { ...BASE_MANIFEST, objects: [] });
    expect(() => loadSceneManifest("sample")).toThrow(/缺少 objects/);

    writeScene("sample", {
      ...BASE_MANIFEST,
      objects: [BASE_MANIFEST.objects[0], BASE_MANIFEST.objects[0]],
    });
    expect(() => loadSceneManifest("sample")).toThrow(/objectId 重复/);
  });

  it("拒绝非法 startTransform", () => {
    writeScene("sample", {
      ...BASE_MANIFEST,
      objects: [
        {
          ...BASE_MANIFEST.objects[2],
          startTransform: { position: [0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], visible: true },
        },
      ],
    });
    expect(() => loadSceneManifest("sample")).toThrow(/startTransform 非法/);
  });
});

describe("资产解析", () => {
  it("声明资产与 room 别名都可取", () => {
    writeScene();
    expect(sceneAssetPath("sample", "sofa")).toContain("sofa.glb");
    // 清单只有 scene，room 是别名
    expect(sceneAssetPath("sample", "room")).toContain("room.glb");
    expect(Object.keys(listSceneAssets("sample")).sort()).toEqual(
      ["floor", "room", "scene", "sofa", "walls"],
    );
  });

  it("拒绝未声明资产、非 glb 与路径穿越", () => {
    writeScene("sample", {
      ...BASE_MANIFEST,
      assets: { scene: { path: "../room.glb" } },
    });
    expect(() => sceneAssetPath("sample", "scene")).toThrow(SceneValidationError);
    expect(() => sceneAssetPath("sample", "unknown")).toThrow(/未声明资产/);
    expect(() => sceneAssetPath("sample", "tex")).toThrow(/未声明资产/);
  });

  it("声明了但文件缺失的资产从 list 中略过", () => {
    const dir = writeScene();
    rmSync(path.join(dir, "sofa.glb"));
    const assets = listSceneAssets("sample");
    expect(assets.sofa).toBeUndefined();
    expect(assets.floor).toBeTruthy();
  });
});

describe("布局保存与版本冲突", () => {
  it("保存后能读回，并写 baseSceneVersion", () => {
    writeScene();
    const saved = saveEdits("sample", editBody());
    expect(saved.baseSceneVersion).toBe(sceneVersion("sample"));
    const stored = loadEdits("sample");
    expect(stored.stale).toBe(false);
    expect(stored.edits?.objects["obj-sofa"].position).toEqual([0.3, 0, 0]);
  });

  it("scene.json 变化后旧布局判 stale 且不返回", () => {
    writeScene();
    saveEdits("sample", editBody());
    writeFileSync(
      path.join(dataDir, "reconstructions", "sample", "scene.json"),
      JSON.stringify({ ...BASE_MANIFEST, generatedAt: "later" }, null, 2),
    );
    const stored = loadEdits("sample");
    expect(stored.stale).toBe(true);
    expect(stored.edits).toBeNull();
  });

  it("baseSceneVersion 不一致抛 SceneVersionConflict", () => {
    writeScene();
    expect(() => saveEdits("sample", editBody({ baseSceneVersion: "deadbeefdeadbeef" }))).toThrow(
      SceneVersionConflict,
    );
  });

  it("拒绝未知 objectId 与非法四元数", () => {
    writeScene();
    expect(() =>
      saveEdits("sample", editBody({ objects: { "obj-ghost": editBody().objects["obj-sofa"] } })),
    ).toThrow(/未知 objectId/);
    expect(() =>
      saveEdits(
        "sample",
        editBody({
          objects: {
            "obj-sofa": {
              position: [0, 0, 0],
              quaternion: [0, 0, 0, 0],
              scale: [1, 1, 1],
              visible: true,
            },
          },
        }),
      ),
    ).toThrow(/四元数长度为 0/);
  });

  it("清除布局幂等", () => {
    writeScene();
    saveEdits("sample", editBody());
    expect(clearEdits("sample")).toBe(true);
    expect(clearEdits("sample")).toBe(false);
    expect(loadEdits("sample").edits).toBeNull();
  });
});
