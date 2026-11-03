/**
 * 自动保存决策（纯函数，便于单测）。
 *
 * 两条硬约束：
 * 1) 读失败退化到 localStorage 旧镜像时，loadSource 置为 "local"，
 *    自动保存必须直接跳过：旧镜像可能早于服务端当前数据，任何自动回写
 *    都会把服务端内容覆盖回旧版本（reconstruction 等字段被清掉）。
 *    本地副本回写服务端只能由用户显式点击「用本地副本覆盖服务端」触发。
 * 2) 加载成功但内容与服务端完全一致时（dirty=false），也必须跳过：
 *    否则加载后 800ms 的盲写会覆盖这半秒内别处的改动。
 *
 * dirty 由调用方用「序列化快照 vs 基线快照」比对得出，而不是散落在
 * 每个 action 里维护的布尔标记——后者要求每个会改场景的 action 都记得
 * 置位、undo/redo 还要正确还原，漏一处就是静默丢保存。
 */

export type LoadSource = "server" | "local" | "unknown";

export type AutosaveDecision =
  | "write"
  | "skip-not-ready"
  | "skip-suspended"
  | "skip-readonly-local"
  | "skip-unchanged";

export function decideAutosave(params: {
  ready: boolean;
  hasScene: boolean;
  loadSource: LoadSource;
  /** 场景内容是否相对基线快照发生了变化 */
  dirty: boolean;
  /**
   * 自动保存是否被挂起：409 冲突弹窗未决、或用户选择「取消」后主动暂停。
   * 挂起期间仍允许编辑，只是不写服务端，避免弹窗基准反复漂移或重复弹窗。
   */
  suspended?: boolean;
}): AutosaveDecision {
  if (!params.ready || !params.hasScene) return "skip-not-ready";
  if (params.suspended) return "skip-suspended";
  if (params.loadSource === "local") return "skip-readonly-local";
  if (!params.dirty) return "skip-unchanged";
  return "write";
}

/**
 * 场景内容快照（用于 dirty 比对）。
 *
 * 直接 JSON.stringify 后比较：基线快照来自同一份对象结构，正常编辑经
 * spread 保持键序，内容相同即字符串相同；万一键序变化导致「假脏」，只会
 * 多写一次，不会漏保存（宁可多写不可丢写）。
 *
 * 数字做 12 位有效数字归一化：Three.js 相机/轨道控制在加载后会回写浮点
 * 舍入噪声（如 7.5 → 7.500000000000001），这不是用户编辑，若不归一化会
 * 让「加载成功且内容一致」判定失效、白写一次并把别处改动覆盖掉。
 * double 有效位约 15~17 位，取 12 位既吃掉末位舍入噪声，又远小于任何
 * 有意义的场景编辑（毫米级位置变更相对精度远高于 1e-12）。
 */
export function snapshotScene(scene: unknown): string {
  return JSON.stringify(scene, (_key, value) =>
    typeof value === "number" && Number.isFinite(value) ? Number(value.toPrecision(12)) : value
  );
}
