"""T-700007 证据生成：合成复现 f1014582 的分裂场景（60/104 → 102/104）。

明确声明：本脚本产出全部为程序生成合成数据（synthetic），不是真实 f1014582 重建。
真实任务的两个对照数字（2026-11-12 实测）见 docs/miniature/THRESHOLDS.md 与
docs/miniature/DATA-PROVENANCE.md；本机无 COLMAP 且无该任务原始数据，无法复测。

跑法（仓库根）：
  .venv/Scripts/python.exe docs/evidence/sfm-merge/make-evidence.py
输出：docs/evidence/sfm-merge/synthetic-split-report.json（exit 0；断言失败 exit 1）
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "services" / "reconstruction"))

import numpy as np  # noqa: E402

from app.miniature import contracts as C  # noqa: E402
from app.miniature import sfm_io as S  # noqa: E402
from app.miniature.tests.test_sfm_merge import _make_model, _pose, _transformed  # noqa: E402

OUT = Path(__file__).resolve().parent


def main() -> int:
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
        merged_dir = root / "merged"
        rep = S.merge_sparse_models([a, b], merged_dir)
        r_merged = S.registration_ratio(merged_dir, processed)

        m_single = C.InputManifest(
            "f1014582-synthetic", str(processed.parent),
            coverage=C.Coverage(n_registered=r_single["registered"]), synthetic=True,
        ).finalize()
        m_merged = C.InputManifest(
            "f1014582-synthetic", str(processed.parent),
            coverage=C.Coverage(n_registered=r_merged["registered"]), synthetic=True,
        ).finalize()

        assert (r_single["registered"], r_single["total"]) == (60, 104), r_single
        assert (r_merged["registered"], r_merged["total"]) == (102, 104), r_merged
        assert rep["status"] == S.MERGE_OK
        assert m_single.manifest_id != m_merged.manifest_id
        assert C.validate_manifest(m_single.as_dict()) == []
        assert C.validate_manifest(m_merged.as_dict()) == []

        report = {
            "synthetic": True,
            "note": "程序生成合成场景，复现 f1014582 历史分裂比例；非真实重建数据。"
                    "真实对照数字（2026-11-12 实测）见 docs/miniature/THRESHOLDS.md 与 DATA-PROVENANCE.md。",
            "scenario": {"photos_on_disk": n, "model_0_registered": 60,
                         "model_1_registered": 45, "shared_images": 3},
            "registration_single_sparse0": r_single,
            "registration_merged": r_merged,
            "low_registration_warn_would_fire_on_single": r_single["ratio"] < C.THRESHOLDS["min_registered_ratio"],
            "merge_report": rep,
            "manifest_id_single": m_single.manifest_id,
            "manifest_id_merged": m_merged.manifest_id,
            "manifest_id_changed_by_merge": m_single.manifest_id != m_merged.manifest_id,
            "denominator_rule": "processed/<id>/images 图片文件数（IMAGE_EXTS 口径，与 ingest 一致），不得用 uploads",
        }
        (OUT / "synthetic-split-report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(json.dumps({k: report[k] for k in (
            "registration_single_sparse0", "registration_merged",
            "manifest_id_changed_by_merge", "low_registration_warn_would_fire_on_single")},
            ensure_ascii=False, indent=2))
        return 0


if __name__ == "__main__":
    sys.exit(main())