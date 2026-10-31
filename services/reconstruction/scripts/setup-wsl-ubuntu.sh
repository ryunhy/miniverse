#!/usr/bin/env bash
# MiniVerse WSL2 Ubuntu 重建环境一键安装脚本
# 前提：Ubuntu-22.04 发行版已注册（root 或 sudo 用户执行）
# 产物：conda env "miniverse"（python 3.10 + torch cu121 + nerfstudio + gsplat 编译）+ apt colmap
set -euo pipefail

log() { echo -e "\n[MiniVerse-setup $(date +%H:%M:%S)] $*\n"; }

export DEBIAN_FRONTEND=noninteractive
SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

log "1/7 系统包：build-essential / ffmpeg / libgl / colmap（CPU 版，位姿恢复与 GPU 版同质量）"
$SUDO apt-get update -y
$SUDO apt-get install -y --no-install-recommends \
  build-essential git curl wget ffmpeg libgl1 libegl1 libgomp1 \
  colmap ninja-build

log "2/7 Miniconda（若未安装）"
if [ ! -x "$HOME/miniconda3/bin/conda" ]; then
  wget -q https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh -O /tmp/miniconda.sh
  bash /tmp/miniconda.sh -b -p "$HOME/miniconda3"
fi
CONDA="$HOME/miniconda3/bin/conda"

log "3/7 conda env miniverse (python 3.10)"
# 新版 Miniconda 需先接受 defaults 渠道 ToS（个人开发免费；商用分发请改用 conda-forge）
"$CONDA" tos accept --override-channels --channel https://repo.anaconda.com/pkgs/main >/dev/null 2>&1 || true
"$CONDA" tos accept --override-channels --channel https://repo.anaconda.com/pkgs/r >/dev/null 2>&1 || true
"$CONDA" env list | grep -q "^miniverse " || "$CONDA" create -n miniverse python=3.10 -y
PIP="$HOME/miniconda3/envs/miniverse/bin/pip"

log "4/7 PyTorch cu121（约 2.5GB 下载）"
"$PIP" install --no-cache-dir torch==2.1.2 torchvision==0.16.2 \
  --index-url https://download.pytorch.org/whl/cu121

log "5/7 验证 CUDA 可用性"
"$HOME/miniconda3/envs/miniverse/bin/python" - <<'PY'
import torch
print("torch", torch.__version__, "| cuda_available:", torch.cuda.is_available())
if torch.cuda.is_available():
    print("gpu:", torch.cuda.get_device_name(0))
PY

log "6/7 conda cuda-toolkit 12.1（nvcc，gsplat 编译需要，约 10 分钟）"
"$CONDA" install -n miniverse -c "nvidia/label/cuda-12.1.1" cuda-toolkit -y

log "7/7 nerfstudio（含 gsplat 源码编译，10~30 分钟）"
"$PIP" install --no-cache-dir nerfstudio

log "完成！验证命令："
echo "  source ~/miniconda3/bin/activate miniverse && ns-train --help | head -2"
echo "  colmap -h | head -2"
echo "  python -m app.main check-env"
