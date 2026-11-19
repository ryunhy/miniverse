"""T-700020 造型语言测试：实心块 + 纯色 + 凸边，开放盒子（顶不封）。

覆盖任务卡 8 条验收中可单测的部分：
① 合成场景 → 开放盒子（射线实证顶不封、开放侧不挡）；
② 块结构只来自人工指定，建块数 == 指定数；
③ 纯色 + 凸边材质字段与夹取；
④ observed/inferred 分开计数、synthetic 标注；
⑤ build_geometry 对 pipeline.py 的调用签名不变，texture.py 依赖保留；
⑦ 旧"闭合率"判据在开放盒子语义下的重算口径（壳体整体不闭合是**预期**）；
⑧ 产物仍符合 miniature.geometry.v1 契约字段与 diagnostics 格式。
③ 的前后对比截图与 ⑦ 的基准重算证据由 outputs/ 下的取证脚本产出（非单测）。

夹具全部是合成数据（synthetic=true 标注），不冒充真实重建。
"""
from __future__ import annotations

import hashlib
import inspect
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import trimesh

from app.miniature import completion as K
from app.miniature import geometry as G
from app.miniature import material_completion as MC
from app.miniature.sfm_io import write_cameras_bin, write_images_bin, write_points3d_bin


def make_structure() -> dict:
    """手工构造的合法 structure（up=+Z，e1=+X，e2=+Y，地板 z=0）。"""
    return {
        "up_world": [0.0, 0.0, 1.0],
        "origin_world": [0.0, 0.0, 0.0],
        "frame": {"e1": [1.0, 0, 0], "e2": [0, 1.0, 0], "up": [0, 0, 1.0]},
        "floor": {"d_along_up": 0.0},
        "faces": [
            {"name": "e1_min", "axis": "e1", "coord": -2.0, "located": True},
            {"name": "e1_max", "axis": "e1", "coord": 2.0, "located": True},
            {"name": "e2_min", "axis": "e2", "coord": -1.5, "located": True},
            {"name": "e2_max", "axis": "e2", "coord": 1.5, "located": True},
        ],
        "kept_walls": ["e1_min", "e2_max"],
        "extent_nu": {"e1": 4.0, "e2": 3.0, "height": 2.5},
    }


def make_instances() -> dict:
    return {
        "schema": "miniature.instances.v1",
        "status": "ok",
        "instances": [
            {
                "id": "inst-a",
                "aabb_nu": {"min": [-1.5, -1.0, 0.0], "max": [-0.5, 0.0, 0.8]},
                "centroid_nu": [-1.0, -0.5, 0.4],
                "size_nu": [1.0, 1.0, 0.8],
            },
            {
                "id": "inst-b",
                "aabb_nu": {"min": [0.5, -1.0, 0.0], "max": [1.5, 0.0, 1.0]},
                "centroid_nu": [1.0, -0.5, 0.5],
                "size_nu": [1.0, 1.0, 1.0],
            },
        ],
    }


def grid_points(center, half, rgb, n_per_axis=4) -> tuple:
    """块内均匀网格点（合成观测支撑）。"""
    xs = [np.linspace(center[i] - half[i], center[i] + half[i], n_per_axis) for i in range(3)]
    pts = np.array([[x, y, z] for x in xs[0] for y in xs[1] for z in xs[2]])
    colors = np.tile(np.asarray(rgb, np.uint8), (len(pts), 1))
    return pts, colors


def make_spec(synthetic=True) -> dict:
    return {
        "schema": "miniature.blocks.v1",
        "source": "manual",
        "synthetic": synthetic,
        "blocks": [
            {"id": "blk-a1", "instance_id": "inst-a", "label": "seat",
             "center_nu": [-1.0, -0.5, 0.25], "size_nu": [0.9, 0.9, 0.5],
             "color_rgb": [180, 60, 50]},
            {"id": "blk-a2", "instance_id": "inst-a", "label": "back",
             "center_nu": [-1.0, -0.5, 0.65], "size_nu": [0.6, 0.6, 0.3]},
            {"id": "blk-b1", "instance_id": "inst-b", "label": "table",
             "center_nu": [1.0, -0.5, 0.4], "size_nu": [0.9, 0.9, 0.8]},
        ],
    }


