/**
 * @file workbench ⇄ 模块 iframe 的视线模型 / 视线点总线。
 *
 * 协议（全部同源，`event.origin === location.origin` 才处理）：
 *
 * ```js
 * { type:'epbl:gaze-hello', version:1 }                       // iframe → host：我准备好了
 * { type:'epbl:gaze-model', version:1, action:'updated', sig } // host → iframe：模型已更新
 * { type:'epbl:gaze-frame', version:1, point:{x,y}, space }    // host → iframe：视线点
 * ```
 *
 * 关键约定：
 * - 宿主**不主动**推给尚未 hello 的 iframe；只有收到 hello 后才把它加入 ready 集合。
 * - `hello()` 由模块在启动时调用；宿主 `onHello()` 里可直接回复当前状态。
 * - 同源校验失败、消息缺 version、跨源 frame 一律忽略，不抛错。
 *
 * @module shared/gaze/bus
 */

export const BUS_VERSION = 1;

export const MSG = Object.freeze({
  model: 'epbl:gaze-model',
  frame: 'epbl:gaze-frame',
  hello: 'epbl:gaze-hello',
  landmarks: 'epbl:gaze-landmarks',
  hands: 'epbl:gaze-hands',
  subscribe: 'epbl:gaze-subscribe',
});

/** 已 hello 的 iframe window 集合（宿主侧用）。 */
const ready = new Set();
const listeners = {
  model: new Set(),
  frame: new Set(),
  hello: new Set(),
  landmarks: new Set(),
  hands: new Set(),
  subscribe: new Set(),
};

/** 正在要 landmarks 的 iframe window（宿主侧计数用）。 */
const subs = new Set();

let installed = false;

function sameOrigin(ev) {
  try {
    return !!ev && ev.origin === window.location.origin;
  } catch {
    return false;
  }
}

function emit(kind, data, ev) {
  for (const cb of listeners[kind]) {
    try {
      cb(data, ev);
    } catch (err) {
      /* 单个订阅者出错不影响其他订阅者 */
    }
  }
}

/** iframe 被换掉/关闭后，window 会 closed：从 ready 与 subs 里剔除，避免订阅计数虚高。 */
function pruneStale() {
  for (const w of Array.from(ready)) {
    try {
      if (w.closed) {
        ready.delete(w);
        subs.delete(w);
      }
    } catch {
      ready.delete(w);
      subs.delete(w);
    }
  }
}

function install() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('message', (ev) => {
    if (!sameOrigin(ev)) return;
    const d = ev.data;
    if (!d || typeof d !== 'object' || d.version !== BUS_VERSION) return;

    if (d.type === MSG.hello) {
      if (ev.source) ready.add(ev.source);
      pruneStale();
      emit('hello', d, ev);
    } else if (d.type === MSG.model) {
      emit('model', d, ev);
    } else if (d.type === MSG.frame) {
      emit('frame', d, ev);
    } else if (d.type === MSG.landmarks) {
      emit('landmarks', { landmarks: decodeLandmarks(d), ts: d.ts, n: d.n }, ev);
    } else if (d.type === MSG.hands) {
      emit('hands', { hands: decodeHands(d), ts: d.ts }, ev);
    } else if (d.type === MSG.subscribe) {
      pruneStale();
      if (d.active && ev.source) subs.add(ev.source);
      else if (ev.source) subs.delete(ev.source);
      emit('subscribe', { count: subs.size, active: !!d.active }, ev);
    }
  });
}

/** 手部结果解码：21 点/手 → [{x,y,z}]，同时还原手势名与左右手。 */
function decodeHands(d) {
  const list = Array.isArray(d.hands) ? d.hands : [];
  return list.map((h) => {
    const flat = h && h.buf ? new Float32Array(h.buf, 0, h.n * 3) : null;
    const points = [];
    if (flat) {
      for (let i = 0; i < h.n; i++) {
        points.push({ x: flat[i * 3], y: flat[i * 3 + 1], z: flat[i * 3 + 2] });
      }
    }
    return {
      points,
      gesture: h.gesture || 'None',
      gestureScore: Number(h.gestureScore) || 0,
      handedness: h.handedness || '',
      handednessScore: Number(h.handednessScore) || 0,
    };
  });
}

/**
 * 订阅宿主的手部结果（landmarks + 手势分类）。
 * 与 landmarks 不同，它不参与宿主推理循环的启停计数：宿主只在有人请求时才推理。
 */
export function onHands(cb) {
  install();
  listeners.hands.add(cb);
  // 宿主只会推给「打过招呼」的 iframe：订阅即 hello（幂等）
  if (typeof window !== 'undefined' && window.parent && window.parent !== window) hello();
  return () => {
    listeners.hands.delete(cb);
  };
}

