/**
 * @file PAGE_NORM 坐标与任意容器 / iframe 的互转。
 *
 * 坐标语义（三段，单向推导，不允许跳步）：
 *
 * ```text
 * client (CSS px，相对视觉视口)
 *   ── / scale + visualViewport.offset ──▶ 布局 px（相对整窗布局视口）
 *   ── / hostWindow.innerWidth|innerHeight ──▶ PAGE_NORM (0..1)
 *   ── - frameElement.rect.left|top ──▶ 本页 iframe 内 px
 *   ── - container.getBoundingClientRect().left|top ──▶ 容器内 px
 *   ── / rect.width|height ──▶ 容器归一化 (0..1)
 * ```
 *
 * 约定：
 * - `hostWindow` 是「整窗」的 window。独立页 = 自己的 window；iframe 内 = `window.parent`。
 * - 所有函数遇到 `rect.width <= 0 || rect.height <= 0` 返回 `null`，不抛错。
 * - 跨域导致 `hostWindow` 不可读时抛出 `{code:'CROSS_ORIGIN'}`，由调用方改用 postMessage。
 *
 * @module shared/gaze/frame
 */

/** 跨域错误码。抛出的是 Error 实例，带 `code`。 */
export const CROSS_ORIGIN = 'CROSS_ORIGIN';

function crossOrigin(cause) {
  const err = new Error('CROSS_ORIGIN');
  err.code = CROSS_ORIGIN;
  if (cause) err.cause = cause;
  return err;
}

function resolveHost(hostWindow) {
  const w = hostWindow || (typeof window !== 'undefined' ? window : null);
  if (!w) throw crossOrigin();
  return w;
}

/** 读取可能跨域抛错的属性。 */
function readProp(obj, key, fallback) {
  let v;
  try {
    v = obj[key];
  } catch (e) {
    throw crossOrigin(e);
  }
  return v == null ? fallback : v;
}

function readViewport(host) {
  const w = Number(readProp(host, 'innerWidth', 0));
  const h = Number(readProp(host, 'innerHeight', 0));
  let vv = null;
  try {
    vv = host.visualViewport || null;
  } catch {
    vv = null;
  }
  const scale = vv && Number.isFinite(vv.scale) && vv.scale > 0 ? vv.scale : 1;
  const offsetLeft = vv && Number.isFinite(vv.offsetLeft) ? vv.offsetLeft : 0;
  const offsetTop = vv && Number.isFinite(vv.offsetTop) ? vv.offsetTop : 0;
  return { w, h, scale, offsetLeft, offsetTop };
}

/**
 * 当前窗口（`win`）作为 iframe 时在整窗中的 rect。
 * @returns {DOMRect|null} 非 iframe 时返回 null
 */
function frameRectOf(win) {
  if (!win) return null;
  let fe = null;
  try {
    fe = win.frameElement;
  } catch (e) {
    throw crossOrigin(e);
  }
  if (!fe) return null;
  try {
    return fe.getBoundingClientRect();
  } catch (e) {
    throw crossOrigin(e);
  }
}

function currentWindow() {
  return typeof window !== 'undefined' ? window : null;
}

function validRect(r) {
  return !!r && Number.isFinite(r.width) && Number.isFinite(r.height) && r.width > 0 && r.height > 0;
}

/* ------------------------------------------------------------------ 公开 API */

/**
 * client（CSS px）→ PAGE_NORM。
 *
 * @param {number} clientX
 * @param {number} clientY
 * @param {Window} [hostWindow] 整窗 window，默认当前 window
 * @returns {{x:number,y:number}|null}
 */
export function pageFromClient(clientX, clientY, hostWindow) {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const host = resolveHost(hostWindow);
  const vp = readViewport(host);
  if (!(vp.w > 0) || !(vp.h > 0)) return null;

  // 视觉视口 CSS px → 布局 px（scale=1 时恒等）
  const lx = clientX / vp.scale + vp.offsetLeft;
  const ly = clientY / vp.scale + vp.offsetTop;
  return { x: lx / vp.w, y: ly / vp.h };
}

/**
 * PAGE_NORM → 本页 client（CSS px）。
 *
 * 在 iframe 内返回的是 iframe 自己文档的 client 坐标（已减掉 iframe 在整窗中的偏移）。
 *
 * @param {{x:number,y:number}} p
 * @param {Window} [hostWindow] 整窗 window，默认当前 window
 * @returns {{x:number,y:number}|null}
 */
export function clientFromPage(p, hostWindow) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  const host = resolveHost(hostWindow);
  const vp = readViewport(host);
  if (!(vp.w > 0) || !(vp.h > 0)) return null;

  let lx = p.x * vp.w;
  let ly = p.y * vp.h;

  const win = currentWindow();
  const r = frameRectOf(win);
  if (r) {
    if (!validRect(r)) return null;
    lx -= r.left;
    ly -= r.top;
  }

  // 布局 px → 视觉视口 CSS px
  return {
    x: (lx - vp.offsetLeft) * vp.scale,
    y: (ly - vp.offsetTop) * vp.scale,
  };
}

