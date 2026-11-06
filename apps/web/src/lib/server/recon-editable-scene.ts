import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { dataDir } from "./paths";
import type { SceneEdits, SceneManifest, SceneTransform } from "@/lib/scene-types";

/**
 * 可编辑场景清单（schema = miniverse.scene-manifest.v1）的读取、版本哈希与编辑持久化。
 *
 * 目录约定（按优先级探测）：
 *   data/reconstructions/<id>/scene.json          （集成批次直接落盘）
 *   data/reconstructions/<id>/mesh/scene.json     （管线把场景落在 mesh/ 子目录）
 *   data/reconstructions/<id>/scene/scene.json    （备用布局）
 *   data/reconstructions/<id>/scene-edits.json    （用户布局，原子写）
 *
 * 版本 = scene.json 字节的 sha256。编辑带 baseSceneVersion：场景被重新生成后，
 * 旧布局会被判为 stale，API 返回 409 而不是把旧变换套到新几何上。
 */

/** v1 清单的 schema 标识，下游（客户端/验收）据此判定可消费。 */
export const SCENE_MANIFEST_SCHEMA = "miniverse.scene-manifest.v1";

export class SceneValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SceneValidationError";
  }
}

export class SceneVersionConflict extends Error {
  constructor(public current: string) {
    super("场景版本已变化，旧布局不再适用");
    this.name = "SceneVersionConflict";
  }
}

/** 只允许安全目录名：sample、UUID、或管线生成的稳定 slug；禁止 / \ .. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DEFAULT_ASSETS = ["room", "walls", "floor", "sofa"] as const;

const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const quat = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);

const transformSchema = z.object({
  position: vec3,
  quaternion: quat,
  scale: vec3.refine((s) => s.every((v) => v !== 0), "缩放不能为 0"),
  visible: z.boolean(),
});

export const editsSchema = z.object({
  version: z.literal(1),
  sceneId: z.string().min(1).max(200),
  baseSceneVersion: z.string().min(8).max(128),
  updatedAt: z.string().min(10),
  objects: z.record(z.string().min(1).max(120), transformSchema),
});

export function sceneIdValid(id: string): boolean {
  return ID_RE.test(id);
}

/** 找到包含 scene.json 的目录；没有则抛 SceneValidationError（API 映射为 404）。 */
export function sceneRoot(id: string): string {
  if (!ID_RE.test(id)) throw new SceneValidationError("非法场景 ID");
  const base = path.join(dataDir(), "reconstructions", id);
  const candidates = [base, path.join(base, "mesh"), path.join(base, "scene")];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "scene.json"))) return dir;
  }
  throw new SceneValidationError(`场景不存在: ${id}`);
}

function manifestPath(id: string): string {
  return path.join(sceneRoot(id), "scene.json");
}

export function loadSceneManifest(id: string): SceneManifest {
  const p = manifestPath(id);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new SceneValidationError(
      e instanceof Error ? `scene.json 无法解析: ${e.message}` : "scene.json 无法解析",
    );
  }
  const m = raw as Partial<SceneManifest>;
  if (m.schema !== SCENE_MANIFEST_SCHEMA) {
    throw new SceneValidationError(`不支持的场景 schema: ${String(m.schema)}`);
  }
  if (!Array.isArray(m.objects) || m.objects.length === 0) {
    throw new SceneValidationError("scene.json 缺少 objects");
  }
  const ids = new Set<string>();
  for (const o of m.objects) {
    if (!o || typeof o.objectId !== "string" || typeof o.nodeName !== "string") {
      throw new SceneValidationError("scene.json objects 项缺少 objectId/nodeName");
    }
    if (ids.has(o.objectId)) throw new SceneValidationError(`objectId 重复: ${o.objectId}`);
    ids.add(o.objectId);
    if (o.startTransform && !transformSchema.safeParse(o.startTransform).success) {
      throw new SceneValidationError(`object ${o.objectId} 的 startTransform 非法`);
    }
  }
  return raw as SceneManifest;
}

/** scene.json 的字节哈希：布局与缓存的版本锚点。 */
export function sceneVersion(id: string): string {
  const bytes = fs.readFileSync(manifestPath(id));
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** 清单声明的资产路径（assets.scene 同时以 room 暴露，兼容默认取 room 的客户端）。 */
export function manifestAssetPaths(manifest: SceneManifest): Map<string, string> {
  const out = new Map<string, string>();
  const assets = manifest.assets;
  if (assets && typeof assets === "object") {
    for (const [key, v] of Object.entries(assets)) {
      if (v && typeof v.path === "string") out.set(key, v.path);
    }
  }
  const scenePath = out.get("scene");
  if (scenePath && !out.has("room")) out.set("room", scenePath);
  return out;
}

/** 资产名 → 磁盘路径；只接受清单声明或已知默认名，且必须是场景目录下的 .glb。 */
export function sceneAssetPath(id: string, asset: string): string {
  const root = sceneRoot(id);
  const manifest = loadSceneManifest(id);
  const declared = manifestAssetPaths(manifest);
  let rel = declared.get(asset);
  if (!rel && (DEFAULT_ASSETS as readonly string[]).includes(asset)) rel = `${asset}.glb`;
  if (!rel) throw new SceneValidationError(`场景未声明资产: ${asset}`);
  const base = path.basename(rel);
  if (base !== rel || path.extname(base).toLowerCase() !== ".glb") {
    throw new SceneValidationError(`资产路径非法: ${rel}`);
  }
  const file = path.join(root, base);
  const resolvedRoot = path.resolve(root) + path.sep;
  if (!path.resolve(file).startsWith(resolvedRoot)) {
    throw new SceneValidationError(`资产路径越界: ${rel}`);
  }
  if (!fs.existsSync(file)) throw new SceneValidationError(`资产文件不存在: ${base}`);
  return file;
}

const assetHashCache = new Map<string, { size: number; mtimeMs: number; sha256: string }>();

/** GLB 的 sha256（按 size+mtime 缓存），用于 ETag / 客户端缓存版本参数。 */
export function assetHash(file: string): string {
  const st = fs.statSync(file);
  const hit = assetHashCache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.sha256;
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  assetHashCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, sha256 });
  return sha256;
}

