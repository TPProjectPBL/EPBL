/**
 * 插件统一状态码与错误类型（阶段 1）。
 * 为采集/检测模块提供可读、可判定的状态码，便于 UI 展示与测试断言。
 */

export const Status = Object.freeze({
  // 摄像头（采集）状态
  CAMERA_IDLE: 'camera_idle',
  CAMERA_STARTING: 'camera_starting',
  CAMERA_RUNNING: 'camera_running',
  CAMERA_STOPPED: 'camera_stopped',

  // 采集错误
  ERR_INSECURE_CONTEXT: 'err_insecure_context',
  ERR_NO_SUPPORT: 'err_no_support',
  ERR_PERMISSION_DENIED: 'err_permission_denied',
  ERR_NO_DEVICE: 'err_no_device',
  ERR_DEVICE_BUSY: 'err_device_busy',
  ERR_UNKNOWN: 'err_unknown',

  // 检测器状态
  DETECTOR_LOADING: 'detector_loading',
  DETECTOR_READY: 'detector_ready',
  ERR_DETECTOR_LOAD: 'err_detector_load',
});

export const StatusMessage = Object.freeze({
  camera_idle: '未启动',
  camera_starting: '启动中…',
  camera_running: '运行中',
  camera_stopped: '已停止',
  err_insecure_context: '非安全上下文（需 HTTPS 或 localhost）',
  err_no_support: '浏览器不支持摄像头采集',
  err_permission_denied: '摄像头权限被拒绝',
  err_no_device: '未检测到摄像头设备',
  err_device_busy: '摄像头被其它程序占用',
  err_unknown: '未知错误',
  detector_loading: '模型加载中…',
  detector_ready: '就绪',
  err_detector_load: '检测模型加载失败',
});

export class PluginError extends Error {
  constructor(code) {
    super(StatusMessage[code] || code);
    this.name = 'PluginError';
    this.code = code;
  }
}
