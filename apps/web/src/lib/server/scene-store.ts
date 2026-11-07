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
 *
 * 写入语义（三种调用方严格分离，避免误用导致覆盖）：
 * - createScene：仅新建；同 ID 已存在抛 SceneExistsError（路由回 409）
 * - updateScene：仅更新；不存在抛 SceneNotFoundError（404），缺版本抛 MissingPreconditionError（428）
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

/** 新建时目标 ID 已存在：调用方据此返回 409，禁止静默覆盖已有场景 */
export class SceneExistsError extends Error {
  readonly sceneId: string;

  constructor(sceneId: string) {
    super("该场景已存在，未保存任何内容");
    this.name = "SceneExistsError";
    this.sceneId = sceneId;
  }
}

/** 更新时目标场景不存在：调用方据此返回 404，禁止隐式重建（防止删除后被悄悄复活） */
export class SceneNotFoundError extends Error {
  readonly sceneId: string;

  constructor(sceneId: string) {
    super("场景不存在或已被删除");
    this.name = "SceneNotFoundError";
    this.sceneId = sceneId;
  }
}

/** 更新时未携带版本号：调用方据此返回 428（保留 CAS 的硬前置条件） */
export class MissingPreconditionError extends Error {
  constructor() {
    super("保存需要携带场景版本号，请刷新页面后重试");
    this.name = "MissingPreconditionError";
  }
}

/** 历史版本保留份数：保留最近 20 个版本即可覆盖误操作回滚窗口，且磁盘占用有界 */
const HISTORY_LIMIT = 20;

/**
 * 场景生命周期标识：取 createdAt 的毫秒时间戳。
 * 同一 sceneId 被删除后重建（或同一 JSON 重新导入）会得到新的 createdAt，
 * 历史目录随之隔离，避免"新场景读到上一生命周期快照"。
 */
function lifecycleOf(scene: SceneData): string {
  const t = Date.parse(scene.metadata.createdAt);
  return Number.isFinite(t) ? String(t) : "0";
}

function historyRoot(sceneId: string): string {
  return path.join(dataDir(), "scenes", "_history", sceneId);
}

/** 当前生命周期的历史目录：_history/<id>/<lifecycle>/ */
function historyDir(sceneId: string, lifecycle: string): string {
  return path.join(historyRoot(sceneId), lifecycle);
}

/** 旧布局（无生命周期层级）：_history/<id>/<rev>.json，仅供读取兼容 */
function isLegacyHistoryFile(f: string): boolean {
  return /^\d+\.json$/.test(f);
}

function pruneHistory(dir: string): void {
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  for (const f of files.slice(0, Math.max(0, files.length - HISTORY_LIMIT))) {
    fs.unlinkSync(path.join(dir, f));
  }
}

/** 写前把旧版本快照到 _history/<id>/<lifecycle>/<rev>.json，并按版本号保留最近 HISTORY_LIMIT 份 */
function snapshotHistory(
  sceneId: string,
  lifecycle: string,
  currentPath: string,
  currentRevision: number
): void {
  const dir = historyDir(sceneId, lifecycle);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${currentRevision}.json`);
  // 同生命周期内同一 revision 重复出现说明外部改过文件；以当前真实内容为准覆盖，
  // 不静默跳过（跳过会让该 revision 永远停留在过期内容上）。
  fs.copyFileSync(currentPath, target);
  pruneHistory(dir);
}

export interface SceneHistoryEntry {
  revision: number;
  updatedAt: string;
  name: string;
  objectCount: number;
}

/** 场景 ID 校验（同时用于历史目录，防止路径穿越） */
function assertSceneId(sceneId: string): void {
  if (!/^[a-f0-9-]{36}$/i.test(sceneId)) throw new ValidationError("非法场景 ID");
}

/**
 * 历史版本列表（revision 倒序）。
 * 只读当前生命周期目录；旧布局只有在快照的 createdAt 与当前场景一致时才纳入，
 * 避免同一 sceneId 被重建后读到上一生命周期内容。
 */
export function listSceneHistory(sceneId: string): SceneHistoryEntry[] {
  assertSceneId(sceneId);
  const current = getScene(sceneId);
  if (!current) return [];
  const lifecycle = lifecycleOf(current);
  const entries = new Map<number, SceneHistoryEntry>();

  const collect = (dir: string, acceptLegacy: boolean) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!isLegacyHistoryFile(f)) continue;
      try {
        const parsed = safeParseScene(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
        if (!parsed.success) continue;
        if (acceptLegacy && parsed.data.metadata.createdAt !== current.metadata.createdAt) continue;
        entries.set(parsed.data.metadata.revision, {
          revision: parsed.data.metadata.revision,
          updatedAt: parsed.data.metadata.updatedAt,
          name: parsed.data.metadata.name,
          objectCount: parsed.data.objects.length,
        });
      } catch {
        // 跳过损坏快照
      }
    }
  };

  // 旧布局先收集，新布局覆盖同名 revision（新布局更可信）
  collect(historyRoot(sceneId), true);
  collect(historyDir(sceneId, lifecycle), false);

  return [...entries.values()].sort((a, b) => b.revision - a.revision);
}

/** 读取单个历史版本内容（用于前端恢复）；版本号必须是非负整数 */
export function getSceneHistoryVersion(sceneId: string, revision: number): SceneData | null {
  assertSceneId(sceneId);
  if (!Number.isInteger(revision) || revision < 0) throw new ValidationError("非法版本号");
  const current = getScene(sceneId);
  if (!current) return null;

  const readAt = (p: string): SceneData | null => {
    if (!fs.existsSync(p)) return null;
    try {
      const parsed = safeParseScene(JSON.parse(fs.readFileSync(p, "utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };

  const scoped = readAt(path.join(historyDir(sceneId, lifecycleOf(current)), `${revision}.json`));
  if (scoped) return scoped;

  // 兼容旧布局：仅当该快照属于当前生命周期时返回
  const legacy = readAt(path.join(historyRoot(sceneId), `${revision}.json`));
  if (legacy && legacy.metadata.createdAt === current.metadata.createdAt) return legacy;
  return null;
}

function scenePath(sceneId: string): string {
  assertSceneId(sceneId);
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

function parseOrThrow(input: unknown): SceneData {
  const parsed = safeParseScene(input);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
    );
  }
  return parsed.data;
}

function writeSceneFile(scene: SceneData): SceneData {
  const p = scenePath(scene.sceneId);
  const tmp = `${p}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(scene, null, 2), "utf8");
  fs.renameSync(tmp, p);
  return scene;
}

