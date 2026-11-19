# T-700007 证据：COLMAP 多子模型自动合并后再评估注册率

日期：2026-11-18（UTC+8 约 23:20–23:40）
环境：Windows 10.0.26200；Python 3.12.14（uv 虚拟环境 .venv，numpy 2.5.5 / scipy 1.18.1 / pillow 13.0.0，
清华镜像安装——PyPI 直连卡死后切换，已如实记录）。本机无 pwsh（已披露），命令在 Git Bash 执行。
本机未安装 COLMAP；data/processed 为空、data/tasks/tasks.db 0 条记录——真实 f1014582 数据不在本机。

## 改动（独占范围内）

- `services/reconstruction/app/miniature/sfm_io.py`：新增二进制写入器（cameras/images/points3D）、
  rotmat2qvec、Umeyama 相似变换对齐、`merge_sparse_models`（纯 Python/numpy，不依赖 pycolmap/COLMAP）、
  `registration_ratio`（分母=processed/<id>/images 图片文件数，IMAGE_EXTS 与 ingest 完全同口径）；
  read_images_bin/read_points3d_bin 增加可选参数与附加键，默认行为不变（向后兼容）。
- `services/reconstruction/app/pipeline/colmap.py`：mapper 之后自动合并。成功则原始子模型移入
  sparse/raw/、合并结果放 sparse/0（ingest._find_colmap 口径不变）；失败则如实写诊断码到
  work_dir/merge_report.json 并告警，保留原始子模型，绝不冒充已合并。run_colmap 签名未变。
- 新增 `services/reconstruction/app/miniature/tests/test_sfm_merge.py`（21 个用例）。
- `app/worker.py` 零改动（发布链卡独占）；禁改区零触碰。

## 合并诊断码（可断言，不允许自由文本替代）

MERGE_OK / MERGE_SINGLE_MODEL / MERGE_NO_SHARED_IMAGES / MERGE_INSUFFICIENT_SHARED（共享<3）/
MERGE_DEGENERATE_GEOMETRY（中心共线/重合，含 SVD 不收敛）/ MERGE_ALIGNMENT_FAILED（残差>参考跨度5%）/
MERGE_UNAVAILABLE（numpy 缺失）。

## 复现命令与退出码（仓库根）

```bash
uv venv .venv --python 3.12
uv pip install --python .venv/Scripts/python.exe --index-url https://pypi.tuna.tsinghua.edu.cn/simple numpy scipy pillow
.venv/Scripts/python.exe -m unittest services.reconstruction.app.miniature.tests.test_sfm_merge -v
    # exit 0：Ran 21 tests — OK（new-tests.log）
.venv/Scripts/python.exe -m unittest discover -s services/reconstruction/app/miniature/tests -t services/reconstruction
    # exit 0：Ran 64 tests — OK（43 既有 + 21 新增，regression-miniature.log）
.venv/Scripts/python.exe docs/evidence/sfm-merge/make-evidence.py
    # exit 0：synthetic-split-report.json（evidence-run.log）
```

mesh 侧测试（app/mesh/tests）在本机无法运行：app.mesh.__init__ → pipeline → render_depth 顶层
`import torch`，torch 未安装（nerfstudio 重依赖，与本卡改动无关；mesh 包不导入 sfm_io/colmap，
grep 导入方清单可证）。见 regression-mesh-blocked.log。这是环境限制，不是本次改动引入的回归。

## 验收对照（8 条）

1. 合成两个可合并稀疏模型，合并后注册相机数>任一单模型 — **过**：
   test_merge_increases_registration（6+6 共享 3 → 9>6）；test_multi_model_merged_into_sparse0。
2. 合并结果变化时 manifest_id 随之变化（内容哈希）— **过**：
   TestManifestIdContentHash 两例 + synthetic-split-report.json 的 manifest_id_changed_by_merge=true；
   validate_manifest 均空错误列表。
3. 真实 f1014582：只读 sparse/0 得 60/104，合并后>=102/104，两数字都留证 — **本机无法复测（na）**：
   无 COLMAP、无该任务原始照片与 sparse 产物（多路径搜索确认：data/processed 空、tasks.db 0 条、
   仓库与 D:\anzhuangbao 浅层、其他工作区均无 f1014582）。历史实测数字（2026-11-12）白纸黑字在
   docs/miniature/THRESHOLDS.md:10 与 DATA-PROVENANCE.md:69：60/104=0.5769 与 102/104=0.9808。
   本目录 synthetic-split-report.json 用**合成数据**复现同一分裂比例（104 张照片、模型0=60、
   模型1=45 共享 3 → 并集 102；单模型 0.5769 低于 0.60 warn 线、合并后 0.9808），
   只证明机制与口径，**不是**真实数据验收。真实复测需在装有 COLMAP 且持有 f1014582 数据的机器上执行。
4. 注册率分母用 processed/<id>/images 文件数，不得用 uploads — **过**：
   test_denominator_is_processed_images_not_uploads（9 图片+1 txt+1 目录 → 分母 9；uploads 3 张被忽略）；
   registration_ratio 与 ingest.IMAGE_EXTS 同口径。
5. 无法合并时如实报诊断码，不得静默取 sparse/0 冒充已合并 — **过**：
   TestMergeDiagnostics 5 例 + test_unmergeable_reports_diagnostic_not_fake_merge
   （merge_report.json=MERGE_NO_SHARED_IMAGES，sparse/0 原样 6 张，sparse/1 保留）。
6. worker.py 调用签名未变 — **过**：test_worker_call_signature_unchanged
   （work_dir, image_dir, use_gpu=True, matcher="exhaustive"）；git status 确认 worker.py 零改动。
7. test_sfm_merge.py 新增用例全过，输出实际用例数 — **过**：21 个用例，Ran 21 tests — OK。
8. colmap.py 与 sfm_io.py 改动后 Python 侧测试无回归 — **过（受影响范围）**：
   miniature 全套 64 用例 OK（含既有 43）；mesh 测试因缺 torch 无法运行（环境限制，见上，如实披露）。

## 证据清单

- new-tests.log / regression-miniature.log / regression-mesh-blocked.log / evidence-run.log
- synthetic-split-report.json（合成复现 60/104→102/104 + manifest_id 对照 + 完整合并报告）
- make-evidence.py（证据生成脚本，可复跑）
- code.diff（colmap.py 98 行变更 + sfm_io.py 371 行变更 + 新增测试全文）

## 如实声明的近似与限制

- 合并非重跑 SfM：共享图像保留参考模型位姿；点云取并集不做几何去重（下游 instances 已有退化簇处理）；
  被合并模型在共享图像上的 2D 观测不并入。与 DATA-PROVENANCE.md 的"合并后注册率=图像名并集/磁盘文件数"
  口径一致（注册数按名字去重）。
- 对齐残差上限 5%（相对参考跨度）是保守工程阈值，合成数据残差 ~1e-13；真实数据行为未在本机验证。
- 合成证据不代表真实重建质量；真实 f1014582 复测是遗留项，需具备数据与 COLMAP 的环境。