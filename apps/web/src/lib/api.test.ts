import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getScene 读失败重试（仅 5xx/网络）", () => {
  it("瞬时 5xx 后成功：重试一次即返回场景", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(503, { error: "服务端暂不可用" }))
      .mockResolvedValueOnce(response(200, { scene: { sceneId: "ok" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.getScene("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.scene).toEqual({ sceneId: "ok" });
  });

  it("持续 5xx：有限次重试后抛 ApiError(status=503)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(503, { error: "boom" }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await api.getScene("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").catch((e: unknown) => e);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 次请求 + 2 次退避重试
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(503);
  });

  it("404 不重试：立即抛 ApiError(status=404)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(404, { error: "场景不存在" }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await api.getScene("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").catch((e: unknown) => e);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });

  it("网络错误：有限次重试后仍失败则抛出", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getScene("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
