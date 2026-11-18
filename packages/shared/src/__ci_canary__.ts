// 【CI canary】故意同时触发 typecheck（TS2322）与 lint（no-unused-vars 警告 × --max-warnings 0）失败，
// 用于验证 packages/shared 确实被 typecheck 与 lint 双覆盖；验证后立即删除，勿合并保留。
export const CI_CANARY_TYPE_ERROR: number = "这不是数字，tsc 必须 TS2322 红";

const unusedCanary = 1;
