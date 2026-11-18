"""房间结构自动推断：地板、两面主墙、转角，以及"这些面到底有没有被拍到"的可见性判定。

为什么不只用全局 RANSAC
- 实测 c858acee 的 SfM 点云（16 240 点）被水平噪声层主导：10 个平面里 9 个与 up 平行，
  只有 1 个竖墙（5.4%）。全局 RANSAC 厚度阈值一放大就把墙"切"成多条平行层。
- 因此：地板用 RANSAC（它确实是最强平面），四面墙改用**轴向直方图峰值 + 近面点残差**，
  既数据驱动又不受层化影响；最后按"哪面墙观测最充分"选保留的两面。

原则
- 不写死任何场景坐标；原点由推断出的转角与地板自动确定。
- 上方向来自相机 up 投票，不假设 COLMAP 轴向约定。
- 拍不到就报拍不到：per-surface visibility 是真实门，不用"点云里有一点"冒充"看到过"。
"""
from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from . import contracts as C
from .ingest import _basis, world_up_from_cameras
from .sfm_io import qvec2rotmat, read_cameras_bin, read_images_bin, read_points3d_bin

log = logging.getLogger("structure")


def intrinsics_from_cam(cam: dict) -> np.ndarray:
    mid, p = cam["model_id"], cam["params"]
    if mid in (0, 1, 2, 3, 4):
        fx, fy, cx, cy = p[0], p[1], p[2], p[3]
    else:
        raise ValueError(f"unsupported camera model {mid}")
    return np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], dtype=np.float64)


def _ransac_plane(pts: np.ndarray, rng: np.random.Generator, iters: int, thresh: float):
    n = len(pts)
    if n < 50:
        return None
    sample = pts[rng.choice(n, size=40000, replace=False)] if n > 40000 else pts
    best = None
    for _ in range(iters):
        p0, p1, p2 = sample[rng.choice(len(sample), 3, replace=False)]
        nrm = np.cross(p1 - p0, p2 - p0)
        ln = np.linalg.norm(nrm)
        if ln < 1e-12:
            continue
        nrm = nrm / ln
        d = -nrm @ p0
        cnt = int((np.abs(pts @ nrm + d) < thresh).sum())
        if best is None or cnt > best[0]:
            best = (cnt, nrm, d)
    return best


def _refine(pts, nrm, d, thresh, rounds=3):
    for _ in range(rounds):
        mask = np.abs(pts @ nrm + d) < thresh
        if mask.sum() < 10:
            break
        sub = pts[mask]
        cen = sub.mean(axis=0)
        _, _, vt = np.linalg.svd(sub - cen, full_matrices=False)
        nrm = vt[-1] / np.linalg.norm(vt[-1])
        d = -nrm @ cen
    mask = np.abs(pts @ nrm + d) < thresh
    rms = float(np.sqrt(np.mean((pts[mask] @ nrm + d) ** 2))) if mask.any() else 0.0
    return nrm, float(d), mask, rms


def project_visibility(points: np.ndarray, cameras: list, cams_intr: dict) -> np.ndarray:
    """每个点是否被至少一个视角看到。针孔近似，畸变未补偿（保守下界）。"""
    seen = np.zeros(len(points), dtype=bool)
    for c in cameras:
        cam = cams_intr[c["camera_id"]]
        K = intrinsics_from_cam(cam)
        R = qvec2rotmat(np.asarray(c["qvec"], dtype=np.float64))
        t = np.asarray(c["tvec"], dtype=np.float64)
        pc = points @ R.T + t
        front = pc[:, 2] > 1e-6
        if not front.any():
            continue
        uv = pc[front][:, :2] / pc[front][:, 2:3] * np.array([K[0, 0], K[1, 1]]) + np.array(
            [K[0, 2], K[1, 2]]
        )
        inside = (
            (uv[:, 0] >= 0)
            & (uv[:, 0] < cam["width"])
            & (uv[:, 1] >= 0)
            & (uv[:, 1] < cam["height"])
        )
        idx = np.nonzero(front)[0][inside]
        seen[idx] = True
    return seen


