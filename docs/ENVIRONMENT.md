# 环境诊断报告（2026-10-24 通宵开发会话实测）

## 结论速览

| 项目 | 状态 | 详情 |
|---|---|---|
| OS | ✅ | Windows 10.0.26200（内部版本 26200.9457） |
| GPU | ✅ | NVIDIA GeForce RTX 4070 Laptop GPU，8188 MiB，驱动 617.42 |
| nvidia-smi | ✅ | 可用（worker 据此自动选训练参数） |
| WSL2 | ⚠️ | 已启用（wsl 2），但只有 docker-desktop 发行版，**无 Ubuntu** |
| Python | ✅ | Windows: 3.10.6 / 3.15.0（py 启动器可用） |
| CUDA Toolkit / nvcc | ❌ | 未安装 |
| PyTorch | ❌ | 已装但 import 链损坏：`AttributeError: module 'colorama' has no attribute 'init'`（tqdm/colorama 版本冲突） |
| COLMAP | ❌ | 不在 PATH |
| Nerfstudio / ns-train | ❌ | 不在 PATH |
| Node.js | ✅ | v24.18.1（`node:sqlite` 内置模块实测可用 → 任务库零原生依赖） |
| npm / git | ✅ | 11.16.0 / 2.55.0 |
| 内存 | ✅ | 31.8 GB |
| 磁盘 | ✅ | C: 剩余 307 GB |
| 内置浏览器 WebGL2 | ✅ | RTX 4070 真实 GPU 加速，EXT_color_buffer_float / OES_texture_float_linear 全支持 |

## 对开发决策的影响

1. **任务持久化选 `node:sqlite`**（DatabaseSync）——零原生编译依赖，WAL 模式，实测 28 个单测覆盖状态机。
2. **重建流水线"完整实现 + 诚实降级"**：COLMAP/Splatfacto 全流程代码就绪，本机缺依赖时任务如实置 `failed` 并附原因与安装指引，**不伪造成功**。`services/reconstruction/scripts/check_env.py` / `python -m app.main check-env` 可随时复查（当前输出 ❌ 缺 COLMAP/Nerfstudio/CUDA，附推荐参数 max_resolution=1200 / steps=7000）。
3. **云算力兜底**：`services/reconstruction/Dockerfile`（nvidia/cuda 12.1 基镜像 + COLMAP + Nerfstudio）可直接部署到任何按小时计费 GPU 主机，`worker-loop` 与 Web 端文件协议不变。

## 浏览器自动化环境特有现象（记录备查）

- 内置浏览器（IAB）的 tab 在窗口被遮挡时，Chromium 原生遮挡检测会**冻结 rAF**（`visibilityState` 仍为 visible，`requestAnimationFrame` 永不回调）。
- R3F 的 always/demand 两种 frameloop 都依赖 rAF → 表现为画布停在首帧。
- 已实现通用兜底 `apps/web/src/lib/render-fallback.ts`：探测 rAF 冻结后用 setInterval 直驱 `gl.render`（真实用户前台环境自动零开销）。本会话所有渲染实证均在该兜底下完成。
