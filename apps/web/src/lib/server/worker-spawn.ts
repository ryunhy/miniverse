import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dataDir, repoRoot, taskDir } from "./paths";
import { getTaskStore } from "./task-store";

/**
 * Python 重建 Worker 派发。
 * - 单飞：同一时刻只允许一个 GPU 任务（lock 文件 + PID 存活检查）
 * - worker 通过 data/tasks/<id>/ 下的文件与 Web 端解耦通信：
 *   input.json（下发）、status.json（上报）、worker.log（日志）、cancel.flag（取消）
 * - 本机无 Python/依赖时任务置为 failed 并写明原因，不伪造成功
 */

const LOCK_FILE = () => path.join(path.dirname(taskDir("00000000-0000-0000-0000-000000000000")), ".worker.lock");

export interface PythonCandidate {
  cmd: string;
  args: string[];
}

/** 探测可用的 Python 解释器（python / py -3） */
export function findPython(): PythonCandidate | null {
  for (const candidate of [
    { cmd: "python", args: [] },
    { cmd: "py", args: ["-3"] },
  ]) {
    try {
      const r = spawnSync(candidate.cmd, [...candidate.args, "--version"], {
        encoding: "utf8",
        timeout: 8000,
        windowsHide: true,
      });
      if (r.status === 0 && /Python 3/i.test(r.stdout + r.stderr)) return candidate;
    } catch {
      // 继续探测
    }
  }
  return null;
}

export interface WslCandidate {
  distro: string;
}

