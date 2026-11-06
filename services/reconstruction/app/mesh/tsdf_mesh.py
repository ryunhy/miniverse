"""TSDF 融合 → 三角网格。

流程：场景包围盒估计 → open3d UniformTSDFVolume（Scalable 版本实测空输出，弃用）
      → marching cubes → 顶点观测支持过滤 → 连通域清理 → 平滑 → 减面。

注意 depth_fit：2DGS 渲染的期望深度通常已是场景单位（a≈1, b≈0），但不同数据集
存在小幅系统性偏差，因此由 depth_calib 用 COLMAP 稀疏点实测拟合，默认恒等。
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
import open3d as o3d

from .visibility import GL_FLIP, ViewStore, compute_support


def scene_bbox(store: ViewStore, sample_step: int = 8, max_views: int = 40) -> tuple[np.ndarray, np.ndarray]:
    pts = []
    for i in range(min(max_views, len(store))):
        w, h = store.size(i)
        d = store.depth(i)
        us, vs = np.meshgrid(np.arange(0, w, sample_step), np.arange(0, h, sample_step))
        u = us.ravel().astype(np.float64)
        v = vs.ravel().astype(np.float64)
        z = d[vs.ravel(), us.ravel()].astype(np.float64)
        ok = z > 1e-3
        if not ok.any():
            continue
        K = store.K(i)
        x = (u[ok] - K[0, 2]) / K[0, 0] * z[ok]
        y = (v[ok] - K[1, 2]) / K[1, 1] * z[ok]
        cam = store.c2w(i) @ GL_FLIP
        pw = np.stack([x, y, z[ok]], 1) @ cam[:3, :3].T + cam[:3, 3]
        pts.append(pw)
    allp = np.concatenate(pts)
    lo = np.percentile(allp, 0.5, axis=0)
    hi = np.percentile(allp, 99.5, axis=0)
    return lo, hi


def clean_mesh(mesh: o3d.geometry.TriangleMesh, support: np.ndarray, min_support: int,
               target_faces: int) -> tuple[o3d.geometry.TriangleMesh, dict]:
    stats: dict = {}
    mesh.remove_duplicated_vertices()
    mesh.remove_duplicated_triangles()
    mesh.remove_degenerate_triangles()
    if len(mesh.triangles) == 0:
        return mesh, {"error": "空网格"}

    # 顶点观测支持过滤：三顶点支持度均不足的面删除（去外推壳/噪声）
    tri = np.asarray(mesh.triangles)
    v_support = support[: len(mesh.vertices)]
    tri_support = v_support[tri].min(1)
    drop = np.where(tri_support < min_support)[0]
    stats["dropped_low_support_faces"] = int(len(drop))
    if len(drop):
        mesh.remove_triangles_by_index(drop)
        mesh.remove_unreferenced_vertices()

    if len(mesh.triangles) == 0:
        return mesh, {**stats, "error": "support 过滤后为空"}

    labels = mesh.cluster_connected_triangles()
    tri_cluster = np.asarray(labels[0])
    counts = np.asarray(labels[1])
    stats["components"] = int(counts.shape[0])
    if counts.shape[0] > 1:
        keep = np.where(counts >= max(counts.max() * 0.01, 500))[0]
        stats["kept_components"] = int(keep.shape[0])
        drop_c = np.where(~np.isin(tri_cluster, keep))[0]
        stats["dropped_component_faces"] = int(len(drop_c))
        mesh.remove_triangles_by_index(drop_c)
        mesh.remove_unreferenced_vertices()

    mesh.compute_vertex_normals()
    mesh = mesh.filter_smooth_taubin(number_of_iterations=8)
    mesh.compute_vertex_normals()
    if target_faces and len(mesh.triangles) > target_faces:
        mesh = mesh.simplify_quadric_decimation(target_faces)
        mesh.compute_vertex_normals()
    return mesh, stats


def build_tsdf(views_dir: Path, out: Path, voxel: float = 0.015, sdf_trunc_mult: float = 4.0,
               min_support: int = 3, target_faces: int = 250000,
               depth_fit: tuple[float, float] = (1.0, 0.0), log=print) -> dict:
    """从渲染视角构建 TSDF 网格，写 PLY + stats.json，返回 stats。"""
    t0 = time.time()
    store = ViewStore(Path(views_dir), depth_fit=depth_fit)
    lo, hi = scene_bbox(store)
    extent = hi - lo
    length = float(extent.max() * 1.12)
    center = (lo + hi) / 2
    origin = center - length / 2
    resolution = int(np.ceil(length / voxel))
    sdf_trunc = voxel * sdf_trunc_mult
    log(f"[bbox] lo={lo.round(3)} hi={hi.round(3)} extent={extent.round(3)} "
        f"length={length:.3f} res={resolution} voxel={voxel}")

    volume = o3d.pipelines.integration.UniformTSDFVolume(
        length=length, resolution=resolution, sdf_trunc=sdf_trunc,
        color_type=o3d.pipelines.integration.TSDFVolumeColorType.NoColor,
        origin=origin.tolist())

    for i in range(len(store)):
        w, h = store.size(i)
        depth = store.depth(i)
        alpha = store.alpha(i)
        valid = (alpha > 127) & np.isfinite(depth) & (depth > 1e-3)
        if valid.sum() > 500:
            p_lo, p_hi = np.percentile(depth[valid], [0.5, 99.5])
            valid &= (depth >= p_lo) & (depth <= p_hi)
        depth = np.where(valid, depth, 0.0).astype(np.float32)
        K = store.K(i)
        cam = store.c2w(i) @ GL_FLIP
        ext = np.eye(4)
        ext[:3, :3] = cam[:3, :3].T
        ext[:3, 3] = -cam[:3, :3].T @ cam[:3, 3]
        intr = o3d.camera.PinholeCameraIntrinsic(w, h, K[0, 0], K[1, 1], K[0, 2], K[1, 2])
        depth_trunc = (max(float(np.percentile(depth[valid], 99.9)) * 1.5, 1.0)
                       if valid.any() else 5.0)
        img = o3d.geometry.RGBDImage.create_from_color_and_depth(
            o3d.geometry.Image(np.zeros((h, w, 3), np.uint8)),
            o3d.geometry.Image(np.ascontiguousarray(depth)),
            depth_scale=1.0, depth_trunc=depth_trunc, convert_rgb_to_intensity=False)
        volume.integrate(img, intr, ext)
        if (i + 1) % 20 == 0 or i == len(store) - 1:
            log(f"  integrate [{i + 1}/{len(store)}] {time.time() - t0:.1f}s")

    mesh = volume.extract_triangle_mesh()
    raw_verts, raw_faces = len(mesh.vertices), len(mesh.triangles)
    log(f"[mc] raw verts={raw_verts} faces={raw_faces}")

    verts = np.asarray(mesh.vertices)
    sup = compute_support(store, verts, tol_abs=max(sdf_trunc * 1.5, 0.03), tol_rel=0.03)
    mesh, cleanup = clean_mesh(mesh, sup["support"], min_support, target_faces)

    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    o3d.io.write_triangle_mesh(str(out), mesh, write_ascii=False, write_vertex_normals=True)
    v_arr = np.asarray(mesh.vertices)
    stats = {
        "views_used": len(store),
        "voxel_length": voxel, "sdf_trunc": sdf_trunc, "resolution": resolution,
        "scene_length": length, "scene_origin": origin.round(6).tolist(),
        "depth_fit": {"a": depth_fit[0], "b": depth_fit[1]},
        "min_support_views": min_support,
        "raw_vertices": int(raw_verts), "raw_faces": int(raw_faces),
        "vertices": int(len(mesh.vertices)), "faces": int(len(mesh.triangles)),
        "bbox_min": v_arr.min(0).round(4).tolist() if len(v_arr) else None,
        "bbox_max": v_arr.max(0).round(4).tolist() if len(v_arr) else None,
        "is_edge_manifold": bool(mesh.is_edge_manifold()) if len(mesh.triangles) else None,
        "surface_area": float(mesh.get_surface_area()) if len(mesh.triangles) else 0.0,
        "vertex_support_median": float(np.median(sup["support"])) if len(sup["support"]) else 0.0,
        "vertex_support_zero_ratio": float((sup["support"] == 0).mean()) if len(sup["support"]) else 0.0,
        "cleanup": cleanup,
        "elapsed_seconds": round(time.time() - t0, 1),
    }
    out.with_suffix(".stats.json").write_text(
        json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"[tsdf] verts={stats['vertices']} faces={stats['faces']} "
        f"manifold={stats['is_edge_manifold']} {stats['elapsed_seconds']}s")
    return stats


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="TSDF → 三角网格")
    ap.add_argument("--views", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--voxel", type=float, default=0.015)
    ap.add_argument("--sdf-trunc-mult", type=float, default=4.0)
    ap.add_argument("--min-support", type=int, default=3)
    ap.add_argument("--target-faces", type=int, default=250000)
    ap.add_argument("--fit-a", type=float, default=1.0)
    ap.add_argument("--fit-b", type=float, default=0.0)
    args = ap.parse_args(argv)
    build_tsdf(args.views, args.out, voxel=args.voxel, sdf_trunc_mult=args.sdf_trunc_mult,
               min_support=args.min_support, target_faces=args.target_faces,
               depth_fit=(args.fit_a, args.fit_b))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
