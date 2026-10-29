/**
 * M14 · 眼动选色交互（注视 + dwell + 进度环 + 误触抑制）
 *
 * 对应《开工方案》9.1 / 9.3：
 *   - 选色 = 眼睛注视颜色面板，注视停留（dwell）触发；
 *   - 决策 7：注视 + dwell 600–900ms + 进度环，单纯注视点无法区分「看」与「选」，必然误触。
 *
 * 误触抑制（三层）：
 *   1. 速度门限：光标移动过快时不开始累积 dwell（扫视经过不算选择）；
 *   2. 一次锁定：选中后必须「移出」该色块再重新进入，才能再次触发（防止长盯连选）；
 *   3. 冷却时间：两次选中之间强制间隔 cooldownMs。
 */

export class PaletteDwell {
  /**
   * @param {object} opts
   *   root       调色板容器（内部元素需带 data-color）
   *   dwellMs    注视停留时长，报告建议 600–900ms
   *   cooldownMs 两次选中之间的冷却
   *   speedLimit 启动 dwell 的速度上限（归一化单位/秒）
   */
  constructor({ root, dwellMs = 700, cooldownMs = 350, speedLimit = 0.55, onSelect, onProgress } = {}) {
    this.root = root;
    this.dwellMs = dwellMs;
    this.cooldownMs = cooldownMs;
    this.speedLimit = speedLimit;
    this.onSelect = onSelect || null;
    this.onProgress = onProgress || null;

    this.swatches = Array.from(root.querySelectorAll('[data-color]'));
    this.rects = [];
    this.measure();

    this.selected = this.swatches[0] ? this.swatches[0].dataset.color : '#ffd166';
    this.selectedEl = this.swatches[0] || null;
    if (this.selectedEl) this.selectedEl.classList.add('is-active');

    this._candidate = null;
    this._start = 0;
    this._lockedEl = null;
    this._cooldownUntil = 0;
    this._progress = 0;
  }

  measure() {
    this.rects = this.swatches.map((el) => {
      const r = el.getBoundingClientRect();
      return { el, x0: r.left, y0: r.top, x1: r.right, y1: r.bottom };
    });
  }

  _hit(px, py) {
    for (const r of this.rects) {
      if (px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1) return r.el;
    }
    return null;
  }

  _setProgress(el, p) {
    if (!el) return;
    el.style.setProperty('--dwell', String(p));
    el.classList.toggle('is-dwelling', p > 0.001);
  }

  _clearCandidate() {
    if (this._candidate) this._setProgress(this._candidate, 0);
    this._candidate = null;
    this._progress = 0;
  }

  select(el, instant = false) {
    if (!el) return;
    this.selected = el.dataset.color;
    this.selectedEl = el;
    for (const s of this.swatches) s.classList.toggle('is-active', s === el);
    this._lockedEl = el;
    this._cooldownUntil = performance.now() + this.cooldownMs;
    if (instant) this._setProgress(el, 0);
    if (this.onSelect) this.onSelect(this.selected, el);
  }

  /**
   * 每帧调用
   * @param {{x:number,y:number,speed:number}|null} cursor 归一化坐标 + 速度
   * @param {number} now performance.now()
   * @param {number} speed 速度（归一化单位/秒）
   * @returns {boolean} 光标是否位于调色板内（调用方可据此暂停绘制）
   */
  update(cursor, now, speed = 0) {
    if (!cursor) {
      this._clearCandidate();
      return false;
    }
    const px = cursor.x * window.innerWidth;
    const py = cursor.y * window.innerHeight;
    const el = this._hit(px, py);

    if (!el) {
      this._clearCandidate();
      this._lockedEl = null; // 移出调色板即解锁
      return false;
    }

    // 误触抑制 3：冷却
    if (now < this._cooldownUntil) {
      this._clearCandidate();
      return true;
    }
    // 误触抑制 2：同一色块选中后需移出再进入
    if (this._lockedEl === el) {
      this._clearCandidate();
      return true;
    }
    // 误触抑制 1：快速掠过不累积
    if (speed > this.speedLimit) {
      this._clearCandidate();
      this._setProgress(el, 0.999 * 0.0 + 0); // 保持 0，仅清理
      return true;
    }

    if (this._candidate !== el) {
      if (this._candidate) this._setProgress(this._candidate, 0);
      this._candidate = el;
      this._start = now;
    }

    this._progress = Math.min(1, (now - this._start) / this.dwellMs);
    this._setProgress(el, this._progress);
    if (this.onProgress) this.onProgress(this._progress, el);

    if (this._progress >= 1) {
      this.select(el, true);
      this._candidate = null;
      this._progress = 0;
      this._setProgress(el, 0);
    }
    return true;
  }
}
