"""T-700007 子模型合并单元测试（标准库 unittest，不依赖 pytest）。

跑法（仓库根）：
  python -m unittest discover -s services/reconstruction/app/miniature/tests -t services/reconstruction

合成夹具自造：9 台环绕相机 + 55 个 3D 点，分裂成两个共享 3 张图像的子模型，
B 模型整体施加已知相似变换（尺度 1.7 + 绕 z 转 30° + 平移）。合并必须恢复参考系。
全部数据为程序生成（synthetic），不代表真实重建。
"""
from __future__ import annotations

import inspect
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import numpy as np

REPO = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(REPO / "services" / "reconstruction"))

from app.miniature import contracts as C  # noqa: E402
from app.miniature import sfm_io as S  # noqa: E402
from app.pipeline import colmap as colmap_mod  # noqa: E402

# B 模型相对参考系的真实相似变换（合成真值，合并后必须恢复）
SCALE = 1.7
_ang = np.deg2rad(30.0)
ROT = np.array([[np.cos(_ang), -np.sin(_ang), 0], [np.sin(_ang), np.cos(_ang), 0], [0, 0, 1.0]])
TRANS = np.array([2.0, -1.0, 0.5])


def _look_at(center: np.ndarray, target: np.ndarray = np.array([0.0, 0.0, 0.8])) -> np.ndarray:
    up = np.array([0.0, 0.0, 1.0])
    fwd = target - center
    fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, up)
    right /= np.linalg.norm(right)
    down = np.cross(fwd, right)
    return np.stack([right, down, fwd])


def _pose(center: np.ndarray) -> dict:
    R = _look_at(center)
    return {"qvec": S.rotmat2qvec(R).tolist(), "tvec": (-R @ center).tolist()}


def _truth(n: int = 9):
    """n 台环绕相机（半径 3，高 1.5）+ 55 个随机点。返回 (cams, images, points_xyz)。"""
    cams = {1: {"camera_id": 1, "model_id": 1, "width": 800, "height": 600,
                "params": [700.0, 700.0, 400.0, 300.0]}}
    imgs = []
    for i in range(n):
        ang = 2 * np.pi * i / n
        center = np.array([3 * np.cos(ang), 3 * np.sin(ang), 1.5])
        imgs.append({"id": i + 1, "camera_id": 1, "name": f"img_{i + 1:02d}.jpg",
                     "center": center.tolist(), **_pose(center)})
    rng = np.random.default_rng(7)
    pts = rng.uniform([-1, -1, 0], [1, 1, 2], (55, 3))
    return cams, imgs, pts


def _make_model(directory: Path, cams: dict, imgs: list, xyz: np.ndarray, id_base: int,
                rng_seed: int = 11) -> None:
    """写一个自洽子模型：track 引用本模型 image id，points2D 引用本模型 point3D_id。"""
    directory.mkdir(parents=True, exist_ok=True)
    n = len(xyz)
    ids = np.arange(id_base, id_base + n, dtype=np.uint64)
    timg, tp2d = [], []
    for j in range(n):
        timg.append(np.array([(j % len(imgs)) + 1, ((j + 2) % len(imgs)) + 1], dtype=np.int64))
        tp2d.append(np.array([0, 1], dtype=np.int64))
    rng = np.random.default_rng(rng_seed)
    out_imgs = []
    for im in imgs:
        mask = [j for j in range(n) if im["id"] in timg[j]]
        out_imgs.append({
            **im,
            "points2d_xy": rng.uniform(0, 800, (len(mask), 2)),
            "points2d_point3d_ids": ids[np.asarray(mask, dtype=np.int64)] if mask else np.zeros(0, np.uint64),
        })
    S.write_cameras_bin(directory / "cameras.bin", cams)
    S.write_images_bin(directory / "images.bin", out_imgs)
    S.write_points3d_bin(directory / "points3D.bin", {
        "n": n, "ids": ids, "xyz": xyz,
        "rgb": np.full((n, 3), 128, dtype=np.uint8), "error": np.full(n, 0.5),
        "track_image_ids": timg, "track_point2d_idx": tp2d,
    })


