"""验证控制前端页面可正常加载：无 JS 语法 / import 错误，module 正常执行。

运行前需在项目根起 http.server 8125：
    python3 -m http.server 8125
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
        page.on("pageerror", lambda e: errors.append("[pageerror] " + str(e)))
        page.on("console", lambda m: errors.append(f"[console.{m.type}] {m.text}") if m.type == "error" else None)

        await page.goto(PAGE, wait_until="domcontentloaded")
        await asyncio.sleep(3)

        # 检查点：webgazer 全局加载、module 执行（日志写入“前端就绪”）
        has_webgazer = await page.evaluate("typeof webgazer !== 'undefined'")
        log_text = await page.text_content("#log")

        print("webgazer 加载:", has_webgazer)
        print("module 已执行:", "前端就绪" in (log_text or ""))
        print("log 首行:", (log_text or "").strip().splitlines()[0] if (log_text or "").strip() else "(空)")

        # 分类：预期（后端未启动的 WS 失败）与已知无害（facemesh 模型路径 404，仅用于已禁用的面部网格 overlay）
        real_errors, known = [], []
        for e in errors:
            if "WebSocket" in e or "8899" in e or "ERR_CONNECTION" in e:
                continue
            if "facemesh" in e or ("Failed to load resource" in e and "404" in e):
                known.append(e)
                continue
            real_errors.append(e)
        print("非预期错误数:", len(real_errors))
        for e in real_errors:
            print("  ", e)
        if known:
            print(f"已知无害警告 {len(known)} 条（facemesh 模型 404，不影响眼动）：")
            for e in known[:2]:
                print("  ", e)

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
