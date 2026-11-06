<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# MiniVerse — 项目硬约束

> 上方 `nextjs-agent-rules` 注释块由 `next dev` 自动维护，**必须原样保留**；项目硬约束追加在其后。

## 不变量（改代码前必读）

- **素材白名单**：`objects[].assetId` 只能取自 `packages/shared/src/asset-catalog.ts`，禁止任意模型路径 / 外部资源 URL。
- **坐标系**：米制、Y 轴向上、家具原点在底部中心；重建与编辑共享同一世界坐标。nerfstudio 导出的 PLY 竖直轴是 **Z**，显示时需 **Rx(-90°)** 立起为 Y-up；**勿回退为 X180**（会把房间竖到编辑器 Z 轴，导致画面 roll / 倒置）。
- **origin 来源标注**：`objects[].origin` ∈ `user` / `ai-detected` / `ai-inferred`，三种来源不得混淆。
- **诚实原则**：演示 / 程序生成 / 合成数据必须标注 `synthetic`，禁止冒充真实重建；环境缺失或任务失败必须如实上报，不许降低验收标准、不许删失败日志。
- **Web ↔ Python 解耦**：两端只通过 `data/tasks/<id>/{input,status,worker.log,cancel.flag}` 文件协议通信，Web 端读取时懒同步 SQLite。
- **完成声明须附实证**：命令输出 / HTTP 码 / 截图；禁用 should / probably / 基本上 等模糊表述。

## 验证入口

- 改动 `packages/shared`（场景 Schema / 素材白名单）后必须跑 `npm test`。
- 提交前四件套：`npm test`、`npm run typecheck`、`npm run lint`、`npm run build`。
