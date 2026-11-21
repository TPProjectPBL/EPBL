/**
 * @file 模块侧接入层：把「点击即训练」「尺寸变化提示」「两点校正」三件事一次装好。
 *
 * 四个业务模块的 DOM 结构差别很大，但要做的事完全一样，所以这里只暴露最少的口子：
 *
 *   const g = createGazeLearning({ getModel, getLandmarks, getAspect, storage });
 *   g.onFrame(landmarks);          // 每帧喂一次，内部算特征 + 记时间戳
 *   g.setModel(raw);               // 标定/校正/在线更新后同步
 *   g.install(document);           // 装点击监听 + 尺寸监视
 *
 * 三个容易踩的点，都在这里统一处理：
 *
 * 1. **坐标必须换成顶层 PAGE_NORM**。模型的训练目标是「相对于顶层页面视口的归一化坐标」，
 *    而模块跑在 iframe 里，`window.innerWidth/innerHeight` 是 iframe 自己的尺寸。
 *    直接在 iframe 里算，y 会被拉伸到 iframe 高度，样本系统性地偏上/偏下。
 * 2. **点击要在 capture 阶段取矩形**。点击常常会切屏，切屏后元素矩形变成 0，标签就错了。
 * 3. **只收「明确可交互」的元素**。点在空白处 = 用户只是随手点了一下，眼睛未必看着那里，
 *    把它当标签就是污染（这是安全阀挡不住的那类样本，必须在源头排除）。
 */

import { extractFeaturesMirrored } from './core/index.js';
import { createOnline } from './online.js';
import { installCompatGuard, readEnv } from './resize.js';

/** 默认可交互元素选择器。`[data-gaze-target]` 给不方便用语义标签的元素留口子。 */
export const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input[type="button"]',
  'input[type="submit"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  'select',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[data-gaze-target]',
].join(',');

/** 从元素往上找最近的「可交互」祖先（点图标/文字时 event.target 往往是子节点）。 */
export function closestInteractive(el, selector = INTERACTIVE_SELECTOR) {
  if (!el || typeof el.closest !== 'function') return null;
  return el.closest(selector);
}

/**
 * 元素中心 → 顶层 PAGE_NORM。
 * 同源 iframe 逐层累加 `frameElement` 偏移；跨域或拿不到顶层时退化为本地视口（至少不崩）。
 */
export function centerPageNorm(el, win) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  const w = win || (typeof window !== 'undefined' ? window : null);
  const r = el.getBoundingClientRect();
  if (!r || !r.width || !r.height) return null;

  let ox = 0;
  let oy = 0;
  let vw = (w && w.innerWidth) || 1;
  let vh = (w && w.innerHeight) || 1;

  try {
    const top = w.top;
    if (top && top !== w && w.frameElement) {
      let cur = w;
      let x = 0;
      let y = 0;
      let guard = 0;
      while (cur && cur !== cur.parent && cur.frameElement && guard++ < 8) {
        const fr = cur.frameElement.getBoundingClientRect();
        x += fr.left;
        y += fr.top;
        cur = cur.parent;
      }
      ox = x;
      oy = y;
      vw = top.innerWidth || vw;
      vh = top.innerHeight || vh;
    }
  } catch {
    /* 跨域：用本地视口，宁可偏也不抛 */
  }

  const x = (ox + r.left + r.width / 2) / vw;
  const y = (oy + r.top + r.height / 2) / vh;
  if (!isFinite(x) || !isFinite(y)) return null;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null; // 屏外（隐藏屏幕里的按钮）
  return { x, y, space: 'PAGE_NORM' };
}

/**
 * PAGE_NORM（顶层页面归一化）→ **当前窗口**的 client 坐标。
 *
 * 模型输出永远是相对顶层页面的归一化坐标；模块跑在 iframe 里时，`p.x * window.innerWidth`
 * 会得到错误结果（iframe 视图只是顶层页面的一块，且 y 还带着偏移）。
 * 这里沿 `frameElement` 逐层扣掉偏移，并用顶层视口做基准。
 */
export function pageNormToClient(p, win) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  if (!w || !p || !isFinite(p.x) || !isFinite(p.y)) return null;
  let vw = w.innerWidth || 1;
  let vh = w.innerHeight || 1;
  let ox = 0;
  let oy = 0;
  try {
    const top = w.top;
    if (top && top !== w && w.frameElement) {
      let cur = w;
      let guard = 0;
      while (cur && cur !== cur.parent && cur.frameElement && guard++ < 8) {
        const fr = cur.frameElement.getBoundingClientRect();
        ox += fr.left;
        oy += fr.top;
        cur = cur.parent;
      }
      vw = top.innerWidth || vw;
      vh = top.innerHeight || vh;
    }
  } catch {
    /* 跨域：退回本地视口 */
  }
  return { x: p.x * vw - ox, y: p.y * vh - oy };
}

