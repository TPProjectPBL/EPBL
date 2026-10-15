import { Status, PluginError } from './status-codes.js';

const DEFAULT_LOCATE = (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;

/**
 * 手势检测模块（阶段 1）：封装 MediaPipe Hands（21 关键点）。
 */
export class HandDetector {
  constructor(options = {}) {
    this.maxNumHands = options.maxNumHands ?? 2;
    this.modelComplexity = options.modelComplexity ?? 1;
    this.minDetectionConfidence = options.minDetectionConfidence ?? 0.5;
    this.minTrackingConfidence = options.minTrackingConfidence ?? 0.5;
    this.locateFile = options.locateFile || DEFAULT_LOCATE;
    this.onResults = options.onResults || null;
    this._hands = null;
    this.results = null;
    this.status = Status.DETECTOR_LOADING;
  }

  init() {
    const HandsCtor = window.Hands;
    if (!HandsCtor) throw new PluginError(Status.ERR_DETECTOR_LOAD);
    this._hands = new HandsCtor({ locateFile: this.locateFile });
    this._hands.setOptions({
      maxNumHands: this.maxNumHands,
      modelComplexity: this.modelComplexity,
      minDetectionConfidence: this.minDetectionConfidence,
      minTrackingConfidence: this.minTrackingConfidence,
    });
    this._hands.onResults((results) => {
      this.results = results;
      if (this.onResults) this.onResults(results);
    });
    this.status = Status.DETECTOR_READY;
    return this;
  }

  detect(video) {
    if (this.status !== Status.DETECTOR_READY || !this._hands) {
      return Promise.reject(new PluginError(Status.ERR_DETECTOR_LOAD));
    }
    return this._hands.send({ image: video });
  }

  /** 手部骨架连接常量（HAND_CONNECTIONS） */
  get connections() {
    return window.Hands ? window.Hands.HAND_CONNECTIONS : [];
  }
}
