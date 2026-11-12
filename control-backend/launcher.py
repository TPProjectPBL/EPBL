#!/usr/bin/env python3
"""隔空控制器 · 控制小窗（tkinter）

一键启动 / 终止整套控制环境，免去进终端操作：
  - Start：启动静态文件服务（8125）+ 控制后端（8899，自动拉起受控 Chrome）
  - End  ：优雅终止后端（关闭受控 Chrome）并停止静态服务
  - 前端 ：打开控制前端页面

运行（用 venv 里的 Python，已含 fastapi/uvicorn）：
    control-backend/.venv/bin/python control-backend/launcher.py
"""
from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = ROOT / "control-backend"
VENV_PY = BACKEND_DIR / ".venv" / "bin" / "python"

HTTP_PORT = 8125
BACKEND_PORT = 8899
BACKEND_URL = f"http://127.0.0.1:{BACKEND_PORT}"
FRONT_URL = f"http://127.0.0.1:{HTTP_PORT}/control-frontend/index.html"


class BackendManager:
    """进程生命周期管理（无 UI，便于独立测试）。

    state: stopped -> starting -> running -> stopping -> stopped
    """

    def __init__(self, on_log=None, extra_env=None):
        self.http_proc: subprocess.Popen | None = None
        self.backend_proc: subprocess.Popen | None = None
        self.state = "stopped"
        self.page = ""
        self.on_log = on_log
        # 启动后端时额外注入的环境变量（如 AC_HOME，用于指定受控浏览器打开的目标页）。
        self.extra_env: dict = dict(extra_env or {})
        self._stop_evt = threading.Event()
        self._thread: threading.Thread | None = None

    def _log(self, msg: str):
        if self.on_log:
            self.on_log(msg)

    # ---------- 启停 ----------
    def start(self) -> bool:
        if self.state != "stopped":
            return False
        self.state = "starting"
        self._log("正在启动静态文件服务…")
        try:
            self.http_proc = subprocess.Popen(
                # 仅绑定回环地址，避免把工作台/测试页暴露到局域网。
                [sys.executable, "-m", "http.server", str(HTTP_PORT),
                 "--bind", "127.0.0.1"],
                cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        except Exception as e:
            self._log(f"静态服务启动失败：{e}")
            self.state = "stopped"
            return False

        self._log("正在启动控制后端（拉起受控 Chrome）…")
        try:
            env = {**os.environ, **self.extra_env}
            self.backend_proc = subprocess.Popen(
                [str(VENV_PY), "-m", "uvicorn", "app.server:app",
                 "--host", "127.0.0.1", "--port", str(BACKEND_PORT)],
                cwd=str(BACKEND_DIR), env=env,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        except Exception as e:
            self._log(f"后端启动失败：{e}")
            self._terminate(self.http_proc)
            self.http_proc = None
            self.state = "stopped"
            return False

        self._stop_evt.clear()
        self._thread = threading.Thread(target=self._monitor, daemon=True)
        self._thread.start()
        return True

    def stop(self) -> None:
        if self.state not in ("running", "starting"):
            return
        self.state = "stopping"
        self._stop_evt.set()
        self._log("正在优雅终止后端（关闭受控 Chrome）…")
        self._terminate(self.backend_proc, wait=6)
        self.backend_proc = None
        self._terminate(self.http_proc)
        self.http_proc = None
        self.page = ""
        self._log("已全部停止")
        self.state = "stopped"

    # ---------- 监控 ----------
    def _monitor(self):
        while not self._stop_evt.is_set():
            backend_alive = self.backend_proc is not None and self.backend_proc.poll() is None
            if self.state == "starting":
                if backend_alive:
                    h = self._fetch_health()
                    if h and h.get("connected"):
                        self.page = h.get("page", "")
                        self.state = "running"
                        self._log("后端已就绪")
                else:
                    self._log("后端启动失败或已退出")
                    self._terminate(self.http_proc)
                    self.http_proc = None
                    self.state = "stopped"
                    break
            elif self.state == "running":
                if backend_alive:
                    h = self._fetch_health()
                    if h:
                        self.page = h.get("page", "")
                else:
                    self._log("后端已退出")
                    self._terminate(self.http_proc)
                    self.http_proc = None
                    self.page = ""
                    self.state = "stopped"
                    break
            time.sleep(1)

    @staticmethod
    def _fetch_health():
        try:
            with urllib.request.urlopen(f"{BACKEND_URL}/health", timeout=1.5) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception:
            return None

    @staticmethod
    def _terminate(proc: subprocess.Popen | None, wait: float = 2.0):
        if proc is None or proc.poll() is not None:
            return
        proc.terminate()
        try:
            proc.wait(timeout=wait)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=2)


class ControlPanel:
    """tkinter 控制小窗，组合 BackendManager。"""

    def __init__(self, root):
        self.root = root
        self.log_q: queue.Queue = queue.Queue()
        self.mgr = BackendManager(on_log=self._queue_log)
        self._build_ui()
        self.root.after(300, self._refresh)
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

    # ---------- UI ----------
    def _build_ui(self):
        self.root.title("隔空控制器 · 控制小窗")
        self.root.geometry("360x300")
        self.root.minsize(340, 260)
        self.root.configure(bg="#12130f")

        frame = tk.Frame(self.root, bg="#12130f", padx=16, pady=14)
        frame.pack(fill="both", expand=True)

        tk.Label(frame, text="隔空控制器", bg="#12130f", fg="#f5c518",
                 font=("Menlo", 16, "bold"), anchor="w").pack(fill="x")
        tk.Label(frame, text="// 一键启动 / 终止控制后端", bg="#12130f", fg="#6b6449",
                 font=("Menlo", 10), anchor="w").pack(fill="x", pady=(0, 12))

        row = tk.Frame(frame, bg="#12130f")
        row.pack(fill="x")
        self.status_dot = tk.Label(row, text="●", bg="#12130f", fg="#666", font=("Menlo", 13))
        self.status_dot.pack(side="left")
        self.status_lbl = tk.Label(row, text="已停止", bg="#12130f", fg="#a79d72",
                                   font=("Menlo", 12, "bold"))
        self.status_lbl.pack(side="left", padx=(6, 0))

        self.page_lbl = tk.Label(frame, text="后端：未运行", bg="#12130f", fg="#6b6449",
                                 font=("Menlo", 9), anchor="w", wraplength=320)
        self.page_lbl.pack(fill="x", pady=(4, 12))

        btns = tk.Frame(frame, bg="#12130f")
        btns.pack(fill="x", pady=(0, 12))
        self.btn_start = tk.Button(btns, text="Start", command=self.start,
                                   bg="#f5c518", fg="#16160f", activebackground="#ffd94a",
                                   activeforeground="#16160f", font=("Menlo", 12, "bold"),
                                   relief="flat", padx=10, pady=6, cursor="hand2")
        self.btn_start.pack(side="left", fill="x", expand=True)
        self.btn_stop = tk.Button(btns, text="End", command=self.stop,
                                  bg="#2a2a22", fg="#f7f2de", activebackground="#3a3a30",
                                  font=("Menlo", 12, "bold"), relief="flat",
                                  padx=10, pady=6, cursor="hand2", state="disabled")
        self.btn_stop.pack(side="left", fill="x", expand=True, padx=(8, 0))
        self.btn_front = tk.Button(btns, text="前端", command=self.open_front,
                                   bg="#2a2a22", fg="#a79d72", activebackground="#3a3a30",
                                   font=("Menlo", 12), relief="flat",
                                   padx=10, pady=6, cursor="hand2")
        self.btn_front.pack(side="left", fill="x", expand=True, padx=(8, 0))

        tk.Label(frame, text="日志", bg="#12130f", fg="#6b6449",
                 font=("Menlo", 9), anchor="w").pack(fill="x")
        self.logbox = tk.Text(frame, bg="#0b0b07", fg="#a79d72", font=("Menlo", 9),
                              height=6, relief="flat", padx=6, pady=6, state="disabled",
                              wrap="word")
        self.logbox.pack(fill="both", expand=True)

    def _queue_log(self, msg: str):
        self.log_q.put(msg)

    def _log(self, msg: str):
        ts = time.strftime("%H:%M:%S")
        self.logbox.configure(state="normal")
        self.logbox.insert("end", f"{ts}  {msg}\n")
        self.logbox.see("end")
        self.logbox.configure(state="disabled")

    # ---------- 动作 ----------
    def start(self):
        self.mgr.start()
        self._refresh_ui()

    def stop(self):
        self.mgr.stop()
        self._refresh_ui()

    def open_front(self):
        if self.mgr.http_proc is None or self.mgr.http_proc.poll() is not None:
            self._queue_log("静态服务未运行，请先 Start")
            return
        webbrowser.open(FRONT_URL)
        self._queue_log(f"已打开前端：{FRONT_URL}")

    # ---------- 轮询 ----------
    def _refresh(self):
        try:
            while True:
                self._log(self.log_q.get_nowait())
        except queue.Empty:
            pass
        self._refresh_ui()
        self.root.after(300, self._refresh)

    def _refresh_ui(self):
        state = self.mgr.state
        dot_colors = {"stopped": "#666", "starting": "#f5c518",
                      "running": "#4cd964", "stopping": "#f5c518"}
        labels = {"stopped": "已停止", "starting": "启动中…",
                  "running": "运行中", "stopping": "终止中…"}
        self.status_dot.configure(fg=dot_colors.get(state, "#666"))
        self.status_lbl.configure(text=labels.get(state, state))

        self.btn_start.configure(state="normal" if state == "stopped" else "disabled")
        self.btn_stop.configure(state="normal" if state in ("running", "starting") else "disabled")

        if state in ("running", "starting"):
            self.page_lbl.configure(text=f"后端：{BACKEND_PORT}  ·  页面：{self.mgr.page or '加载中…'}")
        else:
            self.page_lbl.configure(text="后端：未运行")

    def _on_close(self):
        if self.mgr.state in ("running", "starting", "stopping"):
            self._log("窗口关闭，正在清理子进程…")
            self.mgr.stop()
        self.root.destroy()


def main():
    import tkinter as tk
    root = tk.Tk()
    ControlPanel(root)
    root.mainloop()


if __name__ == "__main__":
    main()
