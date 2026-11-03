"""命令协议模型：前端输入事件 → 后端统一命令。

口径约定：前端只上报「归一化坐标（0–1）」与「语义手势名」；
换算为目标视口像素、以及手势→动作的映射，全部由后端负责。
"""
from __future__ import annotations

from typing import Literal, Union

from pydantic import BaseModel, Field


# ---------- 前端 → 后端：输入事件 ----------
class CursorEvent(BaseModel):
    """眼动光标事件：归一化视口坐标。"""

    type: Literal["cursor"] = "cursor"
    x: float = Field(..., ge=0.0, le=1.0, description="归一化视口横坐标 0–1")
    y: float = Field(..., ge=0.0, le=1.0, description="归一化视口纵坐标 0–1")


class GestureEvent(BaseModel):
    """手势事件：6 件套 + 中立态。"""

    type: Literal["gesture"] = "gesture"
    name: Literal["fist", "thumb", "point", "two", "four_up", "four_down", "open"]
    state: Literal["start", "hold", "end"] = "hold"


class DwellEvent(BaseModel):
    """驻留点击事件（可选）。"""

    type: Literal["dwell"] = "dwell"
    x: float = Field(..., ge=0.0, le=1.0)
    y: float = Field(..., ge=0.0, le=1.0)


InputEvent = Union[CursorEvent, GestureEvent, DwellEvent]


# ---------- 手势 → 动作映射（6 件套，见 HANDOFF.md） ----------
GESTURE_ACTION: dict[str, str] = {
    "fist": "click",           # 握拳 → 确认 / 点击
    "thumb": "back",           # 拇指朝上 → 返回
    "point": "home",           # 食指 → 主页
    "two": "menu",             # 二指 → 菜单
    "four_up": "scroll_up",    # 四指指尖朝上 → 上滚
    "four_down": "scroll_down",  # 四指指尖朝下 → 下滚
}


# ---------- 后端 → 前端：状态回传 ----------
class StateMessage(BaseModel):
    type: Literal["state"] = "state"
    target: str = "browser"
    connected: bool = True
    page: str = ""
