import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { checkRateLimit, resetRateLimitStore, type RateLimitStore } from "./rate-limit";
import { proxy } from "../../proxy";
import { AUTH_TOKEN_ENV } from "./auth";

const TOKEN = "rate-limit-token";

beforeEach(() => {
  resetRateLimitStore();
  vi.unstubAllEnvs();
});

function makeStore(): RateLimitStore {
  return new Map();
}

describe("checkRateLimit（固定窗口）", () => {
  it("窗口内达到上限后拒绝，Retry-After ≥ 1", () => {
    const store = makeStore();
    const clock = 1_000_000;
    const opts = { limit: 3, windowMs: 60_000, now: () => clock };
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit("k", opts, store).allowed).toBe(true);
    }
    const blocked = checkRateLimit("k", opts, store);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("窗口滑动后配额重置", () => {
    const store = makeStore();
    let clock = 1_000_000;
    const opts = { limit: 2, windowMs: 60_000, now: () => clock };
    checkRateLimit("k", opts, store);
    checkRateLimit("k", opts, store);
    expect(checkRateLimit("k", opts, store).allowed).toBe(false);
    clock += 60_001;
    expect(checkRateLimit("k", opts, store).allowed).toBe(true);
  });

  it("不同 key 配额独立", () => {
    const store = makeStore();
    const opts = { limit: 1, windowMs: 60_000, now: () => 0 };
    expect(checkRateLimit("a", opts, store).allowed).toBe(true);
    expect(checkRateLimit("b", opts, store).allowed).toBe(true);
    expect(checkRateLimit("a", opts, store).allowed).toBe(false);
  });
});

describe("proxy × 限流（POST /api/scenes）", () => {
  function post(): NextRequest {
    return new NextRequest("http://localhost:3000/api/scenes", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
  }

  it("超过阈值 → 429 + Retry-After 头", () => {
    vi.stubEnv(AUTH_TOKEN_ENV, TOKEN);
    vi.stubEnv("MINIVERSE_RATE_LIMIT", "5");
    let last = 200;
    for (let i = 0; i < 5; i++) last = proxy(post()).status;
    expect(last).toBe(200); // 前 5 次放行
    const blocked = proxy(post());
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });

  it("未鉴权请求被 401 挡下，不消耗配额", () => {
    vi.stubEnv(AUTH_TOKEN_ENV, TOKEN);
    vi.stubEnv("MINIVERSE_RATE_LIMIT", "1");
    const unauth = new NextRequest("http://localhost:3000/api/scenes", { method: "POST" });
    for (let i = 0; i < 10; i++) expect(proxy(unauth).status).toBe(401);
    // 配额未动：首次鉴权请求仍放行
    expect(proxy(post()).status).toBe(200);
  });

  it("轮换伪造 X-Forwarded-For 不能刷出新配额", () => {
    vi.stubEnv(AUTH_TOKEN_ENV, TOKEN);
    vi.stubEnv("MINIVERSE_RATE_LIMIT", "2");
    for (let i = 0; i < 2; i++) {
      expect(
        proxy(
          new NextRequest("http://localhost:3000/api/scenes", {
            method: "POST",
            headers: { authorization: `Bearer ${TOKEN}`, "x-forwarded-for": `10.0.0.${i}` },
          }),
        ).status,
      ).toBe(200);
    }
    expect(
      proxy(
        new NextRequest("http://localhost:3000/api/scenes", {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "x-forwarded-for": "10.0.0.999" },
        }),
      ).status,
    ).toBe(429);
  });

  it("GET 只读请求不进限流桶", () => {
    vi.stubEnv(AUTH_TOKEN_ENV, TOKEN);
    vi.stubEnv("MINIVERSE_RATE_LIMIT", "1");
    const get = new NextRequest("http://localhost:3000/api/scenes", { method: "GET" });
    for (let i = 0; i < 10; i++) expect(proxy(get).status).toBe(200);
    // 配额仍在：首次写请求放行
    expect(proxy(post()).status).toBe(200);
  });
});
