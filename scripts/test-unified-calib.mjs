/**
 * 统一标定协议自检（Node，无浏览器）。
 *
 * 用合成人脸驱动状态机，验证：
 *   - 9 点标定 → 9 条样本
 *   - 二阶多项式 14 项、alpha = 1.0
 *   - 5 点验证、平均欧氏距离 <= 0.08 判定通过
 *   - 眨眼 / 头部偏移会重置当前点计时（不会带着异常帧结算）
 *   - 镜像前后特征路径一致
 *
 * 注意：合成数据只用于验证流程与数值口径，不代表真机精度。
 * 真机标定必须来自摄像头帧；工作台在模拟模式下会直接拒绝标定。
 */
import { createSession } from '../shared/gaze/calibrate/session.js';
import { fitPoly2 } from '../shared/gaze/calibrate/poly2.js';
import {
  CALIB_POINTS,
  VALIDATE_POINTS,
  RIDGE_ALPHA,
  PASS_DIST,
  PASS_SCORE,
  scoreOf,
} from '../shared/gaze/calibrate/protocol.js';
import { simLandmarksFor } from '../shared/gaze/core/features.js';
import { headPose } from '../shared/gaze/head.js';
import { mirrorLandmarks } from '../shared/gaze/core/mirror.js';
import { extractFeatures, extractFeaturesMirrored } from '../shared/gaze/core/features.js';

const failures = [];
const ok = (cond, msg) => {
  if (!cond) failures.push(msg);
  console.log((cond ? 'PASS  ' : 'FAIL  ') + msg);
};

/** 合成脸没有眼皮，这里撑开眼睑让 EAR 过 0.2。 */
function openEyes(lm) {
  const l = lm[33].y;
  lm[160].y = l - 0.02;
  lm[158].y = l - 0.02;
  lm[153].y = l + 0.02;
  lm[144].y = l + 0.02;
  const r = lm[263].y;
  lm[385].y = r - 0.02;
  lm[387].y = r - 0.02;
  lm[373].y = r + 0.02;
  lm[380].y = r + 0.02;
  return lm;
}

/**
 * 合成脸默认只有 0.08 高，会被真实头控门槛（faceH>=0.22）全部判为「太远」。
 * 这里以画面中心等比放大 3.2 倍，几何比例（roll/yaw/pitch/眼特征方向）不变，
 * 只是让脸的大小达到真实摄像头量级。
 */
function bigFace(lm) {
  return lm.map((p) => ({ x: 0.5 + (p.x - 0.5) * 3.2, y: 0.5 + (p.y - 0.5) * 3.2 }));
}

/**
 * 精确对齐到标定标准框的合成脸：先放大到 faceH≈0.48，再整体平移使 cx/cy=0.5。
 * 用于验证「用户先把脸调进固定虚线框」这一新门槛。
 */
