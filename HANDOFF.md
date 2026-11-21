# 隔空控制器（Air Controller）· 交接文档

> 最后更新：2026-11-21 ｜ HEAD：`5e81f55`（与本地 `origin/main` 引用一致，工作台接入和 BlazeFace 本地化仍在工作区）
> 团队仓库：`origin = TPProjectPBL/EPBL` ｜ 本机克隆**只配了 origin**（旧文档里的个人 fork `jarvis` 已移除）
> 分工（按提交历史）：AlexiaWHsu = 眼动 / dual-test / 控制后端 ｜ Evelyn = 文档 / fruit-slice ｜ **Thriving-r = 隔空画板 `draw/`**

---

## 0. 2026-11-21 工作台与隔空画板

### 启动与复测

在仓库根目录分别启动两个服务：

```bash
# 终端 1 · 工作台静态服务（8125）
python3 scripts/serve.py 8125 .

# 终端 2 · GazeFollower 画板服务（8789）
draw/.venv/bin/python draw/gazefollower_server.py
```

- 工作台画板入口为 `http://127.0.0.1:8125/workbench/index.html#/draw`，也可直开 `http://127.0.0.1:8789/index-3-hand-gazefollower.html`。后启动 8789 时，点工作台工具栏的「重载」。进入画板后点「开启摄像头」，依次点击并注视 9 个标定点。画板重载或视口尺寸变化后需要重新标定。
- 本机 `draw/.venv` 使用 Python 3.12，已安装 `gazefollower==1.1.0`。虚拟环境在 Git 忽略范围内，换机器需要重新安装依赖。服务正常时，`http://127.0.0.1:8789/gaze/health` 返回 `{"model":"GazeFollower"}`。
- 测试台、热力图和跑酷仍由工作台宿主统一标定并提供推理。首次在工作台运行这条链路时，用 `bash scripts/fetch-gaze-model.sh` 准备本地 Face Landmarker 模型，再在工作台完成 9 点标定和 5 点验证。
- 真机复测项包括画板 9 点标定、视线笔尖、捏合落笔，以及从跑酷切入画板、再切回跑酷后摄像头和手势是否恢复。进入画板后可在工作台顶层控制台查看 `__epblGazeHost.getStatus()`，预期 `exclusive: true`、`camera: false`、`hands: false`。

### 已提交的改动

- `5e81f55` 新增 `draw/index-3-hand-gazefollower.html` 和 `draw/gazefollower_server.py`。画板浏览器端开一条摄像头流，MediaPipe 在浏览器内识别手势，同一路的 JPEG 帧送往本机 `/gaze/features` 提取 258 维注视特征。9 点样本交给 `/gaze/calibrate` 拟合岭回归，浏览器持有权重并计算视线坐标。
- `57077e1` 修复工作台宿主漏取 `bus` 导致手势广播失效的问题。跑酷进入时订阅 `onHands` 并请求宿主启动手部推理，离开时退订并请求停止。
- `6bdf3ca`、`0384b98`、`f98e729` 更新宿主统一标定：摄像头弹窗与头位引导、1080p 理想采集分辨率、百分制验证结果与内置诊断。实现入口见 `workbench/gaze-host.js` 和 `shared/gaze/calibrate/`。

### 工作区尚未提交

- `workbench/modules.json` 将 `draw` 切到 8789 的 `standaloneUrl`。`workbench/app.js` 对该路由直接加载独立 iframe，授予 `camera` 权限并隐藏宿主标定按钮和状态点。「重载」和「新标签打开」都使用同一个独立地址。
- `workbench/gaze-host.js` 在进入画板时停止手部推理并释放宿主摄像头，独立画板打开期间阻止宿主重新取流。`cameraEpoch` 用来作废已发出但迟到的取流请求，返回的媒体轨道会被关闭。离开画板后，宿主可按订阅重新取流。`workbench/index.html` 的 CSP 放行 8789 iframe，前端版本号更新为 `20261121f`。
- 保留 `draw/index-3-hand.html` 作为独立 WebGazer 版。该版使用的 `draw/vendor/webgazer/webgazer.js` 把 BlazeFace 从 TF Hub 改为本地模型并设置 `fromTFHub: false`。目前 `draw/vendor/webgazer/blazeface_model/model.json` 和 `group1-shard1of1.bin` 都是未跟踪文件，提交这项修复时要随 vendor 补丁一并纳入。

