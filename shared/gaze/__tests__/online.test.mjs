import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SAMPLE_POOL_MAX,
  RETRAIN_MIN_NEW,
  RETRAIN_MIN_GAP_MS,
  GUARD_RATIO,
  GUARD_SLACK,
  CLICK_MAX_AGE_MS,
  GazeOnlineTrainer,
  createOnline,
  isPageNorm,
  evalModelOn,
} from '../online.js';

function memStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    get length() {
      return m.size;
    },
    key: (i) => Array.from(m.keys())[i] ?? null,
    _map: m,
  };
}

function feat(a) {
  return {
    dLx: 0.3 + a * 0.05,
    dLy: 0.32 + a * 0.03,
    dRx: 0.62 + a * 0.05,
    dRy: 0.34 + a * 0.03,
    faceCx: 0.42 + a * 0.1,
    faceCy: 0.45 + a * 0.08,
    eyeDist: 0.23 + a * 0.02,
    roll: a * 0.01,
  };
}

function baseSamples(n = 24) {
  return Array.from({ length: n }, (_, i) => {
    const a = i / (n - 1);
    return { f: feat(a), tx: 0.15 + a * 0.7, ty: 0.2 + a * 0.6, t: 1000 + i * 10, kind: 'calib' };
  });
}

test('常量与文档一致', () => {
  assert.equal(SAMPLE_POOL_MAX, 48);
  assert.equal(RETRAIN_MIN_NEW, 3);
  assert.equal(RETRAIN_MIN_GAP_MS, 3000);
  assert.equal(GUARD_RATIO, 0.15);
  assert.equal(GUARD_SLACK, 0.01);
  assert.equal(CLICK_MAX_AGE_MS, 300);
});

test('isPageNorm 只接受 0..1 的 PAGE_NORM', () => {
  assert.equal(isPageNorm({ x: 0.2, y: 0.3 }), true);
  assert.equal(isPageNorm({ x: 0.2, y: 0.3, space: 'PAGE_NORM' }), true);
  assert.equal(isPageNorm({ x: 0.2, y: 0.3, space: 'VIDEO' }), false);
  assert.equal(isPageNorm({ x: 800, y: 300 }), false); // 像素坐标
  assert.equal(isPageNorm({ x: -0.1, y: 0.3 }), false);
  assert.equal(isPageNorm(null), false);
});

test('样本池上限与权重淘汰', () => {
  const t = new GazeOnlineTrainer();
  t.setBase(baseSamples(10));
  for (let i = 0; i < 60; i++) t.addClick(feat(0.5), 0.5, 0.5, 10_000 + i * 1000);
  assert.ok(t.total <= SAMPLE_POOL_MAX, `total=${t.total}`);
  assert.ok(t.base.length === 10, '标定样本不应被淘汰');
});

test('攒够 3 条且间隔足够才重训；安全阀拦下离谱样本', () => {
  const t = new GazeOnlineTrainer();
  t.setBase(baseSamples(24));
  const now = 100_000;

  // 3 条与基座一致的点击 → 应被接受，且误差不上升
  for (let i = 0; i < RETRAIN_MIN_NEW; i++) {
    t.addClick(feat(0.4 + i * 0.01), 0.15 + (0.4 + i * 0.01) * 0.7, 0.2 + (0.4 + i * 0.01) * 0.6, now + i);
  }
  assert.equal(t.due(now + 10), true);
  const first = t.train({ now: now + 20, aspect: 0.66 });
  assert.equal(first.status, 'accepted');
  const judge = first.model;

  // 立刻再来 3 条：间隔不足，不该重训
  for (let i = 0; i < RETRAIN_MIN_NEW; i++) t.addClick(feat(0.6), 0.6, 0.6, now + 30 + i);
  assert.equal(t.due(now + 40), false, '距上次训练不到 3 秒');

  // 时间够了再训，但这批标签全错（点在左下、特征是中间）→ 安全阀应拒绝
  const later = now + RETRAIN_MIN_GAP_MS + 100;
  for (let i = 0; i < RETRAIN_MIN_NEW; i++) t.addClick(feat(0.5), 0.02, 0.98, later + i);
  assert.equal(t.due(later + 10), true);
  const second = t.train({ now: later + 20, aspect: 0.66, judge });
  assert.equal(second.status, 'rejected', `期望 rejected，实际 ${second.status} (${second.prevErr} -> ${second.nextErr})`);
  assert.ok(second.nextErr > 0, '应有误差读数');
});

