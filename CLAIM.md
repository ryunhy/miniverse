# CLAIM — MiniVerse 协作分区与占用登记

> 本仓库同时有真人、多个 AI 工具（Claude / GitHub Copilot / Qwen / Antigravity / WorkBuddy / Codex / Trae 等）在改代码。
> **动手前先读本文件，改完登记。** 未登记的跨区改动视为越界；与本文件冲突时以本文件为准。
> 与 `AGENTS.md` 的关系：`AGENTS.md` 管「代码怎么写」（不变量），本文件管「谁在改哪里」（协作边界）。

## 一、硬分区（默认独占，跨区必须先在下方登记）

> **唯一基线**：GitHub `ryunhy/miniverse` 的 `main` 分支。规划附件提到的另一棵本地脏树（mimicode，HEAD `dc3012e`）的内容已入库为 `5f32228`，该脏树废弃，不得在其上并行改动或推送。

| 分区 | 路径 | 默认归属 | 说明 |
|---|---|---|---|
| 共享契约 | `packages/shared/src/` | 需双方评审 | 场景 Schema / 素材白名单。改动必须跑 `npm test`，且不得绕过白名单 |
| Web 应用 | `apps/web/src/` | 前端 | Next.js 路由、组件、API route |
| └ 3D 编辑器 | `apps/web/src/components/editor/` | 编辑器 | EditorShell / LeftPanel / SceneCanvas |
| └ 查看器 | `apps/web/src/components/splat/`、`components/mesh/` | 查看器 | Splat / Mesh 渲染核心 |
| └ 服务端 lib | `apps/web/src/lib/server/` | Web 后端 | 任务状态、worker 拉起 |
| 重建服务 | `services/reconstruction/app/` | Python / 重建 | pipeline、mesh、miniature |
| 文档 | `docs/`、`*.md`（根目录协作文档除外） | 文档 | |
| 测试 | `tests/`、`**/*.test.ts`、`services/**/tests/` | 共享 | 新增优先，改动他人测试需登记 |
| 根构建配置 | `package.json`、`vitest.config.ts`、`.gitignore`、`tsconfig*.json`、`.github/workflows/`、`services/reconstruction/{pytest.ini,requirements-dev.txt}` | **必须登记** | 冲突高发区，改前先在 ACTIVE CLAIMS 写一行；workflows 与 pytest.ini / requirements-dev.txt 属 CI 门禁区 |

## 一·补、全局禁改区（任何 agent 不得直接改动）

以下文件是全仓正确性的根基，改动必须走 PR + 双方评审，且先在 ACTIVE CLAIMS 登记：

- `packages/shared/src/scene-schema.ts`、`packages/shared/src/asset-catalog.ts`（场景 Schema 与素材白名单）
- `apps/web/src/lib/server/recon-editable-scene.ts`、`apps/web/src/lib/server/task-store.ts`、`apps/web/src/lib/server/uploads.ts`（Web 服务端契约）
- `apps/web/src/components/mesh/*`、`apps/web/src/components/splat/*`（渲染核心）
- `AGENTS.md` 顶部 `nextjs-agent-rules` 注释块（由 `next dev` 自动维护，必须原样保留）

例外流程：确需改动时，在 ACTIVE CLAIMS 写明理由与影响面，PR 描述注明「全局禁改区变更」，双方评审通过后方可合入。

## 二、ACTIVE CLAIMS（进行中，改前必须查）

