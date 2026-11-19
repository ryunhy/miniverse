# HANDOFF — MiniVerse 交接文档

> 生成时间：2026-10-24 ｜ 交接人：zcode（会话：MiniVerse 2.0 通宵开发 + 真实重建阶段）
> 下一任 Agent 请**先完整读完本文档**，再读 `PROGRESS.md`（两份里程碑段）与 `TEST_REPORT.md`。
> **2026-11-19 纠偏（T-700015）**：回归基线改为当前实测（见「一」）、新增微缩支线章节（见「八」）、移除个人机器绝对路径。历史快照数字不追改；证据可达性与索取办法见 `docs/COLLABORATION-READINESS.md`，实测原始输出在 `docs/evidence/miniature/`。

## 一、项目一句话状态

**MiniVerse = 上传真实房间照片 → COLMAP 位姿恢复 → Splatfacto 3DGS 训练 → 浏览器查看 → 编辑器叠加可编辑 GLB 家具。**
核心产品能力（第一次真实照片重建全链路）**已于 2026-10-24 实证打通**，当前是"已验证的 MVP"，还不是商业化产品。

- 代码：monorepo，仓库地址 `https://github.com/ryunhy/miniverse.git`，克隆到本地任意目录即可（旧交接写的个人机器绝对路径对协作者无效，已于 2026-11-19 移除；仓库内其余残留位置清单见 `docs/COLLABORATION-READINESS.md`）
- 已验证指标：104 张真实照片 → COLMAP sequential CPU ~20 分钟 → Splatfacto 7000 步/1200px → 106MB scene.ply，训练 16 分 13 秒，**显存峰值 2987MiB / 8GB（37%）**（首次验证基线；后续 30000 步重训产物为 119MB / 47.99 万高斯，见 PROGRESS「质量治理」节）
- 回归基线（历史快照，2026-11-02 实测，保留不追改）：vitest **45/45**、tsc 0 错误、eslint **2 errors + 1 warning**（2 errors 位于当时未提交的 `apps/web/src/components/mesh/MeshViewerCore.tsx`，属 P5 并行改动）、next build EXIT=0（**17 条路由**：6 页面含 `/_not-found` + 11 API）
- **回归基线（当前实测，2026-11-19 复核，T-700015）**：vitest **18 文件 / 173 例全过**（3.75s）、tsc **0 错误**、eslint **0 errors 0 warnings**（`--max-warnings 0`，旧 `EditorShell.tsx:23` 未用导入警告已不存在）、next build EXIT=0（**27 条路由项**、11 条 Turbopack 警告）。环境：Windows 10 26200 / Node v24.21.0 / npm 11.19.0；树状态：HEAD `d69405a` + 42 项并行卡未提交改动（测试数含并行卡新增用例与已合并 PR #2/#3 的门禁测试；任务卡所附 2026-11-18 基线为 15 文件 / 137 例，系当时树状态）。原始输出：`docs/evidence/miniature/four-checks-2026-11-19.log`

## 二、环境与启动（两个世界，别搞混）

