/* 隔空控制器 · 工作台外壳
 * 职责：注册表渲染、hash 路由、iframe 懒加载 + 单实例互斥、下载中心、后端探活。
 * 不使用框架与构建工具；独立模块使用自己的本机服务。
 */
'use strict';

const REGISTRY_URL = 'modules.json';
const RELEASES_URL = 'releases.json';
const HEALTH_URL = 'http://127.0.0.1:8899/health';
const LS = { theme: 'ac.workbench.theme', last: 'ac.workbench.last' };

/** 顶栏导航用的短名，完整名称仍保留在 title 与模块注册表里。 */
const NAV_LABELS = {
  'dual-test': '测试台',
  'gaze-heatmap': '热力图',
  draw: '画板',
  'air-runner': '跑酷',
  releases: '下载',
};
const FRAME_ALLOW = 'camera; microphone; fullscreen; autoplay; clipboard-write; display-capture';

const state = {
  groups: [],
  modules: [],
  active: null,
  registry: {},
  healthTimer: null,
};

const byId = (id) => document.getElementById(id);

/* ---------------- 初始化 ---------------- */
init();

async function init() {
  applyTheme(localStorage.getItem(LS.theme) || 'dark');
  bindShell();

  try {
    const res = await fetch(REGISTRY_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const reg = await res.json();
    state.registry = reg;
    state.groups = Array.isArray(reg.groups) ? reg.groups : [];
    state.modules = Array.isArray(reg.modules) ? reg.modules : [];
    if (!state.modules.length) throw new Error('注册表为空');
    renderNav();
    route();
  } catch (err) {
    showEmpty('模块注册表加载失败', '无法读取 ' + REGISTRY_URL + '：' + err.message);
  }

  checkBackend();
  state.healthTimer = setInterval(checkBackend, 15000);

  window.addEventListener('hashchange', route);
}

/* ---------------- 外壳交互 ---------------- */
function bindShell() {
  byId('homeBtn').addEventListener('click', () => {
    location.hash = '#/home';
  });
  byId('themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  });
  byId('reloadBtn').addEventListener('click', () => {
    const mod = currentModule();
    if (!mod) return;
    activate(mod, { force: true });
  });
  byId('openBtn').addEventListener('click', () => {
    const mod = currentModule();
    if (mod) window.open(mod.standaloneUrl || mod.path, '_blank', 'noopener');
  });
  byId('backBtn').addEventListener('click', () => {
    location.hash = '#/home';
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const v = document.body.dataset.view;
    if (v === 'nav' || v === 'calibrate' || v === 'module' || v === 'releases') {
      location.hash = '#/';
    }
  });
  // 键盘焦点可能停留在外层工作台（眼控/手势用户常不点 iframe），
  // 模块页收不到按键。把画板快捷键转发给当前 iframe，避免“必须先用鼠标点一下”。
  const FORWARD_KEY_RE = /^(?:[1-6 ]|[cCbBeEpPgGhHvVzZrRtT])$/;
  function forwardKeyToFrame(e, eventType) {
    if (document.body.dataset.view !== 'module') return;
    if (e.key === 'Escape') return;   // Escape 由工作台自己处理，避免重复退出
    const target = e.target;
    if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
    if (!FORWARD_KEY_RE.test(e.key) && e.code !== 'Space') return;
    const frame = byId('stage').querySelector('iframe.frame');
    if (!frame || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage({
        type: 'epbl:forward-key',
        eventType,
        key: e.key,
        code: e.code || '',
        metaKey: !!e.metaKey,
        ctrlKey: !!e.ctrlKey,
        shiftKey: !!e.shiftKey,
        altKey: !!e.altKey,
        repeat: !!e.repeat
      }, '*');
      e.preventDefault();
    } catch (_) { /* iframe 尚未就绪时忽略 */ }
  }
  window.addEventListener('keydown', (e) => forwardKeyToFrame(e, 'keydown'));
  window.addEventListener('keyup', (e) => forwardKeyToFrame(e, 'keyup'));
  // 宿主标定完成 → 自动进导航页；失败则退回首页说明原因
  window.addEventListener('epbl:gaze-calibrated', (ev) => {
    const ok = !!(ev.detail && ev.detail.ok);
    if (ok) {
      // 本次页面会话已标定：后续在同一会话内切换空间不再强制重标；
      // 刷新页面会话结束 → 标记清空 → 下次进入重新强制 9 点标定。
      try {
        sessionStorage.setItem('epbl.gaze.calibrated', '1');
      } catch (_) {}
    }
    if (document.body.dataset.view !== 'calibrate') return;
    setTimeout(() => {
      if (document.body.dataset.view !== 'calibrate') return;
      location.hash = ok ? '#/home' : '#/';
    }, 1500);
  });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(LS.theme, theme);
  const btn = byId('themeBtn');
  if (btn) btn.textContent = theme === 'dark' ? '☀' : '☾';
}

function currentModule() {
  return state.modules.find((m) => m.id === state.active) || null;
}

/* ---------------- 顶栏导航（不分组，全部压在顶栏一条） ---------------- */
function renderNav() {
  const nav = byId('topnav');
  nav.textContent = '';

  state.modules.forEach((mod) => nav.appendChild(navItem(mod)));
  nav.appendChild(navItem({
    id: 'releases',
    name: '下载控制小窗',
    desc: 'DMG 安装包与安装指引',
    capabilities: [],
    requires: [],
  }, true));
}

function navItem(mod, isReleases = false) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'nav-item';
  btn.dataset.id = mod.id;
  if ((mod.capabilities || []).includes('camera')) btn.dataset.cap = 'camera';
  btn.title = mod.desc ? mod.name + ' — ' + mod.desc : mod.name;

  const text = document.createElement('span');
  text.className = 't';
  text.textContent = NAV_LABELS[mod.id] || mod.name;
  btn.appendChild(text);

  if ((mod.requires || []).includes('cdn')) btn.appendChild(tag('CDN', 'cdn'));
  if ((mod.capabilities || []).includes('camera')) btn.appendChild(tag('CAM'));

  const dot = document.createElement('span');
  dot.className = 'd';
  btn.appendChild(dot);

  btn.addEventListener('click', () => {
    const target = '#/' + mod.id;
    if (location.hash === target) route();
    else location.hash = target;
  });

  if (isReleases) btn.dataset.releases = '1';
  return btn;
}

function tag(text, extra) {
  const el = document.createElement('span');
  el.className = 'tag' + (extra ? ' ' + extra : '');
  el.textContent = text;
  return el;
}

function markActive(id) {
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.id === id);
  });
}

