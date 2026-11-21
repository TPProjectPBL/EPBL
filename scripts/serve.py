#!/usr/bin/env python3
"""静态服务器（工作台 / 演示页专用）。

`python3 -m http.server` 不带 Cache-Control，Chrome 会按 Last-Modified 做启发式缓存：
改了 overlay.js / gaze-host.js 之后刷新页面，很容易出现「新的宿主 + 旧的模块」混版，
表现为莫名其妙的 `xxx is not a function`。

这里补三个头：no-store / no-cache / Expires: 0，并把 .js .mjs .wasm 的 MIME 固定下来。

    python3 scripts/serve.py 8125 .
"""
import functools
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".wasm": "application/wasm",
        ".webmanifest": "application/manifest+json",
        ".jpg": "image/jpeg",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8125
    directory = sys.argv[2] if len(sys.argv) > 2 else "."
    handler = functools.partial(Handler, directory=directory)
    ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()


if __name__ == "__main__":
    main()
