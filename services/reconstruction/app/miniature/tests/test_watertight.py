"""T-700009 水密性检查与自动修复单元测试。

跑法（仓库根）：
  python -m unittest discover -s services/reconstruction/app/miniature/tests -t services/reconstruction

全部夹具为合成网格（synthetic=true），不冒充真实重建。
"""
from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(REPO / "services" / "reconstruction"))

import trimesh  # noqa: E402

from app.miniature import completion as K  # noqa: E402
from app.miniature import contracts as C  # noqa: E402
from app.miniature import watertight as W  # noqa: E402


def _export(mesh: trimesh.Trimesh, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    trimesh.Scene(mesh).export(str(path))
    return path


def _box(extents=(1.0, 2.0, 3.0)) -> trimesh.Trimesh:
    return trimesh.creation.box(extents=extents)


def _open_box() -> trimesh.Trimesh:
    """盒子去掉一个四边形面（2 个三角形）→ 恰好 1 个 4 边洞。"""
    m = _box()
    side = m.facets[0]
    keep = np.ones(len(m.faces), bool)
    keep[side] = False
    return trimesh.Trimesh(vertices=m.vertices, faces=m.faces[keep], process=False)


def _grid_plane(n: int = 30) -> trimesh.Trimesh:
    """n×n 格子平面：边界环 4n 条边（n=30 → 120 > MAX_HOLE_EDGES=96）。"""
    xs = np.linspace(0, 1, n + 1)
    V = np.array([[x, y, 0.0] for y in xs for x in xs])
    F = []
    for j in range(n):
        for i in range(n):
            a = j * (n + 1) + i
            b, c, d = a + 1, a + n + 1, a + n + 2
            F += [[a, b, d], [a, d, c]]
    return trimesh.Trimesh(vertices=V, faces=np.asarray(F), process=False)


def _nonmanifold() -> trimesh.Trimesh:
    """三个三角形共享同一条边 → 非流形边 1 条。"""
    V = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1]], float)
    F = np.array([[0, 1, 2], [0, 1, 3], [0, 1, 4]])
    return trimesh.Trimesh(vertices=V, faces=F, process=False)