| 日期 | 归属者 | 分支 / 会话 | 路径范围 | 状态 | 退出条件 |
|---|---|---|---|---|---|
| 2026-11-18 | Trae | `mimicode`（本地未提交） | 见 `git status` 的 30+ 改动 | 已释放 | 2026-11-18 已整体提交并推送至 `main`（`5f32228`），分区释放 |
| 2026-11-18 | qoder（Qoder Desktop） | 本地工作树 | `services/reconstruction/app/miniature/{print_export.py,watertight.py,geometry.py,material_completion.py}` 及 `tests/{test_print_export.py,test_watertight.py,test_geometry_style.py}`（新增）；MemoryOS T-700008/T-700009/T-700020 独占区 | 进行中 | 三卡 task_done 验收后释放；不碰 sfm_io.py / worker.py / pipeline.py / texture.py 及 Web 侧他人未提交改动 |
| 2026-11-19 | zcode | `main` + 本地工作树 | MemoryOS T-700014/700017：CLAIM.md / CONTRIBUTING.md / `.github/{PULL_REQUEST_TEMPLATE.md,ISSUE_TEMPLATE/}`；`apps/web/src/{proxy.ts,lib/server/auth.ts,lib/server/rate-limit.ts}` 及其测试 | 已释放 | 两卡已验收关闭（PR #2 e6298a3 / PR #3 d69405a 已合并）；T-700013 CI 门禁区已合并入 main（PR #1 59751db） |
| 2026-11-19 | qoder（Qoder Desktop） | 本地工作树 | MemoryOS T-700006/700011/700012 独占区：`apps/web/src/components/miniature/{MiniatureUploader.tsx,MiniatureUploader.test.tsx(新增),StageTimeline.tsx}`、`apps/web/src/components/editor/LeftPanel.tsx`、`tools/generate-furniture-glb.mjs`、`services/reconstruction/app/miniature/{pipeline.py,tests/test_cache_slots.py(新增)}`、`apps/web/public/assets/furniture/previews/`(新增预览图)、`docs/evidence/cache-slots/`(新增证据)；**根构建配置登记**：`vitest.config.ts` include 增加 `*.test.tsx`、`apps/web/package.json` 增加 jsdom/@testing-library/react devDeps（组件测试必需，PR 时注明） | 进行中 | 三卡 task_done 验收后释放；不碰 THRESHOLDS.md/contracts.THRESHOLDS/asset-catalog.ts/Furniture.tsx/geometry.py/worker.py/sfm_io.py 及他人未提交改动 |

| 2026-11-19 | zcode | `feature/miniature-publish`（PR：worker 自动发布 + 微缩失败归因） | `services/reconstruction/app/worker.py`、`apps/web/src/lib/miniature/{failure.ts,failure.test.ts,stages.ts}`、`apps/web/src/components/miniature/MiniatureLive.tsx` | 已释放 | MemoryOS 卡 #700121/#700122/#700123 已 task_done 验收关闭；PR 合入后分区释放 |
> 规则：开工前在你那一行写清「谁 / 分支 / 路径 / 状态 / 何时释放」。收工后改成 `已释放`，不要直接删行（保留审计）。

## 三、登记规则

1. 只改自己分区内的文件；要跨区，先在「二、ACTIVE CLAIMS」加一行，写明路径与退出条件。
2. 同一文件两方同时改 → **后到者停手**，等先登记者释放；不要靠合并解决。
3. 改 `packages/shared/` 或根构建配置 → 必须走 PR，且 PR 描述里注明「共享契约变更」。
4. 分支自用，不推共享分支名（如 `main`、`mimicode`）；见 `CONTRIBUTING.md` 的分支命名。
5. 构建产物、实验脚本、临时输出放 `outputs/` 或独立目录，不提交进源码树；禁止 `git add -A` 盲加。
6. **与 MemoryOS 任务卡双登记**：认领 = `task_claim` 成功 + 本文件 ACTIVE CLAIMS 加一行；释放 = `task_done`/`task_release` + 对应行改「已释放」。两处必须同步更新，只有其一视为未认领/未释放。

## 四、冲突处置

| 情况 | 处理 |
|---|---|
| 发现目标文件有他人未提交改动 | 停手，读 `git status` / `git diff` 判断归属，联系归属者 |
| 双方已改同一文件 | 以先登记者为准，后到者 `git checkout -- <file>` 回退自己那部分，重新规划 |
| 共享契约 vs 功能需求冲突 | 改契约走 PR + 双方 review，不允许单方直接改 |
| 无法判定归属 | 停止改动，向仓库 owner 报告，不带猜测继续 |

## 五、禁止事项

- 禁止 `git reset --hard` / `git checkout .` / `git clean -f` 等破坏性命令（会抹掉他人工作）。
- 禁止强制推送到 `main`。
- 禁止提交 `.env`、Token、API Key、凭据文件。
- 禁止删除失败日志、降低验收标准来"让测试通过"。
