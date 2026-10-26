# HANDOFF — 隔空控制器（Air Controller）交接文档

> 写给下一个完全没有上下文的新会话。先读这一份，再动代码。

---

## 1. 我们在做什么任务

**PBL 项目：隔空控制器（Air Controller）**——用「眼动 + 手势」实现免接触人机交互，替代鼠标/键盘/触控。

核心技术方案（当前主战场）：

- **眼动追踪**：用 **WebGazer 2.1.2**（本地 vendor 包 + 本地 facemesh 模型），定位视线。
- **手势识别**：用 **MediaPipe Hands**，识别 **6 个静态手势 + 方向滚动**（握拳=确认、拇指朝上=返回、食指=主页、二指=菜单、指尖朝上=上滚、指尖朝下=下滚），带状态机防抖。
- **输出形态**：纯前端 HTML/JS，**无构建工具、无框架**，跑在浏览器里，通过摄像头控制一个屏幕光标去点按钮（dwell 驻留点击），也可通过 WebSocket 把增量发给后端。

一句话：让用户**用眼睛看按钮 + 手势辅助**就能操作一个遥控器界面。

---

## 2. 仓库结构速查（工作区根 `/Users/xu/Desktop/PBL`）

| 路径 | 是什么 | 状态 |
|---|---|---|
| `controller-demo/` | **当前主战场**：眼动+手势控制器 | 活跃 |
| `controller-demo/index.html` | 主页面（WebGazer 眼动 + MediaPipe hands + `?mode=` 切换 + 意图吸附光标 + 9 点标定 + dwell 点击） | 活跃 |
| `controller-demo/webgazer-gaze.html` | 纯 WebGazer 眼动对照页 | 已同步磁吸逻辑 |
| `controller-demo/vendor/webgazer/` | **已 patch 的 WebGazer 2.1.2 本地包** + `facemesh_model/`（model.json + group1-shard1of1.bin，约 8.5M） | 必须提交（clone 后依赖它） |
| `draw/` | 隔空画板（视线笔尖/橡皮擦/双手平移，含 MediaPipe 接入 TODO） | 团队其他人推的，与隔空交互同源，**保留** |
| `eye-page-turner/` | 眼动翻页阅读器（旧方案，基于 MediaPipe face_mesh） | 旧，参考即可 |
| `EyeControlApp/` | 旧 iOS 方案 | 已废弃，`.gitignore` 忽略 |
| `outputs/` | 产物目录 | 产物面板可见 |
| `.deepworks/tmp/ssl/` | 内网 HTTPS 证书 + 服务器脚本（私钥！） | `.gitignore` 忽略，**绝不提交** |
| `.opencode/` | opencode 配置/技能 | `.gitignore` 忽略 |

---

## 3. 已经完成了什么

1. **眼动引擎替换**：从 MediaPipe face_mesh（wasm 推理会 `Aborted` 崩溃）换成 **WebGazer 2.1.2**，并保留了 MediaPipe Hands 手势。
2. **WebGazer 本地化**：把 `webgazer.js` + facemesh 模型下载到 `vendor/`，**patch 了本地模型路径 + `fromTFHub:false` + 允许 127.0.0.1 域名**，离线可跑、不再从 TFHub/CDN 拉模型。
3. **9 点标定**：`recordScreenPosition(x,y,"click")` 采集，标定完精度显著提升。
4. **意图吸附光标**（本轮重点，用户已确认「挺好了」）：
   - 视线点先做**强低通 EMA**（只保留"大致在看哪"的方向）。
   - **按钮磁吸（gravity well）**：视线落在任一按钮中心 70px 内，光标自动吸到按钮中心并稳住，无需精确对准。
   - **懒漂移（lazy cursor）**：看空白区时光标几乎不动，不会跟着抖。
   - 三档「视线吸附」低/中/高（gravity 50/70/95px），UI 在「眼动追踪」面板。
