# MiniVerse GPU 重建服务参考镜像（真实部署用；本地开发用 WSL2/直装即可）
# 构建：docker build -t miniverse-reconstruction services/reconstruction
# 运行：docker run --gpus all -v <repo>/data:/data miniverse-reconstruction \
#         python -m app.main worker-loop --data-dir /data
FROM nvidia/cuda:12.1.1-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.10 python3-pip python3.10-venv \
    colmap \
    git curl ffmpeg libgl1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip3 install --no-cache-dir torch==2.1.2 torchvision==0.16.2 \
    --index-url https://download.pytorch.org/whl/cu121 \
    && pip3 install --no-cache-dir -r requirements.txt

COPY app ./app

# worker-loop：轮询 /data/tasks 下的任务文件协议
CMD ["python3", "-m", "app.main", "worker-loop", "--data-dir", "/data"]
