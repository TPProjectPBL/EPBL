"""控制小窗 GUI 冒烟测试（需真实桌面 GUI 环境，双击 launcher.command 亦可直接验证）。

注意：tkinter 的 Tk() 在无窗口服务器的自动化 shell 中会卡住，因此本脚本仅供
在有 GUI 的桌面手动运行：`control-backend/.venv/bin/python scripts/test_launcher_smoke.py`
运行时会短暂弹出控制小窗与受控 Chrome，自动走完 start → 就绪 → end 全流程。
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import tkinter as tk

from launcher import ControlPanel


def pump(root, seconds):
    end = time.time() + seconds
    while time.time() < end:
        root.update()
        time.sleep(0.05)


def chrome_pipe_count():
    out = subprocess.run(
        ["pgrep", "-fl", "remote-debugging-pipe"],
        capture_output=True, text=True,
    ).stdout.strip().splitlines()
    return len([l for l in out if l.strip()])


def main():
    root = tk.Tk()
    panel = ControlPanel(root)
    root.update()

    print("初始状态:", panel.mgr.state)

    panel.start()
    pump(root, 12)
    print("start 后状态:", panel.mgr.state)
    print("backend 进程存活:", panel.mgr.backend_proc is not None and panel.mgr.backend_proc.poll() is None)

    try:
        with urllib.request.urlopen("http://127.0.0.1:8899/health", timeout=2) as r:
            print("health:", json.loads(r.read().decode()))
    except Exception as e:
        print("health 错误:", e)

    print("受控 Chrome 进程数:", chrome_pipe_count())

    panel.stop()
    pump(root, 4)
    print("stop 后状态:", panel.mgr.state)
    print("backend_proc 清理:", panel.mgr.backend_proc is None)
    print("http_proc 清理:", panel.mgr.http_proc is None)
    print("受控 Chrome 进程数(停止后):", chrome_pipe_count())

    root.destroy()
    print("done")


if __name__ == "__main__":
    main()
