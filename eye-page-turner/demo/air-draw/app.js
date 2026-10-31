/**
 * 隔空画画 · 演示页主控制器
 *
 * 交互映射（依据《开工方案》9.1 / 9.3 决策 6·7·8）：
 *   落笔 = 握拳   |   抬笔 = 张开手掌        → 手势（手部状态二分类 + 滞回防抖）
 *   选色 = 注视调色板 + dwell 700ms + 进度环  → 眼动（M14）
 *   笔尖位置 = 视线（默认，按需求）或食指指尖（备选，更稳好画）
 *
 * 兜底（M15 现场运维要求）：摄像头不可用 → 自动进入「演示模式」，页面永远不会开天窗。
 */

import { CameraModule } from '../../src/camera-module.js';
import { FaceMeshDetector } from '../../src/face-mesh-detector.js';
import { HandDetector } from '../../src/hand-detector.js';
import { StatusMessage } from '../../src/status-codes.js';
import { BrushEngine } from './lib/brush-engine.js';
import { HandStateMachine, classifyHand, handBBox, bboxOverlap } from './lib/hand-state.js';
import { PaletteDwell } from './lib/palette.js';
import { GazeCursorSource, HandCursorSource } from './lib/gaze-source.js';
import { OneEuroPoint } from './lib/smoothing.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

/* ---------------------------------------------------------------- 元素 */
const el = {
  canvas: $('stage'),
  video: $('video'),
  thumb: $('camThumb'),
  palette: $('palette'),
  chipInput: $('chipInput'),
  chipStatus: $('chipStatus'),
  chipPen: $('chipPen'),
  chipFps: $('chipFps'),
  chipColor: $('chipColor'),
  hint: $('hint'),
  toast: $('toast'),
  penDot: $('penDot'),
  guide: $('guide'),
  result: $('result'),
  resultImg: $('resultImg'),
  resultCap: $('resultCap'),
  signature: $('signature'),
  rangeWidth: $('rangeWidth'),
  rangeAlpha: $('rangeAlpha'),
  chkGlow: $('chkGlow'),
  bgToggle: $('bgToggle'),
  btnUndo: $('btnUndo'),
  btnClear: $('btnClear'),
  btnFinish: $('btnFinish'),
  btnDownload: $('btnDownload'),
  btnAgain: $('btnAgain'),
};

/* ---------------------------------------------------------------- 状态 */
const state = {
  input: 'gaze', // gaze | hand | mouse | sim
  cameraReady: false,
  penDown: false,
  occluded: false,
  cursor: null,
  fps: 0,
  overPalette: false,
  lastHintKey: '',
  lastOccludedToast: 0,
};

const smootherGaze = new OneEuroPoint({ minCutoff: 1.1, beta: 0.012 });
const smootherHand = new OneEuroPoint({ minCutoff: 2.4, beta: 0.03 });
const smootherMouse = new OneEuroPoint({ minCutoff: 8, beta: 0.05 });

const gazeSource = new GazeCursorSource({ gain: 2.0 });
const handSource = new HandCursorSource({ gain: 1.9 });
const handSM = new HandStateMachine({ holdFrames: 3, cooldownMs: 160, lostTimeoutMs: 400 });

const brush = new BrushEngine(el.canvas, {
  color: '#ffd166',
  width: Number(el.rangeWidth.value),
  alpha: Number(el.rangeAlpha.value) / 100,
  glow: el.chkGlow.checked,
  onChange: syncToolUI,
});

const palette = new PaletteDwell({
  root: el.palette,
  dwellMs: 700,
  cooldownMs: 350,
  speedLimit: 0.6,
  onSelect: (color, node) => {
    brush.setColor(color);
    el.chipColor.textContent = `颜色：${node ? node.dataset.name || color : color}`;
    showToast(`已选色 ${node ? node.dataset.name || '' : ''}`, 700);
  },
});

let faceResults = null;
let handResults = null;

/* ---------------------------------------------------------------- 工具条同步 */
function syncToolUI() {
  el.rangeWidth.value = String(brush.width);
  el.rangeAlpha.value = String(Math.round(brush.alpha * 100));
  el.chkGlow.checked = !!brush.glow;
}

function showToast(text, ms = 1200) {
  el.toast.textContent = text;
  el.toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.toast.classList.remove('show'), ms);
}

function setChip(node, text, cls) {
  node.textContent = text;
  node.className = 'chip' + (cls ? ' ' + cls : '');
}

function setHint(text) {
  if (state.lastHintKey === text) return;
  state.lastHintKey = text;
  el.hint.textContent = text;
}

