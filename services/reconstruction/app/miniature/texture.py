"""照片直接烘焙：原始照片 → 逐 texel 溯源 → 接缝/拉伸/覆盖度量 → 内嵌纹理 GLB。

与既有 `app/mesh/texture_bake.py` 的区别（本卡要解决的正是它的问题）
- **喂原照片，不喂渲染图**。渲染图与相机位姿之间多一层重渲染误差，会把颜色
  校偏成黄绿色斑；这里直接读 `images/` 下 COLMAP 登记的原图。
- **按 name 精确映射**。视角文件名只认 `images.bin` 里的 `image.name`，
  找不到就报 `PHOTO_MISSING`，绝不按索引猜。
- **不重采样图像去畸变**。把 COLMAP 相机模型直接套在投影端，
  原图一个像素都不动，避免二次重采样损失织物/木纹高频。
- **深度一致性用 SfM 稀疏点建 z-buffer**。没有渲染深度图，就用重建出来的
  3D 点本身当深度证据；查不到深度证据的 texel 不给颜色，宁可标为推断。
- **逐 texel 记录来源**（视角、像素坐标、深度残差），落到 npz，可回查。

坐标系
- 几何顶点来自 `geometry.alpha_surface`，是 local 系（nu，原点在房间中心、
  z 为离地高度）；投影前用 `_to_world` 还原成 SfM 世界坐标。
"""
from __future__ import annotations

import json
import math
from collections import OrderedDict
from pathlib import Path

import numpy as np

from . import contracts as C
from . import material_completion as M
from .geometry import _instance_point_sets, alpha_surface
from .ingest import _find_colmap
from .sfm_io import read_cameras_bin, read_images_bin, read_points3d_bin

SCHEMA = "miniature.texture.v1"

# COLMAP 相机模型：(名称, 参数个数)
COLMAP_MODELS = {
    0: ("SIMPLE_PINHOLE", 3),
    1: ("PINHOLE", 4),
    2: ("SIMPLE_RADIAL", 4),
    3: ("RADIAL", 5),
    4: ("OPENCV", 8),
    5: ("OPENCV_FISHEYE", 8),
    6: ("FULL_OPENCV", 12),
    7: ("FOV", 5),
    8: ("SIMPLE_RADIAL_FISHEYE", 4),
    9: ("RADIAL_FISHEYE", 5),
    10: ("THIN_PRISM_FISHEYE", 12),
}
PINHOLE_MODELS = {0, 1, 2, 3, 4, 6}
FISHEYE_MODELS = {5, 8, 9}

TEX_SIZE = 512           # 每实例贴图边长（可 CLI 覆盖）
MIN_FACING = 0.15        # 法向与视线的余弦下限
DEPTH_TOL_ABS = 0.05     # nu
DEPTH_TOL_REL = 0.03
VIEWS_PER_FACE = 3       # 每面最多混合的视角数
DEPTH_CELL_PX = 8        # 稀疏深度缓冲的网格边长（像素）
DEPTH_DILATE = 2         # 深度缓冲膨胀轮数，容忍 SfM 稀疏
IMG_CACHE_MAX = 8        # 原图 LRU 上限，避免 311 张全驻留

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def _diag(code: str, severity: str, message: str, measured=None, threshold=None) -> dict:
    return {"code": code, "severity": severity, "message": message,
            "measured": measured or {}, "threshold": threshold or {}}


# ---------------------------------------------------------------- 相机与投影


class PhotoView:
    """一张原图 + 它的 COLMAP 相机模型。所有投影都用世界坐标。"""

    def __init__(self, name: str, path: Path, model_id: int, params: list,
                 width: int, height: int, R: np.ndarray, t: np.ndarray):
        self.name = name
        self.path = Path(path)
        self.model_id = int(model_id)
        self.model_name = COLMAP_MODELS[model_id][0]
        self.params = [float(v) for v in params]
        self.width = int(width)
        self.height = int(height)
        self.R = np.asarray(R, np.float64)
        self.t = np.asarray(t, np.float64)
        self.center = -self.R.T @ self.t
        self.K, self.dist = _intrinsics(model_id, self.params)
        self.fisheye = model_id in FISHEYE_MODELS
        self.fx = float(self.K[0, 0])
        self.fy = float(self.K[1, 1])
        self.cx = float(self.K[0, 2])
        self.cy = float(self.K[1, 2])

    def project(self, pts_world: np.ndarray):
        """世界点 → (uv, z)。uv 为原始（含畸变）像素坐标。"""
        P = np.asarray(pts_world, np.float64).reshape(-1, 3)
        pc = P @ self.R.T + self.t
        z = pc[:, 2]
        zs = np.where(np.abs(z) < 1e-9, np.nan, z)
        x = pc[:, 0] / zs
        y = pc[:, 1] / zs
        if self.fisheye:
            r = np.hypot(x, y)
            theta = np.arctan(r)
            k = self.dist
            th2 = theta * theta
            scale = 1.0 + k[0] * th2 + k[1] * th2 ** 2 + k[2] * th2 ** 3 + k[3] * th2 ** 4
            fac = np.where(r > 1e-12, (theta * scale) / np.maximum(r, 1e-12), 1.0)
            xd = x * fac
            yd = y * fac
        else:
            xd, yd = _brown_conrady(x, y, self.dist)
        u = self.fx * xd + self.cx
        v = self.fy * yd + self.cy
        return np.stack([u, v], 1), z

    def pixels_per_nu(self, depth: float) -> float:
        return float((self.fx + self.fy) * 0.5 / max(depth, 1e-9))


