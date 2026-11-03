#!/usr/bin/env python3
"""端到端验证：后端 /camera 指令能广播到前端，前端据此开关摄像头。

流程：起后端 → 无头 Chrome（假摄像头流）打开前端 → 连上后端
     → 后端下发 camera=on → 前端开启摄像头 → 后端下发 camera=off → 前端关闭摄像头。

运行：
    control-backend/.venv/bin/python control-frontend/scripts/test_camera_frontend.py
"""
from __future__ import annotations

import asyncio
import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "control-backend"))

from playwright.async_api import async_playwright  # noqa: E402
from launcher import BackendManager, BACKEND_URL, FRONT_URL  # noqa: E402


def get(path: str) -> dict:
    with urllib.request.urlopen(f"{BACKEND_URL}{path}", timeout=5) as r:
        return json.loads(r.read().decode("utf-8"))


async def main() -> int:
    mgr = BackendManager()
    mgr.start()
    try:
        import time
        for _ in range(60):
            if mgr.state == "running":
                break
            time.sleep(0.5)
        assert mgr.state == "running", f"后端未就绪：{mgr.state}"

        async with async_playwright() as pw:
            browser = await pw.chromium.launch(
                channel="chrome", headless=True,
                args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
            )
            page = await browser.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))

            await page.goto(FRONT_URL, wait_until="domcontentloaded")

            # 1) 前端连上后端
            await page.wait_for_function(
                "document.getElementById('pillBack').textContent.includes('已连接')",
                timeout=15000,
            )
            print("前端已连接后端")

            # 2) 后端下发 camera=on
            on = get("/camera?state=on")
            print("camera=on ->", on)
            assert on.get("camera") == "on"
            assert on.get("connections", 0) >= 1, "前端应已连接"

            # 摄像头开启（pillCam 显示分辨率）且 boot 完成（日志出现就绪/仅眼动）
            await page.wait_for_function(
                "document.getElementById('pillCam').textContent.includes('×')",
                timeout=20000,
            )
            await page.wait_for_function(
                "document.getElementById('log').textContent.includes('全部就绪')"
                " || document.getElementById('log').textContent.includes('仅眼动')"
                " || document.getElementById('log').textContent.includes('手势不可用')",
                timeout=20000,
            )
            pill_on = await page.text_content("#pillCam")
            print("开启后 pillCam:", pill_on.strip())
            assert "×" in pill_on, "摄像头未开启"

            # 3) 后端下发 camera=off
            off = get("/camera?state=off")
            print("camera=off ->", off)
            assert off.get("camera") == "off"

            await page.wait_for_function(
                "document.getElementById('pillCam').textContent.includes('已关闭')",
                timeout=10000,
            )
            pill_off = await page.text_content("#pillCam")
            print("关闭后 pillCam:", pill_off.strip())
            assert "已关闭" in pill_off, "摄像头未关闭"

            real = [e for e in errors if "facemesh" not in e]
            if real:
                print("页面错误:", real)

            await browser.close()

        print("PASS")
        return 0
    finally:
        mgr.stop()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
