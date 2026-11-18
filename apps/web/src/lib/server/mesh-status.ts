/**
 * 网格状态的唯一判定入口（纯函数：不读文件、不碰数据库，便于单测覆盖判断顺序）。
 * 读文件与懒同步 SQLite 由调用方（route.ts）负责。
 */

export type MeshState = "ready" | "running" | "failed" | "missing" | "absent";

/** running 的两种来源：整链路跑到网格阶段 / 单独重试网格 */
export type MeshRunningPhase = "inline" | "retry";

export interface MeshStatusInput {
  /** mesh.glb 字节数，0 表示不存在 */
  glbBytes: number;
  /** 用户是否要求导出网格 */
  requested: boolean;
  /** 任务主状态：pending / processing / completed / failed / canceled */
  taskStatus: string;
  /** worker 上报的阶段（status.json 的 stage），无则 null */
  workerStage: string | null;
  /** 单独重试网格的记录（mesh-status.json 的 status），无则 null */
  retryStatus: string | null;
  retryError: string | null;
  /** task.result.mesh.error */
  meshError: string | null;
}

export interface MeshStatus {
  state: MeshState;
  error: string | null;
  /** 仅 state=running 时有值 */
  phase: MeshRunningPhase | null;
}

/**
 * 判定顺序（从强到弱，改动前请先跑 mesh-status.test.ts）：
 *   1. 单独重试进行中                  → running / retry（旧产物还在，但正在被覆盖）
 *   2. 单独重试失败                    → failed（不能让旧产物的 ready 掩盖失败）
 *   3. 产物存在                        → ready
 *   4. 主任务记录了网格错误            → failed
 *   5. 主任务 processing 且已到网格阶段 → running / inline
 *   6. 主任务 completed 但无产物        → missing
 *   7. 其余                            → absent
 */
export function resolveMeshStatus(input: MeshStatusInput): MeshStatus {
  const { glbBytes, requested, taskStatus, workerStage, retryStatus, retryError, meshError } = input;

  // 重试会原地覆盖 mesh.glb，此时旧产物还在磁盘上，不能据此报 ready
  if (retryStatus === "processing") return { state: "running", error: null, phase: "retry" };
  if (retryStatus === "failed") {
    return { state: "failed", error: retryError || "网格生成失败（详见日志）", phase: null };
  }
  if (glbBytes > 0) return { state: "ready", error: null, phase: null };
  if (meshError) return { state: "failed", error: meshError, phase: null };
  // 整链路跑网格时不写 mesh-status.json，只能靠主任务的 stage 判断
  if (requested && taskStatus === "processing" && workerStage === "mesh") {
    return { state: "running", error: null, phase: "inline" };
  }
  if (requested && taskStatus === "completed") return { state: "missing", error: null, phase: null };
  return { state: "absent", error: null, phase: null };
}
