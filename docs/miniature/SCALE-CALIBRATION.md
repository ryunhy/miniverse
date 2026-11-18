# 最小标定方案：把相对尺度锁成真实米

> 状态：**方案，未实现**。本文只定义做法与字段，不代表代码已落地。
> 背景：当前所有 `m` 都是假的。nerfstudio 的 `scale` 是
> `1 / max|中心化后的相机中心|`（`colmap_dataparser.py:319-323`），
> 只保证"最远相机距离 = 1"，不含任何物理量。详见 `docs/MESH.md:116`。

---

## 第一部分：给拍摄用户看的操作说明

### 带什么

一张 **A4 纸**（210 × 297 mm）。不要用门宽，原因见下方"为什么不用门宽"。

### 怎么放

1. 把 A4 **平铺在地面上**，不要折、不要卷、不要贴在墙上。
2. 位置放在房间中间偏空旷处，周围 30 cm 内不要压到家具腿、地毯边。
3. 如果地面是深色或反光材质，先在 A4 下面垫一张白纸或白卡。
4. 纸的四条边必须完整露出来，不要被椅子、箱子、影子挡住。

### 怎么拍

拍 **2 张**，都用平时拍房间的同一部手机、同一分辨率：

| 张数 | 拍法 | 用途 |
|---|---|---|
| 第 1 张 | 站在纸的斜上方，手机对准纸中心，让纸占画面 1/3 左右，四条边都在画面内 | 自动检出四角 |
| 第 2 张 | 退后，把 A4 和周围两面墙、地面一起拍进去 | 人工兜底时对齐上下文 |

拍完这两张，再按原来的环绕路线拍房间。**这两张也要一起上传**，不要单独裁切或压缩。

### 三条禁忌

- 不要把 A4 拿在手里拍（纸会弯，平面假设失效）。
- 不要隔着玻璃、水面或强反光地面拍（边缘会重影）。
- 不要在纸边压书或杯子（会改变纸的可见轮廓）。

### 拍坏了怎么办

系统会告诉你"标定失败"。失败时**不会瞎猜尺寸**，所有尺寸继续保持相对单位 `nu`，
并明确标注"未标定"。重拍一张即可，不需要重跑整个房间。

### 为什么不用门宽

- 门宽不统一：国内常见 800–900 mm，欧美 762–914 mm，日本 780–800 mm。
- 门框有套线、踢脚线、门缝，肉眼很难说清"哪一条才是标准宽度"。
- A4 是 ISO 216 标准件，误差 ≤ 1 mm，任何人手边都有，且是平面矩形，边缘好检测。

门宽可以作为**次级兜底**（A4 实在没有时），但误差会从约 2% 放大到 5–10%。

---

## 第二部分：给开发看的实现说明

### 一、输入

| 输入 | 来源 | 说明 |
|---|---|---|
| COLMAP 位姿 | `data/processed/<id>/sparse/0/images.bin` | 用现有 `app.mesh.colmap_io.parse_images_bin` |
| 相机内参 | `sparse/0/cameras.bin` | 用 `parse_cameras_bin`，按 `model_id` 展开参数 |
| 点云 | `sparse/0/points3D.bin` | 用 `parse_points3d`，拟合地面 |
| 标定照片 | 用户上传的含 A4 那张 | 必须在 `sparse/0` 里已注册；未注册则拒绝 |

所有中间计算都在 **COLMAP 世界系（nu）** 内完成，最后只输出一个标量
`meters_per_unit`。不要在这个模块里改任何位姿或点云。

### 二、算法步骤

1. **定位 A4 四角（像素）**
   - 首选自动：灰度 → 自适应阈值 → `cv2.findContours` → `approxPolyDP` 取 4 点；
     筛选条件：凸四边形、面积占画面 1%–25%、内角均在 60°–120°。
   - 自动失败则走人工：前端把照片显示出来，让用户点四个角（顺序：左上、右上、右下、左下）。
     人工点选比任何检测都稳，成本只有 4 次点击。

2. **拟合地面平面**
   - 对 `points3D` 做 RANSAC 平面拟合（阈值取点云尺度的 1%，即 `0.01 × 最大跨度`）。
   - 取"法向与相机 up 最接近、且支撑点最多"的平面作为地面。
   - 记平面为 `n·X + d = 0`，`n` 为单位法向。

3. **像素反投影到平面**
   - 像素齐次坐标 `p = [u, v, 1]ᵀ`。
   - 相机系方向：`d_c = K⁻¹ p`。
   - 世界方向：`d_w = R_wcᵀ d_c`（`R_wc` 来自 `images.bin` 的 world→camera 旋转）。
   - 相机中心：`C = -R_wcᵀ t_wc`。
   - 与平面交点：`s = -(n·C + d) / (n·d_w)`，`X = C + s·d_w`。
   - 若 `n·d_w ≈ 0`（射线与地面平行）→ 该角无效，拒绝。

4. **算尺度**
   - 四个 3D 角点按点选顺序组成四边形，取两条短边 `L_s1, L_s2`、
     两条长边 `L_l1, L_l2`、两条对角线 `L_d1, L_d2`。
   - 短边真值 `0.210 m`，长边真值 `0.297 m`，对角线真值 `√(0.210² + 0.297²) = 0.3637 m`。
   - 每条边给出一个候选：`meters_per_unit_i = 真值_i / 测量_i`。
   - 取 6 个候选的**中位数**作为最终值，MAD 作为离散度。

