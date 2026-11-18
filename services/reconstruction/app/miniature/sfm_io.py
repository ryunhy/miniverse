"""COLMAP 二进制只读解析（无 pycolmap 依赖）。

只解析本管线需要的字段；任何解析失败抛 ColmapError，由上游转成诊断码，不静默降级。
"""
from __future__ import annotations

import struct
from pathlib import Path

import numpy as np


class ColmapError(RuntimeError):
    pass


def qvec2rotmat(q: np.ndarray) -> np.ndarray:
    w, x, y, z = [float(v) for v in q]
    return np.array(
        [
            [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * z * w, 2 * x * z + 2 * y * w],
            [2 * x * y + 2 * z * w, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * x * w],
            [2 * x * z - 2 * y * w, 2 * y * z + 2 * x * w, 1 - 2 * x * x - 2 * y * y],
        ],
        dtype=np.float64,
    )


def _read_cstr(f) -> str:
    out = bytearray()
    while True:
        c = f.read(1)
        if not c:
            raise ColmapError("unexpected EOF in string")
        if c == b"\x00":
            break
        out += c
    return out.decode("utf-8", "replace")


def read_cameras_bin(path: Path) -> dict:
    cams = {}
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        for _ in range(n):
            cid = struct.unpack("<I", f.read(4))[0]
            model_id = struct.unpack("<i", f.read(4))[0]
            width, height = struct.unpack("<QQ", f.read(16))
            nparams = {0: 3, 1: 4, 2: 4, 3: 5, 4: 8, 5: 8, 6: 12, 7: 5, 8: 4, 9: 5, 10: 12}.get(model_id)
            if nparams is None:
                raise ColmapError(f"unknown camera model id {model_id}")
            params = struct.unpack("<%dd" % nparams, f.read(8 * nparams))
            cams[cid] = {
                "camera_id": cid,
                "model_id": model_id,
                "width": int(width),
                "height": int(height),
                "params": list(params),
            }
    return cams


def read_images_bin(path: Path) -> list:
    """返回 [{id, qvec, tvec, camera_id, name, center, forward}]，center 为世界坐标相机中心。"""
    out = []
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        for _ in range(n):
            image_id = struct.unpack("<I", f.read(4))[0]
            q = np.frombuffer(f.read(32), dtype=np.float64)
            t = np.frombuffer(f.read(24), dtype=np.float64)
            camera_id = struct.unpack("<I", f.read(4))[0]
            name = _read_cstr(f)
            n2d = struct.unpack("<Q", f.read(8))[0]
            f.seek(24 * n2d, 1)
            R = qvec2rotmat(q)
            center = -R.T @ t
            out.append(
                {
                    "id": image_id,
                    "qvec": [float(v) for v in q],
                    "tvec": [float(v) for v in t],
                    "camera_id": camera_id,
                    "name": name,
                    "center": [float(v) for v in center],
                    "forward": [float(v) for v in R.T @ np.array([0.0, 0.0, 1.0])],
                }
            )
    return out


def read_points3d_bin(path: Path, with_tracks: bool = False) -> dict:
    """with_tracks=True 时额外返回 track_image_ids（每个点被哪些图像观测到）。

    用于"视角子集"回归：只保留 track 与选定相机集合有交集的点，等价于用子集视角重建
    能得到的那部分点云（不重跑 SfM 的近似，已在报告里标注）。
    """
    n = 0
    xyz = []
    rgb = []
    err = []
    tracks = []
    track_ids = []
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        for _ in range(n):
            f.read(8)  # point3D_id
            xyz.append(struct.unpack("<3d", f.read(24)))
            rgb.append(struct.unpack("<3B", f.read(3)))
            err.append(struct.unpack("<d", f.read(8))[0])
            tl = struct.unpack("<Q", f.read(8))[0]
            tracks.append(tl)
            if with_tracks:
                arr = np.frombuffer(f.read(8 * tl), dtype=np.uint32).reshape(-1, 2)
                track_ids.append(arr[:, 0].astype(np.int64))
            else:
                f.seek(8 * tl, 1)
    out = {
        "n": n,
        "xyz": np.asarray(xyz, dtype=np.float64).reshape(-1, 3),
        "rgb": np.asarray(rgb, dtype=np.uint8).reshape(-1, 3),
        "error": np.asarray(err, dtype=np.float64),
        "track_len": np.asarray(tracks, dtype=np.int64),
    }
    if with_tracks:
        out["track_image_ids"] = track_ids
    return out
