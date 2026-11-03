import { beforeEach, describe, expect, it } from "vitest";
import { createDemoScene, createEmptyScene, parseScene } from "@shared/scene-schema";
import { useEditorStore } from "./editor-store";

const SCENE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

/** 每个用例前恢复干净的编辑器状态（store 是模块级单例） */
beforeEach(() => {
  useEditorStore.setState({
    sceneId: null,
    scene: null,
    selectedId: null,
    past: [],
    future: [],
    savedAt: null,
    storageMode: "unknown",
    loadSource: "unknown",
    savedBaseline: null,
  });
});

describe("编辑器 store：revision 透传（避免下一次保存必然 409）", () => {
  it("resetToDemo 沿用当前 revision 与 sceneId，只替换内容", () => {
    const current = parseScene({
      ...createDemoScene(),
      sceneId: SCENE_ID,
      metadata: { ...createDemoScene().metadata, revision: 5, name: "我的场景" },
    });
    useEditorStore.setState({ scene: current, sceneId: SCENE_ID });

    useEditorStore.getState().resetToDemo();

    const next = useEditorStore.getState().scene!;
    expect(next.metadata.revision).toBe(5);
    expect(next.sceneId).toBe(SCENE_ID);
    expect(next.metadata.demo).toBe(true);
    expect(next.objects).toHaveLength(7);
    // 重置进入撤销栈，可回滚
    expect(useEditorStore.getState().past).toHaveLength(1);
  });

  it("loadSceneJson 同 sceneId 时沿用当前 revision（导入不应把版本号打回 0）", () => {
    const current = parseScene({
      ...createEmptyScene("原场景"),
      sceneId: SCENE_ID,
      metadata: { ...createEmptyScene("原场景").metadata, revision: 3 },
    });
    useEditorStore.setState({ scene: current, sceneId: SCENE_ID });

    // 导入内容自身 revision=0（比如从导出文件重新导入）
    const imported = parseScene({
      ...createEmptyScene("导入内容"),
      sceneId: SCENE_ID,
      metadata: { ...createEmptyScene("导入内容").metadata, revision: 0 },
    });
    const result = useEditorStore.getState().loadSceneJson(imported);

    expect(result.ok).toBe(true);
    const next = useEditorStore.getState().scene!;
    expect(next.metadata.revision).toBe(3);
    expect(next.metadata.name).toBe("导入内容");
  });

  it("loadSceneJson 换 sceneId 时使用导入内容自己的 revision（不串用旧版本号）", () => {
    const current = parseScene({
      ...createEmptyScene("原场景"),
      sceneId: SCENE_ID,
      metadata: { ...createEmptyScene("原场景").metadata, revision: 9 },
    });
    useEditorStore.setState({ scene: current, sceneId: SCENE_ID });

    const imported = parseScene({
      ...createEmptyScene("另一个场景"),
      sceneId: OTHER_ID,
      metadata: { ...createEmptyScene("另一个场景").metadata, revision: 2 },
    });
    const result = useEditorStore.getState().loadSceneJson(imported);

    expect(result.ok).toBe(true);
    const next = useEditorStore.getState().scene!;
    expect(next.sceneId).toBe(OTHER_ID);
    expect(next.metadata.revision).toBe(2);
    expect(useEditorStore.getState().sceneId).toBe(OTHER_ID);
  });

  it("非法 JSON 导入失败且不改变当前场景", () => {
    const current = createEmptyScene("原场景");
    useEditorStore.setState({ scene: current, sceneId: current.sceneId });

    const result = useEditorStore.getState().loadSceneJson({ schemaVersion: 99 });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(useEditorStore.getState().scene).toBe(current);
    expect(useEditorStore.getState().scene!.metadata.revision).toBe(0);
  });
});
