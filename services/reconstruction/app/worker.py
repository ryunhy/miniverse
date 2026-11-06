"""MiniVerse 重建 Worker。

与 Web 端通过文件协议解耦协作（data/tasks/<task_id>/）：
- 读取 input.json：{task_id, photo_dir, params, repo_root}
- 阶段上报 status.json：{status, stage, progress, error?, result?}
- 取消检测：cancel.flag 出现时立即退出并上报 canceled
- OOM 自动降级：训练显存不足时降低分辨率重试（最多 2 次）

环境不满足（无 COLMAP/Nerfstudio/CUDA）时如实上报 failed 与原因，绝不伪造成功。
"""
from __future__ import annotations

import json
import logging
import platform
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # services/reconstruction，使 app 包可导入

# pipeline 模块按需导入（无 Pillow/训练栈时 check-env 仍可用）
from app.pipeline.train_splat import query_vram_gb  # noqa: E402 - 仅标准库依赖，可安全顶层导入

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("worker")


def wsl_path(p: str) -> str:
    """Windows 路径 → WSL 路径（C:\\foo\\bar → /mnt/c/foo/bar）；已是 POSIX 则原样返回。"""
    import re

    m = re.match(r"^([A-Za-z]):[\\/](.*)$", p)
    if m:
        return f"/mnt/{m.group(1).lower()}/{m.group(2).replace(chr(92), '/')}"
    return p


class TaskContext:
    def __init__(self, task_id: str, data_dir: Path):
        self.task_id = task_id
        self.task_dir = Path(wsl_path(str(data_dir))) / "tasks" / task_id
        self.work_dir = Path(wsl_path(str(data_dir))) / "processed" / task_id
        self.export_dir = Path(wsl_path(str(data_dir))) / "reconstructions" / task_id
        self.input = json.loads((self.task_dir / "input.json").read_text(encoding="utf-8"))
        self.params: dict = self.input.get("params") or {}
        self._last_stage_file: Path | None = None

    def check_cancel(self) -> None:
        if (self.task_dir / "cancel.flag").exists():
            self.report("canceled", stage="cancel")
            log.warning("检测到取消标记，任务退出")
            sys.exit(0)

    def report(
        self,
        status: str,
        stage: str = "",
        progress: float = 0.0,
        error: str | None = None,
        result: dict | None = None,
    ) -> None:
        payload = {
            "status": status,
            "stage": stage,
            "progress": round(progress, 3),
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        if error:
            payload["error"] = error
        if result:
            payload["result"] = result
        tmp = self.task_dir / "status.json.tmp"
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.task_dir / "status.json")

    def stage(self, name: str, progress: float) -> None:
        """处理中阶段上报（幂等：仅阶段变化时写日志）"""
        self.check_cancel()
        if self._last_stage_file != name:
            log.info("进入阶段：%s（%.0f%%）", name, progress * 100)
            self._last_stage_file = name
        self.report("processing", stage=name, progress=progress)


