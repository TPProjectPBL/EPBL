# 隔空控制器（Air Controller）· 交接文档

> 写给**完全没有上下文的新会话**。先读完这一份再动代码，能省掉至少两小时的重踩。
> 最后更新：2026-10-29 17:40 ｜ HEAD：`b5069b9`（origin/jarvis 均 0/0，工作区干净）
> 团队仓库：`origin = TPProjectPBL/EPBL` ｜ 个人 fork：`jarvis = Jarvis626070/EPBL`

---

## 0. 新会话快速上手（按顺序做这 5 步）

1. **读完本文件**，重点看 **第 3 节（当前卡点）** 和 **第 5 节（坑）**。第 3 节里有已经设计好、只差落地的改法。
2. **看工程蓝图**：`outputs/隔空控制器-工程蓝图.html`（按阶段的可视化说明 + 理想效果 + 踩坑）。
3. **起服务**（项目根目录，两个都要，别搞混）：
   - `python3 -m http.server 8125` → 本机调试用 `http://localhost:8125/...`
   - `python3 .deepworks/tmp/ssl/https_server.py` → 内网/其它设备用 `https://10.11.0.216:8443/...`
4. **改 JS 前**：本项目**没有 node/deno/bun**，改完必须用
   `python3 .deepworks/tmp/check_js_balance.py dual-test/index.html`（**必须带文件参数**，见 5.1 第 21 条）做括号自检，再到浏览器实测。
5. **不要假设"改完就能用"**：没有浏览器自动化工具，页面运行时的真实表现只能靠用户截图反馈。

---

## 1. 我们在做什么任务

**PBL 项目：隔空控制器**——用「眼动 + 手势」实现**免接触人机交互**。

核心方案（2026-10-28 定稿）：

> **眼动负责"指哪"（当鼠标光标），手势负责"做什么"（当命令）。**

- **眼动**：WebGazer 2.1.2（本地 vendor + 本地 facemesh 模型）→ 视线定位 → EMA 平滑 → 按钮磁吸。
- **手势**：MediaPipe GestureRecognizer / Hands（21 点）→ 6 个静态手势 + 方向滚动。
- **形态**：纯前端 HTML/JS，**无构建工具、无框架**，浏览器 + 摄像头即可跑。
- **目标场景**：双手被占用、不便接触、行动不便。

**明确不做**：iOS 原生（`EyeControlApp/` 已废弃）；1–2 米不可靠的捏合 / 摇滚 / 快速甩动手势。

### 手势映射（6 件套，已定稿）

| 姿态 | 动作 | 可靠性（1–2m） |
|---|---|---|
| ✊ 握拳 | 确认 | ★★★ |
| 👍 拇指朝上 | 返回 | ★★☆ |
| ☝️ 食指 | 主页 | ★★★ |
| ✌️ 二指 | 菜单 | ★★☆ |
| 🖐 四指伸出、指尖朝上 | 上滚 | ★★★ |
| 🖐 四指伸出、指尖朝下 | 下滚 | ★★☆ |

`open`（四指伸出、指尖水平）是**中立态**，只用于验证滚动误触发，不算动作。

---

## 2. 已经完成了什么

### 阶段 0 · 地基：摄像头 + 眼动 + 点击 ✅
- 眼动引擎从 MediaPipe face_mesh 换成 **WebGazer 2.1.2**（face_mesh 的 wasm 会 `Aborted` 崩溃）。
- WebGazer 本地化并 patch：模型路径指向本地 `facemesh_model/`、`fromTFHub:false`、允许 `127.0.0.1`，离线可跑。
- 9 点标定（`webgazer.recordScreenPosition(x, y, "click")`）+ 驻留点击（dwell）。

### 阶段 1 · 眼动手感：意图吸附 ✅
- 视线点做 EMA 低通，只保留"大致在看哪"。
- **按钮磁吸（gravity well）**：视线进按钮半径内自动吸中心；看空白区时几乎不动。
- 三档磁吸半径（50/70/95px），URL 可调 `?ema=&gravity=`。用户评价：「挺好了」。