5. **隐藏 WebGazer 红点**：`showPredictionPoints(false)`（调试预测点，关掉不影响数值）。
6. **修复标定遮挡**：视线光标 `.gaze-cursor` 的 `z-index` 从 30 提到 **110**（标定覆盖层 `.overlay` 是 100，之前盖住了光标）。
7. **内网 HTTPS 分享**：`https://10.11.0.192:8443/controller-demo/index.html`，独立 CA + `server.crt`（SAN 绑定 IP），协作者下载信任 `ca.crt` 即可。
8. **手势库重构（本轮）**：把原来的「张开放大 / 握拳缩小」替换为 **6 手势 + 状态机**：
   - **离散动作键**：握拳=确认、拇指朝上=返回、食指=主页、二指=菜单（进入连续 3 帧确认 + 900ms 冷却）。
   - **方向滚动**：张开手掌看指尖方向 → 指尖朝上=上滚、指尖朝下=下滚（持续触发，120ms 步进，滚动演示列表实时可见）。
   - 手指伸/屈用「指尖到手腕(0)距离 vs 指根 MCP 到手腕距离」判定（对朝向鲁棒）；滚动方向用「四指指尖平均 y vs 掌心(9) y」判定（±0.12 死区）。
   - 页面新增滚动演示列表 + 「隔空手势」图例；诊断行显示实时手势。
   - **重要取舍**：因「张开手掌、指尖向上」与「上滚」是同一姿态，**「返回」从张开改为拇指朝上**，避免冲突。
9. **清理无关上传**：删除协作者误传的 `creative-developer-hero.html`（纯网页模板）与 `gaze-pointer-lab.html`（合成眼动驱动的视觉折痕实验页，无真实摄像头/模型）；保留 `draw/` 隔空画板。
10. **阶段 A 预埋（Brio 到位前）**：① 手势活跃时冻结眼动 dwell（`handBusyUntil`：手势期间持续刷新，结束后 300ms 恢复；动作触发后再冻结 480ms），避免「手势触发 + 眼动 dwell」对同一按钮双触发；② 所有手势阈值集中为 `GT`，支持 `?gEnter/gCooldown/gScroll/gStep/gFinger/gThumb/gDead` URL 覆盖，Brio 到位后**不改代码即可试参**。
11. **已提交推送**：`origin/main`（团队仓库 `TPProjectPBL/EPBL`）。

---

## 4. 当前卡在哪

**没有硬性阻塞。** 眼动「意图吸附」用户评价「挺好了」，手势 6 件套代码已落地并通过括号自检。

待 Brio 实测后调参的点：

- **手势阈值**：`fingerUp` 的 1.2 倍、`thumbUp` 的 1.25 倍、滚动判定 ±0.12、状态机 enter=3，都是初值，1–2 米下需按实测微调。
- **拇指 / 二指**在 1–2 米下可靠性中等，需实测确认；若误识别多，先砍拇指、改回「张开=返回」并把滚动换成手位置判定。
- **滚动手感**：`dir*40` / 120ms 是初值，按实测调速度与方向。
- **磁吸 `gravity`** 手感（70px 中档）未最终定死。
- 尚未做的可选优化见下一节，都不是 blocker。

---

## 5. 下一步计划（按 Logitech Brio 1080 + 补光灯 制定）

### 5.0 硬件基线（计划前提）

- **摄像头**：Logitech Brio 1080p（1080p@30fps；可切 720p@60fps），USB 免驱，Mac 直接可用。
- **补光**：⚠️ 必须是**可见光补光灯**。Brio 是 RGB 传感器、带 IR-cut 滤镜，**红外（IR）补光灯对它无效**——红外光会被滤掉，画面不会变亮。若手头是「红外补光灯」，需换成白光 / LED 可见光补光灯。摆放：摄像头同侧、略高于视平线，正面均匀打脸打手，避免逆光/侧背光。
- **距离**：1–2 米（Brio 定焦）。此距离下人手约占画面高 1/8–1/5，MediaPipe 仍可稳定检出 21 点，但**拇指-食指捏合这类精细手势不可靠**，所以手势库只做静态伸/屈 + 慢速方向。
- **光照目标**：面部与手部都均匀受光；过低光照会让 WebGazer 精度骤降、MediaPipe 丢帧。

