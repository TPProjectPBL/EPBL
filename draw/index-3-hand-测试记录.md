# index-3-hand.html 实测记录

日期：2026-10-29
基线：`draw/index.html`（隔空画板 v3.0 · WebGazer）
交付：`draw/index-3-hand.html`（未覆盖原文件）

> 注：基线文件 `draw/index.html` 已在后续整理中删除，功能并入 `draw/index-3-hand.html`；下文“未改原文件”等为当时记录。

## 最终参数

| 项 | 最终值 |
|---|---|
| One Euro | minCutoff 1.0 / beta 0.02 / dCutoff 1.0 |
| 捏合成立 | pinchRatio < 0.45 |
| 捏合释放 | pinchRatio > 0.60 |
| 笔尖点 | draw 手 landmarks[8]（食指指尖） |
| 手掌中心 | landmarks[9]，`raw.handX/Y` 与左手平移继续使用 |
| 落笔确认 | `fistFrames` 两帧，`wantDown = Closed_Fist || pinchOn` |
| 检测节流 | 34ms（未改） |
| 镜像开关 | `HANDEDNESS_FLIP` 默认 false；`?fliphand=1` 或面板 H 交换 |

## 测试环境

- `python3 -m http.server 8788 --bind 127.0.0.1`
- headless Chrome + fake media（非真实摄像头）
- CDP 注入 21 点假 landmark，经真实 `handLoop` / `handleHands` 驱动
- 页面地址：`http://127.0.0.1:8788/draw/index-3-hand.html`

> 说明：以下为合成 landmark 的功能验证，不等同于真实摄像头精度/手感验收。真实指尖抖动、捏合舒适度、物理镜像方向需在用户本机复测。

## 逐项结果

| 验收项 | 结果 | 证据/说明 |
|---|---|---|
| 1 镜像 | 通过（代码级） | tip x=0.20 → `handTargetX=0.8000`；y=0.30 → 0.3000；符合现有 `1-x` 约定 |
| 2 慢线平滑 | 通过（合成） | 目标 0.8→0.2：60ms 时 0.6504，约 400ms 时 0.2434，逐步收敛非瞬移；无真实抖动样本 |
| 3 快线断点 | 未单独压测 | 渲染/补点代码未改动；合成 20fps 下笔画连续生成，真实甩线需复测 |
| 4 捏合起止 | 通过 | ratio 0.20 → down=true；0.50 → 保持 true；0.75 → false；抬笔后 `hudHistory` 笔画 +1 |
| 4 握拳并存 | 通过 | `Closed_Fist` 仍 down=true；捏合释放但握拳时 down 不掉 |
| 5 左右手不串 | 通过 | 双手（右开、左捏）down=false 且笔画数不变；单手左手捏合可落笔；左手张开平移时落笔被锁定（down=true 但不产生 stroke） |
| 6 校准回归 | 通过 | 9 点点击后 `calibCount=9`、浮层关闭、状态显示“标定完成 · 双条件模式已就绪” |
| 6 鼠标兜底 | 通过 | 未开摄像头：鼠标拖动生成 1 笔；Ctrl+Z 撤回、Ctrl+Y 恢复 |
| 6 键盘开关 | 通过 | T 切换笔尖来源；B 切换画布黑白；E 切换橡皮 |
| 6 其他功能 | 代码级未改 | WebGazer 注视、Victory 1200ms 冷却、左手平移、PNG、橡皮、调色板停留、Undo/Redo 数据层均未改动（diff 仅手部一段＋状态显示） |
| 7 零新增依赖 | 通过 | 未引入任何外部脚本/模型 |

## 回归红线核对（diff）

- `webgazer.js` 加载、`setGazeListener`、`onGaze`、`raw.gazeTargetX/Y`：未改。
- 摄像头约束、WebGazer 启动、`GestureRecognizer`、`numHands=2`、`handLoop` 34ms：未改。
- `raw.handX/Y`（9 点）、左手平移、`panOffset`、三层 canvas、stroke 世界坐标、Undo/Redo、橡皮、PNG：未改。
- `Input` 同步、笔尖 lerp、zoneOf、平移锁定、UI 样式/配色/字体：未改。
- 键盘 1–6/E/T/B/R/P/C/S/G/V：未改。

## 状态显示

