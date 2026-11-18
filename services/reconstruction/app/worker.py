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
    # 仅重试网格：复用上次重建的高斯产物，不重跑 COLMAP / 训练
    if bool(ctx.params.get("meshOnly", False)):
        return run_mesh_only(ctx)
    # 仅重试微缩：复用已有 COLMAP 稀疏模型，不重跑训练；不触碰主状态机
    if bool(ctx.params.get("miniatureOnly", False)):
        return run_miniature_only(ctx)
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

            # 可选：照片 → 微缩 GLB（T-700072 正式接入）。
            # 与网格增强彼此独立；失败保留原 3DGS/PLY 并如实标 failed/partial。
            if bool(ctx.params.get("miniature", False)):
                ctx.stage("miniature", 0.95)
                result["miniature"] = _miniature_stage(ctx)
                result["miniatureStatus"] = result["miniature"].get("status")
                if result["miniatureStatus"] not in ("ok", "degraded"):
                    log.warning("微缩失败（%s），原 3DGS 产物已保留：%s",
                                result["miniatureStatus"], result["miniature"].get("error"))

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
      meshExtraction  TSDF 提取方式 "occupancy"（默认，旧行为）| "sdf"
      meshBboxPercentile 场景边界离群裁剪 0–0.5（默认 0.5，旧行为）
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
            # 未显式传参 → 旧行为（occupancy + 0.5）；非法值由 export_mesh 抛错
            extraction=str(ctx.params.get("meshExtraction", "occupancy")),
            bbox_percentile=ctx.params.get("meshBboxPercentile", 0.5),
            log=lambda m: log.info("%s", m),
        )
        out = res.to_dict()
        out["seconds"] = round(time.time() - t0, 1)
        log.info("网格导出完成：%s %.2fMB", out["glbPath"], out["glbBytes"] / 1048576)
        return out
    except Exception as e:  # noqa: BLE001 - 增强项失败不阻断主交付
        log.exception("网格导出失败（高斯产物不受影响）")
        return {"error": f"{type(e).__name__}: {e}", "seconds": round(time.time() - t0, 1)}


