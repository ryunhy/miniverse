import fs from "node:fs";
import path from "node:path";
import {
  parseScene,
  safeParseScene,
  touchScene,
  type SceneData,
} from "@shared/scene-schema";
import { dataDir, ensureDataDirs } from "./paths";

/**
 * 场景持久化：data/scenes/<sceneId>.json，一场景一文件，原子写（tmp + rename）。
 * 写入前强制 Zod 校验；读取时校验失败返回 null 而不是抛错（脏文件隔离）。
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** 写前版本校验失败：调用方据此返回 409（不落盘、丢弃本次写入） */
export class RevisionConflictError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super(`版本冲突：服务端当前 revision=${currentRevision}`);
    this.name = "RevisionConflictError";
    this.currentRevision = currentRevision;
  }
}

/** 历史版本保留份数：保留最近 20 个版本即可覆盖误操作回滚窗口，且磁盘占用有界 */
const HISTORY_LIMIT = 20;

function historyDir(sceneId: string): string {
  return path.join(dataDir(), "scenes", "_history", sceneId);
}

/** 写前把旧版本快照到 _history/<id>/<rev>.json，并按版本号保留最近 HISTORY_LIMIT 份 */
function snapshotHistory(sceneId: string, currentPath: string, currentRevision: number): void {
  const dir = historyDir(sceneId);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${currentRevision}.json`);
  if (!fs.existsSync(target)) {
    fs.copyFileSync(currentPath, target);
  }
  // 清理策略：只保留版本号最大的 HISTORY_LIMIT 份（文件名即 revision，可直接数值排序）
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  for (const f of files.slice(0, Math.max(0, files.length - HISTORY_LIMIT))) {
    fs.unlinkSync(path.join(dir, f));
  }
}

function scenePath(sceneId: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(sceneId)) throw new ValidationError("非法场景 ID");
  return path.join(dataDir(), "scenes", `${sceneId}.json`);
}

export interface SceneSummary {
  sceneId: string;
  name: string;
  updatedAt: string;
  demo: boolean;
  objectCount: number;
}

export function listScenes(): SceneSummary[] {
  ensureDataDirs();
  const dir = path.join(dataDir(), "scenes");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const summaries: SceneSummary[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      const parsed = safeParseScene(raw);
      if (parsed.success) {
        summaries.push({
          sceneId: parsed.data.sceneId,
          name: parsed.data.metadata.name,
          updatedAt: parsed.data.metadata.updatedAt,
          demo: parsed.data.metadata.demo,
          objectCount: parsed.data.objects.length,
        });
      }
    } catch {
      // 跳过损坏文件
    }
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getScene(sceneId: string): SceneData | null {
  const p = scenePath(sceneId);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const parsed = safeParseScene(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * 写入场景（原子写 + 版本递增）。
 * expectedRevision 未传时按无条件写入（向后兼容老调用/新建场景）；
 * 传了则做 CAS：与服务端当前 revision 不符抛 RevisionConflictError（调用方回 409）。
 * 落盘前把旧版本快照进 _history/<id>/<rev>.json。
 */
export function putScene(input: unknown, expectedRevision?: number): SceneData {
  const parsed = safeParseScene(input);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
    );
  }
  ensureDataDirs();
  const p = scenePath(parsed.data.sceneId);
  const exists = fs.existsSync(p);
  const currentRevision = exists ? (getScene(parsed.data.sceneId)?.metadata.revision ?? 0) : 0;

  if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
    throw new RevisionConflictError(currentRevision);
  }

  if (exists) snapshotHistory(parsed.data.sceneId, p, currentRevision);

  // 新建场景从 0 开始；已有场景每次成功落盘 +1
  const revision = exists ? currentRevision + 1 : 0;
  const scene = touchScene({ ...parsed.data, metadata: { ...parsed.data.metadata, revision } });
  const tmp = `${p}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(scene, null, 2), "utf8");
  fs.renameSync(tmp, p);
  return scene;
}

export function deleteScene(sceneId: string): boolean {
  const p = scenePath(sceneId);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

export function parseSceneStrict(raw: unknown): SceneData {
  return parseScene(raw);
}
