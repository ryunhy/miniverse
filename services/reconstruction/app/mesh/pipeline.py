"""3DGS → 网格 全链路编排：2DGS 训练 → 深度渲染 → 标定 → TSDF → 纹理 → GLB。

设计要点：
- 每一步产物都落盘（ckpt / views / mesh.ply / mesh.glb + stats），任一步失败可续跑；
- 2DGS 是可选增强：失败时不影响主链路（scene.ply 仍可交付），错误如实记录；
- 深度拟合参数由 depth_calib 按数据集实测得出，不沿用其他数据集的常数。
"""
from __future__ import annotations

import json
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import depth_calib, render_depth, texture_bake, train_2dgs, tsdf_mesh
from .tsdf_options import resolve_tsdf_options


@dataclass
class MeshResult:
    glb: Path | None
    ply: Path | None
    texture: Path | None
    stats: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "glbPath": str(self.glb) if self.glb else None,
            "glbBytes": self.glb.stat().st_size if self.glb and self.glb.exists() else 0,
            "meshPlyPath": str(self.ply) if self.ply else None,
            "texturePath": str(self.texture) if self.texture else None,
            "stats": self.stats,
        }


def find_sparse_dir(config_path: Path, max_up: int = 6) -> Path | None:
    """向上逐级查找 COLMAP 稀疏点目录。

    本仓库布局：<task>/colmap/sparse/0 与 <task>/nerfstudio/.../run/config.yml，
    因此 config 的 parents[4] 才是任务根目录；但不同导出方式层级会变，
    这里按「从近到远」扫 <parent>/colmap/sparse/0 与 <parent>/sparse/0 兜底。
    """
    p = Path(config_path).resolve()
    for up in range(1, max_up + 1):
        if len(p.parents) <= up:
            break
        root = p.parents[up]
        for rel in ("colmap/sparse/0", "sparse/0"):
            cand = root / rel
            if (cand / "cameras.bin").exists() or (cand / "cameras.txt").exists():
                return cand
    return None


