#!/usr/bin/env bash
# 工作台统一标定入口 · 冒烟脚本
#
# 用法：
#   bash scripts/smoke-workbench.sh            # 默认 8125
#   PORT=8127 bash scripts/smoke-workbench.sh  # 换端口
#
# 做的事：
#   1) 确保 python3 -m http.server 在 EPBL-latest 根上运行
#   2) curl 检查 workbench/、gaze-heatmap/、shared/gaze/bus.js 均 200
#   3) 额外检查关键标记是否真的进了产物（按钮 id / bus 全局 / 接收端）
#   4) 打印手动验证步骤
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8125}"
BASE="http://127.0.0.1:${PORT}"
FAIL=0

say() { printf '%s\n' "$*"; }

start_server() {
  if curl -sf -o /dev/null "$BASE/workbench/"; then
    say "[server] 已在运行：$BASE（root=$ROOT）"
    return 0
  fi
  say "[server] 启动 python3 -m http.server $PORT --directory $ROOT"
  ( cd "$ROOT" && nohup python3 -m http.server "$PORT" --directory "$ROOT" >/dev/null 2>&1 & ) >/dev/null 2>&1
  for _ in $(seq 1 30); do
    sleep 0.2
    if curl -sf -o /dev/null "$BASE/workbench/"; then
      say "[server] 就绪"
      return 0
    fi
  done
  say "[server] 启动失败"
  FAIL=$((FAIL + 1))
  return 1
}

check_code() {
  local path="$1"
  local want="${2:-200}"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$path")
  if [ "$code" = "$want" ]; then
    say "  ok   $code  $path"
  else
    say "  FAIL $code  $path（期望 $want）"
    FAIL=$((FAIL + 1))
  fi
}

check_contains() {
  local path="$1" needle="$2" label="$3"
  if curl -s "$BASE$path" | grep -qF -- "$needle"; then
    say "  ok   $label"
  else
    say "  FAIL $label（$path 里找不到 $needle）"
    FAIL=$((FAIL + 1))
  fi
}

say "== 1. 静态服务 =="
start_server || true

say ""
say "== 2. 关键路径 HTTP 200 =="
check_code "/workbench/"
check_code "/gaze-heatmap/"
check_code "/shared/gaze/bus.js"

say ""
say "== 3. 产物标记 =="
check_contains "/workbench/index.html" 'id="gazeCalibBtn"' "workbench 顶栏有「标定视线」按钮"
check_contains "/workbench/index.html" 'id="gazeModelDot"' "workbench 顶栏有模型状态点"
check_contains "/workbench/index.html" 'gaze-host.js' "workbench 已引入 gaze-host.js"
check_contains "/workbench/gaze-host.js" '__epblGazeHost' "gaze-host 暴露自检接口"
check_contains "/shared/gaze/bus.js" 'epbl:gaze-model' "bus 协议字段存在"
check_contains "/gaze-heatmap/app.js" '__epblBus' "热力图已接 bus"
check_contains "/gaze-heatmap/index.html" 'shared/gaze/bus.js' "热力图 index 已加载 bus 模块"

say ""
say "== 4. 手动验证步骤 =="
cat <<'TXT'
  1) 打开 http://127.0.0.1:8125/workbench/  → 顶栏应出现「标定视线」+ 灰点
  2) 点「标定视线」→ 若摄像头/引擎不可用，stage 上应出现可读原因 + 重试/取消
     （宿主 CSP 为 script-src 'self'，WebAssembly 被拦，真实引擎会走 csp-wasm 分支）
  3) 打开 http://127.0.0.1:8125/workbench/?gazeSim=1 再点一次 → 应跑完 9 点、
     状态点变绿/黄，模型写入 epbl.gaze.model.v1
  4) 切到 #/gaze-heatmap（同一 workbench 页）→ 控制台执行
     __epblGazeHost.getStatus()  →  status 应为 ok 或 stale
     热力图侧应收到 toast「视线模型已更新 · v1-xxxxxxxx」
  5) 控制台执行 __epblBus.readyCount() → 应为 1（热力图 iframe 已 hello）
     再执行 __epblGazeHost.getModel().sig → 与 toast 里的 sig 一致
TXT

say ""
if [ "$FAIL" -eq 0 ]; then
  say "PASS smoke-workbench"
  exit 0
fi
say "FAIL smoke-workbench（$FAIL 项）"
exit 1
