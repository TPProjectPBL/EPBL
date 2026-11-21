#!/bin/bash
# 校验 EPBL 工作副本是否是"融合了控制台 / 热力图 / 画板 / 跑酷"的版本。
# 只读，不修改任何文件。
#
# 用法：
#   bash scripts/verify-bundle.sh
#
# 退出码：
#   0  全部存在
#   1  有文件缺失、为空，或 modules.json 缺少必需模块
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

missing=0
check_file() {
  rel="$1"
  if [ ! -f "$ROOT/$rel" ] || [ ! -s "$ROOT/$rel" ]; then
    echo "缺失或为空: $rel"
    missing=1
  fi
}

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)"
echo "==> HEAD: $(git rev-parse --short HEAD) ($branch)"

echo "==> 基础文件"
check_file "workbench/index.html"
check_file "workbench/modules.json"
check_file "gaze-heatmap/index.html"
check_file "draw/index-3-hand.html"
check_file "eye-page-turner/demo/air-runner/index.html"
check_file "dual-test/index.html"
check_file "controller-demo/index.html"
check_file "control-frontend/index.html"

EXPECTED="dual-test gaze-heatmap draw air-runner"
modules_ok=1
modules_out=""

if command -v python3 >/dev/null 2>&1; then
  modules_out="$(python3 -c '
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    data = json.load(f)
for m in data.get("modules", []):
    print(str(m.get("id", "")) + "\t" + str(m.get("path", "")))
' "$ROOT/workbench/modules.json")"
else
  echo "!! 未找到 python3，退化为 grep 校验 modules.json（不校验 path 指向）"
  modules_ok=0
fi

echo "==> 模块（workbench/modules.json）"
if [ "$modules_ok" -eq 1 ]; then
  for want in $EXPECTED; do
    found_path=""
    while IFS=$'\t' read -r id path; do
      [ -z "$id" ] && continue
      if [ "$id" = "$want" ]; then
        found_path="$path"
        break
      fi
    done <<< "$modules_out"

    if [ -z "$found_path" ]; then
      echo "   缺失模块: $want"
      missing=1
      continue
    fi

    target="$ROOT/workbench/$found_path"
    if [ -f "$target" ] && [ -s "$target" ]; then
      echo "   ok  $want -> $found_path"
    else
      echo "   模块 $want 的 path 指向不存在或为空: $found_path"
      missing=1
    fi
  done
else
  for want in $EXPECTED; do
    if grep -q "\"id\"[[:space:]]*:[[:space:]]*\"$want\"" "$ROOT/workbench/modules.json"; then
      echo "   ok  $want"
    else
      echo "   缺失模块: $want"
      missing=1
    fi
  done
fi

if [ "$missing" -ne 0 ]; then
  echo "==> 校验失败：当前副本不是完整的融合版"
  exit 1
fi

echo "==> 校验通过：控制台 / 热力图 / 画板 / 跑酷 均在"
