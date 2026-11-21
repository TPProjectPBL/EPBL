# 14 · 工作台三段屏：首页 → 标定 → 空间导航

> 2026-11-20 17:20–18:05

原来的工作台是「侧栏 + 模块 iframe」直接进入某个模块。现在改成一条完整的入场动线：

```
#/            首页      单页 hero，只有一个「立即体验」
   ↓
#/calibrate   标定      整屏宿主标定，9 点，含摄像头小窗
   ↓（完成事件）
#/home        导航      2×2 田字卡片，视线停留 1.5s 进入
   ↓
#/<module>    子项目    原 iframe 视图 + 「返回导航」
```

## 路由

| hash | 视图 | 说明 |
| --- | --- | --- |
| `#/` 或空 | landing | 默认入口，不再自动恢复到上次的模块 |
| `#/calibrate` | calibrate | 调 `__epblGazeHost.startCalib()` |
| `#/home` | nav | 卡片网格 + 凝视选择 |
| `#/<moduleId>` | module | 原有 iframe 生命周期 |
| `#/releases` | releases | 下载中心（保留） |

未知 hash 一律回首页——不猜模块，避免地址栏写错就进了某个项目。

`body[data-view]` 切换时隐藏侧栏/顶栏/模块信息条，`setView()` 同时释放视线订阅。

## 首页

- 深色：网格 + 光晕 + 渐变标题；浅色：压深标题色、按钮改实心绿（`html[data-theme="light"]` 覆盖）
- 唯一主动作是 `#ctaStart` → `#/calibrate`
- 页脚常驻 `127.0.0.1:8125 · workbench`

## 标定屏

- `showCalibrate()` 会先等 `window.__epblGazeHost` 就绪（最多 3s）——`app.js` 先于 `gaze-host.js` 执行，
  不等就会误报「视线宿主没有加载」
- 标定 overlay 由宿主挂在 `#stage` 上，所以标定屏必须占满 stage
- 宿主那个 1px 隐藏 video 在标定时临时加 `.calib-video`，摆到右下角当小窗；离开视图由 `setView()` 摘掉类
- 失败原因走 `describeCalibError()` 映射成中文（摄像头拒绝 / 无画面 / wasm 被拦 / 引擎初始化）
- 宿主 `finishCalib()` 派发 `epbl:gaze-calibrated`，`ok` 则 1.5s 后自动跳 `#/home`，失败退回 `#/`

## 导航页

- 卡片来自 `modules.json`，预览图约定 `assets/preview-<id>.jpg`（1400×875）
- 田字：`grid-template-columns:1fr 1fr` + `grid-template-rows:1fr 1fr`；
  窗口 ≤640px 退化为单列（可滚动）
- 凝视选择（`startDwell`）：
  - 宿主 `onGaze(cb)` 每帧推页面归一化坐标（`pushLocalGaze` → `model.predict(extractFeatures(lm))`）
  - 命中判定用卡片 `getBoundingClientRect()`
  - 停留累计 `DWELL_MS = 1500`，离开后按 `DWELL_DECAY = 1.8` 倍率回落
  - 进度画在卡片中央的 SVG 圆环上（`pathLength=100` + `stroke-dashoffset`）
  - 走满 → `location.hash = '#/' + id`
  - 没有模型时退回鼠标位置，只显示光标不触发进入
- 无模型/过期时右上角 pill 显示「尚未标定 / 模型已过期」，仍可点卡片进入

## 宿主侧新增

```js
__epblGazeHost.onGaze(cb)   // 工作台自身订阅（不走 iframe），返回取消函数
__epblGazeHost.offGaze(cb)
__epblGazeHost.getGaze()    // {x,y,conf,ts} | null
__epblGazeHost.getVideo()   // 标定用 video 元素
```

`startInference()` 的两条循环（SIM / 摄像头）在广播 landmarks 之后调用 `pushLocalGaze(lm)`，
只对本地订阅者生效；`localSubs` 为空时零开销。

## 预览图怎么来

```bash
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CH" --headless=new --disable-gpu --hide-scrollbars --window-size=1200,750 \
  --virtual-time-budget=7000 --screenshot=dual-test.png \
  http://127.0.0.1:8125/dual-test/index.html
# 再 sips -Z 1400 → 转 jpeg(q80) → workbench/assets/preview-<id>.jpg
```

## 已知限制

- SIM 模式标定结束时视线停在最后一个点（0.9, 0.88），正好落在右下角「星际跑酷」卡片上，
  1.5s 后会自动进入——这是选择逻辑正确，不是 bug；真机人眼会离开。
- 标定失败时宿主 modal 与页面 hint 会同时出现，文案有重复。
- 进入模块后顶栏「标定视线」改为跳 `#/calibrate`（overlay 挂在 stage 上，iframe 会盖住它）。

## 标定流程：直接复用 air-runner 的 9 点（2026-11-20 三改）

工作台不再自建「就位引导 → 鼠标点靶点 → 预览拟合」那套，改为照搬
`eye-page-turner/demo/air-runner` 的 `gc-*` 流程：

- 9 个靶点，相对位置 `[0.1|0.5|0.9] × [0.12|0.5|0.88]`；
- `settleMs: 350` / `collectMs: 1200` / `minFrames: 6`，与 air-runner 完全一致；
- **注视即采样**，不需要点鼠标（`requireClick` 已移除）；
- 当前靶点放大 1.6 倍（32 → 51px）+ conic 细环表示采样进度，完成的点变绿；
- 标定阶段**不画预测光标**——原实现也没有，只有靶点与进度；
- 12 秒内检测不到人脸就退出并提示（`Calibrator` 自身没有超时，照 air-runner 的
  `waitForEyes` 补的兜底）。

标定完成后仍做 5 点留出测试（不参与训练），这一段画模型预测的十字落点，
所以「光标跟不跟」在测试阶段可以直接看出来。

### 已移除的自造物

- `guidePhase`（就位引导页、虚线推荐框、距离/居中/俯仰三态）整段删除；
- `roughCursor` / `refreshPreviewModel` / `fitPreview` 调用删除；
- `shared/gaze/guide-gate.js`、`shared/gaze/calibrate/preview.js` 及其单测文件暂时保留，
  但已无任何引用，`smoke-workbench.sh` 也不再执行它们。

### 为什么之前会「光标不跟」

`GazeCalibModel.fit` 要求 `MIN_SAMPLES = 8`（[features.js](../../shared/gaze/core/features.js#L49)）。
9 点流程里前 8 个点没有模型，自造的 `roughCursor` 只是一个和屏幕位置无关的固定增益映射，
看起来就是「光标不动」。原实现根本不画这个光标，所以没有这个问题——照搬即修复。
