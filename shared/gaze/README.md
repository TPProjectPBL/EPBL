# shared/gaze

统一手眼标定的共享层。这里放**契约**与**只读工具**，不放具体页面的实现。

## 目录

```text
shared/gaze/
├── CONTRACT.md        坐标 / 误差 / 采样 / 存储 / 版本 的唯一事实来源
├── contract.js        上述契约的运行时常量与纯函数（ES module）
├── README.md          本文件
├── audit-probe.js     现状审计探针（只读，Step 1 产物）
├── core/              标定核心（特征 / 拟合 / 模型 / 回退光标源）
├── engine/            人脸引擎与摄像头入口
│   ├── face-engine.js  FaceLandmarker 478 点（GPU→CPU，本地模型→CDN）
│   ├── camera.js       MediaStream 复用入口（结构化错误码）
│   └── check-landmarks.mjs  新旧引擎关键点索引一致性检查
└── models/            模型目录（.task 不入库）
```

## 首次运行（必须）

人脸模型是二进制、不进 git，第一次跑之前执行：

```bash
bash scripts/fetch-gaze-model.sh
```

它会下载到 `shared/gaze/models/face_landmarker.task`（约 3.7MB，脚本校验 > 3MB）。
下载失败时脚本会打印手动放置路径；目录说明见 `shared/gaze/models/README.md`。

## 谁 import 什么

| 使用方 | 该 import | 不该做 |
|---|---|---|
| 标定流程（将来 `core/`） | `SCHEMA_VERSION`、`CALIB`、`LIMITS`、`STORE_KEYS` | 自己写阈值或键名 |
| 误差统计 | `errToPx`、`clamp01` | 用宽或高代替对角线 |
| 模型存取 | `STORE_KEYS`、`makeSignature` | 新增 `xxx.gazeModel` 之类的键 |
| 页面渲染 | `COORD`、`clamp01` | 在模型层做镜像 |

示例：

```js
import { errToPx, clamp01, makeSignature } from '../../shared/gaze/contract.js';

const p = { x: clamp01(gaze.x), y: clamp01(gaze.y) };
const px = errToPx(Math.hypot(p.x - tx, p.y - ty), innerWidth, innerHeight);
const sig = makeSignature({
  viewport: { w: innerWidth, h: innerHeight },
  dpr: devicePixelRatio,
  camera: { w: video.videoWidth, h: video.videoHeight },
  engine: 'mediapipe-face-mesh-478',
  terms: ['dLx', 'dLy', 'dRx', 'dRy'],
});
```

## 当前阶段

- Step 1：`audit-probe.js`，只读探针，用于采集现状。
- Step 2：`CONTRACT.md` + `contract.js`，**冻结契约，不改任何页面**。
- Step 3：`core/` 抽离（air-runner 标定算法 → 共享，逐位等价）。
- Step 4：`engine/` 统一人脸引擎；跑酷默认走新引擎，`?engine=legacy` 保留旧 FaceMesh 一个版本。

### 人脸引擎用法

```js
import { createFaceEngine } from '../../shared/gaze/engine/face-engine.js';

const engine = await createFaceEngine();          // 默认 GPU，失败自动 CPU
engine.onResult(({ landmarks, ts }) => { /* 478 点，0..1，不镜像 */ });
const r = await engine.push(video, performance.now());
if (!r.landmarks) console.warn(r.reason);         // no-face / insufficient-landmarks
engine.close();
```

- 运行时复用 `draw/vendor/vision/vision_bundle.mjs` 与 `draw/vendor/vision/wasm`。
- 模型本地优先；本地不可用时回退官方 CDN（`allowCdnFallback: false` 可关闭）。
- 返回对象的 `delegate` / `modelSource` 标明实际使用的 GPU/CPU 与 local/cdn。

`audit-probe.js` 不参与运行时，页面里用 `window.__gazeAudit()` 触发；正式链路不要依赖它。

## 回滚

这一层是纯新增，回滚成本为零：

```bash
# 只删本次新增的契约文件
rm shared/gaze/CONTRACT.md shared/gaze/contract.js shared/gaze/README.md
```

- 没有任何现有页面 import 这些文件，删除不会破坏页面。
- `audit-probe.js` 是 Step 1 的独立产物，按需保留或删除。
- 跑酷回退：`?engine=legacy` 强制旧 FaceMesh；删掉 `shared/gaze/engine/` 前先把 app.js 的 import 改回 `lib/gaze-calib.js` 的旧实现。
- 如果后续页面开始 import，回滚前先把 import 改回本地实现。

## 约定

- 不引入第三方依赖。
- 不改配色、主题、页面布局。
- 常量只出现在 `contract.js`；页面出现同名常量视为重复定义。
- 不兼容的 schema 变更必须升版本并写迁移函数，不允许原地覆盖旧数据。
