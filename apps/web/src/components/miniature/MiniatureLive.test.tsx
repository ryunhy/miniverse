// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { applyAssetCheck, ASSET_CHECK_STATUS, deriveMiniatureView, syntheticFixture, type AssetCheck } from "@/lib/miniature/stages";
import MiniatureLive from "./MiniatureLive";

vi.mock("@/components/mesh/MeshViewer", () => ({ default: () => null }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const failingChecks: Exclude<AssetCheck, { kind: "ok" }>[] = [
  { kind: "unpublished" },
  { kind: "asset_missing", detail: "模型文件缺失" },
  { kind: "manifest_invalid", detail: "清单版本未知" },
];

it.each(failingChecks)("显示 $kind 的详情和阶段状态", async (check) => {
  const view = applyAssetCheck(deriveMiniatureView(syntheticFixture()), check);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ view }, {
    status: ASSET_CHECK_STATUS[check.kind],
  })));
  render(<MiniatureLive taskId="synthetic" />);
  expect(await screen.findByText(view.banner.text)).toBeTruthy();
  expect(screen.queryByText("正在读取任务状态…")).toBeNull();
  expect(screen.queryByRole("link", { name: /下载/ })).toBeNull();
});
