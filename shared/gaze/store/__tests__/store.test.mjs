#!/usr/bin/env node
/**
 * store.js 单元测试（Node，无浏览器）。
 *
 * 覆盖：
 *   1) 正常存取（新键 + 旧键双写）
 *   2) 字段缺失 / NaN / 数组长度不一致 → invalid
 *   3) viewport 尺寸变化、dpr 变化 → soft
 *   4) engine 版本变化、terms 变化、相机宽高比差 >= 0.05 → hard
 *   5) 两点校正：正常、越界拒绝、退化拒绝
 *   6) 旧键迁移 → migrated:true 并回写新键
 *   7) clearModel 保留键位、样本存取与截断
 *
 * 运行：node shared/gaze/store/__tests__/store.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const gazeRoot = path.resolve(here, '..', '..'); // shared/gaze
const tmp = path.resolve(gazeRoot, '..', '..', '..', '.deepworks', 'tmp', 'store-test');

function copyAsMjs(srcDir, dstDir, rename) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const f of fs.readdirSync(srcDir)) {
    if (!f.endsWith('.js')) continue;
    let src = fs.readFileSync(path.join(srcDir, f), 'utf8');
    src = src.replace(/from '(\.[^']+)\.js'/g, "from '$1.mjs'");
    const out = rename ? rename(f) : f.replace(/\.js$/, '.mjs');
    fs.writeFileSync(path.join(dstDir, out), src);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
copyAsMjs(path.join(gazeRoot, 'core'), path.join(tmp, 'core'));
copyAsMjs(gazeRoot, tmp, (f) => (f === 'contract.js' ? 'contract.mjs' : f === 'store.js' ? 'store.mjs' : f));

const store = await import(pathToFileURL(path.join(tmp, 'store.mjs')).href);
const { FEATURES } = await import(pathToFileURL(path.join(tmp, 'core', 'features.mjs')).href);

/* ---------------------------------------------------------------- 夹具 */

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

const TERMS_X = ['roll', 'dLx', 'dRx', 'eyeDist'];
const TERMS_Y = ['dLy', 'dRy'];

function makeV3(over = {}) {
  const mean = {};
  const std = {};
  for (const f of FEATURES) {
    mean[f] = 0.01;
    std[f] = 0.02;
  }
  return {
    v: 3,
    ok: true,
    reason: '',
    variant: 'reduced',
    termsX: TERMS_X,
    termsY: TERMS_Y,
    aspect: 4 / 3,
    created: 1763580000000,
    n: 9,
    mean,
    std,
    wx: [0.5, 0.8, 1.1, 0.6, 0.2],
    wy: [0.5, 0.9, 0.7],
    quality: { avgErr: 0.04, maxErr: 0.062, grade: 'good' },
    points: Array.from({ length: 9 }, (_, i) => ({
      tx: 0.1 + (i % 3) * 0.4,
      ty: 0.12 + Math.floor(i / 3) * 0.38,
      px: 0.11 + (i % 3) * 0.4,
      py: 0.13 + Math.floor(i / 3) * 0.38,
      err: 0.014,
    })),
    diag: { frames: 9, samples: 9 },
    ...over,
  };
}

const ENV = {
  viewport: { w: 1440, h: 900, dpr: 2 },
  camera: { w: 640, h: 480 },
  engine: { name: 'mediapipe-face-landmarker', version: '478', landmarks: 478 },
  mirror: false,
};

function fresh(over) {
  const storage = memStorage();
  const r = store.saveModel(makeV3(over), { storage, env: ENV });
  assert.equal(r.ok, true, JSON.stringify(r));
  return { storage, raw: r.raw };
}

const cases = [];
function test(name, fn) {
  try {
    fn();
    cases.push({ name, ok: true });
  } catch (e) {
    cases.push({ name, ok: false, error: e });
  }
}

/* ---------------------------------------------------------------- 1. 正常存取 */

test('save/load 往返：schema1 + 签名 + 双写旧键', () => {
  const { storage, raw } = fresh();
  assert.equal(raw.schema, 1);
  assert.match(raw.sig, /^v1-[0-9a-f]{8}$/);
  assert.equal(raw.engine.name, 'mediapipe-face-landmarker');
  assert.deepEqual(raw.terms, { x: TERMS_X, y: TERMS_Y });

  const legacy = JSON.parse(storage.getItem(store.LEGACY_KEYS.model));
  assert.equal(legacy.v, 3, '旧键必须写成 v3 旧格式');

  const loaded = store.loadModel({ storage });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.migrated, false);
  assert.equal(loaded.model.ok, true);
  assert.equal(loaded.model.quality.grade, 'good');
  assert.deepEqual(loaded.model.termsX, TERMS_X);
  const p = loaded.model.predict(Object.fromEntries(FEATURES.map((f) => [f, 0.02])));
  assert.ok(p && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1, 'predict 应可用');
});

/* ---------------------------------------------------------------- 2. 校验 */

test('字段缺失 → reason:invalid', () => {
  const { storage, raw } = fresh();
  const broken = { ...raw };
  delete broken.wy;
  storage.setItem(store.STORE_KEYS.model, JSON.stringify(broken));
  const r = store.loadModel({ storage });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid');
});

