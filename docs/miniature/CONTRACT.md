# 微缩重建输入与阶段产物契约（miniature.* v1）

单一实现出处：`services/reconstruction/app/miniature/contracts.py`。
阈值单一出处：`docs/miniature/THRESHOLDS.md`（代码侧常量在 `contracts.THRESHOLDS`）。

## 1. 为什么有这层契约

微缩重建被拆成 输入 → 结构 → 实例 → 几何 → 纹理 → 报告 六个阶段，由不同卡片并行实现。
阶段之间只通过 JSON 产物交接，不共享 Python 对象，不靠调用方"记得"某个约定。

三条硬规则：

- **数值必须带来源**：`measured`（实测）/ `inferred`（推断）/ `manual`（人工）/ `unmetric`（无标定）。
  裸数字不允许出现在产物里。
- **拒绝就说拒绝**：不支持、覆盖不足、缺基线一律 `status=unsupported` + 可机读诊断码，
  不允许返回"看起来成功"的空结果。
- **坐标只换算一次**：raw（COLMAP 世界）→ local（房间局部 Y-up）由 `coordinates.build_frame`
  显式给出 4×4 矩阵，后续阶段只消费 local，不再自己推。

## 2. 坐标系与尺度

| 名称 | 定义 | 单位 | 出处 |
|---|---|---|---|
| raw | COLMAP 世界，右手系，原点任意 | nu | `images.bin` 的 `qvec/tvec` |
| local | `local = R·(p − origin)`，R 的行是 `[e1, e2, up]` | nu | `coordinates.build_frame` |
| 显示 | 只有拿到米制标定时才允许换算，否则保持 nu | m / nu | `frame.scale` |

- `up` 由相机自身 up 轴投票得出（`up ≈ −Rᵀ·[0,1,0]`，OpenCV 相机 y 向下），
  不假设 COLMAP 是 Z-up 还是 Y-up。`up_source = "camera_up_vote"`。
- `origin` 取地板平面与两面保留墙的交点，`origin_source = "floor_plane_corner"`。
- 未标定尺度一律 `unit = "nu"`、`meters_per_unit = null`。
  `check_frame()` 会拒绝"`unit=nu` 却声明米制换算"的自相矛盾产物。
- 去畸变口径：`coordinates.check_intrinsics(cams, undistorted)`。
  `undistorted=None` 表示未知，只要存在畸变模型就发 `DISTORTION_NOT_UNDISTORTED`（warn），
  绝不假设已去畸变。

`coordinates.check_frame()` 校验：轴正交、轴归一化、`world_to_local` 矩阵与 origin/轴等价、
尺度口径自洽。任一项不满足返回 `SCALE_INCONSISTENT`，由调用方决定降级还是拒绝。

## 3. Schema 一览

| Schema | 生产者 | 消费者 | 关键字段 |
|---|---|---|---|
| `miniature.input.v1` | 067 `ingest.scan_scene` | 全部 | `images[].sha256`、`coverage`、`colmap`、`scale`、`diagnostics`、`manifest_id` |
| `miniature.structure.v1` | 068 `structure.infer_structure` | 几何/纹理 | `up_world`、`frame`、`origin_world`、`floor`、`faces[]`、`kept_walls`、`extent_nu`、`visibility` |
| `miniature.instances.v1` | 068 `instances.detect_instances` | 几何/纹理 | `frame`、`instances[].id/centroid_nu/aabb_nu/aabb_nerf/centroid_nerf/n_views/partial/confidence/source/label` |
| `miniature.geometry.v1` | 069 `geometry` | 纹理/Worker | 观测面 / 推断支撑分层、`holes[]`、`nonmanifold[]`、`floaters[]` |
| `miniature.texture.v1` | 070 `texture` | Worker/报告 | UV、材质、逐 texel 溯源、观测/推断覆盖率 |
| `miniature.report.v1` | 074 集成 | 看板/网页 | 逐阶段状态、诊断、SHA256、pass/partial/pending |

### 3.0 `instances` 的三套坐标（别混用）

| 字段 | 所在坐标系 | 单位 | 用途 |
|---|---|---|---|
| `aabb_nu` / `centroid_nu` | `frame.local_to_colmap` 的局部系（e1/e2/up） | nu（SfM 归一化，**非米**） | 聚类、稳定性、几何/纹理内部口径 |
| `aabb_nerf` / `centroid_nerf` | nerfstudio 系（与 `scene.ply`、相机中心同一世界） | nerf 归一化 | 投影回原图取色 / 取纹理 |
| `centroid_world` | COLMAP 原始世界坐标（未过 dataparser 变换） | COLMAP 单位 | 仅溯源；**不可与米制房间框比较** |

