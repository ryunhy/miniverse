"""INRIA 3DGS PLY 读取（numpy，零新依赖）。"""
from __future__ import annotations

from pathlib import Path

import numpy as np


def read_inria_ply(path: Path) -> dict:
    props: list[str] = []
    count = 0
    with Path(path).open("rb") as fh:
        while True:
            line = fh.readline().decode("utf-8", "replace").strip()
            if line.startswith("element vertex"):
                count = int(line.split()[-1])
            elif line.startswith("property"):
                props.append(line.split()[-1])
            elif line == "end_header":
                break
        data = np.frombuffer(fh.read(count * len(props) * 4), dtype=np.float32).reshape(count, len(props))
    idx = {p: i for i, p in enumerate(props)}
    out = {"count": count, "properties": props}
    for name in ("x", "y", "z", "opacity", "scale_0", "scale_1", "scale_2",
                 "rot_0", "rot_1", "rot_2", "rot_3"):
        if name in idx:
            out[name] = data[:, idx[name]].astype(np.float32)
    out["means"] = np.stack([out.pop("x"), out.pop("y"), out.pop("z")], 1)
    out["scales"] = np.stack([out.pop("scale_0"), out.pop("scale_1"), out.pop("scale_2")], 1)
    out["quats"] = np.stack([out.pop("rot_0"), out.pop("rot_1"), out.pop("rot_2"), out.pop("rot_3")], 1)
    n_rest = sum(1 for p in props if p.startswith("f_rest_"))
    out["sh_degree"] = int(round((n_rest / 3) ** 0.5 - 1)) if n_rest else 0
    dc = np.stack([data[:, idx[f"f_dc_{c}"]] for c in range(3)], 1)
    rest = np.zeros((count, (out["sh_degree"] + 1) ** 2 - 1, 3), np.float32)
    for k in range(1, rest.shape[1] + 1):
        for c in range(3):
            rest[:, k - 1, c] = data[:, idx[f"f_rest_{c * rest.shape[1] + k - 1}"]]
    out["sh_dc"] = dc
    out["sh_rest"] = rest
    return out
