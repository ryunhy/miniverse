"use client";

import type { SceneData } from "@shared/scene-schema";

export interface SceneSummary {
  sceneId: string;
  name: string;
  updatedAt: string;
  demo: boolean;
  objectCount: number;
}

export interface TaskRow {
  id: string;
  status: "pending" | "processing" | "completed" | "failed" | "canceled";
  params: string;
  photo_count: number;
  result: string | null;
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

/** 带 HTTP 状态码的请求错误：调用方据此区分 404（场景不存在）与 5xx/网络（服务端暂不可用） */
export class ApiError extends Error {
  readonly status: number;
  /** 服务端返回的响应体（409 冲突时携带最新 revision 与最新 scene） */
  readonly payload: unknown;

  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError((body as { error?: string }).error || `请求失败（${res.status}）`, res.status, body);
  }
  return body as T;
}

/** 只有 5xx 与网络错误值得重试；4xx（含 404）重试无意义 */
function isRetryableReadError(e: unknown): boolean {
  if (e instanceof ApiError) return e.status >= 500;
  return true;
}

/** 有限次退避重试（2 次，300ms/900ms），避免服务端瞬时 5xx 直接退化成读失败 */
const READ_RETRY_DELAYS_MS = [300, 900];

async function getSceneWithRetry(id: string): Promise<{ scene: SceneData; revision: number }> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= READ_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await fetch(`/api/scenes/${id}`).then((r) => json<{ scene: SceneData; revision: number }>(r));
    } catch (e) {
      lastError = e;
      if (!isRetryableReadError(e) || attempt === READ_RETRY_DELAYS_MS.length) break;
      await new Promise((resolve) => setTimeout(resolve, READ_RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("网络请求失败");
}

export const api = {
  listScenes: () => fetch("/api/scenes").then((r) => json<{ scenes: SceneSummary[] }>(r)),
  createScene: (template: "demo" | "empty", name?: string) =>
    fetch("/api/scenes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template, name }),
    }).then((r) => json<{ scene: SceneData }>(r)),
  getScene: (id: string) => getSceneWithRetry(id),
  createSceneFromReconstruction: (taskId: string) =>
    fetch("/api/scenes/from-reconstruction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId }),
    }).then((r) => json<{ scene: SceneData }>(r)),
  /**
   * 保存场景。默认带上本地记录的 revision 做 CAS（If-Match），
   * 服务端发现已被其它会话改过时返回 409；forceRevision 用于冲突对话框中
   * 「用我的覆盖服务端」——以服务端最新 revision 为基线强制写入。
   */
  saveScene: (scene: SceneData, opts?: { expectedRevision?: number }) =>
    fetch(`/api/scenes/${scene.sceneId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": `"${opts?.expectedRevision ?? scene.metadata.revision}"`,
      },
      body: JSON.stringify(scene),
    }).then((r) => json<{ scene: SceneData; revision: number; savedAt: string }>(r)),
  listTasks: () => fetch("/api/reconstructions").then((r) => json<{ tasks: TaskRow[] }>(r)),
  getTask: (id: string) =>
    fetch(`/api/reconstructions/${id}`).then((r) =>
      json<{ task: TaskRow; events: TaskEvent[]; logTail: string[] }>(r)
    ),
  retryTask: (id: string) =>
    fetch(`/api/reconstructions/${id}/retry`, { method: "POST" }).then((r) =>
      json<{ task: TaskRow; workerStarted: boolean; workerError: string | null }>(r)
    ),
  cancelTask: (id: string) =>
    fetch(`/api/reconstructions/${id}/cancel`, { method: "POST" }).then((r) => json<{ task: TaskRow }>(r)),
  health: () =>
    fetch("/api/health").then((r) =>
      json<{
        python: string | null;
        workerBusy: boolean;
        taskCount: number;
        sceneCount: number;
      }>(r)
    ),
};

/** XHR 上传（需要进度回调） */
export function uploadPhotos(
  files: File[],
  params: Record<string, unknown>,
  onProgress: (percent: number) => void
): Promise<{ task: TaskRow; workerStarted: boolean; workerError: string | null }> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const f of files) form.append("photos", f);
    form.append("params", JSON.stringify(params));
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/reconstructions");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.error || `上传失败（${xhr.status}）`));
      } catch {
        reject(new Error(`上传失败（${xhr.status}）`));
      }
    };
    xhr.onerror = () => reject(new Error("网络错误：上传失败"));
    xhr.send(form);
  });
}
