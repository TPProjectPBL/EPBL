/**
 * 在线学习（点击即训练）——借鉴 WebGazer 的核心机制，但完全跑在自研标定模型上。
 *
 * WebGazer 的做法：用户的每一次点击都是一条训练样本（点击位置=标签，当时的面部特征=输入），
 * 回归器用 weightedRidge 持续重训，新样本权重更高，结果存本地、下次会话继续用。
 *
 * 我们为什么需要它：真机实测「跨会话漂移是会话内信号的 20 倍」（换一次坐姿，eyeDist 就跳
 * 0.0217，而同一坐姿内 9 个标定点之间的差异只有 0.001 量级）。也就是说 9 点标定只是一张
 * 「某个瞬间的姿势快照」，只要用户往后靠一靠、椅子转一点，快照就过期了。靠离线算法无法修
 * （已实测跨会话泛化 20~70% 误差），只能靠**持续标定**——而用户不会愿意反复做 9 点标定，
 * 所以「顺手点几下就把模型更新了」是唯一可行的路子。
 *
 * 三条安全约束（这是与 WebGazer 的关键区别，它没有这些保护）：
 *   1. 节流：至少新增 N 条样本、且距上次训练超过 T 毫秒才重训。逐次点击都重训会把主线程拖住。
 *   2. 样本上限：只保留权重最高（最新）的若干条，防止 localStorage 无限增长、也避免老姿势主导。
 *   3. 安全阀：新模型必须在**同一份样本集**上不差于旧模型，否则拒收。防止一两次误点击
 *      （用户点了按钮但眼睛在看别处）把模型带坏——这类污染样本是必然存在的。
 */

import { GazeCalibModel, CLICK_HALF_LIFE_MS } from './gaze-calib.js';
import { sampleWeights } from './gaze-calib.js';

/** 样本池上限（含标定样本）。48 条约 10KB JSON，localStorage 毫无压力 */
export const SAMPLE_POOL_MAX = 48;
/** 至少新增这么多点击样本才值得重训（一次重训要跑 N 套特征集 × 5 个 λ × 留一） */
export const RETRAIN_MIN_NEW = 3;
/** 两次重训的最小间隔：留一循环在 48 样本 × 5λ × 2 特征集下约几十毫秒，别让它变成每帧都跑 */
export const RETRAIN_MIN_GAP_MS = 3000;
/** 安全阀：新模型在同一份样本上的平均误差允许比旧模型差这个比例 */
export const GUARD_RATIO = 0.15;
/** 安全阀的绝对宽松量（归一化单位）：相对阈值在小误差上过于苛刻，留 1% 屏宽的地板 */
export const GUARD_SLACK = 0.01;

