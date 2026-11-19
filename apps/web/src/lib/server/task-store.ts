import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataDir, ensureDataDirs, taskDir } from "./paths";

/**
 * 重建任务持久化存储（node:sqlite，零原生依赖）。
 * 状态机：pending → processing → completed | failed；failed/pending → canceled；
 * failed/canceled →(重试) pending。所有流转校验合法性并留事件审计。
 */

export type TaskStatus = "pending" | "processing" | "completed" | "failed" | "canceled";

export const STATUS_FLOW: Record<TaskStatus, TaskStatus[]> = {
  // pending → completed 允许：直跑 worker（不经 worker-loop 轮询）的快速任务无中间态上报
  // pending → failed 允许（卡 #700127）：worker 已把 failed 写进 status.json 但派发记录
  // 丢失（进程在首次同步前死亡/重试竞态）时，懒同步必须能落到 failed，否则任务永远 pending
  pending: ["processing", "canceled", "completed", "failed"],
  processing: ["completed", "failed", "canceled"],
  completed: [],
  failed: ["pending", "canceled"],
  canceled: ["pending"],
};

export interface TaskRow {
  id: string;
  status: TaskStatus;
  params: string; // JSON: {maxResolution?, steps?}
  photo_count: number;
  result: string | null; // JSON: {plyPath, ...}
  error: string | null;
  attempts: number;
  worker_pid: number | null;
  created_at: string;
  updated_at: string;
}

export interface TaskEvent {
  id: number;
  task_id: string;
  level: string;
  message: string;
  created_at: string;
}

export class TaskStore {
  private db: DatabaseSync;

  constructor(dbPath?: string) {
    if (dbPath) {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      this.db = new DatabaseSync(dbPath);
    } else {
      ensureDataDirs();
      this.db = new DatabaseSync(path.join(dataDir(), "tasks", "tasks.db"));
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        params TEXT NOT NULL DEFAULT '{}',
        photo_count INTEGER NOT NULL DEFAULT 0,
        result TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        worker_pid INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, id);
    `);
  }

  create(id: string, params: Record<string, unknown>, photoCount: number): TaskRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tasks (id, status, params, photo_count, created_at, updated_at)
         VALUES (?, 'pending', ?, ?, ?, ?)`
      )
      .run(id, JSON.stringify(params), photoCount, now, now);
    this.appendEvent(id, "info", `任务创建：${photoCount} 张照片`);
    return this.get(id)!;
  }

  get(id: string): TaskRow | undefined {
    return this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
  }

  list(limit = 50): TaskRow[] {
    return this.db
      .prepare(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as unknown as TaskRow[];
  }

  /** 状态流转；非法流转抛错。extra 可更新 result/error/worker_pid/attempts。 */
  transition(
    id: string,
    next: TaskStatus,
    extra: { result?: unknown; error?: string | null; workerPid?: number | null; attemptIncrement?: boolean } = {}
  ): TaskRow {
    const row = this.get(id);
    if (!row) throw new Error(`任务不存在: ${id}`);
    const allowed = STATUS_FLOW[row.status as TaskStatus] ?? [];
    if (!allowed.includes(next)) {
      throw new Error(`非法状态流转: ${row.status} → ${next}`);
    }
    const now = new Date().toISOString();
    const attempts = extra.attemptIncrement ? row.attempts + 1 : row.attempts;
    this.db
      .prepare(
        `UPDATE tasks SET status=?, updated_at=?, result=COALESCE(?, result),
         error=?, worker_pid=?, attempts=? WHERE id=?`
      )
      .run(
        next,
        now,
        extra.result === undefined ? null : JSON.stringify(extra.result),
        extra.error === undefined ? row.error : extra.error,
        extra.workerPid === undefined ? row.worker_pid : extra.workerPid,
        attempts,
        id
      );
    this.appendEvent(id, next === "failed" ? "error" : "info", `状态变更: ${row.status} → ${next}${extra.error ? `（${extra.error}）` : ""}`);
    return this.get(id)!;
  }

  /** 失败/取消后重试：回到 pending 并累加尝试次数（上限 3） */
  retry(id: string): TaskRow {
    const row = this.get(id);
    if (!row) throw new Error(`任务不存在: ${id}`);
    if (row.status !== "failed" && row.status !== "canceled") {
      throw new Error(`仅失败/已取消任务可重试，当前: ${row.status}`);
    }
    if (row.attempts >= 3) throw new Error("重试次数已达上限（3）");
    return this.transition(id, "pending", { error: null, attemptIncrement: true });
  }

  setWorkerPid(id: string, pid: number | null): void {
    this.db.prepare(`UPDATE tasks SET worker_pid=?, updated_at=? WHERE id=?`).run(
      pid,
      new Date().toISOString(),
      id
    );
  }

  appendEvent(id: string, level: "info" | "warn" | "error", message: string): void {
    this.db
      .prepare(`INSERT INTO task_events (task_id, level, message, created_at) VALUES (?,?,?,?)`)
      .run(id, level, message, new Date().toISOString());
  }

  events(id: string, limit = 100): TaskEvent[] {
    return this.db
      .prepare(`SELECT * FROM task_events WHERE task_id=? ORDER BY id DESC LIMIT ?`)
      .all(id, limit) as unknown as TaskEvent[];
  }

  /** 读取 worker 追加的日志尾部 */
  logTail(id: string, maxLines = 200): string[] {
    try {
      const logPath = path.join(taskDir(id), "worker.log");
      if (!fs.existsSync(logPath)) return [];
      const content = fs.readFileSync(logPath, "utf8");
      return content.split(/\r?\n/).slice(-maxLines).filter(Boolean);
    } catch {
      return [];
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

let singleton: TaskStore | null = null;
export function getTaskStore(): TaskStore {
  if (!singleton) singleton = new TaskStore();
  return singleton;
}
