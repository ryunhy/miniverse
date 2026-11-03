import { describe, expect, it } from "vitest";
import { decideAutosave } from "./autosave-decision";

describe("自动保存决策（读失败退化为只读时禁止回写）", () => {
  it("未就绪或场景未加载：不写", () => {
    expect(decideAutosave({ ready: false, hasScene: true, loadSource: "server" })).toBe("skip-not-ready");
    expect(decideAutosave({ ready: false, hasScene: false, loadSource: "local" })).toBe("skip-not-ready");
    expect(decideAutosave({ ready: true, hasScene: false, loadSource: "server" })).toBe("skip-not-ready");
  });

  it("loadSource=local（读失败回退的本地旧镜像）：禁止自动回写", () => {
    expect(decideAutosave({ ready: true, hasScene: true, loadSource: "local" })).toBe("skip-readonly-local");
  });

  it("loadSource=server（正常加载）：允许自动保存", () => {
    expect(decideAutosave({ ready: true, hasScene: true, loadSource: "server" })).toBe("write");
  });

  it("loadSource=unknown 但已有场景：保持原有行为（写）", () => {
    expect(decideAutosave({ ready: true, hasScene: true, loadSource: "unknown" })).toBe("write");
  });
});
