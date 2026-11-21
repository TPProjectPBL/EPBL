/**
 * @file 在线学习（点击即训练）——共享版。
 *
 * 从 `eye-page-turner/demo/air-runner/lib/gaze-online.js` 迁移，算法与常量保持不变，
 * 补三件事：
 *   1. `noteClick({features, target, source, ts})`：统一的入口，自带新鲜度与坐标空间校验；
 *   2. `subscribe(cb)`：模型被安全阀放行后通知所有关心的人（各模块订阅同一个实例）；
 *   3. 持久化走 `store.saveSamples`（新键），并双写旧键 `air-runner.gazeSamples` 方便回滚。
 *
 * 为什么需要它：真机实测「跨会话漂移是会话内信号的 20 倍」——换一次坐姿，eyeDist 跳 0.0217，
 * 而同一坐姿内 9 个标定点之间的差异只有 0.001 量级。9 点标定只是某个瞬间的姿势快照，
 * 用户往后靠一靠就过期了；而人不会愿意反复做 9 点标定，所以「顺手点几下就把模型更新了」
 * 是唯一可行的路子。
 *
 * 三条安全约束（与 WebGazer 的关键区别）：
 *   1. 节流：至少新增 N 条、且距上次训练超过 T 毫秒才重训；
 *   2. 样本上限：只保留权重最高（最新）的若干条，防止 localStorage 膨胀、避免老姿势主导；
 *   3. 安全阀：新模型必须在**同一份样本集**上不差于旧模型，否则拒收。
 *      「点了按钮但眼睛在看别处」这类污染样本是必然存在的，没有这道门模型会被带坏。
 *
 * 全局开关：`enabled=false`（`?train=0` 或设置项）时，`noteClick` 直接返回，
 * 样本池保持为空 ⇒ 数值路径与「从来没有点击样本」完全一致。
 */

import { GazeCalibModel, CLICK_HALF_LIFE_MS, sampleWeights } from './core/index.js';
import { loadSamples, saveSamples } from './store.js';

/** 样本池上限（含标定样本）。48 条约 10KB JSON。 */
export const SAMPLE_POOL_MAX = 48;
/** 至少新增这么多点击样本才值得重训。 */
export const RETRAIN_MIN_NEW = 3;
/** 两次重训的最小间隔（留一循环几十毫秒，别让它每帧都跑）。 */
export const RETRAIN_MIN_GAP_MS = 3000;
/** 安全阀：新模型在同一份样本上的平均误差允许比旧模型差这个比例。 */
export const GUARD_RATIO = 0.15;
/** 安全阀的绝对宽松量（PAGE_NORM）：小误差上纯相对阈值过于苛刻。 */
export const GUARD_SLACK = 0.01;
/**
 * 特征新鲜度窗口（ms）。人脸刚要丢/刚丢时缓存的是几帧前的特征，而标签是「现在点的元素」，
 * 两者不同步的样本比没有样本更坏。300ms ≈ 30fps 下 9 帧。
 */
export const CLICK_MAX_AGE_MS = 300;
/** 旧样本键：只读迁移 + 双写，保证回滚到旧版本时数据还在。 */
export const LEGACY_SAMPLES_KEY = 'air-runner.gazeSamples';
/** 合法来源。`calib` 来自标定/两点校正，`click` 来自真实点击，`refine` 来自校正后的补采。 */
export const SOURCES = Object.freeze(['calib', 'click', 'refine']);
/** 训练所需最小样本数（与 fit 的门槛一致）。 */
export const MIN_SAMPLES = 8;

/**
 * 用同一份样本给模型打分（样本内误差，绝对值偏乐观）。
 * 关键是「同一个集合、同一个函数」给新旧模型打分——相对比较才公平，安全阀才有意义。
 */
export function evalModelOn(model, samples) {
  if (!model || !model.ok) return Infinity;
  let sum = 0;
  let n = 0;
  for (const p of samples) {
    const q = model.predict(p.f);
    if (!q || !isFinite(q.x) || !isFinite(q.y)) continue;
    sum += Math.hypot(q.x - p.tx, q.y - p.ty);
    n += 1;
  }
  return n ? sum / n : Infinity;
}

/** PAGE_NORM 判定：0..1 且显式声明空间时不能是别的空间。像素坐标会被这里挡掉。 */
export function isPageNorm(target) {
  if (!target || typeof target !== 'object') return false;
  if (target.space && target.space !== 'PAGE_NORM' && target.space !== 'page-norm') return false;
  const x = Number(target.x);
  const y = Number(target.y);
  return isFinite(x) && isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1;
}