/**
 * 宿主 → iframe：广播手部结果。
 * 每个 iframe 单独分配 buffer（transfer 后原 buffer 失效，不能共用一份）。
 *
 * @param {Array<{points: Array|Float32Array, gesture?: string, gestureScore?: number, handedness?: string, handednessScore?: number}>} hands
 */
export function broadcastHands(hands, opts = {}) {
  install();
  const list = Array.isArray(hands) ? hands : [];
  if (!list.length) return 0;
  const scope = scopeWindows(opts.root);
  if (!scope.size) return 0;
  const ts = opts.ts || Date.now();
  let sent = 0;
  for (const w of Array.from(ready)) {
    if (!scope.has(w)) {
      ready.delete(w);
      subs.delete(w);
      continue;
    }
    try {
      const payload = list.map((h) => {
        const pts = h && h.points ? h.points : [];
        const n = Math.floor(pts.length / 3);
        const flat = new Float32Array(n * 3);
        for (let i = 0; i < n * 3; i++) flat[i] = Number(pts[i]) || 0;
        return {
          buf: flat.buffer,
          n,
          gesture: h.gesture || 'None',
          gestureScore: Number(h.gestureScore) || 0,
          handedness: h.handedness || '',
          handednessScore: Number(h.handednessScore) || 0,
        };
      });
      const transfer = payload.map((p) => p.buf);
      w.postMessage({ type: MSG.hands, version: BUS_VERSION, ts, hands: payload }, window.location.origin, transfer);
      sent += 1;
    } catch {
      ready.delete(w);
      subs.delete(w);
    }
  }
  return sent;
}

/* ------------------------------------------------------------------ 模块侧 */

/**
 * 向父窗口打招呼。宿主收到后才会开始推送。
 * @returns {boolean} 是否真的发出（顶层页面无父窗口时返回 false）
 */
export function hello() {
  install();
  if (typeof window === 'undefined') return false;
  const parent = window.parent;
  if (!parent || parent === window) return false;
  try {
    parent.postMessage({ type: MSG.hello, version: BUS_VERSION }, window.location.origin);
    return true;
  } catch {
    return false;
  }
}

/**
 * 订阅模型更新。
 * @param {(msg:{type:string,version:number,action:string,sig:string|null}) => void} cb
 * @returns {() => void} 取消订阅
 */
export function onModel(cb) {
  install();
  listeners.model.add(cb);
  return () => listeners.model.delete(cb);
}

/**
 * 订阅视线点。
 * @param {(msg:{type:string,version:number,point:{x:number,y:number},space?:string}) => void} cb
 * @returns {() => void}
 */
export function onFrame(cb) {
  install();
  listeners.frame.add(cb);
  return () => listeners.frame.delete(cb);
}

/** 把宿主广播过来的 Float32Array buffer 还原成 [{x,y,z}]。 */
function decodeLandmarks(d) {
  if (!d || !d.buf || !d.n) return null;
  const f = new Float32Array(d.buf);
  const out = new Array(d.n);
  for (let i = 0; i < d.n; i++) {
    out[i] = { x: f[i * 3], y: f[i * 3 + 1], z: f[i * 3 + 2] };
  }
  return out;
}

/**
 * 订阅宿主推理出来的 landmarks（iframe 侧）。
 * 第一次订阅会向宿主发 `epbl:gaze-subscribe {active:true}`，宿主据此决定是否开推理。
 * @param {(frame:{landmarks:Array<{x:number,y:number,z:number}>, ts:number, n:number}) => void} cb
 * @returns {() => void} unsubscribe（最后一个订阅者取消时会通知宿主停推理）
 */
export function onLandmarks(cb) {
  install();
  listeners.landmarks.add(cb);
  // 宿主只推给「打过招呼」的 iframe：订阅即 hello（幂等），否则订阅者永远收不到帧
  if (typeof window !== 'undefined' && window.parent && window.parent !== window) hello();
  if (!subSent && typeof window !== 'undefined' && window.parent && window.parent !== window) {
    subSent = true;
    postToHost({ active: true });
  }
  return () => {
    listeners.landmarks.delete(cb);
    if (!listeners.landmarks.size && subSent) {
      subSent = false;
      postToHost({ active: false });
    }
  };
}

let subSent = false;
function postToHost(data) {
  try {
    window.parent.postMessage(
      { type: MSG.subscribe, version: BUS_VERSION, ...data },
      window.location.origin
    );
  } catch {
    /* 跨源或宿主不存在：静默 */
  }
}

/* ------------------------------------------------------------------ 宿主侧 */