/* ---------------------------------------------------------------- 每帧统一下发 */
function apply(now) {
  const cursor = state.cursor;

  // M14 选色：光标进入调色板即暂停绘制（对应 9.3 决策 8「分时复用」）
  state.overPalette = cursor ? palette.update(cursor, now, cursor.speed || 0) : (palette.update(null, now, 0), false);

  const frozen = state.occluded || state.overPalette;

  // 笔尖指示器
  if (cursor) {
    el.penDot.style.transform = `translate3d(${cursor.x * window.innerWidth}px, ${cursor.y * window.innerHeight}px, 0)`;
    el.penDot.classList.add('on');
    el.penDot.classList.toggle('down', state.penDown && !frozen);
    el.penDot.classList.toggle('frozen', state.occluded);
    el.penDot.classList.toggle('over', state.overPalette);
  } else {
    el.penDot.classList.remove('on');
  }

  if (cursor && state.penDown && !frozen) {
    if (!brush.drawing) brush.begin(cursor.x, cursor.y);
    else brush.move(cursor.x, cursor.y);
  } else if (brush.drawing) {
    brush.end();
  }

  // 遮挡提示（节流，避免刷屏）
  if (state.occluded && now - state.lastOccludedToast > 2000) {
    state.lastOccludedToast = now;
    showToast('手挡住了脸，请把手移开 🙌', 1600);
  }

  // 提示语
  if (state.input === 'sim') {
    setHint('演示模式：模拟数据自动作画（摄像头不可用时的兜底）');
  } else if (state.input === 'mouse') {
    setHint('鼠标模式：按住拖动作画，移到右侧色板停一下即可选色');
  } else if (!cursor) {
    setHint(state.input === 'gaze' ? '看不到你 · 请坐正并对准摄像头' : '请把手抬到镜头前');
  } else if (state.occluded) {
    setHint('手挡住了脸 · 请把手移开');
  } else if (state.overPalette) {
    setHint('注视色块 0.7 秒即可选色');
  } else if (brush.drawing) {
    setHint('正在画 · 张开手掌抬笔');
  } else {
    setHint(state.input === 'gaze' ? '握拳 = 落笔，视线控制笔尖' : '握拳 = 落笔，食指指尖控制笔尖');
  }

  // 笔尖状态
  setChip(
    el.chipPen,
    state.occluded ? '笔尖：冻结' : state.penDown ? '笔尖：落笔 ●' : '笔尖：抬笔',
    state.penDown && !frozen ? 'ok' : state.occluded ? 'warn' : '',
  );
}

/* ---------------------------------------------------------------- 摄像头链路 */
let busy = false;
let camera = null;
let face = null;
let hands = null;
let frameCount = 0;
let fpsWindowStart = 0;

async function onFrame() {
  if (busy) return;
  busy = true;
  try {
    await face.detect(el.video);
    await hands.detect(el.video);
    const now = performance.now();

    const faceLM = (faceResults && faceResults.multiFaceLandmarks && faceResults.multiFaceLandmarks[0]) || null;
    const handLM = (handResults && handResults.multiHandLandmarks && handResults.multiHandLandmarks[0]) || null;

    // ① 手势 → 落笔/抬笔
    const cls = classifyHand(handLM);
    const hs = handSM.update(cls, now);
    state.penDown = hs.penDown;

    // ② 手遮挡面部 → 冻结画笔（9.5 风险应对）
    if (faceLM && handLM) {
      const overlap = bboxOverlap(handBBox(handLM), faceBBox(faceLM));
      state.occluded = overlap > 0.26;
    } else {
      state.occluded = false;
    }

    // ③ 光标（笔尖位置）
    const raw = state.input === 'gaze' ? gazeSource.getPoint(faceResults) : handSource.getPoint(handLM);
    if (raw) {
      const s = state.input === 'gaze' ? smootherGaze : smootherHand;
      state.cursor = s.filter(raw, now);
    }

    apply(now);

    frameCount += 1;
    if (!fpsWindowStart) fpsWindowStart = now;
    if (now - fpsWindowStart >= 1000) {
      state.fps = Math.round((frameCount * 1000) / (now - fpsWindowStart));
      frameCount = 0;
      fpsWindowStart = now;
      setChip(el.chipFps, `FPS：${state.fps}`, state.fps >= 25 ? 'ok' : 'warn');
    }
  } catch (err) {
    console.warn('[air-draw] frame error', err);
  } finally {
    busy = false;
  }
}

function faceBBox(lm) {
  if (!lm || !lm.length) return null;
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of lm) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