test('evalModelOn 对无效模型返回 Infinity', () => {
  assert.equal(evalModelOn(null, []), Infinity);
  assert.equal(evalModelOn({ ok: false }, []), Infinity);
});

test('noteClick：坐标空间、新鲜度、开关', () => {
  const storage = memStore();
  const now = 500_000;
  const on = createOnline({ storage, getAspect: () => 0.66 });
  const f = feat(0.4);

  // 没有 features → 拒绝
  assert.equal(on.noteClick({ target: { x: 0.5, y: 0.5 }, ts: now }).reason, 'no-features');

  on.markFeatures(f, now);
  // 像素坐标 → 拒绝
  assert.equal(on.noteClick({ target: { x: 640, y: 400 }, ts: now }).reason, 'not-page-norm');
  // 陈旧特征（>300ms）→ 拒绝
  assert.equal(on.noteClick({ target: { x: 0.5, y: 0.5 }, ts: now + 301 }).reason, 'stale-features');
  // 新鲜 → 接受
  const ok = on.noteClick({ target: { x: 0.5, y: 0.5 }, ts: now + 10, source: 'click' });
  assert.equal(ok.accepted, true);
  // 非法 source
  assert.equal(on.noteClick({ target: { x: 0.5, y: 0.5 }, ts: now + 10, source: 'nope' }).reason, 'bad-source');

  // 关闭后：数值路径与「从没有点击样本」一致
  const off = createOnline({ storage: memStore(), enabled: false });
  off.markFeatures(f, now);
  const r = off.noteClick({ target: { x: 0.5, y: 0.5 }, ts: now + 10 });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'disabled');
  assert.equal(off.stats().total, 0);
  assert.equal(off.stats().nClick, 0);
});

test('持久化：新键 + 旧键双写，重新加载能恢复', () => {
  const storage = memStore();
  const now = 900_000;
  const a = createOnline({ storage });
  a.markFeatures(feat(0.3), now);
  a.noteClick({ target: { x: 0.3, y: 0.3 }, ts: now + 5 });

  assert.ok(storage.getItem('air-runner.gazeSamples'), '旧键应被双写');
  assert.ok(storage.getItem('epbl.gaze.samples.v1'), '新键应写入');

  const b = createOnline({ storage });
  assert.equal(b.stats().clicks, 1, '重载后应恢复 1 条点击样本');
});

test('subscribe 在模型被接受时收到通知', async () => {
  const storage = memStore();
  const now = 1_200_000;
  const on = createOnline({ storage, getAspect: () => 0.66 });
  on.rebase(baseSamples(24));

  const got = [];
  const off = on.subscribe((r) => got.push(r));

  for (let i = 0; i < RETRAIN_MIN_NEW; i++) {
    on.markFeatures(feat(0.4 + i * 0.01), now + i);
    const r = on.noteClick({ target: { x: 0.15 + (0.4 + i * 0.01) * 0.7, y: 0.2 + (0.4 + i * 0.01) * 0.6 }, ts: now + i });
    assert.equal(r.accepted, true);
  }
  await new Promise((r) => setTimeout(r, 30)); // 等 scheduleRetrain 的 setTimeout(0)
  assert.ok(got.length >= 1, '应当收到模型更新通知');
  assert.equal(got[0].status, 'accepted');
  off();
});
