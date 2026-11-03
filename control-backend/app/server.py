"""控制后端入口：FastAPI WebSocket 服务。

- 仅监听 127.0.0.1
- WebSocket 连接需带一次性 token（?token=...）
- 接收前端输入事件，经平滑 / 路由后交给目标适配器执行
"""
from __future__ import annotations

import json
import os

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .adapters.browser import BrowserAdapter
from .models import (
    CursorEvent,
    DwellEvent,
    GESTURE_ACTION,
    GestureEvent,
    StateMessage,
)
from .signal import CursorSmoother

TOKEN = os.environ.get("AC_TOKEN", "air-controller-dev")
HOME_URL = os.environ.get("AC_HOME", "http://127.0.0.1:8125/control-backend/targets/test-page.html")

app = FastAPI(title="Air Controller Backend")

adapter = BrowserAdapter(home_url=HOME_URL)
smoother = CursorSmoother()

# 已连接的前端 WebSocket（用于向后端广播摄像头等指令）
connections: list[WebSocket] = []
camera_state: str = "off"


@app.on_event("startup")
async def on_startup() -> None:
    await adapter.start()


@app.on_event("shutdown")
async def on_shutdown() -> None:
    await adapter.stop()


@app.get("/health")
async def health() -> dict:
    return await adapter.status()


async def broadcast(msg: dict) -> None:
    """向所有已连接前端广播指令。"""
    payload = json.dumps(msg)
    for ws in list(connections):
        try:
            await ws.send_text(payload)
        except Exception:  # noqa: BLE001
            pass


@app.get("/camera")
async def set_camera(state: str = "off") -> dict:
    """控制前端摄像头开关：GET /camera?state=on|off。"""
    global camera_state
    if state not in ("on", "off"):
        return {"error": "invalid state", "camera": camera_state}
    camera_state = state
    await broadcast({"type": "camera", "state": state})
    return {"camera": state, "connections": len(connections)}


async def handle_cursor(ev: CursorEvent) -> None:
    res = smoother.filter(ev.x, ev.y)
    if res is None:
        return
    x, y = res
    await adapter.execute({"action": "move", "x": x, "y": y})


async def handle_dwell(ev: DwellEvent) -> None:
    await adapter.execute({"action": "click", "x": ev.x, "y": ev.y})


async def handle_gesture(ev: GestureEvent) -> None:
    action = GESTURE_ACTION.get(ev.name)
    if action is None:
        return
    if action in ("scroll_up", "scroll_down"):
        if ev.state == "end":
            await adapter.execute({"action": "scroll", "dir": "stop"})
        else:
            direction = "down" if action == "scroll_down" else "up"
            await adapter.execute({"action": "scroll", "dir": direction})
    elif ev.state == "start":
        if action == "click":
            cx, cy = smoother.current()
            await adapter.execute({"action": "click", "x": cx, "y": cy})
        elif action == "back":
            await adapter.execute({"action": "back"})
        elif action == "home":
            await adapter.execute({"action": "home"})
        elif action == "menu":
            await adapter.execute({"action": "menu"})


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    if ws.query_params.get("token", "") != TOKEN:
        await ws.close(code=4001, reason="invalid token")
        return

    connections.append(ws)

    status = await adapter.status()
    await ws.send_text(
        StateMessage(connected=True, page=status["page"]).model_dump_json()
    )
    # 下发当前摄像头状态，让晚连接的前端也能同步
    await ws.send_text(json.dumps({"type": "camera", "state": camera_state}))

    try:
        while True:
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
                etype = data.get("type")
                if etype == "cursor":
                    await handle_cursor(CursorEvent.model_validate(data))
                elif etype == "gesture":
                    await handle_gesture(GestureEvent.model_validate(data))
                elif etype == "dwell":
                    await handle_dwell(DwellEvent.model_validate(data))
                else:
                    await ws.send_text(
                        json.dumps({"type": "error", "message": f"unknown type: {etype}"})
                    )
            except Exception as exc:  # noqa: BLE001
                await ws.send_text(
                    json.dumps({"type": "error", "message": str(exc)})
                )
    except WebSocketDisconnect:
        pass
    finally:
        if ws in connections:
            connections.remove(ws)
