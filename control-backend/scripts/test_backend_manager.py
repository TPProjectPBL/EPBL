"""BackendManager start/end 循环测试（无 GUI）。

验证：Start 启动 http 服务 + 后端 + 受控 Chrome → 后端就绪 → End 优雅终止（Chrome 关闭、子进程退出、无残留）。
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from launcher import BackendManager


def chrome_pipe_count():
    out = subprocess.run(
        ["pgrep", "-fl", "remote-debugging-pipe"],
        capture_output=True, text=True,
    ).stdout.strip().splitlines()
    return len([l for l in out if l.strip()])


def main():
    logs: list[str] = []
    mgr = BackendManager(on_log=lambda m: logs.append(m))

    print("初始 state:", mgr.state)
    ok = mgr.start()
    print("start 返回:", ok, "| state:", mgr.state)

    deadline = time.time() + 20
    while mgr.state != "running" and time.time() < deadline:
        time.sleep(0.5)
    print("就绪 state:", mgr.state, "| page:", mgr.page)

    try:
        with urllib.request.urlopen("http://127.0.0.1:8899/health", timeout=2) as r:
            print("health:", json.loads(r.read().decode()))
    except Exception as e:
        print("health 错误:", e)

    print("受控 Chrome 进程数:", chrome_pipe_count())

    mgr.stop()
    print("stop 后 state:", mgr.state)
    print("backend_proc 清理:", mgr.backend_proc is None)
    print("http_proc 清理:", mgr.http_proc is None)
    time.sleep(1)
    print("受控 Chrome 进程数(停止后):", chrome_pipe_count())

    print("=== 日志 ===")
    for l in logs:
        print("  ", l)


if __name__ == "__main__":
    main()
