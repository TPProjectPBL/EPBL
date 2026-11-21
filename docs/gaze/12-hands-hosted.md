# 12 · 手势收归宿主 / 眼动计算链路

> 基线 `daa0a69`；2026-11-20 11:40–12:10

## 1. 眼动到底怎么算的

三页共用同一条链，没有第二种算法：

```
摄像头帧 (640×480)
  └─ MediaPipe FaceLandmarker        → 478 个归一化关键点（468=左虹膜心，473=右虹膜心）
      └─ extractFeatures()           → 8 个尺度无关的比值
          ├ dLx dLy   左虹膜相对眼眶的偏移
          ├ dRx dRy   右虹膜相对眼眶的偏移
          ├ faceCx faceCy  人脸中心（按眼距归一化）
          ├ eyeDist   两眼距离（尺度基准）
          └ roll      头部倾斜
              └─ GazeCalibModel（ridge 线性回归）→ PAGE_NORM (0..1)
                  └─ 平滑（Kalman / EMA）→ client 坐标 → 光标
```

要点：

- **不是端到端 CNN**。MediaPipe 只负责「图像 → 关键点」，视线映射是一个 8 维线性模型（x、y 各一组系数）。
- 之所以要把点化成比值：`eyeDist` 做尺度基准后，同一模型在 40cm 和 60cm 都能用；直接喂坐标会被距离和头部大小带偏。
- 9 点标定拟合的就是这组系数；在线学习/两点校正只是重新拟合或做 `s/t` 仿射补偿，**不换特征、不换模型结构**。
- 三个项目唯一的差别是「第 1–2 步谁跑」：热力图/跑酷在宿主跑，画板历史上自己跑（现在也改成宿主了）。

## 2. 画板改为宿主托管

`draw/index-3-hand.html` 新增 `startHosted()`，在 iframe 内（`HOSTED`）走纯订阅：

- **不再 `getUserMedia`、不再声明 exclusive** ⇒ 宿主唯一一路流，三页共享；
- 眼动：`bus.onLandmarks` → `applySharedGaze(lm)`（与跑酷同一条路）；
- 手势：`bus.onHands` → 还原成 `{landmarks, gestures, handedness}` → 直接喂给原有的 `handleHands()`，
  **手势逻辑一行未改**（`classifyHand`、指尖、握拳、平移全部沿用）；
- 标定按钮改为 `postMessage({type:'epbl:gaze-calib-request'})`，标定统一在工作台做；
- `pagehide` 发 `epbl:gaze-gesture-request {on:false}` 并退订。

独立打开（不在 iframe 里）时 `HOSTED=false`，仍走原来的自开流路径，功能不变。

## 3. bus 新增 hands 协议

```
epbl:gaze-hands { version, ts, hands: [{ buf, n, gesture, gestureScore, handedness, handednessScore }] }
```

- 每帧**每个 iframe 单独分配 buffer** 再 transfer（transfer 后原 buffer 失效，不能共用）。
- `onHands(cb)` 订阅时自动 `hello()`，否则宿主不会推给这个 iframe。
- 与 landmarks 不同，hands 不参与推理循环的启停计数：宿主只在收到 `gesture-request{on:true}` 时才跑。

## 4. 宿主 hand 推理

`workbench/gaze-host.js` 新增 `startHands()`：

- `GestureRecognizer`（`numHands:1`，VIDEO 模式），**12.5fps**（`HANDS_MS=80`）；
- 与脸部共用同一路 `video` 和同一个 `faceBusy` 串行锁，避免两个模型抢帧；
- 手数 `0→0` 不重复广播（省消息），出现/消失必广播；
- `hidden` / `exclusive` 时降频到 600ms 空转，恢复后自动接上；
- `getStatus()` 新增 `hands: boolean`。

## 5. 跑酷：手势关闭

按要求 ban 掉：`startCamera()` 在 `SHARED_HOSTED` 时提前 return，`new HandDetector(...)` 与
`hands.detect()` 都在其后的代码里，**shared 模式下完全不会执行**。跑酷只剩眼动（+ 点击训练）。
独立打开 `air-runner/index.html` 时手势照旧。

## 6. 实测