function stdFaceAt(lm, k) {
  const scaled = lm.map((p) => ({ x: 0.5 + (p.x - 0.5) * k, y: 0.5 + (p.y - 0.5) * k }));
  const h = headPose(scaled, { aspect: 4 / 3 });
  const dx = 0.5 - h.cx;
  const dy = 0.5 - h.cy;
  return scaled.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

/** 对齐到标准框的合成脸：k=5.6 → faceH≈0.56，落在 STD_ALIGN 的 0.42~0.72 范围内。 */
function stdFace(lm) {
  return stdFaceAt(lm, 5.6);
}

// ---- 1. 镜像一致性 ----
{
  const raw = simLandmarksFor(0.3, 0.4, 4 / 3, { noise: 0 });
  const mirrored = mirrorLandmarks(raw);
  const a = extractFeatures(mirrored, 4 / 3);
  const b = extractFeaturesMirrored(raw, 4 / 3);
  ok(a && b && Math.abs(a.dLx - b.dLx) < 1e-12, '镜像路径一致（extractFeaturesMirrored == mirror + extract）');
  ok(mirrored[33].x === 1 - raw[33].x, '镜像 = 1 - x');
}

// ---- 2. 二阶模型形状 ----
{
  const samples = CALIB_POINTS.map((p) => ({
    f: extractFeaturesMirrored(simLandmarksFor(p.tx, p.ty, 4 / 3, { noise: 0.001 }), 4 / 3),
    tx: p.tx,
    ty: p.ty,
  }));
  const m = fitPoly2(samples, { alpha: RIDGE_ALPHA });
  ok(!!m, '9 点可拟合');
  ok(m.terms.length === 14, `二阶展开 14 项（实际 ${m && m.terms.length}）`);
  ok(m.alpha === 1.0 && m.wx.length === 15, 'alpha=1.0、系数含截距');
}

// ---- 3. 端到端状态机 ----
{
  let target = { tx: 0.5, ty: 0.5 };
  let done = null;
  let review = null;
  let now = 0;
  let valGap = 0;
  const s = createSession({
    getLandmarks: () => bigFace(openEyes(simLandmarksFor(target.tx, target.ty, 4 / 3, { noise: 0.0015 }))),
    getAspect: () => 4 / 3,
    faceGate: false,
    onUpdate: (st) => {
      if (st.phase === 'calib') target = CALIB_POINTS[st.idx] || target;
      if (st.phase === 'validate') {
        target = VALIDATE_POINTS[st.idx] || target;
        if (st.gap > 0) valGap = Math.max(valGap, st.gap);
      }
    },
    onDone: (m, r) => {
      done = r;
    },
    onReview: (r) => {
      review = r;
    },
    onFail: (r) => failures.push('流程失败：' + JSON.stringify(r)),
  });
  s.start();
  for (let i = 0; i < 6000 && !done && !review; i += 1) {
    now += 16;
    if (s.state().phase === "ready") s.go(now);
    s.update(now);
  }
  const rep = done || review;
  ok(!!rep, '状态机走完 9 点 + 5 点验证');
  ok(rep && rep.samples.length === 9, `标定样本 9 条（实际 ${rep && rep.samples.length}）`);
  ok(rep && rep.points.length === 5, `验证结果 5 条（实际 ${rep && rep.points.length}）`);
  ok(rep && rep.points.every((p) => Number.isFinite(p.avg)), '5 个验证点都有平均误差');
  ok(rep && Number.isFinite(rep.avgDist) && rep.avgDist <= rep.threshold, `平均误差 ${(rep && rep.avgDist * 100).toFixed(2)}% <= 通过线 ${(rep.threshold * 100).toFixed(0)}%`);
  ok(!!done, '验证通过走 onDone（不是 onReview）');
  ok(rep && Number.isFinite(rep.score) && rep.score >= PASS_SCORE, `正确率 ${rep && Number.isFinite(rep.score) ? rep.score.toFixed(0) : '—'} 分 >= ${PASS_SCORE}`);
  ok(valGap > 500, `测试点之间也停 1 秒（实测 ${Math.round(valGap)}ms）`);
  ok(rep && rep.points.every((p) => p.frames > 0), '每个测试点都有有效帧（间隔没被算进采样）');
}

// ---- 4. 眨眼只丢帧：进度不回落、不重来 ----
{
  let blink = false;
  let now = 0;
  let target = CALIB_POINTS[0];
  let last = null;
  let sawBlinkReset = false;
  const s = createSession({
    getLandmarks: () => {
      const lm = bigFace(openEyes(simLandmarksFor(target.tx, target.ty, 4 / 3, { noise: 0.001 })));
      if (blink) {
        const y = lm[33].y;
        lm[160].y = y; lm[158].y = y; lm[153].y = y; lm[144].y = y;
        const ry = lm[263].y;
        lm[385].y = ry; lm[387].y = ry; lm[373].y = ry; lm[380].y = ry;
      }
      return lm;
    },
    getAspect: () => 4 / 3,
    faceGate: false,
    onUpdate: (st) => {
      last = st;
      if (st.reason === 'blink') sawBlinkReset = true;
    },
  });
  s.start();
  for (let i = 0; i < 40; i += 1) {
    now += 16;
    if (s.state().phase === "ready") s.go(now);
    s.update(now);
  }
  blink = true;
  for (let i = 0; i < 20; i += 1) {
    now += 16;
    if (s.state().phase === "ready") s.go(now);
    s.update(now);
  }
  ok(sawBlinkReset, '眨眼时给出 blink 提示');
  ok(last && last.pointProgress > 0 && last.frames > 0, '眨眼帧被丢弃，但进度不回零');
  const h = headPose(mirrorLandmarks(openEyes(simLandmarksFor(0.5, 0.5, 4 / 3, { noise: 0 }))));
  ok(!!h && Math.abs(h.roll) < 90, '镜像后 roll 不跳 ±180°');
}


// ---- 5. 没有新帧 / 摄像头停流时，进度不许自己走 ----
{
  let now = 0;
  let frameId = 0;
  let age = 0;
  let last = null;
  const s = createSession({
    getLandmarks: () => bigFace(openEyes(simLandmarksFor(CALIB_POINTS[0].tx, CALIB_POINTS[0].ty, 4 / 3, { noise: 0 }))),
    getAspect: () => 4 / 3,
    faceGate: false,
    getFrameId: () => frameId,
    getFrameAge: () => age,
    onUpdate: (st) => {
      last = st;
    },
  });
  s.start();
  // 同一帧被反复调用 200 次：进度必须保持 0
  for (let i = 0; i < 200; i += 1) {
    now += 16;
    if (s.state().phase === "ready") s.go(now);
    s.update(now);
  }
  ok(last && last.pointProgress === 0, '同一帧重复调用不推进进度');
  // 有新帧才开始累计
  for (let i = 0; i < 10; i += 1) {
    now += 16;
    frameId += 1;
    if (s.state().phase === "ready") s.go(now);
    s.update(now);
  }
  ok(last && last.pointProgress > 0, '新帧到达后进度才开始累计');
  // 摄像头停流：只提示，不把已采到的进度清零
  const beforeStale = last ? last.pointProgress : 0;
  age = 900;
  now += 16;
  if (s.state().phase === "ready") s.go(now);
  s.update(now);
  ok(last && last.reason === 'stale' && last.pointProgress === beforeStale, `画面停流只提示、不清进度（stale）→ progress=${last && last.pointProgress} reason=${last && last.reason}`);
}

// ---- 6. 没看靶点（眼睛不动，9 个点采到同一组特征）必须被拒 ----
{
  let now = 0;
  let frameId = 0;
  let fixed = null;
  let last = null;
  const s = createSession({
    // 永远生成同一个注视方向的关键点：模拟「盯着键盘不动」
    getLandmarks: () => {
      fixed = fixed || bigFace(openEyes(simLandmarksFor(0.5, 0.5, 4 / 3, { noise: 0 })));
      return fixed;
    },
    getAspect: () => 4 / 3,
    faceGate: false,
    getFrameId: () => frameId,
    onUpdate: (st) => {
      last = st;
    },
  });
  s.start();
  for (let i = 0; i < 900; i += 1) {
    now += 16;
    frameId += 1;
    if (s.state().phase === "ready") s.go(now);
    s.update(now);
  }
  ok(last && last.samples <= 1, `视线不动时不会凑满 9 个点（已采 ${last && last.samples}）`);
  ok(last && (last.reason === 'noGaze' || last.reason === ''), '第二个点被判“没有视线移动”');
}

// ---- 7. 头部偏移只丢帧：进度不回落 ----
{
  let now = 0;
  let frameId = 0;
  let turn = 0;
  let last = null;
  const s = createSession({
    getLandmarks: () => {
      const lm = bigFace(openEyes(simLandmarksFor(CALIB_POINTS[0].tx, CALIB_POINTS[0].ty, 4 / 3, { noise: 0 })));
      // 只平移鼻尖：眼睛不动、鼻子偏出去 = 向左/右转头（yaw）
      lm[1].x += turn;
      return lm;
    },
    getAspect: () => 4 / 3,
    faceGate: false,
    getFrameId: () => frameId,
    onUpdate: (st) => {
      last = st;
    },
  });
  s.start();
  for (let i = 0; i < 20; i += 1) {
    now += 16;
    frameId += 1;
    if (s.state().phase === "ready") s.go(now);
    s.update(now);
  }
  const before = last ? last.pointProgress : 0;
  turn = 0.08;
  for (let i = 0; i < 3; i += 1) {
    now += 16;
    frameId += 1;
    if (s.state().phase === "ready") s.go(now);
    s.update(now);
  }
  ok(before > 0 && last && last.reason === 'head' && last.pointProgress === before, '转头超阈值只丢帧、进度不回落（head）');
  ok(last && last.head && Math.abs(last.head.dYaw) > 7, `头控数据带偏移量（dYaw=${last && last.head ? last.head.dYaw.toFixed(1) : '—'}°）`);
}


// ---- 8. 标定点之间停 1 秒 ----
{
  let now = 0;
  let frameId = 0;
  let target = CALIB_POINTS[0];
  let last = null;
  const s = createSession({
    getLandmarks: () => bigFace(openEyes(simLandmarksFor(target.tx, target.ty, 4 / 3, { noise: 0 }))),
    getAspect: () => 4 / 3,
    faceGate: false,
    getFrameId: () => frameId,
    onUpdate: (st) => {
      last = st;
      if (st.phase === 'calib' && st.idx < CALIB_POINTS.length) target = CALIB_POINTS[st.idx];
    },
  });
  s.start();
  let sawGap = false;
  for (let i = 0; i < 80; i += 1) {
    now += 16;
    frameId += 1;
    if (s.state().phase === 'ready') s.go(now);
    s.update(now);
    if (last && last.samples === 1 && last.gap > 0) sawGap = true;
  }
  ok(sawGap, '第 1 点结束后出现 1 秒点间隔');
  ok(last && last.gap > 0 && last.pointProgress === 0, '点间隔期间进度为 0（靶点不采样）');
  const gapBefore = last ? last.gap : 0;
  for (let i = 0; i < 80; i += 1) {
    now += 16;
    frameId += 1;
    s.update(now);
  }
  ok(gapBefore > 0 && last && last.gap === 0 && last.pointProgress > 0, '1 秒后下一个点才开始累计');
}

// ---- 9. 测试阶段不稳定只丢帧、不重来 ----
{
  let now = 0;
  let frameId = 0;
  let target = CALIB_POINTS[0];
  let blinkMode = false;
  let report = null;
  const s = createSession({
    getLandmarks: () => {
      const lm = bigFace(openEyes(simLandmarksFor(target.tx, target.ty, 4 / 3, { noise: 0 })));
      if (blinkMode) {
        // 闭眼：EAR 归零
        for (const i of [160, 158, 153, 144, 385, 387, 373, 380]) lm[i].y = lm[33].y;
      }
      return lm;
    },
    getAspect: () => 4 / 3,
    faceGate: false,
    getFrameId: () => frameId,
    onUpdate: (st) => {
      if (st.phase === 'calib' && st.idx < CALIB_POINTS.length) target = CALIB_POINTS[st.idx];
      if (st.phase === 'validate' && st.idx < VALIDATE_POINTS.length) {
        target = VALIDATE_POINTS[st.idx];
        blinkMode = true;
      }
    },
    onDone: (m, r) => { report = r; },
    onReview: (r) => { report = r; },
  });
  s.start();
  for (let i = 0; i < 6000 && !report; i += 1) {
    now += 16;
    frameId += 1;
    if (s.state().phase === 'ready') s.go(now);
    s.update(now);
  }
  ok(!!report && report.points.length === 5, '测试阶段即使一直闭眼也走完 5 个点（不重来）');
  ok(!!report && report.points.every((p) => p.frames === 0), '不稳定的帧全部丢弃，不触发重置');
  ok(!!report && report.score === 0, `一帧都没采到时正确率为 0（实际 ${report && report.score}）`);
}

// ---- 9b. 验证阶段放宽相对头位门控：看边缘靶点的转头不再是整秒 head 丢弃 ----
{
  let now = 0;
  let frameId = 0;
  let target = CALIB_POINTS[0];
  let phase = '';
  let turn = 0;
  let report = null;
  let last = null;
  const s = createSession({
    getLandmarks: () => {
      const lm = bigFace(openEyes(simLandmarksFor(target.tx, target.ty, 4 / 3, { noise: 0 })));
      // 鼻尖平移 0.08 → dYaw≈7.1°：超过标定阈值 7°，低于验证阈值 18°
      lm[1].x += turn;
      return lm;
    },
    getAspect: () => 4 / 3,
    faceGate: false,
    getFrameId: () => frameId,
    onUpdate: (st) => {
      last = st;
      phase = st.phase;
      if (st.phase === 'calib' && st.idx < CALIB_POINTS.length) target = CALIB_POINTS[st.idx];
      if (st.phase === 'validate' && st.idx < VALIDATE_POINTS.length) target = VALIDATE_POINTS[st.idx];
    },
    onDone: (m, r) => { report = r; },
    onReview: (r) => { report = r; },
  });
  s.start();
  for (let i = 0; i < 6000 && !report; i += 1) {
    now += 16;
    frameId += 1;
    if (s.state().phase === 'ready') s.go(now);
    // 标定阶段摆正（turn=0），验证阶段转头看靶点（turn=0.08）
    turn = s.state().phase === 'validate' ? 0.08 : 0;
    s.update(now);
  }
  ok(!!report && report.points.length === 5, '放宽门控后验证走完 5 点');
  // 验证点应采到有效帧（不再因转头整秒丢弃）
  ok(!!report && report.points.slice(1).some((p) => p.frames > 0),
    `验证阶段转头仍能采到有效帧（frames=${report ? report.points.map((p) => p.frames).join(',') : '—'}）`);
  // 每点都带丢弃原因细分
  ok(!!report && report.points.every((p) => p.dropReasons && typeof p.dropReasons === 'object'),
    '验证报告每点带丢弃原因细分 dropReasons');
}

// ---- 9b. 标定前的摄像头弹窗：头稳了 ready 才为 true，且不采样 ----
{
  let now = 0;
  let frameId = 0;
  let shiftX = 0;
  let last = null;
  const s = createSession({
    getLandmarks: () => {
      const lm = stdFace(openEyes(simLandmarksFor(0.5, 0.5, 4 / 3, { noise: 0 })));
      // 整体横移：离开固定标准框（cx 偏出容差），但仍过宽松的 centerOk 门控
      return lm.map((p) => ({ x: p.x + shiftX, y: p.y }));
    },
    getAspect: () => 4 / 3,
    getFrameId: () => frameId,
    onUpdate: (st) => { last = st; },
  });
  s.start();
  for (let i = 0; i < 24; i += 1) {
    now += 16;
    frameId += 1;
    s.update(now);
  }
  ok(last && last.phase === 'ready', '弹窗阶段停在 ready，不提前采样');
  ok(last && last.pointProgress === 0 && last.frames === 0, '弹窗阶段不累计采样帧');
  ok(last && last.ready === true, '头位稳定后 ready=true（可以开始倒计时）');
  const refBefore = last && last.head && last.head.refBox;
  ok(!!refBefore, '稳定后画出虚线标准框（refBox）');

  shiftX = 0.08;
  for (let i = 0; i < 8; i += 1) {
    now += 16;
    frameId += 1;
    s.update(now);
  }
  ok(last && last.ready === false && last.reason === '', '转头后 ready 归 false（继续等，不报错）');
  ok(last && last.head && last.head.refBox && refBefore &&
    Math.abs(last.head.refBox.x - refBefore.x) < 1e-6, '标准框不随头移动（基准固定）');
  // 标准框必须是竖高脸形：物理宽高比 = (w*画面宽)/(h*画面高) = faceAspect
  const box = last.head.refBox;
  const physAspect = (box.w * (4 / 3)) / (box.h * 1);
  ok(Math.abs(physAspect - 0.78) < 1e-6, '标准框是竖高脸形（物理宽高比 0.78，不宽扁）');
}

// ---- 9c. 标定前必须先把脸调进固定标准框：未对齐不锁基准、不倒计时 ----
{
  let now = 0;
  let frameId = 0;
  let aligned = false;
  let last = null;
  const s = createSession({
    getLandmarks: () => {
      // 未对齐时用 bigFace（faceH≈0.32、cy≈0.34，偏离标准框）；对齐后换成 stdFace
      const base = simLandmarksFor(0.5, 0.5, 4 / 3, { noise: 0 });
      return aligned ? stdFace(openEyes(base)) : bigFace(openEyes(base));
    },
    getAspect: () => 4 / 3,
    getFrameId: () => frameId,
    onUpdate: (st) => { last = st; },
  });
  s.start();
  for (let i = 0; i < 30; i += 1) {
    now += 16;
    frameId += 1;
    s.update(now);
  }
  ok(last && last.phase === 'ready' && last.ready === false, '没对准标准框时 ready 一直为 false');
  ok(last && last.head && last.head.stdOk === false, '未对齐时 stdOk=false（徽标显示红）');
  ok(last && last.note.indexOf('虚线框') >= 0, '未对齐时提示用户把脸移进虚线框');
  ok(last && last.head && last.head.hasRef === false, '未对齐时不锁基准头位（不会拿第一个头位当标准）');
  const fixedX = last && last.head && last.head.refBox && last.head.refBox.x;

  aligned = true;
  for (let i = 0; i < 30; i += 1) {
    now += 16;
    frameId += 1;
    s.update(now);
  }
  ok(last && last.head && last.head.stdOk === true, '对齐标准框后 stdOk=true');
  ok(last && last.head && last.head.hasRef === true, '对齐后才锁定基准头位');
  ok(last && last.ready === true, '对齐并稳定后 ready=true（允许倒计时）');
  ok(last && last.head && Math.abs(last.head.refBox.x - fixedX) < 1e-6,
    '虚线框全程固定，对齐前后位置不变（靶子不随头跑）');
}

// ---- 9d. 标准框是「范围 + 稳定」：faceH 落在 0.42~0.72 内即可对齐，越界不 ready ----
{
  const runFace = (k) => {
    let now = 0;
    let frameId = 0;
    let last = null;
    const s = createSession({
      getLandmarks: () => stdFaceAt(openEyes(simLandmarksFor(0.5, 0.5, 4 / 3, { noise: 0 })), k),
      getAspect: () => 4 / 3,
      getFrameId: () => frameId,
      onUpdate: (st) => { last = st; },
    });
    s.start();
    for (let i = 0; i < 30; i += 1) { now += 16; frameId += 1; s.update(now); }
    return last;
  };
  // k=5.0 → faceH≈0.50，比标准 0.56 略远，但仍在范围内 → 应可对齐
  const farther = runFace(5.0);
  ok(farther && farther.head && farther.head.stdOk === true && farther.ready === true,
    'faceH≈0.50（略远）仍在范围内，stdOk=true 且可 ready');
  // k=6.8 → faceH≈0.68，比标准略近，仍在范围内
  const nearer = runFace(6.8);
  ok(nearer && nearer.head && nearer.head.stdOk === true && nearer.ready === true,
    'faceH≈0.68（略近）仍在范围内，stdOk=true 且可 ready');
  // k=7.6 → faceH≈0.76，超出上界但 distanceOk 仍 true → 应被范围拦住
  const tooNear = runFace(7.6);
  ok(tooNear && tooNear.head && tooNear.head.stdOk === false && tooNear.ready === false,
    'faceH≈0.76 超出范围上界，stdOk=false 且不可 ready（虽过 distanceOk）');
  // k=4.0 → faceH≈0.40，超出下界
  const tooFar = runFace(4.0);
  ok(tooFar && tooFar.head && tooFar.head.stdOk === false && tooFar.ready === false,
    'faceH≈0.40 超出范围下界，stdOk=false 且不可 ready');
}

// ---- 9e. 验证点帧数不足时自动延长采样窗口（有上限），带 windowMs ----
{
  let now = 0;
  let frameId = 0;
  let tick = 0;
  let target = CALIB_POINTS[0];
  let phase = '';
  let valIdx = 0;
  let report = null;
  const s = createSession({
    getLandmarks: () => {
      tick += 1;
      // 标定阶段每帧都给脸（顺利过标定）；验证阶段每 12 帧只给 1 帧 → 1 秒约 5 帧，低于 MIN_FRAMES
      if (phase === 'validate' && tick % 12 !== 0) return null;
      return bigFace(openEyes(simLandmarksFor(target.tx, target.ty, 4 / 3, { noise: 0 })));
    },
    getAspect: () => 4 / 3,
    faceGate: false,
    getFrameId: () => frameId,
    onUpdate: (st) => {
      phase = st.phase;
      valIdx = st.valIdx;
      if (st.phase === 'calib' && st.idx < CALIB_POINTS.length) target = CALIB_POINTS[st.idx];
      if (st.phase === 'validate' && st.valIdx < VALIDATE_POINTS.length) target = VALIDATE_POINTS[st.valIdx];
    },
    onDone: (m, r) => { report = r; },
    onReview: (r) => { report = r; },
  });
  s.start();
  for (let i = 0; i < 12000 && !report; i += 1) {
    now += 16;
    frameId += 1;
    if (s.state().phase === 'ready') s.go(now);
    s.update(now);
  }
  ok(!!report && report.points.length === 5, '帧不足场景仍能走完 5 个验证点');
  ok(!!report && report.points.some((p) => p.windowMs > 1000),
    `帧不足的验证点窗口被延长（windowMs=${report ? report.points.map((p) => p.windowMs).join(',') : '—'}）`);
  ok(!!report && report.points.every((p) => p.windowMs <= 2200),
    '延长不超过上限（1000ms + 1200ms）');
  ok(!!report && report.points.every((p) => Number.isInteger(p.windowMs) || Number.isFinite(p.windowMs)),
    '每个验证点都带 windowMs 字段');
}

// ---- 10. 正确率与误差同源：0.16 = 60 分通过线 ----
{
  ok(Math.round(scoreOf(0)) === 100, '误差 0 → 100 分');
  ok(Math.round(scoreOf(0.04)) === 90, '误差 0.04 → 90 分');
  ok(Math.round(scoreOf(0.08)) === 80, '误差 0.08 → 80 分');
  ok(Math.round(scoreOf(0.16)) === 60, '误差 0.16 → 60 分（通过线）');
  ok(Math.round(scoreOf(0.2)) === 50, '误差 0.2 → 50 分');
}

if (failures.length) {
  console.error('\n失败项：\n' + failures.map((f) => ' - ' + f).join('\n'));
  process.exit(1);
}
console.log('\n统一标定协议自检通过');
