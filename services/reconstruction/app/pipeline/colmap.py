"""COLMAP 相机位姿恢复（稀疏重建）。

流程：feature_extractor → exhaustive_matcher → mapper → 多子模型自动合并 →（可选 image_undistorter）
优先复用官方二进制，不重新实现算法。输出 sparse/0/{cameras,images,points3D}.bin。

T-700007：mapper 可能把同一场景分裂成多个子模型（sparse/0、sparse/1…），只读 sparse/0
会低估注册率（实测 f1014582：60/104 vs 合并后 102/104，见 docs/miniature/THRESHOLDS.md）。
现在 mapper 之后自动合并（sfm_io.merge_sparse_models，纯 Python）：
- 合并成功：原始子模型移入 sparse/raw/，合并结果放 sparse/0（ingest._find_colmap 口径不变）；
- 无法合并：如实写诊断码到 work_dir/merge_report.json 并告警，保留原始子模型，绝不冒充已合并。
"""
from __future__ import annotations

import json
import logging
import shutil
import subprocess
from pathlib import Path

log = logging.getLogger("colmap")

WORKER_DIR_ARGS = ["--feature_type", "SIFT", "--SiftExtraction.estimate_affine_shape", "1",
                   "--SiftExtraction.domain_size_pooling", "1"]  # 更稳的匹配，代价是更慢


def find_colmap() -> str | None:
    """探测 COLMAP 可执行文件：PATH > conda 常见路径。"""
    exe = shutil.which("colmap") or shutil.which("colmap.bat")
    if exe:
        return exe
    for cand in (
        Path.home() / "miniconda3" / "Library" / "bin" / "colmap.bat",
        Path.home() / "anaconda3" / "Library" / "bin" / "colmap.bat",
        Path("C:/Program Files/COLMAP/bin/colmap.exe"),
    ):
        if cand.exists():
            return str(cand)
    return None


def run_colmap(work_dir: Path, image_dir: Path, use_gpu: bool = True, matcher: str = "exhaustive") -> Path:
    """执行稀疏重建，返回 sparse 目录。失败抛 RuntimeError 并附日志尾部。

    matcher: exhaustive（默认，适合环绕自由拍摄）| sequential（视频抽帧，CPU 下快一个量级）
    """
    colmap = find_colmap()
    if not colmap:
        raise RuntimeError(
            "未找到 COLMAP 可执行文件。请安装：Windows 官方安装包 / WSL2 Ubuntu `sudo apt install colmap`；"
            "详见 docs/INSTALL-Windows-WSL2.md"
        )

    database = work_dir / "database.db"
    sparse_dir = work_dir / "sparse"
    sparse_dir.mkdir(parents=True, exist_ok=True)

    # 产物缓存：位姿已恢复则直接复用（训练参数可反复重试，不必重跑 COLMAP）。
    # 前提：preprocess 已按输入指纹判定输入未变（变更时会清空 sparse/database）。
    cached = sparse_dir / "0"
    if (cached / "images.bin").exists():
        if not (work_dir / "input_fingerprint.json").exists():
            log.warning(
                "复用 COLMAP 产物，但缺少输入指纹（历史任务）：无法证明当前照片与旧位姿一致。"
                "若已更换照片，请先删除该任务的 sparse/database 再重跑。"
            )
        else:
            log.info("COLMAP 产物已存在，跳过重建（输入指纹一致）：%s", cached)
        return cached

    gpu = "1" if use_gpu else "0"
    matcher_cmd = {
        "exhaustive": ["exhaustive_matcher"],
        "sequential": ["sequential_matcher", "--SequentialMatching.overlap", "10",
                       "--SequentialMatching.quadratic_overlap", "1"],
    }.get(matcher)
    if matcher_cmd is None:
        raise RuntimeError(f"未知 matcher 类型: {matcher}")

    stages = [
        ("特征提取", [
            "feature_extractor", "--database_path", str(database), "--image_path", str(image_dir),
            "--ImageReader.single_camera", "1", "--SiftExtraction.use_gpu", gpu,
        ]),
        ("特征匹配", [
            *matcher_cmd, "--database_path", str(database),
            "--SiftMatching.use_gpu", gpu,
        ]),
        ("增量式建图（位姿恢复）", [
            "mapper", "--database_path", str(database), "--image_path", str(image_dir),
            "--output_path", str(sparse_dir),
        ]),
    ]

    for name, args in stages:
        log.info("COLMAP %s …", name)
        result = subprocess.run(
            [colmap, *args], capture_output=True, text=True, cwd=str(work_dir)
        )
        if result.returncode != 0:
            tail = "\n".join((result.stderr or result.stdout or "").splitlines()[-30:])
            raise RuntimeError(f"COLMAP {name} 失败（exit={result.returncode}）：\n{tail}")

    # mapper 输出 sparse/0..N；收集所有含注册图像的子模型，自动合并后再返回
    models = (
        sorted(
            (d for d in sparse_dir.iterdir() if d.is_dir() and (d / "images.bin").exists()),
            key=lambda p: p.name,
        )
        if sparse_dir.exists()
        else []
    )
    if not models:
        raise RuntimeError(
            "COLMAP 未能配准任何相机（sparse/0 为空）。常见原因：照片重叠不足、运动模糊、纯色墙面。"
            "建议环绕拍摄并保证相邻照片 60%+ 重叠。"
        )
    report = _merge_models(sparse_dir, models, work_dir)
    model_dir = sparse_dir / "0" if (sparse_dir / "0" / "images.bin").exists() else models[0]
    log.info("COLMAP 完成：%s（合并状态：%s）", model_dir, report["status"])
    return model_dir


