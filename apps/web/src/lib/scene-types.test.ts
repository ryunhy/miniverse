import { describe, expect, it } from "vitest";
import { inferObjectRole, isFiniteQuat, isFiniteVec3 } from "./scene-types";

describe("scene-manifest 客户端类型守卫", () => {
  it("role 显式声明时直接采用", () => {
    expect(inferObjectRole({ role: "background", label: "sofa", nodeName: "sofa", objectId: "obj-x" })).toBe(
      "background",
    );
    expect(inferObjectRole({ role: "furniture", label: "wall", nodeName: "wall", objectId: "obj-x" })).toBe(
      "furniture",
    );
  });

  it("缺失 role 时按 label/nodeName 兜底（中英文）", () => {
    expect(inferObjectRole({ label: "wall", nodeName: "walls", objectId: "obj-walls" })).toBe("background");
    expect(inferObjectRole({ label: "地板", nodeName: "floor", objectId: "obj-floor" })).toBe("background");
    expect(inferObjectRole({ label: "sofa", nodeName: "sofa", objectId: "obj-sofa" })).toBe("furniture");
    expect(inferObjectRole({ label: "椅子", nodeName: "chair", objectId: "obj-chair" })).toBe("furniture");
  });

  it("拒绝非有限数值", () => {
    expect(isFiniteVec3([0, 1, 2])).toBe(true);
    expect(isFiniteVec3([0, Number.NaN, 2])).toBe(false);
    expect(isFiniteVec3([0, 1])).toBe(false);
    expect(isFiniteQuat([0, 0, 0, 1])).toBe(true);
    expect(isFiniteQuat([0, 0, 0, Number.POSITIVE_INFINITY])).toBe(false);
  });
});
