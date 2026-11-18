"""纹理后处理：洞填充、接缝/拉伸/覆盖度量。

三条硬约束
- **补洞半径只做 3 轮**。实测 8 轮会把相邻家具的颜色越过 UV 缝拖进来，
  在 UV 岛间隔不足时表现为"分不清是哪个物体的花纹"，比留洞更难排查。
- **观测覆盖与推断覆盖必须分开计数**。`total_fill_ratio` 这种把两者相加的数
  不允许单独出现在报告里冒充保真度。
- **度量只输出可回查的量**（像素对、边长比、色差），不输出"看起来还行"这类判断。
"""
from __future__ import annotations

import numpy as np

# 补洞半径：3 轮。与 outputs/2026-11-07 的贴图实验一致（8 轮会串色）。
FILL_RADIUS = 3
# 接缝判定：0-255 色差的绝对阈值，仅用于统计"明显接缝"的条数
SEAM_HIGH_DIFF = 32.0
# 拉伸判定：三角形三条边在 UV 与 3D 的缩放比 max/min 超过该值即视为长条拉伸
STRETCH_FACTOR = 4.0


def fill_unobserved(tex: np.ndarray, observed: np.ndarray, covered: np.ndarray,
                    radius: int = FILL_RADIUS) -> tuple[np.ndarray, np.ndarray, dict]:
    """把已观测像素向外扩散 `radius` 轮，只填 UV 覆盖区内的洞。

    返回 (tex, inferred_mask, stats)。inferred_mask 与 observed 互斥，
    下游据此把"推断补齐"与"实测采样"分开报告。
    """
    tex = tex.copy()
    observed = np.asarray(observed, bool)
    covered = np.asarray(covered, bool)
    filled = observed.copy()
    rounds = []
    for r in range(int(radius)):
        if filled.all() or not (covered & ~filled).any():
            rounds.append(0)
            continue
        acc = np.zeros(tex.shape, np.float32)
        cnt = np.zeros(filled.shape, np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1),
                       (1, 1), (1, -1), (-1, 1), (-1, -1)):
            sh_m = np.roll(filled, (dy, dx), axis=(0, 1))
            sh_c = np.roll(tex, (dy, dx), axis=(0, 1)).astype(np.float32)
            acc += sh_c * sh_m[..., None]
            cnt += sh_m
        add = covered & ~filled & (cnt > 0)
        if not add.any():
            rounds.append(0)
            continue
        tex[add] = (acc[add] / cnt[add][:, None]).astype(tex.dtype)
        filled |= add
        rounds.append(int(add.sum()))
    inferred = filled & ~observed & covered
    stats = {
        "radius": int(radius),
        "rounds_filled": rounds,
        "n_inferred": int(inferred.sum()),
        "n_unfilled_in_covered": int((covered & ~filled).sum()),
    }
    return tex, inferred, stats


def seam_metrics(tex: np.ndarray, face_map: np.ndarray, valid: np.ndarray,
                 high_diff: float = SEAM_HIGH_DIFF) -> dict:
    """统计 UV 上相邻像素的色差：跨面 vs 面内。

    跨面色差与面内色差同量级 → 无可见三角接缝；跨面明显更大 → 有接缝。
    """
    t = np.asarray(tex, np.float32)
    fm = np.asarray(face_map)
    v = np.asarray(valid, bool)
    pairs = []
    for axis in (0, 1):
        a_v = v[:-1, :] & v[1:, :] if axis == 0 else v[:, :-1] & v[:, 1:]
        a_f = fm[:-1, :] != fm[1:, :] if axis == 0 else fm[:, :-1] != fm[:, 1:]
        a_d = np.abs(t[:-1, :] - t[1:, :]).mean(axis=2) if axis == 0 else np.abs(t[:, :-1] - t[:, 1:]).mean(axis=2)
        pairs.append((a_v & a_f, a_d))
        pairs.append((a_v & ~a_f, a_d))
    cross = np.concatenate([p[1][p[0]] for p in pairs[0::2]]) if pairs else np.zeros(0)
    within = np.concatenate([p[1][p[0]] for p in pairs[1::2]]) if pairs else np.zeros(0)
    out = {
        "n_cross_pairs": int(cross.size),
        "n_within_pairs": int(within.size),
        "cross_mean": round(float(cross.mean()), 3) if cross.size else None,
        "within_mean": round(float(within.mean()), 3) if within.size else None,
        "cross_p95": round(float(np.percentile(cross, 95)), 3) if cross.size else None,
        "high_seam_pairs": int((cross > high_diff).sum()),
        "high_seam_ratio": round(float((cross > high_diff).mean()), 6) if cross.size else None,
        "threshold": {"high_diff": high_diff},
    }
    if out["cross_mean"] is not None and out["within_mean"]:
        out["ratio_cross_over_within"] = round(out["cross_mean"] / out["within_mean"], 4)
    else:
        out["ratio_cross_over_within"] = None
    return out


