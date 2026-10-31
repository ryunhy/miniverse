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

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `请求失败（${res.status}）`);
  return body as T;
}

export const api = {
  listScenes: () => fetch("/api/scenes").then((r) => json<{ scenes: SceneSummary[] }>(r)),
  createScene: (template: "demo" | "empty", name?: string) =>
    fetch("/api/scenes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template, name }),
    }).then((r) => json<{ scene: SceneData }>(r)),
  getScene: (id: string) => fetch(`/api/scenes/${id}`).then((r) => json<{ scene: SceneData }>(r)),
  createSceneFromReconstruction: (taskId: string) =>
    fetch("/api/scenes/from-reconstruction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId }),
    }).then((r) => json<{ scene: SceneData }>(r)),
  saveScene: (scene: SceneData) =>
    fetch(`/api/scenes/${scene.sceneId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scene),
    }).then((r) => json<{ savedAt: string }>(r)),
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
