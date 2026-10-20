/* 阶段 2 · 距离估计器（DistanceEstimator）
 * 原理：人眼瞳距（IPD）在画面中的像素宽度随距离增大而近似线性减小。
 *   距离(米) = K / IPD_px
 *   - 标定后：K = 参考距离(米) × 参考瞳距(像素)，由一次标定反推，适配具体摄像头。
 *   - 未标定：K ≈ 焦距(像素) × 世界瞳距(mm) / 1000，用默认经验参数给出粗略估计。
 * 采用指数移动平均（EMA）平滑，抑制单帧抖动。
 */

const IRIS_POINTS_PER_EYE = 5; // MediaPipe 每眼虹膜 5 点（中心 + 上下左右）

function irisCentroid(landmarks, start) {
  let x = 0;
  let y = 0;
  for (let i = 0; i < IRIS_POINTS_PER_EYE; i++) {
    x += landmarks[start + i].x;
    y += landmarks[start + i].y;
  }
  return { x: x / IRIS_POINTS_PER_EYE, y: y / IRIS_POINTS_PER_EYE };
}

export class DistanceEstimator {
  constructor(options = {}) {
    this.referenceDistanceMeters = options.referenceDistanceMeters ?? 1.0; // 标定参考距离
    this.defaultWorldIpdMm = options.defaultWorldIpdMm ?? 63;              // 成人平均瞳距
    this.defaultFocalPx = options.defaultFocalPx ?? 700;                   // 未标定经验焦距
    this.smoothing = options.smoothing ?? 0.35;                            // EMA 系数（越大越跟手）
    this._calibrationK = options.calibrationK ?? null;                     // K = 距离(米) × 瞳距(像素)
    this._smoothedMeters = null;
    this._ipdPx = null;
  }

  get calibrated() {
    return this._calibrationK != null;
  }

  get ipdPx() {
    return this._ipdPx;
  }

  // 从归一化 landmarks 提取瞳距（像素）：取两眼虹膜 5 点质心的水平间距
  extractIpdPx(landmarks, imageWidth) {
    if (!landmarks || landmarks.length < 478) return null;
    const left = irisCentroid(landmarks, 468);
    const right = irisCentroid(landmarks, 473);
    const px = Math.abs(left.x - right.x) * imageWidth;
    return px > 0 ? px : null;
  }

  // 标定：给定参考距离（米）与当时的瞳距（像素），反推系数 K
  calibrate(referenceDistanceMeters, ipdPx) {
    if (!ipdPx || ipdPx <= 0) return false;
    this.referenceDistanceMeters = referenceDistanceMeters;
    this._calibrationK = referenceDistanceMeters * ipdPx;
    this._smoothedMeters = null; // 标定后重置平滑
    return true;
  }

  // 由瞳距（像素）估计距离（米）
  estimateFromIpd(ipdPx) {
    if (!ipdPx || ipdPx <= 0) return null;
    if (this._calibrationK) return this._calibrationK / ipdPx;
    return (this.defaultFocalPx * this.defaultWorldIpdMm) / (ipdPx * 1000);
  }

  // 逐帧更新：输入 landmarks 与图像宽度，返回平滑后的距离（米）
  update(landmarks, imageWidth) {
    const ipd = this.extractIpdPx(landmarks, imageWidth);
    if (ipd == null) return null;
    this._ipdPx = ipd;
    const raw = this.estimateFromIpd(ipd);
    if (this._smoothedMeters == null) {
      this._smoothedMeters = raw;
    } else {
      this._smoothedMeters =
        this._smoothedMeters * (1 - this.smoothing) + raw * this.smoothing;
    }
    return this._smoothedMeters;
  }

  reset() {
    this._smoothedMeters = null;
    this._ipdPx = null;
  }
}
