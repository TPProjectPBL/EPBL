# Step 5：可复用标定组件 + 跑酷接入

日期：2026-11-20
基线 HEAD：`e59dc97`（拉取时已是最新，`verify-bundle` 通过）

## 1. 交付内容

| 文件 | 行数 | 职责 |
|---|---|---|
| `shared/gaze/calibrate/calibrator.js` | 327 | 9 点标定状态机、逐帧采样、逐点中位数、拟合并交付模型 |
| `shared/gaze/calibrate/overlay.js` | 262 | 纯 DOM 覆盖层：点阵、进度环、结果图、ESC 取消 |
| `shared/gaze/calibrate/validate.js` | 301 | 5 点留出校验，输出分级误差与像素误差 |
| `shared/gaze/calibrate/__tests__/calibrator.test.mjs` | 104 | Node 单测：完整一轮 + 确定性 |
| `eye-page-turner/demo/air-runner/app.js` | 修改 | `startGazeCalib` / `tickGazeCalib` / `finishGazeCalib` 改走 Calibrator |

`core` 与 `contract` 未改动。

## 2. 组件 API

### Calibrator

```js
const cal = new Calibrator({
  container,                      // 标定区域元素
  points,                         // 可选，容器归一化坐标，默认 CALIB.cols × CALIB.rows
  settleMs, collectMs, minFrames, // 可选，覆盖契约默认值
  maxFrames,                      // 可选，默认 90
  extendCorners,                  // 可选，13 点模式（9 点 + 4 角），默认 false
  getLandmarks: ({ index, tx, ty, page }) => landmarks478 | null,
  getAspect: () => videoWidth / videoHeight,
  onProgress: ({ phase, idx, total, progress, pointProgress, note, samples, skipped }) => {},
  onDone: ({ model, samples, diag, skipped, containerRect, viewport, dpr }) => {},
});

cal.start();          // 进入 settle
cal.update(now);      // 每帧驱动，now 用 requestAnimationFrame 时间戳
cal.cancel();         // 中止，不回调 onDone
cal.state;            // 只读状态快照
```

相位：`idle → settle → collect → next → fit → result`。

规则：

- `settle` 在拿到可用人脸后才开始计时，避免用户还没坐好就进入采集。
- `collect` 逐帧 push `{ lm, tx, ty, ts }`，其中 `tx/ty` 已换算为 PAGE_NORM。
- 不足 `minFrames` 或样本无效的点记入 `skipped`（`insufficient-frames` / `invalid-sample`），继续下一点。
- 每个点用 `medianSample` 出中位数样本，最后 `fit` 一次。

### createOverlay

```js
const ov = createOverlay({ container, points, onCancel, label, zIndex });
ov.mount();
ov.update({ phase, idx, pointProgress, note });
ov.showResult({ ok, text, autoHideMs });
ov.hideResult();
ov.layout();   // 窗口尺寸变化时重算
ov.destroy();
```

- 全部内联样式，颜色走 CSS 变量 `--gaze-cal-accent / idle / done / bad / track / ink / bg`，不改页面配色。
- `position: fixed` 相对 `container.ownerDocument` 视口，支持 iframe 内元素与父页面元素。
- ESC 监听用 `keydown` capture 同时挂 `document` 与 `window`，只处理一次。
- `destroy()` 清全部 timer 与监听，不残留 DOM。

### Validator

```js
const v = new Validator({
  model,
  points,                    // 默认 5 点（0.2 / 0.8 网格），PAGE_NORM
  getLandmarks, getAspect,
  onProgress, onDone,
});

v.start(); v.update(now);
// 或 validateModel({ ... }) 内部用 rAF 自动驱动

{
  results: [{ tx, ty, px, py, err, errPx, n }],
  avg, max, avgPx, maxPx,
  frames, perPoint, skipped,
  unit: 'page-norm',
  viewport: { w, h },
}
```

`px/py` 是像素误差分量（`px = errToPx(|predX - tx|, w, h)`，`py` 同理），对齐任务书「px = errToPx」的口径；`errPx` 是同一口径下的径向像素误差；预测坐标放在 `predX/predY`。

## 2.1 决策表落实

| 决策 | 选项 | 实现 |
|---|---|---|
| 点阵默认覆盖 | A. 目标容器 10%/50%/90% | 默认 `CALIB.cols × CALIB.rows`，坐标相对 `container` 归一化 |
| 是否支持 13 点 | A. 9 点 + 4 角可选（默认关） | `extendCorners: true` 时追加 `CORNER_POINTS`（0.06/0.94），默认 9 点 |
| 采集时长 | A. settle 350 + collect 1200 | 契约默认值，未改 |
| 失败是否允许跳过 | A. 允许但标记 unverified | `finishGazeCalib` 失败不再禁用「应用」，改为 `gc.unverified = true`，沿用旧模型并在结果文案标注；落库时 `model.unverified = true` |

## 3. 跑酷接入

