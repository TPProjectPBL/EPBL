/**
 * @file 两点校正 UI。
 *
 * 为什么是两点：`refineWithTwoPoints` 只解 `target ≈ s * gaze + t`（x/y 各自独立缩放+平移），
 * 两组对应点就够。窗口从 1200 宽变到 900 宽，本质就是一次各向异性缩放，用两点能把这类
 * 变化吃掉；而比例变化太大（s 超出 0.85~1.18）说明不是简单的尺寸变化，直接劝重新标定。
 *
 * 采集规则与 9 点标定**完全一致**：复用 `Calibrator` 的 settle → collect → 逐点中位数，
 * 只是点表换成两个（左上/右下）。
 *
 * 用法：
 *   const tp = createTwoPoint({ container, model: raw, getLandmarks, getAspect });
 *   tp.start();
 *   tp.onDone = ({ ok, reason, before, after }) => { ... };
 */

import { Calibrator } from './calibrator.js';
import { createOverlay } from './overlay.js';
import { applyRefine, refineWithTwoPoints } from '../store.js';

/** 左上 / 右下：尽量拉开，避免两点过近导致 sx/sy 估计被噪声放大 */
export const TWO_POINTS = Object.freeze([
  { tx: 0.1, ty: 0.12 },
  { tx: 0.9, ty: 0.88 },
]);

const MSG = Object.freeze({
  intro: '两点校正 · 看向圆点',
  tooFar: '变化太大，请重新标定',
  insufficient: '采样不足，请再试一次',
  noModel: '当前没有可用模型，请先做 9 点标定',
  done: '校正完成',
  cancel: '已取消校正',
});

function pct(v) {
  return `${(Number(v || 0) * 100).toFixed(1)}%`;
}

/**
 * @param {object} opts
 * @param {Element} opts.container       校正点相对它定位
 * @param {object|import('../store.js').GazeCalibModel} opts.model 当前模型（实例或 schema:1 原始对象）
 * @param {(p:object)=>Array|null} opts.getLandmarks 每帧取当前 landmarks
 * @param {()=>number} [opts.getAspect]
 * @param {Storage} [opts.storage]       传了才落盘
 * @param {object} [opts.env]            refine 落盘时补的环境信息
 * @param {boolean} [opts.save=true]     是否保存校正结果
 * @param {(r:object)=>void} [opts.onDone]
 * @param {(s:object)=>void} [opts.onStatus]
 */
export function createTwoPoint(opts = {}) {
  const {
    container,
    model,
    getLandmarks,
    getAspect,
    storage = null,
    env = null,
    save = true,
    onDone = null,
    onStatus = null,
  } = opts;

  if (!container) throw new TypeError('createTwoPoint: 需要 container');
  if (!model) throw new Error(MSG.noModel);

  const overlay = createOverlay({
    container,
    points: TWO_POINTS,
    label: '两点校正',
    onCancel: () => cancel(),
  });

  let cal = null;
  let running = false;
  let result = null;

  const api = {
    onDone,
    onStatus,
    get running() {
      return running;
    },
    get result() {
      return result;
    },
    start,
    cancel,
  };

  function emit(status) {
    if (onStatus) {
      try {
        onStatus(status);
      } catch (e) {
        console.warn('[two-point] onStatus 抛错', e);
      }
    }
  }

  function start() {
    if (running) return api;
    running = true;
    result = null;
    cal = new Calibrator({
      container,
      points: TWO_POINTS,
      getLandmarks,
      getAspect,
      onProgress: (s) => {
        overlay.update(s);
        emit({ phase: s.phase, idx: s.idx, total: s.total, progress: s.progress });
      },
      onDone: (out) => finish(out),
    });
    overlay.mount();
    overlay.update({ phase: 'settle', idx: 0, total: TWO_POINTS.length, progress: 0, note: MSG.intro });
    cal.start();
    emit({ phase: 'settle', idx: 0, total: TWO_POINTS.length, progress: 0 });
    return api;
  }

  function cancel() {
    if (!running) return api;
    running = false;
    if (cal) cal.cancel();
    overlay.destroy();
    emit({ phase: 'cancelled', note: MSG.cancel });
    result = { ok: false, reason: 'cancelled' };
    if (onDone) onDone(result);
    return api;
  }

  function finish(out) {
    const samples = (out && out.samples) || [];
    if (samples.length < TWO_POINTS.length) {
      running = false;
      overlay.showResult({ ok: false, title: MSG.insufficient });
      result = { ok: false, reason: 'insufficient' };
      emit({ phase: 'failed', reason: 'insufficient' });
      if (onDone) onDone(result);
      return result;
    }
    const g = samples.map((s) => {
      let p = null;
      try {
        p = model.predict ? model.predict(s.f) : null;
      } catch {
        p = null;
      }
      return p;
    });
    if (!g[0] || !g[1]) {
      running = false;
      overlay.showResult({ ok: false, title: MSG.noModel });
      result = { ok: false, reason: 'invalid' };
      emit({ phase: 'failed', reason: 'invalid' });
      if (onDone) onDone(result);
      return result;
    }

    const pts = {
      p1: { gaze: { x: g[0].x, y: g[0].y }, target: { x: samples[0].tx, y: samples[0].ty } },
      p2: { gaze: { x: g[1].x, y: g[1].y }, target: { x: samples[1].tx, y: samples[1].ty } },
    };

    const r = save && storage ? applyRefine(model, pts, { storage, env }) : refineWithTwoPoints(model, pts, { env });

    running = false;
    if (!r || !r.ok) {
      const tooFar = r && r.reason === 'out-of-range';
      overlay.showResult({
        ok: false,
        title: tooFar ? MSG.tooFar : '校正失败，请重新标定',
        detail: tooFar && r.s ? `缩放 ${r.s.x.toFixed(2)} / ${r.s.y.toFixed(2)}，超出允许范围` : '',
      });
      result = { ok: false, reason: (r && r.reason) || 'invalid', s: r && r.s };
      emit({ phase: 'failed', reason: result.reason });
      if (onDone) onDone(result);
      return result;
    }

    overlay.showResult({
      ok: true,
      title: MSG.done,
      detail: r.before && r.after ? `${pct(r.before.avgErr)} → ${pct(r.after.avgErr)}` : '',
    });
    result = {
      ok: true,
      model: r.model,
      raw: r.raw,
      s: r.s,
      t: r.t,
      before: r.before,
      after: r.after,
      saved: !!r.saved,
      samples,
    };
    emit({ phase: 'result', ...result, model: undefined, raw: undefined });
    if (onDone) onDone(result);
    return result;
  }

  return api;
}

export default createTwoPoint;
