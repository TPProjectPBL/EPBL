#!/usr/bin/env python3
"""校验工作台模块注册表：每个模块的 path 必须存在。

用法：
    python3 workbench/scripts/check_modules.py

退出码：0 全部存在；1 有缺失或注册表非法。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

WORKBENCH = Path(__file__).resolve().parent.parent
REGISTRY = WORKBENCH / "modules.json"

REQUIRED = {"id", "group", "name", "path"}


def main() -> int:
    if not REGISTRY.exists():
        print(f"[FAIL] 找不到注册表：{REGISTRY}")
        return 1

    try:
        data = json.loads(REGISTRY.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"[FAIL] modules.json 不是合法 JSON：{exc}")
        return 1

    groups = {g.get("id") for g in data.get("groups", [])}
    modules = data.get("modules", [])
    missing: list[str] = []
    problems: list[str] = []
    seen: set[str] = set()

    for mod in modules:
        mid = mod.get("id", "<no-id>")
        lack = REQUIRED - set(mod)
        if lack:
            problems.append(f"{mid}: 缺少字段 {sorted(lack)}")
            continue
        if mid in seen:
            problems.append(f"{mid}: id 重复")
        seen.add(mid)
        if mod["group"] not in groups:
            problems.append(f"{mid}: group '{mod['group']}' 未在 groups 中声明")
        target = (WORKBENCH / mod["path"]).resolve()
        if not target.exists():
            missing.append(f"{mid}: {mod['path']} -> {target}")
        elif not target.is_file():
            problems.append(f"{mid}: {mod['path']} 不是文件")

    width = max((len(m.get("id", "")) for m in modules), default=8)
    print(f"{'ID'.ljust(width)}  {'状态':<6} 路径")
    print("-" * (width + 46))
    for mod in modules:
        mid = mod.get("id", "")
        target = (WORKBENCH / mod.get("path", "")).resolve()
        state = "OK" if target.is_file() else "MISSING"
        print(f"{mid.ljust(width)}  {state:<6} {mod.get('path', '')}")

    print()
    print(f"模块数：{len(modules)}；分组数：{len(groups)}")

    for line in problems:
        print(f"[FAIL] {line}")
    for line in missing:
        print(f"[FAIL] 文件缺失 {line}")

    if problems or missing:
        return 1
    print("[OK] 注册表校验通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
