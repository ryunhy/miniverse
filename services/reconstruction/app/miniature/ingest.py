"""场景输入清点：把任意照片目录 / 已处理场景目录归一成版本化 InputManifest。

约定
- 只读源目录，不写 data/ 下任何文件。
- 所有阈值来自 contracts.THRESHOLDS（单一出处）。
- 不支持就返回 unsupported + 诊断码，不猜、不补、不降级成假成功。
- 世界"上"方向由相机自身 up 轴投票得出，不假设 COLMAP 的 Z-up/Y-up 约定。
"""
from __future__ import annotations

import math
import struct
from pathlib import Path

import numpy as np

from . import contracts as C
from .sfm_io import ColmapError, read_cameras_bin, read_images_bin, qvec2rotmat

try:  # 图像解码探测是可选能力：cv2 缺失时如实标注，不假装检查过
    import cv2  # type: ignore
except Exception:  # noqa: BLE001
    cv2 = None

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def _probe_image(path: Path):
    """返回 (width, height) / False（损坏）/ None（无法探测）。

    None 与 False 必须分开：前者是"没能力检查"，后者是"检查了且坏了"。
    混为一谈会让缺 cv2 的环境把全部图片误报成损坏。
    """
    if cv2 is None:
        return None
    try:
        img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    except Exception:  # noqa: BLE001 - 解码器抛什么都算解析失败
        return False
    if img is None:
        return False
    h, w = img.shape[:2]
    return int(w), int(h)


def _find_colmap(scene: Path) -> Path | None:
    for rel in ("colmap/sparse/0", "sparse/0"):
        p = scene / rel
        if (p / "images.bin").exists() and (p / "cameras.bin").exists():
            return p
    return None


def world_up_from_cameras(cameras: list) -> np.ndarray:
    """OpenCV 相机 y 轴向下，故世界 up ≈ -R^T·[0,1,0]。多视角投票后归一化。"""
    acc = np.zeros(3)
    for c in cameras:
        R = qvec2rotmat(np.asarray(c["qvec"], dtype=np.float64))
        acc += -(R.T @ np.array([0.0, 1.0, 0.0]))
    n = np.linalg.norm(acc)
    return acc / n if n > 1e-9 else np.array([0.0, 0.0, 1.0])


