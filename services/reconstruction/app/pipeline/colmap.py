"""COLMAP 相机位姿恢复（稀疏重建）。

流程：feature_extractor → exhaustive_matcher → mapper →（可选 image_undistorter）
优先复用官方二进制，不重新实现算法。输出 sparse/0/{cameras,images,points3D}.bin。
"""
from __future__ import annotations

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

    # 产物缓存：位姿已恢复则直接复用（训练参数可反复重试，不必重跑 COLMAP）
    cached = sparse_dir / "0"
    if (cached / "images.bin").exists():
        log.info("COLMAP 产物已存在，跳过重建：%s", cached)
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

    # mapper 输出 sparse/0；校验
    model_dir = sparse_dir / "0"
    if not (model_dir / "images.bin").exists():
        # mapper 可能给出多个模型，取 0；若无则说明配准失败（常见：照片重叠不足）
        models = [d for d in sparse_dir.iterdir() if d.is_dir()] if sparse_dir.exists() else []
        if not models:
            raise RuntimeError(
                "COLMAP 未能配准任何相机（sparse/0 为空）。常见原因：照片重叠不足、运动模糊、纯色墙面。"
                "建议环绕拍摄并保证相邻照片 60%+ 重叠。"
            )
        model_dir = models[0]
    log.info("COLMAP 完成：%s", model_dir)
    return model_dir
