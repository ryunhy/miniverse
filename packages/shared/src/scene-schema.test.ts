import { describe, expect, it } from "vitest";
import {
  clampToRoom,
  createDemoScene,
  createEmptyScene,
  migrateV1Scene,
  safeParseScene,
  type SceneObject,
} from "./scene-schema";
import { ASSET_CATALOG, getAsset } from "./asset-catalog";

function validObject(overrides: Partial<SceneObject> = {}): SceneObject {
  return {
    id: "test-obj-1",
    assetId: "chair",
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    visible: true,
    origin: "user",
    materialOverrides: {},
    ...overrides,
  };
}

function validScene() {
  const scene = createEmptyScene("测试场景");
  return { ...scene, objects: [validObject()] };
}

describe("场景 Schema v2 校验", () => {
  it("合法场景通过校验并带默认值", () => {
    const result = safeParseScene(validScene());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schemaVersion).toBe(2);
      expect(result.data.objects[0].visible).toBe(true);
      expect(result.data.objects[0].origin).toBe("user");
    }
  });

  it("拒绝：非法颜色 / 负缩放 / 非法 origin / 越界房间", () => {
    const bad = safeParseScene({
      ...validScene(),
      objects: [validObject({ materialOverrides: { color: "#GGHHII" } })],
    });
    expect(bad.success).toBe(false);

    const badScale = safeParseScene({
      ...validScene(),
      objects: [validObject({ scale: [-1, 1, 1] })],
    });
    expect(badScale.success).toBe(false);

    const badOrigin = safeParseScene({
      ...validScene(),
      objects: [validObject({ origin: "magic" as SceneObject["origin"] })],
    });
    expect(badOrigin.success).toBe(false);

    const badRoom = safeParseScene({
      ...validScene(),
      room: { ...validScene().room, width: 100 },
    });
    expect(badRoom.success).toBe(false);
  });

  it("拒绝：schemaVersion 不符 / sceneId 非法", () => {
    expect(safeParseScene({ ...validScene(), schemaVersion: 3 }).success).toBe(false);
    expect(safeParseScene({ ...validScene(), sceneId: "not-a-uuid" }).success).toBe(false);
  });

  it("v1 场景可迁移：color → materialOverrides", () => {
    const v1 = {
      version: 1,
      room: { width: 5, depth: 4, height: 3, floorColor: "#B98B65", wallColor: "#F1DFC9" },
      objects: [
        {
          id: "bed-001",
          assetId: "bed_double",
          position: [-1.2, 0, -0.8],
          rotation: [0, 1.57, 0],
          scale: [1, 1, 1],
          color: "#E8D9C5",
        },
      ],
      lighting: { preset: "warm", intensity: 1.2 },
    };
    const migrated = migrateV1Scene(v1);
    expect(migrated).not.toBeNull();
    expect(migrated!.schemaVersion).toBe(2);
    expect(migrated!.objects[0].materialOverrides.color).toBe("#E8D9C5");
    expect(safeParseScene(migrated!).success).toBe(true);
  });

  it("演示场景合法且含 7 件家具", () => {
    const demo = createDemoScene();
    const result = safeParseScene(demo);
    expect(result.success).toBe(true);
    expect(demo.objects).toHaveLength(7);
    expect(demo.metadata.demo).toBe(true);
  });

  it("clampToRoom：越界家具被拉回房间内、y 不为负", () => {
    const scene = validScene();
    const room = scene.room; // 5×4
    const clamped = clampToRoom(room, validObject({ position: [99, -5, 99] }), [0.5, 0.5]);
    expect(clamped.position[0]).toBeLessThanOrEqual(room.width / 2);
    expect(clamped.position[2]).toBeLessThanOrEqual(room.depth / 2);
    expect(clamped.position[1]).toBeGreaterThanOrEqual(0);
  });
});

describe("素材白名单目录", () => {
  it("14 个素材，assetId 全局唯一", () => {
    expect(ASSET_CATALOG.length).toBe(14);
    expect(new Set(ASSET_CATALOG.map((a) => a.assetId)).size).toBe(ASSET_CATALOG.length);
  });

  it("演示场景只引用白名单 assetId", () => {
    for (const obj of createDemoScene().objects) {
      expect(getAsset(obj.assetId), `未知 assetId: ${obj.assetId}`).toBeDefined();
    }
  });
});
