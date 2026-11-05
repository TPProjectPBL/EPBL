# 手势切水果（最小版）

Python + OpenCV + MediaPipe Hands，用**食指指尖**切掉往下掉的圆形水果。

## 依赖

```bash
python3 -m pip install --user mediapipe opencv-python
```

本机已装：`mediapipe 1.2.0`、`opencv 5.0.0`、`numpy 2.0.2`（Python 3.9.6 / macOS arm64）。

> 注意：mediapipe 1.x **删除了旧的 `mp.solutions.hands`**，所以本 demo 用的是 Tasks API
> （`mediapipe.tasks.python.vision.HandLandmarker`）。网上大量老教程的 `mp.solutions` 写法在这个版本会直接报
> `AttributeError: module 'mediapipe' has no attribute 'solutions'`。

## 运行

```bash
cd ~/Desktop/project/outputs/fruit-slice
./run.sh                             # 推荐：自动 cd + 用对的解释器
```

等价写法：

```bash
/usr/bin/python3 main.py             # 默认摄像头 0，640x480
/usr/bin/python3 main.py --camera 1  # 换摄像头
/usr/bin/python3 main.py --selftest  # 不开摄像头，自检模型 + 碰撞/计分逻辑
```

> **⚠️ 别直接敲 `python3 main.py`**：本机 shell 里的 `python3` 指向 **Python 3.14**，
> 而 mediapipe / opencv 装在 **Python 3.9**（`/usr/bin/python3`）。
> 用错会报 `ModuleNotFoundError: No module named 'cv2'`。
> 想彻底解决可在 3.14 里装一遍（`...3.14/bin/python3 -m pip install mediapipe`，约 150MB，
> 但会升级全局 numpy/opencv，可能影响其他项目，故默认不做）。

按键 **q** 或 **ESC** 退出。

首次运行时若 `models/hand_landmarker.task` 缺失，脚本会自动下载（约 7.8MB）。

## 玩法

- 画面上方每 20 帧随机生成一个水果（半径 18–34px，下落速度 4–9 像素/帧）
- 水果自动下落，掉出画面底部即移除
- 食指指尖（关键点 8）碰到水果 → 水果消失，分数 +1
- 画面左右翻转成照镜子效果：手往右，指尖也往右

## 实现要点

| 需求 | 做法 |
|---|---|
| 识别食指指尖 | MediaPipe 关键点 `8`，归一化坐标 × 画面尺寸 |
| 上方随机生成、自动下落 | `Game.spawn()` 每 20 帧一次，`Game.update()` 每帧 `y += vy` |
| 碰到即消失、+1 | `Game.check_hit()` 圆-圆相交：`圆心距 ≤ 水果半径 + 指尖半径` |
| 无轨迹/炸弹/防抖 | 故意没写 |

## 文件

- `main.py` —— 全部代码（单文件，中文注释）
- `models/hand_landmarker.task` —— MediaPipe 官方手部关键点模型（7.8MB）
  **未纳入仓库**（模型权重按课程要求不入库），首次运行会自动下载到该路径；也可手动放置。

## 常见问题

- **打不开摄像头**：macOS 会弹权限申请，需允许「终端 / Python」使用摄像头；或摄像头被微信、腾讯会议占用。
- **中文没显示**：`cv2.putText` 自带字体只支持 ASCII，所以 HUD 用英文。要中文可用 PIL 绘制。
- **没有检测到手**：光线不足或手离镜头太远；`num_hands=1`，两只手同时出现只取第一只。

## 已知限制与未验证项

代码里有明确依据的限制（不是猜测）：

| 限制 | 依据 | 影响 |
|---|---|---|
| 只识别 1 只手 | `num_hands=1` | 两只手同时出现只取第一只，另一只的指尖不参与判定 |
| 指尖按单点圆判定，无轨迹插值 | `TIP_RADIUS=20`，`check_hit()` 只做圆-圆相交 | 手快速挥动时，相邻两帧的指尖可能直接跨过水果而不触发；帧率越低越明显 |
| 生成节奏绑定帧数 | `SPAWN_EVERY_FRAMES=20` 按帧计数 | 掉帧时水果生成变慢、下落变慢，游戏节奏随帧率漂移 |
| 同屏上限 6 个 | `MAX_FRUITS=6` | 达到上限后不再生成，难度上限被锁死 |
| 有意不做轨迹 / 炸弹 / 防抖 | 见上文「实现要点」 | 属最小版范围，不是缺陷 |
| 依赖 Python 3.9 的 mediapipe | mediapipe 1.x 删除了 `mp.solutions` | 用 3.14 的 `python3` 会报 `ModuleNotFoundError: No module named 'cv2'` |

**未验证（需要真机数据；开发机没有摄像头）**：

- 真人指尖碰撞的成功率 / 误判率没有统计；
- 不同光照、肤色、手离镜头距离下 MediaPipe 关键点的稳定性没测；
- 640×480 下 `TIP_RADIUS=20` 是否合适（偏大易误判、偏小难切中）没做过调参对比。
