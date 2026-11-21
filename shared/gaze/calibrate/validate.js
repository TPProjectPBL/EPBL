/**
 * @file 5 点留出校验。
 *
 * 与标定共用同一条特征路径与中位数规则：
 *   逐帧收集 → medianSample(窗口) → model.predict(sample) → 误差
 * 因此这里的误差是「换 5 个没参与训练的点」的泛化误差，不是训练集自评。
 *
 * 坐标：points 直接是 PAGE_NORM（0..1，页面归一化），因为留出点通常由调用方指定在整屏范围。
 */
import { CALIB, errToPx } from '../contract.js';
import { medianSample, isFaceUsable } from '../core/index.js';

const DEFAULT_POINTS = [
  { tx: 0.2, ty: 0.2 },
  { tx: 0.8, ty: 0.2 },
  { tx: 0.5, ty: 0.5 },
  { tx: 0.2, ty: 0.8 },
  { tx: 0.8, ty: 0.8 },
];

function toPoint(p) {
  return Array.isArray(p) ? { tx: Number(p[0]), ty: Number(p[1]) } : { tx: Number(p.tx), ty: Number(p.ty) };
}

export class Validator {
  /**
   * @param {object} options
   * @param {object} options.model GazeCalibModel（必须 ok）
   * @param {Array<{tx:number,ty:number}>|Array<[number,number]>} [options.points] 5 个 PAGE_NORM 点
   * @param {number} [options.settleMs]
   * @param {number} [options.collectMs]
   * @param {number} [options.minFrames]
   * @param {()=>Array|null} [options.getLandmarks]
   * @param {()=>number} [options.getAspect]
   * @param {(s:object)=>void} [options.onProgress]
   * @param {(r:object)=>void} [options.onDone]
   */
  constructor(options = {}) {
    const {
      model,
      points = DEFAULT_POINTS,
      settleMs = CALIB.settleMs,
      collectMs = CALIB.collectMs,
      minFrames = CALIB.minFrames,
      getLandmarks,
      getAspect,
      aspect = 4 / 3,
      onProgress,
      onDone,
      maxFrames = 90,
    } = options;

    if (!model || !model.ok) throw new TypeError('Validator: 需要一个可用的 model');

    this.model = model;
    this.points = points.map(toPoint);
    this.settleMs = settleMs;
    this.collectMs = collectMs;
    this.minFrames = minFrames;
    this.maxFrames = maxFrames;
    this.getLandmarks = getLandmarks || null;
    this.getAspect = getAspect || null;
    this.fixedAspect = aspect;
    this.onProgress = onProgress || null;
    this.onDone = onDone || null;

    this.phase = 'idle';
    this.idx = 0;
    this.samples = [];
    this.skipped = [];
    this.frames = [];
    this.armed = false;
    this.t0 = 0;
    this.c0 = 0;
    this.note = '';
    this.result = null;
    this.started = false;
    this.totalFrames = 0;
    this._lastNow = 0;
  }

  get state() {
    return {
      phase: this.phase,
      idx: this.idx,
      total: this.points.length,
      progress: this._progress(),
      note: this.note,
      samples: this.samples.length,
      skipped: this.skipped.length,
    };
  }

  start() {
    this.phase = 'settle';
    this.idx = 0;
    this.samples = [];
    this.skipped = [];
    this.frames = [];
    this.armed = false;
    this.t0 = 0;
    this.c0 = 0;
    this.note = '';
    this.result = null;
    this.totalFrames = 0;
    this.started = true;
    this._emit();
    return this.state;
  }

  update(now, lm) {
    this._lastNow = now;
    if (!this.started || this.phase === 'idle' || this.phase === 'result' || this.phase === 'fit') {
      return this.state;
    }

    const p = this.points[this.idx];
    if (!p) return this.state;

    const current =
      lm !== undefined
        ? lm
        : this.getLandmarks
          ? this.getLandmarks({ index: this.idx, tx: p.tx, ty: p.ty, page: { x: p.tx, y: p.ty } })
          : null;
    const usable = isFaceUsable(current);

    if (this.phase === 'settle') {
      if (!usable) {
        this.note = 'waiting-face';
        this._emit();
        return this.state;
      }
      if (!this.armed) {
        this.armed = true;
        this.t0 = now;
        this.note = '';
      }
      if (now - this.t0 >= this.settleMs) {
        this.phase = 'collect';
        this.c0 = now;
        this.frames = [];
      }
      this._emit();
      return this.state;
    }

    if (this.phase === 'collect') {
      if (usable) {
        this.frames.push({ lm: current, tx: p.tx, ty: p.ty, ts: now });
        this.totalFrames += 1;
        if (this.frames.length > this.maxFrames) this.frames.shift();
      }
      if (now - this.c0 >= this.collectMs) {
        this._finishPoint();
        return this.state;
      }
      this._emit();
      return this.state;
    }

    return this.state;
  }

