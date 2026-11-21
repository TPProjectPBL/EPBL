"""Standalone scoring page server.

Serves gazefollower-score.html on :8791 and proxies /gaze/* to the existing
GazeFollower backend on :8789. It never imports or modifies her server file;
the GazeFollower model keeps running in her own process.
"""

import argparse
import json
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

DRAW_DIR = Path(__file__).resolve().parent
UPSTREAM = "http://127.0.0.1:8789"
ALLOWED = ("/gaze/features", "/gaze/calibrate", "/gaze/health")


class ScoreHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DRAW_DIR), **kwargs)

    def send_json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/health":
            try:
                with urllib.request.urlopen(UPSTREAM + "/gaze/health", timeout=3) as res:
                    upstream = json.loads(res.read().decode())
                self.send_json({"scorePage": "ready", "upstream": upstream})
            except (urllib.error.URLError, TimeoutError, ValueError) as error:
                self.send_json(
                    {"scorePage": "ready", "upstream": None, "error": str(error)},
                    HTTPStatus.SERVICE_UNAVAILABLE,
                )
            return
        if path in ("/", "/gazefollower-score.html"):
            self.path = "/gazefollower-score.html"
        super().do_GET()

    def send_head(self):
        path = unquote_path(self.path)
        if path not in ("/gazefollower-score.html",):
            self.send_error(HTTPStatus.NOT_FOUND)
            return None
        return super().send_head()

    def do_POST(self):
        path = urlsplit(self.path).path
        port = self.server.server_port
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if self.headers.get("Host") not in hosts:
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        if path not in ALLOWED or path == "/gaze/health":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 512 * 1024:
                raise ValueError("Invalid request size")
            body = self.rfile.read(length)
            request = urllib.request.Request(
                UPSTREAM + path,
                data=body,
                method="POST",
                headers={"Content-Type": self.headers.get("Content-Type", "application/octet-stream")},
            )
            with urllib.request.urlopen(request, timeout=15) as response:
                payload = response.read()
                status = HTTPStatus.OK
        except urllib.error.HTTPError as error:
            payload = error.read()
            status = HTTPStatus(error.code)
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as error:
            self.send_json({"error": f"上游 8789 不可用：{error}"}, HTTPStatus.BAD_GATEWAY)
            return
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def log_request(self, code="-", size="-"):
        if urlsplit(self.path).path == "/gaze/features" and code == HTTPStatus.OK:
            return
        super().log_request(code, size)


def unquote_path(raw):
    from urllib.parse import unquote
    return unquote(urlsplit(raw).path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8791)
    args = parser.parse_args()
    with ThreadingHTTPServer(("127.0.0.1", args.port), ScoreHandler) as server:
        print(f"GazeFollower 评分页：http://127.0.0.1:{args.port}/", flush=True)
        print(f"后端代理目标：{UPSTREAM}（她的 8789 服务保持不变）", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
