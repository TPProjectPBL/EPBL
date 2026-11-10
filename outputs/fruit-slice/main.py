#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
手势切水果（最小版）
====================

Python + OpenCV + MediaPipe Hands。

玩法
----
摄像头画面里伸出食指，指尖碰到往下掉的圆形水果，水果消失、分数 + 1。

需求对应
--------
1. 识别食指指尖坐标       -> MediaPipe 手部关键点 8（食指指尖）
2. 上方随机生成、自动下落 -> Game.spawn() / Game.update()
3. 指尖碰到即消失、+1     -> Game.check_hit()
4. 无轨迹 / 无炸弹 / 无防抖 -> 故意都没写，只保留最小玩法

运行
----
    python3 main.py                 # 默认摄像头 0，640x480
    python3 main.py --camera 1      # 换一个摄像头
    python3 main.py --selftest      # 不开摄像头：自检模型加载 + 碰撞/计分逻辑

按键：q 或 ESC 退出。

说明
----
* 屏幕上的文字用英文，因为 cv2.putText 自带字体不支持中文（中文只写在注释里）。
* 首次运行若缺少模型文件，会自动下载 MediaPipe 官方 hand_landmarker.task 到 models/。
"""

import argparse
import os
import random
import sys
import time
import urllib.request

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

# ---------------------------------------------------------------- 常量配置

INDEX_FINGER_TIP = 8        # MediaPipe 手部关键点编号：8 = 食指指尖
TIP_RADIUS = 20             # 指尖判定半径（像素），指头是个圆，不是点
FRUIT_MIN_R = 18            # 水果最小半径
FRUIT_MAX_R = 34            # 水果最大半径
SPAWN_EVERY_FRAMES = 20     # 每多少帧生成一个水果
MAX_FRUITS = 6              # 同屏水果上限，避免越堆越多
FRUIT_COLORS = [            # 水果颜色（BGR）
    (60, 60, 230),          # 红
    (80, 200, 250),         # 黄
    (90, 200, 90),          # 绿
    (220, 140, 60),         # 橙
]

MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
    "hand_landmarker/float16/1/hand_landmarker.task"
)
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "models", "hand_landmarker.task")


# ---------------------------------------------------------------- 游戏逻辑

class Fruit:
    """一个往下掉的水果。只有位置/半径/速度/颜色四件事。"""

    __slots__ = ("x", "y", "r", "vy", "color")

    def __init__(self, x, y, r, vy, color):
        self.x = x
        self.y = y
        self.r = r
        self.vy = vy
        self.color = color


class Game:
    """只管水果的生成、下落、碰撞、计分，不碰摄像头也不碰 MediaPipe。"""

    def __init__(self, width, height):
        self.w = width
        self.h = height
        self.fruits = []
        self.score = 0
        self.frame_count = 0

    def spawn(self):
        """在画面顶部上方随机生成一个水果（y 为负，刚好在屏幕外）。"""
        if len(self.fruits) >= MAX_FRUITS:
            return
        r = random.randint(FRUIT_MIN_R, FRUIT_MAX_R)
        # x 随机，但要保证整个圆都在画面内
        x = random.randint(r + 10, self.w - r - 10)
        y = -r                      # 从上方掉进来
        vy = random.uniform(4.0, 9.0)   # 下落速度（像素/帧）
        self.fruits.append(Fruit(x, y, r, vy, random.choice(FRUIT_COLORS)))

    def update(self):
        """每帧调用：生成 + 下落 + 掉出屏幕的删掉。"""
        self.frame_count += 1
        if self.frame_count % SPAWN_EVERY_FRAMES == 0:
            self.spawn()

        alive = []
        for f in self.fruits:
            f.y += f.vy
            # 整个圆完全掉出画面底部才移除
            if f.y - f.r <= self.h:
                alive.append(f)
        self.fruits = alive

    def check_hit(self, tip_x, tip_y, tip_r=TIP_RADIUS):
        """指尖与水果做圆-圆相交判定；碰到就删掉并 +1。返回本帧切中个数。"""
        if tip_x is None:
            return 0
        remain = []
        popped = 0
        for f in self.fruits:
            # 两圆圆心距 <= 两半径之和 => 相交
            dx = f.x - tip_x
            dy = f.y - tip_y
            if dx * dx + dy * dy <= (f.r + tip_r) ** 2:
                popped += 1
            else:
                remain.append(f)
        self.fruits = remain
        self.score += popped
        return popped

    def draw(self, frame, tip_x=None, tip_y=None):
        """把水果、指尖、分数画到画面上。"""
        for f in self.fruits:
            cv2.circle(frame, (int(f.x), int(f.y)), f.r, f.color, -1)
            # 描一圈白边，深色背景下也看得清
            cv2.circle(frame, (int(f.x), int(f.y)), f.r, (255, 255, 255), 2)

        # 指尖
        if tip_x is not None:
            cv2.circle(frame, (int(tip_x), int(tip_y)), TIP_RADIUS,
                       (0, 255, 255), 2)

        # 分数
        cv2.putText(frame, f"Score: {self.score}", (20, 50),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 255, 0), 3)
        # 操作提示
        cv2.putText(frame, "Point your index finger. Q / ESC to quit",
                    (20, self.h - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                    (200, 200, 200), 1)


# ---------------------------------------------------------------- 模型加载

def ensure_model(path=MODEL_PATH):
    """模型文件不存在就下载一次（约 7.8MB）。"""
    if os.path.exists(path):
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    print(f"未找到模型，正在下载到 {path} ...")
    urllib.request.urlretrieve(MODEL_URL, path)
    print("模型下载完成。")
    return path


def build_landmarker(model_path=MODEL_PATH):
    """构造 HandLandmarker：视频流模式，只追一只手。"""
    options = vision.HandLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=model_path),
        running_mode=vision.RunningMode.VIDEO,   # 摄像头是连续视频流
        num_hands=1,
        min_hand_detection_confidence=0.5,
        min_hand_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    return vision.HandLandmarker.create_from_options(options)


def fingertip_of(result, width, height):
    """从检测结果里取食指指尖的像素坐标；没检测到手就返回 (None, None)。"""
    if not result.hand_landmarks:
        return None, None
    lm = result.hand_landmarks[0][INDEX_FINGER_TIP]
    # 关键点坐标是 0~1 的归一化值，乘上画面尺寸得到像素坐标
    return lm.x * width, lm.y * height


# ---------------------------------------------------------------- 主循环

def run(camera_index=0, width=640, height=480):
    model_path = ensure_model()
    landmarker = build_landmarker(model_path)

    cap = cv2.VideoCapture(camera_index)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    if not cap.isOpened():
        print(f"打不开摄像头 {camera_index}。检查是否被其他程序占用，"
              f"或用 --camera 换一个编号。")
        landmarker.close()
        return 1

    game = Game(width, height)
    t_start = time.monotonic()     # 视频模式要求时间戳单调递增
    last_ts = 0

    print("开始。伸出食指切水果，按 q 或 ESC 退出。")
    while True:
        ok, frame = cap.read()
        if not ok:
            print("读帧失败，退出。")
            break

        # 左右翻转，做成照镜子的效果：手往右，画面里的指尖也往右
        frame = cv2.flip(frame, 1)

        # MediaPipe 要 RGB，OpenCV 给的是 BGR
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)

        # 时间戳必须严格递增，否则 VIDEO 模式会报错
        ts = int((time.monotonic() - t_start) * 1000)
        ts = max(ts, last_ts + 1)
        last_ts = ts

        result = landmarker.detect_for_video(mp_image, ts)
        tip_x, tip_y = fingertip_of(result, frame.shape[1], frame.shape[0])

        # 先更新水果位置，再判碰撞（顺序无所谓，但这样手感更跟手）
        game.update()
        game.check_hit(tip_x, tip_y)
        game.draw(frame, tip_x, tip_y)

        cv2.imshow("Fruit Slice - Index Finger", frame)
        key = cv2.waitKey(1) & 0xFF
        if key in (ord("q"), 27):      # q 或 ESC
            break

    cap.release()
    cv2.destroyAllWindows()
    landmarker.close()
    print(f"结束，最终分数：{game.score}")
    return 0


# ---------------------------------------------------------------- 自检

def selftest():
    """不开摄像头，验证：模型能加载并推理、碰撞与计分逻辑正确。"""
    print("== 自检 ==")
    fails = 0

    def check(name, cond, extra=""):
        nonlocal fails
        print(f"  [{'PASS' if cond else 'FAIL'}] {name} {extra}")
        if not cond:
            fails += 1

    # 1. 模型加载 + 空画面推理（验证整条 MediaPipe 链路可用）
    model_path = ensure_model()
    check("模型文件存在", os.path.exists(model_path),
          f"({os.path.getsize(model_path)} 字节)")
    landmarker = build_landmarker(model_path)
    blank = np.zeros((480, 640, 3), dtype=np.uint8)
    result = landmarker.detect_for_video(
        mp.Image(image_format=mp.ImageFormat.SRGB,
                 data=cv2.cvtColor(blank, cv2.COLOR_BGR2RGB)), 0)
    check("空画面推理不报错且无手", len(result.hand_landmarks) == 0)
    landmarker.close()

    # 2. 生成与下落
    random.seed(0)
    g = Game(640, 480)
    for _ in range(100):        # 100 帧
        g.update()
    check("会生成水果", len(g.fruits) > 0, f"({len(g.fruits)} 个)")
    check("水果在画面内", all(f.r + 10 <= f.x <= 640 - f.r - 10 for f in g.fruits))

    # 3. 命中：指尖正好在水果中心
    g = Game(640, 480)
    g.fruits = [Fruit(320, 300, 30, 0, (0, 0, 255))]
    popped = g.check_hit(320, 300, TIP_RADIUS)
    check("指尖在水果中心 -> 命中", popped == 1 and g.score == 1
          and len(g.fruits) == 0, f"(score={g.score})")

    # 4. 擦边也算命中：距离 = 半径和
    g = Game(640, 480)
    g.fruits = [Fruit(320, 300, 30, 0, (0, 0, 255))]
    g.check_hit(320 + 30 + TIP_RADIUS, 300, TIP_RADIUS)   # 正好相切
    check("相切也算命中（圆-圆相交）", g.score == 1, f"(score={g.score})")

    # 5. 没碰到不误判
    g = Game(640, 480)
    g.fruits = [Fruit(320, 300, 30, 0, (0, 0, 255))]
    g.check_hit(320 + 30 + TIP_RADIUS + 5, 300, TIP_RADIUS)
    check("差 5 像素不命中", g.score == 0, f"(score={g.score})")

    # 6. 没检测到手时不崩
    g = Game(640, 480)
    g.fruits = [Fruit(320, 300, 30, 0, (0, 0, 255))]
    g.check_hit(None, None)
    check("没手时不误伤", g.score == 0 and len(g.fruits) == 1)

    # 7. 掉出屏幕会被清掉
    g = Game(640, 480)
    g.fruits = [Fruit(320, 600, 30, 10, (0, 0, 255))]   # 已在画面下方外
    g.update()
    check("掉出屏幕的删掉", len(g.fruits) == 0)

    # 8. 同屏上限
    g = Game(640, 480)
    for _ in range(MAX_FRUITS + 5):
        g.spawn()
    check(f"同屏不超过 {MAX_FRUITS} 个", len(g.fruits) == MAX_FRUITS,
          f"({len(g.fruits)} 个)")

    print(f"== 结果：{'全部通过' if fails == 0 else str(fails) + ' 项失败'} ==")
    return 0 if fails == 0 else 1


# ---------------------------------------------------------------- 入口

def main():
    p = argparse.ArgumentParser(description="手势切水果（OpenCV + MediaPipe Hands）")
    p.add_argument("--camera", type=int, default=0, help="摄像头编号，默认 0")
    p.add_argument("--width", type=int, default=640, help="画面宽，默认 640")
    p.add_argument("--height", type=int, default=480, help="画面高，默认 480")
    p.add_argument("--selftest", action="store_true",
                   help="不开摄像头，自检模型与游戏逻辑")
    args = p.parse_args()

    if args.selftest:
        return selftest()
    return run(args.camera, args.width, args.height)


if __name__ == "__main__":
    sys.exit(main())
