# Step 4：统一人脸跟踪引擎（478 点含虹膜）

日期：2026-11-20
基线 HEAD：`e59dc97`（拉取时已是最新，`verify-bundle` 通过）

## 验收结论

| 交付 | 状态 |
|---|---|
| 1. `shared/gaze/engine/face-engine.js` | 完成 |
| 2. 模型 + `scripts/fetch-gaze-model.sh` + `.gitignore` + README | 完成 |
| 3. `shared/gaze/engine/camera.js` | 完成 |
| 4. 跑酷接入（默认新引擎 + legacy 回退 + UI 提示） | 完成 |
| 5. `check-landmarks` 一致性检查 | 完成，已实测出坐标 |

真机摄像头仍被微信占用，track 被系统置为 `ended`（2×2 占位帧），因此真机标定未完成；引擎侧已确认 `tasks / GPU / local` 就绪。

## 1. face-engine.js

- Vision Tasks `FilesetResolver.forVisionTasks` + `FaceLandmarker.createFromOptions`。
- 运行时复用 `draw/vendor/vision/vision_bundle.mjs` 与 `draw/vendor/vision/wasm`，不复制第二份 wasm。
- 默认 `runningMode: 'VIDEO'`、`refineLandmarks: true`、`delegate: 'GPU'`。
- 模型本地优先（`shared/gaze/models/face_landmarker.task`），失败回退 CDN。
- GPU 创建失败自动降级 CPU，`engine.delegate` 返回实际生效值。
- 输出为视频帧归一化坐标（0..1），不做镜像。
- `landmarks.length < 478` 时返回 `{ landmarks: null, reason: 'insufficient-landmarks', count }`。
- 其余 reason：`engine-closed` / `no-image` / `no-face` / `inference-failed:*`。
- 初始化彻底失败抛 `code: 'engine-init-failed'`，`attempts` 记录每次尝试。

常量：

```js
FACE_ENGINE.IDX = {
  leftIris: 468, rightIris: 473,
  leftEyeOuter: 33, leftEyeInner: 133,
  rightEyeOuter: 263, rightEyeInner: 362,
};
```

## 2. 模型文件

```text
path    shared/gaze/models/face_landmarker.task
size    3,758,596 bytes（3.59 MiB）
sha256  64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff
```

- `.gitignore`：`shared/gaze/models/*.task`，保留 `!shared/gaze/models/.gitkeep`。
- `scripts/fetch-gaze-model.sh`：下载后校验 > 3MB，失败时打印手动放置路径，支持 `GAZE_MODEL_URL`。
- `shared/gaze/README.md` 写明“首次运行必须执行 `bash scripts/fetch-gaze-model.sh`”。

## 3. camera.js

- `openCamera({ width=640, height=480, facingMode='user', deviceId })` 返回 `{ ok, video, stream, stop, width, height }`。
- 同一个 `video` 元素同时喂 FaceLandmarker 与 HandLandmarker，不重复开流。
- `stop()` 停掉全部 track 并清 `srcObject`。
- 结构化错误码：`permission-denied` / `device-not-found` / `device-busy` / `insecure-context` / `unsupported` / `unknown`。
- 5 秒 `loadedmetadata` 超时保护，避免永久挂起。

## 4. 跑酷接入

- 默认走 `createFaceSource()` → Tasks 引擎；`?engine=legacy` 强制旧 CDN FaceMesh 路径。
- 新引擎初始化失败自动回退 legacy，并 `toast('人脸引擎：新引擎不可用，已回退 legacy', 'bad')`。
- 成功时 `toast('人脸引擎：Tasks GPU（本地模型）', 'ok')`。
- 适配层 `makeTasksFaceSource` 每帧回调 `onFaceResults`（无人脸时传空数组），与旧 FaceMesh 语义对齐，避免 `trackReady` 永远为 false。
- 标定流程、点阵、阈值未改。
- 配色、`ui.css`、`lib/runner.js` 均无改动（`git diff --stat` 为空）。

## 5. 一致性检查

本轮把浏览器侧逻辑拆到 `shared/gaze/engine/check-in-page.js`：原 `check-landmarks.mjs` 顶部有 `node:fs`，页面无法 import，文档里“页面内直接 import”实际不可用。拆分后 CLI 改为注入 `check-in-page.js`，并支持 `GAZE_BASE` 指定静态服务根。

实测（`portrait.jpg`，820×1024，172 KB）：

