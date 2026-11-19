"""T-700011 多槽缓存「换参数切回」实测计时基准（合成场景，明确标注 synthetic）。

为什么是合成场景：本机没有真实重建场景数据，也没有 WSL/nerfstudio 环境，
卡片参考值 46.9s→2.7s 来自真实场景，无法在此复现。本脚本用程序生成的稠密合成房间
（地板+两面墙+家具团，约 2 万点，环形相机，平面色照片）驱动**真实**的四阶段算法
（structure/instances/geometry/texture 均为 app.miniature 里的正式函数，未打桩），
缓存与编排走的也是生产代码 pipeline.run_miniature。因此测得的「冷跑 vs 切回」秒数
是真实算法 + 真实缓存路径的实测值，只是输入场景为合成——按诚实原则标注 synthetic。

跑法（仓库根）：
  .venv/Scripts/python.exe docs/evidence/cache-slots/bench_switchback.py

输出：
  docs/evidence/cache-slots/switchback_timing.json  结构化实测结果
  docs/evidence/cache-slots/switchback_worker.log   三次运行的管线日志
"""
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.path.insert(0, str(REPO / "services" / "reconstruction"))

from app.miniature import pipeline as P  # noqa: E402

# 复用合成房间构造器（真实 COLMAP 二进制 + 照片）
_spec = importlib.util.spec_from_file_location("synthetic_room", HERE / "synthetic_room.py")
_probe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_probe)
write_scene = _probe.write_scene


def run_once(scene: Path, out: Path, tex: int, logs: list[str]) -> dict:
    t0 = time.time()
    res = P.run_miniature(
        scene, out, params={"miniatureTexSize": tex},
        log=lambda m: logs.append(m),
    )
    wall = round(time.time() - t0, 3)
    return {
        "tex_size": tex,
        "wall_seconds": wall,
        "reported_seconds": res["seconds"],
        "status": res["status"],
        "reused": res["cache"]["reused"],
        "cache_key": res["cache"]["key"],
        "stages": [
            {"name": s["name"], "status": s["status"], "seconds": s["seconds"], "cached": s.get("cached", False)}
            for s in res["stages"]
        ],
        "scene_glb_bytes": res["artifacts"].get("scene_glb_bytes"),
        "scene_glb_sha256": res["artifacts"].get("scene_glb_sha256"),
        "error": res.get("error"),
    }


def main() -> int:
    logs: list[str] = []
    with tempfile.TemporaryDirectory() as td:
        scene = Path(td) / "scene"
        n_points = write_scene(scene)
        out = Path(td) / "out"
        logs.append(f"合成场景：{n_points} 点，28 环形相机，640x480 平面色照片（synthetic）")

        a_cold = run_once(scene, out, 512, logs)
        b_cold = run_once(scene, out, 256, logs)
        a_warm = run_once(scene, out, 512, logs)

    four = ["structure", "instances", "geometry", "texture"]
    warm_hits_all_four = a_warm["reused"] == four
    # 切回是否显著快于冷跑（同参数 A）：缓存命中应省去四阶段重算
    speedup = (a_cold["wall_seconds"] / a_warm["wall_seconds"]) if a_warm["wall_seconds"] > 0 else None

    evidence = {
        "task": "T-700011",
        "synthetic": True,
        "synthetic_note": "本机无真实场景数据/无 WSL，参考值 46.9s→2.7s 不可复现；"
                          "输入为程序生成合成房间，四阶段算法与缓存编排均为生产代码（未打桩）。",
        "scene_points": n_points,
        "max_slots_per_stage": P.MAX_SLOTS_PER_STAGE,
        "slot_key_len": P.SLOT_KEY_LEN,
        "runs": {"A_cold_512": a_cold, "B_cold_256": b_cold, "A_warm_512": a_warm},
        "assertions": {
            "warm_A_reused_all_four_stages": warm_hits_all_four,
            "warm_A_reused": a_warm["reused"],
            "A_cold_wall_seconds": a_cold["wall_seconds"],
            "A_warm_wall_seconds": a_warm["wall_seconds"],
            "speedup_cold_over_warm": round(speedup, 2) if speedup else None,
            "warm_faster_than_cold": a_warm["wall_seconds"] < a_cold["wall_seconds"],
            "A_cold_and_warm_glb_identical": a_cold["scene_glb_sha256"] == a_warm["scene_glb_sha256"],
            "B_key_differs_from_A": b_cold["cache_key"] != a_cold["cache_key"],
        },
    }

    HERE.mkdir(parents=True, exist_ok=True)
    (HERE / "switchback_timing.json").write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    (HERE / "switchback_worker.log").write_text("\n".join(logs) + "\n", encoding="utf-8")

    print(json.dumps(evidence["assertions"], ensure_ascii=False, indent=2))
    print("A_cold stages:", [(s["name"], s["status"], s["seconds"]) for s in a_cold["stages"]])
    print("B_cold stages:", [(s["name"], s["status"], s["seconds"]) for s in b_cold["stages"]])
    print("A_warm stages:", [(s["name"], s["status"], s["seconds"], s["cached"]) for s in a_warm["stages"]])
    print("status A_cold/B_cold/A_warm:", a_cold["status"], b_cold["status"], a_warm["status"])
    ok = warm_hits_all_four and evidence["assertions"]["warm_faster_than_cold"]
    print("BENCH", "PASS" if ok else "CHECK")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())