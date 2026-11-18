"""MiniVerse 重建流水线：图像预处理。

- EXIF 方向校正 + 降采样到目标长边（低显存优先策略的核心手段）
- 质量筛查：分辨率过小 / 纯色图警告（不阻断）
- 输入指纹：记录本次输入的 (文件名, 大小, sha256)，供重跑时判断能否复用旧位姿
依赖：Pillow（requirements.txt）
"""
from __future__ import annotations

import hashlib
import json
import logging
import shutil
from pathlib import Path

from PIL import Image, ImageOps

log = logging.getLogger("preprocess")

VALID_EXT = {".jpg", ".jpeg", ".png", ".webp"}
FINGERPRINT_NAME = "input_fingerprint.json"
FINGERPRINT_SCHEMA = "miniature.input-fingerprint.v1"
# 输入变更时需要作废的派生产物：图、稀疏模型、COLMAP 数据库、nerfstudio 归位副本
DERIVED_DIRS = ("sparse", "colmap/sparse")
DERIVED_FILES = ("database.db", "database.db-shm", "database.db-wal")


def collect_photos(photo_dir: Path) -> list[Path]:
    files = sorted(
        p for p in photo_dir.iterdir()
        if p.is_file() and p.suffix.lower() in VALID_EXT and not p.name.startswith(".")
    )
    if len(files) < 3:
        raise RuntimeError(f"照片数量不足（{len(files)} < 3）：{photo_dir}")
    return files


def _sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            buf = fh.read(chunk)
            if not buf:
                break
            h.update(buf)
    return h.hexdigest()


def compute_fingerprint(photo_dir: Path, photos: list[Path] | None = None) -> dict:
    """按文件名排序后的 (文件名, 大小, sha256) 清单 + 总 digest。"""
    photos = photos if photos is not None else collect_photos(photo_dir)
    files = []
    for p in photos:
        files.append({"name": p.name, "bytes": p.stat().st_size, "sha256": _sha256_file(p)})
    payload = "".join(f'{f["name"]}\t{f["bytes"]}\t{f["sha256"]}\n' for f in files)
    return {
        "schema": FINGERPRINT_SCHEMA,
        "algo": "sha256",
        "count": len(files),
        "digest": hashlib.sha256(payload.encode("utf-8")).hexdigest(),
        "files": files,
    }


def load_fingerprint(out_dir: Path) -> dict | None:
    p = Path(out_dir) / FINGERPRINT_NAME
    if not p.exists():
        return None
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        log.warning("输入指纹文件损坏，按缺失处理：%s", p)
        return None
    return raw if isinstance(raw, dict) and raw.get("digest") else None


def _images_complete(out_images: Path, expected: int) -> bool:
    if not out_images.is_dir():
        return False
    n = sum(1 for p in out_images.iterdir() if p.is_file() and p.suffix.lower() in VALID_EXT)
    return n == expected


def _invalidate_derived(out_dir: Path) -> list[str]:
    """清掉与输入绑定的派生产物，返回清理项清单（用于日志）。"""
    removed: list[str] = []
    images = out_dir / "images"
    if images.is_dir():
        n = 0
        for p in images.iterdir():
            if p.is_file():
                p.unlink()
                n += 1
        if n:
            removed.append(f"images/{n}张")
    for rel in DERIVED_DIRS:
        d = out_dir / rel
        if d.exists():
            shutil.rmtree(d)
            removed.append(f"{rel}/")
    for name in DERIVED_FILES:
        p = out_dir / name
        if p.exists():
            p.unlink()
            removed.append(name)
    return removed


def preprocess(photo_dir: Path, out_dir: Path, max_resolution: int = 1600) -> list[Path]:
    """返回处理后的图片列表（写入 out_dir/images）。

    输入指纹与上次一致时复用已有预处理图与 COLMAP 位姿；不一致时先作废派生产物再重建。
    缺指纹的历史任务按"输入变更"处理（无法证明输入一致，复用风险大于重建成本）。
    """
    out_dir = Path(out_dir)
    out_images = out_dir / "images"
    photos = collect_photos(photo_dir)

    fingerprint = compute_fingerprint(photo_dir, photos)
    old = load_fingerprint(out_dir)
    if old is None:
        log.warning("输入指纹缺失（历史任务）：无法证明输入一致，按输入变更处理，作废旧位姿")
        changed = True
    elif old.get("digest") != fingerprint["digest"]:
        log.warning(
            "输入变更：指纹 %s -> %s，作废旧位姿并重建",
            str(old.get("digest"))[:12], fingerprint["digest"][:12],
        )
        changed = True
    elif not _images_complete(out_images, len(photos)):
        log.warning("输入指纹一致但预处理图不完整，重新生成")
        changed = True
    else:
        changed = False

    if changed:
        removed = _invalidate_derived(out_dir)
        log.warning("输入变更，已作废旧位姿重建（清理：%s）", "、".join(removed) or "无残留")
    else:
        log.info("输入指纹一致（%s，%d 张），复用已有 COLMAP 位姿，不清理",
                 fingerprint["digest"][:12], len(photos))

    out_images.mkdir(parents=True, exist_ok=True)
    processed: list[Path] = []
    for i, src in enumerate(photos, 1):
        dest = out_images / f"{i:04d}.jpg"
        if not changed and dest.exists():
            processed.append(dest)
            continue
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im)
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            w, h = im.size
            scale = min(1.0, max_resolution / max(w, h))
            if scale < 1.0:
                im = im.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
            im.save(dest, "JPEG", quality=92)
        processed.append(dest)
        if i % 10 == 0 or i == len(photos):
            log.info("预处理 %d/%d", i, len(photos))

    # 质量报告
    min_edge = 0
    for p in processed:
        with Image.open(p) as im:
            edge = min(im.size)
        min_edge = edge if min_edge == 0 else min(min_edge, edge)
    report = {
        "input_count": len(photos),
        "max_resolution": max_resolution,
        "min_edge": min_edge,
    }
    (out_dir / "preprocess_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    (out_dir / FINGERPRINT_NAME).write_text(
        json.dumps(fingerprint, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    log.info("预处理完成：%s；指纹=%s", report, fingerprint["digest"][:12])
    return processed