- `startGazeCalib()` 构造 Calibrator，容器为 `#gazeField`，参数取 `GC_POINTS / GC_SETTLE_MS / GC_COLLECT_MS / GC_MIN_FRAMES`。
- `tickGazeCalib(now)` 收敛为 `gc.cal.update(now)`，页面绘制仍由 `paintGazeCalib(st.pointProgress)` 完成。
- `finishGazeCalib(result)` 收 `model / samples / skipped`，保存逻辑保持原样。
- `?mode=sim` 分支通过 `simLandmarksFor` 注入合成关键点，`noise: 0.004`。
- `?engine=legacy` 分支未改动。
- `exportGazeDiag` 只新增 `skipped`，原有字段全部保留。
- `localStorage` 键 `air-runner.gazeModel` / `air-runner.gazeSamples` 未变。

## 4. 单测

命令：

```bash
cd EPBL-latest
node shared/gaze/calibrate/__tests__/calibrator.test.mjs
```

输出：

```text
PASS calibrator
  samples=9 skipped=0
  model.ok=true variant=reduced
  avgErr=0.02393270511293783 maxErr=0.055935944496960335 grade=good
  deterministic: same seed → identical model JSON
  13 点扩展：samples=13 ok=true（默认关闭，仅测试台对照用）
```

测试要点：

- 固定种子 `mulberry32(20261120)` 生成合成 landmarks。
- 断言 9 个样本、`model.ok`、`avgErr ∈ [0, 0.1]`、同种子两次模型 JSON 完全一致。
- Node 无 `type: module`，运行时把 `core` 与 `calibrate` 复制为 `.mjs` 并改写 import，测试结束后不影响仓库。

## 5. 浏览器实测

环境：`http://127.0.0.1:8125`，`?mode=sim&v=cal1`。

| 检查项 | 结果 |
|---|---|
| 完整一轮 | 9 样本，`model.ok=true`，avgErr 1.91%，max 4.19%，评级优 |
| 重复 5 轮 | avgErr 3.10% / 3.66% / 2.37% / 2.06% / 1.94%，全部 ok |
| toast | 标定完成：留一平均误差 1.9% · 评级 优 |
| overlay 挂载 | 9 个点，首点 (92.2px, 232.0px)，与容器 0.1/0.12 位置吻合 |
| overlay 销毁 | DOM 残留 0 |
| 5 点留出校验 | avg 3.83%（38px），max 6.02%（59px），375 帧，每点 75 帧 |

说明：后台标签页 rAF 会被节流，自动化验证用手动 `tick(now)` 推进；真实用户在前台不受影响。

## 6. 前后误差对比

| 口径 | 平均 | 最大 |
|---|---|---|
| 旧实现真机基线（`01-baseline.csv`） | 2.93% | 5.23% |
| 新组件 sim 5 轮 | 1.94%–3.66% | 3.91%–6.36% |
| 新组件 Node 固定种子 | 2.39% | 5.59% |
| 新组件 5 点留出（sim） | 3.83% | 6.02% |

结论：同一量级，没有退化。`core` 的特征提取、中位数、拟合代码本轮未改；采样窗口与计数规则与原状态机逐条对齐，差异来自 sim 噪声而非算法。

真机基线是摄像头实测，sim 是合成关键点，两者不可直接相减。

## 7. 已知问题

- 真机验证仍受摄像头占用影响（微信占用），本轮未重测。
- 新增 4 个文件未跟踪、`app.js` 未提交；远端会强推，下次拉取前脚本会打 patch 备份。
- `check-landmarks.mjs` 连续运行两次会耗尽页面 WebGL 上下文，需刷新页面再跑。

## 8.1 本轮补丁（2026-11-20 第二次核验）

- `Calibrator` 增加 `extendCorners`（13 点模式，默认关），单测覆盖 9 点与 13 点两种。
- `validate.js` 的 `px/py` 改为像素误差分量，预测坐标移到 `predX/predY`。
- `finishGazeCalib` 失败分支改为「允许继续 + unverified 标记」，不再强制禁用应用。
- `saveGazeModel` 不再 `removeItem` 删除 `air-runner.gazeModel` 键，改为写 `null` 保留键位。
- `exportGazeDiag` 新增 `unverified` 字段，原有字段未删。
- 修复 `app.js` 调试钩子整体覆盖问题：`?debug=1` 的第二个赋值会覆盖 `gazeCalib/boot/beginRun`，改为合并注入（`hookKeys` 从 5 恢复到 26）。

## 9. 复现路径

```bash
# 拉取
bash EPBL-latest/scripts/pull-latest.sh
bash EPBL-latest/scripts/verify-bundle.sh

# 单测
cd EPBL-latest && node shared/gaze/calibrate/__tests__/calibrator.test.mjs

# 页面
python3 -m http.server 8125 --directory EPBL-latest
# http://127.0.0.1:8125/eye-page-turner/demo/air-runner/?mode=sim
```
