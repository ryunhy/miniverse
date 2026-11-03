import { describe, expect, it } from "vitest";
import { decideAutosave, snapshotScene } from "./autosave-decision";

describe("自动保存决策（读失败退化为只读时禁止回写）", () => {
  it("未就绪或场景未加载：不写", () => {
    expect(decideAutosave({ ready: false, hasScene: true, loadSource: "server", dirty: true })).toBe("skip-not-ready");
    expect(decideAutosave({ ready: false, hasScene: false, loadSource: "local", dirty: false })).toBe("skip-not-ready");
    expect(decideAutosave({ ready: true, hasScene: false, loadSource: "server", dirty: false })).toBe("skip-not-ready");
  });

  it("loadSource=local（读失败回退的本地旧镜像）：禁止自动回写（即使有改动）", () => {
    expect(decideAutosave({ ready: true, hasScene: true, loadSource: "local", dirty: true })).toBe("skip-readonly-local");
    expect(decideAutosave({ ready: true, hasScene: true, loadSource: "local", dirty: false })).toBe("skip-readonly-local");
  });

  it("loadSource=server 且内容相对基线有变化：允许自动保存", () => {
    expect(decideAutosave({ ready: true, hasScene: true, loadSource: "server", dirty: true })).toBe("write");
  });

  it("loadSource=unknown 但有改动：保持原有行为（写）", () => {
    expect(decideAutosave({ ready: true, hasScene: true, loadSource: "unknown", dirty: true })).toBe("write");
  });

  it("加载成功且内容与服务端一致（dirty=false）：不写，避免加载后盲写覆盖别处改动", () => {
    expect(decideAutosave({ ready: true, hasScene: true, loadSource: "server", dirty: false })).toBe("skip-unchanged");
    expect(decideAutosave({ ready: true, hasScene: true, loadSource: "unknown", dirty: false })).toBe("skip-unchanged");
  });
});

describe("场景快照（dirty 比对）", () => {
  it("同一内容序列化结果相等，内容变化后不相等", () => {
    const scene = { room: { width: 5 }, objects: [{ id: "a", position: [0, 0, 0] }] };
    const baseline = snapshotScene(scene);
    expect(snapshotScene({ ...scene })).toBe(baseline);

    const moved = { ...scene, objects: [{ id: "a", position: [1, 0, 0] }] };
    expect(snapshotScene(moved)).not.toBe(baseline);
  });

  it("新增 / 删除家具都会让快照变化（不漏保存）", () => {
    const scene = { objects: [{ id: "a" }] };
    const baseline = snapshotScene(scene);
    expect(snapshotScene({ objects: [{ id: "a" }, { id: "b" }] })).not.toBe(baseline);
    expect(snapshotScene({ objects: [] })).not.toBe(baseline);
  });

  it("相机浮点舍入噪声不算内容变化，真实位移仍算变化", () => {
    const baseline = snapshotScene({ camera: { position: [7.5, 6.6, 7.6] } });
    // OrbitControls 挂载后回写的末位噪声（实测 diff 值）
    const noise = snapshotScene({ camera: { position: [7.500000000000001, 6.599999999999999, 7.6000000000000005] } });
    expect(noise).toBe(baseline);
    // 1mm 真实位移必须识别为变化，避免吞掉保存
    const moved = snapshotScene({ camera: { position: [7.6, 6.6, 7.6] } });
    expect(moved).not.toBe(baseline);
  });
});
