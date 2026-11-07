import fs from "node:fs";
import path from "node:path";
import {
  createEmptyScene,
  parseScene,
  type SceneData,
} from "@shared/scene-schema";
import { reconstructionDir } from "./paths";
import { getTaskStore, type TaskStore } from "./task-store";
import { ValidationError } from "./scene-store";

/**
 * 重建结果 → 编辑器场景（P3 接入的"自动导入"半程）。
 * 任务完成后调用：以空场景为底座挂上高斯背景规格，房间外壳自动隐藏。
 * 校验链：任务存在 → 状态 completed → 产物 scene.ply 实际存在。
 * 本函数不落盘（持久化由 route 层 createScene 完成）；store 参数供测试注入。
 */

export function createSceneFromReconstruction(
  taskId: string,
  store: TaskStore = getTaskStore()
): SceneData {
  if (!/^[a-f0-9-]{36}$/i.test(taskId)) throw new ValidationError("非法任务 ID");

  const task = store.get(taskId);
  if (!task) throw new ValidationError("任务不存在");
  if (task.status !== "completed") {
    throw new ValidationError(`任务未完成（当前状态: ${task.status}），无法导入`);
  }

  const plyPath = path.join(reconstructionDir(taskId), "scene.ply");
  if (!fs.existsSync(plyPath)) {
    throw new ValidationError("任务标记完成但产物 scene.ply 缺失，数据不完整");
  }

  const scene = createEmptyScene(`重建场景 ${taskId.slice(0, 8)}`);
  return parseScene({
    ...scene,
    // 重建背景激活：真实产物，synthetic=false
    reconstruction: {
      taskId,
      status: "completed",
      format: "gaussian-splat",
      url: `/api/reconstructions/${taskId}/result`,
      synthetic: false,
    },
    // 程序化房间外壳隐藏，家具直接摆进重建坐标系
    room: { ...scene.room, visible: false },
    metadata: {
      ...scene.metadata,
      name: `重建场景 ${taskId.slice(0, 8)}`,
      note: "由真实照片重建任务导入",
    },
  });
}