`aabb_nerf` 是局部 AABB 的 8 个角点全部变换后再取的外接轴对齐盒（局部轴与 nerf 轴不平行，
只变换 min/max 两个角会得到一个漏掉物体的假盒子），因此略大于原盒。
缺 `dataparser_transforms.json` 时不输出这两个字段，并在 `diagnostics` 记
`NO_NERF_TRANSFORM`（warn）—— 不猜变换。`aabb_nu` 的数值与精度不因该参数变化。

### 3.1 `manifest_id` 是内容哈希

```
manifest_id = sha256(canonical_json(去 manifest_id 后的整个 body))
```

`canonical_json` = `sort_keys=True, separators=(",", ":")`。
任何字段变化都会改变 `manifest_id`，所以它可以直接当"输入版本号"用。
`validate_manifest()` 会重算并比对，篡改任意字段都会被判为契约违规。

### 3.2 状态机

`status ∈ {ok, degraded, unsupported}`，由诊断严重度决定：

- 有 `error` → `unsupported`
- 否则有 `warn` → `degraded`
- 否则 `ok`

`status=ok` 却带 `error` 诊断，或 `status=unsupported` 却没有诊断，都算契约违规。

## 4. 诊断码表

| 码 | 默认严重度 | 含义 | 解除条件 |
|---|---|---|---|
| `OK` | info | 无异常 | — |
| `NO_IMAGES` | error | `images/` 下没有可用照片 | 放入 jpg/png/webp |
| `NO_SFM_BASELINE` | error | 缺 `colmap/sparse/0` 或 `sparse/0` | 跑 COLMAP 稀疏重建 |
| `LOW_REGISTRATION` | warn / error | 注册率 < 0.60（warn）或注册相机 < 20（error） | 补拍重叠视角或重跑匹配 |
| `LOW_AZIMUTH_COVERAGE` | info | 站位环绕 < 180°，仅视差不足提示 | 环绕补拍（不阻塞） |
| `LOW_LOOKDIR_COVERAGE` | error | 朝向覆盖 < 180°，看不到两面墙 | 原地转身补拍另一侧 |
| `CORRUPT_IMAGE` | error | 图片无法解码 | 删除或替换损坏文件 |
| `DUPLICATE_SCENE` | warn / error | 与已有场景照片重叠（100% → error） | 换独立场景 |
| `UNMETRIC_SCALE` | info | 无米制基准，尺寸记为 nu | 提供标定物 |
| `DISTORTION_NOT_UNDISTORTED` | warn / error | 有畸变模型但未声明去畸变 | 去畸变或声明 `undistorted=True` |
| `SCALE_INCONSISTENT` | warn / error | 坐标轴/参数个数/尺度口径自相矛盾 | 修产物 |
| `UNSUPPORTED_ROOM` | error | 地板以上点不足或找不到实例 | 换场景或补覆盖 |
| `NO_DEPTH_FOR_BAKE` | error | 稀疏点云为空，无法聚类/烘焙 | 补 SfM 点 |

## 5. 产物目录协议

```
<out>/
  manifests/<key>.json      # miniature.input.v1
  structure/<key>.json      # miniature.structure.v1
  instances/<key>.json      # miniature.instances.v1
  geometry/<key>.json       # miniature.geometry.v1
  texture/<key>.json        # miniature.texture.v1
  inventory.json            # 冻结清单汇总
  report.md                 # 逐场景 pass/fail
```

- 所有 `<key>` 与 `scenes.json` 的 `key` 一一对应。
- 生产树 `data/processed/` 与既有管线脚本只读；实验产物落在 `outputs/` 下的独立目录。
- 大二进制（PLY/GLB）不随卡片提交，只记录 SHA256 与路径。

## 6. 对并行卡的兼容性

- 本契约不修改 `scene-manifest.v1`，也不改 Web 任务协议
  （`data/tasks/<id>/{input,status,worker.log,cancel.flag}`）。
  `miniature.input.v1` 是旁挂清单，只引用既有场景，不替换。
- `objects[].assetId` 仍然只能取自 `packages/shared/src/asset-catalog.ts`；
  重建 GLB 走重建资产通道，不塞进家具白名单。
- 最小 fixture 在 `outputs/2026-11-08/reusable-pipeline-tasks/workspaces/700067/code/fixtures/`，
  每个 fixture 的 `synthetic` 字段必须显式为 `true`，禁止拿 fixture 结果当真实场景成功。
