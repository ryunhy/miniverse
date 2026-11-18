"""隐藏面补全与几何缺陷检查（T-700069）。

分工：
- `geometry.py` 负责"从观测点云得到观测表面"（顶点严格是输入点，位移 = 0）。
- 本模块只负责"观测表面之外"的东西：洞的推断支撑 + 四类自动检查。

三条不能破的线：
1. 推断面必须与观测面**分层**返回，不允许混在一张 mesh 里冒充实测。
2. 补洞只用边界环做最小面积封闭，不做整体凸包、不做膨胀外扩
   （整体凸包会把椅腿之间的空隙吞掉，膨胀会产生板块）。
3. 检查器宁可报"未取证"，也不把"没检查"写成"通过"。
"""
from __future__ import annotations

from collections import defaultdict

import numpy as np

# 薄片判据：实例包围盒最薄轴低于此值视为片状/板块
THIN_PLATE_NU = 0.02
# 悬浮判据：实例底面离地板超过此值且正下方无支撑
FLOAT_TOL_NU = 0.35
# 洞的规模上限：超过此边数的边界环不自动封闭（多半是整个背面缺失，
# 硬封会造出一整块假平面），改为如实上报"未闭合"。
MAX_HOLE_EDGES = 96


def _edge_key(a: int, b: int):
    return (a, b) if a < b else (b, a)


def edge_use_counts(faces: np.ndarray) -> dict:
    """每条边被多少个三角形共享。1=边界，2=流形内部，>2=非流形。"""
    cnt: dict = defaultdict(int)
    for tri in faces:
        a, b, c = int(tri[0]), int(tri[1]), int(tri[2])
        for e in (_edge_key(a, b), _edge_key(b, c), _edge_key(c, a)):
            cnt[e] += 1
    return dict(cnt)


def boundary_loops(faces: np.ndarray) -> list:
    """把边界边串成闭环。返回每个环的顶点索引列表。"""
    cnt = edge_use_counts(faces)
    adj: dict = defaultdict(list)
    for (a, b), n in cnt.items():
        if n == 1:
            adj[a].append(b)
            adj[b].append(a)
    loops = []
    visited: set = set()
    for start in list(adj):
        if start in visited:
            continue
        loop = [start]
        visited.add(start)
        cur, prev = start, None
        while True:
            nxt = None
            for cand in adj[cur]:
                if cand != prev and cand not in visited:
                    nxt = cand
                    break
            if nxt is None:
                break
            loop.append(nxt)
            visited.add(nxt)
            prev, cur = cur, nxt
            if cur == start:
                break
        if len(loop) >= 3:
            loops.append(loop)
    return loops


def fill_hidden_faces(vertices: np.ndarray, faces: np.ndarray, max_hole_edges: int = MAX_HOLE_EDGES):
    """用边界环扇形三角化封闭空洞。

    返回 (inferred_faces, report)。inferred_faces 只包含**新增**面，
    顶点索引复用观测层顶点，不引入新顶点——保证"补的是洞，不是重画模型"。
    """
    loops = boundary_loops(faces)
    inferred = []
    report = {
        "n_holes": len(loops),
        "n_filled": 0,
        "n_skipped_too_large": 0,
        "hole_sizes": sorted((len(lp) for lp in loops), reverse=True)[:10],
    }
    for lp in loops:
        if len(lp) < 3:
            continue
        if len(lp) > max_hole_edges:
            # 大洞多半是整面缺失：硬封会产生一大块假平面，宁可留开并上报
            report["n_skipped_too_large"] += 1
            continue
        # 扇形三角化：以环首为扇心。对小洞足够，且不会外扩到边界之外
        for i in range(1, len(lp) - 1):
            inferred.append([lp[0], lp[i], lp[i + 1]])
        report["n_filled"] += 1
    return np.asarray(inferred, dtype=np.int64).reshape(-1, 3), report


def nonmanifold_edges(faces: np.ndarray) -> dict:
    cnt = edge_use_counts(faces)
    bad = [e for e, n in cnt.items() if n > 2]
    return {"n_nonmanifold": len(bad), "n_boundary": sum(1 for n in cnt.values() if n == 1)}


def thin_plate_axes(size_nu) -> list:
    """返回薄于 THIN_PLATE_NU 的轴名，空列表表示不是片状。"""
    names = ["e1", "e2", "up"]
    return [names[i] for i, v in enumerate(size_nu) if float(v) < THIN_PLATE_NU]


def floaters(instances: list) -> list:
    """找"悬空"实例：底面明显高于地板且正下方 1 个 AABB 内没有别的实例。

    注意 `instances[].aabb_nu` 的 z 已经是"离地高度"（`w = Pl·up − floor.d_along_up`），
    这里**不能**再减一次地板偏移——那会把坐标系差异当成悬空证据。

    只报不删：卡面禁止"规则家具替换"，但也没说可以静默丢掉疑似悬浮实例。
    """
    out = []
    for inst in instances:
        lo = inst["aabb_nu"]["min"]
        hi = inst["aabb_nu"]["max"]
        bottom = float(lo[2])
        if bottom <= FLOAT_TOL_NU:
            continue
        cx = 0.5 * (float(lo[0]) + float(hi[0]))
        cy = 0.5 * (float(lo[1]) + float(hi[1]))
        supported = False
        for other in instances:
            if other["id"] == inst["id"]:
                continue
            olo, ohi = other["aabb_nu"]["min"], other["aabb_nu"]["max"]
            if olo[0] - 0.1 <= cx <= ohi[0] + 0.1 and olo[1] - 0.1 <= cy <= ohi[1] + 0.1:
                if float(ohi[2]) >= bottom - FLOAT_TOL_NU:
                    supported = True
                    break
        if not supported:
            out.append(
                {
                    "id": inst["id"],
                    "bottom_nu": round(bottom, 4),
                    "reason": f"底面离地 {bottom:.3f} nu 且正下方无支撑实例",
                }
            )
    return out


def wall_gaps(instances: list, structure: dict, tol: float = 0.05) -> list:
    """找穿出房间保留墙外侧的实例（墙缺口/局部变形证据）。

    local 坐标以点云质心为原点、房间尺寸是 `extent_nu`，所以房间在 e1/e2 上的
    边界是 `±extent/2`，不是 `[0, extent]`。用错边界会把"在房间内但在原点负侧的
    合法家具"全部误报成穿墙。
    """
    kept = set(structure.get("kept_walls") or [])
    extent = structure.get("extent_nu") or {}
    h1 = 0.5 * float(extent.get("e1", 0.0))
    h2 = 0.5 * float(extent.get("e2", 0.0))
    out = []
    for inst in instances:
        lo, hi = inst["aabb_nu"]["min"], inst["aabb_nu"]["max"]
        checks = {
            "e1_min": lo[0] < -h1 - tol,
            "e1_max": hi[0] > h1 + tol,
            "e2_min": lo[1] < -h2 - tol,
            "e2_max": hi[1] > h2 + tol,
        }
        hit = [k for k, v in checks.items() if v and k in kept]
        if hit:
            out.append(
                {
                    "id": inst["id"],
                    "walls": hit,
                    "aabb_min": lo,
                    "aabb_max": hi,
                    "room_half_extent_nu": [round(h1, 4), round(h2, 4)],
                }
            )
    return out
