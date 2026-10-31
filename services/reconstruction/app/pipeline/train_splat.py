"""Nerfstudio Splatfacto 训练（3D Gaussian Splatting）。

- 复用官方 ns-train / ns-export CLI，不重新实现训练算法
- 按显存选择保守参数（分辨率在 preprocess 阶段已控制）
- OOM 检测：捕获 CUDA OutOfMemory → 由 worker 以更低分辨率重试（最多 2 次）
"""
from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
from pathlib import Path

log = logging.getLogger("train_splat")

OOM_PATTERNS = re.compile(
    r"(CUDA out of memory|OutOfMemoryError|CUDA error: out of memory|torch\.cuda\.OutOfMemoryError)",
    re.IGNORECASE,
)


def find_nerfstudio() -> bool:
    return bool(shutil.which("ns-train"))


def query_vram_gb() -> float | None:
    """通过 nvidia-smi 查询显存（GB）；失败返回 None。"""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10,
        )
        if out.returncode == 0:
            return float(out.stdout.strip().splitlines()[0]) / 1024
    except Exception:  # noqa: BLE001 - 探测失败按无显存处理
        pass
    return None


def recommend_steps(vram_gb: float | None, override: int | None = None) -> int:
    """按显存推荐训练步数（保守值；Splatfacto 默认 30000）。"""
    if override:
        return int(override)
    if vram_gb is None:
        return 7000
    if vram_gb < 8:
        return 7000
    if vram_gb < 12:
        return 10000
    return 15000


class OutOfMemoryError_(RuntimeError):
    """训练阶段显存不足（可降级重试）"""


def train_splatfacto(
    work_dir: Path,
    data_dir: Path,
    steps: int = 7000,
    timeout_sec: int = 60 * 90,
) -> Path:
    """运行 ns-train splatfacto，返回 nerfstudio 输出目录（含 config.yml）。"""
    if not find_nerfstudio():
        raise RuntimeError(
            "未找到 ns-train。请安装 Nerfstudio（官方安装文档 https://docs.nerf.studio），"
            "或按 docs/INSTALL-Windows-WSL2.md 在 WSL2 Ubuntu 内配置。"
        )

    output_dir = work_dir / "nerfstudio"
    output_dir.mkdir(parents=True, exist_ok=True)

    # CLI 结构（nerfstudio 1.x）：ns-train <config> <trainer_args> <dataparser> <parser_args>
    # - --output-dir/--timestamp/--vis/--max-num-iterations 属 trainer_args（subcommand 之前）
    # - COLMAP 原生产物（images/ + sparse/0）用 colmap dataparser 直接读取
    cmd = [
        "ns-train", "splatfacto",
        "--max-num-iterations", str(steps),
        "--vis", "tensorboard",
        "--output-dir", str(output_dir),
        "--timestamp", "run",
        "colmap",
        "--data", str(data_dir),
    ]
    log.info("启动训练：%s", " ".join(cmd))
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_sec, cwd=str(work_dir))
    except subprocess.TimeoutExpired as e:
        tail = "\n".join(((e.stdout or "") if isinstance(e.stdout, str) else "").splitlines()[-20:])
        raise RuntimeError(f"训练超时（{timeout_sec}s）\n{tail}") from e

    combined = (proc.stdout or "") + (proc.stderr or "")
    if OOM_PATTERNS.search(combined):
        tail = "\n".join(combined.splitlines()[-25:])
        raise OutOfMemoryError_(f"训练显存不足（OOM）\n{tail}")
    if proc.returncode != 0:
        tail = "\n".join(combined.splitlines()[-40:])
        raise RuntimeError(f"ns-train 失败（exit={proc.returncode}）\n{tail}")

    config = _find_config(output_dir)
    log.info("训练完成：%s", config)
    return config.parent


def _find_config(output_dir: Path) -> Path:
    for cfg in sorted(output_dir.rglob("config.yml")):
        return cfg
    raise RuntimeError(f"未找到训练产物 config.yml（{output_dir}）")


def export_gaussian_splat(work_dir: Path, run_dir: Path, export_dir: Path) -> Path:
    """ns-export gaussian-splat → 导出 3DGS PLY。返回 scene.ply 路径。"""
    ns_export = shutil.which("ns-export")
    if not ns_export:
        raise RuntimeError("未找到 ns-export（Nerfstudio 未正确安装）")
    config = _find_config(run_dir.parent if run_dir.name != "nerfstudio" else run_dir)
    export_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ns-export", "gaussian-splat",
        "--load-config", str(config),
        "--output-dir", str(export_dir),
    ]
    log.info("导出高斯：%s", " ".join(cmd))
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(work_dir))
    if proc.returncode != 0:
        tail = "\n".join(((proc.stderr or "") + (proc.stdout or "")).splitlines()[-30:])
        raise RuntimeError(f"ns-export 失败（exit={proc.returncode}）\n{tail}")

    ply = export_dir / "scene.ply"
    if ply.exists():
        # 重导出：旧 scene.ply 会掩盖本次产物（nerfstudio 1.x 默认输出 splat.ply），先移除
        ply.unlink()
    # nerfstudio 默认输出 splat.ply（非 scene.ply），统一换名
    cands = [p for p in export_dir.glob("*.ply") if p.name != "scene.ply"]
    if cands:
        newest = max(cands, key=lambda p: p.stat().st_mtime)
        newest.rename(ply)
    if not ply.exists():
        raise RuntimeError(f"导出目录无 PLY 产物：{export_dir}")

    meta = {
        "ply": "scene.ply",
        "bytes": ply.stat().st_size,
        "format": "gaussian-splat-ply",
    }
    (export_dir / "metadata.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    log.info("导出完成：scene.ply（%.1f MB）", ply.stat().st_size / 1048576)
    return ply
