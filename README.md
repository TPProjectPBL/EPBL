# 隔空控制器（Air Controller）

> 用「眼动 + 手势」实现免接触人机交互 · PBL 项目

**眼动负责「指哪」（当鼠标光标），手势负责「做什么」（当命令）。**

双手被占用、不便接触、行动不便的场景下，只用摄像头即可隔空操控界面。

## 核心方案

- **眼动**：WebGazer 2.1.2（本地 vendor + 本地 facemesh 模型）→ 视线定位 → EMA 平滑 → 按钮磁吸。
- **手势**：MediaPipe Hands / GestureRecognizer（21 点，本地优先、CDN 兜底）→ 6 个静态手势 + 方向滚动。
- **形态**：纯前端 HTML/JS，**无构建工具、无框架**，浏览器 + 摄像头即可运行。

## 手势映射（6 件套）

| 姿态 | 动作 |
|---|---|
| ✊ 握拳 | 确认 |
| 👍 拇指朝上 | 返回 |
| ☝️ 食指 | 主页 |
| ✌️ 二指 | 菜单 |
| 🖐 四指指尖朝上 | 上滚 |
| 🖐 四指指尖朝下 | 下滚 |

`open`（四指伸出、指尖水平）为中立态，只用于验证滚动误触发，不算动作。

## 目录结构

| 目录 | 说明 |
|---|---|
| `dual-test/` | **主测试台**：眼动光标 + 手势控制（标定、眼动/手势/联合点击测试、结果导出） |
| `control-backend/` | 控制后端：FastAPI + Playwright 控制浏览器（含**控制小窗启动器** `launcher.command`） |
| `control-frontend/` | 控制前端：眼动 + 手势采集，经 WebSocket 上报后端 |
| `controller-demo/` | 控制器基础 demo（含 WebGazer / MediaPipe 本地 vendor） |
| `draw/` | 眼动 / 手势绘图 |
| `eye-page-turner/` | 眼动翻页 |
| `gesture-fruit/` | 手势切水果 |
| `gesture-test/` | 手势测试 |
| `outputs/` | 工程蓝图等产物 |
| `EyeControlApp/` | 已废弃的 iOS 原生方向 |

## 快速运行

```bash
# 项目根目录
python3 -m http.server 8125

# 浏览器打开主测试台
open http://localhost:8125/dual-test/
```

内网 / 其它设备访问：

```bash
python3 .deepworks/tmp/ssl/https_server.py
# 访问 https://<内网IP>:8443/dual-test/
```

## 控制后端（浏览器控制）

免终端一键启停：双击 `control-backend/launcher.command` 打开**控制小窗**，点 **Start** 启动（自动拉起静态服务 + 后端 + 受控 Chrome），点 **End** 优雅终止（关闭受控 Chrome）。小窗里点「前端」可打开控制前端。

手动方式（等价）：

```bash
# 终端 1：静态服务（测试页 + 前端页面）
python3 -m http.server 8125

# 终端 2：控制后端（弹出受控 Chrome）
cd control-backend && ./run.sh

# 打开控制前端
open http://localhost:8125/control-frontend/index.html
```

## 使用流程

1. 点击右上「启动摄像头 + 模型」，授权摄像头；
2. 完成 13 点视线标定；
3. 眼动控制光标、手势发命令，或运行「眼动测试 / 手势测试 / 眼-手联合点击」。

## 环境要求

- 现代浏览器（Chrome / Safari / Edge），需授予摄像头权限；
- 无需安装依赖、无需构建；WebGazer 已本地化，MediaPipe 本地优先、断网时请使用本地 vendor。