### 阶段 2 · 手势 6 件套 + 方向滚动 ✅
- 判定对朝向鲁棒：`指尖到手腕距离 > 指根 MCP 到手腕距离 × 倍数`；拇指同理。
- 状态机：候选连续 3 帧确认；离散动作 900ms 冷却；滚动 120ms 节流。
- **关键取舍**：张开手掌与"上滚"同姿态 → 「返回」改成拇指朝上。

### 阶段 3 · 联调：眼动与手势不打架 ✅
- **`handBusyUntil`**：手势活跃时冻结 dwell（活跃期持续刷新，动作后再冻结 480ms），防同一按钮双触发。
- **参数集中 `GT`**，URL 可覆盖，换硬件不改代码：
  `?gEnter=3&gCooldown=900&gScroll=120&gStep=40&gFinger=1.2&gThumb=1.25&gDead=0.12`

### 阶段 4 · 量化测试台（建设中，当前主战场）

已交付：

| 页面 | 作用 | 状态 |
|---|---|---|
| `gesture-test/index.html` | 手势精确度测试台：7 项测试（6 动作 + 中立态），逐项帧级准确率 / 状态机确认率 / 混淆矩阵 / 导出 JSON | ✅ 用户实测「精度非常高」 |
| `dual-test/index.html` | 眼动光标 + 手势控制测试台：9 点标定、眼动精度（12 目标）、眼-手联合点击（10 轮）、导出 JSON | 🟡 手势可用，**眼动未通** |

**gesture-test 是当前唯一被验证"识别精度很高"的手势实现，它是双模页的参考标准。**
它的取流方式：页面自己 `getUserMedia({video:{width:{ideal:1280},height:{ideal:720},facingMode:"user"}})` → 自有 `<video>` → `recognizer.recognizeForVideo(video, now)`，`numHands:1`，三个置信度 `0.5`，循环节流 34ms，GPU 失败回退 CPU。

### 其它已完成
- 内网 HTTPS 分享：独立 CA + `server.crt`（SAN 绑 IP），白名单 `controller-demo / outputs / gesture-test / dual-test / draw`。
- 工程蓝图：`outputs/隔空控制器-工程蓝图.html`。
- 清理无关模板文件（hero 模板、合成眼动实验页），保留协作者 `draw/` 隔空画板。

---

## 3. 当前卡在哪（最重要的 60 行）

### 现象（用户 2026-10-29 17:33 截图，`http://localhost:8125/dual-test/index.html`）

启动后：

- `摄像头 · 1280×720` ✅
- `手势 · 就绪` ✅（模型加载正常）
- **`视线` 状态灯是灰色** → 说明 `onGaze` **一次都没被调用**
- **`眼动 0 fps`**
- 9 点标定能点完；随后「眼动精度测试」进行到 **6/12 点**，已跑过的 6 个目标**全部**报 **`无视线样本（未检测到脸）`**，`无样本点 = 6`，平均偏差 `—`

### 关键判据（新会话务必记住这个区分）

| `视线` 灯 | 含义 |
|---|---|
| **灰**（默认文字"视线"） | `onGaze` **从未被调用** → WebGazer 的**预测循环没启动** |
| **红**（"视线 · 丢失"） | 回调触发了但 `data` 为 `null` → 循环在跑，只是**没检测到脸** |
| **绿**（"视线 · OK"） | 正常出点 |

本次是**灰**，所以问题不在"脸没露出来"，而在**循环根本没跑起来**。

### 根因（高置信，尚未最终验证）

`b5069b9` 的实现是：页面自己 `getUserMedia` 拿一条 1280×720 的 `MediaStream` → 赋给自有 `<video id="cam">` → **临时替换 `navigator.mediaDevices.getUserMedia` 让它返回同一条流**，好让 WebGazer 复用、不再二次开摄像头。

问题：一条 `MediaStream` 被**多个 `<video>` 同时消费**（`#cam`、WebGazer 的 `#webgazerVideoFeed`，WebGazer 内部的 `tf.data.webcam` 还会再建一个）。Chrome 不报错，但内部 `cam.next()` 永远不 resolve → `begin()` 已 resolve（所以按钮都可用），**但预测循环永久卡在 `await` 上**。

这也解释了为什么"手势好、眼动死"：MediaPipe 读的是我们自己的 `#cam`（正常出帧），WebGazer 读的是它自己那个一直拿不到新帧的 video。

