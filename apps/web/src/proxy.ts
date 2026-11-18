import { NextResponse, type NextRequest } from "next/server";
import { isAuthorized } from "@/lib/server/auth";
import { checkRateLimit } from "@/lib/server/rate-limit";

/**
 * API 门禁（Next.js 16 的 proxy 约定，旧名 middleware 已弃用：
 * 见 node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/{proxy,middleware}.md）。
 *
 * 只拦「写」：POST / PUT / PATCH / DELETE 落在 /api/reconstructions 与 /api/scenes
 * 子树上的请求，必须携带 Authorization: Bearer <MINIVERSE_API_TOKEN>，且受固定窗口限流。
 * GET / HEAD / OPTIONS（所有只读接口）与 /api/health、页面路由不经过本文件，不受影响。
 *
 * 顺序：先鉴权（401）后限流（429）——未鉴权请求不消耗配额、不留限流痕迹。
 */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function proxy(req: NextRequest) {
  if (!WRITE_METHODS.has(req.method.toUpperCase())) {
    return NextResponse.next();
  }

  if (!isAuthorized(req)) {
    return Response.json(
      { error: "未鉴权：写操作需要 Authorization: Bearer <MINIVERSE_API_TOKEN>" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
    );
  }

  const rl = checkRateLimit(extractRateKey(req));
  if (!rl.allowed) {
    return Response.json(
      { error: `请求过于频繁：写操作限流已触发，请在 ${rl.retryAfterSec} 秒后重试` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  return NextResponse.next();
}

/** 限流按令牌计数：令牌相同则共享配额，改 X-Forwarded-For 不能刷出新桶 */
function extractRateKey(req: NextRequest): string {
  return req.headers.get("authorization") ?? "";
}

export const config = {
  matcher: ["/api/reconstructions/:path*", "/api/scenes/:path*"],
};