---

## 1. 我们在做什么任务

**PBL 项目：隔空控制器**——用「眼动 + 手势」实现**免接触人机交互**。

核心方案（2026-10-28 定稿）：

> **眼动负责"指哪"（当鼠标光标），手势负责"做什么"（当命令）。**

- **眼动**：工作台宿主用 MediaPipe Face Landmarker 和共享视线模型；独立画板用 GazeFollower；旧演示页和对照入口保留 WebGazer 2.1.2。
- **手势**：MediaPipe GestureRecognizer / Hands（21 点）→ 6 个静态手势 + 方向滚动。
- **形态**：工作台和各 Web 页面用 HTML/JS，无需构建；GazeFollower 画板的注视推理由本机 Python 服务提供。
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

### 阶段 4 · 量化测试台（已交付，待真机出数据）

已交付：

| 页面 | 作用 | 状态 |
|---|---|---|
| `gesture-test/index.html` | 手势精确度测试台：7 项测试（6 动作 + 中立态），逐项帧级准确率 / 状态机确认率 / 混淆矩阵 / 导出 JSON | ✅ 用户实测「精度非常高」 |
| `dual-test/index.html` | 眼动光标 + 手势控制测试台：工作台内用共享模型，保留 13 点 WebGazer 对照标定；支持眼动精度、眼-手联合点击和导出 JSON | 早期眼动 0 fps 问题已修复（`d475f0c`） |

**gesture-test 是当前唯一被验证"识别精度很高"的手势实现，它是双模页的参考标准。**
它的取流方式：页面自己 `getUserMedia({video:{width:{ideal:1280},height:{ideal:720},facingMode:"user"}})` → 自有 `<video>` → `recognizer.recognizeForVideo(video, now)`，`numHands:1`，三个置信度 `0.5`，循环节流 34ms，GPU 失败回退 CPU。

### 独立 WebGazer 画板：`draw/index-3-hand.html`（Thriving-r 负责）

本节记录 WebGazer 版的功能和历史验证。原 `draw/index.html` 的渲染与工具层已合并进这版。工作台使用的 GazeFollower 版见第 0 节。

| 文件 | 形态 | 落笔方式 | 适用 |
|---|---|---|---|
| `draw/index-3-hand.html` | 手势优先版（含原 v3.0 眼动标定 + 视线九宫格 + 全套工具层） | 拇指+食指**捏合**落笔（<0.45 落 / >0.60 抬），握拳也可落笔；**默认笔尖 = 视线九宫格**，按 `T` 可切 **食指指尖（landmark 8）**（One Euro 平滑） | 独立访问 |

它支持：

- **画布交互**：6 色调色板（`1`–`6`，注视色块停留 0.8s 选中并自动收起，默认收起防误触）；画笔 / 橡皮（20px，`destination-out` 真擦除，**不是**用底色涂）；撤回 / 重做（最多保留最近 50 笔）；画布黑 / 白切换（擦痕随主题正确显示）；清空 / 另存 PNG；笔尖来源切换（视线 / 指尖）；左手张开拖动**平移画布内容**（世界坐标 + `panOffset`，平移期间笔尖锁定不落笔）；复位视图。
- **双条件防误触**：清空 / 保存这类高代价操作（真实手势路径）必须「注视目标 + 握拳/捏合」，并带 450ms 二次视觉确认（`armMs`）；键盘 `C` / `S` 走 `bypass`，只延时 450ms，不需要双条件（开发旁路）。
- **降级**：无摄像头时可全鼠标 + 键盘操作（移动＝注视、按住＝落笔、`空格`+拖动＝左手平移）。
- **HUD**：模式 / 视线九宫格区 / 笔尖来源 / 平移偏移 / 笔画·撤回·恢复计数 / FPS。
- **键盘**：`1`–`6` 选色、`E` 画笔/橡皮、`T` 笔尖来源、`B` 画布色、`R` 复位、`P` 调色板、`C` 清空、`S` 保存、`G` 模拟丢视线、`V` Victory、`H` 交换左右手、`Ctrl+Z` 撤回、`Ctrl+Y` 重做。
- **URL 参数**：`?ema=0.18&gravity=82`（视线平滑 / 磁吸半径），`?fliphand=1`（左右手互换，等价按 `H`）。

