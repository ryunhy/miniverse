# scene-manifest v1 · 浏览器客户端接入说明

> 任务：MemOS 任务 #6638「让真实客户端消费 scene-manifest v1 并支持家具选择移动撤销」
> 落地日期：2026-11-05 ｜ 验收证据：`docs/evidence/scene-manifest-client/`

本文只描述**本仓库客户端与服务端**的实现契约。清单的生成方（重建/集成批次）不在本仓库，
样例产物通过 `data/reconstructions/<id>/` 以文件方式交付，`data/` 不入库。

## 一、数据布局

```
data/reconstructions/<id>/
  scene.json                 # scene-manifest v1 清单（必需）
  mesh/ 或 scene/ 或根目录/  # GLB 资产（scene.json 的 assets[].path 相对此目录）
  scene-edits.json           # 用户布局（首次保存时原子写入）
```

- `scene.json` 的 `schema` 必须等于
  `apps/web/src/lib/server/recon-editable-scene.ts` 中的 `SCENE_MANIFEST_SCHEMA` 常量，否则 400。
- `assets` 里的 `path` 只允许声明过的 `.glb`，且禁止路径穿越；`asset: "scene"` 可别名到 `room`
  （部分批次把合并场景命名为 scene.glb，HTTP 侧仍以 `?asset=room` 取默认整场景）。
- 场景版本 = `sha256(scene.json 字节)`。重建重跑后版本变化，旧布局会被标记 `editsStale`。

## 二、清单字段（客户端实际消费的部分）

| 字段 | 用途 |
|---|---|
| `sceneId` | 与布局文件、请求路径交叉校验 |
| `units` / `upAxis` | v1 = `nu` / `+Y`；客户端不得再自行改轴 |
| `assets` | 资产名 → `{path, bytes, sha256}`；用于请求 `/scene/glb?asset=` |
| `objects[].objectId` | 稳定主键；选择、布局、撤销都以此为准 |
| `objects[].nodeName` | 与 GLB 节点名匹配；匹配不到的条目会被跳过（不猜测） |
| `objects[].label` | 中文展示名（`obj-walls/floor/sofa` 有内置中文名） |
| `objects[].role` | `background` / `furniture`；缺失时按 `objectId+nodeName+label` 关键词兜底推断 |
| `objects[].startTransform` | 初始 `position/quaternion/scale/visible`（有限数值校验，NaN/Inf 拒绝） |

坐标约定：清单里的变换就是 GLB 所在的世界系（nerfstudio 归一化系，米制不适用），
客户端不额外套旋转；这与 `MeshViewer` 的只读展示路径一致。