def stretch_metrics(uv_px: np.ndarray, faces: np.ndarray, verts3d: np.ndarray,
                    factor: float = STRETCH_FACTOR) -> dict:
    """逐面比较三条边的 UV 缩放与 3D 长度，量化"长条拉伸"。

    uv_px 是 texel 坐标（已乘 tex_size），verts3d 与 faces 同一坐标系（世界 nu）。
    """
    F = np.asarray(faces, np.int64)
    if len(F) == 0:
        return {"n_faces": 0, "anisotropy_p50": None, "anisotropy_p95": None,
                "anisotropy_max": None, "n_stretched": 0, "threshold": {"factor": factor}}
    uv = np.asarray(uv_px, np.float64)[F]          # (n,3,2)
    p3 = np.asarray(verts3d, np.float64)[F]        # (n,3,3)
    dens = np.zeros(len(F), np.float64)
    scales = []
    for a, b in ((0, 1), (1, 2), (2, 0)):
        lu = np.linalg.norm(uv[:, a] - uv[:, b], axis=1)
        l3 = np.linalg.norm(p3[:, a] - p3[:, b], axis=1)
        scales.append(np.where(l3 > 1e-9, lu / np.maximum(l3, 1e-9), np.nan))
    S = np.stack(scales, 1)
    with np.errstate(invalid="ignore"):
        mn = np.nanmin(S, axis=1)
        mx = np.nanmax(S, axis=1)
    good = np.isfinite(mn) & np.isfinite(mx) & (mn > 1e-9)
    aniso = np.where(good, mx / np.maximum(mn, 1e-9), 1.0)
    # 每面 texel 密度：UV 面积 / 3D 面积
    uv_area = 0.5 * np.abs(
        (uv[:, 1, 0] - uv[:, 0, 0]) * (uv[:, 2, 1] - uv[:, 0, 1])
        - (uv[:, 2, 0] - uv[:, 0, 0]) * (uv[:, 1, 1] - uv[:, 0, 1])
    )
    n3 = np.cross(p3[:, 1] - p3[:, 0], p3[:, 2] - p3[:, 0])
    a3 = 0.5 * np.linalg.norm(n3, axis=1)
    ok = a3 > 1e-12
    dens[ok] = uv_area[ok] / a3[ok]
    return {
        "n_faces": int(len(F)),
        "anisotropy_p50": round(float(np.percentile(aniso, 50)), 4),
        "anisotropy_p95": round(float(np.percentile(aniso, 95)), 4),
        "anisotropy_max": round(float(aniso.max()), 4),
        "n_stretched": int((aniso > factor).sum()),
        "texel_density_p50": round(float(np.percentile(dens[ok], 50)), 3) if ok.any() else None,
        "threshold": {"factor": factor},
    }


