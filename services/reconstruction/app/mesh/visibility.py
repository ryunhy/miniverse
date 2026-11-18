"""视角存储 + 可见性/深度一致性判定（TSDF 过滤与纹理烘焙共用）。"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

GL_FLIP = np.diag([1.0, -1.0, -1.0, 1.0])


class ViewStore:
    """懒加载 104 视角的 RGB / 深度 / alpha / 内参 / 位姿（带缓存）。"""

    def __init__(self, views_dir: Path, meta: dict | None = None, depth_fit: tuple[float, float] = (1.0, 0.0)):
        self.dir = Path(views_dir)
        self.meta = meta or json.loads((self.dir / "views-meta.json").read_text())
        self.views = self.meta["views"]
        self.depth_fit = depth_fit
        self._cache: dict[tuple[str, int], np.ndarray] = {}

    def __len__(self) -> int:
        return len(self.views)

    def info(self, i: int) -> dict:
        return self.views[i]

    def key(self, i: int) -> str:
        # 用 stem 而非 replace(".jpg","")：数据集常见大写 .JPG，硬编码小写会拼出
        # view-XXX.JPG.npz（实际落盘是 view-XXX.npz），直接 FileNotFoundError。
        return Path(self.views[i]["name"]).stem

    def _load(self, i: int, field: str) -> np.ndarray:
        k = (field, i)
        if k not in self._cache:
            if len(self._cache) >= 24:
                self._cache.pop(next(iter(self._cache)))
            with np.load(self.dir / f"view-{self.key(i)}.npz") as z:
                self._cache[k] = z[field]
        return self._cache[k]

    def depth(self, i: int) -> np.ndarray:
        d = self._load(i, "depth").astype(np.float32)
        return self.depth_fit[0] * d + self.depth_fit[1]

    def alpha(self, i: int) -> np.ndarray:
        return self._load(i, "alpha")

    def rgb(self, i: int) -> np.ndarray:
        return self._load(i, "rgb")

    def normal(self, i: int) -> np.ndarray:
        return self._load(i, "normal").astype(np.float32)

    def K(self, i: int) -> np.ndarray:
        return np.asarray(self.views[i]["K"], dtype=np.float64)

    def c2w(self, i: int) -> np.ndarray:
        return np.asarray(self.views[i]["c2w_gl"], dtype=np.float64)

    def size(self, i: int) -> tuple[int, int]:
        return int(self.views[i]["width"]), int(self.views[i]["height"])


def project_points(c2w_gl: np.ndarray, K: np.ndarray, pts: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """世界点（ns，Y-up 之前即 ns 系）→ (u,v), 相机系 z。"""
    c2w_cv = c2w_gl @ GL_FLIP
    R, t = c2w_cv[:3, :3], c2w_cv[:3, 3]
    pc = (pts - t) @ R
    z = pc[:, 2]
    uv = pc @ K.T
    z_safe = np.where(np.abs(z) < 1e-9, np.nan, z)
    return np.stack([uv[:, 0] / z_safe, uv[:, 1] / z_safe], 1), z


def bilinear(img: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    u0 = np.clip(np.floor(u).astype(np.int64), 0, w - 1)
    v0 = np.clip(np.floor(v).astype(np.int64), 0, h - 1)
    u1 = np.clip(u0 + 1, 0, w - 1)
    v1 = np.clip(v0 + 1, 0, h - 1)
    extra = img.ndim - 2
    fu = (u - u0).reshape((-1,) + (1,) * extra)
    fv = (v - v0).reshape((-1,) + (1,) * extra)
    return (img[v0, u0] * (1 - fu) * (1 - fv) + img[v0, u1] * fu * (1 - fv)
            + img[v1, u0] * (1 - fu) * fv + img[v1, u1] * fu * fv)


def compute_support(store: ViewStore, pts: np.ndarray, tol_abs: float = 0.05,
                    tol_rel: float = 0.02, view_indices: list[int] | None = None) -> dict:
    """统计每个世界点被多少视角「看到且深度一致」，并记录最佳视角（最近且一致）。"""
    idxs = view_indices if view_indices is not None else list(range(len(store)))
    n = len(pts)
    support = np.zeros(n, np.int32)
    best_view = np.full(n, -1, np.int32)
    best_z = np.full(n, np.inf, np.float32)
    for i in idxs:
        w, h = store.size(i)
        uv, z = project_points(store.c2w(i), store.K(i), pts)
        inside = (np.isfinite(uv[:, 0]) & (uv[:, 0] >= 1) & (uv[:, 0] <= w - 2)
                  & (uv[:, 1] >= 1) & (uv[:, 1] <= h - 2) & (z > 1e-3))
        cand = np.where(inside)[0]
        if cand.size == 0:
            continue
        d = store.depth(i)
        dr = bilinear(d, uv[cand, 0], uv[cand, 1])
        tol = np.maximum(tol_abs, np.abs(z[cand]) * tol_rel)
        ok = (dr > 1e-3) & (np.abs(dr - z[cand]) <= tol)
        hit = cand[ok]
        support[hit] += 1
        closer = z[hit] < best_z[hit]
        sel = hit[closer]
        best_view[sel] = i
        best_z[sel] = z[sel]
    return {"support": support, "best_view": best_view, "best_z": best_z}


def coverage_ratio(store: ViewStore, pts: np.ndarray, tol_abs: float = 0.05,
                   tol_rel: float = 0.02) -> float:
    r = compute_support(store, pts, tol_abs, tol_rel)
    return float((r["support"] > 0).mean()) if len(pts) else 0.0