/** 资产名 → sha256，仅列出磁盘上真实存在的文件。 */
export function listSceneAssets(id: string): Record<string, string> {
  const manifest = loadSceneManifest(id);
  const names = new Set<string>([...DEFAULT_ASSETS, ...manifestAssetPaths(manifest).keys()]);
  const out: Record<string, string> = {};
  for (const name of names) {
    try {
      out[name] = assetHash(sceneAssetPath(id, name));
    } catch {
      // 清单声明了但文件缺失：略过，客户端按缺失资产处理（不阻断其余对象）
    }
  }
  return out;
}

export function defaultEdits(manifest: SceneManifest): SceneEdits {
  const objects: Record<string, SceneTransform> = {};
  for (const o of manifest.objects) {
    if (!o.startTransform) continue;
    objects[o.objectId] = normalizeTransform(o.startTransform);
  }
  return {
    version: 1,
    sceneId: manifest.sceneId,
    baseSceneVersion: "",
    updatedAt: new Date(0).toISOString(),
    objects,
  };
}

function normalizeTransform(t: SceneTransform): SceneTransform {
  const q = t.quaternion;
  const norm = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(norm > 1e-6)) throw new SceneValidationError("四元数长度为 0");
  return {
    position: t.position.map(cleanNumber) as [number, number, number],
    quaternion: q.map((v) => cleanNumber(v / norm)) as [number, number, number, number],
    scale: t.scale.map((v) => cleanNumber(v)) as [number, number, number],
    visible: t.visible,
  };
}

function cleanNumber(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function editsPath(id: string): string {
  return path.join(sceneRoot(id), "scene-edits.json");
}

export interface StoredEdits {
  edits: SceneEdits | null;
  stale: boolean;
  currentVersion: string;
}

/** 读取用户布局；文件缺失或损坏都回退为「无布局」，不阻断页面。 */
export function loadEdits(id: string): StoredEdits {
  const version = sceneVersion(id);
  const p = editsPath(id);
  if (!fs.existsSync(p)) {
    return { edits: null, stale: false, currentVersion: version };
  }
  try {
    const parsed = editsSchema.safeParse(JSON.parse(fs.readFileSync(p, "utf8")));
    if (!parsed.success) {
      return { edits: null, stale: true, currentVersion: version };
    }
    const stale = parsed.data.baseSceneVersion !== version;
    return { edits: stale ? null : parsed.data, stale, currentVersion: version };
  } catch {
    return { edits: null, stale: true, currentVersion: version };
  }
}

/**
 * 写入用户布局（整份替换，原子写）。只接受 manifest 里存在的 objectId；
 * baseSceneVersion 必须等于当前 scene.json 哈希，否则抛 SceneVersionConflict。
 */
export function saveEdits(id: string, input: unknown): SceneEdits {
  const manifest = loadSceneManifest(id);
  const version = sceneVersion(id);
  const parsed = editsSchema.safeParse(input);
  if (!parsed.success) {
    throw new SceneValidationError(
      `布局格式非法: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  }
  const edits = parsed.data;
  if (edits.sceneId !== manifest.sceneId) {
    throw new SceneValidationError(`sceneId 不匹配: ${edits.sceneId} != ${manifest.sceneId}`);
  }
  if (edits.baseSceneVersion !== version) throw new SceneVersionConflict(version);
  const known = new Set(manifest.objects.map((o) => o.objectId));
  for (const objectId of Object.keys(edits.objects)) {
    if (!known.has(objectId)) throw new SceneValidationError(`未知 objectId: ${objectId}`);
  }
  const normalized: SceneEdits = {
    version: 1,
    sceneId: edits.sceneId,
    baseSceneVersion: version,
    updatedAt: new Date().toISOString(),
    objects: Object.fromEntries(
      Object.entries(edits.objects).map(([k, v]) => [k, normalizeTransform(v)]),
    ),
  };
  const p = editsPath(id);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2));
  fs.renameSync(tmp, p);
  return normalized;
}

/** 删除已保存布局（恢复默认）。 */
export function clearEdits(id: string): boolean {
  const p = editsPath(id);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}