`index-3-hand.html` 额外接入的离散动作（复用 dual-test 的分类器与边沿状态机）：

| 手势 | 动作 | 约束 |
|---|---|---|
| 👍 拇指朝上 | 切换画笔 / 橡皮 | 3 帧确认；一次连续手势只触发一次；900ms 冷却 |
| ☝️ 食指朝上 | 撤回一笔（等价 Ctrl+Z） | 同上 |
| ✊ 握拳 | 落笔（与捏合并存，`wantDown = Closed_Fist \|\| pinchOn`） | 捏合 / 落笔 / 平移 / 标定期间均不触发离散动作 |
| 🖐 张开手掌 | 抬笔（语义姿态；松开捏合、换非握拳姿态、丢手也会抬笔） | — |

- 关键参数（见 `draw/index-3-hand-测试记录.md`）：One Euro `minCutoff 1.0 / beta 0.02 / dCutoff 1.0`；捏合 0.45 / 0.60；落笔确认 `fistFrames >= 2`；检测节流 34ms；`numHands = 2`。
- 抽出 `window.AirCanvasKit`（版本 `dual-test-port-2`）：`classifyHand` / `createGestureGate` / `isBlackFrame` / `summarizeGaze` / `summarizeJoint` / `buildTestReport`（schema `air-canvas-test/v1`）/ `downloadJSON`，调试桥 `AirCanvasBridge.kit`。移植分两批：第一批纯工具，第二批接 thumb/point 动作。
- 验证状态：`draw/index-3-hand-测试记录.md` 记录了 headless Chrome + CDP 注入假 landmark 的 7 项合成验证：**6 项通过**（镜像、慢线平滑、捏合起止、左右手不串、9 点标定回归 / 鼠标与键盘兜底、零新增依赖），第 3 项「快线断点」**未单独压测**——**只证明逻辑正确，不等于真实摄像头手感**。
- ⚠️ 取流基线偏差：画板当前用 `recognizeForVideo(getVideoElementCanvas())`（WebGazer 默认约 640×480 缓冲），与第 5.2 节「手势一律喂 1280×720 `<video>`、不要传 canvas」不一致。这是真机手势不稳的优先排查项，详见 4.6。
- 真机手感还欠四项：指尖方向是否反、慢线是否抖、快甩是否断点、捏合 0.45/0.60 是否灵敏/误触；取流基线另见 4.6 第 5 项。
- 依赖体积：`draw/vendor/webgazer/`（patched WebGazer 2.1.2 + 本地 facemesh 模型）、`draw/vendor/vision/`（MediaPipe Vision wasm）、`draw/models/gesture_recognizer.task`（约 8.4MB）。
  ⚠️ `.gitignore` 已加 `*.task` / `*.tflite`（老师要求大模型文件不入库）。`draw/models/gesture_recognizer.task` 是**历史已跟踪**文件，仍会随提交走；**新增**模型文件默认不入库，需 `git add -f` 或改成首次运行自动下载（参考 `outputs/fruit-slice/`）。
- **契约**：`dual-test/` 与 `gesture-test/` 的模型和 wasm **都指向 `draw/`**（`../draw/models/gesture_recognizer.task`、`../draw/vendor/vision/`），**别删、别挪**这两个目录。

