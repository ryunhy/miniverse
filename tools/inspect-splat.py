"""检查 3DGS PLY 的高斯质量分布（为 floater 过滤定阈值）。

用法：python tools/inspect-splat.py data/reconstructions/<id>/scene.ply
"""
from __future__ import annotations

import struct
import sys
from pathlib import Path

import numpy as np


def read_header(path: Path) -> tuple[list[str], int, int]:
    """返回 (属性名列表, 顶点数, 数据起始偏移)。"""
    props: list[str] = []
    count = 0
    offset = 0
    with path.open("rb") as f:
        while True:
            raw = f.readline()
            offset += len(raw)
            line = raw.decode("ascii", "replace").strip()
            if line.startswith("element vertex"):
                count = int(line.split()[-1])
            elif line.startswith("property"):
                props.append(line.split()[-1])
            elif line == "end_header":
                break
    return props, count, offset


def main() -> int:
    path = Path(sys.argv[1])
    props, n, offset = read_header(path)
    k = len(props)
    data = np.fromfile(path, dtype=np.float32, offset=offset, count=n * k).reshape(n, k)

    idx = {p: i for i, p in enumerate(props)}
    xyz = data[:, [idx["x"], idx["y"], idx["z"]]].astype(np.float64)
    op_raw = data[:, idx["opacity"]].astype(np.float64)
    sc = np.exp(data[:, [idx["scale_0"], idx["scale_1"], idx["scale_2"]]].astype(np.float64))
    op = 1.0 / (1.0 + np.exp(-op_raw))

    center = np.median(xyz, axis=0)
    dist = np.linalg.norm(xyz - center, axis=1)
    bbox = xyz.max(axis=0) - xyz.min(axis=0)
    diag = float(np.linalg.norm(bbox))

    def pct(v, ps=(1, 5, 10, 25, 50, 75, 90, 95, 99)):
        return {p: round(float(np.percentile(v, p)), 5) for p in ps}

    print(f"vertices={n} props={k} bytes={path.stat().st_size}")
    print("bbox", np.round(bbox, 4).tolist(), "diag", round(diag, 4))
    print("center(median)", np.round(center, 4).tolist())
    print("opacity", pct(op))
    print("opacity<0.02", int((op < 0.02).sum()), " <0.05", int((op < 0.05).sum()),
          " <0.1", int((op < 0.1).sum()), " <0.3", int((op < 0.3).sum()))
    print("scaleMax", pct(sc.max(axis=1)))
    print("scaleMax>diag*0.02", int((sc.max(axis=1) > diag * 0.02).sum()),
          " >diag*0.05", int((sc.max(axis=1) > diag * 0.05).sum()),
          " >diag*0.1", int((sc.max(axis=1) > diag * 0.1).sum()))
    print("dist", pct(dist))
    md = float(np.median(dist))
    print("medianDist", round(md, 4),
          " >2x", int((dist > md * 2).sum()),
          " >3x", int((dist > md * 3).sum()),
          " >5x", int((dist > md * 5).sum()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