test('NaN（JSON 化后为 null）→ reason:invalid', () => {
  const { storage, raw } = fresh();
  const broken = JSON.parse(JSON.stringify(raw));
  broken.mean.dLx = NaN;
  storage.setItem(store.STORE_KEYS.model, JSON.stringify(broken));
  const r = store.loadModel({ storage });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid');
});

test('数组长度不一致 → reason:invalid', () => {
  const { storage, raw } = fresh();
  const broken = JSON.parse(JSON.stringify(raw));
  broken.wx = broken.wx.slice(0, -1);
  storage.setItem(store.STORE_KEYS.model, JSON.stringify(broken));
  const r = store.loadModel({ storage });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid');
});

test('sig 缺失 → reason:invalid', () => {
  const { storage, raw } = fresh();
  const broken = JSON.parse(JSON.stringify(raw));
  delete broken.sig;
  storage.setItem(store.STORE_KEYS.model, JSON.stringify(broken));
  const r = store.loadModel({ storage });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid');
});

/* ---------------------------------------------------------------- 3. soft */

test('viewport 尺寸变化（同宽高比）→ soft + 两点校正建议', () => {
  const { raw } = fresh();
  const r = store.checkCompat(raw, { viewport: { w: 1280, h: 800, dpr: 2 }, camera: ENV.camera, engine: ENV.engine });
  assert.equal(r.level, 'soft');
  assert.equal(r.advice, '建议做两点校正');
  assert.ok(r.diffs.some((d) => d.field === 'viewport.size'));
});

test('dpr 变化 → soft', () => {
  const { raw } = fresh();
  const r = store.checkCompat(raw, { viewport: { w: 1440, h: 900, dpr: 1 }, camera: ENV.camera, engine: ENV.engine });
  assert.equal(r.level, 'soft');
});

test('相机宽高比小幅变化（<0.05）→ soft', () => {
  const { raw } = fresh();
  const r = store.checkCompat(raw, {
    viewport: ENV.viewport,
    camera: { w: 1280, h: 960 }, // 4:3，同比例
    engine: ENV.engine,
  });
  assert.equal(r.level, 'exact', '同比例应算 exact');
  const r2 = store.checkCompat(raw, {
    viewport: ENV.viewport,
    camera: { w: 800, h: 600 },
    engine: ENV.engine,
  });
  assert.equal(r2.level, 'exact');
});

/* ---------------------------------------------------------------- 4. hard */

test('engine 版本变化 → hard', () => {
  const { raw } = fresh();
  const r = store.checkCompat(raw, { viewport: ENV.viewport, camera: ENV.camera, engine: { ...ENV.engine, version: '479' } });
  assert.equal(r.level, 'hard');
  assert.equal(r.advice, '环境变化较大，建议重新标定');
  assert.ok(r.diffs.some((d) => d.field === 'engine.version'));
});

test('terms 不兼容 → hard', () => {
  const { raw } = fresh();
  const r = store.checkCompat(raw, {
    viewport: ENV.viewport,
    camera: ENV.camera,
    engine: ENV.engine,
    terms: { x: ['dLx', 'dRx'], y: TERMS_Y },
  });
  assert.equal(r.level, 'hard');
  assert.ok(r.diffs.some((d) => d.field === 'terms'));
});

test('相机宽高比差 >= 0.05 → hard', () => {
  const { raw } = fresh();
  const r = store.checkCompat(raw, {
    viewport: ENV.viewport,
    camera: { w: 640, h: 360 }, // 16:9 vs 4:3
    engine: ENV.engine,
  });
  assert.equal(r.level, 'hard');
  assert.ok(r.diffs.some((d) => d.field === 'camera.aspect' && d.level === 'hard'));
});

test('完全一致 → exact 且不改模型', () => {
  const { raw } = fresh();
  const snapshot = JSON.stringify(raw);
  const r = store.checkCompat(raw, ENV);
  assert.equal(r.level, 'exact');
  assert.deepEqual(r.diffs, []);
  assert.equal(JSON.stringify(raw), snapshot, 'checkCompat 不得修改模型');
});

/* ---------------------------------------------------------------- 5. 两点校正 */