def write_scene(root: Path, with_points=True, point_blocks=("blk-a1", "blk-a2")) -> Path:
    """合成场景：colmap/sparse/0 + 可选观测点。全部 synthetic。"""
    scene = root / "scene"
    colmap = scene / "colmap" / "sparse" / "0"
    colmap.mkdir(parents=True, exist_ok=True)
    write_cameras_bin(colmap / "cameras.bin", {})
    write_images_bin(colmap / "images.bin", [])
    if with_points:
        pts_list, rgb_list = [], []
        spec = make_spec()
        for b in spec["blocks"]:
            if b["id"] not in point_blocks:
                continue
            half = np.asarray(b["size_nu"]) / 2 * 0.8
            rgb = b.get("color_rgb") or [40, 120, 200]
            p, c = grid_points(b["center_nu"], half, rgb)
            pts_list.append(p)
            rgb_list.append(c)
        xyz = np.concatenate(pts_list)
        rgb = np.concatenate(rgb_list)
        write_points3d_bin(colmap / "points3D.bin", {
            "n": len(xyz), "xyz": xyz, "rgb": rgb,
            "error": np.full(len(xyz), 0.5),
            "track_image_ids": [np.zeros(0, dtype=np.uint64) for _ in range(len(xyz))],
        })
    return scene


def shell_meshes(structure) -> list:
    shell = G.build_room_shell(structure)
    out = []
    for sb in shell["blocks"]:
        V, F = G.beveled_box(sb["center_nu"], sb["size_nu"], sb["bevel_nu"])
        out.append((sb, trimesh.Trimesh(vertices=V, faces=F, process=False)))
    return out


def combined_vf(meshes) -> tuple:
    """把多个 mesh 拼成一组 (V, F)（不合并顶点，保持各块独立）。"""
    vs, fs, off = [], [], 0
    for m in meshes:
        vs.append(np.asarray(m.vertices))
        fs.append(np.asarray(m.faces) + off)
        off += len(m.vertices)
    return np.concatenate(vs), np.concatenate(fs)


def ray_hits(V, F, origin, direction) -> int:
    """Möller–Trumbore 射线求交（纯 numpy，不依赖 rtree/embree）。返回命中面数。"""
    tri = np.asarray(V)[np.asarray(F)]
    v0, e1, e2 = tri[:, 0], tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]
    d = np.asarray(direction, dtype=np.float64)
    o = np.asarray(origin, dtype=np.float64)
    h = np.cross(d, e2)
    a = (e1 * h).sum(axis=1)
    ok = np.abs(a) > 1e-12
    f = np.zeros(len(a))
    f[ok] = 1.0 / a[ok]
    s = o - v0
    u = f * (s * h).sum(axis=1)
    q = np.cross(s, e1)
    v = f * (q * d).sum(axis=1)
    t = f * (e2 * q).sum(axis=1)
    hit = ok & (u >= -1e-9) & (u <= 1 + 1e-9) & (v >= -1e-9) & (u + v <= 1 + 1e-9) & (t > 1e-9)
    return int(hit.sum())


