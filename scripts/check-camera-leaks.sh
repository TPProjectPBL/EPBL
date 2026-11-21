#!/usr/bin/env bash
# 摄像头泄漏检查（CDP 版）。
#
#   bash scripts/check-camera-leaks.sh            # 默认 20 轮
#   ROUNDS=40 bash scripts/check-camera-leaks.sh
#
# 依赖：本地静态服务 + DeepWorks 浏览器 CDP。
#   python3 -m http.server 8125 --directory <repo>   # 若未启动
#   浏览器 CDP: http://127.0.0.1:9228
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CDP_URL="${CDP_URL:-http://127.0.0.1:9228}"
WB_URL="${WB_URL:-http://127.0.0.1:8125/workbench/}"
ROUNDS="${ROUNDS:-20}"

echo "== 摄像头泄漏检查 =="
echo "   repo : $ROOT"
echo "   cdp  : $CDP_URL"
echo "   url  : $WB_URL"
echo "   rounds: $ROUNDS"
echo

if ! curl -sf "$CDP_URL/json/version" >/dev/null 2>&1; then
  echo "!! CDP 不可达：$CDP_URL" >&2
  echo "   先启动 DeepWorks 浏览器（或 --remote-debugging-port=9228）。" >&2
  exit 2
fi

if ! curl -sf "$WB_URL" >/dev/null 2>&1; then
  echo "!! 工作台不可达：$WB_URL" >&2
  echo "   先跑：python3 -m http.server 8125 --directory \"$ROOT\"" >&2
  exit 2
fi

node "$ROOT/scripts/check-camera-leaks.mjs" --cdp "$CDP_URL" --url "$WB_URL" --rounds "$ROUNDS"

echo
echo "通过判据："
echo "  - 每轮 video 元素总数 <= 1（宿主 1 路，或独占模块 1 路）"
echo "  - 结束回到 air-runner 时 host.subscribers >= 1，inference 能恢复"
echo
echo "手动清单（无 CDP 时用 chrome://media-internals）："
echo "  1. 打开工作台 → 切换 4 个模块各 5 次 → media-internals 里只应有 1 个活跃 capture"
echo "  2. 关闭工作台标签页 → 摄像头指示灯 3 秒内熄灭"
echo "  3. 切到别的标签页 30 秒再回来 → air-runner 光标恢复，无重新授权弹窗"
echo "  4. 画板 / dual-test 会声明独占：进入时宿主应提示「已释放设备」，退出后提示「推理恢复」"
