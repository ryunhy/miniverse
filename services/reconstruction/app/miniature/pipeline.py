"""微缩重建的正式编排入口（Task 072）。

把 067–070 交付的四个真实模块接进 Worker 的既有文件协议，取代之前散落在
workspaces/ 下的一次性脚本：

    ingest（照片/COLMAP 清单） → structure（地板+两面墙） → instances（家具实例）
    → geometry（三角面） → texture（原图烘焙+GLB）

三条硬规则
- 不依赖临时脚本：每个阶段都是 app.miniature 里的正式函数，参数只来自 input.json。
- 缓存按「输入 + 参数 + 代码指纹」失效：任一变化都会让下游阶段重跑，不做静默复用。
- 失败不掩盖：任一阶段失败都如实返回 partial/failed，已完成的产物路径保留，
  Worker 据此保留原 3DGS 交付，不把微缩失败报成成功。
"""
from __future__ import annotations

import json
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

from . import contracts as C
from .ingest import _find_colmap, scan_scene


def _load_json(path: Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))

SCHEMA = "miniature.pipeline.v1"
PIPELINE_VERSION = "1.0.0"

# 默认参数与 070/071 冻结值一致：纹理边长 512（3GB 内存下三场景串行的上限），
# 实例体素用 nu 单位（SfM 无米制基准，不能写成米）。
DEFAULT_PARAMS = {
    "tex_size": 512,
    "voxel_nu": 0.05,  # 与 071 基准套件默认值一致（0.02 会把家具碎成 4 块，实测）
    "alpha_factor": 2.0,
}

STAGES = ("ingest", "structure", "instances", "geometry", "texture")

# 阶段进度（Worker 把它映射到自己的 0~1 全局进度）
STAGE_PROGRESS = {
    "ingest": 0.04,
    "structure": 0.20,
    "instances": 0.42,
    "geometry": 0.68,
    "texture": 0.88,
}

# 这些异常表示「数据不支持」，不是程序 bug：要报 unsupported 而不是 failed
UNSUPPORTED_ERRORS = ("NO_POINTS3D", "NO_FLOOR_PLANE", "TOO_FEW_POINTS", "NO_IMAGES")


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _log(log, msg: str, *args) -> None:
    if log is not None:
        log(msg % args if args else msg)


def code_fingerprint() -> str:
    """app/miniature/*.py 的内容指纹。

    改任何一行代码都会让缓存键变化——否则修完写入器缺陷后，旧缓存会让坏 GLB 继续被复用。
    """
    here = Path(__file__).resolve().parent
    parts = [f"{p.name}:{C.sha256_file(p)}" for p in sorted(here.glob("*.py"))]
    return C.sha256_text(f"{PIPELINE_VERSION}|" + "|".join(parts))


def resolve_params(params: dict | None) -> dict:
    """从 input.json 的 params 里取微缩参数，缺省走冻结值；类型错误立即失败。"""
    p = dict(DEFAULT_PARAMS)
    src = params or {}
    mapping = {
        "tex_size": ("miniatureTexSize", int),
        "voxel_nu": ("miniatureVoxel", float),
        "alpha_factor": ("miniatureAlphaFactor", float),
    }
    for out_key, (in_key, cast) in mapping.items():
        if in_key in src and src[in_key] is not None:
            p[out_key] = cast(src[in_key])
    return p


def cache_key(manifest_id: str, params: dict, code: str | None = None) -> str:
    """阶段缓存键 = 输入（manifest_id）+ 参数 + 代码指纹 + 管线版本。

    四者任一变化都必须让缓存失效；代码指纹缺省现算，测试时可注入固定值。
    """
    return C.sha256_text(C.canonical_json({
        "version": PIPELINE_VERSION,
        "manifest_id": manifest_id,
        "params": params,
        "code": code or code_fingerprint(),
    }))


