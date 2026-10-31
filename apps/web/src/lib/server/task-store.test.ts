import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore } from "./task-store";

let dir: string;
let store: TaskStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "miniverse-tasks-"));
  store = new TaskStore(path.join(dir, "tasks.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const TASK = () => randomUUID();

describe("任务状态机", () => {
  it("创建 → pending → processing → completed 合法流转", () => {
    const id = TASK();
    store.create(id, {}, 10);
    expect(store.get(id)!.status).toBe("pending");
    store.transition(id, "processing");
    store.transition(id, "completed", { result: { plyPath: "x.ply" } });
    const row = store.get(id)!;
    expect(row.status).toBe("completed");
    expect(JSON.parse(row.result!)).toEqual({ plyPath: "x.ply" });
  });

  it("拒绝非法流转：completed → processing", () => {
    const id = TASK();
    store.create(id, {}, 5);
    store.transition(id, "processing");
    store.transition(id, "completed");
    expect(() => store.transition(id, "processing")).toThrow(/非法状态流转/);
  });

  it("允许 pending → completed（直跑 worker 的快速任务无中间态上报）", () => {
    const id = TASK();
    store.create(id, {}, 5);
    store.transition(id, "completed", { result: { plyPath: "x.ply" } });
    expect(store.get(id)!.status).toBe("completed");
  });

  it("failed → canceled；failed --retry--> pending 并累加尝试次数", () => {
    const id = TASK();
    store.create(id, {}, 5);
    store.transition(id, "processing");
    store.transition(id, "failed", { error: "COLMAP 缺失" });
    store.transition(id, "canceled");
    const retried = store.retry(id);
    expect(retried.status).toBe("pending");
    expect(retried.attempts).toBe(1);
  });

  it("重试上限 3 次", () => {
    const id = TASK();
    store.create(id, {}, 5);
    for (let i = 0; i < 3; i++) {
      store.transition(id, "processing");
      store.transition(id, "failed", { error: `第${i + 1}次` });
      store.retry(id);
    }
    store.transition(id, "processing");
    store.transition(id, "failed", { error: "第4次" });
    expect(() => store.retry(id)).toThrow(/上限/);
  });

  it("processing 中不可重试", () => {
    const id = TASK();
    store.create(id, {}, 5);
    store.transition(id, "processing");
    expect(() => store.retry(id)).toThrow(/仅失败\/已取消任务可重试/);
  });
});

describe("任务持久化", () => {
  it("状态跨实例持久化（进程重启语义）", () => {
    const id = TASK();
    store.create(id, { maxResolution: 1200 }, 30);
    store.transition(id, "processing");
    store.appendEvent(id, "info", "COLMAP 特征提取完成");
    store.close();

    const reopened = new TaskStore(path.join(dir, "tasks.db"));
    const row = reopened.get(id)!;
    expect(row.status).toBe("processing");
    expect(row.photo_count).toBe(30);
    expect(JSON.parse(row.params)).toEqual({ maxResolution: 1200 });
    const events = reopened.events(id);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.message.includes("COLMAP 特征提取"))).toBe(true);
    reopened.close();
  });

  it("不存在的任务流转抛错", () => {
    expect(() => store.transition(randomUUID(), "processing")).toThrow(/任务不存在/);
  });
});