async function startCamera(inputMode) {
  face = new FaceMeshDetector({ onResults: (r) => (faceResults = r) });
  hands = new HandDetector({ onResults: (r) => (handResults = r) });
  face.init();
  hands.init();

  camera = new CameraModule(el.video, { width: 640, height: 480, onFrame });
  await camera.start();

  state.cameraReady = true;
  state.input = inputMode;
  el.thumb.classList.add('live');
  setChip(el.chipStatus, '摄像头：运行中', 'ok');
  setChip(el.chipInput, inputMode === 'gaze' ? '笔尖来源：视线' : '笔尖来源：指尖', inputMode === 'gaze' ? 'gaze' : 'hand');
}

/* ---------------------------------------------------------------- 鼠标兜底 */
function useMouse(reason) {
  state.input = 'mouse';
  state.cameraReady = false;
  setChip(el.chipStatus, '摄像头：未启用', 'warn');
  setChip(el.chipInput, '笔尖来源：鼠标', 'warn');
  if (reason) showToast(reason, 2000);

  window.addEventListener('mousemove', (e) => {
    const raw = { x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight, conf: 1 };
    state.cursor = smootherMouse.filter(raw, performance.now());
    apply(performance.now());
  });
  window.addEventListener('mousedown', (e) => {
    if (e.target.closest('#palette') || e.target.closest('.tools') || e.target.closest('button')) return;
    state.penDown = true;
    apply(performance.now());
  });
  window.addEventListener('mouseup', () => {
    state.penDown = false;
    apply(performance.now());
  });
  el.palette.addEventListener('click', (e) => {
    const sw = e.target.closest('[data-color]');
    if (sw) palette.select(sw, true);
  });
}

/* ---------------------------------------------------------------- 演示模式（兜底 / 预览） */
function startSim() {
  state.input = 'sim';
  state.cameraReady = false;
  setChip(el.chipStatus, '演示模式（模拟数据）', 'warn');
  setChip(el.chipInput, '笔尖来源：模拟', 'warn');
  setChip(el.chipFps, 'FPS：--');
  showToast('已进入演示模式：模拟数据自动作画', 2400);

  const heart = (() => {
    const pts = [];
    const n = 180;
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * Math.PI * 2;
      const x = 16 * Math.pow(Math.sin(t), 3);
      const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      pts.push({ x: 0.38 + (x / 16) * 0.22, y: 0.5 - (y / 17) * 0.36 });
    }
    return pts;
  })();

  const squiggle = (() => {
    const pts = [];
    for (let i = 0; i <= 90; i++) {
      const u = i / 90;
      pts.push({ x: 0.2 + u * 0.44, y: 0.9 + Math.sin(u * Math.PI * 3) * 0.028 });
    }
    return pts;
  })();

  const strokes = [
    { swatch: 3, path: heart, speed: 0.16 }, // 粉红爱心
    { swatch: 5, path: squiggle, speed: 0.3 }, // 金色签名线
  ];

  let si = 0;
  let phase = 'select';
  let pathIdx = 0;
  let phaseStart = performance.now();
  let penOn = false;

  function swatchCenter(i) {
    const r = palette.rects[i] || palette.rects[palette.rects.length - 1];
    if (!r) return { x: 0.94, y: 0.5 };
    return { x: (r.x0 + r.x1) / 2 / window.innerWidth, y: (r.y0 + r.y1) / 2 / window.innerHeight };
  }

  function loop() {
    const now = performance.now();
    const cur = strokes[si];
    if (!cur) {
      if (now - phaseStart > 4000) {
        brush.clear();
        si = 0;
        phase = 'select';
        pathIdx = 0;
        phaseStart = now;
      }
      state.penDown = false;
      apply(now);
      requestAnimationFrame(loop);
      return;
    }

    if (phase === 'select') {
      const target = swatchCenter(cur.swatch);
      const prev = state.cursor || { x: 0.5, y: 0.5 };
      const far = Math.hypot(target.x - prev.x, target.y - prev.y) > 0.004;
      const k = far ? 0.14 : 0;
      state.cursor = {
        x: prev.x + (target.x - prev.x) * k,
        y: prev.y + (target.y - prev.y) * k,
        speed: far ? 0.9 : 0,
      };
      state.penDown = false;
      if (far) phaseStart = now; // 未到达前不断重置计时，保证 dwell 从"静止"开始
      apply(now);

      // dwell 走满 → palette 已回调选中；再多等 300ms 再落笔
      const wantColor = palette.swatches[cur.swatch].dataset.color;
      if (!far && palette.selected === wantColor && now - phaseStart > palette.dwellMs + 300) {
        phase = 'draw';
        pathIdx = 0;
        phaseStart = now;
      }
      requestAnimationFrame(loop);
      return;
    }

    // 绘制阶段
    const step = Math.max(1, Math.round(cur.path.length / 90));
    const p = cur.path[Math.min(pathIdx, cur.path.length - 1)];
    state.cursor = { x: p.x, y: p.y, speed: 0.2 };
    state.penDown = true;
    apply(now);
    pathIdx += step;
    if (pathIdx >= cur.path.length) {
      state.penDown = false;
      apply(now);
      si += 1;
      phase = 'select';
      pathIdx = 0;
      phaseStart = now;
    }
    requestAnimationFrame(loop);
  }

  el.thumb.classList.remove('live');
  requestAnimationFrame(loop);
}