def run_task(task_id: str, data_dir: Path) -> int:
    ctx = TaskContext(task_id, data_dir)
    log.info("MiniVerse worker 启动：task=%s", task_id)
    log.info("Python %s @ %s", platform.python_version(), platform.platform())
    ctx.report("processing", stage="init", progress=0.01)

    # pipeline 模块按需导入（无 Pillow/训练栈时 check-env 仍可用）
    from app.pipeline import colmap as colmap_mod  # noqa: PLC0415
    from app.pipeline import preprocess as preprocess_mod  # noqa: PLC0415
    from app.pipeline.train_splat import (  # noqa: PLC0415
        OutOfMemoryError_,
        export_gaussian_splat,
        find_nerfstudio,
        recommend_steps,
        train_splatfacto,
    )

    # 环境信息记录（真实探测，不假设）
    vram = query_vram_gb()
    env_info = {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "colmap": bool(colmap_mod.find_colmap()),
        "nerfstudio": find_nerfstudio(),
        "vram_gb": vram,
        "torch_cuda": None,
    }
    try:
        import torch  # noqa: PLC0415 - 可选依赖

        env_info["torch_cuda"] = torch.cuda.is_available()
    except ImportError:
        pass
    log.info("环境：%s", env_info)

    max_resolution = int(ctx.params.get("maxResolution", 1600))
    steps_override = ctx.params.get("steps")
    steps = recommend_steps(vram, steps_override)
    if vram is not None and vram < 8:
        max_resolution = min(max_resolution, 1200)  # 低显存保守策略
    log.info("参数：分辨率上限=%dpx，训练步数=%d（显存=%sGB）", max_resolution, steps, vram)

    # 处理循环：OOM 自动降级重试（最多 2 次）
    resolutions = [max_resolution]
    for factor in (0.75, 0.5):
        resolutions.append(int(max_resolution * factor))

    last_error: Exception | None = None
    for attempt, resolution in enumerate(resolutions):
        if attempt > 2:
            break
        try:
            ctx.check_cancel()

            ctx.stage("preprocess", 0.05)
            images = preprocess_mod.preprocess(
                Path(wsl_path(ctx.input["photo_dir"])), ctx.work_dir, max_resolution=resolution
            )

            ctx.stage("colmap", 0.2)
            # COLMAP GPU 支持需 CUDA 版二进制（apt 版为 CPU），由 params 显式控制
            colmap_gpu = bool(ctx.params.get("colmap_gpu", False))
            matcher = str(ctx.params.get("matcher", "exhaustive"))
            model_dir = colmap_mod.run_colmap(
                ctx.work_dir, ctx.work_dir / "images", use_gpu=colmap_gpu, matcher=matcher
            )
            ctx.stage("colmap-done", 0.45)

            # nerfstudio colmap dataparser 期望 <data>/colmap/sparse/0 结构，归位拷贝
            colmap_link = ctx.work_dir / "colmap" / "sparse" / "0"
            if not colmap_link.exists():
                (ctx.work_dir / "colmap" / "sparse").mkdir(parents=True, exist_ok=True)
                shutil.copytree(model_dir, colmap_link, dirs_exist_ok=True)
            ctx.stage("train", 0.5)
            run_dir = train_splatfacto(ctx.work_dir, ctx.work_dir, steps=steps)
            ctx.stage("export", 0.9)

            ply = export_gaussian_splat(ctx.work_dir, run_dir, ctx.export_dir)
            result = {
                "plyPath": str(ply.relative_to(data_dir)).replace("\\", "/"),
                "plyBytes": ply.stat().st_size,
                "gaussians": "see-metadata",
                "env": env_info,
                "resolution": resolution,
                "steps": steps,
                "attempts": attempt + 1,
            }

            # 可选：3DGS → 网格（2DGS + TSDF + 纹理烘焙）。
            # 这是增强项，失败不影响高斯交付——错误如实写进 result.mesh.error。
            if bool(ctx.params.get("exportMesh", False)):
                ctx.stage("mesh", 0.93)
                result["mesh"] = _export_mesh_stage(ctx, run_dir, ply)

            ctx.report("completed", stage="done", progress=1.0, result=result)
            log.info("任务完成 ✔  task=%s ply=%s", task_id, ply)
            return 0

        except OutOfMemoryError_ as e:
            last_error = e
            if attempt < 2:
                log.warning("显存不足，降低分辨率重试（%d → %d）", resolution, resolutions[attempt + 1])
                continue
            break
        except Exception as e:  # noqa: BLE001 - 顶层兜底，如实上报
            ctx.report("failed", stage="error", error=str(e))
            log.exception("任务失败：task=%s", task_id)
            return 1

    ctx.report("failed", stage="oom", error=f"多次降级后仍显存不足：{last_error}")
    log.error("任务失败（OOM 重试耗尽）")
    return 1


def _export_mesh_stage(ctx: TaskContext, run_dir: Path, ply: Path) -> dict:
    """3DGS → 网格增强阶段。任何异常都转成结构化结果，不中断任务。

    参数（input.json → params）：
      exportMesh      true 开启（默认关，网格比高斯慢很多）
      meshIters       2DGS 训练步数（默认 15000）
      meshTexSize     烘焙贴图边长（默认 4096）
      meshVoxel       TSDF 体素边长（场景单位，默认 0.015）
      meshFaces       目标面数上限（默认 250000）
    """
    t0 = time.time()
    try:
        from app.mesh import export_mesh  # noqa: PLC0415 - 重依赖，按需导入

        config = run_dir / "config.yml"
        if not config.exists():
            configs = sorted(run_dir.rglob("config.yml"))
            if not configs:
                raise RuntimeError(f"未找到训练配置 config.yml（{run_dir}）")
            config = configs[0]

        log.info("网格导出开始：config=%s init=%s", config, ply.name)
        res = export_mesh(
            config_path=config,
            export_dir=ctx.export_dir,
            work_dir=ctx.work_dir,
            iters=int(ctx.params.get("meshIters", 15000)),
            tex_size=int(ctx.params.get("meshTexSize", 4096)),
            voxel=float(ctx.params.get("meshVoxel", 0.015)),
            target_faces=int(ctx.params.get("meshFaces", 250000)),
            init_ply=ply,               # 用已收敛的 3DGS 热启动 2DGS
            keep_views=False,
            log=lambda m: log.info("%s", m),
        )
        out = res.to_dict()
        out["seconds"] = round(time.time() - t0, 1)
        log.info("网格导出完成：%s %.2fMB", out["glbPath"], out["glbBytes"] / 1048576)
        return out
    except Exception as e:  # noqa: BLE001 - 增强项失败不阻断主交付
        log.exception("网格导出失败（高斯产物不受影响）")
        return {"error": f"{type(e).__name__}: {e}", "seconds": round(time.time() - t0, 1)}


