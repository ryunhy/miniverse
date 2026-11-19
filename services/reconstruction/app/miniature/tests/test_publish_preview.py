"""合成 GLB：验证发布顺序、版本匹配及失败回滚。"""

import hashlib
import json
import struct
from pathlib import Path
from types import SimpleNamespace

from app.worker import _publish_miniature_preview


def _glb(name: str) -> bytes:
    document = json.dumps({"asset": {"version": "2.0"}, "nodes": [{"name": name}]}).encode()
    document += b" " * (-len(document) % 4)
    return struct.pack("<IIIII", 0x46546C67, 2, 20 + len(document), len(document), 0x4E4F534A) + document


def test_publish_preserves_previous_asset_when_model_validation_fails(tmp_path):
    ctx = SimpleNamespace(task_id="synthetic", export_dir=tmp_path)
    src = tmp_path / "unpublished.glb"
    src.write_bytes(_glb("furniture-1"))
    instances = tmp_path / "miniature" / "instances.json"
    instances.parent.mkdir()
    instances.write_text(json.dumps({"instances": [{"id": "furniture-1"}, {"id": "missing"}]}))
    payload = {"glb": {"path": str(src)}, "synthetic": True}

    first = _publish_miniature_preview(ctx, payload)
    assert first["state"] == "ok"
    manifest_path = tmp_path / "scene.json"
    previous_manifest = manifest_path.read_bytes()
    manifest = json.loads(previous_manifest)
    asset_path = tmp_path / manifest["assets"]["scene"]["path"]
    assert asset_path.read_bytes() == src.read_bytes()
    assert manifest["assets"]["scene"]["sha256"] == hashlib.sha256(src.read_bytes()).hexdigest()
    assert manifest["synthetic"] is True
    assert manifest["objects"] == [{"objectId": "furniture-1", "nodeName": "furniture-1"}]

    src.write_bytes(b"invalid replacement")
    assert _publish_miniature_preview(ctx, payload)["state"] == "failed"
    assert manifest_path.read_bytes() == previous_manifest
    assert asset_path.read_bytes() == _glb("furniture-1")


def test_publish_preserves_previous_asset_when_manifest_replace_fails(tmp_path, monkeypatch):
    ctx = SimpleNamespace(task_id="synthetic", export_dir=tmp_path)
    src = tmp_path / "unpublished.glb"
    src.write_bytes(_glb("first"))
    payload = {"glb": {"path": str(src)}, "synthetic": True}
    assert _publish_miniature_preview(ctx, payload)["state"] == "ok"
    manifest_path = tmp_path / "scene.json"
    previous_manifest = manifest_path.read_bytes()
    previous_asset = tmp_path / json.loads(previous_manifest)["assets"]["scene"]["path"]

    replace = Path.replace

    def fail_manifest(self, target):
        if target == manifest_path:
            raise OSError("simulated manifest write failure")
        return replace(self, target)

    monkeypatch.setattr(Path, "replace", fail_manifest)
    src.write_bytes(_glb("second"))
    assert _publish_miniature_preview(ctx, payload)["state"] == "failed"
    assert manifest_path.read_bytes() == previous_manifest
    assert previous_asset.read_bytes() == _glb("first")
    assert not list(tmp_path.glob("*.tmp"))
