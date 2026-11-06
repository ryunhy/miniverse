"""用 2DGS 检查点渲染每台相机的 RGB / alpha / 期望深度 / 法向（GPU）。

这些深度与法向是 TSDF 融合与纹理烘焙的唯一输入。深度语义为「沿相机 z 轴的
期望深度」（gsplat render_mode="RGB+ED" + depth_mode="expected"）。

用法（WSL，conda activate miniverse）：
  python -m app.mesh.render_depth --config <config.yml> --ckpt <ckpt.pt> --out <views_dir>
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from .camera_bank import load_nerfstudio_cameras
from .gsplat_bootstrap import bootstrap


def load_ckpt(path: Path) -> dict:
    ck = torch.load(Path(path), map_location="cuda")
    p = ck["params"]
    return {
        "step": int(ck.get("step", -1)),
        "means": p["means"].cuda(),
        "quats": F.normalize(p["quats"].cuda(), dim=-1),
        "scales": p["scales"].cuda(),
        "opacity": p["opacity"].cuda(),
        "sh_dc": p["sh_dc"].cuda(),
        "sh_rest": p["sh_rest"].cuda(),
    }


def render_view(g: dict, cam, sh_degree: int = 3) -> dict:
    from gsplat.rendering import rasterization_2dgs

    H, W = cam.height, cam.width
    viewmat = torch.tensor(cam.extrinsic_cv(), dtype=torch.float32, device="cuda")[None]
    K = torch.tensor(cam.K, dtype=torch.float32, device="cuda")[None]
    bg = torch.tensor([[1.0, 1.0, 1.0, 0.0]], device="cuda")
    with torch.no_grad():
        colors, alpha, rnorm, _snorm, _distort, median, _meta = rasterization_2dgs(
            g["means"], g["quats"], torch.exp(g["scales"]),
            g["opacity"].sigmoid(), torch.cat([g["sh_dc"], g["sh_rest"]], 1),
            viewmat, K, W, H,
            sh_degree=sh_degree, absgrad=False, distloss=False,
            render_mode="RGB+ED", backgrounds=bg, packed=True,
            depth_mode="expected")
    rgb = colors[0, ..., :3].clamp(0, 1).mul(255).byte().cpu().numpy()
    return {
        "rgb": rgb,
        "alpha": (alpha[0, ..., 0].clamp(0, 1) * 255).byte().cpu().numpy(),
        "depth": median[0, ..., 0].float().cpu().numpy(),
        "normal": rnorm[0].float().cpu().numpy(),      # (3,H,W) 单位法向
    }


def render_all(config_path: Path, ckpt_path: Path, out: Path, split: str = "all",
               limit: int = 0, log=print) -> dict:
    bootstrap()
    out.mkdir(parents=True, exist_ok=True)

    cams = load_nerfstudio_cameras(Path(config_path), split=split)
    if limit:
        cams = cams[:limit]
    log(f"[cameras] {len(cams)} (split={split}) {cams[0].width}x{cams[0].height}")

    g = load_ckpt(Path(ckpt_path))
    log(f"[ckpt] step={g['step']} n={len(g['means'])}")

    meta = []
    t0 = time.time()
    for i, cam in enumerate(cams):
        r = render_view(g, cam)
        stem = Path(cam.name).stem
        np.savez_compressed(out / f"view-{stem}.npz",
                            depth=r["depth"], alpha=r["alpha"], rgb=r["rgb"],
                            normal=r["normal"].astype(np.float16))
        meta.append({
            "index": i, "name": cam.name, "split": cam.split,
            "width": cam.width, "height": cam.height,
            "K": cam.K.tolist(), "c2w_gl": cam.c2w_gl.tolist(),
            "distortion": cam.distortion,
        })
        if (i + 1) % 20 == 0 or i == len(cams) - 1:
            log(f"  render [{i + 1}/{len(cams)}] {time.time() - t0:.1f}s")

    summary = {"count": len(meta), "split": split, "ckpt_step": g["step"],
               "resolution": [cams[0].width, cams[0].height],
               "elapsed_s": round(time.time() - t0, 1), "views": meta}
    (out / "views-meta.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    log(f"[views] {len(meta)} 视角 → {out}  {summary['elapsed_s']}s")
    return summary


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="2DGS 渲染深度/法向")
    ap.add_argument("--config", type=Path, required=True)
    ap.add_argument("--ckpt", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--split", choices=["train", "test", "all"], default="all")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args(argv)
    render_all(args.config, args.ckpt, args.out, split=args.split, limit=args.limit)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
