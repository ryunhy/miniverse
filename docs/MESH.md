# 3DGS → 3D 网格（mesh）导出

把重建得到的 Gaussian Splatting 场景转成带纹理的三角网格（GLB），可直接进编辑器
叠加、导出到其他 DCC 工具，或做碰撞/尺寸计算。

## 为什么不能直接从 3DGS PLY 提网格

Splatfacto 训练出的 3D 高斯是**视角相关的体积表示**，不是表面表示。本机实测
（391,604 个高斯的真实场景）：

| 尝试 | 结果 |
|---|---|
| `ns-export poisson` | `Available outputs: []`，目录为空。根因：`splatfacto.get_outputs` 只接受 `Cameras` 对象，`exporter_utils` 传的是 ray bundle |
| `ns-export tsdf` | `Could not find rgb in the model outputs` |
| 高斯中心 → Open3D 泊松（39 秒） | 出 2.14MB GLB，但 `is_watertight=False`、`volume=-0.23`，渲染是**漂浮薄壳碎片** |
| 检查 PLY 自带法线 | `nx/ny/nz` 全为 0（模长 mean=max=0.0000），不可用 |

结论：3D 高斯的几何必须**换一种表示**才能提网格。

## 正确做法：2DGS + TSDF

2DGS（2D Gaussian Splatting）把每个高斯压扁成**面向法线的薄盘**，几何上贴着表面，
因此可以用多视角深度融合（TSDF）重建出封闭网格。

```
nerfstudio config.yml
  │
  ├─ train_2dgs     2DGS 训练（可从已收敛的 3DGS PLY 热启动）→ ckpt + splat-2dgs.ply
  ├─ render_depth   每台相机渲染 RGB / alpha / 期望深度 / 法向
  ├─ depth_calib    用 COLMAP 稀疏点核对深度尺度（拟合 d_point = a·d_render + b）
  ├─ tsdf_mesh      TSDF 融合 → marching cubes → 支持过滤 → 连通域清理 → 平滑减面
  └─ texture_bake   xatlas UV 展开 → 逐面选最优视角 → 逐像素深度剔除采样 → GLB
```

产物：`mesh.glb`（贴图内嵌）、`mesh.ply`（几何）、`mesh-texture.png`、`mesh-metadata.json`。

## 用法

### 在重建任务里开启（推荐）

任务 `params` 里加 `"exportMesh": true`：

```json
{ "matcher": "exhaustive", "steps": 7000, "exportMesh": true }
```

可调参数（都有默认值）：

| 参数 | 默认 | 说明 |
|---|---|---|
| `exportMesh` | `false` | 是否导出网格（比高斯慢很多，默认关） |
| `meshIters` | `15000` | 2DGS 训练步数 |
| `meshTexSize` | `4096` | 烘焙贴图边长 |
| `meshVoxel` | `0.015` | TSDF 体素边长（场景单位） |
| `meshFaces` | `250000` | 目标面数上限 |

网格是**增强项**：失败时不影响高斯交付，错误写进 `result.mesh.error`。

### 单独跑某一阶段（调试）

```bash
cd services/reconstruction   # WSL，conda activate miniverse

python -m app.mesh.train_2dgs  --config <config.yml> --out <dir> --iters 15000 \
                               --init-ply <已收敛的 scene.ply>
python -m app.mesh.render_depth --config <config.yml> --ckpt <ckpt-15000.pt> --out <views>
python -m app.mesh.depth_calib  --views <views> --sparse <sparse/0> \
                               --transform <dataparser_transforms.json> --out <report.json>
python -m app.mesh.tsdf_mesh    --views <views> --out <mesh.ply>
python -m app.mesh.texture_bake --mesh <mesh.ply> --views <views> --out <mesh.glb>
```

### 环境就绪检查

`python -m app.main check-env` 的报告里含 `mesh` 段：`packages`（open3d/xatlas/trimesh/cv2 版本）、
`gsplat_csrc`（预编译扩展是否注入成功）、`nerfstudio` 版本，以及 `ready`/`missing` 总判定。
末尾会打印一行 `网格导出（exportMesh）：✅ 就绪 / ❌ 不可用 —— <缺什么>`。

