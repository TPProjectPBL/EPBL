# 11 · 点击即训练 / 两点校正 / 尺寸变化

> 基线 `e59dc97`；2026-11-20 10:20–11:10

## 1. shared/gaze/online.js

从 `air-runner/lib/gaze-online.js` 迁移，常量原值保留：

| 常量 | 值 |
| --- | --- |
| `SAMPLE_POOL_MAX` | 48 |
| `RETRAIN_MIN_NEW` | 3 |
| `RETRAIN_MIN_GAP_MS` | 3000 |
| `GUARD_RATIO` | 0.15 |
| `GUARD_SLACK` | 0.01 |

新增：

- `CLICK_MAX_AGE_MS = 300`：特征必须新鲜。人脸刚丢时缓存的是旧帧特征，而标签是"现在点的元素"——不同步的样本比没有样本更坏。
- `noteClick({features, target, source, ts})`：
  - `source ∈ {calib, click, refine}`，其它值直接拒；
  - `target` 必须是 PAGE_NORM：0..1 且 `space` 不为空时必须等于 `PAGE_NORM`。像素坐标（如 `{x:800}`）会被 `isPageNorm` 挡掉；
  - 特征时间戳取 `features.ts` 或最近一次 `markFeatures()`；`ts - at > 300ms` 记 `stale-features`。
- `subscribe(cb)`：模型被安全阀放行后通知，`cb` 收到 `{status, model, prevErr, nextErr, n, trainer}`。
- 持久化：主键 `epbl.gaze.samples.v1`（数组，走 `store.saveSamples`），旧键 `air-runner.gazeSamples` **双写**（保留 `{v:1, clicks:[...]}` 旧格式，便于回滚）。
- 启动 hydrate：先读旧键，再用新键覆盖（新键代表更新的一次会话），`pending` 归零，不触发立即重训。

安全阀语义没动：新模型必须在**同一份样本集**上满足
`nextErr <= prevErr × (1.15) + 0.01`，否则 `status: 'rejected'`，线上模型保持不变。

## 2. shared/gaze/resize.js

- `watchViewport(cb, opts)`：监听 `resize`、`visualViewport.resize`、`matchMedia('(resolution: Xdppx)')`，**300ms 防抖**。
- 变化后用 `store.checkCompat(model, env)` 得到 `{level, diffs}`：
  - `exact` → 不提示（并清空签名，方便改回去再改回来时重新提示）；
  - `soft` → 顶部非阻塞条「窗口尺寸变了，建议做一次两点校正」+ [两点校正] [稍后]；
  - `hard` → 阻塞遮罩「请重新标定」+ [重新标定] [稍后]。
- 去重：`compatSignature()` = `level + 排序后的 diffs`，签名相同不重复弹；DOM 上同时只允许一个 `[data-gaze-compat-notice]`。
- 提示条是自建 DOM + 内联样式，**全部中性色**（`rgba(18,22,20,.92)` + 白字），不引用任何页面品牌色。

`installCompatGuard({getModel, onRefine, onRecalib})` 是给模块用的一站式入口。

## 3. shared/gaze/calibrate/two-point.js

- 复用 `Calibrator`，点表换成 `[{0.1,0.12}, {0.9,0.88}]` → **settle / collect / 中位数 / MAD 离群剔除与 9 点完全一致**。
- 两点尽量拉开，避免 `sx/sy` 被噪声放大。
- 流程：两点的采样特征 → `model.predict(f)` 拿模型空间坐标 → `refineWithTwoPoints(model, {p1, p2})`。
- 失败分支：
  - 采样不足 → 「采样不足，请再试一次」；
  - `reason === 'out-of-range'`（s 超出 `[0.85, 1.18]`）→ 「变化太大，请重新标定」，并显示实际 `s`；
  - 其它 → 「校正失败，请重新标定」。
- 成功时显示 `before.avgErr → after.avgErr`，并可 `applyRefine()` 直接落盘。

## 4. 四模块接入

统一用 `shared/gaze/attach.js` 的 `createGazeLearning()`，避免四份重复代码：

| 模块 | 采集点击 | 说明 |
| --- | --- | --- |
| air-runner | 是 | 原有 `noteGazeClick` 保留，导入换成 shared 版；坐标改用 `centerPageNorm` |
| gaze-heatmap | **否**（`collect: false`） | 它在做测量，点击位置不代表注视位置，收进来只会污染共享样本池 |
| draw | 是 | `installClicks(document)` 覆盖工具栏按钮；`applySharedGaze` 每帧喂特征 |
| dual-test | 是 | 特征来自宿主的 `bus.onLandmarks` 广播（本页不开流） |

### 顺手修掉的一个坐标 bug

air-runner 原来的标签是

```js
const tx = (r.left + r.width / 2) / window.innerWidth;
```

