#!/usr/bin/env python3
"""把构建产物发布到工作台下载中心。

用法：python3 packaging/publish.py <dmg路径> <arch> <version>

做的事：
  1. 复制 DMG 到 workbench/releases/
  2. 生成同名 .sha256
  3. 更新 workbench/releases.json 中对应架构条目（status=ready）
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
RELEASES_DIR = REPO / "workbench" / "releases"
RELEASES_JSON = REPO / "workbench" / "releases.json"

ARCHES = {
    "arm64": ("macos-arm64", "隔空控制器（Apple 芯片）"),
    "x86_64": ("macos-x64", "隔空控制器（Intel 芯片）"),
    "x64": ("macos-x64", "隔空控制器（Intel 芯片）"),
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def human_size(num: int) -> str:
    return f"{num / (1024 * 1024):.0f} MB" if num >= 1024 * 1024 else f"{num / 1024:.0f} KB"


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__)
        return 2

    dmg = Path(sys.argv[1]).expanduser().resolve()
    arch = sys.argv[2]
    version = sys.argv[3]
    if not dmg.is_file():
        print(f"[FAIL] 找不到产物：{dmg}")
        return 1

    entry_id, entry_name = ARCHES.get(arch, (f"macos-{arch}", f"隔空控制器（{arch}）"))
    RELEASES_DIR.mkdir(parents=True, exist_ok=True)

    dest = RELEASES_DIR / dmg.name
    if dmg != dest:
        shutil.copy2(dmg, dest)
    digest = sha256(dest)
    size = human_size(dest.stat().st_size)
    (RELEASES_DIR / f"{dest.name}.sha256").write_text(f"{digest}  {dest.name}\n", encoding="utf-8")

    data = {"version": version, "channel": "dev", "items": []}
    if RELEASES_JSON.exists():
        data = json.loads(RELEASES_JSON.read_text(encoding="utf-8"))
    data["version"] = version
    items = data.setdefault("items", [])

    item = next((it for it in items if it.get("id") == entry_id), None)
    if item is None:
        item = {"id": entry_id, "name": entry_name, "platform": "macOS 12+", "arch": arch}
        items.append(item)
    item.update({
        "version": version,
        "file": dest.name,
        "size": size,
        "sha256": digest,
        "status": "ready",
        "note": "首次启动需联网创建运行环境并安装依赖（约 1–3 分钟）。未公证，首次打开请右键 → 打开。",
    })

    RELEASES_JSON.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[OK] 已发布 {dest.name}（{size}），sha256={digest[:16]}…")
    return 0


if __name__ == "__main__":
    sys.exit(main())
