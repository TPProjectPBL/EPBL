#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GazeFollower (MGazeNet) 本地视线推理网关。

浏览器通过 WebSocket 推送 JPEG 帧，本进程完成
人脸对齐 -> MGazeNet 推理 -> 岭回归标定 -> OneEuro 滤波，
回传归一化视线坐标。模型与标定全部在本机，不外发任何图像。

启动：
    python server.py            # 默认 127.0.0.1:8901（仅本机）
    GAZE_PORT=8901 python server.py
"""

import asyncio
import base64
import json
import os
import time
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from gazefollower.calibration import MultivariateRidgeCalibration
from gazefollower.face_alignment import MediaPipeFaceAlignment
from gazefollower.gaze_estimator import MGazeNetGazeEstimator
from gazefollower.misc import OneEuroFilter

SCREEN_W = int(os.environ.get("GAZE_SCREEN_W", "1920"))
SCREEN_H = int(os.environ.get("GAZE_SCREEN_H", "1080"))
PORT = int(os.environ.get("GAZE_PORT", "8901"))
MAX_POINT_FRAMES = 90

app = FastAPI(title="GazeFollower Gateway")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# 模型加载一次，进程内复用
aligner = MediaPipeFaceAlignment()
estimator = MGazeNetGazeEstimator()

_active: Optional["Session"] = None
_stats: List[float] = []


def _px_error(pred_xy, label_xy) -> float:
    dx = (float(pred_xy[0]) - float(label_xy[0])) * SCREEN_W
    dy = (float(pred_xy[1]) - float(label_xy[1])) * SCREEN_H
    return float((dx * dx + dy * dy) ** 0.5)


class Session:
    """单个浏览器连接的推理与标定状态。"""

    def __init__(self) -> None:
        self.calib = MultivariateRidgeCalibration(alpha=0.1)
        self.filter = OneEuroFilter(freq=30.0, min_cutoff=1.0, beta=0.01, d_cutoff=1.0)
        self.collecting = False
        self.buffer: List[np.ndarray] = []
        self.samples: List[Tuple[np.ndarray, Tuple[float, float]]] = []
        self.fitted = False
        self.frames = 0
        self.lost = 0

    def begin_point(self) -> None:
        self.collecting = True
        self.buffer = []

    def commit_point(self, x: float, y: float) -> int:
        """把当前点采集到的特征全部作为该点的标定样本。"""
        self.collecting = False
        frames = self.buffer[-MAX_POINT_FRAMES:]
        for feat in frames:
            self.samples.append((feat, (x, y)))
        n = len(frames)
        self.buffer = []
        return n

    def fit(self) -> Dict:
        if len(self.samples) < 16:
            return {"ok": False, "msg": f"样本不足：{len(self.samples)}，至少需要 16"}
        X = np.stack([s[0] for s in self.samples]).astype(np.float32)
        Y = np.array([s[1] for s in self.samples], dtype=np.float32)
        ok, _, pred = self.calib.calibrate(X, Y)
        if not ok or pred is None:
            self.fitted = False
            return {"ok": False, "msg": "标定训练失败"}
        errs = [_px_error(p, y) for p, y in zip(pred, Y)]
        self.fitted = True
        self.filter.reset()
        return {
            "ok": True,
            "samples": int(X.shape[0]),
            "dim": int(X.shape[1]),
            "err_mean_px": round(float(np.mean(errs)), 1),
            "err_p90_px": round(float(np.percentile(errs, 90)), 1),
        }

    def reset(self) -> None:
        self.calib = MultivariateRidgeCalibration(alpha=0.1)
        self.filter.reset()
        self.collecting = False
        self.buffer = []
        self.samples = []
        self.fitted = False

    def predict(self, feat: np.ndarray, raw, ts: float):
        if self.fitted:
            ok, coord = self.calib.predict(feat, raw)
            if ok:
                nx, ny = float(coord[0]), float(coord[1])
                f = self.filter.filter(np.array([nx, ny], dtype=np.float64), ts)
                return True, float(f[0]), float(f[1])
        return False, float(raw[0]), float(raw[1])


@app.get("/health")
async def health():
    return {
        "ok": True,
        "model": "GazeFollower/MGazeNet",
        "screen": [SCREEN_W, SCREEN_H],
        "busy": _active is not None,
        "fps": round(_fps(), 1),
    }


def _fps() -> float:
    if len(_stats) < 3:
        return 0.0
    avg = sum(_stats[-60:]) / len(_stats[-60:])
    return 1000.0 / avg if avg > 0 else 0.0


@app.websocket("/ws")
async def gaze_ws(websocket: WebSocket):
    global _active
    await websocket.accept()
    if _active is not None:
        await websocket.send_json({"type": "error", "msg": "已有连接占用推理服务"})
        await websocket.close(code=1008)
        return

    session = Session()
    _active = session
    await websocket.send_json(
        {
            "type": "ready",
            "model": "GazeFollower/MGazeNet",
            "dim": 258,
            "screen": [SCREEN_W, SCREEN_H],
        }
    )
    try:
        while True:
            raw_msg = await websocket.receive_text()
            try:
                msg = json.loads(raw_msg)
            except Exception:
                await websocket.send_json({"type": "error", "msg": "invalid json"})
                continue

            kind = msg.get("type")

            if kind == "frame":
                t0 = time.time()
                try:
                    buf = np.frombuffer(base64.b64decode(msg.get("img", "")), dtype=np.uint8)
                    frame = cv2.imdecode(buf, cv2.IMREAD_COLOR)
                except Exception:
                    await websocket.send_json({"type": "error", "msg": "decode failed"})
                    continue
                if frame is None:
                    await websocket.send_json({"type": "error", "msg": "empty frame"})
                    continue

                ts = time.time()
                face = aligner.detect(int(ts * 1000), frame)
                gaze = estimator.detect(frame, face)
                session.frames += 1

                if not gaze.status or gaze.features is None:
                    session.lost += 1
                    if session.lost == 1:
                        session.filter.reset()
                    await websocket.send_json(
                        {
                            "type": "gaze",
                            "id": msg.get("id"),
                            "face": bool(face.status),
                            "ok": False,
                        }
                    )
                    continue

                session.lost = 0
                feat = np.asarray(gaze.features, dtype=np.float32).reshape(-1)
                if session.collecting:
                    session.buffer.append(feat)

                calibrated, nx, ny = session.predict(feat, gaze.raw_gaze_coordinates, ts)
                cost = (time.time() - t0) * 1000.0
                _stats.append(cost)

                await websocket.send_json(
                    {
                        "type": "gaze",
                        "id": msg.get("id"),
                        "face": True,
                        "ok": True,
                        "calibrated": calibrated,
                        "nx": round(nx, 5),
                        "ny": round(ny, 5),
                        "ms": round(cost, 2),
                    }
                )

            elif kind == "calib_point_begin":
                session.begin_point()
                await websocket.send_json({"type": "point_begin_ack"})

            elif kind == "calib_point":
                n = session.commit_point(float(msg.get("x", 0)), float(msg.get("y", 0)))
                await websocket.send_json(
                    {"type": "point_ack", "n": n, "total": len(session.samples)}
                )

            elif kind == "calib_fit":
                await websocket.send_json({"type": "calibrated", **session.fit()})

            elif kind == "calib_reset":
                session.reset()
                await websocket.send_json({"type": "calibrated", "ok": False, "reset": True})

            elif kind == "ping":
                await websocket.send_json({"type": "pong", "t": msg.get("t")})

            else:
                await websocket.send_json({"type": "error", "msg": f"unknown type {kind}"})

    except WebSocketDisconnect:
        pass
    except Exception as exc:  # 保持服务不因单连接异常退出
        try:
            await websocket.send_json({"type": "error", "msg": f"{type(exc).__name__}: {exc}"})
        except Exception:
            pass
    finally:
        _active = None


if __name__ == "__main__":
    import uvicorn

    print(f"[gaze-gateway] MGazeNet ready, port={PORT}, screen={SCREEN_W}x{SCREEN_H}")
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
