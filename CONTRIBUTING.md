# 贡献指南

MiniVerse 是 monorepo：`apps/web`（Next.js）、`packages/shared`（共享契约）、`services/reconstruction`（Python 重建流水线）。
协作边界与文件归属见 [CLAIM.md](CLAIM.md)；代码不变量见 [AGENTS.md](AGENTS.md)。

## 1. 分支

| 用途 | 命名 | 从哪切 |
|---|---|---|
| 新功能 | `feature/<scope>-<简述>` | `main` |
| 修复 | `fix/<简述>` | `main` |
| 文档 | `docs/<简述>` | `main` |
| 实验 | `exp/<简述>` | 自选，禁止合入 `main` |

- 命名用英文小写 + 连字符，例如 `feature/miniature-export`、`fix/mesh-status-polling`。
- 一个分支只做一件事；不要在一个分支里混多个不相关改动。

## 2. 提交

遵循 Conventional Commits：

```
<type>(<scope>): <简述>
```

- `type`：`feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `perf`
- `scope`：`web` / `shared` / `reconstruction` / `editor` / `mesh` / `miniature`
- 示例：`feat(web): 重建列表增加取消按钮`、`fix(mesh): 修正 PLY 竖直轴立起角度`

要求：
- 一次提交只含一个逻辑变更，不要把格式化与功能混在一起提交。
- 提交前跑 `git status` 确认没有误纳 `node_modules/`、`outputs/`、大文件。
- 提交信息说清「为什么」，不只是「改了什么」。

## 3. PR 流程

1. 从 `main` 切分支 → 本地开发 → 自测通过。
2. 推送分支，向 `main` 开 PR（不要直接推 `main`）。
3. PR 描述必须包含：
   - **改了什么**：核心变更点
   - **为什么**：解决什么问题
   - **如何验证**：执行的命令与输出结论（附实证，不写「应该可以」）
   - 是否触及共享契约（`packages/shared/`）或根构建配置
4. 至少 1 人 review 通过后合并；触及共享契约需双方评审。
5. 合并后删除源分支。

## 4. 验证四件套（提交前必跑）

```bash
npm test          # vitest
npm run typecheck # tsc
npm run lint      # eslint
npm run build     # next build
```

- 改动 `packages/shared/`（场景 Schema / 素材白名单）后**必须**跑 `npm test`。
- 任何一条失败就修到通过，不允许用 skip、放宽断言、删日志来「变绿」。
- 环境缺失导致跑不了（如 WSL/CUDA 未就绪），在 PR 里如实说明，不降低验收标准。

## 5. 不变量提醒（违反即拒收）

- `objects[].assetId` 只能取自 `packages/shared/src/asset-catalog.ts`，禁止任意模型路径或外部 URL。
- 坐标系：米制、Y 轴向上、家具原点在底部中心；PLY 竖直轴为 Z，显示用 `Rx(-90°)`，**勿回退为 X180**。
- `objects[].origin` ∈ `user` / `ai-detected` / `ai-inferred`，不得混淆。
- 演示 / 程序生成 / 合成数据必须标注 `synthetic`，不得冒充真实重建。
- Web ↔ Python 只通过 `data/tasks/<id>/{input,status,worker.log,cancel.flag}` 文件协议通信。

## 6. 敏感信息

- 不提交 `.env`、Token、API Key、凭据、个人路径绝对地址。
- 需要新配置项时，提交 `.env.example` 并说明含义，真实值由各自本地填写。
