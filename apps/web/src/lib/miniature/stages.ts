/**
 * 微缩重建的阶段视图（纯函数，无 IO，方便单测）。
 *
 * 设计约束（对应 T-700073 验收）：
 * 1. 阶段状态只能来自「任务产物」或「worker 上报的 stages」，不能按时间假装进度；
 *    后端没上报分阶段状态时，除输入阶段外一律 unknown，并在 UI 明说"未上报"。
 * 2. GLB 没产出就不能显示生成成功：ready 同时要求 status=completed 且 export=done。
 * 3. 推断/观测来源要能区分，provenance 原样透出，不在前端编造。
 */

export type TaskLikeStatus = "pending" | "processing" | "completed" | "failed" | "canceled";

export type StageState = "not_started" | "running" | "done" | "failed" | "skipped" | "unknown";

export interface StageDef {
  key: string;
  label: string;
  hint: string;
}

export interface StageView extends StageDef {
  state: StageState;
  detail?: string;
  evidence?: string;
}

export interface MiniaturePayload {
  synthetic?: boolean;
  /** worker 逐阶段上报：{ ingest: {state, detail, evidence}, ... } */
  stages?: Record<string, { state?: string; detail?: string; evidence?: string }>;
  glb?: { path?: string; bytes?: number; sha256?: string };
  provenance?: {
    photos?: string;
    texture?: string;
    observed_ratio?: number;
    inferred_ratio?: number;
  };
  note?: string;
}

export interface TaskLike {
  id: string;
  status: TaskLikeStatus;
  photo_count?: number;
  result?: string | null;
  error?: string | null;
}

/** 六个阶段，顺序即产线顺序。 */
export const MINIATURE_STAGES: StageDef[] = [
  { key: "ingest", label: "照片输入", hint: "登记照片、校验覆盖与尺度" },
  { key: "structure", label: "房间结构", hint: "地面与墙体定位" },
  { key: "instances", label: "家具实例", hint: "跨视角合并同一件家具" },
  { key: "geometry", label: "几何闭合", hint: "保留真实表面并补全隐藏面" },
  { key: "texture", label: "纹理烘焙", hint: "用原照片烘焙并处理接缝" },
  { key: "export", label: "导出 GLB", hint: "写出可下载的微缩模型" },
];

const VALID_STATES: StageState[] = ["not_started", "running", "done", "failed", "skipped", "unknown"];

export interface MiniatureView {
  taskId: string;
  status: TaskLikeStatus;
  stages: StageView[];
  /** 是否可下载/预览：必须真的拿到 GLB */
  ready: boolean;
  /** 阶段状态来源：worker_report 才代表真实进度 */
  stageSource: "worker_report" | "task_status_only";
  synthetic: boolean;
  glb: { url: string; downloadUrl: string; bytes: number | null; sha256: string | null } | null;
  provenance: MiniaturePayload["provenance"] | null;
  banner: { level: "ok" | "warn" | "error"; text: string };
}

function parsePayload(result: string | null | undefined): MiniaturePayload {
  if (!result) return {};
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    // 兼容两种落盘：{ miniature: {...} } 或直接 {...}
    const inner = parsed.miniature;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) return inner as MiniaturePayload;
    return parsed as MiniaturePayload;
  } catch {
    // result 不是 JSON 时不能当成"有产物"，按空处理
    return {};
  }
}

function normalizeState(raw: string | undefined): StageState {
  if (!raw) return "unknown";
  return (VALID_STATES as string[]).includes(raw) ? (raw as StageState) : "unknown";
}

/** GLB 是否真的存在：路径存在即认为产物落盘（字节数/哈希可能为空，不阻断）。 */
function hasGlb(payload: MiniaturePayload): boolean {
  return Boolean(payload.glb && typeof payload.glb.path === "string" && payload.glb.path.length > 0);
}