def _intrinsics(model_id: int, p: list):
    """COLMAP 参数 → (K 3x3, dist 数组)。dist 顺序为 OpenCV/Brown 约定。"""
    if model_id == 0:
        f, cx, cy = p[0], p[1], p[2]
        K = np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]], np.float64)
        return K, np.zeros(4)
    if model_id == 1:
        fx, fy, cx, cy = p[:4]
        K = np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], np.float64)
        return K, np.zeros(4)
    if model_id == 2:
        f, cx, cy, k1 = p[:4]
        K = np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]], np.float64)
        return K, np.array([k1, 0.0, 0.0, 0.0])
    if model_id == 3:
        f, cx, cy, k1, k2 = p[:5]
        K = np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]], np.float64)
        return K, np.array([k1, k2, 0.0, 0.0])
    if model_id == 4:
        fx, fy, cx, cy, k1, k2, p1, p2 = p[:8]
        K = np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], np.float64)
        return K, np.array([k1, k2, p1, p2])
    if model_id == 6:
        fx, fy, cx, cy, k1, k2, p1, p2, k3, k4, k5, k6 = p[:12]
        K = np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], np.float64)
        return K, np.array([k1, k2, p1, p2, k3, k4, k5, k6])
    if model_id == 5:
        fx, fy, cx, cy, k1, k2, k3, k4 = p[:8]
        K = np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], np.float64)
        return K, np.array([k1, k2, k3, k4])
    if model_id == 8:
        f, cx, cy, k1 = p[:4]
        K = np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]], np.float64)
        return K, np.array([k1, 0.0, 0.0, 0.0])
    if model_id == 9:
        f, cx, cy, k1, k2 = p[:5]
        K = np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]], np.float64)
        return K, np.array([k1, k2, 0.0, 0.0])
    raise ValueError(f"unsupported camera model id {model_id}")


def _brown_conrady(x, y, dist):
    """OpenCV 顺序 [k1,k2,p1,p2(,k3,k4,k5,k6)] 的畸变投影。"""
    k1, k2, p1, p2 = dist[0], dist[1], dist[2], dist[3]
    k3 = dist[4] if len(dist) > 4 else 0.0
    r2 = x * x + y * y
    radial = 1.0 + k1 * r2 + k2 * r2 ** 2 + k3 * r2 ** 3
    xd = x * radial + 2.0 * p1 * x * y + p2 * (r2 + 2.0 * x * x)
    yd = y * radial + p1 * (r2 + 2.0 * y * y) + 2.0 * p2 * x * y
    return xd, yd


class _ImageCache:
    def __init__(self, max_size: int = IMG_CACHE_MAX):
        self.max = max_size
        self._d: OrderedDict = OrderedDict()

    def get(self, view: PhotoView):
        if view.name in self._d:
            self._d.move_to_end(view.name)
            return self._d[view.name]
        import cv2  # 延迟导入：无 cv2 时 load_photo_views 已经先报 unavailable

        bgr = cv2.imread(str(view.path), cv2.IMREAD_COLOR)
        if bgr is None:
            raise FileNotFoundError(str(view.path))
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        self._d[view.name] = rgb
        while len(self._d) > self.max:
            self._d.popitem(last=False)
        return rgb


def load_photo_views(scene_path) -> tuple[list, list, dict]:
    """读 COLMAP 相机与 `images/` 原图，返回 (views, diagnostics, stats)。"""
    scene = Path(scene_path)
    diags = []
    colmap = _find_colmap(scene)
    if colmap is None:
        diags.append(_diag(C.D_NO_SFM_BASELINE, "error", "缺少 COLMAP 稀疏重建，无法投影照片"))
        return [], diags, {}
    try:
        cams = read_cameras_bin(colmap / "cameras.bin")
        imgs = read_images_bin(colmap / "images.bin")
    except Exception as e:  # noqa: BLE001 - 落诊断，不吞
        diags.append(_diag(C.D_NO_SFM_BASELINE, "error", f"COLMAP 解析失败: {e}"))
        return [], diags, {}

    img_dir = scene / "images"
    views = []
    missing: list = []
    unsupported: list = []
    size_mismatch: list = []
    for im in imgs:
        cam = cams.get(im["camera_id"])
        if cam is None:
            continue
        mid = int(cam["model_id"])
        if mid not in PINHOLE_MODELS and mid not in FISHEYE_MODELS:
            unsupported.append(COLMAP_MODELS.get(mid, (f"model_{mid}", 0))[0])
            continue
        name = im["name"]
        p = (scene / name) if ("/" in name or "\\" in name) else (img_dir / name)
        if not p.exists():
            # 只做"精确文件名"查找；不做大小写/模糊/索引匹配
            missing.append(name)
            continue
        R = _rotmat(im["qvec"])
        t = np.asarray(im["tvec"], np.float64)
        view = PhotoView(name, p, mid, cam["params"], cam["width"], cam["height"], R, t)
        views.append(view)

    if missing:
        diags.append(_diag("PHOTO_MISSING", "error",
                           f"{len(missing)} 张 COLMAP 登记的照片在 images/ 下找不到（按 name 精确匹配）",
                           measured={"n_missing": len(missing), "files": missing[:10]}))
    if unsupported:
        diags.append(_diag("CAMERA_MODEL_UNSUPPORTED", "warn",
                           "存在本模块未实现的相机模型，已排除该视角",
                           measured={"models": sorted(set(unsupported))}))
    if size_mismatch:
        diags.append(_diag("IMAGE_SIZE_MISMATCH", "error",
                           "照片分辨率与 cameras.bin 不一致，投影会整体错位",
                           measured={"files": size_mismatch[:10]}))
    if not views:
        diags.append(_diag("NO_USABLE_PHOTO", "error", "没有任何可用于投影的原图"))
    stats = {
        "n_images_in_colmap": len(imgs),
        "n_views_usable": len(views),
        "n_missing": len(missing),
        "n_camera_model_unsupported": len(unsupported),
        "matched_by": "image.name_exact",
        "photo_dir": str(img_dir.relative_to(scene)).replace("\\", "/"),
        "models": sorted({v.model_name for v in views}),
    }
    return views, diags, stats


