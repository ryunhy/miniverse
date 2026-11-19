"""T-700011：微缩阶段缓存单槽 → 多槽。

跑法（仓库根）：
  .venv/Scripts/python.exe -m pytest services/reconstruction/app/miniature/tests/test_cache_slots.py -v
  或 python -m unittest discover -s services/reconstruction/app/miniature/tests -t services/reconstruction

覆盖任务卡验收中可单测的部分：
① A→B→A 切回命中缓存、reused 含四阶段（合成场景 + 受控阶段函数，集成路径走真 run_miniature）；
③ reset_cache=True 时 reused=[]；
④ 槽位超上限按最近使用淘汰且有日志；
⑤ code_fingerprint 变化仍正确失效；
⑥ run_miniature 对外签名与返回结构不变；
⑧ 旧单槽目录平滑迁移 / 明确报不兼容，不静默丢数据。
② 的真实耗时实测由 docs/evidence/cache-slots/ 的取证脚本产出（合成场景，synthetic 标注）。

夹具全部合成（synthetic），不冒充真实重建。COLMAP 二进制写入自包含（struct 手工编码），
不依赖其他卡未提交的 sfm_io 写入器。
"""
from __future__ import annotations

import inspect
import json
import math
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(REPO / "services" / "reconstruction"))

from app.miniature import pipeline as P  # noqa: E402


# ---------------------------------------------------------------------------
# 合成 COLMAP 场景（自包含写入器）
# ---------------------------------------------------------------------------
def _norm(v):
    v = np.asarray(v, dtype=np.float64)
    return v / np.linalg.norm(v)