```
draw 启动后：
  host { cam:true, subs:1, hands:true, exc:false }
  __drawGazeLearn 装上 = true
  iframe 内活跃 video = 0      ← 不再自开流
  顶层活跃 video = 1           ← 只有宿主这一路

hands 协议端到端：
  broadcastHands(1 手/21 点, Open_Palm, 0.91, Right) → draw 收到 1 手
  还原 p0 = {x:0.5, y:0.4, z:0}

切到 air-runner 后：
  host.hands = false           ← draw 卸载时 on:false 生效
  host.subs  = 0
```

单测：`online 8 + resize 6 = 14 pass / 0 fail`；`verify-bundle.sh` 四模块通过。

遗留：设备不出帧（`videoWidth=0`），所以「宿主真的识别出手」这一步没有真机数据，
只能证明通道与循环都在跑。

## 7. 与基线 `e59dc97` 的精度对比

基线时三页是**三套不同算法**，所以"准不准"不能一句比：

| | 基线 e59dc97 | 现在 |
| --- | --- | --- |
| 热力图 | WebGazer `setRegression('ridge')` + 自己 begin()，端到端读像素 | MediaPipe FaceLandmarker → 8 维比值 → 线性模型 |
| 画板 · 眼动 | WebGazer `setGazeListener` | 同上（宿主） |
| 画板 · 手势 | 自跑 GestureRecognizer，`numHands:2`，34ms 节流（≤29fps） | 宿主 GestureRecognizer，`numHands:2`，80ms（12.5fps） |
| 跑酷 · 眼动 | `FaceMeshDetector`（468 点）+ 自带 gaze-online | FaceLandmarker（478 点，含虹膜）+ 共享模型 |
| 标定 | 每页各自标定，无离群剔除 | 宿主 9 点一次，settle + 中位数 + MAD 剔除 |
| 跨会话 | 各自存，刷新后可能失效 | 统一键 + 在线学习样本 |

可比的硬数字只有一个：MediaPipe 方案 13 点校验 **3.67% / 36px**（dual-test）。
基线 WebGazer 没有可用基线（当时记录的是 150×804 窄窗，不可比）。

结论：

- **一致性**明确提高：三页共用同一个模型，不再各自漂移。
- **稳定性**明确提高：持久化 + 离群剔除 + 在线学习 + 尺寸提示。
- **绝对精度**不能断言提高：热力图/画板的眼动从 WebGazer 换成 MediaPipe，算法整个替换，
  需要在真机上用 `?gaze=legacy` 与 shared 路径做一次 A/B 才能定（dual-test 保留 13 点校验）。
- **手势**帧率下降（≤29fps → 12.5fps），`numHands` 已恢复为 2（与基线一致）。

## 8. 头位门控上移到共享层

热力图原来的「固定头部距离/倾角」是精度手段，现在拆成三层：

| 层 | 内容 | 位置 |
| --- | --- | --- |
| 度量 | roll / yaw / pitch / 人脸框 / EAR / 眨眼 | `shared/gaze/head.js`（纯函数，三页可用） |
| 阈值 | `distMin 0.22`、`distMax 0.80`、`rollMax 12`、`yawMax 17`、`pitch 5–68`、`ref*` 一组 | `contract.js` 的 `HEAD` |
| 基准 | 标定时的头位 | `model.headRef`，随模型存，三页共享 |
| 策略 | 多严才丢帧 | 各页面自定（热力图严格，其余仅提示） |

链路（已通）：

```
宿主 9 点标定
  → Calibrator 逐点记录 headPose → 取中位数 → out.headRef
  → model.headRef → store.saveModel（白名单已加 headRef）
  → bus 广播模型 → 热力图 applySharedModel 复原 S.headRef
  → 热力图 readHead() 改用 landmarks + headRef 做 refOk 门控
```

实测：

```
saveModel → loadModel → model.headRef 完整往返
{ cx:0.5, cy:0.455, faceH:0.09, roll:0, yaw:0, pitch:21.8 }
热力图「9 点标定」按钮 → 宿主 startCalib → 覆盖层「工作台标定 · n/9」
```

为什么门控本身不放进宿主：热力图要 `|dRoll|≤5°` 的严格丢帧，跑酷要头歪一点也能玩；
同一套阈值会互相伤害。共享的是**度量与基准**，策略留在页面。