### 其它已完成
- **控制后端 + 控制前端**（AlexiaWHsu，2026-11-03）：FastAPI + Playwright 控制真实 Chrome，`control-backend/launcher.command` 一键起停，控制小窗用 pyobjc/AppKit 原生实现并带「远程开关摄像头」广播。设计报告见 `outputs/隔空控制器-控制后端-系统设计报告.html`。
- **手势切水果**（Evelyn）：纯前端 `gesture-fruit/` 版已删除；保留 `outputs/fruit-slice/` Python（MediaPipe Tasks）版，模型文件不入库、首次运行自动下载。
- **文档与协作规范**（Evelyn，2026-11-05）：`CONTRIBUTING.md`、`.github/` Issue/PR 模板、`docs/`（WASM 可行性报告、开工方案、交付说明与红线自查、需求口径冻结单）。
- 内网 HTTPS 分享：独立 CA + `server.crt`（SAN 绑 IP），白名单 `controller-demo / outputs / gesture-test / dual-test / draw`。
- 工程蓝图：`outputs/隔空控制器-工程蓝图.html`。
- 清理无关模板文件（hero 模板、合成眼动实验页），保留 Thriving-r 的 `draw/` 隔空画板。

---

## 3. dual-test 历史故障：WebGazer 眼动 0 fps

### 3.1 已修复：dual-test 眼动 0 fps（2026-10-31，`d475f0c`）

第 4.1 节记录了当时的修复。`dual-test/index.html` 的 WebGazer 对照路径由 WebGazer 自己开流，
原先的 720p 理想分辨率后来提升到 1080p，`handImg` 直接指向 `#webgazerVideoFeed`。
工作台模式下，测试台可直接使用宿主推理与共享模型。

### 3.2 历史现象与判据（仍然有效，别再重踩）

以下是 2026-10-29 那次故障的原始记录（对应当时代码 `b5069b9`，现已修复），判据表仍可用来判断"为什么没出点"：

- `摄像头 · 1280×720` ✅
- `手势 · 就绪` ✅（模型加载正常）
- **`视线` 状态灯是灰色** → 说明 `onGaze` **一次都没被调用**
- **`眼动 0 fps`**
- 9 点标定能点完；随后「眼动精度测试」进行到 **6/12 点**，已跑过的 6 个目标**全部**报 **`无视线样本（未检测到脸）`**，`无样本点 = 6`，平均偏差 `—`

### 3.2.1 关键判据（务必记住这个区分）

| `视线` 灯 | 含义 |
|---|---|
| **灰**（默认文字"视线"） | `onGaze` **从未被调用** → WebGazer 的**预测循环没启动** |
| **红**（"视线 · 丢失"） | 回调触发了但 `data` 为 `null` → 循环在跑，只是**没检测到脸** |
| **绿**（"视线 · OK"） | 正常出点 |

当时是**灰**，所以问题不在"脸没露出来"，而在**循环根本没跑起来**。

### 3.3 根因（已验证，已修复）

`b5069b9` 的实现是：页面自己 `getUserMedia` 拿一条 1280×720 的 `MediaStream` → 赋给自有 `<video id="cam">` → **临时替换 `navigator.mediaDevices.getUserMedia` 让它返回同一条流**，好让 WebGazer 复用、不再二次开摄像头。

问题：一条 `MediaStream` 被**多个 `<video>` 同时消费**（`#cam`、WebGazer 的 `#webgazerVideoFeed`，WebGazer 内部的 `tf.data.webcam` 还会再建一个）。Chrome 不报错，但内部 `cam.next()` 永远不 resolve → `begin()` 已 resolve（所以按钮都可用），**但预测循环永久卡在 `await` 上**。

这也解释了为什么"手势好、眼动死"：MediaPipe 读的是我们自己的 `#cam`（正常出帧），WebGazer 读的是它自己那个一直拿不到新帧的 video。

### 3.4 已经排除的假设

- ❌ 摄像头权限/占用：`摄像头 · 1280×720` 已证明有真实画面。
- ❌ 手势模型/分辨率：手势显示"就绪"，且 gesture-test 同参数实测很准。
- ❌ CSS `opacity:0` 或容器位置导致解码暂停：已改过一次（移出视口 → 视口内透明），现象不变。

---

## 4. 下一步计划

### 4.1 已落地：回到"单流单 video"，让 WebGazer 自己开流（✅ `d475f0c`）

> 下面是当时的改造清单，保留作回溯用。**当前代码已按此实现，不要再重复改一遍。**

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

