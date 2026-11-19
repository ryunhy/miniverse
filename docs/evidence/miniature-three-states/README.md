# T-700018 实测证据 — 微缩结果接口三态文案

日期：2026-11-18 · 执行者：qoder · 环境：Windows 10 / Node v24.21.0 / npm 11.19.0 / Next 16.4.6（L1 纯 Web，无 Python/GPU）

## 结论

`GET /api/reconstructions/<id>/miniature` 的产物核对不再一律报「磁盘上找不到该文件」，三种真实状态分开表达，文案与 HTTP 码互不相同：

| 状态 | 触发条件 | HTTP | banner.level | 文案关键字 |
|---|---|---|---|---|
| 未发布 | 磁盘上没有 scene.json | 404 | warn | 尚未发布 / scene.json |
| 资产缺失 | 清单合法但声明的 GLB 文件不在磁盘 | 409 | error | 资产文件缺失 |
| 清单非法 | schema 不支持 / 无法解析 / 资产路径非法或越界 | 422 | error | 非法 |
| 成功（对照） | 清单合法且文件存在 | 200 | ok | 生成完成 |

三态均 `ready=false`、`glb=null`、export 阶段显式 `failed`；没有任何把 ready 强置 true 的路径。
失败响应体仍携带完整 `view`（六阶段齐全、身份字段保留），消费契约由 stages.test.ts 回归钉死。

## 实测记录（全部真实执行）

### 1. 单元/集成测试

命令：`npx vitest run apps/web/src/lib/miniature/stages.test.ts`
结果：19 passed（原 9 + 新增 10），退出码 0。

命令：`npm test`
结果：Test Files 15 passed (15)，Tests 147 passed (147)，退出码 0。

### 2. 类型检查 / Lint

命令：`npm run typecheck` → tsc --noEmit 无输出，退出码 0。
命令：`npm run lint` → eslint . 无输出（0 error 0 warning），退出码 0。

### 3. curl 实测（?fixture=1 与自造临时清单驱动 route）

准备：`node docs/evidence/miniature-three-states/seed.mjs D:/anzhuangbao/miniverse/outputs/t700018/data`
（在 gitignore 的 outputs/ 下造独立数据目录：5 个 completed 任务 + 自造临时清单；不触碰仓库 data/）

启动：`MINIVERSE_DATA_DIR=D:/anzhuangbao/miniverse/outputs/t700018/data npm run dev`

| 请求 | 实测 HTTP | 响应体存档 |
|---|---|---|
| /api/reconstructions/ev-unpublished/miniature | 404 | ev-unpublished.json |
| /api/reconstructions/ev-missing/miniature | 409 | ev-missing.json |
| /api/reconstructions/ev-invalid-path/miniature（assets.room.path=../evil.glb） | 422 | ev-invalid-path.json |
| /api/reconstructions/ev-bad-schema/miniature（schema=v0） | 422 | ev-bad-schema.json |
| /api/reconstructions/ev-ok/miniature（合法清单+最小 GLB） | 200 | ev-ok.json |
| /api/reconstructions/any-id/miniature?fixture=1 | 200 | fixture.json（synthetic=true） |

各响应体的 ready / banner.level / banner.text / export 阶段明细见 `summary-bodies.md`（由实际响应 JSON 提取）。
成功态 bytes=72 来自对真实落盘最小 GLB 的 stat；fixture 的 bytes=1024 是合成契约值，响应显式 synthetic=true。

### 4. 构建

命令：`npm run build` → 退出码 0（BUILD_EXIT=0），路由表完整输出（含 /api/reconstructions/[id]/miniature 与 /miniature/[id]），无编译错误。

### 5. 改动边界证明

`git diff --stat`（全文见 code.diff）：

```
apps/web/src/app/api/reconstructions/[id]/miniature/route.ts | 50 +++++---
apps/web/src/lib/miniature/stages.test.ts                    | 136 +++++++++++++-
apps/web/src/lib/miniature/stages.ts                         | 79 ++++++++++
3 files changed, 249 insertions(+), 16 deletions(-)
```

只改卡内三个文件；未触碰全局禁改区（scene-schema.ts / asset-catalog.ts / recon-editable-scene.ts / task-store.ts / uploads.ts / components/mesh/* / components/splat/* / AGENTS.md 注释块），也未改 reconstructions 目录下其他 route。新增文件仅本证据目录。

## 复现步骤

```bash
npm ci
node docs/evidence/miniature-three-states/seed.mjs <绝对路径>/t700018-data
MINIVERSE_DATA_DIR=<绝对路径>/t700018-data npm run dev
# 另开终端：
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/reconstructions/ev-unpublished/miniature  # 404
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/reconstructions/ev-missing/miniature      # 409
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/reconstructions/ev-invalid-path/miniature # 422
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/reconstructions/ev-ok/miniature           # 200
```

## 如实披露的限制

1. 现有消费端 `MiniatureLive.tsx` 的 refresh 对非 2xx 响应直接 return（不读 body）。因此这三种失败态的 banner 目前能在 HTTP 层完整拿到，但详情页要显示它们，需要消费端后续改为读取失败响应体里的 view——该组件不在本卡独占范围内，未改动。本卡已用测试钉死「失败响应体仍完整可渲染」的契约，消费端改造后可直接消费。
2. 实测用 GLB 是为 stat 核对构造的最小 glTF 2.0 空场景（72 字节），不是真实重建产物；ev-ok 只证明核对链路，不证明渲染效果。
3. 三态归类依赖禁改区 recon-editable-scene.ts 的错误消息前缀（「场景不存在」/「资产文件不存在」），已用回归测试钉死该消息契约；若该文件未来改消息，测试会先红。