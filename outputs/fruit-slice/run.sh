#!/bin/sh
# 启动手势切水果。
# 注意：这台机器的 `python3` 指向 Python 3.14，而 mediapipe/opencv 装在 Python 3.9，
# 所以这里写死 /usr/bin/python3，避免 "ModuleNotFoundError: No module named 'cv2'"。
cd "$(dirname "$0")" || exit 1
exec /usr/bin/python3 main.py "$@"
