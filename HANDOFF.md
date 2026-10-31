# HANDOFF — MiniVerse 交接文档

> 生成时间：2026-10-24 ｜ 交接人：zcode（会话：MiniVerse 2.0 通宵开发 + 真实重建阶段）
> 下一任 Agent 请**先完整读完本文档**，再读 `PROGRESS.md`（两份里程碑段）与 `TEST_REPORT.md`。

## 一、项目一句话状态

**MiniVerse = 上传真实房间照片 → COLMAP 位姿恢复 → Splatfacto 3DGS 训练 → 浏览器查看 → 编辑器叠加可编辑 GLB 家具。**
核心产品能力（第一次真实照片重建全链路）**已于 2026-10-24 实证打通**，当前是"已验证的 MVP"，还不是商业化产品。

- 代码：`C:\Users\WYX\.zcode\workspace\93096d68-ed46-47d7-8fe9-02b8d3f61fac\miniverse`（monorepo）
- 已验证指标：104 张真实照片 → COLMAP sequential CPU ~20 分钟 → Splatfacto 7000 步/1200px → 106MB scene.ply，训练 16 分 13 秒，**显存峰值 2987MiB / 8GB（37%）**
- 回归基线：vitest 33/33、tsc 0 错误、eslint 0 错误、next build EXIT=0（12 路由）

## 二、环境与启动（两个世界，别搞混）

### Web 世界（Windows，Node 24）
```bash
cd <仓库>/miniverse
npm install          # 首次
npm run dev          # http://localhost:3000（首页自动进编辑器）
npm test             # vitest 33 个用例
```

### 重建世界（WSL2 Ubuntu 22.04，已装好）
- conda env：`miniverse`（torch 2.1.2+cu121 / cuda-toolkit 12.1 / nerfstudio / setuptools 69.5.1）
- COLMAP：apt 版（**CPU only**，位姿质量与 GPU 版相同）
- 训练入口：`bash /root/train-now.sh`（直跑单任务，MAX_JOBS=2）或 `services/reconstruction/scripts/run-worker-wsl.sh`（常驻轮询）
- 环境自检：`cd services/reconstruction && python -m app.main check-env`（须全项 ✅）

### 一键验收流程（下一个 Agent 的第一个实操）
1. Windows：`npm run dev`
2. 浏览器 http://localhost:3000/reconstructions 上传 3~120 张照片（或复用 `data/uploads/staging-room/` 的 104 张）
3. WSL：`bash /root/train-now.sh`（拾取 pending 任务）
4. 完成后任务详情页点「导入到编辑器」→ 高斯场景渲染
5. 真实重建样例已在库：任务 `f1014582-4012-4acc-b91c-38a9098fcdfe`，场景 `69e00d43-150c-4b6c-a7e5-b6130206c110`

## 三、架构速览（30 秒版）

```
apps/web        Next.js 16 编辑器+API（SQLite 任务库 node:sqlite、场景 Zod v2、上传魔数校验）
packages/shared 场景 Schema v2 + 素材白名单（前后端共享，改它必须 npm test）
services/reconstruction  Python 流水线（与 Web 用 data/tasks 文件协议解耦）
tools/          程序化 GLB 家具生成器 + 演示高斯生成器
data/           uploads / tasks(db) / scenes / processed / reconstructions
```

关键不变量（改代码前必读，细节在 PROGRESS.md）：
- **素材白名单**：objects[].assetId 只能取自 `packages/shared/src/asset-catalog.ts`
- **坐标系**：米、Y 向上、家具原点=底部中心；3DGS 背景经 `SplatObject` 的 X180° 翻转 + 中位数稳健取景对齐（勿删，离群高斯会污染 min/max bbox）
- **AI 来源标注**：objects[].origin ∈ user/ai-detected/ai-inferred，禁止混淆
- **诚实原则**：环境缺失/任务失败必须如实上报，禁止演示数据冒充重建结果

## 四、下一步任务（按优先级）

