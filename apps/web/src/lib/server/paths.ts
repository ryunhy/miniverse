import fs from "node:fs";
import path from "node:path";

/**
 * 统一的数据目录解析。
 * 优先级：MINIVERSE_DATA_DIR 环境变量（测试用）> 从 cwd 向上找到 monorepo 根（含
 * workspaces 声明的 package.json）下的 data/。
 */
export function findRepoRoot(startDir: string = process.cwd()): string {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg.name === "miniverse" && Array.isArray(pkg.workspaces)) return dir;
      } catch {
        // 非法 package.json，继续向上
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("无法定位 MiniVerse monorepo 根目录（未找到 name=miniverse 且含 workspaces 的 package.json）");
}

export function dataDir(): string {
  const root = findRepoRoot();
  return process.env.MINIVERSE_DATA_DIR || path.join(root, "data");
}

export function repoRoot(): string {
  return findRepoRoot();
}

export const SUBDIRS = [
  "uploads",
  "processed",
  "reconstructions",
  "scenes",
  "tasks",
  "demo",
] as const;

export function ensureDataDirs(): string {
  const base = dataDir();
  for (const sub of SUBDIRS) {
    fs.mkdirSync(path.join(base, sub), { recursive: true });
  }
  return base;
}

export function taskDir(taskId: string): string {
  // taskId 由服务端生成的 UUID，仍做白名单校验防目录穿越
  if (!/^[a-f0-9-]{36}$/i.test(taskId)) throw new Error("非法任务 ID");
  return path.join(dataDir(), "tasks", taskId);
}

export function uploadDir(taskId: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(taskId)) throw new Error("非法任务 ID");
  return path.join(dataDir(), "uploads", taskId);
}

export function reconstructionDir(taskId: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(taskId)) throw new Error("非法任务 ID");
  return path.join(dataDir(), "reconstructions", taskId);
}

export function processedDir(taskId: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(taskId)) throw new Error("非法任务 ID");
  return path.join(dataDir(), "processed", taskId);
}
