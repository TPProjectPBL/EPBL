/**
 * @file 页面级「共享模型」桥（controller-demo / control-frontend / dual-test 共用）。
 *
 * 三个控制台页面原本各有一条 WebGazer 链路。接共享模型时只做三件事：
 *   1. 读 `epbl.gaze.model.v1`（store.js），有模型才走 shared；
 *   2. 自己开一路摄像头 + FaceLandmarker，用 AbsoluteGazeSource 出 PAGE_NORM；
 *   3. 通过 bus.js 订阅宿主广播，模型更新后热替换，不刷新页面。
 *
 * **单一模型源**：调用方在 shared 模式下必须停掉 WebGazer 的预测
 *（`clearGazeListener()` + `end()`），否则 WebGazer 的回归和共享模型同时往光标写，
 * 光标会抖成两套坐标的叠加。摄像头可以留着喂手势，但换成本桥的 video/canvas。
 *
 * @module shared/gaze/page-bridge
 */

import { STORE_KEYS, loadModel } from './store.js';
import { AbsoluteGazeSource } from './core/index.js';
import { createFaceEngine } from './engine/face-engine.js';
import { hello, onModel } from './bus.js';
import { errToPx } from './contract.js';

export { STORE_KEYS, errToPx };

/** 是否处在 iframe 里（工作台宿主内）。跨域拿不到 parent 时按 false 处理。 */
export const IN_FRAME = (() => {
  try {
    return !!(typeof window !== 'undefined' && window.parent && window.parent !== window);
  } catch {
    return false;
  }
})();

/**
 * 眼动来源。
 * - `?gaze=legacy` 永远优先，用于回归对比；
 * - 其余情况只要有共享模型就走 shared，没有就由页面决定回退。
 * @returns {'legacy'|'shared'}
 */
export function gazeMode() {
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('gaze') === 'legacy') return 'legacy';
  } catch {
    /* location 不可用（理论不会）→ 当作默认 */
  }
  return readSharedModel() ? 'shared' : 'legacy';
}

/** 同步缓存：primeSharedModel() 之后的模型实例。 */
let MODEL_CACHE = null;

/** 读共享模型实例（同步，仅返回已缓存或旧 localStorage 模型）。 */
export function readSharedModel() {
  if (MODEL_CACHE && MODEL_CACHE.ok) return MODEL_CACHE;
  try {
    const r = loadModel();
    return r.ok ? r.model : null;
  } catch {
    return null;
  }
}

/**
 * 从 IndexedDB（固定键 gaze_model）读取统一标定模型。
 * 协议要求子项目启动时走这里，而不是 localStorage。
 * @returns {Promise<object|null>}
 */
export async function primeSharedModel() {
  try {
    const idb = await import('./idb.js');
    const m = await idb.readPredictor();
    MODEL_CACHE = m || null;
    return MODEL_CACHE;
  } catch {
    MODEL_CACHE = null;
    return null;
  }
}

/**
 * 强制要求模型：读不到就回标定页（iframe 内先请求宿主）。
 * @param {{redirect?: boolean}} [opts]
 * @returns {Promise<object|null>}
 */
export async function requireSharedModel(opts = {}) {
  const m = await primeSharedModel();
  if (m) return m;
  const redirect = opts.redirect !== false;
  if (IN_FRAME && requestHostCalib()) return null;
  if (redirect) {
    try {
      location.replace(new URL('/workbench/index.html#/calibrate', location.href).href);
    } catch {
      /* 无法跳转时由页面自己提示 */
    }
  }
  return null;
}

/**
 * 请宿主导航标定（只在 iframe 内有效）。
 * @returns {boolean} 是否发出请求
 */
export function requestHostCalib() {
  if (!IN_FRAME) return false;
  try {
    window.parent.postMessage({ type: 'epbl:gaze-calib-request', version: 1 }, location.origin);
    return true;
  } catch {
    return false;
  }
}

/**
 * 订阅共享模型更新（按 sig 去重）。
 * @param {(model:object, msg:object) => void} onChange
 * @returns {() => void} 取消订阅
 */
export function subscribeModel(onChange) {
  const initial = readSharedModel();
  let lastSig = initial ? initial.sig || 'created:' + initial.created : '';
  try {
    hello();
  } catch {
    return () => {};
  }
  return onModel((msg) => {
    const m = readSharedModel();
    if (!m) return;
    const sig = (msg && msg.sig) || m.sig || 'created:' + m.created;
    if (sig === lastSig) return;
    lastSig = sig;
    try {
      onChange(m, msg);
    } catch {
      /* 回调异常不影响后续广播 */
    }
  });
}

