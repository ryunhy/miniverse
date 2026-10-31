// E2E 辅助：模拟一次重建任务的完整生命周期（诚实标注：PLY 产物用演示数据替代真实训练）
// 用法：node tools/e2e-simulate-reconstruction.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.MINIVERSE_DATA_DIR = path.join(ROOT, "data");

const { TaskStore } = await import(
  path.join(ROOT, "apps/web/src/lib/server/task-store.ts").replace(".ts", ".ts")
).catch(() => ({ TaskStore: null }));

// node 直接跑 TS 不便，改走 Web API：先上传 3 张 PNG 创建任务
async function main() {
  const BASE = process.env.MV_BASE || "http://localhost:3100";

  // 1) 生成 3 张最小合法 PNG（1×1 像素）
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
      "0000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
    "hex"
  );

  const form = new FormData();
  for (let i = 1; i <= 3; i++) {
    form.append("photos", new File([png], `room-${i}.png`, { type: "image/png" }));
  }
  form.append("params", JSON.stringify({ maxResolution: 800 }));

  const createRes = await fetch(`${BASE}/api/reconstructions`, { method: "POST", body: form });
  const created = await createRes.json();
  if (!createRes.ok) throw new Error("创建任务失败: " + created.error);
  const taskId = created.task.id;
  console.log("① 任务已创建:", taskId, "| 状态:", created.task.status, "| workerStarted:", created.workerStarted);
  if (created.workerError) console.log("   （预期）Worker 未启动原因:", created.workerError.slice(0, 80) + "…");

  // 2) 模拟训练完成：状态流转到 completed + 拷贝演示 PLY 作为产物（本步骤仅用于 E2E 链路验证，
  //    真实场景中由 GPU Worker 写入；导入 API 会对真实任务做同样的校验）
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(ROOT, "data", "tasks", "tasks.db"));
  const now = new Date().toISOString();
  db.prepare("UPDATE tasks SET status='processing', updated_at=? WHERE id=?").run(now, taskId);
  db.prepare(
    "INSERT INTO task_events (task_id, level, message, created_at) VALUES (?,?,?,?)"
  ).run(taskId, "info", "[E2E 模拟] 训练完成（产物为演示 PLY，非真实重建）", now);
  db.prepare("UPDATE tasks SET status='completed', result=?, updated_at=? WHERE id=?").run(
    JSON.stringify({ plyPath: `reconstructions/${taskId}/scene.ply`, simulated: true }),
    now,
    taskId
  );
  db.close();

  const plyDir = path.join(ROOT, "data", "reconstructions", taskId);
  fs.mkdirSync(plyDir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "apps/web/public/demo/demo-room.ply"), path.join(plyDir, "scene.ply"));
  console.log("② 任务已置为 completed，产物 scene.ply 已就位（演示 PLY）");

  // 3) 调自动导入 API
  const importRes = await fetch(`${BASE}/api/scenes/from-reconstruction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId }),
  });
  const imported = await importRes.json();
  if (!importRes.ok) throw new Error("导入失败: " + imported.error);
  console.log("③ 自动导入成功 → 编辑器地址: /editor/" + imported.scene.sceneId);
  console.log("   reconstruction:", JSON.stringify(imported.scene.reconstruction));
  console.log("   room.visible:", imported.scene.room.visible, "（程序化外壳已隐藏）");
}

main().catch((e) => {
  console.error("E2E 失败:", e.message);
  process.exit(1);
});