- 原状态行结构保留，`.real-status` 仍为 260px 省略号单行。
- 有手时追加：`指尖/视线` + `捏合/握拳/抬笔`；无手时仍显示“等待手势”。
- 标定完成/左右手切换等提示驻留 1.2s，避免被下一帧实时状态覆盖。

## 第一批 dual-test 移植（本轮新增）

第一批只移植纯工具，当时不接动作；`draw/index.html` 未改。

| 移植项 | 结果 | 证据 |
|---|---|---|
| 分类器 | 通过 | `open / scroll-up / scroll-down / point / two / thumb / fist` 均按预期；空 landmark → `none` |
| 边沿状态机 | 通过 | `point/thumb` 第 3 帧触发；按住只触发一次，不随 900ms 冷却重复；`open/fist/none` 重新武装；冷却窗内新手势被丢弃；`scroll-up` 首帧触发后按 120ms 节流 |
| 黑帧检测 | 通过 | 纯黑 canvas → `true`；纯白 → `false` |
| 测试指标 | 通过 | `avgPx=40 / p90Px=100 / hitRate=75%`；joint `avgMs=200`；报告 schema 正确 |
| 回归 | 通过 | 合成右手 20fps，捏合落笔并抬笔后笔画 +1；无运行时异常 |
| 行为不变 | 通过 | 第一批完成后 `cls` 仅作为 hand 元数据；第二批开始用于 thumb/point，原落笔/平移/切色逻辑未改 |

- 新增全局：`window.AirCanvasKit`，调试桥新增 `AirCanvasBridge.kit`。
- 现有 `draw.cat`、`wantDown`、One Euro、捏合阈值、左手平移均未改。
- 动作接线（thumb/point/two 与抬笔）留到第二批；第二批已接 thumb/point，`scroll-up` 仍只识别不动作。

## 第二批 thumb / point 动作接线（本轮新增）

`AirCanvasKit` 版本号：`dual-test-port-2`。新增 `real.thumbGate`、`real.pointGate`，在 `handleHands` 末尾、左手平移状态更新后调用；`thumb` → `toggleTool()`，`point` → `undoOnce()`。

| 验收项 | 结果 | 证据 |
|---|---|---|
| thumb 切工具 | 通过 | 3 帧触发：画笔 → 橡皮；持续按住 1.2s 仍为橡皮，不重复；张开后再次拇指 → 画笔 |
| point 撤回 | 通过 | 1 笔 → 0 笔，HUD `撤回 1 / 恢复 1`，toast“已撤回 · 剩余 0 笔”；持续按住 1.2s 不重复 |
| 边沿/冷却 | 通过 | 同一连续手势只消费一次；松开后 900ms 内再次触发被丢弃；超过 900ms 可再次触发 |
| 捏合抑制 | 通过 | 捏合且 `raw.down=true` 时喂入 thumb 姿态，工具保持不变 |
| 画线回归 | 通过 | 捏合落笔并抬笔后 `hudHistory` 笔画 +1；无运行时异常 |
| 语法/异常 | 通过 | `extract-check.mjs` + `node --check`；CDP 无 `Runtime.exceptionThrown` |
| 指南/文案 | 通过 | 新增“拇指朝上 / 食指朝上”两条；按钮 title 改“注视＋捏合”；1280/1024 无横向溢出，help `scrollHeight === clientHeight` |

- 动作期间仍保留原落笔逻辑：`wantDown = Closed_Fist || pinchOn`；捏合/落笔/平移/标定期间不触发离散动作。
- 指南未把 `scroll-up` 写成动作；抬笔仍由“张开手掌”表达。
- 真实摄像头下 thumb/point 的误触率、舒适度仍需本机复测。

## 待真机复测

1. 食指指尖右移，屏幕笔尖是否右移（若反，先用 H / `?fliphand=1`，不要改公式）。
2. 慢速横/竖/圆是否还有可见抖动；若滞后，优先 beta 0.02→0.05。
3. 快速甩线是否断点/折角；必要时按需求在相邻采样点补点（≤8px）。
4. 捏合 0.45/0.60 是否灵敏、是否误触；按实测微调并回写本记录。

## 演示建议

- 优先保证帧率（60fps 优于高分辨率），手离摄像头 40–60cm，正面光，减少运动模糊与丢帧。