/**
 * 用同一份样本给模型打分（样本内误差，绝对值偏乐观）。
 * 关键是「同一个集合、同一个函数」给新旧模型打分——这样相对比较是公平的，安全阀才有意义。
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
    /** 最近一次 9 点标定样本（重新标定时整体替换） */
    this.base = [];
    /** 点击样本（跨会话保留） */
    this.clicks = [];
    this.pending = 0;
    this.lastTrainAt = 0;
    this.lastStatus = 'idle';
  }

  get total() {
    return this.base.length + this.clicks.length;
  }

  /** 重新标定：换掉标定样本，点击样本保留（它们代表最新的坐姿，正是我们要的） */
  setBase(samples) {
    this.base = (samples || []).map((s) => ({ ...s, kind: s.kind || 'calib' }));
    this._prune();
    return this.total;
  }

  /**
   * 记一次点击：把「当时的面部特征」和「点击落在屏幕哪里」配成一条训练样本。
   * @param {object} f 当前帧特征（FEATURES 八个比值）
   * @param {number} tx 目标点 x（归一化）
   * @param {number} ty 目标点 y（归一化）
   * @param {number} t  时间戳（ms）
   */
  addClick(f, tx, ty, t) {
    if (!f || !isFinite(tx) || !isFinite(ty)) return this.total;
    for (const k of ['dLx', 'dLy', 'dRx', 'dRy', 'faceCx', 'faceCy', 'eyeDist', 'roll']) {
      if (!isFinite(f[k])) return this.total;
    }
    this.clicks.push({ f: { ...f }, tx, ty, t, kind: 'click' });
    this.pending += 1;
    this._prune(t);
    return this.total;
  }

  /** 池满时按权重淘汰：标定样本永不淘汰，点击样本里挑权重最低（最老）的丢 */
  _prune(now = 0) {
    const overflow = this.total - this.maxSamples;
    if (overflow <= 0) return;
    if (!this.clicks.length) return;
    const w = sampleWeights(this.clicks, now, this.halfLifeMs) || this.clicks.map(() => 1);
    const order = this.clicks.map((_, i) => i).sort((a, b) => w[a] - w[b] || a - b);
    const drop = new Set(order.slice(0, Math.min(overflow, this.clicks.length)));
    this.clicks = this.clicks.filter((_, i) => !drop.has(i));
  }

  /** 全部样本（标定 + 点击），fit 直接吃这个数组 */
  all() {
    return [...this.base, ...this.clicks];
  }

  /** 现在该不该重训 */
  due(now, extraSamples = 0) {
    if (this.pending < this.minNew) return false;
    if (this.total + extraSamples < 8 /* MIN_SAMPLES */) return false;
    if (this.lastTrainAt && now - this.lastTrainAt < this.minGapMs) return false;
    return true;
  }

  /**
   * 重训 + 安全阀。
   *
   * 安全阀判据：新模型在**同一份样本集**上的平均误差，不得超过「旧模型 × (1+guard) + 绝对地板」。
   * - 用同一个集合同一个函数给新旧模型打分，相对比较才公平（否则口径不同，数字没法比）。
   * - 加绝对地板因为：标定模型的样本内误差很小（0.3% 屏宽量级），纯相对阈值会把
   *   「0.3% → 0.6%」这种仍然优秀的模型判死。
   * - 注：这不是万能的（有意的污染样本无法与「姿势漂移」区分），但配合 fit 自身的
   *   MAX_ACCEPT_ERR 退化门，能挡住绝大多数「点了按钮但眼睛在看别处」的累积污染。
   *
   * @param {object} o
   * @param {number} o.now    现在
   * @param {number} o.aspect 视口宽高比
   * @param {number} o.ridge  岭系数（正常由 fit 自己扫网格，这里一般传默认）
   * @param {object} o.judge  当前生效的模型；新模型必须在同一份样本上不差于它
   */
  train({ now = 0, aspect = 4 / 3, ridge = 0.01, judge = null } = {}) {
    const samples = this.all();
    if (samples.length < 8) {
      this.lastStatus = 'insufficient';
      return { status: 'insufficient', model: null, prevErr: NaN, nextErr: NaN, n: samples.length };
    }
    const next = GazeCalibModel.fit(samples, { aspect, ridge, now, halfLifeMs: this.halfLifeMs });
    if (!next || !next.ok) {
      // fit 内部的三道门（样本不足 / 奇异 / 退化）已经拒绝了：保持旧模型。
      // 同样消费 pending 并记时间戳——否则每 3 秒（节流间隔）就重算一遍同一个失败结果；
      // 等下次再攒够 minNew 条新样本自然会重试。
      this.pending = 0;
      this.lastTrainAt = now;
      this.lastStatus = 'failed';
      return { status: 'failed', model: null, prevErr: NaN, nextErr: NaN, n: samples.length, reason: next ? next.reason : 'null' };
    }
    const nextErr = evalModelOn(next, samples);
    const prevErr = judge ? evalModelOn(judge, samples) : Infinity;
    if (isFinite(prevErr) && nextErr > prevErr * (1 + this.guard) + GUARD_SLACK) {
      // 新模型把误差带大了（多半是污染点击）：拒收，但仍消费 pending，
      // 否则每次点击都会重算一遍同一个坏结果
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
    return this.total;
  }

  /** 持久化：只存特征/标签/时间，不含任何图像（比值本身已做过缩放不变性处理） */
  toJSON() {
    return {
      v: 1,
      clicks: this.clicks.map((c) => ({ f: c.f, tx: c.tx, ty: c.ty, t: c.t })),
    };
  }

  static fromJSON(obj, opts) {
    const t = new GazeOnlineTrainer(opts);
    if (!obj || obj.v !== 1 || !Array.isArray(obj.clicks)) return t;
    for (const c of obj.clicks) {
      if (!c || !c.f) continue;
      t.addClick(c.f, c.tx, c.ty, isFinite(c.t) ? c.t : 0);
    }
    t.pending = 0; // 恢复出来的样本不触发立即重训（等用户下一次点击）
    return t;
  }
}
