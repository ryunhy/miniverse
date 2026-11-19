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


def read_images_bin(path: Path, with_points2d: bool = False) -> list:
    """返回 [{id, qvec, tvec, camera_id, name, center, forward}]，center 为世界坐标相机中心。

    with_points2d=True 时额外返回 points2d_xy（N×2）与 points2d_point3d_ids（N，uint64），
    供子模型合并保留完整 2D 观测；默认行为与旧版完全一致。
    """
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
            raw2d = f.read(24 * n2d)
            R = qvec2rotmat(q)
            center = -R.T @ t
            rec = {
                "id": image_id,
                "qvec": [float(v) for v in q],
                "tvec": [float(v) for v in t],
                "camera_id": camera_id,
                "name": name,
                "center": [float(v) for v in center],
                "forward": [float(v) for v in R.T @ np.array([0.0, 0.0, 1.0])],
            }
            if with_points2d:
                if n2d:
                    # 第三字段是 uint64 位模式（point3D_id），必须按结构化 dtype 读，
                    # 不能当 float64 读再转整数（位模式会被解释成非规格化浮点）。
                    dt = np.dtype([("x", "<f8"), ("y", "<f8"), ("pid", "<u8")])
                    arr = np.frombuffer(raw2d, dtype=dt)
                    rec["points2d_xy"] = np.column_stack([arr["x"], arr["y"]])
                    rec["points2d_point3d_ids"] = arr["pid"].copy()
                else:
                    rec["points2d_xy"] = np.zeros((0, 2), dtype=np.float64)
                    rec["points2d_point3d_ids"] = np.zeros(0, dtype=np.uint64)
            out.append(rec)
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
    track_p2d = []
    point_ids = []
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        for _ in range(n):
            point_ids.append(struct.unpack("<Q", f.read(8))[0])
            xyz.append(struct.unpack("<3d", f.read(24)))
            rgb.append(struct.unpack("<3B", f.read(3)))
            err.append(struct.unpack("<d", f.read(8))[0])
            tl = struct.unpack("<Q", f.read(8))[0]
            tracks.append(tl)
            if with_tracks:
                arr = np.frombuffer(f.read(8 * tl), dtype=np.uint32).reshape(-1, 2)
                track_ids.append(arr[:, 0].astype(np.int64))
                track_p2d.append(arr[:, 1].astype(np.int64))
            else:
                f.seek(8 * tl, 1)
    out = {
        "n": n,
        "ids": np.asarray(point_ids, dtype=np.uint64),
        "xyz": np.asarray(xyz, dtype=np.float64).reshape(-1, 3),
        "rgb": np.asarray(rgb, dtype=np.uint8).reshape(-1, 3),
        "error": np.asarray(err, dtype=np.float64),
        "track_len": np.asarray(tracks, dtype=np.int64),
    }
    if with_tracks:
        out["track_image_ids"] = track_ids
        out["track_point2d_idx"] = track_p2d
    return out


# ---------------------------------------------------------------------------
# T-700007：COLMAP 二进制写入器 + 多子模型合并（纯 Python/numpy，不依赖 pycolmap）
# ---------------------------------------------------------------------------

# 合并诊断码：全部可在测试里断言，不允许自由文本替代（与 contracts 诊断码同一约定）
MERGE_OK = "MERGE_OK"
MERGE_SINGLE_MODEL = "MERGE_SINGLE_MODEL"
MERGE_NO_SHARED_IMAGES = "MERGE_NO_SHARED_IMAGES"
MERGE_INSUFFICIENT_SHARED = "MERGE_INSUFFICIENT_SHARED"
MERGE_DEGENERATE_GEOMETRY = "MERGE_DEGENERATE_GEOMETRY"
MERGE_ALIGNMENT_FAILED = "MERGE_ALIGNMENT_FAILED"

# 与 ingest.IMAGE_EXTS 同口径：注册率分母只数 processed/<id>/images 里的图片文件
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}

