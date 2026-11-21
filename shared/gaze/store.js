/**
 * @file 统一持久化层：模型 / 样本 / 设置的读写，签名校验、兼容判定与两点校正。
 *
 * 存储格式 `schema: 1`（与 `contract.js` 的 `STORE_KEYS` 配套）：
 *
 * ```json
 * {
 *   "schema": 1,
 *   "created": 1763580000000,
 *   "engine": { "name": "mediapipe-face-landmarker", "version": "478", "landmarks": 478 },
 *   "camera": { "w": 640, "h": 480, "aspect": 1.3333 },
 *   "viewport": { "w": 1440, "h": 900, "dpr": 2 },
 *   "terms": { "x": ["roll", "dLx", "dRx", "eyeDist"], "y": ["dLy", "dRy"] },
 *   "mean": { "dLx": 0.0, "...": 0.0 },
 *   "std": { "dLx": 0.01, "...": 0.01 },
 *   "wx": [0.5, 1.2, -0.3],
 *   "wy": [0.5, 1.1, -0.2],
 *   "quality": { "avgErr": 0.024, "maxErr": 0.056, "grade": "good" },
 *   "points": [{ "tx": 0.1, "ty": 0.12, "px": 0.11, "py": 0.13, "err": 0.014 }],
 *   "diag": { "...": "..." },
 *   "mirror": false,
 *   "sig": "v1-3f2a9c1b"
 * }
 * ```
 *
 * 设计约束：
 * - 读旧键只做升级，不删除；写旧键只在 `legacy: true` 时双写。
 * - `checkCompat` 只读，不修改模型。
 * - 两点校正只允许平移 + 各轴缩放（4 参数），不接受旋转/剪切。
 *
 * @module shared/gaze/store
 */
import { SCHEMA_VERSION, STORE_KEYS, LIMITS, CALIB, makeSignature } from './contract.js';
import { FEATURES, clamp01 } from './core/features.js';
import { GazeCalibModel } from './core/model.js';

export const STORE_SCHEMA = SCHEMA_VERSION;

/** 重新导出键名，调用方不必再 import contract。 */
export { STORE_KEYS };

/** 旧键：只读（升级用）与双写（回滚用）。 */
export const LEGACY_KEYS = Object.freeze({
  model: 'air-runner.gazeModel',
  samples: 'air-runner.gazeSamples',
});

export const DEFAULT_ENGINE = Object.freeze({
  name: 'mediapipe-face-landmarker',
  version: '478',
  landmarks: 478,
});

/** 样本上限：点击样本按时间衰减，超出后保留最新的。 */
export const MAX_SAMPLES = 600;

export const DEFAULT_SETTINGS = Object.freeze({
  mirror: false,
  train: true,
  settleMs: CALIB.settleMs,
  collectMs: CALIB.collectMs,
  extendCorners: false,
});

/** 两点校正允许的缩放区间。 */
export const REFINE_SCALE_RANGE = Object.freeze([0.85, 1.18]);

const SIG_RE = /^v1-[0-9a-f]{8}$/;
const GRADES = ['good', 'ok', 'poor'];

/* ------------------------------------------------------------------ 基础设施 */

function resolveStore(storage) {
  if (storage && typeof storage.getItem === 'function') return storage;
  try {
    const ls = globalThis.localStorage;
    if (ls && typeof ls.getItem === 'function') return ls;
  } catch {
    /* 隐私模式 / Node */
  }
  return null;
}

