/**
 * 光标来源（笔尖位置）抽象。
 *
 * ⚠ 重要说明 —— 关于「眼动控制画笔方向」：
 *   设计报告的阶段 3（眼神方向估计 · GazeEstimator）**尚未交付**，
 *   因此本文件里的 GazeCursorSource 是「代理实现（proxy）」：
 *   仅用虹膜在眼眶内的相对偏移做一次粗略映射，用于把 UI 与交互链路先跑通。
 *   它的精度**不足以**直接当产品级视线估计使用。
 *
 *   阶段 3 交付后，只需替换 GazeCursorSource.getPoint() 的内部实现，
 *   外部接口（getPoint / reset）保持不变，app.js 无需改动。
 *
 * 坐标约定：返回 { x, y } ∈ [0,1]，且已完成「镜像」，与镜像显示的预览一致：
 *   用户看向自己左侧 → x 变小（屏幕左侧）。
 */

import { clamp } from './smoothing.js';

/** Face Mesh 索引 */
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

export class HandCursorSource {
  constructor({ gain = 1.9, margin = 0.03 } = {}) {
    this.gain = gain;
    this.margin = margin;
  }

  reset() {}

  /**
   * 用食指指尖作为笔尖（最符合"用手指画画"的直觉）
   * @param {Array} landmarks 21 点
   */
  getPoint(landmarks) {
    if (!landmarks || landmarks.length < 21) return null;
    const tip = landmarks[8];
    const mx = 1 - tip.x;
    return {
      x: clamp(0.5 + (mx - 0.5) * this.gain, this.margin, 1 - this.margin),
      y: clamp(0.5 + (tip.y - 0.5) * this.gain, this.margin, 1 - this.margin),
      conf: 0.95,
    };
  }
}
