# 真机基线怎么做（Step 1 执行单）

配套：[01-baseline.md](./01-baseline.md) / [01-baseline.csv](./01-baseline.csv)

## 这份基线是干什么的

它是**改造前的一次快照**，不是验收。

- 用途：后面统一标定、换引擎、加坐标适配器之后，用同样的条件再跑一次，比较"变好还是变坏"。
- 所以条件必须固定：同一台机器、同一浏览器、同一窗口尺寸、同一坐姿、同一光照。
- 绝对误差没有跨页可比性（单位不同），只做**同页前后对比**。

---

## 一、准备（5 分钟）

1. 关掉其他占摄像头的软件（腾讯会议、微信视频、OBS 等）。
2. 关闭浏览器缩放，保持 100%（地址栏 `Cmd+0`）。
3. 只开一个标签页跑一个入口，不要同时开两个 WebGazer 页面。
4. 坐正，脸在取景框内，眼睛到屏幕约 55–70 cm。
5. 记录环境（后面填每一行都要用）：

```js
// 在任意页面的控制台执行
JSON.stringify({ viewport: innerWidth + 'x' + innerHeight, dpr: devicePixelRatio, ua: navigator.userAgent })
```

---

## 二、通用采集（每页做完标定后执行）

每个页面标定完，在该页控制台粘贴下面这段，它会打印并**自动复制**一行 CSV：

```js
(() => {
  const a = window.__gazeAudit && window.__gazeAudit();
  if (!a) { console.warn('探针未加载，检查是否注入了 shared/gaze/audit-probe.js'); return; }
  const q = a.quality || {};
  let nums = null;
  if (Array.isArray(q)) {
    nums = q.map(v => typeof v === 'number' ? v : v && (v.err ?? v.error ?? v.dist)).filter(Number.isFinite);
  } else if (Array.isArray(q.errs)) {
    nums = q.errs.filter(Number.isFinite);
  }
  let avg = '', max = '', unit = a.coord;
  if (a.page === 'gaze-heatmap') {
    // 热力图以页面卡片为准，探针里的 validationResults 不一定能直接取到数值
    const t = sel => { const el = document.querySelector(sel); return el ? parseFloat(el.textContent) : NaN; };
    const av = t('#calibAvgErr'), mx = t('#calibMaxErr');
    if (Number.isFinite(av)) { avg = av; unit = 'stage-px'; }
    if (Number.isFinite(mx)) max = mx;
  } else if (a.page === 'air-runner' && Number.isFinite(q.avgErr)) {
    avg = +(q.avgErr * 100).toFixed(2);
    max = +(q.maxErr * 100).toFixed(2);
    unit = '%';
  } else if (nums && nums.length) {
    avg = +(nums.reduce((s, v) => s + v, 0) / nums.length).toFixed(1);
    max = +Math.max(...nums).toFixed(1);
    unit = a.page === 'gaze-heatmap' ? 'stage-px' : (a.page === 'dual-test' ? 'screen-px' : a.coord);
  }
  const row = [a.page, a.engine, a.points, avg, max, unit, innerWidth + 'x' + innerHeight, devicePixelRatio, ''].join(',');
  console.log('%c' + row, 'font-weight:bold');
  try { copy(row); } catch (e) {}
  return row;
})()
```

- 页面自己已经显示误差的，以**页面显示值为准**，命令算出来的只作交叉核对。
- 页面没有误差显示的（`controller-demo`、`draw`），这一行的 `avg_err/max_err` 留空，不要编。

---

## 三、逐页操作

> 顺序建议：先做有自报误差的页（跑酷 → 热力图 → 测试台），再做无自报误差的页。

### 1. air-runner（跑酷）——唯一有完整质量门的页

1. 打开 `http://127.0.0.1:8125/eye-page-turner/demo/air-runner/?mode=sim`
2. 按引导页点「继续」，允许摄像头
3. 打开暂停/设置面板，找到「精确注视（9 点标定）」
4. 依次注视 9 个点，每点停顿到进度环走完
5. 完成后读提示：`留一误差 平均 x% / 最大 y% · 评级`
6. 执行「通用采集」命令

记录：`unit=%`，`avg_err/max_err` 用百分比数值（如 `3.42`）。

### 2. gaze-heatmap（热力图）——有 5 点留出校验

1. 打开 `http://127.0.0.1:8125/gaze-heatmap/`
2. 点「9 点标定」，按提示逐点注视点击
3. 标定完成后会进入 **5 个留出点校验**
4. 读页面文案：`预计落点误差约 N px · 约 X% 舞台宽`
5. 执行「通用采集」命令（`unit=stage-px`）

记录：`avg_err` 用页面显示的整数 px；`max_err` 页面上没有就留空。