def _transformed(imgs: list, xyz: np.ndarray):
    """把参考系真值施加已知相似变换，得到 B 模型真值。"""
    out = []
    for im in imgs:
        R = S.qvec2rotmat(np.asarray(im["qvec"]))
        center = -R.T @ np.asarray(im["tvec"])
        center2 = SCALE * (ROT @ center) + TRANS
        R2 = R @ ROT.T
        out.append({**im, "qvec": S.rotmat2qvec(R2).tolist(), "tvec": (-R2 @ center2).tolist(),
                    "center": center2.tolist()})
    return out, SCALE * (xyz @ ROT.T) + TRANS


def _two_models(root: Path):
    """A=图像1..6+点0..29；B=图像4..9+点30..54（B 已施加相似变换）。共享 img_04..06。"""
    cams, imgs, pts = _truth()
    a = root / "sparse" / "0"
    b = root / "sparse" / "1"
    _make_model(a, cams, imgs[0:6], pts[0:30], id_base=101)
    b_imgs, b_pts = _transformed(imgs[3:9], pts[30:55])
    for k, im in enumerate(b_imgs):
        im["id"] = k + 1  # B 有自己的 image id 空间
    _make_model(b, cams, b_imgs, b_pts, id_base=201, rng_seed=12)
    return a, b, imgs, pts


class TestBinaryRoundtrip(unittest.TestCase):
    def test_roundtrip_with_large_uint64_ids(self):
        cams, imgs, pts = _truth(3)
        big = np.array([2**63 + 5, 7, 2**64 - 1], dtype=np.uint64)  # 含无效 id 位模式
        for im in imgs:
            im["points2d_xy"] = np.array([[1.5, 2.5], [3.0, 4.0]])
            im["points2d_point3d_ids"] = big[:2]
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            _make_model(d, cams, imgs, pts[:3], id_base=101)
            # 覆写 images.bin 以携带大 uint64 id
            S.write_images_bin(d / "images.bin", imgs)
            rc = S.read_cameras_bin(d / "cameras.bin")
            ri = S.read_images_bin(d / "images.bin", with_points2d=True)
            rp = S.read_points3d_bin(d / "points3D.bin", with_tracks=True)
            self.assertEqual(rc[1]["params"], cams[1]["params"])
            self.assertEqual([x["name"] for x in ri], [x["name"] for x in imgs])
            np.testing.assert_allclose(ri[0]["points2d_xy"], imgs[0]["points2d_xy"])
            np.testing.assert_array_equal(ri[0]["points2d_point3d_ids"], big[:2])
            np.testing.assert_allclose(rp["xyz"], pts[:3])
            np.testing.assert_array_equal(rp["track_image_ids"][0], [1, 3])
            self.assertEqual(rp["n"], 3)

    def test_rotmat_qvec_roundtrip(self):
        rng = np.random.default_rng(3)
        for _ in range(20):
            center = rng.uniform(-5, 5, 3)
            center[2] = abs(center[2]) + 0.5
            R = _look_at(center)
            q = S.rotmat2qvec(R)
            np.testing.assert_allclose(S.qvec2rotmat(q), R, atol=1e-9)
            self.assertAlmostEqual(float(np.linalg.norm(q)), 1.0, places=9)


