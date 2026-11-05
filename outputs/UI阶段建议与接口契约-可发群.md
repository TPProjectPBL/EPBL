# 网页「手势+眼神」双模态翻页插件 · UI 阶段建议（可直接发群）

> 依据：仓库 `TPProjectPBL/EPBL` 内《网页「手势 + 眼神」双模态翻页插件 · 系统设计报告》**v2.0**（main @ b205284）、第 5/6/10/11 节
> 说明：本文件为 v2.0 口径。早前那版"纯眼动 v1.0"的建议已作废——两份报告不是同一方案。

---

## 一、结论

1. 阶段 0/1 已交付（CameraModule / FaceMeshDetector / HandDetector / renderer / status-codes），**代码质量好，接口干净，UI 可以直接接**。
2. UI 不必等阶段 6。**阶段 2 的交付物本身就写着"距离指示 UI"**，阶段 3 写着"可视化方向指示"，阶段 4 写着"轨迹可视化"——也就是说，从阶段 2 起 UI 就是验收工具，应该现在就并进来。
3. 现在唯一缺的是**一份统一的事件契约**。目前 `main.js` 直接把检测结果画到 canvas 上，UI 与检测是耦合的；一旦并入手势/眼神两分支，会立刻乱。

---

## 二、建议做的 UI（按优先级）

### P0 · 调试态面板（阶段 2/3/4 验收物资）
直接扩展现有 `index.html` 右侧边栏，补上：

| 显示项 | 数据来源 | 为什么必须有 |
|---|---|---|
| 实时距离（米） | DistanceEstimator | 阶段 2 验收就是"实测 1m/1.5m/2m 输出" |
| 当前模式（手势/眼神） | ModeSwitcher | 阶段 2 验收"切换正确、无抖动" |
| **1.5m 刻度条 + ±0.2m 迟滞带** | distance + mode | 临界反复横跳只能靠可视化才测得出 |
| 注视方向箭头 + 置信度 | GazeEstimator | 阶段 3 验收"四方向 ≥90%" |
| 挥动方向 + 轨迹 | GestureRecognizer | 阶段 4 验收"1.5–3m 挥动 ≥90%" |
| 驻留进度环 / 触发打点时间 | 触发分支 | 触发延迟、误触计数全靠它 |

> 现有 `chip-mode`（"模式：待定（距离估计 → 阶段2）"）就是这块的占位，顺着做即可。

### P0 · 权限与降级 UI
- `status-codes.js` 里的 `Status` / `StatusMessage` **已经是可直接消费的一套枚举**，UI 层直接 `import` 它，**不要再造一套状态码**。
- 授权前给一句说明："画面只在你的设备上处理，不上传、不保存"，再触发 `getUserMedia`。
- 拒绝/无设备/非 HTTPS/相机被占用，四种异常都要有明确文案 + 重试入口（`ERR_*` 已齐）。

### P1 · 模式切换的可见反馈（报告明确要求）
- 切换瞬间必须有提示（气泡/toast），并按报告配**动作冷却**，避免用户不知道现在听手势还是听眼神。
- 迟滞带内不切换，UI 不要闪。

### P1 · 状态胶囊 + 展开面板 + **一键停止**
- 默认缩成小胶囊，展开才是完整面板：开始/暂停/**一键停止采集**、灵敏度、驻留时长、距离基准。
- 报告第 10 节"透明可控：明显开关与状态指示，一键停止采集"——这是**硬要求**，不是可选。
- 面板内固定一行隐私声明，便于阶段 8 抓包验收时自证。

### P2 · 配置面板（ConfigStore 的可视化）
- 方向→动作映射（click / scroll / keyboard）、阈值、驻留时长、距离基准（默认瞳距 63mm，可选个体标定）。
- 参数要能落盘，否则每次调参都要改代码重编译。

### P2 · 组件化与隔离
- 按报告阶段 6 封装成 `<eye-page-turner>`，**Shadow DOM 隔离样式**，`z-index` 做成可配置项，避免被宿主页面遮挡。
- 无障碍：关键状态用 `aria-live` 播报，面板支持键盘操作。

---

## 三、最小事件契约草案（建议阶段 2 开工时冻结）

**分层原则**：UI 只消费事件，**禁止直接引用 MediaPipe / 模型对象**。这样 UI 能用 mock 数据先跑，不阻塞。

| 类型 | 名称 | 载荷 | 对应报告模块 |
|---|---|---|---|
| 事件 | `distancechange` | `{ meters: number }` | DistanceEstimator |
| 事件 | `modechange` | `{ mode: 'gesture'\|'gaze', reason: 'cross'\|'hysteresis-hold' }` | ModeSwitcher |
| 事件 | `directionchange` | `{ dir: 'up'\|'down'\|'left'\|'right'\|'center', conf: 0–1, source: 'gaze'\|'gesture' }` | GazeEstimator / GestureRecognizer |
| 事件 | `dwellprogress` | `{ dir, progress: 0–1 }` | DwellStateMachine |
| 事件 | `trigger` | `{ dir, action, latencyMs, modal: 'gesture'\|'gaze' }` | ActionExecutor |
| 事件 | `statechange` | `{ state: Status.*, message: StatusMessage[state] }` | 权限/降级 |
| 命令 | `start()` / `stop()` / `pause()` / `resume()` | — | CameraModule |
| 命令 | `configure(patch)` | 合并进 ConfigStore | ConfigStore |

> 关键点：`statechange` 直接用现有 `Status` 枚举值，别新造；`modechange` 必须带 `reason`，否则迟滞带行为在 UI 上不可观测，阶段 2 的"无抖动"验收没法证明。

---

## 四、待确认项

| # | 问题 | 我的建议 |
|---|---|---|
| 1 | 「同伴开始的阶段 2」是否 = v2.0 的阶段 2（距离估计与模式切换）？"阶段 3 总体完事"指哪一段完成？ | 按 v2.0 口径理解，请群里确认一句 |
| 2 | 我在分工里领哪块：UI（PermissionUI + HostAdapter + 组件封装）还是同时兼顾集成？ | 明确边界，避免和同伴改同一文件 |
| 3 | UI 与同伴的代码怎么合：我直接改 `main.js`，还是把 UI 抽成独立模块再由 `main.js` 引入？ | **抽独立模块**，减少冲突 |
| 4 | 技术栈：原生 ES Module + Web Component（现状）还是引入框架？ | 沿用现状原生，包体可控 |
| 5 | 首个验收宿主页：PDF / PPT / 长文？ | 先定一个主场景 |
| 6 | 1.5m 阈值与 ±0.2m 迟滞带是否已实测标定过？ | 未标定的话 UI 先按 mock 距离跑 |
| 7 | 阶段 1 是否要补单测（报告阶段 1 交付物写了"单元测试"）？目前只有 `renderer.js` 是纯函数好测 | 建议补，`renderer` 优先 |
| 8 | 复用 `status-codes.js` 作为唯一状态源，是否认可？ | 认可就冻结，UI 不另造 |

---

## 五、下一步

1. 仓库已拉到本地 `EPBL/`（main @ b205284），阶段 0/1 代码已通读。
2. 待群里确认第 1、2、3 项后，我按 v2.0 契约抽出 UI 模块（不碰同伴正在写的检测/估计代码）。
3. 先交付**调试态面板**（距离 + 模式 + 1.5m 迟滞带可视化），让阶段 2 有东西可验收。
