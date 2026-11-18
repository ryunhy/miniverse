"""T-700071 负例与失败路径测试：套件必须把坏输入判成非成功，不能输出假成功。

运行：
  python -m unittest discover -s tests/miniature-benchmark -t .
"""
from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location(
    "miniature_bench_run", REPO / "tools" / "miniature-benchmark" / "run.py"
)
B = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = B
_spec.loader.exec_module(B)


class NegativeReject(unittest.TestCase):
    def test_missing_path_is_unsupported(self):
        cfg = {"rejected": [{"key": "nope", "path": "data/does-not-exist-700071",
                             "reason": "INSUFFICIENT_IMAGES"}]}
        with tempfile.TemporaryDirectory() as td:
            rows = B._negative_check(cfg, Path(td))
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["ok"])
        self.assertEqual(rows[0]["measured_status"], "unsupported")

    def test_single_image_dir_is_unsupported(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "proj"
            (root / "images").mkdir(parents=True)
            Image.new("RGB", (32, 32), (120, 120, 120)).save(root / "images" / "one.jpg")
            cfg = {"rejected": [{"key": "single", "path": str(root.relative_to(Path(td).parent)),
                                 "reason": "INSUFFICIENT_IMAGES"}]}
            # 直接把绝对路径塞进去，避免依赖仓库根
            cfg["rejected"][0]["path"] = str(root)
            rows = B._negative_check(cfg, Path(td))
        self.assertNotEqual(rows[0].get("measured_status"), "ok",
                            "单图目录绝不能判成 ok")

    def test_empty_dir_is_not_ok(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "empty"
            root.mkdir()
            cfg = {"rejected": [{"key": "empty", "path": str(root), "reason": "INSUFFICIENT_IMAGES"}]}
            rows = B._negative_check(cfg, Path(td))
        self.assertNotEqual(rows[0].get("measured_status"), "ok")


class GlbFailurePath(unittest.TestCase):
    def test_missing_glb_is_reported(self):
        r = B._glb_reload(Path("C:/definitely-missing/scene.glb"))
        self.assertEqual(r["status"], "missing")

    def test_glb_reload_requires_texture_image(self):
        """导出的 GLB 若没有内嵌贴图，reload 结果里的 n_with_texture_image 必须为 0，
        上层 pas 判定会因此失败——不能因为"能打开"就当成功。"""
        import trimesh

        with tempfile.TemporaryDirectory() as td:
            mesh = trimesh.creation.box()
            p = Path(td) / "plain.glb"
            mesh.export(p)
            r = B._glb_reload(p)
        self.assertEqual(r["status"], "ok")
        self.assertEqual(r["n_with_texture_image"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
