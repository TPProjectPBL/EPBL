#!/usr/bin/env python3
"""隔空控制器 · 控制小窗（macOS 原生 AppKit）

用 pyobjc/AppKit 实现原生小窗，规避系统 Python Tk 8.5 在 macOS 上无法渲染窗口的问题。
功能：Start（启动后端）/ Stop（停止后端）/ 摄像头开关（经后端广播给前端）。

运行（用 venv 里的 Python）：
    control-backend/.venv/bin/python control-backend/launcher_cocoa.py
"""
from __future__ import annotations

import json
import os
import queue
import sys
import urllib.request
import webbrowser
from pathlib import Path

import Cocoa
import objc

sys.path.insert(0, str(Path(__file__).resolve().parent))

from launcher import BackendManager, BACKEND_URL, FRONT_URL  # noqa: E402


class CocoaPanel(Cocoa.NSObject):
    _log_lines: list[str] = []

    def initWithApp_(self, app):
        self = objc.super(CocoaPanel, self).init()
        if self is None:
            return None
        self.app = app
        self.mgr = BackendManager(on_log=self._queue_log)
        self.log_q: queue.Queue = queue.Queue()
        self.camera_on = False
        self._build_ui()
        Cocoa.NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
            0.5, self, Cocoa.NSSelectorFromString("refresh:"), None, True,
        )
        self.refresh_(None)
        # 自动化/开机自启用：AC_AUTOSTART=1 时窗口出现后自动 Start
        if os.environ.get("AC_AUTOSTART") == "1":
            Cocoa.NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
                1.0, self, Cocoa.NSSelectorFromString("autostart:"), None, False,
            )
        return self

    # ---------- 构造 UI ----------
    def _build_ui(self):
        self.window = Cocoa.NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            Cocoa.NSMakeRect(300, 300, 340, 300),
            Cocoa.NSTitledWindowMask | Cocoa.NSClosableWindowMask | Cocoa.NSMiniaturizableWindowMask,
            Cocoa.NSBackingStoreBuffered,
            False,
        )
        self.window.setTitle_("隔空控制器 · 控制小窗")
        self.window.setReleasedWhenClosed_(False)
        self.window.setDelegate_(self)

        cv = self.window.contentView()

        title = Cocoa.NSTextField.labelWithString_("隔空控制器")
        title.setFrame_(Cocoa.NSMakeRect(16, 258, 300, 26))
        title.setFont_(Cocoa.NSFont.boldSystemFontOfSize_(18))
        cv.addSubview_(title)

        self.status_lbl = Cocoa.NSTextField.labelWithString_("已停止")
        self.status_lbl.setFrame_(Cocoa.NSMakeRect(16, 220, 308, 30))
        self.status_lbl.setFont_(Cocoa.NSFont.systemFontOfSize_(13))
        self.status_lbl.setTextColor_(Cocoa.NSColor.labelColor())
        cv.addSubview_(self.status_lbl)

        self.btn_start = self._make_button("Start", "start:", Cocoa.NSMakeRect(16, 160, 96, 40))
        self.btn_stop = self._make_button("Stop", "stop:", Cocoa.NSMakeRect(122, 160, 96, 40))
        self.btn_front = self._make_button("前端", "openFront:", Cocoa.NSMakeRect(228, 160, 96, 40))
        cv.addSubview_(self.btn_start)
        cv.addSubview_(self.btn_stop)
        cv.addSubview_(self.btn_front)

        self.btn_cam = self._make_button("摄像头：关", "toggleCamera:", Cocoa.NSMakeRect(16, 108, 308, 40))
        cv.addSubview_(self.btn_cam)

        log_title = Cocoa.NSTextField.labelWithString_("日志")
        log_title.setFrame_(Cocoa.NSMakeRect(16, 84, 300, 16))
        log_title.setFont_(Cocoa.NSFont.systemFontOfSize_(11))
        cv.addSubview_(log_title)

        self.log_lbl = Cocoa.NSTextField.labelWithString_("")
        self.log_lbl.setFrame_(Cocoa.NSMakeRect(16, 8, 308, 72))
        self.log_lbl.setFont_(Cocoa.NSFont.fontWithName_size_("Menlo", 10.0))
        self.log_lbl.setTextColor_(Cocoa.NSColor.secondaryLabelColor())
        self.log_lbl.setLineBreakMode_(Cocoa.NSLineBreakByTruncatingTail)
        cv.addSubview_(self.log_lbl)

        self.window.makeKeyAndOrderFront_(None)

    def _make_button(self, title, action, frame):
        btn = Cocoa.NSButton.alloc().initWithFrame_(frame)
        btn.setTitle_(title)
        btn.setTarget_(self)
        btn.setAction_(Cocoa.NSSelectorFromString(action))
        btn.setBezelStyle_(Cocoa.NSBezelStyleRounded)
        return btn

    # ---------- 日志 ----------
    def _queue_log(self, msg):
        self.log_q.put(msg)

    def _drain_logs(self):
        lines = []
        while True:
            try:
                lines.append(self.log_q.get_nowait())
            except queue.Empty:
                break
        return lines

    def _append_log(self, line):
        type(self)._log_lines.append(line)
        if len(type(self)._log_lines) > 4:
            type(self)._log_lines = type(self)._log_lines[-4:]
        self.log_lbl.setStringValue_("\n".join(type(self)._log_lines))

    # ---------- 动作 ----------
    def start_(self, sender):
        self.mgr.start()
        self.refresh_(None)

    def autostart_(self, timer):
        self._queue_log("AC_AUTOSTART=1：自动启动服务")
        self.mgr.start()
        self.refresh_(None)

    def stop_(self, sender):
        self.mgr.stop()
        self.refresh_(None)

    def openFront_(self, sender):
        if self.mgr.http_proc is None or self.mgr.http_proc.poll() is not None:
            self._queue_log("静态服务未运行，请先 Start")
            return
        webbrowser.open(FRONT_URL)
        self._queue_log("已打开前端")

    def toggleCamera_(self, sender):
        self.camera_on = not self.camera_on
        state = "on" if self.camera_on else "off"
        try:
            with urllib.request.urlopen(f"{BACKEND_URL}/camera?state={state}", timeout=2) as r:
                data = json.loads(r.read().decode("utf-8"))
            self._queue_log(f"摄像头指令：{state}（前端 {data.get('connections', 0)} 个）")
        except Exception as e:
            self._queue_log(f"下发失败（后端未运行？）：{e}")
            self.camera_on = not self.camera_on
        self.refresh_(None)

    # ---------- 刷新 ----------
    def refresh_(self, timer):
        for line in self._drain_logs():
            self._append_log(line)
        state = self.mgr.state
        labels = {"stopped": "已停止", "starting": "启动中…", "running": "运行中", "stopping": "终止中…"}
        text = labels.get(state, state)
        if state in ("running", "starting"):
            text += f" · 页面 {self.mgr.page or '加载中…'}"
        self.status_lbl.setStringValue_(text)
        self.btn_start.setEnabled_(state == "stopped")
        self.btn_stop.setEnabled_(state in ("running", "starting"))
        self.btn_cam.setEnabled_(state in ("running", "starting"))
        self.btn_cam.setTitle_("摄像头：开" if self.camera_on else "摄像头：关")

    # ---------- 窗口关闭 ----------
    def windowWillClose_(self, notification):
        for p in (self.mgr.backend_proc, self.mgr.http_proc):
            if p and p.poll() is None:
                try:
                    p.terminate()
                except Exception:
                    pass
        self.app.terminate_(None)


def main():
    app = Cocoa.NSApplication.sharedApplication()
    app.setActivationPolicy_(Cocoa.NSApplicationActivationPolicyRegular)
    CocoaPanel.alloc().initWithApp_(app)
    app.activateIgnoringOtherApps_(True)
    app.run()


if __name__ == "__main__":
    main()
