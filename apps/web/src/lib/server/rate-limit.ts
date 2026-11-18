/**
 * API 写操作限流：按令牌计数的固定窗口。
 *
 * 为什么按令牌而不是按 IP：客户端可任意伪造/轮换 X-Forwarded-For，
 * 按 IP 计数等于给了绕过钥匙（每个假 IP 一个新桶）；而能通过鉴权的请求
 * 必持有真令牌，按令牌计数无法靠改头绕开。未鉴权请求在 proxy 里先被
 * 401 挡下、不进入限流，也不会在 Map 里留下任何键。
 *
 * 单实例内存实现：重启清零、多实例不共享——本应用当前是单机本地服务，
 * 上多实例部署时需换成共享存储（Redis 等），已在文档「已知没做的部分」注明。
 */
export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  now?: () => number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** 本窗口还剩多少次配额；被拒时为 0 */
  remaining: number;
  /** 被拒时建议等待的秒数（向上取整） */
  retryAfterSec: number;
}

export interface RateLimitStore {
  get(key: string): { windowStart: number; count: number } | undefined;
  set(key: string, bucket: { windowStart: number; count: number }): void;
}

/** 进程内默认桶：proxy 运行于常驻 Node 进程，模块级 Map 即全实例共享 */
const buckets = new Map<string, { windowStart: number; count: number }>();

export const RATE_LIMIT_ENV = "MINIVERSE_RATE_LIMIT";
export const RATE_WINDOW_ENV = "MINIVERSE_RATE_WINDOW_MS";
export const DEFAULT_LIMIT = 30;
export const DEFAULT_WINDOW_MS = 60_000;

export function rateLimitOptionsFromEnv(env: Record<string, string | undefined> = process.env): RateLimitOptions {
  const limit = Number.parseInt(env[RATE_LIMIT_ENV] ?? "", 10);
  const windowMs = Number.parseInt(env[RATE_WINDOW_ENV] ?? "", 10);
  return {
    limit: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT,
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : DEFAULT_WINDOW_MS,
  };
}

export function checkRateLimit(
  key: string,
  options: RateLimitOptions = rateLimitOptionsFromEnv(),
  store: RateLimitStore = buckets,
): RateLimitResult {
  const now = (options.now ?? Date.now)();
  const bucket = store.get(key);
  if (!bucket || now - bucket.windowStart >= options.windowMs) {
    store.set(key, { windowStart: now, count: 1 });
    return { allowed: true, remaining: options.limit - 1, retryAfterSec: 0 };
  }
  if (bucket.count >= options.limit) {
    const retryAfterMs = bucket.windowStart + options.windowMs - now;
    return { allowed: false, remaining: 0, retryAfterSec: Math.ceil(retryAfterMs / 1000) };
  }
  bucket.count += 1;
  store.set(key, bucket);
  return { allowed: true, remaining: options.limit - bucket.count, retryAfterSec: 0 };
}

/** 仅测试用：清空进程内桶 */
export function resetRateLimitStore(): void {
  buckets.clear();
}