def _merge_models(sparse_dir: Path, models: list, work_dir: Path) -> dict:
    """多子模型自动合并；结果与诊断码写 work_dir/merge_report.json（如实，不冒充）。

    成功：原始子模型移入 sparse/raw/<原名>，合并结果放 sparse/0。
    失败：保留原始子模型不动，报告携带 MergeError 诊断码，注册率按 sparse/0 如实评估。
    """
    report: dict = {
        "schema": "miniverse.colmap-merge.v1",
        "models": [str(m.relative_to(work_dir)) for m in models],
    }
    try:
        from app.miniature import sfm_io  # 延迟导入：find_colmap 等不依赖 numpy
    except ImportError as e:
        report.update(status="MERGE_UNAVAILABLE", message=f"numpy 不可用，无法执行合并：{e}")
        log.warning("COLMAP 子模型合并不可用：%s", e)
        _write_merge_report(work_dir, report)
        return report

    if len(models) == 1:
        report.update(
            status=sfm_io.MERGE_SINGLE_MODEL,
            message="mapper 只产出一个子模型，无需合并",
            registered=len(sfm_io.read_images_bin(models[0] / "images.bin")),
        )
        _write_merge_report(work_dir, report)
        return report

    tmp = sparse_dir / "merged_tmp"
    try:
        if tmp.exists():
            shutil.rmtree(tmp)  # 仅清理本函数自己的临时目录
        merge_rep = sfm_io.merge_sparse_models(models, tmp)
        raw = sparse_dir / "raw"
        raw.mkdir(exist_ok=True)
        for m in models:
            shutil.move(str(m), str(raw / m.name))
        shutil.move(str(tmp), str(sparse_dir / "0"))
        report.update(merge_rep)
        report["raw_models"] = str(raw.relative_to(work_dir))
        log.info(
            "COLMAP 子模型合并成功：%d 个子模型 → 注册 %d 张（各子模型：%s）",
            len(models), merge_rep["registered_merged"],
            [m["registered"] for m in merge_rep["models"]],
        )
    except sfm_io.MergeError as e:
        report.update(status=e.code, message=str(e))
        log.warning(
            "COLMAP 子模型无法合并（%s）：%s。保留原始子模型，注册率按 sparse/0 如实评估，不冒充已合并。",
            e.code, e,
        )
    _write_merge_report(work_dir, report)
    return report


def _write_merge_report(work_dir: Path, report: dict) -> None:
    (work_dir / "merge_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
