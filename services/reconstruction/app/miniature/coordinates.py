"""坐标、尺度与相机口径契约（T-700067）。

三套坐标必须分开记录，不靠"猜"：

1. **raw（COLMAP 世界）**：SfM 直接输出的右手系，原点任意、尺度任意（unit=nu）。
2. **local（房间局部 Y-up）**：`local = R·(p - origin)`，其中 R 的行是 `[e1, e2, up]`。
   房间的"两墙一地"、面积、家具包围盒全部在 local 里表达。
3. **显示（Y-up 米制）**：只有拿到米制标定时才允许换算；未标定一律保持 nu。

本模块只做"记录 + 校验"，不做任何隐式修正：发现口径不一致就返回诊断码，
由调用方决定 degraded / unsupported，不静默改坐标系。
"""
from __future__ import annotations

import numpy as np

from . import contracts as C

SCHEMA = "miniature.coordinates.v1"

# COLMAP camera model_id → (名称, 参数个数, 畸变口径)
# 参数个数与 sfm_io.read_cameras_bin 的映射一致，两处必须同步。
CAMERA_MODELS = {
    0: ("SIMPLE_PINHOLE", 3, "none"),
    1: ("PINHOLE", 4, "none"),
    2: ("SIMPLE_RADIAL", 4, "radial"),
    3: ("RADIAL", 5, "radial"),
    4: ("OPENCV", 8, "opencv"),
    5: ("OPENCV_FISHEYE", 8, "fisheye"),
    6: ("FULL_OPENCV", 12, "opencv"),
    7: ("FOV", 5, "fov"),
    8: ("SIMPLE_RADIAL_FISHEYE", 4, "fisheye"),
    9: ("RADIAL_FISHEYE", 5, "fisheye"),
    10: ("THIN_PRISM_FISHEYE", 12, "fisheye"),
}

# 正交性容差：相机 up 投票 + 叉乘构造理论上是精确正交，只容忍浮点误差。
ORTHO_TOL = 1e-6


def _diag(code: str, severity: str, message: str, measured=None, threshold=None) -> dict:
    return {
        "code": code,
        "severity": severity,
        "message": message,
        "measured": measured or {},
        "threshold": threshold or {},
    }


def build_frame(up, e1, e2, origin, origin_source: str = "floor_plane_corner") -> dict:
    """构造 world→local 的显式变换记录。

    同时给出向量形式和 4x4 矩阵（行主序），两者必须等价：
    `local = M[:3,:3] @ world + M[:3,3]`。
    """
    up = np.asarray(up, dtype=np.float64)
    e1 = np.asarray(e1, dtype=np.float64)
    e2 = np.asarray(e2, dtype=np.float64)
    origin = np.asarray(origin, dtype=np.float64)
    R = np.stack([e1, e2, up], axis=0)  # 行 = 局部轴
    M = np.eye(4, dtype=np.float64)
    M[:3, :3] = R
    M[:3, 3] = -R @ origin
    return {
        "schema": SCHEMA,
        "raw_world": "colmap_world_right_handed_unscaled",
        "local_axes": {"e1": e1.tolist(), "e2": e2.tolist(), "up": up.tolist()},
        "origin_world": origin.tolist(),
        "origin_source": origin_source,
        "world_to_local": [[round(float(v), 12) for v in row] for row in M],
        "local_to_world": [[round(float(v), 12) for v in row] for row in np.linalg.inv(M)],
        # 尺度默认来自 SfM：unit=nu 且没有米制换算。要改成米制必须由调用方显式覆盖，
        # 不能从 build_frame 顺手推断出来。
        "scale": {"unit": "nu", "meters_per_unit": None, "source": "unmetric_sfm"},
    }


def world_to_local(points, frame: dict) -> np.ndarray:
    M = np.asarray(frame["world_to_local"], dtype=np.float64)
    P = np.asarray(points, dtype=np.float64)
    return P @ M[:3, :3].T + M[:3, 3]


def local_to_world(points, frame: dict) -> np.ndarray:
    M = np.asarray(frame["local_to_world"], dtype=np.float64)
    P = np.asarray(points, dtype=np.float64)
    return P @ M[:3, :3].T + M[:3, 3]


def from_structure(structure: dict) -> dict:
    """从 structure 产物提取坐标契约（structure 已推断出 up / 基 / 原点）。"""
    up = structure["up_world"]
    e1 = structure["frame"]["e1"]
    e2 = structure["frame"]["e2"]
    origin = structure["origin_world"]
    fr = build_frame(up, e1, e2, origin, origin_source="floor_plane_corner")
    fr["up_source"] = structure.get("up_source", "unknown")
    fr["scale"] = {
        "unit": "nu",
        "meters_per_unit": None,
        "source": "unmetric_sfm",
        "note": "SfM 无米制基准；nu 是房间跨度归一化单位，不得当作米",
    }
    return fr