def export_mesh(config_path: Path, export_dir: Path, work_dir: Path,
                iters: int = 15000, tex_size: int = 4096, voxel: float = 0.015,
                target_faces: int = 250000, init_ply: Path | None = None,
                keep_views: bool = False, log=print,
                extraction: str = "occupancy", bbox_percentile: float = 0.5) -> MeshResult:
    """跑完整网格链路。产物写入 export_dir：mesh.glb / mesh.ply / mesh-texture.png。

    config_path : nerfstudio 训练产物 config.yml（相机与坐标系来源）
    export_dir  : 最终产物目录（与 scene.ply 同级）
    work_dir    : 中间产物目录（ckpt / views / TSDF）
    extraction  : TSDF 提取方式，"occupancy"（旧行为，默认）| "sdf"
    bbox_percentile : 场景边界离群裁剪比例，0–0.5（默认 0.5，即旧行为）

    非法参数直接抛 ValueError：不做静默回退，避免"以为换了算法其实没换"。
    """
    extraction, bbox_percentile = resolve_tsdf_options(extraction, bbox_percentile)
    t0 = time.time()
    export_dir = Path(export_dir)
    work_dir = Path(work_dir)
    export_dir.mkdir(parents=True, exist_ok=True)
    mesh_work = work_dir / "mesh"
    mesh_work.mkdir(parents=True, exist_ok=True)

    stats: dict = {"config": str(config_path), "iters": iters, "tex_size": tex_size,
                   "voxel": voxel, "target_faces": target_faces}

    # 1) 2DGS 训练（可从已收敛的 3DGS PLY 热启动，显著缩短收敛时间）
    #    可续跑：若目标步数的 ckpt 已存在且步数一致，直接复用，不重复训练。
    t = time.time()
    train_dir = mesh_work / "2dgs"
    ckpt = train_dir / f"ckpt-{iters}.pt"
    if ckpt.exists():
        done = train_dir / "DONE.json"
        reused = json.loads(done.read_text(encoding="utf-8")) if done.exists() else {}
        log(f"[mesh] 1/5 2DGS 训练 —— 复用已有检查点 {ckpt.name}（step={reused.get('step', iters)}）")
        train_summary = {**reused, "step": int(reused.get("step", iters)), "reused": True}
    else:
        log("[mesh] 1/5 2DGS 训练")
        train_summary = train_2dgs.train(
            Path(config_path), train_dir, iters=iters,
            init_ply=Path(init_ply) if init_ply else None, log=log)
        train_summary = {**train_summary, "reused": False}
        ckpt = train_dir / f"ckpt-{train_summary['step']}.pt"
    stats["train"] = {**train_summary, "seconds": round(time.time() - t, 1)}

    # 2) 渲染深度/法向
    t = time.time()
    log("[mesh] 2/5 渲染深度与法向")
    views = mesh_work / "views"
    views_summary = render_depth.render_all(Path(config_path), ckpt, views, split="train", log=log)
    stats["render"] = {"count": views_summary["count"], "seconds": round(time.time() - t, 1)}

    # 3) 深度标定：确认渲染深度与 COLMAP 点深度同一尺度
    t = time.time()
    log("[mesh] 3/5 深度标定")
    sparse = find_sparse_dir(config_path)
    transform = Path(config_path).parent / "dataparser_transforms.json"
    fit_a, fit_b = 1.0, 0.0
    calib = {}
    if sparse is not None and transform.exists():
        calib = depth_calib.calibrate(views, sparse, transform,
                                      out=mesh_work / "depth-calibration.json", log=log)
        fit = calib["fit_render_to_point"]
        # 只在偏差显著时启用校正，避免过拟合噪声
        if abs(fit["a"] - 1) > 0.05 or abs(fit["b"]) > 0.05:
            fit_a, fit_b = fit["a"], fit["b"]
            log(f"[mesh] 启用深度校正 a={fit_a:.6f} b={fit_b:.6f}")
        stats["depth_calibration"] = {k: calib[k] for k in
                                      ("num_samples", "fit_render_to_point", "ratio_median", "conclusion")}
    else:
        log(f"[mesh] 跳过深度标定（缺少 sparse={sparse} 或 transform={transform}）")
        stats["depth_calibration"] = {"skipped": True}
    stats["depth_fit"] = {"a": fit_a, "b": fit_b}
    stats["calib_seconds"] = round(time.time() - t, 1)

    # 4) TSDF → 三角网格
    t = time.time()
    log("[mesh] 4/5 TSDF 融合")
    mesh_ply_work = mesh_work / "mesh-tsdf.ply"
    # 提取方式与边界裁剪由调用方显式传入（任务 params 的 meshExtraction /
    # meshBboxPercentile）；默认 occupancy + 0.5 保持旧行为，历史重试不受影响。
    # 新参数（sdf + 0.1）的对照证据见 outputs/2026-11-11/algorithm-optimization。
    tsdf_stats = tsdf_mesh.build_tsdf(views, mesh_ply_work, voxel=voxel,
                                      target_faces=target_faces,
                                      depth_fit=(fit_a, fit_b), log=log,
                                      extraction=extraction,
                                      bbox_percentile=bbox_percentile)
    stats["tsdf"] = tsdf_stats
    stats["tsdf_seconds"] = round(time.time() - t, 1)

    if tsdf_stats["faces"] < 1000:
        raise RuntimeError(f"TSDF 网格过小（faces={tsdf_stats['faces']}），无法烘焙纹理")

    # 5) 纹理烘焙 → GLB
    t = time.time()
    log("[mesh] 5/5 纹理烘焙 → GLB")
    glb = export_dir / "mesh.glb"
    tex = export_dir / "mesh-texture.png"
    bake_stats = texture_bake.bake_to_glb(mesh_ply_work, views, glb, tex_size=tex_size,
                                          depth_fit=(fit_a, fit_b), texture_out=tex, log=log)
    stats["bake"] = bake_stats
    stats["bake_seconds"] = round(time.time() - t, 1)

    # 归档产物：mesh.ply 与 GLB 同级，便于前端与人工检查
    mesh_ply_out = export_dir / "mesh.ply"
    shutil.copyfile(mesh_ply_work, mesh_ply_out)

    stats["total_seconds"] = round(time.time() - t0, 1)
    stats["vertices"] = bake_stats["vertices"]
    stats["faces"] = bake_stats["faces"]
    (export_dir / "mesh-metadata.json").write_text(
        json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")

    if not keep_views:
        shutil.rmtree(views, ignore_errors=True)

    log(f"[mesh] 完成：{glb.name} {glb.stat().st_size / 1048576:.2f}MB  "
        f"verts={stats['vertices']} faces={stats['faces']}  {stats['total_seconds']}s")
    return MeshResult(glb=glb, ply=mesh_ply_out, texture=tex, stats=stats)