const FEATURE_KEYS = ['dLx', 'dLy', 'dRx', 'dRy', 'faceCx', 'faceCy', 'eyeDist', 'roll'];

function featuresOk(f) {
  if (!f || typeof f !== 'object') return false;
  for (const k of FEATURE_KEYS) if (!isFinite(f[k])) return false;
  return true;
}

export class GazeOnlineTrainer {
  constructor({
    maxSamples = SAMPLE_POOL_MAX,
    minNew = RETRAIN_MIN_NEW,
    minGapMs = RETRAIN_MIN_GAP_MS,
    guard = GUARD_RATIO,
    halfLifeMs = CLICK_HALF_LIFE_MS,
  } = {}) {
    this.maxSamples = maxSamples;
    this.minNew = minNew;
    this.minGapMs = minGapMs;
    this.guard = guard;
    this.halfLifeMs = halfLifeMs;
    /** 最近一次标定样本（重新标定时整体替换） */
    this.base = [];
    /** 点击样本（跨会话保留） */
    this.clicks = [];
    this.pending = 0;
    this.lastTrainAt = 0;
    this.lastStatus = 'idle';
    /** 累计接受的点击条数（诊断用：diag.nClick 的来源之一） */
    this.nClick = 0;
  }

  get total() {
    return this.base.length + this.clicks.length;
  }

  /** 重新标定：换掉标定样本，点击样本保留（它们代表最新坐姿，正是要的）。 */
  setBase(samples) {
    this.base = (samples || []).map((s) => ({ ...s, kind: s.kind || 'calib' }));
    this._prune();
    return this.total;
  }

  /**
   * 记一次样本。
   * @param {object} f   当前帧特征（FEATURES 八个比值）
   * @param {number} tx  目标点 x（PAGE_NORM）
   * @param {number} ty  目标点 y（PAGE_NORM）
   * @param {number} t   时间戳（ms，Date.now 基准：样本要跨会话）
   * @param {string} [kind='click']
   */
  addClick(f, tx, ty, t, kind = 'click') {
    if (!featuresOk(f) || !isFinite(tx) || !isFinite(ty)) return this.total;
    if (tx < 0 || tx > 1 || ty < 0 || ty > 1) return this.total;
    this.clicks.push({ f: { ...f }, tx, ty, t, kind: SOURCES.includes(kind) ? kind : 'click' });
    this.pending += 1;
    this.nClick += 1;
    this._prune(t);
    return this.total;
  }

  /** 池满时按权重淘汰：标定样本永不淘汰，点击样本里挑权重最低（最老）的丢。 */
  _prune(now = 0) {
    const overflow = this.total - this.maxSamples;
    if (overflow <= 0) return;
    if (!this.clicks.length) return;
    const w = sampleWeights(this.clicks, now, this.halfLifeMs) || this.clicks.map(() => 1);
    const order = this.clicks.map((_, i) => i).sort((a, b) => w[a] - w[b] || a - b);
    const drop = new Set(order.slice(0, Math.min(overflow, this.clicks.length)));
    this.clicks = this.clicks.filter((_, i) => !drop.has(i));
  }

  /** 全部样本（标定 + 点击），fit 直接吃这个数组。 */
  all() {
    return [...this.base, ...this.clicks];
  }

  /** 现在该不该重训。 */
  due(now, extraSamples = 0) {
    if (this.pending < this.minNew) return false;
    if (this.total + extraSamples < MIN_SAMPLES) return false;
    if (this.lastTrainAt && now - this.lastTrainAt < this.minGapMs) return false;
    return true;
  }

