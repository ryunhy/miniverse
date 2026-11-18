import { timingSafeEqual } from "node:crypto";

/**
 * API 写操作鉴权：单共享令牌（本地单用户工具的威胁模型）。
 *
 * - 令牌来自环境变量 MINIVERSE_API_TOKEN；未配置时 fail-closed（一律 401），
 *   不存在「忘配环境反而全放行」的旁路。
 * - 比较用 timingSafeEqual，避免时序侧信道；长度不匹配直接判否（泄漏的只是长度）。
 * - 只做「有没有带对令牌」这一件事；限流在 rate-limit.ts，门禁编排在本包外的 proxy.ts。
 */
export const AUTH_TOKEN_ENV = "MINIVERSE_API_TOKEN";

export type AuthEnv = Record<string, string | undefined>;

export function extractBearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  // scheme 不区分大小写（RFC 7235），"bearer xxx" 与 "Bearer xxx" 等价
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

export function isAuthorized(req: Request, env: AuthEnv = process.env): boolean {
  const expected = env[AUTH_TOKEN_ENV];
  const provided = extractBearerToken(req);
  if (!expected || !provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