### 4.3 眼动复测要产出的数据

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

### 4.6 独立 WebGazer 画板真机复测（Thriving-r）

`draw/index-3-hand.html` 只做过合成 landmark 验证，真实摄像头还欠五项：

1. 切到指尖笔尖后（按 `T`），食指指尖右移 → 屏幕笔尖是否右移；若反，先按 `H` 或加 `?fliphand=1`，**不要改镜像公式**。视线笔尖模式只需确认九宫格方向不反。
2. 慢速横 / 竖 / 圆是否还有可见抖动；滞后就先把 One Euro `beta` 从 0.02 调到 0.05。
3. 快速甩线是否断点 / 折角；必要时在相邻采样点之间补点（≤8px）。
4. 捏合阈值 0.45 / 0.60 是否灵敏、是否误触；实测后回写 `draw/index-3-hand-测试记录.md`。
5. **取流基线**：当前画板把 WebGazer 的 `getVideoElementCanvas()`（默认约 640×480）喂给手势模型，而 gesture-test 的黄金基线是 1280×720 自有 `<video>`。若上面几项怎么调都不稳，优先按 5.2 第 7/8 条改造取流，再谈阈值与平滑。

另外眼动版（已并入 `draw/index-3-hand.html`）的 9 点标定精度与视线九宫格手感，建议和 dual-test 一起真机复测。

---

## 5. 踩过的坑（绝对不要再踩）

### 5.1 眼动 / 摄像头（本轮踩得最狠的一类）

1. **WebGazer 的 video 不能 `display:none`，也不能移出视口**。浏览器会暂停该 video 的解码 → `getVideoElementCanvas()` 永远黑帧 → facemesh 检不到脸。当前做法是**留在视口内 + `opacity:0` + `pointer-events:none`**。这个坑已踩过三次。
2. **不要在 `webgazer.begin()` 之前自己开摄像头**。macOS 上"开流 → `stop()` → 立刻再开"极容易拿到**黑帧流**。所以：要么让 WebGazer 自己开（推荐），要么全程只开一次。
3. **绝不要让多个 `<video>` 消费同一条 `MediaStream`**（本次 0 fps 的根因）。Chrome 不报错，但媒体管线会静默卡住。
4. **`onGaze` 从未被调用 vs 回调返回 `null` 是两回事**，看 `视线` 灯的颜色区分（见第 3 节表格）。不要一看到"未检测到脸"就去查光照。
5. **标定时手要放下**。手挡在额头/眼前 → facemesh 完全无输出 → 看起来像"眼动坏了"。
6. 早期 `MediaPipe face_mesh` 的 WASM 曾出现 `Aborted`，旧演示因此改用 WebGazer。当前工作台使用 `shared/gaze/engine/face-engine.js` 的 MediaPipe Face Landmarker。

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

16. **`.deepworks/tmp/check_js_balance.py` 原本硬编码检查 `controller-demo/index.html`，忽略命令行参数**。所以过去几次"自检通过"其实检查的是另一个文件。**已改为读 `sys.argv[1]`**；若换机器重建脚本，务必保留这个行为，检查时**必须带目标文件路径**。注意：该脚本**不在仓库里**（`.deepworks/` 被 gitignore），本机当前也没有；没有它时用 `node --check` 或 macOS 自带 `jsc`（见下一条）。
17. **括号自检通过 ≠ 语法正确**。可用 JavaScriptCore 做真解析（macOS 自带）：
    `python3 - <<'PY'` 抽出 `<script type="module">` → 写成 `.mjs` → `/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc --module-file=xxx.mjs`。
    若报 `ReferenceError`（如 `URLSearchParams`/`document` 未定义）说明**语法已通过**，只是运行环境缺 DOM。
