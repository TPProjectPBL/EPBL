"""验证 BrowserAdapter 能控制系统 Chrome：移动 / 高亮 / 点击 / 滚动 / 导航。

运行前需在项目根起 http.server 提供测试页：
    python3 -m http.server 8125
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.adapters.browser import BrowserAdapter

HOME = "http://127.0.0.1:8125/control-backend/targets/test-page.html"


async def main() -> None:
    a = BrowserAdapter(home_url=HOME)
    await a.start()
    print("[status]", await a.status())

    # 移动 + 高亮：光标在页面上横向扫过
    for i in range(6):
        x = 0.15 + i * 0.12
        await a.execute({"action": "move", "x": x, "y": 0.25})
        await a.execute({"action": "highlight", "x": x, "y": 0.25})
        await asyncio.sleep(0.4)

    # 点击页面某坐标
    await a.execute({"action": "click", "x": 0.3, "y": 0.22})
    await asyncio.sleep(0.8)

    # 持续向下滚动，然后停止
    await a.execute({"action": "scroll", "dir": "down"})
    await asyncio.sleep(1.5)
    await a.execute({"action": "scroll", "dir": "stop"})

    # 回到主页
    await a.execute({"action": "home"})
    await asyncio.sleep(1.0)

    print("[done] 验证完成，5 秒后关闭浏览器")
    await asyncio.sleep(5)
    await a.stop()
    print("[stopped]")


if __name__ == "__main__":
    asyncio.run(main())
