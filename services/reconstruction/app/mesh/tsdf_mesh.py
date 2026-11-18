"""TSDF 融合 → 三角网格（v2：网格空间治理版）。

v1（open3d UniformTSDFVolume + 顶点支持过滤）在深度跨视角不一致的表面上会产出
「双重壳 + 破洞」：marching cubes 后 1428 个连通块，清理后仍剩 12+ 个实体块，
抽稀再裂出碎屑（bonsai 实测 33 块 / 最大块 63.68%）。

v2 在表面提取段内做四层治理（不动 voxel、不加训练步数）：
  1. torch GPU TSDF 融合（同一 bbox / voxel / 截断口径），同时拿到逐体素权重
     （= 一致观测视角数），权重门控在网格空间完成，替代 v1 的顶点支持过滤；
  2. EDT 形态学闭合（binary closing）：打通 ≤2r 间隙、合并双重壳，
     墙角处生成自然圆角；
  3. 高斯平滑 + marching cubes 后，连通块清理升级为两级：
     小块（< max(1%·最大块, 500) 面）照旧丢弃；存留块里距主块 > floater_gap
     的「飞地」丢弃（浮空壳/孤立墙面，无法合理桥接）；
  4. 抽碎屑精确抽稀：抽稀到 target + 补偿量后剔除 <200 面碎块，
     迭代收敛到面数恰好等于 target（不再有碎块计入块数）。

注意 depth_fit：2DGS 渲染的期望深度通常已是场景单位（a≈1, b≈0），不同数据集
存在小幅系统性偏差时由 depth_calib 拟合，默认恒等。
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
import open3d as o3d

from .visibility import GL_FLIP, ViewStore


def scene_bbox(store: ViewStore, sample_step: int = 8, max_views: int = 0,
               percentile: float = 0.5) -> tuple[np.ndarray, np.ndarray]:
    bounds = []
    indices = (np.linspace(0, len(store) - 1, min(max_views, len(store)), dtype=int)
               if max_views > 0 else range(len(store)))
    for i in indices:
        w, h = store.size(i)
        d = store.depth(i)
        us, vs = np.meshgrid(np.arange(0, w, sample_step), np.arange(0, h, sample_step))
        u = us.ravel().astype(np.float64)
        v = vs.ravel().astype(np.float64)
        z = d[vs.ravel(), us.ravel()].astype(np.float64)
        ok = np.isfinite(z) & (z > 1e-3) & (store.alpha(i)[vs.ravel(), us.ravel()] > 127)
        if not ok.any():
            continue
        K = store.K(i)
        x = (u[ok] - K[0, 2]) / K[0, 0] * z[ok]
        y = (v[ok] - K[1, 2]) / K[1, 1] * z[ok]
        cam = store.c2w(i) @ GL_FLIP
        pw = np.stack([x, y, z[ok]], 1) @ cam[:3, :3].T + cam[:3, 3]
        bounds.append(pw)
    if not bounds:
        raise ValueError("无法估计场景范围：没有有效深度观测")
    lo, hi = np.percentile(np.concatenate(bounds), [percentile, 100 - percentile], axis=0)
    return lo, hi


def _depth_angle_weight(depth: np.ndarray, K: np.ndarray) -> np.ndarray:
    v, u = np.indices(depth.shape, dtype=np.float32)
    rays = np.stack([(u - K[0, 2]) / K[0, 0], (v - K[1, 2]) / K[1, 1], np.ones_like(u)], -1)
    points = depth[..., None] * rays
    normals = np.cross(np.gradient(points, axis=1), np.gradient(points, axis=0))
    denominator = np.linalg.norm(normals, axis=-1) * np.linalg.norm(rays, axis=-1)
    angle = np.abs((normals * rays).sum(-1)) / np.maximum(denominator, 1e-12)
    return np.clip(angle, 0.05, 1).astype(np.float32)


def _integrate_grid(store: ViewStore, lo: np.ndarray, hi: np.ndarray, voxel: float,
                    sdf_trunc: float, depth_fit: tuple[float, float], log=print,
                    weighting: str = "uniform") -> tuple[float, np.ndarray, np.ndarray, np.ndarray]:
    import torch

    if weighting not in ("uniform", "angle", "robust", "angle_robust"):
        raise ValueError(f"未知融合权重：{weighting}")
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    log(f"[tsdf-gpu] device={dev} weighting={weighting}")
    length = float((hi - lo).max() * 1.12)
    origin = (lo + hi) / 2 - length / 2
    res = int(np.ceil(length / voxel))
    c0 = torch.asarray((np.arange(res) + 0.5) * voxel, dtype=torch.float32, device=dev)
    gx = (origin[0] + c0).view(-1, 1, 1).expand(res, res, res)
    gy = (origin[1] + c0).view(1, -1, 1).expand(res, res, res)
    gz = (origin[2] + c0).view(1, 1, -1).expand(res, res, res)
    pts = torch.stack([gx, gy, gz], -1).reshape(-1, 3)
    reference = None
    t0 = time.time()
    passes = 2 if "robust" in weighting else 1
    for iteration in range(passes):
        sdf_acc = torch.zeros(pts.shape[0], dtype=torch.float32, device=dev)
        confidence_acc = torch.zeros_like(sdf_acc)
        support = torch.zeros_like(sdf_acc)
        for i in range(len(store)):
            w, h = store.size(i)
            depth = store.depth(i).astype(np.float32)
            valid = (store.alpha(i) > 127) & np.isfinite(depth) & (depth > 1e-3)
            if valid.sum() > 500:
                p_lo, p_hi = np.percentile(depth[valid], [0.5, 99.5])
                valid &= (depth >= p_lo) & (depth <= p_hi)
            depth_trunc = (max(float(np.percentile(depth[valid], 99.9)) * 1.5, 1.0)
                           if valid.any() else 5.0)
            clean_depth = np.where(valid, depth, 0.0)
            depth_img = torch.asarray(clean_depth, dtype=torch.float32, device=dev)
            K = store.K(i)
            angle_img = (torch.asarray(_depth_angle_weight(clean_depth, K), device=dev)
                         if "angle" in weighting else None)
            cam = store.c2w(i) @ GL_FLIP
            R = torch.asarray(cam[:3, :3], dtype=torch.float32, device=dev)
            t = torch.asarray(cam[:3, 3], dtype=torch.float32, device=dev)
            fx, fy, cx, cy = (float(K[0, 0]), float(K[1, 1]), float(K[0, 2]), float(K[1, 2]))
            chunk = 1_000_000
            for start in range(0, len(pts), chunk):
                sl = slice(start, start + chunk)
                pc = (pts[sl] - t) @ R
                z = pc[:, 2]
                inside = z > 1e-3
                u = fx * pc[:, 0] / torch.where(inside, z, torch.ones_like(z)) + cx
                v = fy * pc[:, 1] / torch.where(inside, z, torch.ones_like(z)) + cy
                inside &= (u >= 1) & (u <= w - 2) & (v >= 1) & (v <= h - 2)
                u0, v0 = u.floor().clamp(0, w - 2), v.floor().clamp(0, h - 2)
                fu, fv = (u - u0).clamp(0, 1), (v - v0).clamp(0, 1)
                ui, vi = u0.long(), v0.long()
                mass, d, confidence = torch.zeros_like(z), torch.zeros_like(z), torch.zeros_like(z)
                for du, dv, coeff in ((0, 0, (1 - fu) * (1 - fv)), (1, 0, fu * (1 - fv)),
                                      (0, 1, (1 - fu) * fv), (1, 1, fu * fv)):
                    sample = depth_img[vi + dv, ui + du]
                    coeff = coeff * (sample > 1e-3)
                    mass += coeff
                    d += coeff * sample
                    confidence += coeff if angle_img is None else coeff * angle_img[vi + dv, ui + du]
                # 零值表示无观测，不能插值成物理表面。
                d = d / mass.clamp(min=1e-8)
                confidence = confidence / mass.clamp(min=1e-8)
                residual = d - z
                ok = inside & (mass >= 0.5) & (d > 1e-3) & (d <= depth_trunc) & (residual.abs() < sdf_trunc)
                if reference is not None:
                    confidence *= (voxel / (residual - reference[sl]).abs().clamp(min=voxel)).clamp(max=1)
                confidence = torch.where(ok, confidence, torch.zeros_like(confidence))
                sdf_acc[sl] += confidence * residual.clamp(-sdf_trunc, sdf_trunc)
                confidence_acc[sl] += confidence
                support[sl] += ok.to(torch.float32)
            if (i + 1) % 40 == 0 or i == len(store) - 1:
                log(f"  integrate pass={iteration + 1} [{i + 1}/{len(store)}] {time.time() - t0:.1f}s")
        # 支持数仍是观测计数，不能把角度/稳健权重当作视角数量。
        reference = torch.where(confidence_acc > 0, sdf_acc / confidence_acc.clamp(min=1e-8),
                                torch.ones_like(sdf_acc))
    return (length, reference.reshape(res, res, res).cpu().numpy(),
            support.reshape(res, res, res).cpu().numpy(), origin)


def _close_occupancy(inside: np.ndarray, r: int) -> np.ndarray:
    """EDT 形态学闭合（erode(dilate(X), ball r)），r 以体素为单位。

    膨胀 = {p: dist(p, X) ≤ r}；腐蚀 = {p ∈ 膨胀: dist(p, 补) > r}。
    注意对偶陷阱：edt(~dil) ≤ r 是「膨胀补集」= 腐蚀的反面，必须用 > r。
    """
    from scipy import ndimage

    dil = ndimage.distance_transform_edt(~inside) <= r
    # 腐蚀：p∈dil 且 dist(p, ~dil) > r —— EDT 的零点须落在 ~dil 上，故输入是 dil
    closed = ndimage.distance_transform_edt(dil) > r
    return closed


def _fill_enclosed_air(closed: np.ndarray, log=print) -> tuple[np.ndarray, dict]:
    """填充封闭气穴。

    闭合+桥接把空腔封死后，marching cubes 会输出「气穴内壁」作为独立面片
    组件（块数虚高、烘焙照不到、体检误判为飞地）。固体实体不应有隐藏内腔：
    与网格边界不连通的空气一律填实。
    """
    from scipy import ndimage

    lab_air, _ = ndimage.label(~closed)
    if lab_air.max() == 0:
        return closed, {"pockets_filled_vox": 0, "n_pockets": 0}
    boundary = np.unique(np.concatenate([
        lab_air[0], lab_air[-1], lab_air[:, 0], lab_air[:, -1],
        lab_air[:, :, 0], lab_air[:, :, -1]]))
    pocket = (lab_air > 0) & ~np.isin(lab_air, boundary)
    n_pockets = int(np.unique(lab_air[pocket]).size)
    filled = int(pocket.sum())
    closed = closed | pocket
    log(f"[fill] 封闭气穴 {n_pockets} 个，填实 {filled} vox")
    return closed, {"pockets_filled_vox": filled, "n_pockets": n_pockets}


def _mesh_component_count(mesh: o3d.geometry.TriangleMesh) -> int:
    return int(len(mesh.cluster_connected_triangles()[1]))


def _bridge_components(closed: np.ndarray, max_gap_vox: float, min_vox: int,
                       log=print) -> tuple[np.ndarray, list[dict]]:
    """大组件最近点对桥接。

    形态学闭合对「薄片边缘对边缘、开口直通大空间」的空隙无效：膨胀填入的
    连接体会被腐蚀球从开口侧重新掏掉（玩具用例只覆盖封闭平行缝）。因此对
    闭合后仍分离且 ≥ min_vox 体素的组件，在其与已连集合最近点对之间补一根
    半径 2 体素的细柱（桥接点即两块真实最接近处，如墙脚↔地板），使 MC 后
    同属一个连通块。间隙 > max_gap_vox 的组件不桥接（交给飞地清理丢弃）。
    """
    from scipy import ndimage
    from scipy.spatial import cKDTree

    lab, n = ndimage.label(closed)
    if n <= 1:
        return closed, []
    counts = np.bincount(lab.ravel())
    counts[0] = 0
    order = [int(i) for i in np.argsort(-counts) if counts[i] >= min_vox]
    if len(order) <= 1:
        return closed, []
    main_idx = np.argwhere(lab == order[0])
    tree = cKDTree(main_idx)
    ball_off = _ball_offsets(2)
    bridges: list[dict] = []
    pending = order[1:]
    while pending:
        progressed = False
        deferred = []
        for ci in pending:
            idx = np.argwhere(lab == ci)
            d, _ = tree.query(idx)
            j = int(np.argmin(d))
            if d[j] > max_gap_vox:
                deferred.append(ci)
                continue
            a = idx[j]
            b = main_idx[tree.query(a[None])[1][0]]
            _paint_ball_line(closed, a, b, ball_off)
            main_idx = np.vstack([main_idx, idx])
            tree = cKDTree(main_idx)
            bridges.append({"component_voxels": int(counts[ci]),
                            "gap_vox": round(float(d[j]), 1),
                            "bridged": True})
            log(f"[bridge] 组件 {ci}（{int(counts[ci])} vox）间隙 {d[j]:.1f}vox 已桥接")
            progressed = True
        pending = deferred
        if not progressed:
            break
    for ci in pending:
        bridges.append({"component_voxels": int(counts[ci]), "bridged": False})
        log(f"[bridge] 组件 {ci}（{int(counts[ci])} vox）间隙超限，不桥接")
    n_bridged = sum(1 for x in bridges if x["bridged"])
    log(f"[bridge] 桥接 {n_bridged} 个组件，放弃 {len(bridges) - n_bridged} 个")
    return closed, bridges


def _ball_offsets(radius: int) -> np.ndarray:
    rr = np.arange(-radius, radius + 1)
    dz, dy, dx = np.meshgrid(rr, rr, rr, indexing="ij")
    hit = (dx * dx + dy * dy + dz * dz) <= radius * radius
    return np.stack([dx[hit], dy[hit], dz[hit]], 1)


def _paint_ball_line(grid: np.ndarray, a: np.ndarray, b: np.ndarray,
                     ball_off: np.ndarray) -> None:
    steps = int(np.ceil(np.linalg.norm((b - a).astype(float)))) * 2 + 1
    t = np.linspace(0.0, 1.0, max(steps, 2))[:, None]
    line = (a[None].astype(float) * (1 - t) + b[None].astype(float) * t).round().astype(int)
    shape = np.asarray(grid.shape)
    for p in line:
        pts = p[None] + ball_off
        ok = ((pts >= 0) & (pts < shape)).all(1)
        grid[pts[ok, 0], pts[ok, 1], pts[ok, 2]] = True


def _component_labels(mesh: o3d.geometry.TriangleMesh) -> tuple[np.ndarray, np.ndarray]:
    res = mesh.cluster_connected_triangles()
    return np.asarray(res[0]), np.asarray(res[1])


def _drop_faces(mesh: o3d.geometry.TriangleMesh, tri_idx: np.ndarray) -> o3d.geometry.TriangleMesh:
    if len(tri_idx):
        mesh.remove_triangles_by_index(tri_idx.tolist())
        mesh.remove_unreferenced_vertices()
    return mesh


def clean_mesh(mesh: o3d.geometry.TriangleMesh, floater_gap: float | None = None,
               min_faces_ratio: float = 0.01, min_faces_abs: int = 500,
               log=print) -> tuple[o3d.geometry.TriangleMesh, dict]:
    """两级连通块清理：小块丢弃 + 飞地丢弃（距主块 > floater_gap 米）。

    floater_gap=None 时跳过飞地丢弃（默认，与 v1 基线一致）；显式给数值才启用。
    """
    stats: dict = {}
    mesh.remove_duplicated_vertices()
    mesh.remove_duplicated_triangles()
    mesh.remove_degenerate_triangles()
    if len(mesh.triangles) == 0:
        return mesh, {"error": "空网格"}

    tri = np.asarray(mesh.triangles)
    verts = np.asarray(mesh.vertices)
    lab, counts = _component_labels(mesh)
    stats["components_raw"] = int(counts.shape[0])

    # 1) 小块：低于 max(1%·最大块, 500) 面的照旧丢弃
    thresh = max(counts.max() * min_faces_ratio, min_faces_abs)
    small = np.where(counts < thresh)[0]
    if len(small):
        drop = np.where(np.isin(lab, small))[0]
        stats["dropped_small_faces"] = int(len(drop))
        mesh = _drop_faces(mesh, drop)
        tri = np.asarray(mesh.triangles)
        verts = np.asarray(mesh.vertices)
        lab, counts = _component_labels(mesh)
    if counts.shape[0] <= 1:
        return mesh, stats
    if floater_gap is None:
        stats["kept_components"] = int(counts.shape[0])
        return mesh, stats

    # 2) 飞地：存留块中距主块最小顶点距离 > floater_gap 的判为浮空/孤立，丢弃
    order = np.argsort(-counts)
    main_id = int(order[0])
    main_pts = verts[np.unique(tri[lab == main_id])]
    from scipy.spatial import cKDTree

    tree = cKDTree(main_pts)
    floaters: list[dict] = []
    drop_idx = []
    for ci in order[1:]:
        cpts = verts[np.unique(tri[lab == ci])]
        gap = float(tree.query(cpts, k=1)[0].min())
        if gap > floater_gap:
            floaters.append({"faces": int(counts[ci]), "gap_m": round(gap, 4)})
            drop_idx.append(np.where(lab == ci)[0])
    if drop_idx:
        stats["floater_dropped"] = floaters
        stats["floater_dropped_faces"] = int(sum(f["faces"] for f in floaters))
        mesh = _drop_faces(mesh, np.concatenate(drop_idx))
    stats["kept_components"] = int(len(_component_labels(mesh)[1]))
    return mesh, stats


def decimate_exact(mesh: o3d.geometry.TriangleMesh, target: int, crumb_min: int = 200,
                   max_attempts: int = 4, log=print
                   ) -> tuple[o3d.geometry.TriangleMesh, dict]:
    """抽稀到恰好 target 面，且不留 <crumb_min 面碎块。

    策略：抽稀目标 = target + 预期碎屑面数，抽稀后剔碎块；差多少下一轮补多少。
    4 轮不齐再对最大块单独校平（其余块不再动，保证不产生新碎块）。
    """
    stats: dict = {"target": target}
    extra = 0
    for attempt in range(1, max_attempts + 1):
        m = mesh.simplify_quadric_decimation(target + extra)
        lab, counts = _component_labels(m)
        crumbs = np.where(counts < crumb_min)[0]
        dropped = int(np.asarray(lab)[np.isin(np.asarray(lab), crumbs)].shape[0]) if len(crumbs) else 0
        if len(crumbs):
            m = _drop_faces(m, np.where(np.isin(np.asarray(lab), crumbs))[0])
        total = len(m.triangles)
        stats[f"attempt{attempt}"] = {"decimate_to": target + extra, "crumb_faces": dropped,
                                      "faces": total}
        if total == target:
            stats["attempts"] = attempt
            return m, stats
        extra += target - total
    # 兜底：主块单独校平
    lab, counts = _component_labels(m)
    main_id = int(np.argmax(counts))
    tri = np.asarray(m.triangles)
    verts = np.asarray(m.vertices)
    others_mask = lab != main_id
    others_faces = int(others_mask.sum())
    main = o3d.geometry.TriangleMesh(
        o3d.utility.Vector3dVector(verts),
        o3d.utility.Vector3iVector(tri[~others_mask]))
    main = main.simplify_quadric_decimation(target - others_faces)
    out = o3d.geometry.TriangleMesh(
        o3d.utility.Vector3dVector(np.vstack([np.asarray(main.vertices), verts[np.unique(tri[others_mask])]])),
        o3d.utility.Vector3iVector(np.vstack([
            np.asarray(main.triangles),
            np.searchsorted(np.unique(tri[others_mask]), tri[others_mask]) + len(main.vertices)])))
    stats["attempts"] = f"main_leveling:{max_attempts}+1"
    stats["faces"] = len(out.triangles)
    return out, stats


def build_tsdf(views_dir: Path, out: Path, voxel: float = 0.015, sdf_trunc_mult: float = 4.0,
               min_support: int = 3, target_faces: int = 250000,
               depth_fit: tuple[float, float] = (1.0, 0.0), close_voxels: int = 0,
               close_sigma: float = 1.2, floater_gap: float | None = None,
               bridge_gap_m: float = 0.0, bridge_min_vox: int = 1500,
               mc_level: float = 0.35, log=print, fusion_weighting: str = "uniform",
               bbox_percentile: float = 0.5, extraction: str = "occupancy") -> dict:
    """从渲染视角构建 TSDF 网格，写 PLY + stats.json，返回 stats。

    默认走纯 TSDF 路径（不做闭运算 / 桥接 / 飞地丢弃），与 v1 基线行为一致。
    三步治理都是显式开关，默认关闭：
      close_voxels>0   → 形态学闭运算（体素数）；
      bridge_gap_m>0   → 大组件最近点对桥接（米）；
      floater_gap!=None→ 丢弃距主块超过该值的飞地（米）。
    """
    t0 = time.time()
    store = ViewStore(Path(views_dir), depth_fit=depth_fit)
    lo, hi = scene_bbox(store, percentile=bbox_percentile)
    extent = hi - lo
    length = float(extent.max() * 1.12)
    center = (lo + hi) / 2
    origin = center - length / 2
    resolution = int(np.ceil(length / voxel))
    sdf_trunc = voxel * sdf_trunc_mult
    log(f"[bbox] lo={lo.round(3)} hi={hi.round(3)} extent={extent.round(3)} "
        f"length={length:.3f} res={resolution} voxel={voxel}")

    _, sdf, weight, _ = _integrate_grid(store, lo, hi, voxel, sdf_trunc, depth_fit,
                                        log=log, weighting=fusion_weighting)

    inside = (sdf < 0) & (weight >= min_support)
    n_inside = int(inside.sum())
    if close_voxels > 0:
        closed = _close_occupancy(inside, close_voxels)
    else:
        closed = inside.copy()
    n_closed = int(closed.sum())
    if bridge_gap_m > 0:
        closed, bridges = _bridge_components(closed, max_gap_vox=bridge_gap_m / voxel,
                                             min_vox=bridge_min_vox, log=log)
    else:
        bridges = []
    from scipy import ndimage
    from skimage import measure

    n_grid_comp = int(ndimage.label(closed)[1])
    log(f"[close] inside={n_inside} closed={n_closed} r={close_voxels}vox "
        f"({close_voxels * voxel:.3f}m) grid_components_after_bridge={n_grid_comp} "
        f"bridges={len(bridges)}")

    if extraction == "sdf":
        field = np.where(weight >= min_support, sdf, sdf_trunc).astype(np.float32)
        field = ndimage.gaussian_filter(field, sigma=min(close_sigma, 0.6))
        level = 0.0
        pockets = {"n_soft_pockets": 0, "soft_pocket_vox": 0, "extraction": "sdf"}
    elif extraction == "occupancy":
        field = ndimage.gaussian_filter(closed.astype(np.float32), sigma=close_sigma)
        level = mc_level
        # 气穴填充必须在 MC 等值面水平上判定： σ 平滑会把薄片间残缝封成腔、0.5 开口
        # 在更低等值面处被封死成腔（如树冠空壳），两类内壁都是独立面片组件的来源。
        low = field < level
        lab_low, _ = ndimage.label(low)
        pockets = {"n_soft_pockets": 0, "soft_pocket_vox": 0, "extraction": "occupancy"}
        if lab_low.max() > 0:
            bnd = np.unique(np.concatenate([lab_low[0], lab_low[-1], lab_low[:, 0],
                                            lab_low[:, -1], lab_low[:, :, 0], lab_low[:, :, -1]]))
            soft_pocket = (lab_low > 0) & ~np.isin(lab_low, bnd)
            pockets["n_soft_pockets"] = int(np.unique(lab_low[soft_pocket]).size)
            pockets["soft_pocket_vox"] = int(soft_pocket.sum())
            field[soft_pocket] = 1.0
            log(f"[fill] level={level} 封闭腔 {pockets['n_soft_pockets']} 个，填实 {pockets['soft_pocket_vox']} vox")
    else:
        raise ValueError(f"未知提取方式：{extraction}")
    vv, ff, _, _ = measure.marching_cubes(field, level=level)
    # 面片朝向校正：固体=closed=1，外向法线应指向 closed 减小方向（-梯度）。
    # skimage 绕向全局一致但方向随版本/算法可能相反，用平均点积判定后整体翻转。
    gx, gy, gz = np.gradient(field)
    fc = vv[ff].mean(1)                                  # 每个面的中心（索引空间）
    fi = np.round(fc).astype(np.int64)
    for ax in range(3):
        fi[:, ax] = np.clip(fi[:, ax], 0, field.shape[ax] - 1)
    f0, f1, f2 = vv[ff[:, 0]], vv[ff[:, 1]], vv[ff[:, 2]]
    n_face = np.cross(f1 - f0, f2 - f0)
    g_at = np.stack([gx[fi[:, 0], fi[:, 1], fi[:, 2]],
                     gy[fi[:, 0], fi[:, 1], fi[:, 2]],
                     gz[fi[:, 0], fi[:, 1], fi[:, 2]]], 1)
    if float((n_face * g_at).sum(1).mean()) > 0:
        ff = ff[:, ::-1].copy()
        log("[mc] 面片朝向翻转（绕向与固体外向相反）")
    del gx, gy, gz, g_at, n_face
    verts = origin + (vv + 0.5) * voxel
    raw_verts, raw_faces = int(len(verts)), int(len(ff))
    w_observed = weight[weight > 0]
    weight_median = float(np.median(w_observed)) if w_observed.size else 0.0
    w_zero_ratio = float((weight == 0).mean())
    log(f"[mc] closed-field verts={raw_verts} faces={raw_faces}")
    del field, closed, sdf, weight

    mesh = o3d.geometry.TriangleMesh(
        o3d.utility.Vector3dVector(verts.astype(np.float64)),
        o3d.utility.Vector3iVector(ff.astype(np.int32)))
    log(f"[split-trace] grid={n_grid_comp} mc_raw={_mesh_component_count(mesh)}")
    mesh, cleanup = clean_mesh(mesh, floater_gap=floater_gap, log=log)
    log(f"[split-trace] after_clean={_mesh_component_count(mesh)}")
    if len(mesh.triangles) == 0:
        return {"error": "清理后为空", **cleanup}

    mesh.compute_vertex_normals()
    mesh = mesh.filter_smooth_taubin(number_of_iterations=8)
    mesh.compute_vertex_normals()
    log(f"[split-trace] after_smooth={_mesh_component_count(mesh)}")

    mesh, decim = decimate_exact(mesh, target_faces, log=log)
    log(f"[split-trace] after_decimate={_mesh_component_count(mesh)}")

    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    o3d.io.write_triangle_mesh(str(out), mesh, write_ascii=False, write_vertex_normals=True)
    v_arr = np.asarray(mesh.vertices)
    stats = {
        "views_used": len(store),
        "voxel_length": voxel, "sdf_trunc": sdf_trunc, "resolution": resolution,
        "scene_length": length, "scene_origin": origin.round(6).tolist(),
        "depth_fit": {"a": depth_fit[0], "b": depth_fit[1]},
        "min_support_views": min_support, "fusion_weighting": fusion_weighting,
        "close_voxels": close_voxels, "close_sigma": close_sigma,
        "floater_gap_m": floater_gap,
        "bridge_gap_m": bridge_gap_m, "bridge_min_vox": bridge_min_vox,
        "mc_level": mc_level,
        "bridges": bridges,
        **pockets,
        "inside_voxels": n_inside, "closed_voxels": n_closed,
        "weight_median_observed": weight_median,
        "weight_zero_ratio": w_zero_ratio,
        "raw_vertices": raw_verts, "raw_faces": raw_faces,
        "vertices": int(len(mesh.vertices)), "faces": int(len(mesh.triangles)),
        "bbox_min": v_arr.min(0).round(4).tolist() if len(v_arr) else None,
        "bbox_max": v_arr.max(0).round(4).tolist() if len(v_arr) else None,
        "is_edge_manifold": bool(mesh.is_edge_manifold()) if len(mesh.triangles) else None,
        "surface_area": float(mesh.get_surface_area()) if len(mesh.triangles) else 0.0,
        "cleanup": cleanup,
        "decimation": decim,
        "elapsed_seconds": round(time.time() - t0, 1),
    }
    out.with_suffix(".stats.json").write_text(
        json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"[tsdf] verts={stats['vertices']} faces={stats['faces']} "
        f"manifold={stats['is_edge_manifold']} {stats['elapsed_seconds']}s")
    return stats


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="TSDF → 三角网格（v2 治理版）")
    ap.add_argument("--views", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--voxel", type=float, default=0.015)
    ap.add_argument("--sdf-trunc-mult", type=float, default=4.0)
    ap.add_argument("--min-support", type=int, default=3)
    ap.add_argument("--target-faces", type=int, default=250000)
    ap.add_argument("--fit-a", type=float, default=1.0)
    ap.add_argument("--fit-b", type=float, default=0.0)
    ap.add_argument("--close-voxels", type=int, default=0, help="闭运算半径（体素），0=关闭")
    ap.add_argument("--close-sigma", type=float, default=1.2)
    ap.add_argument("--floater-gap", type=float, default=None, help="飞地丢弃距离（米），缺省关闭")
    ap.add_argument("--bridge-gap-m", type=float, default=0.0, help="组件桥接最大间隙（米），0=关闭")
    ap.add_argument("--bridge-min-vox", type=int, default=1500)
    ap.add_argument("--mc-level", type=float, default=0.35)
    args = ap.parse_args(argv)
    build_tsdf(args.views, args.out, voxel=args.voxel, sdf_trunc_mult=args.sdf_trunc_mult,
               min_support=args.min_support, target_faces=args.target_faces,
               depth_fit=(args.fit_a, args.fit_b), close_voxels=args.close_voxels,
               close_sigma=args.close_sigma, floater_gap=args.floater_gap,
               bridge_gap_m=args.bridge_gap_m, bridge_min_vox=args.bridge_min_vox,
               mc_level=args.mc_level)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