18. **先确认远程再推**：历史文档记录过两个远程 —— `origin`（团队）与 `jarvis`（个人 fork），当时裸 `git push` 会推到个人 fork。**本机克隆已只剩 `origin`**，upstream 为 `origin/main`；换机器/换克隆后先 `git remote -v` 和 `git branch -vv` 确认，推团队统一用 `git push origin main`。
19. **推送被拒先 rebase，绝不 force**：`git fetch origin && git rebase origin/main && git push origin main`。
20. **不要 `git add -A`**：`.deepworks/tmp/ssl/` 里有 `ca.key`/`server.key`，靠 `.gitignore` 忽略，误加就泄露。
21. **内网 IP 是 DHCP 动态的**，变过三次：`10.11.0.183 → 10.11.0.192 → 10.11.0.216`。IP 变了 `server.crt` 的 SAN 失效，要改 `ext.cnf` 重签并重启服务。
22. **运行时 DevTools 仍能读到前端实现**：之前提示过"纯前端无法防住别人看代码"，用户尚未答复是否接受。跨窗口通信的仓库隔离（Jarvis 代码不进 EPBL）是硬约束，**别把 `jarvis-scientist` 的实现写进 EPBL**。

### 5.5 协作

23. **别把"合成眼动 / hero 模板"当真实功能**：`gaze-pointer-lab.html`、`creative-developer-hero.html` 已删（不接摄像头、不跑模型）。`controller-demo/hero.html` 是被集成的真实功能（`?mode=hero`），保留。
24. **`draw/` 是 Thriving-r 的隔空画板**，真实 MediaPipe 隔空画板 + WebGazer，**不要删、不要大改**；`dual-test` / `gesture-test` 还共用它的模型和 wasm（见第 2 节"隔空画板"小节的契约）。

---

## 6. 运行方式 / 服务 / URL

### 启动服务（项目根目录）

| 服务 | 端口 | 命令 | 说明 |
|---|---|---|---|
| 工作台静态服务 | 8125 | `python3 scripts/serve.py 8125 .` | 绑定 `127.0.0.1`，开发时禁用缓存 |
| GazeFollower 画板 | 8789 | `draw/.venv/bin/python draw/gazefollower_server.py` | 绑定 `127.0.0.1`，提供画板页面和注视推理接口 |
| 内网 HTTPS | 8443 | `python3 .deepworks/tmp/ssl/https_server.py` | 白名单 `controller-demo`、`outputs`、`gesture-test`、`dual-test`、`draw`；根路径 302 → 主页面。**脚本和证书不进仓库，本机当前缺失，换机器需重建** |

> 浏览器摄像头需要安全上下文。本机可用 `127.0.0.1` 或 `localhost`，局域网访问需要 HTTPS。8789 是访问者设备自己的本机服务。

### 访问地址