def probe_env(scene_dir: Path | None = None) -> dict:
    """微缩链路依赖自检（preflight）。缺什么就报什么，不假设已装。"""
    import platform

    probe: dict = {"python": platform.python_version(), "packages": {}}
    missing: list[str] = []
    for mod in ("numpy", "cv2", "scipy", "shapely", "trimesh", "xatlas", "PIL"):
        try:
            m = __import__(mod)
            probe["packages"][mod] = getattr(m, "__version__", "unknown")
        except Exception as e:  # noqa: BLE001 - 依赖缺失如实记录
            probe["packages"][mod] = None
            missing.append(f"{mod}({type(e).__name__})")

    probe["missing"] = missing
    probe["ready"] = not missing

    if scene_dir is not None:
        scene = Path(scene_dir)
        colmap = _find_colmap(scene)
        img_dir = scene / "images"
        n_images = len([p for p in img_dir.iterdir() if p.is_file()]) if img_dir.is_dir() else 0
        probe["scene"] = {
            "path": str(scene),
            "n_images": n_images,
            "colmap_sparse": str(colmap) if colmap else None,
            "colmap_ok": colmap is not None,
        }
        probe["ready_for_scene"] = probe["ready"] and colmap is not None and n_images > 0
    return probe


def _cache_path(cache_dir: Path, stage: str) -> Path:
    return cache_dir / f"{stage}.json"


def _read_cache(cache_dir: Path, stage: str, key: str, log) -> dict | None:
    path = _cache_path(cache_dir, stage)
    if not path.exists():
        return None
    try:
        rec = _load_json(path)
    except Exception as e:  # noqa: BLE001 - 缓存损坏按未命中处理
        _log(log, "缓存 %s 读取失败，忽略：%s", stage, e)
        return None
    if rec.get("cache_key") != key:
        _log(log, "缓存 %s 命中但键已变化（输入/参数/代码），重跑", stage)
        return None
    return rec


def _write_cache(cache_dir: Path, stage: str, key: str, doc: dict, doc_path: Path,
                 seconds: float) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    C.write_json(_cache_path(cache_dir, stage), {
        "stage": stage,
        "cache_key": key,
        "status": doc.get("status"),
        "output": str(doc_path),
        "output_sha256": C.sha256_file(doc_path),
        "seconds": round(seconds, 3),
        "created_at": _now(),
    })


def _doc_intact(doc: dict) -> bool:
    """缓存复用的完整性复核：JSON 还在不够，它引用的 GLB 也必须还在且字节数一致。"""
    if doc.get("scene_glb"):
        glb = Path(doc["scene_glb"]["path"])
        if not glb.exists() or glb.stat().st_size != doc["scene_glb"]["bytes"]:
            return False
    for inst in doc.get("instances") or []:
        glb = inst.get("glb")
        if glb and not Path(glb).exists():
            return False
    return True


def _stage_result(name: str, status: str, seconds: float, output: Path | None,
                  cached: bool = False, reason: str | None = None) -> dict:
    row = {
        "name": name,
        "status": status,
        "seconds": round(seconds, 3),
        "cached": cached,
    }
    if output is not None:
        row["output"] = str(output)
    if reason:
        row["reason"] = reason
    return row


