#!/usr/bin/env bash
# 诊断脚本：检查归位结构与训练产物
R=/mnt/c/Users/WYX/.zcode/workspace/93096d68-ed46-47d7-8fe9-02b8d3f61fac/miniverse
T=$R/data/processed/f1014582-4012-4acc-b91c-38a9098fcdfe
echo "=== processed/<task> 内容 ==="
ls "$T" 2>&1
echo "=== colmap 归位 ==="
find "$T/colmap" -type f 2>/dev/null | head -4
echo "=== sparse 原始 ==="
ls "$T/sparse/0" 2>/dev/null
echo "=== worker 进程 ==="
ps aux | grep worker-loop | grep -v grep | wc -l
echo "=== worker.log 尾部 ==="
tail -5 /root/worker.log 2>/dev/null
echo "=== status.json ==="
cat "$R/data/tasks/f1014582-4012-4acc-b91c-38a9098fcdfe/status.json" 2>/dev/null | head -c 150
echo
