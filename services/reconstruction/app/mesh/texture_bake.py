"""UV 展开 + 多视角纹理烘焙 + GLB 导出。

流程：xatlas 参数化 → 逐面选最优可见视角（法向朝向 + 深度一致 + 最近）→ 在 UV 空间
      UV 重心还原 3D 后透视采样（逐像素深度/alpha 剔除）→ 洞填充 → 导出 GLB。
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import cv2
import numpy as np
import trimesh
import xatlas

from .visibility import GL_FLIP, ViewStore, bilinear, project_points


def load_mesh(path: Path) -> tuple[np.ndarray, np.ndarray]:
    mesh = trimesh.load(str(path), process=False)
    return np.asarray(mesh.vertices, np.float64), np.asarray(mesh.faces, np.int64)


def face_normals(verts: np.ndarray, faces: np.ndarray) -> np.ndarray:
    a = verts[faces[:, 0]]
    b = verts[faces[:, 1]]
    c = verts[faces[:, 2]]
    n = np.cross(b - a, c - a)
    norm = np.linalg.norm(n, axis=1, keepdims=True)
    return n / np.maximum(norm, 1e-12)


def to_opencv_distortion(dist: list) -> np.ndarray:
    """nerfstudio 畸变顺序 [k1,k2,k3,k4,p1,p2] → OpenCV 顺序 [k1,k2,p1,p2,k3(,k4,k5,k6)]。

    见 nerfstudio/cameras/camera_utils.py::get_distortion_params。OpenCV 的
    initUndistortRectifyMap 只接受 4/5/8/12/14 元，6 元直接断言失败，因此：
      - k4 == 0 → 输出 5 元（标准 k1,k2,p1,p2,k3 模型）
      - k4 != 0 → 输出 8 元（追加 k4,k5=0,k6=0）
    """
    v = [float(x) for x in (dist or [])]
    if len(v) < 6:
        v = v + [0.0] * (6 - len(v))
    k1, k2, k3, k4, p1, p2 = v[:6]
    if abs(k4) < 1e-12:
        return np.asarray([k1, k2, p1, p2, k3], np.float64)
    return np.asarray([k1, k2, p1, p2, k3, k4, 0.0, 0.0], np.float64)


def undistort_maps(K: np.ndarray, dist: list, w: int, h: int):
    if not dist or all(abs(v) < 1e-9 for v in dist):
        return None, None
    return cv2.initUndistortRectifyMap(K, to_opencv_distortion(dist), None, K, (w, h), cv2.CV_32FC1)


def select_best_views(store: ViewStore, centroids: np.ndarray, normals: np.ndarray,
                      tol_abs: float = 0.06, tol_rel: float = 0.03,
                      min_facing: float = 0.15, top_k: int = 1,
                      sharpness_weight: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    """按质心可见性排序；top_k=1 保留 (N,) API，其余返回 (N,K)，空位 -1/0。

    候选仍须通过质心深度检查；top_k 不能找回所有质心均被遮挡的面。
    """
    if not isinstance(top_k, (int, np.integer)) or top_k < 1:
        raise ValueError("top_k must be a positive integer")
    n = len(centroids)
    best = np.full((n, top_k), -1, np.int32)
    best_score = np.zeros((n, top_k), np.float64)
    for i in range(len(store)):
        w, h = store.size(i)
        cam = store.c2w(i)
        uv, z = project_points(cam, store.K(i), centroids)
        view_dir = cam[:3, 3] - centroids
        dist = np.linalg.norm(view_dir, axis=1)
        facing = np.sum(normals * view_dir, 1) / np.maximum(dist, 1e-9)
        inside = (np.isfinite(uv[:, 0]) & (uv[:, 0] >= 1) & (uv[:, 0] <= w - 2)
                  & (uv[:, 1] >= 1) & (uv[:, 1] <= h - 2) & (z > 1e-3))
        cand = np.where(inside & (facing > min_facing))[0]
        if cand.size == 0:
            continue
        d = store.depth(i)
        dr = bilinear(d, uv[cand, 0], uv[cand, 1])
        tol = np.maximum(tol_abs, np.abs(z[cand]) * tol_rel)
        ok = (dr > 1e-3) & (np.abs(dr - z[cand]) <= tol)
        hit = cand[ok]
        if hit.size == 0:
            continue
        score = facing[hit] * (1.0 / (1.0 + z[hit] * 0.3))
        if sharpness_weight > 0:
            gray = cv2.cvtColor(store.rgb(i), cv2.COLOR_RGB2GRAY).astype(np.float32)
            lap = cv2.Laplacian(gray, cv2.CV_32F, ksize=3)
            local = bilinear(np.abs(lap), uv[hit, 0], uv[hit, 1])
            score *= 1.0 + sharpness_weight * np.clip(local / 20.0, 0, 1)
        if top_k == 1:
            better = score > best_score[hit, 0]
            sel = hit[better]
            best[sel, 0] = i
            best_score[sel, 0] = score[better]
        else:
            worst = np.argmin(best_score[hit], axis=1)
            better = score > best_score[hit, worst]
            sel = hit[better]
            best[sel, worst[better]] = i
            best_score[sel, worst[better]] = score[better]
            order = np.argsort(-best_score[sel], axis=1, kind="stable")
            best[sel] = np.take_along_axis(best[sel], order, axis=1)
            best_score[sel] = np.take_along_axis(best_score[sel], order, axis=1)
    if top_k == 1:
        return best[:, 0], best_score[:, 0]
    return best, best_score


def bake_texture(store: ViewStore, verts: np.ndarray, faces: np.ndarray, uvs: np.ndarray,
                 best_view: np.ndarray, tex_size: int, tol_abs: float = 0.06, *,
                 view_scores: np.ndarray | None = None, color_conflict_threshold: float = 40.0,
                 alpha_min: float = 0.5, projection_mode: str = "perspective",
                 fill_holes: bool = True) -> tuple[np.ndarray, dict]:
    """候选须按质量排序；无 scores 时按 1/(rank+1) 加权，仅融合有效采样。

    任一 RGB 通道的有效候选极差 > 40（0..255 色阶）时选最高权重有效单视角。
    40 是保守的实验阈值（非感知色差/实景标定值），可显式调整至 0..255。
    alpha_min 使用 0..1；uint8 alpha 转为 0..1。affine 仅供投影对照实验。
    pixels_written 为独立直接采样 texel；补绘不计作真实观测。旧元数据来源 unknown。
    """
    if tex_size < 1 or projection_mode not in ("perspective", "affine"):
        raise ValueError("invalid texture size or projection mode")
    if not 0 <= color_conflict_threshold <= 255 or not 0 <= alpha_min <= 1:
        raise ValueError("invalid conflict threshold or alpha_min")
    candidates = np.asarray(best_view)
    if candidates.ndim == 1:
        candidates = candidates[:, None]
    if (candidates.ndim != 2 or len(candidates) != len(faces)
            or not np.issubdtype(candidates.dtype, np.integer)
            or np.any(candidates < -1) or np.any(candidates >= len(store))):
        raise ValueError("best_view must contain view indices with shape (N,) or (N,K)")
    if view_scores is None:
        weights = np.broadcast_to(1.0 / (np.arange(candidates.shape[1]) + 1), candidates.shape)
    else:
        weights = np.asarray(view_scores, dtype=np.float64)
        if weights.ndim == 1:
            weights = weights[:, None]
        if weights.shape != candidates.shape or not np.isfinite(weights).all() or np.any(weights < 0):
            raise ValueError("view_scores must be finite, nonnegative and match best_view")
    tex = np.zeros((tex_size, tex_size, 3), np.float32)
    written = np.zeros((tex_size, tex_size), bool)
    provenance = np.zeros_like(written, dtype=np.uint8)
    conflicts = np.zeros_like(written)
    # 只在第一次使用视角时转换整图；深度/alpha 同样缓存，避免每面复制。
    src_cache: dict[int, tuple] = {}

    def source(i: int) -> tuple:
        if i not in src_cache:
            if len(src_cache) >= 24:
                src_cache.pop(next(iter(src_cache)))
            rgb = store.rgb(i)
            info = store.info(i)
            mx, my = undistort_maps(store.K(i), info.get("distortion") or [], rgb.shape[1], rgb.shape[0])
            if mx is not None:
                rgb = cv2.remap(rgb, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            alpha = store.alpha(i)
            scale = 255.0 if alpha.dtype == np.uint8 else 1.0
            # 只信任显式 rgb_source；禁止由目录名、图像内容或旧元数据猜测照片。
            kind = info.get("rgb_source", store.meta.get("rgb_source", "unknown"))
            code = {"generated": 1, "photograph": 2}.get(kind, 4) if isinstance(kind, str) else 4
            src_cache[i] = (rgb, store.depth(i),
                            alpha.astype(np.float32) / scale, code)
        return src_cache[i]

    uv_px = uvs * (tex_size - 1)
    stats = {"faces": int(len(faces)), "faces_without_view": 0, "faces_degenerate": 0,
             "faces_without_pixels": 0, "projection_mode": projection_mode,
             "color_conflict_threshold": float(color_conflict_threshold)}
    for f, face in enumerate(faces):
        tri_uv, tri = uv_px[face], verts[face]
        if not np.isfinite(tri_uv).all() or not np.isfinite(tri).all():
            stats["faces_degenerate"] += 1
            continue
        v0, v1 = tri_uv[1] - tri_uv[0], tri_uv[2] - tri_uv[0]
        den = v0[0] * v1[1] - v1[0] * v0[1]
        edges = tri[1:] - tri[0]
        area = np.linalg.norm(np.cross(edges[0], edges[1]))
        if (abs(den) <= 1e-12
                or area <= 1e-12 * max(1.0, np.linalg.norm(edges[0]) * np.linalg.norm(edges[1]))):
            stats["faces_degenerate"] += 1
            continue
        active = (candidates[f] >= 0) & (weights[f] > 0)
        if not active.any():
            stats["faces_without_view"] += 1
            continue
        xmin = max(int(np.floor(tri_uv[:, 0].min())), 0)
        xmax = min(int(np.ceil(tri_uv[:, 0].max())), tex_size - 1)
        ymin = max(int(np.floor(tri_uv[:, 1].min())), 0)
        ymax = min(int(np.ceil(tri_uv[:, 1].max())), tex_size - 1)
        if xmax < xmin or ymax < ymin:
            stats["faces_without_pixels"] += 1
            continue
        gx, gy = np.meshgrid(np.arange(xmin, xmax + 1), np.arange(ymin, ymax + 1))
        v2 = np.column_stack([gx.ravel(), gy.ravel()]) - tri_uv[0]
        s = (v2[:, 0] * v1[1] - v1[0] * v2[:, 1]) / den
        t = (v0[0] * v2[:, 1] - v2[:, 0] * v0[1]) / den
        inside = (s >= -1e-4) & (t >= -1e-4) & (s + t <= 1 + 1e-4)
        bary = np.column_stack([1 - s[inside] - t[inside], s[inside], t[inside]])
        points = bary @ tri
        count = len(points)
        total = np.zeros(count)
        accum = np.zeros((count, 3))
        low, high = np.full((count, 3), np.inf), np.full((count, 3), -np.inf)
        strongest = np.zeros(count)
        chosen = np.zeros((count, 3))
        origins, chosen_origin = np.zeros(count, np.uint8), np.zeros(count, np.uint8)
        seen = set()
        for rank in np.flatnonzero(active):
            vi = int(candidates[f, rank])
            if vi in seen:
                continue
            seen.add(vi)
            c2w, K = store.c2w(vi), store.K(vi)
            uv_img, z_pix = project_points(c2w, K, points)
            if projection_mode == "affine":
                corners, _ = project_points(c2w, K, tri)
                uv_img = bary @ corners
            src, depth, alpha, origin = source(vi)
            h, w = src.shape[:2]
            if depth.shape != (h, w) or alpha.shape != (h, w):
                raise ValueError("RGB, depth and alpha must share image coordinates")
            u, v = uv_img.T
            ok = (np.isfinite(uv_img).all(axis=1) & np.isfinite(z_pix) & (z_pix > 1e-3)
                  & (u >= 0) & (u <= w - 1) & (v >= 0) & (v <= h - 1))
            idx = np.flatnonzero(ok)
            dz = bilinear(depth, u[idx], v[idx])
            a = bilinear(alpha, u[idx], v[idx])
            valid = (np.isfinite(dz) & (dz > 1e-3) & np.isfinite(a) & (a > 0) & (a >= alpha_min)
                     & (np.abs(dz - z_pix[idx]) <= np.maximum(tol_abs, np.abs(z_pix[idx]) * 0.03)))
            idx = idx[valid]
            colors = bilinear(src, u[idx], v[idx])
            finite = np.isfinite(colors).all(axis=1)
            idx, colors = idx[finite], colors[finite]
            weight = weights[f, rank]
            accum[idx] += colors * weight
            total[idx] += weight
            low[idx] = np.minimum(low[idx], colors)
            high[idx] = np.maximum(high[idx], colors)
            origins[idx] |= origin
            stronger = weight > strongest[idx]
            better = idx[stronger]
            chosen[better] = colors[stronger]
            chosen_origin[better] = origin
            strongest[better] = weight
        valid = total > 0
        if not valid.any():
            stats["faces_without_pixels"] += 1
            continue
        idx = np.flatnonzero(valid)
        conflict = np.max(high[idx] - low[idx], axis=1) > color_conflict_threshold
        colors = accum[idx] / total[idx, None]
        colors[conflict] = chosen[idx[conflict]]
        origin = origins[idx]  # 整数数组索引已返回副本，conflict 覆写不会污染 origins。
        origin[conflict] = chosen_origin[idx[conflict]]
        yy, xx = gy.ravel()[inside][idx], gx.ravel()[inside][idx]
        tex[yy, xx] = colors
        written[yy, xx] = True  # 黑色是有效颜色，绝不能用 RGB!=0 判定。
        provenance[yy, xx] = origin
        conflicts[yy, xx] = conflict

    filled = written.copy()
    stats["uv_fill_method"] = "none"
    if fill_holes and written.any() and not written.all():
        from scipy import ndimage

        iy, ix = ndimage.distance_transform_edt(~written, return_distances=False, return_indices=True)
        tex[~written] = tex[iy[~written], ix[~written]]
        filled[:] = True
        stats["uv_fill_method"] = "edt_nearest"
    # 来源按最终直接采样像素独立统计。混入 generated 即按 generated；其余含未知则 unknown。
    generated = written & ((provenance & 1) != 0)
    photograph = written & (provenance == 2)
    unknown_source = written & ~generated & ~photograph
    stats.update(pixels_written=int(written.sum()), pixels_filled=int((filled & ~written).sum()),
                 pixels_unknown=int((~filled).sum()), pixels_conflict=int(conflicts.sum()),
                 rgb_source_pixels={"generated": int(generated.sum()), "photograph": int(photograph.sum()),
                                    "unknown": int(unknown_source.sum())},
                 uv_fill_ratio=float(filled.mean()), direct_bake_ratio=float(written.mean()))
    return np.clip(tex, 0, 255).astype(np.uint8), stats


def export_glb(path: Path, verts: np.ndarray, faces: np.ndarray, uvs: np.ndarray,
               texture: np.ndarray) -> dict:
    """自写 GLB 导出（baseColorFactor=1、doubleSided），避免第三方默认值倍乘贴图。"""
    from .glb_io import write_glb

    ok, buf = cv2.imencode(".png", cv2.cvtColor(texture, cv2.COLOR_RGB2BGR))
    if not ok:
        raise SystemExit("贴图 PNG 编码失败")
    return write_glb(path, verts, faces, uvs, buf.tobytes(), name="miniverse-m1-mesh")


def bake_to_glb(mesh_path: Path, views_dir: Path, out: Path, tex_size: int = 4096,
                depth_fit: tuple[float, float] = (1.0, 0.0),
                texture_out: Path | None = None, tol_abs: float | None = None,
                log=print, *, top_k: int = 1, color_conflict_threshold: float = 40.0,
                projection_mode: str = "perspective", sharpness_weight: float = 0.0) -> dict:
    """UV 展开 + 纹理烘焙 + 导出 GLB，写 stats.json 并返回统计。

    tol_abs：深度一致容差（米），None 时用各函数默认 0.06。TSDF 治理版的
    闭合圆角/桥接面偏离实测面最多 2r（默认 10.5cm），6cm 容差会把它们全部
    判为无视角（上轮 58%）导致贴图靠扩散填充；显式传 ~2r 的一半可让圆角面
    直接取到正确颜色。"""
    t0 = time.time()
    verts, faces = load_mesh(Path(mesh_path))
    log(f"[mesh] verts={len(verts)} faces={len(faces)}")

    vmapping, new_faces, uvs = xatlas.parametrize(verts, faces)
    new_verts = verts[vmapping]
    log(f"[xatlas] atlas verts={len(new_verts)} faces={len(new_faces)} uvs={uvs.shape}")

    store = ViewStore(Path(views_dir), depth_fit=depth_fit)
    normals = face_normals(new_verts, new_faces)
    centroids = new_verts[new_faces].mean(1)
    t1 = time.time()
    tolerance = float(tol_abs) if tol_abs is not None else 0.06
    best_view, score = select_best_views(store, centroids, normals, tol_abs=tolerance, top_k=top_k,
                                         sharpness_weight=sharpness_weight)
    # 兜底仅作用于完全没有候选的面，不把 (N,K) 空槽当作面索引。
    missing = best_view < 0 if best_view.ndim == 1 else (best_view < 0).all(axis=1)
    if missing.any():
        b2, s2 = select_best_views(store, centroids[missing], normals[missing],
                                   tol_abs=tolerance, min_facing=-1.0, top_k=top_k)
        best_view[missing], score[missing] = b2, s2
    missing = best_view < 0 if best_view.ndim == 1 else (best_view < 0).all(axis=1)
    log(f"[views] selected {time.time() - t1:.1f}s, no-view faces={missing.sum()}")

    texture, bstats = bake_texture(store, new_verts, new_faces, uvs, best_view, tex_size,
                                   tol_abs=tolerance, view_scores=score,
                                   color_conflict_threshold=color_conflict_threshold,
                                   projection_mode=projection_mode)
    bstats["tol_abs"] = tolerance
    bstats["top_k"] = top_k
    log(f"[bake] {time.time() - t1:.1f}s {json.dumps(bstats, ensure_ascii=False)}")

    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    export_glb(out, new_verts, new_faces, uvs, texture)
    tex_path = Path(texture_out) if texture_out else out.with_name(out.stem + "-texture.png")
    cv2.imwrite(str(tex_path), cv2.cvtColor(texture, cv2.COLOR_RGB2BGR))

    stats = {
        "mesh": str(mesh_path), "glb": str(out), "texture": str(tex_path),
        "texture_size": tex_size,
        "vertices": int(len(new_verts)), "faces": int(len(new_faces)),
        "uv_min": uvs.min(0).round(5).tolist(), "uv_max": uvs.max(0).round(5).tolist(),
        "faces_without_view": int(missing.sum()),
        "bake": bstats,
        "glb_bytes": out.stat().st_size,
        "elapsed_seconds": round(time.time() - t0, 1),
    }
    out.with_suffix(".stats.json").write_text(
        json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"[glb] {out.name} {stats['glb_bytes'] / 1048576:.2f}MB  {stats['elapsed_seconds']}s")
    return stats


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="UV 展开 + 纹理烘焙 → GLB")
    ap.add_argument("--mesh", type=Path, required=True)
    ap.add_argument("--views", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--tex-size", type=int, default=4096)
    ap.add_argument("--fit-a", type=float, default=1.0)
    ap.add_argument("--fit-b", type=float, default=0.0)
    ap.add_argument("--texture-out", type=Path, default=None)
    ap.add_argument("--top-k", type=int, default=1)
    ap.add_argument("--color-conflict-threshold", type=float, default=40.0)
    ap.add_argument("--projection-mode", choices=["perspective", "affine"], default="perspective")
    args = ap.parse_args(argv)
    stats = bake_to_glb(args.mesh, args.views, args.out, tex_size=args.tex_size,
                        depth_fit=(args.fit_a, args.fit_b), texture_out=args.texture_out,
                        top_k=args.top_k, color_conflict_threshold=args.color_conflict_threshold,
                        projection_mode=args.projection_mode)
    print(json.dumps(stats, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
