/* 阶段 3：检测引擎（隐式后台）→ 广播翻页指令 → 控制主页面
 * 在阶段 2 的距离估计 + 模式切换基础上，新增：
 *   - PageController：由手势/视线信号生成稳定翻页指令（防抖 + 冷却 + 复位）
 *   - BroadcastChannel：跨标签页广播指令，主页面（reader.html）接收并翻页
 *   - 隐式模式：折叠摄像头画面，只留紧凑状态栏，后端运行不干扰主页面
 */
import { CameraModule } from './camera-module.js';
import { FaceMeshDetector } from './face-mesh-detector.js';
import { HandDetector } from './hand-detector.js';
import { drawFrame } from './renderer.js';
import { StatusMessage } from './status-codes.js';
import { DistanceEstimator } from './distance-estimator.js';
import { ModeSwitcher, Mode } from './mode-switcher.js';
import { PageController, gestureDirection, gazeDirection, Direction } from './page-controller.js';
import { createChannel, post, MSG_TYPE } from './channel.js';

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

const ui = {
  overlay: document.getElementById('overlay'),
  btnStart: document.getElementById('btn-start'),
  hint: document.getElementById('hint'),
  chipMode: document.getElementById('chip-mode'),
  chipStatus: document.getElementById('chip-status'),
  chipFps: document.getElementById('chip-fps'),
  chipLink: document.getElementById('chip-link'),
  btnStealth: document.getElementById('btn-stealth'),
  cmdNote: document.getElementById('cmd-note'),
  faceState: document.getElementById('face-state'),
  handState: document.getElementById('hand-state'),
  irisState: document.getElementById('iris-state'),
  distanceState: document.getElementById('distance-state'),
  modeState: document.getElementById('mode-state'),
  calibState: document.getElementById('calib-state'),
  btnCalibrate: document.getElementById('btn-calibrate'),
  calibDistance: document.getElementById('calib-distance'),
  distFill: document.getElementById('dist-fill'),
  dotFace: document.getElementById('dot-face'),
  dotHand: document.getElementById('dot-hand'),
  dotIris: document.getElementById('dot-iris'),
};

const MODE_LABEL = {
  [Mode.GAZE]: '眼神模式（近距）',
  [Mode.GESTURE]: '手势模式（远距）',
};

const DIRECTION_LABEL = {
  [Direction.PREV]: '上一页',
  [Direction.NEXT]: '下一页',
};

const DIST_MAX = 3; // 进度条量程（米）

const faceDetector = new FaceMeshDetector();
const handDetector = new HandDetector();
const distanceEstimator = new DistanceEstimator();

// 跨页面广播通道
const channel = createChannel();

// 翻页指令生成器：触发时广播到主页面
const pageController = new PageController({
  cooldownMs: 800,
  minFrames: 5,
  onCommand: (direction) => {
    post(channel, MSG_TYPE.PAGE, { action: direction });
    ui.cmdNote.textContent = '已发送翻页指令：' + (DIRECTION_LABEL[direction] || direction);
    ui.cmdNote.classList.remove('flash');
    void ui.cmdNote.offsetWidth;
    ui.cmdNote.classList.add('flash');
  },
});

const modeSwitcher = new ModeSwitcher({
  thresholdMeters: 1.5,
  hysteresisMeters: 0.2,
  onSwitch: (prev, next, dist) => {
    console.log(`[mode] ${prev} → ${next} @ ${dist ? dist.toFixed(2) : '--'}m`);
    ui.modeState.classList.add('flash');
    setTimeout(() => ui.modeState.classList.remove('flash'), 650);
    post(channel, MSG_TYPE.MODE, { mode: next, label: MODE_LABEL[next] });
  },
});

// 接收主页面探测，回应在线状态
channel.onmessage = (e) => {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === MSG_TYPE.PING) {
    post(channel, MSG_TYPE.STATUS, { status: 'ready' });
  } else if (msg.type === MSG_TYPE.PONG) {
    setLink(true);
  }
};

let camera = null;

// ---- FPS 统计 ----
let frameCount = 0;
let fpsLastTime = performance.now();

function updateFps() {
  frameCount++;
  const now = performance.now();
  if (now - fpsLastTime >= 1000) {
    const fps = Math.round((frameCount * 1000) / (now - fpsLastTime));
    frameCount = 0;
    fpsLastTime = now;
    ui.chipFps.textContent = 'FPS：' + fps;
  }
}

function setStatus(text, stateClass) {
  ui.chipStatus.textContent = '摄像头：' + text;
  ui.chipStatus.className = 'chip' + (stateClass ? ' ' + stateClass : '');
}

function setLink(on) {
  ui.chipLink.textContent = on ? '广播：运行中' : '广播：未启动';
  ui.chipLink.className = 'chip' + (on ? ' on' : '');
}

