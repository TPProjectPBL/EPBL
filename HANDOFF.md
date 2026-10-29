# 隔空控制器（Air Controller）· 交接文档

> 写给**完全没有上下文的新会话**。先读这一份，再动代码。
> 最后更新：2026-10-26 ｜ 团队仓库：`origin = TPProjectPBL/EPBL` ｜ 个人 fork：`jarvis = Jarvis626070/EPBL`

---

## 0. 新会话快速上手（先做这 4 步）

1. **读本文件**（约 5 分钟），重点看第 1、3、5 节。
2. **看工程蓝图**：`outputs/隔空控制器-工程蓝图.html`（按阶段的可视化说明 + 理想效果 + 踩坑）。
3. **跑起来**：项目根目录执行 `python3 -m http.server 8125`，浏览器开 `http://127.0.0.1:8125/controller-demo/index.html`。
4. **改 JS 前记住**：本项目**无 node/deno/bun**，改完必须先跑
   `python3 .deepworks/tmp/check_js_balance.py` 做括号/字符串平衡自检，再到浏览器实测。

---

## 1. 我们在做什么任务

**PBL 项目：隔空控制器**——用「眼动 + 手势」实现**免接触人机交互**，替代鼠标 / 键盘 / 触控。

- **眼动**：WebGazer 2.1.2（本地 vendor 包 + 本地 facemesh 模型），做视线定位 → 按钮磁吸 → 驻留点击。
- **手势**：MediaPipe Hands（21 点），识别 **6 个静态手势 + 方向滚动**：
  - ✊ 握拳 = 确认　👍 拇指朝上 = 返回　☝️ 食指 = 主页　✌️ 二指 = 菜单
  - 🖐 指尖朝上 = 上滚　指尖朝下 = 下滚
- **形态**：纯前端 HTML/JS，**无构建工具、无框架**，浏览器 + 摄像头即可跑；可选 WebSocket 把指令发给后端。
- **目标用户场景**：双手被占用、不便接触、行动不便等场景。

一句话：**眼睛看按钮 + 比手势，就能操作一个遥控器界面。**

**明确不做**：不做 iOS 原生（`EyeControlApp/` 已废弃）、不做精细捏合 / 摇滚等 1–2 米不可靠手势。

---

## 2. 已经完成了什么（按阶段）

### 阶段 0 · 地基：摄像头 + 眼动 + 点击 ✅
- **眼动引擎替换**：旧方案 MediaPipe face_mesh 的 wasm 推理会 `Aborted` 崩溃，已换成 **WebGazer 2.1.2**，手势仍用 MediaPipe Hands。
- **WebGazer 本地化**：`webgazer.js` + facemesh 模型下载到 `vendor/`，**patch 了本地模型路径 + `fromTFHub:false` + 允许 127.0.0.1**，离线可跑。
- **9 点标定**：`webgazer.recordScreenPosition(x, y, "click")`。
- **驻留点击（dwell）**：光标停在按钮上 800ms 触发一次。
- **隐藏红点**：`showPredictionPoints(false)`。
- **修标定遮挡**：`.gaze-cursor` 的 `z-index` 从 30 提到 **110**（标定层 `.overlay` 是 100）。

### 阶段 1 · 眼动手感：意图吸附 ✅
- 视线点做强低通 **EMA**（只保留"大致在看哪"）。
- **按钮磁吸（gravity well）**：视线落在按钮中心 70px 内，光标自动吸到按钮中心。
- **懒漂移**：看空白区时光标几乎不动，不跟着抖。
- 三档「视线吸附」低/中/高（gravity 50/70/95px），UI 在「眼动追踪」面板。
- URL 可调：`?ema=0.14&gravity=70`。
- **用户评价：「挺好了」。**