| 用途 | 地址 |
|---|---|
| 主控制器 | `http://localhost:8125/controller-demo/index.html` ｜ 内网 `https://<内网IP>:8443/controller-demo/index.html` |
| 工作台 | `http://127.0.0.1:8125/workbench/index.html` |
| 眼动 + 手势测试台 | `http://127.0.0.1:8125/workbench/index.html#/dual-test` ｜ 独立对照 `http://localhost:8125/dual-test/index.html` |
| 手势测试台（精度基准） | `http://localhost:8125/gesture-test/index.html` |
| GazeFollower 隔空画板 | `http://127.0.0.1:8125/workbench/index.html#/draw` ｜ 直开 `http://127.0.0.1:8789/index-3-hand-gazefollower.html` |
| 独立 WebGazer 画板 | `http://localhost:8125/draw/index-3-hand.html` |
| 控制前端（眼动/手势采集） | `http://localhost:8125/control-frontend/index.html` |
| 手势切水果 | Python 版 `outputs/fruit-slice/`（纯前端 `gesture-fruit/` 已删除） |
| 信任证书（内网 HTTPS 用） | `https://<内网IP>:8443/ca.crt` |

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
| `workbench/modules.json`、`workbench/app.js`、`workbench/gaze-host.js` | 模块入口、iframe 生命周期、统一标定与摄像头交接 |
| `shared/gaze/` | Face Landmarker 引擎、标定协议、共享模型存储与 iframe 通信 |
| `dual-test/index.html` | 眼动和手势测试台，接收宿主模型，也可走 13 点 WebGazer 对照标定 |
| `gesture-test/index.html` | **手势精度的黄金基准**（约 633 行）：7 项测试、逐手势准确率、混淆矩阵、导出 JSON。用户实测"精度非常高" |
| `controller-demo/index.html` | 主控制器：WebGazer 集成、标定、意图吸附、dwell、手势状态机、`handBusyUntil` 防冲突。**眼动可用性的参照实现** |
| `controller-demo/vendor/webgazer/` | 已 patch 的 WebGazer 2.1.2 + 本地 `facemesh_model/`（**必须提交**） |
| `controller-demo/webgazer-gaze.html` | 眼动对照页，调 EMA / 磁吸参数用 |
| `controller-demo/hero.html` | 协作者 hero 视觉页（`?mode=hero`），保留 |
| `draw/index-3-hand-gazefollower.html`、`draw/gazefollower_server.py` | 工作台隔空画板页面和 8789 本机服务 |
| **`draw/index-3-hand.html`** | **独立 WebGazer 画板（Thriving-r）**：含 v3.0 眼动标定 + 默认视线九宫格笔尖（按 `T` 切食指指尖）+ 捏合 / 握拳落笔 + 拇指切工具 / 食指撤回，`AirCanvasKit` 移植自 dual-test |
| **`draw/index-3-hand-测试记录.md`** | 画板手势版的参数、7 项合成验证（6 通过 / 快线断点未压测）、回归红线与待真机复测清单 |
| **`draw/models/` + `draw/vendor/vision/`** | **共用资源**：`gesture_recognizer.task` + MediaPipe Vision wasm；gesture-test / dual-test 均以 `../draw/...` 引用，**别删别挪** |
| `control-backend/` | 控制后端（FastAPI + Playwright），`launcher.command` 一键起停；含 `test_control.py` 真实 Chrome 回读验证 |
| `control-frontend/` | 控制前端：眼动 + 手势采集，经 WebSocket 上报后端 |
| `outputs/fruit-slice/` | 手势切水果 Python 版（纯前端 `gesture-fruit/` 已删除） |
| `outputs/隔空控制器-工程蓝图.html` | 按阶段的工程蓝图（给人看） |
| `HANDOFF.md` | 本文件，新会话第一份要读 |
| `.deepworks/tmp/check_js_balance.py` | JS 括号自检脚本（gitignore），**必须带文件参数**；本机当前缺失，可用 `node --check` 替代 |
| `.deepworks/tmp/ssl/` | 内网证书 + HTTPS 服务器（**私钥，绝不提交**）；本机当前缺失，换机器需重建 |
| `eye-page-turner/demo/air-runner/` | 工作台跑酷模块，订阅宿主人脸与手部结果 |

---

## 8. Git 纪律（必须遵守）

- 提交前：`git status` → `git diff` 逐项确认，**不用 `git add -A`**。
- 推团队：`git push origin main`（不是裸 `git push`）。
- 被拒：`git fetch origin && git rebase origin/main && git push origin main`。
- **绝不 force push**。
- 提交信息用中文 `feat:/fix:/chore:` 前缀，与仓库现有风格一致。
- 提交后校验同步：`git rev-list --left-right --count origin/main...main` 应为 `0 0`（本机只有 `origin`；若克隆里还有 `jarvis`，再补一次 `jarvis/main...main`）。

### 最近提交链（倒序）

