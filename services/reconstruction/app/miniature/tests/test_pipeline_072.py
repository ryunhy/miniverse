"""T-700072 正式接入的单元测试（标准库 unittest，不依赖 pytest）。

跑法（仓库根）：
  python -m unittest discover -s services/reconstruction/app/miniature/tests -t services/reconstruction

覆盖三件容易悄悄坏掉的事：
- 缓存键必须对「输入 / 参数 / 代码指纹」三者任一变化失效；
- 缓存复用的完整性复核不能只看 JSON 在不在，引用的 GLB 也得在且字节对得上；
- Worker 回写 status.json 的 result.miniature 必须符合 T-700073 的六阶段契约。
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(REPO / "services" / "reconstruction"))

from app.miniature import pipeline as P  # noqa: E402


class TestParams(unittest.TestCase):
    def test_defaults_frozen(self):
        p = P.resolve_params(None)
        self.assertEqual(p, {"tex_size": 512, "voxel_nu": 0.05, "alpha_factor": 2.0})

    def test_override_and_cast(self):
        p = P.resolve_params({"miniatureTexSize": "256", "miniatureVoxel": 0.08})
        self.assertEqual(p["tex_size"], 256)  # 字符串来自 JSON 也接受
        self.assertEqual(p["voxel_nu"], 0.08)
        self.assertEqual(p["alpha_factor"], 2.0)

    def test_blank_value_keeps_default(self):
        p = P.resolve_params({"miniatureTexSize": None})
        self.assertEqual(p["tex_size"], 512)


class TestCacheKey(unittest.TestCase):
    CODE = "a" * 64

    def test_stable_for_same_inputs(self):
        a = P.cache_key("m1", {"tex_size": 512}, self.CODE)
        b = P.cache_key("m1", {"tex_size": 512}, self.CODE)
        self.assertEqual(a, b)
        self.assertEqual(len(a), 64)

    def test_changes_with_manifest(self):
        a = P.cache_key("m1", {"tex_size": 512}, self.CODE)
        b = P.cache_key("m2", {"tex_size": 512}, self.CODE)
        self.assertNotEqual(a, b)

    def test_changes_with_params(self):
        a = P.cache_key("m1", {"tex_size": 512}, self.CODE)
        b = P.cache_key("m1", {"tex_size": 256}, self.CODE)
        self.assertNotEqual(a, b)

    def test_changes_with_code(self):
        a = P.cache_key("m1", {"tex_size": 512}, self.CODE)
        b = P.cache_key("m1", {"tex_size": 512}, "b" * 64)
        self.assertNotEqual(a, b)


class TestCacheRecords(unittest.TestCase):
    def test_wrong_key_is_miss(self):
        with tempfile.TemporaryDirectory() as td:
            cache = Path(td)
            doc_path = cache / "structure.json"
            doc_path.write_text("{}", encoding="utf-8")
            P._write_cache(cache, "structure", "key-a", {"status": "ok"}, doc_path, 0.1)
            self.assertIsNone(P._read_cache(cache, "structure", "key-b", None))
            self.assertIsNotNone(P._read_cache(cache, "structure", "key-a", None))

    def test_doc_intact_requires_referenced_glb(self):
        with tempfile.TemporaryDirectory() as td:
            glb = Path(td) / "scene.glb"
            glb.write_bytes(b"x" * 16)
            doc = {"scene_glb": {"path": str(glb), "bytes": 16}}
            self.assertTrue(P._doc_intact(doc))
            doc["scene_glb"]["bytes"] = 32  # 字节数不符 = 产物已被替换
            self.assertFalse(P._doc_intact(doc))
            glb.unlink()
            self.assertFalse(P._doc_intact(doc))


class TestFailureSemantics(unittest.TestCase):
    def test_empty_scene_stops_at_ingest(self):
        """没有照片/COLMAP 时必须停在 ingest，不进入下游、不伪造成功。"""
        with tempfile.TemporaryDirectory() as td:
            scene = Path(td) / "scene"
            scene.mkdir()
            res = P.run_miniature(scene, Path(td) / "out")
            self.assertIn(res["status"], ("failed", "unsupported"))
            self.assertEqual([s["name"] for s in res["stages"]], ["ingest"])
            self.assertEqual(res["artifacts"]["scene_glb"], None)


class TestWorkerPayload(unittest.TestCase):
    """result.miniature 必须能被 T-700073 的 deriveMiniatureView 直接消费。"""

    def test_payload_shape(self):
        from app import worker  # noqa: PLC0415

        with tempfile.TemporaryDirectory() as td:
            out = Path(td)
            C = __import__("app.miniature.contracts", fromlist=["contracts"])
            C.write_json(out / "input.json", {"manifest_id": "m" * 64, "images": [{}, {}]})
            C.write_json(out / "structure.json", {
                "status": "ok",
                "kept_walls": ["e1_min", "e1_max"],
                "surface_visible": {"e1_min": 1.0, "e1_max": 0.96},
                "floor": {"inlier_ratio": 1.0},
            })
            C.write_json(out / "instances.json", {"status": "ok", "n_instances": 3,
                                                  "n_degenerate_skipped": 1})
            C.write_json(out / "geometry.json", {"status": "ok", "n_instances": 3,
                                                 "n_with_surface": 3, "n_closed": 2})
            C.write_json(out / "texture.json", {
                "status": "ok",
                "instances": [
                    {"coverage": {"n_observed_texels": 30, "n_covered_texels": 100}},
                    {"coverage": {"n_observed_texels": 10, "n_covered_texels": 100}},
                ],
            })
            glb = out / "glb" / "s" / "scene.glb"
            glb.parent.mkdir(parents=True)
            glb.write_bytes(b"glTF" + b"\0" * 60)
            res = {
                "status": "ok",
                "cache": {"params": {"tex_size": 512}},
                "stages": [
                    {"name": "ingest", "status": "ok"},
                    {"name": "structure", "status": "ok"},
                    {"name": "instances", "status": "ok"},
                    {"name": "geometry", "status": "ok"},
                    {"name": "texture", "status": "ok"},
                ],
                "artifacts": {"scene_glb": str(glb), "scene_glb_bytes": 64,
                              "scene_glb_sha256": "c" * 64},
            }
            payload = worker._miniature_payload(res, out)

        self.assertEqual(set(payload["stages"]),
                         {"ingest", "structure", "instances", "geometry", "texture", "export"})
        self.assertTrue(all(s["state"] == "done" for s in payload["stages"].values()))
        self.assertEqual(payload["glb"]["bytes"], 64)
        self.assertEqual(payload["provenance"]["observed_ratio"], 0.2)
        self.assertEqual(payload["provenance"]["inferred_ratio"], 0.8)

    def test_failed_stage_marks_export_failed(self):
        from app import worker  # noqa: PLC0415

        with tempfile.TemporaryDirectory() as td:
            out = Path(td)
            res = {
                "status": "failed",
                "error": "texture 阶段没有产出 scene_glb",
                "stages": [
                    {"name": "ingest", "status": "ok"},
                    {"name": "structure", "status": "unsupported", "reason": "NO_FLOOR_PLANE"},
                ],
                "artifacts": {},
            }
            payload = worker._miniature_payload(res, out)
        self.assertEqual(payload["stages"]["structure"]["state"], "failed")
        self.assertEqual(payload["stages"]["instances"]["state"], "not_started")
        self.assertEqual(payload["stages"]["export"]["state"], "failed")
        self.assertIsNone(payload["glb"])
        self.assertIn("NO_FLOOR_PLANE", payload["stages"]["structure"]["detail"])


if __name__ == "__main__":
    unittest.main()
