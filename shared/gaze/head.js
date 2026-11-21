/**
 * @file 头部姿态度量与门控（共享件）。
 *
 * 从 478 点 FaceLandmarker 输出计算：
 *   - 人脸框（faceW / faceH，归一化）
 *   - 中心（cx / cy，归一化）
 *   - roll / yaw / pitch（度）
 *   - EAR 与眨眼
 *
 * 计算口径与热力图旧实现（`readHead()`）保持一致，便于沿用同一套阈值：
 *   roll  = 两眼外角连线与水平线夹角
 *   yaw   = 鼻尖相对眼中心水平偏移 / 眼距
 *   pitch = 鼻尖相对眼中心垂直偏移 / 眼距
 *
 * 分工原则：
 *   - 度量与阈值放这里（共享）
 *   - 参考基准（标定时的头位）随模型存储（`model.headRef`）
 *   - 用不用门控、多严，由各页面自己决定
 */

import { HEAD } from './contract.js';

/** 关键点索引（FaceMesh / FaceLandmarker 通用拓扑）。 */
export const FACE_PTS = Object.freeze({
  leftEyeOuter: 33,
  rightEyeOuter: 263,
  noseTip: 1,
  chin: 152,
});

const EAR_L = Object.freeze([33, 160, 158, 133, 153, 144]);
const EAR_R = Object.freeze([362, 385, 387, 263, 373, 380]);

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function earOf(lm, idxs) {
  const p = idxs.map((i) => lm[i]);
  if (p.some((v) => !v)) return NaN;
  const horiz = dist(p[0], p[3]);
  if (!(horiz > 1e-6)) return NaN;
  return (dist(p[1], p[5]) + dist(p[2], p[4])) / (2 * horiz);
}

/**
 * 计算头部姿态与几何度量。
 *
 * @param {Array<{x:number,y:number,z?:number}>} lm 478 个归一化关键点
 * @param {{aspect?: number, limits?: object}} [opts]
 *   aspect 为取流宽高比（默认 4/3），用于缩放归一化距离阈值；
 *   传入 16/9 时距离上限同步放大，避免把正常距离误判成「太近」
 * @returns {{
 *   ok: boolean, faceW: number, faceH: number, cx: number, cy: number,
 *   roll: number, yaw: number, pitch: number,
 *   ear: number, blink: boolean,
 *   distanceOk: boolean, centerOk: boolean, poseOk: boolean
 * } | null}
 */
export function headPose(lm, opts = {}) {
  if (!Array.isArray(lm) || lm.length < 468) return null;
  const L = opts.limits || HEAD;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < lm.length; i += 1) {
    const p = lm[i];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;

  const faceW = maxX - minX;
  const faceH = maxY - minY;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const left = lm[FACE_PTS.leftEyeOuter];
  const right = lm[FACE_PTS.rightEyeOuter];
  const nose = lm[FACE_PTS.noseTip];
  const chin = lm[FACE_PTS.chin];

  let roll = NaN;
  let yaw = NaN;
  let pitch = NaN;
  if (left && right && nose) {
    const eyeSpan = Math.max(0.035, dist(left, right));
    const midX = (left.x + right.x) / 2;
    const midY = (left.y + right.y) / 2;
    // 统一标定协议会对所有 x 做 1 - x；镜像后两眼 x 顺序反转，
    // atan2 会跳到 ±180°。这里用 |dx| 保持 roll 在 (-90, 90)，镜像前后同值。
    const dxEye = right.x - left.x;
    roll = (Math.atan2(right.y - left.y, Math.max(Math.abs(dxEye), 1e-6)) * 180) / Math.PI;
    yaw = (Math.atan2(nose.x - midX, eyeSpan) * 180) / Math.PI;
    pitch = (Math.atan2((nose.y - midY) / eyeSpan, 1) * 180) / Math.PI;
  }

  /**
   * 俯仰的稳健指标：眼→鼻 与 鼻→下巴 的垂直距离比。
   *
   * 原来的 pitch 用的是「鼻尖相对眼中心」的角度，但这两个点几乎在同一张刚体上，
   * 2D 投影里低头/仰头时变化极小，实测只有 1~2°，所以全都显示「平视」。
   * 换成两段垂直距离的占比后方向是明确的（按 3D 头部投影验算）：
   *   仰头 → 下巴向相机靠近、投影里「鼻→下巴」被拉长 → 比值变小
   *   低头 → 下巴后退 → 比值变大
   * 实测 10° 约变化 0.04，比原来 1~2° 的 pitch 角度灵敏得多，且不受脸大小影响。
   *
   * 绝对值因人而异，调用方应结合自己的中性基准使用（工作台就位引导会在线学习）。
   */
  let pitchRatio = NaN;
  if (left && right && nose && chin) {
    const eyeMidY = (left.y + right.y) / 2;
    const up = nose.y - eyeMidY;
    const down = chin.y - nose.y;
    const span = up + down;
    if (span > 1e-4 && up > 0 && down > 0) pitchRatio = up / span;
  }

  const earL = earOf(lm, EAR_L);
  const earR = earOf(lm, EAR_R);
  const ear = Number.isFinite(earL) && Number.isFinite(earR) ? (earL + earR) / 2 : NaN;
  const blink = Number.isFinite(ear) && ear > 0 && ear < L.blinkEar;

  // 距离阈值随取流宽高比缩放：坐标系是归一化的，16:9 下同样距离的人脸
  // 在画面高度里占的比例约为 4:3 的 4/3 倍，不缩放会把正常距离误判成「太近」。
  const rawAspect = Number(opts.aspect);
  const aspect = Number.isFinite(rawAspect) && rawAspect > 0.1 ? rawAspect : 4 / 3;
  const distScale = aspect / (4 / 3);
  const distMin = L.distMin * distScale;
  const distMax = L.distMax * distScale;
  const distanceOk = faceH >= distMin && faceH <= distMax;
  const centerOk = Math.abs(cx - 0.5) <= L.centerX && Math.abs(cy - 0.5) <= L.centerY;
  const poseOk =
    Number.isFinite(roll) &&
    Math.abs(roll) <= L.rollMax &&
    Math.abs(yaw) <= L.yawMax &&
    pitch >= L.pitchMin &&
    pitch <= L.pitchMax;

  return {
    ok: distanceOk && centerOk && poseOk && !blink,
    faceW,
    faceH,
    distMin,
    distMax,
    cx,
    cy,
    roll,
    yaw,
    pitch,
    pitchRatio,
    ear,
    earL,
    earR,
    blink,
    distanceOk,
    centerOk,
    poseOk,
  };
}