### 阶段 2 · 手势：6 静态手势 + 方向滚动 ✅
- MediaPipe Hands **21 点**关键点，`maxNumHands:1`。
- 判定方法（对朝向鲁棒）：
  - 手指伸直：`指尖到手腕(0)距离 > 指根 MCP 到手腕距离 × 倍数`；
  - 拇指伸直：`拇指尖(4)到掌心(9) > 拇指 MCP(2)到掌心 × 倍数`；
  - 滚动方向：`四指指尖平均 y vs 掌心(9) y`，死区 ±0.12。
- **状态机**：候选连续 **3 帧**才确认切换；离散动作 **900ms 冷却**；滚动 **120ms 节流**。
- 页面有滚动演示列表 + 「隔空手势」图例 + 诊断行实时手势显示。
- **关键取舍**：因「张开手掌、指尖向上」与「上滚」是同一姿态，**「返回」从张开改为拇指朝上**。

### 阶段 3 · 联调：眼动与手势不打架 ✅（预埋完成）
- **`handBusyUntil`**：手势活跃时冻结眼动 dwell（手势期间持续刷新，结束后 300ms 恢复；动作触发后再冻结 480ms），避免「手势触发 + dwell」对同一按钮双触发。
- **参数集中 `GT`**：所有手势阈值收进一个对象，支持 URL 覆盖，**Brio 到位后不改代码即可试参**：
  `?gEnter=3&gCooldown=900&gScroll=120&gStep=40&gFinger=1.2&gThumb=1.25&gDead=0.12`
  - `gEnter` 确认帧数 / `gCooldown` 动作冷却 / `gScroll` 滚动节流 / `gStep` 滚动像素 / `gFinger` 手指倍数 / `gThumb` 拇指倍数 / `gDead` 方向死区。

### 其它已完成
- **内网 HTTPS 分享**：`https://10.11.0.216:8443/controller-demo/index.html`（独立 CA + `server.crt`，SAN 绑 IP）。
- **清理无关上传**：删除 `creative-developer-hero.html`（纯模板）、`gaze-pointer-lab.html`（合成眼动视觉实验，无真实摄像头/模型）；保留 `draw/` 隔空画板。
- **工程蓝图**：`outputs/隔空控制器-工程蓝图.html`（按阶段 + 理想效果 + 踩坑）。
- **全部已提交推送** `origin/main`。

---

## 3. 当前卡在哪

**没有硬性阻塞。** 眼动「意图吸附」用户已认可；手势 6 件套代码 + 防冲突 + 参数化都已落地并通过括号自检。

**唯一的等待：Logitech Brio 摄像头到位后做真实硬件实测与调参。**（用户会主动告知）

待实测调参清单：
- **手势阈值**：`gFinger=1.2`、`gThumb=1.25`、`gDead=0.12`、`gEnter=3` 都是初值，1–2 米下需微调。
- **拇指 / 二指**在 1–2 米下可靠性中等，需实测；若误识别多，先砍拇指、改回「张开=返回」，滚动换手位置判定。
- **滚动手感**：`gStep=40` / `gScroll=120` 是初值，按实测调速度与方向。
- **磁吸 `gravity`**（70px 中档）未最终定死。

---

## 4. 下一步计划

### 4.1 主计划：Brio 到位后的实测流程（按顺序）

1. **基线实测**：`?mode=hand`，1–2 米逐个比 6 个手势，记录识别率 / 误触发 / 最不稳的手势。
2. **调阈值**：优先用 URL 试参（`gEnter / gThumb / gDead / gScroll`），试出最稳值后再写死默认值。
3. **滚动确认**：指尖向上是否等于内容上滚（反了就改 `dir` 正负）、速度是否舒适。
4. **联调**：`?mode=both`，验证 `handBusyUntil` 生效、同一动作只触发一次。
5. **光照**：先看环境光够不够；不够再考虑补光灯（**必须可见光，不能红外**）。
6. **锁定参数**：把实测最优值写回 `GT` 默认值，更新文档。

### 4.2 可选优化（不阻塞）

