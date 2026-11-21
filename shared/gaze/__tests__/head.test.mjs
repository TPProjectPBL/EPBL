import test from 'node:test';
import assert from 'node:assert/strict';

import { headPose, toHeadRef, headDelta, headGate } from '../head.js';
import { HEAD } from '../contract.js';

/** 造一份 478 点：默认全落在 0.3..0.7 的人脸框里，再按需覆盖关键点。 */
function make(lm = {}) {
  const pts = new Array(478);
  for (let i = 0; i < 478; i += 1) {
    pts[i] = { x: 0.3 + ((i % 10) / 10) * 0.4, y: 0.3 + ((i % 7) / 7) * 0.4, z: 0 };
  }
  // 眼外角：水平，中心在 (0.5, 0.45)
  pts[33] = { x: 0.42, y: 0.45, z: 0 };
  pts[263] = { x: 0.58, y: 0.45, z: 0 };
  // 鼻尖：眼中心下方 → pitch 为正
  pts[1] = { x: 0.5, y: 0.55, z: 0 };
  // 睁眼（EAR 明显大于阈值）
  for (const i of [160, 158, 153, 144]) pts[i] = { x: 0.45, y: 0.435, z: 0 };
  for (const i of [133]) pts[i] = { x: 0.49, y: 0.45, z: 0 };
  for (const i of [362, 373, 380]) pts[i] = { x: 0.55, y: 0.435, z: 0 };
  for (const i of [385, 387]) pts[i] = { x: 0.51, y: 0.465, z: 0 };
  for (const [i, p] of Object.entries(lm)) pts[i] = { z: 0, ...p };
  return pts;
}

test('headPose: 正对镜头时 roll/yaw 归零，pitch 为正', () => {
  const h = headPose(make());
  assert.ok(h);
  assert.ok(Math.abs(h.roll) < 1e-6, `roll=${h.roll}`);
  assert.ok(Math.abs(h.yaw) < 1e-6, `yaw=${h.yaw}`);
  assert.ok(h.pitch > 0, `pitch=${h.pitch}`);
  assert.equal(h.blink, false);
  assert.equal(h.ok, true);
});

test('headPose: 右眼抬高 → roll 为负（atan2 口径，y 轴向下）', () => {
  const h = headPose(make({ 263: { x: 0.58, y: 0.4 } }));
  assert.ok(h.roll < -5, `roll=${h.roll}`);
  assert.equal(h.poseOk, false, '超过 rollMax 应判 poseOk=false');
});

test('headPose: 鼻尖偏右 → yaw 为正', () => {
  const h = headPose(make({ 1: { x: 0.53, y: 0.55 } }));
  assert.ok(h.yaw > 0, `yaw=${h.yaw}`);
});

test('headPose: 闭眼按 EAR 判 blink', () => {
  const h = headPose(
    make({
      160: { x: 0.45, y: 0.452 },
      158: { x: 0.45, y: 0.452 },
      153: { x: 0.45, y: 0.448 },
      144: { x: 0.45, y: 0.448 },
      362: { x: 0.55, y: 0.452 },
      373: { x: 0.55, y: 0.452 },
      380: { x: 0.55, y: 0.448 },
      385: { x: 0.55, y: 0.448 },
      387: { x: 0.55, y: 0.448 },
    }),
  );
  assert.equal(h.blink, true);
  assert.equal(h.ok, false, '眨眼帧整帧不可用');
});

test('headPose: 人脸框过小/过大都判 distanceOk=false', () => {
  const tiny = make();
  for (const p of tiny) {
    p.x = 0.5 + (p.x - 0.5) * 0.2;
    p.y = 0.5 + (p.y - 0.5) * 0.2;
  }
  assert.equal(headPose(tiny).distanceOk, false);

  const huge = make();
  for (const p of huge) {
    p.x = 0.5 + (p.x - 0.5) * 3;
    p.y = 0.5 + (p.y - 0.5) * 3;
  }
  assert.equal(headPose(huge).distanceOk, false);
});

test('headDelta: 与基准一致时 refOk=true', () => {
  const h = headPose(make());
  const ref = toHeadRef(h);
  const d = headDelta(ref, h);
  assert.equal(d.refOk, true);
  assert.equal(d.dRoll, 0);
});

test('headDelta: 后退导致 faceH 缩小超限 → refOk=false', () => {
  const h = headPose(make());
  const ref = toHeadRef(h);
  const far = make();
  for (const p of far) {
    p.x = 0.5 + (p.x - 0.5) * 0.6;
    p.y = 0.5 + (p.y - 0.5) * 0.6;
  }
  const d = headDelta(ref, headPose(far));
  assert.equal(d.refOk, false);
  assert.ok(d.dh < -HEAD.refDh);
});

test('headDelta: 没有基准时不拦帧', () => {
  const d = headDelta(null, headPose(make()));
  assert.equal(d.refOk, true);
});

test('headGate: strictOk 需要硬门控与基准同时通过', () => {
  const h = headPose(make());
  assert.equal(headGate(h, toHeadRef(h)).strictOk, true);
  assert.equal(headGate(h, null).strictOk, true, '无基准时只看硬门控');
  assert.equal(headGate(null, null).strictOk, false);
});

test('headPose: 点数不足直接返回 null', () => {
  assert.equal(headPose(new Array(100).fill({ x: 0.5, y: 0.5 })), null);
  assert.equal(headPose(null), null);
});