/**
 * @param {object} opts
 * @param {() => object|null} opts.getModel      当前模型（schema:1 原始对象或实例）
 * @param {(p:object)=>Array|null} [opts.getLandmarks] 取当前 landmarks（为 null 时只接点击不喂特征）
 * @param {() => number} [opts.getAspect]
 * @param {Storage} [opts.storage]
 * @param {boolean} [opts.collect=true]           是否采集点击（热力图传 false）
 * @param {string} [opts.selector]                可交互元素选择器
 * @param {boolean} [opts.enabled]                在线学习总开关（默认跟随 ?train=0）
 * @param {(r:object)=>void} [opts.onModel]       模型被接受时的回调
 * @param {() => void} [opts.onRefine]            尺寸变化时点「两点校正」
 * @param {() => void} [opts.onRecalib]           hard 变化时点「重新标定」
 * @param {boolean} [opts.guard=true]             是否安装尺寸监视
 */
export function createGazeLearning(opts = {}) {
  const win = opts.win || (typeof window !== 'undefined' ? window : null);
  const doc = opts.doc || (win && win.document) || (typeof document !== 'undefined' ? document : null);
  const getModel = opts.getModel || (() => null);
  const getAspectFn = opts.getAspect || (() => 4 / 3);
  const collect = opts.collect !== false;
  const selector = opts.selector || INTERACTIVE_SELECTOR;

  // 统一标定协议接管模型后，点击即训练默认关闭：
  // 模型唯一来源是 9 点标定 + IndexedDB，模块不得在运行时改写系数。
  const enabled = opts.enabled === true;

  const online = createOnline({
    storage: opts.storage,
    enabled,
    getAspect: getAspectFn,
    getJudge: () => (typeof getModel() === 'object' ? getModel() : null),
    onModel: (r) => {
      if (opts.onModel) opts.onModel(r);
    },
  });

  let lastLm = null;
  let lastFeat = null;
  let clickOff = null;

  const api = {
    online,
    get lastFeatures() {
      return lastFeat;
    },
    /** 每帧调用：landmarks → 特征 → 记录时间戳（供 noteClick 判新鲜度）。 */
    onFrame(lm, ts) {
      if (!lm || !lm.length) return false;
      lastLm = lm;
      let f = null;
      try {
        f = extractFeaturesMirrored(lm, getAspectFn());
      } catch {
        f = null;
      }
      if (!f) return false;
      lastFeat = f;
      return online.markFeatures(f, isFinite(ts) ? ts : Date.now());
    },
    setModel() {
      /* 模型由 getModel 实时读取，这里只是语义占位 */
    },
    /** 记一次点击（元素或已算好的 PAGE_NORM 目标）。 */
    noteClick(elOrTarget, extra = {}) {
      if (!collect) return { accepted: false, reason: 'collect-off' };
      const target = elOrTarget && elOrTarget.x != null && elOrTarget.y != null && !elOrTarget.getBoundingClientRect
        ? elOrTarget
        : centerPageNorm(elOrTarget, win);
      if (!target) return { accepted: false, reason: 'no-target' };
      return online.noteClick({
        target,
        source: extra.source || 'click',
        ts: extra.ts,
        features: extra.features || lastFeat || undefined,
      });
    },
    stats() {
      return { ...online.stats(), hasFeatures: !!lastFeat, collect };
    },
    /** 装点击监听（capture）。返回卸载函数。 */
    installClicks(targetDoc) {
      const d = targetDoc || doc;
      if (!d || clickOff) return clickOff;
      const handler = (ev) => {
        if (ev.defaultPrevented && !ev.isTrusted) return;
        if (ev.button != null && ev.button !== 0) return;
        const el = closestInteractive(ev.target, selector);
        if (!el) return; // 空白处：不是标签
        if (el.closest('[data-gaze-ignore]')) return;
        // capture 阶段取矩形：此时元素还没被切屏移除
        api.noteClick(el);
      };
      d.addEventListener('click', handler, true);
      clickOff = () => {
        d.removeEventListener('click', handler, true);
        clickOff = null;
      };
      return clickOff;
    },
    /** 装尺寸监视 + 提示。 */
    installGuard(container) {
      return installCompatGuard({
        getModel,
        getEnv: () => readEnv(win, opts.extraEnv ? opts.extraEnv() : null),
        container: container || doc && doc.body,
        onRefine: opts.onRefine,
        onRecalib: opts.onRecalib,
        enabled: opts.guard !== false,
        immediate: opts.immediateGuard === true,
      });
    },
    install(targetDoc, container) {
      const offClick = api.installClicks(targetDoc);
      const guard = api.installGuard(container);
      return {
        stop() {
          if (offClick) offClick();
          guard.stop();
        },
        guard,
      };
    },
    destroy() {
      if (clickOff) clickOff();
    },
  };

  return api;
}

export default createGazeLearning;
