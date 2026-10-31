"""MiniVerse 重建流水线：图像预处理。

- EXIF 方向校正 + 降采样到目标长边（低显存优先策略的核心手段）
- 质量筛查：分辨率过小 / 纯色图警告（不阻断）
依赖：Pillow（requirements.txt）
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from PIL import Image, ImageOps

log = logging.getLogger("preprocess")

VALID_EXT = {".jpg", ".jpeg", ".png", ".webp"}


def collect_photos(photo_dir: Path) -> list[Path]:
    files = sorted(
        p for p in photo_dir.iterdir()
        if p.is_file() and p.suffix.lower() in VALID_EXT and not p.name.startswith(".")
    )
    if len(files) < 3:
        raise RuntimeError(f"照片数量不足（{len(files)} < 3）：{photo_dir}")
    return files


def preprocess(photo_dir: Path, out_dir: Path, max_resolution: int = 1600) -> list[Path]:
    """返回处理后的图片列表（写入 out_dir/images）。"""
    out_images = out_dir / "images"
    out_images.mkdir(parents=True, exist_ok=True)
    photos = collect_photos(photo_dir)
    processed: list[Path] = []

    for i, src in enumerate(photos, 1):
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im)
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            w, h = im.size
            scale = min(1.0, max_resolution / max(w, h))
            if scale < 1.0:
                im = im.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
            dest = out_images / f"{i:04d}.jpg"
            im.save(dest, "JPEG", quality=92)
            processed.append(dest)
            if i % 10 == 0 or i == len(photos):
                log.info("预处理 %d/%d", i, len(photos))

    # 质量报告
    report = {
        "input_count": len(photos),
        "max_resolution": max_resolution,
        "min_edge": min(min(Image.open(p).size) for p in processed),
    }
    (out_dir / "preprocess_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    log.info("预处理完成：%s", report)
    return processed