/**
 * 生成参考基准（标定期间的典型头位）。
 * @param {object} head headPose 的返回值
 * @returns {{cx:number,cy:number,faceH:number,roll:number,yaw:number,pitch:number}|null}
 */
export function toHeadRef(head) {
  if (!head || !Number.isFinite(head.cx)) return null;
  return {
    cx: head.cx,
    cy: head.cy,
    faceW: head.faceW,
    faceH: head.faceH,
    roll: head.roll,
    yaw: head.yaw,
    pitch: head.pitch,
  };
}

/**
 * 相对参考基准的偏差。
 * @param {object|null} ref 标定时的基准（`model.headRef`）
 * @param {object} head headPose 的返回值
 * @param {object} [limits]
 * @returns {{dx:number,dy:number,dh:number,dRoll:number,dYaw:number,dPitch:number,refOk:boolean}}
 *   ref 为空时 refOk 恒为 true（没有基准就不拦）
 */
export function headDelta(ref, head, limits = HEAD) {
  if (!ref || !head) {
    return { dx: 0, dy: 0, dh: 0, dRoll: 0, dYaw: 0, dPitch: 0, refOk: true };
  }
  const dx = head.cx - ref.cx;
  const dy = head.cy - ref.cy;
  const dh = head.faceH - ref.faceH;
  const dRoll = head.roll - ref.roll;
  const dYaw = head.yaw - ref.yaw;
  const dPitch = head.pitch - ref.pitch;
  const refOk =
    Math.abs(dx) <= limits.refDx &&
    Math.abs(dy) <= limits.refDy &&
    Math.abs(dh) <= limits.refDh &&
    Math.abs(dRoll) <= limits.refRoll &&
    Math.abs(dYaw) <= limits.refYaw &&
    Math.abs(dPitch) <= limits.refPitch;
  return { dx, dy, dh, dRoll, dYaw, dPitch, refOk };
}

/**
 * 组合判定：硬门控 + 基准门控。
 * @param {object} head
 * @param {object|null} ref
 * @param {object} [limits]
 * @returns {{head:object, delta:object, ok:boolean, strictOk:boolean}}
 *   ok = 硬门控通过；strictOk = 硬门控 + 基准对齐（热力图口径）
 */
export function headGate(head, ref, limits = HEAD) {
  if (!head) return { head: null, delta: null, ok: false, strictOk: false };
  const delta = headDelta(ref, head, limits);
  return { head, delta, ok: head.ok, strictOk: head.ok && delta.refOk };
}