test('两点校正：平移 + 缩放，refine 落库并重算质量', () => {
  const { raw } = fresh();
  const r = store.refineWithTwoPoints(raw, {
    p1: { gaze: { x: 0.2, y: 0.2 }, target: { x: 0.25, y: 0.24 } },
    p2: { gaze: { x: 0.8, y: 0.8 }, target: { x: 0.84, y: 0.86 } },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  // sx = (0.84-0.25)/(0.8-0.2) = 0.9833...
  assert.ok(Math.abs(r.s.x - 0.983333) < 1e-4);
  assert.equal(r.raw.refine.type, '2pt');
  assert.ok(r.raw.refine.created > 0);
  assert.ok(r.after && Number.isFinite(r.after.avgErr));
  // 重参数化后 w0 包含平移项
  assert.notEqual(r.raw.wx[0], raw.wx[0]);
  assert.ok(Math.abs(r.raw.wx[1] - r.s.x * raw.wx[1]) < 1e-9);
});

test('两点校正后 predict 与 s*pred+t 一致', () => {
  const { storage } = fresh();
  const before = store.loadModel({ storage }).model;
  const f = Object.fromEntries(FEATURES.map((k) => [k, 0.02]));
  const p0 = before.predict(f);
  assert.ok(p0, '校正前应可预测');

  const r = store.refineWithTwoPoints(before, {
    p1: { gaze: { x: 0.3, y: 0.3 }, target: { x: 0.33, y: 0.32 } },
    p2: { gaze: { x: 0.7, y: 0.7 }, target: { x: 0.72, y: 0.73 } },
  });
  assert.equal(r.ok, true, JSON.stringify(r));

  const p1 = r.model.predict(f);
  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  assert.ok(Math.abs(p1.x - clamp(r.s.x * p0.x + r.t.x)) < 1e-9);
  assert.ok(Math.abs(p1.y - clamp(r.s.y * p0.y + r.t.y)) < 1e-9);
});

test('两点校正：缩放越界 → out-of-range', () => {
  const { raw } = fresh();
  const r = store.refineWithTwoPoints(raw, {
    p1: { gaze: { x: 0.2, y: 0.2 }, target: { x: 0.2, y: 0.2 } },
    p2: { gaze: { x: 0.3, y: 0.3 }, target: { x: 0.9, y: 0.9 } }, // s = 7
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'out-of-range');
});

test('两点校正：两点重合 → degenerate', () => {
  const { raw } = fresh();
  const r = store.refineWithTwoPoints(raw, {
    p1: { gaze: { x: 0.5, y: 0.5 }, target: { x: 0.2, y: 0.2 } },
    p2: { gaze: { x: 0.5, y: 0.5 }, target: { x: 0.8, y: 0.8 } },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'degenerate');
});

/* ---------------------------------------------------------------- 6. 迁移 */

test('旧键升级：migrated:true 且回写新键', () => {
  const storage = memStorage();
  storage.setItem(store.LEGACY_KEYS.model, JSON.stringify(makeV3()));
  const r = store.loadModel({ storage, env: ENV });
  assert.equal(r.ok, true);
  assert.equal(r.migrated, true);
  assert.equal(r.raw.migrated, true);
  assert.match(r.raw.sig, /^v1-[0-9a-f]{8}$/);
  assert.deepEqual(r.raw.viewport, ENV.viewport);
  assert.ok(storage.getItem(store.STORE_KEYS.model), '升级结果必须回写新键');
  const again = store.loadModel({ storage, env: ENV });
  assert.equal(again.migrated, false, '第二次读应走新键');
});

test('新键无效时不静默回退（返回 invalid）', () => {
  const storage = memStorage();
  storage.setItem(store.STORE_KEYS.model, '{"schema":1}');
  storage.setItem(store.LEGACY_KEYS.model, JSON.stringify(makeV3()));
  const r = store.loadModel({ storage, env: ENV });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid');
});

/* ---------------------------------------------------------------- 7. 清空 / 样本 */

test('clearModel 写 null 保留键位', () => {
  const { storage } = fresh();
  store.clearModel({ storage });
  assert.equal(storage.getItem(store.STORE_KEYS.model), 'null');
  assert.equal(storage.getItem(store.LEGACY_KEYS.model), 'null');
  const r = store.loadModel({ storage });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty');
});

test('样本存取：过滤非法项 + 截断', () => {
  const storage = memStorage();
  const good = (i) => ({
    f: Object.fromEntries(FEATURES.map((f) => [f, 0.01 + i * 1e-4])),
    tx: 0.5,
    ty: 0.5,
  });
  const list = [good(0), { f: {}, tx: 0.1, ty: 0.1 }, good(1)];
  const s = store.saveSamples(list, { storage });
  assert.equal(s.ok, true);
  assert.equal(s.count, 2, '非法样本被过滤');
  const back = store.loadSamples({ storage });
  assert.equal(back.length, 2);

  const many = Array.from({ length: store.MAX_SAMPLES + 20 }, (_, i) => good(i));
  const s2 = store.saveSamples(many, { storage });
  assert.equal(s2.count, store.MAX_SAMPLES);
});

test('设置：默认值 + 只写已知字段', () => {
  const storage = memStorage();
  const d = store.loadSettings({ storage });
  assert.equal(d.mirror, false);
  const s = store.saveSettings({ mirror: true, bogus: 1 }, { storage });
  assert.equal(s.ok, true);
  assert.equal(s.settings.mirror, true);
  assert.equal('bogus' in s.settings, false);
  assert.equal(store.loadSettings({ storage }).mirror, true);
});

/* ---------------------------------------------------------------- 输出 */

let failed = 0;
for (const c of cases) {
  if (c.ok) {
    console.log(`  ok   ${c.name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${c.name}`);
    console.log(`       ${c.error && c.error.message}`);
  }
}
console.log(failed ? `\nFAIL store (${failed}/${cases.length})` : `\nPASS store (${cases.length} cases)`);
process.exit(failed ? 1 : 0);
