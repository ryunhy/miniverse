// @vitest-environment jsdom
/**
 * T-700006：上传器门槛对齐后端（min_images=20 硬门）与取消上传（AbortController）。
 * 阈值单一出处仍是 contracts.py::THRESHOLDS / THRESHOLDS.md，本测试只验证前端对齐，
 * 不定义新阈值。覆盖两条路径：门槛拦截（3 张禁用 / 20 张可提交）与上传中取消。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import MiniatureUploader from "./MiniatureUploader";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

function makeFiles(n: number): File[] {
  return Array.from(
    { length: n },
    (_, i) => new File([`photo-${i}`], `p${String(i).padStart(3, "0")}.jpg`, { type: "image/jpeg" })
  );
}

function selectFiles(n: number) {
  fireEvent.change(screen.getByTestId("photo-input"), { target: { files: makeFiles(n) } });
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  push.mockReset();
});

describe("门槛对齐后端（min_images=20）", () => {
  it("文案为 20~120 张，并区分朝向硬门与站位提示", () => {
    render(<MiniatureUploader />);
    expect(screen.getByText(/20~120 张/)).toBeTruthy();
    // 朝向覆盖是硬门：原地转身、至少半圈
    expect(screen.getByText(/原地转身拍摄/).textContent).toContain("至少半圈（180°）");
    // 站位环绕只是质量提示，不是硬门——两者不得混为一个指标
    expect(screen.getByText(/站位环绕/).textContent).toContain("不是硬门");
  });

  it("选 3 张：按钮禁用并提示还差多少，绝不放行", () => {
    render(<MiniatureUploader />);
    selectFiles(3);
    expect(screen.getByTestId("selected-count").textContent).toContain("已选 3 张");
    const submit = screen.getByTestId("submit-upload") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByTestId("threshold-hint").textContent).toContain("还差 17 张");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("选 19 张仍禁用；选 20 张可提交并跳转任务页", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ task: { id: "task-20" } }),
    });
    render(<MiniatureUploader />);
    selectFiles(19);
    expect((screen.getByTestId("submit-upload") as HTMLButtonElement).disabled).toBe(true);

    selectFiles(20);
    const submit = screen.getByTestId("submit-upload") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/miniature/task-20"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/reconstructions");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("上传中取消（AbortController）", () => {
  it("点取消：请求中止、UI 回可选态、无残留 busy，已选照片保留", async () => {
    let aborted = false;
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        })
    );
    render(<MiniatureUploader />);
    selectFiles(20);
    fireEvent.click(screen.getByTestId("submit-upload"));

    // 进入 busy：出现取消按钮，提交按钮显示上传中
    await waitFor(() => expect(screen.getByTestId("cancel-upload")).toBeTruthy());
    expect(screen.getByTestId("submit-upload").textContent).toContain("正在创建任务");

    fireEvent.click(screen.getByTestId("cancel-upload"));

    // 请求真的被中止，而不是只改 UI
    await waitFor(() => expect(aborted).toBe(true));
    // 回到可选态：busy 文案消失、取消按钮消失、提交按钮重新可用（20 张仍在）
    await waitFor(() => {
      const submit = screen.getByTestId("submit-upload") as HTMLButtonElement;
      expect(submit.disabled).toBe(false);
      expect(submit.textContent).toContain("开始生成微缩模型");
    });
    expect(screen.queryByTestId("cancel-upload")).toBeNull();
    expect(screen.getByTestId("selected-count").textContent).toContain("已选 20 张");
    // 取消不是错误：不展示错误文案，也不跳转
    expect(screen.queryByText(/创建失败/)).toBeNull();
    expect(push).not.toHaveBeenCalled();

    // 无残留 busy：可以立即再次提交
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ task: { id: "task-retry" } }),
    });
    fireEvent.click(screen.getByTestId("submit-upload"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/miniature/task-retry"));
  });

  it("取消后重新选择照片不受影响", async () => {
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError"))
          );
        })
    );
    render(<MiniatureUploader />);
    selectFiles(20);
    fireEvent.click(screen.getByTestId("submit-upload"));
    await waitFor(() => expect(screen.getByTestId("cancel-upload")).toBeTruthy());
    fireEvent.click(screen.getByTestId("cancel-upload"));
    await waitFor(() =>
      expect((screen.getByTestId("submit-upload") as HTMLButtonElement).disabled).toBe(false)
    );

    selectFiles(3);
    expect((screen.getByTestId("submit-upload") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("threshold-hint").textContent).toContain("还差 17 张");
  });
});