### 5.1 计划（按优先级）

1. **基线实测**：`?mode=hand` 打开，1–2 米逐个比 6 个手势，记录识别率 / 误触发 / 最不稳的手势。
2. **调手势阈值**：按实测改 `fingerUp`（1.2×）、`thumbUp`（1.25×）、滚动死区（±0.12）、`GS.enter`（3 帧）；拇指不稳就砍掉，改回「张开=返回」，滚动换「手抬高/压低」。
3. **滚动手感**：调 `scrollTop` 步长与 120ms 节流，确认「指尖向上 = 内容上滚」方向符合直觉（反了就对调 `dir` 正负）。
4. **眼动 + 手势联调**：`?mode=both`，验证三者不打架——尤其手势触发动作时，眼动光标是否误触 dwell 点击。必要时手势激活瞬间暂停 dwell。
5. **补光校准**：固定补光灯位置，比较开/关补光下的手势识别率与眼动精度，确定最终灯位。
6. **（可选）标定诊断行提到覆盖层之上**：`dbg-line` 的 `z-index:60` → `110`。页面上 `.dbg-line` 声明在 `header` 区域；实际选择器在 `style` 里搜 `.dbg-line`。
7. **（可选）磁吸切换滞回**：离开足够远才切下一个按钮。
8. **（可选）同步个人 fork**：`git push jarvis main`。
9. **（可选）集成 `draw/` 隔空画板**（团队功能，已保留）。

---

## 6. 踩过的坑（绝对不要再踩）

1. **MediaPipe face_mesh wasm `Aborted`**：旧方案眼动用 MediaPipe face_mesh，wasm 推理崩溃。**别退回 face_mesh**，眼动就认准 WebGazer。
2. **WebGazer 本地模型必须 patch**：重新下载/升级 WebGazer 后，务必重新 patch `vendor/webgazer/webgazer.js` 里的模型路径指向本地 `facemesh_model/`，且 `fromTFHub:false`；否则会尝试联网拉模型而失败。关键 patch 点：模型 URL、域名白名单加 `127.0.0.1`。
3. **WebGazer 2.1.2 API 差异（别用 1.x 假设）**：
   - `webgazer.begin()` 返回 **Promise**；
   - `setGazeListener(cb)` 回调 `data = {x, y}` 是**视口像素坐标**（不是归一化值）；
   - 标定用 `webgazer.recordScreenPosition(x, y, "click")`。
4. **WebGazer 红点**：`showPredictionPoints(true)` 会在屏幕画红色预测点，纯调试用；隐藏用 `false`，不影响预测数值。
5. **全屏覆盖层会盖住光标**：`.overlay` 是 `z-index:100`，视线光标原来是 30 被盖住。以后再加任何全屏覆盖层，注意把需要可见的光标/诊断行提到 100 以上。
6. **内网 IP 是 DHCP 动态的**：已经变过一次（`10.11.0.183` → `10.11.0.192`）。证书 `server.crt` 的 SAN 绑死了 IP，IP 一变证书就失效。**每次 IP 变化都要重新签 `server.crt` 绑定新 IP**，先用 `ipconfig getifaddr en0` 确认当前 IP。
7. **私钥绝不进 git**：`ca.key` / `server.key` 在 `.deepworks/tmp/ssl/`，靠 `.gitignore` 忽略 `.deepworks/`。**永远不要 `git add -A`**，提交前 `git status` 逐项确认。
8. **仓库有两个远程，别推错**：
   - `origin` = `TPProjectPBL/EPBL`（**团队主仓库，正确推送目标**）
   - `jarvis` = `Jarvis626070/EPBL`（个人 fork）
   - 而且分支 upstream 配的是 `jarvis/main`，所以**裸 `git push` 会推到 jarvis，不是团队仓库**；推团队必须显式 `git push origin main`。