def check_frame(frame: dict) -> list:
    """坐标系一致性检查：正交、单位长度、矩阵与向量等价、尺度口径完整。"""
    diags: list = []
    axes = frame["local_axes"]
    up = np.asarray(axes["up"], dtype=np.float64)
    e1 = np.asarray(axes["e1"], dtype=np.float64)
    e2 = np.asarray(axes["e2"], dtype=np.float64)
    dots = {
        "up.e1": float(abs(up @ e1)),
        "up.e2": float(abs(up @ e2)),
        "e1.e2": float(abs(e1 @ e2)),
    }
    worst = max(dots.values())
    if worst > ORTHO_TOL:
        diags.append(
            _diag(
                C.D_SCALE_INCONSISTENT,
                "error",
                "局部坐标轴不正交，两墙一地的平面约束不成立",
                measured={"dot": {k: round(v, 9) for k, v in dots.items()}},
                threshold={"ortho_tol": ORTHO_TOL},
            )
        )
    norms = {"up": float(np.linalg.norm(up)), "e1": float(np.linalg.norm(e1)), "e2": float(np.linalg.norm(e2))}
    bad_norm = {k: round(v, 9) for k, v in norms.items() if abs(v - 1.0) > 1e-6}
    if bad_norm:
        diags.append(
            _diag(
                C.D_SCALE_INCONSISTENT,
                "error",
                "局部坐标轴未归一化，local 位移会被隐式缩放",
                measured={"norms": bad_norm},
                threshold={"tol": 1e-6},
            )
        )
    # 矩阵 ↔ 向量等价：变换原点应得到 local 零点
    got = world_to_local(np.asarray(frame["origin_world"], dtype=np.float64)[None, :], frame)[0]
    if float(np.linalg.norm(got)) > 1e-6:
        diags.append(
            _diag(
                C.D_SCALE_INCONSISTENT,
                "error",
                "world_to_local 矩阵与 origin/轴向量不一致",
                measured={"origin_in_local": [round(float(v), 9) for v in got]},
                threshold={"tol": 1e-6},
            )
        )
    scale = frame.get("scale") or {}
    if scale.get("unit") == "nu" and scale.get("meters_per_unit") is not None:
        diags.append(
            _diag(
                C.D_SCALE_INCONSISTENT,
                "error",
                "unit=nu 却声明了米制换算，尺度口径自相矛盾",
                measured={"meters_per_unit": scale.get("meters_per_unit")},
            )
        )
    if not scale.get("source"):
        diags.append(
            _diag(
                C.D_SCALE_INCONSISTENT,
                "warn",
                "缺少尺度来源标注，无法判断 nu 是否可用作米制",
                measured={"scale": scale},
            )
        )
    return diags


def check_intrinsics(cams: dict, undistorted: bool | None = None) -> list:
    """相机内参口径检查。

    undistorted=None 表示"未知"——只要存在畸变模型就报 warn，绝不假设已去畸变。
    """
    diags: list = []
    dist_models: dict = {}
    unknown_models = []
    for cam in (cams or {}).values():
        mid = int(cam.get("model_id", -1))
        name, npar, kind = CAMERA_MODELS.get(mid, (f"UNKNOWN_{mid}", -1, "unknown"))
        npar_got = len(cam.get("params") or [])
        if kind == "unknown":
            unknown_models.append({str(mid): npar_got})
        elif npar_got != npar:
            diags.append(
                _diag(
                    C.D_SCALE_INCONSISTENT,
                    "error",
                    f"相机模型 {name} 参数个数不符（读到 {npar_got}，应为 {npar}）",
                    measured={"model_id": mid, "n_got": npar_got},
                    threshold={"n_expected": npar},
                )
            )
        if kind != "none":
            dist_models[name] = dist_models.get(name, 0) + 1
    if unknown_models:
        diags.append(
            _diag(
                C.D_SCALE_INCONSISTENT,
                "error",
                "遇到未知 COLMAP 相机模型，无法确定投影口径",
                measured={"unknown": unknown_models[:8]},
            )
        )
    if dist_models and undistorted is not True:
        sev = "warn" if undistorted is None else "error"
        diags.append(
            _diag(
                C.D_DISTORTION_NOT_UNDISTORTED,
                sev,
                "存在带畸变的相机模型但图像未声明已去畸变；直接用针孔投影会有边缘错位",
                measured={"models": dist_models, "undistorted": undistorted},
            )
        )
    return diags


def as_diagnostics(items: list) -> list:
    """把本模块的 dict 诊断转成 contracts.Diagnostic，便于与清单诊断合并排序。"""
    out = []
    for d in items:
        out.append(
            C.Diagnostic(
                d["code"],
                d["severity"],
                d["message"],
                measured=d.get("measured") or {},
                threshold=d.get("threshold") or {},
            )
        )
    return out
