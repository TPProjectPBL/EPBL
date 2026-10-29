/**
 * 星际跑酷 · 前置 UI 主控
 *
 * 职责拆分（本文件只做编排，算法都在 lib/ 里）：
 *   lib/router.js      屏幕路由
 *   lib/dwell.js       视线停留点击（菜单 + 暂停钮）
 *   lib/gaze-zone.js   三区注视 → 变道
 *   lib/gesture.js     挥手 → 跳/滑，握拳 → 护盾
 *   lib/runner.js      跑酷本体（占位实现）
 *   lib/input.js       复用 air-draw / src 的平滑、光标源、手部状态机、摄像头与检测器
 *
 * 输入通道四种模式：
 *   dual  眼动变道 + 手势跳/滑/护盾（推荐）
 *   gaze  只眼动（跳/滑用键盘兜底）
 *   hand  只手势（左右挥手变道）
 *   mouse 鼠标 + 键盘（无摄像头也能走完整流程）
 *   sim   自动演示（?mode=sim，无需摄像头，合成手部关键点走真实检测链路）
 */

import { ScreenRouter } from './lib/router.js';
import { DwellController } from './lib/dwell.js';
import { GazeZoneSelector } from './lib/gaze-zone.js';
import { WipeDetector, SwipeLaneDetector, classifyHand } from './lib/gesture.js';
import { RunnerGame } from './lib/runner.js';
import { AbsoluteGazeSource, GazeCalibModel, diagnoseText, isFaceUsable, medianSample, simLandmarksFor } from './lib/gaze-calib.js';
import { KalmanPoint, rFromAvgErr } from './lib/kalman.js';
import { GazeOnlineTrainer } from './lib/gaze-online.js';
import {
  OneEuroPoint,
  HandCursorSource,
  HandStateMachine,
  HandState,
  CameraModule,
  FaceMeshDetector,
  HandDetector,
  clamp,
} from './lib/input.js';

/* ------------------------------------------------------------------ 常量 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const LS_SETTINGS = 'air-runner.settings';
const LS_BEST = 'air-runner.best';
const LS_GAZE = 'air-runner.gazeModel';
const LS_GAZE_SAMPLES = 'air-runner.gazeSamples';

const DEFAULT_SETTINGS = {
  mode: 'dual',
  duration: 60,
  difficulty: 'normal',
  gaze: 'normal',
  sensitivity: 'normal',
  dwellNav: 'on',
  sound: 'on',
  gazeAbs: 'off',
};

const GAZE_MS = { fast: 200, normal: 350, stable: 500 };

/* 9 点标定：字段内的相对位置（真实屏幕坐标在渲染时按元素矩形换算） */
const GC_POINTS = [
  [0.1, 0.12], [0.5, 0.12], [0.9, 0.12],
  [0.1, 0.5], [0.5, 0.5], [0.9, 0.5],
  [0.1, 0.88], [0.5, 0.88], [0.9, 0.88],
];
const GC_SETTLE_MS = 350; // 等眼球转到位，前 350ms 不采样
const GC_COLLECT_MS = 1200; // 采样窗口（约 24~40 帧；帧越多，逐坐标中位数越稳、离群帧剔除越有效）
const GC_MIN_FRAMES = 6; // 少于这么多有效帧就丢弃该点
const GC_GRADE_TEXT = { good: '优', ok: '良', poor: '偏低' };

const ERR_TEXT = {
  ERR_PERMISSION_DENIED: '摄像头权限被拒绝，已切到鼠标模式',
  ERR_NO_DEVICE: '没有找到摄像头，已切到鼠标模式',
  ERR_DEVICE_BUSY: '摄像头被其他程序占用，已切到鼠标模式',
  ERR_INSECURE_CONTEXT: '需要 localhost 或 HTTPS 才能开摄像头，已切到鼠标模式',
  ERR_NO_SUPPORT: '当前浏览器不支持摄像头，已切到鼠标模式',
  ERR_DETECTOR_LOAD: '检测模型加载失败，请检查网络后刷新',
  ERR_UNKNOWN: '摄像头启动失败，已切到鼠标模式',
};

const ZONE_LANE = { left: 0, center: 1, right: 2 };
const LANE_TEXT = ['左道', '中间道', '右道'];

/* ------------------------------------------------------------------ 状态 */

const params = new URLSearchParams(location.search);
const forcedMode = params.get('mode'); // sim | mouse | gaze | hand | dual

const state = {
  settings: loadSettings(),
  mode: forcedMode === 'sim' ? 'dual' : forcedMode || 'dual',
  inputSource: '未启动',
  screen: 'splash',
  cursor: { x: 0.5, y: 0.5 },
  cursorSpeed: 0,
  faceResults: null,
  handResults: null,
  camReady: false,
  cameraWanted: false,
  calib: { face: false, hand: false, dist: false, light: false },
  calibTimedOut: false,
  tutorial: { laneLeft: false, laneRight: false, jump: false, slide: false, shield: false },
  best: Number(localStorage.getItem(LS_BEST) || 0),
  lastStats: null,
  paused: false,
  gazeModel: null, // 9 点标定模型（null = 未标定，退回相对方向代理）
  __synthHand: null,
  fps: 0,
};

const sim = {
  active: forcedMode === 'sim',
  cursor: null,
  anim: null,
  done: false,
};

const smooth = new OneEuroPoint({ minCutoff: 1.6, beta: 0.03 });
const kalman = new KalmanPoint(); // 自适应卡尔曼（默认平滑器，选参依据见 lib/kalman.js）
const gazeSource = new AbsoluteGazeSource({ gain: 2.0 });
const handSource = new HandCursorSource({ gain: 1.9 });
const handSM = new HandStateMachine({ holdFrames: 3, cooldownMs: 200 });
const wipeDetector = new WipeDetector();
const laneDetector = new SwipeLaneDetector();

/**
 * 平滑器选择：默认卡尔曼；?smooth=oneeuro 可切回原来的 1€ 滤波器（现场对比 / 回退用）。
 * 选参依据：同机扫描下卡尔曼在「停顿抖动」与「扫视滞后」两端都优于 1€(1.6, 0.03)，
 * 且测量噪声 R 可随标定质量自适应（见 syncKalmanR）。
 */
const SMOOTH_KIND = params.get('smooth') === 'oneeuro' ? 'oneeuro' : 'kalman';
function smoothPoint(raw, now) {
  return SMOOTH_KIND === 'kalman' ? kalman.filter(raw, now) : smooth.filter(raw, now);
}
const gazeZone = new GazeZoneSelector({
  gazeMs: GAZE_MS[state.settings.gaze] || 350,
  onSelect: (id) => onZoneSelect(id),
  onProgress: ({ id, progress }) => paintZones(id, progress),
});
const dwell = new DwellController({
  dwellMs: 800,
  onActivate: (el) => el.click(),
});

let router = null;
let game = null;
let camera = null;
let face = null;
let hands = null;
let audioCtx = null;

/* ------------------------------------------------------------------ 小工具 */

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}');
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings));
  } catch {
    /* 隐私模式下忽略 */
  }
}

let toastTimer = 0;
function toast(msg, kind = '') {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = 'toast';
  }, 2600);
}

function chip(id, text, kind = '') {
  const el = $(`#${id}`);
  if (!el) return;
  el.textContent = text;
  el.className = `chip ${kind}`;
}

function beep(freq = 440, ms = 90, type = 'sine') {
  if (state.settings.sound !== 'on') return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + ms / 1000);
  } catch {
    /* 音频不可用不影响主流程 */
  }
}

function flashText(text) {
  const el = $('#flashEvent');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('go');
  void el.offsetWidth;
  el.classList.add('go');
}

/* ------------------------------------------------------------------ 合成手（sim 模式走真实检测链路） */

/**
 * 生成 21 点手部关键点。
 * @param {number} cx 掌心归一化 x
 * @param {number} cy 掌心归一化 y
 * @param {number} k  0..1 动作进度（挥手位移用）
 * @param {boolean} fist 是否握拳
 */
