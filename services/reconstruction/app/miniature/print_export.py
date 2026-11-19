"""微缩模型可打印导出：STL / 3MF（T-700008，附件 A12）。

独立 CLI，直接读已有微缩 GLB，不 import 水密性卡模块、不改 worker.py：

    python -m app.miniature.print_export <task_id> --data-dir <data_dir> --format stl|3mf|both

硬约束（CONTRACT.md §1 / RUNBOOK.md §6）
- 单位保持 nu（SfM 无米制基准），报告带 UNMETRIC_SCALE 诊断，不声明毫米或米。
  3MF 容器格式强制要求 unit 枚举值（无"无单位"选项），文件内保留格式默认值，
  但同时在 3MF 内嵌 MiniVerse.* 元数据、并在导出报告里权威声明 unit=nu、
  meters_per_unit=null——任何消费端应以报告与内嵌元数据为准。
- 源 GLB 缺失 / 导出失败 / 往返校验不一致：明确报错、退出码非 0，
  不产出空文件或看似成功的结果。
- 每个导出产物做往返验证（trimesh 读回，面数/顶点数与源比对，输出实测数字），
  产物路径与 SHA256 记入报告；大二进制不随卡提交。
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import tempfile
from pathlib import Path

import numpy as np

from . import contracts as C

SCHEMA = "miniature.print_export.v1"

# 诊断码（本卡专用，机器可读）
D_SOURCE_GLB_MISSING = "SOURCE_GLB_MISSING"
D_SOURCE_GLB_UNREADABLE = "SOURCE_GLB_UNREADABLE"
D_EXPORT_FAILED = "EXPORT_FAILED"
D_ROUNDTRIP_MISMATCH = "ROUNDTRIP_MISMATCH"
D_NO_GEOMETRY = "NO_GEOMETRY"


def _diag(code: str, severity: str, message: str, measured=None) -> dict:
    return {"code": code, "severity": severity, "message": message,
            "measured": measured or {}}


def normalize_formats(raw: str) -> list[str]:
    """接受 stl / 3mf / both / stl3mf / 'stl,3mf'，归一为格式列表。"""
    s = (raw or "").strip().lower().replace(" ", "")
    if s in ("both", "stl3mf", "3mfstl", "stl,3mf", "3mf,stl", "all"):
        return ["stl", "3mf"]
    if s in ("stl", "3mf"):
        return [s]
    raise ValueError(f"不支持的 --format：{raw!r}（可选 stl / 3mf / both）")


def find_source_glb(data_dir: Path, task_id: str) -> tuple[Path | None, str]:
    """定位微缩场景 GLB。

    首选 miniature/texture.json 的 scene_glb.path（正式管线产物清单）；
    记录路径失效（跨机迁移）时回退到 miniature/glb/*/scene.glb 通配。
    返回 (路径或 None, 定位方式说明)。
    """
    mini = Path(data_dir) / "reconstructions" / str(task_id) / "miniature"
    tex = mini / "texture.json"
    if tex.exists():
        try:
            doc = json.loads(tex.read_text(encoding="utf-8"))
            p = (doc.get("scene_glb") or {}).get("path")
            if p and Path(p).exists():
                return Path(p), "texture.json:scene_glb.path"
            # 记录路径失效：按产物目录协议在 miniature/glb/<scene_tag>/scene.glb 找
            if p:
                cand = mini / "glb" / Path(p).parent.name / "scene.glb"
                if cand.exists():
                    return cand, "texture.json:scene_glb.path(重定位到产物目录)"
        except Exception:  # noqa: BLE001 - 清单损坏不猜，走通配回退
            pass
    cands = sorted(mini.glob("glb/*/scene.glb"))
    if len(cands) == 1:
        return cands[0], "glob:miniature/glb/*/scene.glb"
    if len(cands) > 1:
        # 多场景 GLB 并存时不猜：报缺失让调用方显式处理
        return None, f"发现 {len(cands)} 个 scene.glb，无法确定唯一源"
    return None, "texture.json 与 glb/*/scene.glb 均未找到"


def _load_combined(path: Path):
    """读 GLB 并把所有 mesh 节点合并为单一 Trimesh（打印件是同一物体的各部件）。

    process=False：不做任何隐式合并/去重，源计数保持原样。
    """
    import trimesh

    scene = trimesh.load(str(path), force="scene", process=False)
    meshes = [g for g in scene.geometry.values() if isinstance(g, trimesh.Trimesh)]
    if not meshes:
        return None, 0
    combined = trimesh.util.concatenate(meshes) if len(meshes) > 1 else meshes[0]
    return combined, len(meshes)


