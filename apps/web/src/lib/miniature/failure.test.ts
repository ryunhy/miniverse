import { describe, expect, it } from "vitest";
import { explainMiniatureFailure, scanDiagnosticCodes } from "./failure";

describe("scanDiagnosticCodes", () => {
  it("按出现顺序识别诊断码并去重", () => {
    const codes = scanDiagnosticCodes(
      "微缩阶段未成功（unsupported：LOW_REGISTRATION｜LOW_LOOKDIR_COVERAGE｜LOW_REGISTRATION）",
    );
    expect(codes.map((c) => c.code)).toEqual(["LOW_REGISTRATION", "LOW_LOOKDIR_COVERAGE"]);
  });

  it("最多返回 5 个码", () => {
    const codes = scanDiagnosticCodes(
      "NO_IMAGES LOW_REGISTRATION LOW_LOOKDIR_COVERAGE CORRUPT_IMAGE DUPLICATE_SCENE UNSUPPORTED_ROOM NO_DEPTH_FOR_BAKE",
    );
    expect(codes).toHaveLength(5);
  });

  it("无码时返回空数组", () => {
    expect(scanDiagnosticCodes("没有码的普通文本")).toEqual([]);
    expect(scanDiagnosticCodes(null, undefined, "")).toEqual([]);
  });
});

describe("explainMiniatureFailure", () => {
  it("任务失败 + 可识别诊断码：给出原因/解除条件，并判不可原样重试", () => {
    const r = explainMiniatureFailure({
      status: "failed",
      error: "微缩阶段未成功（unsupported：LOW_LOOKDIR_COVERAGE）",
    });
    expect(r).not.toBeNull();
    expect(r!.retryableAsIs).toBe(false);
    expect(r!.summary).toContain("朝向覆盖不足");
    expect(r!.codes[0].recover).toContain("转身补拍");
  });

  it("已完成但微缩 unsupported（整链任务不回退主状态）：从 result.miniature 归因", () => {
    const r = explainMiniatureFailure({
      status: "completed",
      miniatureStatus: "unsupported",
      miniatureError: "判 unsupported：DUPLICATE_SCENE（39/39 张照片与已有场景重复）",
    });
    expect(r).not.toBeNull();
    expect(r!.codes[0].code).toBe("DUPLICATE_SCENE");
    expect(r!.retryableAsIs).toBe(false);
    expect(r!.summary).toContain("和已有场景重复");
  });

  it("只有不阻塞的 info 码时判可原样重试", () => {
    const r = explainMiniatureFailure({
      status: "failed",
      error: "LOW_AZIMUTH_COVERAGE 提示",
    });
    expect(r!.retryableAsIs).toBe(true);
  });

  it("识别不到诊断码时给兜底并允许先重试", () => {
    const r = explainMiniatureFailure({
      status: "failed",
      error: "worker 未知崩溃",
    });
    expect(r!.codes).toHaveLength(0);
    expect(r!.retryableAsIs).toBe(true);
    expect(r!.unknownReason).toBe("worker 未知崩溃");
  });

  it("正常完成且无失败语义时返回 null", () => {
    expect(
      explainMiniatureFailure({ status: "completed", miniatureStatus: "ok" }),
    ).toBeNull();
    expect(explainMiniatureFailure({ status: "processing" })).toBeNull();
  });
});
