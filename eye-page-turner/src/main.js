/* 阶段 1：模块化编排
 * 将阶段 0 的单体脚本拆分为采集（CameraModule）、检测（FaceMeshDetector/HandDetector）、
 * 渲染（renderer）各模块，并引入统一状态码。
 */
import { CameraModule } from './camera-module.js';
import { FaceMeshDetector } from './face-mesh-detector.js';
import { HandDetector } from './hand-detector.js';
import { drawFrame } from './renderer.js';
import { StatusMessage } from './status-codes.js';

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
  faceState: document.getElementById('face-state'),
  handState: document.getElementById('hand-state'),
  irisState: document.getElementById('iris-state'),
};

const faceDetector = new FaceMeshDetector();
const handDetector = new HandDetector();
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

function setDetectState(el, detected) {
  el.textContent = detected ? '已检测' : '无';
  el.style.color = detected ? '#7ce0a5' : '#f0a0b0';
}

// ---- 每帧处理：检测 + 渲染 + UI ----
async function onFrame() {
  await faceDetector.detect(video);
  await handDetector.detect(video);

  const summary = drawFrame({
    ctx, canvas, video,
    faceResults: faceDetector.results,
    handResults: handDetector.results,
    faceTesselation: faceDetector.tesselation,
    faceIrises: faceDetector.irises,
    handConnections: handDetector.connections,
  });

  updateFps();
  setDetectState(ui.faceState, summary.hasFace);
  setDetectState(ui.irisState, summary.hasIris);
  setDetectState(ui.handState, summary.hasHand);
}

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
    ui.chipMode.textContent = '模式：待定（距离估计 → 阶段2）';
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
});
