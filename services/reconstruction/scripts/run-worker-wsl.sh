#!/usr/bin/env bash
# MiniVerse GPU Worker 常驻封装（WSL2 Ubuntu 内运行）
# 用法：bash run-worker-wsl.sh <仓库data目录的WSL路径>
# 例：bash run-worker-wsl.sh /mnt/c/Users/<you>/.zcode/workspace/<id>/miniverse/data
set -euo pipefail

DATA_DIR="${1:?用法: run-worker-wsl.sh <data目录路径>}"
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"  # services/reconstruction/scripts → services/reconstruction

source "$HOME/miniconda3/bin/activate" miniverse
cd "$REPO_DIR"

echo "[MiniVerse worker] data-dir=$DATA_DIR"
echo "[MiniVerse worker] 拾取 pending 任务并执行；Ctrl+C 退出"
exec python -u -m app.main worker-loop --data-dir "$DATA_DIR" --interval 5
