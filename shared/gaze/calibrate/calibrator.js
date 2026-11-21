/**
 * @file 可复用的 9 点标定状态机（不依赖任何页面 CSS / DOM 结构）。
 *
 * 只做：状态推进、采样窗口、逐点中位数、拟合、结果汇总。
 * 不画 UI（见 overlay.js），不碰摄像头（landmarks 由调用方每帧喂进来）。
 *
 * 状态：idle → settle → collect → next → fit → result
 *   settle  等眼球转到位（期间不采样；未检测到可用人脸时不计时）
 *   collect 采样窗口，收集 {lm, ts}
 *   next    结算当前点（有效帧 < minFrames 记为 skipped，不中断）
 *   fit     调 GazeCalibModel.fit
 *   result  onDone 交付
 *
 * 坐标：points 默认是「相对 container 的归一化坐标」（0..1）；
 * 采样前会换算成 PAGE_NORM（页面归一化），因为模型的训练目标就是 PAGE_NORM。
 */
import { CALIB } from '../contract.js';
import { GazeCalibModel, median, medianSample, isFaceUsable } from '../core/index.js';
import { headPose } from '../head.js';

const DEFAULT_MAX_FRAMES = 90;

/** 4 角扩展点（相对 container，留 6% 边距避免圆点贴边） */
export const CORNER_POINTS = Object.freeze([
  { tx: 0.06, ty: 0.06 },
  { tx: 0.94, ty: 0.06 },
  { tx: 0.06, ty: 0.94 },
  { tx: 0.94, ty: 0.94 },
]);

function normalizePoints(points, extendCorners) {
  const base = points
    ? points.map((p) =>
        Array.isArray(p) ? { tx: Number(p[0]), ty: Number(p[1]) } : { tx: Number(p.tx), ty: Number(p.ty) }
      )
    : CALIB.rows.flatMap((ty) => CALIB.cols.map((tx) => ({ tx, ty })));
  // 13 点（9 + 4 角）是可选项，默认关闭；测试台做对照时才打开
  return extendCorners ? base.concat(CORNER_POINTS.map((p) => ({ ...p }))) : base;
}

function plainRect(r) {
  return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
}

/** 头位样本的逐字段中位数；样本为空返回 null。 */
function medianHead(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const keys = ['cx', 'cy', 'faceH', 'roll', 'yaw', 'pitch'];
  const out = {};
  for (const k of keys) {
    const v = median(list.map((h) => h[k]).filter((x) => Number.isFinite(x)));
    // 缺一项就整体放弃：宁可不设基准，也不能让坏基准把保存卡住
    if (!Number.isFinite(v)) return null;
    out[k] = v;
  }
  return out;
}

export class Calibrator {
  /**
   * @param {object} options
   * @param {Element} options.container 目标容器（点相对它生成）
   * @param {Array<{tx:number,ty:number}>|Array<[number,number]>} [options.points] 默认取 CALIB.cols × CALIB.rows
   * @param {number} [options.settleMs]
   * @param {number} [options.collectMs]
   * @param {number} [options.minFrames]
   * @param {(s:object)=>void} [options.onProgress]
   * @param {(r:object)=>void} [options.onDone]
   * @param {(p:{index:number,tx:number,ty:number,page:{x:number,y:number}})=>Array|null} [options.getLandmarks] 每帧取当前 478 点
   * @param {()=>number} [options.getAspect] 视频宽高比（默认 4/3）
   * @param {number} [options.aspect] 固定宽高比（getAspect 缺省时使用）
   * @param {number} [options.maxFrames] 单点最多保留帧数（默认 90）
   * @param {boolean} [options.extendCorners] 是否在 9 点后追加 4 角（13 点模式，默认关）
   * @param {boolean} [options.requireClick] 每点先用鼠标点亮/点击确认再采集（默认关）
   */
  constructor(options = {}) {
    const {
      container,
      points,
      settleMs = CALIB.settleMs,
      collectMs = CALIB.collectMs,
      minFrames = CALIB.minFrames,
      onProgress,
      onDone,
      getLandmarks,
      getAspect,
      aspect = 4 / 3,
      maxFrames = DEFAULT_MAX_FRAMES,
      extendCorners = false,
      requireClick = false,
    } = options;

    if (!container || typeof container.getBoundingClientRect !== 'function') {
      throw new TypeError('Calibrator: container 必须提供 getBoundingClientRect()');
    }

    this.container = container;
    this.doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
    this.win = (this.doc && this.doc.defaultView) || (typeof window !== 'undefined' ? window : null);

    this.points = normalizePoints(points, extendCorners);
    this.extendCorners = !!extendCorners;
    this.requireClick = !!requireClick;
    this.settleMs = settleMs;
    this.collectMs = collectMs;
    this.minFrames = minFrames;
    this.maxFrames = maxFrames;
    this.onProgress = onProgress || null;
    this.onDone = onDone || null;
    this.getLandmarks = getLandmarks || null;
    this.getAspect = getAspect || null;
    this.fixedAspect = aspect;

    this.phase = 'idle';
    this.idx = 0;
    this.samples = [];
    this.skipped = [];
    this.frames = [];
    this.heads = [];
    this.rect = null;
    this.armed = false;
    this.t0 = 0;
    this.c0 = 0;
    this.note = '';
    this.result = null;
    this.started = false;
  }

