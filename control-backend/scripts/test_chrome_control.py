#!/usr/bin/env python3
"""真实 Chrome 控制验证：移动 / 点击 / 滚动 / 导航，并读回页面 DOM 确认生效。

拉起 http.server(8125) + 受控 Chrome（会弹出可见窗口），依次：
  move   -> 读取注入光标 #__ac_cursor 位置
  click  -> 点击「按钮 A」后读取 #clicklog 文本
  scroll -> 读取 window.scrollY
  home   -> 读取 URL / scrollY

运行：
    control-backend/.venv/bin/python control-backend/scripts/test_chrome_control.py
"""
from __future__ import annotations

import asyncio
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.adapters.browser import BrowserAdapter  # noqa: E402

HOME = "http://127.0.0.1:8125/control-backend/targets/test-page.html"


async def main() -> int:
    # 1) 起静态服务
    srv = subprocess.Popen(
        [sys.executable, "-m", "http.server", "8125"],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        # 等 http.server 就绪
        for _ in range(20):
            try:
                import urllib.request
                urllib.request.urlopen(HOME, timeout=1).read()
                break
            except Exception:
                time.sleep(0.3)

        # 2) 起受控 Chrome
        a = BrowserAdapter(home_url=HOME)
        await a.start()
        page = a._page
        print("受控 Chrome 已启动，页面：", page.url)

        # 3) move：读注入光标位置
        await a.execute({"action": "move", "x": 0.35, "y": 0.30})
        await asyncio.sleep(0.3)
        cur = await page.evaluate(
            "() => { const d = document.getElementById('__ac_cursor');"
            " return d ? (d.style.left + ',' + d.style.top) : null; }"
        )
        print("move 后注入光标位置(left,top):", cur)
        assert cur is not None, "注入光标不存在"

        # 4) click：点击「按钮 A」后读 #clicklog
        rect = await page.evaluate(
            "() => { const b = document.querySelector('button[data-action=\"A\"]');"
            " const r = b.getBoundingClientRect();"
            " return {x: r.x + r.width/2, y: r.y + r.height/2}; }"
        )
        vs = a._viewport()
        nx, ny = rect["x"] / vs[0], rect["y"] / vs[1]
        await a.execute({"action": "click", "x": nx, "y": ny})
        await asyncio.sleep(0.5)
        log = await page.evaluate("document.getElementById('clicklog').textContent")
        print("click 后 #clicklog:", log)
        assert "按钮 A" in log, f"点击未生效：{log}"

        # 5) scroll down：读 scrollY
        await a.execute({"action": "scroll", "dir": "down"})
        await asyncio.sleep(1.2)
        await a.execute({"action": "scroll", "dir": "stop"})
        sy = await page.evaluate("window.scrollY")
        print("scroll down 后 window.scrollY:", sy)
        assert sy > 0, "滚动未生效"

        # 6) menu（回到顶部占位）：读 scrollY
        await a.execute({"action": "menu"})
        await asyncio.sleep(0.4)
        sy2 = await page.evaluate("window.scrollY")
        print("menu 后 window.scrollY:", sy2)

        # 7) home：重新导航到主页，读 URL
        await a.execute({"action": "home"})
        await asyncio.sleep(1.0)
        print("home 后 URL:", page.url)
        assert page.url.startswith("http://127.0.0.1:8125"), "home 导航未生效"

        # 8) navigate：跳转到另一页再 back
        await a.execute({"action": "navigate", "url": "http://127.0.0.1:8125/control-frontend/index.html"})
        await asyncio.sleep(1.2)
        print("navigate 后 URL:", page.url)
        await a.execute({"action": "back"})
        await asyncio.sleep(1.2)
        print("back 后 URL:", page.url)

        await a.stop()
        print("PASS")
        return 0
    finally:
        srv.terminate()
        srv.wait()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