```
5e81f55 feat(draw): add standalone GazeFollower canvas              ← 当前 HEAD
57077e1 fix(gesture): 恢复工作台内手势识别
f98e729 fix(gaze): 撤掉错误的距离阈值缩放 + 标定结果内置诊断
0384b98 feat(gaze): 融合标定对齐 Alexia 1080p 采集基线
6bdf3ca feat(gaze): 统一标定改为摄像头弹窗 + 标准框头控，测试用百分制正确率
4aac8fc chore(release): 重建 v1.0.0 DMG，包含视线热力图模块
6b0dbd8 feat(workbench): 接入视线热力图模块，移除 hero 与旧控制器入口
e391064 style(workbench): 统一蓝黑色系配色
1005f6c feat(packaging): 控制小窗 py2app 打包与 DMG 流水线，启动器支持打包形态和首次自举
7ace9c3 feat(workbench): 新增统一工作台（侧栏 + 12 模块 + 下载中心 + 摄像头单实例互斥）
8b395e2 fix(vision): WebGazer facemesh 模型改用站点绝对路径，修复非 controller-demo 页面 404
432bf46 docs(outputs): 新增工作台与分发系统设计报告（架构/模块/选型/风险/实施步骤）
0268ec6 fix(control-backend): 静态服务仅绑定 127.0.0.1，避免工作台暴露到局域网
ed267ee chore(repo): 删除旧画板 draw/index.html 与 gesture-fruit（功能已并入/保留 Python 版）
ce68adc Merge remote-tracking branch 'origin/main'
6605ebd feat(vision): 摄像头采集分辨率提升到 1080p（dual-test + control-frontend）
0d87541 feat(control-backend): 启动器支持注入环境变量（AC_HOME 指定受控浏览器目标页）
3dc65aa docs(demo): 补全 fruit-slice / gesture-fruit / air-runner 的问题与未验证项
15ac93e docs: 更新交接文档（补充隔空画板进展与环境同步）
fb55ac0 docs(fruit-slice): 说明模型文件不入库、首次运行自动下载
de26556 docs: 新增协作规范 CONTRIBUTING 与 Issue/PR 模板
c6aaec7 feat(fruit-slice): 新增 Python 版手势切水果 demo
aecfae4 docs: 上传项目文档与阶段产出
30a2ca9 chore: 补充 .gitignore（node_modules / 构建产物 / 日志）
197b4d9 docs: 为 gesture-fruit 与 eye-page-turner/demo 补充 README
02b0e98 test(control-backend): 真实 Chrome 控制验证
7e9f21f feat(control-backend): 控制小窗改 pyobjc 原生实现 + 远程开关摄像头
0b91061 feat(control-backend): 新增控制小窗启动器
4854ce9 feat(control-backend): 控制后端落地 + 控制前端
f97708f docs: 控制后端系统设计报告 v2.0
c09e9cd feat(dual-test): 美化 UI + README
d475f0c fix(dual-test): 修复眼动失效并优化视线标定精度      ← 眼动修复点
e7f305a feat: 新增手部隔空画板并接入拇指切工具/食指撤回      ← Thriving-r
d192850 feat(gesture-fruit): 握拳暂停/继续 + 三态状态机
e89ea8a feat(demo): 隔空画画与星际跑酷 demo
127f151 feat(gesture-fruit): 手势切西瓜 demo
1963f71 docs: 重写交接文档（本文档旧版）
b5069b9 dual-test: 手势改为与 gesture-test 完全一致的取流方式（当时眼动坏了）
97b9e26 隔空画板 webgazer 版                                ← Thriving-r
1459999 feat: 隔空画板（视线笔尖/撤回/橡皮/双手平移/画布切换） ← Thriving-r
```

> 提示：`b5069b9` 的手势路线是对的，**不要整体回退**；眼动问题已在 `d475f0c` 按 4.1 修掉。

---

## 9. 环境备注

- 平台：macOS（darwin），shell：zsh。
- 工作区根（本机）：`/Users/liumenghan/Documents/EPBL`（旧文档写的 `/Users/xu/Desktop/PBL` 是另一台机器）。
- 工具链：**有 node v24.20.0**（项目本身仍是零构建）、Python 3.9.6、openssl、macOS 自带 `jsc`；无 deno / bun。
- DeepWorks Browser（Chrome DevTools 插件）可用，能做无摄像头的页面结构 / 控制台 / DOM 验证；摄像头、标定与手势手感仍需用户真机复测。
- `.gitignore` 已忽略：`.DS_Store`、`.opencode/`、`.deepworks/`、`opencode.jsonc`、`EyeControlApp/`、`uploads/`、`outputs/眼动追踪系统设计报告.html`、`node_modules/`、`dist/`、`build/`、`*.log`、`*.task`、`*.tflite`、`.venv/`。→ 换机器需手动重建 `https_server.py`、`ext.cnf`、证书、`check_js_balance.py`。
