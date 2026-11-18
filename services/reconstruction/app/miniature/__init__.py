"""MiniVerse 可复用微缩管线所需的最小包入口。

各子模块职责：
- contracts : 契约、诊断码、阈值单一出处、manifest 哈希
- sfm_io    : COLMAP 二进制只读解析
- ingest    : 任意照片目录 → 版本化 InputManifest（覆盖度/注册率诊断）
- pipeline  : 编排入口（ingest → structure → geometry → texture → GLB）
"""
from . import contracts  # noqa: F401
from .ingest import scan_scene, world_up_from_cameras  # noqa: F401

__all__ = ["contracts", "scan_scene", "world_up_from_cameras"]
