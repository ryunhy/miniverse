# 协作就绪度报告（COLLABORATION-READINESS）

> 产出：2026-11-19 ｜ 执行者：qoder ｜ 任务：T-700015「交接文档纠偏：基线数字、miniature 章节与证据落库」
> 目的：让接手的协作者知道**当前基线是什么、哪些证据拿得到、哪些拿不到、拿不到的去哪要**。
> 方法：全部结论来自本机实测（命令输出存 `docs/evidence/miniature/`），不编造、不美化。
> 环境：Windows 10 26200 / Node v24.21.0 / npm 11.19.0（L1 纯 Web；本机无 Python、无 GPU，未跑重建管线）。
> 树状态：HEAD `d69405a`（Merge PR #3）+ 并行卡未提交改动（审计时 45 项，动态变化）。

## 一、当前实测基线（2026-11-19）

| 检查 | 命令 | 结果 | 退出码 |
|---|---|---|---|
| 测试 | `npm test` | vitest **18 文件 / 173 例全过**，3.75s | 0 |
| 类型 | `npm run typecheck` | tsc **0 错误** | 0 |
| Lint | `npm run lint` | eslint **0 errors 0 warnings**（`--max-warnings 0`；旧 `EditorShell.tsx:23` 未用导入警告已不存在） | 0 |
| 构建 | `npm run build` | EXIT=0，**27 条路由项**，11 条 Turbopack 警告（动态 fs 访问 tracing 等，非错误） | 0 |

原始输出：`docs/evidence/miniature/four-checks-2026-11-19.log`。

**口径说明（不藏差异）**：T-700015 任务卡所附 2026-11-18 基线为 **15 文件 / 137 例**（当时树状态）。
本次复测为 18 文件 / 173 例，差异来自其后合并的 PR #2/#3 门禁测试与并行卡新增用例
（如 `stages.test.ts` 9→19、新增 `MiniatureUploader.test.tsx` 5 例、`vitest.config.ts` 纳入 `*.test.tsx`）。
两个数字都是实测，分别对应各自树状态；历史快照（PROGRESS.md / TEST_REPORT.md 的 45/45、17 路由等）
按「不追改」原则保留，其免责声明原样未动。

## 二、NEXT-STEPS.md §9 证据索引 —— 逐条可达性标注

实测方法：逐路径 `test -e` + `git ls-files`（输出存 `docs/evidence/miniature/reachability-2026-11-19.txt`）。
「本机」= 当前工作树所在磁盘；「入库」= 已被 git 跟踪，克隆可得。

| # | 主题 | 位置 | 可达性 | 索取办法 / 备注 |
|---|---|---|---|---|
| 1 | 未完成事项全清单 | `outputs/2026-11-14/pending-inventory/outputs/PENDING.md` | **不可达**（本机无此目录；`/outputs/` 被 .gitignore:50 排除，克隆亦无） | 向上一任交接人（zcode）索取原工作树 `outputs/2026-11-14/pending-inventory/`；浓缩版已在 `NEXT-STEPS.md` §5，可先用 |
| 2 | 验收漏洞 | `outputs/acceptance-hardening/acceptance-hardening-2026-11-14.md` | **不可达**（同上） | 同上，索取原工作树 `outputs/acceptance-hardening/` |
| 3 | 一致性 loss 基线 | `outputs/consistency-loss/baseline/depth-consistency.json` | **不可达**（同上；「255 视角 AbsRel 中位 0.0020」系 NEXT-STEPS 转录，原件未复核） | 同上，索取 `outputs/consistency-loss/baseline/` |
| 4 | 微缩输入/阶段契约、阈值 | `docs/miniature/CONTRACT.md`、`docs/miniature/THRESHOLDS.md` | **可达**（已入库） | 单一出处，本卡未改 |
| 5 | 微缩交付与验收 | `docs/miniature/DELIVERY.md`（A1 证据 :181-185） | **可达**（已入库；2026-11-19 复核 :183-185 确为「发布未自动化」缺口登记） | 注意 :3 集成包路径指向个人机器（见本报告 §五），该集成包本身不可达 |
| 6 | 造型/尺寸规格 | `docs/furniture/dimension-spec.md` | **可达**（已入库） | — |
| 7 | 尺度标定方案 | `docs/miniature/SCALE-CALIBRATION.md` | **可达**（已入库；:3 明确「方案，未实现」） | — |
| 8 | 历史里程碑 | `HANDOFF.md`、`PROGRESS.md`、`TEST_REPORT.md` | **可达**（已入库） | 历史快照数字不追改；HANDOFF 基线已于 2026-11-19 补当前实测 |
| 9 | 记忆 #8508 / #7224 / #7166 | MemoryOS | **不可达**（2026-11-19 `memory_read` 三个编号均返回「不存在」，疑属旧记忆库编号体系） | 向交接人索取旧库导出，或在当前库按关键词检索（副本验证 / 开放盒子 / 任务看板口径）；开放盒子判据已有替代可达证据：当前库 **#342**（已验证 2026-11-19） |