def _canonical_counts(mesh) -> dict:
    """合并重复顶点后的规范计数 + 排序顶点表（用于跨格式几何比对）。"""
    m = mesh.copy()
    m.merge_vertices()
    v = np.asarray(m.vertices, dtype=np.float64)
    order = np.lexsort((v[:, 2], v[:, 1], v[:, 0]))
    return {
        "n_vertices_merged": int(len(m.vertices)),
        "n_faces": int(len(m.faces)),
        "sorted_vertices": v[order],
    }


def _roundtrip_check(fmt: str, data: bytes, src_canon: dict) -> dict:
    """把导出字节读回，与源规范形比对。全部输出实测数字，不给模糊结论。"""
    import trimesh

    loaded = trimesh.load(io.BytesIO(data), file_type=fmt, process=False)
    if isinstance(loaded, trimesh.Scene):
        meshes = [g for g in loaded.geometry.values() if isinstance(g, trimesh.Trimesh)]
        back = trimesh.util.concatenate(meshes) if len(meshes) > 1 else meshes[0]
    else:
        back = loaded
    raw_v, raw_f = int(len(back.vertices)), int(len(back.faces))
    canon = _canonical_counts(back)
    faces_match = canon["n_faces"] == src_canon["n_faces"]
    verts_match = canon["n_vertices_merged"] == src_canon["n_vertices_merged"]
    max_dev = None
    if verts_match and faces_match:
        dev = np.abs(canon["sorted_vertices"] - src_canon["sorted_vertices"]).max()
        max_dev = float(dev)
    ok = faces_match and verts_match and max_dev is not None and max_dev <= 1e-5
    return {
        "reload_ok": True,
        "n_vertices_raw": raw_v,
        "n_faces_raw": raw_f,
        "n_vertices_merged": canon["n_vertices_merged"],
        "n_faces_merged": canon["n_faces"],
        "source_n_vertices_merged": src_canon["n_vertices_merged"],
        "source_n_faces": src_canon["n_faces"],
        "faces_match": bool(faces_match),
        "vertices_match": bool(verts_match),
        "max_vertex_deviation_nu": max_dev,
        "match": bool(ok),
    }


def _inject_3mf_unit_metadata(data: bytes) -> bytes:
    """在 3MF 模型 XML 里内嵌权威单位声明（nu / 无米制换算 / UNMETRIC_SCALE）。

    3MF 核心规范的 unit 属性是必填枚举（micron/mm/cm/inch/foot/meter），
    没有"无单位"选项；保留格式默认值的同时用 metadata 显式覆盖语义，
    消费端以 MiniVerse.* 元数据与导出报告为准。
    """
    import zipfile

    from lxml import etree

    zin = zipfile.ZipFile(io.BytesIO(data), "r")
    model_name = "3D/3dmodel.model"
    xml = zin.read(model_name)
    root = etree.fromstring(xml)
    ns = root.nsmap.get(None) or "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
    # metadata 必须位于 resources 之前（规范顺序：metadata*, resources, build）
    insert_at = 0
    for i, child in enumerate(root):
        if etree.QName(child).localname == "metadata":
            insert_at = i + 1
        else:
            break
    for name, text in (
        ("MiniVerse.Unit", "nu"),
        ("MiniVerse.MetersPerUnit", "null"),
        ("MiniVerse.Diagnostic", "UNMETRIC_SCALE"),
        ("MiniVerse.Note", "SfM 无米制基准；unit 属性为 3MF 格式必填占位，不构成米制声明"),
    ):
        el = etree.Element(f"{{{ns}}}metadata")
        el.set("name", name)
        el.text = text
        root.insert(insert_at, el)
        insert_at += 1
    new_xml = etree.tostring(root, xml_declaration=True, encoding="UTF-8")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            zout.writestr(item, new_xml if item.filename == model_name else zin.read(item.filename))
    zin.close()
    return buf.getvalue()


