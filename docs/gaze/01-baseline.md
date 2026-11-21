# 手眼标定现状基线（Step 1）

- 日期：2026-11-19
- 范围：`EPBL-latest/`（工作台 + 控制台 + 热力图 + 画板 + 跑酷 + 测试台）
- 性质：**只读审计**。除只读探针外，未改变任何页面行为、配色或标定流程。
- 配套数据：[01-baseline.csv](./01-baseline.csv)

---

## 0. 本轮拉取与校验

远端再次强制推送，本轮记录：

| 项 | 值 |
|---|---|
| 拉取前 HEAD | `bcc2f61` + 本地脚本提交 `f09ea74` |
| 拉取后 HEAD | `0188dd5` |
| 本地提交处理 | `f09ea74` 重放为 `00ea85e`（`chore(scripts): 新增拉取最新融合版与完整性校验脚本`） |
| 本地页面改动 | 18 个文件全部重放，`.rej` 数量 = 0 |
| 四模块校验 | 通过 |

`verify-bundle.sh` 实际输出：

```text
==> HEAD: 00ea85e (main)
==> 基础文件
==> 模块（workbench/modules.json）
   ok  dual-test -> ../dual-test/index.html
   ok  gaze-heatmap -> ../gaze-heatmap/index.html
   ok  draw -> ../draw/index-3-hand.html
   ok  air-runner -> ../eye-page-turner/demo/air-runner/index.html
==> 校验通过：控制台 / 热力图 / 画板 / 跑酷 均在
```

> 提醒：`pull-latest.sh` 目前只备份**已跟踪文件的工作区改动**，不备份**未推送的本地 commit**。这次是先手动 `format-patch` 保住 `f09ea74` 再 reset 的。脚本本身需要补这个保护（见第 7 节）。

---

## 1. 审计方法

### 1.1 静态审计

逐个读取入口的脚本，记录：标定点数与坐标来源、跟踪引擎、特征、回归、输出坐标、持久化、质量指标、容器依赖、镜像层。

### 1.2 运行时只读探针

新增 [audit-probe.js](../../shared/gaze/audit-probe.js)，只做两件事：

1. 定义 `window.__makeGazeAudit(cfg)` 工厂；
2. 由各页在自己的作用域内把局部变量以 getter 形式交给它。

探针约束：

- 只读，不触发渲染、请求、标定或写 `localStorage`；
- 模型只返回摘要（`terms/quality/created`），不返回 `wx/wy` 与样本数组；
- 整体开关：`shared/gaze/audit-probe.js` 第 13 行 `GAZE_AUDIT_ENABLED = false`，或提前设置 `window.__GAZE_AUDIT_OFF = true`。

浏览器实测（`?v=audit1`，2026-11-19）：7 个入口全部返回结构化对象；工作台内嵌的 iframe 也能被父页读取：

```js
// 父页
window.__gazeAudit()
// 读取 iframe 内的探针
document.querySelector('iframe').contentWindow.__gazeAudit()
```

---

## 2. 总表

| 入口 | 点数 | 跟踪引擎 | 输出坐标 | 持久化 | 质量门 | 镜像 |
|---|---|---|---|---|---|---|
| controller-demo | 9 | WebGazer 2.1.2（468） | screen px（吸附后） | 无 | 无 | 无 |
| control-frontend | 0（无标定 UI） | WebGazer 2.1.2 | page-norm | 无 | 无 | 无 |
| dual-test | 13 | WebGazer 2.1.2 | screen px | 无 | 仅统计 | 无 |
| gaze-heatmap | 9 + 5 校验 | WebGazer 2.1.2 | screen px → stage px | 无 | 仅校验展示 | 无 |
| draw | 9 | WebGazer 2.1.2 | page-norm（画布） | WebGazer 内部 | 无 | **有（1-x）** |
| air-runner | 9 | MediaPipe FaceMesh 478（CDN） | page-norm | `air-runner.gazeModel` | **有（LOO/敏感度/退化）** | 无 |
| workbench | — | 无（宿主） | — | `ac.workbench.*` | — | — |

---

## 3. 逐入口明细

