#!/bin/sh
# 创建/更新 gaze-gateway 的独立运行环境（幂等）
set -e
cd "$(dirname "$0")"
PY="${PYTHON:-python3}"
if [ ! -d .venv ]; then
  "$PY" -m venv .venv
fi
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt
echo "ok: gaze-gateway/.venv ready"
echo "run: gaze-gateway/.venv/bin/python gaze-gateway/server.py"