def export_print_files(
    task_id: str,
    data_dir: Path,
    formats: list[str],
    out_dir: Path | None = None,
) -> dict:
    """执行导出并返回结构化报告。失败时 status=failed + 诊断，不产出冒充成功的文件。"""
    data_dir = Path(data_dir)
    mini = data_dir / "reconstructions" / str(task_id) / "miniature"
    out = Path(out_dir) if out_dir is not None else mini / "print"
    diags: list[dict] = [_diag(C.D_UNMETRIC_SCALE, "info",
                               "无米制基准（COLMAP/SfM 无尺度），导出尺寸单位为 nu，不得声明毫米或米")]
    report: dict = {
        "schema": SCHEMA,
        "task_id": str(task_id),
        "status": "failed",
        "unit": "nu",
        "meters_per_unit": None,
        "diagnostics": diags,
        "source": None,
        "exports": [],
        "synthetic": None,
        "notes": [
            "单位为 nu（SfM 归一化单位）；meters_per_unit=null，未做米制标定",
            "3MF 容器的 unit 属性是格式必填枚举占位；权威单位声明见本报告与 3MF 内嵌 MiniVerse.* 元数据",
            "每个导出文件都经 trimesh 读回做往返校验，计数与偏差为实测值",
            "大二进制不随卡提交，只记录路径与 SHA256",
        ],
    }
    # 上游 synthetic 标记如实透传（有推断成分就必须标）
    mstatus = data_dir / "tasks" / str(task_id) / "miniature-status.json"
    if mstatus.exists():
        try:
            ms = json.loads(mstatus.read_text(encoding="utf-8"))
            syn = (ms.get("result") or {}).get("synthetic")
            if syn is not None:
                report["synthetic"] = bool(syn)
        except Exception:  # noqa: BLE001 - 状态文件损坏不影响导出主流程
            pass

    def finish(status: str) -> dict:
        report["status"] = status
        out.mkdir(parents=True, exist_ok=True)
        C.write_json(out / "print-report.json", report)
        return report

    src, how = find_source_glb(data_dir, task_id)
    if src is None:
        diags.append(_diag(D_SOURCE_GLB_MISSING, "error",
                           f"源 GLB 缺失：{how}", {"searched": str(mini)}))
        return finish("failed")

    try:
        combined, n_geom = _load_combined(src)
    except Exception as e:  # noqa: BLE001
        diags.append(_diag(D_SOURCE_GLB_UNREADABLE, "error",
                           f"源 GLB 无法读取：{type(e).__name__}: {e}", {"path": str(src)}))
        return finish("failed")
    if combined is None or len(combined.faces) == 0:
        diags.append(_diag(D_NO_GEOMETRY, "error", "源 GLB 不含任何三角面，拒绝导出空文件",
                           {"path": str(src)}))
        return finish("failed")

    src_canon = _canonical_counts(combined)
    report["source"] = {
        "path": str(src),
        "located_by": how,
        "sha256": C.sha256_file(src),
        "bytes": int(src.stat().st_size),
        "n_geometries": int(n_geom),
        "n_vertices": int(len(combined.vertices)),
        "n_faces": int(len(combined.faces)),
        "n_vertices_merged": src_canon["n_vertices_merged"],
    }

    out.mkdir(parents=True, exist_ok=True)
    all_ok = True
    for fmt in formats:
        stem = f"{task_id}-miniature"
        final = out / f"{stem}.{fmt}"
        tmp_name = None
        try:
            data = combined.export(file_type=fmt)
            if not data:
                raise RuntimeError("导出器返回空字节")
            if fmt == "3mf":
                data = _inject_3mf_unit_metadata(data)
            rt = _roundtrip_check(fmt, data, src_canon)
            if not rt["match"]:
                diags.append(_diag(D_ROUNDTRIP_MISMATCH, "error",
                                   f"{fmt.upper()} 往返校验不一致，拒绝落盘", rt))
                all_ok = False
                continue
            # 先写临时文件再原子替换：中途失败不会留下半个产物
            fd, tmp_name = tempfile.mkstemp(dir=str(out), suffix=f".{fmt}.tmp")
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            os.replace(tmp_name, final)
            tmp_name = None
            report["exports"].append({
                "format": fmt,
                "path": str(final),
                "bytes": int(final.stat().st_size),
                "sha256": C.sha256_file(final),
                "roundtrip": rt,
            })
        except Exception as e:  # noqa: BLE001
            diags.append(_diag(D_EXPORT_FAILED, "error",
                               f"{fmt.upper()} 导出失败：{type(e).__name__}: {e}"))
            all_ok = False
        finally:
            if tmp_name and Path(tmp_name).exists():
                Path(tmp_name).unlink()

    return finish("ok" if all_ok and report["exports"] else "failed")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m app.miniature.print_export",
        description="把微缩 GLB 导出为可打印 STL / 3MF（单位 nu，带 UNMETRIC_SCALE 诊断）",
    )
    ap.add_argument("task_id", help="重建任务 id（data/reconstructions/<id>/miniature/）")
    ap.add_argument("--data-dir", default="data", help="数据根目录（默认 ./data）")
    ap.add_argument("--format", default="both",
                    help="stl / 3mf / both（也接受 stl3mf、'stl,3mf'）")
    ap.add_argument("--out-dir", default=None,
                    help="导出目录（默认 <data>/reconstructions/<id>/miniature/print/）")
    args = ap.parse_args(argv)

    # Windows 控制台默认 GBK：统一按 UTF-8 输出，无法编码的字符替换而不是崩溃
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

    try:
        formats = normalize_formats(args.format)
    except ValueError as e:
        print(json.dumps({"schema": SCHEMA, "status": "failed",
                          "diagnostics": [_diag("BAD_FORMAT", "error", str(e))]},
                         ensure_ascii=False, indent=2))
        return 2

    report = export_print_files(args.task_id, Path(args.data_dir), formats,
                                out_dir=Path(args.out_dir) if args.out_dir else None)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "ok" else 2


if __name__ == "__main__":
    sys.exit(main())