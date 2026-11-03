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

describe("saveScene 版本号 CAS（If-Match）", () => {
  const scene = (revision: number) => ({ sceneId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", metadata: { revision } });

  it("默认携带本地 revision 作为 If-Match，并返回服务端最新 revision", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, { scene: {}, revision: 3 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await api.saveScene(scene(2) as never);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/scenes/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>)["If-Match"]).toBe('"2"');
    expect(res.revision).toBe(3);
  });

  it("显式 expectedRevision 优先（冲突对话框强制覆盖用最新版本号）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, { scene: {}, revision: 5 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.saveScene(scene(1) as never, { expectedRevision: 4 });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["If-Match"]).toBe('"4"');
  });

  it("409 抛出带 payload 的 ApiError（含服务端 revision 与 scene）", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        response(409, {
          error: "版本冲突：场景已被其他会话修改",
          code: "revision_conflict",
          revision: 7,
          scene: { sceneId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", metadata: { revision: 7 } },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const error = await api.saveScene(scene(2) as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).payload).toMatchObject({ code: "revision_conflict", revision: 7 });
  });
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
