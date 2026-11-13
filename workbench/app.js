/* 隔空控制器 · 工作台外壳
 * 职责：注册表渲染、hash 路由、iframe 懒加载 + 单实例互斥、下载中心、后端探活。
 * 约束：不使用任何框架与构建工具；所有模块与工作台同源（127.0.0.1:8125）。
 */
'use strict';

const REGISTRY_URL = 'modules.json';
const RELEASES_URL = 'releases.json';
const HEALTH_URL = 'http://127.0.0.1:8899/health';
const LS = { theme: 'ac.workbench.theme', last: 'ac.workbench.last' };
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
  byId('menuBtn').addEventListener('click', () => document.body.classList.toggle('nav-open'));
  byId('mask').addEventListener('click', closeNav);
  byId('themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  });
  byId('reloadBtn').addEventListener('click', () => {
    const mod = currentModule();
    if (!mod) return;
    teardownFrame();
    activate(mod, { force: true });
  });
  byId('openBtn').addEventListener('click', () => {
    const mod = currentModule();
    if (mod) window.open(mod.path, '_blank', 'noopener');
  });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(LS.theme, theme);
  const btn = byId('themeBtn');
  if (btn) btn.textContent = theme === 'dark' ? '☀' : '☾';
}

function closeNav() {
  document.body.classList.remove('nav-open');
}

function currentModule() {
  return state.modules.find((m) => m.id === state.active) || null;
}

/* ---------------- 侧栏 ---------------- */
function renderNav() {
  const nav = byId('nav');
  nav.textContent = '';

  state.groups.forEach((group) => {
    const items = state.modules.filter((m) => m.group === group.id);
    if (!items.length) return;
    const box = document.createElement('div');
    box.className = 'nav-group';

    const head = document.createElement('h2');
    head.textContent = group.name;
    box.appendChild(head);

    items.forEach((mod) => box.appendChild(navItem(mod)));
    nav.appendChild(box);
  });

  const dist = document.createElement('div');
  dist.className = 'nav-group';
  const h = document.createElement('h2');
  h.textContent = '分发';
  dist.appendChild(h);
  dist.appendChild(navItem({
    id: 'releases',
    name: '下载控制小窗',
    desc: 'DMG 安装包与安装指引',
    capabilities: [],
    requires: [],
  }, true));
  nav.appendChild(dist);
}

function navItem(mod, isReleases = false) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'nav-item';
  btn.dataset.id = mod.id;
  if ((mod.capabilities || []).includes('camera')) btn.dataset.cap = 'camera';
  btn.title = mod.desc || mod.name;

  const text = document.createElement('span');
  text.className = 't';
  text.textContent = mod.name;
  btn.appendChild(text);

  if ((mod.requires || []).includes('cdn')) btn.appendChild(tag('CDN', 'cdn'));
  if ((mod.capabilities || []).includes('camera')) btn.appendChild(tag('CAM'));

  const dot = document.createElement('span');
  dot.className = 'd';
  btn.appendChild(dot);

  btn.addEventListener('click', () => {
    closeNav();
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
  if (hash === 'releases') {
    showReleases();
    return;
  }

  const last = localStorage.getItem(LS.last);
  const mod =
    state.modules.find((m) => m.id === hash) ||
    state.modules.find((m) => m.id === last) ||
    state.modules.find((m) => m.id === state.registry.default) ||
    state.modules[0];

  if (!mod) {
    showEmpty('没有可用模块', '请检查 modules.json 的 modules 数组。');
    return;
  }
  if (hash !== mod.id) history.replaceState(null, '', '#/' + mod.id);
  activate(mod);
}

/* ---------------- iframe 生命周期（单实例互斥） ---------------- */
function teardownFrame() {
  const stage = byId('stage');
  const frame = stage.querySelector('iframe.frame');
  if (frame) {
    /* 先置空再移除：确保文档卸载、getUserMedia 轨道立即释放 */
    try { frame.src = 'about:blank'; } catch (_) {}
    frame.remove();
  }
  stage.querySelectorAll('.loading, .empty').forEach((n) => n.remove());
  state.active = null;
}

function activate(mod, { force = false } = {}) {
  if (!force && state.active === mod.id && byId('stage').querySelector('iframe.frame')) return;

  teardownFrame();
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
  frame.setAttribute('allow', FRAME_ALLOW);
  frame.src = mod.path;

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
  const bar = byId('moduleBar');
  bar.hidden = false;
  byId('modName').textContent = mod.name;
  byId('crumb').textContent = mod.name;

  const meta = byId('modMeta');
  meta.textContent = '';
  (mod.capabilities || []).forEach((cap) => meta.appendChild(tag(cap === 'camera' ? '摄像头' : '后端', '')));
  (mod.requires || []).forEach((req) => meta.appendChild(tag(req === 'cdn' ? 'CDN 依赖' : '本地资源', req === 'cdn' ? 'cdn' : '')));
  const path = document.createElement('code');
  path.textContent = mod.path;
  meta.appendChild(path);

  const note = byId('modNote');
  if (mod.note) {
    note.hidden = false;
    note.textContent = '提示：' + mod.note;
  } else {
    note.hidden = true;
    note.textContent = '';
  }
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

/* ---------------- 下载中心 ---------------- */
async function showReleases() {
  teardownFrame();
  markActive('releases');
  byId('moduleBar').hidden = true;
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
  [byId('backendPill'), byId('sideBackend')].forEach((el) => {
    if (!el) return;
    el.textContent = text;
    el.className = 'pill ' + (ok ? 'ok' : 'off');
  });
  byId('backendPill').title = ok
    ? '控制后端 127.0.0.1:8899 可用'
    : '控制后端未运行：需要远程控制/受控浏览器时请启动 control-backend';
}
