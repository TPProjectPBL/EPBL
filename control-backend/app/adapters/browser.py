"""BrowserAdapter：通过 Playwright / CDP 控制浏览器通用页面。

第一阶段唯一实现的控制目标。通过 Playwright 托管启动系统 Chrome（独立
user-data-dir），在目标页面注入可视化光标与高亮层，执行移动 / 点击 / 滚动 /
导航 / 高亮。坐标口径为归一化 0–1，内部换算为页面视口像素。
"""
from __future__ import annotations

import asyncio
from typing import Optional

from .base import TargetAdapter

# 注入页面：创建可视化光标（自执行）
_CURSOR_JS = """() => {
  let d = document.getElementById("__ac_cursor");
  if (!d) {
    d = document.createElement("div");
    d.id = "__ac_cursor";
    d.style.cssText = "position:fixed;left:0;top:0;width:18px;height:18px;border-radius:50%;border:2px solid #f5c518;background:rgba(245,197,24,.22);z-index:2147483647;pointer-events:none;transform:translate(-50%,-50%);box-shadow:0 0 10px rgba(245,197,24,.85);";
    document.body.appendChild(d);
  }
}
"""

# 移动可视化光标（参数 p = {x, y} 为像素）
_MOVE_JS = """(p) => {
  const d = document.getElementById("__ac_cursor");
  if (d) { d.style.left = p.x + "px"; d.style.top = p.y + "px"; }
}
"""

# 位置高亮圆环（参数 p = {x, y} 为像素）
_HL_JS = """(p) => {
  let d = document.getElementById("__ac_hl");
  if (!d) {
    d = document.createElement("div");
    d.id = "__ac_hl";
    d.style.cssText = "position:fixed;left:0;top:0;width:34px;height:34px;border:2px solid #f5c518;border-radius:50%;z-index:2147483646;pointer-events:none;transform:translate(-50%,-50%);";
    document.body.appendChild(d);
  }
  d.style.left = p.x + "px"; d.style.top = p.y + "px";
}
"""


class BrowserAdapter(TargetAdapter):
    name = "browser"

    def __init__(
        self,
        home_url: str = "http://127.0.0.1:8125/control-backend/targets/test-page.html",
        scroll_step: int = 60,
        scroll_interval: float = 0.05,
    ):
        self.home_url = home_url
        self.scroll_step = scroll_step
        self.scroll_interval = scroll_interval
        self._pw = None
        self._browser = None
        self._page = None
        self._scroll_dir: Optional[str] = None
        self._scroll_task: Optional[asyncio.Task] = None
        self.ready = False

    # ---------- 生命周期 ----------
    async def start(self) -> None:
        from playwright.async_api import async_playwright

        self._pw = await async_playwright().start()
        # 用系统 Chrome（channel="chrome"），避免下载 Chromium
        self._browser = await self._pw.chromium.launch(channel="chrome", headless=False)
        self._page = await self._browser.new_page()
        await self._page.goto(self.home_url)
        await self._page.evaluate(_CURSOR_JS)
        await self._page.evaluate(_HL_JS, {"x": 0, "y": 0})
        self.ready = True

    async def stop(self) -> None:
        if self._scroll_task:
            self._scroll_task.cancel()
            self._scroll_task = None
        if self._browser:
            try:
                await self._browser.close()
            except Exception:
                pass
        if self._pw:
            try:
                await self._pw.stop()
            except Exception:
                pass
        self.ready = False

    # ---------- 命令分发 ----------
    async def execute(self, cmd: dict) -> None:
        if not self.ready or not self._page:
            return
        action = cmd.get("action")
        if action == "move":
            await self._move(cmd["x"], cmd["y"])
        elif action == "click":
            await self._click(cmd["x"], cmd["y"])
        elif action == "scroll":
            await self._set_scroll(cmd.get("dir", "stop"))
        elif action == "navigate":
            await self._navigate(cmd.get("url", self.home_url))
        elif action == "back":
            await self._back()
        elif action == "home":
            await self._navigate(self.home_url)
        elif action == "menu":
            await self._menu()
        elif action == "highlight":
            await self._highlight(cmd["x"], cmd["y"])

    # ---------- 具体动作 ----------
    def _to_px(self, x: float, y: float) -> tuple[int, int]:
        vs = self._viewport()
        return int(x * vs[0]), int(y * vs[1])

    def _viewport(self) -> tuple[int, int]:
        try:
            vs = self._page.viewport_size
            if vs:
                return vs["width"], vs["height"]
        except Exception:
            pass
        return 1280, 720

    async def _move(self, x: float, y: float) -> None:
        px, py = self._to_px(x, y)
        try:
            await self._page.mouse.move(px, py)
        except Exception:
            pass
        await self._page.evaluate(_MOVE_JS, {"x": px, "y": py})

    async def _highlight(self, x: float, y: float) -> None:
        px, py = self._to_px(x, y)
        await self._page.evaluate(_HL_JS, {"x": px, "y": py})

    async def _click(self, x: float, y: float) -> None:
        px, py = self._to_px(x, y)
        await self._highlight(x, y)
        try:
            await self._page.mouse.click(px, py)
        except Exception:
            pass

    async def _navigate(self, url: str) -> None:
        try:
            await self._page.goto(url)
            await self._page.evaluate(_CURSOR_JS)
        except Exception:
            pass

    async def _back(self) -> None:
        try:
            await self._page.go_back()
        except Exception:
            pass

    async def _menu(self) -> None:
        # TODO: 二指「菜单」语义待定；暂实现为回到页面顶部作为占位反馈。
        try:
            await self._page.evaluate("() => window.scrollTo(0, 0)")
        except Exception:
            pass

    async def _set_scroll(self, direction: str) -> None:
        if direction in ("up", "down"):
            self._scroll_dir = direction
            if self._scroll_task is None or self._scroll_task.done():
                self._scroll_task = asyncio.create_task(self._scroll_loop())
        else:
            self._scroll_dir = None

    async def _scroll_loop(self) -> None:
        while self._scroll_dir:
            dy = self.scroll_step if self._scroll_dir == "down" else -self.scroll_step
            try:
                await self._page.evaluate("(dy) => window.scrollBy(0, dy)", dy)
            except Exception:
                pass
            await asyncio.sleep(self.scroll_interval)

    # ---------- 状态 ----------
    async def status(self) -> dict:
        url = ""
        if self._page:
            try:
                url = self._page.url
            except Exception:
                pass
        return {"name": self.name, "connected": self.ready, "page": url}