def _basis(up: np.ndarray):
    up = up / np.linalg.norm(up)
    ref = np.array([1.0, 0.0, 0.0]) if abs(up[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    e1 = np.cross(up, ref)
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(up, e1)
    return up, e1, e2


def _coverage(cameras: list, bins: int = 12) -> C.Coverage:
    if not cameras:
        return C.Coverage()
    up = world_up_from_cameras(cameras)
    _, e1, e2 = _basis(up)
    P = np.asarray([c["center"] for c in cameras], dtype=np.float64)
    F = np.asarray([c["forward"] for c in cameras], dtype=np.float64)
    cen = P.mean(axis=0)
    Pc = P - cen
    az = np.arctan2(Pc @ e2, Pc @ e1)
    az_bins = np.zeros(bins, dtype=int)
    for a in az:
        az_bins[int((a + math.pi) / (2 * math.pi) * bins) % bins] += 1
    Fp = F - np.outer(F @ up, up)
    ld = np.arctan2(Fp @ e2, Fp @ e1)
    ld_bins = np.zeros(bins, dtype=int)
    for a in ld:
        ld_bins[int((a + math.pi) / (2 * math.pi) * bins) % bins] += 1
    # 竖直跨度用 up 投影
    h = P @ up
    span_plane = [
        float(np.ptp(Pc @ e1)),
        float(np.ptp(Pc @ e2)),
        float(np.ptp(h)),
    ]
    return C.Coverage(
        n_registered=len(cameras),
        azimuth_bins=az_bins.tolist(),
        lookdir_bins=ld_bins.tolist(),
        azimuth_coverage_deg=round(int((az_bins > 0).sum()) / bins * 360, 1),
        lookdir_coverage_deg=round(int((ld_bins > 0).sum()) / bins * 360, 1),
        position_span=[round(v, 6) for v in span_plane],
        up_world=[round(float(v), 6) for v in up],
        up_source="camera_up_vote",
    )


def scan_scene(
    scene: Path,
    scene_key: str,
    known_hashes: dict | None = None,
    hash_images: bool = True,
    max_hash_images: int = 400,
    probe_images: bool = True,
    max_probe_images: int = 400,
) -> C.InputManifest:
    """known_hashes: {sha256: scene_key}，用于识别同源重复副本。"""
    scene = Path(scene)
    diags: list = []
    images = []
    img_dir = scene / "images"
    img_paths = []
    if img_dir.is_dir():
        img_paths = sorted(
            p for p in img_dir.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS
        )
    if not img_paths:
        diags.append(
            C.Diagnostic(C.D_NO_IMAGES, "error", "images/ 下没有可用照片", measured={"count": 0})
        )

    do_hash = hash_images and len(img_paths) <= max_hash_images
    do_probe = probe_images and len(img_paths) <= max_probe_images
    sizes = []
    corrupt: list = []
    probed = 0
    for p in img_paths:
        rec = C.ImageRecord(
            name=p.name,
            rel_path=str(p.relative_to(scene)).replace("\\", "/"),
            bytes=p.stat().st_size,
        )
        if do_hash:
            rec.sha256 = C.sha256_file(p)
        if do_probe:
            probe = _probe_image(p)
            if probe is False:
                corrupt.append(rec.rel_path)
            elif probe is not None:
                rec.width, rec.height = probe
                probed += 1
        images.append(rec)
        sizes.append(rec.bytes)

    if corrupt:
        diags.append(
            C.Diagnostic(
                C.D_CORRUPT_IMAGE,
                "error",
                f"{len(corrupt)} 张图片无法解码，不能当作有效输入",
                measured={"n_corrupt": len(corrupt), "files": corrupt[:10]},
            )
        )
    image_probe = "unavailable"
    if do_probe:
        image_probe = "cv2_decode" if probed else "all_failed"
    elif probe_images:
        image_probe = f"skipped_over_{max_probe_images}"

    colmap_dir = _find_colmap(scene)
    coverage = C.Coverage()
    colmap_info: dict = {"found": bool(colmap_dir), "image_probe": image_probe}
    cameras: list = []
    if colmap_dir is None:
        diags.append(
            C.Diagnostic(
                C.D_NO_SFM_BASELINE,
                "error",
                "缺少 COLMAP 稀疏重建（colmap/sparse/0 或 sparse/0）",
                measured={"searched": ["colmap/sparse/0", "sparse/0"]},
            )
        )
    else:
        try:
            cams_intr = read_cameras_bin(colmap_dir / "cameras.bin")
            cameras = read_images_bin(colmap_dir / "images.bin")
            coverage = _coverage(cameras)
            colmap_info.update(
                {
                    "sparse_dir": str(colmap_dir.relative_to(scene)).replace("\\", "/"),
                    "n_registered": len(cameras),
                    "n_cameras": len(cams_intr),
                    "camera_models": sorted({c["model_id"] for c in cams_intr.values()}),
                    "points3d_bin": (colmap_dir / "points3D.bin").exists(),
                }
            )
            n_disk = len(img_paths)
            ratio = len(cameras) / n_disk if n_disk else 0.0
            colmap_info["registered_ratio"] = round(ratio, 4)
            if n_disk and ratio < C.THRESHOLDS["min_registered_ratio"]:
                diags.append(
                    C.Diagnostic(
                        C.D_LOW_REGISTRATION,
                        "warn",
                        "注册率偏低，可能存在重复拍摄或大量未重叠视角",
                        measured={
                            "ratio": round(ratio, 4),
                            "registered": len(cameras),
                            "on_disk": n_disk,
                        },
                        threshold={"min_registered_ratio": C.THRESHOLDS["min_registered_ratio"]},
                    )
                )
            if len(cameras) < C.THRESHOLDS["min_images"]:
                diags.append(
                    C.Diagnostic(
                        C.D_LOW_REGISTRATION,
                        "error",
                        "注册相机数不足，无法支撑重建",
                        measured={"n_registered": len(cameras)},
                        threshold={"min_images": C.THRESHOLDS["min_images"]},
                    )
                )
            az_bins = int((np.asarray(coverage.azimuth_bins) > 0).sum()) if coverage.azimuth_bins else 0
            ld_bins = int((np.asarray(coverage.lookdir_bins) > 0).sum()) if coverage.lookdir_bins else 0
            if az_bins < C.THRESHOLDS["report_azimuth_bins"]:
                diags.append(
                    C.Diagnostic(
                        C.D_LOW_AZIMUTH_COVERAGE,
                        "info",
                        "相机站位环绕偏窄，视差不足（不影响'能否看到两面墙'判定）",
                        measured={"bins": az_bins, "deg": coverage.azimuth_coverage_deg},
                        threshold={"report_bins": C.THRESHOLDS["report_azimuth_bins"]},
                    )
                )
            if ld_bins < C.THRESHOLDS["min_lookdir_bins"]:
                diags.append(
                    C.Diagnostic(
                        C.D_LOW_LOOKDIR_COVERAGE,
                        "error",
                        "相机朝向覆盖不足，无法观测到足够墙面",
                        measured={"bins": ld_bins, "deg": coverage.lookdir_coverage_deg},
                        threshold={"min_bins": C.THRESHOLDS["min_lookdir_bins"]},
                    )
                )
        except (ColmapError, struct.error) as e:
            diags.append(
                C.Diagnostic(C.D_NO_SFM_BASELINE, "error", f"COLMAP 解析失败: {e}", measured={})
            )

    if known_hashes:
        hit: dict = {}
        hashed = [r for r in images if r.sha256]
        for rec in hashed:
            if rec.sha256 in known_hashes:
                k = known_hashes[rec.sha256]
                hit[k] = hit.get(k, 0) + 1
        total = len(hashed)
        for other, cnt in hit.items():
            overlap = cnt / total if total else 0.0
            diags.append(
                C.Diagnostic(
                    C.D_DUPLICATE_SCENE,
                    "warn" if overlap < 0.999 else "error",
                    f"与场景 {other} 存在重复照片，不能当作独立样本",
                    measured={"overlap_ratio": round(overlap, 4), "duplicated": cnt, "total": total},
                    threshold={"full_duplicate": 0.999},
                )
            )

    diags.append(
        C.Diagnostic(
            C.D_UNMETRIC_SCALE,
            "info",
            "COLMAP/SfM 无米制基准，尺寸以 nu（归一化单位）记录；未做度量标定不得声明米制尺寸",
            measured={"scale_source": "unmetric_sfm", "scale": 1.0},
        )
    )

    manifest = C.InputManifest(
        scene_key=scene_key,
        scene_path=str(scene),
        scene_id=scene.name if len(scene.name) >= 8 else None,
        images=images,
        coverage=coverage,
        colmap=colmap_info,
        scale={"unit": "nu", "meters_per_unit": None, "source": "unmetric_sfm"},
        diagnostics=diags,
    )
    manifest.status = C.decide_status(diags)
    return manifest.finalize()