### 已经排除的假设

- ❌ 摄像头权限/占用：`摄像头 · 1280×720` 已证明有真实画面。
- ❌ 手势模型/分辨率：手势显示"就绪"，且 gesture-test 同参数实测很准。
- ❌ CSS `opacity:0` 或容器位置导致解码暂停：已改过一次（移出视口 → 视口内透明），现象不变。

---

## 4. 下一步计划（改法已经设计好，落地即可）

### 4.1 唯一要做的改造：回到"单流单 video"，让 WebGazer 自己开流

**顺序反过来**——不自己开摄像头，让 WebGazer 开，MediaPipe 去读 WebGazer 的 video。
理由：这条路径在 `controller-demo/index.html` 里是**长期验证可用**的（能出视线），而"预先开流再复用"是本次新引入的实验性做法。

具体改动（`dual-test/index.html`，约 6 处）：

1. **删掉** `startCamera()`、`camStream`、`camVideo`、`const camVideo = $("cam")` 整块。
2. **删掉** HTML 里的 `<video id="cam" playsinline muted autoplay></video>` 和 CSS 里的 `#cam{...}` 规则。
3. **删掉** `bootEye()` 里对 `navigator.mediaDevices.getUserMedia` 的临时替换（`realGUM` / `finally` 还原那一段）。
4. `bootEye()` 改为让 WebGazer 自己以 720p 开流：
   ```js
   webgazer.params.camConstraints = {
     video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
     audio: false,
   };
   await webgazer.begin();                      // 内部 getUserMedia 用它
   const vf = document.getElementById("webgazerVideoFeed");
   // 轮询等 vf.videoWidth 非 0（最多 ~3s），再 isBlackFrame(vf) 校验
   handImg = vf;                                 // 关键：MediaPipe 读 WebGazer 的 video
   ```
   校验通过后打日志 `摄像头就绪 W×H`，并 `pill($("pillCam"), true, ...)`。
5. `bootHand()` 里删掉 `handImg = camVideo;`（改由 `bootEye()` 设置）。
6. `boot()` 顺序改为：`bootEye()` → `bootHand()`。`handImg` 为空时 `handLoop` 会自动 return，安全。
7. 加一条兜底诊断：`begin()` 后 3 秒若 `S.gazeCount` 没增长，日志报
   `3 秒内没有任何视线输出：WebGazer 预测循环可能未启动`，避免下次又靠肉眼猜。

> 参考 API 事实（已核对 vendor 源码）：`webgazer.params.camConstraints` 存在，默认值
> `{video:{width:{min:320,ideal:640,max:1920},height:{min:240,ideal:480,max:1080},facingMode:"user"}}`；
> `webgazer.setCameraConstraints()` 是 async，流已存在时会 `applyConstraints` 并重设内部缓冲尺寸。

### 4.2 如果 720p 让眼动掉帧

`facemesh` 每帧要 `drawImage` 整帧，1280×720 比 640×480 贵约 3 倍。若 `眼动 fps` 低于 15，按序降：

1. 先试 `ideal: 960, height: 540`；
2. 再试回 `640×480`，此时**手势精度**靠"手掌离摄像头近一点"补偿；
3. 或保持 720p 但把标定/测试时的 EMA 调大（`平滑` 滑杆右移）。

### 4.3 眼动跑通后要产出的数据

- 眼动精度：平均偏差、P90、命中率（<70px）、无样本点数（12 点）。
- 眼-手联合：命中/误点/空点/超时 + 平均耗时（10 轮）。
- 判定线：**平均偏差 <70px 可用；联合命中率 ≥80%、单次 <3s 可用。**
- 结果页有「导出结果 JSON」按钮，导出 `dual-control-test.json`。

### 4.4 之后再做的（不阻塞）

- **Brio 到位后**的硬件实测调参（见 4.5）。
- 骨架叠加层（预览上画 21 点 + 各手指伸/屈），仅在需要调试时打开。
- `controller-demo` 集成"眼动光标 + 手势"的新交互骨架。

### 4.5 硬件基线与待调参数