### 3.1 controller-demo（隔空控制器 · 测试台）

| 项 | 内容 |
|---|---|
| 标定点 | 9 点，`CALIB_POINTS`（[index.html](../../controller-demo/index.html#L546)），坐标是视口百分比 |
| 坐标来源 | `p.x * innerWidth`、`p.y * innerHeight` |
| 引擎 | WebGazer 2.1.2，本地 vendor，468 点 facemesh |
| 特征 / 回归 | WebGazer 内部眼特征 + ridge |
| 训练调用 | `webgazer.recordScreenPosition(cx, cy, "click")`（[index.html](../../controller-demo/index.html#L566)） |
| 输出 | `S.cursor`（[index.html](../../controller-demo/index.html#L302)），屏幕像素，且是吸附后的值 |
| 持久化 | 无。没有 `saveDataAcrossSessions(true)`，刷新即丢 |
| 质量指标 | 无；只有调试日志 |
| 容器依赖 | 视口 |
| 镜像 | 无 |
| 探针 | `page=controller-demo`、`coord=screen-px`、`points=9`、`lastGaze=S.cursor` |

### 3.2 control-frontend（隔空控制器 · 控制前端）

| 项 | 内容 |
|---|---|
| 标定点 | **0**。没有标定 UI，直接消费 WebGazer 当前回归 |
| 引擎 | WebGazer 2.1.2 |
| 输出 | `S.gx/S.gy`，页面归一化 0..1（[index.html](../../control-frontend/index.html#L294)），再做 EMA 平滑后 `backend.sendCursor` |
| 持久化 | 无（自身不写；是否蹭到其他页的 WebGazer 全局缓存取决于同源与加载顺序，不可依赖） |
| 质量指标 | 无 |
| 容器依赖 | 视口 |
| 镜像 | 无 |
| 探针 | `page=control-frontend`、`coord=page-norm`、`points=0`、`lastGaze={S.gx,S.gy}` |

> 这是"隐式依赖"最危险的一页：它自己不做标定，却假设别处已经训好了 WebGazer。

### 3.3 dual-test（眼动光标 + 手势控制 · 测试台）

| 项 | 内容 |
|---|---|
| 标定点 | **13 点**，`CALIB`（[index.html](../../dual-test/index.html#L695)）：3 + 2 + 3 + 2 + 3 |
| 引擎 | WebGazer 2.1.2 |
| 训练调用 | `recordScreenPosition`（[index.html](../../dual-test/index.html#L728)） |
| 输出 | `S.cursor`，屏幕像素（[index.html](../../dual-test/index.html#L433) 附近） |
| 质量指标 | `S.gaze.errs`（像素误差集合），只展示、无门槛 |
| 持久化 | 无 |
| 容器依赖 | 视口 |
| 镜像 | 无 |
| 探针 | `page=dual-test`、`coord=screen-px`、`points=13`、`quality=S.gaze.errs` |

> 13 点是现有实现里覆盖最广的点阵，后续统一验收应直接复用它作为"发布基准"。

### 3.4 gaze-heatmap（视线热力图工作台）

| 项 | 内容 |
|---|---|
| 标定点 | 9 点，`CALIB_FALLBACK`（[app.js](../../gaze-heatmap/app.js#L1689)）按舞台矩形缩放（[app.js](../../gaze-heatmap/app.js#L1855)）；运行期 `calibPoints`（[app.js](../../gaze-heatmap/app.js#L1694)） |
| 引擎 | WebGazer 2.1.2 |
| 训练调用 | `window.webgazer.recordScreenPosition`（[app.js](../../gaze-heatmap/app.js#L1965)） |
| 输出 | `S.gaze` 是**屏幕 client px**（[app.js](../../gaze-heatmap/app.js#L985)）；统计时才 `clientToStage`（[app.js](../../gaze-heatmap/app.js#L657)）转成舞台坐标 |
| 舞台 rect | `S.stageRect` 来自 `el.stage.getBoundingClientRect()`（[app.js](../../gaze-heatmap/app.js#L624)） |
| 质量指标 | 5 点留出校验，`S.validationResults`（[app.js](../../gaze-heatmap/app.js#L2248)），**单位是舞台 px**，无硬门槛 |
| 持久化 | 无 |
| 容器依赖 | `#stage` 矩形 + `STAGE_W` 缩放系数 |
| 镜像 | 无 |
| 探针 | `page=gaze-heatmap`、`coord=screen-px`、`points=calibPoints 长度（缺省 9）`、`quality=S.validationResults` |

> 关键点：`S.gaze` 与 `S.validationResults` **不是同一个坐标空间**。前者 screen px，后者 stage px。任何"统一误差"必须先声明在哪个空间。

### 3.5 draw（隔空画板 Air Canvas v3.0）

| 项 | 内容 |
|---|---|
| 标定点 | 9 点，`CALIB_POINTS`（[index.html](../../draw/index-3-hand.html#L2346)） |
| 引擎 | WebGazer 2.1.2 |
| 训练调用 | `wg.recordScreenPosition`（[index.html](../../draw/index-3-hand.html#L2368)） |
| 输出 | `state.penX/penY`，画布【屏幕】归一化 0..1（[index.html](../../draw/index-3-hand.html#L2510)），再 `screenToWorldX/Y` 转世界坐标 |
| 镜像 | **有**：`raw.gazeX = 1 - clamp01(s.x / vw)`（[index.html](../../draw/index-3-hand.html#L1865)）；另有手部/预览两处 `1 - clamp01`（1576、1581、1800 附近） |
| 持久化 | **有，但是 WebGazer 内部**：`saveDataAcrossSessions(true)`（[index.html](../../draw/index-3-hand.html#L2446)），键与格式由 vendor 管理，不是我们的 v1 schema |
| 质量指标 | 无 |
| 容器依赖 | 画布 `cssW/cssH`，与视口解耦 |
| 探针 | `page=draw`、`coord=page-norm`、`points=9`、`lastGaze={penX,penY}` |

> 画板是唯一"模型能跨刷新存活"的 WebGazer 页面，但它存的是 vendor 私有格式，且输出已经镜像。统一接入时这是最容易出现"左右反"的一页。

### 3.6 air-runner（河流跑酷 · 眼动 + 手势）

| 项 | 内容 |
|---|---|
| 标定点 | 9 点，`GC_POINTS`（[app.js](../../eye-page-turner/demo/air-runner/app.js#L64)），相对 `#gazeField` |
| 引擎 | MediaPipe **FaceMesh 478 点（含虹膜）**，CDN + `refineLandmarks` |
| 特征 | `extractFeatures`（[gaze-calib.js](../../eye-page-turner/demo/air-runner/lib/gaze-calib.js#L446)）：`dLx/dLy/dRx/dRy/faceCx/faceCy/eyeDist/roll` |
| 回归 | `GazeCalibModel.fit`（[gaze-calib.js](../../eye-page-turner/demo/air-runner/lib/gaze-calib.js#L669)）：岭回归 + λ 网格 + 1-SE + 留一 + 敏感度门 + 退化门 |
| 输出 | 页面归一化 0..1，`AbsoluteGazeSource`（[gaze-calib.js](../../eye-page-turner/demo/air-runner/lib/gaze-calib.js#L958)） |
| 持久化 | `localStorage['air-runner.gazeModel']`（[app.js](../../eye-page-turner/demo/air-runner/app.js#L47)），`state.gazeModel`（[app.js](../../eye-page-turner/demo/air-runner/app.js#L114)） |
| 质量指标 | `model.quality`：`avgErr/maxErr/grade`，另有 `diag.sensWorst` |
| 容器依赖 | `#gazeField` 全屏矩形（iframe 内即 iframe 视口） |
| 镜像 | 无（特征来自未镜像帧） |
| 探针 | `page=air-runner`、`coord=page-norm`、`points=9`、`model=state.gazeModel` 摘要、`quality=model.quality` |

> 这是目前唯一"模型可序列化 + 有质量门 + 有在线学习"的实现，也是统一标的。注意它依赖 CDN 的 legacy FaceMesh，断网不可用。

### 3.7 workbench（工作台 · 宿主）

| 项 | 内容 |
|---|---|
| 标定 / 采集 | 无。它只负责 iframe 生命周期（`activate`，[app.js](../../workbench/app.js#L199)） |
| 布局 | 左侧栏 `--side-w: 264px`（[style.css](../../workbench/style.css#L8)），stage 为剩余区域（[style.css](../../workbench/style.css#L133)） |
| 持久化 | `ac.workbench.theme`、`ac.workbench.last`（UI 状态，与眼动无关） |
| 探针 | `page=workbench`、`engine=none`、`points=0`、`lastGaze=null` |

> 尺寸问题的根在这里：stage 不是整窗，左边有 264px 侧栏。如果标定点按整窗百分比排，iframe 内只看得到点阵的右半边。

---

## 4. 探针清单

| 页面 | HTML 引用 | 状态注入位置 | 可读字段 | 已知限制 |
|---|---|---|---|---|
| controller-demo | `index.html` 内联脚本前 | IIFE 末尾 | 9 点、screen px、`S.cursor` | 读不到 WebGazer 内部权重 |
| control-frontend | module 前 | module 末尾 | 0 点、page-norm、`S.gx/gy` | 无标定，模型字段恒为 null |
| dual-test | module 前 | module 末尾 | 13 点、screen px、`S.gaze.errs` | 误差是像素，不是归一化 |
| gaze-heatmap | `app.js` 前 | IIFE 末尾 | 9 点、screen px、校验结果 | 质量结果单位是舞台 px |
| draw | vendor 前 | IIFE 末尾 | 9 点、page-norm、`penX/penY` | `penX/penY` 已含 1-x 镜像 |
| air-runner | module 前 | `app.js` 末尾 | 9 点、page-norm、模型摘要 | 依赖 CDN，断网时探针仍可用但引擎不可用 |
| workbench | `app.js` 前 | `app.js` 末尾 | 宿主信息 | 自身无眼动 |

使用方式：

```js
// 任意页面
window.__gazeAudit()

// 工作台里读当前 iframe
document.querySelector('iframe').contentWindow.__gazeAudit()

// 全局关闭（刷新后仍生效需改文件里的常量）
window.__GAZE_AUDIT_OFF = true
```

返回结构：

```json
{
  "page": "air-runner",
  "engine": "mediapipe-face-mesh-478",
  "model": { "schema": null, "created": null, "terms": null, "quality": null },
  "points": 9,
  "coord": "page-norm",
  "lastGaze": { "x": 0.32, "y": 0.42, "live": true, "ts": 0 },
  "quality": null,
  "note": null,
  "ts": 1795099303600,
  "probe": 1
}
```

---

## 5. 真机基线操作单（1 轮）

> 逐页点哪里、误差在哪读、控制台一键采集命令、常见坑：见 [02-real-baseline-howto.md](./02-real-baseline-howto.md)。

固定条件（不满足就别开始，否则数据不可比）：

- 同一台机器、同一浏览器、同一窗口尺寸（记录 `innerWidth × innerHeight` 与 `devicePixelRatio`）；
- 同一坐姿、椅子高度、屏幕距离；
- 同一光照，不逆光；
- 摄像头分辨率固定（记录 `videoWidth × videoHeight`）；
- 每个页面独立标签、独占前台。

每页步骤：

1. 打开页面，等摄像头/模型就绪；
2. 完整做一次该页自己的标定（control-frontend 跳过）；
3. 记录页面自己显示的误差（若有），截图；
4. 在控制台执行 `window.__gazeAudit()`，把返回 JSON 存下来；
5. 填 `01-baseline.csv` 对应行。

CSV 字段：

| 列 | 含义 | 示例 |
|---|---|---|
| `page` | 入口名 | `gaze-heatmap` |
| `engine` | 引擎 | `webgazer-2.1.2` |
| `points` | 标定点数 | `9` |
| `avg_err` | 页面自报平均误差 | `46` |
| `max_err` | 页面自报最大误差 | `88` |
| `unit` | 误差单位 | `stage-px` / `screen-px` / `page-norm` |
| `viewport` | 视口 | `1440x900` |
| `dpr` | 设备像素比 | `2` |
| `notes` | 备注 | `已做 5 点校验` |

> CSV 里的 `pending` 表示尚未实测，不要当成数值使用。

---

## 6. 三个最高风险点

### 风险 1：同一份"注视点"有四种坐标语义，直接共享必偏

- 热力图：`S.gaze` 是屏幕 px（[app.js](../../gaze-heatmap/app.js#L985)），统计时才转舞台坐标（[app.js](../../gaze-heatmap/app.js#L657)）；
- 画板：`raw.gazeX` 先做 `1 - x/vw`（[index.html](../../draw/index-3-hand.html#L1865)），`penX` 是镜像后的画布归一化（[index.html](../../draw/index-3-hand.html#L2510)）；
- 跑酷：模型直接输出页面归一化（[gaze-calib.js](../../eye-page-turner/demo/air-runner/lib/gaze-calib.js#L958)），无镜像；
- 控制台：`S.cursor` 是吸附后的屏幕 px（[index.html](../../controller-demo/index.html#L302)）。

**后果**：把跑酷模型直接塞给画板，会出现左右反 + 比例错；塞给热力图，会差一个 stage 偏移。必须先冻结 `PAGE_NORM` 契约，再逐页接适配器。

### 风险 2：标定点阵的参照物不一致，尺寸一变就系统性偏移

- 热力图按 `stageRect` 排点（[app.js](../../gaze-heatmap/app.js#L624)），且要乘 `STAGE_W` 缩放；
- 跑酷按 `#gazeField` 排点（[app.js](../../eye-page-turner/demo/air-runner/app.js#L64)），在 iframe 内就是 iframe 视口；
- 控制台与测试台按整窗百分比排点（[index.html](../../controller-demo/index.html#L546)、[index.html](../../dual-test/index.html#L695)）；
- 工作台 stage 左侧还有 264px 侧栏（[style.css](../../workbench/style.css#L8)、[style.css](../../workbench/style.css#L133)）。

**后果**：同一个 9 点模型，在全屏和 iframe 内不是同一个物理映射。窗口/侧栏/缩放一变，误差不是抖动，是整体平移或缩放。

### 风险 3：模型资产不可迁移，且只有跑酷一份是"真资产"

- WebGazer 系四页都不写我们可读的模型（controller / control-frontend / dual-test / heatmap 均无）；
- 画板唯一的持久化是 vendor 私有的 `saveDataAcrossSessions(true)`（[index.html](../../draw/index-3-hand.html#L2446)），换引擎就失效；
- 跑酷写 `air-runner.gazeModel`（[app.js](../../eye-page-turner/demo/air-runner/app.js#L47)），但引擎是 CDN legacy FaceMesh，断网不可用。

**后果**：现在没有"一份模型四处可用"的物理载体。统一的第一步不是改算法，而是把跑酷模型 schema 化、把引擎本地化。

---

## 7. 结论与下一步

结论：

1. 现状不是"三套标定"，而是 **5 套标定 + 1 个无标定入口**（control-frontend）；
2. 只有跑酷这份模型具备跨页复用的必要条件（可序列化 + 有质量门 + 有诊断），但它依赖 CDN 引擎；
3. 尺寸问题的根因是"标定点阵的参照物不一致"，不是"归一化没做"；
4. 画板的 `1 - x` 是独立的第二层镜像，必须在统一时显式处理。

下一步（对应总方案）：

- Step 2：冻结 `PAGE_NORM` / 误差 / 镜像 / 存储契约；
- Step 3：把跑酷算法抽成 `shared/gaze/core/`，行为逐位不变；
- Step 4：换成本地 478 点 FaceLandmarker，保留 `?engine=legacy`；
- Step 6~8：统一存储、坐标适配器、工作台标定入口。

同时建议修一个工具问题：`scripts/pull-latest.sh` 在 reset 前应检测"本地领先 FETCH_HEAD 的 commit"，先 `git bundle` 或 `format-patch` 备份，否则未推送提交会被静默清掉。本轮已手工规避，但脚本本身还没改。