export function deriveMiniatureView(task: TaskLike): MiniatureView {
  const payload = parsePayload(task.result);
  const reported = payload.stages;
  const stageSource: MiniatureView["stageSource"] = reported ? "worker_report" : "task_status_only";

  let stages: StageView[];
  if (reported) {
    stages = MINIATURE_STAGES.map((def) => {
      const r = reported[def.key];
      return {
        ...def,
        state: normalizeState(r?.state),
        detail: r?.detail,
        evidence: r?.evidence,
      };
    });
  } else {
    // 没有分阶段上报：只把"照片已收到"当作客观事实，其余一律 unknown，绝不按时间填进度。
    stages = MINIATURE_STAGES.map((def) => ({
      ...def,
      state:
        def.key === "ingest"
          ? (task.photo_count ?? 0) > 0
            ? task.status === "pending"
              ? "done"
              : "done"
            : "not_started"
          : "unknown",
      detail: def.key === "ingest" ? `${task.photo_count ?? 0} 张照片已登记` : "worker 未上报分阶段状态",
    }));
  }

  // 终态修正：worker 没报也要按任务状态兜底，避免"任务已失败但阶段还是 running"。
  if (task.status === "failed" || task.status === "canceled") {
    stages = stages.map((s) => (s.state === "running" ? { ...s, state: "failed" as StageState } : s));
  }

  const exportStage = stages.find((s) => s.key === "export");
  const glbOk = hasGlb(payload) && task.status === "completed" && exportStage?.state !== "failed";
  const ready = glbOk;

  // GLB 拿不到时，导出阶段必须显式失败——不能显示"生成成功"。
  if (!ready) {
    stages = stages.map((s) =>
      s.key === "export" && s.state === "done" ? { ...s, state: "failed", detail: "任务已完成但未找到 GLB 产物" } : s
    );
    const exp = stages.find((s) => s.key === "export");
    if (exp && exp.state === "unknown" && (task.status === "completed" || task.status === "failed")) {
      stages = stages.map((s) => (s.key === "export" ? { ...s, state: "failed", detail: task.error ?? "未产出 GLB" } : s));
    }
  }

  const glb = ready && hasGlb(payload)
    ? {
        url: `/api/reconstructions/${encodeURIComponent(task.id)}/scene/glb?asset=room`,
        downloadUrl: `/api/reconstructions/${encodeURIComponent(task.id)}/scene/glb?asset=room&download=1`,
        bytes: typeof payload.glb?.bytes === "number" ? payload.glb.bytes : null,
        sha256: payload.glb?.sha256 ?? null,
      }
    : null;

  let banner: MiniatureView["banner"];
  if (task.status === "canceled") {
    banner = { level: "warn", text: "任务已取消，没有生成产物。可重试后重新生成。" };
  } else if (task.status === "failed") {
    banner = { level: "error", text: `生成失败：${task.error ?? "worker 未给出原因"}` };
  } else if (task.status === "completed" && !ready) {
    banner = { level: "error", text: "任务已结束但没有可用的 GLB，不能视为生成成功。" };
  } else if (task.status === "completed") {
    banner = { level: "ok", text: "生成完成，可直接预览与下载。" };
  } else if (stageSource === "task_status_only") {
    banner = { level: "warn", text: "worker 未上报分阶段状态，下面只显示已知事实（照片已收到）。" };
  } else {
    banner = { level: "warn", text: "任务进行中。" };
  }

  return {
    taskId: task.id,
    status: task.status,
    stages,
    ready,
    stageSource,
    synthetic: payload.synthetic === true,
    glb,
    provenance: payload.provenance ?? null,
    banner,
  };
}

/**
 * 产物核对结果（T-700018）：route 负责 IO 与错误归类，这里只做纯视图改写，方便单测。
 * 三种失败态必须分开表达，不许一律说「磁盘上找不到该文件」：
 * - unpublished：磁盘上没有 scene.json，场景尚未发布（任务可能已生成成功）；
 * - asset_missing：清单已发布，但清单声明的 GLB 资产文件不在磁盘上；
 * - manifest_invalid：清单 schema 或资产路径非法，清单本身不可消费。
 */