function synthHand(cx, cy, k = 0.5, fist = false) {
  const s = 0.17;
  const base = [
    [0, 0.5], [0.18, 0.36], [0.3, 0.22], [0.4, 0.1], [0.46, 0.02],
    [0.12, 0.16], [0.13, -0.02], [0.14, -0.16], [0.14, -0.3],
    [0.02, 0.14], [0.02, -0.06], [0.02, -0.22], [0.02, -0.38],
    [-0.08, 0.16], [-0.09, -0.02], [-0.1, -0.16], [-0.1, -0.3],
    [-0.17, 0.2], [-0.19, 0.05], [-0.2, -0.06], [-0.21, -0.18],
  ];
  const fold = { 4: [0.26, 0.3], 8: [0.15, 0.08], 12: [0.03, 0.08], 16: [-0.09, 0.08], 20: [-0.21, 0.12] };
  return base.map(([x, y], i) => {
    let px = x;
    let py = y;
    if (fist && fold[i]) {
      px = fold[i][0];
      py = fold[i][1];
    }
    void k;
    return { x: clamp(cx + px * s, 0, 1), y: clamp(cy + py * s, 0, 1), z: 0 };
  });
}

/* ------------------------------------------------------------------ 摄像头链路 */

function currentHand() {
  if (state.__synthHand) return state.__synthHand;
  const h = state.handResults;
  return h && h.multiHandLandmarks && h.multiHandLandmarks.length ? h.multiHandLandmarks[0] : null;
}

function currentFace() {
  const f = state.faceResults;
  return f && f.multiFaceLandmarks && f.multiFaceLandmarks.length ? f.multiFaceLandmarks[0] : null;
}

async function startCamera() {
  if (state.cameraWanted) return true;
  state.cameraWanted = true;
  chip('chipCam', '摄像头：启动中…', 'warn');

  const video = $('#video');
  try {
    face = new FaceMeshDetector({
      onResults: (r) => {
        state.faceResults = r;
        updateCalib('face', !!currentFace());
        drawBox('boxFace', currentFace());
        chip('chipCam', `摄像头：运行中${currentHand() ? ' · 手✓' : ''}`, 'ok');
      },
    }).init();

    hands = new HandDetector({
      maxNumHands: 1,
      onResults: (r) => {
        state.handResults = r;
        const lm = currentHand();
        updateCalib('hand', !!lm);
        drawBox('boxHand', lm);
      },
    }).init();

    let busy = false;
    let tick = 0;
    camera = new CameraModule(video, {
      width: 640,
      height: 480,
      onFrame: async () => {
        if (busy || !video || video.readyState < 2) return;
        busy = true;
        try {
          await face.detect(video);
          if ((tick++ & 1) === 0) await hands.detect(video);
          if ((tick & 7) === 0) updateCalib('light', sampleLuminance(video));
        } catch (err) {
          chip('chipCam', '摄像头：推理异常', 'bad');
        } finally {
          busy = false;
        }
      },
      onError: (err) => chip('chipCam', `摄像头：${err && err.message ? err.message : '异常'}`, 'bad'),
    });

    await camera.start();
    state.camReady = true;
    chip('chipCam', '摄像头：运行中', 'ok');
    $('#camLabel') && ($('#camLabel').textContent = '摄像头预览');
    return true;
  } catch (err) {
    state.camReady = false;
    const text = ERR_TEXT[(err && err.code) || ''] || ERR_TEXT.ERR_UNKNOWN;
    chip('chipCam', '摄像头：不可用', 'bad');
    toast(text, 'bad');
    setMode('mouse', { silent: true });
    return false;
  }
}

function stopCamera() {
  if (camera) {
    try {
      camera.stop();
    } catch {
      /* ignore */
    }
  }
  camera = null;
  state.cameraWanted = false;
  state.camReady = false;
  state.faceResults = null;
  state.handResults = null;
  chip('chipCam', '摄像头：未启动');
}

let lumCanvas = null;
function sampleLuminance(video) {
  try {
    if (!lumCanvas) {
      lumCanvas = document.createElement('canvas');
      lumCanvas.width = 32;
      lumCanvas.height = 24;
    }
    const ctx = lumCanvas.getContext('2d');
    ctx.drawImage(video, 0, 0, 32, 24);
    const data = ctx.getImageData(0, 0, 32, 24).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    }
    return sum / (data.length / 4);
  } catch {
    return null;
  }
}

function drawBox(id, lm) {
  const el = $(`#${id}`);
  if (!el) return;
  if (!lm || !lm.length) {
    el.classList.remove('on');
    return;
  }
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of lm) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  // 预览是镜像的，所以 x 轴翻转
  el.style.left = `${(1 - x1) * 100}%`;
  el.style.top = `${y0 * 100}%`;
  el.style.width = `${(x1 - x0) * 100}%`;
  el.style.height = `${(y1 - y0) * 100}%`;
  el.classList.add('on');
}

/* ------------------------------------------------------------------ 就位检测 */

let calibStartedAt = 0;
let lastDistCheck = 0;

const CHK_ID = { face: 'chkFace', hand: 'chkHand', dist: 'chkDist', light: 'chkLight' };

/**
 * 更新一项就位检测结果。非检测页只记录标志位，不写 DOM（避免每帧刷 DOM）。
 */
function updateCalib(key, pass, text) {
  if (!CHK_ID[key]) return;
  let ok = !!pass;
  let cls = '';
  let msg = text || '';

  if (key === 'light') {
    const lum = pass;
    ok = typeof lum !== 'number' ? true : lum > 45 && lum < 232;
    cls = ok ? 'on' : 'warn';
    msg = typeof lum !== 'number' ? '正常' : ok ? `亮度 ${Math.round(lum)}` : lum <= 45 ? `偏暗 ${Math.round(lum)}` : `过曝 ${Math.round(lum)}`;
  } else if (key === 'face') {
    cls = ok ? 'on' : '';
    msg = ok ? '已检测到' : '未检测到，请正对镜头';
  } else if (key === 'hand') {
    cls = ok ? 'on' : '';
    msg = ok ? '已检测到' : '把手抬到画面里';
  } else if (key === 'dist') {
    cls = ok ? 'on' : 'warn';
    msg = text || (ok ? '合适' : '调整距离');
  }

  state.calib[key] = ok;
  if (router.current !== 'calib') return;
  setCheck(CHK_ID[key], cls, msg);
  paintCalib();
}

function setCheck(id, cls, text) {
  const el = $(`#${id}`);
  if (!el) return;
  el.className = cls;
  const v = el.querySelector('.v');
  if (v) v.textContent = text;
}

