"""WebSocket 端点联调检查：连接 /ws，发送 cursor / gesture 命令，验证后端路由。

先启动后端：run.sh（或 uvicorn），并确保 http.server 8125 提供测试页。
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import websockets

URI = "ws://127.0.0.1:8899/ws?token=air-controller-dev"


async def main() -> None:
    async with websockets.connect(URI) as ws:
        state = await ws.recv()
        print("[recv]", state)

        # cursor 移动
        for i in range(5):
            x = 0.2 + i * 0.1
            await ws.send(json.dumps({"type": "cursor", "x": x, "y": 0.3}))
            await asyncio.sleep(0.3)

        # 握拳 → 点击
        await ws.send(json.dumps({"type": "gesture", "name": "fist", "state": "start"}))
        await asyncio.sleep(0.5)

        # 四指朝下 → 滚动（hold 持续，end 停止）
        await ws.send(json.dumps({"type": "gesture", "name": "four_down", "state": "start"}))
        await asyncio.sleep(1.0)
        await ws.send(json.dumps({"type": "gesture", "name": "four_down", "state": "end"}))
        await asyncio.sleep(0.5)

        # 非法类型 → 应回 error
        await ws.send(json.dumps({"type": "unknown", "x": 1}))
        err = await ws.recv()
        print("[recv]", err)

        print("[done] WebSocket 联调检查完成")


if __name__ == "__main__":
    asyncio.run(main())