def _rotmat2qvec(R: np.ndarray) -> np.ndarray:
    """Shepperd 方法，与 sfm_io.qvec2rotmat 同一 Hamilton 约定。"""
    tr = R[0, 0] + R[1, 1] + R[2, 2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        w, x, y, z = 0.25 * s, (R[2, 1] - R[1, 2]) / s, (R[0, 2] - R[2, 0]) / s, (R[1, 0] - R[0, 1]) / s
    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
        s = math.sqrt(1.0 + R[0, 0] - R[1, 1] - R[2, 2]) * 2
        w, x, y, z = (R[2, 1] - R[1, 2]) / s, 0.25 * s, (R[0, 1] + R[1, 0]) / s, (R[0, 2] + R[2, 0]) / s
    elif R[1, 1] > R[2, 2]:
        s = math.sqrt(1.0 + R[1, 1] - R[0, 0] - R[2, 2]) * 2
        w, x, y, z = (R[0, 2] - R[2, 0]) / s, (R[0, 1] + R[1, 0]) / s, 0.25 * s, (R[1, 2] + R[2, 1]) / s
    else:
        s = math.sqrt(1.0 + R[2, 2] - R[0, 0] - R[1, 1]) * 2
        w, x, y, z = (R[1, 0] - R[0, 1]) / s, (R[0, 2] + R[2, 0]) / s, (R[1, 2] + R[2, 1]) / s, 0.25 * s
    q = np.array([w, x, y, z])
    return q / np.linalg.norm(q)


def room_points() -> tuple[np.ndarray, np.ndarray]:
    """合成房间：地板 + 两面墙 + 三团家具（synthetic）。"""
    rng = np.random.default_rng(7)
    pts, rgb = [], []

    def add(p, c):
        pts.append(p)
        rgb.append(np.tile(np.asarray(c, np.uint8), (len(p), 1)))

    gx, gy = np.meshgrid(np.linspace(-2, 2, 40), np.linspace(-1.5, 1.5, 30))
    add(np.stack([gx.ravel(), gy.ravel(), np.zeros(gx.size)], axis=1), (150, 140, 120))
    wz = np.linspace(0, 2.5, 25)
    wy = np.linspace(-1.5, 1.5, 30)
    a, b = np.meshgrid(wy, wz)
    add(np.stack([np.full(a.size, -2.0), a.ravel(), b.ravel()], axis=1), (180, 170, 150))
    wx = np.linspace(-2, 2, 40)
    a, b = np.meshgrid(wx, wz)
    add(np.stack([a.ravel(), np.full(a.size, 1.5), b.ravel()], axis=1), (170, 160, 140))
    for cx, cy, cz, c in [(-1.0, -0.6, 0.35, (160, 80, 60)), (0.8, -0.5, 0.4, (90, 110, 150)),
                          (0.2, 0.6, 0.25, (120, 140, 90))]:
        p = rng.normal(size=(900, 3)) * np.array([0.35, 0.3, 0.25]) + np.array([cx, cy, cz])
        p[:, 2] = np.clip(p[:, 2], 0.02, None)
        add(p, c)
    return np.concatenate(pts), np.concatenate(rgb)


def write_synthetic_scene(root: Path, n_cams: int = 24, with_photos: bool = True) -> Path:
    scene = root / "scene"
    colmap = scene / "colmap" / "sparse" / "0"
    colmap.mkdir(parents=True, exist_ok=True)
    with open(colmap / "cameras.bin", "wb") as f:
        f.write(struct.pack("<Q", 1))
        f.write(struct.pack("<IiQQ", 1, 1, 640, 480))  # PINHOLE
        f.write(struct.pack("<4d", 500.0, 500.0, 320.0, 240.0))
    poses = []
    with open(colmap / "images.bin", "wb") as f:
        f.write(struct.pack("<Q", n_cams))
        for i in range(n_cams):
            th = 2 * math.pi * i / n_cams
            C = np.array([3.0 * math.cos(th), 3.0 * math.sin(th), 1.5])
            T = np.array([0.0, 0.0, 0.8])
            fw = _norm(T - C)
            r = _norm(np.cross(fw, [0.0, 0.0, 1.0]))
            d = np.cross(fw, r)
            R = np.stack([r, d, fw])
            q = _rotmat2qvec(R)
            t = -R @ C
            poses.append((C, R))
            f.write(struct.pack("<I", i + 1))
            f.write(struct.pack("<4d", *q))
            f.write(struct.pack("<3d", *t))
            f.write(struct.pack("<I", 1))
            f.write(f"{i + 1:03d}.jpg".encode() + b"\0")
            f.write(struct.pack("<Q", 0))  # 无 points2d
    xyz, rgb = room_points()
    with open(colmap / "points3D.bin", "wb") as f:
        f.write(struct.pack("<Q", len(xyz)))
        for j in range(len(xyz)):
            f.write(struct.pack("<Q", j + 1))
            f.write(struct.pack("<3d", *xyz[j]))
            f.write(struct.pack("<3B", *rgb[j]))
            f.write(struct.pack("<d", 0.5))
            f.write(struct.pack("<Q", 0))  # 空 track
    if with_photos:
        img_dir = scene / "images"
        img_dir.mkdir(parents=True, exist_ok=True)
        for i in range(n_cams):
            Image.new("RGB", (640, 480), (120 + i % 40, 110, 100)).save(img_dir / f"{i + 1:03d}.jpg")
    return scene


# ---------------------------------------------------------------------------
# 缓存层单测
# ---------------------------------------------------------------------------
class TestMultiSlotCache(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.cache = self.root / "cache"
        self.out = self.root / "out"
        self.out.mkdir()
        self.logs: list[str] = []

    def tearDown(self):
        self.tmp.cleanup()

    def log(self, m):
        self.logs.append(m)

    def _doc_with_glb(self, tag: str) -> tuple[dict, Path, Path]:
        glb = self.out / "glb" / f"{tag}.glb"
        glb.parent.mkdir(parents=True, exist_ok=True)
        glb.write_bytes(f"glb-{tag}".encode() * 8)
        doc = {"status": "ok", "scene_glb": {"path": str(glb), "bytes": glb.stat().st_size}}
        doc_path = self.out / "texture.json"
        doc_path.write_text(json.dumps(doc), encoding="utf-8")
        return doc, doc_path, glb

    def test_roundtrip_restores_overwritten_output_and_artifacts(self):
        doc_a, path_a, glb_a = self._doc_with_glb("A")
        bytes_a = glb_a.read_bytes()
        P._write_cache(self.cache, "texture", "k" * 64, doc_a, path_a, 1.0, self.log)
        # 参数 B 的运行覆盖 out 里的原件与 GLB
        doc_b, path_b, glb_b = self._doc_with_glb("B")
        self.assertNotEqual(glb_b.read_bytes(), bytes_a)
        rec = P._read_cache(self.cache, "texture", "k" * 64, self.log)
        self.assertIsNotNone(rec)
        self.assertEqual(json.loads(path_a.read_text(encoding="utf-8")), doc_a)
        self.assertEqual(glb_a.read_bytes(), bytes_a)

    def test_wrong_key_is_miss(self):
        doc, path, _ = self._doc_with_glb("A")
        P._write_cache(self.cache, "texture", "a" * 64, doc, path, 0.1, self.log)
        self.assertIsNone(P._read_cache(self.cache, "texture", "b" * 64, self.log))
        self.assertIsNotNone(P._read_cache(self.cache, "texture", "a" * 64, self.log))

    def test_eviction_lru_with_log(self):
        # 键前 16 位必须有区分度（槽目录名取 key[:16]，与真实 sha256 键同形）
        keys = [f"{i:016x}" + "0" * 48 for i in range(P.MAX_SLOTS_PER_STAGE + 2)]
        for i, k in enumerate(keys):
            doc, path, _ = self._doc_with_glb(f"s{i}")
            P._write_cache(self.cache, "geometry", k, doc, path, 0.1, self.log)
            # 让 last_used 有先后：读一次旧槽刷新使用时间
            if i >= 2:
                P._read_cache(self.cache, "geometry", keys[i - 2], self.log)
        stage_dir = self.cache / "geometry"
        slots = sorted(d.name for d in stage_dir.iterdir() if d.is_dir())
        self.assertEqual(len(slots), P.MAX_SLOTS_PER_STAGE)
        self.assertIn(keys[-1][:P.SLOT_KEY_LEN], slots)  # 刚写入的槽必在
        self.assertTrue(any("缓存淘汰" in m for m in self.logs), self.logs)
        self.assertTrue(any("超上限" in m for m in self.logs))

    def test_relative_npz_artifact_restored(self):
        npz = self.out / "texture" / "i1-trace.npz"
        npz.parent.mkdir(parents=True, exist_ok=True)
        npz.write_bytes(b"npz-A" * 4)
        doc = {"status": "ok", "instances": [{"id": "i1", "traces": {"npz": "texture/i1-trace.npz"}}]}
        path = self.out / "texture.json"
        path.write_text(json.dumps(doc), encoding="utf-8")
        P._write_cache(self.cache, "texture", "c" * 64, doc, path, 0.1, self.log)
        npz.write_bytes(b"npz-B-overwritten")
        rec = P._read_cache(self.cache, "texture", "c" * 64, self.log)
        self.assertIsNotNone(rec)
        self.assertEqual(npz.read_bytes(), b"npz-A" * 4)

    def test_legacy_migration_intact(self):
        doc, path, glb = self._doc_with_glb("legacy")
        legacy = self.cache / "texture.json"
        legacy.parent.mkdir(parents=True, exist_ok=True)
        import hashlib
        legacy.write_text(json.dumps({
            "stage": "texture", "cache_key": "d" * 64, "status": "ok",
            "output": str(path), "output_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "seconds": 1.0, "created_at": "2026-01-01T00:00:00Z",
        }), encoding="utf-8")
        rec = P._read_cache(self.cache, "texture", "d" * 64, self.log)
        self.assertIsNotNone(rec)  # 平滑迁移后直接命中
        self.assertFalse(legacy.exists())
        self.assertTrue(legacy.with_suffix(".json.migrated").exists())
        self.assertTrue(any("平滑迁移" in m for m in self.logs))

    def test_legacy_overwritten_reports_incompatible_not_silent(self):
        doc, path, glb = self._doc_with_glb("legacy")
        legacy = self.cache / "structure.json"
        legacy.parent.mkdir(parents=True, exist_ok=True)
        legacy.write_text(json.dumps({
            "stage": "structure", "cache_key": "e" * 64, "status": "ok",
            "output": str(path), "output_sha256": "0" * 64,  # 产物已被覆盖，哈希不符
            "seconds": 1.0, "created_at": "2026-01-01T00:00:00Z",
        }), encoding="utf-8")
        before = legacy.read_bytes()
        self.assertIsNone(P._read_cache(self.cache, "structure", "e" * 64, self.log))
        self.assertTrue(any("无法恢复" in m for m in self.logs), self.logs)
        migrated = legacy.with_suffix(".json.migrated")
        self.assertTrue(migrated.exists())
        self.assertEqual(migrated.read_bytes(), before)  # 记录保留，不静默丢

    def test_legacy_non_record_file_untouched(self):
        self.cache.mkdir(parents=True, exist_ok=True)
        odd = self.cache / "ingest.json"
        odd.write_text('{"not": "a cache record"}', encoding="utf-8")
        self.assertIsNone(P._read_cache(self.cache, "ingest", "f" * 64, self.log))
        self.assertTrue(odd.exists())  # 不是缓存记录就不动它


# ---------------------------------------------------------------------------
# 集成：真 run_miniature + 合成场景 + 受控阶段函数
# ---------------------------------------------------------------------------
class TestPipelineMultiSlot(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.scene = write_synthetic_scene(self.root)
        self.out = self.root / "out"
        self.calls = {"structure": 0, "instances": 0, "geometry": 0, "texture": 0}
        self.logs: list[str] = []
        outer = self

        def fake_structure(scene):
            outer.calls["structure"] += 1
            return {"status": "ok", "schema": "miniature.structure.v1", "diagnostics": []}

        def fake_instances(scene, structure, voxel_nu=None, nerf_transform=None):
            outer.calls["instances"] += 1
            glb = outer.out / "glb" / "inst.glb"
            glb.parent.mkdir(parents=True, exist_ok=True)
            glb.write_bytes(f"inst-voxel{voxel_nu}".encode())
            return {"status": "ok", "n_instances": 1, "diagnostics": [],
                    "instances": [{"id": "i1", "glb": str(glb)}]}

        def fake_geometry(scene, structure, instances, out_dir=None, export_glb=True, alpha_factor=None):
            outer.calls["geometry"] += 1
            glb = Path(out_dir) / "glb" / "geo.glb"
            glb.parent.mkdir(parents=True, exist_ok=True)
            glb.write_bytes(f"geo-alpha{alpha_factor}".encode())
            return {"status": "ok", "n_instances": 1, "n_with_surface": 1, "diagnostics": [],
                    "instances": [{"id": "i1", "glb": str(glb)}]}

        def fake_texture(scene, structure, instances, out_dir=None, tex_size=None, export_glb=True):
            outer.calls["texture"] += 1
            glb = Path(out_dir) / "glb" / "scene.glb"
            glb.parent.mkdir(parents=True, exist_ok=True)
            glb.write_bytes(f"scene-tex{tex_size}".encode() * 4)
            return {"status": "ok", "diagnostics": [], "instances": [],
                    "scene_glb": {"path": str(glb), "bytes": glb.stat().st_size}}

        self.patchers = [
            mock.patch("app.miniature.structure.infer_structure", fake_structure),
            mock.patch("app.miniature.instances.detect_instances", fake_instances),
            mock.patch("app.miniature.instances.load_nerf_transform", lambda scene: None),
            mock.patch("app.miniature.geometry.build_geometry", fake_geometry),
            mock.patch("app.miniature.texture.build_texture", fake_texture),
            mock.patch.object(P, "code_fingerprint", lambda: "a" * 64),
        ]
        for p in self.patchers:
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def run_pipe(self, params=None, reset=False):
        return P.run_miniature(self.scene, self.out, params=params, reset_cache=reset,
                               log=self.logs.append)

    def test_ingest_accepts_synthetic_scene(self):
        res = self.run_pipe()
        self.assertEqual(res["stages"][0]["name"], "ingest")
        self.assertEqual(res["stages"][0]["status"], "ok", res.get("error"))

    def test_a_b_a_switchback_hits_all_four_stages(self):
        a = self.run_pipe({"miniatureTexSize": 512})
        self.assertEqual(a["status"], "ok", a.get("error"))
        self.assertEqual(a["cache"]["reused"], [])
        self.assertEqual(sum(self.calls.values()), 4)
        b = self.run_pipe({"miniatureTexSize": 256})
        self.assertEqual(b["status"], "ok", b.get("error"))
        self.assertEqual(b["cache"]["reused"], [])
        self.assertEqual(sum(self.calls.values()), 8)
        a2 = self.run_pipe({"miniatureTexSize": 512})
        self.assertEqual(a2["status"], "ok", a2.get("error"))
        self.assertEqual(a2["cache"]["reused"], ["structure", "instances", "geometry", "texture"])
        self.assertEqual(sum(self.calls.values()), 8)  # 切回 A 没有重算任何阶段
        self.assertLess(a2["seconds"], a["seconds"] + 1.0)
        # 产物恢复为 A 的字节（不是 B 覆盖后的）
        self.assertEqual((self.out / "glb" / "scene.glb").read_bytes(), b"scene-tex512" * 4)

    def test_reset_cache_forces_recompute(self):
        self.run_pipe()
        res = self.run_pipe(reset=True)
        self.assertEqual(res["cache"]["reused"], [])
        self.assertEqual(sum(self.calls.values()), 8)

    def test_code_fingerprint_change_invalidates(self):
        self.run_pipe()
        with mock.patch.object(P, "code_fingerprint", lambda: "b" * 64):
            res = self.run_pipe()
        self.assertEqual(res["cache"]["reused"], [])
        self.assertEqual(sum(self.calls.values()), 8)

    def test_signature_and_result_shape_unchanged(self):
        sig = inspect.signature(P.run_miniature)
        self.assertEqual(list(sig.parameters),
                         ["scene_dir", "out_dir", "params", "reset_cache", "on_stage",
                          "check_cancel", "log"])
        res = self.run_pipe()
        for k in ("schema", "status", "cache", "stages", "artifacts", "diagnostics",
                  "seconds", "finished_at"):
            self.assertIn(k, res)
        self.assertEqual(set(res["cache"]), {"key", "code", "params", "reused"})


if __name__ == "__main__":
    unittest.main(verbosity=2)