### 纯 CPU 自检（不需要 GPU）

```bash
python -m app.mesh.selftest
```

覆盖 PLY 读写往返、GLB 读写往返、深度标定稳健拟合、相机坐标约定，共 19 项。

## 实测结果（104 张真实照片，RTX 4070 8GB）

| 阶段 | 耗时 | 关键数据 |
|---|---|---|
| 2DGS 训练 15000 步（3DGS 热启动） | 907s | 607,470 高斯，末步 PSNR 34.26 |
| 渲染 52 视角深度/法向 | 24s | 779×519 |
| 深度标定 | 0.5s | a=0.99954, b=0.00294，ratio_median=1.0029（≈1，无需校正） |
| TSDF 融合 + 提取 | 1.5s | 原始 75,785 面 → 清理后 52,052 面 |
| 纹理烘焙 4K → GLB | 55s | 45,693 顶点，14.37 MB，贴图填充率 93.1% |
| **合计（复用检查点）** | **81s** | 训练已存在时；首次全跑约 16 分钟 |

网格拓扑（`open3d` 实测）：

| 指标 | 值 | 说明 |
|---|---|---|
| 连通域 | **1** | 漂浮碎片已被 `clean_mesh` 清掉（原始 215 个 → 1 个） |
| 边流形 | **True** | 无严格非流形边 |
| 开放边界边 | 4,581（5.4%） | 对应相机没拍到的区域，属预期 |
| 水密 | False | 同上；室内重建的固有结果，不是缺陷 |
| 非流形顶点 | 21 | 占比 0.07%，来自减面时的局部折叠 |

浏览器端实测（生产构建 + headless Chrome CDP）：`/api/reconstructions/<id>/mesh`
返回 `200`、`content-type: model/gltf-binary`、15,065,232 字节；任务详情页网格查看器
渲染出带纹理的房间，页面无 JS 报错。

## 已知限制

- **零观测区无法重建**：只拍到室内时，外墙/屋顶没有信号，网格会是开放曲面（正常）。
  实测开放边界占 5.4%，纯色平涂对照渲染确认这些区域是几何空洞而非贴图采样问题。
- **米制尺度未标定**：产物在 nerfstudio 归一化系内，没有真实长度参照时不含米制数值。
- **纹理来自训练视角**：未观测到的区域靠洞填充扩散，会出现平滑色块（实测 4,015/54,893
  面没有任何可用视角，占 7.3%）。
- **2DGS 比 Splatfacto 慢**：15000 步在 8GB 显存上约需 15 分钟；这就是默认关闭的原因。

## 踩过的坑（都已在代码里修掉）

- **OpenCV 不接受 nerfstudio 的 6 元畸变**：nerfstudio 顺序是 `[k1,k2,k3,k4,p1,p2]`，
  OpenCV `initUndistortRectifyMap` 只接受 4/5/8/12/14 元，直接传必然断言失败。
  `texture_bake.to_opencv_distortion()` 负责重排（k4=0 时输出 5 元，否则 8 元）。
- **稀疏点目录不能按固定层级找**：`config.yml` 到任务根的层级随导出方式变化，
  `pipeline.find_sparse_dir()` 改为向上逐级搜索 `colmap/sparse/0` / `sparse/0`。
- **检查点复用**：重跑时若 `ckpt-<iters>.pt` 已存在则跳过训练，避免每次白跑 15 分钟。

## 依赖

全部在现有 `miniverse` conda 环境内，**零新增**：

- torch 2.1.2+cu121、gsplat 1.4.0（含 `/root/torch_ext/gsplat_cuda` 预编译扩展）
- nerfstudio 1.1.5（相机与坐标系来源）
- open3d 0.20、trimesh 5.2、xatlas 0.0.11、pytorch_msssim、opencv

`gsplat_bootstrap.py` 负责注入预编译扩展——nerfstudio 装的 gsplat 不会自动定位
`gsplat.csrc`，不注入则 `rasterization_2dgs` 不可用。