function checkDistance() {
  const lm = currentFace();
  if (!lm) {
    updateCalib('dist', false, '未检测到人脸');
    return;
  }
  let y0 = 1, y1 = 0;
  for (const p of lm) {
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  const h = y1 - y0;
  if (h < 0.3) updateCalib('dist', false, '有点远，靠近一点');
  else if (h > 0.68) updateCalib('dist', false, '有点近，后退一点');
  else updateCalib('dist', true, '合适（约 0.6–1.0 m）');
}

function paintCalib() {
  const done = ['face', 'hand', 'dist', 'light'].filter((k) => state.calib[k]).length;
  const bar = $('#calibBar');
  if (bar) bar.style.width = `${(done / 4) * 100}%`;
  const btn = $('#btnCalibGo');
  if (btn) btn.disabled = !((state.calib.face && state.calib.hand) || state.calibTimedOut);
  const tip = $('#calibTip');
  if (tip) {
    if (!state.calib.face) tip.textContent = '请正对镜头，把脸放在虚线椭圆里。';
    else if (!state.calib.hand) tip.textContent = '很好，现在把手举到画面可见范围内（挥一下手）。';
    else if (!state.calib.dist) tip.textContent = '距离有点不对，前后微调一点。';
    else if (!state.calib.light) tip.textContent = '光线偏暗或过曝，调一下灯或换个位置。';
    else tip.textContent = '就位完成，可以继续了。';
  }
}

/* ------------------------------------------------------------------ 模式 */

function setMode(mode, { silent = false } = {}) {
  state.mode = mode;
  state.settings.mode = mode;
  saveSettings();
  $$('.card[data-mode]').forEach((c) => c.classList.toggle('picked', c.dataset.mode === mode));
  const needCam = mode === 'dual' || mode === 'gaze' || mode === 'hand';
  chip('chipMode', `模式：${{ dual: '双模态', gaze: '纯眼动', hand: '纯手势', mouse: '鼠标键盘' }[mode]}`);
  chip('chipInput', `输入：${{ dual: '眼神 + 手势', gaze: '眼神', hand: '手势', mouse: '鼠标' }[mode]}`);

  if (mode === 'hand') laneDetector.setSensitivity(state.settings.sensitivity);
  if (sim.active) {
    document.body.classList.add('sim-mode');
    chip('chipInput', '输入：自动演示');
  }
  document.body.classList.toggle('show-native-cursor', mode === 'mouse');

  // 自动演示不需要摄像头：避免 sim 演示还弹一次权限框，也避免无摄像头时被降级成鼠标模式
  if (needCam && !params.has('nocam') && !sim.active && !state.cameraWanted) {
    startCamera();
  }
  if (!silent) toast(`已选择「${{ dual: '双模态', gaze: '只用眼睛', hand: '只手不眨眼', mouse: '鼠标 / 键盘' }[mode]}」`, 'ok');
}

/* ------------------------------------------------------------------ 手势与注视分发 */

function dispatchWipe(dir, now) {
  if (router.current === 'game' && game) {
    if (dir === 'up') {
      if (game.jump(now)) {
        beep(660, 90);
        flashText('JUMP');
      }
    } else if (dir === 'down') {
      if (game.slide(now)) {
        beep(300, 110, 'triangle');
        flashText('SLIDE');
      }
    }
  } else if (router.current === 'tutorial') {
    if (dir === 'up') markStep('jump');
    else markStep('slide');
  }
}

function dispatchLaneSwipe(dir) {
  if (state.mode !== 'hand') return;
  if (router.current === 'game' && game) {
    if (game.moveLane(dir === 'right' ? 1 : -1)) {
      beep(520, 70);
      flashText(dir === 'right' ? 'RIGHT' : 'LEFT');
    }
  } else if (router.current === 'tutorial') {
    markStep(dir === 'right' ? 'laneRight' : 'laneLeft');
  }
}

function onZoneSelect(zoneId) {
  if (router.current === 'game' && game) {
    const lane = ZONE_LANE[zoneId];
    if (typeof lane === 'number' && game.setLane(lane)) {
      beep(520, 70);
      flashText(zoneId === 'left' ? 'LEFT' : zoneId === 'right' ? 'RIGHT' : 'CENTER');
    }
  } else if (router.current === 'tutorial') {
    markStep(zoneId === 'left' ? 'laneLeft' : zoneId === 'right' ? 'laneRight' : null);
  }
}

function onFistEnter() {
  if (router.current === 'game' && game) {
    if (game.shield()) {
      beep(880, 160, 'sawtooth');
      flashText('SHIELD');
    }
  } else if (router.current === 'tutorial') {
    markStep('shield');
  }
}

/* ------------------------------------------------------------------ 教学 */

function markStep(key) {
  if (!key || !(key in state.tutorial) || state.tutorial[key]) return;
  state.tutorial[key] = true;
  beep(740, 80);
  paintTutorial();
}

function tutorialAllDone() {
  const t = state.tutorial;
  return t.laneLeft && t.laneRight && t.jump && t.slide && t.shield;
}

function paintTutorial() {
  const t = state.tutorial;
  const live = {
    lane: t.laneLeft && t.laneRight ? '左右都认到了' : `左${t.laneLeft ? '✓' : '…'} 右${t.laneRight ? '✓' : '…'}`,
    jump: t.jump ? '已记录向上挥' : '等待挥手…',
    slide: t.slide ? '已记录向下挥' : '等待挥手…',
    shield: t.shield ? '已记录握拳' : '等待握拳…',
  };
  const nodes = { lane: 'liveLane', jump: 'liveJump', slide: 'liveSlide', shield: 'liveShield' };
  const doneKeys = { lane: t.laneLeft && t.laneRight, jump: t.jump, slide: t.slide, shield: t.shield };

  for (const [k, id] of Object.entries(nodes)) {
    const el = $(`#${id}`);
    if (el) el.textContent = live[k];
    const box = $(`.step[data-step="${k}"]`);
    if (box) {
      box.classList.toggle('ok', !!doneKeys[k]);
      box.classList.toggle('active', !doneKeys[k] && Object.values(doneKeys).filter((v) => !v).length > 0 && !Object.entries(doneKeys).some(([kk, v]) => !v && kk !== k));
    }
  }
  const btn = $('#btnTutorialGo');
  if (btn) btn.disabled = !tutorialAllDone();
  const hint = $('#tutorialHint');
  if (hint) hint.textContent = tutorialAllDone() ? '四项都完成了，可以发车！' : '跟着做一遍，四项都打勾就进赛道。';
}

/* ------------------------------------------------------------------ 三个注视带（HUD） */

function paintZones(activeId, progress) {
  $$('#zoneStrip .zone').forEach((z) => {
    const on = z.dataset.zone === activeId;
    z.style.setProperty('--dwell', on ? String(progress || 0) : '0');
    z.classList.toggle('look', on);
    if (game) z.classList.toggle('cur', ZONE_LANE[z.dataset.zone] === game.targetLane);
  });
}

function clearZones() {
  $$('#zoneStrip .zone').forEach((z) => {
    z.style.setProperty('--dwell', '0');
    z.classList.remove('look');
  });
}

/* ------------------------------------------------------------------ 9 点精确注视标定 */

const gc = {
  active: false,
  idx: 0,
  phase: 'idle', // idle | wait | stare | collect | result
  t0: 0,
  frames: [],
  samples: [],
  model: null,
  note: '',
  tips: [], // 结果页的人类可读诊断（多行）
};

function currentAspect() {
  const v = $('#video');
  return v && v.videoWidth ? v.videoWidth / v.videoHeight : 4 / 3;
}

function fieldRect() {
  const el = $('#gazeField');
  return el ? el.getBoundingClientRect() : null;
}

/** 字段内相对坐标 → 页面归一化坐标（标定目标必须是元素真实所在位置） */
function fieldToPage(fx, fy) {
  const r = fieldRect();
  if (!r || !r.width || !r.height) return { x: fx, y: fy };
  return {
    x: (r.left + fx * r.width) / window.innerWidth,
    y: (r.top + fy * r.height) / window.innerHeight,
  };
}

/** 页面归一化坐标 → 字段内相对坐标（画预测落点用，可超出 0..1 表示落在框外） */
function pageToField(px, py) {
  const r = fieldRect();
  if (!r || !r.width || !r.height) return { x: px, y: py };
  return {
    x: (px * window.innerWidth - r.left) / r.width,
    y: (py * window.innerHeight - r.top) / r.height,
  };
}

function loadGazeModel() {
  try {
    return GazeCalibModel.fromJSON(JSON.parse(localStorage.getItem(LS_GAZE) || 'null'));
  } catch {
    return null;
  }
}

function saveGazeModel(model) {
  try {
    if (model && model.ok) localStorage.setItem(LS_GAZE, JSON.stringify(model.toJSON()));
    else localStorage.removeItem(LS_GAZE);
  } catch {
    /* 隐私模式下忽略 */
  }
}

/* ------------------------------------------------------------------
 * 在线学习：点击即训练
 *
 * 动机：绝对注视真正难的不是拟合，而是**跨会话/换坐姿后系数漂移**（实测同一人两次
 * 标定互测有 20–70% 误差：换姿势后 eyeDist 跳 0.0217，而同一姿势内 9 个标定点之间的
 * 差异只有 0.001 量级）。也就是说 9 点标定只是「某个瞬间的姿势快照」，离线算法修不了。
 * 既然用户不会愿意反复做 9 点标定，就让**每一次真实点击自动变成一条带标签的样本**
 * （输入=当帧面部特征，标签=被点按钮的中心），配合时间衰减加权 + 安全阀重训。
 * 算法全在 lib/gaze-online.js，这里只做采样与编排。
 *
 * 开关：?train=0 关闭（默认开）。样本存 air-runner.gazeSamples，与模型（LS_GAZE）分开。
 * ------------------------------------------------------------------ */

const TRAIN_ON = params.get('train') !== '0';
/**
 * 特征新鲜度窗口（ms）：人脸刚要丢/刚丢失时，缓存的还是几帧前的特征，
 * 而标签是「现在点的按钮」——两者不同步的样本比没有样本更坏，直接丢弃。
 * 300ms ≈ 30fps 下 9 帧，足以容忍一帧的调度抖动，又不至于把陈旧特征放进来。
 */
const CLICK_FEATURE_MAX_AGE_MS = 300;

function loadGazeSamples() {
  try {
    return JSON.parse(localStorage.getItem(LS_GAZE_SAMPLES) || 'null');
  } catch {
    return null;
  }
}

function saveGazeSamples() {
  if (sim.active) return; // 自动演示产生的样本不落盘
  try {
    const j = trainer.toJSON();
    if (j.clicks.length) localStorage.setItem(LS_GAZE_SAMPLES, JSON.stringify(j));
    else localStorage.removeItem(LS_GAZE_SAMPLES);
  } catch {
    /* 隐私模式下忽略 */
  }
}

const trainer = GazeOnlineTrainer.fromJSON(loadGazeSamples());
let trainTimer = null;

/** 标定完成后把它作为可信基座喂给在线学习（点击样本单独累积） */
function rebaseTrainer() {
  trainer.setBase(gc.samples);
  saveGazeSamples();
  return trainer.total;
}

/** 卡尔曼的测量噪声：标定质量好就给更小的 R，让它更信观测、更跟手 */
function syncKalmanR() {
  const q = state.gazeModel && state.gazeModel.quality;
  const r = rFromAvgErr(q ? q.avgErr : 0.05);
  kalman.kx.r = r;
  kalman.ky.r = r;
  return r;
}

function gazeClickCount() {
  return trainer ? trainer.clicks.length : 0;
}

/**
 * 把一次真实点击记成训练样本。
 *
 * ⚠ 必须在 ACTIONS 处理器**之前**调用：点击多半会切屏，切屏后元素矩形就变成 0 了。
 * 排除标定屏的点击（那是「看向目标点」，不是「想看某个按钮」，标签语义不同）。
 */
function noteGazeClick(el) {
  if (!TRAIN_ON || !trainer) return null;
  if (gc.active || (router && router.current === 'gazeCalib')) return null;
  if (!gazeSource.active) return null; // 还没标定 ⇒ 谈不上「绝对注视」的修正
  const f = gazeSource.lastFeatures;
  if (!f) return null; // 当帧没有有效人脸
  // 特征必须新鲜：人脸刚丢失时缓存的是旧帧特征，和「现在点的按钮」不同步
  const age = Date.now() - gazeSource.lastFeaturesAt;
  if (!(age >= 0 && age <= CLICK_FEATURE_MAX_AGE_MS)) return null;
  if (!el || !el.getBoundingClientRect) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const tx = (r.left + r.width / 2) / window.innerWidth;
  const ty = (r.top + r.height / 2) / window.innerHeight;
  if (tx < 0 || tx > 1 || ty < 0 || ty > 1) return null; // 屏外元素（隐藏屏幕里的按钮）
  // 时间基准必须是 Date.now()：样本要跨会话存活，performance.now() 每次刷新都归零
  const t = Date.now();
  trainer.addClick(f, tx, ty, t);
  saveGazeSamples();
  if (trainer.due(t)) scheduleRetrain();
  return { tx, ty };
}

function scheduleRetrain() {
  if (trainTimer !== null) return;
  // 放到下一轮事件循环：点击要立刻有反馈，重训（几十毫秒）不能卡在点击响应里
  trainTimer = setTimeout(() => {
    trainTimer = null;
    retrainGaze();
  }, 0);
}

/**
 * 用累积样本重训。只有安全阀放行（新模型在同一份样本上不比旧模型差）才替换线上模型，
 * 否则宁可维持现状——「不变准」比「变不准」好。
 */
function retrainGaze() {
  const r = trainer.train({ now: Date.now(), aspect: currentAspect(), judge: state.gazeModel });
  if (r.status === 'accepted') {
    state.gazeModel = r.model;
    gazeSource.setModel(r.model);
    syncKalmanR();
    if (!sim.active) saveGazeModel(r.model);
    syncSettingsUi();
    toast(`注视模型已在线更新（${r.n} 条样本）`, 'ok');
  } else if (r.status === 'rejected') {
    toast('这次点击与当前标定差异过大，已忽略（必要时重新标定）', 'bad');
  }
  return r;
}

function gazeStatusText() {
  const m = state.gazeModel;
  if (!m || !m.ok) return '未标定 · 当前用「相对方向」代理注视（粗）';
  const q = m.quality || {};
  const pct = (v) => `${(Number(v || 0) * 100).toFixed(1)}%`;
  const base = `已标定 ${m.n} 点 · 留一误差 平均 ${pct(q.avgErr)} / 最大 ${pct(q.maxErr)} · 评级 ${GC_GRADE_TEXT[q.grade] || '—'}`;
  if (!TRAIN_ON) return `${base} · 在线学习已关（?train=0）`;
  const n = gazeClickCount();
  return n ? `${base} · 已累积 ${n} 条点击样本` : `${base} · 在线学习已开（点击即累积样本）`;
}

/** 标定失败时给用户看的一句话（按 gaze-calib 的失败原因区分，不再笼统说「有效点不足」） */
function gazeFailText(model) {
  const n = gc.samples.length;
  const reason = (model && model.reason) || '';
  if (reason === 'insufficient' || !model) return `有效点不足（${n}/${GC_POINTS.length}），请重做一次`;
  if (reason === 'singular') return '标定数据异常（特征共线），请重做一次';
  if (reason === 'weak-eye-signal') return '眼球信号太弱：跟点时眼睛几乎没动（或脸太远/光线太暗），请只动眼睛重做一次';
  if (reason === 'poor-fit') {
    const q = model.quality || {};
    return `标定误差过大（平均 ${(Number(q.avgErr || 0) * 100).toFixed(1)}%），本次不可用，请重做一次`;
  }
  return '标定不可用，请重做一次';
}

function buildGazeField() {
  const field = $('#gazeField');
  if (!field) return;
  field.innerHTML = '';
  GC_POINTS.forEach(([fx, fy], i) => {
    const p = document.createElement('div');
    p.className = 'gc-point';
    p.dataset.i = String(i);
    p.style.left = `${fx * 100}%`;
    p.style.top = `${fy * 100}%`;
    const ring = document.createElement('span');
    ring.className = 'gc-ring';
    p.appendChild(ring);
    field.appendChild(p);
  });
}

function paintGazeCalib(k = 0) {
  const field = $('#gazeField');
  if (field) {
    Array.from(field.querySelectorAll('.gc-point')).forEach((el, i) => {
      const cur = gc.active && i === gc.idx && gc.phase !== 'result';
      el.classList.toggle('cur', cur);
      el.classList.toggle('done', i < gc.idx || gc.phase === 'result');
      el.style.setProperty('--dwell', cur ? String(clamp(k, 0, 1)) : '0');
    });
  }
  const badge = $('#gcBadge');
  if (badge) badge.textContent = `${Math.min(gc.idx + 1, GC_POINTS.length)} / ${GC_POINTS.length}`;
  const tip = $('#gcTip');
  if (tip) {
    tip.textContent =
      gc.phase === 'result'
        ? '圆点＝目标，小叉＝模型预测落点；距离越近越准。换姿势后请重新标定；要排查问题可点「复制诊断数据」。'
        : '盯住亮起的圆点：只动眼睛，不要转头；共 9 个点，约 20 秒';
  }
  const status = $('#gcStatus');
  if (status) {
    if (gc.active) {
      status.textContent = `第 ${Math.min(gc.idx + 1, GC_POINTS.length)} 点 · 进度 ${Math.round(clamp(k, 0, 1) * 100)}% · 有效点 ${gc.samples.length}${gc.note ? ' · ' + gc.note : ''}`;
    } else if (gc.phase === 'result' && gc.tips && gc.tips.length) {
      // 结果页：逐行给出「能不能用 + 为什么 + 怎么办」，多行靠 CSS white-space: pre-line 保留
      status.textContent = gc.tips.join('\n');
    } else {
      status.textContent = gc.note || gazeStatusText();
    }
  }
}

function startGazeCalib() {
  if (!state.camReady && !state.cameraWanted && !sim.active) {
    toast('标定需要摄像头：请先在模式页允许摄像头权限', 'bad');
    return;
  }
  gc.active = true;
  gc.idx = 0;
  gc.phase = 'wait';
  gc.t0 = 0;
  gc.frames = [];
  gc.samples = [];
  gc.model = null;
  gc.note = '';
  gc.tips = [];
  buildGazeField();
  const apply = $('#gcApply');
  if (apply) apply.disabled = true;
  if (router) router.go('gazeCalib');
  paintGazeCalib(0);
}

function cancelGazeCalib() {
  gc.active = false;
  gc.phase = 'idle';
  gc.note = '';
  if (router) router.go('settings');
  toast('已取消标定');
}

function clearGazeModel() {
  state.gazeModel = null;
  state.settings.gazeAbs = 'off';
  gazeSource.setModel(null);
  saveGazeModel(null);
  // 标定数据没了，累积的点击样本也失去参照（它们是「相对那次标定」的修正项）
  trainer.clearClicks();
  trainer.setBase([]);
  saveGazeSamples();
  saveSettings();
  syncSettingsUi();
  toast('已清除标定数据', 'ok');
}

function finishGazeCalib() {
  gc.active = false;
  gc.phase = 'result';
  const model = GazeCalibModel.fit(gc.samples, { aspect: currentAspect() });
  gc.model = model;
  paintGazeCalib(0);

  if (!model || !model.ok) {
    gc.note = gazeFailText(model);
    gc.tips = diagnoseText(model);
    const apply = $('#gcApply');
    if (apply) apply.disabled = true;
    paintGazeCalib(0);
    toast('标定失败：' + gc.note, 'bad');
    return;
  }

  state.gazeModel = model;
  gazeSource.setModel(model);
  state.settings.gazeAbs = 'on';
  // 在线学习：以这次 9 点标定为可信基座；换标定 ⇒ 平滑器状态清零、卡尔曼 R 按新误差重算
  rebaseTrainer();
  kalman.reset();
  smooth.reset();
  syncKalmanR();
  gc.note = gazeStatusText();
  gc.tips = diagnoseText(model);
  if (!sim.active) {
    saveGazeModel(model);
    saveSettings();
  }
  syncSettingsUi();

  // 画误差图：目标点 vs 预测落点
  const field = $('#gazeField');
  if (field && Array.isArray(model.points)) {
    Array.from(field.querySelectorAll('.gc-pred')).forEach((el) => el.remove());
    model.points.forEach((pt, i) => {
      const base = GC_POINTS[i];
      if (!base) return;
      const c = pageToField(pt.px, pt.py);
      const dot = document.createElement('span');
      dot.className = 'gc-pred show';
      dot.classList.toggle('bad', Number(pt.err) > 0.09);
      dot.style.left = `${c.x * 100}%`;
      dot.style.top = `${c.y * 100}%`;
      dot.title = `误差 ${(Number(pt.err || 0) * 100).toFixed(1)}%`;
      field.appendChild(dot);
    });
  }

  const apply = $('#gcApply');
  if (apply) apply.disabled = false;
  dwell.refresh(); // 应用按钮刚由 disabled 变为可点，刷新停留目标列表
  const grade = model.quality.grade;
  toast(`标定完成：留一平均误差 ${(model.quality.avgErr * 100).toFixed(1)}% · 评级 ${GC_GRADE_TEXT[grade] || grade}`, grade === 'poor' ? 'bad' : 'ok');
}

/**
 * 把标定结果 + 诊断 + 原始特征复制到剪贴板：
 * 真机精度只有用户能测，把「为什么不准」的结构化数据带回开发者手里，才能定位是
 * 特征、光线、还是标定动作的问题（本次 50.4% 事故就是靠这个补上的观测手段）。
 */
function exportGazeDiag() {
  const m = gc.model || state.gazeModel;
  if (!m) {
    toast('还没有标定数据可导出', 'bad');
    return;
  }
  const r4 = (v) => (isFinite(v) ? Number(Number(v).toFixed(4)) : null);
  const payload = {
    at: new Date().toISOString().slice(0, 19),
    ok: !!m.ok,
    reason: m.reason || '',
    variant: m.variant,
    n: m.n,
    quality: m.quality || null,
    diag: m.diag || null,
    aspect: r4(m.aspect),
    termsX: m.termsX,
    termsY: m.termsY,
    wx: (m.wx || []).map(r4),
    wy: (m.wy || []).map(r4),
    points: (m.points || []).map((p) => ({ tx: r4(p.tx), ty: r4(p.ty), px: r4(p.px), py: r4(p.py), err: r4(p.err) })),
    // 本次会话采集到的原始特征（含每点帧数/抖动/头部极差），是复算模型的关键输入
    samples: gc.samples.length
      ? gc.samples.map((s) => ({ tx: r4(s.tx), ty: r4(s.ty), n: s.n, usable: s.usable, stats: s.stats || null, f: s.f }))
      : null,
    tips: diagnoseText(m),
  };
  const text = JSON.stringify(payload, null, 2);
  const done = () => toast('诊断数据已复制，可直接粘贴发送', 'ok');
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.className = 'gc-export';
      const host = $('#gazeField') ? $('#gazeField').parentNode : document.body;
      host.appendChild(ta);
      ta.select();
      if (ta.setSelectionRange) ta.setSelectionRange(0, text.length);
      toast('已选中诊断文本，请按 Ctrl/Cmd+C 复制', 'ok');
      setTimeout(() => ta.remove(), 60000);
    } catch {
      toast('导出失败：请检查浏览器剪贴板权限', 'bad');
    }
  };
  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
    try {
      Promise.resolve(navigator.clipboard.writeText(text)).then(done, fallback);
    } catch {
      fallback();
    }
  } else {
    fallback();
  }
}

