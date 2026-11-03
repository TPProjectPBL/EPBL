"""信号平滑：EMA 低通 + 死区，抑制眼动光标抖动。"""
from __future__ import annotations


class CursorSmoother:
    """对归一化坐标做 EMA 平滑与死区过滤。"""

    def __init__(self, alpha: float = 0.35, deadzone: float = 0.004):
        self.alpha = alpha
        self.deadzone = deadzone
        self._x: float | None = None
        self._y: float | None = None

    def filter(self, x: float, y: float) -> tuple[float, float] | None:
        """返回平滑后的 (x, y)；变化小于死区时返回 None 表示应忽略。"""
        if self._x is None:
            self._x, self._y = x, y
            return x, y
        if abs(x - self._x) < self.deadzone and abs(y - self._y) < self.deadzone:
            return None
        self._x += self.alpha * (x - self._x)
        self._y += self.alpha * (y - self._y)
        return self._x, self._y

    def current(self) -> tuple[float, float]:
        return (self._x or 0.5, self._y or 0.5)