- **摄像头**：Logitech Brio 1080p（定焦，1–2 米）。
- **补光**：⚠️ 必须**可见光**。Brio 是 RGB + IR-cut，红外补光灯无效。用户当前选择"先不买灯"。
- 待实测调参：`gFinger=1.2`、`gThumb=1.25`、`gDead=0.12`、`gEnter=3`、`gStep=40`、`gScroll=120`；磁吸 `gravity`（70px 中档）未定死。

---

## 5. 踩过的坑（绝对不要再踩）

### 5.1 眼动 / 摄像头（本轮踩得最狠的一类）

1. **WebGazer 的 video 不能 `display:none`，也不能移出视口**。浏览器会暂停该 video 的解码 → `getVideoElementCanvas()` 永远黑帧 → facemesh 检不到脸。当前做法是**留在视口内 + `opacity:0` + `pointer-events:none`**。这个坑已踩过三次。
2. **不要在 `webgazer.begin()` 之前自己开摄像头**。macOS 上"开流 → `stop()` → 立刻再开"极容易拿到**黑帧流**。所以：要么让 WebGazer 自己开（推荐），要么全程只开一次。
3. **绝不要让多个 `<video>` 消费同一条 `MediaStream`**（本次 0 fps 的根因）。Chrome 不报错，但媒体管线会静默卡住。
4. **`onGaze` 从未被调用 vs 回调返回 `null` 是两回事**，看 `视线` 灯的颜色区分（见第 3 节表格）。不要一看到"未检测到脸"就去查光照。
5. **标定时手要放下**。手挡在额头/眼前 → facemesh 完全无输出 → 看起来像"眼动坏了"。
6. **MediaPipe face_mesh 的 wasm 会 `Aborted` 崩溃**——眼动就认准 WebGazer，别退回 face_mesh。

### 5.2 手势

7. **手势识别差 99% 是输入分辨率/取流问题，不是模型问题**。gesture-test 用 1280×720 自有 video，实测很准；dual-test 曾用 WebGazer 的 640×480 canvas，就明显不稳。**手势一律喂 1280×720 的 `<video>`（不是 canvas）。**
8. **不要给手势输入传 `getVideoElementCanvas()`**，那是 WebGazer 内部绘制缓冲，可能黑、可能尺寸不对。传 `<video>` 元素本身。
9. **手势触发时 dwell 会"补刀"**：已用 `handBusyUntil` 冻结，**不要删这段逻辑**。
10. **「张开手掌」不能同时是「返回」和「上滚」**，改映射时保持互斥。
11. **三个页面的分类器必须逐行一致**（`controller-demo` / `gesture-test` / `dual-test` 的 `classifyHand`、`FINGERS`、`GT`）。改一处要同步另两处，否则数据不可比。

### 5.3 前端 / 调试

12. **删 DOM 元素必须同步删掉所有 `$("id")` 引用**。本次删掉 `#preview` 画布后，`preview.getContext("2d")` 在模块顶层抛错，**整个 `<script type="module">` 直接不执行**——页面看起来"按钮能点但什么都不工作"。模块顶层任何 `null.xxx` 都是致命的。
13. **全屏覆盖层会盖住光标**：`.overlay` 是 `z-index:100`，光标原来 30 被盖。以后加全屏层记得把光标/诊断行提到 100 以上。
14. **滚动不要加 `scroll-behavior: smooth`**，与手动 `scrollTop` 累加冲突。已移除，别加回。
15. **改完必须 `Cmd+Shift+R` 强刷**。`python3 -m http.server` 会带 `Last-Modified` 缓存，普通刷新可能拿到旧文件，会浪费一整轮排查。

### 5.4 工具与流程

16. **`.deepworks/tmp/check_js_balance.py` 原本硬编码检查 `controller-demo/index.html`，忽略命令行参数**。所以过去几次"自检通过"其实检查的是另一个文件。**已修为读 `sys.argv[1]`**；若换机器重建脚本，务必保留这个行为。检查时**必须带目标文件路径**。
17. **括号自检通过 ≠ 语法正确**。可用 JavaScriptCore 做真解析（macOS 自带）：
    `python3 - <<'PY'` 抽出 `<script type="module">` → 写成 `.mjs` → `/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc --module-file=xxx.mjs`。
    若报 `ReferenceError`（如 `URLSearchParams`/`document` 未定义）说明**语法已通过**，只是运行环境缺 DOM。
