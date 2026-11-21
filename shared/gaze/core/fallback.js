/**
 * @file 光标来源：代理实现（虹膜相对偏移）与带模型时的绝对注视。
 *
 * `GazeCursorSource` 从 `eye-page-turner/demo/air-draw/lib/gaze-source.js` 迁移，
 * 去掉对 air-draw 目录的 import（clamp 就地定义，数值与 smoothing.js 一致）。
 * `AbsoluteGazeSource` 从 `gaze-calib.js` 原样迁移。
 */
import { extractFeatures } from './features.js';
import { mirrorLandmarks } from './mirror.js';

/** 与 air-draw/lib/smoothing.js 的 clamp 完全一致 */
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const IDX = {
  leftIris: 468, // refineLandmarks=true 时，468 即左虹膜中心
  rightIris: 473, // 473 即右虹膜中心
  leftEyeOuter: 33,
  leftEyeInner: 133,
  leftEyeTop: 159,
  leftEyeBottom: 145,
  rightEyeOuter: 263,
  rightEyeInner: 362,
  rightEyeTop: 386,
  rightEyeBottom: 374,
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** 取眼睛张开度（近似 EAR），用于给出置信度 */
function eyeOpenness(lm, top, bottom, inner, outer) {
  const v = dist(lm[top], lm[bottom]);
  const h = dist(lm[inner], lm[outer]) || 1e-6;
  return v / h;
}

/** 虹膜在眼眶包围盒内的相对位置，返回 0..1（用 min/max 抵消左右眼顺序差异） */
function irisRatio(lm, iris, a, b) {
  const lo = Math.min(lm[a].x, lm[b].x);
  const hi = Math.max(lm[a].x, lm[b].x);
  return (lm[iris].x - lo) / Math.max(1e-6, hi - lo);
}

function irisRatioY(lm, iris, top, bottom) {
  const lo = Math.min(lm[top].y, lm[bottom].y);
  const hi = Math.max(lm[top].y, lm[bottom].y);
  return (lm[iris].y - lo) / Math.max(1e-6, hi - lo);
}

export class GazeCursorSource {
  constructor({ gain = 2.0, margin = 0.04 } = {}) {
    this.gain = gain;
    this.margin = margin;
  }

  reset() {}

  /**
   * @param {object|null} faceResults MediaPipe FaceMesh 结果
   * @returns {{x:number,y:number,conf:number}|null}
   */
  getPoint(faceResults) {
    const faces = faceResults && faceResults.multiFaceLandmarks;
    if (!faces || !faces.length) return null;
    const lm = faces[0];
    if (!lm || lm.length < 478) return null; // 无虹膜点（refineLandmarks 未开启）

    const rawX =
      (irisRatio(lm, IDX.leftIris, IDX.leftEyeOuter, IDX.leftEyeInner) +
        irisRatio(lm, IDX.rightIris, IDX.rightEyeOuter, IDX.rightEyeInner)) /
      2;
    const rawY =
      (irisRatioY(lm, IDX.leftIris, IDX.leftEyeTop, IDX.leftEyeBottom) +
        irisRatioY(lm, IDX.rightIris, IDX.rightEyeTop, IDX.rightEyeBottom)) /
      2;

    // 镜像：图像 x 与镜像后的屏幕 x 相反
    const mx = 1 - rawX;

    // 以 0.5 为基准做增益放大（虹膜偏移量很小，不放大则光标只能在中间一小块活动）
    const x = clamp(0.5 + (mx - 0.5) * this.gain, this.margin, 1 - this.margin);
    const y = clamp(0.5 + (rawY - 0.5) * this.gain, this.margin, 1 - this.margin);

    const openL = eyeOpenness(lm, IDX.leftEyeTop, IDX.leftEyeBottom, IDX.leftEyeInner, IDX.leftEyeOuter);
    const openR = eyeOpenness(lm, IDX.rightEyeTop, IDX.rightEyeBottom, IDX.rightEyeInner, IDX.rightEyeOuter);
    const openness = (openL + openR) / 2;
    // 睁眼正常时 openness 约 0.22~0.35；闭眼/眯眼时明显变小
    const conf = clamp((openness - 0.12) / 0.14, 0, 1);

    return { x, y, conf };
  }
}

/* ---------------------------------------------------------------- 光标来源 */

/**
 * 精确注视光标来源：有可用模型时输出「绝对屏幕坐标」，否则退回代理实现（虹膜相对偏移）。
 * 与 GazeCursorSource 接口一致，可直接替换进 app.js。
 */
export class AbsoluteGazeSource {
  constructor({ model = null, gain = 2.0, margin = 0.04, aspect = 4 / 3 } = {}) {
    this.fallback = new GazeCursorSource({ gain, margin });
    this.aspect = aspect;
    this.model = model && model.ok ? model : null;
  }

  setModel(model) {
    this.model = model && model.ok ? model : null;
  }

  get active() {
    return !!(this.model && this.model.ok);
  }

  reset() {
    if (this.fallback && this.fallback.reset) this.fallback.reset();
  }

  getPoint(faceResults) {
    const faces = faceResults && faceResults.multiFaceLandmarks;
    if (!faces || !faces.length) return null;
    const lm = faces[0];
    if (!lm || lm.length < 478) return null;

    // 特征每帧都算一次并缓存：即使当前是 fallback（还没有模型），点击采样也要能取到
    // 「与预测同一条提取路径」的特征——同分布是点击即训练有效的隐含前提。
    const asp = (this.model && this.model.aspect) || this.aspect;
    // 统一标定协议：特征空间是镜像后的坐标，预测必须同一条路径
    const f = extractFeatures(mirrorLandmarks(lm), asp);
    this._lastFeatures = f || null;
    this._lastFeaturesAt = f ? Date.now() : 0;

    if (this.model && f) {
      const p = this.model.predict(f);
      if (p) return p;
    }
    return this.fallback.getPoint(faceResults);
  }

  /** 最近一帧的特征向量（点击即训练采样用）；无有效人脸时为 null */
  get lastFeatures() {
    return this._lastFeatures || null;
  }

  /** 最近一帧特征的采集时刻（Date.now 基准，0=还没有）。调用方据此判断特征是否新鲜 */
  get lastFeaturesAt() {
    return this._lastFeaturesAt || 0;
  }
}