def seam_metrics_mesh(tex: np.ndarray, observed: np.ndarray, face_map: np.ndarray,
                      faces: np.ndarray, uv_px: np.ndarray, margin: float = 1.5,
                      high_diff: float = SEAM_HIGH_DIFF) -> dict:
    """按**网格共边**量接缝：共边的两个面各向内取 margin 像素，比色差。

    为什么不用 atlas 相邻像素：xatlas 打包 UV 岛时与 3D 邻接无关，图集里挨着的
    两个像素常常来自物体两端，色差大是正常的。真正会被人眼看到的是
    "共享一条 3D 边的两个三角形颜色跳变"，只能按网格邻接取。
    """
    t = np.asarray(tex, np.float32)
    ob = np.asarray(observed, bool)
    F = np.asarray(faces, np.int64)
    T = t.shape[0]
    edges: dict = {}
    for fi in range(len(F)):
        tri = F[fi]
        for a, b in ((0, 1), (1, 2), (2, 0)):
            key = (int(min(tri[a], tri[b])), int(max(tri[a], tri[b])))
            edges.setdefault(key, []).append((fi, a, b))

    def inset(fi, a, b):
        tri = uv_px[F[fi]]
        pa, pb = tri[a], tri[b]
        mid = 0.5 * (pa + pb)
        k = [i for i in (0, 1, 2) if i not in (a, b)][0]
        pk = tri[k]
        d = float(np.linalg.norm(pk - mid))
        if d < 1e-6:
            return None
        s = min(max(margin / d, 0.02), 0.35)
        p = mid * (1 - s) + pk * s
        x = int(round(min(max(p[0], 0), T - 1)))
        y = int(round(min(max(p[1], 0), T - 1)))
        if not ob[y, x]:
            return None
        return t[y, x]

    cross = []
    for lst in edges.values():
        if len(lst) != 2:
            continue
        c1 = inset(*lst[0])
        c2 = inset(*lst[1])
        if c1 is None or c2 is None:
            continue
        cross.append(float(np.abs(c1 - c2).mean()))
    cross = np.asarray(cross, np.float64)

    within = []
    for axis in (0, 1):
        same = ob[:-1, :] & ob[1:, :] if axis == 0 else ob[:, :-1] & ob[:, 1:]
        fm = face_map[:-1, :] == face_map[1:, :] if axis == 0 else face_map[:, :-1] == face_map[:, 1:]
        d = np.abs(t[:-1, :] - t[1:, :]).mean(2) if axis == 0 else np.abs(t[:, :-1] - t[:, 1:]).mean(2)
        m = same & fm & (face_map[:-1, :] >= 0 if axis == 0 else face_map[:, :-1] >= 0)
        within.append(d[m])
    within = np.concatenate(within) if within else np.zeros(0)

    out = {
        "method": "mesh_shared_edge",
        "margin_px": margin,
        "n_cross_edges": int(cross.size),
        "n_within_pairs": int(within.size),
        "cross_mean": round(float(cross.mean()), 3) if cross.size else None,
        "cross_p95": round(float(np.percentile(cross, 95)), 3) if cross.size else None,
        "within_mean": round(float(within.mean()), 3) if within.size else None,
        "high_seam_edges": int((cross > high_diff).sum()),
        "high_seam_ratio": round(float((cross > high_diff).mean()), 6) if cross.size else None,
        "threshold": {"high_diff": high_diff},
    }
    if out["cross_mean"] is not None and out["within_mean"]:
        out["ratio_cross_over_within"] = round(out["cross_mean"] / out["within_mean"], 4)
    else:
        out["ratio_cross_over_within"] = None
    return out