class TestBeveledBox(unittest.TestCase):
    def test_closed_manifold_counts_and_bounds(self):
        V, F = G.beveled_box([0.3, -0.2, 0.5], [2.0, 1.0, 0.6], 0.05)
        self.assertEqual(len(V), 24)
        self.assertEqual(len(F), 44)
        nm = K.nonmanifold_edges(F)
        self.assertEqual(nm["n_boundary"], 0)
        self.assertEqual(nm["n_nonmanifold"], 0)
        m = trimesh.Trimesh(vertices=V, faces=F, process=False)
        np.testing.assert_allclose(m.bounds[0], [0.3 - 1.0, -0.2 - 0.5, 0.5 - 0.3], atol=1e-9)
        np.testing.assert_allclose(m.bounds[1], [0.3 + 1.0, -0.2 + 0.5, 0.5 + 0.3], atol=1e-9)

    def test_winding_outward_and_volume(self):
        V, F = G.beveled_box([0, 0, 0], [2.0, 1.0, 0.6], 0.05)
        m = trimesh.Trimesh(vertices=V, faces=F, process=False)
        self.assertTrue(m.is_watertight)
        self.assertTrue(m.is_winding_consistent)
        self.assertGreater(m.volume, 0)  # 法向朝外 → 正体积
        self.assertLess(m.volume, 2.0 * 1.0 * 0.6)  # 凸边削角 → 略小于原盒
        self.assertGreater(m.volume, 0.9 * 2.0 * 1.0 * 0.6)

    def test_bevel_clamp_and_reject(self):
        b = MC.block_bevel_nu([1.0, 2.0, 3.0], override=99.0)
        self.assertLessEqual(b, MC.MAX_BEVEL_RATIO * 1.0)
        with self.assertRaises(ValueError):
            G.beveled_box([0, 0, 0], [1.0, 1.0, 1.0], 0.5)  # >= 最短半边
        with self.assertRaises(ValueError):
            MC.block_bevel_nu([0.0, 1.0, 1.0])


class TestOpenBoxShell(unittest.TestCase):
    def setUp(self):
        self.structure = make_structure()

    def test_shell_form_three_slabs_top_open(self):
        shell = G.build_room_shell(self.structure)
        self.assertTrue(shell["top_open"])
        self.assertEqual(shell["n_blocks"], 3)  # 地板 + 两面保留墙，无顶板
        kinds = sorted(b["kind"] for b in shell["blocks"])
        self.assertEqual(kinds, ["floor", "wall", "wall"])
        self.assertEqual(shell["kept_walls"], ["e1_min", "e2_max"])
        self.assertEqual(sorted(shell["open_sides"]), ["e1_max", "e2_min"])
        t = shell["thickness_nu"]
        floor = next(b for b in shell["blocks"] if b["kind"] == "floor")
        zlo = floor["center_nu"][2] - floor["size_nu"][2] / 2
        zhi = floor["center_nu"][2] + floor["size_nu"][2] / 2
        self.assertAlmostEqual(zlo, -t, places=6)
        self.assertAlmostEqual(zhi, 0.0, places=6)
        for b in shell["blocks"]:
            if b["kind"] != "wall":
                continue
            self.assertAlmostEqual(b["center_nu"][2] - b["size_nu"][2] / 2, 0.0, places=6)
            self.assertAlmostEqual(b["center_nu"][2] + b["size_nu"][2] / 2, 2.5, places=6)
            self.assertEqual(b["color_source"], "inferred")  # 壳体色无照片证据

    def test_wall_thickness_outward(self):
        shell = G.build_room_shell(self.structure)
        t = shell["thickness_nu"]
        w1 = next(b for b in shell["blocks"] if b["id"] == "room-wall-e1_min")
        lo = w1["center_nu"][0] - w1["size_nu"][0] / 2
        hi = w1["center_nu"][0] + w1["size_nu"][0] / 2
        self.assertAlmostEqual(lo, -2.0 - t, places=6)  # 向外加厚
        self.assertAlmostEqual(hi, -2.0, places=6)
        w2 = next(b for b in shell["blocks"] if b["id"] == "room-wall-e2_max")
        lo = w2["center_nu"][1] - w2["size_nu"][1] / 2
        hi = w2["center_nu"][1] + w2["size_nu"][1] / 2
        self.assertAlmostEqual(lo, 1.5, places=6)
        self.assertAlmostEqual(hi, 1.5 + t, places=6)

    def test_ray_evidence_open_top_and_sides(self):
        """射线实证：顶不封、开放侧不挡、保留墙与地板确实存在。"""
        meshes = [m for _, m in shell_meshes(self.structure)]
        V, F = combined_vf(meshes)
        origin = [0.0, 0.0, 1.0]

        def hits(direction):
            return ray_hits(V, F, origin, direction) > 0

        self.assertFalse(hits([0, 0, 1]), "向上射线不应命中任何面（顶必须开放）")
        self.assertTrue(hits([0, 0, -1]), "向下射线应命中地板")
        self.assertTrue(hits([-1, 0, 0]), "e1_min 保留墙应挡住射线")
        self.assertTrue(hits([0, 1, 0]), "e2_max 保留墙应挡住射线")
        self.assertFalse(hits([1, 0, 0]), "e1_max 开放侧不应有面")
        self.assertFalse(hits([0, -1, 0]), "e2_min 开放侧不应有面")

    def test_old_closed_criterion_recomputed_semantics(self):
        """验收⑦口径：旧"封闭房间/整体闭合"判据在开放盒子下不再适用。

        壳体是 3 个独立闭合实心板，拼起来的 mesh 在"每条边恰被 2 面共享"
        意义下仍是 watertight——所以**不能**用 mesh watertight 判"房间是否封闭"。
        重算口径：逐块闭合（实心）+ 室内向上射线 0 命中（顶开放）。
        """
        meshes = [m for _, m in shell_meshes(self.structure)]
        for m in meshes:
            self.assertTrue(m.is_watertight)  # 每块实心闭合
        V, F = combined_vf(meshes)
        # 旧判据（整体闭合=房间封闭）在这里会给出误导性的 True：
        self.assertTrue(trimesh.Trimesh(vertices=V, faces=F, process=False).is_watertight)
        # 新判据：从室内向上发射线，命中 0 面 → 顶开放，房间不封闭
        self.assertEqual(ray_hits(V, F, [0.0, 0.0, 1.0], [0, 0, 1]), 0)
        # 对照：向下命中地板（说明射线装置本身有效，不是"什么都打不中"）
        self.assertGreater(ray_hits(V, F, [0.0, 0.0, 1.0], [0, 0, -1]), 0)


