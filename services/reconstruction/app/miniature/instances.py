"""跨视角家具实例识别：无监督体素连通域聚类 + 稳定 ID。

设计取舍（对应卡 068 验收）：
- **不分类**：没有可用的开放词表分割模型，且规则替换真实物体是被禁止的。
  实例 = 空间上连通的点云团；"未知类"因此天然不会被强行归入某组。
- **ID 稳定**：ID = 粗化（0.25 nu 粒度）质心 + 尺寸的哈希。同一物体在不同视角
  子集 / 不同采样下得到同一个 ID，与运行顺序无关。
- **不误裁部分可见实例**：可见视角少只降低置信度并标 `partial`，不丢实例、不裁包围盒。
- **重复同类对象不串组**：两个同尺寸的椅子质心不同 → 哈希不同 → 两个 ID。
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
from scipy import ndimage

from . import contracts as C
from .ingest import _find_colmap
from .sfm_io import qvec2rotmat, read_cameras_bin, read_images_bin, read_points3d_bin

SCHEMA = "miniature.instances.v1"

DEFAULT_VOXEL_NU = 0.05
DEFAULT_MIN_POINTS = 80
# ID 粒度 0.6 nu，且用 5%/95% 分位中心而非 min/max 中心。
# 实测依据（artifacts/evidence_068.json）：
#  - 0.25 nu + 均值质心 + 尺寸入哈希：80% 点采样下 c858acee 15 个实例只剩 4 个 ID 一致
#  - 0.5 nu + AABB(min/max) 中心：10% 点采样下 survivor 仅 0.58（极值点抖动即可跨桶）
# 哈希量化天生有边界 cliff，只能靠"稳健统计量 + 更粗粒度"降低跨桶概率。
ID_GRID_NU = 0.6


def _diag(code: str, severity: str, message: str) -> dict:
    return {"code": code, "severity": severity, "message": message}


def load_nerf_transform(scene_path) -> dict | None:
    """读 nerfstudio 的 dataparser_transforms.json（COLMAP 世界 → nerfstudio 归一化世界）。

    这一步是 `aabb_nu` 与「相机/3DGS 点云所在的那个世界」之间唯一缺的环节：
    `x_nerf = scale * (M[:3,:3] @ x_colmap) + M[:3,3]`。找不到就返回 None，
    调用方据此把实例标成「只有局部系」，绝不猜一个变换。
    """
    hits = sorted(Path(scene_path).glob("nerfstudio/**/dataparser_transforms.json"))
    if not hits:
        return None
    try:
        raw = json.loads(hits[0].read_text(encoding="utf-8"))
        M = np.asarray(raw["transform"], dtype=np.float64)
        s = float(raw["scale"])
    except (KeyError, ValueError, TypeError, OSError):
        return None
    # nerfstudio 写的是 3×4（R|t），也兼容 4×4 形态
    if M.shape == (4, 4):
        M = M[:3, :]
    if M.shape != (3, 4) or not np.isfinite(M).all() or not np.isfinite(s) or s <= 0:
        return None
    return {"transform": M, "scale": s, "path": str(hits[0])}


def _local_to_colmap(pts: np.ndarray, origin, e1, e2, up, h_floor: float) -> np.ndarray:
    """(u, v, w) → COLMAP 世界坐标；w 是离地高度，所以要加回 h_floor。"""
    pts = np.atleast_2d(np.asarray(pts, dtype=np.float64))
    return (origin[None, :] + pts[:, 0:1] * e1[None, :] + pts[:, 1:2] * e2[None, :]
            + (pts[:, 2:3] + h_floor) * up[None, :])


def _colmap_to_nerf(P: np.ndarray, tf: dict) -> np.ndarray:
    M = np.asarray(tf["transform"], dtype=np.float64)
    return (np.asarray(tf["scale"], dtype=np.float64)
            * (np.asarray(P, dtype=np.float64) @ M[:3, :3].T) + M[:3, 3])


def _stable_id(pts_local: np.ndarray) -> str:
    """ID = 三轴 5%/95% 分位中心，量化到 ID_GRID_NU。

    实测对比（artifacts/evidence_068.json，真视角对半切分）：
      三轴 0.6nu → c858acee 0.8125 / llff_room 1.0 / f1014582 1.0，无撞桶
      两轴 0.6nu → 同上但 c858acee 出现 1 次垂直叠放撞桶（inst_d32ecdd7-2）
      三轴 0.8nu → c858acee 0.875 但 llff_room 0.75 且出现撞桶
    取三轴 0.6 为默认：跨场景最稳且不引入撞桶。
    """
    lo = np.quantile(pts_local, 0.05, axis=0)
    hi = np.quantile(pts_local, 0.95, axis=0)
    center = 0.5 * (lo + hi)

    def b(x: float) -> int:
        return int(round(float(x) / ID_GRID_NU))

    key = "|".join(str(b(v)) for v in center)
    return "inst_" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:8]


def _cluster(q: np.ndarray, voxel: float):
    """26 邻域体素连通域。

    试过聚类前做 6 邻域膨胀桥接稀疏断连，实测**更差**（c858acee tl_q=0.5 的 ID 一致率
    从 0.71 掉到 0.43）——膨胀让簇边界整体外扩，5%/95% 分位中心位移更大。
    保持纯连通域，稳定性交给稳健统计量。
    """
    ij = np.floor(q / voxel).astype(np.int64)
    ij -= ij.min(axis=0) - 1
    shape = tuple(int(v) for v in (ij.max(axis=0) + 2))
    grid = np.zeros(shape, dtype=bool)
    grid[ij[:, 0], ij[:, 1], ij[:, 2]] = True
    lab, _ = ndimage.label(grid, structure=np.ones((3, 3, 3), dtype=np.int8))
    return lab[ij[:, 0], ij[:, 1], ij[:, 2]], ij


def _view_stats(points_world: np.ndarray, images: list, cams: dict, sample: int = 256) -> int:
    """有多少个视角确实在画面内看到了该实例（投影落在图像内且深度为正）。"""
    if len(points_world) == 0:
        return 0
    idx = np.linspace(0, len(points_world) - 1, min(sample, len(points_world))).astype(int)
    Q = points_world[idx]
    need = max(3, int(0.15 * len(Q)))
    seen = 0
    for im in images:
        cam = cams.get(im["camera_id"])
        if cam is None:
            continue
        R = qvec2rotmat(np.asarray(im["qvec"]))
        t = np.asarray(im["tvec"])
        pc = Q @ R.T + t
        z = pc[:, 2]
        ok = z > 0.05
        if int(ok.sum()) < need:
            continue
        p = cam["params"]
        uv = pc[:, :2] / np.maximum(pc[:, 2:3], 1e-9) * np.array([p[0], p[1]]) + np.array([p[2], p[3]])
        inb = (
            ok
            & (uv[:, 0] >= 0)
            & (uv[:, 0] < cam["width"])
            & (uv[:, 1] >= 0)
            & (uv[:, 1] < cam["height"])
        )
        if int(inb.sum()) >= need:
            seen += 1
    return seen


def detect_instances(
    scene_path,
    structure: dict,
    voxel_nu: float = DEFAULT_VOXEL_NU,
    min_points: int = DEFAULT_MIN_POINTS,
    shell_ratio: float = 0.5,
    point_indices: np.ndarray | None = None,
    nerf_transform: dict | None = None,
) -> dict:
    """point_indices 仅用于稳定性回归（模拟视角子集）；正常流程传 None。

    nerf_transform = `load_nerf_transform(scene)` 的返回值。给了才输出 `aabb_nerf` /
    `centroid_nerf`；不给则只保留局部系（`aabb_nu`）并在 diagnostics 里明说缺这一环，
    绝不猜变换。`aabb_nu` 的数值与精度不随该参数变化。
    """
    scene = Path(scene_path)
    diags: list[dict] = []

    colmap = _find_colmap(scene)
    if colmap is None:
        return {
            "schema": SCHEMA,
            "status": "unsupported",
            "diagnostics": [_diag(C.D_NO_SFM_BASELINE, "error", "缺少 COLMAP 稀疏重建基线")],
            "instances": [],
        }
    pcd = read_points3d_bin(colmap / "points3D.bin")
    images = read_images_bin(colmap / "images.bin")
    cams = read_cameras_bin(colmap / "cameras.bin")
    P = pcd["xyz"]
    if point_indices is not None:
        P = P[point_indices]
    n_nonfinite = int((~np.isfinite(P).all(axis=1)).sum())
    if n_nonfinite:
        # NaN/Inf 会让区间比较恒为 False，静默少算点；先剔除并计数上报。
        P = P[np.isfinite(P).all(axis=1)]
    if len(P) == 0:
        return {
            "schema": SCHEMA,
            "status": "unsupported",
            "diagnostics": [_diag(C.D_NO_DEPTH_FOR_BAKE, "error", "稀疏点云为空，无法做实例聚类")],
            "instances": [],
        }

    up = np.asarray(structure["up_world"], dtype=np.float64)
    e1 = np.asarray(structure["frame"]["e1"], dtype=np.float64)
    e2 = np.asarray(structure["frame"]["e2"], dtype=np.float64)
    origin = np.asarray(structure["origin_world"], dtype=np.float64)
    h_floor = float(structure["floor"]["d_along_up"])

    Pl = P - origin
    u, v = Pl @ e1, Pl @ e2
    w = Pl @ up - h_floor
    span = structure["span_nu"]

    # 只保留地板之上、且在稳健范围内的点（远端结构不是家具，且会把体素网格撑爆）
    keep = (
        (w > 0.02)
        & (w < 1.2 * float(span["up"]))
        & (u > -0.25 * float(span["e1"]))
        & (u < 1.25 * float(span["e1"]))
        & (v > -0.25 * float(span["e2"]))
        & (v < 1.25 * float(span["e2"]))
    )
    if int(keep.sum()) < 200:
        return {
            "schema": SCHEMA,
            "status": "unsupported",
            "diagnostics": [_diag(C.D_UNSUPPORTED_ROOM, "error", "地板以上可用点不足 200，房间无法实例化")],
            "instances": [],
        }

    q = np.stack([u[keep], v[keep], w[keep]], axis=1)
    Pw = P[keep]
    labels, ij = _cluster(q, voxel_nu)
    uniq = [int(x) for x in np.unique(labels)]

    instances = []
    shell = None
    n_degenerate = 0
    min_unique_positions = 20
    for lid in uniq:
        if lid == 0:
            continue
        m = labels == lid
        n = int(m.sum())
        if n < min_points:
            continue
        pts = q[m]
        # 退化簇：SfM 会重复重建同一点（实测 f1014582 的 5562 点里只有 5056 个唯一位置，
        # 其中一个簇 384 个点全在同一坐标，aabb 退化成单点、size 全 0）。
        # 这种簇不是物体，跳过并计数，不静默吞掉。
        if len(np.unique(np.round(pts, 6), axis=0)) < min_unique_positions:
            n_degenerate += 1
            continue
        lo, hi = pts.min(axis=0), pts.max(axis=0)
        size = hi - lo
        centroid_local = pts.mean(axis=0)
        world = Pw[m]
        centroid_world = world.mean(axis=0)

        # 未观测比例：包围盒内被占用的体素占比（反映物体是否空心/只拍到一面）
        cell = ij[m]
        occ = len({tuple(x) for x in cell})
        bbox_vox = float(np.prod(np.floor(size / voxel_nu) + 1))
        unobs = float(max(0.0, 1.0 - occ / max(bbox_vox, 1.0)))

        # 房间外壳判据必须同时满足"占多数点"和"尺寸接近房间"。
        # 只看点数占比会把稀疏场景里的单件大家具误判成外壳（实测：3000 点单团在
        # 3400 点场景里占 88%，但尺寸只有 0.3×0.3×0.6 nu，远小于房间跨度）。
        # 外壳应当至少在两个轴上超过房间跨度的一半。
        span_e1, span_e2, span_up = float(span["e1"]), float(span["e2"]), float(span["up"])
        room_like_axes = int(size[0] > 0.5 * span_e1) + int(size[1] > 0.5 * span_e2) + int(size[2] > 0.5 * span_up)
        if room_like_axes >= 2 and n > shell_ratio * len(q):
            shell = {
                "n_points": n,
                "size_nu": [round(float(x), 4) for x in size],
                "room_like_axes": room_like_axes,
                "reason": "单连通域覆盖超过半数的地板以上点云且尺寸接近房间，判为未分割的房间外壳，不列为家具实例",
            }
            continue

        n_views = _view_stats(world, images, cams)
        # partial 判据只用"被几个视角看到"。体素填充率不能当判据：SfM 点云是表面采样，
        # 物体内部本来就空，实测 c858acee 15 个实例的 bbox 体素填充率全部 <3%，
        # 拿它判 partial 会 100% 命中，失去区分度。填充率只作为"不确定区域"度量上报。
        partial = bool(n_views < 3)
        # 置信度 = 证据量（点数支持 40% + 可见视角支持 60%），非概率校准值
        conf = 0.40 * min(n / 1500.0, 1.0) + 0.60 * min(n_views / 8.0, 1.0)
        instances.append(
            {
                "id": _stable_id(pts),
                "n_points": n,
                "centroid_nu": [round(float(x), 4) for x in centroid_local],
                "centroid_world": [round(float(x), 5) for x in centroid_world],
                "aabb_nu": {
                    "min": [round(float(x), 4) for x in lo],
                    "max": [round(float(x), 4) for x in hi],
                },
                "size_nu": [round(float(x), 4) for x in size],
                "height_nu": round(float(size[2]), 4),
                "n_views": int(n_views),
                "unobserved_voxel_ratio": round(unobs, 4),
                "partial": partial,
                "confidence": round(float(min(max(conf, 0.0), 1.0)), 4),
                "source": "sfm-points",
                "label": "unclassified",
            }
        )
        # 同一物体在 nerfstudio 系下的包围盒：局部 AABB 的 8 个角全部变换后取外接盒。
        # 只能变换 8 角点再取 min/max —— 局部轴与 nerf 轴不平行，只变换 min/max 两个角
        # 会得到一个漏掉物体的假盒子。
        if nerf_transform is not None:
            corners = np.array(
                [[a, b, c] for a in (lo[0], hi[0]) for b in (lo[1], hi[1]) for c in (lo[2], hi[2])],
                dtype=np.float64,
            )
            nc = _colmap_to_nerf(_local_to_colmap(corners, origin, e1, e2, up, h_floor), nerf_transform)
            instances[-1]["aabb_nerf"] = {
                "min": [round(float(v), 5) for v in nc.min(axis=0)],
                "max": [round(float(v), 5) for v in nc.max(axis=0)],
            }
            instances[-1]["centroid_nerf"] = [
                round(float(v), 5)
                for v in _colmap_to_nerf(
                    _local_to_colmap(np.asarray([centroid_local]), origin, e1, e2, up, h_floor),
                    nerf_transform,
                )[0]
            ]

    # 同 ID 冲突（粗化后撞桶）：按体积降序保留首个，其余追加序号并降置信度
    instances.sort(key=lambda x: -x["n_points"])
    seen: dict[str, int] = {}
    for inst in instances:
        iid = inst["id"]
        if iid in seen:
            seen[iid] += 1
            inst["id"] = f"{iid}-{seen[iid]}"
            inst["confidence"] = round(inst["confidence"] * 0.9, 4)
        else:
            seen[iid] = 1

    if len(instances) == 0:
        diags.append(_diag(C.D_UNSUPPORTED_ROOM, "error", "未找到任何达到最小点数的家具实例"))

    frame_block = _frame_block(origin, e1, e2, up, h_floor, nerf_transform)
    if nerf_transform is None:
        diags.append(_diag("NO_NERF_TRANSFORM", "warn",
                           "未找到 dataparser_transforms.json：只输出局部系 aabb_nu，未输出 aabb_nerf"))

    return {
        "schema": SCHEMA,
        "status": "ok" if instances else "unsupported",
        "diagnostics": diags,
        "params": {
            "voxel_nu": voxel_nu,
            "min_points": min_points,
            "id_grid_nu": ID_GRID_NU,
            "n_images": len(images),
        },
        "n_points_total": int(len(P)),
        "n_points_used": int(len(q)),
        "n_instances": len(instances),
        "n_degenerate_skipped": n_degenerate,
        "n_nonfinite_skipped": n_nonfinite,
        "room_shell": shell,
        "frame": frame_block,
        "instances": instances,
        "notes": [
            "实例是无监督空间连通域，不做语义分类；label 固定为 unclassified，避免把未知类强行归组",
            "partial=True 只表示可见视角 <3，不据此裁掉实例或缩小包围盒",
            "unobserved_voxel_ratio 是 bbox 体素填充率的补数（不确定区域度量），不作 partial 判据",
            "置信度 = 0.40×点数饱和 + 0.60×可见视角饱和，非概率校准值",
            "aabb_nu/centroid_nu 在 frame.local_to_colmap 的局部系（单位 nu，非米）；"
            "aabb_nerf/centroid_nerf 在 scene.ply 与相机所在的 nerfstudio 系，可直接投影回原图",
            "centroid_world 是 COLMAP 原始世界坐标（未过 dataparser 变换），不要与米制房间框比较",
        ],
    }


def _frame_block(origin, e1, e2, up, h_floor, nerf_transform) -> dict:
    """把「局部 (u,v,w) → COLMAP → nerfstudio」两步写成可复算的矩阵，供外部消费。"""
    L = np.eye(4, dtype=np.float64)
    L[:3, :3] = np.stack([e1, e2, up], axis=1)      # 列 = 局部基
    L[:3, 3] = origin + h_floor * up                # w 是离地高度，先抬回原点所在的世界
    block = {
        "local_axes": {"e1": [round(float(v), 6) for v in e1],
                       "e2": [round(float(v), 6) for v in e2],
                       "up": [round(float(v), 6) for v in up]},
        "origin_world": [round(float(v), 6) for v in origin],
        "floor_h": round(float(h_floor), 6),
        "unit": "nu",
        "meters_per_unit": None,
        "local_to_colmap": [[round(float(v), 9) for v in row] for row in L],
        "colmap_to_nerf": None,
        "formula": "P_colmap = L[:3,:3] @ [u,v,w] + L[:3,3];  P_nerf = scale*M[:3,:3] @ P_colmap + M[:3,3]",
    }
    if nerf_transform is not None:
        M = np.asarray(nerf_transform["transform"], dtype=np.float64)
        s = float(nerf_transform["scale"])
        N = np.eye(4, dtype=np.float64)
        N[:3, :3] = s * M[:3, :3]
        N[:3, 3] = M[:3, 3]
        block["colmap_to_nerf"] = {
            "matrix": [[round(float(v), 9) for v in row] for row in N],
            "scale": round(s, 9),
            "source": str(nerf_transform.get("path", "")),
        }
    return block
