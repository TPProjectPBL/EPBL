/**
 * @file IndexedDB 模型库（统一标定的唯一模型来源）。
 *
 * 协议要求：
 *   - 每次标定完成后**覆盖写入** IndexedDB，键名固定 `gaze_model`
 *   - 子项目启动时从这里读取；读取失败必须回到标定页
 *
 * 数据库：epbl-gaze / 对象仓库：models / 主键：gaze_model
 *
 * 旧版 localStorage 模型（schema 1）只作为迁移来源读取：首次读到旧模型时
 * 复制到 IndexedDB，之后一律以 IndexedDB 为准。
 */

import { IDB, MODEL_VERSION } from './calibrate/protocol.js';
import { predictPoly2 } from './calibrate/poly2.js';

const LEGACY_KEY = 'epbl.gaze.model.v1';

/** IndexedDB 是否可用（Safari 隐私模式等场景会抛错）。 */
export function idbAvailable() {
  try {
    return typeof indexedDB !== 'undefined' && !!indexedDB;
  } catch {
    return false;
  }
}

/**
 * 打开数据库（单例）。
 * @returns {Promise<IDBDatabase>}
 */
export function openDB() {
  if (!idbAvailable()) return Promise.reject(new Error('indexeddb-unavailable'));
  if (openDB._p) return openDB._p;
  openDB._p = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB.db, IDB.version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB.store)) {
        db.createObjectStore(IDB.store);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexeddb-open-failed'));
    req.onblocked = () => reject(new Error('indexeddb-blocked'));
  });
  return openDB._p;
}

function tx(mode, run) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(IDB.store, mode);
        const store = t.objectStore(IDB.store);
        let out;
        try {
          out = run(store);
        } catch (e) {
          reject(e);
          return;
        }
        t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
        t.onerror = () => reject(t.error || new Error('indexeddb-tx-failed'));
        t.onabort = () => reject(t.error || new Error('indexeddb-tx-aborted'));
      }),
  );
}

/**
 * 覆盖写入模型。
 * @param {object} data 标定产物（含 model / validation / headRef …）
 * @returns {Promise<object>} 实际写入的记录
 */
export function putGazeModel(data) {
  const record = Object.assign(
    {
      schema: MODEL_VERSION,
      key: IDB.key,
      createdAt: Date.now(),
    },
    data || {},
  );
  return tx('readwrite', (store) => {
    store.put(record, IDB.key);
    return record;
  });
}

/**
 * 读取原始记录（不包装）。
 * @returns {Promise<object|null>}
 */
export function getGazeModel() {
  return tx('readonly', (store) => store.get(IDB.key)).catch(() => null);
}

/** 删除模型。 */
export function deleteGazeModel() {
  return tx('readwrite', (store) => {
    store.delete(IDB.key);
    return true;
  }).catch(() => false);
}

/**
 * 把存储记录包装成可预测对象。
 * @param {object|null} raw
 */
export function toPredictor(raw) {
  if (!raw || !raw.model || !raw.model.ok) return null;
  const m = raw.model;
  if (!m.predict) {
    m.predict = (f) => predictPoly2(m, f);
  }
  m.schema = raw.schema || MODEL_VERSION;
  m.createdAt = raw.createdAt || 0;
  m.validation = raw.validation || null;
  m.headRef = raw.headRef || m.headRef || null;
  return m;
}

/**
 * 读取可直接用于 page-bridge / 子项目的模型实例。
 *
 * 顺序：IndexedDB → 旧 localStorage（仅迁移读取）。读到旧模型会异步回写到 IndexedDB。
 *
 * @returns {Promise<object|null>}
 */
export function readPredictor() {
  return getGazeModel()
    .then((raw) => {
      const m = toPredictor(raw);
      if (m) return m;
      return migrateLegacy();
    })
    .catch(() => migrateLegacy());
}

function migrateLegacy() {
  try {
    const s = localStorage.getItem(LEGACY_KEY);
    if (!s) return null;
    const raw = JSON.parse(s);
    const stored = raw && raw.model ? raw : { model: raw };
    if (!stored || !stored.model || !stored.model.ok) return null;
    const m = toPredictor(stored);
    if (!m) return null;
    // 旧模型是 schema 1（8 特征线性），只在 IDB 还没有记录时临时使用，
    // 下一次完整标定会立即覆盖。
    putGazeModel({ schema: raw.schema || 1, legacy: true, model: stored.model, validation: stored.validation || null }).catch(
      () => {},
    );
    return m;
  } catch {
    return null;
  }
}

/**
 * 读取失败时的统一出口：抛出带 code 的错误，由页面决定跳转标定页。
 * @returns {Promise<object>}
 */
export async function requirePredictor() {
  const m = await readPredictor();
  if (!m) {
    const err = new Error('gaze-model-missing');
    err.code = 'gaze-model-missing';
    throw err;
  }
  return m;
}
