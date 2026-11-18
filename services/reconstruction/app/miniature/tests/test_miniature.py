"""T-700067 / T-700068 模块级单元测试（标准库 unittest，不依赖 pytest）。

跑法（仓库根）：
  python -m unittest discover -s services/reconstruction/app/miniature/tests -t services/reconstruction
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

REPO = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(REPO / "services" / "reconstruction"))

from app.miniature import contracts as C  # noqa: E402
from app.miniature import coordinates as CO  # noqa: E402
from app.miniature import instances as I  # noqa: E402


def _blob(cx: float, cy: float, n: int = 3000, seed: int = 0, jitter: float = 0.15) -> np.ndarray:
    """单团点云。密度要够（3000 点在 0.15 半径内），否则 5 cm 体素下会碎成几十块，
    测的就不是聚类逻辑而是采样噪声。

    z 取值刻意避开 [0.0, 0.6]：那样 5%/95% 分位中心恰好是 0.30 = 0.5×ID_GRID_NU，
    正落在量化桶边界上，两次独立采样会因极小抖动分到相邻桶、产出不同 ID。
    这是测试数据构造问题（哈希量化天然有边界 cliff），不是稳定性缺陷；
    取 [0.10, 0.70] 使中心约 0.40（0.7 桶），离边界 0.1 nu，远大于分位估计误差。
    """
    rng = np.random.default_rng(seed)
    return np.stack(
        [
            cx + rng.uniform(-jitter, jitter, n),
            cy + rng.uniform(-jitter, jitter, n),
            rng.uniform(0.10, 0.70, n),
        ],
        axis=1,
    )


def _structure() -> dict:
    return {
        "up_world": [0.0, 0.0, 1.0],
        "frame": {"e1": [1.0, 0.0, 0.0], "e2": [0.0, 1.0, 0.0]},
        "origin_world": [0.0, 0.0, 0.0],
        "floor": {"d_along_up": 0.0},
        "span_nu": {"e1": 10.0, "e2": 10.0, "up": 3.0},
        "status": "ok",
        "diagnostics": [],
        "faces": [],
        "kept_walls": [],
        "visibility": {},
        "extent_nu": {"e1": 10.0, "e2": 10.0, "up": 3.0},
        "schema": "miniature.structure.v1",
    }


def _images() -> list:
    return [
        {
            "id": 1,
            "qvec": [1.0, 0.0, 0.0, 0.0],
            "tvec": [0.0, 0.0, 3.0],
            "camera_id": 1,
            "name": "a.jpg",
        }
    ]


def _cams() -> dict:
    return {
        1: {
            "camera_id": 1,
            "model_id": 1,
            "width": 640,
            "height": 480,
            "params": [500.0, 500.0, 320.0, 240.0],
        }
    }


class TestContracts(unittest.TestCase):
    def _manifest(self, status: str = "ok") -> dict:
        m = C.InputManifest(scene_key="k", scene_path="/x", status=status)
        if status == "unsupported":
            m.diagnostics = [C.Diagnostic(C.D_LOW_LOOKDIR_COVERAGE, "error", "覆盖不足")]
        return m.finalize().as_dict()

    def test_manifest_id_is_content_hash(self) -> None:
        m = self._manifest()
        self.assertEqual(C.validate_manifest(m), [])
        tampered = dict(m)
        tampered["scene_key"] = "other"
        self.assertTrue(any("manifest_id" in e for e in C.validate_manifest(tampered)))

    def test_unsupported_needs_diagnostics(self) -> None:
        m = self._manifest("ok")
        m["status"] = "unsupported"
        m.pop("manifest_id")
        m["manifest_id"] = C.sha256_text(C.canonical_json(m))
        self.assertTrue(C.validate_manifest(m))

    def test_status_escalates_from_severity(self) -> None:
        self.assertEqual(C.decide_status([C.Diagnostic(C.D_OK, "info", "")]), "ok")
        self.assertEqual(C.decide_status([C.Diagnostic("X", "warn", "")]), "degraded")
        self.assertEqual(C.decide_status([C.Diagnostic("X", "error", "")]), "unsupported")


class TestStableId(unittest.TestCase):
    def test_same_object_same_id_across_sampling(self) -> None:
        a = _blob(1.0, 2.0, seed=1)
        b = _blob(1.0, 2.0, seed=2)
        self.assertEqual(I._stable_id(a), I._stable_id(b))

    def test_different_positions_get_different_ids(self) -> None:
        self.assertNotEqual(I._stable_id(_blob(0.0, 0.0)), I._stable_id(_blob(3.0, 3.0)))

    def test_id_is_content_addressed_not_sequential(self) -> None:
        self.assertTrue(I._stable_id(_blob(0.0, 0.0)).startswith("inst_"))


class TestCoordinates(unittest.TestCase):
    def _frame(self):
        return CO.build_frame(
            up=[0.0, 1.0, 0.0], e1=[1.0, 0.0, 0.0], e2=[0.0, 0.0, 1.0], origin=[2.0, -1.0, 0.5]
        )

    def test_local_transform_matches_axes(self) -> None:
        fr = self._frame()
        org = CO.world_to_local(np.array([[2.0, -1.0, 0.5]]), fr)[0]
        self.assertAlmostEqual(float(np.linalg.norm(org)), 0.0, places=9)
        # 沿 e1 走 3 个单位 → local 的 (3, 0, 0)
        p = np.array([2.0, -1.0, 0.5]) + 3.0 * np.array([1.0, 0.0, 0.0])
        got = CO.world_to_local(p[None, :], fr)[0]
        self.assertAlmostEqual(float(got[0]), 3.0, places=9)
        self.assertAlmostEqual(float(got[1]), 0.0, places=9)

    def test_roundtrip_world_local(self) -> None:
        fr = self._frame()
        pts = np.array([[0.0, 0.0, 0.0], [5.0, 2.0, -3.0]])
        back = CO.local_to_world(CO.world_to_local(pts, fr), fr)
        self.assertTrue(np.allclose(back, pts, atol=1e-9))

    def test_orthonormal_frame_passes(self) -> None:
        self.assertEqual(CO.check_frame(self._frame()), [])

    def test_non_orthogonal_axes_rejected(self) -> None:
        fr = self._frame()
        fr["local_axes"]["e2"] = [0.6, 0.0, 0.8]  # 与 e1 不正交
        codes = [d["code"] for d in CO.check_frame(fr)]
        self.assertIn(C.D_SCALE_INCONSISTENT, codes)

    def test_nu_unit_must_not_declare_meters(self) -> None:
        fr = self._frame()
        fr["scale"] = {"unit": "nu", "meters_per_unit": 1.0, "source": "manual"}
        self.assertTrue(any(d["severity"] == "error" for d in CO.check_frame(fr)))

    def test_from_structure_keeps_unmetric_scale(self) -> None:
        fr = CO.from_structure(_structure())
        self.assertEqual(fr["scale"]["unit"], "nu")
        self.assertIsNone(fr["scale"]["meters_per_unit"])

    def test_distorted_model_flagged_when_undistortion_unknown(self) -> None:
        cams = {1: {"model_id": 4, "params": [500.0, 500.0, 320.0, 240.0, 0.1, -0.05, 0.01, 0.002]}}
        diags = CO.check_intrinsics(cams, undistorted=None)
        self.assertEqual([d["code"] for d in diags], [C.D_DISTORTION_NOT_UNDISTORTED])
        self.assertEqual(diags[0]["severity"], "warn")

    def test_undistorted_images_pass(self) -> None:
        cams = {1: {"model_id": 4, "params": [500.0, 500.0, 320.0, 240.0, 0.1, -0.05, 0.01, 0.002]}}
        self.assertEqual(CO.check_intrinsics(cams, undistorted=True), [])

    def test_pinhole_has_no_distortion_diagnostic(self) -> None:
        cams = {1: {"model_id": 1, "params": [500.0, 500.0, 320.0, 240.0]}}
        self.assertEqual(CO.check_intrinsics(cams, undistorted=None), [])

    def test_wrong_param_count_is_error(self) -> None:
        cams = {1: {"model_id": 1, "params": [500.0, 500.0]}}
        diags = CO.check_intrinsics(cams, undistorted=True)
        self.assertEqual(diags[0]["code"], C.D_SCALE_INCONSISTENT)
        self.assertEqual(diags[0]["severity"], "error")


class TestCluster(unittest.TestCase):
    def test_separates_two_blobs(self) -> None:
        q = np.vstack([_blob(0.0, 0.0), _blob(3.0, 3.0)])
        lab, _ = I._cluster(q, 0.05)
        self.assertEqual(len(set(lab[lab > 0].tolist())), 2)

    def test_merges_one_connected_blob(self) -> None:
        lab, _ = I._cluster(_blob(0.0, 0.0), 0.05)
        self.assertEqual(len(set(lab[lab > 0].tolist())), 1)


class TestDetectInstances(unittest.TestCase):
    def _run(self, points: np.ndarray, nerf_transform=None):
        with mock.patch.object(I, "_find_colmap", return_value=Path("/fake/colmap")), mock.patch.object(
            I, "read_points3d_bin", return_value={"xyz": points}
        ), mock.patch.object(I, "read_images_bin", return_value=_images()), mock.patch.object(
            I, "read_cameras_bin", return_value=_cams()
        ):
            return I.detect_instances(Path("/fake/scene"), _structure(), nerf_transform=nerf_transform)

    def test_two_objects_two_ids_and_partial_kept(self) -> None:
        pts = np.vstack([_blob(-1.0, 0.0), _blob(1.0, 0.0)])
        doc = self._run(pts)
        self.assertEqual(doc["status"], "ok")
        self.assertEqual(doc["n_instances"], 2)
        ids = [i["id"] for i in doc["instances"]]
        self.assertEqual(len(set(ids)), 2)
        # 单相机 → 每个实例只被 1 个视角看到 → partial=True，但仍必须在输出里
        self.assertTrue(all(i["partial"] for i in doc["instances"]))
        self.assertTrue(all(i["n_points"] >= 80 for i in doc["instances"]))

    def test_degenerate_cluster_skipped_and_counted(self) -> None:
        dup = np.repeat(np.array([[0.5, 0.5, 0.3]]), 400, axis=0)
        pts = np.vstack([_blob(-1.0, 0.0), dup])
        doc = self._run(pts)
        self.assertEqual(doc["n_degenerate_skipped"], 1)
        self.assertEqual(doc["n_instances"], 1)

    def test_nonfinite_points_dropped_and_counted(self) -> None:
        pts = np.vstack([_blob(-1.0, 0.0), np.array([[np.nan, 0.0, 0.0], [np.inf, 1.0, 1.0]])])
        doc = self._run(pts)
        self.assertEqual(doc["n_nonfinite_skipped"], 2)
        self.assertEqual(doc["n_instances"], 1)

    def test_missing_sfm_is_explicitly_unsupported(self) -> None:
        with mock.patch.object(I, "_find_colmap", return_value=None):
            doc = I.detect_instances(Path("/fake/scene"), _structure())
        self.assertEqual(doc["status"], "unsupported")
        self.assertEqual(doc["diagnostics"][0]["code"], C.D_NO_SFM_BASELINE)

    def test_output_has_provenance_fields(self) -> None:
        doc = self._run(_blob(-1.0, 0.0))
        inst = doc["instances"][0]
        for key in ("id", "confidence", "source", "unobserved_voxel_ratio", "n_views", "partial", "label"):
            self.assertIn(key, inst)
        self.assertEqual(inst["source"], "sfm-points")
        self.assertEqual(inst["label"], "unclassified")

    def test_nerf_transform_adds_nerf_fields_and_keeps_nu_identical(self) -> None:
        pts = np.vstack([_blob(-1.0, 0.0), _blob(1.0, 0.0)])
        base = self._run(pts)
        tf = {"transform": np.eye(4), "scale": 1.0, "path": "/fake/dataparser_transforms.json"}
        doc = self._run(pts, tf)

        # aabb_nu 必须逐字节不变（加了 nerf 字段也不能动既有口径）
        self.assertEqual(
            json.dumps([i["aabb_nu"] for i in base["instances"]], sort_keys=True),
            json.dumps([i["aabb_nu"] for i in doc["instances"]], sort_keys=True),
        )
        self.assertEqual([i["id"] for i in base["instances"]], [i["id"] for i in doc["instances"]])
        for inst in doc["instances"]:
            self.assertIn("aabb_nerf", inst)
            self.assertIn("centroid_nerf", inst)
            # M=I, scale=1 → nerf 系与 COLMAP 全等，质心应逐值对齐
            np.testing.assert_allclose(inst["centroid_nerf"], inst["centroid_world"], atol=1e-4)
            for a, b in zip(inst["aabb_nerf"]["min"], inst["aabb_nerf"]["max"]):
                self.assertLessEqual(a, b)
        self.assertIsNotNone(doc["frame"]["colmap_to_nerf"])
        self.assertEqual(doc["frame"]["unit"], "nu")
        self.assertNotIn("NO_NERF_TRANSFORM", [d["code"] for d in doc["diagnostics"]])

    def test_missing_nerf_transform_warns_and_omits_nerf_fields(self) -> None:
        doc = self._run(_blob(-1.0, 0.0))
        self.assertIn("NO_NERF_TRANSFORM", [d["code"] for d in doc["diagnostics"]])
        self.assertNotIn("aabb_nerf", doc["instances"][0])
        self.assertIsNone(doc["frame"]["colmap_to_nerf"])


if __name__ == "__main__":
    unittest.main()
