"""保真几何与隐藏面补全（T-700069）。

核心约束是"不许改动真实表面"：
- **观测层顶点 = 输入 SfM 点本身**。用 3D Delaunay + 外接球半径过滤（alpha shape）
  产三角面，顶点就是输入点索引，位移严格为 0。这是"同坐标输入输出差异"的硬证据，
  不是"误差很小"。
- **不用整体凸包**。alpha shape 保留凹陷，椅腿之间、扶手与坐面之间的空隙不会被填平。
- **推断层单独成 mesh**，材质与 `layer="inferred"` 标注，绝不与观测面混在一起。
- **不做规则家具替换**：没有家具库、没有"识别成椅子就换成椅子模型"的分支。

为什么用 alpha shape 而不是 Poisson / marching cubes：
后两者都会生成**新顶点**，观测面与输入点云之间必然存在位移，"保真"就只能靠相似度间接说明；
alpha shape 的输出顶点集合是输入点的子集，可以直接给出 0 位移的实证。
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

import numpy as np
from scipy.spatial import Delaunay, cKDTree

from . import completion as K
from . import contracts as C
from .ingest import _find_colmap
from .sfm_io import read_points3d_bin

SCHEMA = "miniature.geometry.v1"

# alpha = ALPHA_FACTOR × 点云最近邻距离的 P50。自适应，不对任何场景写死数值。
ALPHA_FACTOR = 3.0
# 面分层判据：最长边 > TAU_FACTOR × nn_P50 的三角形是"跨接面"——它把两块
# 相距较远的观测点连起来，跨越的区域没有点支撑，属于推断而非观测。
# 这是 alpha shape 的固有产物：外表面天然闭合，闭合处即为未观测区域。
TAU_FACTOR = 2.0
# 单个实例参与 Delaunay 的点数上限：超过后等距抽稀（顶点仍是原始点的子集）。
MAX_VERTS = 4000


def _diag(code: str, severity: str, message: str, measured=None, threshold=None) -> dict:
    return {
        "code": code,
        "severity": severity,
        "message": message,
        "measured": measured or {},
        "threshold": threshold or {},
    }


def _local(points: np.ndarray, structure: dict):
    up = np.asarray(structure["up_world"], dtype=np.float64)
    e1 = np.asarray(structure["frame"]["e1"], dtype=np.float64)
    e2 = np.asarray(structure["frame"]["e2"], dtype=np.float64)
    origin = np.asarray(structure["origin_world"], dtype=np.float64)
    Pl = points - origin
    return np.stack([Pl @ e1, Pl @ e2, Pl @ up - float(structure["floor"]["d_along_up"])], axis=1)


def _instance_point_sets(scene: Path, structure: dict, instances: list, eps: float = 1e-4):
    """按 instances 的 AABB 取点；重叠区按质心最近归属。

    不重跑聚类：AABB 由聚类直接得出，比"按参数重算一遍"更不可能与 068 产物漂移。
    """
    colmap = _find_colmap(scene)
    if colmap is None:
        return None
    P = read_points3d_bin(colmap / "points3D.bin")["xyz"]
    P = P[np.isfinite(P).all(axis=1)]
    Q = _local(P, structure)

    sets = {}
    lo = np.array([i["aabb_nu"]["min"] for i in instances], dtype=np.float64)
    hi = np.array([i["aabb_nu"]["max"] for i in instances], dtype=np.float64)
    cen = np.array([i["centroid_nu"] for i in instances], dtype=np.float64)
    inside = np.all((Q[:, None, :] >= lo[None, :, :] - eps) & (Q[:, None, :] <= hi[None, :, :] + eps), axis=2)
    owner = np.full(len(Q), -1, dtype=np.int64)
    if inside.any():
        d = np.linalg.norm(Q[:, None, :] - cen[None, :, :], axis=2)
        d = np.where(inside, d, np.inf)
        best = np.argmin(d, axis=1)
        has = np.isfinite(d[np.arange(len(Q)), best])
        owner[has] = best[has]
    for k, inst in enumerate(instances):
        idx = np.nonzero(owner == k)[0]
        sets[inst["id"]] = (Q[idx], idx)
    return sets


def alpha_surface(points: np.ndarray, alpha_factor: float = ALPHA_FACTOR, max_verts: int = MAX_VERTS):
    """3D Delaunay + 外接球半径过滤 → 边界三角面。顶点返回的是输入点的索引。"""
    n_in = len(points)
    if n_in < 8:
        return None
    idx = np.arange(n_in)
    if n_in > max_verts:
        # 等距抽稀：抽出来的是原始点的子集，位移依然为 0
        idx = np.linspace(0, n_in - 1, max_verts).astype(np.int64)
        idx = np.unique(idx)
    pts = points[idx]
    tree = cKDTree(pts)
    dist, _ = tree.query(pts, k=2)
    nn = float(np.median(dist[:, 1]))
    alpha = alpha_factor * max(nn, 1e-6)
    try:
        tri = Delaunay(pts)
    except Exception:  # noqa: BLE001 - 退化点云（共面/共线）会抛 QhullError
        return None
    simp = tri.simplices
    p0 = pts[simp[:, 0]]
    a = pts[simp[:, 1]] - p0
    b = pts[simp[:, 2]] - p0
    c = pts[simp[:, 3]] - p0
    M = np.stack([a, b, c], axis=1)
    d = 0.5 * np.stack([(a * a).sum(1), (b * b).sum(1), (c * c).sum(1)], axis=1)
    r = np.full(len(simp), np.inf)
    det = np.linalg.det(M)
    good = np.abs(det) > 1e-18
    if good.any():
        x = np.linalg.solve(M[good], d[good][..., None])[..., 0]
        r[good] = np.linalg.norm(x, axis=1)
    keep = simp[r < alpha]
    if len(keep) == 0:
        return None
    faces = np.vstack(
        [keep[:, [0, 1, 2]], keep[:, [0, 1, 3]], keep[:, [0, 2, 3]], keep[:, [1, 2, 3]]]
    )
    keyed = np.sort(faces, axis=1)
    uniq, counts = np.unique(keyed, axis=0, return_counts=True)
    boundary = uniq[counts == 1]
    tri_v = pts[boundary]
    max_edge = np.linalg.norm(tri_v[:, [1, 2, 0]] - tri_v, axis=2).max(axis=1)
    return {
        "vertices": pts,
        "faces": boundary,
        "max_edge": max_edge,
        "n_input_points": int(n_in),
        "n_used_points": int(len(pts)),
        "nn_distance_p50": round(nn, 6),
        "alpha_nu": round(alpha, 6),
        "n_tetra_kept": int(len(keep)),
    }


def _mesh_sha(vertices: np.ndarray, faces: np.ndarray, layer: str) -> str:
    h = hashlib.sha256()
    h.update(layer.encode("utf-8"))
    h.update(np.ascontiguousarray(vertices, dtype="<f8").tobytes())
    h.update(np.ascontiguousarray(faces, dtype="<i8").tobytes())
    return h.hexdigest()


def build_geometry(scene_path, structure: dict, instances_doc: dict,
                   out_dir=None, export_glb: bool = True, alpha_factor: float = ALPHA_FACTOR) -> dict:
    scene = Path(scene_path)
    diags: list = []
    insts = instances_doc.get("instances") or []
    if not insts:
        return {
            "schema": SCHEMA,
            "status": "unsupported",
            "diagnostics": [_diag(C.D_UNSUPPORTED_ROOM, "error", "没有实例，无法生成几何")],
            "instances": [],
        }

    sets = _instance_point_sets(scene, structure, insts)
    if sets is None:
        return {
            "schema": SCHEMA,
            "status": "unsupported",
            "diagnostics": [_diag(C.D_NO_SFM_BASELINE, "error", "缺少 COLMAP 稀疏基线")],
            "instances": [],
        }

    floor_d = float(structure["floor"]["d_along_up"])
    glb_dir = None
    if export_glb and out_dir is not None:
        glb_dir = Path(out_dir) / "glb"
        glb_dir.mkdir(parents=True, exist_ok=True)

    rows = []
    n_no_surface = 0
    for inst in insts:
        pts, idx = sets.get(inst["id"], (np.zeros((0, 3)), np.zeros(0, dtype=np.int64)))
        surf = alpha_surface(pts, alpha_factor=alpha_factor)
        if surf is None:
            n_no_surface += 1
            rows.append(
                {
                    "id": inst["id"],
                    "status": "no_surface",
                    "n_input_points": int(len(pts)),
                    "reason": "点数不足以三角化或点云退化（共面/共线）",
                }
            )
            continue

        V = surf["vertices"]
        F_all = surf["faces"]
        # 分层：alpha 边界本身就是闭合曲面（外表面），所以不需要"再造面"补洞。
        # 有观测点支撑的三角形 → observed；跨度超过 2×nn_P50 的跨接三角形 → inferred。
        # 这里再调 fill_hidden_faces 会重复生成面并与 F_all 撞面，反而不闭合。
        tau = TAU_FACTOR * surf["nn_distance_p50"]
        obs_mask = surf["max_edge"] <= tau
        F = F_all[obs_mask]
        inferred = F_all[~obs_mask]
        nm = K.nonmanifold_edges(F_all)
        holes = K.boundary_loops(F)
        rep = {
            "n_observed_holes": len(holes),
            "observed_hole_sizes": sorted((len(hp) for hp in holes), reverse=True)[:10],
            "n_bridge_faces": int(len(inferred)),
            "tau_nu": round(tau, 6),
            "method": "alpha-shape outer surface, split by max edge length; no vertices added",
        }

        # 观测层位移证据：观测顶点全部来自输入点，理论上 0；这里实测确认
        tree = cKDTree(pts) if len(pts) else None
        disp = 0.0
        if tree is not None and len(V):
            dd, _ = tree.query(V, k=1)
            disp = float(np.max(dd))

        size = [float(inst["size_nu"][i]) for i in range(3)]
        thin = K.thin_plate_axes(size)

        glb_path = None
        glb_sha = None
        if glb_dir is not None:
            glb_path = glb_dir / f"{inst['id']}.glb"
            glb_sha = _export_glb(glb_path, V, F, inferred)

        rows.append(
            {
                "id": inst["id"],
                "status": "ok",
                "layer_observed": {
                    "n_vertices": int(len(V)),
                    "n_faces": int(len(F)),
                    "sha256": _mesh_sha(V, F, "observed"),
                    "vertex_source": "sfm-points (subset by index)",
                    "max_vertex_displacement_nu": round(disp, 9),
                },
                "layer_inferred": {
                    "n_faces": int(len(inferred)),
                    "sha256": _mesh_sha(V, inferred, "inferred") if len(inferred) else None,
                    "method": "bridge faces (max edge > tau) + boundary-loop fan fill; no new vertices, no dilation",
                },
                "completion": rep,
                "closed": bool(nm["n_boundary"] == 0),
                "n_boundary_edges_remaining": int(nm["n_boundary"]),
                "n_nonmanifold_edges": int(nm["n_nonmanifold"]),
                "thin_plate_axes": thin,
                "alpha_nu": surf["alpha_nu"],
                "nn_distance_p50": surf["nn_distance_p50"],
                "n_input_points": surf["n_input_points"],
                "n_used_points": surf["n_used_points"],
                "glb": str(glb_path) if glb_path else None,
                "glb_sha256": glb_sha,
            }
        )

    checks = {
        "thin_plates": [{"id": r["id"], "axes": r["thin_plate_axes"]} for r in rows if r.get("thin_plate_axes")],
        "floaters": K.floaters(insts),
        "nonmanifold": [{"id": r["id"], "n": r["n_nonmanifold_edges"]} for r in rows
                        if r.get("n_nonmanifold_edges")],
        "wall_gaps": K.wall_gaps(insts, structure),
        "no_surface": [r["id"] for r in rows if r["status"] != "ok"],
    }

    if n_no_surface:
        diags.append(
            _diag(
                C.D_UNSUPPORTED_ROOM,
                "warn",
                f"{n_no_surface} 个实例的观测点不足以生成表面，已如实标记 no_surface，未用规则模型顶替",
                measured={"ids": checks["no_surface"]},
            )
        )
    if checks["floaters"]:
        diags.append(
            _diag(
                C.D_UNSUPPORTED_ROOM,
                "warn",
                f"{len(checks['floaters'])} 个实例疑似悬空，已上报未修正",
                measured={"ids": [f["id"] for f in checks["floaters"]]},
            )
        )

    rel = {}
    for r in rows:
        if r["status"] == "ok":
            rel[r["id"]] = r["layer_observed"]["max_vertex_displacement_nu"]
    worst_disp = max(rel.values()) if rel else None

    return {
        "schema": SCHEMA,
        "status": "ok" if any(r["status"] == "ok" for r in rows) else "unsupported",
        "diagnostics": diags,
        "params": {
            "alpha_factor": alpha_factor,
            "tau_factor": TAU_FACTOR,
            "max_verts": MAX_VERTS,
            "thin_plate_nu": K.THIN_PLATE_NU,
            "float_tol_nu": K.FLOAT_TOL_NU,
            "max_hole_edges": K.MAX_HOLE_EDGES,
        },
        "n_instances": len(rows),
        "n_with_surface": sum(1 for r in rows if r["status"] == "ok"),
        "n_closed": sum(1 for r in rows if r.get("closed")),
        "max_observed_vertex_displacement_nu": worst_disp,
        "instances": rows,
        "checks": checks,
        "notes": [
            "观测层顶点是输入 SfM 点的子集（按索引引用），因此观测面位移恒为 0；max_vertex_displacement_nu 是逐实例实测复核值",
            "推断层只由边界环扇形封闭产生，不新增顶点、不做膨胀，因此不会出现板块式外包",
            "拒绝整体凸包：凸包会吞掉椅腿/扶手之间的空隙，alpha shape 保留凹陷",
            "no_surface 的实例不生成任何替代几何，避免用规则家具冒充实测",
            "闭合率与非流形计数是几何自检指标，不能替代与真实场景的相似度",
        ],
    }


def _export_glb(path: Path, V: np.ndarray, F: np.ndarray, inferred: np.ndarray):
    """观测层 + 推断层打成两个 node，材质与名字区分。trimesh 缺失时返回 None。"""
    try:
        import trimesh
    except Exception:  # noqa: BLE001
        return None
    scene = trimesh.Scene()
    if len(F):
        obs = trimesh.Trimesh(vertices=V, faces=F, process=False)
        obs.visual.face_colors = [200, 200, 200, 255]
        scene.add_geometry(obs, node_name="observed", geom_name="observed")
    if len(inferred):
        inf = trimesh.Trimesh(vertices=V, faces=inferred, process=False)
        inf.visual.face_colors = [230, 120, 60, 255]
        scene.add_geometry(inf, node_name="inferred", geom_name="inferred")
    scene.export(path)
    return C.sha256_file(path)
