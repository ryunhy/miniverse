"""TSDF 提取参数解析单测：默认旧行为、显式新参数、非法值报错。"""
from __future__ import annotations

import unittest

from app.mesh.tsdf_options import resolve_tsdf_options


class ResolveTsdfOptionsTest(unittest.TestCase):
    def test_defaults_keep_legacy_behavior(self):
        """未传参：必须保持 occupancy + 0.5，历史任务与重试不受影响。"""
        self.assertEqual(resolve_tsdf_options(), ("occupancy", 0.5))

    def test_explicit_sdf_is_forwarded(self):
        """显式传 sdf + 0.1：原样透传，不被默认值覆盖。"""
        self.assertEqual(resolve_tsdf_options("sdf", 0.1), ("sdf", 0.1))

    def test_explicit_occupancy_string_percentile(self):
        """JSON 里的数字可能以字符串形式到达，应被安全转换。"""
        self.assertEqual(resolve_tsdf_options("occupancy", "0.1"), ("occupancy", 0.1))

    def test_unknown_extraction_raises(self):
        with self.assertRaises(ValueError) as ctx:
            resolve_tsdf_options("marching", 0.1)
        self.assertIn("meshExtraction", str(ctx.exception))

    def test_percentile_out_of_range_raises(self):
        for bad in (-0.1, 0.51, 1.0):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError) as ctx:
                    resolve_tsdf_options("sdf", bad)
                self.assertIn("meshBboxPercentile", str(ctx.exception))

    def test_percentile_not_a_number_raises(self):
        with self.assertRaises(ValueError) as ctx:
            resolve_tsdf_options("sdf", "abc")
        self.assertIn("meshBboxPercentile", str(ctx.exception))

    def test_percentile_nan_raises(self):
        """NaN 通过类型检查但与任何数比较都为假，必须显式拒绝。"""
        with self.assertRaises(ValueError):
            resolve_tsdf_options("sdf", float("nan"))


if __name__ == "__main__":
    unittest.main()