def level_seams(tex: np.ndarray, observed: np.ndarray, covered: np.ndarray,
                face_map: np.ndarray, faces: np.ndarray, uv_px: np.ndarray,
                margin: float = 1.5, lam: float = 0.02,
                max_shift: float = 24.0) -> tuple[np.ndarray, np.ndarray, dict]:
    """接缝电平化：给每个面解一个 RGB 常数偏移，最小化共边两侧色差。

    为什么用常数偏移而不是梯度域（泊松）融合：常数偏移只改低频亮度，不动
    高频结构，织物经纬 / 木纹走向仍然来自原照片；梯度域会把接缝附近的真实
    纹理梯度一并改写，属于"用平滑换观感"，与保真要求冲突。

    解：min Σ_{(a,b)∈共边} ||δ_a - δ_b - (I_b - I_a)||² + λ Σ_f ||δ_f||²
    每个实例独立求解（面数上千，lsqr 足够）。
    """
    import scipy.sparse as sp
    from scipy.sparse.linalg import lsqr

    t = np.asarray(tex, np.float32)
    ob = np.asarray(observed, bool)
    cv = np.asarray(covered, bool)
    F = np.asarray(faces, np.int64)
    T = t.shape[0]
    nF = len(F)
    if nF == 0:
        return tex, np.zeros((0, 3), np.float32), {"method": "none"}

    edges: dict = {}
    for fi in range(nF):
        tri = F[fi]
        for a, b in ((0, 1), (1, 2), (2, 0)):
            key = (int(min(tri[a], tri[b])), int(max(tri[a], tri[b])))
            edges.setdefault(key, []).append((fi, a, b))

    def inset(fi, a, b):
        tri = uv_px[F[fi]]
        pa, pb = tri[a], tri[b]
        mid = 0.5 * (pa + pb)
        k = [i for i in (0, 1, 2) if i not in (a, b)][0]
        d = float(np.linalg.norm(tri[k] - mid))
        if d < 1e-6:
            return None
        s = min(max(margin / d, 0.02), 0.35)
        p = mid * (1 - s) + tri[k] * s
        x = int(round(min(max(p[0], 0), T - 1)))
        y = int(round(min(max(p[1], 0), T - 1)))
        if not (ob[y, x] or cv[y, x]):
            return None
        return fi, t[y, x]

    rows: list = []
    cols: list = []
    vals: list = []
    rhs: list = []
    r = 0
    n_pairs = 0
    for lst in edges.values():
        if len(lst) != 2:
            continue
        a = inset(*lst[0])
        b = inset(*lst[1])
        if a is None or b is None:
            continue
        for c in range(3):
            rows += [r, r]
            cols += [a[0] * 3 + c, b[0] * 3 + c]
            vals += [1.0, -1.0]
            rhs.append(float(b[1][c]) - float(a[1][c]))
            r += 1
        n_pairs += 1
    if n_pairs == 0:
        return tex, np.zeros((nF, 3), np.float32), {"method": "none", "n_pairs": 0}

    # 正则：λ Σ ||δ_f||²，抑制大面积纹理被整体拉亮/压暗造成低频漂移
    for f in range(nF):
        for c in range(3):
            rows.append(r)
            cols.append(f * 3 + c)
            vals.append(lam)
            rhs.append(0.0)
            r += 1

    A = sp.csr_matrix((vals, (rows, cols)), shape=(r, nF * 3))
    sol = lsqr(A, np.asarray(rhs, np.float64), atol=1e-8, btol=1e-8, iter_lim=400)[0]
    delta = sol.reshape(nF, 3).astype(np.float32)
    raw_max = float(np.abs(delta).max()) if delta.size else 0.0
    delta = np.clip(delta, -max_shift, max_shift)

    out = t.copy()
    fm = np.asarray(face_map, np.int64)
    apply_mask = cv & (fm >= 0)
    if apply_mask.any():
        out[apply_mask] += delta[fm[apply_mask]]
        out = np.clip(out, 0, 255)
    stats = {
        "method": "per_face_dc_offset_lsqr",
        "n_shared_edge_pairs": int(n_pairs),
        "lambda": lam,
        "max_shift_allowed": max_shift,
        "max_shift_raw": round(raw_max, 4),
        "n_faces_clipped": int((np.abs(delta) >= max_shift - 1e-6).any(axis=1).sum()),
        "delta_mean_abs": round(float(np.abs(delta).mean()), 4),
        "n_texels_leveled": int(apply_mask.sum()),
        "note": "只改低频亮度，不改高频纹理结构；推断区随所属面同步平移，避免再造接缝",
    }
    return out.astype(np.uint8), delta, stats


