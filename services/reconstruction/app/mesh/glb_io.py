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
    """Read static triangles in the active scene using trimesh, without processing.

    Each part is one primitive instance; ranges are half-open in merged arrays.
    face_parts indexes parts; face_materials uses original glTF indices (-1 = none).
    UVs retain glTF's convention; absent UVs are NaN with has_uv=False. texture is
    RGB base color only; textures contains all decoded core PBR texture slots.
    Top-level material/texture fields are None for multiple material identities.
    Unsupported geometry/features fail explicitly, never return a partial mesh.
    """
    import copy
    import io

    import trimesh

    raw = Path(path).read_bytes()
    try:
        # Validate framing only; accessor/image decoding and world transforms are
        # delegated to the independent reader, not another glTF implementation.
        if len(raw) < 20:
            raise ValueError("GLB header is truncated")
        magic, version, length = struct.unpack_from("<III", raw)
        if magic != 0x46546C67 or version != 2 or length != len(raw):
            raise ValueError("Invalid GLB magic, version or total length")
        off, chunks = 12, []
        while off < length:
            if off + 8 > length:
                raise ValueError("Truncated GLB chunk header")
            size, kind = struct.unpack_from("<II", raw, off)
            off += 8
            if size % 4 or off + size > length:
                raise ValueError("Invalid GLB chunk length")
            chunks.append((kind, raw[off:off + size]))
            off += size
        if chunks[0][0] != 0x4E4F534A or sum(k == 0x4E4F534A for k, _ in chunks) != 1:
            raise ValueError("GLB must start with one JSON chunk")
        js = json.loads(chunks[0][1])
        json_bytes = len(json.dumps(js))
        if js["asset"]["version"] != "2.0":
            raise ValueError("Expected glTF 2.0 asset")
        if js.get("extensionsRequired"):
            raise NotImplementedError("Required glTF extensions are not supported by this reader")
        binary = [data for kind, data in chunks if kind == 0x004E4942]
        buffers = js.get("buffers", [])
        if len(binary) != 1 or len(buffers) != 1 or "uri" in buffers[0]:
            raise NotImplementedError("Expected a self-contained GLB with one embedded buffer")
        if any("uri" in image for image in js.get("images", [])):
            raise NotImplementedError("Only buffer-embedded images are supported")
        declared = buffers[0]["byteLength"]
        if type(declared) is not int or not 0 <= len(binary[0]) - declared <= 3:
            raise ValueError("Invalid embedded buffer length")
        for view in js.get("bufferViews", []):
            start, size = view.get("byteOffset", 0), view["byteLength"]
            if (view["buffer"] != 0 or type(start) is not int or type(size) is not int
                    or start < 0 or size < 0 or start + size > declared):
                raise ValueError("Invalid buffer view range")

        def ref(items, index):
            if type(index) is not int or not 0 <= index < len(items):
                raise ValueError(f"Invalid glTF reference: {index!r}")
            return items[index]

        for accessor in js.get("accessors", []):
            if "sparse" in accessor or accessor.get("extensions"):
                raise NotImplementedError("Sparse/extended accessors are unsupported")
            if "bufferView" in accessor:
                ref(js["bufferViews"], accessor["bufferView"])
        meshes, nodes = js.get("meshes", []), js.get("nodes", [])
        materials = js.get("materials", [])
        active = ref(js["scenes"], js.get("scene", 0))
        primitives = []
        for mesh_index, mesh in enumerate(meshes):
            if not mesh["primitives"]:
                raise ValueError("Mesh has no primitives")
            for primitive_index, p in enumerate(mesh["primitives"]):
                if p.get("mode", 4) not in (4, 5) or p.get("extensions") or p.get("targets"):
                    raise NotImplementedError("Only static triangle/triangle-strip primitives are supported")
                position = ref(js["accessors"], p["attributes"]["POSITION"])
                if position["type"] != "VEC3" or position["componentType"] != 5126:
                    raise ValueError("POSITION must be float VEC3")
                for index in p["attributes"].values():
                    ref(js["accessors"], index)
                if "indices" in p:
                    indices = ref(js["accessors"], p["indices"])
                    if indices["type"] != "SCALAR" or indices["componentType"] not in (5121, 5123, 5125):
                        raise ValueError("Indices must be unsigned integer SCALAR")
                if "material" in p:
                    ref(materials, p["material"])
                primitives.append((mesh_index, primitive_index, p))

        # trimesh tolerates cyclic/multiply-parented graphs and some bad refs.
        # Reject them before loading; do not reproduce its transform math here.
        parents = [0] * len(nodes)
        for node in nodes:
            if node.get("extensions") or "skin" in node or "weights" in node:
                raise NotImplementedError("Skinned/morphed/extended nodes are unsupported")
            if "mesh" in node:
                ref(meshes, node["mesh"])
            for child in node.get("children", []):
                ref(nodes, child)
                parents[child] += 1
                if parents[child] > 1:
                    raise ValueError("Node has multiple parents")
            if "matrix" in node and any(k in node for k in ("translation", "rotation", "scale")):
                raise ValueError("Node mixes matrix and TRS")
            for key, size in (("matrix", 16), ("translation", 3), ("rotation", 4), ("scale", 3)):
                if key in node:
                    values = np.asarray(node[key], dtype=float)
                    if values.shape != (size,) or not np.isfinite(values).all():
                        raise ValueError(f"Invalid node {key}")
                    if key == "rotation" and not np.isclose(np.linalg.norm(values), 1.0):
                        raise ValueError("Node rotation is not a unit quaternion")
        pending = [i for i, count in enumerate(parents) if count == 0]
        visited = 0
        while pending:
            node = nodes[pending.pop()]
            visited += 1
            pending.extend(node.get("children", []))
        if visited != len(nodes):
            raise ValueError("Cyclic node graph")
        pending, seen, expected_parts = list(active.get("nodes", [])), set(), 0
        for root in pending:
            ref(nodes, root)
            if parents[root]:
                raise ValueError("Scene root is also a child")
        while pending:
            index = pending.pop()
            node = ref(nodes, index)
            if index in seen:
                raise ValueError("Repeated scene node")
            seen.add(index)
            pending.extend(node.get("children", []))
            if "mesh" in node:
                expected_parts += len(meshes[node["mesh"]]["primitives"])

        # Preserve raw UVs even without a material: trimesh otherwise drops them,
        # and textured visual UVs are V-flipped. A custom attribute uses the same
        # independent accessor decoder, without changing buffers or topology.
        header = copy.deepcopy(js)
        uv_key = "_MINIVERSE_READ_UV"
        for mesh in header.get("meshes", []):
            for p in mesh["primitives"]:
                if uv_key in p["attributes"]:
                    raise ValueError("Reserved reader attribute already exists")
                if "TEXCOORD_0" in p["attributes"]:
                    p["attributes"][uv_key] = p["attributes"]["TEXCOORD_0"]
        for node in header.get("nodes", []):
            # A camera can coexist with a mesh or be its parent; this API returns
            # geometry only. Do not let trimesh's camera shortcut skip that node.
            node.pop("camera", None)
        text = json.dumps(header).encode("utf-8")
        text += b" " * (-len(text) % 4)
        body = struct.pack("<II", len(text), 0x4E4F534A) + text
        body += b"".join(struct.pack("<II", len(data), kind) + data for kind, data in chunks[1:])
        source = io.BytesIO(struct.pack("<III", magic, version, 12 + len(body)) + body)
        scene = trimesh.load_scene(source, file_type="glb", process=False,
                                   merge_primitives=False, ignore_broken=False)
        # With merge_primitives=False trimesh inserts geometry in mesh/primitive
        # order. Check cardinality so unsupported/skipped primitives cannot pass.
        if len(scene.geometry) != len(primitives):
            raise ValueError("Reader skipped or merged primitives")
        decoded = {}
        for (name, geometry), (mesh_index, primitive_index, p) in zip(scene.geometry.items(), primitives):
            if not isinstance(geometry, trimesh.Trimesh):
                raise ValueError("Expected triangular geometry")
            v, f = np.asarray(geometry.vertices), np.asarray(geometry.faces)
            if (v.ndim != 2 or v.shape[1] != 3 or not np.isfinite(v).all()
                    or f.ndim != 2 or f.shape[1] != 3 or not len(v) or not len(f)
                    or np.any(f < 0) or np.any(f >= len(v))):
                raise ValueError("Invalid vertices or face indices")
            has_uv = "TEXCOORD_0" in p["attributes"]
            uv = np.full((len(v), 2), np.nan)
            if has_uv:
                uv = np.array(geometry.vertex_attributes[uv_key], dtype=np.float64)
                accessor = js["accessors"][p["attributes"]["TEXCOORD_0"]]
                if accessor.get("normalized"):
                    component = accessor["componentType"]
                    if component not in (5121, 5123):
                        raise ValueError("Invalid normalized UV component")
                    uv /= 255 if component == 5121 else 65535
                if uv.shape != (len(v), 2) or not np.isfinite(uv).all():
                    raise ValueError("Invalid UV coordinates")
            material_index = p.get("material", -1)
            mat = materials[material_index] if material_index >= 0 else None
            textures = {}
            if mat is not None:
                if mat.get("extensions"):
                    raise NotImplementedError("Extended materials are unsupported")
                slots = dict(mat.get("pbrMetallicRoughness", {}))
                slots.update({k: mat[k] for k in ("normalTexture", "occlusionTexture", "emissiveTexture") if k in mat})
                loaded_mat = getattr(geometry.visual, "material", None)
                for slot, info in slots.items():
                    if not slot.endswith("Texture"):
                        continue
                    if info.get("texCoord", 0) != 0 or info.get("extensions"):
                        raise NotImplementedError("Only untransformed TEXCOORD_0 textures are supported")
                    texture_info = ref(js["textures"], info["index"])
                    if texture_info.get("extensions"):
                        raise NotImplementedError("Extended textures are unsupported")
                    image_info = ref(js["images"], texture_info["source"])
                    ref(js["bufferViews"], image_info["bufferView"])
                    image = getattr(loaded_mat, slot, None)
                    if not has_uv or image is None:
                        raise ValueError(f"Missing UV or undecodable {slot}")
                    image.load()  # force lazy image errors before returning
                    textures[slot] = np.array(image.convert("RGB"))
            decoded[name] = {"mesh_index": mesh_index, "primitive_index": primitive_index,
                             "material_index": material_index, "material": mat, "textures": textures,
                             "texture": textures.get("baseColorTexture"), "has_uv": has_uv, "uv": uv}

        vertices, faces, uvs, parts, face_parts, face_materials = [], [], [], [], [], []
        vertex_offset = face_offset = 0
        for node_name in scene.graph.nodes_geometry:
            transform, geometry_name = scene.graph[node_name]
            if not np.isfinite(transform).all() or not np.allclose(transform[3], [0, 0, 0, 1]):
                raise ValueError("Invalid world transform")
            geometry = scene.geometry[geometry_name]
            v = trimesh.transform_points(geometry.vertices, transform)
            if not np.isfinite(v).all():
                raise ValueError("Non-finite transformed vertices")
            f = np.array(geometry.faces, dtype=np.int64)
            if np.linalg.det(transform[:3, :3]) < 0:
                f = f[:, ::-1]  # reflections reverse orientation; UV stays vertex-bound
            item = decoded[geometry_name]
            part = {k: value for k, value in item.items() if k != "uv"}
            part.update(node=node_name, transform=transform.copy(),
                        vertex_range=(vertex_offset, vertex_offset + len(v)),
                        face_range=(face_offset, face_offset + len(f)))
            vertices.append(v)
            faces.append(f + vertex_offset)
            uvs.append(item["uv"])
            face_parts.append(np.full(len(f), len(parts), dtype=np.int64))
            face_materials.append(np.full(len(f), item["material_index"], dtype=np.int64))
            parts.append(part)
            vertex_offset += len(v)
            face_offset += len(f)
        if len(parts) != expected_parts:
            raise ValueError("Reader omitted active-scene geometry instances")
        single = parts[0] if parts and len({p["material_index"] for p in parts}) == 1 else None
        mat = single["material"] if single else None
        return {
            "vertices": np.concatenate(vertices) if vertices else np.empty((0, 3)),
            "faces": np.concatenate(faces) if faces else np.empty((0, 3), dtype=np.int64),
            "uv": np.concatenate(uvs) if uvs else np.empty((0, 2)),
            "texture": single["texture"] if single else None, "material": mat,
            "baseColorFactor": (mat or {}).get("pbrMetallicRoughness", {}).get("baseColorFactor", [1, 1, 1, 1]) if single else None,
            "doubleSided": bool((mat or {}).get("doubleSided", False)) if single else None,
            "json_bytes": json_bytes, "parts": parts, "materials": materials,
            "face_parts": np.concatenate(face_parts) if face_parts else np.empty(0, dtype=np.int64),
            "face_materials": np.concatenate(face_materials) if face_materials else np.empty(0, dtype=np.int64),
        }
    except (KeyError, IndexError, TypeError, AssertionError, struct.error, UnicodeError) as exc:
        raise ValueError(f"Invalid GLB: {exc}") from exc


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
