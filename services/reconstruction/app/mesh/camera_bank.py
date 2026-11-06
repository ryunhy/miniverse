"""相机库：从 nerfstudio 训练配置直接取权威相机（不依赖外部导出文件）。

相比桌面 M1 版本（依赖 export/ns-cameras.npz + colmap/sparse 交叉核验），
这里改为直接走 nerfstudio dataparser —— 它是训练时真实使用的相机来源，
不存在「手工变换 vs 导出文件」两套数据可能失配的问题。

坐标约定：
    nerfstudio c2w 为 OpenGL 约定（x右 y上 -z前）
    gsplat / TSDF 需要 OpenCV 约定（x右 y下 z前）→ c2w_cv = c2w_gl @ diag(1,-1,-1,1)
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

GL_FLIP = np.diag([1.0, -1.0, -1.0, 1.0])


@dataclass
class Camera:
    name: str
    path: str
    split: str
    K: np.ndarray          # 3x3 针孔内参（与已去畸变图像一致）
    c2w_gl: np.ndarray     # 4x4 OpenGL，nerfstudio 归一化世界系
    width: int
    height: int
    distortion: list = field(default_factory=list)

    @property
    def center(self) -> np.ndarray:
        return self.c2w_gl[:3, 3]

    def extrinsic_cv(self) -> np.ndarray:
        """world→camera（OpenCV），供 TSDF / 光栅化使用。"""
        c2w_cv = self.c2w_gl @ GL_FLIP
        R = c2w_cv[:3, :3]
        t = c2w_cv[:3, 3]
        ext = np.eye(4)
        ext[:3, :3] = R.T
        ext[:3, 3] = -R.T @ t
        return ext


def load_nerfstudio_cameras(config_path: Path, split: str = "all") -> list[Camera]:
    """用 nerfstudio dataparser 读取训练配置中的权威相机。

    同时返回每台相机的图像路径（nerfstudio 已处理去畸变、下采样）。
    """
    from nerfstudio.utils.eval_utils import eval_setup

    _, pipeline, _, _ = eval_setup(Path(config_path), test_mode="test")
    dp = pipeline.datamanager.dataparser

    cams: list[Camera] = []
    for sp in (("train", "test") if split == "all" else (split,)):
        out = dp.get_dataparser_outputs(sp)
        cameras = out.cameras
        c2w = np.asarray(cameras.camera_to_worlds.cpu().numpy(), dtype=np.float64)  # (N,3,4)
        fx = np.asarray(cameras.fx.cpu().numpy()).reshape(-1)
        fy = np.asarray(cameras.fy.cpu().numpy()).reshape(-1)
        cx = np.asarray(cameras.cx.cpu().numpy()).reshape(-1)
        cy = np.asarray(cameras.cy.cpu().numpy()).reshape(-1)
        w = np.asarray(cameras.width.cpu().numpy()).reshape(-1).astype(int)
        h = np.asarray(cameras.height.cpu().numpy()).reshape(-1).astype(int)
        dist = getattr(cameras, "distortion_params", None)
        dist_np = dist.cpu().numpy() if dist is not None else None

        for i, fname in enumerate(out.image_filenames):
            c2w4 = np.eye(4)
            c2w4[:3, :4] = c2w[i]
            K = np.array([[fx[i], 0.0, cx[i]], [0.0, fy[i], cy[i]], [0.0, 0.0, 1.0]])
            cams.append(Camera(
                name=Path(str(fname)).name,
                path=str(fname),
                split=sp,
                K=K,
                c2w_gl=c2w4,
                width=int(w[i]),
                height=int(h[i]),
                distortion=[float(v) for v in dist_np[i]] if dist_np is not None else [],
            ))
    return cams


def camera_summary(cams: list[Camera]) -> dict:
    """相机集合的自检摘要（写进 metadata，便于排查坐标问题）。"""
    centers = np.stack([c.center for c in cams])
    return {
        "count": len(cams),
        "splits": {sp: sum(1 for c in cams if c.split == sp) for sp in {c.split for c in cams}},
        "resolution": [cams[0].width, cams[0].height] if cams else None,
        "intrinsics_fx": round(float(cams[0].K[0, 0]), 4) if cams else None,
        "centers_min": np.round(centers.min(0), 4).tolist(),
        "centers_max": np.round(centers.max(0), 4).tolist(),
        "center_spread": np.round(centers.max(0) - centers.min(0), 4).tolist(),
        "distortion_nonzero": bool(any(abs(v) > 1e-9 for c in cams for v in c.distortion)),
    }


def dump_summary(cams: list[Camera], out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(camera_summary(cams), ensure_ascii=False, indent=2), encoding="utf-8")