def run_miniature(
    scene_dir: Path,
    out_dir: Path,
    *,
    params: dict | None = None,
    reset_cache: bool = False,
    on_stage=None,
    check_cancel=None,
    log=None,
) -> dict:
    """跑完整微缩链路。返回结构化结果，不向外抛普通异常（取消除外）。

    scene_dir 需包含 images/ 与 colmap/sparse/0（或 sparse/0）。
    out_dir 存放各阶段 JSON、贴图、GLB 与 cache/。
    """
    scene = Path(scene_dir)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    cache_dir = out / "cache"
    p = resolve_params(params)
    code = code_fingerprint()

    t_all = time.time()
    stages: list[dict] = []
    docs: dict[str, dict] = {}
    diags: list[dict] = []
    status = "ok"

    def cancel_check() -> None:
        if check_cancel is not None:
            check_cancel()

    def enter(name: str) -> None:
        cancel_check()
        if on_stage is not None:
            on_stage(name, STAGE_PROGRESS[name])

    def fail(name: str, status_: str, reason: str, t0: float, recorded: bool = False) -> dict:
        # recorded=True：该阶段已有一条成功记录（如 ingest 判 unsupported），
        # 只改写它的状态与原因，不再追加重复行。
        if recorded and stages and stages[-1]["name"] == name:
            stages[-1].update({"status": status_, "reason": reason})
        else:
            stages.append(_stage_result(name, status_, time.time() - t0, None, reason=reason))
        return {
            "schema": SCHEMA,
            "status": status_,
            "failed_stage": name,
            "error": reason,
            "cache": {"key": None, "code": code, "params": p, "reused": [s["name"] for s in stages if s.get("cached")]},
            "stages": stages,
            "artifacts": _artifacts(docs),
            "diagnostics": diags,
            "seconds": round(time.time() - t_all, 2),
            "preserved": "已完成的阶段产物保留在 out_dir，可带 miniatureResetCache=false 续跑",
            "finished_at": _now(),
        }

    # ---- 1) ingest：照片与 COLMAP 清单（轻量，总是跑；它产出缓存键的输入部分）
    enter("ingest")
    t0 = time.time()
    try:
        manifest = scan_scene(scene, scene.name or "scene")
        manifest_doc = manifest.as_dict()
        violations = C.validate_manifest(manifest_doc)
        if violations:
            raise RuntimeError("MANIFEST_INVALID: " + "; ".join(violations))
    except Exception as e:  # noqa: BLE001 - 上传协议问题如实上报
        _log(log, "ingest 失败：%s", e)
        return fail("ingest", "failed", f"{type(e).__name__}: {e}", t0)

    docs["ingest"] = manifest_doc
    ingest_path = out / "input.json"
    C.write_json(ingest_path, manifest_doc)
    stages.append(_stage_result("ingest", manifest_doc["status"], time.time() - t0, ingest_path))
    diags.extend(manifest_doc.get("diagnostics") or [])
    _log(log, "ingest：status=%s images=%d manifest=%s", manifest_doc["status"],
         len(manifest_doc["images"]), manifest_doc["manifest_id"][:12])

    # 输入不满足（照片不足 / 朝向覆盖不够）时，不进入下游——避免拿坏输入硬算
    if manifest_doc["status"] == "unsupported":
        return fail("ingest", "unsupported",
                    "输入清单判 unsupported：" + "; ".join(
                        f"{d['code']}" for d in diags if d.get("severity") == "error"), t0,
                    recorded=True)

    cache_key_ = cache_key(manifest_doc["manifest_id"], p, code)
    reused: list[str] = []

    # ---- 2) structure：地板 + 两面主墙
    enter("structure")
    t0 = time.time()
    st_path = out / "structure.json"
    cached = None if reset_cache else _read_cache(cache_dir, "structure", cache_key_, log)
    if cached and st_path.exists() and C.sha256_file(st_path) == cached.get("output_sha256"):
        structure = _load_json(st_path)
        if not _doc_intact(structure):
            cached = None
    if cached and st_path.exists() and C.sha256_file(st_path) == cached.get("output_sha256"):
        stages.append(_stage_result("structure", structure.get("status"), cached.get("seconds", 0),
                                    st_path, cached=True))
        reused.append("structure")
        _log(log, "structure：复用缓存（%s）", structure.get("status"))
    else:
        try:
            from .structure import infer_structure

            structure = infer_structure(scene)
            C.write_json(st_path, structure)
            _write_cache(cache_dir, "structure", cache_key_, structure, st_path, time.time() - t0)
            stages.append(_stage_result("structure", structure.get("status"), time.time() - t0, st_path))
            diags.extend(structure.get("diagnostics") or [])
            _log(log, "structure：status=%s 用时=%.1fs", structure.get("status"), time.time() - t0)
        except MemoryError:
            raise  # 内存不足要交给 Worker 记 partial，不能当普通失败吞掉
        except Exception as e:  # noqa: BLE001
            _log(log, "structure 失败堆栈：%s", traceback.format_exc())
            msg = f"{type(e).__name__}: {e}"
            unsupported = isinstance(e, RuntimeError) and any(k in str(e) for k in UNSUPPORTED_ERRORS)
            return fail("structure", "unsupported" if unsupported else "failed", msg, t0)
    docs["structure"] = structure
    if structure.get("status") == "unsupported":
        return fail("structure", "unsupported",
                    "结构推断判 unsupported，下游不再执行", t0)

    # ---- 3) instances：家具实例
    enter("instances")
    t0 = time.time()
    ins_path = out / "instances.json"
    cached = None if reset_cache else _read_cache(cache_dir, "instances", cache_key_, log)
    if cached and ins_path.exists() and C.sha256_file(ins_path) == cached.get("output_sha256"):
        instances = _load_json(ins_path)
        if _doc_intact(instances):
            stages.append(_stage_result("instances", instances.get("status"), cached.get("seconds", 0),
                                        ins_path, cached=True))
            reused.append("instances")
            _log(log, "instances：复用缓存（%s）", instances.get("status"))
        else:
            cached = None
    if not cached:
        try:
            from .instances import detect_instances, load_nerf_transform

            # dataparser 变换是 aabb_nu 与「相机/3DGS 所在世界」之间唯一缺的一环；
            # 找不到就传 None，instances 会只输出局部系并记 warn，不猜变换。
            instances = detect_instances(
                scene,
                structure,
                voxel_nu=p["voxel_nu"],
                nerf_transform=load_nerf_transform(scene),
            )
            C.write_json(ins_path, instances)
            _write_cache(cache_dir, "instances", cache_key_, instances, ins_path, time.time() - t0)
            stages.append(_stage_result("instances", instances.get("status"), time.time() - t0, ins_path))
            diags.extend(instances.get("diagnostics") or [])
            _log(log, "instances：status=%s n=%s 用时=%.1fs", instances.get("status"),
                 instances.get("n_instances"), time.time() - t0)
        except MemoryError:
            raise  # 内存不足要交给 Worker 记 partial，不能当普通失败吞掉
        except Exception as e:  # noqa: BLE001
            _log(log, "instances 失败堆栈：%s", traceback.format_exc())
            return fail("instances", "failed", f"{type(e).__name__}: {e}", t0)
    docs["instances"] = instances
    if instances.get("status") == "unsupported":
        return fail("instances", "unsupported", "实例检测判 unsupported，下游不再执行", t0)

    # ---- 4) geometry：逐实例三角面 + 闭合检查
    enter("geometry")
    t0 = time.time()
    geo_path = out / "geometry.json"
    cached = None if reset_cache else _read_cache(cache_dir, "geometry", cache_key_, log)
    if cached and geo_path.exists() and C.sha256_file(geo_path) == cached.get("output_sha256"):
        geometry = _load_json(geo_path)
        if _doc_intact(geometry):
            stages.append(_stage_result("geometry", geometry.get("status"), cached.get("seconds", 0),
                                        geo_path, cached=True))
            reused.append("geometry")
            _log(log, "geometry：复用缓存（%s）", geometry.get("status"))
        else:
            cached = None
    if not cached:
        try:
            from .geometry import build_geometry

            geometry = build_geometry(scene, structure, instances, out_dir=out,
                                      export_glb=True, alpha_factor=p["alpha_factor"])
            C.write_json(geo_path, geometry)
            _write_cache(cache_dir, "geometry", cache_key_, geometry, geo_path, time.time() - t0)
            stages.append(_stage_result("geometry", geometry.get("status"), time.time() - t0, geo_path))
            diags.extend(geometry.get("diagnostics") or [])
            _log(log, "geometry：status=%s 有面=%s/%s 用时=%.1fs", geometry.get("status"),
                 geometry.get("n_with_surface"), geometry.get("n_instances"), time.time() - t0)
        except MemoryError:
            raise  # 内存不足要交给 Worker 记 partial，不能当普通失败吞掉
        except Exception as e:  # noqa: BLE001
            _log(log, "geometry 失败堆栈：%s", traceback.format_exc())
            return fail("geometry", "failed", f"{type(e).__name__}: {e}", t0)
    docs["geometry"] = geometry
    if geometry.get("status") == "unsupported":
        return fail("geometry", "unsupported", "几何生成判 unsupported，下游不再执行", t0)

    # ---- 5) texture：原图烘焙 + 场景 GLB
    enter("texture")
    t0 = time.time()
    tex_path = out / "texture.json"
    cached = None if reset_cache else _read_cache(cache_dir, "texture", cache_key_, log)
    if cached and tex_path.exists() and C.sha256_file(tex_path) == cached.get("output_sha256"):
        texture = _load_json(tex_path)
        if _doc_intact(texture):
            stages.append(_stage_result("texture", texture.get("status"), cached.get("seconds", 0),
                                        tex_path, cached=True))
            reused.append("texture")
            _log(log, "texture：复用缓存（%s）", texture.get("status"))
        else:
            cached = None
    if not cached:
        try:
            from .texture import build_texture

            texture = build_texture(scene, structure, instances, out_dir=out,
                                    tex_size=p["tex_size"], export_glb=True)
            C.write_json(tex_path, texture)
            _write_cache(cache_dir, "texture", cache_key_, texture, tex_path, time.time() - t0)
            stages.append(_stage_result("texture", texture.get("status"), time.time() - t0, tex_path))
            diags.extend(texture.get("diagnostics") or [])
            _log(log, "texture：status=%s glb=%s 用时=%.1fs", texture.get("status"),
                 (texture.get("scene_glb") or {}).get("bytes"), time.time() - t0)
        except MemoryError:
            raise  # 内存不足要交给 Worker 记 partial，不能当普通失败吞掉
        except Exception as e:  # noqa: BLE001
            _log(log, "texture 失败堆栈：%s", traceback.format_exc())
            return fail("texture", "failed", f"{type(e).__name__}: {e}", t0)
    docs["texture"] = texture

    # ---- 汇总：status 取最保守的一档
    st_values = [texture.get("status"), geometry.get("status")]
    if any(s == "degraded" for s in st_values):
        status = "degraded"
    if texture.get("status") == "unsupported":
        status = "unsupported"
    glb = texture.get("scene_glb")
    if status == "ok" and not glb:
        status = "failed"

    result = {
        "schema": SCHEMA,
        "status": status,
        "cache": {"key": cache_key_, "code": code, "params": p, "reused": reused},
        "stages": stages,
        "artifacts": _artifacts(docs),
        "diagnostics": diags,
        "seconds": round(time.time() - t_all, 2),
        "finished_at": _now(),
    }
    if status == "failed":
        result["error"] = "texture 阶段没有产出 scene_glb"
    _log(log, "微缩完成：status=%s 复用=%s 用时=%.1fs", status, reused or "无", result["seconds"])
    return result