18. **仓库有两个远程，别推错**：`origin`（团队）≠ `jarvis`（个人 fork）。分支 upstream 是 `jarvis/main`，**裸 `git push` 会推到个人 fork**；推团队必须 `git push origin main`。
19. **推送被拒先 rebase，绝不 force**：`git fetch origin && git rebase origin/main && git push origin main`。
20. **不要 `git add -A`**：`.deepworks/tmp/ssl/` 里有 `ca.key`/`server.key`，靠 `.gitignore` 忽略，误加就泄露。
21. **内网 IP 是 DHCP 动态的**，变过三次：`10.11.0.183 → 10.11.0.192 → 10.11.0.216`。IP 变了 `server.crt` 的 SAN 失效，要改 `ext.cnf` 重签并重启服务。
22. **运行时 DevTools 仍能读到前端实现**：之前提示过"纯前端无法防住别人看代码"，用户尚未答复是否接受。跨窗口通信的仓库隔离（Jarvis 代码不进 EPBL）是硬约束，**别把 `jarvis-scientist` 的实现写进 EPBL**。

### 5.5 协作

23. **别把"合成眼动 / hero 模板"当真实功能**：`gaze-pointer-lab.html`、`creative-developer-hero.html` 已删（不接摄像头、不跑模型）。`controller-demo/hero.html` 是被集成的真实功能（`?mode=hero`），保留。
24. **`draw/` 是协作者的作品**，真实 MediaPipe 隔空画板，**不要删、不要大改**，dual-test / gesture-test 还共用它的模型和 wasm。

---

## 6. 运行方式 / 服务 / URL

### 启动服务（项目根目录）

| 服务 | 端口 | 命令 | 说明 |
|---|---|---|---|
| 本地调试 HTTP | 8125 | `python3 -m http.server 8125` | 仅本机，`localhost` 是安全源，不受证书限制 |
| 内网 HTTPS | 8443 | `python3 .deepworks/tmp/ssl/https_server.py` | 白名单 `controller-demo`、`outputs`、`gesture-test`、`dual-test`、`draw`；根路径 302 → 主页面 |

> 用户当前主要在 **localhost:8125** 上测 dual-test（避免"不安全证书"页面带来的摄像头/模型限制）。

### 访问地址

| 用途 | 地址 |
|---|---|
| 主控制器 | `http://localhost:8125/controller-demo/index.html` ｜ 内网 `https://10.11.0.216:8443/controller-demo/index.html` |
| **眼动+手势测试台（当前主战场）** | `http://localhost:8125/dual-test/index.html` |
| 手势测试台（精度基准） | `http://localhost:8125/gesture-test/index.html` |
| 隔空画板（协作者） | `https://10.11.0.216:8443/draw/index.html` |
| 协作者信任证书 | `https://10.11.0.216:8443/ca.crt` |

### 页面 URL 参数

| 参数 | 作用 |
|---|---|
| `?mode=gaze\|hand\|both` | 主控制器：只用眼动 / 只用手势 / 两者（默认 both） |
| `?mode=hero` | 协作者的 hero 视线视觉页 |
| `?ema=0.14&gravity=70` | 眼动低通 + 磁吸半径 |
| `?gEnter=&gCooldown=&gScroll=&gStep=&gFinger=&gThumb=&gDead=` | 手势试参（见第 2 节） |

### 证书失效重签（IP 变了才需要）

1. `ipconfig getifaddr en0` 拿新 IP。
2. 更新 `.deepworks/tmp/ssl/ext.cnf` 的 SAN IP，重签：

```bash
openssl req -new -key server.key -out server.csr -subj "/O=PBL/CN=<新IP>"
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAserial ca.srl \
  -out server.crt -days 3650 -sha256 -extfile ext.cnf
openssl verify -CAfile ca.crt server.crt
```

3. 重启 `https_server.py`。

---

## 7. 关键文件清单

