# 10 · 摄像头与推理收归工作台宿主

> 基线 `e59dc97`；2026-11-20 09:20–09:40；视口 536×812（dpr 2）

## 1. 交付 1：宿主单例（workbench/gaze-host.js）

新增接口（`window.__epblGazeHost`）：

| 接口 | 行为 |
| --- | --- |
| `ensureCamera()` | 单例 `{video, stream}`；已存在直接返回。设备不投帧时置 `noFrame`，不抛错 |
| `ensureEngine()` | FaceLandmarker 单例（与标定共用） |
| `ensureGesture()` | GestureRecognizer 懒加载（`draw/models/gesture_recognizer.task`），只有收到 `epbl:gaze-gesture-request` 才初始化 |
| `startInference()` / `stopInference()` | 40ms 循环：`FaceLandmarker.push(video)` → `bus.broadcastLandmarks()` |
| `releaseCamera()` | 停推理 + 停 track + 关引擎（10 分钟空闲 / pagehide / 独占时调用） |

其他行为：

- **切换模块不销毁摄像头**：`stopAll()` 只收标定现场，不再 close 引擎/流。
- **标定与推理共用一条 push 队列**：`faceBusy` 串行化，避免同一个 FaceLandmarker 并发调用。
- **订阅驱动**：`bus.onSubscribe` → `count>0` 开推理；归零后 `armIdle()`，10 分钟无订阅者 `releaseCamera()`。
- **visibilitychange**：`hidden` 停循环（保留流），回前台且 `subs>0` 自动重启，无需重新授权。
- **pagehide / beforeunload**：立即 `releaseCamera()`，让指示灯尽快熄灭。
- **独占冲突**：模块发 `epbl:gaze-exclusive`，宿主 `stopInference()` + `releaseCamera()`（真释放设备）并弹提示；`on:false` 时恢复。不会静默抢设备。

### CSP 变更（需要知会）

`workbench/index.html` 的 `script-src` 从 `'self'` 改为 `'self' 'wasm-unsafe-eval'`。
原因：宿主页要跑 MediaPipe 的 wasm，旧 CSP 直接拒绝编译（Step 8 的 `csp-wasm` 阻塞）。
**这是本轮唯一的安全策略改动**，未放开 `unsafe-eval`，只放开 wasm 编译。

实测：宿主页 `ensureEngine()` 成功，166ms。

## 2. 交付 2：bus 扩展（shared/gaze/bus.js）

- `broadcastLandmarks(landmarks, {root, ts})`：476 点 → `Float32Array(n*3)`，**每个 iframe 单独一份 buffer 并 transfer**（transfer 后原 buffer 失效，不能复用）。
- `onLandmarks(cb)` → 返回 `unsubscribe`；首个订阅者发 `epbl:gaze-subscribe {active:true}`，最后一个取消时发 `false`。
- 宿主侧 `onSubscribe(cb)` / `subscribeCount()`。
- `pruneStale()`：hello 与 subscribe 时剔除 `window.closed` 的 iframe，避免订阅计数虚高（首轮实测曾堆到 5）。

## 3. 交付 3：模块接入

| 模块 | 模式 | 说明 |
| --- | --- | --- |
| air-runner | **订阅** | `startCamera()` 在 shared 下不再 getUserMedia；`onLandmarks` → `onFaceResults({multiFaceLandmarks:[lm]})`，下游逻辑零改动 |
| gaze-heatmap | **订阅** | iframe 内默认 `GAZE_SHARED`；`onLandmarks` → `AbsoluteGazeSource` → `onGaze`；点「启动」直接提示共享模式，不启 WebGazer |
| draw | **独占** | 画笔手势要原图，bus 只传 landmarks（决策表 C），因此在 `startShared()` 声明 exclusive，自己开 1 路；`pagehide` 释放 |
| dual-test | **独占** | 手势识别要原图，`bootShared()` 声明 exclusive |

`?gaze=legacy` 全部保留：模块自己开摄像头，宿主不参与。

air-runner / heatmap 都在 `pagehide` 调 unsubscribe。

## 4. 交付 4：泄漏检查

`scripts/check-camera-leaks.sh` + `check-camera-leaks.mjs`（CDP）：

- 打开工作台 → 4 个模块轮转 20 次 → 每轮统计**真正挂着 `srcObject` 的 video**（不含 WebGazer 预建的空元素）。
- 结束后回到 air-runner，输出宿主 `camera/inference/subscribers`。

实测（20 轮）：

```json
{ "maxLiveTracks": 1,
  "worst": { "liveTracks": 1, "hostVideos": 1, "innerVideos": 0 },
  "end": { "liveTracks": 1, "camera": true, "inference": true } }
```

判据：`maxLiveTracks <= 1` → **通过**。heatmap 内仍有 2 个空 `<video>`（WebGazer 预建），但没有流。

手动清单（无 CDP 时）写在脚本末尾：media-internals 看活跃 capture、关标签 3 秒熄灯、后台 30 秒恢复、独占提示。

## 5. 未验证 / 风险

1. **真机摄像头不投帧**（`videoWidth=0`，三页一致）：因此「landmarks 广播频率」「后台 30 秒恢复后的实际出帧」「指示灯 3 秒熄灭」都只做了代码路径验证，没做真机观察。
2. **手势只在 draw / dual-test 上保留独立流**：宿主 `ensureGesture()` 已能懒加载，但本轮没有模块订阅宿主手部结果（需要新增 hand 广播协议 + 改两处手势链路）。这是下一步。
3. **heatmap 的 iframe 默认行为变了**：以前要 `?gaze=shared` 才消费共享数据，现在 iframe 内默认共享（`?gaze=legacy` 回退）。单独打开仍是 WebGazer。
4. CSP 放开 `wasm-unsafe-eval` 后，宿主页面能编译 wasm；如果这个工作台会加载不可信脚本，需要重新评估。
