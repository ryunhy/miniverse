# 微缩链路 RUNBOOK（T-700072）

面向"拿到一个新任务，怎么装、怎么跑、怎么判定成功/失败、去哪看证据"。
所有数字均来自本机实测，指回 `workspaces/700072/artifacts/` 下的原始文件。

## 1. 环境

| 项 | 实测值 | 来源 |
| --- | --- | --- |
| OS | WSL2 Ubuntu（`Linux-6.18.40.1-microsoft-standard-WSL2-x86_64-with-glibc2.35`） | `artifacts/check_env_072.json` |
| Python | 3.10.22（`/root/miniconda3/envs/miniverse/bin/python`） | 同上 |
| numpy / cv2 / scipy | 1.26.4 / 4.10.0 / 1.15.3 | 同上 |
| shapely / trimesh / xatlas / PIL | 2.0.7 / 5.2.0 / 0.0.11 / 12.3.0 | 同上 |
| COLMAP | 已安装（`colmap=true`） | 同上 |
| torch / CUDA | 2.1.2+cu121，`cuda_available=true`，RTX 4070 Laptop 8 GB | 同上 |
| 微缩预检 | `miniature.ready=true`，`missing=[]` | 同上 |

微缩链路只依赖 CPU 侧库（numpy/cv2/scipy/shapely/trimesh/xatlas/PIL），不依赖 CUDA。
装法：`conda create -n miniverse python=3.10 && pip install numpy opencv-python scipy shapely trimesh xatlas pillow`。
自检入口：

```bash
cd services/reconstruction
python -m app.main check-env          # 退出码 0=可跑真实重建，2=缺主链路依赖
python -m app.miniature.pipeline --preflight   # 只探微缩依赖
```

## 2. 正式入口

微缩**没有独立脚本**，只挂在正式 Worker 上（`services/reconstruction/app/worker.py`）：

```bash
python -m app.main run-task <task_id> --data-dir <data_dir>
```

任务协议（全部是文件，无 HTTP/DB）：

```
data/tasks/<id>/input.json            # 输入（photo_dir + params）
data/tasks/<id>/status.json           # 主任务状态（微缩不改写它）
data/tasks/<id>/miniature-status.json # 微缩状态（miniatureOnly 时写这里）
data/tasks/<id>/cancel.flag           # 取消信号
data/tasks/<id>/worker.log            # 日志
data/processed/<id>/                  # 场景（images + colmap/sparse/0）
data/reconstructions/<id>/miniature/  # 微缩产物（六阶段 json + glb/）
```

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `miniature` | `false` | 挂在主链尾部：主重建成功后顺带产出微缩 |
| `miniatureOnly` | `false` | 只重跑微缩，复用已有 COLMAP 稀疏模型，不碰主 `status.json` |
| `miniatureTexSize` | `512` | 纹理边长；与 070/071 产物一致 |
| `miniatureVoxel` | `0.05` | 体素边长（nu）。实测 0.02 会把家具碎成 4 块，别往下调 |
| `miniatureAlphaFactor` | `2.0` | 前景 alpha 阈值系数 |
| `miniatureResetCache` | `false` | 强制重算四个可缓存阶段 |

## 3. 产物与状态语义

六阶段固定为 `ingest / structure / instances / geometry / texture / export`，
写进 `miniature-status.json` 的 `result.stages`（**map**，不是数组），每项 `{state, detail, evidence}`。

| `status` | 含义 | 退出码 |
| --- | --- | --- |
| `completed` | `result.status ∈ ok/degraded` | 0 |
| `partial` | 内存不足等可恢复降级（如 texture 阶段 OOM） | 1 |
| `failed` | 硬失败；原 3DGS 产物保留不动 | 1 |
| `canceled` | 取消（`cancel.flag`），启动前与中途均覆盖 | 0 |

`unsupported`（如 `NO_FLOOR_PLANE`、`NO_POINTS3D`）在阶段层表达，顶层落 `failed`。

