"""端到端联调验证：前端页面（模拟模式）→ WebSocket → 后端 → 浏览器控制。

前置：后端已启动（run.sh / uvicorn 8899）、http.server 8125 已启动。
检查点：前端连上后端、模拟手势/点击命令成功发送（无 JS 报错）。
"""
from __future__ import annotations

import asyncio

from playwright.async_api import async_playwright

PAGE = "http://127.0.0.1:8125/control-frontend/index.html"


async def main() -> None:
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(channel="chrome", headless=True)
        page = await browser.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        await page.goto(PAGE, wait_until="domcontentloaded")

        # 等前端连上后端（收到 state connected）
        connected = False
        for _ in range(20):
            log_text = (await page.text_content("#log")) or ""
            if "已连接后端" in log_text:
                connected = True
                break
            await asyncio.sleep(0.5)
        print("前端已连接后端:", connected)

        # 模拟手势：four_down（key 6）持续滚动后松开
        await page.keyboard.down("6")
        await asyncio.sleep(1.0)
        await page.keyboard.up("6")

        # 模拟 fist（key 1）点击
        await page.keyboard.down("1")
        await asyncio.sleep(0.3)
        await page.keyboard.up("1")
        await asyncio.sleep(0.5)

        log_text = (await page.text_content("#log")) or ""
        print("模拟滚动已发送:", "[模拟] four_down start" in log_text)
        print("模拟点击已发送:", "[模拟] fist start" in log_text)

        print("JS 错误数:", len(errors))
        for e in errors:
            print("  ", e)

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