export type AssetCheck =
  | { kind: "ok"; bytes: number }
  | { kind: "unpublished" }
  | { kind: "asset_missing"; detail: string }
  | { kind: "manifest_invalid"; detail: string };

/**
 * 三态各自的 HTTP 语义（互不相同）：
 * - 404：场景资源尚未发布，不存在；
 * - 409：清单声明与磁盘实际状态冲突（声明了资产但文件缺失）；
 * - 422：清单内容非法，服务端无法处理消费。
 * 成功核对为 200。失败响应体仍携带完整 view（消费契约：body.view 始终可渲染）。
 */
export const ASSET_CHECK_STATUS = {
  unpublished: 404,
  asset_missing: 409,
  manifest_invalid: 422,
} as const;

/**
 * 把 recon-editable-scene 的 SceneValidationError 消息归入三态。
 * 该模块属全局禁改区，这里把它的消息契约钉死并配回归测试：
 * - 「场景不存在: …」→ 没有 scene.json，未发布；
 * - 「资产文件不存在: …」→ 清单在、资产文件缺；
 * - 其余（无法解析 / schema 不支持 / 缺 objects / 路径非法 / 越界 / 非法 ID）→ 清单或路径非法。
 */
export function classifyAssetFailure(message: string): AssetCheck {
  if (message.startsWith("场景不存在")) return { kind: "unpublished" };
  if (message.startsWith("资产文件不存在")) return { kind: "asset_missing", detail: message };
  return { kind: "manifest_invalid", detail: message };
}

/**
 * 按核对结果改写视图。失败态一律 ready=false、glb=null、export 阶段显式 failed；
 * 绝不为了让页面看起来成功而把 ready 置 true。
 */
export function applyAssetCheck(view: MiniatureView, check: AssetCheck): MiniatureView {
  if (check.kind === "ok") {
    return { ...view, glb: view.glb ? { ...view.glb, bytes: check.bytes } : view.glb };
  }

  let banner: MiniatureView["banner"];
  let exportDetail: string;
  if (check.kind === "unpublished") {
    banner = {
      level: "warn",
      text: "任务已完成，但场景尚未发布：磁盘上没有 scene.json 清单。发布完成前无法预览或下载，这不等于生成失败。",
    };
    exportDetail = "场景尚未发布（缺少 scene.json）";
  } else if (check.kind === "asset_missing") {
    banner = {
      level: "error",
      text: `场景清单已发布，但清单声明的 GLB 资产文件缺失（${check.detail}），不能视为生成成功。`,
    };
    exportDetail = `清单声明的资产文件缺失：${check.detail}`;
  } else {
    banner = {
      level: "error",
      text: `场景清单无法消费：${check.detail}。清单 schema 或资产路径非法，需修复清单后重新发布。`,
    };
    exportDetail = `清单 schema 或资产路径非法：${check.detail}`;
  }

  return {
    ...view,
    ready: false,
    glb: null,
    banner,
    stages: view.stages.map((s) => (s.key === "export" ? { ...s, state: "failed", detail: exportDetail } : s)),
  };
}

/** UI 契约 fixture：显式 synthetic，只用于前端状态演示，不能当真实生成证据。 */
export function syntheticFixture(overrides: Partial<TaskLike> = {}): TaskLike {
  return {
    id: "fixture-synthetic",
    status: "completed",
    photo_count: 12,
    result: JSON.stringify({
      synthetic: true,
      note: "合成契约示例，非真实重建",
      stages: {
        ingest: { state: "done", detail: "12 张照片" },
        structure: { state: "done", detail: "地面 1 面 / 墙 2 面" },
        instances: { state: "done", detail: "3 件家具" },
        geometry: { state: "done", detail: "全部闭合" },
        texture: { state: "done", detail: "原照片烘焙" },
        export: { state: "done", detail: "scene.glb" },
      },
      glb: { path: "glb/scene.glb", bytes: 1024, sha256: "synthetic-not-a-real-hash" },
      provenance: { photos: "synthetic", texture: "synthetic", observed_ratio: 0.5, inferred_ratio: 0.5 },
    }),
    error: null,
    ...overrides,
  };
}