class TestCheck(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_watertight_box_passes(self):
        p = _export(_box(), self.dir / "box.glb")
        rep = W.run(p)
        self.assertEqual(rep["status"], "ok")
        self.assertEqual(rep["exit_code"], 0)
        ck = rep["check"]
        self.assertTrue(ck["watertight"])
        self.assertEqual(ck["holes"]["n"], 0)
        self.assertEqual(ck["nonmanifold"]["n_edges"], 0)
        self.assertEqual(ck["floaters"]["n_components"], 1)
        self.assertEqual(ck["floaters"]["n_floater_components"], 0)
        self.assertAlmostEqual(ck["volume_nu3"], 6.0, places=4)
        print(f"[check] 水密盒子：holes=0 nonmanifold=0 components=1 volume={ck['volume_nu3']} nu^3")

    def test_open_box_reports_one_hole(self):
        p = _export(_open_box(), self.dir / "open.glb")
        rep = W.run(p)
        self.assertEqual(rep["status"], "defective")
        self.assertEqual(rep["exit_code"], 1)
        ck = rep["check"]
        self.assertFalse(ck["watertight"])
        self.assertEqual(ck["holes"]["n"], 1)
        self.assertEqual(ck["holes"]["sizes"], [4])
        self.assertIn("NOT_WATERTIGHT", [d["code"] for d in rep["diagnostics"]])
        print(f"[check] 带洞盒子：watertight=false holes={ck['holes']['n']} sizes={ck['holes']['sizes']}")

    def test_counts_match_geometry_v1_semantics(self):
        m = _open_box()
        p = _export(m, self.dir / "open2.glb")
        rep = W.run(p)
        back, _ = W._load_mesh(p)
        F = np.asarray(back.faces, dtype=np.int64)
        loops = K.boundary_loops(F)
        nm = K.nonmanifold_edges(F)
        self.assertEqual(rep["check"]["holes"]["n"], len(loops))
        self.assertEqual(rep["check"]["nonmanifold"]["n_edges"], nm["n_nonmanifold"])
        self.assertEqual(rep["check"]["nonmanifold"]["n_boundary_edges"], nm["n_boundary"])

    def test_floaters_two_disjoint_boxes(self):
        big = _box([2, 2, 2])
        small = _box([0.2, 0.2, 0.2])
        small.apply_translation([5, 5, 5])
        both = trimesh.util.concatenate([big, small])
        p = _export(both, self.dir / "two.glb")
        rep = W.run(p)
        self.assertTrue(rep["check"]["watertight"])
        self.assertEqual(rep["check"]["floaters"]["n_components"], 2)
        self.assertEqual(rep["check"]["floaters"]["n_floater_components"], 1)
        self.assertEqual(rep["check"]["floaters"]["floater_face_counts"], [12])

    def test_missing_file_exit2(self):
        rep = W.run(self.dir / "nope.glb")
        self.assertEqual(rep["exit_code"], 2)
        self.assertIn("SOURCE_MISSING", [d["code"] for d in rep["diagnostics"]])

    def test_corrupt_file_exit2(self):
        p = self.dir / "bad.glb"
        p.write_bytes(b"not a mesh")
        rep = W.run(p)
        self.assertEqual(rep["exit_code"], 2)
        self.assertIn("SOURCE_UNREADABLE", [d["code"] for d in rep["diagnostics"]])


class TestRepair(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_repair_open_box_roundtrip(self):
        src = _export(_open_box(), self.dir / "open.glb")
        out = self.dir / "fixed.glb"
        sha_src = C.sha256_file(src)
        rep = W.run(src, repair=True, out_path=out)
        self.assertEqual(rep["exit_code"], 0, rep["diagnostics"])
        self.assertTrue(rep["repair"]["repaired"])
        self.assertTrue(out.exists())
        self.assertTrue(rep["source_untouched"])
        self.assertEqual(C.sha256_file(src), sha_src)
        # 独立读回验证水密
        back = trimesh.load(str(out), force="scene")
        meshes = [g for g in back.geometry.values() if isinstance(g, trimesh.Trimesh)]
        fixed = trimesh.util.concatenate(meshes)
        self.assertTrue(fixed.is_watertight)
        self.assertEqual(rep["repair"]["detail"]["before"]["holes"]["n"], 1)
        self.assertEqual(rep["repair"]["detail"]["after"]["holes"]["n"], 0)
        self.assertEqual(rep["repair"]["detail"]["n_faces_added"], 2)
        self.assertEqual(rep["output"]["sha256"], C.sha256_file(out))
        print(f"[repair] 补洞 2 面 → watertight=true，读回验证通过，"
              f"产物 sha={rep['output']['sha256'][:16]}")

    def test_repair_watertight_is_byte_identical(self):
        src = _export(_box(), self.dir / "box.glb")
        out = self.dir / "copy.glb"
        rep = W.run(src, repair=True, out_path=out)
        self.assertEqual(rep["exit_code"], 0)
        self.assertFalse(rep["repair"]["repaired"])
        self.assertTrue(rep["repair"]["geometry_unchanged"])
        self.assertTrue(rep["repair"]["sha256_equal"])
        self.assertEqual(C.sha256_file(out), C.sha256_file(src))
        self.assertEqual(out.read_bytes(), src.read_bytes())
        print(f"[repair] 已水密 → 逐字节复制，sha256 相同：{C.sha256_file(src)[:16]}")

    def test_repair_large_hole_fails_keeps_original(self):
        src = _export(_grid_plane(30), self.dir / "grid.glb")
        out = self.dir / "fixed.glb"
        sha_src = C.sha256_file(src)
        rep = W.run(src, repair=True, out_path=out)
        self.assertEqual(rep["exit_code"], 1)
        self.assertFalse(out.exists())
        self.assertEqual(C.sha256_file(src), sha_src)
        self.assertTrue(rep["source_untouched"])
        codes = [d["code"] for d in rep["diagnostics"]]
        self.assertIn("REPAIR_FAILED", codes)
        self.assertIn("大洞", rep["diagnostics"][-1]["message"])
        self.assertEqual(rep["check"]["holes"]["sizes"], [120])

    def test_repair_nonmanifold_fails(self):
        src = _export(_nonmanifold(), self.dir / "nm.glb")
        out = self.dir / "fixed.glb"
        rep = W.run(src, repair=True, out_path=out)
        self.assertEqual(rep["exit_code"], 1)
        self.assertFalse(out.exists())
        self.assertGreater(rep["check"]["nonmanifold"]["n_edges"], 0)
        self.assertIn("REPAIR_FAILED", [d["code"] for d in rep["diagnostics"]])

    def test_repair_requires_out(self):
        src = _export(_box(), self.dir / "box.glb")
        rep = W.run(src, repair=True, out_path=None)
        self.assertEqual(rep["exit_code"], 2)


class TestCLI(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def _cli(self, args):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = W.main(args)
        return code, json.loads(buf.getvalue())

    def test_cli_check_defective_exit1(self):
        p = _export(_open_box(), self.dir / "open.glb")
        code, rep = self._cli([str(p)])
        self.assertEqual(code, 1)
        self.assertEqual(rep["mode"], "check")
        self.assertFalse(rep["check"]["watertight"])

    def test_cli_repair_exit0_and_report_file(self):
        p = _export(_open_box(), self.dir / "open.glb")
        out = self.dir / "fixed.glb"
        rpt = self.dir / "report.json"
        code, rep = self._cli([str(p), "--repair", "--out", str(out), "--report", str(rpt)])
        self.assertEqual(code, 0)
        self.assertTrue(out.exists())
        self.assertEqual(json.loads(rpt.read_text(encoding="utf-8"))["status"], "ok")

    def test_cli_repair_without_out_exit2(self):
        p = _export(_box(), self.dir / "box.glb")
        with self.assertRaises(SystemExit) as ctx:
            W.main([str(p), "--repair"])
        self.assertEqual(ctx.exception.code, 2)

    def test_no_cross_card_imports(self):
        src = (REPO / "services/reconstruction/app/miniature/watertight.py").read_text(encoding="utf-8")
        self.assertNotIn("print_export", src)
        self.assertNotIn("from .geometry", src)
        self.assertNotIn("import geometry", src)


if __name__ == "__main__":
    unittest.main(verbosity=2)