class TestMerge(unittest.TestCase):
    def test_merge_increases_registration(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            a, b, _, _ = _two_models(root)
            out = root / "merged"
            rep = S.merge_sparse_models([a, b], out)
            merged = S.read_images_bin(out / "images.bin")
            self.assertEqual(rep["status"], S.MERGE_OK)
            self.assertEqual(len(merged), 9)
            self.assertGreater(len(merged), len(S.read_images_bin(a / "images.bin")))
            self.assertGreater(len(merged), len(S.read_images_bin(b / "images.bin")))
            self.assertEqual({im["name"] for im in merged}, {f"img_{i:02d}.jpg" for i in range(1, 10)})
            self.assertEqual(rep["registered_merged"], 9)
            self.assertEqual(rep["points_merged"], 55)
            self.assertEqual(rep["shared_images"][str(b)], 3)

    def test_merge_recovers_reference_frame(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            a, b, truth_imgs, _ = _two_models(root)
            out = root / "merged"
            rep = S.merge_sparse_models([a, b], out)
            merged = {im["name"]: im for im in S.read_images_bin(out / "images.bin")}
            # B 独有图像：合并后中心必须回到参考系真值
            for i in (6, 7, 8):
                np.testing.assert_allclose(merged[f"img_{i + 1:02d}.jpg"]["center"],
                                           truth_imgs[i]["center"], atol=1e-6)
            # 共享图像：保留参考模型位姿（逐位相等）
            ref_imgs = {im["name"]: im for im in S.read_images_bin(a / "images.bin")}
            for nm in ("img_04.jpg", "img_05.jpg", "img_06.jpg"):
                np.testing.assert_allclose(merged[nm]["qvec"], ref_imgs[nm]["qvec"], atol=0, rtol=0)
            al = rep["alignments"][0]
            # 报告的是 B→参考系 的变换：B = SCALE·ROT·A + TRANS ⇒ 逆变换如下
            self.assertAlmostEqual(al["scale"], 1.0 / SCALE, places=6)
            np.testing.assert_allclose(al["rotation"], ROT.T, atol=1e-6)
            np.testing.assert_allclose(al["translation"], -ROT.T @ TRANS / SCALE, atol=1e-6)
            self.assertLess(al["rms_residual"], 1e-6)

    def test_merge_tracks_and_points2d_remapped(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            a, b, _, _ = _two_models(root)
            out = root / "merged"
            S.merge_sparse_models([a, b], out)
            imgs = S.read_images_bin(out / "images.bin", with_points2d=True)
            pts = S.read_points3d_bin(out / "points3D.bin", with_tracks=True)
            valid_img_ids = {im["id"] for im in imgs}
            valid_pt_ids = set(pts["ids"].tolist())
            for t in pts["track_image_ids"]:
                self.assertTrue(set(t.tolist()) <= valid_img_ids)
            for im in imgs:
                for v in im["points2d_point3d_ids"].tolist():
                    self.assertIn(v, valid_pt_ids)
            self.assertEqual(len(imgs), 9)
            self.assertEqual(pts["n"], 55)

    def test_merge_deterministic(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            a, b, _, _ = _two_models(root)
            o1, o2 = root / "m1", root / "m2"
            S.merge_sparse_models([a, b], o1)
            S.merge_sparse_models([a, b], o2)
            for nm in ("cameras.bin", "images.bin", "points3D.bin"):
                self.assertEqual((o1 / nm).read_bytes(), (o2 / nm).read_bytes())


class TestMergeDiagnostics(unittest.TestCase):
    def test_no_shared_images(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            a, b, _, _ = _two_models(root)
            # 把 B 的图像全部改名 → 无共享
            imgs = S.read_images_bin(b / "images.bin", with_points2d=True)
            for im in imgs:
                im["name"] = "other_" + im["name"]
            S.write_images_bin(b / "images.bin", imgs)
            out = root / "merged"
            with self.assertRaises(S.MergeError) as ctx:
                S.merge_sparse_models([a, b], out)
            self.assertEqual(ctx.exception.code, S.MERGE_NO_SHARED_IMAGES)
            self.assertFalse(out.exists() and any(out.iterdir()))

    def test_insufficient_shared(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            cams, imgs, pts = _truth()
            a, b = root / "a", root / "b"
            _make_model(a, cams, imgs[0:6], pts[0:30], 101)
            b_imgs, b_pts = _transformed(imgs[4:9], pts[30:55])  # 共享仅 img_05、img_06
            for k, im in enumerate(b_imgs):
                im["id"] = k + 1
            _make_model(b, cams, b_imgs, b_pts, 201)
            with self.assertRaises(S.MergeError) as ctx:
                S.merge_sparse_models([a, b], root / "m")
            self.assertEqual(ctx.exception.code, S.MERGE_INSUFFICIENT_SHARED)

    def test_single_model(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            a, _, _, _ = _two_models(root)
            with self.assertRaises(S.MergeError) as ctx:
                S.merge_sparse_models([a], root / "m")
            self.assertEqual(ctx.exception.code, S.MERGE_SINGLE_MODEL)

    def test_degenerate_collinear_centers(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            cams = {1: {"camera_id": 1, "model_id": 1, "width": 800, "height": 600,
                        "params": [700.0, 700.0, 400.0, 300.0]}}
            imgs = []
            for i in range(3):
                center = np.array([float(i), 0.0, 1.5])  # 共线
                imgs.append({"id": i + 1, "camera_id": 1, "name": f"c{i}.jpg", **_pose(center)})
            pts = np.zeros((4, 3))
            a, b = root / "a", root / "b"
            _make_model(a, cams, imgs, pts, 101)
            # 统一平移保持共线：t' = t - R·d（逐图 R 不同，但中心偏移一致）
            d = np.array([0.0, 0.0, 0.5])
            b_imgs = []
            for im in imgs:
                R = S.qvec2rotmat(np.asarray(im["qvec"]))
                b_imgs.append({**im, "tvec": (np.asarray(im["tvec"]) - R @ d).tolist()})
            _make_model(b, cams, b_imgs, pts, 201)
            with self.assertRaises(S.MergeError) as ctx:
                S.merge_sparse_models([a, b], root / "m")
            self.assertEqual(ctx.exception.code, S.MERGE_DEGENERATE_GEOMETRY)

    def test_alignment_failed_not_same_scene(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            cams, imgs, pts = _truth(4)
            a, b = root / "a", root / "b"
            _make_model(a, cams, imgs, pts[:10], 101)
            # B 的共享中心施加逐图不同的大偏移 → 不是相似变换，残差必超限
            offsets = np.array([[0, 0, 0], [1.5, 0, 0], [0, 1.5, 0], [0, 0, 1.5]], dtype=float)
            b_imgs = []
            for im, off in zip(imgs, offsets):
                center = np.asarray(im["center"]) + off
                b_imgs.append({**im, **_pose(center)})
            _make_model(b, cams, b_imgs, pts[10:20], 201)
            with self.assertRaises(S.MergeError) as ctx:
                S.merge_sparse_models([a, b], root / "m")
            self.assertEqual(ctx.exception.code, S.MERGE_ALIGNMENT_FAILED)


class TestRegistrationRatio(unittest.TestCase):
    def test_denominator_is_processed_images_not_uploads(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            a, _, _, _ = _two_models(root)
            processed = root / "processed" / "task-x" / "images"
            uploads = root / "uploads"
            processed.mkdir(parents=True)
            uploads.mkdir()
            for i in range(9):
                (processed / f"img_{i + 1:02d}.jpg").write_bytes(b"x")
            (processed / "notes.txt").write_bytes(b"x")  # 非图片不计
            (processed / "sub").mkdir()  # 目录不计
            for i in range(3):
                (uploads / f"u{i}.jpg").write_bytes(b"x")  # uploads 不得作分母
            r = S.registration_ratio(a, processed)
            self.assertEqual(r["registered"], 6)
            self.assertEqual(r["total"], 9)
            self.assertAlmostEqual(r["ratio"], 6 / 9)
            self.assertEqual(r["denominator_source"], str(processed))


class TestManifestIdContentHash(unittest.TestCase):
    def test_manifest_id_changes_when_merge_changes_coverage(self):
        def manifest(n_registered: int) -> C.InputManifest:
            return C.InputManifest(
                scene_key="k", scene_path="processed/task-x",
                coverage=C.Coverage(n_registered=n_registered),
                colmap={"registered": n_registered, "merged": n_registered > 6},
                synthetic=True,
            ).finalize()

        single, merged = manifest(6), manifest(9)
        self.assertNotEqual(single.manifest_id, merged.manifest_id)
        self.assertEqual(C.validate_manifest(single.as_dict()), [])
        self.assertEqual(C.validate_manifest(merged.as_dict()), [])
        # 内容不变 → 哈希不变（确定性）
        self.assertEqual(manifest(9).manifest_id, merged.manifest_id)

    def test_manifest_id_tracks_actual_model_reads(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            a, b, _, _ = _two_models(root)
            out = root / "merged"
            S.merge_sparse_models([a, b], out)
            n_single = len(S.read_images_bin(a / "images.bin"))
            n_merged = len(S.read_images_bin(out / "images.bin"))
            m1 = C.InputManifest("k", "p", coverage=C.Coverage(n_registered=n_single), synthetic=True).finalize()
            m2 = C.InputManifest("k", "p", coverage=C.Coverage(n_registered=n_merged), synthetic=True).finalize()
            self.assertNotEqual(m1.manifest_id, m2.manifest_id)


class TestF1014582ScenarioSynthetic(unittest.TestCase):
    """合成复现 f1014582 的历史分裂比例（60/104 → 102/104），验证机制与分母口径。

    明确声明：这是程序生成的合成场景，不是真实 f1014582 数据。
    真实数据的两个对照数字（2026-11-12 实测）见 docs/miniature/THRESHOLDS.md
    与 DATA-PROVENANCE.md；本机无 COLMAP 且无该任务原始数据，无法复测。
    """

    def test_split_104_photos_60_vs_102(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            n = 104
            cams = {1: {"camera_id": 1, "model_id": 1, "width": 800, "height": 600,
                        "params": [700.0, 700.0, 400.0, 300.0]}}
            imgs = []
            for i in range(n):
                ang = 2 * np.pi * i / n
                center = np.array([3 * np.cos(ang), 3 * np.sin(ang), 1.5 + 0.3 * np.sin(3 * ang)])
                imgs.append({"id": i + 1, "camera_id": 1, "name": f"img_{i + 1:03d}.jpg",
                             "center": center.tolist(), **_pose(center)})
            rng = np.random.default_rng(17)
            pts = rng.uniform([-1, -1, 0], [1, 1, 2], (200, 3))
            a, b = root / "sparse" / "0", root / "sparse" / "1"
            _make_model(a, cams, imgs[0:60], pts[0:100], 1001)
            b_imgs, b_pts = _transformed(imgs[57:102], pts[100:200])  # 45 张，共享 3 张 → 并集 102
            for k, im in enumerate(b_imgs):
                im["id"] = k + 1
            _make_model(b, cams, b_imgs, b_pts, 2001, rng_seed=18)
            processed = root / "processed" / "f1014582-synthetic" / "images"
            processed.mkdir(parents=True)
            for i in range(n):
                (processed / f"img_{i + 1:03d}.jpg").write_bytes(b"x")

            r_single = S.registration_ratio(a, processed)
            self.assertEqual((r_single["registered"], r_single["total"]), (60, 104))
            self.assertAlmostEqual(r_single["ratio"], 60 / 104, places=4)
            self.assertLess(r_single["ratio"], C.THRESHOLDS["min_registered_ratio"])  # 触发 warn 线

            out = root / "merged"
            rep = S.merge_sparse_models([a, b], out)
            r_merged = S.registration_ratio(out, processed)
            self.assertEqual(rep["status"], S.MERGE_OK)
            self.assertEqual((r_merged["registered"], r_merged["total"]), (102, 104))
            self.assertAlmostEqual(r_merged["ratio"], 102 / 104, places=4)
            self.assertGreaterEqual(r_merged["ratio"], 0.98)


class TestRunColmapIntegration(unittest.TestCase):
    """mock COLMAP 二进制：mapper 阶段写入合成子模型，验证 run_colmap 的合并集成。"""

    def _fake_run(self, root: Path, models: str):
        def run(cmd, **kwargs):
            stage = cmd[1]
            if stage == "mapper":
                wd = Path(kwargs["cwd"])
                if models == "two":
                    _two_models(wd)
                elif models == "disjoint":
                    a, b, _, _ = _two_models(wd)
                    imgs = S.read_images_bin(b / "images.bin", with_points2d=True)
                    for im in imgs:
                        im["name"] = "other_" + im["name"]
                    S.write_images_bin(b / "images.bin", imgs)
                elif models == "single":
                    cams, imgs, pts = _truth()
                    _make_model(wd / "sparse" / "0", cams, imgs[0:6], pts[0:30], 101)
                # models == "none"：mapper 不产出任何模型
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        return run

    def _run(self, root: Path, models: str) -> Path:
        with mock.patch.object(colmap_mod, "find_colmap", return_value="colmap"), \
             mock.patch.object(colmap_mod.subprocess, "run", side_effect=self._fake_run(root, models)):
            return colmap_mod.run_colmap(root, root / "images")

    def test_multi_model_merged_into_sparse0(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            model_dir = self._run(root, "two")
            self.assertEqual(model_dir, root / "sparse" / "0")
            self.assertEqual(len(S.read_images_bin(model_dir / "images.bin")), 9)
            self.assertTrue((root / "sparse" / "raw" / "0" / "images.bin").exists())
            self.assertTrue((root / "sparse" / "raw" / "1" / "images.bin").exists())
            rep = json.loads((root / "merge_report.json").read_text(encoding="utf-8"))
            self.assertEqual(rep["status"], S.MERGE_OK)
            self.assertEqual(rep["registered_merged"], 9)
            self.assertEqual([m["registered"] for m in rep["models"]], [6, 6])

    def test_unmergeable_reports_diagnostic_not_fake_merge(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            model_dir = self._run(root, "disjoint")
            self.assertEqual(model_dir, root / "sparse" / "0")
            self.assertEqual(len(S.read_images_bin(model_dir / "images.bin")), 6)  # 原样，未冒充
            self.assertTrue((root / "sparse" / "1" / "images.bin").exists())
            self.assertFalse((root / "sparse" / "raw").exists())
            rep = json.loads((root / "merge_report.json").read_text(encoding="utf-8"))
            self.assertEqual(rep["status"], S.MERGE_NO_SHARED_IMAGES)
            self.assertIn("无共享图像", rep["message"])

    def test_single_model_report(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            model_dir = self._run(root, "single")
            self.assertEqual(model_dir, root / "sparse" / "0")
            rep = json.loads((root / "merge_report.json").read_text(encoding="utf-8"))
            self.assertEqual(rep["status"], S.MERGE_SINGLE_MODEL)
            self.assertEqual(rep["registered"], 6)

    def test_no_model_raises(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            with self.assertRaises(RuntimeError):
                self._run(root, "none")

    def test_cache_early_return_skips_colmap(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            cams, imgs, pts = _truth()
            _make_model(root / "sparse" / "0", cams, imgs[0:6], pts[0:30], 101)
            (root / "input_fingerprint.json").write_text("{}", encoding="utf-8")
            with mock.patch.object(colmap_mod, "find_colmap", return_value="colmap"), \
                 mock.patch.object(colmap_mod.subprocess, "run",
                                   side_effect=AssertionError("缓存命中不应调用 COLMAP")):
                model_dir = colmap_mod.run_colmap(root, root / "images")
            self.assertEqual(model_dir, root / "sparse" / "0")

    def test_worker_call_signature_unchanged(self):
        sig = inspect.signature(colmap_mod.run_colmap)
        self.assertEqual(list(sig.parameters), ["work_dir", "image_dir", "use_gpu", "matcher"])
        self.assertIs(sig.parameters["use_gpu"].default, True)
        self.assertEqual(sig.parameters["matcher"].default, "exhaustive")


if __name__ == "__main__":
    unittest.main()