/* ---------------- 路由 ---------------- */
function route() {
  const hash = decodeURIComponent(location.hash.replace(/^#\/?/, '')).trim();

  // 标定 overlay 挂在 body 上，换路由不会自动收：离开标定屏只暂停、不清已完成的点，
  // 这样右上角「回到首页」之后还能从原进度继续。
  if (hash !== 'calibrate' && window.__epblGazeHost) {
    try {
      if (window.__epblGazeHost.pause) window.__epblGazeHost.pause();
    } catch (_) {}
  }

  if (hash === '') return showLanding();
  if (hash === 'calibrate') return showCalibrate();

  const mod = state.modules.find((m) => m.id === hash);
  // 独立模块在自己的页面内标定。
  if (mod?.standaloneUrl) return activate(mod);

  // 依赖宿主标定的空间须先完成本次会话标定。
  const calibrated = (() => {
    try {
      return sessionStorage.getItem('epbl.gaze.calibrated') === '1';
    } catch (_) {
      return false;
    }
  })();
  if (!calibrated && hash !== 'home') {
    history.replaceState(null, '', '#/calibrate');
    return showCalibrate();
  }

  if (hash === 'home') return showHome();
  if (hash === 'releases') {
    showReleases();
    return;
  }

  if (!mod) {
    // 未知路由不猜模块：回首页，避免地址栏乱写就进了某个项目
    showLanding();
    return;
  }
  activate(mod);
}

/* ---------------- iframe 生命周期（单实例互斥） ---------------- */
function teardownFrame({ standaloneCamera = false } = {}) {
  const stage = byId('stage');
  const frame = stage.querySelector('iframe.frame');
  if (frame) {
    /* 先置空再移除：确保文档卸载、getUserMedia 轨道立即释放 */
    try { frame.src = 'about:blank'; } catch (_) {}
    frame.remove();
  }
  stage.querySelectorAll('.loading, .empty').forEach((n) => n.remove());
  state.active = null;
  window.__epblGazeHost?.setStandaloneCamera?.(standaloneCamera);
}

function activate(mod, { force = false } = {}) {
  if (!force && state.active === mod.id && byId('stage').querySelector('iframe.frame')) return;

  setView('module', { standalone: !!mod.standaloneUrl });
  teardownFrame({ standaloneCamera: !!mod.standaloneUrl });
  byId('stage').replaceChildren();
  state.active = mod.id;
  localStorage.setItem(LS.last, mod.id);
  markActive(mod.id);
  renderModuleBar(mod);

  const stage = byId('stage');
  const loading = document.createElement('div');
  loading.className = 'loading';
  const spin = document.createElement('span');
  spin.className = 'spinner';
  loading.appendChild(spin);
  loading.appendChild(Object.assign(document.createElement('span'), { textContent: '正在加载 ' + mod.name + ' …' }));
  stage.appendChild(loading);

  const frame = document.createElement('iframe');
  frame.className = 'frame';
  frame.title = mod.name;
  frame.setAttribute('allow', mod.standaloneUrl ? 'camera' : FRAME_ALLOW);
  frame.src = mod.standaloneUrl || mod.path;

  let settled = false;
  const slow = setTimeout(() => {
    if (settled) return;
    loading.lastChild.textContent = '加载较慢，仍在等待 ' + mod.name + ' …';
  }, 8000);

  frame.addEventListener('load', () => {
    settled = true;
    clearTimeout(slow);
    loading.remove();
    detectFrameError(frame, mod);
  });

  stage.appendChild(frame);
}

function detectFrameError(frame, mod) {
  let text = '';
  try {
    const doc = frame.contentDocument;
    text = doc && doc.body ? (doc.body.innerText || '').slice(0, 400) : '';
  } catch (_) {
    return; /* 跨域时无法检测，交给模块自身报错 */
  }
  if (/error response|file not found|404/i.test(text)) {
    showEmpty(
      '无法加载「' + mod.name + '」',
      '请确认文件存在：' + mod.path + '（当前由 127.0.0.1:8125 提供静态服务）'
    );
  }
}

function renderModuleBar(mod) {
  const rail = byId('rightbar');
  rail.hidden = false;
  byId('crumb').textContent = mod.name;
}

/* ---------------- 右侧栏摄像头预览 ----------------
 * 直接镜像绘制宿主那一路 video（__epblGazeHost.getVideo()），
 * 与标定时看到的是同一个画面。不移动 video 元素本身，标定链路不受影响。
 * video 是异步创建的（模块订阅视线后才 ensureCamera），所以循环每帧重新取。
 */
let railCamTimer = 0;
function startRailCamera() {
  stopRailCamera();
  const canvas = byId('rbCamCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const cw = canvas.width, ch = canvas.height;
  const box = canvas.parentElement;
  const foot = byId('rbCamFoot');
  // 用 setInterval 而非 rAF：摄像头 30fps 足够，且后台/无头标签也能持续刷新，
  // 不会像 rAF 那样被浏览器节流导致预览停在旧帧。
  const tick = () => {
    let v = null;
    try {
      const host = window.__epblGazeHost;
      if (host && typeof host.getVideo === 'function') v = host.getVideo();
    } catch (_) {}
    if (!v || !v.videoWidth || v.readyState < 2) {
      box.classList.remove('has-video');
      if (foot) foot.textContent = '与标定同一路画面';
      return;
    }
    box.classList.add('has-video');
    if (foot) foot.textContent = '摄像头已连接 · 镜像预览';
    // cover 填充：按较大比例缩放后居中裁切，避免 4:3 摄像头被拉变形
    const vw = v.videoWidth, vh = v.videoHeight;
    const scale = Math.max(cw / vw, ch / vh);
    const dw = vw * scale, dh = vh * scale;
    ctx.drawImage(v, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
  };
  tick();
  railCamTimer = setInterval(tick, 40); // ~25fps，足够预览且不吃 CPU
}
function stopRailCamera() {
  if (railCamTimer) { clearInterval(railCamTimer); railCamTimer = 0; }
  const box = document.querySelector('.rb-cam-box');
  if (box) box.classList.remove('has-video');
}

function showEmpty(title, detail) {
  const stage = byId('stage');
  stage.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'empty';
  const inner = document.createElement('div');
  inner.className = 'empty-inner';
  const h = document.createElement('h2');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = detail;
  const hint = document.createElement('p');
  hint.innerHTML = '';
  const code = document.createElement('code');
  code.textContent = 'python3 -m http.server 8125 --bind 127.0.0.1';
  hint.appendChild(code);
  inner.append(h, p, hint);
  wrap.appendChild(inner);
  stage.appendChild(wrap);
}


/* ---------------- 三段屏：首页 / 标定 / 空间导航 ---------------- */

const DWELL_MS = 1500;      // 视线在卡片上停满这么久就进入（圆环走满一圈）
const DWELL_DECAY = 1.8;    // 视线移开后进度回落倍率

const screens = { gazeOff: null, view: 'landing' };

/** 切换整页视图：landing | calibrate | nav | module */
function setView(view, { standalone = false } = {}) {
  document.body.dataset.view = view;
  byId('gazeCalibBtn').hidden = standalone;
  byId('gazeModelDot').hidden = standalone;
  screens.view = view;
  // 摄像头预览只在模块视图常驻；离开模块即停，省一个 rAF 循环
  if (view === 'module') startRailCamera();
  else stopRailCamera();
  if (screens.gazeOff) {
    screens.gazeOff();
    screens.gazeOff = null;
  }
  if (screens.statusOff) {
    screens.statusOff();
    screens.statusOff = null;
  }
  if (screens.stageOff) {
    screens.stageOff();
    screens.stageOff = null;
  }
  if (screens.calibVideo) {
    screens.calibVideo.classList.remove('calib-video');
    screens.calibVideo = null;
  }
}

function newScreen(className) {
  teardownFrame();
  const stage = byId('stage');
  stage.replaceChildren();
  byId('rightbar').hidden = true;
  const el = document.createElement('div');
  el.className = 'screen ' + className;
  stage.appendChild(el);
  return el;
}

/* ---------- 首页 ---------- */
function showLanding() {
  setView('landing');
  state.active = null;
  markActive(null);
  byId('crumb').textContent = '首页';
  if (location.hash !== '#/' && location.hash !== '') history.replaceState(null, '', '#/');

  const wrap = newScreen('landing');
  wrap.innerHTML = [
    '<div class="hero-glow" aria-hidden="true"></div>',
    '<div class="hero">',
    '  <span class="hero-badge">视线 · 手势 · 隔空操作</span>',
    '  <h1>隔空控制器</h1>',
    '  <p class="hero-sub">进入前先做 9 点标定：每点 1 秒，完成后 5 点验证。</p>',
    '  <button class="cta" id="ctaStart">开始 9 点标定</button>',
    '  <p class="hero-note">只在本机读取摄像头 · 不上传任何画面</p>',
    '</div>',
    '<div class="hero-foot">127.0.0.1:8125 · workbench</div>',
  ].join('\n');

  const cta = wrap.querySelector('#ctaStart');
  cta.addEventListener('click', () => { location.hash = '#/calibrate'; });
  byId('crumb').textContent = '首页';
}

/* ---------- 标定 ---------- */
async function showCalibrate() {
  setView('calibrate');
  state.active = null;
  markActive(null);
  byId('crumb').textContent = '标定';
  if (location.hash !== '#/calibrate') history.replaceState(null, '', '#/calibrate');

  const wrap = newScreen('calibrate');
  wrap.innerHTML = [
    '<div class="calib-head">',
    '  <h2>开始 9 点视线标定</h2>',
    '  <p>9 个标定点 + 5 个测试点，每个点 1 秒；点与点之间停 1 秒。开始前有 3-2-1 倒计时。</p>',
    '</div>',
    '<div class="calib-hint" id="calibHint"><span class="spinner"></span> 正在准备摄像头…</div>',
    '<button class="btn ghost calib-back" id="calibBack">回到首页</button>',
  ].join('\n');

  const hint = wrap.querySelector('#calibHint');
  const back = wrap.querySelector('#calibBack');

  // 宿主按阶段广播，页面只负责把当前该做什么写在同一行里
  const STAGE_TEXT = {
    guide: '① 调整坐姿：让整张脸落在虚线框里',
    'guide-ready': '① 就位完成，点「开始标定」',
    calib: '② 9 点标定：盯住圆点 1 秒，不要让头离开虚线框',
    validate: '③ 5 点测试：继续盯住圆点，每点固定 1 秒',
    review: '③ 正确率未达标：选择重新标定或跳过',
    validated: '④ 测试完成',
    done: '标定完成，正在返回导航',
  };
  const onStage = (e) => {
    const d = (e && e.detail) || {};
    const t = STAGE_TEXT[d.stage];
    if (t) {
      hint.classList.remove('bad');
      hint.textContent = d.stage === 'validated' && d.note ? `${t}：${d.note}` : t;
    }
    // overlay 接管整屏时页面自己的标题/按钮必须退场
    if (d.stage === 'calib') {
      wrap.classList.add('calib-live');
      try {
        const v = window.__epblGazeHost && window.__epblGazeHost.getVideo && window.__epblGazeHost.getVideo();
        if (v) {
          v.classList.add('calib-video');
          screens.calibVideo = v;
        }
      } catch (_) {}
    } else if (d.stage === 'validated' || d.stage === 'done') {
      wrap.classList.remove('calib-live');
    }
  };
  window.addEventListener('epbl:gaze-stage', onStage);
  screens.stageOff = () => window.removeEventListener('epbl:gaze-stage', onStage);
  back.addEventListener('click', () => {
    try {
      if (window.__epblGazeHost && window.__epblGazeHost.backHome) {
        window.__epblGazeHost.backHome();
        return;
      }
      if (window.__epblGazeHost) window.__epblGazeHost.pause();
    } catch (_) {}
    location.hash = '#/home';
  });

  // app.js 先于 gaze-host.js 起跑：等宿主挂到 window 上再发起标定
  const t0 = performance.now();
  while (!window.__epblGazeHost) {
    if (performance.now() - t0 > 3000) break;
    await new Promise((r) => setTimeout(r, 60));
  }
  if (!window.__epblGazeHost) {
    hint.classList.add('bad');
    hint.textContent = '视线宿主没有加载，无法标定。';
    return;
  }

  const r = await window.__epblGazeHost.startCalib();
  if (r && (r.reason === 'cancelled' || r.reason === 'paused')) return;
  if (r && r.ok) return;
  const el = byId('calibHint');
  if (el) {
    el.classList.add('bad');
    el.textContent = describeCalibError(r && r.reason);
  }
}

function describeCalibError(reason) {
  const map = {
    busy: '上一次标定还没结束，请稍等两秒再试。',
    'no-stage': '标定画布没有准备好，请刷新页面。',
    'no-camera-api': '当前浏览器不支持摄像头采集，请用 Chrome / Edge 打开。',
    'camera-denied': '摄像头被拒绝：请在系统设置里允许浏览器使用摄像头后刷新。',
    'no-video-frame': '摄像头已授权但没有画面，换一个摄像头或拔插后重试。',
    'csp-wasm': '当前页面策略不允许 WebAssembly，人脸引擎无法启动。',
    'engine-init': '人脸引擎初始化失败，请看控制台。',
    'sim-init': '模拟数据初始化失败。',
    'sim-mode': '当前是模拟模式（?gazeSim=1），没有真实摄像头帧，不能标定。请去掉该参数后刷新。',
    'fit-failed': '拟合失败：请确认光线充足、整张脸在画面内后重试。',
    'idb-write': '模型写入 IndexedDB 失败，请检查浏览器存储权限后重试。',
  };
  return map[reason] || ('标定没能启动：' + (reason || '未知原因'));
}

/* ---------- 空间导航（2×2 卡片 + 视线停留选中） ---------- */

/** 宿主状态；脚本还没加载时返回 null，调用方自己补渲染。 */
function hostStatus() {
  try {
    return window.__epblGazeHost ? window.__epblGazeHost.getStatus() : null;
  } catch (e) {
    return null;
  }
}

/**
 * 「已标定」不等于「现在能用」：模型绑定了标定时的窗口尺寸和摄像头分辨率。
 * soft = 尺寸变了但比例接近，仍可用，只是建议校正；hard = 环境变化大，重新标定。
 */
function paintPill(el, st) {
  if (!el) return;
  const has = !!(st && st.hasModel);
  const ok = has && st.status === 'ok';
  const soft = has && st.status === 'stale' && st.reason === 'soft';
  el.textContent = !has ? '尚未标定' : ok ? '视线已就绪' : soft ? '建议重新标定' : '模型已过期';
  el.className = 'pill ' + (ok ? 'ok' : has ? 'wait' : 'off');
  el.title = !has
    ? '还没有模型，做一次 9 点标定即可'
    : ok
      ? '标定环境与当前窗口一致'
      : '窗口尺寸或摄像头分辨率变了，请重新做一次 9 点标定';
}

function showHome() {
  setView('nav');
  state.active = null;
  markActive(null);
  byId('crumb').textContent = '空间导航';
  if (location.hash !== '#/home') history.replaceState(null, '', '#/home');

  const wrap = newScreen('nav');
  if (!document.getElementById('calibResumeCss')) {
    const st = document.createElement('style');
    st.id = 'calibResumeCss';
    st.textContent = CALIB_RESUME_CSS;
    document.head.appendChild(st);
  }
  const pending = (() => {
    try {
      return window.__epblGazeHost && window.__epblGazeHost.getPending
        ? window.__epblGazeHost.getPending()
        : null;
    } catch (_) {
      return null;
    }
  })();
  const calibratedNow = (() => {
    try {
      return sessionStorage.getItem('epbl.gaze.calibrated') === '1';
    } catch (_) {
      return false;
    }
  })();
  const resumeText = pending && pending.idx
    ? `标定未完成：已完成 ${pending.idx} / ${pending.total} 点`
    : '还没有完成本次标定';
  const resumeBtn = pending && pending.idx ? '继续标定' : '开始标定';

  wrap.innerHTML = [
    !calibratedNow && [
      '<div class="calib-resume" id="calibResume">',
      `  <span>${resumeText}</span>`,
      `  <button class="btn primary" id="btnResumeCalib">${resumeBtn}</button>`,
      '</div>',
    ].join(''),
    '<header class="nav-head">',
    '  <div class="nav-title">',
    '    <h2>选择要进入的空间</h2>',
    '    <p>注视着卡片别动，圆环走满一圈就进入；也可以直接点。</p>',
    '  </div>',
    '  <div class="nav-side">',
    '    <span class="pill off" id="navPill">检查中…</span>',
    '    <button class="btn ghost" id="navReCalib">重新标定</button>',
    '  </div>',
    '</header>',
    '<div class="card-grid" id="cardGrid"></div>',
    '<div class="gaze-cursor" id="gazeCursor" hidden><i></i></div>',
    '<div class="nav-foot"><span>视线停留 1.5 秒进入</span><span>ESC 返回首页</span></div>',
  ].join('\n');

  // 状态点：立即渲染 + 跟随宿主事件 + 宿主脚本晚到时补渲染
  const pillEl = wrap.querySelector('#navPill');
  paintPill(pillEl, hostStatus());
  const onStatus = (e) => paintPill(pillEl, e.detail || hostStatus());
  window.addEventListener('epbl:gaze-status', onStatus);
  screens.statusOff = () => window.removeEventListener('epbl:gaze-status', onStatus);
  [350, 1200].forEach((ms) => setTimeout(() => {
    if (screens.view === 'nav' && pillEl.isConnected) paintPill(pillEl, hostStatus());
  }, ms));

  const grid = wrap.querySelector('#cardGrid');
  state.modules.forEach((mod) => grid.appendChild(cardEl(mod)));

  const resumeEl = wrap.querySelector('#btnResumeCalib');
  if (resumeEl) resumeEl.addEventListener('click', () => { location.hash = '#/calibrate'; });
  wrap.querySelector('#navReCalib').addEventListener('click', () => {
    // 重新标定 = 丢掉暂停中的进度，从第 1 点开始
    try {
      if (window.__epblGazeHost && window.__epblGazeHost.cancel) window.__epblGazeHost.cancel();
    } catch (_) {}
    location.hash = '#/calibrate';
  });

  startDwell(wrap);
}

const CALIB_RESUME_CSS = [
  '.calib-resume{display:flex;align-items:center;justify-content:space-between;gap:14px;',
  'margin:0 0 16px;padding:12px 16px;border-radius:12px;',
  'border:1px solid var(--line,rgba(255,255,255,.14));',
  'background:var(--card,rgba(255,255,255,.05));font-size:13px}',
].join('');

function cardEl(mod) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'space-card';
  el.dataset.id = mod.id;
  el.innerHTML = [
    '<span class="card-media">',
    '  <img alt="" loading="lazy" src="assets/preview-' + mod.id + '.jpg">',
    '</span>',
    '<span class="card-body">',
    '  <b class="card-title"></b>',
    '  <span class="card-desc"></span>',
    '</span>',
    '<svg class="card-ring" viewBox="0 0 100 100" aria-hidden="true">',
    '  <circle class="ring-bg" cx="50" cy="50" r="46"></circle>',
    '  <circle class="ring-fg" cx="50" cy="50" r="46" pathLength="100"></circle>',
    '</svg>',
  ].join('\n');
  el.querySelector('.card-title').textContent = mod.name;
  el.querySelector('.card-desc').textContent = mod.desc || '';
  el.addEventListener('click', () => { location.hash = '#/' + mod.id; });
  return el;
}

/**
 * 视线停留选中：宿主每帧推 gaze（页面归一化），这里做命中判定与圆环进度。
 * 同一时间只有一张卡片在累积；视线离开后进度按倍率回落。
 */
function startDwell(wrap) {
  const cards = Array.from(wrap.querySelectorAll('.space-card'));
  if (!cards.length) return;
  const cursor = wrap.querySelector('#gazeCursor');
  const progress = new Map(cards.map((c) => [c, 0]));
  let last = performance.now();
  let entering = false;
  let sawGaze = false;

  const paint = (card, v) => {
    const ring = card.querySelector('.ring-fg');
    if (!ring) return;
    const p = Math.max(0, Math.min(1, v / DWELL_MS));
    ring.style.strokeDashoffset = String(100 - p * 100);
    card.classList.toggle('hot', p > 0.04 && !entering);
  };

  const placeCursor = (x, y) => {
    if (!cursor) return;
    cursor.hidden = false;
    cursor.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
  };

  const hitAt = (x, y) => cards.find((c) => {
    const r = c.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  });

  const enter = (card) => {
    if (entering) return;
    entering = true;
    card.classList.add('entering');
    cards.forEach((c) => { if (c !== card) c.classList.remove('hot'); });
    setTimeout(() => { location.hash = '#/' + card.dataset.id; }, 240);
  };

  const step = (x, y) => {
    const now = performance.now();
    const dt = Math.min(140, now - last);
    last = now;
    const hit = hitAt(x, y);

    cards.forEach((c) => {
      if (c === hit) return;
      const v = progress.get(c);
      if (v > 0) progress.set(c, Math.max(0, v - dt * DWELL_DECAY));
      paint(c, progress.get(c));
    });
    if (!hit) return;

    const v = Math.min(DWELL_MS, progress.get(hit) + dt);
    progress.set(hit, v);
    paint(hit, v);
    if (v >= DWELL_MS) enter(hit);
  };

  // 有视线模型时由宿主推坐标；没有模型时退回鼠标位置，页面不至于没法用
  if (window.__epblGazeHost && window.__epblGazeHost.onGaze) {
    screens.gazeOff = window.__epblGazeHost.onGaze((g) => {
      if (!g) return;
      sawGaze = true;
      const x = g.x * window.innerWidth;
      const y = g.y * window.innerHeight;
      placeCursor(x, y);
      step(x, y);
    });
  }
  wrap.addEventListener('mousemove', (e) => {
    if (sawGaze) return;
    placeCursor(e.clientX, e.clientY);
  });
}

/* ---------------- 下载中心 ---------------- */
async function showReleases() {
  setView('releases');
  teardownFrame();
  markActive('releases');
  byId('rightbar').hidden = true;
  byId('crumb').textContent = '下载中心';

  const stage = byId('stage');
  stage.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'releases';
  stage.appendChild(wrap);

  let data = null;
  try {
    const res = await fetch(RELEASES_URL, { cache: 'no-store' });
    if (res.ok) data = await res.json();
  } catch (_) { /* 交给下面的占位 */ }

  /* 等待期间用户可能已切走：避免把下载中心渲染进别的模块视图 */
  if (location.hash.replace(/^#\/?/, '') !== 'releases') return;

  const head = document.createElement('div');
  head.className = 'rel-head';
  const h2 = document.createElement('h2');
  h2.textContent = '下载控制小窗';
  const p = document.createElement('p');
  p.textContent = '控制小窗负责启动/停止本地服务（静态 8125 + 后端 8899），并提供摄像头开关与前端入口。安装前请确认 macOS 版本与芯片架构。';
  head.append(h2, p);
  wrap.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'rel-grid';
  const items = (data && data.items) || [];
  if (!items.length) {
    grid.appendChild(releaseCard({
      name: 'macOS 安装包',
      arch: 'arm64',
      status: 'planned',
      note: '尚未构建',
    }));
  } else {
    items.forEach((item) => grid.appendChild(releaseCard(item)));
  }
  wrap.appendChild(grid);

  if (!items.some((it) => it.status === 'ready')) {
    const note = document.createElement('p');
    note.className = 'placeholder-note';
    note.textContent = '当前仓库还没有可下载的 DMG：本页按设计预留入口与校验位。产物将在打包流水线（S5）完成构建后出现在 workbench/releases/ 下。';
    wrap.appendChild(note);
  }

  wrap.appendChild(section('安装步骤', [
    '双击 DMG，把「隔空控制器.app」拖入「应用程序」。',
    '首次打开请右键 → 打开（未公证版本会被 Gatekeeper 拦截一次）。',
    '点 Start：首次启动会创建运行环境并安装依赖（需联网，约 1–3 分钟）。',
    '在「系统设置 → 隐私与安全性 → 摄像头」中允许对应进程访问摄像头。',
    '启动成功后工作台地址为 http://127.0.0.1:8125/workbench/。',
  ], 'ol'));

  wrap.appendChild(section('开发模式（无需 DMG）', [
    '在仓库根目录执行：python3 -m http.server 8125 --bind 127.0.0.1',
    '打开 http://127.0.0.1:8125/workbench/',
    '需要控制能力时，另开终端运行 control-backend/launcher.command',
  ], 'ul', 'python3 -m http.server 8125 --bind 127.0.0.1'));

  wrap.appendChild(section('完整性校验', [
    '下载后核对 SHA-256：shasum -a 256 隔空控制器-v1.0.0-arm64.dmg',
    '校验值应与本页展示、以及同名 .sha256 文件一致。',
    'DMG 属于本地构建产物（57MB），未随仓库提交；克隆后执行 packaging/build_dmg.sh 重新生成并自动发布到本页。',
  ], 'ul'));
}

function releaseCard(item) {
  const card = document.createElement('div');
  card.className = 'rel-card';

  const h3 = document.createElement('h3');
  h3.textContent = item.name || '隔空控制器';
  const badge = document.createElement('span');
  badge.className = 'pill ' + (item.status === 'ready' ? 'ok' : 'wait');
  badge.textContent = item.status === 'ready' ? '可下载' : '未构建';
  h3.appendChild(badge);
  card.appendChild(h3);

  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = [item.platform || 'macOS', item.arch || 'arm64', 'v' + (item.version || '1.0.0')].join(' · ');
  card.appendChild(sub);

  const dl = document.createElement('dl');
  const rows = [
    ['文件', item.file || '—'],
    ['大小', item.size || '—'],
    ['SHA-256', item.sha256 || '—'],
  ];
  rows.forEach(([k, v]) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  });
  card.appendChild(dl);

  const actions = document.createElement('div');
  actions.className = 'rel-actions';
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.textContent = item.status === 'ready' ? '下载 DMG' : '等待构建';
  btn.disabled = item.status !== 'ready';
  if (item.status === 'ready' && item.file) {
    btn.addEventListener('click', () => { window.location.href = 'releases/' + item.file; });
  }
  actions.appendChild(btn);
  card.appendChild(actions);

  if (item.note) {
    const n = document.createElement('p');
    n.className = 'placeholder-note';
    n.textContent = item.note;
    card.appendChild(n);
  }
  return card;
}

function section(title, lines, listType, command) {
  const sec = document.createElement('section');
  sec.className = 'rel-section';
  const h = document.createElement('h2');
  h.textContent = title;
  sec.appendChild(h);

  const list = document.createElement(listType === 'ol' ? 'ol' : 'ul');
  lines.forEach((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    list.appendChild(li);
  });
  sec.appendChild(list);

  if (command) {
    const pre = document.createElement('pre');
    pre.textContent = command;
    sec.appendChild(pre);
  }
  return sec;
}

/* ---------------- 后端探活 ---------------- */
async function checkBackend() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  let ok = false;
  try {
    /* no-cors 探测：后端未开 CORS 时也能判断端口是否可达（响应为 opaque，只看能否连通） */
    await fetch(HEALTH_URL, { mode: 'no-cors', signal: ctrl.signal, cache: 'no-store' });
    ok = true;
  } catch (_) {
    ok = false;
  } finally {
    clearTimeout(timer);
  }

  const text = ok ? '后端在线' : '后端未启动';
  const pill = byId('backendPill');
  pill.textContent = text;
  pill.className = 'pill ' + (ok ? 'ok' : 'off');
  pill.title = ok
    ? '控制后端 127.0.0.1:8899 可用'
    : '控制后端未运行：需要远程控制/受控浏览器时请启动 control-backend';
}

/* GAZE-AUDIT-PROBE：只读；window.__GAZE_AUDIT_OFF 可整体关闭 */
if (!window.__GAZE_AUDIT_OFF && window.__makeGazeAudit) {
  window.__gazeAudit = window.__makeGazeAudit({
    page: 'workbench',
    engine: () => 'none',
    model: () => null,
    points: () => 0,
    coord: 'page-norm',
    lastGaze: () => null,
    quality: () => null,
    note: '宿主页，自身不采集眼动'
  });
}