5. **一致性检查（不过就拒绝）**
   - 长宽比：`L_long / L_short` 应 ≈ `1.414`，偏离 > 8% → `aspect_mismatch`。
   - 共面性：四角到地面平面的距离中位数 > 短边长度的 5% → `not_coplanar`。
   - 重投影：把四个 3D 角点投回原图，像素误差中位数 > 5 px → `high_reprojection_error`。
   - 候选离散度：`MAD / median > 10%` → `inconsistent_edges`。

6. **写结果**
   - 成功：`meters_per_unit = median(candidates)`，`confidence` 由重投影误差与 MAD 归一化得到。
   - 失败：`meters_per_unit = null`，写 `reject_reason`，**不回退到任何默认层高**。

### 三、落在哪一步

```
preprocess → COLMAP → [标定入口] → splatfacto/2DGS → miniature ingest
                         ↑
                  独立 CLI，可选执行
```

- 新增模块：`services/reconstruction/app/scale/calibrate.py`（尚未创建）。
- CLI：
  ```bash
  python -m app.scale.calibrate \
    --scene data/processed/<id> \
    --image data/processed/<id>/images/00xx.jpg \
    --out data/processed/<id>/scale-calibration.json
  ```
- **不进入** `worker.py` 主流程，不改任务状态机，不碰 `data/` 以外的任何协议。
- 消费方：`miniature/ingest.py` 在构造 `frame.scale` 时读取该文件；
  文件不存在则保持 `{"unit":"nu","meters_per_unit":null,"source":"unmetric_sfm"}`。
- `coordinates.py::check_frame()` 已能拒绝"`unit=nu` 却声明米制"的矛盾，标定成功后
  必须把 `unit` 一并改成 `"m"`，否则会被它拦下。

### 四、输出字段（写入 `scale-calibration.json`）

```json
{
  "schema": "miniature.scale-calibration.v1",
  "unit": "m",
  "meters_per_unit": 0.0,
  "source": "a4_calibration",
  "reference": { "type": "a4", "short_m": 0.210, "long_m": 0.297 },
  "measured": {
    "short_nu": 0.0,
    "long_nu": 0.0,
    "diag_nu": 0.0,
    "aspect": 0.0,
    "reproj_px_median": 0.0,
    "edge_mad_ratio": 0.0
  },
  "confidence": 0.0,
  "evidence": {
    "image": "images/00xx.jpg",
    "corners_px": [[0, 0], [0, 0], [0, 0], [0, 0]],
    "plane": { "n": [0, 0, 0], "d": 0.0 },
    "method": "auto | manual"
  },
  "reject_reason": null
}
```

`confidence` 建议公式（0–1，仅供排序，不参与换算）：

```
confidence = clamp(1 - max(reproj_px_median / 5, edge_mad_ratio / 0.10), 0, 1)
```

### 五、怎么验证

**现有任务一个都不能直接验**：`data/processed` 下 6 个有 COLMAP 产物的任务，
照片里都没有 A4 或任何已知尺寸参照物。硬拿现有任务验证只能验证"能不能跑通"，
验证不了"准不准"。如实说明，不造假。

验证必须新拍一组：

1. 同一房间，用卷尺量一面墙的净宽，记下真值（例如 2.900 m）。
2. 按第一部分拍 A4 + 环绕房间，20–30 张即可。
3. 走正常重建入口跑完 COLMAP。
4. 跑标定 CLI，得到 `meters_per_unit`。
5. 用该系数把重建里的同一面墙换算成米，与卷尺值比较。

预期误差：

| 条件 | A4 在画面中的长边 | 预期相对误差 |
|---|---|---|
| 良好（占 1/3 画面、正对、无遮挡） | ≈ 400 px | **1–2%** |
| 一般（占 1/6 画面、略斜） | ≈ 200 px | **2–4%** |
| 勉强（占 1/10、强透视） | ≈ 120 px | **4–8%** |

2.9 m 的墙，2% 对应约 6 cm。超过 8% 应直接判失败重拍，不要拿去打印。

### 六、失败与降级

| 情况 | 判定码 | 行为 |
|---|---|---|
| 四角没检出、人工也没点 | `corners_not_found` | 不写 `meters_per_unit`，保留 `nu` |
| 长宽比偏离 > 8% | `aspect_mismatch` | 拒绝，提示"纸可能被折/被挡" |
| 四角不共面 | `not_coplanar` | 拒绝，提示"把纸放平，别拿在手里" |
| 重投影误差 > 5 px | `high_reprojection_error` | 拒绝，提示"换正对角度重拍" |
| 过曝/反光导致边缘断裂 | `low_contrast` | 拒绝，提示"垫白纸或换角度" |
| 标定照片未注册进 COLMAP | `image_not_registered` | 拒绝，提示"这两张要一起上传" |
| 所有检查通过 | `null` | 写 `unit="m"` + `meters_per_unit` |

**硬规则：任何失败都不得用"假设层高 2.7 m""假设门高 2.0 m"之类默认值兜底。**
宁可继续用 `nu`，也不给一个看起来像米、实际靠猜的数。

### 七、已知边界

- 标定只锁**整体尺度**，不修正 SfM 的非均匀形变（长走廊两端可能仍有 1–3% 漂移）。
- 镜头畸变未完全校正时，画面边缘的四角定位会偏；标定照片尽量把 A4 放在画面中心区域。
- 多个子模型（如 f101 的 `sparse/0` 和 `sparse/1`）各自有独立坐标系时，标定只对
  拍 A4 所在的那个子模型有效；跨子模型必须先合并（见 `DELIVERY.md` 的 `model_merger` 处置）。
