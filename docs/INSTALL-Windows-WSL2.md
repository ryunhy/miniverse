# MiniVerse 重建环境安装指南（Windows + WSL2）

目标硬件基线：NVIDIA GPU ≥8GB 显存（本开发机实测 RTX 4070 Laptop 8GB）、32GB 内存、500GB NVMe。
显存越小越要用低分辨率 + 少步数（流水线已内置按显存自动降参）。

## 路线选择

| 路线 | 适用 | 说明 |
|---|---|---|
| **WSL2 Ubuntu（推荐）** | Windows 主力机 | COLMAP/Nerfstudio 在 Linux 下最顺，CUDA 直通 |
| Windows 原生 | 不想装 WSL | COLMAP 官方二进制可用；Nerfstudio 的 gsplat 编译较麻烦 |
| Docker（services/reconstruction/Dockerfile） | 有 docker-desktop | 一键镜像，GPU 需要 nvidia-container-toolkit |

本机现状（2026-10-24 实测）：WSL2 已启用但只有 docker-desktop 发行版，未装 Ubuntu；Windows Python 3.10.6 存在但 torch import 链损坏（tqdm/colorama 冲突）、无 COLMAP、无 Nerfstudio、无 CUDA Toolkit（nvcc 不存在）。`python -m app.main check-env` 会如实输出这些结论。

## 步骤 A：安装 WSL2 Ubuntu

```powershell
wsl --install -d Ubuntu-22.04   # 管理员 PowerShell；完成后重启
wsl -s Ubuntu-22.04             # 设为默认发行版
```

## 步骤 B：Ubuntu 内安装基础工具

```bash
sudo apt update && sudo apt install -y build-essential git ffmpeg libgl1
```

## 步骤 C：安装 Miniconda + PyTorch（CUDA 12.1）

```bash
wget https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh
bash Miniconda3-latest-Linux-x86_64.sh -b -p $HOME/miniconda3
$HOME/miniconda3/bin/conda init bash && exec bash

conda create -n miniverse python=3.10 -y
conda activate miniverse

# 版本组合以 Nerfstudio 官方安装文档为准：https://docs.nerf.studio/quickstart/installation.html
pip install torch==2.1.2 torchvision==0.16.2 --index-url https://download.pytorch.org/whl/cu121
python -c "import torch; print(torch.cuda.is_available())"   # 必须 True
```

## 步骤 D：安装 CUDA Toolkit（编译 gsplat / tiny-cuda-nn 需要 nvcc）

```bash
conda install -c nvidia cuda-toolkit=12.1 -y
nvcc --version   # 确认可用
```

## 步骤 E：安装 Nerfstudio

```bash
pip install nerfstudio
ns-train --help   # 验证
```

> gsplat / tiny-cuda-nn 首次运行会即时编译（10~30 分钟）。若编译失败，优先核对
> Python/Torch/CUDA 三者版本组合是否与官方文档一致——不要混装任意新版组合。

## 步骤 F：安装 COLMAP

```bash
sudo apt install -y colmap
colmap -h | head -2   # 验证
# 无 GPU 时 COLMAP 也可用 CPU 跑稀疏重建（慢）；流水线 use_gpu 参数可关
```

## 步骤 G：自检

```bash
cd /mnt/c/<仓库路径>/miniverse/services/reconstruction
python -m app.main check-env
```

预期输出（✅ 满足真实重建条件）：

```json
{ "colmap": true, "nerfstudio_ns_train": true, "torch_cuda_available": true, "vram_gb": 7.99, ... }
```

## 步骤 H：让 Web 端找到重建环境

Web 端派发 Worker 时按 PATH 探测 `python`/`py -3`。WSL2 内安装的环境在 Windows 侧
`worker-spawn.ts` 探测不到时，两种方案：

1. **手动模式（最简单）**：WSL2 内常驻
   ```bash
   conda activate miniverse
   python -m app.main worker-loop --data-dir /mnt/c/<仓库路径>/miniverse/data
   ```
   Web 创建的任务会被它拾取执行。
2. **Windows 侧也装齐**（不推荐，gsplat 编译坑多）。

## 低显存参数对照（8GB 卡实测建议）

| 参数 | 8GB | 12GB+ |
|---|---|---|
| maxResolution | 1200px（流水线自动） | 1600px |
| steps | 7000 | 10000~15000 |
| 并发 GPU 任务 | 1（worker 单飞锁已强制） | 1 |

OOM 处理：流水线捕获 CUDA OutOfMemory 后自动降分辨率（×0.75 → ×0.5）重试，最多 2 次；仍失败则任务置 `failed` 并保留完整日志。

## 拍摄建议（决定重建质量的第一要素）

- 30~80 张，环绕房间 2~3 圈，相邻照片 60%+ 重叠
- 避免运动模糊、镜面反射、大面积纯白墙
- 光线稳定（关自动曝光），分辨率够用即可（上传后还会降采样）
