"""GLB 读取（独立于导出库的实现，用于「重新加载」验收，避免自证式通过）。"""
from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np

COMPONENT = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2),
             5125: ("I", 4), 5126: ("f", 4)}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def read_glb(path: Path) -> dict:
    raw = Path(path).read_bytes()
    magic, version, length = struct.unpack_from("<III", raw, 0)
    if magic != 0x46546C67:
        raise SystemExit("不是合法 GLB（magic 不符）")
    off = 12
    js, bin_chunk = None, None
    while off < len(raw):
        clen, ctype = struct.unpack_from("<II", raw, off)
        off += 8
        data = raw[off: off + clen]
        off += clen
        if ctype == 0x4E4F534A:
            js = json.loads(data.decode("utf-8").rstrip("\x00 "))
        elif ctype == 0x004E4942:
            bin_chunk = data
    if js is None or bin_chunk is None:
        raise SystemExit("GLB 缺少 JSON 或 BIN chunk")

    def accessor(idx: int) -> np.ndarray:
        a = js["accessors"][idx]
        bv = js["bufferViews"][a["bufferView"]]
        fmt, size = COMPONENT[a["componentType"]]
        n = NCOMP[a["type"]]
        start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        count = a["count"]
        arr = np.frombuffer(bin_chunk, dtype=np.dtype(fmt), count=count * n, offset=start)
        return arr.reshape(count, n) if n > 1 else arr

    prim = js["meshes"][0]["primitives"][0]
    verts = accessor(prim["attributes"]["POSITION"]).astype(np.float64)
    uv = accessor(prim["attributes"]["TEXCOORD_0"]).astype(np.float64)
    faces = accessor(prim["indices"]).astype(np.int64)
    if faces.ndim == 1:
        faces = faces.reshape(-1, 3)

    texture = None
    mat = js["materials"][prim["material"]]
    tex_idx = mat["pbrMetallicRoughness"]["baseColorTexture"]["index"]
    img_idx = js["textures"][tex_idx]["source"]
    img_bv = js["bufferViews"][js["images"][img_idx]["bufferView"]]
    img_bytes = bin_chunk[img_bv.get("byteOffset", 0): img_bv.get("byteOffset", 0) + img_bv["byteLength"]]
    import cv2
    texture = cv2.imdecode(np.frombuffer(img_bytes, np.uint8), cv2.IMREAD_COLOR)
    texture = cv2.cvtColor(texture, cv2.COLOR_BGR2RGB)

    return {
        "vertices": verts, "faces": faces, "uv": uv, "texture": texture,
        "material": mat,
        "baseColorFactor": mat["pbrMetallicRoughness"].get("baseColorFactor", [1, 1, 1, 1]),
        "doubleSided": bool(mat.get("doubleSided", False)),
        "json_bytes": len(json.dumps(js)),
    }


def write_glb(path: Path, verts: np.ndarray, faces: np.ndarray, uv: np.ndarray,
              texture_png: bytes, name: str = "miniverse-mesh") -> dict:
    """写一个自包含 GLB（POSITION/TEXCOORD_0/indices + PNG 贴图，baseColorFactor=1）。"""
    verts = np.ascontiguousarray(verts.astype(np.float32))
    uv = np.ascontiguousarray(uv.astype(np.float32))
    idx = np.ascontiguousarray(faces.astype(np.uint32).ravel())

    blob = bytearray()
    views = []

    def add(data: bytes) -> int:
        while len(blob) % 4:
            blob.append(0)
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)})
        blob.extend(data)
        return len(views) - 1

    v_pos = add(verts.tobytes())
    v_uv = add(uv.tobytes())
    v_idx = add(idx.tobytes())
    v_img = add(texture_png)

    js = {
        "asset": {"version": "2.0", "generator": "MiniVerse-M1 services/mesh"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": name}],
        "meshes": [{"name": name, "primitives": [{
            "attributes": {"POSITION": 0, "TEXCOORD_0": 1},
            "indices": 2, "mode": 4, "material": 0,
        }]}],
        "accessors": [
            {"bufferView": v_pos, "componentType": 5126, "count": int(len(verts)), "type": "VEC3",
             "min": verts.min(0).tolist(), "max": verts.max(0).tolist()},
            {"bufferView": v_uv, "componentType": 5126, "count": int(len(uv)), "type": "VEC2",
             "min": uv.min(0).tolist(), "max": uv.max(0).tolist()},
            {"bufferView": v_idx, "componentType": 5125, "count": int(len(idx)), "type": "SCALAR"},
        ],
        "bufferViews": views,
        "images": [{"bufferView": v_img, "mimeType": "image/png"}],
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}],
        "textures": [{"sampler": 0, "source": 0}],
        "materials": [{
            "name": "baked",
            "doubleSided": True,
            "pbrMetallicRoughness": {
                "baseColorTexture": {"index": 0},
                "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
                "metallicFactor": 0.0,
                "roughnessFactor": 1.0,
            },
        }],
        "buffers": [{"byteLength": len(blob)}],
    }
    js_bytes = json.dumps(js, separators=(",", ":")).encode("utf-8")
    while len(js_bytes) % 4:
        js_bytes += b" "
    while len(blob) % 4:
        blob.append(0)
    total = 12 + 8 + len(js_bytes) + 8 + len(blob)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with Path(path).open("wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, total))
        fh.write(struct.pack("<II", len(js_bytes), 0x4E4F534A))
        fh.write(js_bytes)
        fh.write(struct.pack("<II", len(blob), 0x004E4942))
        fh.write(bytes(blob))
    return {"vertices": int(len(verts)), "faces": int(len(faces)), "bytes": total}
