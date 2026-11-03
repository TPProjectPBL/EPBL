"""目标适配器接口（TargetAdapter）。

所有控制目标（浏览器 / 系统 / 应用 / IoT）都实现该契约，
命令模型与前端不变，扩展新目标只新增一个实现类。
"""
from __future__ import annotations

from abc import ABC, abstractmethod


class TargetAdapter(ABC):
    name: str = "base"

    @abstractmethod
    async def start(self) -> None:
        """启动并初始化目标（如拉起浏览器）。"""

    @abstractmethod
    async def stop(self) -> None:
        """停止并释放目标资源。"""

    @abstractmethod
    async def execute(self, cmd: dict) -> None:
        """执行统一命令。

        cmd 形如 {"action": "move", "x": 0.5, "y": 0.3}，坐标为归一化 0–1，
        由适配器内部换算为目标坐标。
        """

    @abstractmethod
    async def status(self) -> dict:
        """返回目标当前状态（连接态 / 页面等）。"""