### Web 世界（Windows，Node 24）
```bash
cd <仓库>/miniverse
npm install          # 首次
npm run dev          # http://localhost:3000（首页自动进编辑器）
npm test             # vitest；2026-11-19 实测 18 文件 / 173 例（见「一」当前基线）
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
- **坐标系**：米、Y 向上、家具原点=底部中心；nerfstudio 导出的 PLY 竖直轴是 Z，3DGS 背景在 `SplatObject` 中用 **Rx(-90°)** 立起为 Y-up（演示 PLY 本身 Y-up 保持恒等）；**勿回退为 X180**（会把房间竖到编辑器 Z 轴）。取景用高斯中位数稳健对齐（勿删，离群高斯会污染 min/max bbox）
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
| gizmo 拖完撤销后画布像素对不上 | TransformControls 松手时 `dragging` 已置 false，R3F 的 click 把选择抢到松手位置下的地板/墙体 | `EditableSceneViewerCore` 的 `onClick` 用 `e.delta > 4` 过滤拖动结束的点击（勿删） |

## 六、验收红线（不许破坏）

1. 任何"完成"声明必须附实证（命令输出/截图/HTTP 码），禁用 should/probably
2. 失败不删日志、不降验收标准；演示数据必须带 synthetic 标注，永不冒充重建
3. 共享记忆库：开工先 memory_context，收尾必须 memory_write 沉淀
4. 用户的 .wslconfig / 系统级配置改动必须备份原文件并在完成后恢复

## 七、scene-manifest v1 客户端接入（2026-11-05，任务 #6638）

**状态：已完成并实证。** `/reconstructions/<id>` 现在优先消费 `data/reconstructions/<id>/scene.json`
（scene-manifest v1），渲染可编辑场景；清单不存在时回退到只读 `MeshViewer`，旧任务行为不变。

- 服务端：`lib/server/recon-editable-scene.ts` + 三个路由
  （`/scene`、`/scene/glb`、`/scene/edits`），布局 `scene-edits.json` 原子写入、`baseSceneVersion` 冲突 409。
- 客户端：`components/mesh/EditableSceneViewer{,Core}.tsx`，支持画布点选、移动/旋转/缩放、
  隐藏、移除/恢复家具、撤销（快照栈 50，Ctrl/Cmd+Z）、保存与刷新恢复、移除家具后的背景检查。
- 验收：`tools/verify-scene-manifest-client.mjs` 驱动真实 headless Chrome（CDP），
  选择 `selection_via=canvas`、变换 `transform_via=gizmo`、撤销后画布像素差 **0**、
  刷新恢复 true；证据在 `docs/evidence/scene-manifest-client/`（JSON + 5 张 PNG）。
- 背景检查在 `sample` 上如实报 `newHoles=1 / silhouetteMisses=10`（家具下方网格确有 1 条视线洞），
  功能可用、结果未美化；契约与限制详见 **`docs/SCENE-MANIFEST.md`**。
- 样例数据 `data/reconstructions/sample/` 来自集成批次 `outputs/integration/sample/`，`data/` 不入库。

## 八、微缩支线 miniature（照片 → 可打印小模型；2026-11-19 补写，T-700015）

主线之外已有一条微缩支线：上传房间照片 → 复用 COLMAP 稀疏模型 → 六阶段
（`ingest / structure / instances / geometry / texture / export`）产出微缩 GLB，可再导出 STL / 3MF。
旧版 HANDOFF 全文未提及本支线，本节按 2026-11-19 磁盘实况补写。

### 形态红线：开放盒子，顶不封

- 微缩产物是**两面墙 + 一块地板、顶不封**的开放盒子，陈列视角；**不是封闭房间**。
- 看到「封闭房间 / 看穿率越低越好」的旧判据，先按开放盒子口径重算：
  向上射线 0 命中 = 顶开放；保留墙方向有命中、两开放侧 0 命中。
- **不要用拼接 mesh 的 `trimesh.is_watertight` 判「房间是否封闭」**：多个独立闭合实心板
  拼成的壳体该值仍为 True（按连通体判边共享），会误导。正确判据 = 室内射线开放度 +
  逐块闭合计数（记忆 #342，已验证 2026-11-19；单连通体水密检查 `watertight.py` 不受此影响）。

### 尺度限制：UNMETRIC_SCALE

- COLMAP/SfM 无米制基准：产物单位是 `nu`，`meters_per_unit=null`，诊断固定带
  `UNMETRIC_SCALE`（info）。**不得声明米制尺寸（米 / 毫米）**；解除条件是提供标定物，
  方案见 `docs/miniature/SCALE-CALIBRATION.md`（标注「未实现」）。
- 纹理含推断像素就必须标 `result.synthetic=true`（如 c858 场景 observed 0.467 / inferred 0.533），
  禁止推断冒充实拍；合成夹具（fixture）结果一律不得当真实重建成功。

### 代码与文档地图（2026-11-19 实测盘点）

| 层 | 位置 | 实况 |
|---|---|---|
| Python 管线 | `services/reconstruction/app/miniature/` | 13 个模块（ingest/structure/instances/geometry/texture/pipeline/contracts/coordinates/sfm_io/completion/material_completion/print_export/watertight）+ `tests/` 8 个测试文件 |
| Web 组件 | `apps/web/src/components/miniature/` | 3 个组件：MiniatureLive / MiniatureUploader / StageTimeline（另有 MiniatureUploader.test.tsx） |
| Web 逻辑 | `apps/web/src/lib/miniature/stages.ts` | 六阶段消费契约 + stages.test.ts |
| 路由 | `/miniature`、`/miniature/[id]`、API `/api/reconstructions/[id]/miniature` | 上传页 / 详情页 / 结果接口（三态文案见 T-700018 证据） |
| 文档 | `docs/miniature/` | 7 份：CONTRACT / THRESHOLDS / RUNBOOK / DELIVERY / BENCHMARK / DATA-PROVENANCE / SCALE-CALIBRATION。**CONTRACT 与 THRESHOLDS 是契约与阈值的单一出处**，改数字必须两处同步并附实测依据 |

### 已知断点与证据位置

- **发布断点（A1，P0）**：worker 只把 GLB 写到 `data/reconstructions/<id>/miniature/glb/<id>/scene.glb`，
  **不自动生成**网页详情页读取的 `scene.json` + `room.glb`；`tools/preview_scene_manifest.py`
  在仓库中不存在（历史交付文档引用过它）。即「管线产物完整，发布到网页可读位置尚未自动化」，
  详见 `docs/miniature/DELIVERY.md` ⑤ 与 `NEXT-STEPS.md` 阶段 1。
- 输入准入硬门：≥20 个注册相机、朝向覆盖 ≥180°（`min_lookdir_bins=6/12`）等，
  单一出处 `docs/miniature/THRESHOLDS.md`；上传页目前 3 张就能点，门槛提示未接（A4）。
- 证据：`docs/evidence/miniature/`（本卡基线实测 + 证据可达性审计）、
  `docs/evidence/miniature-three-states/`（T-700018 三态文案实测）、
  `docs/evidence/cache-slots/`（T-700011 多槽缓存，**合成输入**，非真实重建）。
  T-700072 原始产物 `workspaces/700072/artifacts/` **仓库内取不到**，
  索取办法与逐条可达性标注见 `docs/COLLABORATION-READINESS.md`。
