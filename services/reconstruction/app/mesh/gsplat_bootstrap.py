"""gsplat CUDA 扩展引导。

本机 nerfstudio 1.1.5 安装的 gsplat 1.4.0 不会自动定位预编译扩展
（/root/torch_ext/gsplat_cuda/gsplat_cuda.so），必须显式注入 gsplat.csrc。
不注入时 `from gsplat.rendering import rasterization_2dgs` 会因找不到
csrc 而失败——这是本机实证（记忆 #6495 关联）。
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

DEFAULT_EXT = Path("/root/torch_ext/gsplat_cuda/gsplat_cuda.so")


def bootstrap(ext_path: Path | str = DEFAULT_EXT) -> bool:
    """注入预编译 gsplat 扩展。返回 True=已注入，False=无需注入（gsplat 自带）。

    幂等：重复调用直接返回当前状态。
    """
    import gsplat

    if getattr(gsplat, "csrc", None) is not None:
        return True

    p = Path(ext_path)
    if not p.exists():
        # 回退：gsplat 自带的 csrc 可能可用（pip 安装且编译过）
        try:
            import gsplat.csrc  # noqa: F401
            return True
        except Exception:  # noqa: BLE001
            raise RuntimeError(
                f"未找到 gsplat CUDA 扩展：{p} 不存在，且 gsplat.csrc 不可导入。"
                "请先编译 gsplat（参见 docs/INSTALL-Windows-WSL2.md），"
                "或设置环境变量 MINIVERSE_GSPLAT_EXT 指向 .so 路径。"
            )

    spec = importlib.util.spec_from_file_location("gsplat_cuda", str(p))
    ext = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ext)
    gsplat.csrc = ext
    sys.modules["gsplat.csrc"] = ext
    return True
