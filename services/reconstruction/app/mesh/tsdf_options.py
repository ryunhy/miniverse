"""TSDF 提取参数解析。

独立成模块的原因：pipeline.py 顶部会 import torch / gsplat 等重依赖，
把纯参数校验放在这里，单测无需 GPU 环境即可覆盖。
"""
from __future__ import annotations

VALID_EXTRACTIONS = ("occupancy", "sdf")
DEFAULT_EXTRACTION = "occupancy"   # 旧行为：占据场提取
DEFAULT_PERCENTILE = 0.5           # 旧行为：不做离群裁剪


def resolve_tsdf_options(extraction=None, bbox_percentile=None) -> tuple[str, float]:
    """把任务参数归一成 (extraction, bbox_percentile)。

    - 未传（None）→ 旧行为 occupancy + 0.5，历史任务与重试不受影响；
    - 非法值 → 抛 ValueError，不静默 fallback。
    """
    ext = DEFAULT_EXTRACTION if extraction is None else extraction
    if ext not in VALID_EXTRACTIONS:
        raise ValueError(
            f"meshExtraction 必须是 'occupancy' 或 'sdf'，收到 {extraction!r}"
        )

    if bbox_percentile is None:
        pct = DEFAULT_PERCENTILE
    else:
        try:
            pct = float(bbox_percentile)
        except (TypeError, ValueError):
            raise ValueError(
                f"meshBboxPercentile 必须是 0–0.5 的数值，收到 {bbox_percentile!r}"
            ) from None
        if not (0.0 <= pct <= 0.5):  # NaN 也会落到这里
            raise ValueError(
                f"meshBboxPercentile 必须在 0–0.5 之间，收到 {bbox_percentile!r}"
            )
    return ext, pct