在 workbench 的 iframe 里，`innerHeight` 是 iframe 的高度（约 638），而模型目标是顶层页面（约 812）。**y 会系统性地被拉伸**，等于每个点击样本的标签都偏上。新的 `centerPageNorm()` 会沿 `frameElement` 逐层累加偏移、除以顶层视口尺寸。

### 为什么只收「明确可交互」的元素

`INTERACTIVE_SELECTOR` = `button / a[href] / input[button|submit|checkbox|radio] / select / summary / [role=button|link|tab|menuitem] / [data-gaze-target]`。

点在空白处时用户只是随手一点，眼睛未必看着那里——这类样本安全阀挡不住（它看起来"一致"），只能在源头排除。需要时用 `[data-gaze-target]` 给自定义元素开口子。

点击监听用 **capture** 阶段：点击常常切屏，切屏后元素矩形变 0，标签就错了。

### ?train=0

`attach.js` 默认读 URL 的 `?train=0`；关闭后 `online.enabled = false`，`noteClick` 返回 `{accepted:false, reason:'disabled'}`，样本池保持为空 ⇒ 数值路径与"从来没有点击样本"一致。

## 5. 验收结果

单测（`node --test shared/gaze/__tests__/online.test.mjs` / `resize.test.mjs`）：

```
online: 8 pass / 0 fail
resize: 6 pass / 0 fail
```

覆盖到的：

- 常量与文档一致；
- `isPageNorm` 拒绝像素/越界；
- 样本池 48 上限，标定样本不被淘汰；
- 攒够 3 条 + 间隔 ≥3s 才重训；**注入全部错标的 3 条点击 → `status: 'rejected'`**（安全阀生效，误差不上升）；
- `noteClick` 的四个拒绝分支（no-features / not-page-norm / stale-features / bad-source）；
- `?train=0` 后 `total===0 && nClick===0`；
- 新键 + 旧键双写，重载恢复 1 条；
- `subscribe` 在 accepted 时收到通知；
- resize 300ms 防抖（3 次触发 1 次回调）、同签名不重复、exact 后可重新提示、`stop()` 生效、无模型不回调。

### 没验到 / 缺口

1. **真机摄像头不投帧**（`videoWidth=0`），所以「改宽 100px → soft 提示 → 两点校正 → 误差回落 ±1%」这条端到端走不通：两点校正需要采到 2 组有效帧，设备不出帧时只会走到「采样不足」。逻辑层（防抖、提示、refine 的 s/t 求解与范围检查）已被单测与既有 `store.test.mjs` 覆盖。
2. **draw 的画布落笔点没接**：它和工具栏按钮的语义不同（落笔位置 ≠ 注视位置，笔尖有偏移），做成弱标签需要单独定义偏移模型，本轮只保留工具栏按钮。要开的话加 `?trainCanvas=1` 分支即可。
3. **10 次点击 → `diag.nClick` 增长**只在单测里验到 `nClick` 与模型更新回调；浏览器端因为设备不出帧，`features` 一直为空，点击会被 `no-features` 拒绝——这是设计上正确的行为（没有特征就不该有标签）。

## 6. 三项目眼动统一度（画板 / 热力图 / 跑酷）

| 维度 | 画板 | 热力图 | 跑酷 |
| --- | --- | --- | --- |
| 模型 | `epbl.gaze.model.v1` | 同 | 同 |
| 引擎实现 | `engine/face-engine.js` | 同 | 同 |
| 引擎参数 | `refineLandmarks:true`（默认） | 同 | 同 |
| 特征 | `core/features.js`（478 点含虹膜） | 同 | 同 |
| 坐标空间 | PAGE_NORM（顶层） | 同 | 同 |
| 9 点标定 | 宿主 | 宿主 | 宿主 |
| 两点校正 | 有 | 有 | 有 |
| 在线学习 | 采点击 | **不采**（设计） | 采点击 |
| 尺寸变化 | soft/hard | soft/hard | soft/hard |

有意保留的差异（不是 bug）：

- **谁持有摄像头**：画板为了手势自己开流（`declareExclusive`），另两个走宿主推理。
  两边的 `createFaceEngine()` 是同一份代码、同一组默认参数，所以**输出的 PAGE_NORM 数值等价**。
- **热力图不采点击**：它在做测量，点击位置不代表注视位置。
- **独立打开**（不经工作台）时各模块回退到自己开流，这是保底路径。

### 本轮补掉的一处不对称

画板 `applySharedGaze` 把 PAGE_NORM 转 client 时用的是 `window.innerWidth/innerHeight`。
在 iframe 里那是 iframe 自己的视口（536×647），而 `p` 是相对顶层页面（536×821）归一化的 →
**y 整体偏下约 87px**。已改为 `pageNormToClient()`（逐层扣 `frameElement` 偏移 + 顶层视口为基准）。

实测（工作台 536×821，iframe top=174.2）：

```
pageNormToClient({x:0.5,y:0.5}) → {x:268, y:236.30}
期望                            → {x:268, y:236.30}
旧算法                          → {x:268, y:323.40}   ← 偏下 87px
```
