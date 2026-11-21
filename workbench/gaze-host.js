/* 工作台 · 统一视线标定入口 + 模型广播
 *
 * 约束：workbench 的 CSP 是 script-src 'self'，所以这里全部用本地模块动态 import，
 * 不引任何 CDN；样式只引用现有 CSS 变量，不新增布局规则。
 *
 * 暴露：window.__epblGazeHost = { getStatus, startCalib, cancel, getModel }
 */
(function () {
  'use strict';

  const SIM = /[?&]gazeSim=1(?:&|$)/.test(location.search);
  const POINTS = [
    [0.1, 0.12], [0.5, 0.12], [0.9, 0.12],
    [0.1, 0.5], [0.5, 0.5], [0.9, 0.5],
    [0.1, 0.88], [0.5, 0.88], [0.9, 0.88],
  ];
  const ENGINE = { name: 'mediapipe-face-landmarker', version: '478', landmarks: 478 };
  /** 构建号：改完代码 bump 一次，index.html 的 ?v= 跟着改，旧标签页一看 console 就知道版本。 */
  const BUILD = '20261121e';

  const S = {
    status: 'none',      // none | ok | stale
    model: null,
    raw: null,
    reason: '',
    busy: false,
    source: null,        // 'camera' | 'sim'
    cal: null,
    overlay: null,
    engine: null,
    stream: null,
    video: null,
    landmarks: null,
    lmId: 0,             // 每次真的拿到一帧（含「这一帧没有人脸」）自增
    lmAt: 0,             // 上一次拿到帧的时刻；标定据此判断摄像头是否还在出画面
    sim: null,
    raf: 0,
    panel: null,
    // 摄像头 / 推理单例
    cam: null,           // {video, stream, noFrame}
    faceEngine: null,
    inferTimer: 0,
    inferErr: '',
    inferRunning: false,
    gestureRunning: false,
    lastHandCount: -1,
    hidden: false,
    subs: 0,
    idleTimer: 0,
    exclusive: false,    // 某个模块声明自己独占摄像头
    gesture: null,
    // 工作台自身（首页/导航页）的视线订阅：不走 iframe，直接在宿主页面里用
    localSubs: new Set(),
    ovPhase: null,       // 覆盖层当前阶段：calib | validate
    ovBox: null,         // 整屏覆盖层容器（保证靶点坐标 = PAGE_NORM）
    calDone: null,       // 标定等待方（Promise resolve）
    gaze: null,          // {x,y,conf,ts} 页面归一化
  };

  const INFER_MS = 40;                    // ~25fps
  const IDLE_STOP_MS = 10 * 60 * 1000;    // 10 分钟无订阅者 → 关摄像头
  let BUS = null;
  let FEAT = null;
  const busMod = () => BUS || (BUS = import('../shared/gaze/bus.js?v=' + BUILD + ''));
  const featMod = () => FEAT || (FEAT = import('../shared/gaze/core/features.js?v=' + BUILD + ''));

  /** 轻量提示条（不新增 CSS 文件） */
  function notify(text) {
    let el = document.getElementById('gazeHostToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'gazeHostToast';
      el.style.cssText =
        'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:2147483002;' +
        'max-width:90vw;padding:8px 14px;border-radius:8px;font:13px/1.5 system-ui,sans-serif;' +
        'background:rgba(20,30,24,.94);color:#e9f0e6;border:1px solid #2a3a30;box-shadow:0 8px 24px rgba(0,0,0,.45)';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.display = 'block';
    clearTimeout(el.__t);
    el.__t = setTimeout(() => { el.style.display = 'none'; }, 2600);
  }

  const $ = (id) => document.getElementById(id);
  const stageEl = () => $('stage');

  /* ------------------------------------------------------------ 状态点 */

  const DOT_TEXT = {
    none: ['未标定', '点击「标定视线」开始'],
    ok: ['模型可用', '当前环境与标定时一致'],
    stale: ['模型过期', '环境变化或跳过了验证，请重新标定'],
  };

  function paintDot() {
    const d = $('gazeModelDot');
    if (d) {
      const info = DOT_TEXT[S.status] || DOT_TEXT.none;
      d.className = 'gaze-dot ' + S.status;
      d.title = info[0] + ' · ' + info[1];
      d.setAttribute('aria-label', info[0]);
    }
    // 页面外壳（导航 pill 等）据此刷新，不必轮询 getStatus()
    try {
      window.dispatchEvent(new CustomEvent('epbl:gaze-status', { detail: getStatus() }));
    } catch (e) {}
  }

  function currentEnv() {
    const v = S.video;
    // 没有打开的摄像头时不猜分辨率：否则「标定 1920×1080 → 释放摄像头 → 回落 1280×720」
    // 会被判成硬不兼容，模型一用完就显示过期。
    const cam = v && v.videoWidth ? { w: v.videoWidth, h: v.videoHeight } : null;
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
      camera: cam,
      engine: ENGINE,
      mirror: false,
    };
  }

  async function refreshStatus() {
    let idb;
    try {
      idb = await import('../shared/gaze/idb.js?v=' + BUILD + '');
    } catch (err) {
      S.status = 'none';
      S.reason = 'idb-unavailable';
      paintDot();
      return S.status;
    }
    let raw = null;
    try {
      raw = await idb.getGazeModel();
    } catch (err) {
      raw = null;
    }
    if (!raw || !raw.model || !raw.model.ok) {
      S.model = null;
      S.raw = null;
      S.status = 'none';
      S.reason = 'empty';
      paintDot();
      return S.status;
    }
    S.raw = raw;
    S.model = idb.toPredictor(raw);
    // 环境比对只做提示，不改模型本身：协议要求每次进入都重新标定
    const env = raw.env || null;
    const now = currentEnv();
    const viewDiff =
      !!(env && env.viewport && now.viewport &&
        (env.viewport.w !== now.viewport.w || env.viewport.h !== now.viewport.h));
    // 换摄像头 / 分辨率变化必须判过期：模型里的 aspect 绑定了标定时的采集画面。
    const camDiff =
      !!(env && env.camera && now.camera &&
        (env.camera.w !== now.camera.w || env.camera.h !== now.camera.h));
    const envDiff = viewDiff || camDiff;
    S.status = raw.skipped || envDiff ? 'stale' : 'ok';
    S.reason = raw.skipped
      ? 'validation-skipped'
      : camDiff
        ? 'camera-changed'
        : viewDiff
          ? 'env-changed'
          : 'exact';
    paintDot();
    return S.status;
  }

  /* ------------------------------------------------------------ 面板 */

  function hidePanel() {
    if (S.panel) {
      S.panel.remove();
      S.panel = null;
    }
  }

  function renderPanel(opts) {
    hidePanel();
    const wrap = document.createElement('div');
    wrap.id = 'gazeHostPanel';
    wrap.style.cssText =
      'position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,.45);padding:20px';

    const box = document.createElement('div');
    box.style.cssText =
      'max-width:440px;width:100%;background:var(--panel,#111a13);border:1px solid var(--line2,#2a3a30);' +
      'border-radius:12px;padding:18px 20px 16px;color:var(--txt,#e9f0e6);' +
      'font:13px/1.65 system-ui,-apple-system,"PingFang SC",sans-serif;box-shadow:0 18px 50px rgba(0,0,0,.55)';

    const title = document.createElement('div');
    title.textContent = opts.title;
    title.style.cssText = 'font-size:14.5px;font-weight:600;margin-bottom:8px';

    const body = document.createElement('p');
    body.textContent = opts.text;
    body.style.cssText = 'margin:0 0 14px;color:var(--dim,#8b9a8b)';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap';

    for (const [label, fn, kind] of opts.actions || []) {
      const b = document.createElement('button');
      b.className = 'btn' + (kind === 'ghost' ? ' ghost' : '');
      b.textContent = label;
      b.addEventListener('click', fn);
      row.appendChild(b);
    }

    box.appendChild(title);
    box.appendChild(body);
    box.appendChild(row);
    wrap.appendChild(box);
    document.body.appendChild(wrap);
    S.panel = wrap;
    return wrap;
  }

  function fail(code, text) {
    const err = new Error(text);
    err.code = code;
    return err;
  }

  function showFail(err) {
    const code = (err && err.code) || 'unknown';
    const text = (err && err.message) || '标定未完成，请重试';
    S.busy = false;
    S.reason = code;
    stopAll();
    renderPanel({
      title: '标定未完成',
      text: text,
      actions: [
        ['重试', () => { hidePanel(); startCalib(); }, 'ghost'],
        ['取消', () => { hidePanel(); paintDot(); }, 'ghost'],
      ],
    });
    return code;
  }

  /* ------------------------------------------------------------ 数据源 */

  function waitVideo(video, ms) {
    return new Promise((resolve) => {
      if (video.videoWidth > 0) return resolve(true);
      const t0 = performance.now();
      const tick = () => {
        if (video.videoWidth > 0) return resolve(true);
        if (performance.now() - t0 > ms) return resolve(false);
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  /**
   * 摄像头单例。工作台内所有模块共用这一路 {@link stream}，
   * 模块不再自己 getUserMedia。
   * @returns {Promise<{video:HTMLVideoElement, stream:MediaStream, noFrame:boolean}>}
   */
  async function ensureCamera() {
    if (S.cam && S.cam.stream && S.cam.video) return S.cam;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw fail('no-camera-api', '当前环境不支持摄像头采集（navigator.mediaDevices 缺失）。');
    }
    let stream;
    try {
      // Alexia 1080p 基线：双模态测试台 / 控制前端统一用 1920×1080。
      // 融合标定必须沿用同一采集分辨率，新摄像头接上后才能达到同样效果。
      // 设备不支持时 ideal 会让浏览器退到最接近档位（如 1280×720）。
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: 'user' },
        audio: false,
      });
    } catch (e) {
      const name = (e && e.name) || 'unknown';
      throw fail('camera-denied', '无法打开摄像头（' + name + '）。请检查系统权限、是否被其他程序占用，然后重试。');
    }
    const video = document.createElement('video');
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.style.cssText =
      'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.appendChild(video);
    video.srcObject = stream;
    S.cam = { video, stream, noFrame: false };
    S.stream = stream;
    S.video = video;
    try {
      const p = video.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) {
      /* 自动播放被拦：交给 waitVideo 判定 */
    }
    if (!(await waitVideo(video, 3000))) S.cam.noFrame = true;
    return S.cam;
  }

  /** FaceLandmarker 单例。 */
  async function ensureEngine() {
    if (S.faceEngine) return S.faceEngine;
    try {
      const mod = await import('../shared/gaze/engine/face-engine.js?v=' + BUILD + '');
      S.faceEngine = await mod.createFaceEngine({ refineLandmarks: true });
      S.engine = S.faceEngine;
      return S.faceEngine;
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/WebAssembly|Content Security Policy|unsafe-eval|wasm/i.test(msg)) {
        throw fail('csp-wasm', '人脸引擎初始化失败：当前 CSP 不允许 WebAssembly。');
      }
      throw fail('engine-init', '人脸引擎初始化失败：' + msg.slice(0, 160));
    }
  }

  /** 给摄像头/引擎启动加硬超时：避免无设备时标定页一直空等、既不标定也不报错。 */
  function withTimeout(promise, ms, reason, text) {
    let timer = 0;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail(reason, text)), ms);
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
  }

  async function ensureSource() {
    if (S.source && (S.source === 'sim' || S.stream)) return S.source;

    if (SIM) {
      const core = await import('../shared/gaze/core/index.js?v=' + BUILD + '');
      S.sim = core;
      S.source = 'sim';
      paintDot();
      return S.source;
    }

    const cam = await ensureCamera();
    if (cam.noFrame || !cam.video.videoWidth) {
      throw fail('no-video-frame', '摄像头已授权，但 3 秒内没有画面（设备未投帧）。请更换摄像头或刷新后重试。');
    }
    await ensureEngine();
    S.source = 'camera';
    return S.source;
  }

  /**
   * 模拟模式的一帧。simLandmarksFor 的人脸框只有 0.09 高，远小于真实摄像头（0.3~0.5），
   * 会让头位门控全部判无效；这里等比放大到真实量级，比值类特征不受影响。
   */
  function simFrame() {
    if (!S.sim) return null;
    const q = S.simTarget || { tx: 0.5, ty: 0.5 };
    const lm = S.sim.simLandmarksFor(q.tx, q.ty, 4 / 3, { noise: 0.004 });
    for (const p of lm) {
      p.x = 0.5 + (p.x - 0.5) * 2.6;
      p.y = 0.5 + (p.y - 0.5) * 2.6;
    }
    return lm;
  }

  /**
   * 把最新 landmarks 推进模型，结果分发给工作台自身的订阅者。
   * 模块 iframe 走 postMessage 总线；首页/导航页在同一文档里，直接回调最省。
   */
  async function pushLocalGaze(lm) {
    if (!S.localSubs.size || !lm || !S.model) return;
    try {
      const mod = await featMod();
      const f = mod.extractFeaturesMirrored(lm, (S.model && S.model.aspect) || aspect());
      if (!f) return;
      const p = S.model.predict(f);
      if (!p) return;
      S.gaze = { x: p.x, y: p.y, conf: p.conf, ts: performance.now() };
      for (const cb of S.localSubs) {
        try {
          cb(S.gaze);
        } catch (e) {}
      }
    } catch (e) {
      /* 单帧失败不影响推理循环 */
    }
  }

  function landmarksFor(q) {
    if (S.sim) {
      if (q && Number.isFinite(q.tx)) S.simTarget = { tx: q.tx, ty: q.ty };
      return simFrame();
    }
    return S.landmarks;
  }

  let faceBusy = false;
  /** 同一 FaceLandmarker 实例不能并发 push：标定与推理共用这一条队列。 */
  async function pushFrame(now) {
    if (faceBusy || !S.faceEngine || !S.video) return null;
    faceBusy = true;
    try {
      return await S.faceEngine.push(S.video, now);
    } finally {
      faceBusy = false;
    }
  }

  async function pump(now) {
    if (S.sim) {
      // 模拟模式没有 <video>：直接生成一帧，标定/推理/广播才都有数据可走
      S.landmarks = simFrame();
      S.lmId += 1;
      S.lmAt = now;
      return;
    }
    if (S.source !== 'camera' || !S.faceEngine || !S.video) return;
    // 摄像头没出帧时**保持原状**，由 lmAt 让标定识别「画面停了」；
    // 绝不能把旧 landmarks 当新帧继续累计进度。
    if (S.video.readyState < 2 || !S.video.videoWidth) return;
    let r = null;
    try {
      r = await pushFrame(now);
    } catch (e) {
      r = null;
    }
    // null = 引擎正忙/本帧被跳过，不是「没有人脸」，不要清空上一帧
    if (!r) return;
    S.landmarks = r.landmarks || null;
    S.lmId += 1;
    S.lmAt = now;
  }

  /* ------------------------------------------------------------ 通用小件 */

  const aspect = () => (S.video && S.video.videoWidth ? S.video.videoWidth / S.video.videoHeight : 4 / 3);

  function stopTick() {
    cancelAnimationFrame(S.raf);
    S.raf = 0;
    if (S.calTimer) {
      clearInterval(S.calTimer);
      S.calTimer = 0;
    }
  }

  /** rAF + 50ms 兜底定时器：后台标签被节流时标定也要往前走。 */
  function startLoop(step) {
    stopTick();
    const loop = (now) => {
      if (!S.raf) return;
      step(now);
      S.raf = requestAnimationFrame(loop);
    };
    S.raf = requestAnimationFrame(loop);
    S.calTimer = setInterval(() => {
      if (S.raf) step(typeof performance !== 'undefined' ? performance.now() : Date.now());
    }, 50);
  }

  function emitStage(stage, note) {
    try {
      window.dispatchEvent(new CustomEvent('epbl:gaze-stage', { detail: { stage, note: note || '' } }));
    } catch (e) {}
  }

  /* ------------------------------------------------------------ 标定流程 */

  /* ------------------------------------------------------------ 统一标定（协议 v2） */

  /**
   * 动态加载标定协议相关模块。
   * 工作台 CSP 为 script-src 'self'，全部走本地模块。
   */
  function loadCalibMods() {
    return Promise.all([
      import('../shared/gaze/calibrate/protocol.js?v=' + BUILD + ''),
      import('../shared/gaze/calibrate/session.js?v=' + BUILD + ''),
      import('../shared/gaze/calibrate/overlay.js?v=' + BUILD + ''),
      import('../shared/gaze/idb.js?v=' + BUILD + ''),
    ]);
  }

  /** 换掉覆盖层（9 点 ↔ 5 点验证）。容器必须是整屏，否则坐标与 PAGE_NORM 不一致。 */
  function mountOverlay(createOverlay, points, label) {
    if (S.overlay) {
      try { S.overlay.destroy(); } catch (e) {}
      S.overlay = null;
    }
    if (!S.ovBox) {
      S.ovBox = document.createElement('div');
      S.ovBox.style.cssText = 'position:fixed;inset:0;pointer-events:none';
      document.body.appendChild(S.ovBox);
    }
    const ov = createOverlay({
      container: S.ovBox,
      points,
      label,
      onCancel: () => backHome(),
    });
    ov.mount();
    S.overlay = ov;
    return ov;
  }

  /**
   * 统一标定入口：9 点强制标定 → 拟合 → 5 点验证。
   * 无跳过、无暂停；只有验证未通过时才有「重新标定 / 跳过」分支。
   */
  async function startCalib() {
    if (S.busy) return { ok: false, reason: 'busy' };
    if (!stageEl()) return { ok: false, reason: 'no-stage' };
    // 模拟模式没有真实摄像头帧，标定必须拒绝，避免产出「假模型」
    if (SIM) {
      showFail(fail('sim-mode', '当前是模拟模式（?gazeSim=1），没有真实摄像头帧，不能标定。请去掉该参数后刷新。'));
      return { ok: false, reason: 'sim-mode' };
    }

    S.busy = true;
    S.cancelled = false;
    hidePanel();
    stopInference();

    try {
      const [proto, sessMod, ovMod, idb] = await loadCalibMods();
      await withTimeout(
        ensureSource(),
        20000,
        'camera-timeout',
        '20 秒内没有拿到摄像头画面（设备被占用或未投帧）。请检查摄像头后刷新重试。',
      );
      if (S.cancelled) {
        stopAll();
        return { ok: false, reason: 'cancelled' };
      }

      emitStage('calib', '9 点标定 · 每点 1 秒');
      mountOverlay(ovMod.createOverlay, proto.CALIB_POINTS, '9 点标定 · 每点 1 秒');
      S.ovPhase = 'calib';

      const resume = !!(
        S.pending &&
        (S.pending.phase === 'calib' || S.pending.phase === 'validate' || S.pending.phase === 'ready')
      );
      const session = resume ? S.pending : sessMod.createSession({
        getLandmarks: () => S.landmarks,
        getAspect: aspect,
        // 只有真正的新帧才推进标定进度；摄像头停流时立即判「没有画面」
        getFrameId: () => S.lmId,
        getFrameAge: () => (S.lmAt ? performance.now() - S.lmAt : Infinity),
        onUpdate: (st) => {
          const want = st.phase === 'validate' || (st.phase === 'ready' && st.next === 'validate')
            ? 'validate'
            : 'calib';
          if (want !== S.ovPhase) {
            S.ovPhase = want;
            mountOverlay(
              ovMod.createOverlay,
              want === 'validate' ? proto.VALIDATE_POINTS : proto.CALIB_POINTS,
              want === 'validate' ? '验证准确率 · 5 点各 1 秒' : '9 点标定 · 每点 1 秒',
            );
          }
          if (!S.overlay) return;
          // 小窗里直接画摄像头画面：虚线标准框 + 实时头框
          S.overlay.setHead(st.head ? { ...st.head, video: S.video } : null);
          S.overlay.update({
            phase: st.phase,
            idx: st.idx,
            total: want === 'validate' ? proto.VALIDATE_POINTS.length : proto.CALIB_POINTS.length,
            pointProgress: st.pointProgress,
            progress: st.progress,
            gap: st.gap || 0,
            note: st.note || '',
            reason: st.reason || '',
            score: st.score,
          });
        },
        onDone: (model, report) => {
          stopTick();
          finishUnified(idb, model, report, false);
        },
        onReview: (report) => {
          stopTick();
          reviewUnified(idb, report);
        },
        onFail: (report) => {
          stopTick();
          showFail(fail('fit-failed', (report && report.reason) || '标定拟合失败，请重试。'));
        },
      });

      S.cal = session;
      if (resume) {
        S.pending = null;
        session.resume(performance.now());
      } else {
        session.start();
      }
      startLoop(calStep);

      return await new Promise((resolve) => {
        S.calDone = resolve;
      });
    } catch (e) {
      S.busy = false;
      return { ok: false, reason: showFail(e) };
    }
  }

  let calBusy = false;
  async function calStep(now) {
    if (!S.cal || calBusy) return;
    const phase = S.cal.phase;

    // 标定前：先出居中摄像头弹窗，头稳定了才 3-2-1；测试前直接倒计时
    if (phase === 'ready') {
      const testing = !!S.cal.model;
      if (S.overlay) S.overlay.setPrep(!testing);
      calBusy = true;
      try {
        await pump(now);
        if (S.cal) S.cal.update(now);
      } catch (e) {
        showFail(e);
        if (S.cal) {
          try { S.cal.abort(); } catch (err) {}
          S.cal = null;
        }
        stopTick();
        calBusy = false;
        return;
      } finally {
        calBusy = false;
      }
      if (!S.cal || S.cal.phase !== 'ready') return;
      if (!testing && !S.cal.state().ready) return;
      if (S.counting) return;

      S.counting = true;
      try {
        if (S.overlay) {
          await S.overlay.countdown(
            proto.COUNTDOWN_FROM,
            760,
            testing ? '准备好，接下来测 5 个点' : '头位已稳定 · 准备开始',
          );
        }
      } catch (e) {
        /* 倒计时失败也要能继续 */
      }
      S.counting = false;
      if (S.cal && S.cal.phase === 'ready') S.cal.go(performance.now());
      return;
    }

    if (S.overlay) S.overlay.setPrep(false);
    if (phase !== 'calib' && phase !== 'validate') return;
    calBusy = true;
    try {
      await pump(now);
      if (S.cal) S.cal.update(now);
    } catch (e) {
      showFail(e);
      if (S.cal) {
        try { S.cal.abort(); } catch (err) {}
        S.cal = null;
      }
      stopTick();
    } finally {
      calBusy = false;
    }
  }

  /** 验证未通过：只有「重新标定 / 跳过」两个出口。 */
  function reviewUnified(idb, report) {
    const score = report && Number.isFinite(report.score) ? report.score : 0;
    const pct = Number.isFinite(score) ? Math.round(score) + ' 分' : '—';
    emitStage('review', `正确率 ${pct} · 低于 ${report && report.passScore ? report.passScore : 60} 分`);
    renderPanel({
      title: '标定质量不佳',
      text:
        `5 点测试正确率 ${pct}（通过线 ${report && report.passScore ? report.passScore : 60} 分）。` +
        '建议重新标定：保持头部不动、眼睛看向每个圆点，直到进度走完。',
      actions: [
        [
          '重新标定',
          () => {
            hidePanel();
            if (!S.cal) return;
            S.cal.recalibrate();
            startLoop(calStep);
          },
        ],
        [
          '跳过',
          () => {
            hidePanel();
            finishUnified(idb, report.model, report, true);
          },
        ],
      ],
    });
  }

  /**
   * 落库：IndexedDB 固定键 gaze_model，每次覆盖写入。
   * @param {object} idb
   * @param {object} model  poly2 模型（纯 JSON）
   * @param {object} report 验证报告
   * @param {boolean} skipped 用户是否跳过验证
   */
  async function finishUnified(idb, model, report, skipped) {
    const avg = report && Number.isFinite(report.avgDist) ? report.avgDist : null;
    const score = report && Number.isFinite(report.score) ? report.score : null;
    const record = {
      schema: 2,
      sig: 'idb-' + Date.now(),
      createdAt: Date.now(),
      model,
      headRef: (report && report.headRef) || null,
      validation: {
        avgDist: avg,
        score,
        passScore: report ? report.passScore : 60,
        threshold: report ? report.threshold : 0.08,
        points: (report && report.points) || [],
        skipped: !!skipped,
      },
      env: currentEnv(),
      skipped: !!skipped,
    };

    try {
      await idb.putGazeModel(record);
    } catch (e) {
      showFail(fail('idb-write', '模型写入 IndexedDB 失败：' + ((e && e.message) || e)));
      if (S.calDone) {
        const r = S.calDone;
        S.calDone = null;
        r({ ok: false, reason: 'idb-write' });
      }
      return;
    }

    S.raw = record;
    S.model = idb.toPredictor(record);
    S.status = skipped ? 'stale' : 'ok';
    S.reason = skipped ? 'validation-skipped' : 'exact';
    paintDot();

    let sent = 0;
    try {
      const bus = await busMod();
      sent = bus.broadcastModel(record, { root: stageEl() });
    } catch (e) {
      /* 广播失败不影响落库 */
    }

    const text =
      `正确率 ${score != null ? Math.round(score) + ' 分' : '—'}` +
      (skipped ? ' · 已跳过测试' : ` · ${S.status === 'ok' ? '模型可用' : '建议重标'}`);
    if (S.overlay) {
      S.overlay.showResult({
        ok: !skipped,
        text: `正确率 ${score != null ? Math.round(score) + ' 分' : '—'}\n` +
          (skipped ? '已跳过测试，模型已保存' : S.status === 'ok' ? '模型已保存，可以开始使用' : '建议重新标定'),
        hud: skipped ? '已跳过测试' : '标定完成',
      });
    }
    emitStage('done', text);

    const done = {
      ok: true,
      status: S.status,
      sent,
      sig: record.sig,
      validation: {
        avg: avg,
        score,
        threshold: report ? report.threshold : 0.08,
        skipped: !!skipped,
      },
    };
    try {
      window.dispatchEvent(new CustomEvent('epbl:gaze-calibrated', { detail: done }));
    } catch (e) {}

    setTimeout(() => stopAll(), 2600);
    if (S.calDone) {
      const r = S.calDone;
      S.calDone = null;
      r(done);
    }
    return done;
  }

  /** 取消：收掉标定现场并让等待方拿到结果（不是流程内跳过）。 */
  /**
   * 回到首页：保留已完成的标定点，不销毁 session。
   * 用户点右上角「回到首页」时走这里；再次进入标定会从当前点继续。
   */
  function pauseCalib() {
    const r = S.calDone;
    S.calDone = null;
    stopTick();
    if (S.cal) {
      try {
        S.cal.pause();
        S.pending = S.cal;
      } catch (e) {
        S.pending = null;
      }
      S.cal = null;
    }
    S.ovPhase = null;
    if (S.overlay) {
      try {
        S.overlay.destroy();
      } catch (e) {}
      S.overlay = null;
    }
    if (S.ovBox) {
      try {
        S.ovBox.remove();
      } catch (e) {}
      S.ovBox = null;
    }
    S.counting = false;
    S.landmarks = null;
    S.busy = false;
    if (r) r({ ok: false, reason: 'paused' });
    return true;
  }

  /** 右上角「回到首页」：暂停标定并跳回首页。 */
  function backHome() {
    const pendingInfo = pendingProgress();
    pauseCalib();
    try {
      document.documentElement.setAttribute('data-gaze-pending', JSON.stringify(pendingInfo));
    } catch (e) {}
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'epbl:gaze-home' }, location.origin);
    } else {
      location.hash = '#/home';
    }
    return true;
  }

  /** 暂停中已完成的点数，供首页显示「继续标定」。 */
  function pendingProgress() {
    const s = S.pending;
    if (!s) return null;
    try {
      const st = s.state();
      return {
        phase: st.phase,
        idx: st.idx,
        total: st.total,
        valIdx: st.valIdx,
        samples: st.samples,
      };
    } catch (e) {
      return null;
    }
  }

  function cancelCalib() {
    const r = S.calDone;
    S.calDone = null;
    S.pending = null;
    stopAll();
    hidePanel();
    paintDot();
    if (r) r({ ok: false, reason: 'cancelled' });
    return true;
  }
  function stopAll(opts = {}) {
    S.cancelled = true;
    if (S.guideCancel) {
      try { S.guideCancel(); } catch (e) {}
      S.guideCancel = null;
    }
    stopTick();
    if (S.cal) {
      try { S.cal.abort(); } catch (e) {}
      S.cal = null;
    }
    S.ovPhase = null;
    if (S.overlay) {
      try {
        S.overlay.destroy();
      } catch (e) {}
      S.overlay = null;
    }
    if (S.ovBox) {
      try { S.ovBox.remove(); } catch (e) {}
      S.ovBox = null;
    }
    S.landmarks = null;
    S.busy = false;
    if (opts.release) releaseCamera();
  }

  function cancel() {
    return cancelCalib();
  }

  /** 外部查询：暂停中有没有未完成的标定。 */
  function getPending() {
    return pendingProgress();
  }

  /* ------------------------------------------------------------ 自检接口 */

  function getStatus() {
    return {
      status: S.status,
      hasModel: !!S.raw,
      sig: S.raw ? S.raw.sig : null,
      reason: S.reason,
      busy: S.busy,
      counting: !!S.counting,
      pending: !!S.pending,
      source: S.source,
      camera: !!S.cam,
      inference: S.inferRunning,
      subscribers: S.subs,
      exclusive: S.exclusive,
      hands: S.gestureRunning,
      inferErr: S.inferErr,
      localSubs: S.localSubs.size,
      gaze: S.gaze,
    };
  }

  function getModel() {
    return S.raw || null;
  }

  // 模块页（跑酷/画板/热力图）在 iframe 内点「标定」→ 由宿主统一发起
  window.addEventListener('message', (ev) => {
    if (ev.origin !== location.origin) return;
    const d = ev.data || {};
    if (d.type === 'epbl:gaze-calib-request') {
      startCalib();
      return;
    }
    // 仅模拟模式：让合成视线跟随模块当前的靶点
    if (d.type === 'epbl:gaze-sim-look' && SIM) {
      if (Number.isFinite(d.x) && Number.isFinite(d.y)) S.simTarget = { tx: d.x, ty: d.y };
      return;
    }
    // 模块声明「我要自己开摄像头做手势」：宿主停推理，不抢设备
    if (d.type === 'epbl:gaze-exclusive') {
      S.exclusive = !!d.on;
      if (S.exclusive) {
        // 真释放设备：有些平台不允许两路流同时打开，静默共存会两边都黑屏
        stopInference();
        releaseCamera();
        notify('模块声明独占摄像头，宿主已释放设备');
      } else {
        notify('模块已释放摄像头，宿主推理恢复');
        if (S.subs > 0) startInference();
      }
      return;
    }
    // 手势：引擎按需加载，加载后开始隔帧推理并广播手部结果（画板订阅）
    if (d.type === 'epbl:gaze-gesture-request') {
      if (d.on === false) {
        stopHands();
      } else {
        startHands().catch(() => notify('手势引擎加载失败（见控制台）'));
      }
    }
  });

  /** 工作台自身的视线订阅（首页/导航页用）。返回取消函数。 */
  function onGaze(cb) {
    if (typeof cb !== 'function') return () => {};
    S.localSubs.add(cb);
    if (S.localSubs.size === 1) startInference();
    armIdle();
    return () => offGaze(cb);
  }

  function offGaze(cb) {
    S.localSubs.delete(cb);
    if (!S.localSubs.size) S.gaze = null;
  }

  function getGaze() {
    return S.gaze;
  }

  /** 标定时的摄像头元素（宿主建的隐藏 video）；工作台把它挂成小预览窗。 */
  function getVideo() {
    return S.video || null;
  }

  console.info('[epbl-gaze] build', BUILD, SIM ? '(sim)' : '');

  window.__epblGazeHost = {
    build: BUILD,
    // 调试：看每个标定点采样到的特征与标签是否配对（只在标定中存在）
    debugSamples: () => (S.cal && S.cal.samples ? S.cal.samples.map((x) => ({
      tx: +x.tx.toFixed(3), ty: +x.ty.toFixed(3),
      dLx: x.f ? +x.f.dLx.toFixed(3) : null, dLy: x.f ? +x.f.dLy.toFixed(3) : null,
    })) : null),
    getStatus,
    onGaze,
    offGaze,
    getGaze,
    getVideo,
    startCalib,
    cancel,
    getModel,
    getPending,
    backHome,
    pause: pauseCalib,
    ensureCamera,
    ensureEngine,
    ensureGesture,
    startInference,
    stopInference,
    releaseCamera,
  };

  /* ------------------------------------------------------------ 宿主推理（模块订阅） */

  function releaseCamera() {
    stopInference();
    if (S.stream) {
      try {
        S.stream.getTracks().forEach((t) => t.stop());
      } catch (e) {}
    }
    S.stream = null;
    if (S.video) {
      try {
        S.video.srcObject = null;
        S.video.remove();
      } catch (e) {}
    }
    S.video = null;
    S.cam = null;
    if (S.faceEngine) {
      try {
        S.faceEngine.close();
      } catch (e) {}
    }
    S.faceEngine = null;
    S.engine = null;
  }

  function stopInference() {
    S.inferRunning = false;
    if (S.inferTimer) {
      clearTimeout(S.inferTimer);
      S.inferTimer = 0;
    }
  }

  /**
   * 开推理循环：每帧 FaceLandmarker → broadcastLandmarks。
   * 模块只在订阅时触发；没有订阅者不会空转。
   */
  function startInference() {
    if (S.inferTimer) return;
    if (S.hidden || S.exclusive) return;
    if (SIM) {
      // 模拟模式：没有摄像头/引擎，直接按节奏广播合成 landmarks
      S.inferRunning = true;
      let core = S.sim;
      const simLoop = async () => {
        S.inferTimer = 0;
        if (S.hidden || S.exclusive) {
          S.inferRunning = false;
          return;
        }
        if (!core) {
          try {
            core = await import('../shared/gaze/core/index.js?v=' + BUILD + '');
            S.sim = core;
            if (!S.source) S.source = 'sim';
          } catch (e) {
            S.inferErr = 'sim-init';
            return;
          }
        }
        const lm = simFrame();
        S.landmarks = lm;
        pushLocalGaze(lm);
        try {
          const bus = await busMod();
          bus.broadcastLandmarks(lm, { root: stageEl(), ts: performance.now() });
        } catch (e) {}
        if (!S.hidden && !S.exclusive) S.inferTimer = setTimeout(simLoop, INFER_MS);
      };
      simLoop();
      return;
    }
    // 不因 noFrame 直接放弃：循环里用 videoWidth 判断，设备恢复出帧时能自动接上
    ensureCamera()
      .then(() => ensureEngine())
      .then(() => {
        if (S.inferTimer || S.hidden || S.exclusive) return;
        S.inferRunning = true;
        const loop = async () => {
          S.inferTimer = 0;
          if (S.hidden || S.exclusive) { S.inferRunning = false; return; }
          const cam = S.cam;
          if (cam && cam.video && cam.video.videoWidth) {
            try {
              const r = await pushFrame(performance.now());
              const lm = r && r.landmarks ? r.landmarks : null;
              S.landmarks = lm;
              if (lm) {
                pushLocalGaze(lm);
                const bus = await busMod();
                bus.broadcastLandmarks(lm, { root: stageEl(), ts: performance.now() });
              }
            } catch (e) {
              S.inferErr = (e && e.message) || 'infer';
            }
          }
          if (!S.hidden && !S.exclusive) S.inferTimer = setTimeout(loop, INFER_MS);
        };
        loop();
      })
      .catch((e) => {
        S.inferErr = (e && e.code) || 'infer-init';
      });
  }

  function armIdle() {
    clearTimeout(S.idleTimer);
    S.idleTimer = setTimeout(() => {
      if (S.subs > 0) return;
      releaseCamera();
      notify('10 分钟没有模块使用视线，摄像头已关闭');
    }, IDLE_STOP_MS);
  }

  /** 手势引擎（懒加载；只有模块显式请求才初始化）。 */
  /** 手部推理节奏：12.5fps 足够（挥手判定有 280ms 窗口），给脸部让出余量。 */
  const HANDS_MS = 80;

  /** GestureRecognizer 结果 → bus 需要的扁平负载（每手 21 点 × 3）。 */
  function toHandsPayload(res) {
    const n = (res && res.landmarks && res.landmarks.length) || 0;
    const out = [];
    for (let i = 0; i < n; i++) {
      const pts = res.landmarks[i] || [];
      const flat = new Float32Array(pts.length * 3);
      for (let j = 0; j < pts.length; j++) {
        flat[j * 3] = pts[j].x || 0;
        flat[j * 3 + 1] = pts[j].y || 0;
        flat[j * 3 + 2] = pts[j].z || 0;
      }
      const g = res.gestures && res.gestures[i] && res.gestures[i][0];
      const hd = res.handedness && res.handedness[i] && res.handedness[i][0];
      out.push({
        points: flat,
        gesture: (g && g.categoryName) || 'None',
        gestureScore: g ? g.score : 0,
        handedness: (hd && hd.categoryName) || '',
        handednessScore: hd ? hd.score : 0,
      });
    }
    return out;
  }

  /**
   * 启动手部推理循环。
   * 与脸部共用同一路摄像头与同一个 `faceBusy` 串行锁：
   * GestureRecognizer 和 FaceLandmarker 读同一帧，但两个模型同时跑会互相拖慢。
   */
  async function startHands() {
    if (S.gestureRunning) return S.gesture;
    await ensureGesture();
    const cam = await ensureCamera();
    const video = cam && cam.video;
    if (!video) return null;
    S.gestureRunning = true;
    S.lastHandCount = -1;

    const loop = async () => {
      S.gestureTimer = 0;
      if (!S.gestureRunning) return;
      if (S.hidden || S.exclusive) {
        S.gestureTimer = setTimeout(loop, 600);
        return;
      }
      try {
        if (video.videoWidth > 0 && !S.faceBusy) {
          S.faceBusy = true;
          let res = null;
          try {
            res = await S.gesture.recognizeForVideo(video, performance.now());
          } finally {
            S.faceBusy = false;
          }
          const hands = toHandsPayload(res);
          // 手数从 0 → 0 时不重复广播，省掉大量空消息；出现/消失时必须广播
          if (hands.length || S.lastHandCount !== 0) {
            bus.broadcastHands(hands, { ts: Date.now() });
            S.lastHandCount = hands.length;
          }
          S.gestureErr = '';
        }
      } catch (e) {
        S.gestureErr = String((e && e.message) || e).slice(0, 120);
      }
      S.gestureTimer = setTimeout(loop, HANDS_MS);
    };
    loop();
    notify('手势引擎已就绪 · 手部结果开始广播');
    return S.gesture;
  }

  function stopHands() {
    S.gestureRunning = false;
    if (S.gestureTimer) {
      clearTimeout(S.gestureTimer);
      S.gestureTimer = 0;
    }
  }

  async function ensureGesture() {
    if (S.gesture) return S.gesture;
    const vision = await import('../draw/vendor/vision/vision_bundle.mjs?v=' + BUILD + '');
    const fileset = await vision.FilesetResolver.forVisionTasks('../draw/vendor/vision/wasm');
    S.gesture = await vision.GestureRecognizer.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: '../draw/models/gesture_recognizer.task' },
      runningMode: 'VIDEO',
      numHands: 2, // 与画板原实现一致（原来自己跑时就是双手）；单手会丢双笔能力
    });
    return S.gesture;
  }

  /* ------------------------------------------------------------ 事件绑定 */

  function bind() {
    const btn = $('gazeCalibBtn');
    // 统一走标定整屏：overlay 挂在 #stage 上，模块 iframe 会把它盖住
    if (btn) btn.addEventListener('click', () => { location.hash = '#/calibrate'; });

    // iframe 后加载：收到 hello 再回复当前模型（不主动推）
    busMod()
      .then((bus) => {
        bus.onHello(() => {
          if (S.raw) bus.broadcastModel(S.raw, { root: stageEl() });
        });
        // 订阅计数：>0 开推理；归零后 10 分钟关摄像头
        bus.onSubscribe(({ count }) => {
          S.subs = count;
          if (count > 0) {
            clearTimeout(S.idleTimer);
            startInference();
          } else {
            armIdle();
          }
        });
      })
      .catch(() => {});

    // 后台暂停推理，回前台自动恢复（不重新授权）
    document.addEventListener('visibilitychange', () => {
      S.hidden = document.hidden;
      if (S.hidden) stopInference();
      else if (S.subs > 0) startInference();
    });

    // 关标签页：尽快释放 track，让指示灯熄灭
    window.addEventListener('pagehide', () => releaseCamera());
    window.addEventListener('beforeunload', () => releaseCamera());

    // 模块切换后重新判定一次（摄像头尺寸/视口可能变了）
    window.addEventListener('hashchange', () => {
      setTimeout(() => refreshStatus(), 400);
    });
    window.addEventListener('resize', () => {
      if (S.busy) return;
      // 窗口尺寸变了要重新算兼容等级（只重画状态点会让 pill 一直停在旧结论）
      clearTimeout(S.resizeT);
      S.resizeT = setTimeout(() => { refreshStatus(); }, 320);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      bind();
      refreshStatus();
    });
  } else {
    bind();
    refreshStatus();
  }
})();