def check_env() -> int:
    """环境自检，输出 JSON 报告（供人工诊断与 docs 对照）。"""
    from app.pipeline import colmap as colmap_mod  # noqa: PLC0415
    from app.pipeline.train_splat import find_nerfstudio, recommend_steps  # noqa: PLC0415

    vram = query_vram_gb()
    report = {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "colmap": bool(colmap_mod.find_colmap()),
        "nerfstudio_ns_train": find_nerfstudio(),
        "vram_gb": vram,
        "recommended": {
            "max_resolution": 1200 if (vram or 0) < 8 else 1600,
            "steps": recommend_steps(vram, None),
        },
    }
    try:
        import torch  # noqa: PLC0415 - 可选依赖；import 链可能因 tqdm/colorama 等冲突崩溃

        report["torch"] = torch.__version__
        report["torch_cuda_available"] = torch.cuda.is_available()
        if torch.cuda.is_available():
            report["gpu"] = torch.cuda.get_device_name(0)
    except Exception as e:  # noqa: BLE001 - torch 导入链冲突（如 tqdm/colorama）也如实记录
        report["torch"] = None
        report["torch_cuda_available"] = False
        report["torch_import_error"] = f"{type(e).__name__}: {e}"

    # 网格链路（exportMesh 可选增强，见 docs/MESH.md）：缺依赖不影响高斯交付，
    # 但开启 exportMesh 前必须先看到这里全绿。
    report["mesh"] = _probe_mesh_env()

    print(json.dumps(report, ensure_ascii=False, indent=2))
    ok = report["colmap"] and report["nerfstudio_ns_train"] and report.get("torch_cuda_available")
    print("\n结论：%s" % ("✅ 满足真实重建条件" if ok else "❌ 尚不满足（缺 COLMAP / Nerfstudio / CUDA，见 docs/INSTALL-Windows-WSL2.md）"))
    mesh = report["mesh"]
    if mesh["ready"]:
        print("网格导出（exportMesh）：✅ 就绪")
    else:
        print(f"网格导出（exportMesh）：❌ 不可用 —— {mesh['missing']}，见 docs/MESH.md")
    return 0 if ok else 2


def _probe_mesh_env() -> dict:
    """探测 2DGS + TSDF 网格链路的依赖是否齐备。

    分三档：库是否可导入（open3d/xatlas/trimesh）、gsplat CUDA 扩展是否可注入
    （rasterization_2dgs 的唯一硬依赖）、nerfstudio 相机解析是否可用。
    """
    probe: dict = {"packages": {}, "gsplat_csrc": None, "nerfstudio": None}
    missing: list[str] = []

    for mod in ("open3d", "xatlas", "trimesh", "cv2"):
        try:
            m = __import__(mod)
            probe["packages"][mod] = getattr(m, "__version__", "unknown")
        except Exception as e:  # noqa: BLE001 - 依赖缺失如实记录
            probe["packages"][mod] = None
            missing.append(mod)

    try:
        from app.mesh.gsplat_bootstrap import bootstrap  # noqa: PLC0415

        probe["gsplat_csrc"] = bool(bootstrap())
    except Exception as e:  # noqa: BLE001
        probe["gsplat_csrc"] = False
        probe["gsplat_error"] = f"{type(e).__name__}: {e}"
        missing.append("gsplat csrc")

    try:
        import nerfstudio  # noqa: F401,PLC0415 - 仅验证可导入
        from importlib.metadata import version as _pkg_version  # noqa: PLC0415

        probe["nerfstudio"] = _pkg_version("nerfstudio")
    except Exception as e:  # noqa: BLE001
        probe["nerfstudio"] = None
        probe["nerfstudio_error"] = f"{type(e).__name__}: {e}"
        missing.append("nerfstudio")

    probe["ready"] = not missing
    probe["missing"] = "、".join(missing) if missing else ""
    return probe