/**
 * 订阅 iframe 的 hello。
 * @param {(msg:object, ev:MessageEvent) => void} cb
 * @returns {() => void}
 */
export function onHello(cb) {
  install();
  listeners.hello.add(cb);
  return () => listeners.hello.delete(cb);
}

function scopeWindows(root) {
  const out = new Set();
  if (typeof document === 'undefined') return out;
  const host = root || document.getElementById('stage') || document;
  let frames = [];
  try {
    frames = Array.from(host.querySelectorAll('iframe'));
  } catch {
    frames = [];
  }
  for (const f of frames) {
    let w = null;
    try {
      w = f.contentWindow;
    } catch {
      w = null;
    }
    if (w) out.add(w);
  }
  return out;
}

function postToReady(msg, root) {
  const scope = scopeWindows(root);
  if (!scope.size) return 0;
  let sent = 0;
  for (const w of Array.from(ready)) {
    if (!scope.has(w)) {
      ready.delete(w); // iframe 已卸载
      continue;
    }
    try {
      w.postMessage(msg, window.location.origin);
      sent += 1;
    } catch {
      ready.delete(w);
    }
  }
  return sent;
}

/**
 * 广播模型更新（只发给已 hello 的 iframe）。
 * @param {object|null} model 模型实例或 `{sig}` 对象
 * @param {{root?: Element}} [opts] 限定广播范围，默认 `#stage`
 * @returns {number} 实际发送的 iframe 数量
 */
export function broadcastModel(model, opts = {}) {
  install();
  const sig = model && (model.sig || (model.raw && model.raw.sig) || null);
  return postToReady(
    { type: MSG.model, version: BUS_VERSION, action: 'updated', sig: sig || null },
    opts.root
  );
}

/**
 * 广播视线点（只发给已 hello 的 iframe）。
 * @param {{x:number,y:number,space?:'page'|'client'|'container'}} point
 * @param {{root?: Element}} [opts]
 * @returns {number}
 */
export function broadcastFrame(point, opts = {}) {
  install();
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return 0;
  return postToReady(
    {
      type: MSG.frame,
      version: BUS_VERSION,
      point: { x: point.x, y: point.y },
      space: point.space || 'page',
    },
    opts.root
  );
}

/**
 * 广播 landmarks（只发给已 hello 的 iframe；每个 iframe 单独一份 transferable）。
 * 476 点 × 3 分量 ≈ 5.7KB/帧，比传图像小两个数量级。
 * @param {Array<{x:number,y:number,z:number}>} landmarks
 * @param {{root?: Element, ts?: number}} [opts]
 * @returns {number} 实际发送的 iframe 数量
 */
export function broadcastLandmarks(landmarks, opts = {}) {
  install();
  if (!landmarks || !landmarks.length) return 0;
  const scope = scopeWindows(opts.root);
  if (!scope.size) return 0;
  const ts = opts.ts || Date.now();
  const n = landmarks.length;
  let sent = 0;
  for (const w of Array.from(ready)) {
    if (!scope.has(w)) {
      ready.delete(w);
      subs.delete(w);
      continue;
    }
    try {
      const flat = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const p = landmarks[i] || {};
        flat[i * 3] = p.x || 0;
        flat[i * 3 + 1] = p.y || 0;
        flat[i * 3 + 2] = p.z || 0;
      }
      w.postMessage(
        { type: MSG.landmarks, version: BUS_VERSION, ts, n, buf: flat.buffer },
        window.location.origin,
        [flat.buffer]
      );
      sent += 1;
    } catch {
      ready.delete(w);
      subs.delete(w);
    }
  }
  return sent;
}

/**
 * 订阅「iframe 开始/停止要 landmarks」事件（宿主侧）。
 * @param {(e:{count:number, active:boolean}) => void} cb
 * @returns {() => void}
 */
export function onSubscribe(cb) {
  install();
  listeners.subscribe.add(cb);
  return () => listeners.subscribe.delete(cb);
}

/** 宿主侧：当前有多少 iframe 在要 landmarks。 */
export function subscribeCount() {
  return subs.size;
}

/** 调试：当前已 hello 的 iframe 数量。 */
export function readyCount() {
  return ready.size;
}

/* ------------------------------------------------------------------ 全局暴露 */

// 供 classic script（如热力图 app.js）使用；ESM 调用方仍可直接 import
if (typeof window !== 'undefined') {
  window.__epblBus = {
    VERSION: BUS_VERSION,
    MSG,
    hello,
    onModel,
    onFrame,
    onLandmarks,
    onHands,
    onHello,
    onSubscribe,
    subscribeCount,
    broadcastModel,
    broadcastFrame,
    broadcastLandmarks,
    broadcastHands,
    readyCount,
  };
}