/* ---------------------------------------------------------------- 工具条 */
el.rangeWidth.addEventListener('input', () => brush.setWidth(Number(el.rangeWidth.value)));
el.rangeAlpha.addEventListener('input', () => brush.setAlpha(Number(el.rangeAlpha.value) / 100));
el.chkGlow.addEventListener('change', () => brush.setGlow(el.chkGlow.checked));
el.btnUndo.addEventListener('click', () => brush.undo());
el.btnClear.addEventListener('click', () => {
  brush.clear();
  showToast('画布已清空', 900);
});
el.bgToggle.addEventListener('change', () => {
  const paper = el.bgToggle.checked;
  document.body.classList.toggle('paper', paper);
  brush.setBackground(paper ? '#fbfaf7' : '#0b1020');
});

/* ---------------------------------------------------------------- 作品完成 / 导出 */
el.btnFinish.addEventListener('click', () => {
  if (brush.drawing) brush.end();
  if (brush.isEmpty) {
    showToast('还没画东西呢，握拳开始画吧 ✊', 1600);
    return;
  }
  const url = brush.exportPNG();
  el.resultImg.src = url;
  el.resultCap.textContent = `${el.signature.value || '送给评委'} · ${new Date().toLocaleDateString('zh-CN')}`;
  el.result.classList.add('show');
  el.btnDownload.href = url;
});

el.signature.addEventListener('input', () => {
  el.resultCap.textContent = `${el.signature.value || '送给评委'} · ${new Date().toLocaleDateString('zh-CN')}`;
});

el.btnAgain.addEventListener('click', () => {
  el.result.classList.remove('show');
  brush.clear();
  showToast('来，再画一幅 🎨', 1200);
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') el.result.classList.remove('show');
  if (e.key === 'z' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    brush.undo();
  }
  if (e.key === ' ') {
    e.preventDefault();
    state.penDown = !state.penDown;
    apply(performance.now());
  }
});

window.addEventListener('resize', () => {
  brush.resize();
  palette.measure();
});

/* ---------------------------------------------------------------- 启动 */
$('btnStart').addEventListener('click', () => {
  el.guide.classList.remove('show');
  boot(params.get('input'));
});
$('btnSkip').addEventListener('click', () => {
  el.guide.classList.remove('show');
  startSim();
});

async function boot(preferInput) {
  if (preferInput === 'mouse') return useMouse('已按参数切换到鼠标模式');
  if (preferInput === 'sim' || params.get('demo') === '1') return startSim();
  try {
    await startCamera(preferInput === 'hand' ? 'hand' : 'gaze');
  } catch (err) {
    const msg = (err && err.code && StatusMessage[err.code]) || (err && err.message) || '摄像头启动失败';
    useMouse(`${msg} · 已切换到鼠标模式`);
  }
}

el.guide.classList.add('show');
setChip(el.chipFps, 'FPS：--');
setChip(el.chipColor, `颜色：${palette.selectedEl ? palette.selectedEl.dataset.name || palette.selected : ''}`);
setChip(el.chipPen, '笔尖：抬笔');
syncToolUI();

// 显式带参 → 跳过引导直接进对应模式（展台 kiosk / 联调自测用）
const forced = params.get('input');
if (forced === 'sim' || forced === 'mouse' || params.get('autostart') === '1') {
  el.guide.classList.remove('show');
  boot(forced);
}

// 引导 10 秒后自动消失（对应「零学习成本：10 秒内理解玩法」）
setTimeout(() => {
  if (el.guide.classList.contains('show')) {
    el.guide.classList.remove('show');
    if (!state.cameraReady && state.input !== 'sim') startSim();
  }
}, 10000);
