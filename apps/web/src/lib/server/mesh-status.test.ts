import { describe, expect, it } from "vitest";
import { resolveMeshStatus, type MeshStatusInput } from "./mesh-status";

/** 只写关心的字段，其余取「未开网格、无产物」的基线 */
function input(over: Partial<MeshStatusInput> = {}): MeshStatusInput {
  return {
    glbBytes: 0,
    requested: false,
    taskStatus: "completed",
    workerStage: null,
    retryStatus: null,
    retryError: null,
    meshError: null,
    ...over,
  };
}

describe("resolveMeshStatus 判断顺序", () => {
  it("重试进行中优先于旧产物：旧 mesh.glb 还在也要报 running", () => {
    expect(resolveMeshStatus(input({ glbBytes: 1234, requested: true, taskStatus: "completed", retryStatus: "processing" })))
      .toEqual({ state: "running", error: null, phase: "retry" });
  });

  it("重试失败优先于旧产物：不能让 ready 掩盖失败", () => {
    expect(resolveMeshStatus(input({ glbBytes: 1234, requested: true, retryStatus: "failed", retryError: "TSDF 生成空网格" })))
      .toEqual({ state: "failed", error: "TSDF 生成空网格", phase: null });
  });

  it("无重试记录且产物存在时返回 ready", () => {
    expect(resolveMeshStatus(input({ glbBytes: 1234, requested: true, taskStatus: "completed" })))
      .toEqual({ state: "ready", error: null, phase: null });
  });

  it("单独重试进行中返回 running/retry", () => {
    expect(resolveMeshStatus(input({ requested: true, retryStatus: "processing" })))
      .toEqual({ state: "running", error: null, phase: "retry" });
  });

  it("单独重试失败返回 failed，并透出错误", () => {
    expect(resolveMeshStatus(input({ requested: true, retryStatus: "failed", retryError: "找不到上次重建的高斯点云" })))
      .toEqual({ state: "failed", error: "找不到上次重建的高斯点云", phase: null });
  });

  it("重试失败但没有错误文案时给兜底文案", () => {
    expect(resolveMeshStatus(input({ requested: true, retryStatus: "failed" })).error).toBe("网格生成失败（详见日志）");
  });

  it("failed 优先于整链路 running：有网格错误时不报 running", () => {
    expect(resolveMeshStatus(input({ requested: true, taskStatus: "processing", workerStage: "mesh", meshError: "CUDA out of memory" })))
      .toEqual({ state: "failed", error: "CUDA out of memory", phase: null });
  });

  it("整链路跑到网格阶段返回 running/inline", () => {
    expect(resolveMeshStatus(input({ requested: true, taskStatus: "processing", workerStage: "mesh" })))
      .toEqual({ state: "running", error: null, phase: "inline" });
  });

  it("还没进入网格阶段（export）不报 running", () => {
    expect(resolveMeshStatus(input({ requested: true, taskStatus: "processing", workerStage: "export" })).state).toBe("absent");
  });

  it("processing 但拿不到 stage 时不报 running", () => {
    expect(resolveMeshStatus(input({ requested: true, taskStatus: "processing", workerStage: null })).state).toBe("absent");
  });

  it("没勾网格却在 processing 的 mesh 阶段时不报 running", () => {
    expect(resolveMeshStatus(input({ requested: false, taskStatus: "processing", workerStage: "mesh" })).state).toBe("absent");
  });

  it("开了网格且已完成但无产物返回 missing", () => {
    expect(resolveMeshStatus(input({ requested: true, taskStatus: "completed" })))
      .toEqual({ state: "missing", error: null, phase: null });
  });

  it("没开网格且已完成返回 absent", () => {
    expect(resolveMeshStatus(input({ requested: false, taskStatus: "completed" })))
      .toEqual({ state: "absent", error: null, phase: null });
  });
});
