import test from 'node:test';
import assert from 'node:assert/strict';

import { watchViewport, compatSignature, readEnv, RESIZE_DEBOUNCE_MS } from '../resize.js';

/** 最小 window mock：只需要事件注册 + 尺寸 + matchMedia。 */
function mockWin(w = 1000, h = 800, dpr = 1) {
  const listeners = new Map();
  const win = {
    innerWidth: w,
    innerHeight: h,
    devicePixelRatio: dpr,
    visualViewport: null,
    addEventListener: (k, fn) => {
      if (!listeners.has(k)) listeners.set(k, new Set());
      listeners.get(k).add(fn);
    },
    removeEventListener: (k, fn) => {
      if (listeners.has(k)) listeners.get(k).delete(fn);
    },
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
    _fire(k) {
      for (const fn of listeners.get(k) || []) fn({});
    },
  };
  return win;
}

function rawModel(vw = 1000, vh = 800) {
  return {
    schema: 1,
    v: 1,
    engine: { name: 'mediapipe', version: '0.10' },
    camera: { w: 640, h: 480, aspect: 640 / 480 },
    viewport: { w: vw, h: vh, dpr: 1 },
    terms: { x: ['1'], y: ['faceCx'] },
    wx: [0, 1],
    wy: [0, 1],
    points: [],
    mean: {},
    std: {},
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('readEnv 读视口尺寸与 dpr', () => {
  const win = mockWin(900, 700, 2);
  const env = readEnv(win);
  assert.equal(env.viewport.w, 900);
  assert.equal(env.viewport.h, 700);
  assert.equal(env.viewport.dpr, 2);
});

test('compatSignature 对同一组 diffs 稳定', () => {
  const a = { level: 'soft', diffs: [{ field: 'viewport.size', level: 'soft' }, { field: 'viewport.dpr', level: 'soft' }] };
  const b = { level: 'soft', diffs: [{ field: 'viewport.dpr', level: 'soft' }, { field: 'viewport.size', level: 'soft' }] };
  assert.equal(compatSignature(a), compatSignature(b), '顺序不影响签名');
  assert.notEqual(compatSignature(a), compatSignature({ level: 'hard', diffs: a.diffs }));
});

test('300ms 防抖：连续 resize 只回调一次', async () => {
  const win = mockWin(1000, 800);
  const calls = [];
  const w = watchViewport((r) => calls.push(r), {
    win,
    getModel: () => rawModel(1000, 800),
    getEnv: () => readEnv(win),
  });

  win.innerWidth = 900; // 宽度变 100px → 比例相对差 11% → hard
  win._fire('resize');
  win._fire('resize');
  win._fire('resize');
  assert.equal(calls.length, 0, '防抖期内不应回调');

  await sleep(RESIZE_DEBOUNCE_MS + 120);
  assert.equal(calls.length, 1, `期望 1 次，实际 ${calls.length}`);
  w.stop();
});

test('同一条提示不重复；改回去再改回来会重新提示', async () => {
  const win = mockWin(1000, 800);
  const calls = [];
  const w = watchViewport((r) => calls.push(r), {
    win,
    getModel: () => rawModel(1000, 800),
    getEnv: () => readEnv(win),
  });

  win.innerWidth = 1010; // 比例变化 1% → soft
  win._fire('resize');
  await sleep(RESIZE_DEBOUNCE_MS + 100);
  assert.equal(calls.length, 1);

  // 同样的尺寸再触发一次：签名相同，不重复
  win._fire('resize');
  await sleep(RESIZE_DEBOUNCE_MS + 100);
  assert.equal(calls.length, 1, '相同签名不应重复');

  // 回到原尺寸（exact）→ 清空签名
  win.innerWidth = 1000;
  win._fire('resize');
  await sleep(RESIZE_DEBOUNCE_MS + 100);
  assert.equal(calls.length, 1, 'exact 不回调');

  // 再变回去 → 应重新提示
  win.innerWidth = 1010;
  win._fire('resize');
  await sleep(RESIZE_DEBOUNCE_MS + 100);
  assert.equal(calls.length, 2, '离开 exact 后应重新提示');
  w.stop();
});

test('stop() 之后不再回调', async () => {
  const win = mockWin(1000, 800);
  const calls = [];
  const w = watchViewport((r) => calls.push(r), {
    win,
    getModel: () => rawModel(1000, 800),
    getEnv: () => readEnv(win),
  });
  w.stop();
  win.innerWidth = 900;
  win._fire('resize');
  await sleep(RESIZE_DEBOUNCE_MS + 100);
  assert.equal(calls.length, 0);
});

test('没有模型时不回调（避免空模型被判 hard）', async () => {
  const win = mockWin(1000, 800);
  const calls = [];
  const w = watchViewport((r) => calls.push(r), {
    win,
    getModel: () => null,
    getEnv: () => readEnv(win),
  });
  win.innerWidth = 700;
  win._fire('resize');
  await sleep(RESIZE_DEBOUNCE_MS + 100);
  assert.equal(calls.length, 0);
  w.stop();
});