  cancel() {
    this.started = false;
    this.phase = 'idle';
    this.frames = [];
    return this.state;
  }

  aspect() {
    if (this.getAspect) {
      const v = Number(this.getAspect());
      if (Number.isFinite(v) && v > 0) return v;
    }
    return this.fixedAspect;
  }

  _finishPoint() {
    this.phase = 'next';
    const p = this.points[this.idx];

    if (this.frames.length >= this.minFrames) {
      const s = medianSample(this.frames, this.aspect());
      if (s) this.samples.push(s);
      else this.skipped.push({ index: this.idx, tx: p.tx, ty: p.ty, reason: 'invalid-sample', frames: this.frames.length });
    } else {
      this.skipped.push({ index: this.idx, tx: p.tx, ty: p.ty, reason: 'insufficient-frames', frames: this.frames.length });
    }

    this.idx += 1;
    this.frames = [];

    if (this.idx >= this.points.length) {
      this._compute();
      return;
    }

    this.phase = 'settle';
    this.armed = false;
    this.note = '';
    this._emit();
  }

  _compute() {
    this.phase = 'fit';
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1;
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 1;

    const results = this.samples.map((s) => {
      const pred = this.model.predict(s.f); // predict 吃特征对象，不是 sample
      if (!pred) {
        return {
          tx: s.tx, ty: s.ty,
          px: null, py: null,
          err: null, errPx: null,
          predX: null, predY: null,
          n: s.n,
        };
      }
      const err = Math.hypot(pred.x - s.tx, pred.y - s.ty);
      // px / py 是像素误差分量（契约单位：px），任务书要求 px = errToPx(err, w, h) 的同一口径
      return {
        tx: s.tx,
        ty: s.ty,
        px: errToPx(Math.abs(pred.x - s.tx), vw, vh),
        py: errToPx(Math.abs(pred.y - s.ty), vw, vh),
        err,
        errPx: errToPx(err, vw, vh),
        predX: pred.x,
        predY: pred.y,
        n: s.n,
      };
    });

    const errs = results.map((r) => r.err).filter((v) => Number.isFinite(v));
    const avg = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null;
    const max = errs.length ? Math.max(...errs) : null;

    const out = {
      results,
      avg,
      max,
      avgPx: avg == null ? null : errToPx(avg, vw, vh),
      maxPx: max == null ? null : errToPx(max, vw, vh),
      frames: this.totalFrames,
      perPoint: results.map((r) => r.n || 0),
      skipped: this.skipped.slice(),
      unit: 'page-norm',
      viewport: { w: vw, h: vh },
    };

    this.result = out;
    this.phase = 'result';
    this._emit();
    if (this.onDone) this.onDone(out);
  }

  _progress() {
    if (this.phase === 'idle') return 0;
    if (this.phase === 'result' || this.phase === 'fit') return 1;
    const now = this._lastNow || 0;
    let local = 0;
    if (this.phase === 'settle' && this.armed && this.t0) {
      local = Math.min(1, (now - this.t0) / (this.settleMs + this.collectMs));
    } else if (this.phase === 'collect' && this.c0) {
      local = (this.settleMs + Math.max(0, now - this.c0)) / (this.settleMs + this.collectMs);
    }
    return Math.max(0, Math.min(1, (this.idx + Math.min(1, local)) / this.points.length));
  }

  _emit() {
    if (!this.onProgress) return;
    this.onProgress(this.state);
  }
}

/**
 * 便捷入口：给定 model 与 5 个 PAGE_NORM 点，跑完一整轮。
 * 适合已经在 rAF 循环里的调用方；如果想手动驱动，用 Validator + update()。
 */
export function validateModel(options) {
  const v = new Validator(options);
  return new Promise((resolve, reject) => {
    if (typeof requestAnimationFrame !== 'function') {
      reject(new Error('validateModel: 需要 requestAnimationFrame，Node 环境请用 Validator + update()'));
      return;
    }
    const orig = v.onDone;
    v.onDone = (r) => {
      if (orig) orig(r);
      resolve(r);
    };
    try {
      v.start();
    } catch (err) {
      reject(err);
      return;
    }
    const step = (now) => {
      if (v.phase === 'result' || v.phase === 'idle') return;
      v.update(now);
      if (v.phase !== 'result') requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

export default Validator;