## 三、HTTP 接口

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/api/reconstructions/<id>/scene` | `{manifest, sceneVersion, assets:{名→sha256}, edits, editsStale}`，`Cache-Control: no-store` |
| HEAD | 同上 | 204（清单存在）/ 404 / 400；详情页据此决定走可编辑场景还是只读网格 |
| GET/HEAD | `/api/reconstructions/<id>/scene/glb?asset=room` | GLB 二进制；`ETag = "sha256"`，`If-None-Match` 命中 304；`download=1` 加附件头 |
| GET | `/api/reconstructions/<id>/scene/edits` | 已保存布局（无则 `edits: null`） |
| PUT | 同上 | 请求体 = `SceneEdits`；`baseSceneVersion` 不等于当前版本 → **409** `{code:"stale_scene_version", currentVersion}` |
| DELETE | 同上 | 清除布局（幂等） |

布局写入为 `tmp + rename` 原子替换；对象集合必须与清单一致（未知 objectId → 400）。
客户端保存成功后把返回的 `sceneVersion` 作为新的 `baseSceneVersion`，连续保存不会自撞 409。

## 四、客户端交互（`EditableSceneViewerCore`）

页面：`/reconstructions/<id>` 先发 `HEAD /scene`，存在清单时渲染 `EditableSceneViewer`，
否则回退只读 `MeshViewer`（不改变旧任务的行为）。

- **选择**：画布射线拾取，`userData.objectId` 沿父链回溯；点空白处取消选择；Esc 同效。
- **移动/旋转/缩放**：`TransformControls`，模式按钮 `mode-translate|rotate|scale`；
  另有 X/Y/Z 数值输入框（`pos-x|y|z`），改一次即入撤销栈。
- **隐藏**：每个对象一个 `toggle-<objectId>`；家具可从「移除家具」批量隐藏。
- **撤销**：整份草稿快照栈（上限 50），Ctrl/Cmd+Z 或 `undo` 按钮；
  一次 gizmo 拖动只在 `mouseUp` 提交一条历史，撤销后位置与画布像素都回到拖动前。
- **保存 / 刷新恢复**：`save-layout` → PUT；页面重载后 GET 返回的 `edits` 覆盖 `startTransform`，
  版本不一致时提示布局过期并提供「清除已保存布局」。
- **背景检查**：`remove-furniture` 后以 24×24=576 条视线采样，
  区分 `newHoles`（四周被背景几何包围的新洞）与 `silhouetteMisses`（房间开放边界/天空）。
  `pass = newHoles === 0 && afterHits > 0`；结果如实展示，不因 `newHoles > 0` 隐藏或改写。

### 拖动手势与选择的冲突（已修）

`TransformControls` 在 `onMouseUp` 里把 `dragging` 置回 false，随后 R3F 的 `click` 仍会派发；
若松手位置下面恰好是地板/墙体，选择会被抢走（表现为撤销后高亮停在地板上、画布像素差非 0）。
现在 `onClick` 以 `e.delta > 4` 过滤拖动结束的点击，并在 CDP 证据里验证撤销后 `selectedId` 仍是沙发。

## 五、验证入口

```bash
npm run build
cd apps/web && npx next start -p 3211        # 生产构建，避免 dev 的 HMR 干扰
node tools/verify-scene-manifest-client.mjs  # 真实 Chrome（headless + CDP）
```

前提：`data/reconstructions/sample/` 有 `scene.json` + `room/walls/floor/sofa.glb`
（从集成批次 `outputs/integration/sample/` 复制，命令只消费不生成）。

产物写入 `docs/evidence/scene-manifest-client/`：

| 文件 | 内容 |
|---|---|
| `client-interaction.json` | 逐步骤状态 + `verdict`（选择/变换/撤销/隐藏/保存/背景检查/刷新恢复） |
| `before-drag.png` / `after-drag.png` / `after-undo.png` | 拖动前、拖动后、撤销后 |
| `background-check.png` / `after-reload.png` | 移除家具后的检查、刷新恢复 |

2026-11-05 实测（`sample`，`sceneVersion` 由 `scene.json` 内容决定）：

```json
{ "selection_ui_appeared": true, "transform_ui_appeared": true, "undo_ui_appeared": true,
  "hide_ui_appeared": true, "save_ui_present": true, "refresh_restore": true,
  "selection_via": "canvas", "transform_via": "gizmo",
  "canvas_pixels_changed_by_drag": true, "canvas_pixel_diff_after_undo": 0,
  "background_check_pass": false, "background_new_holes": 1,
  "background_silhouette_misses": 10 }
```

背景检查未通过不是客户端故障：`sample` 的家具下方网格在移除后确实露出 1 个视线洞
（`baselineHits=59 → afterHits=48`），本任务验收只要求该功能可用且结果如实上报。

## 六、测试与门禁

- `apps/web/src/lib/server/recon-editable-scene.test.ts`：14 例（schema/重复 id/非法变换/
  路径穿越/别名/版本冲突/未知 objectId/清除幂等）
- `apps/web/src/lib/scene-types.test.ts`：3 例（role 推断、有限数值）
- 四件套：`npm test`、`npm run typecheck`、`npm run lint`、`npm run build`。
  旧表述「12 文件 / 93 例、仅 `EditorShell.tsx:23` 历史未用导入警告」是 2026-11-05 时点快照，已过期。
  **当前实测（2026-11-19，T-700015 复核）**：vitest **18 文件 / 173 例全过**、tsc **0 错误**、
  eslint **0 errors 0 warnings**（`--max-warnings 0`，EditorShell 未用导入警告已不存在）、
  build EXIT=0（**27 条路由项**、11 条 Turbopack 警告）。
  环境：Windows 10 26200 / Node v24.21.0 / npm 11.19.0，HEAD `d69405a` + 并行卡未提交改动
  （测试数含并行卡新增用例；2026-11-18 基线为 15 文件 / 137 例）。
  原始输出：`docs/evidence/miniature/four-checks-2026-11-19.log`。

## 七、已知限制

- 单场景单文件布局，不做跨任务共享；并发编辑只保证 409 提示，不自动合并。
- 仅支持 `.glb` 资产；清单声明缺失的对象会被跳过而不是阻断整页。
- `data/` 与验收证据目录不属于本仓库交付物；禁止把 Blender 侧移动当作客户端交互证据。
