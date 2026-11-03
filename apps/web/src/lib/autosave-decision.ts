/**
 * 自动保存决策（纯函数，便于单测）。
 *
 * 读失败退化到 localStorage 旧镜像时，loadSource 置为 "local"，
 * 自动保存必须直接跳过：旧镜像可能早于服务端当前数据，任何自动回写
 * 都会把服务端内容覆盖回旧版本（reconstruction 等字段被清掉）。
 * 本地副本回写服务端只能由用户显式点击「用本地副本覆盖服务端」触发。
 */

export type LoadSource = "server" | "local" | "unknown";

export type AutosaveDecision = "write" | "skip-not-ready" | "skip-readonly-local";

export function decideAutosave(params: {
  ready: boolean;
  hasScene: boolean;
  loadSource: LoadSource;
}): AutosaveDecision {
  if (!params.ready || !params.hasScene) return "skip-not-ready";
  if (params.loadSource === "local") return "skip-readonly-local";
  return "write";
}