  /**
   * 重训 + 安全阀。判据：新模型在同一份样本集上的平均误差，
   * 不得超过「旧模型 × (1+guard) + 绝对地板」。
   */
  train({ now = 0, aspect = 4 / 3, ridge = 0.01, judge = null } = {}) {
    const samples = this.all();
    if (samples.length < MIN_SAMPLES) {
      this.lastStatus = 'insufficient';
      return { status: 'insufficient', model: null, prevErr: NaN, nextErr: NaN, n: samples.length };
    }
    const next = GazeCalibModel.fit(samples, { aspect, ridge, now, halfLifeMs: this.halfLifeMs });
    if (!next || !next.ok) {
      // fit 内部三道门已拒绝：保持旧模型。同样消费 pending，否则每 3 秒重算同一个失败结果。
      this.pending = 0;
      this.lastTrainAt = now;
      this.lastStatus = 'failed';
      return {
        status: 'failed',
        model: null,
        prevErr: NaN,
        nextErr: NaN,
        n: samples.length,
        reason: next ? next.reason : 'null',
      };
    }
    const nextErr = evalModelOn(next, samples);
    const prevErr = judge ? evalModelOn(judge, samples) : Infinity;
    if (isFinite(prevErr) && nextErr > prevErr * (1 + this.guard) + GUARD_SLACK) {
      // 新模型把误差带大了（多半是污染点击）：拒收，但消费 pending。
      this.pending = 0;
      this.lastTrainAt = now;
      this.lastStatus = 'rejected';
      return { status: 'rejected', model: null, prevErr, nextErr, n: samples.length };
    }
    this.pending = 0;
    this.lastTrainAt = now;
    this.lastStatus = 'accepted';
    return { status: 'accepted', model: next, prevErr, nextErr, n: samples.length };
  }

  clearClicks() {
    this.clicks = [];
    this.pending = 0;
    this.nClick = 0;
    return this.total;
  }

  stats() {
    return {
      base: this.base.length,
      clicks: this.clicks.length,
      total: this.total,
      pending: this.pending,
      nClick: this.nClick,
      status: this.lastStatus,
    };
  }

  /** 持久化：只存特征/标签/时间，不含任何图像。 */
  toJSON() {
    return {
      v: 1,
      clicks: this.clicks.map((c) => ({ f: c.f, tx: c.tx, ty: c.ty, t: c.t, kind: c.kind })),
    };
  }

  static fromJSON(obj, opts) {
    const t = new GazeOnlineTrainer(opts);
    if (!obj || obj.v !== 1 || !Array.isArray(obj.clicks)) return t;
    for (const c of obj.clicks) {
      if (!c || !c.f) continue;
      t.addClick(c.f, c.tx, c.ty, isFinite(c.t) ? c.t : 0, c.kind || 'click');
    }
    t.pending = 0; // 恢复出来的样本不触发立即重训（等用户下一次点击）
    return t;
  }
}

/* ------------------------------------------------------------------ 便捷封装 */

function readLegacyClicks(storage) {
  try {
    const raw = storage && storage.getItem(LEGACY_SAMPLES_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || obj.v !== 1 || !Array.isArray(obj.clicks)) return null;
    return obj;
  } catch {
    return null;
  }
}

/**
 * 创建一个「共享在线学习」实例。
 *
 * @param {object} [opts]
 * @param {Storage} [opts.storage]
 * @param {boolean} [opts.enabled=true] 全局开关；false 时 noteClick 直接忽略
 * @param {() => number} [opts.getAspect] 当前视频宽高比（默认 4/3）
 * @param {() => object|null} [opts.getJudge] 当前线上模型（安全阀的对照物）
 * @param {(payload: object) => void} [opts.onModel] 模型被接受时的兜底回调（等价 subscribe）
 * @param {number} [opts.now] 测试用时钟
 */