/** wsl.exe -l -q 的输出可能是 UTF-16LE，按空字节判断编码 */
function decodeWslList(buf: Buffer): string[] {
  const text = buf.includes(0) ? buf.toString("utf16le") : buf.toString("utf8");
  return text
    .replace(/\0/g, "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 探测可用于重建的 WSL 发行版。
 * 重建栈（torch / nerfstudio / COLMAP）只存在于 WSL，Windows 侧 Python 没有依赖，
 * 因此 Windows 上默认只派发到 WSL；MINIVERSE_WSL_DISTRO 指定发行版，MINIVERSE_WORKER=python 强制回退本地 Python。
 * 判定标准是 conda 环境 miniverse 里真有 python——docker-desktop 这类系统发行版会被自动跳过。
 */
export const WSL_ENV_PROBE = "test -x /root/miniconda3/envs/miniverse/bin/python";

let cachedWsl: WslCandidate | null | undefined;

export function listWslDistros(): string[] {
  try {
    const r = spawnSync("wsl.exe", ["-l", "-q"], { timeout: 8000, windowsHide: true });
    if (r.status !== 0 || !r.stdout) return [];
    return decodeWslList(r.stdout);
  } catch {
    return [];
  }
}

function wslHasEnv(distro: string): boolean {
  try {
    const r = spawnSync("wsl.exe", ["-d", distro, "-e", "bash", "-lc", WSL_ENV_PROBE], {
      timeout: 20000,
      windowsHide: true,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function findWsl(): WslCandidate | null {
  if (process.platform !== "win32") return null;
  if ((process.env.MINIVERSE_WORKER ?? "").toLowerCase() === "python") return null;
  if (cachedWsl !== undefined) return cachedWsl;

  const distros = listWslDistros().filter((d) => !/^docker-desktop/i.test(d));
  const wanted = process.env.MINIVERSE_WSL_DISTRO?.trim();
  if (wanted) {
    cachedWsl = distros.includes(wanted) && wslHasEnv(wanted) ? { distro: wanted } : null;
    return cachedWsl;
  }
  for (const distro of distros) {
    if (wslHasEnv(distro)) {
      cachedWsl = { distro };
      return cachedWsl;
    }
  }
  return null;
}

/** Windows 路径 → WSL 路径（C:\a\b → /mnt/c/a/b） */
export function toWslPath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p.replace(/\\/g, "/");
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

/** WSL 内的 worker 启动脚本：激活 conda env → 进服务目录 → 执行 run-task */
export function buildWslScript(taskId: string, repo: string, data: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    "set -e",
    // 分离式启动的 wsl.exe 会丢掉转到 Windows 句柄上的 stdout，日志必须由 Linux 侧直接写文件
    `LOG=${q(`${data}/tasks/${taskId}/worker.log`)}`,
    'mkdir -p "$(dirname "$LOG")"',
    'exec >> "$LOG" 2>&1',
    'if [ -f /root/miniconda3/etc/profile.d/conda.sh ]; then source /root/miniconda3/etc/profile.d/conda.sh;',
    'elif [ -f "$HOME/miniconda3/etc/profile.d/conda.sh" ]; then source "$HOME/miniconda3/etc/profile.d/conda.sh"; fi',
    'command -v conda >/dev/null 2>&1 || { echo "[worker] WSL 中未找到 conda，无法启动重建环境"; exit 3; }',
    "conda activate miniverse",
    // ninja 并行编译曾在 WSL 内存限制下被 OOM 杀掉，2 个作业是这台机器的稳定值
    "export MAX_JOBS=2",
    'export TORCH_EXTENSIONS_DIR="${TORCH_EXTENSIONS_DIR:-$HOME/torch_ext}"',
    `cd ${q(`${repo}/services/reconstruction`)}`,
    `exec python -u -m app.main run-task ${q(taskId)} --data-dir ${q(data)}`,
  ].join("\n");
}

function isPidAlive(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], {
        encoding: "utf8",
        timeout: 8000,
        windowsHide: true,
      });
      return (r.stdout || "").includes(String(pid));
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function workerBusy(): { busy: boolean; pid?: number } {
  const lock = LOCK_FILE();
  try {
    if (!fs.existsSync(lock)) return { busy: false };
    const pid = parseInt(fs.readFileSync(lock, "utf8").trim(), 10);
    if (Number.isFinite(pid) && isPidAlive(pid)) return { busy: true, pid };
    fs.unlinkSync(lock); // 僵尸锁清理
    return { busy: false };
  } catch {
    return { busy: false };
  }
}

export interface SpawnResult {
  ok: boolean;
  pid?: number;
  error?: string;
}

/** 派发任务给 Python worker；返回是否成功启动进程 */
export function spawnReconstructionWorker(taskId: string, params: Record<string, unknown>): SpawnResult {
  const store = getTaskStore();
  const busy = workerBusy();
  if (busy.busy) {
    return { ok: false, error: `已有重建任务在运行（PID ${busy.pid}），本任务保持排队` };
  }

  const forceLocalPython = (process.env.MINIVERSE_WORKER ?? "").toLowerCase() === "python";
  const wsl = findWsl();
  // Windows 上默认不派发到本地 Python：那里没有 torch/nerfstudio/COLMAP，只会产生假失败
  const py = wsl || (process.platform === "win32" && !forceLocalPython) ? null : findPython();
  if (!wsl && !py) {
    let error: string;
    if (process.platform === "win32") {
      const distros = listWslDistros();
      error = distros.length
        ? `WSL 发行版（${distros.join(" / ")}）中找不到 conda 环境 miniverse（须存在 /root/miniconda3/envs/miniverse/bin/python），见 docs/INSTALL-Windows-WSL2.md`
        : "未检测到 WSL 发行版：Windows 上重建需要 WSL2 + Ubuntu，见 docs/INSTALL-Windows-WSL2.md";
    } else {
      error = "未找到可用的 Python 3 解释器：请按 docs/INSTALL-Windows-WSL2.md 配置重建环境";
    }
    return { ok: false, error };
  }

  const dir = taskDir(taskId);
  fs.mkdirSync(dir, { recursive: true });

  // 取消标记清障（重试场景）
  const cancelFlag = path.join(dir, "cancel.flag");
  if (fs.existsSync(cancelFlag)) fs.unlinkSync(cancelFlag);

  // 下发输入
  const inputPath = path.join(dir, "input.json");
  const photoDir = path.join(repoRoot(), "data", "uploads", taskId);
  fs.writeFileSync(
    inputPath,
    JSON.stringify({ task_id: taskId, photo_dir: photoDir, params, repo_root: repoRoot() }, null, 2),
    "utf8"
  );

  // 清空上次的 worker 上报状态
  const statusPath = path.join(dir, "status.json");
  if (fs.existsSync(statusPath)) fs.unlinkSync(statusPath);

  const logFd = fs.openSync(path.join(dir, "worker.log"), "a");
  try {
    const runner = wsl
      ? {
          cmd: "wsl.exe",
          args: [
            "-d",
            wsl.distro,
            "-e",
            "bash",
            "-lc",
            buildWslScript(taskId, toWslPath(repoRoot()), toWslPath(dataDir())),
          ],
          label: `WSL:${wsl.distro}`,
        }
      : {
          cmd: py!.cmd,
          args: [
            ...py!.args,
            "-u",
            path.join(repoRoot(), "services", "reconstruction", "app", "main.py"),
            "run-task",
            taskId,
            "--data-dir",
            dataDir(),
          ],
          label: "本地 Python",
        };

    const child = spawn(runner.cmd, runner.args, {
      cwd: repoRoot(),
      stdio: ["ignore", logFd, logFd],
      detached: true,
      windowsHide: true,
    });
    child.unref();
    fs.writeFileSync(LOCK_FILE(), String(child.pid));
    store.setWorkerPid(taskId, child.pid ?? null);
    store.appendEvent(taskId, "info", `Worker 已启动（${runner.label}，PID ${child.pid}）`);
    return { ok: true, pid: child.pid };
  } catch (e) {
    return { ok: false, error: `Worker 启动失败: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    fs.closeSync(logFd);
  }
}

/** 释放 worker 锁（worker 退出后由状态同步调用） */
export function releaseWorkerLock(): void {
  const lock = LOCK_FILE();
  try {
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
  } catch {
    // 忽略
  }
}

/** 取消运行中的 worker：写标记文件 + 尝试终止进程树 */
export function cancelWorker(taskId: string, pid: number | null): void {
  const dir = taskDir(taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cancel.flag"), new Date().toISOString());
  if (pid) {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 8000 });
      } else {
        process.kill(pid, "SIGTERM");
      }
    } catch {
      // 进程可能已退出
    }
  }
}
