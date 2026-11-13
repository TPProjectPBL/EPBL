#!/usr/bin/env bash
# 构建「隔空控制器」DMG：staging → py2app → ad-hoc 签名 → hdiutil → sha256
# 用法：packaging/build_dmg.sh
set -euo pipefail

cd "$(dirname "$0")"
PACKAGING="$(pwd)"
REPO="$(cd .. && pwd)"
VENV_PY="$REPO/control-backend/.venv/bin/python"
APP_NAME="隔空控制器"
VERSION="1.0.0"
ARCH="$(uname -m)"
STAGE="$PACKAGING/stage/site"
DIST="$PACKAGING/dist"

if [ ! -x "$VENV_PY" ]; then
  echo "缺少虚拟环境解释器：$VENV_PY" >&2
  echo "先执行： python3 -m venv control-backend/.venv && control-backend/.venv/bin/pip install -r control-backend/requirements.txt py2app" >&2
  exit 1
fi

echo "==> 1/6 复制静态站点到 staging（排除 .git/.venv/outputs 等）"
rm -rf "$PACKAGING/stage" "$DIST" "$PACKAGING/build"
mkdir -p "$STAGE"
rsync -a \
  --exclude '.git' --exclude '.venv' --exclude '.deepworks' --exclude '.opencode' \
  --exclude 'outputs' --exclude 'packaging' --exclude 'dist' --exclude 'build' \
  --exclude 'workbench/releases' --exclude 'node_modules' --exclude '__pycache__' \
  --exclude 'EyeControlApp' --exclude 'uploads' --exclude 'opencode.jsonc' \
  --exclude '.env*' --exclude '*.log' \
  --exclude '*.pyc' --exclude '.DS_Store' \
  "$REPO/" "$STAGE/"

echo "==> 2/6 py2app 构建 .app"
"$VENV_PY" setup.py py2app >/dev/null

APP="$DIST/$APP_NAME.app"
[ -d "$APP" ] || { echo "构建失败：找不到 $APP" >&2; exit 1; }

echo "==> 3/6 ad-hoc 签名并校验"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

echo "==> 4/6 生成 DMG（含 /Applications 快捷方式与安装说明）"
DMG="$DIST/${APP_NAME}-v${VERSION}-${ARCH}.dmg"
MOUNT_DIR="$(mktemp -d)"
cp -R "$APP" "$MOUNT_DIR/"
ln -s /Applications "$MOUNT_DIR/Applications"
if [ -f "$PACKAGING/resources/安装说明.txt" ]; then
  cp "$PACKAGING/resources/安装说明.txt" "$MOUNT_DIR/"
fi
rm -f "$DMG"
hdiutil create -quiet -volname "$APP_NAME" -srcfolder "$MOUNT_DIR" -ov -format UDZO "$DMG"
rm -rf "$MOUNT_DIR"

echo "==> 5/6 输出校验和"
shasum -a 256 "$DMG" | tee "$DMG.sha256"
ls -lh "$DMG"

echo "==> 6/6 发布到工作台下载中心"
"$VENV_PY" "$PACKAGING/publish.py" "$DMG" "$ARCH" "$VERSION"

echo
echo "完成：$DMG"
echo "工作台：http://127.0.0.1:8125/workbench/#/releases"
echo "提示：未公证版本首次打开需「右键 → 打开」。"
