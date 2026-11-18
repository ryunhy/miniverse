"""回归测试：墙候选相对阈值 + 输入指纹复用/作废。"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from PIL import Image

from app.miniature.structure import wall_extent_ok
from app.pipeline.preprocess import (
    FINGERPRINT_NAME,
    compute_fingerprint,
    load_fingerprint,
    preprocess,
)


def _make_photos(directory: Path, colors: list[str]) -> None:
    for i, color in enumerate(colors, 1):
        Image.new("RGB", (64, 48), color).save(directory / f"{i:03d}.jpg")


class WallExtentTest(unittest.TestCase):
    def test_small_room_keeps_wall(self) -> None:
        # 0.6 nu 的小房间：旧的固定阈值 1.0 会筛光，新相对阈值 0.108 保留
        ok, why, need = wall_extent_ok(500, 0.55, 0.6)
        self.assertTrue(ok, why)
        self.assertAlmostEqual(need, 0.108)
        self.assertLess(0.55, 1.0)  # 同一候选按旧阈值必然被筛

    def test_short_segment_rejected(self) -> None:
        ok, why, need = wall_extent_ok(500, 0.10, 1.0)
        self.assertFalse(ok)
        self.assertAlmostEqual(need, 0.18)
        self.assertIn("延展不足", why)

    def test_point_count_gate(self) -> None:
        ok, why, _ = wall_extent_ok(10, 5.0, 5.0)
        self.assertFalse(ok)
        self.assertIn("点数不足", why)


class InputFingerprintTest(unittest.TestCase):
    def test_same_input_same_digest(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            photos = Path(td)
            _make_photos(photos, ["red", "green", "blue"])
            a = compute_fingerprint(photos)
            b = compute_fingerprint(photos)
            self.assertEqual(a["digest"], b["digest"])
            self.assertEqual(a["count"], 3)
            self.assertEqual(load_fingerprint(photos), None)

    def test_changed_bytes_changes_digest(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            photos = Path(td)
            _make_photos(photos, ["red", "green", "blue"])
            before = compute_fingerprint(photos)["digest"]
            Image.new("RGB", (64, 48), "yellow").save(photos / "002.jpg")
            after = compute_fingerprint(photos)["digest"]
            self.assertNotEqual(before, after)

    def test_preprocess_invalidates_then_reuses(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            photos = root / "uploads"
            photos.mkdir()
            work = root / "work"
            (work / "sparse" / "0").mkdir(parents=True)
            (work / "sparse" / "0" / "images.bin").write_bytes(b"old-poses")
            (work / "database.db").write_bytes(b"old-db")
            _make_photos(photos, ["red", "green", "blue"])

            # 1) 无指纹（历史任务）→ 作废旧位姿并重建
            preprocess(photos, work)
            self.assertFalse((work / "sparse" / "0" / "images.bin").exists())
            self.assertFalse((work / "database.db").exists())
            self.assertTrue((work / FINGERPRINT_NAME).exists())

            # 2) 同输入重跑 → 复用，不清空
            (work / "sparse" / "0").mkdir(parents=True)
            (work / "sparse" / "0" / "images.bin").write_bytes(b"new-poses")
            preprocess(photos, work)
            self.assertTrue((work / "sparse" / "0" / "images.bin").exists())

            # 3) 换一张图 → 检出变更并再次作废
            Image.new("RGB", (64, 48), "yellow").save(photos / "003.jpg")
            preprocess(photos, work)
            self.assertFalse((work / "sparse" / "0" / "images.bin").exists())


if __name__ == "__main__":
    unittest.main()