def fill_flat(tex: np.ndarray, known: np.ndarray, covered: np.ndarray,
              color: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray, dict]:
    """对超出扩散半径的大片未观测区，用**该实例观测中位数色**填平。

    这不是"修模"，而是把"没有照片证据"显式落成一个可辨认的推断色，
    并与 `inferred_local`（r=3 邻域扩散）分开计数。用实例自身中位色而
    不用邻近像素，避免把相邻家具的花纹拖过来。
    """
    tex = tex.copy()
    known = np.asarray(known, bool)
    covered = np.asarray(covered, bool)
    mask = covered & ~known
    if color is None:
        if known.any():
            color = np.median(np.asarray(tex, np.float32)[known], axis=0)
        else:
            color = np.array([128.0, 128.0, 128.0], np.float32)
    color = np.clip(np.asarray(color, np.float32), 0, 255)
    if mask.any():
        tex[mask] = np.round(color).astype(tex.dtype)
    return tex, mask, {"n_flat": int(mask.sum()), "color": [int(round(float(c))) for c in color]}


def coverage_report(covered: np.ndarray, observed: np.ndarray, inferred: np.ndarray,
                    inferred_local: np.ndarray | None = None,
                    inferred_flat: np.ndarray | None = None) -> dict:
    """观测/推断/未填 三分开计数。拒绝只给一个"填满率"。"""
    covered = np.asarray(covered, bool)
    observed = np.asarray(observed, bool)
    inferred = np.asarray(inferred, bool)
    n_cov = int(covered.sum())
    n_obs = int((covered & observed).sum())
    n_inf = int((covered & inferred).sum())
    n_none = int((covered & ~observed & ~inferred).sum())
    out = {
        "n_covered_texels": n_cov,
        "n_observed_texels": n_obs,
        "n_inferred_texels": n_inf,
        "n_unfilled_texels": n_none,
        "observed_ratio_of_covered": round(n_obs / n_cov, 6) if n_cov else 0.0,
        "inferred_ratio_of_covered": round(n_inf / n_cov, 6) if n_cov else 0.0,
        "unfilled_ratio_of_covered": round(n_none / n_cov, 6) if n_cov else 0.0,
        "note": "observed 与 inferred 互斥；两者相加不等于保真度，保真只看 observed",
    }
    if inferred_local is not None:
        out["n_inferred_local_texels"] = int((covered & np.asarray(inferred_local, bool)).sum())
    if inferred_flat is not None:
        out["n_inferred_flat_texels"] = int((covered & np.asarray(inferred_flat, bool)).sum())
    return out


def face_observation(face_map: np.ndarray, observed: np.ndarray) -> dict:
    """逐面统计被观测 texel 的比例，用于"哪些面完全靠推断"。"""
    fm = np.asarray(face_map)
    ob = np.asarray(observed, bool)
    m = fm >= 0
    if not m.any():
        return {"n_faces_seen": 0, "n_faces_fully_inferred": 0, "fully_inferred": []}
    ids = fm[m].astype(np.int64)
    tot = np.bincount(ids)
    obs = np.bincount(ids, weights=ob[m].astype(np.float64))
    present = tot > 0
    fully = np.nonzero(present & (obs == 0))[0]
    ratios = obs[present] / np.maximum(tot[present], 1)
    return {
        "n_faces_seen": int(present.sum()),
        "n_faces_fully_inferred": int(fully.size),
        "fully_inferred": [int(x) for x in fully[:32]],
        "min_observed_ratio": round(float(ratios.min()), 6) if ratios.size else 0.0,
    }


def sharpness(tex: np.ndarray, mask: np.ndarray) -> dict:
    """贴图锐度：观测区的拉普拉斯方差。用于证明"没有被重采样糊掉"。"""
    t = np.asarray(tex, np.float32)
    g = t.mean(axis=2)
    lap = (4 * g[1:-1, 1:-1] - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:])
    m = np.asarray(mask, bool)[1:-1, 1:-1]
    if not m.any():
        return {"n": 0, "laplacian_var": None}
    return {"n": int(m.sum()), "laplacian_var": round(float(lap[m].var()), 4)}