9. **推送被拒先 rebase，不要 force push**：团队仓库别人也会推（遇到过「隔空画板」新提交导致 `fetch first` 拒绝）。正确做法：`git fetch origin && git rebase origin/main && git push origin main`，**绝不 `--force`**，避免覆盖别人工作。
10. **环境无 node/deno/bun**：没法用真实 JS 引擎验证页面逻辑。改 JS 后只能用 Python 做括号/字符串平衡自检 + 让用户在浏览器实测。改完记得做一次平衡自检。

---

## 7. 常用命令 / 服务 / URL

### 启动本地服务

| 服务 | 端口 | 命令 | 当前状态 |
|---|---|---|---|
| 本地调试 HTTP | 8125（仅 127.0.0.1） | `python3 -m http.server 8125`（在项目根目录） | 运行中（PID 52698） |
| 内网 HTTPS | 8443 | `python3 .deepworks/tmp/ssl/https_server.py` | 运行中（PID 66070） |

> `https_server.py` 关键配置：`ROOT="/Users/xu/Desktop/PBL"`、`PORT=8443`、白名单 `("controller-demo","outputs")`、根路径 302 → `/controller-demo/index.html`、`/ca.crt` 触发下载。

### 访问地址

- 本机调试：`http://127.0.0.1:8125/controller-demo/index.html`
- 内网分享：`https://10.11.0.192:8443/controller-demo/index.html`
- 协作者信任证书：`https://10.11.0.192:8443/ca.crt`

### 页面 URL 参数

- `?mode=gaze|hand|both`（默认 `both`）：只用眼动 / 只用手势 / 两者。
- 吸附调参：`?ema=0.14&gravity=70`（ema 视线低通，gravity 磁吸半径）。
- 手势：比静态手势触发按键；张开手掌、指尖朝上/下滚动。图例在页面「隔空手势」面板。
- 手势调参（不改代码试参）：`?gEnter=3&gCooldown=900&gScroll=120&gStep=40&gFinger=1.2&gThumb=1.25&gDead=0.12`。

### 证书失效重签（IP 变了才需要）

1. `ipconfig getifaddr en0` 拿新 IP。
2. 更新 `ext.cnf` 的 SAN IP 列表，重签 `server.crt`（CA 用 `ca.key`/`ca.crt`，之前流程在 `.deepworks/tmp/ssl/` 下）。
3. 重启 `https_server.py`。

---

## 8. 关键文件清单

- `/Users/xu/Desktop/PBL/controller-demo/index.html` — 主页面，核心逻辑（WebGazer 集成、意图吸附、标定、dwell、模式切换、**手势库 + 状态机 + 滚动演示**、诊断）都在这里。
- `/Users/xu/Desktop/PBL/controller-demo/webgazer-gaze.html` — 对照页，已同步磁吸逻辑。
- `/Users/xu/Desktop/PBL/controller-demo/vendor/webgazer/webgazer.js` — 已 patch 的 WebGazer 2.1.2。
- `/Users/xu/Desktop/PBL/controller-demo/vendor/webgazer/facemesh_model/` — 本地模型权重。
- `/Users/xu/Desktop/PBL/.deepworks/tmp/ssl/https_server.py` — 内网 HTTPS 静态服务器（白名单 + ca.crt 下载）。
- `/Users/xu/Desktop/PBL/.deepworks/tmp/ssl/ca.crt` / `server.crt` / `server.key` — 证书链（私钥，别提交）。

---

## 9. 环境备注

- 平台：macOS（darwin），shell：zsh。
- 工作区根：`/Users/xu/Desktop/PBL`（`Working directory` 和 `Workspace root folder` 一致）。
- 无 node/deno/bun：改 JS 后只能用 Python 括号/字符串平衡自检 + 浏览器实测。