def _rotmat(qvec) -> np.ndarray:
    w, x, y, z = [float(v) for v in qvec]
    return np.array([
        [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * z * w, 2 * x * z + 2 * y * w],
        [2 * x * y + 2 * z * w, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * x * w],
        [2 * x * z - 2 * y * w, 2 * y * z + 2 * x * w, 1 - 2 * x * x - 2 * y * y],
    ], np.float64)


def verify_image_sizes(views: list) -> list:
    """逐视角核对磁盘图尺寸与 cameras.bin；不一致返回文件名列表。"""
    import cv2

    bad = []
    for v in views:
        img = cv2.imread(str(v.path), cv2.IMREAD_UNCHANGED)
        if img is None:
            bad.append(v.name)
            continue
        h, w = img.shape[:2]
        if (int(w), int(h)) != (v.width, v.height):
            bad.append(v.name)
    return bad


# ---------------------------------------------------------------- 稀疏深度缓冲


def build_depth_buffer(view: PhotoView, pts_world: np.ndarray,
                       cell: int = DEPTH_CELL_PX, dilate: int = DEPTH_DILATE) -> dict:
    """用 SfM 3D 点在该视角的投影建 min-z 深度网格（稀疏深度证据）。"""
    uv, z = view.project(pts_world)
    gw = max(1, math.ceil(view.width / cell))
    gh = max(1, math.ceil(view.height / cell))
    ok = np.isfinite(uv).all(1) & np.isfinite(z) & (z > 0)
    ok &= (uv[:, 0] >= 0) & (uv[:, 0] < view.width) & (uv[:, 1] >= 0) & (uv[:, 1] < view.height)
    depth = np.full(gw * gh, np.inf, np.float32)
    if ok.any():
        ix = np.clip((uv[ok, 0] // cell).astype(np.int64), 0, gw - 1)
        iy = np.clip((uv[ok, 1] // cell).astype(np.int64), 0, gh - 1)
        np.minimum.at(depth, iy * gw + ix, z[ok].astype(np.float32))
    depth = depth.reshape(gh, gw)
    dil = depth.copy()
    for _ in range(int(dilate)):
        pad = np.full((dil.shape[0] + 2, dil.shape[1] + 2), np.inf, np.float32)
        pad[1:-1, 1:-1] = dil
        stack = [pad[1 + dy:1 + dy + dil.shape[0], 1 + dx:1 + dx + dil.shape[1]]
                 for dy in (-1, 0, 1) for dx in (-1, 0, 1)]
        dil = np.minimum.reduce(stack)
    return {"depth": depth, "depth_dilated": dil, "cell": int(cell), "gw": gw, "gh": gh,
            "n_points": int(ok.sum())}


def sample_depth(buf: dict, uv: np.ndarray) -> np.ndarray:
    """按像素坐标取膨胀后的稀疏深度；无证据处为 inf。"""
    cell = buf["cell"]
    ix = np.clip((uv[:, 0] // cell).astype(np.int64), 0, buf["gw"] - 1)
    iy = np.clip((uv[:, 1] // cell).astype(np.int64), 0, buf["gh"] - 1)
    return buf["depth_dilated"][iy, ix]


# ---------------------------------------------------------------- 坐标还原与网格


def _to_world(P_local: np.ndarray, structure: dict) -> np.ndarray:
    up = np.asarray(structure["up_world"], np.float64)
    e1 = np.asarray(structure["frame"]["e1"], np.float64)
    e2 = np.asarray(structure["frame"]["e2"], np.float64)
    origin = np.asarray(structure["origin_world"], np.float64)
    floor_d = float(structure["floor"]["d_along_up"])
    P = np.asarray(P_local, np.float64)
    Pl = (P[:, 0:1] * e1 + P[:, 1:2] * e2 + (P[:, 2:3] + floor_d) * up)
    return Pl + origin


def face_normals(verts: np.ndarray, faces: np.ndarray) -> np.ndarray:
    a = verts[faces[:, 0]]
    b = verts[faces[:, 1]]
    c = verts[faces[:, 2]]
    n = np.cross(b - a, c - a)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


def _bilinear_rgb(img: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    u = np.clip(u, 0, w - 1.001)
    v = np.clip(v, 0, h - 1.001)
    u0 = np.floor(u).astype(np.int64)
    v0 = np.floor(v).astype(np.int64)
    u1 = np.minimum(u0 + 1, w - 1)
    v1 = np.minimum(v0 + 1, h - 1)
    fu = (u - u0)[:, None]
    fv = (v - v0)[:, None]
    src = img.astype(np.float32)
    return (src[v0, u0] * (1 - fu) * (1 - fv) + src[v0, u1] * fu * (1 - fv)
            + src[v1, u0] * (1 - fu) * fv + src[v1, u1] * fu * fv)


def _rasterize(tri_uv_px: np.ndarray, tex_size: int):
    """UV 三角形覆盖的像素中心 (xx, yy) 与其重心坐标 (s, t)。"""
    xmin = max(int(np.floor(tri_uv_px[:, 0].min())), 0)
    xmax = min(int(np.ceil(tri_uv_px[:, 0].max())), tex_size - 1)
    ymin = max(int(np.floor(tri_uv_px[:, 1].min())), 0)
    ymax = min(int(np.ceil(tri_uv_px[:, 1].max())), tex_size - 1)
    if xmax < xmin or ymax < ymin:
        return None
    gx, gy = np.meshgrid(np.arange(xmin, xmax + 1) + 0.5, np.arange(ymin, ymax + 1) + 0.5)
    px = gx.ravel()
    py = gy.ravel()
    v0 = tri_uv_px[1] - tri_uv_px[0]
    v1 = tri_uv_px[2] - tri_uv_px[0]
    den = v0[0] * v1[1] - v1[0] * v0[1]
    if abs(den) < 1e-12:
        return None
    dx = px - tri_uv_px[0, 0]
    dy = py - tri_uv_px[0, 1]
    s = (dx * v1[1] - v1[0] * dy) / den
    t = (v0[0] * dy - dx * v0[1]) / den
    inside = (s >= -1e-4) & (t >= -1e-4) & (s + t <= 1 + 1e-4)
    if not inside.any():
        return None
    return px[inside].astype(np.int64), py[inside].astype(np.int64), s[inside], t[inside]


def _depth_verdict(d: np.ndarray, z: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """深度判据拆两层：`occluded`（明确更近的表面挡在前面）与 `verified`（深度吻合）。

    SfM 点稀疏，`d=inf` 只代表"这里没有深度证据"，不能当作被遮挡；
    反过来 `d << z` 就是硬遮挡证据。闭合曲面用"不匹配即拒绝"会把
    稀疏区整片判死，故按遮挡语义判定，并单独统计 verified 子集。
    """
    tol = np.maximum(DEPTH_TOL_ABS, np.abs(z) * DEPTH_TOL_REL)
    finite = np.isfinite(d)
    occluded = finite & (z > d + tol)
    verified = finite & (np.abs(d - z) <= tol)
    return occluded, verified


def _top_views(views: list, bufs: list, cent_w: np.ndarray, normals: np.ndarray,
               k: int = VIEWS_PER_FACE) -> tuple[np.ndarray, np.ndarray]:
    """逐面在全部视角里找最优 k 个（朝向 + 视锥 + 无遮挡深度证据）。"""
    nF = len(cent_w)
    nV = len(views)
    score = np.zeros((nF, nV), np.float32)
    for vi, view in enumerate(views):
        uv, z = view.project(cent_w)
        inside = (np.isfinite(uv).all(1) & (uv[:, 0] >= 1) & (uv[:, 0] <= view.width - 2)
                  & (uv[:, 1] >= 1) & (uv[:, 1] <= view.height - 2) & (z > 1e-3))
        if not inside.any():
            continue
        dirs = view.center[None, :] - cent_w
        dist = np.linalg.norm(dirs, axis=1)
        facing = np.sum(normals * dirs, 1) / np.maximum(dist, 1e-9)
        ok = inside & (facing > MIN_FACING)
        if not ok.any():
            continue
        idx = np.nonzero(ok)[0]
        d = sample_depth(bufs[vi], uv[idx])
        occluded, verified = _depth_verdict(d, z[idx])
        sub = facing[idx] * (1.0 / (1.0 + z[idx] * 0.3))
        sub = np.where(occluded, 0.0, sub * np.where(verified, 1.0, 0.85))
        score[idx, vi] = sub.astype(np.float32)
    order = np.argsort(-score, axis=1)[:, :k]
    best = np.take_along_axis(score, order, axis=1)
    order = np.where(best > 0, order, -1)
    return order, best


# ---------------------------------------------------------------- 烘焙主流程


def estimate_view_gains(views: list, pts_world: np.ndarray, cache: "_ImageCache",
                        max_points: int = 20000) -> np.ndarray:
    """逐视角增益归一（在重建点投影处取平均色，再归到全场景中位色）。

    不同照片的曝光/白平衡不同，逐面选到不同视角就会在 UV 边界留下亮暗接缝；
    先把这个低频差异压掉，再做逐 texel 混合，接缝才可能降到面内色差量级。
    """
    rng = np.random.default_rng(0)
    idx = np.arange(len(pts_world))
    if idx.size > max_points:
        idx = rng.choice(idx, max_points, replace=False)
    P = np.asarray(pts_world, np.float64)[idx]
    means = np.full((len(views), 3), np.nan)
    for vi, view in enumerate(views):
        uv, z = view.project(P)
        ok = (np.isfinite(uv).all(1) & (uv[:, 0] >= 0) & (uv[:, 0] <= view.width - 1)
              & (uv[:, 1] >= 0) & (uv[:, 1] <= view.height - 1) & (z > 1e-3))
        if not ok.any():
            continue
        try:
            img = cache.get(view)
        except FileNotFoundError:
            continue
        means[vi] = _bilinear_rgb(img, uv[ok, 0], uv[ok, 1]).mean(0)
    med = np.nanmedian(means, axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        gains = np.clip(med[None, :] / np.maximum(means, 1e-3), 0.7, 1.4)
    gains[~np.isfinite(gains)] = 1.0
    return gains.astype(np.float32)


def bake_instance(views: list, bufs: list, cache: _ImageCache, pts_local: np.ndarray,
                  structure: dict, tex_size: int = TEX_SIZE,
                  gains: np.ndarray | None = None) -> dict | None:
    """单实例：xatlas 展开 → 多视角加权采样 → 补洞 → 度量 → npz + png。"""
    import xatlas

    surf = alpha_surface(pts_local)
    if surf is None:
        return None
    V_l = surf["vertices"]
    F = surf["faces"]
    try:
        vmapping, new_faces, uvs = xatlas.parametrize(
            np.ascontiguousarray(V_l, np.float32), np.ascontiguousarray(F, np.uint32))
    except Exception:  # noqa: BLE001 - 退化网格由调用方记 no_surface
        return None
    if len(np.asarray(new_faces)) == 0:
        return None
    V = np.asarray(V_l[vmapping], np.float64)
    F = np.asarray(new_faces, np.int64)
    uvs = np.asarray(uvs, np.float64)
    W = _to_world(V, structure)
    normals = face_normals(W, F)
    cent = W[F].mean(1)

    order, _ = _top_views(views, bufs, cent, normals)

    T = int(tex_size)
    acc = np.zeros((T, T, 3), np.float32)
    wsum = np.zeros((T, T), np.float32)
    covered = np.zeros((T, T), bool)
    face_map = np.full((T, T), -1, np.int32)
    best_w = np.zeros((T, T), np.float32)
    src_view = np.full((T, T), -1, np.int16)
    src_u = np.zeros((T, T), np.float32)
    src_v = np.zeros((T, T), np.float32)
    src_res = np.full((T, T), np.nan, np.float32)
    src_class = np.full((T, T), -1, np.int8)  # 0=深度实证 1=无遮挡但无深度证据

    uv_px = uvs * (T - 1)
    # 逐面先登记 UV 覆盖，保证"没采到"与"UV 外空白"可区分
    rast = []
    for f in range(len(F)):
        r = _rasterize(uv_px[F[f]], T)
        if r is None:
            rast.append(None)
            continue
        xx, yy, s, t = r
        covered[yy, xx] = True
        face_map[yy, xx] = f
        rast.append((xx, yy, s, t))

    # 视角为外层循环：一张原图只加载一次，避免 311 张全驻留
    per_view_faces: dict = {}
    for f in range(len(F)):
        if rast[f] is None:
            continue
        for j in range(order.shape[1]):
            vi = int(order[f, j])
            if vi < 0:
                continue
            per_view_faces.setdefault(vi, []).append(f)

    stats_reject = {"occluded": 0, "no_depth_evidence": 0, "out_of_frame": 0, "samples": 0}
    for vi, flist in per_view_faces.items():
        view = views[vi]
        img = cache.get(view)
        buf = bufs[vi]
        for f in flist:
            xx, yy, s, t = rast[f]
            tri3d = W[F[f]]
            pos = (s[:, None] * tri3d[0] + t[:, None] * tri3d[1]
                   + (1 - s - t)[:, None] * tri3d[2])
            uv, z = view.project(pos)
            inb = (np.isfinite(uv).all(1) & (uv[:, 0] >= 0) & (uv[:, 0] <= view.width - 1)
                   & (uv[:, 1] >= 0) & (uv[:, 1] <= view.height - 1) & (z > 1e-3))
            if not inb.any():
                stats_reject["out_of_frame"] += int(len(inb))
                continue
            d = sample_depth(buf, uv)
            occluded, verified = _depth_verdict(d, z)
            ok = inb & ~occluded
            stats_reject["occluded"] += int((inb & occluded).sum())
            stats_reject["no_depth_evidence"] += int((inb & ~occluded & ~verified).sum())
            if not ok.any():
                continue
            sel = np.nonzero(ok)[0]
            colors = _bilinear_rgb(img, uv[sel, 0], uv[sel, 1])
            if gains is not None:
                colors = colors * gains[vi][None, :]
            wgt = np.float32(1.0 / (1.0 + float(np.mean(z[sel])) * 0.3))
            px, py = xx[sel], yy[sel]
            acc[py, px] += colors * wgt
            wsum[py, px] += wgt
            stats_reject["samples"] += int(len(sel))
            upd = wgt > best_w[py, px]
            if upd.any():
                ux, uy = px[upd], py[upd]
                best_w[uy, ux] = wgt
                src_view[uy, ux] = vi
                src_u[uy, ux] = uv[sel][upd, 0]
                src_v[uy, ux] = uv[sel][upd, 1]
                src_res[uy, ux] = (np.abs(d - z)[sel])[upd]
                src_class[uy, ux] = np.where(verified[sel][upd], 0, 1).astype(np.int8)

    observed = wsum > 0
    tex = np.zeros((T, T, 3), np.uint8)
    with np.errstate(invalid="ignore", divide="ignore"):
        tex[observed] = np.clip(acc[observed] / wsum[observed][:, None], 0, 255).astype(np.uint8)
    tex, inferred_local, fill_stats = M.fill_unobserved(tex, observed, covered)
    tex, inferred_flat, flat_stats = M.fill_flat(tex, observed | inferred_local, covered)
    inferred = inferred_local | inferred_flat

    # 接缝按**网格共边**量；atlas 相邻像素在 xatlas 下与 3D 邻接无关，
    # 拿它算接缝会把"物体两端"的固有色差算进来
    seam_before = M.seam_metrics_mesh(tex, observed, face_map, F, uv_px)
    sharp_before = M.sharpness(tex, observed)
    # 相邻两块面若来自不同照片，曝光/白平衡差会沿共边跳变；逐面解一个
    # RGB 常数偏移把共边拉平（只动低频，不动织纹木纹的高频结构）
    tex, seam_delta, seam_level = M.level_seams(tex, observed, covered, face_map, F, uv_px)
    seam = M.seam_metrics_mesh(tex, observed, face_map, F, uv_px)
    seam_atlas = M.seam_metrics(tex, np.where(observed, face_map, -1), observed)
    stretch = M.stretch_metrics(uv_px, F, W)
    cov = M.coverage_report(covered, observed, inferred, inferred_local, inferred_flat)
    fobs = M.face_observation(face_map, observed)
    sharp = M.sharpness(tex, observed)

    # 逐 texel 来源统计（按视角）
    sources = []
    if observed.any():
        counts = np.bincount(src_view[observed].astype(np.int64), minlength=len(views))
        for vi in np.argsort(-counts)[:8]:
            if counts[vi] == 0:
                continue
            sources.append({"image": views[int(vi)].name, "n_texels": int(counts[vi])})

    # 逐面主视角（可回查"这一面贴的是哪张照片"）
    face_view = np.full(len(F), -1, np.int16)
    fv = src_view.copy()
    for f in range(len(F)):
        r = rast[f]
        if r is None:
            continue
        vv = fv[r[1], r[0]]
        vv = vv[vv >= 0]
        if vv.size:
            face_view[f] = np.bincount(vv).argmax()

    # 采样密度比：贴图 texel/nu ÷ 源像素/nu。<=1 表示没有上采样（细节未丢失）
    ratios = []
    for f in range(len(F)):
        vi = int(face_view[f])
        if vi < 0:
            continue
        depth = float(np.mean(np.linalg.norm(views[vi].center[None, :] - W[F[f]].mean(0))))
        src_density = views[vi].pixels_per_nu(depth)
        tri = uv_px[F[f]]
        uv_a = 0.5 * abs((tri[1, 0] - tri[0, 0]) * (tri[2, 1] - tri[0, 1])
                         - (tri[2, 0] - tri[0, 0]) * (tri[1, 1] - tri[0, 1]))
        n3 = np.cross(W[F[f]][1] - W[F[f]][0], W[F[f]][2] - W[F[f]][0])
        a3 = 0.5 * float(np.linalg.norm(n3))
        if a3 > 1e-12 and src_density > 1e-9:
            ratios.append(math.sqrt(uv_a / a3) / src_density)
    dense = {
        "sampling_ratio_p50": round(float(np.percentile(ratios, 50)), 4) if ratios else None,
        "sampling_ratio_p90": round(float(np.percentile(ratios, 90)), 4) if ratios else None,
        "meaning": "texel-per-nu ÷ source-pixel-per-nu；<=1 表示贴图未上采样，细节未被放大重建",
        "n_faces_measured": len(ratios),
    }

    n_verified = int(((src_class == 0) & observed).sum())
    n_unconfirmed = int(((src_class == 1) & observed).sum())
    depth_stats = {
        "n_verified_texels": n_verified,
        "n_unconfirmed_texels": n_unconfirmed,
        "verified_ratio_of_observed": round(n_verified / max(n_verified + n_unconfirmed, 1), 6),
        "rule": "occluded := d<z-tol 拒绝；verified := |d-z|<=tol；d=inf 视为无证据、可采样但单独计数",
    }
    return {
        "tex_size": T,
        "texture": tex,
        "observed": observed,
        "inferred": inferred,
        "covered": covered,
        "face_map": face_map,
        "src_view": src_view,
        "src_u": src_u,
        "src_v": src_v,
        "src_res": src_res,
        "src_class": src_class,
        "depth": depth_stats,
        "uvs": uvs,
        "verts_world": W,
        "verts_local": V,
        "faces": F,
        "seam": seam,
        "seam_before_leveling": seam_before,
        "seam_leveling": seam_level,
        "seam_atlas_neighbors": seam_atlas,
        "stretch": stretch,
        "coverage": cov,
        "face_observation": fobs,
        "sharpness": sharp,
        "sharpness_before_leveling": sharp_before,
        "fill": fill_stats,
        "fill_flat": flat_stats,
        "sources": sources,
        "face_view": face_view,
        "density": dense,
        "rejects": stats_reject,
        "uv_px": uv_px,
    }


def _png_bytes(rgb: np.ndarray) -> bytes:
    import cv2

    ok, buf = cv2.imencode(".png", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
    if not ok:
        raise RuntimeError("PNG 编码失败")
    return buf.tobytes()


def write_scene_glb(path: Path, items: list, name: str = "miniverse-miniature") -> dict:
    """多实例、每实例独立材质与内嵌 PNG 的 GLB（自写，避免第三方默认值倍乘贴图）。"""
    blob = bytearray()
    views = []

    def add(data: bytes) -> int:
        while len(blob) % 4:
            blob.append(0)
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)})
        blob.extend(data)
        return len(views) - 1

    accessors, meshes, nodes, materials, textures, images = [], [], [], [], [], []
    layers = []
    for it in items:
        verts = np.ascontiguousarray(it["verts"].astype(np.float32))
        uvs = np.ascontiguousarray(it["uvs"].astype(np.float32))
        faces = np.ascontiguousarray(it["faces"].astype(np.uint32).ravel())
        png = it["png"]
        bv_p = add(verts.tobytes())
        bv_uv = add(uvs.tobytes())
        bv_i = add(faces.tobytes())
        bv_img = add(png)
        a_p = len(accessors)
        accessors.append({"bufferView": bv_p, "componentType": 5126, "count": int(len(verts)),
                          "type": "VEC3", "min": verts.min(0).tolist(), "max": verts.max(0).tolist()})
        a_uv = len(accessors)
        accessors.append({"bufferView": bv_uv, "componentType": 5126, "count": int(len(uvs)),
                          "type": "VEC2", "min": uvs.min(0).tolist(), "max": uvs.max(0).tolist()})
        a_i = len(accessors)
        accessors.append({"bufferView": bv_i, "componentType": 5125, "count": int(len(faces)),
                          "type": "SCALAR"})
        img_idx = len(images)
        images.append({"bufferView": bv_img, "mimeType": "image/png",
                       "name": f"{it['id']}-texture"})
        tex_idx = len(textures)
        textures.append({"source": img_idx, "sampler": 0})
        mat_idx = len(materials)
        materials.append({
            "name": f"{it['id']}-photo",
            "pbrMetallicRoughness": {
                "baseColorTexture": {"index": tex_idx},
                "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
                "metallicFactor": 0.0,
                "roughnessFactor": 1.0,
            },
            "doubleSided": True,
            "extras": {"instanceId": it["id"], "textureSource": "original_photos"},
        })
        prim = {
            "attributes": {"POSITION": a_p, "TEXCOORD_0": a_uv},
            "indices": a_i, "mode": 4, "material": mat_idx,
        }
        # 每个实例必须是独立的 mesh：glTF 里 node.mesh 是 meshes 的下标，
        # 之前所有 primitive 塞进 meshes[0]、而 node 依次引用 0..N-1，
        # 导致 1..N-1 越界（trimesh 容忍，three.js 直接抛 "reading 'primitives'"）。
        meshes.append({"name": f"{name}-{it['id']}", "primitives": [prim]})
        nodes.append({"mesh": len(meshes) - 1, "name": it["id"]})
        layers.append({"id": it["id"], "texture": f"{it['id']}-texture.png"})

    js = {
        "asset": {"version": "2.0", "generator": "MiniVerse-M1 miniature/texture (photos)"},
        "scene": 0,
        "scenes": [{"nodes": list(range(len(nodes)))}],
        "nodes": nodes,
        "meshes": meshes,
        "materials": materials,
        "textures": textures,
        "images": images,
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(blob)}],
    }
    json_bytes = json.dumps(js, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    while len(json_bytes) % 4:
        json_bytes += b" "
    bin_bytes = bytes(blob)
    while len(bin_bytes) % 4:
        bin_bytes += b"\x00"

    total = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
    out = bytearray()
    out += b"glTF" + np.uint32(2).tobytes() + np.uint32(total).tobytes()
    out += np.uint32(len(json_bytes)).tobytes() + b"JSON" + json_bytes
    out += np.uint32(len(bin_bytes)).tobytes() + b"BIN\x00" + bin_bytes
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(bytes(out))
    return {"path": str(path), "bytes": len(out), "n_nodes": len(nodes),
            "n_images": len(images), "n_materials": len(materials),
            "sha256": C.sha256_file(path), "layers": layers}


def build_texture(scene_path, structure: dict, instances_doc: dict,
                  out_dir=None, tex_size: int = TEX_SIZE, export_glb: bool = True) -> dict:
    scene = Path(scene_path)
    diags: list = []
    insts = instances_doc.get("instances") or []
    views, vdiags, vstats = load_photo_views(scene)
    diags.extend(vdiags)
    if not views:
        return {"schema": SCHEMA, "status": "unsupported", "diagnostics": diags,
                "photo_source": vstats, "instances": []}
    if not insts:
        return {"schema": SCHEMA, "status": "unsupported", "diagnostics": diags,
                "photo_source": vstats, "instances": []}

    # 尺寸自检：不做就可能在投影端整体错位，且错得很"像对的"
    bad = verify_image_sizes(views)
    if bad:
        diags.append(_diag("IMAGE_SIZE_MISMATCH", "error",
                           "照片分辨率与 cameras.bin 不一致，已剔除这些视角",
                           measured={"files": bad[:10], "n": len(bad)}))
        views = [v for v in views if v.name not in set(bad)]
    if not views:
        return {"schema": SCHEMA, "status": "unsupported", "diagnostics": diags,
                "photo_source": vstats, "instances": []}

    pts = read_points3d_bin(_find_colmap(scene) / "points3D.bin")["xyz"]
    pts = pts[np.isfinite(pts).all(1)]
    bufs = [build_depth_buffer(v, pts) for v in views]
    cache = _ImageCache()
    gains = estimate_view_gains(views, pts, cache)
    gain_stats = {
        "n_views": int(len(views)),
        "mean": [round(float(v), 4) for v in gains.mean(0)],
        "min": [round(float(v), 4) for v in gains.min(0)],
        "max": [round(float(v), 4) for v in gains.max(0)],
        "rule": "按投影点处平均色归到全场景中位色，clip 到 [0.7,1.4]；用于压低调色/曝光差不造成的跨视角接缝",
    }

    sets = _instance_point_sets(scene, structure, insts)
    if sets is None:
        return {"schema": SCHEMA, "status": "unsupported", "diagnostics": diags,
                "photo_source": vstats, "instances": []}

    out = Path(out_dir) if out_dir is not None else None
    rows, glb_items = [], []
    n_no_surface = 0
    for inst in insts:
        P, _ = sets.get(inst["id"], (np.zeros((0, 3)), np.zeros(0, dtype=np.int64)))
        res = bake_instance(views, bufs, cache, P, structure, tex_size=tex_size, gains=gains)
        if res is None:
            n_no_surface += 1
            rows.append({"id": inst["id"], "status": "no_surface",
                         "n_input_points": int(len(P)),
                         "reason": "点数不足以三角化（与 069 判据一致）"})
            continue
        if out is not None:
            tdir = out / "texture"
            tdir.mkdir(parents=True, exist_ok=True)
            png = _png_bytes(res["texture"])
            (tdir / f"{inst['id']}.png").write_bytes(png)
            np.savez_compressed(
                tdir / f"{inst['id']}-trace.npz",
                src_view=res["src_view"].astype(np.int16),
                src_u=np.round(np.where(res["src_u"] >= 0, res["src_u"], 0)).astype(np.uint16),
                src_v=np.round(np.where(res["src_v"] >= 0, res["src_v"], 0)).astype(np.uint16),
                src_residual=np.clip(np.nan_to_num(res["src_res"], nan=-1.0, posinf=1e3),
                                     -1.0, 1e3).astype(np.float16),
                src_class=res["src_class"].astype(np.int8),
                face_map=res["face_map"].astype(np.int32),
                face_view=res["face_view"].astype(np.int16),
                uv_px=res["uv_px"].astype(np.float32),
                observed=res["observed"],
                inferred=res["inferred"],
                covered=res["covered"],
                tex_size=np.int32(res["tex_size"]),
                image_names=np.asarray([v.name for v in views], dtype="U256"),
            )
            glb_items.append({"id": inst["id"], "verts": res["verts_local"],
                              "uvs": res["uvs"], "faces": res["faces"], "png": png})
        row = {
            "id": inst["id"],
            "status": "ok",
            "tex_size": res["tex_size"],
            "n_vertices": int(len(res["verts_local"])),
            "n_faces": int(len(res["faces"])),
            "coverage": res["coverage"],
            "depth": res["depth"],
            "seam": res["seam"],
            "seam_before_leveling": res["seam_before_leveling"],
            "seam_leveling": res["seam_leveling"],
            "seam_atlas_neighbors": res["seam_atlas_neighbors"],
            "stretch": res["stretch"],
            "face_observation": res["face_observation"],
            "sharpness": res["sharpness"],
            "sharpness_before_leveling": res["sharpness_before_leveling"],
            "fill": res["fill"],
            "fill_flat": res["fill_flat"],
            "sampling_density": res["density"],
            "sources": res["sources"],
            "rejects": res["rejects"],
            "traces": {
                "npz": f"texture/{inst['id']}-trace.npz",
                "fields": "src_view/src_u/src_v/src_residual 逐 texel；face_view 逐面主视角",
            } if out is not None else None,
        }
        rows.append(row)

    scene_glb = None
    if export_glb and out is not None and glb_items:
        # 按场景分目录：多场景共用同一个 out 时，固定文件名会互相覆盖，
        # 导致后跑的场次把前面的 GLB 顶掉（校验时读到同一个字节数）。
        # 用场景目录名（uuid / 数据集名），不能用 parent.name——多个场景同在
        # data/processed/ 下会撞成同一个 "processed"。
        scene_tag = Path(scene_path).name or "scene"
        scene_glb = write_scene_glb(out / "glb" / scene_tag / "scene.glb", glb_items,
                                    name=f"miniverse-miniature-{scene_tag}")

    # 接缝电平化的场景级汇总：按共边条数加权，前后各取一次，避免只报"改好了"
    lm = [r for r in rows if r["status"] == "ok" and r["seam"].get("n_cross_edges")]

    def _wavg(src: str, key: str):
        num = sum(float(r[src].get(key) or 0) * r[src]["n_cross_edges"] for r in lm)
        den = sum(r[src]["n_cross_edges"] for r in lm)
        return round(num / den, 4) if den else None

    def _retention(r):
        a = (r["sharpness"] or {}).get("laplacian_var")
        b = (r["sharpness_before_leveling"] or {}).get("laplacian_var")
        return (a / b) if a and b else None

    ret = [x for x in (_retention(r) for r in lm) if x is not None]
    checks = {
        "no_surface": [r["id"] for r in rows if r["status"] != "ok"],
        "faces_fully_inferred": {r["id"]: r["face_observation"]["n_faces_fully_inferred"]
                                 for r in rows if r["status"] == "ok"
                                 and r["face_observation"]["n_faces_fully_inferred"] > 0},
        "stretched_faces": {r["id"]: r["stretch"]["n_stretched"] for r in rows
                            if r["status"] == "ok" and r["stretch"]["n_stretched"] > 0},
        "high_seam_instances": {r["id"]: r["seam"]["high_seam_edges"] for r in rows
                                if r["status"] == "ok" and (r["seam"]["high_seam_edges"] or 0) > 0},
        "seam_leveling": {
            "cross_mean_before": _wavg("seam_before_leveling", "cross_mean"),
            "cross_mean_after": _wavg("seam", "cross_mean"),
            "ratio_before": _wavg("seam_before_leveling", "ratio_cross_over_within"),
            "ratio_after": _wavg("seam", "ratio_cross_over_within"),
            "high_edges_before": int(sum(r["seam_before_leveling"]["high_seam_edges"] for r in lm)),
            "high_edges_after": int(sum(r["seam"]["high_seam_edges"] for r in lm)),
            "n_instances_cross_mean_improved": int(sum(
                1 for r in lm
                if (r["seam"]["cross_mean"] or 0) < (r["seam_before_leveling"]["cross_mean"] or 0))),
            "n_instances_measured": len(lm),
            "sharpness_retention_p50": round(float(np.percentile(ret, 50)), 4) if ret else None,
            "sharpness_retention_min": round(float(min(ret)), 4) if ret else None,
            "note": "retention = 电平化后/前 的观测区拉普拉斯方差；≈1 说明高频纹理结构未被平滑掉",
        },
    }
    if checks["no_surface"]:
        diags.append(_diag(C.D_UNSUPPORTED_ROOM, "warn",
                           f"{len(checks['no_surface'])} 个实例无几何，未生成贴图",
                           measured={"ids": checks["no_surface"]}))

    ok_rows = [r for r in rows if r["status"] == "ok"]
    status = "ok" if ok_rows else "unsupported"
    if any(d["severity"] == "error" for d in diags):
        status = "degraded" if ok_rows else "unsupported"

    return {
        "schema": SCHEMA,
        "status": status,
        "bake_input": "original_photos",
        "undistortion": "projection_side_brown_conrady (原图不重采样)",
        "photo_source": {**vstats, "n_views_used": len(views)},
        "photo_gains": gain_stats,
        "diagnostics": diags,
        "instances": rows,
        "scene_glb": scene_glb,
        "checks": checks,
        "notes": [
            "贴图只从 images/ 原图采样；渲染图/2DGS 视图不参与烘焙（避免校色黄绿斑）",
            "观测 texel 必须同时满足：视锥内、朝向余弦>阈值、与 SfM 稀疏深度一致；任一不满足不给颜色",
            "补洞半径固定 3 轮，超出半径的洞保持未填，不用大半径把邻近颜色拖过来",
            "coverage 里 observed 与 inferred 分开计数，不提供把两者相加的'总填满率'",
        ],
    }
