# CLAIM — MiniVerse 协作分区与占用登记

> 本仓库同时有真人、多个 AI 工具（Claude / GitHub Copilot / Qwen / Antigravity / WorkBuddy / Codex / Trae 等）在改代码。
> **动手前先读本文件，改完登记。** 未登记的跨区改动视为越界；与本文件冲突时以本文件为准。
> 与 `AGENTS.md` 的关系：`AGENTS.md` 管「代码怎么写」（不变量），本文件管「谁在改哪里」（协作边界）。

## 一、硬分区（默认独占，跨区必须先在下方登记）

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
| 根构建配置 | `package.json`、`vitest.config.ts`、`.gitignore`、`tsconfig*.json` | **必须登记** | 冲突高发区，改前先在 ACTIVE CLAIMS 写一行 |

## 二、ACTIVE CLAIMS（进行中，改前必须查）

| 日期 | 归属者 | 分支 / 会话 | 路径范围 | 状态 | 退出条件 |
|---|---|---|---|---|---|
| 2026-11-18 | Trae | `mimicode`（本地未提交） | 见 `git status` 的 30+ 改动 | 在途 | 归属者确认后提交或回滚 |

> 规则：开工前在你那一行写清「谁 / 分支 / 路径 / 状态 / 何时释放」。收工后改成 `已释放`，不要直接删行（保留审计）。

## 三、登记规则

1. 只改自己分区内的文件；要跨区，先在「二、ACTIVE CLAIMS」加一行，写明路径与退出条件。
2. 同一文件两方同时改 → **后到者停手**，等先登记者释放；不要靠合并解决。
3. 改 `packages/shared/` 或根构建配置 → 必须走 PR，且 PR 描述里注明「共享契约变更」。
4. 分支自用，不推共享分支名（如 `main`、`mimicode`）；见 `CONTRIBUTING.md` 的分支命名。
5. 构建产物、实验脚本、临时输出放 `outputs/` 或独立目录，不提交进源码树；禁止 `git add -A` 盲加。

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
