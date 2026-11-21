#!/usr/bin/env bash
# 下载 MediaPipe FaceLandmarker 模型到 shared/gaze/models/face_landmarker.task
#
# 首次运行（或换机器）必须执行一次；模型是二进制，不进 git。
#   bash scripts/fetch-gaze-model.sh
# 可用环境变量覆盖源：
#   GAZE_MODEL_URL=https://... bash scripts/fetch-gaze-model.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="$ROOT/shared/gaze/models"
DEST="$DEST_DIR/face_landmarker.task"
URL="${GAZE_MODEL_URL:-https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task}"
MIN_BYTES=$((3 * 1024 * 1024))

size_of() {
  if stat -f%z "$1" >/dev/null 2>&1; then stat -f%z "$1"; else stat -c%s "$1"; fi
}

manual_hint() {
  echo
  echo "手动放置路径："
  echo "  $DEST"
  echo "下载地址："
  echo "  $URL"
  echo "要求文件大小 > 3MB（官方 float16 约 3.7MB）。"
}

mkdir -p "$DEST_DIR"

if [ -f "$DEST" ]; then
  CUR="$(size_of "$DEST")"
  if [ "$CUR" -gt "$MIN_BYTES" ]; then
    echo "已存在：$DEST（$((CUR / 1024)) KB），跳过下载。"
    exit 0
  fi
  echo "已存在但过小（$CUR bytes），重新下载。"
fi

TMP="$DEST.part"
rm -f "$TMP"

echo "下载模型：$URL"
if ! curl -fL --retry 2 --connect-timeout 20 -o "$TMP" "$URL"; then
  rm -f "$TMP"
  echo "下载失败（网络或地址不可用）。" >&2
  manual_hint
  exit 1
fi

SIZE="$(size_of "$TMP")"
if [ "$SIZE" -le "$MIN_BYTES" ]; then
  rm -f "$TMP"
  echo "校验失败：文件仅 $SIZE bytes，应大于 $MIN_BYTES bytes。" >&2
  manual_hint
  exit 1
fi

mv "$TMP" "$DEST"
echo "完成：$DEST（$((SIZE / 1024)) KB）"
