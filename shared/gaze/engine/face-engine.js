/**
 * @file 统一人脸跟踪引擎（MediaPipe Vision Tasks · FaceLandmarker，478 点含虹膜）。
 *
 * 职责：只负责「图像帧 → 归一化 478 点」。不做镜像、不做平滑、不做标定。
 * 与 legacy 的 `face_mesh.js`（window.FaceMesh）输出同一套拓扑：0..467 面部 + 468..477 虹膜。
 *
 * 坐标约定（与 CONTRACT.md 一致）：
 *   x / y 为视频帧归一化坐标（0..1），原点在左上角，**不做镜像**；
 *   镜像只允许在渲染层出现一次。
 *
 * 运行时来源：默认复用 `draw/vendor/vision/vision_bundle.mjs` 与 `draw/vendor/vision/wasm`，
 * 避免仓库里放两份 wasm；后续整体迁到 `shared/gaze/vendor` 时用参数覆盖即可。
 *
 * 模型来源：默认本地 `shared/gaze/models/face_landmarker.task`（脚本下载），
 * 本地不可用时回退官方 CDN（可用 allowCdnFallback: false 关闭）。
 */
const DEFAULT_VISION = new URL('../../../draw/vendor/vision/vision_bundle.mjs', import.meta.url).href;
const DEFAULT_WASM = new URL('../../../draw/vendor/vision/wasm', import.meta.url).href;
const DEFAULT_MODEL = new URL('../models/face_landmarker.task', import.meta.url).href;
const CDN_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

const MIN_LANDMARKS = 478;

/**
 * 创建人脸引擎。
 *
 * @param {object} [options]
 * @param {string} [options.wasmPath]   wasm 目录（默认 draw/vendor/vision/wasm）
 * @param {string} [options.modelPath]  .task 路径（默认 shared/gaze/models/face_landmarker.task）
 * @param {'GPU'|'CPU'} [options.delegate='GPU'] 首选 delegate；GPU 失败自动降 CPU
 * @param {boolean} [options.refineLandmarks=true] 是否输出虹膜点（Tasks 默认输出 478）
 * @param {'VIDEO'|'IMAGE'} [options.runningMode='VIDEO']
 * @param {string} [options.visionPath] vision_bundle.mjs 路径
 * @param {boolean} [options.allowCdnFallback=true] 本地模型失败时是否回退 CDN
 * @returns {Promise<object>} engine
 */
export async function createFaceEngine(options = {}) {
  const {
    wasmPath = DEFAULT_WASM,
    modelPath = DEFAULT_MODEL,
    delegate = 'GPU',
    refineLandmarks = true,
    runningMode = 'VIDEO',
    visionPath = DEFAULT_VISION,
    allowCdnFallback = true,
  } = options;

  const mod = await import(visionPath);
  const fileset = await mod.FilesetResolver.forVisionTasks(wasmPath);

  const order = delegate === 'CPU' ? ['CPU'] : ['GPU', 'CPU'];
  const attempts = [];

  const build = async (assetPath, d) => {
    const landmarker = await mod.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: assetPath, delegate: d },
      runningMode,
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    return landmarker;
  };

  let landmarker = null;
  let usedDelegate = null;
  let modelSource = 'local';
  let lastError = null;

  // 1) 本地模型：先 GPU 再 CPU
  for (const d of order) {
    try {
      landmarker = await build(modelPath, d);
      usedDelegate = d;
      break;
    } catch (err) {
      attempts.push({ model: 'local', delegate: d, error: String((err && err.message) || err) });
      lastError = err;
    }
  }

  // 2) 本地全失败 → CDN 回退（仍先 GPU 再 CPU）
  if (!landmarker && allowCdnFallback) {
    for (const d of order) {
      try {
        landmarker = await build(CDN_MODEL, d);
        usedDelegate = d;
        modelSource = 'cdn';
        break;
      } catch (err) {
        attempts.push({ model: 'cdn', delegate: d, error: String((err && err.message) || err) });
        lastError = err;
      }
    }
  }

  if (!landmarker) {
    const err = new Error('[face-engine] FaceLandmarker 创建失败（本地与 CDN 均不可用）');
    err.code = 'engine-init-failed';
    err.attempts = attempts;
    err.cause = lastError;
    throw err;
  }

  const listeners = new Set();
  let lastTs = -1;
  let closed = false;
  const detectMethod = runningMode === 'IMAGE' ? 'detect' : 'detectForVideo';

  /**
   * 推一帧。
   * @param {HTMLVideoElement|HTMLCanvasElement|ImageBitmap|ImageData} image
   * @param {number} [timestampMs] VIDEO 模式必须单调递增；内部会自动纠正
   * @returns {Promise<{landmarks: Array<{x:number,y:number,z:number}>|null, blendshapes: null, ts: number, reason?: string, count?: number}>}
   */
  async function push(image, timestampMs) {
    if (closed) return { landmarks: null, reason: 'engine-closed', ts: lastTs };
    if (!image) return { landmarks: null, reason: 'no-image', ts: lastTs };

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const ts = Number.isFinite(timestampMs) ? Math.max(timestampMs, lastTs + 1) : Math.max(now, lastTs + 1);
    lastTs = ts;

    let raw;
    try {
      raw = await landmarker[detectMethod](image, ts);
    } catch (err) {
      return {
        landmarks: null,
        blendshapes: null,
        ts,
        reason: 'inference-failed:' + String((err && err.message) || err),
      };
    }

    const first = raw && raw.faceLandmarks && raw.faceLandmarks[0];
    if (!first) return { landmarks: null, blendshapes: null, ts, reason: 'no-face' };

    if (!Array.isArray(first) || first.length < MIN_LANDMARKS) {
      const count = Array.isArray(first) ? first.length : 0;
      return {
        landmarks: null,
        blendshapes: null,
        ts,
        reason: 'insufficient-landmarks',
        count,
      };
    }

    const landmarks = first.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    const out = { landmarks, blendshapes: null, ts };

    for (const cb of listeners) {
      try {
        cb(out);
      } catch (err) {
        console.warn('[face-engine] onResult 回调异常', err);
      }
    }
    return out;
  }

  /** 订阅每帧结果；返回取消订阅函数。 */
  function onResult(cb) {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  /** 释放底层模型；之后的 push 返回 engine-closed。 */
  function close() {
    if (closed) return;
    closed = true;
    listeners.clear();
    try {
      landmarker.close();
    } catch (err) {
      console.warn('[face-engine] close 异常', err);
    }
  }

  return {
    push,
    onResult,
    close,
    get delegate() {
      return usedDelegate;
    },
    get modelSource() {
      return modelSource;
    },
    get runningMode() {
      return runningMode;
    },
    get refineLandmarks() {
      return refineLandmarks;
    },
    get attempts() {
      return attempts.slice();
    },
    get closed() {
      return closed;
    },
    /** 底层 landmarker，仅调试/巡检用，业务不要直接依赖。 */
    landmarker,
  };
}

export const FACE_ENGINE = Object.freeze({
  MIN_LANDMARKS,
  CDN_MODEL,
  DEFAULT_VISION,
  DEFAULT_WASM,
  DEFAULT_MODEL,
  /** 关键点索引语义（与 legacy FaceMesh 一致） */
  IDX: Object.freeze({
    leftIris: 468,
    rightIris: 473,
    leftEyeOuter: 33,
    leftEyeInner: 133,
    rightEyeOuter: 263,
    rightEyeInner: 362,
  }),
});
