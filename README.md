# 隔空控制器（Air Controller）

> 用「眼动 + 手势」实现免接触人机交互 · PBL 项目

**眼动负责「指哪」（当鼠标光标），手势负责「做什么」（当命令）。**

双手被占用、不便接触、行动不便的场景下，只用摄像头即可隔空操控界面。

## 核心方案

- **眼动**：工作台用 MediaPipe Face Landmarker 和共享标定模型。基础控制器用 WebGazer 2.1.2（本地 vendor 和 facemesh 模型），支持 EMA 平滑和按钮磁吸。
- **手势**：MediaPipe Hands / GestureRecognizer 提供 21 个手部关键点。基础控制器和画板各有自己的手势映射。
- **形态**：Web 页面用 HTML/JS，可通过静态服务直接运行。控制后端和独立 GazeFollower 对照画板各有本机服务。

## 基础控制器的手势映射

| 姿态 | 动作 |
|---|---|
| ✊ 握拳 | 确认 |
| 👍 拇指朝上 | 返回 |
| ☝️ 食指 | 主页 |
| ✌️ 二指 | 菜单 |
| 🖐 四指指尖朝上 | 上滚 |
| 🖐 四指指尖朝下 | 下滚 |

`open`（四指伸出、指尖水平）为中立态，只用于验证滚动误触发，不算动作。

工作台画板用拇指朝上打开调色板。展开后，拇指朝上或朝下移动高亮一格，握拳 2 秒确认颜色。拇指朝下在调色板收起时切换画笔和橡皮。完整手势见[交接文档](HANDOFF.md#工作台画板的手势)。

## 目录结构

| 目录 | 说明 |
|---|---|
| `workbench/` | 工作台，共用摄像头和视线标定模型 |
| `dual-test/` | **主测试台**：眼动光标 + 手势控制（标定、眼动/手势/联合点击测试、结果导出） |
| `control-backend/` | 控制后端：FastAPI + Playwright 控制浏览器（含**控制小窗启动器** `launcher.command`） |
| `control-frontend/` | 控制前端：眼动 + 手势采集，经 WebSocket 上报后端 |
| `controller-demo/` | 控制器基础 demo（含 WebGazer / MediaPipe 本地 vendor） |
| `draw/` | 眼动 / 手势绘图 |
| `eye-page-turner/` | 眼动翻页 |
| `gesture-test/` | 手势测试 |
| `outputs/` | 工程蓝图等产物 |
| `EyeControlApp/` | 已废弃的 iOS 原生方向 |

## 快速运行

```bash
# 项目根目录
bash scripts/fetch-gaze-model.sh
python3 scripts/serve.py 8125 .
```

打开 [工作台](http://127.0.0.1:8125/workbench/index.html)，点击「开始 9 点标定」，完成标定和 5 点验证后，从空间导航选择「隔空画板」。向下滑进入画布。

也可打开[独立测试台](http://127.0.0.1:8125/dual-test/?gaze=legacy)进行 WebGazer 对照测试。内网访问需要 HTTPS，本地服务脚本和证书的说明见[交接文档](HANDOFF.md#6-运行方式--服务--url)。

## 控制后端（浏览器控制）

免终端一键启停：双击 `control-backend/launcher.command`（或桌面「隔空控制器.command」）打开**控制小窗**，点 **Start** 启动（自动拉起静态服务 + 后端 + 受控 Chrome），点 **Stop** 优雅终止（关闭受控 Chrome）。小窗里点「前端」可打开控制前端；点「摄像头：开/关」可经后端向已连接的前端广播指令，远程开关前端摄像头。

> 控制小窗用 macOS 原生 AppKit（pyobjc）实现，规避系统 Python 自带的 Tk 8.5 在新版 macOS 上无法渲染窗口的问题。运行依赖 `control-backend/.venv`（含 `pyobjc-framework-Cocoa`/`Quartz`）。

手动方式（等价）：

```bash
# 终端 1：静态服务（测试页 + 前端页面）
python3 -m http.server 8125

# 终端 2：控制后端（弹出受控 Chrome）
cd control-backend && ./run.sh

# 打开控制前端
open http://localhost:8125/control-frontend/index.html
```

## 独立测试台的使用流程

1. 点击右上「启动摄像头 + 模型」，授权摄像头；
2. 完成 13 点视线标定；
3. 眼动控制光标、手势发命令，或运行「眼动测试 / 手势测试 / 眼-手联合点击」。

## 环境要求

- 现代浏览器（Chrome / Safari / Edge），需授予摄像头权限；
- Web 页面无需构建。工作台首次运行需准备 Face Landmarker 模型，WebGazer 对照入口使用本地 vendor。