## 三、RUNBOOK（T-700072）证据索引 —— 整段不可达

`docs/miniature/RUNBOOK.md` 约 10 处引用 `workspaces/700072/artifacts/`
（check_env_072.json、worker_e2e_072.log、cache_matrix_c858.json、resilience_072.json、
unittest_072.log、patch/072-miniature-worker.patch、e2e/cache_matrix_c858/ 等）。

- **可达性：不可达**。仓库无 `workspaces/` 目录，本机磁盘亦无（实测）。
- **索取办法**：向 T-700072 执行者索取原工作树 `workspaces/700072/artifacts/` 整目录。
  在拿到原件前，RUNBOOK §5 表格中的关键数字（78 张照片、19 件家具、冷启 46.9s→续跑 2.7s、
  9/9 断言等）只能视为**当时实测的转录**，无法独立复核；不得据此宣称「本机已验证」。
- RUNBOOK 本身在本卡边界外，未改动；可达的替代实测：`docs/evidence/cache-slots/switchback_timing.json`
  （T-700011，**合成输入**，冷跑 5.3s→切回 0.19s，见 RUNBOOK §4 的如实标注）。

## 四、其他被引用但取不到的产物

| 引用物 | 引用处 | 可达性 | 索取办法 |
|---|---|---|---|
| 附件 `miniverse-parallel-tasks.md`（§零/§一/§四/§9） | T-700015 任务卡 | **不可达**（全仓 find 无此文件，2026-11-19 实测） | 向任务卡下发者索取附件原文；卡正文已含 8 条验收与 11-18 基线，本卡工作未被阻塞。§9 证据索引与 `NEXT-STEPS.md` §9 同构，已按本报告 §二逐条标注 |
| `tools/preview_scene_manifest.py` | DELIVERY.md :184、NEXT-STEPS.md 阶段 1-1 | **不可达**（仓库无此文件） | 向 074 集成包索取；或按 NEXT-STEPS 阶段 1-1 由代码卡补建（本卡只改文档，不补代码） |
| `outputs/integration/sample/`（sample 样例来源） | HANDOFF.md §七、SCENE-MANIFEST.md §五 | **不可达**（本机无；/outputs/ 不入库） | 本机 `data/reconstructions/sample/` 尚在（scene.json + 4 GLB，实测），可直接用；新克隆需向集成批次索取 |
| `data/reconstructions/sample/` | SCENE-MANIFEST.md 验证前提 | **本机可达，克隆不可达**（/data/ 被 .gitignore:49 排除） | 向上一任交接人索取，或按 §五验证入口重新生成 |
| `.ws074/repo` 集成运行副本 | DELIVERY.md :4 | **不可达**（/.ws*/ 不入库，本机无） | 向 074 执行者索取 |

## 五、个人机器绝对路径残留清单（全仓 grep 实测）

