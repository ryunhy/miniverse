"""T-700008 微缩打印导出（STL/3MF）单元测试。

跑法（仓库根）：
  python -m unittest discover -s services/reconstruction/app/miniature/tests -t services/reconstruction

全部夹具为合成数据（synthetic=true），不冒充真实重建。
"""
from __future__ import annotations

import contextlib
import io
import json
import re
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(REPO / "services" / "reconstruction"))

import trimesh  # noqa: E402

from app.miniature import contracts as C  # noqa: E402
from app.miniature import print_export as PE  # noqa: E402


def _make_glb(path: Path) -> dict:
    """合成两部件 GLB（两个不同位置的盒子），返回源计数。synthetic=true。"""
    a = trimesh.creation.box(extents=[1.0, 2.0, 0.5])
    b = trimesh.creation.box(extents=[0.4, 0.4, 1.2])
    b.apply_translation([2.0, 1.0, 0.6])
    scene = trimesh.Scene()
    scene.add_geometry(a, node_name="part-a", geom_name="part-a")
    scene.add_geometry(b, node_name="part-b", geom_name="part-b")
    path.parent.mkdir(parents=True, exist_ok=True)
    scene.export(str(path))
    return {"n_geometries": 2, "n_vertices": 16, "n_faces": 24}


def _make_task(root: Path, task_id: str = "t-print-001", with_glb: bool = True) -> Path:
    """搭 data/reconstructions/<id>/miniature/ 产物目录协议。"""
    mini = root / "reconstructions" / task_id / "miniature"
    mini.mkdir(parents=True, exist_ok=True)
    glb = mini / "glb" / "synthetic-scene" / "scene.glb"
    counts = _make_glb(glb) if with_glb else None
    tex = {
        "schema": "miniature.texture.v1",
        "synthetic": True,
        "scene_glb": {"path": str(glb), "bytes": glb.stat().st_size if with_glb else 0,
                      "sha256": C.sha256_file(glb) if with_glb else None},
    }
    C.write_json(mini / "texture.json", tex)
    return mini


class TestFormatParsing(unittest.TestCase):
    def test_normalize(self):
        self.assertEqual(PE.normalize_formats("stl"), ["stl"])
        self.assertEqual(PE.normalize_formats("3mf"), ["3mf"])
        for alias in ("both", "stl3mf", "3mf,stl", "stl,3mf", "ALL"):
            self.assertEqual(PE.normalize_formats(alias), ["stl", "3mf"])
        with self.assertRaises(ValueError):
            PE.normalize_formats("obj")