class TestBuildGeometryBlocks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.scene = write_scene(self.root)
        self.structure = make_structure()
        self.instances = make_instances()
        self.spec = make_spec()
        (self.scene / "miniature-blocks.json").write_text(
            json.dumps(self.spec, ensure_ascii=False), encoding="utf-8")
        self.out = self.root / "out"

    def tearDown(self):
        self.tmp.cleanup()

    def run_build(self, **kw):
        return G.build_geometry(self.scene, self.structure, self.instances,
                                out_dir=self.out, export_glb=True,
                                alpha_factor=2.0, **kw)

    def test_manual_block_count_equals_specified(self):
        doc = self.run_build()
        self.assertEqual(doc["status"], "ok")
        self.assertEqual(doc["n_blocks_specified"], 3)
        self.assertEqual(doc["n_blocks_built"], 3)  # 建块数 == 人工指定数，无自动分解
        rows = {r["id"]: r for r in doc["instances"]}
        self.assertEqual(rows["inst-a"]["n_blocks"], 2)
        self.assertEqual(rows["inst-b"]["n_blocks"], 1)
        self.assertEqual(doc["block_spec"]["source"], "manual")

    def test_no_spec_reports_unsupported(self):
        (self.scene / "miniature-blocks.json").unlink()
        doc = self.run_build()
        self.assertEqual(doc["status"], "unsupported")
        codes = [d["code"] for d in doc["diagnostics"]]
        self.assertIn(G.D_NO_BLOCK_SPEC, codes)
        self.assertEqual(doc["instances"], [])

    def test_invalid_spec_rejected(self):
        bad = make_spec()
        bad["source"] = "auto"
        errs = G.validate_block_spec(bad)
        self.assertTrue(any("manual" in e for e in errs))
        bad2 = make_spec()
        bad2["blocks"][1]["id"] = bad2["blocks"][0]["id"]
        self.assertTrue(any("重复" in e for e in G.validate_block_spec(bad2)))
        bad3 = make_spec()
        bad3["blocks"][0]["size_nu"] = [0.9, -0.9, 0.5]
        self.assertTrue(any("正" in e for e in G.validate_block_spec(bad3)))
        doc = self.run_build(blocks_doc=bad)
        self.assertEqual(doc["status"], "unsupported")
        self.assertIn(G.D_BLOCK_SPEC_INVALID, [d["code"] for d in doc["diagnostics"]])

    def test_color_sources_manual_measured_inferred(self):
        doc = self.run_build()
        mats = {b["id"]: b for r in doc["instances"] if r["status"] == "ok"
                for b in r.get("blocks", [])}
        self.assertEqual(mats["blk-a1"]["color_source"], "manual")
        self.assertEqual(mats["blk-a1"]["color_rgb"], [180, 60, 50])
        self.assertEqual(mats["blk-a2"]["color_source"], "measured")
        self.assertEqual(mats["blk-a2"]["color_rgb"], [40, 120, 200])  # 点色中位数
        self.assertGreaterEqual(mats["blk-a2"]["n_support_points"], MC.MIN_SUPPORT_POINTS)
        self.assertEqual(mats["blk-b1"]["color_source"], "inferred")
        self.assertEqual(mats["blk-b1"]["color_rgb"], list(MC.NEUTRAL_RGB))
        for b in mats.values():
            self.assertEqual(b["geometry_source"], "manual")
            self.assertEqual(b["finish"], "matte")
            self.assertGreater(b["bevel_nu"], 0)
            self.assertTrue(b["closed"])

    def test_observed_inferred_ratios_and_synthetic(self):
        doc = self.run_build()
        self.assertAlmostEqual(doc["observed_ratio"], 2 / 3, places=6)
        self.assertAlmostEqual(doc["inferred_ratio"], 1 / 3, places=6)
        self.assertAlmostEqual(doc["observed_ratio"] + doc["inferred_ratio"], 1.0, places=6)
        self.assertTrue(doc["synthetic"])  # 夹具 synthetic + 有推断块

    def test_synthetic_false_when_all_supported_and_spec_real(self):
        scene2 = write_scene(self.root / "real", point_blocks=("blk-a1", "blk-a2", "blk-b1"))
        spec = make_spec(synthetic=False)
        (scene2 / "miniature-blocks.json").write_text(json.dumps(spec), encoding="utf-8")
        doc = G.build_geometry(scene2, self.structure, self.instances,
                               out_dir=self.root / "out2", export_glb=False)
        self.assertEqual(doc["observed_ratio"], 1.0)
        self.assertEqual(doc["inferred_ratio"], 0.0)
        self.assertFalse(doc["synthetic"])

    def test_missing_colmap_all_inferred_with_warn(self):
        scene3 = self.root / "nocolmap"
        scene3.mkdir()
        (scene3 / "miniature-blocks.json").write_text(json.dumps(make_spec()), encoding="utf-8")
        doc = G.build_geometry(scene3, self.structure, self.instances, export_glb=False)
        self.assertEqual(doc["status"], "ok")
        self.assertIn("NO_SFM_BASELINE", [d["code"] for d in doc["diagnostics"]])
        self.assertEqual(doc["observed_ratio"], 0.0)
        self.assertEqual(doc["inferred_ratio"], 1.0)
        self.assertTrue(doc["synthetic"])

    def test_glb_nodes_and_sha256(self):
        doc = self.run_build()
        rows = {r["id"]: r for r in doc["instances"]}
        for gid, n in (("inst-a", 2), ("inst-b", 1)):
            p = Path(rows[gid]["glb"])
            self.assertTrue(p.exists())
            sc = trimesh.load(str(p), force="scene", process=False)
            self.assertEqual(len(sc.geometry), n)
            sha = hashlib.sha256(p.read_bytes()).hexdigest()
            self.assertEqual(rows[gid]["glb_sha256"], sha)
        shell_p = Path(doc["room_shell"]["glb"])
        self.assertTrue(shell_p.exists())
        sc = trimesh.load(str(shell_p), force="scene", process=False)
        self.assertEqual(len(sc.geometry), 3)
        self.assertEqual(doc["room_shell"]["glb_sha256"],
                         hashlib.sha256(shell_p.read_bytes()).hexdigest())

    def test_unassigned_blocks_not_dropped(self):
        spec = make_spec()
        spec["blocks"][2].pop("instance_id")
        doc = self.run_build(blocks_doc=spec)
        rows = {r["id"]: r for r in doc["instances"]}
        self.assertIn("_unassigned", rows)
        self.assertEqual(rows["_unassigned"]["n_blocks"], 1)
        self.assertEqual(doc["n_blocks_built"], 3)

    def test_instance_without_blocks_marked_no_blocks(self):
        spec = make_spec()
        spec["blocks"] = spec["blocks"][:2]  # 只给 inst-a 指定
        doc = self.run_build(blocks_doc=spec)
        rows = {r["id"]: r for r in doc["instances"]}
        self.assertEqual(rows["inst-b"]["status"], "no_blocks")
        self.assertIn("inst-b", doc["checks"]["no_surface"])
        self.assertEqual(doc["n_blocks_built"], 2)

    def test_wall_gaps_detected_for_protruding_block(self):
        spec = make_spec()
        spec["blocks"][2]["center_nu"] = [-2.2, -0.5, 0.4]  # 穿出 e1_min 保留墙
        spec["blocks"][2]["instance_id"] = "inst-a"
        doc = self.run_build(blocks_doc=spec)
        gaps = doc["checks"]["wall_gaps"]
        self.assertTrue(any(g["id"] == "blk-b1" and "e1_min" in g["walls"] for g in gaps))

    def test_contract_fields_and_diagnostics_format(self):
        doc = self.run_build()
        self.assertEqual(doc["schema"], "miniature.geometry.v1")
        self.assertEqual(doc["style"], G.STYLE)
        self.assertIsNone(doc["max_observed_vertex_displacement_nu"])
        self.assertTrue(doc["room_shell"]["top_open"])
        for key in ("n_instances", "n_with_surface", "n_closed", "instances", "checks",
                    "observed_ratio", "inferred_ratio", "synthetic", "params"):
            self.assertIn(key, doc)
        for d in doc["diagnostics"]:
            for k in ("code", "severity", "message", "measured", "threshold"):
                self.assertIn(k, d)
            self.assertIn(d["severity"], ("info", "warn", "error"))

    def test_pipeline_signature_unchanged(self):
        """pipeline.py 的调用方式必须原样可用（验收⑤）。"""
        sig = inspect.signature(G.build_geometry)
        for name in ("scene_path", "structure", "instances_doc", "out_dir",
                     "export_glb", "alpha_factor"):
            self.assertIn(name, sig.parameters)
        # 与 pipeline.py 完全一致的调用形态
        doc = G.build_geometry(self.scene, self.structure, self.instances,
                               out_dir=self.out, export_glb=True, alpha_factor=2.0)
        self.assertEqual(doc["status"], "ok")

    def test_texture_dependencies_preserved(self):
        """texture.py 从 geometry 导入的两个函数必须原样存在且可用（验收⑤）。"""
        from app.miniature import texture as T
        self.assertIs(T.alpha_surface, G.alpha_surface)
        self.assertIs(T._instance_point_sets, G._instance_point_sets)
        rng = np.random.default_rng(7)
        blob = rng.normal(size=(400, 3)) * np.array([0.5, 0.3, 0.2])
        surf = G.alpha_surface(blob)
        self.assertIsNotNone(surf)
        self.assertGreater(len(surf["faces"]), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)