| 文件 | 角色 |
|---|---|
| `dual-test/index.html` | **当前主战场**：眼动光标 + 手势命令测试台；9 点标定 / 眼动精度 12 目标 / 眼-手联合 10 轮 / 导出 JSON。眼动未通，见第 3 节 |
| `gesture-test/index.html` | **手势精度的黄金基准**（约 633 行）：7 项测试、逐手势准确率、混淆矩阵、导出 JSON。用户实测"精度非常高" |
| `controller-demo/index.html` | 主控制器：WebGazer 集成、标定、意图吸附、dwell、手势状态机、`handBusyUntil` 防冲突。**眼动可用性的参照实现** |
| `controller-demo/vendor/webgazer/` | 已 patch 的 WebGazer 2.1.2 + 本地 `facemesh_model/`（**必须提交**） |
| `controller-demo/webgazer-gaze.html` | 眼动对照页，调 EMA / 磁吸参数用 |
| `controller-demo/hero.html` | 协作者 hero 视觉页（`?mode=hero`），保留 |
| `draw/` | 协作者隔空画板（真实 MediaPipe）+ **共用模型与 wasm**：`draw/models/gesture_recognizer.task`、`draw/vendor/vision/` |
| `outputs/隔空控制器-工程蓝图.html` | 按阶段的工程蓝图（给人看） |
| `HANDOFF.md` | 本文件，新会话第一份要读 |
| `.deepworks/tmp/check_js_balance.py` | JS 括号自检脚本（gitignore），**必须带文件参数** |
| `.deepworks/tmp/ssl/` | 内网证书 + HTTPS 服务器（**私钥，绝不提交**） |
| `eye-page-turner/` | 旧眼动翻页器，仅参考 |

---

## 8. Git 纪律（必须遵守）

- 提交前：`git status` → `git diff` 逐项确认，**不用 `git add -A`**。
- 推团队：`git push origin main`（不是裸 `git push`）。
- 被拒：`git fetch origin && git rebase origin/main && git push origin main`。
- **绝不 force push**。
- 提交信息用中文 `feat:/fix:/chore:` 前缀，与仓库现有风格一致。
- 提交后校验双远程同步：`git rev-list --left-right --count origin/main...main` 与 `jarvis/main...main` 都应为 `0 0`。

### 最近提交链（倒序）

```
b5069b9 dual-test: 手势改为与 gesture-test 完全一致的取流方式   ← 当前 HEAD（眼动反而坏了）
13f4fd6 dual-test: 透明保留视频容器并优先用 <video> 作识别输入
a09fa73 feat(dual-test): 启动前摄像头预检，明确区分权限拒绝/占用/黑帧
41a682a dual-test: 修复 showVideoPreview(false) 导致的黑帧
b3f2c9c feat(dual-test): 新增眼动光标 + 手势控制双模测试台
ca8b390 chore: 内网地址更新为 10.11.0.216
0cd5374 feat(gesture-test): 手势精确度测试页
efe880b ...
```

> 注意：`b5069b9` 的手势路线是对的，**不要整体回退**。要做的是按 4.1 把"谁开摄像头"换掉，保留 `handImg` 直接读 `<video>` 的思路。

---

## 9. 环境备注

- 平台：macOS（darwin），shell：zsh。
- 工作区根：`/Users/xu/Desktop/PBL`。
- **无 node / deno / bun / esbuild**；有 Python 3、openssl、macOS 自带 `jsc`。
- 浏览器自动化工具不可用（DeepWorks Browser 与 Chrome 扩展未连上），只能靠用户截图。
- `.gitignore` 已忽略：`.DS_Store`、`.opencode/`、`.deepworks/`、`opencode.jsonc`、`EyeControlApp/`、`uploads/`、`outputs/眼动追踪系统设计报告.html`。→ 换机器需手动重建 `https_server.py`、`ext.cnf`、证书、`check_js_balance.py`。
- 当前模型（仅记录）：`dth/DeepSeek-V4.1-Flash`。

---

## 10. 给新会话的一句话总结

> 手势侧已经跑通且精度很好（照 `gesture-test` 抄）。dual-test 现在**只有眼动死了**：
> `视线` 灯是灰的 = WebGazer 预测循环没启动，根因是"一条 MediaStream 被多个 video 消费"。
> 按第 4.1 节把摄像头所有权交回 WebGazer（`camConstraints` 设 720p，`handImg = #webgazerVideoFeed`），
> 删掉自建流与 GUM patch，即可验证。改完务必带参数跑括号自检 + 让用户 `Cmd+Shift+R` 强刷。
