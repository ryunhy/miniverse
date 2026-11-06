"""COLMAP 二进制解析（只读工具，M1 使用）。

只依赖 struct/numpy，不引入新依赖。
"""
from __future__ import annotations

import hashlib
import struct
from pathlib import Path

import numpy as np

COLMAP_MODELS = {
    0: ("SIMPLE_PINHOLE", 3),
    1: ("PINHOLE", 4),
    2: ("SIMPLE_RADIAL", 4),
    3: ("RADIAL", 5),
    4: ("OPENCV", 8),
    5: ("OPENCV_FISHEYE", 8),
}


def sha256_of(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as fh:
        while True:
            buf = fh.read(chunk)
            if not buf:
                break
            h.update(buf)
    return h.hexdigest()


def parse_cameras_bin(path: Path) -> list[dict]:
    raw = Path(path).read_bytes()
    off = 0
    (n_cam,) = struct.unpack_from("<Q", raw, off)
    off += 8
    cams = []
    for _ in range(n_cam):
        cam_id, model_id = struct.unpack_from("<II", raw, off)
        off += 8
        width, height = struct.unpack_from("<QQ", raw, off)
        off += 16
        name, n_params = COLMAP_MODELS[model_id]
        params = struct.unpack_from("<" + "d" * n_params, raw, off)
        off += 8 * n_params
        cams.append({
            "camera_id": cam_id, "model": name, "model_id": model_id,
            "width": width, "height": height, "params": list(params),
        })
    return cams


def quat_wxyz_to_rotmat(q: np.ndarray) -> np.ndarray:
    w, x, y, z = q
    return np.array([
        [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * w * z, 2 * x * z + 2 * w * y],
        [2 * x * y + 2 * w * z, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * w * x],
        [2 * x * z - 2 * w * y, 2 * y * z + 2 * w * x, 1 - 2 * x * x - 2 * y * y],
    ], dtype=np.float64)


def parse_images_bin(path: Path) -> list[dict]:
    """返回 COLMAP 记录的 world→camera（OpenCV：x右 y下 z前）。"""
    raw = Path(path).read_bytes()
    off = 0
    (n_img,) = struct.unpack_from("<Q", raw, off)
    off += 8
    out = []
    for _ in range(n_img):
        img_id, qw, qx, qy, qz, tx, ty, tz, cam_id = struct.unpack_from("<I7dI", raw, off)
        off += 4 + 56 + 4
        end = raw.index(b"\x00", off)
        name = raw[off:end].decode("utf-8")
        off = end + 1
        (n2d,) = struct.unpack_from("<Q", raw, off)
        off += 8 + n2d * 24
        R_wc = quat_wxyz_to_rotmat(np.array([qw, qx, qy, qz]))
        t_wc = np.array([tx, ty, tz], dtype=np.float64)
        R_c2w = R_wc.T
        center = -R_c2w @ t_wc
        out.append({
            "image_id": img_id, "name": name, "camera_id": cam_id,
            "R_wc": R_wc, "t_wc": t_wc, "R_c2w": R_c2w, "center": center,
            "num_points2d": n2d,
        })
    return out


def parse_points3d(path: Path) -> dict:
    raw = Path(path).read_bytes()
    off = 0
    (n_pts,) = struct.unpack_from("<Q", raw, off)
    off += 8
    xyz = np.zeros((n_pts, 3), np.float64)
    rgb = np.zeros((n_pts, 3), np.uint8)
    err = np.zeros(n_pts, np.float64)
    track = np.zeros(n_pts, np.int32)
    for i in range(n_pts):
        off += 8
        xyz[i] = struct.unpack_from("<3d", raw, off)
        off += 24
        rgb[i] = struct.unpack_from("<3B", raw, off)
        off += 3
        err[i] = struct.unpack_from("<d", raw, off)[0]
        off += 8
        (n,) = struct.unpack_from("<Q", raw, off)
        off += 8 + n * 8
        track[i] = n
    return {"xyz": xyz, "rgb": rgb, "error": err, "track_len": track}
