"""3DGS → 3D 网格（mesh）转换服务。

为什么存在：Splatfacto 的 3D 高斯是视角相关的体积表示，从它直接提网格只能得到
漂浮薄壳（实测见 docs/MESH.md）。正确做法是用 2DGS（面向法线的薄盘高斯）训练
一份几何一致的高斯，再用 TSDF 融合出封闭表面，最后 UV 展开 + 多视角烘焙纹理。

链路：
    nerfstudio config.yml
      → train_2dgs    （2DGS 训练，输出 ckpt + splat-2dgs.ply）
      → render_depth  （每相机渲染 RGB/alpha/期望深度/法向）
      → depth_calib   （用 COLMAP 稀疏点核对深度尺度）
      → tsdf_mesh     （TSDF 融合 → 三角网格）
      → texture_bake  （UV 展开 + 纹理烘焙 → GLB）
"""

from .pipeline import export_mesh, MeshResult  # noqa: F401

__all__ = ["export_mesh", "MeshResult"]