def _robust_range(vals: np.ndarray, k_mad: float = 4.0):
    """用中位数 ± k·MAD 估有效范围，乖离分位兜底。

    为什么不用分位跨度：实测 room 的 e1 在 q0.5% 处到 -34（房间本体只有 ~9 nu），
    这些远端结构占 0.5% 却能把跨度放大 4 倍，连带把直方图 bin 宽、墙厚带、
    房间尺度全带偏；MAD 对这类长尾污染免疫。
    """
    med = float(np.median(vals))
    mad = float(np.median(np.abs(vals - med))) * 1.4826
    q_lo, q_hi = float(np.quantile(vals, 0.005)), float(np.quantile(vals, 0.995))
    if mad <= 1e-9:
        return q_lo, q_hi
    lo = max(q_lo, med - k_mad * mad)
    hi = min(q_hi, med + k_mad * mad)
    if hi - lo < 1e-6:
        return q_lo, q_hi
    return lo, hi


def _face_candidates(vals: np.ndarray, extreme: str, lo: float, hi: float, band: float, min_count: int):
    """在某一轴的一侧枚举**所有显著密度峰**（最多 8 个），逐个精修并给出实测指标。

    只取单个最强峰不可行：室内点云里家具团常比墙更密（实测 room 内部家具团 7574 点，
    而真墙 -5.8 处只有 892 点），会在第一轮就把墙淘汰掉。改为把候选全部列出，
    由调用方用"外侧空旷 + 延展度"这一物理判据挑墙。
    """
    if hi - lo < 1e-9:
        return []
    nb = 200
    edges = np.linspace(lo, hi, nb + 1)
    cnt, _ = np.histogram(vals, bins=edges)
    centers = 0.5 * (edges[:-1] + edges[1:])
    sm = np.convolve(cnt.astype(np.float64), np.ones(3) / 3.0, mode="same")
    med = float(np.median(vals))
    half = centers < med if extreme == "min" else centers >= med
    idx = np.where(half & (cnt >= min_count))[0]
    if len(idx) == 0:
        return []
    order = idx[np.argsort(-sm[idx])]
    picks: list[int] = []
    for i in order:
        if any(abs(int(i) - j) <= 3 for j in picks):
            continue
        picks.append(int(i))
        if len(picks) >= 8:
            break

    out = []
    for i in picks:
        c0 = float(centers[i])
        for _ in range(3):
            m = np.abs(vals - c0) < band
            if m.sum() < 20:
                break
            c0 = float(np.median(vals[m]))
        mask = np.abs(vals - c0) < band
        n = int(mask.sum())
        if n < 20:
            continue
        # 外侧空旷度：墙的外侧几乎没有点；家具/柜面外侧往往还有房间或另一面墙
        if extreme == "min":
            out_cnt = int(((vals > c0 - 3 * band) & (vals < c0 - band)).sum())
            in_cnt = int(((vals > c0 + band) & (vals < c0 + 3 * band)).sum())
        else:
            out_cnt = int(((vals > c0 + band) & (vals < c0 + 3 * band)).sum())
            in_cnt = int(((vals > c0 - 3 * band) & (vals < c0 - band)).sum())
        rms = float(np.sqrt(np.mean((vals[mask] - c0) ** 2)))
        out.append(
            {
                "coord": c0,
                "n_points": n,
                "outside_ratio": round(float(out_cnt) / float(max(in_cnt, 1)), 4),
                "rms": rms,
                "point_mask": mask,
            }
        )
    return out


def wall_extent_ok(n_points: int, extent_u: float, span_other: float) -> tuple[bool, str, float]:
    """墙候选判据：点数下限 + 延展 ≥ ratio × 另一水平轴房间跨度。

    相对阈值替代旧的固定 min_wall_extent_nu(=1.0)：同一个 1.0 nu 对小房间会筛光所有墙，
    对大房间又会把家具侧板当墙。ratio 默认见 contracts.THRESHOLDS。
    """
    min_points = C.THRESHOLDS["min_wall_points"]
    ratio = C.THRESHOLDS["min_wall_extent_ratio"]
    need_extent = ratio * span_other
    if n_points < min_points:
        return False, f"点数不足 n={n_points} < {min_points}", need_extent
    if extent_u < need_extent:
        return False, (
            f"延展不足 {extent_u:.4f} < {need_extent:.4f}"
            f"（{ratio:.0%} × 跨度 {span_other:.4f}）"
        ), need_extent
    return True, "通过", need_extent


