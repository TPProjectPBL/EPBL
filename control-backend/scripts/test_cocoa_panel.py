#!/usr/bin/env python3
"""验证 pyobjc 控制小窗：按钮 selector 映射 + Start/Stop + 摄像头开关。

在桌面环境（有 GUI）运行，通过 performClick 模拟点击按钮，驱动完整流程：
    control-backend/.venv/bin/python control-backend/scripts/test_cocoa_panel.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import Cocoa

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from launcher_cocoa import CocoaPanel  # noqa: E402


def wait_state(panel, target, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if panel.mgr.state == target:
            return True
        time.sleep(0.3)
    return False


def main() -> int:
    app = Cocoa.NSApplication.sharedApplication()
    app.setActivationPolicy_(Cocoa.NSApplicationActivationPolicyAccessory)
    panel = CocoaPanel.alloc().initWithApp_(app)

    # 控件存在性 + 初始状态
    assert panel.btn_start.title() == "Start"
    assert panel.btn_stop.title() == "Stop"
    assert panel.btn_cam.title() == "摄像头：关"
    assert panel.mgr.state == "stopped"
    print("控件与初始状态 OK")

    # Start
    panel.btn_start.performClick_(None)
    assert wait_state(panel, "running"), f"启动失败，state={panel.mgr.state}"
    print("Start -> running OK，页面:", panel.mgr.page)

    # 摄像头开
    panel.btn_cam.performClick_(None)
    time.sleep(1.0)
    assert panel.camera_on is True, "camera_on 应为 True"
    print("摄像头 -> on OK（按钮标题:", panel.btn_cam.title(), "）")

    # 摄像头关
    panel.btn_cam.performClick_(None)
    time.sleep(1.0)
    assert panel.camera_on is False, "camera_on 应为 False"
    print("摄像头 -> off OK")

    # Stop
    panel.btn_stop.performClick_(None)
    assert wait_state(panel, "stopped"), f"停止失败，state={panel.mgr.state}"
    print("Stop -> stopped OK")

    app.terminate_(None)
    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
