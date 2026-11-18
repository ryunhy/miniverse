# 跨场景复用与保真回归套件（T-700071）

一条命令跑完输入冻结、结构、实例、几何、贴图、GLB 独立重载与负例，输出逐场景
pass/fail 报告。阈值单一出处：`services/reconstruction/app/miniature/contracts.py::THRESHOLDS`。

```bash
python tools/miniature-benchmark/run.py run \
  --scenes outputs/<date>/reusable-pipeline-tasks/workspaces/<card>/code/scenes.json \
  --out    outputs/<date>/reusable-pipeline-tasks/workspaces/<card>/artifacts \
  --tex-size 512
```

退出码：`0` 全部场景 pass 且负例全被判非成功；`2` 存在 fail / degraded / 未跑步骤
（报告里逐条写明，不改判）。

## 子命令

| 子命令 | 作用 | 产物 |
|---|---|---|
| `inventory` | 冻结输入：hash、覆盖度、up 来源、许可 | `manifests/<key>.json`、`inventory.json`、`report.md` |
| `structure` | 地板/墙面/可见性 | `structure/<key>.json` |
| `instances` | 跨视角家具实例 | `instances/<key>.json` |
| `geometry` | alpha-shape 观测面 + 推断桥接面 | `geometry/<key>.json`、`glb/<id>.glb` |
| `texture` | 多视角烘焙 + 接缝电平化 | `texture/<key>.json`、`texture/*.png`、`*-trace.npz`、`glb/scene.glb` |
| `run` | 上述全链路 + GLB 重载 + 逐 texel 回查 + 负例 | `benchmark.json`、`report.md`、`negatives.json` |

## 冻结场景

三个不同实拍房间（"真实"指非合成，不代表做过米制标定），其中两个不参与任何参数选择：

| key | 角色 | 照片 | 注册 | 环绕 | 朝向 | 许可 | manifest_id 前缀 |
|---|---|---|---|---|---|---|---|
| c858acee | 开发集（调参用） | 78 | 76 | 180° | 300° | user_owned_capture | 72aed3defe4c1f2f |
| f1014582 | 复用集（未参与调参） | 104 | 60 | 240° | 240° | user_owned_capture | cfc199080e956de6 |
| llff_room | 复用集（未参与调参） | 311 | 311 | 180° | 270° | unverified_third_party | 35380d3a087439e3 |

- 三组之间照片 MD5 交叉命中 0（同房不同裁剪不会冒充新场景）。
- 完整 hash 见 `artifacts/inventory.json` 的 `manifest_sha256`，每个清单文件本身也有
  sha256，落盘位置 `artifacts/manifests/`。
- `llff_room` 许可为**未核验第三方**（LLFF 数据集），只作复用集的技术验证，
  不得据此对外宣称可商用；这条限制随报告一起交付。

## 被排除的候选（负例）

`scenes.json` 的 `rejected` 段，逐条给出实测值与被判非成功的结论：

| key | 原因 | 处置 |
|---|---|---|
| 70597d42 | 朝向覆盖只有 60°（12 桶占 2 桶），仅一面墙 | 判 unsupported，硬卡点，不补拍不强行重建 |
| 8d01db67 | 无 COLMAP 稀疏基线 | 判 unsupported |
| 34d9d0f6 / 520b63da / 5955bff8 | 与已冻结场景照片 MD5 相同（副本） | 去重后排除，不当作新场景 |

套件每次运行都会重跑这些负例，断言 `status != ok`；任何一条被判成 ok 即整体 fail。

## 三类指标分开评估

1. **观测相似**：逐 texel 回查原照片（`src_view/src_u/src_v` 写进 `*-trace.npz`），
   报源坐标落界比例与色差中位数。这是可回查的溯源，不是训练分数、也不是视觉印象。
2. **结构完整性**：观测顶点最大位移（alpha-shape 顶点取自输入 SfM 点，理论上限 0）、
   闭合实例数、非流形边数。
3. **推断比例**：`observed_ratio` 与 `inferred_ratio` 分列，**不相加冒充保真度**。

## 阈值依据

- 来自 `THRESHOLDS`：注册率、环绕/朝向覆盖、结构面支撑比。数值由真实参考能力与
  like-for-like 基线定出，写在 contracts 里，生成模块改不动。
- 贴图接缝判据 `ratio_cross_over_within < 2.0`：跨面两侧色差不得高于面内自然起伏的
  2 倍。电平化前后各测一次，两次都落盘。
- 采样密度分级：`<=1.0` 不放大；`1.0~2.0` 属插值放大（不新增细节，也不抹掉已有高频，
  只披露）；`>2.0` 判负。

## 未取证 / 限制

- **同机位渲染对照未取证**：本机 WSL 无离屏 OpenGL，未做「原照片 ↔ 导出 GLB」的逐像素
  渲染比对。观测相似由逐 texel 回查给出，口径不同，不能互相替代。
- f1014582 注册率按 `sparse/0` 单模型口径是 60/104 = 0.5769（`LOW_REGISTRATION`），
  合并两个子模型后是 102/104 = 0.9808（见 `DELIVERY.md` 的 `model_merger` 处置）；
  结构仍可产出但属 degraded，报告如实标注。
- 推断区域（闭合面背面等无照片证据处）由实例观测中位色填平，已单独计数。