  get total() {
    return this.points.length;
  }

  /** 当前状态快照（给 UI 用） */
  get state() {
    return {
      phase: this.phase,
      idx: this.idx,
      total: this.total,
      progress: this._localProgress(),
      pointProgress: this._pointLocal(),
      note: this.note,
      waiting: this.phase === 'wait-click',
      samples: this.samples.length,
      skipped: this.skipped.length,
      point: this.points[this.idx] || null,
    };
  }

  start() {
    this.rect = this.container.getBoundingClientRect();
    this.phase = this.requireClick ? 'wait-click' : 'settle';
    this.idx = 0;
    this.samples = [];
    this.skipped = [];
    this.frames = [];
    this.heads = [];
    this.armed = false;
    this.t0 = 0;
    this.c0 = 0;
    this.note = '';
    this.result = null;
    this.started = true;
    this._emit();
    return this.state;
  }

  /** 每帧调用一次。lm 可显式传入，否则用 getLandmarks 取。 */
  update(now, lm) {
    this._lastNow = now;
    if (!this.started || this.phase === 'idle' || this.phase === 'result' || this.phase === 'fit') {
      return this.state;
    }

    const p = this.points[this.idx];
    if (!p) return this.state;

    const page = this.pageOf(p);
    const current =
      lm !== undefined
        ? lm
        : this.getLandmarks
          ? this.getLandmarks({ index: this.idx, tx: p.tx, ty: p.ty, page })
          : null;
    const usable = isFaceUsable(current);

    // 鼠标辅助：等用户点一下靶点（表示「我正在看这里」），再开始 settle/collect
    if (this.phase === 'wait-click') {
      this.note = usable ? 'click-point' : 'waiting-face';
      this._emit();
      return this.state;
    }

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
      const elapsed = now - this.t0;
      if (elapsed >= this.settleMs) {
        this.phase = 'collect';
        this.c0 = now;
        this.frames = [];
      }
      this._emit();
      return this.state;
    }

    if (this.phase === 'collect') {
      // 采样期间丢帧就跳过该帧，但计时继续（与现有流程一致）
      if (usable) {
        this.frames.push({ lm: current, tx: page.x, ty: page.y, ts: now });
        if (this.frames.length > this.maxFrames) this.frames.shift();
      }
      const elapsed = now - this.c0;
      if (elapsed >= this.collectMs) {
        this._finishPoint();
        return this.state;
      }
      this._emit();
      return this.state;
    }