- **骨架叠加层**：摄像头预览上画 21 点 + 当前手势 + 各手指伸/屈，方便看哪根手指判错。
- **实测记录表**：6 手势 × 识别率/误触 的勾选表。
- **标定诊断行提到覆盖层之上**：`.dbg-line` 的 `z-index:60 → 110`。
- **磁吸切换滞回**：离开足够远才切下一个按钮。
- **同步个人 fork**：`git push jarvis main`。
- **集成 `draw/` 隔空画板**（团队功能，已保留）。

### 4.3 硬件基线（计划前提）

- **摄像头**：Logitech Brio 1080p（1080p@30fps，可 720p@60fps），USB 免驱。
- **距离**：1–2 米（Brio 定焦），人手约占画面高 1/8–1/5。
- **补光**：⚠️ 必须**可见光**。Brio 是 RGB + IR-cut，**红外补光灯无效**。用户当前选择「先不买灯，看环境光够不够」。
- **光照目标**：面部与手部均匀受光，避免逆光/侧背光。

---

## 5. 踩过的坑（绝对不要再踩）

### 5.1 技术坑

1. **MediaPipe face_mesh 的 wasm 会 `Aborted` 崩溃**——眼动就认准 WebGazer，**别退回 face_mesh**。
2. **WebGazer 本地模型必须 patch**：升级/重下 WebGazer 后，务必重新 patch `vendor/webgazer/webgazer.js` 的模型路径指向本地 `facemesh_model/`，且 `fromTFHub:false`，并把 `127.0.0.1` 加入域名白名单；否则会联网拉模型而失败。
3. **WebGazer 2.1.2 API 与 1.x 不同**：`begin()` 返回 **Promise**；`setGazeListener` 回调的 `data={x,y}` 是**视口像素**（非归一化）；标定用 `recordScreenPosition(x,y,"click")`。
4. **红点是调试用的**：`showPredictionPoints(false)` 只隐藏红点，不影响预测数值。
5. **全屏覆盖层会盖住光标**：`.overlay` 是 `z-index:100`，光标原来 30 被盖。以后加任何全屏层，记得把光标/诊断行提到 100 以上。
6. **滚动不要加 `scroll-behavior: smooth`**：与手动 `scrollTop` 累加冲突，会卡顿/回弹。**已移除，别再加回**。
7. **手势触发时 dwell 会"补刀"**：同一按钮可能被"手势 + dwell"各点一次。已用 `handBusyUntil` 冻结，**不要删这段逻辑**。
8. **「张开手掌」不能同时做「返回」和「上滚」**：两者是同一姿态，已把「返回」改为拇指朝上。改手势映射时务必保持互斥。
9. **红外补光灯对 Brio 无效**：RGB + IR-cut 会滤掉红外光，画面不会变亮。要补光只能用可见光（白光/LED）。
10. **无 node/deno/bun**：改 JS 后只能 Python 括号自检 + 浏览器实测，不要假设"改完就能用"。
11. **私钥绝不进 git**：`ca.key`/`server.key` 在 `.deepworks/tmp/ssl/`，靠 `.gitignore` 忽略。**永远不要 `git add -A`**，提交前逐项 `git status`。
12. **内网 IP 是 DHCP 动态的**：变过两次（`10.11.0.183` → `10.11.0.192` → `10.11.0.216`）。IP 变了 `server.crt` 的 SAN 就失效，要重新签发，并同步改 `ext.cnf`。

### 5.2 协作 / 流程坑

13. **仓库有两个远程，别推错**：
    - `origin` = `TPProjectPBL/EPBL`（团队主仓库，**正确推送目标**）
    - `jarvis` = `Jarvis626070/EPBL`（个人 fork）
    - 分支 upstream 配的是 `jarvis/main`，**裸 `git push` 会推到 jarvis**；推团队必须显式 `git push origin main`。
14. **推送被拒先 rebase，绝不 force**：团队会有人推（遇到过「隔空画板」新提交）。正确做法：
    `git fetch origin && git rebase origin/main && git push origin main`。**绝不 `--force`**。
