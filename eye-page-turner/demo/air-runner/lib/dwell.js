/**
 * 眼动「注视点击」控制器
 *
 * 前置 UI 的全部按钮都带 data-dwell 属性，视线停留 dwellMs 即可点击 ——
 * 让菜单本身也能全眼动操作（对应设计报告「分时复用 / 低负担交互」）。
 *
 * 复用 M14 的三层误触抑制思路：速度门限、一次锁定、冷却时间。
 * 与 air-draw 的 PaletteDwell 的区别：这里作用于任意可见元素集合，且要求元素当前可见
 * （隐藏屏幕里的按钮不应该被视线"点"到）。
 */

const isVisible = (el) => {
  if (!el) return false;
  if (el.disabled) return false;
  if (el.offsetParent === null && el.tagName !== 'HTML') {
    // fixed 定位元素的 offsetParent 为 null，用 getClientRects 兜底
    if (!el.getClientRects || el.getClientRects().length === 0) return false;
  }
  const r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
};

export class DwellController {
  /**
   * @param {object} opts
   *   selector  默认 '[data-dwell]'
   *   dwellMs   停留时长（前置 UI 建议 700–900ms）
   *   onActivate(el) 触发回调
   *   onProgress(progress, el) 进度回调（画进度环）
   */
  constructor({ selector = '[data-dwell]', dwellMs = 800, cooldownMs = 320, speedLimit = 0.8, onActivate, onProgress } = {}) {
    this.selector = selector;
    this.dwellMs = dwellMs;
    this.cooldownMs = cooldownMs;
    this.speedLimit = speedLimit;
    this.onActivate = onActivate || null;
    this.onProgress = onProgress || null;
    this.items = [];
    this.enabled = true;
    this.refresh();
    this._candidate = null;
    this._start = 0;
    this._locked = null;
    this._cooldownUntil = 0;
    this.cursorInside = false;
  }

  /** 收集元素并预取矩形（屏幕切换 / resize 后必须调用） */
  refresh() {
    const all = Array.from(document.querySelectorAll(this.selector));
    this.items = all
      .filter(isVisible)
      .map((el) => ({ el, rect: el.getBoundingClientRect() }));
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) this.cancel();
  }

  cancel() {
    this._setProgress(this._candidate, 0);
    this._candidate = null;
    this.cursorInside = false;
  }

  _setProgress(el, p) {
    if (!el) return;
    el.style.setProperty('--dwell', String(p));
    // 类名与 ui.css 的进度环规则对应：[data-dwell].dwl-on::after 才显示环
    el.classList.toggle('dwl-on', p > 0.001);
  }

  _hit(px, py) {
    for (const it of this.items) {
      const r = it.rect;
      if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) return it.el;
    }
    return null;
  }

  /**
   * @param {{x:number,y:number}|null} cursor 归一化坐标
   * @param {number} now
   * @param {number} speed 归一化速度（用于"扫视不算点击"）
   * @returns {boolean} 光标是否落在可交互元素上
   */
  update(cursor, now, speed = 0) {
    if (!this.enabled || !cursor) {
      this.cancel();
      return false;
    }
    const px = cursor.x * window.innerWidth;
    const py = cursor.y * window.innerHeight;
    const el = this._hit(px, py);

    if (!el) {
      this.cancel();
      this._locked = null;
      return false;
    }

    this.cursorInside = true;

    if (now < this._cooldownUntil) {
      this._setProgress(this._candidate, 0);
      this._candidate = null;
      return true;
    }
    if (speed > this.speedLimit) {
      // 快速扫过不算点击
      this._setProgress(this._candidate, 0);
      this._candidate = null;
      return true;
    }
    if (this._locked === el) {
      // 已点击过，必须移出再进入
      this._setProgress(el, 0);
      return true;
    }

    if (this._candidate !== el) {
      this._setProgress(this._candidate, 0);
      this._candidate = el;
      this._start = now;
    }

    const p = Math.min(1, (now - this._start) / this.dwellMs);
    this._setProgress(el, p);
    if (this.onProgress) this.onProgress(p, el);

    if (p >= 1) {
      this._cooldownUntil = now + this.cooldownMs;
      this._locked = el;
      this._setProgress(el, 0);
      this._candidate = null;
      // 命中反馈：ui.css 的 hitPulse 动画（动画结束自动失效，无需清理）
      el.classList.add('dwl-hit');
      if (typeof setTimeout === 'function') {
        setTimeout(() => el.classList.remove('dwl-hit'), 400);
      }
      if (this.onActivate) this.onActivate(el);
    }
    return true;
  }
}