### P1（2026-10-24 已全部完成，见 PROGRESS「P1 体验闭环」「P1 收官」节）：体验闭环 + 真实素材实测 ✅
- 已落地：高斯加载进度条（下载 %/解析/ready）、训练相机取景（`/api/reconstructions/:id/cameras`，房间正立 + 真实拍摄视角 + 视角保存刷新不重置）、上传页拍摄指引。
- 真实素材实测：Pexels 免费视频抽帧 44 张走全流程（任务 `70597d42`，14 分钟，正立渲染+取景+视角保存全部实证）。
- 关键结论：nerfstudio 归一化系竖直轴是 Z（PLY 顶点协方差实证），显示需 Rx(-90°) 立起为 Y-up，勿回退为 X180。
- 已修复（2026-10-30）：Windows 侧 worker spawn 原本报 `ModuleNotFoundError: app`，上传后重建不会自动开始。现在 `apps/web/src/lib/server/worker-spawn.ts` 在 Windows 上探测「conda 环境 miniverse 是否存在」后派发到 WSL（`wsl.exe -d <distro> -e bash -lc`），日志由 Linux 侧直接写入 `worker.log`（detached wsl.exe 会丢 stdout）；`main.py` / `worker.py` 的 `sys.path` 也已修正。手工 `train-now` 模式仍可作兜底。

### P2：AI 家具识别（评审建议的第三步）
- Grounding DINO（文字类别检测）+ SAM 2（实例分割），对关键帧检测家具
- 结合 COLMAP 位姿把 2D 框反投影到 3D 位置（需要深度估计或点云中值高度）
- 结果写入 objects[]，**origin 必须标 ai-detected / ai-inferred**，低置信度让用户确认
- 显存预算：检测/分割模型与训练不同时跑（worker 单飞锁已保证）；8GB 够用

### P3：3DGS 物体分离 / 编辑（评审建议的第四步，研究性质）
- 2D 分割 mask 反投影到高斯点做物体级分组；移动后原位置残影是核心难题
- 兜底方案已记录在评审文档：轻量模式（只加不删）→ 高级模式（移除+补全，可要求用户拍"移走家具后"的照片集）
- **未开始**，先做 P2 积累多视角分割数据

### P4：产品化（上线前必做）
- 鉴权（无登录）、配额/成本控制（一次训练 ~16 分钟 GPU）、结果分享页、PLY 瘦身（spz 压缩）、移动端拍摄引导

## 五、已知坑速查（全部已修复，复发时按此排查）

| 症状 | 根因 | 处置 |
|---|---|---|
| R3F 画布 300×150 不渲染 | next.config ESM 下 __dirname undefined → turbopack.root 失效 | 已改 import.meta.dirname，勿回退 |
| spark 黑屏 | StrictMode 双挂载 dispose 掉 GPU 实例 | 实例必须在 useEffect 内创建 |
| 画面停首帧 | WSL/遮挡环境 rAF 冻结 | lib/render-fallback.ts 兜底（勿删） |
| ninja 编译 OOM / interrupted | 并行 nvcc × WSL 内存限制 | MAX_JOBS=2 + .wslconfig memory≥12GB（训练期） |
| COLMAP undistort 被杀 | 同上 | 同上 |
| wsl 复合命令诡异失败 | wsl.exe 拼串交 /bin/sh + Git Bash MSYS 路径转换 | 复杂命令写脚本文件执行 / MSYS_NO_PATHCONV=1 |
| Ubuntu 后台进程莫名消失 | vmIdleTimeout 关 VM | 保活会话（wsl -- sleep infinity）或独立进程 |
| worker 找不到照片目录 | input.json 是 Windows 路径 | worker.py 的 wsl_path() 已转换 |
| 高斯画面 roll/倒置 | PLY（nerfstudio 系）竖直轴是 Z，X180 把房间立到编辑器 Z 轴；且俯/仰拍相机做初始视角时 lookAt 退化 | 改 Rx(-90°) 立起为 Y-up（SplatObject/SplatViewerCore，勿回退）；取景选水平相机 + target 沿拍摄视线 |
| 刷新后高斯视角被重置 | 旧版每次挂载强制取景 | schema camera.autoFrame 门控：取景/用户拖动后落 false，不再重置 |
| 任务卡 pending 但已完成 | 快速任务无中间态 | 状态机已允许 pending→completed |
| .wslconfig | 用户限 4GB 防吃满宿主 | 训练期临时 12GB（备份 .wslconfig.miniverse-backup），**用完必须恢复** |

## 六、验收红线（不许破坏）

1. 任何"完成"声明必须附实证（命令输出/截图/HTTP 码），禁用 should/probably
2. 失败不删日志、不降验收标准；演示数据必须带 synthetic 标注，永不冒充重建
3. 共享记忆库：开工先 memory_context，收尾必须 memory_write 沉淀
4. 用户的 .wslconfig / 系统级配置改动必须备份原文件并在完成后恢复
