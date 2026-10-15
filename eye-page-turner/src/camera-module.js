import { Status, PluginError } from './status-codes.js';

/**
 * 摄像头采集模块（阶段 1）。
 * 封装 MediaPipe camera_utils 的 Camera，负责环境校验、getUserMedia、
 * 状态管理与 DOMException 到统一状态码的映射。
 */
export class CameraModule {
  constructor(video, options = {}) {
    this.video = video;
    this.width = options.width ?? 640;
    this.height = options.height ?? 480;
    this.onFrame = options.onFrame || null;
    this.onError = options.onError || null;
    this._camera = null;
    this.status = Status.CAMERA_IDLE;
  }

  get running() {
    return this.status === Status.CAMERA_RUNNING;
  }

  start() {
    this._assertEnvironment();
    const CameraCtor = window.Camera;
    if (!CameraCtor) throw new PluginError(Status.ERR_NO_SUPPORT);

    this.status = Status.CAMERA_STARTING;
    this._camera = new CameraCtor(this.video, {
      onFrame: () => this._handleFrame(),
      width: this.width,
      height: this.height,
    });

    return this._camera
      .start()
      .then(() => {
        this.status = Status.CAMERA_RUNNING;
      })
      .catch((err) => {
        this.status = Status.CAMERA_IDLE;
        this._camera = null;
        throw this._mapError(err);
      });
  }

  stop() {
    if (this._camera && this._camera.video && this._camera.video.srcObject) {
      this._camera.video.srcObject.getTracks().forEach((t) => t.stop());
    }
    this._camera = null;
    this.status = Status.CAMERA_STOPPED;
  }

  async _handleFrame() {
    try {
      if (this.onFrame) await this.onFrame();
    } catch (err) {
      if (this.onError) this.onError(err);
      else console.warn('[CameraModule] frame error', err);
    }
  }

  _assertEnvironment() {
    if (typeof window.isSecureContext === 'boolean' && !window.isSecureContext) {
      throw new PluginError(Status.ERR_INSECURE_CONTEXT);
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new PluginError(Status.ERR_NO_SUPPORT);
    }
  }

  _mapError(err) {
    switch (err && err.name) {
      case 'NotAllowedError':
      case 'SecurityError':
      case 'PermissionDeniedError':
        return new PluginError(Status.ERR_PERMISSION_DENIED);
      case 'NotFoundError':
      case 'DevicesNotFoundError':
      case 'OverconstrainedError':
        return new PluginError(Status.ERR_NO_DEVICE);
      case 'NotReadableError':
      case 'TrackStartError':
      case 'AbortError':
        return new PluginError(Status.ERR_DEVICE_BUSY);
      default:
        return new PluginError(Status.ERR_UNKNOWN);
    }
  }
}