15. **别把"合成眼动 / hero 模板"当真实功能**：`gaze-pointer-lab.html`、`creative-developer-hero.html` 已删——它们不接摄像头、不跑模型，看着像功能其实不是。`controller-demo/hero.html` 是被集成的功能（`?mode=hero`），保留。

---

## 6. 运行方式 / 服务 / URL

### 启动本地服务（项目根目录）

| 服务 | 端口 | 命令 | 说明 |
|---|---|---|---|
| 本地调试 HTTP | 8125 | `python3 -m http.server 8125` | 仅 127.0.0.1 |
| 内网 HTTPS | 8443 | `python3 .deepworks/tmp/ssl/https_server.py` | 白名单 `controller-demo`、`outputs`、`gesture-test`、`dual-test`、`draw`，根路径 302 → 主页面 |

### 访问地址

- 本机调试：`http://127.0.0.1:8125/controller-demo/index.html`
- 主控制器：`https://10.11.0.216:8443/controller-demo/index.html`
- 眼动+手势测试台：`https://10.11.0.216:8443/dual-test/index.html`
- 手势测试台：`https://10.11.0.216:8443/gesture-test/index.html`
- 隔空画板：`https://10.11.0.216:8443/draw/index.html`
- 协作者信任证书：`https://10.11.0.216:8443/ca.crt`

### 页面 URL 参数

| 参数 | 作用 |
|---|---|
| `?mode=gaze\|hand\|both` | 只用眼动 / 只用手势 / 两者（默认 both） |
| `?mode=hero` | 协作者的 hero 视线视觉页 |
| `?ema=0.14&gravity=70` | 眼动低通 + 磁吸半径 |
| `?gEnter=&gCooldown=&gScroll=&gStep=&gFinger=&gThumb=&gDead=` | 手势试参（见第 2 节） |

### 证书失效重签（IP 变了才需要）

1. `ipconfig getifaddr en0` 拿新 IP。
2. 更新 `ext.cnf` 的 SAN IP，重签 `server.crt`（CA 用 `ca.key`/`ca.crt`）。
3. 重启 `https_server.py`。

---

## 7. 关键文件清单

| 文件 | 角色 |
|---|---|
| `controller-demo/index.html` | **主战场**：WebGazer 集成、标定、意图吸附、dwell、手势库 + 状态机、防冲突、诊断 |
| `controller-demo/vendor/webgazer/` | 已 patch 的 WebGazer 2.1.2 + 本地 facemesh 模型（**必须提交**） |
| `controller-demo/webgazer-gaze.html` | 眼动对照页，调 EMA/磁吸参数用 |
| `controller-demo/hero.html` | 协作者 hero 视觉页（`?mode=hero`），保留 |
| `draw/` | 协作者隔空画板（真实 MediaPipe），保留 |
| `eye-page-turner/` | 旧眼动翻页器，参考即可 |
| `outputs/隔空控制器-工程蓝图.html` | **按阶段的工程蓝图**（给人和新会话看） |
| `HANDOFF.md` | 本文件，新会话第一份要读 |
| `.deepworks/tmp/check_js_balance.py` | JS 括号自检脚本（gitignore） |
| `.deepworks/tmp/ssl/` | 内网证书 + HTTPS 服务器（**私钥，绝不提交**） |

---

## 8. Git 纪律（必须遵守）

- 提交前：`git status` → `git diff` 逐项确认，**不用 `git add -A`**。
- 推团队：`git push origin main`（不是裸 `git push`）。
- 被拒：`git fetch origin && git rebase origin/main && git push origin main`。
- **绝不 force push**。
- 提交信息用中文 `feat:/fix:/chore:` 前缀，与仓库现有风格一致。

---

## 9. 环境备注

- 平台：macOS（darwin），shell：zsh。
- 工作区根：`/Users/xu/Desktop/PBL`。
- 无 node/deno/bun。
- 当前模型（仅记录）：`dth/DeepSeek-V4.1-Flash`。
