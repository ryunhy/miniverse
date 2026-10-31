"""MiniVerse 重建服务 CLI 入口。

用法：
  python -m app.main run-task <task_id> --data-dir <abs data dir>   # 由 Web 端派发
  python -m app.main check-env                                      # 环境自检
  python -m app.main worker-loop --data-dir <abs data dir>           # 轮询待处理任务
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

# 同时支持 `python -m app.main`（cwd 已在 services/reconstruction）与
# `python app/main.py`（Web 端直接按文件路径派发）两种启动方式
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="miniverse-reconstruction")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_run = sub.add_parser("run-task", help="执行单个重建任务")
    p_run.add_argument("task_id")
    p_run.add_argument("--data-dir", required=True, type=Path)

    sub.add_parser("check-env", help="环境自检（COLMAP/Nerfstudio/CUDA）")

    p_loop = sub.add_parser("worker-loop", help="轮询 pending 任务并执行")
    p_loop.add_argument("--data-dir", required=True, type=Path)
    p_loop.add_argument("--interval", type=float, default=5.0)

    args = parser.parse_args(argv)

    if args.cmd == "check-env":
        from app.worker import check_env

        return check_env()

    if args.cmd == "run-task":
        from app.worker import run_task

        data_dir: Path = args.data_dir.resolve()
        if not (data_dir / "tasks" / args.task_id / "input.json").exists():
            print(f"错误：任务输入不存在 {data_dir / 'tasks' / args.task_id / 'input.json'}", file=sys.stderr)
            return 2
        return run_task(args.task_id, data_dir)

    if args.cmd == "worker-loop":
        # 手动模式：扫描 input.json 存在且 status.json 缺失/非终态的任务
        data_dir: Path = args.data_dir.resolve()
        tasks_dir = data_dir / "tasks"
        print(f"worker-loop 启动：监听 {tasks_dir}")
        while True:
            for task_dir in sorted(tasks_dir.iterdir()) if tasks_dir.exists() else []:
                input_file = task_dir / "input.json"
                if not input_file.exists():
                    continue
                status_file = task_dir / "status.json"
                if status_file.exists():
                    try:
                        st = json.loads(status_file.read_text(encoding="utf-8"))
                        if st.get("status") in ("completed", "failed", "canceled"):
                            continue
                    except json.JSONDecodeError:
                        pass
                from app.worker import run_task

                print(f"拾取任务：{task_dir.name}")
                run_task(task_dir.name, data_dir)
            time.sleep(args.interval)

    return 0


if __name__ == "__main__":
    sys.exit(main())
