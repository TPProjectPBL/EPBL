#!/usr/bin/env python3
"""验证后端 /camera 端点：启动后端 → 调 /camera?state=on|off → 停止后端。

无 GUI，可在终端运行：
    control-backend/.venv/bin/python control-backend/scripts/test_camera_api.py
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from launcher import BackendManager, BACKEND_URL  # noqa: E402


def get(path: str) -> dict:
    with urllib.request.urlopen(f"{BACKEND_URL}{path}", timeout=5) as r:
        return json.loads(r.read().decode("utf-8"))


def main() -> int:
    mgr = BackendManager()
    mgr.start()
    try:
        # 等待后端就绪
        for _ in range(60):
            if mgr.state == "running":
                break
            time.sleep(0.5)
        assert mgr.state == "running", f"后端未就绪，state={mgr.state}"

        health = get("/health")
        print("health:", health)
        assert health.get("connected") is True, "health.connected 应为 True"

        on = get("/camera?state=on")
        print("camera on ->", on)
        assert on.get("camera") == "on", "camera 应为 on"

        off = get("/camera?state=off")
        print("camera off ->", off)
        assert off.get("camera") == "off", "camera 应为 off"

        bad = get("/camera?state=bogus")
        print("camera bogus ->", bad)
        assert "error" in bad, "非法 state 应返回 error"

        print("PASS")
        return 0
    finally:
        mgr.stop()


if __name__ == "__main__":
    raise SystemExit(main())
