/**
 * M12 · 手部状态识别（握拳 / 张开 二分类 + 滞回防抖）
 *
 * 对应《开工方案》9.1：落笔 = 握拳，抬笔 = 张开手掌，「手部状态二分类 + 滞回防抖」。
 * 纯函数 + 轻量状态机，不依赖 MediaPipe，可直接单测。
 *
 * 判定思路（不依赖任何模型，只用 21 关键点几何）：
 *   1. 伸直手指数 —— 指尖到手腕的距离是否明显大于 PIP 到手腕的距离；
 *   2. 张开度 —— 拇指尖到小指尖的距离 / 掌宽（用中指 MCP 归一化，抵消远近尺度）；
 *   3. 中间地带一律判为 UNKNOWN（这就是「滞回带」），状态机保持原状态不切换。
 */

export const HandState = Object.freeze({
  FIST: 'fist',
  OPEN: 'open',
  UNKNOWN: 'unknown',
});

/** 四指链条：[指尖, 近节指骨(PIP)]，拇指不参与（不同人拇指姿态差异太大） */
const FINGER_CHAINS = [
  [8, 6, 5],
  [12, 10, 9],
  [16, 14, 13],
  [20, 18, 17],
];

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** 单指是否伸直：指尖相对 PIP 更远离手腕。1.12 系数用于抑制噪声抖动 */
function fingerExtended(lm, tip, pip) {
  const wrist = lm[0];
  return dist(lm[tip], wrist) > dist(lm[pip], wrist) * 1.12;
}

/**
 * 单帧分类。
 * @param {Array<{x:number,y:number}>} landmarks 21 点手部关键点
 * @returns {{state:string, extended:number, spread:number, palm:number}}
 */
export function classifyHand(landmarks) {
  if (!landmarks || landmarks.length < 21) {
    return { state: HandState.UNKNOWN, extended: 0, spread: 0, palm: 0 };
  }
  const palm = dist(landmarks[0], landmarks[9]) || 1e-6;
  let extended = 0;
  for (const [tip, pip] of FINGER_CHAINS) {
    if (fingerExtended(landmarks, tip, pip)) extended += 1;
  }
  const spread = dist(landmarks[4], landmarks[20]) / palm;

  let state = HandState.UNKNOWN;
  if (extended <= 1 && spread < 1.55) state = HandState.FIST;
  else if (extended >= 3 && spread > 1.7) state = HandState.OPEN;

  return { state, extended, spread, palm };
}

/** 手部包围盒（归一化坐标），用于「手遮挡面部」检测 */
export function handBBox(landmarks) {
  if (!landmarks || !landmarks.length) return null;
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of landmarks) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

export function bboxOverlap(a, b) {
  if (!a || !b) return 0;
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy;
  const small = Math.min(a.w * a.h, b.w * b.h) || 1e-6;
  return inter / small;
}

/**
 * 状态机：把逐帧分类结果转成稳定的「落笔 / 抬笔」。
 *
 * - 需要连续 holdFrames 帧相同才会切换状态（防抖）
 * - UNKNOWN 一律不切换（滞回带）
 * - 间隔 cooldownMs 内不重复切换（防抖动连击）
 * - 手离开画面超过 lostTimeoutMs 强制抬笔（安全兜底，否则线条会乱飞）
 */
export class HandStateMachine {
  constructor({ holdFrames = 3, cooldownMs = 160, lostTimeoutMs = 400 } = {}) {
    this.holdFrames = holdFrames;
    this.cooldownMs = cooldownMs;
    this.lostTimeoutMs = lostTimeoutMs;
    this.reset();
  }

  reset() {
    this.state = HandState.UNKNOWN;
    this.penDown = false;
    this._candidate = null;
    this._votes = 0;
    this._lastSwitch = -Infinity; // 允许首帧即刻落笔，避免开场 160ms 空档
    this._lastSeen = 0;
    this.lost = false;
    this.lastExt = 0;
    this.lastSpread = 0;
  }

  /**
   * @param {{state:string, extended:number, spread:number}} cls 单帧分类结果
   * @param {number} now performance.now()
   * @returns {{penDown:boolean, state:string, changed:boolean, lost:boolean}}
   */
  update(cls, now) {
    const visible = cls && cls.state !== HandState.UNKNOWN;
    if (visible) {
      this._lastSeen = now;
      this.lost = false;
      this.lastExt = cls.extended;
      this.lastSpread = cls.spread;
    } else if (this._lastSeen && now - this._lastSeen > this.lostTimeoutMs) {
      this.lost = true;
    }

    // 手离开画面：强制抬笔
    if (this.lost) {
      const changed = this.state !== HandState.UNKNOWN;
      this.state = HandState.UNKNOWN;
      this._candidate = null;
      this._votes = 0;
      this.penDown = false;
      return { penDown: false, state: this.state, changed, lost: true };
    }

    let changed = false;
    if (visible) {
      if (cls.state === this._candidate) {
        this._votes += 1;
      } else {
        this._candidate = cls.state;
        this._votes = 1;
      }
      if (
        this._votes >= this.holdFrames &&
        cls.state !== this.state &&
        now - this._lastSwitch >= this.cooldownMs
      ) {
        this.state = cls.state;
        this._lastSwitch = now;
        this.penDown = cls.state === HandState.FIST;
        changed = true;
      }
    }

    return { penDown: this.penDown, state: this.state, changed, lost: this.lost };
  }
}
