#!/usr/bin/env python3
"""跨场景复用与保真回归套件（一条命令运行）。

用法
  python tools/miniature-benchmark/run.py inventory --scenes <scenes.json> --out <dir>
  python tools/miniature-benchmark/run.py run --scenes <scenes.json> --out <dir> [--only key]

产物
  <out>/manifests/<key>.json    版本化输入清单（含 hash、覆盖度、诊断）
  <out>/inventory.json          冻结清单汇总
  <out>/report.md               逐场景 pass/fail 与未运行项
退出码
  0 = 全部场景 ok；2 = 存在 degraded/unsupported（报告里逐条写明）
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "services" / "reconstruction"))

from app.miniature import contracts as C  # noqa: E402
from app.miniature.ingest import _find_colmap, scan_scene  # noqa: E402
from app.miniature.sfm_io import read_images_bin  # noqa: E402

# 固定观察 ROI（图像归一化坐标）。不随场景变化，也不做自动裁切——自动裁切会让
# "同机位对照"失去可比性，属于必须冻结的基线之一。
FIXED_ROI = {"x0": 0.05, "y0": 0.05, "x1": 0.95, "y1": 0.95}


def baseline_camera(scene_path: Path) -> dict | None:
    """冻结一个参考机位：注册成功、name 排序第一的相机。位姿与内参原样落盘，可回查。"""
    colmap = _find_colmap(scene_path)
    if colmap is None:
        return None
    try:
        imgs = read_images_bin(colmap / "images.bin")
    except Exception:  # noqa: BLE001 - 缺基线如实返回 None，不编造机位
        return None
    rows = imgs.get("images") if isinstance(imgs, dict) else imgs
    if not rows:
        return None
    want = "name" if isinstance(rows[0], dict) and "name" in rows[0] else 0
    ordered = sorted(rows, key=lambda r: (r[want] if isinstance(r, dict) else r.name))
    r = ordered[0]
    get = (lambda k: r.get(k)) if isinstance(r, dict) else (lambda k: getattr(r, k, None))
    return {
        "image_name": get("name"),
        "camera_id": get("camera_id"),
        "qvec": [float(x) for x in (get("qvec") or [])],
        "tvec": [float(x) for x in (get("tvec") or [])],
        "center": [float(x) for x in (get("center") or [])],
        "selection_rule": "registered image with lexicographically smallest name",
    }


def load_scenes(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def all_scenes(cfg: dict) -> list:
    out = []
    for role in ("development", "reuse"):
        for s in cfg.get(role, []):
            s = dict(s)
            s["role"] = role
            out.append(s)
    return out


def cmd_inventory(args) -> int:
    cfg = load_scenes(Path(args.scenes))
    out = Path(args.out)
    mdir = out / "manifests"
    mdir.mkdir(parents=True, exist_ok=True)
    rows = []
    known: dict = {}
    for s in all_scenes(cfg):
        scene_path = REPO_ROOT / s["path"]
        if not scene_path.exists():
            rows.append({"key": s["key"], "role": s["role"], "status": "unsupported", "reason": "path_missing"})
            continue
        m = scan_scene(scene_path, s["key"], known_hashes=known or None)
        m.scale["license"] = s.get("license", "unknown")
        doc = m.as_dict()
        # license 是清单产物的附加字段，写入后必须重算 manifest_id，否则契约校验会
        # 报 "manifest_id does not match content hash"（inventory 自己制造的假违规）
        body = {k: v for k, v in doc.items() if k != "manifest_id"}
        doc["manifest_id"] = C.sha256_text(C.canonical_json(body))
        errs = C.validate_manifest(doc)
        h = C.write_json(mdir / f"{s['key']}.json", doc)
        for rec in m.images:
            if getattr(rec, "sha256", None):
                known[rec.sha256] = s["key"]
        rows.append(
            {
                "key": s["key"],
                "role": s["role"],
                "status": m.status,
                "manifest": f"manifests/{s['key']}.json",
                "manifest_id": doc["manifest_id"],
                "manifest_sha256": h,
                "n_images": len(m.images),
                "n_registered": m.coverage.n_registered,
                "registered_ratio": m.colmap.get("registered_ratio"),
                "azimuth_deg": m.coverage.azimuth_coverage_deg,
                "lookdir_deg": m.coverage.lookdir_coverage_deg,
                "up_world": m.coverage.up_world,
                "up_source": m.coverage.up_source,
                "scale_unit": m.scale.get("unit"),
                "license": m.scale.get("license"),
                "diagnostics": [d.code for d in m.diagnostics],
                "contract_errors": errs,
                # 冻结基线：观察 ROI + 参考机位（名称/内参/位姿原样落盘，可回查）。
                # 参考机位取不到时如实写 null，不用别的相机顶替。
                "roi_normalized": FIXED_ROI,
                "baseline_camera": baseline_camera(scene_path),
            }
        )
    inv = {
        "schema": "miniature.inventory.v1",
        "scenes": rows,
        "rejected": cfg.get("rejected", []),
        "thresholds": C.THRESHOLDS,
    }
    C.write_json(out / "inventory.json", inv)
    (out / "report.md").write_text(render_report(inv), encoding="utf-8")
    bad = [r for r in rows if r.get("status") != "ok" or r.get("contract_errors")]
    print(f"scenes={len(rows)} ok={len(rows) - len(bad)} issues={len(bad)}")
    for r in rows:
        print(
            f"  {r['key']:<12} {r['status']:<11} imgs={r.get('n_images')} "
            f"reg={r.get('n_registered')} az={r.get('azimuth_deg')} look={r.get('lookdir_deg')} "
            f"diag={','.join(r.get('diagnostics') or [])}"
        )
    return 0 if not bad else 2


def render_report(inv: dict) -> str:
    lines = ["# 跨场景复用套件 · 场景冻结报告", "", "阈值单一出处：`services/reconstruction/app/miniature/contracts.py::THRESHOLDS`", ""]
    lines.append("| 场景 | 角色 | 状态 | 照片 | 注册 | 注册率 | 站位环绕 | 朝向覆盖 | up 来源 | 许可 |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|")
    for r in inv["scenes"]:
        lines.append(
            "| {key} | {role} | {status} | {imgs} | {reg} | {rr} | {az}° | {ld}° | {ups} | {lic} |".format(
                key=r["key"],
                role=r["role"],
                status=r["status"],
                imgs=r.get("n_images", "-"),
                reg=r.get("n_registered", "-"),
                rr=r.get("registered_ratio", "-"),
                az=r.get("azimuth_deg", "-"),
                ld=r.get("lookdir_deg", "-"),
                ups=r.get("up_source", "-"),
                lic=r.get("license", "-"),
            )
        )
    lines += ["", "## 冻结基线（逐场景）", ""]
    lines.append(f"固定观察 ROI（图像归一化坐标，不随场景变化）：`{json.dumps(FIXED_ROI)}`")
    lines.append("")
    for r in inv["scenes"]:
        bc = r.get("baseline_camera")
        if bc:
            lines.append(
                f"- **{r['key']}** 参考机位 `{bc['image_name']}`（camera_id={bc['camera_id']}），"
                f"qvec={bc['qvec']}，tvec={bc['tvec']}，center={bc['center']}"
            )
        else:
            lines.append(f"- **{r['key']}** 参考机位未取证（COLMAP images.bin 缺失或不可读）")
    lines += ["", "## 被排除的候选", ""]
    for r in inv.get("rejected", []):
        lines.append(f"- **{r['key']}** — {r['reason']}：{r['measured']} → {r['decision']}")
    lines += ["", "## 诊断明细", ""]
    for r in inv["scenes"]:
        diag = r.get("diagnostics") or []
        if diag or r.get("contract_errors"):
            lines.append(f"- {r['key']}: {', '.join(diag) or '—'}")
            for e in r.get("contract_errors") or []:
                lines.append(f"  - 契约违规：{e}")
    lines.append("")
    return "\n".join(lines)


def cmd_structure(args) -> int:
    from app.miniature.structure import infer_structure

    cfg = load_scenes(Path(args.scenes))
    out = Path(args.out)
    sdir = out / "structure"
    sdir.mkdir(parents=True, exist_ok=True)
    rows = []
    for s in all_scenes(cfg):
        if args.only and s["key"] != args.only:
            continue
        scene_path = REPO_ROOT / s["path"]
        row = {"key": s["key"], "role": s["role"]}
        try:
            st = infer_structure(scene_path)
            C.write_json(sdir / f"{s['key']}.json", st)
            row.update(
                {
                    "status": st["status"],
                    "floor_inliers": st["floor"]["n_inliers"],
                    "floor_inlier_ratio": st["floor"]["inlier_ratio"],
                    "kept_walls": st["kept_walls"],
                    "face_support": {f["name"]: f["support_ratio"] for f in st["faces"]},
                    "vis": {k: v["seen_ratio"] for k, v in st["visibility"].items()},
                    "extent_nu": st["extent_nu"],
                    "corner": [round(v, 4) for v in st["corner_world"]],
                }
            )
        except Exception as e:  # noqa: BLE001 - 明确落在报告里，不吞
            row.update({"status": "unsupported", "error": f"{type(e).__name__}: {e}"})
        rows.append(row)
    C.write_json(out / "structure_summary.json", {"scenes": rows})
    for r in rows:
        print(f"  {r['key']:<12} {r['status']:<11} {r.get('vis', r.get('error', ''))}")
    return 0 if all(r["status"] == "ok" for r in rows) else 2


def cmd_instances(args) -> int:
    from app.miniature.instances import detect_instances

    cfg = load_scenes(Path(args.scenes))
    out = Path(args.out)
    sdir = out / "structure"
    idir = out / "instances"
    idir.mkdir(parents=True, exist_ok=True)
    rows = []
    for s in all_scenes(cfg):
        if args.only and s["key"] != args.only:
            continue
        row = {"key": s["key"], "role": s["role"]}
        st_path = sdir / f"{s['key']}.json"
        if not st_path.exists():
            row.update({"status": "unsupported", "error": "structure_json_missing"})
            rows.append(row)
            continue
        st = json.loads(st_path.read_text(encoding="utf-8"))
        try:
            inst = detect_instances(REPO_ROOT / s["path"], st, voxel_nu=args.voxel)
            C.write_json(idir / f"{s['key']}.json", inst)
            row.update(
                {
                    "status": inst["status"],
                    "n_instances": inst["n_instances"],
                    "n_points_used": inst["n_points_used"],
                    "n_partial": sum(1 for i in inst["instances"] if i["partial"]),
                    "room_shell": inst.get("room_shell") is not None,
                    "ids": [i["id"] for i in inst["instances"]],
                    "diagnostics": [d["code"] for d in inst["diagnostics"]],
                }
            )
        except Exception as e:  # noqa: BLE001 - 明确落在报告里，不吞
            row.update({"status": "unsupported", "error": f"{type(e).__name__}: {e}"})
        rows.append(row)
    C.write_json(out / "instances_summary.json", {"scenes": rows, "voxel_nu": args.voxel})
    for r in rows:
        print(
            f"  {r['key']:<12} {r['status']:<11} n={r.get('n_instances', '-')} "
            f"partial={r.get('n_partial', '-')} shell={r.get('room_shell', '-')} "
            f"err={r.get('error', r.get('diagnostics', ''))}"
        )
    return 0 if all(r["status"] == "ok" for r in rows) else 2


def cmd_geometry(args) -> int:
    from app.miniature.geometry import build_geometry

    cfg = load_scenes(Path(args.scenes))
    out = Path(args.out)
    sdir = out / "structure"
    idir = out / "instances"
    gdir = out / "geometry"
    gdir.mkdir(parents=True, exist_ok=True)
    rows = []
    for s in all_scenes(cfg):
        if args.only and s["key"] != args.only:
            continue
        row = {"key": s["key"], "role": s["role"]}
        st_p, in_p = sdir / f"{s['key']}.json", idir / f"{s['key']}.json"
        if not st_p.exists() or not in_p.exists():
            row.update({"status": "unsupported", "error": "structure_or_instances_json_missing"})
            rows.append(row)
            continue
        st = json.loads(st_p.read_text(encoding="utf-8"))
        inst = json.loads(in_p.read_text(encoding="utf-8"))
        try:
            g = build_geometry(
                REPO_ROOT / s["path"], st, inst, out_dir=out, export_glb=not args.no_glb
            )
            C.write_json(gdir / f"{s['key']}.json", g)
            row.update(
                {
                    "status": g["status"],
                    "n_instances": g.get("n_instances"),
                    "n_with_surface": g.get("n_with_surface"),
                    "n_closed": g.get("n_closed"),
                    "max_disp": g.get("max_observed_vertex_displacement_nu"),
                    "checks": {k: len(v) for k, v in (g.get("checks") or {}).items()},
                    "diagnostics": [d["code"] for d in g.get("diagnostics", [])],
                }
            )
        except Exception as e:  # noqa: BLE001 - 落在报告里，不吞
            row.update({"status": "unsupported", "error": f"{type(e).__name__}: {e}"})
        rows.append(row)
    C.write_json(out / "geometry_summary.json", {"scenes": rows})
    for r in rows:
        print(
            f"  {r['key']:<12} {r['status']:<11} n={r.get('n_instances', '-')} "
            f"surf={r.get('n_with_surface', '-')} closed={r.get('n_closed', '-')} "
            f"disp={r.get('max_disp', '-')} checks={r.get('checks', r.get('error', ''))}"
        )
    return 0 if all(r["status"] == "ok" for r in rows) else 2


def cmd_texture(args) -> int:
    from app.miniature.texture import build_texture

    cfg = load_scenes(Path(args.scenes))
    out = Path(args.out)
    sdir = out / "structure"
    idir = out / "instances"
    tdir = out / "texture"
    tdir.mkdir(parents=True, exist_ok=True)
    rows = []
    for s in all_scenes(cfg):
        if args.only and s["key"] != args.only:
            continue
        row = {"key": s["key"], "role": s["role"]}
        st_p, in_p = sdir / f"{s['key']}.json", idir / f"{s['key']}.json"
        if not st_p.exists() or not in_p.exists():
            row.update({"status": "unsupported", "error": "structure_or_instances_json_missing"})
            rows.append(row)
            continue
        st = json.loads(st_p.read_text(encoding="utf-8"))
        inst = json.loads(in_p.read_text(encoding="utf-8"))
        try:
            t = build_texture(
                REPO_ROOT / s["path"], st, inst, out_dir=out, tex_size=args.tex_size,
                export_glb=not args.no_glb,
            )
            C.write_json(tdir / f"{s['key']}.json", t)
            ok = [i for i in t.get("instances", []) if i.get("status") == "ok"]
            row.update(
                {
                    "status": t["status"],
                    "n_instances": len(t.get("instances", [])),
                    "n_textured": len(ok),
                    "observed_ratio": round(
                        sum(i["coverage"]["n_observed_texels"] for i in ok)
                        / max(sum(i["coverage"]["n_covered_texels"] for i in ok), 1), 4),
                    "inferred_ratio": round(
                        sum(i["coverage"]["n_inferred_texels"] for i in ok)
                        / max(sum(i["coverage"]["n_covered_texels"] for i in ok), 1), 4),
                    "high_seams": sum(i["seam"]["high_seam_edges"] or 0 for i in ok),
                    "stretched": sum(i["stretch"]["n_stretched"] for i in ok),
                    "seam_ratio_before": (t.get("checks", {}).get("seam_leveling") or {}).get("ratio_before"),
                    "seam_ratio_after": (t.get("checks", {}).get("seam_leveling") or {}).get("ratio_after"),
                    "sharpness_retention": (t.get("checks", {}).get("seam_leveling") or {}).get(
                        "sharpness_retention_p50"),
                    "glb": t.get("scene_glb", {}).get("path") if t.get("scene_glb") else None,
                    "diagnostics": [d["code"] for d in t.get("diagnostics", [])],
                }
            )
        except Exception as e:  # noqa: BLE001 - 落在报告里，不吞
            row.update({"status": "unsupported", "error": f"{type(e).__name__}: {e}"})
        rows.append(row)
    C.write_json(out / "texture_summary.json", {"scenes": rows, "tex_size": args.tex_size})
    for r in rows:
        print(
            f"  {r['key']:<12} {r['status']:<11} n={r.get('n_textured', '-')}/{r.get('n_instances', '-')} "
            f"obs={r.get('observed_ratio', '-')} inf={r.get('inferred_ratio', '-')} "
            f"seam={r.get('high_seams', '-')} stretch={r.get('stretched', '-')} "
            f"err={r.get('error', '')}"
        )
    return 0 if all(r["status"] == "ok" for r in rows) else 2


def _texel_trace_check(art: Path, scene_root: Path, doc: dict, n_per: int = 400) -> dict:
    """逐 texel 抽样回查：贴着色的 texel 是否真能指回原照片的某个像素。

    这是"原照片来源真实可追溯"的实测口径，不是"看图像像"。
    """
    import random

    import numpy as np
    from PIL import Image

    rng = random.Random(700070)
    img_dir = scene_root / doc["photo_source"]["photo_dir"]
    names = None
    tot = inb = 0
    diffs: list = []
    per_inst = {}
    for i in doc["instances"]:
        if i.get("status") != "ok" or not i.get("traces"):
            continue
        z = np.load(art / i["traces"]["npz"])
        if names is None:
            names = [str(x) for x in z["image_names"]]
        ob = z["observed"]
        tex = np.asarray(Image.open(art / "texture" / f"{i['id']}.png").convert("RGB"))
        ys, xs = np.nonzero(ob)
        if not len(ys):
            continue
        pick = rng.sample(range(len(ys)), min(n_per, len(ys)))
        cache: dict = {}
        n_t = n_b = 0
        d_local: list = []
        for p in pick:
            y, x = int(ys[p]), int(xs[p])
            vi = int(z["src_view"][y, x])
            if vi < 0 or names is None or vi >= len(names):
                continue
            u, v = int(z["src_u"][y, x]), int(z["src_v"][y, x])
            n_t += 1
            if vi not in cache:
                cache[vi] = np.asarray(Image.open(img_dir / names[vi]).convert("RGB"))
            im = cache[vi]
            if 0 <= v < im.shape[0] and 0 <= u < im.shape[1]:
                n_b += 1
                d = float(np.abs(im[v, u].astype(np.int16) - tex[y, x].astype(np.int16)).mean())
                d_local.append(d)
        tot += n_t
        inb += n_b
        diffs += d_local
        per_inst[i["id"]] = {
            "n_sampled": n_t,
            "in_bounds": n_b,
            "median_abs_diff": round(float(np.median(d_local)), 3) if d_local else None,
        }
    return {
        "n_sampled_texels": tot,
        "in_bounds_ratio": round(inb / tot, 6) if tot else None,
        "median_abs_diff_255": round(float(np.median(diffs)), 3) if diffs else None,
        "p90_abs_diff_255": round(float(np.percentile(diffs, 90)), 3) if diffs else None,
        "per_instance": per_inst,
        "note": "差额来自逐视角增益与逐面电平化（低频），不等于错投",
    }


def _glb_reload(path: Path, expect_sha: str | None = None) -> dict:
    """导入已导出的 GLB 再测：几何数、材质、内嵌贴图、字节数与 sha。"""
    import hashlib

    import trimesh

    if not path.exists():
        return {"status": "missing", "path": str(path)}
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    sha = h.hexdigest()
    sc = trimesh.load(path, force="scene")
    geoms = list(sc.geometry.values())
    n_mat = n_tex = 0
    for g in geoms:
        mat = getattr(g.visual, "material", None)
        if mat is not None:
            n_mat += 1
            # GLB 的 PBRMaterial 没有通用 .image，贴图在 baseColorTexture 等具名槽位上；
            # 只查 .image 会把"已内嵌贴图"误判成 0。
            img = getattr(mat, "image", None)
            if img is None:
                for attr in ("baseColorTexture", "emissiveTexture", "normalTexture", "occlusionTexture"):
                    cand = getattr(mat, attr, None)
                    if cand is not None and getattr(cand, "size", 0):
                        img = cand
                        break
            if img is not None and getattr(img, "size", 0):
                n_tex += 1
    return {
        "status": "ok",
        "path": str(path),
        "bytes": path.stat().st_size,
        "sha256": sha,
        "sha256_matches_manifest": (sha == expect_sha) if expect_sha else None,
        "n_geometry": len(geoms),
        "n_with_material": n_mat,
        "n_with_texture_image": n_tex,
        "n_vertices": int(sum(len(g.vertices) for g in geoms)),
        "n_faces": int(sum(len(g.faces) for g in geoms)),
        "bounds": [float(x) for x in sc.bounds.flatten()] if sc.bounds is not None else None,
    }


def _negative_check(cfg: dict, out: Path) -> list:
    """负例必须被判成 unsupported，不能输出假成功。"""
    rows = []
    for r in cfg.get("rejected", []):
        p = REPO_ROOT / r["path"]
        row = {"key": r["key"], "declared_reason": r["reason"], "path_exists": p.exists()}
        if not p.exists():
            row.update({"measured_status": "unsupported", "ok": True,
                        "note": "路径不存在，判 unsupported 正确"})
            rows.append(row)
            continue
        try:
            m = scan_scene(p, r["key"])
            row.update({"measured_status": m.status,
                        "diagnostics": [d.code for d in m.diagnostics],
                        "ok": m.status != "ok"})
        except Exception as e:  # noqa: BLE001 - 负例异常也算"判非成功"
            row.update({"measured_status": "unsupported",
                        "diagnostics": [f"{type(e).__name__}: {e}"], "ok": True})
        rows.append(row)
    C.write_json(out / "negatives.json", {"schema": "miniature.negatives.v1", "rows": rows})
    return rows


def cmd_run(args) -> int:
    """一条命令跑完整链路，产出逐场景 pass/fail 报告。"""
    from types import SimpleNamespace as NS

    cfg = load_scenes(Path(args.scenes))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    skipped = []
    if args.skip_geometry:
        skipped.append("geometry（--skip-geometry）")
    if args.skip_texture:
        skipped.append("texture（--skip-texture）")

    # 跳过的阶段其判据一律记 None（未运行），不能记 False——否则会把"没跑"
    # 混进"跑了但不过"，报告就分不清失败和未运行。
    ran_geometry = not args.skip_geometry
    ran_texture = not args.skip_texture
    steps = [("inventory", cmd_inventory, dict(scenes=args.scenes, out=args.out))]
    if not args.skip_geometry:
        steps += [
            ("structure", cmd_structure, dict(scenes=args.scenes, out=args.out, only=args.only)),
            ("instances", cmd_instances, dict(scenes=args.scenes, out=args.out, only=args.only,
                                             voxel=args.voxel)),
            ("geometry", cmd_geometry, dict(scenes=args.scenes, out=args.out, only=args.only,
                                           no_glb=False)),
        ]
    if not args.skip_texture:
        steps.append(("texture", cmd_texture, dict(scenes=args.scenes, out=args.out,
                                                   only=args.only, tex_size=args.tex_size,
                                                   no_glb=False)))
    codes = {}
    for name, fn, kw in steps:
        print(f"== {name}")
        try:
            codes[name] = fn(NS(**kw))
        except Exception as e:  # noqa: BLE001 - 记录后继续出报告，不掩盖
            codes[name] = 1
            print(f"  !! {name} 异常 {type(e).__name__}: {e}")
        print(f"   exit={codes[name]}")

    # GLB 独立重载 + 逐 texel 溯源
    reloads, traces = {}, {}
    tdir = out / "texture"
    for s in all_scenes(cfg):
        if args.only and s["key"] != args.only:
            continue
        tp = tdir / f"{s['key']}.json"
        if not tp.exists():
            continue
        doc = json.loads(tp.read_text(encoding="utf-8"))
        g = doc.get("scene_glb")
        if g:
            reloads[s["key"]] = _glb_reload(Path(g["path"]), g.get("sha256"))
        try:
            traces[s["key"]] = _texel_trace_check(out, REPO_ROOT / s["path"], doc)
        except Exception as e:  # noqa: BLE001
            traces[s["key"]] = {"error": f"{type(e).__name__}: {e}"}

    negatives = _negative_check(cfg, out)

    # 逐场景 pass/fail
    def _j(p):
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}

    inv = _j(out / "inventory.json")
    gsum = {r["key"]: r for r in _j(out / "geometry_summary.json").get("scenes", [])}
    tsum = {r["key"]: r for r in _j(out / "texture_summary.json").get("scenes", [])}
    isum = {r["key"]: r for r in _j(out / "instances_summary.json").get("scenes", [])}
    rows = []
    for s in all_scenes(cfg):
        if args.only and s["key"] != args.only:
            continue
        k = s["key"]
        ii = next((x for x in inv.get("scenes", []) if x["key"] == k), {})
        t = tsum.get(k, {})
        g = gsum.get(k, {})
        rl = reloads.get(k, {})
        tr = traces.get(k, {})
        checks = {
            "input_ok": ii.get("status") == "ok" and not ii.get("contract_errors"),
            "structure_ok": (isum.get(k, {}).get("status") == "ok") if ran_geometry else None,
            "geometry_ok": (g.get("status") == "ok") if ran_geometry else None,
            "no_vertex_displacement": ((g.get("max_disp") in (0, 0.0)) if g else False)
            if ran_geometry else None,
            "texture_ok": (t.get("status") == "ok") if ran_texture else None,
            "glb_reload_ok": (rl.get("status") == "ok" and rl.get("n_with_texture_image", 0) > 0
                              and rl.get("n_with_texture_image") == rl.get("n_geometry"))
            if ran_texture else None,
            "trace_ok": ((tr.get("in_bounds_ratio") or 0) > 0.999) if ran_texture else None,
            "seam_ok": ((t.get("seam_ratio_after") if t.get("seam_ratio_after") is not None else 99) < 2.0)
            if ran_texture else None,
        }
        executed = {kk: vv for kk, vv in checks.items() if vv is not None}
        not_run = [kk for kk, vv in checks.items() if vv is None]
        rows.append({
            "key": k, "role": s["role"], "license": s.get("license"),
            "status": "pass" if (executed and all(executed.values())) else "fail",
            "complete": not not_run,
            "checks": checks,
            "not_run_checks": not_run,
            "n_images": ii.get("n_images"), "n_registered": ii.get("n_registered"),
            "registered_ratio": ii.get("registered_ratio"),
            "azimuth_deg": ii.get("azimuth_deg"), "lookdir_deg": ii.get("lookdir_deg"),
            "manifest_sha256": ii.get("manifest_sha256"), "manifest_id": ii.get("manifest_id"),
            "n_instances": isum.get(k, {}).get("n_instances"),
            "n_closed": g.get("n_closed"), "max_disp": g.get("max_disp"),
            "textured": t.get("n_textured"), "observed_ratio": t.get("observed_ratio"),
            "inferred_ratio": t.get("inferred_ratio"), "high_seams": t.get("high_seams"),
            "stretched": t.get("stretched"),
            "glb": rl, "trace": tr,
        })

    doc = {
        "schema": "miniature.benchmark.report.v1",
        "thresholds_source": "services/reconstruction/app/miniature/contracts.py::THRESHOLDS",
        "thresholds": C.THRESHOLDS,
        "exit_codes": codes,
        "skipped": skipped,
        "scenes": rows,
        "negatives": negatives,
        "rejected_declared": cfg.get("rejected", []),
    }
    C.write_json(out / "benchmark.json", doc)
    (out / "report.md").write_text(render_benchmark_report(doc), encoding="utf-8")
    print()
    for r in rows:
        print(f"  {r['key']:<12} {r['status']:<5} complete={r['complete']} {r['checks']}")
    neg_bad = [n["key"] for n in negatives if not n.get("ok")]
    print(f"负例 {len(negatives)} 条，被判成功的={neg_bad}")
    print(f"报告: {out / 'report.md'}")
    ok = all(r["status"] == "pass" for r in rows) and not neg_bad
    return 0 if ok else 2


def render_benchmark_report(doc: dict) -> str:
    L = ["# 跨场景复用与保真回归套件 · 报告", "",
         "一条命令产出：`python tools/miniature-benchmark/run.py run --scenes <scenes.json> --out <dir>`", "",
         f"阈值单一出处：`{doc['thresholds_source']}`", "",
         "## 逐场景结论", "",
         "| 场景 | 角色 | 结论 | 完整 | 未运行项 | 照片 | 注册 | 环绕 | 朝向 | 实例 | 闭合 | 顶点位移 | 贴图实例 | 观测占比 | 推断占比 | 明显接缝 | 拉伸面 |",
         "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in doc["scenes"]:
        L.append(
            f"| {r['key']} | {r['role']} | **{r['status']}** | {'是' if r.get('complete') else '否'} "
            f"| {', '.join(r.get('not_run_checks') or []) or '—'} "
            f"| {r['n_images']} | {r['n_registered']} "
            f"({r['registered_ratio']}) | {r['azimuth_deg']}° | {r['lookdir_deg']}° | {r['n_instances']} "
            f"| {r['n_closed']} | {r['max_disp']} | {r['textured']} | {r['observed_ratio']} "
            f"| {r['inferred_ratio']} | {r['high_seams']} | {r['stretched']} |"
        )
    L += ["", "> 「完整=否」表示该场景有阶段被 `--skip-*` 跳过，对应判据记为未运行（不是通过，也不是失败）；"
              "未运行项列在表中，逐条可查。", ""]
    L += ["", "## 冻结输入", "",
          "| 场景 | 许可 | manifest_id | manifest sha256 |", "|---|---|---|---|"]
    for r in doc["scenes"]:
        L.append(f"| {r['key']} | {r['license']} | `{r['manifest_id']}` | `{r['manifest_sha256']}` |")
    L += ["", "## 三类指标分开评估", "",
          "1. **观测相似**（逐 texel 回查原照片，不是训练分数）", ""]
    for r in doc["scenes"]:
        t = r["trace"]
        if not t:
            L.append(f"- {r['key']}: 未运行（texture 阶段被跳过）")
            continue
        L.append(f"- {r['key']}: 抽样 {t.get('n_sampled_texels')} texel，源坐标落界内 "
                 f"{t.get('in_bounds_ratio')}，色差中位 {t.get('median_abs_diff_255')}/255，"
                 f"P90 {t.get('p90_abs_diff_255')}/255")
    L += ["", "2. **结构完整性**（顶点位移 / 闭合 / 非流形）", ""]
    for r in doc["scenes"]:
        if r["max_disp"] is None:
            L.append(f"- {r['key']}: 未运行（geometry 阶段被跳过）")
            continue
        L.append(f"- {r['key']}: 观测顶点最大位移 `{r['max_disp']}` nu（alpha-shape 顶点取自输入点，"
                 f"理论上限 0）；闭合实例 {r['n_closed']}/{r['n_instances']}")
    L += ["", "3. **推断比例**（与观测严格分开，不合并宣称保真）", ""]
    for r in doc["scenes"]:
        if r["observed_ratio"] is None:
            L.append(f"- {r['key']}: 未运行（texture 阶段被跳过）")
            continue
        L.append(f"- {r['key']}: 观测 {r['observed_ratio']} / 推断 {r['inferred_ratio']}")
    L += ["", "## GLB 独立重载", "",
          "| 场景 | 几何数 | 含材质 | 含内嵌贴图 | 字节 | sha256 与清单一致 |", "|---|---|---|---|---|---|"]
    for r in doc["scenes"]:
        g = r["glb"]
        if not g:
            L.append(f"| {r['key']} | 未运行 | — | — | — | — |")
            continue
        L.append(f"| {r['key']} | {g.get('n_geometry')} | {g.get('n_with_material')} "
                 f"| {g.get('n_with_texture_image')} | {g.get('bytes')} | {g.get('sha256_matches_manifest')} |")
    L += ["", "## 负例（必须判为非成功）", "", "| 场景 | 声明原因 | 实测状态 | 判定 |", "|---|---|---|---|"]
    for n in doc["negatives"]:
        L.append(f"| {n['key']} | {n['declared_reason']} | {n.get('measured_status')} | "
                 f"{'正确' if n.get('ok') else '**判成功，错误**'} |")
    L += ["", "## 未运行项 / 限制", ""]
    if doc["skipped"]:
        for s in doc["skipped"]:
            L.append(f"- 跳过：{s}")
    else:
        L.append("- 无跳过步骤")
    L += ["- 同机位渲染对照未取证：本机 WSL 无离屏 OpenGL，未做原照片↔GLB 逐像素渲染比对；"
          "观测相似改由「逐 texel 回查原照片」给出，两者口径不同，不可互相替代。",
          "- 推断区域（约一半表面，多为闭合面背面）由实例观测中位色填平，已单独计数，不计入保真。",
          ""]
    return "\n".join(L)


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p1 = sub.add_parser("inventory")
    p1.add_argument("--scenes", required=True)
    p1.add_argument("--out", required=True)
    p1.set_defaults(func=cmd_inventory)
    p2 = sub.add_parser("structure")
    p2.add_argument("--scenes", required=True)
    p2.add_argument("--out", required=True)
    p2.add_argument("--only", default=None)
    p2.set_defaults(func=cmd_structure)
    p3 = sub.add_parser("instances")
    p3.add_argument("--scenes", required=True)
    p3.add_argument("--out", required=True)
    p3.add_argument("--only", default=None)
    p3.add_argument("--voxel", type=float, default=0.05)
    p3.set_defaults(func=cmd_instances)
    p4 = sub.add_parser("geometry")
    p4.add_argument("--scenes", required=True)
    p4.add_argument("--out", required=True)
    p4.add_argument("--only", default=None)
    p4.add_argument("--no-glb", action="store_true")
    p4.set_defaults(func=cmd_geometry)
    p5 = sub.add_parser("texture")
    p5.add_argument("--scenes", required=True)
    p5.add_argument("--out", required=True)
    p5.add_argument("--only", default=None)
    p5.add_argument("--tex-size", type=int, default=512)
    p5.add_argument("--no-glb", action="store_true")
    p5.set_defaults(func=cmd_texture)
    p6 = sub.add_parser("run")
    p6.add_argument("--scenes", required=True)
    p6.add_argument("--out", required=True)
    p6.add_argument("--only", default=None)
    p6.add_argument("--voxel", type=float, default=0.05)
    p6.add_argument("--tex-size", type=int, default=512)
    p6.add_argument("--skip-geometry", action="store_true")
    p6.add_argument("--skip-texture", action="store_true")
    p6.set_defaults(func=cmd_run)
    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
