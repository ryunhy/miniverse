import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { extractBearerToken, isAuthorized, AUTH_TOKEN_ENV } from "./auth";
import { proxy, config } from "../../proxy";

const TOKEN = "unit-test-token";
const POST_URL = "http://localhost:3000/api/reconstructions";

afterEach(() => {
  vi.unstubAllEnvs();
});

function postReq(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(POST_URL, { method: "POST", headers });
}

describe("extractBearerToken", () => {
  it("无 Authorization 头 → null", () => {
    expect(extractBearerToken(postReq())).toBeNull();
  });

  it("Bearer scheme 大小写不敏感", () => {
    expect(extractBearerToken(postReq({ authorization: `bearer ${TOKEN}` }))).toBe(TOKEN);
    expect(extractBearerToken(postReq({ authorization: `BEARER ${TOKEN}` }))).toBe(TOKEN);
  });

  it("非 Bearer scheme（Basic 等）→ null", () => {
    expect(extractBearerToken(postReq({ authorization: `Basic ${TOKEN}` }))).toBeNull();
  });
});

describe("isAuthorized", () => {
  it(`${AUTH_TOKEN_ENV} 未配置 → fail-closed：带了令牌也不通过`, () => {
    expect(isAuthorized(postReq({ authorization: `Bearer ${TOKEN}` }), {})).toBe(false);
  });

  it("配置了环境变量但请求没带令牌 → false", () => {
    expect(isAuthorized(postReq(), { [AUTH_TOKEN_ENV]: TOKEN })).toBe(false);
  });

  it("令牌错误 → false；正确 → true", () => {
    expect(isAuthorized(postReq({ authorization: "Bearer wrong" }), { [AUTH_TOKEN_ENV]: TOKEN })).toBe(false);
    expect(isAuthorized(postReq({ authorization: `Bearer ${TOKEN}` }), { [AUTH_TOKEN_ENV]: TOKEN })).toBe(true);
  });

  it("令牌通过非标准头传入（伪装 x-auth-token）→ false", () => {
    expect(isAuthorized(postReq({ "x-auth-token": TOKEN }), { [AUTH_TOKEN_ENV]: TOKEN })).toBe(false);
  });

  it("长度不同不抛异常（timingSafeEqual 前置长度检查）", () => {
    expect(isAuthorized(postReq({ authorization: "Bearer short" }), { [AUTH_TOKEN_ENV]: TOKEN })).toBe(false);
  });
});

describe("proxy 门禁（POST /api/reconstructions）", () => {
  it("未鉴权 → 401 + WWW-Authenticate", () => {
    vi.stubEnv(AUTH_TOKEN_ENV, TOKEN);
    const res = proxy(postReq());
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("令牌错误 → 401", () => {
    vi.stubEnv(AUTH_TOKEN_ENV, TOKEN);
    expect(proxy(postReq({ authorization: "Bearer wrong" })).status).toBe(401);
  });

  it("已鉴权 → 放行（200 next，进 route handler 走 201 创建）", () => {
    vi.stubEnv(AUTH_TOKEN_ENV, TOKEN);
    const res = proxy(postReq({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("matcher 只覆盖 reconstructions / scenes 子树，不含 /api/health 与页面", () => {
    expect(config.matcher).toEqual(["/api/reconstructions/:path*", "/api/scenes/:path*"]);
  });

  it("只读 GET 即使命中 matcher 前缀也放行", () => {
    vi.stubEnv(AUTH_TOKEN_ENV, TOKEN);
    const get = new NextRequest("http://localhost:3000/api/reconstructions", { method: "GET" });
    expect(proxy(get).status).toBe(200);
    const getScene = new NextRequest("http://localhost:3000/api/scenes", { method: "GET" });
    expect(proxy(getScene).status).toBe(200);
  });

  it("方法伪造头不影响判定：X-HTTP-Method-Override: GET 的 POST 仍按 POST 拦", () => {
    vi.stubEnv(AUTH_TOKEN_ENV, TOKEN);
    const req = new NextRequest(POST_URL, {
      method: "POST",
      headers: { "x-http-method-override": "GET" },
    });
    expect(proxy(req).status).toBe(401);
  });
});
