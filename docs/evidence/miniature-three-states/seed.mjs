// T-700018 实测种子脚本：在独立数据目录里造 5 个已完成任务，驱动 miniature route 的三态 + 成功态。
// 用法：node seed.mjs <数据目录绝对路径>
// 说明：全部为自造临时清单（测试夹具），不是真实重建产物；不触碰仓库 data/ 与任何业务代码。
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const base = process.argv[2];
if (!base) {
  console.error("用法: node seed.mjs <数据目录绝对路径>");
  process.exit(1);
}
fs.mkdirSync(path.join(base, "tasks"), { recursive: true });
fs.mkdirSync(path.join(base, "reconstructions"), { recursive: true });

const db = new DatabaseSync(path.join(base, "tasks", "tasks.db"));
db.exec(`
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

// 与 worker 上报同构的 result：声明了 GLB 且 export=done → deriveMiniatureView 会给 ready=true，
// 随后 route 的磁盘核对决定落到哪个态。
const result = JSON.stringify({
  glb: { path: "glb/scene.glb", bytes: 123 },
  stages: {
    ingest: { state: "done", detail: "8 张照片" },
    structure: { state: "done" },
    instances: { state: "done" },
    geometry: { state: "done" },
    texture: { state: "done" },
    export: { state: "done", detail: "scene.glb" },
  },
});

const now = new Date().toISOString();
const ins = db.prepare(
  "INSERT OR REPLACE INTO tasks (id,status,params,photo_count,result,error,attempts,worker_pid,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
);
const ids = ["ev-unpublished", "ev-missing", "ev-invalid-path", "ev-bad-schema", "ev-ok"];
for (const id of ids) ins.run(id, "completed", "{}", 8, result, null, 1, null, now, now);
db.close();

function manifest(sceneId, assetPath, schema = "miniverse.scene-manifest.v1") {
  return JSON.stringify(
    {
      schema,
      sceneId,
      objects: [{ objectId: "room", nodeName: "Room" }],
      assets: { room: { path: assetPath } },
    },
    null,
    2
  );
}

const rec = (id) => path.join(base, "reconstructions", id);

// 态1 未发布：不建任何 scene.json（目录都不存在）

// 态2 资产缺失：清单合法，声明 room.glb，但不放文件
fs.mkdirSync(rec("ev-missing"), { recursive: true });
fs.writeFileSync(path.join(rec("ev-missing"), "scene.json"), manifest("ev-missing", "room.glb"));

// 态3a 路径非法：清单声明 ../evil.glb（basename 校验拒绝）
fs.mkdirSync(rec("ev-invalid-path"), { recursive: true });
fs.writeFileSync(path.join(rec("ev-invalid-path"), "scene.json"), manifest("ev-invalid-path", "../evil.glb"));

// 态3b schema 非法：不支持的 schema 版本
fs.mkdirSync(rec("ev-bad-schema"), { recursive: true });
fs.writeFileSync(
  path.join(rec("ev-bad-schema"), "scene.json"),
  manifest("ev-bad-schema", "room.glb", "miniverse.scene-manifest.v0")
);

// 成功态：合法清单 + 真实存在的最小 GLB（glTF 2.0 空场景，仅用于 stat 核对）
fs.mkdirSync(rec("ev-ok"), { recursive: true });
fs.writeFileSync(path.join(rec("ev-ok"), "scene.json"), manifest("ev-ok", "room.glb"));
const json = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, scene: 0, scenes: [{}] }));
const pad = (4 - (json.length % 4)) % 4;
const jsonChunk = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
const header = Buffer.alloc(12);
header.write("glTF", 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonChunk.length, 8);
const chunkHeader = Buffer.alloc(8);
chunkHeader.writeUInt32LE(jsonChunk.length, 0);
chunkHeader.writeUInt32LE(0x4e4f534a, 4); // JSON
fs.writeFileSync(path.join(rec("ev-ok"), "room.glb"), Buffer.concat([header, chunkHeader, jsonChunk]));

console.log("seeded:", ids.join(", "), "→", base);