/**
 * 起一路共享眼动：摄像头 → FaceLandmarker → AbsoluteGazeSource。
 *
 * 返回的 `video` / `canvas` 可直接交给手势识别（两者同尺寸、同一流、不重复开摄像头）。
 *
 * @param {object} [opts]
 * @param {(frame:{ok:boolean,landmarks:Array|null,point:{x:number,y:number,conf:number}|null,error:string}) => void} [opts.onFrame]
 * @param {number} [opts.pollMs=66] 检测间隔
 * @param {MediaStreamConstraints} [opts.constraints]
 * @returns {Promise<{video:HTMLVideoElement,canvas:HTMLCanvasElement,source:object,setModel:Function,getModel:Function,stop:Function}>}
 */
export async function startSharedGaze(opts = {}) {
  const {
    onFrame,
    pollMs = 66,
    constraints = {
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    },
  } = opts;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('no-camera-api');
  }

  const video = document.createElement('video');
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  // 保持 1×1 可见（display:none 会让部分浏览器暂停解码），但不影响布局
  video.style.cssText =
    'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1;';
  document.body.appendChild(video);

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = stream;
  // 不要 await play()：设备存在但不投帧时 play() 的 Promise 会一直挂着，
  // 整条启动链就卡死在「检测库加载中」。帧是否真的到，交给 tick 里的 videoWidth 判断。
  try {
    const p = video.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    /* 自动播放被拒也不影响后续轮询 */
  }

  const engine = await createFaceEngine();
  const source = new AbsoluteGazeSource();
  const m0 = readSharedModel();
  if (m0) source.setModel(m0);

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let closed = false;
  let timer = null;
  let appModel = m0;

  function cleanup() {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    try {
      video.srcObject = null;
      video.remove();
    } catch {
      /* ignore */
    }
    try {
      if (engine && typeof engine.close === 'function') engine.close();
    } catch {
      /* ignore */
    }
  }

  async function tick() {
    if (closed) return;
    try {
      if (!video.videoWidth) throw new Error('no-video-frame');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const res = await engine.push(canvas, performance.now());
      const lm = res && res.landmarks ? res.landmarks : null;
      const point = lm ? source.getPoint({ multiFaceLandmarks: [lm] }) : null;
      if (onFrame) onFrame({ ok: !!lm, landmarks: lm, point, error: '' });
    } catch (e) {
      if (onFrame) {
        onFrame({ ok: false, landmarks: null, point: null, error: (e && e.message) || String(e) });
      }
    }
    if (!closed) timer = setTimeout(tick, pollMs);
  }

  timer = setTimeout(tick, 0);

  return {
    video,
    canvas,
    source,
    setModel(m) {
      appModel = m && m.ok ? m : null;
      source.setModel(appModel);
    },
    getModel() {
      return appModel;
    },
    stop: cleanup,
  };
}

/**
 * PAGE_NORM → 本页 client px（整窗坐标）。
 * @param {{x:number,y:number}} p
 * @param {Window} [win]
 */
export function pageToClient(p, win) {
  const w = win || window;
  if (!p) return null;
  return { x: p.x * w.innerWidth, y: p.y * w.innerHeight };
}

/**
 * 统一误差口径：归一化 + 像素。
 *
 * - 归一化：以视口宽高为分母的欧氏距离（0..~1.4）
 * - 像素：`errToPx(err, w, h) = err * hypot(w, h)`（与 shared/gaze/contract.js 一致）
 *
 * @param {{x:number,y:number}} got 归一化坐标
 * @param {{x:number,y:number}} want 归一化坐标
 * @param {number} w 视口宽
 * @param {number} h 视口高
 * @returns {{norm:number,px:number}}
 */
export function errorPair(got, want, w, h) {
  if (!got || !want) return { norm: NaN, px: NaN };
  const norm = Math.hypot(got.x - want.x, got.y - want.y);
  return { norm, px: errToPx(norm, w, h) };
}

/** 便捷：把误差格式化成「3.2% / 41px」。 */
export function fmtErr(pair) {
  if (!pair || !Number.isFinite(pair.norm)) return '—';
  return `${(pair.norm * 100).toFixed(1)}% / ${Math.round(pair.px)}px`;
}

// classic script 用的全局出口（controller-demo 是 IIFE，不能直接 import）
if (typeof window !== 'undefined') {
  window.__epblPageBridge = {
    IN_FRAME,
    gazeMode,
    readSharedModel,
    primeSharedModel,
    requireSharedModel,
    requestHostCalib,
    subscribeModel,
    startSharedGaze,
    pageToClient,
    errorPair,
    fmtErr,
  };
}