// 给元素替换模式着色类，不干扰其它（如 flash）类
function setModeClass(el, cls) {
  el.classList.remove('gaze', 'gesture');
  el.classList.add(cls);
}

function setDetectState(el, dot, detected) {
  el.textContent = detected ? '已检测' : '无';
  el.className = 'detect-val ' + (detected ? 'ok' : 'miss');
  dot.className = 'dot ' + (detected ? 'ok' : 'miss');
}

// ---- 距离 / 模式 UI ----
function updateModeUi(mode, distance) {
  const label = MODE_LABEL[mode] || mode;
  const cls = mode === Mode.GESTURE ? 'gesture' : 'gaze';

  ui.modeState.textContent = label;
  setModeClass(ui.modeState, cls);
  setModeClass(ui.chipMode, cls);

  if (distance != null) {
    ui.distanceState.textContent = distance.toFixed(2) + ' m';
    const pct = Math.min(Math.max(distance / DIST_MAX, 0), 1) * 100;
    ui.distFill.style.width = pct + '%';
    ui.chipMode.textContent = '模式：' + label + ' · ' + distance.toFixed(2) + 'm';
  } else {
    ui.distanceState.textContent = '--';
    ui.chipMode.textContent = '模式：' + label;
  }
}

// ---- 每帧处理：检测 + 距离/模式 + 翻页指令 + 渲染 + UI ----
async function onFrame() {
  await faceDetector.detect(video);
  await handDetector.detect(video);

  const faceLandmarks = faceDetector.results?.multiFaceLandmarks?.[0] ?? null;
  const handLandmarks = handDetector.results?.multiHandLandmarks?.[0] ?? null;

  const distance = faceLandmarks
    ? distanceEstimator.update(faceLandmarks, video.videoWidth)
    : null;
  const mode = modeSwitcher.update(distance);
  updateModeUi(mode, distance);

  // 依当前模式提取方向信号并生成翻页指令
  const direction = mode === Mode.GESTURE
    ? gestureDirection(handLandmarks)
    : gazeDirection(faceLandmarks);
  pageController.update(direction);

  const summary = drawFrame({
    ctx, canvas, video,
    faceResults: faceDetector.results,
    handResults: handDetector.results,
    faceTesselation: faceDetector.tesselation,
    faceIrises: faceDetector.irises,
    handConnections: handDetector.connections,
  });

  updateFps();
  setDetectState(ui.faceState, ui.dotFace, summary.hasFace);
  setDetectState(ui.irisState, ui.dotIris, summary.hasIris);
  setDetectState(ui.handState, ui.dotHand, summary.hasHand);
  ui.calibState.textContent = distanceEstimator.calibrated ? '已标定' : '未标定（默认参数）';
}

// ---- 标定 ----
ui.btnCalibrate.addEventListener('click', () => {
  const ipd = distanceEstimator.ipdPx;
  if (!ipd) {
    ui.hint.textContent = '标定失败：未检测到双眼虹膜，请正对镜头后再试。';
    return;
  }
  const ref = parseFloat(ui.calibDistance.value);
  if (!Number.isFinite(ref) || ref <= 0) {
    ui.hint.textContent = '请先填写有效的标定距离（米）。';
    return;
  }
  distanceEstimator.calibrate(ref, ipd);
  ui.calibState.textContent = `已标定 @ ${ref}m`;
  ui.hint.textContent = `标定完成：参考 ${ref}m，瞳距 ${ipd.toFixed(1)}px。`;
});

// ---- 隐式模式：折叠画面，仅保留紧凑状态栏 ----
ui.btnStealth.addEventListener('click', () => {
  const stealth = document.body.classList.toggle('stealth');
  ui.btnStealth.textContent = stealth ? '退出隐式' : '隐式模式';
});

// ---- 启动 ----
async function start() {
  try {
    faceDetector.init();
    handDetector.init();
  } catch (err) {
    ui.hint.textContent = err.message;
    return;
  }

  camera = new CameraModule(video, { onFrame });
  try {
    await camera.start();
    ui.overlay.classList.add('hidden');
    setStatus(StatusMessage[camera.status] || camera.status, 'on');
    setLink(true);
    post(channel, MSG_TYPE.STATUS, { status: 'ready' });
    ui.chipMode.textContent = '模式：' + MODE_LABEL[modeSwitcher.mode];
  } catch (err) {
    setStatus('启动失败', 'err');
    ui.hint.textContent = '无法启动摄像头：' + err.message;
    ui.overlay.classList.remove('hidden');
  }
}

ui.btnStart.addEventListener('click', () => {
  if (!window.Camera || !window.FaceMesh || !window.Hands) {
    ui.hint.textContent = 'MediaPipe 脚本加载失败，请检查网络后刷新重试。';
    return;
  }
  start();
});

window.addEventListener('beforeunload', () => {
  if (camera) camera.stop();
  channel.close();
});
