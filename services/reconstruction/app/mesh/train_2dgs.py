"""2DGS（2D Gaussian Splatting）训练器 → 为表面重建提供几何一致的高斯。

为什么需要它：Splatfacto 的 3D 高斯是视角相关的体积表示，从它直接提网格
（泊松/TSDF）只能得到漂浮薄壳（本机实测，见记忆 #6495）。2DGS 把每个高斯
压扁成面向法线的薄盘，因此能直接用 TSDF 融合出封闭表面。

依赖零新增：torch + gsplat 1.4.0 原生 rasterization_2dgs + pytorch_msssim。

输入：nerfstudio 训练产物 config.yml（相机与坐标系直接复用，保证与基线对齐）
输出：splat-2dgs.ply（INRIA 兼容，scale_2=1e-6 供 3DGS 查看器近似渲染）
      ckpt-*.pt（供 TSDF 提取阶段重新渲染深度/法向）

用法（WSL，conda activate miniverse）：
  python -m app.mesh.train_2dgs --config <config.yml> --out <out_dir> --iters 15000
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from .gsplat_bootstrap import bootstrap

C0 = 0.28209479177387814
ATTRS = ["means", "quats", "scales", "opacity", "sh_dc", "sh_rest"]


def build_dataset(config_path: Path, split: str) -> dict:
    """复用 nerfstudio dataparser，保证相机/坐标系与基线训练完全一致。"""
    import copy

    import yaml
    from nerfstudio.data.datamanagers.full_images_datamanager import _undistort_image
    from nerfstudio.data.datasets.base_dataset import InputDataset

    raw = yaml.load(Path(config_path).read_text(encoding="utf-8"), Loader=yaml.Loader)
    cfg = copy.deepcopy(raw.pipeline.datamanager.dataparser)
    dp = cfg.setup()
    out = dp.get_dataparser_outputs(split)

    # InputDataset 只解码图像；FullImageDatamanager 才去畸变，这里显式复刻该操作
    ds = InputDataset(out)
    imgs = []
    for i in range(len(ds)):
        data = ds.get_data(i)
        camera = ds.cameras[i].reshape(())
        image = data["image"].numpy()
        K = camera.get_intrinsics_matrices().numpy()
        if camera.distortion_params is not None and torch.any(camera.distortion_params != 0):
            K, image, _ = _undistort_image(camera, camera.distortion_params.numpy(), data, image, K)
        imgs.append(torch.from_numpy(image))
        ds.cameras.fx[i], ds.cameras.fy[i] = float(K[0, 0]), float(K[1, 1])
        ds.cameras.cx[i], ds.cameras.cy[i] = float(K[0, 2]), float(K[1, 2])
        ds.cameras.width[i], ds.cameras.height[i] = image.shape[1], image.shape[0]
    out.cameras = ds.cameras

    # nerfstudio c2w 是 OpenGL（y上 -z前）→ gsplat 需要 OpenCV（y下 z前）
    c2w = torch.tensor(np.asarray(out.cameras.camera_to_worlds), dtype=torch.float32)
    R_cv = c2w[:, :3, :3] @ torch.diag(torch.tensor([1.0, -1.0, -1.0]))
    t = c2w[:, :3, 3]
    R_w2c = R_cv.transpose(1, 2)
    viewmats = torch.zeros(len(c2w), 4, 4)
    viewmats[:, 3, 3] = 1
    viewmats[:, :3, :3] = R_w2c
    viewmats[:, :3, 3] = (-R_w2c @ t[..., None]).squeeze(-1)

    fx = np.asarray(out.cameras.fx).reshape(-1)
    fy = np.asarray(out.cameras.fy).reshape(-1)
    cx = np.asarray(out.cameras.cx).reshape(-1)
    cy = np.asarray(out.cameras.cy).reshape(-1)
    Ks = torch.zeros(len(c2w), 3, 3)
    Ks[:, 0, 0] = torch.tensor(fx, dtype=torch.float32)
    Ks[:, 1, 1] = torch.tensor(fy, dtype=torch.float32)
    Ks[:, 0, 2] = torch.tensor(cx, dtype=torch.float32)
    Ks[:, 1, 2] = torch.tensor(cy, dtype=torch.float32)

    W = int(out.cameras.width[0])
    H = int(out.cameras.height[0])
    # 点云在 DataparserOutputs.metadata 里（nerfstudio 1.1.5 实证），不是顶层属性
    meta = out.metadata or {}
    if "points3D_xyz" not in meta:
        raise RuntimeError(
            "dataparser 未提供 points3D_xyz（需 load_3D_points=true 且 COLMAP 有 points3D.bin）")
    pts = torch.tensor(np.asarray(meta["points3D_xyz"]), dtype=torch.float32)
    if pts.ndim == 3:   # (N,4) 齐次坐标 → 取前三维
        pts = pts[:, :3]
    # nerfstudio 1.1.5 的 points3D_rgb 是 0-255 未归一（本机实证）
    rgb = torch.tensor(np.asarray(meta["points3D_rgb"]), dtype=torch.float32)
    if rgb.max() > 1.5:
        rgb = rgb / 255.0

    return {
        "images": torch.stack(imgs).cuda(),
        "viewmats": viewmats.cuda(),
        "Ks": Ks.cuda(),
        "W": W, "H": H, "C": len(imgs),
        "points_xyz": pts.cuda(),
        "points_rgb": rgb.cuda(),
        "scene_scale": getattr(out, "scene_scale_factor", None),
    }


class Gaussians2D:
    """2DGS 参数集：第三轴 scale 恒 0（log1），仅前两轴参与光栅化。"""

    def __init__(self, xyz: torch.Tensor, rgb: torch.Tensor):
        n = len(xyz)
        with torch.no_grad():
            dists = torch.cdist(xyz, xyz) + torch.eye(n, device=xyz.device) * 1e9
            nn3 = dists.topk(3, largest=False).values.mean(1).clamp(min=1e-6)
            s = (nn3 * 0.1).clamp(1e-4, 0.05)
        self.means = torch.nn.Parameter(xyz.cuda())
        self.quats = torch.nn.Parameter(torch.randn(n, 4, device=xyz.device))
        self.scales = torch.nn.Parameter(
            torch.log(torch.stack([s, s, torch.full_like(s, 1.0)], 1)))
        self.opacity = torch.nn.Parameter(torch.logit(torch.full((n,), 0.1, device=xyz.device)))
        sh0 = ((rgb - 0.5) / C0).cuda()
        self.sh_dc = torch.nn.Parameter(sh0[:, None].clone())
        self.sh_rest = torch.nn.Parameter(torch.zeros(n, 15, 3, device=xyz.device))


def build_from_ply(ply_path: Path) -> tuple:
    """热启动：从已收敛的 3DGS PLY 构造 2DGS 初值。

    继承 means/SH/opacity；scale 取两短轴（丢弃薄轴）；
    法向取原旋转中最小 scale 轴，两长轴重新正交化构成面内基。
    """
    from .ply_io import read_inria_ply

    d = read_inria_ply(ply_path)
    n = len(d["means"])
    means = torch.tensor(d["means"], dtype=torch.float32)
    q3 = F.normalize(torch.tensor(d["quats"], dtype=torch.float32), dim=-1)
    sc3 = torch.exp(torch.tensor(d["scales"], dtype=torch.float32))
    op = torch.tensor(d["opacity"], dtype=torch.float32)
    sh_dc = torch.tensor(d["sh_dc"], dtype=torch.float32)
    sh_rest = torch.tensor(d["sh_rest"], dtype=torch.float32)

    w, x, y, z = q3[:, 0], q3[:, 1], q3[:, 2], q3[:, 3]
    R3 = torch.stack([
        torch.stack([1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * w * z, 2 * x * z + 2 * w * y], 1),
        torch.stack([2 * x * y + 2 * w * z, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * w * x], 1),
        torch.stack([2 * x * z - 2 * w * y, 2 * y * z + 2 * w * x, 1 - 2 * x * x - 2 * y * y], 1)], 1)

    order = torch.argsort(sc3, dim=1)          # 升序：[:,0]=最短轴
    row = torch.arange(n)
    normal = R3[row[:, None], :, order[:, 0][:, None]][:, 0]
    ax1 = R3[row[:, None], :, order[:, 2][:, None]][:, 0]
    ax2 = F.normalize(torch.linalg.cross(normal, ax1), dim=-1)
    ax1o = torch.linalg.cross(ax2, normal)
    R2 = torch.stack([ax1o, ax2, normal], 2)   # 列：最长轴、中轴、法向

    import scipy.spatial.transform as st
    quats = torch.tensor(st.Rotation.from_matrix(R2.numpy()).as_quat()[:, [3, 0, 1, 2]]).float()

    scales = torch.log(torch.stack([sc3[row, order[:, 2]], sc3[row, order[:, 1]]], 1))
    scales = torch.cat([scales, torch.zeros(n, 1)], 1)
    # sh_dc 需为 (N,1,3) 才能与 (N,15,3) 的 sh_rest 拼接成 (N,16,3)
    return means, quats, scales, op, sh_dc[:, None], sh_rest


def export_ply(path: Path, g: Gaussians2D) -> None:
    n = len(g.means)
    with torch.no_grad():
        scales3 = g.scales.clone()
        scales3[:, 2] = math.log(1e-6)          # 薄盘：3DGS 查看器按近似椭盘渲染
        q = F.normalize(g.quats, dim=-1).detach()
        sh = torch.cat([g.sh_dc.detach(), g.sh_rest.detach()], 1)
        cols = {
            "x": g.means[:, 0].detach(), "y": g.means[:, 1].detach(), "z": g.means[:, 2].detach(),
            "opacity": g.opacity.detach(),
            "scale_0": scales3[:, 0], "scale_1": scales3[:, 1], "scale_2": scales3[:, 2],
            "rot_0": q[:, 0], "rot_1": q[:, 1], "rot_2": q[:, 2], "rot_3": q[:, 3],
        }
        for k in range(16):
            for c in range(3):
                name = f"f_dc_{c}" if k == 0 else f"f_rest_{c * 15 + k - 1}"
                cols[name] = sh[:, k, c]
        order = (["x", "y", "z"] + [f"n{a}" for a in "xyz"]
                 + [f"f_dc_{i}" for i in range(3)] + [f"f_rest_{i}" for i in range(45)]
                 + ["opacity", "scale_0", "scale_1", "scale_2",
                    "rot_0", "rot_1", "rot_2", "rot_3"])
        arr = np.zeros((n, len(order)), dtype=np.float32)
        for j, name in enumerate(order):
            if name in ("nx", "ny", "nz"):
                continue
            arr[:, j] = cols[name].cpu().numpy()

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as f:
        f.write(b"ply\nformat binary_little_endian 1.0\n")
        f.write(b"comment MiniVerse 2DGS export (scale_2=1e-6 for 3DGS viewers)\n")
        f.write(f"element vertex {n}\n".encode())
        for name in order:
            f.write(f"property float {name}\n".encode())
        f.write(b"end_header\n")
        f.write(arr.tobytes())


def train(config_path: Path, out: Path, iters: int = 15000, max_points: int = 600000,
          lambda_normal: float = 0.05, lambda_dist: float = 1.0,
          init_ply: Path | None = None, log=print) -> dict:
    bootstrap()
    from gsplat.rendering import rasterization_2dgs
    from pytorch_msssim import ssim as ssim_fn

    out.mkdir(parents=True, exist_ok=True)
    train_d = build_dataset(config_path, "train")
    C, W, H = train_d["C"], train_d["W"], train_d["H"]

    pts = train_d["points_xyz"]
    scene_scale = train_d["scene_scale"] or float(
        (pts.max(0).values - pts.min(0).values).norm() / 2)
    log(f"train cams={C} {W}x{H} init pts={len(pts)} scene_scale={scene_scale:.4f}")

    if init_ply and Path(init_ply).exists():
        m0, q0, s0, o0, dc0, rest0 = build_from_ply(Path(init_ply))
        g = Gaussians2D(pts, train_d["points_rgb"])
        for name, val in (("means", m0), ("quats", q0), ("scales", s0),
                          ("opacity", o0), ("sh_dc", dc0), ("sh_rest", rest0)):
            setattr(g, name, torch.nn.Parameter(val.cuda()))
        log(f"warm-start from {init_ply}: n={len(g.means)}")
        lrs = {"means": 1.6e-5 * scene_scale, "quats": 1e-3, "scales": 1e-3,
               "opacity": 5e-3, "sh_dc": 1e-3, "sh_rest": 1e-4}
    else:
        g = Gaussians2D(pts, train_d["points_rgb"])
        lrs = {"means": 1.6e-4 * scene_scale, "quats": 1e-3, "scales": 5e-3,
               "opacity": 5e-2, "sh_dc": 5e-3, "sh_rest": 5e-3 / 20}

    step = 0
    k_decay = math.log(1e-2) / iters

    def make_opt():
        ps = [getattr(g, a) for a in ATTRS]
        return torch.optim.Adam([
            {"params": [p], "lr": lrs[a] * math.exp(k_decay * step)}
            for p, a in zip(ps, ATTRS)
        ], eps=1e-15)

    opt = make_opt()
    perm = torch.randperm(C)
    pi = 0
    accum = torch.zeros(len(g.means), device="cuda")
    accum_n = 0
    log_path = out / "train.log"
    t0 = time.time()

    while step < iters:
        if pi >= C:
            perm = torch.randperm(C)
            pi = 0
        ci = int(perm[pi]); pi += 1
        img = train_d["images"][ci:ci + 1]
        viewmat = train_d["viewmats"][ci:ci + 1]
        K = train_d["Ks"][ci:ci + 1]
        bg = torch.tensor([[1.0, 1.0, 1.0, 0.0]], device="cuda")   # RGB 白背景 + depth 0

        colors, alpha, rnorm, snorm, distort, _median, meta = rasterization_2dgs(
            g.means, F.normalize(g.quats, dim=-1), torch.exp(g.scales),
            torch.sigmoid(g.opacity), torch.cat([g.sh_dc, g.sh_rest], 1), viewmat, K, W, H,
            sh_degree=min(3, step // 1000), absgrad=True, distloss=True,
            render_mode="RGB+ED", backgrounds=bg)
        pred = colors[..., :3]
        loss_l1 = F.l1_loss(pred, img)
        loss_ssim = 1 - ssim_fn(pred.permute(0, 3, 1, 2), img.permute(0, 3, 1, 2), data_range=1.0)
        wmask = (alpha[..., 0] > 0.5).detach()
        loss_n = ((1 - (rnorm * snorm).sum(-1))[wmask].mean()
                  if wmask.any() else torch.zeros((), device="cuda"))
        loss_d = distort.abs().mean()
        loss = 0.8 * loss_l1 + 0.2 * loss_ssim + lambda_normal * loss_n + lambda_dist * loss_d

        opt.zero_grad(set_to_none=True)
        loss.backward()
        with torch.no_grad():
            # 旧版预编译扩展不支持 absgrad（恒 0），改用光栅化内置 densify 梯度
            gd = meta["gradient_2dgs"]
            if gd.grad is not None:
                g2 = gd.grad[0] if gd.grad.dim() == 3 else gd.grad
                gnorm = g2.norm(dim=-1) if g2.dim() == 2 else g2
                gnorm = gnorm.clone()
                gnorm[torch.isnan(gnorm)] = 0
                gnorm = gnorm.clamp(max=1e3)
                if accum.shape[0] == len(g.means):
                    accum += gnorm
                    accum_n += 1
        opt.step()
        step += 1

        if step % 100 == 0:
            with torch.no_grad():
                psnr = -10 * math.log10(float(F.mse_loss(pred, img)) + 1e-12)
            msg = (f"step {step} loss {float(loss):.4f} l1 {float(loss_l1):.4f} psnr {psnr:.2f} "
                   f"n {len(g.means)} nrm {float(loss_n):.4f} dst {float(loss_d):.6f} "
                   f"mem {torch.cuda.max_memory_allocated() / 1e9:.2f}G "
                   f"{(time.time() - t0) / step:.2f}s/it")
            log(msg)
            with log_path.open("a", encoding="utf-8") as f:
                f.write(msg + "\n")

        # densify / prune：干净三步（prune → clone → split）
        if step % 100 == 0 and 500 <= step <= 15000 and len(g.means) < max_points and accum_n > 0:
            with torch.no_grad():
                grads = accum / max(accum_n, 1)
                thr = max(float(torch.quantile(grads, 0.98)), 1e-12)   # 自适应分位阈值
                s_max = g.scales[:, :2].max(1).values.exp()
                alive = (torch.sigmoid(g.opacity) >= 0.005) | (step < 3000)
                clone_m = (grads > thr) & (s_max <= 0.02) & alive
                split_m = (grads > thr) & (s_max > 0.02) & alive

                base = {a: getattr(g, a).data[alive] for a in ATTRS}
                clone_sel = clone_m[alive]
                split_sel = split_m[alive]
                new = dict(base)
                if int(clone_sel.sum()):
                    for a in ATTRS:
                        new[a] = torch.cat([new[a], base[a][clone_sel]], 0)
                if int(split_sel.sum()):
                    m0 = base["means"][split_sel]
                    sc = base["scales"][split_sel]
                    off = torch.randn(len(m0), 3, device="cuda") * sc[:, :2].exp().mean(1, keepdim=True)
                    halves = {a: base[a][split_sel] for a in ("quats", "scales", "opacity", "sh_dc", "sh_rest")}
                    sh = halves["scales"].clone()
                    sh[:, :2] = sh[:, :2] - math.log(1.6)
                    new["means"] = torch.cat([new["means"], m0 + off, m0 - off], 0)
                    for a in ("quats", "opacity", "sh_dc", "sh_rest"):
                        new[a] = torch.cat([new[a], halves[a], halves[a]], 0)
                    new["scales"] = torch.cat([new["scales"], sh, sh], 0)
                for a in ATTRS:
                    setattr(g, a, torch.nn.Parameter(new[a]))
                opt = make_opt()
                accum = torch.zeros(len(g.means), device="cuda")
                accum_n = 0

        if step % 5000 == 0 or step == iters:
            ck = out / f"ckpt-{step}.pt"
            torch.save({"step": step,
                        "params": {a: getattr(g, a).detach().cpu() for a in ATTRS}}, ck)
            export_ply(out / f"splat-2dgs-{step}.ply", g)
            log(f"[checkpoint] {ck}")

    export_ply(out / "splat-2dgs.ply", g)
    summary = {"step": step, "n": len(g.means), "elapsed_s": round(time.time() - t0, 1),
               "lambda_normal": lambda_normal, "lambda_dist": lambda_dist,
               "scene_scale": scene_scale, "cams": C, "resolution": [W, H]}
    (out / "DONE.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    log(f"DONE {out / 'splat-2dgs.ply'}")
    return summary


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="2DGS 训练（供 TSDF 表面重建）")
    ap.add_argument("--config", type=Path, required=True, help="nerfstudio 训练产物 config.yml")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--iters", type=int, default=15000)
    ap.add_argument("--max-points", type=int, default=600000)
    ap.add_argument("--lambda-normal", type=float, default=0.05)
    ap.add_argument("--lambda-dist", type=float, default=1.0)
    ap.add_argument("--init-ply", type=Path, default=None, help="热启动：已收敛的 3DGS PLY")
    args = ap.parse_args(argv)
    train(args.config, args.out, iters=args.iters, max_points=args.max_points,
          lambda_normal=args.lambda_normal, lambda_dist=args.lambda_dist,
          init_ply=args.init_ply)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
