#!/usr/bin/env python3
"""独立环境自检脚本（等价于 python -m app.main check-env）。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.worker import check_env  # noqa: E402

if __name__ == "__main__":
    sys.exit(check_env())