function tickGazeCalib(now) {
  const target = GC_POINTS[gc.idx];
  if (!target || gc.phase === 'result' || gc.phase === 'idle') return;

  const page = fieldToPage(target[0], target[1]);
  const lm = sim.active
    ? simLandmarksFor(page.x, page.y, currentAspect(), { noise: 0.004 })
    : state.faceResults && state.faceResults.multiFaceLandmarks && state.faceResults.multiFaceLandmarks[0];

  if (gc.phase === 'wait') {
    const ok = sim.active || isFaceUsable(lm);
    gc.note = ok ? '' : '未检测到可用人脸，请正对摄像头并保持睁眼';
    if (ok) {
      gc.phase = 'stare';
      gc.t0 = now;
      gc.frames = [];
    }
    paintGazeCalib(0);
    return;
  }

  const total = GC_SETTLE_MS + GC_COLLECT_MS;
  const elapsed = now - gc.t0;

  if (gc.phase === 'collect' && (sim.active || isFaceUsable(lm))) {
    gc.frames.push({ lm, tx: page.x, ty: page.y });
    if (gc.frames.length > 90) gc.frames.shift();
  }

  paintGazeCalib(elapsed / total);

  if (gc.phase === 'stare') {
    if (elapsed >= GC_SETTLE_MS) {
      gc.phase = 'collect';
      gc.frames = [];
      gc.note = '';
    }
    return;
  }

  if (elapsed >= total) {
    if (gc.frames.length >= GC_MIN_FRAMES) {
      const s = medianSample(gc.frames, currentAspect());
      if (s) gc.samples.push(s);
      else gc.note = '该点采样无效';
    } else {
      gc.note = '该点有效帧不足，已跳过';
    }
    gc.idx += 1;
    gc.frames = [];
    if (gc.idx >= GC_POINTS.length) {
      finishGazeCalib();
      return;
    }
    gc.phase = 'stare';
    gc.t0 = now;
    paintGazeCalib(0);
  }
}