def infer_structure(scene_path) -> dict:
    scene = Path(scene_path)
    colmap = scene / "colmap" / "sparse" / "0"
    if not colmap.exists():
        colmap = scene / "sparse" / "0"
    if not (colmap / "points3D.bin").exists():
        raise RuntimeError("NO_POINTS3D")

    pcd = read_points3d_bin(colmap / "points3D.bin")
    cams_intr = read_cameras_bin(colmap / "cameras.bin")
    cameras = read_images_bin(colmap / "images.bin")
    P = pcd["xyz"]
    if len(P) < 500:
        raise RuntimeError(f"TOO_FEW_POINTS({len(P)})")

    up = world_up_from_cameras(cameras)
    _, e1, e2 = _basis(up)
    origin = np.median(np.asarray([c["center"] for c in cameras]), axis=0)
    Pl = P - origin

    # 尺度：用点云到相机中心的稳健半径，避免远点把阈值放大
    rad = np.linalg.norm(Pl, axis=1)
    rad_hi = float(np.quantile(rad, 0.95))
    thresh = max(0.02 * rad_hi, 1e-4)

    rng = np.random.default_rng(20261108)
    found = _ransac_plane(Pl, rng, iters=500, thresh=thresh)
    if found is None:
        raise RuntimeError("NO_FLOOR_PLANE")
    cnt, nrm, d = found
    nrm, d, mask, rms = _refine(Pl, nrm, d, thresh)
    if abs(float(nrm @ up)) < 0.7:
        raise RuntimeError("FLOOR_NOT_HORIZONTAL")
    if float(nrm @ up) < 0:
        nrm, d = -nrm, -d
    h = Pl @ up
    h_floor = float(np.median(h[mask]))
    above = h > h_floor + 0.05 * float(np.quantile(h, 0.99) - h_floor)
    if above.sum() < 500:
        raise RuntimeError("NO_ABOVE_FLOOR_POINTS")

    a = Pl @ e1
    b = Pl @ e2
    aa, bb, hh = a[above], b[above], h[above]
    n_above = int(above.sum())
    lo_a, hi_a_r = _robust_range(aa)
    lo_b, hi_b_r = _robust_range(bb)
    lo_h, hi_h_r = _robust_range(hh)
    span_a, span_b, span_h = hi_a_r - lo_a, hi_b_r - lo_b, hi_h_r - lo_h
    # 墙厚带取"房间最小尺度"的 6%，夹在 8~40 cm：既容纳点云在墙面上的散布，
    # 又不至于把整面家具阵列并进来（room 的 e1 尺度被远端结构拉到 17 nu，
    # 若按 3%×17 取带会得到 0.52 的过宽带）。
    scale_min = max(min(span_a, span_b, span_h), 1e-3)
    band = float(np.clip(0.06 * scale_min, 0.08, 0.40))
    band_a = band_b = band
    min_count = max(int(0.001 * n_above), 40)

    faces = []
    for axis, vals, other, span_other, name, basis in (
        ("e1", aa, bb, span_b, "e1_min", e1),
        ("e1", aa, bb, span_b, "e1_max", e1),
        ("e2", bb, aa, span_a, "e2_min", e2),
        ("e2", bb, aa, span_a, "e2_max", e2),
    ):
        extreme = name.split("_")[1]
        axis_lo, axis_hi = (lo_a, hi_a_r) if axis == "e1" else (lo_b, hi_b_r)
        road = {
            "name": name,
            "axis": axis,
            "coord": 0.0,
            "basis": basis,
            "normal": (basis if extreme == "min" else -basis).tolist(),
            "n_points": 0,
            "n_candidates": 0,
            "outside_ratio": 1.0,
            "support_ratio": 0.0,
            "extent_u": 0.0,
            "extent_v": 0.0,
            "extent_ratio": 0.0,
            "rms": 0.0,
            "located": False,
            "wall_accepted": False,
        }
        cands = _face_candidates(vals, extreme, axis_lo, axis_hi, band, min_count)
        road["n_candidates"] = len(cands)
        # 墙在房间最外缘：按"从外向内"排序，取第一个满足判据的显著峰。
        # 按点数取最大不可行——室内家具团常比墙更密（实测 room 内部家具团 7574 点，
        # 真墙 -5.8 只有 892 点），会把柜面当成墙。
        cands.sort(key=lambda c: c["coord"] if extreme == "min" else -c["coord"])
        scored = []
        for c in cands:
            m = c["point_mask"]
            n = c["n_points"]
            eu = float(np.quantile(other[m], 0.95) - np.quantile(other[m], 0.05)) if n >= 20 else 0.0
            ev = float(np.quantile(hh[m], 0.95) - np.quantile(hh[m], 0.05)) if n >= 20 else 0.0
            # 相对阈值：延展至少占"另一水平轴房间跨度"的 min_wall_extent_ratio。
            # 固定 nu 阈值（旧 min_wall_extent_nu=1.0）对不同房间意义不同：
            # 小房间会把所有墙筛光，大房间会把家具侧板当墙。
            ok, why, _ = wall_extent_ok(n, eu, span_other)
            if not ok:
                log.info("筛掉墙候选 %s: %s（延展/跨度=%.3f）", name, why, eu / max(span_other, 1e-9))
            scored.append((ok, c, n, eu, ev, m))
        accepted = [s for s in scored if s[0]]
        if not accepted:
            log.error("面 %s 的 %d 个候选全部被筛，该侧不产出墙", name, len(scored))
            faces.append(road)
            continue
        _, c, n, eu, ev, m = accepted[0]
        road.update(
            {
                "coord": float(c["coord"]),
                "n_points": n,
                "outside_ratio": c["outside_ratio"],
                "support_ratio": round(float(n) / float(max(n_above, 1)), 4),
                "extent_u": round(eu, 4),
                "extent_v": round(ev, 4),
                "extent_ratio": round(eu / max(span_other, 1e-9), 4),
                "rms": round(c["rms"], 6),
                "located": True,
                "wall_accepted": True,
                "point_mask_above": m,
            }
        )
        faces.append(road)

    # 同一轴的两侧可能收敛到同一面墙（带内收敛），后者标 duplicate 并退出选择
    for axis in ("e1", "e2"):
        pair = sorted([f for f in faces if f["axis"] == axis], key=lambda f: -f["n_points"])
        if len(pair) == 2 and pair[0]["located"] and pair[1]["located"]:
            if abs(pair[0]["coord"] - pair[1]["coord"]) < 2.0 * band:
                pair[1]["duplicate_of"] = pair[0]["name"]
                pair[1]["located"] = False

    # 选两面墙：每轴优先取"外侧空旷 + 点数足够 + 延展成面"的候选，正交轴两面天然共享一条竖棱
    chosen = []
    for axis in ("e1", "e2"):
        cand = [f for f in faces if f["axis"] == axis and f["located"] and f["wall_accepted"]]
        if not cand:
            located = [f for f in faces if f["axis"] == axis and f["located"]]
            detail = ",".join(
                f"{f['name']}=n{f['n_points']},ext{f['extent_ratio']:.3f},out{f['outside_ratio']:.3f}"
                for f in located
            ) or "no-located-face"
            log.error("墙面筛选失败（%s 轴无可用墙）：已定位候选=%s；阈值=%s",
                      axis, detail, C.THRESHOLDS.get("min_wall_extent_ratio"))
            raise RuntimeError("NOT_ENOUGH_WALL_SUPPORT(" + axis + ":" + detail + ")")
        # 保留"数据最全"的那一面：按墙面面积（水平延展 × 竖直延展）比较。
        # 只看点数会偏向点云稠密但矮的家具侧；面积同时约束了"够长"和"够高"。
        chosen.append(max(cand, key=lambda f: f["extent_u"] * f["extent_v"]))

    # 房间尺度（nu）：用 2%/98% 分位跨度（排除占比 <2% 的远端结构），
    # 并夹住"两面已定位墙的间距"——墙一定在范围内，不能比它更窄。
    lo_a_02, hi_a_02 = (float(v) for v in np.quantile(aa, [0.02, 0.98]))
    lo_b_02, hi_b_02 = (float(v) for v in np.quantile(bb, [0.02, 0.98]))
    ext_a = [f["coord"] for f in faces if f["axis"] == "e1" and f["located"]]
    ext_b = [f["coord"] for f in faces if f["axis"] == "e2" and f["located"]]
    room_a = max(hi_a_02 - lo_a_02, (max(ext_a) - min(ext_a)) if len(ext_a) >= 2 else 0.0)
    room_b = max(hi_b_02 - lo_b_02, (max(ext_b) - min(ext_b)) if len(ext_b) >= 2 else 0.0)
    height = float(hi_h_r - h_floor)

    # 转角：两面保留墙 + 地板 三面交点（世界坐标）
    normals = np.asarray([chosen[0]["normal"], chosen[1]["normal"], nrm])
    offs = -np.asarray([chosen[0]["coord"], chosen[1]["coord"], h_floor])
    if abs(np.linalg.det(normals)) < 1e-9:
        raise RuntimeError("DEGENERATE_CORNER")
    corner = np.linalg.solve(normals, offs)

    # 可见性
    vis = {}
    for name, pts_mask in (
        ("floor", mask),
        (chosen[0]["name"], None),
        (chosen[1]["name"], None),
    ):
        if pts_mask is None:
            f = chosen[0] if name == chosen[0]["name"] else chosen[1]
            pts_mask = f["point_mask_above"]
            pts_sel = Pl[above][pts_mask]
        else:
            pts_sel = Pl[pts_mask]
        seen = project_visibility(pts_sel, cameras, cams_intr)
        vis[name] = {
            "n_points": int(len(pts_sel)),
            "seen_ratio": round(float(seen.mean()), 4) if len(pts_sel) else 0.0,
        }
    all_visible = all(v["seen_ratio"] >= C.THRESHOLDS["min_surface_visibility"] for v in vis.values())

    for f in faces:
        f.pop("point_mask_above", None)
        f["basis"] = [round(float(v), 6) for v in f["basis"]]

    out = {
        "schema": C.SCHEMA_STRUCTURE,
        "status": "ok" if all_visible else "unsupported",
        "diagnostics": [] if all_visible else [C.D_UNSUPPORTED_ROOM],
        "up_world": [round(float(v), 6) for v in up],
        "up_source": "camera_up_vote",
        "origin_world": [round(float(v), 6) for v in origin],
        "plane_threshold": round(thresh, 6),
        "wall_band": {"e1": round(band_a, 6), "e2": round(band_b, 6)},
        "above_floor_points": n_above,
        "span_nu": {"e1": round(span_a, 4), "e2": round(span_b, 4), "up": round(span_h, 4)},
        "floor": {
            "normal": [round(float(v), 6) for v in nrm],
            "d_along_up": round(h_floor, 6),
            "n_inliers": int(mask.sum()),
            "inlier_ratio": round(float(mask.sum()) / len(Pl), 4),
            "rms": round(rms, 6),
        },
        "faces": [
            {k: v for k, v in f.items() if k != "point_mask_above"} for f in faces
        ],
        "kept_walls": [chosen[0]["name"], chosen[1]["name"]],
        "corner_world": [round(float(v), 6) for v in corner],
        "frame": {
            "origin_world": [round(float(v), 6) for v in corner],
            "up": [round(float(v), 6) for v in up],
            "e1": [round(float(v), 6) for v in e1],
            "e2": [round(float(v), 6) for v in e2],
            "source": "inferred_from_sfm_planes",
        },
        "extent_nu": {
            "e1": round(room_a, 6),
            "e2": round(room_b, 6),
            "height": round(height, 6),
        },
        "visibility": vis,
        "surface_visible": all_visible,
        "notes": [
            "相机内参仅用针孔部分，镜头畸变未补偿；可见性为保守下界近似",
            "尺度为 SfM 归一化单位（nu），未做度量标定，不得声明米制尺寸",
            "墙的选择依据是密度峰点数与两向延展度，不含任何场景先验",
        ],
    }
    return out
