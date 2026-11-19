# T-700005 证据：程序生成样例场景 + scene-manifest v1 客户端契约验收

日期：2026-11-18（UTC+8 约 22:55–23:06）
环境：Windows 10.0.26200，Node v24.21.0 / npm 11.19.0，Chrome（headless + CDP，端口 9344）。
Shell 说明：本机无 pwsh（已如实披露），全部命令在环境自带 Git Bash 中执行。

## 合成声明（诚实原则）

本目录全部证据基于**程序生成的合成样例**，不是真实重建：

- `data/reconstructions/sample/scene.json` 中 `synthetic: true`，
  `note: "程序生成样例场景，非真实重建；仅供 scene-manifest v1 客户端契约验收，不得作为真实重建证据"`，
  `generator: { tool: "tools/generate-sample-scene.mjs", definition: "tools/sample-scene/scene-definition.json" }`。
- 每个 object 的 provenance 均为 `{ source: "procedural", synthetic: true }`。
- 页面可见标注：obj-room 的清单 label 为「房间外壳（程序生成样例·非真实重建）」，
  对象列表永久渲染该 label（EditableSceneViewerCore 的 LABELS 覆盖表不含 obj-room，
  组件属禁改区，故标注走清单数据而非改组件）。验收断言 `synthetic_annotation_visible: true`。
- 客户端验收结果只证明 **scene-manifest v1 的消费契约**（选择/变换/撤销/刷新恢复/背景检查），
  不代表任何真实场景的重建质量。

## 复现命令与退出码（干净克隆即可复现，无私有数据依赖）

仓库根目录执行：

```bash
node tools/generate-sample-scene.mjs        # exit 0（内置自校验：schema/synthetic/资产哈希/节点名覆盖，失败 exit 1）
npm test                                     # exit 0（15 个测试文件，147 个用例全过）
npm run typecheck                            # exit 0
npm run lint                                 # exit 0
npm run build                                # exit 0
(cd apps/web && npx next start -p 3211)      # 生产服务器，服务最终构建
OUT_DIR=docs/evidence/sample-scene-fixture/client node tools/verify-scene-manifest-client.mjs
                                             # exit 0（对最终构建重跑，2026-11-18 23:06）
```

四件套日志存档于会话临时目录 /tmp/t700005-{test,typecheck,lint,build}.log，
汇总退出码：test=0 / typecheck=0 / lint=0 / build=0。
生成器确定性：不含时间戳，重复运行产物字节一致（资产 sha256 写入清单）。

## 证据清单

- `client/client-interaction.json` — 全部判据为 true：
  selection/transform/undo/hide/save UI 出现；`selection_via: "canvas"`、`transform_via: "gizmo"`；
  拖拽像素变化 true；撤销后像素差 0；刷新恢复 true；
  背景检查 pass（576 条射线，baselineHits=156，afterHits=156，newHoles=0，silhouetteMisses=0）；
  `synthetic: true`、`synthetic_annotation_visible: true`。
- `client/{before-drag,after-drag,after-undo,background-check,after-reload}.png` — 交互截图。
- `scene-get.json` — `GET /api/reconstructions/sample/scene` 200 响应（含完整清单与来源声明）。
- `code.diff` — 本卡代码改动归档（verify 脚本 46+/5-；新增生成器与场景定义见下）。

## 体积证明（验收要求 < 2MB）

- 本证据目录合计约 392KB（`du -sh` 实测）。
- 样例资产合计约 25KB：room.glb 10820B、sofa.glb 6744B、walls.glb 2924B、floor.glb 1656B、scene.json 3320B。

## 本卡新增/修改的代码

- 新增 `tools/generate-sample-scene.mjs`（glTF 2.0 二进制组装，多节点 room.glb + 单资产 GLB）。
- 新增 `tools/sample-scene/scene-definition.json`（合成场景定义，synthetic=true）。
- 修改 `tools/verify-scene-manifest-client.mjs`（读取清单来源声明、合成警告、
  `synthetic_annotation_visible` 判据、报告 data_origin；合成样例未显示标注则验收失败）。
- 未触碰任何禁改区（scene-schema.ts、asset-catalog.ts、recon-editable-scene.ts、
  task-store.ts、uploads.ts、components/mesh/*、components/splat/*、AGENTS.md 顶部块）。

## 限制与未验证项

- 合成样例无法证明真实重建管线质量；真实批次证据在 `docs/evidence/scene-manifest-client/`（历史，未覆盖）。
- 客户端验收仅覆盖 Chrome headless（Windows）；未覆盖移动端/其他浏览器。
- `npm test` 的 147 用例含本仓全部既有测试，非仅本卡新增。