/* ------------------------------------------------------------------ 主循环 */

let lastNow = 0;
let fpsAcc = 0;
let fpsFrames = 0;

function frame(now) {
  const dt = Math.min(0.12, Math.max(0, (now - lastNow) / 1000));
  lastNow = now;

  if (sim.active) simStep(now);

  // ---- 9 点标定：标定屏只跑标定状态机（光标/手势/停留点击全部让路）
  const calibrating = gc.active && router.current === 'gazeCalib';
  if (calibrating) tickGazeCalib(now);

  // ---- 光标来源
  let raw = null;
  const usingGaze = state.mode === 'dual' || state.mode === 'gaze';
  if (sim.active && sim.cursor) {
    raw = sim.cursor;
  } else if (state.mode === 'mouse') {
    raw = state.cursor;
  } else if (usingGaze) {
    raw = gazeSource.getPoint(state.faceResults);
    if (!raw) {
      const h = currentHand();
      if (h) raw = handSource.getPoint(h);
    }
  } else if (state.mode === 'hand') {
    raw = handSource.getPoint(currentHand());
  }

  if (raw) {
    const p = usingGaze && !sim.active && state.mode !== 'mouse' ? smoothPoint(raw, now) : { x: raw.x, y: raw.y, speed: 0 };
    state.cursor = { x: p.x, y: p.y };
    state.cursorSpeed = p.speed;
    const cur = $('#cursor');
    if (cur) {
      cur.classList.toggle('show', router.current !== 'gazeCalib');
      cur.classList.toggle('hand', state.mode === 'hand');
      cur.style.transform = `translate3d(${p.x * window.innerWidth}px, ${p.y * window.innerHeight}px, 0)`;
    }
  } else if (state.mode !== 'mouse' && !sim.active) {
    const cur = $('#cursor');
    if (cur) cur.classList.remove('show');
  }

  // ---- 手势原语（真实与合成共用一条链路）
  // 纯眼动模式下不喂手势，避免"手扶脸/挠头"被当成跳跃指令
  const lm = currentHand();
  const wantWipe =
    (state.mode === 'dual' || state.mode === 'hand' || router.current === 'tutorial' || sim.active) &&
    !calibrating;
  const wipe = wipeDetector.push(wantWipe ? lm : null, now);
  if (wipe.dir) dispatchWipe(wipe.dir, now);

  const laneSwipe = laneDetector.push(state.mode === 'hand' ? lm : null, now);
  if (laneSwipe.dir) dispatchLaneSwipe(laneSwipe.dir);

  const cls = classifyHand(lm);
  const st = handSM.update(cls, now);
  if (st.changed && st.state === HandState.FIST) onFistEnter();

  // ---- 屏幕分发
  if (router.current === 'tutorial') {
    gazeZone.setEnabled(true);
    gazeZone.update(state.cursor, now);
  } else if (router.current === 'game' && game) {
    // 视线落在顶部 HUD 区域时不分发变道，避免"看暂停钮也变道"
    gazeZone.setEnabled(true);
    gazeZone.update(state.cursor && state.cursor.y >= 0.16 ? state.cursor : null, now);
    updateHud(now);
  } else {
    gazeZone.setEnabled(false);
    clearZones();
  }

  // ---- 视线停留点击（所有屏幕；隐藏屏幕的按钮已被可见性过滤掉）
  // 标定屏例外：标定中不许任何停留点击触发，避免误按"取消/重做"
  dwell.setEnabled(state.settings.dwellNav === 'on' && state.mode !== 'sim' && !calibrating);
  dwell.update(state.cursor, now, state.cursorSpeed);

  // ---- 就位检测
  if (router.current === 'calib') {
    if (!calibStartedAt) calibStartedAt = now;
    if (now - lastDistCheck > 300) {
      lastDistCheck = now;
      checkDistance();
    }
    if (sim.active) forceCalibPass();
    else if (now - calibStartedAt > 9000 && !state.calibTimedOut) {
      state.calibTimedOut = true;
      paintCalib();
      toast('检测超时：可直接继续，后续仍可切鼠标兜底', 'bad');
    }
  }

  // ---- FPS
  fpsAcc += dt;
  fpsFrames += 1;
  if (fpsAcc >= 1) {
    state.fps = Math.round(fpsFrames / fpsAcc);
    chip('chipFps', `FPS：${state.fps}${state.camReady ? '' : '（无摄像头）'}`);
    fpsAcc = 0;
    fpsFrames = 0;
  }

  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ HUD */

function updateHud(now) {
  if (!game) return;
  const s = game.snapshot(now);
  const set = (id, text) => {
    const el = $(`#${id}`);
    if (el) el.textContent = text;
  };
  set('hudScore', String(s.score));
  set('hudMeters', `${s.meters} m`);
  set('hudLane', LANE_TEXT[s.lane] || '—');
  set('hudTime', s.timeLeft === null ? '不限时' : `${Math.ceil(s.timeLeft)}s`);
  set('hudShield', s.shielded ? '生效中' : s.shieldReady ? '就绪' : '冷却中');
  const hearts = $('#hudLives');
  if (hearts) {
    hearts.innerHTML = Array.from({ length: game.livesMax }, (_, i) => `<span class="${i < s.lives ? '' : 'off'}">♥</span>`).join('');
  }
}

/* ------------------------------------------------------------------ 关卡流程 */

function pickMode(mode) {
  setMode(mode);
  router.go('calib');
  calibStartedAt = 0;
  const el = $('#camPreview');
  if (el) el.classList.add('show', 'large');
}

function forceCalibPass() {
  state.calib = { face: true, hand: true, dist: true, light: true };
  setCheck('chkFace', 'on', '已检测到');
  setCheck('chkHand', 'on', '已检测到');
  setCheck('chkDist', 'on', '合适');
  setCheck('chkLight', 'on', '正常');
  paintCalib();
}

async function runCountdown() {
  const num = $('#countNum');
  const tip = $('#countTip');
  if (tip) tip.textContent = state.mode === 'dual' ? '握拳开护盾 · 眼睛看向要去的车道' : '眼睛看向要去的车道';
  for (const n of ['3', '2', '1', 'GO']) {
    if (num) {
      num.textContent = n;
      num.style.animation = 'none';
      void num.offsetWidth;
      num.style.animation = '';
    }
    beep(n === 'GO' ? 900 : 520, n === 'GO' ? 200 : 90);
    await wait(n === 'GO' ? 420 : 700);
    if (router.current !== 'countdown') return; // 用户中途退出
  }
  beginRun();
}

function beginRun() {
  const canvas = $('#gameCanvas');
  if (!canvas) return;
  if (!game) {
    game = new RunnerGame(canvas, {
      durationSec: state.settings.duration,
      difficulty: state.settings.difficulty,
      onEnd: (stats) => onGameEnd(stats),
      onEvent: (type) => {
        if (type === 'hit') {
          beep(180, 220, 'square');
          flashText('撞到！');
        }
      },
    });
  }
  let dur = state.settings.duration;
  if (sim.active) dur = dur > 0 ? Math.min(35, dur) : 35;
  game.durationSec = dur;
  game.difficulty = state.settings.difficulty;
  game.laneCount = 3;
  game.livesMax = 3;

  state.paused = false;
  hidePause();
  gazeZone.reset();
  wipeDetector.reset();
  laneDetector.reset();
  handSM.reset();
  router.go('game');
  const preview = $('#camPreview');
  if (preview) {
    preview.classList.add('show');
    preview.classList.remove('large');
  }
  requestAnimationFrame(() => {
    game.resize();
    game.start();
    beep(760, 120);
    if (sim.active) simGameLoop();
  });
}

function pauseGame() {
  if (!game || router.current !== 'game') return;
  state.paused = true;
  game.pause();
  showPause();
}

function resumeGame() {
  if (!game) return;
  state.paused = false;
  hidePause();
  game.resume(performance.now());
}

function showPause() {
  const m = $('#pauseModal');
  if (!m) return;
  const sub = $('#pauseSub');
  if (sub && game) sub.textContent = `分数 ${game.stats.score} · 距离 ${game.stats.meters} m · 剩 ${game.lives} 条命`;
  m.classList.add('is-active');
}

function hidePause() {
  const m = $('#pauseModal');
  if (m) m.classList.remove('is-active');
}

function onGameEnd(stats) {
  state.lastStats = stats;
  if (stats.score > state.best) {
    state.best = stats.score;
    try {
      localStorage.setItem(LS_BEST, String(state.best));
    } catch {
      /* ignore */
    }
  }
  const set = (id, text) => {
    const el = $(`#${id}`);
    if (el) el.textContent = text;
  };
  set('resScore', String(stats.score));
  set('resTitle', stats.reason === 'lives' ? '命用完了' : '时间到');
  set('resReason', `本局 ${stats.duration}s · ${LANE_TEXT[game.targetLane] || ''}收车 · 最高分 ${state.best}`);
  set('resDist', `${stats.meters} m`);
  set('resLane', String(stats.laneChanges));
  set('resJump', String(stats.jumps));
  set('resSlide', String(stats.slides));
  set('resShield', String(stats.shields));
  set('resHit', String(stats.hits));
  set('resBest', stats.score >= state.best ? `新纪录！最高分 ${state.best}` : `最高分：${state.best}`);
  game.stop();
  router.replace('result');
  beep(420, 200);
}

/* ------------------------------------------------------------------ 战绩卡导出 */

function exportCard() {
  const stats = state.lastStats;
  if (!stats) {
    toast('先跑一局再保存战绩卡');
    return;
  }
  const cv = $('#cardCanvas');
  if (!cv || !cv.getContext) return;
  const ctx = cv.getContext('2d');
  const W = cv.width;
  const H = cv.height;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#0a1024');
  g.addColorStop(0.55, '#101a3a');
  g.addColorStop(1, '#1a1140');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(120,165,255,0.5)';
  ctx.lineWidth = 3;
  ctx.strokeRect(24, 24, W - 48, H - 48);

  ctx.fillStyle = '#6ee7ff';
  ctx.font = '600 26px -apple-system, "PingFang SC", sans-serif';
  ctx.fillText('星际跑酷 · AIR RUNNER', 64, 108);
  ctx.fillStyle = '#9fb0d4';
  ctx.font = '20px -apple-system, "PingFang SC", sans-serif';
  ctx.fillText(`模式 ${state.settings.mode === 'dual' ? '双模态' : state.settings.mode} · 难度 ${state.settings.difficulty}`, 64, 148);

  ctx.fillStyle = '#ffffff';
  ctx.font = '800 128px -apple-system, "PingFang SC", sans-serif';
  ctx.fillText(String(stats.score), 64, 300);
  ctx.fillStyle = '#9fb0d4';
  ctx.font = '24px -apple-system, "PingFang SC", sans-serif';
  ctx.fillText('本局得分', 64, 342);

  const rows = [
    ['最远距离', `${stats.meters} m`],
    ['变道次数', String(stats.laneChanges)],
    ['跳跃次数', String(stats.jumps)],
    ['滑铲次数', String(stats.slides)],
    ['护盾次数', String(stats.shields)],
    ['撞击次数', String(stats.hits)],
  ];
  rows.forEach(([k, v], i) => {
    const x = 64 + (i % 2) * 320;
    const y = 440 + Math.floor(i / 2) * 118;
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(x, y, 296, 96);
    ctx.strokeStyle = 'rgba(120,165,255,0.28)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, 296, 96);
    ctx.fillStyle = '#9fb0d4';
    ctx.font = '20px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText(k, x + 22, y + 38);
    ctx.fillStyle = '#eaf1ff';
    ctx.font = '700 34px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText(v, x + 22, y + 78);
  });

  ctx.fillStyle = '#ffc861';
  ctx.font = '600 26px -apple-system, "PingFang SC", sans-serif';
  ctx.fillText(`最高分 ${state.best}`, 64, H - 96);
  ctx.fillStyle = '#6c7ea6';
  ctx.font = '20px -apple-system, "PingFang SC", sans-serif';
  ctx.fillText(new Date().toLocaleString(), 64, H - 56);

  try {
    const url = cv.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `air-runner-${stats.score}.png`;
    a.click();
    toast('战绩卡已保存', 'ok');
  } catch (err) {
    toast('导出失败：请用本地服务打开（localhost）', 'bad');
  }
}

/* ------------------------------------------------------------------ 自动演示（?mode=sim） */

function simStep(now) {
  const a = sim.anim;
  if (!a) return;
  const k = Math.min(1, (now - a.start) / a.dur);
  if (a.kind === 'wipe') {
    const y = a.dir === 'up' ? 0.74 - 0.42 * k : 0.3 + 0.42 * k;
    state.__synthHand = synthHand(a.x, y, k, false);
  } else if (a.kind === 'fist') {
    state.__synthHand = synthHand(0.62, 0.44, k, k > 0.25);
  } else if (a.kind === 'gaze') {
    sim.cursor = { x: a.x, y: a.y };
  }
  if (k >= 1) {
    if (a.kind !== 'gaze') state.__synthHand = null;
    sim.anim = null;
  }
}

function simClick(selector, holdMs = 950) {
  const el = $(selector);
  if (!el) return Promise.resolve();
  const r = el.getBoundingClientRect();
  sim.cursor = { x: (r.left + r.width / 2) / window.innerWidth, y: (r.top + r.height / 2) / window.innerHeight };
  return wait(holdMs).then(() => {
    el.click();
    return wait(260);
  });
}

function simGaze(x, ms) {
  sim.cursor = { x, y: 0.5 };
  sim.anim = { kind: 'gaze', x, y: 0.5, start: performance.now(), dur: ms };
  return wait(ms + 260);
}

function simWipe(dir) {
  sim.anim = { kind: 'wipe', dir, x: 0.55, start: performance.now(), dur: 900 };
  return wait(1000);
}

function simFist() {
  sim.anim = { kind: 'fist', start: performance.now(), dur: 1100 };
  return wait(1200);
}

async function simGameLoop() {
  while (router.current === 'game' && game && !game.over && sim.active) {
    await simGaze(Math.random() < 0.5 ? 0.12 : 0.88, 1500);
    if (router.current !== 'game' || game.over) break;
    if (Math.random() < 0.65) await simWipe(Math.random() < 0.5 ? 'up' : 'down');
    if (router.current !== 'game' || game.over) break;
    if (Math.random() < 0.25) await simFist();
  }
  await wait(2600);
  if (!sim.done) {
    sim.done = true;
    toast('自动演示结束：可换 ?mode=mouse 或 ?mode=dual 自己试玩', 'ok');
  }
}

async function runAutoDemo() {
  sim.active = true;
  document.body.classList.add('sim-mode');
  chip('chipInput', '输入：自动演示');
  await wait(900);
  await simClick('[data-action="to-mode"]');
  await wait(400);
  await simClick('[data-mode="dual"]');
  await wait(500);
  forceCalibPass();
  await wait(700);
  await simClick('[data-action="calib-done"]');
  await wait(500);
  await simGaze(0.12, 900); // 左
  await simGaze(0.88, 900); // 右
  await simWipe('up');
  await simWipe('down');
  await simFist();
  await wait(400);
  await simClick('[data-action="tutorial-done"]');
}

/* ------------------------------------------------------------------ 事件绑定 */

const ACTIONS = {
  'to-mode': () => router.go('mode'),
  'to-help': () => router.go('help'),
  'to-settings': () => router.go('settings'),
  'gaze-calib': () => startGazeCalib(),
  'gaze-calib-cancel': () => cancelGazeCalib(),
  'gaze-calib-redo': () => startGazeCalib(),
  'gaze-calib-export': () => exportGazeDiag(),
  'gaze-calib-apply': () => {
    if (!(state.gazeModel && state.gazeModel.ok)) {
      toast('还没有可用的标定数据', 'bad');
      return;
    }
    state.settings.gazeAbs = 'on';
    gazeSource.setModel(state.gazeModel);
    saveSettings();
    syncSettingsUi();
    router.go('settings');
    toast('已启用精确注视（绝对坐标）', 'ok');
  },
  'gaze-calib-clear': () => clearGazeModel(),
  'to-splash': () => {
    if (game) {
      game.stop();
      game.reset();
    }
    hidePause();
    router.replace('splash');
  },
  back: () => router.back(),
  'pick-mode': (el) => pickMode(el.dataset.mode),
  'calib-done': () => router.go('tutorial'),
  'calib-skip': () => {
    forceCalibPass();
    toast('已跳过就位检测');
    router.go('tutorial');
  },
  'tutorial-done': () => {
    const missing = !tutorialAllDone();
    if (missing) toast('还有动作没完成，也可以点「跳过教学」', 'bad');
    router.go('countdown');
    runCountdown();
  },
  'tutorial-skip': () => {
    state.tutorial = { laneLeft: true, laneRight: true, jump: true, slide: true, shield: true };
    paintTutorial();
    router.go('countdown');
    runCountdown();
  },
  pause: () => pauseGame(),
  resume: () => resumeGame(),
  'play-again': () => {
    hidePause();
    router.go('countdown');
    runCountdown();
  },
  'save-card': () => exportCard(),
  'reset-best': () => {
    state.best = 0;
    try {
      localStorage.removeItem(LS_BEST);
    } catch {
      /* ignore */
    }
    toast('最高分已清除', 'ok');
  },
  set: (el) => {
    const row = el.closest('[data-setting]');
    if (!row) return;
    applySetting(row.dataset.setting, el.dataset.value);
  },
};

function applySetting(key, value) {
  if (!(key in state.settings)) return;

  // 精确注视：没有可用的标定模型时不许打开（否则光标会静止在 0.5/0.5）
  if (key === 'gazeAbs' && value === 'on' && !(state.gazeModel && state.gazeModel.ok)) {
    state.settings.gazeAbs = 'off';
    saveSettings();
    syncSettingsUi();
    toast('还没有标定数据：先做一次 9 点标定（约 15 秒）', 'bad');
    return;
  }

  state.settings[key] = key === 'duration' ? Number(value) : value;
  saveSettings();

  if (key === 'gaze') gazeZone.gazeMs = GAZE_MS[value] || 350;
  if (key === 'sensitivity') {
    wipeDetector.setSensitivity(value);
    laneDetector.setSensitivity(value);
  }
  if (key === 'gazeAbs') gazeSource.setModel(value === 'on' ? state.gazeModel : null);

  syncSettingsUi();
  toast(key === 'gazeAbs' ? `精确注视已${value === 'on' ? '开启' : '关闭'}` : `已保存：${value}`, 'ok');
}

function syncSettingsUi() {
  $$('[data-setting]').forEach((row) => {
    const key = row.dataset.setting;
    $$('button[data-value]', row).forEach((b) => {
      b.classList.toggle('on', String(state.settings[key]) === String(b.dataset.value));
    });
  });
  const gs = $('#gazeCalibStatus');
  if (gs) gs.textContent = gazeStatusText();
}

function onClick(e) {
  const el = e.target.closest && e.target.closest('[data-action]');
  if (!el) return;
  noteGazeClick(el); // 采样必须在动作之前：动作常会切屏，之后元素矩形就变成 0 了
  const fn = ACTIONS[el.dataset.action];
  if (fn) fn(el);
}

function onKey(e) {
  const k = e.key;
  if (k === 'Escape') {
    if (router.current === 'game') (state.paused ? resumeGame() : pauseGame());
    return;
  }
  // 教学页：键盘也能完成动作（纯眼动模式的兜底）
  if (router.current === 'tutorial') {
    if (k === 'ArrowLeft') markStep('laneLeft');
    else if (k === 'ArrowRight') markStep('laneRight');
    else if (k === 'ArrowUp' || k === 'w' || k === 'W' || k === ' ') {
      e.preventDefault();
      markStep('jump');
    } else if (k === 'ArrowDown' || k === 's' || k === 'S') markStep('slide');
    else if (k === 'f' || k === 'F') markStep('shield');
    return;
  }
  if (router.current !== 'game' || !game) return;
  if (k === 'ArrowLeft' || k === 'a' || k === 'A') game.moveLane(-1);
  else if (k === 'ArrowRight' || k === 'd' || k === 'D') game.moveLane(1);
  else if (k === 'ArrowUp' || k === 'w' || k === 'W' || k === ' ') {
    e.preventDefault();
    if (game.jump()) flashText('JUMP');
  } else if (k === 'ArrowDown' || k === 's' || k === 'S') {
    if (game.slide()) flashText('SLIDE');
  } else if (k === 'f' || k === 'F') {
    if (game.shield()) flashText('SHIELD');
  }
}

function onMouseMove(e) {
  if (state.mode !== 'mouse' || sim.active) return;
  state.cursor = { x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight };
  state.cursorSpeed = 0;
}

function onScreenEnter(name, payload, prev) {
  state.screen = name;
  const preview = $('#camPreview');
  if (preview) {
    const showCam = (name === 'calib' || name === 'game' || name === 'tutorial' || name === 'gazeCalib') && state.camReady;
    preview.classList.toggle('show', showCam);
    preview.classList.toggle('large', name === 'calib');
  }
  if (name === 'settings') syncSettingsUi();
  if (name === 'gazeCalib') paintGazeCalib(0);
  if (name === 'result') clearZones();
  if (name === 'tutorial') {
    state.tutorial = { laneLeft: false, laneRight: false, jump: false, slide: false, shield: false };
    paintTutorial();
  }
  if (name === 'game') {
    const m = $('#pauseModal');
    if (m) m.classList.toggle('is-active', !!state.paused);
    // 从设置页返回时渲染循环已停，这里恢复（保持暂停状态）
    if (game && !game.over && !game.running) game.resumeLoop();
  } else if (name !== 'game') {
    hidePause();
  }
  if (name !== 'calib') {
    calibStartedAt = 0;
    lastDistCheck = 0;
  } else {
    state.calibTimedOut = false;
  }
  dwell.refresh();
  setTimeout(() => dwell.refresh(), 360); // 等过渡动画结束再取一次矩形
  if (game && name !== 'game') game.stop();
}

/* ------------------------------------------------------------------ 启动 */

export function boot() {
  router = new ScreenRouter({ initial: 'splash', onEnter: onScreenEnter });

  document.addEventListener('click', onClick);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', () => {
    dwell.refresh();
    if (game) game.resize();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && router.current === 'game' && !state.paused) pauseGame();
  });

  setMode(forcedMode && forcedMode !== 'sim' ? forcedMode : state.settings.mode || 'dual', { silent: true });

  // 载入已保存的 9 点标定模型
  state.gazeModel = loadGazeModel();
  if (params.get('gaze') === 'abs') state.settings.gazeAbs = 'on';
  if (state.settings.gazeAbs === 'on') {
    if (state.gazeModel && state.gazeModel.ok) gazeSource.setModel(state.gazeModel);
    else {
      state.settings.gazeAbs = 'off';
      toast('没有可用的标定数据，精确注视已关闭（设置页可重新标定）', 'bad');
    }
  }
  // 卡尔曼的 R 跟着标定质量走；在线学习的样本池已在模块加载时从 localStorage 恢复
  syncKalmanR();

  syncSettingsUi();
  chip('chipFps', 'FPS：--');
  paintTutorial();
  paintCalib();

  if (params.get('nocam') === '1') {
    setMode('mouse', { silent: true });
    toast('已禁用摄像头（?nocam=1）');
  }

  requestAnimationFrame((t) => {
    lastNow = t;
    frame(t);
  });

  if (params.get('gazecal') === '1') {
    // 直接进标定屏（配 ?mode=sim 可无摄像头看完整标定流程）
    startGazeCalib();
  } else if (params.get('autostart') === '1') {
    // 自动演示仍走双模态链路（sim 不取摄像头），kiosk 场景直接进游戏
    setMode(sim.active ? 'dual' : 'mouse', { silent: true });
    forceCalibPass();
    beginRun();
  } else if (sim.active) {
    runAutoDemo();
  }

  if (params.get('skipintro') === '1') {
    state.tutorial = { laneLeft: true, laneRight: true, jump: true, slide: true, shield: true };
    paintTutorial();
  }
}

