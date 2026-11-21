# 手眼标定契约 v1

- 状态：**冻结（2026-11-19）**
- 适用：`shared/gaze/` 及其下游（测试台、热力图、画板、跑酷、工作台）
- 性质：只定义坐标/误差/存储/版本语义，不改任何现有页面行为

> 本文件是唯一事实来源。页面里已有的实现如果与本文冲突，以本文为准，并在迁移时用适配器收敛。

---

## 1. PAGE_NORM（页面归一化坐标）

页面上一切"注视点"的统一传输格式。

```text
x = clientX / window.innerWidth
y = clientY / window.innerHeight
```

| 项 | 规定 |
|---|---|
| 原点 | 左上角 `(0, 0)` |
| 范围 | `0..1`；**允许**产生越界值（预测天然会越界） |
| clamp 责任 | **调用方**，不是模型 |
| 参照物 | 当前文档视口 `window.innerWidth/innerHeight`，不是舞台、不是画布、不是 iframe 以外的窗口 |
| 单位 | 无量纲 |

推论：

- 同一次注视，在全屏窗口和 iframe 里 `PAGE_NORM` 数值不同，**不能跨容器直接复用**。
- 要做舞台/画布坐标，必须由调用方用各自的 rect 再映射一次，并显式记录目标空间。

```js
// 合法
const p = { x: gaze.x, y: gaze.y };                  // 原样传递
const clamped = { x: clamp01(gaze.x), y: clamp01(gaze.y) };

// 非法：模型内部不要偷偷 clamp
```

---

## 2. VIDEO_NORM（视频帧特征坐标）

特征只在视频帧空间计算，不参与跨页传输。

```text
x = clientX_video / videoWidth
y = clientY_video / videoHeight
aspect = videoWidth / videoHeight
```

| 项 | 规定 |
|---|---|
| 坐标系 | 视频帧**原始方向**，未做任何镜像 |
| 原点 | 帧左上角 |
| 范围 | `0..1` |
| aspect 用途 | **只用于把 y 方向的距离换算到 x 尺度**：`dyX = dy * aspect`；不得拿来缩放特征本身 |
| 输出 | 特征向量（如 `dLx/dLy/dRx/dRy/faceCx/faceCy/eyeDist/roll`），不是注视点 |

禁止事项：

- 不要在视频坐标上做镜像后再训练（镜像属于渲染层，见第 3 节）。
- 不要把 `PAGE_NORM` 的点直接喂给特征提取。
- 不要用 `aspect` 参与除"y 距离 → x 尺度"之外的任何归一化。

---

## 3. 镜像规则

| 层 | 是否允许镜像 | 要求 |
|---|---|---|
| 模型 / 特征 / 训练 | **禁止** | 输入永远是未镜像的 VIDEO_NORM |
| 渲染 / 交互层 | 最多 **一次** | 必须记录 `mirror` 字段 |

`mirror` 取值：

```text
'none'  未镜像（默认）
'x'     水平镜像：x' = 1 - x
```

规则：

1. 一个数据流里，`mirror` 只能出现一次；重复镜像等于回到原方向，是 bug。
2. 任何跨层传递注视点，必须带上 `mirror`。
3. 画板现有的 `1 - x` 属于渲染层镜像，迁移时必须显式声明 `mirror: 'x'`，不能默认沿用。

---

## 4. 误差定义

误差统一在 `PAGE_NORM` 上计算：

```text
err = hypot(predX - tx, predY - ty)
```

像素换算：

```text
errPx = err * hypot(viewportW, viewportH)
```

| 项 | 规定 |
|---|---|
| 输入 | 预测点与目标点都必须是 PAGE_NORM |
| 聚合 | 先算逐点 err，再取平均 / 最大；**不要**先平均坐标再算误差 |
| px 换算 | 用视口**对角线**长度，不是宽、也不是高 |
| 跨坐标空间 | 热力图的 stage-px 结果**不能**直接与本契约的 errPx 比较 |

```js
const err = Math.hypot(predX - tx, predY - ty);   // 0..1 空间
const errPx = errToPx(err, innerWidth, innerHeight);
```

---

## 5. 采样顺序（关键）

标定采样必须严格按以下顺序，**不允许交换**：

```text
1. 逐帧算特征（仅用于判断这一帧是否离群）
2. MAD 剔除离群帧
3. 对每个坐标分别取中位数
4. 用中位数关键点重新算一次特征
```

禁止：

```text
✗ 先对所有帧的特征取中位数，再用中位数特征训练
✗ 用平均代替中位数
✗ 剔除离群帧之前就算"最终特征"
```

