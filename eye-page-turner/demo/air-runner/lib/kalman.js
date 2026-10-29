/**
 * 注视光标平滑：自适应卡尔曼滤波（恒速模型）
 *
 * 为什么在已有 1€ 滤波器之外再加一个：
 *   - 1€（air-draw/lib/smoothing.js）是「低通 + 速度自适应截止频率」，本质仍是**无模型**滤波：
 *     它不知道光标是在匀速扫视还是停住不动，只按瞬时速度调带宽。停顿时的残余抖动和
 *     扫视时的滞后必须二选一（当前 minCutoff=1.6/beta=0.03 是折中值，实测停顿抖动约 1.5% 屏宽）。
 *   - 卡尔曼带**状态模型**（位置 + 速度）：匀速扫视时它能「预测」下一步位置，所以滞后更小；
 *     停住时速度估计收敛到 0，过程噪声自动收窄，抖动被压得更狠。同一个滤波器的两端都更好。
 *   - 额外好处：速度是状态估计量（不是差商），比 1€ 的差分速度更稳，直接喂给 dwell 判定更可靠。
 *
 * 模型（每轴独立，归一化坐标，单位「屏/秒」）：
 *   状态 x = [p, v]，预测 p' = p + v·dt、v' = v
 *   过程噪声 Q = q·[[dt³/3, dt²/2], [dt²/2, dt]]（连续白噪声加速度模型）
 *   观测 z = p + 噪声，R = r
 *   自适应 q：|v| 越大 q 越大（越快越信任观测、越跟手）；停住时 q 收到 qSlow（越稳）。
 *
 * 参考：WebGazer 的 applyKalmanFilter 也是「每坐标一个卡尔曼」；不同之处是我们用恒速模型
 * + 速度自适应 q，而不是固定参数（固定参数的卡尔曼在「静止 vs 扫视」两端必然一头妥协）。
 */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 单轴卡尔曼（2 状态：位置 + 速度） */
export class KalmanFilter1D {
  /**
   * @param {object} o
   * @param {number} o.q      静止时的过程噪声（越小越稳）
   * @param {number} o.qFast  高速时的过程噪声（越大越跟手）
   * @param {number} o.r      观测噪声（≈预测抖动方差，可由模型 avgErr 推）
   * @param {number} o.vRef   达到多大速度算「全速」（归一化单位/秒）
   */
  constructor({ q = 0.001, qFast = 0.3, r = 0.0009, vRef = 1.0 } = {}) {
    this.q = q;
    this.qFast = qFast;
    this.r = r;
    this.vRef = vRef;
    this.reset();
  }

  reset() {
    this.p = 0;
    this.v = 0;
    this.P00 = 1;
    this.P01 = 0;
    this.P10 = 0;
    this.P11 = 1;
    this._init = false;
    this._lastT = null;
  }

  /** @returns {number} 滤波后的位置 */
  filter(z, tMs) {
    if (!isFinite(z)) return this.p;
    if (!this._init) {
      // 首帧直接采信观测：不要从 (0,0) 慢慢爬过去
      this._init = true;
      this.p = z;
      this.v = 0;
      this._lastT = tMs;
      return z;
    }
    const dt = Math.min(0.25, Math.max(1e-3, (tMs - this._lastT) / 1000));
    this._lastT = tMs;

    // 自适应过程噪声：速度 → 带宽
    const q = this.q + (this.qFast - this.q) * clamp01(Math.abs(this.v) / this.vRef);

    // ---- 预测
    const p0 = this.p + this.v * dt;
    const P00 = this.P00 + dt * (this.P10 + this.P01) + dt * dt * this.P11 + (q * dt * dt * dt) / 3;
    const P01 = this.P01 + dt * this.P11 + (q * dt * dt) / 2;
    const P10 = this.P10 + dt * this.P11 + (q * dt * dt) / 2;
    const P11 = this.P11 + q * dt;

    // ---- 更新
    const S = P00 + this.r;
    const K0 = P00 / S;
    const K1 = P10 / S;
    const y = z - p0;
    this.p = p0 + K0 * y;
    this.v = this.v + K1 * y;
    // 用**预测后**的 P 更新（nP10 依赖 P00 的预测值，顺序不能反）
    this.P00 = P00 - K0 * P00;
    this.P01 = P01 - K0 * P01;
    this.P10 = P10 - K1 * P00;
    this.P11 = P11 - K1 * P01;
    return this.p;
  }
}

/** 二维点滤波器，接口与 OneEuroPoint 完全一致（可直接替换） */
export class KalmanPoint {
  constructor(opts) {
    this.kx = new KalmanFilter1D(opts);
    this.ky = new KalmanFilter1D(opts);
    /** 速度输出的一阶低通时间常数（秒）：让 speed 口径贴近 1€ 的差商，避免 dwell 手感突变 */
    this.tauSpeed = (opts && opts.tauSpeed) || 0.12;
    this._sx = 0;
    this._sy = 0;
    this._lastT = null;
  }

  reset() {
    this.kx.reset();
    this.ky.reset();
    this._sx = 0;
    this._sy = 0;
    this._lastT = null;
  }

  /**
   * @returns {{x:number,y:number,vx:number,vy:number,speed:number}} speed 为归一化单位/秒
   */
  filter(point, tMs) {
    const x = this.kx.filter(point.x, tMs);
    const y = this.ky.filter(point.y, tMs);
    let vx = this.kx.v;
    let vy = this.ky.v;
    if (this._lastT !== null) {
      const dt = Math.min(0.25, Math.max(1e-3, (tMs - this._lastT) / 1000));
      const a = 1 - Math.exp(-dt / Math.max(1e-3, this.tauSpeed));
      this._sx += a * (vx - this._sx);
      this._sy += a * (vy - this._sy);
    } else {
      this._sx = vx;
      this._sy = vy;
    }
    this._lastT = tMs;
    vx = this._sx;
    vy = this._sy;
    return { x, y, vx, vy, speed: Math.hypot(vx, vy) };
  }
}

/**
 * 按模型精度微调观测噪声 R（归一化单位²）。
 *
 * 注意**不要**用 avgErr²：avgErr 是「留一平均误差」，其中大部分是**系统性偏差**（模型本身
 * 跟不上），不是零均值噪声，而 R 的物理含义只是观测噪声的方差。扫描实测：r 取到 0.0025
 * （≈avgErr 5% 的平方）时扫视滞后立刻回到 1€ 滤波器的水平（RMS 9.5%），白丢卡尔曼的优势。
 * 所以用一条很平的经验线：3% 误差 → r≈0.0007，5% → 0.0009，7% → 0.0011，并夹在窄区间内。
 */
export function rFromAvgErr(avgErr) {
  const e = isFinite(avgErr) && avgErr > 0 ? avgErr : 0.05;
  return Math.min(0.0012, Math.max(0.0004, 0.0003 + e * 0.012));
}
