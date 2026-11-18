# 贡献指南

MiniVerse 是 monorepo：`apps/web`（Next.js）、`packages/shared`（共享契约）、`services/reconstruction`（Python 重建流水线）。
协作边界与文件归属见 [CLAIM.md](CLAIM.md)；代码不变量见 [AGENTS.md](AGENTS.md)。

## 0. 唯一基线

本仓库**唯一基线**是 GitHub `ryunhy/miniverse` 的 `main` 分支，所有分支从它切出。规划附件提到的另一棵本地脏树（mimicode，HEAD `dc3012e`）的内容已入库为 `5f32228`，该脏树已废弃——不得在其上并行改动或推送，否则与唯一基线分叉。

## 0·补. 环境分级

| 级别 | 范围 | 能跑什么 | 依赖 |
|---|---|---|---|
| L1 | 纯 Web / 文档 | 四件套（`npm test` / `typecheck` / `lint` / `build`） | Node 24，`npm ci` 即可 |
| L2 | L1 + Python CPU 侧 | `npm run test:py`（pytest，无需 CUDA） | Python 3.12 + `services/reconstruction/requirements-dev.txt`（numpy / scipy / Pillow / pytest） |
| L3 | 完整重建环境 | 重建主链（3DGS / mesh / miniature 全流水） | WSL2 Ubuntu + CUDA + nerfstudio + COLMAP，见 `services/reconstruction/requirements.txt` 与 `docs/INSTALL-Windows-WSL2.md` |

- PR 只需声明你在哪一级验证过；L1/L2 缺失必须在 PR「已知没做的部分」写明。
- 环境分级与 CLAIM.md 的分区无关：任何级别改动都要遵守分区与登记规则。

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
2. 推送分支，向 `main` 开 PR（不要直接推 `main`）；PR 描述按 `.github/PULL_REQUEST_TEMPLATE.md` 填写。
3. PR 描述必须包含（模板强制）：
   - **改了什么**：核心变更点
   - **为什么**：解决什么问题
   - **实测证据**：执行的命令与输出结论（附实证，不写「应该可以」，禁用 should / probably / 基本上）
   - **已知没做的部分**：没覆盖的路径、没跑的环境、遗留风险（没有就写「无」）
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
- 坐标系：米制、Y 轴向上、家具原点在底部中心；PLY 竖直轴为 Z，显示用 `Rx(-90°)`，**勿回退为 X180**（会把房间竖到编辑器 Z 轴，画面 roll / 倒置）。
- `objects[].origin` ∈ `user` / `ai-detected` / `ai-inferred`，不得混淆。
- 演示 / 程序生成 / 合成数据必须标注 `synthetic`，不得冒充真实重建。
- Web ↔ Python 只通过 `data/tasks/<id>/{input,status,worker.log,cancel.flag}` 文件协议通信。
- 微缩形态为两面墙 + 地板、顶不封的开放盒子。

## 6. 敏感信息

- 不提交 `.env`、Token、API Key、凭据、个人路径绝对地址。
- 需要新配置项时，提交 `.env.example` 并说明含义，真实值由各自本地填写。
