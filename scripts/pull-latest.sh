#!/bin/bash
# 拉取 EPBL 最新融合版（控制台 / 热力图 / 画板 / 跑酷）。
# 远端历史会被强制推送，因此禁止 git pull，统一走本脚本。
#
# 保护范围：
#   1. 工作区已跟踪文件的改动 -> pending-*.patch，reset 后重放
#   2. 本地提交（远端基线之后的） -> commits-*/0001-*.patch，reset 后 git am 重放
#   3. 未跟踪文件             -> 不备份，但 reset 不会删除，脚本会列出
#
# 关键设计：
#   - last-sync 记录的是「上一次成功拉取到的远端提交」，不是本地 HEAD。
#   - 本地提交每次都会被备份，但用 patch-id 去重，已重放过的不会再 am 一次。
#   - 远端覆盖本地提交（强推）时，备份目录里的 patch 就是恢复源。
#
# 用法：
#   bash scripts/pull-latest.sh
# 可选环境变量：
#   REMOTE=origin BRANCH=main PATCH_DIR=/path/to/tmp bash scripts/pull-latest.sh
#
# 退出码：
#   0  已是最新 / 本地领先 / 更新成功且无冲突
#   3  更新成功，但工作区改动重放存在 .rej，需要手工处理
#   4  本地提交重放失败（git am 冲突），已 abort，补丁保留在 commits-*/ 目录
#   其他 git 命令失败，见 stderr
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-main}"
PATCH_DIR="${PATCH_DIR:-$(dirname "$ROOT")/.deepworks/tmp}"
mkdir -p "$PATCH_DIR"

# 上一次成功拉取到的远端提交
SYNC_FILE="$PATCH_DIR/last-sync"
# 已重放过的 patch-id，防止同一提交被反复 am
APPLIED_FILE="$PATCH_DIR/applied-patch-ids"
touch "$APPLIED_FILE"

ts="$(date +%Y%m%d-%H%M%S)"
old_head="$(git rev-parse HEAD)"
old_short="$(git rev-parse --short HEAD)"
echo "==> 当前 HEAD: $old_short"

# ---------- 1. 备份工作区改动 ----------
patch=""
if [ -n "$(git status --porcelain)" ]; then
  if [ -n "$(git diff HEAD --name-only)" ]; then
    patch="$PATCH_DIR/pending-$ts.patch"
    git diff HEAD > "$patch"
    echo "==> 已备份工作区改动: $patch"
  else
    echo "==> 只有未跟踪文件，无需备份 diff（reset 不会删除它们）"
  fi

  untracked="$(git ls-files --others --exclude-standard)"
  if [ -n "$untracked" ]; then
    echo "!! 以下未跟踪文件不会进入 patch（reset 也不会删除它们）："
    echo "$untracked" | sed 's/^/   /'
  fi
fi

# ---------- 2. 确定远端基线并备份本地提交 ----------
base=""
if [ -f "$SYNC_FILE" ]; then
  base="$(cat "$SYNC_FILE")"
  if ! git cat-file -e "$base^{commit}" 2>/dev/null; then
    echo "!! last-sync 记录的提交 ${base:0:8} 已不存在（历史被改写），改用 FETCH_HEAD"
    base=""
  fi
fi
if [ -z "$base" ] && git rev-parse --verify -q FETCH_HEAD >/dev/null 2>&1; then
  base="$(git rev-parse FETCH_HEAD)"
  echo "!! 没有可用的 last-sync，以 FETCH_HEAD ${base:0:8} 作远端基线"
fi

commits_dir=""
pending_commits=""
if [ -n "$base" ]; then
  pending_commits="$(git rev-list --reverse "$base..HEAD" 2>/dev/null || true)"
fi

if [ -n "$pending_commits" ]; then
  commits_dir="$PATCH_DIR/commits-$ts"
  mkdir -p "$commits_dir"
  # 必须传 range：单个 SHA 会被 format-patch 当成 <since>..HEAD，导致空补丁
  git format-patch -o "$commits_dir" "$base..HEAD" >/dev/null
  echo "==> 已备份本地提交（候选重放）："
  echo "$pending_commits" | while read -r c; do
    echo "   $(git log --oneline -1 "$c")"
  done
  echo "   补丁目录: $commits_dir"
fi

# ---------- 3. 拉取并比较 ----------
echo "==> 拉取 $REMOTE/$BRANCH"
git fetch --depth 1 "$REMOTE" "$BRANCH"

new_head="$(git rev-parse FETCH_HEAD)"
new_short="$(git rev-parse --short FETCH_HEAD)"

if [ "$old_head" = "$new_head" ]; then
  echo "already up to date ($old_short)"
  echo "$new_head" > "$SYNC_FILE"
  exit 0
fi

# 本地领先远端：绝不能 reset，否则会丢掉本地提交。
if git merge-base --is-ancestor "$new_head" "$old_head" 2>/dev/null; then
  ahead="$(git rev-list --count "$new_head..$old_head")"
  echo "==> 本地领先远端 $ahead 个提交，无需更新（$old_short 保持不动）"
  echo "$new_head" > "$SYNC_FILE"
  exit 0
fi

echo "==> 更新: $old_short -> $new_short"
echo "==> 变化范围（$old_short -> $new_short）："
git diff --stat "$old_head" "$new_head" || true

echo "==> reset --hard $new_short"
git reset --hard "$new_head" >/dev/null

# ---------- 4. 重放本地提交（patch-id 去重） ----------
if [ -n "$commits_dir" ]; then
  if ! git config user.email >/dev/null 2>&1; then
    export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-deepworks}"
    export GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-deepworks@localhost}"
  fi

  for p in "$commits_dir"/*.patch; do
    [ -e "$p" ] || continue
    name="$(basename "$p")"
    pid="$(git patch-id --stable < "$p" | awk '{print $1}')"

    if [ -n "$pid" ] && grep -qx "$pid" "$APPLIED_FILE"; then
      echo "   跳过（已重放过）: $name"
      continue
    fi
    # 远端新版本可能已经包含同样的改动
    if git apply --reverse --check "$p" >/dev/null 2>&1; then
      echo "   跳过（当前版本已包含）: $name"
      [ -n "$pid" ] && echo "$pid" >> "$APPLIED_FILE"
      continue
    fi

    echo "   重放: $name"
    if ! git am "$p"; then
      echo "!! 提交重放冲突：$p"
      git am --abort >/dev/null 2>&1 || true
      echo "   已 abort，仓库回到 $new_short。"
      echo "   补丁保留在 $commits_dir，可手工 git am / cherry-pick 后继续。"
      exit 4
    fi
    [ -n "$pid" ] && echo "$pid" >> "$APPLIED_FILE"
  done
fi

# ---------- 5. 重放工作区改动 ----------
if [ -n "$patch" ] && [ -f "$patch" ]; then
  echo "==> 重放工作区改动: $patch"
  set +e
  git apply --reject "$patch"
  apply_rc=$?
  set -e
  if [ "$apply_rc" -ne 0 ]; then
    echo "!! 重放存在冲突（git apply 退出码 $apply_rc），未应用片段见 .rej"
  fi
fi

rejects="$(find . -name '*.rej' -not -path './.git/*' | sort)"
if [ -n "$rejects" ]; then
  echo "!! 需要手工重做的 .rej："
  echo "$rejects" | sed 's/^/   /'
  echo "   逐个按 .rej 内容重新应用，完成后删除对应 .rej。"
  exit 3
fi

# 记录本次拉取到的远端提交
echo "$new_head" > "$SYNC_FILE"
echo "==> 完成：$new_short，无冲突"