function readRaw(store, key) {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(store, key, value) {
  try {
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function parseJSON(raw) {
  if (!raw || raw === 'null' || raw === 'undefined') return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isSize(o) {
  return !!o && isNum(o.w) && isNum(o.h) && o.w > 0 && o.h > 0;
}

function gradeOf(avgErr) {
  if (!isNum(avgErr)) return 'poor';
  if (avgErr <= LIMITS.good) return 'good';
  if (avgErr <= LIMITS.ok) return 'ok';
  return 'poor';
}

function sameTerms(a, b) {
  const ax = (a && a.x) || [];
  const ay = (a && a.y) || [];
  const bx = (b && b.x) || [];
  const by = (b && b.y) || [];
  if (ax.length !== bx.length || ay.length !== by.length) return false;
  for (let i = 0; i < ax.length; i += 1) if (ax[i] !== bx[i]) return false;
  for (let i = 0; i < ay.length; i += 1) if (ay[i] !== by[i]) return false;
  return true;
}

/* ------------------------------------------------------------------ 校验 */

/**
 * 校验 schema:1 原始对象。
 * 任何字段缺失、NaN、数组长度不一致都归为 `reason: 'invalid'`。
 * @param {object} raw
 * @returns {{ok: true} | {ok: false, reason: 'invalid', field: string}}
 */
export function validateStoredModel(raw) {
  const bad = (field) => ({ ok: false, reason: 'invalid', field });
  if (!raw || typeof raw !== 'object') return bad('root');
  if (raw.schema !== STORE_SCHEMA) return bad('schema');
  if (!isNum(raw.created)) return bad('created');

  const e = raw.engine;
  if (!e || typeof e.name !== 'string' || !e.name) return bad('engine.name');
  if (typeof e.version !== 'string' || !e.version) return bad('engine.version');
  if (!Number.isInteger(e.landmarks) || e.landmarks <= 0) return bad('engine.landmarks');

  if (!isSize(raw.camera)) return bad('camera');
  if (!isNum(raw.camera.aspect) || raw.camera.aspect <= 0) return bad('camera.aspect');

  if (!isSize(raw.viewport)) return bad('viewport');
  if (!isNum(raw.viewport.dpr) || raw.viewport.dpr <= 0) return bad('viewport.dpr');

  const terms = raw.terms;
  if (!terms || !Array.isArray(terms.x) || !Array.isArray(terms.y)) return bad('terms');
  if (!terms.x.length || !terms.y.length) return bad('terms');
  for (const t of terms.x.concat(terms.y)) {
    if (typeof t !== 'string' || FEATURES.indexOf(t) < 0) return bad('terms.item');
  }

  for (const k of ['mean', 'std']) {
    const bag = raw[k];
    if (!bag || typeof bag !== 'object') return bad(k);
    for (const f of FEATURES) {
      if (!isNum(bag[f])) return bad(`${k}.${f}`);
      if (k === 'std' && !(bag[f] > 0)) return bad(`std.${f}`);
    }
  }

  if (raw.headRef !== undefined && raw.headRef !== null) {
    const h = raw.headRef;
    if (typeof h !== 'object') return bad('headRef');
    for (const k of ['cx', 'cy', 'faceH', 'roll', 'yaw', 'pitch']) {
      if (!isNum(h[k])) return bad(`headRef.${k}`);
    }
  }

  for (const k of ['wx', 'wy']) {
    const w = raw[k];
    const want = (k === 'wx' ? terms.x : terms.y).length + 1;
    if (!Array.isArray(w) || w.length !== want) return bad(k);
    for (const v of w) if (!isNum(v)) return bad(k);
  }

  const q = raw.quality;
  if (!q || !isNum(q.avgErr) || !isNum(q.maxErr)) return bad('quality');
  if (GRADES.indexOf(q.grade) < 0) return bad('quality.grade');

  if (!Array.isArray(raw.points)) return bad('points');
  if (typeof raw.mirror !== 'boolean') return bad('mirror');
  if (typeof raw.sig !== 'string' || !SIG_RE.test(raw.sig)) return bad('sig');

  return { ok: true };
}

/* ------------------------------------------------------------------ 环境 / 签名 */

/**
 * 归一化调用方传入的环境描述；缺省时尽量从 window 推断。
 * @param {object|null} env
 * @param {object} [modelJSON] 旧模型（补 aspect / 推断摄像头）
 */
export function normalizeEnv(env = null, modelJSON = null) {
  const src = env || {};
  const vp = src.viewport || {};
  const cam = src.camera || {};
  const eng = src.engine || {};

  const viewport = {
    w: isNum(vp.w) && vp.w > 0 ? vp.w : (typeof window !== 'undefined' && window.innerWidth) || 1440,
    h: isNum(vp.h) && vp.h > 0 ? vp.h : (typeof window !== 'undefined' && window.innerHeight) || 900,
    dpr: isNum(vp.dpr) && vp.dpr > 0 ? vp.dpr : (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
  };

  const aspect = isNum(cam.aspect) && cam.aspect > 0
    ? cam.aspect
    : (modelJSON && isNum(modelJSON.aspect) && modelJSON.aspect > 0 ? modelJSON.aspect : 4 / 3);

  const camera = {
    w: isNum(cam.w) && cam.w > 0 ? cam.w : Math.round(480 * aspect),
    h: isNum(cam.h) && cam.h > 0 ? cam.h : 480,
    aspect,
  };

  const engine = {
    name: typeof eng.name === 'string' && eng.name ? eng.name : DEFAULT_ENGINE.name,
    version: eng.version != null && String(eng.version) ? String(eng.version) : DEFAULT_ENGINE.version,
    landmarks: Number.isInteger(eng.landmarks) && eng.landmarks > 0 ? eng.landmarks : DEFAULT_ENGINE.landmarks,
  };

  return { viewport, camera, engine, mirror: !!src.mirror };
}

function signatureOf({ viewport, camera, engine }, terms) {
  return makeSignature({
    viewport: { w: viewport.w, h: viewport.h },
    dpr: viewport.dpr,
    camera: { w: camera.w, h: camera.h },
    engine: `${engine.name}@${engine.version}`,
    terms: terms.x.concat(terms.y),
  });
}

/* ------------------------------------------------------------------ 模型 */

function rawFromModel(model) {
  if (!model) return null;
  if (typeof model.toJSON === 'function') {
    const j = model.toJSON();
    if (!j || j.v !== 3 || !j.ok) return null;
    return j;
  }
  if (model.schema === STORE_SCHEMA) return model;
  // 允许传入 v3 JSON
  if (model.v === 3 && model.ok) return model;
  return null;
}

function toModel(raw) {
  return new GazeCalibModel({
    ok: true,
    variant: raw.variant || 'full',
    termsX: raw.terms.x,
    termsY: raw.terms.y,
    aspect: raw.camera.aspect,
    created: raw.created,
    n: raw.n || (raw.points ? raw.points.length : 0),
    mean: raw.mean,
    std: raw.std,
    wx: raw.wx,
    wy: raw.wy,
    quality: raw.quality,
    points: raw.points,
    diag: raw.diag,
    headRef: raw.headRef || null,
  });
}

/**
 * 读取模型：优先新键，新键无效 / 缺失时回退旧键并升级为 v1。
 *
 * @param {{storage?: Storage}} [opts]
 * @returns {{ok: true, model: GazeCalibModel, raw: object, migrated: boolean}
 *          | {ok: false, reason: 'empty'|'invalid', field?: string, detail?: string}}
 */
export function loadModel(opts = {}) {
  const store = resolveStore(opts.storage);
  if (!store) return { ok: false, reason: 'empty', detail: 'no-storage' };

  const fresh = parseJSON(readRaw(store, STORE_KEYS.model));
  if (fresh) {
    const v = validateStoredModel(fresh);
    if (!v.ok) return { ok: false, reason: 'invalid', field: v.field };
    return { ok: true, model: toModel(fresh), raw: fresh, migrated: false };
  }

  const legacyRaw = readRaw(store, LEGACY_KEYS.model);
  const legacy = parseJSON(legacyRaw);
  if (!legacyRaw) return { ok: false, reason: 'empty' };
  if (!legacy) {
    // 旧键存在但内容不可解析（含显式写入的 'null'）
    return { ok: false, reason: 'empty', detail: 'legacy-null' };
  }

  const up = upgradeLegacy(legacy, opts);
  if (!up.ok) return { ok: false, reason: 'invalid', field: up.field || 'legacy' };
  // 升级结果写回新键，旧键原样保留
  writeRaw(store, STORE_KEYS.model, JSON.stringify(up.raw));
  return { ok: true, model: toModel(up.raw), raw: up.raw, migrated: true };
}

/**
 * 旧格式（v3 GazeCalibModel JSON）→ schema:1。
 * 旧格式没有 viewport / engine / sig，用当前环境补齐并标记 `migrated: true`。
 */
export function upgradeLegacy(legacy, opts = {}) {
  if (!legacy || legacy.v !== 3 || !legacy.ok) {
    return { ok: false, field: 'legacy.v' };
  }
  if (!Array.isArray(legacy.termsX) || !Array.isArray(legacy.termsY)) {
    return { ok: false, field: 'legacy.terms' };
  }
  const env = normalizeEnv(opts.env || null, legacy);
  const terms = { x: legacy.termsX, y: legacy.termsY };
  const raw = {
    schema: STORE_SCHEMA,
    created: isNum(legacy.created) && legacy.created > 0 ? legacy.created : Date.now(),
    engine: env.engine,
    camera: env.camera,
    viewport: env.viewport,
    terms,
    mean: legacy.mean,
    std: legacy.std,
    wx: legacy.wx,
    wy: legacy.wy,
    quality: legacy.quality,
    points: legacy.points || [],
    diag: legacy.diag || null,
    mirror: !!env.mirror,
    sig: signatureOf(env, terms),
    variant: legacy.variant || 'full',
    n: legacy.n || (legacy.points ? legacy.points.length : 0),
    migrated: true,
  };
  if (legacy.unverified) raw.unverified = true;
  const v = validateStoredModel(raw);
  if (!v.ok) return { ok: false, field: `legacy.${v.field}` };
  return { ok: true, raw };
}

/**
 * 保存模型。
 *
 * @param {GazeCalibModel|object} model 模型实例或 v3/schema1 对象
 * @param {{storage?: Storage, env?: object, legacy?: boolean, now?: number}} [opts]
 *        `legacy` 默认 true：同时写 `air-runner.gazeModel`（v3 旧格式），便于回滚。
 * @returns {{ok: true, raw: object} | {ok: false, reason: string, field?: string}}
 */
export function saveModel(model, opts = {}) {
  const store = resolveStore(opts.storage);
  if (!store) return { ok: false, reason: 'no-storage' };

  const j = rawFromModel(model);
  if (!j) return { ok: false, reason: 'invalid-model' };

  const env = normalizeEnv(opts.env || null, j);
  const terms = { x: j.termsX || (j.terms && j.terms.x), y: j.termsY || (j.terms && j.terms.y) };
  const raw = {
    schema: STORE_SCHEMA,
    created: isNum(j.created) && j.created > 0 ? j.created : (opts.now || Date.now()),
    engine: env.engine,
    camera: env.camera,
    viewport: env.viewport,
    terms,
    mean: j.mean,
    std: j.std,
    wx: j.wx,
    wy: j.wy,
    quality: j.quality,
    points: j.points || [],
    diag: j.diag || null,
    mirror: !!env.mirror,
    sig: signatureOf(env, terms),
    variant: j.variant || 'full',
    n: j.n || (j.points ? j.points.length : 0),
  };
  if (j.refine) raw.refine = j.refine;
  // 标定时的头位基准：三页共享同一个模型，也就共享同一套门控基准
  if (j.headRef && typeof j.headRef === 'object') raw.headRef = j.headRef;
  // 留出测试的真实泛化误差：训练集自评会偏乐观，这个才是能对外说的数
  if (opts.validation && typeof opts.validation === 'object') {
    const vv = opts.validation;
    raw.validation = {
      avg: isNum(vv.avg) ? vv.avg : null,
      max: isNum(vv.max) ? vv.max : null,
      avgPx: isNum(vv.avgPx) ? vv.avgPx : null,
      frames: isNum(vv.frames) ? vv.frames : 0,
      points: isNum(vv.points) ? vv.points : 5,
    };
  }
  // unverified 可能挂在实例上（页面用它标记"跳过质量门仍采用"）
  const unverified = !!(j.unverified || (model && model.unverified));
  if (unverified) raw.unverified = true;

  const v = validateStoredModel(raw);
  if (!v.ok) return { ok: false, reason: 'invalid', field: v.field };

  if (!writeRaw(store, STORE_KEYS.model, JSON.stringify(raw))) {
    return { ok: false, reason: 'write-failed' };
  }
  if (opts.legacy !== false) {
    // 旧键写 v3 旧格式，便于回滚；unverified 一并带上
    const legacyJSON = unverified ? { ...j, unverified: true } : j;
    writeRaw(store, LEGACY_KEYS.model, JSON.stringify(legacyJSON));
  }
  return { ok: true, raw };
}

/**
 * 清空模型：写 `null` 保留键位（不是 removeItem）。
 * 旧键同样写 null，避免下次启动又被"迁移"回来。
 */
export function clearModel(opts = {}) {
  const store = resolveStore(opts.storage);
  if (!store) return { ok: false, reason: 'no-storage' };
  writeRaw(store, STORE_KEYS.model, 'null');
  if (opts.legacy !== false) writeRaw(store, LEGACY_KEYS.model, 'null');
  return { ok: true };
}

/* ------------------------------------------------------------------ 样本 / 设置 */

/** 一条样本是否可用：特征齐全 + 标签有限。 */
function validSample(s) {
  if (!s || !s.f || !isNum(s.tx) || !isNum(s.ty)) return false;
  for (const k of FEATURES) if (!isNum(s.f[k])) return false;
  return true;
}

/**
 * 读取样本数组（标定样本 + 点击样本混存）。
 * @returns {Array<{f: object, tx: number, ty: number, kind?: string, t?: number}>}
 */
export function loadSamples(opts = {}) {
  const store = resolveStore(opts.storage);
  if (!store) return [];
  const raw = parseJSON(readRaw(store, STORE_KEYS.samples));
  const arr = Array.isArray(raw) ? raw : null;
  if (!arr) {
    const legacy = parseJSON(readRaw(store, LEGACY_KEYS.samples));
    if (!Array.isArray(legacy)) return [];
    const ok = legacy.filter(validSample);
    if (ok.length) writeRaw(store, STORE_KEYS.samples, JSON.stringify(ok));
    return ok;
  }
  return arr.filter(validSample);
}

/**
 * 保存样本数组（过滤非法项、截断到 MAX_SAMPLES 条最新）。
 * @returns {{ok: true, count: number} | {ok: false, reason: string}}
 */
export function saveSamples(samples, opts = {}) {
  const store = resolveStore(opts.storage);
  if (!store) return { ok: false, reason: 'no-storage' };
  const list = (Array.isArray(samples) ? samples : []).filter(validSample);
  const kept = list.length > MAX_SAMPLES ? list.slice(list.length - MAX_SAMPLES) : list;
  if (!writeRaw(store, STORE_KEYS.samples, JSON.stringify(kept))) {
    return { ok: false, reason: 'write-failed' };
  }
  return { ok: true, count: kept.length };
}

/**
 * 读取设置：与默认值浅合并，并校验类型。
 */
export function loadSettings(opts = {}) {
  const store = resolveStore(opts.storage);
  if (!store) return { ...DEFAULT_SETTINGS };
  const raw = parseJSON(readRaw(store, STORE_KEYS.settings));
  const out = { ...DEFAULT_SETTINGS };
  if (!raw) return out;
  if (typeof raw.mirror === 'boolean') out.mirror = raw.mirror;
  if (typeof raw.train === 'boolean') out.train = raw.train;
  if (typeof raw.extendCorners === 'boolean') out.extendCorners = raw.extendCorners;
  if (isNum(raw.settleMs) && raw.settleMs >= 0) out.settleMs = raw.settleMs;
  if (isNum(raw.collectMs) && raw.collectMs > 0) out.collectMs = raw.collectMs;
  return out;
}

/**
 * 保存设置（只写已知字段）。
 * @returns {{ok: true, settings: object} | {ok: false, reason: string}}
 */
export function saveSettings(settings, opts = {}) {
  const store = resolveStore(opts.storage);
  if (!store) return { ok: false, reason: 'no-storage' };
  const merged = loadSettings(opts);
  const src = settings || {};
  if (typeof src.mirror === 'boolean') merged.mirror = src.mirror;
  if (typeof src.train === 'boolean') merged.train = src.train;
  if (typeof src.extendCorners === 'boolean') merged.extendCorners = src.extendCorners;
  if (isNum(src.settleMs) && src.settleMs >= 0) merged.settleMs = src.settleMs;
  if (isNum(src.collectMs) && src.collectMs > 0) merged.collectMs = src.collectMs;
  if (!writeRaw(store, STORE_KEYS.settings, JSON.stringify(merged))) {
    return { ok: false, reason: 'write-failed' };
  }
  return { ok: true, settings: merged };
}

/* ------------------------------------------------------------------ 兼容判定 */

/**
 * 比较已存模型与当前环境。
 *
 * - `exact`：viewport / camera / engine 全同
 * - `soft` ：viewport 尺寸变化但宽高比相对差 < 0.05，或 dpr 变化，或相机宽高比差 < 0.05
 * - `hard` ：engine 版本变、相机/视口宽高比差 >= 0.05、terms 不兼容
 *
 * 只读：不会修改传入的模型。
 *
 * @param {object|GazeCalibModel} model schema:1 原始对象或模型实例
 * @param {{viewport?: object, camera?: object, engine?: object, terms?: object}} current
 * @returns {{level: 'exact'|'soft'|'hard', diffs: Array<object>, advice: string}}
 */
export function checkCompat(model, current = {}) {
  const raw = rawFromModel(model);
  if (!raw) {
    return {
      level: 'hard',
      diffs: [{ field: 'model', level: 'hard', from: null, to: 'invalid' }],
      advice: '模型不可用，建议重新标定',
    };
  }
  if (raw.v === 3) {
    return {
      level: 'hard',
      diffs: [{ field: 'model', level: 'hard', from: 'v3', to: 'schema1' }],
      advice: '旧格式模型缺少环境信息，建议重新标定',
    };
  }

  const diffs = [];
  const push = (field, level, from, to) => diffs.push({ field, level, from, to });

  const e0 = raw.engine || {};
  const e1 = (current && current.engine) || {};
  if (e1.name && e0.name && e1.name !== e0.name) push('engine.name', 'hard', e0.name, e1.name);
  if (e1.version != null && String(e1.version) !== String(e0.version)) {
    push('engine.version', 'hard', e0.version, String(e1.version));
  }

  if (current && current.terms) {
    const t0 = { x: raw.terms.x, y: raw.terms.y };
    if (!sameTerms(t0, current.terms)) push('terms', 'hard', t0, current.terms);
  }

  const cam0 = raw.camera || {};
  const cam1 = (current && current.camera) || null;
  if (cam1 && isNum(cam1.w) && isNum(cam1.h) && cam1.w > 0 && cam1.h > 0) {
    const a0 = cam0.aspect;
    const a1 = cam1.aspect != null && isNum(cam1.aspect) ? cam1.aspect : cam1.w / cam1.h;
    const rel = Math.abs(a1 - a0) / a0;
    if (rel >= 0.05) push('camera.aspect', 'hard', a0, a1);
    else if (rel > 1e-6) push('camera.aspect', 'soft', a0, a1);
  }

  const vp0 = raw.viewport || {};
  const vp1 = (current && current.viewport) || null;
  if (vp1) {
    if (isNum(vp1.w) && isNum(vp1.h) && vp1.w > 0 && vp1.h > 0) {
      if (vp1.w !== vp0.w || vp1.h !== vp0.h) {
        const rel = Math.abs(vp1.w / vp1.h - vp0.w / vp0.h) / (vp0.w / vp0.h);
        if (rel >= 0.05) push('viewport.size', 'hard', { w: vp0.w, h: vp0.h }, { w: vp1.w, h: vp1.h });
        else push('viewport.size', 'soft', { w: vp0.w, h: vp0.h }, { w: vp1.w, h: vp1.h });
      }
    }
    if (isNum(vp1.dpr) && vp1.dpr !== vp0.dpr) push('viewport.dpr', 'soft', vp0.dpr, vp1.dpr);
  }

  const level = diffs.some((d) => d.level === 'hard')
    ? 'hard'
    : diffs.length
      ? 'soft'
      : 'exact';

  const advice = level === 'hard'
    ? '环境变化较大，建议重新标定'
    : level === 'soft'
      ? '建议做两点校正'
      : '';

  return { level, diffs, advice };
}

/* ------------------------------------------------------------------ 两点校正 */

function qualityFromErrors(errs) {
  if (!errs.length) return null;
  let sum = 0;
  let max = 0;
  for (const e of errs) {
    sum += e;
    if (e > max) max = e;
  }
  const avgErr = sum / errs.length;
  return { avgErr, maxErr: max, grade: gradeOf(avgErr) };
}

/**
 * 两点校正：只做 `target ≈ s * gaze + t`（x/y 各自独立缩放 + 平移，共 4 参数）。
 *
 * 通过重参数化 `wx/wy`（`w0' = s*w0 + t`、`wi' = s*wi`）让原 `predict()` 立刻生效，
 * 不改变 `clamp01` 之前的线性结构，因此不会引入旋转或剪切。
 *
 * @param {object|GazeCalibModel} model
 * @param {{p1:{gaze:{x:number,y:number}, target:{x:number,y:number}},
 *          p2:{gaze:{x:number,y:number}, target:{x:number,y:number}}}} pts
 * @param {{storage?: Storage, now?: number}} [opts]
 * @returns {{ok: true, model: GazeCalibModel, raw: object, s: object, t: object,
 *            before: object, after: object}
 *          | {ok: false, reason: 'invalid'|'degenerate'|'out-of-range', s?: object}}
 */
export function refineWithTwoPoints(model, pts, opts = {}) {
  let raw = rawFromModel(model);
  if (raw && raw.v === 3) {
    // 传模型实例时先补成 schema:1（旧格式没有 viewport/engine，用 opts.env 或当前环境）
    const up = upgradeLegacy(raw, { env: opts.env || null });
    if (!up.ok) return { ok: false, reason: 'invalid' };
    raw = up.raw;
  }
  if (!raw || raw.schema !== STORE_SCHEMA) return { ok: false, reason: 'invalid' };

  const p1 = pts && pts.p1;
  const p2 = pts && pts.p2;
  const num = (o) => o && isNum(o.x) && isNum(o.y);
  if (!num(p1 && p1.gaze) || !num(p1 && p1.target) || !num(p2 && p2.gaze) || !num(p2 && p2.target)) {
    return { ok: false, reason: 'invalid' };
  }

  const dgx = p2.gaze.x - p1.gaze.x;
  const dgy = p2.gaze.y - p1.gaze.y;
  if (Math.abs(dgx) < 1e-3 || Math.abs(dgy) < 1e-3) {
    return { ok: false, reason: 'degenerate' };
  }

  const sx = (p2.target.x - p1.target.x) / dgx;
  const sy = (p2.target.y - p1.target.y) / dgy;
  const tx = p1.target.x - sx * p1.gaze.x;
  const ty = p1.target.y - sy * p1.gaze.y;

  const [lo, hi] = REFINE_SCALE_RANGE;
  if (!isNum(sx) || !isNum(sy) || sx < lo || sx > hi || sy < lo || sy > hi) {
    return { ok: false, reason: 'out-of-range', s: { x: sx, y: sy } };
  }

  const next = JSON.parse(JSON.stringify(raw));
  next.wx = [sx * raw.wx[0] + tx, ...raw.wx.slice(1).map((w) => sx * w)];
  next.wy = [sy * raw.wy[0] + ty, ...raw.wy.slice(1).map((w) => sy * w)];
  next.refine = {
    type: '2pt',
    s: { x: sx, y: sy },
    t: { x: tx, y: ty },
    created: opts.now || Date.now(),
  };

  const before = raw.quality || null;
  const errs = [];
  for (const p of next.points || []) {
    if (!isNum(p.px) || !isNum(p.py) || !isNum(p.tx) || !isNum(p.ty)) continue;
    const nx = clamp01(sx * p.px + tx);
    const ny = clamp01(sy * p.py + ty);
    errs.push(Math.hypot(nx - p.tx, ny - p.ty));
  }
  const after = qualityFromErrors(errs) || before;
  if (after) {
    next.quality = { avgErr: after.avgErr, maxErr: after.maxErr, grade: after.grade };
    if (before && isNum(before.fitErr)) next.quality.fitErr = before.fitErr;
    if (before && before.cv) next.quality.cv = before.cv;
  }

  const v = validateStoredModel(next);
  if (!v.ok) return { ok: false, reason: 'invalid' };

  return {
    ok: true,
    model: toModel(next),
    raw: next,
    s: { x: sx, y: sy },
    t: { x: tx, y: ty },
    before,
    after: next.quality || null,
  };
}

/**
 * 校正并直接落盘（可选便捷入口）。
 * @returns 同 refineWithTwoPoints，另加 `saved: boolean`
 */
export function applyRefine(model, pts, opts = {}) {
  const r = refineWithTwoPoints(model, pts, opts);
  if (!r.ok) return r;
  if (!opts.storage) return { ...r, saved: false };
  const saved = saveModel(r.model, { storage: opts.storage, env: opts.env, legacy: opts.legacy !== false });
  return { ...r, saved: !!saved.ok };
}