def _artifacts(docs: dict) -> dict:
    """把各阶段的产物路径汇总成下游可直接消费的一层。"""
    texture = docs.get("texture") or {}
    geometry = docs.get("geometry") or {}
    glb = texture.get("scene_glb") or {}
    return {
        "input_json": "input.json" if "ingest" in docs else None,
        "structure_json": "structure.json" if "structure" in docs else None,
        "instances_json": "instances.json" if "instances" in docs else None,
        "geometry_json": "geometry.json" if "geometry" in docs else None,
        "texture_json": "texture.json" if "texture" in docs else None,
        "scene_glb": glb.get("path"),
        "scene_glb_bytes": glb.get("bytes"),
        "scene_glb_sha256": glb.get("sha256"),
        "n_instances": geometry.get("n_instances"),
        "n_with_surface": geometry.get("n_with_surface"),
        "manifest_id": (docs.get("ingest") or {}).get("manifest_id"),
    }


def main(argv: list[str]) -> int:
    """命令行入口：python -m app.miniature.pipeline <scene_dir> <out_dir> [--json]

    只用于人工排障与 preflight，Worker 内部直接 import run_miniature。
    """
    import argparse
    import json

    ap = argparse.ArgumentParser()
    ap.add_argument("scene_dir", nargs="?")
    ap.add_argument("out_dir", nargs="?")
    ap.add_argument("--preflight", action="store_true")
    ap.add_argument("--tex-size", type=int, default=DEFAULT_PARAMS["tex_size"])
    ap.add_argument("--voxel", type=float, default=DEFAULT_PARAMS["voxel_nu"])
    ap.add_argument("--reset-cache", action="store_true")
    args = ap.parse_args(argv)

    if args.preflight or not args.scene_dir:
        print(json.dumps(probe_env(Path(args.scene_dir) if args.scene_dir else None),
                         ensure_ascii=False, indent=2))
        return 0
    if not args.out_dir:
        print("用法：python -m app.miniature.pipeline <scene_dir> <out_dir> [--reset-cache]")
        return 2
    res = run_miniature(
        Path(args.scene_dir), Path(args.out_dir),
        params={"miniatureTexSize": args.tex_size, "miniatureVoxel": args.voxel},
        reset_cache=args.reset_cache,
        on_stage=lambda s, p: print(f"[{p:>4.0%}] {s}", file=sys.stderr),
        log=lambda m: print(m, file=sys.stderr),
    )
    print(json.dumps(res, ensure_ascii=False, indent=2))
    return 0 if res["status"] in ("ok", "degraded") else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
