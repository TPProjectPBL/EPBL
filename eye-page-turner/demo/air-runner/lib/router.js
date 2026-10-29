/**
 * 前置界面路由（屏幕状态机）
 *
 * 所有屏幕是同一个 HTML 里的 <section data-screen="xxx">，
 * 通过 is-active 类切换，带进出场过渡；支持 history 栈（返回上一屏）。
 */

export class ScreenRouter {
  /**
   * @param {object} opts
   *   initial  初始屏幕名
   *   onEnter(name, payload, prev) 进入屏幕回调（用于刷新 dwell 元素、启动校准等）
   *   onLeave(name, next)
   */
  constructor({ initial = 'splash', onEnter, onLeave } = {}) {
    this.screens = new Map();
    for (const el of document.querySelectorAll('[data-screen]')) {
      this.screens.set(el.dataset.screen, el);
    }
    this.onEnter = onEnter || null;
    this.onLeave = onLeave || null;
    this.current = null;
    this.payload = {};
    this.history = [];
    if (initial) this.go(initial, {}, { replace: true });
  }

  has(name) {
    return this.screens.has(name);
  }

  el(name) {
    return this.screens.get(name) || null;
  }

  go(name, payload = {}, { replace = false, pushStack = true } = {}) {
    const next = this.screens.get(name);
    if (!next) {
      console.warn('[router] unknown screen:', name);
      return false;
    }
    const prev = this.current;
    if (prev === name) {
      this.payload = payload;
      return true;
    }

    if (prev && !replace && pushStack) this.history.push(prev);
    if (replace) this.history = [];

    if (prev) {
      const prevEl = this.screens.get(prev);
      if (prevEl) {
        prevEl.classList.add('is-leaving');
        prevEl.classList.remove('is-active');
        setTimeout(() => prevEl.classList.remove('is-leaving'), 260);
      }
      if (this.onLeave) this.onLeave(prev, name);
    }

    next.classList.add('is-entering');
    next.classList.add('is-active');
    setTimeout(() => next.classList.remove('is-entering'), 320);

    this.current = name;
    this.payload = payload;
    if (this.onEnter) this.onEnter(name, payload, prev);
    return true;
  }

  replace(name, payload) {
    return this.go(name, payload, { replace: true });
  }

  back(fallback = 'splash') {
    const prev = this.history.pop();
    if (prev) return this.go(prev, {}, { replace: false, pushStack: false });
    return this.go(fallback, {}, { replace: true });
  }

  get canGoBack() {
    return this.history.length > 0;
  }
}