class TestExport(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name) / "data"
        self.mini = _make_task(self.root)
        self.task_id = "t-print-001"

    def tearDown(self):
        self._tmp.cleanup()

    def _run(self, formats, **kw):
        return PE.export_print_files(self.task_id, self.root, formats, **kw)

    def test_stl_roundtrip_counts(self):
        rep = self._run(["stl"])
        self.assertEqual(rep["status"], "ok", rep["diagnostics"])
        src = rep["source"]
        # 源计数实测：两盒子 16 顶点 24 面
        self.assertEqual(src["n_vertices"], 16)
        self.assertEqual(src["n_faces"], 24)
        self.assertEqual(src["n_geometries"], 2)
        self.assertEqual(len(rep["exports"]), 1)
        ex = rep["exports"][0]
        rt = ex["roundtrip"]
        self.assertTrue(rt["match"])
        self.assertTrue(rt["faces_match"])
        self.assertTrue(rt["vertices_match"])
        self.assertEqual(rt["n_faces_raw"], 24)
        self.assertEqual(rt["n_vertices_raw"], 72)  # STL 是三角汤：3×面数
        self.assertEqual(rt["n_vertices_merged"], 16)
        self.assertLessEqual(rt["max_vertex_deviation_nu"], 1e-5)
        # 独立读回（不经导出模块）再验一次
        back = trimesh.load(ex["path"], process=False)
        self.assertEqual(len(back.faces), 24)
        back.merge_vertices()
        self.assertEqual(len(back.vertices), 16)
        print(f"[stl] 源 V={src['n_vertices']} F={src['n_faces']} → "
              f"读回 raw V={rt['n_vertices_raw']} F={rt['n_faces_raw']}，"
              f"合并后 V={rt['n_vertices_merged']}，最大偏差 {rt['max_vertex_deviation_nu']}")

    def test_3mf_roundtrip_and_unit_metadata(self):
        rep = self._run(["3mf"])
        self.assertEqual(rep["status"], "ok", rep["diagnostics"])
        ex = rep["exports"][0]
        self.assertTrue(ex["roundtrip"]["match"])
        self.assertEqual(ex["roundtrip"]["n_faces_merged"], 24)
        self.assertEqual(ex["roundtrip"]["n_vertices_merged"], 16)
        # 报告单位口径：nu + UNMETRIC_SCALE，不声明米制
        self.assertEqual(rep["unit"], "nu")
        self.assertIsNone(rep["meters_per_unit"])
        self.assertIn("UNMETRIC_SCALE", [d["code"] for d in rep["diagnostics"]])
        # 3MF 内嵌权威单位元数据
        with zipfile.ZipFile(ex["path"]) as z:
            xml = z.read("3D/3dmodel.model").decode("utf-8")
        self.assertIn('name="MiniVerse.Unit"', xml)
        self.assertTrue(re.search(r'MiniVerse\.Unit["\']?\s*(?:>|name=)', xml))
        self.assertIn(">nu<", xml)
        self.assertIn("UNMETRIC_SCALE", xml)
        # 独立读回
        back = trimesh.load(ex["path"])
        meshes = list(back.geometry.values()) if isinstance(back, trimesh.Scene) else [back]
        self.assertEqual(sum(len(m.faces) for m in meshes), 24)
        print(f"[3mf] 读回 F={ex['roundtrip']['n_faces_merged']} "
              f"V={ex['roundtrip']['n_vertices_merged']}，元数据单位 nu 已内嵌")

    def test_sha256_and_path_recorded(self):
        rep = self._run(["stl", "3mf"])
        self.assertEqual(rep["status"], "ok")
        self.assertEqual(len(rep["exports"]), 2)
        for ex in rep["exports"]:
            p = Path(ex["path"])
            self.assertTrue(p.exists())
            self.assertGreater(p.stat().st_size, 0)
            self.assertEqual(ex["sha256"], C.sha256_file(p))
            self.assertEqual(ex["bytes"], p.stat().st_size)

    def test_cli_both_formats_exit0(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = PE.main([self.task_id, "--data-dir", str(self.root), "--format", "stl3mf"])
        self.assertEqual(code, 0)
        rep = json.loads(buf.getvalue())
        self.assertEqual(rep["status"], "ok")
        self.assertEqual({e["format"] for e in rep["exports"]}, {"stl", "3mf"})
        self.assertTrue((self.mini / "print" / "print-report.json").exists())

    def test_missing_source_fails_nonzero_no_fake_output(self):
        root2 = Path(self._tmp.name) / "data-empty"
        (root2 / "reconstructions" / "no-such-task").mkdir(parents=True)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = PE.main(["no-such-task", "--data-dir", str(root2), "--format", "both"])
        self.assertEqual(code, 2)
        rep = json.loads(buf.getvalue())
        self.assertEqual(rep["status"], "failed")
        self.assertIn("SOURCE_GLB_MISSING", [d["code"] for d in rep["diagnostics"]])
        self.assertEqual(rep["exports"], [])
        print_dir = root2 / "reconstructions" / "no-such-task" / "miniature" / "print"
        self.assertEqual(list(print_dir.glob("*.stl")), [])
        self.assertEqual(list(print_dir.glob("*.3mf")), [])

    def test_corrupt_glb_fails(self):
        glb = self.mini / "glb" / "synthetic-scene" / "scene.glb"
        glb.write_bytes(b"this is not a glb")
        rep = self._run(["stl"])
        self.assertEqual(rep["status"], "failed")
        self.assertIn("SOURCE_GLB_UNREADABLE", [d["code"] for d in rep["diagnostics"]])
        self.assertEqual(rep["exports"], [])

    def test_glb_without_triangles_fails(self):
        glb = self.mini / "glb" / "synthetic-scene" / "scene.glb"
        pc = trimesh.PointCloud(np.random.default_rng(0).random((10, 3)))
        trimesh.Scene(pc).export(str(glb))
        rep = self._run(["stl"])
        self.assertEqual(rep["status"], "failed")
        self.assertIn("NO_GEOMETRY", [d["code"] for d in rep["diagnostics"]])
        self.assertEqual(rep["exports"], [])

    def test_synthetic_flag_passthrough(self):
        task_dir = self.root / "tasks" / self.task_id
        C.write_json(task_dir / "miniature-status.json",
                     {"result": {"synthetic": True, "status": "ok"}})
        rep = self._run(["stl"])
        self.assertIs(rep["synthetic"], True)

    def test_relocated_glb_path_fallback(self):
        # texture.json 记录的是别机绝对路径 → 按产物目录协议重定位
        tex = json.loads((self.mini / "texture.json").read_text(encoding="utf-8"))
        tex["scene_glb"]["path"] = "/other/machine/glb/synthetic-scene/scene.glb"
        C.write_json(self.mini / "texture.json", tex)
        rep = self._run(["stl"])
        self.assertEqual(rep["status"], "ok", rep["diagnostics"])
        self.assertIn("重定位", rep["source"]["located_by"])

    def test_no_cross_card_imports(self):
        src = (REPO / "services/reconstruction/app/miniature/print_export.py").read_text(encoding="utf-8")
        self.assertNotIn("watertight", src.replace("水密性卡", ""))
        self.assertNotIn("from .worker", src)
        self.assertNotIn("import worker", src)


if __name__ == "__main__":
    unittest.main(verbosity=2)