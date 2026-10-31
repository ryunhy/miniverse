"""3DGS PLY floater 过滤：真正从数据里删掉空腔与离群碎片。

判据（可调）：
  1) 距离：到场景中心（位置中位数）的距离 > median * dist-mult（默认 4）→ 离群
  2) 不透明度：sigmoid(opacity) < opacity-min（默认 0.05）→ 低置信
  3) 尺度：exp(scale) 任一分量 > diag * scale-max-ratio（默认 0.08）→ 超大糊屏

输出同格式 PLY（保留全部属性）+ 统计 JSON。
原文件不覆盖，默认写 <input>.clean.ply。

用法：
  python tools/filter-splat.py data/reconstructions/<id>/scene.ply --out data/reconstructions/<id>/scene.clean.ply
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np


def read_ply(path: Path):
    props: list[str] = []
    count = 0
    offset = 0
    header_lines: list[str] = []
    with path.open("rb") as f:
        while True:
            raw = f.readline()
            offset += len(raw)
            line = raw.decode("ascii", "replace").rstrip("\n")
            header_lines.append(line)
            if line.startswith("element vertex"):
                count = int(line.split()[-1])
            elif line.startswith("property"):
                props.append(line.split()[-1])
            elif line.strip() == "end_header":
                break
    data = np.fromfile(path, dtype=np.float32, offset=offset, count=count * len(props))
    return header_lines, props, count, data.reshape(count, len(props))


def write_ply(path: Path, header_lines: list[str], props: list[str], data: np.ndarray) -> None:
    out_header = []
    for line in header_lines:
        if line.startswith("element vertex"):
            out_header.append(f"element vertex {len(data)}")
        else:
            out_header.append(line)
    text = ("\n".join(out_header) + "\n").encode("ascii")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as f:
        f.write(text)
        f.write(np.ascontiguousarray(data, dtype=np.float32).tobytes())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src", type=Path)
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--dist-mult", type=float, default=4.0)
    ap.add_argument("--opacity-min", type=float, default=0.05)
    ap.add_argument("--scale-max-ratio", type=float, default=0.08)
    ap.add_argument("--report", type=Path, default=None)
    args = ap.parse_args()

    header, props, n, data = read_ply(args.src)
    idx = {p: i for i, p in enumerate(props)}
    xyz = data[:, [idx["x"], idx["y"], idx["z"]]].astype(np.float64)
    op = 1.0 / (1.0 + np.exp(-data[:, idx["opacity"]].astype(np.float64)))
    sc = np.exp(data[:, [idx["scale_0"], idx["scale_1"], idx["scale_2"]]].astype(np.float64))

    center = np.median(xyz, axis=0)
    dist = np.linalg.norm(xyz - center, axis=1)
    md = float(np.median(dist))
    diag = float(np.linalg.norm(xyz.max(axis=0) - xyz.min(axis=0)))

    far = dist > md * args.dist_mult
    faint = op < args.opacity_min
    huge = sc.max(axis=1) > diag * args.scale_max_ratio
    drop = far | faint | huge
    keep = ~drop
    kept = data[keep]

    out = args.out or args.src.with_suffix(".clean.ply")
    write_ply(out, header, props, kept)

    report = {
        "src": str(args.src), "out": str(out),
        "params": {"distMult": args.dist_mult, "opacityMin": args.opacity_min,
                   "scaleMaxRatio": args.scale_max_ratio},
        "verticesBefore": int(n), "verticesAfter": int(keep.sum()),
        "dropped": int(drop.sum()), "droppedPct": round(float(drop.mean() * 100), 3),
        "droppedBy": {"far": int(far.sum()), "faint": int(faint.sum()), "huge": int(huge.sum())},
        "stats": {"medianDist": round(md, 4), "distCut": round(md * args.dist_mult, 4),
                  "diag": round(diag, 4), "center": [round(float(v), 4) for v in center]},
        "bytesBefore": args.src.stat().st_size, "bytesAfter": out.stat().st_size,
    }
    rp = args.report or (args.src.parent / "filter-report.json")
    rp.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: report[k] for k in ("verticesBefore", "verticesAfter", "dropped",
                                             "droppedPct", "droppedBy", "stats")}, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
