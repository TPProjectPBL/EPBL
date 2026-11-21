"""Run the GazeFollower draw page with the gazefollower==1.1.0 package."""

import argparse
import json
import threading
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

import cv2
import numpy as np
from gazefollower.calibration import MultivariateRidgeCalibration
from gazefollower.face_alignment import MediaPipeFaceAlignment
from gazefollower.gaze_estimator import MGazeNetGazeEstimator


DRAW_DIR = Path(__file__).resolve().parent
PAGE = "/index-3-hand-gazefollower.html"
FEATURE_COUNT = 258
POINT_COUNT = 9


def fit_calibration(payload):
    features = np.asarray(payload["features"], dtype=np.float32)
    targets = np.asarray(payload["targets"], dtype=np.float32)
    if (
        features.shape != (POINT_COUNT, FEATURE_COUNT)
        or targets.shape != (POINT_COUNT, 2)
        or not np.isfinite(features).all()
        or not np.isfinite(targets).all()
        or np.any((targets < 0) | (targets > 1))
    ):
        raise ValueError("Invalid calibration samples")

    model = MultivariateRidgeCalibration()
    calibrated, _, _ = model.calibrate(features, targets)
    if not calibrated or not np.isfinite(model.weights).all():
        raise ValueError("Calibration could not be fitted")
    return model.weights.tolist()


class GazeHandler(SimpleHTTPRequestHandler):
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
        if urlsplit(self.path).path == "/gaze/health":
            self.send_json({"model": "GazeFollower"})
        else:
            super().do_GET()

    def send_head(self):
        path = unquote(urlsplit(self.path).path)
        if path == "/":
            self.path = PAGE
        elif path not in (PAGE, "/models/gesture_recognizer.task") and not (
            path.startswith("/vendor/vision/") and ".." not in path.split("/")
        ):
            self.send_error(HTTPStatus.NOT_FOUND)
            return None
        return super().send_head()

    def do_POST(self):
        port = self.server.server_port
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        host = self.headers.get("Host")
        origin = self.headers.get("Origin")
        if host not in hosts or (origin is not None and origin != f"http://{host}"):
            self.send_error(HTTPStatus.FORBIDDEN)
            return

        path = urlsplit(self.path).path
        if path not in ("/gaze/features", "/gaze/calibrate"):
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 512 * 1024:
                raise ValueError("Invalid request size")
            body = self.rfile.read(length)
            if path == "/gaze/calibrate":
                result = {"weights": fit_calibration(json.loads(body))}
            else:
                frame = cv2.imdecode(np.frombuffer(body, dtype=np.uint8), cv2.IMREAD_COLOR)
                if frame is None:
                    raise ValueError("Invalid camera frame")
                with self.server.inference_lock:
                    face = self.server.alignment.detect(time.monotonic_ns(), frame)
                    gaze = self.server.estimator.detect(frame, face)
                features = gaze.features if gaze.status else None
                if features is not None and (
                    features.shape != (FEATURE_COUNT,) or not np.isfinite(features).all()
                ):
                    raise ValueError("Invalid GazeFollower features")
                result = {"features": features.tolist() if features is not None else None}
        except (KeyError, TypeError, ValueError, OverflowError, cv2.error) as error:
            self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        else:
            self.send_json(result)

    def log_request(self, code="-", size="-"):
        if urlsplit(self.path).path != "/gaze/features" or code != HTTPStatus.OK:
            super().log_request(code, size)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8789)
    parser.add_argument("--model", help="Optional path to alternate GazeFollower .mnn weights")
    args = parser.parse_args()

    with ThreadingHTTPServer(("127.0.0.1", args.port), GazeHandler) as server:
        # ponytail: serialize model access on this local drawing server.
        server.inference_lock = threading.Lock()
        server.alignment = MediaPipeFaceAlignment(enable_filter=False)
        server.estimator = MGazeNetGazeEstimator(model_path=args.model or "")
        print(f"GazeFollower 画板：http://127.0.0.1:{server.server_port}{PAGE}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
