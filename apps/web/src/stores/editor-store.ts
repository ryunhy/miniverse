"use client";

import { create } from "zustand";
import {
  clampToRoom,
  createDemoScene,
  migrateV1Scene,
  parseScene,
  safeParseScene,
  touchScene,
  type CameraSpec,
  type SceneData,
  type SceneObject,
} from "@shared/scene-schema";
import { getAsset } from "@shared/asset-catalog";
import type { LoadSource } from "@/lib/autosave-decision";

const LOCAL_PREFIX = "miniverse:scene:v2:";

export type GizmoMode = "translate" | "rotate" | "scale";
export type SplatLoadState = "idle" | "loading" | "ready" | "error";
/** 高斯数据加载进度：download=网络下载（percent 0~100，无 Content-Length 时 null），parse=解析/建 GPU 资源 */
export interface SplatProgress {
  phase: "download" | "parse";
  percent: number | null;
}

/** 高斯场景的世界系稳健包围（orient 后），供 360°/三视图取景。orbitRadius=训练相机轨道半径（数据视角带） */
export interface SplatFrame {
  center: [number, number, number];
  radius: number;
  orbitRadius: number;
}

export type ViewPreset = "inside" | "model360" | "front" | "side" | "top";

interface EditorState {
  sceneId: string | null;
  scene: SceneData | null;
  selectedId: string | null;
  gizmoMode: GizmoMode;
  previewMode: boolean;
  /** 高斯背景加载状态（非场景数据，不参与撤销/持久化） */
  splatLoad: SplatLoadState;
  splatProgress: SplatProgress | null;
  /** 高斯稳健包围帧（加载后写入） */
  splatFrame: SplatFrame | null;
  /** 当前查看模式：inside=房间内部漫游，model=模型环绕/三视图（全向轨道） */
  viewMode: "inside" | "model";
  /** 视图预设请求（nonce 保证重复点击同按钮也触发） */
  viewRequest: { preset: ViewPreset; n: number } | null;
  past: SceneData[];
  future: SceneData[];
  savedAt: number | null;
  storageMode: "server" | "local" | "unknown";
  /** 当前场景数据来源：server=服务端读取，local=读失败后回退的本地旧副本（只读，禁止自动回写） */
  loadSource: LoadSource;

  setSplatLoad: (s: SplatLoadState) => void;
  setSplatProgress: (p: SplatProgress | null) => void;
  setSplatFrame: (f: SplatFrame | null) => void;
  requestView: (preset: ViewPreset) => void;
  setViewMode: (m: "inside" | "model") => void;

  setScene: (scene: SceneData, sceneId: string) => void;
  select: (id: string | null) => void;
  setGizmoMode: (mode: GizmoMode) => void;
  setPreviewMode: (on: boolean) => void;
  addObject: (assetId: string, origin?: SceneObject["origin"]) => string | null;
  duplicateSelected: () => string | null;
  updateObject: (id: string, patch: Partial<SceneObject>, options?: { history?: boolean }) => void;
  removeObject: (id: string) => void;
  updateRoom: (patch: Partial<SceneData["room"]>) => void;
  updateLighting: (patch: Partial<SceneData["lighting"]>) => void;
  updateMetadata: (patch: Partial<SceneData["metadata"]>) => void;
  setReconstruction: (patch: Partial<SceneData["reconstruction"]>) => void;
  setCamera: (camera: CameraSpec) => void;
  loadSceneJson: (raw: unknown) => { ok: boolean; error?: string };
  resetToDemo: () => void;
  clearScene: () => void;
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
  markSaved: (mode: "server" | "local") => void;
  mirrorToLocal: () => void;
  restoreFromLocal: (sceneId: string) => boolean;
}

let idCounter = 0;
function nextId(assetId: string): string {
  idCounter += 1;
  return `${assetId}-${Date.now().toString(36)}-${idCounter}`;
}

const HISTORY_LIMIT = 50;

function withClamp(scene: SceneData, obj: SceneObject): SceneObject {
  const asset = getAsset(obj.assetId);
  return clampToRoom(scene.room, obj, asset?.footprint ?? [0.5, 0.5]);
}