def run_miniature_only(ctx: TaskContext) -> int:
    """只补跑微缩：复用已完成任务的 COLMAP 稀疏模型，不重跑训练。

    与主状态机分开上报：结果写 data/tasks/<id>/miniature-status.json，
    绝不把已完成的 status.json 回退成 processing/canceled。
    """
    log.info("MiniVerse worker 启动（仅微缩重试）：task=%s", ctx.task_id)

    def report(status: str, error: str | None = None, result: dict | None = None) -> None:
        payload: dict = {
            "status": status,
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        if error:
            payload["error"] = error
        if result:
            payload["result"] = result
        tmp = ctx.task_dir / "miniature-status.json.tmp"
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        tmp.replace(ctx.task_dir / "miniature-status.json")

    try:
        if (ctx.task_dir / "cancel.flag").exists():
            report("canceled")
            return 0

        sparse = ctx.work_dir / "colmap" / "sparse" / "0"
        if not sparse.exists():
            report("failed", "找不到 COLMAP 稀疏模型（colmap/sparse/0），只能重跑整个重建任务")
            return 1

        report("processing")
        out = _miniature_stage(ctx, report_main=False)
        st = out.get("status")
        if st in ("ok", "degraded"):
            report("completed", result=out)
            log.info("微缩重试完成：task=%s status=%s", ctx.task_id, st)
            return 0
        if st == "partial":
            # 内存不足等可恢复降级：如实写 partial，不冒充 completed
            report("partial", out.get("error"), out)
            log.warning("微缩重试部分完成：task=%s status=partial", ctx.task_id)
            return 1
        report("failed", out.get("error"), out)
        log.warning("微缩重试失败：task=%s status=%s", ctx.task_id, st)
        return 1
    except SystemExit:
        # 阶段内的取消走 sys.exit(0)：必须在这里落一次 canceled，
        # 否则 miniature-status.json 会永远停在 processing。
        report("canceled")
        log.warning("微缩重试已取消：task=%s", ctx.task_id)
        return 0
    except Exception as e:  # noqa: BLE001 - 单独重试也要如实上报，不静默
        report("failed", f"{type(e).__name__}: {e}")
        log.exception("微缩重试失败：task=%s", ctx.task_id)
        return 1


# ---------- 微缩链路（T-700072 正式接入） ----------

MINIATURE_STAGE_KEYS = ("ingest", "structure", "instances", "geometry", "texture")


def _blank_miniature_stages(detail: str) -> dict:
    stages = {k: {"state": "not_started", "detail": detail} for k in MINIATURE_STAGE_KEYS}
    stages["export"] = {"state": "failed", "detail": detail}
    return stages


def _miniature_stage(ctx: TaskContext, report_main: bool = True) -> dict:
    """照片 → 微缩 GLB，调用 app.miniature.pipeline 的正式编排。

    report_main=False 用于 miniatureOnly 重试：不写主 status.json。
    返回值直接进 result.miniature，结构对齐 T-700073 的 MiniaturePayload。
    """
    t0 = time.time()
    try:
        from app.miniature.pipeline import probe_env, run_miniature  # noqa: PLC0415
    except Exception as e:  # noqa: BLE001 - 依赖缺失如实上报
        return {
            "status": "failed",
            "error": f"微缩模块不可导入：{type(e).__name__}: {e}",
            "stages": _blank_miniature_stages("模块不可用"),
        }

    pre = probe_env(ctx.work_dir)
    if not pre["ready"]:
        return {
            "status": "unsupported",
            "error": "微缩依赖缺失：" + "、".join(pre["missing"]),
            "preflight": pre,
            "stages": _blank_miniature_stages("依赖缺失"),
        }
    if not pre["scene"]["colmap_ok"]:
        return {
            "status": "unsupported",
            "error": "缺少 COLMAP 稀疏模型（colmap/sparse/0），无法定位相机",
            "preflight": pre,
            "stages": _blank_miniature_stages("缺少 COLMAP 稀疏模型"),
        }

    if report_main:
        on_stage = lambda name, p: ctx.stage(f"miniature-{name}", 0.95 + 0.04 * p)  # noqa: E731
        check_cancel = ctx.check_cancel
    else:
        on_stage = lambda name, p: log.info("微缩阶段：%s（%.0f%%）", name, p * 100)  # noqa: E731

        def check_cancel() -> None:  # 只读 cancel.flag，不改主状态机
            if (ctx.task_dir / "cancel.flag").exists():
                log.warning("检测到取消标记，微缩重试退出")
                sys.exit(0)

    out_dir = ctx.export_dir / "miniature"
    try:
        res = run_miniature(
            ctx.work_dir,
            out_dir,
            params=ctx.params,
            reset_cache=bool(ctx.params.get("miniatureResetCache", False)),
            on_stage=on_stage,
            check_cancel=check_cancel,
            log=lambda m: log.info("miniature｜%s", m),
        )
    except SystemExit:
        raise  # 取消：由 ctx.check_cancel 或上面的 flag 检查负责上报
    except MemoryError as e:  # 微缩是 CPU 链路，内存不足时降级为 partial 并保留原产物
        return {
            "status": "partial",
            "error": f"微缩阶段内存不足：{e}；原 3DGS 产物已保留",
            "stages": _blank_miniature_stages("内存不足中止"),
        }
    except Exception as e:  # noqa: BLE001
        log.exception("微缩阶段异常")
        return {
            "status": "failed",
            "error": f"{type(e).__name__}: {e}",
            "stages": _blank_miniature_stages("异常中止"),
        }

    out = _miniature_payload(res, out_dir)
    out["preflight"] = pre
    out["seconds"] = round(time.time() - t0, 1)
    return out


def _miniature_payload(res: dict, out_dir: Path) -> dict:
    """把 pipeline 的数组式 stages 转成 T-700073 约定的 map，并补齐 export 阶段。"""
    rows = {s["name"]: s for s in (res.get("stages") or [])}
    docs: dict[str, dict] = {}
    for key in MINIATURE_STAGE_KEYS:
        # ingest 阶段的产物文件名是 input.json（输入清单），其余阶段与阶段同名
        path = out_dir / ("input.json" if key == "ingest" else f"{key}.json")
        if path.exists():
            try:
                docs[key] = json.loads(path.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001 - 产物损坏不阻断状态上报
                docs[key] = {}

    def state_of(key: str) -> tuple[str, str | None]:
        row = rows.get(key)
        if row is None:
            return "not_started", None
        if row.get("status") in ("ok", "degraded"):
            return "done", row.get("status")
        return "failed", row.get("reason") or row.get("status")

    def detail_of(text: str, st: str, note: str | None) -> str:
        """失败阶段必须把诊断码写进 detail，否则前端只能看到「进度条红了」却不知原因。"""
        return f"{text}｜失败原因：{note}" if st == "failed" and note else text

    stages: dict[str, dict] = {}

    st, note = state_of("ingest")
    ing = docs.get("ingest") or {}
    stages["ingest"] = {
        "state": st,
        "detail": detail_of(
            f"{len(ing.get('images') or [])} 张照片｜manifest {(ing.get('manifest_id') or '')[:12]}",
            st, note),
        "evidence": str(out_dir / "input.json"),
    }

    st, note = state_of("structure")
    doc = docs.get("structure") or {}
    floor = doc.get("floor") or {}
    walls = doc.get("kept_walls") or []
    # 真实产物里可见率在 visibility[<墙名>].seen_ratio；surface_visible 只是总体布尔值。
    # 早期契约提案写成 surface_visible 映射，这里两种形态都兼容，取不到就不写。
    vis = doc.get("visibility")
    if not isinstance(vis, dict):
        vis = doc.get("surface_visible")
    ratios = []
    if isinstance(vis, dict):
        for w in walls:
            item = vis.get(w)
            r = item.get("seen_ratio") if isinstance(item, dict) else item
            if isinstance(r, (int, float)):
                ratios.append(f"{w}={float(r):.3f}")
    vis_txt = "、".join(ratios)
    stages["structure"] = {
        "state": st,
        "detail": detail_of(
            f"保留 {'/'.join(walls) or '无'}｜地板内点率 {float(floor.get('inlier_ratio', 0)):.3f}"
            + (f"｜可见率 {vis_txt}" if vis_txt else ""), st, note),
        "evidence": str(out_dir / "structure.json"),
    }

    st, note = state_of("instances")
    doc = docs.get("instances") or {}
    stages["instances"] = {
        "state": st,
        "detail": detail_of(
            f"{doc.get('n_instances', 0)} 件家具｜退化跳过 {doc.get('n_degenerate_skipped', 0)}",
            st, note),
        "evidence": str(out_dir / "instances.json"),
    }

    st, note = state_of("geometry")
    doc = docs.get("geometry") or {}
    stages["geometry"] = {
        "state": st,
        "detail": detail_of(
            f"{doc.get('n_with_surface', 0)}/{doc.get('n_instances', 0)} 有真实表面"
            f"｜闭合 {doc.get('n_closed', 0)}", st, note),
        "evidence": str(out_dir / "geometry.json"),
    }

    st, note = state_of("texture")
    doc = docs.get("texture") or {}
    insts = doc.get("instances") or []
    obs = sum(int((i.get("coverage") or {}).get("n_observed_texels", 0)) for i in insts)
    cov = sum(int((i.get("coverage") or {}).get("n_covered_texels", 0)) for i in insts)
    ratio = round(obs / cov, 4) if cov else 0.0
    params = (res.get("cache") or {}).get("params") or {}
    stages["texture"] = {
        "state": st,
        "detail": detail_of(f"tex {params.get('tex_size', '')}｜observed {ratio:.3f}", st, note),
        "evidence": str(out_dir / "texture.json"),
    }

    art = res.get("artifacts") or {}
    glb_path = art.get("scene_glb")
    glb = None
    if glb_path:
        glb = {
            "path": str(Path(glb_path).resolve()),
            "bytes": art.get("scene_glb_bytes"),
            "sha256": art.get("scene_glb_sha256"),
        }
    stages["export"] = {
        "state": "done" if glb else "failed",
        "detail": (f"{glb['bytes'] / 1048576:.2f} MB｜sha {(glb['sha256'] or '')[:12]}"
                   if glb else (res.get("error") or "未产出 GLB")),
        "evidence": glb["path"] if glb else str(out_dir / "texture.json"),
    }

    out = {
        "status": res.get("status"),
        "stages": stages,
        "glb": glb,
        "provenance": {
            "photos": "original",
            "texture": "observed_from_photos",
            "observed_ratio": ratio,
            "inferred_ratio": round(1 - ratio, 4) if cov else 0.0,
        },
        # 有推断像素就必须标 synthetic=true（诚实原则：不让推断冒充实拍）
        "synthetic": bool(cov and (1 - ratio) > 1e-6),
        "cache": res.get("cache"),
        "diagnostics": res.get("diagnostics"),
    }
    if res.get("error"):
        out["error"] = res["error"]
    if res.get("failed_stage"):
        out["failed_stage"] = res["failed_stage"]
    return out


def _probe_miniature_env() -> dict:
    """preflight：微缩链路的库依赖（不含场景数据，场景在任务里探）。"""
    try:
        from app.miniature.pipeline import probe_env  # noqa: PLC0415

        return probe_env(None)
    except Exception as e:  # noqa: BLE001
        return {"ready": False, "missing": [f"pipeline({type(e).__name__})"], "error": str(e)}


def run_mesh_only(ctx: TaskContext) -> int:
    """只补跑网格导出：复用已完成任务的训练产物，不重跑 COLMAP / 高斯训练。

    与整条链路分开上报：结果写 data/tasks/<id>/mesh-status.json，
    不触碰主任务的 status.json（主任务已完成，不能把状态机回退到 processing）。
    """
    log.info("MiniVerse worker 启动（仅网格重试）：task=%s", ctx.task_id)

    def report(status: str, error: str | None = None, result: dict | None = None) -> None:
        payload: dict = {
            "status": status,
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        if error:
            payload["error"] = error
        if result:
            payload["result"] = result
        tmp = ctx.task_dir / "mesh-status.json.tmp"
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        tmp.replace(ctx.task_dir / "mesh-status.json")

    try:
        # 不走 ctx.check_cancel()：它会写主任务 status.json，把已完成的任务改成 canceled
        if (ctx.task_dir / "cancel.flag").exists():
            report("canceled")
            return 0

        configs = sorted((ctx.work_dir / "nerfstudio").rglob("config.yml"))
        if not configs:
            report("failed", "找不到上次重建留下的训练文件，只能重跑整个重建任务")
            return 1
        ply = ctx.export_dir / "scene.ply"
        if not ply.exists():
            report("failed", "找不到上次重建的高斯点云，只能重跑整个重建任务")
            return 1

        report("processing")
        out = _export_mesh_stage(ctx, configs[0].parent, ply)
        if out.get("error"):
            report("failed", str(out["error"]), out)
            return 1
        report("completed", result=out)
        log.info("网格重试完成：task=%s", ctx.task_id)
        return 0
    except Exception as e:  # noqa: BLE001 - 单独重试也要如实上报，不静默
        report("failed", f"{type(e).__name__}: {e}")
        log.exception("网格重试失败：task=%s", ctx.task_id)
        return 1


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
    # 微缩链路（miniature 可选增强，见 docs/miniature/DELIVERY.md）：同样只影响微缩，
    # 不改变主重建结论；这里只探库依赖，场景数据在任务内单独探。
    report["miniature"] = _probe_miniature_env()

    print(json.dumps(report, ensure_ascii=False, indent=2))
    # 结论行必须与上面探测到的实际值一致：只列真正缺的项，不写死字符串。
    missing_top = []
    if not report["colmap"]:
        missing_top.append("COLMAP")
    if not report["nerfstudio_ns_train"]:
        missing_top.append("ns-train（Nerfstudio CLI）")
    if not report.get("torch_cuda_available"):
        missing_top.append("CUDA")
    ok = not missing_top
    print("\n结论：%s" % (
        "✅ 满足真实重建条件" if ok
        else "❌ 尚不满足（缺 %s，见 docs/INSTALL-Windows-WSL2.md）" % "、".join(missing_top)))
    mesh = report["mesh"]
    if mesh["ready"]:
        print("网格导出（exportMesh）：✅ 就绪")
    else:
        print(f"网格导出（exportMesh）：❌ 不可用 —— {mesh['missing']}，见 docs/MESH.md")
    mini = report["miniature"]
    if mini.get("ready"):
        print("微缩链路（miniature）：✅ 就绪")
    else:
        print(f"微缩链路（miniature）：❌ 不可用 —— {'、'.join(mini.get('missing') or [])}，见 docs/miniature/DELIVERY.md")
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
