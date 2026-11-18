"""网格链路纯 CPU 自检（不需要 GPU / nerfstudio，可在任意环境跑）。

覆盖：PLY 读写往返、GLB 读写往返、深度标定稳健拟合、相机坐标约定。

用法：
  python -m app.mesh.selftest
退出码 0 = 全部通过。
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import numpy as np

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}  {detail}")
        FAILURES.append(name)


def test_ply_roundtrip() -> None:
    print("[1] PLY 读写往返")
    from app.mesh.ply_io import read_inria_ply

    n = 7
    props = (["x", "y", "z"] + [f"n{a}" for a in "xyz"]
             + [f"f_dc_{i}" for i in range(3)] + [f"f_rest_{i}" for i in range(45)]
             + ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"])
    data = np.random.rand(n, len(props)).astype(np.float32)
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "t.ply"
        with p.open("wb") as f:
            f.write(b"ply\nformat binary_little_endian 1.0\nelement vertex %d\n" % n)
            for name in props:
                f.write(f"property float {name}\n".encode())
            f.write(b"end_header\n")
            f.write(data.tobytes())
        d = read_inria_ply(p)
        check("顶点数", d["count"] == n, f"{d['count']} != {n}")
        check("means 形状", d["means"].shape == (n, 3), str(d["means"].shape))
        check("quats 形状", d["quats"].shape == (n, 4), str(d["quats"].shape))
        check("SH 阶数=3", d["sh_degree"] == 3, str(d["sh_degree"]))
        check("sh_rest 形状", d["sh_rest"].shape == (n, 15, 3), str(d["sh_rest"].shape))
        check("数值一致", np.allclose(d["means"][0], data[0, :3], atol=1e-6))


def test_glb_roundtrip() -> None:
    print("[2] GLB 写 → 读往返")
    import cv2
    from app.mesh.glb_io import read_glb, write_glb

    verts = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], np.float32)
    faces = np.array([[0, 1, 2]], np.int64)
    uv = np.array([[0, 0], [1, 0], [0, 1]], np.float32)
    tex = np.zeros((8, 8, 3), np.uint8)
    tex[:, :4] = (255, 0, 0)
    ok, png = cv2.imencode(".png", cv2.cvtColor(tex, cv2.COLOR_RGB2BGR))

    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "m.glb"
        info = write_glb(p, verts, faces, uv, png.tobytes(), name="selftest")
        check("GLB 已写出", p.exists() and p.stat().st_size > 0)
        r = read_glb(p)
        check("重载顶点数", len(r["vertices"]) == 3, str(len(r["vertices"])))
        check("重载面数", len(r["faces"]) == 1, str(len(r["faces"])))
        check("重载有贴图", r.get("texture") is not None and r["texture"].size > 0)
        check("顶点坐标一致", np.allclose(r["vertices"], verts, atol=1e-6))
        check("写回统计", isinstance(info, dict) and "bytes" in info, str(info))


def test_robust_fit() -> None:
    print("[3] 深度标定稳健拟合")
    from app.mesh.depth_calib import robust_fit

    rng = np.random.default_rng(7)
    x = rng.uniform(0.5, 3.0, 2000)
    y = 0.997 * x + 0.008 + rng.normal(0, 0.002, 2000)
    y[:40] += 1.5                       # 注入 2% 离群
    fit = robust_fit(x, y)
    check("斜率≈0.997", abs(fit["a"] - 0.997) < 0.01, f"a={fit['a']:.5f}")
    check("截距≈0.008", abs(fit["b"] - 0.008) < 0.01, f"b={fit['b']:.5f}")
    check("离群被剔除", fit["inliers"] < fit["total"], f"{fit['inliers']}/{fit['total']}")


def test_camera_convention() -> None:
    print("[4] 相机坐标约定（OpenGL c2w → OpenCV w2c）")
    from app.mesh.camera_bank import GL_FLIP, Camera

    c2w_gl = np.eye(4)
    c2w_gl[:3, 3] = [0, 0, 2]           # 相机在 +z 方向 2 处，朝 -z 看
    K = np.array([[100.0, 0, 50], [0, 100.0, 40], [0, 0, 1]])
    cam = Camera(name="t.jpg", path="", split="train", K=K, c2w_gl=c2w_gl,
                 width=100, height=80)

    # 原点应在相机正前方 z=2 处
    ext = cam.extrinsic_cv()
    p_cam = ext @ np.array([0, 0, 0, 1])
    check("原点在相机前方 z=2", abs(p_cam[2] - 2.0) < 1e-9, f"z={p_cam[2]:.4f}")
    check("原点投影像素中心附近", abs(p_cam[0]) < 1e-9 and abs(p_cam[1]) < 1e-9)

    # GL_FLIP 自逆
    check("GL_FLIP 为自逆", np.allclose(GL_FLIP @ GL_FLIP, np.eye(4)))
    check("GL_FLIP 保持 x 轴", np.allclose(GL_FLIP[0, 0], 1.0))


def test_distortion_order() -> None:
    print("[5] 畸变参数顺序转换（nerfstudio → OpenCV）")
    import cv2
    from app.mesh.texture_bake import to_opencv_distortion, undistort_maps

    # nerfstudio 顺序 [k1,k2,k3,k4,p1,p2]；k4=0 时 OpenCV 收 5 元
    d = [-0.0018, 0.0, 0.0, 0.0, 0.0, 0.0]
    v = to_opencv_distortion(d)
    check("k4=0 → 5 元", v.shape == (5,), str(v.shape))
    check("k1 在首位", abs(v[0] - (-0.0018)) < 1e-12, str(v[0]))
    # 切向畸变位置：nerfstudio p1/p2 是第 5、6 位，OpenCV 要求第 3、4 位
    d2 = [0.01, 0.002, 0.0003, 0.0, 0.0011, 0.0022]
    v2 = to_opencv_distortion(d2)
    check("p1 落到第 3 位", abs(v2[2] - 0.0011) < 1e-12, str(v2))
    check("p2 落到第 4 位", abs(v2[3] - 0.0022) < 1e-12, str(v2))
    check("k3 落到第 5 位", abs(v2[4] - 0.0003) < 1e-12, str(v2))
    # k4 != 0 → 8 元（OpenCV 只接受 4/5/8/12/14）
    d3 = [0.01, 0.002, 0.0003, 0.0004, 0.0, 0.0]
    check("k4≠0 → 8 元", to_opencv_distortion(d3).shape == (8,))

    K = np.array([[100.0, 0, 50], [0, 100.0, 40], [0, 0, 1]])
    mx, my = undistort_maps(K, d, 100, 80)
    check("映射表可构建", mx is not None and mx.shape == (80, 100), str(None if mx is None else mx.shape))
    check("零畸变返回 None", undistort_maps(K, [0.0] * 6, 100, 80)[0] is None)
    # 直接传 6 元给 OpenCV 会断言失败——本函数存在的唯一理由
    try:
        cv2.initUndistortRectifyMap(K, np.asarray(d, np.float64), None, K, (100, 80), cv2.CV_32FC1)
        check("裸 6 元应被 OpenCV 拒绝", False, "居然通过了")
    except cv2.error:
        check("裸 6 元应被 OpenCV 拒绝", True)


def test_view_key() -> None:
    """ViewStore 的 key 必须与 render_depth 落盘名一致，且与扩展名大小写无关。"""
    print("[6] ViewStore key 扩展名大小写")
    import json
    import tempfile

    from app.mesh.visibility import ViewStore

    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        (d / "views-meta.json").write_text(json.dumps({"views": [
            {"name": "DSCF5566.JPG"},
            {"name": "IMG_0001.jpg"},
            {"name": "scan.PNG"},
        ]}), encoding="utf-8")
        (d / "view-DSCF5566.npz").write_bytes(b"")
        vs = ViewStore(Path(td))
        check("大写 .JPG → DSCF5566", vs.key(0) == "DSCF5566", vs.key(0))
        check("小写 .jpg → IMG_0001", vs.key(1) == "IMG_0001", vs.key(1))
        check("大写 .PNG → scan", vs.key(2) == "scan", vs.key(2))
        check("npz 路径可命中", (d / f"view-{vs.key(0)}.npz").exists())


def main() -> int:
    test_ply_roundtrip()
    test_glb_roundtrip()
    test_robust_fit()
    test_camera_convention()
    test_distortion_order()
    test_view_key()
    print()
    if FAILURES:
        print(f"失败 {len(FAILURES)} 项：{FAILURES}")
        return 1
    print("全部自检通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
