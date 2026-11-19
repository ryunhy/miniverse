"""微缩打印件水密性检查与自动修复（T-700009，附件 A13）。

独立 CLI，不 import 导出卡模块、不改 geometry.py（造型卡独占）：

    python -m app.miniature.watertight <glb>                 # 只检查
    python -m app.miniature.watertight <glb> --repair --out <path>

检查口径与 miniature.geometry.v1 一致（复用 completion.py 的判据函数）：
- holes[]      = 边界环（completion.boundary_loops），环数即洞数；
- nonmanifold[] = 被 >2 个三角形共享的边（completion.nonmanifold_edges）；
- floaters[]   = geometry.v1 里是实例级"悬空无支撑"；单网格层面映射为
                 "除最大连通分量外的 disconnected components"，报告中注明口径。

硬约束（CONTRACT.md §1）
- 已水密的网格跑 --repair 不改动几何：输出文件逐字节复制源文件（sha256 相同）。
- 修复失败保留原文件、报失败原因，不输出看似成功的空结果。
- 补洞沿用 geometry.v1 的 MAX_HOLE_EDGES 上限：超大洞不硬封（会造出整块假平面），
  如实报"未闭合"，修复判失败。
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import numpy as np

from . import completion as K
from . import contracts as C

SCHEMA = "miniature.watertight.v1"

D_SOURCE_MISSING = "SOURCE_MISSING"
D_SOURCE_UNREADABLE = "SOURCE_UNREADABLE"
D_NO_GEOMETRY = "NO_GEOMETRY"
D_NOT_WATERTIGHT = "NOT_WATERTIGHT"
D_REPAIR_FAILED = "REPAIR_FAILED"
D_HOLE_TOO_LARGE = "HOLE_TOO_LARGE"


def _diag(code: str, severity: str, message: str, measured=None) -> dict:
    return {"code": code, "severity": severity, "message": message,
            "measured": measured or {}}


def _load_mesh(path: Path):
    """读 GLB（或 trimesh 支持的其他网格格式），合并全部 mesh 节点。"""
    import trimesh

    loaded = trimesh.load(str(path), force="scene", process=False)
    meshes = [g for g in loaded.geometry.values() if isinstance(g, trimesh.Trimesh)]
    if not meshes:
        return None, 0
    combined = trimesh.util.concatenate(meshes) if len(meshes) > 1 else meshes[0]
    return combined, len(meshes)


def _component_stats(mesh) -> dict:
    """按顶点连通性数分量（边界边也连接相邻面，不会因洞而过分量）。"""
    import trimesh

    if len(mesh.faces) == 0:
        return {"n_components": 0, "component_face_counts": [], "n_floater_components": 0,
                "floater_face_counts": []}
    comps = trimesh.graph.connected_components(mesh.edges_sorted, min_len=1)
    vlabel = np.full(len(mesh.vertices), -1, dtype=np.int64)
    for ci, nodes in enumerate(comps):
        vlabel[nodes] = ci
    flabel = vlabel[mesh.faces[:, 0]]
    counts = np.bincount(flabel, minlength=len(comps))
    order = np.argsort(-counts)
    sizes = [int(counts[i]) for i in order]
    return {
        "n_components": int(len(comps)),
        "component_face_counts": sizes,
        "n_floater_components": int(max(len(comps) - 1, 0)),
        "floater_face_counts": sizes[1:],
    }


def inspect_mesh(mesh) -> dict:
    """水密性检查。holes/nonmanifold 判据直接复用 geometry.v1 的 completion 函数。"""
    F = np.asarray(mesh.faces, dtype=np.int64)
    loops = K.boundary_loops(F)
    nm = K.nonmanifold_edges(F)
    comp = _component_stats(mesh)
    # 与 completion 口径一致的"水密"定义：无边界边且无非流形边
    watertight = nm["n_boundary"] == 0 and nm["n_nonmanifold"] == 0
    out = {
        "watertight": bool(watertight),
        "winding_consistent": bool(mesh.is_winding_consistent),
        "holes": {
            "n": int(len(loops)),
            "sizes": sorted((len(lp) for lp in loops), reverse=True)[:10],
        },
        "nonmanifold": {
            "n_edges": int(nm["n_nonmanifold"]),
            "n_boundary_edges": int(nm["n_boundary"]),
        },
        "floaters": comp,
        "n_vertices": int(len(mesh.vertices)),
        "n_faces": int(len(F)),
    }
    if watertight:
        out["volume_nu3"] = round(float(mesh.volume), 6)
    return out


def repair_mesh(mesh):
    """尝试修复：焊重复点 → 去退化面 → 边界环扇形补洞（≤MAX_HOLE_EDGES）→ 修绕序。

    返回 (repaired_mesh_or_None, report)。修不好就返回 None + 原因，绝不硬造封闭。
    """
    import trimesh

    m = mesh.copy()
    before = inspect_mesh(m)
    steps = []

    m.merge_vertices()
    m.update_faces(m.nondegenerate_faces())
    m.remove_unreferenced_vertices()
    steps.append("merge_vertices + remove_degenerate")

    if len(m.faces) == 0:
        return None, {"before": before, "steps": steps,
                      "reason": "去除退化面后没有剩余几何"}

    loops = K.boundary_loops(np.asarray(m.faces, dtype=np.int64))
    too_large = [len(lp) for lp in loops if len(lp) > K.MAX_HOLE_EDGES]
    if too_large:
        return None, {
            "before": before, "steps": steps,
            "reason": f"存在 {len(too_large)} 个超过 MAX_HOLE_EDGES={K.MAX_HOLE_EDGES} 的大洞"
                      "（多半整面缺失），按 geometry.v1 口径不硬封假平面",
            "hole_sizes_too_large": sorted(too_large, reverse=True)[:10],
        }

    if loops:
        inf, rep = K.fill_hidden_faces(np.asarray(m.vertices), np.asarray(m.faces, dtype=np.int64))
        if len(inf):
            m.faces = np.vstack([np.asarray(m.faces), inf])
        steps.append(f"fan_fill_holes(n={rep['n_filled']})")

    trimesh.repair.fix_normals(m, multibody=True)
    steps.append("fix_normals")

    after = inspect_mesh(m)
    if not after["watertight"]:
        return None, {"before": before, "after": after, "steps": steps,
                      "reason": "补洞/修绕序后仍不水密（可能存在非流形边等无法安全自动修复的缺陷）"}
    return m, {"before": before, "after": after, "steps": steps,
               "n_faces_added": int(after["n_faces"] - before["n_faces"])}


def run(glb_path: Path, repair: bool = False, out_path: Path | None = None) -> dict:
    """检查 / 修复主流程。返回结构化报告；退出码语义见 main()。"""
    glb_path = Path(glb_path)
    diags: list[dict] = []
    report: dict = {
        "schema": SCHEMA,
        "mode": "repair" if repair else "check",
        "status": "failed",
        "source": None,
        "check": None,
        "repair": None,
        "diagnostics": diags,
        "notes": [
            "holes/nonmanifold 判据复用 completion.py（与 miniature.geometry.v1 同口径）",
            "floaters 口径：geometry.v1 为实例级悬空；单网格层面映射为除最大连通分量外的 disconnected components",
            "尺寸单位为 nu（SfM 无米制基准），体积记 nu^3，不声明米制",
        ],
    }

    if not glb_path.exists():
        diags.append(_diag(D_SOURCE_MISSING, "error", f"源文件不存在：{glb_path}"))
        report["exit_code"] = 2
        return report
    sha_before = C.sha256_file(glb_path)
    try:
        mesh, n_geom = _load_mesh(glb_path)
    except Exception as e:  # noqa: BLE001
        diags.append(_diag(D_SOURCE_UNREADABLE, "error",
                           f"源文件无法读取：{type(e).__name__}: {e}"))
        report["exit_code"] = 2
        return report
    if mesh is None or len(mesh.faces) == 0:
        diags.append(_diag(D_NO_GEOMETRY, "error", "源文件不含任何三角面"))
        report["exit_code"] = 2
        return report

    report["source"] = {
        "path": str(glb_path),
        "sha256": sha_before,
        "bytes": int(glb_path.stat().st_size),
        "n_geometries": int(n_geom),
    }
    check = inspect_mesh(mesh)
    report["check"] = check

    if not repair:
        if check["watertight"]:
            report["status"] = "ok"
            report["exit_code"] = 0
        else:
            report["status"] = "defective"
            diags.append(_diag(D_NOT_WATERTIGHT, "warn",
                               f"不水密：洞 {check['holes']['n']} 个、非流形边 "
                               f"{check['nonmanifold']['n_edges']} 条", check))
            report["exit_code"] = 1
        return report

    # ---- repair 模式 ----
    if out_path is None:
        diags.append(_diag("BAD_ARGS", "error", "--repair 必须配 --out <path>"))
        report["exit_code"] = 2
        return report
    out_path = Path(out_path)

    if check["watertight"]:
        # 已水密：逐字节复制，几何零改动（sha256 相同是最强证据）
        out_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(glb_path, out_path)
        sha_out = C.sha256_file(out_path)
        report["repair"] = {
            "repaired": False,
            "geometry_unchanged": True,
            "method": "byte-copy (already watertight)",
            "source_sha256": sha_before,
            "output_sha256": sha_out,
            "sha256_equal": sha_out == sha_before,
            "n_vertices": check["n_vertices"],
            "n_faces": check["n_faces"],
        }
        report["output"] = {"path": str(out_path), "sha256": sha_out,
                            "bytes": int(out_path.stat().st_size)}
        report["status"] = "ok"
        report["exit_code"] = 0
        return report

    fixed, rep = repair_mesh(mesh)
    if fixed is None:
        diags.append(_diag(D_REPAIR_FAILED, "error", rep["reason"],
                           {k: v for k, v in rep.items() if k != "reason"}))
        report["repair"] = {"repaired": False, "detail": rep}
        # 失败不写输出文件；源文件保持原样
        report["source_untouched"] = C.sha256_file(glb_path) == sha_before
        report["exit_code"] = 1
        return report

    out_path.parent.mkdir(parents=True, exist_ok=True)
    import trimesh

    scene = trimesh.Scene()
    scene.add_geometry(fixed, geom_name="watertight-repaired")
    scene.export(str(out_path))
    # 修复结果必须能被独立读回且仍水密，否则不算成功
    back, _ = _load_mesh(out_path)
    back_check = inspect_mesh(back) if back is not None else {"watertight": False}
    if not back_check.get("watertight"):
        out_path.unlink(missing_ok=True)
        diags.append(_diag(D_REPAIR_FAILED, "error", "修复产物读回后仍不水密，已删除输出", back_check))
        report["repair"] = {"repaired": False, "detail": rep}
        report["source_untouched"] = C.sha256_file(glb_path) == sha_before
        report["exit_code"] = 1
        return report

    report["repair"] = {
        "repaired": True,
        "geometry_unchanged": False,
        "detail": rep,
        "reload_check": back_check,
    }
    report["output"] = {"path": str(out_path), "sha256": C.sha256_file(out_path),
                        "bytes": int(out_path.stat().st_size)}
    report["source_untouched"] = C.sha256_file(glb_path) == sha_before
    report["status"] = "ok"
    report["exit_code"] = 0
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m app.miniature.watertight",
        description="微缩打印件水密性检查与可选自动修复（holes/nonmanifold/floaters 与 geometry.v1 同口径）",
    )
    ap.add_argument("glb", help="源网格文件（GLB 或 trimesh 支持的格式）")
    ap.add_argument("--repair", action="store_true", help="尝试自动修复（需配 --out）")
    ap.add_argument("--out", default=None, help="修复产物输出路径（--repair 时必填）")
    ap.add_argument("--report", default=None, help="另存 JSON 报告到该路径（stdout 始终输出）")
    args = ap.parse_args(argv)

    # Windows 控制台默认 GBK：统一按 UTF-8 输出，无法编码的字符替换而不是崩溃
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

    if args.repair and not args.out:
        ap.error("--repair 必须配 --out <path>")

    rep = run(Path(args.glb), repair=args.repair,
              out_path=Path(args.out) if args.out else None)
    text = json.dumps(rep, ensure_ascii=False, indent=2)
    print(text)
    if args.report:
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report).write_text(text, encoding="utf-8")
    return int(rep.get("exit_code", 2))


if __name__ == "__main__":
    sys.exit(main())