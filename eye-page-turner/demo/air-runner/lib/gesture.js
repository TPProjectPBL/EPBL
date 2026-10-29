/**
 * 手势输入原语（跑酷版）
 *
 * 与画画 demo 的区别：画画需要「持续握拳 = 落笔」，跑酷需要「一瞬间的动作 = 指令」，
 * 所以这里新增了**挥动检测（SwipeDetector）**：
 *   - 向上挥手 → 跳跃
 *   - 向下挥手 → 滑铲
 *   - 向左/向右挥手 → 变道（纯手势模式下用）
 *   - 握拳 → 护盾（复用 M12 的 HandStateMachine，握拳态 = 按住护盾）
 *
 * 挥动检测的四条抗误触设计：
 *   1. 用「掌宽」归一化位移 → 人在画面里远近变化不影响阈值；
 *   2. 只看最近 window 毫秒的位移 → 判的是"挥得多快"，手缓慢漂移/自然放下不会累积成指令；
 *   3. 出招后必须"停稳"（窗口内位移接近 0 持续 settleMs）才重新武装 → 回手动作不会被当成反向挥手；
 *   4. 冷却时间 + 一次锁定 → 排除了抖动与连击误触。
 */

import { handBBox, bboxOverlap, classifyHand } from '../../air-draw/lib/hand-state.js';

export { classifyHand, handBBox, bboxOverlap };

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** 掌宽：手腕 → 中指根，用来归一化，抵消远近尺度 */
export function palmSize(lm) {
  return dist(lm[0], lm[9]) || 1e-6;
}

const MID_MCP = 9; // 掌心参考点

/**
 * 单轴挥动检测器。
 * @param {'x'|'y'} axis 判定轴。y：向上挥手 → y 变小 → 输出 'up'
 */
export class SwipeDetector {
  constructor({
    axis = 'y',
    threshold = 0.85, // 归一化位移阈值（单位：掌宽）
    window = 280, // 只看最近多少毫秒的位移（= "挥动"的时间窗）
    cooldownMs = 480, // 触发后冷却
    settleRatio = 0.4, // 窗口内位移小于这个值即视为"手停住了"
    settleMs = 110, // 停稳多久才重新武装
    smoothing = 0.55, // 位移的 EMA 系数，压抖动
    positiveLabel = 'up',
    negativeLabel = 'down',
  } = {}) {
    this.axis = axis;
    this.threshold = threshold;
    this.window = window;
    this.cooldownMs = cooldownMs;
    this.settleRatio = settleRatio;
    this.settleMs = settleMs;
    this.smoothing = smoothing;
    this.positiveLabel = positiveLabel;
    this.negativeLabel = negativeLabel;
    this.reset();
  }

  reset() {
    this.samples = []; // 最近 window 毫秒内的平滑采样 {t, v}
    this.smooth = null;
    this.lastSeen = 0;
    this.cooldownUntil = 0;
    this.settledSince = 0;
    this.displacement = 0; // 当前归一化位移（正 = positive 方向）
    this.armed = true; // 出招后必须"停稳"才会重新武装
  }

  /** 手势灵敏度：低/中/高 → 阈值倍数 */
  setSensitivity(level) {
    const k = level === 'low' ? 1.25 : level === 'high' ? 0.72 : 1;
    this.thresholdBase = this.thresholdBase ?? this.threshold;
    this.threshold = this.thresholdBase * k;
  }

  /**
   * @param {Array<{x:number,y:number}>|null} lm 21 点手部关键点
   * @param {number} now
   * @returns {{dir:string|null, power:number}} dir 为 null 表示本帧无指令
   */
  push(lm, now) {
    if (!lm || lm.length < 21) {
      this.samples = [];
      this.smooth = null;
      this.lastSeen = 0;
      this.settledSince = 0;
      return { dir: null, power: 0 };
    }

    const raw = this.axis === 'y' ? lm[MID_MCP].y : lm[MID_MCP].x;
    const palm = palmSize(lm);

    if (this.smooth === null) this.smooth = raw;
    else this.smooth = this.smooth + (raw - this.smooth) * this.smoothing;

    // 手消失一段时间后重新出现 → 重建参考，避免"手一出现就触发"
    if (!this.lastSeen || now - this.lastSeen > this.window * 2) {
      this.lastSeen = now;
      this.samples = [{ t: now, v: this.smooth }];
      this.settledSince = 0;
      return { dir: null, power: 0 };
    }
    this.lastSeen = now;

    // 只看最近 window 毫秒的位移 → 判定的是"挥出去有多快"，
    // 而不是"离初始位置有多远"，所以手缓慢漂移不会累积成一条指令。
    this.samples.push({ t: now, v: this.smooth });
    while (this.samples.length > 1 && now - this.samples[0].t > this.window) this.samples.shift();
    const ref = this.samples[0].v;

    // 坐标轴方向统一：y 轴向下为正 → 取负号，让"向上"为正
    const sign = this.axis === 'y' ? -1 : 1;
    const d = ((this.smooth - ref) * sign) / palm;
    this.displacement = d;

    if (now < this.cooldownUntil) return { dir: null, power: Math.abs(d) };

    // 窗口内几乎没有位移 = 手停住了（回到中立位）→ 重新武装，准备下一招
    if (Math.abs(d) < this.settleRatio) {
      if (!this.settledSince) this.settledSince = now;
      if (now - this.settledSince > this.settleMs) {
        this.settledSince = 0;
        this.armed = true;
      }
      return { dir: null, power: 0 };
    }
    this.settledSince = 0;

    if (this.armed && Math.abs(d) >= this.threshold) {
      const dir = d > 0 ? this.positiveLabel : this.negativeLabel;
      this.cooldownUntil = now + this.cooldownMs;
      this.armed = false; // 关键：必须先停稳，回手动作不会变成反向指令
      return { dir, power: Math.abs(d) };
    }
    return { dir: null, power: Math.abs(d) };
  }
}

/** 竖直挥手：跳跃 / 滑铲 */
export class WipeDetector extends SwipeDetector {
  constructor(opts = {}) {
    super({ axis: 'y', positiveLabel: 'up', negativeLabel: 'down', threshold: 0.85, ...opts });
  }
}

/** 水平挥手：变道（纯手势模式） */
export class SwipeLaneDetector extends SwipeDetector {
  constructor(opts = {}) {
    super({ axis: 'x', positiveLabel: 'right', negativeLabel: 'left', threshold: 1.0, cooldownMs: 420, ...opts });
  }
}

/** 手指伸直数（教学页做实时反馈用） */
export function extendedCount(lm) {
  if (!lm || lm.length < 21) return 0;
  const chains = [[8, 6], [12, 10], [16, 14], [20, 18]];
  const wrist = lm[0];
  let n = 0;
  for (const [tip, pip] of chains) {
    if (dist(lm[tip], wrist) > dist(lm[pip], wrist) * 1.12) n += 1;
  }
  return n;
}

/** 手掌是否高举过头（用于教学页提示"把手抬到镜头前"） */
export function handRaised(lm) {
  if (!lm || lm.length < 21) return false;
  return lm[MID_MCP].y < 0.55;
}