原因：特征里含除法、比例、角度等非线性运算，`median(f(x)) ≠ f(median(x))`。先算特征再取中位数，会在头部轻微移动时产生系统性偏差。

实现要求：

- MAD 剔除用中位数绝对偏差，阈值统一写进实现，不在页面里散落魔数。
- 重算特征必须使用同一套 `terms`（见第 7 节存储格式）。

---

## 6. 质量门槛

| 指标 | 阈值 | 判定 |
|---|---|---|
| `avgErr` | `<= 0.05` | 优（good） |
| `avgErr` | `<= 0.09` | 良（ok） |
| `avgErr` | `> 0.25` | 拒绝（reject），不得保存为可用模型 |
| 敏感度 `sens` | `<= 0.03` | 通过 |

灰区 `0.09 < avg <= 0.25`：允许保存，但标记 `grade: 'weak'`，页面默认不启用"精确注视"。

补充：

- 门槛只约束 `avgErr`，`maxErr` 只做展示。
- `sens` 是"轻微头动/距离变化引起的预测漂移"，超限视为模型不稳定，即使 avgErr 达标。
- 任何拒绝都必须留下原因码，不能静默丢弃。

---

## 7. 存储键

所有持久化统一走这三个键，禁止新增同义键：

| 键 | 内容 | 写入方 |
|---|---|---|
| `epbl.gaze.model.v1` | 标定模型 | 标定流程 |
| `epbl.gaze.samples.v1` | 原始采样点（可复算） | 标定流程 |
| `epbl.gaze.settings.v1` | 引擎/镜像/阈值等设置 | 设置层 |

模型对象最小结构：

```json
{
  "schema": 1,
  "created": 1763600000000,
  "signature": "v1-3f2a9c1b",
  "terms": ["dLx", "dRx", "eyeDist", "roll"],
  "weights": { "wx": [], "wy": [] },
  "quality": { "avgErr": 0.029, "maxErr": 0.052, "grade": "good" },
  "mirror": "none"
}
```

采样对象最小结构：

```json
{
  "schema": 1,
  "aspect": 1.3333,
  "points": [{ "tx": 0.5, "ty": 0.5, "frames": [] }]
}
```

约束：

- 旧键（如 `air-runner.gazeModel`）只允许读，不允许再写。
- 读取到 `schema` 不等于 1 的对象，走迁移函数；迁移失败则丢弃并记录原因。
- `signature` 必须由 `makeSignature` 生成，不能手写。

---

## 8. 版本策略

| 项 | 规定 |
|---|---|
| 当前 schema | `1` |
| 常量来源 | `SCHEMA_VERSION`（`contract.js`） |
| 兼容变更 | 只加可选字段，不升版本 |
| 不兼容变更 | 必须升到 `2`，并提供 `migrateV1ToV2(obj)` |
| 迁移失败 | 返回 `null`，由调用方决定回退到默认模型 |
| 旧数据 | 保留只读；不得原地覆盖 |

升级检查清单：

1. 新字段是否可缺省？
2. 旧页面读新对象会不会崩？
3. 是否有对应迁移函数与回滚路径？
4. `STORE_KEYS` 是否同步升到 `.v2`？

---

## 附：常量对照表

| 名称 | 值 |
|---|---|
| `SCHEMA_VERSION` | `1` |
| `LIMITS.good` | `0.05` |
| `LIMITS.ok` | `0.09` |
| `LIMITS.reject` | `0.25` |
| `LIMITS.sens` | `0.03` |
| `CALIB.cols` | `[0.1, 0.5, 0.9]` |
| `CALIB.rows` | `[0.12, 0.5, 0.88]` |
| `CALIB.settleMs` | `350` |
| `CALIB.collectMs` | `1200` |
| `CALIB.minFrames` | `6` |

以上数值只能出现在 `contract.js`，页面里出现同名常量视为重复定义。

---

## 与现状的差异（迁移提示，不回改页面）

| 位置 | 现状 | 迁移时要做 |
|---|---|---|
| `gaze-heatmap` | `S.gaze` 是 screen px，统计转 stage px | 输出前转 PAGE_NORM |
| `draw` | `penX/penY` 已做 `1 - x` | 声明 `mirror: 'x'`，不要在模型层再镜像 |
| `air-runner` | 已接近契约，但存储键是 `air-runner.gazeModel` | 双读写过渡，最后只写新键 |
| `dual-test` | 误差是屏幕 px | 用 `errToPx` 统一换算 |
| `control-frontend` | 无标定 | 只消费 `epbl.gaze.model.v1` |
