/**
 * 复用入口：把 air-draw 里已验证过的平滑与光标源模块统一从这里导出，
 * 跑酷 demo 不重复实现，也不直接依赖 MediaPipe。
 */

export { OneEuroFilter, OneEuroPoint, clamp } from '../../air-draw/lib/smoothing.js';
export { GazeCursorSource, HandCursorSource } from '../../air-draw/lib/gaze-source.js';
export { HandStateMachine, HandState } from '../../air-draw/lib/hand-state.js';
export { Status, StatusMessage, PluginError } from '../../../src/status-codes.js';
export { CameraModule } from '../../../src/camera-module.js';
export { FaceMeshDetector } from '../../../src/face-mesh-detector.js';
export { HandDetector } from '../../../src/hand-detector.js';