/**
 * 新建场景（POST 专用）：同 ID 已存在直接拒绝，绝不覆盖。
 * createdAt 由服务端重写，保证生命周期标识唯一（同一 JSON 重新导入也得到新生命周期）。
 */
export function createScene(input: unknown): SceneData {
  const parsed = parseOrThrow(input);
  ensureDataDirs();
  const p = scenePath(parsed.sceneId);
  if (fs.existsSync(p)) throw new SceneExistsError(parsed.sceneId);
  const now = new Date().toISOString();
  const scene = touchScene({
    ...parsed,
    metadata: {
      ...parsed.metadata,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    },
  });
  return writeSceneFile(scene);
}

/**
 * 更新场景（PUT 专用）：必须带版本号、必须已存在。
 * 落盘前把旧版本快照进 _history/<id>/<lifecycle>/<rev>.json。
 */
export function updateScene(input: unknown, expectedRevision: number | undefined): SceneData {
  if (expectedRevision === undefined) throw new MissingPreconditionError();
  const parsed = parseOrThrow(input);
  ensureDataDirs();
  const p = scenePath(parsed.sceneId);
  if (!fs.existsSync(p)) throw new SceneNotFoundError(parsed.sceneId);

  const current = getScene(parsed.sceneId);
  if (!current) throw new ValidationError("场景数据损坏，已拒绝写入以避免覆盖");

  const currentRevision = current.metadata.revision;
  if (expectedRevision !== currentRevision) throw new RevisionConflictError(currentRevision);

  snapshotHistory(parsed.sceneId, lifecycleOf(current), p, currentRevision);

  const scene = touchScene({
    ...parsed,
    metadata: {
      ...parsed.metadata,
      revision: currentRevision + 1,
      // 生命周期不随写入变化，强制沿用服务端值，防止客户端篡改后读到别的历史目录
      createdAt: current.metadata.createdAt,
    },
  });
  return writeSceneFile(scene);
}

/**
 * 删除场景：主文件与历史目录一起移到 _trash/<id>-<timestamp>/ 归档，不物理抹掉。
 * 归档目录不在 scenes/ 根层级（是子目录），listScenes 不会读到。
 */
export function deleteScene(sceneId: string): boolean {
  const p = scenePath(sceneId);
  if (!fs.existsSync(p)) return false;
  const trashDir = path.join(dataDir(), "scenes", "_trash", `${sceneId}-${Date.now()}`);
  fs.mkdirSync(trashDir, { recursive: true });
  fs.renameSync(p, path.join(trashDir, "scene.json"));
  const root = historyRoot(sceneId);
  if (fs.existsSync(root)) {
    fs.renameSync(root, path.join(trashDir, "history"));
  }
  return true;
}

export function parseSceneStrict(raw: unknown): SceneData {
  return parseScene(raw);
}