验收要求「不再出现指向个人机器绝对路径的代码位置」。本卡独占边界内的已清除；
边界外的如实登记如下，**建议对应责任卡处理**（本卡不改代码、不越界）：

| 位置 | 内容 | 处置 |
|---|---|---|
| `HANDOFF.md:11`（原） | 指向前交接人个人机器（用户 WYX）的 `.zcode/workspace/<uuid>/miniverse` 绝对路径 | **本卡已清除**，改为仓库地址 `https://github.com/ryunhy/miniverse.git` |
| `docs/miniature/DELIVERY.md:3` | 指向该个人机器 Desktop 下集成包的绝对路径 | 边界外（微缩交付文档）。建议责任卡改为「取不到 + 索取路径」表述 |
| `services/reconstruction/scripts/train-now.sh:4` | `REPO=` 硬编码为该个人机器的 WSL 挂载绝对路径 | 边界外且属代码（本卡禁改代码）。建议改为参数/环境变量传入 |
| `services/reconstruction/scripts/diag-task.sh:3` | 同上（`R=` 硬编码） | 同上 |
| `docs/evidence/sfm-merge/synthetic-split-report.json` | 含本机 Temp 目录绝对路径（历史运行产物） | 历史证据原件，按「历史快照不追改」原则保留原样（该目录当前未入库） |

非个人路径、无需处理：`run-worker-wsl.sh:4` 是 `<you>` 占位示例；
`worker-spawn.test.ts:6` 的 `C:\Users\a\b` 是通用测试夹具。

## 六、证据目录入库状态（克隆者视角）

| 目录 | 本机 | git 跟踪 | 说明 |
|---|---|---|---|
| `docs/evidence/miniature/` | 有 | 本卡新增（随本卡提交入库） | 基线日志 + 可达性审计 + 盘点 |
| `docs/evidence/miniature-three-states/` | 有 | 10 文件已 staged（T-700018） | 入库以该卡提交为准 |
| `docs/evidence/scene-manifest-client/` | 有 | 6 文件已入库 | JSON + 5 PNG |
| `docs/evidence/cache-slots/` | 有 | **0（未跟踪）** | T-700011 产出，建议该卡尽快入库，否则克隆者取不到 |
| `docs/evidence/sample-scene-fixture/` | 有 | **0（未跟踪）** | 同上 |
| `docs/evidence/sfm-merge/` | 有 | **0（未跟踪）** | 同上；含历史 temp 路径，入库前由责任卡决定是否脱敏 |
| `docs/evidence/furniture-previews/` | 有 | **0（未跟踪）** | T-700012 产出（含 verification.json），建议该卡尽快入库 |

## 七、并行协作登记说明

- 本卡独占边界：`HANDOFF.md`、`docs/COLLABORATION-READINESS.md`（新建）、
  `docs/evidence/miniature/`（新建）、`docs/SCENE-MANIFEST.md`。全局禁改区未触碰。
- **双登记缺口（如实上报）**：`CLAIM.md` §三.6 要求认领同时在 ACTIVE CLAIMS 加行，
  但 T-700015 任务卡明确「CLAIM.md 属协作护栏卡，本卡不得改」。本卡仅在 MemoryOS 完成
  `task_claim`（#700015，lease 见任务系统）；CLAIM.md 的登记行请护栏卡责任者补记或授权后补。
- 工作树内其他 42+ 项未提交改动属并行卡（T-700006/700008/700009/700011/700012/700018/700020 等），
  本卡未触碰、未提交、未还原。

## 八、结论

- **就绪**：Web 侧四件套全绿（实测见 §一）；微缩契约/阈值/交付文档可达；
  交接文档基线与 miniature 章节已和磁盘对齐。
- **不就绪（需外部输入）**：§二 #1-3、§三、§四所列历史产物取不到，均已给出索取路径；
  微缩「发布到网页」断点（A1）仍未自动化，属代码卡范围；真实米制标定（B1）未实现。
- 本机未验证项：Python/GPU 重建链路、浏览器端到端交互（本卡为纯文档卡，未跑 dev/浏览器）。