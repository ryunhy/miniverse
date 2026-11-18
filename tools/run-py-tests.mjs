#!/usr/bin/env node
// `npm run test:py` 的入口：优先用仓库根 .venv 的解释器，其次退回 PATH 上的 python3/python。
// 透传额外参数给 pytest，例如：npm run test:py -- -k sfm_merge
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  path.join(repo, ".venv", "Scripts", "python.exe"), // Windows venv
  path.join(repo, ".venv", "bin", "python"), // POSIX venv
  "python3",
  "python",
];

const args = ["-m", "pytest", "services/reconstruction", ...process.argv.slice(2)];

for (const py of candidates) {
  if (path.isAbsolute(py) && !existsSync(py)) continue;
  const r = spawnSync(py, args, { stdio: "inherit", cwd: repo });
  if (r.error && r.error.code === "ENOENT") continue; // PATH 候选不存在，试下一个
  process.exit(r.status ?? 1);
}
console.error("未找到可用的 Python 解释器（尝试过仓库 .venv 与 PATH 上的 python3/python）。");
process.exit(1);
