"""可复用微缩管线的输入/产物契约（v1）。

设计约束
- 只用标准库，任何环境可直接 import，便于并行卡做 fixture。
- 一切"数值"必须带来源字段（measured / inferred / manual / unmetric），不允许裸数字。
- 诊断可机读：不支持的输入返回 status=unsupported + 诊断码，绝不返回假成功。
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Iterable

SCHEMA_INPUT = "miniature.input.v1"
SCHEMA_STRUCTURE = "miniature.structure.v1"
SCHEMA_GEOMETRY = "miniature.geometry.v1"
SCHEMA_TEXTURE = "miniature.texture.v1"
SCHEMA_REPORT = "miniature.report.v1"

# 诊断码：全部可在测试里断言，不允许自由文本替代
D_OK = "OK"
D_NO_IMAGES = "NO_IMAGES"
D_NO_SFM_BASELINE = "NO_SFM_BASELINE"
D_LOW_REGISTRATION = "LOW_REGISTRATION"
D_LOW_AZIMUTH_COVERAGE = "LOW_AZIMUTH_COVERAGE"
D_LOW_LOOKDIR_COVERAGE = "LOW_LOOKDIR_COVERAGE"
D_CORRUPT_IMAGE = "CORRUPT_IMAGE"
D_DUPLICATE_SCENE = "DUPLICATE_SCENE"
D_UNMETRIC_SCALE = "UNMETRIC_SCALE"
D_UNSUPPORTED_ROOM = "UNSUPPORTED_ROOM"
D_NO_DEPTH_FOR_BAKE = "NO_DEPTH_FOR_BAKE"
D_DISTORTION_NOT_UNDISTORTED = "DISTORTION_NOT_UNDISTORTED"
D_SCALE_INCONSISTENT = "SCALE_INCONSISTENT"

# 阈值为下限判据，来源与理由见 docs/miniature/THRESHOLDS.md
# 注意：min_azimuth_bins 只用于报告视差充分性，**不是**准入硬门。
# 实测 c858acee 站位方位仅 180°、朝向却达 300°（手持原地转身拍摄），
# 验收要求是"两面墙被看到"，对应 lookdir 覆盖；站位环绕只影响视差与遮挡补全质量。
THRESHOLDS = {
    "min_registered_ratio": 0.60,
    "min_lookdir_bins": 6,          # /12 桶 = 180°，低于此判无法覆盖两面墙（error）
    "report_azimuth_bins": 6,       # /12 桶 = 180°，低于此仅提示视差不足（info）
    "min_floor_inlier_ratio": 0.15,
    # 判墙用"最外显著密度峰 + 绝对延展"，不用"占 above 点云的比例"：
    # 后者随房间大小与家具密度漂移（实测 c858acee 的强墙 325 点仅占 3.5%，
    # room 的强墙 2147 点仅占 3.1%，而 f1014582 一个家具面就占 11.9%）。
    # 墙的物理定义是"房间最外缘的面状结构"，故按外侧位置 + 延展度判定。
    "min_wall_points": 200,
    "min_wall_extent_ratio": 0.18,  # 墙面延展 / 另一水平轴房间跨度；替代旧的固定 min_wall_extent_nu=1.0
    "max_wall_outside_ratio": 0.25,  # 仅作诊断报告：外侧点密度 / 内侧点密度（房间外常有走廊，不作硬门）
    "min_surface_visibility": 0.35,  # 目标墙面/地板被至少一个视角看到的面积占比
    "min_images": 20,
}


def canonical_json(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def write_json(path: Path, obj: Any) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=False)
    path.write_text(text, encoding="utf-8")
    return sha256_text(text)


@dataclass
class Diagnostic:
    code: str
    severity: str  # info | warn | error
    message: str
    measured: dict = field(default_factory=dict)
    threshold: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class ImageRecord:
    name: str
    rel_path: str
    bytes: int
    sha256: str | None = None
    width: int | None = None
    height: int | None = None

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class Coverage:
    n_registered: int = 0
    azimuth_bins: list = field(default_factory=list)
    lookdir_bins: list = field(default_factory=list)
    azimuth_coverage_deg: float = 0.0
    lookdir_coverage_deg: float = 0.0
    position_span: list = field(default_factory=list)
    up_world: list = field(default_factory=list)
    up_source: str = "unknown"

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class InputManifest:
    scene_key: str
    scene_path: str
    scene_id: str | None = None
    images: list = field(default_factory=list)
    coverage: Coverage = field(default_factory=Coverage)
    colmap: dict = field(default_factory=dict)
    scale: dict = field(default_factory=dict)
    diagnostics: list = field(default_factory=list)
    status: str = "ok"  # ok | degraded | unsupported
    # 演示/程序生成/合成数据必须显式置 True；fixture 永远为 True，禁止冒充真实重建
    synthetic: bool = False
    schema: str = SCHEMA_INPUT
    manifest_id: str = ""

    def finalize(self) -> "InputManifest":
        body = self.as_dict()
        body.pop("manifest_id", None)
        self.manifest_id = sha256_text(canonical_json(body))
        return self

    def as_dict(self) -> dict:
        d = {
            "schema": self.schema,
            "manifest_id": self.manifest_id,
            "scene_key": self.scene_key,
            "scene_id": self.scene_id,
            "scene_path": self.scene_path,
            "status": self.status,
            "synthetic": self.synthetic,
            "images": [i.as_dict() if hasattr(i, "as_dict") else i for i in self.images],
            "coverage": self.coverage.as_dict(),
            "colmap": self.colmap,
            "scale": self.scale,
            "diagnostics": [d.as_dict() if hasattr(d, "as_dict") else d for d in self.diagnostics],
        }
        return d


def decide_status(diagnostics: Iterable[Diagnostic]) -> str:
    sev = {d.severity for d in diagnostics}
    if "error" in sev:
        return "unsupported"
    if "warn" in sev:
        return "degraded"
    return "ok"


def validate_manifest(m: dict) -> list:
    """返回契约违规列表；空列表即通过。供并行卡在 fixture 上做契约测试。"""
    errs = []
    if m.get("schema") != SCHEMA_INPUT:
        errs.append(f"schema mismatch: {m.get('schema')}")
    for key in ("scene_key", "scene_path", "status", "coverage", "manifest_id"):
        if key not in m:
            errs.append(f"missing key: {key}")
    if m.get("status") not in ("ok", "degraded", "unsupported"):
        errs.append(f"bad status: {m.get('status')}")
    body = dict(m)
    body.pop("manifest_id", None)
    if m.get("manifest_id") and sha256_text(canonical_json(body)) != m["manifest_id"]:
        errs.append("manifest_id does not match content hash")
    if m.get("status") == "ok" and any(d.get("severity") == "error" for d in m.get("diagnostics", [])):
        errs.append("status=ok but has error diagnostics")
    if m.get("status") == "unsupported" and not m.get("diagnostics"):
        errs.append("unsupported without diagnostics")
    return errs
