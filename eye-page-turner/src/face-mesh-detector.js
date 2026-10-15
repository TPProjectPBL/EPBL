import { Status, PluginError } from './status-codes.js';

const DEFAULT_LOCATE = (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;

/**
 * 人脸检测模块（阶段 1）：封装 MediaPipe Face Mesh，含虹膜关键点。
 */
export class FaceMeshDetector {
  constructor(options = {}) {
    this.maxNumFaces = options.maxNumFaces ?? 1;
    this.refineLandmarks = options.refineLandmarks ?? true;
    this.minDetectionConfidence = options.minDetectionConfidence ?? 0.5;
    this.minTrackingConfidence = options.minTrackingConfidence ?? 0.5;
    this.locateFile = options.locateFile || DEFAULT_LOCATE;
    this.onResults = options.onResults || null;
    this._mesh = null;
    this.results = null;
    this.status = Status.DETECTOR_LOADING;
  }

  init() {
    const FaceMeshCtor = window.FaceMesh;
    if (!FaceMeshCtor) throw new PluginError(Status.ERR_DETECTOR_LOAD);
    this._mesh = new FaceMeshCtor({ locateFile: this.locateFile });
    this._mesh.setOptions({
      maxNumFaces: this.maxNumFaces,
      refineLandmarks: this.refineLandmarks,
      minDetectionConfidence: this.minDetectionConfidence,
      minTrackingConfidence: this.minTrackingConfidence,
    });
    this._mesh.onResults((results) => {
      this.results = results;
      if (this.onResults) this.onResults(results);
    });
    this.status = Status.DETECTOR_READY;
    return this;
  }

  detect(video) {
    if (this.status !== Status.DETECTOR_READY || !this._mesh) {
      return Promise.reject(new PluginError(Status.ERR_DETECTOR_LOAD));
    }
    return this._mesh.send({ image: video });
  }

  /** 人脸网格连接常量（FACEMESH_TESSELATION） */
  get tesselation() {
    return window.FaceMesh ? window.FaceMesh.FACEMESH_TESSELATION : [];
  }

  /** 虹膜网格连接常量（FACEMESH_IRISES） */
  get irises() {
    return window.FaceMesh ? window.FaceMesh.FACEMESH_IRISES : [];
  }

  /** 判断一组关键点是否含虹膜点（refineLandmarks 开启后长度为 478） */
  static hasIris(landmarks) {
    return Array.isArray(landmarks) && landmarks.length >= 478;
  }
}
