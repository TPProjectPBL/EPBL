#!/bin/sh
# 组装 Cloudflare Pages 可用的静态站点（只含前端运行所需内容）
# 用法：scripts/build-site.sh [输出目录，默认 dist-site]
set -eu
cd "$(dirname "$0")/.."

OUT=${1:-dist-site}
case "$OUT" in
  dist-site|*/dist-site) ;;
  *) echo "拒绝输出到非 dist-site 目录：$OUT" >&2; exit 1 ;;
esac

echo "[1/4] 清理 $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"

echo "[2/4] 复制前端目录"

# 视线模型不入 git，必须在本机先就位，否则公网版会回退到 Google CDN
MODEL=shared/gaze/models/face_landmarker.task
if [ ! -s "$MODEL" ]; then
  echo "  本地缺少 face_landmarker.task，尝试下载…"
  bash scripts/fetch-gaze-model.sh || \
    echo "  ! 下载失败：公网版将回退 Google CDN，国内访问者可能无法标定"
fi

for d in workbench shared dual-test gaze-heatmap draw eye-page-turner gesture-test; do
  cp -R "$d" "$OUT/$d"
done

# DMG 安装包不进公网站点（体积超限，且应走仓库发布）
rm -rf "$OUT/workbench/releases"

# dual-test 只引用 controller-demo 的 WebGazer，其余 mediapipe vendor 不需要
mkdir -p "$OUT/controller-demo/vendor"
cp -R controller-demo/vendor/webgazer "$OUT/controller-demo/vendor/webgazer"

echo "[3/4] 生成公网版发布清单"
cat > "$OUT/workbench/releases.json" <<'JSON'
{
  "version": "1.0.0",
  "channel": "web",
  "items": [],
  "note": "公网演示版不提供安装包，获取方式见项目仓库。"
}
JSON

printf 'User-agent: *\nDisallow: /\n' > "$OUT/robots.txt"

# 站点根入口：域名直接访问时跳到工作台
cat > "$OUT/index.html" <<'HTML'
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=./workbench/">
<title>隔空控制器 · Air Controller</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070b12;color:#e8effa;
       font:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
  a{color:#4f9cf9}
</style>
</head>
<body><p>正在进入工作台… 若未自动跳转，<a href="./workbench/">点此进入</a>。</p></body>
</html>
HTML

cat > "$OUT/404.html" <<'HTML'
<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>页面不存在 · 隔空控制器</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070b12;color:#e8effa;
font:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;text-align:center}a{color:#4f9cf9}</style></head>
<body><div><p>这个地址不存在。</p><p><a href="/workbench/">返回工作台</a></p></div></body>
</html>
HTML

echo "[4/4] 统计"
python3 - "$OUT" <<'PY'
import os, sys
root = sys.argv[1]
files = 0
total = 0
big = []
for base, _, names in os.walk(root):
    for n in names:
        p = os.path.join(base, n)
        s = os.path.getsize(p)
        files += 1
        total += s
        if s > 20 * 1024 * 1024:
            big.append((s, os.path.relpath(p, root)))
print(f"文件数 {files}，总计 {total/1048576:.1f} MB")
for s, p in sorted(big, reverse=True):
    print(f"  ! {s/1048576:.1f} MB  {p}")
if files > 20000:
    print("  ! 超过 Cloudflare Pages 的 20000 文件上限")
PY
echo "完成：$OUT"
