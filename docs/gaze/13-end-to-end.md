# 13 · 「标定 → 模型 → 校验」端到端打通

> 2026-11-20 12:40–13:10

## 链路

```
热力图点「9 点标定」
  → postMessage epbl:gaze-calib-request
  → 宿主 startCalib()：摄像头（或模拟帧）→ Calibrator → overlay 9 点
  → 每点采集：medianSample + headPose 中位数
  → _fit()：GazeCalibModel.fit → model.headRef
  → saveModel（白名单含 headRef）→ broadcastModel
  → 热力图 applySharedModel：hostedSource.setModel + S.headRef + 质量卡变「共享模型已就绪」
热力图点「校验准确度」
  → startValidation()（宿主模式放行）
  → 5 个留出点 × 1200ms，只计 head.ok && refOk && !blink 的帧
  → 报告：avg / max / frames / 每点误差 / 等级
```

## 本次修掉的 6 个断点

| # | 症状 | 根因 | 修法 |
| --- | --- | --- | --- |
| 1 | 标定按钮点不动 | 按钮 disabled（`engine !== 'webgazer'`）且绑的是 `openGuide` | 宿主内保持可用，直接转发标定 |
| 2 | 标定启动失败一次后永久失效 | `startCalib` catch 里没复位 `S.busy` | catch 中 `S.busy = false` |
| 3 | 标定停在 9/9 | `medianHead` 用了未 import 的 `median` | 补 import；`_fit` 加 try/catch + `onError` |
| 4 | 广播只有 subs 没有帧 | `onLandmarks` 不发 `hello()`，宿主 `ready` 为空 | 订阅即 hello（与 `onHands` 一致） |
| 5 | 模拟模式不出 landmarks | 推理循环要求 `videoWidth` | 加 SIM 分支，按 `INFER_MS` 广播合成帧 |
| 6 | 校验全判无效 | 合成人脸框只有 0.09 高，低于 `distMin 0.22` | 模拟帧等比放大 2.6×（比值特征不变） |

## 实测（SIM）

```
标定：grade good · avgErr 1.85% · headRef.faceH 0.238
校验：frames 39–45 · 5 点报告正常生成 · 等级判定/建议文案正常
```

## 模拟模式的已知局限

SIM 用「虹膜平移」表示注视点，且靶点经 iframe 偏移换算，所以校验误差数字不可信
（走通前 52%，修 hello 后 29%）。它只能证明**链路与判定逻辑正确**，
真实精度必须在有摄像头的机器上测：

```bash
python3 -m http.server 8125 --directory EPBL-latest   # 然后开 workbench/#/gaze-heatmap
```
