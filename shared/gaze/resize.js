/**
 * @file 视口变化监视 + 兼容性提示。
 *
 * 模型里存着标定时的 `viewport{w,h,dpr}` 与 `camera.aspect`。窗口一改，注视点就会整体偏移
 * （比例变化大时是缩放，比例不变时是平移/重采样）。三条可选策略里选的是「提示 + 两点校正」：
 *   - 自动重标：打断使用，用户正在看东西时最烦；
 *   - 静默仿射补偿：比例变化大时会越补越偏，而且用户不知道模型已经不可信；
 *   - 提示 + 两点校正：只多花 3 秒，且校正本身有 `REFINE_SCALE_RANGE` 兜底。
 *
 * `checkCompat` 给出 exact / soft / hard：
 *   - soft（尺寸小幅变、dpr 变、相机比例小变）→ 顶部非阻塞条，建议两点校正；
 *   - hard（比例大变、引擎版本变、terms 不兼容）→ 阻塞提示，请重新标定。
 *
 * 300ms 防抖：拖动窗口时 resize 会连续触发几十次，每帧算一次 compat 没有意义。
 * 同一条提示只弹一次：用 `level + diffs` 生成签名，签名没变就不重复打扰。
 */

import { checkCompat } from './store.js';

export const RESIZE_DEBOUNCE_MS = 300;
export const NOTICE_ATTR = 'data-gaze-compat-notice';

/** 读当前环境（viewport / dpr / visualViewport）。camera/engine 由调用方补。 */
export function readEnv(win, extra = null) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  if (!w) return { viewport: { w: 1, h: 1, dpr: 1 } };
  const vv = w.visualViewport;
  return {
    viewport: {
      w: Math.round(w.innerWidth || 0) || 1,
      h: Math.round(w.innerHeight || 0) || 1,
      dpr: round2(w.devicePixelRatio || 1),
    },
    visualViewport: vv ? { w: Math.round(vv.width), h: Math.round(vv.height), scale: round2(vv.scale || 1) } : null,
    ...(extra || {}),
  };
}

function round2(v) {
  return Math.round(Number(v || 0) * 100) / 100;
}

/** 把 diffs 压成一个稳定签名，用来判断「是不是同一条提示」。 */
export function compatSignature(compat) {
  if (!compat) return 'none';
  const parts = (compat.diffs || []).map((d) => `${d.field}:${d.level}`);
  return `${compat.level}|${parts.sort().join(',')}`;
}

/**
 * 监视视口变化。变化并稳定 300ms 后，用 `checkCompat` 与当前模型比对，回调 `{level,diffs,advice,env}`。
 *
 * @param {(r: {level:string, diffs:Array, advice:string, env:object, signature:string}) => void} cb
 * @param {object} [opts]
 * @param {Window} [opts.win]
 * @param {() => object|null} [opts.getModel] 当前模型（schema:1 原始对象或实例）
 * @param {() => object} [opts.getEnv] 自定义环境读取（默认 readEnv）
 * @param {number} [opts.debounceMs=300]
 * @param {boolean} [opts.immediate=false] 立即先检查一次
 * @returns {{stop: () => void, check: (force?: boolean) => object|null}}
 */