/**
 * PAGE_NORM → 容器归一化坐标。
 *
 * @param {{x:number,y:number}} p PAGE_NORM
 * @param {Element} el 目标容器（可以在宿主文档，也可以在 iframe 内）
 * @param {{hostWindow?: Window, hostScroll?: {x:number,y:number}}} [opts]
 *        `hostScroll` 仅在调用方传入「文档坐标」rect 时使用；`getBoundingClientRect()` 已含滚动，默认 0。
 * @returns {{raw:{x:number,y:number}, clamped:{x:number,y:number}, outside:boolean}|null}
 */
export function containerFromPage(p, el, opts = {}) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !el) return null;

  const doc = el.ownerDocument || null;
  const elWin = (doc && doc.defaultView) || null;
  const host = resolveHost(opts.hostWindow || elWin);
  const vp = readViewport(host);
  if (!(vp.w > 0) || !(vp.h > 0)) return null;

  let rect;
  try {
    rect = el.getBoundingClientRect();
  } catch (e) {
    throw crossOrigin(e);
  }
  if (!validRect(rect)) return null;

  const scroll = opts.hostScroll || { x: 0, y: 0 };
  const sx = p.x * vp.w;
  const sy = p.y * vp.h;

  // 若容器不在宿主文档里（在 iframe 内），先扣掉 iframe 自身的偏移
  let localX = sx;
  let localY = sy;
  if (elWin && elWin !== host) {
    const fr = frameRectOf(elWin);
    if (fr) {
      if (!validRect(fr)) return null;
      localX -= fr.left;
      localY -= fr.top;
    }
  }

  const cx = localX - rect.left - (Number(scroll.x) || 0);
  const cy = localY - rect.top - (Number(scroll.y) || 0);

  const raw = { x: cx / rect.width, y: cy / rect.height };
  const clamped = {
    x: raw.x < 0 ? 0 : raw.x > 1 ? 1 : raw.x,
    y: raw.y < 0 ? 0 : raw.y > 1 ? 1 : raw.y,
  };
  const outside = raw.x < 0 || raw.x > 1 || raw.y < 0 || raw.y > 1;
  return { raw, clamped, outside };
}

/**
 * 容器归一化坐标 → PAGE_NORM（`containerFromPage` 的逆运算）。
 *
 * @param {{x:number,y:number}} q 容器归一化坐标
 * @param {Element} el
 * @param {{hostWindow?: Window, hostScroll?: {x:number,y:number}}} [opts]
 * @returns {{x:number,y:number}|null}
 */
export function pageFromContainer(q, el, opts = {}) {
  if (!q || !Number.isFinite(q.x) || !Number.isFinite(q.y) || !el) return null;

  const doc = el.ownerDocument || null;
  const elWin = (doc && doc.defaultView) || null;
  const host = resolveHost(opts.hostWindow || elWin);
  const vp = readViewport(host);
  if (!(vp.w > 0) || !(vp.h > 0)) return null;

  let rect;
  try {
    rect = el.getBoundingClientRect();
  } catch (e) {
    throw crossOrigin(e);
  }
  if (!validRect(rect)) return null;

  const scroll = opts.hostScroll || { x: 0, y: 0 };
  let localX = q.x * rect.width + rect.left + (Number(scroll.x) || 0);
  let localY = q.y * rect.height + rect.top + (Number(scroll.y) || 0);

  if (elWin && elWin !== host) {
    const fr = frameRectOf(elWin);
    if (fr) {
      if (!validRect(fr)) return null;
      localX += fr.left;
      localY += fr.top;
    }
  }

  return { x: localX / vp.w, y: localY / vp.h };
}

/**
 * 当前渲染环境诊断。调试面板 / 自检页用。
 *
 * @param {Window} [hostWindow] 整窗 window，默认当前 window
 * @returns {{inIframe:boolean, hostW:number, hostH:number,
 *            rect:{left:number,top:number,width:number,height:number},
 *            scrollX:number, scrollY:number, dpr:number, scale:number}|null}
 */
export function frameContext(hostWindow) {
  const host = resolveHost(hostWindow);
  const vp = readViewport(host);
  if (!(vp.w > 0) || !(vp.h > 0)) return null;

  const win = currentWindow();
  const fr = frameRectOf(win);
  const inIframe = !!fr;
  const rect = fr
    ? { left: fr.left, top: fr.top, width: fr.width, height: fr.height }
    : { left: 0, top: 0, width: vp.w, height: vp.h };

  if (!validRect(rect)) return null;

  return {
    inIframe,
    hostW: vp.w,
    hostH: vp.h,
    rect,
    scrollX: Number(readProp(host, 'scrollX', 0)) || 0,
    scrollY: Number(readProp(host, 'scrollY', 0)) || 0,
    dpr: Number(readProp(host, 'devicePixelRatio', 1)) || 1,
    scale: vp.scale,
  };
}
