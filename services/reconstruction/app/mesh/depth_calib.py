"""深度标定：确认 2DGS 渲染深度与 COLMAP 稀疏点深度一致，并拟合线性校正。

做法：把 COLMAP 三维点投到每台相机，比较其相机系 z 与渲染深度采样值，
稳健拟合 d_point = a * d_render + b。a≈1,b≈0 时 TSDF 可直接用原始深度。

用法（WSL，conda activate miniverse）：
  python -m app.mesh.depth_calib --views <views_dir> --sparse <sparse/0 目录> \
      --transform <dataparser_transforms.json> --out <report.json>
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from .colmap_io import parse_points3d
from .visibility import GL_FLIP


def sample_bilinear(img: np.ndarray, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    x0 = np.clip(np.floor(xs).astype(np.int64), 0, w - 1)
    y0 = np.clip(np.floor(ys).astype(np.int64), 0, h - 1)
    x1 = np.clip(x0 + 1, 0, w - 1)
    y1 = np.clip(y0 + 1, 0, h - 1)
    fx = xs - x0
    fy = ys - y0
    return (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x1] * fx * (1 - fy)
            + img[y1, x0] * (1 - fx) * fy + img[y1, x1] * fx * fy)


def project(c2w_gl: np.ndarray, K: np.ndarray, pts: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """世界点（nerfstudio 归一化系）→ (u,v), 相机系 z（OpenCV 约定）。"""
    c2w_cv = c2w_gl @ GL_FLIP
    R, t = c2w_cv[:3, :3], c2w_cv[:3, 3]
    pc = (pts - t) @ R
    z = pc[:, 2]
    uvw = pc @ K.T
    z_safe = np.where(np.abs(z) < 1e-12, np.nan, z)
    return np.stack([uvw[:, 0] / z_safe, uvw[:, 1] / z_safe], 1), z


def robust_fit(x: np.ndarray, y: np.ndarray, iters: int = 4) -> dict:
    """拟合 y = a x + b，迭代剔除 3*MAD 之外的离群。"""
    keep = np.ones(len(x), bool)
    a, b = 1.0, 0.0
    for _ in range(iters):
        if keep.sum() < 10:
            break
        A = np.stack([x[keep], np.ones(keep.sum())], 1)
        a, b = np.linalg.lstsq(A, y[keep], rcond=None)[0]
        resid = y - (a * x + b)
        mad = np.median(np.abs(resid[keep] - np.median(resid[keep]))) + 1e-9
        keep = np.abs(resid - np.median(resid)) < 3 * 1.4826 * mad
    resid = y - (a * x + b)
    return {
        "a": float(a), "b": float(b), "inliers": int(keep.sum()), "total": int(len(x)),
        "residual_median": float(np.median(resid[keep])) if keep.any() else None,
        "residual_mad": float(np.median(np.abs(resid[keep] - np.median(resid[keep]))) if keep.any() else None),
        "residual_p95_abs": float(np.percentile(np.abs(resid[keep]), 95)) if keep.any() else None,
    }


def load_transform(path: Path) -> dict:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    return {
        "R": np.asarray(raw["transform"], dtype=np.float64)[:, :3],
        "t": np.asarray(raw["transform"], dtype=np.float64)[:, 3],
        "scale": float(raw["scale"]),
    }


def calibrate(views_dir: Path, sparse_dir: Path, transform_path: Path,
              out: Path | None = None, log=print) -> dict:
    meta = json.loads((Path(views_dir) / "views-meta.json").read_text(encoding="utf-8"))
    dp = load_transform(Path(transform_path))
    p3d = parse_points3d(Path(sparse_dir) / "points3D.bin")
    pts_ns = dp["scale"] * (p3d["xyz"] @ dp["R"].T + dp["t"])

    all_render, all_point, per_view = [], [], []
    for v in meta["views"]:
        stem = Path(v["name"]).stem
        z = np.load(Path(views_dir) / f"view-{stem}.npz")
        depth, alpha = z["depth"], z["alpha"]
        c2w = np.asarray(v["c2w_gl"], dtype=np.float64)
        K = np.asarray(v["K"], dtype=np.float64)
        uv, zc = project(c2w, K, pts_ns)
        h, w = depth.shape
        ok = (np.isfinite(uv[:, 0]) & (uv[:, 0] >= 1) & (uv[:, 0] <= w - 2)
              & (uv[:, 1] >= 1) & (uv[:, 1] <= h - 2) & (zc > 0.05))
        if ok.sum() < 20:
            per_view.append({"name": v["name"], "usable_points": int(ok.sum()), "skipped": True})
            continue
        d_r = sample_bilinear(depth.astype(np.float32), uv[ok, 0], uv[ok, 1])
        a_r = sample_bilinear(alpha.astype(np.float32), uv[ok, 0], uv[ok, 1])
        zc_ok = zc[ok]
        good = (a_r > 127) & (d_r > 1e-6) & (np.abs(d_r - zc_ok) < 0.5 * zc_ok)
        all_render.append(d_r[good])
        all_point.append(zc_ok[good])
        per_view.append({
            "name": v["name"], "split": v["split"], "usable_points": int(ok.sum()),
            "matched_points": int(good.sum()),
            "match_ratio": float(good.sum() / max(1, ok.sum())),
        })

    x = np.concatenate(all_render)
    y = np.concatenate(all_point)
    fit = robust_fit(x, y)
    ratio = y / np.maximum(x, 1e-9)
    report = {
        "views_dir": str(views_dir),
        "num_views": len(meta["views"]),
        "num_samples": int(len(x)),
        "fit_render_to_point": fit,
        "ratio_median": float(np.median(ratio)),
        "ratio_p05": float(np.percentile(ratio, 5)),
        "ratio_p95": float(np.percentile(ratio, 95)),
        "conclusion": ("2DGS 深度与 COLMAP 相机系深度一致（a≈1,b≈0），可直接用于 TSDF"
                       if abs(fit["a"] - 1) < 0.05 and abs(fit["b"]) < 0.05
                       else "存在系统性偏差，TSDF 前必须按 fit 校正"),
        "per_view": per_view,
    }
    if out:
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    log(json.dumps({k: report[k] for k in
                    ("num_samples", "fit_render_to_point", "ratio_median", "conclusion")},
                   ensure_ascii=False, indent=2))
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="2DGS 深度标定")
    ap.add_argument("--views", type=Path, required=True)
    ap.add_argument("--sparse", type=Path, required=True, help="COLMAP sparse/0 目录")
    ap.add_argument("--transform", type=Path, required=True, help="dataparser_transforms.json")
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args(argv)
    calibrate(args.views, args.sparse, args.transform, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