export function watchViewport(cb, opts = {}) {
  const win = opts.win || (typeof window !== 'undefined' ? window : null);
  const debounceMs = isFinite(opts.debounceMs) ? opts.debounceMs : RESIZE_DEBOUNCE_MS;
  const getModel = opts.getModel || (() => null);
  const getEnv = opts.getEnv || (() => readEnv(win, opts.extra));
  if (!win) return { stop() {}, check() { return null; } };

  let timer = null;
  let lastSig = '';
  let stopped = false;
  let mq = null;

  function run(force = false) {
    if (stopped) return null;
    const model = getModel();
    if (!model) return null;
    const env = getEnv() || {};
    let compat;
    try {
      compat = checkCompat(model, env);
    } catch (e) {
      console.warn('[gaze-resize] checkCompat 失败', e);
      return null;
    }
    const signature = compatSignature(compat);
    // exact 不算「变化」，也不清空 lastSig：用户改回去再改回来应重新提示
    if (compat.level === 'exact') {
      lastSig = '';
      return { ...compat, env, signature };
    }
    if (!force && signature === lastSig) return { ...compat, env, signature };
    lastSig = signature;
    const out = { ...compat, env, signature };
    try {
      cb(out);
    } catch (e) {
      console.warn('[gaze-resize] 回调抛错', e);
    }
    return out;
  }

  function schedule() {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      run(false);
    }, debounceMs);
  }

  win.addEventListener('resize', schedule);
  if (win.visualViewport) win.visualViewport.addEventListener('resize', schedule);

  // devicePixelRatio 变化（插拔显示器 / 浏览器缩放）不走 resize，只能靠 matchMedia 追踪
  const bindDpr = () => {
    if (!win.matchMedia) return;
    if (mq && mq.removeEventListener) mq.removeEventListener('change', onDpr);
    mq = win.matchMedia(`(resolution: ${win.devicePixelRatio}dppx)`);
    if (mq && mq.addEventListener) mq.addEventListener('change', onDpr);
  };
  function onDpr() {
    schedule();
    bindDpr(); // 分辨率变了要重新绑定新的 media query
  }
  bindDpr();

  if (opts.immediate) run(true);

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      win.removeEventListener('resize', schedule);
      if (win.visualViewport) win.visualViewport.removeEventListener('resize', schedule);
      if (mq && mq.removeEventListener) mq.removeEventListener('change', onDpr);
    },
    check(force = false) {
      return run(force);
    },
  };
}

/* ------------------------------------------------------------------ 提示 UI */

const FONT = 'system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif';

function btn(doc, text, primary) {
  const b = doc.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.style.cssText = [
    'all:unset',
    'cursor:pointer',
    'padding:6px 12px',
    'border-radius:8px',
    'font-size:12px',
    'font-weight:600',
    `border:1px solid ${primary ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.22)'}`,
    `color:${primary ? '#0d1411' : '#e8eee9'}`,
    `background:${primary ? 'rgba(255,255,255,0.92)' : 'transparent'}`,
  ].join(';');
  return b;
}

/**
 * 弹出兼容性提示。
 *
 * @param {object} r
 * @param {'soft'|'hard'} r.level
 * @param {Document} [r.doc]
 * @param {string} [r.message]
 * @param {() => void} [r.onRefine]      soft：「做两点校正」
 * @param {() => void} [r.onRecalib]     hard：「重新标定」
 * @param {() => void} [r.onIgnore]      关闭时回调
 * @param {number} [r.autoHideMs]        soft 自动隐藏（0 = 不自动）
 * @returns {{close: () => void, el: Element}}
 */
