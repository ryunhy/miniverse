// 【CI canary】故意触发 lint 失败（no-unused-vars 警告 × --max-warnings 0），
// 用于验证 CI lint 门禁真实生效；验证后立即删除，勿合并保留。
const unusedCanary = 1;
