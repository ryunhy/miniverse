#!/usr/bin/env bash
# 训练执行脚本（由 Windows 计划任务调用，完全独立于任何交互会话）
set -uo pipefail
REPO=/mnt/c/Users/WYX/.zcode/workspace/93096d68-ed46-47d7-8fe9-02b8d3f61fac/miniverse
TASK=f1014582-4012-4acc-b91c-38a9098fcdfe

source /root/miniconda3/bin/activate miniverse
export MAX_JOBS=2
export TORCH_EXTENSIONS_DIR=/root/torch_ext

rm -f "$REPO/data/tasks/$TASK/status.json"
cd "$REPO/services/reconstruction"
python -u -m app.main run-task "$TASK" --data-dir "$REPO/data" >> /root/train-run.log 2>&1
echo "exit=$? $(date)" >> /root/train-run.log