export function showCompatNotice(r = {}) {
  const doc = r.doc || (typeof document !== 'undefined' ? document : null);
  if (!doc || !doc.body) return { close() {}, el: null };
  const level = r.level === 'hard' ? 'hard' : 'soft';

  // 单例：先移除旧提示，避免叠一堆
  const old = doc.querySelector(`[${NOTICE_ATTR}]`);
  if (old) old.remove();

  const root = doc.createElement('div');
  root.setAttribute(NOTICE_ATTR, level);

  const close = () => {
    root.remove();
    if (r.onIgnore) {
      try {
        r.onIgnore();
      } catch (e) {
        console.warn('[gaze-resize] onIgnore 抛错', e);
      }
    }
  };

  const card = doc.createElement('div');
  const msg = doc.createElement('div');
  msg.textContent = r.message || (level === 'hard' ? '请重新标定' : '窗口尺寸变了，建议做一次两点校正');

  if (level === 'soft') {
    root.style.cssText = [
      'position:fixed',
      'left:50%',
      'top:14px',
      'transform:translateX(-50%)',
      'z-index:2147482900',
      'pointer-events:none',
      `font-family:${FONT}`,
    ].join(';');
    card.style.cssText = [
      'pointer-events:auto',
      'display:flex',
      'align-items:center',
      'gap:10px',
      'max-width:min(92vw,520px)',
      'padding:9px 12px',
      'border-radius:12px',
      // 中性色：不引入任何页面的品牌色（配色约束）
      'background:rgba(18,22,20,0.92)',
      'color:#e8eee9',
      'border:1px solid rgba(255,255,255,0.16)',
      'box-shadow:0 8px 24px rgba(0,0,0,0.28)',
      'font-size:12.5px',
      'line-height:1.4',
    ].join(';');
    msg.style.cssText = 'flex:1;min-width:0';
    card.appendChild(msg);
    if (r.onRefine) {
      const b = btn(doc, '两点校正', true);
      b.addEventListener('click', () => {
        root.remove();
        r.onRefine();
      });
      card.appendChild(b);
    }
    const x = btn(doc, '稍后', false);
    x.addEventListener('click', close);
    card.appendChild(x);
    root.appendChild(card);
  } else {
    // hard：阻塞，必须做出选择
    root.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147482900',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'background:rgba(0,0,0,0.55)',
      `font-family:${FONT}`,
    ].join(';');
    card.style.cssText = [
      'max-width:min(90vw,420px)',
      'padding:20px 22px',
      'border-radius:16px',
      'background:rgba(18,22,20,0.96)',
      'color:#e8eee9',
      'border:1px solid rgba(255,255,255,0.16)',
      'box-shadow:0 18px 48px rgba(0,0,0,0.42)',
      'font-size:13px',
      'line-height:1.5',
    ].join(';');
    msg.style.cssText = 'margin-bottom:14px';
    card.appendChild(msg);
    const row = doc.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end';
    if (r.onRecalib) {
      const b = btn(doc, '重新标定', true);
      b.addEventListener('click', () => {
        root.remove();
        r.onRecalib();
      });
      row.appendChild(b);
    }
    const later = btn(doc, '稍后', false);
    later.addEventListener('click', close);
    row.appendChild(later);
    card.appendChild(row);
    root.appendChild(card);
  }

  doc.body.appendChild(root);

  if (level === 'soft' && r.autoHideMs) {
    setTimeout(() => {
      if (root.parentNode) {
        root.remove();
      }
    }, r.autoHideMs);
  }
  return { close, el: root };
}

/**
 * 一站式：监视 + 提示 + 去重。模块里只调这一个。
 *
 * @param {object} opts
 * @param {() => object|null} opts.getModel
 * @param {() => object} [opts.getEnv]
 * @param {Element} [opts.container]   用于定位提示（默认 document.body）
 * @param {() => void} [opts.onRefine]
 * @param {() => void} [opts.onRecalib]
 * @param {boolean} [opts.enabled=true]
 * @returns {{stop: () => void, check: (force?: boolean) => object|null, last: object|null}}
 */
export function installCompatGuard(opts = {}) {
  const getModel = opts.getModel;
  const guard = { last: null, stop() {}, check() { return null; } };
  if (opts.enabled === false) return guard;
  const doc = opts.container && opts.container.ownerDocument ? opts.container.ownerDocument : typeof document !== 'undefined' ? document : null;

  const watcher = watchViewport(
    (r) => {
      guard.last = r;
      // 已经在提示中就不重复弹（签名相同 watchViewport 已挡一层，这里再挡跨来源重复）
      if (doc && doc.querySelector(`[${NOTICE_ATTR}]`)) return;
      showCompatNotice({
        level: r.level,
        doc,
        onRefine: opts.onRefine,
        onRecalib: opts.onRecalib,
      });
    },
    { getModel, getEnv: opts.getEnv, debounceMs: opts.debounceMs, immediate: opts.immediate }
  );

  guard.stop = watcher.stop;
  guard.check = watcher.check;
  return guard;
}

export default watchViewport;
