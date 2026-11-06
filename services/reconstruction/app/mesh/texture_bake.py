"""UV 展开 + 多视角纹理烘焙 + GLB 导出。

流程：xatlas 参数化 → 逐面选最优可见视角（法向朝向 + 深度一致 + 最近）→ 在 UV 空间
      逐三角形仿射映射回源图双线性采样（带逐像素深度剔除）→ 洞填充 → 导出 GLB。
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
                      min_facing: float = 0.15) -> tuple[np.ndarray, np.ndarray]:
    n = len(centroids)
    best = np.full(n, -1, np.int32)
    best_score = np.zeros(n, np.float64)
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
        better = score > best_score[hit]
        sel = hit[better]
        best[sel] = i
        best_score[sel] = score[better]
    return best, best_score


def bake_texture(store: ViewStore, verts: np.ndarray, faces: np.ndarray, uvs: np.ndarray,
                 best_view: np.ndarray, tex_size: int, tol_abs: float = 0.06) -> tuple[np.ndarray, dict]:
    tex = np.zeros((tex_size, tex_size, 3), np.float32)
    written = np.zeros((tex_size, tex_size), bool)
    # 每个视角的源图（懒加载 + 去畸变缓存）
    src_cache: dict[int, np.ndarray] = {}

    def source(i: int) -> np.ndarray:
        if i not in src_cache:
            rgb = store.rgb(i)
            info = store.info(i)
            mx, my = undistort_maps(store.K(i), info.get("distortion") or [], rgb.shape[1], rgb.shape[0])
            if mx is not None:
                rgb = cv2.remap(rgb, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            src_cache[i] = rgb
        return src_cache[i]

    uv_px = uvs * (tex_size - 1)
    stats = {"faces": int(len(faces)), "faces_without_view": 0, "pixels_written": 0}

    for f in range(len(faces)):
        vi = best_view[f]
        if vi < 0:
            stats["faces_without_view"] += 1
            continue
        tri_uv = uv_px[faces[f]]
        xmin = max(int(np.floor(tri_uv[:, 0].min())), 0)
        xmax = min(int(np.ceil(tri_uv[:, 0].max())), tex_size - 1)
        ymin = max(int(np.floor(tri_uv[:, 1].min())), 0)
        ymax = min(int(np.ceil(tri_uv[:, 1].max())), tex_size - 1)
        if xmax - xmin < 0 or ymax - ymin < 0:
            continue

        # 3D 三角形 → 图像坐标
        c2w = store.c2w(vi)
        K = store.K(vi)
        uv_img, z_img = project_points(c2w, K, verts[faces[f]])
        if not np.all(np.isfinite(uv_img)):
            continue
        src = source(vi)
        h_src, w_src = src.shape[:2]
        A = cv2.getAffineTransform(tri_uv.astype(np.float32), uv_img.astype(np.float32))

        gx, gy = np.meshgrid(np.arange(xmin, xmax + 1), np.arange(ymin, ymax + 1))
        px = np.stack([gx.ravel(), gy.ravel(), np.ones(gx.size)], 1)
        # 重心坐标判内
        v0 = tri_uv[1] - tri_uv[0]
        v1 = tri_uv[2] - tri_uv[0]
        v2 = px[:, :2] - tri_uv[0]
        den = v0[0] * v1[1] - v1[0] * v0[1]
        if abs(den) < 1e-12:
            continue
        s = (v2[:, 0] * v1[1] - v1[0] * v2[:, 1]) / den
        t = (v0[0] * v2[:, 1] - v2[:, 0] * v0[1]) / den
        inside = (s >= -1e-4) & (t >= -1e-4) & (s + t <= 1 + 1e-4)
        if not inside.any():
            continue

        map_px = px[inside] @ A.T
        u = map_px[:, 0]
        v = map_px[:, 1]
        ok = (u >= 0) & (u <= w_src - 1) & (v >= 0) & (v <= h_src - 1)
        if not ok.any():
            continue
        # 逐像素深度剔除（防止采样到遮挡物/背景）
        d = store.depth(vi)
        dz = bilinear(d, u[ok], v[ok])
        # 由重心插值得到该像素的相机系深度
        bary = np.stack([1 - s[inside][ok] - t[inside][ok], s[inside][ok], t[inside][ok]], 1)
        z_pix = bary @ z_img
        consistent = (dz > 1e-3) & (np.abs(dz - z_pix) <= np.maximum(tol_abs, np.abs(z_pix) * 0.03))
        sel = np.where(ok)[0][consistent]
        if sel.size == 0:
            continue
        colors = bilinear(src.astype(np.float32), u[ok][consistent], v[ok][consistent])
        pix_idx = np.where(inside)[0][ok][consistent]
        yy = gy.ravel()[pix_idx]
        xx = gx.ravel()[pix_idx]
        tex[yy, xx] = colors
        written[yy, xx] = True
        stats["pixels_written"] += int(sel.size)

    # 洞填充：从已有像素向外扩散 4 轮（避免 UV 接缝处的黑边/空洞）
    filled = written.copy()
    for _ in range(4):
        if filled.all():
            break
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            shifted_mask = np.roll(filled, (dy, dx), axis=(0, 1))
            shifted_tex = np.roll(tex, (dy, dx), axis=(0, 1))
            add = (~filled) & shifted_mask
            tex[add] = shifted_tex[add]
            filled |= add
    stats["uv_fill_ratio"] = float(filled.mean())
    stats["direct_bake_ratio"] = float(written.mean())
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
                texture_out: Path | None = None, log=print) -> dict:
    """UV 展开 + 纹理烘焙 + 导出 GLB，写 stats.json 并返回统计。"""
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
    best_view, score = select_best_views(store, centroids, normals)
    # 兜底：没有正对视角的面放宽朝向阈值再试一次（仍要求深度一致，避免采到遮挡物）
    missing = best_view < 0
    if missing.any():
        b2, s2 = select_best_views(store, centroids[missing], normals[missing], min_facing=-1.0)
        best_view[missing] = b2
        score[missing] = s2
    log(f"[views] selected {time.time() - t1:.1f}s, no-view faces={(best_view < 0).sum()}")

    texture, bstats = bake_texture(store, new_verts, new_faces, uvs, best_view, tex_size)
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
        "faces_without_view": int((best_view < 0).sum()),
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
    args = ap.parse_args(argv)
    stats = bake_to_glb(args.mesh, args.views, args.out, tex_size=args.tex_size,
                        depth_fit=(args.fit_a, args.fit_b), texture_out=args.texture_out)
    print(json.dumps(stats, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
