#!/usr/bin/env bash
# 启动控制后端（仅监听 127.0.0.1:8899）
set -e
cd "$(dirname "$0")"
exec .venv/bin/uvicorn app.server:app --host 127.0.0.1 --port 8899