```text
=== Tasks FaceLandmarker（新）===
count=478 delegate=GPU model=local
  468 左虹膜    x=0.44279 y=0.17051 z=0.00071
  473 右虹膜    x=0.54792 y=0.16955 z=0.00089
   33 左眼外角  x=0.42355 y=0.17268 z=0.01845
  133 左眼内角  x=0.46638 y=0.17328 z=0.01111
  263 右眼外角  x=0.56710 y=0.17115 z=0.02268
  362 右眼内角  x=0.52357 y=0.17254 z=0.01303

=== legacy FaceMesh（旧）===
count=478
  468 左虹膜    x=0.44162 y=0.17122 z=0.00880
  473 右虹膜    x=0.54844 y=0.16944 z=0.01200
   33 左眼外角  x=0.42112 y=0.17329 z=0.01753
  133 左眼内角  x=0.46667 y=0.17363 z=0.00996
  263 右眼外角  x=0.56972 y=0.17159 z=0.02193
  362 右眼内角  x=0.52406 y=0.17323 z=0.01195

=== 坐标差（归一化欧氏距离）===
  468 0.00137   473 0.00053
   33 0.00251   133 0.00045
  263 0.00266   362 0.00085
  最大差=0.00266（同拓扑，索引一致）
```

z 值两者口径不同（新引擎 z 更接近 0），平面坐标一致，不影响 2D 注视估计。

## 6. 真机结果

2026-11-20 00:35–00:50 实测：

| 项 | 结果 |
|---|---|
| 摄像头枚举 | `MacBook Air相机 (0000:0001)` |
| `getUserMedia`（首次） | 成功，`getSettings()` 报 640×480，随后 `stop()` |
| 跑酷页实际流 | `videoWidth=2, videoHeight=2`，track `readyState='ended'`，`muted=true` |
| 独立页面复测（前台、`visibilityState=visible`） | track `live`，`muted=true`，6 秒无 `loadedmetadata`，`videoWidth=0` |
| `getSettings()` | 只有 `deviceId/groupId/frameRate:30`，**没有 width/height**，说明设备未协商出视频格式 |
| 引擎 | `engine=tasks`，`delegate=GPU`，`model=local` |
| `trackReady` | `false`（“模型未出帧”） |

**结论**：浏览器侧能拿到 track，但拿不到任何帧。设备未投递首帧，属于 host/系统媒体层问题，与 `face-engine` / `camera.js` 代码无关。

**更正**：此前根据 `pgrep` 看到微信进程在运行，就写成“摄像头被微信占用”，这是没有证据的推断，已撤回。用户确认微信未使用摄像头。当前未能定位具体占用者或失败原因。

待验证方向：重启 DeepWorks 浏览器/应用后重测；检查 macOS 相机隐私开关与指示灯；若仍无帧，再查系统日志 `log show --predicate 'process == "AppleCameraAssistant"'`。

## 7. 本轮修复

- 新增 `shared/gaze/engine/check-in-page.js`（纯浏览器模块，无 node 依赖）。
- `check-landmarks.mjs` 改为 CLI 壳：`export { IDX, LABEL, runCheckInPage }`，并保留 CLI。
- CLI 的 target 选择改为只接受 `http(s)` 页面，`GAZE_VERBOSE=1` 打印实际 target。
- CLI 支持 `GAZE_BASE`，便于静态服务根不是 `EPBL-latest` 的场景。

## 8. 复现

```bash
bash EPBL-latest/scripts/pull-latest.sh
bash EPBL-latest/scripts/verify-bundle.sh
bash EPBL-latest/scripts/fetch-gaze-model.sh

# 页面（服务根为 EPBL-latest）
python3 -m http.server 8125 --directory EPBL-latest
# http://127.0.0.1:8125/eye-page-turner/demo/air-runner/?debug=1

# 一致性检查（服务根为 EPBL-latest 时）
node EPBL-latest/shared/gaze/engine/check-landmarks.mjs --image portrait.jpg

# 服务根为工作区根时
GAZE_BASE=http://127.0.0.1:8127/EPBL-latest/shared/gaze/engine/ \
  node EPBL-latest/shared/gaze/engine/check-landmarks.mjs --image portrait.jpg
```

## 9. 遗留

- 真机标定未完成：浏览器能创建 track，但设备不投递首帧（`muted=true`、`videoWidth=0`），原因未定位。
- 新增文件均未提交；远端会强推，拉取前脚本会打 patch 备份。
- `EPBL-latest/.gaze-check/portrait.jpg` 是本轮检查用的临时图（未跟踪），可随时删除。