### 3. dual-test（眼动 + 手势测试台）——13 点

1. 打开 `http://127.0.0.1:8125/dual-test/`
2. 先启动追踪，再点「开始标定」（13 点）
3. 完成后看统计表里的「平均偏差 xx px」
4. 执行「通用采集」命令（`unit=screen-px`）

### 4. controller-demo（控制台测试页）——9 点，无误差显示

1. 打开 `http://127.0.0.1:8125/controller-demo/`
2. 点「开始 9 点标定」，完成后状态显示「标定完成」
3. 执行「通用采集」命令

记录：`avg_err/max_err` 留空；`notes` 写「页面无误差显示」。

### 5. draw（画板）——9 点，无误差显示

1. 打开 `http://127.0.0.1:8125/draw/index-3-hand.html`
2. 点「9 点标定」，按提示点击
3. 执行「通用采集」命令

注意：这里的 `penX/penY` **已经做了 1-x 镜像**，`lastGaze` 不能直接当屏幕坐标用。`avg_err/max_err` 留空。

### 6. control-frontend（控制前端）——没有标定

1. 打开 `http://127.0.0.1:8125/control-frontend/`
2. 它没有标定 UI，直接用 WebGazer 当前状态
3. 执行「通用采集」命令（`points=0`）

记录：`notes` 写「无标定 UI，未训练」。

### 7. workbench（工作台）——只记录宿主尺寸

1. 打开 `http://127.0.0.1:8125/workbench/`
2. 切换四个模块各一次，确认都能加载
3. 记录 stage 尺寸（不是整窗）：

```js
(() => {
  const f = document.querySelector('iframe');
  const r = document.querySelector('.stage').getBoundingClientRect();
  return JSON.stringify({ stage: Math.round(r.width) + 'x' + Math.round(r.height), frame: f && f.getBoundingClientRect().width + 'x' + f.getBoundingClientRect().height });
})()
```

---

## 四、可选：给无误差页做一次「定点偏差」

`controller-demo` 和 `draw` 没有自报误差，如果你想让基线更完整，可以做一个粗略定点测试：

1. 让视线停在屏幕正中央（不要动头），保持 3 秒；
2. 控制台执行：

```js
(async () => {
  const a0 = window.__gazeAudit && window.__gazeAudit();
  if (!a0) return 'no probe';
  const cx = innerWidth / 2, cy = innerHeight / 2;
  const xs = [], ys = [];
  for (let i = 0; i < 60; i++) {
    const g = window.__gazeAudit().lastGaze;
    if (g && g.live) {
      const px = a0.coord === 'screen-px' ? g.x : g.x * innerWidth;
      const py = a0.coord === 'screen-px' ? g.y : g.y * innerHeight;
      xs.push(px); ys.push(py);
    }
    await new Promise(r => setTimeout(r, 50));
  }
  if (!xs.length) return '无有效采样';
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  const d = Math.hypot(mx - cx, my - cy);
  return JSON.stringify({ samples: xs.length, mean: [Math.round(mx), Math.round(my)], offset_px: Math.round(d) });
})()
```

- `draw` 的结果受镜像影响，只能看**偏差大小**，不能看方向；
- 这条只用于粗看，不替代页面自己的校验。

---

## 五、填写规则

| 情况 | 怎么写 |
|---|---|
| 页面有误差 | 填页面显示值，`unit` 按页填 |
| 页面无误差 | `avg_err/max_err` 留空 |
| 还没测 | 保持 `pending` |
| 误差单位是比例 | 换算成百分比再填，`unit=%` |
| 同一页测了多次 | 只保留第一次完整流程的数据，`notes` 记「共 N 次」 |

---

## 六、常见坑

1. **摄像头被占用**：WebGazer 会一直停在初始化。先关会议软件。
2. **开了两个眼动页**：两个 WebGazer 抢摄像头，误差会异常大。
3. **标定中途转头/前后移动**：整轮作废，重来。
4. **页面缩放不是 100%**：坐标会整体偏，数据不可用。
5. **工作台里标定**：iframe 视口比整窗小，点阵参照物不同，**不要**在工作台里做基线。
6. **热力图在 iframe 里跑**：`S.stageRect` 变成 iframe 内矩形，校验误差单位仍是 stage-px，但和全屏不可直接比。
7. **跑酷断网**：MediaPipe 来自 CDN，模型加载不出来时页面会退回相对方向代理，此时不要记录。

---

## 七、回传

做完后把 7 行 CSV（或控制台打印的 7 行）贴回来，我帮你核对单位并写进 `01-baseline.csv`。

如果某页实在跑不起来，就记一行 `notes=无法运行：原因`，不要留空行。