# 对齐残差上限（相对参考模型相机中心跨度）：超过即认为两模型并非同一场景的可对齐子集
_ALIGNMENT_MAX_REL_RMS = 0.05


class MergeError(RuntimeError):
    """无法合并时抛出，携带诊断码；上游必须如实记录，不得静默取 sparse/0 冒充已合并。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def rotmat2qvec(R: np.ndarray) -> np.ndarray:
    """旋转矩阵 → [w,x,y,z] 单位四元数（Shepperd 分支法，数值稳定）。"""
    R = np.asarray(R, dtype=np.float64)
    trace = R[0, 0] + R[1, 1] + R[2, 2]
    if trace > 0:
        s = 0.5 / np.sqrt(trace + 1.0)
        w, x, y, z = 0.25 / s, (R[2, 1] - R[1, 2]) * s, (R[0, 2] - R[2, 0]) * s, (R[1, 0] - R[0, 1]) * s
    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
        s = 2.0 * np.sqrt(1.0 + R[0, 0] - R[1, 1] - R[2, 2])
        w, x, y, z = (R[2, 1] - R[1, 2]) / s, 0.25 * s, (R[0, 1] + R[1, 0]) / s, (R[0, 2] + R[2, 0]) / s
    elif R[1, 1] > R[2, 2]:
        s = 2.0 * np.sqrt(1.0 + R[1, 1] - R[0, 0] - R[2, 2])
        w, x, y, z = (R[0, 2] - R[2, 0]) / s, (R[0, 1] + R[1, 0]) / s, 0.25 * s, (R[1, 2] + R[2, 1]) / s
    else:
        s = 2.0 * np.sqrt(1.0 + R[2, 2] - R[0, 0] - R[1, 1])
        w, x, y, z = (R[1, 0] - R[0, 1]) / s, (R[0, 2] + R[2, 0]) / s, (R[1, 2] + R[2, 1]) / s, 0.25 * s
    q = np.array([w, x, y, z], dtype=np.float64)
    q /= np.linalg.norm(q)
    if q[0] < 0:
        q = -q
    return q


def write_cameras_bin(path: Path, cams: dict) -> None:
    """cams 与 read_cameras_bin 输出同形。"""
    with open(path, "wb") as f:
        f.write(struct.pack("<Q", len(cams)))
        for cid in sorted(cams):
            c = cams[cid]
            f.write(struct.pack("<IiQQ", c["camera_id"], c["model_id"], c["width"], c["height"]))
            f.write(struct.pack("<%dd" % len(c["params"]), *c["params"]))


def write_images_bin(path: Path, images: list) -> None:
    """images 与 read_images_bin 输出同形；可选 points2d_xy / points2d_point3d_ids。"""
    with open(path, "wb") as f:
        f.write(struct.pack("<Q", len(images)))
        for im in images:
            f.write(struct.pack("<I", im["id"]))
            f.write(struct.pack("<4d", *im["qvec"]))
            f.write(struct.pack("<3d", *im["tvec"]))
            f.write(struct.pack("<I", im["camera_id"]))
            f.write(im["name"].encode("utf-8") + b"\x00")
            xy = np.asarray(im.get("points2d_xy", np.zeros((0, 2))), dtype=np.float64).reshape(-1, 2)
            pid = np.asarray(im.get("points2d_point3d_ids", np.zeros(0)), dtype=np.uint64)
            if len(xy) != len(pid):
                raise ColmapError("points2d_xy 与 points2d_point3d_ids 长度不一致")
            f.write(struct.pack("<Q", len(xy)))
            if len(xy):
                dt = np.dtype([("x", "<f8"), ("y", "<f8"), ("pid", "<u8")])
                arr = np.zeros(len(xy), dtype=dt)
                arr["x"], arr["y"], arr["pid"] = xy[:, 0], xy[:, 1], pid
                f.write(arr.tobytes())


def write_points3d_bin(path: Path, points: dict) -> None:
    """points 与 read_points3d_bin(with_tracks=True) 输出同形。

    track_point2d_idx 缺省时写 0（合成夹具可不提供真实 2D 索引）。
    """
    n = int(points["n"])
    xyz = np.asarray(points["xyz"], dtype=np.float64).reshape(-1, 3)
    rgb = np.asarray(points["rgb"], dtype=np.uint8).reshape(-1, 3)
    err = np.asarray(points["error"], dtype=np.float64)
    ids = np.asarray(points.get("ids", np.arange(1, n + 1)), dtype=np.uint64)
    timg = points["track_image_ids"]
    tp2d = points.get("track_point2d_idx", [np.zeros(len(t), dtype=np.int64) for t in timg])
    with open(path, "wb") as f:
        f.write(struct.pack("<Q", n))
        for i in range(n):
            f.write(struct.pack("<Q", int(ids[i])))
            f.write(struct.pack("<3d", *xyz[i]))
            f.write(struct.pack("<3B", *rgb[i]))
            f.write(struct.pack("<d", float(err[i])))
            ti = np.asarray(timg[i], dtype=np.uint32)
            tp = np.asarray(tp2d[i], dtype=np.uint32)
            f.write(struct.pack("<Q", len(ti)))
            if len(ti):
                f.write(np.column_stack([ti, tp]).astype(np.uint32).tobytes())


def _similarity_from_centers(src: np.ndarray, dst: np.ndarray):
    """Umeyama 相似变换（含尺度）：dst ≈ s·R·src + t。返回 (s, R, t, rms)。

    共享相机中心共线/重合 → MERGE_DEGENERATE_GEOMETRY；
    对齐残差超过参考跨度 5% → MERGE_ALIGNMENT_FAILED（不是同一场景的可对齐子集）。
    """
    n = len(src)
    mu_s, mu_d = src.mean(axis=0), dst.mean(axis=0)
    X, Y = src - mu_s, dst - mu_d
    try:
        sx = np.linalg.svd(X, compute_uv=False)
    except np.linalg.LinAlgError as e:
        # 严格退化（共线/重合）时 LAPACK 可能不收敛，同样按退化诊断处理
        raise MergeError(MERGE_DEGENERATE_GEOMETRY, f"共享相机中心退化（SVD 不收敛：{e}）") from e
    if sx[0] < 1e-12 or sx[1] < 1e-9 * sx[0]:
        raise MergeError(
            MERGE_DEGENERATE_GEOMETRY,
            f"共享相机中心退化（重合或共线，奇异值 {sx.tolist()}），无法估计相似变换",
        )
    try:
        U, D, Vt = np.linalg.svd(Y.T @ X / n)
    except np.linalg.LinAlgError as e:
        raise MergeError(MERGE_DEGENERATE_GEOMETRY, f"共享相机中心退化（协方差 SVD 不收敛：{e}）") from e
    S = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        S[2, 2] = -1
    R = U @ S @ Vt
    s = float((D * np.diag(S)).sum() / ((X * X).sum() / n))
    t = mu_d - s * (R @ mu_s)
    res = dst - (s * (src @ R.T) + t)
    rms = float(np.sqrt((res * res).sum(axis=1).mean()))
    span = float(np.linalg.norm(dst.max(axis=0) - dst.min(axis=0)))
    if span > 1e-12 and rms / span > _ALIGNMENT_MAX_REL_RMS:
        raise MergeError(
            MERGE_ALIGNMENT_FAILED,
            f"对齐残差过大（rms={rms:.6g}，参考跨度={span:.6g}，相对 {rms / span:.3f} > "
            f"{_ALIGNMENT_MAX_REL_RMS}）：两模型不是同一场景的可对齐子集",
        )
    return s, R, t, rms


def merge_sparse_models(model_dirs: list, out_dir: Path) -> dict:
    """把多个 COLMAP 稀疏子模型合并为一个模型，写入 out_dir，返回合并报告。

    算法：以注册图像最多的子模型为参考系；其余子模型用共享图像（≥3 张）的相机中心
    估计相似变换（Umeyama，含尺度）对齐到参考系；图像按名字去重（共享图像保留参考系位姿），
    相机按参数去重，点云取并集并重映射 track/point3D_id。

    如实声明的近似：点云不做几何去重（下游 instances 已有退化簇处理）；
    被合并模型在共享图像上的 2D 观测不并入（保留参考模型的观测）。

    无法合并时抛 MergeError（带诊断码），不产出任何文件、不静默降级。
    """
    model_dirs = [Path(d) for d in model_dirs]
    models = []
    for d in model_dirs:
        cams = read_cameras_bin(d / "cameras.bin")
        imgs = read_images_bin(d / "images.bin", with_points2d=True)
        p3 = d / "points3D.bin"
        pts = (
            read_points3d_bin(p3, with_tracks=True)
            if p3.exists()
            else {"n": 0, "ids": np.zeros(0, np.uint64), "xyz": np.zeros((0, 3)),
                  "rgb": np.zeros((0, 3), np.uint8), "error": np.zeros(0),
                  "track_image_ids": [], "track_point2d_idx": []}
        )
        models.append({"dir": d, "cams": cams, "imgs": imgs, "pts": pts})
    valid = [m for m in models if m["imgs"]]
    if len(valid) < 2:
        raise MergeError(
            MERGE_SINGLE_MODEL,
            f"只有 {len(valid)} 个含注册图像的子模型，无需/无法合并（共 {len(models)} 个目录）",
        )
    ref = max(valid, key=lambda m: len(m["imgs"]))
    # 参考模型排首位：共享图像去重时保留参考系位姿与 2D 观测（与报告声明一致）
    valid = [ref] + [m for m in valid if m is not ref]
    ref_names = {im["name"]: im for im in ref["imgs"]}

    alignments = []
    shared_counts = {}
    for m in valid:
        if m is ref:
            continue
        shared = [im["name"] for im in m["imgs"] if im["name"] in ref_names]
        shared_counts[str(m["dir"])] = len(shared)
        if not shared:
            raise MergeError(
                MERGE_NO_SHARED_IMAGES,
                f"子模型 {m['dir']} 与参考模型 {ref['dir']} 无共享图像，无法对齐",
            )
        if len(shared) < 3:
            raise MergeError(
                MERGE_INSUFFICIENT_SHARED,
                f"子模型 {m['dir']} 与参考模型仅 {len(shared)} 张共享图像（<3），无法可靠估计相似变换",
            )
        src = np.asarray([next(im["center"] for im in m["imgs"] if im["name"] == nm) for nm in shared])
        dst = np.asarray([ref_names[nm]["center"] for nm in shared])
        s, R, t, rms = _similarity_from_centers(src, dst)
        alignments.append({"model": str(m["dir"]), "scale": s, "rotation": R.tolist(),
                           "translation": t.tolist(), "rms_residual": rms, "shared": len(shared)})
        # 对齐该子模型的相机位姿与点云到参考系
        for im in m["imgs"]:
            Rb = qvec2rotmat(np.asarray(im["qvec"]))
            Cb = -Rb.T @ np.asarray(im["tvec"])
            Cb2 = s * (R @ Cb) + t
            Rb2 = Rb @ R.T
            im["qvec"] = rotmat2qvec(Rb2).tolist()
            im["tvec"] = (-Rb2 @ Cb2).tolist()
            im["center"] = Cb2.tolist()
            im["forward"] = (Rb2.T @ np.array([0.0, 0.0, 1.0])).tolist()
        if m["pts"]["n"]:
            m["pts"]["xyz"] = s * (m["pts"]["xyz"] @ R.T) + t

    # 相机去重（model_id + 尺寸 + 参数完全一致视为同一相机）
    merged_cams: dict = {}
    cam_key_to_id: dict = {}
    cam_maps = []
    for m in valid:
        cmap = {}
        for cid, c in m["cams"].items():
            key = (c["model_id"], c["width"], c["height"], tuple(c["params"]))
            if key not in cam_key_to_id:
                new_id = len(merged_cams) + 1
                cam_key_to_id[key] = new_id
                merged_cams[new_id] = {**c, "camera_id": new_id}
            cmap[cid] = cam_key_to_id[key]
        cam_maps.append(cmap)

    # 图像按名字去重：参考系优先；重编号 1..N
    merged_imgs: list = []
    name_to_new: dict = {}
    img_maps = []
    for mi, m in enumerate(valid):
        imap = {}
        for im in m["imgs"]:
            if im["name"] in name_to_new:
                imap[im["id"]] = name_to_new[im["name"]]
                continue
            new_id = len(merged_imgs) + 1
            name_to_new[im["name"]] = new_id
            imap[im["id"]] = new_id
            merged_imgs.append({
                "id": new_id, "qvec": im["qvec"], "tvec": im["tvec"],
                "camera_id": cam_maps[mi][im["camera_id"]], "name": im["name"],
                "points2d_xy": im["points2d_xy"], "points2d_point3d_ids": im["points2d_point3d_ids"],
                "_owner": mi,
            })
        img_maps.append(imap)

    # 点云并集：重编号 1..M，track 的 image_id 与 points2D 的 point3D_id 全部重映射
    merged_xyz, merged_rgb, merged_err, merged_timg, merged_tp2d = [], [], [], [], []
    pt_maps = []
    for mi, m in enumerate(valid):
        pts = m["pts"]
        pmap = {}
        for i in range(pts["n"]):
            new_id = len(merged_xyz) + 1
            pmap[int(pts["ids"][i])] = new_id
            merged_xyz.append(pts["xyz"][i])
            merged_rgb.append(pts["rgb"][i])
            merged_err.append(pts["error"][i])
            merged_timg.append(np.asarray([img_maps[mi][int(v)] for v in pts["track_image_ids"][i]], dtype=np.int64))
            merged_tp2d.append(pts["track_point2d_idx"][i])
        pt_maps.append(pmap)
    for im in merged_imgs:
        pid = im["points2d_point3d_ids"]
        if len(pid):
            # 只重映射保留方模型已知的 point3D_id；未知/无效 id（如 kInvalidPoint3DId）原样保留
            owner = im["_owner"]
            im["points2d_point3d_ids"] = np.asarray(
                [pt_maps[owner].get(int(v), int(v)) for v in pid], dtype=np.uint64
            )

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    write_cameras_bin(out_dir / "cameras.bin", merged_cams)
    write_images_bin(out_dir / "images.bin", merged_imgs)
    write_points3d_bin(out_dir / "points3D.bin", {
        "n": len(merged_xyz), "xyz": np.asarray(merged_xyz).reshape(-1, 3),
        "rgb": np.asarray(merged_rgb, dtype=np.uint8).reshape(-1, 3),
        "error": np.asarray(merged_err), "track_image_ids": merged_timg, "track_point2d_idx": merged_tp2d,
    })
    return {
        "status": MERGE_OK,
        "models": [{"dir": str(m["dir"]), "registered": len(m["imgs"]), "points": int(m["pts"]["n"])} for m in valid],
        "reference": str(ref["dir"]),
        "shared_images": shared_counts,
        "alignments": alignments,
        "registered_merged": len(merged_imgs),
        "points_merged": len(merged_xyz),
        "note": "共享图像保留参考模型位姿；点云取并集不做几何去重；被合并模型在共享图像上的 2D 观测不并入。",
    }


def registration_ratio(model_dir: Path, processed_images_dir: Path) -> dict:
    """注册率 = 模型注册图像数 / processed/<id>/images 图片文件数（不得用 uploads）。

    分母口径与 ingest.scan_scene 完全一致（IMAGE_EXTS，大小写不敏感，只数文件）。
    """
    model_dir, processed_images_dir = Path(model_dir), Path(processed_images_dir)
    registered = len(read_images_bin(model_dir / "images.bin"))
    total = (
        sum(1 for p in processed_images_dir.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS)
        if processed_images_dir.is_dir()
        else 0
    )
    return {
        "registered": registered,
        "total": total,
        "ratio": registered / total if total else 0.0,
        "denominator_source": str(processed_images_dir),
    }