export const useEditorStore = create<EditorState>((set, get) => ({
  sceneId: null,
  scene: null,
  selectedId: null,
  gizmoMode: "translate",
  previewMode: false,
  splatLoad: "idle",
  splatProgress: null,
  splatFrame: null,
  viewMode: "inside",
  viewRequest: null,
  past: [],
  future: [],
  savedAt: null,
  storageMode: "unknown",
  loadSource: "unknown",

  setSplatLoad: (splatLoad) => set({ splatLoad }),
  setSplatProgress: (splatProgress) => set({ splatProgress }),
  setSplatFrame: (splatFrame) => set({ splatFrame }),
  requestView: (preset) => set({ viewRequest: { preset, n: Date.now() } }),
  setViewMode: (viewMode) => set({ viewMode }),

  setScene: (scene, sceneId) =>
    set({ scene, sceneId, past: [], future: [], selectedId: null, loadSource: "server" }),

  select: (id) => set({ selectedId: id }),
  setGizmoMode: (gizmoMode) => set({ gizmoMode }),
  setPreviewMode: (previewMode) =>
    set({ previewMode, selectedId: previewMode ? null : get().selectedId }),

  addObject: (assetId, origin = "user") => {
    const { scene } = get();
    const asset = getAsset(assetId);
    if (!scene || !asset) return null;
    const obj: SceneObject = {
      id: nextId(assetId),
      assetId,
      label: asset.label,
      position: [(Math.random() - 0.5) * 0.6, 0, (Math.random() - 0.5) * 0.6],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      visible: true,
      origin,
      materialOverrides: {},
    };
    set({
      past: [...get().past, scene].slice(-HISTORY_LIMIT),
      future: [],
      scene: { ...scene, objects: [...scene.objects, withClamp(scene, obj)] },
      selectedId: obj.id,
    });
    return obj.id;
  },

  duplicateSelected: () => {
    const { scene, selectedId } = get();
    if (!scene || !selectedId) return null;
    const src = scene.objects.find((o) => o.id === selectedId);
    if (!src) return null;
    const copy: SceneObject = { ...src, id: nextId(src.assetId) };
    set({
      past: [...get().past, scene].slice(-HISTORY_LIMIT),
      future: [],
      scene: { ...scene, objects: [...scene.objects, withClamp(scene, copy)] },
      selectedId: copy.id,
    });
    return copy.id;
  },

  updateObject: (id, patch, options) => {
    const { scene } = get();
    if (!scene) return;
    const objects = scene.objects.map((o) => (o.id === id ? withClamp(scene, { ...o, ...patch }) : o));
    set({
      ...(options?.history === false
        ? {}
        : { past: [...get().past, scene].slice(-HISTORY_LIMIT), future: [] }),
      scene: { ...scene, objects },
    });
  },

  removeObject: (id) => {
    const { scene, selectedId } = get();
    if (!scene) return;
    set({
      past: [...get().past, scene].slice(-HISTORY_LIMIT),
      future: [],
      scene: { ...scene, objects: scene.objects.filter((o) => o.id !== id) },
      selectedId: selectedId === id ? null : selectedId,
    });
  },

  updateRoom: (patch) => {
    const { scene } = get();
    if (!scene) return;
    const nextRoom = { ...scene.room, ...patch };
    set({
      past: [...get().past, scene].slice(-HISTORY_LIMIT),
      future: [],
      scene: {
        ...scene,
        room: nextRoom,
        objects: scene.objects.map((o) => withClamp({ ...scene, room: nextRoom }, o)),
      },
    });
  },

  updateLighting: (patch) => {
    const { scene } = get();
    if (!scene) return;
    set({ scene: { ...scene, lighting: { ...scene.lighting, ...patch } } });
  },

  updateMetadata: (patch) => {
    const { scene } = get();
    if (!scene) return;
    set({ scene: { ...scene, metadata: { ...scene.metadata, ...patch } } });
  },

  setReconstruction: (patch) => {
    const { scene } = get();
    if (!scene) return;
    const recon = { ...scene.reconstruction, ...patch };
    const splatActive = recon.format === "gaussian-splat" && !!recon.url;
    // 高斯背景激活时隐藏程序化房间外壳；退出时恢复
    set({
      past: [...get().past, scene].slice(-HISTORY_LIMIT),
      future: [],
      scene: {
        ...scene,
        reconstruction: recon,
        room: { ...scene.room, visible: !splatActive },
      },
    });
  },

  setCamera: (camera) => {
    const { scene } = get();
    if (!scene) return;
    // 相机状态不参与撤销历史
    set({ scene: { ...scene, camera } });
  },

  loadSceneJson: (raw) => {
    const v2 = safeParseScene(raw);
    if (v2.success) {
      set({ scene: v2.data, sceneId: v2.data.sceneId, past: [], future: [], selectedId: null });
      return { ok: true };
    }
    const migrated = migrateV1Scene(raw);
    if (migrated) {
      set({ scene: migrated, sceneId: migrated.sceneId, past: [], future: [], selectedId: null });
      return { ok: true };
    }
    const firstIssue = v2.error.issues[0];
    return {
      ok: false,
      error: `${firstIssue?.path.join(".") || "(root)"}: ${firstIssue?.message ?? "格式错误"}`,
    };
  },

  resetToDemo: () => {
    const sceneId = get().sceneId;
    const scene = get().scene;
    if (!sceneId || !scene) return;
    const demo = createDemoScene();
    set({
      past: [...get().past, scene].slice(-HISTORY_LIMIT),
      future: [],
      scene: parseScene({ ...demo, sceneId }),
      selectedId: null,
    });
  },

  clearScene: () => {
    const { scene } = get();
    if (!scene) return;
    set({
      past: [...get().past, scene].slice(-HISTORY_LIMIT),
      future: [],
      scene: {
        ...scene,
        objects: [],
        reconstruction: {
          taskId: null,
          status: "none",
          format: "none",
          url: null,
          synthetic: false,
          ambientColor: null,
        },
        room: { ...scene.room, visible: true },
      },
      selectedId: null,
    });
  },

  pushHistory: () => {
    const { scene } = get();
    if (!scene) return;
    set({ past: [...get().past, scene].slice(-HISTORY_LIMIT), future: [] });
  },

  undo: () => {
    const { past, future, scene, selectedId } = get();
    if (past.length === 0 || !scene) return;
    const prev = past[past.length - 1];
    set({
      scene: prev,
      past: past.slice(0, -1),
      future: [scene, ...future].slice(0, HISTORY_LIMIT),
      selectedId: prev.objects.some((o) => o.id === selectedId) ? selectedId : null,
    });
  },

  redo: () => {
    const { past, future, scene } = get();
    if (future.length === 0 || !scene) return;
    const next = future[0];
    set({
      scene: next,
      past: [...past, scene].slice(-HISTORY_LIMIT),
      future: future.slice(1),
    });
  },

  // 成功写回服务端后，数据来源即视为服务端（用户确认覆盖本地副本后自动保存恢复）
  markSaved: (storageMode) =>
    set({
      savedAt: Date.now(),
      storageMode,
      ...(storageMode === "server" ? { loadSource: "server" as LoadSource } : {}),
    }),

  mirrorToLocal: () => {
    const { scene, sceneId } = get();
    if (!scene || !sceneId) return;
    try {
      localStorage.setItem(LOCAL_PREFIX + sceneId, JSON.stringify(touchScene(scene)));
    } catch {
      // localStorage 异常不影响主流程
    }
  },

  restoreFromLocal: (sceneId) => {
    try {
      const raw = localStorage.getItem(LOCAL_PREFIX + sceneId);
      if (!raw) return false;
      const parsed = safeParseScene(JSON.parse(raw));
      if (!parsed.success) return false;
      set({ scene: parsed.data, sceneId, past: [], future: [], selectedId: null, loadSource: "local" });
      return true;
    } catch {
      return false;
    }
  },
}));

export function localSceneKey(sceneId: string): string {
  return LOCAL_PREFIX + sceneId;
}