export function createOnline(opts = {}) {
  const storage = opts.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  const trainer = new GazeOnlineTrainer(opts);
  const listeners = new Set();
  let enabled = opts.enabled !== false;
  let lastFeatures = null;
  let lastFeaturesAt = 0;

  // 启动时合并样本：新键优先，旧键（air-runner.gazeSamples）只读迁移后双写。
  (function hydrate() {
    try {
      const legacy = readLegacyClicks(storage);
      if (legacy) {
        const t2 = GazeOnlineTrainer.fromJSON(legacy, opts);
        if (t2.total) {
          for (const c of t2.clicks) trainer.addClick(c.f, c.tx, c.ty, c.t, c.kind);
          trainer.pending = 0;
        }
      }
      const arr = loadSamples({ storage });
      const clicks = arr.filter((s) => s && s.kind && s.kind !== 'calib');
      if (clicks.length) {
        // 新键里有更新的记录时以它为准（避免旧键反复覆盖）
        trainer.clearClicks();
        for (const c of clicks) trainer.addClick(c.f, c.tx, c.ty, isFinite(c.t) ? c.t : 0, c.kind || 'click');
        trainer.pending = 0;
      }
    } catch {
      /* 隐私模式下忽略 */
    }
  })();

  function persist() {
    const j = trainer.toJSON();
    try {
      // 主键：store 的样本数组（与标定样本共用一个池）
      saveSamples(trainer.clicks.map((c) => ({ f: c.f, tx: c.tx, ty: c.ty, t: c.t, kind: c.kind })), {
        storage,
      });
    } catch {
      /* 忽略 */
    }
    try {
      // 旧键双写：便于回滚到 air-runner 旧版本
      if (j.clicks.length) storage && storage.setItem(LEGACY_SAMPLES_KEY, JSON.stringify(j));
      else storage && storage.removeItem(LEGACY_SAMPLES_KEY);
    } catch {
      /* 忽略 */
    }
  }

  function retrain() {
    const now = Date.now();
    const judge = (opts.getJudge && opts.getJudge()) || null;
    const aspect = (opts.getAspect && opts.getAspect()) || 4 / 3;
    const r = trainer.train({ now, aspect, judge });
    if (r.status === 'accepted') {
      persist();
      for (const cb of Array.from(listeners)) {
        try {
          cb({ ...r, trainer: trainer.stats() });
        } catch (e) {
          console.warn('[gaze-online] subscribe 回调抛错', e);
        }
      }
      if (opts.onModel) {
        try {
          opts.onModel(r);
        } catch (e) {
          console.warn('[gaze-online] onModel 抛错', e);
        }
      }
    }
    return r;
  }

  let trainTimer = null;
  function scheduleRetrain() {
    if (trainTimer !== null) return;
    // 放到下一轮事件循环：点击要立刻有反馈，重训（几十毫秒）不能卡在点击响应里
    trainTimer = setTimeout(() => {
      trainTimer = null;
      retrain();
    }, 0);
  }

  const api = {
    trainer,
    get enabled() {
      return enabled;
    },
    setEnabled(v) {
      enabled = !!v;
      return enabled;
    },
    /** 模块每帧（或每隔几帧）调用：记下最新特征与其时间戳，供 noteClick 判新鲜度。 */
    markFeatures(f, ts) {
      if (!featuresOk(f)) return false;
      lastFeatures = f;
      lastFeaturesAt = isFinite(ts) ? ts : Date.now();
      return true;
    },
    get lastFeatures() {
      return lastFeatures;
    },
    get lastFeaturesAt() {
      return lastFeaturesAt;
    },

    /**
     * 记一次点击。只有「PAGE_NORM 目标 + 新鲜特征 + 在范围内」才接受。
     * @returns {{accepted: boolean, reason?: string, total?: number, retrainScheduled?: boolean}}
     */
    noteClick({ features, target, source = 'click', ts } = {}) {
      if (!enabled) return { accepted: false, reason: 'disabled' };
      if (!SOURCES.includes(source)) return { accepted: false, reason: 'bad-source' };
      if (!isPageNorm(target)) return { accepted: false, reason: 'not-page-norm' };
      const f = features || lastFeatures;
      if (!featuresOk(f)) return { accepted: false, reason: 'no-features' };
      const now = isFinite(ts) ? ts : Date.now();
      const at = isFinite(f && f.ts) ? f.ts : lastFeaturesAt;
      if (!at) return { accepted: false, reason: 'no-features' };
      const age = now - at;
      if (!(age >= 0 && age <= CLICK_MAX_AGE_MS)) return { accepted: false, reason: 'stale-features' };
      const before = trainer.total;
      trainer.addClick(f, Number(target.x), Number(target.y), now, source);
      if (trainer.total === before) return { accepted: false, reason: 'rejected-sample' };
      persist();
      const due = trainer.due(now);
      if (due) scheduleRetrain();
      return { accepted: true, total: trainer.total, retrainScheduled: due };
    },

    /** 标定完成后把它作为可信基座喂进来（点击样本单独累积）。 */
    rebase(samples) {
      const n = trainer.setBase(samples);
      persist();
      return n;
    },

    /** 模型被安全阀放行时回调。返回 unsubscribe。 */
    subscribe(cb) {
      if (typeof cb !== 'function') return () => {};
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    retrain,
    due(now = Date.now()) {
      return trainer.due(now);
    },
    stats() {
      return { ...trainer.stats(), enabled, lastFeaturesAt };
    },
    clear() {
      trainer.clearClicks();
      persist();
      return trainer.total;
    },
    save: persist,
  };
  return api;
}

export default createOnline;