try {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
} catch (err) {
  console.error('[air-runner] boot failed', err);
}

// 调试/自测入口
if (typeof window !== 'undefined') {
  window.__airRunner = {
    get router() {
      return router;
    },
    get game() {
      return game;
    },
    state,
    sim,
    settings: state.settings,
    dwell,
    gazeZone,
    wipeDetector,
    laneDetector,
    handSM,
    synthHand,
    boot,
    setMode,
    beginRun,
    forceCalibPass,
    applySetting,
    gazeSource,
    smooth:
      SMOOTH_KIND === 'kalman'
        ? { kind: SMOOTH_KIND, filter: (p, t) => kalman.filter(p, t), reset: () => kalman.reset() }
        : { kind: SMOOTH_KIND, filter: (p, t) => smooth.filter(p, t), reset: () => smooth.reset() },
    kalman,
    gazeCalib: {
      start: startGazeCalib,
      cancel: cancelGazeCalib,
      clear: clearGazeModel,
      load: loadGazeModel,
      tick: tickGazeCalib,
      export: exportGazeDiag,
      points: GC_POINTS,
      tips: () => gc.tips.slice(),
      status: () => ({
        active: gc.active,
        idx: gc.idx,
        phase: gc.phase,
        samples: gc.samples.length,
        target: GC_POINTS[gc.idx] || null,
        ok: !!(state.gazeModel && state.gazeModel.ok), // 当前生效的模型
        lastFit: !!(gc.model && gc.model.ok), // 最近一次标定结果（含误差图数据）
        variant: gc.model ? gc.model.variant : null,
        reasons: gc.model ? gc.model.reasons : null,
        note: gc.note,
        model: state.gazeModel,
        lastModel: gc.model,
      }),
    },
    /** 在线学习（点击即训练）：自测与现场调参入口 */
    gazeTrain: {
      on: TRAIN_ON,
      trainer,
      samples: () => trainer.total,
      clicks: () => trainer.clicks.slice(),
      rebase: rebaseTrainer,
      retrain: retrainGaze,
      note: noteGazeClick,
      save: saveGazeSamples,
      raw: () => loadGazeSamples(),
      status: () => ({
        on: TRAIN_ON,
        total: trainer.total,
        base: trainer.base.length,
        clicks: trainer.clicks.length,
        pending: trainer.pending,
        due: trainer.due(Date.now()),
        last: trainer.lastStatus,
        smooth: SMOOTH_KIND,
      }),
    },
    actions: ACTIONS,
  };
}