## 4. 缓存

缓存目录：`data/reconstructions/<id>/miniature/cache/`，每阶段一条 JSON。
键 = `sha256(manifest_id + params + code_fingerprint)`：

- `manifest_id`：`miniature.input.v1` 的内容哈希（含场景路径与照片/COLMAP 指纹）
- `params`：上表四个可调参数
- `code_fingerprint`：`app/miniature/*.py` 逐文件 sha 汇总

**已知限制**：缓存是单槽的——换参数会把旧参数的缓存覆盖，切回来必须重算。
需要同时保留两套参数产物时，指定不同的 `--data-dir`（或不同 task）。

## 5. 验收证据索引（T-700072）

| 验收 | 证据文件 | 关键数字 |
| --- | --- | --- |
| ① 新照片自动跑完六阶段 | `artifacts/worker_e2e_072.log` | `run-task` 退出码 0；78 张照片；manifest `d6c28f0280c7`；structure 保留 `e1_min/e2_max`，地板内点率 0.435，可见率 0.998/0.977；19 件家具；19/19 有真实表面、闭合 19；tex 512、observed 0.467 |
| ② 旧 `exportMesh`/GLB/PLY 兼容、只走文件协议 | `git diff services/reconstruction/app/worker.py` + `artifacts/worker_e2e_072.log` | 主链仅新增 `miniature` 分支（导出后追加）；`miniatureOnly` 独立写 `miniature-status.json`，不改 `status.json` |
| ③ 缓存按输入/参数/版本失效 | `artifacts/cache_matrix_c858.json` | 冷启 46.9 s → 续跑 2.7 s（`reused=[structure,instances,geometry,texture]`）；voxel 0.06 键变 `2052b6…`、GLB 3867708→3503184 B；`--reset` 后 `reused=[]`；6/6 断言 true |
| ④ 取消/重试/OOM/GPU 锁真实可测 | `artifacts/resilience_072.json` | 9/9 断言 true：启动前取消 → `canceled`、中途取消 → `canceled`、texture OOM → `partial` 且原 3DGS 保留、结构异常 → `failed` 不伪成功、失败后重试 → `completed`、`gpu.lock` 未被触碰 |
| ⑤ 失败保留原 3DGS、不伪成功 | 同上 `oom_texture` / `structure_failure` 两条 | `original_ply_kept=true`；`file_status` 分别为 `partial` / `failed` |
| ⑥ 环境/入口/说明/日志 | 本文件 + `artifacts/check_env_072.json` + `artifacts/unittest_072.log` | 环境全绿；35 个单测 OK；patch 见 `workspaces/700072/artifacts/patch/072-miniature-worker.patch`（1164 行，4 个文件） |

冷启动 GLB：3867708 B、sha `bc77523a…`（`artifacts/e2e/cache_matrix_c858/`）；
Worker 端到端 GLB：3867708 B、sha `b82c0eac…`（沙箱任务）。**字节数相同、sha 不同**，
因为 GLB 的 JSON chunk 里嵌了场景路径——比对产物时以"同任务同参数"为准，别跨路径比 sha。

## 6. 已知限制（必须如实转述给下游）

- **无米制基准**：COLMAP/SfM 无尺度，产物单位是 `nu`，诊断固定带 `UNMETRIC_SCALE`。不得声明米制尺寸。
- **纹理有推断成分**：c858 场景 `observed_ratio=0.4669`、`inferred_ratio=0.5331`，
  因此 `result.synthetic=true`（有推断像素就必须标，不能让推断冒充实拍）。
- **GPU 锁不适用**：微缩全 CPU，代码中零处引用 `gpu.lock`；`resources/` 下当前也没有该文件
  （只有 `.gitkeep` 与 `archive/`），所以"GPU 锁行为"这一项对本链路只能证明"不发生干扰"，不能证明"正确抢锁"。
- **单槽缓存**：见第 4 节。
