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

export function putScene(input: unknown): SceneData {
  const parsed = safeParseScene(input);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
    );
  }
  const scene = touchScene(parsed.data);
  ensureDataDirs();
  const p = scenePath(scene.sceneId);
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
