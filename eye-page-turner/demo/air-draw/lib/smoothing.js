/**
 * 抖动抑制：1€ 滤波器（One Euro Filter）
 *
 * 交互式光标（视线点、指尖点）的噪声治理是「能不能画出一条像样的线」的关键。
 * 相比固定参数的 EMA，1€ 滤波器能在「慢速时强平滑、快速时低延迟」之间自动取舍，
 * 特别适合视线这种静止抖动大、扫视时延迟敏感的信号。
 *
 * 参考：Casiez, Roussel, Vogel (CHI 2012), "1€ Filter".
 */

class LowPass {
  constructor() {
    this.s = null;
  }
  filter(value, a) {
    this.s = this.s === null ? value : a * value + (1 - a) * this.s;
    return this.s;
  }
  reset() {
    this.s = null;
  }
}

function alphaOf(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
  constructor({ minCutoff = 1.2, beta = 0.02, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this._x = new LowPass();
    this._dx = new LowPass();
    this._lastT = null;
    this._lastX = 0;
  }

  reset() {
    this._x.reset();
    this._dx.reset();
    this._lastT = null;
    this._lastX = 0;
  }

  filter(x, tMs) {
    if (this._lastT === null) {
      this._lastT = tMs;
      this._lastX = x;
      this._x.filter(x, 1);
      return x;
    }
    const dt = Math.max(1e-4, (tMs - this._lastT) / 1000);
    const dx = (x - this._lastX) / dt;
    const edx = this._dx.filter(dx, alphaOf(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    const y = this._x.filter(x, alphaOf(cutoff, dt));
    this._lastT = tMs;
    this._lastX = x;
    return y;
  }
}

/** 二维点滤波器 */
export class OneEuroPoint {
  constructor(opts) {
    this.fx = new OneEuroFilter(opts);
    this.fy = new OneEuroFilter(opts);
    this._last = null;
  }

  reset() {
    this.fx.reset();
    this.fy.reset();
    this._last = null;
  }

  /**
   * @returns {{x:number,y:number,vx:number,vy:number,speed:number}} speed 为归一化单位/秒
   */
  filter(point, tMs) {
    const x = this.fx.filter(point.x, tMs);
    const y = this.fy.filter(point.y, tMs);
    let vx = 0;
    let vy = 0;
    if (this._last) {
      const dt = Math.max(1e-4, (tMs - this._last.t) / 1000);
      vx = (x - this._last.x) / dt;
      vy = (y - this._last.y) / dt;
    }
    this._last = { x, y, t: tMs };
    return { x, y, vx, vy, speed: Math.hypot(vx, vy) };
  }
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