    return this.state;
  }

  /** 鼠标辅助模式下确认当前靶点，进入采样。 */
  confirm() {
    if (this.phase !== 'wait-click') return false;
    this.phase = 'settle';
    this.armed = false;
    this.t0 = 0;
    this.note = '';
    this._emit();
    return true;
  }

  /** 主动取消：清空采样并回到 idle。 */
  cancel() {
    this.started = false;
    this.phase = 'idle';
    this.frames = [];
    this.note = '';
    return this.state;
  }

  /** container 内归一化坐标 → PAGE_NORM（相对于容器所在文档的视口）。 */
  pageOf(p) {
    const r = this.rect || this.container.getBoundingClientRect();
    const vw = (this.win && this.win.innerWidth) || 1;
    const vh = (this.win && this.win.innerHeight) || 1;
    return {
      x: (r.left + p.tx * r.width) / vw,
      y: (r.top + p.ty * r.height) / vh,
    };
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
      if (s) {
        this.samples.push(s);
        // 逐点记录头位，最后取中位数作为标定基准
        const heads = this.frames
          .map((fr) => headPose(fr.lm, { aspect: this.aspect() }))
          .filter((h) => h && Number.isFinite(h.cx) && Number.isFinite(h.faceH));
        if (heads.length) this.heads.push(...heads);
      }
      else
        this.skipped.push({
          index: this.idx,
          tx: p.tx,
          ty: p.ty,
          reason: 'invalid-sample',
          frames: this.frames.length,
        });
    } else {
      this.skipped.push({
        index: this.idx,
        tx: p.tx,
        ty: p.ty,
        reason: 'insufficient-frames',
        frames: this.frames.length,
      });
    }

    this.idx += 1;
    this.frames = [];

    if (this.idx >= this.points.length) {
      this._fit();
      return;
    }

    this.phase = this.requireClick ? 'wait-click' : 'settle';
    this.armed = false;
    this.note = '';
    this._emit();
  }

  _fit() {
    this.phase = 'fit';
    let model;
    try {
      model = GazeCalibModel.fit(this.samples, { aspect: this.aspect() });
    } catch (e) {
      // 拟合失败必须落回可恢复状态，否则现场会永远停在最后一个点
      this.note = `fit-failed: ${(e && e.message) || e}`;
      this.phase = 'idle';
      this.frames = [];
      this._emit();
      if (this.onError) this.onError(e);
      return;
    }

    const win = this.win;
    const viewport = {
      w: (win && win.innerWidth) || 1,
      h: (win && win.innerHeight) || 1,
    };
    const headRef = medianHead(this.heads);
    if (model) model.headRef = headRef;
    const out = {
      model,
      headRef,
      samples: this.samples.slice(),
      diag: (model && model.diag) || null,
      skipped: this.skipped.slice(),
      containerRect: this.rect ? plainRect(this.rect) : null,
      viewport,
      dpr: (win && win.devicePixelRatio) || 1,
    };

    this.result = out;
    this.phase = 'result';
    this._emit();

    if (this.onDone) this.onDone(out);
  }

  _pointLocal() {
    if (this.phase === 'idle') return 0;
    if (this.phase === 'result' || this.phase === 'fit') return 1;
    const now = Number.isFinite(this._lastNow) ? this._lastNow : this._now();
    if (this.phase === 'settle' && this.armed && this.t0) {
      return Math.max(0, Math.min(1, (now - this.t0) / (this.settleMs + this.collectMs)));
    }
    if (this.phase === 'collect' && this.c0) {
      return Math.max(0, Math.min(1, (this.settleMs + Math.max(0, now - this.c0)) / (this.settleMs + this.collectMs)));
    }
    return 0;
  }

  _localProgress() {
    if (this.phase === 'idle') return 0;
    if (this.phase === 'result' || this.phase === 'fit') return 1;
    if (!this.points[this.idx]) return 1;
    return Math.max(0, Math.min(1, (this.idx + this._pointLocal()) / this.points.length));
  }

  _now() {
    if (this.win && this.win.performance && this.win.performance.now) return this.win.performance.now();
    return Date.now();
  }

  _emit() {
    if (!this.onProgress) return;
    this.onProgress({
      phase: this.phase,
      idx: this.idx,
      total: this.total,
      progress: this._localProgress(),
      pointProgress: this._pointLocal(),
      note: this.note,
      waiting: this.phase === 'wait-click',
      samples: this.samples.length,
      skipped: this.skipped.length,
      point: this.points[this.idx] || null,
    });
  }
}

export default Calibrator;
