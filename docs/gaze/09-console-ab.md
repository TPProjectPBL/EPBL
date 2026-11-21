# 09 · 控制台三页接入共享模型（controller-demo / control-frontend / dual-test）

> 基线：`e59dc97`（`scripts/pull-latest.sh` 报告 already up to date）
> 时间：2026-11-20 01:20–01:40
> 环境：`python3 -m http.server 8125 --directory EPBL-latest`，视口 536×812（dpr 2）

## 1. 做了什么

新增 [page-bridge.js](../../EPBL-latest/shared/gaze/page-bridge.js)，三页共用：

| 能力 | 说明 |
| --- | --- |
| `gazeMode()` | `?gaze=legacy` → `legacy`；否则有共享模型 → `shared` |
| `readSharedModel()` | 读 `epbl.gaze.model.v1`（store.js，schema 1） |
| `startSharedGaze()` | 自建摄像头流 → FaceLandmarker → `AbsoluteGazeSource` → PAGE_NORM；`video`/`canvas` 可直接复用手势 |
| `subscribeModel()` | `bus.js` hello + 模型广播，按 `sig`（缺省用 `created`）去重 |
| `requestHostCalib()` | iframe 内向宿主发 `epbl:gaze-calib-request` |
| `errorPair()` / `fmtErr()` | 归一化 + px 双单位，px 走 `errToPx(err,w,h)=err*hypot(w,h)` |

三页改动：

1. **controller-demo/index.html**
   - 新增 ESM 桥（`window.__epblPageBridge`），classic IIFE 运行时取用。
   - `init()` 先试 `startSharedMode()`；成功则 **不启动 WebGazer**（同一时刻只有一套预测写光标）。
   - 失败或无模型 → 原 WebGazer 链路（代码未删）。
   - 9 点标定：shared 模式下改为 `requestHostCalib()`（宿主标定一次，本页自动应用）；
     独立打开 / `?gaze=legacy` 仍用原 overlay。
   - 光标 pill 在 shared 模式下显示「共享模型」。
2. **control-frontend/index.html**
   - 原本没有标定 UI：默认 shared，直接读模型。
   - 无模型时在日志区给可点链接「请先到工作台完成标定」，并附 `?gaze=legacy` 回退说明。
   - 手势与眼动共用同一路 `video`（不再由 WebGazer 开流）。
3. **dual-test/index.html**
   - 13 点标定保留，定位为 **WebGazer 对照**。
   - 新增「共享模型 · 13 点校验」按钮：只读共享模型，跑同一组 13 点，
     每点 400ms 稳定 + 1200ms 采样，输出每点与汇总的 avg/max（归一化 + px）。
   - 结果面板新增一块表格，导出 JSON 增加 `shared` 与 `gazeMode`。

`workbench/gaze-host.js` 已有 `epbl:gaze-calib-request` 监听（上一轮补的），本轮未改。

## 2. 模式矩阵

| 页面 | 默认（有模型） | 无模型 | `?gaze=legacy` |
| --- | --- | --- | --- |
| controller-demo | shared 驱动光标，标定按钮→请求宿主 | 回退 WebGazer 9 点 | WebGazer 9 点 |
| control-frontend | shared 驱动光标 | 提示去工作台标定 + 跳转 | WebGazer |
| dual-test | shared 驱动光标 + 共享 13 点校验 | 回退 WebGazer 13 点标定 | WebGazer 13 点标定 |

## 3. 实测结果

### 3.1 真机摄像头限制

本机 `getUserMedia` 能拿到 track、权限 `granted`、有 1 个 `videoinput`，
但 `<video>` 永远是 `videoWidth=0`（air-runner / draw / 本轮三页一致）。
因此 **真实精度未测**：下面的数据来自「注入 PAGE_NORM」，验证的是坐标链路与统计口径，不是模型精度。

顺带发现并修掉一个真 bug：`startSharedGaze` 原先 `await video.play()`，
无帧设备上该 Promise 永不 resolve，整条启动链卡死（页面停在「检测库加载中」）。
改为不 await，靠 `videoWidth` 判定帧是否到达。

### 3.2 共享模型加载

| 页面 | `mode` | shared.on | 模型 | 备注 |
| --- | --- | --- | --- | --- |
| controller-demo | shared | true | 已读到 | 摄像头 pill 亮，无帧→face pill 暗 |
| control-frontend | shared | true | 已读到 | 手势就绪，复用同一 video |
| dual-test | shared | true | 已读到 | 「共享模型 · 13 点校验」按钮可用 |

### 3.3 dual-test 13 点校验（注入偏移 18px / 12px）

```text
点数     13 / 13（无样本 0）
平均     3.67 % · 36 px
最大     3.67 % · 36 px
耗时     24.8 s
```

核对：`hypot(18/536, 12/812) = 0.03669` → `0.03669 × hypot(536,812) = 35.7px`，与面板一致。
14 个点全部命中同一偏移，说明逐点采样、均值、双单位换算三段都正确（该项是固定偏移的回归测试，不是精度结论）。

### 3.4 坐标方向检查（左右反 / 上下反）

三页均用「连续注入 25 帧 → 读光标」：

| 页面 | 左注入 | 右注入 | 上注入 | 下注入 | 结论 |
| --- | --- | --- | --- | --- | --- |
| controller-demo | x=118 | x=414 | y=170 | y=676 | 正常 |
| control-frontend | (0.200, 0.600) | (0.782, 0.309) | — | — | 正常 |
| dual-test | x=86 | x=457 | y=110 | y=689 | 正常 |

**没有出现左右反或上下反**，按任务要求继续完成，未触发停止条件。
（controller-demo 的数值受 70px 磁吸 + 惯性影响；control-frontend 的 0.782 是 EMA=0.16 未完全收敛，方向正确。）

## 4. 单一模型源核对

- controller/dual-test：shared 成功时不调用 `webgazer.begin()`，也不注册 `setGazeListener`。
- control-frontend：shared 路径完全不碰 webgazer，摄像头由 `page-bridge` 单独开。
- 页面上的 `__gazeAudit.engine()` 现在返回 `shared | webgazer`，审计脚本可直接区分。

## 5. 未完成 / 风险

1. **真实精度未测**：摄像头不投帧。需要在能出帧的机器上重跑：
   - 工作台标定一次 → 三页各跑一遍 13 点/9 点校验 → 把真实 avg/max 填进本文件 §3.3。
2. **WebGazer 与共享模型的回退切换需要刷新**：模型源在 `boot()` 时决定，运行中不热切（避免两套预测同时写光标）。
   模型**更新**是热的（`subscribeModel` → `setModel`）。
3. controller-demo 的 hero 模式在 shared 下走 `heroSend(clientPx - iframeOffset)`，逻辑未改；真机未验。
4. `?gaze=legacy` 下三页行为与改动前一致（controller-demo / dual-test 已验证按钮与模式分支）。
